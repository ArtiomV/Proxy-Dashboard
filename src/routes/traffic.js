'use strict';
//
// src/routes/traffic.js — traffic-data endpoints (Stage 3).
//
// 7 routes:
//   GET  /api/client/daily_traffic            — per-client daily breakdown
//   GET  /api/admin/daily_traffic             — admin: all clients by day
//   POST /api/admin/backfill_daily_traffic    — recompute past days from hourly
//   GET  /api/admin/bandwidth_single          — ProxySmart passthrough (single port)
//   GET  /api/admin/bandwidth_period          — ProxySmart passthrough (range)
//   POST /api/admin/reset_bandwidth           — ProxySmart counter reset
//   GET  /api/admin/unique_ips                — count distinct IPs per modem

const express = require('express');

module.exports = function createTrafficRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    fetchAllServersDataCached, mergeServerData,
    fetchApi, postApi, findServer,
    getMoscowToday, trafficBytesToGb, parseBwToBytes, parseTrafficValue,
    normalizeOperator,
    clients, clientByLogin, clientById,
    dailyTraffic, portKeyToPortName,
    knownModems, SERVER_COUNTRIES,
    _dtUpsert,
    refreshPortKeyMapping,
    logActivity,
  } = deps;
  const r = express.Router();

r.get('/api/client/daily_traffic', authMiddleware, async (req, res) => {
  const clientInfo = clientByLogin.get(req.user.login);
  if (!clientInfo) return res.status(404).json({ error: 'Client not found' });

  const portNameFilter = clientInfo.portName || req.user.portNameFilter;
  const fromDate = req.query.from || '';
  const toDate = req.query.to || '';
  const includeToday = req.query.include_today === '1';
  const result = {};

  // Use global portKey→portName mapping (refreshed by billing)
  // Fallback: refresh from cache if mapping is empty
  if (Object.keys(portKeyToPortName).length === 0) {
    try {
      const cachedResults = await fetchAllServersDataCached();
      refreshPortKeyMapping(cachedResults);
    } catch (e) { /* cache may not be ready yet */ }
  }
  const portNameMap = portKeyToPortName;

  // Collect daily traffic for ports matching this client's portName
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    let match = false;
    if (portNameFilter === '*') {
      match = true;
    } else {
      const firstDay = Object.values(days)[0];
      const pn = (firstDay && firstDay.portName) || portNameMap[portId] || portId;
      if (pn === portNameFilter) match = true;
    }
    if (match) {
      // Filter by date range
      const filtered = {};
      for (const [d, entry] of Object.entries(days)) {
        if (fromDate && d < fromDate) continue;
        if (toDate && d > toDate) continue;
        filtered[d] = entry;
      }
      if (Object.keys(filtered).length > 0) {
        result[portId] = filtered;
      }
    }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

  if (includeToday) {
    // Add today's live data from ProxySmart
    try {
      const results = await fetchAllServersDataCached();
      const merged = mergeServerData(results, portNameFilter);
      const todayData = {};
      for (const [portId, b] of Object.entries(merged.bandwidth || {})) {
        const dIn = parseTrafficValue(b.bandwidth_bytes_day_in);
        const dOut = parseTrafficValue(b.bandwidth_bytes_day_out);
        if (dIn > 0 || dOut > 0) {
          todayData[portId] = { in: dIn, out: dOut, portName: b.portName || '' };
        }
      }
      res.json({ daily: result, today: todayData, todayDate: today });
    } catch (err) {
      res.json({ daily: result, today: {}, todayDate: today });
    }
  } else {
    res.json({ daily: result, today: {}, todayDate: today });
  }
});

