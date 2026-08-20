'use strict';
//
// src/routes/clients.js — admin client CRUD + balance ops (Stage 3).
//
// 14 core routes (closing_documents + bills go to src/routes/tochka.js).
// Covered by 10 characterization tests in tests/api/clients.test.js.

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { sha256hex } = require('../utils/secrets');
const financeEvents = require('../billing/events');   // WP7.2: cache invalidation on client mutations
const { referralCommission } = require('../billing/referral');   // A1/Р6: комиссия 10%, единая константа
function _emitFinanceWrite() {
  try { financeEvents.emit('finance-write'); } catch (_) { /* best-effort */ }
}

module.exports = function createClientsRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    validate, ClientCreateSchema, PaymentSchema, BalanceAdjustSchema,
    fetchAllServersDataCached, mergeServerData, fetchApi,
    atomicCredit, atomicDebit,
    saveClients, rebuildClientMaps,
    deleteSessionsByLogin,
    auditLog, logActivity, getClientIp,
    generateId,
    clients,
    clientById, clientByLogin, clientByApiKey, clientByInn, clientByResetToken,
    users,
    _ledgerInsert, _ledgerEntryParams, ledgerDb, documentsDb,
    DOCUMENTS_DIR,
    validateClientInput,
    appSettings,
    notifyClient,   // B2C Э3 (WP5): «Зачислено N ₽» клиенту после ручного зачисления
    // Ручная блокировка клиента (POST /:id/block): гашение портов и пула.
    proxyConf, parseHtmlInputFields, findServer, proxySmart, getMoscowNow,
    retailPoolDb, alerts,
  } = deps;
  const r = express.Router();

  // 19.07: recalcFromLedger здесь больше не используется. Реплей остался в
  // src/billing/recalc.js как диагностика; enforcement — ledgerFinalBalance.

r.get('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const search = (req.query.search || '').toLowerCase().trim();
  
  let filtered = clients;
  if (search) {
    filtered = clients.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      (c.login || '').toLowerCase().includes(search) ||
      (c.portName || '').toLowerCase().includes(search) ||
      (c.contact || '').toLowerCase().includes(search)
    );
  }
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  // Mask the stored apiKey hash with the display prefix — the hash must never
  // leave the server; the full key is only shown once at (re)generation.
  const safe = page.map(c => {
    const { password, passwordHash, ...rest } = c;
    return { ...rest, apiKey: rest.apiKeyPrefix ? rest.apiKeyPrefix + '••••••••' : '' };
  });
  res.json({ clients: safe, total, limit, offset });
});

