-- 2026-09-18 · DEEP-15 (FIX-SPEC §15.2): durable-маркер отложенного возврата
-- тестового порта в пул. Если отвязку нельзя подтвердить (сервер удалён из
-- конфигурации/недоступен, дедлайн невалиден, apply не применил portName),
-- строка НЕ переводится в free: порт остаётся leased (недоступен для продажи)
-- и повторяется в следующих циклах retail-guard. Здесь — причина:
--   server_unknown | invalid_deadline | unbind_unconfirmed
-- release() сбрасывает маркер вместе со статусом.
ALTER TABLE retail_pool ADD COLUMN pending_release TEXT;
