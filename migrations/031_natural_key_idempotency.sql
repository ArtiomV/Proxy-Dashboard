-- 031: Tochka sync idempotency fix (Stage 18.6).
-- Full design context: server.js → runTochkaSync().
--
-- Two structural changes:
--
-- 1. The existing payment_id UNIQUE applied to ALL rows including ''.
--    The first row with payment_id='' silently blocked every subsequent
--    sync-insert (also producing payment_id=''). Credits kept landing
--    in billing_ledger while the audit-row in bank_payments was never
--    saved → cascading double-credit, invisible to anyone scanning
--    bank_payments. Fix: make the index match the tpid one — partial
--    on non-empty values only.
--
-- 2. New column `natural_key`. The webhook and the sync return DIFFERENT
--    identifiers for the SAME real transaction (Tochka's internal id
--    differs between channels), so neither `payment_id` nor
--    `tochka_payment_id` alone is enough to de-dup. The natural key is
--    derived from data the real transaction uniquely owns:
--      payer_inn | amount | date | purpose-prefix
--    Server-side code uses this as the primary idempotency gate BEFORE
--    invoking atomicCredit. We DO NOT add a UNIQUE constraint here —
--    existing data has multiple legitimate rows that share the same key
--    (the WildBox / Speech-Tech doubles we're about to reconcile),
--    and dropping them is the operator's call, not the migration's.

-- 1) Replace overly-strict pid_unique with a partial one.
DROP INDEX IF EXISTS idx_bank_payments_pid_unique;
CREATE UNIQUE INDEX idx_bank_payments_pid_unique
  ON bank_payments(payment_id)
  WHERE payment_id IS NOT NULL AND payment_id != '';

-- 2) Add natural_key column + non-unique lookup index. Backfill from existing
-- rows so older transactions are de-duppable by code on next sync.
ALTER TABLE bank_payments ADD COLUMN natural_key TEXT;
CREATE INDEX idx_bank_payments_natural_key ON bank_payments(natural_key);

UPDATE bank_payments
   SET natural_key = COALESCE(payer_inn,'') || '|'
                  || CAST(amount AS TEXT) || '|'
                  || COALESCE(date,'') || '|'
                  || substr(COALESCE(purpose,''), 1, 100)
 WHERE natural_key IS NULL;
