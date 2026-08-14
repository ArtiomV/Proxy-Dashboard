// B2C Этап 1 (ТЗ 10.08): регистрация, verify/reset пароля, change_password,
// tariffs CRUD, buy_proxy с тестовым кредитом.
// Фича-флаг retail_enabled включается в beforeAll и выключается после —
// соседние сьюты не должны видеть розничные роуты включёнными.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, asAdmin, asClient } from '../_helpers/app.js';
import request from 'supertest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db, adminToken;

function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  if (on) settings.retail_pool_servers = 'S1';
  // WP7 (Э5): лимит аккаунтов на reg_ip — в сьюте регистраций много с одного
  // тестового IP, поднимаем (сам лимит проверяется в retail-stage5.test.js).
  if (on) settings.retail_max_accounts_per_ip = 1000;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  // in-memory appSettings — стабильная идентичность объекта (state-stable-identity):
  // мутация полей видна всем роутерам, захватившим ссылку при монтировании
  stateMod.state.appSettings.retail_enabled = on;
  if (on) stateMod.state.appSettings.retail_pool_servers = 'S1';
  if (on) stateMod.state.appSettings.retail_max_accounts_per_ip = 1000;
}

function cleanup() {
  db.prepare("DELETE FROM clients WHERE login LIKE 'u_%' OR email LIKE '%@b2c-test.local'").run();
  db.prepare("DELETE FROM auth_tokens").run();
  db.prepare("DELETE FROM retail_pool").run();
  db.prepare("DELETE FROM tariffs WHERE geo = 'TST'").run();
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
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
  cleanup();
});

describe('B2C Э1: регистрация (WP1)', () => {
  it('register: email+пароль → аккаунт individual/allow_debt=0/price=0 + verify-токен в mail_outbox', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'First@B2C-Test.local', password: 'password123', consent: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.login).toMatch(/^u_/);
    expect(res.body.token).toBeTruthy();

    const row = db.prepare('SELECT * FROM clients WHERE login = ?').get(res.body.login);
    expect(row.client_type).toBe('individual');
    expect(row.allow_debt).toBe(0);
    expect(row.price).toBe(0);
    expect(row.port_name).toBe(row.login);
    expect(row.email).toBe('first@b2c-test.local'); // нормализация в lower-case
    expect(row.email_verified).toBe(0);
    expect(row.consent_pd_at).toBeTruthy();

    // verify-письмо в очереди (SendPulse не настроен → mail_outbox)
    const outbox = JSON.parse(db.prepare('SELECT value FROM kv_store WHERE key = ?').get('mail_outbox').value);
    const verifyMail = outbox.find(m => m.kind === 'verify_email' && m.to === 'first@b2c-test.local');
    expect(verifyMail).toBeTruthy();
    expect(verifyMail.text).toContain('/verify?token=');
  });

  it('register: дубль email → 409', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'first@b2c-test.local', password: 'password123', consent: true });
    expect(res.status).toBe(409);
  });

  it('register: без consent → 400 (zod literal true)', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'noconsent@b2c-test.local', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('register: honeypot «website» заполнен → молчаливый ok без создания', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'bot@b2c-test.local', password: 'password123', consent: true, website: 'http://spam' });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT * FROM clients WHERE email = ?').get('bot@b2c-test.local');
    expect(row).toBeUndefined();
  });

  it('login по email: логин с @ → lookup email→login', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ login: 'FIRST@b2c-test.local', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.login).toMatch(/^u_/);
  });
});

