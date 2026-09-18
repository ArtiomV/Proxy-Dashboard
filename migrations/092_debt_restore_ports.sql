-- 2026-09-18 · DEEP-08 (FIX-SPEC §15.1): durable-список ожидаемых пар
-- server+portID долгового восстановления legacy-клиента (JSON
-- [{server, portId}]). Сохраняется при автоблоке ДО сетевых действий;
-- отсутствие сервера в фиде больше не завершает операцию «успехом».
ALTER TABLE clients ADD COLUMN debt_restore_ports TEXT;
