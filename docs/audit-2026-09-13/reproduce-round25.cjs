'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
async function main() {
  db.exec('CREATE TABLE modem_httpcheck(ts TEXT,server TEXT,nick TEXT,status INTEGER,total_ms REAL,content_ok INTEGER,error TEXT,port_id TEXT,route_reason TEXT)');
  const filename = require.resolve('../../src/jobs/http-check'), req = new EventEmitter(), res = new EventEmitter();
  req.destroy = () => {}; res.statusCode = 200; res.complete = false;
  let directStarted = false, settled = false;
  const transport = { request() { throw new Error('Unexpected network'); }, get(url, opts, callback) {
    directStarted = true; queueMicrotask(() => callback(res)); return req;
  } };
  const localRequire = createRequire(filename), box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: box, exports: box.exports, Buffer,
    require: name => name === 'http' || name === 'https' ? transport : localRequire(name), setTimeout, clearTimeout }, { filename });
  const monitor = box.exports.create({ db, logger: { info() {}, warn() {} }, alerts: { trigger() { return true; } },
    getSetting: (k, d) => k === 'httpcheck_alert_threshold' ? 1 : d,
    apiServers: [{ name: 'S1', publicIp: '192.0.2.1' }],
    fetchAllServersDataCached: async () => [{ serverName: 'S1', status: [{ modem_details: { IMEI: 'i', NICK: 'M' }, net_details: { IS_ONLINE: 'yes' } }],
      ports: { i: [{ portID: 'p', HTTP_PORT: 8000, LOGIN: 'test', PASSWORD: 'test', portName: 'client' }] } }],
    fetchThroughProxy: async () => ({ status: 503, body: 'failed', totalMs: 1 }) });
  const run = monitor.runOnce();
  run.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(directStarted, true);
  res.emit('data', Buffer.from('partial'));
  res.emit('aborted');
  // Capture EventEmitter's unhandled error at the test boundary, not in application code.
  assert.equal(res.listenerCount('error'), 0);
  assert.throws(() => res.emit('error', new Error('aborted')), /aborted/);
  res.emit('close'); req.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const next = await monitor.runOnce();
  assert.equal(next.skipped, 'already_running');
  console.log(JSON.stringify({ finding: 'DEEP-88',
    isolation: 'actual HTTP monitor in VM; controlled request/response EventEmitters; SQLite in memory; no sockets',
    responseErrorHandlers: 0, responseErrorEscapes: true, runSettledAfterResponseClose: settled,
    nextRun: next.skipped,
    limitation: 'transport events simulated; no real Node socket abort or production process crash performed' }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
