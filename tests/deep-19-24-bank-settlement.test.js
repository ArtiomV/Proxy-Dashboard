// 2026-09-18 · Регрессии DEEP-19 и DEEP-24 (FIX-SPEC §): единая bank-event
// settlement и сверка по идентификатору события. Настоящие SQLite repositories
// (bank_payments, billing_ledger, finance_idempotency на общей тестовой БД);
// заглушается только банк (tochkaRequest), НЕ идемпотентность.
// На коде до исправления каждый тест падал:
//   DEEP-19: повтор ручной привязки давал вторую строку ledger и второе
//            зачисление; matched записывался отдельно от кредита; другой
//            получатель молча переприсваивал событие.
//   DEEP-24: recovery сверял «клиент+сумма+дата» — второй такой же платёж
//            помечался matched БЕЗ зачисления; платёж без id события
//            помечался оплаченным без доказательства.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp, asAdmin } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);

let app, db, adminToken, createSync, atomic, payerMatch;
const TAG = 'd1924';
const cleanup = { clients: [], bankPayments: [], ledgerClients: [] };

beforeAll(() => {
  const ctx = bootApp();
  app = ctx.app;
  db = ctx.db;
  adminToken = asAdmin();
  createSync = cjsRequire('../src/jobs/tochka-sync.js').create;
  atomic = cjsRequire('../src/billing/atomic.js');
  payerMatch = cjsRequire('../src/billing/payer-match.js');
});

