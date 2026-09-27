// 2026-09-27 (миграция 105): проводной учёт трафика модемов.
//   • parseModemNetDev — парсер /proc/net/dev (только интерфейсы modem*);
//   • wire-scale в aggregateHourlyTraffic: сумма заявленного по портам модема
//     > проводной дельты × 1.3 → все порты масштабируются к проводу,
//     uncertain=6, заявленное сохраняется в raw_bytes_*;
//   • без wire-данных / без iface (net_details.DEV) — записывается как заявлено;
//   • заявка ≈ провод (здоровый модем) — без изменений.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const trafficDb = require('../src/db/traffic.js');
const hourly = require('../src/traffic/hourly.js');
const { parseModemNetDev } = require('../src/jobs/server-metrics.js');

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
    CREATE TABLE modem_wire_counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT NOT NULL,
      iface TEXT NOT NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_modem_wire_counters_srv_iface_ts
      ON modem_wire_counters(server_name, iface, ts);
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

// Живой фид: один модем (MD_1, DEV=modem4470) с двум портами portA/portB.
function feed2(counters, opts = {}) {
  const bwRow = (dayIn, monIn) => ({
    portName: 'cli',
    bandwidth_bytes_day_in: String(dayIn), bandwidth_bytes_day_out: '0',
    bandwidth_bytes_month_in: String(monIn), bandwidth_bytes_month_out: '0',
    bandwidth_bytes_yesterday_in: '0', bandwidth_bytes_yesterday_out: '0',
    bandwidth_bytes_prev_month_in: '0', bandwidth_bytes_prev_month_out: '0',
  });
  const dev = opts.dev === undefined ? 'modem4470' : opts.dev;
  return [{
    serverName: 'S1',
    bw: { portA: bwRow(counters.a.day, counters.a.mon), portB: bwRow(counters.b.day, counters.b.mon) },
    ports: { imei1: [{ portID: 'portA', portName: 'cliA' }, { portID: 'portB', portName: 'cliB' }] },
    status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD_1' }, net_details: { CELLOP: 'Moldcell', DEV: dev } }],
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

// Два семпла /proc/net/dev вокруг предыдущего часа: за 5 мин до начала и за
// 5 мин до конца. Дельта rx между ними = rxDelta байт.
function seedWireSamples(db, rxDelta, iface = 'modem4470') {
  const now = Date.now();
  const h0 = now - (now % 3600000) - 3600000;   // начало предыдущего часа (как в агрегаторе)
  const fmt = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const ins = db.prepare('INSERT INTO modem_wire_counters (server_name, iface, rx_bytes, tx_bytes, ts) VALUES (?, ?, ?, ?, ?)');
  ins.run('S1', iface, 1e12, 0, fmt(h0 - 5 * 60e3));
  ins.run('S1', iface, 1e12 + rxDelta, 0, fmt(h0 + 55 * 60e3));
}

const HOUR_SQL = "strftime('%Y-%m-%d %H:00', datetime('now', '-1 hour'))";

describe('parseModemNetDev: парсер /proc/net/dev', () => {
  const NET_DEV = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 115292 896 0 0 0 0 0 0 115292 896 0 0 0 0 0 0',
    '  enp3s0: 987654 1000 0 0 0 0 0 0 123456 900 0 0 0 0 0 0',
    'modem4470: 4200000 50 0 0 0 0 0 0 2100000 40 0 0 0 0 0 0',
    '  wlan0: 111 2 0 0 0 0 0 0 222 3 0 0 0 0 0 0',
  ].join('\n');

  it('берёт только modem*-строки: rx = колонка 2, tx = колонка 10', () => {
    expect(parseModemNetDev(NET_DEV)).toEqual([
      { iface: 'modem4470', rx_bytes: 4200000, tx_bytes: 2100000 },
    ]);
  });

  it('несколько модемов; мусор/пустота — пустой массив без исключений', () => {
    const two = parseModemNetDev('modem1: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\nmodem2: 30 1 0 0 0 0 0 0 40 1 0 0 0 0 0 0');
    expect(two).toHaveLength(2);
    expect(two[1]).toEqual({ iface: 'modem2', rx_bytes: 30, tx_bytes: 40 });
    expect(parseModemNetDev('')).toEqual([]);
    expect(parseModemNetDev('garbage\nmodem: nope')).toEqual([]);
    expect(parseModemNetDev(null)).toEqual([]);
  });
});

describe('wire-scale (uncertain=6): заявка портов против проводной дельты', () => {
  it('2 порта заявили 1 ГБ + 3 ГБ, провод 0.5 ГБ → записано 0.125 + 0.375, uncertain=6, raw сохранены', async () => {
    let counters = { a: { day: 10e9, mon: 10e9 }, b: { day: 10e9, mon: 10e9 } };
    const db = boot(async () => feed2(counters));
    await hourly.aggregateHourlyTraffic();          // baseline
    counters = { a: { day: 11e9, mon: 11e9 }, b: { day: 13e9, mon: 13e9 } };
    seedWireSamples(db, 0.5e9);                     // провод: 0.5 ГБ за час
    await hourly.aggregateHourlyTraffic();          // заявка 1+3 ГБ → масштаб ×0.125

    const a = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    const b = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portB' AND hour_start = ${HOUR_SQL}`).get();
    expect(Number(a.bytes_in)).toBe(0.125e9);
    expect(Number(b.bytes_in)).toBe(0.375e9);
    expect(a.uncertain).toBe(6);
    expect(b.uncertain).toBe(6);
    expect(Number(a.raw_bytes_in)).toBe(1e9);       // заявленное не потеряно
    expect(Number(b.raw_bytes_in)).toBe(3e9);
    // Итог по модему = провод × 1.0
    expect(Number(a.bytes_in) + Number(b.bytes_in)).toBe(0.5e9);
  });

  it('без wire-данных — записывается как заявлено (uncertain=0)', async () => {
    let counters = { a: { day: 10e9, mon: 10e9 }, b: { day: 10e9, mon: 10e9 } };
    const db = boot(async () => feed2(counters));
    await hourly.aggregateHourlyTraffic();
    counters = { a: { day: 11e9, mon: 11e9 }, b: { day: 13e9, mon: 13e9 } };
    await hourly.aggregateHourlyTraffic();          // семплов нет — масштабирование пропущено

    const a = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    const b = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portB' AND hour_start = ${HOUR_SQL}`).get();
    expect(Number(a.bytes_in)).toBe(1e9);
    expect(Number(b.bytes_in)).toBe(3e9);
    expect(a.uncertain).toBe(0);
    expect(b.uncertain).toBe(0);
    expect(a.raw_bytes_in).toBeNull();
  });

  it('здоровый модем (заявка ≈ провод) — без изменений', async () => {
    let counters = { a: { day: 10e9, mon: 10e9 }, b: { day: 10e9, mon: 10e9 } };
    const db = boot(async () => feed2(counters));
    await hourly.aggregateHourlyTraffic();
    counters = { a: { day: 11e9, mon: 11e9 }, b: { day: 13e9, mon: 13e9 } };
    seedWireSamples(db, 4e9);                       // провод 4 ГБ ≥ заявки 4 ГБ
    await hourly.aggregateHourlyTraffic();

    const a = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    const b = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portB' AND hour_start = ${HOUR_SQL}`).get();
    expect(Number(a.bytes_in)).toBe(1e9);
    expect(Number(b.bytes_in)).toBe(3e9);
    expect(a.uncertain).toBe(0);
    expect(b.uncertain).toBe(0);
  });

  it('нет DEV в живом фиде (модем офлайн) — масштабирование пропускаем', async () => {
    let counters = { a: { day: 10e9, mon: 10e9 }, b: { day: 10e9, mon: 10e9 } };
    const db = boot(async () => feed2(counters, { dev: '' }));
    await hourly.aggregateHourlyTraffic();
    counters = { a: { day: 11e9, mon: 11e9 }, b: { day: 13e9, mon: 13e9 } };
    seedWireSamples(db, 0.5e9);                     // семплы есть, но привязки ник→iface нет
    await hourly.aggregateHourlyTraffic();

    const a = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(Number(a.bytes_in)).toBe(1e9);
    expect(a.uncertain).toBe(0);
  });

  it('один семпл вместо двух — недостаточно данных, масштабирование пропускаем', async () => {
    let counters = { a: { day: 10e9, mon: 10e9 }, b: { day: 10e9, mon: 10e9 } };
    const db = boot(async () => feed2(counters));
    await hourly.aggregateHourlyTraffic();
    counters = { a: { day: 11e9, mon: 11e9 }, b: { day: 13e9, mon: 13e9 } };
    // Только семпл «до начала часа» — границы конца часа нет.
    const now = Date.now();
    const h0 = now - (now % 3600000) - 3600000;
    db.prepare('INSERT INTO modem_wire_counters (server_name, iface, rx_bytes, tx_bytes, ts) VALUES (?, ?, ?, ?, ?)')
      .run('S1', 'modem4470', 1e12, 0, new Date(h0 - 5 * 60e3).toISOString().slice(0, 19).replace('T', ' '));
    await hourly.aggregateHourlyTraffic();

    const a = db.prepare(`SELECT * FROM traffic_hourly WHERE port_id='S1_portA' AND hour_start = ${HOUR_SQL}`).get();
    expect(Number(a.bytes_in)).toBe(1e9);
    expect(a.uncertain).toBe(0);
  });
});
