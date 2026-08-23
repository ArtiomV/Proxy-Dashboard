-- 076 — ТЗ мониторинга v2, этап 4 (23.08): B2 (ack-кнопки «в работе» /
-- «решено» в Telegram) и B3 (maintenance-окна обслуживания)
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

-- B2: подтверждения алертов из TG. kind='ack' — «в работе», глушит правило
-- по dedup-ключу до until_ts (ms-эпоха), kind='solved' — «решено», глушит
-- до конца инцидента (until_ts IS NULL). Подавление проверяется в
-- alerts.trigger() до проверки cooldown
CREATE TABLE IF NOT EXISTS alert_acks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    TEXT NOT NULL,
  dedup_key  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('ack','solved')),
  acked_by   TEXT NOT NULL DEFAULT '',
  acked_at   TEXT NOT NULL,
  until_ts   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alert_acks_rule ON alert_acks(rule_id, dedup_key);

-- B3: окна обслуживания. Пока объект (сервер/модем) в активном окне, его
-- алерты молчат, а эпизоды server_downtime помечаются maintenance=1 и
-- исключаются из SLA-отчёта (C1). from_ts/to_ts — ms-эпоха
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('server','modem')),
  target_id   TEXT NOT NULL,
  from_ts     INTEGER NOT NULL,
  to_ts       INTEGER NOT NULL,
  comment     TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_target ON maintenance_windows(target_type, target_id, from_ts);

-- B3: флаг «простой в окне обслуживания» для исключения из SLA
ALTER TABLE server_downtime ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0;
