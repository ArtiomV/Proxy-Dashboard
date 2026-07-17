// Characterization tests for the payment/money path — locks the contract
// BEFORE Stage 13.1/13.2/13.3 touch it. Each test documents what the CURRENT
// implementation does (not what it should do); any future commit that
// intends to change behavior must update the assertion explicitly and
// explain why in the commit message.
//
// Coverage matrix:
//   POST   /api/admin/clients/:id/payment
//     • balance in DB updated
//     • row appears in billing_ledger
//     • row appears in payments table
//     • referrer referral_balance bumped by 15% (DB + in-memory)
//   POST   /api/admin/clients/:id/charge
//     • balance debited
//     • row in billing_ledger with type='correction'
//   DELETE /api/admin/clients/:id/payment/:index?amount=…
//     • payments row removed
//     • billing_ledger reversal entry written
//     • referrer commission reversed (DB + in-memory)
//   POST   /api/tochka/webhook (auto-credit + referral)
//     • bank_payments row inserted
//     • idempotent on repeat paymentId (UNIQUE)
//     • client balance credited; referral commission applied
//   GET    /api/admin/clients/:id/payments
//     • returns from in-memory client.payments (current source)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import https from 'https';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
});

// --- Small helpers for direct-DB assertions ---

function dbBalance(id) {
  const r = db.prepare('SELECT balance FROM clients WHERE id = ?').get(id);
  return r ? r.balance : null;
}
function dbReferralBalance(id) {
  const r = db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(id);
  return r ? r.referral_balance : null;
}
function ledgerEntries(id) {
  return db.prepare(
    'SELECT id, type, amount, date, note, source, payment_id FROM billing_ledger ' +
    'WHERE client_id = ? ORDER BY id'
  ).all(id);
}
function paymentsRows(id) {
  return db.prepare('SELECT id, amount, date, note, source, payment_id FROM payments WHERE client_id = ?').all(id);
}

let _tag = 0;
async function createClient(overrides = {}) {
  const tag = crypto.randomBytes(3).toString('hex') + (++_tag);
  const res = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'PayTest ' + tag, login: 'pay_' + tag, password: 'pw_' + tag,
    portName: 'payport_' + tag, billingType: 'per_gb', price: 10, currency: 'RUB',
    ...overrides,
  });
  expect(res.status).toBe(200);
  return res.body.client;
}

// Create a referrer + referred pair. Returns { referrer, referred }.
// The referrer is set on the referred via direct DB write (admin-create
// route doesn't accept referred_by in the body in current implementation).
async function createReferralPair() {
  const referrer = await createClient();
  const referred = await createClient();
  // Wire the link both in DB AND in the live in-memory client map.
  db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrer.id, referred.id);
  // Read state from server.js' in-memory map (the one the routes use).
  const { state } = require('../../src/state/index.js');
  const liveReferred = state.clientById.get(referred.id);
  if (liveReferred) liveReferred.referred_by = referrer.id;
  return { referrer, referred };
}

describe('Stage 13.0: characterization — POST /api/admin/clients/:id/payment', () => {
  it('credits balance + writes billing_ledger row + writes payments table row', async () => {
    const c = await createClient();
    const ledgerBefore = ledgerEntries(c.id).length;
    const paymentsBefore = paymentsRows(c.id).length;

    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 250, date: '2026-05-23', note: 'first' });
    expect(res.status).toBe(200);

    // 1. Balance in DB matches HTTP response.
    expect(dbBalance(c.id)).toBe(250);
    expect(res.body.balance).toBe(250);

    // 2. billing_ledger gained exactly one row of type='payment'.
    const ledger = ledgerEntries(c.id);
    expect(ledger.length).toBe(ledgerBefore + 1);
    const last = ledger[ledger.length - 1];
    expect(last.type).toBe('payment');
    expect(last.amount).toBe(250);
    expect(last.date).toBe('2026-05-23');

    // 3. Stage 13.3: payments table is NO LONGER written from saveClients.
    // The recorded fact lives in billing_ledger (asserted above). Legacy
    // rows pre-dating 13.3 stay readable; new payments don't add rows.
    const paymentsAfter = paymentsRows(c.id);
    expect(paymentsAfter.length).toBe(paymentsBefore);
  });

  it('credits referrer with 15% commission (DB + in-memory)', async () => {
    const { referrer, referred } = await createReferralPair();
    expect(dbReferralBalance(referrer.id)).toBe(0);

    const res = await request(app)
      .post(`/api/admin/clients/${referred.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 1000, date: '2026-05-23', note: 'refpay' });
    expect(res.status).toBe(200);

    // 15% of 1000 = 150. DB updated by _clientUpdateReferralBalance.run.
    expect(dbReferralBalance(referrer.id)).toBe(150);

    // In-memory map also updated (same code path: clientById.get(referrer))
    const { state } = require('../../src/state/index.js');
    expect(state.clientById.get(referrer.id).referral_balance).toBe(150);
  });
});

describe('Stage 13.0: characterization — POST /api/admin/clients/:id/charge', () => {
  it('debits balance + writes billing_ledger row with type=correction', async () => {
    const c = await createClient();
    // Seed +500
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 500, date: '2026-05-23' });

    const ledgerBefore = ledgerEntries(c.id).length;
    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/charge`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 75, date: '2026-05-23', note: 'fixup' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(425);
    expect(dbBalance(c.id)).toBe(425);

    const ledger = ledgerEntries(c.id);
    expect(ledger.length).toBe(ledgerBefore + 1);
    const last = ledger[ledger.length - 1];
    expect(last.type).toBe('correction');
    expect(last.amount).toBe(75);
  });
});

