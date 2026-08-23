// C1 (ТЗ мониторинга v2, этап 4, 23.08): SLA/uptime-отчёт за месяц.
//   - serverUptime: эпизоды server_downtime, пересекающие месяц, клиппятся
//     на его границы; maintenance=1 исключён из простоя и числа эпизодов,
//     но виден отдельными колонками;
//   - modemUptime: доля online/total в минутных uptime_daily;
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
    CREATE TABLE uptime_daily (
      key TEXT, date TEXT, online INTEGER, total INTEGER,
      PRIMARY KEY (key, date)
    );
    CREATE TABLE client_uptime_daily (
      key TEXT, date TEXT, client_name TEXT, online INTEGER, total INTEGER,
      PRIMARY KEY (key, date, client_name)
    );
    CREATE TABLE modem_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT, imei TEXT, nick TEXT, operator TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE traffic_hourly (
      server_name TEXT, nick TEXT, client_name TEXT, hour_start TEXT
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

  const meta = db.prepare('INSERT INTO modem_meta (server_name, imei, nick, operator) VALUES (?, ?, ?, ?)');
  meta.run('S1', 'I1', 'M1', 'Moldtelecom');
  meta.run('S1', 'I2', 'M2', 'Orange MD');
  meta.run('S2', 'I3', 'M3', '');

  const uptime = db.prepare('INSERT INTO uptime_daily (key, date, online, total) VALUES (?, ?, ?, ?)');
  uptime.run('S1_I1', '2026-08-15', 8, 10);       // M1: 80%
  uptime.run('S1_I2', '2026-08-15', 2, 4);        // M2: 50%
  uptime.run('S2_I3', '2026-08-15', 3, 3);        // M3: 100%
  uptime.run('S1_I1', '2026-07-20', 0, 1);        // вне месяца

  db.prepare('INSERT INTO client_uptime_daily (key, date, client_name, online, total) VALUES (?, ?, ?, ?, ?)')
    .run('S1_I1', '2026-08-15', 'client-a', 8, 10);
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

  it('modemUptime: единые периодические проверки + оператор из modem_meta', () => {
    const rows = sla.modemUptime(db, MONTH);
    const m1 = rows.find(r => r.nick === 'M1');
    expect(m1.checks).toBe(10);
    expect(m1.online_checks).toBe(8);
    expect(m1.uptime_pct).toBe(80);
    expect(m1.operator).toBe('Moldtelecom');
    const m2 = rows.find(r => r.nick === 'M2');
    expect(m2.uptime_pct).toBe(50);
    expect(m2.operator).toBe('Orange MD');
    const m3 = rows.find(r => r.nick === 'M3');
    expect(m3.uptime_pct).toBe(100);
    expect(m3.operator).toBe('');
  });

  it('client report считает офлайн-проверки, а не только сохранённые пинги', () => {
    const report = sla.buildClientReport(db, MONTH, 'client-a');
    expect(report.summary).toMatchObject({ checks: 10, online_checks: 8, failed_checks: 2, uptime_pct: 80 });
    expect(report.modems[0]).toMatchObject({ nick: 'M1', checks: 10, failed_checks: 2, uptime_pct: 80 });
  });

  it('legacy-привязка не дублирует день после появления прямых клиентских тиков', () => {
    db.prepare('INSERT INTO uptime_daily (key, date, online, total) VALUES (?, ?, ?, ?)')
      .run('S1_I2', '2026-08-16', 1, 2);
    db.prepare('INSERT INTO traffic_hourly (server_name, nick, client_name, hour_start) VALUES (?, ?, ?, ?)')
      .run('S1', 'M2', 'client-b', '2026-08-15T22:00:00.000Z'); // 16.08 MSK

    expect(sla.buildClientReport(db, MONTH, 'client-b').summary)
      .toMatchObject({ checks: 2, online_checks: 1, uptime_pct: 50 });

    db.prepare('INSERT INTO client_uptime_daily (key, date, client_name, online, total) VALUES (?, ?, ?, ?, ?)')
      .run('S1_I2', '2026-08-16', 'client-a', 1, 2);
    expect(sla.buildClientReport(db, MONTH, 'client-b').summary)
      .toMatchObject({ checks: 0, online_checks: 0, uptime_pct: null });
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
    expect(csv).toContain('type;target;operator;uptime_pct;episodes;downtime_min;checks');
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
