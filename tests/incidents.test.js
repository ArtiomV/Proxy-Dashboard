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
