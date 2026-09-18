-- 2026-09-18 · DEEP-23 (§ FIX-SPEC): durable-учёт суточного биллинга.
-- billing_runs — прогон за расчётную дату; billing_jobs — задание
-- client/date с durable статусом и тарифным контекстом на момент расчёта.
-- Статусы заданий: pending (создано, списание не подтверждено), done
-- (списано), zero (нулевое списание — завершено, НЕ retry), no_data
-- (недостаток достоверных данных — retry), failed (ошибка — retry),
-- skipped (политика: blocked/paused/insufficient — не retry).
-- Восстановление ищет незавершённые задания (pending/failed/no_data), а не
-- возраст traffic snapshot; повтор сохраняет дату и контекст из context.
CREATE TABLE IF NOT EXISTS billing_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_date TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'daily',
  status       TEXT NOT NULL DEFAULT 'running',   -- running | completed | failed
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  summary      TEXT,
  UNIQUE(billing_date, kind)
);

CREATE TABLE IF NOT EXISTS billing_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_date TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'daily',
  status       TEXT NOT NULL DEFAULT 'pending',
  amount       REAL,
  context      TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(billing_date, client_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_billing_jobs_open
  ON billing_jobs(status, billing_date)
  WHERE status IN ('pending', 'failed', 'no_data');
