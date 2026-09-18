// 2026-09-18 · Регрессии DEEP-15 (FIX-SPEC §15.2): возврат тестового порта
// в пул (retail-guard._processExpiredTestDays). Настоящий SQLite repository
// (retail_pool через bootApp), боксы — управляемые заглушки. На коде до
// исправления каждый сценарий переводил порт в free без подтверждённой
// отвязки (старый доступ оставался активным одновременно с новой выдачей):
//   - сервер удалён из конфигурации: отключение пропускалось, порт уходил
//     в free и продавался;
//   - невалидный test_expires_at: Date.parse → NaN не блокировал возврат;
//   - POST/apply без фактической смены portName считался успешной отвязкой
//     (один HTTP 200/apply не доказывает отключение прежнего клиента).

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const retailPoolDb = require('../src/db/retail-pool.js');
const retailGuardMod = require('../src/jobs/retail-guard.js');

const T0 = new Date('2026-09-18T12:00:00+03:00');   // МСК

let NOW = new Date(T0.getTime());
let db;
const seededPoolIds = [];

beforeAll(() => { db = bootApp().db; });
afterEach(() => {
  NOW = new Date(T0.getTime());
  // строки пула живут в общей тестовой БД — чистим после каждого теста
  while (seededPoolIds.length) {
    try { db.prepare('DELETE FROM retail_pool WHERE id = ?').run(seededPoolIds.pop()); } catch (_) { /* best-effort */ }
  }
});

// leased-строка с дедлайном тест-дня (по умолчанию — уже истёкшим).
function seedLeasedTestRow({ server = 'S1', clientId = 'c15', testExpiresAt } = {}) {
  const portId = 'p15_' + crypto.randomBytes(3).toString('hex');
  retailPoolDb.insertLeased(server, portId, clientId);
  const row = retailPoolDb.byPort(server, portId);
  seededPoolIds.push(row.id);
  const iso = testExpiresAt !== undefined ? testExpiresAt : new Date(NOW.getTime() - 3600e3).toISOString();
  if (iso != null) retailPoolDb.setTestExpires(row.id, iso);
  return retailPoolDb.byId(row.id);
}

// Управляемый «бокс»: postConfForm применяет formData к состоянию порта.
// net.silentReject=true имитирует apply без фактической смены portName
// (HTTP 200 есть, отвязки нет — кейс «неподтверждённая отвязка» §15.2).
function mkNet(boxes, { silentReject = false } = {}) {
  const state = {};
  for (const [srv, ports] of Object.entries(boxes)) {
    state[srv] = {};
    for (const [pid, p] of Object.entries(ports)) {
      state[srv][pid] = { portID: pid, PASSWORD: 'pw', ...p };
    }
  }
  const net = {
    state,
    silentReject,
    calls: { posts: [] },
  };
  net.proxyConf = {
    getConfForm: async () => ({ ok: true, html: '<form></form>' }),
    postConfForm: async (srv, path, formData) => {
      const pid = path.split('/').pop();
      net.calls.posts.push({ server: srv.name, portId: pid, formData: { ...formData } });
      const port = state[srv.name] && state[srv.name][pid];
      if (!net.silentReject && port) {
        if (formData.portName !== undefined) port.portName = formData.portName;
        if (formData.PROXY_VALID_BEFORE !== undefined) port.PROXY_VALID_BEFORE = formData.PROXY_VALID_BEFORE;
      }
      return { ok: true };
    },
    getConfAction: async () => ({ ok: true }),
  };
  net.fetchApi = async (srv, path) => {
    if (path === '/apix/list_ports_json') {
      return { imei1: Object.values(state[srv.name] || {}).map(p => ({ ...p })) };
    }
    return { ok: true };   // apply_port
  };
  net.feed = () => Object.keys(state).map(n => ({
    serverName: n,
    ports: { imei1: Object.values(state[n]).map(p => ({ portID: p.portID, portName: p.portName, PROXY_VALID_BEFORE: p.PROXY_VALID_BEFORE })) },
  }));
  return net;
}

// knownServers — серверы, оставшиеся в конфигурации (findServer); сервер,
// удалённый из конфигурации, в список не входит, хотя бокс ещё жив.
function mkDeps(net, { knownServers } = {}) {
  const alertsFired = [];
  const known = knownServers || Object.keys(net.state);
  const deps = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    logActivity() {},
    auditLog() {},
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    proxyConf: net.proxyConf,
    fetchApi: net.fetchApi,
    parseHtmlInputFields: () => ({ proxy_password: 'pw' }),
    findServer: (name) => (known.includes(name) ? { name, apiUrl: 'http://' + name } : null),
    proxySmart: { invalidateCache() {} },
    ledgerDb: { listByClient: () => [] },
    saveClients: () => true,
    getMoscowNow: () => new Date(NOW.getTime()),
    fetchAllServersDataCached: async () => net.feed(),
    // Клиент без portName — пер-клиентский конвейер долга его пропускает,
    // а фаза тест-дня найдёт его для уведомления по row.client_id.
    clients: [{ id: 'c15', login: 'u15', name: 'T', portName: null }],
    retailPoolDb,
    tariffsDb: { byId: () => null },
    getSetting: (k, d) => (k === 'retail_enabled' ? true : d),
    notifyClient: async () => true,
    kvGet: () => undefined,
    kvSet: () => {},
  };
  return { deps, alertsFired };
}

