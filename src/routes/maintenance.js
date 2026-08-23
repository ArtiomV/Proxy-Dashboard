'use strict';
//
// src/routes/maintenance.js — B3 (ТЗ мониторинга v2, этап 4, 23.08): CRUD
// окон обслуживания. Логика — src/maintenance.js; подавление алертов — в
// alerts.trigger(), пометка простоев — в modem-tracking.js.
//
//   GET    /api/admin/maintenance          — список (?active=1 — только незавершённые)
//   POST   /api/admin/maintenance          — {target_type, target_id, from_ts, to_ts, comment}
//   DELETE /api/admin/maintenance/:id

const express = require('express');
const maintenance = require('../maintenance');

module.exports = function (deps) {
  const { db, logger, authMiddleware, adminMiddleware } = deps;
  const r = express.Router();

  r.get('/api/admin/maintenance', authMiddleware, adminMiddleware, (req, res) => {
    try {
      res.json({ windows: maintenance.listWindows(db, { active: req.query.active === '1' }) });
    } catch (e) {
      logger.error('[Maintenance] list: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/api/admin/maintenance', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const body = req.body || {};
      const from_ts = Number(body.from_ts);
      const to_ts = Number(body.to_ts);
      if (Number.isFinite(to_ts) && to_ts <= Date.now()) {
        return res.status(400).json({ error: 'окно полностью в прошлом — на алерты оно уже не повлияет' });
      }
      const out = maintenance.createWindow(db, {
        target_type: body.target_type,
        target_id: body.target_id,
        from_ts, to_ts,
        comment: body.comment,
        created_by: (req.user && req.user.login) || '',
      });
      res.json({ ok: true, id: out.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/api/admin/maintenance/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const ok = maintenance.deleteWindow(db, parseInt(req.params.id, 10));
      res.json({ ok });
    } catch (e) {
      logger.error('[Maintenance] delete: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
