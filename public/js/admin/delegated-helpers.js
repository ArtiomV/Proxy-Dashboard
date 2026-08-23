'use strict';
//
// public/js/admin/delegated-helpers.js — именованные хелперы для сайтов,
// которые не выражаются безопасной грамматикой delegation.js (Stage 5 ph.2 /
// Stage 11). Всё — обычные глобальные функции; вызываются через
// data-on-click="helperName(arg1, this)".

// 💾 Скачать выгрузку прокси из окна экспорта (состояние — window._aeState).
function aeDownload() {
  var st = window._aeState || {};
  var r = aeBuildExport(st.proxies || [], st);
  var b = new Blob([r.lines.join('\n') + (r.lines.length ? '\n' : '')], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = 'proxies' + (r.selected !== '*' ? '_' + r.selected : '') + '_' + r.proto + '.txt';
  a.click();
}

// ─── Окно экспорта прокси из админки (bulkExport) ────────────────────────────
// Окно живёт через delegation.js (только глобальные функции), поэтому вся
// логика — здесь. Состояние окна: window._aeState = {proxies, proto, client}.
//
// Чистая часть (покрыта node-тестами): группировка портов по клиентам
// (клиент = portName порта; безымянные — группа '') и сборка строк выгрузки
// с учётом выбранного клиента и протокола.
function aeBuildExport(proxies, state) {
  state = state || {};
  var groups = {}, order = [];
  proxies.forEach(function (p) {
    var c = p.portName || '';
    if (!groups[c]) { groups[c] = 0; order.push(c); }
    groups[c]++;
  });
  order.sort(function (a, b) {
    if (groups[b] !== groups[a]) return groups[b] - groups[a];   // по убыванию числа портов
    if (!a !== !b) return !a ? 1 : -1;                           // «без клиента» — последней
    return a < b ? -1 : 1;
  });
  var clients = order.map(function (c) { return { name: c, count: groups[c] }; });
  var sel = (state.client === undefined || state.client === null) ? '*' : state.client;
  if (sel !== '*' && !groups[sel]) sel = '*';          // выбранный клиент исчез — назад к «все»
  var proto = state.proto === 'socks5' ? 'socks5' : 'http';
  var lines = [];
  proxies.forEach(function (p) {
    if (sel !== '*' && (p.portName || '') !== sel) return;
    var port = proto === 'http' ? p.http : p.socks;
    if (!port) return;                                  // у части портов нет socks-пары
    lines.push(p.login + ':' + p.pass + '@' + p.host + ':' + port);
  });
  return { clients: clients, selected: sel, proto: proto, lines: lines };
}

function aeOpen(proxies) {
  window._aeState = { proxies: proxies, proto: 'http', client: '*' };
  var old = document.getElementById('aeOverlay');
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = 'aeOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  aeRender();
}

function _aeBtn(action, arg, label, active) {
  return '<button style="padding:4px 12px;font-size:11px;cursor:pointer;border:none;'
    + (active ? 'background:var(--accent);color:#fff' : 'background:var(--bg-2);color:var(--text-1)')
    + '" data-on-click="' + action + '(\'' + String(arg).replace(/'/g, "\\'") + '\')">' + esc(label) + '</button>';
}

function aeRender() {
  var st = window._aeState;
  var overlay = document.getElementById('aeOverlay');
  if (!st || !overlay) return;
  var r = aeBuildExport(st.proxies, st);
  // Переключатель клиентов — только когда среди выгружаемых портов их ≥2
  // (модем может нести порты разных клиентов, раньше выгружались все скопом).
  var clientRow = '';
  if (r.clients.length > 1) {
    clientRow = '<div style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex-wrap:wrap">'
      + _aeBtn('aeSetClient', '*', 'Все (' + st.proxies.length + ')', r.selected === '*')
      + r.clients.map(function (c) {
          return _aeBtn('aeSetClient', c.name, (c.name || '(без клиента)') + ' (' + c.count + ')', r.selected === c.name);
        }).join('')
      + '</div>';
  }
  var content = '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;width:min(640px,100%);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.5)" data-on-click="event.stopPropagation()">'
    + '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">'
    + '<div><span style="font-size:16px">'+icon('upload',16)+'</span> <strong style="font-size:14px">Экспорт прокси</strong> <span style="color:var(--text-2);font-size:12px">' + r.lines.length + ' шт.</span></div>'
    + '<button data-on-click="this.closest(\'#aeOverlay\').remove()" style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--text-1);font-size:13px;display:flex;align-items:center;justify-content:center">'+icon('x',13)+'</button>'
    + '</div>'
    + '<div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<div style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden">'
    + _aeBtn('aeSetProto', 'http', 'HTTP', r.proto === 'http')
    + _aeBtn('aeSetProto', 'socks5', 'SOCKS5', r.proto === 'socks5')
    + '</div>'
    + clientRow
    + '<span style="font-size:11px;color:var(--text-2)">Формат: login:pass@host:port</span>'
    + '</div>'
    + '<div style="padding:12px 20px;flex:1;overflow:auto"><textarea id="aeText" style="width:100%;height:300px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-0);resize:vertical" readonly>' + esc(r.lines.join('\n')) + '</textarea></div>'
    + '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'
    + '<button class="btn btn-sm" data-on-click="copyText(document.getElementById(\'aeText\').value,this)">'+icon('copy',12)+' Скопировать</button>'
    + '<button class="btn btn-primary btn-sm" data-on-click="aeDownload()">'+icon('save',12)+' Скачать .txt</button>'
    + '</div></div>';
  overlay.innerHTML = content;
}

function aeSetClient(c) {
  var st = window._aeState;
  if (!st) return;
  st.client = (c === undefined || c === null) ? '*' : c;
  aeRender();
}

function aeSetProto(p) {
  var st = window._aeState;
  if (!st) return;
  st.proto = p === 'socks5' ? 'socks5' : 'http';
  aeRender();
}

// Открыть модем по нику из карты currentData._modemMap в модалке деталей
// (бывшая IIFE из карточки «модем»).
function openModemDetailByNick(nick, server) {
  var map = (typeof currentData !== 'undefined' && currentData && currentData._modemMap) || null;
  if (!map) return;
  for (var imei in map) {
    var m = map[imei];
    if (m.nick === nick && (!server || m.server === server)) {
      currentDetailModem = m;
      var serverLabel = typeof _serverDisplayLabel === 'function' ? _serverDisplayLabel(m.server) : m.server;
      document.getElementById('modalTitle').textContent = m.nick + ' (' + serverLabel + ')';
      switchTab('info', document.querySelector('.modal-tab[data-tab=info]'));
      document.getElementById('detailModal').classList.add('show');
      // закрыть оверлей, из которого открыли (если был)
      var ov = document.querySelector('div[style*=fixed]');
      if (ov) ov.remove();
      break;
    }
  }
}

// Показать/скрыть секрет в поле (modems.js peek): real — реальное значение,
// masked — маска (по умолчанию восемь точек). Раскрытые значения запоминаются
// (window._peekRevealed по id поля) и восстанавливаются после авторефреша —
// раньше каждые 60 сек пароли снова прятались под маску.
if (typeof window !== 'undefined') window._peekRevealed = window._peekRevealed || {};
function peekField(el, id, real, masked) {
  var v = document.getElementById(id);
  if (!v || typeof window === 'undefined') return;
  var mask = masked || '••••••••';
  var show = (v.textContent === mask);
  v.textContent = show ? real : mask;
  if (show) window._peekRevealed[id] = real; else delete window._peekRevealed[id];
  if (el) el.innerHTML = icon(show ? 'eyeOff' : 'eye', 11);
}
function restorePeekFields() {
  for (var id in window._peekRevealed) {
    var v = document.getElementById(id);
    if (v && v.textContent !== window._peekRevealed[id]) v.textContent = window._peekRevealed[id];
  }
}

// Показать/скрыть пароль на карточке сервера (settings.js): переключает
// textContent поля и иконку кнопки, флаг — в dataset.shown.
function togglePwdView(el, viewId, real) {
  var sp = document.getElementById(viewId);
  if (!sp) return;
  if (sp.dataset.shown) {
    sp.textContent = '••••••••';
    sp.dataset.shown = '';
    el.innerHTML = icon('eye', 12);
  } else {
    sp.textContent = real;
    sp.dataset.shown = '1';
    el.innerHTML = icon('lock', 12);
  }
}

// Reset IP по IMEI: если на странице есть кнопка модема — клик по ней
// (штатный путь resetIp), иначе прямой POST на API (точная семантика
// бывшей инлайн-IIFE из детали модема).
function resetIpByImei(imei, server) {
  var b = document.querySelector('[data-imei="' + imei + '"]');
  if (b) { resetIp(b); return; }
  fetch(API + '/api/admin/reset_ip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
    body: JSON.stringify({ imei: imei, serverName: server })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) { showToast(d.ok ? 'IP сброшен' : d.error, d.ok ? 'success' : 'error'); })
    .catch(function () { showToast('Ошибка сети', 'error'); });
}

// Финансы: выбор периода — localStorage + активная кнопка в ряду.
function finSetPeriod(el, period) {
  localStorage.setItem('fin_period', period);
  el.parentElement.querySelectorAll('.fin-period-btn').forEach(function (b) { b.classList.remove('active'); });
  el.classList.add('active');
  renderFinancesTab();
}

// Финансы: переход к модему по нику (таблица «По модемам»).
function finJumpToModem(nick) {
  var mm = (typeof currentData !== 'undefined' && currentData && currentData._modemMap) || {};
  for (var k in mm) {
    if (mm[k].nick === nick) { showDetails(mm[k]); break; }
  }
}

// Финансы → «все →»: переход на банковскую вкладку.
function finNavBank() {
  var b = document.querySelector('.nav-tab[data-on-click*=bank]');
  if (b) b.click();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { aeDownload, aeBuildExport, aeOpen, aeRender, aeSetClient, aeSetProto, openModemDetailByNick, peekField, togglePwdView, resetIpByImei, finSetPeriod, finJumpToModem, finNavBank };
}

// Переключить поповер «Формула» в карточке выручки (клик вместо hover —
// hover на динамически перерисовываемых карточках ненадёжен).
function toggleMrrFormula(el) {
  var wrap = el && el.parentElement;
  var pop = wrap && wrap.querySelector('.mrr-fp');
  if (!pop) return;
  pop.style.display = (pop.style.display === 'block') ? 'none' : 'block';
}
