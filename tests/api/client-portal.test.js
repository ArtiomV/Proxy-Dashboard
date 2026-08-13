// Characterization tests for the client-facing portal routes:
//   GET /api/dashboard_data    — main client dashboard payload
//   GET /api/billing_history   — ledger entries + summary
//
// In the test environment fetchAllServersDataCached returns an empty array
// (no API_*_URL set), so the proxy-data branches return empty maps. We
// validate the shape + auth requirements rather than the data values.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';
const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');

let app, db, adminToken, clientLogin, clientToken;
const PASSWORD = 'portal_pass_' + crypto.randomBytes(4).toString('hex');

// Тот же паттерн, что в retail-stage1.test.js: флаг живёт и в kv_store, и в
// in-memory appSettings (стабильная идентичность объекта).
function setRetail(on) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings.retail_enabled = on;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings.retail_enabled = on;
}

beforeAll(async () => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  clientLogin = 'portal_' + crypto.randomBytes(3).toString('hex');
  // Create client through the admin route so users{} is populated.
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'Portal Test', login: clientLogin, password: PASSWORD,
    portName: 'portal_p_' + crypto.randomBytes(2).toString('hex'),
    billingType: 'per_gb', price: 10, currency: 'RUB',
  });
  if (create.status !== 200) throw new Error('seed failed: ' + create.status);
  // Login as the client to get a real session
  const login = await request(app).post('/api/login').send({ login: clientLogin, password: PASSWORD });
  if (login.status !== 200) throw new Error('client login failed: ' + login.status);
  clientToken = login.body.token;
});

