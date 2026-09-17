'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const middleware = (req, res, next) => next();
const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
if (!db.pragma('table_info(bills)').some(c => c.name === 'formula')) db.exec("ALTER TABLE bills ADD COLUMN formula TEXT DEFAULT ''");
const docs = require(path.join(ROOT, 'src/db/documents'));
docs.init(db);
// FK is disabled explicitly: these probes isolate the document repository.
db.pragma('foreign_keys = OFF');
const first = { id: 'b1', period: '2026-09', amount: 100, status: 'unpaid' };
const second = { ...first, id: 'b2' };
docs.insertBill(first, 'a');
const ignored = docs.insertBill(second, 'a');
assert.equal(ignored.changes, 0);
assert.equal(docs.listBills('a').length, 1);
const act = { id: 'act1', status: 'signed', signedAt: '2026-09-01T00:00:00Z', totalAmount: 100, items: [] };
const client = { id: 'a', closingDocuments: [act], bills: [first] };
const updates = [];
const router = require(path.join(ROOT, 'src/routes/tochka'))({
  authMiddleware: middleware, adminMiddleware: middleware,
  clientById: new Map([['a', client]]), auditLog: noop, getClientIp: () => 'test',
  documentsDb: { updateClosingItems: (...args) => updates.push(args), updateBillAmount: noop, insertBill: noop },
});
const h = router.stack.find(l => l.route && l.route.path === '/api/admin/clients/:id/closing_documents/:docId' && l.route.methods.put).route.stack.at(-1).handle;
const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } };
h({ user: { login: 'admin' }, params: { id: 'a', docId: 'act1' }, body: { items: [{ name: 'changed', quantity: 1, price: 200 }] } }, res);
assert.equal(act.status, 'signed');
assert.equal(act.totalAmount, 200);
assert.equal(updates.length, 1);
console.log(JSON.stringify({ isolation: 'SQLite in memory and local handler; no network', results: [
  { finding: 'DEEP-54', secondDocumentIgnored: ignored.changes === 0, durableDocuments: docs.listBills('a').length, scope: 'repository gate; concurrent bank route requires integration regression' },
  { finding: 'DEEP-55', changedSignedAct: res.body.ok, statusAfterEdit: act.status, totalAfterEdit: act.totalAmount },
] }, null, 2));
db.close();
