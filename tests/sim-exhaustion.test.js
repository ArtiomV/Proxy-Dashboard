// 2026-09-26 · sim-exhaustion: детектор «у симки кончился пакет» по симптомам.
// SIM OK + ppp_connected + без EXT_IP/IP_RESET + пинг 100% ≥ 15 мин
// непрерывно → sim_package_exhausted. Ротация (краткий IP_RESET) и флапы
// не алертят; возврат IP снимает стейт, новый эпизод алертит заново.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const simExhaustion = require('../src/jobs/sim-exhaustion.js');

const MIGRATION_104 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '104_sim_exhaustion_state.sql'), 'utf8');

const MODEM_EX = {   // SIM OK, сессия есть, IP нет, пинг 100%
  modem_details: { IMEI: 'imei1', NICK: 'MD_1' },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'no', EXT_IP: '', ping_stats: '?ms, 100% loss', CELLOP: 'Moldcell' },
};
const MODEM_OK = {
  modem_details: { IMEI: 'imei2', NICK: 'MD_2' },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'yes', EXT_IP: '94.139.1.1', ping_stats: '150ms, 0% loss', CELLOP: 'Moldcell' },
};

function boot(feed, settings = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE traffic_hourly (server_name TEXT, nick TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER)');
  const fired = [];
  const job = simExhaustion.create({
    db, logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    fetchAllServersDataCached: async () => feed(),
  });
  return { job, fired, db };
}

describe('sim-exhaustion', () => {
  it('симптом ≥15 мин непрерывно → один алерт с контекстом расхода', async () => {
    let feed = () => [{ serverName: 'S1', status: [MODEM_EX, MODEM_OK] }];
    const { job, fired, db } = boot(feed);
    db.prepare("INSERT INTO traffic_hourly VALUES ('S1', 'MD_1', '2026-09-26 08:00', 5e9, 1e9)").run();

    await job.runOnce();   // t0 — стейт создан, алерта ещё нет
    expect(fired.length).toBe(0);
    expect(job._state.size).toBe(1);

    const st = job._state.get('S1|imei1');
    st.since = Date.now() - 16 * 60000;   // 16 мин непрерывно
    await job.runOnce();
    expect(fired.length).toBe(1);
    expect(fired[0].rule).toBe('sim_package_exhausted');
    expect(fired[0].payload).toMatchObject({ nick: 'MD_1', server: 'S1', used_gb: 6 });
    expect(fired[0].payload.mins).toBeGreaterThanOrEqual(15);

    await job.runOnce();   // повтор в том же эпизоде — не алертит (st.alerted)
    expect(fired.length).toBe(1);
  });

  it('краткий симптом (флап/ротация) не алертит', async () => {
    const { job, fired } = boot(() => [{ serverName: 'S1', status: [MODEM_EX] }]);
    await job.runOnce();
    await job.runOnce();
    expect(fired.length).toBe(0);
  });

  it('возврат IP снимает стейт; новый эпизод — новый алерт', async () => {
    let down = true;
    const { job, fired } = boot(() => [{ serverName: 'S1', status: [down ? MODEM_EX : MODEM_OK] }]);
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(1);
    down = false;                    // IP вернулся (онлайн)
    await job.runOnce();
    expect(job._state.size).toBe(0); // эпизод закрыт
    down = true;                     // новый эпизод
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(2);
  });

  it('устаревший фид (_cached) и ротация (IP_RESET+online) не алертят', async () => {
    const rotating = {
      modem_details: { IMEI: 'imei3', NICK: 'MD_3' },
      net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'no', EXT_IP: 'IP_RESET', ping_stats: '150ms, 0% loss' },
    };
    const { job, fired } = boot(() => [{ serverName: 'S1', _cached: true, status: [MODEM_EX] }, { serverName: 'S1', status: [rotating] }]);
    await job.runOnce();
    job._state.forEach(st => { st.since = 0; });
    await job.runOnce();
    expect(fired.length).toBe(0);
  });
});

