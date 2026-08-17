'use strict';
// src/db/documents.js — repository for client_documents + closing_documents
// + bills. All keyed on client_id with delete-by-client + insert + list.
// Used by saveClients() sub-array sync + per-route docs endpoints.

let S = {};
let _db = null;

function init(db) {
  _db = db;
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
  // 2026-08-04: построчное редактирование акта в админке (было только в банке).
  S.closingUpdateItems = db.prepare(
    'UPDATE closing_documents SET items = ?, total_amount = ? WHERE id = ?'
  );
  // ...и суммы счёта.
  S.billUpdateAmount = db.prepare('UPDATE bills SET amount = ? WHERE id = ?');

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
    'INSERT INTO bills (id, client_id, tochka_bill_id, period, bill_number, amount, status, created_at, formula) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET status=excluded.status, formula=excluded.formula'
  );
  S.billsByClient = db.prepare('SELECT * FROM bills WHERE client_id = ? ORDER BY created_at');
  // Direct status UPDATE — still the primary persistence path (bill-settle
  // and bill-status-sync persist immediately, without a saveClients round).
  S.billUpdateStatus = db.prepare('UPDATE bills SET status = ? WHERE id = ?');
  // B2 (Р15): анти-дабл гейт для счетов — один счёт на (клиент, период).
  // UNIQUE-индекс idx_bills_unique_period (миграция 056) — истина; эта
  // проверка нужна, т.к. billInsert — UPSERT по PK и конфликт по уникальному
  // индексу бросил бы исключение внутри saveClients().
  S.billByClientPeriod = db.prepare('SELECT id FROM bills WHERE client_id = ? AND period = ?');

  // 2026-08-17: помесячная серия «№ N/MM-YYYY» (миграция 068). Годовая
  // таблица doc_numbering больше не используется — остаётся как архив.
  S.docNumMInit = db.prepare('INSERT OR IGNORE INTO doc_numbering_monthly (ym, next_num) VALUES (?, 1)');
  S.docNumMBump = db.prepare('UPDATE doc_numbering_monthly SET next_num = next_num + 1 WHERE ym = ? RETURNING next_num');
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
function updateClosingItems(id, items, totalAmount) { return S.closingUpdateItems.run(JSON.stringify(items || []), totalAmount || 0, id); }
function updateBillAmount(id, amount) { return S.billUpdateAmount.run(amount || 0, id); }

// ─── Bills ────────────────────────────────────────────────────────────────
function deleteBillsByClient(clientId) { return S.billDeleteByClient.run(clientId); }
function deleteBill(id) { return S.billDeleteById.run(id); }
function insertBill(b, clientId) {
  // B2: анти-дабл гейт — второй счёт на тот же (клиент, период) молча
  // отклоняем (UNIQUE-индекс 056 — backstop; явная проверка нужна, чтобы его
  // исключение не уронило всю транзакцию saveClients).
  const existing = S.billByClientPeriod.get(clientId, b.period || '');
  if (existing && existing.id !== b.id) return { changes: 0 };
  return S.billInsert.run(
    b.id, clientId, b.tochkaBillId || '', b.period || '',
    b.billNumber || '', b.amount || 0, b.status || 'unsigned',
    b.createdAt || new Date().toISOString(),
    b.formula ? JSON.stringify(b.formula) : ''
  );
}
function listBills(clientId) { return S.billsByClient.all(clientId); }
function updateBillStatus(id, status) { return S.billUpdateStatus.run(status, id); }

// B2 (Р15/Р23): атомарная выдача следующего сквозного номера. Единый счётчик
// для актов и счетов вместе (одна серия на систему); номера удалённых
// документов НЕ переиспользуются (дыры — норма).
//
// 2026-08-17 — новая модель: «№ N/MM-YYYY», счётчик привязан к МЕСЯЦУ
// ПЕРИОДА документа (period 'YYYY-MM'), а не к дате создания: акт за июль,
// выставленный в августе, получает номер из июльской серии. Если period не
// передан/невалиден — берётся текущий месяц. INSERT OR IGNORE + UPDATE ...
// RETURNING в одной транзакции — гонка крон+ручная генерация не может выдать
// один номер дважды. `now` — injectable для тестов.
function nextDocNumber(now, period) {
  let year, month;   // month: 1..12
  const pm = /^(\d{4})-(\d{2})/.exec(String(period || ''));
  if (pm && +pm[2] >= 1 && +pm[2] <= 12) {
    year = +pm[1]; month = +pm[2];
  } else {
    const d = now ? new Date(now) : new Date();
    year = d.getFullYear(); month = d.getMonth() + 1;
  }
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  let num;
  _db.transaction(() => {
    S.docNumMInit.run(ym);
    num = S.docNumMBump.get(ym).next_num - 1;
  })();
  return { num, year, month, label: `${num}/${ym.slice(5)}-${year}` };
}

module.exports = {
  init,
  deleteDocsByClient, deleteDoc, insertDoc, listDocs,
  deleteClosingByClient, deleteClosing, insertClosing, listClosing, updateClosingStatus, updateClosingItems,
  deleteBillsByClient, deleteBill, insertBill, listBills, updateBillStatus, updateBillAmount,
  nextDocNumber,
};
