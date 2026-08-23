'use strict';
//
// 23.08: durable-fallback в дневном биллинге. Если бокс клиента недоступен
// в момент прогона (cached data / сервер не отвечает), клиент НЕ
// пропускается, когда durable-источник (traffic_hourly) уже содержит его
// вчерашний трафик — списание идёт по durable-данным, а расхождение потом
// ловит ShadowBilling. Пропуск + retry — только когда durable тоже пуст.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const billingJob = require('../src/jobs/billing');

function mkDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traffic_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL DEFAULT '', port_id TEXT NOT NULL DEFAULT '',
    nick TEXT NOT NULL DEFAULT '', operator TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '', hour_start TEXT NOT NULL,
    bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0)`);
  return db;
}

function mkDeps(overrides = {}) {
  const db = mkDb();
  const debits = [];
  const deps = {
    db,
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {},
    fetchAllServersData: async () => overrides.results || [],
    refreshPortKeyMapping() {},
    getMoscowYesterday: () => '2026-08-22',
    getMoscowNow: () => new Date('2026-08-23T01:00:00+03:00'),
    ledgerDb: {
      existsChargeOnDate: () => false,
      chargedClientIdsForDate: () => [],
    },
    clients: overrides.clients || [],
    dailyTraffic: {},
    recordDailyTraffic() {},
    parseBwToBytes: (s) => (typeof s === 'number' ? s : 0),
    trafficBytesToGb: (b) => Math.round(b / 1e9 * 1000) / 1000,
    getClientCachedServers: (results, portName) => overrides.cachedServers || [],
    apiServers: overrides.apiServers || [{ name: 'S2' }],
    getClientBytesForMskDate: overrides.durableBytes != null
      ? () => overrides.durableBytes
      : () => 0,
    computeClientYesterdayBytes: () => overrides.liveBytes || 0,
    computeClientMonthBytes: () => 0,
    atomicDebit: (id, cost, meta) => { debits.push({ id, cost, meta }); return { balanceBefore: 1000, balanceAfter: 1000 - cost }; },
    modemPlural: (n) => 'модема',
    appSettings: {},
    alerts: { trigger: () => true },
    saveClients() {},
    saveDailyTraffic() {},
    withClientsLock: (fn) => fn(),
    setLastBillingRunSummary() {},
    tariffsDb: null,
  };
  return { deps, debits, db };
}

const baseClient = {
  id: 'c1', name: 'TestClient', portName: 'TestPN',
  price: 23, billingType: 'per_gb',
};

describe('billing durable-fallback (23.08)', () => {
  it('бокс в кеше + durable-данные есть → клиент БИЛЛИТСЯ по durable', async () => {
    const { deps, debits } = mkDeps({
      clients: [{ ...baseClient }],
      cachedServers: ['S2'],
      durableBytes: 1123e9,          // traffic_hourly за вчера
      liveBytes: 0,
    });
    await billingJob.create(deps).runDailyBilling();
    expect(debits.length).toBe(1);
    expect(debits[0].meta.traffic_source).toBe('daily_billing_durable_fallback');
    expect(debits[0].meta.fallback_reason).toContain('S2');
  });

  it('бокс в кеше + durable пуст → пропуск + retry, как раньше', async () => {
    const { deps, debits } = mkDeps({
      clients: [{ ...baseClient }],
      cachedServers: ['S2'],
      durableBytes: 0,
      liveBytes: 0,
    });
    await billingJob.create(deps).runDailyBilling();
    expect(debits.length).toBe(0);
  });

  it('все серверы живы → обычный прогон без fallback-маркера', async () => {
    const { deps, debits } = mkDeps({
      clients: [{ ...baseClient }],
      results: [{ serverName: 'S2', bw: {} }],
      cachedServers: [],
      durableBytes: 50e9,
      liveBytes: 50e9,
    });
    await billingJob.create(deps).runDailyBilling();
    expect(debits.length).toBe(1);
    expect(debits[0].meta.traffic_source).toBe('daily_billing');
    expect(debits[0].meta.fallback_reason).toBeUndefined();
  });

  it('per_modem при fallback: число модемов берётся из traffic_hourly, если live пуст', async () => {
    const { deps, debits, db } = mkDeps({
      clients: [{ ...baseClient, billingType: 'per_modem', price: 3100 }],
      cachedServers: ['S2'],
      durableBytes: 0,   // per_modem проходит по типу биллинга, не по байтам
    });
    db.prepare(`INSERT INTO traffic_hourly (server_name, nick, client_name, hour_start, bytes_in) VALUES
      ('S2','MD_1','TestPN','2026-08-21 22:00',1),
      ('S2','MD_2','TestPN','2026-08-22 01:00',1),
      ('S2','MD_2','TestPN','2026-08-22 02:00',1)`).run();
    await billingJob.create(deps).runDailyBilling();
    expect(debits.length).toBe(1);
    // 2 distinct nick за 22.08 (МСК), 31 день в августе: 3100*2/31 = 200
    expect(debits[0].cost).toBe(200);
    expect(debits[0].meta.modem_count).toBe(2);
  });
});
