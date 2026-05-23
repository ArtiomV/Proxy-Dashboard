-- Proxies.Rent Dashboard — SQLite Schema
-- Replaces: clients.json, billing_ledger.json, sessions.json, bank_payments.json,
--           ip_tracking.json, uptime_tracking.json, daily_traffic.json, audit_log.json

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
  allow_debt      INTEGER DEFAULT 0,
  max_debt        REAL,
  sla_uptime_pct  REAL DEFAULT 99.0,
  sla_max_latency_ms INTEGER DEFAULT 1000,
  sla_max_error_pct REAL DEFAULT 5.0,
  sla_auto_credit INTEGER DEFAULT 0,
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
-- Hard idempotency for webhook + sync (prevents double-credit race)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_payments_pid_unique
  ON bank_payments(payment_id)
  WHERE payment_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_payments_tpid_unique
  ON bank_payments(tochka_payment_id)
  WHERE tochka_payment_id IS NOT NULL AND tochka_payment_id != '';

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

-- System activity log (automated processes: speedtest, billing, recovery, etc.)
CREATE TABLE IF NOT EXISTS system_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  category    TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  action      TEXT NOT NULL,
  target      TEXT,
  message     TEXT NOT NULL,
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_syslog_ts ON system_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_syslog_cat ON system_log(category, timestamp);
CREATE INDEX IF NOT EXISTS idx_syslog_level ON system_log(level, timestamp);

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

-- Rotation log synced from ProxySmart
CREATE TABLE IF NOT EXISTS rotation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  nick        TEXT NOT NULL,
  old_ip      TEXT,
  new_ip      TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  took_sec    REAL,
  attempt     INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rotation_log_nick ON rotation_log(server_name, nick);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rotation_log_uniq ON rotation_log(server_name, nick, started_at);

-- Hourly traffic aggregates (for heatmap and trend analytics)
-- Key-value store for app settings and caches (replaces settings.json, top_hosts_cache.json)
CREATE TABLE IF NOT EXISTS kv_store (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Modem metadata cache (static data from ProxySmart, updated periodically)
CREATE TABLE IF NOT EXISTS modem_meta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  imei        TEXT NOT NULL,
  nick        TEXT NOT NULL DEFAULT '',
  operator    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(server_name, imei)
);
CREATE INDEX IF NOT EXISTS idx_modem_meta_nick ON modem_meta(nick);

-- Hourly traffic per port (bandwidth entry)
CREATE TABLE IF NOT EXISTS traffic_hourly (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL DEFAULT '',
  port_id     TEXT NOT NULL DEFAULT '',
  nick        TEXT NOT NULL DEFAULT '',
  operator    TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  hour_start  TEXT NOT NULL,     -- '2026-03-29 14:00'
  bytes_in    INTEGER DEFAULT 0,
  bytes_out   INTEGER DEFAULT 0,
  uncertain   INTEGER NOT NULL DEFAULT 0,
  corrected   INTEGER DEFAULT 0,
  UNIQUE(port_id, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_hour ON traffic_hourly(hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_srv ON traffic_hourly(server_name, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_nick2 ON traffic_hourly(nick, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_client ON traffic_hourly(client_name, hour_start);

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

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_ledger_client_type ON billing_ledger(client_id, type);
CREATE INDEX IF NOT EXISTS idx_ledger_client_date ON billing_ledger(client_id, date);
-- Idempotency for daily charges: prevents duplicate rows if runDailyBilling retries
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_charge
  ON billing_ledger(client_id, date, type)
  WHERE type = 'charge';
CREATE INDEX IF NOT EXISTS idx_bank_matched ON bank_payments(matched_client_id);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_operator ON traffic_hourly(operator, hour_start);
CREATE INDEX IF NOT EXISTS idx_traffic_hourly_client ON traffic_hourly(client_name, hour_start);

-- Hourly snapshots (bandwidth counter baselines for delta calculation)
CREATE TABLE IF NOT EXISTS hourly_snapshots (
  port_id                    TEXT PRIMARY KEY,
  day_in                     INTEGER NOT NULL DEFAULT 0,
  day_out                    INTEGER NOT NULL DEFAULT 0,
  month_in                   INTEGER NOT NULL DEFAULT 0,
  month_out                  INTEGER NOT NULL DEFAULT 0,
  yesterday_in               INTEGER NOT NULL DEFAULT 0,
  yesterday_out              INTEGER NOT NULL DEFAULT 0,
  prev_month_in              INTEGER NOT NULL DEFAULT 0,
  prev_month_out             INTEGER NOT NULL DEFAULT 0,
  day_at_last_hour_start_in  INTEGER NOT NULL DEFAULT 0,
  day_at_last_hour_start_out INTEGER NOT NULL DEFAULT 0,
  mon_at_last_hour_start_in  INTEGER NOT NULL DEFAULT 0,
  mon_at_last_hour_start_out INTEGER NOT NULL DEFAULT 0,
  pending                    INTEGER NOT NULL DEFAULT 0,
  captured_at                TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated_at            TEXT
);

-- SLA violations (Phase 4) — per-client breaches of uptime/latency/errors SLA
CREATE TABLE IF NOT EXISTS sla_violations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT,
  date             TEXT,
  metric           TEXT,
  expected         REAL,
  actual           REAL,
  credited_amount  REAL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sla_violations_client ON sla_violations(client_id, date);
CREATE INDEX IF NOT EXISTS idx_sla_violations_date ON sla_violations(date);

-- API usage tracking (Phase 2) — per-client log of /api/v1/* requests
CREATE TABLE IF NOT EXISTS api_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT,
  client_name      TEXT,
  api_key_prefix   TEXT,
  endpoint         TEXT,
  method           TEXT,
  status_code      INTEGER,
  response_time_ms INTEGER,
  user_agent       TEXT,
  ip               TEXT,
  timestamp        TEXT DEFAULT CURRENT_TIMESTAMP,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_usage_client ON api_usage(client_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(timestamp);

-- Raw per-modem domain hit counts (Phase 5 logs explorer)
CREATE TABLE IF NOT EXISTS top_hosts_detail (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at  TEXT NOT NULL,
  server_name  TEXT NOT NULL,
  port_id      TEXT NOT NULL,
  nick         TEXT NOT NULL,
  client_name  TEXT NOT NULL DEFAULT '',
  operator     TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_thd_host   ON top_hosts_detail(host);
CREATE INDEX IF NOT EXISTS idx_thd_client ON top_hosts_detail(client_name);
CREATE INDEX IF NOT EXISTS idx_thd_op     ON top_hosts_detail(operator);
CREATE INDEX IF NOT EXISTS idx_thd_srv    ON top_hosts_detail(server_name);
CREATE INDEX IF NOT EXISTS idx_thd_nick   ON top_hosts_detail(server_name, nick);
CREATE INDEX IF NOT EXISTS idx_thd_snap   ON top_hosts_detail(snapshot_at);

-- Proxy latency checks
CREATE TABLE IF NOT EXISTS proxy_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  nick TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  connect_ms INTEGER,
  total_ms INTEGER,
  status_code INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pc_nick ON proxy_checks(nick);
CREATE INDEX IF NOT EXISTS idx_pc_checked ON proxy_checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_pc_operator ON proxy_checks(operator);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
);
