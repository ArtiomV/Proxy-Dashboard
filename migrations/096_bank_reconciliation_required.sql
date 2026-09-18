-- 2026-09-18 · DEEP-24 (§ FIX-SPEC): сверка банковских платежей по идентификатору
-- события, а не по «клиент+сумма+дата». Когда legacy-история не даёт доказать
-- идентичность события (нет ни payment_id, ни tochka_payment_id), платёж НЕ
-- помечается оплаченным вслепую — он уходит в reconciliation_required для
-- ручной сверки. 1 = требуется ручная сверка; auto/recovery-пути такую строку
-- пропускают.
ALTER TABLE bank_payments ADD COLUMN reconciliation_required INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bank_payments_reconciliation
  ON bank_payments(reconciliation_required)
  WHERE reconciliation_required = 1;
