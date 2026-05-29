-- 032: Notifications module rework (Stage 18.15).
-- Full design context: src/telegram/alerts.js + src/jobs/notify-collect.js
-- + src/routes/notifications.js. The bell in the admin header used to
-- regenerate a list client-side on every refresh, with no persistence and
-- a single «mark all read» action. This migration backs the unified store.
--
-- Two tables. notifications holds the events (one row = one occurrence,
-- deduped by dedup_key). notification_read_state holds per-user read +
-- dismiss markers — the events are shared across admins but each admin
-- has their own «прочитано/скрыто» state.

CREATE TABLE IF NOT EXISTS notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key       TEXT NOT NULL,
  rule_id         TEXT NOT NULL,                -- e.g. 'server_unreachable', 'modem_offline', 'client_debt'
  priority        TEXT NOT NULL DEFAULT 'info', -- critical | important | early | info
  entity_kind     TEXT,                         -- modem | client | crm | system | payment
  entity_id       TEXT,                         -- nick / client_id / crm_id / null
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,                -- short HTML-safe message
  payload_json    TEXT,                         -- original alerts.trigger payload
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One open dedup_key at a time. Once an event is older than 30 days
-- it's purged by the collector job — gives the dedup logic a sliding
-- window without locking forever. The collector also avoids re-emitting
-- when an active row exists for the same key.
CREATE INDEX IF NOT EXISTS idx_notifications_dedup     ON notifications(dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_created   ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_priority  ON notifications(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_entity    ON notifications(entity_kind, entity_id);

CREATE TABLE IF NOT EXISTS notification_read_state (
  notif_id        INTEGER NOT NULL,
  user_login      TEXT NOT NULL,
  read_at         TEXT,
  dismissed_at    TEXT,
  PRIMARY KEY (notif_id, user_login),
  FOREIGN KEY (notif_id) REFERENCES notifications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_read_user ON notification_read_state(user_login, dismissed_at, read_at);
