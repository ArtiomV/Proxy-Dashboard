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
    _ledgerInsert, _ledgerEntryParams, ledgerDb, clientsDb, paymentsDb, documentsDb,
    DOCUMENTS_DIR,
    validateClientInput,
    appSettings,
  } = deps;
  const r = express.Router();
  // Prepared statement pulled from clientsDb. Stage 13.1: the
  // referral_balance update used to live here too, but it's now owned
  // by atomic.js so referral commission lands in the same txn as the
  // payment that triggered it.
  const _clientUpdateBalance = clientsDb.updateBalanceStmt();

  // Full-ledger balance recompute (Stage 18.8) — moved to src/billing/recalc.js
  // (WP5) so the reconcile job and these routes share ONE formula.
  const { recalcFromLedger: _recalcFromLedger } = require('../billing/recalc');
  const recalcFromLedger = (clientId) => _recalcFromLedger(db, clientId);

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
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by, inn, kpp, legalName, contractInfo, contractDate, address, clientType, allowDebt, maxDebt, slaUptimePct, slaMaxLatencyMs, slaMaxErrorPct, slaAutoCredit } = req.body;
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
    billingType: billingType || 'per_gb',
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
    slaUptimePct:    typeof slaUptimePct    === 'number' ? slaUptimePct    : 99,
    slaMaxLatencyMs: typeof slaMaxLatencyMs === 'number' ? slaMaxLatencyMs : 1000,
    slaMaxErrorPct:  typeof slaMaxErrorPct  === 'number' ? slaMaxErrorPct  : 5,
    slaAutoCredit:   !!slaAutoCredit,
    clientType: clientType || 'legal',
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
  const { name, portName, login, password, contact, notes, billingType, price, currency, inn, kpp, legalName, contractInfo, contractDate, address, autoActs, autoBills, billingPaused, clientType, allowDebt, maxDebt, slaUptimePct, slaMaxLatencyMs, slaMaxErrorPct, slaAutoCredit } = req.body;
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
    billingType: billingType !== undefined ? billingType : (old.billingType || 'per_gb'),
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
    slaUptimePct:    slaUptimePct    !== undefined ? Number(slaUptimePct)    : (typeof old.slaUptimePct    === 'number' ? old.slaUptimePct    : 99),
    slaMaxLatencyMs: slaMaxLatencyMs !== undefined ? Number(slaMaxLatencyMs) : (typeof old.slaMaxLatencyMs === 'number' ? old.slaMaxLatencyMs : 1000),
    slaMaxErrorPct:  slaMaxErrorPct  !== undefined ? Number(slaMaxErrorPct)  : (typeof old.slaMaxErrorPct  === 'number' ? old.slaMaxErrorPct  : 5),
    slaAutoCredit:   slaAutoCredit   !== undefined ? !!slaAutoCredit         : !!old.slaAutoCredit,
    clientType: clientType !== undefined ? clientType : (old.clientType || 'legal')
  };
  clients[idx] = updated;
  saveClients(clients);
  rebuildClientMaps();
  users[updated.login] = { passwordHash: updated.passwordHash, portNameFilter: updated.portName, source: 'client', clientId: updated.id };
  _emitFinanceWrite();
  
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
  if (!client.payments) client.payments = [];

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
        delta: Math.round(parsedAmount * 0.15 * 100) / 100,
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

  // Push payment AFTER atomicCredit succeeds (МЕД-3)
  client.payments.push({ amount: parsedAmount, date, note: note || '', createdAt: new Date().toISOString() });

  if (referral) {
    const referrer = clientById.get(referral.referrerId);
    if (referrer) logger.info(`[Referral] Credited ${referralOpts.delta.toFixed(2)} to ${referrer.name} (15% of ${parsedAmount}) — atomic with payment`);
  }

  saveClients(clients);
  auditLog(req.user.login, 'add_payment', { clientId: client.id, clientName: client.name, amount: parsedAmount, note: note || '', ip: getClientIp(req) });
  res.json({ ok: true, payments: client.payments, balance: client.balance });
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
r.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const all = ledgerDb.listByClient(client.id);
  // P0-2: deleting a payment records a payment_reversal pointing back at it
  // (reversedLedgerId). Hide the reversed original from the list so it
  // disappears, while the reversal stays in the full ledger as an audit fact.
  const reversed = new Set(
    all.filter(e => e.type === 'payment_reversal' && e.reversedLedgerId != null)
       .map(e => e.reversedLedgerId)
  );
  const payments = all
    .filter(e => (e.type === 'payment' || e.type === 'bank_payment') && !reversed.has(e.db_id))
    .map(_mapLedgerToPayment)
    .reverse(); // listByClient is ORDER BY id ASC; UI expects newest-first
  res.json(payments);
});

