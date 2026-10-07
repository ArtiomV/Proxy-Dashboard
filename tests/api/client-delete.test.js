import { it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

it('delete client persists', async () => {
  const ctx = bootApp();
  const app = ctx.app, db = ctx.db;
  const adminToken = asAdmin();
  const login = 'del_' + crypto.randomBytes(3).toString('hex');
  const pass = 'p_' + crypto.randomBytes(3).toString('hex');
  const cr = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken)
    .send({ name: 'Del Test', login, password: pass, portName: 'del_pn_' + crypto.randomBytes(2).toString('hex'), billingType: 'per_gb', price: 10 });
  console.log('create:', cr.status, cr.body && cr.body.client ? cr.body.client.id : JSON.stringify(cr.body).slice(0,200));
  const id = cr.body.client.id;
  const d = await request(app).delete('/api/admin/clients/' + id).set('X-Auth-Token', adminToken);
  console.log('delete:', d.status, JSON.stringify(d.body));
  const row = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
  console.log('in db after delete:', !!row);
  const list = await request(app).get('/api/admin/data').set('X-Auth-Token', adminToken);
  const still = (list.body.clients || []).some(c => c.id === id);
  console.log('in admin list:', still);
  expect(row).toBeUndefined();
});
