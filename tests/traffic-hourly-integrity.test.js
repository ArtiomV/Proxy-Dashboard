// 2026-09-24 · Регрессии DEEP-28/29/31 (FIX-SPEC §19.4): целостность
// почасового трафика.
//   DEEP-28: last_updated_at — время последней агрегации; refresh при старте
//            его не «омолаживает», кэш снимка несёт ту же дату, что и БД.
//   DEEP-29: повтор агрегатора внутри часа — аддитивная дельта (100+200=300),
//            а не KEEP первой записи; идентичный фид не задваивается.
//   DEEP-31: сверхпороговый час — карантин (bytes=0, uncertain=4, raw сохранён);
//            сглаживание ищет соседей только на ТОМ ЖЕ сервере.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const trafficDb = require('../src/db/traffic.js');
const hourly = require('../src/traffic/hourly.js');

const noopLogger = { info() {}, warn() {}, error() {} };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE traffic_hourly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT, port_id TEXT, nick TEXT, operator TEXT, client_name TEXT,
      hour_start TEXT, bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
      uncertain INTEGER DEFAULT 0,
      raw_bytes_in INTEGER DEFAULT NULL, raw_bytes_out INTEGER DEFAULT NULL,
      UNIQUE(port_id, hour_start)
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
    CREATE TABLE daily_traffic (
      port_name TEXT, date TEXT, bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
      client_name TEXT DEFAULT '', UNIQUE(port_name, date)
    );
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT, client_name TEXT, api_key_prefix TEXT, endpoint TEXT, method TEXT,
      status_code INTEGER, response_time_ms INTEGER, user_agent TEXT, ip TEXT,
      error TEXT, key_via TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

// Живой фид одного сервера с одним модемом/портом и заданными счётчиками.
function feedWith(dayIn, dayOut, monIn, monOut, opts = {}) {
  const bwRow = {
    portName: 'cli',
    bandwidth_bytes_day_in: String(dayIn), bandwidth_bytes_day_out: String(dayOut),
    bandwidth_bytes_month_in: String(monIn), bandwidth_bytes_month_out: String(monOut),
    bandwidth_bytes_yesterday_in: String(opts.yesIn || 0), bandwidth_bytes_yesterday_out: String(opts.yesOut || 0),
    bandwidth_bytes_prev_month_in: String(opts.pmIn || 0), bandwidth_bytes_prev_month_out: String(opts.pmOut || 0),
  };
  const statusModem = (nick) => ({
    modem_details: { IMEI: 'imei1', NICK: nick },
    net_details: { CELLOP: 'Moldcell', IS_ONLINE: 'yes' },
  });
  return [{
    serverName: 'S1',
    bw: { portA: bwRow },
    ports: { imei1: [{ portID: 'portA', portName: 'cli' }] },
    status: (opts.nicks || ['MD_1']).map(statusModem),
  }];
}

function boot(feedFn) {
  const db = makeDb();
  trafficDb.init(db);
  hourly.init({
    db, logger: noopLogger,
    fetchAllServersDataCached: feedFn,
    refreshPortKeyMapping: () => {},
    getPortKeyToPortName: () => ({}),
    _htUpsert: trafficDb.hourlyUpsertStmt(),
    _htCleanup: () => {},
    _metaOpGet: { get: () => null },
    _pcOpGet: null,
    _snapUpsert: trafficDb.snapshotUpsertStmt(),
    _snapUpsertPreserve: trafficDb.snapshotUpsertPreserveStmt(),
    _snapGet: trafficDb.snapshotGetStmt(),
    _snapGetAll: trafficDb.snapshotGetAllStmt(),
  });
  return db;
}

const HOUR_SQL = "strftime('%Y-%m-%d %H:00', datetime('now', '-1 hour'))";

