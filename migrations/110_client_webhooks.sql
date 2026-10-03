-- 2026-10-03: клиентские вебхуки (ЛК → URL клиента). Одна запись на клиента
-- (v1): URL + набор событий. События: proxy_offline, proxy_online,
-- ip_changed, payment_received, daily_charge. Доставка — src/webhooks.js.
CREATE TABLE IF NOT EXISTS client_webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT 'proxy_offline,proxy_online,payment_received,daily_charge,ip_changed',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_ok_at  TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
