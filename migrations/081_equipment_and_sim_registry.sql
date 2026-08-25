-- Structured equipment accounting per physical location and an authoritative
-- ICCID -> phone registry used to enrich ProxySmart modem data.

CREATE TABLE IF NOT EXISTS equipment_inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location_key   TEXT NOT NULL,
  equipment_type TEXT NOT NULL COLLATE NOCASE,
  quantity       INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(location_key, equipment_type)
);
CREATE INDEX IF NOT EXISTS idx_equipment_location
  ON equipment_inventory(location_key);

CREATE TABLE IF NOT EXISTS sim_registry (
  iccid       TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  operator    TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'import',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sim_registry_phone ON sim_registry(phone);

