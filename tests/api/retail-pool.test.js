// B2C Этап 2 (API): пул розницы + B6.
//   • B6: POST /api/admin/assign_modem с пустым newPortName — отвязка (НЕ 400);
//   • GET /api/admin/retail/pool — rows: полный список;
//   • pool/add — создание free-портов на свободных модемах;
//   • legacy_preview / legacy_import — перенос legacy-портов физиков в пул;
//   • buy_proxy тест-тарифа → test_expires_at = выдача + 24ч (миграция 062).
// Роутеры монтируются standalone с моками ProxySmart — живого бокса нет.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createRetailRouter = require('../../src/routes/retail.js');
const createProxiesRouter = require('../../src/routes/proxies.js');

const SRV = { name: 'S1', url: 'http://stub', user: 'u', pass: 'p' };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const passAuth = (req, res, next) => { req.user = { login: 'test_admin', isAdmin: 1 }; next(); };

// ── in-memory retail_pool (как в tests/retail-guard.test.js, + all/insert) ──
function mkPoolDb(rows = []) {
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    _rows: rows,
    all: () => rows,
    byStatus: (s) => rows.filter(r => r.status === s),
    byClient: (cid) => rows.filter(r => r.client_id === cid && ['reserved', 'leased', 'blocked'].includes(r.status)),
    byPort: (srv, pid) => rows.find(r => r.server === srv && r.port_id === pid),
    countByStatus: () => rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    nextFree: (srv) => rows.find(r => r.status === 'free' && r.server === srv),
    reserve: (id, cid, until) => {
      const r = rows.find(x => x.id === id && x.status === 'free');
      if (!r) return false;
      r.status = 'reserved'; r.client_id = cid; r.reserved_until = until;
      return true;
    },
    lease: (id) => { const r = rows.find(x => x.id === id); r.status = 'leased'; r.reserved_until = null; },
    release: (id) => { const r = rows.find(x => x.id === id); r.status = 'free'; r.client_id = null; r.hold_until = null; r.test_expires_at = null; },
    block: (id, h) => { const r = rows.find(x => x.id === id); r.status = 'blocked'; r.hold_until = h; },
    setTestExpires: (id, iso) => { rows.find(x => x.id === id).test_expires_at = iso; },
    insertFree: (srv, pid) => {
      if (rows.some(r => r.server === srv && r.port_id === pid)) return { changes: 0 };
      rows.push({ id: nextId++, server: srv, port_id: pid, status: 'free', client_id: null });
      return { changes: 1 };
    },
    insertLeased: (srv, pid, cid) => {
      if (rows.some(r => r.server === srv && r.port_id === pid)) return { changes: 0 };
      rows.push({ id: nextId++, server: srv, port_id: pid, status: 'leased', client_id: cid });
      return { changes: 1 };
    },
    remove: (id) => { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}

// DEEP-22 (2026-09-18): buy_proxy ведёт durable-покупку — in-memory стаб
// retail_purchases с той же статусной машиной и UNIQUE-ограничениями.
function mkPurchasesDb() {
  const rows = [];
  return {
    _rows: rows,
    byStatus: (st) => rows.filter(r => r.status === st),
    createReserved: (p) => {
      const inFlight = rows.some(r => r.client_id === p.clientId &&
        ['reserved', 'provisioning', 'provisioned', 'charge_failed', 'quarantine'].includes(r.status));
      const testUsed = p.testDay && rows.some(r => r.client_id === p.clientId && r.test_day === 1 && r.status !== 'failed');
      if (inFlight || testUsed) {
        const e = new Error('UNIQUE constraint failed: retail_purchases.client_id');
        e.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw e;
      }
      const row = { id: p.id, client_id: p.clientId, tariff_id: p.tariffId, server: null, port_id: null, pool_row_id: null, amount: p.amount, test_day: p.testDay ? 1 : 0, status: 'reserved' };
      rows.push(row);
      return row;
    },
    setPortInfo: (id, server, portId, poolRowId) => {
      const r = rows.find(x => x.id === id);
      if (r) { r.server = server; r.port_id = portId; r.pool_row_id = poolRowId; }
    },
    setStatus: (id, status) => { const r = rows.find(x => x.id === id); if (r) r.status = status; },
  };
}

function mountRetail({ poolRows = [], clients = [], tariffs = {}, settings = {}, fetchApiImpl, fetchAllResults, posted, user, refusePost = false } = {}) {
  const boxPorts = [];   // порты, реально созданные на «боксе» (видны в list_ports_json)
  const poolDb = mkPoolDb(poolRows);
  const purchasesDb = mkPurchasesDb();
  const cfg = { retail_enabled: true, retail_pool_servers: 'S1', retail_test_day_price: 100, ...settings };
  const auth = (req, res, next) => { req.user = user || { login: 'test_admin', isAdmin: 1 }; next(); };
  const router = createRetailRouter({
    logger: silent,
    authMiddleware: auth, adminMiddleware: auth,
    clients, saveClients: () => {},
    tariffsDb: { byId: (id) => tariffs[id] || null, publicActive: () => Object.values(tariffs).filter(t => t.public && t.active) },
    retailPoolDb: poolDb,
    retailPurchasesDb: purchasesDb,
    atomicDebit: () => {},
    getSetting: (k, d) => (k in cfg ? cfg[k] : d),
    getMoscowNow: () => new Date(),
    findServer: () => SRV,
    fetchApi: async (srv, path) => {
      const base = fetchApiImpl ? await fetchApiImpl(srv, path) : {};
      if (path === '/apix/list_ports_json') {
        const out = { ...(base || {}) };
        for (const c of boxPorts) out[c.imei] = [...(out[c.imei] || []), { portID: c.portID, portName: c.portName }];
        return out;
      }
      return base;
    },
    proxyConf: {
      getConfForm: async () => ({ ok: true, html: `<form><input name="portID" value="port_${Math.random().toString(36).slice(2, 8)}"><input name="proxy_password" value="pw"></form>` }),
      postConfForm: async (_srv, path, formData) => {
        posted && posted.push({ path, formData });
        // ProxySmart не создаёт порт с пустым именем: отвечает 302 на форму, а клиент считает это ok.
        if (!refusePost && String(formData.portName || '').trim()) boxPorts.push({ imei: (path.match(/imei=([^&]+)/) || [])[1], portID: formData.portID, portName: formData.portName });
        return { ok: true };
      },
      getConfAction: async () => ({ ok: true }),
    },
    proxySmart: { invalidateCache() {} },
    parseHtmlInputFields: (html) => {
      const m = html.match(/name="portID" value="([^"]+)"/);
      return { portID: m ? m[1] : undefined, proxy_password: 'pw' };
    },
    fetchAllServersDataCached: async () => fetchAllResults || [],
    auditLog: () => {}, logActivity: () => {}, getClientIp: () => '127.0.0.1',
    alerts: { trigger: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, poolDb, purchasesDb, router };
}

describe('GET /api/admin/retail/pool — rows', () => {
  it('отдаёт counts + полный список строк пула', async () => {
    const { app } = mountRetail({
      poolRows: [
        { id: 1, server: 'S1', port_id: 'p1', status: 'free', client_id: null, hold_until: null, test_expires_at: null, reserved_until: null },
        { id: 2, server: 'S1', port_id: 'p2', status: 'blocked', client_id: 'c1', hold_until: '2026-08-20T00:00:00Z', test_expires_at: null, reserved_until: null },
      ],
    });
    const res = await request(app).get('/api/admin/retail/pool');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ free: 1, blocked: 1 });
    expect(res.body.rows.length).toBe(2);
    expect(res.body.rows[1]).toMatchObject({ port_id: 'p2', status: 'blocked', client_id: 'c1', hold_until: '2026-08-20T00:00:00Z' });
  });
});

