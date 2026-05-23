'use strict';
// src/db/payments.js — repository for the `payments` table (per-client
// payment ledger; not bank_payments which has its own webhook flow).
//
// Stage 13.2: switched from wipe-and-rewrite (deleteByClient + insert all)
// to additive sync. Each newly-pushed in-memory entry gets its
// auto-incremented rowid back as `db_id` so subsequent saveClients
// invocations can skip rows that already exist in the DB. Routes that
// delete a single payment use `deleteById(rowid)` directly.
//
// `deleteByClient` is kept for the single legitimate use case: dropping
// a client entirely (ON DELETE CASCADE handles the rest, but the
// explicit call is here for symmetry with other repos).

let S = {};

function init(db) {
  S.deleteByClient = db.prepare('DELETE FROM payments WHERE client_id = ?');
  S.deleteById     = db.prepare('DELETE FROM payments WHERE id = ?');
  S.insert = db.prepare(
    'INSERT INTO payments (client_id, amount, date, note, source, payment_id, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  S.byClient = db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY date DESC, id DESC');
}

function deleteByClient(clientId) { return S.deleteByClient.run(clientId); }
function deleteById(id) { return S.deleteById.run(id); }
function insert({ clientId, amount, date, note, source, paymentId, createdAt }) {
  return S.insert.run(clientId, amount, date || '', note || '', source || 'manual', paymentId || null, createdAt || new Date().toISOString());
}
function listByClient(clientId) { return S.byClient.all(clientId); }

module.exports = { init, deleteByClient, deleteById, insert, listByClient };
