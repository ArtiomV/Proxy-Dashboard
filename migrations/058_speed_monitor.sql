-- 058: speed_monitor — почасовой замер скорости выбранных модемов (джоба SpeedMonitor)
-- Для анализа стабильности операторов по локациям: dl/ul/ping + ok/error каждый час
-- по каждому отслеживаемому нику, история 60 дней (прун в самой джобе)
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

CREATE TABLE IF NOT EXISTS speed_monitor (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  server   TEXT NOT NULL DEFAULT '',
  nick     TEXT NOT NULL,
  imei     TEXT NOT NULL DEFAULT '',
  download REAL NOT NULL DEFAULT 0,
  upload   REAL NOT NULL DEFAULT 0,
  ping     REAL NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 1,
  error    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_speedmon_nick_ts ON speed_monitor(nick, ts);
CREATE INDEX IF NOT EXISTS idx_speedmon_ts ON speed_monitor(ts);
