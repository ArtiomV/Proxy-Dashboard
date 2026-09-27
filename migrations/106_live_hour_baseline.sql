-- 2026-09-27: собственный baseline для «живой ячейки» текущего часа в
-- /api/analytics/heatmap. Раньше live-дельта считалась от hourly_snapshots.
-- day_at_last_hour_start — но этот baseline управляется логикой часовой
-- агрегации и может быть 0/протухшим (инцидент: RO1, 27.09 — baseline=0
-- после обнуления счётчиков ProxySmart дал +226 ГБ фантома за час).
-- Здесь — наша собственная точка отсчёта: первое наблюдение порта в текущем
-- МСК-часе. Дельта считается только внутри часа, скачки baseline извне не
-- влияют; недооценка ограничена первой минутой часа (дашборд опрашивает ~раз
-- в минуту).
CREATE TABLE IF NOT EXISTS live_hour_baseline (
  port_id   TEXT PRIMARY KEY,
  hour_key  TEXT NOT NULL,        -- 'YYYY-MM-DD HH' по МСК
  bytes     INTEGER NOT NULL
);
