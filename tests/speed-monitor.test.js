// SpeedMonitor: почасовой замер скорости выбранных модемов.
//   • parseSpeedtestResult — все формы ответа бокса
//   • runSpeedMonitor — резолв ников по show_status_json, ok/offline/not_found
//     строки в speed_monitor, ретенция, re-entrancy guard

import { describe, it, expect, beforeAll, vi } from 'vitest';
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

function makeJob(fetchApi, opts = {}) {
  process.env.SPEED_MONITOR_NICKS = NICKS;
  const { normalizeOperator } = cjsRequire('../src/utils/traffic.js');
  const job = speedMonitor.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {},
    apiServers: [{ name: 'S1', country: 'MD' }, { name: 'S2', country: 'RO' }],
    fetchApi,
    normalizeOperator,
    sleep: async () => {},   // пауза ретрая в тестах мгновенная
    ...opts,
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

  it('ping не берётся из служебных полей и отсекается при мусоре', () => {
    // 2026-08-13: в проде в ping утекал таймаут fetchApi (180000 мс → 1800000.0).
    expect(parseSpeedtestResult({ download: '5', latency: 1800000 })).toEqual({ dl: 5, ul: 0, ping: 0 });
    expect(parseSpeedtestResult({ download: '5', timeout: 180000 })).toEqual({ dl: 5, ul: 0, ping: 0 });
    expect(parseSpeedtestResult({ download: '5', ping: '1800000' })).toEqual({ dl: 5, ul: 0, ping: 0 });
    expect(parseSpeedtestResult({ raw: 'Download: 5 Mbps\nPing: 99999999 ms' })).toEqual({ dl: 5, ul: 0, ping: 0 });
    expect(parseSpeedtestResult({ download: '5', ping: 'abc' })).toEqual({ dl: 5, ul: 0, ping: 0 });
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

// Джоб с никами из настройки speedtest_modems (getSetting), без env-override.
function makeJobWithSetting(fetchApi, settingCsv, envCsv, opts = {}) {
  if (envCsv) process.env.SPEED_MONITOR_NICKS = envCsv;
  const { normalizeOperator } = cjsRequire('../src/utils/traffic.js');
  const job = speedMonitor.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    logActivity() {},
    apiServers: [{ name: 'S1', country: 'MD' }],
    fetchApi,
    normalizeOperator,
    getSetting: (k, def) => (k === 'speedtest_modems' ? settingCsv : def),
    sleep: async () => {},   // пауза ретрая в тестах мгновенная
    ...opts,
  });
  delete process.env.SPEED_MONITOR_NICKS;
  return job;
}

describe('SpeedMonitor: список модемов из настройки speedtest_modems', () => {
  it('без env ники берутся из getSetting на каждый прогон', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const job = makeJobWithSetting(statusFetch({ download: '20', upload: '5', ping: '30' }), 'MD_01');
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 1, failed: 0 });
    const nicks = db.prepare('SELECT nick FROM speed_monitor').all().map(x => x.nick);
    expect(nicks).toEqual(['MD_01']);
  });

  it('env SPEED_MONITOR_NICKS — override над настройкой', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const job = makeJobWithSetting(statusFetch({ download: '1', upload: '1', ping: '1' }), 'MD_01', 'MD_04');
    await job.runSpeedMonitor();
    const nicks = db.prepare('SELECT nick FROM speed_monitor').all().map(x => x.nick);
    expect(nicks).toEqual(['MD_04']);
  });

  it('пустая/битая настройка → дефолтный список DEFAULT_NICKS', () => {
    const { DEFAULT_NICKS } = cjsRequire('../src/jobs/speed-monitor.js');
    const job = makeJobWithSetting(statusFetch({}), '  ');
    expect(job.getTargetNicks()).toEqual(DEFAULT_NICKS.split(','));
  });

  it('PUT /api/admin/settings: speedtest_modems валидируется и сохраняется', async () => {
    const { asAdmin } = await import('./_helpers/app.js');
    const request = (await import('supertest')).default;
    const { app } = bootApp();
    const token = asAdmin();

    const bad = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', token).send({ speedtest_modems: 'MD_01,плохой ник!' });
    expect(bad.status).toBe(400);

    const ok = await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', token).send({ speedtest_modems: ' MD_01 , MD_04 ' });
    expect(ok.status).toBe(200);
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'app_settings'").get();
    expect(JSON.parse(row.value).speedtest_modems).toBe('MD_01,MD_04');

    // Возвращаем дефолт — blob общий для других тестов процесса.
    await request(app).put('/api/admin/settings')
      .set('X-Auth-Token', token).send({ speedtest_modems: 'MD2_40,MD2_44,MD_01,MD_04,MD_10' });
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

describe('SpeedMonitor: динамическая норма модема', () => {
  it('два замера ниже 50% недельной медианы открывают деградацию, 75% закрывают', () => {
    db.prepare('DELETE FROM speed_monitor').run();
    db.prepare('DELETE FROM modem_speed_baseline_state').run();
    const ins=db.prepare("INSERT INTO speed_monitor(server,nick,download,upload,ping,ok,operator,ts) VALUES('S1','MD_BASE',30,5,20,1,'Moldcell',datetime('now',?))");
    for(let i=1;i<=12;i++)ins.run('-'+i+' hours');
    const trigger=vi.fn();
    const job=makeJobWithSetting(statusFetch({download:'30'}),'MD_BASE',undefined,{alerts:{trigger}});
    const f={server:{name:'S1'},imei:'base-imei',operator:'Moldcell'};
    expect(job.evaluateBaseline(f,'MD_BASE',10)).toMatchObject({bad:true,consecutive:1,degraded:false});
    expect(job.evaluateBaseline(f,'MD_BASE',9)).toMatchObject({bad:true,consecutive:2,degraded:true});
    expect(trigger).toHaveBeenCalledWith('modem_speed_baseline_degraded',expect.objectContaining({nick:'MD_BASE',baseline:30,current:9}));
    expect(job.evaluateBaseline(f,'MD_BASE',25)).toMatchObject({bad:false,degraded:false});
    expect(trigger).toHaveBeenCalledWith('modem_speed_baseline_recovered',expect.objectContaining({nick:'MD_BASE',baseline:30,current:25}));
  });
});

describe('SpeedMonitor: повторный замер (нестабильный dl)', () => {
  // fetchApi со счётчиком вызовов speedtest; результаты — по очереди из dlSeq.
  function seqFetch(dlSeq) {
    let stCalls = 0;
    const fetchApi = async (server, path) => {
      if (path === '/apix/show_status_json') {
        if (server.name !== 'S1') return [];
        return [{ modem_details: { NICK: 'MD_01', IMEI: '860000000000001' }, net_details: { IS_ONLINE: 'yes', CELLOP: 'moldcell' } }];
      }
      if (path.startsWith('/apix/speedtest')) {
        const dl = dlSeq[Math.min(stCalls, dlSeq.length - 1)];
        stCalls++;
        return { download: String(dl), upload: '5', ping: '20' };
      }
      throw new Error('unexpected ' + path);
    };
    return { fetchApi, calls: () => stCalls };
  }

  it('dl=1 → повтор → в БД ушёл лучший (30), attempts=2', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = seqFetch([1, 30]);
    const job = makeJobWithSetting(f.fetchApi, 'MD_01');
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 1, failed: 0 });
    expect(f.calls()).toBe(2);
    const row = db.prepare("SELECT download, attempts FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row).toMatchObject({ download: 30, attempts: 2 });
  });

  it('dl=40 с первого замера → повтор не делаем (attempts=1, экономим трафик симки)', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = seqFetch([40, 1]);
    const job = makeJobWithSetting(f.fetchApi, 'MD_01');
    await job.runSpeedMonitor();
    expect(f.calls()).toBe(1);
    const row = db.prepare("SELECT download, attempts FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row).toMatchObject({ download: 40, attempts: 1 });
  });

  it('второй замер хуже → в БД остаётся первый (лучший по dl)', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = seqFetch([4, 0.5]);
    const job = makeJobWithSetting(f.fetchApi, 'MD_01');
    await job.runSpeedMonitor();
    expect(f.calls()).toBe(2);
    const row = db.prepare("SELECT download, attempts FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row).toMatchObject({ download: 4, attempts: 2 });
  });

  it('ok=0 → один ретрай; успех со второго раза пишется с attempts=2', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    let stCalls = 0;
    const fetchApi = async (server, path) => {
      if (path === '/apix/show_status_json') {
        if (server.name !== 'S1') return [];
        return [{ modem_details: { NICK: 'MD_01', IMEI: '860000000000001' }, net_details: { IS_ONLINE: 'yes', CELLOP: 'moldcell' } }];
      }
      if (path.startsWith('/apix/speedtest')) {
        stCalls++;
        if (stCalls === 1) return { error: 'modem busy' };
        return { download: '25', upload: '8', ping: '30' };
      }
      throw new Error('unexpected ' + path);
    };
    const job = makeJobWithSetting(fetchApi, 'MD_01');
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 1, failed: 0 });
    expect(stCalls).toBe(2);
    const row = db.prepare("SELECT ok, download, attempts FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row).toMatchObject({ ok: 1, download: 25, attempts: 2 });
  });

  it('оба замера вернули нули → ok=0 empty_result (attempts=2), нули не «успех»', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    let stCalls = 0;
    const fetchApi = async (server, path) => {
      if (path === '/apix/show_status_json') {
        if (server.name !== 'S1') return [];
        return [{ modem_details: { NICK: 'MD_01', IMEI: '860000000000001' }, net_details: { IS_ONLINE: 'yes', CELLOP: 'moldcell' } }];
      }
      if (path.startsWith('/apix/speedtest')) { stCalls++; return { download: '0', upload: '0', ping: '0' }; }
      throw new Error('unexpected ' + path);
    };
    // retryRounds: 0 — раунды перезамеров покрыты отдельными тестами ниже,
    // здесь проверяем смысл одиночного прогона.
    const job = makeJobWithSetting(fetchApi, 'MD_01', undefined, { retryRounds: 0 });
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 0, failed: 1, recovered: 0 });
    expect(stCalls).toBe(2);   // dl<5 → ретрай, но и он нулевой
    const row = db.prepare("SELECT ok, error, attempts FROM speed_monitor WHERE nick = 'MD_01'").get();
    expect(row).toMatchObject({ ok: 0, error: 'empty_result', attempts: 2 });
  });

  it('старые ok=1 с dl=ul=0 не роняют агрегаты (ок=0 в выдаче)', async () => {
    const { asAdmin } = await import('./_helpers/app.js');
    const request = (await import('supertest')).default;
    const { app } = bootApp();
    const token = asAdmin();
    db.prepare('DELETE FROM speed_monitor').run();
    // Историческая «нулевая успешная» строка + нормальная в тот же час.
    db.prepare("INSERT INTO speed_monitor (nick, server, download, upload, ping, ok, operator, ts) VALUES ('MD_01','S1',0,0,0,1,'Moldcell',datetime('now','-1 hours'))").run();
    db.prepare("INSERT INTO speed_monitor (nick, server, download, upload, ping, ok, operator, ts) VALUES ('MD_01','S1',30,10,40,1,'Moldcell',datetime('now','-1 hours'))").run();
    const res = await request(app).get('/api/admin/speed-monitor?hours=48').set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r2 => r2.nick === 'MD_01');
    expect(row).toMatchObject({ ok_count: 1, fail_count: 1, avg_dl: 30, min_dl: 30, max_dl: 30 });
  });
});

