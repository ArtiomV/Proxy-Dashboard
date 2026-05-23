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
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const logger = require('./src/logger');
const { validate } = require('./src/middleware/validate');
// ClientUpdateSchema is consumed inside src/routes/clients.js (which imports
// from src/schemas directly). server.js only needs the schemas used in PUT
// routes that haven't been extracted, plus the create/payment/balance ones
// passed via deps.
const { LoginSchema, ClientCreateSchema, PaymentSchema, BalanceAdjustSchema } = require('./src/schemas');
const { getTzOffset, getMoscowNow, getMoscowToday, getMoscowYesterday } = require('./src/utils/time');
const { parseTrafficValue, parseBwToBytes, trafficBytesToGb, normalizeOperator } = require('./src/utils/traffic');
const proxySmart = require('./src/api/proxy-smart');
const hourlyTraffic = require('./src/traffic/hourly');
const { buildDocHtml: _buildDocHtml } = require('./src/documents/generator');
const { safeWriteFile: _safeWriteFile, _fileLocks } = require('./src/utils/files');
// JWT helpers now imported inside src/routes/tochka.js (via deps). server.js
// only keeps verifyJwtSignature because dbAudit's webhook signature check
// uses it on initial setup before the router mounts.
const { verifyJwtSignature } = require('./src/tochka/jwt');
const { tochkaRequest: _tochkaRequest } = require('./src/tochka/api');
const billing = require('./src/billing/atomic');
// MONTH_NAMES_RU / buildTochkaActBody / etc. moved into src/tochka/documents.js;
// server.js still needs the underscored exports for its nightly autoActs +
// autoBills crons (lines below). The router does its own require.
const {
  buildActItemsFromLedger: _buildActItemsFromLedger,
  buildTochkaActBody: _buildTochkaActBody,
  buildTochkaBillBody: _buildTochkaBillBody,
  calculateMonthlyBillAmount: _calculateMonthlyBillAmount,
} = require('./src/tochka/documents');
const tgBot = require('./src/telegram/bot');
const tgSummary = require('./src/telegram/daily_summary');
const aiInsights = require('./src/telegram/ai_insights');
const simulator = require('./src/simulator/engine');
const simulatorDb = require('./src/db/simulator');
const paymentsDb = require('./src/db/payments');
const documentsDb = require('./src/db/documents');
const clientsDb = require('./src/db/clients');
// Stage 14.1: state module hoisted near other requires so early
// initializers (tochkaConfig defaults, see below) can use it without TDZ.
const stateMod = require('./src/state');
const ledgerDb = require('./src/db/ledger');
const kvDb = require('./src/db/kv');
const trafficDb = require('./src/db/traffic');
const trackingDb = require('./src/db/tracking');
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
kvDb.init(db);
trafficDb.init(db);
trackingDb.init(db);
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
// kv_store prepared statements moved into src/db/kv.js (Stage 2 finish).
// Aliased here so the kv-guard layer below keeps its existing call sites.
const _kvGet = kvDb.getStmt();
const _kvSet = kvDb.setStmt();
const _kvHistoryInsert = kvDb.historyInsertStmt();
const _kvHistoryPrune = kvDb.historyPruneStmt();

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
  const _dbRow = _kvGet.get('api_servers');
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
  const rows = clientsDb.allRows();
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
      // Stage 13.2: stamp db_id so saveClients() can skip rows that
      // already exist in the DB. Without this every save call would
      // re-insert the entire history.
      db_id: r.id,
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
      // Remove deleted clients (ON DELETE CASCADE cleans sub-tables).
      const liveIds = new Set(clientsList.map(c => c.id));
      for (const r of clientsDb.allIds()) {
        if (!liveIds.has(r.id)) clientsDb.deleteById(r.id);
      }
      // Upsert clients + ADDITIVELY sync sub-arrays.
      //
      // Stage 13.2: this used to wipe each sub-table per client and reinsert
      // from the in-memory copy — a partial in-memory array would silently
      // erase real rows in the DB. The new contract is additive:
      //   - payments: rows without an `db_id` are NEW pushes → INSERT and
      //     stamp the returned rowid back on the entry so the next save
      //     call skips it.
      //   - documents / closing / bills: their `id` is a hex token assigned
      //     at push time; INSERT OR IGNORE means existing rows survive, new
      //     ones get appended.
      //   - Deletes of individual sub-entries are NOT handled here — the
      //     route that removes the in-memory entry MUST also call the
      //     corresponding xxxDb.deleteByXxx(id). saveClients no longer
      //     interprets "missing from memory" as "delete from DB".
      for (const c of clientsList) {
        clientsDb.upsertRow(c);
        // Stage 13.3: payments are no longer written from saveClients.
        // billing_ledger is the source of truth — atomicCredit already
        // wrote the row inside its txn when the payment was processed.
        // The legacy `payments` table is read-only now (kept so existing
        // rows stay visible; new ones won't appear).
        for (const d of (c.documents || []))        documentsDb.insertDoc(d, c.id);
        for (const d of (c.closingDocuments || [])) documentsDb.insertClosing(d, c.id);
        for (const b of (c.bills || []))            documentsDb.insertBill(b, c.id);
      }
    })();
  } catch (e) {
    logger.error('[SQLite] Error saving clients:', e.message);
  }
}

const BILLING_LEDGER_FILE = path.join(__dirname, 'billing_ledger.json'); // legacy JSON fallback
// _ledgerDeleteByClient / _ledgerInsert moved into src/db/ledger.js.
// _ledgerInsert alias is already created near the init block at the top.

