// 2026-10-01: warn server_unreachable в system_log — только со ВТОРОГО подряд
// сбоя или при простое ≥2 мин. reset_gently на S4 блочит панель ~60с каждые
// 5 мин → одиночный failed poll = микроблип; ~335 шумных warn/сутки в ленте.
// Реальные простои логируются со 2-го полла (~2 мин), downtime/TG не тронуты.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { create } = require('../src/jobs/modem-tracking.js');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function mkDeps(fetchServerData) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE modem_meta (server_name TEXT, imei TEXT, nick TEXT, deleted INTEGER DEFAULT 0)');
  const logs = [];
  const fired = [];
  const deps = {
    apiServers: [{ name: 'S4' }],
    fetchServerData,
    db, logger: silentLogger,
    logActivity: (cat, level, action, target, message) => logs.push({ cat, level, action, target }),
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; }, clearCooldown() {} },
    SERVER_COUNTRIES: {}, normalizeOperator: (s) => s, operatorsDb: {},
    fetchApi: async () => ({}), postFormApi: async () => ({}),
    recordIpChange() {}, saveIpTracking() {}, saveUptimeTracking() {},
    _serverDownSince: {}, _serverUnreachableAlertSent: {},
    uptimeTracking: {}, ipTracking: {}, offlineAlertSent: {}, autoRecovery: {},
    appSettings: {},
    knownModems: { S4: {} },
    _downSince: {}, _alertEnabledAt: 0,
    _metaOpGetByImei: () => null, _modemMetaUpsert() {}, _metaIccidGetByImei: () => null,
    _deletedModemSet: new Set(),
  };
  return { deps, logs, fired };
}

const boom = async () => { throw new Error('Timeout from S4'); };
const ok = async () => ({ status: [] });

describe('server_unreachable: микроблипы не шумят в system_log', () => {
  it('1-й сбой подряд — молча; 2-й — warn; успех сбрасывает серию', async () => {
    let fail = true;
    const { deps, logs } = mkDeps(async () => (fail ? boom() : ok()));
    const job = create(deps);

    await job.trackModems();   // сбой №1 — микроблип, warn быть не должно
    expect(logs.filter(l => l.action === 'server_unreachable').length).toBe(0);
    expect(deps._serverDownSince['S4']).toBeDefined();   // даун трекается с 1-го сбоя

    await job.trackModems();   // сбой №2 — реальный простой, warn
    expect(logs.filter(l => l.action === 'server_unreachable').length).toBe(1);

    fail = false;
    await job.trackModems();   // восстановился — серия сброшена
    fail = true;
    await job.trackModems();   // снова 1-й сбой — снова молча
    expect(logs.filter(l => l.action === 'server_unreachable').length).toBe(1);
  });

  it('одиночный сбой при простое ≥2 мин — warn даже на 1-й серии', async () => {
    const { deps, logs } = mkDeps(boom);
    deps._serverDownSince['S4'] = Date.now() - 3 * 60000;   // уже 3 мин в дауне
    const job = create(deps);
    await job.trackModems();
    expect(logs.filter(l => l.action === 'server_unreachable').length).toBe(1);
  });
});
