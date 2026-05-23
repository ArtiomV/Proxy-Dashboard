-- Raw per-modem domain hit counts from /apix/top_hosts, refreshed every
-- aggregation cycle. Preserves dimensions lost by the old flattened kv cache:
-- which server / modem / operator / client actually hit which host.
CREATE TABLE IF NOT EXISTS top_hosts_detail (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at  TEXT NOT NULL,   -- when this aggregation ran
  server_name  TEXT NOT NULL,
  port_id      TEXT NOT NULL,   -- fullKey e.g. "S1_port123"
  nick         TEXT NOT NULL,
  client_name  TEXT NOT NULL DEFAULT '',
  operator     TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_thd_host   ON top_hosts_detail(host);
CREATE INDEX IF NOT EXISTS idx_thd_client ON top_hosts_detail(client_name);
CREATE INDEX IF NOT EXISTS idx_thd_op     ON top_hosts_detail(operator);
CREATE INDEX IF NOT EXISTS idx_thd_srv    ON top_hosts_detail(server_name);
CREATE INDEX IF NOT EXISTS idx_thd_nick   ON top_hosts_detail(server_name, nick);
CREATE INDEX IF NOT EXISTS idx_thd_snap   ON top_hosts_detail(snapshot_at);
