const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const fsPromises = fs.promises;

// ==================== SQLite DATABASE (TASK-M) ====================
const DB_PATH = path.join(__dirname, 'dashboard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema on startup (CREATE IF NOT EXISTS is safe to re-run)
if (fs.existsSync(SCHEMA_PATH)) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // Clean old traffic_hourly rows without server prefix (SRV: format)
  try {
    const cleaned = db.prepare("DELETE FROM traffic_hourly WHERE port_name NOT LIKE '%:%'").run();
    if (cleaned.changes > 0) console.log(`[SQLite] Cleaned ${cleaned.changes} old traffic_hourly rows without server prefix`);
  } catch(e) {}
  console.log('[SQLite] Schema applied, database ready');
}

// BUG-01 fix: Synchronous migration via spawnSync — blocks until complete,
// preventing race condition where loadClients() runs before DB is populated.
// WAL mode allows concurrent access; spawnSync is safe (fixed command, no shell).
function autoMigrateIfNeeded() {
  const clientCount = db.prepare('SELECT COUNT(*) as cnt FROM clients').get().cnt;
  if (clientCount > 0) return;
  const jsonPath = path.join(__dirname, 'clients.json');
  if (!fs.existsSync(jsonPath)) return;
  console.log('[SQLite] Empty database with existing JSON files. Running sync migration...');
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, ['migrate.js'], {
      cwd: __dirname, stdio: 'inherit', timeout: 30000
    });
    if (result.status !== 0) {
      console.error('[SQLite] Migration exited with code', result.status);
    } else {
      console.log('[SQLite] Migration complete');
    }
  } catch (e) {
    console.error('[SQLite] Migration failed:', e.message, '— run "node migrate.js" manually');
  }
}
autoMigrateIfNeeded();

// Safe ALTER TABLE — add columns if they don't exist (for existing DBs)
function safeAddColumn(table, column, type) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); } catch (e) { /* already exists */ }
}
safeAddColumn('bank_payments', 'dismissed', 'INTEGER DEFAULT 0');
safeAddColumn('bank_payments', 'source', "TEXT DEFAULT ''");
safeAddColumn('bank_payments', 'tochka_payment_id', 'TEXT');
try { db.exec('CREATE INDEX IF NOT EXISTS idx_bank_payments_tochka_id ON bank_payments(tochka_payment_id)'); } catch (e) {}
safeAddColumn('billing_ledger', 'details', "TEXT DEFAULT '{}'");
safeAddColumn('closing_documents', 'contract_info', "TEXT DEFAULT ''");
safeAddColumn('clients', 'client_type', "TEXT DEFAULT 'legal'");
safeAddColumn('closing_documents', 'signed_at', 'TEXT');

// External proxies table
db.exec(`CREATE TABLE IF NOT EXISTS external_proxies (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  label TEXT DEFAULT '',
  protocol TEXT DEFAULT 'HTTP',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  login TEXT DEFAULT '',
  password TEXT DEFAULT '',
  change_ip_url TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (client_id) REFERENCES clients(id)
)`);
safeAddColumn('external_proxies', 'change_ip_url', "TEXT DEFAULT ''");
safeAddColumn('external_proxies', 'valid_until', 'TEXT');
safeAddColumn('external_proxies', 'billing_type', "TEXT DEFAULT 'monthly'");
safeAddColumn('external_proxies', 'price', 'REAL DEFAULT 0');
safeAddColumn('external_proxies', 'traffic_used_gb', 'REAL DEFAULT 0');

// Hourly traffic aggregates table
db.exec(`CREATE TABLE IF NOT EXISTS traffic_hourly (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  port_name   TEXT NOT NULL,
  hour_start  TEXT NOT NULL,
  bytes_in    INTEGER DEFAULT 0,
  bytes_out   INTEGER DEFAULT 0,
  UNIQUE(port_name, hour_start)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_traffic_hourly_hour ON traffic_hourly(hour_start)');
db.exec('CREATE INDEX IF NOT EXISTS idx_traffic_hourly_port ON traffic_hourly(port_name, hour_start)');

// Prepared statements for common operations
const dbStmts = {
  // Sessions — fully SQLite-backed
  getSession: db.prepare('SELECT token, login, port_name_filter AS portNameFilter, is_admin AS isAdmin, expires_at AS expiresAt FROM sessions WHERE token = ? AND expires_at > ?'),
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, login, port_name_filter, is_admin, expires_at) VALUES (?, ?, ?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteSessionsByLogin: db.prepare('DELETE FROM sessions WHERE login = ?'),
  cleanExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  countSessions: db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > ?'),

  // Bank payments — fully SQLite-backed
  getBankPayments: db.prepare('SELECT * FROM bank_payments ORDER BY received_at DESC'),
  insertBankPayment: db.prepare(`INSERT OR IGNORE INTO bank_payments
    (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date,
     customer_code, matched, matched_client_id, matched_client_name, auto_credit,
     dismissed, source, tochka_payment_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  findBankPaymentByPaymentId: db.prepare('SELECT * FROM bank_payments WHERE payment_id = ? AND auto_credit = 1 LIMIT 1'),
  findBankPaymentByTochkaId: db.prepare('SELECT id FROM bank_payments WHERE tochka_payment_id = ? LIMIT 1'),
  updateBankPaymentMatch: db.prepare('UPDATE bank_payments SET matched = ?, matched_client_id = ?, matched_client_name = ?, auto_credit = ? WHERE id = ?'),
  dismissBankPayment: db.prepare('UPDATE bank_payments SET dismissed = 1 WHERE id = ?'),
  dismissAllUnmatched: db.prepare("UPDATE bank_payments SET dismissed = 1 WHERE matched = 0 AND webhook_type = 'incomingPayment'"),
  countUnmatchedPayments: db.prepare("SELECT COUNT(*) as cnt FROM bank_payments WHERE matched = 0 AND dismissed = 0 AND webhook_type = 'incomingPayment'"),
  getBankPaymentById: db.prepare('SELECT * FROM bank_payments WHERE id = ?'),

  // Audit log — fully SQLite-backed
  insertAudit: db.prepare('INSERT INTO audit_log (timestamp, admin, action, details) VALUES (?, ?, ?, ?)'),
  getAuditLog: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?'),
  countAuditLog: db.prepare('SELECT COUNT(*) as cnt FROM audit_log'),
  cleanOldAudit: db.prepare("DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')"),
};

// DATA-01/02: Async file write with per-file mutex to prevent race conditions and event loop blocking
const _fileLocks = new Map();
function safeWriteFile(filePath, data) {
  const prev = _fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = filePath + '.tmp';
    try {
      await fsPromises.writeFile(tmp, data, 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (e) {
      // Cleanup tmp if rename failed
      try { await fsPromises.unlink(tmp); } catch (_) {}
      console.error(`[safeWriteFile] Error writing ${path.basename(filePath)}:`, e.message);
    }
  }).catch(() => {});
  _fileLocks.set(filePath, next);
  return next;
}

// Load .env manually
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const PORT = process.env.PORT || 3000;

// Multiple API servers: API_<name>_URL, API_<name>_USER, API_<name>_PASS
// Optional: API_<name>_PUBLIC_IP, API_<name>_COUNTRY, API_<name>_COUNTRY_NAME
const apiServers = [];
const serverKeys = new Set();
for (const key of Object.keys(process.env)) {
  const m = key.match(/^API_(.+)_URL$/);
  if (m) serverKeys.add(m[1]);
}
for (const name of serverKeys) {
  const urlObj = new URL(process.env[`API_${name}_URL`]);
  apiServers.push({
    name,
    url: process.env[`API_${name}_URL`],
    user: process.env[`API_${name}_USER`] || 'proxy',
    pass: process.env[`API_${name}_PASS`] || 'proxy',
    publicIp: process.env[`API_${name}_PUBLIC_IP`] || urlObj.hostname
  });
}

// TASK-K: Server country/IP mapping — built from env, no hardcoded IPs
// Fallback defaults for known servers (used if env vars not set)
const _defaultCountries = { S1: { country: 'MD', name: 'Moldova' }, S2: { country: 'RO', name: 'Romania' } };
const SERVER_COUNTRIES = {};
for (const s of apiServers) {
  const dc = _defaultCountries[s.name] || {};
  SERVER_COUNTRIES[s.name] = {
    serverIp: s.publicIp,
    country: process.env[`API_${s.name}_COUNTRY`] || dc.country || '',
    name: process.env[`API_${s.name}_COUNTRY_NAME`] || dc.name || s.name
  };
}
console.log(`Loaded ${apiServers.length} API server(s): ${apiServers.map(s => s.name + ' (' + s.url + ')').join(', ')}`);

// TASK-19: Startup validation — warn about missing critical configuration
{
  const warnings = [];
  if (apiServers.length === 0) warnings.push('No API servers configured (API_<name>_URL). Dashboard will have no modem data.');
  if (!fs.existsSync(DB_PATH) && !fs.existsSync(path.join(__dirname, 'clients.json'))) {
    warnings.push('No database or clients.json found — starting with empty data.');
  }
  if (!fs.existsSync(SCHEMA_PATH)) warnings.push('schema.sql not found — database tables may be missing.');
  for (const s of apiServers) {
    if (!s.url) warnings.push(`API server ${s.name} has no URL.`);
    if (s.user === 'proxy' && s.pass === 'proxy') warnings.push(`API server ${s.name} uses default credentials.`);
  }
  if (warnings.length > 0) {
    console.warn('[Startup] ⚠️  Warnings:');
    warnings.forEach(w => console.warn(`  - ${w}`));
  }
}

// Modem login mapping: MODEM_LOGIN_<nick>=<login>
const modemLogins = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('MODEM_LOGIN_')) {
    const nick = key.slice(12);
    modemLogins[nick] = val;
  }
}
console.log(`Loaded ${Object.keys(modemLogins).length} modem login mapping(s)`);

// Parse users from .env: USER_<login>=<password>|<portName>
const users = {};
for (const [key, val] of Object.entries(process.env)) {
  if (key.startsWith('USER_')) {
    const login = key.slice(5);
    const pipeIdx = val.indexOf('|');
    if (pipeIdx === -1) continue;
    const password = val.slice(0, pipeIdx);
    const filterPart = val.slice(pipeIdx + 1).trim();
    const portNameFilter = filterPart === '*' ? '*' : filterPart;
    users[login] = { passwordHash: bcrypt.hashSync(password, 10), portNameFilter, source: 'env' };
  }
}

// ==================== CLIENT MANAGEMENT (SQLite-backed, BUG-01/ARCH-01) ====================
const CLIENTS_FILE = path.join(__dirname, 'clients.json'); // JSON fallback for first-time migration

// Prepared statements for client & sub-table persistence
const _clientUpsert = db.prepare(`INSERT INTO clients (id, login, password, password_hash, port_name, name, contact, notes,
    billing_type, price, currency, balance, api_key, referral_code, referred_by, referral_balance,
    reset_token, inn, kpp, legal_name, contract_info, address, auto_acts, auto_bills,
    last_traffic_snapshot, created_at, client_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    login=excluded.login, password=excluded.password, password_hash=excluded.password_hash,
    port_name=excluded.port_name, name=excluded.name, contact=excluded.contact,
    notes=excluded.notes, billing_type=excluded.billing_type, price=excluded.price,
    currency=excluded.currency, balance=excluded.balance, api_key=excluded.api_key,
    referral_code=excluded.referral_code, referred_by=excluded.referred_by,
    referral_balance=excluded.referral_balance, reset_token=excluded.reset_token,
    inn=excluded.inn, kpp=excluded.kpp, legal_name=excluded.legal_name,
    contract_info=excluded.contract_info, address=excluded.address,
    auto_acts=excluded.auto_acts, auto_bills=excluded.auto_bills,
    last_traffic_snapshot=excluded.last_traffic_snapshot, client_type=excluded.client_type,
    updated_at=datetime('now')`);
const _clientDelete = db.prepare('DELETE FROM clients WHERE id = ?');
const _clientGetIds = db.prepare('SELECT id FROM clients');

// TASK-03+BUG-02+BUG-03: Atomic balance+ledger operations in ONE transaction
const _clientGetBalance = db.prepare('SELECT balance FROM clients WHERE id = ?');
const _clientUpdateBalance = db.prepare('UPDATE clients SET balance = ?, updated_at = datetime(\'now\') WHERE id = ?');
// BUG-09 fix: Persist referral_balance to DB immediately
const _clientUpdateReferralBalance = db.prepare('UPDATE clients SET referral_balance = ?, updated_at = datetime(\'now\') WHERE id = ?');

/**
 * atomicCredit — atomically add amount to client balance AND insert ledger entry
 * BUG-02 fix: balance + ledger in single transaction (no partial state)
 * BUG-03 fix: uses clientById.get() for O(1) in-memory sync
 * @param {string} clientId
 * @param {number} amount
 * @param {object} [ledgerEntry] — if provided, inserted in same transaction
 * Returns { balanceBefore, balanceAfter }
 */
function atomicCredit(clientId, amount, ledgerEntry) {
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount) || amount === 0) throw new Error('atomicCredit: invalid amount');
  let balanceBefore, balanceAfter, ledgerDbId;
  db.transaction(() => {
    const row = _clientGetBalance.get(clientId);
    if (!row) throw new Error(`atomicCredit: client ${clientId} not found`);
    balanceBefore = row.balance || 0;
    balanceAfter = Math.round((balanceBefore + amount) * 100) / 100;
    _clientUpdateBalance.run(balanceAfter, clientId);
    if (ledgerEntry) {
      const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
      const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
      entry.db_id = result.lastInsertRowid;
      ledgerDbId = entry.db_id; // OLD-02 fix: expose to caller
      if (!billingLedger[clientId]) billingLedger[clientId] = [];
      billingLedger[clientId].push(entry);
    }
  })();
  const client = clientById.get(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId };
}

/**
 * atomicDebit — atomically subtract amount from client balance AND insert ledger entry
 * Same BUG-02/03/05 fixes as atomicCredit
 */
