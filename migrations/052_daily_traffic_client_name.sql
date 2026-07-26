-- 052: daily_traffic — атрибуция клиента в момент записи (WP3).
-- Раньше клиент для daily_traffic вычислялся через ТЕКУЩИЙ маппинг
-- portKeyToPortName: перенесённый порт переписывал историю на нового
-- владельца (dry-run 2026-07-26: расхождения до ±27% против hourly-first).
-- Теперь писатели (recordDailyTraffic) замораживают client_name вместе с
-- байтами; историческая атрибуция до этой миграции — через traffic_hourly.

ALTER TABLE daily_traffic ADD COLUMN client_name TEXT NOT NULL DEFAULT '';
