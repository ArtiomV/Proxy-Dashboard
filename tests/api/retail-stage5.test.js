// B2C Этап 5 (WP7): антифрод розницы — API-часть.
//   - лимит аккаунтов на reg_ip (retail_max_accounts_per_ip): 403 с нейтральным
//     текстом + след в audit_log (оба пути — email и TG Login Widget);
//   - blocked=1 → 403 на КАЖДОМ запросе (authMiddleware) + kill сессий;
//   - POST /api/admin/clients/:id/unblock — разблокировка только админом;
//   - POST /api/admin/retail/client/rehabilitate — возврат портов по kv-маркеру
//     abuse_hold (боевого бокса в тесте нет — проверяем контракт/ошибки/аудит).
// Харнес общий (tests/_helpers/app.js), БД общая на весь прогон — свои строки
// чистим, настройки retail_max_accounts_per_ip сохраняем/восстанавливаем.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db, adminToken;

function kvSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run(key, value);
}

function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
}

// Лимит мультиаккаунтов: и в kv, и в in-memory appSettings (стабильная
// идентичность — мутация видна всем роутерам, tests/state-stable-identity).
function setIpLimit(n) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_max_accounts_per_ip = n;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_max_accounts_per_ip = n;
}

function cleanup() {
  db.prepare("DELETE FROM clients WHERE login LIKE 'u_%' OR email LIKE '%@wp7-test.local'").run();
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
  db.prepare("DELETE FROM kv_store WHERE key LIKE 'abuse_hold:%'").run();
  // in-memory: регистрации живут в state.clients — вычищаем и там, иначе
  // уникальность email (in-memory find) мешает повторным прогонам.
  const arr = stateMod.state.clients;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/^u_/.test(arr[i].login || '') || /@wp7-test\.local$/.test(arr[i].email || '')) arr.splice(i, 1);
  }
}

function syncClient(login, patch) {
  const c = stateMod.state.clients.find(x => x.login === login);
  if (c) Object.assign(c, patch);
  return c;
}

async function register(email) {
  return request(app).post('/api/register')
    .send({ email, password: 'password123', consent: true });
}

// Валидный payload Telegram Login Widget (подпись по токену бота из настроек).
function tgPayload(id, botToken) {
  const p = { id, first_name: 'WP7', auth_date: Math.floor(Date.now() / 1000) };
  const checkString = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  p.hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return p;
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  cleanup();
  setRetail(true);
});

afterAll(() => {
  setRetail(false);
  setIpLimit(2);   // дефолт ТЗ; соседние сьюты поднимают сами при надобности
  stateMod.state.appSettings.telegram_bot_token = '';
  cleanup();
});

describe('WP7: лимит аккаунтов на reg_ip (retail_max_accounts_per_ip)', () => {
  it('превышение → 403 с нейтральным текстом + audit retail_multiaccount_ip', async () => {
    setIpLimit(2);
    expect((await register('multi1@wp7-test.local')).status).toBe(200);
    expect((await register('multi2@wp7-test.local')).status).toBe(200);
    const third = await register('multi3@wp7-test.local');
    expect(third.status).toBe(403);
    expect(third.body.error).not.toMatch(/IP|лимит|мульти/i);   // нейтрально — причину не раскрываем
    expect(db.prepare('SELECT * FROM clients WHERE email = ?').get('multi3@wp7-test.local')).toBeUndefined();
    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'retail_multiaccount_ip' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.details).count).toBeGreaterThanOrEqual(2);
    setIpLimit(1000);
  });

  it('лимит 0 → контур выключен', async () => {
    setIpLimit(0);
    expect((await register('nolimit1@wp7-test.local')).status).toBe(200);
    expect((await register('nolimit2@wp7-test.local')).status).toBe(200);
    setIpLimit(1000);
  });

  it('TG-путь: тот же лимит при СОЗДАНИИ аккаунта; вход существующего не режется', async () => {
    const BOT = 'wp7_test_bot_token';
    // getSetting читает in-memory appSettings (токен — секрет, но здесь тестовый).
    stateMod.state.appSettings.telegram_bot_token = BOT;

    // Один аккаунт уже есть с этого IP → лимит 1: создание через TG отклонено.
    setIpLimit(1);
    const denied = await request(app).post('/api/auth/telegram').send(tgPayload(990001, BOT));
    expect(denied.status).toBe(403);

    // Подняли лимит → аккаунт создаётся; повторный вход тем же tg id — не создание.
    setIpLimit(1000);
    const created = await request(app).post('/api/auth/telegram').send(tgPayload(990001, BOT));
    expect(created.status).toBe(200);
    expect(created.body.login).toMatch(/^u_/);
    const again = await request(app).post('/api/auth/telegram').send(tgPayload(990001, BOT));
    expect(again.status).toBe(200);
    expect(again.body.login).toBe(created.body.login);
  });
});

