'use strict';
// src/jobs/http-check.js — A2 (ТЗ мониторинга v2, 23.08): HTTP-чек сайта
// через прокси-порт модема — проверка «глазами клиента»: открывается ли сайт,
// нет ли редиректа-заглушки оператора («пополните баланс») / фильтрации.
//
// Механика: для каждого ника из scope HTTP GET `httpcheck_url` через
// прокси-порт (хост = publicIp сервера, креды порта из list_ports_json).
// Проверки: status 200–399, опционально тело содержит httpcheck_must_contain
// и НЕ содержит httpcheck_must_not_contain. https-цели идут через CONNECT.
//
// Охват — весь парк. Реальный запрос выполняется только через действующие
// клиентские реквизиты; свободные/просроченные порты получают понятный skip.
// Сеть защищена ограниченной параллельностью.
//
// Алерты: httpcheck_alert_threshold (дефолт 3, Настройки → Уведомления) подряд
// неудачи → modem_http_fail (important, с причиной);
// восстановление → modem_ping_recovered-аналог modem_http_recovered.
// Стрики в памяти — рестарт просто перезапускает стрик (как modem-ping).
//
// Тесты подсовывают deps.fetchThroughProxy и deps.fetchAllServersDataCached —
// сеть не дёргаем.

const http = require('http');
const tls = require('tls');
const { pickValidClientHttpPort } = require('../utils/proxy-port');

const MAX_BODY = 512 * 1024;   // must-contain проверяем по первым 512 КБ

// Минимальный HTTP(S) GET через HTTP-прокси с Basic-авторизацией.
// Возвращает { status, totalMs, body } либо бросает Error.
function fetchThroughProxy(proxy, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return reject(new Error('unsupported_protocol'));
    const auth = (proxy.login && proxy.password)
      ? 'Basic ' + Buffer.from(proxy.login + ':' + proxy.password).toString('base64') : null;
    const resources = new Set();
    let settled = false;
    // One deadline includes TCP, CONNECT, TLS and body, even if bytes keep arriving.
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    function finish(error, status, body) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const resource of resources) resource.destroy();
      if (error) reject(error);
      else resolve({ status, totalMs: Date.now() - started, body: body.toString('utf8') });
    }
    function track(resource) {
      resources.add(resource);
      resource.on('error', error => finish(error));
      return resource;
    }
    const collect = res => {
      track(res);
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        const remaining = MAX_BODY - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(remaining, chunk.length);
        // Content checks intentionally inspect only the first MAX_BODY bytes.
        if (bytes >= MAX_BODY) finish(null, res.statusCode || 0, Buffer.concat(chunks));
      });
      res.on('end', () => finish(null, res.statusCode || 0, Buffer.concat(chunks)));
      res.on('aborted', () => finish(new Error('response_aborted')));
      res.on('close', () => {
        if (!res.complete) finish(new Error('response_aborted'));
      });
    };
    const headers = { Host: target.host, 'User-Agent': 'Mozilla/5.0 (httpcheck)',
      Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close' };
    if (target.protocol === 'http:') {
      track(http.request({ hostname: proxy.host, port: proxy.port, method: 'GET',
        path: targetUrl, agent: false,
        headers: { ...headers, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      }, collect)).end();
      return;
    }
    const authority = target.hostname + ':' + (target.port || '443');
    const connReq = track(http.request({
      hostname: proxy.host, port: proxy.port, method: 'CONNECT', path: authority,
      agent: false,
      headers: { Host: authority, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
    }));
    connReq.on('connect', (res, socket, head) => {
      track(socket);
      if (settled) { socket.destroy(); return; }
      if (res.statusCode !== 200) return finish(new Error('CONNECT status ' + res.statusCode));
      if (head.length) socket.unshift(head);
      const tlsSock = track(tls.connect({ socket, servername: target.hostname,
        rejectUnauthorized: true }, () => {
        if (settled) return;
        // Let Node parse framing/chunked encoding for HTTPS just as for HTTP.
        const agent = new http.Agent({ keepAlive: false });
        resources.add(agent);
        agent.createConnection = () => tlsSock;
        track(http.request({ hostname: target.hostname, port: target.port || 443,
          method: 'GET', path: target.pathname + target.search, headers, agent,
        }, collect)).end();
      }));
      tlsSock.on('close', () => {
        if (!settled) finish(new Error('tunnel_closed'));
      });
    });
    connReq.end();
  });
}

