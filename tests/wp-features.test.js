// Покрытие фич, принятых в main 2026-07-26 (бывшие незакоммиченные наработки):
//  - WP3 rotation caller: upsert бэкфиллит caller/target_mode, не затирая
//    уже известные значения пустыми (COALESCE).
//  - WP2 domain-guard: суффикс-матч по реальному бан-листу, дельта кумулятивных
//    счётчиков, идемпотентность повторного прогона в тот же день.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const trackingDb = require('../src/db/tracking.js');
const domainGuard = require('../src/jobs/domain-guard.js');

// ── WP3: rotation_log caller/target_mode ─────────────────────────────────
function mkRotationDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rotation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT, nick TEXT, old_ip TEXT, new_ip TEXT,
    started_at TEXT, ended_at TEXT, took_sec INTEGER, attempt INTEGER,
    caller TEXT, target_mode TEXT,
    UNIQUE(server_name, nick, started_at))`);
  // trackingDb.init готовит и другие стейтменты — таблицы-заглушки
  for (const t of [
    'CREATE TABLE ip_tracking (key TEXT PRIMARY KEY, ip TEXT, updated_at TEXT)',
    'CREATE TABLE uptime_tracking (key TEXT PRIMARY KEY, total_checks INTEGER, online_checks INTEGER, first_check TEXT, last_check TEXT, last_online_check TEXT, offline_alerted INTEGER)',
    'CREATE TABLE uptime_daily (key TEXT, date TEXT, online INTEGER, total INTEGER, UNIQUE(key, date))',
    'CREATE TABLE ip_history (id INTEGER PRIMARY KEY, key TEXT, ip TEXT, started_at TEXT, ended_at TEXT)',
    `CREATE TABLE modem_meta (
      server_name TEXT, imei TEXT, nick TEXT, operator TEXT, model TEXT, phone TEXT,
      sim_status TEXT, reboot_score INTEGER, http_redirect INTEGER, band TEXT, is_locked INTEGER,
      signal_strength TEXT, iccid TEXT, cell_op TEXT, net_type TEXT, modem_uptime INTEGER,
      signals_updated_at TEXT, updated_at TEXT, is_test_pool INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
      UNIQUE(server_name, imei))`,
    'CREATE TABLE proxy_checks (id INTEGER PRIMARY KEY, server_name TEXT, nick TEXT, client_name TEXT, total_ms INTEGER, error TEXT, checked_at TEXT)',
  ]) db.exec(t);
  return db;
}

describe('WP3: rotation upsert — caller/target_mode', () => {
  let db, upsert, select;
  beforeEach(() => {
    db = mkRotationDb();
    trackingDb.init(db);
    upsert = trackingDb.rotationUpsertStmt();
    select = trackingDb.rotationSelectStmt();
  });

  it('повторный синк бэкфиллит caller/target_mode в старую строку', () => {
    // старая строка (до 050) — без caller
    upsert.run('S2', 'RO2_49', '1.1.1.1', '2.2.2.2', '2026-07-25 10:00:00', '2026-07-25 10:00:30', 30, 1, null, null);
    // новый синк несёт caller — бэкфиллит
    upsert.run('S2', 'RO2_49', '1.1.1.1', '2.2.2.2', '2026-07-25 10:00:00', '2026-07-25 10:00:30', 30, 1, 'schedule', '4g');
    const rows = select.all('S2', 'RO2_49');
    expect(rows.length).toBe(1);
    expect(rows[0].caller).toBe('schedule');
    expect(rows[0].target_mode).toBe('4g');
  });

  it('NULL-caller при повторном синке НЕ затирает известного', () => {
    upsert.run('S2', 'RO2_49', '1.1.1.1', '2.2.2.2', '2026-07-25 10:00:00', '2026-07-25 10:00:30', 30, 1, 'api', '4g');
    upsert.run('S2', 'RO2_49', '1.1.1.1', '2.2.2.2', '2026-07-25 10:00:00', '2026-07-25 10:00:30', 30, 1, null, null);
    expect(select.all('S2', 'RO2_49')[0].caller).toBe('api');
  });
});

// ── WP2: domain-guard ────────────────────────────────────────────────────
function mkGuardDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE top_hosts_detail (
    server_name TEXT, port_id TEXT, nick TEXT, client_name TEXT, host TEXT, count INTEGER, snapshot_at TEXT)`);
  db.exec(`CREATE TABLE top_hosts_daily (
    date TEXT, server_name TEXT, port_id TEXT, nick TEXT, client_name TEXT, host TEXT, count INTEGER,
    UNIQUE(date, server_name, port_id, host))`);
  db.exec(`CREATE TABLE domain_guard_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, server_name TEXT, client_name TEXT, nick TEXT, host TEXT, matched_domain TEXT,
    hits_delta INTEGER, total INTEGER, created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, server_name, client_name, host))`);
  return db;
}

