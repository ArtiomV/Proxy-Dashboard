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
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-08-16.db.gz'), gz);
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-08-23.db.gz'), gz);   // новее — берётся он
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps({ tmpDir });
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(true);
    expect(r.source).toBe('local');
    expect(r.file).toBe('dashboard-2026-08-23.db.gz');
    expect(r.counts.clients).toBe(1);
    expect(deps.alerts.trigger).not.toHaveBeenCalled();
    expect(deps.logActivity).toHaveBeenCalledWith('system', 'info', 'backup_restore_test_ok',
      'dashboard-2026-08-23.db.gz', expect.stringContaining('OK'), expect.objectContaining({ source: 'local' }));
    expect(deps.logger.warn).toHaveBeenCalled();   // warn про локальный fallback
    // temp-файлы прибиты
    expect(fs.readdirSync(tmpDir).filter(f => f.startsWith('backup-test-'))).toHaveLength(0);
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
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-08-23.db.gz'), zlib.gzipSync(Buffer.from('junk junk junk')));
    process.env.DB_BACKUP_DIR = backupDir;

    const deps = makeDeps();
    const job = backupTest.create(deps);
    const r = await job.runOnce();
    expect(r.ok).toBe(false);
    expect(deps.alerts.trigger).toHaveBeenCalledWith('backup_restore_failed',
      expect.objectContaining({ source: 'local', file: 'dashboard-2026-08-23.db.gz' }));
  });
});
