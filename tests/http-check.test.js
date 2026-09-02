// HttpCheck (A2, 23.08): HTTP-чек сайта через прокси-порт модема —
// scope, контент-проверки (заглушка оператора), стрики алертов, история.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const hcMod = require('../src/jobs/http-check.js');

let db, alertsFired, settings, fetchBehavior;
const API_SERVERS = [{ name: 'S1', url: 'http://10.0.0.1:7001', publicIp: '1.2.3.4' }];

function mk(overrides = {}) {
  alertsFired = [];
  settings = {
    httpcheck_enabled: true,
    httpcheck_url: 'https://example.com',
    httpcheck_must_contain: '',
    httpcheck_must_not_contain: '',
    httpcheck_scope: 'all',
    httpcheck_timeout_ms: 15000,
    speedtest_modems: 'MD2_39',
    ...overrides,
  };
  return hcMod.create({
    db,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
    getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
    apiServers: API_SERVERS,
    fetchAllServersDataCached: async () => [{
      serverName: 'S1',
      status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD2_39' }, net_details: { IS_ONLINE: 'yes' } }],
      ports: { imei1: [{ portID: 'portA', portName: 'client-a', HTTP_PORT: '8012', LOGIN: 'u', PASSWORD: 'p' }] },
    }],
    // Сеть не дёргаем: поведение чека управляет тест.
    fetchThroughProxy: async (proxy, url, timeout) => fetchBehavior(proxy, url, timeout),
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE modem_httpcheck (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, server TEXT NOT NULL, nick TEXT NOT NULL,
    status INTEGER, total_ms INTEGER, content_ok INTEGER, error TEXT
  )`);
  fetchBehavior = async () => ({ status: 200, totalMs: 300, body: '<html>Example Domain</html>' });
});

describe('http-check', () => {
  it('успешный чек пишется в историю, алертов нет', async () => {
    const job = mk();
    const res = await job.runOnce();
    expect(res).toMatchObject({ ok: 1, failed: 0 });
    const row = db.prepare('SELECT * FROM modem_httpcheck').get();
    expect(row).toMatchObject({ server: 'S1', nick: 'MD2_39', status: 200, error: '' });
    expect(alertsFired.length).toBe(0);
    expect(job.latest()['S1_MD2_39'].status).toBe(200);
  });

  it('3 подряд неудачи → modem_http_fail, затем recovered (дефолтный порог)', async () => {
    fetchBehavior = async () => { throw new Error('timeout'); };
    const job = mk();
    await job.runOnce();
    expect(alertsFired.length).toBe(0);          // первый фейл — только стрик
    expect(job.latest()['S1_MD2_39']).toMatchObject({ fail_streak: 1, failing: false });
    await job.runOnce();
    expect(alertsFired.length).toBe(0);          // второй — ещё рано (порог 3, v2.10.69)
    await job.runOnce();
    expect(alertsFired.map(a => a.rule)).toEqual(['modem_http_fail']);
    expect(job.latest()['S1_MD2_39']).toMatchObject({ fail_streak: 3, failing: true });
    await job.runOnce();
    expect(alertsFired.length).toBe(1);          // не дублируется
    fetchBehavior = async () => ({ status: 200, totalMs: 250, body: 'ok' });
    await job.runOnce();
    expect(alertsFired[1].rule).toBe('modem_http_recovered');
    expect(job.latest()['S1_MD2_39']).toMatchObject({ fail_streak: 0, failing: false });
  });

  it('порог настраивается: httpcheck_alert_threshold=1 → алерт на первой же неудаче', async () => {
    fetchBehavior = async () => { throw new Error('timeout'); };
    const job = mk({ httpcheck_alert_threshold: 1 });
    await job.runOnce();
    expect(alertsFired.map(a => a.rule)).toEqual(['modem_http_fail']);
  });

  it('must_not_contain ловит заглушку оператора', async () => {
    fetchBehavior = async () => ({ status: 200, totalMs: 100, body: '<html>Пополните баланс</html>' });
    const job = mk({ httpcheck_must_not_contain: 'Пополните баланс' });
    await job.runOnce();
    await job.runOnce();
    await job.runOnce();
    expect(alertsFired[0].rule).toBe('modem_http_fail');
    expect(alertsFired[0].payload.error).toContain('content_blocked');
    const row = db.prepare('SELECT * FROM modem_httpcheck ORDER BY id DESC').get();
    expect(row.content_ok).toBe(0);
  });

  it('status 502 — неудача без контент-проверки', async () => {
    fetchBehavior = async () => ({ status: 502, totalMs: 90, body: 'bad gateway' });
    const job = mk();
    await job.runOnce();
    const row = db.prepare('SELECT * FROM modem_httpcheck').get();
    expect(row.error).toBe('http_status_502');
    expect(row.content_ok).toBeNull();
  });

  it('выключен настройкой — skip', async () => {
    const job = mk({ httpcheck_enabled: false });
    const res = await job.runOnce();
    expect(res.skipped).toBe('disabled');
    expect(db.prepare('SELECT COUNT(*) c FROM modem_httpcheck').get().c).toBe(0);
  });

  it('legacy scope больше не ограничивает HTTP-проверку списком Speedtest', async () => {
    const job = mk({ speedtest_modems: 'OTHER_NICK' });
    const res = await job.runOnce();
    expect(res).toMatchObject({ total: 1, ok: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM modem_httpcheck').get().c).toBe(1);
  });

  it('пропускает невалидные реквизиты и выбирает действующий клиентский порт', async () => {
    mk(); // восстановить базовые настройки после кейса scope выше
    let usedProxy = null;
    const job = hcMod.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
      getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
      apiServers: API_SERVERS,
      fetchAllServersDataCached: async () => [{
        serverName: 'S1',
        status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD2_39' }, net_details: { IS_ONLINE: 'yes' } }],
        ports: { imei1: [
          { portName: 'expired-client', HTTP_PORT: '8011', LOGIN: 'bad', PASSWORD: 'bad', IS_EXPIRED: 'true' },
          { portName: 'randomport1', HTTP_PORT: '8012', LOGIN: 'bad2', PASSWORD: 'bad2' },
          { portName: 'live-client', HTTP_PORT: '8013', LOGIN: 'live', PASSWORD: 'secret', IS_EXPIRED: 'false', IS_OVER_QUOTA: 'false' },
        ] },
      }],
      fetchThroughProxy: async (proxy) => { usedProxy = proxy; return { status: 200, totalMs: 80, body: 'ok' }; },
    });
    const res = await job.runOnce();
    expect(res).toMatchObject({ ok: 1, failed: 0 });
    expect(usedProxy).toMatchObject({ port: 8013, login: 'live', password: 'secret' });
  });

  it('не делает HTTP-запрос без действующих клиентских реквизитов', async () => {
    mk();
    let fetches = 0;
    const job = hcMod.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
      getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
      apiServers: API_SERVERS,
      fetchAllServersDataCached: async () => [{
        serverName: 'S1',
        status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD2_39' }, net_details: { IS_ONLINE: 'yes' } }],
        ports: { imei1: [{ portName: 'client-a', HTTP_PORT: '8012', LOGIN: 'u', PASSWORD: 'p', IS_OVER_QUOTA: 'yes' }] },
      }],
      fetchThroughProxy: async () => { fetches++; return { status: 200, totalMs: 80, body: 'ok' }; },
    });
    const res = await job.runOnce();
    expect(res).toMatchObject({ ok: 0, failed: 0, skipped: 1 });
    expect(fetches).toBe(0);
    expect(job.latest()['S1_MD2_39'].error).toBe('no_valid_client_credentials');
    expect(alertsFired).toEqual([]);
  });

  it('оффлайн-модем пишет error=offline без алерта (территория modem_offline)', async () => {
    const job = mk();
    job._state.clear();
    // подменяем резолв: модем оффлайн
    const job2 = hcMod.create({
      db,
      logger: { info() {}, warn() {}, error() {} },
      alerts: { trigger: (rule, payload) => alertsFired.push({ rule, payload }) },
      getSetting: (k, dflt) => (k in settings ? settings[k] : dflt),
      apiServers: API_SERVERS,
      fetchAllServersDataCached: async () => [{
        serverName: 'S1',
        status: [{ modem_details: { IMEI: 'imei1', NICK: 'MD2_39' }, net_details: { IS_ONLINE: 'no' } }],
        ports: {},
      }],
      fetchThroughProxy: async () => ({ status: 200, totalMs: 100, body: '' }),
    });
    await job2.runOnce();
    await job2.runOnce();
    const row = db.prepare('SELECT * FROM modem_httpcheck ORDER BY id DESC').get();
    expect(row.error).toBe('offline');
    expect(alertsFired.length).toBe(0);
  });

  // Регрессия 24.08: обрыв CONNECT-туннеля посреди TLS-handshake раньше
  // стрелял 'error' на tlsSock ДО установки слушателя (он вешался внутри
  // secureConnect-колбэка) → uncaughtException → pm2-рестарт всего дашборда.
  // Теперь слушатели вешаются сразу — промис просто reject'ится.
  it('обрыв туннеля посреди TLS-handshake → reject, без uncaughtException', async () => {
    const http = require('http');
    const proxy = http.createServer();
    proxy.on('connect', (req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setImmediate(() => socket.destroy()); // рвём до завершения handshake
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const port = proxy.address().port;

    let uncaught = null;
    const onUncaught = (e) => { uncaught = e; };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(hcMod.fetchThroughProxy(
        { host: '127.0.0.1', port, login: 'u', password: 'p' },
        'https://example.com/', 5000
      )).rejects.toThrow();
      await new Promise(r => setImmediate(r)); // дать шанс всплыть uncaught
      expect(uncaught).toBeNull();
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      proxy.close();
    }
  });
});
