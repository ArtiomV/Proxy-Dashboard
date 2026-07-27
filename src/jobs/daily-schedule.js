'use strict';
//
// src/jobs/daily-schedule.js — суточное расписание: scheduleRepeating
// (единый реестр src/jobs/scheduler.js, WP6.4) и динамический планировщик
// спидтестов (несколько времён в день). Extracted from server.js
// (Stage 9, boot-хвост) — без изменения логики.

function create(deps) {
  const { logger, scheduler, getAppSettings, getTzOffset, runNightlySpeedtests } = deps;

  // Таймеры наружу (gracefulShutdown в server.js чистит их по ссылке).
  const speedtestTimers = [];
  const cronTimers = [];   // Non-speedtest cron timers (billing, reconciliation, etc.)

  function scheduleRepeating(hour, minute, label, fn, isSpeedtest) {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const msUntil = next - now;
    logger.info(`[${label}] Next run at ${next.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);
    const entry = {};
    // WP6.4: every recurring job registers in the unified scheduler registry
    // (name/schedule/runs/last-error → /api/admin/health).
    const { safeFn, job } = scheduler.wrapJob(label,
      `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`, fn, logger);
    job.nextRunAt = next.toISOString();
    entry.timeout = setTimeout(() => {
      safeFn();
      entry.interval = setInterval(safeFn, 24 * 60 * 60 * 1000);
    }, msUntil);
    if (isSpeedtest) speedtestTimers.push(entry);
    else cronTimers.push(entry);
  }

  // Dynamic speedtest scheduler (supports multiple times per day)
  function rescheduleSpeedtests() {
    // Clear existing timers
    speedtestTimers.forEach(t => { if (t.timeout) clearTimeout(t.timeout); if (t.interval) clearInterval(t.interval); });
    speedtestTimers.length = 0;

    const times = getAppSettings().speedtest_times || ['02:00', '14:00'];
    const mskOff = getTzOffset('Europe/Moscow');
    for (const timeStr of times) {
      const parts = timeStr.split(':').map(Number);
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
      const utcHour = (parts[0] - mskOff + 24) % 24;
      scheduleRepeating(utcHour, parts[1], 'Speedtest-' + timeStr + ' MSK', runNightlySpeedtests, true);
    }
  }

  return { scheduleRepeating, rescheduleSpeedtests, speedtestTimers, cronTimers };
}

module.exports = { create };
