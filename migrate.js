#!/usr/bin/env node
/**
 * Proxies.Rent Dashboard — JSON to SQLite Migration Script
 * Run once: node migrate.js
 *
 * Migrates data from JSON files to SQLite database (dashboard.db).
 * Safe to run multiple times — uses INSERT OR IGNORE.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'dashboard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

console.log('=== Proxies.Rent JSON → SQLite Migration ===\n');

// Open database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Execute schema
console.log('[1/8] Creating schema...');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);
console.log('  Schema applied successfully.');

// Helper: load JSON file safely
function loadJson(filename, defaultValue = []) {
  const filePath = path.join(__dirname, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`  Warning: Could not read ${filename}:`, e.message);
  }
  return defaultValue;
}

// [2] Migrate clients
console.log('\n[2/8] Migrating clients...');
const clients = loadJson('clients.json');
const insertClient = db.prepare(`
  INSERT OR IGNORE INTO clients (
    id, login, password, password_hash, port_name, name, contact, notes,
    billing_type, price, currency, balance, api_key, referral_code,
    referred_by, referral_balance, reset_token,
    inn, kpp, legal_name, contract_info, address,
    auto_acts, auto_bills, last_traffic_snapshot, created_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?
  )
`);

const insertPaymentStmt = db.prepare(`
  INSERT OR IGNORE INTO payments (client_id, amount, date, note, source, payment_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertDocStmt = db.prepare(`
  INSERT OR IGNORE INTO client_documents (id, client_id, name, file_name, mime_type, date)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertClosingDocStmt = db.prepare(`
  INSERT OR IGNORE INTO closing_documents (id, client_id, tochka_doc_id, period, type, act_number, items, total_amount, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertBillStmt = db.prepare(`
  INSERT OR IGNORE INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

let clientCount = 0, paymentCount = 0, docCount = 0, closingDocCount = 0, billCount = 0;

const migrateClientsTransaction = db.transaction(() => {
  for (const c of clients) {
    insertClient.run(
      c.id, c.login, c.password || '', c.passwordHash || '', c.portName || '', c.name || '', c.contact || '', c.notes || '',
      c.billingType || 'per_gb', c.price || 0, c.currency || 'RUB', c.balance || 0, c.apiKey || '', c.referral_code || '',
      c.referred_by || null, c.referral_balance || 0, c.resetToken || '',
      c.inn || '', c.kpp || '', c.legalName || '', c.contractInfo || '', c.address || '',
      c.autoActs !== false ? 1 : 0, c.autoBills !== false ? 1 : 0,
      JSON.stringify(c.last_traffic_snapshot || {}), c.createdAt || new Date().toISOString()
    );
    clientCount++;

    // Payments
    for (const p of (c.payments || [])) {
      insertPaymentStmt.run(
        c.id, p.amount, p.date, p.note || '', p.source || 'manual', p.paymentId || null, p.createdAt || new Date().toISOString()
      );
      paymentCount++;
    }

    // Documents
    for (const d of (c.documents || [])) {
      insertDocStmt.run(d.id, c.id, d.name, d.fileName, d.mimeType || '', d.date || new Date().toISOString());
      docCount++;
    }

    // Closing documents
    for (const cd of (c.closingDocuments || [])) {
      insertClosingDocStmt.run(
        cd.id, c.id, cd.tochkaDocumentId || '', cd.period || '', cd.type || 'act',
        cd.actNumber || '', JSON.stringify(cd.items || []), cd.totalAmount || 0,
        cd.status || 'unsigned', cd.createdAt || new Date().toISOString()
      );
      closingDocCount++;
    }

    // Bills
    for (const b of (c.bills || [])) {
      insertBillStmt.run(
        b.id, c.id, b.tochkaBillId || '', b.period || '', b.billNumber || '',
        b.amount || 0, b.status || 'unpaid', b.createdAt || new Date().toISOString()
      );
      billCount++;
    }
  }
});

migrateClientsTransaction();
console.log(`  ${clientCount} clients, ${paymentCount} payments, ${docCount} documents, ${closingDocCount} closing docs, ${billCount} bills`);

// [3] Migrate billing ledger
console.log('\n[3/8] Migrating billing ledger...');
const ledger = loadJson('billing_ledger.json', {});
const insertLedger = db.prepare(`
  INSERT INTO billing_ledger (client_id, type, date, timestamp, amount, currency, balance_before, balance_after, gb_used, modem_count, days_in_month, note, source, payment_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let ledgerCount = 0;
const migrateLedgerTransaction = db.transaction(() => {
  for (const [clientId, entries] of Object.entries(ledger)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      insertLedger.run(
        clientId, e.type || '', e.date || '', e.timestamp || '', e.amount || 0,
        e.currency || 'RUB', e.balance_before ?? null, e.balance_after ?? null,
        e.gb_used ?? null, e.modem_count ?? null, e.days_in_month ?? null,
        e.note || '', e.source || null, e.paymentId || null
      );
      ledgerCount++;
    }
  }
});
migrateLedgerTransaction();
console.log(`  ${ledgerCount} ledger entries`);

// [4] Migrate sessions
console.log('\n[4/8] Migrating sessions...');
const sessions = loadJson('sessions.json', {});
const insertSession = db.prepare(`
  INSERT OR IGNORE INTO sessions (token, login, port_name_filter, is_admin, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);

let sessionCount = 0;
const now = Date.now();
const migrateSessionsTransaction = db.transaction(() => {
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.expiresAt && sess.expiresAt > now) {
      insertSession.run(token, sess.login, sess.portNameFilter || '', sess.isAdmin ? 1 : 0, sess.expiresAt);
      sessionCount++;
    }
  }
});
migrateSessionsTransaction();
console.log(`  ${sessionCount} active sessions (expired sessions skipped)`);

// [5] Migrate bank payments
console.log('\n[5/8] Migrating bank payments...');
const bankPayments = loadJson('bank_payments.json');
const insertBankPayment = db.prepare(`
  INSERT OR IGNORE INTO bank_payments (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date, customer_code, matched, matched_client_id, matched_client_name, auto_credit, dismissed, source, tochka_payment_id, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let bpCount = 0;
const migrateBpTransaction = db.transaction(() => {
  for (const bp of bankPayments) {
    insertBankPayment.run(
      bp.id, bp.webhookType || '', bp.payerInn || '', bp.payerName || '', bp.amount || 0,
      bp.purpose || '', bp.paymentId || '', bp.date || '', bp.customerCode || '',
      bp.matched ? 1 : 0, bp.matchedClientId || null, bp.matchedClientName || null,
      bp.autoCredit ? 1 : 0, bp.dismissed ? 1 : 0, bp.source || '',
      bp.tochkaPaymentId || null, bp.receivedAt || new Date().toISOString()
    );
    bpCount++;
  }
});
migrateBpTransaction();
console.log(`  ${bpCount} bank payments`);

// [6] Migrate IP tracking, uptime tracking, IP history
console.log('\n[6/8] Migrating tracking data...');
const ipTracking = loadJson('ip_tracking.json', {});
const uptimeTracking = loadJson('uptime_tracking.json', {});
const ipHistory = loadJson('ip_history.json', {});

const insertIpTracking = db.prepare('INSERT OR REPLACE INTO ip_tracking (key, ip, updated_at) VALUES (?, ?, ?)');
const insertUptimeTracking = db.prepare('INSERT OR REPLACE INTO uptime_tracking (key, data) VALUES (?, ?)');
const insertIpHistory = db.prepare('INSERT INTO ip_history (key, ip, started_at, ended_at) VALUES (?, ?, ?, ?)');

let ipCount = 0, uptimeCount = 0, historyCount = 0;
const migrateTrackingTransaction = db.transaction(() => {
  for (const [key, data] of Object.entries(ipTracking)) {
    insertIpTracking.run(key, data.ip || '', data.updatedAt || '');
    ipCount++;
  }
  for (const [key, data] of Object.entries(uptimeTracking)) {
    insertUptimeTracking.run(key, JSON.stringify(data));
    uptimeCount++;
  }
  for (const [key, entries] of Object.entries(ipHistory)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      insertIpHistory.run(key, e.ip || '', e.startedAt || '', e.endedAt || '');
      historyCount++;
    }
  }
});
migrateTrackingTransaction();
console.log(`  ${ipCount} IP records, ${uptimeCount} uptime records, ${historyCount} IP history entries`);

// [7] Migrate daily traffic
console.log('\n[7/8] Migrating daily traffic...');
const dailyTraffic = loadJson('daily_traffic.json', {});
const insertDailyTraffic = db.prepare('INSERT OR REPLACE INTO daily_traffic (port_name, date, bytes_in, bytes_out) VALUES (?, ?, ?, ?)');

let trafficCount = 0;
const migrateTrafficTransaction = db.transaction(() => {
  for (const [portName, days] of Object.entries(dailyTraffic)) {
    if (typeof days !== 'object') continue;
    for (const [date, data] of Object.entries(days)) {
      const bytesIn = typeof data === 'object' ? (data.in || 0) : (typeof data === 'number' ? data : 0);
      const bytesOut = typeof data === 'object' ? (data.out || 0) : 0;
      insertDailyTraffic.run(portName, date, bytesIn, bytesOut);
      trafficCount++;
    }
  }
});
migrateTrafficTransaction();
console.log(`  ${trafficCount} daily traffic entries`);

// [8] Migrate telegram data
console.log('\n[8/8] Migrating Telegram data...');
const tgUsers = loadJson('telegram_users.json', {});
const tgProxies = loadJson('telegram_proxies.json');
const tgFeedback = loadJson('telegram_feedback.json');

const insertTgUser = db.prepare(`
  INSERT OR IGNORE INTO telegram_users (chat_id, username, test_used, plan, registered_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertTgSpeedtest = db.prepare(`
  INSERT INTO telegram_speedtests (chat_id, speed, tested_at) VALUES (?, ?, ?)
`);
const insertTgProxy = db.prepare(`
  INSERT INTO telegram_proxies (chat_id, port_name, server, http_port, socks_port, login, password, plan, created_at, expires_at, active)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTgFeedback = db.prepare(`
  INSERT INTO telegram_feedback (chat_id, username, type, score, message, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let tgUserCount = 0, tgSpeedtestCount = 0, tgProxyCount = 0, tgFeedbackCount = 0;
const migrateTgTransaction = db.transaction(() => {
  for (const [chatId, u] of Object.entries(tgUsers)) {
    insertTgUser.run(chatId, u.username || '', u.testUsed ? 1 : 0, u.plan || null, u.registeredAt || '', u.updatedAt || '');
    tgUserCount++;
    for (const st of (u.speedTests || [])) {
      insertTgSpeedtest.run(chatId, st.speed || 0, st.date || '');
      tgSpeedtestCount++;
    }
  }
  for (const p of tgProxies) {
    insertTgProxy.run(
      p.chatId || '', p.portName || '', p.server || '', p.httpPort || 0, p.socksPort || 0,
      p.login || '', p.password || '', p.plan || '', p.createdAt || '', p.expiresAt || '', p.active !== false ? 1 : 0
    );
    tgProxyCount++;
  }
  for (const f of tgFeedback) {
    insertTgFeedback.run(f.chatId || '', f.username || '', f.type || 'text', f.score || null, f.message || '', f.createdAt || '');
    tgFeedbackCount++;
  }
});
migrateTgTransaction();
console.log(`  ${tgUserCount} TG users, ${tgSpeedtestCount} speedtests, ${tgProxyCount} proxies, ${tgFeedbackCount} feedback`);

// Migrate audit log if exists
const auditEntries = loadJson('audit_log.json');
if (auditEntries.length > 0) {
  console.log('\n[Bonus] Migrating audit log...');
  const insertAudit = db.prepare(`
    INSERT INTO audit_log (timestamp, admin, action, details) VALUES (?, ?, ?, ?)
  `);
  const migrateAuditTransaction = db.transaction(() => {
    for (const e of auditEntries) {
      const { timestamp, admin, action, ...rest } = e;
      insertAudit.run(timestamp || '', admin || '', action || '', JSON.stringify(rest));
    }
  });
  migrateAuditTransaction();
  console.log(`  ${auditEntries.length} audit entries`);
}

db.close();

console.log('\n=== Migration Complete ===');
console.log(`Database created at: ${DB_PATH}`);
console.log(`Size: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);
console.log('\nJSON files NOT deleted — verify data before removing them.');
console.log('To verify: sqlite3 dashboard.db "SELECT COUNT(*) FROM clients;"');
