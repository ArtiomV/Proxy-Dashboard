// 2026-09-18 · Регрессия DEEP-26 (FIX-SPEC §): адресное удаление клиента по ID.
// Настоящий роутер routes/clients; фид портов — управляемые Promise-барьеры
// (без случайных sleep). На коде до исправления каждый тест падал:
//   • конкурентные удаления A и B фактически удаляли A и C (индекс в массиве
//     запоминался до await проверки портов);
//   • ошибка фида портов РАЗРЕШАЛА удаление («proceeding with deletion»);
//   • проверка смотрела только bw — порт, видный лишь в авторитетном реестре
//     назначений ports, удаление не останавливал.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const createClientsRouter = cjsRequire('../src/routes/clients.js');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const pass = (_req, _res, next) => next();

function handler(router, url, method) {
  return router.stack.find(l => l.route && l.route.path === url && l.route.methods[method]).route.stack.at(-1).handle;
}
function mockRes() {
  return { statusCode: 200, body: null,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; return this; } };
}

function mount({ clientsArr, feed }) {
  const deleted = [];
  const router = createClientsRouter({
    db: null, logger: silent,
    authMiddleware: pass, adminMiddleware: pass,
    validate: () => pass,
    clients: clientsArr,
    clientById: new Map(clientsArr.map(c => [c.id, c])),
    clientByLogin: new Map(), clientByApiKey: new Map(), clientByInn: new Map(), clientByResetToken: new Map(),
    users: {},
    fetchAllServersDataCached: feed,
    saveClients: () => {}, rebuildClientMaps: () => {},
    deleteSessionsByLogin: () => {},
    auditLog: (_actor, action, data) => { if (action === 'delete_client') deleted.push(data.clientId); },
    logActivity: () => {}, getClientIp: () => 'test',
  });
  return { router, deleted, remove: handler(router, '/api/admin/clients/:id', 'delete') };
}

const mkClients = () => ['a', 'b', 'c'].map(id => ({ id, login: id, name: id, portName: id }));

describe('DEEP-26: конкурентное удаление клиентов адресно по ID', () => {
  it('удаление A и B с барьерами — удалены A и B, C остаётся', async () => {
    const clients = mkClients();
    const pending = [];
    const { remove, deleted } = mount({
      clientsArr: clients,
      feed: () => new Promise(resolve => pending.push(resolve)),
    });
    const first = remove({ params: { id: 'a' }, user: { login: 'admin' } }, mockRes());
    const second = remove({ params: { id: 'b' }, user: { login: 'admin' } }, mockRes());
    // A завершается первым, B — вторым: на старом коде сохранённый индекс B
    // после splice A указывал на C — удалялись A и C.
    pending[0]([]);
    await first;
    pending[1]([]);
    const r2 = mockRes();
    void r2;
    await second;
    expect(deleted).toEqual(['a', 'b']);
    expect(clients.map(c => c.id)).toEqual(['c']);
  });

  it('ошибка фида портов — удаление НЕ подтверждено (502), клиент остаётся', async () => {
    const clients = mkClients();
    const { remove, deleted } = mount({
      clientsArr: clients,
      feed: () => Promise.reject(new Error('all boxes unreachable')),
    });
    const res = mockRes();
    await remove({ params: { id: 'a' }, user: { login: 'admin' } }, res);
    // Отсутствие данных — невозможность подтвердить удаление, а не разрешение.
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('PORTS_FEED_UNAVAILABLE');
    expect(deleted).toEqual([]);
    expect(clients.length).toBe(3);
  });

  it('порт виден только в реестре назначений ports (не в bw) — удаление запрещено', async () => {
    const clients = mkClients();
    const { remove, deleted } = mount({
      clientsArr: clients,
      feed: async () => [{ serverName: 'S1', bw: {}, ports: { imei1: [{ portID: 'p1', portName: 'a' }] } }],
    });
    const res = mockRes();
    await remove({ params: { id: 'a' }, user: { login: 'admin' } }, res);
    expect(res.statusCode).toBe(400);
    expect(deleted).toEqual([]);
    expect(clients.length).toBe(3);
  });

  it('нулевой трафик живого порта в bw — порт занят, удаление запрещено', async () => {
    const clients = mkClients();
    const { remove, deleted } = mount({
      clientsArr: clients,
      feed: async () => [{ serverName: 'S1', bw: { p1: { portName: 'b', bandwidth_bytes_day_in: 0 } } }],
    });
    const res = mockRes();
    await remove({ params: { id: 'b' }, user: { login: 'admin' } }, res);
    expect(res.statusCode).toBe(400);
    expect(deleted).toEqual([]);
    expect(clients.map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('портов нет — удаление проходит, чужие ID не затронуты', async () => {
    const clients = mkClients();
    const { remove, deleted } = mount({ clientsArr: clients, feed: async () => [{ serverName: 'S1', bw: {}, ports: {} }] });
    const res = mockRes();
    await remove({ params: { id: 'b' }, user: { login: 'admin' } }, res);
    expect(res.statusCode).toBe(200);
    expect(deleted).toEqual(['b']);
    expect(clients.map(c => c.id)).toEqual(['a', 'c']);
  });
});
