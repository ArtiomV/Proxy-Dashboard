// 2026-10-13: модем без клиента — «мёртвый» (часто без сети), его пинги,
// HTTP-чеки и ротации не должны входить в сводную статистику. Общий фильтр
// и единые критерии ротации — src/modems/stat-scope.js.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const statScope = require('../src/modems/stat-scope');

const ROSTER = {
  S3: {
    p1: { portName: 'clientA', nick: 'MD_49', imei: '111' },
    p2: { portName: 'random_pool', nick: 'MD_82', imei: '222' },   // random — не клиент
    p3: { portName: '', nick: 'MD_83', imei: '333' },              // без имени — не клиент
  },
  RO1: { p9: { portName: 'clientB', nick: 'RO1_11', imei: '999' } },
};

describe('stat-scope', () => {
  it('boundModemKeys: только порты с клиентом, по нику и по IMEI', () => {
    const keys = statScope.boundModemKeys(ROSTER);
    expect([...keys].sort()).toEqual(['RO1|999', 'RO1|RO1_11', 'S3|111', 'S3|MD_49']);
    expect(statScope.modemHasClient('S3', 'MD_49', ROSTER)).toBe(true);
    expect(statScope.modemHasClient('S3', 'MD_82', ROSTER)).toBe(false);
  });

  it('пустой ростер — fail-open (фильтра нет)', () => {
    expect(statScope.boundClause('server_name', 'nick', {})).toEqual({ clause: '', params: [] });
  });

  it('SQL: свободные модемы и ротации без IP исключены, потеря IP — неуспех', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE rotation_log (server_name TEXT, nick TEXT, old_ip TEXT, new_ip TEXT, started_at TEXT)`);
    const ins = db.prepare('INSERT INTO rotation_log VALUES (?,?,?,?,?)');
    ins.run('S3', 'MD_49', '1.1.1.1', '2.2.2.2', 't');   // успех
    ins.run('S3', 'MD_49', '2.2.2.2', '2.2.2.2', 't');   // IP не сменился
    ins.run('S3', 'MD_49', '2.2.2.2', '', 't');          // IP потерян
    ins.run('S3', 'MD_49', '', '', 't');                 // без сети — не считается
    ins.run('S3', 'MD_49', null, null, 't');             // без сети — не считается
    ins.run('S3', 'MD_82', '', '', 't');                 // свободный модем
    ins.run('S3', 'MD_82', '3.3.3.3', '3.3.3.3', 't');   // свободный модем
    ins.run('RO1', '999', '4.4.4.4', '5.5.5.5', 't');    // старая запись под IMEI
    const sc = statScope.boundClause('server_name', 'nick', ROSTER);
    const row = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN ${statScope.rotFailedSql()} THEN 1 ELSE 0 END) AS failed
      FROM rotation_log WHERE ${statScope.rotCountedSql()}${sc.clause}
    `).get(...sc.params);
    expect(row).toEqual({ total: 4, failed: 2 });
  });
});
