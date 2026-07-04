-- 038_sales_jobs.sql
-- Background-job tracking for the AI sales bots admin panel. The agent runs
-- (look-alike research, contact finding) take minutes, so the HTTP endpoint
-- starts a job, returns its id, and the panel polls status. Single-process
-- app → at most one job runs at a time. See src/routes/ai-sales.js.
CREATE TABLE IF NOT EXISTS sales_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  bot         TEXT NOT NULL DEFAULT '',        -- lookalikes | contacts | push
  params      TEXT NOT NULL DEFAULT '',        -- JSON of run params
  status      TEXT NOT NULL DEFAULT 'running', -- running | done | error
  progress    TEXT NOT NULL DEFAULT '',        -- human-readable last progress line
  done        INTEGER NOT NULL DEFAULT 0,      -- items processed
  total       INTEGER NOT NULL DEFAULT 0,      -- items planned
  result      TEXT NOT NULL DEFAULT '',        -- JSON summary
  error       TEXT NOT NULL DEFAULT '',
  started_by  TEXT NOT NULL DEFAULT '',        -- admin login
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_jobs_status ON sales_jobs(status);
