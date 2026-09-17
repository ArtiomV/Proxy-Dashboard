'use strict';
// Real Express dispatcher, no listen/socket. Observe rejection only in this process.
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const noop = () => {};
const middleware = (req, res, next) => next();
async function main() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE counters(n INTEGER); CREATE TRIGGER deny_counter BEFORE INSERT ON counters BEGIN SELECT RAISE(ABORT, 'injected sqlite failure'); END;");
  const router = require('../../src/routes/tochka')({
    authMiddleware: middleware, adminMiddleware: middleware,
    clientById: new Map([['a', { id: 'a', bills: [] }]]),
    documentsDb: { nextDocNumber: () => db.prepare('INSERT INTO counters VALUES(1)').run() },
  });
  const app = express();
  app.use(router);
  let errorMiddlewareReached = false, responseSent = false, finalCallbackReached = false;
  app.use((err, req, res, next) => { errorMiddlewareReached = true; res.status(500).json({ error: err.message }); });
  let listener;
  const rejected = new Promise(resolve => {
    listener = reason => resolve(reason);
    process.once('unhandledRejection', listener);
  });
  let timeout;
  try {
    const req = { method: 'POST', url: '/api/admin/tochka/create_bill', headers: {}, body: { clientId: 'a', amount: 100, period: '2026-09' } };
    const res = { setHeader: noop, getHeader: noop, status() { return this; }, json() { responseSent = true; }, end() { responseSent = true; } };
    app.handle(req, res, () => { finalCallbackReached = true; });
    const reason = await Promise.race([rejected, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('No rejection observed')), 1000); })]);
    assert.match(reason.message, /injected sqlite failure/);
    assert.equal(errorMiddlewareReached, false);
    assert.equal(responseSent, false);
    assert.equal(finalCallbackReached, false);
    console.log(JSON.stringify({ finding: 'DEEP-60', expressVersion: require('express/package.json').version,
      unhandledRejection: true, errorMiddlewareReached, responseSent, finalCallbackReached,
      isolation: 'real Express app.handle and SQLite; no network listener' }, null, 2));
  } finally { clearTimeout(timeout); process.removeListener('unhandledRejection', listener); db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