afterAll(() => {
  try { db.prepare('DELETE FROM clients WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
  try { db.prepare('DELETE FROM sessions WHERE login = ?').run(clientLogin); } catch (_) { /* best-effort */ }
});

describe('GET /api/dashboard_data', () => {
  it('200 + shape with auth (empty data is acceptable, schema is the contract)', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    // The route always returns these top-level keys regardless of whether
    // any modem data is loaded. Asserting their presence locks the shape.
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('ports');
    expect(res.body).toHaveProperty('bandwidth');
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/dashboard_data');
    expect(res.status).toBe(401);
  });

  it('401 with bogus token', async () => {
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', 'bogus-token');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dashboard_data — retail (B2C Э2)', () => {
  // Поле retail появляется только при retail_enabled: balanceNegativeSince +
  // порты пула клиента (status/holdUntil/testExpiresAt) для баннера конвейера.
  it('no retail field when retail_enabled is off', async () => {
    setRetail(false);
    const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('retail');
  });

  it('retail field with pool ports when retail_enabled is on', async () => {
    setRetail(true);
    const clientRow = db.prepare('SELECT id FROM clients WHERE login = ?').get(clientLogin);
    const portId = 'ptest_' + crypto.randomBytes(3).toString('hex');
    db.prepare(
      "INSERT INTO retail_pool (server, port_id, status, client_id, hold_until, test_expires_at, updated_at) " +
      "VALUES ('S1', ?, 'blocked', ?, '2030-01-01T00:00:00.000Z', NULL, datetime('now'))"
    ).run(portId, String(clientRow.id));
    try {
      const res = await request(app).get('/api/dashboard_data').set('X-Auth-Token', clientToken);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('retail');
      expect(res.body.retail).toHaveProperty('balanceNegativeSince');
      expect(typeof res.body.retail.graceHours).toBe('number');
      const p = (res.body.retail.ports || []).find(x => x.portId === portId);
      expect(p).toBeDefined();
      expect(p.server).toBe('S1');
      expect(p.status).toBe('blocked');
      expect(p.holdUntil).toBe('2030-01-01T00:00:00.000Z');
      expect(p.testExpiresAt).toBeNull();
    } finally {
      db.prepare('DELETE FROM retail_pool WHERE server = ? AND port_id = ?').run('S1', portId);
      setRetail(false);
    }
  });
});

describe('GET /api/billing_history', () => {
  it('200 + summary structure for newly-created client (no entries yet)', async () => {
    const res = await request(app).get('/api/billing_history').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBe(0);
    // Shape: { balance, currency, summary: {…}, entries: [] }
    expect(res.body).toHaveProperty('balance');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalCharges');
    expect(res.body.summary).toHaveProperty('totalPayments');
    expect(typeof res.body.summary.totalCharges).toBe('number');
    expect(typeof res.body.summary.totalPayments).toBe('number');
  });

  it('reflects an admin-recorded payment in summary + entries', async () => {
    // Admin records a payment for this client. NB: due to the stale
    // billingLedger / clientById ref bug (see FOLLOWUP.md), the in-memory
    // billingLedger map IS updated by atomicCredit even though
    // client.balance isn't — so the ledger surface here works correctly.
    const clientRow = db.prepare('SELECT id FROM clients WHERE login = ?').get(clientLogin);
    const pay = await request(app)
      .post(`/api/admin/clients/${clientRow.id}/payment`)
      .set('X-Auth-Token', adminToken)
      .send({ amount: 250, date: '2026-05-15', note: 'portal-test' });
    expect(pay.status).toBe(200);

    const res = await request(app).get('/api/billing_history').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalPayments).toBeGreaterThanOrEqual(250);
    const hit = (res.body.entries || []).find(e => e.type === 'payment' && Number(e.amount) === 250);
    expect(hit).toBeDefined();
  });

  it('honors ?month=YYYY-MM filter', async () => {
    const res = await request(app).get('/api/billing_history?month=2099-01').set('X-Auth-Token', clientToken);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(0);   // nothing in year 2099
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/billing_history');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/client/email', () => {
  // Розница нужна только для verify-письма (verificationSent); сам роут
  // доступен при любом флаге. Включаем/выключаем локально, как retail-stage1.
  let client2Login, client2Token;
  const EMAIL1 = 'Portal_Email1@portal-test.local'; // регистр — специально, ждём lowercase
  const EMAIL1_NORM = EMAIL1.toLowerCase();
  const EMAIL2 = 'portal_email2@portal-test.local';
  const EMAIL3 = 'portal_email3@portal-test.local';

  beforeAll(async () => {
    setRetail(true);
    client2Login = 'portal2_' + crypto.randomBytes(3).toString('hex');
    const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
      name: 'Portal Test 2', login: client2Login, password: PASSWORD,
      portName: 'portal2_p_' + crypto.randomBytes(2).toString('hex'),
      billingType: 'per_gb', price: 10, currency: 'RUB',
    });
    if (create.status !== 200) throw new Error('seed client2 failed: ' + create.status);
    const login = await request(app).post('/api/login').send({ login: client2Login, password: PASSWORD });
    if (login.status !== 200) throw new Error('client2 login failed: ' + login.status);
    client2Token = login.body.token;
  });

  afterAll(() => {
    setRetail(false);
    try { db.prepare('DELETE FROM clients WHERE login = ?').run(client2Login); } catch (_) { /* best-effort */ }
    try { db.prepare('DELETE FROM sessions WHERE login = ?').run(client2Login); } catch (_) { /* best-effort */ }
    try { db.prepare('DELETE FROM auth_tokens WHERE login IN (?, ?)').run(clientLogin, client2Login); } catch (_) { /* best-effort */ }
  });

  it('401 without auth', async () => {
    const res = await request(app).post('/api/client/email').send({ email: EMAIL1_NORM });
    expect(res.status).toBe(401);
  });

  it('400 on invalid email (zod)', async () => {
    const res = await request(app).post('/api/client/email').set('X-Auth-Token', clientToken)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
  });

  it('sets email: 200, lowercase-нормализация, verify-письмо при retail_enabled', async () => {
    const res = await request(app).post('/api/client/email').set('X-Auth-Token', clientToken)
      .send({ email: EMAIL1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe(EMAIL1_NORM);
    expect(res.body.verificationSent).toBe(true);

    // Профиль (referral endpoint) отражает email + сброшенную верификацию
    const ref = await request(app).get('/api/client/referral').set('X-Auth-Token', clientToken);
    expect(ref.body.email).toBe(EMAIL1_NORM);
    expect(ref.body.emailVerified).toBe(false);

    // Письмо ушло в очередь (без SendPulse-кредов — mail_outbox)
    const outbox = JSON.parse(db.prepare('SELECT value FROM kv_store WHERE key = ?').get('mail_outbox').value);
    const mail = outbox.filter(m => m.kind === 'verify_email' && m.to === EMAIL1_NORM).pop();
    expect(mail).toBeTruthy();
    expect(mail.text).toContain('/verify?token=');

    // Полный цикл: подтверждаем email токеном из письма
    const token = mail.text.match(/\/verify\?token=([0-9a-f]+)/)[1];
    const ver = await request(app).post('/api/verify_email').send({ token });
    expect(ver.status).toBe(200);
    const ref2 = await request(app).get('/api/client/referral').set('X-Auth-Token', clientToken);
    expect(ref2.body.emailVerified).toBe(true);
  });

  it('смена email сбрасывает emailVerified', async () => {
    const res = await request(app).post('/api/client/email').set('X-Auth-Token', clientToken)
      .send({ email: EMAIL2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ref = await request(app).get('/api/client/referral').set('X-Auth-Token', clientToken);
    expect(ref.body.email).toBe(EMAIL2);
    expect(ref.body.emailVerified).toBe(false); // был true после verify выше
  });

  it('409 на дубль email другого клиента', async () => {
    const set2 = await request(app).post('/api/client/email').set('X-Auth-Token', client2Token)
      .send({ email: EMAIL3 });
    expect(set2.status).toBe(200);

    const dupe = await request(app).post('/api/client/email').set('X-Auth-Token', clientToken)
      .send({ email: EMAIL3.toUpperCase() }); // регистр не должен обходить проверку
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe('Аккаунт с этим email уже существует');

    // Себе самому тот же email — не дубль
    const self = await request(app).post('/api/client/email').set('X-Auth-Token', client2Token)
      .send({ email: EMAIL3 });
    expect(self.status).toBe(200);
  });
});