// ── 2026-09-26 (вторая итерация): состояние «пакет исчерпан» персистентно
// (миграция 104), переживает рестарт. Восстановление подтверждается
// СПИДТЕСТ-пробой: тарифы «безлимит с троттлингом», возврат IP/пинга сам по
// себе ничего не значит — трафик идёт и на минимальной скорости.
const MODEM_OK_IMEI1 = {   // тот же модем, что MODEM_EX, но выглядит здоровым
  modem_details: { IMEI: 'imei1', NICK: 'MD_1' },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'yes', EXT_IP: '94.139.1.5', ping_stats: '150ms, 0% loss', CELLOP: 'Moldcell' },
};

function bootWithTable(feed, settings = {}, speedResult) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE traffic_hourly (server_name TEXT, nick TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER)');
  db.exec(MIGRATION_104);
  const fired = [];
  const probes = [];
  const mkJob = () => simExhaustion.create({
    db, logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    fetchAllServersDataCached: async () => feed(),
    apiServers: [{ name: 'S1' }],
    fetchApi: async (server, path) => {           // спидтест-проба бокса
      if (path.startsWith('/apix/speedtest')) {
        probes.push(path);
        return typeof speedResult === 'function' ? speedResult() : speedResult;
      }
      throw new Error('unexpected ' + path);
    },
  });
  return { mkJob, fired, db, probes };
}

describe('sim-exhaustion: персистентное состояние и восстановление', () => {
  it('подтверждённый эпизод пишется в БД; после «рестарта» алерт не повторяется', async () => {
    const { mkJob, fired, db } = bootWithTable(() => [{ serverName: 'S1', status: [MODEM_EX] }]);

    const job1 = mkJob();
    await job1.runOnce();
    job1._state.get('S1|imei1').since = Date.now() - 16 * 60000;
    await job1.runOnce();
    expect(fired.map(f => f.rule)).toEqual(['sim_package_exhausted']);
    const row = db.prepare('SELECT * FROM sim_exhaustion_state WHERE server_name = ? AND imei = ?').get('S1', 'imei1');
    expect(row).toBeTruthy();
    expect(row.alerted_at).toBeGreaterThan(0);
    expect(row.operator).toBe('Moldcell');

    // «Рестарт»: новый инстанс на той же БД. Симптом держится, но повторного
    // алерта нет — alerted_at пережил рестарт.
    const job2 = mkJob();
    await job2.runOnce();
    job2._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job2.runOnce();
    expect(fired.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
  });

  it('восстановление подтверждается спидтест-пробой: урезанная скорость держит состояние, нормальная — снимает', async () => {
    let healthy = false;
    let speed = { download: '0.4', upload: '0.1', ping: '999' };   // троттлинг: трафик идёт, скорость минимальная
    const { mkJob, fired, db, probes } = bootWithTable(
      () => [{ serverName: 'S1', status: [healthy ? MODEM_OK_IMEI1 : MODEM_EX] }],
      {}, () => speed);
    const job = mkJob();

    // Эпизод подтверждён и заалерчен.
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 30 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);

    // Модем выглядит здоровым (IP + пинг), но проба показывает троттлинг —
    // состояние держим, восстановления нет.
    healthy = true;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(1);

    // Повторный прогон в пределах probe-кулдауна — новых замеров нет.
    await job.runOnce();
    expect(probes.length).toBe(1);

    // Пакет реактивирован: следующая проба (после кулдауна) даёт нормальный dl.
    speed = { download: '25.4', upload: '10.2', ping: '48' };
    job._probes.set('S1|imei1', Date.now() - 31 * 60000);
    await job.runOnce();
    expect(probes.length).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(fired.length).toBe(2);
    expect(fired[1].rule).toBe('sim_package_recovered');
    expect(fired[1].payload).toMatchObject({ server: 'S1', nick: 'MD_1', imei: 'imei1', dl: 25.4 });
    expect(fired[1].payload.mins_down).toBeGreaterThanOrEqual(25);

    // Повторный прогон по здоровому модему — ни проб, ни алертов.
    await job.runOnce();
    expect(probes.length).toBe(2);
    expect(fired.length).toBe(2);
  });

  it('флап здорового вида без проб не снимает состояние; неудачный замер — просто следующая проба по кулдауну', async () => {
    let feed = () => [{ serverName: 'S1', status: [MODEM_EX] }];
    let speed = new Error('speedtest timeout');
    const { mkJob, fired, db, probes } = bootWithTable(() => feed(), {}, () => { throw speed; });
    const job = mkJob();
    await job.runOnce();
    job._state.get('S1|imei1').since = Date.now() - 20 * 60000;
    await job.runOnce();
    expect(fired.length).toBe(1);

    // Модем стал выглядеть здоровым, но замер падает — состояние держим.
    feed = () => [{ serverName: 'S1', status: [MODEM_OK_IMEI1] }];
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(1);
  });

  it('модем без здоровых признаков (ушёл в полный оффлайн) НЕ восстанавливается', async () => {
    const { mkJob, fired, db } = bootWithTable(() => [{ serverName: 'S1', status: [] }]); // модем пропал из фида
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imei1', 'MD_1', 'Moldcell', ?, ?)")
      .run(Date.now() - 3600e3, Date.now() - 3500e3);
    const job = mkJob();
    await job.runOnce();
    await job.runOnce();
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(0);
  });
});

