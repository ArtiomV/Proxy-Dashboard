'use strict';
//
// src/jobs/backup-test.js — D3 (ТЗ мониторинга v2, этап 4, 23.08): еженедельный
// тест восстановления бэкапа. Бэкап считается существующим только после
// проверки восстановления.
//
// Источник дампа: облако через rclone (RCLONE_REMOTE / RCLONE_DEST_PREFIX,
// как у scripts/backup-offsite.sh); если облако не настроено/недоступно —
// fallback на последний локальный dashboard-*.db.gz из DB_BACKUP_DIR (warn
// в лог: тест идёт по локальной копии). Проверка: gunzip в /tmp →
// better-sqlite3 readonly → PRAGMA integrity_check + счётчики ключевых
// таблиц > 0. Любой фейл → alerts.trigger('backup_restore_failed'),
// отсутствие дампов — тоже фейл («бэкапов нет»). Регистрация: startup.js,
// scheduleRepeating 03:10 UTC + проверка воскресенья внутри расписания.
//
// Тесты подсовывают deps.execFile / deps.tmpDir — сеть и rclone не дёргаем.

const zlib = require('zlib');

function create(deps) {
  const { logger, alerts, logActivity, fs, path } = deps;
  const _execFile = deps.execFile || require('child_process').execFile;
  const _tmpDir = deps.tmpDir || require('os').tmpdir();

  function _exec(cmd, args) {
    return new Promise((resolve, reject) => {
      _execFile(cmd, args, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || ''); return reject(err); }
        resolve(String(stdout));
      });
    });
  }

  // Последний дамп: сначала облако (rclone), иначе локальная копия.
  async function _findLatest() {
    const remote = process.env.RCLONE_REMOTE || '';
    const prefix = process.env.RCLONE_DEST_PREFIX || 'proxy-dashboard-backups';
    if (remote) {
      try {
        const out = await _exec('rclone', ['lsf', `${remote}:${prefix}`, '--include', 'dashboard-*.db.gz']);
        const names = out.split('\n').map(s => s.trim())
          .filter(s => /^dashboard-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(s)).sort();
        if (names.length) return { source: 's3', file: names[names.length - 1], remote, prefix };
        logger.warn('[BackupTest] rclone: в облаке дампов не найдено — fallback на локальную копию');
      } catch (e) {
        logger.warn('[BackupTest] rclone недоступен (' + e.message + ') — тест по локальной копии');
      }
    } else {
      logger.warn('[BackupTest] RCLONE_REMOTE не задан — тест по локальной копии бэкапа');
    }
    const dir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
    let names = [];
    try {
      names = fs.readdirSync(dir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort();
    } catch (_) { /* каталога нет */ }
    if (!names.length) return null;
    const file = names[names.length - 1];
    return { source: 'local', file, localPath: path.join(dir, file) };
  }

  function _gunzip(src, dest) {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      const gz = zlib.createGunzip();
      rs.on('error', reject);
      ws.on('error', reject);
      gz.on('error', reject);
      ws.on('finish', () => resolve(dest));
      rs.pipe(gz).pipe(ws);
    });
  }

  async function runOnce() {
    const stamp = Date.now();
    const tmpGz = path.join(_tmpDir, `backup-test-${stamp}.db.gz`);
    const tmpDb = path.join(_tmpDir, `backup-test-${stamp}.db`);
    let latest = null;
    try {
      latest = await _findLatest();
      if (!latest) throw new Error('бэкапов нет — ни в облаке (rclone), ни локально');
      if (latest.source === 's3') {
        await _exec('rclone', ['copyto', `${latest.remote}:${latest.prefix}/${latest.file}`, tmpGz]);
      } else {
        fs.copyFileSync(latest.localPath, tmpGz);
      }
      await _gunzip(tmpGz, tmpDb);
      const info = verifyBackupFile(tmpDb, deps.Database);
      logger.info(`[BackupTest] OK: ${latest.file} (${latest.source}), clients=${info.counts.clients}`);
      if (logActivity) {
        logActivity('system', 'info', 'backup_restore_test_ok', latest.file,
          `Тест восстановления OK: ${latest.file} (${latest.source})`,
          { source: latest.source, counts: info.counts });
      }
      return { ok: true, source: latest.source, file: latest.file, counts: info.counts };
    } catch (e) {
      const err = (e && e.message) || String(e);
      logger.error('[BackupTest] FAILED: ' + err);
      try {
        alerts.trigger('backup_restore_failed', {
          source: latest ? latest.source : '?', file: latest ? latest.file : '', error: err,
        });
      } catch (_) { /* alert best-effort */ }
      if (logActivity) {
        logActivity('system', 'critical', 'backup_restore_test_failed', latest && latest.file || null,
          'Тест восстановления бэкапа не прошёл', { error: err });
      }
      return { ok: false, error: err };
    } finally {
      for (const f of [tmpGz, tmpDb, tmpDb + '-shm', tmpDb + '-wal']) {
        try { fs.unlinkSync(f); } catch (_) { /* temp-файл может не существовать */ }
      }
    }
  }

  return { runOnce, _findLatest };
}

// Чистая проверка файла БД: integrity_check + счётчики ключевых таблиц > 0.
// Бросает Error с причиной при любом фейле.
function verifyBackupFile(dbPath, Database) {
  const _Database = Database || require('better-sqlite3');
  let bdb;
  try {
    bdb = new _Database(dbPath, { readonly: true });
    const ic = bdb.pragma('integrity_check');
    const first = Array.isArray(ic) && ic[0] && ic[0].integrity_check;
    if (first !== 'ok') throw new Error('integrity_check: ' + (first || 'no result'));
    const counts = {};
    for (const t of ['clients', 'billing_ledger', 'speed_monitor']) {
      const c = bdb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      if (!(c > 0)) throw new Error(`таблица ${t} пуста (${c} строк)`);
      counts[t] = c;
    }
    return { ok: true, counts };
  } catch (e) {
    throw new Error('verify: ' + ((e && e.message) || e));
  } finally {
    try { if (bdb) bdb.close(); } catch (_) { /* best-effort */ }
  }
}

module.exports = { create, verifyBackupFile };