describe('B2C Э1: verify_email + смена/сброс пароля (WP1)', () => {
  let login, sessionToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'verify@b2c-test.local', password: 'password123', consent: true });
    login = res.body.login;
    sessionToken = res.body.token;
  });

  it('buy_proxy до верификации email → 403 EMAIL_NOT_VERIFIED', async () => {
    const res = await request(app)
      .post('/api/client/buy_proxy')
      .set('X-Auth-Token', sessionToken)
      .send({ tariff_id: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verify_email: токен из письма подтверждает адрес (одноразовый)', async () => {
    const row = db.prepare("SELECT * FROM auth_tokens WHERE login = ? AND type = 'verify_email'").get(login);
    expect(row).toBeTruthy();
    // Токен в БД — sha256; plaintext только в mail_outbox
    const outbox = JSON.parse(db.prepare('SELECT value FROM kv_store WHERE key = ?').get('mail_outbox').value);
    const mail = outbox.find(m => m.kind === 'verify_email' && m.to === 'verify@b2c-test.local');
    const plain = mail.text.match(/token=([a-f0-9]+)/)[1];

    const res = await request(app).post('/api/verify_email').send({ token: plain });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT email_verified FROM clients WHERE login = ?').get(login).email_verified).toBe(1);

    // повторно токен не работает
    const again = await request(app).post('/api/verify_email').send({ token: plain });
    expect(again.status).toBe(400);
  });

  it('change_password: старый → новый, сессии убиты', async () => {
    const res = await request(app)
      .post('/api/client/change_password')
      .set('X-Auth-Token', sessionToken)
      .send({ old: 'password123', new: 'newpassword456' });
    expect(res.status).toBe(200);
    expect(res.body.relogin).toBe(true);

    // старая сессия мертва
    const me = await request(app)
      .post('/api/client/change_password')
      .set('X-Auth-Token', sessionToken)
      .send({ old: 'newpassword456', new: 'x'.repeat(10) });
    expect(me.status).toBe(401);

    // новый пароль работает
    const relogin = await request(app)
      .post('/api/login')
      .send({ login: 'verify@b2c-test.local', password: 'newpassword456' });
    expect(relogin.status).toBe(200);
  });

  it('forgot/reset: токен 1ч одноразовый → новый пароль, сессии убиты', async () => {
    const forgot = await request(app)
      .post('/api/forgot_password')
      .send({ email: 'verify@b2c-test.local' });
    expect(forgot.status).toBe(200);

    const outbox = JSON.parse(db.prepare('SELECT value FROM kv_store WHERE key = ?').get('mail_outbox').value);
    const mail = outbox.filter(m => m.kind === 'reset_password' && m.to === 'verify@b2c-test.local').pop();
    expect(mail).toBeTruthy();
    const plain = mail.text.match(/token=([a-f0-9]+)/)[1];

    const reset = await request(app)
      .post('/api/reset_password')
      .send({ token: plain, password: 'resetpass789' });
    expect(reset.status).toBe(200);

    const relogin = await request(app)
      .post('/api/login')
      .send({ login: 'verify@b2c-test.local', password: 'resetpass789' });
    expect(relogin.status).toBe(200);

    // токен одноразовый
    const again = await request(app)
      .post('/api/reset_password')
      .send({ token: plain, password: 'another000' });
    expect(again.status).toBe(400);
  });
});

describe('B2C Э1: tariffs CRUD (Р36)', () => {
  let tariffId;

  it('admin создаёт тариф → виден на витрине public=1', async () => {
    const res = await request(app)
      .post('/api/admin/tariffs')
      .set('X-Auth-Token', adminToken)
      .send({ name: 'Тест РФ', type: 'per_modem', geo: 'TST', server: 'S1', price: 3000, public: true });
    expect(res.status).toBe(200);
    tariffId = res.body.tariff.id;
    expect(res.body.tariff.price_day).toBeCloseTo(3000 / 30.4, 1);

    const showcase = await request(app)
      .get('/api/client/tariffs')
      .set('X-Auth-Token', asClient('u_showcase'));
    expect(showcase.status).toBe(200);
    const t = showcase.body.tariffs.find(x => x.id === tariffId);
    expect(t).toBeTruthy();
    expect(t.name).toBe('Тест РФ');
  });

  it('клиент не видит админский CRUD (403), не-active тариф не на витрине', async () => {
    const clientToken = asClient('u_noaccess');
    const res = await request(app)
      .get('/api/admin/tariffs')
      .set('X-Auth-Token', clientToken);
    expect(res.status).toBe(403);

    await request(app)
      .post('/api/admin/tariffs')
      .set('X-Auth-Token', adminToken)
      .send({ name: 'Скрытый', type: 'per_modem', geo: 'TST', server: 'S1', price: 100, public: true, active: false });
    const showcase = await request(app)
      .get('/api/client/tariffs')
      .set('X-Auth-Token', clientToken);
    expect(showcase.body.tariffs.find(x => x.name === 'Скрытый')).toBeUndefined();
  });

  it('PUT меняет цену (audit tariff_price_changed), DELETE привязанного → 409', async () => {
    const put = await request(app)
      .put(`/api/admin/tariffs/${tariffId}`)
      .set('X-Auth-Token', adminToken)
      .send({ price: 3500 });
    expect(put.status).toBe(200);
    expect(put.body.tariff.price).toBe(3500);

    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'tariff_price_changed' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toBeTruthy();

    // привязываем клиента → delete запрещён
    db.prepare("UPDATE clients SET tariff_id = ? WHERE email = 'verify@b2c-test.local'").run(tariffId);
    const del = await request(app)
      .delete(`/api/admin/tariffs/${tariffId}`)
      .set('X-Auth-Token', adminToken);
    expect(del.status).toBe(409);
    db.prepare("UPDATE clients SET tariff_id = NULL WHERE email = 'verify@b2c-test.local'").run();
  });
});

