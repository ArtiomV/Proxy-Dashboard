// B2C Этап 4 (WP3): эквайринг розницы — карта/СБП через Точку.
//   - POST /api/client/topup: гейты (retail_enabled, email_verified, провайдер),
//     min/max, создание платежа + строка card_payments;
//   - POST /api/payments/webhook/tochka: strict-подпись (401), зачёт ТОЛЬКО по
//     webhook, идемпотентность дублей, рефкомиссия 10% в той же транзакции,
//     сверка суммы;
//   - POST /api/admin/card_payments/:orderId/refund: refund провайдера →
//     payment_reversal + откат рефкомиссии; падение провайдера → 502 без сторно;
//   - GET /api/admin/card_payments: список только админу;
//   - юнит-тесты src/payments/provider.js + tochka-acquiring.js (маппинг полей
//     по OpenAPI v1.93.0-stable) — с поддельными deps, без сети.
// Боевых кредов нет — провайдер подменён моком через require-кэш
// (server.js создаёт провайдера на каждый запрос: require(...).create(...)).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');
const providerMod = require('../../src/payments/provider.js');
const tochkaAcq = require('../../src/payments/tochka-acquiring.js');

const origCreate = providerMod.create;

let app, db, adminToken;
const createdLogins = [];

// ── Мок провайдера: «сырьё» webhook — JSON-строка, «подпись» — заголовок
// X-Test-Sig: valid (иначе мок отвечает ok:false, как strict-verify Точки).
const mockState = { nullProvider: false, failRefund: false };
const mockProvider = {
  name: 'mock',
  async create_payment(p) {
    return { confirmation_url: 'https://pay.test/' + p.order_id, provider_payment_id: 'op_' + p.order_id };
  },
  async verify_webhook(headers, rawBody) {
    if (headers['x-test-sig'] !== 'valid') return { ok: false, reason: 'bad_sig' };
    let payload;
    try { payload = JSON.parse(String(rawBody)); } catch { return { ok: false, reason: 'bad_body' }; }
    return {
      ok: true,
      order_id: payload.order_id || null,
      status: payload.status || 'paid',
      provider_payment_id: payload.operation_id || null,
      method: payload.method || 'card',
      amount: payload.amount != null ? payload.amount : null,
      raw: payload,
    };
  },
  async refund(providerPaymentId, amount) {
    if (mockState.failRefund) throw new Error('provider down');
    return { ok: true, providerPaymentId, amount };
  },
};

function setSetting(key, value) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings[key] = value;
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))')
    .run('app_settings', JSON.stringify(settings));
  stateMod.state.appSettings[key] = value;
}

function syncClient(login, patch) {
  const c = stateMod.state.clients.find(x => x.login === login);
  if (c) Object.assign(c, patch);
  return c;
}

async function register(email) {
  const res = await request(app).post('/api/register')
    .send({ email, password: 'password123', consent: true });
  expect(res.status).toBe(200);
  createdLogins.push(res.body.login);
  return res.body;   // { token, login, client }
}

async function registerVerified(email) {
  const { login, token } = await register(email);
  db.prepare('UPDATE clients SET email_verified = 1 WHERE login = ?').run(login);
  const client = syncClient(login, { emailVerified: true });
  return { login, token, client };
}

function topup(token, body) {
  return request(app).post('/api/client/topup').set('X-Auth-Token', token).send(body);
}

function webhook(payload, sig = 'valid') {
  const r = request(app).post('/api/payments/webhook/tochka').set('Content-Type', 'text/plain');
  if (sig) r.set('X-Test-Sig', sig);
  return r.send(JSON.stringify(payload));
}

function ledgerOf(clientId) {
  return db.prepare('SELECT * FROM billing_ledger WHERE client_id = ? ORDER BY id').all(clientId);
}

