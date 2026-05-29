-- 034_operator_backfill.sql
-- The heatmap "по операторам" reads traffic_hourly.operator, which is frozen at
-- write time each hour. When a modem's live CELLOP read the literal placeholder
-- "Unknown" (or was empty — common right after a rotation/reconnect), that value
-- got baked in even though the modem's real carrier is known elsewhere.
--
-- Recover those rows from two persisted sources, in priority order:
--   1. modem_meta  — authoritative per-modem operator (server_name + nick)
--   2. proxy_checks — latest carrier observed by the latency-check job
-- Whatever still can't be resolved is normalized to '' so the breakdown skips it
-- instead of showing a bogus "Unknown" bucket.
--
-- Idempotent: only touches rows whose operator is currently '' / 'Unknown'.

-- 1. From modem_meta (skip meta rows that are themselves empty/Unknown)
UPDATE traffic_hourly
   SET operator = (
     SELECT m.operator FROM modem_meta m
      WHERE m.server_name = traffic_hourly.server_name
        AND m.nick = traffic_hourly.nick
        AND TRIM(m.operator) != '' AND LOWER(m.operator) != 'unknown'
      LIMIT 1)
 WHERE (operator = '' OR operator = 'Unknown' OR operator IS NULL)
   AND EXISTS (
     SELECT 1 FROM modem_meta m
      WHERE m.server_name = traffic_hourly.server_name
        AND m.nick = traffic_hourly.nick
        AND TRIM(m.operator) != '' AND LOWER(m.operator) != 'unknown');

-- 2. From the latest non-Unknown proxy-check observation
UPDATE traffic_hourly
   SET operator = (
     SELECT pc.operator FROM proxy_checks pc
      WHERE pc.server_name = traffic_hourly.server_name
        AND pc.nick = traffic_hourly.nick
        AND TRIM(pc.operator) != '' AND LOWER(pc.operator) != 'unknown'
      ORDER BY pc.checked_at DESC LIMIT 1)
 WHERE (operator = '' OR operator = 'Unknown' OR operator IS NULL)
   AND EXISTS (
     SELECT 1 FROM proxy_checks pc
      WHERE pc.server_name = traffic_hourly.server_name
        AND pc.nick = traffic_hourly.nick
        AND TRIM(pc.operator) != '' AND LOWER(pc.operator) != 'unknown');

-- 3. Collapse the legacy double-spaced Moldtelecom variant
UPDATE traffic_hourly SET operator = 'Moldtelecom'
 WHERE LOWER(REPLACE(REPLACE(operator,'  ',' '),'  ',' ')) = 'moldtelecom moldtelecom';

-- 4. Anything still literally 'Unknown' is genuinely unresolved — blank it so it
--    drops out of the per-operator breakdown rather than mislabeling real traffic
--    as a carrier named "Unknown".
UPDATE traffic_hourly SET operator = '' WHERE operator = 'Unknown';

-- 5. Heal modem_meta itself (feeds the Модемы page). A signal-loss poll can
--    freeze 'Unknown'/'' into the authoritative per-modem operator; recover it
--    from the latest non-Unknown proxy-check so the modems page agrees with the
--    heatmap. The runtime guard also self-heals on the next good poll, but this
--    makes it correct immediately on deploy.
UPDATE modem_meta
   SET operator = (
     SELECT pc.operator FROM proxy_checks pc
      WHERE pc.server_name = modem_meta.server_name
        AND pc.nick = modem_meta.nick
        AND TRIM(pc.operator) != '' AND LOWER(pc.operator) != 'unknown'
      ORDER BY pc.checked_at DESC LIMIT 1)
 WHERE (operator = '' OR LOWER(operator) = 'unknown')
   AND EXISTS (
     SELECT 1 FROM proxy_checks pc
      WHERE pc.server_name = modem_meta.server_name
        AND pc.nick = modem_meta.nick
        AND TRIM(pc.operator) != '' AND LOWER(pc.operator) != 'unknown');
