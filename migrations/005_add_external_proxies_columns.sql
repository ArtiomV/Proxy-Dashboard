ALTER TABLE external_proxies ADD COLUMN change_ip_url TEXT DEFAULT '';
ALTER TABLE external_proxies ADD COLUMN valid_until TEXT;
ALTER TABLE external_proxies ADD COLUMN billing_type TEXT DEFAULT 'monthly';
ALTER TABLE external_proxies ADD COLUMN price REAL DEFAULT 0;
ALTER TABLE external_proxies ADD COLUMN traffic_used_gb REAL DEFAULT 0;
