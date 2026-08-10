-- B2 (Р15/Р23): сквозная нумерация закрывающих документов «№ N/YYYY».
-- Единый счётчик для актов и счетов вместе (одна серия на систему внутри года):
-- номер выдаётся атомарно (UPDATE ... RETURNING в транзакции создания документа),
-- дыры от удалённых документов НЕ переиспользуются. Счётчик стартует с 1 для
-- каждого нового года (новая строка year). Документы старого формата
-- (АКТ-YYYYMM-<id4>) не перенумеровываются.
CREATE TABLE IF NOT EXISTS doc_numbering (
  year     INTEGER PRIMARY KEY,
  next_num INTEGER NOT NULL DEFAULT 1
);

-- B2: анти-дабл гейт на уровне БД — один акт на (клиент, период, тип) и один
-- счёт на (клиент, период). In-memory проверки в роутах/кроне остаются как
-- fast-path, истина — эти индексы. Дубликаты (гонка крон+ручная генерация)
-- схлопываются до самой свежей строки.
DELETE FROM closing_documents
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM closing_documents GROUP BY client_id, period, type
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_closing_docs_unique_period
  ON closing_documents(client_id, period, type);

DELETE FROM bills
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM bills GROUP BY client_id, period
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_unique_period
  ON bills(client_id, period);

-- B3 (Р13): факт автоматической блокировки физика по долгу. Нужна персистентность,
-- чтобы после рестарта восстановление (оплата → продление «дата до») знало,
-- что порт был погашен именно автоблоком, а не ручным override.
ALTER TABLE clients ADD COLUMN debt_blocked INTEGER DEFAULT 0;

-- NB: db_audit-триггер на clients.price (B1) — отдельной миграцией 057:
-- тело CREATE TRIGGER содержит точку с запятой и не переживает per-statement
-- фолбэк раннера, а здесь ALTER на свежей БД (schema.sql уже содержит колонку)
-- гарантированно отправляет файл в этот фолбэк (benign duplicate column).

