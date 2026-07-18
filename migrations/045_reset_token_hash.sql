-- 045: hash client reset tokens at rest (SHA-256), same scheme as 043 for
-- API keys. reset_token was the last plaintext bearer secret in the DB.
-- After this, a working reset link is only ever shown once, at rotation
-- (POST /api/client/reset_link/rotate).
--
-- NB: sha256hex() is registered by server.js via better-sqlite3 db.function()
-- before the migration runner executes — do not run standalone via sqlite3
-- CLI. Keep comments free of statement terminators (the runner splits naively).

UPDATE clients SET reset_token = sha256hex(reset_token)
  WHERE reset_token IS NOT NULL AND reset_token != ''
    AND (length(reset_token) != 64 OR reset_token GLOB '*[^0-9a-f]*');
