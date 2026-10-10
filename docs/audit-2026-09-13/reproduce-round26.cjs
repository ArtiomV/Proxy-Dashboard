'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const filename = require.resolve('../../src/jobs/http-check');
async function sample(chunks) {
  let copiedBytes = 0, concatCalls = 0;
  const observedBuffer = { concat(parts) {
    concatCalls++; copiedBytes += parts.reduce((n, p) => n + p.length, 0);
    return Buffer.concat(parts);
  } };
  const transport = { get(url, options, cb) {
    const req = new EventEmitter(); req.destroy = () => {};
    queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; cb(res);
      for (const c of chunks) res.emit('data', c);
      res.emit('end');
    });
    return req;
  } };
  const localRequire = createRequire(filename), box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports._probeDirect = _fetchDirect;', {
    module: box, exports: box.exports, Buffer: observedBuffer,
    require: name => name === 'https' || name === 'http' ? transport : localRequire(name), setTimeout, clearTimeout
  }, { filename });
  const r = await box.exports._probeDirect('https://test.invalid', 5000);
  return { copiedBytes, concatCalls, returnedBytes: Buffer.byteLength(r.body) };
}
async function main() {
  const single = await sample([Buffer.alloc(64 * 1024, 'a')]);
  const fragmented = await sample(Array.from({ length: 64 }, () => Buffer.alloc(1024, 'a')));
  assert.equal(single.returnedBytes, fragmented.returnedBytes);
  assert.equal(fragmented.copiedBytes, 2129920);
  assert.equal(single.copiedBytes, 65536);
  const oversized = await sample([Buffer.alloc(600 * 1024, 'a')]);
  assert.equal(oversized.returnedBytes, 600 * 1024);
  assert.ok(oversized.returnedBytes > 512 * 1024);
  const beyondCap = await sample([...Array.from({ length: 8 }, () => Buffer.alloc(64 * 1024, 'a')),
    ...Array.from({ length: 10 }, () => Buffer.alloc(1024, 'b'))]);
  assert.equal(beyondCap.returnedBytes, 512 * 1024);
  assert.equal(beyondCap.concatCalls, 19);
  console.log(JSON.stringify({ finding: 'DEEP-90',
    isolation: 'actual direct-check helper in VM; local stream events; real Buffer.concat instrumented; no network',
    single, fragmented, oversized, beyondCap,
    meaning: 'copiedBytes is cumulative Buffer.concat output, not peak memory or elapsed-time benchmark' }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
