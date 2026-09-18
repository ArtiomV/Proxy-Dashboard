'use strict';
//
// src/jobs/backup.js — nightly DB backup + history pruning (WP6.4).
// Extracted VERBATIM from server.js: the DbBackup (02:00 UTC) and
// HistoryPrune (02:30 UTC) scheduleRepeating bodies. Deps via factory.
//
function create(deps) {
  const { db, logger, logActivity, fs, path } = deps;
  // FIX-08 п.5 (18.09.2026): блокировка охватывает весь цикл
  // снимок → верификация → сжатие → публикация, а не только gzipFile.
  let backupRunning = false;

  // Nightly DB backup — SQLite Online Backup API (safe while live).
  // Keeps 7 days of snapshots; older ones pruned (with sidecars).
  async function runDbBackup() {
    if (backupRunning) return { skipped: 'already_running' };
    backupRunning = true;
    try {
      const backupDir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch (_) { /* best-effort: error intentionally swallowed */ }
      const ts = new Date().toISOString().slice(0, 10);
      const dest = path.join(backupDir, `dashboard-${ts}.db`);
      // better-sqlite3 .backup() is a promise that streams pages to disk.
      await db.backup(dest);
      // DEEP-16 (18.09.2026): наличие таблицы clients само по себе не
      // доказывает целостность SQLite — проверяем quick_check снимка ДО
      // публикации и ДО удаления старых копий. Проверочная БД закрывается
      // через finally, иначе ошибка запроса оставляла её открытой.
      // deps.Database — точка инъекции для тестов.
      const Database = deps.Database || require('better-sqlite3');
      let bdb;
      try {
        bdb = new Database(dest, { readonly: true });
        const qc = bdb.pragma('quick_check');
        const qcFirst = Array.isArray(qc) && qc[0] && Object.values(qc[0])[0];
        if (qcFirst !== 'ok') throw new Error('backup verification: quick_check: ' + (qcFirst || 'no result'));
        const ok = bdb.prepare("SELECT count(*) c FROM sqlite_master WHERE name='clients'").get();
        if (!ok || !ok.c) throw new Error('backup verification: clients table missing');
      } finally {
        try { if (bdb) bdb.close(); } catch (_) { /* best-effort: close intentionally swallowed */ }
      }
      // D2: сжимаем снапшот gzip'ом — БД выросла до ~700 MB, 7 дневных копий
      // ели ~5 GB диска (13.08.2026). В облако и monthly/ уезжает .gz;
      // восстановление: gunzip → обычный dashboard.db.
      await gzipFile(dest, { fs, logger });
      const finalDest = dest + '.gz';
      // Prune backups older than 7 days (с защитой последней пригодной
      // копии — FIX-08 п.8, см. pruneOldBackups).
      const { pruned } = pruneOldBackups(fs, path, backupDir);
      const sizeMb = Math.round(fs.statSync(finalDest).size / 1024 / 1024 * 10) / 10;
      logger.info(`[DbBackup] ${finalDest} (${sizeMb} MB, gz), pruned ${pruned} old backups`);
      logActivity('system', 'info', 'db_backup_complete', null, `Backed up ${sizeMb} MB to ${finalDest}`, { sizeMb, pruned });
      // D2: monthly-ротация — снапшот, сделанный 1-го числа, копируем в
      // monthly/ и храним 12 штук (год истории для восстановления «на месяц назад»).
      try {
        const m = rotateMonthlyBackup(fs, path, backupDir, finalDest, ts, 12, logger);
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
    } finally {
      backupRunning = false;
    }
  }

  // Nightly history pruning — no-op с 2026-09: retention rotation_log /
  // system_log / proxy_checks (и остальных time-bounded таблиц) теперь ведёт
  // jobs/cleanup.js (runRetentionCleanup, настраиваемые retention_* политики).
  // Функция сохранена для расписания (startup.js, 02:30 UTC) и внешнего API.
  const HISTORY_RETENTION_DAYS = 60;
  function runHistoryPrune() {
    // Retention is owned by jobs/cleanup.js and its configurable policy.
    // Kept as a no-op for scheduler/API compatibility.
    logger.info('[HistoryPrune] skipped: unified retention runs in DbCleanup');
    return { skipped: 'unified_retention' };
  }

  return { runDbBackup, runHistoryPrune, HISTORY_RETENTION_DAYS };
}

// D2: monthly-ротация. Если бэкап сделан 1-го числа (dateStr 'YYYY-MM-01'),
// копируем его в <backupDir>/monthly/ и храним последние `keep` (12) штук.
// DEEP-16 (18.09.2026): копия пишется во временный файл на том же разделе,
// проверяется (размер == источнику) и публикуется атомарным rename — обрыв
// copyFile не портит предыдущий monthly-архив. Чистая функция поверх fs/path —
// покрыта unit-тестом. logger опционален (для fsync-предупреждений).
function rotateMonthlyBackup(fs, path, backupDir, dest, dateStr, keep = 12, logger = null) {
  if (!/^\d{4}-\d{2}-01$/.test(dateStr)) return null;
  const mDir = path.join(backupDir, 'monthly');
  fs.mkdirSync(mDir, { recursive: true });
  const mDest = path.join(mDir, path.basename(dest));
  const tmp = `${mDest}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.copyFileSync(dest, tmp);
    if (fs.statSync(tmp).size !== fs.statSync(dest).size) {
      throw new Error('monthly copy size mismatch');
    }
    fsyncFile(fs, tmp, logger);
    fs.renameSync(tmp, mDest);
    fsyncDir(fs, path.dirname(mDest), logger);
  } catch (e) {
    // Ошибка → удаляем только временный файл, прежний monthly-архив цел.
    try { fs.unlinkSync(tmp); } catch (_) { /* временного файла может не быть */ }
    throw e;
  }
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

// FIX-08 п.8 (18.09.2026): ротация daily-архивов старше keepDays (7 дней).
// Сроки не сокращаем; последний опубликованный архив не удаляем никогда —
// даже если ВСЕ копии старше cutoff (сломанное расписание/часы), должна
// остаться хотя бы одна пригодная копия. Sidecar-файлы (-shm/-wal/.gz)
// убираем вместе с удаляемой базой. .partial/.tmp сюда не попадают по regex.
function pruneOldBackups(fs, path, backupDir, keepDays = 7, now = Date.now()) {
  const files = fs.readdirSync(backupDir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/.test(f)).sort();
  const cutoff = new Date(now - keepDays * 86400000).toISOString().slice(0, 10);
  const newest = files[files.length - 1] || null;
  let pruned = 0;
  for (const f of files) {
    const fileDate = f.slice(10, 20);
    if (fileDate < cutoff) {
      if (f === newest) continue;   // последнюю пригодную копию не трогаем
      const base = f.endsWith('.gz') ? f.slice(0, -3) : f;
      for (const ext of ['', '-shm', '-wal', '.gz']) {
        try { fs.unlinkSync(path.join(backupDir, base + ext)); } catch (_) { /* sidecar may not exist */ }
      }
      pruned++;
    }
  }
  return { pruned, kept: files.length - pruned };
}

// DEEP-16 (18.09.2026): fsync различает «операция не поддерживается
// платформой» (ENOSYS/ENOTSUP/EINVAL — warn и продолжаем) и реальную ошибку
// ввода-вывода (EIO и пр. — НЕ маскируем best-effort success).
function _isFsyncUnsupported(e) {
  return e && ['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(e.code);
}

// fsync содержимого файла ДО публикации: реальная I/O-ошибка прерывает
// публикацию (бросаем наверх — вызывающий код удалит временный файл и
// сохранит прежний архив).
function fsyncFile(fs, file, logger) {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } catch (e) {
    if (_isFsyncUnsupported(e)) {
      if (logger) logger.warn(`[DbBackup] fsync не поддерживается (${e.code}) для ${file} — продолжаем без него`);
    } else {
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// fsync каталога ПОСЛЕ rename: запись каталога могла не уехать на диск.
// Неподдерживаемая операция — warn; реальная I/O-ошибка — error в лог, но
// опубликованный (и уже проверенный хешем) архив не портим и не откатываем.
function fsyncDir(fs, dir, logger) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
  } catch (e) {
    if (_isFsyncUnsupported(e) || (e && e.code === 'EISDIR')) {
      if (logger) logger.warn(`[DbBackup] fsync каталога не поддерживается (${e.code}) — продолжаем без него`);
      return;
    }
    if (logger) logger.error(`[DbBackup] не удалось открыть каталог для fsync: ${e.message}`);
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch (e) {
    if (_isFsyncUnsupported(e)) {
      if (logger) logger.warn(`[DbBackup] fsync каталога не поддерживается (${e.code}) — продолжаем без него`);
    } else if (logger) {
      logger.error(`[DbBackup] fsync каталога ${dir} failed: ${e.message}`);
    }
  } finally {
    fs.closeSync(fd);
  }
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
// FIX-08 (18.09.2026): сжатие идёт pipeline'ом во временный уникальный файл
// на том же разделе (эксклюзивное создание 'wx'), конечный .gz на запись не
// открывается. Перед публикацией проверяем целостность gzip и побайтовое
// соответствие распакованного содержимого снимку (sha256, потоково).
// Публикация — атомарный rename + fsync файла/каталога там, где это
// поддерживается (реальные I/O-ошибки fsync не маскируются — см. fsyncFile).
// При любой ошибке потоки завершаются pipeline'ом, удаляется только временный
// файл, прежний архив и исходный .db сохраняются. io — точки инъекции для
// тестов (fs-ошибки ENOSPC/EIO и т.п.).
function gzipFile(dest, io = {}) {
  const _fs = io.fs || require('fs');
  const zlib = require('zlib');
  const crypto = require('crypto');
  const { Writable } = require('stream');
  const { pipeline } = require('stream/promises');
  const logger = io.logger || null;
  async function sha256(file, compressed) {
    const hash = crypto.createHash('sha256');
    const sink = new Writable({
      write(chunk, _enc, callback) { hash.update(chunk); callback(); },
    });
    if (compressed) await pipeline(_fs.createReadStream(file), zlib.createGunzip(), sink);
    else await pipeline(_fs.createReadStream(file), sink);
    return hash.digest('hex');
  }
  return (async () => {
    const out = dest + '.gz';
    const tmp = `${out}.${process.pid}.${Date.now()}.partial`;
    const rs = _fs.createReadStream(dest);
    const ws = _fs.createWriteStream(tmp, { flags: 'wx' });
    const gz = zlib.createGzip({ level: 6 });
    try {
      await pipeline(rs, gz, ws);
      if (_fs.statSync(tmp).size === 0) throw new Error('gzip output is empty');
      const [sourceHash, restoredHash] = await Promise.all([sha256(dest, false), sha256(tmp, true)]);
      if (sourceHash !== restoredHash) throw new Error('gzip verification hash mismatch');
      fsyncFile(_fs, tmp, logger);
      _fs.renameSync(tmp, out);
      fsyncDir(_fs, require('path').dirname(out), logger);
      // FIX-08 п.4: после публикации исходный снимок можно удалить; ошибка
      // его удаления — отдельный warning, а не порча опубликованного архива.
      try { _fs.unlinkSync(dest); } catch (e) {
        if (logger) logger.warn(`[DbBackup] не удалось удалить снимок ${dest} после публикации: ${e.message}`);
      }
      return out;
    } catch (e) {
      try { _fs.unlinkSync(tmp); } catch (_) { /* временного файла может не быть */ }
      throw e;
    }
  })();
}

module.exports = { create, rotateMonthlyBackup, runOffsiteUpload, gzipFile, pruneOldBackups, fsyncFile, fsyncDir };
