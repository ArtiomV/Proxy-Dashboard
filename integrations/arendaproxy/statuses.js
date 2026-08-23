(function () {
  'use strict';

  // Drop-in replacement for arendaproxy.ru/js/statuses.js. The public page
  // keeps its existing HTML/CSS; only the source of truth changes.
  var API = 'https://app.arendaproxy.ru/api/public/status';
  var ORDER = ['residential-ru', 'mobile-md', 'mobile-ro'];
  var COLORS = {
    operational: '#16a34a',
    degraded: '#f59e0b',
    major_outage: '#ef4444',
    unknown: '#c8ced8'
  };

  function byId(data, id) {
    return (data.components || []).filter(function (c) { return c.id === id; })[0] || null;
  }

  function dayStatus(day) {
    if (!day || day.uptime == null) return 'unknown';
    if (day.uptime >= 99.9) return 'operational';
    if (day.uptime >= 98) return 'degraded';
    return 'major_outage';
  }

  function label(status) {
    return status === 'operational' ? 'В норме'
      : status === 'degraded' ? 'Есть сбои'
      : status === 'major_outage' ? 'Недоступно'
      : 'Нет данных';
  }

  function setUnknown(card) {
    var uptime = card.querySelector('.proxy-status-head > :last-child');
    if (uptime) {
      uptime.textContent = 'Нет данных';
      uptime.className = '';
      uptime.style.color = COLORS.unknown;
    }
    Array.prototype.forEach.call(card.querySelectorAll('.proxy-status-blocks > *'), function (block) {
      block.className = '';
      block.style.backgroundColor = COLORS.unknown;
      block.title = 'Нет телеметрии';
    });
  }

  function renderCard(card, component) {
    if (!component) return setUnknown(card);
    var uptime = card.querySelector('.proxy-status-head > :last-child');
    if (uptime) {
      uptime.textContent = component.uptime60d == null
        ? 'Нет данных'
        : Number(component.uptime60d).toFixed(3) + '% uptime';
      uptime.className = '';
      uptime.style.color = COLORS[component.status] || COLORS.unknown;
    }

    var dayMap = {};
    (component.days || []).forEach(function (d) { dayMap[d.day] = d; });
    var blocks = card.querySelectorAll('.proxy-status-blocks > *');
    var now = new Date();
    Array.prototype.forEach.call(blocks, function (block, index) {
      var date = new Date(now.getTime() - (blocks.length - 1 - index) * 86400000);
      var key = date.toISOString().slice(0, 10);
      var day = dayMap[key] || null;
      var status = dayStatus(day);
      block.className = '';
      block.style.backgroundColor = COLORS[status];
      var pct = day && day.uptime != null ? ' · ' + Number(day.uptime).toFixed(3) + '%' : '';
      block.title = label(status) + pct + ' · ' + date.toLocaleDateString('ru-RU');
      block.setAttribute('aria-label', block.title);
    });
  }

  function render(data) {
    var section = document.querySelector('.proxy-status');
    if (!section) return;
    var heading = section.querySelector('h1');
    if (heading) heading.textContent = data.overall === 'operational'
      ? 'Все прокси в сети'
      : data.overall === 'major_outage' ? 'Есть недоступные прокси'
      : data.overall === 'degraded' ? 'Есть перебои в работе'
      : 'Нет свежих данных';
    var stamp = section.querySelector('h1 + p');
    if (stamp) {
      var updated = new Date(data.updatedAt);
      stamp.textContent = 'Последнее обновление ' + updated.toLocaleString('ru-RU', {
        timeZone: 'Europe/Chisinau', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
      }) + ' (GMT+3)';
    }
    var cards = section.querySelectorAll('.proxy-status-el');
    Array.prototype.forEach.call(cards, function (card, i) { renderCard(card, byId(data, ORDER[i])); });
  }

  var cards = document.querySelectorAll('.proxy-status-el');
  Array.prototype.forEach.call(cards, setUnknown); // never flash manufactured 100%
  fetch(API, { credentials: 'omit', cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(render)
    .catch(function () {
      var section = document.querySelector('.proxy-status');
      var heading = section && section.querySelector('h1');
      if (heading) heading.textContent = 'Нет свежих данных';
    });
}());
