-- 054: billing_shadow_log — теневой тест тарификации (Фаза 0, §2 ТЗ).
-- Ежедневное сравнение двух вариантов списания per_gb клиентов БЕЗ движения
-- денег: V1 (legacy, прод) = max(durable, live) × price, V2 (канон) = durable
-- × price с фолбэком на live при hours_present < 20. Копит 4 недели — затем
-- решение о переключении боевого биллинга на V2 (критерии §2.2).
-- date — вчерашняя МСК-дата (как date в billing_ledger / daily_traffic).
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл.

CREATE TABLE IF NOT EXISTS billing_shadow_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  hours_present  INTEGER NOT NULL DEFAULT 0,
  gb_durable     REAL NOT NULL DEFAULT 0,
  gb_uncertain   REAL NOT NULL DEFAULT 0,
  gb_live        REAL NOT NULL DEFAULT 0,
  gb_v1          REAL NOT NULL DEFAULT 0,
  rub_v1         REAL NOT NULL DEFAULT 0,
  gb_v2          REAL NOT NULL DEFAULT 0,
  rub_v2         REAL NOT NULL DEFAULT 0,
  fallback_used  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(date, client_id)
);
CREATE INDEX IF NOT EXISTS idx_bsl_date ON billing_shadow_log(date);
CREATE INDEX IF NOT EXISTS idx_bsl_client ON billing_shadow_log(client_id, date);
