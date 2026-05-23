// Test-harness entry point. Imports the real server.js (which under
// NODE_ENV=test does NOT bind a port and does NOT schedule cron/Telegram),
// and exposes utilities for:
//   - direct DB access for assertions / fixture seeding
//   - issuing an admin or client session token without going through bcrypt
//   - cleaning rows between tests
//
// Because server.js is huge and slow to require, we load it once and let
// every suite reuse the same `app` + `db`. Tests must clean up their own
// fixtures (delete rows they inserted) to keep suites independent.

const path = require('path');
const crypto = require('crypto');

// Force the require to happen *after* setup-env.js has set DASHBOARD_DB_PATH.
// Vitest setupFiles runs first, so by the time this module is imported the
// env is ready — but require server.js lazily to make the ordering explicit.
let _bootCache = null;
function bootApp() {
  if (_bootCache) return _bootCache;
  // Sanity-check that setup-env actually ran. If a test forgets to wire
  // it up via vitest.config.js, we want a clear error, not a clobbered prod DB.
  if (process.env.NODE_ENV !== 'test' || !process.env.DASHBOARD_DB_PATH) {
    throw new Error('[test/app] setup-env.js did not run — NODE_ENV or DASHBOARD_DB_PATH unset');
  }
  const mod = require(path.join(__dirname, '..', '..', 'server.js'));
  _bootCache = mod;
  return mod;
}

// Insert a session row directly, bypassing bcrypt + the login endpoint.
// Returns the token string that callers pass via X-Auth-Token header.
function mintSession({ login = 'test_admin', isAdmin = true, portFilter = '*', ttlMs = 60 * 60 * 1000 } = {}) {
  const { db } = bootApp();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  db.prepare(`INSERT INTO sessions (token, login, port_name_filter, is_admin, expires_at)
              VALUES (?, ?, ?, ?, ?)`).run(token, login, portFilter, isAdmin ? 1 : 0, expiresAt);
  return token;
}

// Convenience: seed an admin user row + return a fresh token.
function asAdmin(login = 'test_admin') {
  return mintSession({ login, isAdmin: true });
}

function asClient(login = 'test_client', portFilter = '*') {
  return mintSession({ login, isAdmin: false, portFilter });
}

// Wipe rows from a known set of mutable tables. Use sparingly — between
// suites is fine, between every test is overkill and slow.
function resetMutableTables() {
  const { db } = bootApp();
  const tables = [
    'sessions', 'audit_log', 'system_log', 'api_usage',
    'bank_payments', 'ledger', 'clients',
    'simulator_runs', 'simulator_profiles',
    'rotation_log', 'proxy_checks',
  ];
  const tx = db.transaction(() => {
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) { /* table may not exist on fresh DBs */ }
    }
  });
  tx();
}

module.exports = { bootApp, mintSession, asAdmin, asClient, resetMutableTables };
