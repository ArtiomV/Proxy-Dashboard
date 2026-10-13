'use strict';
//
// src/jobs/backup-test.js — D3 (ТЗ мониторинга v2, этап 4, 23.08): еженедельный
// тест восстановления бэкапа. Бэкап считается существующим только после
// проверки восстановления.
//
// Источник дампа: облако через rclone (RCLONE_REMOTE / RCLONE_DEST_PREFIX,
// как у scripts/backup-offsite.sh); если облако не настроено/недоступно —
// fallback на последний локальный dashboard-*.db.gz из DB_BACKUP_DIR (warn
// в лог: тест идёт по локальной копии). Проверка: gunzip во временный каталог
// (по умолчанию DB_BACKUP_DIR/tmp на диске, НЕ tmpfs /tmp — см. инцидент
// 30.08) → better-sqlite3 readonly → PRAGMA integrity_check + счётчики ключевых
// таблиц > 0. Любой фейл → alerts.trigger('backup_restore_failed'),
// отсутствие дампов — тоже фейл («бэкапов нет»). FIX-08 п.7 (18.09.2026):
// повреждение последнего архива — всегда явный фейл; пригодный предыдущий
// архив ищется только для оценки восстановимости (recoverableFrom) и не
// маскирует фейл. Регистрация: startup.js, scheduleRepeating 03:10 UTC +
// проверка воскресенья внутри расписания.
//
// Тесты подсовывают deps.execFile / deps.tmpDir — сеть и rclone не дёргаем.

const zlib = require('zlib');
const { pipeline } = require('stream/promises');

