// ModemRate (A3, 23.08): текущая скорость модема из дельт суточных
// bw-счётчиков — скользящее окно, полуночный reset, снапшоты в БД, top().
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const rateMod = require('../src/jobs/modem-rate.js');

let db;
const T0 = Date.parse('2026-08-23T06:00:00.000Z');

function mk() {
  return rateMod.create({ db, logger: { info() {}, warn() {}, error() {} } });
}

// Собирает data-результат fetchServerData с заданными суточными счётчиками.
function mkData(dayInBytes, dayOutBytes) {
  const fmt = (b) => (b / 1e9).toFixed(1) + ' GB';
  return {
    serverName: 'S1',
    bw: { portA: { portName: 'C', bandwidth_bytes_day_in: fmt(dayInBytes), bandwidth_bytes_day_out: fmt(dayOutBytes) } },
    status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD2_39' }, net_details: { IS_ONLINE: 'yes' } }],
    ports: { imei1: [{ portID: 'portA', portName: 'C' }] },
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE modem_rate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, server TEXT NOT NULL, nick TEXT NOT NULL,
    rate_in_mbps REAL, rate_out_mbps REAL
  )`);
});

describe('modem-rate', () => {
  it('rate = дельта за окно; 0.1 GB за 5 мин ≈ 1.33 Мбит/с', () => {
    const job = mk();
    job.ingest('S1', mkData(1e9, 0), T0);                       // базовая точка («1.0 GB»)
    job.ingest('S1', mkData(1.1e9, 0), T0 + 5 * 60000);          // «1.1 GB» через 5 мин
    const l = job.latest()['S1_MD2_39'];
    expect(l).toBeTruthy();
    expect(l.rate_in_mbps).toBeCloseTo(0.1e9 * 8 / 1e6 / 300, 1); // ~2.67 Мбит/с
    expect(l.rate_out_mbps).toBe(0);
  });

  it('нет базы (<1 мин) → latest пуст', () => {
    const job = mk();
    job.ingest('S1', mkData(1e9, 0), T0);
    expect(job.latest()['S1_MD2_39']).toBeUndefined();
  });

  it('полуночный reset счётчика не даёт отрицательный rate', () => {
    const job = mk();
    job.ingest('S1', mkData(50e9, 0), T0);
    job.ingest('S1', mkData(50.5e9, 0), T0 + 5 * 60000);
    job.ingest('S1', mkData(0.1e9, 0), T0 + 10 * 60000);   // reset в полночь
    const l = job.latest()['S1_MD2_39'];
    // окно сброшено — базы нет, rate либо старый (ещё не протух), либо null,
    // но НЕ отрицательный
    if (l) expect(l.rate_in_mbps).toBeGreaterThanOrEqual(0);
    job.ingest('S1', mkData(0.2e9, 0), T0 + 15 * 60000);
    const l2 = job.latest()['S1_MD2_39'];
    expect(l2.rate_in_mbps).toBeCloseTo(0.1e9 * 8 / 1e6 / 300, 1);
  });

  it('снапшот в modem_rate раз в 5 минут', () => {
    const job = mk();
    job.ingest('S1', mkData(1e9, 0), T0);
    job.ingest('S1', mkData(1.1e9, 0), T0 + 5 * 60000);   // первый снапшот
    job.ingest('S1', mkData(1.2e9, 0), T0 + 7 * 60000);   // <5 мин — без записи
    job.ingest('S1', mkData(1.3e9, 0), T0 + 11 * 60000);  // второй снапшот
    const rows = db.prepare('SELECT * FROM modem_rate ORDER BY id').all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ server: 'S1', nick: 'MD2_39' });
  });

  it('несколько портов модема суммируются', () => {
    const job = mk();
    const d1 = mkData(1e9, 0);
    d1.bw.portB = { portName: 'C', bandwidth_bytes_day_in: '2.0 GB', bandwidth_bytes_day_out: '0.0 GB' };
    d1.ports.imei1.push({ portID: 'portB', portName: 'C' });
    job.ingest('S1', d1, T0);
    const d2 = mkData(1.1e9, 0);
    d2.bw.portB = { portName: 'C', bandwidth_bytes_day_in: '2.2 GB', bandwidth_bytes_day_out: '0.0 GB' };
    d2.ports.imei1.push({ portID: 'portB', portName: 'C' });
    job.ingest('S1', d2, T0 + 5 * 60000);   // суммарно +0.3 GB за 5 мин
    expect(job.latest()['S1_MD2_39'].rate_in_mbps).toBeCloseTo(0.3e9 * 8 / 1e6 / 300, 1);
  });

  it('top() сортирует по суммарной скорости', () => {
    const job = mk();
    job.ingest('S1', mkData(1e9, 0), T0);
    job.ingest('S1', mkData(2e9, 0), T0 + 5 * 60000);
    const top = job.top(5);
    expect(top.length).toBe(1);
    expect(top[0].key).toBe('S1_MD2_39');
    expect(top[0].total).toBeGreaterThan(0);
  });
});
