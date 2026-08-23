-- 080: единый периодический аптайм модемов
-- Старый health-score и его дневная история удалены по решению продукта
-- Клиентский аптайм агрегируется из тех же минутных online/total-проверок

DROP TABLE IF EXISTS modem_health_daily;

CREATE TABLE IF NOT EXISTS client_uptime_daily (
  key         TEXT NOT NULL,
  date        TEXT NOT NULL,
  client_name TEXT NOT NULL,
  online      INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, date, client_name)
);

CREATE INDEX IF NOT EXISTS idx_client_uptime_daily_client
  ON client_uptime_daily(client_name, date, key);
