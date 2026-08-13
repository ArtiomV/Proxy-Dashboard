// public/js/admin/speed-monitor.js — карточка «Скорость модемов» на дашборде.
// Почасовые замеры джобы SpeedMonitor (GET /api/admin/speed-monitor):
// линия DL на модем, дыры = часы без связи/замера. В легенде и мета-плашках —
// ник · оператор · сервер · локация, чтобы было видно, какая симка/оператор
// на какой локации стабильна, а какая проседает по часам.
//
// Зависит от глобалов admin.js/utils.js: api, esc, newChartSafe, getChartColors,
// _dashUi, _dashUiSave (все доступны к моменту вызова — модуль только объявляет
// функции, не трогает их на загрузке).

var _speedMonHours = _dashUi.speedMonHours || 48;
var _speedMonLastFetch = 0;
var _SPEEDMON_MIN_REFETCH_MS = 5 * 60 * 1000;   // renderAccNew дёргает часто

var _SPEEDMON_PALETTE = ['#3b9dd8', '#965ac8', '#ef9f27', '#3faf6e', '#e05a5a', '#8b8b88'];

function setSpeedMonHours(h, el) {
  _speedMonHours = h;
  _dashUiSave({ speedMonHours: h });
  if (el && el.parentNode) {
    Array.prototype.forEach.call(el.parentNode.querySelectorAll('.dchip'), function (c) { c.classList.remove('on'); });
    el.classList.add('on');
  }
  loadSpeedMonitor(true);
}

function _speedMonLabel(nick, modems) {
  var m = null;
  (modems || []).forEach(function (x) { if (x.nick === nick) m = x; });
  if (!m) return nick;
  var parts = [nick];
  if (m.operator) parts.push(m.operator);
  var loc = [m.server, m.location && m.location !== m.server ? m.location : ''].filter(Boolean).join(' · ');
  if (loc) parts.push(loc);
  return parts.join(' · ');
}

function loadSpeedMonitor(force) {
  var canvas = document.getElementById('speedMonCanvas');
  if (!canvas) return;
  var now = Date.now();
  if (!force && now - _speedMonLastFetch < _SPEEDMON_MIN_REFETCH_MS) return;
  _speedMonLastFetch = now;

  api(API + '/api/admin/speed-monitor?hours=' + _speedMonHours).then(function (d) {
    var rows = (d && d.rows) || [];
    var modems = (d && d.modems) || [];
    var emptyEl = document.getElementById('speedMonEmpty');
    var metaEl = document.getElementById('speedMonMeta');

    // Мета-плашки «ник · оператор · сервер · локация» с цветом датасета.
    if (metaEl) {
      if (!modems.length) { metaEl.innerHTML = ''; }
      else {
        metaEl.innerHTML = modems.map(function (m, i) {
          var color = _SPEEDMON_PALETTE[i % _SPEEDMON_PALETTE.length];
          return '<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;'
            + 'border:0.5px solid var(--border);border-radius:8px;padding:3px 9px;background:var(--bg-1)">'
            + '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0"></span>'
            + '<b>' + esc(m.nick) + '</b>'
            + (m.operator ? '<span style="color:var(--text-1)">' + esc(m.operator) + '</span>' : '')
            + '<span style="color:var(--text-3)">' + esc([m.server, m.location && m.location !== m.server ? m.location : ''].filter(Boolean).join(' · ')) + '</span>'
            + '</span>';
        }).join('');
      }
    }

    if (!rows.length) {
      if (emptyEl) emptyEl.style.display = 'block';
      newChartSafe(canvas, { type: 'line', data: { labels: [], datasets: [] } });
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Ось — объединение часов всех ников (у каждого свои дыры).
    var hourSet = {};
    rows.forEach(function (r) { hourSet[r.hour_msk] = 1; });
    var hours = Object.keys(hourSet).sort();
    var labels = hours.map(function (h) {
      // "2026-08-13 14:00" → "13.08 14:00"
      var m2 = h.match(/^\d{4}-(\d{2})-(\d{2}) (\d{2}):00$/);
      return m2 ? m2[2] + '.' + m2[1] + ' ' + m2[3] + ':00' : h;
    });

    var nicks = [];
    rows.forEach(function (r) { if (nicks.indexOf(r.nick) < 0) nicks.push(r.nick); });
    nicks.sort();

    var datasets = nicks.map(function (nick, i) {
      var color = _SPEEDMON_PALETTE[i % _SPEEDMON_PALETTE.length];
      var byHour = {};
      rows.forEach(function (r) {
        if (r.nick !== nick) return;
        // Час без успешного замера → null (дыра в линии), а не 0 —
        // 0 выглядел бы как «оператор дал ноль скорости».
        byHour[r.hour_msk] = r.ok_count > 0 ? r.avg_dl : null;
      });
      return {
        label: _speedMonLabel(nick, modems),
        data: hours.map(function (h) { return byHour[h] != null ? byHour[h] : null; }),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 1.5,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: false,
      };
    });

    var cc = getChartColors();
    newChartSafe(canvas, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 2, font: { size: 10 }, color: cc.text || '#9b9b98' },
          },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: {
              label: function (ctx) {
                var v = ctx.parsed.y;
                return ctx.dataset.label + ': ' + (v == null ? 'нет замера' : v.toFixed(2) + ' Мбит/с');
              },
            },
          },
        },
        scales: {
          x: { ticks: { font: { size: 10 }, color: '#9b9b98', maxRotation: 0, autoSkip: true }, grid: { color: cc.grid, drawTicks: false }, border: { display: false } },
          y: {
            beginAtZero: true, title: { display: true, text: 'DL, Мбит/с', font: { size: 10 }, color: '#6b6b68' },
            ticks: { font: { size: 10 }, color: '#6b6b68' }, grid: { color: cc.grid, drawTicks: false }, border: { display: false },
          },
        },
      },
    });
  }).catch(function () { /* транзиент (рестарт бэка) — следующий тик подхватит */ });
}
