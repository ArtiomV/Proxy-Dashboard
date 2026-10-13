// 2026-10-13: синк журнала ротаций каждые 30 минут получает от панели ВСЮ
// историю модема. Upsert без условия переписывал каждую строку (~143k UPDATE
// за прогон → лаги event loop 4–5 с). Upsert обязан писать только новые или
// изменившиеся строки; водяной знак — последняя сохранённая ротация модема.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const require = createRequire(import.meta.url);
const trackingDb = require('../src/db/tracking');

describe('rotation_log upsert: пишет только новое и изменившееся', () => {
  let db;
  beforeAll(() => { db = bootApp().db; });
  afterEach(() => { db.prepare("DELETE FROM rotation_log WHERE server_name = 'TRL'").run(); });

  const up = (...a) => trackingDb.rotationUpsertStmt().run('TRL', 'MD_T', ...a).changes;

  it('повтор неизменной строки — 0 записей; изменение — 1', () => {
    expect(up('1.1.1.1', '2.2.2.2', '2026-10-13@10:00:00', '2026-10-13@10:00:20', 20, 1, 'api', null)).toBe(1);
    expect(up('1.1.1.1', '2.2.2.2', '2026-10-13@10:00:00', '2026-10-13@10:00:20', 20, 1, 'api', null)).toBe(0);
    // caller=null в повторе не затирает и не считается изменением
    expect(up('1.1.1.1', '2.2.2.2', '2026-10-13@10:00:00', '2026-10-13@10:00:20', 20, 1, null, null)).toBe(0);
    expect(up('1.1.1.1', '3.3.3.3', '2026-10-13@10:00:00', '2026-10-13@10:00:25', 25, 1, null, null)).toBe(1);
    const row = db.prepare("SELECT * FROM rotation_log WHERE server_name='TRL'").get();
    expect(row.new_ip).toBe('3.3.3.3');
    expect(row.caller).toBe('api');
  });

  it('незавершённая ротация дописывается, когда панель отдаёт конец', () => {
    expect(up('1.1.1.1', '', '2026-10-13@11:00:00', '', 0, 1, null, null)).toBe(1);
    expect(up('1.1.1.1', '4.4.4.4', '2026-10-13@11:00:00', '2026-10-13@11:00:30', 30, 1, null, null)).toBe(1);
  });

  it('водяной знак — последняя started_at модема', () => {
    up('a', 'b', '2026-10-12@09:00:00', 'x', 1, 1, null, null);
    up('a', 'b', '2026-10-13@09:00:00', 'x', 1, 1, null, null);
    expect(trackingDb.rotationLastStartedStmt().get('TRL', 'MD_T').last).toBe('2026-10-13@09:00:00');
    expect(trackingDb.rotationLastStartedStmt().get('TRL', 'nope').last).toBe(null);
  });
});
