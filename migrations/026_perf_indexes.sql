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

-- db_audit: investigative queries by (table_name, row_id, ts).
CREATE INDEX IF NOT EXISTS idx_dba_table_row_ts ON db_audit(table_name, row_id, ts);

-- rotation_log: per-modem queries (server_name, nick, started_at).
CREATE INDEX IF NOT EXISTS idx_rotlog_modem_started
  ON rotation_log(server_name, nick, started_at);
