// GET /api/public/tariffs — публичная витрина тарифов для лендинга.
//   • без авторизации, CORS '*'
//   • retail_enabled=false → enabled:false и пустой список
//   • retail_enabled=true → только public+active, perDay, флаг тест-дня

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApp } from '../_helpers/app.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db;

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
});

function setRetail(on) {
  // PUT /api/admin/settings retail_enabled не принимает (тумблера в UI нет),
  // поэтому как в retail-stage* сьютах: kv_store + in-memory appSettings
  // (стабильная идентичность объекта — мутация видна всем роутерам).
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('app_settings', ?, datetime('now'))")
    .run(JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
}

afterAll(() => {
  setRetail(false);
  try { db.prepare("DELETE FROM tariffs WHERE name LIKE 'pubtest_%'").run(); } catch (_) { /* best-effort */ }
});

describe('GET /api/public/tariffs', () => {
  it('без auth, CORS *, retail выключен → enabled:false, tariffs:[]', async () => {
    setRetail(false);
    const res = await request(app).get('/api/public/tariffs');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toMatchObject({ enabled: false, tariffs: [] });
  });

  it('retail включен → только public+active, perDay и isTestDay корректны', async () => {
    db.prepare("INSERT INTO tariffs (name, type, geo, server, price, public, is_default, active, sort) VALUES ('pubtest_pub', 'per_modem', 'MD', 'S1', 4500, 1, 0, 1, 0)").run();
    db.prepare("INSERT INTO tariffs (name, type, geo, server, price, public, is_default, active, sort) VALUES ('pubtest_hidden', 'per_modem', 'MD', 'S1', 3000, 0, 0, 1, 0)").run();
    db.prepare("INSERT INTO tariffs (name, type, geo, server, price, public, is_default, active, sort, duration_hours) VALUES ('pubtest_test', 'per_modem', 'MD', 'S1', 100, 1, 0, 1, 0, 24)").run();
    setRetail(true);

    const res = await request(app).get('/api/public/tariffs');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    const names = res.body.tariffs.map(t => t.name);
    expect(names).toContain('pubtest_pub');
    expect(names).toContain('pubtest_test');
    expect(names).not.toContain('pubtest_hidden');
    const pub = res.body.tariffs.find(t => t.name === 'pubtest_pub');
    expect(pub).toMatchObject({ price: 4500, perDay: 148.03, isTestDay: false, minProxies: 1 });
    const tst = res.body.tariffs.find(t => t.name === 'pubtest_test');
    expect(tst.isTestDay).toBe(true);
  });
});
