// ServerMetrics (загрузка серверов на дашборде):
//   • parseSshMetrics — stdout одной SSH-команды (cpu/load/free/df/uptime/temp)
//   • parseSystemStatus — HTML /system_status (время, live stats, mongo, usb)
//   • runServerMetrics — SSH недоступен → fallback на HTTP-панель, source='http'
//   • GET /api/admin/server_metrics — последняя строка по серверу + age_sec

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { bootApp } from './_helpers/app.js';

const cjsRequire = createRequire(import.meta.url);

let db, serverMetrics;
beforeAll(() => {
  db = bootApp().db;
  serverMetrics = cjsRequire('../src/jobs/server-metrics.js');
  db.prepare('DELETE FROM server_metrics').run();
});

// Реалистичный stdout SSH-команды (секции разделены '---').
const SSH_OUT = [
  'cpu  1000 0 500 8000 200 0 50 0 0 0',
  'cpu  1010 0 510 8060 210 0 50 0 0 0',   // dTotal=90, dIdle=70 → 22.2%
  '---',
  '1.25 0.90 0.60 3/456 12345',
  '---',
  '              total        used        free      shared  buff/cache   available',
  'Mem:           1836        1200         100          24         536         612',
  'Swap:           512         128         384',
  '---',
  'Filesystem     1M-blocks   Used Available Use% Mounted on',
  '/dev/sda1        120000  80000     40000  67% /',
  '---',
  '123456.78 987654.32',
  '---',
  '55000',
  '42000',
  'Package id 0:  +55.5°C  (high = +80.0°C, crit = +100.0°C)',
  '---',
  '84',   // ss established — fallback панельных «connections»
  '1',    // pgrep mongod — fallback mongo_ok
].join('\n');

describe('ServerMetrics: parseSshMetrics', () => {
  const { parseSshMetrics } = cjsRequire('../src/jobs/server-metrics.js');

  it('полный вывод: cpu/load/mem/swap/disk/uptime/temp', () => {
    const m = parseSshMetrics(SSH_OUT);
    // dTotal=90, dIdle(idle+iowait)=70 → (90-70)/90 = 22.2%
    expect(m.cpu_pct).toBe(22.2);
    expect(m.load1).toBe(1.25);
    expect(m.load5).toBe(0.9);
    expect(m.load15).toBe(0.6);
    // mem: (1836-612)/1836 = 66.7%
    expect(m.mem_used_pct).toBe(66.7);
    expect(m.mem_total_mb).toBe(1836);
    expect(m.mem_used_mb).toBe(1224);   // 1836 − 612 (available)
    expect(m.swap_used_pct).toBe(25);
    expect(m.disk_used_pct).toBe(67);
    expect(m.disk_total_mb).toBe(120000);
    expect(m.disk_used_mb).toBe(80000);
    expect(m.uptime_sec).toBe(123457);
    // sensors приоритетнее термозон (55.5 > 55.0)
    expect(m.temp_c).toBe(55.5);
    // секция 6: SSH-fallback панельных метрик
    expect(m.conns).toBe(84);
    expect(m.mongo_ok).toBe(1);
  });

  it('без sensors температура берётся из термозон (/1000)', () => {
    const m = parseSshMetrics(SSH_OUT.replace(/Package[^\n]+/, ''));
    expect(m.temp_c).toBe(55);
  });

  it('мусор/пустота → null-поля, без исключений', () => {
    const m = parseSshMetrics('garbage');
    expect(m.cpu_pct).toBeNull();
    expect(m.load1).toBeNull();
    expect(m.mem_used_pct).toBeNull();
    expect(m.disk_used_pct).toBeNull();
    expect(m.uptime_sec).toBeNull();
    expect(m.temp_c).toBeNull();
    expect(parseSshMetrics('')).toMatchObject({ load1: null, temp_c: null });
  });

  it('Swap: 0 total → swap_used_pct = 0, отсутствие строки → null', () => {
    const noSwap = SSH_OUT.replace(/^Swap:.*$/m, 'Swap:              0           0           0');
    expect(parseSshMetrics(noSwap).swap_used_pct).toBe(0);
    const absent = SSH_OUT.replace(/^Swap:.*$/m, '');
    expect(parseSshMetrics(absent).swap_used_pct).toBeNull();
  });
});

// Фрагмент /system_status (реальная структура панели).
const STATUS_HTML = `
<h3>System Time</h3>
<p>2026-08-20 10:49:50 EEST</p>
<h3>Live stats</h3>
<span style="font-size: 120%; "> 93 </span> connections
<span style="font-size: 120%; "> 1.2   </span> requests/second
<h3>MongoDB status</h3>
<p><font color=green>OK</font></p>
<details><summary><h3>USB errors</h3></summary>
<i> Critical USB errors:</i>
<pre style="color:red">modem MD_04: reset loop
modem MD_10: no SIM
</pre>
</details>`;

