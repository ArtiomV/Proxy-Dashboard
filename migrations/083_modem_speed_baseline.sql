-- 083 — динамическая норма скорости по каждому замеряемому модему

CREATE TABLE IF NOT EXISTS modem_speed_baseline_state (
  server          TEXT NOT NULL,
  nick            TEXT NOT NULL,
  operator        TEXT NOT NULL DEFAULT '',
  baseline_dl     REAL,
  current_dl      REAL,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  consecutive_bad INTEGER NOT NULL DEFAULT 0,
  degraded        INTEGER NOT NULL DEFAULT 0,
  degraded_since  TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(server,nick)
);
