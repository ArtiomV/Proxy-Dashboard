'use strict';
//
// src/routes/tochka.js — Tochka Bank integration (Stage 3).
//
// 23 routes spanning: webhook ingest, config CRUD, payment matching,
// act + bill generation, client-facing document fetch. Tightly coupled
// to src/tochka/* helpers + bank_payments table.

const express = require('express');
const { settleBillsOnPayment } = require('../billing/bill-settle');
const crypto = require('crypto');
// Stage 3 finish: helpers from src/tochka/documents.js. Until Stage 4 these
// were called bare and would have ReferenceError'd if a generate_act request
// ever fired through the router; the cron path in server.js worked only
// because server.js has its own wrapper.
const {
  buildActItemsFromLedger,
  buildTochkaActBody,
  buildTochkaBillBody,
  calculateMonthlyBillAmount,
} = require('../tochka/documents');
const { tochkaRequest: _rawTochkaRequest } = require('../tochka/api');
const { buildDocHtml: _buildDocHtml } = require('../documents/generator');
const { findClientByPayer, buildNaturalKey } = require('../billing/payer-match');

module.exports = function createTochkaRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    verifyJwtSignature, _pickField, insertBankPaymentToDb,
    dbAudit, dbStmts, bankPaymentFromRow, getAllBankPayments,
    tochkaConfig, saveTochkaConfig,
    atomicCredit,
    saveClients, rebuildClientMaps,
    auditLog, logActivity, getClientIp,
    appSettings,
    clients,
    clientById, clientByLogin, clientByInn,
    apiServers, SERVER_COUNTRIES,
    fetchAllServersDataCached,
    getMoscowToday,
    ledgerDb, clientsDb, documentsDb,
    runTochkaSync,
  } = deps;
  const r = express.Router();

  // A) Real-time auto-credit WITHOUT trusting the webhook. Tochka's JWT often
  // can't be verified (JWKS endpoint errors), so the webhook itself can't credit
  // — it lands the payment as «unmatched». Instead we treat the webhook as a
  // "ping": schedule a statement sync a few seconds later. The sync pulls the
  // statement via our OWN authenticated API call and credits by INN, so the money
  // decision is never based on unverified webhook content. Debounced/coalesced so
  // a burst of webhooks fires at most one sync; unref'd so it never blocks exit.
  let _webhookSyncTimer = null;
  function scheduleWebhookSync() {
    if (_webhookSyncTimer || typeof runTochkaSync !== 'function') return;
    _webhookSyncTimer = setTimeout(() => {
      _webhookSyncTimer = null;
      Promise.resolve()
        .then(() => runTochkaSync({ source: 'webhook' }))
        .then(res => { if (res && (res.matched || res.imported)) logger.info(`[Tochka] webhook-triggered sync: imported=${res.imported} matched=${res.matched}`); })
        .catch(e => logger.warn('[Tochka] webhook-triggered sync failed: ' + (e && e.message)));
    }, 8000);
    if (_webhookSyncTimer && _webhookSyncTimer.unref) _webhookSyncTimer.unref();
  }
  // Helpers in src/tochka/documents.js need `tochkaConfig` and a getLedger
  // getter; wrap them once so the call sites below stay readable.
  const _buildAct = (client, period) => buildActItemsFromLedger(client, period, (id) => ledgerDb.listByClient(id));
  const _calcBill = (client, cachedResults) => calculateMonthlyBillAmount(client, cachedResults, (id) => ledgerDb.listByClient(id));
  // BUGFIX: src/tochka/api.js exports tochkaRequest(tochkaConfig, method, path, body)
  // but every call site here passes only (method, path, body). The missing config
  // arg shifted everything → the body object landed in `apiPath`, which then failed
  // the string check with "Invalid Tochka API path" — so NO Tochka API call from
  // this router ever executed (acts/bills never reached Tochka). Wrap once to inject
  // the live config so the call sites stay 3-arg.
  const tochkaRequest = (method, apiPath, body) => _rawTochkaRequest(tochkaConfig, method, apiPath, body);
  const _buildActBody = (client, period, actItems, actNumber) => buildTochkaActBody(tochkaConfig, client, period, actItems, actNumber);
  const _buildBillBody = (client, amount, billNumber, billDate) => buildTochkaBillBody(tochkaConfig, client, amount, billNumber, billDate);
  // Stage 3 finish: these were bare-referenced in tochka.js without deps,
  // so any /generate_act / /sync / /closing_documents/:id/pdf request was a
  // latent ReferenceError. Stage 4 wires them properly.
  const buildDocHtml = (type, doc, client, billAmount) => _buildDocHtml(type, doc, client, billAmount, tochkaConfig);
  // Stage 13.1: referral_balance update moved into atomicCredit's txn.
  // No more router-side _clientUpdateReferralBalance.run() — kept here as
  // a hint to anyone wondering where the old call went.

