-- 035_server_downtime.sql
-- Persist server-level unreachable episodes (ProxySmart API timeout / unreachable).
-- The app already tracked _serverDownSince in memory + fired a server_unreachable
-- alert, but nothing was recorded, so there was no downtime history. Each row is
-- one outage: when it started, when the server came back, and how long it lasted.
CREATE TABLE IF NOT EXISTS server_downtime (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name  TEXT    NOT NULL,
  down_from    TEXT    NOT NULL,
  down_to      TEXT    NOT NULL,
  duration_sec INTEGER NOT NULL,
  alerted      INTEGER NOT NULL DEFAULT 0,   -- 1 if a server_unreachable alert fired
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_server_downtime_server ON server_downtime(server_name, down_from);
