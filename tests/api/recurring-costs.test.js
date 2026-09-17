// Плановые (повторяющиеся) расходы — recurring_costs (замена неявного
// «шаблона из последнего заполненного месяца»):
//   1. CRUD правил + валидация (overlap диапазонов, currency, end<start);
//   2. effective = правила + разовые строки; разовая строка перекрывает
//      правило только в своём месяце (source 'override' vs 'rule');
//   3. POST monthly_costs НИКОГДА не меняет правила;
//   4. DELETE: будущее правило удаляется физически, действующее —
//      закрывается концом текущего месяца;
//   5. finance_dashboard: summary.cost_source ('recurring' → 'entered').
// Харнес общий (tests/_helpers/app.js); свои строки помечаем subkey 'RC-*'
// и чистим в afterAll (бэкфилл-миграция на чужих фикстурах не мешает).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApp, asAdmin } from '../_helpers/app.js';

const CUR = new Date().toISOString().slice(0, 7);

let app, db, adminToken;
const createdRuleIds = [];

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin('rc_admin');
});

afterAll(() => {
  db.prepare(`DELETE FROM monthly_costs WHERE period IN ('2025-03','2025-06')`).run();
  for (const id of createdRuleIds) {
    db.prepare('DELETE FROM recurring_costs WHERE id = ?').run(id);
  }
  db.prepare(`DELETE FROM recurring_costs WHERE subkey LIKE 'RC-%'`).run();
  db.prepare("DELETE FROM sessions WHERE login = 'rc_admin'").run();
});

async function postRule(body) {
  const res = await request(app)
    .post('/api/admin/recurring_costs')
    .set('X-Auth-Token', adminToken)
    .send(body);
  if (res.status === 200 && res.body.rule) createdRuleIds.push(res.body.rule.id);
  return res;
}

describe('recurring_costs: CRUD и валидация', () => {
  it('create → видно в GET monthly_costs (recurring.all), PUT меняет amount', async () => {
    const post = await postRule({ category: 'hosting', subkey: 'RC-HALL', amount: 300, currency: 'RUB', start_period: '2025-05' });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);
    const id = post.body.rule.id;
    expect(id).toBeGreaterThan(0);

    const get = await request(app)
      .get('/api/admin/monthly_costs?period=2025-05')
      .set('X-Auth-Token', adminToken);
    expect(get.status).toBe(200);
    const listed = (get.body.recurring.all || []).find(r => r.id === id);
    expect(listed).toMatchObject({ category: 'hosting', subkey: 'RC-HALL', amount: 300, start_period: '2025-05', end_period: null });
    // Правило активно в своём диапазоне
    const active = (get.body.recurring.active || []).find(r => r.rule_id === id || r.id === id);
    expect(active).toBeTruthy();

    const put = await request(app)
      .put('/api/admin/recurring_costs/' + id)
      .set('X-Auth-Token', adminToken)
      .send({ category: 'hosting', subkey: 'RC-HALL', amount: 750, currency: 'RUB', start_period: '2025-05' });
    expect(put.status).toBe(200);
    expect(put.body.rule.amount).toBe(750);
  });

  it('PUT несуществующего id → 404', async () => {
    const res = await request(app)
      .put('/api/admin/recurring_costs/999999')
      .set('X-Auth-Token', adminToken)
      .send({ category: 'other', amount: 100, start_period: '2025-05' });
    expect(res.status).toBe(404);
  });

  it('overlap диапазонов одного category+subkey → 400', async () => {
    // RC-HALL занят с 2025-05 бессрочно (создан выше).
    const res = await postRule({ category: 'hosting', subkey: 'RC-HALL', amount: 100, start_period: '2025-06' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/пересекается/);
    // Несмежный subkey — можно.
    const ok = await postRule({ category: 'hosting', subkey: 'RC-HALL-2', amount: 100, start_period: '2025-06' });
    expect(ok.status).toBe(200);
  });

  it('невалидная currency → 400', async () => {
    const res = await postRule({ category: 'other', amount: 100, currency: 'USD', start_period: '2025-05' });
    expect(res.status).toBe(400);
  });

  it('end_period < start_period → 400', async () => {
    const res = await postRule({ category: 'other', amount: 100, start_period: '2025-05', end_period: '2025-04' });
    expect(res.status).toBe(400);
  });
});

