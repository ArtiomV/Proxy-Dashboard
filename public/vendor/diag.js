// Диагностика мобильного рендера: видна на экране без консоли.
(function () {
  var log = document.getElementById('log');
  function add(msg, color) {
    var d = document.createElement('div');
    d.textContent = msg;
    if (color) d.style.color = color;
    log.appendChild(d);
  }
  document.getElementById('t').textContent = new Date().toISOString().slice(11, 19) + 'Z';
  window.onerror = function (m, s, l) {
    add('JS ERROR: ' + m + ' @ ' + String(s || '').split('/').pop() + ':' + l, '#f66');
  };
  add('JS OK (diag.js выполняется)');
  add('UA: ' + navigator.userAgent.slice(0, 90), '#888');
  // По очереди грузим реальные скрипты админки и докладываем статус.
  var files = ['/js/icons.js', '/js/utils.js', '/js/admin/modems.js', '/js/admin.js'];
  (function next(i) {
    if (i >= files.length) { add('ВСЕ СКРИПТЫ ЗАГРУЖЕНЫ', '#0f0'); return; }
    var s = document.createElement('script');
    s.src = files[i];
    s.onload = function () { add('loaded: ' + files[i]); next(i + 1); };
    s.onerror = function () { add('FAIL LOAD: ' + files[i], '#f66'); next(i + 1); };
    document.body.appendChild(s);
  })(0);
})();