const HEALTHY = { IS_ONLINE: 'yes', EXT_IP: '1.2.3.4', SimStatus: 'SIM OK', ping_stats: '160ms, 0% loss' };

describe('POST /api/admin/retail/pool/add', () => {
  it('создаёт free-порты на свободных модемах (пустой portName → apply → insert)', async () => {
    const posted = [];
    const { app, poolDb } = mountRetail({
      posted,
      fetchApiImpl: async (srv, path) => {
        if (path === '/apix/show_status_json') {
          return [
            { modem_details: { IMEI: 'imei_free' }, net_details: HEALTHY },
            { modem_details: { IMEI: 'imei_busy' }, net_details: HEALTHY },
            { modem_details: { IMEI: 'imei_off' }, net_details: { ...HEALTHY, IS_ONLINE: 'no' } },
            // 2026-10-15: онлайн, но выдавать нечего — не кандидаты
            { modem_details: { IMEI: 'imei_noip' }, net_details: { ...HEALTHY, EXT_IP: '' } },
            { modem_details: { IMEI: 'imei_nosim' }, net_details: { ...HEALTHY, SimStatus: 'SIM NOT INSERTED' } },
            { modem_details: { IMEI: 'imei_dead' }, net_details: { ...HEALTHY, ping_stats: '0ms, 100% loss' } },
          ];
        }
        if (path === '/apix/list_ports_json') {
          return { imei_busy: [{ portID: 'px', portName: 'corpClient' }] };   // занят клиентом
        }
        return {};
      },
    });
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 1 });
    expect(res.status).toBe(200);
    expect(res.body.created.length).toBe(1);
    expect(res.body.errors).toEqual([]);
    // add_port пошёл на СВОБОДНЫЙ модем, с пустым portName
    expect(posted[0].path).toBe('/conf/add_port?imei=imei_free');
    expect(posted[0].formData.portName).toMatch(/^randomport\d+$/);   // не пустое: ProxySmart пустое имя игнорирует
    expect(poolDb._rows.some(r => r.status === 'free' && r.port_id === res.body.created[0])).toBe(true);
  });

  it('покупка при пустом пуле сама поднимает порт на свободном модеме (не «закончились»)', async () => {
    const clients = [{ id: 'c_od', login: 'u_od', name: 'O', portName: 'u_od', clientType: 'individual', emailVerified: true, blocked: false, balance: 10000, testUsed: true, tariffId: null }];
    const { app, poolDb } = mountRetail({
      clients, user: { login: 'u_od', isAdmin: 0 }, poolRows: [],
      tariffs: { 21: { id: 21, name: 'T', active: 1, public: 1, duration_hours: null, price: 3000, min_topup_days: 1, server: 'S1', geo: 'MD' } },
      fetchApiImpl: async (srv, path) => path === '/apix/show_status_json'
        ? [{ modem_details: { IMEI: 'imei_e', NICK: 'MD_E' }, net_details: HEALTHY }]
        : {},
    });
    const res = await request(app).post('/api/client/buy_proxy').send({ tariff_id: 21 });
    expect(res.status).toBe(200);
    expect(poolDb._rows.filter(r => r.status === 'leased').length).toBe(1);
  });

  it('подпитка: до цели не хватает → создаёт недостающие, цель достигнута → ничего не делает', async () => {
    const feed = async (srv, path) => path === '/apix/show_status_json'
      ? ['a', 'b', 'c', 'd'].map(x => ({ modem_details: { IMEI: 'imei_' + x, NICK: 'MD_' + x }, net_details: HEALTHY }))
      : {};
    const { router, poolDb } = mountRetail({ poolRows: [], fetchApiImpl: feed });
    const r1 = await router.topUpPool(3);
    expect(r1.servers.S1).toMatchObject({ free: 0, added: 3 });
    expect(poolDb._rows.filter(r => r.status === 'free').length).toBe(3);
    const r2 = await router.topUpPool(3);
    expect(r2.servers.S1).toMatchObject({ free: 3, added: 0 });
  });

  it('ProxySmart «принял» форму, но порт не создал → в пул ничего не пишем (нет призрачных портов)', async () => {
    const feed = async (srv, path) => path === '/apix/show_status_json'
      ? [{ modem_details: { IMEI: 'imei_x', NICK: 'MD_X' }, net_details: HEALTHY }] : {};
    const { app, poolDb } = mountRetail({ poolRows: [], fetchApiImpl: feed, refusePost: true });
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 1 });
    expect(res.body.created).toEqual([]);
    expect(res.body.errors[0].reason).toMatch(/не создал порт/);
    expect(poolDb._rows.length).toBe(0);
  });

  it('модем с техническим randomport-портом (без клиента) остаётся кандидатом; с клиентским — нет', async () => {
    const feed = async (srv, path) => {
      if (path === '/apix/show_status_json') return [
        { modem_details: { IMEI: 'imei_rp', NICK: 'MD_RP' }, net_details: HEALTHY },
        { modem_details: { IMEI: 'imei_cl', NICK: 'MD_CL' }, net_details: HEALTHY }];
      if (path === '/apix/list_ports_json') return { imei_rp: [{ portID: 'prp', portName: 'randomport12' }], imei_cl: [{ portID: 'pcl', portName: 'u_client' }] };
      return {};
    };
    const posted = [];
    const { app } = mountRetail({ poolRows: [], fetchApiImpl: feed, posted });
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 2 });
    expect(res.body.created.length).toBe(1);
    expect(posted[0].path).toBe('/conf/add_port?imei=imei_rp');
    expect(res.body.errors[0].reason).toMatch(/больше нет/);
  });

  it('count вне 1..50 → 400', async () => {
    const { app } = mountRetail();
    const res = await request(app).post('/api/admin/retail/pool/add').send({ server: 'S1', count: 100 });
    expect(res.status).toBe(400);
  });
});

