'use strict';
// src/db/documents.js — repository for client_documents + closing_documents
// + bills. All keyed on client_id with delete-by-client + insert + list.
// Used by saveClients() sub-array sync + per-route docs endpoints.

let S = {};

function init(db) {
  S.docDeleteByClient = db.prepare('DELETE FROM client_documents WHERE client_id = ?');
  S.docDeleteById     = db.prepare('DELETE FROM client_documents WHERE id = ?');
  // Stage 13.2: INSERT OR IGNORE (id is PRIMARY KEY) makes saveClients()
  // idempotent — re-running it after a partial failure can't double-insert,
  // and additive sync stops the DELETE-then-INSERT wipe that could lose
  // rows present in the DB but missing from the in-memory client object.
  S.docInsert = db.prepare(
    'INSERT OR IGNORE INTO client_documents (id, client_id, name, file_name, mime_type, date) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );
  S.docsByClient = db.prepare('SELECT * FROM client_documents WHERE client_id = ? ORDER BY date');

  S.closingDeleteByClient = db.prepare('DELETE FROM closing_documents WHERE client_id = ?');
  S.closingDeleteById     = db.prepare('DELETE FROM closing_documents WHERE id = ?');
  S.closingInsert = db.prepare(
    'INSERT OR IGNORE INTO closing_documents (id, client_id, tochka_doc_id, period, type, act_number, ' +
    'items, total_amount, status, contract_info, signed_at, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  S.closingByClient = db.prepare(
    'SELECT * FROM closing_documents WHERE client_id = ? ORDER BY created_at'
  );
  // closingInsert is INSERT OR IGNORE (idempotent) → it can't persist a status
  // change to an existing row. A dedicated UPDATE is needed so «подписан» sticks
  // across reloads (otherwise server.js reloads status from this table = unsigned).
  S.closingUpdateStatus = db.prepare(
    'UPDATE closing_documents SET status = ?, signed_at = ? WHERE id = ?'
  );

  S.billDeleteByClient = db.prepare('DELETE FROM bills WHERE client_id = ?');
  S.billDeleteById     = db.prepare('DELETE FROM bills WHERE id = ?');
  // UPSERT, not INSERT OR IGNORE: status is the one mutable field, and every
  // status writer (bill-settle, bill-status-sync, bill_status route) mutates
  // the in-memory bill BEFORE persisting — so saveClients upserting status
  // can never revert the DB to a stale value, it can only write the same or
  // a newer one. This closes the foot-gun where a future code path mutates
  // bill.status in memory, calls plain saveClients(), and silently loses the
  // change on reload. amount/period/etc. stay insert-once (same philosophy
  // as clients.balance, which is excluded from the clients upsert).
  S.billInsert = db.prepare(
    'INSERT INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET status=excluded.status'
  );
  S.billsByClient = db.prepare('SELECT * FROM bills WHERE client_id = ? ORDER BY created_at');
  // Direct status UPDATE — still the primary persistence path (bill-settle
  // and bill-status-sync persist immediately, without a saveClients round).
  S.billUpdateStatus = db.prepare('UPDATE bills SET status = ? WHERE id = ?');
}

// ─── Client documents ─────────────────────────────────────────────────────
function deleteDocsByClient(clientId) { return S.docDeleteByClient.run(clientId); }
function deleteDoc(id) { return S.docDeleteById.run(id); }
function insertDoc(d, clientId) {
  return S.docInsert.run(d.id, clientId, d.name || '', d.fileName || '', d.mimeType || '', d.date || '');
}
function listDocs(clientId) { return S.docsByClient.all(clientId); }

// ─── Closing documents (acts) ─────────────────────────────────────────────
function deleteClosingByClient(clientId) { return S.closingDeleteByClient.run(clientId); }
function deleteClosing(id) { return S.closingDeleteById.run(id); }
function insertClosing(d, clientId) {
  return S.closingInsert.run(
    d.id, clientId, d.tochkaDocumentId || '', d.period || '', d.type || 'act',
    d.actNumber || '', JSON.stringify(d.items || []), d.totalAmount || 0,
    d.status || 'unsigned', d.contractInfo || '', d.signedAt || null,
    d.createdAt || new Date().toISOString()
  );
}
function listClosing(clientId) { return S.closingByClient.all(clientId); }
function updateClosingStatus(id, status, signedAt) { return S.closingUpdateStatus.run(status, signedAt || null, id); }

// ─── Bills ────────────────────────────────────────────────────────────────
function deleteBillsByClient(clientId) { return S.billDeleteByClient.run(clientId); }
function deleteBill(id) { return S.billDeleteById.run(id); }
function insertBill(b, clientId) {
  return S.billInsert.run(
    b.id, clientId, b.tochkaBillId || '', b.period || '',
    b.billNumber || '', b.amount || 0, b.status || 'unsigned',
    b.createdAt || new Date().toISOString()
  );
}
function listBills(clientId) { return S.billsByClient.all(clientId); }
function updateBillStatus(id, status) { return S.billUpdateStatus.run(status, id); }

module.exports = {
  init,
  deleteDocsByClient, deleteDoc, insertDoc, listDocs,
  deleteClosingByClient, deleteClosing, insertClosing, listClosing, updateClosingStatus,
  deleteBillsByClient, deleteBill, insertBill, listBills, updateBillStatus,
};
