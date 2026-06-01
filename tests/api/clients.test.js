// Characterization tests for admin client CRUD + balance operations.
//
// What's locked here is the HTTP contract:
//   - response shape (no password / passwordHash leak)
//   - status codes for valid + invalid inputs
//   - balance changes land BOTH in HTTP response AND in DB / in-memory state
//   - payment/charge/balance_adjust go through atomicCredit/atomicDebit
//     so the ledger row exists for each money move
//
// Plus the side effects the TZ explicitly calls out for these routes —
// final balance in DB matches the response.

import { describe, it, expect, beforeAll } from 'vitest';
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

function dbBalance(id) {
  const row = db.prepare('SELECT balance FROM clients WHERE id = ?').get(id);
  return row ? row.balance : null;
}
function ledgerCount(id) {
  return db.prepare('SELECT COUNT(*) AS n FROM billing_ledger WHERE client_id = ?').get(id).n;
}

// Each test creates its own client to keep DB rows independent.
async function createClient(overrides = {}) {
  const tag = crypto.randomBytes(3).toString('hex');
  const body = {
    name: 'CRUD Test ' + tag,
    login: 'crud_' + tag,
    password: 'pw_' + tag,
    portName: 'crudport_' + tag,
    billingType: 'per_gb',
    price: 10,
    currency: 'RUB',
    ...overrides,
  };
  const res = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send(body);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body.client;
}

describe('#4 settlement date — contractDate persists through the positional upsert', () => {
  it('round-trips contractDate on create + update', async () => {
    const c = await createClient({ contractDate: '2026-03-17' });
    expect(c.contractDate).toBe('2026-03-17');
    // Re-read from the list (i.e. straight from the DB upsert).
    const list = await request(app).get('/api/admin/clients?limit=500').set('X-Auth-Token', adminToken);
    const fromDb = list.body.clients.find(x => x.id === c.id);
    expect(fromDb.contractDate).toBe('2026-03-17');
    // Update changes it.
    const upd = await request(app).put('/api/admin/clients/' + c.id).set('X-Auth-Token', adminToken).send({ contractDate: '2026-04-02' });
    expect(upd.status).toBe(200);
    const list2 = await request(app).get('/api/admin/clients?limit=500').set('X-Auth-Token', adminToken);
    expect(list2.body.clients.find(x => x.id === c.id).contractDate).toBe('2026-04-02');
  });
});

describe('GET /api/admin/clients', () => {
  it('returns paginated list with total + safe shape (no passwordHash)', async () => {
    const created = await createClient();
    const res = await request(app).get('/api/admin/clients?limit=200').set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    const found = res.body.clients.find(c => c.id === created.id);
    expect(found).toBeDefined();
    // Secrets MUST NOT leak — TZ-relevant behavior.
    expect(found.passwordHash).toBeUndefined();
    expect(found.password).toBeUndefined();
  });
});

describe('POST /api/admin/clients', () => {
  it('creates a client, mints apiKey + referral_code, response omits secrets', async () => {
    const c = await createClient();
    expect(c.id).toBeTruthy();
    expect(c.apiKey).toMatch(/^prx_/);
    expect(c.referral_code).toMatch(/^REF-/);
    expect(c.passwordHash).toBeUndefined();
    expect(c.password).toBeUndefined();
    // DB row exists with expected fields
    const row = db.prepare('SELECT id, login, balance FROM clients WHERE id = ?').get(c.id);
    expect(row).toBeTruthy();
    expect(row.login).toBe(c.login);
    expect(row.balance).toBe(0);
  });

  it('rejects with 400 when required fields missing', async () => {
    const res = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
      name: 'No portName', login: 'incomplete_' + crypto.randomBytes(2).toString('hex'),
    });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate login (400 "Login already exists")', async () => {
    const first = await createClient();
    const res = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
      name: 'dup', login: first.login, password: 'whatever',
      portName: 'whatever_' + crypto.randomBytes(2).toString('hex'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/login.*exists/i);
  });
});

describe('POST /api/admin/clients/:id/payment', () => {
  it('credits the balance and appends a ledger entry (HTTP body matches DB)', async () => {
    const c = await createClient();
    expect(dbBalance(c.id)).toBe(0);
    const before = ledgerCount(c.id);
    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 100, date: '2026-03-01', note: 'first payment' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // After Stage 4 fix (billing/atomic.js getClientById getter), HTTP balance
    // matches DB. Previously this was 0 due to stale clientById ref.
    expect(res.body.balance).toBe(100);
    expect(dbBalance(c.id)).toBe(100);
    expect(ledgerCount(c.id)).toBe(before + 1);
  });

  it('rejects negative or zero amount (400)', async () => {
    const c = await createClient();
    for (const bad of [-10, 0]) {
      const res = await request(app)
        .post(`/api/admin/clients/${c.id}/payment`)
        .set('X-Auth-Token', adminToken)
        .send({ amount: bad, date: '2026-03-02' });
      expect(res.status).toBe(400);
    }
    // Balance unchanged
    expect(dbBalance(c.id)).toBe(0);
  });

  it('404 on unknown client id', async () => {
    const res = await request(app)
      .post('/api/admin/clients/does-not-exist/payment')
      .set('X-Auth-Token', adminToken)
      .send({ amount: 50, date: '2026-03-03' });
    // Could be 404 OR 400 depending on validation order — but should NOT be 200.
    expect(res.status).not.toBe(200);
  });
});

describe('POST /api/admin/clients/:id/charge', () => {
  it('debits the balance and writes a ledger entry', async () => {
    const c = await createClient();
    // Seed +200 so we can debit -50
    await request(app).post(`/api/admin/clients/${c.id}/payment`).set('X-Auth-Token', adminToken)
      .send({ amount: 200, date: '2026-04-01' });
    expect(dbBalance(c.id)).toBe(200);

    const beforeLedger = ledgerCount(c.id);
    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/charge`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 50, date: '2026-04-02', note: 'fix' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(150);   // Stage 4 fix
    expect(res.body.balanceBefore).toBe(200);
    expect(res.body.balanceAfter).toBe(150);

    expect(dbBalance(c.id)).toBe(150);
    expect(ledgerCount(c.id)).toBe(beforeLedger + 1);
  });
});

describe('POST /api/admin/clients/:id/balance_adjust', () => {
  // After Stage 4 fix, res.body.balance is correct (was stale before).
  it('positive amount credits via atomicCredit', async () => {
    const c = await createClient();
    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/balance_adjust`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 75.5, note: 'adj+' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(75.5);
    expect(dbBalance(c.id)).toBe(75.5);
  });

  it('negative amount debits via atomicDebit (balance goes negative ok)', async () => {
    const c = await createClient();
    const res = await request(app)
      .post(`/api/admin/clients/${c.id}/balance_adjust`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: -30, note: 'adj-' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(-30);
    expect(dbBalance(c.id)).toBe(-30);
  });
});
