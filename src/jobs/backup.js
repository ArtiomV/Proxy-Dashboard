'use strict';
//
// src/jobs/backup.js — nightly DB backup + history pruning (WP6.4).
// Extracted VERBATIM from server.js: the DbBackup (02:00 UTC) and
// HistoryPrune (02:30 UTC) scheduleRepeating bodies. Deps via factory.
//
function create(deps) {
  const { db, logger, logActivity, fs, path } = deps;

  // Nightly DB backup — SQLite Online Backup API (safe while live).
  // Keeps 7 days of snapshots; older ones pruned (with sidecars).
  async function runDbBackup() {
    try {
      const backupDir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch (_) { /* best-effort: error intentionally swallowed */ }
      const ts = new Date().toISOString().slice(0, 10);
      const dest = path.join(backupDir, `dashboard-${ts}.db`);
      // better-sqlite3 .backup() is a promise that streams pages to disk.
      await db.backup(dest);
      // Verify the backup opens & has clients table.
      const Database = require('better-sqlite3');
      const bdb = new Database(dest, { readonly: true });
      const ok = bdb.prepare("SELECT count(*) c FROM sqlite_master WHERE name='clients'").get();
      bdb.close();
      if (!ok || !ok.c) throw new Error('backup verification: clients table missing');
      // Prune backups older than 7 days. Each is a full copy of the (growing)
      // DB — 14×~280 MB was ~4 GB on a 24 GB disk; 7 days is a comfortable window.
      // Also remove the SQLite sidecars (-shm/-wal) that matched a pruned .db
      // (the old regex left them behind to accumulate).
      const files = fs.readdirSync(backupDir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db$/.test(f));
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      let pruned = 0;
      for (const f of files) {
        const fileDate = f.slice(10, 20);
        if (fileDate < cutoff) {
          for (const ext of ['', '-shm', '-wal']) {
            try { fs.unlinkSync(path.join(backupDir, f + ext)); } catch (_) { /* sidecar may not exist */ }
          }
          pruned++;
        }
      }
      const sizeMb = Math.round(fs.statSync(dest).size / 1024 / 1024 * 10) / 10;
      logger.info(`[DbBackup] ${dest} (${sizeMb} MB), pruned ${pruned} old backups`);
      logActivity('system', 'info', 'db_backup_complete', null, `Backed up ${sizeMb} MB to ${dest}`, { sizeMb, pruned });
    } catch (e) {
      logger.error('[DbBackup] FAILED: ' + (e.stack || e.message));
      logActivity('system', 'critical', 'db_backup_failed', null, 'DB backup failed', { error: e.message });
    }
  }

  // Nightly history pruning — rotation_log / system_log / proxy_checks are
  // append-only and were the bulk of the live DB. Bare-date cutoff is
  // index-friendly and format-agnostic across the three timestamp formats.
  const HISTORY_RETENTION_DAYS = 60;
  function runHistoryPrune() {
    try {
      const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
      const targets = [
        ['rotation_log', 'started_at'],
        ['system_log',   'timestamp'],
        ['proxy_checks', 'checked_at'],
      ];
      let total = 0;
      const parts = [];
      for (const [table, col] of targets) {
        const r = db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoff);
        total += r.changes;
        parts.push(`${table}=${r.changes}`);
      }
      logger.info(`[HistoryPrune] cutoff<${cutoff} (${HISTORY_RETENTION_DAYS}d), deleted ${total} rows (${parts.join(', ')})`);
      if (total > 0) {
        logActivity('system', 'info', 'history_prune', null, `Pruned ${total} rows older than ${HISTORY_RETENTION_DAYS}d`, { total, cutoff, parts });
      }
    } catch (e) {
      logger.error('[HistoryPrune] ' + (e.stack || e.message));
    }
  }

  return { runDbBackup, runHistoryPrune, HISTORY_RETENTION_DAYS };
}

module.exports = { create };
