-- 048: traffic reconciliation (WP1 ProxySmart data integration).
-- Nightly job compares our billed daily_traffic rows against the box's own
-- pmacct counters (/apix/get_counters_port) over the same box-local day
-- window. Rows are written per (port_key, date) where port_key equals
-- daily_traffic.port_name ("S2_portXYZ") and date equals the MSK billing
-- date label used by daily_traffic.

CREATE TABLE IF NOT EXISTS traffic_recon (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  server_name  TEXT NOT NULL,
  port_key     TEXT NOT NULL,
  client_name  TEXT DEFAULT '',
  ps_in        INTEGER DEFAULT 0,
  ps_out       INTEGER DEFAULT 0,
  our_in       INTEGER DEFAULT 0,
  our_out      INTEGER DEFAULT 0,
  diff_pct     REAL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(port_key, date)
);
CREATE INDEX IF NOT EXISTS idx_traffic_recon_date ON traffic_recon(date);
CREATE INDEX IF NOT EXISTS idx_traffic_recon_server ON traffic_recon(server_name, date);
