-- Durable recovery state for acquiring payments that reached `paid` but were
-- not yet fully credited. Delays are calculated by the repository.
ALTER TABLE card_payments ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card_payments ADD COLUMN next_recovery_at TEXT;
ALTER TABLE card_payments ADD COLUMN recovery_error TEXT;

CREATE INDEX IF NOT EXISTS idx_card_payments_recovery
  ON card_payments(status, next_recovery_at, id);