describe('sim-exhaustion: isExhausted — гейт подавления', () => {
  it('матч по imei / server+nick / голому nick; без таблицы → false', async () => {
    const db = new Database(':memory:');
    db.exec(MIGRATION_104);
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, since_ts) VALUES ('S1', 'imei9', 'MD_9', 1)").run();

    expect(simExhaustion.isExhausted(db, { server: 'S1', nick: 'MD_9', imei: 'imei9' })).toBe(true);
    expect(simExhaustion.isExhausted(db, { imei: 'imei9' })).toBe(true);              // imei без сервера
    expect(simExhaustion.isExhausted(db, { server: 'S1', nick: 'MD_9' })).toBe(true); // server+nick
    expect(simExhaustion.isExhausted(db, { nick: 'MD_9' })).toBe(true);               // голый nick
    expect(simExhaustion.isExhausted(db, { server: 'S2', nick: 'MD_9' })).toBe(false);// чужой сервер
    expect(simExhaustion.isExhausted(db, { server: 'S1', nick: 'MD_1', imei: 'imei1' })).toBe(false);
    expect(simExhaustion.isExhausted(db, {})).toBe(false);

    const empty = new Database(':memory:');   // таблицы нет — старая схема
    expect(simExhaustion.isExhausted(empty, { imei: 'imei9' })).toBe(false);
  });
});

// ── 2026-09-26 (v4): сигнатура 2 — троттлинг. Модем жив (IP/пинг в норме),
// но замеры ~0. Подтверждение контрольной пробой после 5-мин «отдыха».
// Плюс операторский уровень: ≥80% симок оператора в состоянии → групповой алерт.
const healthyModem = (imei, nick, cellop = 'moldcell') => ({
  modem_details: { IMEI: imei, NICK: nick },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'yes', EXT_IP: '94.139.1.5', ping_stats: '150ms, 0% loss', CELLOP: cellop },
});

function bootV4(feed, speedResult, settings = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE traffic_hourly (server_name TEXT, nick TEXT, hour_start TEXT, bytes_in INTEGER, bytes_out INTEGER)');
  db.exec(MIGRATION_104);
  db.exec(`CREATE TABLE speed_monitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT, nick TEXT, imei TEXT,
    download REAL, upload REAL, ping REAL, ok INTEGER, error TEXT, operator TEXT,
    attempts INTEGER, ts TEXT DEFAULT (datetime('now'))
  )`);
  const fired = [];
  const probes = [];
  const mkJob = () => simExhaustion.create({
    db, logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => { fired.push({ rule, payload }); return true; } },
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    fetchAllServersDataCached: async () => feed(),
    apiServers: [{ name: 'S1' }, { name: 'S4' }],
    fetchApi: async (server, path) => {
      if (path.startsWith('/apix/speedtest')) {
        probes.push(path);
        return typeof speedResult === 'function' ? speedResult() : speedResult;
      }
      throw new Error('unexpected ' + path);
    },
  });
  return { mkJob, fired, db, probes };
}

