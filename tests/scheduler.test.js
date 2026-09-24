// WP6.4: scheduler registry bookkeeping (runs/errors/last-error).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { wrapJob, getJobs } = require('../src/jobs/scheduler.js');

const silent = { error() {} };

describe('scheduler registry (WP6.4)', () => {
  it('tracks runs, errors and exposes jobs for health', async () => {
    const { safeFn: okFn, job: okJob } = wrapJob('TestOk', '02:00 UTC', () => 1, silent);
    okJob.nextRunAt = '2026-07-19T02:00:00Z';
    okFn(); okFn();
    expect(okJob.runs).toBe(2);
    expect(okJob.errors).toBe(0);
    expect(okJob.lastRunAt).toBeTruthy();
    expect(okJob.nextRunAt).toBe('2026-07-19T02:00:00Z');

    const { safeFn: badFn, job: badJob } = wrapJob('TestBad', '03:00 UTC', () => { throw new Error('boom'); }, silent);
    badFn();
    expect(badJob.runs).toBe(1);
    expect(badJob.errors).toBe(1);
    expect(badJob.lastError).toBe('boom');

    // async rejection is also caught
    const { safeFn: asyncBadFn, job: asyncBadJob } = wrapJob('TestAsyncBad', '04:00 UTC', async () => { throw new Error('async boom'); }, silent);
    await asyncBadFn();
    await new Promise(r => setImmediate(r));
    expect(asyncBadJob.lastError).toBe('async boom');

    const names = getJobs().map(j => j.name);
    expect(names).toContain('TestOk');
    expect(names).toContain('TestBad');
  });
});

// C8/§10.7: raw-setInterval jobs are registered in the same registry, so
// /api/admin/health → jobs shows their last-run/status. Behaviour/cadence
// unchanged (wrapJob only adds bookkeeping around the original tick fn).
describe('interval jobs register in the scheduler registry (C8)', () => {
  it('NotifyCollect / Failover / ConnsHist appear in getJobs() after init', async () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE notifications (id INTEGER PRIMARY KEY, created_at TEXT)');

    const notifyCollect = require('../src/jobs/notify-collect.js');
    const failover = require('../src/jobs/failover.js');
    const connsHistory = require('../src/jobs/conns-history.js');

    const nc = notifyCollect.init({
      logger: silent, db,
      alerts: { isRuleEnabled: () => false, recordBellEvent() {}, trigger: () => true },
      uptimeTracking: {}, knownModems: {}, clients: [],
      getStaleNicks: () => new Set(), getSetting: (k, d) => d,
      trackingDb: { metaFleetRosterStmt: () => ({ all: () => [] }) },
      fetchAllServersDataCached: async () => [],
      mergeServerData: () => ({ status: [] }),
    });
    const fo = failover.init({ logger: silent, db, appSettings: {}, alerts: { trigger: () => true } });
    connsHistory.create({ getFetchAllServersDataCached: async () => [], logger: silent }).start();

    const byName = Object.fromEntries(getJobs().map(j => [j.name, j]));
    expect(byName.NotifyCollect.schedule).toBe('every 2 min');
    expect(byName.Failover.schedule).toBe('every 3 min');
    expect(byName.ConnsHist.schedule).toBe('every 1 min');
    // ConnsHist ticks immediately on start → runs counter already moved.
    await new Promise(r => setImmediate(r));
    expect(byName.ConnsHist.runs).toBeGreaterThanOrEqual(1);
    expect(byName.ConnsHist.lastRunAt).toBeTruthy();

    nc.stop(); fo.stop();
  });
});

// 2026-09-24 · DEEP-35: Promise-контракт, lastSuccessAt, running/duration,
// структурированный результат completed/skipped/partial/failed.
describe('scheduler — DEEP-35: структурированный результат', () => {
  it('safeFn возвращает Promise выполнения и результат job', async () => {
    const { safeFn, job } = wrapJob('TestPromise', '1 min', async () => ({ status: 'skipped', reason: 'disabled' }), silent);
    const r = await safeFn();
    expect(r).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(job.lastResult).toBe('skipped');
    expect(job.lastSuccessAt).toBeTruthy();
    expect(job.lastDurationMs).not.toBeNull();
    expect(job.running).toBe(false);
    expect(job.errors).toBe(0);
  });

  it('structured partial — успех с оговоркой, не ошибка', async () => {
    const { safeFn, job } = wrapJob('TestPartial', '1 min', async () => ({ status: 'partial', done: 3, total: 5 }), silent);
    await safeFn();
    expect(job.lastResult).toBe('partial');
    expect(job.errors).toBe(0);
    expect(job.lastSuccessAt).toBeTruthy();
  });

  it('structured failed БЕЗ throw — считается ошибкой (раньше неотличим от успеха)', async () => {
    const { safeFn, job } = wrapJob('TestStructFail', '1 min', async () => ({ status: 'failed', error: 'no_data' }), silent);
    await safeFn();
    expect(job.lastResult).toBe('failed');
    expect(job.errors).toBe(1);
    expect(job.lastError).toBe('no_data');
    expect(job.lastSuccessAt).toBeNull();
  });

  it('running=true на время выполнения', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const { safeFn, job } = wrapJob('TestRunning', '1 min', () => gate, silent);
    const p = safeFn();
    expect(job.running).toBe(true);
    release();
    await p;
    expect(job.running).toBe(false);
  });
});