r.post('/api/tochka/webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  logger.info('[Tochka Webhook] Received webhook');
  // Audit context — every webhook-driven write tags as source=webhook actor=tochka
  dbAudit.setActiveContext({ source: 'webhook', actor: 'tochka', ip: getClientIp(req), reason: 'tochka_webhook' });
  try {
    // Body is JWT string
    const jwtToken = typeof req.body === 'string' ? req.body.trim() : JSON.stringify(req.body);

    
    const { verified, payload, reason } = await verifyJwtSignature(jwtToken, tochkaConfig.jwt);
    if (!payload) {
      logger.error('[Tochka Webhook] Failed to decode JWT payload');
      return res.status(200).json({ ok: true, processed: false, reason: 'invalid_jwt' });
    }
    // If verification fails (e.g. Tochka rotated keys faster than our cache),
    // STILL save the decoded payload so admin can review and credit manually
    // — losing payment data was the worse failure mode.
    // Auto-credit only happens when verified = true.
    if (!verified) {
      logger.error(`[Tochka Webhook] JWT NOT verified: ${reason}. Saving as unverified for manual review.`);
      // Surface the security event in system_log so it shows up in the
      // admin "events" feed instead of buried in pino-only logs.
      try { logActivity('system', 'warn', 'tochka_unverified_webhook', null, `Unverified Tochka webhook accepted (reason: ${reason})`, { reason: String(reason || '').slice(0, 200), payerInn: _pickField(payload, ['SidePayer','sidePayer','payer'])?.inn || '', amount: payload.amount || payload.Amount || '' }); } catch (_) { /* best-effort: error intentionally swallowed */ }
      if (appSettings.tochka_strict_webhook) {
        // Strict mode: refuse to persist unverified payments at all. Off by default.
        return res.status(401).json({ ok: false, processed: false, reason: 'jwt_verification_failed' });
      }
      // fall through — don't return, let it land in bank_payments as unmatched
    } else {
      logger.info('[Tochka Webhook] JWT signature verified successfully');
    }

    logger.info('[Tochka Webhook] Decoded payload:', JSON.stringify(payload).slice(0, 500));

    const webhookType = payload.webhookType || payload.WebhookType || '';
    // Tochka has been observed returning both CamelCase ("SidePayer") and
    // camelCase ("sidePayer") depending on endpoint. Use a small helper that
    // tries every case-variant for the same logical field.
    const sidePayer = _pickField(payload, ['SidePayer', 'sidePayer', 'payer', 'Payer']) || {};
    const payerInn  = sidePayer.inn || sidePayer.Inn || sidePayer.taxCode || '';
    const payerName = sidePayer.name || sidePayer.Name || '';
    const amount = Math.round(parseFloat(payload.amount || payload.Amount || sidePayer.amount || sidePayer.Amount || '0') * 100) / 100;
    if (isNaN(amount) || amount <= 0 || amount > 100000000) {
      logger.warn(`[Tochka Webhook] Invalid amount: ${amount}, skipping auto-credit`);
      return res.status(200).json({ ok: true, processed: false, reason: 'invalid_amount' });
    }
    const purpose = payload.purpose || '';
    const paymentId = payload.paymentId || '';
    const paymentDate = payload.date || new Date().toISOString().slice(0, 10);
    const customerCode = payload.customerCode || '';

    
    // Build the bank-payment record up front
    // Stage 18.6: natural_key — see runTochkaSync. Webhook now populates the
    // same field so the very-next sync immediately recognises this transaction
    // and skips, without ever calling atomicCredit (the WildBox double-credit
    // path before this stage).
    const naturalKey = buildNaturalKey(payerInn, amount, paymentDate, purpose);
    const bankPayment = {
      id: crypto.randomBytes(8).toString('hex'),
      webhookType,
      payerInn,
      payerName,
      amount,
      purpose,
      paymentId,
      date: paymentDate,
      customerCode,
      naturalKey,
      receivedAt: new Date().toISOString(),
      matched: false,
      matchedClientId: null,
      matchedClientName: null,
      autoCredit: false
    };

    // Stage 18.6: natural-key idempotency gate. Before this, we relied on
    // UNIQUE(payment_id), but Tochka's webhook+sync return different ids for
    // the same real transaction, so that constraint was insufficient.
    // Now: if a row already exists with the same natural_key (payer+amount
    // +date+purpose-prefix), the credit has already happened — bail out.
    if (dbStmts.findBankPaymentByNaturalKey && dbStmts.findBankPaymentByNaturalKey.get(naturalKey)) {
      logger.info(`[Tochka Webhook] Duplicate natural_key (already processed) — payer=${payerInn} amount=${amount} date=${paymentDate}`);
      // Stage 18.13: дубль-кредит заблокирован — это хорошо, но стоит знать (редкое событие)
      try {
        require('../telegram/alerts').trigger('duplicate_credit_blocked', {
          client: payerName || ('ИНН ' + payerInn), amount, natural_key: naturalKey,
        });
      } catch (e) {
        // P2-1: alert is best-effort — the accounting decision (dup blocked, NOT
        // re-credited) already happened and was logged above; a failed Telegram
        // send must not change the 200 response. Log at debug for traceability.
        logger.debug(`[Tochka] duplicate_credit_blocked alert failed: ${e.message}`);
      }
      return res.status(200).json({ ok: true, processed: false, reason: 'duplicate_natural_key' });
    }

    // Atomic insert — UNIQUE(payment_id) on bank_payments enforces idempotency
    // even under concurrent webhook delivery. Two parallel webhook requests
    // with the same paymentId can no longer both insert + double-credit.
    let inserted = false;
    try {
      insertBankPaymentToDb(bankPayment);
      inserted = true;
    } catch (e) {
      if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
        logger.info(`[Tochka Webhook] Duplicate paymentId=${paymentId} (race-safe)`);
        return res.status(200).json({ ok: true, processed: false, reason: 'duplicate' });
      }
      throw e;
    }

    // Auto-credit only when (a) JWT was verified, (b) it's an incoming payment,
    // and (c) we just won the race to insert the row. The DB-level UNIQUE
    // guarantees no concurrent webhook can also reach this branch for the same paymentId.
    if (verified && webhookType === 'incomingPayment') {
      // Match by INN (primary) or unambiguous company name (fallback).
      const _payerMatch = findClientByPayer(payerInn, payerName, clientByInn, clients);
      const matchedClient = _payerMatch && _payerMatch.client;
      if (matchedClient) {
        try {
          // Stage 13.1: balance + ledger + referral all run in atomicCredit's
          // single txn (was previously two adjacent db.transaction() calls,
          // i.e. two commits — a crash between them left the bank_payment
          // unmatched but the balance credited).
          let referralOpts = null;
          if (matchedClient.referred_by) {
            const referrer = clientById.get(matchedClient.referred_by);
            if (referrer) {
              referralOpts = {
                referrerId: referrer.id,
                delta: Math.round(amount * 0.15 * 100) / 100,
              };
            }
          }
          atomicCredit(matchedClient.id, amount, {
            type: 'bank_payment',
            date: paymentDate,
            timestamp: new Date().toISOString(),
            amount, currency: 'RUB',
            note: `Банк Точка (ИНН: ${payerInn}): ${purpose}`.slice(0, 300),
            source: 'tochka_webhook',
            paymentId
          }, referralOpts ? { referral: referralOpts } : undefined);
          // Match-mark stays in its own txn since it touches a DIFFERENT
          // table (bank_payments) — the credit + referral already committed
          // by atomicCredit, so the worst case here is a stuck "unmatched"
          // bank_payment row that admin can reconcile manually. The reverse
          // ordering (match-mark first, then credit) would risk double-credit
          // on retry, which is the worse failure.
          dbStmts.updateBankPaymentMatch.run(1, matchedClient.id, matchedClient.name, 1, paymentId);
          try { settleBillsOnPayment(matchedClient, amount, purpose, { documentsDb, logActivity, logger }); } catch (e) { logger.error('[BillSettle]', e.message); }
          if (!matchedClient.payments) matchedClient.payments = [];
          matchedClient.payments.push({
            amount, date: paymentDate,
            note: `Банк Точка: ${payerName} — ${purpose}`.slice(0, 200),
            createdAt: new Date().toISOString(),
            source: 'tochka_webhook',
            paymentId
          });
          saveClients(clients);
          bankPayment.matched = true;
          bankPayment.matchedClientId = matchedClient.id;
          bankPayment.autoCredit = true;
          logger.info(`[Tochka Webhook] Auto-credited ${amount} RUB to ${matchedClient.name} (INN: ${payerInn})`);
          // Stage 18.13: «новый платёж» — любой платёж от webhook.
          try {
            require('../telegram/alerts').trigger('payment_received', {
              client: matchedClient.name, client_id: matchedClient.id,
              amount, inn: payerInn, source: 'Точка (webhook)',
              natural_key: naturalKey, date: paymentDate,
              balanceAfter: matchedClient.balance,
            });
          } catch (e) {
            // P2-1: best-effort notification — the credit itself already committed
            // (atomicCredit in the same handler); a failed alert must not undo it.
            logger.debug(`[Tochka] payment_received alert failed: ${e.message}`);
          }
        } catch (e) {
          logger.error(`[Tochka Webhook] credit failed for ${matchedClient.name}:`, e.message);
          // Row stays unmatched — admin can attribute manually.
        }
      } else {
        logger.info(`[Tochka Webhook] Unmatched: INN=${payerInn}, amount=${amount}, purpose=${purpose}`);
      }
    }

    // A) If this incoming payment wasn't auto-credited right here (e.g. JWT
    // unverified, or no client matched yet), ping a statement sync — the trusted
    // path reconciles + credits it by INN within seconds instead of ≤30 min.
    if (webhookType === 'incomingPayment' && !bankPayment.matched) {
      try { scheduleWebhookSync(); } catch (_) { /* best-effort */ }
    }

    res.status(200).json({ ok: true, processed: true, inserted, matched: bankPayment.matched, verified });
  } catch (err) {
    logger.error('[Tochka Webhook] Error:', err.message);
    res.status(200).json({ ok: true, processed: false, reason: err.message });
  } finally {
    dbAudit.clearActiveContext();
  }
});

