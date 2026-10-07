-- 2026-10-07: снятие ON DELETE CASCADE с финансовых/документных таблиц.
-- Инцидент 07.10: удаление клиента flint019 каскадно стёрло его
-- billing_ledger (10 записей платежей/списаний) — история спасена из
-- pre-deploy снапшота. Код в clients.js утверждал «ledger не каскадируется»,
-- схема говорила обратное. Теперь: client_id — просто TEXT, удаление клиента
-- оставляет финансовую и документную историю нетронутой (сверки, акты прошлых
-- периодов). REFERENCES убран совсем, иначе DELETE клиента с историей падал
-- бы по FK-ограничению.
-- Пересборка: create-new → copy → drop → rename; индексы восстановлены явно.
-- FK-ссылок НА эти таблицы нет, поэтому PRAGMA foreign_keys трогать не нужно.

CREATE TABLE billing_ledger_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  date        TEXT NOT NULL,
  timestamp   TEXT,
  amount      REAL NOT NULL,
  currency    TEXT DEFAULT 'RUB',
  balance_before REAL,
  balance_after REAL,
  gb_used     REAL,
  modem_count INTEGER,
  days_in_month INTEGER,
  note        TEXT DEFAULT '',
  source      TEXT,
  payment_id  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  details TEXT DEFAULT '{}', purchase_id TEXT
);
INSERT INTO billing_ledger_new SELECT * FROM billing_ledger;
DROP TABLE billing_ledger;
ALTER TABLE billing_ledger_new RENAME TO billing_ledger;
CREATE INDEX idx_ledger_client_id ON billing_ledger(client_id);
CREATE INDEX idx_ledger_date ON billing_ledger(date);
CREATE INDEX idx_ledger_type ON billing_ledger(type);
CREATE INDEX idx_ledger_client_type ON billing_ledger(client_id, type);
CREATE INDEX idx_ledger_client_date ON billing_ledger(client_id, date);
-- NB: idx_ledger_unique_charge (UNIQUE client+date+type WHERE type='charge')
-- НЕ восстанавливаем — миграция 025 его сняла осознанно (DEEP-20: иначе вторая
-- retail-покупка в тот же день теряла списание). Дневная идемпотентность —
-- idx_ledger_unique_chargelike (purchase_id IS NULL), покупки — purchase_unique.
CREATE INDEX idx_ledger_type_date ON billing_ledger(type, date);
CREATE INDEX idx_ledger_payment ON billing_ledger(payment_id, type);
CREATE UNIQUE INDEX idx_ledger_unique_chargelike
  ON billing_ledger(client_id, date, type)
  WHERE type IN ('charge', 'correction', 'manual_charge') AND purchase_id IS NULL;
CREATE UNIQUE INDEX idx_ledger_purchase_unique
  ON billing_ledger(purchase_id)
  WHERE purchase_id IS NOT NULL;

CREATE TABLE payments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL,
  amount      REAL NOT NULL,
  date        TEXT NOT NULL,
  note        TEXT DEFAULT '',
  source      TEXT DEFAULT 'manual',
  payment_id  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
INSERT INTO payments_new SELECT * FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX idx_payments_client_id ON payments(client_id);
CREATE INDEX idx_payments_date ON payments(date);

CREATE TABLE client_documents_new (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime_type   TEXT DEFAULT '',
  date        TEXT DEFAULT (datetime('now'))
);
INSERT INTO client_documents_new SELECT * FROM client_documents;
DROP TABLE client_documents;
ALTER TABLE client_documents_new RENAME TO client_documents;
CREATE INDEX idx_docs_client_id ON client_documents(client_id);

CREATE TABLE closing_documents_new (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  tochka_doc_id   TEXT,
  period          TEXT NOT NULL,
  type            TEXT DEFAULT 'act',
  act_number      TEXT,
  items           TEXT DEFAULT '[]',
  total_amount    REAL DEFAULT 0,
  status          TEXT DEFAULT 'unsigned',
  created_at      TEXT DEFAULT (datetime('now')),
  contract_info TEXT DEFAULT '', signed_at TEXT
);
INSERT INTO closing_documents_new SELECT * FROM closing_documents;
DROP TABLE closing_documents;
ALTER TABLE closing_documents_new RENAME TO closing_documents;
CREATE INDEX idx_closing_docs_client ON closing_documents(client_id);
CREATE INDEX idx_closing_docs_period ON closing_documents(period);
CREATE UNIQUE INDEX idx_closing_docs_unique_period ON closing_documents(client_id, period, type);

CREATE TABLE bills_new (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  tochka_bill_id  TEXT,
  period          TEXT NOT NULL,
  bill_number     TEXT,
  amount          REAL NOT NULL,
  status          TEXT DEFAULT 'unpaid',
  created_at      TEXT DEFAULT (datetime('now')),
  formula TEXT NOT NULL DEFAULT ''
);
INSERT INTO bills_new SELECT * FROM bills;
DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;
CREATE INDEX idx_bills_client ON bills(client_id);
CREATE INDEX idx_bills_period ON bills(period);
CREATE UNIQUE INDEX idx_bills_unique_period ON bills(client_id, period);