function create(deps) {
  const { db, logger, alerts, getSetting, fetchAllServersDataCached, apiServers, events } = deps;   // events — SSE (23.08): httpcheck_result после прогона
  const _fetch = deps.fetchThroughProxy || fetchThroughProxy;
  const _insert = db.prepare(
    'INSERT INTO modem_httpcheck (ts, server, nick, status, total_ms, content_ok, error) VALUES (?,?,?,?,?,?,?)'
  );

  // key `${server}_${nick}` → { failStreak, failing, last: {status,total_ms,content_ok,error,ts} }
  const state = new Map();

  function _settings() {
    return {
      enabled: getSetting('httpcheck_enabled', true),
      url: String(getSetting('httpcheck_url', 'https://example.com') || '').trim(),
      mustContain: String(getSetting('httpcheck_must_contain', '') || '').trim(),
      mustNotContain: String(getSetting('httpcheck_must_not_contain', '') || '').trim(),
      timeoutMs: Math.max(3000, parseInt(getSetting('httpcheck_timeout_ms', 15000)) || 15000),
      concurrency: Math.max(1, Math.min(20, parseInt(getSetting('httpcheck_concurrency', 8)) || 8)),
      // v2.10.69: порог TG-алерта modem_http_fail — N ПОДРЯД неудачных чеков
      // (раньше было зашито 2). Раздел «Уведомления» → «Пороги доступности».
      alertThreshold: Math.max(1, Math.min(20, parseInt(getSetting('httpcheck_alert_threshold', 3)) || 3)),
    };
  }

  // Резолв всех модемов: ник → { server, nick, proxy:{host,port,login,password} }.
  async function _resolveTargets() {
    const allData = await fetchAllServersDataCached();
    const hostByServer = {};
    for (const s of (apiServers || [])) hostByServer[s.name] = s.publicIp || new URL(s.url).hostname;

    const targets = [];
    for (const data of allData) {
      const srv = data.serverName;
      const host = hostByServer[srv];
      if (!host) continue;
      const portsMap = data.ports || {};
      for (const m of (Array.isArray(data.status) ? data.status : [])) {
        const md = m.modem_details || {};
        const nd = m.net_details || {};
        const nick = md.NICK;
        if (!nick || /^random/i.test(nick)) continue;
        if (!m.net_details || m.net_details.IS_ONLINE !== 'yes') {
          targets.push({ server: srv, nick, offline: true });
          continue;
        }
        const port = pickValidClientHttpPort(portsMap[md.IMEI]);
        if (!port) { targets.push({ server: srv, nick, unavailable: true }); continue; }
        targets.push({
          server: srv, nick, imei: md.IMEI || '', operator: nd.CELLOP || '',
          clients: port.portName ? [String(port.portName)] : [],
          proxy: { host, port: parseInt(port.HTTP_PORT, 10), login: port.LOGIN || '', password: port.PASSWORD || '' },
        });
      }
    }
    return targets;
  }

  let running = false;

  async function runOnce() {
    const cfg = _settings();
    if (!cfg.enabled) return { skipped: 'disabled' };
    if (!cfg.url) return { skipped: 'no_url' };
    if (running) return { skipped: 'already_running' };
    running = true;
    try {
      const targets = await _resolveTargets();
      const tsIso = new Date().toISOString();
      let ok = 0, failed = 0, skipped = 0;
      async function checkTarget(t) {
        const key = t.server + '_' + t.nick;
        let st = state.get(key);
        if (!st) { st = { failStreak: 0, failing: false, last: null }; state.set(key, st); }

        let status = null, totalMs = null, contentOk = null, error = '';
        if (t.offline) {
          error = 'offline';
        } else if (t.unavailable) {
          error = 'no_valid_client_credentials';
        } else {
          try {
            const r = await _fetch(t.proxy, cfg.url, cfg.timeoutMs);
            status = r.status; totalMs = r.totalMs;
            if (!(status >= 200 && status < 400)) {
              error = 'http_status_' + status;
            } else {
              const body = r.body || '';
              if (cfg.mustNotContain && body.includes(cfg.mustNotContain)) {
                contentOk = 0;
                error = 'content_blocked (возможен редирект оператора)';
              } else if (cfg.mustContain && !body.includes(cfg.mustContain)) {
                contentOk = 0;
                error = 'content_mismatch';
              } else if (cfg.mustContain || cfg.mustNotContain) {
                contentOk = 1;
              }
            }
          } catch (e) {
            error = String(e.message || e).slice(0, 200);
          }
        }

        try { _insert.run(tsIso, t.server, t.nick, status, totalMs, contentOk, error); }
        catch (e) { logger.warn('[HttpCheck] insert failed: ' + e.message); }
        st.last = { status, total_ms: totalMs, content_ok: contentOk, error, ts: tsIso, offline: !!t.offline };

        const isSkipped = !!(t.offline || t.unavailable);
        const good = !error;
        if (isSkipped) {
          skipped++;
          // Без валидного маршрута проверки это не HTTP-сбой. Не создаём
          // ложный красный статус и recovery без фактического успешного чека.
          st.failStreak = 0;
          st.failing = false;
        } else if (good) {
          ok++;
          if (st.failing) { st.failing = false; alerts.trigger('modem_http_recovered', { server: t.server, nick: t.nick, imei: t.imei, operator: t.operator, clients: t.clients, ms: totalMs }); }
          st.failStreak = 0;
        } else {
          failed++;
          st.failStreak++;
          // Оффлайн-модем — территория modem_offline-алертов, не дублируем.
          if (!t.offline && !t.unavailable && st.failStreak >= cfg.alertThreshold && !st.failing) {
            st.failing = true;
            alerts.trigger('modem_http_fail', { server: t.server, nick: t.nick, imei: t.imei, operator: t.operator, clients: t.clients, error, status, url: cfg.url });
          }
        }
      }
      for (let i = 0; i < targets.length; i += cfg.concurrency) {
        await Promise.all(targets.slice(i, i + cfg.concurrency).map(checkTarget));
      }
      logger.info(`[HttpCheck] ${ok} ok, ${failed} failed, ${skipped} skipped of ${targets.length}`);
      // SSE (23.08): свежие HTTP-чеки → realtime-обновление колонки в админке.
      if (events) { try { events.publish('httpcheck_result', { ok, failed, skipped, total: targets.length }); } catch (_) { /* best-effort */ } }
      return { ok, failed, skipped, total: targets.length };
    } finally {
      running = false;
    }
  }

  // Снимок для UI: { 'S1_MD2_39': { status, total_ms, content_ok, error, ts } }
  function latest() {
    const out = {};
    for (const [k, st] of state) {
      if (st.last) out[k] = { ...st.last, fail_streak: st.failStreak, failing: st.failing };
    }
    return out;
  }

  return { runOnce, latest, _state: state };
}

module.exports = { create, fetchThroughProxy };
