-- 060_retail_core.sql — B2C retail core (ТЗ «B2C продажа прокси физлицам», консолидированное 10.08).
-- ТЗ ссылается на «054_retail_core.sql», но 054–059 уже заняты — берём следующий свободный номер.
--
-- Состав:
--   1. clients: розничные поля (email/TG/consent/blocked/tariff/hold/test) — safeAddColumn-стиль.
--   2. auth_tokens — одноразовые токены email-потоков (verify 24ч / reset 1ч).
--   3. tariffs — единый прайс для всех клиентов (Р36): розница видит public=1,
--      B2B AutoCreate берёт is_default. flat НЕТ в enum (Р34) — только per_modem/per_gb.
--   4. retail_pool — пул портов для автовыдачи (free|reserved|leased|blocked).
--   5. card_payments — эквайринг (этап 4; таблица создаётся заранее, webhook идемпотентен по order_id).
--   6. data-миграция: clients.price → price_override (всем существующим — цена не «уезжает», Р36).
--      pricing_tiers (kv app_settings) → tariffs делается в JS при boot (тарифы — JSON в kv,
--      SQL-миграция их не видит): см. seedTariffsFromPricingTiers() в server.js.

-- ── clients: розничные поля ────────────────────────────────────────────────
ALTER TABLE clients ADD COLUMN email TEXT;
ALTER TABLE clients ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN tg_chat_id TEXT;            -- telegram user id (личка)
ALTER TABLE clients ADD COLUMN reg_ip TEXT;
ALTER TABLE clients ADD COLUMN consent_pd_at TEXT;
ALTER TABLE clients ADD COLUMN blocked INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN abuse_strikes INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN balance_negative_since TEXT;
ALTER TABLE clients ADD COLUMN tariff_id INTEGER;          -- привязка к единому прайсу (Р36)
ALTER TABLE clients ADD COLUMN price_override REAL;        -- индивидуальная цена корпората
ALTER TABLE clients ADD COLUMN hold_ttl_days INTEGER;      -- NULL = дефолт 7; -1 = ∞ (Р33)
ALTER TABLE clients ADD COLUMN test_used INTEGER DEFAULT 0; -- тест-день: 1 раз на аккаунт

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email ON clients(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_tg ON clients(tg_chat_id) WHERE tg_chat_id IS NOT NULL;

-- ── auth_tokens: верификация email (24ч) + сброс пароля (1ч), одноразовые ───
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  type TEXT NOT NULL,                         -- verify_email | reset_password
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_login ON auth_tokens(login, type);

-- ── tariffs: единый прайс (Р36) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'per_modem',       -- per_modem | per_gb (flat нет — Р34)
  geo TEXT NOT NULL,                            -- RU | MD | RO | …
  server TEXT NOT NULL,                         -- бокс выдачи (из retail_pool_servers)
  price REAL NOT NULL,                          -- канон: ₽/мес (per_modem) | ₽/ГБ (per_gb)
  min_proxies INTEGER DEFAULT 1,                -- тир объёма (наследие pricing_tiers)
  public INTEGER DEFAULT 0,                     -- 1 = виден рознице на витрине
  is_default INTEGER DEFAULT 0,                 -- дефолт для B2B AutoCreate
  maxconn INTEGER,
  bandlim_kbit INTEGER,
  rotation_allowed INTEGER DEFAULT 1,
  min_topup_days INTEGER DEFAULT 1,
  duration_hours INTEGER,                       -- NULL = подписка; 24 = тест-день (разовая фикс-цена)
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

-- ── retail_pool: пул портов для автовыдачи ─────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_pool (
  id INTEGER PRIMARY KEY,
  server TEXT NOT NULL,
  port_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'free',          -- free|reserved|leased|blocked
  client_id TEXT,
  reserved_until TEXT,
  hold_until TEXT,
  last_client_id TEXT,
  updated_at TEXT,
  UNIQUE(server, port_id)
);

-- ── card_payments: эквайринг (этап 4) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_payments (
  id INTEGER PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,                                  -- card | sbp
  status TEXT NOT NULL DEFAULT 'created',       -- created|paid|credited|failed|refunded
  provider_payment_id TEXT,
  raw_json TEXT,
  created_at TEXT,
  credited_at TEXT
);

-- ── data-миграция: clients.price → price_override ──────────────────────────
-- Всем существующим клиентам фиксируем текущую цену как индивидуальную —
-- после переезда биллинга на getClientPrice (override → tariff → legacy price)
-- ни у кого цена не меняется (Р36).
UPDATE clients SET price_override = price WHERE price_override IS NULL AND price > 0;
