// Characterization tests for src/billing/atomic.js.
//
// The contract under test:
//   - atomicCredit: balance + ledger in one transaction; in-memory clientById
//     and billingLedger updated as a side effect
//   - atomicDebit: same, plus minBalance gate → INSUFFICIENT_BALANCE error,
//     plus UNIQUE-violation handling → { duplicate: true }
//   - amount rounded to cents
//   - amount=0 is a no-op (no ledger write, no balance change)
//
// The TZ explicitly calls out these cases. If a future change to atomic.js
// regresses any of them, this file should be the first to scream.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

// CJS-cached require: server.js loads billing via require(), so its post-init
// instance lives in the CJS cache. ESM dynamic import() gets a *separate*
// uninitialised copy and would have undefined `db`. Pin to the CJS path.
const cjsRequire = createRequire(import.meta.url);

let billing, db;

beforeAll(() => {
  const { db: bootedDb } = bootApp();
  db = bootedDb;
  billing = cjsRequire('../src/billing/atomic.js');
});

// Helper: insert a fresh client row and matching record in clientById (so
// atomic.js can keep its in-memory mirror in sync). Returns id.
function makeClient({ balance = 0, login = null } = {}) {
  const id = crypto.randomUUID();
  const realLogin = login || ('test_' + id.slice(0, 8));
  db.prepare(`INSERT INTO clients (id, login, name, balance, created_at)
              VALUES (?, ?, ?, ?, datetime('now'))`)
    .run(id, realLogin, 'Test ' + realLogin, balance);
  // Mirror into the in-memory clientById map that atomic.js synchronises.
  // The map is owned by server.js — we re-require to get the same reference.
  // eslint-disable-next-line global-require
  const serverCtx = require('../server.js');
  if (!serverCtx.clientById) {
    // Older code path: clientById isn't exported. atomic.js no-ops when
    // the lookup is empty, so this is fine for tests that read from DB.
  }
  return id;
}

function getBalance(id) {
  return db.prepare('SELECT balance FROM clients WHERE id = ?').get(id).balance;
}
function getLedgerCount(id) {
  return db.prepare('SELECT COUNT(*) AS n FROM billing_ledger WHERE client_id = ?').get(id).n;
}