describe('sim-exhaustion v4: троттлинг-сигнатура (модем жив, скорость ~0)', () => {
  it('плохой замер → 5 мин отдыха → подтверждающая проба ~0 → состояние + алерт kind=throttled', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [healthyModem('imei5', 'MD_5')] }],
      { download: '0.5', upload: '0.2', ping: '900' });
    db.prepare("INSERT INTO speed_monitor (server, nick, download, ok) VALUES ('S1', 'MD_5', 0.3, 1)").run();
    const job = mkJob();

    await job.runOnce();   // кандидат отмечен, пробы ещё нет — модем «отдыхает»
    expect(probes.length).toBe(0);
    expect(job._throttleCandidates.has('S1|imei5')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);

    // Прошло 5+ минут — подтверждающая проба, скорость снова ~0 → состояние.
    job._throttleCandidates.get('S1|imei5').firstAt = Date.now() - 6 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(1);
    expect(fired[0].rule).toBe('sim_package_exhausted');
    expect(fired[0].payload).toMatchObject({ nick: 'MD_5', server: 'S1', kind: 'throttled', dl: 0.5, operator: 'Moldcell' });
  });

  it('контрольная проба с нормальной скоростью — ложная тревога, состояние не включается', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [healthyModem('imei5', 'MD_5')] }],
      { download: '25', upload: '10', ping: '40' });
    db.prepare("INSERT INTO speed_monitor (server, nick, download, ok) VALUES ('S1', 'MD_5', 0.3, 1)").run();
    const job = mkJob();
    await job.runOnce();
    job._throttleCandidates.get('S1|imei5').firstAt = Date.now() - 6 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(fired.length).toBe(0);
    expect(job._throttleCandidates.size).toBe(0);
  });

  it('модем уже в состоянии (сигнатура 1) — замеры ~0 не плодят дубли и пробы', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [MODEM_EX] }],
      { download: '0.5', upload: '0.2', ping: '900' });
    db.prepare("INSERT INTO speed_monitor (server, nick, download, ok) VALUES ('S1', 'MD_1', 0.3, 1)").run();
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imei1', 'MD_1', 'Moldcell', 1, 2)").run();
    const job = mkJob();
    await job.runOnce();
    await job.runOnce();
    expect(probes.length).toBe(0);   // модем не «здоров» → recovery-проб нет; уже в состоянии → throttle-проб нет
    expect(fired.length).toBe(0);
  });
});

describe('sim-exhaustion v4: операторский уровень', () => {
  it('≥80% симок оператора на площадке в состоянии → один групповой алерт', async () => {
    const fleet = [
      healthyModem('imeiA', 'MD_A'), healthyModem('imeiB', 'MD_B'),
      healthyModem('imeiC', 'MD_C'), healthyModem('imeiD', 'MD_D'),
    ];
    const { mkJob, fired, db } = bootV4(() => [{ serverName: 'S1', status: fleet }], null);
    const ins = db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', ?, ?, 'Moldcell', 1, 2)");
    ins.run('imeiA', 'MD_A'); ins.run('imeiB', 'MD_B'); ins.run('imeiC', 'MD_C');   // 3/4 = 75% < 80%
    const job = mkJob();
    await job.runOnce();
    expect(fired.filter(f => f.rule === 'operator_package_throttled').length).toBe(0);

    ins.run('imeiD', 'MD_D');   // 4/4 = 100% ≥ 80%
    await job.runOnce();
    const opAlerts = fired.filter(f => f.rule === 'operator_package_throttled');
    expect(opAlerts.length).toBe(1);
    expect(opAlerts[0].payload).toMatchObject({ server: 'S1', operator: 'Moldcell', exhausted: 4, total: 4 });
  });

  it('меньше 3 симок оператора — группового алерта нет (шум по мелочи)', async () => {
    const fleet = [healthyModem('imeiA', 'MD_A'), healthyModem('imeiB', 'MD_B')];
    const { mkJob, fired, db } = bootV4(() => [{ serverName: 'S1', status: fleet }], null);
    const ins = db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', ?, ?, 'Moldcell', 1, 2)");
    ins.run('imeiA', 'MD_A'); ins.run('imeiB', 'MD_B');
    const job = mkJob();
    await job.runOnce();
    expect(fired.filter(f => f.rule === 'operator_package_throttled').length).toBe(0);
  });
});

