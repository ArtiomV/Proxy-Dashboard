// B2C Этап 2: retail-guard — конвейер автоблока розницы (grace → block+hold →
// delete → restore + тест-день + low-balance). Чистые юнит-тесты на моках
// ProxySmart (proxyConf/fetchApi) — без живого бокса. Время инжектируется
// через deps.getMoscowNow (паттерн speed-monitor/debt-block tests).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const guardMod = require('../src/jobs/retail-guard.js');

const T0 = new Date('2026-08-10T10:00:00+03:00');   // МСК
const TODAY = '2026-08-10';

let NOW;
let posted, deleted, applied, notified, audited, activity, alertsFired, saved;
let kv, settings, server;

// ── in-memory retail_pool ──
function mkPoolDb(rows) {
  return {
    byStatus: (s) => rows.filter(r => r.status === s),
    byClient: (cid) => rows.filter(r => r.client_id === cid && ['reserved', 'leased', 'blocked'].includes(r.status)),
    byPort: (srv, pid) => rows.find(r => r.server === srv && r.port_id === pid),
    block: (id, holdUntil) => { const r = rows.find(x => x.id === id); r.status = 'blocked'; r.hold_until = holdUntil; },
    unblock: (id) => { const r = rows.find(x => x.id === id); r.status = 'leased'; r.hold_until = null; },
    release: (id) => { const r = rows.find(x => x.id === id); r.status = 'free'; r.client_id = null; r.hold_until = null; r.test_expires_at = null; },
    remove: (id) => { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

function mkDeps({ poolRows = [], ledgerEntries = [], resultsFn } = {}) {
  posted = []; deleted = []; applied = []; notified = []; audited = [];
  activity = []; alertsFired = []; saved = 0;
  kv = new Map();
  settings = { retail_enabled: true, retail_grace_hours: 24, retail_hold_days: 7 };
  server = { name: 'S1', apiUrl: 'http://s1' };
  const poolDb = mkPoolDb(poolRows);
  return {
    deps: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      logActivity: (cat, level, action, target, _msg, _details) => activity.push({ cat, level, action, target }),
      auditLog: (who, action, details) => audited.push({ who, action, details }),
      alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
      proxyConf: {
        getConfForm: async () => ({ ok: true, html: '<form><input name="proxy_password" value="pw1"></form>' }),
        postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
        getConfAction: async (srv, path) => { deleted.push(path); return { ok: true }; },
      },
      fetchApi: async (srv, path) => { applied.push(path); return {}; },
      parseHtmlInputFields: () => ({ proxy_password: 'pw1' }),
      findServer: () => server,
      proxySmart: { invalidateCache() {} },
      ledgerDb: { listByClient: () => ledgerEntries },
      saveClients: () => { saved++; },
      getMoscowNow: () => new Date(NOW.getTime()),
      fetchAllServersDataCached: async () => (resultsFn ? resultsFn() : serverResults()),
      clients: [],
      retailPoolDb: poolDb,
      tariffsDb: { byId: () => null },
      getSetting: (k, d) => (k in settings ? settings[k] : d),
      notifyClient: async (client, text) => { notified.push({ client: client.login, text }); return true; },
      kvGet: (k) => (kv.has(k) ? { value: kv.get(k) } : undefined),
      kvSet: (k, v) => kv.set(k, v),
    },
    poolDb,
    poolRows,
  };
}

function serverResults(portName = 'u_a', validBefore = '2026-12-31') {
  return [{
    serverName: 'S1',
    ports: { imei1: [{ portID: 'p1', portName, PROXY_VALID_BEFORE: validBefore }] },
  }];
}

function mkClient(overrides = {}) {
  return {
    id: 'c1', login: 'u_a', name: 'ClientA', portName: 'u_a',
    clientType: 'individual', allowDebt: false, debtBlocked: false,
    balance: -100, balanceNegativeSince: null, holdTtlDays: null,
    ...overrides,
  };
}

const lastValidBefore = () => posted[posted.length - 1].formData.PROXY_VALID_BEFORE;
const setNow = (d) => { NOW = new Date(d.getTime()); };
beforeEach(() => { NOW = new Date(T0.getTime()); });

describe('retail-guard: grace → block → hold → delete', () => {
  it('шаг 1: balance ≤ 0 → balanceNegativeSince + уведомление grace, порт НЕ трогаем', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    const client = mkClient();
    deps.clients.push(client);
    await guard.runOnce();

    expect(client.balanceNegativeSince).toBeTruthy();
    expect(saved).toBe(1);
    expect(posted.length).toBe(0);                     // порт работает
    expect(notified.some(n => /отключён через 24/.test(n.text))).toBe(true);
  });

  it('grace-уведомление не дублируется (дедуп kv)', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    const client = mkClient();
    deps.clients.push(client);
    await guard.runOnce();
    await guard.runOnce();                             // тот же день, grace идёт
    expect(notified.length).toBe(1);
  });

  it('шаг 2: grace истёк → «дата до» = сегодня, строка пула leased → blocked + hold_until', async () => {
    const poolRows = [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    const client = mkClient({ balanceNegativeSince: new Date(T0.getTime() - 25 * 3600e3).toISOString() });
    deps.clients.push(client);
    await guard.runOnce();

    expect(lastValidBefore()).toBe(TODAY);
    expect(applied).toEqual(['/apix/apply_port?arg=p1']);
    expect(poolRows[0].status).toBe('blocked');
    expect(Date.parse(poolRows[0].hold_until)).toBe(T0.getTime() + 7 * 86400e3);
    expect(audited.some(a => a.action === 'retail_block')).toBe(true);
    expect(notified.some(n => /храним 7 дн/.test(n.text))).toBe(true);
  });

  it('hold_ttl_days = -1 → hold_until NULL, порт НИКОГДА не удаляется', async () => {
    const poolRows = [{ id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1', hold_until: null }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    // «Прошло» 90 дней — порт обязан жить.
    setNow(new Date(T0.getTime() + 90 * 86400e3));
    const client = mkClient({
      holdTtlDays: -1,
      balanceNegativeSince: new Date(T0.getTime() - 91 * 86400e3).toISOString(),
    });
    deps.clients.push(client);
    await guard.runOnce();

    expect(deleted.length).toBe(0);
    expect(poolRows.length).toBe(1);
    expect(poolRows[0].status).toBe('blocked');
  });

  it('шаг 3: hold_until прошёл → delete_port на боксе + строка пула удалена + audit + уведомление', async () => {
    const poolRows = [{
      id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1',
      hold_until: new Date(T0.getTime() - 3600e3).toISOString(),
    }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({
      balanceNegativeSince: new Date(T0.getTime() - 8 * 86400e3).toISOString(),
    }));
    await guard.runOnce();

    expect(deleted).toEqual(['/conf/delete_port/p1']);
    expect(poolRows.length).toBe(0);
    expect(audited.some(a => a.action === 'retail_port_deleted')).toBe(true);
    expect(notified.some(n => /порт удалён/i.test(n.text))).toBe(true);
  });

  it('шаг 3: фейл delete_port на боксе → строка остаётся, повтор в след. цикле', async () => {
    const poolRows = [{
      id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1',
      hold_until: new Date(T0.getTime() - 3600e3).toISOString(),
    }];
    const { deps } = mkDeps({ poolRows });
    deps.proxyConf.getConfAction = async () => ({ ok: false, reason: 'AUTH_WALLED' });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balanceNegativeSince: new Date(T0.getTime() - 8 * 86400e3).toISOString() }));
    await guard.runOnce();
    expect(poolRows.length).toBe(1);                   // не удалили — ретрай позже
    expect(notified.some(n => /порт удалён/i.test(n.text))).toBe(false);   // удаление не случилось
  });

  it('шаг 3 (legacy): клиент без строки пула — порт тоже удаляется по hold-дедлайну', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    // grace 24ч + hold 7дн → дедлайн 8 суток после ухода в минус; «прошло» 9.
    deps.clients.push(mkClient({
      balanceNegativeSince: new Date(T0.getTime() - 9 * 86400e3).toISOString(),
    }));
    await guard.runOnce();
    expect(deleted).toEqual(['/conf/delete_port/p1']);
    expect(audited.some(a => a.action === 'retail_port_deleted' && a.details.legacy === true)).toBe(true);
  });

  it('шаг 5: за 3 дня и 1 день до hold_until — предупреждения (дедуп по дате)', async () => {
    const poolRows = [{
      id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1',
      hold_until: new Date(T0.getTime() + 2 * 86400e3).toISOString(),   // до удаления 2 дня
    }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({
      balanceNegativeSince: new Date(T0.getTime() - 6 * 86400e3).toISOString(),
    }));
    await guard.runOnce();
    expect(notified.some(n => /До удаления порта осталось 2 дн/.test(n.text))).toBe(true);
    // hold_until уже < 1 дня → 1-дневное предупреждение
    poolRows[0].hold_until = new Date(T0.getTime() + 12 * 3600e3).toISOString();
    await guard.runOnce();
    expect(notified.some(n => /остались сутки/.test(n.text))).toBe(true);
  });
});

