// WP5: the daily balance-reconcile job must catch balance-vs-ledger drift.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { create } = require('../src/jobs/balance-reconcile.js');

function mkDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE billing_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, type TEXT,
    amount REAL, date TEXT, balance_before REAL, balance_after REAL)`);
  return db;
}
const silentLogger = { info() {}, warn() {}, error() {} };

describe('balance-reconcile job (WP5)', () => {
  let db, fired, alerts, logRows, logActivity;
  beforeEach(() => {
    db = mkDb();
    fired = [];
    alerts = { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } };
    logRows = [];
    logActivity = (...a) => logRows.push(a);
  });
  function seedLedger() {
    // expected balance for client A: 100 − 30 = 70
    db.prepare("INSERT INTO billing_ledger (client_id, type, amount, date, balance_before, balance_after) VALUES ('A','payment',100,'2026-06-01',0,100)").run();
    db.prepare("INSERT INTO billing_ledger (client_id, type, amount, date, balance_before, balance_after) VALUES ('A','charge',30,'2026-06-02',100,70)").run();
  }

  it('clean books → divergent = 0, no alerts', () => {
    seedLedger();
    const clients = [{ id: 'A', name: 'Client A', balance: 70 }];
    const job = create({ db, clients, logActivity, logger: silentLogger, alerts });
    const res = job.runOnce();
    expect(res.divergent).toBe(0);
    expect(res.total).toBe(1);
    expect(fired.length).toBe(0);
    expect(logRows.length).toBe(0);
  });

  it('corrupted balance → detected, logged critical, TG alert fired, visible via getLastResult', () => {
    seedLedger();
    const clients = [{ id: 'A', name: 'Client A', balance: 50 }];  // should be 70
    const job = create({ db, clients, logActivity, logger: silentLogger, alerts });
    const res = job.runOnce();
    expect(res.divergent).toBe(1);
    expect(res.offenders[0]).toMatchObject({ id: 'A', actual: 50, expected: 70, diff: -20 });
    // critical activity logged
    expect(logRows.length).toBe(1);
    expect(logRows[0][0]).toBe('billing');
    expect(logRows[0][1]).toBe('critical');
    expect(logRows[0][2]).toBe('balance_drift');
    // TG alert fired once with the balance_drift rule
    expect(fired.length).toBe(1);
    expect(fired[0].rule).toBe('balance_drift');
    // health surface
    expect(job.getLastResult().divergent).toBe(1);
  });

  it('respects the opening-balance anchor (pre-ledger remainder)', () => {
    // Opening balance 500 outside the ledger → first entry's balance_before=500.
    db.prepare("INSERT INTO billing_ledger (client_id, type, amount, date, balance_before, balance_after) VALUES ('B','payment',100,'2026-06-01',500,600)").run();
    const clients = [{ id: 'B', name: 'Client B', balance: 600 }];
    const job = create({ db, clients, logActivity, logger: silentLogger, alerts });
    expect(job.runOnce().divergent).toBe(0);
  });
});
