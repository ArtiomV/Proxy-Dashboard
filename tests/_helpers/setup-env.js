// Vitest globalSetup — runs once before any test imports server.js.
//
// Goals:
//   - point the app at a temp DB (separate from prod dashboard.db)
//   - sanitize ALL env vars server.js consults at boot, so behavior is
//     deterministic regardless of what's in the developer's shell
//
// This file MUST run before require('../../server.js') anywhere. The
// vitest.config.js setupFiles hook guarantees that ordering.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Fresh temp DB per test process. Vitest's fileParallelism=false means
// suites share a process, so a single DB serves them all — tests are
// expected to clean their own rows.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
process.env.DASHBOARD_DB_PATH = path.join(tmpDir, 'test.db');
process.env.DB_BACKUP_DIR = path.join(tmpDir, 'backups');
fs.mkdirSync(process.env.DB_BACKUP_DIR, { recursive: true });

// NODE_ENV=test gates the app.listen() + cron init in server.js.
process.env.NODE_ENV = 'test';

// Clear API_*_URL so server boots with zero modem servers — tests that
// need ProxySmart data will mock fetchAllServersDataCached explicitly.
for (const k of Object.keys(process.env)) {
  if (/^API_.+_(URL|USER|PASS|PUBLIC_IP)$/.test(k)) delete process.env[k];
  if (/^TOCHKA_/.test(k)) delete process.env[k];
  if (/^MODEM_LOGIN_/.test(k)) delete process.env[k];
  if (/^CRM_/.test(k)) delete process.env[k];
}

// Silent logging during tests (pino respects this via its env hook).
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
process.env.PORT = '0';   // belt-and-braces in case anything tries to listen

// Stash the tmp dir so app.js can clean it up on teardown if needed.
process.env._TEST_TMP_DIR = tmpDir;
