-- 055: выпил мёртвых фич (ТЗ-рефакторинг, блок C)
-- C1 SLA: таблица sla_violations + колонки clients sla_* (добавлены миграцией
-- 019, поэтому DROP COLUMN отрабатывает и на свежих БД) — действующих
-- договоров с SLA нет, мониторинг качества (proxy_checks) НЕ затрагивается
-- C3 AI-лидген: таблицы sales_* (созданы миграциями 037/038)
-- C6: external_proxies (создаётся миграцией 005) и traffic_recon (миграция 048)
-- DROP TABLE IF EXISTS безопасен и на свежих БД, где таблиц уже нет
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

DROP TABLE IF EXISTS sla_violations;
DROP TABLE IF EXISTS sales_niches;
DROP TABLE IF EXISTS sales_companies;
DROP TABLE IF EXISTS sales_contacts;
DROP TABLE IF EXISTS sales_jobs;
DROP TABLE IF EXISTS external_proxies;
DROP TABLE IF EXISTS traffic_recon;

ALTER TABLE clients DROP COLUMN sla_uptime_pct;
ALTER TABLE clients DROP COLUMN sla_max_latency_ms;
ALTER TABLE clients DROP COLUMN sla_max_error_pct;
ALTER TABLE clients DROP COLUMN sla_auto_credit;