r.post('/api/admin/clients', authMiddleware, adminMiddleware, validate(ClientCreateSchema), async (req, res) => {
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by, inn, kpp, legalName, contractInfo, contractDate, address, clientType, allowDebt, maxDebt } = req.body;
  if (!name || !portName || !login || !password) {
    return res.status(400).json({ error: 'name, portName, login, password required' });
  }
  // Validation handled by zod middleware (validate(ClientCreateSchema))
  if (users[login]) {
    return res.status(400).json({ error: 'Login already exists: ' + login });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  // Only the SHA-256 hash is kept (migration 043); the plaintext key is
  // returned ONCE in the create response and is unrecoverable afterwards.
  const plainApiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  // Same for the self-service reset token (migration 045).
  const plainResetToken = crypto.randomBytes(16).toString('hex');
  const client = {
    id: generateId(),
    name, portName, login,
    password, // kept for admin reference
    passwordHash,
    contact: contact || '',
    notes: notes || '',
    // Базовый тариф для новых клиентов — «За модем» (ежедневное списание),
    // если тип не задан явно (2026-07-26, раньше был per_gb).
    billingType: billingType || 'per_modem',
    price: parseFloat(price) || 0,
    currency: currency || 'RUB',
    payments: [],
    apiKey: sha256hex(plainApiKey),
    apiKeyPrefix: plainApiKey.slice(0, 8),
    referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    referred_by: null,
    referral_balance: 0,
    // Hash-only at rest (migration 045); plaintext returned once in the
    // create response, then unrecoverable — client rotates via the portal.
    resetToken: sha256hex(plainResetToken),
    documents: [],
    balance: 0,
    last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
    inn: inn || '',
    kpp: kpp || '',
    legalName: legalName || '',
    contractInfo: contractInfo || '',
    contractDate: contractDate || '',
    address: address || '',
    closingDocuments: [],
    bills: [],
    autoActs: true,
    autoBills: true,
    billingPaused: false,
    allowDebt: !!allowDebt,
    maxDebt: typeof maxDebt === 'number' ? maxDebt : null,
    clientType: clientType || 'individual',   // 2026-08-04: базово физ. лицо (реша оператора)
    createdAt: new Date().toISOString()
  };

  // Handle referral: if referred_by code is provided
  if (referred_by) {
    const referrer = clients.find(c => c.referral_code === referred_by);
    if (referrer) {
      client.referred_by = referrer.id;
    }
  }

  clients.push(client);
  try {
    saveClients(clients);
  } catch (e) {
    // Race: two concurrent POSTs hit the in-memory check before either ran saveClients.
    // SQLite UNIQUE(login) catches it here — roll back the in-memory push.
    clients.pop();
    if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(e.message || ''))) {
      return res.status(409).json({ error: 'Login or API key already exists (race detected)' });
    }
    throw e;
  }
  rebuildClientMaps();
  users[login] = { passwordHash, portNameFilter: portName, source: 'client', clientId: client.id };
  _emitFinanceWrite();

  const { password: _p, passwordHash: _ph, ...safeClient } = client;
  // One-time plaintext reveal: safeClient.apiKey / resetToken are the stored
  // SHA-256 hashes; the response swaps in the real secrets so the admin can
  // hand them to the client.
  res.json({ ok: true, client: { ...safeClient, apiKey: plainApiKey, resetToken: plainResetToken } });
});

r.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  
  const old = clientById.get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Client not found' });
  const idx = clients.indexOf(old);
  // BUG-12: Validate input
  const valErr = validateClientInput(req.body, false);
  if (valErr) return res.status(400).json({ error: valErr });
  const { name, portName, login, password, contact, notes, billingType, price, currency, inn, kpp, legalName, contractInfo, contractDate, address, autoActs, autoBills, billingPaused, clientType, allowDebt, maxDebt } = req.body;
  if (login && login !== old.login) {
    if (users[login]) return res.status(400).json({ error: 'Login already exists: ' + login });
    delete users[old.login];
  }
  
  let newPasswordHash = old.passwordHash;
  let newPassword = old.password;
  if (password && password !== old.password) {
    newPasswordHash = await bcrypt.hash(password, 10);
    newPassword = password;
  }
  const updated = {
    ...old,
    name: name || old.name,
    portName: portName || old.portName,
    login: login || old.login,
    password: newPassword,
    passwordHash: newPasswordHash,
    contact: contact !== undefined ? contact : old.contact,
    notes: notes !== undefined ? notes : old.notes,
    billingType: billingType !== undefined ? billingType : (old.billingType || 'per_modem'),
    price: price !== undefined ? parseFloat(price) : (old.price || 0),
    currency: currency !== undefined ? currency : (old.currency || 'RUB'),
    inn: inn !== undefined ? inn : (old.inn || ''),
    kpp: kpp !== undefined ? kpp : (old.kpp || ''),
    legalName: legalName !== undefined ? legalName : (old.legalName || ''),
    contractInfo: contractInfo !== undefined ? contractInfo : (old.contractInfo || ''),
    contractDate: contractDate !== undefined ? contractDate : (old.contractDate || ''),
    address: address !== undefined ? address : (old.address || ''),
    autoActs: autoActs !== undefined ? autoActs : (old.autoActs !== undefined ? old.autoActs : true),
    autoBills: autoBills !== undefined ? autoBills : (old.autoBills !== undefined ? old.autoBills : true),
    billingPaused: billingPaused !== undefined ? billingPaused : (old.billingPaused || false),
    allowDebt: allowDebt !== undefined ? !!allowDebt : !!old.allowDebt,
    maxDebt: maxDebt !== undefined ? (typeof maxDebt === 'number' ? maxDebt : null) : (old.maxDebt !== undefined ? old.maxDebt : null),
    clientType: clientType !== undefined ? clientType : (old.clientType || 'legal')
  };
  clients[idx] = updated;
  saveClients(clients);
  rebuildClientMaps();
  users[updated.login] = { passwordHash: updated.passwordHash, portNameFilter: updated.portName, source: 'client', clientId: updated.id };
  _emitFinanceWrite();

  // B1 (Р14): журнал смены цены (кто/когда/старая/новая). Акт mid-month
  // разбивается по price_per_unit из ledger, а эта запись — аудит ручной
  // операции и источник для per_modem (UPDATE clients.price покрыт и
  // db_audit-триггером — миграция 056).
  const oldPrice = old.price || 0;
  if (price !== undefined && parseFloat(price) !== oldPrice) {
    auditLog(req.user.login, 'price_change', { clientId: old.id, clientName: old.name, oldPrice, newPrice: parseFloat(price), ip: getClientIp(req) });
    logActivity('billing', 'info', 'price_change', old.name, `Цена изменена: ${oldPrice} → ${parseFloat(price)} ₽`, { client_id: old.id, old_price: oldPrice, new_price: parseFloat(price) });
  }
  
  const { password: _p, passwordHash: _ph, ...safeClient } = updated;
  res.json({ ok: true, client: safeClient });
});

