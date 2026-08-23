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

// MiB → «3,3/7,4 ГБ» (десятичная запятая, округление до 0.1 ГБ до сотни).
function _srvMetGb(usedMb, totalMb) {
  if (usedMb == null || totalMb == null) return null;
  var f = function (v) { v = v / 1024; return (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)).replace('.', ','); };
  return f(usedMb) + '/' + f(totalMb) + ' ГБ';
}

// Подпись значения шкалы: «44% · 3,3/7,4 ГБ» (если есть абсолютные цифры).
function _srvMetVal(pct, usedMb, totalMb) {
  if (pct == null) return null;
  var gb = _srvMetGb(usedMb, totalMb);
  return pct + '%' + (gb ? ' · ' + gb : '');
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
    + '<span style="min-width:52px;flex-shrink:0;text-align:right;color:' + (pct == null ? 'var(--text-3)' : 'var(--text-1)') + ';font-family:var(--font-mono);white-space:nowrap">' + esc(val) + '</span>'
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
  var down = !!(m && m.error);
  var wrap = down
    ? 'border:2px solid #e13232;border-radius:10px;padding:12px 14px;background:linear-gradient(160deg,#ffdcdc 0%,#ffb9b9 100%);box-shadow:0 4px 18px rgba(225,50,50,.35)'
    : 'border:0.5px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--bg-2)'
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
    h += _srvMetBar('RAM', m.mem_used_pct, null, null, _srvMetVal(m.mem_used_pct, m.mem_used_mb, m.mem_total_mb));
    h += _srvMetBar('Swap', m.swap_used_pct);
    h += _srvMetBar('Диск', m.disk_used_pct, null, null, _srvMetVal(m.disk_used_pct, m.disk_used_mb, m.disk_total_mb));
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
    // Среднее за 24ч рядом с текущим — видно, пик это или норма.
    if (m.avg24) {
      var a = m.avg24, ab = [];
      if (a.cpu_pct != null) ab.push('CPU ' + a.cpu_pct + '%');
      if (a.mem_used_pct != null) ab.push('RAM ' + a.mem_used_pct + '%');
      if (a.disk_used_pct != null) ab.push('диск ' + a.disk_used_pct + '%');
      if (a.temp_c != null) ab.push(a.temp_c + '°C');
      if (ab.length) h += '<div style="margin-top:6px;font-size:10px;color:var(--text-3)" title="Среднее за последние 24 часа (' + (a.samples || 0) + ' замеров)">среднее за 24ч: ' + esc(ab.join(' · ')) + '</div>';
    }
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

// Компактный блок метрик для встраивания в карточку «Парк по серверам»:
// CPU/RAM/Диск шкалами + строка флагов (температура, аптайм, conn/rps, mongo,
// usb, дрейф). Данных нет — пустая строка (карточка живёт и без метрик).
function srvMetInline(name) {
  var d = window._srvMetData || {};
  var m = (d.metrics || {})[name];
  if (!m) return '';
  var h = '<div style="margin-top:9px;padding-top:9px;border-top:1px solid var(--border)">';
  if (m.error) {
    return h + '<div style="font-size:10px;color:var(--danger)">Бокс недоступен: ' + esc(m.error) + '</div></div>';
  }
  var hasSsh = m.cpu_pct != null || m.load1 != null || m.mem_used_pct != null
    || m.swap_used_pct != null || m.disk_used_pct != null;
  if (hasSsh) {
    h += '<div style="display:flex;flex-direction:column;gap:4px">';
    h += _srvMetBar('CPU', m.cpu_pct);
    h += _srvMetBar('RAM', m.mem_used_pct, null, null, _srvMetVal(m.mem_used_pct, m.mem_used_mb, m.mem_total_mb));
    h += _srvMetBar('Диск', m.disk_used_pct, null, null, _srvMetVal(m.disk_used_pct, m.disk_used_mb, m.disk_total_mb));
    h += '</div>';
  }
  var bits = [];
  if (m.temp_c != null) {
    var tc = m.temp_c >= 70 ? 'var(--danger)' : m.temp_c >= 55 ? 'var(--warning)' : 'var(--text-2)';
    bits.push('<span style="color:' + tc + '">' + esc(String(m.temp_c)) + '°C</span>');
  }
  var up = _srvMetUptime(m.uptime_sec);
  if (up) bits.push('<span style="color:var(--text-3)">аптайм ' + esc(up) + '</span>');
  if (m.conns != null) bits.push('<span style="color:var(--text-2)">' + esc(String(m.conns)) + ' conn</span>');
  if (m.mongo_ok === 0) bits.push('<span style="color:var(--danger)">MongoDB FAIL</span>');
  if (m.usb_errors) bits.push('<span style="color:var(--danger)">USB: ' + esc(m.usb_errors) + '</span>');
  if (!hasSsh && !m.error) bits.push('<span style="color:var(--warning)">SSH недоступен</span>');
  if (m.avg24 && m.avg24.cpu_pct != null) {
    bits.push('<span style="color:var(--text-3)" title="Средняя нагрузка за последние 24 часа">ср. 24ч: CPU ' + m.avg24.cpu_pct + '% · RAM ' + (m.avg24.mem_used_pct != null ? m.avg24.mem_used_pct + '%' : '—') + '</span>');
  }
  if ((m.age_sec || 0) > _SRVMET_STALE_SEC && m.collected_at) {
    var dtM = new Date(m.collected_at);
    bits.push('<span style="color:var(--text-3)">данные на ' + String(dtM.getHours()).padStart(2, '0') + ':' + String(dtM.getMinutes()).padStart(2, '0') + '</span>');
  }
  if (bits.length) h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:10px">' + bits.join('') + '</div>';
  return h + '</div>';
}

// Данные складываем в window._srvMetData и перерендериваем карточки парка —
// отдельного блока «Загрузка серверов» больше нет, метрики живут внутри
// карточек «Парк по серверам» (20.08).
//
// ── Редизайн карточки сервера (20.08, макет от владельца) ──
// Спарклайн 24ч: плавная линия + лёгкая заливка, пунктир — среднее.
// Для процентов шкала фиксирована 0..100; для соединений подстраивается
// под фактический диапазон, чтобы небольшие колебания оставались заметны.
function _srvSpark(series, avgValue, tone, relativeScale) {
  var pts = [];
  var vals = (series || []).filter(function (v) { return v != null && isFinite(v); }).map(Number);
  var min = 0, max = 100;
  if (relativeScale && vals.length) {
    min = Math.min.apply(null, vals.concat(avgValue == null ? [] : [Number(avgValue)]));
    max = Math.max.apply(null, vals.concat(avgValue == null ? [] : [Number(avgValue)]));
    var pad = Math.max(1, (max - min) * 0.35);
    min -= pad; max += pad;
  }
  function yFor(v) { return 33 - ((Math.max(min, Math.min(max, v)) - min) / Math.max(1, max - min)) * 28; }
  if (series && series.length) {
    var n = series.length;
    for (var i = 0; i < n; i++) {
      var v = series[i];
      if (v == null || !isFinite(v)) continue;
      var x = n > 1 ? (i / (n - 1)) * 300 : 150;
      pts.push({ x: x, y: yFor(Number(v)) });
    }
  }
  var purple = tone === 'purple';
  var stroke = purple ? 'var(--server-purple)' : 'var(--success)';
  var fill = purple ? 'var(--server-purple-bg)' : 'var(--green-bg)';
  var h = '<svg viewBox="0 0 300 36" preserveAspectRatio="none" class="server-spark" aria-hidden="true">';
  if (avgValue != null && isFinite(avgValue)) {
    var ay = yFor(Number(avgValue));
    h += '<line x1="0" y1="' + ay.toFixed(1) + '" x2="300" y2="' + ay.toFixed(1)
      + '" style="stroke:var(--text-3)" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>';
  }
  if (pts.length > 1) {
    var path = 'M' + pts[0].x.toFixed(1) + ',' + pts[0].y.toFixed(1);
    for (var p = 1; p < pts.length; p++) {
      var prev = pts[p - 1], cur = pts[p], mid = (prev.x + cur.x) / 2;
      path += ' C' + mid.toFixed(1) + ',' + prev.y.toFixed(1) + ' ' + mid.toFixed(1) + ',' + cur.y.toFixed(1) + ' ' + cur.x.toFixed(1) + ',' + cur.y.toFixed(1);
    }
    h += '<path d="' + path + ' L300,36 L0,36 Z" style="fill:' + fill + '" opacity="0.48"/>';
    h += '<path d="' + path + '" fill="none" stroke-width="1.8" stroke-linecap="round" style="stroke:' + stroke + ';vector-effect:non-scaling-stroke"/>';
  }
  return h + '</svg>';
}

// Строка метрики: иконка + название/подпись + спарклайн + текущее значение
// (крупно, с подписью-абсолютом типа «3,3/7,4 ГБ») + пилюля «ср. 24ч».
function _fmtP(v) { return v == null ? null : String(Math.round(v * 10) / 10).replace('.', ','); }

function _srvMetMinutes(sec) {
  var mins = Math.max(0, Math.round((Number(sec) || 0) / 60));
  return mins + ' мин';
}

function _srvMetEpisodeLabel(count) {
  count = Math.max(0, Number(count) || 0);
  var mod10 = count % 10, mod100 = count % 100;
  var word = mod10 === 1 && mod100 !== 11 ? 'эпизод'
    : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'эпизода' : 'эпизодов');
  return count + ' ' + word;
}

