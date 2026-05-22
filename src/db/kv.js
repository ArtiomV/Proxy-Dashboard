'use strict';
// src/db/kv.js — kv_store + kv_store_history repository (Stage 2 finish).
//
// The kv_store table is the JSON-blob equivalent of a settings map: caches
// like dailyTraffic snapshot, baseline integrity hashes, etc. The history
// sibling keeps last-50 versions for forensic recovery (see kv-guard).
//
// Hot-path: kvGet/kvSet are called on every kvSetCritical write path —
// expose as raw prepared statements to avoid wrapper-fn overhead.

let S = {};

function init(db) {
  S.get = db.prepare('SELECT value FROM kv_store WHERE key = ?');
  S.set = db.prepare(
    "INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  );
  S.historyInsert = db.prepare(
    'INSERT INTO kv_store_history (key, old_value, new_value, source, shape_signature, regressed) ' +
    'VALUES (?,?,?,?,?,?)'
  );
  S.historyPrune = db.prepare(
    'DELETE FROM kv_store_history WHERE key = ? AND id NOT IN ' +
    '(SELECT id FROM kv_store_history WHERE key = ? ORDER BY id DESC LIMIT 50)'
  );
}

function getStmt() { return S.get; }
function setStmt() { return S.set; }
function historyInsertStmt() { return S.historyInsert; }
function historyPruneStmt() { return S.historyPrune; }

module.exports = { init, getStmt, setStmt, historyInsertStmt, historyPruneStmt };