r.delete('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const idx = clients.indexOf(client);
  if (idx === -1) return res.status(404).json({ error: 'Client not found' });

  try {
    const results = await fetchAllServersDataCached();
    let hasActivePorts = false;
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName === client.portName) { hasActivePorts = true; break; }
        }
      }
      if (hasActivePorts) break;
    }

    if (hasActivePorts) {
      return res.status(400).json({
        error: `Нельзя удалить: у клиента есть активные порты (portName: ${client.portName}). Сначала закройте все порты.`
      });
    }
  } catch (e) {
    logger.warn('[DeleteClient] Could not verify ports, proceeding with deletion:', e.message);
  }

  const removed = clients.splice(idx, 1)[0];
  saveClients(clients);
  rebuildClientMaps();
  delete users[removed.login];
  deleteSessionsByLogin(removed.login);
  _emitFinanceWrite();
  auditLog(req.user.login, 'delete_client', { clientId: removed.id, clientName: removed.name, ip: getClientIp(req) });
  res.json({ ok: true });
});

r.post('/api/admin/clients/:id/payment', authMiddleware, adminMiddleware, validate(PaymentSchema), (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return res.status(400).json({ error: 'Invalid amount: must be positive and reasonable' });
  }

  // Stage 13.1: referral commission is computed up-front and applied INSIDE
  // the same atomicCredit transaction. Before this fix a crash between the
  // balance update and the referral .run() left the two out of sync (the
  // payment was credited, the commission wasn't).
  let referralOpts = null;
  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) {
      referralOpts = {
        referrerId: referrer.id,
        delta: referralCommission(parsedAmount),
      };
    }
  }

  const { balanceBefore, balanceAfter, referral } = atomicCredit(client.id, parsedAmount, {
    type: 'payment',
    date: date,
    timestamp: new Date().toISOString(),
    amount: parsedAmount,
    currency: client.currency || 'RUB',
    note: note || 'Пополнение баланса'
  }, referralOpts ? { referral: referralOpts } : undefined);

  if (referral) {
    const referrer = clientById.get(referral.referrerId);
    if (referrer) logger.info(`[Referral] Credited ${referralOpts.delta.toFixed(2)} to ${referrer.name} (10% of ${parsedAmount}) — atomic with payment`);
  }

  saveClients(clients);
  auditLog(req.user.login, 'add_payment', { clientId: client.id, clientName: client.name, amount: parsedAmount, note: note || '', ip: getClientIp(req) });
  // B2C Э3 (WP5): уведомление клиенту — best-effort, основной поток не роняет.
  if (notifyClient) {
    Promise.resolve(notifyClient(client,
      `Зачислено ${Math.round(parsedAmount * 100) / 100} ₽. Баланс: ${Math.round(balanceAfter * 100) / 100} ₽.`,
      { action: 'balance_credited', details: { client_id: client.id, amount: parsedAmount, balance: balanceAfter } }
    )).catch(e => logger.warn(`[Clients] notify ${client.login}: ${e.message}`));
  }
  // C5: payment list is derived from billing_ledger (the in-memory
  // client.payments[] array is gone).
  res.json({ ok: true, payments: _listLedgerPayments(client.id), balance: client.balance });
});

