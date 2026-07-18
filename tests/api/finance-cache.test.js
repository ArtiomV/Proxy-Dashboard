// WP7.2: a finance-affecting write must invalidate the 60s finance_dashboard
// cache IMMEDIATELY (previously only the monthly-cost endpoint reset it).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken, clientId, clientLogin;

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'fc_' + crypto.randomBytes(3).toString('hex');
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Finance Cache Test', login: clientLogin, password: 'pw_' + crypto.randomBytes(4).toString('hex'),
    portName: 'fc_p_' + crypto.randomBytes(2).toString('hex'), billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + JSON.stringify(create.body));
  clientId = create.body.client.id;
});

afterAll(() => {
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM sessions WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
});

describe('WP7.2: finance cache invalidation via the shared write event', () => {
  it('a charge shows up in finance_dashboard MRR immediately (no 60s staleness)', async () => {
    const r1 = await request(app).get('/api/admin/finance_dashboard').set('X-Auth-Token', adminToken);
    expect(r1.status).toBe(200);
    const mrrBefore = r1.body.summary.mrr;

    const charge = await request(app).post(`/api/admin/clients/${clientId}/charge`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 500, date: new Date().toISOString().slice(0, 10), note: 'cache-invalidation test' });
    expect(charge.status).toBe(200);

    // Immediately re-request — the write event must have dropped the cache.
    const r2 = await request(app).get('/api/admin/finance_dashboard').set('X-Auth-Token', adminToken);
    expect(r2.status).toBe(200);
    expect(r2.body.summary.mrr).toBe(mrrBefore + 500);
  });
});