// ── 2026-09-26 (v5): сигнатура 3 — «замороженный трафик» по bw-счётчикам
// живого фида. Почасовой монитор меряет пару ников в час — слишком медленно
// при массовом троттлинге (флуд MD_72/73). Дельта < 5 МБ за 20 мин → кандидат
// на ту же подтверждающую пробу. Отбор бесплатный, спидтест — арбитр.
const frozenModem = (imei, nick, dayIn, dayOut, cellop = 'moldcell') => ({
  modem_details: { IMEI: imei, NICK: nick },
  net_details: { SimStatus: 'SIM OK', ConnectionStatus: 'OK, ppp_connected', IS_ONLINE: 'yes', EXT_IP: '94.139.1.5', ping_stats: '150ms, 0% loss', CELLOP: cellop },
  ports: [{ bandwidth_bytes_day_in: String(dayIn), bandwidth_bytes_day_out: String(dayOut) }],
});

describe('sim-exhaustion v5: замороженный трафик (bw-счётчики)', () => {
  it('дельта < 5 МБ за 20 мин → проба ~0 → состояние + алерт с evidence про заморозку', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [frozenModem('imeiF', 'MD_F', 1e9, 5e8)] }],
      { download: '0.4', upload: '0.1', ping: '900' });
    const job = mkJob();

    await job.runOnce();   // базовая точка отсчёта
    await job.runOnce();   // дельта 0 — заморозка началась, окно ещё не вышло
    expect(probes.length).toBe(0);

    job._bwTrack.get('S1|imeiF').frozenSince = Date.now() - 21 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(1);
    expect(fired[0].payload.kind).toBe('throttled');
    expect(fired[0].payload.evidence).toContain('трафик заморожен');
  });

  it('трафик растёт → заморозки нет, проб нет', async () => {
    let bw = 1e9;
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [frozenModem('imeiF', 'MD_F', bw, 5e8)] }],
      { download: '0.4', upload: '0.1', ping: '900' });
    const job = mkJob();
    await job.runOnce();
    bw = 2e9;   // +1 ГБ — трафик идёт
    await job.runOnce();
    job._bwTrack.get('S1|imeiF').frozenSince = Date.now() - 60 * 60000;   // даже если бы окно было
    bw = 5e9;
    await job.runOnce();
    expect(probes.length).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(fired.length).toBe(0);
  });

  it('проба с нормальной скоростью → cleared + бэкофф 6ч от повторных кандидатов', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [frozenModem('imeiF', 'MD_F', 1e9, 5e8)] }],
      { download: '30', upload: '10', ping: '40' });
    const job = mkJob();
    await job.runOnce();
    await job.runOnce();
    job._bwTrack.get('S1|imeiF').frozenSince = Date.now() - 21 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(job._frozenClearedAt.has('S1|imeiF')).toBe(true);

    // Заморозка снова накопилась, но бэкофф — повторной пробы нет.
    job._bwTrack.get('S1|imeiF').frozenSince = Date.now() - 25 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(fired.length).toBe(0);
  });
});

