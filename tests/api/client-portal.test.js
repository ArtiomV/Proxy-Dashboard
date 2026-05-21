// Characterization tests for the client-facing portal routes:
//   GET /api/dashboard_data    — main client dashboard payload
//   GET /api/billing_history   — ledger entries + summary
//
// In the test environment fetchAllServersDataCached returns an empty array
// (no API_*_URL set), so the proxy-data branches return empty maps. We
// validate the shape + auth requirements rather than the data values.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken, clientLogin, clientToken;
const PASSWORD = 'portal_pass_' + crypto.randomBytes(4).toString('hex');

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'portal_' + crypto.randomBytes(3).toString('hex');
  // Create client through the admin route so users{} is populated.
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Portal Test', login: clientLogin, password: PASSWORD,
    portName: 'portal_p_' + crypto.randomBytes(2).toString('hex'),
    billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + create.status);
  // Login as the client to get a real session
  const login = await request(app).post('/api/login').send({ login: clientLogin, password: PASSWORD });
  if (login.status !== 200) throw new Error('client login failed: ' + login.status);
  clientToken = login.body.token;
});

afterAll(() => {
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) {}
  try { db.prepare('DELETE FROM sessions WHERE login = ?').run(clientLogin); } catch (_) {}
});

describe('GET /api/dashboard_data', () => {
  it('200 + shape with auth (empty data is acceptable, schema is the contract)', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    // The route always returns these top-level keys regardless of whether
    // any modem data is loaded. Asserting their presence locks the shape.
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('ports');
    expect(res.body).toHaveProperty('bandwidth');
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/dashboard_data');
    expect(res.status).toBe(401);
  });

  it('401 with bogus token', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', 'bogus-token');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/billing_history', () => {
  it('200 + summary structure for newly-created client (no entries yet)', async () => {
    const res = await request(app).get('/api/billing_history').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBe(0);
    // Shape: { balance, currency, summary: {…}, entries: [] }
    expect(res.body).toHaveProperty('balance');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalCharges');
    expect(res.body.summary).toHaveProperty('totalPayments');
    expect(typeof res.body.summary.totalCharges).toBe('number');
    expect(typeof res.body.summary.totalPayments).toBe('number');
  });

  it('reflects an admin-recorded payment in summary + entries', async () => {
    // Admin records a payment for this client. NB: due to the stale
    // billingLedger / clientById ref bug (see FOLLOWUP.md), the in-memory
    // billingLedger map IS updated by atomicCredit even though
    // client.balance isn't — so the ledger surface here works correctly.
    const clientRow = db.prepare('SELECT id FROM clients WHERE login = ?').get(clientLogin);
    const pay = await request(app)
      .post(`/api/admin/clients/${clientRow.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 250, date: '2026-05-15', note: 'portal-test' });
    expect(pay.status).toBe(200);

    const res = await request(app).get('/api/billing_history').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalPayments).toBeGreaterThanOrEqual(250);
    const hit = (res.body.entries || []).find(e => e.type === 'payment' && Number(e.amount) === 250);
    expect(hit).toBeDefined();
  });

  it('honors ?month=YYYY-MM filter', async () => {
    const res = await request(app).get('/api/billing_history?month=2099-01').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(0);   // nothing in year 2099
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/billing_history');
    expect(res.status).toBe(401);
  });
});