// WP6 (Этап 7, Р28): ручная выплата рефкомиссии ДЕНЬГАМИ (на карту — оператор
// переводит сам, здесь только фиксация). referral_balance −= amount с гардом
// (>= amount) + строка ledger type='payout' — одной транзакцией. Баланс
// клиента не трогаем: деньги ушли мимо системы. Выводом на баланс клиент
// управляет сам (POST /api/client/referral/withdraw_to_balance).
r.post('/api/admin/clients/:id/referral_payout', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const amount = Math.round(parseFloat(req.body && req.body.amount) * 100) / 100;
  if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'Invalid amount' });

  const now = new Date();
  const entry = {
    type: 'payout', date: now.toISOString().slice(0, 10), timestamp: now.toISOString(),
    amount, currency: client.currency || 'RUB',
    note: req.body.note || 'Выплата партнёрской комиссии (вручную)',
    source: 'referral',
    balance_before: client.balance || 0, balance_after: client.balance || 0,
  };
  let newRefBalance;
  try {
    db.transaction(() => {
      const upd = db.prepare(
        'UPDATE clients SET referral_balance = ROUND(referral_balance - ?, 2) WHERE id = ? AND referral_balance >= ?'
      ).run(amount, client.id, amount);
      if (upd.changes === 0) {
        const err = new Error('insufficient_referral_balance');
        err.code = 'INSUFFICIENT_REFERRAL';
        throw err;
      }
      _ledgerInsert.run(..._ledgerEntryParams(client.id, entry));
      newRefBalance = db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(client.id).referral_balance;
    })();
  } catch (e) {
    if (e.code === 'INSUFFICIENT_REFERRAL') {
      return res.status(409).json({ error: `Недостаточно комиссии: доступно ${client.referral_balance || 0} ₽`, code: 'INSUFFICIENT_REFERRAL' });
    }
    logger.error(`[Referral] payout ${client.login}: ${e.message}`);
    return res.status(500).json({ error: 'Payout failed', details: e.message });
  }
  client.referral_balance = newRefBalance;
  saveClients(clients);
  auditLog(req.user.login, 'referral_payout', { clientId: client.id, login: client.login, amount, ip: getClientIp(req) });
  logActivity('client', 'info', 'referral_payout', client.login,
    `Выплата партнёрской комиссии деньгами: ${amount} ₽ (оператор ${req.user.login})`, { amount });
  res.json({ ok: true, amount, referral_balance: newRefBalance });
});

