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
