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

  it('a new in-memory payment without db_id is INSERTED and stamped with db_id', () => {
    const cid = makeClientRow();
    const stale = {
      id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0,
      payments: [{ amount: 42, date: '2026-05-23', note: 'fresh', createdAt: '2026-05-23T11:00:00Z' }],
    };
    expect(stale.payments[0].db_id).toBeUndefined();

    server.saveClients([stale]);

    // Row inserted AND the in-memory entry now carries its rowid back.
    const rows = paymentsDb.listByClient(cid);
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(42);
    expect(typeof stale.payments[0].db_id).toBe('number');
  });

  it('saveClients called twice does NOT double-insert (db_id stamping prevents it)', () => {
    const cid = makeClientRow();
    const stale = {
      id: cid, login: 'inv_' + cid, name: 'Inv', balance: 0,
      payments: [{ amount: 7, date: '2026-05-23', note: 'once', createdAt: '2026-05-23T12:00:00Z' }],
    };

    server.saveClients([stale]);
    server.saveClients([stale]);
    server.saveClients([stale]);

    // Still exactly one row — the db_id stamped on the first save tells
    // subsequent calls "this row is already in the DB, skip".
    expect(paymentsDb.listByClient(cid).length).toBe(1);
  });
});
