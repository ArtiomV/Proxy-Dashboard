'use strict';
// Isolated audit probes: no production DB, sockets, bank calls or server startup.
// These assertions confirm CURRENT defects, not desired regression behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const Database = require('better-sqlite3');
const noop = () => {};
const middleware = (req, res, next) => next();
const logger = { info: noop, warn: noop, error: noop, debug: noop };
const results = [];
function handler(router, url, method) {
  return router.stack.find(l => l.route && l.route.path === url && l.route.methods[method]).route.stack.at(-1).handle;
}
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }

async function main() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE clients(id TEXT PRIMARY KEY, balance REAL);
    CREATE TABLE billing_ledger(id INTEGER PRIMARY KEY, client_id TEXT, type TEXT, date TEXT,
    timestamp TEXT, amount REAL, currency TEXT, balance_before REAL, balance_after REAL,
    delta_gb REAL, modem_count INTEGER, days_in_month INTEGER, note TEXT, source TEXT,
    payment_id TEXT, details TEXT);
    INSERT INTO clients VALUES ('a',1000);`);
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations/025_ledger_unique_all.sql'), 'utf8'));
  // Execute the actual serializer without loading server.js and its startup jobs.
  const serverText = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const serializer = serverText.slice(serverText.indexOf('function _ledgerEntryParams('), serverText.indexOf('\nfunction auditLog('));
  const params = vm.runInNewContext('(' + serializer.trim() + ')');
  const client = { id: 'a', name: 'A', login: 'a', balance: 1000, bills: [] };
  const atomic = require(path.join(ROOT, 'src/billing/atomic'));
  atomic.init({ db, getClientById: id => id === 'a' ? client : undefined,
    _clientGetBalance: db.prepare('SELECT balance FROM clients WHERE id=?'),
    _clientUpdateBalance: db.prepare('UPDATE clients SET balance=? WHERE id=?'),
    _ledgerInsert: db.prepare('INSERT INTO billing_ledger(client_id,type,date,timestamp,amount,currency,balance_before,balance_after,delta_gb,modem_count,days_in_month,note,source,payment_id,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    _ledgerEntryParams: params });
  const entry = { date: '2026-09-12', type: 'charge', note: 'first_day' };
  atomic.atomicDebit('a', 100, entry);
  const second = atomic.atomicDebit('a', 100, entry);
  const chargeRow = db.prepare('SELECT amount,balance_before,balance_after FROM billing_ledger').get();
  assert.equal(second.duplicate, true);
  assert.equal(client.balance, 900);
  assert.equal(chargeRow.amount, 0);
  results.push({ finding: 'DEEP-20/21', secondPurchaseDuplicate: second.duplicate, balance: client.balance, chargeRow });

  const bank = { id: 'bp1', paymentId: 'bank-event-1', amount: 50, date: '2026-09-12', matched: 1, payerInn: 'demo', purpose: 'demo' };
  const bankRouter = require(path.join(ROOT, 'src/routes/tochka'))({
    authMiddleware: middleware, adminMiddleware: middleware, logger,
    clients: [client], clientById: new Map([['a', client]]), bankPaymentFromRow: x => x,
    dbStmts: { getBankPaymentById: { get: () => bank }, updateBankPaymentMatch: { run: noop } },
    atomicCredit: atomic.atomicCredit, saveClients: noop, logActivity: noop,
  });
  const match = handler(bankRouter, '/api/admin/tochka/match_payment', 'post');
  match({ body: { paymentId: 'bp1', clientId: 'a' } }, response());
  match({ body: { paymentId: 'bp1', clientId: 'a' } }, response());
  const bankEntries = db.prepare("SELECT COUNT(*) n FROM billing_ledger WHERE type='bank_payment'").get().n;
  assert.equal(bankEntries, 2);
  results.push({ finding: 'DEEP-19', bankEntriesForSamePayment: bankEntries, balance: client.balance });
  db.close();

  const clients = ['a', 'b', 'c'].map(id => ({ id, login: id, portName: id }));
  const pending = [];
  const deleted = [];
  const router = require(path.join(ROOT, 'src/routes/clients'))({
    clients, clientById: new Map(clients.map(c => [c.id, c])), users: {}, logger,
    authMiddleware: middleware, adminMiddleware: middleware, validate: () => middleware,
    fetchAllServersDataCached: () => new Promise(resolve => pending.push(resolve)),
    saveClients: noop, rebuildClientMaps: noop, deleteSessionsByLogin: noop,
    auditLog: (actor, action, data) => deleted.push(data.clientId), getClientIp: () => 'test',
  });
  const remove = handler(router, '/api/admin/clients/:id', 'delete');
  const firstDelete = remove({ params: { id: 'a' }, user: { login: 'admin' } }, response());
  const secondDelete = remove({ params: { id: 'b' }, user: { login: 'admin' } }, response());
  pending[0]([]); await firstDelete;
  pending[1]([]); await secondDelete;
  assert.deepEqual(deleted, ['a', 'c']);
  results.push({ finding: 'DEEP-26', requestedDelete: ['a', 'b'], actualDelete: deleted, remaining: clients.map(c => c.id) });

  // Deterministic timer schedule, no sleeps or network sockets.
  let now = 10000;
  const timers = [];
  const context = { module: { exports: {} }, Date: { now: () => now },
    setTimeout: fn => { timers.push(fn); return { unref: noop }; }, clearTimeout: noop,
    setInterval: () => ({ unref: noop }), clearInterval: noop };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/events.js'), 'utf8'), context);
  const events = context.module.exports.create({ throttleMs: 2000 });
  const writes = [];
  events.subscribe({ write: s => { writes.push(s); return true; }, on: noop, end: noop }, 'session');
  events.publish('status', { version: 1 });
  now = 11000; events.publish('status', { version: 2 });
  now = 12001; events.publish('status', { version: 3 });
  now = 14002; timers.shift()();
  const versions = writes.map(s => JSON.parse(s.split('data: ')[1]).version);
  assert.deepEqual(versions, [1, 3, 2]);
  events.closeAll();
  results.push({ finding: 'DEEP-30', deliveredVersions: versions });

  const probes = [];
  const httpJob = require(path.join(ROOT, 'src/jobs/http-check')).create({
    db: { prepare: () => ({ run: noop }) }, logger, alerts: { trigger: noop },
    getSetting: (key, fallback) => fallback,
    apiServers: [{ name: 'S4', url: 'http://test.invalid', publicIp: '127.0.0.1' }],
    fetchAllServersDataCached: async () => [{ serverName: 'S4',
      status: ['MD_03', 'MD_07'].map(NICK => ({ modem_details: { NICK, IMEI: 'cloned-imei' }, net_details: { IS_ONLINE: 'yes' } })),
      ports: { 'cloned-imei': [
        { portID: 'p1', HTTP_PORT: 10001, LOGIN: 'demo', PASSWORD: 'demo', portName: 'client1' },
        { portID: 'p2', HTTP_PORT: 10002, LOGIN: 'demo', PASSWORD: 'demo', portName: 'client2' },
      ] } }],
    fetchThroughProxy: async proxy => { probes.push(proxy.port); return { status: 302, body: '', totalMs: 1 }; },
  });
  const httpResult = await httpJob.runOnce();
  assert.deepEqual(probes, [10001, 10001]);
  assert.equal(httpResult.ok, 2);
  results.push({ finding: 'DEEP-33/34', probedPorts: probes, ignoredPort: 10002, redirectAccepted: httpResult.ok });

  const trafficDb = new Database(':memory:');
  trafficDb.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  trafficDb.exec('ALTER TABLE daily_traffic ADD COLUMN client_name TEXT DEFAULT ""');
  const traffic = require(path.join(ROOT, 'src/db/traffic'));
  traffic.init(trafficDb);
  trafficDb.prepare("INSERT INTO hourly_snapshots(port_id,day_in,month_in,last_updated_at) VALUES ('S1_p1',100,100,datetime('now','-5 hours'))").run();
  // Add a read-only cache accessor in the VM, leaving production sources intact.
  const hourlyContext = { module: { exports: {} }, require: spec => require(path.resolve(ROOT, 'src/traffic', spec)) };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/traffic/hourly.js'), 'utf8') + '\nmodule.exports.auditSnap = id => snapCache.get(id);', hourlyContext);
  const hourly = hourlyContext.module.exports;
  hourly.init({ db: trafficDb, logger, _snapGetAll: traffic.snapshotGetAllStmt(), _snapUpsert: traffic.snapshotUpsertStmt(),
    fetchAllServersDataCached: async () => [{ serverName: 'S1', bw: { p1: { bandwidth_bytes_day_in: 200, bandwidth_bytes_month_in: 200 } } }] });
  assert.ok(hourly.auditSnap('S1_p1').last_updated_at);
  await hourly.refreshSnapshotsOnly();
  assert.equal(hourly.auditSnap('S1_p1').last_updated_at, undefined);
  assert.ok(trafficDb.prepare("SELECT last_updated_at FROM hourly_snapshots WHERE port_id='S1_p1'").get().last_updated_at);
  results.push({ finding: 'DEEP-28', cacheLostTimestamp: true, sqliteHasTimestamp: true });
  const upsert = traffic.hourlyUpsertStmt();
  upsert.run('S1', 'S1_p1', 'M1', 'demo', 'a', '2026-09-12 12:00', 100, 0, 0);
  upsert.run('S1', 'S1_p1', 'M1', 'demo', 'a', '2026-09-12 12:00', 200, 0, 0);
  const stored = trafficDb.prepare('SELECT bytes_in FROM traffic_hourly').get().bytes_in;
  assert.equal(stored, 100);
  results.push({ finding: 'DEEP-29', incrementalWrites: [100, 200], storedBytes: stored,
    scope: 'actual repository conflict behavior; full aggregator scheduling needs regression test' });
  trafficDb.close();
  console.log(JSON.stringify({ isolation: 'in-memory SQLite and local modules only', results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