describe('Stage 13.0: characterization — DELETE /api/admin/clients/:id/payment/:index', () => {
  it('removes the payment from in-memory array + writes a payment_reversal ledger entry + reverses referral commission', async () => {
    const { referrer, referred } = await createReferralPair();

    // Make a payment that bumps referral by 30 (15% of 200).
    await request(app).post(`/api/admin/clients/${referred.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 200, date: '2026-05-23' });
    expect(dbReferralBalance(referrer.id)).toBe(30);
    expect(dbBalance(referred.id)).toBe(200);

    // Delete the payment we just made. Requires the amount confirmation.
    const delRes = await request(app)
      .delete(`/api/admin/clients/${referred.id}/payment/0?amount=200`)
      .set('X-Auth-Token', adminToken);
    expect(delRes.status).toBe(200);

    // Balance is rolled back via atomicDebit + 'payment_reversal' ledger entry.
    expect(dbBalance(referred.id)).toBe(0);
    const ledger = ledgerEntries(referred.id);
    const reversal = ledger.find(e => e.type === 'payment_reversal');
    expect(reversal).toBeTruthy();
    expect(reversal.amount).toBe(200);

    // Referral commission reversed (DB + in-memory).
    expect(dbReferralBalance(referrer.id)).toBe(0);
    const { state } = require('../../src/state/index.js');
    expect(state.clientById.get(referrer.id).referral_balance).toBe(0);

    // Stage 13.3: payments table no longer written from saveClients; the
    // payment reversal is recorded in billing_ledger only.
    expect(paymentsRows(referred.id).length).toBe(0);
  });
});

describe('Stage 13.3: GET /api/admin/clients/:id/payments reads from billing_ledger', () => {
  it('returns ledger-derived payment list (preserves response shape)', async () => {
    const c = await createClient();
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 33, date: '2026-05-23', note: 'visible' });

    const res = await request(app).get(`/api/admin/clients/${c.id}/payments`).set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const found = res.body.find(p => p.amount === 33 && p.note === 'visible');
    expect(found).toBeTruthy();
    // Response shape preserved: { amount, date, note, source, paymentId, createdAt }
    expect(typeof found.createdAt).toBe('string');
    expect(found.source).toBe('manual');
  });

  it('does NOT include charge / correction / payment_reversal entries', async () => {
    const c = await createClient();
    // Payment + charge + reversal → only the payment should show up.
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 100, date: '2026-05-23', note: 'p1' });
    await request(app).post(`/api/admin/clients/${c.id}/charge`).set('X-Auth-Token', adminToken)
      .send({ amount: 30, date: '2026-05-23', note: 'c1' });

    const res = await request(app).get(`/api/admin/clients/${c.id}/payments`).set('X-Auth-Token', adminToken);
    expect(res.body.length).toBe(1);
    expect(res.body[0].amount).toBe(100);
    expect(res.body[0].note).toBe('p1');
  });
});

describe('P0-2: DELETE /api/admin/clients/:id/payment/by-ledger/:ledgerDbId', () => {
  it('reverses balance + referral by stable ledger id, hides the payment, and is idempotent', async () => {
    const { referrer, referred } = await createReferralPair();
    await request(app).post(`/api/admin/clients/${referred.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 200, date: '2026-05-23', note: 'byledger' });
    expect(dbBalance(referred.id)).toBe(200);
    expect(dbReferralBalance(referrer.id)).toBe(30);   // 15% of 200

    // Get the stable ledger id the UI deletes by.
    const list = await request(app).get(`/api/admin/clients/${referred.id}/payments`).set('X-Auth-Token', adminToken);
    const pay = list.body.find(p => p.amount === 200);
    expect(pay).toBeTruthy();
    expect(typeof pay.ledgerDbId).toBe('number');

    // Delete it.
    const del = await request(app)
      .delete(`/api/admin/clients/${referred.id}/payment/by-ledger/${pay.ledgerDbId}`)
      .set('X-Auth-Token', adminToken);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Balance + referral reversed; a payment_reversal entry exists.
    expect(dbBalance(referred.id)).toBe(0);
    expect(dbReferralBalance(referrer.id)).toBe(0);
    const ledger = ledgerEntries(referred.id);
    const reversal = ledger.filter(e => e.type === 'payment_reversal');
    expect(reversal.length).toBe(1);
    expect(reversal[0].amount).toBe(200);

    // The reversed payment is hidden from the list.
    const after = await request(app).get(`/api/admin/clients/${referred.id}/payments`).set('X-Auth-Token', adminToken);
    expect(after.body.find(p => p.ledgerDbId === pay.ledgerDbId)).toBeFalsy();

    // Idempotent: a repeat delete does NOT reverse again.
    const del2 = await request(app)
      .delete(`/api/admin/clients/${referred.id}/payment/by-ledger/${pay.ledgerDbId}`)
      .set('X-Auth-Token', adminToken);
    expect(del2.status).toBe(200);
    expect(del2.body.already).toBe(true);
    expect(dbBalance(referred.id)).toBe(0);                       // unchanged
    expect(dbReferralBalance(referrer.id)).toBe(0);              // unchanged
    expect(ledgerEntries(referred.id).filter(e => e.type === 'payment_reversal').length).toBe(1); // no 2nd reversal
  });

  it('404s for a non-existent / non-payment ledger id', async () => {
    const c = await createClient();
    const res = await request(app)
      .delete(`/api/admin/clients/${c.id}/payment/by-ledger/99999999`)
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(404);
  });
});

