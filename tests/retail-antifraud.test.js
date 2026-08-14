// B2C Этап 5 (WP7): антифрод розницы.
//   1) domain-guard: авто-саспенд розничного порта при хите по бан-листу
//      («дата до» = сегодня + пул blocked с ∞ hold + kv-маркер abuse_hold),
//      strikes → blocked=1 + kill сессий; B2B не трогается; дедуп по порту.
//   2) retail-guard: blocked-клиенты пропускаются; abuse_hold-маркер
//      запрещает авто-восстановление; монитор уникальности IP пула.
// Чистые юнит-тесты на моках (паттерн retail-guard.test.js); domain-guard
// получает in-memory SQLite с таблицами top_hosts_* / domain_guard_hits
// (схема — migrations 020/049, минимальный набор колонок).

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const domainGuardMod = require('../src/jobs/domain-guard.js');
const retailGuardMod = require('../src/jobs/retail-guard.js');

const T0 = new Date('2026-08-10T10:00:00+03:00');   // МСК
const TODAY = '2026-08-10';

// ── in-memory БД для domain-guard ──
function mkDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE top_hosts_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_at TEXT NOT NULL,
      server_name TEXT NOT NULL, port_id TEXT NOT NULL, nick TEXT NOT NULL,
      client_name TEXT NOT NULL DEFAULT '', operator TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '', host TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE top_hosts_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
      server_name TEXT NOT NULL, port_id TEXT NOT NULL, nick TEXT NOT NULL DEFAULT '',
      client_name TEXT NOT NULL DEFAULT '', host TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, server_name, port_id, host));
    CREATE TABLE domain_guard_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
      server_name TEXT NOT NULL, client_name TEXT NOT NULL DEFAULT '', nick TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL, matched_domain TEXT NOT NULL,
      hits_delta INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, server_name, client_name, host));
  `);
  return db;
}

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

// Свежий снапшот top_hosts: хост из реального config/blocked-domains.json.
function seedSnapshot(db, rows) {
  const ins = db.prepare(`INSERT INTO top_hosts_detail
    (snapshot_at, server_name, port_id, nick, client_name, host, count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(new Date().toISOString(), r.server || 'S1', r.port_id || 'p1',
      r.nick || '', r.client_name || '', r.host, r.count);
  }
}

function mkDgDeps({ poolRows = [], settings = {}, snapshotRows } = {}) {
  const db = mkDb();
  if (snapshotRows !== null) seedSnapshot(db, snapshotRows || [
    { host: 'absolutbank.by', count: 5, client_name: 'u_a', port_id: 'p1' },
  ]);
  const posted = [], applied = [], notified = [], audited = [], alertsFired = [], killedSessions = [];
  const activity = [];
  const kv = new Map();
  const server = { name: 'S1', apiUrl: 'http://s1' };
  const cfg = {
    retail_enabled: true, domain_guard_suspend_hits: 1, abuse_strikes_block: 2,
    domain_guard_servers: 'S1',
    ...settings,
  };
  const deps = {
    db,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getSetting: (k, d) => (k in cfg ? cfg[k] : d),
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    logActivity: (cat, level, action, target, _msg, _details) => activity.push({ cat, level, action, target }),
    getMoscowToday: () => TODAY,
    getMoscowNow: () => new Date(T0.getTime()),
    auditLog: (who, action, details) => audited.push({ who, action, details }),
    clients: [],
    saveClients: () => { deps._saved = (deps._saved || 0) + 1; },
    retailPoolDb: mkPoolDb(poolRows),
    deleteSessionsByLogin: (login) => killedSessions.push(login),
    notifyClient: async (client, text) => { notified.push({ client: client.login, text }); return true; },
    kvGet: (k) => (kv.has(k) ? { value: kv.get(k) } : undefined),
    kvSet: (k, v) => kv.set(k, v),
    // deps port-validity
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: '<form><input name="proxy_password" value="pw1"></form>' }),
      postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
      getConfAction: async () => ({ ok: true }),
    },
    fetchApi: async (srv, path) => { applied.push(path); return {}; },
    parseHtmlInputFields: () => ({ proxy_password: 'pw1' }),
    findServer: () => server,
    proxySmart: { invalidateCache() {} },
    ledgerDb: { listByClient: () => [] },
  };
  return { db, deps, posted, applied, notified, audited, alertsFired, killedSessions, activity, kv, poolRows };
}

function mkRetailClient(overrides = {}) {
  return {
    id: 'c1', login: 'u_a', name: 'RetailA', portName: 'u_a',
    clientType: 'individual', allowDebt: false, blocked: false, abuseStrikes: 0,
    balance: 100, ...overrides,
  };
}

