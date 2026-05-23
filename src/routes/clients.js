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
  const safe = page.map(c => { const { password, passwordHash, ...rest } = c; return rest; });
  res.json({ clients: safe, total, limit, offset });
});

r.post('/api/admin/clients', authMiddleware, adminMiddleware, validate(ClientCreateSchema), async (req, res) => {
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by, inn, kpp, legalName, contractInfo, address, clientType, allowDebt, maxDebt, slaUptimePct, slaMaxLatencyMs, slaMaxErrorPct, slaAutoCredit } = req.body;
  if (!name || !portName || !login || !password) {
    return res.status(400).json({ error: 'name, portName, login, password required' });
  }
  // Validation handled by zod middleware (validate(ClientCreateSchema))
  if (users[login]) {
    return res.status(400).json({ error: 'Login already exists: ' + login });
  }
  const passwordHash = await bcrypt.hash(password, 10);
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
    apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
    referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    referred_by: null,
    referral_balance: 0,
    resetToken: crypto.randomBytes(16).toString('hex'),
    documents: [],
    balance: 0,
    last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
    inn: inn || '',
    kpp: kpp || '',
    legalName: legalName || '',
    contractInfo: contractInfo || '',
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

  const { password: _p, passwordHash: _ph, ...safeClient } = client;
  res.json({ ok: true, client: safeClient });
});

r.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  
  const old = clientById.get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Client not found' });
  const idx = clients.indexOf(old);
  // BUG-12: Validate input
  const valErr = validateClientInput(req.body, false);
  if (valErr) return res.status(400).json({ error: valErr });
  const { name, portName, login, password, contact, notes, billingType, price, currency, inn, kpp, legalName, contractInfo, address, autoActs, autoBills, billingPaused, clientType, allowDebt, maxDebt, slaUptimePct, slaMaxLatencyMs, slaMaxErrorPct, slaAutoCredit } = req.body;
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

r.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.payments || []);
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
  const deletedDbId = deletedPayment.db_id;
  client.payments.splice(payIdx, 1);
  if (deletedDbId) paymentsDb.deleteById(deletedDbId);

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

r.get('/api/admin/clients/:id/ledger', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const allEntries = ledgerDb.listByClient(client.id);
  // BUG-11: Pagination support
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const entries = allEntries.slice(offset, offset + limit);
  res.json({
    balance: client.balance,
    last_snapshot: client.last_traffic_snapshot,
    
    entries: entries.map(({ db_id, ...e }) => e),
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

  // Reverse the deleted entry's effect on balance using stored snapshot.
  const entryImpact = (entry.balance_after != null && entry.balance_before != null)
    ? entry.balance_after - entry.balance_before
    : ((['payment', 'bank_payment', 'credit'].includes(entry.type)) ? (entry.amount || 0) : -(entry.amount || entry.cost || 0));
  const newBalance = Math.round((client.balance - entryImpact) * 100) / 100;

  // SQLite transaction — DELETE and UPDATE happen as one unit. Previously
  // these were two separate statements and a crash between them left
  // balance and ledger out of sync.
  try {
    db.transaction(() => {
      if (entry.db_id) ledgerDb.deleteById(entry.db_id);
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
  client.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  saveClients(clients);
  res.json({ ok: true, apiKey: client.apiKey });
});

  return r;
};