describe('ServerMetrics: parseSystemStatus', () => {
  const { parseSystemStatus } = cjsRequire('../src/jobs/server-metrics.js');
  // nowMs подобран так, чтобы дрейф был ровно +10с (EEST = UTC+3).
  const NOW_MS = Date.UTC(2026, 7, 20, 7, 49, 40);   // 10:49:40 EEST

  it('время бокса, live stats, mongo, usb-ошибки', () => {
    const m = parseSystemStatus(STATUS_HTML, NOW_MS);
    expect(m.box_time_drift_sec).toBe(10);
    expect(m.conns).toBe(93);
    expect(m.rps).toBe(1.2);
    expect(m.mongo_ok).toBe(1);
    expect(m.usb_errors).toMatch(/^2: modem MD_04: reset loop$/);
  });

  it('пустой pre = нет usb-ошибок; без секции mongo — mongo_ok null', () => {
    const clean = STATUS_HTML
      .replace(/<pre[^>]*>[\s\S]*?<\/pre>/, '<pre style="color:red"></pre>')
      .replace(/<h3>MongoDB status<\/h3>[\s\S]*?<\/p>/, '');
    const m = parseSystemStatus(clean, NOW_MS);
    expect(m.usb_errors).toBe('');
    expect(m.mongo_ok).toBeNull();
  });

  it('пустой/битый html → нейтральный объект, без исключений', () => {
    const m = parseSystemStatus('', NOW_MS);
    expect(m).toEqual({ conns: null, rps: null, mongo_ok: null, usb_errors: '', box_time_drift_sec: null });
  });
});

describe('ServerMetrics: runServerMetrics (fallback на HTTP)', () => {
  it('SSH недоступен → строка с source=http и HTTP-полями', async () => {
    db.prepare('DELETE FROM server_metrics').run();
    const job = serverMetrics.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      apiServers: [{ name: 'S9', url: 'http://box', user: 'u', pass: 'p', osLogin: 'root', osPassword: 'x', publicIp: '1.2.3.4' }],
      // sshpass падает на обоих портах (файрвол бокса)
      execFile: (cmd, args, opts, cb) => cb(new Error('Connection timed out')),
      proxyConf: { getPage: async () => ({ ok: true, html: STATUS_HTML, status: 200 }) },
    });
    const r = await job.runServerMetrics();
    expect(r).toMatchObject({ partial: 1, failed: 0 });
    const row = db.prepare('SELECT * FROM server_metrics WHERE server_name = ?').get('S9');
    expect(row.source).toBe('http');
    expect(row.cpu_pct).toBeNull();
    expect(row.conns).toBe(93);
    expect(row.rps).toBe(1.2);
    expect(row.mongo_ok).toBe(1);
    expect(row.usb_errors).toMatch(/^2: /);
    expect(row.error).toBe('');
  });

  it('sshPort из конфига сервера идёт первым (mon@ на нестандартном порту)', async () => {
    db.prepare('DELETE FROM server_metrics').run();
    const ports = [];
    const job = serverMetrics.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      apiServers: [{ name: 'S11', url: 'http://box', user: 'u', pass: 'p', osLogin: 'mon', publicIp: '1.2.3.4', sshPort: 6001 }],
      execFile: (cmd, args, opts, cb) => { ports.push(Number(args[args.indexOf('-p') + 1])); cb(new Error('Connection timed out')); },
      proxyConf: { getPage: async () => ({ ok: true, html: STATUS_HTML, status: 200 }) },
    });
    await job.runServerMetrics();
    expect(ports[0]).toBe(6001);          // сначала кастомный порт
    expect(ports).toContain(2222);        // затем дефолтные
    expect(ports.filter(p => p === 6001)).toHaveLength(1);  // без дублей
  });

  it('панель виснет → conns/mongo из SSH-fallback секции (source=ssh)', async () => {
    db.prepare('DELETE FROM server_metrics').run();
    const job = serverMetrics.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      apiServers: [{ name: 'S12', url: 'http://box', user: 'u', pass: 'p', osLogin: 'mon', publicIp: '1.2.3.4', sshPort: 6001 }],
      execFile: (cmd, args, opts, cb) => cb(null, SSH_OUT),
      proxyConf: { getPage: async () => ({ ok: false, reason: 'TIMEOUT', status: 0 }) },
    });
    const r = await job.runServerMetrics();
    expect(r).toMatchObject({ ok: 1 });
    const row = db.prepare('SELECT * FROM server_metrics WHERE server_name = ?').get('S12');
    expect(row.source).toBe('ssh');
    expect(row.cpu_pct).toBe(22.2);
    expect(row.conns).toBe(84);
    expect(row.mongo_ok).toBe(1);
  });

  it('панель отвечает → её conns приоритетнее SSH-fallback', async () => {
    db.prepare('DELETE FROM server_metrics').run();
    const job = serverMetrics.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      apiServers: [{ name: 'S13', url: 'http://box', user: 'u', pass: 'p', osLogin: 'mon', publicIp: '1.2.3.4' }],
      execFile: (cmd, args, opts, cb) => cb(null, SSH_OUT),
      proxyConf: { getPage: async () => ({ ok: true, html: STATUS_HTML, status: 200 }) },
    });
    await job.runServerMetrics();
    const row = db.prepare('SELECT * FROM server_metrics WHERE server_name = ?').get('S13');
    expect(row.source).toBe('mixed');
    expect(row.conns).toBe(93);        // из панели, не 84 из SSH
    expect(row.usb_errors).toMatch(/^2: /);   // есть только у панели
  });

  it('недоступны оба источника → строка с error, без ssh-кредов SSH не зовём', async () => {
    db.prepare('DELETE FROM server_metrics').run();
    let sshCalls = 0;
    const job = serverMetrics.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      apiServers: [{ name: 'S10', url: 'http://box', user: 'u', pass: 'p' }],   // нет osLogin/osPassword
      execFile: (cmd, args, opts, cb) => { sshCalls++; cb(new Error('should not be called')); },
      proxyConf: { getPage: async () => ({ ok: false, reason: 'HTTP_502', status: 502 }) },
    });
    const r = await job.runServerMetrics();
    expect(sshCalls).toBe(0);
    expect(r).toMatchObject({ failed: 1 });
    const row = db.prepare('SELECT * FROM server_metrics WHERE server_name = ?').get('S10');
    expect(row.source).toBe('');
    expect(row.error).toMatch(/unreachable/);
  });
});

