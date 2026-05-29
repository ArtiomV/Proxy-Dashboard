-- 030: Stage 17 — Daily health snapshots + operator-country mapping.
--
-- Two independent tables, both populated by background jobs but readable from
-- API endpoints.
--
-- modem_health_daily
--   One row per (date, server_name, imei). Written by a daily cron at 23:55 MSK
--   that snapshots the last full day's health metrics. Used by the new
--   per-modem 30-day timeline in the «Здоровье» tab.
--
--   `score` is the same 0–100 integer the live /api/analytics/modem_health
--   endpoint computes. Storing it pre-aggregated keeps the timeline render
--   cheap (no need to rerun the heavy CTEs for each historical day).
--
--   Backfill: a one-shot fill at app boot computes scores for the trailing
--   30 days from existing proxy_checks + uptime_tracking + rotation_log so
--   the timeline is populated immediately, not only after 30 cron firings.
--
-- operator_country_map
--   Persistent mapping operator_name → country_code (e.g. 'orange ro' → 'RO').
--   Two sources:
--     'auto'   — inferred from the server the operator was first seen on
--                (servers carry a country in kv_store; new operators inherit).
--     'manual' — admin override via the new «Операторы и страны» settings card.
--   Manual wins over auto. Auto rows are upserted whenever the modem-poll
--   loop sees a new operator on a server with a known country.
--
--   We deliberately store the operator name as the canonical normalized form
--   produced by `normalizeOperator()` so the FE can join without re-normalizing.

CREATE TABLE IF NOT EXISTS modem_health_daily (
  date         TEXT NOT NULL,           -- YYYY-MM-DD (MSK calendar day)
  server_name  TEXT NOT NULL,
  imei         TEXT NOT NULL,
  nick         TEXT,                    -- denormalized for cheap display joins
  score        INTEGER,                 -- 0–100, NULL when no data that day
  error_pct    REAL,                    -- 0–100
  latency_ms   INTEGER,                 -- avg latency from proxy_checks
  uptime_pct   REAL,                    -- 0–100, from uptime_tracking daily bucket
  total_checks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, server_name, imei)
);
CREATE INDEX IF NOT EXISTS idx_health_daily_modem ON modem_health_daily(server_name, imei, date DESC);
CREATE INDEX IF NOT EXISTS idx_health_daily_date ON modem_health_daily(date DESC);

CREATE TABLE IF NOT EXISTS operator_country_map (
  operator     TEXT PRIMARY KEY,        -- normalized form (lowercase post-trim)
  country      TEXT NOT NULL,           -- ISO-2 (RO, MD, RU…)
  source       TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  first_seen_on TEXT                    -- server_name where first detected (for audit)
);
CREATE INDEX IF NOT EXISTS idx_op_country_country ON operator_country_map(country);
