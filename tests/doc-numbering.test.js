// B2 (Р15/Р23) + 2026-08-17: поклиентская сквозная нумерация «№ NN/MM-YYYY» —
// NN из атомарного счётчика doc_numbering_client (непрерывный с начала работы
// с клиентом, единый для актов и счетов), MM-YYYY — месяц ПЕРИОДА документа.
// Без clientId — фолбэк на помесячную системную серию doc_numbering_monthly.
// + анти-дабл гейты UNIQUE(client_id, period[, type]).
//
// Контракт:
//   - номер относится к месяцу периода: акт за 2026-07, выставленный в
//     августе, получает «N/07-2026» из июльской серии;
//   - без period (или с кривым) — серия текущего месяца;
//   - номера последовательны и не переиспользуются (дыры от удалений — норма);
//   - две «конкурентные» вставки акта/счёта на один (клиент, период) → одна строка;
//   - insertBill с чужим периодом-дубликатом молча отклоняется (не роняет
//     транзакцию saveClients).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { bootApp } = require('./_helpers/app.js');
const documentsDb = require('../src/db/documents.js');

let db;
const clientId = 'test_docnum_' + crypto.randomBytes(4).toString('hex');

beforeAll(() => {
  ({ db } = bootApp());
  db.prepare(`INSERT INTO clients (id, login, name, port_name) VALUES (?, ?, ?, ?)`)
    .run(clientId, clientId, 'DocNum Test', 'docnumport');
});

afterAll(() => {
  try { db.prepare('DELETE FROM closing_documents WHERE client_id = ?').run(clientId); } catch (_) { /* cleanup best-effort */ }
  try { db.prepare('DELETE FROM bills WHERE client_id = ?').run(clientId); } catch (_) { /* cleanup best-effort */ }
  try { db.prepare('DELETE FROM clients WHERE id = ?').run(clientId); } catch (_) { /* cleanup best-effort */ }
  try { db.prepare("DELETE FROM doc_numbering_monthly WHERE ym LIKE '2099-%'").run(); } catch (_) { /* cleanup best-effort */ }
  try { db.prepare("DELETE FROM doc_numbering_client WHERE client_id LIKE 'docnum_seq_%'").run(); } catch (_) { /* cleanup best-effort */ }
});

describe('doc_numbering_client — поклиентский счётчик «№ NN/MM-YYYY»', () => {
  const cidA = 'docnum_seq_A_' + crypto.randomBytes(3).toString('hex');
  const cidB = 'docnum_seq_B_' + crypto.randomBytes(3).toString('hex');

  it('NN — сквозной номер клиента (не сбрасывается по месяцам), суффикс — месяц периода', () => {
    const a = documentsDb.nextDocNumber(new Date('2026-08-17T10:00:00Z'), '2099-07', cidA);
    expect(a.label).toBe('01/07-2099');      // первый документ клиента, период июль 2099
    const b = documentsDb.nextDocNumber(null, '2099-08', cidA);
    expect(b.label).toBe('02/08-2099');      // второй документ клиента, период август
  });

  it('серия независима между клиентами', () => {
    const a = documentsDb.nextDocNumber(null, '2099-08', cidB);
    expect(a.label).toBe('01/08-2099');      // у другого клиента — свой счётчик с 01
  });

  it('без clientId — фолбэк на помесячную системную серию', () => {
    const sys = documentsDb.nextDocNumber(null, '2099-10');
    expect(sys.label).toMatch(/^\d{2}\/10-2099$/);
  });

  it('без period — текущий месяц; кривой period — тоже текущий месяц', () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const cur = documentsDb.nextDocNumber(null, null, cidA);
    expect(cur.label).toBe(`${String(cur.num).padStart(2, '0')}/${mm}-${d.getFullYear()}`);
    const bad = documentsDb.nextDocNumber(null, 'not-a-period', cidA);
    expect(bad.label).toBe(`${String(bad.num).padStart(2, '0')}/${mm}-${d.getFullYear()}`);
  });

  it('счётчик монотонен: «удаление» документа не освобождает номер (дыра не переиспользуется)', () => {
    const before = documentsDb.nextDocNumber(null, '2099-09', cidA);
    // Имитация удаления документа с этим номером: счётчик не откатывается.
    const after = documentsDb.nextDocNumber(null, '2099-09', cidA);
    expect(after.num).toBe(before.num + 1);
  });
});

describe('анти-дабл гейты (UNIQUE client_id+period)', () => {
  it('две конкурентные вставки акта на один период → одна строка в БД', () => {
    const d1 = { id: crypto.randomBytes(8).toString('hex'), period: '2026-07', type: 'act', actNumber: '10/2026', totalAmount: 100 };
    const d2 = { id: crypto.randomBytes(8).toString('hex'), period: '2026-07', type: 'act', actNumber: '11/2026', totalAmount: 200 };
    documentsDb.insertClosing(d1, clientId);
    documentsDb.insertClosing(d2, clientId);   // INSERT OR IGNORE → конфликт UNIQUE глотает дубль
    const rows = documentsDb.listClosing(clientId).filter(r => r.period === '2026-07');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(d1.id);            // побеждает первая вставка
  });

  it('разные типы документов на один период не конфликтуют (act vs report)', () => {
    const d3 = { id: crypto.randomBytes(8).toString('hex'), period: '2026-07', type: 'report', actNumber: '12/2026', totalAmount: 50 };
    documentsDb.insertClosing(d3, clientId);
    const rows = documentsDb.listClosing(clientId).filter(r => r.period === '2026-07');
    expect(rows.length).toBe(2);
  });

  it('второй счёт на тот же период отклоняется гейтом insertBill (без исключения)', () => {
    const b1 = { id: crypto.randomBytes(8).toString('hex'), period: '2026-08', billNumber: '13/2026', amount: 500, status: 'unpaid' };
    const b2 = { id: crypto.randomBytes(8).toString('hex'), period: '2026-08', billNumber: '14/2026', amount: 700, status: 'unpaid' };
    documentsDb.insertBill(b1, clientId);
    const res = documentsDb.insertBill(b2, clientId);
    expect(res.changes).toBe(0);
    const rows = documentsDb.listBills(clientId).filter(r => r.period === '2026-08');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(b1.id);
  });

  it('re-issue того же bill.id — не дубль (upsert статуса работает)', () => {
    const b = db.prepare('SELECT * FROM bills WHERE client_id = ? AND period = ?').get(clientId, '2026-08');
    const res = documentsDb.insertBill({ id: b.id, period: '2026-08', billNumber: b.bill_number, amount: 500, status: 'paid' }, clientId);
    expect(res.changes).toBe(1);
    expect(db.prepare('SELECT status FROM bills WHERE id = ?').get(b.id).status).toBe('paid');
  });
});
