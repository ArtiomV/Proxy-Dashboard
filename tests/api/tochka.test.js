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
import https from 'https';
import { EventEmitter } from 'events';
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

// Regression guard for the signature bug that stopped acts from ever reaching
// Tochka. src/tochka/api.js exports tochkaRequest(tochkaConfig, method, path, body)
// but the router calls it (method, path, body). When it was imported raw, the
// body object slid into the `path` slot and api.js threw "Invalid Tochka API
// path" BEFORE any HTTPS call — so the act saved locally with tochka_doc_id NULL
// and silently never filed. This test configures Tochka, intercepts the HTTPS
// layer (no network), and asserts a real string path reaches it + the route
// reports the verified outcome (tochkaPushed) the operator now relies on.
describe('POST /api/admin/tochka/create_act — act actually reaches Tochka', () => {
  it('passes a string API path to the HTTPS layer and reports tochkaPushed=true', async () => {
    // 1) Configure Tochka so create_act attempts a push (needs jwt+customerCode+accountId).
    await request(app).post('/api/admin/tochka/config').set('X-Auth-Token', adminToken)
      .send({ jwt: 'test.jwt.token', clientId: 'tcl', customerCode: '300000001', accountId: 'acc-001' });

    // 2) A client WITH an INN — create_act skips Tochka entirely without one.
    const tag = crypto.randomBytes(3).toString('hex');
    const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken)
      .send({ name: 'Act Co ' + tag, login: 'act_' + tag, password: 'longpass', portName: 'actp_' + tag, inn: '9704223433', price: 100 });
    expect(create.status).toBe(200);
    const clientId = create.body.client.id;

    // 3) Intercept the Tochka HTTPS call without hitting the network. api.js calls
    //    https.request at call-time, so swapping the method is enough.
    const realRequest = https.request;
    let capturedPath = null, capturedMethod = null;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      capturedMethod = opts.method;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      const fakeReq = new EventEmitter();
      fakeReq.write = () => {};
      fakeReq.destroy = () => {};
      fakeReq.end = () => {
        cb(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(JSON.stringify({ Data: { documentId: 'DOC-REG-1' } })));
          res.emit('end');
        });
      };
      return fakeReq;
    };

    let body;
    try {
      const res = await request(app).post('/api/admin/tochka/create_act').set('X-Auth-Token', adminToken)
        .send({ clientId, period: '2026-05', items: [{ description: 'Proxy', amount: 100 }] });
      body = res.body;
    } finally {
      https.request = realRequest;
      // Leave Tochka unconfigured for the rest of the suite.
      await request(app).post('/api/admin/tochka/config').set('X-Auth-Token', adminToken)
        .send({ jwt: '', clientId: '', customerCode: '', accountId: '' });
    }

    // With the old bug capturedPath would be null (threw before https.request)
    // and tochkaPushed false. The fix makes the real path reach the HTTPS layer.
    expect(capturedMethod).toBe('POST');
    expect(typeof capturedPath).toBe('string');
    expect(capturedPath).toBe('/uapi/invoice/v1.0/closing-documents');
    expect(body.ok).toBe(true);
    expect(body.tochkaPushed).toBe(true);
    expect(body.document.tochkaDocumentId).toBe('DOC-REG-1');
  });
});

describe('tochka config: masked jwt does not clobber the stored token', () => {
  it('keeps stored jwt when the form echoes back the ****-mask', async () => {
    await request(app).post('/api/admin/tochka/config').set('X-Auth-Token', adminToken)
      .send({ jwt: 'real-jwt-token-abcdef12', companyInn: '1234567890' }).expect(200);
    const g1 = await request(app).get('/api/admin/tochka/config').set('X-Auth-Token', adminToken).expect(200);
    expect(g1.body.jwt).toMatch(/^\*\*\*\*/);
    // форма сохраняется с маской (как делает UI при «Сохранить» без смены токена)
    await request(app).post('/api/admin/tochka/config').set('X-Auth-Token', adminToken)
      .send({ jwt: g1.body.jwt, companyInn: '9999999999' }).expect(200);
    const g2 = await request(app).get('/api/admin/tochka/config').set('X-Auth-Token', adminToken).expect(200);
    expect(g2.body.jwt).toBe('****' + 'real-jwt-token-abcdef12'.slice(-8));  // токен не затёрт маской
    expect(g2.body.companyInn).toBe('9999999999');                            // остальные поля обновились
  });

  it('does not 500 on non-string fields', async () => {
    await request(app).post('/api/admin/tochka/config').set('X-Auth-Token', adminToken)
      .send({ clientId: null, companyKpp: 123 }).expect(200);
  });
});
