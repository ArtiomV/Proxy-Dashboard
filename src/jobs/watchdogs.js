'use strict';
//
// src/jobs/watchdogs.js — сторожевые проверки ресурсов и кронов:
//  • hourlyHealthCheck — раз в час: heap vs V8 heap_size_limit (не heapTotal,
//    Stage 18.14), свободное место на разделе приложения, застрявшие кроны
//    (по последним записям в system_log с порогом 2× интервала);
//  • heapDiskWatchdog — раз в 5 мин: те же heap/disk с записью в system_log.
// Extracted from server.js (Stage 9, boot-хвост) — без изменения логики.

function create(deps) {
  const { db, logger, alerts, logActivity, fs } = deps;

  function hourlyHealthCheck() {
    try {
      // Memory check — compare heapUsed against V8's `heap_size_limit`
      // (the actual OOM ceiling, ~4 GB by default on x64), NOT `heapTotal`.
      // Stage 18.14: was using heapTotal which is just the *currently
      // allocated* chunk; V8 grows it on demand so heapUsed/heapTotal sits
      // near 100% during normal GC cycles. We were alerting at 36 MB / 38 MB
      // = 95% even though there were gigabytes of headroom. pm2 only kills
      // on `max_memory_restart` (rss-based), not on this ratio.
      const mu = process.memoryUsage();
      const v8stats = require('v8').getHeapStatistics();
      const usedMB = Math.round(mu.heapUsed / 1024 / 1024);
      const totalMB = Math.round(v8stats.heap_size_limit / 1024 / 1024);
      const pct = totalMB > 0 ? Math.round(usedMB / totalMB * 100) : 0;
      if (pct >= 90)      alerts.trigger('heap_high', { pct, usedMB, totalMB });
      else if (pct >= 85) alerts.trigger('heap_warn', { pct, usedMB, totalMB });

      // Disk check — statfs of the app's own partition (P1-6: was hardcoded to
      // /root/Proxy-Dashboard, which silently no-op'd the disk alert on any other
      // host/path; __dirname follows the app wherever it's deployed).
      try {
        const stat = fs.statfsSync(__dirname);
        const freeB  = stat.bavail * stat.bsize;
        const totalB = stat.blocks * stat.bsize;
        const freeGB = Math.round(freeB / 1e9 * 10) / 10;
        const freePct = totalB > 0 ? Math.round(freeB / totalB * 100) : 100;
        if (freePct < 10)      alerts.trigger('disk_low_critical', { freeGB, pct: freePct });
        else if (freePct < 20) alerts.trigger('disk_low_warn',     { freeGB, pct: freePct });
      } catch (e) { /* statfs may not work on some FS — best-effort */ }

      // Cron-health check — for crons we know the expected interval, did we
      // run within 2x? Tracking via system_log entries.
      const cronChecks = [
        { job: 'DailyBilling', action: 'billing_start', maxAgeH: 26 },
        { job: 'HourlyAgg',    action: 'tracking_complete', maxAgeH: 1 },  // tracking ~5min
        { job: 'TopHosts',     action: 'top_hosts_complete', maxAgeH: 26 },
      ];
      for (const ck of cronChecks) {
        try {
          const row = db.prepare("SELECT MAX(timestamp) AS last FROM system_log WHERE action = ?").get(ck.action);
          if (!row || !row.last) continue;
          const ageH = (Date.now() - Date.parse(row.last + 'Z')) / 3600000;
          if (ageH > ck.maxAgeH * 2) {
            alerts.trigger('cron_stuck', {
              job: ck.job, lastRunAgo: Math.round(ageH) + ' ч',
              intervalLabel: ck.maxAgeH + ' ч',
            });
          }
        } catch (_) { /* best-effort */ }
      }
    } catch (e) { logger.warn('[Alerts] hourly check: ' + e.message); }
  }

  function heapDiskWatchdog() {
    try {
      // Stage 18.14: see comment in the hourly heap check above — using
      // heapTotal as the denominator is wrong (it's the *current allocation*,
      // not the limit). Compare against V8 heap_size_limit instead.
      const mem = process.memoryUsage();
      const limit = require('v8').getHeapStatistics().heap_size_limit;
      const pct = limit > 0 ? Math.round((mem.heapUsed / limit) * 100) : 0;
      if (pct > 85) {
        logActivity('system', 'warn', 'heap_high', null, `Heap ${pct}% (${Math.round(mem.heapUsed/1e6)}MB / ${Math.round(limit/1e6)}MB)`, { pct, heapUsed: mem.heapUsed, heapLimit: limit });
      }
    } catch (_) { /* best-effort: error intentionally swallowed */ }
    try {
      // Disk free via statfs (Node 18.15+)
      const target = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
      if (fs.statfs) {
        fs.statfs(fs.existsSync(target) ? target : '/', (err, st) => {
          if (err) return;
          const freeBytes = st.bavail * st.bsize;
          const freeMb = Math.round(freeBytes / 1e6);
          if (freeMb < 500) {
            logActivity('system', 'critical', 'disk_low', null, `Free disk ${freeMb} MB on ${target}`, { freeMb });
          }
        });
      }
    } catch (_) { /* best-effort: error intentionally swallowed */ }
  }

  return { hourlyHealthCheck, heapDiskWatchdog };
}

module.exports = { create };
