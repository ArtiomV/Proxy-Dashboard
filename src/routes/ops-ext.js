'use strict';
//
// src/routes/ops-ext.js — remaining ops endpoints (Stage 3 finish).
//
// 11 admin-only routes left in server.js after the first ops.js extraction.
// Late-mounted in server.js so all helpers (fetchAllServersDataCached etc.)
// are already defined. Globals accessed via getter functions to avoid TDZ
// during mount-time evaluation.

const express = require('express');
const { computeFleet, annotateTestPool, computeClientWorking } = require('../modems/fleet');
const simulatorDb = require('../db/simulator');
const { computeRevenueWindow } = require('../billing/revenue');   // WP8: canonical revenue
const scheduler = require('../jobs/scheduler');                  // WP6.4: job registry for /api/admin/health

// ── /api/admin/data section degradation wrapper (WP6.2) ──────────────────
// One failing section degrades to its fallback instead of 502ing the panel.
function _runSection(logger, name, fn, fallback) {
  try { return fn(); }
  catch (e) { logger.warn('[data] section ' + name + ' failed (degraded): ' + e.message); return fallback; }
}

module.exports = function createOpsExtRouter(deps) {
  const {
    db, logger, DB_PATH,
    trackingDb,
    authMiddleware, adminMiddleware, dashboardLimiter,
    fs, path, dbStmts, dbAudit,
    appSettings,
    getAllBankPayments,
    getSessionCount, getClients,
    getApiServers, getServerCountries,
    getRunningJobs,
    getLastBillingRunSummary, getLastReconciliationMonth, getIntervals,
    getFetchAllServersDataCached, getMergeServerData,
    getIpTracking, getUptimeTracking, getIpHistory, getKnownModems,
    getDailyTraffic, getPortKeyToPortName,
    getTochkaConfig, getProxyCheckSummary,
    computeProxyIssues, fetchApi, findServer,
    getSpeedtestLatest, _getClientTrend, _getModemTrend,
    logActivity,
    getMoscowNow, getMoscowToday, getMoscowYesterday,
    ledgerExpense, parseBwToBytes, trafficBytesToGb,
  } = deps;
  const r = express.Router();
  // Stage 4: billing_ledger reads come from DB. Two cheap aggregate queries
  // replace what used to walk the in-memory `billingLedger` object.
  const _ledgerCountStmt = db.prepare('SELECT COUNT(*) AS n FROM billing_ledger');
  const _ledgerMonthAggStmt = db.prepare(`
    SELECT client_id, type, amount, balance_before, balance_after, gb_used
      FROM billing_ledger
     WHERE (type = 'charge' OR type = 'correction')
       AND date LIKE ?
  `);
  // Modem registry rows (non-random, non-test) — the candidate set for the
  // fleet count. Recency/online state comes from uptime_tracking + the live
  // snapshot in computeFleet (src/modems/fleet.js), not from a SQL time filter.
  // Fleet roster query lives in src/db/tracking.js (metaFleetRosterStmt) as the
  // SINGLE source of truth — it bakes in the deleted/random/test exclusions and is
  // regression-guarded by tests/fleet-roster.test.js, so the RO2_35 «deleted modem
  // still counted» bug can't silently return via a rewrite here.
  const _fleetMetaStmt = trackingDb.metaFleetRosterStmt();

r.get('/api/admin/health', authMiddleware, adminMiddleware, (req, res) => {
  const mem = process.memoryUsage();
  const ledgerEntryCount = _ledgerCountStmt.get().n;
  const dbSize = fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) : 0;
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    clients: getClients().length,
    sessions: getSessionCount(),
    servers: getApiServers().length,
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024)
    },
    database: { size_kb: dbSize, ledger_entries: ledgerEntryCount, wal_mode: true },
    billing: getLastBillingRunSummary() || { last_run: null },
    // WP5: balance-vs-ledger drift surfaced by the daily reconcile job.
    balance: (() => { const r = (deps.getBalanceReconcile ? deps.getBalanceReconcile().getLastResult() : {}); return { divergent_clients: r.divergent || 0, checked_at: r.checkedAt || null, total_clients: r.total || 0 }; })(),
    // WP7.3: ?apiKey= query-param usage over the last 7 days — the metric that
    // gates the sunset of the deprecated fallback (target: 0 before removal).
    apikey_query_uses_7d: (() => {
      try { return db.prepare("SELECT COUNT(*) AS n FROM api_usage WHERE key_via = 'query' AND timestamp >= datetime('now', '-7 days')").get().n; }
      catch (_) { return null; }
    })(),
    reconciliation: { last_month: getLastReconciliationMonth() || null },
    intervals: getIntervals().length,
    // WP6.4: unified scheduler registry — every recurring job with its
    // schedule, run count, last run, and last error.
    jobs: scheduler.getJobs(),
    timestamp: new Date().toISOString()
  });
});

