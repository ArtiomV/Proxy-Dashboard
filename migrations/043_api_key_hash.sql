-- 043: hash client API keys at rest (SHA-256).
-- A leaked dashboard.db / backup no longer yields working API keys.
-- api_key_prefix keeps a display prefix (e.g. "prx_ab12") so the UI can show
-- a masked key. The full key is only ever shown once, at (re)generation.
--
-- NB: sha256hex() is a JS function registered by server.js via better-sqlite3
-- db.function() BEFORE the migration runner executes. Running this file
-- standalone (sqlite3 CLI) will fail with "no such function: sha256hex".
--
-- NB2: keep comments in this file free of statement-terminator characters —
-- the migration runner's per-statement fallback splits the file naively.

ALTER TABLE clients ADD COLUMN api_key_prefix TEXT;

UPDATE clients SET api_key_prefix = substr(api_key, 1, 8)
  WHERE api_key IS NOT NULL AND api_key != ''
    AND (api_key_prefix IS NULL OR api_key_prefix = '');

-- Hash anything that isn't already a 64-char lowercase hex digest
-- (idempotent: a re-run or partially-migrated DB won't double-hash).
UPDATE clients SET api_key = sha256hex(api_key)
  WHERE api_key IS NOT NULL AND api_key != ''
    AND (length(api_key) != 64 OR api_key GLOB '*[^0-9a-f]*');
