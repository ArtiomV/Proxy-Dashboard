-- 085 — пояснение часового baseline скорости модема

ALTER TABLE modem_speed_baseline_state ADD COLUMN baseline_hour INTEGER;
ALTER TABLE modem_speed_baseline_state ADD COLUMN day_type TEXT NOT NULL DEFAULT '';
ALTER TABLE modem_speed_baseline_state ADD COLUMN baseline_window_days INTEGER NOT NULL DEFAULT 56;