describe('SpeedMonitor: настойчивые перезамеры (2026-08-14)', () => {
  // Модем оффлайн в основном прогоне, оживает на N-м раунде перезамеров.
  // statusOnlineAfterRounds: с какого вызова show_status_json модем онлайн
  // (1-й вызов — основной прогон, 2-й — раунд 1, 3-й — раунд 2, ...).
  function recoveringFetch(statusOnlineAfterRounds, dlResult) {
    let statusCalls = 0, stCalls = 0;
    const fetchApi = async (server, path) => {
      if (path === '/apix/show_status_json') {
        statusCalls++;
        if (server.name !== 'S1') return [];
        const online = statusCalls > statusOnlineAfterRounds ? 'yes' : 'no';
        return [{ modem_details: { NICK: 'MD_04', IMEI: '860000000000004' }, net_details: { IS_ONLINE: online, CELLOP: 'orange' } }];
      }
      if (path.startsWith('/apix/speedtest')) { stCalls++; return dlResult; }
      throw new Error('unexpected ' + path);
    };
    return { fetchApi, statusCalls: () => statusCalls, stCalls: () => stCalls };
  }

  it('оффлайн → ожил на 2-м раунде → ok-строка дописана, recovered=1', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = recoveringFetch(2, { download: '18', upload: '6', ping: '40' });
    const job = makeJobWithSetting(f.fetchApi, 'MD_04', undefined, { retryRounds: 5 });
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 0, failed: 1, recovered: 1 });
    const rows = db.prepare("SELECT ok, error, download, operator FROM speed_monitor WHERE nick = 'MD_04' ORDER BY ts").all();
    expect(rows.length).toBe(2);   // исходная fail-строка + восстановленная ok
    expect(rows[0]).toMatchObject({ ok: 0, error: 'offline' });
    expect(rows[1]).toMatchObject({ ok: 1, download: 18, operator: 'Orange MD' });
    expect(f.stCalls()).toBe(1);   // замер только когда модем ожил
    expect(f.statusCalls()).toBe(3); // основной прогон + раунды 1 и 2
  });

  it('ошибка speedtest в прогоне → успех на 1-м раунде → recovered=1', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    let stCalls = 0;
    const fetchApi = async (server, path) => {
      if (path === '/apix/show_status_json') {
        if (server.name !== 'S1') return [];
        return [{ modem_details: { NICK: 'MD_01', IMEI: '860000000000001' }, net_details: { IS_ONLINE: 'yes', CELLOP: 'moldcell' } }];
      }
      if (path.startsWith('/apix/speedtest')) {
        stCalls++;
        // Основной прогон: обе попытки — ошибка. Раунд 1: успех.
        return stCalls <= 2 ? { error: 'modem busy' } : { download: '25', upload: '8', ping: '30' };
      }
      throw new Error('unexpected ' + path);
    };
    const job = makeJobWithSetting(fetchApi, 'MD_01', undefined, { retryRounds: 3 });
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 0, failed: 1, recovered: 1 });
    const rows = db.prepare("SELECT ok, download FROM speed_monitor WHERE nick = 'MD_01' ORDER BY ts").all();
    expect(rows.length).toBe(2);
    expect(rows[1]).toMatchObject({ ok: 1, download: 25 });
  });

  it('не ожил за отведённые раунды → лишних строк нет, recovered=0', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = recoveringFetch(Infinity, { download: '10', upload: '5', ping: '30' });
    const job = makeJobWithSetting(f.fetchApi, 'MD_04', undefined, { retryRounds: 2 });
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 0, failed: 1, recovered: 0 });
    const rows = db.prepare("SELECT ok, error FROM speed_monitor WHERE nick = 'MD_04'").all();
    expect(rows.length).toBe(1);   // только исходная fail-строка
    expect(rows[0]).toMatchObject({ ok: 0, error: 'offline' });
    expect(f.stCalls()).toBe(0);   // оффлайн — замеров не было
    expect(f.statusCalls()).toBe(3); // прогон + 2 раунда перерезолва
  });

  it('все успешны в основном прогоне → раунды перезамеров не запускаются', async () => {
    db.prepare('DELETE FROM speed_monitor').run();
    const f = recoveringFetch(0, { download: '30', upload: '9', ping: '35' });
    const job = makeJobWithSetting(f.fetchApi, 'MD_04', undefined, { retryRounds: 5 });
    const r = await job.runSpeedMonitor();
    expect(r).toMatchObject({ tested: 1, failed: 0, recovered: 0 });
    expect(f.statusCalls()).toBe(1);   // только основной резолв
  });
});
