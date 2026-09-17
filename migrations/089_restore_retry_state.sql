-- Fixed targets for debt restoration retries. They survive process restarts so
-- a failed daily attempt cannot keep extending a client's service window.
ALTER TABLE retail_pool ADD COLUMN restore_until TEXT;
ALTER TABLE clients ADD COLUMN debt_restore_until TEXT;
