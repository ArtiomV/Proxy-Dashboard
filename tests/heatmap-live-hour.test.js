// 2026-09-27: «живая ячейка» текущего часа в хитмапе почасового трафика.
// traffic_hourly пишется по завершении часа — до этого превью считается из
// bw-счётчиков боксов минус baseline часового снапшота
// (hourly_snapshots.day_at_last_hour_start_*).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeLiveCells } = require('../src/routes/analytics.js');

const snapStmtFor = (map) => ({ get: (id) => map[id] });
const bw = (inn, out) => ({ bandwidth_bytes_day_in: inn, bandwidth_bytes_day_out: out });

describe('heatmap live hour: частичный трафик незавершённого часа', () => {
  it('дельта от часового baseline; пустой клиент/протухший фид/отрицательная дельта — мимо', () => {
    const results = [
      { serverName: 'S1', bw: {
        p1: bw('700 MB', '300 MB'),   // 1 GB − 0.5 GB baseline = 0.5 GB
        p2: bw('200 MB', '100 MB'),   // нет снапшота — пропуск
        p3: bw('100 MB', '50 MB'),    // дельта отрицательная (сброс внутри часа) — пропуск
        p4: bw('500 MB', '100 MB'),   // клиента нет в pnMap/opMap — пропуск (UNBOUND_FILTER)
      } },
      { serverName: 'S3', _cached: true, bw: { p9: bw('10 GB', '1 GB') } },   // протухший фид — пропуск
    ];
    const snaps = snapStmtFor({
      'S1_p1': { i: 400e6, o: 100e6 },
      'S1_p3': { i: 200e6, o: 100e6 },
      'S1_p4': { i: 0, o: 0 },
      'S3_p9': { i: 0, o: 0 },
    });
    const pnMap = { S1_p1: 'Brandanalytics' };
    const opMap = { S1_p1: { operator: 'Moldcell' }, S1_p4: { operator: 'Orange MD', client_name: '' } };

    const cells = computeLiveCells(results, snaps, pnMap, opMap);
    expect(cells).toEqual([
      { server: 'S1', client: 'Brandanalytics', operator: 'Moldcell', bytes: 500e6 },
    ]);
  });

  it('клиент подхватывается из traffic_hourly (opMap), если в pnMap порта нет', () => {
    const results = [{ serverName: 'S1', bw: { p1: bw('1.2 GB', '0 GB') } }];
    const snaps = snapStmtFor({ S1_p1: { i: 200e6, o: 0 } });
    const cells = computeLiveCells(results, snaps, {}, { S1_p1: { operator: 'Orange RO', client_name: 'WildBox' } });
    expect(cells).toEqual([{ server: 'S1', client: 'WildBox', operator: 'Orange RO', bytes: 1e9 }]);
  });
});

describe('heatmap live hour: оператор порта из живого фида', () => {
  it('живой CELLOP (нормализованный) побеждает устаревший opMap; порт маппится по IMEI→portID как в hourly-агрегации', () => {
    const results = [{
      serverName: 'RO1',
      status: [{ modem_details: { IMEI: 'imei1', NICK: 'RO1_12' }, net_details: { CELLOP: 'digi' } }],
      ports: { imei1: [{ portID: 'p1', portName: 'Brandanalytics' }] },
      bw: { p1: bw('900 MB', '100 MB') },
    }];
    const snaps = snapStmtFor({ RO1_p1: { i: 0, o: 0 } });
    const opMap = { RO1_p1: { operator: 'Orange RO', client_name: 'Brandanalytics' } };   // устаревший
    const cells = computeLiveCells(results, snaps, {}, opMap, (raw) => (raw === 'digi' ? 'Digi' : raw));
    expect(cells).toEqual([{ server: 'RO1', client: 'Brandanalytics', operator: 'Digi', bytes: 1e9 }]);
  });

  it('CELLOP=unknown → fallback на opMap', () => {
    const results = [{
      serverName: 'S1',
      status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD_1' }, net_details: { CELLOP: 'unknown' } }],
      ports: { imei1: [{ portID: 'p1', portName: 'Brandanalytics' }] },
      bw: { p1: bw('1 GB', '0 GB') },
    }];
    const snaps = snapStmtFor({ S1_p1: { i: 0, o: 0 } });
    const cells = computeLiveCells(results, snaps, {}, { S1_p1: { operator: 'Moldcell', client_name: 'Brandanalytics' } }, (raw) => raw);
    expect(cells[0].operator).toBe('Moldcell');
  });
});

describe('heatmap live hour: анти-фантом на задушенном модеме (MD2_39)', () => {
  it('порт на throttled-модеме клампится к 0.4 ГБ, на живом — нет', () => {
    const mkFeed = (imei, nick, cellop, dayIn, dayOut) => [{
      serverName: 'S1',
      status: [{ modem_details: { IMEI: imei, NICK: nick }, net_details: { CELLOP: cellop } }],
      ports: { [imei]: [{ portID: 'p1', portName: 'WildBox' }] },
      bw: { p1: bw(dayIn, dayOut) },
    }];
    const snaps = snapStmtFor({ S1_p1: { i: 0, o: 0 } });
    // 2 ГБ/час на задушенном модеме — фантом, кламп к 0.4 ГБ
    let cells = computeLiveCells(mkFeed('i1', 'MD2_39', 'moldcell', '1.0 GB', '1.0 GB'), snaps, {}, {},
      (raw) => raw, () => true);
    expect(cells[0].bytes).toBe(400e6);
    // тот же объём на живом модеме — без клампа
    cells = computeLiveCells(mkFeed('i1', 'MD2_39', 'moldcell', '1.0 GB', '1.0 GB'), snaps, {}, {},
      (raw) => raw, () => false);
    expect(cells[0].bytes).toBe(2e9);
    // без isExhaustedFn — прежнее поведение
    cells = computeLiveCells(mkFeed('i1', 'MD2_39', 'moldcell', '1.0 GB', '1.0 GB'), snaps, {}, {});
    expect(cells[0].bytes).toBe(2e9);
  });
});
