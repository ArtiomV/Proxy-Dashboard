'use strict';
//
// src/routes/analytics-domains.js — top-hosts log explorer (WP6.1 carve-out
// from analytics.js): logs_domains_full. Every query goes through
// src/db/analytics.js (shared topHostsWhere builder owns the param order).

const express = require('express');
const analyticsDb = require('../db/analytics');

module.exports = function createAnalyticsDomainsRouter(deps) {
  const { logger, authMiddleware, adminMiddleware, db, runDomainGuard, logActivity } = deps;
  const r = express.Router();

  // WP2: журнал доменного контроля (совпадения top_hosts с бан-листом на
  // bypass-боксах). Пишет src/jobs/domain-guard.js.
  r.get('/api/admin/domain_guard', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
      const rows = db.prepare(`SELECT date, server_name, client_name, nick, host,
          matched_domain, hits_delta, total
        FROM domain_guard_hits WHERE date >= date('now', ?)
        ORDER BY date DESC, hits_delta DESC LIMIT 500`).all(`-${days} days`);
      res.json({ rows });
    } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
  });

  // Ручной запуск контроля (первый прогон / отладка).
  r.post('/api/admin/domain_guard/run', authMiddleware, adminMiddleware, (req, res) => {
    if (typeof runDomainGuard !== 'function') return res.status(501).json({ error: 'not wired' });
    runDomainGuard().catch(e => logger.error('[DomainGuard] manual run failed:', e.message));
    if (logActivity) logActivity('system', 'info', 'domain_guard_manual', req.user && req.user.login, 'Ручной запуск доменного контроля');
    res.json({ ok: true, started: true });
  });

  // Drill-down: ВСЕ домены клиента за конкретный день (top_hosts_daily), с
  // дельтой против предыдущего среза и флагом banned. ProxySmart отдаёт только
  // хостнеймы (top_hosts), полных URL в источнике нет — «ссылки» = домены.
  r.get('/api/admin/domain_guard/client_hosts', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const server = String(req.query.server || '');
      const client = String(req.query.client || '');
      const date = String(req.query.date || '').slice(0, 10);
      if (!server || !client || !date) return res.status(400).json({ error: 'server, client, date required' });

      let blocklist = [];
      try {
        const cfg = JSON.parse(require('fs').readFileSync(
          require('path').join(__dirname, '..', '..', 'config', 'blocked-domains.json'), 'utf8'));
        blocklist = [...(cfg.domains || []), ...(cfg.custom || [])]
          .map(d => String(d).toLowerCase().trim()).filter(Boolean);
      } catch (e) { logger.warn('[domain_guard/client_hosts] blocklist: ' + e.message); }
      const isBanned = (host) => {
        const h = String(host).toLowerCase();
        return blocklist.some(d => h === d || h.endsWith('.' + d));
      };

      const rows = db.prepare(`SELECT port_id, nick, host, count FROM top_hosts_daily
        WHERE date = ? AND server_name = ? AND client_name = ?`).all(date, server, client);
      const prevStmt = db.prepare(`SELECT count FROM top_hosts_daily
        WHERE server_name = ? AND port_id = ? AND host = ? AND date < ?
        ORDER BY date DESC LIMIT 1`);
      const out = rows.map(rw => {
        const prev = prevStmt.get(server, rw.port_id, rw.host, date);
        const delta = !prev ? (rw.count || 0)
          : (rw.count >= prev.count ? rw.count - prev.count : rw.count);
        return { host: rw.host, port_id: rw.port_id, nick: rw.nick || '', count: rw.count || 0, delta, banned: isBanned(rw.host) };
      }).filter(rw => rw.delta > 0);
      out.sort((a, b) => b.delta - a.delta);
      res.json({ date, server, client, rows: out });
    } catch (err) { res.status(500).json({ error: 'Failed', details: err.message }); }
  });

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
