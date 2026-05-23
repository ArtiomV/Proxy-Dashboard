-- 029: Load-simulator schema.
--
-- The simulator drives synthetic traffic through a designated "test pool" of
-- modems to reproduce client-side complaints like "timeouts kick in when I
-- ramp up worker count." It's deliberately isolated from production traffic:
-- only modems flagged `is_test_pool = 1` can be selected as targets.
--
--   simulator_profiles  — reusable test configurations (target URLs,
--                          concurrency mode, duration, thresholds)
--   simulator_runs      — one row per execution; carries snapshot of profile
--                          and final summary stats
--   simulator_samples   — one row per individual HTTP request; allows post-hoc
--                          drilldown into per-modem behavior, breaking-point
--                          analysis, percentile recalculation
--
-- Pruning: a daily cron in server.js deletes runs (and CASCADE samples) older
-- than 30 days to keep DB size bounded.

ALTER TABLE modem_meta ADD COLUMN is_test_pool INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_modem_meta_test_pool ON modem_meta(is_test_pool) WHERE is_test_pool = 1;

CREATE TABLE IF NOT EXISTS simulator_profiles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS simulator_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id    INTEGER REFERENCES simulator_profiles(id) ON DELETE SET NULL,
  profile_name  TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  status        TEXT NOT NULL DEFAULT 'running',  -- running | completed | aborted | error
  config_json   TEXT NOT NULL,
  summary_json  TEXT,
  started_by    TEXT,
  error_msg     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sim_runs_status ON simulator_runs(status);
CREATE INDEX IF NOT EXISTS idx_sim_runs_started ON simulator_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS simulator_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES simulator_runs(id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,        -- ms since run start (small int, fits 31 bits up to ~24 days)
  worker_id    INTEGER NOT NULL,
  modem_nick   TEXT NOT NULL,
  server_name  TEXT NOT NULL,
  status       TEXT NOT NULL,           -- success | timeout | http_error | conn_error
  http_status  INTEGER,
  total_ms     INTEGER NOT NULL,
  connect_ms   INTEGER,
  ttfb_ms      INTEGER,                 -- time-to-first-byte (useful for diagnosing slow-body issue)
  bytes        INTEGER NOT NULL DEFAULT 0,
  url          TEXT,
  error_msg    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sim_samples_run_ts ON simulator_samples(run_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_sim_samples_run_modem ON simulator_samples(run_id, modem_nick);
