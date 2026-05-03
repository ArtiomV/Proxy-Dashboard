-- Negative-balance protection: admin can mark specific clients as allowed to go
-- into debt, and optionally set a hard floor. max_debt is stored as a positive
-- number (balance guard uses -max_debt as minBalance).
ALTER TABLE clients ADD COLUMN allow_debt INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN max_debt REAL;
