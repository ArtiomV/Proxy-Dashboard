-- 2026-09-24 · DEEP-69 (FIX-SPEC §36): пересечение простоя с окнами обслуживания.
-- maintenance_sec — секунды эпизода, покрытые окнами (объединение пересечений);
-- maintenance_windows — id применённых окон (версия расчёта, JSON).
-- Флаг maintenance=1 остаётся для обратной совместимости: выставляется только
-- когда интервал покрыт окнами ПОЛНОСТЬЮ (раньше — по моменту восстановления).
ALTER TABLE server_downtime ADD COLUMN maintenance_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_downtime ADD COLUMN maintenance_windows TEXT NOT NULL DEFAULT '';
