// B2C Этап 7 (WP6): промокоды + вывод партнёрской комиссии.
//   - src/db/promo-codes.js: findValid (нет/выключен/истёк/исчерпан),
//     consume — атомарный лимит (UPDATE WHERE used < max_uses);
//   - GET /api/client/promo/check — проверка кода для UI ЛК (без списаний);
//   - POST /api/client/topup + webhook: бонус percent/fixed отдельной строкой
//     ledger (type='promo_bonus'), used++;
//   - bonus_days из промокодов убран (2026-08): покупка промокодов не принимает;
//   - POST /api/client/referral/withdraw_to_balance: self-referral трюк —
//     balance += amount и referral_balance = 0 в одной транзакции;
//   - POST /api/admin/clients/:id/referral_payout: ручная выплата оператором
//     (Р28), 409 при нехватке, строка ledger type='payout';
//   - Админ CRUD промокодов: create/list/toggle/delete, дубликат → 409.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { bootApp, asAdmin } from '../_helpers/app.js';

const require = createRequire(import.meta.url);
const stateMod = require('../../src/state/index.js');
const providerMod = require('../../src/payments/provider.js');
const promoDb = require('../../src/db/promo-codes.js');

const origCreate = providerMod.create;

let app, db, adminToken;
const createdLogins = [];

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
  async refund() { return { ok: true }; },
};

function setSetting(key, value) {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');
  const settings = row ? JSON.parse(row.value) : {};
  settings[key] = value;
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('app_settings', ?, datetime('now'))")
    .run(JSON.stringify(settings));
  stateMod.state.appSettings[key] = value;
}

function syncClient(login, patch) {
  const c = stateMod.state.clients.find(x => x.login === login);
  if (c) Object.assign(c, patch);
  return c;
}

async function registerVerified(email) {
  const res = await request(app).post('/api/register')
    .send({ email, password: 'password123', consent: true });
  expect(res.status).toBe(200);
  createdLogins.push(res.body.login);
  db.prepare('UPDATE clients SET email_verified = 1 WHERE login = ?').run(res.body.login);
  syncClient(res.body.login, { emailVerified: true });
  return res.body;   // { token, login, client }
}

function webhook(payload) {
  return request(app).post('/api/payments/webhook/tochka')
    .set('Content-Type', 'text/plain')
    .set('X-Test-Sig', 'valid')
    .send(JSON.stringify(payload));
}

function ledgerOf(clientId) {
  return db.prepare('SELECT * FROM billing_ledger WHERE client_id = ? ORDER BY id').all(clientId);
}

function cleanup() {
  const emails = db.prepare("SELECT id, login FROM clients WHERE email LIKE '%@wp6-test.local'").all();
  for (const c of emails) {
    db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(c.id);
    db.prepare('DELETE FROM card_payments WHERE client_id = ?').run(c.id);
  }
  db.prepare("DELETE FROM clients WHERE email LIKE '%@wp6-test.local'").run();
  db.prepare("DELETE FROM promo_codes WHERE code LIKE 'WP6%'").run();
  db.prepare("DELETE FROM tariffs WHERE name LIKE 'wp6_%'").run();
  const arr = stateMod.state.clients;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/@wp6-test\.local$/.test(arr[i].email || '')) arr.splice(i, 1);
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
  setSetting('retail_max_accounts_per_ip', 1000);
  setSetting('retail_reg_limit_per_ip_day', 1000);
  providerMod.create = () => mockProvider;
});

afterAll(() => {
  providerMod.create = origCreate;
  setSetting('retail_enabled', false);
  setSetting('retail_acquiring_provider', '');
  cleanup();
});

