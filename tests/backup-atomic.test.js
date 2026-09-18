import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
const require = createRequire(import.meta.url);
const { gzipFile } = require('../src/jobs/backup');
const { Writable } = require('stream');

describe('atomic backup compression', () => {
  it('keeps the previous archive when compression cannot start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-atomic-'));
    const source = path.join(dir, 'missing.db');
    const archive = source + '.gz';
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('previous')));
    const before = fs.readFileSync(archive);
    await expect(gzipFile(source)).rejects.toThrow();
    expect(fs.readFileSync(archive)).toEqual(before);
    expect(fs.readdirSync(dir).some(f => f.endsWith('.partial'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a valid archive and removes the source only after success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-atomic-'));
    const source = path.join(dir, 'snapshot.db');
    fs.writeFileSync(source, Buffer.from('snapshot-data'));
    const archive = await gzipFile(source);
    expect(zlib.gunzipSync(fs.readFileSync(archive)).toString()).toBe('snapshot-data');
    expect(fs.existsSync(source)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// FIX-08 (18.09.2026): инъекция fs-ошибок через io.fs — ошибка записи
// (ENOSPC), rename и fsync не должны портить прежний архив и исходный снимок;
// временный файл всегда убирается.
describe('FIX-08: gzipFile — инъекция ошибок', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fix08-'));
    const source = path.join(dir, 'snapshot.db');
    fs.writeFileSync(source, Buffer.from('snapshot-data'));
    const archive = source + '.gz';
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('previous-good')));
    return { dir, source, archive, before: fs.readFileSync(archive) };
  }

  function expectIntact({ dir, source, archive, before }) {
    expect(fs.readFileSync(archive)).toEqual(before);          // прежний архив побайтно цел
    expect(fs.readFileSync(source).toString()).toBe('snapshot-data'); // снимок сохранён
    expect(fs.readdirSync(dir).some(f => f.endsWith('.partial'))).toBe(false); // tmp убран
  }

  it('ENOSPC на записи → прежний архив и снимок целы, .partial удалён', async () => {
    const ctx = setup();
    const noSpaceFs = Object.create(fs);
    noSpaceFs.createWriteStream = () => new Writable({
      write(_chunk, _enc, cb) {
        const e = new Error('no space left on device');
        e.code = 'ENOSPC';
        cb(e);
      },
    });
    await expect(gzipFile(ctx.source, { fs: noSpaceFs })).rejects.toThrow(/ENOSPC|no space/);
    expectIntact(ctx);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('ошибка rename → публикация не состоялась, прежний архив цел', async () => {
    const ctx = setup();
    const noRenameFs = Object.create(fs);
    noRenameFs.renameSync = () => {
      const e = new Error('rename failed');
      e.code = 'EPERM';
      throw e;
    };
    await expect(gzipFile(ctx.source, { fs: noRenameFs })).rejects.toThrow(/rename failed/);
    expectIntact(ctx);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('реальная I/O-ошибка fsync файла (EIO) прерывает публикацию', async () => {
    const ctx = setup();
    const ioErrFs = Object.create(fs);
    ioErrFs.fsyncSync = () => {
      const e = new Error('input/output error');
      e.code = 'EIO';
      throw e;
    };
    await expect(gzipFile(ctx.source, { fs: ioErrFs })).rejects.toThrow(/input\/output/);
    expectIntact(ctx);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('неподдерживаемый fsync (EINVAL) — warn, но архив публикуется', async () => {
    const ctx = setup();
    const unsupportedFs = Object.create(fs);
    unsupportedFs.fsyncSync = () => {
      const e = new Error('invalid argument');
      e.code = 'EINVAL';
      throw e;
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const out = await gzipFile(ctx.source, { fs: unsupportedFs, logger });
    expect(zlib.gunzipSync(fs.readFileSync(out)).toString()).toBe('snapshot-data');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EINVAL'));
    expect(logger.error).not.toHaveBeenCalled();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('I/O-ошибка fsync каталога (EIO) не маскируется: error в лог, архив опубликован', async () => {
    const ctx = setup();
    let fsyncCalls = 0;
    const dirIoErrFs = Object.create(fs);
    dirIoErrFs.fsyncSync = (fd) => {
      fsyncCalls++;
      if (fsyncCalls === 1) return fs.fsyncSync(fd);   // fsync файла — успешно
      const e = new Error('input/output error');       // fsync каталога — EIO
      e.code = 'EIO';
      throw e;
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const out = await gzipFile(ctx.source, { fs: dirIoErrFs, logger });
    expect(zlib.gunzipSync(fs.readFileSync(out)).toString()).toBe('snapshot-data');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('fsync каталога'));
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });
});

// FIX-08, нагрузочный аспект (18.09.2026): сжатие потоковое — heap не растёт
// пропорционально размеру снимка. 64 MB несжимаемых (случайных) данных.
describe('FIX-08: потоковое сжатие — память', () => {
  it('64 MB снимок: прирост heap ограничен буферами потоков', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-load-'));
    const source = path.join(dir, 'big.db');
    const crypto = require('crypto');
    const fd = fs.openSync(source, 'w');
    for (let i = 0; i < 16; i++) fs.writeSync(fd, crypto.randomBytes(4 * 1024 * 1024));
    fs.closeSync(fd);

    let gc = null;
    try {
      require('v8').setFlagsFromString('--expose-gc');
      gc = require('vm').runInNewContext('gc');
    } catch (_) { /* gc недоступен — замер грубее */ }
    if (gc) gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const archive = await gzipFile(source);
    if (gc) gc();
    const heapAfter = process.memoryUsage().heapUsed;

    expect(fs.statSync(source.replace('.db', '.db.gz')).size).toBeGreaterThan(0);
    expect(zlib.gunzipSync(fs.readFileSync(archive)).length).toBe(64 * 1024 * 1024);
    // Потоковые буферы — единицы MB; рост к размеру БД (64 MB) означал бы
    // загрузку снимка в память целиком.
    expect(heapAfter - heapBefore).toBeLessThan(32 * 1024 * 1024);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
