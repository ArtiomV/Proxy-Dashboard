// BlockedPortCleanup (21.08): автоудаление портов заблокированных клиентов
// после истечения hold (retail_hold_days от blocked_since, миграция 073).
// Проверяем условия населения (ручной/долговой блок, юрлица — никогда,
// hold ещё идёт / blocked_since отсутствует) и механику delete_port + алерты.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const cleanupMod = require('../src/jobs/blocked-port-cleanup.js');

const NOW = new Date('2026-08-21T10:00:00+03:00');   // МСК
const OLD = '2026-08-10T10:00:00.000Z';              // 11 дней назад — hold истёк
const FRESH = '2026-08-21T08:00:00.000Z';            // 2 часа назад — hold идёт

let deleted, deleteFails, alertsFired, audited, activity, notified;

function mkDeps({ holdDays = '2', clientsList = [] } = {}) {
  deleted = []; deleteFails = new Set(); alertsFired = []; audited = []; activity = []; notified = [];
  const server = { name: 'S1', apiUrl: 'http://s1' };
  return {
    logger: { info() {}, warn() {}, error() {} },
    logActivity: (cat, level, action, target) => activity.push({ cat, level, action, target }),
    auditLog: (who, action, details) => audited.push({ who, action, details }),
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    proxyConf: {
      getConfAction: async (srv, path) => {
        const m = path.match(/\/conf\/delete_port\/(.+)$/);
        const portId = m ? decodeURIComponent(m[1]) : path;
        if (deleteFails.has(portId)) return { ok: false, reason: 'boom' };
        deleted.push(portId);
        return { ok: true };
      },
    },
    fetchApi: async () => ({}),
    parseHtmlInputFields: () => ({}),
    findServer: () => server,
    proxySmart: { invalidateCache() {} },
    ledgerDb: { listByClient: () => [] },
    saveClients: () => {},
    getMoscowNow: () => new Date(NOW.getTime()),
    fetchAllServersDataCached: async () => [{
      serverName: 'S1',
      ports: { imei1: [{ portID: 'p1', portName: 'clientA', PROXY_VALID_BEFORE: '2026-08-21' }] },
    }],
    clients: clientsList,
    getSetting: (k, dflt) => (k === 'retail_hold_days' ? holdDays : dflt),
    notifyClient: async (c, text) => { notified.push({ id: c.id, text }); },
  };
}

function mkClient(overrides = {}) {
  return {
    id: 'c1', login: 'clienta', name: 'ClientA', portName: 'clientA',
    clientType: 'individual', allowDebt: false,
    blocked: true, debtBlocked: false, blockedSince: OLD,
    balance: -100, ...overrides,
  };
}

describe('blocked-port-cleanup: удаление портов после hold', () => {
  it('ручной блок, hold истёк → порт удалён, алерт + аудит + уведомление клиенту', async () => {
    const client = mkClient();
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    const stats = await job.runOnce();

    expect(deleted).toEqual(['p1']);
    expect(stats.deleted).toEqual(['p1']);
    expect(alertsFired.some(a => a.rule === 'blocked_ports_deleted')).toBe(true);
    expect(audited.some(a => a.action === 'blocked_port_deleted')).toBe(true);
    expect(notified.some(n => n.id === 'c1')).toBe(true);
  });

  it('долговой блок (debt_blocked), hold истёк → порт удалён', async () => {
    const client = mkClient({ blocked: false, debtBlocked: true });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    await job.runOnce();
    expect(deleted).toEqual(['p1']);
  });

  it('hold ещё идёт (blocked_since свежий) → не трогаем', async () => {
    const client = mkClient({ blockedSince: FRESH });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    const stats = await job.runOnce();
    expect(deleted).toEqual([]);
    expect(stats.candidates).toBe(0);
  });

  it('юрлицо заблокировано — НИКОГДА не удаляем', async () => {
    const client = mkClient({ clientType: 'legal' });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    await job.runOnce();
    expect(deleted).toEqual([]);
  });

  it('нет blocked_since (блок до миграции 073) → не трогаем', async () => {
    const client = mkClient({ blockedSince: null });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    await job.runOnce();
    expect(deleted).toEqual([]);
  });

  it('не заблокирован — не трогаем', async () => {
    const client = mkClient({ blocked: false, debtBlocked: false });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    await job.runOnce();
    expect(deleted).toEqual([]);
  });

  it('delete_port упал → порт в failed, клиент остаётся на следующий цикл, алерт не шлём', async () => {
    const client = mkClient();
    const deps = mkDeps({ clientsList: [client] });
    deleteFails.add('p1');
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(deleted).toEqual([]);
    expect(stats.failed).toEqual(['p1']);
    expect(alertsFired.some(a => a.rule === 'blocked_ports_deleted')).toBe(false);
  });

  it('порта на боксе уже нет → просто пропускаем (идемпотентно)', async () => {
    const client = mkClient({ portName: 'ghost' });
    const job = cleanupMod.create(mkDeps({ clientsList: [client] }));
    const stats = await job.runOnce();
    expect(deleted).toEqual([]);
    expect(stats.candidates).toBe(1);
  });

  it('retail_hold_days из настройки уважается (hold=15 → 11 дней ещё мало)', async () => {
    const client = mkClient();
    const job = cleanupMod.create(mkDeps({ clientsList: [client], holdDays: '15' }));
    await job.runOnce();
    expect(deleted).toEqual([]);
  });
});
