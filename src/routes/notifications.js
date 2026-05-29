'use strict';

// Stage 18.15 — bell-icon backend.
//   GET    /api/admin/notifications              — list, with filter + per-user state
//   GET    /api/admin/notifications/badge        — cheap unread-count probe (polled)
//   POST   /api/admin/notifications/:id/read     — mark single as read
//   POST   /api/admin/notifications/:id/dismiss  — soft-hide single
//   POST   /api/admin/notifications/read-all     — mark every visible as read
//   POST   /api/admin/notifications/dismiss-read-older — bulk clear old reads
//
// Events are shared across all admins (one row in `notifications`). Each
// admin has their own read/dismiss markers in `notification_read_state`
// keyed by login. So «прочитано/скрыто» is personal but the history is
// global — exactly what the user asked for.

const express = require('express');

const PRIORITY_RANK = { critical: 3, important: 2, early: 1, info: 0 };

module.exports = function (deps) {
  const { logger, db, authMiddleware, adminMiddleware } = deps;
  const r = express.Router();

  // Prepared statements — built once at module load. db is injected, so this
  // runs after migrations have applied the schema.
  const _list = db.prepare(`
    SELECT n.id, n.dedup_key, n.rule_id, n.priority, n.entity_kind, n.entity_id,
           n.title, n.message, n.payload_json, n.created_at,
           s.read_at AS read_at, s.dismissed_at AS dismissed_at
      FROM notifications n
      LEFT JOIN notification_read_state s
        ON s.notif_id = n.id AND s.user_login = ?
     WHERE (s.dismissed_at IS NULL)
     ORDER BY n.created_at DESC
     LIMIT ?
  `);

  // Cheap counter for polling. Same join, count only.
  const _badge = db.prepare(`
    SELECT
      SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN s.read_at IS NULL AND n.priority = 'critical' THEN 1 ELSE 0 END) AS unread_critical
      FROM notifications n
      LEFT JOIN notification_read_state s
        ON s.notif_id = n.id AND s.user_login = ?
     WHERE (s.dismissed_at IS NULL)
       AND n.created_at >= datetime('now','-30 days')
  `);

  const _exists = db.prepare('SELECT id FROM notifications WHERE id = ?');

  const _markRead = db.prepare(`
    INSERT INTO notification_read_state (notif_id, user_login, read_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(notif_id, user_login) DO UPDATE SET read_at = excluded.read_at
  `);

  const _dismiss = db.prepare(`
    INSERT INTO notification_read_state (notif_id, user_login, dismissed_at, read_at)
    VALUES (?, ?, datetime('now'), COALESCE((SELECT read_at FROM notification_read_state WHERE notif_id=? AND user_login=?), datetime('now')))
    ON CONFLICT(notif_id, user_login) DO UPDATE SET dismissed_at = excluded.dismissed_at
  `);

  const _readAll = db.prepare(`
    INSERT INTO notification_read_state (notif_id, user_login, read_at)
    SELECT n.id, ?, datetime('now')
      FROM notifications n
      LEFT JOIN notification_read_state s ON s.notif_id = n.id AND s.user_login = ?
     WHERE s.read_at IS NULL AND (s.dismissed_at IS NULL)
       AND n.created_at >= datetime('now','-30 days')
    ON CONFLICT(notif_id, user_login) DO UPDATE SET read_at = excluded.read_at
  `);

  const _dismissOldRead = db.prepare(`
    INSERT INTO notification_read_state (notif_id, user_login, dismissed_at, read_at)
    SELECT s.notif_id, s.user_login, datetime('now'), s.read_at
      FROM notification_read_state s
     WHERE s.user_login = ?
       AND s.read_at IS NOT NULL
       AND s.dismissed_at IS NULL
       AND s.read_at < datetime('now','-7 days')
    ON CONFLICT(notif_id, user_login) DO UPDATE SET dismissed_at = excluded.dismissed_at
  `);

  function userLogin(req) {
    return (req.user && req.user.login) || 'anonymous';
  }

  // ── GET list ────────────────────────────────────────────────
  r.get('/api/admin/notifications', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const login = userLogin(req);
      const filter = String(req.query.filter || 'all');
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      let rows = _list.all(login, limit);
      if (filter === 'unread')   rows = rows.filter(r => !r.read_at);
      if (filter === 'critical') rows = rows.filter(r => r.priority === 'critical');
      // Parse payload_json once on the wire; clients use it for navigation.
      const out = rows.map(r => ({
        id: r.id,
        rule_id: r.rule_id,
        priority: r.priority,
        priority_rank: PRIORITY_RANK[r.priority] || 0,
        entity_kind: r.entity_kind,
        entity_id: r.entity_id,
        title: r.title,
        message: r.message,
        payload: r.payload_json ? safeParse(r.payload_json) : null,
        created_at: r.created_at,
        read_at: r.read_at,
        dismissed_at: r.dismissed_at,
      }));
      res.json({ notifications: out, count: out.length });
    } catch (e) {
      logger.error('[Notifications] list: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET badge (poll) ────────────────────────────────────────
  r.get('/api/admin/notifications/badge', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const login = userLogin(req);
      const row = _badge.get(login) || {};
      res.json({ unread: row.unread || 0, unread_critical: row.unread_critical || 0 });
    } catch (e) {
      logger.error('[Notifications] badge: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST mark read ──────────────────────────────────────────
  r.post('/api/admin/notifications/:id/read', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || !_exists.get(id)) return res.status(404).json({ error: 'not found' });
      _markRead.run(id, userLogin(req));
      res.json({ ok: true });
    } catch (e) {
      logger.error('[Notifications] read: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST dismiss ────────────────────────────────────────────
  r.post('/api/admin/notifications/:id/dismiss', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || !_exists.get(id)) return res.status(404).json({ error: 'not found' });
      const login = userLogin(req);
      _dismiss.run(id, login, id, login);
      res.json({ ok: true });
    } catch (e) {
      logger.error('[Notifications] dismiss: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST read all ───────────────────────────────────────────
  r.post('/api/admin/notifications/read-all', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const login = userLogin(req);
      const info = _readAll.run(login, login);
      res.json({ ok: true, marked: info.changes });
    } catch (e) {
      logger.error('[Notifications] read-all: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST dismiss-read-older ─────────────────────────────────
  // Hides read-and-old cards from the panel for this user. Frontend offers
  // this as «Скрыть прочитанные старше 7 дней».
  r.post('/api/admin/notifications/dismiss-read-older', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const info = _dismissOldRead.run(userLogin(req));
      res.json({ ok: true, dismissed: info.changes });
    } catch (e) {
      logger.error('[Notifications] dismiss-old: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}
