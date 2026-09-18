'use strict';
// src/db/retail-purchases.js — repository для `retail_purchases` (миграция 098).
//
// 2026-09-18 · DEEP-22 (§ FIX-SPEC): восстанавливаемая операция покупки.
// Строка создаётся ДО сетевых вызовов бокса; частично выполненная покупка
// переживает рестарт и доводится recovery-проходом retail-guard:
//   reserved → provisioning → provisioned → charged
//     └→ failed        — отвязка порта подтверждена, деньги не тронуты;
//     └→ charge_failed — порт выдан, списание не прошло: retry по purchase_id
//                        (idx_ledger_purchase_unique делает повтор duplicate);
//     └→ quarantine    — исход сети неизвестен: reconcile по СВЕЖЕМУ владельцу
//                        порта на боксе, само истечение TTL резерва ничего не
//                        доказывает.

let S = {};

function init(db) {
  S.byId = db.prepare('SELECT * FROM retail_purchases WHERE id = ?');
  S.byPoolRow = db.prepare(
    "SELECT * FROM retail_purchases WHERE pool_row_id = ? ORDER BY created_at DESC LIMIT 1"
  );
  S.byStatus = db.prepare('SELECT * FROM retail_purchases WHERE status = ?');
  S.insert = db.prepare(`INSERT INTO retail_purchases
    (id, client_id, tariff_id, server, port_id, pool_row_id, amount, test_day, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`);
  S.setPortInfo = db.prepare(
    "UPDATE retail_purchases SET server=?, port_id=?, pool_row_id=?, updated_at=datetime('now') WHERE id = ?"
  );
  S.setStatus = db.prepare(
    "UPDATE retail_purchases SET status=?, error=?, updated_at=datetime('now') WHERE id = ?"
  );
  S.recoverableCharges = db.prepare("SELECT * FROM retail_purchases WHERE status = 'charge_failed'");
  S.quarantined = db.prepare("SELECT * FROM retail_purchases WHERE status = 'quarantine'");
  S.inFlight = db.prepare(
    "SELECT * FROM retail_purchases WHERE status IN ('reserved','provisioning','provisioned')"
  );
}

function byId(id) { return S.byId.get(id); }
function byPoolRow(poolRowId) { return S.byPoolRow.get(poolRowId); }
function byStatus(status) { return S.byStatus.all(status); }
// Создание — захват права на покупку: UNIQUE-индексы (in-flight на клиента,
// одноразовый тест-день) отклоняют гонку SQLITE_CONSTRAINT_UNIQUE — caller
// переводит её в 409/403, а НЕ продолжает выдачу.
function createReserved(p) {
  S.insert.run(p.id, p.clientId, p.tariffId ?? null, p.server || null,
    p.portId || null, p.poolRowId ?? null, p.amount || 0, p.testDay ? 1 : 0);
  return byId(p.id);
}
function setPortInfo(id, server, portId, poolRowId) { S.setPortInfo.run(server, portId, poolRowId, id); }
function setStatus(id, status, error) { S.setStatus.run(status, error ? String(error).slice(0, 300) : null, id); }
function recoverableCharges() { return S.recoverableCharges.all(); }
function quarantined() { return S.quarantined.all(); }
function inFlight() { return S.inFlight.all(); }

module.exports = {
  init, byId, byPoolRow, byStatus, createReserved, setPortInfo, setStatus,
  recoverableCharges, quarantined, inFlight,
};
