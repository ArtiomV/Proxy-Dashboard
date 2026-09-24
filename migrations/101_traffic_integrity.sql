-- 2026-09-24 · DEEP-29/31/33 (FIX-SPEC §19.4): достоверные интервалы трафика.
--
-- DEEP-31: raw-наблюдения часа хранятся ОТДЕЛЬНО от расчётных байтов.
-- NULL = строка не корректировалась (raw == bytes). Заполнено: clamp спайка,
-- median-сглаживание, карантин сверхпорогового часа (uncertain=4, bytes=0).
ALTER TABLE traffic_hourly ADD COLUMN raw_bytes_in  INTEGER DEFAULT NULL;
ALTER TABLE traffic_hourly ADD COLUMN raw_bytes_out INTEGER DEFAULT NULL;

-- DEEP-33: HTTP-чек фиксирует, через КАКОЙ порт и ПОЧЕМУ он был выбран
-- (roster binding / first_valid fallback / ambiguous_clone_imei) — результат
-- одного маршрута больше не выдаётся за независимые проверки двух модемов
-- при клонированном IMEI. Без секретов (только port_id и причина).
ALTER TABLE modem_httpcheck ADD COLUMN port_id      TEXT NOT NULL DEFAULT '';
ALTER TABLE modem_httpcheck ADD COLUMN route_reason TEXT NOT NULL DEFAULT '';