function atomicDebit(clientId, amount, ledgerEntry) {
  amount = Math.round(parseFloat(amount) * 100) / 100;
  if (isNaN(amount) || amount === 0) throw new Error('atomicDebit: invalid amount');
  let balanceBefore, balanceAfter, ledgerDbId;
  db.transaction(() => {
    const row = _clientGetBalance.get(clientId);
    if (!row) throw new Error(`atomicDebit: client ${clientId} not found`);
    balanceBefore = row.balance || 0;
    balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;
    _clientUpdateBalance.run(balanceAfter, clientId);
    if (ledgerEntry) {
      const entry = { ...ledgerEntry, balance_before: balanceBefore, balance_after: balanceAfter };
      const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
      entry.db_id = result.lastInsertRowid;
      ledgerDbId = entry.db_id; // OLD-02 fix: expose to caller
      if (!billingLedger[clientId]) billingLedger[clientId] = [];
      billingLedger[clientId].push(entry);
    }
  })();
  const client = clientById.get(clientId);
  if (client) client.balance = balanceAfter;
  return { balanceBefore, balanceAfter, ledgerDbId };
}
const _paymentDeleteByClient = db.prepare('DELETE FROM payments WHERE client_id = ?');
const _paymentInsert = db.prepare('INSERT INTO payments (client_id, amount, date, note, source, payment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const _docDeleteByClient = db.prepare('DELETE FROM client_documents WHERE client_id = ?');
const _docInsert = db.prepare('INSERT INTO client_documents (id, client_id, name, file_name, mime_type, date) VALUES (?, ?, ?, ?, ?, ?)');
const _closingDocDeleteByClient = db.prepare('DELETE FROM closing_documents WHERE client_id = ?');
const _closingDocInsert = db.prepare('INSERT INTO closing_documents (id, client_id, tochka_doc_id, period, type, act_number, items, total_amount, status, contract_info, signed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const _billDeleteByClient = db.prepare('DELETE FROM bills WHERE client_id = ?');
const _billInsert = db.prepare('INSERT INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const _getPayments = db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY date DESC, id DESC');
const _getDocs = db.prepare('SELECT * FROM client_documents WHERE client_id = ? ORDER BY date');
const _getClosingDocs = db.prepare('SELECT * FROM closing_documents WHERE client_id = ? ORDER BY created_at');
const _getBills = db.prepare('SELECT * FROM bills WHERE client_id = ? ORDER BY created_at');

function clientFromRow(r) {
  return {
    id: r.id, login: r.login, password: r.password || '', passwordHash: r.password_hash || '',
    portName: r.port_name || '', name: r.name, contact: r.contact || '', notes: r.notes || '',
    billingType: r.billing_type || 'per_gb', price: r.price || 0, currency: r.currency || 'RUB',
    balance: r.balance || 0, apiKey: r.api_key || '', referral_code: r.referral_code || '',
    referred_by: r.referred_by || null, referral_balance: r.referral_balance || 0,
    resetToken: r.reset_token || '', inn: r.inn || '', kpp: r.kpp || '',
    legalName: r.legal_name || '', contractInfo: r.contract_info || '',
    address: r.address || '', autoActs: r.auto_acts !== 0, autoBills: r.auto_bills !== 0,
    clientType: r.client_type || 'legal',
    last_traffic_snapshot: r.last_traffic_snapshot
      ? (typeof r.last_traffic_snapshot === 'string' ? JSON.parse(r.last_traffic_snapshot) : r.last_traffic_snapshot)
      : { timestamp: null, month_bytes: 0 },
    createdAt: r.created_at || '',
    payments: [], documents: [], closingDocuments: [], bills: []
  };
}

function loadClients() {
  const rows = db.prepare('SELECT * FROM clients').all();
  if (rows.length === 0) {
    // JSON fallback for first-time migration
    try {
      if (fs.existsSync(CLIENTS_FILE)) {
        const jsonClients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
        if (jsonClients.length > 0) return jsonClients;
      }
    } catch (e) { console.error('[SQLite] Failed to load clients from JSON fallback:', e.message); }
    return [];
  }
  const clientsList = rows.map(clientFromRow);
  for (const client of clientsList) {
    client.payments = _getPayments.all(client.id).map(r => ({
      amount: r.amount, date: r.date, note: r.note || '', source: r.source || 'manual',
      paymentId: r.payment_id || undefined, createdAt: r.created_at || ''
    }));
    client.documents = _getDocs.all(client.id).map(r => ({
      id: r.id, name: r.name, fileName: r.file_name, mimeType: r.mime_type || '', date: r.date || ''
    }));
    client.closingDocuments = _getClosingDocs.all(client.id).map(r => ({
      id: r.id, tochkaDocumentId: r.tochka_doc_id || '', period: r.period, type: r.type || 'act',
      actNumber: r.act_number || '', items: JSON.parse(r.items || '[]'), totalAmount: r.total_amount || 0,
      status: r.status || 'unsigned', contractInfo: r.contract_info || '',
      signedAt: r.signed_at || undefined, createdAt: r.created_at || ''
    }));
    client.bills = _getBills.all(client.id).map(r => ({
      id: r.id, tochkaBillId: r.tochka_bill_id || '', period: r.period,
      billNumber: r.bill_number || '', amount: r.amount || 0,
      status: r.status || 'unpaid', createdAt: r.created_at || ''
    }));
  }
  return clientsList;
}

function saveClients(clientsList) {
  if (!Array.isArray(clientsList)) {
    console.error('[CRITICAL] saveClients called without array argument! Aborting write.');
    return;
  }
  try {
    db.transaction(() => {
      // Remove deleted clients (ON DELETE CASCADE cleans sub-tables)
      const liveIds = new Set(clientsList.map(c => c.id));
      for (const r of _clientGetIds.all()) {
        if (!liveIds.has(r.id)) _clientDelete.run(r.id);
      }
      // Upsert clients + sync sub-arrays
      for (const c of clientsList) {
        _clientUpsert.run(
          c.id, c.login, c.password || '', c.passwordHash || '', c.portName || '', c.name || '',
          c.contact || '', c.notes || '', c.billingType || 'per_gb', c.price || 0,
          c.currency || 'RUB', c.balance || 0, c.apiKey || '', c.referral_code || '',
          c.referred_by || null, c.referral_balance || 0, c.resetToken || '',
          c.inn || '', c.kpp || '', c.legalName || '', c.contractInfo || '',
          c.address || '', c.autoActs !== false ? 1 : 0, c.autoBills !== false ? 1 : 0,
          JSON.stringify(c.last_traffic_snapshot || {}), c.createdAt || new Date().toISOString(),
          c.clientType || 'legal'
        );
        // Sync payments
        _paymentDeleteByClient.run(c.id);
        for (const p of (c.payments || [])) {
          _paymentInsert.run(c.id, p.amount, p.date || '', p.note || '', p.source || 'manual',
            p.paymentId || null, p.createdAt || new Date().toISOString());
        }
        // Sync documents
        _docDeleteByClient.run(c.id);
        for (const d of (c.documents || [])) {
          _docInsert.run(d.id, c.id, d.name || '', d.fileName || '', d.mimeType || '', d.date || '');
        }
        // Sync closing documents
        _closingDocDeleteByClient.run(c.id);
        for (const d of (c.closingDocuments || [])) {
          _closingDocInsert.run(d.id, c.id, d.tochkaDocumentId || '', d.period || '', d.type || 'act',
            d.actNumber || '', JSON.stringify(d.items || []), d.totalAmount || 0, d.status || 'unsigned',
            d.contractInfo || '', d.signedAt || null, d.createdAt || new Date().toISOString());
        }
        // Sync bills
        _billDeleteByClient.run(c.id);
        for (const b of (c.bills || [])) {
          _billInsert.run(b.id, c.id, b.tochkaBillId || '', b.period || '', b.billNumber || '',
            b.amount || 0, b.status || 'unpaid', b.createdAt || new Date().toISOString());
        }
      }
    })();
  } catch (e) {
    console.error('[SQLite] Error saving clients:', e.message);
  }
}

// ==================== BILLING LEDGER (SQLite-backed, BUG-01/ARCH-01) ====================
const BILLING_LEDGER_FILE = path.join(__dirname, 'billing_ledger.json'); // JSON fallback
const _ledgerDeleteByClient = db.prepare('DELETE FROM billing_ledger WHERE client_id = ?');
const _ledgerInsert = db.prepare(`INSERT INTO billing_ledger
  (client_id, type, date, timestamp, amount, currency, balance_before, balance_after,
   gb_used, modem_count, days_in_month, note, source, payment_id, details)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let billingLedger = {};
{
  const _blRows = db.prepare('SELECT * FROM billing_ledger ORDER BY id').all();
  if (_blRows.length > 0) {
    for (const r of _blRows) {
      if (!billingLedger[r.client_id]) billingLedger[r.client_id] = [];
      const entry = { type: r.type, date: r.date, timestamp: r.timestamp || '' };
      if (r.type === 'charge') { entry.cost = r.amount; } else { entry.amount = r.amount; }
      entry.currency = r.currency || 'RUB';
      if (r.balance_before != null) entry.balance_before = r.balance_before;
      if (r.balance_after != null) entry.balance_after = r.balance_after;
      if (r.gb_used != null) entry.delta_gb = r.gb_used;
      if (r.modem_count != null) entry.modem_count = r.modem_count;
      if (r.days_in_month != null) entry.days_in_month = r.days_in_month;
      if (r.note) entry.note = r.note;
      if (r.source) entry.source = r.source;
      if (r.payment_id) entry.paymentId = r.payment_id;
      if (r.details && r.details !== '{}') {
        try { Object.assign(entry, JSON.parse(r.details)); } catch (e) {}
      }
      entry.db_id = r.id; // BUG-05 fix: track SQLite rowid for point deletion
      billingLedger[r.client_id].push(entry);
    }
    console.log(`[SQLite] Loaded ${_blRows.length} billing ledger entries`);
  } else {
    try {
      if (fs.existsSync(BILLING_LEDGER_FILE)) {
        billingLedger = JSON.parse(fs.readFileSync(BILLING_LEDGER_FILE, 'utf8'));
        const total = Object.values(billingLedger).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
        if (total > 0) console.log(`[SQLite] Loaded ${total} billing ledger entries from JSON fallback`);
      }
    } catch (e) { console.error('[SQLite] Failed to load billing_ledger from JSON:', e.message); }
  }
}

const MAX_LEDGER_ENTRIES = 1000; // per client

// TASK-04: Helper to build details JSON and amount for SQLite insert
function _ledgerEntryParams(clientId, e) {
  const amount = e.type === 'charge' ? (e.cost || 0) : (e.amount || 0);
  const details = {};
  if (e.delta_bytes != null) details.delta_bytes = e.delta_bytes;
  if (e.price_per_unit != null) details.price_per_unit = e.price_per_unit;
  if (e.billing_type) details.billing_type = e.billing_type;
  if (e.tochkaPaymentId) details.tochkaPaymentId = e.tochkaPaymentId;
  return [
    clientId, e.type || '', e.date || '', e.timestamp || '', amount,
    e.currency || 'RUB', e.balance_before ?? null, e.balance_after ?? null,
    e.delta_gb ?? null, e.modem_count ?? null, e.days_in_month ?? null,
    e.note || '', e.source || null, e.paymentId || null,
    Object.keys(details).length > 0 ? JSON.stringify(details) : null
  ];
}

/**
 * TASK-04+BUG-05: Incremental appendLedgerEntry — inserts single entry to SQLite + in-memory
 * Saves db_id (lastInsertRowid) back to entry for point deletion
 * NOTE: For balance-changing operations, prefer atomicCredit/atomicDebit with ledgerEntry param
 */
function appendLedgerEntry(clientId, entry) {
  if (!billingLedger[clientId]) billingLedger[clientId] = [];
  try {
    const result = _ledgerInsert.run(..._ledgerEntryParams(clientId, entry));
    entry.db_id = result.lastInsertRowid; // BUG-05 fix: track SQLite rowid
    billingLedger[clientId].push(entry); // NEW-02 fix: only push on successful insert
  } catch (e) {
    console.error('[SQLite] Error appending ledger entry:', e.message);
    // NOT adding to in-memory — keeps state consistent with DB
  }
}

// BUG-04 fix: Point deletion by SQLite rowid instead of DELETE+reinsert
const _ledgerDeleteById = db.prepare('DELETE FROM billing_ledger WHERE id = ?');

// TASK-04: Full save — only for bulk operations (migration, ledger trimming, entry deletion)
function saveBillingLedger() {
  try {
    const validIds = new Set(_clientGetIds.all().map(r => r.id));
    db.transaction(() => {
      for (const clientId in billingLedger) {
        if (!validIds.has(clientId)) continue;
        let entries = billingLedger[clientId];
        if (!Array.isArray(entries)) continue;
        if (entries.length > MAX_LEDGER_ENTRIES) {
          entries = entries.slice(-MAX_LEDGER_ENTRIES);
          billingLedger[clientId] = entries;
        }
        _ledgerDeleteByClient.run(clientId);
        for (const e of entries) {
          _ledgerInsert.run(..._ledgerEntryParams(clientId, e));
        }
      }
    })();
  } catch (e) {
    console.error('[SQLite] Error saving billing ledger:', e.message);
  }
}

// ==================== AUDIT LOG (TASK-J) — SQLite-backed ====================
function auditLog(adminLogin, action, details = {}) {
  try {
    const ts = new Date().toISOString();
    dbStmts.insertAudit.run(ts, adminLogin, action, JSON.stringify(details));
  } catch (e) {
    console.error('[AuditLog] Write failed:', e.message);
  }
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

// ==================== TOCHKA BANK API ====================
const TOCHKA_CONFIG_FILE = path.join(__dirname, 'tochka_config.json');
let tochkaConfig = { jwt: '', clientId: '', customerCode: '', accountId: '', companyName: '', companyInn: '', companyKpp: '' };
try {
  if (fs.existsSync(TOCHKA_CONFIG_FILE)) {
    Object.assign(tochkaConfig, JSON.parse(fs.readFileSync(TOCHKA_CONFIG_FILE, 'utf8')));
  }
} catch (e) { console.log('[Tochka] Error loading config file:', e.message); }
// .env overrides file config
if (process.env.TOCHKA_JWT_TOKEN) tochkaConfig.jwt = process.env.TOCHKA_JWT_TOKEN;
if (process.env.TOCHKA_CLIENT_ID) tochkaConfig.clientId = process.env.TOCHKA_CLIENT_ID;
if (process.env.TOCHKA_CUSTOMER_CODE) tochkaConfig.customerCode = process.env.TOCHKA_CUSTOMER_CODE;
if (process.env.TOCHKA_ACCOUNT_ID) tochkaConfig.accountId = process.env.TOCHKA_ACCOUNT_ID;
if (process.env.TOCHKA_COMPANY_NAME) tochkaConfig.companyName = process.env.TOCHKA_COMPANY_NAME;
if (process.env.TOCHKA_COMPANY_INN) tochkaConfig.companyInn = process.env.TOCHKA_COMPANY_INN;
if (process.env.TOCHKA_COMPANY_KPP) tochkaConfig.companyKpp = process.env.TOCHKA_COMPANY_KPP;
function saveTochkaConfig() { safeWriteFile(TOCHKA_CONFIG_FILE, JSON.stringify(tochkaConfig, null, 2)); }
if (tochkaConfig.jwt) { saveTochkaConfig(); console.log(`[Tochka] API configured (client_id: ${tochkaConfig.clientId})`); }
else console.log('[Tochka] No JWT token configured, bank integration disabled');

// Tochka API helper — HTTPS requests to enter.tochka.com
function tochkaRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${tochkaConfig.jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (tochkaConfig.customerCode) headers['CustomerCode'] = tochkaConfig.customerCode;
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request({
      hostname: 'enter.tochka.com',
      port: 443,
      path: apiPath,
      method: method,
      headers,
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf.toString()), headers: res.headers }); }
          catch (e) { resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers }); }
        } else if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
          resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
        } else {
          resolve({ status: res.statusCode, data: buf.toString(), headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tochka API timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ==================== BANK PAYMENTS — SQLite-backed ====================
// Helper: convert SQLite row to JS object with camelCase keys
function bankPaymentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, webhookType: row.webhook_type, payerInn: row.payer_inn,
    payerName: row.payer_name, amount: row.amount, purpose: row.purpose,
    paymentId: row.payment_id, date: row.date, customerCode: row.customer_code,
    matched: !!row.matched, matchedClientId: row.matched_client_id,
    matchedClientName: row.matched_client_name, autoCredit: !!row.auto_credit,
    dismissed: !!row.dismissed, source: row.source || '',
    tochkaPaymentId: row.tochka_payment_id || '', receivedAt: row.received_at
  };
}

function insertBankPaymentToDb(bp) {
  dbStmts.insertBankPayment.run(
    bp.id, bp.webhookType || '', bp.payerInn || '', bp.payerName || '',
    bp.amount || 0, bp.purpose || '', bp.paymentId || '', bp.date || '',
    bp.customerCode || '', bp.matched ? 1 : 0, bp.matchedClientId || null,
    bp.matchedClientName || null, bp.autoCredit ? 1 : 0,
    bp.dismissed ? 1 : 0, bp.source || '', bp.tochkaPaymentId || '',
    bp.receivedAt || new Date().toISOString()
  );
}

function getAllBankPayments() {
  return dbStmts.getBankPayments.all().map(bankPaymentFromRow);
}

// SEC-02: JWT verification for Tochka webhooks
// Cache for Tochka JWKS public keys
let tochkaJwksCache = { keys: null, fetchedAt: 0 };
const JWKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch (e) { return null; }
}

function decodeJwtHeader(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  } catch (e) { return null; }
}

// Fetch JWKS from Tochka Bank
function fetchTochkaJwks() {
  return new Promise((resolve, reject) => {
    https.get('https://enter.tochka.com/uapi/open-banking/.well-known/jwks.json', { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JWKS parse error: ' + e.message)); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('JWKS fetch timeout')); });
  });
}

// Convert JWK RSA public key to PEM format
function jwkToPem(jwk) {
  const n = base64urlDecode(jwk.n);
  const e = base64urlDecode(jwk.e);
  // Build RSA public key in DER format
  function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  function encodeDerInteger(buf) {
    // Prepend 0x00 if high bit set (positive integer)
    const needsPad = buf[0] & 0x80;
    const content = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), encodeLength(content.length), content]);
  }
  const nDer = encodeDerInteger(n);
  const eDer = encodeDerInteger(e);
  const rsaSeqContent = Buffer.concat([nDer, eDer]);
  const rsaSeq = Buffer.concat([Buffer.from([0x30]), encodeLength(rsaSeqContent.length), rsaSeqContent]);
  // Wrap in BIT STRING
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLength(rsaSeq.length + 1), Buffer.from([0x00]), rsaSeq]);
  // RSA OID: 1.2.840.113549.1.1.1
  const oid = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const pubKeyContent = Buffer.concat([oid, bitString]);
  const pubKey = Buffer.concat([Buffer.from([0x30]), encodeLength(pubKeyContent.length), pubKeyContent]);
  const b64 = pubKey.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
}

// Verify JWT signature using cached JWKS
async function verifyJwtSignature(token) {
  const header = decodeJwtHeader(token);
  const payload = decodeJwtPayload(token);
  if (!header || !payload) return { verified: false, payload: null, reason: 'invalid_jwt_format' };

  // Fetch/cache JWKS
  const now = Date.now();
  if (!tochkaJwksCache.keys || (now - tochkaJwksCache.fetchedAt) > JWKS_CACHE_TTL) {
    try {
      const jwks = await fetchTochkaJwks();
      tochkaJwksCache = { keys: jwks.keys || [], fetchedAt: now };
      console.log(`[Tochka JWKS] Fetched ${tochkaJwksCache.keys.length} key(s)`);
    } catch (e) {
      console.error('[Tochka JWKS] Failed to fetch keys:', e.message);
      // If we have cached keys, use them even if expired
      if (tochkaJwksCache.keys) {
        console.warn('[Tochka JWKS] Using expired cached keys');
      } else {
        // No keys at all — log warning but still return decoded payload (graceful degradation)
        console.warn('[Tochka JWKS] No cached keys, skipping signature verification');
        return { verified: false, payload, reason: 'jwks_unavailable' };
      }
    }
  }

  // Find matching key
  const kid = header.kid;
  const alg = header.alg || 'RS256';
  let matchingKey = kid ? tochkaJwksCache.keys.find(k => k.kid === kid) : tochkaJwksCache.keys[0];

  if (!matchingKey) {
    console.warn(`[Tochka JWT] No matching key found for kid="${kid}"`);
    return { verified: false, payload, reason: 'key_not_found' };
  }

  try {
    const pem = jwkToPem(matchingKey);
    const parts = token.split('.');
    const signedData = parts[0] + '.' + parts[1];
    const signature = base64urlDecode(parts[2]);

    const algMap = { 'RS256': 'RSA-SHA256', 'RS384': 'RSA-SHA384', 'RS512': 'RSA-SHA512' };
    const cryptoAlg = algMap[alg] || 'RSA-SHA256';

    const verifier = crypto.createVerify(cryptoAlg);
    verifier.update(signedData);
    const isValid = verifier.verify(pem, signature);

    return { verified: isValid, payload, reason: isValid ? 'ok' : 'signature_invalid' };
  } catch (e) {
    console.error('[Tochka JWT] Verification error:', e.message);
    return { verified: false, payload, reason: 'verification_error: ' + e.message };
  }
}

// Track last act/bill generation month to avoid duplicates
let lastActGenerationMonth = '';
let lastBillGenerationMonth = '';

// Russian month names (prepositional case for "в январе")
const MONTH_NAMES_RU = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];

// Helper: build Tochka closing document request body
function buildTochkaActBody(client, period, actItems, actNumber) {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const monthNameRu = MONTH_NAMES_RU[month - 1] || '';
  const serviceName = `Услуги по обеспечению подключения к прокси-серверу в ${monthNameRu} ${year}г`;
  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  // Build Act object
  // NB: поле "Основание" не поддерживается API Точки для закрывающих документов — заполняется вручную
  const act = {
    Positions: actItems.map((item, idx) => ({
      positionName: serviceName,
      quantity: item.quantity || 1,
      unitCode: 'услуга.',
      totalAmount: item.amount || 0,
      ndsKind: 'without_nds',
      price: item.amount || 0,
      positionNumber: idx + 1
    })),
    actDate: `${period}-${String(lastDay).padStart(2, '0')}`,
    number: actNumber,
    totalAmount: Math.round(totalAmount * 100) / 100
  };

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Act: act,
        PackingList: {},
        Invoicef: {},
        Upd: {}
      }
    }
  };
}

// TASK-06: Shared helper — build act items from billing ledger for a given period
function buildActItemsFromLedger(client, period) {
  const ledgerEntries = billingLedger[client.id] || [];
  const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
  const totalGb = monthCharges.reduce((sum, e) => sum + (e.delta_gb || 0), 0);
  const totalCost = Math.round(monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0) * 100) / 100;
  const modemCharges = monthCharges.filter(e => e.billing_type === 'per_modem');
  const gbCharges = monthCharges.filter(e => e.billing_type !== 'per_modem');

  const actItems = [];
  if (gbCharges.length > 0) {
    actItems.push({
      name: 'Услуги мобильных прокси (трафик)',
      quantity: Math.round(totalGb * 100) / 100,
      unit: 'ГБ',
      price: client.price || 23,
      amount: Math.round(gbCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
    });
  }
  if (modemCharges.length > 0) {
    const modemCount = new Set(modemCharges.map(e => e.note || '')).size || 1;
    actItems.push({
      name: 'Услуги мобильных прокси (аренда модемов)',
      quantity: modemCount,
      unit: 'шт',
      price: client.price || 0,
      amount: Math.round(modemCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100
    });
  }
  if (actItems.length === 0) {
    actItems.push({
      name: 'Услуги мобильных прокси',
      quantity: Math.round(totalGb * 100) / 100 || 1,
      unit: totalGb > 0 ? 'ГБ' : 'мес',
      price: client.price || 23,
      amount: totalCost
    });
  }
  return { actItems, totalCost, monthCharges };
}

// Helper: build Tochka bill (счёт на оплату) request body
function buildTochkaBillBody(client, amount, billNumber, billDate) {
  const isIP = client.inn && client.inn.length === 12;

  // Build full counterparty name with address (ИНН/КПП добавляется Точкой автоматически)
  let secondSideName = client.legalName || client.name;
  if (client.address) {
    secondSideName += `, ${client.address}`;
  }

  return {
    Data: {
      accountId: tochkaConfig.accountId,
      customerCode: tochkaConfig.customerCode,
      SecondSide: {
        secondSideType: isIP ? 'individual_entrepreneur' : 'legal_entity',
        type: isIP ? 'ip' : 'company',
        inn: client.inn || '',
        taxCode: client.inn || '',
        kpp: client.kpp || '',
        name: secondSideName
      },
      Content: {
        Invoice: {
          Positions: [{
            positionName: 'Предоплата за услуги мобильных прокси',
            quantity: 1,
            unitCode: 'услуга.',
            totalAmount: amount,
            ndsKind: 'without_nds',
            price: amount,
            positionNumber: 1
          }],
          invoiceDate: billDate,
          number: billNumber,
          totalAmount: amount
        }
      }
    }
  };
}

// Helper: calculate monthly bill amount for a client
function calculateMonthlyBillAmount(client, cachedResults) {
  let baseAmount = 0;

  if (client.billingType === 'per_modem') {
    // Fixed: price * modem count
    let modemCount = 0;
    if (cachedResults && cachedResults.length > 0) {
      for (const data of cachedResults) {
        if (typeof data.bw === 'object') {
          for (const [portId, b] of Object.entries(data.bw)) {
            if (b.portName === client.portName) modemCount++;
          }
        }
      }
    }
    if (modemCount === 0) modemCount = 1; // fallback
    baseAmount = client.price * modemCount;
  } else {
    // per_gb: sum charges from previous month
    const now = new Date();
    const prevMonth = new Date(now);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const prevPeriod = prevMonth.toISOString().slice(0, 7); // YYYY-MM

    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(prevPeriod));
    baseAmount = monthCharges.reduce((sum, e) => sum + (e.cost || 0), 0);

    if (baseAmount <= 0) return 0; // no charges last month — skip
  }

  // Add negative balance (debt) to the amount
  let totalAmount = baseAmount;
  if ((client.balance || 0) < 0) {
    totalAmount += Math.abs(client.balance);
  }

  // For per_gb: round up to nearest 10,000₽
  if (client.billingType !== 'per_modem') {
    totalAmount = Math.ceil(totalAmount / 10000) * 10000;
  }

  return Math.round(totalAmount * 100) / 100;
}

// ==================== DAILY TRAFFIC HISTORY — SQLite-backed ====================
let dailyTraffic = {}; // { portKey: { "2026-03-01": { in: bytes, out: bytes, portName }, ... } }
// Load from SQLite
try {
  const rows = db.prepare('SELECT port_name, date, bytes_in, bytes_out FROM daily_traffic').all();
  for (const r of rows) {
    if (!dailyTraffic[r.port_name]) dailyTraffic[r.port_name] = {};
    dailyTraffic[r.port_name][r.date] = { in: r.bytes_in, out: r.bytes_out };
  }
  if (rows.length > 0) console.log(`[SQLite] Loaded ${rows.length} daily traffic entries`);
} catch (e) { console.error('Failed to load daily_traffic from SQLite:', e.message); }

const _dtUpsert = db.prepare('INSERT OR REPLACE INTO daily_traffic (port_name, date, bytes_in, bytes_out) VALUES (?, ?, ?, ?)');
const _dtCleanup = db.prepare("DELETE FROM daily_traffic WHERE date < date('now', '-90 days')");
const _htUpsert = db.prepare('INSERT OR REPLACE INTO traffic_hourly (port_name, hour_start, bytes_in, bytes_out) VALUES (?, ?, ?, ?)');
const _htCleanup = db.prepare("DELETE FROM traffic_hourly WHERE hour_start < datetime('now', '-90 days')");

function saveDailyTraffic() {
  try {
    const batch = db.transaction(() => {
      for (const [portName, days] of Object.entries(dailyTraffic)) {
        for (const [date, data] of Object.entries(days)) {
          const bIn = typeof data === 'object' ? (data.in || 0) : 0;
          const bOut = typeof data === 'object' ? (data.out || 0) : 0;
          _dtUpsert.run(portName, date, bIn, bOut);
        }
      }
      _dtCleanup.run();
    });
    batch();
  } catch (e) { console.error('[saveDailyTraffic] SQLite error:', e.message); }
}

// ==================== HOURLY TRAFFIC AGGREGATION ====================
// In-memory snapshots of daily counters, used to derive per-hour increments
let hourlyDaySnapshots = {}; // { portName: { in: bytes, out: bytes, date: 'YYYY-MM-DD' } }

async function aggregateHourlyTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    if (Object.keys(portKeyToPortName).length === 0) refreshPortKeyMapping(results);
    const pnMap = portKeyToPortName;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // The hour window that just completed (e.g. at 14:01 → store 13:00–14:00)
    const prevH = new Date(now);
    prevH.setHours(prevH.getHours() - 1, 0, 0, 0);
    const hourStart = prevH.toISOString().slice(0, 13).replace('T', ' ') + ':00';

    const batch = db.transaction(() => {
      for (const data of results) {
        if (typeof data.bw !== 'object') continue;
        const srv = data.serverName || '';
        for (const [portId, b] of Object.entries(data.bw)) {
          const clientName = b.portName || pnMap[srv + '_' + portId] || '';
          if (!clientName) continue;
          const portName = srv + ':' + clientName; // prefix with server for per-country separation
          const dayIn  = parseBwToBytes(b.bandwidth_bytes_day_in);
          const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
          const snap = hourlyDaySnapshots[portName];
          if (snap && snap.date === todayStr) {
            const incIn  = Math.max(0, dayIn  - snap.in);
            const incOut = Math.max(0, dayOut - snap.out);
            if (incIn + incOut > 0) _htUpsert.run(portName, hourStart, incIn, incOut);
          }
          hourlyDaySnapshots[portName] = { in: dayIn, out: dayOut, date: todayStr };
        }
      }
      _htCleanup.run();
    });
    batch();
    console.log(`[HourlyAgg] Stored ${hourStart}, ports tracked: ${Object.keys(hourlyDaySnapshots).length}`);
  } catch (e) {
    console.error('[HourlyAgg] Error:', e.message);
  }
}

// Parse traffic value like "10.5 GB" to bytes
function parseTrafficValue(val) {
  if (!val || val === '0 B') return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  const match = str.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return num * (mult[unit] || 1);
}

// ==================== BILLING HELPERS ====================

function getMoscowNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

function getMoscowToday() {
  return getMoscowNow().toLocaleDateString('en-CA'); // "YYYY-MM-DD"
}

function getMoscowYesterday() {
  const d = getMoscowNow();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}

function trafficBytesToGb(bytes) {
  return Math.round(bytes / (1024 * 1024 * 1024) * 1000) / 1000;
}

// Global portKey→portName mapping: "S1_port123" → "Brandanalytics"
let portKeyToPortName = {};
function refreshPortKeyMapping(allServerResults) {
  const map = {};
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      const prefix = (data.serverName || '') + '_';
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName) map[prefix + portId] = b.portName;
      }
    }
  }
  portKeyToPortName = map;
}

// Last billing run metadata (for /health and retry logic)
let lastBillingRunSummary = null;
let lastReconciliationMonth = '';

// ==================== KNOWN MODEMS (persistence for offline detection) ====================
const KNOWN_MODEMS_FILE = path.join(__dirname, 'known_modems.json');
let knownModems = {}; // { serverName: { portId: { portName, imei, nick, model, portInfo, lastSeen } } }
try {
  if (fs.existsSync(KNOWN_MODEMS_FILE)) {
    knownModems = JSON.parse(fs.readFileSync(KNOWN_MODEMS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load known_modems:', e.message); }

function saveKnownModems() {
  safeWriteFile(KNOWN_MODEMS_FILE, JSON.stringify(knownModems, null, 2));
}

/**
 * Update known modems from fresh (non-cached) server data.
 * Remembers each modem ever seen so we can inject them as offline later.
 */
function updateKnownModems(data) {
  if (data._cached) return;
  const srvName = data.serverName;
  if (!knownModems[srvName]) knownModems[srvName] = {};
  const km = knownModems[srvName];
  const now = Date.now();

  // Build portId → imei map from ports data
  const portIdToImei = {};
  if (data.ports && typeof data.ports === 'object') {
    for (const [imei, portList] of Object.entries(data.ports)) {
      if (Array.isArray(portList)) {
        for (const p of portList) {
          if (p.portID) portIdToImei[p.portID] = imei;
        }
      }
    }
  }

  // Update known modems with currently present data
  if (data.bw && typeof data.bw === 'object') {
    for (const [portId, bw] of Object.entries(data.bw)) {
      const imei = portIdToImei[portId] || '';
      let modemStatus = null;
      if (Array.isArray(data.status)) {
        modemStatus = data.status.find(m => m.modem_details && m.modem_details.IMEI === imei);
      }
      let portInfo = null;
      if (data.ports && data.ports[imei]) {
        const arr = Array.isArray(data.ports[imei]) ? data.ports[imei] : [];
        portInfo = arr.find(p => p.portID === portId) || null;
      }

      km[portId] = {
        portName: bw.portName || '',
        imei,
        nick: (modemStatus && modemStatus.modem_details && modemStatus.modem_details.NICK) || (km[portId] && km[portId].nick) || '',
        model: (modemStatus && modemStatus.modem_details && (modemStatus.modem_details.MODEL_SHOWN || modemStatus.modem_details.MODEL)) || (km[portId] && km[portId].model) || '',
        portInfo: portInfo ? JSON.parse(JSON.stringify(portInfo)) : (km[portId] && km[portId].portInfo ? km[portId].portInfo : null),
        lastSeen: now
      };
    }
  }

  saveKnownModems();
}

/**
 * Inject offline modems: for modems in knownModems that are NOT in the current data,
 * add them back with offline status so they appear in the dashboard.
 */
function injectOfflineModems(data) {
  const srvName = data.serverName;
  const km = knownModems[srvName];
  if (!km) return;

  const currentPortIds = new Set(Object.keys(data.bw || {}));
  // Build set of IMEIs already present in status to avoid duplicates
  const currentImeis = new Set(
    (Array.isArray(data.status) ? data.status : [])
      .map(m => m.modem_details ? m.modem_details.IMEI : null)
      .filter(Boolean)
  );

  for (const [portId, info] of Object.entries(km)) {
    if (currentPortIds.has(portId)) continue;
    // Skip if this modem's IMEI is already in status (online under different portId)
    if (info.imei && currentImeis.has(info.imei)) continue;
    // Inject into bw
    if (!data.bw) data.bw = {};
    data.bw[portId] = {
      portName: info.portName || '',
      bandwidth_bytes_day_in: '0 B',
      bandwidth_bytes_day_out: '0 B',
      bandwidth_bytes_yesterday_in: '0 B',
      bandwidth_bytes_yesterday_out: '0 B',
      bandwidth_bytes_month_in: '0 B',
      bandwidth_bytes_month_out: '0 B',
      bandwidth_bytes_prevmonth_in: '0 B',
      bandwidth_bytes_prevmonth_out: '0 B',
      bandwidth_bytes_lifetime_in: '0 B',
      bandwidth_bytes_lifetime_out: '0 B',
      _offline: true
    };

    // Inject into status
    if (!Array.isArray(data.status)) data.status = [];
    if (info.imei) {
      data.status.push({
        modem_details: {
          IMEI: info.imei,
          NICK: info.nick || '',
          MODEL_SHOWN: info.model || '',
          MODEL: info.model || ''
        },
        net_details: {
          IS_ONLINE: 'no',
          EXT_IP: '',
          CELLOP: '',
          CurrentNetworkType: ''
        },
        _server: srvName,
        _offline: true
      });
    }

    // Inject into ports
    if (!data.ports) data.ports = {};
    if (info.imei && info.portInfo) {
      if (!data.ports[info.imei]) data.ports[info.imei] = [];
      const existing = data.ports[info.imei].find(p => p.portID === portId);
      if (!existing) {
        data.ports[info.imei].push({
          ...info.portInfo,
          _offline: true
        });
      }
    }
  }
}

// Load clients into users map on startup
let clients = loadClients();

// TASK-E: Map indexes for O(1) client lookups
let clientById = new Map();
let clientByLogin = new Map();
let clientByApiKey = new Map();
let clientByInn = new Map();
let clientByResetToken = new Map();

function rebuildClientMaps() {
  clientById = new Map(clients.map(c => [c.id, c]));
  clientByLogin = new Map(clients.map(c => [c.login, c]));
  clientByApiKey = new Map(clients.filter(c => c.apiKey).map(c => [c.apiKey, c]));
  clientByInn = new Map(clients.filter(c => c.inn).map(c => [c.inn, c]));
  clientByResetToken = new Map(clients.filter(c => c.resetToken).map(c => [c.resetToken, c]));
}

// Ensure all clients have required fields (migration)
let clientsMigrated = false;
for (const c of clients) {
  if (!c.payments) { c.payments = []; clientsMigrated = true; }
  if (!c.apiKey) { c.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex'); clientsMigrated = true; }
  if (!c.referral_code) { c.referral_code = 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(); clientsMigrated = true; }
  if (c.referral_balance === undefined) { c.referral_balance = 0; clientsMigrated = true; }
  if (!c.resetToken) { c.resetToken = crypto.randomBytes(16).toString('hex'); clientsMigrated = true; }
  if (!c.documents) { c.documents = []; clientsMigrated = true; }
  // Billing persistence: initialize balance from total payments
  if (c.balance === undefined) {
    c.balance = (c.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    clientsMigrated = true;
  }
  if (!c.last_traffic_snapshot) {
    c.last_traffic_snapshot = { timestamp: null, month_bytes: 0 };
    clientsMigrated = true;
  }
  // Tochka Bank integration fields
  if (c.inn === undefined) { c.inn = ''; clientsMigrated = true; }
  if (c.kpp === undefined) { c.kpp = ''; clientsMigrated = true; }
  if (c.legalName === undefined) { c.legalName = ''; clientsMigrated = true; }
  if (!c.closingDocuments) { c.closingDocuments = []; clientsMigrated = true; }
  if (c.contractInfo === undefined) { c.contractInfo = ''; clientsMigrated = true; }
  if (c.address === undefined) { c.address = ''; clientsMigrated = true; }
  if (!c.bills) { c.bills = []; clientsMigrated = true; }
  if (c.autoActs === undefined) { c.autoActs = true; clientsMigrated = true; }
  if (c.autoBills === undefined) { c.autoBills = true; clientsMigrated = true; }
  // SEC-01: Migrate plaintext passwords to bcrypt
  if (c.password && !c.password.startsWith('$2b$')) {
    c.passwordHash = bcrypt.hashSync(c.password, 10);
    clientsMigrated = true;
    console.log(`  [bcrypt] Migrated password for ${c.login}`);
  }
  if (!c.passwordHash && c.password) {
    c.passwordHash = bcrypt.hashSync(c.password, 10);
    clientsMigrated = true;
  }
}
if (clientsMigrated) saveClients(clients);
rebuildClientMaps(); // Build maps before auto-migration check

// Auto-migrate .env users (non-admin) to clients if not already there
for (const [login, u] of Object.entries(users)) {
  if (u.source === 'env' && u.portNameFilter !== '*') {
    const exists = clientByLogin.get(login);
    if (!exists) {
      const client = {
        id: crypto.randomBytes(8).toString('hex'),
        name: u.portNameFilter,
        portName: u.portNameFilter,
        login,
        password: '', // Not stored in plaintext
        passwordHash: u.passwordHash,
        contact: '',
        notes: 'Auto-migrated from .env',
        billingType: 'per_gb',
        price: 23,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      console.log(`  Auto-migrated user ${login} -> client "${u.portNameFilter}"`);
    }
  }
}
saveClients(clients);
rebuildClientMaps();

for (const c of clients) {
  if (c.login && c.portName && (c.passwordHash || c.password)) {
    users[c.login] = {
      passwordHash: c.passwordHash || bcrypt.hashSync(c.password, 10),
      portNameFilter: c.portName,
      source: 'client',
      clientId: c.id
    };
  }
}
console.log(`Loaded ${Object.keys(users).length} user(s): ${Object.keys(users).join(', ')}`);
console.log(`  - ${clients.length} client(s) from SQLite`);
rebuildClientMaps();

// ==================== SESSIONS — SQLite-backed ====================
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSession(token) {
  if (!token) return null;
  return dbStmts.getSession.get(token, Date.now()) || null;
}

function createSession(token, login, portNameFilter, isAdmin, expiresAt) {
  dbStmts.insertSession.run(token, login, portNameFilter || '', isAdmin ? 1 : 0, expiresAt);
}

function deleteSession(token) {
  if (token) dbStmts.deleteSession.run(token);
}

function deleteSessionsByLogin(login) {
  dbStmts.deleteSessionsByLogin.run(login);
}

function getSessionCount() {
  return dbStmts.countSessions.get(Date.now()).cnt;
}

// TASK-13: Store interval refs for graceful shutdown
const _intervals = [];
_intervals.push(setInterval(() => {
  const result = dbStmts.cleanExpiredSessions.run(Date.now());
  if (result.changes > 0) {
    console.log(`[Sessions] Cleaned ${result.changes} expired session(s)`);
  }
}, 60 * 60 * 1000));

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }

// ==================== SETTINGS ====================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let appSettings = {
  speedtest_times: ['02:00', '14:00'],
  pricing_tiers: [
    { min_proxies: 1, price: 30, label: '1-4 прокси' },
    { min_proxies: 5, price: 25, label: '5-9 прокси' },
    { min_proxies: 10, price: 23, label: '10-19 прокси' },
    { min_proxies: 20, price: 20, label: '20+ прокси' }
  ]
};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    appSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load settings:', e.message); }

function saveSettings() {
  safeWriteFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
}

// ==================== PRICING TIERS ====================
function getPriceForProxyCount(count) {
  const tiers = appSettings.pricing_tiers || [];
  // Sort descending by min_proxies to find the right tier
  const sorted = tiers.slice().sort((a, b) => b.min_proxies - a.min_proxies);
  for (const tier of sorted) {
    if (count >= tier.min_proxies) return tier.price;
  }
  return tiers.length > 0 ? tiers[0].price : 23; // fallback
}

// ==================== BANDWIDTH PARSING UTILS ====================
// BUG-01: parseBwToBytes was duplicate of parseTrafficValue — consolidated
const parseBwToBytes = parseTrafficValue;

function computeClientMonthBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_month_out);
        }
      }
    }
  }
  return totalBytes;
}

function computeClientYesterdayBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_yesterday_out);
        }
      }
    }
  }
  return totalBytes;
}

function computeClientPrevMonthBytes(allServerResults, portName) {
  let totalBytes = 0;
  for (const data of allServerResults) {
    if (typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          totalBytes += parseBwToBytes(b.bandwidth_bytes_prevmonth_in);
          totalBytes += parseBwToBytes(b.bandwidth_bytes_prevmonth_out);
        }
      }
    }
  }
  return totalBytes;
}

// Sum stored daily_traffic bytes for a client over a month (e.g. "2026-03")
function getClientStoredMonthBytes(clientPortName, monthPrefix) {
  let totalBytes = 0;
  for (const [portKey, days] of Object.entries(dailyTraffic)) {
    // Match by portName from stored data or global mapping
    const firstDay = Object.values(days)[0];
    const pn = (firstDay && firstDay.portName) || portKeyToPortName[portKey] || '';
    if (pn !== clientPortName) continue;
    for (const [date, entry] of Object.entries(days)) {
      if (!date.startsWith(monthPrefix)) continue;
      totalBytes += (entry.in || 0) + (entry.out || 0);
    }
  }
  return totalBytes;
}

function getClientCachedServers(allServerResults, portName) {
  const cachedServers = [];
  for (const data of allServerResults) {
    if (data._cached && typeof data.bw === 'object') {
      for (const [portId, b] of Object.entries(data.bw)) {
        if (b.portName === portName) {
          cachedServers.push(data.serverName);
          break;
        }
      }
    }
  }
  return cachedServers;
}

// ==================== DOCUMENTS DIR ====================
const DOCUMENTS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for login endpoint (SEC-03: anti-bruteforce)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 attempts per IP per window
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false
});

// SEC-03: Rate limiting for reset_ip_by_token (public endpoint)
const resetTokenLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 attempts per IP per minute
  message: { error: 'Too many requests, try again in 1 minute' },
  standardHeaders: true,
  legacyHeaders: false
});

// TASK-12: Rate limiting for check_proxy (heavy network ops)
const checkProxyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // max 5 batch checks per IP per minute
  message: { error: 'Too many proxy check requests, try again in 1 minute' },
  standardHeaders: true,
  legacyHeaders: false
});

// ==================== AUTH ====================

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const sess = getSession(token);
  if (!sess) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = sess;
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// TASK-H: Health-check endpoint (no auth required)
// TASK-22: Expanded /health endpoint with DB stats and ledger info
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const ledgerEntryCount = Object.values(billingLedger).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  const dbSize = fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) : 0;
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    clients: clients.length,
    sessions: getSessionCount(),
    servers: apiServers.length,
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024)
    },
    database: {
      size_kb: dbSize,
      ledger_entries: ledgerEntryCount,
      wal_mode: true
    },
    billing: lastBillingRunSummary || { last_run: null },
    reconciliation: { last_month: lastReconciliationMonth || null },
    intervals: _intervals.length,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const user = users[login];
  if (!user) return res.status(401).json({ error: 'Invalid login or password' });
  // SEC-01: bcrypt comparison
  const passwordValid = user.passwordHash
    ? await bcrypt.compare(password, user.passwordHash)
    : (user.password === password); // fallback for un-migrated
  if (!passwordValid) return res.status(401).json({ error: 'Invalid login or password' });
  const token = generateToken();
  const isAdmin = user.portNameFilter === '*';
  createSession(token, login, user.portNameFilter, isAdmin, Date.now() + SESSION_TTL);
  // Log client logins (not admin)
  if (!isAdmin) {
    auditLog(login, 'client_login', { ip: getClientIp(req), portNameFilter: user.portNameFilter });
  }
  res.json({ token, login, isAdmin });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  deleteSession(token);
  res.json({ ok: true });
});

// Admin: impersonate client (create session as client)
app.post('/api/admin/impersonate/:id', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const user = users[client.login];
  if (!user) return res.status(400).json({ error: 'Client user not found' });
  const token = generateToken();
  createSession(token, client.login, user.portNameFilter, false, Date.now() + SESSION_TTL);
  res.json({ ok: true, token, login: client.login });
});

// ==================== ProxySmart API helpers ====================

// OPT-05: Extract server name from prefixed ID (e.g., "S1_port123" → "S1")
function extractServerName(prefixedId) {
  return apiServers.map(s => s.name).find(n => prefixedId.startsWith(n + '_')) || '';
}

// BUG-05: Detect protocol from URL to use http or https
function getHttpLib(url) {
  return url.protocol === 'https:' ? https : http;
}

function fetchApi(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function fetchApiRaw(server, apiPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
      timeout
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: proxyRes.headers['content-type'] || '' }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.end();
  });
}

function postApi(server, apiPath, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(postData);
    req.end();
  });
}

function postFormApi(server, apiPath, formData, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData)
      },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(formData);
    req.end();
  });
}

function findServer(serverName) {
  return apiServers.find(s => s.name === serverName);
}

// ==================== DATA FETCHING & MERGING ====================

// ===== SERVER DATA CACHE =====
// Preserves modem data + traffic when a server goes down temporarily
const SERVER_CACHE_FILE = path.join(__dirname, 'server_cache.json');
let serverCache = {};
try {
  if (fs.existsSync(SERVER_CACHE_FILE)) {
    serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
    console.log(`Loaded server cache: ${Object.keys(serverCache).length} server(s) cached`);
  }
} catch (e) { console.error('Failed to load server_cache:', e.message); }

function saveServerCache() {
  safeWriteFile(SERVER_CACHE_FILE, JSON.stringify(serverCache));
}

function cacheServerData(data) {
  serverCache[data.serverName] = {
    bw: data.bw,
    status: data.status,
    ports: data.ports,
    serverName: data.serverName,
    cachedAt: Date.now()
  };
  saveServerCache();
}

// When server is down, mark all modems as offline but keep bandwidth + ports
function getCachedDataAsOffline(serverName) {
  const cached = serverCache[serverName];
  if (!cached) return null;

  const ageMinutes = Math.round((Date.now() - cached.cachedAt) / 60000);
  console.log(`[Cache] Using cached data for ${serverName} (${ageMinutes} min old)`);

  // Mark all modems in status as offline + _cached flag
  let offlineStatus = [];
  if (Array.isArray(cached.status)) {
    offlineStatus = cached.status.map(m => {
      const copy = JSON.parse(JSON.stringify(m));
      if (copy.net_details) {
        copy.net_details.IS_ONLINE = 'no';
      }
      copy._cached = true;
      copy._cachedAt = cached.cachedAt;
      return copy;
    });
  }

  return {
    bw: cached.bw || {},
    status: offlineStatus,
    ports: cached.ports || {},
    serverName: serverName,
    _cached: true,
    _cachedAt: cached.cachedAt
  };
}

// ==================== AUTO_IP_ROTATION cache (from ProxySmart /conf/edit/) ====================
const modemRotationCache = {}; // { "S1:IMEI" -> minutes }
let rotationCacheUpdatedAt = 0;
const ROTATION_CACHE_TTL = 5 * 60 * 1000; // refresh every 5 min

async function refreshRotationCache() {
  for (const server of apiServers) {
    try {
      let statusData;
      try { statusData = await fetchApi(server, '/apix/show_status_json'); } catch (e) {
        console.log(`[Rotation] ${server.name} status fetch failed: ${e.message}`);
        continue;
      }
      const modems = Array.isArray(statusData) ? statusData : [];
      if (modems.length === 0) { console.log(`[Rotation] ${server.name}: 0 modems, skipping`); continue; }
      let fetched = 0;
      // Fetch sequentially to avoid hammering the server
      for (const m of modems) {
        const imei = m.modem_details?.IMEI;
        if (!imei) continue;
        try {
          const raw = await fetchApiRaw(server, `/conf/edit/${imei}`);
          const html = raw.buffer ? raw.buffer.toString('utf8') : String(raw);
          const match = html.match(/AUTO_IP_ROTATION[^>]*value="(\d*)"/);
          const mins = match && match[1] ? parseInt(match[1]) : 0;
          modemRotationCache[server.name + ':' + imei] = mins;
          fetched++;
        } catch (e) { /* skip */ }
      }
      console.log(`[Rotation] ${server.name}: fetched ${fetched}/${modems.length} modems`);
    } catch (e) { console.log(`[Rotation] Failed for ${server.name}: ${e.message}`); }
  }
  rotationCacheUpdatedAt = Date.now();
  const total = Object.keys(modemRotationCache).length;
  console.log(`[Rotation] Total cached: ${total} modem rotation values`);
}

// Inject AUTO_IP_ROTATION into status data
function injectRotationData(result) {
  const statusArr = Array.isArray(result.status) ? result.status : [];
  for (const m of statusArr) {
    const imei = m.modem_details?.IMEI;
    if (!imei) continue;
    const key = result.serverName + ':' + imei;
    if (modemRotationCache[key] !== undefined) {
      m.modem_details.AUTO_IP_ROTATION = String(modemRotationCache[key]);
    }
  }
}

async function fetchServerData(server) {
  const [bw, status, ports] = await Promise.all([
    fetchApi(server, '/apix/bandwidth_report_all'),
    fetchApi(server, '/apix/show_status_json'),
    fetchApi(server, '/apix/list_ports_json')
  ]);
  const result = { bw, status, ports, serverName: server.name };
  // Inject rotation data from cache
  injectRotationData(result);
  // Cache successful response
  cacheServerData(result);
  return result;
}

// Refresh rotation cache on startup and periodically
setTimeout(() => refreshRotationCache(), 10000);
setInterval(() => refreshRotationCache(), ROTATION_CACHE_TTL);

// ==================== ROTATION LOG SYNC (ProxySmart → SQLite) ====================
const ROTATION_LOG_SYNC_INTERVAL = 30 * 60 * 1000; // every 30 min
async function syncAllRotationLogs() {
  let totalSynced = 0;
  for (const server of apiServers) {
    try {
      const statusData = await fetchApi(server, '/apix/show_status_json');
      const modems = Array.isArray(statusData) ? statusData : [];
      for (const m of modems) {
        const nick = m.modem_details?.NICK || m.modem_details?.name || m.modem_details?.IMEI;
        if (!nick) continue;
        try {
          const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
          const entries = Array.isArray(result) ? result : (result?.log || result?.logs || result?.data || []);
          if (entries.length) {
            syncRotationLog(server.name, nick, entries);
            totalSynced += entries.length;
          }
        } catch (e) { /* skip individual modem */ }
      }
    } catch (e) {
      console.log(`[RotLogSync] ${server.name} failed: ${e.message}`);
    }
  }
  console.log(`[RotLogSync] Synced ${totalSynced} rotation entries across all servers`);
}
// Initial sync after 30 sec, then every 30 min
setTimeout(() => syncAllRotationLogs().catch(e => console.error('[RotLogSync]', e.message)), 30000);
setInterval(() => syncAllRotationLogs().catch(e => console.error('[RotLogSync]', e.message)), ROTATION_LOG_SYNC_INTERVAL);

// Fetch data from all servers; use cache for unreachable ones
async function fetchAllServersData() {
  const settled = await Promise.allSettled(apiServers.map(s => fetchServerData(s)));
  const results = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      const data = settled[i].value;
      updateKnownModems(data);   // remember modems we've seen
      injectOfflineModems(data); // add back missing modems as offline
      results.push(data);
    } else {
      const srvName = apiServers[i].name;
      console.log(`[API] Server ${srvName} unreachable: ${settled[i].reason?.message || 'unknown'}`);
      // Try to use cached data
      const cached = getCachedDataAsOffline(srvName);
      if (cached) {
        injectOfflineModems(cached); // add back missing modems as offline
        results.push(cached);
      } else {
        console.log(`[API] No cache available for ${srvName}`);
      }
    }
  }
  return results;
}

// TASK-D: In-memory cache for fetchAllServersData (TTL 10s + in-flight dedup)
let _psCache = null;
let _psCacheTs = 0;
let _psFetchPromise = null;
const PS_CACHE_TTL = 10 * 1000;

async function fetchAllServersDataCached() {
  if (_psCache && (Date.now() - _psCacheTs) < PS_CACHE_TTL) return _psCache;
  if (_psFetchPromise) return _psFetchPromise;
  _psFetchPromise = fetchAllServersData()
    .then(r => { _psCache = r; _psCacheTs = Date.now(); _psFetchPromise = null; return r; })
    .catch(e => { _psFetchPromise = null; throw e; });
  return _psFetchPromise;
}

function filterByPortName(data, portNameFilter) {
  const { bw, status, ports } = data;
  const allowedPortIds = new Set();
  const allowedImeis = new Set();
  let filteredBw = {};
  if (typeof bw === 'object') {
    for (const [portId, b] of Object.entries(bw)) {
      if (b.portName === portNameFilter) { filteredBw[portId] = b; allowedPortIds.add(portId); }
    }
  }
  if (ports && typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (Array.isArray(portList)) {
        for (const p of portList) { if (p.portID && allowedPortIds.has(p.portID)) allowedImeis.add(imei); }
      }
    }
  }
  let filteredStatus = [];
  if (Array.isArray(status)) {
    filteredStatus = status.filter(m => { const imei = m.modem_details?.IMEI; return imei && allowedImeis.has(imei); });
  }
  let filteredPorts = {};
  if (typeof ports === 'object') {
    for (const [imei, portList] of Object.entries(ports)) {
      if (allowedImeis.has(imei) && Array.isArray(portList)) {
        const filtered = portList.filter(p => allowedPortIds.has(p.portID));
        if (filtered.length > 0) filteredPorts[imei] = filtered;
      }
    }
  }
  return { bw: filteredBw, status: filteredStatus, ports: filteredPorts };
}

function mergeServerData(allData, portNameFilter) {
  const mergedBw = {}, mergedStatus = [], mergedPorts = {};
  const cachedServers = [];
  for (const data of allData) {
    const filtered = portNameFilter === '*' ? data : filterByPortName(data, portNameFilter);
    const prefix = data.serverName + '_';
    const isCached = !!data._cached;
    if (isCached) cachedServers.push({ name: data.serverName, cachedAt: data._cachedAt });
    for (const [portId, b] of Object.entries(filtered.bw)) {
      mergedBw[prefix + portId] = { ...b, _server: data.serverName, _cached: isCached };
    }
    const statusArr = Array.isArray(filtered.status) ? filtered.status : [];
    for (const m of statusArr) {
      // Skip ghost entries from deleted ports (no STATE, no proxy_creds)
      // But allow rebooting modems and offline-injected modems through
      if (!m.STATE || m.STATE === '?') {
        if (m.IS_REBOOTING !== 'true' && !m._offline) continue;
      }
      const entry = { ...m, _server: data.serverName };
      if (isCached) entry._cached = true;
      if (entry.modem_details && entry.modem_details.IMEI) {
        entry.modem_details = { ...entry.modem_details, IMEI: prefix + entry.modem_details.IMEI };
      }
      mergedStatus.push(entry);
    }
    const portsObj = typeof filtered.ports === 'object' ? filtered.ports : {};
    for (const [imei, portList] of Object.entries(portsObj)) {
      const prefixedImei = prefix + imei;
      const filteredPortList = portList;
      const prefixedPorts = filteredPortList.map(p => ({ ...p, portID: p.portID ? prefix + p.portID : p.portID, _server: data.serverName, _cached: isCached }));
      if (prefixedPorts.length > 0) mergedPorts[prefixedImei] = (mergedPorts[prefixedImei] || []).concat(prefixedPorts);
    }
  }

  // Ensure every modem in ports has a status entry (handles modems present in bw/ports but missing from status during reboot)
  const statusImeis = new Set(mergedStatus.map(m => m.modem_details ? m.modem_details.IMEI : null).filter(Boolean));
  for (const [imei, portList] of Object.entries(mergedPorts)) {
    if (statusImeis.has(imei)) continue;
    // Find server name and nick from port data or knownModems
    const srv = (portList[0] && portList[0]._server) || '';
    const rawImei = imei.replace(/^S\d+_/, '');
    let nick = '', model = '';
    const km = knownModems[srv];
    if (km) {
      for (const info of Object.values(km)) {
        if (info.imei === rawImei) { nick = info.nick || ''; model = info.model || ''; break; }
      }
    }
    mergedStatus.push({
      modem_details: { IMEI: imei, NICK: nick, MODEL_SHOWN: model, MODEL: model },
      net_details: { IS_ONLINE: 'no', EXT_IP: '', CELLOP: '', CurrentNetworkType: '' },
      _server: srv,
      _offline: true
    });
  }

  return { bandwidth: mergedBw, status: mergedStatus, ports: mergedPorts, modemLogins, cachedServers };
}

// ==================== IP TRACKING & UPTIME TRACKING — SQLite-backed ====================

const MAX_IP_HISTORY = 100;

// Load IP tracking from SQLite
let ipTracking = {};
try {
  const rows = db.prepare('SELECT key, ip, updated_at FROM ip_tracking').all();
  for (const r of rows) ipTracking[r.key] = { ip: r.ip, since: r.updated_at };
  if (rows.length > 0) console.log(`[SQLite] Loaded ${rows.length} IP tracking entries`);
} catch (e) { console.error('Failed to load ip_tracking from SQLite:', e.message); }

// Load uptime tracking from SQLite
let uptimeTracking = {};
try {
  const rows = db.prepare('SELECT key, data FROM uptime_tracking').all();
  for (const r of rows) { try { uptimeTracking[r.key] = JSON.parse(r.data); } catch (e) {} }
  if (rows.length > 0) console.log(`[SQLite] Loaded ${rows.length} uptime tracking entries`);
} catch (e) { console.error('Failed to load uptime_tracking from SQLite:', e.message); }

// Load IP history from SQLite (with db_id for incremental updates)
let ipHistory = {};
try {
  const rows = db.prepare('SELECT id, key, ip, started_at, ended_at FROM ip_history ORDER BY id ASC').all();
  for (const r of rows) {
    if (!ipHistory[r.key]) ipHistory[r.key] = [];
    ipHistory[r.key].push({ db_id: r.id, ip: r.ip, from: r.started_at, to: r.ended_at || null });
  }
  if (rows.length > 0) console.log(`[SQLite] Loaded ${rows.length} IP history entries`);
} catch (e) { console.error('Failed to load ip_history from SQLite:', e.message); }

const _ipUpsert = db.prepare('INSERT OR REPLACE INTO ip_tracking (key, ip, updated_at) VALUES (?, ?, ?)');
const _utUpsert = db.prepare('INSERT OR REPLACE INTO uptime_tracking (key, data) VALUES (?, ?)');
const _ihInsert = db.prepare('INSERT INTO ip_history (key, ip, started_at, ended_at) VALUES (?, ?, ?, ?)');
const _ihUpdateEnd = db.prepare('UPDATE ip_history SET ended_at = ? WHERE id = ?');
const _ihDeleteById = db.prepare('DELETE FROM ip_history WHERE id = ?');

function saveIpTracking() {
  try {
    const batch = db.transaction(() => {
      for (const [key, data] of Object.entries(ipTracking)) {
        _ipUpsert.run(key, data.ip || '', data.since || '');
      }
    });
    batch();
  } catch (e) { console.error('[saveIpTracking] SQLite error:', e.message); }
}

function saveUptimeTracking() {
  try {
    const batch = db.transaction(() => {
      for (const [key, data] of Object.entries(uptimeTracking)) {
        _utUpsert.run(key, JSON.stringify(data));
      }
    });
    batch();
  } catch (e) { console.error('[saveUptimeTracking] SQLite error:', e.message); }
}

// BUG-02: Incremental saveIpHistory — only save entries without db_id (fallback/edge case)
function saveIpHistory() {
  try {
    db.transaction(() => {
      for (const [key, entries] of Object.entries(ipHistory)) {
        for (const e of entries) {
          if (!e.db_id) {
            const result = _ihInsert.run(key, e.ip || '', e.from || '', e.to || '');
            e.db_id = result.lastInsertRowid;
          }
        }
      }
    })();
  } catch (e) { console.error('[saveIpHistory] SQLite error:', e.message); }
}

// BUG-02: recordIpChange — direct incremental DB writes (no full rewrite)
function recordIpChange(key, oldIp, newIp, timestamp) {
  if (!ipHistory[key]) ipHistory[key] = [];
  const entries = ipHistory[key];
  // Close previous entry
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    if (!last.to) {
      last.to = timestamp;
      if (last.db_id) _ihUpdateEnd.run(timestamp, last.db_id);
    }
  }
  // Add new entry with direct INSERT
  const result = _ihInsert.run(key, newIp, timestamp, '');
  entries.push({ db_id: result.lastInsertRowid, ip: newIp, from: timestamp, to: null });
  // Trim to MAX_IP_HISTORY
  if (entries.length > MAX_IP_HISTORY) {
    const toDelete = entries.slice(0, entries.length - MAX_IP_HISTORY);
    for (const e of toDelete) {
      if (e.db_id) _ihDeleteById.run(e.db_id);
    }
    ipHistory[key] = entries.slice(-MAX_IP_HISTORY);
  }
}

// Combined tracking: IP changes + uptime percentage (runs every 5 min)
// Uptime fix: skip rotating/rebooting modems, skip unreachable servers
async function trackModems() {
  const now = Date.now();
  let totalTracked = 0;

  for (const server of apiServers) {
    let statusArr;
    try {
      const data = await fetchServerData(server);
      statusArr = Array.isArray(data.status) ? data.status : [];
    } catch (e) {
      // Server unreachable -- skip all modems on this server (don't count as offline)
      console.log(`[Tracking] Server ${server.name} unreachable, skipping: ${e.message}`);
      continue;
    }

    const prefix = server.name + '_';

    for (const m of statusArr) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      const key = prefix + imei;
      const extIp = m.net_details?.EXT_IP || '';
      const isOnline = m.net_details?.IS_ONLINE === 'yes';
      const isRotating = m.IS_ROTATED === 'true' || m.IS_ROTATED === true;
      const isRebooting = m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true;

      // IP tracking (always, regardless of status)
      if (extIp && extIp !== 'IP_RESET') {
        if (!ipTracking[key]) {
          ipTracking[key] = { ip: extIp, since: now };
          // Record initial IP in history
          recordIpChange(key, null, extIp, now);
        } else if (ipTracking[key].ip !== extIp) {
          // IP changed! Record in history with timestamp
          recordIpChange(key, ipTracking[key].ip, extIp, now);
          ipTracking[key] = { ip: extIp, since: now };
        }
        // else same IP -- keep existing `since`
      }

      // Uptime tracking -- skip if rotating, rebooting, or IP is resetting
      if (isRotating || isRebooting || extIp === 'IP_RESET' || extIp === '') {
        continue;
      }

      if (!uptimeTracking[key]) {
        uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, consecutive_failures: 0, daily: {} };
      }
      if (!uptimeTracking[key].consecutive_failures) uptimeTracking[key].consecutive_failures = 0;
      if (!uptimeTracking[key].daily) uptimeTracking[key].daily = {};

      // Daily bucket for 30-day uptime
      const todayBucket = new Date().toLocaleDateString('en-CA');
      if (!uptimeTracking[key].daily[todayBucket]) uptimeTracking[key].daily[todayBucket] = { online: 0, total: 0 };

      if (isOnline) {
        uptimeTracking[key].consecutive_failures = 0;
        uptimeTracking[key].total_checks++;
        uptimeTracking[key].online_checks++;
        uptimeTracking[key].daily[todayBucket].total++;
        uptimeTracking[key].daily[todayBucket].online++;
      } else {
        uptimeTracking[key].consecutive_failures++;
        if (uptimeTracking[key].consecutive_failures >= 3) {
          uptimeTracking[key].total_checks++;
          uptimeTracking[key].daily[todayBucket].total++;
          // don't increment online = downtime
        } else {
          uptimeTracking[key].total_checks++;
          uptimeTracking[key].online_checks++;
          uptimeTracking[key].daily[todayBucket].total++;
          uptimeTracking[key].daily[todayBucket].online++;
        }
      }

      // Prune daily buckets older than 35 days
      const cutoffPrune = new Date(now - 35 * 86400000).toLocaleDateString('en-CA');
      for (const d of Object.keys(uptimeTracking[key].daily)) {
        if (d < cutoffPrune) delete uptimeTracking[key].daily[d];
      }

      totalTracked++;
    }
  }

  saveIpTracking();
  saveUptimeTracking();
  // BUG-02: saveIpHistory() removed — recordIpChange() now does direct DB writes
  console.log(`[Tracking] Updated IP & uptime for ${Object.keys(ipTracking).length} modems (${totalTracked} uptime checks)`);
}

// ==================== SPEEDTEST HISTORY ====================

const SPEEDTEST_HISTORY_FILE = path.join(__dirname, 'speedtest_history.json');
const MAX_SPEEDTEST_ENTRIES = 30;

let speedtestHistory = {};
try {
  if (fs.existsSync(SPEEDTEST_HISTORY_FILE)) {
    speedtestHistory = JSON.parse(fs.readFileSync(SPEEDTEST_HISTORY_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load speedtest_history:', e.message); }

function saveSpeedtestHistory() {
  safeWriteFile(SPEEDTEST_HISTORY_FILE, JSON.stringify(speedtestHistory, null, 2));
}

let speedtestRunning = false;

// BUG-03: Extract speedtest result parsing (was duplicated in test + retry)
function parseSpeedtestResult(result) {
  let dl = 0, ul = 0, ping = 0;
  if (result && typeof result === 'object') {
    dl = parseFloat(result.download || result.Download || result.dl || 0);
    ul = parseFloat(result.upload || result.Upload || result.ul || 0);
    ping = parseFloat(result.ping || result.Ping || result.latency || 0);
    if (result.raw && typeof result.raw === 'string') {
      const dlMatch = result.raw.match(/download[:\s]*([\d.]+)/i);
      const ulMatch = result.raw.match(/upload[:\s]*([\d.]+)/i);
      const pingMatch = result.raw.match(/ping[:\s]*([\d.]+)/i);
      if (dlMatch) dl = parseFloat(dlMatch[1]);
      if (ulMatch) ul = parseFloat(ulMatch[1]);
      if (pingMatch) ping = parseFloat(pingMatch[1]);
    }
  }
  return { dl, ul, ping };
}

function pushSpeedtestEntry(key, entry) {
  if (!speedtestHistory[key]) speedtestHistory[key] = [];
  speedtestHistory[key].push(entry);
  if (speedtestHistory[key].length > MAX_SPEEDTEST_ENTRIES) {
    speedtestHistory[key] = speedtestHistory[key].slice(-MAX_SPEEDTEST_ENTRIES);
  }
  saveSpeedtestHistory();
}

async function runNightlySpeedtests() {
  if (speedtestRunning) {
    console.log('[Speedtest] Already running, skipping...');
    return;
  }
  speedtestRunning = true;
  console.log('[Speedtest] Starting speedtest run...');
  let testedCount = 0, errorCount = 0;

  try {
    for (const server of apiServers) {
      try {
        const statusData = await fetchApi(server, '/apix/show_status_json');
        const modems = Array.isArray(statusData) ? statusData : [];
        console.log(`[Speedtest] ${server.name}: ${modems.length} modems to test`);

        for (const m of modems) {
          const nick = m.modem_details?.NICK;
          const imei = m.modem_details?.IMEI;
          const isOnline = m.net_details?.IS_ONLINE === 'yes';
          if (!nick || !imei || !isOnline) continue;

          const key = server.name + '_' + imei;
          try {
            console.log(`[Speedtest] Testing ${nick} (${server.name})...`);
            const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
            const { dl, ul, ping } = parseSpeedtestResult(result);

            const entry = { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result };

            // Re-test if DL or UL is below 1 Mbps
            if (dl < 1 || ul < 1) {
              console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} — near-zero detected, re-testing in 10 min...`);
              setTimeout(async () => {
                try {
                  console.log(`[Speedtest] Re-testing ${nick} (${server.name})...`);
                  const retryResult = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
                  const r = parseSpeedtestResult(retryResult);
                  if (r.dl + r.ul > dl + ul) {
                    pushSpeedtestEntry(key, { date: new Date().toISOString(), download: r.dl, upload: r.ul, ping: r.ping, raw: retryResult, retry: true, ...(r.dl < 1 || r.ul < 1 ? { _lowSpeed: true } : {}) });
                    console.log(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (improved)`);
                  } else {
                    console.log(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (not improved)`);
                  }
                } catch (e) { console.error(`[Speedtest] Re-test ${nick} error:`, e.message); }
              }, 10 * 60 * 1000);
            }

            pushSpeedtestEntry(key, entry);
            testedCount++;
            console.log(`[Speedtest] ${nick}: DL=${dl} UL=${ul} Ping=${ping}`);
          } catch (e) {
            console.error(`[Speedtest] Error testing ${nick}:`, e.message);
            errorCount++;
          }

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        console.error(`[Speedtest] Error on server ${server.name}:`, e.message);
        errorCount++;
      }
    }
  } finally {
    speedtestRunning = false;
  }

  console.log(`[Speedtest] Complete: ${testedCount} tested, ${errorCount} errors`);
}

