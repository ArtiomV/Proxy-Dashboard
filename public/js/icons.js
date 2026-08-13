/* public/js/icons.js — единый набор SVG-иконок вместо эмодзи.
 * Использование: icon('bell') → '<svg …>' (inline, currentColor).
 *   icon(name, sizePx, color)  — size по умолчанию 14, color по умолчанию currentColor
 *   flagIcon('MD'|'RU'|'RO'|'DE'|'AT', sizePx) — флажок со скруглением.
 * Иконки stroke-based (стиль Lucide), viewBox 24 — красиво на любой теме.
 * Глобально: window.icon / window.flagIcon (CommonJS-экспорт для тестов).
 */
(function () {
  'use strict';

  var P = {
    // status / generic
    alert: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v4.5"/><path d="M12 17.2h.01"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.1-2.5 3.8"/><path d="M12 17h.01"/>',
    // actions
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>',
    bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
    save: '<path d="M5 3h12l4 4v14H5z"/><path d="M8 3v5h8V3"/><path d="M8 21v-7h8v7"/>',
    bell: '<path d="M8 2C5.79 2 4 3.79 4 6v3.5l-1 1.5h10l-1-1.5V6c0-2.21-1.79-4-4-4z" transform="translate(4 2)"/><path d="M10.5 19a1.5 1.5 0 0 0 3 0" transform="translate(-1 0)"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18z"/>',
    edit: '<path d="M15.5 4.5l4 4L8 20H4v-4L15.5 4.5z"/><path d="M13.5 6.5l4 4"/>',
    download: '<path d="M12 3v12"/><path d="M6.5 9.5 12 15l5.5-5.5"/><path d="M4 20h16"/>',
    upload: '<path d="M12 15V3"/><path d="M6.5 8.5 12 3l5.5 5.5"/><path d="M4 20h16"/>',
    hourglass: '<path d="M7 3h10M7 21h10"/><path d="M8 3v3.5L12 12l4-5.5V3"/><path d="M8 21v-3.5L12 12l4 5.5V21"/>',
    flask: '<path d="M9.5 3h5"/><path d="M10 3v5.5L4.5 18a2.4 2.4 0 0 0 2.1 3.5h10.8a2.4 2.4 0 0 0 2.1-3.5L14 8.5V3"/><path d="M7.5 14h9"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.8-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.7-7.5-9.5V6z"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.3 3-5.5 7-5.5s7 2.2 7 5.5"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 5.3M20.5 20c0-2.3-1.4-3.9-3.3-4.6"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M15 9c-.7-1-1.8-1.4-3-1.4-1.7 0-3 .8-3 2.2 0 3 6 1.5 6 4.4 0 1.4-1.3 2.2-3 2.2-1.3 0-2.5-.5-3.2-1.6"/>',
    card: '<rect x="3" y="6" width="18" height="13" rx="2.2"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1"/>',
    bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M4 10v8M8.5 10v8M15.5 10v8M20 10v8"/><path d="M2.5 20.5h19"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M10.6 6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.1 9.5 6.1a17.6 17.6 0 0 1-2.7 3.4M6.6 6.9A16.7 16.7 0 0 0 2.5 12S6 18.1 12 18.1c1.2 0 2.3-.3 3.3-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v4.5h-4.5"/>',
    antenna: '<path d="M8 20h8"/><path d="M12 20v-4"/><circle cx="12" cy="13" r="1.6"/><path d="M7.5 8.5a6.4 6.4 0 0 1 9 0M5 6a10 10 0 0 1 14 0"/>',
    signal: '<path d="M4 18v-4M9 18v-8M14 18V6M19 18V3"/>',
    stop: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8.5 16v-5M13 16V8M17.5 16v-8"/>',
    trend: '<path d="M3 17l5.5-5.5 3.5 3.5L20.5 6"/><path d="M15 6h5.5v5.5"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 1 5.6 5.6L9 20.5l-4.5-1 1-4.5L16.6 3.9a4 4 0 0 1-2.1 2.6z"/><path d="M13 7.5 16.5 11"/>',
    pin: '<path d="M12 21s-6.5-5.7-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.3 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
    keyboard: '<rect x="3" y="7" width="18" height="11" rx="2"/><path d="M7 11h.01M11 11h.01M15 11h.01M17 11h.01M7 14.5h10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5 15.8 15.8"/>',
    plug: '<path d="M9 7V3M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
    art: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="15.5" cy="10" r="1.2"/><path d="M12 21a3 3 0 0 1 0-6c3 0 5-1.5 5-4"/>',
    print: '<path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 13h10v8H7z"/>',
    fire: '<path d="M12 3c1 3.5 5 5 5 9.5A5 5 0 0 1 7 12.5c0-2 1-3.7 2.3-5C9.7 9 10 10.5 11 11c.5-2.5.5-5 1-8z"/>',
    robot: '<rect x="5" y="9" width="14" height="11" rx="2"/><path d="M12 9V5"/><circle cx="12" cy="4" r="1.2"/><circle cx="9.5" cy="13.5" r="1.1"/><circle cx="14.5" cy="13.5" r="1.1"/><path d="M9 17h6"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 6.6 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    db: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5V18.5c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8V5.5"/><path d="M4 12c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8"/>',
    link: '<path d="M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.6-5.6l-1.7 1.7"/><path d="M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.6 5.6l1.7-1.7"/>',
    infinity: '<path d="M7 15.5a3.5 3.5 0 1 1 0-7c4 0 6 7 10 7a3.5 3.5 0 1 0 0-7c-4 0-6 7-10 7z"/>',
    box: '<path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8 12 12l8.5-4"/><path d="M12 12v8.5"/>',
    siren: '<path d="M6 18v-6a6 6 0 0 1 12 0v6"/><path d="M4 18h16v3H4z"/><path d="M12 3v.01M4.6 5.6l.7.7M18.7 5.6l-.7.7"/>',
    off: '<circle cx="12" cy="12" r="9"/><path d="M7 7l10 10"/>',
    snail: '<circle cx="9" cy="14" r="4.5"/><circle cx="9" cy="14" r="1.6"/><path d="M13.5 14h6a2.5 2.5 0 0 1 0 5H5"/><path d="M17 9.5V7M19.5 9.5V7"/><path d="M16 7h.01M20.5 7h.01"/>',
    plane: '<path d="M10.5 13.5 3 11l1.5-1.5L11 11l4-6.5a1.8 1.8 0 0 1 2.8 2.3L14 13l1.5 6.5L14 21l-3.5-7.5z"/>',
    key: '<circle cx="8.5" cy="8.5" r="4.5"/><path d="M11.7 11.7 20 20"/><path d="M16 16l2.5-2.5M18.5 18.5 21 16"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 18.5h18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>',
    building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h.01M14.5 7h.01M9 11h.01M14.5 11h.01M9 15h.01M14.5 15h.01"/><path d="M10 21v-3.5h4V21"/>',
    receipt: '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5L10 21l-2-1.5L6 21z"/><path d="M9.5 8h5M9.5 12h5"/>',
    history: '<path d="M4 12a8 8 0 1 1 2.34 5.66"/><path d="M4 21v-4.5H8.5"/><path d="M12 8v4l3 1.7"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14 21l-3.5-7.5L3 10z"/>',
    filter: '<path d="M4 5h16l-6.5 7.5V19l-3 2v-8.5z"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    mobile: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>',
    sim: '<path d="M8 3h8l4 4v14H8z" transform="translate(-1 0)"/><rect x="9" y="11" width="7" height="6" rx="1"/>',
    gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M12 10v10"/><path d="M12 10S9 10 7.8 8.8A2.1 2.1 0 0 1 10.8 6C12 7.5 12 10 12 10zM12 10s3 0 4.2-1.2A2.1 2.1 0 0 0 13.2 6C12 7.5 12 10 12 10z"/>',
    logOut: '<path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8"/><path d="M17 8l4 4-4 4M21 12H10"/>',
  };

  function icon(name, size, color) {
    var body = P[name] || P.question;
    var s = size || 14;
    var stroke = color || 'currentColor';
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="' + stroke +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">' +
      body + '</svg>';
  }

  // Цветные статусные точки вместо 🔴🟡🔵⚫ — circle icon c fill.
  function dot(color, size) {
    var s = size || 9;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 10 10" style="vertical-align:-1px;flex-shrink:0"><circle cx="5" cy="5" r="4.2" fill="' + color + '"/></svg>';
  }

  // Флаги (замена regional-indicator эмодзи).
  var FLAGS = {
    RU: ['#fff', '#0039A6', '#D52B1E'],
    MD: ['#003DA5', '#FFD100', '#C1272D', 'v'],
    RO: ['#002B7F', '#FCD116', '#CE1126', 'v'],
    DE: ['#000', '#DD0000', '#FFCC00'],
    AT: ['#EF3340', '#fff', '#EF3340'],
  };
  function flagIcon(code, size) {
    var f = FLAGS[String(code || '').toUpperCase()];
    var s = size || 14;
    var w = Math.round(s * 4 / 3);
    if (!f) return '<span style="font-size:' + Math.round(s * 0.75) + 'px">' + code + '</span>';
    var stripes = '';
    if (f[3] === 'v') {
      var sw = w / 3;
      for (var i = 0; i < 3; i++) stripes += '<rect x="' + (i * sw).toFixed(2) + '" width="' + (sw + 0.5).toFixed(2) + '" height="' + s + '" fill="' + f[i] + '"/>';
    } else {
      var sh = s / f.length;
      for (var j = 0; j < f.length; j++) stripes += '<rect y="' + (j * sh).toFixed(2) + '" width="' + w + '" height="' + (sh + 0.5).toFixed(2) + '" fill="' + f[j] + '"/>';
    }
    return '<svg width="' + w + '" height="' + s + '" viewBox="0 0 ' + w + ' ' + s + '" style="vertical-align:-2px;border-radius:2px;overflow:hidden;flex-shrink:0">' + stripes + '</svg>';
  }

  window.icon = icon;
  window.iconDot = dot;
  window.flagIcon = flagIcon;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { icon: icon, iconDot: dot, flagIcon: flagIcon };
  }
})();