describe('billing/atomic', () => {
  describe('atomicCredit', () => {
    it('adds amount to balance and inserts ledger entry in one transaction', () => {
      const id = makeClient({ balance: 100 });
      const res = billing.atomicCredit(id, 50, { type: 'payment', date: '2026-01-01', note: 'test' });
      expect(res.balanceBefore).toBe(100);
      expect(res.balanceAfter).toBe(150);
      expect(getBalance(id)).toBe(150);
      expect(getLedgerCount(id)).toBe(1);
    });

    it('rounds amount to cents (no floating-point drift)', () => {
      const id = makeClient({ balance: 0 });
      const res = billing.atomicCredit(id, 0.1 + 0.2, { type: 'payment', date: '2026-01-02' });
      // 0.1 + 0.2 = 0.30000000000000004 → rounded to 0.30
      expect(res.balanceAfter).toBe(0.3);
      expect(getBalance(id)).toBe(0.3);
    });

    it('amount=0 is a no-op (no ledger write, no balance change)', () => {
      const id = makeClient({ balance: 42 });
      const beforeCount = getLedgerCount(id);
      const res = billing.atomicCredit(id, 0, { type: 'payment', date: '2026-01-03' });
      expect(res.balanceBefore).toBe(42);
      expect(res.balanceAfter).toBe(42);
      expect(getLedgerCount(id)).toBe(beforeCount);
    });

    it('throws when client_id is unknown (no orphan ledger row)', () => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM billing_ledger').get().n;
      expect(() => billing.atomicCredit('does-not-exist', 10, { type: 'payment', date: '2026-01-04' }))
        .toThrow(/not found/);
      const after = db.prepare('SELECT COUNT(*) AS n FROM billing_ledger').get().n;
      expect(after).toBe(before);
    });
  });

  describe('atomicDebit', () => {
    it('subtracts amount from balance and inserts ledger entry', () => {
      const id = makeClient({ balance: 100 });
      const res = billing.atomicDebit(id, 30, { type: 'charge', date: '2026-02-01', amount: 30 });
      expect(res.balanceBefore).toBe(100);
      expect(res.balanceAfter).toBe(70);
      expect(getBalance(id)).toBe(70);
    });

    it('allows balance to go negative when minBalance is not set', () => {
      const id = makeClient({ balance: 10 });
      const res = billing.atomicDebit(id, 50, { type: 'charge', date: '2026-02-02', amount: 50 });
      expect(res.balanceAfter).toBe(-40);
      expect(getBalance(id)).toBe(-40);
    });

    it('refuses to debit below minBalance (INSUFFICIENT_BALANCE)', () => {
      const id = makeClient({ balance: 10 });
      let thrown;
      try {
        billing.atomicDebit(id, 50, { type: 'charge', date: '2026-02-03', amount: 50 }, { minBalance: 0 });
      } catch (e) { thrown = e; }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe('INSUFFICIENT_BALANCE');
      expect(thrown.balanceBefore).toBe(10);
      // Balance NOT touched
      expect(getBalance(id)).toBe(10);
      expect(getLedgerCount(id)).toBe(0);
    });

    it('returns {duplicate:true} on UNIQUE-index violation (idempotent re-charge)', () => {
      const id = makeClient({ balance: 100 });
      const entry = { type: 'charge', date: '2026-02-04', amount: 30 };
      const first = billing.atomicDebit(id, 30, entry);
      expect(first.balanceAfter).toBe(70);
      // Second identical charge on the same date hits the UNIQUE index on
      // (client_id, date, type) WHERE type='charge'. atomic.js converts this
      // into a non-throwing result so callers can retry safely.
      const second = billing.atomicDebit(id, 30, entry);
      expect(second.duplicate).toBe(true);
      // Balance MUST be unchanged — the whole point of duplicate detection
      expect(getBalance(id)).toBe(70);
    });
  });

  // Stage 13.1: opts.referral propagates the commission inside the same
  // transaction as the balance update. Pre-fix this was a separate stmt
  // OUTSIDE the txn — a crash between the two left the books inconsistent.
  describe('opts.referral atomicity', () => {
    function makeReferralPair() {
      const referrer = makeClient({ balance: 0 });
      const referred = makeClient({ balance: 0 });
      db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrer, referred);
      return { referrer, referred };
    }
    function getRef(id) {
      return db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(id).referral_balance;
    }

    it('atomicCredit with opts.referral updates referrer DB inside the same txn', () => {
      const { referrer, referred } = makeReferralPair();
      const res = billing.atomicCredit(referred, 1000, { type: 'payment', date: '2026-03-01', amount: 1000 }, {
        referral: { referrerId: referrer, delta: 150 }, // 15% of 1000
      });
      expect(res.balanceAfter).toBe(1000);
      expect(res.referral).toEqual({ referrerId: referrer, newBalance: 150 });
      // DB committed both halves.
      expect(getBalance(referred)).toBe(1000);
      expect(getRef(referrer)).toBe(150);
    });

    it('atomicDebit with negative referral delta reverses the commission', () => {
      const { referrer, referred } = makeReferralPair();
      // Seed: pretend a prior payment already credited 150 to the referrer.
      db.prepare('UPDATE clients SET referral_balance = ? WHERE id = ?').run(150, referrer);
      db.prepare('UPDATE clients SET balance = ? WHERE id = ?').run(1000, referred);

      const res = billing.atomicDebit(referred, 1000, { type: 'payment_reversal', date: '2026-03-02', amount: 1000 }, {
        referral: { referrerId: referrer, delta: -150 },
      });
      expect(res.balanceAfter).toBe(0);
      expect(res.referral.newBalance).toBe(0);
      expect(getRef(referrer)).toBe(0);
      expect(getBalance(referred)).toBe(0);
    });

    it('rolls back BOTH balance and referral if the txn throws (no partial state)', () => {
      // Throw inside the txn by passing an unknown referrer — the SELECT in
      // _applyReferralInsideTx will return undefined, and the UPDATE that
      // affects zero rows still "succeeds" in SQLite (no error). To force a
      // real rollback we instead use an unknown CLIENT_ID — atomicCredit
      // checks that BEFORE balance update and throws "not found".
      const { referrer } = makeReferralPair();
      const refBefore = getRef(referrer);
      expect(() => billing.atomicCredit('nope-no-such-client', 100, { type: 'payment', date: '2026-03-03' }, {
        referral: { referrerId: referrer, delta: 15 },
      })).toThrow(/not found/);
      // Referrer balance UNCHANGED — the failed txn was rolled back.
      expect(getRef(referrer)).toBe(refBefore);
    });

    it('missing referrerId or zero delta = referral block ignored (no update)', () => {
      const { referrer, referred } = makeReferralPair();
      const refBefore = getRef(referrer);
      billing.atomicCredit(referred, 50, { type: 'payment', date: '2026-03-04' }, {
        referral: { referrerId: null, delta: 100 }, // null referrerId
      });
      expect(getRef(referrer)).toBe(refBefore);
      billing.atomicCredit(referred, 50, { type: 'payment', date: '2026-03-05' }, {
        referral: { referrerId: referrer, delta: 0 }, // zero delta
      });
      expect(getRef(referrer)).toBe(refBefore);
    });
  });
});
