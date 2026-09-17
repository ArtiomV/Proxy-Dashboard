'use strict';
// Audit probes assert current defects. No external requests or production DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const middleware = (req, res, next) => next();
const logger = { info: noop, warn: noop, error: noop };
const results = [];
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
function handler(router, url, method) { return router.stack.find(x => x.route && x.route.path === url && x.route.methods[method]).route.stack.at(-1).handle; }
async function main() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE traffic_hourly(nick TEXT, client_name TEXT); INSERT INTO traffic_hourly VALUES ('old-modem','alice');");
  const ownership = require(path.join(ROOT, 'src/modems/ownership'));
  const pastAccess = await ownership.isModemOwned({ nick: 'old-modem', portNameFilter: 'alice', deps: {
    db, fetchAllServersDataCached: async () => [], knownModems: {},
    mergeServerData: () => ({ status: [{ modem_details: { NICK: 'old-modem', IMEI: 'old' } }], ports: { old: [{ portName: '' }] } }),
  } });
  assert.equal(pastAccess, true);
  results.push({ finding: 'DEEP-38', livePortUnbound: true, rosterEmpty: true, historicalOwnershipGranted: pastAccess });

  const mutations = [];
  const { sha256hex } = require(path.join(ROOT, 'src/utils/secrets'));
  const blocked = { id: 'a', login: 'alice', portName: 'alice', blocked: true };
  const router = require(path.join(ROOT, 'src/routes/client-portal'))({
    db, logger, authMiddleware: middleware, dashboardLimiter: middleware, resetTokenLimiter: middleware,
    validate: () => middleware, knownModems: {}, clientByResetToken: new Map([[sha256hex('demo-token'), blocked]]),
    fetchAllServersDataCached: async () => [],
    mergeServerData: () => ({ status: [{ modem_details: { NICK: 'duplicate-nick', IMEI: 'S1_imei' } }], ports: { S1_imei: [{ portName: 'alice' }] } }),
    findServer: name => ({ name }), apiServers: [{ name: 'S4' }, { name: 'S1' }],
    fetchApi: async (server, url) => {
      if (url.includes('show_status')) return [{ modem_details: { NICK: 'duplicate-nick', IMEI: 'foreign-imei' } }];
      mutations.push({ action: 'reset', server: server.name }); return { ok: true };
    },
    proxyConf: { getConfForm: async () => ({ ok: true, fields: {} }),
      postConfForm: async (server, url, fields) => { mutations.push({ action: 'rotation', server: server.name, imei: fields.IMEI }); return { ok: true }; },
      verifyRotation: async () => ({ ok: true }) },
    modemRotationCache: {}, proxySmart: { invalidateCache: noop }, auditLog: noop, getClientIp: () => 'test',
  });
  const rotationRes = response();
  await handler(router, '/api/client/set_rotation', 'post')({ body: { nick: 'duplicate-nick', serverName: 'S4', minutes: 5 }, user: { login: 'alice', portNameFilter: 'alice' } }, rotationRes);
  assert.equal(rotationRes.body.ok, true);
  assert.deepEqual(mutations[0], { action: 'rotation', server: 'S4', imei: 'foreign-imei' });
  results.push({ finding: 'DEEP-37', ownershipFeedServer: 'S1', mutated: mutations[0] });
  const resetRes = response();
  await handler(router, '/api/client/reset_ip_by_token', 'get')({ query: { nick: 'duplicate-nick', token: 'demo-token' } }, resetRes);
  assert.equal(resetRes.body.ok, true);
  results.push({ finding: 'DEEP-39', clientBlocked: true, resetSucceeded: true, mutated: mutations[1] });
  db.close();

  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const settingFunction = source.slice(source.indexOf('function setSettings('), source.indexOf('\nfunction getPriceForProxyCount('));
  const memory = { auto_reboot_enabled: false };
  const apply = vm.runInNewContext('(' + settingFunction.trim() + ')', {
    appSettings: memory, SENSITIVE_SETTINGS: new Set(), saveSettings: () => { throw new Error('simulated SQLITE_FULL'); },
  });
  assert.throws(() => apply({ auto_reboot_enabled: true }), /SQLITE_FULL/);
  assert.equal(memory.auto_reboot_enabled, true);
  results.push({ finding: 'DEEP-41', writeFailed: true, runtimeAutoRebootEnabled: memory.auto_reboot_enabled });

  const selfClient = { id: 'b', login: 'bob', apiKey: 'old-hash' };
  const keyRouter = require(path.join(ROOT, 'src/routes/client-portal'))({
    logger, authMiddleware: middleware, dashboardLimiter: middleware, resetTokenLimiter: middleware,
    validate: () => middleware, clientByLogin: new Map([['bob', selfClient]]),
    getSetting: (key, fallback) => key === 'api_key_grace_hours' ? 0 : fallback,
    saveClients: noop, rebuildClientMaps: noop, auditLog: noop, getClientIp: () => 'test', notifyClient: async () => {},
  });
  const keyRes = response();
  await handler(keyRouter, '/api/client/api_key/regenerate', 'post')({ user: { login: 'bob' } }, keyRes);
  assert.equal(keyRes.body.graceHours, 24);
  results.push({ finding: 'DEEP-42', configuredGraceHours: 0, appliedGraceHours: keyRes.body.graceHours });

  const authSource = source.slice(source.indexOf('function authMiddleware('), source.indexOf('\nfunction adminMiddleware('));
  const staleSession = { login: 'former-login', isAdmin: false, portNameFilter: 'old-binding' };
  const auth = vm.runInNewContext('(' + authSource.trim() + ')', {
    _readSessionToken: () => 'demo', getSession: () => staleSession, clientByLogin: new Map(), deleteSessionsByLogin: noop,
  });
  let nextCalled = false;
  const authReq = { method: 'GET' };
  auth(authReq, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  results.push({ finding: 'DEEP-40', clientMissing: true, oldSessionAccepted: true, scope: authReq.user.portNameFilter });

  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'proxy-audit-backup-'));
  try {
    const demoPath = path.join(tmp, 'demo.db');
    const demo = new Database(demoPath);
    demo.exec('CREATE TABLE clients(id); INSERT INTO clients VALUES(1); CREATE TABLE billing_ledger(id); INSERT INTO billing_ledger VALUES(1); CREATE TABLE speed_monitor(id); INSERT INTO speed_monitor VALUES(1);');
    demo.close();
    fs.writeFileSync(path.join(tmp, 'dashboard-1999-01-01.db.gz'), require('node:zlib').gzipSync(fs.readFileSync(demoPath)));
    const backupContext = { module: { exports: {} }, require, process: { env: { DB_BACKUP_DIR: tmp } } };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/jobs/backup-test.js'), 'utf8'), backupContext);
    const backupTest = backupContext.module.exports.create({ logger, alerts: { trigger: noop }, fs, path, tmpDir: tmp, Database });
    const backupResult = await backupTest.runOnce();
    assert.equal(backupResult.ok, true);
    results.push({ finding: 'DEEP-43', staleBackup: backupResult.file, restoreTestOk: backupResult.ok });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ isolation: 'in-memory DB, local code, stubbed remote mutations', results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
