'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = require.resolve('../../src/jobs/backup-test');
async function main() {
  const now = Date.now();
  const name = time => 'dashboard-' + new Date(time).toISOString().slice(0, 10) + '.db.gz';
  const latest = name(now), previous = name(now - 86400000);
  let freeChecks = 0, decompressions = 0;
  const copied = [], writes = [], warnings = [];
  const fakeFs = {
    mkdirSync() {}, mkdtempSync: () => '/virtual/tmp/run-test',
    readdirSync: dir => dir === '/virtual/backups' ? [previous, latest] : [],
    copyFileSync(src, dst) { copied.push({ src, dst }); },
    statSync: () => ({ size: 1024 }),
    statfsSync() { freeChecks++; return { bavail: 0, bsize: 4096 }; },
    createReadStream: p => ({ source: p }),
    createWriteStream(p) { writes.push(p); return { destination: p }; },
    unlinkSync() {}, rmSync() {}
  };
  class FakeDatabase {
    pragma() { return [{ integrity_check: 'ok' }]; }
    prepare() { return { get: () => ({ n: 1 }) }; }
    close() {}
  }
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: box, exports: box.exports,
    process: { env: { DB_BACKUP_DIR: '/virtual/backups' } },
    require(name) {
      if (name === 'zlib') return { createGunzip: () => ({ transform: 'gunzip' }) };
      if (name === 'stream/promises') return { pipeline: async () => { decompressions++; } };
      throw new Error('Unexpected dependency: ' + name);
    }
  }, { filename });
  const job = box.exports.create({ fs: fakeFs, path, tmpDir: '/virtual/tmp', Database: FakeDatabase,
    execFile() { throw new Error('Unexpected external command'); },
    logger: { info() {}, error() {}, warn(s) { warnings.push(s); } }, alerts: { trigger() {} } });
  const result = await job.runOnce();
  assert.equal(result.ok, false);
  assert.match(result.error, /мало места/);
  assert.equal(freeChecks, 1);
  assert.equal(decompressions, 1);
  assert.equal(copied.length, 2);
  assert.match(writes[0], /backup-test-prev-/);
  assert.equal(result.recoverableFrom, previous);
  assert.ok(warnings.some(s => s.includes('последний архив повреждён')));
  console.log(JSON.stringify({ finding: 'DEEP-92',
    isolation: 'actual backup-test control flow in VM; virtual fs, decompressor and verifier; no writes/network',
    freeBytes: 0, freeSpaceChecks: freeChecks, fallbackDecompressions: decompressions,
    reportedError: result.error, incorrectlyLoggedCorruptArchive: true,
    limitation: 'proves attempted fallback path after space rejection; no real disk exhaustion or gzip expansion performed' }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
