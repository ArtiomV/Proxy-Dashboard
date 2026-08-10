-- 056_drop_payments.sql — РУЧНАЯ миграция (НЕ подхватывается autorun-раннером:
-- раннер читает только migrations/*.sql верхнего уровня, каталог manual/ он
-- не обходит — см. src/db/migrations.js).
--
-- Применять ТОЛЬКО после чистой сверки:
--   node scripts/reconcile-payments.js --db /root/Proxy-Dashboard/dashboard.db --out reconcile-report.json
-- Скрипт должен завершиться с «OK — расхождений нет» (exit 0). Расхождения
-- доимпортировать в billing_ledger и прогнать сверку повторно.
--
-- Применение на проде (с pre-deploy снапшотом БД):
--   cp dashboard.db dashboard.db.pre-056.bak
--   sqlite3 dashboard.db < migrations/manual/056_drop_payments.sql
--   sqlite3 dashboard.db "INSERT INTO _migrations (name) VALUES ('manual/056_drop_payments.sql');"
--   pm2 restart dashboard
--
-- После дропа убрать CREATE TABLE payments (+ её индексы) из schema.sql —
-- baseline для свежих БД больше не должен создавать мёртвую таблицу.

DROP TABLE IF EXISTS payments;
DROP INDEX IF EXISTS idx_payments_client_id;
DROP INDEX IF EXISTS idx_payments_date;
