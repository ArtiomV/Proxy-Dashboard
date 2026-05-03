-- Monthly cost categories. Admin inputs per period (YYYY-MM).
-- Used to compute CPM (cost per modem) and Margin per modem.
-- subkey: for category='server' = server name (S1/S2/...);
--         for category='sim' = operator name (Orange MD, Moldtelecom, ...)
--         for other categories — null
CREATE TABLE IF NOT EXISTS monthly_costs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL,
  category    TEXT NOT NULL,
  subkey      TEXT,
  amount      REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(period, category, subkey)
);
CREATE INDEX IF NOT EXISTS idx_mc_period ON monthly_costs(period);
CREATE INDEX IF NOT EXISTS idx_mc_cat    ON monthly_costs(category, period);
