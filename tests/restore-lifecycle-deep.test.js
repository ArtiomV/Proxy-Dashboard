// 2026-09-18 · Этап 3 ТЗ: регрессии DEEP-06..10, DEEP-14 и FIX-03/FIX-07
// (FIX-SPEC §5, §8, §13, §15.1). Настоящие SQLite repositories (retail_pool,
// clients, billing_ledger через bootApp), сеть/боксы — управляемые заглушки.
// Каждый тест падал на коде до исправления:
//   DEEP-06: долговой клиент с балансом 500 и истёкшим blockedSince терял порт;
//   DEEP-07: blocked/billingPaused клиент получал success и сброс debtBlocked;
//   DEEP-08: legacy-восстановление завершалось по одному вернувшемуся серверу;
//   DEEP-09: не было перепроверки владельца после await; unblock затирал
//            конкурентное состояние строки пула;
//   DEEP-10: saveClients проглатывал ошибку, сетевое действие шло без durable
//            сохранения цели retry;
//   DEEP-14: legacy retry пересчитывал дату ежедневно; смешанный pool+legacy
//            восстанавливался неполно;
//   FIX-07:  среднесуточный расход за [сегодня−7; сегодня) / 7, копейка после
//            деления; та же граница в портале.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const retailPoolDb = require('../src/db/retail-pool.js');
const ledgerDb = require('../src/db/ledger.js');
const debtBlockMod = require('../src/jobs/debt-block.js');
const retailGuardMod = require('../src/jobs/retail-guard.js');
const cleanupMod = require('../src/jobs/blocked-port-cleanup.js');
const portValidityMod = require('../src/services/port-validity.js');
const clientPortalRouter = require('../src/routes/client-portal.js');

const T0 = new Date('2026-09-11T10:00:00+03:00');   // МСК
const TODAY = '2026-09-11';

let NOW = new Date(T0.getTime());
let db, server;
const seededClientIds = [];
const seededPoolIds = [];

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  server = require('../server.js');
});
afterEach(() => {
  NOW = new Date(T0.getTime());
  // строки пула живут в общей тестовой БД — чистим после каждого теста
  while (seededPoolIds.length) {
    try { db.prepare('DELETE FROM retail_pool WHERE id = ?').run(seededPoolIds.pop()); } catch (_) { /* best-effort */ }
  }
});
afterAll(() => {
  for (const id of seededClientIds) {
    try { db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id); } catch (_) { /* best-effort */ }
    try { db.prepare('DELETE FROM clients WHERE id = ?').run(id); } catch (_) { /* best-effort */ }
  }
});

// ── фикстуры ──

function seedClient(clientsArr, overrides = {}) {
  const id = 'deep3-' + crypto.randomBytes(4).toString('hex');
  const c = {
    id, login: 'lg_' + id, name: 'C ' + id, portName: 'pn_' + id,
    apiKey: 'key_' + id,
    clientType: 'individual', allowDebt: false, billingPaused: false,
    blocked: false, debtBlocked: false, blockedSince: null,
    balanceNegativeSince: null, holdTtlDays: null,
    balance: 0, debtRestoreUntil: null, debtRestorePorts: null,
    ...overrides,
  };
  db.prepare(`INSERT INTO clients (id, login, name, balance, port_name, client_type,
              allow_debt, billing_paused, blocked, debt_blocked, blocked_since,
              balance_negative_since, debt_restore_until, debt_restore_ports, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`)
    .run(c.id, c.login, c.name, c.balance, c.portName, c.clientType,
      c.allowDebt ? 1 : 0, c.billingPaused ? 1 : 0, c.blocked ? 1 : 0, c.debtBlocked ? 1 : 0,
      c.blockedSince, c.balanceNegativeSince, c.debtRestoreUntil,
      c.debtRestorePorts ? JSON.stringify(c.debtRestorePorts) : null);
  clientsArr.push(c);
  seededClientIds.push(id);
  return c;
}

