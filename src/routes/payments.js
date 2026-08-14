'use strict';
//
// src/routes/payments.js — B2C Э4 (WP3): эквайринг физиков (карта/СБП).
//
//   POST /api/client/topup                     — создать платёж (auth, лимитер,
//                                                retail_enabled + email_verified)
//   POST /api/payments/webhook/tochka          — вебхук банка (БЕЗ auth, raw JWT,
//                                                strict-подпись, лимитер по IP)
//   GET  /api/client/payments                  — история card_payments клиента
//   GET  /api/admin/card_payments              — список для админки (+ фильтр)
//   POST /api/admin/card_payments/:orderId/refund — возврат (премодерация вручную)
//
// Зачёт ТОЛЬКО по webhook (не по return-url!). Деньги — только через
// atomicCredit/atomicDebit; вызовы провайдера — ВНЕ SQLite-транзакций.
// Идемпотентность webhook: markPaid (UPDATE … WHERE status='created') —
// дубль → changes=0 → 200 без зачёта.

const express = require('express');
const crypto = require('crypto');
const { referralCommission } = require('../billing/referral');   // Р6: комиссия 10% с любого канала

module.exports = function createPaymentsRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware, validate, TopupSchema,
    topupLimiter, webhookLimiter,
    clients, clientById, saveClients,
    getSetting, tariffsDb, cardPaymentsDb, ledgerDb, promoDb,
    atomicCredit, atomicDebit,
    auditLog, logActivity, getClientIp,
    alerts, notifyClient,
    createProvider, dbAudit,
  } = deps;
  const r = express.Router();

  function _clientOf(req) {
    return clients.find(c => c.login === req.user.login);
  }

  // Минимум пополнения: настройка retail_min_topup (>0); 0/не задана —
  // суточное списание тарифа клиента (price/30.4); без тарифа — 100 ₽.
  function _minTopupFor(client) {
    const configured = Number(getSetting('retail_min_topup', 0));
    if (configured > 0) return Math.round(configured * 100) / 100;
    if (client.tariffId != null) {
      const t = tariffsDb.byId(client.tariffId);
      if (t && t.price > 0 && t.duration_hours !== 24) {
        return Math.max(1, Math.round((t.price / 30.4) * 100) / 100);
      }
    }
    return 100;
  }
  function _maxTopup() {
    return Number(getSetting('retail_max_topup', 100000)) || 100000;
  }

  // Р22-паттерн (как tochka-sync.js:31): рефкомиссия 10% в той же транзакции.
  function _referralOptsFor(client, amount) {
    if (!client.referred_by) return undefined;
    const referrer = clientById.get(client.referred_by);
    if (!referrer) return undefined;
    return { referral: { referrerId: referrer.id, delta: referralCommission(amount) } };
  }

  function _notifyCredit(client, amount, balanceAfter) {
    if (!notifyClient || !client) return;
    Promise.resolve(notifyClient(client,
      `Зачислено ${Math.round(amount * 100) / 100} ₽. Баланс: ${Math.round(balanceAfter * 100) / 100} ₽.`,
      { action: 'balance_credited', details: { client_id: client.id, amount, balance: balanceAfter } }
    )).catch(e => logger.warn(`[Payments] notify ${client.login}: ${e.message}`));
  }

  function _publicPayment(p) {
    return {
      order_id: p.order_id, amount: p.amount, method: p.method,
      status: p.status, created_at: p.created_at, credited_at: p.credited_at || null,
    };
  }

  // ── Создание платежа ─────────────────────────────────────────────────────
  r.post('/api/client/topup', authMiddleware, topupLimiter, validate(TopupSchema), async (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const client = _clientOf(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (client.blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    // 54-ФЗ: чек уходит на email — без подтверждённого адреса оплата запрещена (WP1/§6)
    if (!client.emailVerified || !client.email) {
      return res.status(403).json({ error: 'Подтвердите email перед оплатой', code: 'EMAIL_NOT_VERIFIED' });
    }
    const provider = createProvider();
    if (!provider) {
      return res.status(503).json({ error: 'Эквайринг не подключён — пополнение временно недоступно', code: 'ACQUIRING_NOT_CONFIGURED' });
    }

    const amount = Math.round(parseFloat(req.body.amount) * 100) / 100;
    const method = req.body.method;   // 'card' | 'sbp' (TopupSchema)
    const min = _minTopupFor(client);
    const max = _maxTopup();
    if (!(amount >= min)) {
      return res.status(400).json({ error: `Минимальная сумма пополнения — ${min} ₽`, code: 'AMOUNT_TOO_SMALL', min });
    }
    if (!(amount <= max)) {
      return res.status(400).json({ error: `Максимальная сумма пополнения — ${max} ₽`, code: 'AMOUNT_TOO_LARGE', max });
    }

    // WP6: промокод на пополнение (percent/fixed). Бонус зачислится в webhook
    // вместе с платежом; bonus_days сюда не подходит (он про покупку).
    let promoCode = null;
    if (req.body.promo) {
      const { promo, error } = promoDb.findValid(req.body.promo);
      if (error) return res.status(400).json({ error, code: 'PROMO_INVALID' });
      if (promo.type === 'bonus_days') {
        return res.status(400).json({ error: 'Этот промокод действует при покупке прокси', code: 'PROMO_WRONG_CONTEXT' });
      }
      promoCode = promo.code;
    }

    // Читаемый уникальный заказ; ≤45 символов — лимит paymentLinkId Точки.
    const orderId = `R${client.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    cardPaymentsDb.insertCreated(orderId, client.id, amount, method, promoCode);

    // Вызов провайдера — ВНЕ транзакций SQLite (сеть в транзакции недопустима).
    const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
    try {
      const created = await provider.create_payment({
        order_id: orderId, amount, method,
        receipt_email: client.email,
        return_url: base + '/?payment=success',
        fail_url: base + '/?payment=failed',
      });
      // operationId сразу к заказу — по нему админ делает возврат, а webhook
      // сверяет provider_payment_id.
      if (created.provider_payment_id) {
        cardPaymentsDb.attachProvider(orderId, created.provider_payment_id);
      }
      auditLog(client.login, 'retail_topup_created', { order_id: orderId, amount, method, ip: getClientIp(req) });
      res.json({ ok: true, order_id: orderId, confirmation_url: created.confirmation_url });
    } catch (e) {
      cardPaymentsDb.markStatus(orderId, 'failed');
      logger.error(`[Payments] create_payment failed (${orderId}): ${e.message}`);
      res.status(502).json({ error: 'Платёжная система недоступна — попробуйте позже', code: 'PROVIDER_ERROR' });
    }
  });

  // ── Вебхук банка ─────────────────────────────────────────────────────────
  // Тело — «голая» строка JWT (Content-Type: text/plain): express.text ДО
  // json-парсера здесь не нужен глобально — content-type не application/json.
  // Strict-подпись внутри provider.verify_webhook; подделка → 401.
  r.post('/api/payments/webhook/tochka', webhookLimiter, express.text({ type: '*/*', limit: '100kb' }), async (req, res) => {
    const provider = createProvider();
    if (!provider) return res.status(503).json({ ok: false, error: 'acquiring not configured' });
    if (dbAudit && dbAudit.setActiveContext) {
      dbAudit.setActiveContext({ source: 'webhook', actor: 'tochka_acquiring', ip: getClientIp(req), reason: 'acquiring_webhook' });
    }

    const verdict = await provider.verify_webhook(req.headers, req.body);
    if (!verdict.ok) {
      logger.warn(`[Payments webhook] подпись не прошла: ${verdict.reason || '?'} (ip ${getClientIp(req)})`);
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }
    const { order_id: orderId, status, provider_payment_id: providerPaymentId } = verdict;
    if (!orderId) return res.status(200).json({ ok: true, ignored: 'no_order_id' });

    const row = cardPaymentsDb.byOrderId(orderId);
    if (!row) {
      // Не наш заказ (чужой webhook на нашем URL) — 200, чтобы банк не ретраил 30 раз.
      logger.warn(`[Payments webhook] неизвестный order_id ${orderId}`);
      return res.status(200).json({ ok: true, ignored: 'unknown_order' });
    }
    const rawJson = JSON.stringify(verdict.raw || {});

    if (status === 'paid') {
      // Сверка суммы: расхождение = подозрительно, деньги НЕ зачисляем.
      if (verdict.amount != null && Math.abs(verdict.amount - row.amount) > 0.005) {
        logger.error(`[Payments webhook] amount mismatch ${orderId}: webhook ${verdict.amount} != db ${row.amount}`);
        try { alerts && alerts.trigger('retail_card_payment', { login: row.client_id, amount: row.amount, method: row.method, error: 'amount_mismatch' }); } catch (_) { /* alert best-effort */ }
        return res.status(200).json({ ok: true, processed: false, reason: 'amount_mismatch' });
      }
      // Идемпотентность: UPDATE … WHERE status='created' — дубль → changes=0.
      const marked = cardPaymentsDb.markPaid(orderId, providerPaymentId, rawJson);
      if (marked.changes === 0) {
        return res.status(200).json({ ok: true, duplicate: true, status: row.status });
      }
      const client = clientById.get(row.client_id);
      if (!client) {
        // Клиента удалили между оплатой и webhook — строка paid остаётся
        // для ручного разбора; банку 200 (деньги у нас, ретраи не помогут).
        logger.error(`[Payments webhook] client ${row.client_id} not found for ${orderId}`);
        return res.status(200).json({ ok: true, processed: false, reason: 'client_not_found' });
      }
      try {
        const result = atomicCredit(client.id, row.amount, {
          type: 'card_payment', source: 'acquiring',
          amount: row.amount,
          date: new Date().toISOString().slice(0, 10),
          timestamp: new Date().toISOString(),
          note: `Пополнение ${row.method === 'sbp' ? 'СБП' : 'картой'} (${orderId})`,
          paymentId: orderId,
        }, _referralOptsFor(client, row.amount));
        cardPaymentsDb.markCredited(orderId);
        saveClients(clients);
        _notifyCredit(client, row.amount, result.balanceAfter);
        // WP6: бонус по промокоду — тем же платежом, отдельной строкой ledger
        // (type='promo_bonus'). consume() атомарен; лимит исчерпан между
        // созданием платежа и webhook → бонус честно пропускаем (лог+аудит).
        if (row.promo_code) {
          try {
            const { promo } = promoDb.findValid(row.promo_code);
            const bonus = promo
              ? Math.round((promo.type === 'percent' ? row.amount * promo.value / 100 : promo.value) * 100) / 100
              : 0;
            if (promo && bonus > 0 && promoDb.consume(promo.id)) {
              const bres = atomicCredit(client.id, bonus, {
                type: 'promo_bonus', source: 'promo',
                amount: bonus,
                date: new Date().toISOString().slice(0, 10),
                timestamp: new Date().toISOString(),
                note: `Промокод ${promo.code} (+${promo.type === 'percent' ? promo.value + '%' : promo.value + ' ₽'})`,
                paymentId: orderId,
              });
              saveClients(clients);
              logActivity('client', 'info', 'promo_bonus', client.login,
                `Промокод ${promo.code}: +${bonus} ₽ к пополнению ${orderId}`, { order_id: orderId, bonus });
              _notifyCredit(client, bonus, bres.balanceAfter);
            } else {
              logger.warn(`[Payments webhook] promo ${row.promo_code} для ${orderId} не применён (лимит/неактивен)`);
            }
          } catch (e) {
            // Бонус не зачислился — платёж уже зачтён, не валим webhook.
            logger.error(`[Payments webhook] promo bonus failed ${orderId}: ${e.message}`);
          }
        }
        try { alerts && alerts.trigger('retail_card_payment', { login: client.login, client_id: client.id, amount: row.amount, method: row.method || verdict.method }); } catch (_) { /* alert best-effort */ }
        logActivity('client', 'info', 'retail_card_credited', client.login,
          `Эквайринг: зачислено ${row.amount} ₽ (${row.method || verdict.method}, ${orderId})`, { order_id: orderId });
      } catch (e) {
        // Строка остаётся 'paid' — зачисление восстановится ретраем webhook
        // (markPaid идемпотентен, повторный webhook дойдёт сюда снова? НЕТ —
        // status уже 'paid', markPaid даст changes=0. Поэтому здесь — громкий
        // алерт: такой платёж требует ручного зачисления).
        logger.error(`[Payments webhook] credit failed for ${orderId}: ${e.message}`);
        try { alerts && alerts.trigger('retail_card_payment', { login: client.login, client_id: client.id, amount: row.amount, method: row.method, error: 'credit_failed' }); } catch (_) { /* alert best-effort */ }
        return res.status(500).json({ ok: false, error: 'credit failed' });
      }
      return res.status(200).json({ ok: true, credited: true });
    }

    // Не-paid статусы: денег нет. EXPIRED/DECLINED по незачисленному заказу —
    // failed; прочее (AUTHORIZED, REFUNDED — возврат идёт через админку) — лог.
    if (status === 'failed' && row.status === 'created') {
      cardPaymentsDb.markStatus(orderId, 'failed');
      logger.info(`[Payments webhook] ${orderId} → failed (${verdict.provider_status})`);
    } else {
      logger.info(`[Payments webhook] ${orderId}: status ${verdict.provider_status} → без зачисления (row ${row.status})`);
    }
    res.status(200).json({ ok: true, processed: false, status });
  });

  // ── История платежей клиента + параметры формы пополнения ────────────────
  r.get('/api/client/payments', authMiddleware, (req, res) => {
    if (!getSetting('retail_enabled', false)) return res.status(404).json({ error: 'Not found' });
    const client = _clientOf(req);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({
      payments: cardPaymentsDb.byClient(client.id).map(_publicPayment),
      topup: {
        min: _minTopupFor(client),
        max: _maxTopup(),
        enabled: !!createProvider(),
        emailVerified: !!client.emailVerified,
      },
    });
  });

  // ── Админка: список карточных платежей ───────────────────────────────────
  r.get('/api/admin/card_payments', authMiddleware, adminMiddleware, (req, res) => {
    const clientId = req.query.client_id ? String(req.query.client_id) : null;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rows = clientId ? cardPaymentsDb.byClient(clientId) : cardPaymentsDb.recent(limit);
    res.json({
      payments: rows.map(p => ({
        ..._publicPayment(p),
        provider_payment_id: p.provider_payment_id || null,
        client_id: p.client_id,
        client_login: (clientById.get(p.client_id) || {}).login || null,
      })),
    });
  });

  // ── Админка: возврат платежа (ручная премодерация) ───────────────────────
  // Порядок строго: provider.refund → (успех) payment_reversal в ledger →
  // markStatus('refunded'). Провайдер упал — НЕ сторнируем, 502.
  r.post('/api/admin/card_payments/:orderId/refund', authMiddleware, adminMiddleware, async (req, res) => {
    const orderId = String(req.params.orderId || '');
    const row = cardPaymentsDb.byOrderId(orderId);
    if (!row) return res.status(404).json({ error: 'Платёж не найден' });
    if (row.status === 'refunded') return res.json({ ok: true, already: true });
    if (row.status !== 'credited') {
      return res.status(409).json({ error: `Возврат возможен только для зачисленных платежей (сейчас: ${row.status})` });
    }
    const provider = createProvider();
    if (!provider) return res.status(503).json({ error: 'Эквайринг не подключён', code: 'ACQUIRING_NOT_CONFIGURED' });
    const client = clientById.get(row.client_id);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });

    // 1. Возврат у провайдера (вне транзакций).
    try {
      await provider.refund(row.provider_payment_id, row.amount);
    } catch (e) {
      logger.error(`[Payments] refund ${orderId} failed: ${e.message}`);
      return res.status(502).json({ error: 'Провайдер не выполнил возврат — сторно не делалось', details: e.message });
    }

    // 2. Сторно в ledger (payment_reversal) + откат рефкомиссии — одной
    //    транзакцией atomicDebit, как delete-by-ledger в clients.js.
    const ledgerEntry = ledgerDb.listByClient(client.id)
      .find(e => e.type === 'card_payment' && e.paymentId === orderId);
    let referralOpts = null;
    if (client.referred_by) {
      const referrer = clientById.get(client.referred_by);
      if (referrer) referralOpts = { referrerId: referrer.id, delta: -referralCommission(row.amount) };
    }
    try {
      atomicDebit(client.id, row.amount, {
        type: 'payment_reversal',
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        amount: row.amount,
        currency: client.currency || 'RUB',
        note: `Возврат эквайринга (${orderId})`,
        source: 'acquiring',
        paymentId: orderId,
        reversedLedgerId: ledgerEntry ? ledgerEntry.db_id : undefined,
      }, referralOpts ? { referral: referralOpts } : undefined);
    } catch (e) {
      // Деньги у провайдера УЖЕ возвращены, а сторно не записалось —
      // расхождение требует ручного разбора: громкий лог + алерт + 500.
      logger.error(`[Payments] refund ${orderId}: provider OK, ledger reversal FAILED: ${e.message}`);
      try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId, error: 'reversal_failed' }); } catch (_) { /* alert best-effort */ }
      return res.status(500).json({ error: 'Возврат у провайдера прошёл, но сторно не записалось — нужен ручной разбор', details: e.message });
    }

    // 3. Статус заказа + аудит + алерт.
    cardPaymentsDb.markStatus(orderId, 'refunded');
    saveClients(clients);
    auditLog(req.user.login, 'retail_card_refund', { order_id: orderId, client_id: client.id, amount: row.amount, ip: getClientIp(req) });
    logActivity('client', 'warning', 'retail_card_refund', client.login,
      `Возврат эквайринга ${row.amount} ₽ (${orderId})`, { order_id: orderId, by: req.user.login });
    try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId }); } catch (_) { /* alert best-effort */ }
    res.json({ ok: true, balance: client.balance });
  });

  return r;
};
