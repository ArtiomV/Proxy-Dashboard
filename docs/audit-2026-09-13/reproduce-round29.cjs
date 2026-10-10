'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { create } = require('../../src/jobs/backup-test');
async function main() {
  let unavailable = true, mkdirAttempts = 0, alerts = 0;
  const fs = {
    mkdirSync() {}, readdirSync() { return []; },
    mkdtempSync() {
      mkdirAttempts++;
      if (unavailable) { const e = new Error('injected ENOSPC'); e.code = 'ENOSPC'; throw e; }
      throw new Error('Recovered filesystem should have been retried');
    }
  };
  const job = create({ fs, path, tmpDir: '/virtual-audit-directory',
    logger: { info() {}, warn() {}, error() {} }, alerts: { trigger() { alerts++; } },
    execFile() { throw new Error('Unexpected external command'); } });
  await assert.rejects(job.runOnce(), /injected ENOSPC/);
  unavailable = false;
  const second = await job.runOnce();
  assert.equal(second.skipped, 'already_running');
  assert.equal(mkdirAttempts, 1);
  assert.equal(alerts, 0);
  console.log(JSON.stringify({ finding: 'DEEP-44 residual',
    isolation: 'actual backup-test factory, injected filesystem error, no file/network/commands',
    firstRun: 'rejected ENOSPC before protected try/finally',
    secondRunAfterSpaceRecovered: second, tempCreationAttempts: mkdirAttempts, restoreFailureAlerts: alerts }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
