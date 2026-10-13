'use strict';
//
// src/boot/http-client-guard.js — страж исходящих HTTP-сокетов.
//
// 13.10.2026 процесс дважды падал (02:27 и 07:47 UTC) на внутреннем ассерте
// Node: ERR_INTERNAL_ASSERTION в _http_client socketOnData —
// assert(parser && parser.socket === socket). Данные пришли в клиентский
// сокет, чей HTTP-парсер уже освобождён или отдан другому сокету из пула.
// Оба раза — посреди прогона http-check (проверки через прокси модемов).
//
// Страж ПАССИВЕН: на сокеты не вешается ни одного слушателя данных (первая
// версия вешала 'data'-слушатель и ломала длинные HTTPS-ответы — «Premature
// close» у запросов к API Anthropic; убрано в тот же день). Он только ведёт
// реестр живых клиентских сокетов (снимается по 'close'). Когда ассерт всё же
// сработал, в uncaughtException:
//   • в реестре ищутся сокеты с нарушенной связью парсера (parser отсутствует
//     или принадлежит другому сокету) — виновник и есть такой сокет;
//   • такие сокеты закрываются, чужой парсер от них отвязывается;
//   • в журнал пишется запрос виновника (метод, хост:порт, путь без query);
//   • процесс продолжает работу.

const dc = require('diagnostics_channel');

const _live = new Set();
let _installed = false;

function _describe(req) {
  try {
    const path = String(req.path || '').split('?')[0].slice(0, 120);
    return `${req.method || '?'} ${req.host || '?'}:${(req.socket && req.socket.remotePort) || ''}${path}`;
  } catch (_) { return '?'; }
}

function _onCreated({ request }) {
  if (!request || typeof request.once !== 'function') return;
  request.once('socket', (socket) => {
    if (!socket) return;
    socket.__guardReq = request;
    if (_live.has(socket)) return;
    _live.add(socket);
    socket.once('close', () => _live.delete(socket));
  });
}

function install() {
  if (_installed) return;
  _installed = true;
  dc.subscribe('http.client.request.created', _onCreated);
}

function isParserAssert(err) {
  return !!(err && err.code === 'ERR_INTERNAL_ASSERTION'
    && /socketOnData/.test(String(err.stack || '')));
}

function _broken(s) {
  if (!s || s.destroyed) return false;
  if (!s._httpMessage) return false;                      // сокет не занят запросом
  return !s.parser || s.parser.socket !== s;
}

// true — исключение обработано, процесс продолжает работу.
function handleUncaught(err, log) {
  if (!isParserAssert(err)) return false;
  const culprits = [..._live].filter(_broken);
  const infos = [];
  for (const s of culprits) {
    const req = s.__guardReq || s._httpMessage;
    const state = !s.parser ? 'parser=null' : 'parser=foreign';
    infos.push((req ? _describe(req) : `${s.remoteAddress || '?'}:${s.remotePort || '?'}`) + ` (${state})`);
    try { if (s.parser && s.parser.socket !== s) s.parser = null; } catch (_) { /* best-effort */ }
    try { s.destroy(); } catch (_) { /* best-effort */ }
  }
  try { if (log) log(infos.length ? infos.join('; ') : 'виновный сокет не найден'); } catch (_) { /* best-effort */ }
  return true;
}

module.exports = { install, handleUncaught, isParserAssert, _liveCount: () => _live.size };
