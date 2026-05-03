-- Prevent duplicate daily charges for the same client in case of runDailyBilling crash/retry
-- Partial index: applies only to charge records (not top-ups, refunds, etc.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_charge
  ON billing_ledger(client_id, date, type)
  WHERE type = 'charge';
