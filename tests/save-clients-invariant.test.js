// Stage 13.2 invariant test.
//
// The TZ-stated invariant:
//   "Запись клиента не должна иметь возможности стереть платёж/документ,
//    которого нет в его in-memory копии, но который есть в БД."
//
// Pre-fix: saveClients() did paymentsDb.deleteByClient(id) + reinsert all
// of c.payments — a stale in-memory array (e.g. partial load, race with
// webhook insert) wiped real DB rows. Same shape for documents/closing/bills.
//
// Post-fix: saveClients is additive. The test below inserts a payment +
// document + closing doc + bill DIRECTLY into the DB (bypassing memory),
// then invokes saveClients with a client whose in-memory arrays do NOT
// contain those rows. All four must survive.

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);
let db, server, paymentsDb, documentsDb;

beforeAll(() => {
  const ctx = bootApp();
  db = ctx.db;
  server = cjsRequire('../server.js');
  paymentsDb = cjsRequire('../src/db/payments.js');
  documentsDb = cjsRequire('../src/db/documents.js');
});

function makeClientRow() {
  const id = 'inv-' + crypto.randomBytes(4).toString('hex');
  db.prepare(`INSERT INTO clients (id, login, name, balance, created_at)
              VALUES (?, ?, ?, 0, datetime('now'))`).run(id, 'inv_' + id, 'Inv ' + id);
  return id;
}

describe('Stage 13.2: saveClients is additive — DB rows survive stale in-memory state', () => {
  it('a payment present in DB but missing from c.payments is NOT deleted', () => {
    const cid = makeClientRow();

    // 1. Insert a payment DIRECTLY (no in-memory presence).
    paymentsDb.insert({
      clientId: cid, amount: 999, date: '2026-05-23', note: 'db-only',
      source: 'manual', paymentId: null, createdAt: '2026-05-23T10:00:00Z',
    });
    expect(paymentsDb.listByClient(cid).length).toBe(1);

    // 2. saveClients with a client whose in-memory payments array is empty.
    const stale = { id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0, payments: [] };
    server.saveClients([stale]);

    // 3. The pre-existing DB row MUST survive. (Pre-fix it was wiped.)
    const surviving = paymentsDb.listByClient(cid);
    expect(surviving.length).toBe(1);
    expect(surviving[0].amount).toBe(999);
    expect(surviving[0].note).toBe('db-only');
  });

  it('document/closing/bill rows present in DB but missing from in-memory arrays survive', () => {
    const cid = makeClientRow();
    const docId = 'd-' + crypto.randomBytes(4).toString('hex');
    const closingId = 'c-' + crypto.randomBytes(4).toString('hex');
    const billId = 'b-' + crypto.randomBytes(4).toString('hex');

    documentsDb.insertDoc({ id: docId, name: 'Inv', fileName: 'f.pdf', mimeType: '', date: '2026-05-23' }, cid);
    documentsDb.insertClosing({ id: closingId, period: '2026-04', actNumber: 'A1', items: [], totalAmount: 100, status: 'unsigned' }, cid);
    documentsDb.insertBill({ id: billId, period: '2026-05', billNumber: 'B1', amount: 200, status: 'unpaid' }, cid);

    expect(documentsDb.listDocs(cid).length).toBe(1);
    expect(documentsDb.listClosing(cid).length).toBe(1);
    expect(documentsDb.listBills(cid).length).toBe(1);

    // saveClients with an entirely empty stale snapshot.
    const stale = { id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0 };
    server.saveClients([stale]);

    // All three survive.
    expect(documentsDb.listDocs(cid).length).toBe(1);
    expect(documentsDb.listClosing(cid).length).toBe(1);
    expect(documentsDb.listBills(cid).length).toBe(1);
  });

  it('Stage 13.3: saveClients DOES NOT write to payments table anymore', () => {
    // billing_ledger is the source of truth for payment history; the
    // payments table is read-only (kept for legacy rows). saveClients
    // intentionally skips it.
    const cid = makeClientRow();
    const stale = {
      id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0,
      payments: [{ amount: 42, date: '2026-05-23', note: 'fresh', createdAt: '2026-05-23T11:00:00Z' }],
    };

    server.saveClients([stale]);
    server.saveClients([stale]);

    // No rows written, no matter how many times saveClients is called.
    expect(paymentsDb.listByClient(cid).length).toBe(0);
  });

  it('bill status changed in memory IS persisted by saveClients (upsert on status)', () => {
    // Contract: insertBill upserts ONLY the mutable `status` column on
    // conflict — a future code path that mutates bill.status in memory and
    // calls plain saveClients() must not silently lose the change.
    const cid = makeClientRow();
    const billId = 'b-' + crypto.randomBytes(4).toString('hex');
    const c = {
      id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0,
      bills: [{ id: billId, period: '2026-05', billNumber: 'B-UP', amount: 300, status: 'unpaid' }],
    };
    server.saveClients([c]);
    expect(documentsDb.listBills(cid)[0].status).toBe('unpaid');

    // Mutate ONLY the in-memory copy, no direct updateBillStatus call.
    c.bills[0].status = 'paid';
    server.saveClients([c]);

    const row = documentsDb.listBills(cid)[0];
    expect(row.status).toBe('paid');   // upsert persisted it
    expect(row.amount).toBe(300);      // immutable fields untouched
    expect(row.bill_number).toBe('B-UP');
  });
});