describe('WP7: blocked=1 — 403 на каждом запросе + kill сессий', () => {
  it('живая сессия заблокированного клиента умирает сразу (authMiddleware)', async () => {
    const reg = await register('blocked@wp7-test.local');
    expect(reg.status).toBe(200);
    const { login, token } = reg.body;

    const okBefore = await request(app).get('/api/client/tariffs').set('X-Auth-Token', token);
    expect(okBefore.status).toBe(200);

    // Блокируем «извне» (как делает антифрод): БД + in-memory.
    db.prepare('UPDATE clients SET blocked = 1 WHERE login = ?').run(login);
    syncClient(login, { blocked: true });

    const denied = await request(app).get('/api/client/tariffs').set('X-Auth-Token', token);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/заблокирован/i);
    // Сессии убиты — следующий запрос уже 401.
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE login = ?').get(login).c).toBe(0);
    const after = await request(app).get('/api/client/tariffs').set('X-Auth-Token', token);
    expect(after.status).toBe(401);
  });

  it('login заблокированного → 403 ДО проверки пароля', async () => {
    const res = await request(app).post('/api/login')
      .send({ login: 'blocked@wp7-test.local', password: 'wrong-password' });
    expect(res.status).toBe(403);
  });

  it('admin unblock: blocked=0 + reset_strikes → login снова работает', async () => {
    const client = stateMod.state.clients.find(x => x.email === 'blocked@wp7-test.local');
    expect(client).toBeTruthy();
    db.prepare('UPDATE clients SET abuse_strikes = 2 WHERE id = ?').run(client.id);
    syncClient(client.login, { abuseStrikes: 2 });

    // клиент не может разблокировать себя/других
    const asClientTok = (await register('notadmin@wp7-test.local')).body.token;
    const forbidden = await request(app)
      .post(`/api/admin/clients/${client.id}/unblock`)
      .set('X-Auth-Token', asClientTok)
      .send({});
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/unblock`)
      .set('X-Auth-Token', adminToken)
      .send({ reset_strikes: true });
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(false);
    expect(res.body.abuseStrikes).toBe(0);
    expect(client.blocked).toBe(false);
    expect(client.abuseStrikes).toBe(0);
    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'retail_unblock' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toBeTruthy();

    const login = await request(app).post('/api/login')
      .send({ login: 'blocked@wp7-test.local', password: 'password123' });
    expect(login.status).toBe(200);
  });

  it('unblock без reset_strikes: strikes сохраняются', async () => {
    const reg = await register('strikes@wp7-test.local');
    const client = syncClient(reg.body.login, { blocked: true, abuseStrikes: 1 });
    db.prepare('UPDATE clients SET blocked = 1, abuse_strikes = 1 WHERE login = ?').run(reg.body.login);
    const res = await request(app)
      .post(`/api/admin/clients/${client.id}/unblock`)
      .set('X-Auth-Token', adminToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.abuseStrikes).toBe(1);
  });
});

describe('WP7: реабилитация портов (POST /api/admin/retail/client/rehabilitate)', () => {
  it('нет маркера abuse_hold → ok, restored=0; не-админу 403', async () => {
    const reg = await register('rehab@wp7-test.local');
    const client = syncClient(reg.body.login, {});

    const forbidden = await request(app)
      .post('/api/admin/retail/client/rehabilitate')
      .set('X-Auth-Token', reg.body.token)
      .send({ client_id: client.id });
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post('/api/admin/retail/client/rehabilitate')
      .set('X-Auth-Token', adminToken)
      .send({ client_id: client.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restored).toBe(0);
  });

  it('маркер есть, но бокс недоступен (в тесте нет S1) → ошибка по порту, маркер НЕ снят', async () => {
    const reg = await register('rehab2@wp7-test.local');
    const client = syncClient(reg.body.login, {});
    db.prepare("INSERT INTO retail_pool (server, port_id, status, client_id) VALUES ('S1', 'portWP7A', 'blocked', ?)").run(client.id);
    kvSet(`abuse_hold:${client.id}`, JSON.stringify([{ server: 'S1', port_id: 'portWP7A', host: 'absolutbank.by', date: '2026-08-10' }]));

    const res = await request(app)
      .post('/api/admin/retail/client/rehabilitate')
      .set('X-Auth-Token', adminToken)
      .send({ client_id: client.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors.length).toBe(1);
    // маркер сохранён — retail-guard не начнёт авто-восстановление, ретрай возможен
    expect(kvGetValue(`abuse_hold:${client.id}`)).toBeTruthy();
    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'retail_rehabilitate' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toBeTruthy();
    db.prepare("DELETE FROM retail_pool WHERE port_id = 'portWP7A'").run();
  });

  it('retail_enabled=false → 404', async () => {
    setRetail(false);
    const res = await request(app)
      .post('/api/admin/retail/client/rehabilitate')
      .set('X-Auth-Token', adminToken)
      .send({ client_id: 'whatever' });
    expect(res.status).toBe(404);
    setRetail(true);
  });
});

function kvGetValue(key) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
  return row && row.value;
}
