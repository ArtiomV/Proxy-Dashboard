// 2026-10-02: аптайм без окон «пакет исчерпан» — минуты, когда модем не мог
// работать из-за пакета оператора, исключаются из знаменателя (SLA отвечает
// за инфраструктуру, не за тариф). Окна: notifications (exhausted/recovered)
// + открытые строки sim_exhaustion_state.
// NB: mapRow ждёт дневные строки (observed_from/to как 'YYYY-MM-DD') — контракт
// clientRows/modemRows. Знаменатель никогда не опускается ниже online_checks.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const up = require('../src/uptime-period.js');

function mkDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE notifications (id INTEGER PRIMARY KEY, rule_id TEXT, payload_json TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE sim_exhaustion_state (server_name TEXT, imei TEXT, nick TEXT, since_ts INTEGER)`);
  return db;
}

const D = (s) => Date.parse(s + 'Z');

describe('uptime-period: окна исчерпания пакета исключаются из знаменателя SLA', () => {
  it('окно из пары exhausted→recovered вычитает свои минуты (кап — до online)', () => {
    const db = mkDb();
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_exhausted', ?, ?)").run(JSON.stringify({ server: 'S4', nick: 'MD_17' }), '2026-10-01 10:00:00');
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_recovered', ?, ?)").run(JSON.stringify({ server: 'S4', nick: 'MD_17' }), '2026-10-01 12:00:00');
    const wins = up.exhaustionWindows(db, D('2026-10-01T00:00:00'), D('2026-10-02T00:00:00'));
    const row = { server: 'S4', nick: 'MD_17', checks: 1000, online_checks: 900, observed_from: '2026-10-01', observed_to: '2026-10-02' };
    const adj = up.adjustRowForExhaustion(up.mapRow(row), wins);
    expect(adj.excluded_exhaustion_min).toBe(120);
    expect(adj.checks).toBe(900);            // max(online=900, 1000−120=880)
    expect(adj.uptime_pct).toBe(100);        // 900/900 — все сбои были в окне пакета
  });

  it('сбои ВНЕ окна остаются в знаменателе', () => {
    const db = mkDb();
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_exhausted', ?, ?)").run(JSON.stringify({ server: 'S4', nick: 'MD_17' }), '2026-10-01 10:00:00');
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_recovered', ?, ?)").run(JSON.stringify({ server: 'S4', nick: 'MD_17' }), '2026-10-01 12:00:00');
    const wins = up.exhaustionWindows(db, D('2026-10-01T00:00:00'), D('2026-10-02T00:00:00'));
    // 1000 проверок, 800 онлайн: 100 мин сбоёв в окне (вычтутся), 100 — вне (остаются)
    const row = { server: 'S4', nick: 'MD_17', checks: 1000, online_checks: 800, observed_from: '2026-10-01', observed_to: '2026-10-02' };
    const adj = up.adjustRowForExhaustion(up.mapRow(row), wins);
    expect(adj.checks).toBe(880);            // 1000−120
    expect(adj.uptime_pct).toBe(90.91);      // 800/880
  });

  it('открытая строка sim_exhaustion_state — окно до конца периода; день целиком «вне пакета» капается до online', () => {
    const db = mkDb();
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, since_ts) VALUES ('S4', 'i1', 'MD_19', ?)").run(D('2026-10-01T06:00:00'));
    const wins = up.exhaustionWindows(db, D('2026-10-01T00:00:00'), D('2026-10-02T00:00:00'));
    const row = { server: 'S4', nick: 'MD_19', checks: 500, online_checks: 100, observed_from: '2026-10-01', observed_to: '2026-10-02' };
    const adj = up.adjustRowForExhaustion(up.mapRow(row), wins);
    expect(adj.checks).toBe(100);            // окно 1080 мин > 500 проверок → кап до online
    expect(adj.uptime_pct).toBe(100);
  });

  it('модем без окон — без изменений', () => {
    const db = mkDb();
    const wins = up.exhaustionWindows(db, D('2026-10-01T00:00:00'), D('2026-10-02T00:00:00'));
    const row = { server: 'S1', nick: 'MD2_50', checks: 1000, online_checks: 990, observed_from: '2026-10-01', observed_to: '2026-10-02' };
    const adj = up.adjustRowForExhaustion(up.mapRow(row), wins);
    expect(adj.checks).toBe(1000);
    expect(adj.uptime_pct).toBe(99);
  });

  it('пересечение границ периода учитывается частично', () => {
    const db = mkDb();
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_exhausted', ?, ?)").run(JSON.stringify({ server: 'S1', nick: 'MD_1' }), '2026-09-28 20:00:00');
    db.prepare("INSERT INTO notifications (rule_id, payload_json, created_at) VALUES ('sim_package_recovered', ?, ?)").run(JSON.stringify({ server: 'S1', nick: 'MD_1' }), '2026-09-29 02:00:00');
    const wins = up.exhaustionWindows(db, D('2026-09-28T00:00:00'), D('2026-09-30T00:00:00'));
    // наблюдения за 29.09: окно накрывает 00:00–02:00 = 120 мин
    const row = { server: 'S1', nick: 'MD_1', checks: 500, online_checks: 380, observed_from: '2026-09-29', observed_to: '2026-09-30' };
    const adj = up.adjustRowForExhaustion(up.mapRow(row), wins);
    expect(adj.excluded_exhaustion_min).toBe(120);
    expect(adj.checks).toBe(380);            // max(online=380, 500−120=380)
  });
});
