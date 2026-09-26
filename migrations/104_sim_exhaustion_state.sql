-- 2026-09-26: состояние «у симки исчерпан пакет» — персистентно, переживает
-- рестарт дашборда (раньше жило только в памяти sim-exhaustion job).
-- Пока строка активна:
--   * алерты нестабильности этого модема подавлены (alerts.js,
--     EXHAUST_SUPPRESSED_RULES) — причина известна, шум не нужен;
--   * почасовые спидтесты по модему пропускаются (speed-monitor) — оператор
--     не блокирует сеть, а режет скорость до ~0, замер бессмысленен и жрёт
--     трафик.
-- Строка удаляется только при подтверждённом восстановлении (IP выдаётся,
-- пинг проходит, sustained sim_exhaustion_recover_min) — с алертом
-- sim_package_recovered. Пополнение пакета оператором тем самым ловится
-- по косвенным признакам автоматически.
CREATE TABLE IF NOT EXISTS sim_exhaustion_state (
  server_name TEXT NOT NULL,
  imei        TEXT NOT NULL,
  nick        TEXT NOT NULL DEFAULT '',
  operator    TEXT NOT NULL DEFAULT '',
  since_ts    INTEGER NOT NULL,        -- мс epoch: с какого момента симптом держится
  alerted_at  INTEGER,                 -- мс epoch: когда ушёл алерт sim_package_exhausted
  PRIMARY KEY (server_name, imei)
);
CREATE INDEX IF NOT EXISTS idx_sim_exhaustion_nick ON sim_exhaustion_state(server_name, nick);
