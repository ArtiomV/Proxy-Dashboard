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
      latency_ms INTEGER, loss_pct INTEGER, ok INTEGER
    );
  `);
  db.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S1', 'i1', 'MD_1');
  db.prepare('INSERT INTO modem_meta (server_name, imei, nick) VALUES (?, ?, ?)').run('S2', 'i2', 'RO_1');
  db.prepare('INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'S1', 'MD_1', 120, 0, 1);
  db.prepare('INSERT INTO modem_ping (ts, server, nick, latency_ms, loss_pct, ok) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'S2', 'RO_1', null, 100, 0);

  app = express();
  app.use(createPublicStatusRouter({
    db,
    apiServers: [{ name: 'S1' }, { name: 'S2' }],
    SERVER_COUNTRIES: { S1: { country: 'MD' }, S2: { country: 'RO' } },
  }));
});

afterAll(() => db.close());

describe('GET /api/public/status', () => {
  it('returns real country aggregates and never invents residential uptime', async () => {
    const res = await request(app).get('/api/public/status');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.source).toBe('proxysmart_ping_stats');
    const md = res.body.components.find(c => c.id === 'mobile-md');
    const ro = res.body.components.find(c => c.id === 'mobile-ro');
    const ru = res.body.components.find(c => c.id === 'residential-ru');
    expect(md).toMatchObject({ status: 'operational', online: 1, total: 1 });
    expect(ro).toMatchObject({ status: 'major_outage', online: 0, total: 1 });
    expect(ru).toMatchObject({ status: 'unknown', uptime60d: null });
    expect(res.body.overall).toBe('major_outage');
  });
});
