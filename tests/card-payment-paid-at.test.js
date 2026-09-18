// 2026-09-18 · Регрессии DEEP-17 (FIX-SPEC §14.1): paid_at и дедуп служебного
// алерта эквайринга. Настоящие SQLite repositories (card_payments, ledger —
// через bootApp); банк/провайдер — заглушка. На коде до исправления:
//   - paid_at не сохранялся, recovery считал 15 минут от created_at — заказ,
//     созданный задолго до оплаты, алертил сразу;
//   - dedupeKey правила retail_card_payment содержал Date.now() — повтор
//     одного unresolved-инцидента создавал сообщение каждый цикл recovery.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const createRouter = require('../src/routes/payments');
const cardPaymentsRepo = require('../src/db/card-payments');
const ledgerRepo = require('../src/db/ledger');
const promoRepo = require('../src/db/promo-codes');
const stateMod = require('../src/state/index.js');

let db, atomic, router, alertSpy, warnSpy;
let failCredit = false;
const TAG = 'deep17';
const cleanupIds = { clients: [], orders: [] };

function seedClient(id, balance = 0) {
  db.prepare(`INSERT INTO clients (id, login, name, balance, created_at)
              VALUES (?, ?, ?, ?, datetime('now'))`)
    .run(id, `${TAG}_${id}`, 'DEEP17 ' + id, balance);
  const client = { id, login: `${TAG}_${id}`, balance };
  stateMod.state.clients.push(client);
  cleanupIds.clients.push(id);
  return client;
}
function syncMap() {
  return { get: (id) => stateMod.state.clients.find(c => c.id === id) };
}
function orderRow(orderId) {
  return db.prepare('SELECT * FROM card_payments WHERE order_id = ?').get(orderId);
}
function balanceOf(clientId) {
  return db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance;
}
function mkPaidOrder(orderId, clientId, amount) {
  cleanupIds.orders.push(orderId);
  cardPaymentsRepo.insertCreated(orderId, clientId, amount, 'card', null, null);
  cardPaymentsRepo.markPaid(orderId, 'op_' + orderId, '{}');
  return orderRow(orderId);
}
function webhookHandler() {
  return router.stack.find(l => l.route && l.route.path === '/api/payments/webhook/tochka')
    .route.stack.at(-1).handle;
}
const mockRes = () => ({
  code: 200, body: null,
  status(n) { this.code = n; return this; },
  json(d) { this.body = d; return this; },
});

beforeAll(() => {
  db = bootApp().db;
  atomic = require('../src/billing/atomic.js');   // инициализирован server.js на этой БД
  alertSpy = vi.fn();
  warnSpy = vi.fn();
  const pass = (_req, _res, next) => next();
  router = createRouter({
    logger: { info() {}, warn: warnSpy, error() {} }, authMiddleware: pass, adminMiddleware: pass,
    validate: () => pass, TopupSchema: {}, topupLimiter: pass, webhookLimiter: pass,
    clients: stateMod.state.clients, clientById: syncMap(), saveClients: vi.fn(),
    getSetting: (_k, d) => d, tariffsDb: {},
    cardPaymentsDb: cardPaymentsRepo, ledgerDb: ledgerRepo, promoDb: promoRepo,
    // Зачисление падает, пока failCredit=true (крах между webhook и кредитом).
    atomicCredit: (...args) => {
      if (failCredit) throw new Error('SQLITE_BUSY: database is locked');
      return atomic.atomicCredit(...args);
    },
    atomicDebit: atomic.atomicDebit,
    auditLog() {}, logActivity() {}, getClientIp: () => '',
    alerts: { trigger: alertSpy },
    createProvider: () => router.__provider,
  });
});

afterEach(() => { failCredit = false; });

afterAll(() => {
  for (const id of cleanupIds.orders) {
    db.prepare('DELETE FROM card_payments WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM billing_ledger WHERE payment_id = ?').run(id);
    db.prepare('DELETE FROM finance_idempotency WHERE event_key LIKE ?').run(`%:${id}`);
  }
  for (const id of cleanupIds.clients) {
    db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    const i = stateMod.state.clients.findIndex(c => c.id === id);
    if (i >= 0) stateMod.state.clients.splice(i, 1);
  }
});