beforeEach(() => { /* каждый тест собирает свои deps */ });

describe('WP7: domain-guard — авто-саспенд розницы', () => {
  it('хит на розничном порту (pool leased) → «дата до»=сегодня, пул blocked (∞ hold), strike, notify, алерт', async () => {
    const { deps, posted, applied, notified, audited, alertsFired, kv, poolRows } = mkDgDeps({
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    const client = mkRetailClient();
    deps.clients.push(client);
    const guard = domainGuardMod.create(deps);
    const res = await guard.runDomainGuard();

    expect(res.hits).toBe(1);
    // «дата до» = сегодня (механика конвейера retail-guard, НЕ отвязка portName)
    expect(posted.some(p => p.formData.PROXY_VALID_BEFORE === TODAY)).toBe(true);
    expect(posted.every(p => p.formData.portName === undefined)).toBe(true);
    expect(applied).toContain('/apix/apply_port?arg=p1');
    // строка пула → blocked с hold_until NULL (∞ hold, ждёт админа)
    expect(poolRows[0].status).toBe('blocked');
    expect(poolRows[0].hold_until).toBe(null);
    // strike + маркер заморозки
    expect(client.abuseStrikes).toBe(1);
    expect(client.blocked).toBe(false);
    expect(kv.get('abuse_hold:c1')).toBeTruthy();
    expect(JSON.parse(kv.get('abuse_hold:c1'))[0]).toMatchObject({ server: 'S1', port_id: 'p1' });
    expect(kv.get('abuse_susp:c1:S1:p1')).toBe('1');
    expect(deps._saved).toBe(1);
    // уведомления: клиенту + админу
    expect(notified.some(n => /AUP/.test(n.text) && /приостановлен/.test(n.text))).toBe(true);
    expect(alertsFired.some(a => a.rule === 'retail_abuse_suspend' && a.payload.port_id === 'p1')).toBe(true);
    expect(alertsFired.some(a => a.rule === 'domain_guard_hit')).toBe(true);   // общий алерт сохранён
    expect(audited.some(a => a.action === 'retail_abuse_suspend')).toBe(true);
  });

  it('B2B-порт (юрлицо, не в пуле) → НЕ саспендится, только общий алерт', async () => {
    const { deps, posted, notified, alertsFired } = mkDgDeps();
    deps.clients.push({
      id: 'b1', login: 'corp1', name: 'ООО Ромашка', portName: 'corp1',
      clientType: 'legal', blocked: false, abuseStrikes: 0,
    });
    // snapshotRows по умолчанию — client_name 'u_a', подменим на B2B:
    deps.db.prepare('UPDATE top_hosts_detail SET client_name = ?').run('corp1');
    const guard = domainGuardMod.create(deps);
    const res = await guard.runDomainGuard();

    expect(res.hits).toBe(1);
    expect(posted.length).toBe(0);                          // порт не тронут
    expect(notified.length).toBe(0);
    expect(alertsFired.some(a => a.rule === 'retail_abuse_suspend')).toBe(false);
    expect(alertsFired.some(a => a.rule === 'domain_guard_hit')).toBe(true);
    expect(deps.clients[0].abuseStrikes).toBe(0);
  });

  it('strikes достигает abuse_strikes_block → blocked=1 + kill сессий + пометка в алерте', async () => {
    const { deps, killedSessions, alertsFired, notified } = mkDgDeps({
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    const client = mkRetailClient({ abuseStrikes: 1 });     // второе нарушение
    deps.clients.push(client);
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();

    expect(client.abuseStrikes).toBe(2);
    expect(client.blocked).toBe(true);
    expect(killedSessions).toEqual(['u_a']);
    expect(alertsFired.some(a => a.rule === 'retail_abuse_suspend' && a.payload.blocked === true)).toBe(true);
    expect(notified.some(n => /заблокирован/i.test(n.text))).toBe(true);
  });

  it('повторный прогон по тому же порту — дедуп: второй strike НЕ начисляется', async () => {
    const { deps } = mkDgDeps({
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    const client = mkRetailClient();
    deps.clients.push(client);
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    await guard.runDomainGuard();                           // тот же снапшот, тот же день
    expect(client.abuseStrikes).toBe(1);
    expect(client.blocked).toBe(false);
  });

  it('уже заблокированный клиент — повторный саспенд не выполняется', async () => {
    const { deps, posted } = mkDgDeps({
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1', hold_until: null }],
    });
    const client = mkRetailClient({ blocked: true, abuseStrikes: 2 });
    deps.clients.push(client);
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    expect(posted.length).toBe(0);
    expect(client.abuseStrikes).toBe(2);
  });

  it('порог domain_guard_suspend_hits: delta ниже порога → только алерт', async () => {
    const { deps, posted, poolRows } = mkDgDeps({
      settings: { domain_guard_suspend_hits: 10 },          // delta=5 < 10
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    deps.clients.push(mkRetailClient());
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    expect(posted.length).toBe(0);
    expect(poolRows[0].status).toBe('leased');
    expect(deps.clients[0].abuseStrikes).toBe(0);
  });

  it('domain_guard_suspend_hits=0 → авто-саспенд выключен', async () => {
    const { deps, posted, poolRows } = mkDgDeps({
      settings: { domain_guard_suspend_hits: 0 },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    deps.clients.push(mkRetailClient());
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    expect(posted.length).toBe(0);
    expect(poolRows[0].status).toBe('leased');
  });

  it('retail_enabled=false → авто-саспенд не применяется', async () => {
    const { deps, posted, poolRows } = mkDgDeps({
      settings: { retail_enabled: false },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p1', status: 'leased', client_id: 'c1', hold_until: null }],
    });
    deps.clients.push(mkRetailClient());
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    expect(posted.length).toBe(0);
    expect(poolRows[0].status).toBe('leased');
  });

  it('розничность по clientType=individual даже без строки пула (legacy-порт)', async () => {
    const { deps, posted } = mkDgDeps();                    // пул пуст
    deps.clients.push(mkRetailClient());
    const guard = domainGuardMod.create(deps);
    await guard.runDomainGuard();
    expect(posted.some(p => p.formData.PROXY_VALID_BEFORE === TODAY)).toBe(true);
    expect(deps.clients[0].abuseStrikes).toBe(1);
  });
});

// ── retail-guard: антифрод-интеграция (WP7) ──
function mkRgDeps({ poolRows = [], settings = {}, uniqueIpsPct } = {}) {
  const posted = [], notified = [], alertsFired = [];
  const activity = [], audited = [];
  const kv = new Map();
  const fetchedPaths = [];
  const cfg = {
    retail_enabled: true, retail_grace_hours: 24, retail_hold_days: 7,
    retail_pool_servers: 'S1', retail_min_unique_ips: 50,
    ...settings,
  };
  const server = { name: 'S1', apiUrl: 'http://s1' };
  const deps = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    logActivity: (cat, level, action, target) => activity.push({ cat, level, action, target }),
    auditLog: (who, action, details) => audited.push({ who, action, details }),
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: '<form><input name="proxy_password" value="pw1"></form>' }),
      postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
      getConfAction: async () => ({ ok: true }),
    },
    fetchApi: async (srv, path) => {
      fetchedPaths.push(path);
      if (path === '/apix/unique_ips_json') return { UNIQUE_IPS_PERCENT: uniqueIpsPct, TOTAL_ROTATIONS: 100, DAYS: 14 };
      return {};
    },
    parseHtmlInputFields: () => ({ proxy_password: 'pw1' }),
    findServer: (name) => (name === 'S1' ? server : null),
    proxySmart: { invalidateCache() {} },
    ledgerDb: { listByClient: () => [] },
    saveClients: () => { deps._saved = (deps._saved || 0) + 1; },
    getMoscowNow: () => new Date(T0.getTime()),
    fetchAllServersDataCached: async () => [{
      serverName: 'S1',
      ports: { imei1: [{ portID: 'p1', portName: 'u_a', PROXY_VALID_BEFORE: TODAY }] },
    }],
    clients: [],
    retailPoolDb: mkPoolDb(poolRows),
    tariffsDb: { byId: () => null },
    getSetting: (k, d) => (k in cfg ? cfg[k] : d),
    notifyClient: async (client, text) => { notified.push({ client: client.login, text }); return true; },
    kvGet: (k) => (kv.has(k) ? { value: kv.get(k) } : undefined),
    kvSet: (k, v) => kv.set(k, v),
  };
  return { deps, posted, notified, alertsFired, kv, fetchedPaths, poolRows };
}

describe('WP7: retail-guard — антифрод-интеграция', () => {
  it('blocked=1 → клиент полностью пропускается конвейером (даже вход в grace)', async () => {
    const { deps, posted, notified } = mkRgDeps();
    deps.clients.push({
      id: 'c1', login: 'u_a', name: 'R', portName: 'u_a', clientType: 'individual',
      allowDebt: false, blocked: true, abuseStrikes: 2,
      balance: -100, balanceNegativeSince: null,
    });
    const guard = retailGuardMod.create(deps);
    await guard.runOnce();
    expect(deps.clients[0].balanceNegativeSince).toBe(null);   // grace не начат
    expect(posted.length).toBe(0);
    expect(notified.length).toBe(0);
  });

  it('kv-маркер abuse_hold → авто-восстановление после пополнения НЕ выполняется', async () => {
    const poolRows = [{ id: 1, server: 'S1', port_id: 'p1', status: 'blocked', client_id: 'c1', hold_until: null }];
    const { deps, posted, kv, poolRows: rows } = mkRgDeps({ poolRows });
    kv.set('abuse_hold:c1', JSON.stringify([{ server: 'S1', port_id: 'p1', host: 'absolutbank.by', date: TODAY }]));
    deps.clients.push({
      id: 'c1', login: 'u_a', name: 'R', portName: 'u_a', clientType: 'individual',
      allowDebt: false, blocked: false, abuseStrikes: 1,
      balance: 500, balanceNegativeSince: new Date(T0.getTime() - 2 * 86400e3).toISOString(),
    });
    const guard = retailGuardMod.create(deps);
    await guard.runOnce();
    expect(posted.length).toBe(0);                // «дата до» не продлена
    expect(rows[0].status).toBe('blocked');       // пул не разблокирован
    // долговой след тоже не трогаем — это зона антифрода, решает админ
    expect(deps.clients[0].balanceNegativeSince).toBeTruthy();
  });

  it('монитор пула: уникальность IP ниже порога → алерт retail_pool_ip_degraded', async () => {
    const { deps, alertsFired, fetchedPaths } = mkRgDeps({ uniqueIpsPct: 30 });
    const guard = retailGuardMod.create(deps);
    await guard.runOnce();
    expect(fetchedPaths).toContain('/apix/unique_ips_json');
    expect(alertsFired.some(a => a.rule === 'retail_pool_ip_degraded' && a.payload.server === 'S1' && a.payload.uniqueIps === 30)).toBe(true);
  });

  it('монитор пула: уникальность в норме → алерта нет', async () => {
    const { deps, alertsFired } = mkRgDeps({ uniqueIpsPct: 80 });
    const guard = retailGuardMod.create(deps);
    await guard.runOnce();
    expect(alertsFired.some(a => a.rule === 'retail_pool_ip_degraded')).toBe(false);
  });

  it('монитор пула: retail_min_unique_ips=0 → проверка выключена (API не дёргается)', async () => {
    const { deps, fetchedPaths } = mkRgDeps({ settings: { retail_min_unique_ips: 0 }, uniqueIpsPct: 10 });
    const guard = retailGuardMod.create(deps);
    await guard.runOnce();
    expect(fetchedPaths).not.toContain('/apix/unique_ips_json');
  });
});

// ── новые правила alerts.js (WP7): рендер и дедуп-ключи ──
// Без init(): чистые функции реестра (TG-отправку покрывает retail-alerts.test.js).
describe('WP7: правила алертов розницы', () => {
  const alerts = require('../src/telegram/alerts.js');

  it('retail_abuse_suspend: критический, дедуп по client+port, рендер со strikes/blocked', () => {
    const rule = alerts.RULES.retail_abuse_suspend;
    expect(rule).toBeTruthy();
    expect(rule.priority).toBe('critical');
    expect(rule.dedupeKey({ client_id: 'c1', port_id: 'p1' })).not.toBe(rule.dedupeKey({ client_id: 'c1', port_id: 'p2' }));
    const text = rule.render({ client: 'u_a', server: 'S1', port_id: 'p1', host: 'absolutbank.by', strikes: 2, blocked: true });
    expect(text).toContain('u_a');
    expect(text).toContain('absolutbank.by');
    expect(text).toContain('ЗАБЛОКИРОВАН');
    expect(rule.render({ client: 'u_a', server: 'S1', port_id: 'p1', host: 'h', strikes: 1, blocked: false })).not.toContain('ЗАБЛОКИРОВАН');
  });

  it('retail_multiaccount_ip: дедуп по IP, рендер с count/limit', () => {
    const rule = alerts.RULES.retail_multiaccount_ip;
    expect(rule).toBeTruthy();
    expect(rule.dedupeKey({ ip: '1.2.3.4' })).not.toBe(rule.dedupeKey({ ip: '5.6.7.8' }));
    const text = rule.render({ ip: '1.2.3.4', count: 3, limit: 2 });
    expect(text).toContain('1.2.3.4');
    expect(text).toContain('3');
  });

  it('retail_pool_ip_degraded: дедуп по серверу, рендер с процентами', () => {
    const rule = alerts.RULES.retail_pool_ip_degraded;
    expect(rule).toBeTruthy();
    expect(rule.dedupeKey({ server: 'S1' })).not.toBe(rule.dedupeKey({ server: 'S2' }));
    const text = rule.render({ server: 'S1', uniqueIps: 30, min: 50 });
    expect(text).toContain('S1');
    expect(text).toContain('30%');
    expect(text).toContain('50%');
  });
});
