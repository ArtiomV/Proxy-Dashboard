// ЛК v3: журнал ротаций, настройки прокси, новый пароль порта, профиль,
// начисления партнёрки + джоба «уведомлять, если офлайн».

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const createV3 = require('../src/routes/client-portal-v3.js');
const { rotationReason } = createV3;
const offlineNotify = require('../src/jobs/client-offline-notify.js');

const ALICE = {
  id: 'c1', login: 'alice', name: 'ООО «Альфа»', portName: 'alice', balance: 5000,
  referral_balance: 150, referral_code: 'ALC1', clientType: 'legal', price: 23, currency: 'RUB',
  inn: '7700000000', kpp: '770001001', legalName: 'ООО «Альфа»', address: 'Москва', contractInfo: '№ 1-А',
  createdAt: '2025-01-12T00:00:00Z', tgChatId: 111, email: 'a@a.ru', emailVerified: true,
};
const BOB = { id: 'c2', login: 'bob', name: 'bob', portName: 'bob', referred_by: 'c1', balance: 0 };

// Сервер S1: модем MD_1 (alice, порт S1_p1), модем MD_2 (bob, порт S1_p2)
const SERVER_DATA = [{
  serverName: 'S1',
  status: [{ modem_details: { NICK: 'MD_1', IMEI: 'IMEI1' } }, { modem_details: { NICK: 'MD_2', IMEI: 'IMEI2' } }],
  ports: { IMEI1: [{ portID: 'p1', portName: 'alice' }], IMEI2: [{ portID: 'p2', portName: 'bob' }] },
}];
function mergeServerData(_results, portNameFilter) {
  const ports = {
    S1_IMEI1: [{ portID: 'S1_p1', LOGIN: 'alogin', portName: 'alice', _server: 'S1' }],
    S1_IMEI2: [{ portID: 'S1_p2', LOGIN: 'blogin', portName: 'bob', _server: 'S1' }],
  };
  const out = {};
  for (const [k, l] of Object.entries(ports)) {
    const f = l.filter(p => portNameFilter === '*' || p.portName === portNameFilter);
    if (f.length) out[k] = f;
  }
  return { ports: out, status: [], bandwidth: {} };
}