afterAll(() => {
  for (const id of cleanup.bankPayments) {
    db.prepare('DELETE FROM bank_payments WHERE id = ?').run(id);
  }
  for (const id of cleanup.clients) {
    db.prepare('DELETE FROM billing_ledger WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM finance_idempotency WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  }
});

function makeUnverifiedJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return [b64({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' }), b64(payload), 'bogus'].join('.');
}

async function seedClient(tag, balance = 0) {
  const create = await request(app).post('/api/admin/clients').set('X-Auth-Token', adminToken).send({
    name: 'DEEP ' + tag, login: `${TAG}_${tag}`, password: 'longpass', portName: `${TAG}p_${tag}`,
  });
  expect(create.status).toBe(200);
  const id = create.body.client.id;
  db.prepare('UPDATE clients SET balance = ? WHERE id = ?').run(balance, id);
  cleanup.clients.push(id);
  return id;
}
function balanceOf(id) { return db.prepare('SELECT balance FROM clients WHERE id = ?').get(id).balance; }
function ledgerOf(id, type) {
  return db.prepare('SELECT * FROM billing_ledger WHERE client_id = ? AND type = ? ORDER BY id').all(id, type);
}

// ── DEEP-19 ─────────────────────────────────────────────────────────────────
describe('DEEP-19: повтор ручной привязки банка идемпотентен', () => {
  async function seedUnmatchedPayment(tag, amount) {
    const tochkaPid = `tp-${tag}-` + crypto.randomBytes(3).toString('hex');
    const jwt = makeUnverifiedJwt({
      webhookType: 'incomingPayment', paymentId: tochkaPid, amount,
      date: '2026-09-17', purpose: `test:${TAG}-${tag}`,
      SidePayer: { inn: '9812345678', name: 'DEEP19 PAYER' },
    });
    await request(app).post('/api/tochka/webhook').set('Content-Type', 'application/jwt').send(jwt);
    const row = db.prepare('SELECT id FROM bank_payments WHERE payment_id = ?').get(tochkaPid);
    cleanup.bankPayments.push(row.id);
    return row.id;
  }

  it('два вызова match_payment с одним paymentId — одно зачисление, повтор возвращает already', async () => {
    const clientId = await seedClient('rep1');
    const bankPaymentId = await seedUnmatchedPayment('rep1', 500);

    const r1 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);

    const r2 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId });
    expect(r2.status).toBe(200);
    expect(r2.body.already).toBe(true);          // исходный результат, НЕ новый кредит

    expect(balanceOf(clientId)).toBe(500);       // на старом коде: 1000
    expect(ledgerOf(clientId, 'bank_payment').length).toBe(1);
    // matched записан той же операцией
    const bp = db.prepare('SELECT matched, matched_client_id FROM bank_payments WHERE id = ?').get(bankPaymentId);
    expect(bp.matched).toBe(1);
    expect(bp.matched_client_id).toBe(clientId);
    // durable-ключ события
    expect(db.prepare("SELECT * FROM finance_idempotency WHERE event_key = ?").get('bank_match:' + bankPaymentId)).toBeTruthy();
  });

  it('привязка того же события другому клиенту — 409 конфликт, деньги не двигаются', async () => {
    const c1 = await seedClient('cfx1');
    const c2 = await seedClient('cfx2');
    const bankPaymentId = await seedUnmatchedPayment('cfx', 700);

    const r1 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId: c1 });
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId: c2 });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('MATCH_CONFLICT');

    expect(balanceOf(c1)).toBe(700);
    expect(balanceOf(c2)).toBe(0);
    expect(ledgerOf(c2, 'bank_payment').length).toBe(0);
  });

  it('ручная привязка платит рефереру один раз (parity с sync/webhook)', async () => {
    // реферер + реферал через API; referred_by проставляем напрямую
    const referrerId = await seedClient('ref1');
    const referredId = await seedClient('rfd1');
    db.prepare('UPDATE clients SET referred_by = ? WHERE id = ?').run(referrerId, referredId);
    const { state } = cjsRequire('../src/state/index.js');
    const mem = state.clients.find(c => c.id === referredId);
    if (mem) mem.referred_by = referrerId;

    const bankPaymentId = await seedUnmatchedPayment('ref', 1000);
    const r1 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId: referredId });
    expect(r1.status).toBe(200);
    expect(db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(referrerId).referral_balance).toBe(150);

    const r2 = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: bankPaymentId, clientId: referredId });
    expect(r2.body.already).toBe(true);
    // комиссия НЕ удвоена
    expect(db.prepare('SELECT referral_balance FROM clients WHERE id = ?').get(referrerId).referral_balance).toBe(150);
  });

  it('matched без ledger-доказательства (legacy) — reconciliation_required, не повторный кредит', async () => {
    const clientId = await seedClient('leg1');
    // legacy-строка: matched=1, но зачисления в ledger никогда не было
    // (крах старого кода между credit и match-mark / ручная правка).
    const rowId = 'bp_' + TAG + '_legacy';
    db.prepare(`INSERT INTO bank_payments
      (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date,
       matched, matched_client_id, matched_client_name, auto_credit, dismissed, received_at, natural_key)
      VALUES (?, 'incomingPayment', '9812345678', 'LEGACY', 300, 'test:${TAG}-leg', '', '2026-09-10', 1, ?, 'LEGACY', 0, 0, datetime('now'), ?)`)
      .run(rowId, clientId, '9812345678|300|2026-09-10|test:' + TAG + '-leg');
    cleanup.bankPayments.push(rowId);

    const r = await request(app).post('/api/admin/tochka/match_payment')
      .set('X-Auth-Token', adminToken).send({ paymentId: rowId, clientId });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BANK_RECONCILIATION_REQUIRED');
    expect(balanceOf(clientId)).toBe(0);   // вслепую НЕ зачислили
    expect(db.prepare('SELECT reconciliation_required FROM bank_payments WHERE id = ?').get(rowId).reconciliation_required).toBe(1);
  });
});