r.post('/api/admin/tochka/config', authMiddleware, adminMiddleware, async (req, res) => {
  const { jwt, clientId, customerCode, accountId, companyName, companyInn, companyKpp, companyAddress, bankAccount, bankName, bankBic, bankCorrAccount } = req.body;
  // GET отдаёт jwt маской «****XXXXXXXX» — если форма прислала её обратно,
  // хранимый токен НЕ трогаем (иначе любое «Сохранить» убивает интеграцию).
  if (typeof jwt === 'string' && !jwt.startsWith('****')) tochkaConfig.jwt = jwt.trim();
  if (typeof clientId === 'string') tochkaConfig.clientId = clientId.trim();
  if (typeof customerCode === 'string') tochkaConfig.customerCode = customerCode.trim();
  if (typeof accountId === 'string') tochkaConfig.accountId = accountId.trim();
  if (typeof companyName === 'string') tochkaConfig.companyName = companyName.trim();
  if (typeof companyInn === 'string') tochkaConfig.companyInn = companyInn.trim();
  if (typeof companyKpp === 'string') tochkaConfig.companyKpp = companyKpp.trim();
  if (typeof companyAddress === 'string') tochkaConfig.companyAddress = companyAddress.trim();
  if (typeof bankAccount === 'string') tochkaConfig.bankAccount = bankAccount.trim();
  if (typeof bankName === 'string') tochkaConfig.bankName = bankName.trim();
  if (typeof bankBic === 'string') tochkaConfig.bankBic = bankBic.trim();
  if (typeof bankCorrAccount === 'string') tochkaConfig.bankCorrAccount = bankCorrAccount.trim();
  // Stage 15.1: await the disk write before responding. Payment credentials
  // are sensitive enough that "200 OK saved" must mean "on disk", not
  // "in memory only" — a kill -9 between the response and the write
  // would otherwise lose the change silently.
  await saveTochkaConfig();
  logger.info('[Tochka] Config updated from admin UI, jwt=' + (tochkaConfig.jwt ? 'set' : 'empty') + ', clientId=' + tochkaConfig.clientId);
  res.json({ ok: true, configured: !!tochkaConfig.jwt });
});

