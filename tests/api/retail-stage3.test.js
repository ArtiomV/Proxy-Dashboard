// B2C Этап 3 (WP5): единый TG-бот — API-часть.
//   - POST /api/client/tg_link_code / tg_unlink (привязка Telegram из ЛК);
//   - payload /api/client/referral: tgLinked + botUsername;
//   - настройки: telegram_admin_ids / retail_bulk_buy_threshold / retail_pool_min_free;
//   - telegram_bot_token — секрет (enc1: в kv, маска в GET);
//   - notifyClient при ручном зачислении (system_log → client_notify).
// Бот в тестах не стартует (NODE_ENV=test) — tgBot.init здесь нужен только для
// getBotUsername внутри tg_link_code (kv-кэш подсёдан, сеть не дёргается).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');
const tgBot = require('../../src/telegram/bot.js');

let app, db, adminToken;

function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  // WP7 (Э5): лимит аккаунтов на reg_ip — регистраций в сьюте больше дефолтных 2.
  if (on) settings.retail_max_accounts_per_ip = 1000;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
  if (on) stateMod.state.appSettings.retail_max_accounts_per_ip = 1000;
}

function kvSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run(key, value);
}

function cleanup() {
  db.prepare("DELETE FROM clients WHERE login LIKE 'u_%' OR email LIKE '%@wp5-test.local'").run();
  db.prepare("DELETE FROM auth_tokens").run();
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
  db.prepare("DELETE FROM kv_store WHERE key = 'tg_bot_username'").run();
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  cleanup();
  setRetail(true);
  // Username бота — из kv-кэша (getMe не дёргаем, сети в тестах нет).
  kvSet('tg_bot_username', 'wp5_test_bot');
  // tgBot.init в проде делает startup.js; в тестах — вручную (нужен только
  // getBotUsername для /api/client/tg_link_code).
  tgBot.init({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getSetting: (k, d) => { const v = stateMod.state.appSettings[k]; return v === undefined ? d : v; },
    setSetting: (k, v) => { stateMod.state.appSettings[k] = v; },
    kvGet: (k) => db.prepare('SELECT value FROM kv_store WHERE key = ?').get(k),
    kvSet,
  });
});

afterAll(() => {
  setRetail(false);
  cleanup();
  // Откатываем настройки, которых касались тесты (общая kv app_settings).
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  if (row) {
    const s = JSON.parse(row.value);
    delete s.telegram_bot_token;
    delete s.telegram_admin_ids;
    db.prepare("UPDATE kv_store SET value = ? WHERE key = 'app_settings'").run(JSON.stringify(s));
  }
  stateMod.state.appSettings.telegram_bot_token = '';
  stateMod.state.appSettings.telegram_admin_ids = '';
});

async function registerClient(email) {
  const res = await request(app)
    .post('/api/register')
    .send({ email, password: 'password123', consent: true });
  expect(res.status).toBe(200);
  return { login: res.body.login, token: res.body.token };
}

function syncTgChatId(login, tgChatId) {
  db.prepare('UPDATE clients SET tg_chat_id = ? WHERE login = ?').run(tgChatId, login);
  const c = stateMod.state.clients.find(x => x.login === login);
  if (c) c.tgChatId = tgChatId;
}

describe('WP5: POST /api/client/tg_link_code', () => {
  it('без auth → 401', async () => {
    const res = await request(app).post('/api/client/tg_link_code').send({});
    expect(res.status).toBe(401);
  });

  it('выдаёт одноразовый код + url с deep-link на бота (кэш username из kv)', async () => {
    const { login, token } = await registerClient('link@wp5-test.local');
    const res = await request(app)
      .post('/api/client/tg_link_code')
      .set('X-Auth-Token', token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.code).toMatch(/^[a-f0-9]{48}$/);
    expect(res.body.url).toBe(`https://t.me/wp5_test_bot?start=link_${res.body.code}`);
    expect(res.body.ttlMin).toBe(15);
    // В БД — sha256 хэш, тип tg_link, не использован
    const row = db.prepare("SELECT * FROM auth_tokens WHERE login = ? AND type = 'tg_link'").get(login);
    expect(row).toBeTruthy();
    expect(row.used).toBe(0);
    expect(row.token).not.toBe(res.body.code);
  });

  it('уже привязан → 409 TG_ALREADY_LINKED', async () => {
    const { login, token } = await registerClient('linked@wp5-test.local');
    syncTgChatId(login, '555000');
    const res = await request(app)
      .post('/api/client/tg_link_code')
      .set('X-Auth-Token', token)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TG_ALREADY_LINKED');
    syncTgChatId(login, null);
  });
});

