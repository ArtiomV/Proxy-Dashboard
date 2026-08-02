// updateKnownModems — стабильный total клиента (2026-08-02, БА «31 вместо 32»).
// Биндинг порта в list_ports_json авторитетен: порт мёртвого модема остаётся
// в ростере (total не падает), а удалённый на боксе (нет ни в ports, ни в bw)
// — выбывает. Soft-deleted модемы не ингестятся.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { create } = require('../src/services/modems.js');

function mkDeps(over = {}) {
  return {
    db: { prepare: () => ({ all: () => [] }) },
    logger: { info() {}, warn() {}, error() {} },
    knownModems: {},
    saveKnownModems() {},
    deletedModemSet: new Set(),
    appSettings: {},
    trackingDb: { metaListRecentForServerStmt: () => ({ all: () => [] }) },
    ...over,
  };
}

const bwRow = (portName) => ({
  portName, bandwidth_bytes_day_in: '0 B', bandwidth_bytes_day_out: '0 B',
});

describe('updateKnownModems: стабильный total по биндингам бокса', () => {
  it('порт мёртвого модема (есть в ports, нет в bw) попадает в ростер', () => {
    const deps = mkDeps();
    const svc = create(deps);
    svc.updateKnownModems({
      serverName: 'S2',
      bw: { portA: bwRow('Brandanalytics') },
      ports: {
        IMEI1: [{ portID: 'portA', portName: 'Brandanalytics' }, { portID: 'portB', portName: 'Brandanalytics' }],
      },
      status: [],
    });
    const km = deps.knownModems.S2;
    expect(Object.keys(km).sort()).toEqual(['portA', 'portB']);
    expect(km.portB.portName).toBe('Brandanalytics');
    expect(km.portB.imei).toBe('IMEI1');
  });

  it('порт, удалённый на боксе, выбывает после 24ч грейса (флап не удаляет)', () => {
    const deps = mkDeps();
    const svc = create(deps);
    const feed = {
      serverName: 'S2',
      bw: { portA: bwRow('Brandanalytics') },
      ports: { IMEI1: [{ portID: 'portA', portName: 'Brandanalytics' }, { portID: 'portB', portName: 'Brandanalytics' }] },
      status: [],
    };
    svc.updateKnownModems(feed);
    expect(Object.keys(deps.knownModems.S2).sort()).toEqual(['portA', 'portB']);
    // Бокс потерял portB (флап пере-энумерации) — грейс: сразу НЕ удаляем.
    const feedNoB = {
      serverName: 'S2',
      bw: { portA: bwRow('Brandanalytics') },
      ports: { IMEI1: [{ portID: 'portA', portName: 'Brandanalytics' }] },
      status: [],
    };
    svc.updateKnownModems(feedNoB);
    expect(Object.keys(deps.knownModems.S2).sort()).toEqual(['portA', 'portB']);
    expect(deps.knownModems.S2.portB._missingSince).toBeTruthy();
    // Порт вернулся — метка грейса снимается.
    svc.updateKnownModems(feed);
    expect(deps.knownModems.S2.portB._missingSince).toBeUndefined();
    // А если отсутствует дольше 24ч — удаляем (отвязка на боксе).
    svc.updateKnownModems(feedNoB);
    deps.knownModems.S2.portB._missingSince = Date.now() - 25 * 3600 * 1000;
    svc.updateKnownModems(feedNoB);
    expect(Object.keys(deps.knownModems.S2)).toEqual(['portA']);
  });

  it('порт soft-deleted модема не ингестится', () => {
    const deps = mkDeps({ deletedModemSet: new Set(['S2|IMEI_DEAD']) });
    const svc = create(deps);
    svc.updateKnownModems({
      serverName: 'S2',
      bw: {},
      ports: { IMEI_DEAD: [{ portID: 'portD', portName: 'Brandanalytics' }] },
      status: [],
    });
    expect(deps.knownModems.S2).toEqual({});
  });

  it('пустой/сломанный ports — ростер не трогаем (fail-open)', () => {
    const deps = mkDeps();
    deps.knownModems.S2 = { portA: { portName: 'Brandanalytics', imei: 'I1', lastSeen: 1, lastClientSeen: 1 } };
    const svc = create(deps);
    svc.updateKnownModems({ serverName: 'S2', bw: {}, ports: {}, status: [] });
    expect(Object.keys(deps.knownModems.S2)).toEqual(['portA']);
  });
});