// ── Админ CRUD ───────────────────────────────────────────────────────────────
describe('WP6: админ CRUD промокодов', () => {
  let promoId;
  it('create → list, toggle выключает, delete удаляет', async () => {
    const res = await request(app).post('/api/admin/promo-codes')
      .set('X-Auth-Token', adminToken)
      .send({ code: 'WP6CRUD', type: 'percent', value: 10, max_uses: 5 });
    expect(res.status).toBe(200);
    promoId = res.body.id;

    const list = await request(app).get('/api/admin/promo-codes').set('X-Auth-Token', adminToken);
    const p = list.body.promo_codes.find(x => x.code === 'WP6CRUD');
    expect(p).toMatchObject({ type: 'percent', value: 10, max_uses: 5, used: 0, active: true });
    expect(p.description).toBe('+10% к пополнению');

    const off = await request(app).post(`/api/admin/promo-codes/${promoId}/toggle`).set('X-Auth-Token', adminToken);
    expect(off.body.active).toBe(false);
    expect(promoDb.findValid('WP6CRUD').error).toBeTruthy();

    const on = await request(app).post(`/api/admin/promo-codes/${promoId}/toggle`).set('X-Auth-Token', adminToken);
    expect(on.body.active).toBe(true);

    const del = await request(app).delete(`/api/admin/promo-codes/${promoId}`).set('X-Auth-Token', adminToken);
    expect(del.status).toBe(200);
    expect(promoDb.findValid('WP6CRUD').error).toBeTruthy();
  });

  it('дубликат кода → 409; percent > 100 → 400', async () => {
    await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6DUP', type: 'fixed', value: 100 });
    const dup = await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'wp6dup', type: 'fixed', value: 50 });
    expect(dup.status).toBe(409);
    const big = await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6BIG', type: 'percent', value: 150 });
    expect(big.status).toBe(400);
  });

  it('без admin → 401/403', async () => {
    const res = await request(app).get('/api/admin/promo-codes');
    expect([401, 403]).toContain(res.status);
  });
});

// ── promoDb: findValid / consume ─────────────────────────────────────────────
describe('WP6: promoDb — findValid и атомарный consume', () => {
  it('истёкший и исчерпанный код невалидны; consume не превышает max_uses', () => {
    promoDb.create({ code: 'WP6EXP', type: 'fixed', value: 10, max_uses: null, expires_at: '2020-01-01T23:59:59.000Z' });
    expect(promoDb.findValid('WP6EXP').error).toBeTruthy();

    const id = promoDb.create({ code: 'WP6LIM', type: 'fixed', value: 10, max_uses: 1, expires_at: null });
    expect(promoDb.consume(id)).toBe(true);
    expect(promoDb.consume(id)).toBe(false);   // лимит исчерпан — гонка проиграна
    expect(promoDb.findValid('WP6LIM').error).toBeTruthy();
  });
});

// ── ЛК: проверка промокода ───────────────────────────────────────────────────
describe('WP6: GET /api/client/promo/check — контексты', () => {
  let token;
  beforeAll(async () => {
    ({ token } = await registerVerified('check@wp6-test.local'));
    await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6PCT', type: 'percent', value: 10 });
  });

  it('percent в context=topup → ok с описанием; в context=buy → 400', async () => {
    const ok = await request(app).get('/api/client/promo/check?code=WP6PCT&context=topup').set('X-Auth-Token', token);
    expect(ok.body).toMatchObject({ ok: true, type: 'percent', value: 10, description: '+10% к пополнению' });
    const bad = await request(app).get('/api/client/promo/check?code=WP6PCT&context=buy').set('X-Auth-Token', token);
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
  });

  it('bonus_days больше не создаётся → 400; несуществующий код → 404', async () => {
    const bd = await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6DAYS', type: 'bonus_days', value: 3 });
    expect(bd.status).toBe(400);
    const nf = await request(app).get('/api/client/promo/check?code=WP6NOPE&context=topup').set('X-Auth-Token', token);
    expect(nf.status).toBe(404);
  });
});