r.delete('/api/admin/clients/:id/payment/:index', authMiddleware, adminMiddleware, (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const payIdx = parseInt(req.params.index);
  if (!client.payments || payIdx < 0 || payIdx >= client.payments.length) {
    return res.status(400).json({ error: 'Invalid payment index' });
  }
  const deletedPayment = client.payments[payIdx];
  const deletedAmount = parseFloat(deletedPayment.amount) || 0;

  // Require amount confirmation to prevent race condition with index shifts
  const expectedAmount = parseFloat(req.query.amount || req.body?.amount);
  if (isNaN(expectedAmount) || Math.abs(Math.round(expectedAmount * 100) - Math.round(deletedAmount * 100)) > 0) {
    return res.status(409).json({ error: 'Payment amount mismatch — list may have changed, please refresh' });
  }
  // Stage 13.2: explicit single-row delete so the additive saveClients
  // sync doesn't have to delete-by-client anymore. If the in-memory entry
  // has a db_id (loaded from DB or stamped by an earlier saveClients), use
  // it. Older entries that pre-date 13.2 won't have one — fall through and
  // saveClients won't re-insert because we splice from the array.
  client.payments.splice(payIdx, 1);
  // Stage 13.3: ledger reversal (the `payment_reversal` entry added
  // below by atomicDebit) is the recorded fact. The legacy `payments`
  // table isn't written from saveClients anymore, so no per-row cleanup
  // here — historic rows that pre-date Stage 13.3 just stay (read-only,
  // ignored by the new GET /:id/payments path which reads from ledger).

  // Stage 13.1: referral reversal lives in the same atomicDebit txn as
  // the balance reversal — same atomicity guarantee as the credit path.
  let referralOpts = null;
  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) {
      referralOpts = {
        referrerId: referrer.id,
        delta: -Math.round(deletedAmount * 0.15 * 100) / 100,
      };
    }
  }

  const { balanceBefore, balanceAfter, referral } = atomicDebit(client.id, deletedAmount, {
    type: 'payment_reversal',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: deletedAmount,
    currency: client.currency || 'RUB',
    note: 'Отмена оплаты администратором'
  }, referralOpts ? { referral: referralOpts } : undefined);

  if (referral) {
    const referrer = clientById.get(referral.referrerId);
    if (referrer) logger.info(`[Referral] Reversed ${Math.abs(referralOpts.delta).toFixed(2)} from ${referrer.name} (payment deletion) — atomic with reversal`);
  }

  saveClients(clients);
  res.json({ ok: true, payments: client.payments, balance: client.balance });
});

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
    if (referrer) referralOpts = { referrerId: referrer.id, delta: -(Math.round(paidAmount * 0.15 * 100) / 100) };
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

  // Best-effort: keep the legacy in-memory client.payments array consistent.
  // The ledger is authoritative; this just avoids a stale count if anything
  // still reads the array.
  if (Array.isArray(client.payments)) {
    const i = client.payments.findIndex(p => Math.round((parseFloat(p.amount) || 0) * 100) === Math.round(paidAmount * 100));
    if (i >= 0) client.payments.splice(i, 1);
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
  // "last charge" (looked like billing had stopped). Tag each row with its
  // absolute index in the ASC list BEFORE reversing, so the index-based delete
  // route (/ledger/:entryIndex) still targets the right row.
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
    entries: entries.map(({ db_id, ...e }) => e),   // keep _idx, drop internal db_id
    monthly,
    total: allEntries.length,
    limit,
    offset
  });
});

r.delete('/api/admin/clients/:id/ledger/:entryIndex', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = ledgerDb.listByClient(client.id);
  const idx = parseInt(req.params.entryIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= entries.length) return res.status(400).json({ error: 'Invalid entry index' });

  const entry = entries[idx];

  // Stage 18.8: FULL RECALCULATION after delete (shared recalcFromLedger,
  // hoisted to factory scope; P1-1 anchors on the first balance_before so a
  // pre-ledger opening remainder isn't wiped). Subtracting just this entry's
  // delta would perpetuate any pre-existing drift.
  let newBalance;
  try {
    db.transaction(() => {
      if (entry.db_id) ledgerDb.deleteById(entry.db_id);
      newBalance = recalcFromLedger(client.id);
      _clientUpdateBalance.run(newBalance, client.id);
    })();
  } catch (e) {
    logger.error('[Ledger] Delete transaction failed: ' + e.message);
    return res.status(500).json({ error: 'Delete failed', details: e.message });
  }
  client.balance = newBalance;

  // Stage 4: billingLedger in-memory mirror removed. listByClient() always
  // reads fresh from billing_ledger so no client-side cache update needed
  // after ledgerDb.deleteById() already mutated the DB inside the txn above.
  logger.info(`[Ledger] Deleted entry #${idx} (${entry.type}) for client ${client.name}, recalculated balance: ${client.balance}`);
  auditLog(req.user.login, 'delete_ledger_entry', { clientId: client.id, clientName: client.name, entryType: entry.type, amount: entry.amount || entry.cost, ip: getClientIp(req) });
  res.json({ ok: true, newBalance: client.balance });
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

  return r;
};
