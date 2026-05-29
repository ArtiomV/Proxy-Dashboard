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
    expect(res.body.categories.server).toMatchObject({ perItem: true, itemType: 'server' });
  });

  it('GET /api/admin/finance_dashboard returns the metrics payload', async () => {
    const res = await request(app)
      .get('/api/admin/finance_dashboard')
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('period');
    expect(res.body).toHaveProperty('summary');
    expect(typeof res.body.summary).toBe('object');
  });
});
