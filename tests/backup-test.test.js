// D3 (ТЗ мониторинга v2, этап 4, 23.08): еженедельный тест восстановления
// бэкапа (src/jobs/backup-test.js).
//   - verifyBackupFile: integrity_check + счётчики clients/billing_ledger/
//     speed_monitor > 0; мусорный файл и пустые таблицы → Error;
//   - runOnce: fallback на локальную копию (без RCLONE_REMOTE), gunzip,
//     проверка, logActivity ok; отсутствие дампов → алерт
//     backup_restore_failed; temp-файлы прибиваются.
// rclone/сеть не дёргаем: тесты идут по локальной ветке (RCLONE_REMOTE
// снимаем на время теста и восстанавливаем после).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const backupTest = require('../src/jobs/backup-test.js');

function makeValidDbFile(file) {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE clients (id INTEGER);
    CREATE TABLE billing_ledger (id INTEGER);
    CREATE TABLE speed_monitor (id INTEGER);
    INSERT INTO clients VALUES (1);
    INSERT INTO billing_ledger VALUES (1);
    INSERT INTO speed_monitor VALUES (1);
  `);
  d.close();
}

let workDir;   // свежий tmp-каталог на каждый тест

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
});
afterEach(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

describe('D3: verifyBackupFile', () => {
  it('валидная БД → ok + счётчики', () => {
    const f = path.join(workDir, 'ok.db');
    makeValidDbFile(f);
    const r = backupTest.verifyBackupFile(f);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ clients: 1, billing_ledger: 1, speed_monitor: 1 });
  });

  it('мусорный файл → Error(verify)', () => {
    const f = path.join(workDir, 'garbage.db');
    fs.writeFileSync(f, 'this is not a sqlite database at all');
    expect(() => backupTest.verifyBackupFile(f)).toThrow(/verify:/);
  });

  it('пустые ключевые таблицы → Error(пуста)', () => {
    const f = path.join(workDir, 'empty.db');
    const d = new Database(f);
    d.exec('CREATE TABLE clients (id INTEGER); CREATE TABLE billing_ledger (id INTEGER); CREATE TABLE speed_monitor (id INTEGER);');
    d.close();
    expect(() => backupTest.verifyBackupFile(f)).toThrow(/пуста/);
  });
});

// 2026-09-24 · DEEP-43: имена дампов — динамические (RPO-проверка по дате файла).
const _d = (daysAgo) => {
  const t = new Date(Date.now() - daysAgo * 86400000);
  return t.toISOString().slice(0, 10);
};
const FRESH = 'dashboard-' + _d(1) + '.db.gz';   // вчера — проходит RPO
const OLD = 'dashboard-' + _d(8) + '.db.gz';     // неделя — старше RPO=2

describe('D3: runOnce — локальный fallback', () => {
  const savedEnv = {};
  beforeEach(() => {
    for (const k of ['RCLONE_REMOTE', 'DB_BACKUP_DIR']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ['RCLONE_REMOTE', 'DB_BACKUP_DIR']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function makeDeps(over = {}) {
    return {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      alerts: { trigger: vi.fn() },
      logActivity: vi.fn(),
      fs, path,
      tmpDir: workDir,
      ...over,
    };
  }

  it('последний локальный дамп: gunzip → проверка → ok, temp-файлы прибиты', async () => {
    const backupDir = path.join(workDir, 'backups');
    const tmpDir = path.join(workDir, 'tmp');
    fs.mkdirSync(backupDir); fs.mkdirSync(tmpDir);
    const dbFile = path.join(workDir, 'src.db');
    makeValidDbFile(dbFile);
    const gz = zlib.gzipSync(fs.readFileSync(dbFile));
    fs.writeFileSync(path.join(backupDir, '' + OLD + ''), gz);
    fs.writeFileSync(path.join(backupDir, '' + FRESH + ''), gz);   // новее — берётся он
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps({ tmpDir });
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(true);
    expect(r.source).toBe('local');
    expect(r.file).toBe('' + FRESH + '');
    expect(r.counts.clients).toBe(1);
    expect(deps.alerts.trigger).not.toHaveBeenCalled();
    expect(deps.logActivity).toHaveBeenCalledWith('system', 'info', 'backup_restore_test_ok',
      '' + FRESH + '', expect.stringContaining('OK'), expect.objectContaining({ source: 'local' }));
    expect(deps.logger.warn).toHaveBeenCalled();   // warn про локальный fallback
    // temp-файлы прибиты
    expect(fs.readdirSync(tmpDir).filter(f => f.startsWith('backup-test-'))).toHaveLength(0);
  });

  // 13.10: BACKUP_OFFSITE=off — облако выключено владельцем: rclone не
  // вызывается, локальная копия проверяется без warn и без DEGRADED.
  it('BACKUP_OFFSITE=off: rclone не трогаем даже при RCLONE_REMOTE, без DEGRADED', async () => {
    const backupDir = path.join(workDir, 'backups');
    const tmpDir = path.join(workDir, 'tmp');
    fs.mkdirSync(backupDir); fs.mkdirSync(tmpDir);
    const dbFile = path.join(workDir, 'src.db');
    makeValidDbFile(dbFile);
    fs.writeFileSync(path.join(backupDir, '' + FRESH + ''), zlib.gzipSync(fs.readFileSync(dbFile)));
    process.env.DB_BACKUP_DIR = backupDir;
    process.env.RCLONE_REMOTE = 'remote-that-must-not-be-called';
    const prev = process.env.BACKUP_OFFSITE;
    process.env.BACKUP_OFFSITE = 'off';
    try {
      const deps = makeDeps({ tmpDir });
      const r = await backupTest.create(deps).runOnce();
      expect(r.ok).toBe(true);
      expect(r.source).toBe('local');
      expect(r.checks.remote).toBe('disabled');
      expect(r.degraded).toBe(null);
      expect(deps.logger.warn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.BACKUP_OFFSITE; else process.env.BACKUP_OFFSITE = prev;
    }
  });

  it('дампов нет → ok:false + алерт backup_restore_failed', async () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir);   // пустой каталог
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps();
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('бэкапов нет');
    expect(deps.alerts.trigger).toHaveBeenCalledWith('backup_restore_failed',
      expect.objectContaining({ error: expect.stringContaining('бэкапов нет') }));
    expect(deps.logActivity).toHaveBeenCalledWith('system', 'critical', 'backup_restore_test_failed',
      null, expect.any(String), expect.objectContaining({ error: expect.stringContaining('бэкапов нет') }));
  });

  it('битый дамп (не sqlite после gunzip) → ok:false + алерт', async () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, '' + FRESH + ''), zlib.gzipSync(Buffer.from('junk junk junk')));
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps();
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(false);
    expect(deps.alerts.trigger).toHaveBeenCalledWith('backup_restore_failed',
      expect.objectContaining({ source: 'local', file: '' + FRESH + '' }));
  });

  // FIX-08 п.7 (18.09.2026): последний архив повреждён — итог остаётся явным
  // фейлом (не маскируется успехом старого), но пригодный предыдущий архив
  // указывается как recoverableFrom для оценки восстановимости.
  it('последний архив битый, предыдущий валидный → ok:false + recoverableFrom', async () => {
    const backupDir = path.join(workDir, 'backups');
    const tmpDir = path.join(workDir, 'tmp');
    fs.mkdirSync(backupDir); fs.mkdirSync(tmpDir);
    const dbFile = path.join(workDir, 'src.db');
    makeValidDbFile(dbFile);
    const good = zlib.gzipSync(fs.readFileSync(dbFile));
    fs.writeFileSync(path.join(backupDir, '' + OLD + ''), good);
    fs.writeFileSync(path.join(backupDir, '' + FRESH + ''), zlib.gzipSync(Buffer.from('corrupted')));
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps({ tmpDir });
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    // Повреждение последнего НЕ скрыто: фейл + алерт именно на последний файл.
    expect(r.ok).toBe(false);
    expect(r.recoverableFrom).toBe('' + OLD + '');
    expect(deps.alerts.trigger).toHaveBeenCalledWith('backup_restore_failed',
      expect.objectContaining({
        file: '' + FRESH + '',
        recoverableFrom: '' + OLD + '',
      }));
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('' + OLD + ''));
    // temp-файлы проверки предыдущих архивов прибиты
    expect(fs.readdirSync(tmpDir).filter(f => f.startsWith('backup-test-'))).toHaveLength(0);
  });

  // FIX-08 п.6: .partial/.tmp в каталоге бэкапов не считаются готовым бэкапом.
  it('stray .partial от прошлого crash не выбирается как бэкап', async () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz.999.123.partial'), 'not-ready');
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps();
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('бэкапов нет');
  });
});

// 2026-09-24 · DEEP-43: freshness/RPO — отдельная проверка, не часть integrity.
describe('DEEP-43: RPO и degraded-статус', () => {
  it('валидный, но СТАРЫЙ дамп (>RPO) — фейл «устарел», не ok', async () => {
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir);
    const dbFile = path.join(workDir, 'src.db');
    makeValidDbFile(dbFile);
    fs.writeFileSync(path.join(backupDir, OLD), zlib.gzipSync(fs.readFileSync(dbFile)));
    process.env.DB_BACKUP_DIR = backupDir;
    const job = backupTest.create({
      logger: { info() {}, warn() {}, error() {} },
      alerts: { trigger() {} }, logActivity() {}, fs, path,
      tmpDir: path.join(workDir, 'tmp'),
    });
    const r = await job.runOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('устарел');
  });
});
