ALTER TABLE bank_payments ADD COLUMN dismissed INTEGER DEFAULT 0;
ALTER TABLE bank_payments ADD COLUMN source TEXT DEFAULT '';
ALTER TABLE bank_payments ADD COLUMN tochka_payment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bank_payments_tochka_id ON bank_payments(tochka_payment_id);
