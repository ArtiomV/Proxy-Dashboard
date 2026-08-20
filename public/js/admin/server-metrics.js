// public/js/admin/server-metrics.js — блок «Загрузка серверов» на дашборде.
// Данные: GET /api/admin/server_metrics (последняя строка server_metrics по
// каждому боксу, пишет джоба ServerMetrics раз в 10 мин). Два источника:
// SSH (cpu/load/ram/swap/disk/temp/uptime — приоритетно) и HTTP-панель бокса
// /system_status (conns/rps/mongo/usb/дрейф часов). Когда SSH недоступен,
// SSH-полей нет — показываем HTTP-метрики с пометкой «расширенные метрики
// недоступны». Данные старше 20 мин приглушаются с пометкой «данные на HH:MM».
//
// Зависит от глобалов utils.js/admin.js: api, API, esc (доступны к моменту
// вызова — модуль только объявляет функции, на загрузке ничего не трогает).

var _srvMetLastFetch = 0;
var _SRVMET_MIN_REFETCH_MS = 5 * 60 * 1000;   // renderAccNew дёргает часто
var _SRVMET_STALE_SEC = 20 * 60;              // старше 20 мин — приглушаем

// Цвет шкалы по заполненности: <60 зелёная, <85 жёлтая, иначе красная.
function _srvMetColor(pct) {
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 60) return 'var(--warning)';
  return 'var(--success)';
}

// Одна шкала «подпись [====----] NN%». pct null → прочерк (метрики нет).
function _srvMetBar(label, pct, widthPct, color, valueText) {
  var w = pct == null ? 0 : Math.max(0, Math.min(100, widthPct != null ? widthPct : pct));
  var c = pct == null ? 'var(--text-3)' : (color || _srvMetColor(pct));
  var val = pct == null ? '—' : (valueText != null ? valueText : pct + '%');
  return '<div style="display:flex;align-items:center;gap:8px;font-size:11px">'
    + '<span style="width:44px;flex-shrink:0;color:var(--text-2)">' + esc(label) + '</span>'
    + '<span style="flex:1;height:6px;border-radius:3px;background:var(--bg-3);overflow:hidden;display:block">'
    + '<span style="display:block;height:100%;width:' + w + '%;background:' + c + ';border-radius:3px"></span></span>'
    + '<span style="width:52px;flex-shrink:0;text-align:right;color:' + (pct == null ? 'var(--text-3)' : 'var(--text-1)') + ';font-family:var(--font-mono)">' + esc(val) + '</span>'
    + '</div>';
}

// Аптайм сек → «12д 4ч» / «5ч 20м» / «40м».
function _srvMetUptime(sec) {
  if (!(sec > 0)) return null;
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'д ' + h + 'ч';
  if (h > 0) return h + 'ч ' + m + 'м';
  return m + 'м';
}