let db, app, postApi, fetchApi;
const LEDGER = {
  c1: [{ type: 'referral_withdraw', amount: 50, date: '2026-09-01' }],
  c2: [
    { type: 'payment', amount: 1000, date: '2026-09-10', timestamp: '2026-09-10T10:00:00Z' },
    { type: 'charge', cost: 23, date: new Date().toISOString().slice(0, 10) },
  ],
};

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, admin TEXT, action TEXT, entity_type TEXT, entity_id TEXT, details TEXT);
    CREATE TABLE rotation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT, nick TEXT, old_ip TEXT, new_ip TEXT,
      started_at TEXT, ended_at TEXT, took_sec REAL, attempt INTEGER, caller TEXT, target_mode TEXT);
    CREATE TABLE traffic_hourly (port_id TEXT, client_name TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER);
  `);
  const now = Date.now();
  const ts = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const ins = db.prepare('INSERT INTO rotation_log (server_name,nick,old_ip,new_ip,started_at,took_sec,caller) VALUES (?,?,?,?,?,?,?)');
  ins.run('S1', 'MD_1', '1.1.1.1', '1.1.1.2', ts(now - 60e3), 8, 'cron');
  ins.run('S1', 'MD_1', '1.1.1.2', '1.1.1.3', ts(now - 120e3), 10, 'web');
  ins.run('S1', 'MD_1', '1.1.1.3', '1.1.1.4', ts(now - 180e3), 6, 'reset_url');
  ins.run('S1', 'MD_1', '1.1.1.0', '1.1.1.1', ts(now - 40 * 864e5), 6, 'cron');   // вне окна 30 дн
  ins.run('S1', 'MD_2', '9.9.9.9', '9.9.9.8', ts(now - 60e3), 6, 'cron');          // чужой модем

  postApi = vi.fn(async () => ({ ok: true }));
  fetchApi = vi.fn(async () => ({ ok: true }));
  const clients = [ALICE, BOB];
  const byLogin = new Map(clients.map(c => [c.login, c]));
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { login: req.get('x-login') || 'alice', portNameFilter: req.get('x-login') === 'bob' ? 'bob' : 'alice' }; next(); });
  app.use(createV3({
    db, logger: { info() {}, warn() {}, error() {} },
    authMiddleware: (req, res, next) => next(),
    fetchAllServersDataCached: async () => SERVER_DATA,
    mergeServerData, fetchApi, postApi,
    findServer: n => (n === 'S1' ? { name: 'S1' } : null),
    knownModems: { S1: { p1: { nick: 'MD_1', imei: 'IMEI1', portName: 'alice' }, p2: { nick: 'MD_2', imei: 'IMEI2', portName: 'bob' } } },
    clients, clientById: new Map(clients.map(c => [c.id, c])), clientByLogin: byLogin,
    ledgerDb: { listByClient: id => LEDGER[id] || [] },
    auditLog() {}, getClientIp: () => '127.0.0.1',
    proxySmart: { invalidateCache() {} }, getSetting: (k, d) => d,
  }));
});
afterAll(() => db.close());

describe('rotationReason', () => {
  it('cron → timer, web → manual, reset_url → link, api → api', () => {
    expect(rotationReason({ caller: 'cron' })).toBe('timer');
    expect(rotationReason({ caller: 'web' })).toBe('manual');
    expect(rotationReason({ caller: 'reset_url' })).toBe('link');
    expect(rotationReason({ caller: 'apix' })).toBe('api');
    expect(rotationReason({})).toBe('timer');
  });
});

describe('/api/client/rotation_log', () => {
  it('свой модем: окно 30 дней, счётчики причин, уникальные IP', async () => {
    const r = await request(app).get('/api/client/rotation_log?nick=MD_1&serverName=S1');
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ all: 3, timer: 1, manual: 1, ext: 1 });
    expect(r.body.uniqueIps).toBe(3);
    expect(r.body.avgTook).toBe(8);
    expect(r.body.entries[0].to).toBe('1.1.1.2');   // свежие сверху
  });
  it('фильтр причины ext = ссылка + API', async () => {
    const r = await request(app).get('/api/client/rotation_log?nick=MD_1&serverName=S1&reason=ext');
    expect(r.body.total).toBe(1);
    expect(r.body.entries[0].reason).toBe('link');
  });
  it('чужой модем — 403', async () => {
    const r = await request(app).get('/api/client/rotation_log?nick=MD_2&serverName=S1');
    expect(r.status).toBe(403);
  });
});

describe('/api/client/proxy_prefs', () => {
  it('сохраняет название и флаг уведомлений, пустое название удаляет', async () => {
    let r = await request(app).post('/api/client/proxy_prefs').send({ nick: 'MD_1', serverName: 'S1', label: '  Парсер WB\n поток 2 ', notifyOffline: true });
    expect(r.status).toBe(200);
    expect(r.body.labels.MD_1).toBe('Парсер WB поток 2');
    expect(r.body.notifyOffline.MD_1).toBe(true);
    r = await request(app).get('/api/client/proxy_prefs');
    expect(r.body.labels.MD_1).toBe('Парсер WB поток 2');
    r = await request(app).post('/api/client/proxy_prefs').send({ nick: 'MD_1', label: '' });
    expect(r.body.labels.MD_1).toBeUndefined();
    expect(r.body.notifyOffline.MD_1).toBe(true);
  });
  it('чужой ник — 403', async () => {
    const r = await request(app).post('/api/client/proxy_prefs').send({ nick: 'MD_2', label: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('/api/client/proxy_password', () => {
  it('свой порт: store_port с сырыми IMEI/portID и apply_port', async () => {
    const r = await request(app).post('/api/client/proxy_password').send({ portId: 'S1_p1', serverName: 'S1' });
    expect(r.status).toBe(200);
    expect(r.body.password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(postApi).toHaveBeenCalledWith({ name: 'S1' }, '/crud/store_port', { IMEI: 'IMEI1', portID: 'p1', proxy_password: r.body.password });
    expect(fetchApi).toHaveBeenCalledWith({ name: 'S1' }, '/apix/apply_port?arg=p1');
  });
  it('чужой порт — 403, без вызова ProxySmart', async () => {
    postApi.mockClear();
    const r = await request(app).post('/api/client/proxy_password').send({ portId: 'S1_p2', serverName: 'S1' });
    expect(r.status).toBe(403);
    expect(postApi).not.toHaveBeenCalled();
  });
});

describe('/api/client/profile', () => {
  it('учётная запись и реквизиты', async () => {
    db.prepare("INSERT INTO audit_log (timestamp, admin, action) VALUES ('2026-01-12T10:00:00Z','alice','password_changed')").run();
    const r = await request(app).get('/api/client/profile');
    expect(r.status).toBe(200);
    expect(r.body.clientTypeLabel).toBe('Юридическое лицо');
    expect(r.body.legal).toMatchObject({ inn: '7700000000', kpp: '770001001', contract: '№ 1-А' });
    expect(r.body.pwChangedAt).toBe('2026-01-12T10:00:00Z');
    expect(r.body.tgLinked).toBe(true);
  });
});

describe('/api/client/referral_stats', () => {
  it('начисления по платежам рефералов, «начислено всего» = остаток + выведено', async () => {
    const r = await request(app).get('/api/client/referral_stats');
    expect(r.status).toBe(200);
    expect(r.body.referrals).toBe(1);
    expect(r.body.active).toBe(1);
    expect(r.body.accruals).toEqual([{ date: '2026-09-10', client: 'bob', pay: 1000, fee: 150 }]);
    expect(r.body.totalEarned).toBe(200);
    expect(r.body.rate).toBe(0.15);
  });
});

describe('client-offline-notify', () => {
  function setup(lastOnlineAgoMs) {
    const sent = [];
    const uptimeTracking = { S1_IMEI1: { last_online_check: new Date(Date.now() - lastOnlineAgoMs).toISOString() } };
    const job = offlineNotify.create({
      db, logger: { warn() {} },
      clientById: new Map([['c1', ALICE]]),
      uptimeTracking,
      knownModems: { S1: { p1: { nick: 'MD_1', imei: 'IMEI1', portName: 'alice' } } },
      notifyClient: async (c, text) => { sent.push(text); return true; },
    });
    return { job, sent, uptimeTracking };
  }
  it('офлайн > 5 мин → одно уведомление, возврат → «снова работает»', async () => {
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('client_proxy_prefs:c1', ?)").run(JSON.stringify({ notifyOffline: { MD_1: true } }));
    const { job, sent, uptimeTracking } = setup(7 * 60e3);
    await job.tick();
    await job.tick();
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('MD_1');
    uptimeTracking.S1_IMEI1.last_online_check = new Date().toISOString();
    await job.tick();
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('снова работает');
  });
  it('меньше 5 минут — молчим; лежал дольше часа (после рестарта) — молчим и о возврате', async () => {
    let s = setup(2 * 60e3);
    await s.job.tick();
    expect(s.sent.length).toBe(0);
    s = setup(3 * 3600e3);
    await s.job.tick();
    s.uptimeTracking.S1_IMEI1.last_online_check = new Date().toISOString();
    await s.job.tick();
    expect(s.sent.length).toBe(0);
  });
});
