// B3 (ТЗ мониторинга v2, этап 4, 23.08): maintenance-окна обслуживания.
//   - isInMaintenance: совпадение по server / nick, границы включительно;
//   - alerts.trigger() молчит по объекту в активном окне; после удаления
//     окна алерт снова проходит;
//   - CRUD API /api/admin/maintenance (admin-only, валидация, ?active=1).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const maintenance = require('../src/maintenance.js');
const alerts = require('../src/telegram/alerts.js');

function freshDb() {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE server_downtime (id INTEGER PRIMARY KEY, server_name TEXT, down_from TEXT, down_to TEXT)');
  d.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '076_monitoring_v2_stage4.sql'), 'utf8'));
  return d;
}

describe('B3: isInMaintenance', () => {
  let db;
  const now = Date.now();
  beforeAll(() => {
    db = freshDb();
    maintenance.createWindow(db, {
      target_type: 'server', target_id: 'W_SRV',
      from_ts: now - 3600e3, to_ts: now + 3600e3, comment: 'плановые работы', created_by: 't',
    });
    maintenance.createWindow(db, {
      target_type: 'modem', target_id: 'W_MDM',
      from_ts: now - 3600e3, to_ts: now + 3600e3, comment: '', created_by: 't',
    });
    // Завершившееся окно — не должно матчиться.
    maintenance.createWindow(db, {
      target_type: 'server', target_id: 'W_OLD',
      from_ts: now - 7200e3, to_ts: now - 3600e3, comment: '', created_by: 't',
    });
  });
  afterAll(() => db.close());

  it('сервер в активном окне → окно', () => {
    const w = maintenance.isInMaintenance(db, { server: 'W_SRV' }, now);
    expect(w).toBeTruthy();
    expect(w.comment).toBe('плановые работы');
  });

  it('модем матчится по nick', () => {
    expect(maintenance.isInMaintenance(db, { server: 'WHATEVER', nick: 'W_MDM' }, now)).toBeTruthy();
    expect(maintenance.isInMaintenance(db, { server: 'WHATEVER', nick: 'OTHER' }, now)).toBeNull();
  });

  it('другой сервер / вне окна / завершившееся окно → null', () => {
    expect(maintenance.isInMaintenance(db, { server: 'W_OTHER' }, now)).toBeNull();
    expect(maintenance.isInMaintenance(db, { server: 'W_SRV' }, now + 7200e3)).toBeNull();
    expect(maintenance.isInMaintenance(db, { server: 'W_OLD' }, now)).toBeNull();
  });

  it('границы окна включительны', () => {
    const w = maintenance.listWindows(db).find(x => x.target_id === 'W_SRV');
    expect(maintenance.isInMaintenance(db, { server: 'W_SRV' }, w.from_ts)).toBeTruthy();
    expect(maintenance.isInMaintenance(db, { server: 'W_SRV' }, w.to_ts)).toBeTruthy();
    expect(maintenance.isInMaintenance(db, { server: 'W_SRV' }, w.from_ts - 1)).toBeNull();
    expect(maintenance.isInMaintenance(db, { server: 'W_SRV' }, w.to_ts + 1)).toBeNull();
  });

  it('без server/nick → null, пустая таблица → null', () => {
    expect(maintenance.isInMaintenance(db, {}, now)).toBeNull();
    const empty = new Database(':memory:');
    expect(maintenance.isInMaintenance(empty, { server: 'X' }, now)).toBeNull();   // таблицы нет — не падаем
    empty.close();
  });
});