r.get('/api/admin/jobs/:id', authMiddleware, adminMiddleware, (req, res) => {
  const job = getRunningJobs().get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

r.get('/api/admin/auto_reboot_log', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const rows = db.prepare(`
      SELECT id, server_name, nick, imei, rebooted_at, reason, status, error
        FROM auto_reboot_log
       WHERE rebooted_at >= datetime('now', '-${days} days')
       ORDER BY id DESC
       LIMIT ?
    `).all(limit);
    res.json({ count: rows.length, days, rows });
  } catch (e) {
    logger.error('[auto_reboot_log]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/db_audit', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { table, operation, row_id, actor, source, since, until } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 5000);
    let rows;
    if (row_id && table) {
      rows = dbAudit.getRowHistory(table, row_id, limit);
    } else {
      rows = dbAudit.search({ table, operation, actor, source, since, until, limit });
    }
    res.json({ count: rows.length, rows });
  } catch (e) {
    logger.error('[db_audit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/api_usage', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const clientId = String(req.query.client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'client_id required' });
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);

    const sinceExpr = `datetime('now', '-${days} days')`;

    // Aggregate
    const totals = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms,
             MIN(timestamp) as first_ts,
             MAX(timestamp) as last_ts
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
    `).get(clientId);

    // Per-day buckets (for chart)
    const perDay = db.prepare(`
      SELECT substr(timestamp, 1, 10) as date,
             COUNT(*) as count,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
      GROUP BY date
      ORDER BY date
    `).all(clientId);

    // Per-endpoint breakdown
    const perEndpoint = db.prepare(`
      SELECT endpoint, method,
             COUNT(*) as count,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(response_time_ms) as avg_ms
      FROM api_usage
      WHERE client_id = ? AND timestamp >= ${sinceExpr}
      GROUP BY endpoint, method
      ORDER BY count DESC
    `).all(clientId);

    // Latest requests
    const recent = db.prepare(`
      SELECT endpoint, method, status_code, response_time_ms, user_agent, ip, timestamp, error
      FROM api_usage
      WHERE client_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(clientId, limit);

    // Active flag: any request in last 24h
    const recent24h = db.prepare(`
      SELECT COUNT(*) as c FROM api_usage
      WHERE client_id = ? AND timestamp >= datetime('now', '-1 day')
    `).get(clientId).c;

    const total = totals.total || 0;
    const errors = totals.errors || 0;
    res.json({
      client_id: clientId,
      days,
      active_24h: recent24h > 0,
      requests_24h: recent24h,
      summary: {
        total,
        errors,
        error_rate_pct: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
        avg_response_ms: totals.avg_ms ? Math.round(totals.avg_ms) : null,
        first_request: totals.first_ts,
        last_request: totals.last_ts,
      },
      per_day: perDay,
      per_endpoint: perEndpoint,
      recent,
    });
  } catch (e) {
    logger.error('[api_usage]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/admin/data section builders (WP6.2) ─────────────────────────────
// The mega-handler is decomposed into independently-guarded sections: one
// failing section degrades to empty values instead of 502ing the whole panel.
// Each builder returns ONLY its payload slice; the handler merges them.

// Section: meta (test-pool flags, phone enrich, server list)
function _metaSection(merged) {
  // Flag test-pool modems so the frontend can keep headline counters
  // consistent with the fleet roster (which excludes them) and badge the
  // tiles. modem_meta is the source of truth for is_test_pool.
  try { annotateTestPool(merged.status, simulatorDb.testPoolKeySet()); }
  catch (e) { logger.warn('[data] test-pool annotate: ' + e.message); }
  // Offline modems report an empty live PHONE_NUMBER — fill it from the
  // persisted modem_meta so the phone still shows for disconnected modems.
  try {
    const _phoneMap = {};
    for (const r of db.prepare("SELECT server_name, imei, phone FROM modem_meta WHERE phone <> ''").all()) {
      _phoneMap[r.server_name + '|' + r.imei] = r.phone;
    }
    for (const m of (merged.status || [])) {
      const md = m && m.modem_details;
      if (!md || (md.PHONE_NUMBER && String(md.PHONE_NUMBER).trim())) continue;
      const srv = m._server || '';
      const raw = String(md.IMEI || '').indexOf(srv + '_') === 0 ? String(md.IMEI).slice(srv.length + 1) : String(md.IMEI || '');
      const ph = _phoneMap[srv + '|' + raw];
      if (ph) md.PHONE_NUMBER = ph;
    }
  } catch (e) { logger.warn('[data] phone enrich: ' + e.message); }
  const servers = getApiServers().map(s => {
    const sc = getServerCountries()[s.name] || {};
    return { name: s.name, publicIp: s.publicIp, country: sc.country, countryName: sc.name, tz: sc.tz, address: s.address || '' };
  });
  return { servers };
}

// Section: clients (roster modem counts + sanitized client list)
function _clientsSection() {
  // STABLE per-client modem count from the known_modems roster (24h
  // retention on lastClientSeen) — see the long comment history in git;
  // an offline modem keeps counting for 24h instead of vanishing.
  const _ROSTER_RETAIN_MS = 24 * 3600 * 1000;
  const _rosterNow = Date.now();
  const _clientModemSets = {};   // portName -> Set('server|imei')
  for (const [srvName, ports] of Object.entries(getKnownModems() || {})) {
    for (const [pid, info] of Object.entries(ports || {})) {
      if (!info || !info.portName || /^random/i.test(info.portName)) continue;
      // Identity may be absent for a bound-but-unreadable port — count it by
      // portId then (it bills traffic; БА «30 vs 32» case).
      const id = info.imei || info.nick || pid;
      const _lcs = info.lastClientSeen != null ? info.lastClientSeen : info.lastSeen;
      const ls = typeof _lcs === 'number' ? _lcs : Date.parse(_lcs || 0);
      if (!ls || (_rosterNow - ls) > _ROSTER_RETAIN_MS) continue;
      (_clientModemSets[info.portName] || (_clientModemSets[info.portName] = new Set())).add(srvName + '|' + id);
    }
  }
  const _clientModemCounts = {};
  for (const pn in _clientModemSets) _clientModemCounts[pn] = _clientModemSets[pn].size;
  const sanitizedClients = getClients().map(c => {
    const { password, passwordHash, ...safe } = c;
    safe.modemCount = _clientModemCounts[c.portName] || 0;
    return safe;
  });
  return { sanitizedClients };
}

function _clientsFallback() {
  return { sanitizedClients: getClients().map(c => { const { password, passwordHash, ...safe } = c; return safe; }) };
}

// Section: billing (month aggregates + canonical revenue_30d)
function _billingSection() {
  // Stage 4: SQL aggregate replaces in-memory walk of `billingLedger`.
  const clientMonthCharges = {};
  const clientMonthGb = {};
  // WP8 UTC→MSK fix: month prefix is a Moscow date, always.
  const curMonthPfx = getMoscowToday().slice(0, 7);
  const monthRows = _ledgerMonthAggStmt.all(`${curMonthPfx}%`);
  for (const r of monthRows) {
    const entry = r.type === 'charge'
      ? { type: r.type, cost: r.amount, balance_before: r.balance_before, balance_after: r.balance_after }
      : { type: r.type, amount: r.amount, balance_before: r.balance_before, balance_after: r.balance_after };
    const exp = ledgerExpense(entry);
    if (exp !== 0) clientMonthCharges[r.client_id] = (clientMonthCharges[r.client_id] || 0) + exp;
    if (r.gb_used != null) clientMonthGb[r.client_id] = (clientMonthGb[r.client_id] || 0) + r.gb_used;
  }
  for (const k of Object.keys(clientMonthCharges)) clientMonthCharges[k] = Math.round(clientMonthCharges[k] * 100) / 100;
  for (const k of Object.keys(clientMonthGb)) clientMonthGb[k] = Math.round(clientMonthGb[k] * 1000) / 1000;
  // Canonical revenue (WP8): rolling 30 MSK days, charge + correction via
  // ledgerExpense — the SAME number as /api/admin/finance_dashboard shows.
  const revenue30d = computeRevenueWindow({ db, ledgerExpense, today: getMoscowToday(), days: 30 });
  return { clientMonthCharges, clientMonthGb, revenue30d };
}

// Section: traffic (live month, last hour, today, yesterday override, trends)
function _trafficSection(merged) {
  const portNameToClientId = {};
  for (const c of getClients()) {
    if (c.portName) portNameToClientId[c.portName] = c.id;
  }
  // Live month traffic per client from ProxySmart real-time counters.
  const clientLiveMonthGb = {};
  const portNameBytes = {};
  for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
    const pn = bwData.portName;
    if (!pn || !portNameToClientId[pn]) continue;
    if (!portNameBytes[pn]) portNameBytes[pn] = 0;
    portNameBytes[pn] += parseBwToBytes(bwData.bandwidth_bytes_month_in);
    portNameBytes[pn] += parseBwToBytes(bwData.bandwidth_bytes_month_out);
  }
  for (const [pn, bytes] of Object.entries(portNameBytes)) {
    const cid = portNameToClientId[pn];
    if (cid && bytes > 0) clientLiveMonthGb[cid] = trafficBytesToGb(bytes);
  }
  // Last FULLY COMPLETED hour per client (never the in-progress bucket).
  const clientLastHourGb = {};
  const rows = db.prepare(`
    SELECT client_name, SUM(bytes_in + bytes_out) as total
    FROM traffic_hourly
    WHERE client_name != ''
      AND hour_start = (
        SELECT MAX(hour_start) FROM traffic_hourly
        WHERE client_name != ''
          AND hour_start < strftime('%Y-%m-%d %H:00', 'now')
      )
    GROUP BY client_name
  `).all();
  for (const r of rows) {
    const cid = portNameToClientId[r.client_name];
    if (cid) clientLastHourGb[cid] = trafficBytesToGb(r.total);
  }
  // Today per client from live data.
  const clientTodayGb = {};
  for (const [bwKey, bwData] of Object.entries(merged.bandwidth || {})) {
    const pn = bwData.portName;
    if (!pn || !portNameToClientId[pn]) continue;
    const cid = portNameToClientId[pn];
    if (!clientTodayGb[cid]) clientTodayGb[cid] = 0;
    clientTodayGb[cid] += trafficBytesToGb(parseBwToBytes(bwData.bandwidth_bytes_day_in) + parseBwToBytes(bwData.bandwidth_bytes_day_out));
  }
  // Override yesterday bandwidth with recorded daily_traffic (stable, not degraded by modem restarts)
  const _yesterdayStr = getMoscowYesterday();
  for (const [portId, bwData] of Object.entries(merged.bandwidth || {})) {
    const dt = getDailyTraffic()[portId]?.[_yesterdayStr];
    if (dt) {
      bwData.bandwidth_bytes_yesterday_in = dt.in || 0;
      bwData.bandwidth_bytes_yesterday_out = dt.out || 0;
    }
  }
  // Trends (cached 60s by the _getXxxTrend helpers).
  const modemTrend = _getModemTrend();
  const clientTrend = _getClientTrend();
  return { clientLiveMonthGb, clientLastHourGb, clientTodayGb, modemTrend, clientTrend };
}

// Section: fleet (roster count + per-client «в работе»)
function _fleetSection(merged, sanitizedClients) {
  // Modem fleet KPI — one coherent count (src/modems/fleet.js):
  //   total  = STABLE roster; active = online ≤48h ∪ online now;
  //   working = active − disconnected.
  const fleet = computeFleet(_fleetMetaStmt.all(), getUptimeTracking(), merged.status || []);
  // Per-client «в работе» with fleet semantics (active ∩ not-dark-≥10min).
  const _clientWorking = computeClientWorking(getKnownModems(), fleet);
  for (const c of sanitizedClients) {
    c.modemWorking = c.portName ? (_clientWorking[c.portName] || 0) : 0;
  }
  return { fleet };
}

r.get('/api/admin/data', dashboardLimiter, authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const results = await getFetchAllServersDataCached()();
    const merged = getMergeServerData()(results, '*');
    const meta = _runSection(logger, 'meta', () => _metaSection(merged), { servers: [] });
    const clientsSec = _runSection(logger, 'clients', _clientsSection, _clientsFallback());
    const billingSec = _runSection(logger, 'billing', _billingSection, { clientMonthCharges: {}, clientMonthGb: {}, revenue30d: { byClient: {}, total: 0, windowDays: 30, asOf: getMoscowToday() } });
    const trafficSec = _runSection(logger, 'traffic', () => _trafficSection(merged), { clientLiveMonthGb: {}, clientLastHourGb: {}, clientTodayGb: {}, modemTrend: {}, clientTrend: {} });
    const fleetSec = _runSection(logger, 'fleet', () => _fleetSection(merged, clientsSec.sanitizedClients), { fleet: { total: 0, online: 0, offline: 0, byServer: {} } });

    res.json({
      connsHistory: (deps.getConnsHistory ? deps.getConnsHistory() : {}),
      clientMonthCharges: billingSec.clientMonthCharges,
      clientMonthGb: billingSec.clientMonthGb,
      clientLiveMonthGb: trafficSec.clientLiveMonthGb,
      clientLastHourGb: trafficSec.clientLastHourGb,
      clientTodayGb: trafficSec.clientTodayGb,
      modemTrend: trafficSec.modemTrend,
      clientTrend: trafficSec.clientTrend,
      fleet: fleetSec.fleet,
      // Canonical revenue metric (WP8) — same source as finance_dashboard.
      metrics: { revenue_30d: billingSec.revenue30d.total, window_days: 30, as_of: billingSec.revenue30d.asOf },
      clientRevenue30d: billingSec.revenue30d.byClient,
      // Per-client counters use the known_modems roster with 24h retention —
      // deliberately NARROWER than fleet 48h (WP1.4).
      rosterWindowHours: 24,
      ...merged,
      servers: meta.servers,
      clients: clientsSec.sanitizedClients,
      ipTracking: getIpTracking(),
      uptimeTracking: getUptimeTracking(),
      speedtestLatest: getSpeedtestLatest(),
      ipHistory: getIpHistory(),
      settings: appSettings,
      bankPayments: getAllBankPayments(),
      tochkaConfigured: !!getTochkaConfig().jwt,
      tochkaConfig: (() => { const tc = getTochkaConfig(); return { jwt: tc.jwt ? '****' + tc.jwt.slice(-8) : '', clientId: tc.clientId, customerCode: tc.customerCode, accountId: tc.accountId, companyName: tc.companyName, companyInn: tc.companyInn, companyKpp: tc.companyKpp, companyAddress: tc.companyAddress, bankAccount: tc.bankAccount, bankName: tc.bankName, bankBic: tc.bankBic, bankCorrAccount: tc.bankCorrAccount }; })(),
      proxyCheckSummary: getProxyCheckSummary(),
      proxyIssues: computeProxyIssues(),
    });
  } catch (err) {
    res.status(502).json({ error: 'API request failed', details: err.message });
  }
});

