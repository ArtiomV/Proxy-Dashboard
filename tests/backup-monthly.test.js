// D2 (2026-08): monthly-ротация бэкапов — снапшот 1-го числа копируется в
// monthly/ и хранится 12 штук. Тест чистой логики rotateMonthlyBackup
// (src/jobs/backup.js) на реальной tmp-ФС.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { rotateMonthlyBackup } = require('../src/jobs/backup.js');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-monthly-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function seedBackup(name) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, 'fake-db-' + name);
  return f;
}

describe('D2: rotateMonthlyBackup', () => {
  it('не 1-е число → null, monthly/ не создаётся', () => {
    const dest = seedBackup('dashboard-2026-08-15.db');
    expect(rotateMonthlyBackup(fs, path, tmp, dest, '2026-08-15')).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'monthly'))).toBe(false);
  });

  it('1-е число → копия в monthly/ с содержимым оригинала', () => {
    const dest = seedBackup('dashboard-2026-08-01.db');
    const r = rotateMonthlyBackup(fs, path, tmp, dest, '2026-08-01');
    expect(r.dest).toBe(path.join(tmp, 'monthly', 'dashboard-2026-08-01.db'));
    expect(fs.readFileSync(r.dest, 'utf8')).toBe('fake-db-dashboard-2026-08-01.db');
    expect(r.pruned).toBe(0);
  });

  it('хранит последние 12 — 13-й вытесняет самый старый', () => {
    const mDir = path.join(tmp, 'monthly');
    fs.mkdirSync(mDir);
    for (let m = 1; m <= 12; m++) {
      fs.writeFileSync(path.join(mDir, `dashboard-2025-${String(m).padStart(2, '0')}-01.db`), 'x');
    }
    const dest = seedBackup('dashboard-2026-01-01.db');
    const r = rotateMonthlyBackup(fs, path, tmp, dest, '2026-01-01');
    expect(r.pruned).toBe(1);
    const rest = fs.readdirSync(mDir).sort();
    expect(rest.length).toBe(12);
    expect(rest[0]).toBe('dashboard-2025-02-01.db');   // 2025-01 вытеснен
    expect(rest[rest.length - 1]).toBe('dashboard-2026-01-01.db');
  });

  it('чужие файлы в monthly/ ротацию не ломают и не считаются', () => {
    const mDir = path.join(tmp, 'monthly');
    fs.mkdirSync(mDir);
    fs.writeFileSync(path.join(mDir, 'README.txt'), 'keep me');
    const dest = seedBackup('dashboard-2026-08-01.db');
    const r = rotateMonthlyBackup(fs, path, tmp, dest, '2026-08-01');
    expect(r.pruned).toBe(0);
    expect(fs.existsSync(path.join(mDir, 'README.txt'))).toBe(true);
  });

  // DEEP-16 (18.09.2026): monthly-копия публикуется атомарно (временный файл
  // + rename) — обрыв copyFile не портит предыдущий monthly-архив.
  it('обрыв copyFile → прежний monthly-архив побайтно цел, .tmp убран', () => {
    const mDir = path.join(tmp, 'monthly');
    fs.mkdirSync(mDir);
    const mDest = path.join(mDir, 'dashboard-2026-08-01.db');
    fs.writeFileSync(mDest, 'previous-monthly-good');
    const dest = seedBackup('dashboard-2026-08-01.db');
    // Инъекция: копия обрывается посередине (записали кусок — и ENOSPC).
    const brokenFs = Object.create(fs);
    brokenFs.copyFileSync = (src, dst) => {
      fs.writeFileSync(dst, 'partial-');
      const e = new Error('no space left on device');
      e.code = 'ENOSPC';
      throw e;
    };
    expect(() => rotateMonthlyBackup(brokenFs, path, tmp, dest, '2026-08-01')).toThrow(/ENOSPC|no space/);
    expect(fs.readFileSync(mDest, 'utf8')).toBe('previous-monthly-good');
    expect(fs.readdirSync(mDir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('успешная публикация не оставляет .tmp-файлов', () => {
    const dest = seedBackup('dashboard-2026-08-01.db');
    rotateMonthlyBackup(fs, path, tmp, dest, '2026-08-01');
    const mDir = path.join(tmp, 'monthly');
    expect(fs.readdirSync(mDir).filter(f => f.includes('.tmp'))).toHaveLength(0);
  });
});
