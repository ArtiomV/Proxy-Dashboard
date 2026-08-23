import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

const PERIOD = '2040-04';
const OPERATOR = 'Bundle Test Mobile';
let app, db, token, previousPackages, previousMdl, previousRon;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  token = asAdmin('operator_cost_admin');
  previousPackages = stateMod.state.appSettings.operator_packages;
  previousMdl = stateMod.state.appSettings.fx_rate_mdl;
  previousRon = stateMod.state.appSettings.fx_rate_ron;
  stateMod.state.appSettings.operator_packages = JSON.stringify([
    { operator: OPERATOR, type: 'shared', volume_gb: 100, max_sims: 2, price: 300, currency: 'RUB' },
  ]);
  stateMod.state.appSettings.fx_rate_mdl = 10;
  stateMod.state.appSettings.fx_rate_ron = 5;
  const add = db.prepare('INSERT INTO modem_meta (server_name, imei, nick, operator, deleted) VALUES (?, ?, ?, ?, ?)');
  add.run('COST_TEST', 'cost-1', 'cost-1', OPERATOR, 0);
  add.run('COST_TEST', 'cost-2', 'cost-2', OPERATOR, 0);
  add.run('COST_TEST', 'cost-3', 'cost-3', OPERATOR, 0);
  add.run('COST_TEST', 'cost-deleted', 'cost-deleted', OPERATOR, 1);
});

afterAll(() => {
  stateMod.state.appSettings.operator_packages = previousPackages;
  stateMod.state.appSettings.fx_rate_mdl = previousMdl;
  stateMod.state.appSettings.fx_rate_ron = previousRon;
  db.prepare('DELETE FROM monthly_costs WHERE period = ?').run(PERIOD);
  db.prepare("DELETE FROM modem_meta WHERE server_name = 'COST_TEST'").run();
  db.prepare("DELETE FROM sessions WHERE login = 'operator_cost_admin'").run();
});

describe('automatic operator-package expenses API', () => {
  it('exposes the live SIM formula in the redesigned costs data', async () => {
    const res = await request(app)
      .get('/api/admin/monthly_costs?period=' + PERIOD)
      .set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    expect(res.body.operator_costs).toContainEqual(expect.objectContaining({
      operator: OPERATOR,
      sim_count: 3,
      max_sims: 2,
      bundle_count: 2,
      price: 300,
      amount: 600,
      total_volume_gb: 200,
      configured: true,
    }));
  });

  it('replaces a matching legacy SIM expense instead of double-counting it', async () => {
    const save = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', token)
      .send({ period: PERIOD, items: [
        { category: 'sim', subkey: OPERATOR, amount: 999, currency: 'RUB', qty: 3 },
      ] });
    expect(save.status).toBe(200);

    const res = await request(app)
      .get('/api/admin/finance_dashboard?period=' + PERIOD)
      .set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    expect(res.body.summary.total_cost).toBe(600);
    expect(res.body.cost_by_category.sim).toBe(600);
    expect(res.body.operator_package_costs.rows).toContainEqual(expect.objectContaining({
      operator: OPERATOR, amount: 600, configured: true,
    }));
  });
});
