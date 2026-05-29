-- 033: Modem failover engine (Stage 19).
-- Full design context: src/jobs/failover.js + src/routes/failover.js.
--
-- When a client's modem dies (hard-down after USB-reset exhausted) or
-- glitches persistently (high error% over a window), the engine re-points
-- that client's port to a healthy spare modem ON THE SAME SERVER via
-- ProxySmart's edit_port IMEI-swap (Variant A — keeps portID / TCP port /
-- login / password, so the client's connection string survives). This
-- table is the audit trail: every attempt (real or dry-run) lands here.

CREATE TABLE IF NOT EXISTS failover_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT NOT NULL DEFAULT (datetime('now')),
  server_name      TEXT NOT NULL,
  client_port_name TEXT,                  -- the client (portName) being rescued
  dead_imei        TEXT,                  -- modem we're moving the port OFF
  dead_nick        TEXT,
  dead_port_id     TEXT NOT NULL,         -- the port being teleported
  spare_imei       TEXT,                  -- modem we're moving the port ONTO
  spare_nick       TEXT,
  mode             TEXT NOT NULL DEFAULT 'A',  -- A = move_port (seamless)
  trigger_reason   TEXT,                  -- recovery_exhausted | hard_offline | glitch_errors | manual
  result           TEXT NOT NULL,         -- ok | failed | skipped_no_spare | skipped_cooldown | skipped_rate | dry_run
  error            TEXT,
  dry_run          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_failover_ts     ON failover_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_failover_server ON failover_log(server_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_failover_dead   ON failover_log(dead_imei, ts DESC);
