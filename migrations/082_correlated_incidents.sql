-- 082 — корреляция алертов: несколько падений одного оператора на одной
-- площадке превращаются в один инцидент с жизненным циклом и итогом

CREATE TABLE IF NOT EXISTS monitoring_incidents (
  id              TEXT PRIMARY KEY,
  correlation_key TEXT NOT NULL,
  server          TEXT NOT NULL DEFAULT '',
  operator        TEXT NOT NULL DEFAULT '',
  hypothesis      TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  opened_at       TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  closed_at       TEXT,
  duration_sec    INTEGER,
  modem_count     INTEGER NOT NULL DEFAULT 0,
  client_count    INTEGER NOT NULL DEFAULT 0,
  members_json    TEXT NOT NULL DEFAULT '[]',
  reasons_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_monitoring_incidents_state_time
  ON monitoring_incidents(state, opened_at);