function _srvMetClock(ts) {
  var d = new Date(ts);
  if (!isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function _srvMetEventStamp(ts) {
  var d = new Date(ts);
  if (!isFinite(d.getTime())) return '';
  var day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  return day + ', ' + _srvMetClock(ts);
}

function _srvMetLastFlap(downtime) {
  var events = downtime && downtime.events || [];
  if (!events.length) return '';
  var e = events[events.length - 1];
  if (e.ongoing) return 'с ' + _srvMetClock(e.from) + ' · ' + _srvMetMinutes(e.duration_sec) + ', продолжается';
  return _srvMetClock(e.from) + '–' + _srvMetClock(e.to) + ' · ' + _srvMetMinutes(e.duration_sec);
}

// Зелёные сутки с красными отрезками недоступности. Минимальная видимая
// ширина короткого эпизода — 1.4%, иначе 2–3 минуты теряются на Retina.
function _srvMetFlapTimeline(downtime, generatedAt) {
  var now = Date.parse(generatedAt) || Date.now();
  var start = now - 24 * 3600e3;
  var spans = '';
  (downtime && downtime.events || []).forEach(function (e) {
    var from = Math.max(start, Date.parse(e.from));
    var to = Math.min(now, Date.parse(e.to));
    if (!isFinite(from) || !isFinite(to) || to <= from) return;
    var left = Math.max(0, Math.min(100, (from - start) / (24 * 3600e3) * 100));
    var width = Math.max(1.4, (to - from) / (24 * 3600e3) * 100);
    if (left + width > 100) width = 100 - left;
    spans += '<i style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%" title="'
      + esc(_srvMetClock(e.from) + '–' + _srvMetClock(e.to)) + '"></i>';
  });
  return '<span class="server-flap-timeline" aria-label="Эпизоды недоступности за 24 часа">' + spans + '</span>';
}

function srvMetRowV2(ic, title, sub, current, absText, average, series, options) {
  options = options || {};
  var unit = options.unit == null ? '%' : options.unit;
  var tone = options.tone || 'green';
  var val = current == null ? '—' : (options.integer ? String(Math.round(current)) : _fmtP(current)) + unit;
  var avg = average == null ? null : (options.integer ? String(Math.round(average)) : _fmtP(average)) + unit;
  return '<div class="server-metric-row server-metric-row--' + tone + '">'
    + '<span class="server-icon-box server-metric-icon">' + icon(ic, 18) + '</span>'
    + '<span class="server-metric-copy">'
    + '<span class="server-metric-title">' + esc(title) + '</span>'
    + '<span class="server-metric-sub">' + esc(sub) + '</span></span>'
    + '<span class="server-metric-spark">' + _srvSpark(series, average, tone, !!options.relativeScale) + '</span>'
    + '<span class="server-metric-current">'
    + '<span class="server-metric-value">' + esc(val) + '</span>'
    + (absText ? '<span class="server-metric-absolute">' + esc(absText) + '</span>' : '')
    + '</span>'
    + (avg != null
      ? '<span class="server-metric-average">ср. 24ч:&nbsp; ' + esc(avg) + '</span>'
      : '<span class="server-metric-average server-metric-average--empty">—</span>')
    + '</div>';
}

function renderServerMetrics(box, d) {
  window._srvMetData = d || {};
  if (typeof renderNewFleetServers === 'function') renderNewFleetServers();
}

function loadServerMetrics(force) {
  var now = Date.now();
  if (!force && now - _srvMetLastFetch < _SRVMET_MIN_REFETCH_MS) return;
  _srvMetLastFetch = now;
  api(API + '/api/admin/server_metrics').then(function (d) {
    renderServerMetrics(null, d || {});
  }).catch(function () { /* транзиент (рестарт бэка) — следующий тик подхватит */ });
}

// Экспорт для node-тестов (паттерн public/js/utils.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _srvMetBar, _srvMetUptime, _srvMetCard, renderServerMetrics, _srvMetColor,
    srvMetInline, _srvSpark, srvMetRowV2, _srvMetMinutes, _srvMetEpisodeLabel,
    _srvMetEventStamp, _srvMetLastFlap, _srvMetFlapTimeline,
  };
}
