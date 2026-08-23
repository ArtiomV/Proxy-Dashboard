-- Per-SIM contract renewal/update date managed by an admin. Kept on modem_meta
-- because the SIM identity (ICCID) belongs to the modem record, not a client.
ALTER TABLE modem_meta ADD COLUMN contract_renewal_date TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_modem_meta_contract_renewal
  ON modem_meta(contract_renewal_date)
  WHERE contract_renewal_date <> '';
