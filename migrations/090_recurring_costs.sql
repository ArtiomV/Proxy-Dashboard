-- Плановые (повторяющиеся) расходы. Раньше «повторением» служил неявный
-- шаблон — строки последнего заполненного месяца в monthly_costs. Теперь
-- повторение задаётся явным правилом с диапазоном действия, а monthly_costs
-- хранит только разовые суммы и override на конкретный месяц.
--   start_period — YYYY-MM, действует с этого месяца включительно;
--   end_period   — YYYY-MM последнего месяца действия включительно,
--                  NULL = бессрочно.
CREATE TABLE IF NOT EXISTS recurring_costs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL,
  subkey       TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'RUB',
  qty          REAL,
  notes        TEXT,
  start_period TEXT NOT NULL,
  end_period   TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rc_range ON recurring_costs(start_period, end_period);

-- Бэкфилл: один раз переносим последний заполненный месяц monthly_costs в
-- бессрочные правила (старое поведение «шаблона» не теряется при переезде).
-- Срабатывает только когда recurring_costs пуста и monthly_costs не пуста.
-- Маркер в notes делает происхождение правила видимым в UI.
INSERT INTO recurring_costs (category, subkey, amount, currency, qty, notes, start_period, end_period)
SELECT category, subkey, amount, currency, qty,
       COALESCE(notes || ' · ', '') || '[миграция: проверьте]',
       (SELECT MAX(period) FROM monthly_costs), NULL
  FROM monthly_costs
 WHERE period = (SELECT MAX(period) FROM monthly_costs)
   AND (SELECT COUNT(*) FROM recurring_costs) = 0
   AND (SELECT MAX(period) FROM monthly_costs) IS NOT NULL;
