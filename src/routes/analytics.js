'use strict';
//
// src/routes/analytics.js — read-only analytics endpoints (Stage 3).
//
// 11 admin-only routes powering the Analytics tab in admin.html:
//   monthly_traffic, heatmap, modem_heatmap, latency_stats, latency_day,
//   modem_health, rotations, ip_stats, traffic_forecast, capacity,
//   logs_domains_full
//
// Each route is a SELECT-heavy read of traffic_hourly / proxy_checks /
// rotation_log / etc. No mutations, no shared state besides the live
// ProxySmart cache. Dependencies are dense but well-defined — factory
// pulls every helper they need from server.js.

const express = require('express');

module.exports = function createAnalyticsRouter(deps) {
  // Bare-name destructure: these live as let/const bindings in server.js
  // but are never REASSIGNED (only mutated), so a direct ref is safe.
  // For ones that DO get rebound (none currently in analytics scope),
  // pass a getter instead.
  const {
    db, logger, authMiddleware, adminMiddleware,
    fetchAllServersDataCached, mergeServerData,
    getMoscowToday,
    trafficBytesToGb, parseTrafficValue, parseBwToBytes,
    normalizeOperator,
    SERVER_COUNTRIES,
    computeClientSlaMetrics,
    clients, clientById, clientByLogin,
    dailyTraffic, ipTracking, uptimeTracking, knownModems,
    portKeyToPortName,
    appSettings,
  } = deps;
  const r = express.Router();

r.get('/api/analytics/monthly_traffic', authMiddleware, adminMiddleware, (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)
    .toISOString().slice(0, 10);
  try {
    const rows = db.prepare(
      'SELECT substr(date,1,7) as month, SUM(bytes_in+bytes_out) as total_bytes ' +
      'FROM daily_traffic WHERE date >= ? GROUP BY month ORDER BY month'
    ).all(startDate);
    const byMonth = {};
    for (const r of rows) byMonth[r.month] = r.total_bytes || 0;
    // Add today's bytes from in-memory store (saved nightly, so today may be partial)
    const todayStr = now.toISOString().slice(0, 10);
    const curMonth = todayStr.slice(0, 7);
    for (const days of Object.values(dailyTraffic)) {
      const t = days[todayStr];
      if (t) byMonth[curMonth] = (byMonth[curMonth] || 0) + (t.in || 0) + (t.out || 0);
    }
    const MONTHS_RU = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const result = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mStr = d.toISOString().slice(0, 7);
      const totalGb = Math.round((byMonth[mStr] || 0) / 1e9 * 10) / 10;
      const entry = { month: mStr, label: MONTHS_RU[d.getMonth()], total_gb: totalGb };
      if (i === 0) {
        entry.is_current = true;
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        // Forecast: extrapolate from completed days (dom-1, since today is incomplete)
        const completedDays = Math.max(dom - 1, 1);
        if (completedDays >= 2 && totalGb > 0) {
          entry.forecast_gb = Math.round(totalGb / completedDays * dim * 10) / 10;
        } else {
          // Use previous month total as initial plan
          const prevMStr = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
          const prevGb = Math.round((byMonth[prevMStr] || 0) / 1e9 * 10) / 10;
          if (prevGb > 0) entry.forecast_gb = prevGb;
        }
      }
      // Include today's live bandwidth for current month (from ProxySmart API cache)
      if (i === 0 && totalGb === 0) {
        // Try to get current month data from daily_traffic in-memory
        let todayTotal = 0;
        const todayStr2 = now.toISOString().slice(0, 10);
        for (const days of Object.values(dailyTraffic)) {
          const t = days[todayStr2];
          if (t) todayTotal += (t.in || 0) + (t.out || 0);
        }
        if (todayTotal > 0) entry.total_gb = Math.round(todayTotal / 1e9 * 10) / 10;
      }
      result.push(entry);
    }
    res.json(result);
  } catch (e) {
    logger.error('[monthly_traffic]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { view = 'country', id = 'all' } = req.query;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const cacheKey = `${view}|${id}|${days}`;
    const cached = _heatmapCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < HEATMAP_TTL_MS) {
      return res.json(cached.data);
    }
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');
    // Build server→country mapping
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }
    // Date list in Moscow time (dynamic offset via getTzOffset)
    const now2 = new Date();
    const mskOffset = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcFetchStart = startDate + 'T00:00:00Z';
    const utcFetchStartShifted = new Date(new Date(utcFetchStart).getTime() - mskOffset * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    const matrix = dateList.map(() => new Array(24).fill(0));

    // Build SQL filter based on view type — all filtering is on per-modem columns
    const tzHours = Math.round(Math.max(-12, Math.min(14, mskOffset)));
    const tzStr = (tzHours >= 0 ? '+' : '') + tzHours + ' hours';
    let sql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes, MAX(uncertain) as corrected FROM traffic_hourly WHERE hour_start >= ?`;
    const params = [utcFetchStartShifted];

    if (idKey !== 'all') {
      if (view === 'country') {
        // Find server names for this country
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          sql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          params.push(...servers);
        }
      } else if (view === 'operator') {
        // Filter by operator column (case-insensitive LIKE)
        sql += " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        params.push('%' + idKey + '%');
      } else if (view === 'client') {
        // Filter by client_name column (exact match)
        sql += " AND client_name = ?";
        params.push(id);
      }
    }

    sql += ' GROUP BY day, hour ORDER BY day, hour';
    const rows = db.prepare(sql).all(...params);
    let hasData = false;
    const correctedCells = dateList.map(() => new Array(24).fill(false));
    const dateIdx = new Map(dateList.map((d, i) => [d, i]));
    for (const r of rows) {
      const di = dateIdx.get(r.day);
      if (di !== undefined && r.hour >= 0 && r.hour < 24) {
        matrix[di][r.hour] = r.bytes / 1e9;
        if (r.corrected) correctedCells[di][r.hour] = true;
        hasData = true;
      }
    }

    // Per-operator breakdown for country and client views
    let operator_breakdown;
    if (view === 'country' || view === 'client') {
      operator_breakdown = dateList.map(() => Array.from({ length: 24 }, () => ({})));
      let opSql = `SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr}')) AS INTEGER) as hour, operator, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE hour_start >= ?`;
      const opParams = [utcFetchStartShifted];
      if (view === 'client') {
        opSql += ' AND client_name = ?';
        opParams.push(id);
      } else if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          opSql += ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          opParams.push(...servers);
        }
      }
      opSql += ' GROUP BY day, hour, operator ORDER BY day, hour, operator';
      const opRows = db.prepare(opSql).all(...opParams);
      for (const r of opRows) {
        const di = dateIdx.get(r.day);
        if (di !== undefined && r.hour >= 0 && r.hour < 24 && r.operator) {
          operator_breakdown[di][r.hour][r.operator] = r.bytes / 1e9;
        }
      }
    }

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()], dateShort: date.slice(5) };
    });
    const resp = {
      meta: { id, days: dateList, day_meta: dayMeta, has_hourly: hasData, corrected: correctedCells },
      matrix
    };
    if (operator_breakdown) resp.operator_breakdown = operator_breakdown;
    _heatmapCache.set(cacheKey, { ts: Date.now(), data: resp });
    // Bound cache size — evict oldest when > 200 entries (very defensive)
    if (_heatmapCache.size > 200) {
      const oldestKey = _heatmapCache.keys().next().value;
      _heatmapCache.delete(oldestKey);
    }
    res.json(resp);
  } catch (e) {
    logger.error('[heatmap]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/modem_heatmap', authMiddleware, adminMiddleware, async (req, res) => {
  const { nick, serverName } = req.query;
  if (!nick || !serverName) return res.status(400).json({ error: 'nick and serverName required' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
  try {
    const mhCacheKey = `modem|${serverName}|${nick}|${days}`;
    const mhCached = _heatmapCache.get(mhCacheKey);
    if (mhCached && Date.now() - mhCached.ts < HEATMAP_TTL_MS) {
      return res.json(mhCached.data);
    }
    const now2 = new Date();
    const mskOffset2 = getTzOffset('Europe/Moscow');
    const mskNow = new Date(now2.getTime() + mskOffset2 * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }
    const startDate = dateList[0];
    const utcStart = new Date(new Date(startDate + 'T00:00:00Z').getTime() - mskOffset2 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

    // Get combined traffic for this modem (aggregated across all ports)
    const result = {};
    const dateIdx2 = new Map(dateList.map((d, i) => [d, i]));
    const clientRow = db.prepare("SELECT client_name FROM traffic_hourly WHERE nick = ? AND server_name = ? AND hour_start >= ? LIMIT 1").get(nick, serverName, utcStart);
    const clientLabel = (clientRow && clientRow.client_name) || nick;
    const matrix = dateList.map(() => new Array(24).fill(0));
    const tzH2 = Math.round(Math.max(-12, Math.min(14, mskOffset2)));
    const tzStr2 = (tzH2 >= 0 ? '+' : '') + tzH2 + ' hours';
    const rows = db.prepare(`SELECT strftime('%Y-%m-%d', datetime(hour_start, '${tzStr2}')) as day, CAST(strftime('%H', datetime(hour_start, '${tzStr2}')) AS INTEGER) as hour, SUM(bytes_in+bytes_out) as bytes FROM traffic_hourly WHERE nick = ? AND server_name = ? AND hour_start >= ? GROUP BY day, hour`).all(nick, serverName, utcStart);
    for (const r of rows) {
      const di = dateIdx2.get(r.day);
      if (di !== undefined && r.hour >= 0 && r.hour < 24) matrix[di][r.hour] = r.bytes / 1e9;
    }
    result[clientLabel] = { portId: nick, clientName: clientLabel, matrix };

    const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayMeta = dateList.map(date => {
      const d = new Date(date + 'T00:00:00');
      return { date, label: DAYS_RU[d.getDay()] };
    });
    const mhResp = { nick, serverName, days: dateList, day_meta: dayMeta, ports: result };
    _heatmapCache.set(mhCacheKey, { ts: Date.now(), data: mhResp });
    res.json(mhResp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/latency_stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { view = 'country', id = 'all' } = req.query;
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');

    const mskOffset = getTzOffset('Europe/Moscow');
    const tzHours2 = Math.round(Math.max(-12, Math.min(14, mskOffset)));
    const tzStr = (tzHours2 >= 0 ? '+' : '') + tzHours2 + ' hours';
    const now2 = new Date();
    const since = new Date(now2.getTime() - days * 86400000).toISOString();
    // Prior period: equal-length window immediately preceding `since`.
    const priorSince = new Date(now2.getTime() - days * 2 * 86400000).toISOString();
    const priorUntil = since;

    // Build server→country mapping
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }

    let filter = '';
    const filterParams = [];
    if (idKey !== 'all') {
      if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          filter = ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          filterParams.push(...servers);
        }
      } else if (view === 'operator') {
        filter = " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        filterParams.push('%' + idKey + '%');
      } else if (view === 'client') {
        filter = " AND client_name = ?";
        filterParams.push(id);
      }
    }

    // Current window: per-day values + counts. total_ms = full request (modem→site),
    // connect_ms = TCP handshake to modem only. Both reported separately so the
    // operator can tell whether slow checks are modem-side or upstream.
    const dayValsSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND total_ms IS NOT NULL AND error IS NULL${filter} ORDER BY day, total_ms`;
    const errSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND error IS NOT NULL${filter} GROUP BY day`;
    const totalSql = `SELECT strftime('%Y-%m-%d', datetime(checked_at, '${tzStr}')) as day, COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ?${filter} GROUP BY day`;
    const rows = db.prepare(dayValsSql).all(since, ...filterParams);
    const errRows = db.prepare(errSql).all(since, ...filterParams);
    const totalRows = db.prepare(totalSql).all(since, ...filterParams);

    const byDay = {};
    const allVals = [];
    const allConnectVals = [];
    for (const r of rows) {
      if (!byDay[r.day]) byDay[r.day] = [];
      byDay[r.day].push(r.total_ms);
      allVals.push(r.total_ms);
      if (r.connect_ms != null) allConnectVals.push(r.connect_ms);
    }
    const errMap = {};
    let totalErrs = 0;
    for (const r of errRows) { errMap[r.day] = r.cnt; totalErrs += r.cnt; }
    const totalMap = {};
    let totalChecks = 0;
    for (const r of totalRows) { totalMap[r.day] = r.cnt; totalChecks += r.cnt; }

    // Percentile helper — input must already be sorted ascending.
    const pctile = (sorted, p) => {
      if (!sorted.length) return null;
      const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
      return sorted[Math.max(0, idx)];
    };

    // Date list in Moscow time (consistent with heatmap)
    const mskNow = new Date(now2.getTime() + mskOffset * 3600 * 1000);
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() - i));
      dateList.push(d.toISOString().slice(0, 10));
    }

    const result = {
      days: dateList,
      median_ms: [], avg_ms: [], p75_ms: [], p95_ms: [], p99_ms: [],
      error_pct: [], total_checks: []
    };
    for (const day of dateList) {
      const vals = byDay[day] || [];
      const total = totalMap[day] || 0;
      const errs = errMap[day] || 0;
      if (vals.length === 0) {
        result.median_ms.push(null);
        result.avg_ms.push(null);
        result.p75_ms.push(null);
        result.p95_ms.push(null);
        result.p99_ms.push(null);
      } else {
        // vals already sorted ascending (SQL ORDER BY day, total_ms)
        result.median_ms.push(pctile(vals, 0.5));
        result.p75_ms.push(pctile(vals, 0.75));
        result.p95_ms.push(pctile(vals, 0.95));
        result.p99_ms.push(pctile(vals, 0.99));
        result.avg_ms.push(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
      }
      result.error_pct.push(total > 0 ? Math.round(errs / total * 100) : null);
      result.total_checks.push(total);
    }

    // Overall percentiles across the whole window
    const allSorted = allVals.slice().sort((a, b) => a - b);
    const connectSorted = allConnectVals.slice().sort((a, b) => a - b);
    const overall = {
      total_checks: totalChecks,
      ok_checks: allVals.length,
      errors: totalErrs,
      error_pct: totalChecks > 0 ? Math.round(totalErrs / totalChecks * 1000) / 10 : null,
      p50: pctile(allSorted, 0.5),
      p75: pctile(allSorted, 0.75),
      p95: pctile(allSorted, 0.95),
      p99: pctile(allSorted, 0.99),
      // Connect-only percentiles (TCP handshake to modem, excludes upstream request)
      connect_p50: pctile(connectSorted, 0.5),
      connect_p75: pctile(connectSorted, 0.75),
      connect_p95: pctile(connectSorted, 0.95),
      connect_p99: pctile(connectSorted, 0.99),
    };

    // Distribution buckets — uses configured warn/bad thresholds.
    // very_slow boundary is 2× bad: visibly catastrophic checks.
    const warnMs = Number(appSettings.proxy_check_warn_ms) || 500;
    const badMs = Number(appSettings.proxy_check_bad_ms) || 2000;
    const verySlowMs = badMs * 2;
    const buckets = { fast: 0, ok: 0, slow: 0, very_slow: 0 };
    for (const v of allVals) {
      if (v < warnMs) buckets.fast++;
      else if (v < badMs) buckets.ok++;
      else if (v < verySlowMs) buckets.slow++;
      else buckets.very_slow++;
    }

    // Prior period (same filter, equal-length window immediately before `since`)
    const priorValsSql = `SELECT total_ms, connect_ms FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND total_ms IS NOT NULL AND error IS NULL${filter}`;
    const priorTotalSql = `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ?${filter}`;
    const priorErrSql = `SELECT COUNT(*) as cnt FROM proxy_checks WHERE checked_at >= ? AND checked_at < ? AND error IS NOT NULL${filter}`;
    const priorRows = db.prepare(priorValsSql).all(priorSince, priorUntil, ...filterParams);
    const priorTotal = db.prepare(priorTotalSql).get(priorSince, priorUntil, ...filterParams).cnt || 0;
    const priorErrs = db.prepare(priorErrSql).get(priorSince, priorUntil, ...filterParams).cnt || 0;
    const priorSorted = priorRows.map(r => r.total_ms).sort((a, b) => a - b);
    const priorConnectSorted = priorRows.map(r => r.connect_ms).filter(v => v != null).sort((a, b) => a - b);
    const prior = {
      total_checks: priorTotal,
      errors: priorErrs,
      error_pct: priorTotal > 0 ? Math.round(priorErrs / priorTotal * 1000) / 10 : null,
      p50: pctile(priorSorted, 0.5),
      p75: pctile(priorSorted, 0.75),
      p95: pctile(priorSorted, 0.95),
      p99: pctile(priorSorted, 0.99),
      connect_p50: pctile(priorConnectSorted, 0.5),
      connect_p75: pctile(priorConnectSorted, 0.75),
      connect_p95: pctile(priorConnectSorted, 0.95),
      connect_p99: pctile(priorConnectSorted, 0.99),
    };

    res.json({
      ...result,
      overall,
      buckets,
      prior,
      thresholds: { warn_ms: warnMs, bad_ms: badMs, very_slow_ms: verySlowMs }
    });
  } catch (e) {
    logger.error('[latency_stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/latency_day', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { view = 'country', id = 'all', date } = req.query;
    const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');

    // Determine MSK date
    const mskOffset = getTzOffset('Europe/Moscow');
    let mskDate;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      mskDate = date;
    } else {
      const now = new Date();
      const mskNow = new Date(now.getTime() + mskOffset * 3600 * 1000);
      mskDate = mskNow.toISOString().slice(0, 10);
    }

    // Convert MSK day boundaries to UTC
    const dayStartMsk = new Date(mskDate + 'T00:00:00Z');
    const dayStartUtc = new Date(dayStartMsk.getTime() - mskOffset * 3600 * 1000);
    const dayEndUtc = new Date(dayStartUtc.getTime() + 86400000);
    const utcFrom = dayStartUtc.toISOString();
    const utcTo = dayEndUtc.toISOString();

    // Build filter (same logic as latency_stats)
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }

    let filter = '';
    const params = [utcFrom, utcTo];
    if (idKey !== 'all') {
      if (view === 'country') {
        const servers = [];
        for (const [srv, cn] of Object.entries(serverCountryMap)) {
          if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
        }
        if (servers.length > 0) {
          filter = ' AND server_name IN (' + servers.map(() => '?').join(',') + ')';
          params.push(...servers);
        }
      } else if (view === 'operator') {
        filter = " AND LOWER(REPLACE(operator, ' ', '_')) LIKE ?";
        params.push('%' + idKey + '%');
      } else if (view === 'client') {
        filter = " AND client_name = ?";
        params.push(id);
      }
    }

    const sql = `SELECT nick, server_name, operator, client_name, checked_at,
      connect_ms, total_ms, status_code, error
      FROM proxy_checks
      WHERE checked_at >= ? AND checked_at < ?${filter}
      ORDER BY checked_at ASC`;

    const rows = db.prepare(sql).all(...params);

    // Build points with MSK time
    const points = [];
    let okCount = 0, errCount = 0, totalMsArr = [];
    for (const r of rows) {
      const utcMs = new Date(r.checked_at).getTime();
      const mskMs = utcMs + mskOffset * 3600 * 1000;
      const mskD = new Date(mskMs);
      const h = mskD.getUTCHours();
      const m = mskD.getUTCMinutes();
      const minutes = h * 60 + m;
      const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

      points.push({
        t: timeStr,
        min: minutes,
        nick: r.nick,
        op: r.operator || '',
        client: r.client_name || '',
        connect: r.connect_ms,
        total: r.total_ms,
        status: r.status_code,
        error: r.error || null
      });

      if (r.error) {
        errCount++;
      } else {
        okCount++;
        if (r.total_ms != null) totalMsArr.push(r.total_ms);
      }
    }

    // Summary
    const sorted = totalMsArr.slice().sort((a, b) => a - b);
    const summary = {
      total: points.length,
      ok: okCount,
      errors: errCount,
      median_ms: null,
      p95_ms: null,
      avg_ms: null
    };
    if (sorted.length > 0) {
      const mid = Math.floor(sorted.length / 2);
      summary.median_ms = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
      summary.avg_ms = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      summary.p95_ms = sorted[Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)];
    }

    res.json({ date: mskDate, points, summary });
  } catch (e) {
    logger.error('[latency_day]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/modem_health', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const sinceExpr = `datetime('now', '-${days} days')`;
    const badMs = Number(appSettings.proxy_check_bad_ms) || 1500;
    const errThreshold = Number(appSettings.error_rate_threshold) || 15;

    // Base set: modems active in the period (have proxy_checks OR traffic_hourly).
    // Deduplicates historical/moved modem_meta entries (e.g. modems migrated
    // between servers — multiple rows with same nick). Picks the most recently
    // updated modem_meta row per (server, nick) as authoritative source of operator.
    const modems = db.prepare(`
      WITH active AS (
        SELECT DISTINCT server_name, nick FROM proxy_checks
        WHERE checked_at >= ${sinceExpr}
        UNION
        SELECT DISTINCT server_name, nick FROM traffic_hourly
        WHERE hour_start >= ${sinceExpr}
      ),
      meta_latest AS (
        SELECT server_name, nick, imei, operator,
               ROW_NUMBER() OVER (PARTITION BY server_name, nick ORDER BY updated_at DESC) as rn
        FROM modem_meta
      )
      SELECT a.server_name, a.nick, COALESCE(m.imei, '') as imei, COALESCE(m.operator, '') as operator
      FROM active a
      LEFT JOIN meta_latest m
        ON m.server_name = a.server_name AND m.nick = a.nick AND m.rn = 1
      ORDER BY a.server_name, a.nick
    `).all();
    if (modems.length === 0) return res.json({ modems: [], summary: { total: 0 } });

    // Batch per-modem queries grouped to avoid N+1. One pass per metric.
    const checksRows = db.prepare(`
      SELECT server_name, nick,
             AVG(total_ms) FILTER (WHERE error IS NULL) as avg_latency,
             COUNT(*) as total_checks,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as err_checks
      FROM proxy_checks
      WHERE checked_at >= ${sinceExpr}
      GROUP BY server_name, nick
    `).all();
    const checksMap = {};
    for (const r of checksRows) checksMap[r.server_name + '|' + r.nick] = r;

    const rotRows = db.prepare(`
      SELECT server_name, nick,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY server_name, nick
    `).all();
    const rotMap = {};
    for (const r of rotRows) rotMap[r.server_name + '|' + r.nick] = r;

    // Traffic totals (for the traffic_gb display only — NOT for uptime).
    // Uptime is computed from polling data (uptimeTracking) so it reflects
    // "modem reachable" not "client sent traffic". See uptime computation below.
    const trafRows = db.prepare(`
      SELECT server_name, nick, SUM(bytes_in + bytes_out) as bytes
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
      GROUP BY server_name, nick
    `).all();
    const trafMap = {};
    for (const r of trafRows) trafMap[r.server_name + '|' + r.nick] = r;

    // Uptime — polling-based: 5-min ping checks against ProxySmart aggregated
    // into per-day buckets in uptimeTracking[server+'_'+imei].daily[YYYY-MM-DD].
    // online/total over the last N days = ratio. Reflects "modem available"
    // independent of client traffic activity. (Traffic-based active_hours was
    // misleading: a modem with no client traffic looked offline.)
    const utCutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    function pollingUptime(server, imei) {
      if (!imei) return null;
      const ut = uptimeTracking[server + '_' + imei];
      if (!ut || !ut.daily) return null;
      let online = 0, total = 0;
      for (const d in ut.daily) {
        if (d >= utCutoffDate) {
          online += ut.daily[d].online || 0;
          total  += ut.daily[d].total  || 0;
        }
      }
      if (total === 0) return null;
      return { online, total, ratio: online / total };
    }

    const out = modems.map(m => {
      const key = m.server_name + '|' + m.nick;
      const ch = checksMap[key] || {};
      const rot = rotMap[key] || {};
      const tr = trafMap[key] || {};
      const errPct = ch.total_checks > 0 ? (ch.err_checks / ch.total_checks) * 100 : null;
      const latency = ch.avg_latency != null ? Math.round(ch.avg_latency) : null;

      // Replaces the old traffic-based activeHours/expectedHours formula.
      const up = pollingUptime(m.server_name, m.imei);
      const uptimeRatio = up ? up.ratio : 0;
      const uptimePct   = up ? Math.round(uptimeRatio * 1000) / 10 : 0;
      const upOnline    = up ? up.online : 0;
      const upTotal     = up ? up.total  : 0;

      // Health score 0-100 — computed alongside a per-factor `breakdown` so
      // the UI can show *why* a modem scored low (used by the «Здоровье» tab
      // in the modem detail modal). Each breakdown entry records value+norm+
      // impact (points subtracted from the initial 100).
      let score = 100;
      const breakdown = [];

      // Thresholds for the health score. Calibrated to the actual modem fleet
      // (typical baseline: ~1.8s latency, ~12s rotation). Deliberately
      // decoupled from `proxy_check_bad_ms` — that setting controls the table
      // cell coloring and is tuned for a different purpose.
      const ERROR_NORMAL_PCT = 5;           // ≤ 5% is normal — no penalty
      const LAT_WARN_MS = 2000;             // ≤ 2000ms is normal
      const LAT_BAD_MS  = 4000;             // > 4000ms is severe
      const ROT_NORMAL_SEC = 15;            // ≤ 15s is normal
      const ROT_BAD_SEC    = 30;            // > 30s is severe

      // Factor 1: Error rate. Norm is 0-5% (real-world traffic always has some
      // noise from upstream / target sites). Penalty applies only above 5%:
      // (errPct - 5) × 2 points, capped at 50.
      const errCost = errPct != null && errPct > ERROR_NORMAL_PCT
        ? Math.min((errPct - ERROR_NORMAL_PCT) * 2, 50)
        : 0;
      score -= errCost;
      breakdown.push({
        factor: 'error_pct',
        label: 'Ошибки',
        value: errPct != null ? Math.round(errPct * 10) / 10 : null,
        unit: '%',
        norm: '≤ ' + ERROR_NORMAL_PCT + '%',
        warn_at: '> ' + ERROR_NORMAL_PCT + '%',
        bad_at: '≥ ' + errThreshold + '%',
        impact: -Math.round(errCost * 10) / 10,
        impact_explain: errPct == null ? 'нет данных'
          : errPct <= ERROR_NORMAL_PCT ? 'в норме (до 5%), штрафа нет'
          : `−${Math.round(errCost*10)/10} баллов ((${Math.round(errPct*10)/10}% − ${ERROR_NORMAL_PCT}%) × 2, max −50)`,
        status: errPct == null ? 'unknown'
          : errPct >= errThreshold ? 'bad'
          : errPct > ERROR_NORMAL_PCT ? 'warn'
          : 'good',
      });

      // Factor 2: Latency — stepped multiplier so there's no harsh cliff.
      // ≤ warn (1500ms): no penalty. warn-bad (1500-3000ms): ×0.9 (−10%).
      // > bad (3000ms): ×0.75 (−25%).
      const beforeLatency = score;
      let latencyMult = 1, latencyTier = 'good';
      if (latency != null) {
        if (latency > LAT_BAD_MS)       { latencyMult = 0.75; latencyTier = 'bad';  }
        else if (latency > LAT_WARN_MS) { latencyMult = 0.9;  latencyTier = 'warn'; }
      } else {
        latencyTier = 'unknown';
      }
      score *= latencyMult;
      const latencyCost = beforeLatency - score;
      breakdown.push({
        factor: 'latency_ms',
        label: 'Задержка',
        value: latency,
        unit: 'мс',
        norm: '≤ ' + LAT_WARN_MS + ' мс',
        warn_at: '> ' + LAT_WARN_MS + ' мс',
        bad_at: '> ' + LAT_BAD_MS + ' мс',
        impact: -Math.round(latencyCost * 10) / 10,
        impact_explain: latency == null ? 'нет данных'
          : latencyMult === 1 ? 'в норме, штрафа нет'
          : `× ${latencyMult} (${latencyTier === 'bad' ? '−25%' : '−10%'}) → −${Math.round(latencyCost*10)/10} баллов`,
        status: latencyTier,
      });

      // Factor 3: Rotation duration — new. If IP rotation takes too long the
      // proxy effectively pauses. ≤5s normal, 5-15s ×0.95, >15s ×0.85.
      const beforeRot = score;
      const rotAvg = rot.avg_sec != null ? rot.avg_sec : null;
      let rotMult = 1, rotTier = 'good';
      if (rotAvg != null) {
        if (rotAvg > ROT_BAD_SEC)         { rotMult = 0.85; rotTier = 'bad';  }
        else if (rotAvg > ROT_NORMAL_SEC) { rotMult = 0.95; rotTier = 'warn'; }
      } else if (rot.total === 0) {
        rotTier = 'unknown';
      }
      score *= rotMult;
      const rotCost = beforeRot - score;
      breakdown.push({
        factor: 'rotation_avg_sec',
        label: 'Длительность ротации',
        value: rotAvg != null ? Math.round(rotAvg * 10) / 10 : null,
        unit: 'с',
        norm: '≤ ' + ROT_NORMAL_SEC + ' с',
        warn_at: '> ' + ROT_NORMAL_SEC + ' с',
        bad_at: '> ' + ROT_BAD_SEC + ' с',
        impact: -Math.round(rotCost * 10) / 10,
        impact_explain: rotAvg == null ? (rot.total === 0 ? 'нет ротаций за период' : 'нет данных')
          : rotMult === 1 ? 'в норме, штрафа нет'
          : `× ${rotMult} (${rotTier === 'bad' ? '−15%' : '−5%'}) → −${Math.round(rotCost*10)/10} баллов`,
        status: rotTier,
      });

      // Factor 4: Uptime — polling-based. Multiplies score by ratio of
      // successful pings to total pings over the period.
      const beforeUptime = score;
      if (up) score *= uptimeRatio;
      const uptimeCost = beforeUptime - score;
      breakdown.push({
        factor: 'uptime_pct',
        label: 'Аптайм',
        value: uptimePct,
        unit: '%',
        norm: '100%',
        warn_at: '< 99%',
        bad_at: '< 95%',
        impact: -Math.round(uptimeCost * 10) / 10,
        impact_explain: !up ? 'нет данных пингов'
          : uptimeRatio >= 1 ? 'в норме, штрафа нет'
          : `× ${Math.round(uptimeRatio*100)/100} (${upOnline} из ${upTotal} проверок онлайн, каждые 5 мин) → −${Math.round(uptimeCost*10)/10} баллов`,
        status: !up ? 'unknown' : uptimePct >= 99 ? 'good' : uptimePct >= 95 ? 'warn' : 'bad',
      });

      // Informational only (do NOT affect score, but useful in the detail view).
      const rotFailedPct = rot.total > 0 ? (rot.failed / rot.total) * 100 : 0;
      breakdown.push({
        factor: 'rotations_failed_pct',
        label: 'Неуспешные ротации',
        value: Math.round(rotFailedPct * 10) / 10,
        unit: '%',
        norm: '< 5%',
        warn_at: '> 5%',
        bad_at: '> 15%',
        impact: 0,
        impact_explain: rot.total === 0 ? 'нет ротаций за период' : 'информационно, на скор не влияет',
        status: rot.total === 0 ? 'unknown' : rotFailedPct >= 15 ? 'bad' : rotFailedPct >= 5 ? 'warn' : 'good',
      });
      breakdown.push({
        factor: 'total_checks',
        label: 'Всего проверок',
        value: ch.total_checks || 0,
        unit: '',
        norm: '> 100 / день',
        warn_at: '< 50 / день',
        bad_at: '< 10 / день',
        impact: 0,
        impact_explain: 'информационно, контекст для других метрик',
        status: 'unknown',
      });

      score = Math.max(0, Math.min(100, Math.round(score)));

      return {
        nick: m.nick,
        server_name: m.server_name,
        operator: m.operator || '',
        latency_ms: latency,
        error_pct: errPct != null ? Math.round(errPct * 10) / 10 : null,
        total_checks: ch.total_checks || 0,
        rotations: rot.total || 0,
        rotations_failed_pct: Math.round(rotFailedPct * 10) / 10,
        avg_rotation_sec: rot.avg_sec != null ? Math.round(rot.avg_sec * 10) / 10 : null,
        traffic_gb: tr.bytes ? Math.round(tr.bytes / 1e9 * 100) / 100 : 0,
        uptime_online_checks: upOnline,
        uptime_total_checks: upTotal,
        uptime_pct: uptimePct,
        health_score: score,
        status: score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad',
        breakdown,
      };
    });

    const summary = {
      total: out.length,
      good: out.filter(x => x.status === 'good').length,
      warn: out.filter(x => x.status === 'warn').length,
      bad: out.filter(x => x.status === 'bad').length,
      err_threshold_pct: errThreshold
    };
    res.json({ modems: out, summary, days });
  } catch (e) {
    logger.error('[modem_health]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/rotations', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const sinceExpr = `datetime('now', '-${days} days')`;

    const totals = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec,
             MAX(took_sec) as max_sec,
             MIN(took_sec) as min_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
    `).get();

    const perDay = db.prepare(`
      SELECT substr(started_at, 1, 10) as date,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY date
      ORDER BY date
    `).all();

    const perModem = db.prepare(`
      SELECT r.server_name, r.nick, m.operator,
             COUNT(*) as total,
             SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
             AVG(r.took_sec) as avg_sec,
             MAX(r.took_sec) as max_sec
      FROM rotation_log r
      LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
      WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL
      GROUP BY r.server_name, r.nick
      ORDER BY total DESC
      LIMIT 200
    `).all();

    const perOperator = db.prepare(`
      SELECT COALESCE(m.operator, 'unknown') as operator,
             COUNT(*) as total,
             SUM(CASE WHEN r.old_ip = r.new_ip THEN 1 ELSE 0 END) as failed,
             AVG(r.took_sec) as avg_sec
      FROM rotation_log r
      LEFT JOIN modem_meta m ON m.nick = r.nick AND m.server_name = r.server_name
      WHERE r.started_at >= ${sinceExpr} AND r.ended_at IS NOT NULL
      GROUP BY operator
      ORDER BY total DESC
    `).all();

    const perServer = db.prepare(`
      SELECT server_name,
             COUNT(*) as total,
             SUM(CASE WHEN old_ip = new_ip THEN 1 ELSE 0 END) as failed,
             AVG(took_sec) as avg_sec,
             MAX(took_sec) as max_sec
      FROM rotation_log
      WHERE started_at >= ${sinceExpr} AND ended_at IS NOT NULL
      GROUP BY server_name
      ORDER BY total DESC
    `).all();

    const recentFailed = db.prepare(`
      SELECT server_name, nick, old_ip, new_ip, started_at, took_sec
      FROM rotation_log
      WHERE old_ip IS NOT NULL AND new_ip IS NOT NULL AND old_ip = new_ip
        AND started_at >= ${sinceExpr}
      ORDER BY started_at DESC
      LIMIT 50
    `).all();

    const success = totals.total > 0 ? ((totals.total - totals.failed) / totals.total) * 100 : 0;
    res.json({
      days,
      summary: {
        total: totals.total || 0,
        failed: totals.failed || 0,
        success_pct: Math.round(success * 10) / 10,
        avg_sec: totals.avg_sec != null ? Math.round(totals.avg_sec * 10) / 10 : null,
        max_sec: totals.max_sec != null ? Math.round(totals.max_sec * 10) / 10 : null,
        min_sec: totals.min_sec != null ? Math.round(totals.min_sec * 10) / 10 : null,
      },
      per_day: perDay,
      per_server: perServer,
      per_modem: perModem,
      per_operator: perOperator,
      recent_failed: recentFailed
    });
  } catch (e) {
    logger.error('[rotations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/ip_stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const sinceExpr = `datetime('now', '-${days} days')`;

    const uniqueIps = db.prepare(`
      SELECT COUNT(DISTINCT ip) as c FROM ip_history
      WHERE started_at >= ${sinceExpr}
    `).get().c;

    const totalAssignments = db.prepare(`
      SELECT COUNT(*) as c FROM ip_history WHERE started_at >= ${sinceExpr}
    `).get().c;

    // Reused IPs: more than 1 distinct key uses it
    const reused = db.prepare(`
      SELECT ip, COUNT(*) as uses, COUNT(DISTINCT key) as modems,
             MIN(started_at) as first, MAX(started_at) as last
      FROM ip_history
      WHERE started_at >= ${sinceExpr}
      GROUP BY ip
      HAVING modems > 1
      ORDER BY uses DESC
      LIMIT 100
    `).all();

    // Average lifetime: only rows with ended_at
    const lifetimeAll = db.prepare(`
      SELECT AVG((julianday(ended_at) - julianday(started_at)) * 86400) as avg_sec
      FROM ip_history
      WHERE ended_at IS NOT NULL AND started_at >= ${sinceExpr}
    `).get().avg_sec;

    // Pool size per server (distinct IPs per server prefix in key, e.g. "S1_port123")
    const poolsRows = db.prepare(`
      SELECT substr(key, 1, instr(key, '_') - 1) as server,
             COUNT(DISTINCT ip) as ip_count,
             COUNT(*) as total_assignments,
             AVG(CASE WHEN ended_at IS NOT NULL THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) as avg_lifetime_sec
      FROM ip_history
      WHERE started_at >= ${sinceExpr} AND instr(key, '_') > 0
      GROUP BY server
      ORDER BY ip_count DESC
    `).all();

    res.json({
      days,
      summary: {
        unique_ips: uniqueIps,
        total_assignments: totalAssignments,
        reuse_ratio: uniqueIps > 0 ? Math.round(totalAssignments / uniqueIps * 100) / 100 : 0,
        avg_lifetime_sec: lifetimeAll != null ? Math.round(lifetimeAll) : null,
        reused_count: reused.length
      },
      reused,
      pools: poolsRows
    });
  } catch (e) {
    logger.error('[ip_stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/traffic_forecast', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 60);
    const sinceExpr = `datetime('now', '-${days} days')`;
    const mskToday = getMoscowToday();
    const mskNow = getMoscowNow();
    const daysInMonth = new Date(mskNow.getFullYear(), mskNow.getMonth() + 1, 0).getDate();
    const dayOfMonth = mskNow.getDate();
    const daysLeftInMonth = daysInMonth - dayOfMonth;

    // Per-client per-day gb totals from daily_traffic
    const rows = db.prepare(`
      SELECT port_name, date, SUM(bytes_in + bytes_out) as bytes
      FROM daily_traffic
      WHERE date >= substr(${sinceExpr}, 1, 10)
      GROUP BY port_name, date
    `).all();

    // Build client → port_names
    const portToClient = {};
    for (const c of clients) if (c.portName) portToClient[c.portName] = c;
    const portIdToClient = {}; // Fallback: port_id like "S1_portXXX" → client via modem_meta

    // Per-client aggregation
    const perClient = {};
    for (const r of rows) {
      // port_name in daily_traffic is the full port_id (S1_portXXX), not client portName.
      // Match via live portKey mapping.
      const pnCandidate = portKeyToPortName[r.port_name] || r.port_name;
      const client = portToClient[pnCandidate];
      if (!client) continue;
      if (!perClient[client.id]) perClient[client.id] = { id: client.id, name: client.name, portName: client.portName, price: client.price || 0, currency: client.currency || 'RUB', balance: client.balance || 0, billingType: client.billingType || 'per_gb', days: {} };
      if (!perClient[client.id].days[r.date]) perClient[client.id].days[r.date] = 0;
      perClient[client.id].days[r.date] += r.bytes || 0;
    }

    const forecasts = Object.values(perClient).map(c => {
      const arr = Object.entries(c.days).sort((a, b) => a[0].localeCompare(b[0]));
      const xs = arr.map((_, i) => i);
      const ys = arr.map(a => a[1] / 1e9); // GB
      const n = xs.length;
      let slope = 0, mean = 0;
      if (n >= 2) {
        const sumX = xs.reduce((s, v) => s + v, 0);
        const sumY = ys.reduce((s, v) => s + v, 0);
        const sumXY = xs.reduce((s, v, i) => s + v * ys[i], 0);
        const sumX2 = xs.reduce((s, v) => s + v * v, 0);
        const meanX = sumX / n, meanY = sumY / n;
        const denom = sumX2 - n * meanX * meanX;
        slope = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 0;
        mean = meanY;
      } else if (n === 1) {
        mean = ys[0];
      }

      const avgDailyGb = mean;
      // Forecast end of month: current month accumulated so far + avgDaily * days_left
      const thisMonthRows = arr.filter(a => a[0].startsWith(mskToday.slice(0, 7)));
      const monthGbSoFar = thisMonthRows.reduce((s, a) => s + a[1] / 1e9, 0);
      const forecastMonthGb = monthGbSoFar + avgDailyGb * daysLeftInMonth;

      // Runway: how many days current balance lasts at current rate
      let runwayDays = null;
      if (c.billingType === 'per_gb' && c.price > 0 && avgDailyGb > 0) {
        runwayDays = Math.max(0, Math.floor(c.balance / (avgDailyGb * c.price)));
      } else if (c.billingType === 'per_modem' && c.price > 0) {
        // rough approx — divide balance by (price per modem / days in month) × modem count
        runwayDays = Math.floor(c.balance / (c.price / daysInMonth));
      }

      return {
        client_id: c.id,
        client_name: c.name,
        avg_daily_gb: Math.round(avgDailyGb * 100) / 100,
        trend_gb_per_day: Math.round(slope * 100) / 100,
        month_gb_so_far: Math.round(monthGbSoFar * 10) / 10,
        forecast_month_gb: Math.round(forecastMonthGb * 10) / 10,
        balance: c.balance,
        currency: c.currency,
        runway_days: runwayDays,
        low_balance_alert: runwayDays !== null && runwayDays <= 7
      };
    }).sort((a, b) => (a.runway_days || 9999) - (b.runway_days || 9999));

    res.json({
      days,
      mskToday,
      days_left_in_month: daysLeftInMonth,
      forecasts
    });
  } catch (e) {
    logger.error('[traffic_forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

r.get('/api/analytics/capacity', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 180);
    const sinceExpr = `datetime('now', '-${days} days')`;

    // Per-server utilization
    const servers = db.prepare(`
      SELECT server_name,
             COUNT(DISTINCT nick) as modem_count,
             SUM(bytes_in + bytes_out) as total_bytes,
             AVG(bytes_in + bytes_out) as avg_hour_bytes,
             MAX(bytes_in + bytes_out) as max_hour_bytes,
             COUNT(DISTINCT substr(hour_start, 1, 10)) as active_days
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
      GROUP BY server_name
      ORDER BY total_bytes DESC
    `).all();

    // Modem count growth by month
    const modemGrowth = db.prepare(`
      SELECT substr(updated_at, 1, 7) as month,
             COUNT(DISTINCT imei) as modems
      FROM modem_meta
      GROUP BY month
      ORDER BY month
    `).all();

    // Overall totals
    const totals = db.prepare(`
      SELECT SUM(bytes_in + bytes_out) as total_bytes,
             COUNT(DISTINCT nick) as total_modems,
             COUNT(DISTINCT server_name) as total_servers
      FROM traffic_hourly
      WHERE hour_start >= ${sinceExpr}
    `).get();

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

r.get('/api/analytics/logs_domains_full', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { host = '', client = '', operator = '', server = '', nick = '' } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 2000, 1), 20000);
    const minCount = Math.max(parseInt(req.query.min_count) || 1, 1);

    const where = ['count >= ?'];
    const params = [minCount];
    if (host)     { where.push('LOWER(host) LIKE ?');   params.push('%' + String(host).toLowerCase() + '%'); }
    if (client)   { where.push('client_name = ?');      params.push(client); }
    if (operator) { where.push('operator = ?');         params.push(operator); }
    if (server)   { where.push('server_name = ?');      params.push(server); }
    if (nick)     { where.push('nick = ?');             params.push(nick); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Snapshot meta
    const snap = db.prepare('SELECT MIN(snapshot_at) as ts, COUNT(*) as total_rows FROM top_hosts_detail').get();

    // Filtered raw rows (capped)
    const rows = db.prepare(`
      SELECT server_name, port_id, nick, client_name, operator, country, host, count
      FROM top_hosts_detail
      ${whereSql}
      ORDER BY count DESC
      LIMIT ${limit}
    `).all(...params);

    // Summary of the filtered set
    const totals = db.prepare(`
      SELECT COUNT(*) as rows,
             SUM(count) as hits,
             COUNT(DISTINCT host) as unique_hosts,
             COUNT(DISTINCT client_name) as clients,
             COUNT(DISTINCT operator) as operators,
             COUNT(DISTINCT server_name) as servers,
             COUNT(DISTINCT nick) as modems
      FROM top_hosts_detail
      ${whereSql}
    `).get(...params);

    // Each aggregation runs independently — no O(rows²) client-side work needed
    const agg = sql => db.prepare(sql).all(...params);
    const topHosts = agg(`
      SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as modems, COUNT(DISTINCT client_name) as clients
      FROM top_hosts_detail ${whereSql}
      GROUP BY host ORDER BY hits DESC LIMIT 100`);
    const byClient = agg(`
      SELECT client_name, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY client_name ORDER BY hits DESC`);
    const byOperator = agg(`
      SELECT operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY operator ORDER BY hits DESC`);
    const byServer = agg(`
      SELECT server_name, country, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts, COUNT(DISTINCT nick) as modems
      FROM top_hosts_detail ${whereSql}
      GROUP BY server_name ORDER BY hits DESC`);
    const byModem = agg(`
      SELECT server_name, nick, operator, SUM(count) as hits, COUNT(DISTINCT host) as unique_hosts
      FROM top_hosts_detail ${whereSql}
      GROUP BY server_name, nick ORDER BY hits DESC LIMIT 100`);

    // TLD / IP split — computed in JS because SQLite lacks rinstr/reverse.
    const tldRows = db.prepare(`
      SELECT host, SUM(count) as hits, COUNT(DISTINCT nick) as mods
      FROM top_hosts_detail ${whereSql}
      GROUP BY host
    `).all(...params);
    const tldMap = {};
    const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;
    for (const r of tldRows) {
      let tld;
      if (IP_RE.test(r.host)) tld = '(IP)';
      else {
        const dot = r.host.lastIndexOf('.');
        tld = dot === -1 ? '(none)' : r.host.slice(dot + 1).toLowerCase();
      }
      if (!tldMap[tld]) tldMap[tld] = { tld, hits: 0, unique_hosts: 0 };
      tldMap[tld].hits += r.hits;
      tldMap[tld].unique_hosts += 1;
    }
    const byTld = Object.values(tldMap).sort((a, b) => b.hits - a.hits).slice(0, 50);

    // Facet lists (unfiltered — for populating filter dropdowns)
    const facetClients = db.prepare('SELECT DISTINCT client_name FROM top_hosts_detail WHERE client_name != \'\' ORDER BY client_name').all().map(r => r.client_name);
    const facetOperators = db.prepare('SELECT DISTINCT operator FROM top_hosts_detail WHERE operator != \'\' ORDER BY operator').all().map(r => r.operator);
    const facetServers = db.prepare('SELECT DISTINCT server_name FROM top_hosts_detail ORDER BY server_name').all().map(r => r.server_name);

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
      facets: { clients: facetClients, operators: facetOperators, servers: facetServers }
    });
  } catch (e) {
    logger.error('[logs_domains_full]', e.message);
    res.status(500).json({ error: e.message });
  }
});

  return r;
};
