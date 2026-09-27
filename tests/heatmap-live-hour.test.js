// 2026-09-27: «живая ячейка» текущего часа в хитмапе почасового трафика.
// traffic_hourly пишется по завершении часа — до этого превью считается из
// bw-счётчиков боксов минус СОБСТВЕННЫЙ baseline (live_hour_baseline,
// миграция 106): первая точка отсчёта в каждом МСК-часе. Чужой baseline
// (hourly_snapshots) не используется — инцидент RO1 27.09 (+226 ГБ/ч).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeLiveCells } = require('../src/routes/analytics.js');

const HK = '2026-09-27 17';
const bw = (inn, out) => ({ bandwidth_bytes_day_in: inn, bandwidth_bytes_day_out: out });

function mkBaseline(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: { get: (id) => store.get(id) },   // computeLiveCells ждёт statement-подобный объект .get()
    upsert: { run: (id, hk, b) => store.set(id, { hour_key: hk, bytes: b }) },
    store,
  };
}

describe('heatmap live hour: частичный трафик незавершённого часа', () => {
  it('дельта от собственного baseline; первое наблюдение в часе = 0 и становится точкой отсчёта', () => {
    const base = mkBaseline();
    const feed = () => [{ serverName: 'S1', status: [{ modem_details: { IMEI: 'i1', NICK: 'MD_1' }, net_details: { CELLOP: 'moldcell' } }], ports: { i1: [{ portID: 'p1', portName: 'Brandanalytics' }] }, bw: { p1: bw('700 MB', '300 MB') } }];

    // Первое наблюдение в часе — baseline ещё неизвестен, дельта 0, но точка отсчёта записана.
    let cells = computeLiveCells(feed(), HK, base.get, base.upsert, {}, {}, (x) => x);
    expect(cells).toEqual([]);
    expect(base.store.get('S1_p1')).toEqual({ hour_key: HK, bytes: 1e9 });

    // Счётчик вырос — дельта считается от нашей точки отсчёта.
    const feed2 = () => [{ serverName: 'S1', status: [{ modem_details: { IMEI: 'i1', NICK: 'MD_1' }, net_details: { CELLOP: 'moldcell' } }], ports: { i1: [{ portID: 'p1', portName: 'Brandanalytics' }] }, bw: { p1: bw('900 MB', '400 MB') } }];
    cells = computeLiveCells(feed2(), HK, base.get, base.upsert, {}, {}, (x) => x);
    expect(cells).toEqual([{ server: 'S1', client: 'Brandanalytics', operator: 'moldcell', bytes: 300e6 }]);

    // Новый час — baseline пересоздаётся, фантома из прошлого часа нет.
    cells = computeLiveCells(feed2(), '2026-09-27 18', base.get, base.upsert, {}, {}, (x) => x);
    expect(cells).toEqual([]);
    expect(base.store.get('S1_p1')).toEqual({ hour_key: '2026-09-27 18', bytes: 1.3e9 });
  });

  it('baseline=0 из прошлого (инцидент RO1) не даёт фантома: точка отсчёта — первое наблюдение часа', () => {
    // Симулируем ситуацию RO1: счётчик уже большой (10.7 GB), baseline — наш, текущего часа, ещё нет.
    const base = mkBaseline();
    const feed = () => [{ serverName: 'RO1-MF289', status: [{ modem_details: { IMEI: 'i2', NICK: 'RO1_01' }, net_details: { CELLOP: 'orange' } }], ports: { i2: [{ portID: 'pX', portName: 'Brandanalytics' }] }, bw: { pX: bw('10.7 GB', '1.9 GB') } }];
    const cells = computeLiveCells(feed(), HK, base.get, base.upsert, {}, {}, (raw) => (raw === 'orange' ? 'Orange RO' : raw));
    expect(cells).toEqual([]);   // НЕ 12.6 ГБ фантома
    // Через «минуту» (+100 MB) — живое значение только за этот прирост.
    const feed2 = () => [{ serverName: 'RO1-MF289', status: [{ modem_details: { IMEI: 'i2', NICK: 'RO1_01' }, net_details: { CELLOP: 'orange' } }], ports: { i2: [{ portID: 'pX', portName: 'Brandanalytics' }] }, bw: { pX: bw('10.8 GB', '1.9 GB') } }];
    const cells2 = computeLiveCells(feed2(), HK, base.get, base.upsert, {}, {}, (raw) => (raw === 'orange' ? 'Orange RO' : raw));
    expect(cells2).toEqual([{ server: 'RO1-MF289', client: 'Brandanalytics', operator: 'Orange RO', bytes: 100e6 }]);
  });

  it('протухший фид, пустой клиент, отрицательная дельта — мимо', () => {
    const base = mkBaseline({
      S1_p3: { hour_key: HK, bytes: 300e6 },   // текущий < baseline (сброс внутри часа) — пропуск
    });
    const results = [
      { serverName: 'S1', bw: {
        p3: bw('100 MB', '50 MB'),
        p4: bw('500 MB', '100 MB'),
      }, status: [{ modem_details: { IMEI: 'i1', NICK: 'MD_1' }, net_details: { CELLOP: 'x' } }], ports: { i1: [{ portID: 'p3', portName: 'WildBox' }, { portID: 'p4', portName: '' }] } },
      { serverName: 'S3', _cached: true, bw: { p9: bw('10 GB', '1 GB') } },
    ];
    base.upsert.run('S1_p4', HK, 100e6);
    const cells = computeLiveCells(results, HK, base.get, base.upsert, {}, {}, (x) => x);
    expect(cells).toEqual([]);   // p4 без клиента (UNBOUND_FILTER), p3 отрицательная дельта, S3 протух
  });

  it('оператор резолвится из живого CELLOP (нормализованный), CELLOP=unknown → fallback на opMap', () => {
    const base = mkBaseline({ RO1_p1: { hour_key: HK, bytes: 0 }, S1_p1: { hour_key: HK, bytes: 0 } });
    const results = [
      { serverName: 'RO1', status: [{ modem_details: { IMEI: 'imei1', NICK: 'RO1_12' }, net_details: { CELLOP: 'digi' } }], ports: { imei1: [{ portID: 'p1', portName: 'Brandanalytics' }] }, bw: { p1: bw('900 MB', '100 MB') } },
      { serverName: 'S1', status: [{ modem_details: { IMEI: 'imei2', NICK: 'MD_1' }, net_details: { CELLOP: 'unknown' } }], ports: { imei2: [{ portID: 'p1', portName: 'Brandanalytics' }] }, bw: { p1: bw('1 GB', '0 GB') } },
    ];
    const opMap = { RO1_p1: { operator: 'Orange RO' }, S1_p1: { operator: 'Moldcell', client_name: 'Brandanalytics' } };
    const cells = computeLiveCells(results, HK, base.get, base.upsert, {}, opMap, (raw) => (raw === 'digi' ? 'Digi' : raw));
    expect(cells.find((c) => c.server === 'RO1').operator).toBe('Digi');
    expect(cells.find((c) => c.server === 'S1').operator).toBe('Moldcell');
  });
});