// Stage 4: in-memory `billingLedger` mirror REMOVED. Every reader now calls
// `ledgerDb.listByClient(clientId)` which reads fresh DB rows on each call.
// One-shot migration: if billing_ledger table is empty AND the legacy JSON
// file from pre-SQLite days exists, import its contents into the table.
{
  const _blCount = ledgerDb.rowCount();
  if (_blCount === 0 && fs.existsSync(BILLING_LEDGER_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(BILLING_LEDGER_FILE, 'utf8'));
      let migrated = 0;
      db.transaction(() => {
        for (const [clientId, entries] of Object.entries(legacy || {})) {
          if (!Array.isArray(entries)) continue;
          for (const e of entries) {
            _ledgerInsert.run(..._ledgerEntryParams(clientId, e));
            migrated++;
          }
        }
      })();
      if (migrated > 0) logger.info(`[SQLite] Migrated ${migrated} billing ledger entries from legacy JSON → DB`);
    } catch (e) { logger.error('[SQLite] Failed to migrate billing_ledger from JSON:', e.message); }
  } else if (_blCount > 0) {
    logger.info(`[SQLite] billing_ledger has ${_blCount} rows (loaded on-demand via ledgerDb)`);
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

function auditLog(adminLogin, action, details = {}) {
  try {
    const ts = new Date().toISOString();
    dbStmts.insertAudit.run(ts, adminLogin, action, JSON.stringify(details));
  } catch (e) {
    logger.error('[AuditLog] Write failed:', e.message);
  }
}

// Pagination helper — same shape across endpoints. Caps limit at `hardMax`
// (route-defined) and `MAX_PAGE_LIMIT` (global). Returns { limit, offset }.
// Usage: const { limit, offset } = parsePage(req, { defaultLimit: 50, hardMax: 200 });
const MAX_PAGE_LIMIT = 1000;

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
// Stage 14.1: tochkaConfig moved into src/state/index.js. Const alias to
// the SAME object reference for the process lifetime — saveTochkaConfig
// rebinds in place via setTochkaConfig() so routers holding the
// reference always see fresh fields.
stateMod.setTochkaConfig({ jwt: '', clientId: '', customerCode: '', accountId: '', companyName: '', companyInn: '', companyKpp: '', companyAddress: '', bankAccount: '', bankName: '', bankBic: '', bankCorrAccount: '' });
const tochkaConfig = stateMod.state.tochkaConfig;

// AES-256-GCM at-rest encryption for tochka_config.json.
//
// Stage 12: redesigned the key derivation so a hostname change can no
// longer lock the operator out of the config (that already happened
// once — see FOLLOWUP "Tochka config decryption is fragile").
//
// Key sources, in PREFERENCE order (used to encrypt new writes):
//   1. $TOCHKA_CONFIG_KEY env var (64 hex chars). EXPLICIT, PREFERRED.
//   2. /etc/machine-id (Linux/systemd; survives `hostnamectl set-hostname`).
//   3. Legacy hostname+platform hash. Kept only so existing files
//      encrypted before Stage 12 can still be decrypted.
//
// Decryption tries ALL three keys in turn — whichever works wins.
// On success with a NON-preferred key, the next saveTochkaConfig() will
// re-encrypt with the highest-priority available key, completing the
// migration silently. We log a WARN whenever we fall through past (1).
function _tochkaCryptKey_env() {
  const env = process.env.TOCHKA_CONFIG_KEY;
  return (env && /^[0-9a-f]{64}$/i.test(env)) ? Buffer.from(env, 'hex') : null;
}
function _tochkaCryptKey_machineId() {
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (!id) return null;
    return crypto.createHash('sha256').update('tochka-config-v1|machine-id|' + id).digest();
  } catch (_) { return null; }
}
function _tochkaCryptKey_legacy() {
  return crypto.createHash('sha256')
    .update('tochka-config-v1|' + os.hostname() + '|' + process.platform)
    .digest();
}
// Preferred key for NEW encryption (used by saveTochkaConfig).
function _tochkaCryptKey() {
  return _tochkaCryptKey_env() || _tochkaCryptKey_machineId() || _tochkaCryptKey_legacy();
}
// All candidate keys for DECRYPTION, ordered by preference.
function _tochkaCryptKeyCandidates() {
  const out = [];
  const env = _tochkaCryptKey_env(); if (env) out.push({ key: env, name: 'env' });
  const mid = _tochkaCryptKey_machineId(); if (mid) out.push({ key: mid, name: 'machine-id' });
  out.push({ key: _tochkaCryptKey_legacy(), name: 'legacy-hostname' });
  return out;
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
  // Stage 12: try every candidate key in preference order. The first one
  // that authenticates wins — GCM tag verification means a wrong key
  // throws synchronously, no risk of silent garbage output.
  const candidates = _tochkaCryptKeyCandidates();
  let lastErr = null;
  for (const { key, name } of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
      const buf = Buffer.concat([decipher.update(Buffer.from(wrap.ct, 'base64')), decipher.final()]);
      if (name !== 'env') {
        logger.warn(`[Tochka] config decrypted with fallback key '${name}'. Set $TOCHKA_CONFIG_KEY to lock the key explicitly — next saveTochkaConfig() will re-encrypt with the preferred key.`);
      }
      return JSON.parse(buf.toString('utf8'));
    } catch (e) { lastErr = e; /* try next */ }
  }
  throw lastErr || new Error('tochka config decrypt failed: no candidate key worked');
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
// Stage 15.1: returns the promise so admin routes can `await` it before
// responding (so the UI never sees "saved" without an on-disk write).
// safeWriteFile's internal .catch() already swallows rejections (the
// returned promise resolves either way) — we add an explicit .catch
// hook here so caller-side rejections still surface in our logs even if
// the internal one is bypassed in the future.
function saveTochkaConfig() {
  return safeWriteFile(TOCHKA_CONFIG_FILE, _encryptJson(tochkaConfig))
    .catch(e => { logger.error('[Tochka] saveTochkaConfig failed:', e.message); });
}

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
let lastActGenerationMonth  = (_kvGet.get('last_act_generation_month')  || {}).value || '';
let lastBillGenerationMonth = (_kvGet.get('last_bill_generation_month') || {}).value || '';

