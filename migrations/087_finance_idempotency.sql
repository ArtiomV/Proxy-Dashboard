-- Durable claims for retryable financial events. The claim is inserted in the
-- same SQLite transaction as balance, ledger and referral writes.
CREATE TABLE IF NOT EXISTS finance_idempotency (
  event_key  TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  amount     REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finance_idempotency_client
  ON finance_idempotency(client_id, created_at);
