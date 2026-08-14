-- v2.10.8: валюта затрат (MDL/RON с конвертацией в RUB по курсу ЦБ) и
-- кол-во SIM. amount — ИТОГО в указанной валюте (UI считает qty × цену сам);
-- qty — число SIM-карт (category='sim'), для прочих категорий NULL.
-- Старые строки читаются как RUB (DEFAULT 'RUB').
ALTER TABLE monthly_costs ADD COLUMN currency TEXT NOT NULL DEFAULT 'RUB';
ALTER TABLE monthly_costs ADD COLUMN qty REAL;
