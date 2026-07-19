'use strict';
// Unified scheduler registry (WP6.4): every recurring job registers here
// with its schedule, run count, and last error — surfaced in
// /api/admin/health as `jobs`. wrapJob preserves the original safe-fn
// semantics (errors logged, never thrown) while adding bookkeeping.
const jobs = new Map();

// wrapJob(label, schedule, fn, logger) → { safeFn, job }
//   label    — job name (e.g. 'DbBackup')
//   schedule — human label (e.g. '02:00 UTC' or 'every 5 min')
//   fn       — the job body; may return a promise
function wrapJob(label, schedule, fn, logger) {
  const job = jobs.get(label) || {
    name: label, schedule,
    runs: 0, errors: 0,
    lastRunAt: null, lastError: null, lastErrorAt: null, nextRunAt: null,
  };
  jobs.set(label, job);
  const safeFn = () => {
    job.lastRunAt = new Date().toISOString();
    job.runs++;
    try {
      const r = fn();
      if (r && r.catch) r.catch(e => {
        job.errors++;
        job.lastError = e.message;
        job.lastErrorAt = new Date().toISOString();
        logger.error(`[${label}] Error:`, e.message);
      });
    } catch (e) {
      job.errors++;
      job.lastError = e.message;
      job.lastErrorAt = new Date().toISOString();
      logger.error(`[${label}] Error:`, e.message);
    }
  };
  return { safeFn, job };
}

function getJobs() {
  return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { wrapJob, getJobs };
