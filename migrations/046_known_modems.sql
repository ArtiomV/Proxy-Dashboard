-- 046: known_modems roster moves into SQLite (WP4). Until now the
-- port→client binding roster lived ONLY in known_modems.json — a file that
-- is NOT part of the dashboard.db backup, so a restore lost every binding.
-- Structure mirrors the JSON: one row per (server_name, port_key), the
-- entry payload as JSON (imei, nick, portName, lastSeen, lastClientSeen…).

CREATE TABLE IF NOT EXISTS known_modems (
  server_name TEXT NOT NULL,
  port_key    TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (server_name, port_key)
);
