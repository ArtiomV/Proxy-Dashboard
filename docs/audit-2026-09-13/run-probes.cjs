'use strict';
// Explicit audited allowlist. Runs each probe in a separate process, serially.
// Successful probe means CURRENT DEFECT reproduced, not application acceptance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function walk(rel) {
  return fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap(e => {
    const p = path.posix.join(rel, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() && /\.(js|sql)$/.test(e.name) ? [p] : [];
  });
}
const paths = ['server.js', 'schema.sql', 'package.json', 'package-lock.json', ...walk('src'), ...walk('public/js'), ...walk('migrations')].sort();
function fingerprint() { return sha(paths.map(p => p + '\0' + sha(fs.readFileSync(path.join(ROOT, p)))).join('\n')); }
const before = fingerprint();
const results = [];
for (let round = 3; round <= 20; round++) {
  const file = `reproduce-round${round}.cjs`;
  const full = path.join(__dirname, file);
  const started = Date.now();
  const run = spawnSync(process.execPath, [full], { cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  let payload = null, parseError = null;
  try { payload = JSON.parse(run.stdout || ''); } catch (e) { parseError = e.message; }
  const confirmed = run.status === 0 && !run.error && !parseError;
  results.push({ file, sha256: sha(fs.readFileSync(full)), confirmed, exitCode: run.status, signal: run.signal,
    durationMs: Date.now() - started, error: run.error ? run.error.message : parseError,
    stderr: run.stderr || '', payload });
  console.log(`${file}: ${confirmed ? 'DEFECT REPRODUCED' : 'CHECK FAILED'}`);
}
const after = fingerprint();
const report = { generatedAt: new Date().toISOString(), node: process.version,
  meaning: 'Positive assertions reproduce known defects. Not a complete audit or passing product regression suite.',
  scope: 'round3..round20 only; earlier reproduce.cjs and tests/ not executed by this runner',
  fingerprintScope: 'server/schema/package manifests/src/public-js/migrations', fingerprintFiles: paths.length,
  sourceSha256Before: before, sourceSha256After: after, sourceUnchanged: before === after,
  total: results.length, confirmed: results.filter(r => r.confirmed).length, results };
fs.writeFileSync(path.join(__dirname, 'probe-results.json'), JSON.stringify(report, null, 2) + '\n');
if (before !== after || results.some(r => !r.confirmed)) process.exitCode = 1;
