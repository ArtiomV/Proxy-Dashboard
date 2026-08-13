// public/js/admin/speed-monitor.js — карточка «Скорость модемов» на дашборде.
// Почасовые замеры джобы SpeedMonitor (GET /api/admin/speed-monitor):
// линия DL на модем, дыры = часы без связи/замера. В легенде и мета-плашках —
// ник · оператор · сервер · локация, чтобы было видно, какая симка/оператор
// на какой локации стабильна, а какая проседает по часам.
// Разбиение по локациям (адрес → оператор → ↓/↑) — в попапе графика при
// наведении (external-тултип в дизайне «Почасового трафика»), а не
// отдельными плашками под картой.
//
// Зависит от глобалов admin.js/utils.js: api, esc, newChartSafe, getChartColors,
// _dashUi, _dashUiSave (все доступны к моменту вызова — модуль только объявляет
// функции, не трогает их на загрузке).

// NB: _dashUi объявлен в admin.js, который грузится ПОСЛЕ этого файла, —
// трогать его на загрузке нельзя (ReferenceError убивал весь модуль, график
// оставался пустым). Читаем persisted-значение лениво, внутри функций.
var _speedMonHours = 48;
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
  // Ленивое чтение persisted-периода (см. NB выше): первый вызов — после
  // загрузки admin.js, _dashUi уже существует.
  try {
    if (typeof _dashUi !== 'undefined' && _dashUi.speedMonHours
        && !_speedMonHoursRestored) {
      _speedMonHours = _dashUi.speedMonHours;
      _speedMonHoursRestored = true;
      document.querySelectorAll('[data-on-click^="setSpeedMonHours("]').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-on-click') === 'setSpeedMonHours(' + _speedMonHours + ',this)');
      });
    }
  } catch (_) {}
  var now = Date.now();
  if (!force && now - _speedMonLastFetch < _SPEEDMON_MIN_REFETCH_MS) return;
  _speedMonLastFetch = now;

  api(API + '/api/admin/speed-monitor?hours=' + _speedMonHours).then(function (d) {
    var skel = document.getElementById('speedMonSkel');
    if (skel) skel.style.display = 'none';   // данные пришли — скелетон убираем
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

    // Разбиение по локациям для попапа графика (external-тултип): адрес
    // сервера из настроек (fallback — страна/имя бокса) → оператор → средние
    // ↓/↑ за наведённый час, взвешенные по числу успешных замеров. dl и ul
    // копим с раздельными счётчиками — если у оператора есть только одно
    // направление, в попапе покажем то, что есть.
    var nickLoc = {}, nickOp = {};
    modems.forEach(function (m) {
      nickLoc[m.nick] = m.address || m.location || m.server || '—';
      nickOp[m.nick] = m.operator || 'оператор?';
    });
    var hourLocOps = {};   // hour_msk → loc → op → { dl, nd, ul, nu } (суммы)
    rows.forEach(function (r) {
      if (!(r.ok_count > 0)) return;
      var loc = nickLoc[r.nick];
      if (!loc) return;
      var op = nickOp[r.nick] || 'оператор?';
      var H = hourLocOps[r.hour_msk] || (hourLocOps[r.hour_msk] = {});
      var L = H[loc] || (H[loc] = {});
      var O = L[op] || (L[op] = { dl: 0, nd: 0, ul: 0, nu: 0 });
      if (r.avg_dl != null) { O.dl += r.avg_dl * r.ok_count; O.nd += r.ok_count; }
      if (r.avg_ul != null) { O.ul += r.avg_ul * r.ok_count; O.nu += r.ok_count; }
    });

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
            enabled: false,   // рисует только external — на-канвас тултип не нужен
            // Свой external-попап в дизайне тултипа «Почасового трафика»
            // (analytics.js showHeatTT): белая карточка, заголовок — час,
            // локация — жирный подзаголовок, под ней операторы строками
            // «имя … ↓x.x ↑y.y Мбит/с», между локациями — пустая строка.
            external: function (context) {
              var ttEl = document.getElementById('speedMonTT');
              if (!ttEl) {
                ttEl = document.createElement('div');
                ttEl.id = 'speedMonTT';
                ttEl.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;background:#fff;'
                  + 'border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:170px;'
                  + 'box-shadow:0 4px 20px rgba(0,0,0,0.09);opacity:0;transition:opacity .12s ease;'
                  + 'font-family:Inter,-apple-system,sans-serif';
                document.body.appendChild(ttEl);
              }
              var tt = context.tooltip;
              if (!tt || tt.opacity === 0 || !tt.dataPoints || !tt.dataPoints.length) {
                ttEl.style.opacity = '0';
                return;
              }
              var H = hourLocOps[hours[tt.dataPoints[0].dataIndex]];
              var h = '<div style="font-size:11px;color:#9b9b98;margin-bottom:6px">'
                + esc((tt.title && tt.title[0]) || '') + '</div>';
              if (H) {
                Object.keys(H).forEach(function (loc, li) {
                  // Пустая строка между блоками локаций.
                  if (li) h += '<div style="height:13px"></div>';
                  h += '<div style="font-size:12px;font-weight:600;color:#1a1a1a;margin-bottom:3px">'
                    + esc(loc) + '</div>';
                  var ops = H[loc];
                  Object.keys(ops).sort(function (a, b) {
                    var da = ops[a].nd ? ops[a].dl / ops[a].nd : -1;
                    var db = ops[b].nd ? ops[b].dl / ops[b].nd : -1;
                    return db - da;   // по убыванию среднего ↓
                  }).forEach(function (op) {
                    var o = ops[op];
                    var parts = [];
                    if (o.nd) parts.push('↓' + (o.dl / o.nd).toFixed(1));
                    if (o.nu) parts.push('↑' + (o.ul / o.nu).toFixed(1));
                    if (!parts.length) return;
                    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:2px 0">'
                      + '<span style="font-size:11px;color:#9b9b98">' + esc(op) + '</span>'
                      + '<span style="font-size:12px;font-weight:500;color:#1a1a1a;white-space:nowrap">'
                      + parts.join(' ') + ' Мбит/с</span></div>';
                  });
                });
              }
              ttEl.innerHTML = h;
              // Позиционирование — как в chartExtTooltip: от каретки, с клампом к окну.
              var rect = context.chart.canvas.getBoundingClientRect();
              ttEl.style.opacity = '1';
              var w = ttEl.offsetWidth, ht = ttEl.offsetHeight;
              var x = rect.left + tt.caretX + 14, y = rect.top + tt.caretY - 10;
              if (x + w > window.innerWidth - 8) x = rect.left + tt.caretX - w - 14;
              if (x < 8) x = 8;
              if (y + ht > window.innerHeight - 8) y = window.innerHeight - ht - 8;
              if (y < 8) y = 8;
              ttEl.style.left = x + 'px';
              ttEl.style.top = y + 'px';
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
