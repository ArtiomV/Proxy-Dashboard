// Регрессия 2026-07-29: soft-deleted модемы (modem_meta.deleted=1) попадали
// в сводный TG-алерт «🚨 Не работает модемов: N» (modems_down_bulk) и
// пере-алертились после каждого рестарта: их записи в _downSince не могли
// закрыться «recovery» (модем удалён навсегда) и нигде не проверялся флаг
// deleted. Фикс: фильтр по _deletedModemSet в offline-алерте + janitor
// _downSince в сводке.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { create } = require('../src/jobs/modem-tracking.js');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function mkDeps() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE modem_meta (server_name TEXT, imei TEXT, nick TEXT, deleted INTEGER DEFAULT 0)');
  db.prepare("INSERT INTO modem_meta (server_name,imei,nick,deleted) VALUES ('S4','111','MD_DEL',1)").run();
  db.prepare("INSERT INTO modem_meta (server_name,imei,nick,deleted) VALUES ('S4','222','MD_REAL',0)").run();
  const fired = [];
  const now = Date.now();
  const deps = {
    apiServers: [{ name: 'S4' }],
    fetchServerData: async () => ({ status: [] }),   // оба модема выпали из фида
    db, logger: silentLogger, logActivity() {},
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    SERVER_COUNTRIES: {}, normalizeOperator: (s) => s, operatorsDb: {},
    fetchApi: async () => ({}), postFormApi: async () => ({}),
    recordIpChange() {}, saveIpTracking() {}, saveUptimeTracking() {},
    _serverDownSince: {}, _serverUnreachableAlertSent: {},
    uptimeTracking: {
      'S4_111': { last_online_check: new Date(now - 30 * 60000).toISOString(), daily: {} },
      'S4_222': { last_online_check: new Date(now - 30 * 60000).toISOString(), daily: {} },
    },
    ipTracking: {}, offlineAlertSent: {}, autoRecovery: {},
    appSettings: { modems_down_threshold: 1, modem_offline_threshold_min: 10, stale_modem_hours: 12 },
    knownModems: { S4: { p1: { imei: '111', nick: 'MD_DEL' }, p2: { imei: '222', nick: 'MD_REAL' } } },
    _downSince: { 'S4_111': now - 5000 * 60000 },   // застрявшая запись удалённого модема
    _alertEnabledAt: 0,
    _metaOpGetByImei: () => null, _modemMetaUpsert() {}, _metaIccidGetByImei: () => null,
    _deletedModemSet: new Set(['S4|111']),
  };
  return { deps, fired };
}

describe('modems_down_bulk: soft-deleted модемы не алертят и не попадают в сводку', () => {
  it('deleted: нет modem_offline_20m, _downSince вычищен, сводка только по живому', async () => {
    const { deps, fired } = mkDeps();
    const job = create(deps);
    await job.trackModems();

    const offlineAlerts = fired.filter(f => f.rule === 'modem_offline_20m');
    expect(offlineAlerts.map(a => a.payload.imei)).toEqual(['222']);   // алерт только по живому
    expect(deps._downSince['S4_111']).toBeUndefined();                  // janitor вычистил труп
    expect(deps._downSince['S4_222']).toBeDefined();                    // живой учтён

    const bulk = fired.filter(f => f.rule === 'modems_down_bulk');
    expect(bulk.length).toBe(1);
    expect(bulk[0].payload.count).toBe(1);
    expect(bulk[0].payload.list).toContain('MD_REAL');
    expect(bulk[0].payload.list).not.toContain('MD_DEL');
  });
});