function create(deps) {
  const { logger, alerts, logActivity, fs, path } = deps;
  const _execFile = deps.execFile || require('child_process').execFile;
  // 30.08: /tmp на проде — tmpfs в ОЗУ (1.9G), дамп ~700M туда не влезал при
  // частично занятом tmpfs (ENOSPC на ровном месте). По умолчанию распаковываем
  // на ДИСК рядом с локальными бэкапами; переопределить — BACKUP_TEST_TMPDIR.
  const _tmpDir = deps.tmpDir || process.env.BACKUP_TEST_TMPDIR || _defaultTmpDir();
  // DEEP-44 (2026-09-24): overlap-guard + уникальный mkdtemp на запуск.
  let _running = false;
  // DEEP-43: давность дампа (RPO) — отдельная проверка, не часть integrity.
  const RPO_DAYS = Math.max(1, parseInt(process.env.BACKUP_TEST_RPO_DAYS || '2', 10) || 2);

  function _defaultTmpDir() {
    try {
      const d = path.join(process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard', 'tmp');
      fs.mkdirSync(d, { recursive: true });
      return d;
    } catch (_) { return require('os').tmpdir(); }
  }

  function _exec(cmd, args) {
    return new Promise((resolve, reject) => {
      _execFile(cmd, args, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || ''); return reject(err); }
        resolve(String(stdout));
      });
    });
  }

  // Последний дамп: сначала облако (rclone), иначе локальная копия.
  // DEEP-43: remoteStatus — раздельная оценка доступности независимой копии;
  // успешный локальный fallback НЕ закрывает offsite-инцидент.
  async function _findLatest() {
    const remote = process.env.RCLONE_REMOTE || '';
    const prefix = process.env.RCLONE_DEST_PREFIX || 'proxy-dashboard-backups';
    let remoteStatus = 'unconfigured';
    if (require('./backup').offsiteDisabled()) {
      // BACKUP_OFFSITE=off — облака нет намеренно: проверяем локальную копию
      // без пометки DEGRADED.
      remoteStatus = 'disabled';
    } else if (remote) {
      try {
        const names = await _listPublished('s3');
        if (names.length) return { source: 's3', file: names[names.length - 1], remote, prefix, remoteStatus: 'ok' };
        remoteStatus = 'empty';
        logger.warn('[BackupTest] rclone: в облаке дампов не найдено — fallback на локальную копию');
      } catch (e) {
        remoteStatus = 'unavailable';
        logger.warn('[BackupTest] rclone недоступен (' + e.message + ') — тест по локальной копии');
      }
    } else {
      logger.warn('[BackupTest] RCLONE_REMOTE не задан — тест по локальной копии бэкапа');
    }
    const dir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
    const names = await _listPublished('local');
    if (!names.length) return { source: null, file: null, remoteStatus };
    const file = names[names.length - 1];
    return { source: 'local', file, localPath: path.join(dir, file), remoteStatus };
  }

  // DEEP-44: stream.pipeline закрывает ВСЕ ресурсы при ошибке (ручной
  // pipe+on(error) оставлял потоки висеть). Ошибка входа/gzip/диска —
  // одно отклонение Promise, дескрипторы освобождены.
  function _gunzip(src, dest) {
    return pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest)).then(() => dest);
  }

  // DEEP-44: свободного места должно хватить на распаковку с запасом.
  function _assertFreeSpace(dir, gzBytes) {
    try {
      const st = fs.statfsSync(dir);
      const free = st.bavail * st.bsize;
      const need = gzBytes * 8 + 100 * 1024 * 1024;   // коэф. распаковки + запас
      if (free < need) throw new Error(`мало места для теста восстановления: free ${(free / 1e9).toFixed(1)}GB < need ${(need / 1e9).toFixed(1)}GB`);
    } catch (e) {
      if (e.code === 'ENOENT' || /мало места/.test(e.message)) throw e;
      // statfs недоступен — не блокируем проверку
    }
  }

  // DEEP-44: осиротевшие каталоги прошлых запусков (kill -9 мимо finally) —
  // чистим только run-* старше суток (allowlist по имени + возраст).
  function _cleanOrphanRuns() {
    try {
      for (const name of fs.readdirSync(_tmpDir)) {
        if (!/^run-/.test(name)) continue;
        const full = path.join(_tmpDir, name);
        try {
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
        } catch (_) { /* файл гонки — пропускаем */ }
      }
    } catch (_) { /* best-effort */ }
  }

  // DEEP-43: давность по имени dashboard-YYYY-MM-DD.db.gz (UTC).
  function _fileAgeDays(file) {
    const m = /^dashboard-(\d{4})-(\d{2})-(\d{2})\.db\.gz$/.exec(file || '');
    if (!m) return null;
    return (Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000;
  }

  // Список опубликованных архивов (только точные имена dashboard-YYYY-MM-DD.db.gz —
  // .partial/.tmp сюда не попадают никогда, FIX-08 п.6) для выбранного источника.
  async function _listPublished(source) {
    if (source === 's3') {
      const remote = process.env.RCLONE_REMOTE || '';
      const prefix = process.env.RCLONE_DEST_PREFIX || 'proxy-dashboard-backups';
      const out = await _exec('rclone', ['lsf', `${remote}:${prefix}`, '--include', 'dashboard-*.db.gz']);
      return out.split('\n').map(s => s.trim())
        .filter(s => /^dashboard-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(s)).sort();
    }
    const dir = process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard';
    try {
      return fs.readdirSync(dir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f)).sort();
    } catch (_) { return []; }
  }

  // FIX-08 п.7 (18.09.2026): последний архив повреждён — оцениваем
  // восстановимость: проверяем до 3 предыдущих опубликованных архивов того же
  // источника и возвращаем имя ближайшего пригодного. Это НЕ подменяет итог:
  // повреждение последнего архива всегда остаётся явным фейлом с алертом.
  async function _findRecoverable(latest) {
    if (!latest) return null;
    let names;
    try { names = await _listPublished(latest.source); } catch (_) { return null; }
    const older = names.filter(n => n < latest.file).slice(-3).reverse();
    const stamp = Date.now();
    for (const name of older) {
      const tmpGz = path.join(_tmpDir, `backup-test-prev-${stamp}.db.gz`);
      const tmpDb = path.join(_tmpDir, `backup-test-prev-${stamp}.db`);
      try {
        if (latest.source === 's3') {
          await _exec('rclone', ['copyto', `${latest.remote}:${latest.prefix}/${name}`, tmpGz]);
        } else {
          fs.copyFileSync(path.join(process.env.DB_BACKUP_DIR || '/var/backups/proxy-dashboard', name), tmpGz);
        }
        await _gunzip(tmpGz, tmpDb);
        verifyBackupFile(tmpDb, deps.Database);
        return name;
      } catch (_) { /* этот тоже повреждён — смотрим глубже */ } finally {
        for (const f of [tmpGz, tmpDb, tmpDb + '-shm', tmpDb + '-wal']) {
          try { fs.unlinkSync(f); } catch (_) { /* temp-файл может не существовать */ }
        }
      }
    }
    return null;
  }

  async function runOnce() {
    if (_running) return { ok: false, skipped: 'already_running' };   // DEEP-44
    _running = true;
    try { fs.mkdirSync(_tmpDir, { recursive: true }); } catch (_) { /* существует */ }
    _cleanOrphanRuns();
    // DEEP-44: уникальный каталог запуска (параллельный запуск/совпадение
    // Date.now больше не делит пути), finally чистит только его.
    const runDir = fs.mkdtempSync(path.join(_tmpDir, 'run-'));
    const tmpGz = path.join(runDir, 'backup.db.gz');
    const tmpDb = path.join(runDir, 'backup.db');
    let latest = null;
    try {
      latest = await _findLatest();
      if (!latest || !latest.file) throw new Error('бэкапов нет — ни в облаке (rclone), ни локально');
      // DEEP-43: freshness/RPO — отдельная проверка. Валидный дамп
      // двухлетней давности — это НЕ актуальный бэкап.
      const ageDays = _fileAgeDays(latest.file);
      if (ageDays != null && ageDays > RPO_DAYS) {
        throw new Error(`последний дамп устарел: ${latest.file} (${Math.floor(ageDays)} дн. > RPO ${RPO_DAYS} дн.)`);
      }
      if (latest.source === 's3') {
        await _exec('rclone', ['copyto', `${latest.remote}:${latest.prefix}/${latest.file}`, tmpGz]);
      } else {
        fs.copyFileSync(latest.localPath, tmpGz);
      }
      _assertFreeSpace(runDir, fs.statSync(tmpGz).size);
      await _gunzip(tmpGz, tmpDb);
      const info = verifyBackupFile(tmpDb, deps.Database);
      // DEEP-43: раздельные оценки — integrity, freshness, remote. Локальный
      // fallback при недоступном облаке — degraded, а не чистый ok.
      const checks = {
        integrity: true,
        freshWithinDays: ageDays != null ? Math.floor(ageDays) : null,
        remote: latest.remoteStatus,
      };
      const degraded = latest.source === 'local' && (latest.remoteStatus === 'unavailable' || latest.remoteStatus === 'empty')
        ? 'remote_unavailable' : null;
      logger.info(`[BackupTest] OK: ${latest.file} (${latest.source}), clients=${info.counts.clients}${degraded ? ' — DEGRADED: облако недоступно, проверена локальная копия' : ''}`);
      if (logActivity) {
        logActivity('system', degraded ? 'warn' : 'info', 'backup_restore_test_ok', latest.file,
          `Тест восстановления OK: ${latest.file} (${latest.source})${degraded ? ' — облако недоступно' : ''}`,
          { source: latest.source, counts: info.counts, checks, degraded });
      }
      return { ok: true, source: latest.source, file: latest.file, counts: info.counts, checks, degraded };
    } catch (e) {
      const err = (e && e.message) || String(e);
      // FIX-08 п.7: повреждение последнего архива не маскируем — итог всегда
      // ok:false + алерт; пригодный предыдущий архив указываем лишь как
      // оценку восстановимости (recoverableFrom).
      const recoverableFrom = latest && latest.file ? await _findRecoverable(latest) : null;
      if (recoverableFrom) {
        logger.warn(`[BackupTest] последний архив повреждён (${latest.file}); ближайший пригодный: ${recoverableFrom}`);
      }
      logger.error('[BackupTest] FAILED: ' + err);
      try {
        alerts.trigger('backup_restore_failed', {
          source: latest && latest.source ? latest.source : '?', file: latest ? latest.file : '', error: err,
          recoverableFrom: recoverableFrom || null,
        });
      } catch (_) { /* alert best-effort */ }
      if (logActivity) {
        logActivity('system', 'critical', 'backup_restore_test_failed', latest && latest.file || null,
          'Тест восстановления бэкапа не прошёл', { error: err, recoverableFrom: recoverableFrom || null });
      }
      return { ok: false, error: err, recoverableFrom: recoverableFrom || null };
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      _running = false;
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
