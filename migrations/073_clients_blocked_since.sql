-- 073: clients.blocked_since — метка времени входа в блокировку (ручную или
-- долговую). Джоба автоудаления портов отсчитывает от неё срок хранения
-- (retail_hold_days). Бэкфилл: для уже заблокированных — balance_negative_since
-- (долговые) или updated_at (ручные), чтобы hold не отсчитывался «с нуля»
-- NULL = не заблокирован / блок до внедрения без известной даты
-- Плюс: юрлицам по умолчанию разрешён уход в минус (allow_debt=1) — их порты
-- не блокируются и не удаляются автоматически (договорённость 21.08)
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

ALTER TABLE clients ADD COLUMN blocked_since TEXT;

UPDATE clients SET blocked_since = COALESCE(balance_negative_since, updated_at, datetime('now'))
WHERE blocked = 1 OR debt_blocked = 1;

UPDATE clients SET allow_debt = 1 WHERE client_type = 'legal';