describe('B3: alerts.trigger молчит в maintenance-окне', () => {
  let db, sendMessage;
  beforeAll(() => {
    db = freshDb();
    sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    alerts.init({
      logger: { warn() {}, info() {}, error() {}, debug() {} },
      getSetting: (k, d) => (k === 'telegram_bot_token' ? 'tok' : d),
      appSettings: { telegram_chat_id: '123' },
      kvSetCritical: () => ({ ok: true }),
      kvGet: { get: () => undefined },
      db,
      tgBot: { sendMessage, tgRequest: vi.fn().mockResolvedValue({ ok: true }) },
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // за пределы boot grace
  });
  afterAll(() => { vi.useRealTimers(); db.close(); });
  beforeEach(() => sendMessage.mockClear());

  it('сервер в окне → алерт подавлен, TG не дёргаем', () => {
    const now = Date.now();
    maintenance.createWindow(db, {
      target_type: 'server', target_id: 'MNT1', from_ts: now - 3600e3, to_ts: now + 3600e3, created_by: 't',
    });
    expect(alerts.trigger('server_unreachable', { server: 'MNT1', error: 'timeout' })).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('окно модема глушит модемный алерт по nick', () => {
    const now = Date.now();
    maintenance.createWindow(db, {
      target_type: 'modem', target_id: 'MNTM1', from_ts: now - 3600e3, to_ts: now + 3600e3, created_by: 't',
    });
    expect(alerts.trigger('modem_ping_dead', { server: 'MNTS', nick: 'MNTM1', imei: 'im1', loss: 100 })).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    // ...но алерт по другому модему того же сервера проходит
    expect(alerts.trigger('modem_ping_dead', { server: 'MNTS', nick: 'MNTM2', imei: 'im2', loss: 100 })).toBe(true);
  });

  it('после deleteWindow алерт снова проходит', () => {
    const now = Date.now();
    const { id } = maintenance.createWindow(db, {
      target_type: 'server', target_id: 'MNT3', from_ts: now - 3600e3, to_ts: now + 3600e3, created_by: 't',
    });
    expect(alerts.trigger('server_unreachable', { server: 'MNT3', error: 't' })).toBe(false);
    expect(maintenance.deleteWindow(db, id)).toBe(true);
    expect(alerts.trigger('server_unreachable', { server: 'MNT3', error: 't' })).toBe(true);
  });
});

describe('B3: API /api/admin/maintenance', () => {
  let app, db, token;
  const created = [];
  beforeAll(() => {
    const b = bootApp();
    app = b.app; db = b.db;
    token = asAdmin('mnt_admin');
  });
  afterAll(() => {
    for (const id of created) {
      try { db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id); } catch (_) { /* уже удалено */ }
    }
  });

  it('CRUD: create → list ?active=1 → delete', async () => {
    const now = Date.now();
    const create = await request(app)
      .post('/api/admin/maintenance')
      .set('X-Auth-Token', token)
      .send({ target_type: 'server', target_id: 'API_MNT1', from_ts: now - 60000, to_ts: now + 3600e3, comment: 'апгрейд' });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    created.push(create.body.id);

    const list = await request(app)
      .get('/api/admin/maintenance?active=1')
      .set('X-Auth-Token', token);
    expect(list.status).toBe(200);
    const w = list.body.windows.find(x => x.id === create.body.id);
    expect(w).toBeTruthy();
    expect(w.target_id).toBe('API_MNT1');
    expect(w.created_by).toBe('mnt_admin');

    const del = await request(app)
      .delete('/api/admin/maintenance/' + create.body.id)
      .set('X-Auth-Token', token);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list2 = await request(app)
      .get('/api/admin/maintenance')
      .set('X-Auth-Token', token);
    expect(list2.body.windows.some(x => x.id === create.body.id)).toBe(false);
  });

  it('окно полностью в прошлом → 400', async () => {
    const now = Date.now();
    const r = await request(app)
      .post('/api/admin/maintenance')
      .set('X-Auth-Token', token)
      .send({ target_type: 'server', target_id: 'API_MNT2', from_ts: now - 7200e3, to_ts: now - 3600e3 });
    expect(r.status).toBe(400);
  });

  it('невалидный target_type / интервал → 400', async () => {
    const now = Date.now();
    const bad1 = await request(app)
      .post('/api/admin/maintenance')
      .set('X-Auth-Token', token)
      .send({ target_type: 'planet', target_id: 'X', from_ts: now, to_ts: now + 60000 });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app)
      .post('/api/admin/maintenance')
      .set('X-Auth-Token', token)
      .send({ target_type: 'server', target_id: 'X', from_ts: now + 60000, to_ts: now });
    expect(bad2.status).toBe(400);
  });

  it('без токена → 401', async () => {
    const r = await request(app).get('/api/admin/maintenance');
    expect(r.status).toBe(401);
  });
});
