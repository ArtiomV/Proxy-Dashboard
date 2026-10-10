'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const filename = require.resolve('../../src/jobs/http-check');
async function scenario(mode) {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE modem_httpcheck(ts TEXT,server TEXT,nick TEXT,status INTEGER,total_ms REAL,content_ok INTEGER,error TEXT,port_id TEXT,route_reason TEXT)');
    const realRequire = createRequire(filename), box = { exports: {} }, checks = [], events = [], reconciled = [], warnings = [];
    let directCalls = 0;
    const transport = { request() { throw new Error('Unexpected network request'); }, get(url, opts, callback) {
      directCalls++;
      const req = new EventEmitter(); req.destroy = () => {};
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = mode === 'parallel' ? 200 : 503; callback(res); res.emit('data', Buffer.from('test-body')); res.emit('end'); });
      return req;
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: box, exports: box.exports, Buffer,
      require: name => name === 'https' || name === 'http' ? transport : realRequire(name),
      setTimeout, clearTimeout }, { filename });
    const settings = { httpcheck_url: 'https://target.invalid', httpcheck_alert_threshold: 1,
      httpcheck_must_contain: mode === 'fallback' ? 'expected-target-body' : '' };
    const ids = mode === 'parallel' ? [1, 2, 3, 4] : [1];
    const monitor = box.exports.create({ db, logger: { info() {}, warn(x) { warnings.push(x); } },
      alerts: { trigger(rule, payload) { events.push({ rule, payload }); return true; }, reconcileIncidents(v) { reconciled.push(...v); } },
      getSetting: (k, d) => k in settings ? settings[k] : d,
      apiServers: [{ name: 'S1', publicIp: '192.0.2.1' }],
      fetchAllServersDataCached: async () => [{ serverName: 'S1',
        status: ids.map(i => ({ modem_details: { IMEI: 'i' + i, NICK: 'M' + i }, net_details: { IS_ONLINE: 'yes' } })),
        ports: Object.fromEntries(ids.map(i => ['i' + i, [{ portID: 'p' + i, HTTP_PORT: String(8000 + i), LOGIN: 'test', PASSWORD: 'test', portName: 'client' }]])) }],
      fetchThroughProxy: async (proxy, url) => {
        checks.push(url);
        if (mode === 'fallback' && url === settings.httpcheck_url) throw new Error('CONNECT status 403');
        return mode === 'fallback' ? { status: 200, totalMs: 1, body: '192.0.2.2' } : { status: 503, totalMs: 1, body: 'unavailable' };
      } });
    const result = await monitor.runOnce();
    return { result, checks, events, reconciled, directCalls, warnings, saved: db.prepare('SELECT status,content_ok,error FROM modem_httpcheck').get() };
  } finally { db.close(); }
}
async function main() {
  const fallback = await scenario('fallback');
  assert.equal(fallback.result.ok, 1);
  assert.equal(fallback.saved.error, '');
  assert.equal(fallback.saved.status, 200);
  assert.equal(fallback.saved.content_ok, null);
  assert.equal(fallback.reconciled.length, 1);
  const down = await scenario('down');
  assert.equal(down.directCalls, 1);
  assert.equal(down.events[0].rule, 'modem_http_fail');
  assert.ok(down.warnings.some(x => x.includes('подавлен')));
  const parallel = await scenario('parallel');
  assert.equal(parallel.directCalls, 4);
  assert.equal(parallel.result.failed, 4);
  assert.equal(parallel.events.length, 4);
  console.log(JSON.stringify({ findings: ['DEEP-86', 'DEEP-87', 'DEEP-89'],
    isolation: 'actual HTTP monitor in VM, SQLite in memory, proxy and direct transports stubbed; no network',
    fallback: { targetConnectStatus: 403, saved: fallback.saved, reportedOk: fallback.result.ok, healthReconciliationCalled: true },
    targetDown: { proxyStatus: 503, directStatus: 503, loggedSuppressed: true, emittedRule: down.events[0].rule },
    parallel: { failedTargets: 4, directRequestsInOneTick: parallel.directCalls } }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
