'use strict';
// src/db/payments.js — repository for the `payments` table (per-client
// payment ledger; not bank_payments which has its own webhook flow).

let S = {};

function init(db) {
  S.deleteByClient = db.prepare('DELETE FROM payments WHERE client_id = ?');
  S.insert = db.prepare(
    'INSERT INTO payments (client_id, amount, date, note, source, payment_id, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  S.byClient = db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY date DESC, id DESC');
}

function deleteByClient(clientId) { return S.deleteByClient.run(clientId); }
function insert({ clientId, amount, date, note, source, paymentId, createdAt }) {
  return S.insert.run(clientId, amount, date || '', note || '', source || 'manual', paymentId || null, createdAt || new Date().toISOString());
}
function listByClient(clientId) { return S.byClient.all(clientId); }

module.exports = { init, deleteByClient, insert, listByClient };
