'use strict';

const crypto = require('crypto');

// P2-2: background job registry extracted verbatim from server.js. Async-fire-
// and-track: launch an async fn in the background, return a jobId, and let the
// caller poll /api/admin/jobs/:id for completion (avoids HTTP timeouts when e.g.
// billing takes >30s). Self-contained — no app state, no closures.
const jobs = new Map(); // jobId → { id, name, status, startedAt, finishedAt, error, result }

function startJob(name, fn) {
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { id: jobId, name, status: 'running', startedAt: new Date().toISOString() };
  jobs.set(jobId, job);
  // Trim job map at 200 entries
  if (jobs.size > 200) {
    const oldest = Array.from(jobs.keys()).slice(0, jobs.size - 200);
    for (const k of oldest) jobs.delete(k);
  }
  Promise.resolve().then(() => fn()).then(result => {
    job.status = 'done'; job.finishedAt = new Date().toISOString(); job.result = result;
  }).catch(e => {
    job.status = 'failed'; job.finishedAt = new Date().toISOString(); job.error = e.message;
  });
  return jobId;
}

module.exports = { jobs, startJob };
