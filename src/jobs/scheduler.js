'use strict';
// Unified scheduler registry (WP6.4): every recurring job registers here
// with its schedule, run count, and last error — surfaced in
// /api/admin/health as `jobs`. wrapJob preserves the original safe-fn
// semantics (errors logged, never thrown) while adding bookkeeping.
//
// 2026-09-24 · DEEP-35 (FIX-SPEC §19.5): Promise-контракт и
// структурированный результат. safeFn теперь ВОЗВРАЩАЕТ Promise выполнения
// (можно await'ить в тестах и оркестрации), ведёт lastSuccessAt,
// running/lastDurationMs и lastResult ('completed'|'skipped'|'partial'|
// 'failed'). Раньше ошибки, поглощённые внутри job без результата, не
// отличались от успеха. Переход на async безопасен: safeFn по-прежнему не
// бросает (catch внутри), setInterval его Promise просто игнорирует.
const jobs = new Map();

// wrapJob(label, schedule, fn, logger) → { safeFn, job }
//   label    — job name (e.g. 'DbBackup')
//   schedule — human label (e.g. '02:00 UTC' or 'every 5 min')
//   fn       — the job body; may return a promise; may return
//              { status: 'completed'|'skipped'|'partial'|'failed', error? }
function wrapJob(label, schedule, fn, logger) {
  const job = jobs.get(label) || {
    name: label, schedule,
    runs: 0, errors: 0,
    lastRunAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, nextRunAt: null,
    running: false, lastDurationMs: null, lastResult: null,
  };
  jobs.set(label, job);
  const safeFn = async () => {
    job.lastRunAt = new Date().toISOString();
    job.runs++;
    job.running = true;
    const started = Date.now();
    try {
      const r = await fn();
      job.lastDurationMs = Date.now() - started;
      const status = (r && typeof r === 'object' && typeof r.status === 'string') ? r.status : 'completed';
      job.lastResult = status;
      if (status === 'failed') {
        // Явный structured-failed БЕЗ throw — раньше был неотличим от успеха.
        job.errors++;
        job.lastError = String((r && r.error) || 'job reported failed');
        job.lastErrorAt = new Date().toISOString();
        logger.error(`[${label}] Reported failed:`, job.lastError);
      } else {
        // partial — результат с оговорками: успех, но отдельно виден в health.
        job.lastSuccessAt = new Date().toISOString();
      }
      return r;
    } catch (e) {
      job.lastDurationMs = Date.now() - started;
      job.errors++;
      job.lastError = e.message;
      job.lastErrorAt = new Date().toISOString();
      job.lastResult = 'failed';
      logger.error(`[${label}] Error:`, e.message);
      return undefined;
    } finally {
      job.running = false;
    }
  };
  return { safeFn, job };
}

function getJobs() {
  return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { wrapJob, getJobs };