function getSpeedtestLatest() {
  const latest = {};
  for (const [key, entries] of Object.entries(speedtestHistory)) {
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      latest[key] = { download: last.download, upload: last.upload, ping: last.ping, date: last.date, ...(last._lowSpeed ? { _lowSpeed: true } : {}) };
    }
  }
  return latest;
}

// ==================== CLIENT DASHBOARD API ====================

app.get('/api/dashboard_data', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clientByLogin.get(req.user.login);
    if (clientInfo) {
      const totalPayments = (clientInfo.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Current month expense from billing ledger
      const ledgerEntries = billingLedger[clientInfo.id] || [];
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.cost || 0), 0);

      // Live month traffic from ProxySmart
      let liveMonthBytes = 0;
      for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_in);
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_out);
      }
      const liveMonthGb = trafficBytesToGb(liveMonthBytes);

      // Billed month GB from ledger (for comparison)
      const billedMonthGb = ledgerEntries
        .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.delta_gb || 0), 0);

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        liveMonthGb,
        billedMonthGb: Math.round(billedMonthGb * 1000) / 1000,
        apiKey: clientInfo.apiKey || ''
      };
    }

    // Include tracking data filtered for this user's modems
    if (req.user.portNameFilter !== '*') {
      const filteredIpTracking = {};
      const filteredUptimeTracking = {};
      const filteredSpeedtest = {};
      const filteredIpHistory = {};
      const speedLatest = getSpeedtestLatest();

      const clientImeis = new Set();
      for (const imei of Object.keys(merged.ports)) {
        clientImeis.add(imei);
      }

      const cutoff30 = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA');

      for (const imei of clientImeis) {
        if (ipTracking[imei]) filteredIpTracking[imei] = ipTracking[imei];
        if (uptimeTracking[imei]) {
          const ut = uptimeTracking[imei];
          // Compute 30-day uptime from daily buckets
          let online30 = 0, total30 = 0;
          for (const [date, bucket] of Object.entries(ut.daily || {})) {
            if (date >= cutoff30) { online30 += bucket.online; total30 += bucket.total; }
          }
          filteredUptimeTracking[imei] = {
            total_checks: ut.total_checks,
            online_checks: ut.online_checks,
            first_check: ut.first_check,
            uptime30d: total30 > 0 ? Math.round(online30 / total30 * 1000) / 10 : null
          };
        }
        if (speedLatest[imei]) filteredSpeedtest[imei] = speedLatest[imei];
        if (ipHistory[imei]) filteredIpHistory[imei] = ipHistory[imei];
      }

      merged.ipTracking = filteredIpTracking;
      merged.uptimeTracking = filteredUptimeTracking;
      merged.speedtestLatest = filteredSpeedtest;
      merged.ipHistory = filteredIpHistory;
    }

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== CLIENT: DAILY TRAFFIC HISTORY ====================

