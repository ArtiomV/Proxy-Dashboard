-- 093: 2026-09-18 · FIX-05/06 (FIX-SPEC раздел 7, DEEP-12/13 из 16.2) —
-- единая модель свежести нативных пингов ProxySmart
--
-- modem_ping остаётся историей ТОЛЬКО пригодных измерений: недостоверные
-- наблюдения (пустой/битый ping_stats) туда больше не попадают и не размывают
-- проценты (measured_at — время замера на боксе; API его не отдаёт, поле
-- зарезервировано и пока всегда NULL, выдумывать его запрещено ТЗ)
-- Историческим строкам достоверность задним числом не приписывается: текущий
-- статус и reboot читают только modem_ping_state ниже
--
-- modem_ping_state — текущее состояние НАБЛЮДЕНИЯ по каждому слоту
-- (server+nick): quality = valid | missing | invalid; stale не хранится —
-- вычисляется на каждом чтении из observed_at и TTL (ping_fresh_ttl_min,
-- дефолт 10 мин, общий с публичным статусом)
-- observed_at — время получения ЖИВОГО ответа бокса дашбордом (кэшированные
-- и офлайн-снимки до ingest не доходят), measured_at — как выше, NULL
-- Ключ — слот (server, nick), а не IMEI: на боксе возможны клоны IMEI
-- (FIX-SPEC 16.2), у каждого слота свой ping_stats

CREATE TABLE IF NOT EXISTS modem_ping_state (
  server      TEXT NOT NULL,
  nick        TEXT NOT NULL,
  imei        TEXT,
  quality     TEXT NOT NULL,
  latency_ms  INTEGER,
  loss_pct    INTEGER,
  ok          INTEGER,
  observed_at TEXT NOT NULL,
  measured_at TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (server, nick)
);

ALTER TABLE modem_ping ADD COLUMN measured_at TEXT;
