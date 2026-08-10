-- B1 (Р14): журнал смены цены на уровне БД — покрывает ЛЮБОЕ изменение
-- clients.price (db_audit-триггер, по образцу trg_clients_balance_au из 022).
-- Ручная смена через PUT /api/admin/clients/:id дополнительно пишет в audit_log
-- (кто/когда/старая/новая) — триггер видит только факт изменения.
-- Отдельным файлом от 056: тело триггера содержит ';' и не переживает
-- per-statement фолбэк раннера миграций.
DROP TRIGGER IF EXISTS trg_clients_price_au;
CREATE TRIGGER trg_clients_price_au AFTER UPDATE OF price ON clients
WHEN COALESCE(OLD.price, 0) != COALESCE(NEW.price, 0)
BEGIN
  INSERT INTO db_audit (table_name, operation, row_id, old_values, new_values, context_id)
  VALUES ('clients.price', 'UPDATE', NEW.id,
    json_object('price', OLD.price),
    json_object('price', NEW.price, 'name', NEW.name),
    (SELECT context_id FROM _audit_active_context WHERE id = 1));
END;
