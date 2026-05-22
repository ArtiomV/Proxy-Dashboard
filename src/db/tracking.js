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

  // Stage 8: startup-load queries previously inlined in server.js.
  S.ipAll      = db.prepare('SELECT key, ip, updated_at FROM ip_tracking');
  S.utAll      = db.prepare('SELECT key, data FROM uptime_tracking');
  S.ihAllOrder = db.prepare('SELECT id, key, ip, started_at, ended_at FROM ip_history ORDER BY id ASC');

  // Stage 8: proxy_checks SLA aggregation — used by computeClientSlaMetrics
  // for each client. Hoisted out of the function so the prepare cost runs
  // once at boot, not on every SLA cycle.
  S.slaClientChecks24h = db.prepare(`
    SELECT AVG(total_ms) FILTER (WHERE error IS NULL) as avg_ms,
           COUNT(*) as total,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors
      FROM proxy_checks
     WHERE client_name = ? AND checked_at >= datetime('now', '-1 day')
  `);
  S.slaClientModems = db.prepare(`
    SELECT DISTINCT pc.server_name, pc.nick, COALESCE(mm.imei, '') as imei
      FROM proxy_checks pc
      LEFT JOIN modem_meta mm ON mm.server_name = pc.server_name AND mm.nick = pc.nick
     WHERE pc.client_name = ? AND pc.checked_at >= datetime('now', ?)
  `);

  // Stage 8: sla_violations writes — same hoist-once rationale.
  S.slaInsertViolation = db.prepare(`
    INSERT INTO sla_violations (client_id, date, metric, expected, actual, credited_amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  S.slaExistsViolation = db.prepare(`
    SELECT id FROM sla_violations WHERE client_id = ? AND date = ? AND metric = ?
  `);
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
  ipAllStmt:           () => S.ipAll,
  utAllStmt:           () => S.utAll,
  ihAllOrderStmt:      () => S.ihAllOrder,
  slaClientChecks24hStmt: () => S.slaClientChecks24h,
  slaClientModemsStmt:    () => S.slaClientModems,
  slaInsertViolationStmt: () => S.slaInsertViolation,
  slaExistsViolationStmt: () => S.slaExistsViolation,
};
