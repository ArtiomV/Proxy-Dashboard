'use strict';
// tests/today-traffic.test.js — src/traffic/today.js: корректное «сегодня» (MSK)
// поверх живых day-счётчиков ProxySmart (инцидент 28.08: «Румыния 300 ГБ
// в час ночи» — сырой счётчик до 03:00 MSK содержит весь вчерашний день).

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const todayCalc = require('../src/traffic/today');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE traffic_hourly (
      server_name TEXT, port_id TEXT, nick TEXT, operator TEXT, client_name TEXT,
      hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER, uncertain INTEGER DEFAULT 0,
      PRIMARY KEY (port_id, hour_start)
    );
    CREATE TABLE hourly_snapshots (
      port_id TEXT PRIMARY KEY,
      day_in INTEGER, day_out INTEGER, month_in INTEGER, month_out INTEGER,
      yesterday_in INTEGER, yesterday_out INTEGER,
      prev_month_in INTEGER, prev_month_out INTEGER,
      day_at_last_hour_start_in INTEGER, day_at_last_hour_start_out INTEGER,
      mon_at_last_hour_start_in INTEGER, mon_at_last_hour_start_out INTEGER,
      pending INTEGER, captured_at TEXT, last_updated_at TEXT
    );
  `);
  return db;
}

const TODAY = '2026-08-28';
// MSK-полночь 28.08 = 27.08 21:00 UTC. «Сейчас» в тестах — 28.08 01:00 MSK
// (27.08 22:00 UTC): бокс ещё НЕ сбросил day-счётчики (reset в 00:00 UTC).
const NOW_UTC = '2026-08-27 22:05:00';

describe('today-traffic: MSK-сегодня против UTC-reset счётчиков', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('clampLiveDelta: только (0, 20GB)', () => {
    expect(todayCalc.clampLiveDelta(0)).toBe(0);
    expect(todayCalc.clampLiveDelta(-5)).toBe(0);
    expect(todayCalc.clampLiveDelta(1e9)).toBe(1e9);
    expect(todayCalc.clampLiveDelta(25e9)).toBe(0);
  });

  it('в 01:00 MSK вчерашний полный день НЕ попадает в «сегодня»', () => {
    // Порт вчера накачал 300 ГБ; час 21:00 UTC (00:00–01:00 MSK) уже в hourly.
    db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out)
      VALUES ('RO1', 'RO1_portA', 'm1', 'Orange RO', 'cli', '2026-08-27 21:00:00', 12e9, 3e9)`).run();
    // Снапшот на начало часа: счётчик был 288e9 (вчерашний день почти весь).
    db.prepare(`INSERT INTO hourly_snapshots (port_id, day_at_last_hour_start_in, day_at_last_hour_start_out, last_updated_at)
      VALUES ('RO1_portA', 288e9, 60e9, ?)`).run(NOW_UTC);

    const th = todayCalc.hourlyTodayByPort(db, TODAY);
    const snaps = todayCalc.snapshotBaselines(db, TODAY);
    // Живой счётчик до reset: 300e9 in / 62e9 out (весь вчерашний день).
    const t = todayCalc.todayBytes(th, snaps, 'RO1_portA', 300e9, 62e9);
    // hourly(15 GB) + дельта(12+2 GB) = 29 GB — а не 362 GB сырых.
    expect(t.in).toBe(12e9 + 12e9);
    expect(t.out).toBe(3e9 + 2e9);
    expect(t.in + t.out).toBeLessThan(40e9);
  });

  it('после reset (03:00+ MSK) считается новый день с нуля', () => {
    // Reset произошёл, агрегатор записал reset-час и обновил baseline.
    db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out)
      VALUES ('RO1', 'RO1_portA', 'm1', 'Orange RO', 'cli', '2026-08-28 00:00:00', 5e9, 1e9)`).run();
    db.prepare(`INSERT INTO hourly_snapshots (port_id, day_at_last_hour_start_in, day_at_last_hour_start_out, last_updated_at)
      VALUES ('RO1_portA', 2e9, 0.5e9, '2026-08-28 01:05:00')`).run();

    const th = todayCalc.hourlyTodayByPort(db, TODAY);
    const snaps = todayCalc.snapshotBaselines(db, TODAY);
    const t = todayCalc.todayBytes(th, snaps, 'RO1_portA', 4e9, 1.2e9);
    expect(t.in).toBe(5e9 + 2e9);   // hourly 5 + delta (4−2)
    expect(t.out).toBe(1e9 + 0.7e9);
  });

  it('протухший снапшот (сервер лежал за полночь) — live-дельта пропускается', () => {
    db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out)
      VALUES ('RO1', 'RO1_portA', 'm1', 'Orange RO', 'cli', '2026-08-28 05:00:00', 1e9, 0.2e9)`).run();
    // Снапшот обновлялся последний раз вчера днём — baseline доресетный.
    db.prepare(`INSERT INTO hourly_snapshots (port_id, day_at_last_hour_start_in, day_at_last_hour_start_out, last_updated_at)
      VALUES ('RO1_portA', 100e9, 20e9, '2026-08-27 10:00:00')`).run();

    const th = todayCalc.hourlyTodayByPort(db, TODAY);
    const snaps = todayCalc.snapshotBaselines(db, TODAY);
    expect(snaps.has('RO1_portA')).toBe(false);
    const t = todayCalc.todayBytes(th, snaps, 'RO1_portA', 3e9, 1e9);
    expect(t.in).toBe(1e9);   // только hourly, без мусорной дельты
    expect(t.out).toBe(0.2e9);
  });

  it('hasOwnAccounting: свежая установка → raw-fallback разрешён', () => {
    const th = todayCalc.hourlyTodayByPort(db, TODAY);
    const snaps = todayCalc.snapshotBaselines(db, TODAY);
    expect(todayCalc.hasOwnAccounting(th, snaps)).toBe(false);
  });

  it('локальный reset бокса (00:00 МСК) после снапшота 21:00 UTC — baseline=0, не «0 Б»', () => {
    // Инцидент 29.08: MD-боксы сбрасывают счётчики в ЛОКАЛЬНУЮ полночь
    // (00:00 МСК = 21:00 UTC) через секунды после снапшота агрегатора.
    // Живой счётчик (0.5 ГБ) < baseline (17.6 ГБ) → дельта уходит в минус.
    db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out)
      VALUES ('S4', 'S4_portA', 'm1', 'Moldcell', 'cli', '2026-08-27 21:00:00', 0.2e9, 0.05e9)`).run();
    db.prepare(`INSERT INTO hourly_snapshots (port_id, day_at_last_hour_start_in, day_at_last_hour_start_out, last_updated_at)
      VALUES ('S4_portA', 17.6e9, 4e9, ?)`).run(NOW_UTC);

    const th = todayCalc.hourlyTodayByPort(db, TODAY);
    const snaps = todayCalc.snapshotBaselines(db, TODAY);
    // Живой счётчик после локального reset: 0.5 GB in / 0.1 GB out.
    const t = todayCalc.todayBytes(th, snaps, 'S4_portA', 0.5e9, 0.1e9);
    expect(t.in).toBe(0.2e9 + 0.5e9);   // hourly + live от нуля, НЕ 0
    expect(t.out).toBe(0.05e9 + 0.1e9);
  });
});
