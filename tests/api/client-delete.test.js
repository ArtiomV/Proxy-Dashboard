import { it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

// Удаление клиента: строка уходит из clients и из выдачи админки (07.10,
// регрессия «пишет удалено, а эффекта нет»), а финансовая история в
// billing_ledger ПЕРЕЖИВАЕТ удаление (миграция 111 — каскад снят после
// инцидента flint019, где удаление стёрло 10 записей истории).
it('delete client persists; ledger history survives', async () => {
  const ctx = bootApp();
  const app = ctx.app, db = ctx.db;
  const adminToken = asAdmin();
  const login = 'del_' + crypto.randomBytes(3).toString('hex');
  const pass = 'p_' + crypto.randomBytes(3).toString('hex');
  const cr = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken)
    .send({ name: 'Del Test', login, password: pass, portName: 'del_pn_' + crypto.randomBytes(2).toString('hex'), billingType: 'per_gb', price: 10 });
  const id = cr.body.client.id;
  // финансовая запись клиента — должна пережить удаление
  db.prepare("INSERT INTO billing_ledger (client_id, type, date, amount, note) VALUES (?, 'payment', date('now'), 1000, 'test')").run(id);
  const d = await request(app).delete('/api/admin/clients/' + id).set('X-Auth-Token', adminToken);
  expect(d.status).toBe(200);
  expect(d.body.ok).toBe(true);
  const row = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
  expect(row).toBeUndefined();
  const ledgerRows = db.prepare('SELECT id FROM billing_ledger WHERE client_id = ?').all(id);
  expect(ledgerRows.length).toBe(1);   // история НЕ каскадирована
  const list = await request(app).get('/api/admin/data').set('X-Auth-Token', adminToken);
  const still = (list.body.clients || []).some(c => c.id === id);
  expect(still).toBe(false);
  db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
});
