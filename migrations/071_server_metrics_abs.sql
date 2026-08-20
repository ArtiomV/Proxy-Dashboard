-- 071: server_metrics — абсолютные значения RAM/диска в MiB (джоба ServerMetrics)
-- Проценты на шкалах «Загрузки серверов» остаются, рядом фронт показывает
-- реальные цифры («86/232 ГБ»). NULL для старых строк и HTTP-only сборов
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

ALTER TABLE server_metrics ADD COLUMN mem_used_mb INTEGER;
ALTER TABLE server_metrics ADD COLUMN mem_total_mb INTEGER;
ALTER TABLE server_metrics ADD COLUMN disk_used_mb INTEGER;
ALTER TABLE server_metrics ADD COLUMN disk_total_mb INTEGER;
