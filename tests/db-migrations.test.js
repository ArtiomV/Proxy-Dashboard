// Stage 9 (DoD #1 tail): раннер миграций вынесен в src/db/migrations.js.
// Контракт: один прогон на файл (учёт в _migrations), транзакционность
// (небезопасная ошибка = откат без маркера), benign-фолбэк per-statement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { runMigrations, isBenignMigrationError } = require('../src/db/migrations.js');

const silent = { info() {}, warn() {}, error() {} };
let dir, db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdmig-'));
  db = new Database(':memory:');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

const write = (name, sql) => fs.writeFileSync(path.join(dir, name), sql);
const applied = () => db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name);

describe('runMigrations (src/db/migrations.js)', () => {
  it('применяет файлы по порядку и пишет маркеры; повторный прогон — no-op', () => {
    write('001_a.sql', 'CREATE TABLE t1 (id INTEGER);');
    write('002_b.sql', 'CREATE TABLE t2 (id INTEGER);');
    runMigrations(db, { migrationsDir: dir, logger: silent });
    expect(applied()).toEqual(['001_a.sql', '002_b.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t2'").get()).toBeTruthy();
    // повторный прогон: ничего нового не применяется
    db.prepare('DROP TABLE t2').run();
    runMigrations(db, { migrationsDir: dir, logger: silent });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t2'").get()).toBeFalsy();
  });

  it('benign-ошибка в per-statement фолбэке терпима (duplicate column)', () => {
    write('001_a.sql', 'CREATE TABLE t1 (id INTEGER);');
    runMigrations(db, { migrationsDir: dir, logger: silent });
    fs.rmSync(path.join(dir, '001_a.sql'));
    // миграция, которая целиком падает на exec (второй ALTER), но per-statement benign
    write('002_b.sql', 'ALTER TABLE t1 ADD COLUMN c TEXT;\nALTER TABLE t1 ADD COLUMN c TEXT;');
    // файл целиком: первая же копия применится, вторая даст duplicate → весь exec падает,
    // но транзакция exec-фолбэка уже отработала... поэтому файл специально ловим:
    // exec всего файла упадёт на втором ALTER; per-statement: первая пройдёт (уже есть), вторая — duplicate (benign)
    runMigrations(db, { migrationsDir: dir, logger: silent });
    expect(applied()).toEqual(['001_a.sql', '002_b.sql']);
    expect(db.prepare('PRAGMA table_info(t1)').all().some(c => c.name === 'c')).toBe(true);
  });

  it('небезопасная ошибка (no such column) → бросок, откат, файл НЕ помечен', () => {
    write('001_bad.sql', 'CREATE TABLE ok_t (id INTEGER);\nUPDATE no_such_table SET x = 1;');
    expect(() => runMigrations(db, { migrationsDir: dir, logger: silent })).toThrow(/001_bad\.sql/);
    expect(applied()).toEqual([]);
    // транзакция откатилась: даже CREATE TABLE не остался
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_t'").get()).toBeFalsy();
  });

  it('isBenignMigrationError: duplicate/already exists — да; no such column — нет (P1-3)', () => {
    expect(isBenignMigrationError(new Error('duplicate column name: c'))).toBe(true);
    expect(isBenignMigrationError(new Error('table t already exists'))).toBe(true);
    expect(isBenignMigrationError(new Error('no such column: x'))).toBe(false);
  });
});
