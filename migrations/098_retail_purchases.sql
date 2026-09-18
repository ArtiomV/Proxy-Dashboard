-- 2026-09-18 · DEEP-22 (§ FIX-SPEC): восстанавливаемая операция покупки прокси.
-- Каждая выдача из пула фиксируется durable-строкой ДО сетевых вызовов бокса;
-- статусная машина: reserved → provisioning → provisioned → charged,
-- компенсационные/аварийные ветки: failed (отвязка подтверждена, деньги не
-- тронуты), charge_failed (порт выдан, списание не прошло — recovery
-- досписывает по purchase_id), quarantine (исход сети неизвестен — reconcile
-- по свежему владельцу порта, порт НЕ возвращается в free вслепую).
CREATE TABLE IF NOT EXISTS retail_purchases (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  tariff_id   INTEGER,
  server      TEXT,
  port_id     TEXT,
  pool_row_id INTEGER,
  amount      REAL NOT NULL DEFAULT 0,
  test_day    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Финансовый резерв: одна незавершённая покупка на клиента. Второй запрос,
-- пока первая операция в полёте (или ждёт досписания/сверки), отклоняется —
-- два конкурентных запроса больше не проходят проверку одного баланса.
CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_purchases_inflight
  ON retail_purchases(client_id)
  WHERE status IN ('reserved', 'provisioning', 'provisioned', 'charge_failed', 'quarantine');

-- Уникальное право на тест-день — durable, а не только in-memory testUsed:
-- любая непровальная тестовая покупка навсегда закрывает повторную.
CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_purchases_testday
  ON retail_purchases(client_id)
  WHERE test_day = 1 AND status != 'failed';

CREATE INDEX IF NOT EXISTS idx_retail_purchases_pool ON retail_purchases(pool_row_id);
CREATE INDEX IF NOT EXISTS idx_retail_purchases_status ON retail_purchases(status);