function seedPoolRow(row) {
  const info = db.prepare(`INSERT INTO retail_pool (server, port_id, status, client_id, hold_until, restore_until, updated_at)
                           VALUES (?,?,?,?,?,?, datetime('now'))`)
    .run(row.server, row.port_id, row.status, row.client_id || null, row.hold_until || null, row.restore_until || null);
  seededPoolIds.push(info.lastInsertRowid);
  return retailPoolDb.byId(info.lastInsertRowid);
}

function clientRow(id) {
  return db.prepare('SELECT debt_blocked, debt_restore_until, debt_restore_ports, balance_negative_since FROM clients WHERE id = ?').get(id);
}

// Управляемые «боксы»: boxes = { S1: { p1: { portName, PROXY_VALID_BEFORE } } }.
// downServers — сервер мёртв: выпадает из фида, все вызовы падают.
// failServers — сервер в фиде, но запись (форма/POST) падает: retry-кейс.
function mkNet(boxes, { downServers = [], failServers = [] } = {}) {
  const state = {};
  for (const [srv, ports] of Object.entries(boxes)) {
    state[srv] = {};
    for (const [pid, p] of Object.entries(ports)) {
      state[srv][pid] = { portID: pid, PASSWORD: 'pw', ...p };
    }
  }
  const down = new Set(downServers);
  const fail = new Set(failServers);
  const calls = { posts: [], applies: [], deletes: [] };
  const proxyConf = {
    getConfForm: async (srv, path) => {
      const pid = path.split('/').pop();
      if (down.has(srv.name) || fail.has(srv.name) || !state[srv.name] || !state[srv.name][pid]) {
        return { ok: false, reason: 'unavailable' };
      }
      return { ok: true, html: '<form></form>' };
    },
    postConfForm: async (srv, path, formData) => {
      const pid = path.split('/').pop();
      if (down.has(srv.name) || fail.has(srv.name)) return { ok: false, reason: 'unavailable' };
      const port = state[srv.name][pid];
      calls.posts.push({ server: srv.name, portId: pid, formData: { ...formData } });
      if (formData.PROXY_VALID_BEFORE !== undefined) port.PROXY_VALID_BEFORE = formData.PROXY_VALID_BEFORE;
      if (formData.portName !== undefined) port.portName = formData.portName;
      return { ok: true };
    },
    getConfAction: async (srv, path) => {
      const m = path.match(/\/conf\/delete_port\/(.+)$/);
      const pid = decodeURIComponent(m[1]);
      if (down.has(srv.name) || fail.has(srv.name)) return { ok: false, reason: 'unavailable' };
      calls.deletes.push(`${srv.name}:${pid}`);
      delete state[srv.name][pid];
      return { ok: true };
    },
  };
  const fetchApi = async (srv, path) => {
    if (down.has(srv.name) || fail.has(srv.name)) throw new Error('unavailable');
    if (path === '/apix/list_ports_json') {
      return { imei1: Object.values(state[srv.name] || {}).map(p => ({ ...p })) };
    }
    const m = path.match(/\/apix\/apply_port\?arg=(.+)$/);
    if (m) { calls.applies.push(`${srv.name}:${decodeURIComponent(m[1])}`); return { ok: true }; }
    return {};
  };
  const feed = () => Object.keys(state)
    .filter(n => !down.has(n))
    .map(n => ({
      serverName: n,
      ports: { imei1: Object.values(state[n]).map(p => ({ portID: p.portID, portName: p.portName, PROXY_VALID_BEFORE: p.PROXY_VALID_BEFORE })) },
    }));
  return { proxyConf, fetchApi, feed, calls, state, down, fail };
}

function mkDeps(clientsArr, net, { settings = {}, saveImpl } = {}) {
  const kv = new Map();
  const activity = [];
  const alertsFired = [];
  const notified = [];
  const deps = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    logActivity: (cat, level, action, target, message, details) => activity.push({ cat, level, action, target, message, details }),
    auditLog() {},
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    proxyConf: net.proxyConf,
    fetchApi: net.fetchApi,
    parseHtmlInputFields: () => ({}),
    findServer: (name) => (net.state[name] ? { name, apiUrl: 'http://' + name } : null),
    proxySmart: { invalidateCache() {} },
    ledgerDb,
    saveClients: saveImpl || server.saveClients,
    getMoscowNow: () => new Date(NOW.getTime()),
    fetchAllServersDataCached: async () => net.feed(),
    clients: clientsArr,
    retailPoolDb,
    tariffsDb: { byId: () => null },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    notifyClient: async (c, text) => { notified.push({ id: c.id, text }); return true; },
    kvGet: (k) => (kv.has(k) ? { value: kv.get(k) } : undefined),
    kvSet: (k, v) => kv.set(k, v),
    knownModems: {},
    saveKnownModems: () => {},
  };
  return { deps, activity, alertsFired, notified };
}