describe('DEEP-15: возврат тестового порта — неподтверждённая отвязка ≠ free', () => {
  it('сервер удалён из конфигурации → порт НЕ free: leased + pending release, отвязка не начиналась', async () => {
    const net = mkNet({ S1: { } });
    const row = seedLeasedTestRow({ server: 'S1' });
    net.state.S1[row.port_id] = { portID: row.port_id, PASSWORD: 'pw', portName: 'u15' };
    const { deps } = mkDeps(net, { knownServers: [] });   // S1 удалён из конфигурации
    const stats = await retailGuardMod.create(deps).runOnce();

    const after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('leased');                  // НЕ free
    expect(after.client_id).toBe('c15');
    expect(after.pending_release).toBe('server_unknown');
    expect(net.calls.posts).toEqual([]);                  // сетевых действий не было
    expect(retailPoolDb.nextFree('S1')).toBeUndefined();  // порт недоступен для продажи
    expect(stats.testDayEnded).toEqual([]);
  });

  it('невалидный test_expires_at → НЕ free: диагностируемое pending release, доступ не тронут', async () => {
    const net = mkNet({ S1: { } });
    const row = seedLeasedTestRow({ server: 'S1', testExpiresAt: 'not-a-date' });
    net.state.S1[row.port_id] = { portID: row.port_id, PASSWORD: 'pw', portName: 'u15' };
    const { deps } = mkDeps(net);
    await retailGuardMod.create(deps).runOnce();

    const after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('leased');
    expect(after.pending_release).toBe('invalid_deadline');
    expect(net.calls.posts).toEqual([]);
    expect(net.state.S1[row.port_id].portName).toBe('u15');
    expect(retailPoolDb.nextFree('S1')).toBeUndefined();
  });

  it('apply не применил portName → НЕ free; после исправления бокса повтор доводит возврат', async () => {
    const net = mkNet({ S1: { } }, { silentReject: true });
    const row = seedLeasedTestRow({ server: 'S1' });
    net.state.S1[row.port_id] = { portID: row.port_id, PASSWORD: 'pw', portName: 'u15' };
    const { deps, alertsFired } = mkDeps(net);
    const guard = retailGuardMod.create(deps);

    const first = await guard.runOnce();
    let after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('leased');                  // НЕ free
    expect(after.pending_release).toBe('unbind_unconfirmed');
    expect(net.state.S1[row.port_id].portName).toBe('u15');   // отвязка не подтверждена
    expect(first.testDayEnded).toEqual([]);
    expect(alertsFired.some(a => a.rule === 'retail_test_day_ended')).toBe(false);
    expect(retailPoolDb.nextFree('S1')).toBeUndefined();

    // Бокс исправлен: следующий цикл завершает возврат по pending release.
    net.silentReject = false;
    const second = await guard.runOnce();
    after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('free');
    expect(after.pending_release).toBe(null);
    expect(net.state.S1[row.port_id].portName).toBe('');
    expect(second.testDayEnded).toEqual([row.port_id]);
  });

  it('crash после отвязки до release: порт на боксе уже пуст → повтор завершает возврат', async () => {
    const net = mkNet({ S1: { } });
    const row = seedLeasedTestRow({ server: 'S1' });
    net.state.S1[row.port_id] = { portID: row.port_id, PASSWORD: 'pw', portName: '' };   // отвязка применилась, процесс умер до release()
    db.prepare("UPDATE retail_pool SET pending_release='unbind_unconfirmed' WHERE id=?").run(row.id);
    const { deps } = mkDeps(net);
    const stats = await retailGuardMod.create(deps).runOnce();

    const after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('free');
    expect(after.pending_release).toBe(null);
    expect(stats.testDayEnded).toEqual([row.port_id]);
  });

  it('штатный возврат: подтверждённая отвязка → free, порт на боксе пуст', async () => {
    const net = mkNet({ S1: { } });
    const row = seedLeasedTestRow({ server: 'S1' });
    net.state.S1[row.port_id] = { portID: row.port_id, PASSWORD: 'pw', portName: 'u15' };
    const { deps, alertsFired } = mkDeps(net);
    const stats = await retailGuardMod.create(deps).runOnce();

    const after = retailPoolDb.byId(row.id);
    expect(after.status).toBe('free');
    expect(after.pending_release).toBe(null);
    expect(net.state.S1[row.port_id].portName).toBe('');
    expect(alertsFired.some(a => a.rule === 'retail_test_day_ended')).toBe(true);
    expect(stats.testDayEnded).toEqual([row.port_id]);
  });
});
