// A1/Р22 + A3: Tochka statement sync — referral commission and natural-key
// sequence anti-collision.
//
// The sync job is tested through its factory with mocked Tochka API
// (tochkaRequest) against the real booted DB and the real, server-initialized
// atomic.js — so the credit path (balance + ledger + referral in one txn)
// is the production one, not a reimplementation.
//
// Coverage:
//   • sync auto-credit pays the referrer 10% (Р22: sync used to skip referral)
//   • two identical payments in one statement → BOTH credited (A3 sequence)
//   • re-sync of the same statement → no double credit (idempotency)
//   • empty transactionId re-pull → conservative dedup (no re-credit)

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);

let db, createSync, atomic, payerMatch;

beforeAll(() => {
  db = bootApp().db;
  createSync = cjsRequire('../src/jobs/tochka-sync.js').create;
  atomic = cjsRequire('../src/billing/atomic.js');      // initialized by server boot
  payerMatch = cjsRequire('../src/billing/payer-match.js');
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function seedPair(inn) {
  const referrer = {
    id: 'ref-' + crypto.randomBytes(4).toString('hex'),
    name: 'Referrer ' + inn, inn: '', referred_by: null, balance: 0, referral_balance: 0,
  };
  const referred = {
    id: 'rfd-' + crypto.randomBytes(4).toString('hex'),
    name: 'Referred ' + inn, inn, referred_by: referrer.id, balance: 0, referral_balance: 0,
  };
  db.prepare("INSERT INTO clients (id, login, name, inn, balance, referral_balance) VALUES (?, ?, ?, ?, 0, 0)")
    .run(referrer.id, referrer.id, referrer.name, '');
  db.prepare("INSERT INTO clients (id, login, name, inn, balance, referral_balance, referred_by) VALUES (?, ?, ?, ?, 0, 0, ?)")
    .run(referred.id, referred.id, referred.name, inn, referrer.id);
  return { referrer, referred };
}

function dbBalance(id) {
  return db.prepare('SELECT balance FROM clients WHERE id = ?').get(id).balance;
}
function dbReferral(id) {
  return db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(id).referral_balance;
}
function ledgerRows(id) {
  return db.prepare("SELECT type, amount FROM billing_ledger WHERE client_id = ? ORDER BY id").all(id);
}

function tx({ inn, amount, purpose, transactionId, date = '2026-06-01' }) {
  return {
    creditDebitIndicator: 'Credit',
    Amount: { amount: String(amount) },
    DebtorParty: { inn, name: 'Payer ' + inn },
    description: purpose,
    transactionId,
    documentProcessDate: date,
  };
}

// Builds runTochkaSync with mocked Tochka API returning the given transactions.
function makeSync(transactions, { clientsArr, clientByInn }) {
  const dbStmts = {
    findBankPaymentsByNaturalKeyBase: db.prepare(
      'SELECT id, payment_id, tochka_payment_id, natural_key, matched, dismissed FROM bank_payments ' +
      'WHERE natural_key = ? OR substr(natural_key, 1, ?) = ? ORDER BY id'),
    ledgerHasBankPaymentOn: db.prepare(
      "SELECT 1 FROM billing_ledger WHERE client_id = ? AND type = 'bank_payment' AND ABS(amount - ?) < 0.01 AND date = ? LIMIT 1"),
    findBankPaymentByTochkaId: db.prepare('SELECT id FROM bank_payments WHERE tochka_payment_id = ? LIMIT 1'),
    findBankPaymentByPaymentIdAny: db.prepare('SELECT id FROM bank_payments WHERE payment_id = ? LIMIT 1'),
    updateBankPaymentMatch: db.prepare(
      'UPDATE bank_payments SET matched = ?, matched_client_id = ?, matched_client_name = ?, auto_credit = ? WHERE id = ?'),
  };
  const insertBankPaymentToDb = (bp) => {
    if (bp.paymentId && dbStmts.findBankPaymentByPaymentIdAny.get(bp.paymentId)) return false;
    db.prepare(`INSERT INTO bank_payments
      (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date,
       customer_code, matched, matched_client_id, matched_client_name, auto_credit,
       dismissed, source, tochka_payment_id, received_at, natural_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bp.id, bp.webhookType || '', bp.payerInn || '', bp.payerName || '',
        bp.amount || 0, bp.purpose || '', bp.paymentId || '', bp.date || '',
        bp.customerCode || '', bp.matched ? 1 : 0, bp.matchedClientId || null,
        bp.matchedClientName || null, bp.autoCredit ? 1 : 0,
        bp.dismissed ? 1 : 0, bp.source || '', bp.tochkaPaymentId || '',
        bp.receivedAt || new Date().toISOString(), bp.naturalKey || null);
    return true;
  };
  const tochkaRequest = async (method) => {
    if (method === 'POST') return { data: { Data: { Statement: { statementId: 'st-test' } } } };
    return { data: { Data: { Statement: [{ status: 'Ready', Transaction: transactions }] } } };
  };
  const logger = { info() {}, warn() {}, error() {} };
  return createSync({
    tochkaConfig: { jwt: 'x', accountId: 'acc-test' },
    logger, tochkaRequest,
    buildNaturalKey: payerMatch.buildNaturalKey,
    resolveNaturalKey: payerMatch.resolveNaturalKey,
    dbStmts,
    findClientByPayer: payerMatch.findClientByPayer,
    clientByInn,
    clients: clientsArr,
    atomicCredit: atomic.atomicCredit,
    settleBillsOnPayment() {},
    documentsDb: {},
    logActivity() {},
    saveClients() {},
    alerts: { trigger() {} },
    insertBankPaymentToDb,
    _resetTochkaFailStreak() {},
  }).runTochkaSync;
}

function ctxFor(pair) {
  const clientsArr = [pair.referrer, pair.referred];
  const clientByInn = new Map([[pair.referred.inn, pair.referred]]);
  return { clientsArr, clientByInn };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('A1/Р22: referral commission in the Tochka sync path', () => {
  it('auto-credit by INN pays the referrer 10% inside atomicCredit', async () => {
    const pair = seedPair('6000000001');
    const run = makeSync([
      tx({ inn: '6000000001', amount: 10000, purpose: 'Оплата по договору', transactionId: 'cbs-t1' }),
    ], ctxFor(pair));

    const res = await run({ dateFrom: '2026-06-01', dateTo: '2026-06-01', source: 'test' });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(1);

    expect(dbBalance(pair.referred.id)).toBe(10000);
    // 10% of 10000 — before the fix the sync credited 0 referral.
    expect(dbReferral(pair.referrer.id)).toBe(1000);
    expect(ledgerRows(pair.referred.id).filter(e => e.type === 'bank_payment').length).toBe(1);
  }, 15000);
});

describe('A3: natural-key sequence anti-collision in sync', () => {
  it('two identical payments in one statement are BOTH credited; re-sync dedups', async () => {
    const pair = seedPair('6000000002');
    const transactions = [
      tx({ inn: '6000000002', amount: 5000, purpose: 'Оплата по счёту 7', transactionId: 'cbs-a1' }),
      tx({ inn: '6000000002', amount: 5000, purpose: 'Оплата по счёту 7', transactionId: 'cbs-a2' }),
    ];
    const run = makeSync(transactions, ctxFor(pair));

    const res = await run({ dateFrom: '2026-06-01', dateTo: '2026-06-01', source: 'test' });
    expect(res.ok).toBe(true);
    // Both real payments credited — the old natural_key gate swallowed the second.
    expect(dbBalance(pair.referred.id)).toBe(10000);
    expect(dbReferral(pair.referrer.id)).toBe(1000);   // 10% of each 5000
    // ORDER BY rowid, не id: id — текстовый 'bp_<ms>_<random>', и при вставке
    // обеих строк в одну миллисекунду порядок решал случайный суффикс —
    // флейк в CI (keys[1] оказывался базовым ключом вместо '#2').
    const keys = db.prepare("SELECT natural_key FROM bank_payments WHERE payer_inn = '6000000002' ORDER BY rowid")
      .all().map(r => r.natural_key);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(/#2$/.test(keys[1])).toBe(true);

    // Re-sync of the SAME statement: both transactionIds recognised → no double credit.
    const res2 = await run({ dateFrom: '2026-06-01', dateTo: '2026-06-01', source: 'test' });
    expect(res2.ok).toBe(true);
    expect(res2.matched).toBe(0);
    expect(dbBalance(pair.referred.id)).toBe(10000);
    expect(dbReferral(pair.referrer.id)).toBe(1000);
    expect(ledgerRows(pair.referred.id).filter(e => e.type === 'bank_payment').length).toBe(2);
  }, 20000);

  it('empty transactionId re-pull is conservatively deduped (never re-credits)', async () => {
    const pair = seedPair('6000000003');
    const transactions = [
      tx({ inn: '6000000003', amount: 7000, purpose: 'Без id', transactionId: '' }),
    ];
    const run = makeSync(transactions, ctxFor(pair));

    await run({ dateFrom: '2026-06-01', dateTo: '2026-06-01', source: 'test' });
    expect(dbBalance(pair.referred.id)).toBe(7000);

    // Same transaction re-pulled with an empty id: can't tell it apart from a
    // real second payment → skip (the Stage 18.6 double-credit hole stays shut).
    await run({ dateFrom: '2026-06-01', dateTo: '2026-06-01', source: 'test' });
    expect(dbBalance(pair.referred.id)).toBe(7000);
    expect(ledgerRows(pair.referred.id).filter(e => e.type === 'bank_payment').length).toBe(1);
  }, 20000);
});
