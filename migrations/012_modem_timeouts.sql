CREATE TABLE IF NOT EXISTS modem_timeouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  nick TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_min REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mt_nick ON modem_timeouts(nick);
CREATE INDEX IF NOT EXISTS idx_mt_started ON modem_timeouts(started_at);
CREATE INDEX IF NOT EXISTS idx_mt_open ON modem_timeouts(ended_at) WHERE ended_at IS NULL;
