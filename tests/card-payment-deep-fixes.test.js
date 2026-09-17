// 2026-09-18 · Регрессии DEEP-01/02/03 (FIX-SPEC §13–14) на НАСТОЯЩИХ SQLite
// repositories: заглушается только банк (createProvider), а consume /
// markCredited / finance_idempotency — настоящие, на общей тестовой БД.
// Каждый тест падал на коде до исправления:
//   DEEP-01: ISO 'T' vs SQLite ' ' — просроченный retry в тот же день не выбирался;
//   DEEP-02: отключённый/исчерпанный промокод оставлял заказ в 'paid' навсегда;
//   DEEP-03: два refund проходили credited до await провайдера; статус писался
//            вне транзакции сторно.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const createRouter = require('../src/routes/payments');
const cardPaymentsRepo = require('../src/db/card-payments');
const ledgerRepo = require('../src/db/ledger');
const promoRepo = require('../src/db/promo-codes');
const stateMod = require('../src/state/index.js');

let db, atomic, router, alertSpy;
const TAG = 'deep18';
const cleanupIds = { clients: [], orders: [], promos: [] };

function seedClient(id, balance = 0) {
  db.prepare(`INSERT INTO clients (id, login, name, balance, created_at)
              VALUES (?, ?, ?, ?, datetime('now'))`)
    .run(id, `${TAG}_${id}`, 'DEEP ' + id, balance);
  const client = { id, login: `${TAG}_${id}`, balance };
  stateMod.state.clients.push(client);
  cleanupIds.clients.push(id);
  return client;
}
function syncMap() {
  // Живой геттер: клиенты сидятся уже ПОСЛЕ создания роутера.
  return { get: (id) => stateMod.state.clients.find(c => c.id === id) };
}
function orderRow(orderId) {
  return db.prepare('SELECT * FROM card_payments WHERE order_id = ?').get(orderId);
}
function ledgerRows(clientId, type) {
  return db.prepare('SELECT * FROM billing_ledger WHERE client_id = ? AND type = ?').all(clientId, type);
}
function balanceOf(clientId) {
  return db.prepare('SELECT balance FROM clients WHERE id = ?').get(clientId).balance;
}

beforeAll(() => {
  db = bootApp().db;
  atomic = require('../src/billing/atomic.js');   // инициализирован server.js на этой БД
  alertSpy = vi.fn();
  const pass = (_req, _res, next) => next();
  router = createRouter({
    logger: { info() {}, warn() {}, error() {} }, authMiddleware: pass, adminMiddleware: pass,
    validate: () => pass, TopupSchema: {}, topupLimiter: pass, webhookLimiter: pass,
    clients: stateMod.state.clients, clientById: syncMap(), saveClients: vi.fn(),
    getSetting: (_k, d) => d, tariffsDb: {},
    cardPaymentsDb: cardPaymentsRepo, ledgerDb: ledgerRepo, promoDb: promoRepo,
    atomicCredit: atomic.atomicCredit, atomicDebit: atomic.atomicDebit,
    auditLog() {}, logActivity() {}, getClientIp: () => '',
    alerts: { trigger: alertSpy },
    createProvider: () => router.__provider,
  });
});

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
  for (const id of cleanupIds.promos) db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id);
});

function mkOrder(orderId, clientId, amount, promo = {}) {
  cleanupIds.orders.push(orderId);
  cardPaymentsRepo.insertCreated(orderId, clientId, amount, 'card', promo.code || null,
    promo.bonusAmount != null ? promo.bonusAmount : null);
  cardPaymentsRepo.markPaid(orderId, 'op_' + orderId, '{}');
  return orderRow(orderId);
}

