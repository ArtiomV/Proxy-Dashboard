-- 028: Append-only history of writes to critical kv_store entries.
--
-- Motivation: kv_store holds blobs (api_servers, app_settings, etc.) that are
-- routinely rewritten in full. A single buggy save can silently truncate fields
-- (see env↔DB merge bug, 2026-05-20). The nightly full-DB backup catches it
-- with up to 14 days lag, but is heavy to restore from. This per-key history
-- gives us field-level granularity and one-SQL rollback.
--
-- Pruning: kvSetCritical() in server.js keeps the last 50 versions per key.
CREATE TABLE IF NOT EXISTS kv_store_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,
  old_value       TEXT,        -- previous value (NULL if first write)
  new_value       TEXT NOT NULL,
  written_at      TEXT DEFAULT (datetime('now')),
  source          TEXT,        -- code path that triggered the write (for forensics)
  shape_signature TEXT,        -- compact JSON summary of the new value's shape
  regressed       INTEGER DEFAULT 0  -- 1 if write was flagged as shape regression but allowed
);
CREATE INDEX IF NOT EXISTS idx_kv_history_key ON kv_store_history(key, written_at DESC);