r.post('/api/admin/clients/:id/charge', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return res.status(400).json({ error: 'Invalid amount: must be positive and reasonable' });
  }

  const { balanceBefore, balanceAfter } = atomicDebit(client.id, parsedAmount, {
    type: 'correction',
    date: date,
    timestamp: new Date().toISOString(),
    amount: parsedAmount,
    currency: client.currency || 'RUB',
    note: note || 'Корректировка: ручное списание'
  });

  saveClients(clients);
  auditLog(req.user.login, 'manual_charge', { clientId: client.id, clientName: client.name, amount: parsedAmount, note: note || '', ip: getClientIp(req) });
  res.json({ ok: true, balance: client.balance, balanceBefore, balanceAfter });
});

// Stage 13.3: source of truth for payment history is billing_ledger
// (it's atomic, idempotent, and survives stale-memory bugs). Map the
// ledger row shape to the historical payment shape so the UI response
// stays identical.
function _mapLedgerToPayment(entry) {
  return {
    amount: entry.amount,
    date: entry.date,
    note: entry.note || '',
    source: entry.source || 'manual',
    paymentId: entry.paymentId || undefined,
    // ledger entries store the ISO timestamp; payments table called it
    // createdAt. Preserve the old field name in the response.
    createdAt: entry.timestamp || '',
    // P0-2: stable ledger row id the UI deletes by (no fragile array index).
    ledgerDbId: entry.db_id,
  };
}
function _listLedgerPayments(clientId) {
  const all = ledgerDb.listByClient(clientId);
  // P0-2: deleting a payment records a payment_reversal pointing back at it
  // (reversedLedgerId). Hide the reversed original from the list so it
  // disappears, while the reversal stays in the full ledger as an audit fact.
  const reversed = new Set(
    all.filter(e => e.type === 'payment_reversal' && e.reversedLedgerId != null)
       .map(e => e.reversedLedgerId)
  );
  return all
    .filter(e => (e.type === 'payment' || e.type === 'bank_payment') && !reversed.has(e.db_id))
    .map(_mapLedgerToPayment)
    .reverse(); // listByClient is ORDER BY id ASC; UI expects newest-first
}
r.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(_listLedgerPayments(client.id));
});

// C5: DELETE /api/admin/clients/:id/payment/:index removed — it indexed the
// legacy in-memory client.payments[] array (a boot-time snapshot that never
// saw fresh payments, so the route was non-functional). Reversal goes through
// the by-ledger route below.

// P0-2 (Path A): delete a payment by its stable ledger db_id (not array index,
// which was a different source AND order than the GET list — the old route was
// dead code that always 409'd). Records a referral-aware payment_reversal in the
// SAME transaction as the balance reversal (atomicDebit), so balance and
// referral_balance stay in sync. Idempotent: re-deleting an already-reversed
// payment is a no-op (no double reversal).
r.delete('/api/admin/clients/:id/payment/by-ledger/:ledgerDbId', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const ledgerDbId = parseInt(req.params.ledgerDbId, 10);
  if (!Number.isInteger(ledgerDbId)) return res.status(400).json({ error: 'Invalid ledger id' });

  const entries = ledgerDb.listByClient(client.id);
  const target = entries.find(e => e.db_id === ledgerDbId && (e.type === 'payment' || e.type === 'bank_payment'));
  if (!target) return res.status(404).json({ error: 'Payment not found' });

  // Idempotency: a reversal already pointing at this payment → no-op.
  const already = entries.some(e => e.type === 'payment_reversal' && e.reversedLedgerId === ledgerDbId);
  if (already) return res.json({ ok: true, already: true, balance: client.balance });

  const paidAmount = parseFloat(target.amount) || 0;

  // Referral claw-back in the same atomicDebit txn, mirroring the credit path.
  let referralOpts = null;
  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) referralOpts = { referrerId: referrer.id, delta: -referralCommission(paidAmount) };
  }

  let result;
  try {
    result = atomicDebit(client.id, paidAmount, {
      type: 'payment_reversal',
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      amount: paidAmount,
      currency: client.currency || 'RUB',
      note: 'Удаление оплаты администратором',
      reversedLedgerId: ledgerDbId,
    }, referralOpts ? { referral: referralOpts } : undefined);
  } catch (e) {
    logger.error('[Payment] delete-by-ledger failed: ' + e.message);
    return res.status(500).json({ error: 'Reversal failed', details: e.message });
  }

  if (result && result.referral) {
    const referrer = clientById.get(result.referral.referrerId);
    if (referrer) logger.info(`[Referral] Reversed ${Math.abs(referralOpts.delta).toFixed(2)} from ${referrer.name} (payment ${ledgerDbId} deleted) — atomic with reversal`);
  }

  saveClients(clients);
  auditLog(req.user.login, 'delete_payment', { clientId: client.id, clientName: client.name, amount: paidAmount, ledgerDbId, ip: getClientIp(req) });
  res.json({ ok: true, balance: client.balance });
});

