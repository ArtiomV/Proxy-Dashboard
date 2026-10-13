-- 2026-10-13: ИИ-технический директор (src/cto). Предложения проходят путь
-- pending → approved → applied → verified (или rejected / snoozed / failed /
-- rolled_back / acknowledged для советов без исполняемого действия).
CREATE TABLE IF NOT EXISTS cto_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  run_id        INTEGER,
  fingerprint   TEXT NOT NULL,            -- sha1(тема|цель|действие): не повторять отклонённое
  category      TEXT NOT NULL DEFAULT 'general',
  severity      TEXT NOT NULL DEFAULT 'info',   -- info | warn | critical
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',       -- что вижу и почему предлагаю
  evidence_json TEXT NOT NULL DEFAULT '[]',     -- [{fact, source, kind:'data'|'assumption'}]
  expected      TEXT NOT NULL DEFAULT '',       -- ожидаемый эффект / как проверю
  action_type   TEXT NOT NULL DEFAULT 'advice', -- advice | set_modem_rotation | set_setting
  action_json   TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_at    TEXT,
  decided_by    TEXT,
  snooze_until  TEXT,
  applied_at    TEXT,
  before_json   TEXT,                           -- состояние до применения (для отката)
  result_json   TEXT,
  verify_after  TEXT,                           -- когда проверять эффект
  verified_at   TEXT,
  verify_json   TEXT,
  tg_chat_id    TEXT,
  tg_message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cto_prop_status ON cto_proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cto_prop_fp ON cto_proposals(fingerprint);

CREATE TABLE IF NOT EXISTS cto_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  trigger       TEXT NOT NULL DEFAULT 'schedule',   -- schedule | manual | event
  status        TEXT NOT NULL DEFAULT 'running',    -- running | ok | failed | skipped
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  proposals     INTEGER DEFAULT 0,
  summary       TEXT,                               -- итог осмотра одной фразой
  next_run_in_h REAL,                               -- решение ИИ (в границах 6–12 ч)
  next_run_why  TEXT,
  error         TEXT
);
