-- Track when each port snapshot was last updated, so we can split delta across
-- missed hours if the ProxySmart server was offline (avoid fake spike on heatmap).
ALTER TABLE hourly_snapshots ADD COLUMN last_updated_at TEXT;
