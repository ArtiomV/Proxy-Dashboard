// tests/billing-ledger-integrity.test.js — Stage 10 startup-integrity test.
//
// Locks the invariant established by Stage 4 billingLedger removal:
//   ledgerDb.rowCount() === sum over all clients of ledgerDb.listByClient(id).length
//
// If either path drifts (e.g. someone adds a WHERE filter to listByClient
// that silently drops rows, or rowCount() switches to a different table),
// this test trips and surfaces the divergence early. The metrics endpoint
// + admin health depend on rowCount() reporting the same number that the
// per-client list views show, so consistency here matters for trust.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);

let db, ledgerDb;

beforeAll(() => {
  bootApp();
  ledgerDb = require('../src/db/ledger.js');
  db = require('better-sqlite3')(process.env.DASHBOARD_DB_PATH);
});

describe('Stage 10: billing_ledger startup integrity', () => {
  it('rowCount() matches the row count from sqlite directly', () => {
    const direct = db.prepare('SELECT COUNT(*) AS n FROM billing_ledger').get().n;
    expect(ledgerDb.rowCount()).toBe(direct);
  });

  it('sum of listByClient lengths equals rowCount (no orphans, no double-count)', () => {
    // Pull every distinct client_id that appears in the ledger.
    const clientIds = db.prepare('SELECT DISTINCT client_id FROM billing_ledger').all().map(r => r.client_id);
    let listSum = 0;
    for (const id of clientIds) {
      listSum += ledgerDb.listByClient(id).length;
    }
    expect(listSum).toBe(ledgerDb.rowCount());
  });

  it('listByClient returns the historical JS shape (charges have `cost`, others have `amount`)', () => {
    // Smoke-test against whatever fixture data the test DB has. We don't
    // require any particular row to exist — only that any row we DO see
    // obeys the shape contract Stage 4 documented in src/db/ledger.js.
    const row = db.prepare("SELECT client_id FROM billing_ledger LIMIT 1").get();
    if (!row) return; // empty DB is fine (CI may run on fresh schema)
    const entries = ledgerDb.listByClient(row.client_id);
    for (const e of entries) {
      // type + date + timestamp always present
      expect(e.type).toBeTruthy();
      expect(e.date).toBeTruthy();
      // charges store `cost`, everything else stores `amount`
      if (e.type === 'charge') {
        expect(e).toHaveProperty('cost');
        expect(e).not.toHaveProperty('amount');
      } else {
        expect(e).toHaveProperty('amount');
      }
      // db_id is always present (used by delete-ledger-entry route)
      expect(typeof e.db_id).toBe('number');
    }
  });
});