app.get('/api/client/daily_traffic', authMiddleware, async (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  const portNameFilter = clientInfo.portName || req.user.portNameFilter;
  const fromDate = req.query.from || '';
  const toDate = req.query.to || '';
  const includeToday = req.query.include_today === '1';
  const result = {};

  // Use global portKey→portName mapping (refreshed by billing)
  // Fallback: refresh from cache if mapping is empty
  if (Object.keys(portKeyToPortName).length === 0) {
    try {
      const cachedResults = await fetchAllServersDataCached();
      refreshPortKeyMapping(cachedResults);
    } catch (e) { /* cache may not be ready yet */ }
  }
  const portNameMap = portKeyToPortName;

  // Collect daily traffic for ports matching this client's portName
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    let match = false;
    if (portNameFilter === '*') {
      match = true;
    } else {
      const firstDay = Object.values(days)[0];
      const pn = (firstDay && firstDay.portName) || portNameMap[portId] || portId;
      if (pn === portNameFilter) match = true;
    }
    if (match) {
      // Filter by date range
      const filtered = {};
      for (const [d, entry] of Object.entries(days)) {
        if (fromDate && d < fromDate) continue;
        if (toDate && d > toDate) continue;
        filtered[d] = entry;
      }
      if (Object.keys(filtered).length > 0) {
        result[portId] = filtered;
      }
    }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

  if (includeToday) {
    // Add today's live data from ProxySmart
    try {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, portNameFilter);
      const todayData = {};
      for (const [portId, b] of Object.entries(merged.bandwidth || {})) {
        const dIn = parseTrafficValue(b.bandwidth_bytes_day_in);
        const dOut = parseTrafficValue(b.bandwidth_bytes_day_out);
        if (dIn > 0 || dOut > 0) {
          todayData[portId] = { in: dIn, out: dOut, portName: b.portName || '' };
        }
      }
      res.json({ daily: result, today: todayData, todayDate: today });
    } catch (err) {
      res.json({ daily: result, today: {}, todayDate: today });
    }
  } else {
    res.json({ daily: result, today: {}, todayDate: today });
  }
});

// ==================== CLIENT: BILLING HISTORY ====================

app.get('/api/billing_history', authMiddleware, (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  const entries = billingLedger[clientInfo.id] || [];

  // Optional filters
  const { month, limit: limitStr } = req.query;
  let filtered = entries;

  // Filter by month (e.g. "2026-02")
  if (month) {
    filtered = filtered.filter(e => e.date && e.date.startsWith(month));
  }

  // Sort newest first
  filtered = filtered.slice().sort((a, b) => (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''));

  // Limit results
  const limit = parseInt(limitStr) || 200;
  filtered = filtered.slice(0, limit);

  // Summary: payments, charges, adjustments
  const allEntries = entries;
  const totalCharges = allEntries.filter(e => e.type === 'charge').reduce((sum, e) => sum + (e.cost || 0), 0);
  const totalPayments = allEntries.filter(e => e.type === 'payment').reduce((sum, e) => sum + (e.amount || 0), 0);

  // Current month summary
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const monthCharges = allEntries
    .filter(e => e.type === 'charge' && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + (e.cost || 0), 0);

  // Average daily charge over last 7 days: sum charges for days [today-7 .. today-1] / 7
  const today = getMoscowToday(); // "YYYY-MM-DD"
  const d7 = getMoscowNow();
  d7.setDate(d7.getDate() - 7);
  const sevenDaysAgoStr = d7.toLocaleDateString('en-CA'); // exclusive lower bound
  const last7dTotal = allEntries
    .filter(e => e.type === 'charge' && e.date && e.date > sevenDaysAgoStr && e.date < today)
    .reduce((sum, e) => sum + (e.cost || 0), 0);
  const avgDailyCharge7d = Math.round((last7dTotal / 7) * 100) / 100;

  res.json({
    balance: clientInfo.balance,
    currency: clientInfo.currency || 'RUB',
    summary: {
      totalCharges: Math.round(totalCharges * 100) / 100,
      totalPayments: Math.round(totalPayments * 100) / 100,
      monthCharges: Math.round(monthCharges * 100) / 100,
      avgDailyCharge7d,
      daysUntilZero: avgDailyCharge7d > 0 ? Math.floor(clientInfo.balance / avgDailyCharge7d) : null
    },
    // OLD-01 fix: strip internal db_id from API response
    entries: filtered.map(({ db_id, ...e }) => e)
  });
});

// ==================== CLIENT: IP RESET (non-admin) ====================

app.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    const success = result && result.result === 'success';
    auditLog(req.user.login, 'client_reset_ip', { imei, serverName, ip: getClientIp(req), success });
    if (success) {
      res.json({ ok: true, result });
    } else {
      res.json({ ok: false, error: result?.message || 'Reset failed', result });
    }
  } catch (err) { res.status(502).json({ ok: false, error: 'Reset failed', details: err.message }); }
});

// ==================== CLIENT: TOKEN-BASED IP RESET (public, no session) ====================

app.get('/api/client/reset_ip_by_token', resetTokenLimiter, async (req, res) => {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  const client = clientByResetToken.get(token);
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
});

// ==================== CLIENT: ROTATION LOG ====================

app.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Fetch from ProxySmart and sync to DB (same as admin)
    try {
      const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
      const entries = Array.isArray(result) ? result : (result?.log || result?.logs || result?.data || []);
      syncRotationLog(serverName, nick, entries);
    } catch (fetchErr) { /* serve from DB if ProxySmart fails */ }
    const rows = _rlSelect.all(serverName, nick);
    res.json(rows);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== CLIENT: SET ROTATION INTERVAL ====================

app.post('/api/client/set_rotation', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName, minutes } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const mins = parseInt(minutes);
    if (isNaN(mins) || mins < 0 || mins > 1440) return res.status(400).json({ error: 'minutes must be 0-1440' });

    // Verify modem belongs to this client
    const portNameFilter = req.user.portNameFilter;
    if (portNameFilter === '*') { /* admin — allow */ }
    else {
      const cached = getCachedData();
      if (!cached) return res.status(503).json({ error: 'Data not loaded yet' });
      const allPorts = cached.ports || {};
      let owned = false;
      for (const srv in allPorts) {
        const ports = allPorts[srv] || [];
        for (const p of ports) {
          if (p.portName === portNameFilter) {
            const pNick = (p.portID || '').replace(/^S[12]_/, '');
            if (pNick === nick) { owned = true; break; }
          }
        }
        if (owned) break;
      }
      if (!owned) return res.status(403).json({ error: 'Modem not assigned to your account' });
    }

    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // Get current modem IMEI from status
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    const modem = modems.find(m => m.modem_details && m.modem_details.NICK === nick);
    if (!modem) return res.status(404).json({ error: 'Modem not found' });

    const imei = modem.modem_details.IMEI;
    // Store rotation setting
    await postApi(server, '/crud/store_modem', { IMEI: imei, AUTO_IP_ROTATION: String(mins) });
    // Apply settings
    await postApi(server, '/modem/settings', { imei });

    console.log(`[Rotation] Client ${req.user.login} set ${nick} rotation to ${mins} min`);
    auditLog(req.user.login, 'client_set_rotation', { nick, serverName, minutes: mins, ip: getClientIp(req) });
    res.json({ ok: true, minutes: mins });
  } catch (err) { res.status(502).json({ error: 'Failed to set rotation', details: err.message }); }
});

// ==================== CLIENT: IP HISTORY ====================

app.get('/api/client/ip_history', authMiddleware, (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json(ipHistory[key] || []);
});

// ==================== CLIENT: CREDENTIALS EXPORT ====================

app.get('/api/client/credentials_export', authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);

    const COUNTRIES = SERVER_COUNTRIES;
    // Build server URL map for direct reset URLs
    const credentials = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = extractServerName(imei);
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD) {
          credentials.push({
            modem: modemNick,
            server: serverName,
            serverIp: ci.serverIp || '',
            httpPort: p.HTTP_PORT || '',
            socksPort: p.SOCKS_PORT || '',
            login: p.LOGIN,
            password: p.PASSWORD,
            httpProxy: ci.serverIp ? `${ci.serverIp}:${p.HTTP_PORT}` : '',
            socks5Proxy: ci.serverIp ? `${ci.serverIp}:${p.SOCKS_PORT}` : '',
            httpCreds: p.http_creds || '',
            socks5Creds: p.socks5_creds || '',
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    // SEC: serverInfo with user/pass removed — clients use /api/client/reset_ip instead
    const clientInfo = clientByLogin.get(req.user.login);
    auditLog(req.user.login, 'client_export_creds', { count: credentials.length, ip: getClientIp(req) });
    res.json({
      credentials,
      clientName: req.user.login,
      exportDate: new Date().toISOString(),
      resetToken: clientInfo ? clientInfo.resetToken : ''
    });
  } catch (err) { res.status(502).json({ error: 'Export failed', details: err.message }); }
});

// ==================== CLIENT: REFERRAL PROGRAM ====================

app.get('/api/client/referral', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const referrals = clients.filter(c => c.referred_by === client.id);
  res.json({
    referrals_count: referrals.length,
    referral_balance: client.referral_balance || 0,
    referrals: referrals.map(r => ({ name: r.name, createdAt: r.createdAt }))
  });
});

// ==================== CLIENT: DOCUMENTS ====================

app.get('/api/client/documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json([]);
  res.json((client.documents || []).map(d => ({ id: d.id, name: d.name, date: d.date })));
});

app.get('/api/client/documents/:docId/download', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const doc = (client.documents || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(DOCUMENTS_DIR, doc.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(doc.name || doc.fileName);
  const mimeTypes = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png': 'image/png', '.jpg': 'image/jpeg' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  fs.createReadStream(filePath).pipe(res);
});

// ==================== CORS for Public API (Bug #6) ====================
app.use('/api/v1', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ==================== PUBLIC: PROXY API v2 (Evomi-style, apiKey via header or query) ====================

app.get('/api/v1/proxy', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apikey;
  if (!apiKey) return res.status(401).json({ success: false, error: 'API key required. Pass via X-API-Key header or ?apikey= query parameter.' });

  const client = clientByApiKey.get(apiKey);
  if (!client) return res.status(401).json({ success: false, error: 'Invalid API key' });

  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = SERVER_COUNTRIES;

    const proxies = [];
    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = extractServerName(imei);
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      let operator = '', isOnline = false;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) {
          modemNick = m.modem_details.NICK || imei;
          operator = m.net_details?.CELLOP || '';
          isOnline = m.net_details?.IS_ONLINE === 'yes';
          break;
        }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD && ci.serverIp) {
          // Use RESET_SECURE_LINK from port data (direct modem server URL)
          const changeIpUrl = p.RESET_SECURE_LINK?.URL || '';
          proxies.push({
            id: modemNick,
            host: ci.serverIp,
            ports: { http: parseInt(p.HTTP_PORT) || 0, socks5: parseInt(p.SOCKS_PORT) || 0 },
            username: p.LOGIN,
            password: p.PASSWORD,
            country: ci.country || '',
            country_name: ci.name || '',
            operator,
            online: isOnline,
            change_ip_url: changeIpUrl
          });
        }
      }
    }

    // Billing
    const clientInfo = clientByLogin.get(client.login);
    const totalPayments = clientInfo ? (clientInfo.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) : 0;

    // Bandwidth totals (in MB) — use parseBwToBytes → GB → MB
    let monthBytes = 0;
    for (const b of Object.values(merged.bandwidth)) {
      monthBytes += parseBwToBytes(b.bandwidth_bytes_month_in);
      monthBytes += parseBwToBytes(b.bandwidth_bytes_month_out);
    }
    const monthMb = Math.round(trafficBytesToGb(monthBytes) * 1024);

    res.json({
      success: true,
      client: client.name,
      billing: {
        type: clientInfo?.billingType || 'per_gb',
        price_per_gb: clientInfo?.price || 0,
        currency: clientInfo?.currency || 'RUB',
        balance: clientInfo?.balance !== undefined ? clientInfo.balance : totalPayments,
        usage_mb: Math.round(monthMb)
      },
      proxies,
      proxy_count: proxies.length
    });
  } catch (err) {
    res.status(502).json({ success: false, error: 'Failed to fetch proxy data' });
  }
});

// ==================== PUBLIC: PROXY API v1 (legacy, kept for backward compat) ====================

app.get('/api/v1/proxies', async (req, res) => {
  const { apiKey, format } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  const client = clientByApiKey.get(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, client.portName);

    const COUNTRIES = SERVER_COUNTRIES;
    const proxies = [];

    for (const [imei, portList] of Object.entries(merged.ports)) {
      const serverName = extractServerName(imei);
      const ci = COUNTRIES[serverName] || {};
      let modemNick = imei;
      for (const m of merged.status) {
        if (m.modem_details?.IMEI === imei) { modemNick = m.modem_details.NICK || imei; break; }
      }
      for (const p of portList) {
        if (p.LOGIN && p.PASSWORD && ci.serverIp) {
          proxies.push({
            modem: modemNick,
            ip: ci.serverIp,
            httpPort: parseInt(p.HTTP_PORT) || 0,
            socksPort: parseInt(p.SOCKS_PORT) || 0,
            login: p.LOGIN,
            password: p.PASSWORD,
            resetUrl: p.RESET_SECURE_LINK?.URL || ''
          });
        }
      }
    }

    const fmt = (format || 'json').toLowerCase();
    if (fmt === 'txt') {
      const lines = proxies.map(p => `${p.ip}:${p.httpPort}:${p.login}:${p.password}|${p.resetUrl}`);
      res.type('text/plain').send(lines.join('\n'));
    } else if (fmt === 'csv') {
      const lines = ['ip,http_port,socks_port,login,password,reset_url'];
      proxies.forEach(p => lines.push([p.ip, p.httpPort, p.socksPort, p.login, p.password, p.resetUrl].join(',')));
      res.type('text/csv').send(lines.join('\n'));
    } else {
      res.json({ proxies, count: proxies.length, client: client.name });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch proxy data' });
  }
});

// ==================== ADMIN: FULL DATA ====================

// TASK-D: Cache invalidation endpoint
app.post('/api/admin/cache/invalidate', authMiddleware, adminMiddleware, (req, res) => {
  _psCache = null;
  _psCacheTs = 0;
  console.log('[Cache] ProxySmart cache invalidated by admin');
  res.json({ ok: true, message: 'Cache invalidated' });
});