// Extracted to src/tochka/documents.js — buildTochkaActBody, buildActItemsFromLedger, buildTochkaBillBody, calculateMonthlyBillAmount, MONTH_NAMES_RU
function buildActItemsFromLedger(client, period) {
  return _buildActItemsFromLedger(client, period, (id) => ledgerDb.listByClient(id));
}
function buildTochkaActBody(client, period, actItems, actNumber) {
  return _buildTochkaActBody(tochkaConfig, client, period, actItems, actNumber);
}
function buildTochkaBillBody(client, amount, billNumber, billDate) {
  return _buildTochkaBillBody(tochkaConfig, client, amount, billNumber, billDate);
}
function calculateMonthlyBillAmount(client, cachedResults) {
  return _calculateMonthlyBillAmount(client, cachedResults, (id) => ledgerDb.listByClient(id));
}

// Stage 14.1: dailyTraffic moved to state.dailyTraffic (stable ref). No
// rebinds in this file — all mutations are property assignments, so a
// const alias is enough. Routers receive `dailyTraffic` via deps and see
// the same object reference for the process lifetime.
const dailyTraffic = stateMod.state.dailyTraffic; // { portKey: { "2026-03-01": { in: bytes, out: bytes, portName }, ... } }

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
  trafficDb.dailyPurge90dStmt().run();
  const rows = trafficDb.dailyLast90dStmt().all();
  for (const r of rows) {
    if (!dailyTraffic[r.port_name]) dailyTraffic[r.port_name] = {};
    dailyTraffic[r.port_name][r.date] = { in: r.bytes_in, out: r.bytes_out };
  }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} daily traffic entries`);
} catch (e) { logger.error('Failed to load daily_traffic from SQLite:', e.message); }

// daily_traffic / traffic_hourly / hourly_snapshots / api_usage prepared
// statements moved into src/db/traffic.js (Stage 2 finish).
const _dtUpsert = trafficDb.dailyUpsertStmt();
const _htUpsert = trafficDb.hourlyUpsertStmt();
const _snapUpsert = trafficDb.snapshotUpsertStmt();
const _snapGet = trafficDb.snapshotGetStmt();
const _snapGetAll = trafficDb.snapshotGetAllStmt();
const _apiUsageInsert = trafficDb.apiUsageInsertStmt();
// Stage 4 finish: runRetentionCleanup + cleanupStalePortMappings moved to
// src/jobs/cleanup.js (~225 lines). server.js keeps thin wrappers; the
// underlying factory is created lazily on first call because several
// dependencies (SERVER_CACHE_FILE, appSettings, dailyTraffic, ipTracking
// etc.) are declared later in this file and would TDZ at module-load time.
let _cleanupJobs = null;
function _initCleanupJobs() {
  if (_cleanupJobs) return _cleanupJobs;
  _cleanupJobs = require('./src/jobs/cleanup').create({
    db, logger, fs, SERVER_CACHE_FILE,
    // Pass the LET-bound containers by getter so the job sees fresh content
    // even if appSettings / dailyTraffic / etc. get mutated later.
    get appSettings() { return appSettings; },
    get dailyTraffic() { return dailyTraffic; },
    get ipTracking() { return ipTracking; },
    get uptimeTracking() { return uptimeTracking; },
    get modemRotationCache() { return modemRotationCache; },
    get knownModems() { return knownModems; },
    saveKnownModems: (...a) => saveKnownModems(...a),
    logActivity: (...a) => logActivity(...a),
  });
  return _cleanupJobs;
}
function runRetentionCleanup() { return _initCleanupJobs().runRetentionCleanup(); }
function cleanupStalePortMappings() { return _initCleanupJobs().cleanupStalePortMappings(); }


// Closure for hourly.js dependency (replaces prepared statement)
const _htCleanup = () => {
  const days = Number.isInteger(appSettings.retention_traffic_hourly) && appSettings.retention_traffic_hourly >= 7
    ? appSettings.retention_traffic_hourly : 90;
  return trafficDb.hourlyPurgeOlderThan(db, days);
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
// Stage 14.1: stable reference via state. refreshPortKeyMapping used to
// rebind the binding (`portKeyToPortName = map`) — routers that already
// destructured the old reference would see stale data. Now we replace
// CONTENTS in place via setPortKeyToPortName().
const portKeyToPortName = stateMod.state.portKeyToPortName;
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
  stateMod.setPortKeyToPortName(map);
}

// Last billing run metadata (for /health and retry logic)
let lastBillingRunSummary = null;
let lastReconciliationMonth = (_kvGet.get('last_reconciliation_month') || {}).value || '';

const KNOWN_MODEMS_FILE = path.join(__dirname, 'known_modems.json');
// Stage 14.1: stable reference via state. Load mutates in place.
const knownModems = stateMod.state.knownModems; // { serverName: { portId: { portName, imei, nick, model, portInfo, lastSeen } } }
try {
  if (fs.existsSync(KNOWN_MODEMS_FILE)) {
    stateMod.setKnownModems(JSON.parse(fs.readFileSync(KNOWN_MODEMS_FILE, 'utf8')));
  }
} catch (e) { logger.error('Failed to load known_modems:', e.message); }

function saveKnownModems() {
  // Stage 15.1: explicit .catch so a write failure is surfaced even if a
  // future safeWriteFile internal change stops swallowing rejections.
  // Returning the promise lets future callers `await` if needed.
  return safeWriteFile(KNOWN_MODEMS_FILE, JSON.stringify(knownModems, null, 2))
    .catch(e => { logger.error('[saveKnownModems] write failed:', e.message); });
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

// Stage 4 finish: clients[] + 5 derived maps moved to src/state/index.js.
// We hold const aliases to the state-module objects — they're now stable
// identities for the process lifetime, mutated in place by setClients() +
// rebuildMaps(). Route mounts no longer need shim objects with .get()
// wrappers. (Stage 14.1 hoisted the `require('./src/state')` to the top
// of the file so tochkaConfig defaults can use it earlier.)
stateMod.setClients(loadClients());
const clients = stateMod.state.clients;
const clientById         = stateMod.state.clientById;
const clientByLogin      = stateMod.state.clientByLogin;
const clientByApiKey     = stateMod.state.clientByApiKey;
const clientByInn        = stateMod.state.clientByInn;
const clientByResetToken = stateMod.state.clientByResetToken;

function rebuildClientMaps() {
  stateMod.rebuildMaps();
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
// Stage 4: pass a getClientById getter instead of the Map directly.
// server.js rebinds `clientById = new Map(...)` during state rebuilds;
// the getter re-reads the current binding on every credit/debit so the
// in-memory mirror stays in sync (previously the captured Map went
// stale → HTTP responses showed `balance: 0` after any client create).
// Stage 4 finish: the in-memory `billingLedger` mirror is gone — atomic.js
// no longer maintains a JS-side ledger copy.
billing.init({
  db, _clientGetBalance, _clientUpdateBalance, _ledgerInsert, _ledgerEntryParams,
  // Stage 13.1: atomic.js now owns the referral credit/debit so a route
  // can no longer leave the txn open between balance update and referral
  // bump. Pass the prepared stmt; atomic.js runs it INSIDE the same txn.
  _clientUpdateReferralBalance,
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

// Stage 14.1: appSettings lives in state with stable identity. Rebinds
// (was `appSettings = {...}` on reload) were the most dangerous variant
// of this bug — settings are read on every request by virtually every
// route. setAppSettings() replaces CONTENTS in place; routers that took
// the reference at mount time always see fresh fields.
stateMod.setAppSettings({ ...SETTINGS_DEFAULTS });
const appSettings = stateMod.state.appSettings;
try {
  const row = _kvGet.get('app_settings');
  if (row) {
    stateMod.setAppSettings({ ...SETTINGS_DEFAULTS, ...JSON.parse(row.value) });
  } else {
    // One-time migration from settings.json
    const SETTINGS_FILE = path.join(__dirname, 'settings.json');
    if (fs.existsSync(SETTINGS_FILE)) {
      stateMod.setAppSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
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

// Stage 14.2: single contract for appSettings access. Every caller (routes,
// jobs, telegram bot, simulator) goes through getSetting / setSetting now.
// Direct mutation (`appSettings.x = ...`) is the path of the historical
// inconsistency where servers.js skipped the disk save — easy to forget.
//
// getSetting(key, def) — reads from state.appSettings; falls back to `def`.
// setSetting(key, val) — mutates state.appSettings in place AND persists.
//   Use setSettings({a:1, b:2}) for batch updates that save only once.
function getSetting(key, def) {
  return appSettings[key] !== undefined ? appSettings[key] : def;
}
function setSetting(key, val) {
  appSettings[key] = val;
  saveSettings();
}
function setSettings(partial) {
  if (!partial || typeof partial !== 'object') return;
  Object.assign(appSettings, partial);
  saveSettings();
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
  const r1 = trafficDb.hourlyByClientDateStmt().get(portName, date);
  if (r1.bytes > 0) return r1.bytes;
  // Fallback — daily_traffic stores by port_id; resolve via in-memory map
  const portIds = [];
  for (const [k, v] of Object.entries(portKeyToPortName)) {
    if (v === portName) portIds.push(k);
  }
  return trafficDb.dailySumByDateAndPorts(db, date, portIds);
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
// CSP restored after Stage 5 (inline <script> blocks extracted into
// public/js/admin.js + client.js). Inline `onclick="…"` attributes in
// generated HTML are allowed via script-src-attr 'unsafe-inline' — the
// pragmatic compromise; migrating to event delegation is FOLLOWUP work.
// Chart.js CDN whitelisted by hash via the existing <script integrity>
// attribute; 'self' covers the extracted local JS.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src':  ["'self'", 'https://cdn.jsdelivr.net'],
      'script-src-attr': ["'unsafe-inline'"],   // inline onclick="…" in admin.js-rendered HTML
      'style-src':   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src':    ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src':     ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
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
  // Getter form so the router sees the current `clients` binding (let-rebound
  // on reload). Stage 4 removed the in-memory ledger mirror — ops.js reads
  // billing_ledger row count via its own DB statement.
  getClients: () => clients,
}));

// Admin health — detailed info

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

// POST /api/admin/monthly_costs
// Body: { period: 'YYYY-MM', items: [{category, subkey, amount, notes}, ...] }
// Перезаписывает строки за период (атомарно).

// GET /api/admin/finance_dashboard
// Считает все метрики для финансового дашборда.
// MRR — trailing 30d revenue per client. NRR — 3-month cohort.
// Cached for 60s — recomputation is heavy (~200ms with 30+ aggregations).
let _financeCache = null;
let _financeCacheTs = 0;
let _financeCacheKey = '';
const FINANCE_CACHE_TTL_MS = 60 * 1000;

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

// /api/admin/run_billing + /api/admin/billing_rerun moved into src/routes/billing.js (Stage 3).
app.use(require('./src/routes/billing')({
  db, logger, authMiddleware, adminMiddleware,
  runDailyBilling, _startJob,
  getMoscowToday, getClientBytesForMskDate, trafficBytesToGb,
  atomicDebit, saveClients, modemPlural, logActivity, auditLog,
  getClients: () => clients,
}));

// Re-run billing for a specific past MSK date.
// Use case: a ProxySmart server was offline at midnight, its yesterday counters
// reset to 0, and the original daily billing produced empty / partial charges.
// This recomputes from the durable traffic_hourly source.
//
// Body: { date: "YYYY-MM-DD", client_ids?: [string], dry_run?: bool }
// - date is required and must be in the past (today is still active)
// - client_ids optional; if omitted, processes all clients without an existing charge
// - dry_run prints what would happen without writing

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
const ipTracking = stateMod.state.ipTracking; // Stage 14.1
try {
  const rows = trackingDb.ipAllStmt().all();
  for (const r of rows) ipTracking[r.key] = { ip: r.ip, since: r.updated_at };
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} IP tracking entries`);
} catch (e) { logger.error('Failed to load ip_tracking from SQLite:', e.message); }