// ── DEEP-06: blocked-port-cleanup не удаляет при плюсовом балансе / паузе ──

describe('DEEP-06: blocked-port-cleanup — защита pending-восстановления', () => {
  const OLD = '2026-08-20T10:00:00.000Z';   // > hold (7 дн) назад
  const CLEANUP_SETTINGS = { retail_hold_days: 7 };

  function mkCleanupDeps(clientsArr, net) {
    const { deps, activity, alertsFired } = mkDeps(clientsArr, net, { settings: CLEANUP_SETTINGS });
    return { deps, activity, alertsFired };
  }

  it('долговой блок + положительный баланс + истёкший blockedSince → порт НЕ удалён', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null } } });
    const client = seedClient(clientsArr, { debtBlocked: true, blockedSince: OLD, balance: 500 });
    net.state.S1.p1.portName = client.portName;   // порт клиента жив на боксе
    const { deps } = mkCleanupDeps(clientsArr, net);
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(stats.candidates).toBe(0);
    expect(net.calls.deletes).toEqual([]);
    expect(net.state.S1.p1).toBeDefined();
  });

  it('ручной/антифрод-блок + положительный баланс → удаляется (баланс не снимает ручной блок)', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null } } });
    const client = seedClient(clientsArr, { blocked: true, blockedSince: OLD, balance: 500 });
    net.state.S1.p1.portName = client.portName;
    const { deps } = mkCleanupDeps(clientsArr, net);
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(stats.deleted).toEqual(['p1']);
    expect(net.calls.deletes).toEqual(['S1:p1']);
  });

  it('billingPaused + долговой блок → не удаляется (политика Б: порты бессрочные)', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null } } });
    const client = seedClient(clientsArr, { debtBlocked: true, billingPaused: true, blockedSince: OLD, balance: -100 });
    net.state.S1.p1.portName = client.portName;
    const { deps } = mkCleanupDeps(clientsArr, net);
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(stats.candidates).toBe(0);
    expect(net.calls.deletes).toEqual([]);
  });

  it('per-клиент hold_ttl_days = -1 → бессрочный hold, не удаляется', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null } } });
    const client = seedClient(clientsArr, { debtBlocked: true, blockedSince: OLD, balance: -100, holdTtlDays: -1 });
    net.state.S1.p1.portName = client.portName;
    const { deps } = mkCleanupDeps(clientsArr, net);
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(stats.candidates).toBe(0);
    expect(net.calls.deletes).toEqual([]);
  });

  it('долговой блок, баланс ≤ 0, hold истёк → удаляется (базовое поведение сохранено)', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null } } });
    const client = seedClient(clientsArr, { debtBlocked: true, blockedSince: OLD, balance: -100 });
    net.state.S1.p1.portName = client.portName;
    const { deps } = mkCleanupDeps(clientsArr, net);
    const job = cleanupMod.create(deps);
    const stats = await job.runOnce();
    expect(stats.deleted).toEqual(['p1']);
  });
});

// ── DEEP-07: debt-block не воскрешает blocked/billingPaused ──

