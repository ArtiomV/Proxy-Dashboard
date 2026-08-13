-- 062_retail_guard.sql — B2C Этап 2: конвейер автоблока розницы (retail-guard).
--
-- retail_pool.test_expires_at — дедлайн возврата ТЕСТ-ДНЯ в пул:
--   NULL  — обычная подписка (не трогаем);
--   ISO   — для тест-тарифа (duration_hours=24): выдача + 24ч, проставляет
--           buy_proxy; по истечении retail-guard отвязывает порт (пустой
--           portName) и возвращает строку в free.

ALTER TABLE retail_pool ADD COLUMN test_expires_at TEXT;
