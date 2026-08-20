-- 070: server_metrics — периодический снимок загрузки ProxySmart-боксов (джоба ServerMetrics)
-- Источники: SSH (cpu/load/mem/swap/disk/temp/uptime, приоритетно) + HTTP-панель
-- /system_status (conns/rps/mongo/usb/дрейф времени) — source фиксирует, что реально собрано
-- История 7 дней, прун в самой джобе
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

CREATE TABLE IF NOT EXISTS server_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name        TEXT NOT NULL,
  collected_at       TEXT NOT NULL,          -- ISO-метка сбора (UTC)
  source             TEXT NOT NULL DEFAULT '', -- 'ssh' | 'http' | 'mixed' | '' (ничего не собрано)
  cpu_pct            REAL,                   -- NULL = метрики нет (SSH недоступен)
  load1              REAL,
  load5              REAL,
  load15             REAL,
  mem_used_pct       REAL,
  swap_used_pct      REAL,
  disk_used_pct      REAL,
  temp_c             REAL,
  uptime_sec         INTEGER,
  conns              INTEGER,                -- живые коннекты панели (HTTP)
  rps                REAL,                   -- requests/second панели (HTTP)
  mongo_ok           INTEGER,                -- 1/0, NULL = неизвестно
  usb_errors         TEXT NOT NULL DEFAULT '', -- '' = нет/неизвестно, иначе «N: первая строка»
  box_time_drift_sec INTEGER,                -- дрейф часов бокса относительно дашборда, сек
  error              TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_server_metrics_name_ts ON server_metrics(server_name, collected_at);
