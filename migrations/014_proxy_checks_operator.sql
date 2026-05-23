-- Add operator column to proxy_checks for analytics filtering
ALTER TABLE proxy_checks ADD COLUMN operator TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_pc_operator ON proxy_checks(operator);
