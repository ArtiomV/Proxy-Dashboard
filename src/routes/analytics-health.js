'use strict';
//
// src/routes/analytics-health.js — modem health endpoints (WP6.1 carve-out
// from analytics.js): modem_health + modem_health_history.
// All SQL lives in src/db/analytics.js — this file only shapes the response.

const express = require('express');
const analyticsDb = require('../db/analytics');

module.exports = function createAnalyticsHealthRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    appSettings,
    getStaleNicks, getUnboundNicks,
    uptimeTracking,
  } = deps;
  const r = express.Router();

  r.get('/api/analytics/modem_health', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
      const errThreshold = Number(appSettings.error_rate_threshold) || 15;

      // Base set: modems active in the period (proxy_checks OR traffic_hourly),
      // deduped to the latest modem_meta row per (server, nick).
      const modems = analyticsDb.healthActive(-days);
      // Stage 18.8/18.14: stale modems are tagged `stale: true` and excluded
      // from summary KPIs only — the table still shows them.
      const staleNicks = (typeof getStaleNicks === 'function') ? getStaleNicks() : new Set();
      // Stage 18.16: currently-unbound modems are dropped entirely.
      const unboundNicks = (typeof getUnboundNicks === 'function') ? getUnboundNicks() : new Set();
      if (unboundNicks.size > 0) {
        const before = modems.length;
        for (let i = modems.length - 1; i >= 0; i--) {
          if (unboundNicks.has(modems[i].nick)) modems.splice(i, 1);
        }
        if (modems.length !== before) logger.debug(`[modem_health] dropped ${before - modems.length} unbound modems`);
      }
      if (modems.length === 0) return res.json({ modems: [], summary: { total: 0 } });

      const checksRows = analyticsDb.healthChecks(-days);
      const checksMap = {};
      for (const row of checksRows) checksMap[row.server_name + '|' + row.nick] = row;

      const rotRows = analyticsDb.healthRotations(-days);
      const rotMap = {};
      for (const row of rotRows) rotMap[row.server_name + '|' + row.nick] = row;

      // Traffic totals (display only — uptime is polling-based, see below).
      const trafRows = analyticsDb.healthTraffic(-days);
      const trafMap = {};
      for (const row of trafRows) trafMap[row.server_name + '|' + row.nick] = row;

      // Uptime — polling-based: 5-min checks aggregated in uptimeTracking.
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

        const up = pollingUptime(m.server_name, m.imei);
        const uptimeRatio = up ? up.ratio : 0;
        const uptimePct   = up ? Math.round(uptimeRatio * 1000) / 10 : 0;
        const upOnline    = up ? up.online : 0;
        const upTotal     = up ? up.total  : 0;

        // Health score 0-100 with per-factor breakdown (see «Здоровье» tab).
        let score = 100;
        const breakdown = [];

        const ERROR_NORMAL_PCT = 5;
        const LAT_WARN_MS = 2000;
        const LAT_BAD_MS  = 4000;
        const ROT_NORMAL_SEC = 15;
        const ROT_BAD_SEC    = 30;

        // Factor 1: Error rate — penalty only above 5%, ×2, capped at −50.
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

        // Factor 2: Latency — ≤warn no penalty; warn-bad ×0.9; >bad ×0.75.
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

        // Factor 3: Rotation duration — ≤normal no penalty; above ×0.95/×0.85.
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

        // Factor 4: Uptime — multiplies by the polling online/total ratio.
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

        // Factor 5: Device/SIM health — latest ProxySmart signals.
        const REBOOT_BAD = 70;
        const _simRaw = String(m.sim_status || '').toUpperCase();
        const _simBad = !!_simRaw && _simRaw !== 'UNKNOWN' && !/\bOK\b|READY/.test(_simRaw);
        const _rebootHigh = m.reboot_score != null && Number(m.reboot_score) >= REBOOT_BAD;
        const beforeDev = score;
        let devMult = 1, devTier = 'good';
        if (_simBad)     { devMult *= 0.7; devTier = 'bad'; }
        if (_rebootHigh) { devMult *= 0.9; if (devTier !== 'bad') devTier = 'warn'; }
        score *= devMult;
        const devCost = beforeDev - score;
        const _devParts = [];
        if (_simBad)     _devParts.push('SIM «' + _simRaw + '» (×0.7)');
        if (_rebootHigh) _devParts.push('reboot ' + m.reboot_score + ' (×0.9)');
        breakdown.push({
          factor: 'device_health',
          label: 'SIM / ребут',
          value: _simBad ? _simRaw : (_rebootHigh ? 'reboot ' + m.reboot_score : (_simRaw || '—')),
          unit: '',
          norm: 'SIM OK, reboot < ' + REBOOT_BAD,
          warn_at: 'reboot ≥ ' + REBOOT_BAD,
          bad_at: 'SIM не OK',
          impact: -Math.round(devCost * 10) / 10,
          impact_explain: (!_simBad && !_rebootHigh) ? 'в норме, штрафа нет'
            : _devParts.join(' + ') + ` → −${Math.round(devCost * 10) / 10} баллов`,
          status: devTier,
        });

        // Informational only (no score impact).
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
          // Stage 18.14: flag, not exclusion. Summary KPIs below ignore it.
          stale: staleNicks.has(m.nick),
          breakdown,
        };
      });

      // Summary KPIs exclude stale rows (long-dead can't drag counters down).
      const active = out.filter(x => !x.stale);
      const summary = {
        total: active.length,
        good: active.filter(x => x.status === 'good').length,
        warn: active.filter(x => x.status === 'warn').length,
        bad: active.filter(x => x.status === 'bad').length,
        excluded_stale: out.length - active.length,
        err_threshold_pct: errThreshold
      };
      res.json({ modems: out, summary, days });
    } catch (e) {
      logger.error('[modem_health]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 17: per-modem daily health timeline (modem_health_daily table,
  // populated by src/jobs/health-snapshot.js; missing days come as score=null).
  r.get('/api/analytics/modem_health_history', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const server = String(req.query.server || '').trim();
      const imei   = String(req.query.imei   || '').trim();
      const days   = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 60);
      if (!server || !imei) return res.status(400).json({ error: 'server and imei required' });
      const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const healthDb = require('../db/health');
      const rows = healthDb.historyByModem(server, imei, sinceDate);
      res.json({ server, imei, days, rows });
    } catch (e) {
      logger.error('[modem_health_history]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