describe('recurring_costs: effective и override', () => {
  it('разовая строка перекрывает правило только в своём месяце', async () => {
    const post = await postRule({ category: 'server', subkey: 'RC-S1', amount: 500, currency: 'RUB', start_period: '2025-01' });
    expect(post.status).toBe(200);

    const save = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-03', items: [{ category: 'server', subkey: 'RC-S1', amount: 700 }] });
    expect(save.status).toBe(200);

    // Месяц с override: 700, source 'override'
    const g3 = await request(app).get('/api/admin/monthly_costs?period=2025-03').set('X-Auth-Token', adminToken);
    const eff3 = (g3.body.effective || []).find(e => e.category === 'server' && e.subkey === 'RC-S1');
    expect(eff3).toMatchObject({ amount: 700, source: 'override' });

    // Следующий месяц: снова план 500, source 'rule'
    const g4 = await request(app).get('/api/admin/monthly_costs?period=2025-04').set('X-Auth-Token', adminToken);
    const eff4 = (g4.body.effective || []).find(e => e.category === 'server' && e.subkey === 'RC-S1');
    expect(eff4).toMatchObject({ amount: 500, source: 'rule' });
    expect(g4.body.rows).toEqual([]);

    // До start_period правила нет
    const g0 = await request(app).get('/api/admin/monthly_costs?period=2024-12').set('X-Auth-Token', adminToken);
    const eff0 = (g0.body.effective || []).find(e => e.category === 'server' && e.subkey === 'RC-S1');
    expect(eff0).toBeUndefined();
    const act0 = (g0.body.recurring.active || []).find(r => r.category === 'server' && r.subkey === 'RC-S1');
    expect(act0).toBeUndefined();
  });

  it('POST monthly_costs не меняет правила (снимок recurring.all стабилен)', async () => {
    const before = await request(app).get('/api/admin/monthly_costs?period=2025-03').set('X-Auth-Token', adminToken);
    const snapshotBefore = JSON.stringify(before.body.recurring.all);

    const save = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-03', items: [{ category: 'server', subkey: 'RC-S1', amount: 900 }, { category: 'other', amount: 50 }] });
    expect(save.status).toBe(200);

    const after = await request(app).get('/api/admin/monthly_costs?period=2025-03').set('X-Auth-Token', adminToken);
    expect(JSON.stringify(after.body.recurring.all)).toBe(snapshotBefore);
  });
});

describe('recurring_costs: DELETE = остановить', () => {
  it('правило со start в прошлом закрывается концом текущего месяца', async () => {
    const post = await postRule({ category: 'electricity', subkey: 'RC-OLD', amount: 100, start_period: '2020-01' });
    expect(post.status).toBe(200);
    const id = post.body.rule.id;

    const del = await request(app)
      .delete('/api/admin/recurring_costs/' + id)
      .set('X-Auth-Token', adminToken);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, stopped: true });

    const row = db.prepare('SELECT * FROM recurring_costs WHERE id = ?').get(id);
    expect(row).toBeTruthy(); // не удалено физически
    expect(row.end_period).toBe(CUR);

    // Для будущего периода правило уже не активно
    const g = await request(app).get('/api/admin/monthly_costs?period=2099-01').set('X-Auth-Token', adminToken);
    const act = (g.body.recurring.active || []).find(r => r.category === 'electricity' && r.subkey === 'RC-OLD');
    expect(act).toBeUndefined();
  });

  it('правило со start в будущем удаляется физически', async () => {
    const post = await postRule({ category: 'salary', subkey: 'RC-FUT', amount: 100, start_period: '2099-01' });
    expect(post.status).toBe(200);
    const id = post.body.rule.id;

    const del = await request(app)
      .delete('/api/admin/recurring_costs/' + id)
      .set('X-Auth-Token', adminToken);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ ok: true, deleted: true });

    const row = db.prepare('SELECT * FROM recurring_costs WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });
});

describe('recurring_costs: finance_dashboard cost_source', () => {
  it('только правило → recurring; после POST monthly_costs → entered', async () => {
    const post = await postRule({ category: 'other', amount: 800, currency: 'RUB', start_period: '2025-06', end_period: '2025-06' });
    expect(post.status).toBe(200);

    const d1 = await request(app)
      .get('/api/admin/finance_dashboard?period=2025-06')
      .set('X-Auth-Token', adminToken);
    expect(d1.status).toBe(200);
    expect(d1.body.summary.cost_source).toBe('recurring');
    expect(d1.body.summary.cost_carried_from).toBeUndefined();
    // Своя статья учтена в затратах (в total_cost могут входить и другие
    // правила этого файла, активные в 2025-06 — проверяем свою категорию).
    expect(d1.body.cost_by_category.other).toBe(800);

    const save = await request(app)
      .post('/api/admin/monthly_costs')
      .set('X-Auth-Token', adminToken)
      .send({ period: '2025-06', items: [{ category: 'other', amount: 100 }] });
    expect(save.status).toBe(200);

    const d2 = await request(app)
      .get('/api/admin/finance_dashboard?period=2025-06')
      .set('X-Auth-Token', adminToken);
    expect(d2.status).toBe(200);
    expect(d2.body.summary.cost_source).toBe('entered');
    expect(d2.body.cost_by_category.other).toBe(100);
  });
});
