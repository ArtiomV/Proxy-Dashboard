-- 005: extended columns for external_proxies
-- Base table created here (not in schema.sql) so fresh DBs have something to
-- ALTER; on prod DBs the CREATE below is a no-op and the columns already exist
-- (benign duplicate-column errors are tolerated by the runner)
-- Table itself was later dropped by migration 055 (feature removed, ТЗ C6)

CREATE TABLE IF NOT EXISTS external_proxies (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  label TEXT DEFAULT '',
  protocol TEXT DEFAULT 'HTTP',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  login TEXT DEFAULT '',
  password TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

ALTER TABLE external_proxies ADD COLUMN change_ip_url TEXT DEFAULT '';
ALTER TABLE external_proxies ADD COLUMN valid_until TEXT;
ALTER TABLE external_proxies ADD COLUMN billing_type TEXT DEFAULT 'monthly';
ALTER TABLE external_proxies ADD COLUMN price REAL DEFAULT 0;
ALTER TABLE external_proxies ADD COLUMN traffic_used_gb REAL DEFAULT 0;
