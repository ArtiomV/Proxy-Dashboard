import {describe,it,expect,vi,afterEach} from 'vitest';
import Database from 'better-sqlite3';

const incidents=require('../src/telegram/incidents.js');

function harness(){
  const db=new Database(':memory:');
  db.exec(`
    CREATE TABLE monitoring_incidents(id TEXT PRIMARY KEY,correlation_key TEXT,server TEXT,operator TEXT,hypothesis TEXT,state TEXT,opened_at TEXT,last_seen_at TEXT,closed_at TEXT,duration_sec INTEGER,modem_count INTEGER,client_count INTEGER,members_json TEXT,reasons_json TEXT);
    CREATE TABLE modem_meta(server_name TEXT,imei TEXT,nick TEXT,operator TEXT,updated_at TEXT);
    CREATE TABLE known_modems(server_name TEXT,port_key TEXT,data TEXT);
  `);
  const emitted=[];
  const manager=incidents.create({db,logger:{warn:()=>{}},getSetting:(k,d)=>d,emit:(rule,payload)=>emitted.push({rule,payload})});
  return {db,emitted,manager};
}

afterEach(()=>{vi.useRealTimers();});

describe('incident correlation',()=>{
  it('groups three modems of one operator/server into one incident and auto-closes',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h=harness();
    for(let i=1;i<=3;i++)h.manager.handle('modem_ping_dead',{server:'S1',nick:'MD_'+i,imei:'i'+i,operator:'Orange',clients:['c'+i]});
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].rule).toBe('fleet_incident_opened');
    expect(h.emitted[0].payload.modems).toBe(3);
    expect(h.emitted[0].payload.clients).toBe(3);
    expect(h.db.prepare("SELECT state,modem_count,client_count FROM monitoring_incidents").get()).toMatchObject({state:'open',modem_count:3,client_count:3});

    h.manager.handle('modem_ping_recovered',{server:'S1',nick:'MD_1',imei:'i1'});
    h.manager.handle('modem_ping_recovered',{server:'S1',nick:'MD_2',imei:'i2'});
    expect(h.emitted).toHaveLength(1);
    vi.advanceTimersByTime(23*60*1000);
    h.manager.handle('modem_ping_recovered',{server:'S1',nick:'MD_3',imei:'i3'});
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].rule).toBe('fleet_incident_closed');
    expect(h.emitted[1].payload.duration_sec).toBe(23*60);
    expect(h.db.prepare("SELECT state FROM monitoring_incidents").get().state).toBe('closed');
    h.manager.shutdown();h.db.close();
  });

  it('cancels a short individual flap without sending open/recovery noise',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h=harness();
    h.manager.handle('modem_http_fail',{server:'S2',nick:'RO_1',imei:'r1',operator:'Vodafone'});
    vi.advanceTimersByTime(2*60*1000);
    h.manager.handle('modem_http_recovered',{server:'S2',nick:'RO_1',imei:'r1'});
    vi.advanceTimersByTime(5*60*1000);
    expect(h.emitted).toHaveLength(0);
    h.manager.shutdown();h.db.close();
  });

  it('falls back to individual alerts when the group threshold is not reached',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h=harness();
    h.manager.handle('modem_ping_dead',{server:'S3',nick:'M1',imei:'a',operator:'Moldcell'});
    h.manager.handle('modem_ping_dead',{server:'S3',nick:'M2',imei:'b',operator:'Moldcell'});
    vi.advanceTimersByTime(5*60*1000);
    expect(h.emitted.map(x=>x.rule)).toEqual(['modem_ping_dead','modem_ping_dead']);
    h.manager.shutdown();h.db.close();
  });

  it('does not close a member until all of its active symptoms recovered',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h=harness();
    for(let i=1;i<=3;i++)h.manager.handle('modem_ping_dead',{server:'S4',nick:'M'+i,imei:'x'+i,operator:'Orange'});
    h.manager.handle('modem_http_fail',{server:'S4',nick:'M1',imei:'x1',operator:'Orange'});
    h.manager.handle('modem_ping_recovered',{server:'S4',nick:'M1',imei:'x1'});
    h.manager.handle('modem_ping_recovered',{server:'S4',nick:'M2',imei:'x2'});
    h.manager.handle('modem_ping_recovered',{server:'S4',nick:'M3',imei:'x3'});
    expect(h.emitted.map(x=>x.rule)).toEqual(['fleet_incident_opened']);
    expect(h.db.prepare("SELECT state FROM monitoring_incidents").get().state).toBe('open');
    h.manager.handle('modem_http_recovered',{server:'S4',nick:'M1',imei:'x1'});
    expect(h.emitted.map(x=>x.rule)).toEqual(['fleet_incident_opened','fleet_incident_closed']);
    h.manager.shutdown();h.db.close();
  });
});