r.get('/api/admin/system_health', authMiddleware, adminMiddleware, (req, res) => {
  try {
    // Billing success 24h
    const billing24 = db.prepare(`
      SELECT level, COUNT(*) as c FROM system_log
      WHERE category = 'billing' AND timestamp >= datetime('now', '-1 day')
      GROUP BY level
    `).all();
    const billingByLevel = {};
    for (const r of billing24) billingByLevel[r.level] = r.c;

    // API error rate
    const apiErrors24 = db.prepare(`
      SELECT COUNT(*) as c FROM system_log
      WHERE category = 'api' AND level = 'error' AND timestamp >= datetime('now', '-1 day')
    `).get().c;

    // Per-day system_log errors for trend
    const errorsByDay = db.prepare(`
      SELECT substr(timestamp, 1, 10) as date,
             SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors,
             SUM(CASE WHEN level = 'warn'  THEN 1 ELSE 0 END) as warns
      FROM system_log
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY date
      ORDER BY date
    `).all();

    // DB size — use the actual open DB file path (better-sqlite3 .name), not
    // path.join(__dirname,…) which resolved to src/routes/dashboard.db (does not
    // exist) and made the UI show 0 MB.
    let dbSizeBytes = 0;
    try { if (db.name) dbSizeBytes = fs.statSync(db.name).size; } catch (_) { /* best-effort */ }

    // Disk usage of the app's partition (the UI had no free-space indicator).
    let disk = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const st = fs.statfsSync(path.join(__dirname, '..', '..'));  // app root from src/routes/
        const totalB = st.blocks * st.bsize, freeB = st.bavail * st.bsize;
        if (totalB > 0) disk = {
          total_gb: Math.round(totalB / 1e9 * 10) / 10,
          free_gb:  Math.round(freeB  / 1e9 * 10) / 10,
          used_pct: Math.round((totalB - freeB) / totalB * 100),
        };
      }
    } catch (_) { /* statfs unsupported on this FS — leave null */ }

    // Server downtime history (mig 035) — recent unreachable episodes per server.
    let serverDowntime = [];
    try {
      serverDowntime = db.prepare(
        'SELECT server_name, down_from, down_to, duration_sec, alerted FROM server_downtime ORDER BY id DESC LIMIT 20'
      ).all();
    } catch (_) { /* table may not exist on a very old DB */ }

    // Sessions
    const sessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE expires_at > datetime('now')").get().c;

    // Memory
    const memUsage = process.memoryUsage();

    // Recent critical events
    const recentCritical = db.prepare(`
      SELECT id, timestamp, level, category, action, target, message, details
      FROM system_log
      WHERE level IN ('error', 'warn')
      ORDER BY id DESC
      LIMIT 50
    `).all();

    // Per-server uptime (from uptime_tracking via live data)
    const serverStatus = getApiServers().map(s => {
      const sc = getServerCountries()[s.name] || {};
      return {
        name: s.name,
        country: sc.name || '',
        publicIp: s.publicIp || ''
      };
    });

    res.json({
      timestamp: new Date().toISOString(),
      billing_24h: billingByLevel,
      api_errors_24h: apiErrors24,
      errors_by_day: errorsByDay,
      db: {
        size_bytes: dbSizeBytes,
        size_mb: Math.round(dbSizeBytes / 1048576 * 10) / 10
      },
      disk,
      server_downtime: serverDowntime,
      sessions: sessionCount,
      memory: {
        rss_mb: Math.round(memUsage.rss / 1048576),
        heap_mb: Math.round(memUsage.heapUsed / 1048576),
        heap_total_mb: Math.round(memUsage.heapTotal / 1048576)
      },
      uptime_sec: Math.round(process.uptime()),
      recent_critical: recentCritical,
      servers: serverStatus
    });
  } catch (e) {
    logger.error('[system_health]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/audit_log', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const total = dbStmts.countAuditLog.get().cnt;
  const rows = dbStmts.getAuditLog.all(limit, offset);
  // Parse details JSON back to object for frontend
  const entries = rows.map(r => {
    let details = {};
    try { details = JSON.parse(r.details || '{}'); } catch (_) { /* best-effort: error intentionally swallowed */ }
    return { timestamp: r.timestamp, admin: r.admin, action: r.action, ...details };
  });
  res.json({ total, offset, limit, entries });
});

r.post('/api/admin/restart_dashboard', authMiddleware, adminMiddleware, (req, res) => {
  logger.info(`[Admin] Dashboard restart requested by ${req.user.login}`);
  logActivity('admin', 'warn', 'dashboard_restart', null, `Dashboard restart requested by ${req.user.login}`);
  res.json({ ok: true, message: 'Restarting...' });
  setTimeout(() => process.exit(0), 500);
});

r.get('/api/admin/backup', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/crud/backup_export');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Backup failed', details: err.message }); }
});

r.get('/api/admin/system_log', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const category = req.query.category || null;
    const level = req.query.level || null;
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();

    const rows = dbStmts.systemLogQueryFiltered.all(from, category, category, level, level, limit);
    res.json({ success: true, entries: rows, total: rows.length });
  } catch (e) {
    logger.error('[SystemLog API] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

  return r;
};

// Exported for tests (WP6.2): the degradation wrapper used by /api/admin/data.
module.exports._runSection = _runSection;
