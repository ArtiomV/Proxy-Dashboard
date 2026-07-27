'use strict';
//
// src/jobs/hourly-agg-schedule.js — «resilient» планировщик почасовой
// агрегации трафика: попытки в :00, :01, :02, :03, :04 (5 тай) за час,
// который только что кончился; маркер последнего записанного часа в
// kv_store (рестарт не дублирует запись). Таймаут и флаг остановки живут
// здесь (gracefulShutdown зовёт stop()). Extracted from server.js
// (Stage 9, boot-хвост) — без изменения логики.

function create(deps) {
  const { kvGet, kvSet, logger, logActivity, trafficDb, aggregateHourlyTraffic } = deps;

  let _loopTimeout = null;
  let _stopped = false;
  let _lastRecordedHour = null;
  try { const r = kvGet.get('hourly_last_recorded'); if (r) _lastRecordedHour = r.value; } catch (_) { /* best-effort: error intentionally swallowed */ }

  function start() {
    // Find next :00 (top of the hour)
    const now = new Date();
    const next00 = new Date(now);
    next00.setMinutes(0, 0, 0);
    next00.setTime(next00.getTime() + 60 * 60 * 1000); // always next hour's :00
    const msUntil = next00 - now;
    logger.info(`[HourlyAgg] Resilient schedule: first attempt at ${next00.toISOString()} (in ${Math.round(msUntil / 60000)} min)`);

    _loopTimeout = setTimeout(function hourlyLoop() {
      if (_stopped) return;
      _loopTimeout = setTimeout(hourlyLoop, 60 * 60 * 1000);
      // At :00, aggregateHourlyTraffic() writes to prevH = now - 1h (the hour that just ended)
      const ATTEMPT_OFFSETS = [0, 60, 120, 180, 240]; // seconds after :00 → :00, :01, :02, :03, :04
      let attemptIdx = 0;

      // Target is always the hour that just ended — use UTC methods to avoid timezone/rounding issues
      const nowMs = Date.now();
      const currentHourMs = nowMs - (nowMs % 3600000); // round down to current hour start
      const targetHourStr = new Date(currentHourMs - 3600000).toISOString().slice(0, 13).replace('T', ' ') + ':00';

      // Skip if already recorded (e.g. after restart)
      if (_lastRecordedHour === targetHourStr) {
        logger.info(`[HourlyAgg] Hour ${targetHourStr} already recorded, skipping`);
        return;
      }

      function tryRecord() {
        // Mark inner block as async-fn whose errors propagate to the outer .catch
        // (was `.then(async () => {...})` whose internal throws produced
        // unhandledRejection instead of being caught).
        aggregateHourlyTraffic().then(() => {
          try {
            // Success = no exception, even if cnt=0 (all modems offline)
            _lastRecordedHour = targetHourStr;
            try { kvSet.run('hourly_last_recorded', targetHourStr); } catch (_) { /* best-effort: error intentionally swallowed */ }
            const check = trafficDb.hourlyExistsForHourStmt().get(targetHourStr);
            logger.info(`[HourlyAgg] SUCCESS on attempt ${attemptIdx + 1}/5 for ${targetHourStr} (${(check && check.cnt) || 0} rows)`);
            logActivity('traffic', 'info', 'hourly_agg', null, `Hourly traffic aggregated for ${targetHourStr}: ${(check && check.cnt) || 0} rows (attempt ${attemptIdx + 1})`, { hour: targetHourStr, rows: (check && check.cnt) || 0, attempt: attemptIdx + 1 });
          } catch (e) {
            logger.error(`[HourlyAgg] post-success bookkeeping failed: ${e.stack || e.message}`);
          }
        }).catch(e => {
          logger.error(`[HourlyAgg] Attempt ${attemptIdx + 1}/5 error: ${e.message}`);
          attemptIdx++;
          if (attemptIdx < ATTEMPT_OFFSETS.length) {
            const delay = (ATTEMPT_OFFSETS[attemptIdx] - ATTEMPT_OFFSETS[attemptIdx - 1]) * 1000;
            setTimeout(tryRecord, delay);
          } else {
            logger.warn(`[HourlyAgg] All 5 attempts failed for ${targetHourStr} — hour will be empty`);
            logActivity('traffic', 'error', 'hourly_agg_failed', null, `All 5 attempts failed for ${targetHourStr}`, { hour: targetHourStr });
          }
        });
      }

      tryRecord();
    }, msUntil);
  }

  function stop() {
    _stopped = true;
    if (_loopTimeout) clearTimeout(_loopTimeout);
  }

  return { start, stop };
}

module.exports = { create };
