-- Proxies.Rent Dashboard — SQLite Schema
-- Replaces: clients.json, billing_ledger.json, sessions.json, bank_payments.json,
--           ip_tracking.json, uptime_tracking.json, daily_traffic.json,
--           telegram_users.json, telegram_proxies.json, telegram_feedback.json,
--           audit_log.json

-- Clients (replaces clients.json)
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  login           TEXT UNIQUE NOT NULL,
  password        TEXT,
  password_hash   TEXT,
  port_name       TEXT,
  name            TEXT NOT NULL,
  contact         TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  billing_type    TEXT DEFAULT 'per_gb',
  price           REAL DEFAULT 0,
  currency        TEXT DEFAULT 'RUB',
  balance         REAL DEFAULT 0,
  api_key         TEXT UNIQUE,
  referral_code   TEXT UNIQUE,
  referred_by     TEXT,
  referral_balance REAL DEFAULT 0,
  reset_token     TEXT,
  inn             TEXT DEFAULT '',
  kpp             TEXT DEFAULT '',
  legal_name      TEXT DEFAULT '',
  contract_info   TEXT DEFAULT '',
  address         TEXT DEFAULT '',
  auto_acts       INTEGER DEFAULT 1,
  auto_bills      INTEGER DEFAULT 1,
  last_traffic_snapshot TEXT DEFAULT '{}',
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_login ON clients(login);
CREATE INDEX IF NOT EXISTS idx_clients_port_name ON clients(port_name);
CREATE INDEX IF NOT EXISTS idx_clients_api_key ON clients(api_key);
CREATE INDEX IF NOT EXISTS idx_clients_inn ON clients(inn);

-- Payments (replaces client.payments[] array inside clients.json)
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  date        TEXT NOT NULL,
  note        TEXT DEFAULT '',
  source      TEXT DEFAULT 'manual',
  payment_id  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_client_id ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);

-- Billing ledger (replaces billing_ledger.json)
CREATE TABLE IF NOT EXISTS billing_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
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
  details     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_client_id ON billing_ledger(client_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON billing_ledger(date);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON billing_ledger(type);

-- Sessions (replaces sessions.json)
CREATE TABLE IF NOT EXISTS sessions (
  token           TEXT PRIMARY KEY,
  login           TEXT NOT NULL,
  port_name_filter TEXT,
  is_admin        INTEGER DEFAULT 0,
  expires_at      INTEGER NOT NULL,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Bank payments from Tochka (replaces bank_payments.json)
CREATE TABLE IF NOT EXISTS bank_payments (
  id                TEXT PRIMARY KEY,
  webhook_type      TEXT,
  payer_inn         TEXT,
  payer_name        TEXT,
  amount            REAL NOT NULL,
  purpose           TEXT,
  payment_id        TEXT,
  date              TEXT NOT NULL,
  customer_code     TEXT,
  matched           INTEGER DEFAULT 0,
  matched_client_id TEXT,
  matched_client_name TEXT,
  auto_credit       INTEGER DEFAULT 0,
  dismissed         INTEGER DEFAULT 0,
  source            TEXT DEFAULT '',
  tochka_payment_id TEXT,
  received_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_payments_payment_id ON bank_payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_bank_payments_client_id ON bank_payments(matched_client_id);
CREATE INDEX IF NOT EXISTS idx_bank_payments_date ON bank_payments(date);
CREATE INDEX IF NOT EXISTS idx_bank_payments_tochka_id ON bank_payments(tochka_payment_id);

-- Client documents (replaces client.documents[] array)
CREATE TABLE IF NOT EXISTS client_documents (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime_type   TEXT DEFAULT '',
  date        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_client_id ON client_documents(client_id);

-- Closing documents / Acts (replaces client.closingDocuments[] array)
CREATE TABLE IF NOT EXISTS closing_documents (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tochka_doc_id   TEXT,
  period          TEXT NOT NULL,
  type            TEXT DEFAULT 'act',
  act_number      TEXT,
  items           TEXT DEFAULT '[]',
  total_amount    REAL DEFAULT 0,
  status          TEXT DEFAULT 'unsigned',
  contract_info   TEXT,
  signed_at       TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_closing_docs_client ON closing_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_closing_docs_period ON closing_documents(period);

-- Bills (replaces client.bills[] array)
CREATE TABLE IF NOT EXISTS bills (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tochka_bill_id  TEXT,
  period          TEXT NOT NULL,
  bill_number     TEXT,
  amount          REAL NOT NULL,
  status          TEXT DEFAULT 'unpaid',
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_client ON bills(client_id);
CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period);

-- Audit log (TASK-J, replaces audit_log.json)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  admin       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_log(admin);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

-- IP tracking (replaces ip_tracking.json)
CREATE TABLE IF NOT EXISTS ip_tracking (
  key         TEXT PRIMARY KEY,
  ip          TEXT,
  updated_at  TEXT
);

-- Uptime tracking (replaces uptime_tracking.json)
CREATE TABLE IF NOT EXISTS uptime_tracking (
  key         TEXT PRIMARY KEY,
  data        TEXT DEFAULT '{}'
);

-- IP history (replaces ip_history.json)
CREATE TABLE IF NOT EXISTS ip_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  ip          TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ip_history_key ON ip_history(key);

-- Hourly traffic aggregates (for heatmap and trend analytics)
CREATE TABLE IF NOT EXISTS traffic_hourly (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  port_name   TEXT NOT NULL,
  hour_start  TEXT NOT NULL,     -- '2026-03-29 14:00'
  bytes_in    INTEGER DEFAULT 0,
  bytes_out   INTEGER DEFAULT 0,
  UNIQUE(port_name, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_hour ON traffic_hourly(hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_port ON traffic_hourly(port_name, hour_start);

-- Daily traffic (replaces daily_traffic.json)
CREATE TABLE IF NOT EXISTS daily_traffic (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  port_name   TEXT NOT NULL,
  date        TEXT NOT NULL,
  bytes_in    INTEGER DEFAULT 0,
  bytes_out   INTEGER DEFAULT 0,
  UNIQUE(port_name, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_traffic_port_date ON daily_traffic(port_name, date);