app.get('/api/admin/daily_traffic', authMiddleware, adminMiddleware, async (req, res) => {
  // Return daily traffic aggregated by client (portName) for each day
  const results = await fetchAllServersDataCached();
  if (Object.keys(portKeyToPortName).length === 0) refreshPortKeyMapping(results);
  const pnMap = portKeyToPortName;
  // Aggregate: { clientName: { "2026-03-01": { in: bytes, out: bytes }, ... } }
  // Also track per-server: { clientName: { "2026-03-01": { in, out, servers: { S1: {in,out}, S2: {in,out} } } } }
  const byClient = {};
  // Build portId -> serverName mapping
  const portIdToServer = {};
  for (const data of results) {
    const srvName = data.serverName || '';
    if (typeof data.bw === 'object') {
      for (const portId of Object.keys(data.bw)) {
        portIdToServer[portId] = srvName;
        portIdToServer[srvName + '_' + portId] = srvName;
      }
    }
  }
  // Historical days from dailyTraffic
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    const pn = (Object.values(days)[0] && Object.values(days)[0].portName) || pnMap[portId] || 'Не назначен';
    const srv = portIdToServer[portId] || '';
    if (!byClient[pn]) byClient[pn] = {};
    for (const [date, entry] of Object.entries(days)) {
      if (!byClient[pn][date]) byClient[pn][date] = { in: 0, out: 0, servers: {} };
      byClient[pn][date].in += entry.in || 0;
      byClient[pn][date].out += entry.out || 0;
      if (srv) {
        if (!byClient[pn][date].servers[srv]) byClient[pn][date].servers[srv] = { in: 0, out: 0 };
        byClient[pn][date].servers[srv].in += entry.in || 0;
        byClient[pn][date].servers[srv].out += entry.out || 0;
      }
    }
  }
  // Today's live data from bandwidth cache
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const data of results) {
    if (typeof data.bw !== 'object') continue;
    const srvName = data.serverName || '';
    for (const [portId, b] of Object.entries(data.bw)) {
      const pn = b.portName || pnMap[(data.serverName || '') + '_' + portId] || 'Не назначен';
      const dayIn = parseBwToBytes(b.bandwidth_bytes_day_in);
      const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
      if (dayIn > 0 || dayOut > 0) {
        if (!byClient[pn]) byClient[pn] = {};
        if (!byClient[pn][todayStr]) byClient[pn][todayStr] = { in: 0, out: 0, servers: {} };
        byClient[pn][todayStr].in += dayIn;
        byClient[pn][todayStr].out += dayOut;
        if (srvName) {
          if (!byClient[pn][todayStr].servers[srvName]) byClient[pn][todayStr].servers[srvName] = { in: 0, out: 0 };
          byClient[pn][todayStr].servers[srvName].in += dayIn;
          byClient[pn][todayStr].servers[srvName].out += dayOut;
        }
      }
    }
  }
  res.json(byClient);
});

// ==================== ANALYTICS ENDPOINTS ====================

app.get('/api/analytics/monthly_traffic', authMiddleware, adminMiddleware, (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)
    .toISOString().slice(0, 10);
  try {
    const rows = db.prepare(
      'SELECT substr(date,1,7) as month, SUM(bytes_in+bytes_out) as total_bytes ' +
      'FROM daily_traffic WHERE date >= ? GROUP BY month ORDER BY month'
    ).all(startDate);
    const byMonth = {};
    for (const r of rows) byMonth[r.month] = r.total_bytes || 0;
    // Add today's bytes from in-memory store (saved nightly, so today may be partial)
    const todayStr = now.toISOString().slice(0, 10);
    const curMonth = todayStr.slice(0, 7);
    for (const days of Object.values(dailyTraffic)) {
      const t = days[todayStr];
      if (t) byMonth[curMonth] = (byMonth[curMonth] || 0) + (t.in || 0) + (t.out || 0);
    }
    const MONTHS_RU = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mStr = d.toISOString().slice(0, 7);
      const totalGb = Math.round((byMonth[mStr] || 0) / 1073741824 * 10) / 10;
      const entry = { month: mStr, label: MONTHS_RU[d.getMonth()], total_gb: totalGb };
      if (i === 0) {
        entry.is_current = true;
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        if (dom > 0 && totalGb > 0) entry.forecast_gb = Math.round(totalGb / dom * dim * 10) / 10;
      }
      result.push(entry);
    }
    res.json(result);
  } catch (e) {
    console.error('[monthly_traffic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analytics/heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { view = 'country', id = 'moldova' } = req.query;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const results = await fetchAllServersDataCached();
    if (Object.keys(portKeyToPortName).length === 0) refreshPortKeyMapping(results);
    const pnMap = portKeyToPortName;
    // Build portName → countries/operators sets from live data
    const portCountries = {}, portOperators = {};
    for (const data of results) {
      const srv = (data.serverName || '').toLowerCase();
      const ctr = ((SERVER_COUNTRIES[data.serverName] || {}).country || '').toLowerCase();
      const ctrName = ((SERVER_COUNTRIES[data.serverName] || {}).name || '').toLowerCase();
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const pn = b.portName || pnMap[(data.serverName || '') + '_' + portId] || '';
        if (!pn) continue;
        if (!portCountries[pn]) portCountries[pn] = new Set();
        portCountries[pn].add(srv); portCountries[pn].add(ctr); portCountries[pn].add(ctrName);
        if (!portOperators[pn]) portOperators[pn] = new Set();
        if (b.operator) portOperators[pn].add(b.operator.toLowerCase().replace(/[\s.]+/g, '_'));
      }
    }
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');
    // Build server→country mapping
    const serverCountryMap = {}; // { 'S1': 'moldova', 'S2': 'romania' }
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }
    let filterPortNames = null;
    let filterServerPrefix = null; // for hourly data with 'SRV:portName' format
    if (idKey === 'all') {
      filterPortNames = null; filterServerPrefix = null; // no filter
    } else if (view === 'country') {
      // Find which server(s) belong to this country
      filterServerPrefix = [];
      for (const [srv, cn] of Object.entries(serverCountryMap)) {
        if (cn.includes(idKey) || idKey.includes(cn)) filterServerPrefix.push(srv);
      }
      // Also build portNames filter for daily_traffic (S1_portXXX format)
      filterPortNames = new Set();
      for (const [pn, set] of Object.entries(portCountries))
        for (const c of set) if (c && (c.includes(idKey) || idKey.includes(c))) { filterPortNames.add(pn); break; }
    } else if (view === 'operator') {
      filterPortNames = new Set();
      for (const [pn, set] of Object.entries(portOperators))
        for (const op of set) if (op && (op.includes(idKey) || idKey.includes(op) || op.replace(/_/g,'').includes(idKey.replace(/_/g,'')))) { filterPortNames.add(pn); break; }
    } else if (view === 'client') {
      filterPortNames = new Set([id]);
      // For hourly: client ports exist on multiple servers with prefix
      filterServerPrefix = null; // match by client name part
    }
    // Date list in Moscow time (UTC+3)
    const now2 = new Date();
    const mskNow = new Date(now2.getTime() + 3 * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    // Fetch from 3h before startDate (MSK 00:00 = UTC 21:00 prev day)
    const utcFetchStart = startDate + 'T00:00:00Z';
    const utcFetchStartShifted = new Date(new Date(utcFetchStart).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const matrix = dateList.map(() => new Array(24).fill(0));
    const checkRows = db.prepare('SELECT COUNT(*) as cnt FROM traffic_hourly WHERE hour_start >= ?').get(utcFetchStartShifted);
    if (checkRows.cnt > 0) {
      // Real hourly data — port_name format is 'SRV:clientName'
      let sql = "SELECT strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) as day, CAST(strftime('%H', datetime(hour_start, '+3 hours')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE hour_start >= ?";
      const params = [utcFetchStartShifted];
      if (filterServerPrefix && filterServerPrefix.length > 0) {
        // Filter by server prefix (country view): port_name LIKE 'S1:%' OR port_name LIKE 'S2:%'
        sql += ' AND (' + filterServerPrefix.map(() => "port_name LIKE ?").join(' OR ') + ')';
        filterServerPrefix.forEach(s => params.push(s + ':%'));
      } else if (view === 'client' && id) {
        // Filter by client name suffix: port_name LIKE '%:clientName'
        sql += " AND port_name LIKE ?";
        params.push('%:' + id);
      }
      sql += ' GROUP BY day, hour ORDER BY day, hour';
      for (const r of db.prepare(sql).all(...params)) {
        const di = dateList.indexOf(r.day);
        if (di >= 0 && r.hour >= 0 && r.hour < 24) matrix[di][r.hour] = r.bytes / 1073741824;
      }
    } else {
      // No hourly data available — matrix stays empty (all zeros)
      // Daily data can't provide hourly resolution, showing fake flat bars is misleading
    }
    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()], dateShort: date.slice(5) };
    });
    res.json({
      meta: { id, modems_count: filterPortNames ? filterPortNames.size : Object.keys(portCountries).length, days: dateList, day_meta: dayMeta, has_hourly: checkRows.cnt > 0 },
      matrix
    });
  } catch (e) {
    console.error('[heatmap]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/data', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, '*');
    const servers = apiServers.map(s => ({ name: s.name, url: s.url }));
    // TASK-01 (SEC): serverAuth removed — credentials must never reach the frontend
    // SEC-04: Strip passwords/hashes from client data sent to frontend
    const sanitizedClients = clients.map(c => {
      const { password, passwordHash, ...safe } = c;
      return safe;
    });
    // BUG-11: billingLedger removed from bulk response — use /api/admin/clients/:id/ledger instead
    // Sprint-4 Task 1: Compute monthly charges server-side (replaces client-side billingLedger lookup)
    const clientMonthCharges = {};
    const clientMonthGb = {};
    const curMonthPfx = new Date().toISOString().slice(0, 7);
    for (const [clientId, entries] of Object.entries(billingLedger)) {
      let cost = 0, gb = 0;
      for (const e of entries) {
        if (e.type === 'charge' && e.date && e.date.startsWith(curMonthPfx)) {
          cost += (e.cost || 0);
          gb += (e.delta_gb || 0);
        }
      }
      if (cost !== 0) clientMonthCharges[clientId] = Math.round(cost * 100) / 100;
      if (gb !== 0) clientMonthGb[clientId] = Math.round(gb * 1000) / 1000;
    }

    // TRAFFIC-FIX: Compute live month traffic per client from ProxySmart real-time data
    // This fixes discrepancy between admin client list (was showing billed delta only)
    // and admin analytics / client portal (showing live counters)
    const clientLiveMonthGb = {};
    const portNameToClientId = {};
    for (const c of clients) {
      if (c.portName) portNameToClientId[c.portName] = c.id;
    }
    // Sum bandwidth_bytes_month_in + _out for each portName from live data
    const portNameBytes = {};
    for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
      const pn = bwData.portName;
      if (!pn || !portNameToClientId[pn]) continue;
      if (!portNameBytes[pn]) portNameBytes[pn] = 0;
      portNameBytes[pn] += parseBwToBytes(bwData.bandwidth_bytes_month_in);
      portNameBytes[pn] += parseBwToBytes(bwData.bandwidth_bytes_month_out);
    }
    for (const [pn, bytes] of Object.entries(portNameBytes)) {
      const cid = portNameToClientId[pn];
      if (cid && bytes > 0) {
        clientLiveMonthGb[cid] = trafficBytesToGb(bytes);
      }
    }

    // Override yesterday bandwidth with recorded daily_traffic (stable, not degraded by modem restarts)
    const _yesterdayStr = getMoscowYesterday();
    for (const [portId, bwData] of Object.entries(merged.bandwidth || {})) {
      const dt = dailyTraffic[portId]?.[_yesterdayStr];
      if (dt) {
        bwData.bandwidth_bytes_yesterday_in = dt.in || 0;
        bwData.bandwidth_bytes_yesterday_out = dt.out || 0;
      }
    }

    res.json({
      clientMonthCharges,
      clientMonthGb,
      clientLiveMonthGb,
      ...merged,
      servers,
      clients: sanitizedClients,
      ipTracking,
      uptimeTracking,
      speedtestLatest: getSpeedtestLatest(),
      ipHistory,
      settings: appSettings,
      bankPayments: getAllBankPayments(),
      tochkaConfigured: !!tochkaConfig.jwt,
      tochkaConfig: { jwt: tochkaConfig.jwt ? '****' + tochkaConfig.jwt.slice(-8) : '', clientId: tochkaConfig.clientId, customerCode: tochkaConfig.customerCode, accountId: tochkaConfig.accountId, companyName: tochkaConfig.companyName, companyInn: tochkaConfig.companyInn, companyKpp: tochkaConfig.companyKpp }
    });
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// ==================== ADMIN: CLIENT MANAGEMENT ====================

// BUG-12: Input validation for admin routes
function validateClientInput(body, isCreate = false) {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length > 200) return 'name max 200 chars';
    if (isCreate && body.name.trim().length === 0) return 'name is required';
  }
  if (body.login !== undefined) {
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(body.login)) return 'login must be 3-50 alphanumeric chars or underscores';
  }
  if (body.inn !== undefined && body.inn !== '') {
    if (!/^\d{10}(\d{2})?$/.test(body.inn)) return 'inn must be 10 or 12 digits';
  }
  if (body.kpp !== undefined && body.kpp !== '') {
    if (!/^\d{9}$/.test(body.kpp)) return 'kpp must be 9 digits';
  }
  if (body.price !== undefined) {
    const p = parseFloat(body.price);
    if (isNaN(p) || p < 0) return 'price must be a non-negative number';
  }
  if (body.billingType !== undefined) {
    if (!['per_gb', 'per_modem', 'flat'].includes(body.billingType)) return 'billingType must be per_gb, per_modem, or flat';
  }
  if (body.currency !== undefined) {
    if (!['RUB', 'USD', 'EUR'].includes(body.currency)) return 'currency must be RUB, USD, or EUR';
  }
  if (body.contact !== undefined && typeof body.contact === 'string' && body.contact.length > 500) return 'contact max 500 chars';
  if (body.notes !== undefined && typeof body.notes === 'string' && body.notes.length > 2000) return 'notes max 2000 chars';
  if (body.clientType !== undefined) {
    if (!['individual', 'legal'].includes(body.clientType)) return 'clientType must be individual or legal';
  }
  return null;
}

// BUG-11: Pagination for admin clients list
app.get('/api/admin/clients', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const search = (req.query.search || '').toLowerCase().trim();
  // SEC-04: strip sensitive fields
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

app.post('/api/admin/clients', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, portName, login, password, contact, notes, billingType, price, currency, referred_by, inn, kpp, legalName, contractInfo, address, clientType } = req.body;
  if (!name || !portName || !login || !password) {
    return res.status(400).json({ error: 'name, portName, login, password required' });
  }
  // BUG-12: Validate input
  const valErr = validateClientInput(req.body, true);
  if (valErr) return res.status(400).json({ error: valErr });
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
  saveClients(clients);
  rebuildClientMaps();
  users[login] = { passwordHash, portNameFilter: portName, source: 'client', clientId: client.id };
  // SEC-04: strip sensitive fields from response
  const { password: _p, passwordHash: _ph, ...safeClient } = client;
  res.json({ ok: true, client: safeClient });
});

app.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  // TASK-10: O(1) lookup + index needed for array replacement
  const old = clientById.get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Client not found' });
  const idx = clients.indexOf(old);
  // BUG-12: Validate input
  const valErr = validateClientInput(req.body, false);
  if (valErr) return res.status(400).json({ error: valErr });
  const { name, portName, login, password, contact, notes, billingType, price, currency, inn, kpp, legalName, contractInfo, address, autoActs, autoBills, billingPaused, clientType } = req.body;
  if (login && login !== old.login) {
    if (users[login]) return res.status(400).json({ error: 'Login already exists: ' + login });
    delete users[old.login];
  }
  // SEC-01: hash new password with bcrypt if changed
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
    clientType: clientType !== undefined ? clientType : (old.clientType || 'legal')
  };
  clients[idx] = updated;
  saveClients(clients);
  rebuildClientMaps();
  users[updated.login] = { passwordHash: updated.passwordHash, portNameFilter: updated.portName, source: 'client', clientId: updated.id };
  // SEC-04: strip sensitive fields from response
  const { password: _p, passwordHash: _ph, ...safeClient } = updated;
  res.json({ ok: true, client: safeClient });
});

// DELETE client -- with port protection
app.delete('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  // BUG-08 fix: O(1) lookup first, then find index only for splice
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
    console.warn('[DeleteClient] Could not verify ports, proceeding with deletion:', e.message);
  }

  const removed = clients.splice(idx, 1)[0];
  saveClients(clients);
  rebuildClientMaps();
  delete users[removed.login];
  deleteSessionsByLogin(removed.login);
  auditLog(req.user.login, 'delete_client', { clientId: removed.id, clientName: removed.name, ip: getClientIp(req) });
  res.json({ ok: true });
});

// ==================== ADMIN: PAYMENTS ====================

app.post('/api/admin/clients/:id/payment', authMiddleware, adminMiddleware, (req, res) => {
  // BUG-08 fix: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return res.status(400).json({ error: 'Invalid amount: must be positive and reasonable' });
  }
  if (!client.payments) client.payments = [];
  client.payments.push({
    amount: parsedAmount,
    date,
    note: note || '',
    createdAt: new Date().toISOString()
  });

  // BUG-02 fix: Atomic balance + ledger in ONE transaction
  const { balanceBefore, balanceAfter } = atomicCredit(client.id, parsedAmount, {
    type: 'payment',
    date: date,
    timestamp: new Date().toISOString(),
    amount: parsedAmount,
    currency: client.currency || 'RUB',
    note: note || 'Пополнение баланса'
  });

  // BUG-09 fix: Referral commission — O(1) lookup, round, persist to DB
  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) {
      const commission = Math.round(parsedAmount * 0.15 * 100) / 100;
      referrer.referral_balance = Math.round(((referrer.referral_balance || 0) + commission) * 100) / 100;
      _clientUpdateReferralBalance.run(referrer.referral_balance, referrer.id);
      console.log(`[Referral] Credited ${commission.toFixed(2)} to ${referrer.name} (15% of ${parsedAmount})`);
    }
  }

  saveClients(clients);
  auditLog(req.user.login, 'add_payment', { clientId: client.id, clientName: client.name, amount: parsedAmount, note: note || '', ip: getClientIp(req) });
  res.json({ ok: true, payments: client.payments, balance: client.balance });
});

// Manual charge (debit) from client balance
app.post('/api/admin/clients/:id/charge', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return res.status(400).json({ error: 'Invalid amount: must be positive and reasonable' });
  }

  const { balanceBefore, balanceAfter } = atomicDebit(client.id, parsedAmount, {
    type: 'manual_charge',
    date: date,
    timestamp: new Date().toISOString(),
    amount: parsedAmount,
    currency: client.currency || 'RUB',
    note: note || 'Ручное списание'
  });

  saveClients(clients);
  auditLog(req.user.login, 'manual_charge', { clientId: client.id, clientName: client.name, amount: parsedAmount, note: note || '', ip: getClientIp(req) });
  res.json({ ok: true, balance: client.balance, balanceBefore, balanceAfter });
});

app.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.payments || []);
});

app.delete('/api/admin/clients/:id/payment/:index', authMiddleware, adminMiddleware, (req, res) => {
  // BUG-08 fix: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const payIdx = parseInt(req.params.index);
  if (!client.payments || payIdx < 0 || payIdx >= client.payments.length) {
    return res.status(400).json({ error: 'Invalid payment index' });
  }
  const deletedPayment = client.payments[payIdx];
  const deletedAmount = parseFloat(deletedPayment.amount) || 0;

  // OLD-03 fix: verify amount to prevent wrong-payment deletion under concurrency
  const expectedAmount = parseFloat(req.query.amount || req.body?.amount);
  if (expectedAmount && Math.abs(expectedAmount - deletedAmount) > 0.01) {
    return res.status(409).json({ error: 'Payment amount mismatch — list may have changed, please refresh' });
  }
  client.payments.splice(payIdx, 1);

  // BUG-02 fix: Atomic balance + ledger in ONE transaction
  // NEW-01 fix: amount positive — type indicates the meaning of the operation
  const { balanceBefore, balanceAfter } = atomicDebit(client.id, deletedAmount, {
    type: 'payment_reversal',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: deletedAmount,
    currency: client.currency || 'RUB',
    note: 'Отмена оплаты администратором'
  });

  saveClients(clients);
  res.json({ ok: true, payments: client.payments, balance: client.balance });
});

// ==================== ADMIN: BILLING LEDGER ====================

app.get('/api/admin/clients/:id/ledger', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const allEntries = billingLedger[client.id] || [];
  // BUG-11: Pagination support
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const entries = allEntries.slice(offset, offset + limit);
  res.json({
    balance: client.balance,
    last_snapshot: client.last_traffic_snapshot,
    // OLD-01 fix: strip internal db_id from API response
    entries: entries.map(({ db_id, ...e }) => e),
    total: allEntries.length,
    limit,
    offset
  });
});

// BUG-06 fix: Delete ledger entry + revert balance — point deletion, no saveClients, single auditLog
app.delete('/api/admin/clients/:id/ledger/:entryIndex', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = billingLedger[client.id] || [];
  const idx = parseInt(req.params.entryIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= entries.length) return res.status(400).json({ error: 'Invalid entry index' });

  const entry = entries[idx];

  // Delete from SQLite
  if (entry.db_id) {
    _ledgerDeleteById.run(entry.db_id);
  }
  entries.splice(idx, 1);
  billingLedger[client.id] = entries;

  // Recalculate balance from scratch using all remaining ledger entries
  let recalcBalance = 0;
  for (const e of entries) {
    const isCredit = ['payment', 'bank_payment', 'credit', 'manual_credit', 'adjustment_credit'].includes(e.type)
      || (e.type === 'adjustment' && (e.amount || 0) > 0);
    const amt = e.amount || e.cost || 0;
    if (isCredit) recalcBalance += amt;
    else recalcBalance -= amt;
  }
  recalcBalance = Math.round(recalcBalance * 100) / 100;
  _clientUpdateBalance.run(recalcBalance, client.id);
  client.balance = recalcBalance;

  saveBillingLedger();
  console.log(`[Ledger] Deleted entry #${idx} (${entry.type}) for client ${client.name}, recalculated balance: ${client.balance}`);
  auditLog(req.user.login, 'delete_ledger_entry', { clientId: client.id, clientName: client.name, entryType: entry.type, amount: entry.amount || entry.cost, ip: getClientIp(req) });
  res.json({ ok: true, newBalance: client.balance });
});

app.post('/api/admin/clients/:id/balance_adjust', authMiddleware, adminMiddleware, (req, res) => {
  // BUG-08 fix: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, note } = req.body;
  if (amount === undefined) return res.status(400).json({ error: 'amount required' });

  // BUG-02 fix: Atomic balance + ledger in ONE transaction
  // NEW-01 fix: ledger amount always positive — sign conveyed by credit vs debit
  // OLD-05 fix: removed unnecessary saveClients (balance already persisted via _clientUpdateBalance)
  const adjustment = parseFloat(amount);
  const ledgerEntry = {
    type: 'adjustment',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: Math.abs(adjustment),
    currency: client.currency || 'RUB',
    note: note || 'Ручная корректировка баланса'
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

// ==================== ADMIN: BILLING RECONCILIATION ====================

app.get('/api/admin/billing/reconciliation', authMiddleware, adminMiddleware, async (req, res) => {
  const period = req.query.period || getMoscowToday().slice(0, 7); // "YYYY-MM"

  // Ensure portKey mapping is populated for matching dailyTraffic → clients
  if (Object.keys(portKeyToPortName).length === 0) {
    try {
      const cachedResults = await fetchAllServersDataCached();
      refreshPortKeyMapping(cachedResults);
    } catch (e) { /* best effort */ }
  }

  const results = [];

  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) continue;

    // Sum stored daily_traffic bytes for this month
    const storedBytes = getClientStoredMonthBytes(client.portName, period);
    const storedGb = trafficBytesToGb(storedBytes);

    // Sum ledger charges for this month
    const entries = billingLedger[client.id] || [];
    const monthCharges = entries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    const billedGb = Math.round(monthCharges.reduce((s, e) => s + (e.delta_gb || 0), 0) * 1000) / 1000;
    const billedCost = Math.round(monthCharges.reduce((s, e) => s + (e.cost || 0), 0) * 100) / 100;

    // Count days with traffic vs days with billing
    const trafficDays = new Set();
    for (const [portKey, days] of Object.entries(dailyTraffic)) {
      const firstDay = Object.values(days)[0];
      const pn = (firstDay && firstDay.portName) || portKeyToPortName[portKey] || '';
      if (pn !== client.portName) continue;
      for (const date of Object.keys(days)) {
        if (date.startsWith(period)) trafficDays.add(date);
      }
    }
    const billingDays = new Set(monthCharges.map(e => e.date));

    const diffGb = Math.round((storedGb - billedGb) * 1000) / 1000;
    let status = 'ok';
    if (Math.abs(diffGb) > 0.01) status = 'mismatch';
    if (trafficDays.size > 0 && billingDays.size === 0) status = 'missing_billing';
    if (trafficDays.size === 0 && billingDays.size > 0) status = 'missing_traffic';

    // Find missing days (traffic recorded but no charge)
    const missingDays = [...trafficDays].filter(d => !billingDays.has(d)).sort();

    results.push({
      client_id: client.id,
      client_name: client.name,
      billing_type: client.billingType || 'per_gb',
      stored_gb: storedGb,
      billed_gb: billedGb,
      diff_gb: diffGb,
      billed_cost: billedCost,
      traffic_days: trafficDays.size,
      billing_days: billingDays.size,
      missing_days: missingDays,
      status
    });
  }

  res.json({ period, clients: results });
});

// ==================== ADMIN: DOCUMENTS ====================

app.post('/api/admin/clients/:id/document', authMiddleware, adminMiddleware, async (req, res) => {
  // TASK-10: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { name, fileBase64, mimeType } = req.body;
  if (!name || !fileBase64) return res.status(400).json({ error: 'name and fileBase64 required' });

  // SEC-04: Validate file extension
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
  const fileName = `${docId}.${ext}`;
  const filePath = path.join(DOCUMENTS_DIR, fileName);

  await fsPromises.writeFile(filePath, Buffer.from(fileBase64, 'base64'));

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

app.delete('/api/admin/clients/:id/document/:docId', authMiddleware, adminMiddleware, (req, res) => {
  // TASK-10: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.documents) return res.status(404).json({ error: 'No documents' });
  const docIdx = client.documents.findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });
  const doc = client.documents[docIdx];
  // Delete file
  try { fs.unlinkSync(path.join(DOCUMENTS_DIR, doc.fileName)); } catch (e) {}
  client.documents.splice(docIdx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// ==================== ADMIN: API KEY MANAGEMENT ====================

app.post('/api/admin/clients/:id/regenerate_key', authMiddleware, adminMiddleware, (req, res) => {
  // TASK-10: O(1) lookup
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  saveClients(clients);
  res.json({ ok: true, apiKey: client.apiKey });
});

// ==================== ADMIN: AUDIT LOG (TASK-J) ====================

app.get('/api/admin/audit_log', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const total = dbStmts.countAuditLog.get().cnt;
  const rows = dbStmts.getAuditLog.all(limit, offset);
  // Parse details JSON back to object for frontend
  const entries = rows.map(r => {
    let details = {};
    try { details = JSON.parse(r.details || '{}'); } catch (e) {}
    return { timestamp: r.timestamp, admin: r.admin, action: r.action, ...details };
  });
  res.json({ total, offset, limit, entries });
});

// CRM translate endpoint removed — translations applied directly to DB

// ==================== ADMIN: SETTINGS ====================

app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json(appSettings);
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  const { speedtest_times, pricing_tiers } = req.body;
  if (speedtest_times && Array.isArray(speedtest_times)) {
    appSettings.speedtest_times = speedtest_times.filter(t => /^\d{2}:\d{2}$/.test(t));
  }
  if (pricing_tiers && Array.isArray(pricing_tiers)) {
    appSettings.pricing_tiers = pricing_tiers.map(t => ({
      min_proxies: parseInt(t.min_proxies) || 1,
      price: parseFloat(t.price) || 0,
      label: t.label || ''
    }));
  }
  saveSettings();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings });
});

