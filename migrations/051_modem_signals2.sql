-- 051: ещё сигналы modem_meta (WP4) — ProxySmart отдаёт их в show_status_json,
-- но мы не персистили: сила сигнала, ICCID (детект замены SIM), «сырой»
-- оператор CELLOP, тип сети (LTE/…), аптайм модема. Хранятся на modem_meta,
-- чтобы офлайн-модем держал последние значения. Продолжение миграции 039.
-- NB: без точек с запятой в комментариях — раннер наивно сплитит файл.

ALTER TABLE modem_meta ADD COLUMN signal_strength TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN iccid TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN cell_op TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN net_type TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN modem_uptime TEXT DEFAULT '';
