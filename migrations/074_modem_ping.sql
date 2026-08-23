-- 074: modem_ping — история пингов модемов (A1, ТЗ мониторинга v2, 23.08)
-- Источник — net_details.ping_stats из /apix/show_status_json (бокс сам
-- пингует через каждый модем, ~1/мин), пишем на каждом цикле tracking'а
-- Джоба src/jobs/modem-ping.js, ретенция — retention_modem_ping (дефолт 30 дн)
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

CREATE TABLE IF NOT EXISTS modem_ping (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,               -- ISO-метка опроса (UTC)
  server      TEXT NOT NULL,
  nick        TEXT NOT NULL,
  latency_ms  INTEGER,                     -- NULL = не распарсилось
  loss_pct    INTEGER,                     -- 0–100
  ok          INTEGER NOT NULL DEFAULT 1   -- 1 = loss < ping_loss_dead_pct
);

CREATE INDEX IF NOT EXISTS idx_modem_ping_nick ON modem_ping(server, nick, ts);
