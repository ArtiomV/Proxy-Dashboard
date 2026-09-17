'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../../src/routes/proxy-checks.js');
const nativeRequire = createRequire(file);
const calls = [];
let status = 200;
class Socket extends EventEmitter {
  setTimeout() {} destroy() {} connect() { queueMicrotask(() => this.emit('connect')); }
}
const context = { module: { exports: {} }, Buffer, require: name => {
  if (name === 'http') return { request(options, cb) {
    calls.push(options.hostname);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; cb(res);
      res.emit('data', '{"ip":"test-fixture"}'); res.emit('end');
    });
    return req;
  } };
  if (name === 'net') return { Socket };
  return nativeRequire(name);
} };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
const middleware = (req, res, next) => next();
const router = context.module.exports({ authMiddleware: middleware, adminMiddleware: middleware, checkProxyLimiter: middleware });
const h = router.stack.find(l => l.route.path === '/api/tools/check_proxy').route.stack.at(-1).handle;
function response() { return { status() { return this; }, json(body) { this.body = body; } }; }
async function main() {
  const local = response();
  await h({ body: { proxies: [{ ip: 'localhost', port: 80 }, { ip: '::ffff:127.0.0.1', port: 80 }] } }, local);
  assert.ok(calls.includes('localhost'));
  assert.ok(calls.includes('::ffff:127.0.0.1'));
  status = 407;
  const refused = response();
  await h({ body: { proxies: [{ ip: '192.0.2.1', port: 80 }] } }, refused);
  assert.equal(refused.body.results[0].working, true);
  assert.equal(refused.body.results[0].status, 0);
  await assert.rejects(() => h({ body: { proxies: [null] } }, response()), /ip/);
  console.log(JSON.stringify({ isolation: 'all HTTP/TCP adapters stubbed; no network', results: [
    { finding: 'DEEP-61', privateHostsPassedToNetworkAdapter: calls.slice(0, 2) },
    { finding: 'DEEP-62', httpStatus: 407, tcpConnectSucceeded: true, reportedWorking: true },
    { finding: 'DEEP-60', nullProxyElementRejectsHandler: true },
  ] }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