describe('WP2: domain-guard — детект обращений к бан-листу', () => {
  let db, fired;
  beforeEach(() => {
    db = mkGuardDb();
    fired = [];
    const now = new Date().toISOString();
    // свежий снапшот: один хост из бан-листа, один разрешённый
    db.prepare('INSERT INTO top_hosts_detail (server_name, port_id, nick, client_name, host, count, snapshot_at) VALUES (?,?,?,?,?,?,?)')
      .run('S2', 'portA', 'RO2_1', 'WildBox', 'sberbank.ru', 100, now);
    db.prepare('INSERT INTO top_hosts_detail (server_name, port_id, nick, client_name, host, count, snapshot_at) VALUES (?,?,?,?,?,?,?)')
      .run('S2', 'portA', 'RO2_1', 'WildBox', 'example.com', 500, now);
    db.prepare('INSERT INTO top_hosts_detail (server_name, port_id, nick, client_name, host, count, snapshot_at) VALUES (?,?,?,?,?,?,?)')
      .run('S4', 'portB', 'MD_1', 'Brandanalytics', 'pay.binance.com', 42, now);   // поддомен бан-сета
  });

  function mkJob() {
    return domainGuard.create({
      db, logger: { info() {}, warn() {}, error() {} },
      getSetting: (k, d) => d,
      alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
      logActivity: () => {},
      getMoscowToday: () => '2026-07-26',
    });
  }

  it('находит хост и поддомен из бан-листа, пишет историю, шлёт алерт', async () => {
    const res = await mkJob().runDomainGuard();
    expect(res.hits).toBe(2);                       // sberbank.ru + pay.binance.com; example.com — нет
    const alert = fired.find(f => f.rule === 'domain_guard_hit');
    expect(alert).toBeTruthy();
    expect(alert.payload.count).toBe(2);
    const hits = db.prepare('SELECT host, matched_domain, hits_delta FROM domain_guard_hits ORDER BY host').all();
    expect(hits.map(h => h.host)).toEqual(['pay.binance.com', 'sberbank.ru']);
    expect(hits[0].matched_domain).toBe('binance.com');   // суффикс-матч поддомена
    expect(db.prepare('SELECT COUNT(*) n FROM top_hosts_daily').get().n).toBe(3);
  });

  it('baseline предыдущего дня: без прироста счётчиков — хитов нет', async () => {
    // «вчера» уже записаны те же значения, что в сегодняшнем снапшоте → дельта 0
    db.prepare("INSERT INTO top_hosts_daily (date, server_name, port_id, nick, client_name, host, count) VALUES ('2026-07-25','S2','portA','RO2_1','WildBox','sberbank.ru',100)").run();
    db.prepare("INSERT INTO top_hosts_daily (date, server_name, port_id, nick, client_name, host, count) VALUES ('2026-07-25','S4','portB','MD_1','Brandanalytics','pay.binance.com',42)").run();
    const res = await mkJob().runDomainGuard();
    expect(res.hits).toBe(0);
    expect(fired.filter(f => f.rule === 'domain_guard_hit').length).toBe(0);
  });

  it('прирост счётчика алертится только на дельту', async () => {
    db.prepare("INSERT INTO top_hosts_daily (date, server_name, port_id, nick, client_name, host, count) VALUES ('2026-07-25','S2','portA','RO2_1','WildBox','sberbank.ru',100)").run();
    db.prepare("INSERT INTO top_hosts_daily (date, server_name, port_id, nick, client_name, host, count) VALUES ('2026-07-25','S4','portB','MD_1','Brandanalytics','pay.binance.com',42)").run();
    db.prepare("UPDATE top_hosts_detail SET count = 130 WHERE host = 'sberbank.ru'").run();
    const res = await mkJob().runDomainGuard();
    expect(res.hits).toBe(1);
    const row = db.prepare("SELECT hits_delta, total FROM domain_guard_hits WHERE host = 'sberbank.ru'").get();
    expect(row.hits_delta).toBe(30);   // 130 − 100, не 130
    expect(row.total).toBe(130);
  });
});
