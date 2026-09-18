-- 2026-09-18 · DEEP-20/21 (§ FIX-SPEC): идемпотентность покупки отделена от
-- ключа суточного списания.
--   • purchase_id — идентификатор durable-покупки (retail_purchases.id) для
--     charge первых суток/тест-дня. Повтор ТОЙ ЖЕ покупки упирается в
--     idx_ledger_purchase_unique → duplicate, а вторая РАЗНАЯ покупка в тот же
--     день больше не конфликтует с первой.
--   • Суточный ключ idx_ledger_unique_chargelike сохранён (UNIQUE вслепую НЕ
--     снимаем — иначе открылись бы двойные суточные списания), но теперь он
--     действует только на строки БЕЗ purchase_id: дневной расчёт, коррекции,
--     ручные списания. Гварды биллинга (existsChargeOnDate /
--     chargedClientIdsForDate) фильтруют purchase-строки тем же предикатом,
--     поэтому first_day-строка покупки больше не останавливает расчёт всех
--     клиентов.
ALTER TABLE billing_ledger ADD COLUMN purchase_id TEXT;

DROP INDEX IF EXISTS idx_ledger_unique_chargelike;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_chargelike
  ON billing_ledger(client_id, date, type)
  WHERE type IN ('charge', 'correction', 'manual_charge') AND purchase_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_purchase_unique
  ON billing_ledger(purchase_id)
  WHERE purchase_id IS NOT NULL;
