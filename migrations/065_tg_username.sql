-- 065_tg_username.sql — username Telegram-аккаунта рядом с tg_chat_id (060).
-- Показываем в профиле ЛК, кто именно привязан (@username). Заполняется:
--   • при регистрации/входе через TG (Login/OIDC — preferred_username);
--   • при привязке по коду /start link_<code> (бот знает msg.from.username).
-- NULL/'' у ранее привязанных — до следующего входа/привязки.

ALTER TABLE clients ADD COLUMN tg_username TEXT;