r.get('/api/admin/clients/:id/ledger', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const allEntries = ledgerDb.listByClient(client.id);   // id ASC (oldest-first)
  // BUG-11: Pagination support.
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  // NEWEST-first: the default page must show RECENT activity. Previously this
  // returned the OLDEST `limit` entries (slice(0,100) of an id-ASC list), so a
  // client with >100 entries (e.g. one charged daily for months) had its recent
  // charges fall onto an unloaded page 2 — the history view then showed a stale
  // "last charge" (looked like billing had stopped). Each row also carries its
  // stable ledgerDbId — the UI reverses payments by it (A4: правки только
  // через сторнирование, индексное удаление запрещено).
  const newestFirst = allEntries.map((e, i) => ({ ...e, _idx: i })).reverse();
  const entries = newestFirst.slice(offset, offset + limit);
  // Per-month segmentation (computed over the FULL ledger so totals are complete
  // regardless of the 100-row page). spent = debits (charges/manual/correction),
  // topup = credits (payments/bank/positive adjustments). Keyed by 'YYYY-MM'.
  const monthly = {};
  for (const e of allEntries) {
    const ds = e.date || e.timestamp || '';
    const mk = /^\d{4}-\d{2}/.test(ds) ? ds.slice(0, 7) : '';
    if (!mk) continue;
    if (!monthly[mk]) monthly[mk] = { spent: 0, topup: 0, count: 0 };
    let s = 0;
    if (e.type === 'charge') s = -(e.cost || 0);
    else if (e.type === 'manual_charge' || e.type === 'correction') s = -(e.amount || 0);
    else if (e.type === 'payment' || e.type === 'bank_payment') s = (e.amount || 0);
    else if (e.type === 'adjustment' || e.type === 'payment_reversal') s = (e.amount || 0);
    if (s >= 0) monthly[mk].topup += s; else monthly[mk].spent += -s;
    monthly[mk].count++;
  }
  for (const k of Object.keys(monthly)) {
    monthly[k].spent = Math.round(monthly[k].spent * 100) / 100;
    monthly[k].topup = Math.round(monthly[k].topup * 100) / 100;
  }
  res.json({
    balance: client.balance,
    last_snapshot: client.last_traffic_snapshot,
    entries: entries.map(({ db_id, ...e }) => ({ ...e, ledgerDbId: db_id })),   // ledgerDbId — стабильный id строки для сторно-роута
    monthly,
    total: allEntries.length,
    limit,
    offset
  });
});

// A4: физическое удаление ledger-записей запрещено. Старый роут удалял строку
// и сдвигал снапшоты balance_before/after последующих записей, но НЕ сторнировал
// реферальную комиссию — баланс реферера расходился с ledger. Правки только
// через сторнирование: DELETE /api/admin/clients/:id/payment/by-ledger/:ledgerDbId
// (payment_reversal в одной транзакции с откатом баланса и комиссии).
r.delete('/api/admin/clients/:id/ledger/:entryIndex', authMiddleware, adminMiddleware, (req, res) => {
  return res.status(405).json({ error: 'Удаление операций из ledger запрещено: правки только через сторнирование (DELETE /payment/by-ledger/:ledgerDbId)' });
});

