-- Expand idempotency to cover correction and manual_charge as well.
-- Previously only `type='charge'` was deduped, so an admin manually posting
-- a `correction` twice (same client + date) created duplicate ledger rows.
DROP INDEX IF EXISTS idx_ledger_unique_charge;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_chargelike
  ON billing_ledger(client_id, date, type)
  WHERE type IN ('charge', 'correction', 'manual_charge');
