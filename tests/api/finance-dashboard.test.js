// P2-2 characterization: locks the finance routes' contract while COST_CATEGORIES
// moves out of server.js into src/billing/cost-categories.js and the dead cache
// is removed from server.js. The compute logic in billing-ext.js is untouched —
// these assertions prove the response shape (and the relocated categories) survive.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';

let app, adminToken;
beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  adminToken = asAdmin();
});

describe('P2-2: finance routes contract', () => {
  it('GET /api/admin/monthly_costs surfaces the relocated COST_CATEGORIES', async () => {
    const res = await request(app)
      .get('/api/admin/monthly_costs?period=2026-05')
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.categories).toBeTruthy();
    // The exact category set from src/billing/cost-categories.js.
    expect(Object.keys(res.body.categories).sort()).toEqual(
      ['electricity', 'hosting', 'other', 'salary', 'server', 'sim'].sort()
    );
    // v2.10.36: площадочные расходы привязаны к локации (адресу), не к серверу.
    expect(res.body.categories.server).toMatchObject({ perItem: true, itemType: 'location' });
  });

  it('GET /api/admin/finance_dashboard returns the metrics payload', async () => {
    const res = await request(app)
      .get('/api/admin/finance_dashboard')
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('period');
    expect(res.body).toHaveProperty('summary');
    expect(typeof res.body.summary).toBe('object');
    // A9: явные алиасы «факт vs ожидание» — обратимо-совместимые дубли legacy-полей.
    expect(res.body.summary.revenue_30d_fact).toBe(res.body.summary.mrr);
    expect(res.body.summary.run_rate_eom).toBe(res.body.summary.forecast_eom);
  });
});

describe('2026-07-30: paused client must not count in MRR', () => {
  it('billingPaused=1 → mrr 0 in current window, excluded from totals', async () => {
    const { db } = bootApp();
    // Create a real client through the API so the in-memory roster sees it.
    const create = await request(app)
      .post('/api/admin/clients')
      .set('X-Auth-Token', adminToken)
      .send({ name: 'PausedT', portName: 'PAUSED_T', login: 'paused_t', password: 'x123456789ab', billingType: 'per_gb', price: 100 });
    expect(create.status).toBe(200);
    const cid = create.body.client.id;
    try {
      // Factual trailing revenue inside the current 30d window.
      const today = new Date().toISOString().slice(0, 10);
      db.prepare("INSERT INTO billing_ledger (client_id, type, amount, date, balance_before, balance_after) VALUES (?,?,?,?,?,?)")
        .run(cid, 'charge', 3000, today, 0, -3000);
      // Pause the client.
      const put = await request(app)
        .put('/api/admin/clients/' + cid)
        .set('X-Auth-Token', adminToken)
        .send({ billingPaused: true });
      expect(put.status).toBe(200);
      // ?period= busts the 60s finance cache from the contract test above.
      const res = await request(app)
        .get('/api/admin/finance_dashboard?period=2026-06')
        .set('X-Auth-Token', adminToken);
      expect(res.status).toBe(200);
      const row = (res.body.per_client || []).find(p => p.id === cid);
      expect(row).toBeTruthy();
      expect(row.paused).toBe(true);
      expect(row.mrr).toBe(0);            // paused → 0 in current MRR
      // In the test DB this client is the ONLY revenue source: if the pause
      // were ignored, headline MRR and revenue_30d would be 3000.
      expect(res.body.summary.mrr).toBe(0);
      expect(res.body.metrics.revenue_30d).toBe(0);
      expect(res.body.summary.forecast_so_far).toBe(0);
    } finally {
      db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(cid);
      db.prepare('DELETE FROM clients WHERE id = ?').run(cid);
      // keep in-memory roster consistent for later suites
      await request(app).delete('/api/admin/clients/' + cid).set('X-Auth-Token', adminToken);
    }
  });
});