// ==================== ADMIN: MODEM ACTIONS ====================

app.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reset failed', details: err.message }); }
});

app.post('/api/admin/reboot', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot failed', details: err.message }); }
});

app.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/usb_reset_modem_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'USB reset failed', details: err.message }); }
});

app.post('/api/admin/reboot_server', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, password } = req.body;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const adminUser = users[req.user.login];
    if (!adminUser) return res.status(403).json({ error: 'Пользователь не найден' });
    const pwdValid = adminUser.passwordHash ? await bcrypt.compare(password || '', adminUser.passwordHash) : (adminUser.password === password);
    if (!pwdValid) return res.status(403).json({ error: 'Неверный пароль' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/reboot_server', 30000);
    console.log(`[Admin] Server ${serverName} reboot requested`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot server failed', details: err.message }); }
});

app.post('/api/admin/reset_complete', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, password } = req.body;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const adminUser = users[req.user.login];
    if (!adminUser) return res.status(403).json({ error: 'Пользователь не найден' });
    const pwdValid = adminUser.passwordHash ? await bcrypt.compare(password || '', adminUser.passwordHash) : (adminUser.password === password);
    if (!pwdValid) return res.status(403).json({ error: 'Неверный пароль' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Reset IP for all modems on this server
    const statusData = await fetchApi(server, '/apix/show_status_json');
    const modems = Array.isArray(statusData) ? statusData : [];
    let resetCount = 0;
    for (const m of modems) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      try {
        await fetchApi(server, `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(imei)}`, 15000);
        resetCount++;
      } catch (e) { /* skip failed */ }
    }
    console.log(`[Admin] Reset complete on ${serverName}: ${resetCount}/${modems.length} modems`);
    res.json({ ok: true, total: modems.length, reset: resetCount });
  } catch (err) { res.status(502).json({ error: 'Reset complete failed', details: err.message }); }
});

app.post('/api/admin/store_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...modemData } = req.body;
    if (!serverName || !modemData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_modem', modemData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store modem failed', details: err.message }); }
});

app.post('/api/admin/apply_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, imei } = req.body;
    if (!serverName || !imei) return res.status(400).json({ error: 'serverName and imei required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/settings', { imei });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply modem failed', details: err.message }); }
});

// ==================== ADMIN: ASSIGN/UNASSIGN MODEM TO CLIENT ====================
// Changes portName on ProxySmart server via form POST to /conf/edit_port/{portID}
function postFormApi(server, apiPath, formData, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const postData = new URLSearchParams(formData).toString();
    const req = getHttpLib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout, rejectUnauthorized: false
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, raw: data.slice(0, 500) }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

app.post('/api/admin/assign_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newPortName } = req.body;
    if (!serverName || !portID || !newPortName) return res.status(400).json({ error: 'serverName, portID, newPortName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // First read current port config from edit page
    const editPageRaw = await fetchApiRaw(server, `/conf/edit_port/${portID}`);
    const editHtml = editPageRaw || '';
    // Extract existing form values to preserve them
    const extract = (name) => { const m = editHtml.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)); return m ? m[1] : ''; };
    const formData = {
      portID: extract('portID') || portID,
      portName: newPortName,
      http_port: extract('http_port'),
      socks_port: extract('socks_port'),
      proxy_login: extract('proxy_login'),
      proxy_password: extract('proxy_password'),
      MAXCONN: extract('MAXCONN'),
      CONNLIM: extract('CONNLIM'),
      bandlimin: extract('bandlimin'),
      bandlimout: extract('bandlimout'),
      bw_quota: extract('bw_quota'),
      CREATED_AT: extract('CREATED_AT'),
      PROXY_VALID_BEFORE: extract('PROXY_VALID_BEFORE')
    };

    const result = await postFormApi(server, `/conf/edit_port/${portID}`, formData);
    console.log(`[AssignModem] Assigned port ${portID} to "${newPortName}" on ${serverName}`);
    // Invalidate cache so changes appear immediately
    serverDataCache.clear();
    auditLog(req.user.login, 'assign_modem', { serverName, portID, newPortName, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[AssignModem] Error:', err.message);
    res.status(502).json({ error: 'Failed to assign modem', details: err.message });
  }
});

// ==================== EXTERNAL PROXIES ====================
app.get('/api/admin/external_proxies', authMiddleware, adminMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM external_proxies ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/admin/external_proxies', authMiddleware, adminMiddleware, (req, res) => {
  const { client_id, label, protocol, host, port, login, password, change_ip_url, note, valid_until, billing_type, price, traffic_used_gb } = req.body;
  if (!client_id || !host || !port) return res.status(400).json({ error: 'client_id, host, port required' });
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO external_proxies (id, client_id, label, protocol, host, port, login, password, change_ip_url, note, valid_until, billing_type, price, traffic_used_gb) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, client_id, label || '', protocol || 'HTTP', host, parseInt(port), login || '', password || '', change_ip_url || '', note || '', valid_until || null, billing_type || 'monthly', parseFloat(price) || 0, parseFloat(traffic_used_gb) || 0);
  auditLog(req.user.login, 'add_external_proxy', { id, client_id, host, port, ip: getClientIp(req) });
  res.json({ ok: true, id });
});

app.put('/api/admin/external_proxies/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { label, protocol, host, port, login, password, change_ip_url, note, valid_until, billing_type, price, traffic_used_gb } = req.body;
  const existing = db.prepare('SELECT id FROM external_proxies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE external_proxies SET label=?, protocol=?, host=?, port=?, login=?, password=?, change_ip_url=?, note=?, valid_until=?, billing_type=?, price=?, traffic_used_gb=? WHERE id=?')
    .run(label || '', protocol || 'HTTP', host || '', parseInt(port) || 0, login || '', password || '', change_ip_url || '', note || '', valid_until || null, billing_type || 'monthly', parseFloat(price) || 0, parseFloat(traffic_used_gb) || 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/external_proxies/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM external_proxies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Client: view own external proxies
app.get('/api/client/external_proxies', authMiddleware, (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.json([]);
  const rows = db.prepare('SELECT id, label, protocol, host, port, login, password, change_ip_url, note, billing_type, price, traffic_used_gb FROM external_proxies WHERE client_id = ? ORDER BY created_at DESC').all(clientInfo.id);
  res.json(rows);
});

app.get('/api/admin/available_modems', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const available = [];
    for (const srv of Object.keys(results)) {
      const ports = results[srv].ports || {};
      const status = results[srv].status || [];
      const modemMap = {};
      status.forEach(m => { const imei = m.modem_details?.IMEI; if (imei) modemMap[imei] = m; });
      for (const imei of Object.keys(ports)) {
        const modemPorts = ports[imei];
        const modem = modemMap[imei];
        const nick = modem?.modem_details?.NICK || imei;
        modemPorts.forEach(p => {
          available.push({
            server: srv,
            imei,
            nick,
            portID: p.portID,
            portName: p.portName || '',
            httpPort: p.HTTP_PORT,
            socksPort: p.SOCKS_PORT,
            login: p.LOGIN
          });
        });
      }
    }
    res.json({ modems: available });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/admin/modem_status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/show_single_status_json?arg=${encodeURIComponent(nick)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// Rotation log: fetch from ProxySmart, sync to SQLite, return from DB
const _rlUpsert = db.prepare(`INSERT OR IGNORE INTO rotation_log (server_name, nick, old_ip, new_ip, started_at, ended_at, took_sec, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const _rlSelect = db.prepare(`SELECT * FROM rotation_log WHERE server_name = ? AND nick = ? ORDER BY started_at DESC LIMIT 200`);

function syncRotationLog(serverName, nick, entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  let inserted = 0;
  const insert = db.transaction((rows) => {
    for (const e of rows) {
      const start = e.start_time || e.Start || e.start || e.StartTime || '';
      const end = e.end_time || e.End || e.end || e.EndTime || '';
      const took = parseFloat(e.total_time || e['Time took (seconds)'] || e.Took || e.took || 0);
      const attempt = parseInt(e.attempt || e.Attempt || 1);
      const oldIp = e.old_ip || e['Old IPv4'] || e.OldIPv4 || e.oldIp || '';
      const newIp = e.new_ip || e['New IPv4'] || e.NewIPv4 || e.newIp || '';
      if (!start) continue;
      try { _rlUpsert.run(serverName, nick, oldIp, newIp, start, end, took, attempt); inserted++; } catch(e) { /* dup */ }
    }
  });
  insert(entries);
  return inserted;
}

app.get('/api/admin/rotation_log', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Fetch fresh data from ProxySmart and sync to DB
    try {
      const result = await fetchApi(server, `/apix/get_rotation_log?arg=${encodeURIComponent(nick)}`);
      const entries = Array.isArray(result) ? result : (result?.log || result?.logs || result?.data || []);
      syncRotationLog(serverName, nick, entries);
    } catch (fetchErr) {
      console.log(`[RotationLog] ProxySmart fetch failed for ${nick}@${serverName}: ${fetchErr.message}, serving from DB`);
    }
    // Always return from DB (has synced data + any previous data)
    const rows = _rlSelect.all(serverName, nick);
    res.json(rows);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/speedtest', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName, imei } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
    // Save to history when imei provided and result is valid
    if (imei && result && !result.error) {
      const key = `${serverName}_${imei}`;
      const dl = parseFloat(result.download || result.Download || result.dl || 0);
      const ul = parseFloat(result.upload || result.Upload || result.ul || 0);
      const ping = parseFloat(result.ping || result.Ping || result.latency || 0);
      if (dl > 0 || ul > 0) {
        pushSpeedtestEntry(key, { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result });
      }
    }
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Speedtest failed', details: err.message }); }
});

app.get('/api/admin/speedtest_history', authMiddleware, adminMiddleware, (req, res) => {
  res.json(speedtestHistory);
});

app.get('/api/admin/top_hosts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/ip_history', authMiddleware, adminMiddleware, (req, res) => {
  const { key } = req.query;
  if (key) {
    res.json(ipHistory[key] || []);
  } else {
    res.json(ipHistory);
  }
});

// ==================== ADMIN: SMS / USSD ====================

app.get('/api/admin/sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.query;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/modem/sms/${encodeURIComponent(imei)}?json=1`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Read SMS failed', details: err.message }); }
});

app.post('/api/admin/send_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, phone, sms } = req.body;
    if (!imei || !serverName || !phone || !sms) return res.status(400).json({ error: 'imei, serverName, phone, sms required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-sms', { imei, phone, sms });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send SMS failed', details: err.message }); }
});

app.post('/api/admin/send_ussd', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { imei, serverName, ussd } = req.body;
    if (!imei || !serverName || !ussd) return res.status(400).json({ error: 'imei, serverName, ussd required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/modem/send-ussd', { imei, ussd });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Send USSD failed', details: err.message }); }
});

app.post('/api/admin/purge_sms', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.body;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/purge_sms_json?arg=${encodeURIComponent(nick)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Purge SMS failed', details: err.message }); }
});

// ==================== ADMIN: PORT CRUD ====================

app.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI || !portData.portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await postApi(server, '/crud/store_port', portData);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store port failed', details: err.message }); }
});

// Update proxy credentials (login/password) for an existing port
app.post('/api/admin/update_port_creds', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, IMEI, portID, proxy_login, proxy_password } = req.body;
    if (!serverName || !IMEI || !portID) return res.status(400).json({ error: 'serverName, IMEI, portID required' });
    if (!proxy_login && !proxy_password) return res.status(400).json({ error: 'proxy_login or proxy_password required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Send to ProxySmart store_port (updates existing port)
    const portData = { IMEI, portID };
    if (proxy_login) portData.proxy_login = proxy_login;
    if (proxy_password) portData.proxy_password = proxy_password;
    const storeResult = await postApi(server, '/crud/store_port', portData);
    // Apply changes
    const applyResult = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`);
    res.json({ ok: true, storeResult, applyResult });
  } catch (err) { res.status(502).json({ error: 'Update credentials failed', details: err.message }); }
});

// Get full port configuration from ProxySmart edit form
app.get('/api/admin/get_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId } = req.query;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portId}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const extract = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
      if (m) return m[1];
      const m2 = html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
      return m2 ? m2[1] : '';
    };
    const extractSelected = (name) => {
      const re = new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`);
      const blockM = html.match(re);
      if (!blockM) return '';
      const block = blockM[0];
      const sel = block.match(/<option[^>]*selected[^>]*value="([^"]*)"/);
      if (sel) return sel[1];
      const sel2 = block.match(/<option[^>]*value="([^"]*)"[^>]*selected/);
      return sel2 ? sel2[1] : '';
    };
    res.json({
      portID: extract('portID') || portId,
      portName: extract('portName'),
      http_port: extract('http_port'),
      socks_port: extract('socks_port'),
      proxy_login: extract('proxy_login'),
      proxy_password: extract('proxy_password'),
      MAXCONN: extract('MAXCONN'),
      CONNLIM: extract('CONNLIM'),
      bandlimin: extract('bandlimin'),
      bandlimout: extract('bandlimout'),
      bw_quota: extract('bw_quota'),
      PROXY_VALID_BEFORE: extract('PROXY_VALID_BEFORE'),
      CREATED_AT: extract('CREATED_AT'),
      OS_SPOOF: extractSelected('OS_SPOOF'),
      IP_VERSION: extractSelected('IP_VERSION'),
    });
  } catch (err) {
    console.error('[GetPortConfig]', err.message);
    res.status(502).json({ error: 'Get port config failed', details: err.message });
  }
});

// Save full port configuration via ProxySmart form endpoint
app.post('/api/admin/save_port_config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portId, ...fields } = req.body;
    if (!serverName || !portId) return res.status(400).json({ error: 'serverName and portId required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Read current config to preserve hidden fields (CREATED_AT, etc.)
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portId}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const extract = (name) => { const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)); return m ? m[1] : ''; };
    const formData = { portID: portId, CREATED_AT: extract('CREATED_AT'), ...fields };
    // Remove internal fields not needed by ProxySmart form
    delete formData.serverName; delete formData.IMEI;
    const result = await postFormApi(server, `/conf/edit_port/${portId}`, formData);
    // Apply the port changes
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    serverDataCache.clear();
    auditLog(req.user.login, 'save_port_config', { serverName, portId, fields: Object.keys(fields), ip: getClientIp(req) });
    res.json({ ok: true, status: result.status });
  } catch (err) {
    console.error('[SavePortConfig]', err.message);
    res.status(502).json({ error: 'Save port config failed', details: err.message });
  }
});

app.post('/api/admin/apply_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply port failed', details: err.message }); }
});

app.post('/api/admin/purge_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/conf/delete_port/${encodeURIComponent(portId)}`);
    console.log(`[Admin] Deleted port ${portId} from ${serverName} via ProxySmart`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Delete port failed', details: err.message }); }
});

app.get('/api/admin/free_ports', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/get_free_tcp_ports');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: BANDWIDTH ====================

app.get('/api/admin/bandwidth_single', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_report_json?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/bandwidth_period', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName, start, end } = req.query;
    if (!portId || !serverName || !start || !end) return res.status(400).json({ error: 'portId, serverName, start, end required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_counters_port?PORTID=${encodeURIComponent(portId)}&START=${encodeURIComponent(start)}&END=${encodeURIComponent(end)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.post('/api/admin/reset_bandwidth', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_reset_counter?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== ADMIN: ANALYTICS ====================

app.get('/api/admin/unique_ips', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/unique_ips_json');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

app.get('/api/admin/backup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/crud/backup_export');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Backup failed', details: err.message }); }
});

app.get('/api/admin/vpn_profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const { buffer, contentType } = await fetchApiRaw(server, `/get_vpn_profile/${encodeURIComponent(portId)}.ovpn`);
    res.set('Content-Type', contentType || 'application/x-openvpn-profile');
    res.set('Content-Disposition', `attachment; filename="${portId}.ovpn"`);
    res.send(buffer);
  } catch (err) { res.status(502).json({ error: 'VPN profile failed', details: err.message }); }
});

app.get('/api/admin/shop_report', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { shop, period, serverName } = req.query;
    if (!shop || !period || !serverName) return res.status(400).json({ error: 'shop, period, serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/shop_report/${encodeURIComponent(shop)}/${encodeURIComponent(period)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

// ==================== TOOLS: PROXY CHECKER ====================

app.post('/api/tools/check_proxy', checkProxyLimiter, authMiddleware, async (req, res) => {
  const { proxies } = req.body;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return res.status(400).json({ error: 'proxies array required' });
  }
  const toCheck = proxies.slice(0, 50);

  // Check targets in order of reliability
  const checkTargets = [
    { url: 'http://api.ipify.org?format=json', host: 'api.ipify.org', parseIp: d => { try { return JSON.parse(d).ip; } catch(e) { return null; } } },
    { url: 'http://ip-api.com/json', host: 'ip-api.com', parseIp: d => { try { return JSON.parse(d).query; } catch(e) { return null; } } }
  ];

  async function checkOneProxy(proxy) {
    const start = Date.now();
    const proxyAuth = proxy.login && proxy.password
      ? `${proxy.login}:${proxy.password}` : null;
    for (const target of checkTargets) {
      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: proxy.ip,
            port: parseInt(proxy.port),
            path: target.url,
            method: 'GET',
            headers: {
              'Host': target.host,
              ...(proxyAuth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } : {})
            },
            timeout: 15000
          }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => resolve({ body: data, status: proxyRes.statusCode }));
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
          r.end();
        });
        if (result.status >= 200 && result.status < 400) {
          const detectedIp = target.parseIp(result.body) || result.body.trim();
          return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp, status: result.status };
        }
      } catch (e) { continue; }
    }
    // TCP fallback — proxy port is open but HTTP check failed
    try {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(5000);
        sock.connect(parseInt(proxy.port), proxy.ip, () => { sock.destroy(); resolve(true); });
        sock.on('error', (err) => { sock.destroy(); reject(err); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
      });
      return { ip: proxy.ip, port: proxy.port, working: true, responseTime: Date.now() - start, detectedIp: '(порт открыт, IP не определён)', status: 0 };
    } catch (e) {
      return { ip: proxy.ip, port: proxy.port, working: false, responseTime: Date.now() - start, error: e.message };
    }
  }

  // Run checks in parallel (batches of 15)
  const results = [];
  for (let i = 0; i < toCheck.length; i += 15) {
    const batch = toCheck.slice(i, i + 15);
    const batchResults = await Promise.all(batch.map(p => checkOneProxy(p)));
    results.push(...batchResults);
  }

  res.json({ results });
});

// ==================== TOP HOSTS AGGREGATION (auto-nightly) ====================
const TOP_HOSTS_CACHE_FILE = path.join(__dirname, 'top_hosts_cache.json');

let topHostsCache = { data: {}, perPort: {}, updatedAt: null };
try {
  if (fs.existsSync(TOP_HOSTS_CACHE_FILE)) {
    topHostsCache = JSON.parse(fs.readFileSync(TOP_HOSTS_CACHE_FILE, 'utf8'));
    if (!topHostsCache.perPort) topHostsCache.perPort = {};
  }
} catch (e) { console.error('Failed to load top_hosts cache:', e.message); }

async function aggregateTopHosts() {
  console.log('[TopHosts] Starting aggregation...');
  const merged = {};
  const perPort = {};
  let fetchedCount = 0;
  let errorCount = 0;

  for (const server of apiServers) {
    try {
      const [portsResult, bwResult] = await Promise.all([
        fetchApi(server, '/apix/list_ports_json'),
        fetchApi(server, '/apix/bandwidth_report_all')
      ]);

      const portNameMap = {};
      if (bwResult && typeof bwResult === 'object') {
        for (const [portId, b] of Object.entries(bwResult)) {
          if (b.portName) portNameMap[portId] = b.portName;
        }
      }

      const portKeys = portsResult ? Object.keys(portsResult).filter(k => k !== 'raw') : [];
      console.log(`[TopHosts] ${server.name} list_ports_json: ${portKeys.length} IMEIs`);

      let portsMap = {};
      if (portsResult && typeof portsResult === 'object' && !portsResult.raw) {
        portsMap = portsResult;
      } else if (portsResult && portsResult.raw) {
        try { portsMap = JSON.parse(portsResult.raw); } catch(e) { console.log('[TopHosts] Failed to parse raw'); }
      }

      const portIds = [];
      for (const imei in portsMap) {
        if (imei === 'raw' || imei === '_server') continue;
        const ports = portsMap[imei];
        if (Array.isArray(ports)) {
          ports.forEach(p => { if (p.portID) portIds.push(p.portID); });
        }
      }
      console.log(`[TopHosts] ${server.name}: found ${portIds.length} ports to scan`);

      for (const portId of portIds) {
        try {
          const result = await fetchApi(server, `/apix/top_hosts?arg=${encodeURIComponent(portId)}`, 15000);
          if (result && typeof result === 'object') {
            let entries = [];
            if (Array.isArray(result)) entries = result;
            else {
              for (const k in result) {
                if (k !== 'raw' && typeof result[k] !== 'object') entries.push({ host: k, count: parseInt(result[k]) || 0 });
              }
            }

            const portName = portNameMap[portId] || portId;

            entries.forEach(e => {
              const h = e.host || e.domain || 'unknown';
              const count = e.count || e.requests || 1;
              merged[h] = (merged[h] || 0) + count;
              if (!perPort[portName]) perPort[portName] = {};
              perPort[portName][h] = (perPort[portName][h] || 0) + count;
            });
            if (entries.length > 0) fetchedCount++;
          }
        } catch (e) { errorCount++; }
      }
    } catch (e) {
      console.error(`[TopHosts] Error on server ${server.name}:`, e.message);
      errorCount++;
    }
  }

  topHostsCache = {
    data: merged,
    perPort,
    updatedAt: new Date().toISOString(),
    stats: { domains: Object.keys(merged).length, portsScanned: fetchedCount, errors: errorCount }
  };
  safeWriteFile(TOP_HOSTS_CACHE_FILE, JSON.stringify(topHostsCache, null, 2));
  console.log(`[TopHosts] Aggregation complete: ${Object.keys(merged).length} domains from ${fetchedCount} ports (${errorCount} errors), ${Object.keys(perPort).length} portNames`);
  return topHostsCache;
}

app.get('/api/admin/top_hosts_aggregated', authMiddleware, adminMiddleware, (req, res) => {
  res.json(topHostsCache);
});

