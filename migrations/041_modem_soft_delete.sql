-- 041: soft-delete flag for modems.
-- The DELETE-modem endpoint used to hard-delete the modem_meta row, but the
-- ProxySmart poll re-creates it on the very next cycle for any modem still in
-- the device list (e.g. dead box4/S4 LAN modems) → deletes never "stuck".
-- A persistent `deleted` flag survives the upsert (the upsert never touches it)
-- and injectOfflineModems filters it out. Auto-restored if the modem comes back
-- with a real client port (see updateKnownModems).
ALTER TABLE modem_meta ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_modem_meta_deleted ON modem_meta(deleted) WHERE deleted = 1;