// ── DEEP-01 ─────────────────────────────────────────────────────────────────
describe('DEEP-01: pendingPaid и формат next_recovery_at', () => {
  it('просроченный ISO-retry (с T) в тот же день выбирается; будущий — нет', () => {
    const c = seedClient('d01_c');
    // legacy-формат: toISOString с 'T' и миллисекундами, минута назад (UTC).
    mkOrder('d01_iso', c.id, 100);
    db.prepare('UPDATE card_payments SET next_recovery_at = ? WHERE order_id = ?')
      .run(new Date(Date.now() - 60000).toISOString(), 'd01_iso');
    expect(cardPaymentsRepo.pendingPaid(10).map(r => r.order_id)).toContain('d01_iso');
    // Будущий ISO-retry не выбирается.
    db.prepare('UPDATE card_payments SET next_recovery_at = ? WHERE order_id = ?')
      .run(new Date(Date.now() + 3600000).toISOString(), 'd01_iso');
    expect(cardPaymentsRepo.pendingPaid(10).map(r => r.order_id)).not.toContain('d01_iso');
    // markRecoveryFailure пишет SQLite-формат (с пробелом) — сравнимо с datetime('now').
    cardPaymentsRepo.markRecoveryFailure('d01_iso', 'boom');
    expect(orderRow('d01_iso').next_recovery_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

// ── DEEP-02 ─────────────────────────────────────────────────────────────────
describe('DEEP-02: бонус отделён от основной оплаты', () => {
  it('отключённый после оплаты код: основная сумма зачислена, заказ credited, бонус → review', async () => {
    const c = seedClient('d02_c1');
    const pid = promoRepo.create({ code: 'D02OFF', type: 'percent', value: 10 });
    cleanupIds.promos.push(pid);
    mkOrder('d02_off', c.id, 200, { code: 'D02OFF', bonusAmount: 20 });
    promoRepo.setActive(pid, false);   // код отключён ПОСЛЕ создания заказа

    const res = await router.runRecovery();
    expect(res.failed).toBe(0);
    const row = orderRow('d02_off');
    expect(row.status).toBe('credited');            // не застрял в paid
    expect(row.promo_status).toBe('review');
    expect(balanceOf(c.id)).toBe(200);              // только основная сумма
    expect(ledgerRows(c.id, 'promo_bonus')).toEqual([]);
    expect(promoRepo.byCode('D02OFF').used).toBe(0); // лимит НЕ обходили
    expect(alertSpy).toHaveBeenCalledWith('retail_card_payment',
      expect.objectContaining({ order_id: 'd02_off', error: 'promo_review' }));
    // Повторный проход — заказ больше не поднимается, денег не прибавляется.
    alertSpy.mockClear();
    await router.runRecovery();
    expect(balanceOf(c.id)).toBe(200);
    expect(alertSpy.mock.calls.filter(a => a[1] && a[1].order_id === 'd02_off')).toEqual([]);
  });

  it('исчерпанный лимит: первый заказ получает бонус, второй → review без зацикливания', async () => {
    const c1 = seedClient('d02_c2');
    const c2 = seedClient('d02_c3');
    const pid = promoRepo.create({ code: 'D02ONE', type: 'fixed', value: 50, max_uses: 1 });
    cleanupIds.promos.push(pid);
    mkOrder('d02_first', c1.id, 100, { code: 'D02ONE', bonusAmount: 50 });
    mkOrder('d02_second', c2.id, 100, { code: 'D02ONE', bonusAmount: 50 });

    await router.runRecovery();
    expect(balanceOf(c1.id)).toBe(150);
    expect(orderRow('d02_first').promo_status).toBe('applied');
    expect(promoRepo.byCode('D02ONE').used).toBe(1);
    expect(balanceOf(c2.id)).toBe(100);             // только основная сумма
    const second = orderRow('d02_second');
    expect(second.status).toBe('credited');
    expect(second.promo_status).toBe('review');
    await router.runRecovery();                      // повтор ничего не меняет
    expect(balanceOf(c2.id)).toBe(100);
    expect(promoRepo.byCode('D02ONE').used).toBe(1);
  });

  it('удалённый код + уже записанный исторический бонус: сверка завершает заказ без новых денег', async () => {
    const c = seedClient('d02_c4');
    const pid = promoRepo.create({ code: 'D02GONE', type: 'percent', value: 10 });
    cleanupIds.promos.push(pid);
    mkOrder('d02_hist', c.id, 300, { code: 'D02GONE' });
    // Исторический бонус записан «как раньше» — прямая строка ledger.
    db.prepare(`INSERT INTO billing_ledger (client_id, type, date, timestamp, amount, currency, payment_id)
                VALUES (?, 'promo_bonus', '2026-09-10', '2026-09-10T00:00:00Z', 30, 'RUB', ?)`)
      .run(c.id, 'd02_hist');
    promoRepo.remove(pid);                           // код удалён ДО recovery

    await router.runRecovery();
    const row = orderRow('d02_hist');
    expect(row.status).toBe('credited');
    expect(row.promo_status).toBe('applied');
    expect(balanceOf(c.id)).toBe(300);               // основная сумма один раз
    expect(ledgerRows(c.id, 'promo_bonus').length).toBe(1); // бонус НЕ продублирован
  });

  it('пересозданный код с тем же именем не меняет зафиксированную сумму бонуса', async () => {
    const c = seedClient('d02_c5');
    const pid = promoRepo.create({ code: 'D02SNAP', type: 'fixed', value: 10 });
    cleanupIds.promos.push(pid);
    mkOrder('d02_snap', c.id, 100, { code: 'D02SNAP', bonusAmount: 10 });
    // Код пересоздан с ДРУГИМ номиналом после создания заказа.
    promoRepo.remove(pid);
    const pid2 = promoRepo.create({ code: 'D02SNAP', type: 'fixed', value: 999 });
    cleanupIds.promos.push(pid2);

    await router.runRecovery();
    expect(balanceOf(c.id)).toBe(110);               // снимок 10 ₽, а не 999 ₽
    const bonus = ledgerRows(c.id, 'promo_bonus');
    expect(bonus.length).toBe(1);
    expect(bonus[0].amount).toBe(10);
    expect(orderRow('d02_snap').promo_status).toBe('applied');
  });

  it('крах между основным кредитом и бонусом: recovery доводит ровно один раз', async () => {
    const c = seedClient('d02_c6');
    const pid = promoRepo.create({ code: 'D02CRASH', type: 'percent', value: 10 });
    cleanupIds.promos.push(pid);
    mkOrder('d02_crash', c.id, 500, { code: 'D02CRASH', bonusAmount: 50 });
    // Имитация краха ПОСЛЕ коммита основного кредита, ДО бонуса: реальная
    // транзакция atomicCredit с durable-claim, заказ остаётся paid.
    atomic.atomicCredit(c.id, 500, {
      type: 'card_payment', source: 'acquiring', amount: 500,
      date: '2026-09-18', timestamp: '2026-09-18T00:00:00Z',
      note: 'Пополнение', paymentId: 'd02_crash',
    }, { idempotencyKey: 'card_payment:d02_crash' });

    await router.runRecovery();
    expect(balanceOf(c.id)).toBe(550);               // 500 (не продублированы) + 50
    expect(orderRow('d02_crash').status).toBe('credited');
    expect(orderRow('d02_crash').promo_status).toBe('applied');
    expect(promoRepo.byCode('D02CRASH').used).toBe(1);
    await router.runRecovery();                      // повтор — no-op
    expect(balanceOf(c.id)).toBe(550);
    expect(ledgerRows(c.id, 'card_payment').length).toBe(1);
    expect(ledgerRows(c.id, 'promo_bonus').length).toBe(1);
  });
});

// ── DEEP-03 ─────────────────────────────────────────────────────────────────
describe('DEEP-03: устойчивый возврат эквайринга', () => {
  function refundHandler() {
    return router.stack.find(l => l.route && l.route.path === '/api/admin/card_payments/:orderId/refund')
      .route.stack.at(-1).handle;
  }
  const mockRes = () => ({
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(d) { this.body = d; return this; },
  });
  const mockReq = (orderId) => ({ params: { orderId }, user: { login: 'admin' }, headers: {} });

  it('два конкурентных refund: один вызов банка, одно сторно, второй — 409', async () => {
    const c = seedClient('d03_c1', 800);
    mkOrder('d03_race', c.id, 800);
    db.prepare("UPDATE card_payments SET status='credited' WHERE order_id='d03_race'").run();
    // Управляемый барьер перед ответом провайдера — без случайных sleep.
    let releaseBarrier;
    const barrier = new Promise(r => { releaseBarrier = r; });
    let providerCalls = 0;
    router.__provider = {
      async refund() { providerCalls++; await barrier; return { ok: true }; },
    };
    const handler = refundHandler();
    const r1 = mockRes(), r2 = mockRes();
    const p1 = handler(mockReq('d03_race'), r1);
    const p2 = handler(mockReq('d03_race'), r2);
    await p2;               // второй запрос отброшен захватом, не дожидаясь банка
    releaseBarrier();
    await p1;
    expect(providerCalls).toBe(1);
    expect(r1.code).toBe(200);
    // Второй запрос видит durable-захват (refund_pending) → 409 без вызова банка.
    expect(r2.code).toBe(409);
    expect(r2.body.code).toBe('REFUND_REVIEW_REQUIRED');
    expect(balanceOf(c.id)).toBe(0);
    expect(ledgerRows(c.id, 'payment_reversal').length).toBe(1);
    expect(orderRow('d03_race').status).toBe('refunded');
    // Ключ события сохранён.
    expect(db.prepare("SELECT * FROM finance_idempotency WHERE event_key='refund:d03_race'").get()).toBeTruthy();
  });

  it('неизвестный исход у банка: refund_pending сохраняется, слепой повтор запрещён, webhook REFUNDED доводит сторно', async () => {
    const c = seedClient('d03_c2', 400);
    mkOrder('d03_unc', c.id, 400);
    db.prepare("UPDATE card_payments SET status='credited' WHERE order_id='d03_unc'").run();
    let providerCalls = 0;
    router.__provider = { async refund() { providerCalls++; throw new Error('network timeout'); } };
    const handler = refundHandler();
    const r1 = mockRes();
    await handler(mockReq('d03_unc'), r1);
    expect(r1.code).toBe(502);
    expect(r1.body.code).toBe('REFUND_UNCERTAIN');
    expect(orderRow('d03_unc').status).toBe('refund_pending');
    expect(balanceOf(c.id)).toBe(400);
    // Повтор НЕ вызывает банк.
    const r2 = mockRes();
    await handler(mockReq('d03_unc'), r2);
    expect(r2.code).toBe(409);
    expect(r2.body.code).toBe('REFUND_REVIEW_REQUIRED');
    expect(providerCalls).toBe(1);
    // Webhook REFUNDED подтверждает исход → refund_provider_ok → сторно.
    cardPaymentsRepo.refundProviderOk('d03_unc');
    await router.runRecovery();
    expect(orderRow('d03_unc').status).toBe('refunded');
    expect(balanceOf(c.id)).toBe(0);
    expect(ledgerRows(c.id, 'payment_reversal').length).toBe(1);
    expect(providerCalls).toBe(1);
  });

  it('крах после ответа банка до записи сторно: recovery завершает по refund_provider_ok без вызова банка', async () => {
    const c = seedClient('d03_c3', 250);
    mkOrder('d03_crash', c.id, 250);
    db.prepare("UPDATE card_payments SET status='credited' WHERE order_id='d03_crash'").run();
    cardPaymentsRepo.claimRefund('d03_crash', c.id, 250);   // захват + ключ
    cardPaymentsRepo.refundProviderOk('d03_crash');          // банк подтвердил, процесс умер
    let providerCalls = 0;
    router.__provider = { async refund() { providerCalls++; return { ok: true }; } };
    await router.runRecovery();
    expect(providerCalls).toBe(0);
    expect(orderRow('d03_crash').status).toBe('refunded');
    expect(balanceOf(c.id)).toBe(0);
    expect(ledgerRows(c.id, 'payment_reversal').length).toBe(1);
    // Повторный refund — идемпотентный already, деньги не двигаются.
    const handler = refundHandler();
    const r = mockRes();
    await handler(mockReq('d03_crash'), r);
    expect(r.body.already).toBe(true);
    expect(providerCalls).toBe(0);
    expect(balanceOf(c.id)).toBe(0);
  });

  it('точный отказ банка (definitive): захват отпущен, повторный refund проходит полный цикл', async () => {
    const c = seedClient('d03_c4', 100);
    mkOrder('d03_ref', c.id, 100);
    db.prepare("UPDATE card_payments SET status='credited' WHERE order_id='d03_ref'").run();
    let providerCalls = 0, failOnce = true;
    router.__provider = {
      async refund() {
        providerCalls++;
        if (failOnce) { const e = new Error('http 409'); e.definitive = true; throw e; }
        return { ok: true };
      },
    };
    const handler = refundHandler();
    const r1 = mockRes();
    await handler(mockReq('d03_ref'), r1);
    expect(r1.code).toBe(502);
    expect(r1.body.code).toBe('REFUND_REFUSED');
    expect(orderRow('d03_ref').status).toBe('credited');
    expect(balanceOf(c.id)).toBe(100);
    failOnce = false;
    const r2 = mockRes();
    await handler(mockReq('d03_ref'), r2);
    expect(r2.code).toBe(200);
    expect(providerCalls).toBe(2);
    expect(orderRow('d03_ref').status).toBe('refunded');
    expect(balanceOf(c.id)).toBe(0);
    expect(ledgerRows(c.id, 'payment_reversal').length).toBe(1);
  });
});
