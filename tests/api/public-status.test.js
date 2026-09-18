import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const createPublicStatusRouter = require('../../src/routes/public-status.js');

let db, app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE modem_meta (
      server_name TEXT, imei TEXT, nick TEXT, deleted INTEGER DEFAULT 0,
      is_test_pool INTEGER DEFAULT 0
    );
    CREATE TABLE modem_ping (
      id INTEGER PRIMARY KEY, ts TEXT, server TEXT, nick TEXT,
      latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, measured_at TEXT
    );
    CREATE TABLE modem_ping_state (
      server TEXT, nick TEXT, imei TEXT, quality TEXT,
      latency_ms INTEGER, loss_pct INTEGER, ok INTEGER,
      observed_at TEXT, measured_at TEXT, updated_at TEXT,
      PRIMARY KEY (server, nick)
    );
  `);
  db.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S1', 'i1', 'MD_1');
  db.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S2', 'i2', 'RO_1');
  db.prepare('INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'S1', 'MD_1', 120, 0, 1);
  db.prepare('INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'S2', 'RO_1', null, 100, 0);
  // FIX-05/06: текущий статус читается из modem_ping_state
  const st = db.prepare(`INSERT INTO modem_ping_state
    (server, nick, imei, quality, latency_ms, loss_pct, ok, observed_at, measured_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  const nowIso = new Date().toISOString();
  st.run('S1', 'MD_1', 'i1', 'valid', 120, 0, 1, nowIso, nowIso);
  st.run('S2', 'RO_1', 'i2', 'valid', null, 100, 0, nowIso, nowIso);

  app = express();
  app.use(createPublicStatusRouter({
    db,
    apiServers: [{ name: 'S1' }, { name: 'S2' }],
    SERVER_COUNTRIES: { S1: { country: 'MD' }, S2: { country: 'RO' } },
  }));
});

afterAll(() => db.close());

describe('GET /api/public/status', () => {
  it('returns real mobile aggregates and the product-fixed RU component', async () => {
    const res = await request(app).get('/api/public/status');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.source).toBe('mixed');
    const md = res.body.components.find(c => c.id === 'mobile-md');
    const ro = res.body.components.find(c => c.id === 'mobile-ro');
    const ru = res.body.components.find(c => c.id === 'residential-ru');
    expect(md).toMatchObject({ status: 'operational', online: 1, total: 1 });
    expect(ro).toMatchObject({ status: 'major_outage', online: 0, total: 1 });
    expect(ru).toMatchObject({
      status: 'operational', reason: 'product_fixed_100', source: 'product_fixed',
      currentPct: 100, uptime60d: 100,
    });
    expect(ru.days).toHaveLength(60);
    expect(ru.days.every(day => day.uptime === 100)).toBe(true);
    expect(res.body.overall).toBe('major_outage');
  });
});

// FIX-05/06 (2026-09-18): текущий статус — из modem_ping_state с общей
// политикой свежести; пропуски (missing/invalid) считаются отдельно.
describe('GET /api/public/status — качество наблюдений', () => {
  function build(stateRows) {
    const db2 = new Database(':memory:');
    db2.exec(`
      CREATE TABLE modem_meta (server_name TEXT, imei TEXT, nick TEXT, deleted INTEGER DEFAULT 0, is_test_pool INTEGER DEFAULT 0);
      CREATE TABLE modem_ping (id INTEGER PRIMARY KEY, ts TEXT, server TEXT, nick TEXT, latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, measured_at TEXT);
      CREATE TABLE modem_ping_state (server TEXT, nick TEXT, imei TEXT, quality TEXT, latency_ms INTEGER, loss_pct INTEGER, ok INTEGER, observed_at TEXT, measured_at TEXT, updated_at TEXT, PRIMARY KEY (server, nick));
    `);
    db2.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S1', 'i1', 'MD_1');
    db2.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S1', 'i2', 'MD_2');
    const st = db2.prepare(`INSERT INTO modem_ping_state
      (server, nick, imei, quality, latency_ms, loss_pct, ok, observed_at, measured_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`);
    for (const r of stateRows) st.run(r.server || 'S1', r.nick, r.imei || 'i', r.quality, r.ok, r.observed_at, r.observed_at);
    const app2 = express();
    app2.use(createPublicStatusRouter({
      db: db2,
      apiServers: [{ name: 'S1' }],
      SERVER_COUNTRIES: { S1: { country: 'MD' } },
    }));
    return app2;
  }

  it('missing-наблюдение — не онлайн и не падение: пропуск считается отдельно', async () => {
    const now = new Date().toISOString();
    const app2 = build([
      { nick: 'MD_1', quality: 'valid', ok: 1, observed_at: now },
      { nick: 'MD_2', quality: 'missing', ok: null, observed_at: now },
    ]);
    const res = await request(app2).get('/api/public/status');
    const md = res.body.components.find(c => c.id === 'mobile-md');
    expect(md).toMatchObject({ online: 1, total: 2, freshChecks: 1, skippedChecks: 1, status: 'degraded', currentPct: 50 });
  });

  it('все наблюдения недостоверны → «нет данных», а не 0%/100%', async () => {
    const now = new Date().toISOString();
    const app2 = build([
      { nick: 'MD_1', quality: 'missing', ok: null, observed_at: now },
      { nick: 'MD_2', quality: 'invalid', ok: null, observed_at: now },
    ]);
    const res = await request(app2).get('/api/public/status');
    const md = res.body.components.find(c => c.id === 'mobile-md');
    expect(md).toMatchObject({ status: 'unknown', currentPct: null, freshChecks: 0, skippedChecks: 2 });
    expect(res.body.overall).toBe('operational'); // живой остаётся только фиксированный RU
  });

  it('протухшее валидное наблюдение (>TTL) не считается свежим', async () => {
    const old = new Date(Date.now() - 60 * 60000).toISOString();
    const app2 = build([
      { nick: 'MD_1', quality: 'valid', ok: 1, observed_at: old },
      { nick: 'MD_2', quality: 'valid', ok: 0, observed_at: old },
    ]);
    const res = await request(app2).get('/api/public/status');
    const md = res.body.components.find(c => c.id === 'mobile-md');
    expect(md).toMatchObject({ status: 'unknown', currentPct: null, freshChecks: 0 });
  });
});
