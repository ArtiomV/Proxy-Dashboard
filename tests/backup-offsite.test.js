// DEEP-16 (18.09.2026): scripts/backup-offsite.sh выгружает в облако только
// ТОЧНЫЕ имена опубликованных архивов через manifest (--files-from), а не
// wildcard dashboard-*.db* (он захватывал .db-wal/.db-shm/.partial).
// Облако не дёргаем: rclone подменён заглушкой в PATH, которая записывает
// argv и содержимое manifest; проверяем список входных файлов.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup-offsite.sh');

let workDir, backupDir, binDir, capturedDir;
const savedEnv = {};

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-offsite-'));
  backupDir = path.join(workDir, 'backups');
  binDir = path.join(workDir, 'bin');
  capturedDir = path.join(workDir, 'captured');
  fs.mkdirSync(backupDir); fs.mkdirSync(binDir); fs.mkdirSync(capturedDir);
  // Заглушка rclone: сохраняет argv и содержимое --files-from.
  fs.writeFileSync(path.join(binDir, 'rclone'), `#!/bin/sh
echo "$@" > "${capturedDir}/argv"
prev=""
for a in "$@"; do
  if [ "$prev" = "--files-from" ]; then cp "$a" "${capturedDir}/files-from"; fi
  prev="$a"
done
exit 0
`, { mode: 0o755 });
  for (const k of ['RCLONE_REMOTE', 'RCLONE_DEST_PREFIX']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ['RCLONE_REMOTE', 'RCLONE_DEST_PREFIX']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

function runScript(env = {}) {
  return execFileSync('bash', [SCRIPT, backupDir], {
    env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, RCLONE_REMOTE: 'testremote', ...env },
    encoding: 'utf8',
  });
}

function manifest() {
  const f = path.join(capturedDir, 'files-from');
  expect(fs.existsSync(f)).toBe(true);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).sort();
}

describe('DEEP-16: backup-offsite.sh — manifest точных имён', () => {
  it('выгружаются только опубликованные .db.gz (daily + monthly), без wildcard', () => {
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-17.db.gz'), 'gz1');
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz'), 'gz2');
    fs.mkdirSync(path.join(backupDir, 'monthly'));
    fs.writeFileSync(path.join(backupDir, 'monthly', 'dashboard-2026-09-01.db.gz'), 'gzm');
    // Мусор, который wildcard dashboard-*.db* захватил бы:
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz.123.456.partial'), 'partial');
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db-wal'), 'wal');
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db-shm'), 'shm');
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz.tmp'), 'tmp');
    fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'other');

    const out = runScript();
    expect(out).toContain('offsite OK');
    // Никаких glob-включений — только --files-from.
    const argv = fs.readFileSync(path.join(capturedDir, 'argv'), 'utf8');
    expect(argv).toContain('--files-from');
    expect(argv).not.toContain('--include');
    expect(manifest()).toEqual([
      'dashboard-2026-09-17.db.gz',
      'dashboard-2026-09-18.db.gz',
      'monthly/dashboard-2026-09-01.db.gz',
    ]);
  });

  it('stray .partial от прошлого запуска в облако не попадает', () => {
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz'), 'gz');
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-17.db.gz.777.111.partial'), 'stale');
    runScript();
    expect(manifest()).toEqual(['dashboard-2026-09-18.db.gz']);
  });

  it('legacy .db: готовый (старый, без sidecar) выгружается; живой/sidecar — нет', () => {
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    const ready = path.join(backupDir, 'dashboard-2025-01-01.db');
    fs.writeFileSync(ready, 'legacy');
    fs.utimesSync(ready, old, old);
    const withWal = path.join(backupDir, 'dashboard-2025-02-01.db');
    fs.writeFileSync(withWal, 'legacy2');
    fs.utimesSync(withWal, old, old);
    fs.writeFileSync(withWal + '-wal', 'wal');   // sidecar → готовность не подтверждена
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db'), 'fresh'); // mtime сейчас → пишется

    runScript();
    expect(manifest()).toEqual(['dashboard-2025-01-01.db']);
  });

  it('нет опубликованных архивов → понятная ошибка, rclone не вызывается', () => {
    fs.writeFileSync(path.join(backupDir, 'dashboard-2026-09-18.db.gz.1.2.partial'), 'partial');
    let err = null;
    try { runScript(); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.stderr)).toContain('не найдено');
    expect(fs.existsSync(path.join(capturedDir, 'argv'))).toBe(false);
  });
});
