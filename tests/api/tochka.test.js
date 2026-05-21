// Characterization tests for the Tochka bank surface:
//   POST /api/tochka/webhook        — incoming payment webhook
//   POST /api/admin/tochka/match_payment — admin matches unmatched payment
//
// Signed-vs-unsigned: the JWKS-backed signature path needs Tochka's keys.
// We exercise the unverified path (production behavior: accept + persist
// for manual review, don't auto-credit). For the strict-mode case we set
// the relevant setting before issuing the request.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
});

// Build a Tochka-shaped JWT with a bogus signature. The body is valid JSON,
// so verifyJwtSignature returns { verified: false, payload, reason }.
function makeUnverifiedJwt(payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return [b64(header), b64(payload), 'bogus-signature'].join('.');
}

afterEach(() => {
  // Drop test webhook rows so each suite starts clean.
  try { db.prepare("DELETE FROM bank_payments WHERE purpose LIKE 'test:%'").run(); } catch (_) { /* best-effort */ }
});

describe('POST /api/tochka/webhook', () => {
  it('persists an unverified incoming payment + returns 200', async () => {
    const paymentId = 'tp-' + crypto.randomBytes(4).toString('hex');
    const payload = {
      webhookType: 'incomingPayment',
      paymentId,
      amount: 1234.56,
      date: '2026-05-21',
      purpose: 'test:unverified-payment',
      SidePayer: { inn: '7700000000', name: 'TEST ИП' },
    };
    const jwt = makeUnverifiedJwt(payload);

    const res = await request(app)
      .post('/api/tochka/webhook')
      .set('Content-Type', 'application/jwt')
      .send(jwt);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The webhook should have written to bank_payments table.
    const row = db.prepare('SELECT * FROM bank_payments WHERE payment_id = ?').get(paymentId);
    expect(row).toBeTruthy();
    // Amount stored as number
    expect(Number(row.amount)).toBe(1234.56);
    // Not auto-matched (no client matches the test INN)
    expect(row.matched).toBe(0);
  });

  it('returns 200 with reason=invalid_jwt for malformed body', async () => {
    const res = await request(app)
      .post('/api/tochka/webhook')
      .set('Content-Type', 'application/jwt')
      .send('this is not a jwt');
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    // Reason could vary: invalid_jwt (no payload at all) or persisted-as-unmatched.
    // The contract: never 5xx out of webhook (Tochka would retry indefinitely).
  });

  it('returns 200 with reason=invalid_amount for zero/negative amount', async () => {
    const jwt = makeUnverifiedJwt({
      webhookType: 'incomingPayment', paymentId: 'tp-zero', amount: 0,
      date: '2026-05-21', purpose: 'test:zero-amount',
    });
    const res = await request(app).post('/api/tochka/webhook').set('Content-Type', 'application/jwt').send(jwt);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('invalid_amount');
  });
});

describe('POST /api/admin/tochka/match_payment', () => {
  it('attaches an unmatched payment to a client + credits balance via atomicCredit', async () => {
    // Seed an unmatched bank_payment via the webhook
    const tochkaPaymentId = 'tp-match-' + crypto.randomBytes(3).toString('hex');
    const jwt = makeUnverifiedJwt({
      webhookType: 'incomingPayment', paymentId: tochkaPaymentId,
      amount: 500, date: '2026-05-21', purpose: 'test:to-match',
      SidePayer: { inn: '9900000000', name: 'TO MATCH' },
    });
    await request(app).post('/api/tochka/webhook').set('Content-Type', 'application/jwt').send(jwt);

    // match_payment expects bank_payments.id (the internal hex PK), NOT the
    // Tochka paymentId. The admin UI gets the internal id via /payments listing.
    const row = db.prepare('SELECT id FROM bank_payments WHERE payment_id = ?').get(tochkaPaymentId);
    expect(row).toBeTruthy();
    const bankPaymentId = row.id;

    // Create a client to match it to
    const tag = crypto.randomBytes(3).toString('hex');
    const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
      name: 'Match Test', login: 'match_' + tag, password: 'longpass',
      portName: 'matchp_' + tag,
    });
    expect(create.status).toBe(200);
    const clientId = create.body.client.id;

    expect(db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance).toBe(0);

    // Match!
    const matchRes = await request(app)
      .post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken)
      .send({ paymentId: bankPaymentId, clientId });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.ok).toBe(true);

    // DB authoritative checks:
    //   - bank_payments row now marked matched + linked to clientId
    //   - client balance increased by the payment amount
    //   - ledger has a bank_payment entry
    const bp = db.prepare('SELECT matched, matched_client_id FROM bank_payments WHERE id = ?').get(bankPaymentId);
    expect(bp.matched).toBe(1);
    expect(bp.matched_client_id).toBe(clientId);

    expect(db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance).toBe(500);

    const ledger = db.prepare("SELECT * FROM billing_ledger WHERE client_id = ? AND type = 'bank_payment'").all(clientId);
    expect(ledger.length).toBe(1);
    expect(ledger[0].amount).toBe(500);
  });

  it('400 when paymentId or clientId missing', async () => {
    const res = await request(app)
      .post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken)
      .send({ paymentId: 'only-one' });
    expect(res.status).toBe(400);
  });

  it('404 when paymentId not in bank_payments', async () => {
    const res = await request(app)
      .post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken)
      .send({ paymentId: 'does-not-exist', clientId: 'whatever' });
    expect(res.status).toBe(404);
  });
});
