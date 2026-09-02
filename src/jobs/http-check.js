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
    const auth = (proxy.login && proxy.password)
      ? 'Basic ' + Buffer.from(proxy.login + ':' + proxy.password).toString('base64') : null;

    const finish = (status, bodyBuf) => resolve({ status, totalMs: Date.now() - started, body: bodyBuf.toString('utf8') });

    const collect = (res, sock) => {
      const chunks = []; let bytes = 0;
      res.on('data', c => { bytes += c.length; if (bytes <= MAX_BODY) chunks.push(c); if (bytes > MAX_BODY) { res.destroy(); } });
      res.on('end', () => finish(res.statusCode || 0, Buffer.concat(chunks)));
      res.on('close', () => finish(res.statusCode || 0, Buffer.concat(chunks)));
      res.on('error', reject);
      if (sock) sock.on('error', reject);
    };

    if (target.protocol === 'http:') {
      // Обычный absolute-URI GET через прокси (как checkOneProxy).
      const req = http.request({
        hostname: proxy.host, port: proxy.port, method: 'GET',
        path: targetUrl,
        headers: { Host: target.host, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
        timeout: timeoutMs,
      }, res => collect(res));
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
      return;
    }

    // https — CONNECT-туннель, затем TLS поверх него.
    const connReq = http.request({
      hostname: proxy.host, port: proxy.port, method: 'CONNECT',
      path: target.hostname + ':443',
      headers: { Host: target.hostname + ':443', ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      timeout: timeoutMs,
    });
    connReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error('CONNECT status ' + res.statusCode));
      }
      const tlsSock = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
        const reqStr = `GET ${target.pathname || '/'}${target.search || ''} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: Mozilla/5.0 (httpcheck)\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
        tlsSock.write(reqStr);
        let buf = Buffer.alloc(0);
        tlsSock.on('data', c => {
          buf = Buffer.concat([buf, c]);
          if (buf.length > MAX_BODY) tlsSock.destroy();
        });
        tlsSock.on('end', () => {
          const headEnd = buf.indexOf('\r\n\r\n');
          const head = headEnd >= 0 ? buf.slice(0, headEnd).toString('latin1') : '';
          const status = parseInt((head.match(/^HTTP\/\d\.\d (\d+)/) || [])[1] || '0', 10);
          // chunked-декод не делаем: для must-contain достаточно сырого тела
          // (ключевые фразы заглушек видны и в chunked-потоке).
          finish(status, headEnd >= 0 ? buf.slice(headEnd + 4) : buf);
        });
      });
      // 24.08: error/timeout вешаем СРАЗУ, а не внутри secureConnect-колбэка.
      // Раньше при обрыве туннеля посреди TLS-handshake 'error' стрелял до
      // появления слушателя → uncaughtException → рестарт всего дашборда
      // (4 краша за 23–24.08 по этой причине).
      tlsSock.on('error', reject);
      tlsSock.on('timeout', () => { tlsSock.destroy(); reject(new Error('timeout')); });
    });
    connReq.on('error', reject);
    connReq.on('timeout', () => { connReq.destroy(); reject(new Error('timeout')); });
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
