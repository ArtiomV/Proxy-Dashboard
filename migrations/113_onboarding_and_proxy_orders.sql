-- 2026-10-15: личный кабинет розницы.
-- client_onboarding — выбор «физлицо / юрлицо» при первом входе и анкета юрлица
-- (реквизиты для договора). Основные поля (ИНН, КПП, название, адрес) дублируются
-- в clients — там их читают счета/акты; здесь — полная анкета и статус договора.
CREATE TABLE IF NOT EXISTS client_onboarding (
  client_id        TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL,                     -- individual | legal
  requisites_json  TEXT NOT NULL DEFAULT '{}',        -- анкета юрлица
  contract_status  TEXT NOT NULL DEFAULT 'none',      -- none | awaiting_template | generated | sent
  manager_task     TEXT,                              -- id задачи в CRM (если создана)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- proxy_orders — заказы, которые выдаёт менеджер (прокси РФ): клиент выбирает тип,
-- гео и количество, менеджер получает задачу (CRM + Telegram) и выдаёт вручную.
CREATE TABLE IF NOT EXISTS proxy_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL,
  region       TEXT NOT NULL,                         -- RU
  proxy_type   TEXT NOT NULL,
  geo          TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  comment      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'new',           -- new | in_progress | done | cancelled
  manager_task TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proxy_orders_client ON proxy_orders(client_id, created_at);
