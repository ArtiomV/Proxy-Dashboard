-- 047: normalize uptime_tracking out of its JSON blob (WP7.1).
-- The (key, data-json) shape made SQL impossible — fleet and uptime readers
-- were forced through the in-memory copy. Scalar fields become real columns
-- and the per-day buckets move to uptime_daily. Backfilled from the JSON in
-- pure SQL (json_extract / json_each).
--
-- NB: keep comments in this file free of statement terminators — the
-- migration runner's per-statement fallback splits the file naively.

ALTER TABLE uptime_tracking ADD COLUMN total_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uptime_tracking ADD COLUMN online_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uptime_tracking ADD COLUMN first_check TEXT;
ALTER TABLE uptime_tracking ADD COLUMN last_check TEXT;
ALTER TABLE uptime_tracking ADD COLUMN last_online_check TEXT;
ALTER TABLE uptime_tracking ADD COLUMN offline_alerted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS uptime_daily (
  key     TEXT NOT NULL,
  date    TEXT NOT NULL,
  online  INTEGER NOT NULL DEFAULT 0,
  total   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, date)
);

UPDATE uptime_tracking SET
  total_checks      = COALESCE(json_extract(data, '$.total_checks'), 0),
  online_checks     = COALESCE(json_extract(data, '$.online_checks'), 0),
  first_check       = json_extract(data, '$.first_check'),
  last_check        = json_extract(data, '$.last_check'),
  last_online_check = json_extract(data, '$.last_online_check'),
  offline_alerted   = COALESCE(json_extract(data, '$.offline_alerted'), 0)
  WHERE data IS NOT NULL AND data != '' AND data != '{}';

INSERT OR REPLACE INTO uptime_daily (key, date, online, total)
  SELECT t.key,
         j.key,
         COALESCE(json_extract(j.value, '$.online'), 0),
         COALESCE(json_extract(j.value, '$.total'), 0)
  FROM uptime_tracking t, json_each(t.data, '$.daily') j
  WHERE t.data IS NOT NULL AND t.data != '' AND t.data != '{}';

-- The old `data` blob column is intentionally RETAINED (unused): the
-- migration runner aborts on "no such column", so a DROP would break fresh
-- installs where schema.sql no longer creates it. It stays empty forever.
