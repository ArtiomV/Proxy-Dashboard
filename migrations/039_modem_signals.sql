-- 039_modem_signals.sql
-- ProxySmart already returns these per-modem fields in show_status_json but we
-- never persisted them: SIM status, reboot-need score, operator HTTP-redirect
-- (captive portal == SIM out of money / blocked), current LTE band, and the
-- modem-locked flag. Stored on modem_meta so offline modems keep last-known
-- values and the health / alert / failover jobs can read them.
ALTER TABLE modem_meta ADD COLUMN sim_status TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN reboot_score INTEGER DEFAULT NULL;
ALTER TABLE modem_meta ADD COLUMN http_redirect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE modem_meta ADD COLUMN band TEXT DEFAULT '';
ALTER TABLE modem_meta ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE modem_meta ADD COLUMN signals_updated_at TEXT DEFAULT '';