r.get('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    jwt: tochkaConfig.jwt ? '****' + tochkaConfig.jwt.slice(-8) : '',
    clientId: tochkaConfig.clientId,
    customerCode: tochkaConfig.customerCode,
    accountId: tochkaConfig.accountId,
    companyName: tochkaConfig.companyName,
    companyInn: tochkaConfig.companyInn,
    companyKpp: tochkaConfig.companyKpp,
    companyAddress: tochkaConfig.companyAddress,
    bankAccount: tochkaConfig.bankAccount,
    bankName: tochkaConfig.bankName,
    bankBic: tochkaConfig.bankBic,
    bankCorrAccount: tochkaConfig.bankCorrAccount
  });
});

r.post('/api/admin/tochka/autodetect', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt) {
    return res.status(400).json({ error: 'JWT токен не заполнен' });
  }
  try {
    const results = {};
    // 1. Get customers list -> customerCode
    try {
      const custResult = await tochkaRequest('GET', '/uapi/open-banking/v1.0/customers');
      const cd = custResult.data?.Data || custResult.data || {};
      const customers = cd.Customer || cd.Customers || cd.customers || (Array.isArray(cd) ? cd : []);
      logger.info('[Tochka Autodetect] Customers raw:', JSON.stringify(custResult.data).slice(0, 500));
      if (Array.isArray(customers) && customers.length > 0) {
        const c = customers[0];
        results.customerCode = c.customerCode || c.CustomerCode || c.code || '';
        results.companyName = c.fullName || c.shortName || c.name || c.Name || c.organizationName || '';
        results.companyInn = c.taxCode || c.inn || c.Inn || c.INN || '';
        results.companyKpp = c.kpp || c.Kpp || c.KPP || '';
      }
    } catch (e) { logger.info('[Tochka Autodetect] Customers error:', e.message); }
    // 2. Get accounts list -> accountId
    try {
      const accResult = await tochkaRequest('GET', '/uapi/open-banking/v1.0/accounts');
      const ad = accResult.data?.Data || accResult.data || {};
      const accounts = ad.Account || ad.Accounts || ad.accounts || (Array.isArray(ad) ? ad : []);
      logger.info('[Tochka Autodetect] Accounts raw:', JSON.stringify(accResult.data).slice(0, 500));
      if (Array.isArray(accounts) && accounts.length > 0) {
        const rub = accounts.find(a => (a.currency === 'RUB' || a.Currency === 'RUB')) || accounts[0];
        results.accountId = rub.accountId || rub.AccountId || rub.resourceId || '';
        if (!results.customerCode && rub.customerCode) results.customerCode = rub.customerCode;
      }
    } catch (e) { logger.info('[Tochka Autodetect] Accounts error:', e.message); }
    // Save detected values
    if (results.customerCode) tochkaConfig.customerCode = results.customerCode;
    if (results.accountId) tochkaConfig.accountId = results.accountId;
    if (results.companyName) tochkaConfig.companyName = results.companyName;
    if (results.companyInn) tochkaConfig.companyInn = results.companyInn;
    if (results.companyKpp) tochkaConfig.companyKpp = results.companyKpp;
    saveTochkaConfig();
    logger.info('[Tochka Autodetect] Results:', JSON.stringify(results));
    res.json({ ok: true, detected: results });
  } catch (err) {
    res.status(502).json({ error: 'Ошибка автоопределения', details: err.message });
  }
});

