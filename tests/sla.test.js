// C1 (ТЗ мониторинга v2, этап 4, 23.08): SLA/uptime-отчёт за месяц.
//   - serverUptime: эпизоды server_downtime, пересекающие месяц, клиппятся
//     на его границы; maintenance=1 исключён из простоя и числа эпизодов,
//     но виден отдельными колонками;
//   - modemUptime: доля ok=1 в modem_ping, оператор из modem_meta;
//   - operatorUptime: средний uptime модемов оператора (без оператора — мимо);
//   - toCsv: BOM + разделитель ';' (Excel RU);
//   - GET /api/admin/sla_report: валидация month, JSON и CSV.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sla = require('../src/sla.js');

// Август 2026: 31 день = 44640 минут.
const MONTH = '2026-08';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_downtime (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT NOT NULL, down_from TEXT NOT NULL, down_to TEXT NOT NULL,
      maintenance INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE modem_ping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server TEXT, nick TEXT, ok INTEGER, ts TEXT
    );
    CREATE TABLE modem_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT, nick TEXT, operator TEXT
    );
  `);
  return db;
}

function seed(db) {
  const ep = db.prepare('INSERT INTO server_downtime (server_name, down_from, down_to, maintenance) VALUES (?, ?, ?, ?)');
  ep.run('S1', '2026-08-10T10:00:00.000Z', '2026-08-10T11:00:00.000Z', 0);   // 60 мин внутри месяца
  ep.run('S1', '2026-07-31T23:00:00.000Z', '2026-08-01T01:00:00.000Z', 0);   // кросс начало → клип 60 мин
  ep.run('S1', '2026-08-12T00:00:00.000Z', '2026-08-12T02:00:00.000Z', 1);   // maintenance → 120 мин отдельно
  ep.run('S1', '2026-08-31T23:00:00.000Z', '2026-09-01T01:00:00.000Z', 0);   // кросс конец → клип 60 мин
  ep.run('S1', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', 0);   // вне месяца — не попадает
  ep.run('S2', '2026-08-05T00:00:00.000Z', '2026-08-05T00:30:00.000Z', 0);   // другой сервер, 30 мин

  const ping = db.prepare('INSERT INTO modem_ping (server, nick, ok, ts) VALUES (?, ?, ?, ?)');
  const aug = h => `2026-08-15T${String(h).padStart(2, '0')}:00:00.000Z`;
  for (let i = 0; i < 10; i++) ping.run('S1', 'M1', i < 8 ? 1 : 0, aug(i));        // M1: 8/10
  for (let i = 0; i < 4; i++) ping.run('S1', 'M2', i < 2 ? 1 : 0, aug(i));         // M2: 2/4
  for (let i = 0; i < 3; i++) ping.run('S2', 'M3', 1, aug(i));                     // M3: 3/3, без meta
  ping.run('S1', 'M1', 0, '2026-07-20T00:00:00.000Z');                             // вне месяца — не считается

  const meta = db.prepare('INSERT INTO modem_meta (server_name, nick, operator) VALUES (?, ?, ?)');
  meta.run('S1', 'M1', 'Moldtelecom');
  meta.run('S1', 'M2', 'Orange MD');
  meta.run('S1', 'M2', '   ');   // пустой оператор не должен перебивать непустого (MAX по NULLIF)
}

describe('C1: sla.js — расчёт', () => {
  let db;
  beforeAll(() => { db = freshDb(); seed(db); });
  afterAll(() => db.close());

  it('monthBounds: границы UTC и валидация', () => {
    const b = sla.monthBounds(MONTH);
    expect(b.minutes).toBe(44640);
    expect(b.fromIso).toBe('2026-08-01T00:00:00.000Z');
    expect(b.toIso).toBe('2026-09-01T00:00:00.000Z');
    expect(() => sla.monthBounds('2026-13')).toThrow();
    expect(() => sla.monthBounds('junk')).toThrow();
  });

  it('serverUptime: клиппинг на границы месяца, maintenance отдельно', () => {
    const rows = sla.serverUptime(db, MONTH);
    const s1 = rows.find(r => r.server === 'S1');
    expect(s1.episodes).toBe(3);                  // maintenance-эпизод не считается
    expect(s1.downtime_min).toBe(180);            // 60 + 60 (клип) + 60 (клип)
    expect(s1.maintenance_episodes).toBe(1);
    expect(s1.maintenance_min).toBe(120);
    expect(s1.uptime_pct).toBe(99.6);             // 1 − 180/44640
    const s2 = rows.find(r => r.server === 'S2');
    expect(s2.downtime_min).toBe(30);
  });

  it('modemUptime: доля ok-пингов + оператор из modem_meta', () => {
    const rows = sla.modemUptime(db, MONTH);
    const m1 = rows.find(r => r.nick === 'M1');
    expect(m1.pings).toBe(10);
    expect(m1.ok_pings).toBe(8);
    expect(m1.uptime_pct).toBe(80);
    expect(m1.operator).toBe('Moldtelecom');
    const m2 = rows.find(r => r.nick === 'M2');
    expect(m2.uptime_pct).toBe(50);
    expect(m2.operator).toBe('Orange MD');
    const m3 = rows.find(r => r.nick === 'M3');
    expect(m3.uptime_pct).toBe(100);
    expect(m3.operator).toBe('');
  });

  it('operatorUptime: средний uptime модемов, модемы без оператора мимо', () => {
    const ops = sla.operatorUptime(sla.modemUptime(db, MONTH));
    expect(ops).toHaveLength(2);
    expect(ops.find(o => o.operator === 'Moldtelecom')).toMatchObject({ modems: 1, uptime_pct: 80 });
    expect(ops.find(o => o.operator === 'Orange MD')).toMatchObject({ modems: 1, uptime_pct: 50 });
  });

  it('buildReport + toCsv: структура, BOM и разделитель «;»', () => {
    const rep = sla.buildReport(db, MONTH);
    expect(rep.month).toBe(MONTH);
    expect(rep.minutes_in_month).toBe(44640);
    expect(rep.servers.length).toBe(2);
    expect(rep.modems.length).toBe(3);
    expect(rep.operators.length).toBe(2);
    const csv = sla.toCsv(rep);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv).toContain('type;target;operator;uptime_pct;episodes;downtime_min;pings');
    expect(csv).toContain('server;S1;;99.6;3;180;');
    expect(csv).toContain('modem;S1/M1;Moldtelecom;80;;;10');
    expect(csv).toContain('operator;Moldtelecom;;80;;;1');
  });
});

describe('C1: API /api/admin/sla_report', () => {
  let app, token;
  beforeAll(() => {
    const b = bootApp();
    app = b.app;
    token = asAdmin('sla_admin');
  });

  it('JSON-отчёт за месяц', async () => {
    const r = await request(app)
      .get('/api/admin/sla_report?month=' + MONTH)
      .set('X-Auth-Token', token);
    expect(r.status).toBe(200);
    expect(r.body.month).toBe(MONTH);
    expect(Array.isArray(r.body.servers)).toBe(true);
    expect(Array.isArray(r.body.modems)).toBe(true);
    expect(Array.isArray(r.body.operators)).toBe(true);
  });

  it('CSV-формат: text/csv + Content-Disposition + BOM', async () => {
    const r = await request(app)
      .get('/api/admin/sla_report?month=' + MONTH + '&format=csv')
      .set('X-Auth-Token', token);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('sla-' + MONTH + '.csv');
    expect(r.text.charCodeAt(0)).toBe(0xFEFF);
  });

  it('невалидный month → 400', async () => {
    const r = await request(app)
      .get('/api/admin/sla_report?month=2026-13')
      .set('X-Auth-Token', token);
    expect(r.status).toBe(400);
    const r2 = await request(app)
      .get('/api/admin/sla_report')
      .set('X-Auth-Token', token);
    expect(r2.status).toBe(400);
  });

  it('без токена → 401', async () => {
    const r = await request(app).get('/api/admin/sla_report?month=' + MONTH);
    expect(r.status).toBe(401);
  });
});
