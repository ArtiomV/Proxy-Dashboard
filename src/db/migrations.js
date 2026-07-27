'use strict';
//
// src/db/migrations.js — раннер SQL-миграций из migrations/ (Stage 9, хвост
// DoD #1; extracted from server.js). Контракт:
//   • каждый файл применяется один раз (учёт в таблице _migrations);
//   • файл гоняется в ОДНОЙ транзакции: небезопасная ошибка = откат и
//     файл НЕ помечается применённым (fail-fast, старт абортируется);
//   • «доброкачественные» ошибки (уже применённые ALTER/CREATE IF NOT EXISTS)
//     терпимы только в per-statement фолбэке; `no such column` — НЕ benign
//     (P1-3: значит баг в самой миграции).

// Benign SQLite errors we can safely ignore when re-running migrations:
// re-applied ALTER TABLE ADD COLUMN, re-applied CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS,
// and similar "already applied" cases. Anything else aborts the migration (fail-fast).
const BENIGN_MIGRATION_ERRORS = [
  /duplicate column name/i,   // re-applied ALTER TABLE ADD COLUMN
  /already exists/i,          // re-applied CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS
  // P1-3: `no such column` is NOT benign. A migration only runs while it's not in
  // _migrations (every run here is a first apply), so this error means the
  // migration's own SQL is buggy — swallowing it would silently skip the intended
  // change AND mark the file applied, so it never re-runs. Fail fast instead. (No
  // migration uses DROP/RENAME COLUMN, so nothing legitimately hits this on re-run.)
];
function isBenignMigrationError(err) {
  const msg = (err && err.message) || String(err);
  return BENIGN_MIGRATION_ERRORS.some(rx => rx.test(msg));
}

// Run SQL migrations from `migrationsDir` against `db` (better-sqlite3).
// Throws on the first non-benign failure — caller решает судьбу стартапа.
function runMigrations(db, { migrationsDir, logger, fs, path }) {
  const _fs = fs || require('fs');
  const _path = path || require('path');
  const _logger = logger || console;
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  if (!_fs.existsSync(migrationsDir)) return;
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  const files = _fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = _fs.readFileSync(_path.join(migrationsDir, file), 'utf8');
    try {
      // Run the whole migration in a single atomic transaction.
      // Pre-scan: if the whole file runs as one exec and fails with a non-benign
      // error, roll back AND don't mark as applied.
      db.transaction(() => {
        try {
          db.exec(sql);
        } catch (_) {
          // Fall back to per-statement execution only to tolerate benign
          // "already applied" errors (so re-runs work). Anything else re-throws.
          for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
            try { db.exec(stmt); }
            catch (stmtErr) {
              if (!isBenignMigrationError(stmtErr)) {
                throw new Error(`statement failed: ${stmtErr.message}\n  SQL: ${stmt.slice(0, 200)}`);
              }
            }
          }
        }
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
      _logger.info(`[Migration] Applied: ${file}`);
    } catch (e) {
      // Hard fail: migration left DB unchanged; surface the actual error.
      _logger.error(`[Migration] FAILED ${file}:`, e.message);
      // Don't silently continue — abort startup so deploy is visibly broken.
      throw new Error(`Migration ${file} failed — aborting startup. ${e.message}`);
    }
  }
}

module.exports = { runMigrations, isBenignMigrationError, BENIGN_MIGRATION_ERRORS };