r.post('/api/admin/tochka/register_webhook', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt || !tochkaConfig.clientId) {
    return res.status(400).json({ error: 'Tochka API not configured. Введите JWT токен и Client ID в разделе Банк.' });
  }
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });

  try {
    const result = await tochkaRequest('PUT', `/uapi/webhook/v1.0/${tochkaConfig.clientId}`, {
      webhookUrl,
      webhookType: 'incomingPayment'
    });
    logger.info('[Tochka] Webhook registered:', JSON.stringify(result.data));
    res.json({ ok: true, result: result.data });
  } catch (err) {
    res.status(502).json({ error: 'Failed to register webhook', details: err.message });
  }
});

r.post('/api/admin/tochka/sync', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await runTochkaSync({
    dateFrom: req.body?.dateFrom,
    dateTo:   req.body?.dateTo,
    source:   'manual'
  });
  if (!result.ok) {
    const status = result.error === 'tochka_not_configured' ? 400
                 : result.error === 'statement_not_ready'   ? 504
                 : 502;
    return res.status(status).json({ error: result.error, details: result.details });
  }
  res.json(result);
});

r.get('/api/admin/tochka/payments', authMiddleware, adminMiddleware, (req, res) => {
  const payments = getAllBankPayments();
  res.json({
    configured: !!tochkaConfig.jwt,
    payments,
    unmatchedCount: dbStmts.countUnmatchedPayments.get().cnt
  });
});

r.post('/api/admin/tochka/dismiss_unmatched', authMiddleware, adminMiddleware, (req, res) => {
  const result = dbStmts.dismissAllUnmatched.run();
  logger.info(`[Tochka] Dismissed ${result.changes} unmatched payments`);
  res.json({ ok: true, dismissed: result.changes });
});

r.post('/api/admin/tochka/dismiss_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId } = req.body;
  const row = dbStmts.getBankPaymentById.get(paymentId);
  if (!row) return res.status(404).json({ error: 'Payment not found' });
  dbStmts.dismissBankPayment.run(paymentId);
  res.json({ ok: true });
});

