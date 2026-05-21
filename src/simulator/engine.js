'use strict';

/**
 * Simulator engine: drives a pool of HTTP workers through specified modems,
 * records per-request samples, exposes live aggregates.
 *
 * Concurrency model is profile-driven:
 *   constant — fixed N workers throughout the run
 *   ramp     — linear from N1 to N2 over T seconds, hold at N2 after
 *   burst    — N workers for `on_seconds`, then 0 for `off_seconds`, repeat
 *
 * Lifecycle:
 *   start(profile) -> creates simulator_runs row, schedules tick(), spawns
 *                     workers per current target count
 *   tick()         -> 500ms scheduler: matches activeWorkers to target
 *   workerLoop()   -> infinite loop while active: pick modem+url, fetch,
 *                     record sample, repeat (no per-request sleep — back-to-
 *                     back is what reproduces client load patterns)
 *   stop(reason)   -> signals workers to exit after current request,
 *                     computes summary, writes simulator_runs.summary_json
 *
 * Only one run can be active at a time (singleton). enforced.
 */

const { executeRequest } = require('./worker');

let db, logger, getSetting;
let activeRun = null;
let listeners = [];   // SSE subscribers: { runId, send: (event) => void }

// ─── Prepared statements (lazy, after init) ───────────────────────────────────
let _runInsert, _runUpdate, _sampleInsert, _profileGet, _modemTestPoolCheck;

