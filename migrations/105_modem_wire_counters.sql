-- 2026-09-27: проводные счётчики модемов — «ground truth» трафика с боксов.
-- Замерено на проде: per-port счётчики ProxySmart (/apix/bandwidth_report_all)
-- на задушенных/перегруженных модемах завышены в 24–48 раз (счётчик порта
-- считает принятые от клиента байты = спрос, а не прошедший через модем
-- трафик). Проводная правда — /proc/net/dev на боксе, интерфейсы modemNNNN
-- (привязка ник→iface: show_status_json → net_details.DEV).
-- server-metrics джоб ходит на боксы по SSH каждые ~10 мин и пишет сюда
-- семплы (rx_bytes — колонка 2, tx_bytes — колонка 10 /proc/net/dev).
-- src/traffic/hourly.js масштабирует заявленные портами дельты к проводной
-- дельте (uncertain=6), когда расхождение > 30%.
-- Ретенция 10 дней — прун при каждом прогоне server-metrics.
CREATE TABLE IF NOT EXISTS modem_wire_counters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_name TEXT NOT NULL,
  iface       TEXT NOT NULL,
  rx_bytes    INTEGER NOT NULL DEFAULT 0,
  tx_bytes    INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_modem_wire_counters_srv_iface_ts
  ON modem_wire_counters(server_name, iface, ts);
