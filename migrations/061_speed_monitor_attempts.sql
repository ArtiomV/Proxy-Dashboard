-- 061: speed_monitor.attempts — число попыток замера (1 или 2)
-- 2026-08-13: замер с повтором (низкий dl / ok=0 → один ретрай через ~25с),
-- attempts фиксирует, сколько реальных speedtest'ов ушло в строку
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

ALTER TABLE speed_monitor ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