r.get('/api/admin/daily_traffic', authMiddleware, adminMiddleware, async (req, res) => {
  // Return daily traffic aggregated by client (portName) for each day
  const results = await fetchAllServersDataCached();
  // Build fresh portId -> portName and portId -> serverName mappings from live data
  const pnMap = {};
  const portIdToServer = {};
  for (const data of results) {
    const srvName = data.serverName || '';
    if (typeof data.bw !== 'object') continue;
    for (const [portId, b] of Object.entries(data.bw)) {
      const fullKey = srvName + '_' + portId;
      portIdToServer[portId] = srvName;
      portIdToServer[fullKey] = srvName;
      if (b.portName) { pnMap[fullKey] = b.portName; pnMap[portId] = b.portName; }
    }
  }
  const byClient = {};
  // Historical days from dailyTraffic
  for (const [portId, days] of Object.entries(dailyTraffic)) {
    const pn = pnMap[portId] || 'Не назначен';
    const srv = portIdToServer[portId] || (portId.match(/^(S\d+)_/) ? portId.match(/^(S\d+)_/)[1] : '');
    if (!byClient[pn]) byClient[pn] = {};
    for (const [date, entry] of Object.entries(days)) {
      if (!byClient[pn][date]) byClient[pn][date] = { in: 0, out: 0, servers: {} };
      byClient[pn][date].in += entry.in || 0;
      byClient[pn][date].out += entry.out || 0;
      if (srv) {
        if (!byClient[pn][date].servers[srv]) byClient[pn][date].servers[srv] = { in: 0, out: 0 };
        byClient[pn][date].servers[srv].in += entry.in || 0;
        byClient[pn][date].servers[srv].out += entry.out || 0;
      }
    }
  }
  // Today's live data from bandwidth cache
  // Use Moscow time (GMT+3) for "today" since most servers are in Moldova/Romania (GMT+3/+3)
  const _nowLocal = new Date(Date.now() + 3 * 3600000);
  const todayStr = _nowLocal.toISOString().slice(0, 10);
  // For PAST days: override byClient with traffic_hourly aggregation.
  // traffic_hourly is updated every hour from counter deltas and uses UTC timestamps,
  // so we MSK-shift here to attribute traffic to the right calendar day.
  // This avoids the midnight "drop to zero" that happens when ProxySmart's
  // bandwidth_bytes_yesterday_* counter shifts later than MSK midnight (e.g., MD/RO winter TZ).
  try {
    const hourlyRows = db.prepare(`
      SELECT client_name as pn, server_name as srv,
             strftime('%Y-%m-%d', datetime(hour_start, '+3 hours')) as date,
             SUM(bytes_in) as bin, SUM(bytes_out) as bout
      FROM traffic_hourly
      WHERE hour_start >= datetime('now', '-31 days') AND client_name != ''
      GROUP BY pn, srv, date
    `).all();
    for (const r of hourlyRows) {
      if (r.date === todayStr) continue; // today comes from live counter below
      if (!byClient[r.pn]) byClient[r.pn] = {};
      // Authoritative override: traffic_hourly is the source of truth for past days
      if (!byClient[r.pn][r.date]) byClient[r.pn][r.date] = { in: 0, out: 0, servers: {} };
      // First time we see this (pn,date) combo: reset before summing servers
      if (byClient[r.pn][r.date]._th_seen !== true) {
        byClient[r.pn][r.date] = { in: 0, out: 0, servers: {}, _th_seen: true };
      }
      byClient[r.pn][r.date].in += r.bin;
      byClient[r.pn][r.date].out += r.bout;
      if (r.srv) {
        if (!byClient[r.pn][r.date].servers[r.srv]) byClient[r.pn][r.date].servers[r.srv] = { in: 0, out: 0 };
        byClient[r.pn][r.date].servers[r.srv].in = (byClient[r.pn][r.date].servers[r.srv].in || 0) + r.bin;
        byClient[r.pn][r.date].servers[r.srv].out = (byClient[r.pn][r.date].servers[r.srv].out || 0) + r.bout;
      }
    }
    // Strip helper flag before sending response
    for (const pn in byClient) for (const dt in byClient[pn]) delete byClient[pn][dt]._th_seen;
  } catch (e) {
    logger.warn('[daily_traffic] traffic_hourly override failed: ' + e.message);
  }
  for (const data of results) {
    if (typeof data.bw !== 'object') continue;
    const srvName = data.serverName || '';
    for (const [portId, b] of Object.entries(data.bw)) {
      const pn = b.portName || pnMap[(data.serverName || '') + '_' + portId] || 'Не назначен';
      const dayIn = parseBwToBytes(b.bandwidth_bytes_day_in);
      const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
      if (dayIn > 0 || dayOut > 0) {
        if (!byClient[pn]) byClient[pn] = {};
        if (!byClient[pn][todayStr]) byClient[pn][todayStr] = { in: 0, out: 0, servers: {} };
        byClient[pn][todayStr].in += dayIn;
        byClient[pn][todayStr].out += dayOut;
        if (srvName) {
          if (!byClient[pn][todayStr].servers[srvName]) byClient[pn][todayStr].servers[srvName] = { in: 0, out: 0 };
          byClient[pn][todayStr].servers[srvName].in += dayIn;
          byClient[pn][todayStr].servers[srvName].out += dayOut;
        }
      }
    }
  }
  // If detail=modems, also return per-modem (per-nick) breakdown
  if (req.query.detail === 'modems') {
    const byModem = {};
    // Build portId → nick mapping from known modems + status
    // Build portId→nick from known_modems.json (reliable) + live status (fresh)
    const portIdToNick = {};
    const portIdToClientName = {};
    const portIdToOperator = {};
    // known_modems.json: { "S1": { "portXXX": { nick, portName } }, "S2": { ... } }
    for (const srv in knownModems) {
      for (const portId in knownModems[srv]) {
        const info = knownModems[srv][portId];
        if (info.nick) portIdToNick[srv + '_' + portId] = info.nick;
        if (info.portName) portIdToClientName[srv + '_' + portId] = info.portName;
      }
    }
    // Override with live status (may have newer nicks) + capture operator
    for (const data of results) {
      const statusArr = Array.isArray(data.status) ? data.status : [];
      const portsMap = data.ports || {};
      const srvName = data.serverName || '';
      const srvCountry = (SERVER_COUNTRIES[srvName] || {}).country || '';
      const isRO = srvCountry === 'RO';
      for (const m of statusArr) {
        const md = m.modem_details || {};
        const imei = md.IMEI;
        const nick = md.NICK || imei;
        if (!imei) continue;
        const rawOp = (m.net_details && m.net_details.CELLOP) || md.OPERATOR || '';
        const op = normalizeOperator(rawOp.toLowerCase().trim(), isRO);
        const modemPorts = portsMap[imei] || [];
        for (const p of modemPorts) {
          // dailyTraffic keys are server-prefixed ("S2_portXXX"); raw data.ports
          // entries have bare portIDs. Write BOTH so dailyTraffic loop below
          // resolves no matter which form it iterates over.
          const bareId = p.portID;
          const prefId = srvName + '_' + bareId;
          portIdToNick[bareId] = nick;
          portIdToNick[prefId] = nick;
          if (op) {
            portIdToOperator[bareId] = op;
            portIdToOperator[prefId] = op;
          }
          if (p.portName) {
            portIdToClientName[bareId] = p.portName;
            portIdToClientName[prefId] = p.portName;
          }
        }
      }
    }
    // Historical from dailyTraffic — group by nick+portName (one modem can serve multiple clients)
    for (const [portId, days] of Object.entries(dailyTraffic)) {
      const nick = portIdToNick[portId] || portId.replace(/^S\d+_port/, '');
      const pn = portIdToClientName[portId] || (Object.values(days)[0] && Object.values(days)[0].portName) || pnMap[portId] || '';
      const srv = portIdToServer[portId] || '';
      const op = portIdToOperator[portId] || '';
      const modemKey = nick + (pn ? ':' + pn : '');
      if (!byModem[modemKey]) byModem[modemKey] = { portName: pn, server: srv, nick: nick, operator: op, days: {} };
      else if (!byModem[modemKey].operator && op) byModem[modemKey].operator = op;
      for (const [date, entry] of Object.entries(days)) {
        if (!byModem[modemKey].days[date]) byModem[modemKey].days[date] = 0;
        byModem[modemKey].days[date] += (entry.in || 0) + (entry.out || 0);
      }
    }
    // Today's live (bw keys already prefixed in merged data: S1_portXXX)
    const _nowLocal2 = new Date(Date.now() + 3 * 3600000);
    const todayStr2 = _nowLocal2.toISOString().slice(0, 10);
    for (const data of results) {
      if (typeof data.bw !== 'object') continue;
      for (const [portId, b] of Object.entries(data.bw)) {
        const nick = portIdToNick[portId] || portId;
        const pn2 = b.portName || portIdToClientName[portId] || '';
        const modemKey2 = nick + (pn2 ? ':' + pn2 : '');
        const dayIn = parseBwToBytes(b.bandwidth_bytes_day_in);
        const dayOut = parseBwToBytes(b.bandwidth_bytes_day_out);
        if (dayIn + dayOut > 0) {
          if (!byModem[modemKey2]) byModem[modemKey2] = { portName: pn2, server: data.serverName, nick: nick, operator: portIdToOperator[portId] || '', days: {} };
          if (!byModem[modemKey2].days[todayStr2]) byModem[modemKey2].days[todayStr2] = 0;
          byModem[modemKey2].days[todayStr2] += dayIn + dayOut;
        }
      }
    }
    return res.json({ clients: byClient, modems: byModem });
  }
  res.json(byClient);
});

