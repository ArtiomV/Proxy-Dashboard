'use strict';
//
// public/js/admin/dguard.js — Настройки → «Доменный контроль»: журнал
// совпадений с бан-листом (domain_guard_hits, пишет src/jobs/domain-guard.js)
// + drill-down «все домены клиента за день» (/api/admin/domain_guard/client_hosts).
// Источник (ProxySmart top_hosts) отдаёт только хостнеймы — полных URL нет.

var _dguardRows = null;

function loadDomainGuard(){
  var box = document.getElementById('dguardHits');
  if(!box) return;
  box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Загрузка...</div>';
  api(API + '/api/admin/domain_guard?days=30').then(function(d){
    _dguardRows = (d && d.rows) || [];
    if(!_dguardRows.length){
      box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Совпадений с бан-листом нет за 30 дней</div>';
      return;
    }
    var h = '<table class="res-table"><thead><tr><th>Дата</th><th>Клиент</th><th>Сервер</th><th>Домен из бан-листа</th><th>За день</th><th>Всего</th><th></th></tr></thead><tbody>';
    _dguardRows.forEach(function(r, i){
      h += '<tr><td style="font-family:monospace;font-size:10px">' + esc(r.date) + '</td>'
        + '<td style="font-weight:600">' + esc(r.client_name || '—') + (r.nick ? ' <span style="color:var(--text-3);font-weight:400;font-size:10px">· ' + esc(r.nick) + '</span>' : '') + '</td>'
        + '<td>' + esc(_serverDisplayLabel(r.server_name)) + '</td>'
        + '<td><span style="color:var(--danger);font-weight:600">' + esc(r.host) + '</span></td>'
        + '<td style="font-family:monospace">+' + r.hits_delta + '</td>'
        + '<td style="font-family:monospace;color:var(--text-3)">' + r.total + '</td>'
        + '<td><button class="btn btn-sm" style="font-size:10px;padding:2px 8px" data-on-click="openDomainGuardDrill(' + i + ')">Все домены</button></td></tr>';
    });
    box.innerHTML = h + '</tbody></table>';
  }).catch(function(e){
    box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">' + esc(e.message) + '</div>';
  });
}

function openDomainGuardDrill(i){
  var r = _dguardRows && _dguardRows[i];
  if(!r) return;
  var card = document.getElementById('dguardDrillCard');
  var box = document.getElementById('dguardDrill');
  document.getElementById('dguardDrillTitle').textContent = 'Все домены: ' + (r.client_name || '?') + ' · ' + _serverDisplayLabel(r.server_name) + ' · ' + r.date;
  card.style.display = '';
  box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Загрузка...</div>';
  api(API + '/api/admin/domain_guard/client_hosts?server=' + encodeURIComponent(r.server_name)
      + '&client=' + encodeURIComponent(r.client_name || '') + '&date=' + encodeURIComponent(r.date))
    .then(function(d){
      var rows = (d && d.rows) || [];
      if(!rows.length){
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Нет обращений за этот день</div>';
        return;
      }
      var h = '<table class="res-table"><thead><tr><th>Домен</th><th>Модем</th><th>За день</th><th>Всего</th></tr></thead><tbody>';
      rows.forEach(function(x){
        h += '<tr' + (x.banned ? ' style="background:rgba(232,65,65,.08)"' : '') + '>'
          + '<td style="font-weight:' + (x.banned ? '600' : '400') + ';color:' + (x.banned ? 'var(--danger)' : 'var(--text-1)') + '">'
          + esc(x.host) + (x.banned ? ' <span style="font-size:9px;font-weight:600;color:#fff;background:var(--danger);padding:1px 6px;border-radius:6px">БАН</span>' : '') + '</td>'
          + '<td style="color:var(--text-3);font-size:10px">' + esc(x.nick || '') + '</td>'
          + '<td style="font-family:monospace">+' + x.delta + '</td>'
          + '<td style="font-family:monospace;color:var(--text-3)">' + x.count + '</td></tr>';
      });
      box.innerHTML = h + '</tbody></table>';
    })
    .catch(function(e){
      box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">' + esc(e.message) + '</div>';
    });
}

function closeDomainGuardDrill(){
  var c = document.getElementById('dguardDrillCard');
  if(c) c.style.display = 'none';
}
