'use strict';

// Dashboard «Обращения к API» — read-only view of inbound client/external API
// access. Rows are written by the global /api access-log middleware in
// server.js into the api_access_log table (migration 042). This router only
// READS them for the dashboard card:
//   GET /api/admin/api_access_log?hours=24&limit=150&type=&client=
// Covers public API (X-API-Key), client portal, reset-by-link rotation, the
// Tochka payment webhook, and login attempts. Admin self-traffic is not logged.

const express = require('express');

module.exports = function (deps) {
  const { logger, db, authMiddleware, adminMiddleware } = deps;
  const r = express.Router();

  // Prepared once at module load — db is injected after migrations applied.
  // The `(? = '' OR col = ?)` idiom makes type/client filters optional in a
  // single statement (empty string → no filter).
  const qRecent = db.prepare(`
    SELECT id, ts, caller_type, client_name, identity, method, path, purpose,
           status, duration_ms, ip, user_agent
      FROM api_access_log
     WHERE ts >= datetime('now', ?)
       AND (? = '' OR caller_type = ?)
       AND (? = '' OR client_name = ?)
     ORDER BY id DESC
     LIMIT ?`);

  const qSummary = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
           COUNT(DISTINCT client_name) AS clients
      FROM api_access_log
     WHERE ts >= datetime('now', ?)`);

  const qByType = db.prepare(`
    SELECT caller_type, COUNT(*) AS c
      FROM api_access_log
     WHERE ts >= datetime('now', ?)
     GROUP BY caller_type`);

  const qByPurpose = db.prepare(`
    SELECT purpose, COUNT(*) AS c
      FROM api_access_log
     WHERE ts >= datetime('now', ?)
     GROUP BY purpose
     ORDER BY c DESC
     LIMIT 12`);

  const qTopClients = db.prepare(`
    SELECT client_name, caller_type, COUNT(*) AS c, MAX(ts) AS last_ts,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
      FROM api_access_log
     WHERE ts >= datetime('now', ?)
     GROUP BY client_name
     ORDER BY c DESC
     LIMIT 10`);

  r.get('/api/admin/api_access_log', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 720);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 1000);
      const type = String(req.query.type || '').trim();
      const client = String(req.query.client || '').trim();
      const sinceExpr = '-' + hours + ' hours';

      const recent = qRecent.all(sinceExpr, type, type, client, client, limit);
      const summary = qSummary.get(sinceExpr) || {};
      const byType = qByType.all(sinceExpr);
      const byPurpose = qByPurpose.all(sinceExpr);
      const topClients = qTopClients.all(sinceExpr);

      res.json({
        hours,
        summary: {
          total: summary.total || 0,
          errors: summary.errors || 0,
          clients: summary.clients || 0,
        },
        by_type: byType,
        by_purpose: byPurpose,
        top_clients: topClients,
        recent,
      });
    } catch (e) {
      logger.error('[api_access_log] ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