describe('legacy_preview / legacy_import', () => {
  const legacyResults = [{
    serverName: 'S1',
    ports: {
      imei1: [
        { portID: 'p_leg', portName: 'u_legacy' },     // физик-legacy → кандидат
        { portID: 'p_corp', portName: 'ACME Corp' },   // юрлицо → нет
        { portID: 'p_free', portName: '' },            // пустой → нет
      ],
    },
  }];
  const clients = [
    { id: 'c_leg', login: 'u_legacy', portName: 'u_legacy', clientType: 'individual' },
    { id: 'c_corp', login: 'acme', portName: 'ACME Corp', clientType: 'legal' },
  ];

  it('preview: порты физиков вне пула → кандидаты; уже в пуле — исключены', async () => {
    const { app } = mountRetail({
      clients, fetchAllResults: legacyResults,
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_dup', status: 'leased', client_id: 'c_leg' }],
    });
    const res = await request(app).get('/api/admin/retail/pool/legacy_preview');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ server: 'S1', port_id: 'p_leg', login: 'u_legacy', client_id: 'c_leg' }]);
  });

  it('import: insert leased, идемпотентно (дубль → skipped)', async () => {
    const { app, poolDb } = mountRetail({ clients });
    const items = [{ server: 'S1', port_id: 'p_leg', client_id: 'c_leg' }];
    const r1 = await request(app).post('/api/admin/retail/pool/legacy_import').send({ items });
    expect(r1.body.imported).toBe(1);
    expect(poolDb.byPort('S1', 'p_leg')).toMatchObject({ status: 'leased', client_id: 'c_leg' });
    const r2 = await request(app).post('/api/admin/retail/pool/legacy_import').send({ items });
    expect(r2.body.imported).toBe(0);
    expect(r2.body.skipped[0].reason).toBe('duplicate');
    // после импорта preview пуст
    const prev = await request(mountRetail({ clients, fetchAllResults: legacyResults, poolRows: poolDb._rows }).app)
      .get('/api/admin/retail/pool/legacy_preview');
    expect(prev.body.items).toEqual([]);
  });
});

