-- Auto-reboot log for flaky modems (high latency / high error rate).
-- Used to throttle reboots: don't reboot the same modem more often than once
-- per N minutes (default 60).
CREATE TABLE IF NOT EXISTS auto_reboot_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  nick        TEXT NOT NULL,
  imei        TEXT,
  rebooted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason      TEXT,
  status      TEXT,             -- 'success' | 'failed'
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_arl_modem  ON auto_reboot_log(server_name, nick, rebooted_at);
CREATE INDEX IF NOT EXISTS idx_arl_recent ON auto_reboot_log(rebooted_at);
