-- Performance indexes spotted in audit. Covers the most frequent WHERE/ORDER BY
-- patterns in server.js without changing semantics.

-- billing_ledger: many endpoints filter by (type, date >= ?) — finance_dashboard
-- MRR / churn / NRR all do this. Existing idx_ledger_client_type alone forces
-- a full scan over date.
CREATE INDEX IF NOT EXISTS idx_ledger_type_date ON billing_ledger(type, date);

-- traffic_hourly: heatmap + daily-summary queries do
--   WHERE client_name = ? AND hour_start >= ?  ORDER BY hour_start
-- Existing idx_traffic_hourly_client(client_name, hour_start) was created;
-- this one is a no-op if already present but kept for safety.
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_client_hour
  ON traffic_hourly(client_name, hour_start);

-- proxy_checks: dashboards filter by recent window.
CREATE INDEX IF NOT EXISTS idx_pc_checked_desc ON proxy_checks(checked_at DESC);

-- proxy_checks: getProxyCheckSummary() ran two FULL-TABLE scans on every
-- /api/admin/data hit (~4s once proxy_checks reached ~550k rows — the entire
-- "сайт долго грузится" cause). These covering indexes make both index-only:
--   • "last check per modem":   SELECT MAX(id) ... GROUP BY nick, server_name
--   • "7-day summary per modem": GROUP BY nick, server_name with AVG/COUNT/SUM
-- Measured: 1861ms→61ms and 2132ms→59ms.
CREATE INDEX IF NOT EXISTS idx_pc_nick_srv_id ON proxy_checks(nick, server_name, id);
CREATE INDEX IF NOT EXISTS idx_pc_nick_srv_checked
  ON proxy_checks(nick, server_name, checked_at, total_ms, error);

-- The planner only uses these covering indexes once it has table statistics —
-- without ANALYZE it keeps a full-scan plan (the queries stayed 2s after the
-- index alone; ANALYZE dropped them to ~50ms). Stamp stats here for fresh DBs;
-- `PRAGMA optimize` on startup (server.js) keeps them fresh as the table grows.
ANALYZE proxy_checks;

-- db_audit: investigative queries by (table_name, row_id, ts).
CREATE INDEX IF NOT EXISTS idx_dba_table_row_ts ON db_audit(table_name, row_id, ts);

-- rotation_log: per-modem queries (server_name, nick, started_at).
CREATE INDEX IF NOT EXISTS idx_rotlog_modem_started
  ON rotation_log(server_name, nick, started_at);