describe('buy_proxy: тест-день проставляет test_expires_at (+24ч)', () => {
  it('duration_hours=24 → строка пула получает дедлайн возврата', async () => {
    const clients = [{
      id: 'c_t', login: 'u_t', name: 'T', portName: 'u_t', clientType: 'individual',
      emailVerified: true, blocked: false, balance: 1000, testUsed: false, tariffId: null,
    }];
    const before = Date.now();
    const { app, poolDb } = mountRetail({
      clients,
      user: { login: 'u_t', isAdmin: 0 },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_test', status: 'free', client_id: null }],
      tariffs: { 7: { id: 7, name: 'Тест-день', active: 1, public: 1, duration_hours: 24, price: 100, min_topup_days: 1, server: 'S1', geo: 'TST' } },
    });
    const res = await request(app)
      .post('/api/client/buy_proxy')
      .send({ tariff_id: 7 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = poolDb.byPort('S1', 'p_test');
    expect(row.status).toBe('leased');
    expect(row.client_id).toBe('c_t');
    const exp = Date.parse(row.test_expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 24 * 3600e3);
    expect(exp).toBeLessThanOrEqual(Date.now() + 24 * 3600e3);
    expect(clients[0].testUsed).toBe(true);
  });

  it('обычная подписка → test_expires_at НЕ проставляется', async () => {
    const clients = [{
      id: 'c_s', login: 'u_s', name: 'S', portName: 'u_s', clientType: 'individual',
      emailVerified: true, blocked: false, balance: 1000, testUsed: true, tariffId: null,
    }];
    const { app, poolDb } = mountRetail({
      clients,
      user: { login: 'u_s', isAdmin: 0 },
      poolRows: [{ id: 1, server: 'S1', port_id: 'p_sub', status: 'free', client_id: null }],
      tariffs: { 9: { id: 9, name: 'Базовый', active: 1, public: 1, duration_hours: null, price: 300, min_topup_days: 1, server: 'S1', geo: 'TST' } },
    });
    const res = await request(app).post('/api/client/buy_proxy').send({ tariff_id: 9 });
    expect(res.status).toBe(200);
    expect(poolDb.byPort('S1', 'p_sub').test_expires_at).toBeFalsy();
  });
});

// 2026-10-15: тариф со списком серверов «S1, S3» — раньше строка целиком
// считалась одним именем сервера, пул не находился и любая покупка кончалась
// «прокси закончились» (так стояли все 4 тарифа розницы в проде).
describe('buy_proxy: тариф со списком серверов', () => {
  it('«S1, S3»: на S1 пусто, на S3 есть свободный порт → выдача с S3', async () => {
    const clients = [{
      id: 'c_m', login: 'u_m', name: 'M', portName: 'u_m', clientType: 'individual',
      emailVerified: true, blocked: false, balance: 10000, testUsed: true, tariffId: null,
    }];
    const { app, poolDb } = mountRetail({
      clients,
      user: { login: 'u_m', isAdmin: 0 },
      poolRows: [{ id: 1, server: 'S3', port_id: 'p_s3', status: 'free', client_id: null }],
      tariffs: { 11: { id: 11, name: '1-29 прокси', active: 1, public: 1, duration_hours: null, price: 4500, min_topup_days: 1, server: 'S1, S3', geo: 'MD' } },
    });
    const res = await request(app).post('/api/client/buy_proxy').send({ tariff_id: 11 });
    expect(res.status).toBe(200);
    expect(poolDb.byPort('S3', 'p_s3')).toMatchObject({ status: 'leased', client_id: 'c_m' });
  });
});

// 2026-10-15: покупка пакетом — гео + количество, ступень цены по общему числу прокси.
describe('buy_proxies: количество, гео и ступени цены', () => {
  const TIERS = {
    1: { id: 1, name: '1-29 прокси', active: 1, public: 1, duration_hours: null, price: 4500, min_topup_days: 1, server: 'S1, S3', geo: 'MD', min_proxies: 1 },
    2: { id: 2, name: '30-49 прокси', active: 1, public: 1, duration_hours: null, price: 4275, min_topup_days: 1, server: 'S1, S3', geo: 'MD', min_proxies: 30 },
    3: { id: 3, name: 'Румыния', active: 1, public: 1, duration_hours: null, price: 5000, min_topup_days: 1, server: 'RO1', geo: 'RO', min_proxies: 1 },
  };
  const pool = (n, server = 'S1', start = 0) => Array.from({ length: n }, (_, i) => ({ id: start + i + 1, server, port_id: `p${start + i}`, status: 'free', client_id: null }));
  const mk = (over = {}) => [{
    id: 'c_b', login: 'u_b', name: 'B', portName: 'u_b', clientType: 'individual',
    emailVerified: true, blocked: false, balance: 100000, testUsed: true, tariffId: null, ...over,
  }];

  it('3 прокси MD → выдано 3 по ступени «1-29», тариф клиента = ступень', async () => {
    const clients = mk();
    const { app, poolDb } = mountRetail({ clients, user: { login: 'u_b', isAdmin: 0 }, poolRows: pool(5), tariffs: TIERS });
    const res = await request(app).post('/api/client/buy_proxies').send({ geo: 'md', quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bought: 3, requested: 3, tier: { id: 1 } });
    expect(poolDb.byStatus('leased').length).toBe(3);
    expect(clients[0].tariffId).toBe(1);
  });

  it('у клиента 28 прокси, покупает ещё 2 → итог 30, ступень «30-49» для всех', async () => {
    const clients = mk({ tariffId: 1 });
    const owned = Array.from({ length: 28 }, (_, i) => ({ id: 100 + i, server: 'S1', port_id: `own${i}`, status: 'leased', client_id: 'c_b' }));
    const { app } = mountRetail({ clients, user: { login: 'u_b', isAdmin: 0 }, poolRows: [...owned, ...pool(2, 'S3')], tariffs: TIERS });
    const res = await request(app).post('/api/client/buy_proxies').send({ geo: 'MD', quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bought: 2, tier: { id: 2, name: '30-49 прокси' }, total_proxies: 30 });
    expect(clients[0].tariffId).toBe(2);
  });

  it('свободных меньше, чем просят → 409 POOL_SHORT без списаний и без смены тарифа', async () => {
    const clients = mk();
    const { app, poolDb } = mountRetail({ clients, user: { login: 'u_b', isAdmin: 0 }, poolRows: pool(2), tariffs: TIERS });
    const res = await request(app).post('/api/client/buy_proxies').send({ geo: 'MD', quantity: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'POOL_SHORT', available: 2 });
    expect(poolDb.byStatus('leased').length).toBe(0);
    expect(clients[0].tariffId).toBe(null);
  });

  it('денег не хватает на первые сутки за все прокси → 402 до выдачи', async () => {
    const clients = mk({ balance: 100 });
    const { app, poolDb } = mountRetail({ clients, user: { login: 'u_b', isAdmin: 0 }, poolRows: pool(5), tariffs: TIERS });
    const res = await request(app).post('/api/client/buy_proxies').send({ geo: 'MD', quantity: 3 });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(poolDb.byStatus('leased').length).toBe(0);
  });

  it('прокси другой страны при действующем тарифе → 409 GEO_LOCKED; количество вне 1–50 → 400', async () => {
    const clients = mk({ tariffId: 1 });
    const { app } = mountRetail({ clients, user: { login: 'u_b', isAdmin: 0 }, poolRows: pool(5, 'RO1'), tariffs: TIERS });
    expect((await request(app).post('/api/client/buy_proxies').send({ geo: 'RO', quantity: 1 })).body.code).toBe('GEO_LOCKED');
    expect((await request(app).post('/api/client/buy_proxies').send({ geo: 'MD', quantity: 0 })).status).toBe(400);
    expect((await request(app).post('/api/client/buy_proxies').send({ geo: 'MD', quantity: 51 })).status).toBe(400);
  });
});

describe('B6: POST /api/admin/assign_modem — пустой newPortName = отвязка', () => {
  function mountProxies(posted) {
    const router = createProxiesRouter({
      logger: silent,
      authMiddleware: passAuth, adminMiddleware: passAuth,
      fetchApi: async () => ({}),
      fetchApiRaw: async () => ({}),
      postFormApi: async () => ({}),
      findServer: () => SRV,
      parseHtmlInputFields: () => ({ proxy_password: 'pw', portName: 'oldName' }),
      auditLog: () => {}, getClientIp: () => '127.0.0.1',
      proxySmart: { invalidateCache() {} },
      proxyConf: {
        getConfForm: async () => ({ ok: true, html: '<form></form>' }),
        postConfForm: async (srv, path, formData) => { posted.push({ path, formData }); return { ok: true }; },
      },
      modemRotationCache: {},
      fetchAllServersDataCached: async () => [],
      syncRotationLog: async () => {}, _rlSelect: { all: () => [] },
      pushSpeedtestEntry: () => {}, ipHistory: {},
    });
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  }

  it('newPortName: "" → 200, отвязка техническим именем randomport… (пустое имя ProxySmart игнорирует; НЕ 400)', async () => {
    const posted = [];
    const app = mountProxies(posted);
    const res = await request(app)
      .post('/api/admin/assign_modem')
      .send({ serverName: 'S1', portID: 'p1', newPortName: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(posted[0].formData.portName).toMatch(/^randomport\d+$/);
  });

  it('newPortName отсутствует (undefined) → 400', async () => {
    const app = mountProxies([]);
    const res = await request(app)
      .post('/api/admin/assign_modem')
      .send({ serverName: 'S1', portID: 'p1' });
    expect(res.status).toBe(400);
  });
});
