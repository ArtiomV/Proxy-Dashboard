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
      // D2: сжимаем снапшот gzip'ом — БД выросла до ~700 MB, 7 дневных копий
      // ели ~5 GB диска (13.08.2026). В облако и monthly/ уезжает .gz;
      // восстановление: gunzip → обычный dashboard.db.
      await gzipFile(dest);
      const finalDest = dest + '.gz';
      // Prune backups older than 7 days. Each is a full copy of the (growing)
      // DB — 14×~280 MB was ~4 GB on a 24 GB disk; 7 days is a comfortable window.
      // Also remove the SQLite sidecars (-shm/-wal) that matched a pruned .db
      // (the old regex left them behind to accumulate).
      const files = fs.readdirSync(backupDir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/.test(f));
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      let pruned = 0;
      for (const f of files) {
        const fileDate = f.slice(10, 20);
        if (fileDate < cutoff) {
          const base = f.endsWith('.gz') ? f.slice(0, -3) : f;
          for (const ext of ['', '-shm', '-wal', '.gz']) {
            try { fs.unlinkSync(path.join(backupDir, base + ext)); } catch (_) { /* sidecar may not exist */ }
          }
          pruned++;
        }
      }
      const sizeMb = Math.round(fs.statSync(finalDest).size / 1024 / 1024 * 10) / 10;
      logger.info(`[DbBackup] ${finalDest} (${sizeMb} MB, gz), pruned ${pruned} old backups`);
      logActivity('system', 'info', 'db_backup_complete', null, `Backed up ${sizeMb} MB to ${finalDest}`, { sizeMb, pruned });
      // D2: monthly-ротация — снапшот, сделанный 1-го числа, копируем в
      // monthly/ и храним 12 штук (год истории для восстановления «на месяц назад»).
      try {
        const m = rotateMonthlyBackup(fs, path, backupDir, finalDest, ts);
        if (m) logger.info(`[DbBackup] monthly snapshot ${m.dest} (pruned ${m.pruned})`);
      } catch (e) {
        logger.warn('[DbBackup] monthly rotation failed: ' + e.message);
      }
      // D2: offsite-выгрузка в облако (rclone, scripts/backup-offsite.sh).
      // Best-effort: сбой не роняет локальный бэкап, но и не молчит (C7).
      await runOffsiteUpload(logger, logActivity, backupDir);
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

// D2: monthly-ротация. Если бэкап сделан 1-го числа (dateStr 'YYYY-MM-01'),
// копируем его в <backupDir>/monthly/ и храним последние `keep` (12) штук.
// Чистая функция поверх fs/path — покрыта unit-тестом.
function rotateMonthlyBackup(fs, path, backupDir, dest, dateStr, keep = 12) {
  if (!/^\d{4}-\d{2}-01$/.test(dateStr)) return null;
  const mDir = path.join(backupDir, 'monthly');
  fs.mkdirSync(mDir, { recursive: true });
  const mDest = path.join(mDir, path.basename(dest));
  fs.copyFileSync(dest, mDest);
  const files = fs.readdirSync(mDir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/.test(f)).sort();
  let pruned = 0;
  while (files.length > keep) {
    const f = files.shift();
    for (const ext of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(path.join(mDir, f + ext)); } catch (_) { /* sidecar may not exist */ }
    }
    pruned++;
  }
  return { dest: mDest, pruned };
}

// D2: offsite-выгрузка daily+monthly бэкапов в облако через rclone
// (scripts/backup-offsite.sh, remote из $RCLONE_REMOTE). Best-effort: сбой —
// warn в лог + system_log (C7), ночной бэкап не роняем. Если rclone/remote не
// настроены, скрипт падает с понятной ошибкой — сюда она приходит как warn.
function runOffsiteUpload(logger, logActivity, backupDir) {
  const { execFile } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, '..', '..', 'scripts', 'backup-offsite.sh');
  return new Promise((resolve) => {
    execFile('bash', [script, backupDir], { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim().slice(0, 300);
        logger.warn('[DbBackup] offsite upload failed: ' + msg);
        try { logActivity('system', 'warn', 'backup_offsite_failed', null, 'Offsite backup upload failed', { error: msg }); } catch (_) { /* best-effort */ }
        return resolve(false);
      }
      const out = String(stdout).trim();
      if (out) logger.info('[DbBackup] offsite upload: ' + out.slice(0, 200));
      resolve(true);
    });
  });
}

// D2: gzip-сжатие снапшота (см. runDbBackup): потоковое, без загрузки 700 MB
// в память. Удаляет исходный .db после успешной записи .gz.
function gzipFile(dest) {
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const out = dest + '.gz';
    const rs = fs.createReadStream(dest);
    const ws = fs.createWriteStream(out);
    const gz = zlib.createGzip({ level: 6 });
    rs.on('error', reject);
    ws.on('error', reject);
    gz.on('error', reject);
    ws.on('finish', () => {
      try { fs.unlinkSync(dest); } catch (_) { /* best-effort */ }
      resolve(out);
    });
    rs.pipe(gz).pipe(ws);
  });
}

module.exports = { create, rotateMonthlyBackup, runOffsiteUpload, gzipFile };
