'use strict';
// At-rest protection for bearer secrets (API keys, session tokens).
//
// Only SHA-256 hashes are persisted: a leaked dashboard.db / backup no
// longer hands out working credentials. Plaintext exists only transiently —
// in the one-time creation response and in the client's cookie/header.
// Lookups hash the presented value and compare against the stored hash.
//
// Registered as a SQLite function (server.js, before the migration runner)
// so migration 043 can hash existing rows in pure SQL.
const crypto = require('crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = { sha256hex };
