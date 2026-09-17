'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop };
async function main() {
  const pending = [], moves = [];
  const context = { module: { exports: {} }, require: p => require(path.resolve(ROOT, 'src/jobs', p)),
    setTimeout: noop, setInterval: noop, clearInterval: noop };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/jobs/failover.js'), 'utf8'), context);
  const failover = context.module.exports;
  failover.init({ logger, db: { prepare: () => ({ run: noop }) },
    appSettings: {}, findServer: name => ({ name }), uptimeTracking: {},
    knownModems: { S1: { p1: { imei: 'dead1', portName: 'alice' }, p2: { imei: 'dead2', portName: 'bob' } } },
    proxyConf: {
      getConfForm: () => new Promise(resolve => pending.push(resolve)),
      postConfForm: async (server, url, fields) => { moves.push({ port: url.split('/').at(-1), target: fields.IMEI, owner: fields.portName }); return { ok: true }; },
    },
    // Source is actually rebound to carol; failover never compares the owner to knownModems.
    parseHtmlInputFields: () => ({ proxy_password: 'demo', portName: 'carol', IMEI: 'already-moved' }),
    fetchApi: async () => { throw new Error('simulated apply failure'); },
    logActivity: noop, alerts: { trigger: noop }, proxySmart: { invalidateCache: noop },
  });
  const allData = { status: [{ _server: 'S1', modem_details: { IMEI: 'S1_spare', NICK: 'spare' }, net_details: { IS_ONLINE: 'yes' } }], ports: {} };
  const a = failover.failoverModem({ server: 'S1', imei: 'dead1', nick: 'd1' }, 'manual', { manual: true, allData });
  const b = failover.failoverModem({ server: 'S1', imei: 'dead2', nick: 'd2' }, 'manual', { manual: true, allData });
  assert.equal(pending.length, 2);
  pending.forEach(resolve => resolve({ ok: true, html: '' }));
  const completed = await Promise.all([a, b]);
  assert.equal(moves.length, 2);
  assert.ok(moves.every(m => m.target === 'spare' && m.owner === 'carol'));
  assert.ok(completed.every(r => r.results[0].result === 'ok'));
  const results = [
    { finding: 'DEEP-50', twoConcurrentMovesToSameSpare: moves },
    { finding: 'DEEP-51', rosterOwners: ['alice', 'bob'], actualOwnerMoved: 'carol' },
    { finding: 'DEEP-52', applyFailedTwice: true, reportedResults: completed.map(r => r.results[0].result) },
  ];
  const client = { id: 'a', login: 'alice', portName: 'alice', name: 'Alice', blocked: true };
  const router = require(path.join(ROOT, 'src/routes/public-api'))({
    _readApiKey: () => 'demo', getClientByApiKey: () => client,
    fetchAllServersDataCached: async () => [], extractServerName: () => 'S1', SERVER_COUNTRIES: { S1: { serverIp: '127.0.0.1' } },
    mergeServerData: () => ({ status: [], ports: { S1_imei: [{ LOGIN: 'demo', PASSWORD: 'demo', HTTP_PORT: 8001 }] } }),
  });
  const h = router.stack.find(l => l.route.path === '/api/v1/proxies').route.stack[0].handle;
  const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; } };
  await h({ query: {} }, res);
  assert.equal(res.body.count, 1);
  results.push({ finding: 'DEEP-53', clientBlocked: true, credentialsReturned: res.body.count });
  console.log(JSON.stringify({ isolation: 'local code, disabled timers, no network', results }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
