-- Backfill NULL/empty payment_id with a deterministic synthetic value so we
-- can rely on payment_id as a true primary identifier going forward.
UPDATE bank_payments
SET payment_id = 'legacy-' || id
WHERE payment_id IS NULL OR payment_id = '';

-- Drop the partial unique index (was excluding empty/null rows). Replace with
-- a plain unique index now that every row has a non-empty payment_id.
DROP INDEX IF EXISTS idx_bank_payments_pid_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_payments_pid_unique
  ON bank_payments(payment_id);
