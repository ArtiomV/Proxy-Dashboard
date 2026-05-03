-- Prevent double-crediting from concurrent webhooks (race condition fix).
-- Partial index — applies only to non-empty payment_id (some legacy rows
-- might have empty string).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_payments_pid_unique
  ON bank_payments(payment_id)
  WHERE payment_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_payments_tpid_unique
  ON bank_payments(tochka_payment_id)
  WHERE tochka_payment_id IS NOT NULL AND tochka_payment_id != '';
