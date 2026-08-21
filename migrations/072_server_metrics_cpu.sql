-- 072: server_metrics — модель CPU и число потоков (джоба ServerMetrics, SSH)
-- Подпись строки CPU в карточке сервера показывает «i3-10100 · 8 потоков»
-- вместо общего «Загрузка процессора». NULL для старых строк и HTTP-only сборов
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

ALTER TABLE server_metrics ADD COLUMN cpu_model TEXT;
ALTER TABLE server_metrics ADD COLUMN cpu_cores INTEGER;
