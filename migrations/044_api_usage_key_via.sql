-- 044: track HOW the API key was presented on /api/v1 requests ('header' vs
-- deprecated 'query'). Feeds the sunset decision for ?apiKey= (WP7.3): when
-- key_via='query' rows go to zero, the fallback can be removed safely.

ALTER TABLE api_usage ADD COLUMN key_via TEXT;

-- Existing rows used the header unless proven otherwise (query logging did
-- not exist), and 'header' keeps the NOT NULL-ish analytics simple.
UPDATE api_usage SET key_via = 'header' WHERE key_via IS NULL;
