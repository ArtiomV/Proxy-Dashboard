'use strict';
//
// src/routes/sla.js — SLA metrics endpoints (Stage 3).
//
// Two admin-only routes:
//   GET /api/admin/clients/:id/sla   — per-client SLA metrics + violations
//   GET /api/admin/sla_overview      — dashboard rollup across all clients

const express = require('express');

module.exports = function createSlaRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    computeClientSlaMetrics,
    getClientById, getClients,
  } = deps;
  const r = express.Router();

  r.get('/api/admin/clients/:id/sla', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const client = getClientById(req.params.id);
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
  r.get('/api/admin/sla_overview', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const out = { ok: 0, breach: 0, no_data: 0, clients: [] };
      const clients = getClients();
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

  return r;
};
