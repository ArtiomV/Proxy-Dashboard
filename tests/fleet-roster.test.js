// Regression guard for the fleet-roster query (src/db/tracking.js →
// metaFleetRosterStmt), which feeds computeFleet → «В работе X/Y» headline,
// per-server cards, «Модем отключен» card, and the offline alert.
//
// The RO2_35 bug (2026-07-16): a soft-deleted modem (modem_meta.deleted=1) kept
// being counted in fleet.total and lingered in offlineList → dashboard showed
// «91/92» and «модем отключён» for a deleted modem. Root cause: the roster query
// forgot `AND (deleted IS NULL OR deleted = 0)`. This test locks that filter (and
// the random/test/blank-imei exclusions) so a future rewrite can't silently
// resurrect the bug.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const trackingDb = require('../src/db/tracking');

const IMEIS = ['TESTFLEET_live', 'TESTFLEET_deleted', 'TESTFLEET_random', 'TESTFLEET_testpool', 'TESTFLEET_blank'];

function insert(db, { imei, nick, is_test_pool = 0, deleted = 0 }) {
  db.prepare(
    `INSERT INTO modem_meta (server_name, imei, nick, is_test_pool, deleted, updated_at)
     VALUES ('S9', ?, ?, ?, ?, datetime('now'))`
  ).run(imei, nick, is_test_pool, deleted);
}

describe('metaFleetRoster query (deleted/random/test exclusions)', () => {
  let db;
  beforeAll(() => { db = bootApp().db; });
  afterEach(() => {
    const del = db.prepare('DELETE FROM modem_meta WHERE imei = ?');
    for (const i of IMEIS) del.run(i);
  });

  it('excludes a soft-deleted modem (the RO2_35 scenario)', () => {
    insert(db, { imei: 'TESTFLEET_live', nick: 'S9_LIVE' });
    insert(db, { imei: 'TESTFLEET_deleted', nick: 'S9_DELETED', deleted: 1 });

    const rows = trackingDb.metaFleetRosterStmt().all().filter(r => String(r.imei).startsWith('TESTFLEET_'));
    const imeis = rows.map(r => r.imei);

    expect(imeis).toContain('TESTFLEET_live');
    expect(imeis).not.toContain('TESTFLEET_deleted');
  });

  it('also excludes random-nick, test-pool, and blank-imei rows', () => {
    insert(db, { imei: 'TESTFLEET_live', nick: 'S9_LIVE' });
    insert(db, { imei: 'TESTFLEET_random', nick: 'random123' });
    insert(db, { imei: 'TESTFLEET_testpool', nick: 'S9_TEST', is_test_pool: 1 });
    insert(db, { imei: 'TESTFLEET_blank', nick: '' });

    const imeis = trackingDb.metaFleetRosterStmt().all()
      .filter(r => String(r.imei).startsWith('TESTFLEET_')).map(r => r.imei);

    expect(imeis).toEqual(['TESTFLEET_live']);
  });
});
