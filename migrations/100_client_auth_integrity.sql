-- 2026-09-18 · DEEP-25/27 (FIX-SPEC §15.3): целостность учётных записей.
--
-- DEEP-25: уникальность email — на уровне БД, по нормализованному значению
-- (register хранит lower(trim(email)), но гонка двух запросов проходила
-- in-memory проверку до commit). Частичный UNIQUE-индекс по lower(email):
-- B2B-клиенты без email (NULL/'') не ограничиваются. login уже UNIQUE NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_norm_unique
  ON clients(lower(email)) WHERE email IS NOT NULL AND email != '';

-- DEEP-27: версия аутентификации. Инкрементируется каждой сменой пароля
-- (reset/change — clientsDb.updatePasswordHash). login, начавший
-- bcrypt.compare со старым хэшем ДО сброса, после compare сверяет версию:
-- изменилась — сессию не выдаём (иначе старый пароль получал новую сессию
-- уже после durable-смены пароля и отзыва сессий).
ALTER TABLE clients ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
