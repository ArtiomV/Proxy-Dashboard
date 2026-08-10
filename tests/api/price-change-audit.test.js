// B1 (Р14): журнал смены цены. PUT /api/admin/clients/:id с новой ценой пишет
// audit_log (action=price_change: кто/старая/новая) + system_log; db_audit
// ловит сам UPDATE clients.price триггером (миграция 056). Без смены цены —
// записей нет.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, db, adminToken;

beforeAll(() => {
  ({ app, db } = bootApp());
  adminToken = asAdmin();
});

async function createClient(overrides = {}) {
  const tag = crypto.randomBytes(3).toString('hex');
  const res = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'PriceAudit ' + tag,
    login: 'priceaudit_' + tag,
    password: 'pw_' + tag,
    portName: 'priceauditport_' + tag,
    billingType: 'per_gb',
    price: 250,
    currency: 'RUB',
    ...overrides,
  });
  expect(res.status).toBe(200);
  return res.body.client;
}

const auditRows = (clientId) =>
  db.prepare("SELECT * FROM audit_log WHERE action = 'price_change' AND details LIKE ?").all(`%${clientId}%`);

describe('PUT /api/admin/clients/:id — журнал смены цены (B1)', () => {
  it('смена цены → запись в audit_log с old/new', async () => {
    const c = await createClient({ price: 250 });
    const res = await request(app).put(`/api/admin/clients/${c.id}`)
      .set('X-Auth-Token', adminToken)
      .send({ price: 220 });
    expect(res.status).toBe(200);

    const rows = auditRows(c.id);
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details);
    expect(details.oldPrice).toBe(250);
    expect(details.newPrice).toBe(220);
    expect(details.clientId).toBe(c.id);
    expect(rows[0].admin).toBe('test_admin');

    // И в system_log — операционный след.
    const slog = db.prepare("SELECT * FROM system_log WHERE action = 'price_change' AND target = ?").all(c.name);
    expect(slog.length).toBe(1);

    // И db_audit триггером (UPDATE clients.price) — покрытие любого пути записи.
    const dba = db.prepare("SELECT * FROM db_audit WHERE table_name = 'clients.price' AND row_id = ?").all(c.id);
    expect(dba.length).toBe(1);
    expect(JSON.parse(dba[0].old_values).price).toBe(250);
    expect(JSON.parse(dba[0].new_values).price).toBe(220);
  });

  it('тот же PUT без смены цены — журнал не пишется', async () => {
    const c = await createClient({ price: 300 });
    const res = await request(app).put(`/api/admin/clients/${c.id}`)
      .set('X-Auth-Token', adminToken)
      .send({ price: 300, notes: 'просто правка' });
    expect(res.status).toBe(200);
    expect(auditRows(c.id).length).toBe(0);
    const dba = db.prepare("SELECT * FROM db_audit WHERE table_name = 'clients.price' AND row_id = ?").all(c.id);
    expect(dba.length).toBe(0);
  });
});
