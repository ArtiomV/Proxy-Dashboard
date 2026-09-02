-- 086: grace-ротация API-ключей клиентов (self-serve перевыпуск в ЛК, v2.10.68)
-- api_key_created_at — когда выдан ТЕКУЩИЙ ключ (для карточки в ЛК)
-- api_key_prev + api_key_prev_expires_at — прежний ключ (хэш) продолжает
-- работать до этого момента (24 ч после перевыпуска), чтобы клиент обновил
-- интеграцию без обрыва. NULL у prev = старого ключа нет или grace истёк
-- NB: комментарии без точек с запятой — раннер миграций наивно сплитит файл

ALTER TABLE clients ADD COLUMN api_key_created_at TEXT;

ALTER TABLE clients ADD COLUMN api_key_prev TEXT;

ALTER TABLE clients ADD COLUMN api_key_prev_expires_at TEXT;
