// 25.08: нормализация ICCID в tracking. ProxySmart иногда отдаёт ICCID
// с техническим суффиксом-филлером «F» (8937…82F). Храним и сравниваем
// только цифры: иначе одна и та же SIM периодически выглядела как замена
// и плодила ложные sim_iccid_changed.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { create } = require('../src/jobs/modem-tracking.js');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const IMEI = '355151062286001';

function mkDeps({ storedIccid, feedIccid }) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE modem_meta (server_name TEXT, imei TEXT, nick TEXT, deleted INTEGER DEFAULT 0)');
  const fired = [];
  const upserts = [];
  const deps = {
    apiServers: [{ name: 'S1' }],
    fetchServerData: async () => ({
      status: [{
        modem_details: { IMEI, NICK: 'MD1_01', IS_ONLINE: 'yes' },
        net_details: { ICCID: feedIccid },
      }],
      bw: {}, ports: {},
    }),
    db, logger: silentLogger, logActivity() {},
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    SERVER_COUNTRIES: {}, normalizeOperator: (s) => s, operatorsDb: {},
    fetchApi: async () => ({}), postFormApi: async () => ({}),
    recordIpChange() {}, saveIpTracking() {}, saveUptimeTracking() {},
    _serverDownSince: {}, _serverUnreachableAlertSent: {},
    uptimeTracking: { [`S1_${IMEI}`]: { last_online_check: new Date().toISOString(), daily: {} } },
    ipTracking: {}, offlineAlertSent: {}, autoRecovery: {},
    appSettings: { modems_down_threshold: 1, modem_offline_threshold_min: 10, stale_modem_hours: 12 },
    knownModems: {},
    _downSince: {},
    _alertEnabledAt: 0,
    _metaOpGetByImei: { get: () => null },
    _modemMetaUpsert: { run: (...args) => upserts.push(args) },
    _metaIccidGetByImei: { get: () => (storedIccid ? { iccid: storedIccid } : null) },
    _deletedModemSet: new Set(),
  };
  return { deps, fired, upserts };
}

describe('ICCID normalization (25.08)', () => {
  it('суффикс F у сохранённого значения — не «замена SIM», алерт не стреляет', async () => {
    const { deps, fired, upserts } = mkDeps({
      storedIccid: '8937312345678901234F',           // старая сырая запись с филлером
      feedIccid: '8937312345678901234',              // тот же SIM без суффикса
    });
    const job = create(deps);
    await job.trackModems();
    expect(fired.filter(a => a.rule === 'sim_iccid_changed')).toEqual([]);
    // В upsert уходит нормализованное значение — только цифры (iccid — 13-й аргумент)
    expect(upserts[0][12]).toBe('8937312345678901234');
  });

  it('суффикс F у свежего значения — тоже не замена', async () => {
    const { deps, fired } = mkDeps({
      storedIccid: '8937312345678901234',
      feedIccid: '8937312345678901234F',
    });
    const job = create(deps);
    await job.trackModems();
    expect(fired.filter(a => a.rule === 'sim_iccid_changed')).toEqual([]);
  });

  it('реальная смена ICCID — алерт с нормализованными значениями', async () => {
    const { deps, fired, upserts } = mkDeps({
      storedIccid: '8937312345678901234',
      feedIccid: '8937312345678909999F',
    });
    const job = create(deps);
    await job.trackModems();
    const alert = fired.find(a => a.rule === 'sim_iccid_changed');
    expect(alert).toBeTruthy();
    expect(alert.payload.old_iccid).toBe('8937312345678901234');
    expect(alert.payload.new_iccid).toBe('8937312345678909999');
    expect(upserts[0][12]).toBe('8937312345678909999');
  });

  it('первая запись ICCID — не смена, алерта нет', async () => {
    const { deps, fired } = mkDeps({ storedIccid: null, feedIccid: '8937312345678901234' });
    const job = create(deps);
    await job.trackModems();
    expect(fired.filter(a => a.rule === 'sim_iccid_changed')).toEqual([]);
  });

  it('номер из реестра SIM важнее номера от бокса (26.08)', async () => {
    const { deps, upserts } = mkDeps({ storedIccid: null, feedIccid: '8937312345678901234' });
    // Бокс отдаёт устаревший номер, в реестре — актуальный
    deps.fetchServerData = async () => ({
      status: [{
        modem_details: { IMEI, NICK: 'MD1_01', IS_ONLINE: 'yes', PHONE_NUMBER: '+37360000000' },
        net_details: { ICCID: '8937312345678901234' },
      }],
      bw: {}, ports: {},
    });
    deps._simRegistryPhoneByIccid = { get: () => ({ phone: '+37360111222' }) };
    const job = create(deps);
    await job.trackModems();
    // phone — 6-й аргумент upsert
    expect(upserts[0][5]).toBe('+37360111222');
  });

  it('без записи в реестре используется номер бокса', async () => {
    const { deps, upserts } = mkDeps({ storedIccid: null, feedIccid: '8937312345678901234' });
    deps.fetchServerData = async () => ({
      status: [{
        modem_details: { IMEI, NICK: 'MD1_01', IS_ONLINE: 'yes', PHONE_NUMBER: '+37360000000' },
        net_details: { ICCID: '8937312345678901234' },
      }],
      bw: {}, ports: {},
    });
    deps._simRegistryPhoneByIccid = { get: () => null };
    const job = create(deps);
    await job.trackModems();
    expect(upserts[0][5]).toBe('+37360000000');
  });
});
