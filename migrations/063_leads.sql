-- 063: Входящие заявки с лендинга arendaproxy.ru (inbox + аудит CRM-push).
--
-- POST /api/public/lead (без auth) пишет каждую заявку сюда ДО попытки
-- отправки в Twenty CRM: если CRM недоступна, заявка не теряется —
-- crm_status='failed', алерт админу, можно допушить вручную.
--
-- status     — воронка (пока только 'new'; обработка идёт в Twenty)
-- crm_status — pending | pushed | failed (результат push в Twenty)

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  contact       TEXT NOT NULL,                -- @telegram или телефон
  contact_type  TEXT NOT NULL DEFAULT 'telegram',  -- telegram | phone
  message       TEXT NOT NULL DEFAULT '',
  product       TEXT NOT NULL DEFAULT '',     -- mobile | residential_* | any
  offer         TEXT NOT NULL DEFAULT '',     -- trial_24h | consultation | ...
  page          TEXT NOT NULL DEFAULT '',     -- страница сайта
  cta_position  TEXT NOT NULL DEFAULT '',     -- точка CTA
  utm_json      TEXT NOT NULL DEFAULT '{}',   -- UTM-метки (localStorage ap_utm)
  ip            TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',
  crm_status    TEXT NOT NULL DEFAULT 'pending',
  crm_person_id TEXT NOT NULL DEFAULT ''      -- uuid персоны в Twenty
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_crm_status ON leads(crm_status);
