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
