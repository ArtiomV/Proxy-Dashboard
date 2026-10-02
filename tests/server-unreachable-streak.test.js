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

// 2026-10-03: блип недоступности бокса ≠ «все модемы оффлайн». Тики вообще не
// пишутся на failed poll (нет наблюдения); подтверждённый простой (≥2 мин)
// бэкфиллится минутами оффлайна при восстановлении.
describe('аптайм модемов при недоступности бокса', () => {
  it('блип: total_checks не растёт; восстановление после ≥2 мин: бэкфилл минут как failed', async () => {
    let fail = true;
    const { deps } = mkDeps(async () => (fail ? boom() : ok()));
    deps.uptimeTracking['S4_222'] = { total_checks: 100, online_checks: 100, daily: {}, last_online_check: new Date().toISOString() };
    deps.knownModems.S4.p2 = { imei: '222', nick: 'MD_REAL', portName: 'Brandanalytics' };
    const job = create(deps);

    await job.trackModems();   // блип — один failed poll
    expect(deps.uptimeTracking['S4_222'].total_checks).toBe(100);   // ничего не записано

    // Простой 3 минуты: бокс вернулся — минуты бэкфиллятся как failed.
    deps._serverDownSince['S4'] = Date.now() - 3 * 60000;
    fail = false;
    await job.trackModems();
    expect(deps.uptimeTracking['S4_222'].total_checks).toBe(104);   // +3 мин бэкфилл + 1 тик цикла
    expect(deps.uptimeTracking['S4_222'].online_checks).toBe(100);  // онлайн не вырос (всё failed)
  });
});
