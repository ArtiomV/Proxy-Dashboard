'use strict';
//
// src/routes/analytics-domains.js — top-hosts log explorer (WP6.1 carve-out
// from analytics.js): logs_domains_full. Every query goes through
// src/db/analytics.js (shared topHostsWhere builder owns the param order).

const express = require('express');
const analyticsDb = require('../db/analytics');

module.exports = function createAnalyticsDomainsRouter(deps) {
  const { logger, authMiddleware, adminMiddleware } = deps;
  const r = express.Router();

  r.get('/api/analytics/logs_domains_full', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const { host = '', client = '', operator = '', server = '', nick = '' } = req.query;
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 2000, 1), 20000);
      const minCount = Math.max(parseInt(req.query.min_count) || 1, 1);

      const { whereSql, params } = analyticsDb.topHostsWhere({ host, client, operator, server, nick, minCount });

      // Snapshot meta
      const snap = analyticsDb.topHostsSnapshotMeta();

      // Filtered raw rows (capped) + summary of the filtered set
      const rows = analyticsDb.topHostsRows(whereSql, params, limit);
      const totals = analyticsDb.topHostsTotals(whereSql, params);

      // Aggregations (each an independent query)
      const topHosts = analyticsDb.topHostsTop(whereSql, params);
      const byClient = analyticsDb.topHostsByClient(whereSql, params);
      const byOperator = analyticsDb.topHostsByOperator(whereSql, params);
      const byServer = analyticsDb.topHostsByServer(whereSql, params);
      const byModem = analyticsDb.topHostsByModem(whereSql, params);

      // TLD / IP split — computed in JS because SQLite lacks rinstr/reverse.
      const tldRows = analyticsDb.topHostsTldRows(whereSql, params);
      const tldMap = {};
      const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
      for (const row of tldRows) {
        let tld;
        if (IP_RE.test(row.host)) tld = '(IP)';
        else {
          const dot = row.host.lastIndexOf('.');
          tld = dot === -1 ? '(none)' : row.host.slice(dot + 1).toLowerCase();
        }
        if (!tldMap[tld]) tldMap[tld] = { tld, hits: 0, unique_hosts: 0 };
        tldMap[tld].hits += row.hits;
        tldMap[tld].unique_hosts += 1;
      }
      const byTld = Object.values(tldMap).sort((a, b) => b.hits - a.hits).slice(0, 50);

      // Facet lists (unfiltered — for populating filter dropdowns)
      const facets = analyticsDb.topHostsFacets();

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
        facets,
      });
    } catch (e) {
      logger.error('[logs_domains_full]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