r.post('/api/admin/clients/:id/balance_adjust', authMiddleware, adminMiddleware, validate(BalanceAdjustSchema), (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, note } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'amount required' });

  
  
  
  const adjustment = parseFloat(amount);
  const ledgerEntry = {
    type: 'correction',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: Math.abs(adjustment),
    currency: client.currency || 'RUB',
    note: note || 'Корректировка баланса'
  };
  let balanceBefore, balanceAfter;
  if (adjustment >= 0) {
    ({ balanceBefore, balanceAfter } = atomicCredit(client.id, adjustment, ledgerEntry));
  } else {
    ({ balanceBefore, balanceAfter } = atomicDebit(client.id, -adjustment, ledgerEntry));
  }

  auditLog(req.user.login, 'balance_adjust', { clientId: client.id, clientName: client.name, amount: adjustment, note: note || '', ip: getClientIp(req) });
  res.json({ ok: true, balance: client.balance });
});

r.post('/api/admin/clients/:id/document', authMiddleware, adminMiddleware, async (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { name, fileBase64, mimeType } = req.body;
  if (!name || !fileBase64) return res.status(400).json({ error: 'name and fileBase64 required' });

  
  const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'png', 'jpg', 'jpeg']);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({ error: `File type .${ext} not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` });
  }

  // Validate file size (base64 → ~75% of original, max 10MB decoded)
  if (fileBase64.length > 14 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large (max 10MB)' });
  }

  const docId = generateId();
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '');
  const fileName = `${docId}.${safeExt}`;
  const filePath = path.resolve(DOCUMENTS_DIR, fileName);
  // Prevent path traversal
  if (!filePath.startsWith(path.resolve(DOCUMENTS_DIR) + path.sep)) return res.status(400).json({ error: 'Invalid file path' });

  try {
    await fsPromises.writeFile(filePath, Buffer.from(fileBase64, 'base64'));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save file', details: err.message });
  }

  if (!client.documents) client.documents = [];
  client.documents.push({
    id: docId,
    name,
    fileName,
    mimeType: mimeType || 'application/pdf',
    date: new Date().toISOString()
  });
  saveClients(clients);
  res.json({ ok: true });
});

r.delete('/api/admin/clients/:id/document/:docId', authMiddleware, adminMiddleware, (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.documents) return res.status(404).json({ error: 'No documents' });
  const docIdx = client.documents.findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });
  const doc = client.documents[docIdx];
  // Delete file (with path traversal protection)
  const delPath = path.join(DOCUMENTS_DIR, path.basename(doc.fileName));
  if (delPath.startsWith(DOCUMENTS_DIR)) { try { fs.unlinkSync(delPath); } catch (_) { /* best-effort: error intentionally swallowed */ } }
  client.documents.splice(docIdx, 1);
  // Stage 13.2: explicit delete — saveClients no longer wipes the table.
  documentsDb.deleteDoc(doc.id);
  saveClients(clients);
  res.json({ ok: true });
});

r.post('/api/admin/clients/:id/regenerate_key', authMiddleware, adminMiddleware, (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  // Hash-only at rest; the new plaintext is returned once, then unrecoverable.
  const plainApiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  client.apiKey = sha256hex(plainApiKey);
  client.apiKeyPrefix = plainApiKey.slice(0, 8);
  saveClients(clients);
  res.json({ ok: true, apiKey: plainApiKey });
});

