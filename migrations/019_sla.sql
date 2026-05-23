-- Phase 4: per-client SLA tracking
ALTER TABLE clients ADD COLUMN sla_uptime_pct REAL DEFAULT 99.0;
ALTER TABLE clients ADD COLUMN sla_max_latency_ms INTEGER DEFAULT 1000;
ALTER TABLE clients ADD COLUMN sla_max_error_pct REAL DEFAULT 5.0;
ALTER TABLE clients ADD COLUMN sla_auto_credit INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS sla_violations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT,
  date             TEXT,
  metric           TEXT,       -- uptime | latency | errors
  expected         REAL,
  actual           REAL,
  credited_amount  REAL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sla_violations_client ON sla_violations(client_id, date);
CREATE INDEX IF NOT EXISTS idx_sla_violations_date ON sla_violations(date);
