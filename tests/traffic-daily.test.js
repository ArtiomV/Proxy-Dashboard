// WP3 (2026-07-26): recordDailyTraffic — единый писатель daily_traffic.
// SQL (MAX-семантика байт + client_name, миграция 052) и in-memory кэш
// обновляются в одной точке. До этого 4 писателя дублировали логику, а
// клиент вычислялся через текущий маппинг портов (переписывал историю).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const trafficDb = require('../src/db/traffic.js');
const daily = require('../src/traffic/daily.js');

let db, cache;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE daily_traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port_name TEXT NOT NULL, date TEXT NOT NULL,
    bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
    client_name TEXT NOT NULL DEFAULT '',
    UNIQUE(port_name, date))`);
  // trafficDb.init готовит стейтменты ко всем четырём таблицам — нужны все
  db.exec(`CREATE TABLE traffic_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT, port_id TEXT, nick TEXT, operator TEXT, client_name TEXT,
    hour_start TEXT, bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
    uncertain INTEGER DEFAULT 0, UNIQUE(port_id, hour_start))`);
  db.exec(`CREATE TABLE hourly_snapshots (
    port_id TEXT PRIMARY KEY,
    day_in INTEGER, day_out INTEGER, month_in INTEGER, month_out INTEGER,
    yesterday_in INTEGER, yesterday_out INTEGER, prev_month_in INTEGER, prev_month_out INTEGER,
    day_at_last_hour_start_in INTEGER, day_at_last_hour_start_out INTEGER,
    mon_at_last_hour_start_in INTEGER, mon_at_last_hour_start_out INTEGER,
    pending INTEGER, captured_at TEXT, last_updated_at TEXT)`);
  db.exec(`CREATE TABLE api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT, client_name TEXT, api_key_prefix TEXT, endpoint TEXT, method TEXT,
    status_code INTEGER, response_time_ms INTEGER, user_agent TEXT, ip TEXT, error TEXT, key_via TEXT)`);
  trafficDb.init(db);
  cache = {};
  daily.init({ dailyUpsertStmt: trafficDb.dailyUpsertStmt(), dailyTraffic: cache });
});

const row = (p, d) => db.prepare('SELECT * FROM daily_traffic WHERE port_name=? AND date=?').get(p, d);

describe('recordDailyTraffic (WP3)', () => {
  it('пишет SQL + кэш в одной точке, с client_name', () => {
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 100, 50, 'WildBox');
    expect(row('S2_portA', '2026-07-26')).toMatchObject({ bytes_in: 100, bytes_out: 50, client_name: 'WildBox' });
    expect(cache['S2_portA']['2026-07-26']).toEqual({ in: 100, out: 50, portName: 'WildBox' });
  });

  it('MAX-семантика: меньшее значение не затирает большее (SQL и кэш)', () => {
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 200, 100, 'WildBox');
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 150, 90, 'WildBox');   // рестарт-гонка: меньше
    expect(row('S2_portA', '2026-07-26')).toMatchObject({ bytes_in: 200, bytes_out: 100 });
    expect(cache['S2_portA']['2026-07-26']).toEqual({ in: 200, out: 100, portName: 'WildBox' });
    // но большее — обновляет
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 300, 60, 'WildBox');
    expect(row('S2_portA', '2026-07-26').bytes_in).toBe(300);
    expect(row('S2_portA', '2026-07-26').bytes_out).toBe(100);   // MAX(100,60)
    expect(cache['S2_portA']['2026-07-26'].out).toBe(100);
  });

  it('client_name: пустой НЕ затирает известного; новый непустой — обновляет', () => {
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 100, 0, 'WildBox');
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 100, 0, '');           // бэкстоп без имени
    expect(row('S2_portA', '2026-07-26').client_name).toBe('WildBox');
    expect(cache['S2_portA']['2026-07-26'].portName).toBe('WildBox');
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 100, 0, 'LTESpace');   // перенос порта
    expect(row('S2_portA', '2026-07-26').client_name).toBe('LTESpace');
  });

  it('мусорные входы: отрицательные/NaN → 0; без portKey/date — no-op', () => {
    daily.recordDailyTraffic('S2_portA', '2026-07-26', -5, NaN, 'WildBox');
    expect(row('S2_portA', '2026-07-26')).toMatchObject({ bytes_in: 0, bytes_out: 0 });
    daily.recordDailyTraffic('', '2026-07-26', 1, 1, 'X');
    daily.recordDailyTraffic('S2_portB', '', 1, 1, 'X');
    expect(db.prepare('SELECT COUNT(*) n FROM daily_traffic').get().n).toBe(1);
  });

  it('кэш-фолбэк portName: при повторной записи без имени прежнее имя кэша сохраняется', () => {
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 100, 0, 'WildBox');
    daily.recordDailyTraffic('S2_portA', '2026-07-26', 200, 0);               // clientName не передан
    expect(cache['S2_portA']['2026-07-26'].portName).toBe('WildBox');
  });
});
