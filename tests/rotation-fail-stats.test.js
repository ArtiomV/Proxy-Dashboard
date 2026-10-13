// 2026-09-26: getRotStats7d — доля неуспешных ротаций по модемам за 7 дней
// для колонки «Ротации %» на странице модемов. «Неуспешная» — новый IP не
// получен или совпал со старым; ротации без единого известного IP не считаются. Результат кэшируется на 5 минут (rotation_log
// ~175k строк/7д, индекса по started_at нет).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const opsExt = require('../src/routes/ops-ext.js');

function mkDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rotation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL, nick TEXT NOT NULL,
    old_ip TEXT, new_ip TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, took_sec REAL
  )`);
  return db;
}

// Формат ProxySmart, как в проде: 'YYYY-MM-DD@hh:mm:ss'.
const ts = (hAgo) => new Date(Date.now() - hAgo * 3600e3).toISOString().slice(0, 19).replace('T', '@');

describe('getRotStats7d — статистика неуспешных ротаций за 7 дней', () => {
  it('считает total/failed/pct по server_nick; старые и пустые записи не считаются фейлами', () => {
    const db = mkDb();
    opsExt._resetRotStatsCache();
    const ins = db.prepare('INSERT INTO rotation_log (server_name,nick,old_ip,new_ip,started_at,ended_at) VALUES (?,?,?,?,?,?)');
    // S1_A: 4 ротации за окно, 2 без смены IP → 50%
    ins.run('S1', 'A', '1.1.1.1', '2.2.2.2', ts(1), ts(1));
    ins.run('S1', 'A', '2.2.2.2', '3.3.3.3', ts(2), ts(2));
    ins.run('S1', 'A', '3.3.3.3', '3.3.3.3', ts(3), ts(3));
    ins.run('S1', 'A', '4.4.4.4', '4.4.4.4', ts(4), ts(4));
    // старше 7 дней — вне окна, не должна попасть ни в total, ни в failed
    ins.run('S1', 'A', '9.9.9.9', '9.9.9.9', ts(24 * 8), ts(24 * 8));
    // S1_B: оба IP пустые — модем был без сети, это не ротация (2026-10-13:
    // общий критерий src/modems/stat-scope.js) — в статистику не идёт.
    ins.run('S1', 'B', '', '', ts(1), ts(1));
    // S1_C: IP потерян (новый пустой) — неуспешная.
    ins.run('S1', 'C', '5.5.5.5', '', ts(1), ts(1));
    ins.run('S1', 'C', '', '6.6.6.6', ts(2), ts(2));

    const out = opsExt._getRotStats7d(db);
    expect(out['S1_A']).toEqual({ total: 4, failed: 2, pct: 50 });
    expect(out['S1_B']).toBeUndefined();
    expect(out['S1_C']).toEqual({ total: 2, failed: 1, pct: 50 });
  });

  it('кэширует результат на 5 минут; _resetRotStatsCache сбрасывает', () => {
    const db = mkDb();
    opsExt._resetRotStatsCache();
    const ins = db.prepare('INSERT INTO rotation_log (server_name,nick,old_ip,new_ip,started_at,ended_at) VALUES (?,?,?,?,?,?)');
    ins.run('S1', 'A', '1.1.1.1', '2.2.2.2', ts(1), ts(1));
    const first = opsExt._getRotStats7d(db);
    expect(first['S1_A'].total).toBe(1);

    ins.run('S1', 'A', '2.2.2.2', '2.2.2.2', ts(2), ts(2));
    const cached = opsExt._getRotStats7d(db);
    expect(cached['S1_A'].total).toBe(1);   // кэш — вставка не видна

    opsExt._resetRotStatsCache();
    const fresh = opsExt._getRotStats7d(db);
    expect(fresh['S1_A']).toEqual({ total: 2, failed: 1, pct: 50 });
  });
});

// 2026-10-02: getRotStats7dCached — только чтение кэша, без рекомпьютa в
// request-path (синхронный GROUP BY 175k строк останавливал event loop на
// 1–3с → pending у клиентов портала; рекомпьют теперь в фоновом тике server.js).
describe('getRotStats7dCached — request-path без рекомпьютa', () => {
  it('при холодном кэше возвращает {} и НЕ дёргает БД', () => {
    opsExt._resetRotStatsCache();
    let dbTouched = false;
    const db = { prepare: () => { dbTouched = true; throw new Error('must not query'); } };
    const out = opsExt._getRotStats7dCached();
    expect(out).toEqual({});
    expect(dbTouched).toBe(false);
    void db;
  });

  it('после фонового рекомпьютa отдаёт те же данные', () => {
    const db = mkDb();
    opsExt._resetRotStatsCache();
    db.prepare('INSERT INTO rotation_log (server_name,nick,old_ip,new_ip,started_at,ended_at) VALUES (?,?,?,?,?,?)')
      .run('S1', 'A', '1.1.1.1', '1.1.1.1', ts(1), ts(1));
    opsExt._getRotStats7d(db);   // фоновый тик
    expect(opsExt._getRotStats7dCached()['S1_A']).toEqual({ total: 1, failed: 1, pct: 100 });
  });
});