describe('retail-guard: восстановление', () => {
  it('шаг 4: balance > 0 → blocked → leased, hold NULL, «дата до» = today + floor(balance/avg)', async () => {
    // Списания 100 ₽/день 04–09.08 → avg = 600/7 ≈ 85.71; balance 500 → 5 дней.
    const ledger = [];
    for (let d = 3; d <= 9; d++) ledger.push({ type: 'charge', date: `2026-08-0${d}`, cost: 100 });
    const poolRows = [{ id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1', hold_until: 'x' }];
    const { deps } = mkDeps({ poolRows, ledgerEntries: ledger, resultsFn: () => serverResults('u_a', TODAY) });
    const guard = guardMod.create(deps);
    const client = mkClient({
      balance: 500, debtBlocked: true,
      balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    deps.clients.push(client);
    await guard.runOnce();

    expect(lastValidBefore()).toBe('2026-08-15');      // today + 5 дн
    expect(poolRows[0].status).toBe('leased');
    expect(poolRows[0].hold_until).toBe(null);
    expect(client.balanceNegativeSince).toBe(null);
    expect(client.debtBlocked).toBe(false);            // сброс legacy-флага
    expect(saved).toBe(1);
    expect(audited.some(a => a.action === 'retail_restore')).toBe(true);
    expect(notified.some(n => /сервис восстановлен/i.test(n.text))).toBe(true);
  });

  it('avg = 0 (нет списаний) → дефолт 30 дней', async () => {
    const { deps } = mkDeps({ resultsFn: () => serverResults('u_a', TODAY) });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balance: 500, balanceNegativeSince: T0.toISOString() }));
    await guard.runOnce();
    expect(lastValidBefore()).toBe('2026-09-09');
  });

  it('не укорачиваем более поздний ручной срок (override)', async () => {
    const poolRows = [{ id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1', hold_until: 'x' }];
    const { deps } = mkDeps({ poolRows, resultsFn: () => serverResults('u_a', '2027-01-01') });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balance: 500, balanceNegativeSince: T0.toISOString() }));
    await guard.runOnce();
    expect(posted.length).toBe(0);                     // запись не пошла
    expect(poolRows[0].status).toBe('leased');         // но пул восстановлен
  });
});

