CREATE INDEX IF NOT EXISTS idx_ledger_client_type ON billing_ledger(client_id, type);
CREATE INDEX IF NOT EXISTS idx_ledger_client_date ON billing_ledger(client_id, date);
CREATE INDEX IF NOT EXISTS idx_bank_matched ON bank_payments(matched_client_id);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_operator ON traffic_hourly(operator, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_client ON traffic_hourly(client_name, hour_start);
