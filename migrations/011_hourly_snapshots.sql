-- Hourly snapshots: dedicated table instead of kv_store JSON blob
CREATE TABLE IF NOT EXISTS hourly_snapshots (
  port_id                    TEXT PRIMARY KEY,
  day_in                     INTEGER NOT NULL DEFAULT 0,
  day_out                    INTEGER NOT NULL DEFAULT 0,
  month_in                   INTEGER NOT NULL DEFAULT 0,
  month_out                  INTEGER NOT NULL DEFAULT 0,
  yesterday_in               INTEGER NOT NULL DEFAULT 0,
  yesterday_out              INTEGER NOT NULL DEFAULT 0,
  prev_month_in              INTEGER NOT NULL DEFAULT 0,
  prev_month_out             INTEGER NOT NULL DEFAULT 0,
  day_at_last_hour_start_in  INTEGER NOT NULL DEFAULT 0,
  day_at_last_hour_start_out INTEGER NOT NULL DEFAULT 0,
  mon_at_last_hour_start_in  INTEGER NOT NULL DEFAULT 0,
  mon_at_last_hour_start_out INTEGER NOT NULL DEFAULT 0,
  pending                    INTEGER NOT NULL DEFAULT 0,
  captured_at                TEXT NOT NULL
);

-- Extend corrected flag: 0=ok, 1=corrected, 2=uncertain (day vs month discrepancy)
ALTER TABLE traffic_hourly ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0;