describe('DEEP-29: повтор агрегатора внутри часа — аддитивная дельта', () => {
  it('два прогона: 100 MB + 200 MB = 300 MB в одном bucket, без потери и задвоения', async () => {
    let counters = { day: 0, mon: 0 };
    const db = boot(async () => feedWith(counters.day, 0, counters.mon, 0));

    counters = { day: 100e6, mon: 100e6 };
    await hourly.aggregateHourlyTraffic();         // baseline (без записи часа)
    counters = { day: 200e6, mon: 200e6 };
    await hourly.aggregateHourlyTraffic();         // первая дельта 100 MB
    counters = { day: 400e6, mon: 400e6 };
    await hourly.aggregateHourlyTraffic();         // вторая дельта 200 MB в тот же bucket

    const row = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(row.bytes_in).toBe(300e6);

    // Идентичный фид — дельта 0, сумма не растёт (защита от задвоения).
    await hourly.aggregateHourlyTraffic();
    const row2 = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(row2.bytes_in).toBe(300e6);
  });

  it('сырой SQL-контракт: additive merge + raw COALESCE + uncertain MAX', () => {
    const db = makeDb();
    trafficDb.init(db);
    const up = trafficDb.hourlyUpsertStmt();
    up.run('S1', 'S1_p', 'n', 'op', 'c', '2026-09-24 10:00', 100, 50, 0, null, null);
    up.run('S1', 'S1_p', 'n', 'op', 'c', '2026-09-24 10:00', 200, 60, 2, 900, 800);
    const row = db.prepare('SELECT * FROM traffic_hourly').get();
    expect(row.bytes_in).toBe(300);
    expect(row.bytes_out).toBe(110);
    expect(row.raw_bytes_in).toBe(900);
    expect(row.uncertain).toBe(2);
  });
});

describe('DEEP-28: last_updated_at не «омолаживается» refresh и совпадает с кэшем', () => {
  it('snapshotUpsertPreserve обновляет счётчики, но дату измерения держит', () => {
    const db = makeDb();
    trafficDb.init(db);
    const up = trafficDb.snapshotUpsertStmt();
    const upP = trafficDb.snapshotUpsertPreserveStmt();
    up.run('S1_p', 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0);
    db.prepare("UPDATE hourly_snapshots SET last_updated_at='2026-09-20 01:00:00'").run();
    upP.run('S1_p', 2, 2, 2, 2, 0, 0, 0, 0, 2, 2, 2, 2, 0);
    const row = trafficDb.snapshotGetStmt().get('S1_p');
    expect(row.day_in).toBe(2);
    expect(row.last_updated_at).toBe('2026-09-20 01:00:00');   // не «омолодилось»
    // Обычный upsert дату всё же обновляет (это и есть измерение).
    up.run('S1_p', 3, 3, 3, 3, 0, 0, 0, 0, 3, 3, 3, 3, 0);
    const row2 = trafficDb.snapshotGetStmt().get('S1_p');
    expect(row2.last_updated_at > '2026-09-20 01:00:00').toBe(true);
  });

  it('refreshSnapshotsOnly: baseline жив, last_updated_at прежний (в БД и в кэше)', async () => {
    const db = boot(async () => feedWith(50e9, 10e9, 500e9, 100e9));
    // Имитация «вчерашней» агрегации: снимок со старой датой.
    trafficDb.snapshotUpsertStmt().run('S1_portA', 40e9, 8e9, 490e9, 90e9, 0, 0, 0, 0, 40e9, 8e9, 490e9, 90e9, 0);
    db.prepare("UPDATE hourly_snapshots SET last_updated_at='2026-09-20 01:00:00'").run();
    hourly.init({
      db, logger: noopLogger,
      fetchAllServersDataCached: async () => feedWith(50e9, 10e9, 500e9, 100e9),
      refreshPortKeyMapping: () => {}, getPortKeyToPortName: () => ({}),
      _htUpsert: trafficDb.hourlyUpsertStmt(), _htCleanup: () => {},
      _metaOpGet: { get: () => null }, _pcOpGet: null,
      _snapUpsert: trafficDb.snapshotUpsertStmt(),
      _snapUpsertPreserve: trafficDb.snapshotUpsertPreserveStmt(),
      _snapGet: trafficDb.snapshotGetStmt(), _snapGetAll: trafficDb.snapshotGetAllStmt(),
    });
    await hourly.refreshSnapshotsOnly();
    const row = trafficDb.snapshotGetStmt().get('S1_portA');
    expect(Number(row.day_in)).toBe(40e9);                    // baseline не перезаписан live-счётчиком
    expect(row.last_updated_at).toBe('2026-09-20 01:00:00');  // и не «омоложен»
  });
});