app.post('/api/admin/top_hosts_refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await aggregateTopHosts();
    res.json({ ok: true, stats: result.stats, updatedAt: result.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SCHEDULERS ====================

// Dynamic speedtest scheduler (supports multiple times per day)
let speedtestTimers = [];

function rescheduleSpeedtests() {
  // Clear existing timers
  speedtestTimers.forEach(t => { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); });
  speedtestTimers = [];

  const times = appSettings.speedtest_times || ['02:00', '14:00'];
  for (const timeStr of times) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    scheduleRepeating(parts[0], parts[1], 'Speedtest-' + timeStr, runNightlySpeedtests);
  }
}

function scheduleRepeating(hour, minute, label, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  const entry = {};
  entry.timeout = setTimeout(() => {
    fn().catch(e => console.error(`[${label}] Error:`, e.message));
    entry.interval = setInterval(() => {
      fn().catch(e => console.error(`[${label}] Error:`, e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  speedtestTimers.push(entry);
}

// OPT-02: scheduleNightly removed — use scheduleRepeating directly

// ==================== DAILY BILLING ====================
// Single flow: fetch → save daily_traffic → charge → retry on failure
async function runDailyBilling(retryClientIds) {
  const isRetry = Array.isArray(retryClientIds) && retryClientIds.length > 0;
  console.log(`[Billing] Starting ${isRetry ? 'RETRY' : 'daily'} billing run...`);

  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    console.error('[Billing] Failed to fetch server data:', e.message);
    lastBillingRunSummary = { error: e.message, timestamp: new Date().toISOString() };
    return;
  }

  // Refresh global portKey mapping for reconciliation/analytics
  refreshPortKeyMapping(results);

  const yesterdayStr = getMoscowYesterday();
  const moscowYesterday = getMoscowNow();
  moscowYesterday.setDate(moscowYesterday.getDate() - 1);
  const yesterdayLabel = moscowYesterday.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let charged = 0, skipped = 0;
  const skippedClients = []; // for retry

  // 1. Save ALL ports' yesterday traffic to dailyTraffic (single source of truth)
  for (const data of results) {
    if (data._cached || typeof data.bw !== 'object') continue;
    const prefix = data.serverName + '_';
    for (const [portId, b] of Object.entries(data.bw)) {
      if (!b.portName) continue;
      const key = prefix + portId;
      if (!dailyTraffic[key]) dailyTraffic[key] = {};
      if (!dailyTraffic[key][yesterdayStr]) {
        const yIn = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
        const yOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
        if (yIn > 0 || yOut > 0) {
          dailyTraffic[key][yesterdayStr] = { in: yIn, out: yOut, portName: b.portName };
        }
      }
    }
  }

  // 2. Bill each client
  const clientsToBill = isRetry
    ? clients.filter(c => retryClientIds.includes(c.id))
    : clients;

  for (const client of clientsToBill) {
    if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) {
      if (client.billingPaused) console.log(`[Billing] Skipping ${client.name} — billing paused`);
      skipped++;
      continue;
    }

    // Check server availability for this client's ports
    const cachedServers = getClientCachedServers(results, client.portName);
    if (cachedServers.length > 0 || results.length < apiServers.length) {
      const reason = cachedServers.length > 0
        ? `cached data on [${cachedServers.join(', ')}]`
        : `only ${results.length}/${apiServers.length} servers`;
      console.log(`[Billing] Skipping ${client.name}: ${reason}`);
      skippedClients.push(client.id);
      skipped++;
      continue;
    }

    try {
      const deltaBytes = computeClientYesterdayBytes(results, client.portName);
      const deltaGb = trafficBytesToGb(deltaBytes);

      // Update snapshot for diagnostics
      client.last_traffic_snapshot = {
        timestamp: new Date().toISOString(),
        month_bytes: computeClientMonthBytes(results, client.portName)
      };

      if (deltaBytes <= 0) {
        skipped++;
        continue;
      }

      // Compute cost
      let cost = 0;
      if (client.billingType === 'per_modem') {
        let modemCount = 0;
        for (const data of results) {
          if (typeof data.bw === 'object') {
            for (const [portId, b] of Object.entries(data.bw)) {
              if (b.portName === client.portName) modemCount++;
            }
          }
        }
        const mn = getMoscowNow();
        const daysInMonth = new Date(mn.getFullYear(), mn.getMonth() + 1, 0).getDate();
        cost = (client.price * modemCount) / daysInMonth;
      } else {
        cost = client.price * deltaGb;
      }
      cost = Math.round(cost * 100) / 100;
      if (cost <= 0) { skipped++; continue; }

      atomicDebit(client.id, cost, {
        type: 'charge',
        date: yesterdayStr,
        timestamp: new Date().toISOString(),
        delta_bytes: Math.round(deltaBytes),
        delta_gb: deltaGb,
        price_per_unit: client.price,
        billing_type: client.billingType || 'per_gb',
        cost,
        currency: client.currency || 'RUB',
        note: `Списание за трафик (${yesterdayLabel})`,
        traffic_source: 'daily_billing'
      });

      charged++;
      console.log(`[Billing] ${client.name}: ${deltaGb}GB, ${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
    } catch (e) {
      console.error(`[Billing] Error billing ${client.name}:`, e.message);
    }
  }

  saveClients(clients);
  saveDailyTraffic();

  lastBillingRunSummary = {
    timestamp: new Date().toISOString(),
    billed_date: yesterdayStr,
    charged,
    skipped,
    skipped_clients: skippedClients,
    is_retry: isRetry
  };

  console.log(`[Billing] Complete: ${charged} charged, ${skipped} skipped`);

  // 3. Schedule retry if clients were skipped due to server issues (max 1 retry, not on retry runs)
  if (!isRetry && skippedClients.length > 0) {
    console.log(`[Billing] Scheduling retry in 1 hour for ${skippedClients.length} skipped client(s)...`);
    setTimeout(() => {
      runDailyBilling(skippedClients).catch(e => console.error('[Billing] Retry error:', e.message));
    }, 60 * 60 * 1000);
  }
}

// ==================== MONTHLY RECONCILIATION ====================
// Runs on 1st of each month at 03:00 UTC (06:00 MSK), before acts generation
async function runMonthlyReconciliation() {
  const mn = getMoscowNow();
  const currentMonth = getMoscowToday().slice(0, 7); // "YYYY-MM"

  // Only run on 1st of month
  if (mn.getDate() !== 1) {
    console.log('[MonthlyRecon] Not 1st of month, skipping');
    return;
  }

  // Guard: don't run twice for same month
  // Previous month is what we reconcile
  const prevMonth = new Date(mn.getFullYear(), mn.getMonth() - 1, 1);
  const prevMonthStr = prevMonth.toLocaleDateString('en-CA').slice(0, 7); // "YYYY-MM"
  if (lastReconciliationMonth === prevMonthStr) {
    console.log(`[MonthlyRecon] Already reconciled ${prevMonthStr}, skipping`);
    return;
  }

  console.log(`[MonthlyRecon] Starting reconciliation for ${prevMonthStr}...`);

  // Refresh port mapping
  try {
    const results = await fetchAllServersDataCached();
    refreshPortKeyMapping(results);
  } catch (e) { /* mapping may already be populated */ }

  let corrections = 0;
  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) continue;

    // Per-modem clients — fixed rate, just log
    if (client.billingType === 'per_modem') {
      console.log(`[MonthlyRecon] ${client.name}: per_modem — skipped (fixed rate)`);
      continue;
    }

    const storedBytes = getClientStoredMonthBytes(client.portName, prevMonthStr);
    const storedGb = trafficBytesToGb(storedBytes);

    const entries = billingLedger[client.id] || [];
    const monthCharges = entries.filter(e =>
      e.type === 'charge' && e.date && e.date.startsWith(prevMonthStr) &&
      (!e.traffic_source || e.traffic_source !== 'monthly_reconciliation')
    );
    const billedBytes = monthCharges.reduce((s, e) => s + (e.delta_bytes || 0), 0);
    const billedGb = trafficBytesToGb(billedBytes);

    const diffGb = Math.round((storedGb - billedGb) * 1000) / 1000;

    if (diffGb <= 0.01) {
      console.log(`[MonthlyRecon] ${client.name}: ok (stored=${storedGb}GB, billed=${billedGb}GB)`);
      continue;
    }

    // Correction needed
    const correctionCost = Math.round(diffGb * client.price * 100) / 100;
    if (correctionCost <= 0) continue;

    // Last day of previous month as billing date
    const lastDay = new Date(mn.getFullYear(), mn.getMonth(), 0);
    const lastDayStr = lastDay.toLocaleDateString('en-CA');
    const monthLabel = prevMonth.toLocaleDateString('ru-RU', { month: '2-digit', year: 'numeric' });

    atomicDebit(client.id, correctionCost, {
      type: 'charge',
      date: lastDayStr,
      timestamp: new Date().toISOString(),
      delta_bytes: Math.round((storedBytes - billedBytes)),
      delta_gb: diffGb,
      price_per_unit: client.price,
      billing_type: 'per_gb',
      cost: correctionCost,
      currency: client.currency || 'RUB',
      note: `Корректировка за месяц (${monthLabel})`,
      traffic_source: 'monthly_reconciliation'
    });

    corrections++;
    console.log(`[MonthlyRecon] ${client.name}: +${diffGb}GB (+${correctionCost}₽)`);
  }

  lastReconciliationMonth = prevMonthStr;
  saveClients(clients);
  console.log(`[MonthlyRecon] Complete: ${corrections} correction(s)`);
}

// ==================== AUTO-CREATE MISSING CLIENTS ====================

async function autoCreateMissingClients() {
  try {
    const results = await fetchAllServersData();
    const existingPortNames = new Set(clients.map(c => c.portName));
    const allPortNames = new Set();

    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName) {
            allPortNames.add(b.portName);
          }
        }
      }
    }

    // Count ports per portName for pricing
    const portCountMap = {};
    for (const data of results) {
      if (typeof data.bw === 'object') {
        for (const [portId, b] of Object.entries(data.bw)) {
          if (b.portName) {
            portCountMap[b.portName] = (portCountMap[b.portName] || 0) + 1;
          }
        }
      }
    }

    const IGNORED_PORTNAMES = new Set(['Test', 'test', 'TEST', 'Не назначен', '', 'debug', 'Demo', 'demo']);
    let created = 0;
    for (const pn of allPortNames) {
      if (existingPortNames.has(pn)) continue;
      if (IGNORED_PORTNAMES.has(pn)) continue;
      const login = pn.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (users[login]) continue;

      const proxyCount = portCountMap[pn] || 1;
      const autoPrice = getPriceForProxyCount(proxyCount);
      const password = crypto.randomBytes(8).toString('hex');
      const passwordHash = bcrypt.hashSync(password, 10);
      const client = {
        id: generateId(),
        name: pn,
        portName: pn,
        login: login,
        password: password,
        passwordHash: passwordHash,
        contact: '',
        notes: 'Auto-created from portName',
        billingType: 'per_gb',
        price: autoPrice,
        currency: 'RUB',
        payments: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        documents: [],
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      users[login] = { passwordHash, portNameFilter: pn, source: 'client', clientId: client.id };
      created++;
      console.log(`  Auto-created client: login=${login}, portName=${pn}`);
    }

    if (created > 0) {
      saveClients(clients);
      rebuildClientMaps();
      console.log(`[AutoCreate] Created ${created} new client(s)`);
    } else {
      console.log('[AutoCreate] All portNames have client accounts');
    }
  } catch (e) {
    console.error('[AutoCreate] Error:', e.message);
  }
}

// ==================== PAGES ====================

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== API DOCUMENTATION ====================

app.get('/api/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    title: 'Proxies.Rent API Documentation',
    version: '1.0',
    baseUrl,
    authentication: {
      description: 'Используйте API ключ из вашего личного кабинета',
      methods: [
        { name: 'Query parameter', example: `${baseUrl}/api/v1/proxies?apiKey=YOUR_API_KEY` },
        { name: 'Session token', header: 'X-Auth-Token', description: 'Получается через /api/login' }
      ]
    },
    endpoints: {
      public: [
        {
          method: 'GET',
          path: '/api/v1/proxies',
          description: 'Получить список всех ваших прокси',
          params: {
            apiKey: { required: true, description: 'Ваш API ключ (найдите в личном кабинете)' },
            format: { required: false, default: 'json', options: ['json', 'txt', 'csv'], description: 'Формат ответа' }
          },
          examples: {
            json: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=json"`,
            txt: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=txt"`,
            csv: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=csv"`
          },
          response_json: {
            proxies: [{ modem: 'MD2_64', ip: '89.149.100.92', httpPort: 8040, socksPort: 9040, login: 'user', password: 'pass', resetUrl: 'http://...' }],
            count: 1,
            client: 'ClientName'
          },
          response_txt: 'ip:port:login:password|reset_url (по одному на строку)'
        },
        {
          method: 'GET',
          path: '/api/client/reset_ip_by_token',
          description: 'Сброс IP модема по токену (не требует авторизации)',
          params: {
            nick: { required: true, description: 'Ник модема (например MD2_64)' },
            token: { required: true, description: 'Токен сброса из вашего аккаунта' }
          },
          example: `curl "${baseUrl}/api/client/reset_ip_by_token?nick=MD2_64&token=YOUR_TOKEN"`
        }
      ],
      authenticated: [
        {
          method: 'POST',
          path: '/api/login',
          description: 'Авторизация — получение токена сессии',
          body: { login: 'string', password: 'string' },
          response: { token: 'string', login: 'string', isAdmin: 'boolean' }
        },
        {
          method: 'GET',
          path: '/api/client/data',
          description: 'Получить все данные клиента (модемы, трафик, порты)',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'GET',
          path: '/api/client/credentials_export',
          description: 'Экспорт доступов прокси с прямыми ссылками на смену IP',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
        },
        {
          method: 'POST',
          path: '/api/client/reset_ip',
          description: 'Сброс IP модема',
          headers: { 'X-Auth-Token': 'YOUR_TOKEN', 'Content-Type': 'application/json' },
          body: { imei: 'IMEI модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/rotation_log',
          description: 'Лог ротации IP модема',
          params: { nick: 'Ник модема', serverName: 'S1 или S2' }
        },
        {
          method: 'GET',
          path: '/api/client/ip_history',
          description: 'История смены IP с точными временными метками',
          params: { key: 'IMEI ключ (формат: S1_IMEI или S2_IMEI)' }
        },
        {
          method: 'GET',
          path: '/api/client/referral',
          description: 'Информация о партнёрской программе'
        },
        {
          method: 'GET',
          path: '/api/client/documents',
          description: 'Список закрывающих документов'
        },
        {
          method: 'POST',
          path: '/api/tools/check_proxy',
          description: 'Проверка работоспособности прокси (макс. 50 штук)',
          body: { proxies: [{ ip: 'string', port: 'number', login: 'string (опц.)', password: 'string (опц.)' }] }
        }
      ]
    },
    formats: {
      txt: 'ip:port:login:password|direct_reset_url',
      csv: 'ip,http_port,socks_port,login,password,reset_url',
      json: 'Полный JSON объект со всеми данными'
    },
    notes: [
      'Ссылка для смены IP работает напрямую с сервером — не требует работы нашего сервера',
      'API ключ можно найти в личном кабинете',
      'Спидтесты выполняются автоматически в 02:00 и 14:00 UTC',
      'IP история обновляется каждые 10 минут'
    ]
  });
});

// ==================== TOCHKA BANK: WEBHOOK (public, no auth) ====================

// Accept raw text body for webhook
app.post('/api/tochka/webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  console.log('[Tochka Webhook] Received webhook');
  try {
    // Body is JWT string
    const jwtToken = typeof req.body === 'string' ? req.body.trim() : JSON.stringify(req.body);

    // SEC-02: Verify JWT signature before processing
    const { verified, payload, reason } = await verifyJwtSignature(jwtToken);
    if (!payload) {
      console.error('[Tochka Webhook] Failed to decode JWT payload');
      return res.status(200).json({ ok: true, processed: false, reason: 'invalid_jwt' });
    }
    if (!verified) {
      console.warn(`[Tochka Webhook] JWT signature NOT verified (reason: ${reason}). Processing anyway with warning.`);
      // Log unverified webhooks for audit
    } else {
      console.log('[Tochka Webhook] JWT signature verified successfully');
    }

    console.log('[Tochka Webhook] Decoded payload:', JSON.stringify(payload).slice(0, 500));

    const webhookType = payload.webhookType || '';
    const payerInn = payload.SidePayer?.inn || '';
    const payerName = payload.SidePayer?.name || '';
    // BUG-07 fix: payload.amount takes priority (top-level is the actual payment amount)
    // TASK-09: Round amount to 2 decimal places to avoid floating-point drift
    const amount = Math.round(parseFloat(payload.amount || payload.SidePayer?.amount || '0') * 100) / 100;
    if (isNaN(amount) || amount <= 0 || amount > 100000000) {
      console.warn(`[Tochka Webhook] Invalid amount: ${amount}, skipping auto-credit`);
      return res.status(200).json({ ok: true, processed: false, reason: 'invalid_amount' });
    }
    const purpose = payload.purpose || '';
    const paymentId = payload.paymentId || '';
    const paymentDate = payload.date || new Date().toISOString().slice(0, 10);
    const customerCode = payload.customerCode || '';

    // TASK-C: Deduplicate — skip if paymentId already processed (SQLite query)
    if (paymentId && dbStmts.findBankPaymentByPaymentId.get(paymentId)) {
      console.log(`[Tochka Webhook] Duplicate paymentId=${paymentId}, skipping`);
      return res.status(200).json({ ok: true, processed: false, reason: 'duplicate' });
    }

    // Log the payment
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
      receivedAt: new Date().toISOString(),
      matched: false,
      matchedClientId: null,
      autoCredit: false
    };

    // Only process incoming payments
    if (webhookType === 'incomingPayment') {
      // Find client by INN
      const matchedClient = payerInn ? clientByInn.get(payerInn) : null;

      if (matchedClient) {
        bankPayment.matched = true;
        bankPayment.matchedClientId = matchedClient.id;
        bankPayment.matchedClientName = matchedClient.name;

        // BUG-02 fix: Atomic credit + ledger in ONE transaction
        {
          // Add payment record
          if (!matchedClient.payments) matchedClient.payments = [];
          matchedClient.payments.push({
            amount,
            date: paymentDate,
            note: `Банк Точка: ${payerName} — ${purpose}`.slice(0, 200),
            createdAt: new Date().toISOString(),
            source: 'tochka_webhook',
            paymentId
          });

          const { balanceBefore, balanceAfter } = atomicCredit(matchedClient.id, amount, {
            type: 'bank_payment',
            date: paymentDate,
            timestamp: new Date().toISOString(),
            amount,
            currency: 'RUB',
            note: `Банк Точка (ИНН: ${payerInn}): ${purpose}`.slice(0, 300),
            source: 'tochka_webhook',
            paymentId
          });

          // BUG-09 fix: Referral commission — O(1) lookup, round, persist to DB
          if (matchedClient.referred_by) {
            const referrer = clientById.get(matchedClient.referred_by);
            if (referrer) {
              const commission = Math.round(amount * 0.15 * 100) / 100;
              referrer.referral_balance = Math.round(((referrer.referral_balance || 0) + commission) * 100) / 100;
              _clientUpdateReferralBalance.run(referrer.referral_balance, referrer.id);
            }
          }

          bankPayment.autoCredit = true;
          saveClients(clients);
          console.log(`[Tochka Webhook] Auto-credited ${amount} RUB to ${matchedClient.name} (INN: ${payerInn})`);
        }
      } else {
        console.log(`[Tochka Webhook] Unmatched payment: INN=${payerInn}, amount=${amount}, purpose=${purpose}`);
      }
    }

    insertBankPaymentToDb(bankPayment);

    res.status(200).json({ ok: true, processed: true, matched: bankPayment.matched });
  } catch (err) {
    console.error('[Tochka Webhook] Error:', err.message);
    res.status(200).json({ ok: true, processed: false, reason: err.message });
  }
});

// ==================== TOCHKA BANK: ADMIN ENDPOINTS ====================

// Save Tochka config from admin UI
app.post('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  const { jwt, clientId, customerCode, accountId, companyName, companyInn, companyKpp } = req.body;
  if (jwt !== undefined) tochkaConfig.jwt = jwt.trim();
  if (clientId !== undefined) tochkaConfig.clientId = clientId.trim();
  if (customerCode !== undefined) tochkaConfig.customerCode = customerCode.trim();
  if (accountId !== undefined) tochkaConfig.accountId = accountId.trim();
  if (companyName !== undefined) tochkaConfig.companyName = companyName.trim();
  if (companyInn !== undefined) tochkaConfig.companyInn = companyInn.trim();
  if (companyKpp !== undefined) tochkaConfig.companyKpp = companyKpp.trim();
  saveTochkaConfig();
  console.log('[Tochka] Config updated from admin UI, jwt=' + (tochkaConfig.jwt ? 'set' : 'empty') + ', clientId=' + tochkaConfig.clientId);
  res.json({ ok: true, configured: !!tochkaConfig.jwt });
});

// Get Tochka config
app.get('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  res.json({
    jwt: tochkaConfig.jwt ? '****' + tochkaConfig.jwt.slice(-8) : '',
    clientId: tochkaConfig.clientId,
    customerCode: tochkaConfig.customerCode,
    accountId: tochkaConfig.accountId,
    companyName: tochkaConfig.companyName,
    companyInn: tochkaConfig.companyInn,
    companyKpp: tochkaConfig.companyKpp
  });
});

// Auto-detect Customer Code and Account ID from Tochka API
app.post('/api/admin/tochka/autodetect', authMiddleware, adminMiddleware, async (req, res) => {
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
      console.log('[Tochka Autodetect] Customers raw:', JSON.stringify(custResult.data).slice(0, 500));
      if (Array.isArray(customers) && customers.length > 0) {
        const c = customers[0];
        results.customerCode = c.customerCode || c.CustomerCode || c.code || '';
        results.companyName = c.fullName || c.shortName || c.name || c.Name || c.organizationName || '';
        results.companyInn = c.taxCode || c.inn || c.Inn || c.INN || '';
        results.companyKpp = c.kpp || c.Kpp || c.KPP || '';
      }
    } catch (e) { console.log('[Tochka Autodetect] Customers error:', e.message); }
    // 2. Get accounts list -> accountId
    try {
      const accResult = await tochkaRequest('GET', '/uapi/open-banking/v1.0/accounts');
      const ad = accResult.data?.Data || accResult.data || {};
      const accounts = ad.Account || ad.Accounts || ad.accounts || (Array.isArray(ad) ? ad : []);
      console.log('[Tochka Autodetect] Accounts raw:', JSON.stringify(accResult.data).slice(0, 500));
      if (Array.isArray(accounts) && accounts.length > 0) {
        const rub = accounts.find(a => (a.currency === 'RUB' || a.Currency === 'RUB')) || accounts[0];
        results.accountId = rub.accountId || rub.AccountId || rub.resourceId || '';
        if (!results.customerCode && rub.customerCode) results.customerCode = rub.customerCode;
      }
    } catch (e) { console.log('[Tochka Autodetect] Accounts error:', e.message); }
    // Save detected values
    if (results.customerCode) tochkaConfig.customerCode = results.customerCode;
    if (results.accountId) tochkaConfig.accountId = results.accountId;
    if (results.companyName) tochkaConfig.companyName = results.companyName;
    if (results.companyInn) tochkaConfig.companyInn = results.companyInn;
    if (results.companyKpp) tochkaConfig.companyKpp = results.companyKpp;
    saveTochkaConfig();
    console.log('[Tochka Autodetect] Results:', JSON.stringify(results));
    res.json({ ok: true, detected: results });
  } catch (err) {
    res.status(502).json({ error: 'Ошибка автоопределения', details: err.message });
  }
});

// Register webhook in Tochka
app.post('/api/admin/tochka/register_webhook', authMiddleware, adminMiddleware, async (req, res) => {
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
    console.log('[Tochka] Webhook registered:', JSON.stringify(result.data));
    res.json({ ok: true, result: result.data });
  } catch (err) {
    res.status(502).json({ error: 'Failed to register webhook', details: err.message });
  }
});

