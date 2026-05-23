-- Full DB audit: every INSERT/UPDATE/DELETE on financial tables is captured
-- by SQLite triggers. The triggers fire regardless of which code path made
-- the change — even raw db.exec() or buggy code that bypasses our wrappers.

-- Context describes "who/why/when" — set by JS middleware/scheduler.
CREATE TABLE IF NOT EXISTS db_audit_context (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  source       TEXT NOT NULL DEFAULT 'unknown',  -- http | scheduler | webhook | startup | manual
  actor        TEXT,                              -- admin login or 'system'
  ip           TEXT,
  request_id   TEXT,
  http_method  TEXT,
  http_path    TEXT,
  reason       TEXT,                              -- short description of what we expected to do
  stack        TEXT                               -- abbreviated stack (top 8 frames)
);
CREATE INDEX IF NOT EXISTS idx_dba_ctx_ts     ON db_audit_context(ts);
CREATE INDEX IF NOT EXISTS idx_dba_ctx_actor  ON db_audit_context(actor);
CREATE INDEX IF NOT EXISTS idx_dba_ctx_source ON db_audit_context(source, ts);

-- Audit log itself — one row per DML operation per row.
CREATE TABLE IF NOT EXISTS db_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  table_name  TEXT NOT NULL,
  operation   TEXT NOT NULL,                       -- INSERT | UPDATE | DELETE
  row_id      TEXT,
  old_values  TEXT,
  new_values  TEXT,
  context_id  INTEGER REFERENCES db_audit_context(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dba_ts    ON db_audit(ts);
CREATE INDEX IF NOT EXISTS idx_dba_table ON db_audit(table_name, ts);
CREATE INDEX IF NOT EXISTS idx_dba_row   ON db_audit(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_dba_ctx   ON db_audit(context_id);

-- Single-row pivot table — JS sets the active context_id before each write.
-- Triggers read from here so every captured row is linked to a context.
CREATE TABLE IF NOT EXISTS _audit_active_context (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  context_id  INTEGER
);
INSERT OR IGNORE INTO _audit_active_context (id, context_id) VALUES (1, NULL);

-- ============================================================================
-- billing_ledger — full audit (INSERT, UPDATE, DELETE)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_billing_ledger_ai;
CREATE TRIGGER trg_billing_ledger_ai AFTER INSERT ON billing_ledger
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, new_values, context_id)
  VALUES ('billing_ledger', 'INSERT', CAST(NEW.id AS TEXT),
    json_object('id', NEW.id, 'client_id', NEW.client_id, 'type', NEW.type, 'date', NEW.date,
                'timestamp', NEW.timestamp, 'amount', NEW.amount,
                'balance_before', NEW.balance_before, 'balance_after', NEW.balance_after,
                'gb_used', NEW.gb_used, 'modem_count', NEW.modem_count,
                'note', NEW.note, 'source', NEW.source, 'payment_id', NEW.payment_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_billing_ledger_au;
CREATE TRIGGER trg_billing_ledger_au AFTER UPDATE ON billing_ledger
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, new_values, context_id)
  VALUES ('billing_ledger', 'UPDATE', CAST(OLD.id AS TEXT),
    json_object('id', OLD.id, 'client_id', OLD.client_id, 'type', OLD.type, 'date', OLD.date,
                'timestamp', OLD.timestamp, 'amount', OLD.amount,
                'balance_before', OLD.balance_before, 'balance_after', OLD.balance_after,
                'gb_used', OLD.gb_used, 'modem_count', OLD.modem_count,
                'note', OLD.note, 'source', OLD.source, 'payment_id', OLD.payment_id),
    json_object('id', NEW.id, 'client_id', NEW.client_id, 'type', NEW.type, 'date', NEW.date,
                'timestamp', NEW.timestamp, 'amount', NEW.amount,
                'balance_before', NEW.balance_before, 'balance_after', NEW.balance_after,
                'gb_used', NEW.gb_used, 'modem_count', NEW.modem_count,
                'note', NEW.note, 'source', NEW.source, 'payment_id', NEW.payment_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_billing_ledger_ad;
CREATE TRIGGER trg_billing_ledger_ad AFTER DELETE ON billing_ledger
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('billing_ledger', 'DELETE', CAST(OLD.id AS TEXT),
    json_object('id', OLD.id, 'client_id', OLD.client_id, 'type', OLD.type, 'date', OLD.date,
                'timestamp', OLD.timestamp, 'amount', OLD.amount,
                'balance_before', OLD.balance_before, 'balance_after', OLD.balance_after,
                'gb_used', OLD.gb_used, 'modem_count', OLD.modem_count,
                'note', OLD.note, 'source', OLD.source, 'payment_id', OLD.payment_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- clients.balance — only when balance actually changes
-- ============================================================================
DROP TRIGGER IF EXISTS trg_clients_balance_au;
CREATE TRIGGER trg_clients_balance_au AFTER UPDATE OF balance ON clients
WHEN COALESCE(OLD.balance, 0) != COALESCE(NEW.balance, 0)
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, new_values, context_id)
  VALUES ('clients.balance', 'UPDATE', NEW.id,
    json_object('balance', OLD.balance),
    json_object('balance', NEW.balance, 'name', NEW.name),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- bank_payments — full audit
-- ============================================================================
DROP TRIGGER IF EXISTS trg_bank_payments_ai;
CREATE TRIGGER trg_bank_payments_ai AFTER INSERT ON bank_payments
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, new_values, context_id)
  VALUES ('bank_payments', 'INSERT', NEW.id,
    json_object('id', NEW.id, 'payment_id', NEW.payment_id, 'tochka_payment_id', NEW.tochka_payment_id,
                'date', NEW.date, 'amount', NEW.amount, 'payer_inn', NEW.payer_inn,
                'payer_name', NEW.payer_name, 'matched', NEW.matched,
                'matched_client_id', NEW.matched_client_id, 'source', NEW.source),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_bank_payments_au;
CREATE TRIGGER trg_bank_payments_au AFTER UPDATE ON bank_payments
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, new_values, context_id)
  VALUES ('bank_payments', 'UPDATE', NEW.id,
    json_object('matched', OLD.matched, 'matched_client_id', OLD.matched_client_id,
                'dismissed', OLD.dismissed, 'auto_credit', OLD.auto_credit),
    json_object('matched', NEW.matched, 'matched_client_id', NEW.matched_client_id,
                'dismissed', NEW.dismissed, 'auto_credit', NEW.auto_credit),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_bank_payments_ad;
CREATE TRIGGER trg_bank_payments_ad AFTER DELETE ON bank_payments
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('bank_payments', 'DELETE', OLD.id,
    json_object('id', OLD.id, 'payment_id', OLD.payment_id, 'tochka_payment_id', OLD.tochka_payment_id,
                'date', OLD.date, 'amount', OLD.amount, 'payer_inn', OLD.payer_inn,
                'payer_name', OLD.payer_name, 'matched_client_id', OLD.matched_client_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- payments — manual top-ups attached to clients
-- ============================================================================
DROP TRIGGER IF EXISTS trg_payments_ai;
CREATE TRIGGER trg_payments_ai AFTER INSERT ON payments
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, new_values, context_id)
  VALUES ('payments', 'INSERT', CAST(NEW.id AS TEXT),
    json_object('id', NEW.id, 'client_id', NEW.client_id, 'amount', NEW.amount,
                'date', NEW.date, 'note', NEW.note, 'source', NEW.source, 'payment_id', NEW.payment_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_payments_ad;
CREATE TRIGGER trg_payments_ad AFTER DELETE ON payments
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('payments', 'DELETE', CAST(OLD.id AS TEXT),
    json_object('id', OLD.id, 'client_id', OLD.client_id, 'amount', OLD.amount,
                'date', OLD.date, 'note', OLD.note, 'source', OLD.source, 'payment_id', OLD.payment_id),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- closing_documents — acts (legal documents)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_closing_docs_ai;
CREATE TRIGGER trg_closing_docs_ai AFTER INSERT ON closing_documents
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, new_values, context_id)
  VALUES ('closing_documents', 'INSERT', NEW.id,
    json_object('id', NEW.id, 'client_id', NEW.client_id, 'period', NEW.period,
                'act_number', NEW.act_number, 'total_amount', NEW.total_amount,
                'tochka_doc_id', NEW.tochka_doc_id, 'status', NEW.status),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_closing_docs_au;
CREATE TRIGGER trg_closing_docs_au AFTER UPDATE ON closing_documents
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, new_values, context_id)
  VALUES ('closing_documents', 'UPDATE', NEW.id,
    json_object('total_amount', OLD.total_amount, 'tochka_doc_id', OLD.tochka_doc_id, 'status', OLD.status),
    json_object('total_amount', NEW.total_amount, 'tochka_doc_id', NEW.tochka_doc_id, 'status', NEW.status),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_closing_docs_ad;
CREATE TRIGGER trg_closing_docs_ad AFTER DELETE ON closing_documents
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('closing_documents', 'DELETE', OLD.id,
    json_object('id', OLD.id, 'client_id', OLD.client_id, 'period', OLD.period,
                'act_number', OLD.act_number, 'total_amount', OLD.total_amount,
                'tochka_doc_id', OLD.tochka_doc_id, 'status', OLD.status),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- bills — счета на оплату
-- ============================================================================
DROP TRIGGER IF EXISTS trg_bills_ai;
CREATE TRIGGER trg_bills_ai AFTER INSERT ON bills
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, new_values, context_id)
  VALUES ('bills', 'INSERT', NEW.id,
    json_object('id', NEW.id, 'client_id', NEW.client_id, 'period', NEW.period,
                'bill_number', NEW.bill_number, 'amount', NEW.amount, 'status', NEW.status),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

DROP TRIGGER IF EXISTS trg_bills_ad;
CREATE TRIGGER trg_bills_ad AFTER DELETE ON bills
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('bills', 'DELETE', OLD.id,
    json_object('id', OLD.id, 'client_id', OLD.client_id, 'period', OLD.period,
                'bill_number', OLD.bill_number, 'amount', OLD.amount, 'status', OLD.status),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;

-- ============================================================================
-- clients — DELETE (creation/edit captured via balance trigger)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_clients_ad;
CREATE TRIGGER trg_clients_ad AFTER DELETE ON clients
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, context_id)
  VALUES ('clients', 'DELETE', OLD.id,
    json_object('id', OLD.id, 'login', OLD.login, 'name', OLD.name, 'balance', OLD.balance,
                'billing_type', OLD.billing_type, 'price', OLD.price),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;
