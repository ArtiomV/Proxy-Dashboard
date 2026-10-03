-- 2026-10-03: бэкфилл ip_history из rotation_log.
-- До миграции 107 ip_history обрезалась до 100 строк на модем, поэтому
-- аналитика «IP-разнообразие» (ip_stats) за 30/90 дней показывала 80–100
-- уникальных IP вместо реальных тысяч. rotation_log хранит полную историю
-- ротаций с new_ip — переносим её в ip_history за окно retention (90 дней):
--   key       = server_name || '_' || imei  (как пишет recordIpChange)
--   ended_at  = started_at следующей ротации того же модема (LEAD),
--               у последней записи NULL (IP ещё действует)
-- Дубликаты по (key, started_at) пропускаем — свежие строки, записанные
-- recordIpChange после 107, не задваиваются. Расхождения по секундам между
-- поллингом и rotation_log на COUNT(DISTINCT ip) не влияют.
-- modem_meta дедуплицируем по (server_name, nick) живых записей — иначе
-- SIM-swap с двумя IMEI у одного ника удвоил бы строки.
INSERT INTO ip_history (key, ip, started_at, ended_at)
WITH meta AS (
  SELECT server_name, nick, MAX(imei) AS imei
    FROM modem_meta
   WHERE deleted = 0 AND imei IS NOT NULL AND imei != ''
   GROUP BY server_name, nick
), src AS (
  SELECT r.server_name || '_' || m.imei AS key,
         r.new_ip AS ip,
         r.started_at AS started_at,
         LEAD(r.started_at) OVER (
           PARTITION BY r.server_name, r.nick ORDER BY r.started_at
         ) AS ended_at
    FROM rotation_log r
    JOIN meta m ON m.server_name = r.server_name AND m.nick = r.nick
   WHERE r.started_at >= datetime('now', '-90 days')
     AND r.new_ip IS NOT NULL AND r.new_ip != ''
)
SELECT key, ip, started_at, ended_at
  FROM src s
 WHERE NOT EXISTS (
   SELECT 1 FROM ip_history h
    WHERE h.key = s.key AND h.started_at = s.started_at
 )
 ORDER BY key, started_at;
