// v2.10.7: мелочи B2C auth — API-часть.
//   - POST /api/auth/resend_verification: auth-only, 400 «нет email» /
//     «уже подтверждён», ok → письмо (в тесте — mail_outbox), кулдаун 429;
//   - GET  /api/auth/session_token: raw-токен сессии для посадочной /tg-auth;
//   - GET  /api/auth/telegram_oidc_start: 404 при выкл рознице, 503 без
//     client_id, 302 на oauth.telegram.org с state/nonce при настроенном;
//   - tg_username (миграция 065): TG-регистрация сохраняет username,
//     /api/client/referral его отдаёт, tg_unlink очищает.
// Харнес общий (tests/_helpers/app.js); свои строки чистим.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db;

function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
}

function cleanup() {
  db.prepare("DELETE FROM clients WHERE login LIKE 'u_%' OR email LIKE '%@am-test.local'").run();
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
  db.prepare("DELETE FROM kv_store WHERE key = 'mail_outbox'").run();
  const arr = stateMod.state.clients;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/^u_/.test(arr[i].login || '') || /@am-test\.local$/.test(arr[i].email || '')) arr.splice(i, 1);
  }
}

function tgPayload(id, botToken, extra) {
  const p = { id, first_name: 'AM', auth_date: Math.floor(Date.now() / 1000), ...(extra || {}) };
  const checkString = Object.keys(p).filter(k => p[k] !== undefined).sort().map(k => `${k}=${p[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  p.hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return p;
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  cleanup();
  setRetail(true);
  stateMod.state.appSettings.retail_max_accounts_per_ip = 0; // лимит IP не мешает
});

afterAll(() => {
  setRetail(false);
  stateMod.state.appSettings.telegram_bot_token = '';
  stateMod.state.appSettings.telegram_oidc_client_id = '';
  stateMod.state.appSettings.retail_max_accounts_per_ip = 2;
  cleanup();
});

describe('resend_verification', () => {
  it('без auth → 401; без email → 400; ok → письмо в mail_outbox; повтор → 429; verified → 400', async () => {
    expect((await request(app).post('/api/auth/resend_verification')).status).toBe(401);

    // TG-аккаунт без email
    const BOT = 'am_test_bot_token';
    stateMod.state.appSettings.telegram_bot_token = BOT;
    const tg = await request(app).post('/api/auth/telegram').send(tgPayload(770001, BOT));
    expect(tg.status).toBe(200);
    const noMail = await request(app).post('/api/auth/resend_verification')
      .set('X-Auth-Token', tg.body.token);
    expect(noMail.status).toBe(400);

    // email-аккаунт
    const reg = await request(app).post('/api/register')
      .send({ email: 'resend@am-test.local', password: 'password123', consent: true });
    expect(reg.status).toBe(200);
    const ok = await request(app).post('/api/auth/resend_verification')
      .set('X-Auth-Token', reg.body.token);
    expect(ok.status).toBe(200);
    const outbox = JSON.parse(db.prepare("SELECT value FROM kv_store WHERE key = 'mail_outbox'").get().value);
    expect(outbox.some(m => m.kind === 'verify_email' && m.to === 'resend@am-test.local')).toBe(true);

    // кулдаун
    const again = await request(app).post('/api/auth/resend_verification')
      .set('X-Auth-Token', reg.body.token);
    expect(again.status).toBe(429);

    // подтверждённый email
    const client = stateMod.state.clients.find(c => c.login === reg.body.login);
    client.emailVerified = true;
    const verified = await request(app).post('/api/auth/resend_verification')
      .set('X-Auth-Token', reg.body.token);
    expect(verified.status).toBe(400);
  });
});

describe('session_token', () => {
  it('без auth → 401; с токеном → тот же token + login', async () => {
    expect((await request(app).get('/api/auth/session_token')).status).toBe(401);
    const reg = await request(app).post('/api/register')
      .send({ email: 'sess@am-test.local', password: 'password123', consent: true });
    const res = await request(app).get('/api/auth/session_token')
      .set('X-Auth-Token', reg.body.token);
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(reg.body.token);
    expect(res.body.login).toBe(reg.body.login);
  });
});

describe('telegram_oidc_start', () => {
  it('розница выкл → 404; нет client_id → 503; задан → 302 с state/nonce', async () => {
    setRetail(false);
    expect((await request(app).get('/api/auth/telegram_oidc_start')).status).toBe(404);
    setRetail(true);

    stateMod.state.appSettings.telegram_oidc_client_id = '';
    delete process.env.TELEGRAM_OIDC_CLIENT_ID;
    expect((await request(app).get('/api/auth/telegram_oidc_start')).status).toBe(503);

    stateMod.state.appSettings.telegram_oidc_client_id = '8934167617';
    const res = await request(app).get('/api/auth/telegram_oidc_start');
    expect(res.status).toBe(302);
    const loc = res.headers.location;
    expect(loc).toContain('https://oauth.telegram.org/auth?');
    expect(loc).toContain('client_id=8934167617');
    expect(loc).toContain('response_type=code');
    expect(loc).toMatch(/state=[0-9a-f]{32}/);
    expect(loc).toMatch(/nonce=[0-9a-f]{32}/);
    expect(loc).toContain('redirect_uri=');
  });

  it('callback с неизвестным state → редирект на /tg-auth?error=', async () => {
    stateMod.state.appSettings.telegram_oidc_client_id = '8934167617';
    const res = await request(app).get('/api/auth/telegram_oidc?state=deadbeef&code=x');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/tg-auth\?error=/);
  });
});

describe('tg_username (миграция 065)', () => {
  it('TG-регистрация сохраняет username → referral отдаёт → unlink очищает', async () => {
    const BOT = 'am_test_bot_token';
    stateMod.state.appSettings.telegram_bot_token = BOT;
    const tg = await request(app).post('/api/auth/telegram')
      .send(tgPayload(770002, BOT, { username: 'am_tester' }));
    expect(tg.status).toBe(200);

    const ref = await request(app).get('/api/client/referral')
      .set('X-Auth-Token', tg.body.token);
    expect(ref.status).toBe(200);
    expect(ref.body.tgLinked).toBe(true);
    expect(ref.body.tgUsername).toBe('am_tester');

    const un = await request(app).post('/api/client/tg_unlink')
      .set('X-Auth-Token', tg.body.token);
    expect(un.status).toBe(200);
    const client = stateMod.state.clients.find(c => c.login === tg.body.login);
    expect(client.tgChatId).toBeFalsy();
    expect(client.tgUsername).toBeFalsy();
    const row = db.prepare('SELECT tg_chat_id, tg_username FROM clients WHERE login = ?').get(tg.body.login);
    expect(row.tg_chat_id).toBeNull();
    expect(row.tg_username).toBeNull();
  });
});
