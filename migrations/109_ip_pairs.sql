-- 2026-10-03: rollup-таблица уникальных пар (модем, IP) для ip_stats.
-- После бэкфилла 108 ip_history выросла до ~450 тыс. строк за 30 дней, и
-- /api/analytics/ip_stats выполнялся 22 с (шесть полных сканов с
-- DISTINCT/GROUP BY и join'ом modem_meta по конкатенации), блокируя event
-- loop — у клиентов «зависали» блоки кабинета. Аналитика уникальных адресов
-- не нуждается в каждом назначении: достаточно пары (key, ip) с first/last
-- seen. Пары поддерживаются инкрементально в recordIpChange; здесь —
-- первичный бэкфилл из ip_history.
CREATE TABLE IF NOT EXISTS ip_pairs (
  key        TEXT NOT NULL,
  ip         TEXT NOT NULL,
  first_seen TEXT,
  last_seen  TEXT,
  PRIMARY KEY (key, ip)
);
CREATE INDEX IF NOT EXISTS idx_ip_pairs_last ON ip_pairs(last_seen);

INSERT OR IGNORE INTO ip_pairs (key, ip, first_seen, last_seen)
  SELECT key, ip, MIN(started_at), MAX(started_at)
    FROM ip_history
   GROUP BY key, ip;
