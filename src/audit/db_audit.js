'use strict';
/**
 * DB-level audit module.
 *
 * Architecture:
 * - SQLite triggers (migration 022_db_audit.sql) capture every INSERT/UPDATE/DELETE
 *   on financial tables. Triggers fire regardless of which code path made the
 *   change — even raw db.exec() or buggy code that bypasses our wrappers.
 *
 * - This module provides the "context" half: who triggered the change, why,
 *   from which request/job. The context is stored in db_audit_context, and a
 *   single-row pivot table _audit_active_context holds the active context_id.
 *   Triggers read from that pivot to link each captured row to a context.
 *
 * - Express middleware sets context per HTTP request.
 * - Scheduled jobs / webhooks / startup paths set their own context via
 *   withContext().
 *
 * - Without context, captured rows still have table+old/new — just NULL actor.
 */

const { AsyncLocalStorage } = require('async_hooks');

let db, logger;
let _ctxInsert, _ctxActivate, _ctxClear;
const als = new AsyncLocalStorage();
let initialized = false;

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  _ctxInsert = db.prepare(`INSERT INTO db_audit_context
    (source, actor, ip, request_id, http_method, http_path, reason, stack)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  _ctxActivate = db.prepare('UPDATE _audit_active_context SET context_id = ? WHERE id = 1');
  _ctxClear    = db.prepare('UPDATE _audit_active_context SET context_id = NULL WHERE id = 1');
  initialized = true;
}

// Capture a 8-frame stack (excluding our own code)
function captureStack() {
  const e = new Error();
  const lines = (e.stack || '').split('\n').slice(3, 11);
  return lines.map(s => s.trim()).join('\n');
}

// Insert a context row and activate it for upcoming triggers.
// Caller MUST call clearActiveContext() afterwards (use try/finally or runWith).
function setActiveContext(ctxData) {
  if (!initialized) return null;
  const id = _ctxInsert.run(
    String(ctxData.source || 'unknown'),
    ctxData.actor      ? String(ctxData.actor).slice(0, 200)      : null,
    ctxData.ip         ? String(ctxData.ip).slice(0, 100)         : null,
    ctxData.request_id ? String(ctxData.request_id).slice(0, 100) : null,
    ctxData.http_method ? String(ctxData.http_method).slice(0, 16) : null,
    ctxData.http_path   ? String(ctxData.http_path).slice(0, 300) : null,
    ctxData.reason     ? String(ctxData.reason).slice(0, 500)     : null,
    ctxData.stack      ? String(ctxData.stack).slice(0, 2000)
                       : (ctxData.includeStack ? captureStack() : null)
  ).lastInsertRowid;
  _ctxActivate.run(id);
  return id;
}

function clearActiveContext() {
  if (!initialized) return;
  _ctxClear.run();
}

/**
 * Run a synchronous block of DB writes with the given context active.
 * All writes inside fn() will link to a freshly-inserted context_id.
 */
function withContext(ctxData, fn) {
  if (!initialized) return fn();
  setActiveContext(ctxData);
  try {
    return fn();
  } finally {
    clearActiveContext();
  }
}

/**
 * Express middleware that wraps each request in a per-request ALS context.
 * For requests that actually write to the DB, the route handler should call
 * ensureRequestContext() right before the first write. Read-only requests
 * don't pay for context_id insertion.
 */
function expressMiddleware(req, res, next) {
  const ctxData = {
    source: 'http',
    actor:  (req.user && (req.user.login || req.user.clientId)) || null,
    ip:     getReqIp(req),
    request_id: req.id || null,
    http_method: req.method,
    http_path:   (req.originalUrl || req.path || '').split('?')[0],
  };
  // Lazy: don't insert context yet. Handler/lib calls ensureRequestContext()
  // when actually writing.
  als.run({ ...ctxData, _ctxId: null }, () => next());
}

function getReqIp(req) {
  return (req.ip || req.headers['x-forwarded-for'] || req.headers['x-real-ip']
       || (req.socket && req.socket.remoteAddress) || '').toString().split(',')[0].trim();
}

/**
 * Lazily insert+activate context for the current request. Idempotent within
 * one request — first call inserts the row, subsequent calls reactivate it.
 * Call this immediately before doing DB writes in route handlers (or, better,
 * use withRouteContext()).
 */
function ensureRequestContext(reasonHint) {
  if (!initialized) return null;
  const store = als.getStore();
  if (!store) {
    // No ALS — synthesize an "unknown_http" context
    return setActiveContext({ source: 'unknown_http', reason: reasonHint });
  }
  if (store._ctxId) {
    _ctxActivate.run(store._ctxId);
    return store._ctxId;
  }
  if (reasonHint && !store.reason) store.reason = reasonHint;
  store._ctxId = setActiveContext(store);
  return store._ctxId;
}

/**
 * Convenience wrapper for a scheduled job. Inserts a context with source=scheduler
 * and activates it for the duration of fn(). Synchronous; for async jobs use
 * runJobAsync().
 */
function runJob(name, reason, fn) {
  return withContext({
    source: 'scheduler',
    actor: 'system',
    reason: reason ? `${name}: ${reason}` : name
  }, fn);
}

/**
 * Async version: sets context once, keeps it active across the awaits inside
 * fn(). After fn() resolves/rejects, context is cleared.
 *
 * NOTE: if other writes happen concurrently with this job, they'll race on the
 * single _audit_active_context pivot. Use only for serial / non-concurrent jobs.
 */
async function runJobAsync(name, reason, fn) {
  if (!initialized) return fn();
  setActiveContext({
    source: 'scheduler',
    actor: 'system',
    reason: reason ? `${name}: ${reason}` : name
  });
  try {
    return await fn();
  } finally {
    clearActiveContext();
  }
}

/**
 * For webhook handlers — sets a webhook context.
 */
function withWebhookContext(name, ip, fn) {
  return withContext({ source: 'webhook', actor: name, ip, reason: name }, fn);
}

/**
 * Diagnostic — get last N audit entries for a specific row.
 */
function getRowHistory(tableName, rowId, limit = 50) {
  if (!initialized) return [];
  return db.prepare(`
    SELECT a.id, a.ts, a.operation, a.old_values, a.new_values,
           c.source, c.actor, c.ip, c.http_method, c.http_path, c.reason, c.stack
    FROM db_audit a
    LEFT JOIN db_audit_context c ON c.id = a.context_id
    WHERE a.table_name = ? AND a.row_id = ?
    ORDER BY a.id DESC
    LIMIT ?
  `).all(tableName, String(rowId), limit);
}

/**
 * Diagnostic — search audit by criteria.
 */
function search({ table, operation, since, until, actor, source, limit = 200 } = {}) {
  if (!initialized) return [];
  const where = [];
  const params = [];
  if (table)     { where.push('a.table_name = ?'); params.push(table); }
  if (operation) { where.push('a.operation = ?');  params.push(operation); }
  if (since)     { where.push('a.ts >= ?');        params.push(since); }
  if (until)     { where.push('a.ts <= ?');        params.push(until); }
  if (actor)     { where.push('c.actor = ?');      params.push(actor); }
  if (source)    { where.push('c.source = ?');     params.push(source); }
  const sql = `SELECT a.id, a.ts, a.table_name, a.operation, a.row_id,
                      a.old_values, a.new_values,
                      c.source, c.actor, c.ip, c.http_method, c.http_path, c.reason, c.stack
               FROM db_audit a
               LEFT JOIN db_audit_context c ON c.id = a.context_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY a.id DESC
               LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit) || 200, 1), 5000));
  return db.prepare(sql).all(...params);
}

module.exports = {
  init,
  withContext,
  expressMiddleware,
  ensureRequestContext,
  setActiveContext,
  clearActiveContext,
  runJob,
  runJobAsync,
  withWebhookContext,
  getRowHistory,
  search,
};
