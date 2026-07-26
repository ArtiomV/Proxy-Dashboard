-- 050: rotation_log — кто инициировал ротацию и режим сети (WP3).
-- get_rotation_log отдаёт CALLER (schedule/link/api/portID) и target_mode
-- (4g/auto/…). Раньше синк их отбрасывал — карточка не могла показать,
-- почему сменился IP и кто это запустил. Колонки nullable, бэкфилл идёт
-- сам при следующем просмотре (get_rotation_log возвращает всю историю,
-- а upsert теперь обновляет существующие строки).

ALTER TABLE rotation_log ADD COLUMN caller TEXT;
ALTER TABLE rotation_log ADD COLUMN target_mode TEXT;
