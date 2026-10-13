// FIX-08/DEEP-16 (18.09.2026): runDbBackup целиком — верификация снимка
// quick_check (DEEP-16), блокировка от двух одновременных прогонов (п.5),
// ротация daily с защитой последней пригодной копии (п.8, pruneOldBackups).
// Облако не дёргаем: RCLONE_REMOTE снят, rclone-скрипт падает с warn —
// на итог бэкапа это не влияет (best-effort, C7).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const backup = require('../src/jobs/backup.js');

let workDir;
const savedEnv = {};

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-run-'));
  for (const k of ['DB_BACKUP_DIR', 'RCLONE_REMOTE']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ['DB_BACKUP_DIR', 'RCLONE_REMOTE']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

function makeTemplateDb(file) {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE clients (id INTEGER);
    CREATE TABLE billing_ledger (id INTEGER);
    CREATE TABLE speed_monitor (id INTEGER);
    INSERT INTO clients VALUES (1);
  `);
  d.close();
}

function makeDeps(over = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logActivity: vi.fn(),
    fs, path,
    ...over,
  };
}

describe('FIX-08/DEEP-16: runDbBackup', () => {
  // 13.10: BACKUP_OFFSITE=off — выгрузку в облако не пытаемся (у владельца
  // свой автобэкап), warn'ов про rclone нет.
  it('BACKUP_OFFSITE=off: offsite пропускается без warn', async () => {
    const dbFile = path.join(workDir, 'dashboard.db');
    makeTemplateDb(dbFile);
    process.env.DB_BACKUP_DIR = path.join(workDir, 'backups');
    const prev = process.env.BACKUP_OFFSITE;
    process.env.BACKUP_OFFSITE = 'off';
    try {
      const deps = makeDeps({ db: new Database(dbFile) });
      await backup.create(deps).runDbBackup();
      expect(deps.logger.error).not.toHaveBeenCalled();
      expect(deps.logger.warn).not.toHaveBeenCalled();
      expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('offsite upload skipped'));
    } finally {
      if (prev === undefined) delete process.env.BACKUP_OFFSITE; else process.env.BACKUP_OFFSITE = prev;
    }
  });

  it('успешный прогон: снимок → quick_check → gzip → публикация, .gz валиден', async () => {
    const dbFile = path.join(workDir, 'dashboard.db');
    makeTemplateDb(dbFile);
    const backupDir = path.join(workDir, 'backups');
    process.env.DB_BACKUP_DIR = backupDir;
    const deps = makeDeps({ db: new Database(dbFile) });
    const job = backup.create(deps);

    await job.runDbBackup();

    expect(deps.logger.error).not.toHaveBeenCalled();
    const ts = new Date().toISOString().slice(0, 10);
    const gz = path.join(backupDir, `dashboard-${ts}.db.gz`);
    expect(fs.existsSync(gz)).toBe(true);
    // Архив распаковывается в валидную SQLite с таблицей clients.
    const restored = path.join(workDir, 'restored.db');
    fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(gz)));
    const rdb = new Database(restored, { readonly: true });
    expect(Object.values(rdb.pragma('quick_check')[0])[0]).toBe('ok');
    expect(rdb.prepare('SELECT COUNT(*) n FROM clients').get().n).toBe(1);
    rdb.close();
    deps.db.close();
  });

  it('DEEP-16: quick_check снимка не «ok» → фейл, .gz не публикуется, прежний архив цел, проверочная БД закрыта', async () => {
    const dbFile = path.join(workDir, 'dashboard.db');
    makeTemplateDb(dbFile);
    const backupDir = path.join(workDir, 'backups');
    fs.mkdirSync(backupDir);
    process.env.DB_BACKUP_DIR = backupDir;
    // Прежняя пригодная копия — не должна пострадать.
    const prevGz = path.join(backupDir, 'dashboard-2026-09-17.db.gz');
    fs.writeFileSync(prevGz, zlib.gzipSync(Buffer.from('previous-good')));
    const before = fs.readFileSync(prevGz);

    // Инъекция: проверочная БД сообщает о повреждении снимка.
    let closed = false;
    class CorruptDb {
      constructor() {}
      pragma() { return [{ quick_check: 'corruption on page 7' }]; }
      prepare() { throw new Error('should not reach prepare'); }
      close() { closed = true; }
    }
    const deps = makeDeps({ db: new Database(dbFile), Database: CorruptDb });
    const job = backup.create(deps);

    await job.runDbBackup();

    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('quick_check'));
    expect(deps.logActivity).toHaveBeenCalledWith('system', 'critical', 'db_backup_failed',
      null, expect.any(String), expect.objectContaining({ error: expect.stringContaining('quick_check') }));
    expect(closed).toBe(true);   // проверочная БД закрыта через finally
    expect(fs.readFileSync(prevGz)).toEqual(before);
    expect(fs.readdirSync(backupDir).filter(f => f.endsWith('.partial'))).toHaveLength(0);
    deps.db.close();
  });

  it('DEEP-16: ошибка запроса при верификации → проверочная БД закрыта через finally', async () => {
    const dbFile = path.join(workDir, 'dashboard.db');
    makeTemplateDb(dbFile);
    const backupDir = path.join(workDir, 'backups');
    process.env.DB_BACKUP_DIR = backupDir;
    let closed = false;
    class ThrowingDb {
      constructor() {}
      pragma() { return [{ quick_check: 'ok' }]; }
      prepare() { throw new Error('simulated query failure'); }
      close() { closed = true; }
    }
    const deps = makeDeps({ db: new Database(dbFile), Database: ThrowingDb });
    const job = backup.create(deps);

    await job.runDbBackup();

    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('simulated query failure'));
    expect(closed).toBe(true);
    deps.db.close();
  });

  it('FIX-08 п.5: два одновременных прогона — второй явно пропущен', async () => {
    const dbFile = path.join(workDir, 'dashboard.db');
    makeTemplateDb(dbFile);
    const backupDir = path.join(workDir, 'backups');
    process.env.DB_BACKUP_DIR = backupDir;
    // Медленный снимок: блокировка должна держаться весь цикл.
    const slowDb = {
      backup: async (dest) => {
        fs.copyFileSync(dbFile, dest);
        await new Promise(r => setTimeout(r, 100));
      },
    };
    const deps = makeDeps({ db: slowDb });
    const job = backup.create(deps);

    const first = job.runDbBackup();
    const second = await job.runDbBackup();
    expect(second).toEqual({ skipped: 'already_running' });
    await first;
    expect(deps.logger.error).not.toHaveBeenCalled();
    const ts = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(backupDir, `dashboard-${ts}.db.gz`))).toBe(true);
  });
});

// FIX-08 п.8 (18.09.2026): сроки хранения не сокращаем (7 дней), но последнюю
// пригодную копию не удаляем, даже если ВСЕ архивы старше cutoff.
describe('FIX-08 п.8: pruneOldBackups — защита последней копии', () => {
  it('все архивы старше cutoff → самый новый всё равно остаётся', () => {
    const dir = path.join(workDir, 'b');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'dashboard-2026-08-01.db.gz'), 'a');
    fs.writeFileSync(path.join(dir, 'dashboard-2026-08-02.db.gz'), 'b');
    const r = backup.pruneOldBackups(fs, path, dir, 7, Date.parse('2026-09-18T00:00:00Z'));
    expect(r.pruned).toBe(1);
    expect(fs.existsSync(path.join(dir, 'dashboard-2026-08-02.db.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dashboard-2026-08-01.db.gz'))).toBe(false);
  });

  it('свежий архив есть → старые удаляются вместе с sidecar-файлами', () => {
    const dir = path.join(workDir, 'b');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-01.db.gz'), 'old');
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-01.db-wal'), 'wal');
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-01.db-shm'), 'shm');
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-17.db.gz'), 'fresh');
    const r = backup.pruneOldBackups(fs, path, dir, 7, Date.parse('2026-09-18T00:00:00Z'));
    expect(r.pruned).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['dashboard-2026-09-17.db.gz']);
  });

  it('.partial/.tmp ротация не трогает — это не файлы этой операции', () => {
    const dir = path.join(workDir, 'b');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-01.db.gz.123.456.partial'), 'stale');
    fs.writeFileSync(path.join(dir, 'dashboard-2026-09-17.db.gz'), 'fresh');
    backup.pruneOldBackups(fs, path, dir, 7, Date.parse('2026-09-18T00:00:00Z'));
    expect(fs.existsSync(path.join(dir, 'dashboard-2026-09-01.db.gz.123.456.partial'))).toBe(true);
  });
});