function cleanup() {
  const emails = db.prepare("SELECT id, login FROM clients WHERE email LIKE '%@wp3-test.local'").all();
  const ids = emails.map(c => c.id);
  for (const id of ids) {
    db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM card_payments WHERE client_id = ?').run(id);
  }
  db.prepare("DELETE FROM clients WHERE email LIKE '%@wp3-test.local'").run();
  db.prepare("DELETE FROM sessions WHERE login LIKE 'u_%'").run();
  const arr = stateMod.state.clients;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/@wp3-test\.local$/.test(arr[i].email || '')) arr.splice(i, 1);
  }
}

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  cleanup();
  setSetting('retail_enabled', true);
  setSetting('retail_acquiring_provider', 'tochka');
  setSetting('retail_min_topup', 0);
  setSetting('retail_max_topup', 100000);
  // WP7-лимит мультиаккаунтов с reg_ip мешает массовой регистрации в тестах.
  setSetting('retail_max_accounts_per_ip', 1000);
  // Суточный лимит регистраций с IP (429 в registration.js:135) — тоже поднимаем.
  setSetting('retail_reg_limit_per_ip_day', 1000);
  providerMod.create = () => (mockState.nullProvider ? null : mockProvider);
});

afterAll(() => {
  providerMod.create = origCreate;
  setSetting('retail_enabled', false);
  setSetting('retail_acquiring_provider', '');
  setSetting('retail_min_topup', 0);
  setSetting('retail_max_topup', 100000);
  setSetting('retail_max_accounts_per_ip', 2);   // дефолт ТЗ, как в retail-stage5
  setSetting('retail_reg_limit_per_ip_day', 10);
  cleanup();
});

