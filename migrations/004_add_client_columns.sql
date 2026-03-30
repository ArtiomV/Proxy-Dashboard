ALTER TABLE clients ADD COLUMN client_type TEXT DEFAULT 'legal';
ALTER TABLE clients ADD COLUMN billing_paused INTEGER DEFAULT 0;