describe('DEEP-31: карантин сверхпорогового часа и сервер-скоуп сглаживания', () => {
  it('дельта ≥ 20 GB: bytes=0, uncertain=4, raw сохранён; биллинг-сумма не растёт', async () => {
    let counters = { day: 10e9, mon: 10e9 };
    const db = boot(async () => feedWith(counters.day, 0, counters.mon, 0));
    await hourly.aggregateHourlyTraffic();          // baseline 10 GB
    counters = { day: 35e9, mon: 35e9 };
    await hourly.aggregateHourlyTraffic();          // дельта 25 GB → карантин

    const row = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(row.bytes_in).toBe(0);
    expect(row.uncertain).toBe(4);
    expect(Number(row.raw_bytes_in)).toBe(25e9);
    const sum = db.prepare(`SELECT COALESCE(SUM(bytes_in+bytes_out),0) s FROM traffic_hourly`).get().s;
    expect(sum).toBe(0);   // в суммы (биллинг) карантин не попадает
    // Авто-сглаживание флага мелких строк карантин не трогает.
    trafficDb.hourlyAutoSmoothUncertainStmt().run();
    expect(db.prepare(`SELECT uncertain FROM traffic_hourly WHERE port_id='S1_portA'`).get().uncertain).toBe(4);
  });

  it('сглаживание НЕ использует соседей с другого сервера (одинаковые ники)', async () => {
    // Час назад был записан baseline; текущая дельта противоречит month → uncertain=2.
    let counters = { day: 0, mon: 0 };
    const db = boot(async () => feedWith(counters.day, 0, counters.mon, 0));
    // «Соседи» на ДРУГОМ сервере с тем же nick+client — достаточно для медианы,
    // но использоваться не должны (DEEP-31: разные временные ряды).
    const ins = db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
      VALUES ('S4', ?, 'MD_1', 'moldcell', 'cli', strftime('%Y-%m-%d %H:00', datetime('now', ?)), 1e9, 0, 0)`);
    ins.run('S4_pA', '-2 hours'); ins.run('S4_pB', '-3 hours'); ins.run('S4_pC', '-4 hours');
    counters = { day: 1e9, mon: 1e9 };
    await hourly.aggregateHourlyTraffic();          // baseline
    counters = { day: 11e9, mon: 1.1e9 };
    await hourly.aggregateHourlyTraffic();          // day-дельта 10 GB vs month 100 MB → uncertain=2
    const row = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    // Соседей на S1 нет → сглаживания нет, строка остаётся uncertain=2 (не 3).
    expect(row.uncertain).toBe(2);
    expect(Number(row.bytes_in)).toBe(10e9);
  });

  it('клон IMEI: атрибуция порта — первый модем, не последний (DEEP-33)', async () => {
    let counters = { day: 1e9, mon: 1e9 };
    const db = boot(async () => feedWith(counters.day, 0, counters.mon, 0, { nicks: ['MD_FIRST', 'MD_SECOND'] }));
    await hourly.aggregateHourlyTraffic();
    counters = { day: 2e9, mon: 2e9 };
    await hourly.aggregateHourlyTraffic();
    const row = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(row.nick).toBe('MD_FIRST');
  });
});
