-- 036_client_contract_date.sql
-- #4 «Дата взаиморасчётов»: contract signing date per client. The settlement
-- day-of-month (when monthly acts/bills are issued for that client) is derived
-- from it. Empty → settlement day 1 (existing behaviour, billed on the 1st).
ALTER TABLE clients ADD COLUMN contract_date TEXT DEFAULT '';
