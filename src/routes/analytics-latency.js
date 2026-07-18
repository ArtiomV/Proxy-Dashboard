'use strict';
//
// src/routes/analytics-latency.js — proxy latency endpoints (WP6.1 carve-out
// from analytics.js): latency_stats + latency_day.
// Query strings come from src/db/analytics.js; the view/stale/unbound filter
// fragment is shared through analyticsDb.proxyChecksFilter.

const express = require('express');
const analyticsDb = require('../db/analytics');
const { tzModifier } = require('../utils/time');

module.exports = function createAnalyticsLatencyRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    appSettings,
    apiServers,
    SERVER_COUNTRIES,
    getStaleNicks, getUnboundNicks,
    getTzOffset,
  } = deps;
  const r = express.Router();

  function _serversForCountry(idKey) {
    const serverCountryMap = {};
    for (const s of apiServers) {
      const cn = ((SERVER_COUNTRIES[s.name] || {}).name || '').toLowerCase();
      if (cn) serverCountryMap[s.name] = cn;
    }
    const servers = [];
    for (const [srv, cn] of Object.entries(serverCountryMap)) {
      if (cn.includes(idKey) || idKey.includes(cn)) servers.push(srv);
    }
    return servers;
  }

  // Percentile helper — input must already be sorted ascending.
  function pctile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
    return sorted[Math.max(0, idx)];
  }

  r.get('/api/analytics/latency_stats', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const { view = 'country', id = 'all' } = req.query;
      const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
      const idKey = id.toLowerCase().replace(/[\s.]+/g, '_');

      const mskOffset = getTzOffset('Europe/Moscow');
      const tzStr = tzModifier(mskOffset);
      const now2 = new Date();
      const since = new Date(now2.getTime() - days * 86400000).toISOString();
      const priorSince = new Date(now2.getTime() - days * 2 * 86400000).toISOString();
      const priorUntil = since;

      // Stage 18.7 + 18.16: exclude stale (>12h offline) and currently-unbound
      // modems from the stats — they must not skew percentiles.
      const staleNicks = (typeof getStaleNicks === 'function') ? getStaleNicks(12) : new Set();
      const unboundNicks = (typeof getUnboundNicks === 'function') ? getUnboundNicks() : new Set();
      const { clause: filter, params: filterParams } = analyticsDb.proxyChecksFilter({
        view, idKey, id,
        servers: view === 'country' && idKey !== 'all' ? _serversForCountry(idKey) : [],
        staleNicks, unboundNicks,
      });

      const rows = analyticsDb.latencyDayVals(tzStr, filter, since, filterParams);
      const errRows = analyticsDb.latencyErrByDay(tzStr, filter, since, filterParams);
      const totalRows = analyticsDb.latencyTotalByDay(tzStr, filter, since, filterParams);

      const byDay = {};
      const byDayConnect = {};
      const allVals = [];
      const allConnectVals = [];
      for (const row of rows) {
        if (!byDay[row.day]) byDay[row.day] = [];
        byDay[row.day].push(row.total_ms);
        allVals.push(row.total_ms);
        if (row.connect_ms != null) {
          if (!byDayConnect[row.day]) byDayConnect[row.day] = [];
          byDayConnect[row.day].push(row.connect_ms);
          allConnectVals.push(row.connect_ms);
        }
      }
      const errMap = {};
      let totalErrs = 0;
      for (const row of errRows) { errMap[row.day] = row.cnt; totalErrs += row.cnt; }
      const totalMap = {};
      let totalChecks = 0;
      for (const row of totalRows) { totalMap[row.day] = row.cnt; totalChecks += row.cnt; }

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
        connect_p95_ms: [],
        error_pct: [], error_count: [], total_checks: []
      };
      for (const day of dateList) {
        const vals = byDay[day] || [];
        const cvals = byDayConnect[day] || [];
        const total = totalMap[day] || 0;
        const errs = errMap[day] || 0;
        if (vals.length === 0) {
          result.median_ms.push(null);
          result.avg_ms.push(null);
          result.p75_ms.push(null);
          result.p95_ms.push(null);
          result.p99_ms.push(null);
        } else {
          result.median_ms.push(pctile(vals, 0.5));
          result.p75_ms.push(pctile(vals, 0.75));
          result.p95_ms.push(pctile(vals, 0.95));
          result.p99_ms.push(pctile(vals, 0.99));
          result.avg_ms.push(Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
        }
        if (cvals.length === 0) {
          result.connect_p95_ms.push(null);
        } else {
          const cSorted = cvals.slice().sort((a, b) => a - b);
          result.connect_p95_ms.push(pctile(cSorted, 0.95));
        }
        result.error_pct.push(total > 0 ? Math.round(errs / total * 100) : null);
        result.error_count.push(errs);
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
        connect_p50: pctile(connectSorted, 0.5),
        connect_p75: pctile(connectSorted, 0.75),
        connect_p95: pctile(connectSorted, 0.95),
        connect_p99: pctile(connectSorted, 0.99),
      };

      // Distribution buckets — configured warn/bad thresholds.
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

      // Prior period (equal-length window immediately before `since`)
      const priorRows = analyticsDb.latencyPriorVals(filter, priorSince, priorUntil, filterParams);
      const priorTotal = analyticsDb.latencyPriorTotal(filter, priorSince, priorUntil, filterParams).cnt || 0;
      const priorErrs = analyticsDb.latencyPriorErr(filter, priorSince, priorUntil, filterParams).cnt || 0;
      const priorSorted = priorRows.map(row => row.total_ms).sort((a, b) => a - b);
      const priorConnectSorted = priorRows.map(row => row.connect_ms).filter(v => v != null).sort((a, b) => a - b);
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

      // Stage 18.16 — exclude currently-unbound modems (same as latency_stats).
      const unboundNicks = (typeof getUnboundNicks === 'function') ? getUnboundNicks() : new Set();
      const { clause: filterNoTime, params: filterOnlyParams } = analyticsDb.proxyChecksFilter({
        view, idKey, id,
        servers: view === 'country' && idKey !== 'all' ? _serversForCountry(idKey) : [],
        unboundNicks,
      });
      const rows = analyticsDb.latencyDayRows(filterNoTime, [utcFrom, utcTo, ...filterOnlyParams]);

      // Build points with MSK time
      const points = [];
      let okCount = 0, errCount = 0, totalMsArr = [];
      for (const row of rows) {
        const utcMs = new Date(row.checked_at).getTime();
        const mskMs = utcMs + mskOffset * 3600 * 1000;
        const mskD = new Date(mskMs);
        const h = mskD.getUTCHours();
        const m = mskD.getUTCMinutes();
        const minutes = h * 60 + m;
        const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

        points.push({
          t: timeStr,
          min: minutes,
          nick: row.nick,
          op: row.operator || '',
          client: row.client_name || '',
          connect: row.connect_ms,
          total: row.total_ms,
          status: row.status_code,
          error: row.error || null
        });

        if (row.error) {
          errCount++;
        } else {
          okCount++;
          if (row.total_ms != null) totalMsArr.push(row.total_ms);
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

  return r;
};
