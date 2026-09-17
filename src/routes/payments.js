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
// Идемпотентность: durable-claim finance_idempotency (card_payment:<order_id>,
// promo_bonus:<order_id>, refund:<order_id>) вставляется в той же транзакции,
// что и деньги; markCredited — тоже внутри неё. Крах между webhook и
// зачислением догоняет recovery-джоба (runRecovery, 5 мин) по строкам в
// статусе 'paid'; крах между подтверждением возврата банком и сторно — по
// строкам 'refund_provider_ok' (2026-09-18, DEEP-03).

const express = require('express');
const crypto = require('crypto');
const { referralCommission } = require('../billing/referral');   // Р6: комиссия 10% с любого канала
const { decodeJwtPayload } = require('../tochka/jwt');           // peek webhookType для unified-URL роутинга

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
    getBankWebhookHandler,
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

  function _creditMain(row, finalizeInsideTx) {
    const client = clientById.get(row.client_id);
    if (!client) throw new Error(`client ${row.client_id} not found`);
    const historical = ledgerDb && typeof ledgerDb.listByClient === 'function'
      ? (ledgerDb.listByClient(client.id) || []).filter(e => e.type === 'card_payment' && e.paymentId === row.order_id)
      : [];
    if (historical.length > 1) throw new Error(`multiple historical ledger rows for ${row.order_id}`);
    if (historical.length === 1) {
      const recorded = Number(historical[0].amount);
      if (!Number.isFinite(recorded) || Math.abs(recorded - Number(row.amount)) > 0.005) {
        throw new Error(`historical ledger amount mismatch for ${row.order_id}`);
      }
      return { client, result: { duplicate: true, historical: true, balanceBefore: client.balance, balanceAfter: client.balance } };
    }
    const result = atomicCredit(client.id, row.amount, {
      type: 'card_payment', source: 'acquiring', amount: row.amount,
      date: new Date().toISOString().slice(0, 10), timestamp: new Date().toISOString(),
      note: `Пополнение ${row.method === 'sbp' ? 'СБП' : 'картой'} (${row.order_id})`,
      paymentId: row.order_id,
    }, {
      ...(_referralOptsFor(client, row.amount) || {}),
      idempotencyKey: `card_payment:${row.order_id}`,
      insideTx: finalizeInsideTx ? () => cardPaymentsDb.markCredited(row.order_id) : undefined,
    });
    return { client, result };
  }

  // 2026-09-18 · DEEP-02 (§14.2): ожидаемый бонус — снимок, зафиксированный
  // при создании заказа; для legacy-строк (без снимка) — расчёт по текущему
  // коду. Редактирование/пересоздание промокода не меняет обязательство.
  function _expectedBonus(row, promo) {
    const snap = Number(row.promo_bonus_amount);
    if (Number.isFinite(snap) && snap > 0) return Math.round(snap * 100) / 100;
    if (!promo) return null;
    const b = Math.round((promo.type === 'percent' ? row.amount * promo.value / 100 : promo.value) * 100) / 100;
    return Number.isFinite(b) && b > 0 ? b : null;
  }

  // Бонус невозможно применить автоматически (код отключён/исчерпан/удалён
  // после оплаты, сумма расходится): основная оплата УЖЕ у клиента — заказ
  // завершаем, бонус уходит на ручную сверку. Иначе заказ навсегда оставался
  // 'paid' и recovery крутил его бесконечно (DEEP-02).
  function _promoReview(row, reason) {
    cardPaymentsDb.completeOrder(row.order_id, 'review');
    logger.error(`[Payments] promo ${row.promo_code} (${row.order_id}) → review: ${reason}`);
    try {
      alerts && alerts.trigger('retail_card_payment', {
        login: row.client_id, client_id: row.client_id, amount: row.amount,
        method: row.method, order_id: row.order_id, error: 'promo_review', reason,
      });
    } catch (_) { /* alert best-effort */ }
    return { review: true, reason };
  }

  function _creditPromo(row, client) {
    if (!row.promo_code) return null;
    // §14.2: наличие старого бонуса проверяем по ledger ГЛОБАЛЬНО и ДО чтения
    // кода — код мог быть удалён или пересоздан после оплаты. Совпадение
    // клиента/суммы/типа завершает фазу без новых денег; несовпадение — review.
    const existing = ledgerDb && typeof ledgerDb.listByPayment === 'function'
      ? ledgerDb.listByPayment(row.order_id, 'promo_bonus')
      : [];
    if (existing.length > 1) return _promoReview(row, 'multiple_bonus_rows');
    const promo = typeof promoDb.byCode === 'function'
      ? promoDb.byCode(row.promo_code)
      : (promoDb.findValid(row.promo_code) || {}).promo;
    const bonus = _expectedBonus(row, promo);
    if (existing.length === 1) {
      const recorded = Number(existing[0].amount);
      if (existing[0].client_id !== row.client_id || !Number.isFinite(recorded) ||
          (bonus != null && Math.abs(recorded - bonus) > 0.005)) {
        return _promoReview(row, 'historical_bonus_mismatch');
      }
      cardPaymentsDb.completeOrder(row.order_id, 'applied');
      return { duplicate: true, historical: true, balanceBefore: client.balance, balanceAfter: client.balance };
    }
    if (!promo) return _promoReview(row, 'promo_missing');
    if (bonus == null) return _promoReview(row, 'invalid_bonus');
    try {
      return atomicCredit(client.id, bonus, {
        type: 'promo_bonus', source: 'promo', amount: bonus,
        date: new Date().toISOString().slice(0, 10), timestamp: new Date().toISOString(),
        note: `Промокод ${promo.code} (+${promo.type === 'percent' ? promo.value + '%' : promo.value + ' ₽'})`,
        paymentId: row.order_id,
      }, {
        idempotencyKey: `promo_bonus:${row.order_id}`,
        insideTx: () => {
          // consume=false → лимит исчерпан/код отключён после оплаты. Лимит
          // НЕ обходим (§14.2): вся транзакция откатывается, бонус → review.
          if (!promoDb.consume(promo.id)) {
            const e = new Error('promo limit exhausted');
            e.code = 'PROMO_EXHAUSTED';
            throw e;
          }
          cardPaymentsDb.setPromoStatus(row.order_id, 'applied');
          cardPaymentsDb.markCredited(row.order_id);
        },
      });
    } catch (e) {
      if (e && e.code === 'PROMO_EXHAUSTED') return _promoReview(row, 'promo_exhausted');
      throw e;   // транзиентная ошибка БД — заказ остаётся paid, recovery повторит
    }
  }

  function _completeCredit(row) {
    const main = _creditMain(row, !row.promo_code);
    const promo = _creditPromo(row, main.client);
    // Duplicate claims can only be observed after their transaction committed.
    // This also reconciles historical ledger rows created before durable claims.
    if ((main.result.duplicate && !row.promo_code) || (promo && promo.duplicate)) {
      cardPaymentsDb.completeOrder(row.order_id, promo && row.promo_code ? 'applied' : null);
    }
    saveClients(clients);
    return { ...main, promo };
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
    // вместе с платежом. 2026-09-18 (DEEP-02, §14.2): сумма бонуса фиксируется
    // в заказе — последующее редактирование/удаление кода не меняет обещание.
    let promoCode = null, promoBonus = null;
    if (req.body.promo) {
      const { promo, error } = promoDb.findValid(req.body.promo);
      if (error) return res.status(400).json({ error, code: 'PROMO_INVALID' });
      promoCode = promo.code;
      const b = Math.round((promo.type === 'percent' ? amount * promo.value / 100 : promo.value) * 100) / 100;
      if (Number.isFinite(b) && b > 0) promoBonus = b;
    }

    // Читаемый уникальный заказ; ≤45 символов — лимит paymentLinkId Точки.
    const orderId = `R${client.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    cardPaymentsDb.insertCreated(orderId, client.id, amount, method, promoCode, promoBonus);

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
  //
  // Unified URL: у API-ключа Точки ОДИН webhook URL на все типы событий.
  // Поэтому сюда же приходят и банковские события (incomingPayment) — их
  // передаём в банковский обработчик (routes/tochka.js), ничего не меняя.
  // Тип читаем из payload БЕЗ верификации (это только роутинг; обработчик
  // сам проверяет подпись — банковский мягко, эквайринг строго).
  r.post('/api/payments/webhook/tochka', webhookLimiter, express.text({ type: '*/*', limit: '100kb' }), async (req, res) => {
    const peeked = decodeJwtPayload(typeof req.body === 'string' ? req.body.trim() : '');
    if (peeked && peeked.webhookType && peeked.webhookType !== 'acquiringInternetPayment') {
      const bankHandler = getBankWebhookHandler && getBankWebhookHandler();
      if (bankHandler) return bankHandler(req, res);
      logger.warn('[Payments webhook] не-эквайринговый тип ' + peeked.webhookType + ', а bank handler не подключён');
      return res.status(200).json({ ok: true, ignored: 'no_bank_handler' });
    }
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
      if (row.provider_payment_id && providerPaymentId && row.provider_payment_id !== providerPaymentId) {
        logger.error(`[Payments webhook] provider id mismatch ${orderId}`);
        return res.status(200).json({ ok: true, processed: false, reason: 'provider_id_mismatch' });
      }
      // Сверка суммы: расхождение = подозрительно, деньги НЕ зачисляем.
      if (!Number.isFinite(Number(row.amount)) || Number(row.amount) <= 0 ||
          (verdict.amount != null && (!Number.isFinite(Number(verdict.amount)) || Math.abs(Number(verdict.amount) - Number(row.amount)) > 0.005))) {
        logger.error(`[Payments webhook] amount mismatch ${orderId}: webhook ${verdict.amount} != db ${row.amount}`);
        try { alerts && alerts.trigger('retail_card_payment', { login: row.client_id, amount: row.amount, method: row.method, error: 'amount_mismatch' }); } catch (_) { /* alert best-effort */ }
        return res.status(200).json({ ok: true, processed: false, reason: 'amount_mismatch' });
      }
      // Идемпотентность по статусу: credited → дубль без зачёта; терминальный
      // failed/refunded → paid-событие подозрительно, деньги не зачисляем;
      // повторный webhook по 'paid' идёт в _completeCredit (recovery-путь).
      if (row.status === 'credited') {
        return res.status(200).json({ ok: true, duplicate: true, status: row.status });
      }
      if (row.status !== 'created' && row.status !== 'paid') {
        logger.warn(`[Payments webhook] paid event for ${orderId} in terminal status ${row.status}`);
        return res.status(200).json({ ok: true, processed: false, reason: 'terminal_status', status: row.status });
      }
      if (row.status === 'created') cardPaymentsDb.markPaid(orderId, providerPaymentId, rawJson);
      const client = clientById.get(row.client_id);
      if (!client) {
        // Клиента удалили между оплатой и webhook — строка paid остаётся
        // для ручного разбора; банку 200 (деньги у нас, ретраи не помогут).
        logger.error(`[Payments webhook] client ${row.client_id} not found for ${orderId}`);
        return res.status(200).json({ ok: true, processed: false, reason: 'client_not_found' });
      }
      try {
        const { result, promo } = _completeCredit(row);
        if (!result.duplicate) _notifyCredit(client, row.amount, result.balanceAfter);
        // Бонус — отдельное устойчивое событие. Пока его транзакция не
        // завершилась, заказ остаётся paid и будет поднят recovery job.
        if (promo && !promo.duplicate && !promo.review) {
          logActivity('client', 'info', 'promo_bonus', client.login,
            `Промокод ${row.promo_code}: бонус к пополнению ${orderId}`, { order_id: orderId });
          _notifyCredit(client, promo.balanceAfter - promo.balanceBefore, promo.balanceAfter);
        }
        try { alerts && alerts.trigger('retail_card_payment', { login: client.login, client_id: client.id, amount: row.amount, method: row.method || verdict.method }); } catch (_) { /* alert best-effort */ }
        logActivity('client', 'info', 'retail_card_credited', client.login,
          `Эквайринг: зачислено ${row.amount} ₽ (${row.method || verdict.method}, ${orderId})`, { order_id: orderId });
      } catch (e) {
        // Строка остаётся 'paid' — зачисление догонит recovery-джоба
        // (runRecovery, 5 мин; backoff 1/5/15/60 мин по recovery_attempts).
        // Здесь — громкий алерт + 500, чтобы банк тоже ретраил webhook.
        logger.error(`[Payments webhook] credit failed for ${orderId}: ${e.message}`);
        try { alerts && alerts.trigger('retail_card_payment', { login: client.login, client_id: client.id, amount: row.amount, method: row.method, error: 'credit_failed' }); } catch (_) { /* alert best-effort */ }
        return res.status(500).json({ ok: false, error: 'credit failed' });
      }
      return res.status(200).json({ ok: true, credited: true });
    }

    // Не-paid статусы: денег нет. EXPIRED/DECLINED по незачисленному заказу —
    // failed; прочее (AUTHORIZED — лог). REFUNDED — сопоставляем с операцией
    // возврата (2026-09-18, DEEP-03/§14.3), а не теряем в логах.
    if (status === 'refunded') {
      if (row.status === 'refund_pending') {
        // Банк подтвердил возврат, чей исход был неизвестен (crash/таймаут
        // после вызова). Переводим в provider_ok и доводим сторно без нового
        // сетевого вызова; ошибка записи оставляет заказ для recovery.
        cardPaymentsDb.refundProviderOk(orderId);
        logger.info(`[Payments webhook] ${orderId}: REFUNDED подтвердил незавершённый возврат`);
        try { _finalizeRefund(cardPaymentsDb.byOrderId(orderId)); }
        catch (e) { logger.error(`[Payments webhook] refund finalize ${orderId}: ${e.message}`); }
      } else if (row.status === 'refund_provider_ok') {
        try { _finalizeRefund(row); }
        catch (e) { logger.error(`[Payments webhook] refund finalize ${orderId}: ${e.message}`); }
      } else if (row.status === 'credited') {
        // Возврат инициирован вне нашего контура (вручную в банке). Деньги
        // автоматически НЕ двигаем — громкий алерт на сверку.
        logger.error(`[Payments webhook] внешний REFUNDED по зачисленному заказу ${orderId}`);
        try { alerts && alerts.trigger('retail_card_refund', { login: row.client_id, client_id: row.client_id, amount: row.amount, order_id: orderId, error: 'external_refund' }); } catch (_) { /* alert best-effort */ }
      }
      return res.status(200).json({ ok: true, status: cardPaymentsDb.byOrderId(orderId).status });
    }
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
  // 2026-09-18 · DEEP-03 (§14.3): устойчивая операция с фазами
  //   credited → refund_pending (захват + ключ ДО вызова банка) →
  //   refund_provider_ok (банк подтвердил) → refunded (сторно записано).
  // Слепой повтор вызова банка запрещён: неизвестный исход (refund_pending)
  // уходит на сверку; подтверждённый (refund_provider_ok) доводится только
  // записью сторно, без нового обращения к провайдеру.
  function _finalizeRefund(row) {
    const client = clientById.get(row.client_id);
    if (!client) throw new Error(`client ${row.client_id} not found`);
    const ledgerEntry = ledgerDb.listByClient(client.id)
      .find(e => e.type === 'card_payment' && e.paymentId === row.order_id);
    let referralOpts = null;
    if (client.referred_by) {
      const referrer = clientById.get(client.referred_by);
      if (referrer) referralOpts = { referrerId: referrer.id, delta: -referralCommission(row.amount) };
    }
    // Сторно + откат рефкомиссии + финальный статус — одной транзакцией
    // (раньше markStatus('refunded') шёл ПОСЛЕ коммита — крах между ними
    // оставлял credited с уже записанным сторно).
    const result = atomicDebit(client.id, row.amount, {
      type: 'payment_reversal',
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      amount: row.amount,
      currency: client.currency || 'RUB',
      note: `Возврат эквайринга (${row.order_id})`,
      source: 'acquiring',
      paymentId: row.order_id,
      reversedLedgerId: ledgerEntry ? ledgerEntry.db_id : undefined,
    }, {
      ...(referralOpts ? { referral: referralOpts } : {}),
      insideTx: () => {
        if (cardPaymentsDb.markRefunded(row.order_id).changes === 0) {
          throw new Error(`refund status race for ${row.order_id}`);
        }
      },
    });
    if (result.duplicate) throw new Error(`unexpected duplicate reversal for ${row.order_id}`);
    saveClients(clients);
    logActivity('client', 'warning', 'retail_card_refund', client.login,
      `Возврат эквайринга ${row.amount} ₽ (${row.order_id})`, { order_id: row.order_id });
    return { client, result };
  }

  r.post('/api/admin/card_payments/:orderId/refund', authMiddleware, adminMiddleware, async (req, res) => {
    const orderId = String(req.params.orderId || '');
    const row = cardPaymentsDb.byOrderId(orderId);
    if (!row) return res.status(404).json({ error: 'Платёж не найден' });
    if (row.status === 'refunded') return res.json({ ok: true, already: true });
    if (row.status === 'refund_provider_ok') {
      // Банк уже подтвердил возврат — только догоняем сторно (crash-safe retry).
      try {
        const { client } = _finalizeRefund(row);
        auditLog(req.user.login, 'retail_card_refund', { order_id: orderId, client_id: client.id, amount: row.amount, ip: getClientIp(req), resumed: true });
        try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId }); } catch (_) { /* alert best-effort */ }
        return res.json({ ok: true, balance: client.balance, resumed: true });
      } catch (e) {
        logger.error(`[Payments] refund ${orderId}: ledger reversal FAILED on resume: ${e.message}`);
        try { alerts && alerts.trigger('retail_card_refund', { login: row.client_id, client_id: row.client_id, amount: row.amount, order_id: orderId, error: 'reversal_failed' }); } catch (_) { /* alert best-effort */ }
        return res.status(500).json({ error: 'Возврат у провайдера подтверждён, но сторно не записалось — нужен ручной разбор', details: e.message });
      }
    }
    if (row.status === 'refund_pending') {
      // Исход вызова банка неизвестен. Повторный вызов может задвоить возврат —
      // только сверка с банком/webhook REFUNDED (§14.3).
      logger.error(`[Payments] refund ${orderId}: незавершённый возврат, нужна сверка`);
      try { alerts && alerts.trigger('retail_card_refund', { login: row.client_id, client_id: row.client_id, amount: row.amount, order_id: orderId, error: 'refund_uncertain' }); } catch (_) { /* alert best-effort */ }
      return res.status(409).json({ error: 'Возврат уже выполняется или его исход неизвестен — нужна сверка с банком', code: 'REFUND_REVIEW_REQUIRED' });
    }
    if (row.status !== 'credited') {
      return res.status(409).json({ error: `Возврат возможен только для зачисленных платежей (сейчас: ${row.status})` });
    }
    const provider = createProvider();
    if (!provider) return res.status(503).json({ error: 'Эквайринг не подключён', code: 'ACQUIRING_NOT_CONFIGURED' });
    const client = clientById.get(row.client_id);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });

    // 1. Захват заказа + durable-ключ ДО внешнего вызова: два параллельных
    //    refund больше не проходят проверку credited одновременно.
    try {
      const claim = cardPaymentsDb.claimRefund(orderId, client.id, row.amount);
      if (!claim || claim.changes === 0) {
        return res.status(409).json({ error: 'Возврат уже выполняется', code: 'REFUND_IN_PROGRESS' });
      }
    } catch (e) {
      logger.error(`[Payments] refund claim ${orderId}: ${e.message}`);
      return res.status(409).json({ error: 'Возврат уже выполняется или требует сверки', code: 'REFUND_IN_PROGRESS' });
    }

    // 2. Возврат у провайдера (вне транзакций).
    try {
      await provider.refund(row.provider_payment_id, row.amount);
    } catch (e) {
      if (e && e.definitive) {
        // Банк ТОЧНО отказал (HTTP 4xx) — возврата не было: отпускаем захват,
        // повтор разрешён.
        cardPaymentsDb.releaseRefundClaim(orderId);
        logger.error(`[Payments] refund ${orderId} refused by provider: ${e.message}`);
        return res.status(502).json({ error: 'Провайдер отклонил возврат — сторно не делалось', details: e.message, code: 'REFUND_REFUSED' });
      }
      // Сеть/таймаут/5xx — исход НЕИЗВЕСТЕН. Захват и ключ сохраняются,
      // слепой повтор запрещён (§14.3): сверка по webhook REFUNDED / вручную.
      logger.error(`[Payments] refund ${orderId} uncertain: ${e.message}`);
      try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId, error: 'refund_uncertain' }); } catch (_) { /* alert best-effort */ }
      return res.status(502).json({ error: 'Исход возврата у провайдера неизвестен — нужна сверка, повтор заблокирован', details: e.message, code: 'REFUND_UNCERTAIN' });
    }

    // 3. Фиксируем подтверждение банка ДО сторно — крах между фазами догоняется
    //    без повторного вызова провайдера.
    cardPaymentsDb.refundProviderOk(orderId);

    // 4. Сторно в ledger (payment_reversal) + откат рефкомиссии + статус.
    try {
      _finalizeRefund(row);
    } catch (e) {
      // Деньги у провайдера УЖЕ возвращены, а сторно не записалось — заказ в
      // refund_provider_ok: recovery доведёт, громкий лог + алерт + 500.
      logger.error(`[Payments] refund ${orderId}: provider OK, ledger reversal FAILED: ${e.message}`);
      try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId, error: 'reversal_failed' }); } catch (_) { /* alert best-effort */ }
      return res.status(500).json({ error: 'Возврат у провайдера прошёл, но сторно не записалось — recovery повторит без вызова банка', details: e.message });
    }

    // 5. Аудит + алерт (после durable-фиксации).
    auditLog(req.user.login, 'retail_card_refund', { order_id: orderId, client_id: client.id, amount: row.amount, ip: getClientIp(req) });
    try { alerts && alerts.trigger('retail_card_refund', { login: client.login, client_id: client.id, amount: row.amount, order_id: orderId }); } catch (_) { /* alert best-effort */ }
    res.json({ ok: true, balance: client.balance });
  });

  let recoveryRunning = false;
  r.runRecovery = async function runRecovery() {
    if (recoveryRunning) return { skipped: 'already_running' };
    recoveryRunning = true;
    let credited = 0, failed = 0, refundsFinalized = 0, refundsFailed = 0;
    try {
      for (const row of cardPaymentsDb.pendingPaid(50)) {
        try {
          _completeCredit(row);
          credited++;
        } catch (e) {
          failed++;
          logger.error(`[Payments recovery] ${row.order_id}: ${e.message}`);
          if (typeof cardPaymentsDb.markRecoveryFailure === 'function') {
            cardPaymentsDb.markRecoveryFailure(row.order_id, e.message);
          }
          const paidAt = Date.parse(row.created_at || '');
          if (Number.isFinite(paidAt) && Date.now() - paidAt >= 15 * 60000) {
            try { alerts && alerts.trigger('retail_card_payment', {
              login: row.client_id, client_id: row.client_id, amount: row.amount,
              method: row.method, error: 'recovery_failed', order_id: row.order_id,
            }); } catch (_) { /* alert best-effort */ }
          }
        }
      }
      // 2026-09-18 · DEEP-03: банк подтвердил возврат, а сторно не записано
      // (крах между фазами) — доводим БЕЗ нового вызова провайдера.
      if (typeof cardPaymentsDb.pendingRefundFinalize === 'function') {
        for (const row of cardPaymentsDb.pendingRefundFinalize(50)) {
          try {
            _finalizeRefund(row);
            refundsFinalized++;
          } catch (e) {
            refundsFailed++;
            logger.error(`[Payments recovery] refund ${row.order_id}: ${e.message}`);
            try { alerts && alerts.trigger('retail_card_refund', {
              login: row.client_id, client_id: row.client_id, amount: row.amount,
              order_id: row.order_id, error: 'reversal_failed',
            }); } catch (_) { /* alert best-effort */ }
          }
        }
      }
      return { credited, failed, refundsFinalized, refundsFailed };
    } finally { recoveryRunning = false; }
  };

  return r;
};