// ── topup + webhook: бонус percent ──────────────────────────────────────────
describe('WP6: промокод при пополнении', () => {
  it('percent 10%: платёж 1000 ₽ → баланс 1100 ₽, ledger promo_bonus, used=1', async () => {
    await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6BONUS', type: 'percent', value: 10 });
    const { token, login } = await registerVerified('bonus@wp6-test.local');

    const top = await request(app).post('/api/client/topup').set('X-Auth-Token', token)
      .send({ amount: 1000, method: 'card', promo: 'wp6bonus' });   // регистр не важен
    expect(top.status).toBe(200);
    const orderId = top.body.order_id || top.body.confirmation_url.split('/').pop();
    const payRow = db.prepare('SELECT * FROM card_payments WHERE order_id = ?').get(orderId);
    expect(payRow.promo_code).toBe('WP6BONUS');

    const wh = await webhook({ order_id: orderId, operation_id: 'op_' + orderId, method: 'card', amount: 1000 });
    expect(wh.status).toBe(200);

    const clientId = db.prepare('SELECT id FROM clients WHERE login = ?').get(login).id;
    const rows = ledgerOf(clientId);
    const payment = rows.find(r => r.type === 'card_payment' && r.amount === 1000);
    const bonus = rows.find(r => r.type === 'promo_bonus');
    expect(payment).toBeTruthy();
    expect(bonus).toMatchObject({ amount: 100, source: 'promo' });
    expect(bonus.note).toContain('WP6BONUS');
    const balance = db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance;
    expect(Math.round(balance)).toBe(1100);
    expect(promoDb.list().find(p => p.code === 'WP6BONUS').used).toBe(1);

    // повторный webhook — идемпотентно, бонус не дублируется
    await webhook({ order_id: orderId, operation_id: 'op_' + orderId, method: 'card', amount: 1000 });
    expect(ledgerOf(clientId).filter(r => r.type === 'promo_bonus').length).toBe(1);
  });

  it('fixed: платёж 500 ₽ + промокод 150 ₽ → баланс 650 ₽', async () => {
    await request(app).post('/api/admin/promo-codes').set('X-Auth-Token', adminToken)
      .send({ code: 'WP6FIX', type: 'fixed', value: 150 });
    const { token, login } = await registerVerified('fixed@wp6-test.local');
    const top = await request(app).post('/api/client/topup').set('X-Auth-Token', token)
      .send({ amount: 500, method: 'sbp', promo: 'WP6FIX' });
    expect(top.status).toBe(200);
    const orderId = top.body.order_id || top.body.confirmation_url.split('/').pop();
    await webhook({ order_id: orderId, operation_id: 'op_' + orderId, method: 'sbp', amount: 500 });
    const clientId = db.prepare('SELECT id FROM clients WHERE login = ?').get(login).id;
    const bonus = ledgerOf(clientId).find(r => r.type === 'promo_bonus');
    expect(bonus).toMatchObject({ amount: 150 });
  });

  it('невалидный промокод → 400 PROMO_INVALID', async () => {
    const { token } = await registerVerified('wrongctx@wp6-test.local');
    const inv = await request(app).post('/api/client/topup').set('X-Auth-Token', token)
      .send({ amount: 500, method: 'card', promo: 'WP6NOPE' });
    expect(inv.status).toBe(400);
    expect(inv.body.code).toBe('PROMO_INVALID');
  });
});

// ── Вывод рефкомиссии ───────────────────────────────────────────────────────
describe('WP6: вывод партнёрской комиссии', () => {
  it('withdraw_to_balance: пусто → 400; 200 ₽ → баланс +200, комиссия 0, ledger referral_withdraw', async () => {
    const { token, login } = await registerVerified('wd@wp6-test.local');
    const empty = await request(app).post('/api/client/referral/withdraw_to_balance').set('X-Auth-Token', token);
    expect(empty.status).toBe(400);

    db.prepare('UPDATE clients SET referral_balance = 200 WHERE login = ?').run(login);
    syncClient(login, { referral_balance: 200 });

    const res = await request(app).post('/api/client/referral/withdraw_to_balance').set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(200);

    const row = db.prepare('SELECT balance, referral_balance FROM clients WHERE login = ?').get(login);
    expect(Math.round(row.balance)).toBe(200);
    expect(Math.round(row.referral_balance)).toBe(0);
    const clientId = db.prepare('SELECT id FROM clients WHERE login = ?').get(login).id;
    const led = ledgerOf(clientId).find(r => r.type === 'referral_withdraw');
    expect(led).toMatchObject({ amount: 200 });

    // повтор — уже нечего выводить
    const again = await request(app).post('/api/client/referral/withdraw_to_balance').set('X-Auth-Token', token);
    expect(again.status).toBe(400);
  });

  it('admin referral_payout: нехватка → 409; 150 из 200 → ledger payout, комиссия 50', async () => {
    const { login } = await registerVerified('payout@wp6-test.local');
    db.prepare('UPDATE clients SET referral_balance = 200 WHERE login = ?').run(login);
    const client = syncClient(login, { referral_balance: 200 });

    const tooMuch = await request(app).post(`/api/admin/clients/${client.id}/referral_payout`)
      .set('X-Auth-Token', adminToken).send({ amount: 500 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('INSUFFICIENT_REFERRAL');

    const res = await request(app).post(`/api/admin/clients/${client.id}/referral_payout`)
      .set('X-Auth-Token', adminToken).send({ amount: 150, note: 'На карту' });
    expect(res.status).toBe(200);
    expect(res.body.referral_balance).toBe(50);
    expect(client.referral_balance).toBe(50);

    const payout = ledgerOf(client.id).find(r => r.type === 'payout');
    expect(payout).toMatchObject({ amount: 150, source: 'referral' });
    // баланс клиента выплата не трогает
    const bal = db.prepare('SELECT balance FROM clients WHERE id = ?').get(client.id).balance;
    expect(Math.round(bal)).toBe(0);
  });
});
