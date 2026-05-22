'use strict';
// src/db/tracking.js — ip_tracking + uptime_tracking + ip_history +
// modem_meta + rotation_log (Stage 2 finish).

let S = {};

function init(db) {
  S.ipUpsert    = db.prepare('INSERT OR REPLACE INTO ip_tracking (key, ip, updated_at) VALUES (?, ?, ?)');
  S.utUpsert    = db.prepare('INSERT OR REPLACE INTO uptime_tracking (key, data) VALUES (?, ?)');
  S.ihInsert    = db.prepare('INSERT INTO ip_history (key, ip, started_at, ended_at) VALUES (?, ?, ?, ?)');
  S.ihUpdateEnd = db.prepare('UPDATE ip_history SET ended_at = ? WHERE id = ?');
  S.ihDeleteById = db.prepare('DELETE FROM ip_history WHERE id = ?');
  S.modemMetaUpsert = db.prepare(
    'INSERT OR REPLACE INTO modem_meta ' +
    '(server_name, imei, nick, operator, model, phone, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
  );
  S.metaOperatorGet = db.prepare(
    'SELECT operator FROM modem_meta WHERE server_name = ? AND nick = ? LIMIT 1'
  );
  S.rotationUpsert = db.prepare(
    'INSERT OR IGNORE INTO rotation_log ' +
    '(server_name, nick, old_ip, new_ip, started_at, ended_at, took_sec, attempt) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  S.rotationSelect = db.prepare(
    'SELECT * FROM rotation_log WHERE server_name = ? AND nick = ? ' +
    'ORDER BY started_at DESC LIMIT 200'
  );
}

module.exports = {
  init,
  ipUpsertStmt:        () => S.ipUpsert,
  utUpsertStmt:        () => S.utUpsert,
  ihInsertStmt:        () => S.ihInsert,
  ihUpdateEndStmt:     () => S.ihUpdateEnd,
  ihDeleteByIdStmt:    () => S.ihDeleteById,
  modemMetaUpsertStmt: () => S.modemMetaUpsert,
  metaOperatorGetStmt: () => S.metaOperatorGet,
  rotationUpsertStmt:  () => S.rotationUpsert,
  rotationSelectStmt:  () => S.rotationSelect,
};
