'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { pruneOldBackups } = require('../../src/jobs/backup');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-audit-prune-'));
try {
  const file = path.join(dir, 'dashboard-2026-09-01.db');
  const db = new Database(file);
  db.exec('CREATE TABLE clients(id INTEGER PRIMARY KEY); INSERT INTO clients VALUES(1)');
  db.close();
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file + '.gz', zlib.gzipSync(bytes));
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(file + '.gz')), bytes);
  const result = pruneOldBackups(fs, path, dir, 7, Date.parse('2026-10-09T12:00:00Z'));
  const remaining = fs.readdirSync(dir);
  assert.equal(result.kept, 1);
  assert.equal(remaining.length, 0);
  console.log(JSON.stringify({ finding: 'DEEP-91',
    isolation: 'real pruning helper; valid SQLite and matching gzip generated in unique temporary directory',
    before: ['dashboard-2026-09-01.db', 'dashboard-2026-09-01.db.gz'],
    reported: result, remainingFiles: remaining,
    limitation: 'all-archives-expired helper scenario; normal runDbBackup creates a fresh archive before pruning' }, null, 2));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