describe('ServerMetrics: GET /api/admin/server_metrics', () => {
  it('последняя строка по серверу + age_sec; сервер без данных → null', async () => {
    const { asAdmin } = await import('./_helpers/app.js');
    const request = (await import('supertest')).default;
    const { app } = bootApp();
    const token = asAdmin();
    db.prepare('DELETE FROM server_metrics').run();
    db.prepare('DELETE FROM server_downtime').run();
    const ins = db.prepare(`INSERT INTO server_metrics
      (server_name, collected_at, source, cpu_pct, load1, mem_used_pct, conns, rps)
      VALUES (?, ?, 'mixed', ?, 1.2, ?, 93, 1.2)`);
    ins.run('S1', new Date(Date.now() - 25 * 3600e3).toISOString(), 99, 99); // за пределами 24ч (id ниже — вставлена первой)
    ins.run('S1', new Date(Date.now() - 3600e3).toISOString(), 10, 50);   // в пределах 24ч
    ins.run('S1', new Date(Date.now() - 60e3).toISOString(), 30, 66.7);   // свежая
    db.prepare('UPDATE server_metrics SET usb_errors = ? WHERE id = (SELECT MAX(id) FROM server_metrics WHERE server_name = ?)')
      .run('8: Bluetooth: HCI socket layer initialized', 'S1');
    const down = db.prepare(`INSERT INTO server_downtime
      (server_name, down_from, down_to, duration_sec, alerted) VALUES (?, ?, ?, ?, 0)`);
    down.run('S1', new Date(Date.now() - 3 * 3600e3).toISOString(), new Date(Date.now() - 2.9 * 3600e3).toISOString(), 360);
    down.run('S1', new Date(Date.now() - 2 * 3600e3).toISOString(), new Date(Date.now() - 1.75 * 3600e3).toISOString(), 900);
    down.run('S1', new Date(Date.now() - 30 * 3600e3).toISOString(), new Date(Date.now() - 29 * 3600e3).toISOString(), 3600); // вне окна

    const res = await request(app).get('/api/admin/server_metrics').set('X-Auth-Token', token);
    expect(res.status).toBe(200);
    const m = res.body.metrics.S1;
    expect(m).toBeTruthy();
    expect(m.cpu_pct).toBe(30);
    expect(m.age_sec).toBeGreaterThanOrEqual(55);
    expect(m.age_sec).toBeLessThan(3600);   // выбрана свежая строка, не часовой давности
    // среднее за 24ч: только две свежие строки (99%-ная старше суток не считается)
    expect(m.avg24).toMatchObject({ cpu_pct: 20, conns: 93, samples: 2 });
    expect(Math.abs(m.avg24.mem_used_pct - 58.4)).toBeLessThan(0.1);
    // спарклайны: только точки за 24ч, в хронологическом порядке
    expect(m.series24.cpu).toEqual([10, 30]);
    expect(m.series24.mem).toEqual([50, 66.7]);
    expect(m.series24.conns).toEqual([93, 93]);
    expect(m.series24.ts).toHaveLength(2);   // метки времени для ховер-тултипа
    expect(m.downtime24).toMatchObject({ episodes: 2, duration_sec: 1260 });
    expect(m.downtime24.events).toHaveLength(2);
    expect(m.latest_event).toMatchObject({ source: 'USB 8', message: 'Bluetooth: HCI socket layer initialized' });
    expect(res.body.generated_at).toBeTruthy();
    expect(res.body.addresses).toBeTruthy();
  });
});