r.post('/api/admin/backfill_daily_traffic', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const date = String(req.body?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required in YYYY-MM-DD (MSK)' });
    }
    // Reject future / today (today is still live)
    const todayMsk = getMoscowToday();
    if (date >= todayMsk) {
      return res.status(400).json({ error: 'date must be in the past (today is live via bandwidth_bytes_day_*)' });
    }
    // Aggregate per port_id for the given MSK day
    const rows = db.prepare(`
      SELECT port_id, client_name,
             SUM(bytes_in)  AS bytes_in,
             SUM(bytes_out) AS bytes_out,
             COUNT(*)       AS hours
      FROM traffic_hourly
      WHERE substr(datetime(hour_start, '+3 hours'), 1, 10) = ?
      GROUP BY port_id
    `).all(date);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'no traffic_hourly data for that MSK day', date });
    }

    let written = 0, totalBytes = 0, skippedExisting = 0;
    const force = req.body?.force === true;

    const tx = db.transaction(() => {
      for (const r of rows) {
        const bIn  = Number(r.bytes_in  || 0);
        const bOut = Number(r.bytes_out || 0);
        if (bIn === 0 && bOut === 0) continue;

        // If an existing daily_traffic row has non-zero data, respect it
        // unless caller explicitly passes force=true.
        if (!force) {
          const existing = db.prepare(
            'SELECT bytes_in, bytes_out FROM daily_traffic WHERE port_name = ? AND date = ?'
          ).get(r.port_id, date);
          if (existing && (existing.bytes_in > 0 || existing.bytes_out > 0)) {
            skippedExisting++;
            continue;
          }
        }

        _dtUpsert.run(r.port_id, date, bIn, bOut);
        // Sync in-memory so the daily chart reflects the backfill immediately
        if (!dailyTraffic[r.port_id]) dailyTraffic[r.port_id] = {};
        dailyTraffic[r.port_id][date] = {
          in: bIn, out: bOut, portName: r.client_name || ''
        };
        written++;
        totalBytes += bIn + bOut;
      }
    });
    tx();

    const totalGb = Math.round(totalBytes / 1e9 * 1000) / 1000;
    logger.info(`[Backfill] daily_traffic for ${date}: ${written} ports, ${totalGb} GB (skipped ${skippedExisting} existing)`);
    logActivity('traffic', 'info', 'backfill_daily', null,
      `Backfilled daily_traffic for ${date}: ${written} ports, ${totalGb} GB`,
      { date, written, total_gb: totalGb, skipped_existing: skippedExisting });

    res.json({
      ok: true, date,
      written, skipped_existing: skippedExisting,
      total_bytes: totalBytes, total_gb: totalGb,
      port_count: rows.length
    });
  } catch (e) {
    logger.error('[Backfill] daily_traffic error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/admin/bandwidth_single', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.query;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_report_json?arg=${encodeURIComponent(portId)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.get('/api/admin/bandwidth_period', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName, start, end } = req.query;
    if (!portId || !serverName || !start || !end) return res.status(400).json({ error: 'portId, serverName, start, end required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/get_counters_port?PORTID=${encodeURIComponent(portId)}&START=${encodeURIComponent(start)}&END=${encodeURIComponent(end)}`);
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.post('/api/admin/reset_bandwidth', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { portId, serverName } = req.body;
    if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, `/apix/bandwidth_reset_counter?arg=${encodeURIComponent(portId)}`);
    res.json({ ok: true, result });
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

r.get('/api/admin/unique_ips', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { serverName } = req.query;
    if (!serverName) return res.status(400).json({ error: 'serverName required' });
    const server = findServer(serverName);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const result = await fetchApi(server, '/apix/unique_ips_json');
    res.json(result);
  } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
});

  return r;
};