function init(deps) {
  db = deps.db;
  logger = deps.logger;
  getSetting = deps.getSetting;

  _runInsert = db.prepare(`
    INSERT INTO simulator_runs (profile_id, profile_name, status, config_json, started_by)
    VALUES (?, ?, 'running', ?, ?) RETURNING id
  `);
  _runUpdate = db.prepare(`
    UPDATE simulator_runs SET status = ?, ended_at = datetime('now'), summary_json = ?, error_msg = ?
    WHERE id = ?
  `);
  _sampleInsert = db.prepare(`
    INSERT INTO simulator_samples
      (run_id, ts_ms, worker_id, modem_nick, server_name, status, http_status, total_ms, connect_ms, ttfb_ms, bytes, url, error_msg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  _profileGet = db.prepare('SELECT id, name, config_json FROM simulator_profiles WHERE id = ?');
  _modemTestPoolCheck = db.prepare(`
    SELECT 1 FROM modem_meta WHERE server_name = ? AND nick = ? AND is_test_pool = 1
    ORDER BY updated_at DESC LIMIT 1
  `);
  logger.info('[Simulator] engine initialised');
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getActive() {
  if (!activeRun) return null;
  return {
    id: activeRun.id,
    started_at: activeRun.startedAt,
    elapsed_sec: Math.floor((Date.now() - activeRun.startedAt) / 1000),
    target_workers: activeRun.targetWorkers,
    active_workers: activeRun.workers.size,
    profile_name: activeRun.profile.name,
  };
}

// Caller (the /run API endpoint) is responsible for resolving proxy URLs
// from (server, nick) → full http://user:pass@host:port — passes them in
// via opts.resolvedModems. Engine just trusts the list.
function start(profile, opts) {
  if (activeRun) throw new Error('Симулятор уже запущен (run #' + activeRun.id + ')');
  _validateProfile(profile);

  const resolvedModems = (opts && opts.resolvedModems) || [];
  if (resolvedModems.length === 0) {
    throw new Error('Не передано ни одного модема с готовыми credentials');
  }
  // Belt-and-suspenders: verify each one is actually in the test pool.
  for (const m of resolvedModems) {
    if (!_modemTestPoolCheck.get(m.server, m.nick)) {
      throw new Error(`Модем ${m.server}/${m.nick} не помечен как is_test_pool — отказ`);
    }
  }

  const runRow = _runInsert.get(
    profile.id || null,
    profile.name || 'ad-hoc',
    JSON.stringify(profile),
    (opts && opts.startedBy) || null
  );

  activeRun = {
    id: runRow.id,
    profile,
    modems: resolvedModems,
    startedAt: Date.now(),
    nextWorkerId: 0,
    targetWorkers: 0,
    workers: new Map(),   // workerId -> { stopRequested }
    samples: 0,
    stopReason: null,
  };

  // Buffer for batched sample writes (1 row at a time would tank perf)
  activeRun.sampleBuffer = [];
  activeRun.flushTimer = setInterval(_flushSamples, 1000);

  activeRun.tickTimer = setInterval(_tick, 500);
  activeRun.endTimer = setTimeout(() => stop('completed'), profile.duration_ms);

  logger.info(`[Simulator] start run #${runRow.id} (${profile.name||'ad-hoc'}, ${resolvedModems.length} modems)`);
  _broadcast({ type: 'start', run: getActive() });
  return runRow.id;
}

function stop(reason) {
  if (!activeRun) return;
  const run = activeRun;
  activeRun = null;
  run.stopReason = reason || 'aborted';

  clearInterval(run.tickTimer);
  clearTimeout(run.endTimer);
  // Signal workers to exit after current request
  for (const w of run.workers.values()) w.stopRequested = true;

  // Give workers a moment to drain in-flight requests, then finalise
  setTimeout(() => {
    clearInterval(run.flushTimer);
    _flushSamplesFor(run);

    const summary = _computeSummary(run);
    _runUpdate.run(run.stopReason, JSON.stringify(summary), null, run.id);
    logger.info(`[Simulator] run #${run.id} ${run.stopReason} (${run.samples} samples, ${run.workers.size} still in-flight)`);
    _broadcast({ type: 'end', runId: run.id, reason: run.stopReason, summary });
  }, 2000);
}

function abort(runId) {
  if (!activeRun || activeRun.id !== runId) {
    throw new Error('Нет активного run с этим id');
  }
  stop('aborted');
}

// SSE subscription. `send` is a function that takes an event object.
function subscribe(runId, send) {
  const listener = { runId, send };
  listeners.push(listener);
  // Immediately push current snapshot
  if (activeRun && activeRun.id === runId) {
    send({ type: 'snapshot', run: getActive() });
  }
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

function _validateProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('Профиль не задан');
  if (!Array.isArray(p.target_modems) || p.target_modems.length === 0) throw new Error('Не выбран ни один модем');
  if (!Array.isArray(p.targets) || p.targets.length === 0) throw new Error('Не задано ни одного URL');
  if (!p.concurrency || !p.concurrency.mode) throw new Error('Не задан режим concurrency');
  if (typeof p.duration_ms !== 'number' || p.duration_ms <= 0) throw new Error('duration_ms некорректно');
  if (typeof p.timeout_ms !== 'number' || p.timeout_ms <= 0) throw new Error('timeout_ms некорректно');
  for (const t of p.targets) {
    if (!t.url || !/^https?:\/\//.test(t.url)) throw new Error('Некорректный URL: ' + (t.url||''));
  }
}

// _resolveModems / _findLiveModem removed — resolution happens in the API
// layer that calls start(). See routes in server.js (Day 2).

function _tick() {
  if (!activeRun) return;
  const elapsedSec = (Date.now() - activeRun.startedAt) / 1000;
  const target = _computeTargetWorkers(activeRun.profile, elapsedSec);
  activeRun.targetWorkers = target;
  // Spawn missing workers
  while (activeRun.workers.size < target) {
    _spawnWorker();
  }
  // Mark surplus workers for shutdown (they'll exit after their current request)
  if (activeRun.workers.size > target) {
    let toKill = activeRun.workers.size - target;
    for (const [id, w] of activeRun.workers) {
      if (toKill <= 0) break;
      if (!w.stopRequested) { w.stopRequested = true; toKill--; }
    }
  }
}

function _computeTargetWorkers(profile, elapsedSec) {
  const c = profile.concurrency;
  if (c.mode === 'constant') return Math.max(0, c.workers|0);
  if (c.mode === 'ramp') {
    if (elapsedSec >= c.ramp_seconds) return c.end|0;
    const f = elapsedSec / c.ramp_seconds;
    return Math.round(c.start + (c.end - c.start) * f);
  }
  if (c.mode === 'burst') {
    const cycle = c.on_seconds + c.off_seconds;
    if (cycle <= 0) return 0;
    return (elapsedSec % cycle) < c.on_seconds ? (c.workers|0) : 0;
  }
  return 0;
}

function _spawnWorker() {
  const run = activeRun;
  if (!run) return;
  const workerId = ++run.nextWorkerId;
  const ctx = { stopRequested: false };
  run.workers.set(workerId, ctx);
  _workerLoop(workerId, ctx).catch(e => {
    logger.warn('[Simulator] worker error: ' + (e.message || e));
  }).finally(() => {
    run.workers.delete(workerId);
  });
}

async function _workerLoop(workerId, ctx) {
  const run = activeRun;
  if (!run) return;
  while (!ctx.stopRequested && activeRun === run) {
    const modem = _pickModem(run);
    const target = _pickTarget(run.profile);
    // proxyUrl is pre-resolved by the API layer (Day 2). Engine just consumes it.
    const sample = await executeRequest({
      url: target.url,
      method: target.method || 'GET',
      headers: target.headers || {},
      body: target.body,
      proxyUrl: modem.proxyUrl,
      timeoutMs: run.profile.timeout_ms,
    });
    if (activeRun !== run) break; // run ended while we were awaiting
    const tsMs = Date.now() - run.startedAt;
    run.sampleBuffer.push([
      run.id, tsMs, workerId, modem.nick, modem.server, sample.status,
      sample.http_status || 0, sample.total_ms, sample.connect_ms, sample.ttfb_ms,
      sample.bytes, target.url, sample.error_msg
    ]);
    run.samples++;
  }
}

function _pickModem(run) {
  // Weighted random distribution would be next; for now uniform random.
  return run.modems[Math.floor(Math.random() * run.modems.length)];
}

function _pickTarget(profile) {
  // Weighted choice over profile.targets
  const total = profile.targets.reduce((s, t) => s + (t.weight || 1), 0);
  let r = Math.random() * total;
  for (const t of profile.targets) {
    r -= (t.weight || 1);
    if (r <= 0) return t;
  }
  return profile.targets[0];
}

// _buildProxyUrl removed — see comment above _workerLoop. URL pre-resolved.

// ─── Sample buffer flush ──────────────────────────────────────────────────────

function _flushSamples() { if (activeRun) _flushSamplesFor(activeRun); }
function _flushSamplesFor(run) {
  if (!run.sampleBuffer.length) return;
  const batch = run.sampleBuffer.splice(0, run.sampleBuffer.length);
  const tx = db.transaction(() => {
    for (const row of batch) _sampleInsert.run(...row);
  });
  try { tx(); } catch (e) { logger.warn('[Simulator] sample flush failed: ' + e.message); }
  // Aggregate the just-flushed batch for live consumers
  _broadcast({ type: 'tick', runId: run.id, snapshot: getActive(), batchCount: batch.length });
}

// ─── Summary computation (final report) ───────────────────────────────────────

function _computeSummary(run) {
  // Pull all samples for this run from DB (faster than re-reading buffer)
  const rows = db.prepare(`
    SELECT status, total_ms, connect_ms, ttfb_ms, bytes
    FROM simulator_samples WHERE run_id = ?
  `).all(run.id);

  const total = rows.length;
  const byStatus = {};
  const totalMs = [];
  let totalBytes = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    totalMs.push(r.total_ms);
    totalBytes += r.bytes || 0;
  }
  totalMs.sort((a, b) => a - b);
  const pct = (p) => totalMs.length ? totalMs[Math.min(totalMs.length-1, Math.floor(totalMs.length * p))] : 0;

  const durationSec = Math.max(1, ((Date.now() - run.startedAt) / 1000));
  return {
    total_requests: total,
    by_status: byStatus,
    success_pct: total ? Math.round((byStatus.success||0) / total * 1000) / 10 : 0,
    timeout_pct: total ? Math.round((byStatus.timeout||0) / total * 1000) / 10 : 0,
    p50_ms: pct(0.50),
    p95_ms: pct(0.95),
    p99_ms: pct(0.99),
    avg_throughput_mbps: Math.round(totalBytes * 8 / 1e6 / durationSec * 10) / 10,
    duration_sec: Math.round(durationSec),
  };
}

function _broadcast(event) {
  for (const l of listeners) {
    if (!event.runId || event.runId === l.runId) {
      try { l.send(event); } catch (_) { /* best-effort */ }
    }
  }
}

module.exports = { init, start, stop, abort, getActive, subscribe };