// Auto-recovery: track offline modems for automatic USB reset
// { 'S1_IMEI': { offlineSince: timestamp, attempts: 0, lastAttempt: timestamp } }
const autoRecovery = {};

// Load uptime tracking from SQLite
const uptimeTracking = stateMod.state.uptimeTracking; // Stage 14.1
try {
  const rows = trackingDb.utAllStmt().all();
  for (const r of rows) { try { uptimeTracking[r.key] = JSON.parse(r.data); } catch (_) { /* best-effort: error intentionally swallowed */ } }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} uptime tracking entries`);
} catch (e) { logger.error('Failed to load uptime_tracking from SQLite:', e.message); }

// Load IP history from SQLite (with db_id for incremental updates)
const ipHistory = stateMod.state.ipHistory; // Stage 14.1
try {
  const rows = trackingDb.ihAllOrderStmt().all();
  for (const r of rows) {
    if (!ipHistory[r.key]) ipHistory[r.key] = [];
    ipHistory[r.key].push({ db_id: r.id, ip: r.ip, from: r.started_at, to: r.ended_at || null });
  }
  if (rows.length > 0) logger.info(`[SQLite] Loaded ${rows.length} IP history entries`);
} catch (e) { logger.error('Failed to load ip_history from SQLite:', e.message); }

// ip_tracking / uptime_tracking / ip_history statements → src/db/tracking.js
const _ipUpsert = trackingDb.ipUpsertStmt();
const _utUpsert = trackingDb.utUpsertStmt();
const _ihInsert = trackingDb.ihInsertStmt();
const _ihUpdateEnd = trackingDb.ihUpdateEndStmt();
const _ihDeleteById = trackingDb.ihDeleteByIdStmt();

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
// modem_meta statements → src/db/tracking.js
const _modemMetaUpsert = trackingDb.modemMetaUpsertStmt();
const _metaOpGet = trackingDb.metaOperatorGetStmt();

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
  const cleaned = trafficDb.hourlyAutoSmoothUncertainStmt().run();
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
  // Stage 15.1: explicit .catch — see saveKnownModems for rationale.
  return safeWriteFile(SPEEDTEST_HISTORY_FILE, JSON.stringify(speedtestHistory, null, 2))
    .catch(e => { logger.error('[saveSpeedtestHistory] write failed:', e.message); });
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

// Client-portal routes (+ /api/dashboard_data, /api/billing_history) moved
// to src/routes/client-portal.js (Stage 3). Client maps are rebound by
// rebuildClientMaps() so we pass tiny shim objects with .get() that re-reads
// the current binding via closure — same root cause as Stage 4 atomic.js fix.
app.use(require('./src/routes/client-portal')({
  db, logger, authMiddleware, dashboardLimiter, resetTokenLimiter,
  fetchAllServersDataCached, mergeServerData, fetchApi, postApi, findServer,
  extractServerName,
  getMoscowToday, getMoscowNow, trafficBytesToGb, parseBwToBytes, parseTrafficValue,
  ledgerExpense, SERVER_COUNTRIES,
  // syncRotationLog + _rlSelect are defined later in server.js, so we
  // pass tiny lazy wrappers that resolve at call time.
  syncRotationLog: function (...args) { return syncRotationLog.apply(null, args); },
  _rlSelect: { all: (...args) => _rlSelect.all(...args) },
  apiServers,
  clients,
  // Stage 4 finish: maps are stable references via src/state — no more shims.
  clientById, clientByLogin, clientByApiKey, clientByResetToken,
  dailyTraffic, ledgerDb, ipTracking, uptimeTracking, ipHistory,
  DOCUMENTS_DIR,
  getTochkaConfig: () => tochkaConfig,
  getSpeedtestLatest,
  auditLog, logActivity, getClientIp,
  saveClients,
}));

// All traffic endpoints moved to src/routes/traffic.js (Stage 3).
app.use(require('./src/routes/traffic')({
  db, logger, authMiddleware, adminMiddleware,
  fetchAllServersDataCached, mergeServerData,
  fetchApi, postApi, findServer,
  getMoscowToday, trafficBytesToGb, parseBwToBytes, parseTrafficValue,
  normalizeOperator,
  clients, clientByLogin, clientById,
  dailyTraffic, portKeyToPortName,
  knownModems, SERVER_COUNTRIES,
  _dtUpsert,
  refreshPortKeyMapping,
  logActivity,
}));



// Accept BOTH POST (correct semantic for state-changing op) and GET
// (backwards-compat for existing client integrations & emailed URLs).
// New integrations should use POST.







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

// /api/admin/cache/invalidate + /admin + /api/docs + /api/admin/vpn_profile
// + /api/admin/shop_report moved into src/routes/misc.js (Stage 3).
app.use(require('./src/routes/misc')({
  logger, authMiddleware, adminMiddleware,
  proxySmart, findServer, fetchApi, fetchApiRaw,
}));


// Auto-reboot history — last N reboots triggered by the flaky-modem watcher

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

// Phase 2: API usage stats + recent log for a given client.
// Query params: client_id (required), days (1-30, default 7), limit (1-500, default 100).

// Backfill daily_traffic for a given MSK date by summing traffic_hourly rows.
// Use when bandwidth_bytes_yesterday_* came back as 0 from ProxySmart
// (e.g. after a ProxySmart restart around midnight) and the daily chart
// shows a hole. traffic_hourly is written independently by hourly.js and
// survives these cases. Safe to run multiple times — UPSERT uses MAX.

// All /api/analytics/* routes moved to src/routes/analytics.js (Stage 3).
app.use(require('./src/routes/analytics')({
  db, logger, authMiddleware, adminMiddleware,
  fetchAllServersDataCached, mergeServerData,
  getMoscowToday, getMoscowNow, getTzOffset,
  trafficBytesToGb, parseTrafficValue, parseBwToBytes,
  normalizeOperator,
  SERVER_COUNTRIES,
  computeClientSlaMetrics,
  clients, clientById, clientByLogin,
  dailyTraffic, ipTracking, uptimeTracking, knownModems,
  portKeyToPortName,
  appSettings,
  apiServers,
}));

// Heatmap response cache: key=view|id|days, TTL 5 min.
// Heatmap data only changes once per hour (when hourly aggregation runs),
// so a 5-min cache saves ~hundreds of strftime invocations per request.
const _heatmapCache = new Map();
const HEATMAP_TTL_MS = 5 * 60 * 1000;


// Per-port heatmap for a specific modem (nick)


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
// Proxy-checks + top-hosts routes moved to src/routes/proxy-checks.js (Stage 3).
app.use(require('./src/routes/proxy-checks')({
  db, logger, authMiddleware, adminMiddleware, checkProxyLimiter,
  fetchAllServersDataCached, fetchApi, findServer,
  apiServers, SERVER_COUNTRIES,
  curlCheckProxy, normalizeOperator,
  dbStmts,
  appSettings,
  // topHostsCache + aggregateTopHosts defined later in server.js → lazy refs
  getTopHostsCache: () => topHostsCache,
  aggregateTopHosts: (...args) => aggregateTopHosts(...args),
}));

// Latency analytics — daily percentiles, overall distribution, and prior-period
// comparison. Used by the "Распределение задержек" card.

// Latency per-day scatter — individual check points for a single day

// ============================================================================
// PHASE 3 — "Система" tab analytics endpoints
// ============================================================================

// 3.1 Modem health: per-modem uptime, latency, errors, rotations, traffic, score

// 3.2 Rotation analytics

// 3.3 IP analytics

// 3.4 Traffic forecast — per-client linear regression + runway (days of balance left)

// 3.5 Capacity planning

// 3.6 System health dashboard

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
  const checks = trackingDb.slaClientChecks24hStmt().get(client.portName);

  // Uptime over 30 days — polling-based, aggregated across the client's modems.
  // Uses the same uptimeTracking source as the per-modem health score so all
  // dashboard uptime numbers are computed from one canonical signal (5-min
  // ping checks against ProxySmart). Replaces the old traffic-based formula
  // which inflated downtime whenever clients didn't transmit traffic.
  const UPTIME_DAYS = 30;
  const utCutoffDate = new Date(Date.now() - UPTIME_DAYS * 86400000).toISOString().slice(0, 10);

  // Find this client's modems (any that produced proxy_check rows in the window).
  // Includes the IMEI for the uptimeTracking lookup.
  const clientModems = trackingDb.slaClientModemsStmt().all(client.portName, `-${UPTIME_DAYS} days`);

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
    const insertViolation = trackingDb.slaInsertViolationStmt();
    const existsStmt = trackingDb.slaExistsViolationStmt();

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
// SLA routes moved into src/routes/sla.js (Stage 3).
app.use(require('./src/routes/sla')({
  db, logger, authMiddleware, adminMiddleware,
  computeClientSlaMetrics,
  getClientById: (id) => clientById.get(id),
  getClients: () => clients,
}));

// Manual proxy check (single or bulk)

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
// Admin clients routes moved to src/routes/clients.js (Stage 3).
// Mutable client maps wrapped to follow rebinds (rebuildClientMaps).
app.use(require('./src/routes/clients')({
  db, logger, authMiddleware, adminMiddleware,
  validate, ClientCreateSchema, PaymentSchema, BalanceAdjustSchema,
  fetchAllServersDataCached, mergeServerData, fetchApi,
  atomicCredit, atomicDebit,
  saveClients, rebuildClientMaps,
  deleteSessionsByLogin,
  auditLog, logActivity, getClientIp,
  generateId,
  clients,
  // Stage 4 finish: maps are stable references via src/state — no more shims.
  clientById, clientByLogin, clientByApiKey, clientByInn, clientByResetToken,
  users,
  _ledgerInsert, _ledgerEntryParams, ledgerDb, clientsDb, paymentsDb, documentsDb,
  DOCUMENTS_DIR,
  validateClientInput,
  appSettings,
}));



// DELETE client -- with port protection


// Manual charge (debit) from client balance











// CRM translate endpoint removed — translations applied directly to DB

// API Servers management
// Servers + settings routes moved to src/routes/servers.js (Stage 3).
app.use(require('./src/routes/servers')({
  logger, authMiddleware, adminMiddleware,
  apiServers, SERVER_COUNTRIES, appSettings,
  fetchApi, saveApiServersToDb, proxySmart,
  auditLog, getClientIp,
  setSettings, rescheduleSpeedtests, rescheduleProxyCheck,
}));






// Send a test telegram summary for an arbitrary date (default = yesterday MSK).
// Telegram + AI insights + CRM moved into src/routes/telegram-crm.js (Stage 3).
app.use(require('./src/routes/telegram-crm')({
  logger, authMiddleware, adminMiddleware,
  tgBot, tgSummary, aiInsights,
  getAppSettings: () => appSettings,
}));

// Shared handler for modem control actions (reduces duplication)
// Modem + port control routes moved to src/routes/proxies.js (Stage 3).
app.use(require('./src/routes/proxies')({
  db, logger, authMiddleware, adminMiddleware,
  fetchApi, fetchApiRaw, postApi, postFormApi, findServer,
  parseHtmlInputFields,
  apiServers, SERVER_COUNTRIES,
  users,
  auditLog, logActivity, getClientIp,
  proxySmart,
  saveKnownModems,
  knownModems,
  saveSpeedtestHistory, speedtestHistory,
  pushSpeedtestEntry,
  ipHistory, saveIpHistory,
  modemRotationCache,
  fetchAllServersDataCached,
  syncRotationLog: (...args) => syncRotationLog(...args),
  _rlSelect: { all: (...args) => _rlSelect.all(...args) },
}));





// Restart the dashboard process (pm2 will auto-restart)




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




// Rotation log: fetch from ProxySmart, sync to SQLite, return from DB
// rotation_log statements → src/db/tracking.js
const _rlUpsert = trackingDb.rotationUpsertStmt();
const _rlSelect = trackingDb.rotationSelectStmt();

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











// Move port to a different modem (change IMEI assignment)

// Update proxy credentials (login/password) for an existing port

// Get full port configuration from ProxySmart edit form

// Save full port configuration via ProxySmart form endpoint

// Bulk set OS spoofing on multiple ports
// Bulk set OS spoofing on multiple ports

// Bulk set auto-rotation on multiple modems









// /api/admin/vpn_profile + /api/admin/shop_report moved into src/routes/misc.js.


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

// Stage 4 finish: aggregateTopHosts (113 lines) moved to
// src/jobs/top-hosts.js. Lazy init; the setter rebinds the let above so
// /api/admin/top_hosts_aggregated reads the freshest snapshot.
let _topHostsJob = null;
function _initTopHostsJob() {
  if (_topHostsJob) return _topHostsJob;
  _topHostsJob = require('./src/jobs/top-hosts').create({
    db, logger,
    get apiServers() { return apiServers; },
    SERVER_COUNTRIES,
    fetchApi, normalizeOperator,
    _kvSet,
    logActivity,
    setTopHostsCache: (v) => { topHostsCache = v; },
  });
  return _topHostsJob;
}
async function aggregateTopHosts() { return _initTopHostsJob().aggregateTopHosts(); }

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
      const existingCharge = ledgerDb.existsChargeOnDate(yesterdayCheck);
      if (existingCharge) return { skip: true, reason: `Already billed for ${yesterdayCheck}` };
    } else {
      const chargedIds = ledgerDb.chargedClientIdsForDate(yesterdayCheck);
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
  _kvSet.run('last_reconciliation_month', prevMonthStr);
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

    const entries = ledgerDb.listByClient(client.id);
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

// Stage 4 finish: autoCreateMissingClients + autoGenerateMonthly{Acts,Bills}
// moved to src/jobs/tochka-cron.js. Lazy initialization for the same TDZ
// reason as the cleanup module (getMoscowNow / tochkaConfig / clients /
// getTochkaConfig / etc. are declared later in this file).
let _tochkaCronJobs = null;
function _initTochkaCronJobs() {
  if (_tochkaCronJobs) return _tochkaCronJobs;
  _tochkaCronJobs = require('./src/jobs/tochka-cron').create({
    db, logger,
    fetchAllServersDataCached, fetchAllServersData,
    clients, users,
    saveClients, rebuildClientMaps,
    logActivity, generateId,
    getPriceForProxyCount,
    ledgerDb,
    getMoscowNow,
    getTochkaConfig: () => tochkaConfig,
    tochkaRequest,
    buildActItemsFromLedger, buildTochkaActBody,
    buildTochkaBillBody, calculateMonthlyBillAmount,
    getLastActGenerationMonth:  () => lastActGenerationMonth,
    setLastActGenerationMonth:  (v) => { lastActGenerationMonth = v; },
    getLastBillGenerationMonth: () => lastBillGenerationMonth,
    setLastBillGenerationMonth: (v) => { lastBillGenerationMonth = v; },
  });
  return _tochkaCronJobs;
}
async function autoCreateMissingClients()  { return _initTochkaCronJobs().autoCreateMissingClients(); }
async function autoGenerateMonthlyActs()   { return _initTochkaCronJobs().autoGenerateMonthlyActs(); }
async function autoGenerateMonthlyBills()  { return _initTochkaCronJobs().autoGenerateMonthlyBills(); }

// /admin + /api/docs + /api/admin/{cache/invalidate, vpn_profile, shop_report}
// moved into src/routes/misc.js (Stage 3) — mount is above near cache/invalidate.

// Accept raw text body for webhook
// Tochka routes (webhook + admin tochka + per-client closing_documents/bills)
// moved to src/routes/tochka.js (Stage 3). The webhook uses a raw text body
// parser; the router applies it internally via express.text() per-route.
app.use(require('./src/routes/tochka')({
  db, logger, authMiddleware, adminMiddleware,
  verifyJwtSignature, _pickField, insertBankPaymentToDb,
  dbAudit, dbStmts, bankPaymentFromRow, getAllBankPayments,
  tochkaConfig, saveTochkaConfig,
  atomicCredit,
  saveClients, rebuildClientMaps,
  auditLog, logActivity, getClientIp,
  appSettings,
  clients,
  // Stage 4 finish: maps are stable references via src/state — no more shims.
  clientById, clientByLogin, clientByInn,
  apiServers, SERVER_COUNTRIES,
  fetchAllServersDataCached,
  getMoscowToday,
  ledgerDb, clientsDb, documentsDb,
  // runTochkaSync is defined later in this file — pass a lazy wrapper that
  // resolves at call time so the mount doesn't TDZ.
  runTochkaSync: (...args) => runTochkaSync(...args),
}));

// Save Tochka config from admin UI

// Get Tochka config

// Auto-detect Customer Code and Account ID from Tochka API

// Register webhook in Tochka

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


// Get Tochka status / bank payments log

// Dismiss unmatched payments (hide them)

// Dismiss single payment

// Manually match unmatched payment to client

// Create closing document (Акт выполненных работ)

// Get closing documents for client (client-side)

// Download closing document PDF from Tochka

// Admin: download closing document PDF

// escHtml extracted to src/utils/html.js
// buildDocHtml extracted to src/documents/generator.js

function buildDocHtml(type, doc, client, billAmount) {
  return _buildDocHtml(type, doc, client, billAmount, tochkaConfig);
}

// Admin: HTML print for closing document (act)

// Admin: change closing document status (signed/unsigned)

// Admin: delete closing document

// Admin: get closing documents for a client

// Admin: get ALL closing documents across all clients (for bank tab overview)

// Admin: bulk generate acts for a specific period for all clients with charges

// Create bill for a client

// Generate bills for all clients

// Get all bills across all clients

// Download bill PDF

// Admin: HTML print for bill

// Change bill status

// Delete bill

// Client-side: get bills

// Client-side: download bill PDF


// System activity log viewer

// Simulator routes moved into src/routes/simulator.js (Stage 3).
app.use(require('./src/routes/simulator')({
  db, logger, authMiddleware, adminMiddleware,
  simulator, simulatorDb,
  fetchAllServersDataCached, SERVER_COUNTRIES,
  auditLog,
}));

// Late-mount ops-extension + billing-extension (Stage 3 finish).
app.use(require('./src/routes/ops-ext')({
  db, logger, DB_PATH,
  authMiddleware, adminMiddleware, dashboardLimiter,
  fs, path, dbStmts, dbAudit,
  appSettings,
  getAllBankPayments,
  getSessionCount: () => getSessionCount(),
  getClients: () => clients,
  getApiServers: () => apiServers,
  getServerCountries: () => SERVER_COUNTRIES,
  getRunningJobs: () => _jobs,
  getLastBillingRunSummary: () => lastBillingRunSummary,
  getLastReconciliationMonth: () => lastReconciliationMonth,
  getIntervals: () => _intervals,
  getFetchAllServersDataCached: () => fetchAllServersDataCached,
  getMergeServerData: () => mergeServerData,
  getIpTracking: () => ipTracking,
  getUptimeTracking: () => uptimeTracking,
  getIpHistory: () => ipHistory,
  getDailyTraffic: () => dailyTraffic,
  getPortKeyToPortName: () => portKeyToPortName,
  getTochkaConfig: () => tochkaConfig,
  getProxyCheckSummary: () => getProxyCheckSummary(),
  computeProxyIssues: (...args) => computeProxyIssues(...args),
  fetchApi: (...args) => fetchApi(...args),
  findServer: (...args) => findServer(...args),
  getSpeedtestLatest: () => getSpeedtestLatest(),
  _getClientTrend: () => _getClientTrend(),
  _getModemTrend: () => _getModemTrend(),
  logActivity,
  getMoscowNow, getMoscowYesterday,
  ledgerExpense, parseBwToBytes, trafficBytesToGb,
}));

app.use(require('./src/routes/billing-ext')({
  db, logger, authMiddleware, adminMiddleware,
  getClients: () => clients,
  clientById,
  getFetchAllServersDataCached: () => fetchAllServersDataCached,
  getMergeServerData: () => mergeServerData,
  getPortKeyToPortName: () => portKeyToPortName,
  getDailyTraffic: () => dailyTraffic,
  ledgerDb,
  COST_CATEGORIES,
  getClientStoredMonthBytes,
  refreshPortKeyMapping,
  getApiServers: () => apiServers,
  getServerCountries: () => SERVER_COUNTRIES,
  normalizeOperator,
  getMoscowToday, trafficBytesToGb, parseBwToBytes, ledgerExpense,
  appSettings,
  auditLog, logActivity,
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
    getSetting,
  });
  // Load-simulator engine. Only init here — proxy-URL resolution happens in
  // the per-request endpoint (Day 2), which calls fetchAllServersDataCached()
  // and builds full proxyUrls for the chosen target modems before passing
  // them to simulator.start().
  simulator.init({
    db, logger,
    getSetting,
  });
  tgSummary.init({
    db, logger,
    clientById,
    getSetting,
    aiInsights,
  });
  tgBot.init({
    logger,
    getSetting,
    setSetting,
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
            const check = trafficDb.hourlyExistsForHourStmt().get(targetHourStr);
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

// Stage 9: checkCrmPaymentConfirmations (53 lines) moved to
// src/jobs/crm-sync.js. Lazy init for same TDZ reason as the other jobs.
let _crmSyncJob = null;
function _initCrmSyncJob() {
  if (_crmSyncJob) return _crmSyncJob;
  _crmSyncJob = require('./src/jobs/crm-sync').create({
    logger, logActivity,
    CRM_DB_URL, CRM_WS,
    getAppSettings: () => appSettings,
  });
  return _crmSyncJob;
}
async function checkCrmPaymentConfirmations() {
  return _initCrmSyncJob().checkCrmPaymentConfirmations();
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
module.exports = { app, db, saveClients };