describe('WP3: POST /api/client/topup — гейты и лимиты', () => {
  it('retail_enabled=false → 404', async () => {
    const { token } = await registerVerified('gate404@wp3-test.local');
    setSetting('retail_enabled', false);
    const res = await topup(token, { amount: 500, method: 'card' });
    expect(res.status).toBe(404);
    setSetting('retail_enabled', true);
  });

  it('email не подтверждён → 403 EMAIL_NOT_VERIFIED', async () => {
    const { token } = await register('noverify@wp3-test.local');
    const res = await topup(token, { amount: 500, method: 'card' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('провайдер не настроен → 503 ACQUIRING_NOT_CONFIGURED', async () => {
    const { token } = await registerVerified('noprov@wp3-test.local');
    mockState.nullProvider = true;
    const res = await topup(token, { amount: 500, method: 'card' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ACQUIRING_NOT_CONFIGURED');
    mockState.nullProvider = false;
  });

  it('min/max: retail_min_topup=500 → 100 ₽ отклонено, 500 ₽ принято; >max → 400', async () => {
    const { token } = await registerVerified('limits@wp3-test.local');
    setSetting('retail_min_topup', 500);

    const tooSmall = await topup(token, { amount: 100, method: 'card' });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.code).toBe('AMOUNT_TOO_SMALL');
    expect(tooSmall.body.min).toBe(500);

    const tooBig = await topup(token, { amount: 200000, method: 'card' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe('AMOUNT_TOO_LARGE');

    const ok = await topup(token, { amount: 500, method: 'sbp' });
    expect(ok.status).toBe(200);
    expect(ok.body.confirmation_url).toBe('https://pay.test/' + ok.body.order_id);

    const row = db.prepare('SELECT * FROM card_payments WHERE order_id = ?').get(ok.body.order_id);
    expect(row.status).toBe('created');
    expect(row.amount).toBe(500);
    expect(row.method).toBe('sbp');
    expect(row.provider_payment_id).toBe('op_' + ok.body.order_id);
    setSetting('retail_min_topup', 0);
  });

  it('невалидное тело → 400 (zod)', async () => {
    const { token } = await registerVerified('badbody@wp3-test.local');
    expect((await topup(token, { amount: -5, method: 'card' })).status).toBe(400);
    expect((await topup(token, { amount: 500, method: 'crypto' })).status).toBe(400);
  });
});

describe('WP3: webhook — зачёт только по подписанному webhook', () => {
  it('подделка подписи → 401, баланс не меняется', async () => {
    const { token, client } = await registerVerified('forged@wp3-test.local');
    const t = await topup(token, { amount: 700, method: 'card' });
    const res = await webhook({ order_id: t.body.order_id, status: 'paid', amount: 700 }, 'wrong');
    expect(res.status).toBe(401);
    expect(client.balance).toBe(0);
    expect(db.prepare('SELECT balance FROM clients WHERE id = ?').get(client.id).balance).toBe(0);
    // Строка не тронута — ждёт настоящий webhook.
    expect(db.prepare('SELECT status FROM card_payments WHERE order_id = ?').get(t.body.order_id).status).toBe('created');
  });

  it('валидный paid → зачёт: баланс +N, ledger card_payment, статус credited', async () => {
    const { token, client } = await registerVerified('credit@wp3-test.local');
    const t = await topup(token, { amount: 1000, method: 'card' });
    expect(t.status).toBe(200);
    // До webhook — ноль: зачёт ТОЛЬКО по webhook, не по return-url.
    expect(client.balance).toBe(0);

    const res = await webhook({
      order_id: t.body.order_id, status: 'paid',
      operation_id: 'op_' + t.body.order_id, amount: 1000, method: 'card',
    });
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(true);
    expect(client.balance).toBe(1000);
    expect(db.prepare('SELECT balance FROM clients WHERE id = ?').get(client.id).balance).toBe(1000);

    const entries = ledgerOf(client.id);
    const pay = entries.find(e => e.type === 'card_payment');
    expect(pay).toBeTruthy();
    expect(pay.amount).toBe(1000);
    expect(pay.payment_id).toBe(t.body.order_id);
    expect(pay.source).toBe('acquiring');

    const row = db.prepare('SELECT * FROM card_payments WHERE order_id = ?').get(t.body.order_id);
    expect(row.status).toBe('credited');
    expect(row.credited_at).toBeTruthy();
  });

  it('дубль webhook → 200 duplicate, баланс не меняется', async () => {
    const { token, client } = await registerVerified('dupe@wp3-test.local');
    const t = await topup(token, { amount: 300, method: 'sbp' });
    const payload = { order_id: t.body.order_id, status: 'paid', amount: 300, method: 'sbp' };
    expect((await webhook(payload)).body.credited).toBe(true);
    const again = await webhook(payload);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(client.balance).toBe(300);
    expect(ledgerOf(client.id).filter(e => e.type === 'card_payment').length).toBe(1);
  });

  it('расхождение суммы → processed:false, деньги НЕ зачислены', async () => {
    const { token, client } = await registerVerified('mismatch@wp3-test.local');
    const t = await topup(token, { amount: 500, method: 'card' });
    const res = await webhook({ order_id: t.body.order_id, status: 'paid', amount: 499 });
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.reason).toBe('amount_mismatch');
    expect(client.balance).toBe(0);
    expect(db.prepare('SELECT status FROM card_payments WHERE order_id = ?').get(t.body.order_id).status).toBe('created');
  });

  it('неизвестный order_id → 200 ignored (банк не ретраит)', async () => {
    const res = await webhook({ order_id: 'R-not-ours', status: 'paid', amount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unknown_order');
  });

  it('рефкомиссия 10% рефереру в той же транзакции', async () => {
    const referrer = await registerVerified('ref_parent@wp3-test.local');
    const referred = await registerVerified('ref_child@wp3-test.local');
    db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrer.client.id, referred.client.id);
    syncClient(referred.login, { referred_by: referrer.client.id });

    const t = await topup(referred.token, { amount: 1000, method: 'card' });
    expect((await webhook({ order_id: t.body.order_id, status: 'paid', amount: 1000 })).body.credited).toBe(true);

    expect(referred.client.balance).toBe(1000);
    expect(referrer.client.referral_balance).toBe(100);
    expect(db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(referrer.client.id).referral_balance).toBe(100);
  });
});

describe('WP3: возврат (POST /api/admin/card_payments/:orderId/refund)', () => {
  async function creditedPayment(email, amount) {
    const { token, client } = await registerVerified(email);
    const t = await topup(token, { amount, method: 'card' });
    await webhook({ order_id: t.body.order_id, status: 'paid', amount });
    return { client, orderId: t.body.order_id };
  }

  it('успех: payment_reversal + reversedLedgerId + откат рефкомиссии + статус refunded', async () => {
    const referrer = await registerVerified('rf_parent@wp3-test.local');
    const { client } = await creditedPayment('rf_child@wp3-test.local', 800);
    db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrer.client.id, client.id);
    // referred_by должен был стоять ДО зачёта для комиссии — поэтому отдельный
    // платёж с уже проставленной связкой:
    syncClient(client.login, { referred_by: referrer.client.id });
    const t2 = await topup(
      db.prepare('SELECT token FROM sessions WHERE login = ? LIMIT 1').get(client.login).token,
      { amount: 1000, method: 'card' });
    await webhook({ order_id: t2.body.order_id, status: 'paid', amount: 1000 });
    expect(client.balance).toBe(1800);
    expect(referrer.client.referral_balance).toBe(100);

    const res = await request(app)
      .post(`/api/admin/card_payments/${t2.body.order_id}/refund`)
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(client.balance).toBe(800);
    expect(referrer.client.referral_balance).toBe(0);

    const entries = ledgerOf(client.id);
    const reversal = entries.find(e => e.type === 'payment_reversal');
    expect(reversal).toBeTruthy();
    expect(reversal.amount).toBe(1000);
    const original = entries.find(e => e.type === 'card_payment' && e.payment_id === t2.body.order_id);
    expect(JSON.parse(reversal.details).reversedLedgerId).toBe(original.id);
    expect(db.prepare('SELECT status FROM card_payments WHERE order_id = ?').get(t2.body.order_id).status).toBe('refunded');

    // Повторный refund — идемпотентный ok.already.
    const again = await request(app)
      .post(`/api/admin/card_payments/${t2.body.order_id}/refund`)
      .set('X-Auth-Token', adminToken);
    expect(again.body.already).toBe(true);
    expect(client.balance).toBe(800);
  });

  it('провайдер упал → 502, ledger и статус НЕ тронуты', async () => {
    const { client, orderId } = await creditedPayment('rf_fail@wp3-test.local', 600);
    mockState.failRefund = true;
    const res = await request(app)
      .post(`/api/admin/card_payments/${orderId}/refund`)
      .set('X-Auth-Token', adminToken);
    expect(res.status).toBe(502);
    mockState.failRefund = false;
    expect(client.balance).toBe(600);
    expect(ledgerOf(client.id).find(e => e.type === 'payment_reversal')).toBeUndefined();
    expect(db.prepare('SELECT status FROM card_payments WHERE order_id = ?').get(orderId).status).toBe('credited');
  });

  it('refund незачтённого платежа → 409; несуществующего → 404; клиенту → 403', async () => {
    const { token, client } = await registerVerified('rf_409@wp3-test.local');
    const t = await topup(token, { amount: 500, method: 'card' });
    const conflict = await request(app)
      .post(`/api/admin/card_payments/${t.body.order_id}/refund`)
      .set('X-Auth-Token', adminToken);
    expect(conflict.status).toBe(409);
    const missing = await request(app)
      .post('/api/admin/card_payments/R-no-such/refund')
      .set('X-Auth-Token', adminToken);
    expect(missing.status).toBe(404);
    const forbidden = await request(app)
      .post(`/api/admin/card_payments/${t.body.order_id}/refund`)
      .set('X-Auth-Token', token);
    expect(forbidden.status).toBe(403);
    expect(client).toBeTruthy();
  });
});

describe('WP3: история платежей', () => {
  it('GET /api/client/payments — свои платежи + параметры формы; админ-список с логином', async () => {
    const { token, client, login } = await registerVerified('history@wp3-test.local');
    const t = await topup(token, { amount: 450, method: 'sbp' });

    const mine = await request(app).get('/api/client/payments').set('X-Auth-Token', token);
    expect(mine.status).toBe(200);
    expect(mine.body.payments.length).toBe(1);
    expect(mine.body.payments[0].order_id).toBe(t.body.order_id);
    expect(mine.body.payments[0].status).toBe('created');
    expect(mine.body.topup).toEqual({ min: 100, max: 100000, enabled: true, emailVerified: true });

    const admin = await request(app).get('/api/admin/card_payments').set('X-Auth-Token', adminToken);
    expect(admin.status).toBe(200);
    const row = admin.body.payments.find(p => p.order_id === t.body.order_id);
    expect(row.client_login).toBe(login);
    expect(row.client_id).toBe(client.id);

    const denied = await request(app).get('/api/admin/card_payments').set('X-Auth-Token', token);
    expect(denied.status).toBe(403);
  });
});

// ── Юнит-тесты маппинга (реальные provider.js + tochka-acquiring.js, фейковые deps)
describe('WP3: provider factory + маппинг tochka-acquiring (без сети)', () => {
  function fakeDeps(overrides = {}) {
    const settings = {
      tochka_acq_jwt: 'test-jwt',
      tochka_acq_customer_code: '300000001',
      ...overrides.settings,
    };
    return {
      logger: { warn() {}, error() {} },
      getSetting: (k, d) => (settings[k] !== undefined ? settings[k] : d),
      tochkaRequest: overrides.tochkaRequest || (async () => ({ status: 200, data: {} })),
      verifyJwtSignature: overrides.verifyJwtSignature || (async () => ({ verified: false, reason: 'stub' })),
    };
  }

  it('provider.create: пусто/none → null; неизвестный → null; tochka → объект', () => {
    // Роутовые тесты выше подменяют providerMod.create моком — здесь проверяем
    // НАСТОЯЩУЮ фабрику (origCreate сохранён до подмены).
    const s = (v) => (k, d) => (k === 'retail_acquiring_provider' ? v : d);
    expect(origCreate({ getSetting: s(''), logger: console })).toBeNull();
    expect(origCreate({ getSetting: s('none'), logger: console })).toBeNull();
    expect(origCreate({ getSetting: s('yookassa'), logger: { warn() {} } })).toBeNull();
    const p = origCreate({ getSetting: s('tochka'), logger: console, tochkaRequest: async () => ({}), verifyJwtSignature: async () => ({}) });
    expect(p.name).toBe('tochka');
  });

  it('create_payment: тело по OpenAPI (paymentMode, paymentLinkId, чек 54-ФЗ)', async () => {
    let captured = null;
    const deps = fakeDeps({
      settings: { tochka_acq_merchant_id: '200000000000001', tochka_acq_tax_system: 'usn_income' },
      tochkaRequest: async (cfg, method, path, body) => {
        captured = { cfg, method, path, body };
        return { status: 200, data: { Data: { operationId: 'op-1', paymentLink: 'https://pay.tochka.test/x' } } };
      },
    });
    const p = tochkaAcq.create(deps);
    const res = await p.create_payment({
      order_id: 'R1-abc', amount: 500, method: 'sbp',
      receipt_email: 'c@wp3-test.local', return_url: 'https://app.test/?ok', fail_url: 'https://app.test/?fail',
    });
    expect(res).toEqual({ confirmation_url: 'https://pay.tochka.test/x', provider_payment_id: 'op-1' });
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/uapi/acquiring/v1.0/payments_with_receipt');
    const D = captured.body.Data;
    expect(D.customerCode).toBe('300000001');
    expect(D.amount).toBe(500);
    expect(D.paymentMode).toEqual(['sbp']);
    expect(D.paymentLinkId).toBe('R1-abc');
    expect(D.redirectUrl).toBe('https://app.test/?ok');
    expect(D.failRedirectUrl).toBe('https://app.test/?fail');
    expect(D.Client).toEqual({ email: 'c@wp3-test.local' });
    expect(D.Items[0]).toMatchObject({ vatType: 'none', paymentMethod: 'full_payment', paymentObject: 'service', amount: 500, quantity: 1 });
    expect(D.merchantId).toBe('200000000000001');
    expect(D.taxSystemCode).toBe('usn_income');
  });

  it('create_payment: не-200/битый ответ → throw; без merchantId поле не шлём', async () => {
    let captured = null;
    const p = tochkaAcq.create(fakeDeps({
      tochkaRequest: async (cfg, m, path, body) => { captured = body; return { status: 400, data: { message: 'bad' } }; },
    }));
    await expect(p.create_payment({ order_id: 'R2', amount: 1, method: 'card', receipt_email: 'a@b.c', return_url: 'u' }))
      .rejects.toThrow(/create_payment failed/);
    expect(captured.Data.merchantId).toBeUndefined();
    expect(captured.Data.taxSystemCode).toBeUndefined();
  });

  it('verify_webhook: strict — подпись не прошла → ok:false; неверный тип → ok:false', async () => {
    const p = tochkaAcq.create(fakeDeps({
      verifyJwtSignature: async () => ({ verified: false, reason: 'bad_sig' }),
    }));
    expect((await p.verify_webhook({}, 'jwt.string.here')).ok).toBe(false);

    const p2 = tochkaAcq.create(fakeDeps({
      verifyJwtSignature: async () => ({ verified: true, payload: { webhookType: 'newPayment' } }),
    }));
    expect((await p2.verify_webhook({}, 'jwt')).ok).toBe(false);
  });

  it('verify_webhook: маппинг статусов APPROVED/EXPIRED/REFUNDED + amount-строка', async () => {
    function makeVerifier(payload) {
      return fakeDeps({ verifyJwtSignature: async () => ({ verified: true, payload }) });
    }
    const paid = await tochkaAcq.create(makeVerifier({
      webhookType: 'acquiringInternetPayment', status: 'APPROVED',
      paymentLinkId: 'R1-x', operationId: 'op-9', amount: '500.00', paymentType: 'sbp',
    })).verify_webhook({}, 'jwt');
    expect(paid).toMatchObject({ ok: true, order_id: 'R1-x', status: 'paid', provider_payment_id: 'op-9', method: 'sbp', amount: 500 });

    const expired = await tochkaAcq.create(makeVerifier({
      webhookType: 'acquiringInternetPayment', status: 'EXPIRED', paymentLinkId: 'R2',
    })).verify_webhook({}, 'jwt');
    expect(expired.status).toBe('failed');

    const refunded = await tochkaAcq.create(makeVerifier({
      webhookType: 'acquiringInternetPayment', status: 'REFUNDED_PARTIALLY', paymentLinkId: 'R3',
    })).verify_webhook({}, 'jwt');
    expect(refunded.status).toBe('refunded');

    const authorized = await tochkaAcq.create(makeVerifier({
      webhookType: 'acquiringInternetPayment', status: 'AUTHORIZED', paymentLinkId: 'R4',
    })).verify_webhook({}, 'jwt');
    expect(authorized.status).toBe('other');
  });

  it('refund: POST payments/{operationId}/refund; не-200 → throw', async () => {
    let captured = null;
    const ok = tochkaAcq.create(fakeDeps({
      tochkaRequest: async (cfg, m, path, body) => { captured = { m, path, body }; return { status: 200, data: { Data: { isRefund: true } } }; },
    }));
    expect((await ok.refund('op-1', 250)).ok).toBe(true);
    expect(captured.path).toBe('/uapi/acquiring/v1.0/payments/op-1/refund');
    expect(captured.body).toEqual({ Data: { amount: 250 } });

    const bad = tochkaAcq.create(fakeDeps({
      tochkaRequest: async () => ({ status: 409, data: { message: 'not approved' } }),
    }));
    await expect(bad.refund('op-2', 100)).rejects.toThrow(/refund failed/);
  });
});
