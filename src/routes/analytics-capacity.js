'use strict';
//
// src/routes/analytics-capacity.js — capacity endpoint (WP6.1 carve-out
// from analytics.js). SQL statements come from src/db/analytics.js; the
// stale-modem NOT IN fragments are built there too.

const express = require('express');
const analyticsDb = require('../db/analytics');

module.exports = function createAnalyticsCapacityRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    getStaleNicks, getStaleImeis,
  } = deps;
  const r = express.Router();

  r.get('/api/analytics/capacity', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 180);
      const sinceExpr = `datetime('now', '-${days} days')`;

      // Stage 18.8: stale (offline > N hours) modems excluded from capacity
      // counts — total bytes stays accurate (no recent traffic anyway), while
      // modem counts reflect the live fleet.
      const staleNicks = (typeof getStaleNicks === 'function') ? getStaleNicks() : new Set();
      const { clause: staleFilter, params: staleArgs } = analyticsDb.notInClause('nick', staleNicks);

      // Per-server utilization
      const servers = analyticsDb.capacityServers(sinceExpr, staleFilter).all(...staleArgs);

      // Modem count growth by month — stale IMEIs excluded at SELECT level
      // (nicks would be the wrong key here).
      const staleImeisSet = (typeof getStaleImeis === 'function') ? getStaleImeis() : new Set();
      const { clause: imeiFilter, params: imeiArgs } = analyticsDb.notInClause('imei', staleImeisSet);
      const modemGrowth = analyticsDb.capacityModemGrowth(imeiFilter).all(...imeiArgs);

      // Overall totals
      const totals = analyticsDb.capacityTotals(sinceExpr, staleFilter).get(...staleArgs);

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

  return r;
};
