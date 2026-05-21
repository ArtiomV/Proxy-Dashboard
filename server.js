// Skip .env injection under NODE_ENV=test — the supertest harness sets
// its own env in tests/_helpers/setup-env.js and must not be overridden
// by whatever the developer happens to have in .env. Prod path unchanged.
if (process.env.NODE_ENV !== 'test') require('dotenv').config();
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
const { v4: uuidv4 } = require('uuid');
const fsPromises = fs.promises;
const logger = require('./src/logger');
const { validate } = require('./src/middleware/validate');
const { LoginSchema, ClientCreateSchema, ClientUpdateSchema, PaymentSchema, BalanceAdjustSchema } = require('./src/schemas');
const { getTzOffset, getMoscowNow, getMoscowToday, getMoscowYesterday } = require('./src/utils/time');
const { parseTrafficValue, parseBwToBytes, trafficBytesToGb, normalizeOperator } = require('./src/utils/traffic');
const proxySmart = require('./src/api/proxy-smart');
const hourlyTraffic = require('./src/traffic/hourly');
const { escHtml } = require('./src/utils/html');
const { buildDocHtml: _buildDocHtml } = require('./src/documents/generator');
const { safeWriteFile: _safeWriteFile, _fileLocks } = require('./src/utils/files');
const { decodeJwtPayload, decodeJwtHeader, fetchTochkaJwks, jwkToPem, verifyJwtSignature } = require('./src/tochka/jwt');
const { tochkaRequest: _tochkaRequest } = require('./src/tochka/api');
const billing = require('./src/billing/atomic');
const { MONTH_NAMES_RU, buildActItemsFromLedger: _buildActItemsFromLedger, buildTochkaActBody: _buildTochkaActBody, buildTochkaBillBody: _buildTochkaBillBody, calculateMonthlyBillAmount: _calculateMonthlyBillAmount } = require('./src/tochka/documents');
const tgBot = require('./src/telegram/bot');
const tgSummary = require('./src/telegram/daily_summary');
const aiInsights = require('./src/telegram/ai_insights');
const simulator = require('./src/simulator/engine');
const simulatorDb = require('./src/db/simulator');
const paymentsDb = require('./src/db/payments');
const documentsDb = require('./src/db/documents');
const clientsDb = require('./src/db/clients');
const ledgerDb = require('./src/db/ledger');
const { execFile } = require('child_process');
const os = require('os');

// DASHBOARD_DB_PATH override lets tests point at an isolated temp DB
// without disturbing the production path. Unset in prod → identical behavior.
const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, 'dashboard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate traffic_hourly to per-modem schema BEFORE schema apply (v2: server_name+nick+operator+client_name)
try {
  const htExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='traffic_hourly'").get();
  if (htExists) {
    const htInfo = db.prepare("PRAGMA table_info(traffic_hourly)").all();
    const hasNick = htInfo.some(c => c.name === 'nick');
    if (!hasNick) {
      logger.info('[Migration] Recreating traffic_hourly with per-modem columns...');
      db.exec('DROP TABLE IF EXISTS traffic_hourly');
      db.exec('DROP INDEX IF EXISTS idx_traffic_hourly_hour');
      db.exec('DROP INDEX IF EXISTS idx_traffic_hourly_port');
      logger.info('[Migration] traffic_hourly dropped, will be recreated by schema');
    }
  }
} catch (e) { logger.error('[Migration] traffic_hourly pre-check:', e.message); }

// Apply schema on startup (CREATE IF NOT EXISTS is safe to re-run)
if (fs.existsSync(SCHEMA_PATH)) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  logger.info('[SQLite] Schema applied, database ready');
}

// JSON→SQLite migration check
function autoMigrateIfNeeded() {
  const jsonPath = path.join(__dirname, 'clients.json');
  if (!fs.existsSync(jsonPath)) return;
  const clientCount = db.prepare('SELECT COUNT(*) as cnt FROM clients').get().cnt;
  if (clientCount > 0) return;
  logger.error('[Migration] Found clients.json but database is empty.');
  logger.error('[Migration] Run: node migrate.js');
  logger.error('[Migration] Then restart the server.');
  process.exit(1);
}
autoMigrateIfNeeded();

// Run SQL migrations from migrations/ directory
// Benign SQLite errors we can safely ignore when re-running migrations:
// re-applied ALTER TABLE ADD COLUMN, re-applied CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS,
// and similar "already applied" cases. Anything else aborts the migration (fail-fast).
const BENIGN_MIGRATION_ERRORS = [
  /duplicate column name/i,
  /already exists/i,
  /no such column/i,      // safe for UPDATE re-runs that reference a column that was dropped earlier in same file
];
function isBenignMigrationError(err) {
  const msg = (err && err.message) || String(err);
  return BENIGN_MIGRATION_ERRORS.some(rx => rx.test(msg));
}

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      // Run the whole migration in a single atomic transaction.
      // Pre-scan: if the whole file runs as one exec and fails with a non-benign
      // error, roll back AND don't mark as applied.
      db.transaction(() => {
        try {
          db.exec(sql);
        } catch (e) {
          // Fall back to per-statement execution only to tolerate benign
          // "already applied" errors (so re-runs work). Anything else re-throws.
          for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
            try { db.exec(stmt); }
            catch (stmtErr) {
              if (!isBenignMigrationError(stmtErr)) {
                throw new Error(`statement failed: ${stmtErr.message}\n  SQL: ${stmt.slice(0, 200)}`);
              }
            }
          }
        }
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
      logger.info(`[Migration] Applied: ${file}`);
    } catch (e) {
      // Hard fail: migration left DB unchanged; surface the actual error.
      logger.error(`[Migration] FAILED ${file}:`, e.message);
      // Don't silently continue — abort startup so deploy is visibly broken.
      throw new Error(`Migration ${file} failed — aborting startup. ${e.message}`);
    }
  }
}
try {
  runMigrations();
} catch (e) {
  // Migrations failed — abort startup so pm2 records the failure and ops
  // notices the bad deploy. Continuing with mismatched schema risks data
  // corruption far worse than a restart loop.
  logger.error('[Migration] FATAL on startup: ' + (e.stack || e.message));
  process.exit(1);
}

// Domain-DB repositories (Stage 2). Each one wraps prepared statements for
// a table-group and exposes named functions used by routes. Inited here so
// statements are prepared exactly once after migrations have run.
simulatorDb.init(db);
paymentsDb.init(db);
documentsDb.init(db);
clientsDb.init(db);
ledgerDb.init(db);
// Aliases for legacy callsites that still hold raw prepared-statement refs.
// These are passed to billing.init() and used by atomicCredit/atomicDebit
// on the hot path — wrapping in a function would add a per-credit call.
const _clientGetBalance = clientsDb.getBalanceStmt();
const _clientUpdateBalance = clientsDb.updateBalanceStmt();
const _clientUpdateReferralBalance = clientsDb.updateReferralBalanceStmt();
const _ledgerInsert = ledgerDb.insertStmt();

// ─── kv_store loss-prevention layer ────────────────────────────────────────────
// History + refuse-to-shrink guard for critical kv entries. See migration 028.
//
// Each critical key registers a `shape()` function that summarises the value's
// "fill level" (e.g., how many populated metadata fields per server). When a
// new write would strictly REGRESS the shape (any tracked count drops), the
// guard refuses unless explicitly allowed via the `allowRegression` flag —
// catching whole classes of silent data-loss bugs at write-time.
//
// Defined here (right after migrations) so it's available during the
// env↔DB merge at startup, NOT later in the file where most other helpers live.
const _kvGet = db.prepare('SELECT value FROM kv_store WHERE key = ?');
const _kvSet = db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))");
const _kvHistoryInsert = db.prepare(`INSERT INTO kv_store_history (key, old_value, new_value, source, shape_signature, regressed) VALUES (?,?,?,?,?,?)`);
const _kvHistoryPrune = db.prepare(`DELETE FROM kv_store_history WHERE key = ? AND id NOT IN (SELECT id FROM kv_store_history WHERE key = ? ORDER BY id DESC LIMIT 50)`);

const { KV_CRITICAL_SHAPES, shapeRegressions: _shapeRegressions, mergeDbMetadataIntoEnvServers, DB_META_FIELDS: _DB_META_FIELDS } = require('./src/utils/kv-guard');

// Write a critical kv entry. Refuses if shape regresses (unless allowed).
// Returns { ok: true } on success, or { ok: false, error, regressions } on refusal.
// Uses logActivity if available (it's a hoisted function declaration, so the
// reference resolves even though the body isn't reachable until later in the
// file — but logActivity's own try/catch keeps it safe if its deps aren't ready).
function kvSetCritical(key, value, opts) {
  opts = opts || {};
  const source = opts.source || 'unknown';
  const allowRegression = !!opts.allowRegression;
  const shapeFn = KV_CRITICAL_SHAPES[key];
  const oldRow = _kvGet.get(key);
  const oldValue = oldRow ? oldRow.value : null;
  const newShape = shapeFn ? shapeFn(value) : null;
  const oldShape = (shapeFn && oldValue) ? shapeFn(oldValue) : null;
  const regressions = (oldShape && newShape) ? _shapeRegressions(oldShape, newShape) : [];

  if (regressions.length > 0 && !allowRegression) {
    logger.warn(`[kvGuard] REFUSED write to '${key}' from '${source}': shape regression ${JSON.stringify(regressions)}`);
    try { if (typeof logActivity === 'function') logActivity('system', 'warn', 'kv_write_refused', null, `Refused regressive write to ${key}`, { key, source, regressions }); } catch (_) { /* best-effort: error intentionally swallowed */ }
    return { ok: false, error: 'shape regression', regressions };
  }

  try {
    _kvHistoryInsert.run(key, oldValue, value, source, newShape ? JSON.stringify(newShape) : null, regressions.length > 0 ? 1 : 0);
    _kvSet.run(key, value);
    _kvHistoryPrune.run(key, key);
    if (regressions.length > 0) {
      logger.warn(`[kvGuard] ALLOWED regressive write to '${key}' from '${source}' (explicit override): ${JSON.stringify(regressions)}`);
    }
    return { ok: true };
  } catch (e) {
    logger.error(`[kvGuard] write to '${key}' failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function kvCurrentShape(key) {
  const fn = KV_CRITICAL_SHAPES[key];
  if (!fn) return null;
  const row = _kvGet.get(key);
  if (!row) return null;
  return fn(row.value);
}
// ───────────────────────────────────────────────────────────────────────────────

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
  findBankPaymentByPaymentIdAny: db.prepare('SELECT id FROM bank_payments WHERE payment_id = ? LIMIT 1'),
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
  // cleanOldAudit — moved to runRetentionCleanup()

  // Proxy latency monitoring
  proxyCheckInsert: db.prepare(`INSERT INTO proxy_checks (server_name, nick, client_name, operator, checked_at, connect_ms, total_ms, status_code, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  // Explicit columns instead of SELECT * — proxy_checks has 11 columns; the UI
  // only reads 7. Returning 1000 rows × unused columns wastes bytes on the wire.
  proxyCheckRecent: db.prepare(`SELECT checked_at, server_name, nick, client_name, operator, connect_ms, total_ms, error FROM proxy_checks WHERE checked_at >= ? ORDER BY checked_at DESC LIMIT 1000`),
  proxyCheckByNick: db.prepare(`SELECT checked_at, server_name, nick, client_name, operator, connect_ms, total_ms, error FROM proxy_checks WHERE nick = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 100`),
  proxyCheckSummary: db.prepare(`SELECT nick, server_name, COUNT(*) as total_checks, AVG(total_ms) as avg_ms, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count FROM proxy_checks WHERE checked_at >= ? GROUP BY nick, server_name`),
  proxyCheckLast: db.prepare(`SELECT nick, server_name, connect_ms, total_ms, status_code, error, checked_at FROM proxy_checks WHERE id IN (SELECT MAX(id) FROM proxy_checks GROUP BY nick, server_name)`),
  // proxyCheckCleanOld — moved to runRetentionCleanup()

  // System activity log
  systemLogInsert: db.prepare('INSERT INTO system_log (category, level, action, target, message, details) VALUES (?, ?, ?, ?, ?, ?)'),
  systemLogQuery: db.prepare('SELECT * FROM system_log WHERE timestamp >= ? ORDER BY id DESC LIMIT ?'),
  systemLogQueryFiltered: db.prepare('SELECT * FROM system_log WHERE timestamp >= ? AND (? IS NULL OR category = ?) AND (? IS NULL OR level = ?) ORDER BY id DESC LIMIT ?'),
  // systemLogClean — moved to runRetentionCleanup()
};

// _fileLocks moved to src/utils/files.js
// safeWriteFile extracted to src/utils/files.js
function safeWriteFile(filePath, data) { return _safeWriteFile(filePath, data, logger); }

// .env loaded by dotenv at top of file

const PORT = process.env.PORT || 3000;

// API servers: loaded from .env (legacy) + SQLite kv_store (new additions via UI)
const apiServers = [];
const _envServerKeys = new Set();
for (const key of Object.keys(process.env)) {
  const m = key.match(/^API_(.+)_URL$/);
  if (m) _envServerKeys.add(m[1]);
}
for (const name of _envServerKeys) {
  const urlObj = new URL(process.env[`API_${name}_URL`]);
  apiServers.push({
    name,
    url: process.env[`API_${name}_URL`],
    user: process.env[`API_${name}_USER`] || 'proxy',
    pass: process.env[`API_${name}_PASS`] || 'proxy',
    publicIp: process.env[`API_${name}_PUBLIC_IP`] || urlObj.hostname
  });
}
// Load additional servers from DB (added via Settings UI) AND merge DB-stored
// metadata into env-defined servers. Env owns connection (url/user/pass/publicIp);
// DB owns metadata set via UI (address, hardware, ssh creds, country/tz).
// Without the merge, env servers lose UI-set fields on every restart because
// saveApiServersToDb() below would persist the impoverished env-only version
// and overwrite the DB's metadata — silent data loss on every pm2 restart.
// Merge logic lives in src/utils/kv-guard.js and has dedicated tests.
try {
  const _dbRow = db.prepare("SELECT value FROM kv_store WHERE key = 'api_servers'").get();
  if (_dbRow) {
    const dbServers = JSON.parse(_dbRow.value);
    mergeDbMetadataIntoEnvServers(apiServers, dbServers);
  }
} catch (_) { /* best-effort: error intentionally swallowed */ }
function saveApiServersToDb(source) {
  // Routes through kvSetCritical so the write is history-logged AND refused if
  // it would silently shrink any tracked metadata count (address/ssh/etc).
  const payload = JSON.stringify(apiServers);
  const r = kvSetCritical('api_servers', payload, { source: source || 'saveApiServersToDb' });
  if (!r.ok) {
    logger.error(`[saveApiServersToDb] refused: ${r.error}; regressions=${JSON.stringify(r.regressions || [])}`);
  }
}
// Auto-migrate: save env servers to DB on first run
if (apiServers.length > 0) saveApiServersToDb();

// Server country config — loaded from DB server objects (country, countryName, tz fields)
// getTzOffset extracted to src/utils/time.js
const SERVER_COUNTRIES = {};
for (const s of apiServers) {
  SERVER_COUNTRIES[s.name] = {
    serverIp: s.publicIp,
    country: s.country || '',
    name: s.countryName || s.name,
    tz: s.tz || 'Europe/Moscow'
  };
}
logger.info(`Loaded ${apiServers.length} API server(s): ${apiServers.map(s => s.name + ' (' + s.url + ')').join(', ')}`);

// ─── Startup integrity check ───────────────────────────────────────────────────
// Compare current api_servers shape (servers × populated metadata fields)
// against the baseline saved at last successful startup. If anything regressed,
// log loud WARN + an audit event so ops can intervene before the regressed
// state gets persisted further. Baseline is updated after the check.
//
// Catches: any future merge bug, accidental kv_store edit, env config drift
// that strips fields silently.
(function checkApiServersIntegrity() {
  try {
    const currentShape = KV_CRITICAL_SHAPES.api_servers(JSON.stringify(apiServers));
    const baselineRow = _kvGet.get('integrity_baseline_api_servers');
    let baseline = null;
    if (baselineRow) { try { baseline = JSON.parse(baselineRow.value); } catch (_) { /* best-effort: error intentionally swallowed */ } }
    if (baseline) {
      const regs = _shapeRegressions(baseline, currentShape);
      if (regs.length > 0) {
        logger.warn(`[Integrity] api_servers REGRESSED since last startup: ${JSON.stringify(regs)}`);
        logger.warn(`[Integrity]   baseline: ${JSON.stringify(baseline)}`);
        logger.warn(`[Integrity]   current : ${JSON.stringify(currentShape)}`);
        // logActivity isn't defined yet at this point (hoisted as a function but
        // its db dependency dbStmts may not exist) — defer the audit event.
        process.nextTick(() => {
          try { logActivity('system', 'critical', 'integrity_regression', 'api_servers', `Server metadata regressed at boot: ${regs.map(r => r.field + ' ' + r.before + '→' + r.after).join(', ')}`, { regressions: regs, baseline, current: currentShape }); } catch (_) { /* best-effort: error intentionally swallowed */ }
        });
      } else {
        logger.info(`[Integrity] api_servers OK: ${JSON.stringify(currentShape)}`);
      }
    } else {
      logger.info(`[Integrity] api_servers baseline initialised: ${JSON.stringify(currentShape)}`);
    }
    _kvSet.run('integrity_baseline_api_servers', JSON.stringify(currentShape));
  } catch (e) {
    logger.error('[Integrity] check failed: ' + e.message);
  }
})();
// ───────────────────────────────────────────────────────────────────────────────

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
    logger.warn('[Startup] ⚠️  Warnings:');
    warnings.forEach(w => logger.warn(`  - ${w}`));
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
logger.info(`Loaded ${Object.keys(modemLogins).length} modem login mapping(s)`);

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

const CLIENTS_FILE = path.join(__dirname, 'clients.json'); // JSON fallback for first-time migration

// Clients prepared statements moved into src/db/clients.js (Stage 2).
// Hot-path balance/referral statements aliased near the top of this file
// after `clientsDb.init(db)` for billing.init() consumption.

/** atomicCredit / atomicDebit — delegated to src/billing/atomic.js */
function atomicCredit(...args) { return billing.atomicCredit(...args); }
function atomicDebit(...args) { return billing.atomicDebit(...args); }
// payments + documents + closing + bills prepared statements moved into
// src/db/payments.js and src/db/documents.js (Stage 2). Callers use the
// named functions on those modules.

// Get signed expense amount from ledger entry:
// charges: always positive (cost), corrections: signed based on balance change
function ledgerExpense(e) {
  if (e.type === 'correction') {
    // Use balance delta to determine direction (debit=expense, credit=income)
    if (e.balance_before != null && e.balance_after != null) {
      return Math.round((e.balance_before - e.balance_after) * 100) / 100; // positive=expense, negative=refund
    }
    return e.cost || e.amount || 0;
  }
  return e.cost || e.amount || 0;
}

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
    billingPaused: r.billing_paused === 1, clientType: r.client_type || 'legal',
    allowDebt: r.allow_debt === 1,
    maxDebt: r.max_debt != null ? r.max_debt : null,
    slaUptimePct:    r.sla_uptime_pct    != null ? r.sla_uptime_pct : 99,
    slaMaxLatencyMs: r.sla_max_latency_ms != null ? r.sla_max_latency_ms : 1000,
    slaMaxErrorPct:  r.sla_max_error_pct  != null ? r.sla_max_error_pct : 5,
    slaAutoCredit:   r.sla_auto_credit === 1,
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
    } catch (e) { logger.error('[SQLite] Failed to load clients from JSON fallback:', e.message); }
    return [];
  }
  const clientsList = rows.map(clientFromRow);
  for (const client of clientsList) {
    client.payments = paymentsDb.listByClient(client.id).map(r => ({
      amount: r.amount, date: r.date, note: r.note || '', source: r.source || 'manual',
      paymentId: r.payment_id || undefined, createdAt: r.created_at || ''
    }));
    client.documents = documentsDb.listDocs(client.id).map(r => ({
      id: r.id, name: r.name, fileName: r.file_name, mimeType: r.mime_type || '', date: r.date || ''
    }));
    client.closingDocuments = documentsDb.listClosing(client.id).map(r => ({
      id: r.id, tochkaDocumentId: r.tochka_doc_id || '', period: r.period, type: r.type || 'act',
      actNumber: r.act_number || '', items: JSON.parse(r.items || '[]'), totalAmount: r.total_amount || 0,
      status: r.status || 'unsigned', contractInfo: r.contract_info || '',
      signedAt: r.signed_at || undefined, createdAt: r.created_at || ''
    }));
    client.bills = documentsDb.listBills(client.id).map(r => ({
      id: r.id, tochkaBillId: r.tochka_bill_id || '', period: r.period,
      billNumber: r.bill_number || '', amount: r.amount || 0,
      status: r.status || 'unpaid', createdAt: r.created_at || ''
    }));
  }
  return clientsList;
}

function saveClients(clientsList) {
  if (!Array.isArray(clientsList)) {
    logger.error('[CRITICAL] saveClients called without array argument! Aborting write.');
    return;
  }
  try {
    db.transaction(() => {
      // Remove deleted clients (ON DELETE CASCADE cleans sub-tables)
      const liveIds = new Set(clientsList.map(c => c.id));
      for (const r of clientsDb.allIds()) {
        if (!liveIds.has(r.id)) clientsDb.deleteById(r.id);
      }
      // Upsert clients + sync sub-arrays
      for (const c of clientsList) {
        clientsDb.upsertRow(c);
        // Sync payments
        paymentsDb.deleteByClient(c.id);
        for (const p of (c.payments || [])) {
          paymentsDb.insert({
            clientId: c.id, amount: p.amount, date: p.date, note: p.note,
            source: p.source, paymentId: p.paymentId, createdAt: p.createdAt,
          });
        }
        // Sync documents
        documentsDb.deleteDocsByClient(c.id);
        for (const d of (c.documents || [])) documentsDb.insertDoc(d, c.id);
        // Sync closing documents
        documentsDb.deleteClosingByClient(c.id);
        for (const d of (c.closingDocuments || [])) documentsDb.insertClosing(d, c.id);
        // Sync bills
        documentsDb.deleteBillsByClient(c.id);
        for (const b of (c.bills || [])) documentsDb.insertBill(b, c.id);
      }
    })();
  } catch (e) {
    logger.error('[SQLite] Error saving clients:', e.message);
  }
}

const BILLING_LEDGER_FILE = path.join(__dirname, 'billing_ledger.json'); // JSON fallback
// _ledgerDeleteByClient / _ledgerInsert moved into src/db/ledger.js.
// _ledgerInsert alias is already created near the init block at the top.

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
        try { Object.assign(entry, JSON.parse(r.details)); } catch (_) { /* best-effort: error intentionally swallowed */ }
      }
      entry.db_id = r.id; 
      billingLedger[r.client_id].push(entry);
    }
    logger.info(`[SQLite] Loaded ${_blRows.length} billing ledger entries`);
  } else {
    try {
      if (fs.existsSync(BILLING_LEDGER_FILE)) {
        billingLedger = JSON.parse(fs.readFileSync(BILLING_LEDGER_FILE, 'utf8'));
        const total = Object.values(billingLedger).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
        if (total > 0) logger.info(`[SQLite] Loaded ${total} billing ledger entries from JSON fallback`);
      }
    } catch (e) { logger.error('[SQLite] Failed to load billing_ledger from JSON:', e.message); }
  }
}

const MAX_LEDGER_ENTRIES = 1000; // per client

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
    entry.db_id = result.lastInsertRowid; 
    billingLedger[clientId].push(entry); 
  } catch (e) {
    logger.error('[SQLite] Error appending ledger entry:', e.message);
    // NOT adding to in-memory — keeps state consistent with DB
  }
}

// _ledgerDeleteById moved into src/db/ledger.js (Stage 2).

function saveBillingLedger() {
  try {
    const validIds = new Set(clientsDb.allIds().map(r => r.id));
    db.transaction(() => {
      for (const clientId in billingLedger) {
        if (!validIds.has(clientId)) continue;
        let entries = billingLedger[clientId];
        if (!Array.isArray(entries)) continue;
        if (entries.length > MAX_LEDGER_ENTRIES) {
          entries = entries.slice(-MAX_LEDGER_ENTRIES);
          billingLedger[clientId] = entries;
        }
        ledgerDb.deleteByClient(clientId);
        for (const e of entries) {
          _ledgerInsert.run(..._ledgerEntryParams(clientId, e));
        }
      }
    })();
  } catch (e) {
    logger.error('[SQLite] Error saving billing ledger:', e.message);
  }
}

function auditLog(adminLogin, action, details = {}) {
  try {
    const ts = new Date().toISOString();
    dbStmts.insertAudit.run(ts, adminLogin, action, JSON.stringify(details));
  } catch (e) {
    logger.error('[AuditLog] Write failed:', e.message);
  }
}

// Response envelope helpers — preferred shape for NEW endpoints:
//   apiOk(res, data?)     →  { ok: true, ...data }
//   apiErr(res, code, msg) →  { ok: false, error: msg, code }
// (Existing endpoints keep their idiosyncratic shapes for back-compat.
//  Migrate to apiOk/apiErr gradually when touching each route.)
function apiOk(res, data) { return res.json(Object.assign({ ok: true }, data || {})); }
function apiErr(res, statusCode, code, msg) {
  return res.status(statusCode).json({ ok: false, error: msg || code, code });
}

// Pagination helper — same shape across endpoints. Caps limit at `hardMax`
// (route-defined) and `MAX_PAGE_LIMIT` (global). Returns { limit, offset }.
// Usage: const { limit, offset } = parsePage(req, { defaultLimit: 50, hardMax: 200 });
const MAX_PAGE_LIMIT = 1000;
function parsePage(req, opts) {
  const o = opts || {};
  const cap = Math.min(o.hardMax || MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const def = Math.min(o.defaultLimit || 50, cap);
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || def, cap));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  return { limit, offset };
}

function logActivity(category, level, action, target, message, details = null) {
  try {
    const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
    dbStmts.systemLogInsert.run(category, level, action, target || null, message, detailsStr);
  } catch (e) {
    logger.error(`[SystemLog] Write failed: ${e.message}`);
  }
  // Urgent alert: forward critical/error events to Telegram immediately if
  // configured. Throttled per (action, target) to avoid alert storms — only
  // first occurrence per 15 min for the same key.
  try {
    if (level === 'critical' || (level === 'error' && _shouldUrgentAlert(action))) {
      _emitUrgentAlert(level, action, target, message);
    }
  } catch (_) { /* never let alert path break logActivity */ }
}

// Critical actions that always trigger an immediate alert (when level=error).
const URGENT_ACTIONS = new Set([
  'server_unreachable',
  'billing_failed',
  'billing_unique_conflict',
  'tochka_sync_failed',
  'tochka_unverified_webhook',
  'db_backup_failed',
  'uncaught_exception',
  'unhandled_rejection',
  'telegram_summary_failed'
]);
function _shouldUrgentAlert(action) { return URGENT_ACTIONS.has(action); }

const _urgentAlertCooldown = new Map();
function _emitUrgentAlert(level, action, target, message) {
  if (typeof tgBot === 'undefined' || typeof tgBot.sendMessage !== 'function') return;
  const token = appSettings.telegram_bot_token;
  const chatId = appSettings.telegram_chat_id;
  if (!token || !chatId || !appSettings.telegram_summary_enabled) return;
  const key = action + '|' + (target || '');
  const now = Date.now();
  const last = _urgentAlertCooldown.get(key) || 0;
  if (now - last < 15 * 60 * 1000) return; // 15-min cooldown
  _urgentAlertCooldown.set(key, now);
  // Trim cooldown map periodically — never grows beyond a few dozen keys.
  if (_urgentAlertCooldown.size > 200) {
    for (const [k, t] of _urgentAlertCooldown) if (now - t > 60 * 60 * 1000) _urgentAlertCooldown.delete(k);
  }
  const icon = level === 'critical' ? '🚨' : '⚠️';
  const txt = `${icon} <b>${level.toUpperCase()}</b>\n<code>${String(action).slice(0, 60)}</code>${target ? ' · ' + String(target).slice(0, 60) : ''}\n${String(message).slice(0, 800)}`;
  tgBot.sendMessage(token, chatId, txt, { parse_mode: 'HTML' }).catch(e => {
    logger.warn('[UrgentAlert] Telegram send failed: ' + e.message);
  });
}

const TRUSTED_PROXIES = (process.env.TRUSTED_PROXY || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(s => s.trim());
function normalizeIp(ip) {
  if (!ip) return '';
  // Strip ::ffff: prefix (IPv6-mapped IPv4)
  return ip.replace(/^::ffff:/i, '').trim();
}
function getClientIp(req) {
  const raw = req.socket?.remoteAddress || '';
  const remote = normalizeIp(raw);
  const isTrusted = TRUSTED_PROXIES.some(p => normalizeIp(p) === remote || remote.includes(normalizeIp(p)));
  if (isTrusted) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const realIp = req.headers['x-real-ip'] || '';
    const clientIp = normalizeIp(xff) || normalizeIp(realIp);
    // Return actual client IP; fallback to req.ip (Express trust proxy) or remote
    return clientIp || normalizeIp(req.ip) || remote || 'unknown';
  }
  return remote || 'unknown';
}

const TOCHKA_CONFIG_FILE = path.join(__dirname, 'tochka_config.json');
let tochkaConfig = { jwt: '', clientId: '', customerCode: '', accountId: '', companyName: '', companyInn: '', companyKpp: '', companyAddress: '', bankAccount: '', bankName: '', bankBic: '', bankCorrAccount: '' };

// AES-256-GCM at-rest encryption for tochka_config.json. Key comes from
// $TOCHKA_CONFIG_KEY (32 random bytes hex). If absent we fall back to a
// derived key based on hostname + process.platform — enough to make the
// file non-trivially readable to anyone who only got the file (not root),
// but the production deployment SHOULD set $TOCHKA_CONFIG_KEY explicitly.
function _tochkaCryptKey() {
  const env = process.env.TOCHKA_CONFIG_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, 'hex');
  // Derived fallback (deterministic per host so saves stay readable on restart).
  return crypto.createHash('sha256')
    .update('tochka-config-v1|' + os.hostname() + '|' + process.platform)
    .digest();
}
function _encryptJson(obj) {
  const key = _tochkaCryptKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: enc.toString('base64') });
}
function _decryptJson(payload) {
  const wrap = JSON.parse(payload);
  if (!wrap || wrap.v !== 1) throw new Error('not an encrypted v1 payload');
  const key = _tochkaCryptKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
  const buf = Buffer.concat([decipher.update(Buffer.from(wrap.ct, 'base64')), decipher.final()]);
  return JSON.parse(buf.toString('utf8'));
}

try {
  if (fs.existsSync(TOCHKA_CONFIG_FILE)) {
    const raw = fs.readFileSync(TOCHKA_CONFIG_FILE, 'utf8');
    let parsed;
    if (raw.trim().startsWith('{"v":1')) {
      try { parsed = _decryptJson(raw); }
      catch (e) {
        const hasExplicitKey = !!(process.env.TOCHKA_CONFIG_KEY && /^[0-9a-f]{64}$/i.test(process.env.TOCHKA_CONFIG_KEY));
        const hostNow = os.hostname();
        // Distinguish "wrong explicit key" from "derived key drift after hostname change" —
        // both are decrypt failures but they need different fixes from the operator.
        if (hasExplicitKey) {
          logger.error(`[Tochka] DECRYPT FAILED with explicit $TOCHKA_CONFIG_KEY. File was encrypted with a different key. ${e.message}`);
        } else {
          logger.error(`[Tochka] DECRYPT FAILED with derived key (hostname=${hostNow}). Most likely the hostname changed since the file was last saved. Set TOCHKA_CONFIG_KEY in .env or restore the previous hostname. ${e.message}`);
        }
        // Also surface in system_log so it shows up in the admin UI without needing SSH.
        try { logActivity('system', 'error', 'tochka_decrypt_failed', null,
          `Не удалось расшифровать tochka_config.json (hostname=${hostNow}). Проверьте \$TOCHKA_CONFIG_KEY или восстановите hostname.`,
          { hostname: hostNow, hasExplicitKey }); } catch (_) { /* best-effort: error intentionally swallowed */ }
        parsed = null;
      }
    } else {
      // Plaintext legacy file → load and re-encrypt on first save.
      parsed = JSON.parse(raw);
      logger.info('[Tochka] Legacy plaintext config detected — will re-encrypt on next save');
    }
    if (parsed) Object.assign(tochkaConfig, parsed);
  }
} catch (e) { logger.info('[Tochka] Error loading config file: ' + e.message); }
// .env overrides file config
if (process.env.TOCHKA_JWT_TOKEN) tochkaConfig.jwt = process.env.TOCHKA_JWT_TOKEN;
if (process.env.TOCHKA_CLIENT_ID) tochkaConfig.clientId = process.env.TOCHKA_CLIENT_ID;
if (process.env.TOCHKA_CUSTOMER_CODE) tochkaConfig.customerCode = process.env.TOCHKA_CUSTOMER_CODE;
if (process.env.TOCHKA_ACCOUNT_ID) tochkaConfig.accountId = process.env.TOCHKA_ACCOUNT_ID;
if (process.env.TOCHKA_COMPANY_NAME) tochkaConfig.companyName = process.env.TOCHKA_COMPANY_NAME;
if (process.env.TOCHKA_COMPANY_INN) tochkaConfig.companyInn = process.env.TOCHKA_COMPANY_INN;
if (process.env.TOCHKA_COMPANY_KPP) tochkaConfig.companyKpp = process.env.TOCHKA_COMPANY_KPP;
if (process.env.TOCHKA_COMPANY_ADDRESS) tochkaConfig.companyAddress = process.env.TOCHKA_COMPANY_ADDRESS;
if (process.env.TOCHKA_BANK_ACCOUNT) tochkaConfig.bankAccount = process.env.TOCHKA_BANK_ACCOUNT;
if (process.env.TOCHKA_BANK_NAME) tochkaConfig.bankName = process.env.TOCHKA_BANK_NAME;
if (process.env.TOCHKA_BANK_BIC) tochkaConfig.bankBic = process.env.TOCHKA_BANK_BIC;
if (process.env.TOCHKA_BANK_CORR_ACCOUNT) tochkaConfig.bankCorrAccount = process.env.TOCHKA_BANK_CORR_ACCOUNT;
function saveTochkaConfig() { safeWriteFile(TOCHKA_CONFIG_FILE, _encryptJson(tochkaConfig)); }

// Tochka response field lookup that tolerates case variation. Tries the
// provided keys in order, returns the first non-undefined value.
function _pickField(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}
if (tochkaConfig.jwt) { saveTochkaConfig(); logger.info(`[Tochka] API configured (client_id: ${tochkaConfig.clientId})`); }
else logger.info('[Tochka] No JWT token configured, bank integration disabled');

// Extracted to src/tochka/api.js
function tochkaRequest(method, apiPath, body) {
  return _tochkaRequest(tochkaConfig, method, apiPath, body);
}

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
  // Prevent duplicate payments by payment_id
  if (bp.paymentId) {
    const existing = dbStmts.findBankPaymentByPaymentIdAny.get(bp.paymentId);
    if (existing) {
      logger.warn(`[BankPayment] Duplicate payment_id ${bp.paymentId}, skipping insert`);
      return false;
    }
  }
  dbStmts.insertBankPayment.run(
    bp.id, bp.webhookType || '', bp.payerInn || '', bp.payerName || '',
    bp.amount || 0, bp.purpose || '', bp.paymentId || '', bp.date || '',
    bp.customerCode || '', bp.matched ? 1 : 0, bp.matchedClientId || null,
    bp.matchedClientName || null, bp.autoCredit ? 1 : 0,
    bp.dismissed ? 1 : 0, bp.source || '', bp.tochkaPaymentId || '',
    bp.receivedAt || new Date().toISOString()
  );
  return true;
}

function getAllBankPayments() {
  return dbStmts.getBankPayments.all().map(bankPaymentFromRow);
}

// Extracted to src/tochka/jwt.js — decodeJwtPayload, decodeJwtHeader, fetchTochkaJwks, jwkToPem, verifyJwtSignature

// Track last act/bill generation month to avoid duplicates
let lastActGenerationMonth = (db.prepare("SELECT value FROM kv_store WHERE key = 'last_act_generation_month'").get() || {}).value || '';
let lastBillGenerationMonth = (db.prepare("SELECT value FROM kv_store WHERE key = 'last_bill_generation_month'").get() || {}).value || '';

// Extracted to src/tochka/documents.js — buildTochkaActBody, buildActItemsFromLedger, buildTochkaBillBody, calculateMonthlyBillAmount, MONTH_NAMES_RU
function buildActItemsFromLedger(client, period) {
  return _buildActItemsFromLedger(client, period, billingLedger);
}
function buildTochkaActBody(client, period, actItems, actNumber) {
  return _buildTochkaActBody(tochkaConfig, client, period, actItems, actNumber);
}
function buildTochkaBillBody(client, amount, billNumber, billDate) {
  return _buildTochkaBillBody(tochkaConfig, client, amount, billNumber, billDate);
}
function calculateMonthlyBillAmount(client, cachedResults) {
  return _calculateMonthlyBillAmount(client, cachedResults, billingLedger);
}

let dailyTraffic = {}; // { portKey: { "2026-03-01": { in: bytes, out: bytes, portName }, ... } }

// Cached trend computations — invalidated whenever dailyTraffic is mutated
// (syncYesterdayTraffic, runDailyBilling, retention cleanup). TTL backstop 60s.
let _modemTrendCache = null;
let _clientTrendCache = null;
let _trendCacheTs = 0;
const TREND_CACHE_TTL_MS = 60 * 1000;
function _invalidateTrendCache() { _modemTrendCache = null; _clientTrendCache = null; _trendCacheTs = 0; }
function _computeTrends() {
  const mskNow = getMoscowNow();
  const completedDays = Math.max(mskNow.getDate() - 1, 0);
  if (completedDays === 0) return { modem: {}, client: {} };
  const cy = mskNow.getFullYear(), cm = mskNow.getMonth();
  const curPrefix  = `${cy}-${String(cm + 1).padStart(2, '0')}`;
  const prevDate   = new Date(cy, cm - 1, 1);
  const prevPrefix = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const curCutoff  = `${curPrefix}-${String(completedDays).padStart(2, '0')}`;
  const prevCutoff = `${prevPrefix}-${String(completedDays).padStart(2, '0')}`;
  const modem = {};
  const byClient = {};
  for (const [portKey, days] of Object.entries(dailyTraffic)) {
    let curBytes = 0, prevBytes = 0;
    for (const [date, entry] of Object.entries(days)) {
      const b = (entry.in || 0) + (entry.out || 0);
      if (date.startsWith(curPrefix) && date <= curCutoff) curBytes += b;
      else if (date.startsWith(prevPrefix) && date <= prevCutoff) prevBytes += b;
    }
    if (prevBytes > 0)       modem[portKey] = Math.round((curBytes - prevBytes) / prevBytes * 100);
    else if (curBytes > 0)   modem[portKey] = null;
    // Aggregate by client portName for clientTrend
    const pn = (typeof portKeyToPortName !== 'undefined' && portKeyToPortName[portKey])
            || (Object.values(days)[0] && Object.values(days)[0].portName)
            || '';
    if (pn) {
      if (!byClient[pn]) byClient[pn] = { cur: 0, prev: 0 };
      byClient[pn].cur += curBytes;
      byClient[pn].prev += prevBytes;
    }
  }
  const client = {};
  for (const [pn, d] of Object.entries(byClient)) {
    if (d.prev > 0)     client[pn] = Math.round((d.cur - d.prev) / d.prev * 100);
    else if (d.cur > 0) client[pn] = null;
  }
  return { modem, client };
}
function _getModemTrend() {
  if (_modemTrendCache && (Date.now() - _trendCacheTs) < TREND_CACHE_TTL_MS) return _modemTrendCache;
  const t = _computeTrends();
  _modemTrendCache = t.modem; _clientTrendCache = t.client; _trendCacheTs = Date.now();
  return _modemTrendCache;
}
function _getClientTrend() {
  if (_clientTrendCache && (Date.now() - _trendCacheTs) < TREND_CACHE_TTL_MS) return _clientTrendCache;
  const t = _computeTrends();
  _modemTrendCache = t.modem; _clientTrendCache = t.client; _trendCacheTs = Date.now();
  return _clientTrendCache;
}
// Load from SQLite
try {
  // Load only last 90 days to limit memory usage
  db.prepare("DELETE FROM daily_traffic WHERE date < date('now', '-90 days')").run();
  const rows = db.prepare("SELECT port_name, date, bytes_in, bytes_out FROM daily_traffic WHERE date >= date('now', '-90 days')").all();
  for (const r of rows) {
    if (!dailyTraffic[r.port_name]) dailyTraffic[r.port_name] = {};
    dailyTraffic[r.port_name][r.date] = { in: r.bytes_in, out: r.bytes_out };
  }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} daily traffic entries`);
} catch (e) { logger.error('Failed to load daily_traffic from SQLite:', e.message); }

const _dtUpsert = db.prepare(`INSERT INTO daily_traffic (port_name, date, bytes_in, bytes_out) VALUES (?, ?, ?, ?)
  ON CONFLICT(port_name, date) DO UPDATE SET
  bytes_in = MAX(bytes_in, excluded.bytes_in),
  bytes_out = MAX(bytes_out, excluded.bytes_out)`);
// daily_traffic never cleaned — needed for long-term trend charts
// If hour already recorded for this port — skip (don't overwrite or accumulate)
const _htUpsert = db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(port_id, hour_start) DO UPDATE SET
  bytes_in  = CASE WHEN bytes_in  = 0 THEN excluded.bytes_in  ELSE bytes_in  END,
  bytes_out = CASE WHEN bytes_out = 0 THEN excluded.bytes_out ELSE bytes_out END,
  uncertain = CASE WHEN excluded.uncertain > uncertain THEN excluded.uncertain ELSE uncertain END`);
const _snapUpsert = db.prepare(`INSERT INTO hourly_snapshots
  (port_id, day_in, day_out, month_in, month_out, yesterday_in, yesterday_out,
   prev_month_in, prev_month_out, day_at_last_hour_start_in, day_at_last_hour_start_out,
   mon_at_last_hour_start_in, mon_at_last_hour_start_out, pending, captured_at, last_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  ON CONFLICT(port_id) DO UPDATE SET
  day_in=excluded.day_in, day_out=excluded.day_out,
  month_in=excluded.month_in, month_out=excluded.month_out,
  yesterday_in=excluded.yesterday_in, yesterday_out=excluded.yesterday_out,
  prev_month_in=excluded.prev_month_in, prev_month_out=excluded.prev_month_out,
  day_at_last_hour_start_in=excluded.day_at_last_hour_start_in,
  day_at_last_hour_start_out=excluded.day_at_last_hour_start_out,
  mon_at_last_hour_start_in=excluded.mon_at_last_hour_start_in,
  mon_at_last_hour_start_out=excluded.mon_at_last_hour_start_out,
  pending=excluded.pending, captured_at=excluded.captured_at,
  last_updated_at=datetime('now')`);
const _snapGet = db.prepare('SELECT * FROM hourly_snapshots WHERE port_id = ?');
const _snapGetAll = db.prepare('SELECT * FROM hourly_snapshots');
// API usage tracking (Phase 2)
const _apiUsageInsert = db.prepare(`INSERT INTO api_usage
  (client_id, client_name, api_key_prefix, endpoint, method, status_code,
   response_time_ms, user_agent, ip, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
// Retention cleanup — dynamic SQL using appSettings retention values
function runRetentionCleanup() {
  const retentions = {
    traffic_hourly: { col: 'hour_start', key: 'retention_traffic_hourly', def: 90 },
    modem_meta:     { col: 'updated_at', key: 'retention_modem_meta', def: 30 },
    rotation_log:   { col: 'started_at', key: 'retention_rotation_log', def: 30 }, // grows ~25k/day; 30d default keeps it manageable
    proxy_checks:   { col: 'checked_at', key: 'retention_proxy_checks', def: 30 },
    audit_log:      { col: 'timestamp',  key: 'retention_audit_log', def: 90 },
    system_log:     { col: 'timestamp',  key: 'retention_system_log', def: 30 },
    api_usage:      { col: 'timestamp',  key: 'retention_api_usage', def: 30 },
    // DB-level audit (triggers): keep 365 days by default — financial forensics
    db_audit:         { col: 'ts', key: 'retention_db_audit', def: 365 },
    db_audit_context: { col: 'ts', key: 'retention_db_audit', def: 365 },
    // Auto-reboot log — 90 days
    auto_reboot_log:  { col: 'rebooted_at', key: 'retention_auto_reboot', def: 90 },
    // Simulator runs — 30 days; CASCADE on simulator_samples handles the rest.
    simulator_runs:   { col: 'started_at', key: 'retention_simulator_runs', def: 30 },
  };
  const results = {};
  for (const [table, { col, key, def }] of Object.entries(retentions)) {
    const raw = appSettings[key];
    const days = Number.isInteger(raw) && raw >= 7 ? raw : def;
    results[table] = db.prepare(`DELETE FROM ${table} WHERE ${col} < datetime('now', '-${days} days')`).run();
  }
  // In-memory dailyTraffic cleanup (mirrors daily_traffic table retention)
  try {
    const rawDt = appSettings.retention_daily_traffic;
    const dtDays = Number.isInteger(rawDt) && rawDt >= 7 ? rawDt : 90;
    const cutoff = new Date(Date.now() - dtDays * 86400000).toISOString().slice(0, 10);
    let removedDays = 0, removedKeys = 0;
    for (const [key, days] of Object.entries(dailyTraffic)) {
      for (const date of Object.keys(days)) {
        if (date < cutoff) { delete days[date]; removedDays++; }
      }
      if (!Object.keys(days).length) { delete dailyTraffic[key]; removedKeys++; }
    }
    // Also prune the daily_traffic table to stay in sync with memory
    const dbRes = db.prepare('DELETE FROM daily_traffic WHERE date < ?').run(cutoff);
    results.daily_traffic_memory = { changes: removedDays, removedKeys };
    results.daily_traffic = dbRes;
  } catch (e) {
    logger.error('[Retention] dailyTraffic cleanup error:', e.message);
  }
  // Stale port mapping cleanup: remove daily_traffic rows + known_modems entries
  // for port_ids that disappeared from live ProxySmart > N days ago.
  // (Was a manual fix on 2026-05-04 — automated here so the WildBox-style
  // ghost-port issue can't recur.)
  results.stale_ports = cleanupStalePortMappings();
  // Prune in-memory tracking maps so they don't grow forever as modems churn.
  // ipTracking/uptimeTracking/modemRotationCache key on serverName+IMEI; entries
  // for IMEIs not seen in live data for >30 days are dead weight.
  try {
    const liveImeis = new Set();
    try {
      const cache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf8'));
      for (const srv of Object.keys(cache || {})) {
        const status = Array.isArray(cache[srv].status) ? cache[srv].status : [];
        for (const m of status) {
          const imei = m.modem_details && m.modem_details.IMEI;
          if (imei) liveImeis.add(srv + '_' + imei);
        }
      }
    } catch (_) { /* best-effort: error intentionally swallowed */ }
    let ipPruned = 0, upPruned = 0, rotPruned = 0;
    if (liveImeis.size > 0) {
      for (const k of Object.keys(ipTracking)) if (!liveImeis.has(k)) { delete ipTracking[k]; ipPruned++; }
      for (const k of Object.keys(uptimeTracking)) if (!liveImeis.has(k)) { delete uptimeTracking[k]; upPruned++; }
      for (const k of Object.keys(modemRotationCache)) {
        // modemRotationCache keys are `serverName:imei` — different prefix style
        const [srv, imei] = k.split(':');
        if (srv && imei && !liveImeis.has(srv + '_' + imei)) { delete modemRotationCache[k]; rotPruned++; }
      }
    }
    results.tracking_pruned = { ipTracking: ipPruned, uptimeTracking: upPruned, modemRotationCache: rotPruned };
  } catch (e) {
    logger.warn('[Retention] tracking-map pruning error: ' + e.message);
  }
  return results;
}

/**
 * Remove ports that no longer exist in live ProxySmart for >N days.
 * - Skips servers whose cache is older than 30 min (we don't trust stale caches
 *   to decide what's "live"; better to keep data than delete prematurely).
 * - Default threshold: 14 days. Configurable via appSettings.retention_stale_ports_days.
 */
function cleanupStalePortMappings() {
  try {
    const rawDays = appSettings.retention_stale_ports_days;
    // Default 3 days: a disconnected modem stays visible as offline for ~3
    // days, then its known_modems entry is dropped so the row disappears.
    // Minimum 1 day to allow tighter behavior if needed.
    const days = Number.isInteger(rawDays) && rawDays >= 1 ? rawDays : 3;
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const cutoffMs   = Date.now() - days * 86400000;

    // Build set of CURRENTLY LIVE port_ids from server_cache.json.
    // Only trust servers whose cache is fresh (≤30 min old) — for unreachable
    // servers we have no authoritative info on what's still live, so skip them.
    let serverCache = {};
    try {
      serverCache = JSON.parse(fs.readFileSync(SERVER_CACHE_FILE, 'utf-8'));
    } catch (_) { return { skipped: 'no_cache' }; }

    const FRESHNESS_MS = 30 * 60 * 1000;
    const liveIds = new Set();
    const skippedSrv = [];
    for (const [srvName, entry] of Object.entries(serverCache)) {
      if (!entry || !entry.bw) continue;
      const age = Date.now() - (entry.cachedAt || 0);
      if (age > FRESHNESS_MS) { skippedSrv.push(srvName); continue; }
      for (const pid of Object.keys(entry.bw)) liveIds.add(srvName + '_' + pid);
    }
    if (liveIds.size === 0) {
      return { skipped: 'no_fresh_servers', skippedSrv };
    }

    // 1. daily_traffic table: stale port_ids whose latest activity < cutoff.
    const stale = db.prepare(`
      SELECT port_name FROM daily_traffic
      GROUP BY port_name HAVING MAX(date) < ?
    `).all(cutoffDate);
    let dtDeleted = 0;
    if (stale.length) {
      const stmt = db.prepare('DELETE FROM daily_traffic WHERE port_name = ?');
      const tx = db.transaction(() => {
        for (const r of stale) {
          if (liveIds.has(r.port_name)) continue;     // still live → keep
          dtDeleted += stmt.run(r.port_name).changes;
        }
      });
      tx();
    }

    // 2. In-memory dailyTraffic: drop matching keys.
    let dtMemKeys = 0;
    for (const k of Object.keys(dailyTraffic)) {
      if (liveIds.has(k)) continue;
      const dates = Object.keys(dailyTraffic[k]);
      const lastDate = dates.length ? dates.sort().slice(-1)[0] : '';
      if (lastDate && lastDate < cutoffDate) {
        delete dailyTraffic[k];
        dtMemKeys++;
      }
    }

    // 3. known_modems.json: remove entries with stale lastSeen, only on
    //    servers that ARE fresh (skipped servers untouched).
    //    Also handle "IMEI reassigned": if the same IMEI has multiple km
    //    entries (modem was moved between clients/ports), keep only the
    //    newest by lastSeen and remove older ones that are not in live bw.
    let kmRemoved = 0, kmChanged = false;

    // Build per-IMEI index globally across all (fresh) servers.
    const byImei = {};   // imei -> [{srv, pid, lastSeen}]
    for (const srvName of Object.keys(knownModems || {})) {
      if (skippedSrv.includes(srvName)) continue;
      const km = knownModems[srvName];
      for (const [pid, info] of Object.entries(km)) {
        if (!info.imei) continue;
        if (!byImei[info.imei]) byImei[info.imei] = [];
        byImei[info.imei].push({ srv: srvName, pid, lastSeen: info.lastSeen || 0 });
      }
    }
    // Build live-IMEI set per server (modem currently visible in ProxySmart status,
    // regardless of whether its port is in bw — could be a default/random port).
    const liveImeisByServer = {};
    for (const srvName of Object.keys(serverCache)) {
      if (skippedSrv.includes(srvName)) continue;
      liveImeisByServer[srvName] = new Set();
      const stArr = Array.isArray(serverCache[srvName].status) ? serverCache[srvName].status : [];
      for (const m of stArr) {
        const imei = m.modem_details && m.modem_details.IMEI;
        if (imei) liveImeisByServer[srvName].add(imei);
      }
    }
    // Pass A: IMEI-dedup — newer wins (modem reassigned to different port).
    for (const list of Object.values(byImei)) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.lastSeen - a.lastSeen);
      for (let i = 1; i < list.length; i++) {
        const old = list[i];
        if (liveIds.has(old.srv + '_' + old.pid)) continue;
        delete knownModems[old.srv][old.pid];
        kmRemoved++; kmChanged = true;
      }
    }
    // Pass B: stale lastSeen — original retention (modem disconnected long ago).
    for (const srvName of Object.keys(knownModems || {})) {
      if (skippedSrv.includes(srvName)) continue;
      const km = knownModems[srvName];
      for (const pid of Object.keys(km)) {
        const fullId = srvName + '_' + pid;
        if (liveIds.has(fullId)) continue;
        const lastSeen = km[pid].lastSeen || 0;
        if (lastSeen > cutoffMs) continue;
        delete km[pid];
        kmRemoved++; kmChanged = true;
      }
    }
    // Pass C: port deleted but IMEI still online (modem moved to a different port,
    // typically an auto-generated "randomport*" default after we removed the named
    // port). The stale km entry would otherwise misattribute the modem to a former
    // client. Detect by: port not in live bw AND IMEI is currently online on the
    // same server — the bind is no longer authoritative.
    for (const srvName of Object.keys(knownModems || {})) {
      if (skippedSrv.includes(srvName)) continue;
      const liveImeis = liveImeisByServer[srvName] || new Set();
      const km = knownModems[srvName];
      for (const pid of Object.keys(km)) {
        if (liveIds.has(srvName + '_' + pid)) continue;        // port still live
        const imei = km[pid].imei;
        if (!imei) continue;
        if (!liveImeis.has(imei)) continue;                    // modem also offline → keep (will be injected as ghost)
        // Modem is online but on a different port → old assignment is stale
        delete km[pid];
        kmRemoved++; kmChanged = true;
      }
    }
    if (kmChanged) saveKnownModems();

    if (dtDeleted || dtMemKeys || kmRemoved) {
      logger.info(`[Retention] Stale port cleanup: daily_traffic=${dtDeleted} rows, dailyTraffic=${dtMemKeys} keys, known_modems=${kmRemoved} entries (threshold ${days}d)`);
      logActivity('system', 'info', 'stale_port_cleanup', null,
        `Cleaned ${dtDeleted} daily_traffic rows, ${dtMemKeys} memory keys, ${kmRemoved} known_modems entries`,
        { days, dtDeleted, dtMemKeys, kmRemoved, skippedSrv });
    }
    return { dtDeleted, dtMemKeys, kmRemoved, skippedSrv, days };
  } catch (e) {
    logger.error('[Retention] stale port cleanup error: ' + e.message);
    return { error: e.message };
  }
}

// Closure for hourly.js dependency (replaces prepared statement)
const _htCleanup = () => {
  const days = Number.isInteger(appSettings.retention_traffic_hourly) && appSettings.retention_traffic_hourly >= 7
    ? appSettings.retention_traffic_hourly : 90;
  return db.prepare(`DELETE FROM traffic_hourly WHERE hour_start < datetime('now', '-${days} days')`).run();
};

// Save yesterday's traffic from live ProxySmart data — called every 5 min
async function syncYesterdayTraffic() {
  try {
    const results = await fetchAllServersDataCached();
    const now = new Date();
    let count = 0;
    const batch = db.transaction(() => {
      for (const data of results) {
        if (data._cached || typeof data.bw !== 'object') continue;
        const prefix = data.serverName + '_';
        // Each server has its own timezone — "yesterday" depends on local midnight
        const srvTz = (SERVER_COUNTRIES[data.serverName] || {}).tz || 'Europe/Moscow';
        const tzOffset = getTzOffset(srvTz);
        const localNow = new Date(now.getTime() + tzOffset * 3600 * 1000);
        const localYesterday = new Date(localNow);
        localYesterday.setUTCDate(localYesterday.getUTCDate() - 1);
        const yesterdayStr = localYesterday.toISOString().slice(0, 10);
        for (const [portId, b] of Object.entries(data.bw)) {
          if (!b.portName) continue;
          const key = prefix + portId;
          const yIn = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
          const yOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
          if (yIn > 0 || yOut > 0) {
            // Skip if yesterday data already exists and today's data is identical (ProxySmart hasn't reset yet)
            const existingYesterday = dailyTraffic[key] && dailyTraffic[key][yesterdayStr];
            if (existingYesterday && existingYesterday.in === yIn && existingYesterday.out === yOut) continue;
            _dtUpsert.run(key, yesterdayStr, yIn, yOut);
            if (!dailyTraffic[key]) dailyTraffic[key] = {};
            dailyTraffic[key][yesterdayStr] = { in: yIn, out: yOut, portName: b.portName };
            count++;
          }
        }
      }
    });
    batch();
    if (count > 0) {
      logger.info(`[DailySync] Saved ${count} yesterday traffic entries`);
      logActivity('traffic', 'info', 'daily_sync', null, `Saved ${count} yesterday traffic entries`, { count });
    }
  } catch (e) {
    logger.error('[DailySync] Error:', e.message);
    logActivity('traffic', 'error', 'daily_sync_error', null, `Daily traffic sync failed: ${e.message}`);
  }
}

// Removed: correctHourlyFromDaily — hourly data should be correct at write time.
// Gaps from restarts are expected; daily_traffic is the source of truth for billing.

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
    });
    batch();
  } catch (e) { logger.error('[saveDailyTraffic] SQLite error:', e.message); }
}

// Hourly traffic aggregation extracted to src/traffic/hourly.js
// Init is called after _metaOpGet is defined (see below)
async function aggregateHourlyTraffic() { return hourlyTraffic.aggregateHourlyTraffic(); }

// parseTrafficValue, getMoscow*, trafficBytesToGb extracted to src/utils/

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
let lastReconciliationMonth = (db.prepare("SELECT value FROM kv_store WHERE key = 'last_reconciliation_month'").get() || {}).value || '';

const KNOWN_MODEMS_FILE = path.join(__dirname, 'known_modems.json');
let knownModems = {}; // { serverName: { portId: { portName, imei, nick, model, portInfo, lastSeen } } }
try {
  if (fs.existsSync(KNOWN_MODEMS_FILE)) {
    knownModems = JSON.parse(fs.readFileSync(KNOWN_MODEMS_FILE, 'utf8'));
  }
} catch (e) { logger.error('Failed to load known_modems:', e.message); }

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

      // Ignore ProxySmart's auto-generated "randomport*" placeholders — these
      // are not real client bindings, and remembering them would re-create
      // ghosts on disconnect.
      const cleanPortName = /^randomport\d+$/i.test(bw.portName || '') ? '' : (bw.portName || '');
      km[portId] = {
        portName: cleanPortName,
        imei,
        nick: (modemStatus && modemStatus.modem_details && modemStatus.modem_details.NICK) || (km[portId] && km[portId].nick) || '',
        model: (modemStatus && modemStatus.modem_details && (modemStatus.modem_details.MODEL_SHOWN || modemStatus.modem_details.MODEL)) || (km[portId] && km[portId].model) || '',
        portInfo: portInfo ? (typeof structuredClone === 'function' ? structuredClone(portInfo) : JSON.parse(JSON.stringify(portInfo))) : (km[portId] && km[portId].portInfo ? km[portId].portInfo : null),
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

// Async mutex for runDailyBilling vs saveClients. Both mutate ledger/balance
// or rebuild the in-memory client maps. Without serialization, billing could
// run on a stale snapshot while saveClients-from-webhook is mid-rebuild.
let _clientsLock = Promise.resolve();
function withClientsLock(fn) {
  const next = _clientsLock.then(() => fn(), () => fn());
  // Don't propagate rejections to subsequent waiters.
  _clientsLock = next.catch(() => {});
  return next;
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
  // Migrate plaintext passwords to bcrypt then nullify plaintext
  if (c.password && !c.password.startsWith('$2b$')) {
    c.passwordHash = bcrypt.hashSync(c.password, 10);
    c.password = null;
    clientsMigrated = true;
  }
  if (!c.passwordHash && c.password) {
    c.passwordHash = bcrypt.hashSync(c.password, 10);
    c.password = null;
    clientsMigrated = true;
  }
}
if (clientsMigrated) saveClients(clients);
rebuildClientMaps(); // Build maps before auto-migration check
// Stage 4: pass getters instead of the maps directly. server.js rebinds
// `clientById = new Map(...)` and `billingLedger = {...}` during state
// rebuilds; getters re-read the current value on every credit/debit so
// the in-memory mirror stays in sync (previously the captured Map went
// stale → HTTP responses showed `balance: 0` after any client create).
billing.init({
  db, _clientGetBalance, _clientUpdateBalance, _ledgerInsert, _ledgerEntryParams,
  getBillingLedger: () => billingLedger,
  getClientById: (id) => clientById.get(id),
});

// DB-level audit (triggers + JS context layer). Initialized after migrations
// so triggers exist; harmless if already initialized.
const dbAudit = require('./src/audit/db_audit');
dbAudit.init({ db, logger });

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
      logger.info(`  Auto-migrated user ${login} -> client "${u.portNameFilter}"`);
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
logger.info(`Loaded ${Object.keys(users).length} user(s): ${Object.keys(users).join(', ')}`);
logger.info(`  - ${clients.length} client(s) from SQLite`);
rebuildClientMaps();

function getSessionTTL() { return (appSettings.session_ttl_days || 30) * 86400000; }

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

const _intervals = [];
let _hourlyLoopTimeout = null;
let _hourlyAggStopped = false;
_intervals.push(setInterval(() => {
  const result = dbStmts.cleanExpiredSessions.run(Date.now());
  if (result.changes > 0) {
    logger.info(`[Sessions] Cleaned ${result.changes} expired session(s)`);
    logActivity('system', 'info', 'session_cleanup', null, `Cleaned ${result.changes} expired session(s)`, { removed: result.changes });
  }
}, 60 * 60 * 1000));

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateId() { return crypto.randomBytes(8).toString('hex'); }

// (kv_store helpers moved earlier — see right after runMigrations() so they're
// available when api_servers loads from the DB during initial bootstrap.)

const SETTINGS_DEFAULTS = {
  speedtest_times: ['02:00', '14:00'],
  pricing_tiers: [
    { min_proxies: 1, price: 30, label: '1-4 прокси' },
    { min_proxies: 5, price: 25, label: '5-9 прокси' },
    { min_proxies: 10, price: 23, label: '10-19 прокси' },
    { min_proxies: 20, price: 20, label: '20+ прокси' }
  ],
  proxy_check_target: 'https://www.instagram.com/',
  proxy_check_warn_ms: 500,
  proxy_check_bad_ms: 2000,
  proxy_check_interval_min: 60,
  // Auto-recovery
  recovery_offline_sec: 60,
  recovery_max_attempts: 3,
  recovery_retry_min: 3,
  // Modem tracking & rotation
  tracking_interval_min: 3,
  rotation_cache_ttl_min: 30,
  rotation_sync_interval_min: 30,
  // Proxy check (additional)
  proxy_check_timeout_sec: 15,
  proxy_check_concurrency: 10,
  error_rate_threshold: 15, // % errors to highlight red in modem table
  // "Сбоит прокси" alerts (Проблемы инфраструктуры): per-modem flaky thresholds
  proxy_alert_latency_ms: 1500, // avg latency above which modem is flagged as flaky
  proxy_alert_error_pct:  5,    // error % above which modem is flagged as flaky
  proxy_alert_window_min: 60,   // evaluation window (minutes)
  // Auto-reboot of flaky modems (high latency / high errors only — NOT for rotation-fail)
  auto_reboot_enabled:         false, // disabled by default — admin enables in Settings
  auto_reboot_min_interval_min: 60,   // throttle: don't reboot same modem more often than this
  // Speedtest (additional)
  speedtest_low_threshold: 1,
  speedtest_retest_delay_min: 10,
  speedtest_max_history: 30,
  // Data retention (days)
  retention_traffic_hourly: 90,
  retention_daily_traffic: 90,
  retention_audit_log: 90,
  retention_system_log: 30,
  retention_rotation_log: 90,
  retention_proxy_checks: 30,
  retention_modem_meta: 30,
  retention_api_usage: 30,
  retention_db_audit: 365,
  retention_simulator_runs: 30,
  // Session & billing
  session_ttl_days: 30,
  billing_retry_delay_hours: 1,
  reconciliation_tolerance_gb: 0.01,
  // CRM & auto-create
  auto_create_interval_min: 10,
  crm_check_interval_min: 10,
  crm_reminder_days: 3,
  // Telegram daily summary
  telegram_bot_token: '',
  telegram_chat_id: '',
  telegram_summary_enabled: true,
  telegram_summary_time: '08:00', // HH:MM МСК
  telegram_last_sent_date: '',    // YYYY-MM-DD — written after each successful send
  // Strict mode for Tochka webhook signatures: when true, unverified webhooks
  // are rejected outright instead of being saved for manual review. Default
  // false — lossy mode preferred during JWKS rotation flakes.
  tochka_strict_webhook: false
};

let appSettings = { ...SETTINGS_DEFAULTS };
// Load from SQLite, fallback to settings.json for migration
try {
  const row = _kvGet.get('app_settings');
  if (row) {
    appSettings = { ...SETTINGS_DEFAULTS, ...JSON.parse(row.value) };
  } else {
    // One-time migration from settings.json
    const SETTINGS_FILE = path.join(__dirname, 'settings.json');
    if (fs.existsSync(SETTINGS_FILE)) {
      appSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      _kvSet.run('app_settings', JSON.stringify(appSettings));
      logger.info('[Settings] Migrated from settings.json to SQLite');
    } else {
      _kvSet.run('app_settings', JSON.stringify(appSettings));
    }
  }
} catch (e) { logger.error('Failed to load settings:', e.message); }

function saveSettings() {
  _kvSet.run('app_settings', JSON.stringify(appSettings));
}

function getPriceForProxyCount(count) {
  const tiers = appSettings.pricing_tiers || [];
  // Sort descending by min_proxies to find the right tier
  const sorted = tiers.slice().sort((a, b) => b.min_proxies - a.min_proxies);
  for (const tier of sorted) {
    if (count >= tier.min_proxies) return tier.price;
  }
  return tiers.length > 0 ? tiers[0].price : 23; // fallback
}

// parseBwToBytes, normalizeOperator extracted to src/utils/traffic.js

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

// Russian plural for "модем" in genitive case (used in "Списание за аренду N модем*")
// 1 → модема (singular gen), 2-4 → модема (sing gen), 5-20 → модемов (plur gen),
// 21 → модема (after 1 ending), 22-24 → модема (2-4 ending), 25-30 → модемов, etc.
// Special case: 11-14 always "модемов".
function modemPlural(n) {
  n = Math.abs(Math.round(Number(n) || 0)) % 100;
  const last = n % 10;
  if (n >= 11 && n <= 14) return 'модемов';
  if (last === 1) return 'модема';
  if (last >= 2 && last <= 4) return 'модема';
  return 'модемов';
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

// Compute bytes for a client on a specific MSK date.
// Source priority:
//   1. traffic_hourly grouped by client_name (independent of ProxySmart yesterday counter,
//      so it survives ProxySmart restarts that zero the daily counters)
//   2. fallback to daily_traffic table joined via portKeyToPortName mapping
// Returns total bytes (in + out).
function getClientBytesForMskDate(portName, date) {
  if (!portName || !date) return 0;
  const r1 = db.prepare(`
    SELECT COALESCE(SUM(bytes_in + bytes_out), 0) as bytes
    FROM traffic_hourly
    WHERE client_name = ?
      AND substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
  `).get(portName, date);
  if (r1.bytes > 0) return r1.bytes;
  // Fallback — daily_traffic stores by port_id; resolve via in-memory map
  const portIds = [];
  for (const [k, v] of Object.entries(portKeyToPortName)) {
    if (v === portName) portIds.push(k);
  }
  if (portIds.length === 0) return 0;
  const placeholders = portIds.map(() => '?').join(',');
  const r2 = db.prepare(`
    SELECT COALESCE(SUM(bytes_in + bytes_out), 0) as bytes
    FROM daily_traffic
    WHERE date = ? AND port_name IN (${placeholders})
  `).get(date, ...portIds);
  return r2.bytes || 0;
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
    const pn = portKeyToPortName[portKey]
      || (Object.values(days)[0] && Object.values(days)[0].portName)
      || '';
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

const DOCUMENTS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // trust first proxy (nginx) — req.ip uses x-forwarded-for
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// Per-request correlation ID — propagated through logs so we can grep a
// single request's lifecycle across multiple subsystems. Honour caller's
// X-Request-Id if they supplied one (lets nginx/edge inject a trace ID),
// otherwise generate one. Echo back in response so clients can quote it
// when reporting bugs.
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id = (typeof incoming === 'string' && /^[a-zA-Z0-9-]{4,64}$/.test(incoming))
    ? incoming
    : crypto.randomBytes(6).toString('hex');
  req.id = id;
  res.set('X-Request-Id', id);
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Request ID for logging
app.use((req, res, next) => {
  req.id = uuidv4();
  res.set('X-Request-Id', req.id);
  next();
});

// DB-audit per-request context (lazy: only inserts a context_id row when
// the handler does an actual DB write that hits an audited table).
app.use(dbAudit.expressMiddleware);

// Rate limiting for login endpoint (SEC-03: anti-bruteforce, per real client IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 attempts per real client IP per window
  keyGenerator: (req) => getClientIp(req), // use real IP behind nginx, not proxy IP
  message: { error: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // don't count successful logins
});

const resetTokenLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 attempts per IP per minute
  keyGenerator: (req) => getClientIp(req),
  message: { error: 'Too many requests, try again in 1 minute' },
  standardHeaders: true,
  legacyHeaders: false
});

const checkProxyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // max 5 batch checks per IP per minute
  keyGenerator: (req) => getClientIp(req),
  message: { error: 'Too many proxy check requests, try again in 1 minute' },
  standardHeaders: true,
  legacyHeaders: false
});

// Public client API — 120 requests/min per IP+key combo. Per-key keying so
// one abusive integration can't starve other clients sharing an IP.
const apiV1Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => (req.headers['x-api-key'] || req.query.apikey || getClientIp(req)),
  message: { success: false, error: 'Rate limit exceeded — slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

// Admin/client dashboard data — heavy endpoint that hits all 4 ProxySmart
// servers. 60 requests/min per session token (= one admin tab refreshing
// every ~1s is the soft ceiling).
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.headers['x-auth-token'] || getClientIp(req)),
  message: { error: 'Dashboard rate limit exceeded — wait a few seconds' },
  standardHeaders: true,
  legacyHeaders: false
});

// CSRF posture (rationale):
//   • Primary auth uses X-Auth-Token header (custom header).
//   • Browser cross-origin requests cannot set custom headers without an
//     explicit Access-Control-Allow-Headers OK from this server (CORS).
//   • Cookie support (pr_session) is httpOnly + SameSite=Strict, which means
//     other sites cannot ride along — the cookie is only sent on same-origin
//     navigation/AJAX from dashboard.proxies.rent itself.
//   • Therefore standard CSRF tokens are not required at this time. If we
//     ever switch to cookie-only with SameSite=Lax/None, add a CSRF token
//     (double-submit cookie pattern is the cheap fix).
function _readSessionToken(req) {
  // Header takes priority for backwards compatibility (existing frontend).
  // Cookie is the safer transport — httpOnly means XSS can't steal it.
  if (req.headers['x-auth-token']) return req.headers['x-auth-token'];
  const cookieHdr = req.headers['cookie'] || '';
  const m = cookieHdr.match(/(?:^|;\s*)pr_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function authMiddleware(req, res, next) {
  const token = _readSessionToken(req);
  const sess = getSession(token);
  if (!sess) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = sess;
  // Ensure DB-audit knows who's behind any subsequent write in this request.
  // Cheap (one INSERT per write request) — no-op for read-only GETs that
  // never trigger watched tables.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { dbAudit.ensureRequestContext(req.method + ' ' + (req.originalUrl || req.path || '').split('?')[0]); } catch (_) { /* best-effort: error intentionally swallowed */ }
  }
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// /metrics + /health moved into src/routes/ops.js (Stage 3). Mounted below.
app.use(require('./src/routes/ops')({
  db, logger, DB_PATH,
  getSessionCount: () => getSessionCount(),
  // Getter forms so the router sees the current `billingLedger` and `clients`
  // bindings — they're `let`s that get rebound on reload.
  getBillingLedger: () => billingLedger,
  getClients: () => clients,
}));

// Admin health — detailed info
app.get('/api/admin/health', authMiddleware, adminMiddleware, (req, res) => {
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
    database: { size_kb: dbSize, ledger_entries: ledgerEntryCount, wal_mode: true },
    billing: lastBillingRunSummary || { last_run: null },
    reconciliation: { last_month: lastReconciliationMonth || null },
    intervals: _intervals.length,
    timestamp: new Date().toISOString()
  });
});

// /api/login, /api/logout, /api/admin/impersonate moved into src/routes/auth.js
app.use(require('./src/routes/auth')({
  logger,
  loginLimiter, validate, LoginSchema, authMiddleware, adminMiddleware,
  getUsers: () => users,
  getClientById: (id) => clientById.get(id),
  generateToken, createSession, deleteSession, getSessionTTL,
  _readSessionToken, auditLog, getClientIp,
}));

// extractServerName, getHttpLib -> moved to src/api/proxy-smart.js
const extractServerName = proxySmart.extractServerName;
const getHttpLib = proxySmart.getHttpLib;

// Manual billing trigger
// =========== Финансовая аналитика ===========

// Категории затрат и их subkey-структура
const COST_CATEGORIES = {
  server:      { label: 'Аренда серверов', perItem: true,  itemType: 'server' },   // subkey = S1/S2/...
  sim:         { label: 'SIM-карты',       perItem: true,  itemType: 'operator' }, // subkey = Orange MD / Moldtelecom / ...
  electricity: { label: 'Электричество',   perItem: false },
  hosting:     { label: 'Хостинг/связь',   perItem: false },
  salary:      { label: 'Зарплата',        perItem: false },
  other:       { label: 'Прочее',          perItem: false }
};

// GET /api/admin/monthly_costs?period=YYYY-MM
// Возвращает все строки затрат за период + meta (категории, операторы, серверы для UI).
app.get('/api/admin/monthly_costs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period
                 : new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`SELECT id, period, category, subkey, amount, notes, updated_at
      FROM monthly_costs WHERE period = ? ORDER BY category, subkey`).all(period);
    // Если за период пусто — auto-fill из предыдущего месяца (как шаблон, без сохранения)
    let template = null;
    if (rows.length === 0) {
      const prev = db.prepare("SELECT MAX(period) as p FROM monthly_costs WHERE period < ?").get(period).p;
      if (prev) {
        template = db.prepare(`SELECT category, subkey, amount, notes
          FROM monthly_costs WHERE period = ?`).all(prev);
      }
    }
    // Список операторов (для SIM): из live ProxySmart
    const operators = db.prepare(`SELECT DISTINCT operator FROM modem_meta
      WHERE operator != '' ORDER BY operator`).all().map(r => r.operator);
    const servers = apiServers.map(s => s.name);
    res.json({
      period, rows, template,
      categories: COST_CATEGORIES,
      meta: { operators, servers }
    });
  } catch (e) {
    logger.error('[monthly_costs/get]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/monthly_costs
// Body: { period: 'YYYY-MM', items: [{category, subkey, amount, notes}, ...] }
// Перезаписывает строки за период (атомарно).
app.post('/api/admin/monthly_costs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const period = String(req.body?.period || '');
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period YYYY-MM required' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    db.transaction(() => {
      db.prepare('DELETE FROM monthly_costs WHERE period = ?').run(period);
      const ins = db.prepare(`INSERT INTO monthly_costs (period, category, subkey, amount, notes)
        VALUES (?, ?, ?, ?, ?)`);
      for (const it of items) {
        if (!it || !it.category) continue;
        const amount = Number(it.amount);
        if (!Number.isFinite(amount) || amount < 0) continue;
        if (!COST_CATEGORIES[it.category]) continue;
        ins.run(period, it.category, it.subkey || null, amount, (it.notes || '').slice(0, 500));
      }
    })();
    auditLog(req.user.login, 'monthly_costs_save', { period, count: items.length });
    res.json({ ok: true, period, saved: items.length });
  } catch (e) {
    logger.error('[monthly_costs/post]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/finance_dashboard
// Считает все метрики для финансового дашборда.
// MRR — trailing 30d revenue per client. NRR — 3-month cohort.
// Cached for 60s — recomputation is heavy (~200ms with 30+ aggregations).
let _financeCache = null;
let _financeCacheTs = 0;
let _financeCacheKey = '';
const FINANCE_CACHE_TTL_MS = 60 * 1000;
app.get('/api/admin/finance_dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const period = String(req.query.period || '').match(/^\d{4}-\d{2}$/) ? req.query.period
                 : todayStr.slice(0, 7);
    const cacheKey = period;
    if (_financeCache && _financeCacheKey === cacheKey && (Date.now() - _financeCacheTs) < FINANCE_CACHE_TTL_MS) {
      return res.json(_financeCache);
    }

    // Date helpers
    const isoDay = d => d.toISOString().slice(0, 10);
    const dayMs = 86400000;
    const since30 = isoDay(new Date(now.getTime() - 30 * dayMs));
    const since60 = isoDay(new Date(now.getTime() - 60 * dayMs));
    const since90 = isoDay(new Date(now.getTime() - 90 * dayMs));
    const since120 = isoDay(new Date(now.getTime() - 120 * dayMs));
    const since365 = isoDay(new Date(now.getTime() - 365 * dayMs));

    // -- per-client MRR (trailing 30d revenue) --
    const mrrRows = db.prepare(`SELECT client_id, SUM(amount) as mrr
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY client_id`).all(since30);
    const mrrByClient = Object.fromEntries(mrrRows.map(r => [r.client_id, Math.round(r.mrr * 100) / 100]));

    // -- per-client previous 30d (60..30 days ago) --
    const prevMrrRows = db.prepare(`SELECT client_id, SUM(amount) as mrr
      FROM billing_ledger WHERE type='charge' AND date >= ? AND date < ? GROUP BY client_id`).all(since60, since30);
    const prevMrrByClient = Object.fromEntries(prevMrrRows.map(r => [r.client_id, Math.round(r.mrr * 100) / 100]));

    // -- 3 months ago window (120..90 days ago) for NRR baseline --
    const baseRows = db.prepare(`SELECT client_id, SUM(amount) as rev
      FROM billing_ledger WHERE type='charge' AND date >= ? AND date < ? GROUP BY client_id`).all(since120, since90);
    const baseByClient = Object.fromEntries(baseRows.map(r => [r.client_id, Math.round(r.rev * 100) / 100]));

    // -- per-tariff split --
    const totalMrr = Object.values(mrrByClient).reduce((s, v) => s + v, 0);
    const prevTotalMrr = Object.values(prevMrrByClient).reduce((s, v) => s + v, 0);
    const mrrGrowthPct = prevTotalMrr > 0 ? Math.round(((totalMrr - prevTotalMrr) / prevTotalMrr) * 1000) / 10 : null;

    // Per-tariff revenue
    const perTariffRows = db.prepare(`SELECT
      COALESCE(json_extract(details, '$.billing_type'), 'per_gb') as bt,
      SUM(amount) as rev
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY bt`).all(since30);
    const perTariff = {};
    perTariffRows.forEach(r => { perTariff[r.bt || 'per_gb'] = Math.round(r.rev * 100) / 100; });

    // -- ARR --
    const arr = Math.round(totalMrr * 12);

    // -- Active / new / churned --
    const activeClients = clients.filter(c => !c.billingPaused && (mrrByClient[c.id] || 0) > 0);
    const periodFirstDay = period + '-01';
    const newClients = clients.filter(c => (c.createdAt || '').slice(0, 10) >= periodFirstDay
                                          && (c.createdAt || '').slice(0, 7) === period);
    // Churned: had revenue in [60..30d ago], no revenue in last 30d, and (paused OR balance < 0)
    const churnedClients = clients.filter(c => {
      const had = (prevMrrByClient[c.id] || 0) > 0;
      const has = (mrrByClient[c.id] || 0) > 0;
      return had && !has;
    });

    // -- ARPU --
    const arpu = activeClients.length > 0 ? Math.round(totalMrr / activeClients.length) : 0;

    // -- Top-N concentration --
    const sortedByMrr = Object.entries(mrrByClient)
      .map(([cid, mrr]) => ({ cid, mrr, name: (clientById.get(cid) || {}).name || cid }))
      .sort((a, b) => b.mrr - a.mrr);
    const topN = (n) => sortedByMrr.slice(0, n).reduce((s, x) => s + x.mrr, 0);
    const top1 = sortedByMrr[0] || null;
    const concentration = totalMrr > 0 ? {
      top1_pct:  Math.round((topN(1) / totalMrr) * 1000) / 10,
      top1_name: top1 ? top1.name : '—',
      top3_pct:  Math.round((topN(3) / totalMrr) * 1000) / 10,
      top5_pct:  Math.round((topN(5) / totalMrr) * 1000) / 10
    } : { top1_pct: 0, top1_name: '—', top3_pct: 0, top5_pct: 0 };

    // -- NRR (3-month cohort) --
    // Cohort = clients that had revenue in [120..90d ago].
    // Their revenue then vs their revenue now (last 30d).
    const cohortIds = Object.keys(baseByClient);
    const cohortRevenueThen = cohortIds.reduce((s, id) => s + (baseByClient[id] || 0), 0);
    // Their CURRENT 30-day revenue (only the same cohort, including expansions)
    const cohortRevenueNow = cohortIds.reduce((s, id) => s + (mrrByClient[id] || 0), 0);
    // Normalize "then" to a 30-day window (the baseRows window is also 30 days, so direct ratio)
    const nrrPct = cohortRevenueThen > 0 ? Math.round((cohortRevenueNow / cohortRevenueThen) * 1000) / 10 : null;

    // -- Churn rate --
    const startOfPeriodActive = clients.filter(c => (prevMrrByClient[c.id] || 0) > 0).length;
    const churnRatePct = startOfPeriodActive > 0
      ? Math.round((churnedClients.length / startOfPeriodActive) * 1000) / 10
      : 0;

    // -- Modem utilization (live data) --
    let liveResults = [];
    try { liveResults = await fetchAllServersDataCached(); } catch (_) { /* best-effort: error intentionally swallowed */ }
    let totalModems = 0, rentedModems = 0;
    const modemsByServer = {};
    const modemsByOperator = {};
    const modemsByPortName = {};
    for (const data of liveResults) {
      const srv = data.serverName;
      if (typeof data.bw !== 'object') continue;
      modemsByServer[srv] = modemsByServer[srv] || { total: 0, rented: 0 };
      const isRO = (SERVER_COUNTRIES[srv] || {}).country === 'RO';
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const opByImei = {};
      for (const m of statusArr) {
        const md = m.modem_details || {};
        if (md.IMEI) {
          const op = normalizeOperator(((m.net_details || {}).CELLOP || md.OPERATOR || ''), isRO);
          opByImei[md.IMEI] = op;
        }
      }
      const portsMap = data.ports || {};
      for (const [portId, b] of Object.entries(data.bw)) {
        totalModems++;
        modemsByServer[srv].total++;
        if (b.portName) {
          rentedModems++;
          modemsByServer[srv].rented++;
          modemsByPortName[b.portName] = modemsByPortName[b.portName] || { count: 0, server: srv };
          modemsByPortName[b.portName].count++;
        }
        // Operator from status
        // Find IMEI for this portId
        for (const imei in portsMap) {
          if (Array.isArray(portsMap[imei])) {
            for (const p of portsMap[imei]) {
              if (p.portID === portId) {
                const op = opByImei[imei];
                if (op) {
                  modemsByOperator[op] = modemsByOperator[op] || { total: 0, rented: 0 };
                  modemsByOperator[op].total++;
                  if (b.portName) modemsByOperator[op].rented++;
                }
                break;
              }
            }
          }
        }
      }
    }
    const utilPct = totalModems > 0 ? Math.round((rentedModems / totalModems) * 1000) / 10 : 0;

    // -- Costs (current period) --
    const costRows = db.prepare(`SELECT category, subkey, amount FROM monthly_costs WHERE period = ?`).all(period);
    const totalCost = costRows.reduce((s, r) => s + (r.amount || 0), 0);
    const costByCategory = {};
    costRows.forEach(r => {
      costByCategory[r.category] = (costByCategory[r.category] || 0) + (r.amount || 0);
    });
    const costPerModem = totalModems > 0 ? Math.round((totalCost / totalModems) * 100) / 100 : 0;

    // -- RPM (revenue per rented modem) --
    const rpm = rentedModems > 0 ? Math.round((totalMrr / rentedModems) * 100) / 100 : 0;
    const marginPerModem = Math.round((rpm - costPerModem) * 100) / 100;

    // -- Revenue per server / per operator (revenue allocated by client portName→server) --
    const portKeyToClient = {};
    for (const c of clients) if (c.portName) portKeyToClient[c.portName] = c.id;
    const revBySrv = {}, revByOp = {};
    for (const data of liveResults) {
      const srv = data.serverName;
      if (typeof data.bw !== 'object') continue;
      const portClientCount = {};
      for (const b of Object.values(data.bw)) {
        if (b.portName) portClientCount[b.portName] = (portClientCount[b.portName] || 0) + 1;
      }
      // For each client on this server: their MRR proportional to number of modems on this server
      for (const [pn, modemCount] of Object.entries(portClientCount)) {
        const cid = portKeyToClient[pn];
        if (!cid) continue;
        const cMrr = mrrByClient[cid] || 0;
        const totalModemsOfClient = (modemsByPortName[pn] || {}).count || modemCount;
        const portion = totalModemsOfClient > 0 ? cMrr * (modemCount / totalModemsOfClient) : 0;
        revBySrv[srv] = (revBySrv[srv] || 0) + portion;
      }
    }
    // Per-server table
    const perServer = Object.keys(modemsByServer).sort().map(s => {
      const total = modemsByServer[s].total;
      const rented = modemsByServer[s].rented;
      const rev = Math.round(revBySrv[s] || 0);
      return {
        server: s,
        total, rented,
        utilization_pct: total > 0 ? Math.round((rented / total) * 1000) / 10 : 0,
        revenue: rev,
        revenue_per_modem: rented > 0 ? Math.round((rev / rented) * 100) / 100 : 0
      };
    });
    const perOperator = Object.keys(modemsByOperator).sort().map(op => ({
      operator: op,
      total:    modemsByOperator[op].total,
      rented:   modemsByOperator[op].rented,
      utilization_pct: modemsByOperator[op].total > 0
        ? Math.round((modemsByOperator[op].rented / modemsByOperator[op].total) * 1000) / 10 : 0
    }));

    // -- Per-client breakdown --
    const perClient = clients
      .map(c => {
        const cMrr  = mrrByClient[c.id]     || 0;
        const cPrev = prevMrrByClient[c.id] || 0;
        const delta = cPrev > 0 ? Math.round(((cMrr - cPrev) / cPrev) * 1000) / 10 : null;
        const sharePct = totalMrr > 0 ? Math.round((cMrr / totalMrr) * 1000) / 10 : 0;
        return {
          id: c.id,
          name: c.name,
          billingType: c.billingType || 'per_gb',
          price: c.price || 0,
          balance: c.balance || 0,
          mrr: cMrr,
          mrr_prev: cPrev,
          mrr_delta_pct: delta,
          share_pct: sharePct,
          paused: !!c.billingPaused
        };
      })
      .sort((a, b) => b.mrr - a.mrr);

    // -- Pricing variance --
    const perGbPrices = clients.filter(c => c.billingType === 'per_gb' && c.price > 0).map(c => c.price);
    const perModemPrices = clients.filter(c => c.billingType === 'per_modem' && c.price > 0).map(c => c.price);
    function stats(arr) {
      if (arr.length === 0) return null;
      const min = Math.min(...arr), max = Math.max(...arr);
      const avg = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 100) / 100;
      return { count: arr.length, min, max, avg };
    }

    // -- MRR trend (last 12 months) --
    const trendRows = db.prepare(`SELECT substr(date, 1, 7) as month, SUM(amount) as revenue
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY month ORDER BY month`).all(since365);
    const trend = [];
    // Also detail by tariff
    const trendTariffRows = db.prepare(`SELECT substr(date, 1, 7) as month,
      COALESCE(json_extract(details, '$.billing_type'), 'per_gb') as bt, SUM(amount) as revenue
      FROM billing_ledger WHERE type='charge' AND date >= ? GROUP BY month, bt ORDER BY month`).all(since365);
    const trendIdx = {};
    for (const r of trendRows) {
      const o = { month: r.month, total: Math.round(r.revenue), per_gb: 0, per_modem: 0 };
      trendIdx[r.month] = o; trend.push(o);
    }
    for (const r of trendTariffRows) {
      if (trendIdx[r.month]) trendIdx[r.month][r.bt] = Math.round(r.revenue);
    }

    // -- EOM forecast for current month --
    const monthStart = todayStr.slice(0, 7) + '-01';
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysLeft = daysInMonth - dayOfMonth;
    const monthRevenueSoFar = db.prepare(`SELECT SUM(amount) s FROM billing_ledger
      WHERE type='charge' AND date >= ? AND date <= ?`).get(monthStart, todayStr).s || 0;
    // Per-day average rate from current month so far
    const dailyRateSoFar = dayOfMonth > 0 ? monthRevenueSoFar / dayOfMonth : 0;
    const forecastEOM = Math.round(monthRevenueSoFar + dailyRateSoFar * daysLeft);

    // -- Daily revenue last 30 days for sparkline --
    const dailyRows = db.prepare(`SELECT date, SUM(amount) as rev FROM billing_ledger
      WHERE type='charge' AND date >= ? GROUP BY date ORDER BY date`).all(since30);

    const payload = {
      period,
      now: now.toISOString(),
      summary: {
        mrr: Math.round(totalMrr),
        mrr_prev: Math.round(prevTotalMrr),
        mrr_growth_pct: mrrGrowthPct,
        arr,
        active_clients: activeClients.length,
        new_clients: newClients.length,
        churned_clients: churnedClients.length,
        churn_rate_pct: churnRatePct,
        arpu,
        nrr_pct: nrrPct,
        nrr_cohort_size: cohortIds.length,
        utilization_pct: utilPct,
        total_modems: totalModems,
        rented_modems: rentedModems,
        rpm,
        cpm: costPerModem,
        margin_per_modem: marginPerModem,
        total_cost: Math.round(totalCost),
        forecast_eom: forecastEOM,
        forecast_so_far: Math.round(monthRevenueSoFar)
      },
      concentration,
      per_tariff_revenue: perTariff,
      pricing: {
        per_gb: stats(perGbPrices),
        per_modem: stats(perModemPrices)
      },
      cost_by_category: costByCategory,
      per_server: perServer,
      per_operator: perOperator,
      per_client: perClient,
      trend,
      churned: churnedClients.map(c => ({ id: c.id, name: c.name, last_mrr: prevMrrByClient[c.id] || 0 })),
      new: newClients.map(c => ({ id: c.id, name: c.name, created: c.createdAt, mrr: mrrByClient[c.id] || 0 })),
      daily_revenue: dailyRows.map(r => ({ date: r.date, revenue: Math.round(r.rev) }))
    };
    _financeCache = payload; _financeCacheKey = cacheKey; _financeCacheTs = Date.now();
    res.json(payload);
  } catch (e) {
    logger.error('[finance_dashboard] ' + (e.stack || e.message));
    res.status(500).json({ error: 'Finance dashboard failed' });
  }
});

// Invalidator — called whenever ledger or settings change that affect finance metrics.
function invalidateFinanceCache() { _financeCache = null; _financeCacheTs = 0; }

// Async-fire-and-track pattern: launch billing in background, return a job ID.
// Caller polls /api/admin/jobs/:id for completion. Avoids HTTP timeouts
// when billing takes >30s.
const _jobs = new Map(); // jobId → { status, startedAt, finishedAt, error, result }
function _startJob(name, fn) {
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { id: jobId, name, status: 'running', startedAt: new Date().toISOString() };
  _jobs.set(jobId, job);
  // Trim job map at 200 entries
  if (_jobs.size > 200) {
    const oldest = Array.from(_jobs.keys()).slice(0, _jobs.size - 200);
    for (const k of oldest) _jobs.delete(k);
  }
  Promise.resolve().then(() => fn()).then(result => {
    job.status = 'done'; job.finishedAt = new Date().toISOString(); job.result = result;
  }).catch(e => {
    job.status = 'failed'; job.finishedAt = new Date().toISOString(); job.error = e.message;
  });
  return jobId;
}
app.get('/api/admin/jobs/:id', authMiddleware, adminMiddleware, (req, res) => {
  const job = _jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

app.post('/api/admin/run_billing', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // sync=1 → wait for completion (preserves old behavior).
    // default async — returns immediately with job ID.
    if (req.query.sync === '1') {
      await runDailyBilling();
      return res.json({ ok: true });
    }
    const jobId = _startJob('run_billing', () => runDailyBilling());
    res.json({ ok: true, jobId, status_url: `/api/admin/jobs/${jobId}` });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

// Re-run billing for a specific past MSK date.
// Use case: a ProxySmart server was offline at midnight, its yesterday counters
// reset to 0, and the original daily billing produced empty / partial charges.
// This recomputes from the durable traffic_hourly source.
//
// Body: { date: "YYYY-MM-DD", client_ids?: [string], dry_run?: bool }
// - date is required and must be in the past (today is still active)
// - client_ids optional; if omitted, processes all clients without an existing charge
// - dry_run prints what would happen without writing
app.post('/api/admin/billing_rerun', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const date = String((req.body && req.body.date) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date YYYY-MM-DD required' });
    const today = getMoscowToday();
    if (date >= today) return res.status(400).json({ error: 'date must be strictly in the past' });

    const targetClientIds = Array.isArray(req.body && req.body.client_ids) ? new Set(req.body.client_ids) : null;
    const dryRun = !!(req.body && req.body.dry_run);

    // Already-charged client ids for that date
    const alreadyCharged = new Set(
      db.prepare("SELECT DISTINCT client_id FROM billing_ledger WHERE type='charge' AND date = ?").all(date).map(r => r.client_id)
    );

    const dt = new Date(date + 'T12:00:00Z');
    const dateLabel = dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const daysInMonth = new Date(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0).getDate();

    const report = [];
    let charged = 0, skipped = 0, totalCost = 0;

    for (const client of clients) {
      if (targetClientIds && !targetClientIds.has(client.id)) continue;
      if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) {
        report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'no_billing' });
        skipped++; continue;
      }
      if (alreadyCharged.has(client.id)) {
        report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'already_billed' });
        skipped++; continue;
      }

      const deltaBytes = getClientBytesForMskDate(client.portName, date);
      const deltaGb = trafficBytesToGb(deltaBytes);

      if (deltaBytes <= 0) {
        report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'no_traffic' });
        skipped++; continue;
      }

      let cost = 0;
      let modemCount = 0;
      if (client.billingType === 'per_modem') {
        // Modem count from traffic_hourly distinct nicks for that day
        modemCount = db.prepare(`
          SELECT COUNT(DISTINCT nick) as n FROM traffic_hourly
          WHERE client_name = ?
            AND substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
        `).get(client.portName, date).n || 0;
        cost = (client.price * modemCount) / daysInMonth;
      } else {
        cost = client.price * deltaGb;
      }
      cost = Math.round(cost * 100) / 100;
      if (cost <= 0) { skipped++; continue; }

      if (dryRun) {
        report.push({ client_id: client.id, name: client.name, status: 'would_charge', gb: deltaGb, cost });
        continue;
      }

      // Charges always proceed; only enforce admin-set hard floor if any.
      let minBalance = null;
      if (typeof client.maxDebt === 'number' && client.maxDebt > 0) {
        minBalance = -Math.abs(client.maxDebt);
      }

      try {
        const debitRes = atomicDebit(client.id, cost, {
          type: 'charge',
          date,
          timestamp: new Date().toISOString(),
          delta_bytes: Math.round(deltaBytes),
          delta_gb: deltaGb,
          price_per_unit: client.price,
          billing_type: client.billingType || 'per_gb',
          modem_count: modemCount || null,
          days_in_month: daysInMonth,
          cost,
          currency: client.currency || 'RUB',
          note: client.billingType === 'per_modem'
            ? `Списание за аренду ${modemCount} ${modemPlural(modemCount)} (${dateLabel}) — recomputed`
            : `Списание за трафик (${dateLabel}) — recomputed`,
          traffic_source: 'billing_rerun'
        }, { minBalance });

        if (debitRes && debitRes.duplicate) {
          report.push({ client_id: client.id, name: client.name, status: 'skip', reason: 'duplicate_at_db' });
          skipped++; continue;
        }
        report.push({ client_id: client.id, name: client.name, status: 'charged', gb: deltaGb, cost, balance_after: debitRes.balanceAfter });
        charged++; totalCost += cost;
        logActivity('billing', 'info', 'billing_rerun_charge', client.name,
          `Rerun charge ${cost} ${client.currency || 'RUB'} for ${deltaGb}GB on ${date}`,
          { client_id: client.id, gb: deltaGb, cost, date });
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_BALANCE') {
          report.push({ client_id: client.id, name: client.name, status: 'fail', reason: 'insufficient_balance', cost });
        } else {
          report.push({ client_id: client.id, name: client.name, status: 'error', error: e.message });
          logger.error(`[Billing rerun] ${client.name}:`, e.message);
        }
      }
    }

    if (!dryRun && charged > 0) saveClients(clients);

    logger.info(`[Billing rerun] date=${date} charged=${charged} skipped=${skipped} total=${totalCost.toFixed(2)} dry=${dryRun}`);
    auditLog(req.user.login, 'billing_rerun', { date, charged, skipped, total: totalCost, dry_run: dryRun });
    res.json({ ok: true, date, charged, skipped, total_cost: Math.round(totalCost * 100) / 100, dry_run: dryRun, report });
  } catch (e) {
    logger.error('[billing_rerun]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// fetchApi, fetchApiRaw, postApi, findServer -> moved to src/api/proxy-smart.js
const fetchApi = proxySmart.fetchApi;
const fetchApiRaw = proxySmart.fetchApiRaw;
const postApi = proxySmart.postApi;
// postFormApi defined below in ASSIGN/UNASSIGN section (single definition)
const findServer = proxySmart.findServer;

// ===== SERVER DATA CACHE =====
// serverCache, saveServerCache, cacheServerData, getCachedDataAsOffline -> moved to src/api/proxy-smart.js
const SERVER_CACHE_FILE = path.join(__dirname, 'server_cache.json');
const saveServerCache = proxySmart.saveServerCache;
const cacheServerData = proxySmart.cacheServerData;
const getCachedDataAsOffline = proxySmart.getCachedDataAsOffline;

const modemRotationCache = {}; // { "S1:IMEI" -> minutes }
let rotationCacheUpdatedAt = 0;
// Load persisted rotation cache
try {
  const _rcRow = _kvGet.get('rotation_cache');
  if (_rcRow) { Object.assign(modemRotationCache, JSON.parse(_rcRow.value)); logger.info(`[Rotation] Restored ${Object.keys(modemRotationCache).length} cached rotation values`); }
} catch (_) { /* best-effort: error intentionally swallowed */ }
const ROTATION_CACHE_TTL = () => (appSettings.rotation_cache_ttl_min || 30) * 60000;

async function refreshRotationCache() {
  for (const server of apiServers) {
    try {
      let statusData;
      try { statusData = await fetchApi(server, '/apix/show_status_json'); } catch (e) {
        logger.info(`[Rotation] ${server.name} status fetch failed: ${e.message}`);
        continue;
      }
      const modems = Array.isArray(statusData) ? statusData : [];
      if (modems.length === 0) { logger.info(`[Rotation] ${server.name}: 0 modems, skipping`); continue; }
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
      logger.info(`[Rotation] ${server.name}: fetched ${fetched}/${modems.length} modems`);
    } catch (e) { logger.info(`[Rotation] Failed for ${server.name}: ${e.message}`); }
  }
  rotationCacheUpdatedAt = Date.now();
  const total = Object.keys(modemRotationCache).length;
  logger.info(`[Rotation] Total cached: ${total} modem rotation values`);
  logActivity('rotation', 'info', 'cache_refreshed', null, `Rotation cache refreshed: ${total} modems`, { total });
  try { _kvSet.run('rotation_cache', JSON.stringify(modemRotationCache)); } catch (_) { /* best-effort: error intentionally swallowed */ }
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

// fetchServerData -> moved to src/api/proxy-smart.js
const fetchServerData = proxySmart.fetchServerData;

// Initialize proxySmart module now that all deps are available
proxySmart.init({
  http, https, logger, apiServers, safeWriteFile,
  SERVER_CACHE_FILE,
  updateKnownModems, injectOfflineModems, injectRotationData
});

// Refresh rotation cache on startup and periodically
setTimeout(() => refreshRotationCache(), 10000);
_intervals.push(setInterval(() => refreshRotationCache(), ROTATION_CACHE_TTL()));

const ROTATION_LOG_SYNC_INTERVAL = () => (appSettings.rotation_sync_interval_min || 30) * 60000;
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
      logger.info(`[RotLogSync] ${server.name} failed: ${e.message}`);
      logActivity('rotation', 'error', 'sync_error', server.name, `Rotation log sync failed: ${e.message}`);
    }
  }
  logger.info(`[RotLogSync] Synced ${totalSynced} rotation entries across all servers`);
  logActivity('rotation', 'info', 'sync_complete', null, `Synced ${totalSynced} rotation log entries`, { total: totalSynced });
}
// Initial sync after 30 sec, then every 30 min
setTimeout(() => syncAllRotationLogs().catch(e => logger.error('[RotLogSync]', e.message)), 30000);
_intervals.push(setInterval(() => syncAllRotationLogs().catch(e => logger.error('[RotLogSync]', e.message)), ROTATION_LOG_SYNC_INTERVAL()));

// fetchAllServersData, fetchAllServersDataCached, _psCache, _psCacheTs, _psFetchPromise, PS_CACHE_TTL
// -> moved to src/api/proxy-smart.js
const fetchAllServersData = proxySmart.fetchAllServersData;
const fetchAllServersDataCached = proxySmart.fetchAllServersDataCached;

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

// ProxySmart auto-generates fallback ports like "randomport3905" when a real
// port is deleted but the modem is still connected. The portName equals the
// portId and doesn't represent a real client. Normalize to empty so it doesn't
// pollute client lists / counts / billing.
function _isAutoRandomPort(name) {
  return typeof name === 'string' && /^randomport\d+$/i.test(name);
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
      const bwOverride = process.env[`PORTNAME_OVERRIDE_${data.serverName}`];
      const cleanName = _isAutoRandomPort(b.portName) ? '' : b.portName;
      mergedBw[prefix + portId] = { ...b, portName: cleanName, _server: data.serverName, _cached: isCached, ...(bwOverride ? { portName: bwOverride } : {}) };
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
      // Apply portName override for servers where ProxySmart doesn't support port renaming
      const portNameOverride = process.env[`PORTNAME_OVERRIDE_${data.serverName}`];
      const prefixedPorts = filteredPortList.map(p => ({
        ...p,
        portName: portNameOverride || (_isAutoRandomPort(p.portName) ? '' : p.portName),
        portID: p.portID ? prefix + p.portID : p.portID,
        _server: data.serverName,
        _cached: isCached
      }));
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

const MAX_IP_HISTORY = 100;

// Load IP tracking from SQLite
let ipTracking = {};
try {
  const rows = db.prepare('SELECT key, ip, updated_at FROM ip_tracking').all();
  for (const r of rows) ipTracking[r.key] = { ip: r.ip, since: r.updated_at };
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} IP tracking entries`);
} catch (e) { logger.error('Failed to load ip_tracking from SQLite:', e.message); }

// Auto-recovery: track offline modems for automatic USB reset
// { 'S1_IMEI': { offlineSince: timestamp, attempts: 0, lastAttempt: timestamp } }
const autoRecovery = {};

// Load uptime tracking from SQLite
let uptimeTracking = {};
try {
  const rows = db.prepare('SELECT key, data FROM uptime_tracking').all();
  for (const r of rows) { try { uptimeTracking[r.key] = JSON.parse(r.data); } catch (_) { /* best-effort: error intentionally swallowed */ } }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} uptime tracking entries`);
} catch (e) { logger.error('Failed to load uptime_tracking from SQLite:', e.message); }

// Load IP history from SQLite (with db_id for incremental updates)
let ipHistory = {};
try {
  const rows = db.prepare('SELECT id, key, ip, started_at, ended_at FROM ip_history ORDER BY id ASC').all();
  for (const r of rows) {
    if (!ipHistory[r.key]) ipHistory[r.key] = [];
    ipHistory[r.key].push({ db_id: r.id, ip: r.ip, from: r.started_at, to: r.ended_at || null });
  }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} IP history entries`);
} catch (e) { logger.error('Failed to load ip_history from SQLite:', e.message); }

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
  } catch (e) { logger.error('[saveIpTracking] SQLite error:', e.message); }
}

function saveUptimeTracking() {
  try {
    const batch = db.transaction(() => {
      for (const [key, data] of Object.entries(uptimeTracking)) {
        _utUpsert.run(key, JSON.stringify(data));
      }
    });
    batch();
  } catch (e) { logger.error('[saveUptimeTracking] SQLite error:', e.message); }
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
  } catch (e) { logger.error('[saveIpHistory] SQLite error:', e.message); }
}

// BUG-02: recordIpChange — direct incremental DB writes (no full rewrite)
function recordIpChange(key, oldIp, newIp, timestamp) {
  if (!ipHistory[key]) ipHistory[key] = [];
  const entries = ipHistory[key];
  const ts = typeof timestamp === 'number' ? new Date(timestamp).toISOString() : timestamp;
  // Close previous entry
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    if (!last.to) {
      last.to = ts;
      if (last.db_id) _ihUpdateEnd.run(ts, last.db_id);
    }
  }
  // Add new entry with direct INSERT
  const result = _ihInsert.run(key, newIp, ts, '');
  entries.push({ db_id: result.lastInsertRowid, ip: newIp, from: ts, to: null });
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
const _modemMetaUpsert = db.prepare(`INSERT OR REPLACE INTO modem_meta (server_name, imei, nick, operator, model, phone, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
const _metaOpGet = db.prepare('SELECT operator FROM modem_meta WHERE server_name = ? AND nick = ? LIMIT 1');

// Initialize hourly traffic module now that all dependencies are ready
hourlyTraffic.init({
  db,
  logger,
  fetchAllServersDataCached,
  refreshPortKeyMapping,
  getPortKeyToPortName: () => portKeyToPortName,
  _htUpsert,
  _htCleanup,
  _metaOpGet,
  _snapUpsert,
  _snapGet,
  _snapGetAll,
  SERVER_COUNTRIES,
});

// One-time cleanup: clear false positive uncertain flags from old 50MB threshold era
try {
  const cleaned = db.prepare(`UPDATE traffic_hourly SET uncertain = 0 WHERE uncertain > 0 AND (bytes_in + bytes_out) < ${150 * 1e6}`).run();
  if (cleaned.changes > 0) logger.info(`[HourlyAgg] Cleared ${cleaned.changes} false positive uncertain flags (old 50MB threshold)`);
} catch (e) { /* ignore */ }

async function trackModems() {
  const now = Date.now();
  let totalTracked = 0;
  const seenRecoveryKeys = new Set();

  for (const server of apiServers) {
    let statusArr;
    try {
      const data = await fetchServerData(server);
      statusArr = Array.isArray(data.status) ? data.status : [];
    } catch (e) {
      logger.info(`[Tracking] Server ${server.name} unreachable: ${e.message} — marking all modems as down`);
      logActivity('modem', 'warn', 'server_unreachable', server.name, `Server unreachable: ${e.message}`);
      // Server unreachable = all its modems are down
      const todayBucket = new Date().toLocaleDateString('en-CA');
      for (const k of Object.keys(uptimeTracking)) {
        if (k.startsWith(server.name + '_')) {
          seenRecoveryKeys.add(k); // preserve autoRecovery state for unreachable servers
          if (!uptimeTracking[k].daily) uptimeTracking[k].daily = {};
          if (!uptimeTracking[k].daily[todayBucket]) uptimeTracking[k].daily[todayBucket] = { online: 0, total: 0 };
          uptimeTracking[k].total_checks++;
          uptimeTracking[k].daily[todayBucket].total++;
          // don't increment online = downtime
        }
      }
      continue;
    }

    const prefix = server.name + '_';

    // Sync modem metadata to SQLite (nick, operator, model, phone — rarely changes)
    try {
      const metaBatch = db.transaction(() => {
        for (const m of statusArr) {
          const md = m.modem_details || {};
          const imei = md.IMEI;
          if (!imei) continue;
          const nd = m.net_details || {};
          const rawOp = (nd.CELLOP || md.OPERATOR || '').toLowerCase().trim();
          const isRO = server.name === 'S2' || server.name.indexOf('S2') === 0;
          const normOp = normalizeOperator(rawOp, isRO) || nd.CELLOP || md.OPERATOR || '';
          _modemMetaUpsert.run(server.name, imei, md.NICK || '', normOp, md.MODEL || '', md.PHONE_NUMBER || '');
        }
      });
      metaBatch();
    } catch (e) { /* non-critical */ }

    for (const m of statusArr) {
      const imei = m.modem_details?.IMEI;
      if (!imei) continue;
      const key = prefix + imei;
      const nick = m.modem_details?.NICK || imei;  // hoisted from below to fix TDZ in IP-change log
      const extIp = m.net_details?.EXT_IP || '';
      const isOnline = m.net_details?.IS_ONLINE === 'yes';
      const isRotating = m.IS_ROTATED === 'true' || m.IS_ROTATED === true;
      const isRebooting = m.IS_REBOOTING === 'true' || m.IS_REBOOTING === true;

      // IP tracking (always, regardless of status)
      if (extIp && extIp !== 'IP_RESET') {
        if (!ipTracking[key]) {
          ipTracking[key] = { ip: extIp, since: new Date(now).toISOString() };
          // Record initial IP in history
          recordIpChange(key, null, extIp, now);
        } else if (ipTracking[key].ip !== extIp) {
          // IP changed! Record in history with timestamp
          recordIpChange(key, ipTracking[key].ip, extIp, now);
          logActivity('modem', 'info', 'ip_changed', nick, `IP changed: ${ipTracking[key].ip} → ${extIp}`, { server: server.name, old_ip: ipTracking[key].ip, new_ip: extIp });
          ipTracking[key] = { ip: extIp, since: new Date(now).toISOString() };
        }
        // else same IP -- keep existing `since`
      }

      // Uptime tracking
      // Rotating/rebooting = online (normal operation, not downtime)
      // Offline = immediately count as downtime (no threshold)
      if (!uptimeTracking[key]) {
        uptimeTracking[key] = { total_checks: 0, online_checks: 0, first_check: now, daily: {} };
      }
      if (!uptimeTracking[key].daily) uptimeTracking[key].daily = {};

      const todayBucket = new Date().toLocaleDateString('en-CA');
      if (!uptimeTracking[key].daily[todayBucket]) uptimeTracking[key].daily[todayBucket] = { online: 0, total: 0 };

      const isUp = isOnline || isRotating || isRebooting || extIp === 'IP_RESET';
      uptimeTracking[key].total_checks++;
      uptimeTracking[key].daily[todayBucket].total++;
      if (isUp) {
        uptimeTracking[key].online_checks++;
        uptimeTracking[key].daily[todayBucket].online++;
      }

      // Prune daily buckets older than 35 days
      const cutoffPrune = new Date(now - 35 * 86400000).toLocaleDateString('en-CA');
      for (const d of Object.keys(uptimeTracking[key].daily)) {
        if (d < cutoffPrune) delete uptimeTracking[key].daily[d];
      }

      // Auto-recovery: USB reset for offline modems
      const recoveryKey = key; // prefix + imei
      seenRecoveryKeys.add(recoveryKey);
      // `nick` already declared at top of loop body (hoisted)
      if (isUp) {
        if (autoRecovery[recoveryKey]) {
          if (autoRecovery[recoveryKey].attempts > 0) {
            logger.info(`[AutoRecovery] ${nick} back online after ${autoRecovery[recoveryKey].attempts} reset(s)`);
            logActivity('recovery', 'info', 'modem_recovered', nick, `Back online after ${autoRecovery[recoveryKey].attempts} USB reset(s)`, { server: server.name, attempts: autoRecovery[recoveryKey].attempts });
          }
          delete autoRecovery[recoveryKey];
        }
      } else {
        if (!autoRecovery[recoveryKey]) {
          autoRecovery[recoveryKey] = { offlineSince: now, attempts: 0, lastAttempt: 0 };
        }
        const rec = autoRecovery[recoveryKey];
        const offlineSec = (now - rec.offlineSince) / 1000;
        const _recOffSec = appSettings.recovery_offline_sec || 60;
        const _recMaxAtt = appSettings.recovery_max_attempts || 3;
        const _recRetryMs = (appSettings.recovery_retry_min || 3) * 60000;
        if (offlineSec >= _recOffSec && rec.attempts < _recMaxAtt && (now - rec.lastAttempt) >= _recRetryMs) {
          rec.attempts++;
          rec.lastAttempt = now;
          logger.warn(`[AutoRecovery] USB reset #${rec.attempts}/${_recMaxAtt} for ${nick} (${server.name}), offline ${Math.round(offlineSec)}s`);
          logActivity('recovery', 'warn', 'usb_reset', nick, `USB reset #${rec.attempts}/${_recMaxAtt} (offline ${Math.round(offlineSec)}s)`, { server: server.name, attempt: rec.attempts, offline_sec: Math.round(offlineSec) });
          fetchApi(server, `/apix/usb_reset_modem_json?arg=${encodeURIComponent(nick)}`)
            .catch(e => {
              logger.error(`[AutoRecovery] USB reset failed for ${nick}: ${e.message}`);
              logActivity('recovery', 'error', 'usb_reset_failed', nick, `USB reset failed: ${e.message}`, { server: server.name });
            });
          if (rec.attempts >= _recMaxAtt) {
            logger.warn(`[AutoRecovery] ${nick} exhausted ${_recMaxAtt} attempts, giving up`);
            logActivity('recovery', 'warn', 'recovery_exhausted', nick, `Exhausted ${_recMaxAtt} USB reset attempts, giving up`, { server: server.name });
          }
        }
      }

      totalTracked++;
    }
  }

  // Prune stale modem keys from uptimeTracking (modems removed or not seen in 7+ days)
  const MAX_UPTIME_KEYS = 500;
  const uptimeKeys = Object.keys(uptimeTracking);
  if (uptimeKeys.length > MAX_UPTIME_KEYS) {
    const now7d = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA');
    for (const k of uptimeKeys) {
      const days = Object.keys(uptimeTracking[k].daily || {});
      const latest = days.length ? days.sort().pop() : '';
      if (latest < now7d) { delete uptimeTracking[k]; }
    }
  }

  // Prune autoRecovery keys for modems no longer in the system
  for (const rk of Object.keys(autoRecovery)) {
    if (!seenRecoveryKeys.has(rk)) delete autoRecovery[rk];
  }

  saveIpTracking();
  saveUptimeTracking();
  // BUG-02: saveIpHistory() removed — recordIpChange() now does direct DB writes
  logger.info(`[Tracking] Updated IP & uptime for ${Object.keys(ipTracking).length} modems (${totalTracked} uptime checks)`);
  logActivity('modem', 'info', 'tracking_complete', null, `Tracked ${totalTracked} modems across ${apiServers.length} servers`, { modem_count: totalTracked, ip_count: Object.keys(ipTracking).length });
}

// ========== PROXY LATENCY MONITORING ==========
let _proxyCheckInterval = null;
function rescheduleProxyCheck() {
  if (_proxyCheckInterval) clearInterval(_proxyCheckInterval);
  const min = appSettings.proxy_check_interval_min || 60;
  _proxyCheckInterval = setInterval(() => {
    checkProxyLatency().catch(e => logger.error('[ProxyCheck] Error:', e.message));
  }, min * 60 * 1000);
  logger.info(`[ProxyCheck] Rescheduled: every ${min} min`);
}
function getProxyCheckTimeout() { return appSettings.proxy_check_timeout_sec || 15; }
function getProxyCheckConcurrency() { return appSettings.proxy_check_concurrency || 10; }

function curlCheckProxy(proxyUrl, targetUrl) {
  const target = targetUrl || appSettings.proxy_check_target || 'https://www.instagram.com/';
  return new Promise((resolve) => {
    const args = [
      '-x', proxyUrl,
      '-w', '%{time_connect}|||%{time_total}|||%{http_code}',
      '-o', '/dev/null', '-s',
      '--max-time', String(getProxyCheckTimeout()),
      '-L', // follow redirects
      target
    ];
    execFile('curl', args, { timeout: (getProxyCheckTimeout() + 5) * 1000 }, (err, stdout) => {
      if (err) {
        const isTimeout = err.killed || (err.message && err.message.includes('timed out'));
        resolve({ connect_ms: null, total_ms: null, status_code: null, error: isTimeout ? 'TIMEOUT' : err.message.slice(0, 200) });
        return;
      }
      const parts = stdout.trim().split('|||');
      if (parts.length === 3) {
        const connectRaw = parseFloat(parts[0]);
        const totalRaw = parseFloat(parts[1]);
        const statusRaw = parseInt(parts[2]);
        const connectMs = isNaN(connectRaw) ? null : Math.round(connectRaw * 1000);
        const totalMs = isNaN(totalRaw) ? null : Math.round(totalRaw * 1000);
        const statusCode = isNaN(statusRaw) ? null : statusRaw;
        const error = (statusCode && statusCode >= 400) ? `HTTP ${statusCode}` : null;
        resolve({ connect_ms: connectMs, total_ms: totalMs, status_code: statusCode, error });
      } else {
        resolve({ connect_ms: null, total_ms: null, status_code: null, error: 'Parse error' });
      }
    });
  });
}

async function checkProxyLatency() {
  try {
    const results = await fetchAllServersDataCached();
    const nowIso = new Date().toISOString();

    // Build list of proxies to check
    const proxies = [];
    for (const data of results) {
      const srv = data.serverName || '';
      const sc = SERVER_COUNTRIES[srv] || {};
      const serverIp = sc.serverIp || '';
      if (!serverIp) continue;
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const portsMap = data.ports || {};

      // Map IMEI → modem info
      const modemInfo = {};
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        if (!imei) continue;
        modemInfo[imei] = {
          nick: md.NICK || imei,
          isOnline: m.net_details?.IS_ONLINE === 'yes',
          isRotating: m.IS_ROTATED === 'true' || m.IS_ROTATED === true,
          operator: normalizeOperator(m.net_details?.CELLOP, srv === 'S2' || srv.startsWith('S2')),
        };
      }

      for (const [imei, portList] of Object.entries(portsMap)) {
        const info = modemInfo[imei];
        if (!info) continue;
        // Skip offline modems (not rotating)
        if (!info.isOnline && !info.isRotating) continue;
        for (const p of portList) {
          if (!p.HTTP_PORT || !p.LOGIN || !p.PASSWORD) continue;
          // Skip unassigned proxies (no client renting this port).
          // ProxySmart blocks traffic on unbound ports → would always error
          // and inflate error_rate, falsely flagging modems as flaky.
          if (!p.portName || !p.portName.trim()) continue;
          proxies.push({
            server: srv,
            nick: info.nick,
            client: p.portName,
            operator: info.operator || '',
            proxyUrl: `http://${p.LOGIN}:${p.PASSWORD}@${serverIp}:${p.HTTP_PORT}`,
          });
          break; // one check per modem is enough
        }
      }
    }

    // Run checks with concurrency limit
    let ok = 0, errors = 0;
    const batch = db.transaction((entries) => {
      for (const e of entries) {
        dbStmts.proxyCheckInsert.run(e.server, e.nick, e.client, e.operator || '', nowIso, e.connect_ms, e.total_ms, e.status_code, e.error);
      }
    });

    const entries = [];
    for (let i = 0; i < proxies.length; i += getProxyCheckConcurrency()) {
      const chunk = proxies.slice(i, i + getProxyCheckConcurrency());
      const results = await Promise.all(chunk.map(async (p) => {
        const r = await curlCheckProxy(p.proxyUrl);
        return { server: p.server, nick: p.nick, client: p.client, operator: p.operator, ...r };
      }));
      for (const r of results) {
        entries.push(r);
        if (r.error) errors++;
        else ok++;
      }
    }

    batch(entries);
    logger.info(`[ProxyCheck] Checked ${entries.length} proxies: ${ok} ok, ${errors} errors`);
    logActivity('proxy_check', errors > 0 ? 'warn' : 'info', 'check_complete', null, `Checked ${entries.length} proxies: ${ok} ok, ${errors} errors`, { total: entries.length, ok, errors });
  } catch (e) {
    logger.error('[ProxyCheck] Error:', e.message);
    logActivity('proxy_check', 'error', 'check_error', null, `Proxy latency check failed: ${e.message}`);
  }
}

const SPEEDTEST_HISTORY_FILE = path.join(__dirname, 'speedtest_history.json');
function getMaxSpeedtestEntries() { return appSettings.speedtest_max_history || 30; }

let speedtestHistory = {};
try {
  if (fs.existsSync(SPEEDTEST_HISTORY_FILE)) {
    speedtestHistory = JSON.parse(fs.readFileSync(SPEEDTEST_HISTORY_FILE, 'utf8'));
  }
} catch (e) { logger.error('Failed to load speedtest_history:', e.message); }

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
  if (speedtestHistory[key].length > getMaxSpeedtestEntries()) {
    speedtestHistory[key] = speedtestHistory[key].slice(-getMaxSpeedtestEntries());
  }
  saveSpeedtestHistory();
}

async function runNightlySpeedtests() {
  if (speedtestRunning) {
    logger.info('[Speedtest] Already running, skipping...');
    return;
  }
  speedtestRunning = true;
  logger.info('[Speedtest] Starting speedtest run...');
  let testedCount = 0, errorCount = 0;

  try {
    for (const server of apiServers) {
      try {
        const statusData = await fetchApi(server, '/apix/show_status_json');
        const modems = Array.isArray(statusData) ? statusData : [];
        logger.info(`[Speedtest] ${server.name}: ${modems.length} modems to test`);

        for (const m of modems) {
          const nick = m.modem_details?.NICK;
          const imei = m.modem_details?.IMEI;
          const isOnline = m.net_details?.IS_ONLINE === 'yes';
          if (!nick || !imei || !isOnline) continue;

          const key = server.name + '_' + imei;
          try {
            logger.info(`[Speedtest] Testing ${nick} (${server.name})...`);
            const result = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
            const { dl, ul, ping } = parseSpeedtestResult(result);

            const entry = { date: new Date().toISOString(), download: dl, upload: ul, ping, raw: result };

            // Re-test if DL or UL is below threshold
            const _stLowThresh = appSettings.speedtest_low_threshold || 1;
            const _stRetestMs = (appSettings.speedtest_retest_delay_min || 10) * 60000;
            if (dl < _stLowThresh || ul < _stLowThresh) {
              logger.info(`[Speedtest] ${nick}: DL=${dl} UL=${ul} — below ${_stLowThresh} Mbps, re-testing in ${appSettings.speedtest_retest_delay_min || 10} min...`);
              setTimeout(async () => {
                try {
                  logger.info(`[Speedtest] Re-testing ${nick} (${server.name})...`);
                  const retryResult = await fetchApi(server, `/apix/speedtest?arg=${encodeURIComponent(nick)}`, 180000);
                  const r = parseSpeedtestResult(retryResult);
                  if (r.dl + r.ul > dl + ul) {
                    pushSpeedtestEntry(key, { date: new Date().toISOString(), download: r.dl, upload: r.ul, ping: r.ping, raw: retryResult, retry: true, ...(r.dl < _stLowThresh || r.ul < _stLowThresh ? { _lowSpeed: true } : {}) });
                    logger.info(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (improved)`);
                  } else {
                    logger.info(`[Speedtest] Re-test ${nick}: DL=${r.dl} UL=${r.ul} (not improved)`);
                  }
                } catch (e) { logger.error(`[Speedtest] Re-test ${nick} error:`, e.message); }
              }, _stRetestMs);
            }

            pushSpeedtestEntry(key, entry);
            testedCount++;
            logger.info(`[Speedtest] ${nick}: DL=${dl} UL=${ul} Ping=${ping}`);
            if (dl < _stLowThresh || ul < _stLowThresh) {
              logActivity('speedtest', 'warn', 'low_speed', nick, `Low speed: DL=${dl} UL=${ul} Ping=${ping}`, { server: server.name, dl, ul, ping });
            } else {
              logActivity('speedtest', 'info', 'test_result', nick, `DL=${dl} UL=${ul} Ping=${ping}`, { server: server.name, dl, ul, ping });
            }
          } catch (e) {
            logger.error(`[Speedtest] Error testing ${nick}:`, e.message);
            logActivity('speedtest', 'error', 'test_error', nick, `Speedtest failed: ${e.message}`, { server: server.name });
            errorCount++;
          }

          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        logger.error(`[Speedtest] Error on server ${server.name}:`, e.message);
        errorCount++;
      }
    }
  } finally {
    speedtestRunning = false;
  }

  logger.info(`[Speedtest] Complete: ${testedCount} tested, ${errorCount} errors`);
  logActivity('speedtest', errorCount > 0 ? 'warn' : 'info', 'run_complete', null, `Speedtest complete: ${testedCount} tested, ${errorCount} errors`, { tested: testedCount, errors: errorCount });
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

app.get('/api/dashboard_data', dashboardLimiter, authMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, req.user.portNameFilter);
    const clientInfo = clientByLogin.get(req.user.login);
    if (clientInfo) {
      const totalPayments = (clientInfo.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Current month expense from billing ledger
      const ledgerEntries = billingLedger[clientInfo.id] || [];
      const currentMonthPrefix = getMoscowToday().slice(0, 7);
      const monthExpense = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + ledgerExpense(e), 0);

      // Live month traffic from ProxySmart
      let liveMonthBytes = 0;
      for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_in);
        liveMonthBytes += parseBwToBytes(bwData.bandwidth_bytes_month_out);
      }
      const liveMonthGb = trafficBytesToGb(liveMonthBytes);

      // Billed month GB from ledger (for comparison)
      const billedMonthGb = ledgerEntries
        .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
        .reduce((sum, e) => sum + (e.delta_gb || 0), 0);

      // Last hour traffic from traffic_hourly for this client's portName —
      // single bulk query with scalar subquery to compute max hour once.
      let lastHourGb = 0;
      if (clientInfo.portName) {
        const lhRow = db.prepare(`
          SELECT SUM(bytes_in + bytes_out) as total
          FROM traffic_hourly
          WHERE client_name = ?
            AND hour_start = (SELECT MAX(hour_start) FROM traffic_hourly WHERE client_name = ?)
        `).get(clientInfo.portName, clientInfo.portName);
        if (lhRow && lhRow.total) lastHourGb = trafficBytesToGb(lhRow.total);
      }

      merged.billing = {
        billingType: clientInfo.billingType || 'per_gb',
        price: clientInfo.price || 0,
        currency: clientInfo.currency || 'RUB',
        totalPayments,
        balance: clientInfo.balance !== undefined ? clientInfo.balance : totalPayments,
        monthExpense: Math.round(monthExpense * 100) / 100,
        liveMonthGb,
        billedMonthGb: Math.round(billedMonthGb * 1000) / 1000,
        lastHourGb,
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

    // Include server info for client portal (needed for IP addresses)
    merged.servers = apiServers.map(s => ({
      name: s.name, publicIp: s.publicIp,
      country: (SERVER_COUNTRIES[s.name] || {}).country || '',
      countryName: (SERVER_COUNTRIES[s.name] || {}).name || s.name
    }));

    res.json(merged);
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

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
  const totalCharges = allEntries.filter(e => e.type === 'charge' || e.type === 'correction').reduce((sum, e) => sum + ledgerExpense(e), 0);
  const totalPayments = allEntries.filter(e => e.type === 'payment').reduce((sum, e) => sum + (e.amount || 0), 0);

  // Current month summary
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const monthCharges = allEntries
    .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(currentMonthPrefix))
    .reduce((sum, e) => sum + ledgerExpense(e), 0);

  // Average daily charge over last 7 days: sum charges for days [today-7 .. today-1] / 7
  const today = getMoscowToday(); // "YYYY-MM-DD"
  const d7 = getMoscowNow();
  d7.setDate(d7.getDate() - 7);
  const sevenDaysAgoStr = d7.toLocaleDateString('en-CA'); // exclusive lower bound
  const last7dTotal = allEntries
    .filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date > sevenDaysAgoStr && e.date < today)
    .reduce((sum, e) => sum + ledgerExpense(e), 0);
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
    
    entries: filtered.map(({ db_id, ...e }) => e)
  });
});

app.post('/api/client/reset_ip', authMiddleware, async (req, res) => {
  try {
    const { imei, serverName } = req.body;
    if (!imei || !serverName) return res.status(400).json({ error: 'imei and serverName required' });
    // Verify client owns this modem
    const pnf = req.user.portNameFilter;
    if (pnf !== '*') {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, pnf);
      if (!merged.ports[imei]) return res.status(403).json({ error: 'Modem not assigned to this client' });
    }
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

// Accept BOTH POST (correct semantic for state-changing op) and GET
// (backwards-compat for existing client integrations & emailed URLs).
// New integrations should use POST.
const _resetIpHandler = async (req, res) => {
  const nick = (req.body && req.body.nick) || req.query.nick;
  const token = (req.body && req.body.token) || req.query.token;
  req.query.nick = nick; req.query.token = token; // for downstream code
  return _resetIpImpl(req, res);
};
app.post('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);
app.get('/api/client/reset_ip_by_token', resetTokenLimiter, _resetIpHandler);
async function _resetIpImpl(req, res) {
  const { nick, token } = req.query;
  if (!nick || !token) return res.status(400).json({ error: 'nick and token required' });
  const client = clientByResetToken.get(token);
  if (!client) return res.status(401).json({ error: 'Invalid token' });
  // Verify nick belongs to this client's portName
  const allowed = db.prepare("SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1").get(nick, client.portName);
  if (!allowed) return res.status(403).json({ error: 'Modem not assigned to this client' });
  // Try all servers
  for (const server of apiServers) {
    try {
      const result = await fetchApi(server, `/apix/reset_modem?arg=${encodeURIComponent(nick)}`);
      if (result) return res.json({ ok: true, result });
    } catch (e) { /* try next server */ }
  }
  res.status(404).json({ error: 'Modem not found' });
}

app.get('/api/client/rotation_log', authMiddleware, async (req, res) => {
  try {
    const { nick, serverName } = req.query;
    if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
    // Verify client owns this modem
    const pnf = req.user.portNameFilter;
    if (pnf !== '*') {
      const allowed = db.prepare("SELECT 1 FROM traffic_hourly WHERE nick = ? AND client_name = ? LIMIT 1").get(nick, pnf);
      if (!allowed) return res.status(403).json({ error: 'Modem not assigned to this client' });
    }
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
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, '*');
      if (!merged) return res.status(503).json({ error: 'Data not loaded yet' });
      const allPorts = merged.ports || {};
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

    logger.info(`[Rotation] Client ${req.user.login} set ${nick} rotation to ${mins} min`);
    auditLog(req.user.login, 'client_set_rotation', { nick, serverName, minutes: mins, ip: getClientIp(req) });
    res.json({ ok: true, minutes: mins });
  } catch (err) { res.status(502).json({ error: 'Failed to set rotation', details: err.message }); }
});

app.get('/api/client/ip_history', authMiddleware, async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  // Verify client owns this modem (key is IMEI)
  const pnf = req.user.portNameFilter;
  if (pnf !== '*') {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, pnf);
    if (!merged.ports[key]) return res.status(403).json({ error: 'Modem not assigned to this client' });
  }
  res.json(ipHistory[key] || []);
});

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

// Phase 2: log every /api/v1/* request with response time and status.
// Applied after the CORS handler so OPTIONS preflight doesn't spam the log.
// Accept API key from X-API-Key header (preferred) or query string (deprecated).
// Query-string keys leak into nginx logs, proxy caches, and browser history;
// we keep the fallback for now but stamp a Deprecation header so integrations
// can migrate. Plan: drop query-string after a few months.
function _readApiKey(req, res) {
  const fromHeader = req.headers['x-api-key'];
  if (fromHeader) return String(fromHeader);
  const fromQuery = req.query && (req.query.apikey || req.query.apiKey);
  if (fromQuery) {
    res.set('Deprecation', 'true');
    res.set('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
    res.set('Warning', '299 - "apikey query param is deprecated; use X-API-Key header"');
    return String(fromQuery);
  }
  return '';
}

app.use('/api/v1', apiV1Limiter, (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const start = Date.now();
  const apiKey = _readApiKey(req, res);
  res.on('finish', () => {
    try {
      const client = apiKey ? clientByApiKey.get(apiKey) : null;
      // Only log requests that presented an API key. Anonymous 401s are noise.
      if (!client) return;
      const errMsg = (res.statusCode >= 400 && res.locals && res.locals.apiError) || null;
      _apiUsageInsert.run(
        client.id || null,
        client.name || null,
        String(apiKey).slice(0, 8),
        req.path || req.originalUrl || '',
        req.method,
        res.statusCode,
        Date.now() - start,
        (req.headers['user-agent'] || '').slice(0, 300),
        getClientIp(req) || '',
        errMsg
      );
    } catch (_e) { /* never break the request on logging failure */ }
  });
  next();
});

// /api/v1/proxy + /api/v1/proxies moved into src/routes/public-api.js (Stage 3).
app.use(require('./src/routes/public-api')({
  _readApiKey,
  fetchAllServersDataCached, mergeServerData,
  extractServerName, SERVER_COUNTRIES,
  parseBwToBytes, trafficBytesToGb,
  getClientByApiKey: (k) => clientByApiKey.get(k),
  getClientByLogin: (l) => clientByLogin.get(l),
}));

app.post('/api/admin/cache/invalidate', authMiddleware, adminMiddleware, (req, res) => {
  proxySmart.invalidateCache();
  logger.info('[Cache] ProxySmart cache invalidated by admin');
  res.json({ ok: true, message: 'Cache invalidated' });
});

app.get('/api/admin/daily_traffic', authMiddleware, adminMiddleware, async (req, res) => {
  // Return daily traffic aggregated by client (portName) for each day
  const results = await fetchAllServersDataCached();
  // Build fresh portId -> portName and portId -> serverName mappings from live data
  const pnMap = {};
  const portIdToServer = {};
  for (const data of results) {
    const srvName = data.serverName || '';
    if (typeof data.bw !== 'object') continue;
    for (const [portId, b] of Object.entries(data.bw)) {
      const fullKey = srvName + '_' + portId;
      portIdToServer[portId] = srvName;
      portIdToServer[fullKey] = srvName;
      if (b.portName) { pnMap[fullKey] = b.portName; pnMap[portId] = b.portName; }
    }
  }
  const byClient = {};
  // Historical days from dailyTraffic
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    const pn = pnMap[portId] || 'Не назначен';
    const srv = portIdToServer[portId] || (portId.match(/^(S\d+)_/) ? portId.match(/^(S\d+)_/)[1] : '');
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
  // Use Moscow time (GMT+3) for "today" since most servers are in Moldova/Romania (GMT+3/+3)
  const _nowLocal = new Date(Date.now() + 3 * 3600000);
  const todayStr = _nowLocal.toISOString().slice(0, 10);
  // For PAST days: override byClient with traffic_hourly aggregation.
  // traffic_hourly is updated every hour from counter deltas and uses UTC timestamps,
  // so we MSK-shift here to attribute traffic to the right calendar day.
  // This avoids the midnight "drop to zero" that happens when ProxySmart's
  // bandwidth_bytes_yesterday_* counter shifts later than MSK midnight (e.g., MD/RO winter TZ).
  try {
    const hourlyRows = db.prepare(`
      SELECT client_name as pn, server_name as srv,
             strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) as date,
             SUM(bytes_in) as bin, SUM(bytes_out) as bout
      FROM traffic_hourly
      WHERE hour_start >= datetime('now', '-31 days') AND client_name != ''
      GROUP BY pn, srv, date
    `).all();
    for (const r of hourlyRows) {
      if (r.date === todayStr) continue; // today comes from live counter below
      if (!byClient[r.pn]) byClient[r.pn] = {};
      // Authoritative override: traffic_hourly is the source of truth for past days
      if (!byClient[r.pn][r.date]) byClient[r.pn][r.date] = { in: 0, out: 0, servers: {} };
      // First time we see this (pn,date) combo: reset before summing servers
      if (byClient[r.pn][r.date]._th_seen !== true) {
        byClient[r.pn][r.date] = { in: 0, out: 0, servers: {}, _th_seen: true };
      }
      byClient[r.pn][r.date].in += r.bin;
      byClient[r.pn][r.date].out += r.bout;
      if (r.srv) {
        if (!byClient[r.pn][r.date].servers[r.srv]) byClient[r.pn][r.date].servers[r.srv] = { in: 0, out: 0 };
        byClient[r.pn][r.date].servers[r.srv].in = (byClient[r.pn][r.date].servers[r.srv].in || 0) + r.bin;
        byClient[r.pn][r.date].servers[r.srv].out = (byClient[r.pn][r.date].servers[r.srv].out || 0) + r.bout;
      }
    }
    // Strip helper flag before sending response
    for (const pn in byClient) for (const dt in byClient[pn]) delete byClient[pn][dt]._th_seen;
  } catch (e) {
    logger.warn('[daily_traffic] traffic_hourly override failed: ' + e.message);
  }
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
  // If detail=modems, also return per-modem (per-nick) breakdown
  if (req.query.detail === 'modems') {
    const byModem = {};
    // Build portId → nick mapping from known modems + status
    // Build portId→nick from known_modems.json (reliable) + live status (fresh)
    const portIdToNick = {};
    const portIdToClientName = {};
    const portIdToOperator = {};
    // known_modems.json: { "S1": { "portXXX": { nick, portName } }, "S2": { ... } }
    for (const srv in knownModems) {
      for (const portId in knownModems[srv]) {
        const info = knownModems[srv][portId];
        if (info.nick) portIdToNick[srv + '_' + portId] = info.nick;
        if (info.portName) portIdToClientName[srv + '_' + portId] = info.portName;
      }
    }
    // Override with live status (may have newer nicks) + capture operator
    for (const data of results) {
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const portsMap = data.ports || {};
      const srvName = data.serverName || '';
      const srvCountry = (SERVER_COUNTRIES[srvName] || {}).country || '';
      const isRO = srvCountry === 'RO';
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        const nick = md.NICK || imei;
        if (!imei) continue;
        const rawOp = (m.net_details && m.net_details.CELLOP) || md.OPERATOR || '';
        const op = normalizeOperator(rawOp.toLowerCase().trim(), isRO);
        const modemPorts = portsMap[imei] || [];
        for (const p of modemPorts) {
          // dailyTraffic keys are server-prefixed ("S2_portXXX"); raw data.ports
          // entries have bare portIDs. Write BOTH so dailyTraffic loop below
          // resolves no matter which form it iterates over.
          const bareId = p.portID;
          const prefId = srvName + '_' + bareId;
          portIdToNick[bareId] = nick;
          portIdToNick[prefId] = nick;
          if (op) {
            portIdToOperator[bareId] = op;
            portIdToOperator[prefId] = op;
          }
          if (p.portName) {
            portIdToClientName[bareId] = p.portName;
            portIdToClientName[prefId] = p.portName;
          }
        }
      }
    }
    // Historical from dailyTraffic — group by nick+portName (one modem can serve multiple clients)
    for (const [portId, days] of Object.entries(dailyTraffic)) {
      const nick = portIdToNick[portId] || portId.replace(/^S\d+_port/, '');
      const pn = portIdToClientName[portId] || (Object.values(days)[0] && Object.values(days)[0].portName) || pnMap[portId] || '';
      const srv = portIdToServer[portId] || '';
      const op = portIdToOperator[portId] || '';
      const modemKey = nick + (pn ? ':' + pn : '');
      if (!byModem[modemKey]) byModem[modemKey] = { portName: pn, server: srv, nick: nick, operator: op, days: {} };
      else if (!byModem[modemKey].operator && op) byModem[modemKey].operator = op;
      for (const [date, entry] of Object.entries(days)) {
        if (!byModem[modemKey].days[date]) byModem[modemKey].days[date] = 0;
        byModem[modemKey].days[date] += (entry.in || 0) + (entry.out || 0);
      }
    }
    // Today's live (bw keys already prefixed in merged data: S1_portXXX)
    const _nowLocal2 = new Date(Date.now() + 3 * 3600000);
    const todayStr2 = _nowLocal2.toISOString().slice(0, 10);
    for (const data of results) {
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const nick = portIdToNick[portId] || portId;
        const pn2 = b.portName || portIdToClientName[portId] || '';
        const modemKey2 = nick + (pn2 ? ':' + pn2 : '');
        const dayIn = parseBwToBytes(b.bandwidth_bytes_day_in);
        const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
        if (dayIn + dayOut > 0) {
          if (!byModem[modemKey2]) byModem[modemKey2] = { portName: pn2, server: data.serverName, nick: nick, operator: portIdToOperator[portId] || '', days: {} };
          if (!byModem[modemKey2].days[todayStr2]) byModem[modemKey2].days[todayStr2] = 0;
          byModem[modemKey2].days[todayStr2] += dayIn + dayOut;
        }
      }
    }
    return res.json({ clients: byClient, modems: byModem });
  }
  res.json(byClient);
});

// Auto-reboot history — last N reboots triggered by the flaky-modem watcher
app.get('/api/admin/auto_reboot_log', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const rows = db.prepare(`
      SELECT id, server_name, nick, imei, rebooted_at, reason, status, error
        FROM auto_reboot_log
       WHERE rebooted_at >= datetime('now', '-${days} days')
       ORDER BY id DESC
       LIMIT ?
    `).all(limit);
    res.json({ count: rows.length, days, rows });
  } catch (e) {
    logger.error('[auto_reboot_log]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DB-level audit explorer — every INSERT/UPDATE/DELETE on financial tables
// captured by SQL triggers, with per-write context (who/why/when).
//
// Query params:
//   table      — billing_ledger | bank_payments | clients.balance | payments | closing_documents | bills | clients
//   operation  — INSERT | UPDATE | DELETE
//   row_id     — exact row id (e.g. ledger row id, client_id)
//   actor      — admin login or 'system'
//   source     — http | scheduler | webhook | manual | unknown_http | startup
//   since/until — ISO timestamp filters
//   limit      — max rows (default 200, max 5000)
app.get('/api/admin/db_audit', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { table, operation, row_id, actor, source, since, until } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 5000);
    let rows;
    if (row_id && table) {
      rows = dbAudit.getRowHistory(table, row_id, limit);
    } else {
      rows = dbAudit.search({ table, operation, actor, source, since, until, limit });
    }
    res.json({ count: rows.length, rows });
  } catch (e) {
    logger.error('[db_audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Phase 2: API usage stats + recent log for a given client.
// Query params: client_id (required), days (1-30, default 7), limit (1-500, default 100).
app.get('/api/admin/api_usage', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const clientId = String(req.query.client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);

    const sinceExpr = `datetime('now', '-${days} days')`;

    // Aggregate
    const totals = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms,
             MIN(timestamp) as first_ts,
             MAX(timestamp) as last_ts
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
    `).get(clientId);

    // Per-day buckets (for chart)
    const perDay = db.prepare(`
      SELECT substr(timestamp, 1, 10) as date,
             COUNT(*) as count,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
      GROUP BY date
      ORDER BY date
    `).all(clientId);

    // Per-endpoint breakdown
    const perEndpoint = db.prepare(`
      SELECT endpoint, method,
             COUNT(*) as count,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
      GROUP BY endpoint, method
      ORDER BY count DESC
    `).all(clientId);

    // Latest requests
    const recent = db.prepare(`
      SELECT endpoint, method, status_code, response_time_ms, user_agent, ip, timestamp, error
      FROM api_usage
      WHERE client_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(clientId, limit);

    // Active flag: any request in last 24h
    const recent24h = db.prepare(`
      SELECT COUNT(*) as c FROM api_usage
      WHERE client_id = ? AND timestamp >= datetime('now', '-1 day')
    `).get(clientId).c;

    const total = totals.total || 0;
    const errors = totals.errors || 0;
    res.json({
      client_id: clientId,
      days,
      active_24h: recent24h > 0,
      requests_24h: recent24h,
      summary: {
        total,
        errors,
        error_rate_pct: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
        avg_response_ms: totals.avg_ms ? Math.round(totals.avg_ms) : null,
        first_request: totals.first_ts,
        last_request: totals.last_ts,
      },
      per_day: perDay,
      per_endpoint: perEndpoint,
      recent,
    });
  } catch (e) {
    logger.error('[api_usage]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Backfill daily_traffic for a given MSK date by summing traffic_hourly rows.
// Use when bandwidth_bytes_yesterday_* came back as 0 from ProxySmart
// (e.g. after a ProxySmart restart around midnight) and the daily chart
// shows a hole. traffic_hourly is written independently by hourly.js and
// survives these cases. Safe to run multiple times — UPSERT uses MAX.
app.post('/api/admin/backfill_daily_traffic', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const date = String(req.body?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required in YYYY-MM-DD (MSK)' });
    }
    // Reject future / today (today is still live)
    const todayMsk = getMoscowToday();
    if (date >= todayMsk) {
      return res.status(400).json({ error: 'date must be in the past (today is live via bandwidth_bytes_day_*)' });
    }
    // Aggregate per port_id for the given MSK day
    const rows = db.prepare(`
      SELECT port_id, client_name,
             SUM(bytes_in)  AS bytes_in,
             SUM(bytes_out) AS bytes_out,
             COUNT(*)       AS hours
      FROM traffic_hourly
      WHERE substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
      GROUP BY port_id
    `).all(date);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'no traffic_hourly data for that MSK day', date });
    }

    let written = 0, totalBytes = 0, skippedExisting = 0;
    const force = req.body?.force === true;

    const tx = db.transaction(() => {
      for (const r of rows) {
        const bIn  = Number(r.bytes_in  || 0);
        const bOut = Number(r.bytes_out || 0);
        if (bIn === 0 && bOut === 0) continue;

        // If an existing daily_traffic row has non-zero data, respect it
        // unless caller explicitly passes force=true.
        if (!force) {
          const existing = db.prepare(
            'SELECT bytes_in, bytes_out FROM daily_traffic WHERE port_name = ? AND date = ?'
          ).get(r.port_id, date);
          if (existing && (existing.bytes_in > 0 || existing.bytes_out > 0)) {
            skippedExisting++;
            continue;
          }
        }

        _dtUpsert.run(r.port_id, date, bIn, bOut);
        // Sync in-memory so the daily chart reflects the backfill immediately
        if (!dailyTraffic[r.port_id]) dailyTraffic[r.port_id] = {};
        dailyTraffic[r.port_id][date] = {
          in: bIn, out: bOut, portName: r.client_name || ''
        };
        written++;
        totalBytes += bIn + bOut;
      }
    });
    tx();

    const totalGb = Math.round(totalBytes / 1e9 * 1000) / 1000;
    logger.info(`[Backfill] daily_traffic for ${date}: ${written} ports, ${totalGb} GB (skipped ${skippedExisting} existing)`);
    logActivity('traffic', 'info', 'backfill_daily', null,
      `Backfilled daily_traffic for ${date}: ${written} ports, ${totalGb} GB`,
      { date, written, total_gb: totalGb, skipped_existing: skippedExisting });

    res.json({
      ok: true, date,
      written, skipped_existing: skippedExisting,
      total_bytes: totalBytes, total_gb: totalGb,
      port_count: rows.length
    });
  } catch (e) {
    logger.error('[Backfill] daily_traffic error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
      const totalGb = Math.round((byMonth[mStr] || 0) / 1e9 * 10) / 10;
      const entry = { month: mStr, label: MONTHS_RU[d.getMonth()], total_gb: totalGb };
      if (i === 0) {
        entry.is_current = true;
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        // Forecast: extrapolate from completed days (dom-1, since today is incomplete)
        const completedDays = Math.max(dom - 1, 1);
        if (completedDays >= 2 && totalGb > 0) {
          entry.forecast_gb = Math.round(totalGb / completedDays * dim * 10) / 10;
        } else {
          // Use previous month total as initial plan
          const prevMStr = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
          const prevGb = Math.round((byMonth[prevMStr] || 0) / 1e9 * 10) / 10;
          if (prevGb > 0) entry.forecast_gb = prevGb;
        }
      }
      // Include today's live bandwidth for current month (from ProxySmart API cache)
      if (i === 0 && totalGb === 0) {
        // Try to get current month data from daily_traffic in-memory
        let todayTotal = 0;
        const todayStr2 = now.toISOString().slice(0, 10);
        for (const days of Object.values(dailyTraffic)) {
          const t = days[todayStr2];
          if (t) todayTotal += (t.in || 0) + (t.out || 0);
        }
        if (todayTotal > 0) entry.total_gb = Math.round(todayTotal / 1e9 * 10) / 10;
      }
      result.push(entry);
    }
    res.json(result);
  } catch (e) {
    logger.error('[monthly_traffic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Heatmap response cache: key=view|id|days, TTL 5 min.
// Heatmap data only changes once per hour (when hourly aggregation runs),
// so a 5-min cache saves ~hundreds of strftime invocations per request.
const _heatmapCache = new Map();
const HEATMAP_TTL_MS = 5 * 60 * 1000;

app.get('/api/analytics/heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { view = 'country', id = 'all' } = req.query;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const cacheKey = `${view}|${id}|${days}`;
    const cached = _heatmapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HEATMAP_TTL_MS) {
      return res.json(cached.data);
    }
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');
    // Build server→country mapping
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }
    // Date list in Moscow time (dynamic offset via getTzOffset)
    const now2 = new Date();
    const mskOffset = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcFetchStart = startDate + 'T00:00:00Z';
    const utcFetchStartShifted = new Date(new Date(utcFetchStart).getTime() - mskOffset * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const matrix = dateList.map(() => new Array(24).fill(0));

    // Build SQL filter based on view type — all filtering is on per-modem columns
    const tzHours = Math.round(Math.max(-12, Math.min(14, mskOffset)));
    const tzStr = (tzHours >= 0 ? '+' : '') + tzHours + ' hours';
    let sql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes, MAX(uncertain) as corrected FROM traffic_hourly WHERE hour_start >= ?`;
    const params = [utcFetchStartShifted];

    if (idKey !== 'all') {
      if (view === 'country') {
        // Find server names for this country
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          sql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          params.push(...servers);
        }
      } else if (view === 'operator') {
        // Filter by operator column (case-insensitive LIKE)
        sql += " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        params.push('%' + idKey + '%');
      } else if (view === 'client') {
        // Filter by client_name column (exact match)
        sql += " AND client_name = ?";
        params.push(id);
      }
    }

    sql += ' GROUP BY day, hour ORDER BY day, hour';
    const rows = db.prepare(sql).all(...params);
    let hasData = false;
    const correctedCells = dateList.map(() => new Array(24).fill(false));
    const dateIdx = new Map(dateList.map((d, i) => [d, i]));
    for (const r of rows) {
      const di = dateIdx.get(r.day);
      if (di !== undefined && r.hour >= 0 && r.hour < 24) {
        matrix[di][r.hour] = r.bytes / 1e9;
        if (r.corrected) correctedCells[di][r.hour] = true;
        hasData = true;
      }
    }

    // Per-operator breakdown for country and client views
    let operator_breakdown;
    if (view === 'country' || view === 'client') {
      operator_breakdown = dateList.map(() => Array.from({ length: 24 }, () => ({})));
      let opSql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, operator, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE hour_start >= ?`;
      const opParams = [utcFetchStartShifted];
      if (view === 'client') {
        opSql += ' AND client_name = ?';
        opParams.push(id);
      } else if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          opSql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          opParams.push(...servers);
        }
      }
      opSql += ' GROUP BY day, hour, operator ORDER BY day, hour, operator';
      const opRows = db.prepare(opSql).all(...opParams);
      for (const r of opRows) {
        const di = dateIdx.get(r.day);
        if (di !== undefined && r.hour >= 0 && r.hour < 24 && r.operator) {
          operator_breakdown[di][r.hour][r.operator] = r.bytes / 1e9;
        }
      }
    }

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()], dateShort: date.slice(5) };
    });
    const resp = {
      meta: { id, days: dateList, day_meta: dayMeta, has_hourly: hasData, corrected: correctedCells },
      matrix
    };
    if (operator_breakdown) resp.operator_breakdown = operator_breakdown;
    _heatmapCache.set(cacheKey, { ts: Date.now(), data: resp });
    // Bound cache size — evict oldest when > 200 entries (very defensive)
    if (_heatmapCache.size > 200) {
      const oldestKey = _heatmapCache.keys().next().value;
      _heatmapCache.delete(oldestKey);
    }
    res.json(resp);
  } catch (e) {
    logger.error('[heatmap]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-port heatmap for a specific modem (nick)
app.get('/api/analytics/modem_heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { nick, serverName } = req.query;
  if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const mhCacheKey = `modem|${serverName}|${nick}|${days}`;
    const mhCached = _heatmapCache.get(mhCacheKey);
    if (mhCached && Date.now() - mhCached.ts < HEATMAP_TTL_MS) {
      return res.json(mhCached.data);
    }
    const now2 = new Date();
    const mskOffset2 = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset2 * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcStart = new Date(new Date(startDate + 'T00:00:00Z').getTime() - mskOffset2 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

    // Get combined traffic for this modem (aggregated across all ports)
    const result = {};
    const dateIdx2 = new Map(dateList.map((d, i) => [d, i]));
    const clientRow = db.prepare("SELECT client_name FROM traffic_hourly WHERE nick = ? AND server_name = ? AND hour_start >= ? LIMIT 1").get(nick, serverName, utcStart);
    const clientLabel = (clientRow && clientRow.client_name) || nick;
    const matrix = dateList.map(() => new Array(24).fill(0));
    const tzH2 = Math.round(Math.max(-12, Math.min(14, mskOffset2)));
    const tzStr2 = (tzH2 >= 0 ? '+' : '') + tzH2 + ' hours';
    const rows = db.prepare(`SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr2}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr2}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE nick = ? AND server_name = ? AND hour_start >= ? GROUP BY day, hour`).all(nick, serverName, utcStart);
    for (const r of rows) {
      const di = dateIdx2.get(r.day);
      if (di !== undefined && r.hour >= 0 && r.hour < 24) matrix[di][r.hour] = r.bytes / 1e9;
    }
    result[clientLabel] = { portId: nick, clientName: clientLabel, matrix };

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()] };
    });
    const mhResp = { nick, serverName, days: dateList, day_meta: dayMeta, ports: result };
    _heatmapCache.set(mhCacheKey, { ts: Date.now(), data: mhResp });
    res.json(mhResp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/data', dashboardLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const merged = mergeServerData(results, '*');
    const servers = apiServers.map(s => {
      const sc = SERVER_COUNTRIES[s.name] || {};
      return { name: s.name, publicIp: s.publicIp, country: sc.country, countryName: sc.name, tz: sc.tz, address: s.address || '' };
    });
    // TASK-01 (SEC): serverAuth removed — credentials must never reach the frontend
    
    // Count modems per client from live bandwidth data
    const _clientModemCounts = {};
    for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
      const pn = bwData.portName;
      if (pn) _clientModemCounts[pn] = (_clientModemCounts[pn] || 0) + 1;
    }
    const sanitizedClients = clients.map(c => {
      const { password, passwordHash, ...safe } = c;
      safe.modemCount = _clientModemCounts[c.portName] || 0;
      return safe;
    });
    // BUG-11: billingLedger removed from bulk response — use /api/admin/clients/:id/ledger instead
    
    const clientMonthCharges = {};
    const clientMonthGb = {};
    const curMonthPfx = new Date().toISOString().slice(0, 7);
    for (const [clientId, entries] of Object.entries(billingLedger)) {
      let cost = 0, gb = 0;
      for (const e of entries) {
        if ((e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(curMonthPfx)) {
          cost += ledgerExpense(e);
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

    // Per-client last completed hour traffic from traffic_hourly
    const clientLastHourGb = {};
    const clientTodayGb = {};
    {
      // Last completed hour
      // N+1 fix: use single bulk query with scalar subquery so "max hour" is
      // computed once; O(1) client lookup via portNameToClientId map.
      const rows = db.prepare(`
        SELECT client_name, SUM(bytes_in + bytes_out) as total
        FROM traffic_hourly
        WHERE client_name != ''
          AND hour_start = (SELECT MAX(hour_start) FROM traffic_hourly WHERE client_name != '')
        GROUP BY client_name
      `).all();
      for (const r of rows) {
        const cid = portNameToClientId[r.client_name];
        if (cid) clientLastHourGb[cid] = trafficBytesToGb(r.total);
      }
      // Today per client from live data
      for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
        const pn = bwData.portName;
        if (!pn || !portNameToClientId[pn]) continue;
        const cid = portNameToClientId[pn];
        if (!clientTodayGb[cid]) clientTodayGb[cid] = 0;
        clientTodayGb[cid] += trafficBytesToGb(parseBwToBytes(bwData.bandwidth_bytes_day_in) + parseBwToBytes(bwData.bandwidth_bytes_day_out));
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

    // Modem trend: compare first N days of current month vs first N days of previous month.
    // This was a hot O(ports × days) loop on every /api/admin/data hit (~50 admin
    // page-views/day each iterating ~11k port/date pairs). Cached for 60s.
    const modemTrend = _getModemTrend();

    // Client trend: aggregate modem trend by portName (client)
    const clientTrend = _getClientTrend();
    // Skip the inline computation below — handled by _getClientTrend cache.
    if (false) {
      const mskNow2 = getMoscowNow();
      const cd2 = Math.max(mskNow2.getDate() - 1, 0);
      if (cd2 > 0) {
        const cy = mskNow2.getFullYear(), cm = mskNow2.getMonth();
        const cp = `${cy}-${String(cm + 1).padStart(2, '0')}`;
        const pd = new Date(cy, cm - 1, 1);
        const pp = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
        const cc = `${cp}-${String(cd2).padStart(2, '0')}`;
        const pc = `${pp}-${String(cd2).padStart(2, '0')}`;
        const byClient = {}; // portName -> { cur, prev }
        for (const [portKey, days] of Object.entries(dailyTraffic)) {
          const pn = portKeyToPortName[portKey] || (Object.values(days)[0] && Object.values(days)[0].portName) || '';
          if (!pn) continue;
          if (!byClient[pn]) byClient[pn] = { cur: 0, prev: 0 };
          for (const [date, entry] of Object.entries(days)) {
            if (date.startsWith(cp) && date <= cc) byClient[pn].cur += (entry.in || 0) + (entry.out || 0);
            else if (date.startsWith(pp) && date <= pc) byClient[pn].prev += (entry.in || 0) + (entry.out || 0);
          }
        }
        for (const [pn, d] of Object.entries(byClient)) {
          if (d.prev > 0) clientTrend[pn] = Math.round((d.cur - d.prev) / d.prev * 100);
          else if (d.cur > 0) clientTrend[pn] = null;
        }
      }
    }

    res.json({
      clientMonthCharges,
      clientMonthGb,
      clientLiveMonthGb,
      clientLastHourGb,
      clientTodayGb,
      modemTrend,
      clientTrend,
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
      tochkaConfig: { jwt: tochkaConfig.jwt ? '****' + tochkaConfig.jwt.slice(-8) : '', clientId: tochkaConfig.clientId, customerCode: tochkaConfig.customerCode, accountId: tochkaConfig.accountId, companyName: tochkaConfig.companyName, companyInn: tochkaConfig.companyInn, companyKpp: tochkaConfig.companyKpp, companyAddress: tochkaConfig.companyAddress, bankAccount: tochkaConfig.bankAccount, bankName: tochkaConfig.bankName, bankBic: tochkaConfig.bankBic, bankCorrAccount: tochkaConfig.bankCorrAccount },
      proxyCheckSummary: getProxyCheckSummary(),
      proxyIssues: computeProxyIssues(),
    });
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

// "Сбоит прокси" — качество прокси-сервиса (latency + error rate).
// Триггеры:
//   1) avg latency за окно > proxy_alert_latency_ms
//   2) error_rate за окно > proxy_alert_error_pct
// IP-ротация НЕ учитывается — для этого есть отдельная карточка "Завис IP",
// которая опирается на ip_tracking (живые проверки IP), а не на rotation_log
// (который часто содержит исторические/auto-rotation записи без реального
// смысла "проблемы").
function computeProxyIssues() {
  try {
    const winMin   = Math.max(5, Math.min(720, appSettings.proxy_alert_window_min || 60));
    const latLimit = Math.max(100, Math.min(60000, appSettings.proxy_alert_latency_ms || 1500));
    const errLimit = Math.max(0, Math.min(100, appSettings.proxy_alert_error_pct || 5));
    const sinceExpr = `datetime('now', '-${winMin} minutes')`;

    const checkRows = db.prepare(`
      SELECT server_name, nick,
             AVG(total_ms) FILTER (WHERE error IS NULL) AS avg_ms,
             COUNT(*)                                  AS total,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
             MAX(client_name)                          AS client_name,
             MAX(operator)                             AS operator
        FROM proxy_checks
       WHERE checked_at >= ${sinceExpr}
       GROUP BY server_name, nick
    `).all();

    const issues = [];
    for (const c of checkRows) {
      const errPct  = c.total > 0 ? Math.round(c.errors / c.total * 1000) / 10 : 0;
      const latency = c.avg_ms != null ? Math.round(c.avg_ms) : null;
      const reasons = [];
      if (latency != null && latency > latLimit) reasons.push(`задержка ${latency}мс`);
      if (errPct > errLimit) reasons.push(`ошибки ${errPct}%`);
      if (reasons.length === 0) continue;
      issues.push({
        nick: c.nick,
        server: c.server_name,
        operator: c.operator || '',
        client: c.client_name || '',
        latency,
        errorPct: errPct,
        reasons,
        detail: reasons.join(' · ')
      });
    }
    issues.sort((a, b) => b.reasons.length - a.reasons.length || (b.errorPct - a.errorPct));
    return issues;
  } catch (e) {
    logger.error('[proxyIssues]', e.message);
    return [];
  }
}

// Auto-reboot of flaky modems.
// Triggers when a modem appears in proxyIssues with reasons OTHER than just
// rotation-fail (i.e. actual quality problems: high latency or high error %).
// Throttle: never reboots the same modem more often than auto_reboot_min_interval_min.
// Safe by design — opt-in via appSettings.auto_reboot_enabled.
const _autoRebootInsert = (() => {
  try {
    return db.prepare(`INSERT INTO auto_reboot_log
      (server_name, nick, imei, reason, status, error)
      VALUES (?, ?, ?, ?, ?, ?)`);
  } catch (_) { return null; }
})();

async function runAutoReboot() {
  if (!appSettings.auto_reboot_enabled) return;
  const minInterval = Math.max(15, parseInt(appSettings.auto_reboot_min_interval_min) || 60);

  // computeProxyIssues already returns only latency/error-driven issues
  const candidates = computeProxyIssues();
  if (candidates.length === 0) return;

  // Build IMEI lookup: nick + server_name → imei (need IMEI for reboot API)
  let live;
  try { live = await fetchAllServersDataCached(); } catch (e) { live = []; }
  const imeiMap = {};   // server|nick → imei
  for (const data of live) {
    const srv = data.serverName;
    if (!Array.isArray(data.status)) continue;
    for (const m of data.status) {
      const md = m.modem_details || {};
      if (md.NICK && md.IMEI) imeiMap[srv + '|' + md.NICK] = md.IMEI;
    }
  }

  // Throttle check via DB — last reboot timestamp per modem
  const sinceExpr = `datetime('now', '-${minInterval} minutes')`;
  const recent = db.prepare(`
    SELECT server_name, nick, MAX(rebooted_at) AS last
      FROM auto_reboot_log
     WHERE rebooted_at >= ${sinceExpr}
     GROUP BY server_name, nick
  `).all();
  const recentSet = new Set(recent.map(r => r.server_name + '|' + r.nick));

  let attempted = 0, succeeded = 0;
  for (const it of candidates) {
    const key = it.server + '|' + it.nick;
    if (recentSet.has(key)) continue; // already rebooted recently
    const imei = imeiMap[key];
    if (!imei) {
      logger.warn(`[AutoReboot] no IMEI for ${it.server}/${it.nick}, skipping`);
      continue;
    }
    const server = findServer(it.server);
    if (!server) continue;
    attempted++;
    try {
      await fetchApi(server, `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(imei)}`);
      if (_autoRebootInsert) _autoRebootInsert.run(it.server, it.nick, imei, it.detail, 'success', null);
      logger.warn(`[AutoReboot] ${it.server}/${it.nick} IMEI=${imei} reason="${it.detail}"`);
      logActivity('modem', 'warn', 'auto_reboot', it.nick,
        `Auto-reboot triggered: ${it.detail}`,
        { server: it.server, nick: it.nick, imei, reasons: it.reasons });
      succeeded++;
    } catch (e) {
      if (_autoRebootInsert) _autoRebootInsert.run(it.server, it.nick, imei, it.detail, 'failed', e.message);
      logger.error(`[AutoReboot] ${it.server}/${it.nick} failed:`, e.message);
    }
  }
  if (attempted > 0) {
    logger.info(`[AutoReboot] cycle: ${succeeded}/${attempted} reboots, ${candidates.length - attempted} throttled`);
  }
}

// Proxy check summary helper — last 7 days
function getProxyCheckSummary() {
  try {
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const summary = dbStmts.proxyCheckSummary.all(since7d);
    const last = dbStmts.proxyCheckLast.all();
    return { summary, last };
  } catch (e) { return { summary: [], last: [] }; }
}

// Detailed proxy check history API
app.get('/api/admin/proxy_checks', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const nick = req.query.nick;
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    if (nick) {
      const checks = dbStmts.proxyCheckByNick.all(nick, since);
      res.json({ checks });
    } else {
      const checks = dbStmts.proxyCheckRecent.all(since);
      res.json({ checks });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Latency analytics — daily percentiles, overall distribution, and prior-period
// comparison. Used by the "Распределение задержек" card.
app.get('/api/analytics/latency_stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { view = 'country', id = 'all' } = req.query;
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');

    const mskOffset = getTzOffset('Europe/Moscow');
    const tzHours2 = Math.round(Math.max(-12, Math.min(14, mskOffset)));
    const tzStr = (tzHours2 >= 0 ? '+' : '') + tzHours2 + ' hours';
    const now2 = new Date();
    const since = new Date(now2.getTime() - days * 86400000).toISOString();
    // Prior period: equal-length window immediately preceding `since`.
    const priorSince = new Date(now2.getTime() - days * 2 * 86400000).toISOString();
    const priorUntil = since;

    // Build server→country mapping
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }

    let filter = '';
    const filterParams = [];
    if (idKey !== 'all') {
      if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          filter = ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          filterParams.push(...servers);
        }
      } else if (view === 'operator') {
        filter = " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        filterParams.push('%' + idKey + '%');
      } else if (view === 'client') {
        filter = " AND client_name = ?";
        filterParams.push(id);
      }
    }

    // Current window: per-day values + counts. total_ms = full request (modem→site),
    // connect_ms = TCP handshake to modem only. Both reported separately so the
    // operator can tell whether slow checks are modem-side or upstream.
    const dayValsSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND total_ms IS NOT NULL AND error IS NULL${filter} ORDER BY day, total_ms`;
    const errSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND error IS NOT NULL${filter} GROUP BY day`;
    const totalSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ?${filter} GROUP BY day`;
    const rows = db.prepare(dayValsSql).all(since, ...filterParams);
    const errRows = db.prepare(errSql).all(since, ...filterParams);
    const totalRows = db.prepare(totalSql).all(since, ...filterParams);

    const byDay = {};
    const allVals = [];
    const allConnectVals = [];
    for (const r of rows) {
      if (!byDay[r.day]) byDay[r.day] = [];
      byDay[r.day].push(r.total_ms);
      allVals.push(r.total_ms);
      if (r.connect_ms != null) allConnectVals.push(r.connect_ms);
    }
    const errMap = {};
    let totalErrs = 0;
    for (const r of errRows) { errMap[r.day] = r.cnt; totalErrs += r.cnt; }
    const totalMap = {};
    let totalChecks = 0;
    for (const r of totalRows) { totalMap[r.day] = r.cnt; totalChecks += r.cnt; }

    // Percentile helper — input must already be sorted ascending.
    const pctile = (sorted, p) => {
      if (!sorted.length) return null;
      const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
      return sorted[Math.max(0, idx)];
    };

    // Date list in Moscow time (consistent with heatmap)
    const mskNow = new Date(now2.getTime() + mskOffset * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }

    const result = {
      days: dateList,
      median_ms: [], avg_ms: [], p75_ms: [], p95_ms: [], p99_ms: [],
      error_pct: [], total_checks: []
    };
    for (const day of dateList) {
      const vals = byDay[day] || [];
      const total = totalMap[day] || 0;
      const errs = errMap[day] || 0;
      if (vals.length === 0) {
        result.median_ms.push(null);
        result.avg_ms.push(null);
        result.p75_ms.push(null);
        result.p95_ms.push(null);
        result.p99_ms.push(null);
      } else {
        // vals already sorted ascending (SQL ORDER BY day, total_ms)
        result.median_ms.push(pctile(vals, 0.5));
        result.p75_ms.push(pctile(vals, 0.75));
        result.p95_ms.push(pctile(vals, 0.95));
        result.p99_ms.push(pctile(vals, 0.99));
        result.avg_ms.push(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
      }
      result.error_pct.push(total > 0 ? Math.round(errs / total * 100) : null);
      result.total_checks.push(total);
    }

    // Overall percentiles across the whole window
    const allSorted = allVals.slice().sort((a, b) => a - b);
    const connectSorted = allConnectVals.slice().sort((a, b) => a - b);
    const overall = {
      total_checks: totalChecks,
      ok_checks: allVals.length,
      errors: totalErrs,
      error_pct: totalChecks > 0 ? Math.round(totalErrs / totalChecks * 1000) / 10 : null,
      p50: pctile(allSorted, 0.5),
      p75: pctile(allSorted, 0.75),
      p95: pctile(allSorted, 0.95),
      p99: pctile(allSorted, 0.99),
      // Connect-only percentiles (TCP handshake to modem, excludes upstream request)
      connect_p50: pctile(connectSorted, 0.5),
      connect_p75: pctile(connectSorted, 0.75),
      connect_p95: pctile(connectSorted, 0.95),
      connect_p99: pctile(connectSorted, 0.99),
    };

    // Distribution buckets — uses configured warn/bad thresholds.
    // very_slow boundary is 2× bad: visibly catastrophic checks.
    const warnMs = Number(appSettings.proxy_check_warn_ms) || 500;
    const badMs = Number(appSettings.proxy_check_bad_ms) || 2000;
    const verySlowMs = badMs * 2;
    const buckets = { fast: 0, ok: 0, slow: 0, very_slow: 0 };
    for (const v of allVals) {
      if (v < warnMs) buckets.fast++;
      else if (v < badMs) buckets.ok++;
      else if (v < verySlowMs) buckets.slow++;
      else buckets.very_slow++;
    }

    // Prior period (same filter, equal-length window immediately before `since`)
    const priorValsSql = `SELECT total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND total_ms IS NOT NULL AND error IS NULL${filter}`;
    const priorTotalSql = `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ?${filter}`;
    const priorErrSql = `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND error IS NOT NULL${filter}`;
    const priorRows = db.prepare(priorValsSql).all(priorSince, priorUntil, ...filterParams);
    const priorTotal = db.prepare(priorTotalSql).get(priorSince, priorUntil, ...filterParams).cnt || 0;
    const priorErrs = db.prepare(priorErrSql).get(priorSince, priorUntil, ...filterParams).cnt || 0;
    const priorSorted = priorRows.map(r => r.total_ms).sort((a, b) => a - b);
    const priorConnectSorted = priorRows.map(r => r.connect_ms).filter(v => v != null).sort((a, b) => a - b);
    const prior = {
      total_checks: priorTotal,
      errors: priorErrs,
      error_pct: priorTotal > 0 ? Math.round(priorErrs / priorTotal * 1000) / 10 : null,
      p50: pctile(priorSorted, 0.5),
      p75: pctile(priorSorted, 0.75),
      p95: pctile(priorSorted, 0.95),
      p99: pctile(priorSorted, 0.99),
      connect_p50: pctile(priorConnectSorted, 0.5),
      connect_p75: pctile(priorConnectSorted, 0.75),
      connect_p95: pctile(priorConnectSorted, 0.95),
      connect_p99: pctile(priorConnectSorted, 0.99),
    };

    res.json({
      ...result,
      overall,
      buckets,
      prior,
      thresholds: { warn_ms: warnMs, bad_ms: badMs, very_slow_ms: verySlowMs }
    });
  } catch (e) {
    logger.error('[latency_stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Latency per-day scatter — individual check points for a single day
app.get('/api/analytics/latency_day', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { view = 'country', id = 'all', date } = req.query;
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');

    // Determine MSK date
    const mskOffset = getTzOffset('Europe/Moscow');
    let mskDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      mskDate = date;
    } else {
      const now = new Date();
      const mskNow = new Date(now.getTime() + mskOffset * 3600 * 1000);
      mskDate = mskNow.toISOString().slice(0, 10);
    }

    // Convert MSK day boundaries to UTC
    const dayStartMsk = new Date(mskDate + 'T00:00:00Z');
    const dayStartUtc = new Date(dayStartMsk.getTime() - mskOffset * 3600 * 1000);
    const dayEndUtc = new Date(dayStartUtc.getTime() + 86400000);
    const utcFrom = dayStartUtc.toISOString();
    const utcTo = dayEndUtc.toISOString();

    // Build filter (same logic as latency_stats)
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }

    let filter = '';
    const params = [utcFrom, utcTo];
    if (idKey !== 'all') {
      if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          filter = ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          params.push(...servers);
        }
      } else if (view === 'operator') {
        filter = " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        params.push('%' + idKey + '%');
      } else if (view === 'client') {
        filter = " AND client_name = ?";
        params.push(id);
      }
    }

    const sql = `SELECT nick, server_name, operator, client_name, checked_at,
      connect_ms, total_ms, status_code, error
      FROM proxy_checks
      WHERE checked_at >= ? AND checked_at < ?${filter}
      ORDER BY checked_at ASC`;

    const rows = db.prepare(sql).all(...params);

    // Build points with MSK time
    const points = [];
    let okCount = 0, errCount = 0, totalMsArr = [];
    for (const r of rows) {
      const utcMs = new Date(r.checked_at).getTime();
      const mskMs = utcMs + mskOffset * 3600 * 1000;
      const mskD = new Date(mskMs);
      const h = mskD.getUTCHours();
      const m = mskD.getUTCMinutes();
      const minutes = h * 60 + m;
      const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

      points.push({
        t: timeStr,
        min: minutes,
        nick: r.nick,
        op: r.operator || '',
        client: r.client_name || '',
        connect: r.connect_ms,
        total: r.total_ms,
        status: r.status_code,
        error: r.error || null
      });

      if (r.error) {
        errCount++;
      } else {
        okCount++;
        if (r.total_ms != null) totalMsArr.push(r.total_ms);
      }
    }

    // Summary
    const sorted = totalMsArr.slice().sort((a, b) => a - b);
    const summary = {
      total: points.length,
      ok: okCount,
      errors: errCount,
      median_ms: null,
      p95_ms: null,
      avg_ms: null
    };
    if (sorted.length > 0) {
      const mid = Math.floor(sorted.length / 2);
      summary.median_ms = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
      summary.avg_ms = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      summary.p95_ms = sorted[Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)];
    }

    res.json({ date: mskDate, points, summary });
  } catch (e) {
    logger.error('[latency_day]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// PHASE 3 — "Система" tab analytics endpoints
// ============================================================================

// 3.1 Modem health: per-modem uptime, latency, errors, rotations, traffic, score
app.get('/api/analytics/modem_health', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const sinceExpr = `datetime('now', '-${days} days')`;
    const badMs = Number(appSettings.proxy_check_bad_ms) || 1500;
    const errThreshold = Number(appSettings.error_rate_threshold) || 15;

    // Base set: modems active in the period (have proxy_checks OR traffic_hourly).
    // Deduplicates historical/moved modem_meta entries (e.g. modems migrated
    // between servers — multiple rows with same nick). Picks the most recently
    // updated modem_meta row per (server, nick) as authoritative source of operator.
    const modems = db.prepare(`
      WITH active AS (
        SELECT DISTINCT server_name, nick FROM proxy_checks
        WHERE checked_at >= ${sinceExpr}
        UNION
        SELECT DISTINCT server_name, nick FROM traffic_hourly
        WHERE hour_start >= ${sinceExpr}
      ),
      meta_latest AS (
        SELECT server_name, nick, imei, operator,
               ROW_NUMBER() OVER (PARTITION BY server_name, nick ORDER BY updated_at DESC) as rn
        FROM modem_meta
      )
      SELECT a.server_name, a.nick, COALESCE(m.imei, '') as imei, COALESCE(m.operator, '') as operator
      FROM active a
      LEFT JOIN meta_latest m
        ON m.server_name = a.server_name AND m.nick = a.nick AND m.rn = 1
      ORDER BY a.server_name, a.nick
    `).all();
    if (modems.length === 0) return res.json({ modems: [], summary: { total: 0 } });

    // Batch per-modem queries grouped to avoid N+1. One pass per metric.
    const checksRows = db.prepare(`
      SELECT server_name, nick,
             AVG(total_ms) FILTER (WHERE error IS NULL) as avg_latency,
             COUNT(*) as total_checks,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as err_checks
      FROM proxy_checks
      WHERE checked_at >= ${sinceExpr}
      GROUP BY server_name, nick
    `).all();
    const checksMap = {};
    for (const r of checksRows) checksMap[r.server_name + '|' + r.nick] = r;

    const rotRows = db.prepare(`
      SELECT server_name, nick,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY server_name, nick
    `).all();
    const rotMap = {};
    for (const r of rotRows) rotMap[r.server_name + '|' + r.nick] = r;

    // Traffic totals (for the traffic_gb display only — NOT for uptime).
    // Uptime is computed from polling data (uptimeTracking) so it reflects
    // "modem reachable" not "client sent traffic". See uptime computation below.
    const trafRows = db.prepare(`
      SELECT server_name, nick, SUM(bytes_in + bytes_out) as bytes
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
      GROUP BY server_name, nick
    `).all();
    const trafMap = {};
    for (const r of trafRows) trafMap[r.server_name + '|' + r.nick] = r;

    // Uptime — polling-based: 5-min ping checks against ProxySmart aggregated
    // into per-day buckets in uptimeTracking[server+'_'+imei].daily[YYYY-MM-DD].
    // online/total over the last N days = ratio. Reflects "modem available"
    // independent of client traffic activity. (Traffic-based active_hours was
    // misleading: a modem with no client traffic looked offline.)
    const utCutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    function pollingUptime(server, imei) {
      if (!imei) return null;
      const ut = uptimeTracking[server + '_' + imei];
      if (!ut || !ut.daily) return null;
      let online = 0, total = 0;
      for (const d in ut.daily) {
        if (d >= utCutoffDate) {
          online += ut.daily[d].online || 0;
          total  += ut.daily[d].total  || 0;
        }
      }
      if (total === 0) return null;
      return { online, total, ratio: online / total };
    }

    const out = modems.map(m => {
      const key = m.server_name + '|' + m.nick;
      const ch = checksMap[key] || {};
      const rot = rotMap[key] || {};
      const tr = trafMap[key] || {};
      const errPct = ch.total_checks > 0 ? (ch.err_checks / ch.total_checks) * 100 : null;
      const latency = ch.avg_latency != null ? Math.round(ch.avg_latency) : null;

      // Replaces the old traffic-based activeHours/expectedHours formula.
      const up = pollingUptime(m.server_name, m.imei);
      const uptimeRatio = up ? up.ratio : 0;
      const uptimePct   = up ? Math.round(uptimeRatio * 1000) / 10 : 0;
      const upOnline    = up ? up.online : 0;
      const upTotal     = up ? up.total  : 0;

      // Health score 0-100 — computed alongside a per-factor `breakdown` so
      // the UI can show *why* a modem scored low (used by the «Здоровье» tab
      // in the modem detail modal). Each breakdown entry records value+norm+
      // impact (points subtracted from the initial 100).
      let score = 100;
      const breakdown = [];

      // Thresholds for the health score. Calibrated to the actual modem fleet
      // (typical baseline: ~1.8s latency, ~12s rotation). Deliberately
      // decoupled from `proxy_check_bad_ms` — that setting controls the table
      // cell coloring and is tuned for a different purpose.
      const ERROR_NORMAL_PCT = 5;           // ≤ 5% is normal — no penalty
      const LAT_WARN_MS = 2000;             // ≤ 2000ms is normal
      const LAT_BAD_MS  = 4000;             // > 4000ms is severe
      const ROT_NORMAL_SEC = 15;            // ≤ 15s is normal
      const ROT_BAD_SEC    = 30;            // > 30s is severe

      // Factor 1: Error rate. Norm is 0-5% (real-world traffic always has some
      // noise from upstream / target sites). Penalty applies only above 5%:
      // (errPct - 5) × 2 points, capped at 50.
      const errCost = errPct != null && errPct > ERROR_NORMAL_PCT
        ? Math.min((errPct - ERROR_NORMAL_PCT) * 2, 50)
        : 0;
      score -= errCost;
      breakdown.push({
        factor: 'error_pct',
        label: 'Ошибки',
        value: errPct != null ? Math.round(errPct * 10) / 10 : null,
        unit: '%',
        norm: '≤ ' + ERROR_NORMAL_PCT + '%',
        warn_at: '> ' + ERROR_NORMAL_PCT + '%',
        bad_at: '≥ ' + errThreshold + '%',
        impact: -Math.round(errCost * 10) / 10,
        impact_explain: errPct == null ? 'нет данных'
          : errPct <= ERROR_NORMAL_PCT ? 'в норме (до 5%), штрафа нет'
          : `−${Math.round(errCost*10)/10} баллов ((${Math.round(errPct*10)/10}% − ${ERROR_NORMAL_PCT}%) × 2, max −50)`,
        status: errPct == null ? 'unknown'
          : errPct >= errThreshold ? 'bad'
          : errPct > ERROR_NORMAL_PCT ? 'warn'
          : 'good',
      });

      // Factor 2: Latency — stepped multiplier so there's no harsh cliff.
      // ≤ warn (1500ms): no penalty. warn-bad (1500-3000ms): ×0.9 (−10%).
      // > bad (3000ms): ×0.75 (−25%).
      const beforeLatency = score;
      let latencyMult = 1, latencyTier = 'good';
      if (latency != null) {
        if (latency > LAT_BAD_MS)       { latencyMult = 0.75; latencyTier = 'bad';  }
        else if (latency > LAT_WARN_MS) { latencyMult = 0.9;  latencyTier = 'warn'; }
      } else {
        latencyTier = 'unknown';
      }
      score *= latencyMult;
      const latencyCost = beforeLatency - score;
      breakdown.push({
        factor: 'latency_ms',
        label: 'Задержка',
        value: latency,
        unit: 'мс',
        norm: '≤ ' + LAT_WARN_MS + ' мс',
        warn_at: '> ' + LAT_WARN_MS + ' мс',
        bad_at: '> ' + LAT_BAD_MS + ' мс',
        impact: -Math.round(latencyCost * 10) / 10,
        impact_explain: latency == null ? 'нет данных'
          : latencyMult === 1 ? 'в норме, штрафа нет'
          : `× ${latencyMult} (${latencyTier === 'bad' ? '−25%' : '−10%'}) → −${Math.round(latencyCost*10)/10} баллов`,
        status: latencyTier,
      });

      // Factor 3: Rotation duration — new. If IP rotation takes too long the
      // proxy effectively pauses. ≤5s normal, 5-15s ×0.95, >15s ×0.85.
      const beforeRot = score;
      const rotAvg = rot.avg_sec != null ? rot.avg_sec : null;
      let rotMult = 1, rotTier = 'good';
      if (rotAvg != null) {
        if (rotAvg > ROT_BAD_SEC)         { rotMult = 0.85; rotTier = 'bad';  }
        else if (rotAvg > ROT_NORMAL_SEC) { rotMult = 0.95; rotTier = 'warn'; }
      } else if (rot.total === 0) {
        rotTier = 'unknown';
      }
      score *= rotMult;
      const rotCost = beforeRot - score;
      breakdown.push({
        factor: 'rotation_avg_sec',
        label: 'Длительность ротации',
        value: rotAvg != null ? Math.round(rotAvg * 10) / 10 : null,
        unit: 'с',
        norm: '≤ ' + ROT_NORMAL_SEC + ' с',
        warn_at: '> ' + ROT_NORMAL_SEC + ' с',
        bad_at: '> ' + ROT_BAD_SEC + ' с',
        impact: -Math.round(rotCost * 10) / 10,
        impact_explain: rotAvg == null ? (rot.total === 0 ? 'нет ротаций за период' : 'нет данных')
          : rotMult === 1 ? 'в норме, штрафа нет'
          : `× ${rotMult} (${rotTier === 'bad' ? '−15%' : '−5%'}) → −${Math.round(rotCost*10)/10} баллов`,
        status: rotTier,
      });

      // Factor 4: Uptime — polling-based. Multiplies score by ratio of
      // successful pings to total pings over the period.
      const beforeUptime = score;
      if (up) score *= uptimeRatio;
      const uptimeCost = beforeUptime - score;
      breakdown.push({
        factor: 'uptime_pct',
        label: 'Аптайм',
        value: uptimePct,
        unit: '%',
        norm: '100%',
        warn_at: '< 99%',
        bad_at: '< 95%',
        impact: -Math.round(uptimeCost * 10) / 10,
        impact_explain: !up ? 'нет данных пингов'
          : uptimeRatio >= 1 ? 'в норме, штрафа нет'
          : `× ${Math.round(uptimeRatio*100)/100} (${upOnline} из ${upTotal} проверок онлайн, каждые 5 мин) → −${Math.round(uptimeCost*10)/10} баллов`,
        status: !up ? 'unknown' : uptimePct >= 99 ? 'good' : uptimePct >= 95 ? 'warn' : 'bad',
      });

      // Informational only (do NOT affect score, but useful in the detail view).
      const rotFailedPct = rot.total > 0 ? (rot.failed / rot.total) * 100 : 0;
      breakdown.push({
        factor: 'rotations_failed_pct',
        label: 'Неуспешные ротации',
        value: Math.round(rotFailedPct * 10) / 10,
        unit: '%',
        norm: '< 5%',
        warn_at: '> 5%',
        bad_at: '> 15%',
        impact: 0,
        impact_explain: rot.total === 0 ? 'нет ротаций за период' : 'информационно, на скор не влияет',
        status: rot.total === 0 ? 'unknown' : rotFailedPct >= 15 ? 'bad' : rotFailedPct >= 5 ? 'warn' : 'good',
      });
      breakdown.push({
        factor: 'total_checks',
        label: 'Всего проверок',
        value: ch.total_checks || 0,
        unit: '',
        norm: '> 100 / день',
        warn_at: '< 50 / день',
        bad_at: '< 10 / день',
        impact: 0,
        impact_explain: 'информационно, контекст для других метрик',
        status: 'unknown',
      });

      score = Math.max(0, Math.min(100, Math.round(score)));

      return {
        nick: m.nick,
        server_name: m.server_name,
        operator: m.operator || '',
        latency_ms: latency,
        error_pct: errPct != null ? Math.round(errPct * 10) / 10 : null,
        total_checks: ch.total_checks || 0,
        rotations: rot.total || 0,
        rotations_failed_pct: Math.round(rotFailedPct * 10) / 10,
        avg_rotation_sec: rot.avg_sec != null ? Math.round(rot.avg_sec * 10) / 10 : null,
        traffic_gb: tr.bytes ? Math.round(tr.bytes / 1e9 * 100) / 100 : 0,
        uptime_online_checks: upOnline,
        uptime_total_checks: upTotal,
        uptime_pct: uptimePct,
        health_score: score,
        status: score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad',
        breakdown,
      };
    });

    const summary = {
      total: out.length,
      good: out.filter(x => x.status === 'good').length,
      warn: out.filter(x => x.status === 'warn').length,
      bad: out.filter(x => x.status === 'bad').length,
      err_threshold_pct: errThreshold
    };
    res.json({ modems: out, summary, days });
  } catch (e) {
    logger.error('[modem_health]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3.2 Rotation analytics
app.get('/api/analytics/rotations', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const sinceExpr = `datetime('now', '-${days} days')`;

    const totals = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec,
             MAX(took_sec) as max_sec,
             MIN(took_sec) as min_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
    `).get();

    const perDay = db.prepare(`
      SELECT substr(started_at, 1, 10) as date,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY date
      ORDER BY date
    `).all();

    const perModem = db.prepare(`
      SELECT r.server_name, r.nick, m.operator,
             COUNT(*) as total,
             SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
             AVG(r.took_sec) as avg_sec,
             MAX(r.took_sec) as max_sec
      FROM rotation_log r
      LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
      WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL
      GROUP BY r.server_name, r.nick
      ORDER BY total DESC
      LIMIT 200
    `).all();

    const perOperator = db.prepare(`
      SELECT COALESCE(m.operator, 'unknown') as operator,
             COUNT(*) as total,
             SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
             AVG(r.took_sec) as avg_sec
      FROM rotation_log r
      LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
      WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL
      GROUP BY operator
      ORDER BY total DESC
    `).all();

    const perServer = db.prepare(`
      SELECT server_name,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec,
             MAX(took_sec) as max_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY server_name
      ORDER BY total DESC
    `).all();

    const recentFailed = db.prepare(`
      SELECT server_name, nick, old_ip, new_ip, started_at, took_sec
      FROM rotation_log
      WHERE old_ip IS NOT NULL AND new_ip IS NOT NULL AND old_ip = new_ip
        AND started_at >= ${sinceExpr}
      ORDER BY started_at DESC
      LIMIT 50
    `).all();

    const success = totals.total > 0 ? ((totals.total - totals.failed) / totals.total) * 100 : 0;
    res.json({
      days,
      summary: {
        total: totals.total || 0,
        failed: totals.failed || 0,
        success_pct: Math.round(success * 10) / 10,
        avg_sec: totals.avg_sec != null ? Math.round(totals.avg_sec * 10) / 10 : null,
        max_sec: totals.max_sec != null ? Math.round(totals.max_sec * 10) / 10 : null,
        min_sec: totals.min_sec != null ? Math.round(totals.min_sec * 10) / 10 : null,
      },
      per_day: perDay,
      per_server: perServer,
      per_modem: perModem,
      per_operator: perOperator,
      recent_failed: recentFailed
    });
  } catch (e) {
    logger.error('[rotations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3.3 IP analytics
app.get('/api/analytics/ip_stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const sinceExpr = `datetime('now', '-${days} days')`;

    const uniqueIps = db.prepare(`
      SELECT COUNT(DISTINCT ip) as c FROM ip_history
      WHERE started_at >= ${sinceExpr}
    `).get().c;

    const totalAssignments = db.prepare(`
      SELECT COUNT(*) as c FROM ip_history WHERE started_at >= ${sinceExpr}
    `).get().c;

    // Reused IPs: more than 1 distinct key uses it
    const reused = db.prepare(`
      SELECT ip, COUNT(*) as uses, COUNT(DISTINCT key) as modems,
             MIN(started_at) as first, MAX(started_at) as last
      FROM ip_history
      WHERE started_at >= ${sinceExpr}
      GROUP BY ip
      HAVING modems > 1
      ORDER BY uses DESC
      LIMIT 100
    `).all();

    // Average lifetime: only rows with ended_at
    const lifetimeAll = db.prepare(`
      SELECT AVG((julianday(ended_at) - julianday(started_at)) * 86400) as avg_sec
      FROM ip_history
      WHERE ended_at IS NOT NULL AND started_at >= ${sinceExpr}
    `).get().avg_sec;

    // Pool size per server (distinct IPs per server prefix in key, e.g. "S1_port123")
    const poolsRows = db.prepare(`
      SELECT substr(key, 1, instr(key, '_') - 1) as server,
             COUNT(DISTINCT ip) as ip_count,
             COUNT(*) as total_assignments,
             AVG(CASE WHEN ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) as avg_lifetime_sec
      FROM ip_history
      WHERE started_at >= ${sinceExpr} AND instr(key, '_') > 0
      GROUP BY server
      ORDER BY ip_count DESC
    `).all();

    res.json({
      days,
      summary: {
        unique_ips: uniqueIps,
        total_assignments: totalAssignments,
        reuse_ratio: uniqueIps > 0 ? Math.round(totalAssignments / uniqueIps * 100) / 100 : 0,
        avg_lifetime_sec: lifetimeAll != null ? Math.round(lifetimeAll) : null,
        reused_count: reused.length
      },
      reused,
      pools: poolsRows
    });
  } catch (e) {
    logger.error('[ip_stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3.4 Traffic forecast — per-client linear regression + runway (days of balance left)
app.get('/api/analytics/traffic_forecast', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 60);
    const sinceExpr = `datetime('now', '-${days} days')`;
    const mskToday = getMoscowToday();
    const mskNow = getMoscowNow();
    const daysInMonth = new Date(mskNow.getFullYear(), mskNow.getMonth() + 1, 0).getDate();
    const dayOfMonth = mskNow.getDate();
    const daysLeftInMonth = daysInMonth - dayOfMonth;

    // Per-client per-day gb totals from daily_traffic
    const rows = db.prepare(`
      SELECT port_name, date, SUM(bytes_in + bytes_out) as bytes
      FROM daily_traffic
      WHERE date >= substr(${sinceExpr}, 1, 10)
      GROUP BY port_name, date
    `).all();

    // Build client → port_names
    const portToClient = {};
    for (const c of clients) if (c.portName) portToClient[c.portName] = c;
    const portIdToClient = {}; // Fallback: port_id like "S1_portXXX" → client via modem_meta

    // Per-client aggregation
    const perClient = {};
    for (const r of rows) {
      // port_name in daily_traffic is the full port_id (S1_portXXX), not client portName.
      // Match via live portKey mapping.
      const pnCandidate = portKeyToPortName[r.port_name] || r.port_name;
      const client = portToClient[pnCandidate];
      if (!client) continue;
      if (!perClient[client.id]) perClient[client.id] = { id: client.id, name: client.name, portName: client.portName, price: client.price || 0, currency: client.currency || 'RUB', balance: client.balance || 0, billingType: client.billingType || 'per_gb', days: {} };
      if (!perClient[client.id].days[r.date]) perClient[client.id].days[r.date] = 0;
      perClient[client.id].days[r.date] += r.bytes || 0;
    }

    const forecasts = Object.values(perClient).map(c => {
      const arr = Object.entries(c.days).sort((a, b) => a[0].localeCompare(b[0]));
      const xs = arr.map((_, i) => i);
      const ys = arr.map(a => a[1] / 1e9); // GB
      const n = xs.length;
      let slope = 0, mean = 0;
      if (n >= 2) {
        const sumX = xs.reduce((s, v) => s + v, 0);
        const sumY = ys.reduce((s, v) => s + v, 0);
        const sumXY = xs.reduce((s, v, i) => s + v * ys[i], 0);
        const sumX2 = xs.reduce((s, v) => s + v * v, 0);
        const meanX = sumX / n, meanY = sumY / n;
        const denom = sumX2 - n * meanX * meanX;
        slope = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 0;
        mean = meanY;
      } else if (n === 1) {
        mean = ys[0];
      }

      const avgDailyGb = mean;
      // Forecast end of month: current month accumulated so far + avgDaily * days_left
      const thisMonthRows = arr.filter(a => a[0].startsWith(mskToday.slice(0, 7)));
      const monthGbSoFar = thisMonthRows.reduce((s, a) => s + a[1] / 1e9, 0);
      const forecastMonthGb = monthGbSoFar + avgDailyGb * daysLeftInMonth;

      // Runway: how many days current balance lasts at current rate
      let runwayDays = null;
      if (c.billingType === 'per_gb' && c.price > 0 && avgDailyGb > 0) {
        runwayDays = Math.max(0, Math.floor(c.balance / (avgDailyGb * c.price)));
      } else if (c.billingType === 'per_modem' && c.price > 0) {
        // rough approx — divide balance by (price per modem / days in month) × modem count
        runwayDays = Math.floor(c.balance / (c.price / daysInMonth));
      }

      return {
        client_id: c.id,
        client_name: c.name,
        avg_daily_gb: Math.round(avgDailyGb * 100) / 100,
        trend_gb_per_day: Math.round(slope * 100) / 100,
        month_gb_so_far: Math.round(monthGbSoFar * 10) / 10,
        forecast_month_gb: Math.round(forecastMonthGb * 10) / 10,
        balance: c.balance,
        currency: c.currency,
        runway_days: runwayDays,
        low_balance_alert: runwayDays !== null && runwayDays <= 7
      };
    }).sort((a, b) => (a.runway_days || 9999) - (b.runway_days || 9999));

    res.json({
      days,
      mskToday,
      days_left_in_month: daysLeftInMonth,
      forecasts
    });
  } catch (e) {
    logger.error('[traffic_forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3.5 Capacity planning
app.get('/api/analytics/capacity', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 180);
    const sinceExpr = `datetime('now', '-${days} days')`;

    // Per-server utilization
    const servers = db.prepare(`
      SELECT server_name,
             COUNT(DISTINCT nick) as modem_count,
             SUM(bytes_in + bytes_out) as total_bytes,
             AVG(bytes_in + bytes_out) as avg_hour_bytes,
             MAX(bytes_in + bytes_out) as max_hour_bytes,
             COUNT(DISTINCT substr(hour_start, 1, 10)) as active_days
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
      GROUP BY server_name
      ORDER BY total_bytes DESC
    `).all();

    // Modem count growth by month
    const modemGrowth = db.prepare(`
      SELECT substr(updated_at, 1, 7) as month,
             COUNT(DISTINCT imei) as modems
      FROM modem_meta
      GROUP BY month
      ORDER BY month
    `).all();

    // Overall totals
    const totals = db.prepare(`
      SELECT SUM(bytes_in + bytes_out) as total_bytes,
             COUNT(DISTINCT nick) as total_modems,
             COUNT(DISTINCT server_name) as total_servers
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
    `).get();

    const totalGb = totals.total_bytes ? totals.total_bytes / 1e9 : 0;
    const avgPerModem = totals.total_modems > 0 ? totalGb / totals.total_modems : 0;

    res.json({
      days,
      summary: {
        total_gb: Math.round(totalGb * 10) / 10,
        total_modems: totals.total_modems || 0,
        total_servers: totals.total_servers || 0,
        avg_gb_per_modem: Math.round(avgPerModem * 100) / 100,
      },
      servers: servers.map(s => ({
        server_name: s.server_name,
        modems: s.modem_count,
        total_gb: Math.round(s.total_bytes / 1e9 * 10) / 10,
        avg_hour_mb: Math.round(s.avg_hour_bytes / 1048576 * 10) / 10,
        max_hour_mb: Math.round(s.max_hour_bytes / 1048576 * 10) / 10,
        active_days: s.active_days,
        utilization_pct: s.max_hour_bytes > 0
          ? Math.round(s.avg_hour_bytes / s.max_hour_bytes * 100)
          : 0
      })),
      modem_growth: modemGrowth
    });
  } catch (e) {
    logger.error('[capacity]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3.6 System health dashboard
app.get('/api/admin/system_health', authMiddleware, adminMiddleware, (req, res) => {
  try {
    // Billing success 24h
    const billing24 = db.prepare(`
      SELECT level, COUNT(*) as c FROM system_log
      WHERE category = 'billing' AND timestamp >= datetime('now', '-1 day')
      GROUP BY level
    `).all();
    const billingByLevel = {};
    for (const r of billing24) billingByLevel[r.level] = r.c;

    // API error rate
    const apiErrors24 = db.prepare(`
      SELECT COUNT(*) as c FROM system_log
      WHERE category = 'api' AND level = 'error' AND timestamp >= datetime('now', '-1 day')
    `).get().c;

    // Per-day system_log errors for trend
    const errorsByDay = db.prepare(`
      SELECT substr(timestamp, 1, 10) as date,
             SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors,
             SUM(CASE WHEN level = 'warn'  THEN 1 ELSE 0 END) as warns
      FROM system_log
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY date
      ORDER BY date
    `).all();

    // DB size
    let dbSizeBytes = 0;
    try {
      const dbPath = path.join(__dirname, 'dashboard.db');
      if (fs.existsSync(dbPath)) dbSizeBytes = fs.statSync(dbPath).size;
    } catch (_) { /* best-effort: error intentionally swallowed */ }

    // Sessions
    const sessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE expires_at > datetime('now')").get().c;

    // Memory
    const memUsage = process.memoryUsage();

    // Recent critical events
    const recentCritical = db.prepare(`
      SELECT id, timestamp, level, category, action, target, message, details
      FROM system_log
      WHERE level IN ('error', 'warn')
      ORDER BY id DESC
      LIMIT 50
    `).all();

    // Per-server uptime (from uptime_tracking via live data)
    const serverStatus = apiServers.map(s => {
      const sc = SERVER_COUNTRIES[s.name] || {};
      return {
        name: s.name,
        country: sc.name || '',
        publicIp: s.publicIp || ''
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      billing_24h: billingByLevel,
      api_errors_24h: apiErrors24,
      errors_by_day: errorsByDay,
      db: {
        size_bytes: dbSizeBytes,
        size_mb: Math.round(dbSizeBytes / 1048576 * 10) / 10
      },
      sessions: sessionCount,
      memory: {
        rss_mb: Math.round(memUsage.rss / 1048576),
        heap_mb: Math.round(memUsage.heapUsed / 1048576),
        heap_total_mb: Math.round(memUsage.heapTotal / 1048576)
      },
      uptime_sec: Math.round(process.uptime()),
      recent_critical: recentCritical,
      servers: serverStatus
    });
  } catch (e) {
    logger.error('[system_health]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// PHASE 4 — SLA per client
// ============================================================================

// Compute SLA metrics for a single client.
// Uptime is measured over 30 days (contractual SLA horizon).
// Latency and error_pct use last 24 h (current service quality).
// Returns { uptime_pct, avg_latency_ms, error_pct, total_checks } or null if no data.
function computeClientSlaMetrics(client) {
  if (!client.portName) return null;
  // Latency + error rate (24 h)
  const checks = db.prepare(`
    SELECT AVG(total_ms) FILTER (WHERE error IS NULL) as avg_ms,
           COUNT(*) as total,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors
    FROM proxy_checks
    WHERE client_name = ? AND checked_at >= datetime('now', '-1 day')
  `).get(client.portName);

  // Uptime over 30 days — polling-based, aggregated across the client's modems.
  // Uses the same uptimeTracking source as the per-modem health score so all
  // dashboard uptime numbers are computed from one canonical signal (5-min
  // ping checks against ProxySmart). Replaces the old traffic-based formula
  // which inflated downtime whenever clients didn't transmit traffic.
  const UPTIME_DAYS = 30;
  const utCutoffDate = new Date(Date.now() - UPTIME_DAYS * 86400000).toISOString().slice(0, 10);

  // Find this client's modems (any that produced proxy_check rows in the window).
  // Includes the IMEI for the uptimeTracking lookup.
  const clientModems = db.prepare(`
    SELECT DISTINCT pc.server_name, pc.nick, COALESCE(mm.imei, '') as imei
    FROM proxy_checks pc
    LEFT JOIN modem_meta mm ON mm.server_name = pc.server_name AND mm.nick = pc.nick
    WHERE pc.client_name = ? AND pc.checked_at >= datetime('now', ?)
  `).all(client.portName, `-${UPTIME_DAYS} days`);

  let upOnline = 0, upTotal = 0;
  for (const mm of clientModems) {
    if (!mm.imei) continue;
    const ut = uptimeTracking[mm.server_name + '_' + mm.imei];
    if (!ut || !ut.daily) continue;
    for (const d in ut.daily) {
      if (d >= utCutoffDate) {
        upOnline += ut.daily[d].online || 0;
        upTotal  += ut.daily[d].total  || 0;
      }
    }
  }

  if (checks.total === 0 && upTotal === 0) return null;
  const uptimePct = upTotal > 0 ? Math.round(upOnline / upTotal * 1000) / 10 : null;
  const errorPct = checks.total > 0 ? Math.round(checks.errors / checks.total * 1000) / 10 : 0;
  return {
    uptime_pct: uptimePct,
    uptime_window_days: UPTIME_DAYS,
    uptime_online_checks: upOnline,
    uptime_total_checks: upTotal,
    avg_latency_ms: checks.avg_ms != null ? Math.round(checks.avg_ms) : null,
    error_pct: errorPct,
    total_checks: checks.total
  };
}

// Evaluate SLA, write violations to DB. Optionally auto-credit.
async function runSlaCheck() {
  try {
    const today = getMoscowToday();
    let violationsCount = 0, creditsCount = 0;
    const insertViolation = db.prepare(`INSERT INTO sla_violations
      (client_id, date, metric, expected, actual, credited_amount)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const existsStmt = db.prepare(`SELECT id FROM sla_violations WHERE client_id = ? AND date = ? AND metric = ?`);

    for (const client of clients) {
      if (!client.portName || !client.price) continue;
      const m = computeClientSlaMetrics(client);
      if (!m) continue;
      const breaches = [];
      if (m.uptime_pct != null && client.slaUptimePct != null && m.uptime_pct < client.slaUptimePct) {
        breaches.push({ metric: 'uptime', expected: client.slaUptimePct, actual: m.uptime_pct });
      }
      if (m.avg_latency_ms != null && client.slaMaxLatencyMs != null && m.avg_latency_ms > client.slaMaxLatencyMs) {
        breaches.push({ metric: 'latency', expected: client.slaMaxLatencyMs, actual: m.avg_latency_ms });
      }
      if (m.error_pct != null && client.slaMaxErrorPct != null && m.error_pct > client.slaMaxErrorPct) {
        breaches.push({ metric: 'errors', expected: client.slaMaxErrorPct, actual: m.error_pct });
      }
      for (const b of breaches) {
        // Skip if already logged today
        if (existsStmt.get(client.id, today, b.metric)) continue;
        // Auto-credit: 1% of daily rate per breach (per_gb only, cap at 10%)
        let credit = 0;
        if (client.slaAutoCredit && client.price > 0 && client.billingType === 'per_gb') {
          credit = Math.min(client.price * 0.01, client.price * 0.1);
          credit = Math.round(credit * 100) / 100;
          if (credit > 0) {
            try {
              atomicCredit(client.id, credit, {
                type: 'adjustment',
                date: today,
                timestamp: new Date().toISOString(),
                amount: credit,
                currency: client.currency || 'RUB',
                note: `SLA кредит: ${b.metric} ${b.actual} (норма ${b.expected})`,
                traffic_source: 'sla_auto'
              });
              creditsCount++;
            } catch (e) {
              logger.error(`[SLA] credit error for ${client.name}:`, e.message);
              credit = 0;
            }
          }
        }
        insertViolation.run(client.id, today, b.metric, b.expected, b.actual, credit);
        violationsCount++;
        logger.warn(`[SLA] ${client.name} breach: ${b.metric} actual=${b.actual} expected=${b.expected} credit=${credit}`);
      }
    }
    if (violationsCount > 0 || creditsCount > 0) {
      logActivity('system', 'warn', 'sla_check', null,
        `SLA check: ${violationsCount} breaches, ${creditsCount} credits applied`,
        { violations: violationsCount, credits: creditsCount, date: today });
    }
  } catch (e) {
    logger.error('[SLA]', e.message);
  }
}

// Endpoint: per-client SLA status
app.get('/api/admin/clients/:id/sla', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const client = clientById.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'not found' });
    const metrics = computeClientSlaMetrics(client);
    const violations = db.prepare(`
      SELECT * FROM sla_violations
      WHERE client_id = ?
      ORDER BY id DESC
      LIMIT 100
    `).all(client.id);
    const thresholds = {
      uptime_pct:    client.slaUptimePct    != null ? client.slaUptimePct    : 99,
      max_latency_ms: client.slaMaxLatencyMs != null ? client.slaMaxLatencyMs : 1000,
      max_error_pct: client.slaMaxErrorPct  != null ? client.slaMaxErrorPct  : 5,
      auto_credit:   !!client.slaAutoCredit
    };
    let status = 'ok';
    if (metrics) {
      if ((metrics.uptime_pct != null && metrics.uptime_pct < thresholds.uptime_pct) ||
          (metrics.avg_latency_ms != null && metrics.avg_latency_ms > thresholds.max_latency_ms) ||
          (metrics.error_pct != null && metrics.error_pct > thresholds.max_error_pct)) {
        status = 'breach';
      }
    }
    res.json({ client_id: client.id, status, metrics, thresholds, violations });
  } catch (e) {
    logger.error('[sla]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint: overall SLA status across all clients (for dashboard widget)
app.get('/api/admin/sla_overview', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const out = { ok: 0, breach: 0, no_data: 0, clients: [] };
    for (const client of clients) {
      if (!client.portName || !client.price) continue;
      const m = computeClientSlaMetrics(client);
      if (!m) { out.no_data++; continue; }
      const expected = {
        uptime: client.slaUptimePct    != null ? client.slaUptimePct    : 99,
        latency: client.slaMaxLatencyMs != null ? client.slaMaxLatencyMs : 1000,
        errors: client.slaMaxErrorPct  != null ? client.slaMaxErrorPct  : 5,
      };
      const breach =
        (m.uptime_pct     != null && m.uptime_pct     < expected.uptime) ||
        (m.avg_latency_ms != null && m.avg_latency_ms > expected.latency) ||
        (m.error_pct      != null && m.error_pct      > expected.errors);
      if (breach) out.breach++; else out.ok++;
      out.clients.push({
        id: client.id, name: client.name,
        status: breach ? 'breach' : 'ok',
        uptime_pct: m.uptime_pct, avg_latency_ms: m.avg_latency_ms, error_pct: m.error_pct,
        expected
      });
    }
    res.json(out);
  } catch (e) {
    logger.error('[sla_overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual proxy check (single or bulk)
app.post('/api/admin/proxy_check', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { modems } = req.body; // [{nick, server}] or single {nick, server}
    const list = Array.isArray(modems) ? modems : (req.body.nick ? [{ nick: req.body.nick, server: req.body.server }] : []);
    if (!list.length) return res.status(400).json({ error: 'No modems specified' });
    if (list.length > 50) return res.status(400).json({ error: 'Max 50 modems per request' });

    const results = await fetchAllServersDataCached();
    const nowIso = new Date().toISOString();

    // Build proxy map: nick+server → proxyUrl
    const proxyMap = {};
    for (const data of results) {
      const srv = data.serverName || '';
      const sc = SERVER_COUNTRIES[srv] || {};
      const serverIp = sc.serverIp || '';
      if (!serverIp) continue;
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const portsMap = data.ports || {};
      const modemInfo = {};
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        if (!imei) continue;
        modemInfo[imei] = { nick: md.NICK || imei, operator: normalizeOperator(m.net_details?.CELLOP, srv === 'S2' || srv.startsWith('S2')) };
      }
      for (const [imei, portList] of Object.entries(portsMap)) {
        const info = modemInfo[imei];
        if (!info) continue;
        for (const p of portList) {
          if (!p.HTTP_PORT || !p.LOGIN || !p.PASSWORD) continue;
          proxyMap[info.nick + '|' + srv] = {
            server: srv, nick: info.nick, client: p.portName || '', operator: info.operator || '',
            proxyUrl: `http://${p.LOGIN}:${p.PASSWORD}@${serverIp}:${p.HTTP_PORT}`,
          };
          break;
        }
      }
    }

    // Run checks
    const checks = [];
    for (const item of list) {
      const key = (item.nick || '') + '|' + (item.server || '');
      const proxy = proxyMap[key];
      if (!proxy) {
        checks.push({ nick: item.nick, server: item.server, error: 'Proxy not found' });
        continue;
      }
      // Unassigned proxies don't accept connections in ProxySmart.
      // Skip the actual check and return a clear explanation instead of
      // a misleading "connection refused" / "407" error.
      if (!proxy.client || !proxy.client.trim()) {
        checks.push({
          nick: proxy.nick, server: proxy.server, client: '',
          operator: proxy.operator, status_code: null, total_ms: null, connect_ms: null,
          error: 'Прокси не в аренде — присвойте portName клиенту, чтобы порт стал активным в ProxySmart'
        });
        continue;
      }
      const r = await curlCheckProxy(proxy.proxyUrl);
      const entry = { server: proxy.server, nick: proxy.nick, client: proxy.client, operator: proxy.operator, ...r };
      dbStmts.proxyCheckInsert.run(entry.server, entry.nick, entry.client, entry.operator || '', nowIso, entry.connect_ms, entry.total_ms, entry.status_code, entry.error);
      checks.push(entry);
    }

    res.json({ ok: true, checks });
  } catch (e) {
    logger.error('[ProxyCheck] Manual check error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

app.post('/api/admin/clients', authMiddleware, adminMiddleware, validate(ClientCreateSchema), async (req, res) => {
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

app.put('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  
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

// DELETE client -- with port protection
app.delete('/api/admin/clients/:id', authMiddleware, adminMiddleware, async (req, res) => {
  
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

app.post('/api/admin/clients/:id/payment', authMiddleware, adminMiddleware, validate(PaymentSchema), (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { amount, date, note } = req.body;
  if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return res.status(400).json({ error: 'Invalid amount: must be positive and reasonable' });
  }
  if (!client.payments) client.payments = [];

  const { balanceBefore, balanceAfter } = atomicCredit(client.id, parsedAmount, {
    type: 'payment',
    date: date,
    timestamp: new Date().toISOString(),
    amount: parsedAmount,
    currency: client.currency || 'RUB',
    note: note || 'Пополнение баланса'
  });

  // Push payment AFTER atomicCredit succeeds (МЕД-3)
  client.payments.push({ amount: parsedAmount, date, note: note || '', createdAt: new Date().toISOString() });

  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) {
      const commission = Math.round(parsedAmount * 0.15 * 100) / 100;
      referrer.referral_balance = Math.round(((referrer.referral_balance || 0) + commission) * 100) / 100;
      _clientUpdateReferralBalance.run(referrer.referral_balance, referrer.id);
      logger.info(`[Referral] Credited ${commission.toFixed(2)} to ${referrer.name} (15% of ${parsedAmount})`);
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

app.get('/api/admin/clients/:id/payments', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client.payments || []);
});

app.delete('/api/admin/clients/:id/payment/:index', authMiddleware, adminMiddleware, (req, res) => {
  
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
  client.payments.splice(payIdx, 1);

  
  
  const { balanceBefore, balanceAfter } = atomicDebit(client.id, deletedAmount, {
    type: 'payment_reversal',
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    amount: deletedAmount,
    currency: client.currency || 'RUB',
    note: 'Отмена оплаты администратором'
  });

  // Reverse referral commission (МЕД-4)
  if (client.referred_by) {
    const referrer = clientById.get(client.referred_by);
    if (referrer) {
      const commission = Math.round(deletedAmount * 0.15 * 100) / 100;
      referrer.referral_balance = Math.round(((referrer.referral_balance || 0) - commission) * 100) / 100;
      _clientUpdateReferralBalance.run(referrer.referral_balance, referrer.id);
      logger.info(`[Referral] Reversed ${commission.toFixed(2)} from ${referrer.name} (payment deletion)`);
    }
  }

  saveClients(clients);
  res.json({ ok: true, payments: client.payments, balance: client.balance });
});

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
    
    entries: entries.map(({ db_id, ...e }) => e),
    total: allEntries.length,
    limit,
    offset
  });
});

app.delete('/api/admin/clients/:id/ledger/:entryIndex', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const entries = billingLedger[client.id] || [];
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
  entries.splice(idx, 1);
  billingLedger[client.id] = entries;
  client.balance = newBalance;

  // saveBillingLedger() removed (КРИТ-3): _ledgerDeleteById already deleted atomically, full rewrite invalidates db_id
  logger.info(`[Ledger] Deleted entry #${idx} (${entry.type}) for client ${client.name}, recalculated balance: ${client.balance}`);
  auditLog(req.user.login, 'delete_ledger_entry', { clientId: client.id, clientName: client.name, entryType: entry.type, amount: entry.amount || entry.cost, ip: getClientIp(req) });
  res.json({ ok: true, newBalance: client.balance });
});

app.post('/api/admin/clients/:id/balance_adjust', authMiddleware, adminMiddleware, validate(BalanceAdjustSchema), (req, res) => {
  
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

app.get('/api/admin/billing/reconciliation', authMiddleware, adminMiddleware, async (req, res) => {
  const period = req.query.period || getMoscowToday().slice(0, 7); // "YYYY-MM"

  // Ensure portKey mapping is populated for matching dailyTraffic → clients
  if (Object.keys(portKeyToPortName).length === 0) {
    try {
      const cachedResults = await fetchAllServersDataCached();
      refreshPortKeyMapping(cachedResults);
    } catch (e) { logger.warn('[Reconciliation] Failed to refresh port mapping:', e.message); }
  }

  const results = [];

  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) continue;

    // Sum stored daily_traffic bytes for this month
    const storedBytes = getClientStoredMonthBytes(client.portName, period);
    const storedGb = trafficBytesToGb(storedBytes);

    // Sum ledger charges for this month
    const entries = billingLedger[client.id] || [];
    const monthCharges = entries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
    const billedGb = Math.round(monthCharges.reduce((s, e) => s + (e.delta_gb || 0), 0) * 1000) / 1000;
    const billedCost = Math.round(monthCharges.reduce((s, e) => s + ledgerExpense(e), 0) * 100) / 100;

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
    const missingDays = [...trafficDays].filter(d => !billingDays.has(d)).sort((a, b) => a.localeCompare(b));

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

app.post('/api/admin/clients/:id/document', authMiddleware, adminMiddleware, async (req, res) => {
  
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

app.delete('/api/admin/clients/:id/document/:docId', authMiddleware, adminMiddleware, (req, res) => {
  
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
  saveClients(clients);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/regenerate_key', authMiddleware, adminMiddleware, (req, res) => {
  
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  client.apiKey = 'prx_' + crypto.randomBytes(24).toString('hex');
  saveClients(clients);
  res.json({ ok: true, apiKey: client.apiKey });
});

app.get('/api/admin/audit_log', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const total = dbStmts.countAuditLog.get().cnt;
  const rows = dbStmts.getAuditLog.all(limit, offset);
  // Parse details JSON back to object for frontend
  const entries = rows.map(r => {
    let details = {};
    try { details = JSON.parse(r.details || '{}'); } catch (_) { /* best-effort: error intentionally swallowed */ }
    return { timestamp: r.timestamp, admin: r.admin, action: r.action, ...details };
  });
  res.json({ total, offset, limit, entries });
});

// CRM translate endpoint removed — translations applied directly to DB

// API Servers management
app.get('/api/admin/servers', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ servers: apiServers.map(s => ({
    name: s.name, url: s.url, publicIp: s.publicIp,
    country: SERVER_COUNTRIES[s.name] || {},
    panelUser: s.user || '', panelPassword: s.pass || '',
    osLogin: s.osLogin || '', osPassword: s.osPassword || '',
    hardware: s.hardware || '', address: s.address || ''
  })) });
});

app.patch('/api/admin/servers/:name', authMiddleware, adminMiddleware, async (req, res) => {
  const srv = apiServers.find(s => s.name === req.params.name);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const { osLogin, osPassword, hardware, address, panelUser, panelPassword } = req.body;
  if (osLogin     !== undefined) srv.osLogin    = osLogin;
  if (osPassword  !== undefined) srv.osPassword = osPassword;
  if (hardware    !== undefined) srv.hardware   = hardware;
  if (address     !== undefined) srv.address    = address;

  // Panel credentials change → validate against ProxySmart before persisting,
  // otherwise we can lock ourselves out of the server with a typo.
  if (panelUser !== undefined || panelPassword !== undefined) {
    const candidate = {
      ...srv,
      user: panelUser !== undefined ? String(panelUser).trim() || 'proxy' : srv.user,
      pass: panelPassword !== undefined ? String(panelPassword) : srv.pass
    };
    if (!candidate.user || !candidate.pass) {
      return res.status(400).json({ error: 'panel user and password cannot be empty' });
    }
    try {
      await fetchApi(candidate, '/apix/show_status_json', 8000);
    } catch (e) {
      return res.status(502).json({ error: 'Panel auth failed — credentials not saved', details: e.message });
    }
    srv.user = candidate.user;
    srv.pass = candidate.pass;
    proxySmart.invalidateCache();
  }

  saveApiServersToDb();
  auditLog(req.user.login, 'update_server', { name: req.params.name, fields: Object.keys(req.body || {}), ip: getClientIp(req) });
  res.json({ ok: true });
});

app.post('/api/admin/servers', authMiddleware, adminMiddleware, async (req, res) => {
  const { name, url, user, pass, publicIp, country, countryName, tz } = req.body;
  if (!name || !url || !user || !pass) return res.status(400).json({ error: 'name, url, user, pass required' });
  if (apiServers.find(s => s.name === name)) return res.status(409).json({ error: 'Server name already exists' });
  // Test connectivity
  try {
    const testServer = { name, url, user, pass, publicIp: publicIp || new URL(url).hostname, country: country || '', countryName: countryName || name, tz: tz || 'Europe/Moscow' };
    const status = await fetchApi(testServer, '/apix/show_status_json', 10000);
    const modemCount = Array.isArray(status) ? status.length : 0;
    // Add to runtime
    apiServers.push(testServer);
    SERVER_COUNTRIES[name] = { country: testServer.country, name: testServer.countryName, tz: testServer.tz, serverIp: testServer.publicIp };
    // Save to DB (not .env)
    saveApiServersToDb();
    auditLog(req.user.login, 'add_server', { name, url, modemCount, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true, modemCount });
  } catch (e) {
    res.status(502).json({ error: 'Server unreachable', details: e.message });
  }
});

app.delete('/api/admin/servers/:name', authMiddleware, adminMiddleware, (req, res) => {
  const idx = apiServers.findIndex(s => s.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });
  apiServers.splice(idx, 1);
  delete SERVER_COUNTRIES[req.params.name];
  saveApiServersToDb();
  proxySmart.invalidateCache();
  auditLog(req.user.login, 'delete_server', { name: req.params.name, ip: getClientIp(req) });
  res.json({ ok: true });
});

app.get('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  res.json(appSettings);
});

app.put('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
  const { speedtest_times, pricing_tiers, min_speed_threshold, proxy_check_target, proxy_check_warn_ms, proxy_check_bad_ms } = req.body;
  if (speedtest_times && Array.isArray(speedtest_times)) {
    appSettings.speedtest_times = speedtest_times.filter(t => /^\d{2}:\d{2}$/.test(t));
  }
  if (min_speed_threshold != null) {
    appSettings.min_speed_threshold = parseFloat(min_speed_threshold) || 2;
  }
  if (req.body.error_rate_threshold != null) {
    appSettings.error_rate_threshold = Math.max(1, Math.min(100, parseInt(req.body.error_rate_threshold) || 15));
  }
  if (req.body.proxy_alert_latency_ms != null) {
    appSettings.proxy_alert_latency_ms = Math.max(100, Math.min(60000, parseInt(req.body.proxy_alert_latency_ms) || 1500));
  }
  if (req.body.proxy_alert_error_pct != null) {
    appSettings.proxy_alert_error_pct = Math.max(0, Math.min(100, parseFloat(req.body.proxy_alert_error_pct) || 5));
  }
  if (req.body.proxy_alert_window_min != null) {
    appSettings.proxy_alert_window_min = Math.max(5, Math.min(720, parseInt(req.body.proxy_alert_window_min) || 60));
  }
  if (req.body.auto_reboot_enabled != null) {
    appSettings.auto_reboot_enabled = !!req.body.auto_reboot_enabled;
  }
  if (req.body.auto_reboot_min_interval_min != null) {
    appSettings.auto_reboot_min_interval_min = Math.max(15, Math.min(720, parseInt(req.body.auto_reboot_min_interval_min) || 60));
  }
  if (pricing_tiers && Array.isArray(pricing_tiers)) {
    appSettings.pricing_tiers = pricing_tiers.map(t => ({
      min_proxies: parseInt(t.min_proxies) || 1,
      price: parseFloat(t.price) || 0,
      label: t.label || ''
    }));
  }
  if (proxy_check_target != null) {
    const url = String(proxy_check_target).trim();
    // SSRF-defense: reject internal/loopback/metadata hosts. proxy_check_target
    // is fed to curl from each ProxySmart server, so a malicious admin could
    // pivot to internal services on those machines (or use server as a probe).
    let ok = false;
    if (url && /^https?:\/\/.+/.test(url)) {
      try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const bad = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|169\.254\.|::1$|fc00:|fe80:|metadata\.)/i;
        if (!bad.test(host) && !/^\d+$/.test(host) && host !== '0.0.0.0') ok = true;
      } catch (_) { ok = false; }
    }
    if (ok) appSettings.proxy_check_target = url;
    else return res.status(400).json({ error: 'proxy_check_target rejected (internal/loopback/metadata host)' });
  }
  if (proxy_check_warn_ms != null) {
    appSettings.proxy_check_warn_ms = Math.max(50, parseInt(proxy_check_warn_ms) || 500);
  }
  if (proxy_check_bad_ms != null) {
    appSettings.proxy_check_bad_ms = Math.max(100, parseInt(proxy_check_bad_ms) || 2000);
  }
  if (req.body.proxy_check_interval_min != null) {
    appSettings.proxy_check_interval_min = Math.max(5, Math.min(1440, parseInt(req.body.proxy_check_interval_min) || 60));
    rescheduleProxyCheck();
  }
  // Auto-recovery
  if (req.body.recovery_offline_sec != null) appSettings.recovery_offline_sec = Math.max(10, Math.min(600, parseInt(req.body.recovery_offline_sec) || 60));
  if (req.body.recovery_max_attempts != null) appSettings.recovery_max_attempts = Math.max(1, Math.min(10, parseInt(req.body.recovery_max_attempts) || 3));
  if (req.body.recovery_retry_min != null) appSettings.recovery_retry_min = Math.max(1, Math.min(60, parseInt(req.body.recovery_retry_min) || 3));
  // Modem tracking & rotation
  if (req.body.tracking_interval_min != null) appSettings.tracking_interval_min = Math.max(1, Math.min(30, parseInt(req.body.tracking_interval_min) || 3));
  if (req.body.rotation_cache_ttl_min != null) appSettings.rotation_cache_ttl_min = Math.max(5, Math.min(240, parseInt(req.body.rotation_cache_ttl_min) || 30));
  if (req.body.rotation_sync_interval_min != null) appSettings.rotation_sync_interval_min = Math.max(5, Math.min(240, parseInt(req.body.rotation_sync_interval_min) || 30));
  // Proxy check (additional)
  if (req.body.proxy_check_timeout_sec != null) appSettings.proxy_check_timeout_sec = Math.max(5, Math.min(120, parseInt(req.body.proxy_check_timeout_sec) || 15));
  if (req.body.proxy_check_concurrency != null) appSettings.proxy_check_concurrency = Math.max(1, Math.min(50, parseInt(req.body.proxy_check_concurrency) || 10));
  // Speedtest (additional)
  if (req.body.speedtest_low_threshold != null) appSettings.speedtest_low_threshold = Math.max(0.1, Math.min(50, parseFloat(req.body.speedtest_low_threshold) || 1));
  if (req.body.speedtest_retest_delay_min != null) appSettings.speedtest_retest_delay_min = Math.max(1, Math.min(120, parseInt(req.body.speedtest_retest_delay_min) || 10));
  if (req.body.speedtest_max_history != null) appSettings.speedtest_max_history = Math.max(5, Math.min(200, parseInt(req.body.speedtest_max_history) || 30));
  // Data retention (days)
  if (req.body.retention_traffic_hourly != null) appSettings.retention_traffic_hourly = Math.max(7, Math.min(365, parseInt(req.body.retention_traffic_hourly) || 90));
  if (req.body.retention_daily_traffic != null) appSettings.retention_daily_traffic = Math.max(7, Math.min(365, parseInt(req.body.retention_daily_traffic) || 90));
  if (req.body.retention_api_usage != null) appSettings.retention_api_usage = Math.max(7, Math.min(365, parseInt(req.body.retention_api_usage) || 30));
  if (req.body.retention_audit_log != null) appSettings.retention_audit_log = Math.max(7, Math.min(365, parseInt(req.body.retention_audit_log) || 90));
  if (req.body.retention_system_log != null) appSettings.retention_system_log = Math.max(7, Math.min(365, parseInt(req.body.retention_system_log) || 30));
  if (req.body.retention_rotation_log != null) appSettings.retention_rotation_log = Math.max(7, Math.min(365, parseInt(req.body.retention_rotation_log) || 90));
  if (req.body.retention_proxy_checks != null) appSettings.retention_proxy_checks = Math.max(7, Math.min(365, parseInt(req.body.retention_proxy_checks) || 30));
  if (req.body.retention_modem_meta != null) appSettings.retention_modem_meta = Math.max(7, Math.min(365, parseInt(req.body.retention_modem_meta) || 30));
  // Session & billing
  if (req.body.session_ttl_days != null) appSettings.session_ttl_days = Math.max(1, Math.min(365, parseInt(req.body.session_ttl_days) || 30));
  if (req.body.billing_retry_delay_hours != null) appSettings.billing_retry_delay_hours = Math.max(0.5, Math.min(24, parseFloat(req.body.billing_retry_delay_hours) || 1));
  if (req.body.reconciliation_tolerance_gb != null) appSettings.reconciliation_tolerance_gb = Math.max(0.001, Math.min(1, parseFloat(req.body.reconciliation_tolerance_gb) || 0.01));
  // CRM & auto-create
  if (req.body.auto_create_interval_min != null) appSettings.auto_create_interval_min = Math.max(1, Math.min(60, parseInt(req.body.auto_create_interval_min) || 10));
  if (req.body.crm_check_interval_min != null) appSettings.crm_check_interval_min = Math.max(5, Math.min(120, parseInt(req.body.crm_check_interval_min) || 10));
  if (req.body.crm_reminder_days != null) appSettings.crm_reminder_days = Math.max(1, Math.min(30, parseInt(req.body.crm_reminder_days) || 3));
  // Telegram daily summary
  if (req.body.telegram_bot_token != null) appSettings.telegram_bot_token = String(req.body.telegram_bot_token).trim();
  if (req.body.telegram_chat_id != null) appSettings.telegram_chat_id = String(req.body.telegram_chat_id).trim();
  if (req.body.telegram_summary_enabled != null) appSettings.telegram_summary_enabled = !!req.body.telegram_summary_enabled;
  if (req.body.telegram_summary_time != null) {
    const t = String(req.body.telegram_summary_time);
    if (/^\d{2}:\d{2}$/.test(t)) appSettings.telegram_summary_time = t;
  }

  saveSettings();
  rescheduleSpeedtests();
  res.json({ ok: true, settings: appSettings });
});

// Send a test telegram summary for an arbitrary date (default = yesterday MSK).
// Telegram + AI insights + CRM moved into src/routes/telegram-crm.js (Stage 3).
app.use(require('./src/routes/telegram-crm')({
  logger, authMiddleware, adminMiddleware,
  tgBot, tgSummary, aiInsights,
  getAppSettings: () => appSettings,
}));

// Shared handler for modem control actions (reduces duplication)
async function _modemAction(req, res, paramName, apiPathFn, errorLabel) {
  try {
    const paramVal = req.body[paramName];
    const { serverName } = req.body;
    if (!paramVal || !serverName) return res.status(400).json({ error: `${paramName} and serverName required` });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, apiPathFn(paramVal));
    return res.json({ ok: true, result });
  } catch (err) { return res.status(502).json({ error: `${errorLabel} failed`, details: err.message }); }
}

app.post('/api/admin/reset_ip', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reset_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reset'));

app.post('/api/admin/reboot', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'imei', v => `/apix/reboot_modem_by_imei?IMEI=${encodeURIComponent(v)}`, 'Reboot'));

app.post('/api/admin/usb_reset', authMiddleware, adminMiddleware, (req, res) =>
  _modemAction(req, res, 'nick', v => `/apix/usb_reset_modem_json?arg=${encodeURIComponent(v)}`, 'USB reset'));

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
    logger.info(`[Admin] Server ${serverName} reboot requested`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Reboot server failed', details: err.message }); }
});

// Restart the dashboard process (pm2 will auto-restart)
app.post('/api/admin/restart_dashboard', authMiddleware, adminMiddleware, (req, res) => {
  logger.info(`[Admin] Dashboard restart requested by ${req.user.login}`);
  logActivity('admin', 'warn', 'dashboard_restart', null, `Dashboard restart requested by ${req.user.login}`);
  res.json({ ok: true, message: 'Restarting...' });
  setTimeout(() => process.exit(0), 500);
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
    logger.info(`[Admin] Reset complete on ${serverName}: ${resetCount}/${modems.length} modems`);
    res.json({ ok: true, total: modems.length, reset: resetCount });
  } catch (err) { res.status(502).json({ error: 'Reset complete failed', details: err.message }); }
});

app.post('/api/admin/store_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...modemData } = req.body;
    if (!serverName || !modemData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Strip server prefix from IMEI (e.g. "S2_012345" → "012345")
    const rawImei = modemData.IMEI.replace(/^S\d+_/, '');
    modemData.IMEI = rawImei;
    // First GET current config to preserve existing fields
    const confHtml = await fetchApiRaw(server, `/conf/edit/${rawImei}`);
    const html = confHtml.buffer ? confHtml.buffer.toString('utf8') : String(confHtml);
    const currentFields = {};
    const fieldMatches = html.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g);
    for (const fm of fieldMatches) currentFields[fm[1]] = fm[2];
    // Merge: user changes override current values, keep rest
    const merged = { ...currentFields, ...modemData };
    // Remove empty values that were not in original
    for (const k of Object.keys(merged)) {
      if (merged[k] === '' && currentFields[k]) merged[k] = currentFields[k];
    }
    logger.info({ merged, rawImei, serverName }, '[StoreModem] Sending to ProxySmart');
    const result = await postFormApi(server, `/conf/edit/${rawImei}`, merged);
    logger.info({ status: result.status }, '[StoreModem] Response');
    auditLog(req.user.login, 'store_modem', { serverName, IMEI: rawImei, ip: getClientIp(req) });
    // Update rotation cache immediately so dashboard reflects the change
    const newRot = parseInt(modemData.AUTO_IP_ROTATION) || 0;
    modemRotationCache[serverName + ':' + rawImei] = newRot;
    proxySmart.invalidateCache(); // invalidate data cache
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Store modem failed', details: err.message }); }
});

app.post('/api/admin/apply_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { serverName, imei } = req.body;
    if (!serverName || !imei) return res.status(400).json({ error: 'serverName and imei required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Strip server prefix from IMEI
    imei = imei.replace(/^S\d+_/, '');
    const result = await postFormApi(server, '/modem/settings', { imei });
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Apply modem failed', details: err.message }); }
});

// Changes portName on ProxySmart server via form POST to /conf/edit_port/{portID}
function postFormApi(server, apiPath, formData, timeout = 15000) {
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
      timeout
    }, (proxyRes) => {
      let data = '';
      let bytes = 0;
      proxyRes.on('data', chunk => {
        bytes += chunk.length;
        // Cap response body at 256 KB — protect against runaway HTML
        if (bytes <= 256 * 1024) data += chunk;
      });
      proxyRes.on('end', () => {
        // ProxySmart returns 302 redirects on successful form submission — keep them.
        // 4xx/5xx = real failure that callers must see (was silently swallowed before).
        if (proxyRes.statusCode >= 400) {
          reject(new Error(`HTTP ${proxyRes.statusCode} from ${server.name}: ${data.slice(0, 200)}`));
          return;
        }
        resolve({ status: proxyRes.statusCode, raw: data.slice(0, 1024) });
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout from ' + server.name)); });
    req.write(postData);
    req.end();
  });
}

// Tolerant <input name="..." value="..."> parser — handles either attribute
// order, multi-line tags, single/double quotes, and self-closing slashes.
// Returns plain object { name: value, ... }.
function parseHtmlInputFields(html) {
  const fields = {};
  if (!html) return fields;
  const inputRe = /<input\b[^>]*?>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameMatch  = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const valueMatch = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (nameMatch && valueMatch !== null) {
      fields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }
  // <select> with selected <option> — keep selected value
  const selectRe = /<select\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html)) !== null) {
    const name = m[1], body = m[2];
    const selOpt = body.match(/<option\b[^>]*\bselected\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i)
                || body.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bselected\b/i);
    if (selOpt) {
      fields[name] = selOpt[1];
    } else {
      const first = body.match(/<option\b[^>]*\bvalue\s*=\s*["']([^"']*)["']/i);
      if (first) fields[name] = first[1];
    }
  }
  // <textarea name="...">body</textarea>
  const textareaRe = /<textarea\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = textareaRe.exec(html)) !== null) {
    fields[m[1]] = m[2].trim();
  }
  return fields;
}

app.post('/api/admin/assign_modem', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newPortName } = req.body;
    if (!serverName || !portID || !newPortName) return res.status(400).json({ error: 'serverName, portID, newPortName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    // Read full current form to preserve ALL required fields
    const editPageRaw = await fetchApiRaw(server, `/conf/edit_port/${portID}`);
    const editHtml = editPageRaw?.buffer ? editPageRaw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(editHtml);
    // Get proxy_password from port API data (not in HTML form)
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portID && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore */ }
    }
    // Apply the rename
    formData.portName = newPortName;

    const result = await postFormApi(server, `/conf/edit_port/${portID}`, formData);
    logger.info(`[AssignModem] Assigned port ${portID} to "${newPortName}" on ${serverName}`);
    // Invalidate cache so changes appear immediately
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'assign_modem', { serverName, portID, newPortName, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[AssignModem] Error:', err.message);
    res.status(502).json({ error: 'Failed to assign modem', details: err.message });
  }
});

app.get('/api/admin/available_modems', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await fetchAllServersDataCached();
    const available = [];
    for (const data of results) {
      const srvName = data.serverName || '';
      const ports = data.ports || {};
      const status = Array.isArray(data.status) ? data.status : [];
      const modemMap = {};
      status.forEach(m => { const imei = m.modem_details?.IMEI; if (imei) modemMap[imei] = m; });
      for (const imei of Object.keys(ports)) {
        const modemPorts = ports[imei];
        const modem = modemMap[imei];
        const nick = modem?.modem_details?.NICK || imei;
        modemPorts.forEach(p => {
          available.push({
            server: srvName,
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
      try { _rlUpsert.run(serverName, nick, oldIp, newIp, start, end, took, attempt); inserted++; } catch(dupErr) { if (!dupErr.message.includes('UNIQUE')) logger.error('[SyncRotationLog] Insert error:', dupErr.message); }
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
      logger.info(`[RotationLog] ProxySmart fetch failed for ${nick}@${serverName}: ${fetchErr.message}, serving from DB`);
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

app.post('/api/admin/store_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, ...portData } = req.body;
    if (!serverName || !portData.IMEI) return res.status(400).json({ error: 'serverName and IMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const rawImei = portData.IMEI.replace(/^S\d+_/, '');
    if (portData.portName && portData.portName.length < 4) return res.status(400).json({ error: 'portName must be at least 4 characters' });
    // GET pre-filled form values from ProxySmart (portID, http_port, login, password)
    const formHtml = await fetchApiRaw(server, `/conf/add_port?imei=${rawImei}`);
    const html = formHtml.buffer ? formHtml.buffer.toString('utf8') : String(formHtml);
    const prefilled = parseHtmlInputFields(html);

    // Sanity check — without portID and http_port the form will fail server-side
    if (!prefilled.portID) {
      return res.status(502).json({ error: 'ProxySmart add_port form returned no portID', html_snippet: html.slice(0, 300) });
    }

    // Merge: user values override pre-filled, but only for fields the form supports.
    // portID/proxy_login/proxy_password generated by ProxySmart are used as-is unless user supplied a value.
    const formData = { ...prefilled };
    if (portData.portName) formData.portName = portData.portName;
    if (portData.http_port  && prefilled.http_port  !== undefined) formData.http_port  = portData.http_port;
    if (portData.socks_port && prefilled.socks_port !== undefined) formData.socks_port = portData.socks_port;
    if (portData.proxy_login    && prefilled.proxy_login    !== undefined) formData.proxy_login    = portData.proxy_login;
    if (portData.proxy_password && prefilled.proxy_password !== undefined) formData.proxy_password = portData.proxy_password;

    const actualPortId = formData.portID;

    // Submit the form. postFormApi now rejects on HTTP 4xx/5xx (was silently
    // swallowing failures before).
    await postFormApi(server, `/conf/add_port?imei=${rawImei}`, formData);

    // Auto-apply the new port. Previously the frontend had to make a second
    // request, but it was passing the client-side generated portID instead of
    // the one ProxySmart actually used → apply_port always 404'd → port was
    // created but never activated. Doing it here uses the authoritative ID.
    let applied = false;
    try {
      await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(actualPortId)}`);
      applied = true;
    } catch (e) {
      logger.warn(`[store_port] apply_port failed for ${actualPortId}: ${e.message}`);
    }

    proxySmart.invalidateCache();
    auditLog(req.user.login, 'store_port', { serverName, IMEI: rawImei, portName: portData.portName, portId: actualPortId, applied, ip: getClientIp(req) });
    logActivity('modem', 'info', 'port_created', portData.portName || actualPortId, `Port created on ${serverName}/${rawImei} (id=${actualPortId})`, { applied });
    res.json({ ok: true, portId: actualPortId, applied });
  } catch (err) {
    logger.error('[store_port] ' + err.message);
    res.status(502).json({ error: 'Store port failed', details: err.message });
  }
});

// Move port to a different modem (change IMEI assignment)
app.post('/api/admin/move_port', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName, portID, newIMEI } = req.body;
    if (!serverName || !portID || !newIMEI) return res.status(400).json({ error: 'serverName, portID, newIMEI required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    // Read full current port form
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portID}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(html);
    // Get proxy_password from port API
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portID && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore */ }
    }
    // Change IMEI to move port to new modem
    formData.IMEI = newIMEI;
    await postFormApi(server, `/conf/edit_port/${portID}`, formData);
    // Re-apply so ProxySmart picks up the new IMEI binding
    try { await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portID)}`); }
    catch (e) { logger.warn(`[move_port] apply_port failed for ${portID}: ${e.message}`); }
    auditLog(req.user.login, 'move_port', { serverName, portID, newIMEI, ip: getClientIp(req) });
    proxySmart.invalidateCache();
    res.json({ ok: true });
  } catch (err) { res.status(502).json({ error: 'Move port failed', details: err.message }); }
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
      const sel = block.match(/<option[^>]*selected[^>]*value\s*=\s*"([^"]*)"/);
      if (sel) return sel[1];
      const sel2 = block.match(/<option[^>]*value\s*=\s*"([^"]*)"[^>]*selected/);
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
      OS: extractSelected('OS'),
      IP_MODE: extractSelected('IP_MODE'),
    });
  } catch (err) {
    logger.error('[GetPortConfig]', err.message);
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
    // Read full current form to preserve ALL required fields
    const raw = await fetchApiRaw(server, `/conf/edit_port/${portId}`);
    const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
    const formData = parseHtmlInputFields(html);
    // Get proxy_password from port API data (not in HTML form)
    if (!formData.proxy_password) {
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
          }
          if (formData.proxy_password) break;
        }
      } catch (e) { /* ignore — password may already be in fields */ }
    }
    // Merge user changes on top of current values
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'OS_SPOOF') formData.OS = v; // Map dashboard → ProxySmart field names
      else if (k === 'IP_VERSION') formData.IP_MODE = v;
      else formData[k] = v;
    }
    // Remove internal fields not needed by ProxySmart form
    delete formData.serverName; delete formData.OS_SPOOF; delete formData.IP_VERSION;
    const result = await postFormApi(server, `/conf/edit_port/${portId}`, formData);
    // Apply the port changes
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'save_port_config', { serverName, portId, fields: Object.keys(fields), ip: getClientIp(req) });
    const success = result.status === 302 || result.status === 200;
    res.json({ ok: success, status: result.status });
  } catch (err) {
    logger.error('[SavePortConfig]', err.message);
    res.status(502).json({ error: 'Save port config failed', details: err.message });
  }
});

// Bulk set OS spoofing on multiple ports
// Bulk set OS spoofing on multiple ports
app.post('/api/admin/bulk_os_spoof', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { ports, os } = req.body;
    if (!Array.isArray(ports) || !ports.length) return res.status(400).json({ error: 'ports array required' });
    // Pre-fetch passwords per server (cache list_ports_json once per server)
    const pwCache = {};
    const serverNames = [...new Set(ports.map(p => p.serverName))];
    for (const sn of serverNames) {
      const server = findServer(sn);
      if (!server) continue;
      try {
        const portsData = await fetchApi(server, '/apix/list_ports_json');
        pwCache[sn] = {};
        for (const [, plist] of Object.entries(portsData)) {
          for (const port of plist) {
            if (port.portID && port.PASSWORD) pwCache[sn][port.portID] = port.PASSWORD;
          }
        }
      } catch (e) { logger.warn(`[BulkOS] Failed to fetch ports for ${sn}: ${e.message}`); }
    }
    let ok = 0, failed = 0;
    for (const p of ports) {
      try {
        const server = findServer(p.serverName);
        if (!server) { failed++; continue; }
        const raw = await fetchApiRaw(server, `/conf/edit_port/${p.portId}`);
        const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
        const fields = parseHtmlInputFields(html);
        // Password from pre-fetched cache
        const pw = (pwCache[p.serverName] || {})[p.portId];
        if (pw) fields.proxy_password = pw;
        fields.OS = os || '';
        const result = await postFormApi(server, `/conf/edit_port/${p.portId}`, fields);
        if (result.status === 302 || result.status === 200) ok++;
        else failed++;
      } catch (e) { failed++; }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_os_spoof', { os, count: ports.length, ok, failed, ip: getClientIp(req) });
    res.json({ ok: true, updated: ok, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk set auto-rotation on multiple modems
app.post('/api/admin/bulk_rotation', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { modems, rotation } = req.body;
    if (!Array.isArray(modems) || !modems.length) return res.status(400).json({ error: 'modems array required' });
    const rotVal = String(rotation != null ? rotation : 10);
    let ok = 0, failed = 0;
    for (const m of modems) {
      try {
        const server = findServer(m.serverName);
        if (!server) { failed++; continue; }
        const raw = await fetchApiRaw(server, `/conf/edit/${m.imei}`);
        const html = raw?.buffer ? raw.buffer.toString('utf8') : '';
        const fields = parseHtmlInputFields(html);
        fields.AUTO_IP_ROTATION = rotVal;
        await postFormApi(server, `/conf/edit/${m.imei}`, fields);
        modemRotationCache[m.serverName + ':' + m.imei] = parseInt(rotVal) || 0;
        ok++;
      } catch (e) { failed++; }
    }
    proxySmart.invalidateCache();
    auditLog(req.user.login, 'bulk_rotation', { rotation: rotVal, count: modems.length, ok, failed, ip: getClientIp(req) });
    res.json({ ok: true, updated: ok, failed });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    logger.info(`[Admin] Deleted port ${portId} from ${serverName} via ProxySmart`);
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

  const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|0\.|169\.254\.|fc|fd)/;
  async function checkOneProxy(proxy) {
    if (PRIVATE_IP_RE.test(proxy.ip)) {
      return { ip: proxy.ip, port: proxy.port, working: false, error: 'Private IP not allowed' };
    }
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
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', (err) => { sock.removeAllListeners(); sock.destroy(); reject(err); });
        sock.once('timeout', () => { sock.removeAllListeners(); sock.destroy(); reject(new Error('Timeout')); });
        try { sock.connect(parseInt(proxy.port), proxy.ip); } catch (e) { sock.destroy(); reject(e); }
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

let topHostsCache = { data: {}, perPort: {}, updatedAt: null };
try {
  const row = _kvGet.get('top_hosts_cache');
  if (row) {
    topHostsCache = JSON.parse(row.value);
    if (!topHostsCache.perPort) topHostsCache.perPort = {};
  } else {
    // One-time migration from top_hosts_cache.json
    const TOP_HOSTS_CACHE_FILE = path.join(__dirname, 'top_hosts_cache.json');
    if (fs.existsSync(TOP_HOSTS_CACHE_FILE)) {
      topHostsCache = JSON.parse(fs.readFileSync(TOP_HOSTS_CACHE_FILE, 'utf8'));
      if (!topHostsCache.perPort) topHostsCache.perPort = {};
      _kvSet.run('top_hosts_cache', JSON.stringify(topHostsCache));
      logger.info('[TopHosts] Migrated from top_hosts_cache.json to SQLite');
    }
  }
} catch (e) { logger.error('Failed to load top_hosts cache:', e.message); }

async function aggregateTopHosts() {
  logger.info('[TopHosts] Starting aggregation...');
  const merged = {};
  const perPort = {};
  const detailRows = []; // [server_name, port_id, nick, client_name, operator, country, host, count]
  let fetchedCount = 0;
  let errorCount = 0;

  for (const server of apiServers) {
    const srvCountry = (SERVER_COUNTRIES[server.name] || {}).country || '';
    const isRO = srvCountry === 'RO';
    try {
      const [portsResult, bwResult, statusResult] = await Promise.all([
        fetchApi(server, '/apix/list_ports_json'),
        fetchApi(server, '/apix/bandwidth_report_all'),
        fetchApi(server, '/apix/show_status_json').catch(() => null)
      ]);

      const portNameMap = {};
      if (bwResult && typeof bwResult === 'object') {
        for (const [portId, b] of Object.entries(bwResult)) {
          if (b.portName) portNameMap[portId] = b.portName;
        }
      }

      // portId → {nick, operator} from status
      const portIdInfo = {};
      const statusArr = Array.isArray(statusResult) ? statusResult : [];
      let portsMap = {};
      if (portsResult && typeof portsResult === 'object' && !portsResult.raw) portsMap = portsResult;
      else if (portsResult && portsResult.raw) { try { portsMap = JSON.parse(portsResult.raw); } catch (_) { /* best-effort: error intentionally swallowed */ } }

      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI || '';
        const nick = md.NICK || imei;
        const rawOp = ((m.net_details || {}).CELLOP || md.OPERATOR || '').toLowerCase().trim();
        const op = normalizeOperator(rawOp, isRO);
        const ports = portsMap[imei] || [];
        for (const p of ports) if (p.portID) portIdInfo[p.portID] = { nick, operator: op };
      }

      const portIds = [];
      for (const imei in portsMap) {
        if (imei === 'raw' || imei === '_server') continue;
        const ports = portsMap[imei];
        if (Array.isArray(ports)) ports.forEach(p => { if (p.portID) portIds.push(p.portID); });
      }
      logger.info(`[TopHosts] ${server.name}: found ${portIds.length} ports to scan`);

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

            const portName = portNameMap[portId] || '';
            const info = portIdInfo[portId] || {};
            const nick = info.nick || portId;
            const op = info.operator || '';
            const fullPortId = server.name + '_' + portId;

            entries.forEach(e => {
              const h = e.host || e.domain || 'unknown';
              const count = e.count || e.requests || 1;
              merged[h] = (merged[h] || 0) + count;
              if (portName) {
                if (!perPort[portName]) perPort[portName] = {};
                perPort[portName][h] = (perPort[portName][h] || 0) + count;
              }
              detailRows.push([server.name, fullPortId, nick, portName || '', op, srvCountry, h, count]);
            });
            if (entries.length > 0) fetchedCount++;
          }
        } catch (e) { errorCount++; }
      }
    } catch (e) {
      logger.error(`[TopHosts] Error on server ${server.name}:`, e.message);
      errorCount++;
    }
  }

  // Persist detailed matrix — atomic replace so queries see a consistent snapshot.
  const snapshotAt = new Date().toISOString();
  try {
    const insertDetail = db.prepare(`INSERT INTO top_hosts_detail
      (snapshot_at, server_name, port_id, nick, client_name, operator, country, host, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      db.prepare('DELETE FROM top_hosts_detail').run();
      for (const r of detailRows) insertDetail.run(snapshotAt, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]);
    })();
  } catch (e) {
    logger.error('[TopHosts] Failed to persist detail rows:', e.message);
  }

  topHostsCache = {
    data: merged,
    perPort,
    updatedAt: snapshotAt,
    stats: { domains: Object.keys(merged).length, portsScanned: fetchedCount, errors: errorCount, detailRows: detailRows.length }
  };
  _kvSet.run('top_hosts_cache', JSON.stringify(topHostsCache));
  logger.info(`[TopHosts] Aggregation complete: ${Object.keys(merged).length} domains, ${detailRows.length} detail rows from ${fetchedCount} ports (${errorCount} errors)`);
  logActivity('system', 'info', 'top_hosts_complete', null, `Top hosts: ${Object.keys(merged).length} domains, ${detailRows.length} detail rows`, { domains: Object.keys(merged).length, detail_rows: detailRows.length, ports_scanned: fetchedCount, errors: errorCount });
  return topHostsCache;
}

app.get('/api/admin/top_hosts_aggregated', authMiddleware, adminMiddleware, (req, res) => {
  res.json(topHostsCache);
});

// Phase 5: comprehensive domain-log explorer.
// Returns everything useful from the top_hosts_detail snapshot plus pre-computed
// aggregates across every dimension so the UI can render breakdowns without
// re-aggregating. Supports filtering by host pattern, client, operator, server.
//
// Query params (all optional):
//   host       — substring match on host (case-insensitive)
//   client     — exact client_name
//   operator   — exact operator
//   server     — exact server_name
//   nick       — exact nick
//   limit      — max raw rows returned (default 2000, max 20000)
//   min_count  — drop rows with count < N (default 1)
app.get('/api/analytics/logs_domains_full', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { host = '', client = '', operator = '', server = '', nick = '' } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 2000, 1), 20000);
    const minCount = Math.max(parseInt(req.query.min_count) || 1, 1);

    const where = ['count >= ?'];
    const params = [minCount];
    if (host)     { where.push('LOWER(host) LIKE ?');   params.push('%' + String(host).toLowerCase() + '%'); }
    if (client)   { where.push('client_name = ?');      params.push(client); }
    if (operator) { where.push('operator = ?');         params.push(operator); }
    if (server)   { where.push('server_name = ?');      params.push(server); }
    if (nick)     { where.push('nick = ?');             params.push(nick); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Snapshot meta
    const snap = db.prepare('SELECT MIN(snapshot_at) as ts, COUNT(*) as total_rows FROM top_hosts_detail').get();

    // Filtered raw rows (capped)
    const rows = db.prepare(`
      SELECT server_name, port_id, nick, client_name, operator, country, host, count
      FROM top_hosts_detail
      ${whereSql}
      ORDER BY count DESC
      LIMIT ${limit}
    `).all(...params);

    // Summary of the filtered set
    const totals = db.prepare(`
      SELECT COUNT(*) as rows,
             SUM(count) as hits,
             COUNT(DISTINCT host) as unique_hosts,
             COUNT(DISTINCT client_name) as clients,
             COUNT(DISTINCT operator) as operators,
             COUNT(DISTINCT server_name) as servers,
             COUNT(DISTINCT nick) as modems
      FROM top_hosts_detail
      ${whereSql}
    `).get(...params);

    // Each aggregation runs independently — no O(rows²) client-side work needed
    const agg = sql => db.prepare(sql).all(...params);
    const topHosts = agg(`
      SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as modems, COUNT(DISTINCT client_name) as clients
      FROM top_hosts_detail ${whereSql}
      GROUP BY host ORDER BY hits DESC LIMIT 100`);
    const byClient = agg(`
      SELECT client_name, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY client_name ORDER BY hits DESC`);
    const byOperator = agg(`
      SELECT operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY operator ORDER BY hits DESC`);
    const byServer = agg(`
      SELECT server_name, country, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts, COUNT(DISTINCT nick) as modems
      FROM top_hosts_detail ${whereSql}
      GROUP BY server_name ORDER BY hits DESC`);
    const byModem = agg(`
      SELECT server_name, nick, operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY server_name, nick ORDER BY hits DESC LIMIT 100`);

    // TLD / IP split — computed in JS because SQLite lacks rinstr/reverse.
    const tldRows = db.prepare(`
      SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as mods
      FROM top_hosts_detail ${whereSql}
      GROUP BY host
    `).all(...params);
    const tldMap = {};
    const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
    for (const r of tldRows) {
      let tld;
      if (IP_RE.test(r.host)) tld = '(IP)';
      else {
        const dot = r.host.lastIndexOf('.');
        tld = dot === -1 ? '(none)' : r.host.slice(dot + 1).toLowerCase();
      }
      if (!tldMap[tld]) tldMap[tld] = { tld, hits: 0, unique_hosts: 0 };
      tldMap[tld].hits += r.hits;
      tldMap[tld].unique_hosts += 1;
    }
    const byTld = Object.values(tldMap).sort((a, b) => b.hits - a.hits).slice(0, 50);

    // Facet lists (unfiltered — for populating filter dropdowns)
    const facetClients = db.prepare('SELECT DISTINCT client_name FROM top_hosts_detail WHERE client_name != \'\' ORDER BY client_name').all().map(r => r.client_name);
    const facetOperators = db.prepare('SELECT DISTINCT operator FROM top_hosts_detail WHERE operator != \'\' ORDER BY operator').all().map(r => r.operator);
    const facetServers = db.prepare('SELECT DISTINCT server_name FROM top_hosts_detail ORDER BY server_name').all().map(r => r.server_name);

    res.json({
      snapshot_at: snap.ts,
      total_rows_in_snapshot: snap.total_rows,
      filters: { host, client, operator, server, nick, limit, min_count: minCount },
      summary: totals,
      top_hosts: topHosts,
      by_client: byClient,
      by_operator: byOperator,
      by_server: byServer,
      by_modem: byModem,
      by_tld: byTld,
      rows,
      facets: { clients: facetClients, operators: facetOperators, servers: facetServers }
    });
  } catch (e) {
    logger.error('[logs_domains_full]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/top_hosts_refresh', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await aggregateTopHosts();
    res.json({ ok: true, stats: result.stats, updatedAt: result.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dynamic speedtest scheduler (supports multiple times per day)
let speedtestTimers = [];

function rescheduleSpeedtests() {
  // Clear existing timers
  speedtestTimers.forEach(t => { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); });
  speedtestTimers = [];

  const times = appSettings.speedtest_times || ['02:00', '14:00'];
  const mskOff = getTzOffset('Europe/Moscow');
  for (const timeStr of times) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    const utcHour = (parts[0] - mskOff + 24) % 24;
    scheduleRepeating(utcHour, parts[1], 'Speedtest-' + timeStr + ' MSK', runNightlySpeedtests, true);
  }
}

const _cronTimers = []; // Non-speedtest cron timers (billing, reconciliation, etc.)
function scheduleRepeating(hour, minute, label, fn, isSpeedtest) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  logger.info(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
  const entry = {};
  const safeFn = () => { try { const r = fn(); if (r && r.catch) r.catch(e => logger.error(`[${label}] Error:`, e.message)); } catch (e) { logger.error(`[${label}] Error:`, e.message); } };
  entry.timeout = setTimeout(() => {
    safeFn();
    entry.interval = setInterval(safeFn, 24 * 60 * 60 * 1000);
  }, msUntil);
  if (isSpeedtest) speedtestTimers.push(entry);
  else _cronTimers.push(entry);
}

// Single flow: fetch → save daily_traffic → charge → retry on failure
async function runDailyBilling(retryClientIds) {
  // Mutex: serialize billing vs saveClients to avoid reading stale client snapshots.
  return withClientsLock(() => _runDailyBillingImpl(retryClientIds));
}

async function _runDailyBillingImpl(retryClientIds) {
  const isRetry = Array.isArray(retryClientIds) && retryClientIds.length > 0;
  // Guard: prevent double billing for same date (atomic check)
  const yesterdayCheck = getMoscowYesterday();
  const skipResult = db.transaction(() => {
    if (!isRetry) {
      const existingCharge = db.prepare("SELECT id FROM billing_ledger WHERE date = ? AND type = 'charge' LIMIT 1").get(yesterdayCheck);
      if (existingCharge) return { skip: true, reason: `Already billed for ${yesterdayCheck}` };
    } else {
      const chargedIds = db.prepare("SELECT DISTINCT client_id FROM billing_ledger WHERE date = ? AND type = 'charge'").all(yesterdayCheck).map(r => r.client_id);
      if (chargedIds.length > 0) {
        retryClientIds = retryClientIds.filter(id => !chargedIds.includes(id));
        if (retryClientIds.length === 0) return { skip: true, reason: 'Retry: all clients already billed' };
      }
    }
    return { skip: false };
  })();
  if (skipResult.skip) {
    logger.warn(`[Billing] ${skipResult.reason}, skipping`);
    logActivity('billing', 'info', 'billing_skip', null, skipResult.reason);
    return;
  }
  logger.info(`[Billing] Starting ${isRetry ? 'RETRY' : 'daily'} billing run...`);
  logActivity('billing', 'info', 'billing_start', null, `Starting ${isRetry ? 'RETRY' : 'daily'} billing run`);

  let results;
  try {
    results = await fetchAllServersData();
  } catch (e) {
    logger.error('[Billing] Failed to fetch server data:', e.message);
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
      const yIn = parseBwToBytes(b.bandwidth_bytes_yesterday_in);
      const yOut = parseBwToBytes(b.bandwidth_bytes_yesterday_out);
      if (yIn > 0 || yOut > 0) {
        const existing = dailyTraffic[key][yesterdayStr];
        const newIn = Math.max(existing?.in || 0, yIn);
        const newOut = Math.max(existing?.out || 0, yOut);
        _dtUpsert.run(key, yesterdayStr, newIn, newOut);
        dailyTraffic[key][yesterdayStr] = { in: newIn, out: newOut, portName: b.portName };
      }
    }
  }

  // 2. Bill each client
  const clientsToBill = isRetry
    ? clients.filter(c => retryClientIds.includes(c.id))
    : clients;

  for (const client of clientsToBill) {
    if (!client.portName || !client.price || client.price <= 0 || client.billingPaused) {
      if (client.billingPaused) logger.info(`[Billing] Skipping ${client.name} — billing paused`);
      skipped++;
      continue;
    }

    // Check server availability for this client's ports
    const cachedServers = getClientCachedServers(results, client.portName);
    if (cachedServers.length > 0 || results.length < apiServers.length) {
      const reason = cachedServers.length > 0
        ? `cached data on [${cachedServers.join(', ')}]`
        : `only ${results.length}/${apiServers.length} servers`;
      logger.info(`[Billing] Skipping ${client.name}: ${reason}`);
      skippedClients.push(client.id);
      skipped++;
      continue;
    }

    try {
      // Primary source: durable traffic_hourly / daily_traffic. Survives ProxySmart restarts
      // that zero the bandwidth_bytes_yesterday_* counters (which has caused missed bills
      // when a server reboots across midnight).
      const deltaBytesDurable = getClientBytesForMskDate(client.portName, yesterdayStr);
      const deltaBytesLive = computeClientYesterdayBytes(results, client.portName);
      const deltaBytes = Math.max(deltaBytesDurable, deltaBytesLive);
      const deltaGb = trafficBytesToGb(deltaBytes);

      if (deltaBytesDurable > deltaBytesLive * 1.1 && deltaBytesLive > 0) {
        logger.warn(`[Billing] ${client.name}: durable source wins (${trafficBytesToGb(deltaBytesDurable)} GB) over ProxySmart yesterday (${trafficBytesToGb(deltaBytesLive)} GB) — server likely restarted`);
      }

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
      let modemCount = 0;
      const mn = getMoscowNow();
      // yesterdayStr is yesterday's MSK date — use that month for daysInMonth
      const _ystY = parseInt(yesterdayStr.slice(0,4));
      const _ystM = parseInt(yesterdayStr.slice(5,7));
      const daysInMonth = new Date(_ystY, _ystM, 0).getDate();
      if (client.billingType === 'per_modem') {
        for (const data of results) {
          if (typeof data.bw === 'object') {
            for (const [portId, b] of Object.entries(data.bw)) {
              if (b.portName === client.portName) modemCount++;
            }
          }
        }
        cost = (client.price * modemCount) / daysInMonth;
      } else {
        cost = client.price * deltaGb;
      }
      cost = Math.round(cost * 100) / 100;
      if (cost <= 0) { skipped++; continue; }

      // Debt policy: by default charges ALWAYS go through, even if balance
      // goes far negative — clients accumulate debt and admin reconciles
      // via top-up. Hard floor only applies if admin sets client.maxDebt
      // explicitly (e.g. to refuse charges past -100k).
      let minBalance = null;
      if (typeof client.maxDebt === 'number' && client.maxDebt > 0) {
        minBalance = -Math.abs(client.maxDebt);
      }

      let debitRes;
      try {
        debitRes = atomicDebit(client.id, cost, {
          type: 'charge',
          date: yesterdayStr,
          timestamp: new Date().toISOString(),
          delta_bytes: Math.round(deltaBytes),
          delta_gb: deltaGb,
          price_per_unit: client.price,
          billing_type: client.billingType || 'per_gb',
          modem_count: modemCount || null,
          days_in_month: daysInMonth,
          cost,
          currency: client.currency || 'RUB',
          note: client.billingType === 'per_modem'
            ? `Списание за аренду ${modemCount} ${modemPlural(modemCount)} (${yesterdayLabel})`
            : `Списание за трафик (${yesterdayLabel})`,
          traffic_source: 'daily_billing'
        }, { minBalance });
      } catch (e) {
        if (e && e.code === 'INSUFFICIENT_BALANCE') {
          logger.warn(`[Billing] ${client.name}: insufficient balance (${e.balanceBefore} → ${e.balanceAfter}, min=${e.minBalance}), charge blocked`);
          logActivity('billing', 'warn', 'insufficient_balance', client.name,
            `Insufficient balance: would go from ${e.balanceBefore} to ${e.balanceAfter} (limit ${e.minBalance})`,
            { client_id: client.id, cost, balance: e.balanceBefore, minBalance: e.minBalance });
          skipped++;
          continue;
        }
        throw e;
      }

      if (debitRes && debitRes.duplicate) {
        logger.info(`[Billing] ${client.name}: charge for ${yesterdayStr} already posted (duplicate), skipping`);
        skipped++;
        continue;
      }

      charged++;
      logger.info(`[Billing] ${client.name}: ${deltaGb}GB, ${cost} ${client.currency || 'RUB'}, balance=${client.balance}`);
      logActivity('billing', 'info', 'daily_charge', client.name, `Charged ${cost} ${client.currency || 'RUB'} for ${deltaGb}GB`, { client_id: client.id, gb: deltaGb, cost, balance: client.balance });
    } catch (e) {
      logger.error(`[Billing] Error billing ${client.name}:`, e.message);
      logActivity('billing', 'error', 'billing_error', client.name, `Billing error: ${e.message}`, { client_id: client.id });
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

  logger.info(`[Billing] Complete: ${charged} charged, ${skipped} skipped`);
  logActivity('billing', charged > 0 ? 'info' : 'warn', 'billing_complete', null, `Billing complete: ${charged} charged, ${skipped} skipped`, { charged, skipped, date: yesterdayStr, is_retry: isRetry });

  // 3. Schedule retry if clients were skipped due to server issues (max 1 retry, not on retry runs)
  if (!isRetry && skippedClients.length > 0) {
    const _retryHours = appSettings.billing_retry_delay_hours || 1;
    logger.info(`[Billing] Scheduling retry in ${_retryHours}h for ${skippedClients.length} skipped client(s)...`);
    setTimeout(() => {
      runDailyBilling(skippedClients).catch(e => logger.error('[Billing] Retry error:', e.message));
    }, _retryHours * 3600000);
  }
}

// Runs on 1st of each month at 03:00 UTC (06:00 MSK), before acts generation
async function runMonthlyReconciliation() {
  const mn = getMoscowNow();
  const currentMonth = getMoscowToday().slice(0, 7); // "YYYY-MM"

  // Only run on 1st of month
  if (mn.getDate() !== 1) {
    logger.info('[MonthlyRecon] Not 1st of month, skipping');
    return;
  }

  // Guard: don't run twice for same month
  // Previous month is what we reconcile
  const prevMonth = new Date(mn.getFullYear(), mn.getMonth() - 1, 1);
  const prevMonthStr = prevMonth.toLocaleDateString('en-CA').slice(0, 7); // "YYYY-MM"
  if (lastReconciliationMonth === prevMonthStr) {
    logger.info(`[MonthlyRecon] Already reconciled ${prevMonthStr}, skipping`);
    return;
  }

  logger.info(`[MonthlyRecon] Starting reconciliation for ${prevMonthStr}...`);

  // CRITICAL: persist the marker BEFORE any debits, so a crash mid-loop won't
  // cause a re-run on next start (which would double-bill corrections).
  // We accept the small risk of "marked-but-skipped" in exchange for no double-billing.
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('last_reconciliation_month', ?)").run(prevMonthStr);
  lastReconciliationMonth = prevMonthStr;

  // Refresh port mapping (don't swallow — log the failure)
  try {
    const results = await fetchAllServersDataCached();
    refreshPortKeyMapping(results);
  } catch (e) {
    logger.warn('[MonthlyRecon] port mapping refresh failed (using cached):', e.message);
  }

  let corrections = 0;
  for (const client of clients) {
    if (!client.portName || !client.price || client.price <= 0) continue;

    // Per-modem clients — fixed rate, just log
    if (client.billingType === 'per_modem') {
      logger.info(`[MonthlyRecon] ${client.name}: per_modem — skipped (fixed rate)`);
      continue;
    }

    const storedBytes = getClientStoredMonthBytes(client.portName, prevMonthStr);
    const storedGb = trafficBytesToGb(storedBytes);

    const entries = billingLedger[client.id] || [];
    const monthCharges = entries.filter(e =>
      (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(prevMonthStr) &&
      (!e.traffic_source || e.traffic_source !== 'monthly_reconciliation')
    );
    const billedBytes = monthCharges.reduce((s, e) => s + (e.delta_bytes || 0), 0);
    const billedGb = trafficBytesToGb(billedBytes);

    const diffGb = Math.round((storedGb - billedGb) * 1000) / 1000;

    if (diffGb <= (appSettings.reconciliation_tolerance_gb || 0.01)) {
      logger.info(`[MonthlyRecon] ${client.name}: ok (stored=${storedGb}GB, billed=${billedGb}GB)`);
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
    logger.info(`[MonthlyRecon] ${client.name}: +${diffGb}GB (+${correctionCost}₽)`);
  }

  // Marker already persisted at start; just save client balances and log.
  saveClients(clients);
  logger.info(`[MonthlyRecon] Complete: ${corrections} correction(s)`);
  logActivity('billing', 'info', 'reconciliation_complete', null, `Monthly reconciliation for ${prevMonthStr}: ${corrections} correction(s)`, { period: prevMonthStr, corrections });
}

async function autoCreateMissingClients() {
  try {
    const results = await fetchAllServersDataCached();
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
        password: null,
        passwordHash: passwordHash,
        contact: '',
        notes: 'Auto-created from portName',
        billingType: 'per_gb',
        price: autoPrice,
        currency: 'RUB',
        payments: [],
        documents: [],
        closingDocuments: [],
        bills: [],
        apiKey: 'prx_' + crypto.randomBytes(24).toString('hex'),
        referral_code: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        referred_by: null,
        referral_balance: 0,
        resetToken: crypto.randomBytes(16).toString('hex'),
        balance: 0,
        last_traffic_snapshot: { timestamp: null, month_bytes: 0 },
        inn: '', kpp: '', legalName: '', contractInfo: '', address: '',
        autoActs: true, autoBills: true, billingPaused: false,
        clientType: 'legal',
        createdAt: new Date().toISOString()
      };
      clients.push(client);
      users[login] = { passwordHash, portNameFilter: pn, source: 'client', clientId: client.id };
      created++;
      logger.info(`  Auto-created client: login=${login}, portName=${pn}`);
      logActivity('system', 'info', 'client_auto_created', pn, `Auto-created client: login=${login}, portName=${pn}`, { login, portName: pn, price: autoPrice, proxy_count: proxyCount });
    }

    if (created > 0) {
      saveClients(clients);
      rebuildClientMaps();
      logger.info(`[AutoCreate] Created ${created} new client(s)`);
      logActivity('system', 'info', 'auto_create_complete', null, `Auto-created ${created} new client(s)`, { created });
    }
  } catch (e) {
    logger.error('[AutoCreate] Error:', e.message);
    logActivity('system', 'error', 'auto_create_error', null, `Auto-create clients error: ${e.message}`);
  }
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// Accept raw text body for webhook
app.post('/api/tochka/webhook', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  logger.info('[Tochka Webhook] Received webhook');
  // Audit context — every webhook-driven write tags as source=webhook actor=tochka
  dbAudit.setActiveContext({ source: 'webhook', actor: 'tochka', ip: getClientIp(req), reason: 'tochka_webhook' });
  try {
    // Body is JWT string
    const jwtToken = typeof req.body === 'string' ? req.body.trim() : JSON.stringify(req.body);

    
    const { verified, payload, reason } = await verifyJwtSignature(jwtToken);
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
      matchedClientName: null,
      autoCredit: false
    };

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
      const matchedClient = payerInn ? clientByInn.get(payerInn) : null;
      if (matchedClient) {
        try {
          atomicCredit(matchedClient.id, amount, {
            type: 'bank_payment',
            date: paymentDate,
            timestamp: new Date().toISOString(),
            amount, currency: 'RUB',
            note: `Банк Точка (ИНН: ${payerInn}): ${purpose}`.slice(0, 300),
            source: 'tochka_webhook',
            paymentId
          });
          // Match-mark + payment-record + referral commission in ONE transaction.
          // Previously each was a separate statement, so a partial failure
          // (e.g. crash between match-mark and referral credit) could leave
          // referral_balance double-credited on webhook retry.
          db.transaction(() => {
            dbStmts.updateBankPaymentMatch.run(1, matchedClient.id, matchedClient.name, 1, paymentId);
            if (matchedClient.referred_by) {
              const referrer = clientById.get(matchedClient.referred_by);
              if (referrer) {
                const commission = Math.round(amount * 0.15 * 100) / 100;
                const newRefBal = Math.round(((referrer.referral_balance || 0) + commission) * 100) / 100;
                _clientUpdateReferralBalance.run(newRefBal, referrer.id);
                referrer.referral_balance = newRefBal;  // sync in-memory only after DB succeeded
              }
            }
          })();
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
        } catch (e) {
          logger.error(`[Tochka Webhook] credit failed for ${matchedClient.name}:`, e.message);
          // Row stays unmatched — admin can attribute manually.
        }
      } else {
        logger.info(`[Tochka Webhook] Unmatched: INN=${payerInn}, amount=${amount}, purpose=${purpose}`);
      }
    }

    res.status(200).json({ ok: true, processed: true, inserted, matched: bankPayment.matched, verified });
  } catch (err) {
    logger.error('[Tochka Webhook] Error:', err.message);
    res.status(200).json({ ok: true, processed: false, reason: err.message });
  } finally {
    dbAudit.clearActiveContext();
  }
});

// Save Tochka config from admin UI
app.post('/api/admin/tochka/config', authMiddleware, adminMiddleware, (req, res) => {
  const { jwt, clientId, customerCode, accountId, companyName, companyInn, companyKpp, companyAddress, bankAccount, bankName, bankBic, bankCorrAccount } = req.body;
  if (jwt !== undefined) tochkaConfig.jwt = jwt.trim();
  if (clientId !== undefined) tochkaConfig.clientId = clientId.trim();
  if (customerCode !== undefined) tochkaConfig.customerCode = customerCode.trim();
  if (accountId !== undefined) tochkaConfig.accountId = accountId.trim();
  if (companyName !== undefined) tochkaConfig.companyName = companyName.trim();
  if (companyInn !== undefined) tochkaConfig.companyInn = companyInn.trim();
  if (companyKpp !== undefined) tochkaConfig.companyKpp = companyKpp.trim();
  if (companyAddress !== undefined) tochkaConfig.companyAddress = companyAddress.trim();
  if (bankAccount !== undefined) tochkaConfig.bankAccount = bankAccount.trim();
  if (bankName !== undefined) tochkaConfig.bankName = bankName.trim();
  if (bankBic !== undefined) tochkaConfig.bankBic = bankBic.trim();
  if (bankCorrAccount !== undefined) tochkaConfig.bankCorrAccount = bankCorrAccount.trim();
  saveTochkaConfig();
  logger.info('[Tochka] Config updated from admin UI, jwt=' + (tochkaConfig.jwt ? 'set' : 'empty') + ', clientId=' + tochkaConfig.clientId);
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
    companyKpp: tochkaConfig.companyKpp,
    companyAddress: tochkaConfig.companyAddress,
    bankAccount: tochkaConfig.bankAccount,
    bankName: tochkaConfig.bankName,
    bankBic: tochkaConfig.bankBic,
    bankCorrAccount: tochkaConfig.bankCorrAccount
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
    logger.info('[Tochka] Webhook registered:', JSON.stringify(result.data));
    res.json({ ok: true, result: result.data });
  } catch (err) {
    res.status(502).json({ error: 'Failed to register webhook', details: err.message });
  }
});

// Sync historical payments from Tochka (Init Statement → poll → match)
// Tochka statement sync — extracted into reusable function so it can be called
// from the manual admin endpoint AND from the scheduled poller.
// Returns { ok, total?, imported?, matched?, skipped?, error? }.
async function runTochkaSync({ dateFrom, dateTo, source = 'manual' } = {}) {
  if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
    return { ok: false, error: 'tochka_not_configured' };
  }
  // Default to "last 12 months" instead of hardcoded 2024 (time-bomb when
  // anyone copies this code post-2027 — they'd silently scan 3 years).
  const from = dateFrom || new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const to   = dateTo   || new Date().toISOString().slice(0, 10);
  logger.info(`[Tochka Sync:${source}] Requesting statement ${from} — ${to}`);

  // 1) Init statement
  let initResult;
  try {
    initResult = await tochkaRequest('POST', '/uapi/open-banking/v1.0/statements', {
      Data: { Statement: {
        accountId: tochkaConfig.accountId,
        startDateTime: from + 'T00:00:00+00:00',
        endDateTime:   to   + 'T00:00:00+00:00'
      } }
    });
  } catch (e) {
    return { ok: false, error: 'init_failed', details: e.message };
  }
  const statementId =
       initResult.data?.Data?.Statement?.statementId
    || initResult.data?.Data?.statementId
    || initResult.data?.statementId;
  if (!statementId) {
    return { ok: false, error: 'no_statement_id', details: initResult.data };
  }
  logger.info(`[Tochka Sync:${source}] statement=${statementId}`);

  // 2) Poll until Ready — exponential backoff (1.5x), capped at 10s per wait,
  // ~10 attempts → total ~60s. Previously: 15 fixed 2s polls = self-DOS on Tochka.
  let statement = null;
  let delay = 1000;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, delay));
    let getResult;
    try {
      getResult = await tochkaRequest('GET',
        `/uapi/open-banking/v1.0/accounts/${tochkaConfig.accountId}/statements/${statementId}`);
    } catch (e) {
      logger.warn(`[Tochka Sync:${source}] poll #${attempt+1} error: ${e.message}`);
      delay = Math.min(delay * 1.5, 10000);
      continue;
    }
    const stData = getResult.data?.Data?.Statement?.[0]
                || getResult.data?.Data?.Statement
                || getResult.data;
    const status = stData?.status || stData?.Status || '';
    if (status === 'Ready' || status === 'ready') { statement = stData; break; }
    delay = Math.min(delay * 1.5, 10000);
  }
  if (!statement) return { ok: false, error: 'statement_not_ready' };

  // 3) Process credits — auto-credit by INN, save all to bank_payments
  const transactions = statement.Transaction || statement.transactions || [];
  let imported = 0, matched = 0, skipped = 0;
  for (const tx of transactions) {
    const indicator = tx.creditDebitIndicator || tx.CreditDebitIndicator || '';
    if (indicator !== 'Credit' && indicator !== 'credit') continue;

    const amount = Math.round(parseFloat(tx.Amount?.amount || tx.amount || 0) * 100) / 100;
    if (!(amount > 0)) continue;
    const debtor = tx.DebtorParty || tx.CounterParty || tx.SidePayer || {};
    const payerInn  = debtor.inn || debtor.Inn || debtor.taxCode || '';
    const payerName = debtor.name || debtor.Name || debtor.fullName || '';
    const purpose   = tx.description || tx.Description || tx.TransactionInformation || '';
    const paymentId = tx.transactionId || tx.TransactionId || tx.paymentId
                   || ('tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const date = tx.documentProcessDate || tx.bookingDateTime || tx.valueDateTime || tx.date || to;

    if (dbStmts.findBankPaymentByTochkaId.get(paymentId)) { skipped++; continue; }

    const bankPayment = {
      id: 'bp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      tochkaPaymentId: paymentId,
      webhookType: 'incomingPayment',
      source: 'sync',
      date: typeof date === 'string' ? date.slice(0, 10) : date,
      amount, payerInn, payerName, purpose,
      matched: false, matchedClientId: null, matchedClientName: null,
      receivedAt: new Date().toISOString()
    };

    if (payerInn) {
      const client = clientByInn.get(payerInn);
      if (client) {
        bankPayment.matched = true;
        bankPayment.matchedClientId = client.id;
        bankPayment.matchedClientName = client.name;
        try {
          atomicCredit(client.id, amount, {
            type: 'bank_payment',
            amount, date: bankPayment.date,
            timestamp: new Date().toISOString(),
            note: 'Синхронизация из Точки: ' + (purpose || '').slice(0, 100),
            source: 'tochka_sync',
            tochkaPaymentId: paymentId
          });
          matched++;
        } catch (e) {
          logger.error(`[Tochka Sync:${source}] credit failed for ${client.name}:`, e.message);
          bankPayment.matched = false;
          bankPayment.matchedClientId = null;
          bankPayment.matchedClientName = null;
        }
      }
    }
    insertBankPaymentToDb(bankPayment);
    imported++;
  }
  if (imported > 0) saveClients(clients);

  logger.info(`[Tochka Sync:${source}] done: total=${transactions.length} imported=${imported} matched=${matched} skipped=${skipped}`);
  if (imported > 0 || matched > 0) {
    logActivity('billing', 'info', 'tochka_sync', null,
      `Tochka sync (${source}): ${imported} new, ${matched} auto-credited`,
      { from, to, total: transactions.length, imported, matched, skipped });
  }
  return { ok: true, total: transactions.length, imported, matched, skipped };
}

app.post('/api/admin/tochka/sync', authMiddleware, adminMiddleware, async (req, res) => {
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
  logger.info(`[Tochka] Dismissed ${result.changes} unmatched payments`);
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

  saveClients(clients);
  res.json({ ok: true, balance: client.balance });
});

// Create closing document (Акт выполненных работ)
app.post('/api/admin/tochka/create_act', authMiddleware, adminMiddleware, async (req, res) => {
  const { clientId, period, items } = req.body;
  if (!clientId || !period) return res.status(400).json({ error: 'clientId and period required' });

  const client = clientById.get(clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  
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
        logger.info(`[Tochka] Created act ${tochkaDocumentId} for ${client.name}, period ${period}`);
      } else {
        logger.error({ tochkaResponse: result.data, status: result.status }, '[Tochka] Create act unexpected response');
      }
    } catch (err) {
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

// escHtml extracted to src/utils/html.js
// buildDocHtml extracted to src/documents/generator.js

function buildDocHtml(type, doc, client, billAmount) {
  return _buildDocHtml(type, doc, client, billAmount, tochkaConfig);
}

// Admin: HTML print for closing document (act)
app.get('/api/admin/clients/:id/closing_documents/:docId/print', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const doc = (client.closingDocuments || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  const html = buildDocHtml('act', doc, client); // sanitized via escHtml
  res.send(html); // NOSONAR: output is escaped in buildDocHtml
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
    } catch (e) { logger.warn('[Tochka] Delete doc error:', e.message); }
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
    const monthCharges = ledgerEntries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) { skipped++; continue; }

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) {
      skipped++;
      results.push({ client: client.name, status: 'exists' });
      continue;
    }

    try {
      
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
    try { serverData = await fetchAllServersDataCached(); } catch (e) { logger.error('[Bills] fetchAllServersData error:', e.message); }
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

// Generate bills for all clients
app.post('/api/admin/tochka/generate_bills', authMiddleware, adminMiddleware, async (req, res) => {
  const { period } = req.body;
  const now = new Date();
  const billPeriod = period || now.toISOString().slice(0, 7);
  const billDate = now.toISOString().slice(0, 10);

  let generated = 0, skipped = 0, errors = 0;
  const results = [];
  let serverData = [];
  try { serverData = await fetchAllServersDataCached(); } catch (e) { logger.error('[Bills] fetchAllServersData error:', e.message); }

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

// Admin: HTML print for bill
app.get('/api/admin/clients/:id/bills/:billId/print', authMiddleware, adminMiddleware, (req, res) => {
  const client = clientById.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const bill = (client.bills || []).find(b => b.id === req.params.billId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  const html = buildDocHtml('bill', bill, client, bill.amount); // sanitized via escHtml
  res.send(html); // NOSONAR: output is escaped in buildDocHtml
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
    } catch (e) { logger.error('[Tochka] Delete bill error:', e.message); }
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

async function autoGenerateMonthlyActs() {
  const moscowDate = getMoscowNow();
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

  logger.info(`[Tochka AutoActs] Generating acts for period ${period}...`);
  let generated = 0;

  for (const client of clients) {
    // Skip clients with autoActs disabled
    if (client.autoActs === false) continue;

    // Skip clients without charges
    const ledgerEntries = billingLedger[client.id] || [];
    const monthCharges = ledgerEntries.filter(e => (e.type === 'charge' || e.type === 'correction') && e.date && e.date.startsWith(period));
    if (monthCharges.length === 0) continue;

    // Skip if act already exists for this period
    if ((client.closingDocuments || []).some(d => d.period === period)) continue;

    try {
      
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
        } catch (e) { logger.error(`[Tochka AutoActs] API error for ${client.name}:`, e.message); }
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
      logger.info(`[Tochka AutoActs] Created act for ${client.name}: ${totalCost} RUB`);
      logActivity('billing', 'info', 'act_created', client.name, `Act created: ${totalCost} RUB for ${period}`, { client_id: client.id, amount: totalCost, period, act_number: actNumber });
    } catch (e) {
      logger.error(`[Tochka AutoActs] Error for ${client.name}:`, e.message);
      logActivity('billing', 'error', 'act_error', client.name, `Act generation error: ${e.message}`, { client_id: client.id, period });
    }
  }

  if (generated > 0) {
    saveClients(clients);
    logger.info(`[Tochka AutoActs] Generated ${generated} acts for ${period}`);
  }
  logActivity('billing', 'info', 'acts_complete', null, `Monthly acts generation: ${generated} created for ${period}`, { generated, period });
  lastActGenerationMonth = period;
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('last_act_generation_month', ?)").run(period);
}

async function autoGenerateMonthlyBills() {
  const moscowDate = getMoscowNow();
  const day = moscowDate.getDate();
  const hour = moscowDate.getHours();

  // Only run on 1st of month, after 8:00 Moscow time
  if (day !== 1 || hour < 8) return;

  // Current month (bills are for the current month, unlike acts which are for previous)
  const currentPeriod = `${moscowDate.getFullYear()}-${String(moscowDate.getMonth() + 1).padStart(2, '0')}`;

  // Prevent duplicate generation
  if (lastBillGenerationMonth === currentPeriod) return;

  logger.info(`[Tochka AutoBills] Generating bills for period ${currentPeriod}...`);
  let generated = 0;
  let serverData = [];
  try { serverData = await fetchAllServersData(); } catch (e) { logger.error('[AutoBills] fetchAllServersData error:', e.message); }

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
        logger.info(`[Tochka AutoBills] Skipping ${client.name}: amount is 0`);
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
          logger.error(`[Tochka AutoBills] API error for ${client.name}:`, e.message);
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
      logger.info(`[Tochka AutoBills] Created bill for ${client.name}: ${amount} RUB`);
      logActivity('billing', 'info', 'bill_created', client.name, `Bill created: ${amount} RUB for ${currentPeriod}`, { client_id: client.id, amount, period: currentPeriod, bill_number: billNumber });
    } catch (e) {
      logger.error(`[Tochka AutoBills] Error for ${client.name}:`, e.message);
      logActivity('billing', 'error', 'bill_error', client.name, `Bill generation error: ${e.message}`, { client_id: client.id, period: currentPeriod });
    }
  }

  if (generated > 0) {
    saveClients(clients);
    logger.info(`[Tochka AutoBills] Generated ${generated} bills for ${currentPeriod}`);
  }
  logActivity('billing', 'info', 'bills_complete', null, `Monthly bills generation: ${generated} created for ${currentPeriod}`, { generated, period: currentPeriod });
  lastBillGenerationMonth = currentPeriod;
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('last_bill_generation_month', ?)").run(currentPeriod);
}

// System activity log viewer
app.get('/api/admin/system_log', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const category = req.query.category || null;
    const level = req.query.level || null;
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();

    const rows = dbStmts.systemLogQueryFiltered.all(from, category, category, level, level, limit);
    res.json({ success: true, entries: rows, total: rows.length });
  } catch (e) {
    logger.error('[SystemLog API] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Simulator routes moved into src/routes/simulator.js (Stage 3).
app.use(require('./src/routes/simulator')({
  db, logger, authMiddleware, adminMiddleware,
  simulator, simulatorDb,
  fetchAllServersDataCached, SERVER_COUNTRIES,
  auditLog,
}));

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Final Express error middleware — catches errors thrown from async handlers
// that weren't caught by inline try/catch. Logs full stack server-side,
// returns generic message to client (no internal-path or SQL leakage).
app.use((err, req, res, next) => {
  const msg = (err && err.stack) || (err && err.message) || String(err);
  logger.error(`[Express] ${req.method} ${req.path}: ${msg}`);
  try { logActivity('system', 'error', 'unhandled_express', null, `${req.method} ${req.path}: ${(err && err.message) || ''}`, { path: req.path, method: req.method }); } catch (_) { /* best-effort: error intentionally swallowed */ }
  if (res.headersSent) return next(err);
  // Admins get the message for debugging; everyone else gets generic.
  const isAdmin = req.user && req.user.isAdmin;
  res.status(500).json(isAdmin ? { error: 'Internal error', details: (err && err.message) || '' } : { error: 'Internal error' });
});

// When required as a module under NODE_ENV=test (supertest harness), skip
// binding a port and skip all cron/tracking/Telegram side effects — tests
// only need `app` + `db` exposed via module.exports below. Production code
// path (node server.js) is unchanged.
const IS_TEST = process.env.NODE_ENV === 'test';
const httpServer = IS_TEST ? null : app.listen(PORT, () => {
  logger.info(`Proxies.Rent Dashboard running at http://localhost:${PORT}`);

  // Schedule speedtests (configurable times, default 02:00 + 14:00)
  rescheduleSpeedtests();

  // Schedule nightly TopHosts at 03:00
  scheduleRepeating(3, 0, 'TopHosts', aggregateTopHosts);

  // Start modem tracking (IP + uptime) — every 5 min
  const TRACKING_INTERVAL_MS = (appSettings.tracking_interval_min || 3) * 60000;
  logger.info(`[Tracking] Starting IP & uptime tracking (every ${TRACKING_INTERVAL_MS / 60000} min)...`);
  trackModems().catch(e => logger.error('[Tracking] Initial error:', e.message));
  _intervals.push(setInterval(() => {
    trackModems().catch(e => logger.error('[Tracking] Error:', e.message));
  }, TRACKING_INTERVAL_MS));

  // Sync yesterday traffic — once at startup, then daily at 00:45 UTC (03:45 MSK)
  syncYesterdayTraffic().catch(e => logger.error('[DailySync] Initial error:', e.message));
  scheduleRepeating(0, 45, 'DailySync', syncYesterdayTraffic);
  scheduleRepeating(7, 0, 'DailySync-07:00', syncYesterdayTraffic);
  scheduleRepeating(15, 0, 'DailySync-15:00', syncYesterdayTraffic);

  // Pre-reset snapshots removed — day-counter based detection handles resets automatically

  // If no cached top_hosts data, do initial aggregation
  if (!topHostsCache.updatedAt) {
    logger.info('[TopHosts] No cached data, running initial aggregation...');
    aggregateTopHosts().catch(e => logger.error('[TopHosts] Initial error:', e.message));
  }

  // Auto-create client accounts for all portNames that don't have one
  autoCreateMissingClients().catch(e => logger.error('[AutoCreate] Error:', e.message));
  // Re-check periodically so new portNames get accounts without restart
  _intervals.push(setInterval(() => {
    autoCreateMissingClients().catch(e => logger.error('[AutoCreate] Error:', e.message));
  }, (appSettings.auto_create_interval_min || 10) * 60000));

  // Proxy latency monitoring
  const pcMin = appSettings.proxy_check_interval_min || 60;
  logger.info(`[ProxyCheck] Starting proxy latency monitoring (every ${pcMin} min)...`);
  setTimeout(() => {
    checkProxyLatency().catch(e => logger.error('[ProxyCheck] Initial error:', e.message));
  }, 30 * 1000);
  _proxyCheckInterval = setInterval(() => {
    checkProxyLatency().catch(e => logger.error('[ProxyCheck] Error:', e.message));
  }, pcMin * 60 * 1000);

  // Phase 4: SLA check every 6 hours. First run 5 min after start.
  setTimeout(() => {
    dbAudit.runJobAsync('SlaCheck', 'initial', () => runSlaCheck())
      .catch(e => logger.error('[SLA] Initial error:', e.message));
  }, 5 * 60 * 1000);
  _intervals.push(setInterval(() => {
    dbAudit.runJobAsync('SlaCheck', 'periodic', () => runSlaCheck())
      .catch(e => logger.error('[SLA] Periodic error:', e.message));
  }, 6 * 60 * 60 * 1000));

  // Auto-reboot flaky modems every 15 min.
  // The throttle inside (auto_reboot_min_interval_min, default 60) ensures the
  // same modem isn't rebooted more than once per hour even if checked every 15.
  // Disabled by default — admin enables in Settings.
  setTimeout(() => {
    dbAudit.runJobAsync('AutoReboot', 'initial', () => runAutoReboot())
      .catch(e => logger.error('[AutoReboot] Initial error:', e.message));
  }, 10 * 60 * 1000);
  _intervals.push(setInterval(() => {
    dbAudit.runJobAsync('AutoReboot', 'periodic', () => runAutoReboot())
      .catch(e => logger.error('[AutoReboot] Periodic error:', e.message));
  }, 15 * 60 * 1000));

  // Phase 6: Tochka bank statement sync every 4 hours.
  // Acts as a reliable backup to webhook delivery — webhooks can be lost during
  // Tochka key rotation, network blips, or our process restarts. Polling guarantees
  // payments eventually land in bank_payments and auto-credit by INN.
  // Skips silently if tochkaConfig is incomplete.
  // Window: last 14 days (idempotent — duplicates skipped via tochka_payment_id).
  function _scheduledTochkaSync(reason) {
    if (!tochkaConfig.jwt || !tochkaConfig.accountId) {
      logger.debug('[Tochka Sync:scheduled] skipped — config incomplete');
      return;
    }
    const today = new Date();
    const dateTo   = today.toISOString().slice(0, 10);
    const dateFrom = new Date(today.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    dbAudit.runJobAsync('TochkaSync', reason, () =>
      runTochkaSync({ dateFrom, dateTo, source: reason })
    )
      .then(r => {
        if (!r.ok) logger.warn(`[Tochka Sync:${reason}] failed:`, r.error, r.details || '');
      })
      .catch(e => logger.error(`[Tochka Sync:${reason}] exception:`, e.message));
  }
  // Initial run 90s after start (after DB warm-up + cache populate)
  setTimeout(() => _scheduledTochkaSync('startup'), 90 * 1000);
  _intervals.push(setInterval(() => _scheduledTochkaSync('periodic'), 4 * 60 * 60 * 1000));

  // Nightly DB cleanup at 00:30 UTC — remove old data using dynamic retention settings
  scheduleRepeating(0, 30, 'DbCleanup', () => {
    try {
      const res = runRetentionCleanup();
      const total = Object.values(res).reduce((s, r) => s + r.changes, 0);
      if (total > 0) logger.info(`[DbCleanup] Removed ${total} old rows (hourly:${res.traffic_hourly.changes} meta:${res.modem_meta.changes} rot:${res.rotation_log.changes} proxy:${res.proxy_checks.changes} audit:${res.audit_log.changes} syslog:${res.system_log.changes})`);
      logActivity('system', 'info', 'db_cleanup', null, `DB cleanup: ${total} rows removed`, { hourly: res.traffic_hourly.changes, meta: res.modem_meta.changes, rotation: res.rotation_log.changes, proxy_checks: res.proxy_checks.changes, audit: res.audit_log.changes, system_log: res.system_log.changes });
    } catch (e) {
      logger.error('[DbCleanup] Error:', e.message);
      logActivity('system', 'error', 'db_cleanup_error', null, `DB cleanup error: ${e.message}`);
    }
  });

  // Heap & disk watchdog — fires every 5 min, alerts on threshold crossings.
  // Heap > 85% of total → log + system_log (telegram alert via logActivity).
  // Disk free < 500 MB on backup volume → same.
  _intervals.push(setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const pct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
      if (pct > 85) {
        logActivity('system', 'warn', 'heap_high', null, `Heap ${pct}% (${Math.round(mem.heapUsed/1e6)}MB / ${Math.round(mem.heapTotal/1e6)}MB)`, { pct, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal });
      }
    } catch (_) { /* best-effort: error intentionally swallowed */ }
    try {
      // Disk free via statfs (Node 18.15+)
      const target = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
      if (fs.statfs) {
        fs.statfs(fs.existsSync(target) ? target : '/', (err, st) => {
          if (err) return;
          const freeBytes = st.bavail * st.bsize;
          const freeMb = Math.round(freeBytes / 1e6);
          if (freeMb < 500) {
            logActivity('system', 'critical', 'disk_low', null, `Free disk ${freeMb} MB on ${target}`, { freeMb });
          }
        });
      }
    } catch (_) { /* best-effort: error intentionally swallowed */ }
  }, 5 * 60 * 1000));

  // Nightly DB backup at 02:00 UTC (05:00 MSK) — uses SQLite Online Backup
  // API (db.backup) so it's safe to run while the dashboard is live.
  // Keeps last 14 snapshots; oldest pruned automatically.
  scheduleRepeating(2, 0, 'DbBackup', async () => {
    try {
      const backupDir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch (_) { /* best-effort: error intentionally swallowed */ }
      const ts = new Date().toISOString().slice(0, 10);
      const dest = path.join(backupDir, `dashboard-${ts}.db`);
      // better-sqlite3 .backup() is a promise that streams pages to disk.
      await db.backup(dest);
      // Verify the backup opens & has clients table.
      const Database = require('better-sqlite3');
      const bdb = new Database(dest, { readonly: true });
      const ok = bdb.prepare("SELECT count(*) c FROM sqlite_master WHERE name='clients'").get();
      bdb.close();
      if (!ok || !ok.c) throw new Error('backup verification: clients table missing');
      // Prune backups older than 14 days
      const files = fs.readdirSync(backupDir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db$/.test(f));
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      let pruned = 0;
      for (const f of files) {
        const fileDate = f.slice(10, 20);
        if (fileDate < cutoff) {
          try { fs.unlinkSync(path.join(backupDir, f)); pruned++; } catch (_) { /* best-effort: error intentionally swallowed */ }
        }
      }
      const sizeMb = Math.round(fs.statSync(dest).size / 1024 / 1024 * 10) / 10;
      logger.info(`[DbBackup] ${dest} (${sizeMb} MB), pruned ${pruned} old backups`);
      logActivity('system', 'info', 'db_backup_complete', null, `Backed up ${sizeMb} MB to ${dest}`, { sizeMb, pruned });
    } catch (e) {
      logger.error('[DbBackup] FAILED: ' + (e.stack || e.message));
      logActivity('system', 'critical', 'db_backup_failed', null, 'DB backup failed', { error: e.message });
    }
  });

  // Hourly: just the stale-port mapping cleanup (cheap, keeps the "modem
  // disconnected ≥ N days → vanish" window precise to the hour instead of
  // ±1 day from the nightly run).
  _intervals.push(setInterval(() => {
    try {
      const res = cleanupStalePortMappings();
      if (res && (res.dtDeleted || res.dtMemKeys || res.kmRemoved)) {
        logger.info(`[StalePortsHourly] dt=${res.dtDeleted} mem=${res.dtMemKeys} km=${res.kmRemoved}`);
      }
    } catch (e) { logger.error('[StalePortsHourly] ' + e.message); }
  }, 60 * 60 * 1000));

  // Schedule daily billing at 01:00 UTC (04:00 MSK, 4h after ProxySmart midnight reset)
  scheduleRepeating(1, 0, 'DailyBilling', () =>
    dbAudit.runJobAsync('DailyBilling', null, () => runDailyBilling()));

  // Post-correct hourly data at 01:30 UTC (04:30 MSK) — after daily sync + billing
  // Monthly reconciliation at 03:30 UTC (06:30 MSK) on 1st of month — after TopHosts, before acts
  scheduleRepeating(3, 30, 'MonthlyReconciliation', () =>
    dbAudit.runJobAsync('MonthlyReconciliation', null, () => runMonthlyReconciliation()));

  // Auto-generate closing documents (acts) on 1st of each month at 08:05 Moscow (05:05 UTC)
  scheduleRepeating(5, 5, 'MonthlyActs', autoGenerateMonthlyActs);

  // Auto-generate bills on 1st of each month at 08:10 Moscow (05:10 UTC)
  scheduleRepeating(5, 10, 'MonthlyBills', autoGenerateMonthlyBills);

  // ---------------------------------------------------------------------------
  // Telegram bot — daily summary + /start auto-registration
  // ---------------------------------------------------------------------------
  aiInsights.init({
    db, logger,
    getSetting: (key, def) => (appSettings[key] !== undefined ? appSettings[key] : def),
  });
  // Load-simulator engine. Only init here — proxy-URL resolution happens in
  // the per-request endpoint (Day 2), which calls fetchAllServersDataCached()
  // and builds full proxyUrls for the chosen target modems before passing
  // them to simulator.start().
  simulator.init({
    db, logger,
    getSetting: (key, def) => (appSettings[key] !== undefined ? appSettings[key] : def),
  });
  tgSummary.init({
    db, logger,
    clientById,
    getSetting: (key, def) => (appSettings[key] !== undefined ? appSettings[key] : def),
    aiInsights,
  });
  tgBot.init({
    logger,
    getSetting: (key, def) => (appSettings[key] !== undefined ? appSettings[key] : def),
    setSetting: (key, val) => { appSettings[key] = val; saveSettings(); },
    buildDailySummary: tgSummary.buildDailySummary,
  });
  // Start the long-poll loop (handles /start, /today, /yesterday, /status)
  tgBot.start();

  // Daily summary scheduler — checks every 60s if MSK time has reached
  // appSettings.telegram_summary_time and we haven't already sent today.
  // Note: time check is `>= target` (not `===`), so a missed minute due to
  // event-loop lag still delivers the message later in the day.
  _intervals.push(setInterval(async () => {
    try {
      if (!appSettings.telegram_summary_enabled) return;
      const token  = appSettings.telegram_bot_token;
      const chatId = appSettings.telegram_chat_id;
      const time   = appSettings.telegram_summary_time || '08:00';
      if (!token || !chatId) return;
      // MSK now
      const mskNow = new Date(Date.now() + 3 * 3600000);
      const hh = String(mskNow.getUTCHours()).padStart(2, '0');
      const mm = String(mskNow.getUTCMinutes()).padStart(2, '0');
      const nowHM = `${hh}:${mm}`;
      if (nowHM < time) return;          // not yet
      const todayMsk = mskNow.toISOString().slice(0, 10);
      if (appSettings.telegram_last_sent_date === todayMsk) return; // already sent today
      const yMsk = new Date(mskNow.getTime() - 86400000).toISOString().slice(0, 10);
      const { text, parse_mode } = await tgSummary.buildDailySummary(yMsk);
      // Retry up to 3 times on transient network errors (ECONNRESET, timeout)
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await tgBot.sendMessage(token, chatId, text, { parse_mode });
          if (resp && resp.ok === false) throw new Error('Telegram: ' + (resp.description || JSON.stringify(resp)));
          lastErr = null; break;
        } catch (e) {
          lastErr = e;
          logger.warn(`[Telegram] daily send attempt ${attempt}/3 failed: ${e.message || e}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (lastErr) throw lastErr;
      appSettings.telegram_last_sent_date = todayMsk;
      saveSettings();
      logger.info(`[Telegram] Daily summary sent for ${yMsk} → chat ${chatId}`);
      logActivity('system', 'info', 'telegram_summary_sent', null, `Daily summary sent for ${yMsk}`, { date: yMsk, chatId });
    } catch (e) {
      const detail = (e && e.stack) ? e.stack : (e && e.message) ? e.message : JSON.stringify(e);
      logger.error('[Telegram] daily tick failed: ' + detail);
      logActivity('system', 'error', 'telegram_summary_failed', null, 'Daily summary failed', { error: detail.slice(0, 500) });
    }
  }, 60 * 1000));

  // Resilient hourly traffic aggregation with retry logic:
  // Attempts at :00, :01, :02, :03, :04 (5 tries).
  let _hourlyLastRecordedHour = null; // e.g. '2026-03-31 12:00'
  try { const r = _kvGet.get('hourly_last_recorded'); if (r) _hourlyLastRecordedHour = r.value; } catch (_) { /* best-effort: error intentionally swallowed */ }
  // _hourlyLoopTimeout and _hourlyAggStopped declared at module level for gracefulShutdown
  (function scheduleHourlyAggRetry() {
    // Find next :00 (top of the hour)
    const now = new Date();
    const next00 = new Date(now);
    next00.setMinutes(0, 0, 0);
    next00.setTime(next00.getTime() + 60 * 60 * 1000); // always next hour's :00
    const msUntil = next00 - now;
    logger.info(`[HourlyAgg] Resilient schedule: first attempt at ${next00.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);

    _hourlyLoopTimeout = setTimeout(function hourlyLoop() {
      if (_hourlyAggStopped) return;
      // At :00, aggregateHourlyTraffic() writes to prevH = now - 1h (the hour that just ended)
      const ATTEMPT_OFFSETS = [0, 60, 120, 180, 240]; // seconds after :00 → :00, :01, :02, :03, :04
      let attemptIdx = 0;

      // Target is always the hour that just ended — use UTC methods to avoid timezone/rounding issues
      const nowMs = Date.now();
      const currentHourMs = nowMs - (nowMs % 3600000); // round down to current hour start
      const targetHourStr = new Date(currentHourMs - 3600000).toISOString().slice(0, 13).replace('T', ' ') + ':00';

      // Skip if already recorded (e.g. after restart)
      if (_hourlyLastRecordedHour === targetHourStr) {
        logger.info(`[HourlyAgg] Hour ${targetHourStr} already recorded, skipping`);
        setTimeout(hourlyLoop, 60 * 60 * 1000);
        return;
      }

      function tryRecord() {
        // Mark inner block as async-fn whose errors propagate to the outer .catch
        // (was `.then(async () => {...})` whose internal throws produced
        // unhandledRejection instead of being caught).
        aggregateHourlyTraffic().then(() => {
          try {
            // Success = no exception, even if cnt=0 (all modems offline)
            _hourlyLastRecordedHour = targetHourStr;
            try { _kvSet.run('hourly_last_recorded', targetHourStr); } catch (_) { /* best-effort: error intentionally swallowed */ }
            const check = db.prepare('SELECT COUNT(*) as cnt FROM traffic_hourly WHERE hour_start = ?').get(targetHourStr);
            logger.info(`[HourlyAgg] SUCCESS on attempt ${attemptIdx + 1}/5 for ${targetHourStr} (${(check && check.cnt) || 0} rows)`);
            logActivity('traffic', 'info', 'hourly_agg', null, `Hourly traffic aggregated for ${targetHourStr}: ${(check && check.cnt) || 0} rows (attempt ${attemptIdx + 1})`, { hour: targetHourStr, rows: (check && check.cnt) || 0, attempt: attemptIdx + 1 });
          } catch (e) {
            logger.error(`[HourlyAgg] post-success bookkeeping failed: ${e.stack || e.message}`);
          }
        }).catch(e => {
          logger.error(`[HourlyAgg] Attempt ${attemptIdx + 1}/5 error: ${e.message}`);
          attemptIdx++;
          if (attemptIdx < ATTEMPT_OFFSETS.length) {
            const delay = (ATTEMPT_OFFSETS[attemptIdx] - ATTEMPT_OFFSETS[attemptIdx - 1]) * 1000;
            setTimeout(tryRecord, delay);
          } else {
            logger.warn(`[HourlyAgg] All 5 attempts failed for ${targetHourStr} — hour will be empty`);
            logActivity('traffic', 'error', 'hourly_agg_failed', null, `All 5 attempts failed for ${targetHourStr}`, { hour: targetHourStr });
          }
        });
      }

      tryRecord();
      // Schedule next hour's :00
      _hourlyLoopTimeout = setTimeout(hourlyLoop, 60 * 60 * 1000);
    }, msUntil);
  })();

  // Mid-hour snapshot removed (FIX-13): 5 retry attempts at :00-:04 are sufficient.

  // Startup: refresh snapshots only (NO DB writes) — prevents restart-induced data loss
  const snapshotCount = hourlyTraffic.getSnapshotCount();
  logger.info(`[HourlyAgg] ${snapshotCount} snapshots loaded, refreshing in 15s (no DB write)`);
  setTimeout(() => hourlyTraffic.refreshSnapshotsOnly().catch(e => logger.error('[HourlyAgg:startup]', e.message)), 15000);

  // Billing catch-up: if last snapshot is older than 26 hours, run now
  (async () => {
    try {
      const now = Date.now();
      let needsCatchup = false;
      for (const c of clients) {
        if (c.billingPaused) continue;
        if (c.last_traffic_snapshot && c.last_traffic_snapshot.timestamp) {
          const lastRun = new Date(c.last_traffic_snapshot.timestamp).getTime();
          if (now - lastRun > 26 * 60 * 60 * 1000) {
            needsCatchup = true;
            break;
          }
        }
      }
      if (needsCatchup) {
        logger.info('[Billing] Catch-up: missed billing detected, running now...');
        logActivity('billing', 'warn', 'billing_catchup', null, 'Missed billing detected, running catch-up');
        await runDailyBilling();
      }
    } catch (e) {
      logger.error('[Billing] Catch-up error:', e.message);
    }
  })();
});

const CRM_DB_URL = process.env.CRM_DB_URL || '';
const CRM_WS = process.env.CRM_WORKSPACE || 'workspace_1wekp8bkkvyv4c57kfv5uljgp';

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
      logger.info(`[CRM] Payment confirmed for deal "${deal.name}": next payment ${nextPayment.toISOString().slice(0, 10)}`);
      logActivity('system', 'info', 'crm_payment_confirmed', deal.name, `Payment confirmed, next: ${nextPayment.toISOString().slice(0, 10)}`);
    }

    // Find deals with nextPaymentDate within 3 days — log reminder
    const _crmDays = appSettings.crm_reminder_days || 3;
    const reminderDate = new Date(Date.now() + _crmDays * 86400000);
    const upcoming = await pgClient.query(
      `SELECT o.id, o.name, o."nextPaymentDate", o.amount, c.name as company_name
       FROM "${CRM_WS}".opportunity o
       LEFT JOIN "${CRM_WS}".company c ON o."companyId" = c.id
       WHERE o."nextPaymentDate" IS NOT NULL AND o."nextPaymentDate" <= $1 AND o."nextPaymentDate" >= NOW()
       AND o.stage = 'AKTIVNYY_KLIENT' AND o."deletedAt" IS NULL`,
      [reminderDate.toISOString()]
    );

    if (upcoming.rows.length > 0) {
      logger.info(`[CRM] Payment reminders (due within ${_crmDays} days):`);
      for (const deal of upcoming.rows) {
        const dueDate = new Date(deal.nextPaymentDate).toISOString().slice(0, 10);
        logger.info(`  - ${deal.company_name || deal.name}: ${deal.amount || '?'} RUB, due ${dueDate}`);
      }
    }

    await pgClient.end();
  } catch (e) {
    if (pgClient) try { await pgClient.end(); } catch (_) { /* best-effort: error intentionally swallowed */ }
    // pg module might not be installed — skip silently
    if (e.code !== 'MODULE_NOT_FOUND') {
      logger.error('[CRM] Payment check error:', e.message);
    }
  }
}

// Run CRM payment check periodically
checkCrmPaymentConfirmations().catch(e => { if (e.code !== 'MODULE_NOT_FOUND') logger.error('[CRM] Initial check error:', e.message); });
_intervals.push(setInterval(() => {
  checkCrmPaymentConfirmations().catch(e => { if (e.code !== 'MODULE_NOT_FOUND') logger.error('[CRM] Interval error:', e.message); });
}, (appSettings.crm_check_interval_min || 10) * 60000));

let _shutdownInProgress = false;
function gracefulShutdown(signal) {
  if (_shutdownInProgress) return; // re-entrant SIGTERM during shutdown
  _shutdownInProgress = true;
  logger.info(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

  _hourlyAggStopped = true;
  if (_hourlyLoopTimeout) clearTimeout(_hourlyLoopTimeout);
  if (_proxyCheckInterval) clearInterval(_proxyCheckInterval);
  for (const iv of _intervals) clearInterval(iv);
  _intervals.length = 0;
  for (const t of speedtestTimers.concat(_cronTimers)) { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); }
  // Stop the telegram poll loop (avoid hanging in long-poll for 25s after SIGTERM)
  try { if (tgBot && tgBot.stop) tgBot.stop(); } catch (_) { /* best-effort: error intentionally swallowed */ }

  // Stop accepting new connections (no-op in test mode where httpServer is null)
  if (httpServer) httpServer.close(() => {
    logger.info('[Shutdown] HTTP server closed');
  });

  // Wait for pending writes to complete, then close DB and exit
  const allPending = Array.from(_fileLocks.values());
  Promise.all(allPending)
    .then(() => {
      try { db.close(); logger.info('[Shutdown] SQLite database closed'); } catch (_) { /* best-effort: error intentionally swallowed */ }
      logger.info('[Shutdown] All writes complete. Bye!');
      process.exit(0);
    })
    .catch((e) => {
      try { db.close(); } catch (_) { /* best-effort: error intentionally swallowed */ }
      logger.error('[Shutdown] Error during cleanup:', e.message);
      process.exit(1);
    });

  // Force exit after 10 seconds if writes don't complete
  setTimeout(() => {
    logger.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Crash-resilience: log unhandled async errors but keep the process alive.
// Without these handlers a single forgotten .catch() inside setInterval
// can take the dashboard down. We log to stderr, pino, and system_log so
// nothing slips through, then continue. uncaughtException is the only one
// we treat as fatal (per Node best practice the V8 state may be unsafe).
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  const msg = (reason && reason.stack) || (reason && reason.message) || String(reason);
  try { logger.error('[UnhandledRejection] ' + msg); } catch (_) { console.error('[UnhandledRejection]', msg); }
  try { logActivity('system', 'error', 'unhandled_rejection', null, 'Unhandled promise rejection', { reason: String(msg).slice(0, 1000) }); } catch (_) { /* best-effort: error intentionally swallowed */ }
});

process.on('uncaughtException', (err) => {
  const msg = (err && err.stack) || (err && err.message) || String(err);
  try { logger.error('[UncaughtException] ' + msg); } catch (_) { console.error('[UncaughtException]', msg); }
  try { logActivity('system', 'critical', 'uncaught_exception', null, 'Uncaught exception — restarting', { error: String(msg).slice(0, 1000) }); } catch (_) { /* best-effort: error intentionally swallowed */ }
  // Per Node docs: after uncaughtException the process is in undefined state.
  // Trigger graceful shutdown so pm2 restarts cleanly.
  try { gracefulShutdown('uncaughtException'); } catch (_) { process.exit(1); }
});

// Expose internals for the supertest harness (NODE_ENV=test). Production
// code paths don't reach for this — the start-via-`node server.js` flow
// runs to completion above and never `require()`s its own exports.
module.exports = { app, db };
