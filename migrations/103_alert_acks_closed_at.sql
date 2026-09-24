-- 2026-09-24 · DEEP-74 (FIX-SPEC §39): «решено» — до конца ЭПИЗОДА, не навсегда.
-- closed_at фиксирует завершение эпизода при достоверном recovery (clearCooldown);
-- активные ack/solved выбираются только с closed_at IS NULL. История
-- подтверждений сохраняется (строки не удаляются), новая авария того же
-- объекта — новый эпизод с новым подавлением.
ALTER TABLE alert_acks ADD COLUMN closed_at TEXT DEFAULT NULL;
