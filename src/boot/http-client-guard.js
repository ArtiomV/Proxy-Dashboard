'use strict';
//
// src/boot/http-client-guard.js — страж исходящих HTTP-сокетов.
//
// 13.10.2026 процесс дважды падал (02:27 и 07:47 UTC) на внутреннем ассерте
// Node: ERR_INTERNAL_ASSERTION в _http_client socketOnData —
// assert(parser && parser.socket === socket). Данные пришли в клиентский
// сокет, чей HTTP-парсер уже освобождён или отдан другому сокету из пула.
// Оба раза — посреди прогона http-check (проверки через прокси модемов);
// стенд с «плохим» прокси на Node 22.23.3 причину не воспроизвёл.
//
// Что делает страж:
//   1. Каждому клиентскому сокету помечает «чей он» (метод, хост:порт, путь
//      без query) — первым 'data'-листенером запоминает последний сокет,
//      получивший данные. Если ассерт сработает, в журнале будет конкретный
//      запрос, а не безымянный стек Node.
//   2. handleUncaught(err): именно этот ассерт — не повод перезапускать
//      весь процесс. Он бросается ДО разбора данных (состояние парсера не
//      тронуто); сломанный сокет закрываем, чужой парсер от него отвязываем
//      (иначе socketCloseListener освободит парсер соседнего запроса), а
//      владелец-запрос получает обычный обрыв соединения.

const dc = require('diagnostics_channel');

let _last = null;            // { socket, info, at }
let _installed = false;
const _marked = new WeakSet();

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
    if (_marked.has(socket)) return;
    _marked.add(socket);
    socket.prependListener('data', function guardMark() {
      _last = { socket: this, at: Date.now() };
    });
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

// true — исключение обработано, процесс продолжает работу.
function handleUncaught(err, log) {
  if (!isParserAssert(err)) return false;
  const last = _last;
  _last = null;
  let info = 'unknown socket';
  if (last && last.socket) {
    const s = last.socket;
    const req = s.__guardReq || s._httpMessage;
    info = req ? _describe(req) : `${s.remoteAddress || '?'}:${s.remotePort || '?'}`;
    const parserState = !s.parser ? 'parser=null'
      : (s.parser.socket === s ? 'parser=own' : 'parser=foreign');
    info += ` (${parserState}, data ${Date.now() - last.at}ms ago)`;
    try { if (s.parser && s.parser.socket !== s) s.parser = null; } catch (_) { /* best-effort */ }
    try { s.destroy(); } catch (_) { /* best-effort */ }
  }
  try { if (log) log(info); } catch (_) { /* best-effort */ }
  return true;
}

module.exports = { install, handleUncaught, isParserAssert, _peekLast: () => _last };