// ── 2026-09-27 (v5.1): ложные срабатывания MD2_50-66. Moldtelecom/Orange MD —
// хронически медленные модемы (норма 1–2 Мбит, трафик 6–8 ГБ/сут), абсолютный
// порог 1 Мбит их флаганул. Фикс: allowlist операторов для троттлинг-сигнатур
// (дефолт Moldcell) + относительный порог восстановления от нормы модема.
describe('sim-exhaustion v5.1: allowlist операторов и относительное восстановление', () => {
  it('Moldtelecom не кандидатствует в троттлинг по замороженному трафику (дефолтный allowlist)', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [frozenModem('imeiT', 'MD2_55', 1e9, 5e8, 'unite')] }],
      { download: '0.5', upload: '0.2', ping: '900' });
    const job = mkJob();
    await job.runOnce();
    await job.runOnce();
    job._bwTrack.get('S1|imeiT').frozenSince = Date.now() - 60 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(0);   // даже пробы нет — оператор вне allowlist
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(fired.length).toBe(0);
  });

  it('allowlist расширяется настройкой: Moldtelecom флагается при включении', async () => {
    const { mkJob, fired, db, probes } = bootV4(
      () => [{ serverName: 'S1', status: [frozenModem('imeiT', 'MD2_55', 1e9, 5e8, 'unite')] }],
      { download: '0.5', upload: '0.2', ping: '900' },
      { sim_exhaustion_throttle_operators: 'moldcell, moldtelecom' });
    const job = mkJob();
    await job.runOnce();
    await job.runOnce();
    job._bwTrack.get('S1|imeiT').frozenSince = Date.now() - 60 * 60000;
    await job.runOnce();
    expect(probes.length).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired[0].payload.operator).toBe('Moldtelecom');
  });

  it('восстановление относительно нормы модема: медленный-by-design (норма ~1.3) восстанавливается на 1.6 Мбит', async () => {
    const { mkJob, fired, db } = bootV4(
      () => [{ serverName: 'S1', status: [healthyModem('imeiT', 'MD2_55', 'unite')] }],
      { download: '1.6', upload: '0.8', ping: '200' });
    // 14-дневная норма ~1.3 Мбит (медиана) — как у MD2_52 в проде.
    const ins = db.prepare("INSERT INTO speed_monitor (server, nick, download, ok) VALUES ('S1', 'MD2_55', ?, 1)");
    for (const d of [0.9, 1.1, 1.3, 1.3, 1.4, 1.5, 1.8]) ins.run(d);
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imeiT', 'MD2_55', 'Moldtelecom', ?, ?)")
      .run(Date.now() - 3600e3, Date.now() - 3500e3);

    const job = mkJob();
    await job.runOnce();   // проба: dl 1.6 ≥ max(1, min(5, 1.3*0.5)) = 1 → восстановлен
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
    expect(fired.length).toBe(1);
    expect(fired[0].rule).toBe('sim_package_recovered');
  });

  it('без истории замеров — абсолютный порог 5 Мбит (прежнее поведение)', async () => {
    const { mkJob, fired, db } = bootV4(
      () => [{ serverName: 'S1', status: [healthyModem('imeiM', 'MD_1')] }],
      { download: '1.6', upload: '0.8', ping: '200' });
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imeiM', 'MD_1', 'Moldcell', ?, ?)")
      .run(Date.now() - 3600e3, Date.now() - 3500e3);
    const job = mkJob();
    await job.runOnce();   // 1.6 < 5 и нормы нет → держим состояние
    expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
    expect(fired.length).toBe(0);
  });
});

// ── 2026-09-27: пробы идут через глобальный гейт спидтестов на бокс
// (src/jobs/speedtest-gate.js). Гейт занят (монитор/UI меряют) → проба
// трактуется как 'retry': замер бокса не вызывается, состояние держится,
// следующая проба по обычному кулдауну.
describe('sim-exhaustion: гейт спидтестов на бокс (2026-09-27)', () => {
  it('гейт занят → recovery-проба = retry (замера нет, состояние держим); освободился → обычная проба', async () => {
    const gate = require('../src/jobs/speedtest-gate.js');
    gate._reset();
    const { mkJob, fired, db, probes } = bootWithTable(
      () => [{ serverName: 'S1', status: [MODEM_OK_IMEI1] }],
      { speedtest_gate_wait_sec: 1 },
      { download: '25', upload: '10', ping: '48' });
    db.prepare("INSERT INTO sim_exhaustion_state (server_name, imei, nick, operator, since_ts, alerted_at) VALUES ('S1', 'imei1', 'MD_1', 'Moldcell', ?, ?)")
      .run(Date.now() - 3600e3, Date.now() - 3500e3);
    const held = [await gate.acquire('S1'), await gate.acquire('S1')];   // оба слота S1 заняты «снаружи»
    try {
      const job = mkJob();
      await job.runOnce();   // проба ждёт слот 1с → GATE_BUSY → retry
      expect(probes.length).toBe(0);   // fetchApi speedtest даже не вызывался
      expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(1);
      expect(fired.length).toBe(0);

      held.forEach(release => release());
      job._probes.set('S1|imei1', 0);   // кулдаун пробы снимаем
      await job.runOnce();
      expect(probes.length).toBe(1);
      expect(db.prepare('SELECT COUNT(*) c FROM sim_exhaustion_state').get().c).toBe(0);
      expect(fired.length).toBe(1);
      expect(fired[0].rule).toBe('sim_package_recovered');
    } finally {
      held.forEach(release => release());
      gate._reset();
    }
  });
});
