'use strict';

// Stage 19 — failover admin endpoints.
//   GET  /api/admin/failover/log?limit=100       — audit trail
//   GET  /api/admin/failover/spares?server=S2    — healthy free modems
//   GET  /api/admin/failover/candidates          — client modems currently
//                                                  eligible for failover (preview)
//   POST /api/admin/failover/execute             — manual trigger
//        body: { server, imei, nick }

const express = require('express');

module.exports = function (deps) {
  const { db, logger, authMiddleware, adminMiddleware, failover, getClientIp, auditLog } = deps;
  const r = express.Router();

  r.get('/api/admin/failover/log', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const rows = db.prepare('SELECT * FROM failover_log ORDER BY ts DESC LIMIT ?').all(limit);
      res.json({ log: rows });
    } catch (e) {
      logger.error('[Failover] log: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/api/admin/failover/spares', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const server = String(req.query.server || '');
      if (!server) return res.status(400).json({ error: 'server required' });
      res.json({ server, spares: await failover.listSpares(server) });
    } catch (e) {
      logger.error('[Failover] spares: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Dry preview — which client modems would the auto-scan act on right now,
  // and is a spare available for each. Pure read, no mutation.
  r.get('/api/admin/failover/candidates', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      res.json({ candidates: await failover.previewCandidates() });
    } catch (e) {
      logger.error('[Failover] candidates: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/api/admin/failover/execute', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { server, imei, nick } = req.body || {};
      if (!server || !imei) return res.status(400).json({ error: 'server, imei required' });
      auditLog(req.user.login, 'failover_manual', { server, imei, nick, ip: getClientIp(req) });
      const result = await failover.manualFailover(server, imei, nick || imei);
      res.json(result);
    } catch (e) {
      logger.error('[Failover] execute: ' + e.message);
      res.status(502).json({ error: e.message });
    }
  });

  return r;
};
