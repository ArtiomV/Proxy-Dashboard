-- 064: WP6 (Этап 7, фаза 2) — промокоды розницы.
--
-- type: percent (+% бонусом к пополнению) | fixed (+N ₽ бонусом к пополнению)
--       | bonus_days (+N дней при покупке — зачисляется эквивалентом на
--       баланс: tariff.price/30.4 × N, деньги остаются единой моделью).
-- max_uses NULL = без лимита; used инкрементится атомарно (consume).
-- card_payments.promo_code — какой код применён к платежу (для аудита).

CREATE TABLE IF NOT EXISTS promo_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type       TEXT NOT NULL CHECK (type IN ('percent','fixed','bonus_days')),
  value      REAL NOT NULL,
  max_uses   INTEGER,                       -- NULL = без лимита
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,                          -- NULL = бессрочный
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE card_payments ADD COLUMN promo_code TEXT;