describe('DEEP-07: debt-block._restoreAfterCredit — повторный допуск', () => {
  function mkRestoreScenario(overrides) {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } } });
    const client = seedClient(clientsArr, { balance: 500, debtBlocked: true, ...overrides });
    net.state.S1.p1.portName = client.portName;
    const { deps, alertsFired } = mkDeps(clientsArr, net);
    const job = debtBlockMod.create(deps);
    return { job, client, net, alertsFired, deps };
  }

  it('ручной/антифрод-блок после долга → нет success, debtBlocked не сброшен, сети нет', async () => {
    const { job, client, net, alertsFired } = mkRestoreScenario({ blocked: true });
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(client.debtBlocked).toBe(true);
    expect(net.calls.posts).toEqual([]);
    expect(alertsFired.some(a => a.rule === 'client_unblocked_debt')).toBe(false);
  });

  it('тарифная пауза → нет success, debtBlocked не сброшен', async () => {
    const { job, client, net } = mkRestoreScenario({ billingPaused: true });
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(client.debtBlocked).toBe(true);
    expect(net.calls.posts).toEqual([]);
  });

  it('retryPendingRestores не считает blocked/billingPaused ни restored, ни pending', async () => {
    const { job, deps } = mkRestoreScenario({ blocked: true });
    const c2 = seedClient(deps.clients, { balance: 500, debtBlocked: true, billingPaused: true });
    expect(c2.debtBlocked).toBe(true);
    await expect(job.retryPendingRestores()).resolves.toEqual({ restored: 0, pending: 0 });
  });
});

// ── DEEP-10: нет durable-записи цели → нет сетевого действия ──

describe('DEEP-10: ошибка saveClients отменяет сетевое восстановление', () => {
  it('saveClients=false до продления → restoreAfterCredit=false, POST/apply не вызывались', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } } });
    const client = seedClient(clientsArr, { balance: 500, debtBlocked: true });
    net.state.S1.p1.portName = client.portName;
    const { deps, activity } = mkDeps(clientsArr, net, { saveImpl: () => false });
    const job = debtBlockMod.create(deps);
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(net.calls.posts).toEqual([]);
    expect(net.calls.applies).toEqual([]);
    expect(client.debtBlocked).toBe(true);
    expect(activity.some(a => a.action === 'debt_restore_persist_error')).toBe(true);
  });

  it('retail-guard: ошибка записи legacy-цели → сетевые действия отменены', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } } });
    const client = seedClient(clientsArr, {
      balance: 500, balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    net.state.S1.p1.portName = client.portName;
    const { deps, activity } = mkDeps(clientsArr, net, {
      settings: { retail_enabled: true, retail_grace_hours: 24, retail_hold_days: 7 },
      saveImpl: () => false,
    });
    const guard = retailGuardMod.create(deps);
    const stats = await guard.runOnce();
    expect(stats.restored).toEqual([]);
    expect(net.calls.posts).toEqual([]);
    expect(activity.some(a => a.action === 'retail_restore_persist_error')).toBe(true);
  });
});

// ── DEEP-08: durable-набор ожидаемых портов legacy-восстановления ──

