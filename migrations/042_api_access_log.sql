-- 042_api_access_log.sql
-- Inbound API access log: one row per CLIENT/EXTERNAL-facing API request so the
-- admin can see WHO accessed the API, WHEN, and FOR WHAT PURPOSE. Written by the
-- global /api access-log middleware in server.js. Covers: public API (X-API-Key),
-- client portal sessions, reset-by-link IP rotation, the Tochka payment webhook,
-- and login attempts. Admin self-traffic (dashboard polling) is NOT recorded —
-- it is noise, and admin actions already live in audit_log.
CREATE TABLE IF NOT EXISTS api_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  caller_type TEXT NOT NULL,                             -- api_key | portal | reset_link | webhook | auth
  client_id   INTEGER,
  client_name TEXT,
  identity    TEXT,                                      -- api-key prefix / login / token tail / 'tochka'
  method      TEXT,
  path        TEXT,
  purpose     TEXT,                                      -- human category (RU)
  status      INTEGER,
  duration_ms INTEGER,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_aal_ts      ON api_access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_aal_client  ON api_access_log(client_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_aal_type    ON api_access_log(caller_type, ts DESC);