// Ручная блокировка клиента админом: blocked=1, сброс всех сессий, гашение
// всех портов (B2B — «дата до» = сегодня, как debt-block; розница — пул →
// blocked с ∞ hold, как domain-guard). Идемпотентно: повторный вызов по уже
// заблокированному клиенту только дожимает порты.
r.post('/api/admin/clients/:id/block', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const wasBlocked = !!client.blocked;
  client.blocked = true;
  saveClients(clients);
  try { deleteSessionsByLogin(client.login); } catch (_) { /* best-effort */ }

  const today = getMoscowNow().toLocaleDateString('en-CA');   // YYYY-MM-DD
  const result = { b2b: 0, retail: 0, errors: [] };
  try {
    const portValidity = require('../services/port-validity').create({
      proxyConf, fetchApi, parseHtmlInputFields, findServer, proxySmart, ledgerDb, getMoscowNow,
    });
    const serverResults = await fetchAllServersDataCached();
    for (const pt of portValidity.clientPorts(client, serverResults)) {
      try {
        await portValidity.setPortValidBefore(pt.server, pt.portId, today);
        result.b2b++;
      } catch (e) {
        result.errors.push(`${pt.server && pt.server.name || '?'}/${pt.portId}: ${e.message}`);
      }
    }
  } catch (e) {
    result.errors.push('b2b: ' + e.message);
  }
  try {
    if (retailPoolDb) {
      for (const pr of retailPoolDb.byClient(client.id)) {
        if (pr.status === 'leased' || pr.status === 'reserved') { retailPoolDb.block(pr.id, null); result.retail++; }
      }
    }
  } catch (e) {
    result.errors.push('retail: ' + e.message);
  }

  logger.warn(`[Clients] ${client.login}: ручная блокировка админом ${req.user.login} — погашено B2B ${result.b2b}, розница ${result.retail}${result.errors.length ? ', ошибки: ' + result.errors.join('; ') : ''}`);
  auditLog(req.user.login, 'client_block_admin', {
    clientId: client.id, login: client.login, wasBlocked,
    b2b: result.b2b, retail: result.retail, errors: result.errors,
    ip: getClientIp(req),
  });
  logActivity('client', 'warning', 'client_block_admin', client.login,
    `Клиент заблокирован админом: погашено портов B2B ${result.b2b}, розница ${result.retail}`,
    { client_id: client.id, b2b: result.b2b, retail: result.retail });
  try {
    alerts.trigger('client_blocked_admin', {
      client_id: client.id, client: client.name || client.login,
      b2b: result.b2b, retail: result.retail,
      errors: result.errors.length ? result.errors.join('; ') : '',
    });
  } catch (_) { /* alert best-effort */ }
  try {
    await notifyClient(client,
      'Аккаунт заблокирован администратором. Доступ к прокси приостановлен — свяжитесь с поддержкой.',
      { action: 'client_block_admin', details: { client_id: client.id } });
  } catch (e) { logger.warn(`[Clients] notify ${client.login}: ${e.message}`); }
  res.json({ ok: true, blocked: true, ...result });
});

// B2C Э5 (WP7): разблокировка аккаунта — ТОЛЬКО админом (§8 ТЗ). blocked=0;
// опционально reset_strikes обнуляет abuse_strikes (иначе следующее
// нарушение снова дойдёт до порога abuse_strikes_block и переблокирует).
// Замороженные антифродом порты здесь НЕ воскрешаются — для этого
// POST /api/admin/retail/client/rehabilitate (routes/retail.js).
r.post('/api/admin/clients/:id/unblock', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const wasBlocked = !!client.blocked;
  client.blocked = false;
  const resetStrikes = !!(req.body && req.body.reset_strikes);
  if (resetStrikes) client.abuseStrikes = 0;
  saveClients(clients);
  auditLog(req.user.login, 'retail_unblock', {
    clientId: client.id, login: client.login,
    wasBlocked, resetStrikes, abuseStrikes: client.abuseStrikes || 0,
    ip: getClientIp(req),
  });
  logActivity('client', 'warning', 'retail_unblock', client.login,
    `Аккаунт разблокирован админом${resetStrikes ? ' (strikes обнулены)' : ''}`,
    { client_id: client.id, abuse_strikes: client.abuseStrikes || 0 });
  res.json({ ok: true, blocked: false, abuseStrikes: client.abuseStrikes || 0 });
});

  return r;
};
