// v2.10.8: валюты затрат MDL/RON (курс ЦБ + ручной фикс) и SIM qty×цена.
//   - POST/GET /api/admin/monthly_costs: currency/qty round-trip, старые
//     строки без currency читаются как RUB;
//   - невалидная currency → 400;
//   - src/services/fx: getRates/toRub по override-настройкам fx_rate_mdl/ron;
//     при заданных обоих override fetch к ЦБ НЕ выполняется (fetch подменён
//     на кидающий стаб);
//   - finance_dashboard конвертирует MDL-затрату в RUB по override-курсу.
// Харнес общий (tests/_helpers/app.js); свои строки и настройки чистим.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');
const fx = require('../../src/services/fx.js');

const PERIODS = ['2025-01', '2025-02', '2025-03'];

let app, db, adminToken;
let _origFetch;

function setFxOverrides(mdl, ron) {
  stateMod.state.appSettings.fx_rate_mdl = mdl;
  stateMod.state.appSettings.fx_rate_ron = ron;
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin('fx_admin');
  // Страховка: любой сетевой вызов из fx в тестах — падение теста.
  _origFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden in cost-currency tests'); };
});

afterAll(() => {
  globalThis.fetch = _origFetch;
  setFxOverrides(0, 0);
  db.prepare(`DELETE FROM monthly_costs WHERE period IN ('2025-01','2025-02','2025-03')`).run();
  db.prepare("DELETE FROM sessions WHERE login = 'fx_admin'").run();
});

describe('v2.10.8: monthly_costs currency/qty', () => {
  it('POST/GET round-trip: currency и qty сохраняются, дефолт RUB', async () => {
    const post = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-01', items: [
        { category: 'server', subkey: 'S1', amount: 500, currency: 'MDL' },
        { category: 'sim', subkey: 'Moldcell', amount: 100, currency: 'MDL', qty: 25 },
        { category: 'other', amount: 300 }, // currency опущена → RUB
      ] });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);

    const get = await request(app)
      .get('/api/admin/monthly_costs?period=2025-01')
      .set('X-Auth-Token', adminToken);
    expect(get.status).toBe(200);
    const sim = get.body.rows.find(r => r.category === 'sim' && r.subkey === 'Moldcell');
    expect(sim).toMatchObject({ amount: 100, currency: 'MDL', qty: 25 });
    const srv = get.body.rows.find(r => r.category === 'server' && r.subkey === 'S1');
    expect(srv).toMatchObject({ amount: 500, currency: 'MDL', qty: null });
    const other = get.body.rows.find(r => r.category === 'other');
    expect(other).toMatchObject({ amount: 300, currency: 'RUB', qty: null });
    // Шапка модалки: курс + мета со странами для дефолта валюты.
    expect(get.body.fx).toHaveProperty('rates');
    expect(get.body.fx.rates).toHaveProperty('MDL');
    expect(get.body.fx.rates).toHaveProperty('RON');
    expect(get.body.meta).toHaveProperty('serverCountry');
    expect(get.body.meta).toHaveProperty('operatorCountry');
    expect(get.body.fx_overrides).toEqual({ MDL: 0, RON: 0 });
  });

  it('template из прошлого месяца несёт currency/qty', async () => {
    const get = await request(app)
      .get('/api/admin/monthly_costs?period=2025-02')
      .set('X-Auth-Token', adminToken);
    expect(get.status).toBe(200);
    expect(get.body.rows).toEqual([]);
    const sim = (get.body.template || []).find(r => r.category === 'sim');
    expect(sim).toMatchObject({ currency: 'MDL', qty: 25 });
  });

  it('невалидная currency → 400', async () => {
    const res = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-02', items: [{ category: 'other', amount: 100, currency: 'USD' }] });
    expect(res.status).toBe(400);
    // Период не перезаписан мусором
    const get = await request(app)
      .get('/api/admin/monthly_costs?period=2025-02')
      .set('X-Auth-Token', adminToken);
    expect(get.body.rows).toEqual([]);
  });
});

describe('v2.10.8: fx-сервис по override-настройкам', () => {
  it('getRates: оба override → source override, fetch к ЦБ не выполняется', async () => {
    setFxOverrides(10, 5);
    const rates = await fx.getRates(); // fetch подменён на кидающий стаб — вызов упал бы
    expect(rates).toMatchObject({ MDL: 10, RON: 5, source: 'override' });
  });

  it('toRub конвертирует по последнему курсу, RUB — как есть', async () => {
    setFxOverrides(10, 5);
    await fx.getRates();
    expect(fx.toRub(100, 'MDL')).toBe(1000);
    expect(fx.toRub(100, 'RON')).toBe(500);
    expect(fx.toRub(100, 'RUB')).toBe(100);
    expect(fx.toRub(100, undefined)).toBe(100); // старые строки без валюты
  });

  it('finance_dashboard конвертирует MDL-затрату в RUB по override-курсу', async () => {
    setFxOverrides(10, 0);
    const post = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-03', items: [
        { category: 'server', subkey: 'S1', amount: 1000, currency: 'MDL' },
        { category: 'salary', amount: 500 }, // RUB
      ] });
    expect(post.status).toBe(200);

    const res = await request(app)
      .get('/api/admin/finance_dashboard?period=2025-03')
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    // 1000 MDL × 10 ₽ + 500 ₽
    expect(res.body.summary.total_cost).toBe(10500);
    expect(res.body.cost_by_category.server).toBe(10000);
    expect(res.body.cost_by_category.salary).toBe(500);
    expect(res.body.fx).toMatchObject({ MDL: 10 });
  });
});