describe('retail-guard: тест-день', () => {
  it('leased + test_expires_at < now → отвязка (пустой portName) + free + алерт + уведомление', async () => {
    const poolRows = [{
      id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1',
      test_expires_at: new Date(T0.getTime() - 3600e3).toISOString(),
    }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balance: 100 }));     // баланс в плюсе — конвейер долга не активен
    await guard.runOnce();

    expect(posted.some(p => p.formData.portName === '')).toBe(true);   // отвязка
    expect(poolRows[0].status).toBe('free');
    expect(poolRows[0].client_id).toBe(null);
    expect(poolRows[0].test_expires_at).toBe(null);
    expect(alertsFired.some(a => a.rule === 'retail_test_day_ended')).toBe(true);
    expect(notified.some(n => /Тест-день завершён/.test(n.text))).toBe(true);
  });

  it('test_expires_at в будущем — не трогаем', async () => {
    const poolRows = [{
      id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1',
      test_expires_at: new Date(T0.getTime() + 3600e3).toISOString(),
    }];
    const { deps } = mkDeps({ poolRows });
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balance: 100 }));
    await guard.runOnce();
    expect(poolRows[0].status).toBe('leased');
    expect(posted.length).toBe(0);
  });
});

describe('retail-guard: границы населения и флаг', () => {
  it('юрлицо с минусом — НИКОГДА не трогается', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    const client = mkClient({ clientType: 'legal' });
    deps.clients.push(client);
    await guard.runOnce();
    expect(client.balanceNegativeSince).toBe(null);
    expect(posted.length).toBe(0);
    expect(notified.length).toBe(0);
  });

  it('allowDebt = true — не трогается', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    const client = mkClient({ allowDebt: true });
    deps.clients.push(client);
    await guard.runOnce();
    expect(client.balanceNegativeSince).toBe(null);
    expect(posted.length).toBe(0);
  });

  it('retail_enabled = false → прогон пропускается полностью', async () => {
    const { deps } = mkDeps();
    deps.getSetting = (k, d) => (k === 'retail_enabled' ? false : d);
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient());
    const r = await guard.runOnce();
    expect(r.skipped).toBe('retail_disabled');
    expect(notified.length).toBe(0);
    expect(posted.length).toBe(0);
  });

  it('шаг 6: low-balance runway ≤ 3 дн → уведомление, дедуп 1/сутки', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    // price 300 ₽/мес → ~9.87 ₽/дн; balance 20 → runway ≈ 2 дня.
    deps.clients.push(mkClient({ balance: 20, price: 300 }));
    await guard.runOnce();
    expect(notified.some(n => /хватит примерно на 2 дн/.test(n.text))).toBe(true);
    await guard.runOnce();                             // тот же день — дедуп
    expect(notified.length).toBe(1);
  });

  it('low-balance: runway ≤ 1 дн → отдельное предупреждение', async () => {
    const { deps } = mkDeps();
    const guard = guardMod.create(deps);
    deps.clients.push(mkClient({ balance: 5, price: 300 }));
    await guard.runOnce();
    expect(notified.some(n => /меньше чем на сутки/.test(n.text))).toBe(true);
  });
});
