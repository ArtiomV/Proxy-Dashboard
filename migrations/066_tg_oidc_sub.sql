-- 066_tg_oidc_sub.sql — OIDC sub Telegram-логина (миграция с Login Widget на OIDC).
-- sub в OIDC — НЕ числовой telegram user id (бот хранит его в tg_chat_id),
-- а отдельный 18-значный идентификатор. Из-за совпадения по tg_chat_id OIDC-вход
-- создавал ДУБЛЬ аккаунта вместо входа в существующий (15.08.2026).
-- Связка: при OIDC-входе сначала ищем по tg_oidc_sub; промах — по tg_username
-- (если Telegram его отдал) и прикрепляем sub к найденному аккаунту.

ALTER TABLE clients ADD COLUMN tg_oidc_sub TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_oidc_sub ON clients(tg_oidc_sub) WHERE tg_oidc_sub IS NOT NULL;
