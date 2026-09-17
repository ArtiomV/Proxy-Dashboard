'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const middleware = (req, res, next) => next();
const logger = { info: noop, warn: noop, error: noop };
function handler(router, url, method) { return router.stack.find(l => l.route && l.route.path === url && l.route.methods[method]).route.stack.at(-1).handle; }
function response() { return { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } }; }
async function main() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'proxy-audit-docs-'));
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
    db.pragma('foreign_keys = OFF');
    if (!db.pragma('table_info(bills)').some(c => c.name === 'formula')) db.exec("ALTER TABLE bills ADD COLUMN formula TEXT DEFAULT ''");
    const docs = require(path.join(ROOT, 'src/db/documents')); docs.init(db);
    const client = { id: 'a', login: 'alice', name: 'Alice', inn: 'demo', bills: [], documents: [] };
    const saveClients = clients => db.transaction(() => {
      for (const c of clients) for (const b of c.bills || []) docs.insertBill(b, c.id);
    })();
    const bankCalls = [];
    const file = path.join(ROOT, 'src/routes/tochka.js');
    const originalRequire = createRequire(file);
    const context = { module: { exports: {} }, require: p => {
      if (p === '../tochka/api') return { tochkaRequest: (config, method, url) => new Promise(resolve => bankCalls.push({ method, resolve })) };
      if (p === '../telegram/alerts') return { trigger: noop };
      return originalRequire(p);
    } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
    const router = context.module.exports({ logger, authMiddleware: middleware, adminMiddleware: middleware,
      clients: [client], clientById: new Map([['a', client]]), documentsDb: docs, saveClients,
      tochkaConfig: { jwt: 'demo', customerCode: 'demo', accountId: 'demo' }, auditLog: noop, getClientIp: () => 'test',
    });
    const create = handler(router, '/api/admin/tochka/create_bill', 'post');
    const req = () => ({ body: { clientId: 'a', amount: 100, period: '2026-09' } });
    const ra = response(), rb = response();
    const a = create(req(), ra), b = create(req(), rb);
    assert.equal(bankCalls.length, 2);
    bankCalls.forEach((call, i) => call.resolve({ status: 200, data: { Data: { documentId: 'bank-' + i } } }));
    await Promise.all([a, b]);
    assert.equal(client.bills.length, 2);
    assert.equal(docs.listBills('a').length, 1);
    assert.ok(ra.body.ok && rb.body.ok);
    const results = [{ finding: 'DEEP-54', bankCreates: 2, successResponses: 2, memoryBills: 2, sqliteBills: 1 }];

    const remove = handler(router, '/api/admin/clients/:id/bill/:billId', 'delete');
    const keptId = docs.listBills('a')[0].id;
    const rr = response();
    const deleting = remove({ user: { login: 'admin' }, params: { id: 'a', billId: keptId } }, rr);
    bankCalls.at(-1).resolve({ status: 500, data: { error: 'bank failure' } });
    await deleting;
    assert.equal(rr.body.ok, true);
    assert.ok(!docs.listBills('a').some(row => row.id === keptId));
    assert.equal(docs.listBills('a').length, 1);
    assert.equal(docs.listBills('a')[0].id, client.bills[0].id);
    results.push({ finding: 'DEEP-57/54', bankDeleteStatus: 500, responseOk: true, originalLocalBillDeleted: true,
      previouslyIgnoredBillPersistedAfterDeletion: true });

    const doc = { id: 'd1', fileName: 'd1.pdf', name: 'demo.pdf' };
    client.documents.push(doc); docs.insertDoc(doc, 'a');
    fs.writeFileSync(path.join(tmp, doc.fileName), 'local fixture');
    db.exec("CREATE TRIGGER deny_document_delete BEFORE DELETE ON client_documents BEGIN SELECT RAISE(ABORT, 'injected document delete failure'); END;");
    const clientRouter = require(path.join(ROOT, 'src/routes/clients'))({
      logger, authMiddleware: middleware, adminMiddleware: middleware, validate: () => middleware,
      clients: [client], clientById: new Map([['a', client]]), documentsDb: docs, DOCUMENTS_DIR: tmp, saveClients,
    });
    assert.throws(() => handler(clientRouter, '/api/admin/clients/:id/document/:docId', 'delete')({ params: { id: 'a', docId: 'd1' } }, response()), /injected/);
    assert.equal(fs.existsSync(path.join(tmp, doc.fileName)), false);
    assert.equal(docs.listDocs('a').length, 1);
    results.push({ finding: 'DEEP-56', sqliteDeleteRejected: true, fileExists: false, metadataStillExists: true });
    console.log(JSON.stringify({ isolation: 'real handlers, SQLite repositories, temporary files; bank stubbed', results }, null, 2));
  } finally { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
