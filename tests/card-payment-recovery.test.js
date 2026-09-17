import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const createRouter = require('../src/routes/payments');
const Database = require('better-sqlite3');
const cardPaymentsRepo = require('../src/db/card-payments');

describe('card payment recovery', () => {
  it('retries paid rows and marks them credited after financial completion', async () => {
    const row = { order_id: 'o1', client_id: 'c1', amount: 500, method: 'card', status: 'paid' };
    const client = { id: 'c1', login: 'u1' };
    const markCredited = vi.fn(() => { row.status = 'credited'; });
    const atomicCredit = vi.fn((_id, _amount, _entry, opts) => {
      if (opts && opts.insideTx) opts.insideTx();
      return { balanceBefore: 0, balanceAfter: 500, duplicate: false };
    });
    const pass = (_req, _res, next) => next();
    const router = createRouter({
      logger: { info() {}, warn() {}, error() {} }, authMiddleware: pass, adminMiddleware: pass,
      validate: () => pass, TopupSchema: {}, topupLimiter: pass, webhookLimiter: pass,
      clients: [client], clientById: new Map([['c1', client]]), saveClients: vi.fn(),
      getSetting: (_k, d) => d, tariffsDb: {},
      cardPaymentsDb: { pendingPaid: () => [row], markCredited },
      ledgerDb: {}, promoDb: {}, atomicCredit, atomicDebit: vi.fn(),
      auditLog() {}, logActivity() {}, getClientIp: () => '', alerts: { trigger() {} },
      createProvider: () => null,
    });
    await expect(router.runRecovery()).resolves.toEqual({ credited: 1, failed: 0 });
    expect(atomicCredit).toHaveBeenCalledWith('c1', 500, expect.objectContaining({ paymentId: 'o1' }),
      expect.objectContaining({ idempotencyKey: 'card_payment:o1' }));
    expect(markCredited).toHaveBeenCalledWith('o1');
  });

  it('finishes an attached promo after it became inactive', async () => {
    const row = { order_id: 'o2', client_id: 'c1', amount: 200, method: 'card', status: 'paid', promo_code: 'OLD10' };
    const client = { id: 'c1', login: 'u1' };
    const atomicCredit = vi.fn((_id, amount, _entry, opts) => {
      if (opts && opts.insideTx) opts.insideTx();
      return { balanceBefore: 0, balanceAfter: amount, duplicate: false };
    });
    const consume = vi.fn(() => true);
    const pass = (_req, _res, next) => next();
    const router = createRouter({
      logger: { info() {}, warn() {}, error() {} }, authMiddleware: pass, adminMiddleware: pass,
      validate: () => pass, TopupSchema: {}, topupLimiter: pass, webhookLimiter: pass,
      clients: [client], clientById: new Map([['c1', client]]), saveClients: vi.fn(),
      getSetting: (_k, d) => d, tariffsDb: {},
      cardPaymentsDb: { pendingPaid: () => [row], markCredited: vi.fn() },
      ledgerDb: {}, promoDb: { byCode: () => ({ id: 7, code: 'OLD10', type: 'percent', value: 10, active: 0 }), consume },
      atomicCredit, atomicDebit: vi.fn(), auditLog() {}, logActivity() {}, getClientIp: () => '',
      alerts: { trigger() {} }, createProvider: () => null,
    });
    await expect(router.runRecovery()).resolves.toEqual({ credited: 1, failed: 0 });
    expect(atomicCredit).toHaveBeenCalledTimes(2);
    expect(atomicCredit.mock.calls[1][1]).toBe(20);
    expect(consume).toHaveBeenCalledWith(7);
    expect(atomicCredit.mock.calls[1][3]).toEqual(expect.objectContaining({ idempotencyKey: 'promo_bonus:o2' }));
  });

  // DEEP-01: next_recovery_at пишется в SQLite-формате с пробелом — иначе
  // сравнение с datetime('now') в pendingPaid ломалось на 'T' в тот же день.
  it('markRecoveryFailure stores a datetime comparable with datetime(\'now\')', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE card_payments (
      id INTEGER PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL,
      amount REAL NOT NULL, method TEXT, status TEXT NOT NULL DEFAULT 'created',
      provider_payment_id TEXT, raw_json TEXT, created_at TEXT, credited_at TEXT,
      promo_code TEXT, recovery_attempts INTEGER NOT NULL DEFAULT 0,
      next_recovery_at TEXT, recovery_error TEXT)`);
    cardPaymentsRepo.init(db);
    db.prepare("INSERT INTO card_payments (order_id, client_id, amount, status, created_at) " +
      "VALUES ('o9', 'c1', 100, 'paid', datetime('now'))").run();
    cardPaymentsRepo.markRecoveryFailure('o9', 'boom', Date.now());
    const row = db.prepare("SELECT * FROM card_payments WHERE order_id = 'o9'").get();
    expect(row.recovery_attempts).toBe(1);
    expect(row.recovery_error).toBe('boom');
    expect(row.next_recovery_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Просроченный ретрай выбирается тем же SELECT, что использует recovery job.
    db.prepare("UPDATE card_payments SET next_recovery_at = datetime('now', '-1 minute') WHERE order_id = 'o9'").run();
    expect(cardPaymentsRepo.pendingPaid(10).map(r => r.order_id)).toEqual(['o9']);
    // Будущий ретрай — нет.
    db.prepare("UPDATE card_payments SET next_recovery_at = datetime('now', '+1 hour') WHERE order_id = 'o9'").run();
    expect(cardPaymentsRepo.pendingPaid(10)).toEqual([]);
  });
});