r.post('/api/admin/tochka/match_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId, clientId } = req.body;
  if (!paymentId || !clientId) return res.status(400).json({ error: 'paymentId and clientId required' });

  const bpRow = dbStmts.getBankPaymentById.get(paymentId);
  if (!bpRow) return res.status(404).json({ error: 'Payment not found' });
  const bp = bankPaymentFromRow(bpRow);
  
  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  
  const amount = bp.amount;

  if (!client.payments) client.payments = [];
  client.payments.push({
    amount,
    date: bp.date,
    note: `Ручная привязка: ${bp.payerName} — ${bp.purpose}`.slice(0, 200),
    createdAt: new Date().toISOString(),
    source: 'tochka_manual',
    paymentId: bp.paymentId
  });

  const { balanceBefore, balanceAfter } = atomicCredit(client.id, amount, {
    type: 'bank_payment',
    date: bp.date,
    timestamp: new Date().toISOString(),
    amount,
    currency: 'RUB',
    note: `Ручная привязка (ИНН: ${bp.payerInn}): ${bp.purpose}`.slice(0, 300),
    source: 'tochka_manual',
    paymentId: bp.paymentId
  });

  // Update bank payment in SQLite
  dbStmts.updateBankPaymentMatch.run(1, client.id, client.name, 0, paymentId);
  try { settleBillsOnPayment(client, amount, bp.purpose, { documentsDb, logActivity, logger }); } catch (e) { logger.error('[BillSettle]', e.message); }

  saveClients(clients);
  res.json({ ok: true, balance: client.balance });
});

r.post('/api/admin/tochka/create_act', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, period, items } = req.body;
  if (!clientId || !period) return res.status(400).json({ error: 'clientId and period required' });

  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  
  let actItems = items;
  if (!actItems || actItems.length === 0) {
    ({ actItems } = _buildAct(client, period));
  }

  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);

  // Try to create via Tochka API if configured.
  // We do NOT trust "no exception" as success — we inspect the response and
  // record exactly why a push failed so the operator is told, instead of the
  // act silently living only in our DB (tochka_doc_id NULL).
  let tochkaDocumentId = null;
  let tochkaPushed = false;
  let tochkaStatus = '';   // human-readable outcome surfaced to the operator
  const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
  if (!tochkaConfig.jwt || !tochkaConfig.customerCode || !tochkaConfig.accountId) {
    tochkaStatus = 'Точка не настроена (нет JWT / customerCode / accountId)';
  } else if (!client.inn) {
    tochkaStatus = 'У клиента не указан ИНН — Точка не примет акт';
  } else {
    try {
      const actData = _buildActBody(client, period, actItems, actNumber);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaDocumentId = result.data.Data.documentId;
        tochkaPushed = true;
        tochkaStatus = 'Отправлен в Точку';
        logger.info(`[Tochka] Created act ${tochkaDocumentId} for ${client.name}, period ${period}`);
      } else {
        const errDetail = result.data?.Errors ? JSON.stringify(result.data.Errors).slice(0, 300)
          : (result.data?.message || JSON.stringify(result.data || {}).slice(0, 300));
        tochkaStatus = `Точка вернула статус ${result.status}: ${errDetail}`;
        logger.error({ tochkaResponse: result.data, status: result.status }, '[Tochka] Create act unexpected response');
      }
    } catch (err) {
      tochkaStatus = `Ошибка запроса в Точку: ${err.message}`;
      logger.error('[Tochka] Create act error:', err.message);
    }
  }

  // Save locally regardless of Tochka API success
  const docId = crypto.randomBytes(8).toString('hex');
  const closingDoc = {
    id: docId,
    tochkaDocumentId,
    period,
    createdAt: new Date().toISOString(),
    status: 'unsigned', // unsigned | signed
    totalAmount: Math.round(totalAmount * 100) / 100,
    items: actItems,
    actNumber,
    contractInfo: client.contractInfo || ''
  };

  if (!client.closingDocuments) client.closingDocuments = [];
  client.closingDocuments.push(closingDoc);
  saveClients(clients);

  res.json({ ok: true, document: closingDoc, tochkaPushed, tochkaStatus });
});

