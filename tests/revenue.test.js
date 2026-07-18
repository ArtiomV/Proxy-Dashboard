// WP8 unit tests for the canonical revenue metric (src/billing/revenue.js).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { computeRevenueWindow } = require('../src/billing/revenue.js');

// ledgerExpense copy (same semantics as server.js): charge → cost; correction →
// balance delta (positive = expense, negative = refund).
function ledgerExpense(e) {
  if (e.type === 'correction') {
    if (e.balance_before != null && e.balance_after != null) {
      return Math.round((e.balance_before - e.balance_after) * 100) / 100;
    }
    return e.cost || e.amount || 0;
  }
  return e.cost || e.amount || 0;
}

let db;
beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE billing_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, type TEXT,
    amount REAL, date TEXT, balance_before REAL, balance_after REAL)`);
  const ins = db.prepare('INSERT INTO billing_ledger (client_id, type, amount, date, balance_before, balance_after) VALUES (?,?,?,?,?,?)');
  // Client A: charges 100 (today-5d) + 50 (today-29d) + 999 (today-31d, outside)
  ins.run('A', 'charge', 100, '2026-06-25', null, null);
  ins.run('A', 'charge', 50, '2026-06-01', null, null);
  ins.run('A', 'charge', 999, '2026-05-30', null, null);
  // Client A: correction refund −20 (balance went UP by 20) inside window
  ins.run('A', 'correction', 20, '2026-06-20', 100, 120);
  // Client B: charge 200 in window
  ins.run('B', 'charge', 200, '2026-06-15', null, null);
});
afterEach(() => vi.useRealTimers());

const TODAY = '2026-06-30'; // MSK reference date

describe('computeRevenueWindow (WP8 canonical)', () => {
  it('sums charge + correction via ledgerExpense; refund REDUCES revenue', () => {
    const r = computeRevenueWindow({ db, ledgerExpense, today: TODAY, days: 30 });
    expect(r.byClient.A).toBe(130);       // 100 + 50 − 20 refund
    expect(r.byClient.B).toBe(200);
    expect(r.total).toBe(330);
    expect(r.windowDays).toBe(30);
    expect(r.asOf).toBe(TODAY);
  });

  it('window edge is inclusive at exactly today−30d, exclusive beyond', () => {
    // 2026-05-31 is exactly 30 days back → included; the 999 charge at 05-30 is out.
    const ins = db.prepare('INSERT INTO billing_ledger (client_id, type, amount, date) VALUES (?,?,?,?)');
    ins.run('C', 'charge', 7, '2026-05-31');
    const r = computeRevenueWindow({ db, ledgerExpense, today: TODAY, days: 30 });
    expect(r.byClient.C).toBe(7);
    expect(r.byClient.A).toBe(130);       // 999 from 05-30 still excluded
  });

  it('fromDays computes the PREVIOUS window (60..30 days ago)', () => {
    const r = computeRevenueWindow({ db, ledgerExpense, today: TODAY, days: 30, fromDays: 60 });
    expect(r.byClient.A).toBe(999);       // only the 05-30 charge lands in 60..30
    expect(r.byClient.B).toBeUndefined();
  });
});

describe('MSK window discipline (WP8 UTC bug class)', () => {
  it('getMoscowToday gives the MSK month at 01:00 MSK on the 1st (UTC still on prev month)', () => {
    // 2026-07-01 01:00 MSK = 2026-06-30 22:00 UTC — UTC month would be 2026-06.
    vi.setSystemTime(new Date('2026-06-30T22:00:00Z'));
    const { getMoscowToday } = require('../src/utils/time.js');
    const pfx = getMoscowToday().slice(0, 7);
    expect(pfx).toBe('2026-07');          // MSK month — NOT 2026-06 (the ops-ext bug)
    expect(new Date().toISOString().slice(0, 7)).toBe('2026-06'); // proves the trap is real
  });
});
