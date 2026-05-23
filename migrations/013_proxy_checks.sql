DROP TABLE IF EXISTS modem_timeouts;

CREATE TABLE IF NOT EXISTS proxy_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  nick TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  connect_ms INTEGER,
  total_ms INTEGER,
  status_code INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pc_nick ON proxy_checks(nick);
CREATE INDEX IF NOT EXISTS idx_pc_checked ON proxy_checks(checked_at);
