'use strict';
//
// src/events.js — SSE (ТЗ мониторинга v2, этап 5, 23.08): внутрипроцессная
// шина realtime-событий админки. Джобы публикуют через publish(type, data)
// (fire-and-forget: без подписчиков — дешёвый no-op, падать не может),
// роут GET /api/admin/events подписывает SSE-клиентов через subscribe().
//
//   - троттлинг: не чаще 1 события каждого типа в THROTTLE_MS на клиента;
//     промежуточные публикации коалесцируются — выигрывает последнее значение;
//   - heartbeat ':ping' каждые HEARTBEAT_MS (держим соединение сквозь Nginx);
//   - лимит MAX_PER_SESSION одновременных SSE-клиентов на admin-сессию;
//   - closeAll() шлёт событие 'bye' и закрывает потоки — graceful shutdown
//     при pm2 restart (фронт переподключается сам, с backoff).

function create(opts) {
  opts = opts || {};
  const HEARTBEAT_MS = opts.heartbeatMs || 25000;
  const THROTTLE_MS = opts.throttleMs != null ? opts.throttleMs : 2000;
  const MAX_PER_SESSION = opts.maxPerSession || 10;
  const logger = opts.logger || null;

  // client: { res, sessionId, lastSent: Map(type→ms), pending: Map(type→data), timer, backedUp, missed }
  const clients = new Set();

  // DEEP-32 (2026-09-24): backpressure. res.write() === false → клиент не
  // успевает; дальше только коалесцируем в pending и считаем пропущенные.
  // За пределом MAX_MISSED медленный подписчик отключается, а не накапливает
  // буфер процесса. drain возвращает клиента в прямой режим.
  const MAX_MISSED = 100;

  function _write(client, chunk) {
    if (client.backedUp) return false;
    const ok = client.res.write(chunk);
    if (ok === false) {
      client.backedUp = true;
      client.res.once('drain', () => { client.backedUp = false; });
    }
    return true;
  }

  function _send(client, type, data) {
    let payload;
    try { payload = JSON.stringify(data == null ? {} : data); }
    catch (_) { payload = '{}'; }   // несериализуемый payload не должен ронять джобу
    if (!_write(client, 'event: ' + type + '\ndata: ' + payload + '\n\n')) {
      client.missed = (client.missed || 0) + 1;
      if (client.missed > MAX_MISSED) { _drop(client, 'slow_consumer'); return false; }
    }
    client.lastSent.set(type, Date.now());
    return true;
  }

  function _drop(client, reason) {
    if (!clients.has(client)) return;
    clients.delete(client);
    if (client.timer) { clearTimeout(client.timer); client.timer = null; }
    try { client.res.end(); } catch (_) { /* сокет уже мёртв */ }
    if (logger && reason) logger.info('[SSE] client dropped: ' + reason);
  }

  // Отправка отложенных (коалесцированных) событий, чей троттлинг уже истёк;
  // остальные ждут следующего таймера.
  function _flush(client) {
    client.timer = null;
    if (client.backedUp) return;   // DEEP-32: ждём drain, не доливаем в полный буфер
    const now = Date.now();
    let nextDue = Infinity;
    for (const [type, data] of client.pending) {
      const due = (client.lastSent.get(type) || 0) + THROTTLE_MS;
      if (due <= now) {
        client.pending.delete(type);
        try { _send(client, type, data); } catch (e) { _drop(client, 'write: ' + e.message); return; }
      } else if (due < nextDue) nextDue = due;
    }
    if (client.pending.size && nextDue < Infinity) {
      client.timer = setTimeout(() => _flush(client), nextDue - Date.now() + 5);
      if (client.timer.unref) client.timer.unref();
    }
  }

  // Fire-and-forget для джоб: без подписчиков — мгновенный выход.
  function publish(type, data) {
    if (!clients.size) return;
    const now = Date.now();
    for (const client of [...clients]) {
      try {
        if (client.backedUp) {
          // DEEP-32: буфер клиента полон — не пишем вовсе, только
          // коалесцируем; за пределом MAX_MISSED отключаем медленного
          // подписчика (дренажа нет, память процесса не растёт).
          client.pending.set(type, data);
          client.missed = (client.missed || 0) + 1;
          if (client.missed > MAX_MISSED) { _drop(client, 'slow_consumer'); continue; }
          if (!client.timer) {
            client.timer = setTimeout(() => _flush(client), THROTTLE_MS + 5);
            if (client.timer.unref) client.timer.unref();
          }
          continue;
        }
        const last = client.lastSent.get(type) || 0;
        if (now - last >= THROTTLE_MS) {
          // DEEP-30 (2026-09-24): перед прямой отправкой сносим старый pending
          // этого типа — иначе отложенное УСТАРЕВШЕЕ значение уезжало после
          // свежего (версии 1,2,3 доставлялись как 1,3,2).
          client.pending.delete(type);
          _send(client, type, data);
        } else {
          // Окно троттлинга: коалесцируем — последнее значение типа выигрывает.
          client.pending.set(type, data);
          if (!client.timer) {
            client.timer = setTimeout(() => _flush(client), THROTTLE_MS - (now - last) + 5);
            if (client.timer.unref) client.timer.unref();
          }
        }
      } catch (e) { _drop(client, 'write: ' + e.message); }
    }
  }

  // Подписка SSE-ответа. false = лимит на сессию исчерпан (роут отвечает 429).
  // Отписка — по 'close' сокета (клиент ушёл / вкладка закрыта).
  function subscribe(res, sessionId, login) {
    let perSession = 0;
    for (const c of clients) if (c.sessionId === sessionId) perSession++;
    if (perSession >= MAX_PER_SESSION) return false;
    const client = { res, sessionId, login: login || '', lastSent: new Map(), pending: new Map(), timer: null };
    clients.add(client);
    res.on('close', () => _drop(client));
    return true;
  }

  // heartbeat-комментарий: Nginx/прокси не режут соединение по idle-таймауту.
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (client.backedUp) continue;   // DEEP-32: не доливаем в переполненный буфер
      try { client.res.write(':ping\n\n'); } catch (e) { _drop(client, 'heartbeat: ' + e.message); }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  // DEEP-32 (2026-09-24): отзыв/expiry сессии закрывает её SSE-потоки.
  // Раньше авторизация проверялась только при подключении — logout не
  // закрывал уже открытый поток, он жил до закрытия вкладки.
  // Ключ — token-hash (точная сессия) ИЛИ login (все сессии пользователя).
  function closeSession(sessionId, reason) {
    for (const client of [...clients]) {
      if (client.sessionId !== sessionId && client.login !== sessionId) continue;
      try { client.res.write('event: bye\ndata: {"reason":"' + (reason || 'session_revoked') + '"}\n\n'); } catch (_) { /* best-effort */ }
      _drop(client);
    }
  }

  // Graceful shutdown (pm2 restart): 'bye' → фронт закрывает поток и
  // переподключается с backoff, не спамя реконнектами в мёртвый процесс.
  function closeAll() {
    clearInterval(heartbeat);
    for (const client of [...clients]) {
      try { client.res.write('event: bye\ndata: {"reason":"shutdown"}\n\n'); } catch (_) { /* best-effort */ }
      _drop(client);
    }
  }

  function clientCount() { return clients.size; }

  return { publish, subscribe, closeAll, closeSession, clientCount };
}

module.exports = { create };
