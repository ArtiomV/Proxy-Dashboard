'use strict';
// src/db/documents.js — repository for client_documents + closing_documents
// + bills. All keyed on client_id with delete-by-client + insert + list.
// Used by saveClients() sub-array sync + per-route docs endpoints.

let S = {};

function init(db) {
  S.docDeleteByClient = db.prepare('DELETE FROM client_documents WHERE client_id = ?');
  S.docInsert = db.prepare(
    'INSERT INTO client_documents (id, client_id, name, file_name, mime_type, date) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );
  S.docsByClient = db.prepare('SELECT * FROM client_documents WHERE client_id = ? ORDER BY date');

  S.closingDeleteByClient = db.prepare('DELETE FROM closing_documents WHERE client_id = ?');
  S.closingInsert = db.prepare(
    'INSERT INTO closing_documents (id, client_id, tochka_doc_id, period, type, act_number, ' +
    'items, total_amount, status, contract_info, signed_at, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  S.closingByClient = db.prepare(
    'SELECT * FROM closing_documents WHERE client_id = ? ORDER BY created_at'
  );

  S.billDeleteByClient = db.prepare('DELETE FROM bills WHERE client_id = ?');
  S.billInsert = db.prepare(
    'INSERT INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  S.billsByClient = db.prepare('SELECT * FROM bills WHERE client_id = ? ORDER BY created_at');
}

// ─── Client documents ─────────────────────────────────────────────────────
function deleteDocsByClient(clientId) { return S.docDeleteByClient.run(clientId); }
function insertDoc(d, clientId) {
  return S.docInsert.run(d.id, clientId, d.name || '', d.fileName || '', d.mimeType || '', d.date || '');
}
function listDocs(clientId) { return S.docsByClient.all(clientId); }

// ─── Closing documents (acts) ─────────────────────────────────────────────
function deleteClosingByClient(clientId) { return S.closingDeleteByClient.run(clientId); }
function insertClosing(d, clientId) {
  return S.closingInsert.run(
    d.id, clientId, d.tochkaDocumentId || '', d.period || '', d.type || 'act',
    d.actNumber || '', JSON.stringify(d.items || []), d.totalAmount || 0,
    d.status || 'unsigned', d.contractInfo || '', d.signedAt || null,
    d.createdAt || new Date().toISOString()
  );
}
function listClosing(clientId) { return S.closingByClient.all(clientId); }

// ─── Bills ────────────────────────────────────────────────────────────────
function deleteBillsByClient(clientId) { return S.billDeleteByClient.run(clientId); }
function insertBill(b, clientId) {
  return S.billInsert.run(
    b.id, clientId, b.tochkaBillId || '', b.period || '',
    b.billNumber || '', b.amount || 0, b.status || 'unsigned',
    b.createdAt || new Date().toISOString()
  );
}
function listBills(clientId) { return S.billsByClient.all(clientId); }

module.exports = {
  init,
  deleteDocsByClient, insertDoc, listDocs,
  deleteClosingByClient, insertClosing, listClosing,
  deleteBillsByClient, insertBill, listBills,
};
