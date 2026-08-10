'use strict';
// src/db/tracking.js — ip_tracking + uptime_tracking + ip_history +
// modem_meta + rotation_log (Stage 2 finish).

let S = {};

function init(db) {
  S.ipUpsert    = db.prepare('INSERT OR REPLACE INTO ip_tracking (key, ip, updated_at) VALUES (?, ?, ?)');
  // WP7.1: uptime_tracking is normalized (migration 047) — scalar columns +
  // uptime_daily for per-day buckets, no more JSON blob.
  S.utUpsert    = db.prepare(`INSERT OR REPLACE INTO uptime_tracking
    (key, total_checks, online_checks, first_check, last_check, last_online_check, offline_alerted)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  S.utDailyUpsert = db.prepare(`INSERT INTO uptime_daily (key, date, online, total) VALUES (?, ?, ?, ?)
    ON CONFLICT(key, date) DO UPDATE SET online=excluded.online, total=excluded.total`);
  S.ihInsert    = db.prepare('INSERT INTO ip_history (key, ip, started_at, ended_at) VALUES (?, ?, ?, ?)');
  S.ihUpdateEnd = db.prepare('UPDATE ip_history SET ended_at = ? WHERE id = ?');
  S.ihDeleteById = db.prepare('DELETE FROM ip_history WHERE id = ?');
  // Upsert that PRESERVES the last non-empty value per field. An offline modem
  // reports empty PHONE_NUMBER/MODEL/NICK in the live feed; the old INSERT OR
  // REPLACE wiped the whole row, so a modem going offline erased its saved phone
  // (and nick) — they vanished from the UI for disconnected modems. Now each
  // field keeps its stored value when the incoming one is blank.
  // Positional args (11): server_name, imei, nick, operator, model, phone,
  //                       sim_status, reboot_score, http_redirect, band, is_locked.
  // nick/operator/model/phone + sim_status/band preserve their last non-empty
  // value on a blank poll (offline modem reports blanks). reboot_score preserves
  // on NULL. http_redirect/is_locked are always-set 0/1 so a cleared problem is
  // reflected on the very next poll.
  S.modemMetaUpsert = db.prepare(
    'INSERT INTO modem_meta ' +
    '(server_name, imei, nick, operator, model, phone, ' +
    ' sim_status, reboot_score, http_redirect, band, is_locked, ' +
    ' signal_strength, iccid, cell_op, net_type, modem_uptime, ' +
    ' signals_updated_at, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')) " +
    'ON CONFLICT(server_name, imei) DO UPDATE SET ' +
    "  nick     = CASE WHEN excluded.nick     <> '' THEN excluded.nick     ELSE nick     END, " +
    "  operator = CASE WHEN excluded.operator <> '' THEN excluded.operator ELSE operator END, " +
    "  model    = CASE WHEN excluded.model    <> '' THEN excluded.model    ELSE model    END, " +
    "  phone    = CASE WHEN excluded.phone    <> '' THEN excluded.phone    ELSE phone    END, " +
    "  sim_status   = CASE WHEN excluded.sim_status <> '' THEN excluded.sim_status ELSE sim_status END, " +
    "  band         = CASE WHEN excluded.band <> '' THEN excluded.band ELSE band END, " +
    "  reboot_score = CASE WHEN excluded.reboot_score IS NOT NULL THEN excluded.reboot_score ELSE reboot_score END, " +
    "  http_redirect = excluded.http_redirect, " +
    "  is_locked     = excluded.is_locked, " +
    "  signal_strength = CASE WHEN excluded.signal_strength <> '' THEN excluded.signal_strength ELSE signal_strength END, " +
    "  iccid        = CASE WHEN excluded.iccid <> '' THEN excluded.iccid ELSE iccid END, " +
    "  cell_op      = CASE WHEN excluded.cell_op <> '' THEN excluded.cell_op ELSE cell_op END, " +
    "  net_type     = CASE WHEN excluded.net_type <> '' THEN excluded.net_type ELSE net_type END, " +
    "  modem_uptime = CASE WHEN excluded.modem_uptime <> '' THEN excluded.modem_uptime ELSE modem_uptime END, " +
    "  signals_updated_at = datetime('now'), " +
    "  updated_at = datetime('now')"
  );
  // WP4: read current ICCID by (server, imei) для детекта замены SIM.
  S.metaIccidGetByImei = db.prepare(
    'SELECT iccid FROM modem_meta WHERE server_name = ? AND imei = ? LIMIT 1'
  );
  S.metaOperatorGet = db.prepare(
    'SELECT operator FROM modem_meta WHERE server_name = ? AND nick = ? LIMIT 1'
  );
  // Stage 17: lookup by IMEI for the empty-operator guard in the tracking
  // loop — the upsert key is (server_name, imei), so we need to read by the
  // same key to know what's currently persisted.
  S.metaOperatorGetByImei = db.prepare(
    'SELECT operator FROM modem_meta WHERE server_name = ? AND imei = ? LIMIT 1'
  );
  // Stage 18: list all modems known to the server within the retention window
  // — used by injectOfflineModems() as a fallback source so a modem that's
  // missing from known_modems (any reason) is still visible in the admin.
  // The bind is days-string concatenated since better-sqlite3 doesn't accept
  // interval params; we hand-build it from a single numeric input that's
  // clamped before prepare. NOT a SQL-injection vector — the caller is
  // server.js which controls the value (an appSettings int).
  S.metaListRecentForServer = db.prepare(
    "SELECT server_name, nick, imei, operator, model, phone, updated_at " +
    "FROM modem_meta WHERE server_name = ? AND imei IS NOT NULL AND TRIM(imei) != '' " +
    "AND deleted = 0 " +   // 041: soft-deleted modems are hidden from the offline fallback
    "AND updated_at >= datetime('now', ?) "
  );
  // Roster feeding computeFleet (the «В работе X/Y» headline + per-server cards +
  // «Модем отключен» card + offline alert). MUST exclude soft-deleted modems, or a
  // deleted modem keeps inflating total and lingers in offlineList (the RO2_35
  // «91/92» bug). Centralized here so the deleted-filter can't be forgotten by a
  // future rewrite — guarded by tests/fleet-roster.test.js.
  S.metaFleetRoster = db.prepare(
    "SELECT server_name AS srv, imei, nick " +
    "FROM modem_meta " +
    "WHERE imei IS NOT NULL AND TRIM(imei) != '' " +
    "  AND nick IS NOT NULL AND TRIM(nick) != '' " +
    "  AND lower(nick) NOT LIKE 'random%' " +
    "  AND (is_test_pool IS NULL OR is_test_pool = 0) " +
    "  AND (deleted IS NULL OR deleted = 0)"
  );
  // Stage 18: explicit delete by (server, imei) — used by the DELETE-modem
  // endpoint to purge a modem from BOTH known_modems and modem_meta atomically
  // (otherwise it'd reappear via the meta fallback on the next render).
  S.metaDeleteByImei = db.prepare(
    'DELETE FROM modem_meta WHERE server_name = ? AND imei = ?'
  );
  // 041: soft-delete (poll-resistant). The DELETE endpoint flags the row instead
  // of removing it, so the next ProxySmart poll's upsert (which never touches
  // `deleted`) can't resurrect the modem. Auto-cleared by updateKnownModems when
  // the modem proves a SUSTAINED return: N consecutive online polls
  // (_autoRestoreIfStable, default 3) — a one-poll blip never clears the flag.
  S.metaSoftDelete = db.prepare(
    'UPDATE modem_meta SET deleted = 1 WHERE server_name = ? AND imei = ?'
  );
  S.metaUndelete = db.prepare(
    'UPDATE modem_meta SET deleted = 0 WHERE server_name = ? AND imei = ?'
  );
  S.metaListDeleted = db.prepare(
    "SELECT server_name, imei FROM modem_meta WHERE deleted = 1 AND imei IS NOT NULL AND TRIM(imei) != ''"
  );
  // 041b: robust delete — match by imei OR nick. A recovery/rename can leave a
  // modem_meta row whose imei differs from (or is blank in) the known_modems
  // entry the UI deletes by; matching nick too makes the soft-delete stick.
  S.metaSoftDeleteWide = db.prepare(
    "UPDATE modem_meta SET deleted = 1 WHERE server_name = ? AND (imei = ? OR (nick = ? AND nick <> ''))"
  );
  S.metaUndeleteWide = db.prepare(
    "UPDATE modem_meta SET deleted = 0 WHERE server_name = ? AND (imei = ? OR (nick = ? AND nick <> ''))"
  );
  S.metaNickByImei = db.prepare(
    "SELECT nick FROM modem_meta WHERE server_name = ? AND imei = ? AND nick IS NOT NULL AND nick <> '' LIMIT 1"
  );
  // ON CONFLICT DO UPDATE (не OR IGNORE): при повторной выборке бэкфиллит
  // caller/target_mode в строки, синканные до миграции 050. Ключ уникальности
  // — (server_name, nick, started_at).
  S.rotationUpsert = db.prepare(
    'INSERT INTO rotation_log ' +
    '(server_name, nick, old_ip, new_ip, started_at, ended_at, took_sec, attempt, caller, target_mode) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(server_name, nick, started_at) DO UPDATE SET ' +
    'ended_at=excluded.ended_at, took_sec=excluded.took_sec, attempt=excluded.attempt, ' +
    'old_ip=excluded.old_ip, new_ip=excluded.new_ip, ' +
    'caller=COALESCE(excluded.caller, rotation_log.caller), ' +
    'target_mode=COALESCE(excluded.target_mode, rotation_log.target_mode)'
  );
  S.rotationSelect = db.prepare(
    'SELECT * FROM rotation_log WHERE server_name = ? AND nick = ? ' +
    'ORDER BY started_at DESC LIMIT 200'
  );

  // Stage 8: startup-load queries previously inlined in server.js.
  S.ipAll      = db.prepare('SELECT key, ip, updated_at FROM ip_tracking');
  // WP7.1: normalized read (migration 047) — columns, not a JSON blob.
  S.utAll      = db.prepare('SELECT key, total_checks, online_checks, first_check, last_check, last_online_check, offline_alerted FROM uptime_tracking');
  S.utDailyAll = db.prepare('SELECT key, date, online, total FROM uptime_daily');
  S.ihAllOrder = db.prepare('SELECT id, key, ip, started_at, ended_at FROM ip_history ORDER BY id ASC');
}

module.exports = {
  init,
  ipUpsertStmt:        () => S.ipUpsert,
  utUpsertStmt:        () => S.utUpsert,
  utDailyUpsertStmt:   () => S.utDailyUpsert,
  ihInsertStmt:        () => S.ihInsert,
  ihUpdateEndStmt:     () => S.ihUpdateEnd,
  ihDeleteByIdStmt:    () => S.ihDeleteById,
  modemMetaUpsertStmt: () => S.modemMetaUpsert,
  metaIccidGetByImeiStmt: () => S.metaIccidGetByImei,
  metaOperatorGetStmt: () => S.metaOperatorGet,
  metaOperatorGetByImeiStmt: () => S.metaOperatorGetByImei,
  metaListRecentForServerStmt: () => S.metaListRecentForServer,    // Stage 18
  metaFleetRosterStmt:         () => S.metaFleetRoster,            // fleet count (deleted-excluded)
  metaDeleteByImeiStmt:        () => S.metaDeleteByImei,            // Stage 18
  metaSoftDeleteStmt:          () => S.metaSoftDelete,              // 041
  metaUndeleteStmt:            () => S.metaUndelete,                // 041
  metaListDeletedStmt:         () => S.metaListDeleted,             // 041
  metaSoftDeleteWideStmt:      () => S.metaSoftDeleteWide,          // 041b
  metaUndeleteWideStmt:        () => S.metaUndeleteWide,            // 041b
  metaNickByImeiStmt:          () => S.metaNickByImei,              // 041b
  rotationUpsertStmt:  () => S.rotationUpsert,
  rotationSelectStmt:  () => S.rotationSelect,
  ipAllStmt:           () => S.ipAll,
  utAllStmt:           () => S.utAll,
  utDailyAllStmt:      () => S.utDailyAll,
  ihAllOrderStmt:      () => S.ihAllOrder,
};
