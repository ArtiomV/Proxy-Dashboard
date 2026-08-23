-- Product decision 2026-08-23: sample ProxySmart Ping Destination once/minute.
-- Override an explicitly persisted legacy value (usually 3) on existing installs;
-- fresh installs receive the new default from SETTINGS_DEFAULTS.
UPDATE kv_store
SET value = json_set(value, '$.tracking_interval_min', 1),
    updated_at = datetime('now')
WHERE key = 'app_settings';
