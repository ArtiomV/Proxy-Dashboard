// SpeedMonitor: почасовой замер скорости выбранных модемов.
//   • parseSpeedtestResult — все формы ответа бокса
//   • runSpeedMonitor — резолв ников по show_status_json, ok/offline/not_found
//     строки в speed_monitor, ретенция, re-entrancy guard

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);

let db, speedMonitor;
beforeAll(() => {
  db = bootApp().db;
  speedMonitor = cjsRequire('../src/jobs/speed-monitor.js');
  db.prepare('DELETE FROM speed_monitor').run();
});

const NICKS = 'MD_01,MD_04,MD_10';

function makeJob(fetchApi) {
  process.env.SPEED_MONITOR_NICKS = NICKS;
  const { normalizeOperator } = cjsRequire('../src/utils/traffic.js');
  const job = speedMonitor.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {},
    apiServers: [{ name: 'S1', country: 'MD' }, { name: 'S2', country: 'RO' }],
    fetchApi,
    normalizeOperator,
  });
  delete process.env.SPEED_MONITOR_NICKS;
  return job;
}

// S1: MD_01 онлайн (Moldtelecom), MD_04 оффлайн; MD_10 нет нигде.
function statusFetch(dlResult) {
  return async (server, path) => {
    if (path === '/apix/show_status_json') {
      if (server.name !== 'S1') return [];
      return [
        { modem_details: { NICK: 'MD_01', IMEI: '860000000000001' }, net_details: { IS_ONLINE: 'yes', CELLOP: 'moldtelecom' } },
        { modem_details: { NICK: 'MD_04', IMEI: '860000000000004' }, net_details: { IS_ONLINE: 'no', CELLOP: 'orange' } },
        { modem_details: { NICK: 'MD_99', IMEI: '860000000000099' }, net_details: { IS_ONLINE: 'yes' } },
      ];
    }
    if (path.startsWith('/apix/speedtest')) return dlResult;
    throw new Error('unexpected ' + path);
  };
}

describe('SpeedMonitor: parseSpeedtestResult', () => {
  const { parseSpeedtestResult } = cjsRequire('../src/jobs/speed-monitor.js');

  it('поля в разном регистре + raw-строка + мусор', () => {
    expect(parseSpeedtestResult({ download: '25.4', upload: '10.2', ping: '48' }))
      .toEqual({ dl: 25.4, ul: 10.2, ping: 48 });
    expect(parseSpeedtestResult({ Download: 12, Upload: 3 }))
      .toEqual({ dl: 12, ul: 3, ping: 0 });
    expect(parseSpeedtestResult({ raw: 'Download: 31.7 Mbps\nUpload: 8.9 Mbps\nPing: 55 ms' }))
      .toEqual({ dl: 31.7, ul: 8.9, ping: 55 });
    expect(parseSpeedtestResult(null)).toEqual({ dl: 0, ul: 0, ping: 0 });
    expect(parseSpeedtestResult('oops')).toEqual({ dl: 0, ul: 0, ping: 0 });
  });
});

describe('SpeedMonitor: GET /api/admin/speed-monitor', () => {
  it('почасовая агрегация + мета (оператор/сервер/локация) по никам', async () => {
    const { asAdmin } = await import('./_helpers/app.js');
    const request = (await import('supertest')).default;
    const { app } = bootApp();
    const token = asAdmin();
    db.prepare('DELETE FROM speed_monitor').run();
    db.prepare("INSERT INTO speed_monitor (nick, server, download, upload, ping, ok, operator, ts) VALUES ('MD_01','S1',20,8,40,1,'Moldtelecom',datetime('now','-2 hours'))").run();
    db.prepare("INSERT INTO speed_monitor (nick, server, download, upload, ping, ok, operator, ts) VALUES ('MD_01','S1',10,6,50,1,'Moldtelecom',datetime('now','-2 hours'))").run();
    db.prepare("INSERT INTO speed_monitor (nick, server, ok, error, operator, ts) VALUES ('MD_01','S1',0,'offline','Moldtelecom',datetime('now','-1 hours'))").run();

    const res = await request(app).get('/api/admin/speed-monitor?hours=48').set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    const hourRow = res.body.rows.find(r => r.nick === 'MD_01' && r.samples === 2);
    expect(hourRow).toMatchObject({ ok_count: 2, avg_dl: 15, min_dl: 10, max_dl: 20 });
    const failRow = res.body.rows.find(r => r.nick === 'MD_01' && r.fail_count === 1);
    expect(failRow).toBeTruthy();
    const meta = (res.body.modems || []).find(m => m.nick === 'MD_01');
    expect(meta).toMatchObject({ server: 'S1', operator: 'Moldtelecom' });
    expect(typeof meta.location).toBe('string');   // в тесте apiServers пуст → fallback на имя сервера
  });
});

describe('SpeedMonitor: runSpeedMonitor', () => {
  it('онлайн → ok-строка; оффлайн и не найден → ok=0 с причиной', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const job = makeJob(statusFetch({ download: '25.4', upload: '10.2', ping: '48' }));
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 1, failed: 2 });

    const rows = db.prepare('SELECT nick, ok, error, download, server, imei, operator FROM speed_monitor ORDER BY nick').all();
    expect(rows.length).toBe(3);
    const byNick = Object.fromEntries(rows.map(x => [x.nick, x]));
    expect(byNick.MD_01).toMatchObject({ ok: 1, download: 25.4, server: 'S1', imei: '860000000000001', operator: 'Moldtelecom' });
    expect(byNick.MD_04).toMatchObject({ ok: 0, error: 'offline', operator: 'Orange MD' });
    expect(byNick.MD_10).toMatchObject({ ok: 0, error: 'not_found', server: '' });
  });

  it('ошибка speedtest → ok=0 с текстом, прогон не падает', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const job = makeJob(statusFetch({ error: 'modem busy' }));
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 0, failed: 3 });
    const row = db.prepare("SELECT ok, error FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row.ok).toBe(0);
    expect(row.error).toContain('modem busy');
  });

  it('ретенция: строки старше 60 дней сносятся', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    db.prepare("INSERT INTO speed_monitor (nick, ok, ts) VALUES ('MD_01', 1, datetime('now', '-61 days'))").run();
    const job = makeJob(statusFetch({ download: '1', upload: '1', ping: '1' }));
    await job.runSpeedMonitor();
    const old = db.prepare("SELECT COUNT(*) c FROM speed_monitor WHERE ts < datetime('now', '-60 days')").get().c;
    expect(old).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM speed_monitor').get().c).toBe(3);
  });
});
