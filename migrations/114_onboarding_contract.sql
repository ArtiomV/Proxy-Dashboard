-- 2026-10-15: номер и дата договора юрлица из ЛК (генерация по шаблону).
ALTER TABLE client_onboarding ADD COLUMN contract_number TEXT;
ALTER TABLE client_onboarding ADD COLUMN contract_date TEXT;