describe('DEEP-08: legacy-восстановление не завершается по одному серверу', () => {
  it('S1+S4, вернулся только S1 → pending; S4 поднялся → полный успех', async () => {
    const clientsArr = [];
    const net = mkNet({
      S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } },
      S4: { p9: { portName: null, PROXY_VALID_BEFORE: TODAY } },
    }, { downServers: ['S4'] });
    const client = seedClient(clientsArr, {
      balance: 500, debtBlocked: true,
      debtRestoreUntil: '2026-10-11',
      debtRestorePorts: [{ server: 'S1', portId: 'p1' }, { server: 'S4', portId: 'p9' }],
    });
    net.state.S1.p1.portName = client.portName;
    net.state.S4.p9.portName = client.portName;
    const { deps } = mkDeps(clientsArr, net);
    const job = debtBlockMod.create(deps);

    // S1 продлён, S4 недоступен → операция НЕ завершена.
    expect(await job.restoreAfterCredit(client)).toBe(false);
    expect(net.calls.posts.map(p => p.portId)).toEqual(['p1']);
    expect(client.debtBlocked).toBe(true);
    // Набор ожидания укорочен durable: остался только S4/p9.
    const mid = clientRow(client.id);
    expect(mid.debt_blocked).toBe(1);
    expect(JSON.parse(mid.debt_restore_ports)).toEqual([{ server: 'S4', portId: 'p9' }]);

    // «Рестарт»: новая джоба поверх той же БД; S4 поднялся → успех.
    net.down.delete('S4');
    const job2 = debtBlockMod.create(deps);
    expect(await job2.restoreAfterCredit(client)).toBe(true);
    expect(client.debtBlocked).toBe(false);
    const fin = clientRow(client.id);
    expect(fin.debt_blocked).toBe(0);
    expect(fin.debt_restore_ports).toBe(null);
    // 22.09: цель восстановления — бессрочно (''), legacy-цель-дата
    // '2026-10-11' (миграция 089) больше не используется как срок.
    expect(net.state.S4.p9.PROXY_VALID_BEFORE).toBe('');
  });

  it('порт удалён снаружи, сервер в фиде → исключён из ожидания (не «восстановлен»)', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: {} });   // порт p1 уже отсутствует на живом сервере
    const client = seedClient(clientsArr, {
      balance: 500, debtBlocked: true,
      debtRestoreUntil: '2026-10-11',
      debtRestorePorts: [{ server: 'S1', portId: 'p1' }],
    });
    const { deps, activity } = mkDeps(clientsArr, net);
    const job = debtBlockMod.create(deps);
    expect(await job.restoreAfterCredit(client)).toBe(true);
    expect(net.calls.posts).toEqual([]);
    expect(activity.some(a => a.action === 'debt_restore_port_gone')).toBe(true);
    expect(clientRow(client.id).debt_restore_ports).toBe(null);
  });

  it('автоблок фиксирует ожидаемый набор портов в БД (миграция 092)', async () => {
    const clientsArr = [];
    const net = mkNet({
      S1: { p1: { portName: null, PROXY_VALID_BEFORE: '2027-01-01' } },
      S4: { p9: { portName: null, PROXY_VALID_BEFORE: '2027-01-01' } },
    });
    const client = seedClient(clientsArr, { balance: -100 });
    net.state.S1.p1.portName = client.portName;
    net.state.S4.p9.portName = client.portName;
    const { deps } = mkDeps(clientsArr, net);
    const job = debtBlockMod.create(deps);
    await job.runAfterDailyBilling(clientsArr, net.feed());
    expect(client.debtBlocked).toBe(true);
    const row = clientRow(client.id);
    expect(JSON.parse(row.debt_restore_ports)).toEqual([
      { server: 'S1', portId: 'p1' }, { server: 'S4', portId: 'p9' },
    ]);
  });
});

// ── DEEP-09: перепроверка владельца и сериализация в port-validity ──