// Одна карточка сервера. m — строка метрик (может быть null — данных ещё нет).
function _srvMetCard(name, m, address) {
  var stale = m && (m.age_sec || 0) > _SRVMET_STALE_SEC;
  var wrap = 'border:0.5px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--bg-2)'
    + (stale ? ';opacity:0.55' : '');
  var h = '<div style="' + wrap + '">';
  // Шапка: имя · адрес площадки; справа — источник и возраст/время данных.
  h += '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px">'
    + '<span style="font-size:12px;font-weight:600;color:var(--text-0)">' + esc(name)
    + (address ? ' <span style="font-weight:400;color:var(--text-2)">· ' + esc(address) + '</span>' : '')
    + '</span>';
  var meta = [];
  if (m && m.source) meta.push(m.source === 'mixed' ? 'ssh+http' : m.source);
  if (stale && m.collected_at) {
    var dt = new Date(m.collected_at);
    meta.push('данные на ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'));
  }
  h += '<span style="font-size:10px;color:var(--text-3);white-space:nowrap">' + esc(meta.join(' · ')) + '</span></div>';

  if (!m) {
    h += '<div style="font-size:11px;color:var(--text-3)">Данных ещё нет — джоба ServerMetrics пишет раз в 10 мин.</div></div>';
    return h;
  }
  if (m.error) {
    h += '<div style="font-size:11px;color:var(--danger)">Бокс недоступен: ' + esc(m.error) + '</div></div>';
    return h;
  }

  // SSH-метрики: хотя бы одно поле собрано → показываем шкалы.
  var hasSsh = m.cpu_pct != null || m.load1 != null || m.mem_used_pct != null
    || m.swap_used_pct != null || m.disk_used_pct != null;
  if (hasSsh) {
    h += '<div style="display:flex;flex-direction:column;gap:5px">';
    h += _srvMetBar('CPU', m.cpu_pct);
    // Load: нормируем к 4 (cpu_count неизвестен) — пороги 2/4 на load1.
    var l1 = m.load1;
    h += _srvMetBar('Load', l1, l1 != null ? (l1 / 4) * 100 : null,
      l1 != null ? (l1 >= 4 ? 'var(--danger)' : l1 >= 2 ? 'var(--warning)' : 'var(--success)') : null,
      l1 != null ? String(l1) : null);
    h += _srvMetBar('RAM', m.mem_used_pct);
    h += _srvMetBar('Swap', m.swap_used_pct);
    h += _srvMetBar('Диск', m.disk_used_pct);
    h += '</div>';
    // Температура и аптайм — текстом с цветовой индикацией.
    var bits = [];
    if (m.temp_c != null) {
      var tc = m.temp_c >= 70 ? 'var(--danger)' : m.temp_c >= 55 ? 'var(--warning)' : 'var(--text-1)';
      bits.push('<span style="color:' + tc + '">' + esc(String(m.temp_c)) + '°C</span>');
    }
    var up = _srvMetUptime(m.uptime_sec);
    if (up) bits.push('<span style="color:var(--text-2)">аптайм ' + esc(up) + '</span>');
    if (bits.length) h += '<div style="display:flex;gap:12px;margin-top:8px;font-size:11px">' + bits.join('') + '</div>';
  } else {
    h += '<div style="font-size:11px;color:var(--warning);margin-bottom:6px">Расширенные метрики недоступны (SSH)</div>';
  }

  // HTTP-метрики панели (есть и без SSH): conns/rps, mongo, usb, дрейф часов.
  var chips = [];
  if (m.conns != null) chips.push(esc(String(m.conns)) + ' conn');
  if (m.rps != null) chips.push(esc(String(m.rps)) + ' rps');
  if (chips.length) {
    h += '<div style="margin-top:8px;font-size:11px;color:var(--text-1)">' + chips.join(' · ') + '</div>';
  }
  var flags = [];
  if (m.mongo_ok === 1) flags.push('<span style="color:var(--success)">MongoDB OK</span>');
  else if (m.mongo_ok === 0) flags.push('<span style="color:var(--danger)">MongoDB FAIL</span>');
  if (m.usb_errors) flags.push('<span style="color:var(--danger)">USB: ' + esc(m.usb_errors) + '</span>');
  if (m.box_time_drift_sec != null && Math.abs(m.box_time_drift_sec) > 30) {
    var dr = m.box_time_drift_sec;
    flags.push('<span style="color:' + (Math.abs(dr) > 120 ? 'var(--warning)' : 'var(--text-2)') + '">дрейф часов '
      + (dr > 0 ? '+' : '') + esc(String(dr)) + ' с</span>');
  }
  if (flags.length) h += '<div style="margin-top:5px;font-size:11px;display:flex;gap:12px;flex-wrap:wrap">' + flags.join('') + '</div>';
  h += '</div>';
  return h;
}

function renderServerMetrics(box, d) {
  var metrics = d.metrics || {};
  var addresses = d.addresses || {};
  var names = Object.keys(metrics).sort();
  if (!names.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:10px 2px">Серверы не настроены.</div>';
    return;
  }
  box.innerHTML = names.map(function (n) {
    return _srvMetCard(n, metrics[n], addresses[n]);
  }).join('');
}

function loadServerMetrics(force) {
  var box = document.getElementById('serverMetrics');
  if (!box) return;
  var now = Date.now();
  if (!force && now - _srvMetLastFetch < _SRVMET_MIN_REFETCH_MS) return;
  _srvMetLastFetch = now;
  api(API + '/api/admin/server_metrics').then(function (d) {
    renderServerMetrics(box, d || {});
  }).catch(function () { /* транзиент (рестарт бэка) — следующий тик подхватит */ });
}

// Экспорт для node-тестов (паттерн public/js/utils.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _srvMetBar, _srvMetUptime, _srvMetCard, renderServerMetrics, _srvMetColor };
}
