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
const { pickValidClientHttpPort, isValidClientHttpPort } = require('../utils/proxy-port');

const MAX_BODY = 512 * 1024;   // must-contain проверяем по первым 512 КБ

// Минимальный HTTP(S) GET через HTTP-прокси с Basic-авторизацией.
// 08.10: живость цели НАПРЯМУЮ (без прокси) — гейт для http_fail.
// Если httpcheck_url недоступна с самого сервера — падения через модемы не
// их вина (лежит сайт/геоблок), и алерты по всему парку — ложная тревога.
// Одна проверка на тик, кэшируется.
function _fetchDirect(url, timeoutMs) {
  return new Promise((resolve) => {
    let mod;
    try { mod = url.startsWith('https:') ? require('https') : require('http'); }
    catch (_) { return resolve({ ok: false, error: 'bad url' }); }
    const started = Date.now();
    let req;
    try {
      req = mod.get(url, { timeout: timeoutMs, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => { if (Buffer.concat(chunks).length < MAX_BODY) chunks.push(c); });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), totalMs: Date.now() - started }));
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// 08.10: подхват ротаций — «модем сменил IP в последние 2 минуты». Живой
// источник — ip_history (пишется в момент смены IP нашим tracking'ом), а не
// rotation_log (синкается с боксов с задержкой в минуты). Ключ = server_imei.
let _recentRotCache = null, _recentRotAt = 0;
function _recentlyRotatedSet(db) {
  if (_recentRotCache && Date.now() - _recentRotAt < 30000) return _recentRotCache;
  let set = new Set();
  try {
    // 09.10: started_at хранится в ISO с 'T'/'Z' (JS toISOString), а
    // datetime('now') отдаёт формат с пробелом — строковое сравнение 'T' > ' '
    // делало ВСЕ сегодняшние строки «свежими», и каждый модем круглые сутки
    // считался «только что ротированным». Сравниваем с ISO из JS.
    const sinceIso = new Date(Date.now() - 2 * 60000).toISOString();
    for (const r of db.prepare('SELECT key FROM ip_history WHERE started_at >= ?').all(sinceIso)) set.add(r.key);
  } catch (_) { /* нет таблицы на минимальной схеме */ }
  _recentRotCache = set; _recentRotAt = Date.now();
  return set;
}
function _recentlyRotated(db, srv, imei) {
  return _recentlyRotatedSet(db).has(srv + '_' + imei);
}
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
    function finish(error, status, body, location) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const resource of resources) resource.destroy();
      if (error) reject(error);
      else resolve({ status, totalMs: Date.now() - started, body: body.toString('utf8'), location: location || '' });
    }
    function track(resource) {
      resources.add(resource);
      resource.on('error', error => finish(error));
      return resource;
    }
    const collect = res => {
      track(res);
      // DEEP-34 (2026-09-24): location отдаём наверх — job следует за
      // редиректом через тот же прокси в общем deadline и проверяет
      // КОНЕЧНЫЙ ответ (302 на заглушку оператора больше не «успех»).
      const location = res.headers && res.headers.location ? String(res.headers.location) : '';
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        const remaining = MAX_BODY - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(remaining, chunk.length);
        // Content checks intentionally inspect only the first MAX_BODY bytes.
        if (bytes >= MAX_BODY) finish(null, res.statusCode || 0, Buffer.concat(chunks), location);
      });
      res.on('end', () => finish(null, res.statusCode || 0, Buffer.concat(chunks), location));
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
  const knownModems = deps.knownModems || {};   // DEEP-33: roster- binding nick→portId
  const _fetch = deps.fetchThroughProxy || fetchThroughProxy;
  const _insert = db.prepare(
    'INSERT INTO modem_httpcheck (ts, server, nick, status, total_ms, content_ok, error, port_id, route_reason) VALUES (?,?,?,?,?,?,?,?,?)'
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
      // DEEP-33 (2026-09-24): IMEI НЕ уникален (клоны на S4) — порт для чека
      // выбираем по подтверждённой roster-связи nick→portId, а не «первый
      // валидный порт IMEI». Один порт проверяется ОДИН раз: второй ник,
      // разрешившийся в тот же portId, получает явный ambiguous, а не
      // «независимую проверку» через чужой маршрут.
      const rosterPortByNick = {};
      for (const [pid, info] of Object.entries(knownModems[srv] || {})) {
        if (info && info.nick && !rosterPortByNick[info.nick]) rosterPortByNick[info.nick] = pid;
      }
      const claimedPort = {};   // portId → nick (первый claimant побеждает)
      for (const m of (Array.isArray(data.status) ? data.status : [])) {
        const md = m.modem_details || {};
        const nd = m.net_details || {};
        const nick = md.NICK;
        if (!nick || /^random/i.test(nick)) continue;
        if (!m.net_details || m.net_details.IS_ONLINE !== 'yes') {
          targets.push({ server: srv, nick, offline: true });
          continue;
        }
        // 08.10: модем в ротации (IS_ROTATED) — чек пропускаем. В окне
        // смены IP (13–20 сек) 3proxy отвечает CONNECT 403 — это не поломка,
        // а штатная фаза; чек, попавший в ротацию, рисовал ложный кластер
        // «403 по всему оператору» (кейс MD_71/73/74).
        if (m.IS_ROTATED === 'true' || m.IS_ROTATED === true) {
          targets.push({ server: srv, nick, rotating: true });
          continue;
        }
        // Подхват ротаций: IS_ROTATED снимается с окончанием, а listener
        // 3proxy перебиндивается ещё ~30–60 сек — чек в этом хвосте ловил
        // ECONNREFUSED (кейс MD2_43: фейл через 46 сек после конца ротации).
        if (_recentlyRotated(db, srv, md.IMEI || '')) {
          targets.push({ server: srv, nick, rotating: true });
          continue;
        }
        const candidates = portsMap[md.IMEI] || [];
        let port = null, routeReason = '';
        const rosterPid = rosterPortByNick[nick];
        if (rosterPid) {
          const bound = candidates.find(p => p && p.portID === rosterPid);
          if (bound && isValidClientHttpPort(bound)) { port = bound; routeReason = 'roster'; }
        }
        if (!port) {
          port = pickValidClientHttpPort(candidates);
          routeReason = port ? 'first_valid' : '';
        }
        if (!port) { targets.push({ server: srv, nick, unavailable: true }); continue; }
        const prevClaimant = claimedPort[port.portID];
        if (prevClaimant && prevClaimant !== nick) {
          targets.push({ server: srv, nick, imei: md.IMEI || '', ambiguous: true, portId: port.portID });
          continue;
        }
        claimedPort[port.portID] = nick;
        targets.push({
          server: srv, nick, imei: md.IMEI || '', operator: nd.CELLOP || '',
          clients: port.portName ? [String(port.portName)] : [],
          portId: port.portID, routeReason,
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
      const tickState = { targetAlive: null };   // 08.10: кэш живости цели на тик
      let ok = 0, failed = 0, skipped = 0;
      async function checkTarget(t) {
        const key = t.server + '_' + t.nick;
        let st = state.get(key);
        if (!st) { st = { failStreak: 0, failing: false, last: null }; state.set(key, st); }

        let status = null, totalMs = null, contentOk = null, error = '';
        if (t.offline) {
          error = 'offline';
        } else if (t.rotating) {
          error = 'rotating';
        } else if (t.unavailable) {
          error = 'no_valid_client_credentials';
        } else if (t.ambiguous) {
          // DEEP-33: ник разрешился в порт, уже проверенный под другим ником
          // (клон IMEI). Результат одного маршрута не выдаём за независимую
          // проверку второго модема — явный маркер вместо чужого статуса.
          error = 'ambiguous_clone_imei';
        } else {
          try {
            // DEEP-34 (2026-09-24): следуем за HTTP(S)-редиректами через тот
            // же прокси в ОБЩЕМ deadline (макс 3 перехода) и проверяем конечный
            // ответ. 302 на заглушку оператора («пополните баланс») или
            // недоступный адрес больше не засчитывается как успешный чек;
            // обычный редирект на рабочий сайт — не поломка модема.
            const MAX_REDIRECTS = 3;
            const deadline = Date.now() + cfg.timeoutMs;
            const seenUrls = new Set();
            let url = cfg.url, redirects = 0, finalOrigin = '';
            let r = null;
            for (;;) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) { error = 'timeout'; break; }
              r = await _fetch(t.proxy, url, remaining);
              status = r.status; totalMs = Date.now() - (deadline - cfg.timeoutMs);
              if (status >= 300 && status < 400 && r.location) {
                let next;
                try { next = new URL(r.location, url); }
                catch (_) { error = 'redirect_unverified (bad location)'; break; }
                if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                  error = 'redirect_unverified (' + next.protocol.replace(':', '') + ')';
                  break;
                }
                if (seenUrls.has(next.href) || redirects >= MAX_REDIRECTS) {
                  error = 'redirect_cycle (→ ' + next.origin + ')';
                  break;
                }
                seenUrls.add(next.href);
                url = next.href; finalOrigin = next.origin; redirects++;
                continue;
              }
              break;   // финальный ответ (или редирект без location — принимаем как финальный)
            }
            if (!error) {
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
            }
            if (error && redirects > 0 && finalOrigin) error += ' (после редиректа → ' + finalOrigin + ')';
          } catch (e) {
            error = String(e.message || e).slice(0, 200);
          }
          // 08.10: CONNECT 403 при свежих кредах — это чаще ACL порта на цель
          // (deny-list клиента: MD2_40/46 блокируют example.com), чем поломка
          // модема. Контрольная цель (нейтральный ipify) через тот же прокси:
          // ответила — порт жив, цель заблокирована конфигом; не ответила —
          // реальный сбой.
          if (error === 'CONNECT status 403') {
            try {
              const fb = await _fetch(t.proxy, 'https://api.ipify.org', Math.max(5000, cfg.timeoutMs / 2));
              if (fb && fb.status >= 200 && fb.status < 400) {
                error = '';            // порт жив — это ACL на цель, не сбой
                status = fb.status;
                totalMs = fb.totalMs;
                contentOk = null;
              }
            } catch (_) { /* остаётся 403 — реальный сбой */ }
          }
        }

        try { _insert.run(tsIso, t.server, t.nick, status, totalMs, contentOk, error, t.portId || '', t.routeReason || (t.ambiguous ? 'ambiguous_clone_imei' : '')); }
        catch (e) { logger.warn('[HttpCheck] insert failed: ' + e.message); }
        st.last = { status, total_ms: totalMs, content_ok: contentOk, error, ts: tsIso, offline: !!t.offline };

        const isSkipped = !!(t.offline || t.rotating || t.unavailable || t.ambiguous);
        const good = !error;
        if (isSkipped) {
          skipped++;
          // Без валидного маршрута проверки это не HTTP-сбой. Не создаём
          // ложный красный статус и recovery без фактического успешного чека.
          st.failStreak = 0;
          st.failing = false;
        } else if (good) {
          ok++;
          // DEEP-75: успешный чек — тоже свежее подтверждение здоровья для
          // согласования сохранённых инцидентов (см. reconcile в incidents).
          if (alerts.reconcileIncidents) {
            try { alerts.reconcileIncidents([{ server: t.server, imei: t.imei, nick: t.nick, online: true }]); } catch (_) {}
          }
          if (st.failing) { st.failing = false; alerts.trigger('modem_http_recovered', { server: t.server, nick: t.nick, imei: t.imei, operator: t.operator, clients: t.clients, ms: totalMs }); }
          st.failStreak = 0;
        } else {
          failed++;
          st.failStreak++;
          // Оффлайн-модем — территория modem_offline-алертов, не дублируем.
          // DEEP-77: failing выставляем только при ПРИНЯТОМ trigger —
          // отклонённая попытка повторяется на следующих чеках, а не сгорает.
          if (!t.offline && !t.unavailable && st.failStreak >= cfg.alertThreshold && !st.failing) {
            // 08.10: алерт только если цель жива НАПРЯМУЮ (кэш на тик).
            // Упавший сайт ≠ больные модемы — иначе один мёртвый URL
            // поднимал тревогу по всему парку разом.
            if (tickState.targetAlive === null) {
              try {
                const d = await _fetchDirect(cfg.url, Math.max(5000, cfg.timeoutMs / 2));
                const contentOk = d.ok && (d.status >= 200 && d.status < 400)
                  && (!cfg.mustContain || (d.body || '').includes(cfg.mustContain))
                  && (!cfg.mustNotContain || !(d.body || '').includes(cfg.mustNotContain));
                tickState.targetAlive = !!contentOk;
                if (!tickState.targetAlive) {
                  logger.warn(`[HttpCheck] цель ${cfg.url} недоступна напрямую (${d.ok ? d.status : d.error}) — http_fail по парку подавлен`);
                  logActivity('system', 'warn', 'httpcheck_target_down', cfg.url,
                    `Цель недоступна напрямую: ${d.ok ? 'HTTP ' + d.status : d.error}`, {});
                }
              } catch (e) {
                tickState.targetAlive = true;   // ошибка самой проверки — не глушим
              }
            }
            if (!tickState.targetAlive) {
              // цель лежит — не инкриминируем «модем сбой», стрик просто
              // заморожен (когда сайт оживёт, стрик продолжит честно)
            } else if (alerts.trigger('modem_http_fail', { server: t.server, nick: t.nick, imei: t.imei, operator: t.operator, clients: t.clients, error, status, url: cfg.url })) {
              st.failing = true;
            }
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

module.exports = { create, fetchThroughProxy, _clearRecentRotCache: () => { _recentRotCache = null; _recentRotAt = 0; } };