r.get('/api/admin/clients/:id/closing_documents/:docId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.tochkaDocumentId) {
    return res.status(404).json({ error: 'Документ не связан с Точкой. PDF недоступен.' });
  }

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}/file`);
    if (result.buffer) {
      // The act number is Cyrillic ("АКТ-..."), which Node forbids in a raw
      // header value — setHeader would throw "Invalid character in header
      // content" and the download 502'd. Use RFC 5987 (filename*) with an
      // ASCII fallback, same as the bill route below.
      const fname = `${doc.actNumber || 'act'}.pdf`;
      const asciiName = fname.replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

r.get('/api/admin/clients/:id/closing_documents/:docId/print', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  const html = buildDocHtml('act', doc, client); // sanitized via escHtml
  res.send(html); // NOSONAR: output is escaped in buildDocHtml
});

r.post('/api/admin/clients/:id/closing_document_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { docId, status } = req.body;
  if (!docId || !['signed', 'unsigned'].includes(status)) {
    return res.status(400).json({ error: 'docId and status (signed/unsigned) required' });
  }
  const doc = (client.closingDocuments || []).find(d => d.id === docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  doc.status = status;
  doc.signedAt = (status === 'signed') ? new Date().toISOString() : undefined;
  // Persist DIRECTLY to the DB. saveClients() uses INSERT OR IGNORE for closing
  // docs, so a status change on an existing row would otherwise be dropped and
  // server.js would reload the old «unsigned» status on the next data refresh.
  try { documentsDb.updateClosingStatus(doc.id, status, doc.signedAt || null); } catch (_) {}
  saveClients(clients);
  res.json({ ok: true, document: doc });
});

r.delete('/api/admin/clients/:id/closing_document/:docId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const docIdx = (client.closingDocuments || []).findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });

  const doc = client.closingDocuments[docIdx];
  // Try to delete from Tochka too
  if (doc.tochkaDocumentId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}`);
    } catch (e) { logger.warn('[Tochka] Delete doc error:', e.message); }
  }

  client.closingDocuments.splice(docIdx, 1);
  // Stage 13.2: explicit row delete (saveClients no longer wipes the table).
  documentsDb.deleteClosing(doc.id);
  saveClients(clients);
  res.json({ ok: true });
});

r.get('/api/admin/clients/:id/closing_documents', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.closingDocuments || []);
});

r.get('/api/admin/tochka/all_acts', authMiddleware, adminMiddleware, (req, res) => {
  const allDocs = [];
  for (const client of clients) {
    (client.closingDocuments || []).forEach(d => {
      allDocs.push({
        ...d,
        clientId: client.id,
        clientName: client.name,
        clientInn: client.inn || ''
      });
    });
  }
  allDocs.sort((a, b) => (b.period || '').localeCompare(a.period || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ documents: allDocs });
});

r.post('/api/admin/tochka/generate_acts', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body; // YYYY-MM
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period required (YYYY-MM)' });

  let generated = 0, skipped = 0, errors = 0;
  const results = [];

  for (const client of clients) {
    if (client.clientType === 'individual') { skipped++; continue; }  // физ. лицо — акты не нужны
    const ledgerEntries = ledgerDb.listByClient(client.id);
    const monthCharges = ledgerEntries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) { skipped++; continue; }

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) {
      skipped++;
      results.push({ client: client.name, status: 'exists' });
      continue;
    }

    try {
      
      const { actItems, totalCost } = _buildAct(client, period);
      if (totalCost <= 0) { skipped++; continue; }

      // Try Tochka API
      let tochkaDocumentId = null;
      const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
      if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
        try {
          const actData = _buildActBody(client, period, actItems, actNumber);
          const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
          if (result.status === 200 && result.data?.Data?.documentId) {
            tochkaDocumentId = result.data.Data.documentId;
          }
        } catch (e) { logger.error(`[Tochka BulkActs] API error for ${client.name}:`, e.message); }
      }

      const docId = crypto.randomBytes(8).toString('hex');
      if (!client.closingDocuments) client.closingDocuments = [];
      client.closingDocuments.push({
        id: docId,
        tochkaDocumentId,
        period,
        createdAt: new Date().toISOString(),
        status: 'unsigned',
        totalAmount: totalCost,
        items: actItems,
        actNumber,
        contractInfo: client.contractInfo || ''
      });
      generated++;
      results.push({ client: client.name, status: 'created', amount: totalCost });
      logger.info(`[Tochka BulkActs] Created act for ${client.name}: ${totalCost} RUB (period ${period})`);
    } catch (e) {
      errors++;
      results.push({ client: client.name, status: 'error', error: e.message });
    }
  }

  if (generated > 0) saveClients(clients);
  auditLog(req.user.login, 'generate_acts', { period: period || 'auto', generated, skipped, errors, ip: getClientIp(req) });
  res.json({ ok: true, generated, skipped, errors, results });
});

r.post('/api/admin/tochka/create_bill', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, amount: manualAmount, period } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Calculate amount or use manual
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  let serverData = [];
  if (!manualAmount) {
    try { serverData = await fetchAllServersDataCached(); } catch (e) { logger.error('[Bills] fetchAllServersData error:', e.message); }
  }
  let amount = manualAmount || _calcBill(client, serverData);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Cannot calculate bill amount (no charges found)' });

  const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
  const billDate = now.toISOString().slice(0, 10);

  let tochkaBillId = null;
  if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
    try {
      const billData = _buildBillBody(client, amount, billNumber, billDate);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaBillId = result.data.Data.documentId;
        logger.info(`[Tochka] Created bill ${tochkaBillId} for ${client.name}, amount ${amount}`);
      } else {
        logger.error('[Tochka] Create bill response:', JSON.stringify(result.data));
      }
    } catch (err) {
      logger.error('[Tochka] Create bill error:', err.message);
    }
  }

  const billId = crypto.randomBytes(8).toString('hex');
  const bill = {
    id: billId,
    tochkaBillId,
    period: billPeriod,
    createdAt: new Date().toISOString(),
    amount: Math.round(amount * 100) / 100,
    status: 'unpaid',
    billNumber
  };

  if (!client.bills) client.bills = [];
  client.bills.push(bill);
  saveClients(clients);

  res.json({ ok: true, bill });
});