describe('DEEP-17: paid_at — возраст незавершённого зачисления (§14.1)', () => {
  it('markPaid фиксирует paid_at первого подтверждения банка; повтор его не двигает', () => {
    const c = seedClient('d17_c0');
    cleanupIds.orders.push('d17_mark');
    cardPaymentsRepo.insertCreated('d17_mark', c.id, 100, 'card', null, null);
    cardPaymentsRepo.markPaid('d17_mark', 'op_d17_mark', '{}');
    const row = orderRow('d17_mark');
    expect(row.status).toBe('paid');
    // SQLite UTC-формат, как credited_at/next_recovery_at (сравним лексикографически).
    expect(row.paid_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    cardPaymentsRepo.markPaid('d17_mark', 'op_other', '{}');   // status уже paid → no-op
    expect(orderRow('d17_mark').paid_at).toBe(row.paid_at);
    expect(orderRow('d17_mark').provider_payment_id).toBe('op_d17_mark');
    // Закрываем заказ, чтобы он не поднимался recovery-прогонами других тестов.
    db.prepare("UPDATE card_payments SET status='credited' WHERE order_id='d17_mark'").run();
  });

  it('свежая оплата СТАРОГО заказа: 15 минут считаются от paid_at — алерта нет', async () => {
    const c = seedClient('d17_c1');
    mkPaidOrder('d17_fresh', c.id, 500);
    // Заказ создан 2 часа назад, банк подтвердил оплату 5 минут назад.
    db.prepare("UPDATE card_payments SET created_at=datetime('now','-2 hours'), paid_at=datetime('now','-5 minutes') WHERE order_id='d17_fresh'").run();
    failCredit = true;
    alertSpy.mockClear();
    const res = await router.runRecovery();
    expect(res.failed).toBe(1);
    // Возраст незавершённого зачисления — 5 минут: инцидент ещё свежий.
    expect(alertSpy.mock.calls.filter(a => a[1] && a[1].error === 'recovery_failed')).toEqual([]);
  });

  it('зачисление не завершено >15 минут от paid_at → служебный алерт с order_id', async () => {
    const c = seedClient('d17_c2');
    mkPaidOrder('d17_stale', c.id, 500);
    db.prepare("UPDATE card_payments SET paid_at=datetime('now','-20 minutes') WHERE order_id='d17_stale'").run();
    failCredit = true;
    alertSpy.mockClear();
    const res = await router.runRecovery();
    expect(res.failed).toBe(1);
    expect(alertSpy).toHaveBeenCalledWith('retail_card_payment',
      expect.objectContaining({ order_id: 'd17_stale', error: 'recovery_failed' }));
  });

  it('legacy-строка без paid_at: вымышленное время не приписывается — диагностика вместо алерта по возрасту', async () => {
    const c = seedClient('d17_c3');
    mkPaidOrder('d17_legacy', c.id, 500);
    // Как строка до миграции 094: paid, но paid_at NULL; заказ старый.
    db.prepare("UPDATE card_payments SET paid_at=NULL, created_at=datetime('now','-2 hours') WHERE order_id='d17_legacy'").run();
    failCredit = true;
    alertSpy.mockClear();
    warnSpy.mockClear();
    const res = await router.runRecovery();
    expect(res.failed).toBe(1);
    // created_at — НЕ возраст незавершённого зачисления: алерта по возрасту нет,
    // состояние диагностируется в логе, paid_at остаётся NULL (не выдуман).
    expect(alertSpy.mock.calls.filter(a => a[1] && a[1].error === 'recovery_failed')).toEqual([]);
    expect(orderRow('d17_legacy').paid_at).toBe(null);
    expect(warnSpy.mock.calls.some(a => /paid_at/.test(String(a[0])))).toBe(true);
  });

  it('повторный верифицированный paid-webhook по legacy-строке фиксирует paid_at и доводит зачисление', async () => {
    const c = seedClient('d17_c4');
    cleanupIds.orders.push('d17_hook');
    cardPaymentsRepo.insertCreated('d17_hook', c.id, 300, 'card', null, null);
    // legacy-строка: paid без paid_at (как до миграции 094).
    db.prepare("UPDATE card_payments SET status='paid', provider_payment_id='op_d17_hook' WHERE order_id='d17_hook'").run();
    router.__provider = {
      verify_webhook: async () => ({
        ok: true, order_id: 'd17_hook', status: 'paid',
        provider_payment_id: 'op_d17_hook', raw: {},
      }),
    };
    const res = mockRes();
    await webhookHandler()({ headers: {}, body: 'raw-jwt' }, res);

    expect(res.code).toBe(200);
    expect(res.body.credited).toBe(true);
    const row = orderRow('d17_hook');
    // Проверенное подтверждение банка сохранено — это НЕ вымышленное время.
    expect(row.paid_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.status).toBe('credited');
    expect(balanceOf(c.id)).toBe(300);
    // Повтор webhook: paid_at первого подтверждения не перезаписывается.
    const res2 = mockRes();
    await webhookHandler()({ headers: {}, body: 'raw-jwt' }, res2);
    expect(orderRow('d17_hook').paid_at).toBe(row.paid_at);
    expect(balanceOf(c.id)).toBe(300);
  });
});

// Дедуп служебного алерта: модуль alerts изолирован на файл (vitest),
// init с моками по паттерну retail-alerts.test.js.
describe('DEEP-17: дедуп retail_card_payment без Date.now() (§14.1)', () => {
  const alerts = require('../src/telegram/alerts.js');
  let sendMessage;

  beforeAll(() => {
    sendMessage = vi.fn().mockResolvedValue({});
    alerts.init({
      logger: { warn() {}, info() {}, error() {} },
      getSetting: (k, d) => (k === 'telegram_bot_token' ? 'tok' : d),
      appSettings: { telegram_chat_id: '123', telegram_night_digest_enabled: false },
      kvSetCritical: () => ({ ok: true }),
      kvGet: { get: () => undefined },
      db: { prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined }) },
      tgBot: { sendMessage },
    });
    // boot-grace 5 минут молчания — переносим «сейчас» за пределы окна.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
  });
  afterAll(() => { vi.useRealTimers(); });

  it('dedupeKey стабилен для одного инцидента: order_id + тип проблемы, без Date.now()', () => {
    const rule = alerts.RULES.retail_card_payment;
    const p = { order_id: 'ord_1', error: 'recovery_failed', login: 'u', amount: 100 };
    const k1 = rule.dedupeKey(p);
    vi.advanceTimersByTime(60000);   // другое время — тот же инцидент
    expect(rule.dedupeKey(p)).toBe(k1);
    // Другой заказ / другой тип проблемы / успех — другие ключи.
    expect(rule.dedupeKey({ ...p, order_id: 'ord_2' })).not.toBe(k1);
    expect(rule.dedupeKey({ ...p, error: 'credit_failed' })).not.toBe(k1);
    expect(rule.dedupeKey({ order_id: 'ord_1', login: 'u', amount: 100 })).not.toBe(k1);
  });

  it('повтор unresolved-инцидента не создаёт сообщение каждый цикл recovery', () => {
    sendMessage.mockClear();
    const p = { order_id: 'ord_inc', client_id: 'c', login: 'u', amount: 100, method: 'card', error: 'recovery_failed' };
    expect(alerts.trigger('retail_card_payment', p)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60000);   // следующий проход recovery (5 мин)
    expect(alerts.trigger('retail_card_payment', p)).toBe(false);
    vi.advanceTimersByTime(5 * 60000);
    expect(alerts.trigger('retail_card_payment', p)).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Успешные оплаты разных заказов не подавляют друг друга.
    expect(alerts.trigger('retail_card_payment', { order_id: 'ord_ok1', client_id: 'c', login: 'u', amount: 100, method: 'card' })).toBe(true);
    expect(alerts.trigger('retail_card_payment', { order_id: 'ord_ok2', client_id: 'c', login: 'u', amount: 100, method: 'card' })).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});