describe('DEEP-09: port-validity — владелец и сериализация по server+portID', () => {
  const srv = { name: 'S1', apiUrl: 'http://s1' };

  function mkPvDeps({ portName = 'pn_a', onPost } = {}) {
    const calls = { posts: [] };
    let lastVb = '2026-09-20';
    const deps = {
      proxyConf: {
        getConfForm: async () => ({ ok: true, html: '<form><input name="proxy_password" value="pw"></form>' }),
        postConfForm: async (s, p, fd) => {
          calls.posts.push({ ...fd });
          if (fd.PROXY_VALID_BEFORE) lastVb = fd.PROXY_VALID_BEFORE;
          if (onPost) onPost();
          return { ok: true };
        },
      },
      fetchApi: async (s, path) => {
        if (path === '/apix/list_ports_json') {
          return { i: [{ portID: 'p1', portName, PROXY_VALID_BEFORE: lastVb, PASSWORD: 'pw' }] };
        }
        return {};
      },
      parseHtmlInputFields: () => ({ proxy_password: 'pw' }),
      findServer: () => srv,
      proxySmart: { invalidateCache() {} },
      ledgerDb,
      getMoscowNow: () => new Date(NOW.getTime()),
    };
    return { deps, calls };
  }

  it('владелец сменился до POST → conflict, полная форма конкурента НЕ затирается', async () => {
    const { deps, calls } = mkPvDeps({ portName: 'other_client' });
    const pv = portValidityMod.create(deps);
    await expect(pv.setPortValidBefore(srv, 'p1', '2026-09-20', { expectedPortName: 'pn_a' }))
      .rejects.toThrow(/conflict/);
    expect(calls.posts).toEqual([]);
  });

  it('изменения одного порта сериализуются: второй POST начинается после конца первого', async () => {
    const order = [];
    let releaseFirst;
    const gate = new Promise(res => { releaseFirst = res; });
    let formCalls = 0;
    const { deps } = mkPvDeps();
    deps.proxyConf.getConfForm = () => {
      formCalls++;
      order.push('form' + formCalls);
      const html = '<form><input name="proxy_password" value="pw"></form>';
      return formCalls === 1 ? gate.then(() => ({ ok: true, html })) : Promise.resolve({ ok: true, html });
    };
    const origPost = deps.proxyConf.postConfForm;
    deps.proxyConf.postConfForm = async (s, p, fd) => { order.push('post'); return origPost(s, p, fd); };
    const pv = portValidityMod.create(deps);
    const p1 = pv.setPortValidBefore(srv, 'p1', '2026-09-20');
    const p2 = pv.setPortValidBefore(srv, 'p1', '2026-09-21');
    await new Promise(res => setImmediate(res));
    expect(formCalls).toBe(1);   // второй писатель ждёт первого
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['form1', 'post', 'form2', 'post']);
  });

  it('retail-pool.unblock — условный UPDATE: чужой статус = 0 строк (конфликт)', () => {
    const row = seedPoolRow({ server: 'S9', port_id: 'px9', status: 'leased', client_id: 'someone' });
    const res = retailPoolDb.unblock(row.id);
    expect(res.changes).toBe(0);                       // leased не «восстановлен»
    expect(retailPoolDb.byId(row.id).status).toBe('leased');
    retailPoolDb.block(row.id, null);
    expect(retailPoolDb.unblock(row.id).changes).toBe(1);
    expect(retailPoolDb.byId(row.id).status).toBe('leased');
  });

  it('retail-guard: конкурентный unblock строки → порт pending, успех не объявлен', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } } });
    const client = seedClient(clientsArr, {
      balance: 500, balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    net.state.S1.p1.portName = client.portName;
    const poolRow = seedPoolRow({ server: 'S1', port_id: 'p1', status: 'blocked', client_id: client.id, hold_until: '2026-09-20T00:00:00.000Z' });
    const { deps, notified, activity } = mkDeps(clientsArr, net, {
      settings: { retail_enabled: true, retail_grace_hours: 24, retail_hold_days: 7 },
    });
    // Конкурент (UI/админ) переводит строку в leased между чтением и unblock.
    const origPost = net.proxyConf.postConfForm;
    net.proxyConf.postConfForm = async (s, p, fd) => {
      const r = await origPost(s, p, fd);
      db.prepare("UPDATE retail_pool SET status='leased', hold_until=NULL WHERE id = ?").run(poolRow.id);
      return r;
    };
    const guard = retailGuardMod.create(deps);
    const stats = await guard.runOnce();
    expect(stats.restored).toEqual([]);
    expect(notified.some(n => /сервис восстановлен/i.test(n.text))).toBe(false);
    expect(activity.some(a => a.action === 'retail_restore_conflict')).toBe(true);
  });
});

// ── DEEP-14: фиксированная дата legacy retry + смешанный pool+legacy ──

