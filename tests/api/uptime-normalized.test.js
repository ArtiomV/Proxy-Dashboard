// WP7.1: uptime_tracking is normalized (migration 047) — scalar columns +
// uptime_daily, no JSON blob. Locks the db-layer round trip.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
let db, trackingDb;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  trackingDb = require('../../src/db/tracking.js');
});

describe('WP7.1: normalized uptime_tracking', () => {
  it('has scalar columns and the uptime_daily table (no blob dependency)', () => {
    const cols = db.prepare("PRAGMA table_info(uptime_tracking)").all().map(c => c.name);
    for (const c of ['total_checks', 'online_checks', 'last_online_check', 'offline_alerted']) {
      expect(cols).toContain(c);
    }
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='uptime_daily'").get();
    expect(t).toBeTruthy();
  });

  it('utUpsert/utAll round trip; daily upsert conflicts update in place', () => {
    trackingDb.utUpsertStmt().run('WT_S1_T1', 10, 8, '2026-07-01T00:00:00Z', '2026-07-17T10:00:00Z', '2026-07-17T09:55:00Z', 1);
    trackingDb.utDailyUpsertStmt().run('WT_S1_T1', '2026-07-17', 5, 6);

    const row = trackingDb.utAllStmt().all().find(r => r.key === 'WT_S1_T1');
    expect(row).toMatchObject({
      total_checks: 10,
      online_checks: 8,
      last_online_check: '2026-07-17T09:55:00Z',
      offline_alerted: 1,
    });

    let days = trackingDb.utDailyAllStmt().all().filter(d => d.key === 'WT_S1_T1');
    expect(days).toEqual([{ key: 'WT_S1_T1', date: '2026-07-17', online: 5, total: 6 }]);

    // Conflict on (key, date) updates instead of duplicating.
    trackingDb.utDailyUpsertStmt().run('WT_S1_T1', '2026-07-17', 7, 9);
    days = trackingDb.utDailyAllStmt().all().filter(d => d.key === 'WT_S1_T1');
    expect(days).toEqual([{ key: 'WT_S1_T1', date: '2026-07-17', online: 7, total: 9 }]);

    // Cleanup so re-runs stay isolated.
    db.prepare("DELETE FROM uptime_tracking WHERE key = 'WT_S1_T1'").run();
    db.prepare("DELETE FROM uptime_daily WHERE key = 'WT_S1_T1'").run();
  });
});
