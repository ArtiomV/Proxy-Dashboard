'use strict';
//
// src/api/proxysmart-conf.js — доступ к /conf/* ProxySmart с обходом логин-стены.
//
// Зачем отдельный модуль: на части серверов (S2) /conf/* закрыт UI-сессией —
// basic-auth GET/POST получает 302 → /modem/login. Раньше дашборд этого не
// замечал, и это дало двойной баг «выключил, а оно ротируется»:
//   • refreshRotationCache парсил страницу логина как «поля AUTO_IP_ROTATION
//     нет → 0» → в UI у всех модемов S2 светилось «Выкл» при реально
//     включённой ротации;
//   • store_modem / bulk_rotation POST'или в логин-стену и отвечали ok:true —
//     «сохранено», хотя ProxySmart ничего не менял (302 → /modem/login
//     считался успехом, т.к. 302 → /conf — обычный успех у ProxySmart).
//
// Модуль логинится теми же creds (POST /modem/login, form username/password),
// кэширует cookie на сервер, ретраит запрос с cookie. Если и после логина
// стена — честный reason 'AUTH_WALLED' вместо молчаливого фейла. «Не смогли
// прочитать» НИКОГДА не превращается в значение 0 («Выкл»).

const http = require('http');
const https = require('https');

const LOGIN_TTL_MS = 10 * 60 * 1000;   // пере-логин не чаще, чем раз в 10 мин
let _logger = { info() {}, warn() {}, error() {}, debug() {} };
const _sessions = {};                  // serverName -> { cookie, at }

function init({ logger } = {}) { if (logger) _logger = logger; }

function _lib(url) { return url.protocol === 'https:' ? https : http; }

// Сырой запрос к ProxySmart (basic auth, опционально form-body и cookie).
// НЕ ходит по редиректам: 302 для нас — сигнал (логин-стена или успех POST).
function _raw(server, { method, path, formBody, cookie, timeout = 12000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, server.url);
    const auth = Buffer.from(`${server.user}:${server.pass}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    let body = null;
    if (formBody) {
      body = new URLSearchParams(formBody).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (cookie) headers.Cookie = cookie;
    const req = _lib(url).request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers, timeout,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (bytes <= 512 * 1024) chunks.push(c); });
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location || '',
        setCookie: res.headers['set-cookie'] || [],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout from ' + server.name)));
    if (body) req.write(body);
    req.end();
  });
}

// Логин-стена: редирект на /modem/login или страница логина в теле.
function _looksLikeLogin(res) {
  if (res.status === 302 && /\/modem\/login/.test(res.location)) return true;
  return /\/modem\/login/.test(res.body.slice(0, 600));
}

// Сессионная cookie для сервера (кэш 10 мин; force — перевойти).
async function _session(server, force) {
  const s = _sessions[server.name];
  if (!force && s && (Date.now() - s.at) < LOGIN_TTL_MS) return s.cookie;
  const res = await _raw(server, {
    method: 'POST', path: '/modem/login',
    formBody: { username: server.user, password: server.pass },
  });
  // Берём ВСЕ set-cookie пары (служебные вроде allowCGP=yes безобидны) —
  // выбор «первой» пары уже обжигался: сессионная cookie оказалась не первой.
  const pairs = (res.setCookie || [])
    .map(sc => String(sc).split(';')[0])
    .filter(p => p && p.includes('='));
  if (!pairs.length) throw new Error(`login не вернул cookie (HTTP ${res.status})`);
  _sessions[server.name] = { cookie: pairs.join('; '), at: Date.now() };
  return _sessions[server.name].cookie;
}

function _dropSession(server) { delete _sessions[server.name]; }

// GET /conf/... → { ok:true, fields, html, status } | { ok:false, reason, status }
// reason: 'AUTH_WALLED' | 'HTTP_<code>' | 'NO_FORM'
async function getConfForm(server, path) {
  let res = await _raw(server, { method: 'GET', path });
  for (let attempt = 0; attempt < 2 && _looksLikeLogin(res); attempt++) {
    let cookie;
    try { cookie = await _session(server, attempt > 0); }
    catch (e) {
      _logger.warn(`[ProxyConf] ${server.name}: login failed: ${e.message}`);
      return { ok: false, reason: 'AUTH_WALLED', status: res.status };
    }
    res = await _raw(server, { method: 'GET', path, cookie });
  }
  if (_looksLikeLogin(res)) {
    _dropSession(server);
    return { ok: false, reason: 'AUTH_WALLED', status: 302 };
  }
  if (res.status !== 200) return { ok: false, reason: 'HTTP_' + res.status, status: res.status };
  const fields = {};
  for (const m of res.body.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = m[2];
  if (!Object.keys(fields).length) return { ok: false, reason: 'NO_FORM', status: 200, html: res.body };
  return { ok: true, fields, html: res.body, status: 200 };
}

// POST /conf/... → { ok:true, status, location } | { ok:false, reason, status }
// 302 → /conf (или не на логин) у ProxySmart = успешное сохранение.
async function postConfForm(server, path, fields) {
  let res = await _raw(server, { method: 'POST', path, formBody: fields });
  for (let attempt = 0; attempt < 2 && _looksLikeLogin(res); attempt++) {
    let cookie;
    try { cookie = await _session(server, attempt > 0); }
    catch (e) {
      _logger.warn(`[ProxyConf] ${server.name}: login failed: ${e.message}`);
      return { ok: false, reason: 'AUTH_WALLED', status: res.status };
    }
    res = await _raw(server, { method: 'POST', path, formBody: fields, cookie });
  }
  if (_looksLikeLogin(res)) {
    _dropSession(server);
    return { ok: false, reason: 'AUTH_WALLED', status: 302 };
  }
  if (res.status >= 400) return { ok: false, reason: 'HTTP_' + res.status, status: res.status };
  return { ok: true, status: res.status, location: res.location };
}

// AUTO_IP_ROTATION из HTML формы: число минут; ПУСТОЕ value → 0 (выкл);
// поле отсутствует → null (НЕИЗВЕСТНО — никогда не подменять нулём).
function parseRotation(html) {
  const m = String(html || '').match(/AUTO_IP_ROTATION[^>]*value="(\d*)"/);
  if (!m) return null;
  return m[1] === '' ? 0 : parseInt(m[1], 10);
}

module.exports = { init, getConfForm, postConfForm, parseRotation, _dropSession, _sessions };
