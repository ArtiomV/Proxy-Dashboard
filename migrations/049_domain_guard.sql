-- 049: domain-guard (WP2 ProxySmart data integration).
-- Компенсирующий контроль вместо снятой hfilter-фильтрации на bypass-боксах
-- (S2/RO2, S4/box4): суточная история top_hosts по guard-серверам + журнал
-- совпадений с бан-листом (config/blocked-domains.json).
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл.

CREATE TABLE IF NOT EXISTS top_hosts_daily (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  server_name  TEXT NOT NULL,
  port_id      TEXT NOT NULL,
  nick         TEXT NOT NULL DEFAULT '',
  client_name  TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date, server_name, port_id, host)
);
CREATE INDEX IF NOT EXISTS idx_thd_daily_date ON top_hosts_daily(date);
CREATE INDEX IF NOT EXISTS idx_thd_daily_port ON top_hosts_daily(server_name, port_id, host, date);

CREATE TABLE IF NOT EXISTS domain_guard_hits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  server_name  TEXT NOT NULL,
  client_name  TEXT NOT NULL DEFAULT '',
  nick         TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL,
  matched_domain TEXT NOT NULL,
  hits_delta   INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(date, server_name, client_name, host)
);
CREATE INDEX IF NOT EXISTS idx_dgh_date ON domain_guard_hits(date);
