-- 075 — ТЗ мониторинга v2, этап 2 (23.08): A3 (мгновенная скорость модема)
-- и A2 (HTTP-чек сайта через прокси-порт модема).

-- A3: снимок текущей скорости модема каждые 5 мин (rate = дельта суточных
-- bw-счётчиков бокса за скользящее окно). Ретенция 7 дн (retention_modem_rate).
CREATE TABLE IF NOT EXISTS modem_rate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,               -- ISO UTC
  server TEXT NOT NULL,
  nick TEXT NOT NULL,
  rate_in_mbps REAL NOT NULL DEFAULT 0,
  rate_out_mbps REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_modem_rate_nick ON modem_rate (server, nick, ts);

-- A2: результат HTTP-чека сайта через прокси-порт модема («глазами клиента»).
-- content_ok: 1 — страница прошла must/must-not проверки, 0 — не прошла
-- (редирект оператора/фильтрация), NULL — проверки контента не заданы.
-- Ретенция 30 дн (retention_modem_httpcheck).
CREATE TABLE IF NOT EXISTS modem_httpcheck (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,               -- ISO UTC
  server TEXT NOT NULL,
  nick TEXT NOT NULL,
  status INTEGER,                 -- HTTP status или NULL при сетевой ошибке
  total_ms INTEGER,
  content_ok INTEGER,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_modem_httpcheck_nick ON modem_httpcheck (server, nick, ts);