// 2026-09-24 · DEEP-75/76/78/79: согласование, persistence-ошибки, точная
// атрибуция по IMEI, смена группы.
describe('incidents — DEEP-75/76/78/79', () => {
  it('DEEP-75: «рестарт» + модем уже здоров → reconcile закрывает сохранённый инцидент', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h = harness();
    for (let i = 1; i <= 3; i++) h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'MD_' + i, imei: 'i' + i, operator: 'Orange' });
    expect(h.emitted[0].rule).toBe('fleet_incident_opened');
    h.manager.shutdown();
    // «Рестарт»: новый менеджер над той же БД; модемы восстановились, пока
    // процесс лежал — recovery-переходов не будет, согласование обязано закрыть.
    const h2 = harness();
    h2.db.exec('ATTACH \':memory:\' AS x');   // no-op, отдельная БД не нужна — используем h.db
    const mgr2 = incidents.create({ db: h.db, logger: { warn: () => {} }, getSetting: (k, d) => d, emit: (r, p) => h2.emitted.push({ rule: r, payload: p }) });
    expect(mgr2._open.size).toBe(1);   // инцидент загружен из SQLite
    mgr2.reconcile([{ server: 'S1', imei: 'i1', online: true }, { server: 'S1', imei: 'i2', online: true }, { server: 'S1', imei: 'i3', online: true }]);
    expect(mgr2._open.size).toBe(0);
    expect(h2.emitted.some(e => e.rule === 'fleet_incident_closed')).toBe(true);
    expect(h.db.prepare('SELECT state FROM monitoring_incidents').get().state).toBe('closed');
    mgr2.shutdown(); h.db.close();
  });

  it('DEEP-76: ошибка SQLite при закрытии → инцидент НЕ закрыт (ни Map, ни emit)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h = harness();
    for (let i = 1; i <= 3; i++) h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'MD_' + i, imei: 'i' + i, operator: 'Orange' });
    h.db.exec('DROP TABLE monitoring_incidents');   // persistence сломан
    for (let i = 1; i <= 3; i++) h.manager.handle('modem_ping_recovered', { server: 'S1', nick: 'MD_' + i, imei: 'i' + i });
    expect(h.emitted.filter(e => e.rule === 'fleet_incident_closed').length).toBe(0);
    expect(h.manager._open.size).toBe(1);   // эпизод не потерян — повтор при следующем событии
    h.manager.shutdown(); h.db.close();
  });

  it('DEEP-78: совпадение nick у двух IMEI — оператор берётся по ТОЧНОМУ imei', () => {
    const h = harness();
    h.db.prepare("INSERT INTO modem_meta VALUES ('S1','imei_OLD','same-nick','Orange','2026-08-01')").run();
    h.db.prepare("INSERT INTO modem_meta VALUES ('S1','imei_NEW','same-nick','Vodafone','2026-08-25')").run();
    h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'same-nick', imei: 'imei_OLD' });
    const c = h.manager._pending.get('S1|imei_OLD');
    expect(c.member.operator).toBe('Orange');
    h.manager.shutdown(); h.db.close();
  });

  it('DEEP-79: смена группы — участник деактивирован в прежнем инциденте; recovery закрывает оба', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-26T06:00:00Z'));
    const h = harness();
    for (const n of ['i1', 'i2', 'i3']) h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'M_' + n, imei: n, operator: 'A' });
    expect(h.emitted.filter(e => e.rule === 'fleet_incident_opened').length).toBe(1);
    // Оператор i1 «уточнился» → новая группа B с двумя другими модемами.
    h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'X_1', imei: 'x1', operator: 'B' });
    h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'M_i1', imei: 'i1', operator: 'B' });
    expect(h.manager._open.size).toBe(1);   // B ещё не набрала threshold
    h.manager.handle('modem_ping_dead', { server: 'S1', nick: 'X_2', imei: 'x2', operator: 'B' });
    expect(h.manager._open.size).toBe(2);
    const incA = Array.from(h.manager._open.values()).find(x => x.operator === 'A');
    const memberInA = incA.members.get('S1|i1');
    expect(memberInA.active).toBe(false);   // перенесён в B
    // Recovery i1 закрывает его во ВСЕХ связанных инцидентах, не только первом.
    h.manager.handle('modem_ping_recovered', { server: 'S1', nick: 'M_i1', imei: 'i1' });
    const incB = Array.from(h.manager._open.values()).find(x => x.operator === 'B');
    expect(incB.members.get('S1|i1').active).toBe(false);
    h.manager.shutdown(); h.db.close();
  });
});
