-- Migrate traffic_hourly from per-nick to per-port
-- Add port_id column and make it the unique key instead of nick
ALTER TABLE traffic_hourly ADD COLUMN port_id TEXT NOT NULL DEFAULT '';

-- Copy nick to port_id for existing data (best effort — old data stays as nick-based)
UPDATE traffic_hourly SET port_id = server_name || '_' || nick WHERE port_id = '';

-- Drop old unique index and create new one
DROP INDEX IF EXISTS idx_traffic_hourly_nick;
CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_hourly_port_hour ON traffic_hourly(port_id, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_nick2 ON traffic_hourly(nick, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_client ON traffic_hourly(client_name, hour_start);
