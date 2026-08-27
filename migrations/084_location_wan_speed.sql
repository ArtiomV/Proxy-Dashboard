-- 084 — история скорости проводного WAN по физическим локациям

CREATE TABLE IF NOT EXISTS location_wan_speed (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  location_key     TEXT NOT NULL,
  location_label   TEXT NOT NULL,
  server_name      TEXT NOT NULL DEFAULT '',
  collected_at     TEXT NOT NULL,
  download_mbps    REAL,
  upload_mbps      REAL,
  ping_ms           REAL,
  jitter_ms         REAL,
  packet_loss_pct   REAL,
  provider          TEXT NOT NULL DEFAULT '',
  external_ip       TEXT NOT NULL DEFAULT '',
  method            TEXT NOT NULL DEFAULT '',
  ok                INTEGER NOT NULL DEFAULT 0,
  error             TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_location_wan_speed_key_ts
  ON location_wan_speed(location_key, collected_at);