describe('WP5: POST /api/client/tg_unlink', () => {
  it('снимает tg_chat_id (идемпотентно)', async () => {
    const { login, token } = await registerClient('unlink@wp5-test.local');
    syncTgChatId(login, '555001');

    const res = await request(app)
      .post('/api/client/tg_unlink')
      .set('X-Auth-Token', token)
      .send({});
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT tg_chat_id FROM clients WHERE login = ?').get(login).tg_chat_id).toBeNull();
    expect(stateMod.state.clients.find(x => x.login === login).tgChatId).toBeNull();

    // повтор — ок, ничего не падает
    const again = await request(app)
      .post('/api/client/tg_unlink')
      .set('X-Auth-Token', token)
      .send({});
    expect(again.status).toBe(200);
  });

  it('без auth → 401', async () => {
    const res = await request(app).post('/api/client/tg_unlink').send({});
    expect(res.status).toBe(401);
  });
});

describe('WP5: payload /api/client/referral — tgLinked + botUsername', () => {
  it('tgLinked отражает tg_chat_id; botUsername из kv-кэша', async () => {
    const { login, token } = await registerClient('payload@wp5-test.local');
    const before = await request(app).get('/api/client/referral').set('X-Auth-Token', token);
    expect(before.status).toBe(200);
    expect(before.body.tgLinked).toBe(false);
    expect(before.body.botUsername).toBe('wp5_test_bot');

    syncTgChatId(login, '555002');
    const after = await request(app).get('/api/client/referral').set('X-Auth-Token', token);
    expect(after.body.tgLinked).toBe(true);
  });
});

describe('WP5: настройки (PUT /api/admin/settings)', () => {
  it('telegram_admin_ids: валидация CSV числовых id', async () => {
    const bad = await request(app)
      .put('/api/admin/settings')
      .set('X-Auth-Token', adminToken)
      .send({ telegram_admin_ids: 'abc,123' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .put('/api/admin/settings')
      .set('X-Auth-Token', adminToken)
      .send({ telegram_admin_ids: '111, 222' });
    expect(ok.status).toBe(200);
    expect(stateMod.state.appSettings.telegram_admin_ids).toBe('111,222');
  });

  it('пороги алертов розницы сохраняются с границами', async () => {
    const res = await request(app)
      .put('/api/admin/settings')
      .set('X-Auth-Token', adminToken)
      .send({ retail_bulk_buy_threshold: 5, retail_pool_min_free: 2 });
    expect(res.status).toBe(200);
    expect(stateMod.state.appSettings.retail_bulk_buy_threshold).toBe(5);
    expect(stateMod.state.appSettings.retail_pool_min_free).toBe(2);
  });

  it('telegram_bot_token — enc1: в kv, маска в GET, маска не затирает значение', async () => {
    const TOKEN = 'stage3:token-' + Date.now();
    const put = await request(app)
      .put('/api/admin/settings')
      .set('X-Auth-Token', adminToken)
      .send({ telegram_bot_token: TOKEN });
    expect(put.status).toBe(200);

    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
    expect(row.value).not.toContain(TOKEN);
    expect(JSON.parse(row.value).telegram_bot_token).toMatch(/^enc1:/);

    const get = await request(app).get('/api/admin/settings').set('X-Auth-Token', adminToken);
    expect(get.body.telegram_bot_token).toBe('••••••••');

    // Сохранение формы с маской не затирает токен
    const beforeKv = row.value;
    const putMask = await request(app)
      .put('/api/admin/settings')
      .set('X-Auth-Token', adminToken)
      .send({ telegram_bot_token: '••••••••' });
    expect(putMask.status).toBe(200);
    const afterKv = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get().value;
    expect(afterKv).toBe(beforeKv);
  });
});

describe('WP5: notifyClient при зачислении (ручной платёж админа)', () => {
  it('POST /api/admin/clients/:id/payment → след balance_credited в system_log', async () => {
    const { login } = await registerClient('credit@wp5-test.local');
    const clientId = db.prepare('SELECT id FROM clients WHERE login = ?').get(login).id;
    db.prepare("DELETE FROM system_log WHERE action = 'balance_credited' AND target = ?").run(login);

    const res = await request(app)
      .post(`/api/admin/clients/${clientId}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 250, date: '2026-08-14', note: 'wp5 test' });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(250);

    // notifyClient: TG не привязан → только logActivity (след в system_log).
    const row = db.prepare("SELECT * FROM system_log WHERE action = 'balance_credited' AND target = ? ORDER BY id DESC LIMIT 1").get(login);
    expect(row).toBeTruthy();
    expect(row.message).toContain('Зачислено 250 ₽');
    expect(row.message).toContain('Баланс: 250 ₽');
  });
});