// Sync historical payments from Tochka (Init Statement → poll → match)
app.post('/api/admin/tochka/sync', authMiddleware, adminMiddleware, async (req, res) => {
  if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
    return res.status(400).json({ error: 'Tochka API не настроен. Заполните JWT и Account ID.' });
  }

  const { dateFrom, dateTo } = req.body;
  const from = dateFrom || '2024-01-01';
  const to = dateTo || new Date().toISOString().slice(0, 10);

  console.log(`[Tochka Sync] Requesting statement ${from} — ${to}`);

  try {
    // Step 1: Init Statement
    const initResult = await tochkaRequest('POST', '/uapi/open-banking/v1.0/statements', {
      Data: {
        Statement: {
          accountId: tochkaConfig.accountId,
          startDateTime: from + 'T00:00:00+00:00',
          endDateTime: to + 'T00:00:00+00:00'
        }
      }
    });

    const statementId = initResult.data?.Data?.Statement?.statementId
      || initResult.data?.Data?.statementId
      || initResult.data?.statementId;

    if (!statementId) {
      console.log('[Tochka Sync] Init response:', JSON.stringify(initResult.data));
      return res.status(502).json({ error: 'Не удалось создать выписку', details: initResult.data });
    }

    console.log(`[Tochka Sync] Statement initiated: ${statementId}`);

    // Step 2: Poll for Ready status (max 30 seconds)
    let statement = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const getResult = await tochkaRequest('GET',
        `/uapi/open-banking/v1.0/accounts/${tochkaConfig.accountId}/statements/${statementId}`);
      const stData = getResult.data?.Data?.Statement?.[0] || getResult.data?.Data?.Statement || getResult.data;
      const status = stData?.status || stData?.Status || '';
      console.log(`[Tochka Sync] Poll #${attempt + 1}: status=${status}`);
      if (status === 'Ready' || status === 'ready') {
        statement = stData;
        break;
      }
    }

    if (!statement) {
      return res.status(504).json({ error: 'Выписка не готова. Попробуйте позже.' });
    }

    // Step 3: Extract transactions
    const transactions = statement.Transaction || statement.transactions || [];
    console.log(`[Tochka Sync] Got ${transactions.length} transactions`);

    let imported = 0, matched = 0, skipped = 0;
    let loggedSample = false;

    for (const tx of transactions) {
      // Only process incoming (credit) payments
      const indicator = tx.creditDebitIndicator || tx.CreditDebitIndicator || '';
      if (indicator !== 'Credit' && indicator !== 'credit') continue;

      if (!loggedSample) {
        console.log('[Tochka Sync] Sample credit transaction:', JSON.stringify(tx).slice(0, 1500));
        loggedSample = true;
      }

      // TASK-08: Round amount to 2 decimal places
      const amount = Math.round(parseFloat(tx.Amount?.amount || tx.amount || 0) * 100) / 100;
      // DebtorParty = плательщик (кто платит нам), CreditorParty = получатель
      const debtor = tx.DebtorParty || tx.CounterParty || tx.SidePayer || {};
      const payerInn = debtor.inn || debtor.Inn || debtor.taxCode || '';
      const payerName = debtor.name || debtor.Name || debtor.fullName || '';
      const purpose = tx.description || tx.Description || tx.TransactionInformation || '';
      const paymentId = tx.transactionId || tx.TransactionId || tx.paymentId || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
      const date = tx.documentProcessDate || tx.bookingDateTime || tx.valueDateTime || tx.date || to;

      // Check if already processed (SQLite query)
      const alreadyExists = dbStmts.findBankPaymentByTochkaId.get(paymentId);
      if (alreadyExists) { skipped++; continue; }

      // Create bank payment record
      const bankPayment = {
        id: 'bp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        tochkaPaymentId: paymentId,
        webhookType: 'incomingPayment',
        source: 'sync',
        date: typeof date === 'string' ? date.slice(0, 10) : date,
        amount: amount,
        payerInn: payerInn,
        payerName: payerName,
        purpose: purpose,
        matched: false,
        matchedClientId: null,
        matchedClientName: null,
        receivedAt: new Date().toISOString()
      };

      // Try to match by INN
      if (payerInn) {
        const client = clientByInn.get(payerInn);
        if (client) {
          bankPayment.matched = true;
          bankPayment.matchedClientId = client.id;
          bankPayment.matchedClientName = client.name;

          // BUG-02 fix: Atomic credit + ledger in ONE transaction
          atomicCredit(client.id, amount, {
            type: 'bank_payment',
            amount: Math.round(amount * 100) / 100,
            date: bankPayment.date,
            timestamp: new Date().toISOString(),
            note: 'Синхронизация из Точки: ' + (purpose || '').slice(0, 100),
            source: 'tochka_sync',
            tochkaPaymentId: paymentId
          });
          matched++;
        }
      }

      insertBankPaymentToDb(bankPayment);
      imported++;
    }

    // Save clients (ledger entries already saved incrementally)
    if (imported > 0) {
      saveClients(clients);
    }

    console.log(`[Tochka Sync] Done: ${imported} imported, ${matched} matched, ${skipped} skipped (duplicates)`);
    res.json({ ok: true, total: transactions.length, imported, matched, skipped });

  } catch (err) {
    console.error('[Tochka Sync] Error:', err.message);
    res.status(502).json({ error: 'Ошибка синхронизации', details: err.message });
  }
});

// Get Tochka status / bank payments log
app.get('/api/admin/tochka/payments', authMiddleware, adminMiddleware, (req, res) => {
  const payments = getAllBankPayments();
  res.json({
    configured: !!tochkaConfig.jwt,
    payments,
    unmatchedCount: dbStmts.countUnmatchedPayments.get().cnt
  });
});

// Dismiss unmatched payments (hide them)
app.post('/api/admin/tochka/dismiss_unmatched', authMiddleware, adminMiddleware, (req, res) => {
  const result = dbStmts.dismissAllUnmatched.run();
  console.log(`[Tochka] Dismissed ${result.changes} unmatched payments`);
  res.json({ ok: true, dismissed: result.changes });
});

// Dismiss single payment
app.post('/api/admin/tochka/dismiss_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId } = req.body;
  const row = dbStmts.getBankPaymentById.get(paymentId);
  if (!row) return res.status(404).json({ error: 'Payment not found' });
  dbStmts.dismissBankPayment.run(paymentId);
  res.json({ ok: true });
});

// Manually match unmatched payment to client
app.post('/api/admin/tochka/match_payment', authMiddleware, adminMiddleware, (req, res) => {
  const { paymentId, clientId } = req.body;
  if (!paymentId || !clientId) return res.status(400).json({ error: 'paymentId and clientId required' });

  const bpRow = dbStmts.getBankPaymentById.get(paymentId);
  if (!bpRow) return res.status(404).json({ error: 'Payment not found' });
  const bp = bankPaymentFromRow(bpRow);
  // BUG-08 fix: O(1) lookup
  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // BUG-02 fix: Atomic credit + ledger in ONE transaction
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

  saveClients(clients);
  res.json({ ok: true, balance: client.balance });
});

// ==================== TOCHKA BANK: CLOSING DOCUMENTS ====================

// Create closing document (Акт выполненных работ)
app.post('/api/admin/tochka/create_act', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, period, items } = req.body;
  if (!clientId || !period) return res.status(400).json({ error: 'clientId and period required' });

  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // TASK-06: Use shared helper for act items
  let actItems = items;
  if (!actItems || actItems.length === 0) {
    ({ actItems } = buildActItemsFromLedger(client, period));
  }

  const totalAmount = actItems.reduce((s, i) => s + (i.amount || 0), 0);

  // Try to create via Tochka API if configured
  let tochkaDocumentId = null;
  const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
  if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
    try {
      const actData = buildTochkaActBody(client, period, actItems, actNumber);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaDocumentId = result.data.Data.documentId;
        console.log(`[Tochka] Created act ${tochkaDocumentId} for ${client.name}, period ${period}`);
      } else {
        console.error('[Tochka] Create act response:', JSON.stringify(result.data));
      }
    } catch (err) {
      console.error('[Tochka] Create act error:', err.message);
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

  res.json({ ok: true, document: closingDoc });
});

// Get closing documents for client (client-side)
app.get('/api/client/closing_documents', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json({ documents: [] });
  res.json({ documents: (client.closingDocuments || []).map(d => ({
    id: d.id,
    period: d.period,
    totalAmount: d.totalAmount,
    status: d.status,
    createdAt: d.createdAt,
    actNumber: d.actNumber,
    items: d.items
  }))});
});

// Download closing document PDF from Tochka
app.get('/api/client/closing_documents/:docId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!doc.tochkaDocumentId) {
    return res.status(404).json({ error: 'Документ не связан с Точкой. PDF недоступен.' });
  }

  try {
    const result = await tochkaRequest('GET', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}/file`);
    if (result.buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.actNumber || 'act'}.pdf"`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

// Admin: download closing document PDF
app.get('/api/admin/clients/:id/closing_documents/:docId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
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
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.actNumber || 'act'}.pdf"`);
      res.send(result.buffer);
    } else {
      res.status(502).json({ error: 'Failed to get PDF from Tochka' });
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to get PDF', details: err.message });
  }
});

// Admin: change closing document status (signed/unsigned)
app.post('/api/admin/clients/:id/closing_document_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { docId, status } = req.body;
  if (!docId || !['signed', 'unsigned'].includes(status)) {
    return res.status(400).json({ error: 'docId and status (signed/unsigned) required' });
  }
  const doc = (client.closingDocuments || []).find(d => d.id === docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  doc.status = status;
  if (status === 'signed') doc.signedAt = new Date().toISOString();
  saveClients(clients);
  res.json({ ok: true, document: doc });
});

// Admin: delete closing document
app.delete('/api/admin/clients/:id/closing_document/:docId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const docIdx = (client.closingDocuments || []).findIndex(d => d.id === req.params.docId);
  if (docIdx === -1) return res.status(404).json({ error: 'Document not found' });

  const doc = client.closingDocuments[docIdx];
  // Try to delete from Tochka too
  if (doc.tochkaDocumentId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/closing-documents/${tochkaConfig.customerCode}/${doc.tochkaDocumentId}`);
    } catch (e) { console.warn('[Tochka] Delete doc error:', e.message); }
  }

  client.closingDocuments.splice(docIdx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// Admin: get closing documents for a client
app.get('/api/admin/clients/:id/closing_documents', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.closingDocuments || []);
});

// Admin: get ALL closing documents across all clients (for bank tab overview)
app.get('/api/admin/tochka/all_acts', authMiddleware, adminMiddleware, (req, res) => {
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

// Admin: bulk generate acts for a specific period for all clients with charges
app.post('/api/admin/tochka/generate_acts', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body; // YYYY-MM
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period required (YYYY-MM)' });

  let generated = 0, skipped = 0, errors = 0;
  const results = [];

  for (const client of clients) {
    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) { skipped++; continue; }

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) {
      skipped++;
      results.push({ client: client.name, status: 'exists' });
      continue;
    }

    try {
      // TASK-06: Use shared helper
      const { actItems, totalCost } = buildActItemsFromLedger(client, period);
      if (totalCost <= 0) { skipped++; continue; }

      // Try Tochka API
      let tochkaDocumentId = null;
      const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
      if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
        try {
          const actData = buildTochkaActBody(client, period, actItems, actNumber);
          const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
          if (result.status === 200 && result.data?.Data?.documentId) {
            tochkaDocumentId = result.data.Data.documentId;
          }
        } catch (e) { console.error(`[Tochka BulkActs] API error for ${client.name}:`, e.message); }
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
      console.log(`[Tochka BulkActs] Created act for ${client.name}: ${totalCost} RUB (period ${period})`);
    } catch (e) {
      errors++;
      results.push({ client: client.name, status: 'error', error: e.message });
    }
  }

  if (generated > 0) saveClients(clients);
  auditLog(req.user.login, 'generate_acts', { period: period || 'auto', generated, skipped, errors, ip: getClientIp(req) });
  res.json({ ok: true, generated, skipped, errors, results });
});

// ==================== TOCHKA BANK: BILLS (СЧЕТА НА ОПЛАТУ) ====================

// Create bill for a client
app.post('/api/admin/tochka/create_bill', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, amount: manualAmount, period } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Calculate amount or use manual
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  let serverData = [];
  if (!manualAmount) {
    try { serverData = await fetchAllServersDataCached(); } catch (e) { console.error('[Bills] fetchAllServersData error:', e.message); }
  }
  let amount = manualAmount || calculateMonthlyBillAmount(client, serverData);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Cannot calculate bill amount (no charges found)' });

  const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
  const billDate = now.toISOString().slice(0, 10);

  let tochkaBillId = null;
  if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
    try {
      const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
      const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
      if (result.status === 200 && result.data?.Data?.documentId) {
        tochkaBillId = result.data.Data.documentId;
        console.log(`[Tochka] Created bill ${tochkaBillId} for ${client.name}, amount ${amount}`);
      } else {
        console.error('[Tochka] Create bill response:', JSON.stringify(result.data));
      }
    } catch (err) {
      console.error('[Tochka] Create bill error:', err.message);
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

// Generate bills for all clients
app.post('/api/admin/tochka/generate_bills', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body;
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  const billDate = now.toISOString().slice(0, 10);

  let generated = 0, skipped = 0, errors = 0;
  const results = [];
  let serverData = [];
  try { serverData = await fetchAllServersDataCached(); } catch (e) { console.error('[Bills] fetchAllServersData error:', e.message); }

  for (const client of clients) {
    if (!client.inn) { skipped++; continue; }
    if ((client.bills || []).some(b => b.period === billPeriod)) { skipped++; continue; }

    const amount = calculateMonthlyBillAmount(client, serverData);
    if (!amount || amount <= 0) { skipped++; continue; }

    const billNumber = `СЧЁТ-${billPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
    let tochkaBillId = null;

    if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId) {
      try {
        const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
        const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
        if (result.status === 200 && result.data?.Data?.documentId) {
          tochkaBillId = result.data.Data.documentId;
        } else {
          console.error(`[Tochka] Bill error for ${client.name}:`, JSON.stringify(result.data));
        }
      } catch (err) {
        console.error(`[Tochka] Bill error for ${client.name}:`, err.message);
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

// Get all bills across all clients
app.get('/api/admin/tochka/all_bills', authMiddleware, adminMiddleware, (req, res) => {
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

// Download bill PDF
app.get('/api/admin/clients/:id/bills/:billId/pdf', authMiddleware, adminMiddleware, async (req, res) => {
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

// Change bill status
app.post('/api/admin/clients/:id/bill_status', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { billId, status } = req.body;
  const bill = (client.bills || []).find(b => b.id === billId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  bill.status = status === 'paid' ? 'paid' : 'unpaid';
  saveClients(clients);
  res.json({ ok: true, bill });
});

// Delete bill
app.delete('/api/admin/clients/:id/bill/:billId', authMiddleware, adminMiddleware, async (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const idx = (client.bills || []).findIndex(b => b.id === req.params.billId);
  if (idx === -1) return res.status(404).json({ error: 'Bill not found' });

  const bill = client.bills[idx];
  if (bill.tochkaBillId && tochkaConfig.jwt) {
    try {
      await tochkaRequest('DELETE', `/uapi/invoice/v1.0/bills/${tochkaConfig.customerCode}/${bill.tochkaBillId}`);
    } catch (e) { console.error('[Tochka] Delete bill error:', e.message); }
  }
  client.bills.splice(idx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

// Client-side: get bills
app.get('/api/client/bills', authMiddleware, (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.json({ bills: [] });
  res.json({ bills: (client.bills || []).map(b => ({
    id: b.id,
    period: b.period,
    amount: b.amount,
    status: b.status,
    createdAt: b.createdAt,
    billNumber: b.billNumber,
    hasPdf: !!b.tochkaBillId
  }))});
});

// Client-side: download bill PDF
app.get('/api/client/bills/:billId/pdf', authMiddleware, async (req, res) => {
  const client = clientByLogin.get(req.user.login);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill || !bill.tochkaBillId) return res.status(404).json({ error: 'Bill not found' });

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

// ==================== TOCHKA: AUTO-GENERATE ACTS (1st of month) ====================
async function autoGenerateMonthlyActs() {
  const now = new Date();
  const moscowDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = moscowDate.getDate();
  const hour = moscowDate.getHours();

  // Only run on 1st of month, after 8:00 Moscow time
  if (day !== 1 || hour < 8) return;

  // Previous month
  const prevMonth = new Date(moscowDate);
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  const period = prevMonth.toISOString().slice(0, 7); // YYYY-MM

  // Prevent duplicate generation
  if (lastActGenerationMonth === period) return;

  console.log(`[Tochka AutoActs] Generating acts for period ${period}...`);
  let generated = 0;

  for (const client of clients) {
    // Skip clients with autoActs disabled
    if (client.autoActs === false) continue;

    // Skip clients without charges
    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => e.type === 'charge' && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) continue;

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) continue;

    try {
      // TASK-06: Use shared helper
      const { actItems, totalCost } = buildActItemsFromLedger(client, period);

      // Try Tochka API
      let tochkaDocumentId = null;
      const actNumber = `АКТ-${period.replace('-', '')}-${client.id.slice(0, 4)}`;
      if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId && client.inn) {
        try {
          const actData = buildTochkaActBody(client, period, actItems, actNumber);
          const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/closing-documents', actData);
          if (result.status === 200 && result.data?.Data?.documentId) {
            tochkaDocumentId = result.data.Data.documentId;
          }
        } catch (e) { console.error(`[Tochka AutoActs] API error for ${client.name}:`, e.message); }
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
      console.log(`[Tochka AutoActs] Created act for ${client.name}: ${totalCost} RUB`);
    } catch (e) {
      console.error(`[Tochka AutoActs] Error for ${client.name}:`, e.message);
    }
  }

  if (generated > 0) {
    saveClients(clients);
    console.log(`[Tochka AutoActs] Generated ${generated} acts for ${period}`);
  }
  lastActGenerationMonth = period;
}

// ==================== TOCHKA: AUTO-GENERATE BILLS (1st of month) ====================
async function autoGenerateMonthlyBills() {
  const now = new Date();
  const moscowDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = moscowDate.getDate();
  const hour = moscowDate.getHours();

  // Only run on 1st of month, after 8:00 Moscow time
  if (day !== 1 || hour < 8) return;

  // Current month (bills are for the current month, unlike acts which are for previous)
  const currentPeriod = `${moscowDate.getFullYear()}-${String(moscowDate.getMonth() + 1).padStart(2, '0')}`;

  // Prevent duplicate generation
  if (lastBillGenerationMonth === currentPeriod) return;

  console.log(`[Tochka AutoBills] Generating bills for period ${currentPeriod}...`);
  let generated = 0;
  let serverData = [];
  try { serverData = await fetchAllServersData(); } catch (e) { console.error('[AutoBills] fetchAllServersData error:', e.message); }

  for (const client of clients) {
    // Skip clients with autoBills disabled
    if (client.autoBills === false) continue;

    // Skip clients without INN
    if (!client.inn) continue;

    // Skip if bill already exists for this period
    if ((client.bills || []).some(b => b.period === currentPeriod)) continue;

    try {
      const amount = calculateMonthlyBillAmount(client, serverData);
      if (amount <= 0) {
        console.log(`[Tochka AutoBills] Skipping ${client.name}: amount is 0`);
        continue;
      }

      const billNumber = `СЧЁТ-${currentPeriod.replace('-', '')}-${client.id.slice(0, 4)}`;
      const billDate = `${currentPeriod}-01`;

      let tochkaBillId = null;
      if (tochkaConfig.jwt && tochkaConfig.customerCode && tochkaConfig.accountId) {
        try {
          const billData = buildTochkaBillBody(client, amount, billNumber, billDate);
          const result = await tochkaRequest('POST', '/uapi/invoice/v1.0/bills', billData);
          if (result.status === 200 && result.data?.Data?.documentId) {
            tochkaBillId = result.data.Data.documentId;
          }
        } catch (e) {
          console.error(`[Tochka AutoBills] API error for ${client.name}:`, e.message);
        }
      }

      const billId = crypto.randomBytes(8).toString('hex');
      if (!client.bills) client.bills = [];
      client.bills.push({
        id: billId,
        tochkaBillId,
        period: currentPeriod,
        createdAt: new Date().toISOString(),
        amount,
        status: 'unpaid',
        billNumber,
        billDate
      });
      generated++;
      console.log(`[Tochka AutoBills] Created bill for ${client.name}: ${amount} RUB`);
    } catch (e) {
      console.error(`[Tochka AutoBills] Error for ${client.name}:`, e.message);
    }
  }

  if (generated > 0) {
    saveClients(clients);
    console.log(`[Tochka AutoBills] Generated ${generated} bills for ${currentPeriod}`);
  }
  lastBillGenerationMonth = currentPeriod;
}

// ==================== JSON fallback for unknown API routes (Bug #5) ====================
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.path}`
  });
});

const httpServer = app.listen(PORT, () => {
  console.log(`Proxies.Rent Dashboard running at http://localhost:${PORT}`);

  // Schedule speedtests (configurable times, default 02:00 + 14:00)
  rescheduleSpeedtests();

  // Schedule nightly TopHosts at 03:00
  scheduleRepeating(3, 0, 'TopHosts', aggregateTopHosts);

  // Start modem tracking (IP + uptime)
  const TRACKING_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  console.log(`[Tracking] Starting IP & uptime tracking (every ${TRACKING_INTERVAL_MS / 60000} min)...`);
  trackModems().catch(e => console.error('[Tracking] Initial error:', e.message));
  _intervals.push(setInterval(() => {
    trackModems().catch(e => console.error('[Tracking] Error:', e.message));
  }, TRACKING_INTERVAL_MS));

  // If no cached top_hosts data, do initial aggregation
  if (!topHostsCache.updatedAt) {
    console.log('[TopHosts] No cached data, running initial aggregation...');
    aggregateTopHosts().catch(e => console.error('[TopHosts] Initial error:', e.message));
  }

  // Auto-create client accounts for all portNames that don't have one
  autoCreateMissingClients().catch(e => console.error('[AutoCreate] Error:', e.message));
  // Re-check every 10 minutes so new portNames get accounts without restart
  _intervals.push(setInterval(() => {
    autoCreateMissingClients().catch(e => console.error('[AutoCreate] Error:', e.message));
  }, 10 * 60 * 1000));

  // Schedule daily billing at 01:00 UTC (04:00 MSK, 4h after ProxySmart midnight reset)
  scheduleRepeating(1, 0, 'DailyBilling', runDailyBilling);

  // Monthly reconciliation at 03:00 UTC (06:00 MSK) on 1st of month — before acts
  scheduleRepeating(3, 0, 'MonthlyReconciliation', runMonthlyReconciliation);

  // Auto-generate closing documents (acts) on 1st of each month at 08:05 Moscow (05:05 UTC)
  scheduleRepeating(5, 5, 'MonthlyActs', autoGenerateMonthlyActs);

  // Auto-generate bills on 1st of each month at 08:10 Moscow (05:10 UTC)
  scheduleRepeating(5, 10, 'MonthlyBills', autoGenerateMonthlyBills);

  // Hourly traffic aggregation at :01 each hour (reads day counter delta → stores in traffic_hourly)
  (function scheduleHourlyAgg() {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(1, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    const msUntil = next - now;
    console.log(`[HourlyAgg] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
    setTimeout(() => {
      aggregateHourlyTraffic().catch(e => console.error('[HourlyAgg]', e.message));
      setInterval(() => aggregateHourlyTraffic().catch(e => console.error('[HourlyAgg]', e.message)), 60 * 60 * 1000);
    }, msUntil);
  })();

  // Billing catch-up: if last snapshot is older than 26 hours, run now
  (async () => {
    try {
      const now = Date.now();
      let needsCatchup = false;
      for (const c of clients) {
        if (c.last_traffic_snapshot && c.last_traffic_snapshot.timestamp) {
          const lastRun = new Date(c.last_traffic_snapshot.timestamp).getTime();
          if (now - lastRun > 26 * 60 * 60 * 1000) {
            needsCatchup = true;
            break;
          }
        }
      }
      if (needsCatchup) {
        console.log('[Billing] Catch-up: missed billing detected, running now...');
        await runDailyBilling();
      }
    } catch (e) {
      console.error('[Billing] Catch-up error:', e.message);
    }
  })();
});



// ==================== CRM PAYMENT TRACKING ====================
const CRM_DB_URL = 'postgresql://twenty:TwentyCRM2026x@172.18.0.5:5432/default';
const CRM_WS = 'workspace_1wekp8bkkvyv4c57kfv5uljgp';

async function checkCrmPaymentConfirmations() {
  let pgClient;
  try {
    const { Client } = require('pg');
    pgClient = new Client({ connectionString: CRM_DB_URL });
    await pgClient.connect();

    // Find deals where paymentConfirmed = true
    const confirmed = await pgClient.query(
      `SELECT id, name, "nextPaymentDate", "companyId" FROM "${CRM_WS}".opportunity WHERE "paymentConfirmed" = true AND "deletedAt" IS NULL`
    );

    for (const deal of confirmed.rows) {
      const now = new Date();
      const nextPayment = new Date(now);
      nextPayment.setMonth(nextPayment.getMonth() + 1); // same date next month (JS handles overflow: Jan 31 → Feb 28)
      await pgClient.query(
        `UPDATE "${CRM_WS}".opportunity SET "lastPaymentDate" = $1, "nextPaymentDate" = $2, "paymentConfirmed" = false, "updatedAt" = $1 WHERE id = $3`,
        [now.toISOString(), nextPayment.toISOString(), deal.id]
      );
      console.log(`[CRM] Payment confirmed for deal "${deal.name}": next payment ${nextPayment.toISOString().slice(0, 10)}`);
    }

    // Find deals with nextPaymentDate within 3 days — log reminder
    const reminderDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const upcoming = await pgClient.query(
      `SELECT o.id, o.name, o."nextPaymentDate", o.amount, c.name as company_name
       FROM "${CRM_WS}".opportunity o
       LEFT JOIN "${CRM_WS}".company c ON o."companyId" = c.id
       WHERE o."nextPaymentDate" IS NOT NULL AND o."nextPaymentDate" <= $1 AND o."nextPaymentDate" >= NOW()
       AND o.stage = 'AKTIVNYY_KLIENT' AND o."deletedAt" IS NULL`,
      [reminderDate.toISOString()]
    );

    if (upcoming.rows.length > 0) {
      console.log(`[CRM] Payment reminders (due within 3 days):`);
      for (const deal of upcoming.rows) {
        const dueDate = new Date(deal.nextPaymentDate).toISOString().slice(0, 10);
        console.log(`  - ${deal.company_name || deal.name}: ${deal.amount || '?'} RUB, due ${dueDate}`);
      }
    }

    await pgClient.end();
  } catch (e) {
    if (pgClient) try { await pgClient.end(); } catch (_) {}
    // pg module might not be installed — skip silently
    if (e.code !== 'MODULE_NOT_FOUND') {
      console.error('[CRM] Payment check error:', e.message);
    }
  }
}

// Run CRM payment check every 10 minutes
checkCrmPaymentConfirmations().catch(() => {});
_intervals.push(setInterval(() => {
  checkCrmPaymentConfirmations().catch(() => {});
}, 10 * 60 * 1000));

// ==================== GRACEFUL SHUTDOWN ====================
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

  // TASK-13: Clear all intervals to prevent memory leaks
  for (const iv of _intervals) clearInterval(iv);
  _intervals.length = 0;

  // Stop accepting new connections
  httpServer.close(() => {
    console.log('[Shutdown] HTTP server closed');
  });

  // Wait for pending writes to complete, then close DB and exit
  const allPending = Array.from(_fileLocks.values());
  Promise.all(allPending)
    .then(() => {
      try { db.close(); console.log('[Shutdown] SQLite database closed'); } catch (e) {}
      console.log('[Shutdown] All writes complete. Bye!');
      process.exit(0);
    })
    .catch((e) => {
      try { db.close(); } catch (_) {}
      console.error('[Shutdown] Error during cleanup:', e.message);
      process.exit(1);
    });

  // Force exit after 10 seconds if writes don't complete
  setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