r.post('/api/admin/tochka/generate_bills', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body;
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  const billDate = now.toISOString().slice(0, 10);

  let generated = 0, skipped = 0, errors = 0;
  const results = [];
  let serverData = [];
  try { serverData = await fetchAllServersDataCached(); } catch (e) { logger.error('[Bills] fetchAllServersData error:', e.message); }

  for (const client of clients) {
    if (client.clientType === 'individual') { skipped++; continue; }  // физ. лицо — счета не нужны
    if (!client.inn) { skipped++; continue; }
    if ((client.bills || []).some(b => b.period === billPeriod)) { skipped++; continue; }

    const amount = _calcBill(client, serverData);
    if (!amount || amount <= 0) { skipped++; continue; }

    const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
    let tochkaBillId = null;

    if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId) {
      try {
        const billData = _buildBillBody(client, amount, billNumber, billDate);
        const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
        if (result.status === 200 && result.data?.Data?.documentId) {
          tochkaBillId = result.data.Data.documentId;
        } else {
          logger.error(`[Tochka] Bill error for ${client.name}:`, JSON.stringify(result.data));
        }
      } catch (err) {
        logger.error(`[Tochka] Bill error for ${client.name}:`, err.message);
      }
    }

    const billId = crypto.randomBytes(8).toString('hex');
    if (!client.bills) client.bills = [];
    client.bills.push({
      id: billId,
      tochkaBillId,
      period: billPeriod,
      createdAt: new Date().toISOString(),
      amount: Math.round(amount * 100) / 100,
      status: 'unpaid',
      billNumber
    });

    generated++;
    results.push({ client: client.name, status: 'created', amount: Math.round(amount * 100) / 100 });
  }

  if (generated > 0) saveClients(clients);
  auditLog(req.user.login, 'generate_bills', { period: billPeriod, generated, skipped, errors, ip: getClientIp(req) });
  res.json({ ok: true, generated, skipped, errors, results });
});

r.get('/api/admin/tochka/all_bills', authMiddleware, adminMiddleware, (req, res) => {
  const allBills = [];
  for (const client of clients) {
    for (const b of (client.bills || [])) {
      allBills.push({
        ...b,
        clientId: client.id,
        clientName: client.name,
        clientInn: client.inn || ''
      });
    }
  }
  allBills.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ bills: allBills });
});

r.get('/api/admin/clients/:id/bills/:billId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill || !bill.tochkaBillId) return res.status(404).json({ error: 'Bill not found or no Tochka ID' });

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}/file`);
    if (result.status === 200 && result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(bill.billNumber + '.pdf')}`);
      res.send(result.buffer);
    } else {
      res.status(500).json({ error: 'Failed to download PDF' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

r.get('/api/admin/clients/:id/bills/:billId/print', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  const html = buildDocHtml('bill', bill, client, bill.amount); // sanitized via escHtml
  res.send(html); // NOSONAR: output is escaped in buildDocHtml
});

r.post('/api/admin/clients/:id/bill_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { billId, status } = req.body;
  const bill = (client.bills || []).find(b => b.id === billId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  bill.status = status === 'paid' ? 'paid' : 'unpaid';
  // Persist DIRECTLY to the bills table. saveClients() uses INSERT OR IGNORE for
  // bills, so a status change on an existing row would otherwise be dropped and
  // server.js would rebuild client.bills as «unpaid» on the next reload.
  try { documentsDb.updateBillStatus(bill.id, bill.status); } catch (_) {}
  saveClients(clients);
  res.json({ ok: true, bill });
});

r.delete('/api/admin/clients/:id/bill/:billId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const idx = (client.bills || []).findIndex(b => b.id === req.params.billId);
  if (idx === -1) return res.status(404).json({ error: 'Bill not found' });

  const bill = client.bills[idx];
  if (bill.tochkaBillId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}`);
    } catch (e) { logger.error('[Tochka] Delete bill error:', e.message); }
  }
  client.bills.splice(idx, 1);
  // Stage 13.2: explicit row delete (saveClients no longer wipes the table).
  documentsDb.deleteBill(bill.id);
  saveClients(clients);
  res.json({ ok: true });
});

  return r;
};
