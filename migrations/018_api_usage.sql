-- Track API usage per client (which clients hit /api/v1/*, response times, errors).
-- Retention controlled via appSettings.retention_api_usage (default 30 days).
CREATE TABLE IF NOT EXISTS api_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT,
  client_name      TEXT,
  api_key_prefix   TEXT,
  endpoint         TEXT,
  method           TEXT,
  status_code      INTEGER,
  response_time_ms INTEGER,
  user_agent       TEXT,
  ip               TEXT,
  timestamp        TEXT DEFAULT CURRENT_TIMESTAMP,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_usage_client ON api_usage(client_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(timestamp);
