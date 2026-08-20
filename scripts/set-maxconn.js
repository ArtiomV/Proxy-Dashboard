#!/usr/bin/env node
'use strict';
//
// scripts/set-maxconn.js — массовая установка MAXCONN на всех портах всех боксов.
//
// Зачем: MAXCONN — лимит одновременных коннектов 3proxy на порт. Меняем
// централизованно тем же путём, что админка (save_port_config,
// src/routes/proxies-ports.js): GET формы /conf/edit_port → merge → POST →
// apply_port → verify re-read (ProxySmart применяет конфиг не мгновенно).
//
// Запуск (на проде, из корня репо):
//   node scripts/set-maxconn.js                  # выставить 600 на всех портах
//   node scripts/set-maxconn.js --value 800      # другое значение
//   node scripts/set-maxconn.js --dry-run        # только показать текущие значения
//   node scripts/set-maxconn.js --server S4      # один бокс
//   node scripts/set-maxconn.js --db /path/dashboard.db
//
// Серверы и креды читает из kv_store.api_servers (та же merged-запись, что
// использует дашборд). Exit code 1, если были порты с ошибкой.

const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
}
const DRY = args.includes('--dry-run');
const VALUE = String(parseInt(argVal('value', '600'), 10));
const ONLY_SERVER = argVal('server', null);
const DB_PATH = argVal('db', process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'dashboard.db'));

if (!/^\d+$/.test(VALUE)) { console.error('--value должен быть целым числом'); process.exit(2); }

const Database = require('better-sqlite3');
const proxyConf = require('../src/api/proxysmart-conf');
const { parseHtmlInputFields } = require('../src/utils/html-forms');

proxyConf.init({ logger: { info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a), debug() {} } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Источник серверов: --servers-json '[{"name":"S4","url":"http://127.0.0.1:8084","user":"ops","pass":"..."}]'
// (обход БД — для запуска через ssh-туннели), иначе kv_store.api_servers.
function loadServers() {
  const raw = argVal('servers-json', process.env.SERVERS_JSON || '');
  if (raw) return JSON.parse(raw);
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT value FROM kv_store WHERE key='api_servers'").get();
  db.close();
  if (!row) { console.error('kv_store.api_servers пуст — нечего опрашивать'); process.exit(2); }
  return JSON.parse(row.value);
}

// GET /apix/* с basic-auth (на /apix логин-стены нет — ходит fetchApi дашборда).
function apiGet(server, apiPath, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: 'GET',
      headers: { Authorization: `Basic ${auth}` }, timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (_) { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function listPorts(server) {
  const data = await apiGet(server, '/apix/list_ports_json');
  const out = [];
  for (const [owner, plist] of Object.entries(data || {})) {
    if (!Array.isArray(plist)) continue;
    for (const p of plist) {
      if (p && p.portID) out.push({ portID: String(p.portID), password: p.PASSWORD || '', owner });
    }
  }
  return out;
}

// Имя поля в форме: на форме edit_port встречается MAXCONN (админка) — но на
// всякий случай поддерживаем и lowercase-вариант (retail-путь пишет maxconn).
function pickFieldName(fields) {
  if ('MAXCONN' in fields) return 'MAXCONN';
  if ('maxconn' in fields) return 'maxconn';
  return null;
}

async function processPort(server, port) {
  const formPath = `/conf/edit_port/${port.portID}`;
  const form = await proxyConf.getConfForm(server, formPath);
  if (!form.ok) return { status: 'fail', reason: `форма не отдалась (${form.reason})` };
  const fields = parseHtmlInputFields(form.html);
  const fname = pickFieldName(fields);
  if (!fname) return { status: 'fail', reason: 'в форме нет поля MAXCONN' };
  const current = fields[fname];
  if (current === VALUE) return { status: 'already' };
  if (DRY) return { status: 'dry', current };
  // proxy_password в HTML-форме пуст — восстанавливаем из list_ports_json,
  // иначе POST затрёт пароль (та же ловушка, что в save_port_config).
  if (!fields.proxy_password && port.password) fields.proxy_password = port.password;
  fields[fname] = VALUE;
  const posted = await proxyConf.postConfForm(server, formPath, fields);
  if (!posted.ok) return { status: 'fail', reason: `не сохранил (${posted.reason})`, current };
  try { await apiGet(server, `/apix/apply_port?arg=${encodeURIComponent(port.portID)}`); }
  catch (e) { return { status: 'fail', reason: `apply_port: ${e.message}`, current }; }
  // Verify-after-write: ProxySmart применяет не мгновенно — перечитываем.
  for (let i = 0; i < 3; i++) {
    await sleep(1500);
    const back = await proxyConf.getConfForm(server, formPath);
    if (back.ok) {
      const v = parseHtmlInputFields(back.html)[fname];
      if (v === VALUE) return { status: 'ok', was: current };
    }
  }
  return { status: 'fail', reason: 'verify не подтвердил', current };
}

(async () => {
  let servers = loadServers();
  if (ONLY_SERVER) servers = servers.filter(s => s.name === ONLY_SERVER);
  if (!servers.length) { console.error('Нет серверов под фильтр'); process.exit(2); }

  console.log(`MAXCONN=${VALUE}${DRY ? ' (dry-run)' : ''}; серверы: ${servers.map(s => s.name).join(', ')}`);
  const totals = { ok: 0, already: 0, dry: 0, fail: 0 };
  const failures = [];

  for (const server of servers) {
    let ports;
    try { ports = await listPorts(server); }
    catch (e) {
      console.error(`[${server.name}] list_ports_json failed: ${e.message}`);
      failures.push(`${server.name}: list_ports_json ${e.message}`);
      continue;
    }
    console.log(`\n[${server.name}] портов: ${ports.length}`);
    const dist = {};
    for (const port of ports) {
      let r;
      try { r = await processPort(server, port); }
      catch (e) { r = { status: 'fail', reason: e.message }; }
      totals[r.status] = (totals[r.status] || 0) + 1;
      if (r.status === 'fail') {
        failures.push(`${server.name}/${port.portID}: ${r.reason}`);
        console.log(`  ${port.portID}: FAIL — ${r.reason}`);
      } else if (r.status === 'dry') {
        dist[r.current === '' ? '(пусто)' : r.current] = (dist[r.current === '' ? '(пусто)' : r.current] || 0) + 1;
        console.log(`  ${port.portID}: ${r.current === '' ? '(пусто)' : r.current} → ${VALUE}`);
      } else if (r.status === 'ok') {
        console.log(`  ${port.portID}: ${r.was === '' ? '(пусто)' : r.was} → ${VALUE} ok`);
      }
      if (!DRY && r.status !== 'already') await sleep(120); // не дDoSим панель
    }
    if (DRY) console.log(`  распределение текущих значений: ${JSON.stringify(dist)}`);
  }

  console.log(`\nИтого: ok=${totals.ok || 0} already=${totals.already || 0}${DRY ? ` dry=${totals.dry || 0}` : ''} fail=${totals.fail || 0}`);
  if (failures.length) {
    console.error('Ошибки:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
