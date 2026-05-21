'use strict';
//
// src/routes/ops.js — operational endpoints (Stage 3).
//
// Factory pattern: takes a `deps` object and returns an express.Router.
// Routes inside refer to deps directly to avoid stale closures over the
// mutable globals that server.js still owns (billingLedger, clients, etc.)
// — getters are used for those.
//
// This is the FIRST Stage 3 router. Start narrow with the smallest, most
// isolated endpoints to validate the factory + mounting pattern before
// touching the more deeply-coupled domains.

const express = require('express');
const fs = require('fs');

module.exports = function createOpsRouter(deps) {
  const { db, logger, DB_PATH, getSessionCount, getBillingLedger, getClients } = deps;
  const r = express.Router();

  // Minimal Prometheus-compatible /metrics — text format. Lets ops scrape this
  // from Grafana/Prometheus without installing prom-client (zero deps).
  r.get('/metrics', (req, res) => {
    try {
      const mem = process.memoryUsage();
      const billingLedger = getBillingLedger();
      const clients = getClients();
      const ledgerCount = Object.values(billingLedger).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
      const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
      const lines = [
        '# HELP proxy_dashboard_uptime_seconds Process uptime in seconds',
        '# TYPE proxy_dashboard_uptime_seconds counter',
        `proxy_dashboard_uptime_seconds ${Math.round(process.uptime())}`,
        '# HELP proxy_dashboard_memory_rss_bytes Resident memory in bytes',
        '# TYPE proxy_dashboard_memory_rss_bytes gauge',
        `proxy_dashboard_memory_rss_bytes ${mem.rss}`,
        '# HELP proxy_dashboard_memory_heap_used_bytes Node heap used',
        '# TYPE proxy_dashboard_memory_heap_used_bytes gauge',
        `proxy_dashboard_memory_heap_used_bytes ${mem.heapUsed}`,
        '# HELP proxy_dashboard_memory_heap_total_bytes Node heap total',
        '# TYPE proxy_dashboard_memory_heap_total_bytes gauge',
        `proxy_dashboard_memory_heap_total_bytes ${mem.heapTotal}`,
        '# HELP proxy_dashboard_clients_total Number of clients',
        '# TYPE proxy_dashboard_clients_total gauge',
        `proxy_dashboard_clients_total ${clients.length}`,
        '# HELP proxy_dashboard_ledger_entries_total In-memory ledger entries',
        '# TYPE proxy_dashboard_ledger_entries_total gauge',
        `proxy_dashboard_ledger_entries_total ${ledgerCount}`,
        '# HELP proxy_dashboard_db_size_bytes SQLite file size',
        '# TYPE proxy_dashboard_db_size_bytes gauge',
        `proxy_dashboard_db_size_bytes ${dbSize}`,
        '# HELP proxy_dashboard_sessions_total Active sessions',
        '# TYPE proxy_dashboard_sessions_total gauge',
        `proxy_dashboard_sessions_total ${getSessionCount()}`,
        ''
      ];
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(lines.join('\n'));
    } catch (e) {
      res.status(500).set('Content-Type', 'text/plain').send('# metrics_error\n');
    }
  });

  // Public health — verifies DB read works. Returns 503 if DB unhealthy so
  // load-balancers / monitoring tools can detect "process alive but broken".
  r.get('/health', (req, res) => {
    try {
      const ok = db.prepare('SELECT 1 AS ok').get();
      if (!ok || ok.ok !== 1) throw new Error('sqlite returned unexpected row');
      res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'ok' });
    } catch (e) {
      logger.error('[/health] DB check failed: ' + e.message);
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), error: 'db_check_failed' });
    }
  });

  return r;
};