describe('B2C Э1: buy_proxy (WP2, тестовый кредит)', () => {
  let sessionToken, login, tariffId;

  beforeAll(async () => {
    // тариф для покупки
    const t = await request(app)
      .post('/api/admin/tariffs')
      .set('X-Auth-Token', adminToken)
      .send({ name: 'Покупочный', type: 'per_modem', geo: 'TST', server: 'S1', price: 3000, public: true });
    tariffId = t.body.tariff.id;

    // verified клиент с балансом (тестовый кредит от админа)
    const reg = await request(app)
      .post('/api/register')
      .send({ email: 'buyer@b2c-test.local', password: 'password123', consent: true });
    login = reg.body.login;
    sessionToken = reg.body.token;
    db.prepare('UPDATE clients SET email_verified = 1, balance = 500 WHERE login = ?').run(login);
    // in-memory синхронизация
    const { state } = stateMod;
    const c = state.clients.find(x => x.login === login);
    if (c) { c.emailVerified = true; c.balance = 500; }

    // свободный порт в пуле
    db.prepare("INSERT INTO retail_pool (server, port_id, status) VALUES ('S1', 'portTEST01', 'free')").run();
  });

  it('витрина /api/client/tariffs доступна клиенту ЛК', async () => {
    const res = await request(app)
      .get('/api/client/tariffs')
      .set('X-Auth-Token', sessionToken);
    expect(res.status).toBe(200);
    expect(res.body.tariffs.some(t => t.id === tariffId)).toBe(true);
  });

  it('недостаточно средств → 402 с required', async () => {
    const poor = await request(app)
      .post('/api/register')
      .send({ email: 'poor@b2c-test.local', password: 'password123', consent: true });
    db.prepare('UPDATE clients SET email_verified = 1, balance = 10 WHERE login = ?').run(poor.body.login);
    const { state } = stateMod;
    const c = state.clients.find(x => x.login === poor.body.login);
    if (c) { c.emailVerified = true; c.balance = 10; }

    const res = await request(app)
      .post('/api/client/buy_proxy')
      .set('X-Auth-Token', poor.body.token)
      .send({ tariff_id: tariffId });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.required).toBeGreaterThan(0);
  });

  it('пустой пул → 409 POOL_EMPTY (бокс S1 недоступен в тесте — до провижининга не доходит)', async () => {
    // забираем единственный free-порт «из-под» клиента
    db.prepare("UPDATE retail_pool SET status = 'leased' WHERE port_id = 'portTEST01'").run();
    const res = await request(app)
      .post('/api/client/buy_proxy')
      .set('X-Auth-Token', sessionToken)
      .send({ tariff_id: tariffId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('POOL_EMPTY');
  });

  it('резерв порта атомарен: занятый порт не выдаётся дважды', async () => {
    db.prepare("INSERT INTO retail_pool (server, port_id, status) VALUES ('S1', 'portRACE1', 'free')").run();
    const retailPoolDb = require('../../src/db/retail-pool.js');
    const row = retailPoolDb.nextFree('S1');
    const until = new Date(Date.now() + 60000).toISOString();
    expect(retailPoolDb.reserve(row.id, 'client_a', until)).toBe(true);
    // повторный резерв того же порта → false (changes=0)
    expect(retailPoolDb.reserve(row.id, 'client_b', until)).toBe(false);
    expect(retailPoolDb.byId(row.id).client_id).toBe('client_a');
  });

  it('тест-день: повторная покупка → 403 TEST_USED', async () => {
    const testT = await request(app)
      .post('/api/admin/tariffs')
      .set('X-Auth-Token', adminToken)
      .send({ name: 'Тест-день', type: 'per_modem', geo: 'TST', server: 'S1', price: 100, public: true, duration_hours: 24 });
    db.prepare('UPDATE clients SET test_used = 1 WHERE login = ?').run(login);
    const { state } = stateMod;
    const c = state.clients.find(x => x.login === login);
    if (c) c.testUsed = true;

    const res = await request(app)
      .post('/api/client/buy_proxy')
      .set('X-Auth-Token', sessionToken)
      .send({ tariff_id: testT.body.tariff.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEST_USED');
  });
});

describe('B2C Э1: фича-флаг', () => {
  it('retail_enabled=false → register/tariffs/buy 404', async () => {
    setRetail(false);
    const reg = await request(app)
      .post('/api/register')
      .send({ email: 'off@b2c-test.local', password: 'password123', consent: true });
    expect(reg.status).toBe(404);

    const showcase = await request(app)
      .get('/api/client/tariffs')
      .set('X-Auth-Token', asClient('u_off'));
    expect(showcase.status).toBe(404);

    const buy = await request(app)
      .post('/api/client/buy_proxy')
      .set('X-Auth-Token', asClient('u_off'))
      .send({ tariff_id: 1 });
    expect(buy.status).toBe(404);
    setRetail(true);
  });
});