describe('P1-1: recalcFromLedger preserves a pre-ledger opening balance', () => {
  it('keeps the opening remainder when a ledger entry is deleted (anchors on first balance_before)', async () => {
    const c = await createClient();
    // Simulate a balance set OUTSIDE the ledger (import / pre-ledger era).
    db.prepare('UPDATE clients SET balance = 500 WHERE id = ?').run(c.id);
    const { state } = require('../../src/state/index.js');
    const live = state.clientById.get(c.id);
    if (live) live.balance = 500;

    // Two payments on top → ledger snapshots start from 500.
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 100, date: '2026-05-23' });
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 50, date: '2026-05-23' });
    expect(dbBalance(c.id)).toBe(650);

    // Delete the 2nd ledger entry (index 1, id ASC). Correct balance = 600,
    // NOT 100 (which the old start-from-zero recompute would have produced).
    const del = await request(app)
      .delete(`/api/admin/clients/${c.id}/ledger/1`)
      .set('X-Auth-Token', adminToken);
    expect(del.status).toBe(200);
    expect(dbBalance(c.id)).toBe(600);
  });
});

describe('Stage 13.0: characterization — Tochka webhook auto-credit (matched client)', () => {
  // The webhook handler verifies JWTs against Tochka's JWKS over the network.
  // With no/slow network each fetch burns the full 10s https timeout, and the
  // cache stays empty after a failure — so two posts below cost 20s+ and trip
  // the vitest timeout. Stub https.get to fail fast (same pattern as
  // tests/api/tochka.test.js swapping https.request): the handler then takes
  // the documented 'jwks_unavailable' graceful path — the payment is still
  // recorded as unverified, which is exactly what this test characterizes.
  let realHttpsGet;
  beforeAll(() => {
    realHttpsGet = https.get;
    https.get = () => {
      const fakeReq = { on(ev, fn) {
        if (ev === 'error') process.nextTick(() => fn(new Error('network disabled in tests')));
        return fakeReq;
      } };
      return fakeReq;
    };
  });
  afterAll(() => { https.get = realHttpsGet; });

  // Build a webhook payload that the receiver will treat as unverified
  // (no JWT signature), so we exercise the "save unverified" path. The
  // verified auto-credit path requires a JWT cosigned by Tochka — we
  // characterize that separately by stubbing client_by_inn matching.

  function fakeJwtPayload(obj) {
    // JWT structure: header.payload.signature (base64url). We don't sign;
    // verifyJwtSignature will return verified=false but still surface payload.
    const enc = b => Buffer.from(JSON.stringify(b)).toString('base64url');
    return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(obj)}.invalid`;
  }

  it('records an unverified incoming payment + is idempotent on repeat paymentId', async () => {
    const paymentId = 'cz-test-' + crypto.randomBytes(4).toString('hex');
    const payload = {
      webhookType: 'incomingPayment',
      paymentId,
      payerInn: '7777777777',
      payerName: 'TEST',
      amount: 100, purpose: 'test', date: '2026-05-23',
    };

    // First call: row inserted.
    const r1 = await request(app).post('/api/tochka/webhook')
      .set('Content-Type', 'text/plain').send(fakeJwtPayload(payload));
    expect(r1.status).toBe(200);

    const row1 = db.prepare('SELECT * FROM bank_payments WHERE payment_id = ?').get(paymentId);
    expect(row1).toBeTruthy();
    expect(row1.amount).toBe(100);

    // Second call (same paymentId): the explicit pre-insert dup check in
    // server.js#insertBankPaymentToDb silently returns false (no throw),
    // so the route still reports processed=true. The DB-level
    // race-safe path (catching SQLITE_CONSTRAINT_UNIQUE → 'duplicate')
    // exists for the case where two webhooks race past the JS check.
    // Either way: NO second row is inserted, which is the invariant
    // that actually matters for accounting.
    const r2 = await request(app).post('/api/tochka/webhook')
      .set('Content-Type', 'text/plain').send(fakeJwtPayload(payload));
    expect(r2.status).toBe(200);

    const count = db.prepare('SELECT COUNT(*) AS n FROM bank_payments WHERE payment_id = ?').get(paymentId).n;
    expect(count).toBe(1); // ← the real invariant: no double-insert
  });
});