describe('DEEP-14: retail-guard — legacy retry и смешанный набор', () => {
  const GUARD_SETTINGS = { retail_enabled: true, retail_grace_hours: 24, retail_hold_days: 7 };

  it('legacy retry использует сохранённую цель, а не пересчёт от нового дня', async () => {
    const clientsArr = [];
    // Сервер в фиде, но запись падает — restore pending, цель фиксируется durable.
    const net = mkNet({ S1: { p1: { portName: null, PROXY_VALID_BEFORE: TODAY } } }, { failServers: ['S1'] });
    const client = seedClient(clientsArr, {
      balance: 500, balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    net.state.S1.p1.portName = client.portName;
    const { deps } = mkDeps(clientsArr, net, { settings: GUARD_SETTINGS });
    const guard = retailGuardMod.create(deps);

    // День 1: запись не прошла — цель зафиксирована durable, успеха нет.
    let stats = await guard.runOnce();
    expect(stats.restored).toEqual([]);
    expect(net.calls.posts).toEqual([]);
    expect(clientRow(client.id).debt_restore_until).toBe('2026-10-11');   // avg=0 → +30 дн

    // День 2: запись проходит — retry идёт на ТУ ЖЕ дату, а не сегодня+30.
    NOW = new Date(T0.getTime() + 86400e3);   // 2026-09-12
    net.fail.delete('S1');
    stats = await retailGuardMod.create(deps).runOnce();   // «рестарт» джобы
    expect(stats.restored).toEqual([client.id]);
    expect(net.calls.posts[0].formData.PROXY_VALID_BEFORE).toBe('2026-10-11');
    expect(clientRow(client.id).debt_restore_until).toBe(null);
  });

  it('смешанный pool+legacy: продлены и строка пула, и порт без строки', async () => {
    const clientsArr = [];
    const net = mkNet({
      S1: {
        p1: { portName: null, PROXY_VALID_BEFORE: TODAY },
        p2: { portName: null, PROXY_VALID_BEFORE: TODAY },
      },
    });
    const client = seedClient(clientsArr, {
      balance: 500, balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    net.state.S1.p1.portName = client.portName;
    net.state.S1.p2.portName = client.portName;   // legacy-порт без строки пула
    const poolRow = seedPoolRow({ server: 'S1', port_id: 'p1', status: 'blocked', client_id: client.id, hold_until: '2026-09-20T00:00:00.000Z' });
    const { deps, notified } = mkDeps(clientsArr, net, { settings: GUARD_SETTINGS });
    const stats = await retailGuardMod.create(deps).runOnce();
    expect(stats.restored).toEqual([client.id]);
    const postedPorts = net.calls.posts.map(p => p.portId).sort();
    expect(postedPorts).toEqual(['p1', 'p2']);
    expect(net.state.S1.p1.PROXY_VALID_BEFORE).toBe('2026-10-11');
    expect(net.state.S1.p2.PROXY_VALID_BEFORE).toBe('2026-10-11');
    expect(retailPoolDb.byId(poolRow.id).status).toBe('leased');
    expect(notified.some(n => /сервис восстановлен/i.test(n.text))).toBe(true);
  });

  it('FIX-03 п.9: hold истёк, но restore_until + плюсовой баланс → порт не удалён после рестарта', async () => {
    const clientsArr = [];
    const net = mkNet({ S1: { p1: { portName: 'someone', PROXY_VALID_BEFORE: TODAY } } });
    // portName='' → клиент пропускается циклом (in-memory pendingRestoreRows пуст
    // даже в этом прогоне — защита только durable).
    const client = seedClient(clientsArr, { balance: 500, portName: '' });
    const poolRow = seedPoolRow({
      server: 'S1', port_id: 'p1', status: 'blocked', client_id: client.id,
      hold_until: '2026-09-01T00:00:00.000Z', restore_until: '2026-10-11',
    });
    const { deps } = mkDeps(clientsArr, net, { settings: GUARD_SETTINGS });
    const stats = await retailGuardMod.create(deps).runOnce();
    expect(stats.deleted).toEqual([]);
    expect(net.calls.deletes).toEqual([]);
    expect(retailPoolDb.byId(poolRow.id)).toBeDefined();
  });

  it('повторный блок сбрасывает протухший restore_until (новый долговой цикл)', () => {
    const row = seedPoolRow({ server: 'S9', port_id: 'px8', status: 'blocked', client_id: 'x', restore_until: '2026-10-11' });
    retailPoolDb.lease(row.id);
    retailPoolDb.block(row.id, '2026-09-20T00:00:00.000Z');
    expect(retailPoolDb.byId(row.id).restore_until).toBe(null);
  });
});

// ── FIX-07: среднесуточный расход за семь полных дней ──

describe('FIX-07: avgDailyCharge7d — [сегодня−7; сегодня) / 7', () => {
  function pv() {
    return portValidityMod.create({ ledgerDb, getMoscowNow: () => new Date(NOW.getTime()) });
  }
  function charge(clientId, date, amount) {
    db.prepare(`INSERT INTO billing_ledger (client_id, type, date, timestamp, amount, source)
                VALUES (?, 'charge', ?, ?, ?, 'test')`)
      .run(clientId, date, date + 'T04:00:00.000Z', amount);
  }

  it('семь списаний по 100 ₽ (включая нижнюю границу) → 100 ₽', () => {
    const c = seedClient([]);
    for (let d = 4; d <= 10; d++) charge(c.id, `2026-09-${String(d).padStart(2, '0')}`, 100);
    expect(pv().avgDailyCharge7d(c.id)).toBe(100);
  });

  it('списание только на нижней границе 70 ₽ → 10 ₽; сегодня и сегодня−8 исключены', () => {
    const c = seedClient([]);
    charge(c.id, '2026-09-04', 70);    // нижняя граница включена
    charge(c.id, '2026-09-03', 999);   // сегодня−8 — вне окна
    charge(c.id, '2026-09-11', 999);   // текущий день — вне окна
    expect(pv().avgDailyCharge7d(c.id)).toBe(10);
  });

  it('пустая история → 0; деление всегда на 7', () => {
    const c = seedClient([]);
    expect(pv().avgDailyCharge7d(c.id)).toBe(0);
    charge(c.id, '2026-09-10', 35);
    expect(pv().avgDailyCharge7d(c.id)).toBe(5);   // 35/7, а не 35/1
  });

  it('переход месяца и года считается по календарным датам', () => {
    const c = seedClient([]);
    // Сегодня 02.10: окно [25.09; 02.10).
    NOW = new Date('2026-10-02T10:00:00+03:00');
    for (let d = 25; d <= 30; d++) charge(c.id, `2026-09-${d}`, 100);
    charge(c.id, '2026-10-01', 100);
    expect(pv().avgDailyCharge7d(c.id)).toBe(100);
    // Сегодня 02.01.2027: окно [26.12.2026; 02.01.2027).
    const c2 = seedClient([]);
    NOW = new Date('2027-01-02T10:00:00+03:00');
    for (let d = 26; d <= 31; d++) charge(c2.id, `2026-12-${d}`, 77);
    charge(c2.id, '2027-01-01', 77);
    expect(pv().avgDailyCharge7d(c2.id)).toBe(77);
  });

  it('одинаковый результат при разных TZ процесса', () => {
    const c = seedClient([]);
    for (let d = 4; d <= 10; d++) charge(c.id, `2026-09-${String(d).padStart(2, '0')}`, 100);
    const { getMoscowNow } = require('../src/utils/time.js');
    const savedTz = process.env.TZ;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T07:00:00Z'));   // 10:00 МСК
    try {
      const results = [];
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        results.push(portValidityMod.create({ ledgerDb, getMoscowNow }).avgDailyCharge7d(c.id));
      }
      expect(results).toEqual([100, 100, 100]);
    } finally {
      vi.useRealTimers();
      if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    }
  });

  it('портал (billing_history) использует ту же границу окна', async () => {
    const c = seedClient([]);
    for (let d = 4; d <= 10; d++) charge(c.id, `2026-09-${String(d).padStart(2, '0')}`, 100);
    // Роутеру нужны десятки deps; задействованные billing_history подставлены
    // явно, остальные — pass-through заглушки через Proxy.
    const pass = (_req, _res, next) => next();
    const router = clientPortalRouter(new Proxy({
      logger: { info() {}, warn() {}, error() {} },
      authMiddleware: (req, _res, next) => { req.user = { login: c.login, portNameFilter: '*' }; next(); },
      fetchAllServersDataCached: async () => [],
      mergeServerData: () => ({ ports: {} }),
      getMoscowToday: () => TODAY,
      getMoscowNow: () => new Date(NOW.getTime()),
      ledgerExpense: server.ledgerExpense,
      ledgerDb,
      clientByLogin: new Map([[c.login, c]]),
    }, { get: (t, k) => (k in t ? t[k] : () => pass) }));
    const layer = router.stack.find(l => l.route && l.route.path === '/api/billing_history');
    const handler = layer.route.stack.at(-1).handle;
    const res = { status() { return this; }, json(o) { this.body = o; } };
    await handler({ user: { login: c.login, portNameFilter: '*' }, query: {} }, res);
    expect(res.body.summary.avgDailyCharge7d).toBe(100);
  });
});
