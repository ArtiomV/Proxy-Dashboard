'use strict';
//
// public/js/admin/delegated-helpers.js — именованные хелперы для сайтов,
// которые не выражаются безопасной грамматикой delegation.js (Stage 5 ph.2 /
// Stage 11). Всё — обычные глобальные функции; вызываются через
// data-on-click="helperName(arg1, this)".

// 💾 Скачать textarea #aeText как proxies_<proto>.txt (глобальная proto).
function aeDownload() {
  var b = new Blob([document.getElementById('aeText').value], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = 'proxies_' + (window.proto || 'http') + '.txt';
  a.click();
}

// Открыть модем по нику из карты currentData._modemMap в модалке деталей
// (бывшая IIFE из карточки «модем»).
function openModemDetailByNick(nick) {
  var map = (typeof currentData !== 'undefined' && currentData && currentData._modemMap) || null;
  if (!map) return;
  for (var imei in map) {
    var m = map[imei];
    if (m.nick === nick) {
      currentDetailModem = m;
      document.getElementById('modalTitle').textContent = m.nick + ' (' + m.server + ')';
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
// masked — маска (по умолчанию восемь точек).
function peekField(el, id, real, masked) {
  var v = document.getElementById(id);
  if (!v) return;
  var mask = masked || '••••••••';
  v.textContent = (v.textContent === mask) ? real : mask;
}

// Показать/скрыть пароль на карточке сервера (settings.js): переключает
// textContent поля и иконку кнопки, флаг — в dataset.shown.
function togglePwdView(el, viewId, real) {
  var sp = document.getElementById(viewId);
  if (!sp) return;
  if (sp.dataset.shown) {
    sp.textContent = '••••••••';
    sp.dataset.shown = '';
    el.textContent = '👁';
  } else {
    sp.textContent = real;
    sp.dataset.shown = '1';
    el.textContent = '🔒';
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
  module.exports = { aeDownload, openModemDetailByNick, peekField, togglePwdView, resetIpByImei, finSetPeriod, finJumpToModem, finNavBank };
}