// ── DEEP-24 ─────────────────────────────────────────────────────────────────
// Харнес runTochkaSync с заглушенным банком — паттерн tochka-sync-referral.
function tx({ inn, amount, purpose, transactionId, date = '2026-09-16' }) {
  return {
    creditDebitIndicator: 'Credit',
    Amount: { amount: String(amount) },
    DebtorParty: { inn, name: 'Payer ' + inn },
    description: purpose,
    transactionId,
    documentProcessDate: date,
  };
}
function insertBpRow(row) {
  db.prepare(`INSERT INTO bank_payments
    (id, webhook_type, payer_inn, payer_name, amount, purpose, payment_id, date,
     customer_code, matched, matched_client_id, matched_client_name, auto_credit,
     dismissed, source, tochka_payment_id, received_at, natural_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, 'incomingPayment', row.payer_inn, 'Payer', row.amount, row.purpose,
      row.payment_id || '', row.date, '', row.matched ? 1 : 0, row.matched_client_id || null,
      row.matched_client_name || null, row.matched ? 1 : 0, 0, row.source || '',
      row.tochka_payment_id || '', new Date().toISOString(), row.natural_key);
  cleanup.bankPayments.push(row.id);
}
function makeSync(transactions, { clientsArr, clientByInn }) {
  const dbStmts = {
    findBankPaymentsByNaturalKeyBase: db.prepare(
      'SELECT id, payment_id, tochka_payment_id, natural_key, matched, dismissed, reconciliation_required FROM bank_payments ' +
      'WHERE natural_key = ? OR substr(natural_key, 1, ?) = ? ORDER BY received_at, id'),
    ledgerHasBankPaymentEvent: db.prepare(
      "SELECT 1 FROM billing_ledger WHERE client_id = ? AND type = 'bank_payment' AND payment_id = ? LIMIT 1"),
    markBankPaymentReconciliation: db.prepare(
      'UPDATE bank_payments SET reconciliation_required = 1 WHERE id = ?'),
    findBankPaymentByTochkaId: db.prepare('SELECT id FROM bank_payments WHERE tochka_payment_id = ? LIMIT 1'),
    findBankPaymentByPaymentIdAny: db.prepare('SELECT id FROM bank_payments WHERE payment_id = ? LIMIT 1'),
    updateBankPaymentMatch: db.prepare(
      'UPDATE bank_payments SET matched = ?, matched_client_id = ?, matched_client_name = ?, auto_credit = ? WHERE id = ?'),
    linkBankPaymentTochkaId: db.prepare(
      "UPDATE bank_payments SET tochka_payment_id = ? WHERE id = ? AND (tochka_payment_id IS NULL OR tochka_payment_id = '')"),
  };
  const insertBankPaymentToDb = (bp) => {
    if (bp.paymentId && dbStmts.findBankPaymentByPaymentIdAny.get(bp.paymentId)) return false;
    insertBpRow({
      id: bp.id, payer_inn: bp.payerInn, amount: bp.amount, purpose: bp.purpose,
      payment_id: bp.paymentId, date: bp.date, matched: bp.matched,
      matched_client_id: bp.matchedClientId, matched_client_name: bp.matchedClientName,
      source: bp.source, tochka_payment_id: bp.tochkaPaymentId, natural_key: bp.naturalKey,
    });
    return true;
  };
  const tochkaRequest = async (method) => {
    if (method === 'POST') return { data: { Data: { Statement: { statementId: 'st-deep24' } } } };
    return { data: { Data: { Statement: [{ status: 'Ready', Transaction: transactions }] } } };
  };
  const logger = { info() {}, warn() {}, error() {} };
  return createSync({
    tochkaConfig: { jwt: 'x', accountId: 'acc-deep24' },
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

describe('DEEP-24: bank recovery не склеивает два разных платежа одной суммы', () => {
  it('второй такой же перевод зачисляется как отдельное событие (webhook + statement)', async () => {
    const inn = '6099000001';
    const client = { id: 'c-' + crypto.randomBytes(4).toString('hex'), name: 'DEEP24 ' + inn, inn, balance: 0, referral_balance: 0 };
    db.prepare('INSERT INTO clients (id, login, name, inn, balance, referral_balance) VALUES (?, ?, ?, ?, 0, 0)')
      .run(client.id, client.id, client.name, inn);
    cleanup.clients.push(client.id);
    const purpose = 'Оплата по счёту 42';
    const base = payerMatch.buildNaturalKey(inn, 5000, '2026-09-16', purpose);

    // Платёж 1 — доставлен webhook'ом и УЖЕ зачислен (ledger payment_id = tb-1).
    atomic.atomicCredit(client.id, 5000, {
      type: 'bank_payment', date: '2026-09-16', timestamp: new Date().toISOString(),
      amount: 5000, currency: 'RUB', note: 'webhook credit', source: 'tochka_webhook', paymentId: 'tb-deep24-1',
    });
    insertBpRow({ id: 'bp-deep24-1', payer_inn: inn, amount: 5000, purpose, payment_id: 'tb-deep24-1',
      date: '2026-09-16', matched: true, matched_client_id: client.id, natural_key: base });
    // Платёж 2 — webhook не верифицирован: строка сохранена БЕЗ зачисления.
    insertBpRow({ id: 'bp-deep24-2', payer_inn: inn, amount: 5000, purpose, payment_id: 'tb-deep24-2',
      date: '2026-09-16', matched: false, natural_key: base + '#2' });

    // Statement видит ОБА перевода (sync-идентификаторы другие, как у Точки).
    const run = makeSync([
      tx({ inn, amount: 5000, purpose, transactionId: 'cbs-deep24-1' }),
      tx({ inn, amount: 5000, purpose, transactionId: 'cbs-deep24-2' }),
    ], { clientsArr: [client], clientByInn: new Map([[inn, client]]) });

    const res = await run({ dateFrom: '2026-09-16', dateTo: '2026-09-16', source: 'test' });
    expect(res.ok).toBe(true);
    // На старом коде второй платёж склеивался с первым по «сумма+дата» и
    // помечался matched БЕЗ зачисления: баланс оставался 5000.
    expect(balanceOf(client.id)).toBe(10000);
    expect(ledgerOf(client.id, 'bank_payment').length).toBe(2);
    const row2 = db.prepare('SELECT matched, matched_client_id, reconciliation_required FROM bank_payments WHERE id = ?').get('bp-deep24-2');
    expect(row2.matched).toBe(1);
    expect(row2.reconciliation_required || 0).toBe(0);
    // Повторный sync — без двойного зачисления.
    await run({ dateFrom: '2026-09-16', dateTo: '2026-09-16', source: 'test' });
    expect(balanceOf(client.id)).toBe(10000);
    expect(ledgerOf(client.id, 'bank_payment').length).toBe(2);
  });

  it('legacy-строка без идентификатора события — reconciliation_required, НЕ matched', async () => {
    const inn = '6099000002';
    const client = { id: 'c-' + crypto.randomBytes(4).toString('hex'), name: 'DEEP24 ' + inn, inn, balance: 0, referral_balance: 0 };
    db.prepare('INSERT INTO clients (id, login, name, inn, balance, referral_balance) VALUES (?, ?, ?, ?, 0, 0)')
      .run(client.id, client.id, client.name, inn);
    cleanup.clients.push(client.id);
    const purpose = 'Платёж без id ' + TAG;
    const base = payerMatch.buildNaturalKey(inn, 2500, '2026-09-16', purpose);
    // Строка вообще без id события (ни payment_id, ни tochka_payment_id).
    insertBpRow({ id: 'bp-deep24-noid', payer_inn: inn, amount: 2500, purpose, payment_id: '',
      date: '2026-09-16', matched: false, natural_key: base });

    const run = makeSync([
      tx({ inn, amount: 2500, purpose, transactionId: '' }),   // и в выписке id пуст
    ], { clientsArr: [client], clientByInn: new Map([[inn, client]]) });

    const res = await run({ dateFrom: '2026-09-16', dateTo: '2026-09-16', source: 'test' });
    expect(res.ok).toBe(true);
    const row = db.prepare('SELECT matched, reconciliation_required FROM bank_payments WHERE id = ?').get('bp-deep24-noid');
    // Неоднозначность — НЕ доказательство оплаты: ручная сверка, не matched.
    expect(row.matched).toBe(0);
    expect(row.reconciliation_required).toBe(1);
    expect(balanceOf(client.id)).toBe(0);
  });
});
