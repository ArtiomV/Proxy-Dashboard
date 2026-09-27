// 2026-09-27: атрибуция оператора «на дату чтения» в разбивках хитмапа.
// История в traffic_hourly НЕ переписывается: пустой/легаси-'unknown'
// оператор backfill'ится в SELECT'е из самой свежей непустой строки того же
// порта в пределах запрошенного периода (operatorAttributionCase в
// src/db/traffic.js). Без известного оператора за период — группа
// 'Неизвестный', молча с реальным оператором такие строки не смешиваются.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const analyticsDb = require('../src/db/analytics.js');

let db;

const START = '2026-09-20 00:00';

function addRow(portId, nick, operator, hourStart, bytes) {
  db.prepare(`INSERT INTO traffic_hourly (server_name, port_id, nick, operator, client_name, hour_start, bytes_in, bytes_out, uncertain)
    VALUES ('S1',?,?,?,?,?,?,0,0)`).run(portId, nick, operator, 'cli', hourStart, bytes);
}

function opRows(start = START) {
  const { sql, params } = analyticsDb.heatmapOperatorSql({
    tzStr: '+0 hours', start, view: 'country', id: 'all', servers: [],
  });
  return db.prepare(sql).all(...params);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE traffic_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT, port_id TEXT,
    nick TEXT, operator TEXT, client_name TEXT, hour_start TEXT,
    bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0,
    uncertain INTEGER NOT NULL DEFAULT 0,
    UNIQUE(port_id, hour_start)
  )`);
});

describe('heatmapOperatorSql: группа «Неизвестный» (2026-09-27)', () => {
  it("пустой, NULL и легаси-'unknown' оператор группируются как 'Неизвестный'", () => {
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);
    addRow('S1_pB', 'MD_2', 'unknown', '2026-09-21 10:00', 2e9);
    addRow('S1_pB', 'MD_2', null, '2026-09-21 11:00', 4e9);
    const rows = opRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.op === 'Неизвестный')).toBe(true);
    expect(rows.reduce((s, r) => s + r.bytes, 0)).toBe(7e9);
  });

  it('реальный оператор не смешивается с «Неизвестным»', () => {
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);
    addRow('S1_pC', 'MD_3', 'Moldcell', '2026-09-21 10:00', 2e9);
    const rows = opRows();
    const byOp = {};
    for (const r of rows) byOp[r.op] = (byOp[r.op] || 0) + r.bytes;
    expect(byOp['Неизвестный']).toBe(1e9);
    expect(byOp['Moldcell']).toBe(2e9);
  });
});

describe('heatmapOperatorSql: backfill пустого оператора из свежей строки порта', () => {
  it('пустые часы приписываются свежему оператору того же порта в пределах периода', () => {
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);
    addRow('S1_pA', 'MD_1', 'Moldcell', '2026-09-22 10:00', 2e9);
    const rows = opRows();
    expect(rows.every(r => r.op === 'Moldcell')).toBe(true);
    expect(rows.reduce((s, r) => s + r.bytes, 0)).toBe(3e9);
  });

  it('backfill ограничен периодом: оператор, известный только ДО start, не подставляется', () => {
    addRow('S1_pA', 'MD_1', 'Moldcell', '2026-09-19 10:00', 9e9);   // до START
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);
    const rows = opRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('Неизвестный');
    expect(rows[0].bytes).toBe(1e9);
  });

  it('строки с реальным оператором backfill не трогает (SIM переехала — старые часы остаются за старым оператором)', () => {
    addRow('S1_pA', 'MD_1', 'Orange MD', '2026-09-21 10:00', 1e9);
    addRow('S1_pA', 'MD_1', 'Moldcell', '2026-09-22 10:00', 2e9);
    const rows = opRows();
    const byOp = {};
    for (const r of rows) byOp[r.op] = (byOp[r.op] || 0) + r.bytes;
    expect(byOp['Orange MD']).toBe(1e9);
    expect(byOp['Moldcell']).toBe(2e9);
    expect(byOp['Неизвестный']).toBeUndefined();
  });

  it('backfill — по порту, а не по нику: чужой порт с тем же оператором не влияет', () => {
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);          // у порта истории нет
    addRow('S1_pB', 'MD_1', 'Moldcell', '2026-09-22 10:00', 2e9);  // тот же nick, другой порт
    const rows = opRows();
    const byOp = {};
    for (const r of rows) byOp[r.op] = (byOp[r.op] || 0) + r.bytes;
    expect(byOp['Неизвестный']).toBe(1e9);
    expect(byOp['Moldcell']).toBe(2e9);
  });
});

describe('heatmapSql view=operator: фильтр по оператору «на дату чтения»', () => {
  function matrixRows(idKey) {
    const { sql, params } = analyticsDb.heatmapSql({
      tzStr: '+0 hours', start: START, view: 'operator', idKey, id: idKey, servers: [],
    });
    return db.prepare(sql).all(...params);
  }

  it('пустые часы порта с известным свежим оператором попадают в его матрицу', () => {
    addRow('S1_pA', 'MD_1', '', '2026-09-21 10:00', 1e9);
    addRow('S1_pA', 'MD_1', 'Moldcell', '2026-09-22 10:00', 2e9);
    const rows = matrixRows('moldcell');
    expect(rows.reduce((s, r) => s + r.bytes, 0)).toBe(3e9);
  });

  it('порт без известного оператора в периоде в матрицу оператора не попадает', () => {
    addRow('S1_pB', 'MD_2', '', '2026-09-21 10:00', 5e9);
    expect(matrixRows('moldcell')).toHaveLength(0);
  });

  it('фильтр country/client и общая матрица (id=all) не изменились по параметрам', () => {
    addRow('S1_pA', 'MD_1', 'Moldcell', '2026-09-21 10:00', 1e9);
    const all = analyticsDb.heatmapSql({ tzStr: '+0 hours', start: START, view: 'country', idKey: 'all', id: 'all', servers: [] });
    expect(db.prepare(all.sql).all(...all.params).reduce((s, r) => s + r.bytes, 0)).toBe(1e9);
    const client = analyticsDb.heatmapSql({ tzStr: '+0 hours', start: START, view: 'client', idKey: 'cli', id: 'cli', servers: [] });
    expect(db.prepare(client.sql).all(...client.params).reduce((s, r) => s + r.bytes, 0)).toBe(1e9);
  });
});
