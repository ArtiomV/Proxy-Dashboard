// public/js/admin.js — extracted from public/admin.html (Stage 5).
// Single-page admin app: client list, modem table, analytics, simulator,
// settings. Heavy reliance on the global window namespace for shared
// state between functions; no module system. Kept as a single file
// because every function references several others and bundling would
// just rename them.

// Utility functions (esc, parseTraffic, fmtGb, bytesToGb, fmtGbShort, pct,
// getModemStatus, formatUptime, formatTraffic, renderSignalBars,
// renderNetBadge, fmtDateRu, showToast, getChartColors) moved to
// public/js/utils.js — single shared source for admin + client portal so
// the same byte value renders identically on both pages. Stage 7 unified
// the unit semantics (decimal SI everywhere; matches backend).

// Debounce: collapse rapid keystrokes / events into one trailing call.
// Used for search input, filter changes, anything that rebuilds the
// modem table — without this, 500+ modem rows re-render on every keypress.
function debounce(fn,ms){var t=null;return function(){var args=arguments,ctx=this;clearTimeout(t);t=setTimeout(function(){fn.apply(ctx,args)},ms||180)}}
var debouncedRenderTable=debounce(function(){renderTable()},180);
var debouncedRenderClients=debounce(function(){renderClients()},180);

// newChartSafe — always tear down a previous Chart instance bound to the
// same canvas before constructing a new one. Without this, switching tabs
// or refreshing the dashboard leaks Chart objects + their event handlers.
function newChartSafe(canvasEl, cfg) {
  if (!canvasEl) return null;
  try {
    if (window.Chart && Chart.getChart) {
      var existing = Chart.getChart(canvasEl);
      if (existing && typeof existing.destroy === 'function') existing.destroy();
    }
  } catch (_) {}
  var ctx = canvasEl.getContext ? canvasEl.getContext('2d') : canvasEl;
  return new Chart(ctx, cfg);
}
var API='',authToken=localStorage.getItem('pr_admin_token')||'',currentData=null;
var sortCol='nick',sortDir='asc',activeServerFilter=localStorage.getItem('admin_srv_filter')||'all',activeStatusFilter='all',activeClientFilter='';
var autoRefreshTimer=null,charts={},REFRESH_MS=10000;
var _crmLoaded=false;

// ── Resilience: never surface a raw JSON-parse/HTML error to the user. During a
// backend restart/deploy nginx briefly returns a 502 HTML page ("<!DOCTYPE…"),
// so the 10s poller's r.json() throws SyntaxError "Unexpected token '<'". These
// are transient — swallow them (the next refresh recovers) and show a friendly
// "reconnecting" toast instead of the raw parse error.
function _isServerDownErr(e){return !!e&&(e._serverDown===true||e.name==='SyntaxError'||/Unexpected token|<!DOCTYPE|is not valid JSON|server_unavailable/i.test((e&&e.message)||''));}
function _okJson(r){var ct=(r&&r.headers&&r.headers.get&&r.headers.get('content-type'))||'';if(!r.ok||(ct&&ct.indexOf('json')<0)){var err=new Error('server_unavailable');err._serverDown=true;throw err;}return r.json();}
// Catch-all: even if some other of the ~150 call sites lets a raw parse error
// reach a toast, replace it with the friendly message (never show "<!DOCTYPE…").
(function(){var _orig=(typeof window!=='undefined'&&window.showToast)?window.showToast:(typeof showToast==='function'?showToast:null);if(!_orig)return;var _wrap=function(m,t,d){if(typeof m==='string'&&/Unexpected token|<!DOCTYPE|is not valid JSON|server_unavailable/i.test(m)){return _orig('Сервер перезапускается, переподключаюсь…','warning',4000);}return _orig(m,t,d);};try{window.showToast=_wrap;}catch(_){}try{showToast=_wrap;}catch(_){}})();

function crmExport(object){
  showToast('Готовлю экспорт CRM…','info');
  // NB: stays on raw fetch — this endpoint returns a CSV blob and the code
  // needs Response headers (Content-Disposition), which api() doesn't expose.
  fetch(API+'/api/admin/crm/export?object='+encodeURIComponent(object),{headers:{'X-Auth-Token':authToken}})
    .then(function(r){
      if(!r.ok) return r.json().then(function(d){throw new Error(d.error||('HTTP '+r.status))});
      var fname=(r.headers.get('Content-Disposition')||'').match(/filename="([^"]+)"/);
      return r.blob().then(function(b){return {b:b,fname:fname?fname[1]:('crm-'+object+'.csv')}});
    })
    .then(function(x){
      var u=URL.createObjectURL(x.b);var a=document.createElement('a');a.href=u;a.download=x.fname;
      document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},4000);
      showToast('Экспорт скачан: '+x.fname,'success');
    })
    .catch(function(e){showToast('Экспорт CRM: '+e.message,'error');});
}
function crmAutoLogin(){
  var frame=document.getElementById('crmFrame');
  var status=document.getElementById('crmStatus');
  if(_crmLoaded&&frame.src.indexOf('crm.')!==-1){return}
  status.textContent='Подключение...';status.style.color='var(--warning)';
  api(API+'/api/admin/crm_token').then(function(d){
    if(d.token&&d.url){
      frame.src=d.url+'/verify?loginToken='+d.token;
      _crmLoaded=true;
      status.textContent='Подключено';status.style.color='var(--success)';
      setTimeout(function(){status.textContent=''},3000);
    }else{
      status.textContent=d.error||'Ошибка входа';status.style.color='var(--danger)';
      if(d.url){frame.src=d.url;_crmLoaded=true}
    }
  }).catch(function(e){
    status.textContent='CRM недоступна';status.style.color='var(--danger)';
  });
}

var COLUMNS=[{id:'rail',label:'',visible:true,sortable:false,width:'6px'},
  {id:'bulk',label:'<input type="checkbox" id="bulkSelectAll" onclick="bulkToggleAll(this)" style="cursor:pointer;margin:0">',visible:true,sortable:false,width:'28px'},
  {id:'status',label:'',visible:true,sortable:false,width:'24px'},
  {id:'nick',label:'Модем',visible:true,sortable:true},
  {id:'server',label:'Сервер',visible:false,sortable:true},
  {id:'portName',label:'Клиент',visible:true,sortable:true},
  {id:'creds',label:'Доступ',visible:true,sortable:false},
  {id:'extIp',label:'Внеш.IP',visible:false,sortable:false},
  {id:'netType',label:'Сеть',visible:true,sortable:true},
  {id:'phone',label:'Телефон',visible:false,sortable:false},
  {id:'trafficDay',label:'Сегодня',visible:true,sortable:true},
  {id:'trafficMon',label:'Месяц',visible:false,sortable:true},
  {id:'speed',label:'Скорость <span class="th-hint" title="Download ↓ / Upload ↑ в Mbps&#10;Зелёный: > 30 Mbps&#10;Синий: 10–30 Mbps&#10;Оранжевый: < 10 Mbps&#10;⚠ — значение аномально низкое">ⓘ</span>',visible:false,sortable:true},
  {id:'uptime',label:'Аптайм',visible:false,sortable:true},
  {id:'latency',label:'Латентность',visible:true,sortable:true},
  {id:'conns',label:'Конн. <span class="th-hint" title="Живые TCP-подключения через прокси (HTTP + SOCKS5), суммарно по портам модема&#10;Клик — настройки порта: лимиты Max Conn / Conn Limit">ⓘ</span>',visible:true,sortable:true,width:'104px'},
  {id:'errors',label:'Ошибки',visible:false,sortable:true},
  {id:'health',label:'Здоровье',visible:true,sortable:true,width:'70px'},
  {id:'rotation',label:'Ротация',visible:false,sortable:true},
  {id:'band',label:'Band',visible:false,sortable:true},
  {id:'actions',label:'',visible:true,sortable:false,width:'118px'}
];
var _countryFlags={'MD':'\u{1F1F2}\u{1F1E9}','RO':'\u{1F1F7}\u{1F1F4}','US':'\u{1F1FA}\u{1F1F8}','DE':'\u{1F1E9}\u{1F1EA}'};
var _countryNamesRu={'Moldova':'\u041c\u043e\u043b\u0434\u043e\u0432\u0430','Romania':'\u0420\u0443\u043c\u044b\u043d\u0438\u044f'};
var COUNTRIES={};
var COUNTRY_ORDER=[];
function _initServers(servers){if(!servers||!servers.length)return;COUNTRIES={};COUNTRY_ORDER=[];servers.slice().sort(function(a,b){return a.name.localeCompare(b.name)}).forEach(function(s){COUNTRIES[s.name]={flag:_countryFlags[s.country]||'',name:_countryNamesRu[s.countryName]||s.countryName||s.name,serverIp:s.publicIp||'',country:s.country||'',address:s.address||''};COUNTRY_ORDER.push(s.name);});}

// ========== THEME ==========
// Весь кабинет — СВЕТЛАЯ тема по умолчанию (Дашборд/Финансы и так scoped-light в
// finance.css; тёмная тема для их контента не реализована, поэтому базовый вид —
// единый светлый). Тумблер оставлен рабочим и сохраняет выбор, дефолт = light.
function toggleTheme(){var t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=t;try{localStorage.setItem('pr_admin_theme',t)}catch(e){}if(typeof updateChartsTheme==='function')updateChartsTheme();}
(function(){var t='light';try{t=localStorage.getItem('pr_admin_theme')||'light';}catch(e){}document.documentElement.dataset.theme=t;})();

// getChartColors moved to /js/utils.js

// ========== AUTH ==========
function doLogin(){window.location.href='/'}
function doLogout(){api(API+'/api/logout',{method:'POST'});authToken='';localStorage.removeItem('pr_admin_token');localStorage.removeItem('pr_token');localStorage.removeItem('pr_login');window.location.href='/'}

// ========== NAV ==========
var _activeBankTab='overview';
var _bankEverRendered=false;
function switchBankNav(name){
  ['overview','acts','bills','payments'].forEach(function(t){
    var nav=document.getElementById('bnav_'+t);
    var secMap={overview:'bankOverviewSection',acts:'bankDocumentsSection',bills:'bankBillsSection',payments:'bankPaymentsSection'};
    var sec=document.getElementById(secMap[t]);
    if(nav)nav.classList.toggle('active',t===name);
    if(sec)sec.style.display=t===name?'':'none';
  });
  _activeBankTab=name;
  if(name==='overview'&&currentData)renderFinancesTabNew();
  else if(name==='acts'&&currentData)renderBankDocuments();
  else if(name==='bills'&&currentData)renderBankBills();
  else if(name==='payments'&&currentData)renderBankPayments();
}
var _activeSettingsSection='audit';
function switchSettingsSection(name){
  try{if(window.matchMedia('(max-width:480px)').matches){var _c=document.querySelector('.tab-sidebar-layout>div:last-child');if(_c)setTimeout(function(){_c.scrollIntoView({behavior:'smooth',block:'start'});},60);}}catch(_){}
  // recovery / proxycheck / data are three VIEWS of the shared settingsSection_data:
  // show that section and filter its cards by [data-subsec]. Cards without a
  // data-subsec belong to the «Данные и хранение» (data) view.
  var DATA_VIEWS={recovery:1,proxycheck:1,data:1};
  ['bank','audit','servers','syslog','serverHealth','simulator','operators','alerts','failover'].forEach(function(s){
    var sec=document.getElementById('settingsSection_'+s);
    if(sec)sec.style.display=s===name?'':'none';
  });
  var dataSec=document.getElementById('settingsSection_data');
  if(dataSec){
    dataSec.style.display=DATA_VIEWS[name]?'':'none';
    if(DATA_VIEWS[name]){
      dataSec.querySelectorAll('.analytics-card').forEach(function(c){
        var sub=c.getAttribute('data-subsec')||'data';
        c.style.display=sub===name?'':'none';
      });
    }
  }
  ['bank','data','audit','servers','syslog','serverHealth','simulator','operators','alerts','failover','recovery','proxycheck'].forEach(function(s){
    var nav=document.getElementById('snav_'+s);
    if(nav){nav.classList.toggle('active',s===name);}
  });
  _activeSettingsSection=name;
  localStorage.setItem('admin_settings_section',name);
  if(name==='audit')loadAuditLog();
  if(name==='servers')loadServersList();
  if(name==='syslog')loadSystemLog();
  if(name==='serverHealth')renderSysDashboard('serverHealthContent');
  if(name==='simulator')initSimulator();
  if(name==='operators')loadOperatorsMapping();
  if(name==='alerts')loadAlertRules();
  if(name==='failover'){loadFailoverSettings();loadFailoverCandidates();loadFailoverLog();}
}
function switchMainTab(name,el,auto){var nt=document.querySelector('.nav-tabs');if(nt)nt.classList.remove('burger-open');localStorage.setItem('admin_active_tab',name);document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active')});el.classList.add('active');document.getElementById('tab-'+name).classList.add('active');var sa=document.getElementById('modemSearchArea');if(sa)sa.style.display=name==='modems'?'flex':'none';if(name==='dashboard'){try{renderAccNew();}catch(e){console.error(e);}}if(name==='clients')renderClients();if(name==='analytics'){initAnalyticsSelectors();loadSettings();renderBankConfig();var ss=localStorage.getItem('admin_settings_section')||'serverHealth';switchSettingsSection(ss);if(typeof restoreRestartBanner==='function')restoreRestartBanner();}if(name==='bank'){if(!auto||!_bankEverRendered){_bankEverRendered=true;switchBankNav(_activeBankTab||'overview');}}if(name==='crm'){crmAutoLogin()}}

// ========== PHASE 3: SYSTEM TAB ==========
var _sysCharts = {};
// Recommended default period per sub-tab. Health shows 24h uptime (per SLA spec);
// rotations are short-term signal; forecast/capacity/IP need a long window.
var _sysDefaults = { health: 1, rotations: 7, ip: 30, forecast: 30, capacity: 30, dashboard: 7, logs: 7 };
// switchSysTab/refreshSysTab removed — the Система tab no longer exists.
// Its analytical sub-tabs (health/rotations/ip/forecast/capacity) are now
// served from Аналитика (see renderAccSubTab); Системный лог lives in
// Настройки → Состояние сервера; Логи доменов was removed entirely.
// KPI card. `accent` (optional) drives the left border + soft tinted bg —
// lets each Аналитика section (rotations / ip / capacity) have a distinct
// visual identity. Falls back to `color` if no explicit accent is given.
function _sysKpi(label, value, sub, color, accent){
  var stripe = accent || color || 'var(--accent)';
  // Tint background with the same accent at low opacity for subtle theming.
  // Works for both hex (#XXXXXX) and CSS vars by composing via color-mix.
  var bg = accent
    ? 'background:linear-gradient(135deg,'+_kpiTint(accent,0.10)+','+_kpiTint(accent,0.02)+');'
    : 'background:var(--bg-1);';
  return '<div style="position:relative;padding:14px 18px;'+bg+'border:1px solid var(--border);border-left:4px solid '+stripe+';border-radius:8px;flex:1;min-width:140px;box-shadow:0 1px 2px rgba(0,0,0,0.03)">'
    + '<div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;font-weight:600">'+label+'</div>'
    + '<div style="font-size:24px;font-weight:700;margin-top:6px;line-height:1.15;'+(color?'color:'+color:'color:var(--text-0)')+'">'+value+'</div>'
    + (sub ? '<div style="font-size:11px;color:var(--text-3);margin-top:4px">'+sub+'</div>' : '')
    + '</div>';
}
// Tint helper — turns '#3B9DD8' into an rgba() at the given alpha. Returns
// a CSS-color literal that can sit inside linear-gradient(). CSS vars get
// passed through untinted (browsers won't compute alpha for var() here).
function _kpiTint(c, a){
  if (typeof c !== 'string') return 'transparent';
  if (c.charAt(0) === '#' && (c.length === 7 || c.length === 4)) {
    var r, g, b;
    if (c.length === 7) { r=parseInt(c.slice(1,3),16); g=parseInt(c.slice(3,5),16); b=parseInt(c.slice(5,7),16); }
    else { r=parseInt(c.charAt(1)+c.charAt(1),16); g=parseInt(c.charAt(2)+c.charAt(2),16); b=parseInt(c.charAt(3)+c.charAt(3),16); }
    return 'rgba('+r+','+g+','+b+','+a+')';
  }
  return c;
}
// Reads the active period selector. Falls back across known selector IDs so
// the renderSys* functions work from the various Аналитика sub-tabs.
// Callers may pass an explicit id (preferred — avoids the wrong selector
// winning when multiple are present in DOM at once).
function _sysDays(explicitId){
  var ids = explicitId ? [explicitId] : ['sysModemsDays','sysIpcapDays'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && el.value) { var v = parseInt(el.value); if (!isNaN(v) && v > 0) return v; }
  }
  return 7;
}
function _sysLoader(){return '<div style="color:var(--text-3);padding:40px;text-align:center">Загрузка...</div>'}
function _sysError(msg){return '<div style="color:var(--danger);padding:20px">'+esc(msg)+'</div>'}

// ----- 3.1 Health -----
function renderSysHealth(targetId, daysId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  var days = _sysDays(daysId);
  api(API + '/api/analytics/modem_health?days='+days)
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var s = d.summary || {};
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Всего модемов', s.total || 0);
      h += _sysKpi('Здоровые', s.good || 0, '≥80 баллов', 'var(--success)');
      h += _sysKpi('Предупреждение', s.warn || 0, '50-79 баллов', 'var(--warning)');
      h += _sysKpi('Проблемные', s.bad || 0, '<50 баллов', 'var(--danger)');
      h += '</div>';
      h += '<div style="font-size:10px;color:var(--text-3);margin:0 0 8px 4px">Uptime рассчитан как доля активных часов за последние ' + (days*24) + ' ч (= '+days+' '+(days===1?'день':'д.')+')</div>';
      h += '<table style="width:100%;border-collapse:collapse;font-size:11px;background:var(--bg-1);border:1px solid var(--border);border-radius:8px;overflow:hidden">';
      h += '<thead><tr style="background:var(--bg-2);color:var(--text-2)">';
      h += '<th style="padding:8px 10px;text-align:left">Модем</th>';
      h += '<th style="padding:8px 10px;text-align:left">Сервер</th>';
      h += '<th style="padding:8px 10px;text-align:left">Оператор</th>';
      h += '<th style="padding:8px 10px;text-align:right">Uptime</th>';
      h += '<th style="padding:8px 10px;text-align:right">Латентность</th>';
      h += '<th style="padding:8px 10px;text-align:right">Ошибки</th>';
      h += '<th style="padding:8px 10px;text-align:right">Ротаций</th>';
      h += '<th style="padding:8px 10px;text-align:right">Трафик</th>';
      h += '<th style="padding:8px 10px;text-align:center">Здоровье</th>';
      h += '</tr></thead><tbody>';
      var sorted = (d.modems||[]).slice().sort(function(a,b){return a.health_score - b.health_score});
      sorted.forEach(function(m){
        var col = m.status === 'good' ? 'var(--success)' : m.status === 'warn' ? 'var(--warning)' : 'var(--danger)';
        h += '<tr>';
        h += '<td style="padding:6px 10px;font-weight:600">'+esc(m.nick)+'</td>';
        h += '<td style="padding:6px 10px;color:var(--text-2)">'+esc(m.server_name)+'</td>';
        h += '<td style="padding:6px 10px;color:var(--text-2)">'+esc(m.operator||'—')+'</td>';
        h += '<td style="padding:6px 10px;text-align:right">'+(m.uptime_pct||0)+'%</td>';
        h += '<td style="padding:6px 10px;text-align:right">'+fmtMs(m.latency_ms)+'</td>';
        h += '<td style="padding:6px 10px;text-align:right;'+(m.error_pct > 10 ? 'color:var(--danger);font-weight:600' : '')+'">'+(m.error_pct != null ? m.error_pct+'%' : '—')+'</td>';
        h += '<td style="padding:6px 10px;text-align:right">'+(m.rotations||0)+'</td>';
        h += '<td style="padding:6px 10px;text-align:right">'+(m.traffic_gb||0)+' GB</td>';
        h += '<td style="padding:6px 10px;text-align:center">'
          +'<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:'+col+';color:#fff;font-weight:700">'+m.health_score+'</span></td>';
        h += '</tr>';
      });
      h += '</tbody></table>';
      c.innerHTML = h;
    })
    .catch(function(e){c.innerHTML = _sysError(e.message)});
}

// ----- 3.2 Rotations -----
function renderSysRotations(targetId, daysId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  var days = _sysDays(daysId);
  api(API + '/api/analytics/rotations?days='+days)
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var s = d.summary || {};
      var ACC = '#3B9DD8';  // section accent — blue for Ротации
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Всего', s.total || 0, null, null, ACC);
      h += _sysKpi('Неуспешных', s.failed || 0, (s.total>0?Math.round(s.failed/s.total*100):0)+'% всех', s.failed > 0 ? 'var(--danger)' : null, ACC);
      h += _sysKpi('Успешность', (s.success_pct||0)+'%', null, s.success_pct>=95?'var(--success)':s.success_pct>=80?'var(--warning)':'var(--danger)', ACC);
      h += _sysKpi('Avg время', s.avg_sec != null ? s.avg_sec+' с' : '—', null, null, ACC);
      h += _sysKpi('Max время', s.max_sec != null ? s.max_sec+' с' : '—', null, null, ACC);
      h += '</div>';
      // Chart
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">Ротации по дням</div>';
      h += '<div style="height:220px"><canvas id="sysRotChart"></canvas></div>';
      h += '</div>';
      // Servers + Operators
      h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px">';
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">По серверам</div>';
      if (!d.per_server || !d.per_server.length) {
        h += '<div style="color:var(--text-3);padding:10px;text-align:center">Нет данных</div>';
      } else {
        h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px;text-align:left">Сервер</th><th style="padding:4px;text-align:right">Всего</th><th style="padding:4px;text-align:right">Failed</th><th style="padding:4px;text-align:right">Avg с</th><th style="padding:4px;text-align:right">Max с</th></tr></thead><tbody>';
        d.per_server.forEach(function(srv){
          h += '<tr><td style="padding:4px;font-weight:600">'+esc(srv.server_name||'—')+'</td><td style="padding:4px;text-align:right">'+srv.total+'</td><td style="padding:4px;text-align:right;'+(srv.failed>0?'color:var(--danger)':'')+'">'+srv.failed+'</td><td style="padding:4px;text-align:right;font-weight:600">'+(srv.avg_sec!=null?Math.round(srv.avg_sec*10)/10:'—')+'</td><td style="padding:4px;text-align:right;color:var(--text-2)">'+(srv.max_sec!=null?Math.round(srv.max_sec*10)/10:'—')+'</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</div>';
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">По операторам</div>';
      h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px;text-align:left">Оператор</th><th style="padding:4px;text-align:right">Всего</th><th style="padding:4px;text-align:right">Failed</th><th style="padding:4px;text-align:right">Avg с</th></tr></thead><tbody>';
      // Filter out unknown/empty operators — they don't tell us anything useful
      // and tend to dominate the table when there are flaky SIM detections.
      (d.per_operator||[]).filter(function(o){
        var op = String(o.operator || '').trim().toLowerCase();
        return op && op !== '—' && op !== 'unknown' && op !== '?';
      }).forEach(function(o){
        h += '<tr><td style="padding:4px">'+esc(o.operator)+'</td><td style="padding:4px;text-align:right">'+o.total+'</td><td style="padding:4px;text-align:right;'+(o.failed>0?'color:var(--danger)':'')+'">'+o.failed+'</td><td style="padding:4px;text-align:right">'+(o.avg_sec!=null?Math.round(o.avg_sec*10)/10:'—')+'</td></tr>';
      });
      h += '</tbody></table></div></div>';
      // Per-modem (full width — "Последние неудачи" block removed)
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">По модемам (топ-20 по avg)</div>';
      if (!d.per_modem || !d.per_modem.length) {
        h += '<div style="color:var(--text-3);padding:10px;text-align:center">Нет</div>';
      } else {
        var sortedPm = d.per_modem.slice().filter(function(m){return m.avg_sec!=null}).sort(function(a,b){return b.avg_sec - a.avg_sec}).slice(0,20);
        h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px;text-align:left">Модем</th><th style="padding:4px;text-align:left">Сервер</th><th style="padding:4px;text-align:right">Всего</th><th style="padding:4px;text-align:right">Avg с</th><th style="padding:4px;text-align:right">Max с</th></tr></thead><tbody>';
        sortedPm.forEach(function(m){
          h += '<tr><td style="padding:4px;font-weight:600">'+esc(m.nick)+'</td><td style="padding:4px;color:var(--text-2)">'+esc(m.server_name||'—')+'</td><td style="padding:4px;text-align:right">'+m.total+'</td><td style="padding:4px;text-align:right;font-weight:600">'+Math.round(m.avg_sec*10)/10+'</td><td style="padding:4px;text-align:right;color:var(--text-2)">'+(m.max_sec!=null?Math.round(m.max_sec*10)/10:'—')+'</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</div>';
      c.innerHTML = h;
      // Draw chart
      setTimeout(function(){
        var cv = document.getElementById('sysRotChart');
        if(!cv || !window.Chart) return;
        var cc = getChartColorsLight();
        var pd = d.per_day || [];
        _sysCharts.rot = newChartSafe(cv, {
          type: 'bar',
          data: {
            labels: pd.map(function(x){return x.date.slice(5)}),
            datasets: [
              {label:'Всего', data: pd.map(function(x){return x.total}), backgroundColor: '#3B9DD8', stack:'a'},
              {label:'Failed', data: pd.map(function(x){return x.failed}), backgroundColor: '#E04141', stack:'b'},
            ]
          },
          options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'top',labels:{color:cc.text,font:{size:10}}}},
            scales:{x:{stacked:false,ticks:{color:cc.text,font:{size:9}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:cc.text},grid:{color:cc.grid}}}}
        });
      }, 40);
    })
    .catch(function(e){c.innerHTML = _sysError(e.message)});
}

// ----- 3.3 IP analytics -----
function renderSysIp(targetId, daysId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  var days = _sysDays(daysId);
  api(API + '/api/analytics/ip_stats?days='+Math.max(days,7))
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var s = d.summary || {};
      var ACC = '#965AC8';  // section accent — purple for IP-аналитика
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Уникальных IP', s.unique_ips || 0, 'за '+d.days+'д', null, ACC);
      h += _sysKpi('Назначений', s.total_assignments || 0, null, null, ACC);
      h += _sysKpi('Reuse ratio', s.reuse_ratio || 0, 'assign/IP', null, ACC);
      h += _sysKpi('Средний lifetime', s.avg_lifetime_sec ? Math.round(s.avg_lifetime_sec/60)+' мин' : '—', null, null, ACC);
      h += _sysKpi('IP с повторами', s.reused_count || 0, null, null, ACC);
      h += _sysKpi('Подсетей/модем', (d.subnet_summary && d.subnet_summary.avg) || 0, 'макс '+((d.subnet_summary && d.subnet_summary.max) || 0)+' · /24', null, ACC);
      h += '</div>';
      // Pools
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">Пулы IP по серверам</div>';
      h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">Сервер</th><th style="padding:4px 8px;text-align:right">Уникальных IP</th><th style="padding:4px 8px;text-align:right">Назначений</th><th style="padding:4px 8px;text-align:right">Avg lifetime</th></tr></thead><tbody>';
      (d.pools||[]).forEach(function(p){
        h += '<tr><td style="padding:4px 8px;font-weight:600">'+esc(p.server)+'</td><td style="padding:4px 8px;text-align:right">'+p.ip_count+'</td><td style="padding:4px 8px;text-align:right">'+p.total_assignments+'</td><td style="padding:4px 8px;text-align:right">'+(p.avg_lifetime_sec ? Math.round(p.avg_lifetime_sec/60)+' мин' : '—')+'</td></tr>';
      });
      h += '</tbody></table></div>';
      if(_totalRows>rows.length) h += '<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:8px 4px 0" onclick="zMore(\'api\')">+ ещё '+(_totalRows-rows.length)+' за период</div>';
      // Reused
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">IP с повторным использованием</div>';
      if (!d.reused || !d.reused.length) {
        h += '<div style="color:var(--text-3);padding:10px">Нет повторов</div>';
      } else {
        h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">IP</th><th style="padding:4px 8px;text-align:right">Использований</th><th style="padding:4px 8px;text-align:right">Модемов</th><th style="padding:4px 8px;text-align:left">Первое</th><th style="padding:4px 8px;text-align:left">Последнее</th></tr></thead><tbody>';
        d.reused.slice(0, 50).forEach(function(r){
          h += '<tr><td style="padding:4px 8px;font-family:var(--font-mono)">'+esc(r.ip)+'</td><td style="padding:4px 8px;text-align:right">'+r.uses+'</td><td style="padding:4px 8px;text-align:right">'+r.modems+'</td><td style="padding:4px 8px">'+esc((r.first||'').slice(5,16))+'</td><td style="padding:4px 8px">'+esc((r.last||'').slice(5,16))+'</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</div>';
      // Подсети на модем — сколько разных /24 прокручивает каждый модем (диверсификация IP)
      var _sn = d.subnets || [];
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:14px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">Подсети на модем <span style="color:var(--text-3);text-transform:none">(/24 — чем больше, тем разнообразнее IP)</span></div>';
      if(!_sn.length){
        h += '<div style="color:var(--text-3);padding:10px">Нет данных</div>';
      } else {
        h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">Модем</th><th style="padding:4px 8px;text-align:left">Сервер</th><th style="padding:4px 8px;text-align:right">Подсетей /24</th><th style="padding:4px 8px;text-align:right">Уникальных IP</th></tr></thead><tbody>';
        _sn.forEach(function(x){
          h += '<tr><td style="padding:4px 8px;font-weight:600">'+esc(x.nick)+'</td><td style="padding:4px 8px;color:var(--text-2)">'+esc(x.server)+'</td><td style="padding:4px 8px;text-align:right;font-weight:600;color:'+ACC+'">'+x.subnets+'</td><td style="padding:4px 8px;text-align:right">'+x.ips+'</td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '</div>';
      c.innerHTML = h;
    })
    .catch(function(e){c.innerHTML = _sysError(e.message)});
}

// renderSysForecast removed — was used only by the deleted «Планирование» sub-tab.

// ----- 3.5 Capacity -----
function renderSysCapacity(targetId, daysId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  var days = _sysDays(daysId);
  api(API + '/api/analytics/capacity?days='+Math.max(days,7))
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var s = d.summary || {};
      var ACC = '#EF9F27';  // section accent — amber for Ёмкость
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Всего модемов', s.total_modems || 0, null, null, ACC);
      h += _sysKpi('Серверов', s.total_servers || 0, null, null, ACC);
      h += _sysKpi('Трафик (всего)', (s.total_gb||0) + ' GB', 'за ' + d.days + 'д', null, ACC);
      h += _sysKpi('Avg/модем', (s.avg_gb_per_modem||0) + ' GB', null, null, ACC);
      h += '</div>';
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:8px">Серверы</div>';
      h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:6px;text-align:left">Сервер</th><th style="padding:6px;text-align:right">Модемов</th><th style="padding:6px;text-align:right">Всего GB</th><th style="padding:6px;text-align:right">Avg/час</th><th style="padding:6px;text-align:right">Max/час</th><th style="padding:6px;text-align:right">Active дн.</th></tr></thead><tbody>';
      (d.servers||[]).forEach(function(srv){
        h += '<tr><td style="padding:6px;font-weight:600">'+esc(srv.server_name)+'</td><td style="padding:6px;text-align:right">'+srv.modems+'</td><td style="padding:6px;text-align:right">'+srv.total_gb+'</td><td style="padding:6px;text-align:right">'+srv.avg_hour_mb+' MB</td><td style="padding:6px;text-align:right">'+srv.max_hour_mb+' MB</td><td style="padding:6px;text-align:right">'+srv.active_days+'</td></tr>';
      });
      h += '</tbody></table></div>';
      // Growth
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">Рост парка модемов</div>';
      h += '<div style="height:180px"><canvas id="sysCapChart"></canvas></div>';
      h += '</div>';
      c.innerHTML = h;
      setTimeout(function(){
        var cv = document.getElementById('sysCapChart');
        if(!cv || !window.Chart) return;
        var cc = getChartColorsLight();
        var g = d.modem_growth || [];
        _sysCharts.cap = newChartSafe(cv, {
          type: 'line',
          data: { labels: g.map(function(x){return x.month}), datasets: [{label:'Модемов', data: g.map(function(x){return x.modems}), borderColor:'#3B9DD8', backgroundColor:'rgba(59,157,216,0.1)', fill:true, tension:.3}] },
          options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{ticks:{color:cc.text},grid:{display:false}},y:{beginAtZero:true,ticks:{color:cc.text},grid:{color:cc.grid}}}}
        });
      }, 40);
    })
    .catch(function(e){c.innerHTML = _sysError(e.message)});
}

// ----- 3.6 System dashboard -----
function renderSysDashboard(targetId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  api(API + '/api/admin/system_health')
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Uptime', Math.floor((d.uptime_sec||0)/3600)+'ч '+Math.floor(((d.uptime_sec||0)%3600)/60)+'мин');
      h += _sysKpi('DB', (d.db&&d.db.size_mb||0)+' MB');
      if(d.disk)h += _sysKpi('Диск', d.disk.free_gb+' ГБ своб.', d.disk.used_pct+'% занято из '+d.disk.total_gb+' ГБ', d.disk.used_pct>=85?'var(--danger)':(d.disk.used_pct>=75?'#D4880F':null));
      h += _sysKpi('Sessions', d.sessions || 0);
      h += _sysKpi('Memory RSS', (d.memory&&d.memory.rss_mb||0)+' MB', 'heap '+((d.memory&&d.memory.heap_mb)||0)+' MB');
      h += _sysKpi('API errors 24h', d.api_errors_24h || 0, null, d.api_errors_24h > 0 ? 'var(--danger)' : 'var(--success)');
      h += '</div>';
      // Errors chart
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">Ошибки/предупреждения за 7 дней</div>';
      h += '<div style="height:180px"><canvas id="sysErrChart"></canvas></div>';
      h += '</div>';
      // Recent critical
      h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">Последние события (error/warn)</div>';
      if (!d.recent_critical || !d.recent_critical.length) {
        h += '<div style="color:var(--text-3);padding:10px">Нет</div>';
      } else {
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;min-width:520px;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">Время</th><th style="padding:4px 8px;text-align:left">Уровень</th><th style="padding:4px 8px;text-align:left">Категория</th><th style="padding:4px 8px;text-align:left">Цель</th><th style="padding:4px 8px;text-align:left">Сообщение</th></tr></thead><tbody>';
        d.recent_critical.forEach(function(r){
          var col = r.level === 'error' ? 'color:var(--danger);font-weight:600' : 'color:var(--warning)';
          h += '<tr><td style="padding:4px 8px">'+esc((r.timestamp||'').slice(5,16))+'</td><td style="padding:4px 8px;'+col+'">'+esc(r.level)+'</td><td style="padding:4px 8px">'+esc(r.category||'')+'</td><td style="padding:4px 8px">'+esc(r.target||'')+'</td><td style="padding:4px 8px;color:var(--text-2);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.message)+'">'+esc(r.message||'')+'</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      h += '</div>';
      // Server downtime history (mig 035)
      if (d.server_downtime && d.server_downtime.length) {
        h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:14px">';
        h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">⚠ Недоступность серверов (история)</div>';
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;min-width:520px;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">Сервер</th><th style="padding:4px 8px;text-align:left">С</th><th style="padding:4px 8px;text-align:left">По</th><th style="padding:4px 8px;text-align:right">Длительность</th></tr></thead><tbody>';
        d.server_downtime.forEach(function(r){
          var mins = Math.round((r.duration_sec||0)/60);
          var dur = mins >= 60 ? (Math.floor(mins/60)+'ч '+(mins%60)+'м') : (mins+' мин');
          h += '<tr><td style="padding:4px 8px;font-weight:600">'+esc(r.server_name)+'</td><td style="padding:4px 8px">'+esc((r.down_from||"").slice(5,16).replace("T"," "))+'</td><td style="padding:4px 8px">'+esc((r.down_to||"").slice(5,16).replace("T"," "))+'</td><td style="padding:4px 8px;text-align:right;color:var(--danger);font-weight:600">'+dur+'</td></tr>';
        });
        h += '</tbody></table></div></div>';
      }
      c.innerHTML = h;
      setTimeout(function(){
        var cv = document.getElementById('sysErrChart');
        if(!cv || !window.Chart) return;
        var cc = getChartColorsLight();
        var e7 = d.errors_by_day || [];
        _sysCharts.err = newChartSafe(cv, {
          type: 'bar',
          data: { labels: e7.map(function(x){return x.date.slice(5)}), datasets: [
            {label:'Errors', data: e7.map(function(x){return x.errors}), backgroundColor:'#E04141'},
            {label:'Warnings', data: e7.map(function(x){return x.warns}), backgroundColor:'#F0A533'}
          ]},
          options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'top',labels:{color:cc.text,font:{size:10}}}}, scales:{x:{ticks:{color:cc.text,font:{size:9}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:cc.text},grid:{color:cc.grid}}}}
        });
      }, 40);
    })
    .catch(function(e){c.innerHTML = _sysError(e.message)});
}

// renderSysLogs and its helpers removed — domain log explorer dropped
// as part of System-tab consolidation (low-use research tool, duplicated
// Топ ресурсов).


// ========== DATA ==========
function updateServerDownBanner(cachedServers){
  var b=document.getElementById('serverDownBanner');
  if(!b)return;
  if(!cachedServers||!cachedServers.length){b.style.display='none';return;}
  var now=Date.now();
  var parts=cachedServers.map(function(s){
    var ageMin=Math.round((now-(s.cachedAt||now))/60000);
    return '<b>'+esc(s.name)+'</b> ('+(ageMin>0?ageMin+' мин назад':'недоступен')+')';
  });
  var noun=cachedServers.length===1?'Сервер':'Серверов недоступно: '+cachedServers.length+' —';
  document.getElementById('serverDownBannerText').innerHTML=noun+' '+parts.join(', ')+'. Последние данные показаны из кеша.';
  b.style.display='flex';
}
// AbortController so the auto-refresh interval (60s) doesn't pile up
// requests when one fetch is slow. Each call aborts the previous and
// also pauses while the tab is hidden (visibilitychange handler).
var _loadDataAbort=null;
// Transient network drop (RU↔Cloudflare leg occasionally swallows a response).
// Not a real outage — retry a couple times before surfacing it; the next
// auto-refresh recovers anyway, so we never toast a bare "Failed to fetch".
function _isNetErr(e){return !!e&&(e.name==='TypeError'||/Failed to fetch|NetworkError|Load failed|network/i.test(e.message||''));}
function _fetchRetry(url,opts,tries){
  tries=tries||3;
  return fetch(url,opts).catch(function(e){
    var aborted=opts&&opts.signal&&opts.signal.aborted;
    if(tries>1&&_isNetErr(e)&&!aborted){
      return new Promise(function(res){setTimeout(res,700);}).then(function(){return _fetchRetry(url,opts,tries-1);});
    }
    throw e;
  });
}
function loadData(){
  if(!authToken)return;
  if(document.hidden)return; // pause when tab not visible
  if(_loadDataAbort){try{_loadDataAbort.abort()}catch(_){}}
  _loadDataAbort=new AbortController();
  _armRefreshBar(); // restart the 10s countdown bar on every refresh (auto or manual)
  _fetchRetry(API+'/api/admin/data',{headers:{'X-Auth-Token':authToken},signal:_loadDataAbort.signal},3)
    .then(function(r){if(r.status===401){doLogout();throw new Error('x')}return _okJson(r)})
    .then(function(data){
      currentData=data;
      updateServerDownBanner(data.cachedServers);
      processData();renderServerFilter();renderTable();updateHeaderStats();populateAccClientFilter();
      document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('ru-RU');
      var _st=localStorage.getItem('admin_active_tab')||'dashboard';
      var _te=document.querySelector('.nav-tab[onclick*="\''+_st+'\'"]');if(_te)switchMainTab(_st,_te,true);
    })
    .catch(function(e){
      if(e.name==='AbortError')return; // superseded by newer fetch
      if(_isNetErr(e)||_isServerDownErr(e))return; // transient blip / backend restarting — next refresh recovers, don't nag
      if(e.message!=='x')showToast('Ошибка: '+e.message,'error');
    });
}
// Pause auto-refresh when tab hidden (saves bandwidth & DB load when admin minimised).
document.addEventListener('visibilitychange',function(){if(!document.hidden)loadData()});

// Keyboard shortcuts (Cmd/Ctrl + key). Listed in /? overlay.
document.addEventListener('keydown',function(e){
  // Skip if focus is in an input/textarea (don't hijack typing)
  var t=e.target,tag=t&&t.tagName;
  var inField=(tag==='INPUT'||tag==='TEXTAREA'||(t&&t.isContentEditable));
  var meta=(e.metaKey||e.ctrlKey);
  // Cmd+R / Ctrl+R intercepted by browser — use Cmd+Shift+R instead for forced reload.
  // Cmd+K: focus search-box in current tab
  if(meta&&(e.key==='k'||e.key==='K')){
    e.preventDefault();
    var sb=document.getElementById('modemSearch')||document.getElementById('searchBox')||document.getElementById('clientSearch');
    if(sb){sb.focus();sb.select()}
    return;
  }
  // / : focus search (only when not typing)
  if(!inField&&e.key==='/'){
    e.preventDefault();
    var sb2=document.getElementById('modemSearch')||document.getElementById('searchBox')||document.getElementById('clientSearch');
    if(sb2){sb2.focus()}
    return;
  }
  // Esc: close any open modal/panel (already wired in several places — this is the catch-all)
  if(e.key==='Escape'){
    document.querySelectorAll('.modal.show').forEach(function(m){m.classList.remove('show')});
    var np=document.getElementById('notifPanel');if(np&&np.style.display!=='none')np.style.display='none';
  }
  // ? : show shortcuts help
  if(!inField&&e.key==='?'){
    e.preventDefault();
    showToast('⌨️  Cmd+K — поиск · / — поиск · Esc — закрыть модалку','info',5000);
  }
});

function processData(){if(!currentData)return;_initServers(currentData.servers);var downSet={};(currentData.cachedServers||[]).forEach(function(s){downSet[s.name]=true;});var mm={},sa=currentData.status||[];for(var i=0;i<sa.length;i++){var m=sa[i],imei=m.modem_details?m.modem_details.IMEI:null;if(!imei)continue;mm[imei]={raw:m,server:m._server,_cached:!!m._cached,_serverDown:!!downSet[m._server],nick:m.modem_details.NICK||'',imei:imei,rawImei:imei.replace(/^S\d+_/,''),phone:m.modem_details.PHONE_NUMBER||'',model:m.modem_details.MODEL_SHOWN||m.modem_details.MODEL||'',uptime:m.modem_details.UDEV_UPTIME||0,notes:m.modem_details.NOTES||'',usbId:m.modem_details.USB_ID||'',extIp:(m.net_details?m.net_details.EXT_IP:'')||'',netType:(m.net_details?m.net_details.CurrentNetworkType:'')||'',signal:parseInt(m.net_details?m.net_details.SIGNAL_STRENGTH:'0')||0,operator:(function(){var r=(m.net_details?m.net_details.CELLOP:'')||'';var srv=m._server||'';var isRO=srv.indexOf('S2')===0||srv==='S2';var _c=r.toLowerCase().replace(/\s+/g,' ').trim();var n={'unite':'Moldtelecom','moldtelecom':'Moldtelecom','moldtelecom moldtelecom':'Moldtelecom','orange':isRO?'Orange RO':'Orange MD','orange ro':'Orange RO','orange md':'Orange MD','vodafone ro':'Vodafone RO','vodafone':'Vodafone RO'};return n[_c]||r})(),apn:(m.net_details?m.net_details.APN:'')||'',isTestPool:!!m.isTestPool,isOnline:!m._cached&&!downSet[m._server]&&(m.net_details?m.net_details.IS_ONLINE==='yes':false),isRotating:m.IS_ROTATED==='true',isRebooting:m.IS_REBOOTING==='true',state:m.STATE,connectionStatus:(m.net_details?m.net_details.ConnectionStatus:'')||'',timeToRotation:m.modem_details.TIME_TO_IP_ROTATION||'',autoRotation:m.modem_details.AUTO_IP_ROTATION||'',targetMode:m.modem_details.TARGET_MODE||'',ping:(m.net_details?m.net_details.ping_stats:'')||'',band:(function(){var b=(m.net_details?String(m.net_details.BAND||''):'').trim();return(b&&b!=='?')?b:''})(),simStatus:(m.net_details?String(m.net_details.SimStatus||'').toUpperCase().trim():''),httpRedirect:(function(){var r=m.net_details?m.net_details.HTTP_REDIRECT_IMPOSED:null;if(r==null)return false;var s=String(r).toLowerCase().trim();return!!s&&['no','null','0','false','none'].indexOf(s)<0})(),rebootScore:(function(){var r=m.modem_details?m.modem_details.REBOOT_SCORE:null;return(r!=null&&r!==''&&isFinite(+r))?Math.round(+r):null})(),isLocked:(m.IS_LOCKED===true||m.IS_LOCKED==='true'),msg:(function(){var b=m.MSGS;b=Array.isArray(b)?b.join('; '):(b||'');return [m.MSG||'',b].filter(Boolean).join('; ').trim()})(),webappDown:(function(){var b=m.MSGS;b=Array.isArray(b)?b.join(' '):(b||'');return /web ?app|not available|restart the modem/i.test(String(m.MSG||'')+' '+b)})(),pktLoss:(function(){var p=(m.net_details?m.net_details.ping_stats:'')||'';var mm=/(\d+)\s*%\s*loss/i.exec(p);return mm?parseInt(mm[1],10):null})(),connDead:(function(){var c=String((m.net_details?m.net_details.ConnectionStatus:'')||'').toLowerCase();return /disconnect|ppp_disc|no carrier|down/.test(c)})(),ports:[]}}
  var po=currentData.ports||{};for(var pi in po){if(mm[pi])mm[pi].ports=po[pi]}
  var bw=currentData.bandwidth||{};for(var mi in mm){var mod=mm[mi];for(var p=0;p<mod.ports.length;p++){var pt=mod.ports[p];if(bw[pt.portID])pt._bw=bw[pt.portID]}}
  // IP tracking & uptime tracking
  var ipt=currentData.ipTracking||{};
  var upt=currentData.uptimeTracking||{};
  var spt=currentData.speedtestLatest||{};
  var now=Date.now();
  for(var imei in mm){
    var m=mm[imei];
    // Stuck IP detection
    if(ipt[imei]){
      var sinceMs=now-ipt[imei].since;
      m.ipStuck=sinceMs>24*60*60*1000;
      m.ipSinceHours=Math.floor(sinceMs/3600000);
    }
    // Uptime percentage
    if(upt[imei]&&upt[imei].total_checks>0){
      m.uptimePct=(upt[imei].online_checks/upt[imei].total_checks*100).toFixed(1);
    }
    // Stage 18.9 — lastSeenMs is "когда модем последний раз был ОНЛАЙН",
    // not "когда мы последний раз poll'или". Прежняя версия брала last_check,
    // который теперь бампится и для offline-модемов (Stage 17.1 offline-tick) —
    // в итоге MD2_41 / MD2_48 (offline неделю) показывались как «отключён 5м назад».
    //
    // Strict policy: only set lastSeenMs if we actually KNOW the modem was
    // online at some point. Otherwise leave undefined and the UI will show
    // a plain «OFFLINE» pill (no false-recency).
    //   - last_online_check (Stage 18.9 timestamp) → primary
    //   - last_check ONLY IF online_checks > 0 — proves the modem has been
    //     alive at least once during tracking
    var _u = upt[imei];
    if(_u){
      var _online = _u.last_online_check;
      if(_online){
        var _to=Date.parse(_online);
        if(!isNaN(_to))m.lastSeenMs=_to;
      } else if(_u.last_check && (_u.online_checks||0) > 0){
        var _t=Date.parse(_u.last_check);
        if(!isNaN(_t))m.lastSeenMs=_t;
      }
      // else: leave m.lastSeenMs undefined → pill stays plain "OFFLINE"
    }
    // Latest speedtest
    if(spt[imei]){
      m.lastSpeedDl=spt[imei].download||0;
      m.lastSpeedUl=spt[imei].upload||0;
      m.lastSpeedDate=spt[imei].date||'';
      m.lowSpeed=!!spt[imei]._lowSpeed;
    }
  }
  // Proxy check summary: map by server_nick for fast lookup
  var pcs=currentData.proxyCheckSummary||{};
  var pcSummary=pcs.summary||[];
  var pcLast=pcs.last||[];
  var pcSumMap={};
  for(var pi=0;pi<pcSummary.length;pi++){var p=pcSummary[pi];pcSumMap[p.server_name+'_'+p.nick]={total:p.total_checks||0,avgMs:Math.round(p.avg_ms)||0,errors:p.error_count||0}}
  var pcLastMap={};
  for(var li=0;li<pcLast.length;li++){var l=pcLast[li];pcLastMap[l.server_name+'_'+l.nick]={connectMs:l.connect_ms,totalMs:l.total_ms,status:l.status_code,error:l.error,checkedAt:l.checked_at}}
  var pcConsecMap={},pcConsec=pcs.consec||[];for(var ci=0;ci<pcConsec.length;ci++){pcConsecMap[pcConsec[ci].server_name+'_'+pcConsec[ci].nick]=pcConsec[ci].consec||0}
  var pcTodayMap={},pcToday=pcs.today||[];for(var ti=0;ti<pcToday.length;ti++){var pt=pcToday[ti];pcTodayMap[pt.server_name+'_'+pt.nick]={total:pt.total_checks||0,errors:pt.error_count||0}}
  for(var imei in mm){
    var m=mm[imei],pKey=m.server+'_'+m.nick;
    var sm=pcSumMap[pKey];
    var lt=pcLastMap[pKey];
    m.pcAvgMs=sm?sm.avgMs:null;
    m.pcErrorPct=sm&&sm.total>0?Math.round((sm.errors||0)/sm.total*100):null;
    var td=pcTodayMap[pKey];
    m.pcChecksToday=td?td.total:0;
    m.pcErrToday=td?td.errors:0;
    m.pcErrorPctToday=td&&td.total>0?Math.round((td.errors||0)/td.total*100):null;
    m.pcLastMs=lt?lt.totalMs:null;
    m.pcLastError=lt?lt.error:null;
    m.pcConsecFails=pcConsecMap[pKey]||0;
    m.pcLastStatus=lt?lt.status:null;
    m.pcCheckedAt=lt?lt.checkedAt:null;
  }
  currentData._modemMap=mm;
  // Health scores are a separate analytical aggregate (7-day window). Loaded
  // once and cached in window._healthMap, keyed by server|nick. Refreshed
  // every 5 min in background — stale enough to be safe between dashboard polls.
  if (!window._healthMap || (Date.now() - (window._healthMapAt || 0)) > 5*60000) {
    loadHealthMap();
  }
}

// In-page confirm/prompt. Native confirm()/prompt() get permanently muted once
// the user ticks «не показывать диалоги» → they silently return null/false and
// every action (incl. the reboot password) breaks. These custom modals aren't
// subject to that browser suppression.
function uiDialog(o){return new Promise(function(resolve){var prev=document.getElementById('uiDlg');if(prev)prev.remove();var ov=document.createElement('div');ov.id='uiDlg';ov.className='ui-dlg-ov';ov.tabIndex=-1;var inp=o.input?'<input id="uiDlgInput" class="ui-dlg-input" type="'+(o.password?'password':'text')+'" autocomplete="off"'+(o.placeholder?' placeholder="'+esc(o.placeholder)+'"':'')+'>':'';ov.innerHTML='<div class="ui-dlg">'+(o.title?'<div class="ui-dlg-title">'+esc(o.title)+'</div>':'')+'<div class="ui-dlg-msg">'+String(o.message||'').split('\n').map(esc).join('<br>')+'</div>'+inp+'<div class="ui-dlg-btns"><button type="button" class="ui-dlg-btn" id="uiDlgC">Отмена</button><button type="button" class="ui-dlg-btn '+(o.danger?'ui-dlg-danger':'ui-dlg-ok')+'" id="uiDlgK">'+esc(o.okText||'OK')+'</button></div></div>';document.body.appendChild(ov);var f=document.getElementById('uiDlgInput');setTimeout(function(){(f||ov).focus()},30);var settled=false;function done(v){if(settled)return;settled=true;ov.remove();resolve(v)}document.getElementById('uiDlgC').onclick=function(){done(o.input?null:false)};document.getElementById('uiDlgK').onclick=function(){done(o.input?(f?f.value:''):true)};ov.addEventListener('mousedown',function(e){if(e.target===ov)done(o.input?null:false)});ov.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();done(o.input?(f?f.value:''):true)}else if(e.key==='Escape'){e.preventDefault();done(o.input?null:false)}})})}
function uiConfirm(msg,o){o=o||{};return uiDialog({title:o.title||'Подтверждение',message:msg,okText:o.okText||'Да',danger:o.danger})}
function uiPrompt(msg,o){o=o||{};return uiDialog({title:o.title||'',message:msg,input:true,password:o.password,placeholder:o.placeholder,okText:o.okText||'OK',danger:o.danger})}
function rnd(n){var c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',r='';for(var i=0;i<n;i++)r+=c[Math.floor(Math.random()*c.length)];return r}

function loadSpeedHistory(key){
  var area=document.getElementById('speedHistoryArea');
  if(!area){
    // After speedtest result: replace modal body with history view + back button
    var mb=document.getElementById('modalBody');if(!mb)return;
    var m=currentDetailModem;
    var backFn=m?'switchTab(\'history\',document.querySelector(\'.modal-tab[data-tab="history"]\'))':'';
    mb.innerHTML='<div style="padding:12px"><div style="margin-bottom:10px;display:flex;gap:6px;align-items:center">'
      +'<button class="btn btn-sm" onclick="'+backFn+'">← Назад</button>'
      +'<span style="font-size:11px;color:var(--text-2)">История скорости</span></div>'
      +'<div id="speedHistoryArea"></div></div>';
    area=document.getElementById('speedHistoryArea');
  }
  if(!area)return;
  area.innerHTML='<div style="color:var(--text-3);padding:8px">Загрузка...</div>';
  api(API+'/api/admin/speedtest_history').then(function(data){
    var entries=data[key]||[];
    if(!entries.length){area.innerHTML='<div style="color:var(--text-3);padding:8px">Нет истории для ключа «'+esc(key)+'»</div>';return}
    var h='<table class="log-table"><thead><tr><th>Дата</th><th>Download</th><th>Upload</th><th>Ping</th></tr></thead><tbody>';
    entries.slice().reverse().forEach(function(e){
      if(!Number(e.download)&&!Number(e.upload))return;
      h+='<tr><td>'+new Date(e.date).toLocaleString('ru-RU')+'</td><td style="color:var(--success)">'+Number(e.download).toFixed(1)+' Mbps</td><td style="color:var(--accent)">'+Number(e.upload).toFixed(1)+' Mbps</td><td>'+Number(e.ping).toFixed(0)+' ms</td></tr>';
    });
    area.innerHTML=h+'</tbody></table>';
  }).catch(function(e){area.innerHTML='<div style="color:var(--danger)">'+(esc(e.message))+'</div>'});
}

// ========== TRAFFIC TAB (PAN-OS ACC Style) ==========
var accPeriod='month';
var topHostsCache=null;
var topHostsCachePerPort=null;
var PALETTE=['#185FA5','#1D9E75','#D85A30','#7F77DD','#BA7517','#888780','#D4537E'];
var CHART_COLORS={
  incoming:{solid:'#378ADD',label:'Входящий'},
  outgoing:{solid:'#EF9F27',label:'Исходящий'},
  clients:['#185FA5','#1D9E75','#D85A30','#7F77DD','#BA7517','#888780','#D4537E'],
  categories:{
    'Социальные сети':'#185FA5','Поисковики':'#1D9E75','CDN/Облако':'#7F77DD',
    'Видео':'#D85A30','Реклама':'#BA7517','Мессенджеры':'#D4537E','Почта':'#E06B3C','Прочее':'#B4B2A9'
  },
  operators:['#378ADD','#1D9E75','#EF9F27','#7F77DD','#D85A30','#888780']
};
// Внешний HTML-тултип для всех графиков — единый стиль «Почасового трафика»:
// белая карточка r10 с тенью, приглушённый заголовок, цветная точка + подпись
// слева, значение жирным справа, разделитель перед футером-итогом. Читает
// стандартную модель tooltip (title/body/footer/labelColors), поэтому работает
// с любым графиком без переписывания их callbacks.
function updateChartsTheme(){if(document.getElementById('tab-traffic').classList.contains('active'))renderTrafficTab()}

// ========== TASK 13: BULK MODEM ACTIONS ==========
window._bulkSel={};
function updateBulkPanel(){
  var checks=document.querySelectorAll('.bulk-chk:checked');
  window._bulkSel={};
  checks.forEach(function(c){window._bulkSel[c.dataset.imei]={server:c.dataset.server,nick:c.dataset.nick}});
  var n=Object.keys(window._bulkSel).length;
  var panel=document.getElementById('bulkPanel');
  if(panel){panel.style.display=n>0?'flex':'none';var lbl=document.getElementById('bulkCountLabel');if(lbl)lbl.textContent=n}
  var allChk=document.getElementById('bulkSelectAll');
  if(allChk){var total=document.querySelectorAll('.bulk-chk').length;allChk.checked=n>0&&n===total;allChk.indeterminate=n>0&&n<total}
  // Sync per-server bulk checkboxes (tri-state: checked / unchecked / indeterminate)
  document.querySelectorAll('.srv-bulk-chk').forEach(function(scb){
    var srv=scb.dataset.server;
    var srvChks=document.querySelectorAll('.bulk-chk[data-server="'+srv+'"]');
    var srvSel =document.querySelectorAll('.bulk-chk[data-server="'+srv+'"]:checked');
    scb.checked       = srvChks.length>0 && srvSel.length===srvChks.length;
    scb.indeterminate = srvSel.length>0  && srvSel.length<srvChks.length;
  });
}
function bulkToggleAll(cb){
  var table=cb.closest('table');
  if(table){table.querySelectorAll('.bulk-chk').forEach(function(c){c.checked=cb.checked})}
  else{document.querySelectorAll('.bulk-chk').forEach(function(c){c.checked=cb.checked})}
  updateBulkPanel();
}
// Toggle bulk selection for all modems on a single server (only the visible
// ones — filters are already applied to the rendered .bulk-chk set).
function bulkToggleServer(srv,cb){
  document.querySelectorAll('.bulk-chk[data-server="'+srv+'"]').forEach(function(c){c.checked=cb.checked});
  updateBulkPanel();
}
function clearBulkSel(){
  window._bulkSel={};
  document.querySelectorAll('.bulk-chk').forEach(function(c){c.checked=false});
  document.querySelectorAll('.srv-bulk-chk').forEach(function(c){c.checked=false;c.indeterminate=false});
  var allChk=document.getElementById('bulkSelectAll');if(allChk){allChk.checked=false;allChk.indeterminate=false}
  var panel=document.getElementById('bulkPanel');if(panel)panel.style.display='none';
}
function bulkResetIp(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  confirmDialog('Сбросить IP для '+items.length+' модемов?',function(){
    var promises=items.map(function(imei){var s=window._bulkSel[imei];return api(API+'/api/admin/reset_ip',{method:'POST',json:{imei:imei,serverName:s.server}})});
    Promise.all(promises).then(function(){showToast('Сброс IP отправлен для '+items.length+' модемов','success');clearBulkSel();setTimeout(loadData,3000)}).catch(function(e){showToast('Ошибка: '+esc(e.message),'error')});
  },'Сбросить','Массовый сброс IP');
}
function bulkReboot(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  confirmDialog('Перезагрузить '+items.length+' модемов?',function(){
    var promises=items.map(function(imei){var s=window._bulkSel[imei];return api(API+'/api/admin/reboot',{method:'POST',json:{imei:imei,serverName:s.server}})});
    Promise.all(promises).then(function(){showToast('Ребут отправлен для '+items.length+' модемов','success');clearBulkSel();setTimeout(loadData,5000)}).catch(function(e){showToast('Ошибка: '+esc(e.message),'error')});
  },'Перезагрузить','Массовый ребут',true);
}

function bulkDelete(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  confirmDialog('Удалить '+items.length+' модем(ов) из дашборда?\n\nОфлайн/призрачные исчезнут навсегда. Физически живые вернутся при следующем опросе ProxySmart.',function(){
    // Удаляем по IMEI через синтетический port_id meta_<imei>. Параллельно —
    // Node однопоточный, мутации known_modems сериализуются, запись файла отражает
    // финальное состояние; так удаление пачки не тянется по одному запросу.
    var ok=0,fail=0;
    Promise.all(items.map(function(imei){var s=window._bulkSel[imei];
      return api(API+'/api/admin/modems/'+encodeURIComponent(s.server)+'/'+encodeURIComponent('meta_'+imei)+'?nick='+encodeURIComponent(s.nick||''),{method:'DELETE'})
        .then(function(r){if(r.ok)ok++;else fail++;}).catch(function(){fail++;});
    })).then(function(){
      showToast('Удалено модемов: '+ok+(fail?(' · ошибок: '+fail):''),fail&&!ok?'error':'success');
      clearBulkSel();setTimeout(loadData,300);
    });
  },'Удалить','Массовое удаление',true);
}

function bulkOsSpoof(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  // Collect all ports from selected modems
  var portsList=[];
  items.forEach(function(imei){
    var s=window._bulkSel[imei];
    var mm=currentData&&currentData._modemMap||{};
    // Find modem by rawImei
    for(var k in mm){if(mm[k].rawImei===imei&&mm[k].server===s.server){
      mm[k].ports.forEach(function(p){if(p.portID)portsList.push({serverName:s.server,portId:p.portID.replace(/^S\d+_/,''),label:mm[k].nick+'/'+p.portName})});
      break;
    }}
  });
  if(!portsList.length){showToast('Нет портов для изменения','error');return}
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=function(e){if(e.target===overlay)overlay.remove()};
  overlay.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:420px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)" onclick="event.stopPropagation()">'
    +'<h3 style="margin:0 0 12px;font-size:14px;color:var(--text-0)">🛡 OS Spoofing — '+portsList.length+' портов</h3>'
    +'<select id="bulkOsSelect" class="form-input" style="width:100%;margin-bottom:12px">'
    +'<option value="">--Выкл--</option>'
    +'<option value="android:1">android:1 (p0f)</option>'
    +'<option value="android:3" selected>android:3 (real, ~Linux)</option>'
    +'<option value="android:4">android:4 (Android 14)</option>'
    +'<option value="macosx:3">macOS:3</option>'
    +'<option value="macosx:4">macOS:4 (12.6/iPhone 13)</option>'
    +'<option value="macosx:5">macOS:5 (Ventura)</option>'
    +'<option value="ios:1">iOS:1 (p0f)</option>'
    +'<option value="ios:2">iOS:2 (real iPhone)</option>'
    +'<option value="ios:3">iOS:3 (iPhone 12 Pro Max)</option>'
    +'<option value="windows:1">Win:1 (Win10 Server)</option>'
    +'<option value="windows:4">Win:4 (Win10/11 Desktop)</option>'
    +'</select>'
    +'<div style="display:flex;gap:8px;justify-content:flex-end">'
    +'<button class="btn btn-sm" onclick="this.closest(\'div[style*=fixed]\').remove()">Отмена</button>'
    +'<button class="btn btn-primary btn-sm" id="bulkOsBtn">Применить</button>'
    +'</div></div>';
  document.body.appendChild(overlay);
  document.getElementById('bulkOsBtn').onclick=function(){
    var os=document.getElementById('bulkOsSelect').value;
    var btn=this;btn.disabled=true;btn.textContent='Применяю...';
    api(API+'/api/admin/bulk_os_spoof',{method:'POST',json:{ports:portsList,os:os}})
    .then(function(d){
      if(d.ok){showToast('OS Spoof установлен: '+d.updated+' портов'+(d.failed?' ('+d.failed+' ошибок)':''),'success');overlay.remove();clearBulkSel();setTimeout(loadData,3000)}
      else{showToast(d.error||'Ошибка','error');btn.disabled=false;btn.textContent='Применить'}
    }).catch(function(e){showToast(e.message,'error');btn.disabled=false;btn.textContent='Применить'});
  };
}

function bulkRotation(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  var modems=[];
  items.forEach(function(imei){var s=window._bulkSel[imei];modems.push({imei:imei,serverName:s.server})});
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=function(e){if(e.target===overlay)overlay.remove()};
  overlay.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:420px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)" onclick="event.stopPropagation()">'
    +'<h3 style="margin:0 0 12px;font-size:14px;color:var(--text-0)">⏱ Авторотация — '+modems.length+' модемов</h3>'
    +'<select id="bulkRotSelect" class="form-input" style="width:100%;margin-bottom:12px">'
    +'<option value="0">Выкл.</option>'
    +'<option value="5">5 мин</option>'
    +'<option value="10" selected>10 мин</option>'
    +'<option value="15">15 мин</option>'
    +'<option value="30">30 мин</option>'
    +'<option value="60">1 час</option>'
    +'<option value="120">2 часа</option>'
    +'<option value="240">4 часа</option>'
    +'<option value="480">8 часов</option>'
    +'<option value="720">12 часов</option>'
    +'<option value="1440">24 часа</option>'
    +'</select>'
    +'<div style="display:flex;gap:8px;justify-content:flex-end">'
    +'<button class="btn btn-sm" onclick="this.closest(\'div[style*=fixed]\').remove()">Отмена</button>'
    +'<button class="btn btn-primary btn-sm" id="bulkRotBtn">Применить</button>'
    +'</div></div>';
  document.body.appendChild(overlay);
  document.getElementById('bulkRotBtn').onclick=function(){
    var rot=document.getElementById('bulkRotSelect').value;
    var btn=this;btn.disabled=true;btn.textContent='Применяю...';
    api(API+'/api/admin/bulk_rotation',{method:'POST',json:{modems:modems,rotation:parseInt(rot)}})
    .then(function(d){
      if(d.ok){showToast('Ротация установлена: '+d.updated+' модемов'+(d.failed?' ('+d.failed+' ошибок)':''),'success');overlay.remove();clearBulkSel();setTimeout(loadData,3000)}
      else{showToast(d.error||'Ошибка','error');btn.disabled=false;btn.textContent='Применить'}
    }).catch(function(e){showToast(e.message,'error');btn.disabled=false;btn.textContent='Применить'});
  };
}

function bulkProxyCheck(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  var mm=currentData&&currentData._modemMap||{};
  var modems=[];
  items.forEach(function(imei){
    var s=window._bulkSel[imei];
    for(var k in mm){if(mm[k].rawImei===imei&&mm[k].server===s.server){modems.push({nick:mm[k].nick,server:s.server});break}}
  });
  if(!modems.length){showToast('Нет модемов для проверки','error');return}
  confirmDialog('Замерить задержку для '+modems.length+' модемов?\nМожет занять до '+Math.ceil(modems.length/10*15)+' сек.',function(){
    showToast('Замер задержки для '+modems.length+' модемов...','info');
    api(API+'/api/admin/proxy_check',{method:'POST',json:{modems:modems}})
    .then(function(d){
      if(!d.ok){showToast(d.error||'Ошибка','error');return}
      var checks=d.checks||[];var ok=0,err=0;
      checks.forEach(function(c){if(c.error)err++;else ok++});
      showToast('Замер завершён: '+ok+' ок, '+err+' ошибок','success');
      _proxyLogCache={};
      setTimeout(loadData,1000);
    }).catch(function(){showToast('Ошибка сети','error')});
  },'Замерить','Замер задержки прокси');
}

function bulkExport(){
  var items=Object.keys(window._bulkSel);if(!items.length)return;
  var mm=currentData&&currentData._modemMap||{};
  var proxies=[];
  items.forEach(function(imei){
    var s=window._bulkSel[imei];
    for(var k in mm){if(mm[k].rawImei===imei&&mm[k].server===s.server){
      var ci=COUNTRIES[mm[k].server]||{};
      var host=ci.serverIp||'';
      mm[k].ports.forEach(function(p){
        if(!p.HTTP_PORT||!p.LOGIN)return;
        proxies.push({host:host,http:p.HTTP_PORT,socks:p.SOCKS_PORT||'',login:p.LOGIN,pass:p.PASSWORD||'',nick:mm[k].nick,portName:p.portName||'',changeip:(p.RESET_SECURE_LINK||{}).URL||''});
      });
      break;
    }}
  });
  if(!proxies.length){showToast('Нет прокси для экспорта','error');return}
  // Modal
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.onclick=function(e){if(e.target===overlay)overlay.remove()};
  var proto='http';
  function renderExport(){
    var lines=proxies.map(function(p){var port=proto==='http'?p.http:p.socks;return p.login+':'+p.pass+'@'+p.host+':'+port});
    var txt=lines.join('\n');
    var content='<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;width:min(640px,100%);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.5)" onclick="event.stopPropagation()">'
      +'<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">'
      +'<div><span style="font-size:16px">📤</span> <strong style="font-size:14px">Экспорт прокси</strong> <span style="color:var(--text-2);font-size:12px">'+proxies.length+' шт.</span></div>'
      +'<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--text-1);font-size:13px;display:flex;align-items:center;justify-content:center">✕</button>'
      +'</div>'
      +'<div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      +'<div style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden">'
      +'<button id="aeHttp" style="padding:4px 12px;font-size:11px;cursor:pointer;border:none;background:'+(proto==='http'?'var(--accent)':'var(--bg-2)')+';color:'+(proto==='http'?'#fff':'var(--text-1)')+'" onclick="proto=\'http\';renderExport()">HTTP</button>'
      +'<button id="aeSocks" style="padding:4px 12px;font-size:11px;cursor:pointer;border:none;border-left:1px solid var(--border);background:'+(proto==='socks5'?'var(--accent)':'var(--bg-2)')+';color:'+(proto==='socks5'?'#fff':'var(--text-1)')+'" onclick="proto=\'socks5\';renderExport()">SOCKS5</button>'
      +'</div>'
      +'<span style="font-size:11px;color:var(--text-2)">Формат: login:pass@host:port</span>'
      +'</div>'
      +'<div style="padding:12px 20px;flex:1;overflow:auto"><textarea id="aeText" style="width:100%;height:300px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-0);resize:vertical" readonly>'+esc(txt)+'</textarea></div>'
      +'<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'
      +'<button class="btn btn-sm" onclick="copyText(document.getElementById(\'aeText\').value,this)">📋 Скопировать</button>'
      +'<button class="btn btn-primary btn-sm" onclick="var b=new Blob([document.getElementById(\'aeText\').value],{type:\'text/plain\'});var a=document.createElement(\'a\');a.href=URL.createObjectURL(b);a.download=\'proxies_\'+proto+\'.txt\';a.click()">💾 Скачать .txt</button>'
      +'</div></div>';
    overlay.innerHTML=content;
  }
  renderExport();
  document.body.appendChild(overlay);
}

// ========== NOTIFICATION BELL (Stage 18.15 rewrite) ==========
// Backed by /api/admin/notifications. Bell badge polls /badge each 30s;
// opening the panel does one full fetch with the current filter. Read /
// dismiss / read-all happen via POST endpoints — read-state is per-user
// in SQLite, so it survives cache clears and works across browsers.
// `generateNotifications()` is kept as a no-op stub so older callers don't
// blow up if something still references it.
window._notifs=[];
window._notifFilter='all';
window._notifLastFetchAt=0;
function generateNotifications(){ /* removed in Stage 18.15 — backend collector now owns this */ }
function timeAgo(ts){
  if(!ts)return'сейчас';
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC without
  // timezone. Browsers parse that as LOCAL — off by hours. Force UTC.
  if(typeof ts==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) ts=ts.replace(' ','T')+'Z';
  var ms=Date.now()-new Date(ts).getTime();
  if(ms<0)ms=0;
  var s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
  if(d>0)return d+'д назад';
  if(h>0)return h+'ч назад';
  if(m>0)return m+'м назад';
  return'только что';
}
// Light poll: just the count, no payloads. Updates the header badge.
function refreshNotifBadge(){
  api(API+'/api/admin/notifications/badge')
    .then(function(d){return (d&&d.__status>=400)?null:d})
    .then(function(d){
      if(!d)return;
      var unread=Number(d.unread)||0,crit=Number(d.unread_critical)||0;
      var badge=document.getElementById('notifBadge');
      if(!badge)return;
      badge.style.display=unread>0?'flex':'none';
      badge.textContent=unread>99?'99+':String(unread);
      badge.classList.toggle('is-critical',crit>0);
    })
    .catch(function(){});
}
// Full fetch, called when the panel opens or after a mutation.
function refreshNotifPanel(){
  var url=API+'/api/admin/notifications?filter='+encodeURIComponent(window._notifFilter)+'&limit=200';
  api(url)
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(d){
      window._notifs=Array.isArray(d.notifications)?d.notifications:[];
      window._notifLastFetchAt=Date.now();
      renderNotifPanel();
      refreshNotifBadge();
    })
    .catch(function(e){
      var list=document.getElementById('notifList');
      if(list)list.innerHTML='<div class="notif-empty" style="color:var(--danger)">Ошибка: '+esc(e.message)+'</div>';
    });
}
function setNotifFilter(name){
  if(window._notifFilter===name)return;
  window._notifFilter=name;
  document.querySelectorAll('#notifFilters .notif-filter').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-filter')===name);
  });
  refreshNotifPanel();
}
function renderNotifPanel(){
  var list=document.getElementById('notifList');if(!list)return;
  var notifs=window._notifs||[];
  // Filter chip counts — derive from already-fetched list when on 'all',
  // otherwise leave blank to avoid misleading counts.
  var unreadCount=notifs.filter(function(n){return !n.read_at}).length;
  var critCount=notifs.filter(function(n){return n.priority==='critical'&&!n.read_at}).length;
  var uc=document.getElementById('notifFilterUnreadCount');
  var cc=document.getElementById('notifFilterCritCount');
  if(uc)uc.textContent=unreadCount?unreadCount:'';
  if(cc)cc.textContent=critCount?critCount:'';
  if(!notifs.length){list.innerHTML='<div class="notif-empty">Нет уведомлений</div>';return}
  var iconForPrio={critical:'🚨',important:'⚠️',early:'ℹ️',info:'•'};
  var h='';
  notifs.forEach(function(n){
    var prio=n.priority||'info';
    var read=!!n.read_at;
    var icon=iconForPrio[prio]||'•';
    // First line of message: keep the original emoji (if any) by stripping
    // none; the rendered message already starts with one in most rules.
    h+='<div class="notif-item '+(read?'read':'unread')+'" data-id="'+n.id+'" onclick="onNotifClick(event,'+n.id+')">';
    h+='<span class="notif-item-strip notif-item-strip--'+prio+'"></span>';
    h+='<div class="notif-icon notif-icon--'+prio+'">'+icon+'</div>';
    h+='<div class="notif-body">';
    h+='<div class="notif-title">'+esc(n.title||'')+'</div>';
    h+='<div class="notif-text">'+(n.message||'').replace(/\n/g,'<br>')+'</div>';
    h+='<div class="notif-time">'+timeAgo(n.created_at)+'</div>';
    h+='</div>';
    h+='<button class="notif-dismiss" title="Скрыть" onclick="event.stopPropagation();dismissNotif('+n.id+')">×</button>';
    h+='</div>';
  });
  list.innerHTML=h;
}
function onNotifClick(ev, id){
  var n=(window._notifs||[]).find(function(x){return x.id===id});
  if(!n)return;
  // Mark read (optimistic) + persist
  if(!n.read_at){
    n.read_at=new Date().toISOString();
    api(API+'/api/admin/notifications/'+id+'/read',{method:'POST'}).catch(function(){});
  }
  // Navigate to source. Close panel first so the UI shift is visible.
  var p=document.getElementById('notifPanel');if(p)p.style.display='none';
  _notifNavigate(n);
  // Refresh badge async so the count drops.
  setTimeout(refreshNotifBadge,200);
}
// Decide which tab/drawer to open based on entity_kind + entity_id.
function _notifNavigate(n){
  if(!n||!n.entity_kind)return;
  try{
    if(n.entity_kind==='modem'){
      switchMainTab('modems');
      if(n.entity_id){
        // Try to find the modem by nick across servers and open its detail.
        var nick=String(n.entity_id);
        var found=null;
        var mm=currentData&&currentData._modemMap||{};
        for(var k in mm){if(mm[k]&&mm[k].nick===nick){found=mm[k];break;}}
        if(found&&typeof openDetailAtTab==='function')openDetailAtTab(nick,found.server,'health');
      }
    } else if(n.entity_kind==='client'){
      switchMainTab('clients');
      if(n.entity_id&&typeof showClientDetail==='function'){setTimeout(function(){showClientDetail(n.entity_id)},150);}
    } else if(n.entity_kind==='crm'){
      switchMainTab('crm');
    } else if(n.entity_kind==='payment'){
      switchMainTab('bank');
    } else {
      // system → settings → состояние сервера
      switchMainTab('analytics');
      if(typeof switchSettingsSection==='function')setTimeout(function(){switchSettingsSection('serverstate')},200);
    }
  } catch(_) { /* navigation is best-effort */ }
}
function dismissNotif(id){
  // Optimistic remove
  window._notifs=(window._notifs||[]).filter(function(n){return n.id!==id});
  renderNotifPanel();
  api(API+'/api/admin/notifications/'+id+'/dismiss',{method:'POST'})
    .finally(refreshNotifBadge);
}
function toggleNotifPanel(){
  var p=document.getElementById('notifPanel');if(!p)return;
  var open=p.style.display!=='none';
  p.style.display=open?'none':'flex';
  if(!open)refreshNotifPanel();
}
function markAllNotifRead(){
  api(API+'/api/admin/notifications/read-all',{method:'POST'})
    .then(function(){ refreshNotifPanel(); refreshNotifBadge(); })
    .catch(function(){});
}
function dismissReadOlderNotif(){
  api(API+'/api/admin/notifications/dismiss-read-older',{method:'POST'})
    .then(function(){ refreshNotifPanel(); refreshNotifBadge(); })
    .catch(function(){});
}
document.addEventListener('click',function(e){
  var panel=document.getElementById('notifPanel');var btn=document.getElementById('notifBtn');
  if(panel&&btn&&!panel.contains(e.target)&&!btn.contains(e.target))panel.style.display='none';
});
// Kick off polling once the page is logged-in. We piggy-back on the
// existing dashboard refresh tick, but also do an immediate fetch on load.
if(typeof window!=='undefined'){
  setTimeout(function(){ if(typeof authToken!=='undefined'&&authToken){refreshNotifBadge();} },1500);
  setInterval(function(){ if(typeof authToken!=='undefined'&&authToken){refreshNotifBadge();} },30000);
}

// Stage 18.16: bootstrap latency thresholds early. loadSettings() only runs
// when the user opens «Настройки», so before that _pcWarnMs/_pcBadMs sat at
// the hardcoded 500/2000 defaults — making the modem table flip latency
// colors (yellow→green or vice versa) the moment Settings was visited and
// the real thresholds (e.g. 1500/3000) finally loaded. Fetch them once on
// startup so colors are stable from the first render.
function _loadProxyCheckThresholds(){
  if(!authToken)return;
  api(API+'/api/admin/settings')
    .then(function(d){return (d&&d.__status>=400)?null:d})
    .then(function(s){
      if(!s)return;
      var warn=Number(s.proxy_check_warn_ms);
      var bad =Number(s.proxy_check_bad_ms);
      var changed=false;
      // `>0` (not `||`) so an explicit `0` doesn't silently revert to a default.
      if(warn>0&&warn!==_pcWarnMs){_pcWarnMs=warn;changed=true;}
      if(bad >0&&bad !==_pcBadMs ){_pcBadMs =bad; changed=true;}
      var ert=Number(s.error_rate_threshold);
      if(ert>0&&ert!==_errorRateThreshold){_errorRateThreshold=ert;changed=true;}
      // Stage 18.16: same bootstrap issue applies to stale_modem_hours — the
      // «Не в стат.» chip uses it to decide who's excluded from analytics.
      var smh=Number(s.stale_modem_hours);
      if(smh>0&&window._staleModemHours!==smh){window._staleModemHours=smh;changed=true;}
      if(changed&&currentData&&typeof renderTable==='function'){try{renderTable();}catch(_){}}
    })
    .catch(function(){});
}
if(typeof window!=='undefined'){
  setTimeout(_loadProxyCheckThresholds,300);
}

// ========== TASK 15: AUDIT LOG ==========
var _auditAllEntries=[];
var _auditFilter='all';
function loadAuditLog(){
  var el=document.getElementById('auditLogTable');if(!el)return;
  el.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Загрузка...</div>';
  api(API+'/api/admin/audit_log?limit=500')
    .then(function(d){_auditAllEntries=d.entries||[];renderAuditLog()})
    .catch(function(e){var el2=document.getElementById('auditLogTable');if(el2)el2.innerHTML='<div style="color:var(--danger);padding:12px;font-size:12px">Ошибка: '+esc(e.message)+'</div>'});
}
function setAuditFilter(f){
  _auditFilter=f;
  document.querySelectorAll('.audit-filter-btn').forEach(function(b){b.classList.toggle('active',b.dataset.f===f)});
  renderAuditLog();
}
function renderAuditLog(){
  var el=document.getElementById('auditLogTable');if(!el)return;
  var entries=_auditAllEntries.filter(function(e){
    var a=e.action||'';
    if(_auditFilter==='client')return a.startsWith('client_');
    if(_auditFilter==='admin')return !a.startsWith('client_');
    return true;
  });
  if(!entries.length){el.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Нет записей</div>';return}
  var h='<table class="log-table" style="width:100%"><thead><tr><th style="width:140px">Время</th><th style="width:90px">Пользователь</th><th style="width:140px">Действие</th><th style="width:110px">IP</th><th>Детали</th></tr></thead><tbody>';
  entries.forEach(function(e){
    var a=e.action||'';var actCls='audit-update';
    var isClient=a.startsWith('client_');
    if(a==='client_login')actCls='audit-create';
    else if(/creat|add|login/.test(a))actCls='audit-create';
    else if(/delet|remov/.test(a))actCls='audit-delete';
    else if(/billing|payment|charg|topup|reset_ip|set_rotation|export/.test(a))actCls='audit-billing';
    var ts=(e.timestamp||'').replace('T',' ').substring(0,16);
    // Resolve clientId → clientName if missing
    if(!e.clientName&&e.clientId&&currentData&&currentData.clients){var _fc=currentData.clients.find(function(c){return c.id===e.clientId});if(_fc)e.clientName=_fc.name}
    var details=[];
    if(e.clientName)details.push('<b>'+esc(e.clientName)+'</b>');
    else if(e.client_name)details.push(esc(e.client_name));
    if(e.note)details.push(esc(e.note));
    if(e.nick)details.push('модем: <b>'+esc(e.nick)+'</b>');
    if(e.minutes!==undefined)details.push('ротация: '+e.minutes+'м');
    if(e.amount!==undefined)details.push(e.amount+'₽');
    if(e.count!==undefined&&isClient)details.push(e.count+' записей');
    var skip={action:1,admin:1,timestamp:1,entity_type:1,entity_id:1,client_name:1,clientName:1,clientId:1,note:1,ip:1,nick:1,minutes:1,amount:1,count:1,portNameFilter:1,serverName:1,success:1};
    for(var k in e){if(!skip[k]&&e[k]!==null&&e[k]!==undefined&&e[k]!=='')details.push(esc(k)+': '+esc(String(e[k])))}
    h+='<tr><td style="font-size:10px;color:var(--text-2);font-family:monospace;white-space:nowrap">'+ts+'</td>';
    h+='<td style="font-size:11px">'+(isClient?'<span style="color:var(--accent)">👤</span> ':'')+esc(e.admin||'—')+'</td>';
    h+='<td><span class="audit-action '+actCls+'">'+esc(a.replace('client_',''))+'</span></td>';
    h+='<td style="font-family:var(--font-mono);font-size:10px;color:var(--text-2)">'+esc(e.ip||'—')+'</td>';
    h+='<td style="font-size:11px;color:var(--text-1)">'+details.join(' · ')+'</td></tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
}

// ========== SYSTEM LOG ==========
var _syslogTimer=null;
var _syslogEntries=[];
function loadSystemLog(){
  var el=document.getElementById('syslogTable');if(!el)return;
  var cat=document.getElementById('syslogCategory').value;
  var lvl=document.getElementById('syslogLevel').value;
  var days=parseInt(document.getElementById('syslogPeriod').value)||7;
  var from=new Date(Date.now()-days*86400000).toISOString();
  var url=API+'/api/admin/system_log?limit=500&from='+encodeURIComponent(from);
  if(cat)url+='&category='+encodeURIComponent(cat);
  if(lvl)url+='&level='+encodeURIComponent(lvl);
  api(url)
    .then(function(d){_syslogEntries=d.entries||[];renderSystemLog()})
    .catch(function(e){el.innerHTML='<div style="color:var(--danger);padding:12px;font-size:12px">Ошибка: '+esc(e.message)+'</div>'});
}
function renderSystemLog(){
  var el=document.getElementById('syslogTable');if(!el)return;
  if(!_syslogEntries.length){el.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Нет записей</div>';return}
  var catLabels={modem:'Модем',recovery:'Восст.',speedtest:'Speedtest',proxy_check:'Proxy',rotation:'Ротация',billing:'Биллинг',traffic:'Трафик',system:'Система'};
  var levelColors={info:'#6b7280',warn:'#d97706',error:'#dc2626'};
  var h='<table class="log-table" style="width:100%"><thead><tr><th style="width:130px">Время</th><th style="width:80px">Категория</th><th style="width:50px">Ур.</th><th style="width:120px">Действие</th><th style="width:100px">Цель</th><th>Сообщение</th></tr></thead><tbody>';
  _syslogEntries.forEach(function(e){
    var ts=(e.timestamp||'').replace('T',' ').substring(0,16);
    var cat=catLabels[e.category]||e.category;
    var lvlColor=levelColors[e.level]||'#6b7280';
    var lvlBg=e.level==='error'?'rgba(220,38,38,0.1)':e.level==='warn'?'rgba(217,119,6,0.1)':'transparent';
    h+='<tr style="background:'+lvlBg+'">';
    h+='<td style="font-size:10px;color:var(--text-2);font-family:monospace;white-space:nowrap">'+ts+'</td>';
    h+='<td style="font-size:10px"><span style="background:var(--bg-2);padding:2px 6px;border-radius:4px;font-size:10px">'+esc(cat)+'</span></td>';
    h+='<td style="font-size:10px;font-weight:600;color:'+lvlColor+'">'+esc(e.level)+'</td>';
    h+='<td style="font-size:11px;font-family:var(--font-mono);font-size:10px">'+esc(e.action||'')+'</td>';
    h+='<td style="font-size:11px">'+esc(e.target||'—')+'</td>';
    h+='<td style="font-size:11px;color:var(--text-1)">'+esc(e.message||'')+'</td>';
    h+='</tr>';
  });
  h+='</tbody></table>';
  el.innerHTML=h;
}
function toggleSyslogAutoRefresh(){
  if(_syslogTimer){clearInterval(_syslogTimer);_syslogTimer=null}
  if(document.getElementById('syslogAutoRefresh').checked){
    _syslogTimer=setInterval(function(){if(_activeSettingsSection==='syslog')loadSystemLog()},30000);
  }
}
toggleSyslogAutoRefresh();

// ========== CLIENTS TAB ==========
var _filterProblematic=false;var _clientFilter='all';
function toggleProblematicFilter(){
  _filterProblematic=!_filterProblematic;
  var btn=document.getElementById('btnFilterProblematic');
  if(btn)btn.classList.toggle('active',_filterProblematic);
  renderClients();
}
function renderClients(){
  if(!currentData)return;
  var cl=currentData.clients||[];
  var search=(document.getElementById('clientSearch')||{}).value||'';
  search=search.toLowerCase();
  var container=document.getElementById('clientCardList');
  if(!container)return;
  var pnm={};var map=currentData._modemMap||{};
  for(var imei in map){var mm=map[imei];mm.ports.forEach(function(p){if(p.portName){if(!pnm[p.portName])pnm[p.portName]=[];pnm[p.portName].push({nick:mm.nick,server:mm.server})}})}
  // Sort: active clients by monthly expense desc, inactive at bottom
  var charges=currentData.clientMonthCharges||{};
  cl=cl.slice().sort(function(a,b){
    var aActive=(a.modemCount||0)>0||(pnm[a.portName]||[]).length>0;
    var bActive=(b.modemCount||0)>0||(pnm[b.portName]||[]).length>0;
    if(aActive&&!bActive)return-1;
    if(!aActive&&bActive)return 1;
    var aCost=charges[a.id]||0;
    var bCost=charges[b.id]||0;
    return bCost-aCost;
  });
  // WP8: _mrr и эвристика expiring — из canonical clientRevenue30d (скользящие
  // 30 дней), а не месяц-ту-дейт: дневная норма расхода ch/30 теперь верна и
  // 1-го числа (месяц-ту-дейт давал пустой список expiring в начале месяца).
  var _cnt={all:0,active:0,debtors:0,expiring:0},_mrr=0;cl.forEach(function(c){var b=c.balance!==undefined?c.balance:0;var ch=((currentData.clientRevenue30d||{})[c.id]||0);var md=(pnm[c.portName]||[]).length;_cnt.all++;_mrr+=ch;if(b<0){_cnt.debtors++;}else{if(md>0)_cnt.active++;if(ch>0&&b/(ch/30)<5)_cnt.expiring++;}});
  var h='';var count=0;var colors=CHART_COLORS.clients;
  cl.forEach(function(c,i){
    var modems=pnm[c.portName]||[];
    if(search&&(c.name+' '+c.portName+' '+c.login+' '+(c.contact||'')+' '+(c.legalName||'')).toLowerCase().indexOf(search)===-1)return;
    var balance=c.balance!==undefined?c.balance:0;
    var _ch0=((currentData.clientRevenue30d||{})[c.id]||0);if(_clientFilter==='active'&&!(balance>=0&&modems.length>0))return;if(_clientFilter==='debtors'&&balance>=0)return;if(_clientFilter==='expiring'&&!(balance>=0&&_ch0>0&&balance/(_ch0/30)<5))return;
    count++;var bt=c.billingType||'per_gb';var price=c.price||0;
    var cost=Math.round(((currentData.clientMonthCharges||{})[c.id]||0)*100)/100;
    var monthGbLive=Math.round(((currentData.clientLiveMonthGb||{})[c.id]||0)*10)/10;
    var tariffLabel=price+(bt==='per_modem'?'\u20BD/мод':'\u20BD/\u0413\u0411');
    var ctLabel=(c.clientType||'legal')==='individual'?'Физ. лицо':'Юр. лицо';
    var balWarn='';
    var color=colors[(count-1)%colors.length];
    var isInactive=!modems.length;
    var _stp=balance<0?['ДОЛЖНИК','var(--danger)','#fff']:(c.billingPaused?['ПАУЗА','var(--warning)','#000']:(isInactive?['НЕТ МОДЕМОВ','var(--bg-3)','var(--text-2)']:['АКТИВЕН','var(--success)','#fff']));
    var stPill='<span style="font-size:9px;font-weight:600;color:'+_stp[2]+';background:'+_stp[1]+';padding:3px 9px;border-radius:6px;letter-spacing:.5px;white-space:nowrap">'+_stp[0]+'</span>';
    h+='<div class="client-card'+(isInactive?' client-card--inactive':'')+'">';
    // Header / balance / 2x2 stats / actions — mockup card layout
    var _nm=(c.name||'').replace(/^(ООО|ИП|ЗАО|АО|ПАО)\s*/i,'').replace(/["«»]/g,'').trim();
    var _ws=_nm.split(/\s+/).filter(Boolean);
    var _ini=((_ws.length>=2?(_ws[0].charAt(0)+_ws[1].charAt(0)):_nm.slice(0,2)).toUpperCase())||'?';
    var balColor=balance<0?'var(--danger)':(balance>0?'var(--success)':'var(--text-2)');
    var _balStr=Math.round(balance).toLocaleString('ru-RU')+' ₽'+balWarn;
    var _pm=modems.length;var _plw=(_pm%100>=11&&_pm%100<=14)?'модемов':(_pm%10===1?'модем':(_pm%10>=2&&_pm%10<=4?'модема':'модемов'));
    h+='<div style="padding:18px 18px">';
    h+='<div style="display:flex;align-items:center;gap:11px;margin-bottom:12px">';
    h+='<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0">'+esc(_ini)+'</div>';
    h+='<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:14px;color:var(--text-0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(c.name)+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+ctLabel+' · '+esc(c.login)+' · '+_pm+' '+_plw+'</div></div>';
    h+=stPill;
    h+='</div>';
    h+='<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text-2)">Баланс</span><span style="font-size:20px;font-weight:700;color:'+balColor+';font-family:var(--font-mono)">'+_balStr+'</span></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;margin-bottom:15px">';
    var ms=[['Тариф',tariffLabel,'var(--text-1)'],['Расход/мес',Math.round(cost).toLocaleString('ru-RU')+' ₽','var(--accent)'],['Трафик/мес',monthGbLive.toFixed(1)+' GB','var(--text-1)'],['Модемов',''+_pm,isInactive?'var(--text-3)':'var(--text-1)']];
    ms.forEach(function(m){h+='<div><div style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">'+m[0]+'</div><div style="font-size:13px;font-weight:600;color:'+m[2]+';font-family:var(--font-mono)">'+m[1]+'</div></div>';});
    h+='</div>';
    h+='<div style="display:flex;gap:6px">';
    h+='<button class="btn btn-sm btn-primary" onclick="renderClientDetail(\''+c.id+'\',\'payments\')" style="flex:1;font-size:11px;justify-content:center">Платежи</button>';
    h+='<button class="btn btn-sm" onclick="renderClientDetail(\''+c.id+'\')" style="flex:1;font-size:11px;justify-content:center" title="Детали и настройки">Детали</button>';
    h+='<button class="btn btn-sm" onclick="impersonateClient(\''+c.id+'\',\''+esc(c.name)+'\')" style="font-size:11px" title="Войти как клиент">👤</button>';
    h+='</div>';
    h+='</div>';
    // Expandable modems
    h+='<div id="clientCard_'+c.id+'" style="display:none;padding:0 16px 14px;border-top:1px solid var(--border)">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin:10px 0 8px">';
    h+='<span style="font-size:11px;font-weight:600;color:var(--text-0)">Модемы ('+modems.length+')</span>';
    h+='<button class="btn btn-sm" onclick="openAssignModemModal(\''+c.id+'\',\''+esc(c.portName)+'\')" style="font-size:9px;padding:1px 6px;background:var(--accent);color:#fff">+ Модем</button>';
    h+='</div>';
    if(modems.length){h+='<div style="display:flex;flex-wrap:wrap;gap:4px">';modems.forEach(function(md){var mn=md.nick+' ('+md.server+')';h+='<span class="client-modem-tag" style="display:inline-flex;align-items:center;gap:4px">'+esc(mn)+' <span onclick="unassignModem(\''+esc(mn)+'\',\''+esc(c.portName)+'\')" style="cursor:pointer;color:var(--danger);font-size:12px;line-height:1" title="Отвязать">&times;</span></span>';});h+='</div>';}
    else{h+='<div style="font-size:11px;color:var(--text-3)">Нет подключённых модемов</div>';}
    h+='<div id="paymentArea_'+c.id+'" style="margin-top:8px"></div>';
    h+='</div>';
    h+='</div>';
  });
  if(!count)h='<div style="text-align:center;padding:60px;color:var(--text-3);font-size:14px">Нет клиентов</div>';
  var summary=document.getElementById('clientSummary');
  if(summary)summary.textContent=count+' клиент'+(count===1?'':'ов');
  var _st=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};_st('clCntAll',_cnt.all);_st('clCntActive',_cnt.active);_st('clCntDebt',_cnt.debtors);_st('clCntExp',_cnt.expiring);var _me=document.getElementById('clMrrTotal');if(_me)_me.textContent=Math.round(_mrr).toLocaleString('ru-RU')+' ₽';
  container.innerHTML=h;
  // Update debt count badge on "Проблемные" button
  var debtCount=(currentData.clients||[]).filter(function(c){return(c.balance!==undefined?c.balance:0)<0}).length;
  var dcBadge=document.getElementById('debtCountBadge');
  if(dcBadge){if(debtCount>0){dcBadge.textContent=debtCount;dcBadge.style.display='';}else{dcBadge.style.display='none';}}
}
function toggleBankFields(){var el=document.getElementById('bankFieldsSection');if(el)el.style.display=(document.getElementById('cfClientType').value==='legal')?'':'none'}
function showClientForm(data){document.getElementById('clientFormId').value=data?data.id:'';document.getElementById('clientModalTitle').textContent=data?'Редактировать':'Новый клиент';document.getElementById('cfName').value=data?data.name:'';document.getElementById('cfPortName').value=data?data.portName:'';document.getElementById('cfLogin').value=data?data.login:'client_'+rnd(8);document.getElementById('cfPassword').value=data?'':rnd(12);document.getElementById('cfPassword').placeholder=data?'Без изменений':'';document.getElementById('cfContact').value=data?(data.contact||''):'';document.getElementById('cfBillingType').value=data?(data.billingType||'per_gb'):'per_gb';document.getElementById('cfPrice').value=data?(data.price||0):0;document.getElementById('cfNotes').value=data?(data.notes||''):'';document.getElementById('cfClientType').value=data?(data.clientType||'legal'):'legal';toggleBankFields();document.getElementById('cfInn').value=data?(data.inn||''):'';document.getElementById('cfKpp').value=data?(data.kpp||''):'';document.getElementById('cfLegalName').value=data?(data.legalName||''):'';document.getElementById('cfAddress').value=data?(data.address||''):'';document.getElementById('cfContractInfo').value=data?(data.contractInfo||''):'';document.getElementById('cfContractDate').value=data?((data.contractDate||'').slice(0,10)):'';document.getElementById('cfAutoActs').checked=data?(data.autoActs!==false):true;document.getElementById('cfAutoBills').checked=data?(data.autoBills!==false):true;document.getElementById('cfBillingPaused').checked=data?!!data.billingPaused:false;document.getElementById('cfAllowDebt').checked=data?!!data.allowDebt:false;document.getElementById('cfMaxDebt').value=data&&typeof data.maxDebt==='number'?data.maxDebt:'';document.getElementById('cfSlaUptime').value=data&&typeof data.slaUptimePct==='number'?data.slaUptimePct:99;document.getElementById('cfSlaLatency').value=data&&typeof data.slaMaxLatencyMs==='number'?data.slaMaxLatencyMs:1000;document.getElementById('cfSlaErrPct').value=data&&typeof data.slaMaxErrorPct==='number'?data.slaMaxErrorPct:5;document.getElementById('cfSlaAutoCredit').checked=data?!!data.slaAutoCredit:false;var apiSec=document.getElementById('cfApiKeySection');if(data&&data.apiKey){apiSec.style.display='block';document.getElementById('cfApiKey').value=data.apiKey}else{apiSec.style.display='none';document.getElementById('cfApiKey').value=''}document.getElementById('clientModal').classList.add('show')}
function closeClientModal(){document.getElementById('clientModal').classList.remove('show');currentOpsClientId=null;}
document.getElementById('clientModal').addEventListener('click',function(e){if(e.target===this)closeClientModal()});
function editClient(id){var c=(currentData.clients||[]).find(function(x){return x.id===id});if(c)showClientForm(c)}
function saveClient(){var id=document.getElementById('clientFormId').value;var maxDebtRaw=document.getElementById('cfMaxDebt').value;var slaUpRaw=document.getElementById('cfSlaUptime').value,slaLatRaw=document.getElementById('cfSlaLatency').value,slaErrRaw=document.getElementById('cfSlaErrPct').value;var d={name:document.getElementById('cfName').value,portName:document.getElementById('cfPortName').value,login:document.getElementById('cfLogin').value,password:document.getElementById('cfPassword').value,contact:document.getElementById('cfContact').value,billingType:document.getElementById('cfBillingType').value,price:document.getElementById('cfPrice').value,notes:document.getElementById('cfNotes').value,clientType:document.getElementById('cfClientType').value,inn:document.getElementById('cfInn').value,kpp:document.getElementById('cfKpp').value,legalName:document.getElementById('cfLegalName').value,address:document.getElementById('cfAddress').value,contractInfo:document.getElementById('cfContractInfo').value,contractDate:document.getElementById('cfContractDate').value,autoActs:document.getElementById('cfAutoActs').checked,autoBills:document.getElementById('cfAutoBills').checked,billingPaused:document.getElementById('cfBillingPaused').checked,allowDebt:document.getElementById('cfAllowDebt').checked,maxDebt:maxDebtRaw!==''?parseFloat(maxDebtRaw):undefined,slaUptimePct:slaUpRaw!==''?parseFloat(slaUpRaw):undefined,slaMaxLatencyMs:slaLatRaw!==''?parseInt(slaLatRaw):undefined,slaMaxErrorPct:slaErrRaw!==''?parseFloat(slaErrRaw):undefined,slaAutoCredit:document.getElementById('cfSlaAutoCredit').checked};if(!d.name||!d.portName||!d.login||(!id&&!d.password))return showToast('Заполните обязательные поля','error');api(API+(id?'/api/admin/clients/'+id:'/api/admin/clients'),{method:id?'PUT':'POST',json:d}).then(function(r){if(r.ok||r.client){showToast(id?'Обновлён':'Создан','success');closeClientModal();loadData()}else showToast(r.error,'error')}).catch(function(e){showToast(e.message,'error')})}
function deleteClient(id,name){confirmDialog('Удалить клиента «'+name+'»? Это действие нельзя отменить.',function(){api(API+'/api/admin/clients/'+id,{method:'DELETE'}).then(function(d){d.ok?showToast('Удалён','success'):showToast(d.error,'error');loadData()}).catch(function(e){showToast(esc(e.message),'error')});},'Удалить','Удалить клиента')}

function impersonateClient(id,name){
  api(API+'/api/admin/impersonate/'+id,{method:'POST'}).then(function(d){
    if(d.ok&&d.token){
      var url=window.location.origin+'/?impersonate='+encodeURIComponent(d.token);
      window.open(url,'_blank');
      showToast('Открыт ЛК '+name,'success');
    }else{showToast(d.error||'Ошибка','error')}
  }).catch(function(e){showToast(e.message,'error')})
}

// ========== PAYMENTS ==========
// ==================== ASSIGN/UNASSIGN MODEM ====================
function openAssignModemModal(clientId, clientPortName) {
  var overlay = document.createElement('div');
  overlay.id = 'assignModemOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = '<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:500px;max-height:80vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0;font-size:14px">Добавить модем клиенту</h3><button onclick="document.getElementById(\'assignModemOverlay\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-2)">&times;</button></div>' +
    '<div style="font-size:11px;color:var(--text-2);margin-bottom:8px">portName: <b>' + esc(clientPortName) + '</b></div>' +
    '<input id="assignModemSearch" class="form-input" placeholder="Поиск по нику модема..." style="width:100%;margin-bottom:8px;font-size:12px" oninput="filterAssignModemList()">' +
    '<div id="assignModemList" style="font-size:12px">Загрузка...</div></div>';
  // Defensive cleanup: remove any leftover assign-modem overlay from a prior
  // open() that was never closed (was leaking DOM nodes + listeners over time).
  document.querySelectorAll('.assign-modem-overlay').forEach(function(el){el.remove()});
  overlay.classList.add('assign-modem-overlay');
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  // Fetch available modems
  api(API + '/api/admin/available_modems')
    .then(function(data) {
      window._assignModemData = { modems: data.modems || [], clientPortName: clientPortName };
      renderAssignModemList();
    })
    .catch(function(e) { var c = document.getElementById('assignModemList'); if (c) c.innerHTML = '<div style="color:var(--danger);padding:8px">Ошибка: ' + esc(e.message) + '</div>'; });
}

function renderAssignModemList() {
  var data = window._assignModemData;
  if (!data) return;
  var search = (document.getElementById('assignModemSearch') || {}).value || '';
  search = search.toLowerCase();
  var container = document.getElementById('assignModemList');
  if (!container) return;

  // Filter: show unassigned or assigned to different client
  var modems = data.modems.filter(function(m) {
    if (search && m.nick.toLowerCase().indexOf(search) === -1) return false;
    return m.portName !== data.clientPortName; // hide already assigned to this client
  });

  if (!modems.length) { container.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:20px">Нет доступных модемов</div>'; return; }

  var h = '<table style="width:100%;border-collapse:collapse"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 8px;text-align:left;font-size:10px">Модем</th><th style="padding:6px 8px;text-align:left;font-size:10px">Сервер</th><th style="padding:6px 8px;text-align:left;font-size:10px">Текущий клиент</th><th style="padding:6px 8px;text-align:center;font-size:10px;width:80px"></th></tr></thead><tbody>';
  modems.forEach(function(m) {
    var assigned = m.portName || 'Свободен';
    var clr = m.portName ? 'var(--warning)' : 'var(--success)';
    h += '<tr>';
    h += '<td style="padding:6px 8px;font-weight:500">' + esc(m.nick) + '</td>';
    h += '<td style="padding:6px 8px;font-size:10px;color:var(--text-2)">' + esc(m.server) + '</td>';
    h += '<td style="padding:6px 8px;font-size:10px;color:' + clr + '">' + esc(assigned) + '</td>';
    h += '<td style="padding:6px 8px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:var(--accent);color:#fff" onclick="assignModem(\'' + esc(m.server) + '\',\'' + esc(m.portID) + '\',\'' + esc(data.clientPortName) + '\',\'' + esc(m.nick) + '\')">Назначить</button></td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  container.innerHTML = h;
}

function filterAssignModemList() { renderAssignModemList(); }

function assignModem(serverName, portID, newPortName, nick) {
  if (!confirm('Назначить ' + nick + ' клиенту ' + newPortName + '?')) return;
  api(API + '/api/admin/assign_modem',{method:'POST',json:{ serverName: serverName, portID: portID, newPortName: newPortName }})
    .then(function(d) {
      if (d.ok) {
        showToast(nick + ' назначен', 'success');
        var overlay = document.getElementById('assignModemOverlay');
        if (overlay) overlay.remove();
        loadData();
      } else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function unassignModem(nick, clientPortName) {
  if (!confirm('Отвязать ' + nick + ' от клиента?')) return;
  // Find modem portID by nick
  api(API + '/api/admin/available_modems')
    .then(function(data) {
      var modem = (data.modems || []).find(function(m) { return m.nick === nick && m.portName === clientPortName; });
      if (!modem) return showToast('Модем не найден', 'error');
      api(API + '/api/admin/assign_modem',{method:'POST',json:{ serverName: modem.server, portID: modem.portID, newPortName: '' }})
        .then(function(d) {
          if (d.ok) { showToast(nick + ' отвязан', 'success'); loadData(); }
          else showToast(d.error || 'Ошибка', 'error');
        }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// P0-2: addPayment/deletePayment removed — the per-client manual-payment UI was
// retired in favour of the Tochka bank flow + balance_adjust, so both were dead
// code (no callers). The backend delete-by-ledger-id route remains for API/future
// use (src/routes/clients.js: DELETE /clients/:id/payment/by-ledger/:ledgerDbId).

// ========== ANALYTICS ==========
function initAnalyticsSelectors(){}

// ========== UTILS ==========
function copyText(t,b){
  function onOk(){if(b){var o=b.innerHTML;b.innerHTML='\u2714';setTimeout(function(){b.innerHTML=o},1500)}showToast('Скопировано','info')}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(onOk).catch(doFallback)}else{doFallback()}
  function doFallback(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;left:-9999px;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');onOk()}catch(e){showToast('Ошибка копирования','error')}document.body.removeChild(a)}
}
function togglePass(el){if(el.classList.contains('revealed')){el.textContent='\u2022\u2022\u2022\u2022';el.classList.remove('revealed');el.style.color='';el.style.letterSpacing=''}else{el.textContent=el.dataset.pass;el.classList.add('revealed');el.style.color='var(--text-0)';el.style.letterSpacing='normal'}}
// showToast moved to /js/utils.js
var _confirmCb=null;
function showProblemPopup(label,key){
  var items=(window._problemData&&window._problemData[key])||[];
  if(!items.length)return;
  var h='<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1500;display:flex;align-items:center;justify-content:center" onclick="this.remove()">';
  h+='<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;min-width:340px;max-width:520px;max-height:70vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)" onclick="event.stopPropagation()">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="font-size:14px;font-weight:600;color:var(--text-0)">'+esc(label)+' <span style="color:var(--text-3);font-weight:400">('+items.length+')</span></span><button style="background:none;border:none;font-size:18px;color:var(--text-2);cursor:pointer;padding:0 4px" onclick="this.closest(\'div[style*=fixed]\').remove()">&times;</button></div>';
  h+='<div style="display:flex;flex-direction:column;gap:6px">';
  items.forEach(function(item){
    var n=item.nick||item;
    var detail=item.detail||'';
    h+='<div style="padding:8px 12px;background:var(--bg-2);border-radius:8px;border:1px solid var(--border);cursor:pointer" onclick="(function(){document.querySelector(\'div[style*=fixed]\').remove();var map=currentData&&currentData._modemMap;if(!map)return;for(var imei in map){var m=map[imei];if(m.nick===\''+esc(n)+'\'){currentDetailModem=m;document.getElementById(\'modalTitle\').textContent=m.nick+\' (\'+m.server+\')\';switchTab(\'info\',document.querySelector(\'.modal-tab[data-tab=info]\'));document.getElementById(\'detailModal\').classList.add(\'show\');break}}})()">';
    h+='<div style="font-size:12px;font-weight:500;color:var(--text-0);margin-bottom:2px">'+esc(n)+'</div>';
    if(detail)h+='<div style="font-size:11px;color:var(--text-2)">'+detail+'</div>';
    h+='</div>';
  });
  h+='</div></div></div>';
  document.body.insertAdjacentHTML('beforeend',h);
}
function confirmDialog(msg,onConfirm,okLabel,title,isDanger){
  var ov=document.getElementById('confirmOverlay');
  if(!ov)return;
  document.getElementById('confirmMsg').textContent=msg;
  document.getElementById('confirmTitle').textContent=title||'Подтверждение';
  var okBtn=document.getElementById('confirmOkBtn');
  okBtn.textContent=okLabel||'Удалить';
  okBtn.className='btn btn-sm '+(isDanger===false?'btn-primary':'btn-danger');
  _confirmCb=onConfirm;
  ov.style.display='flex';
  if(window._confirmEscHandler)document.removeEventListener('keydown',window._confirmEscHandler);
  window._confirmEscHandler=function(e){if(e.key==='Escape'){_confirmCancel();}};
  document.addEventListener('keydown',window._confirmEscHandler);
}
function _confirmOk(){var cb=_confirmCb;_confirmCb=null;document.getElementById('confirmOverlay').style.display='none';if(window._confirmEscHandler){document.removeEventListener('keydown',window._confirmEscHandler);window._confirmEscHandler=null;}if(cb)cb();}
function _confirmCancel(){_confirmCb=null;document.getElementById('confirmOverlay').style.display='none';if(window._confirmEscHandler){document.removeEventListener('keydown',window._confirmEscHandler);window._confirmEscHandler=null;}}
function updateHeaderStats(){
  if(!currentData||!currentData._modemMap)return;
  var map=currentData._modemMap,total=0,online=0,stale=0;
  // Stage 18.7+: modems offline > N hours are excluded from the Online/Total
  // counter per user spec. N is now configurable via Settings UI (default 12).
  // window._staleModemHours is set by loadSettings() — fall back to 12 before
  // settings load (matches backend default).
  //
  // Stage 18.9+: offline modems WITHOUT a known lastSeenMs (never been online
  // since we started tracking) are ALSO counted as stale — same as the backend
  // getStaleImeis() rule. Otherwise they'd silently stay in the «live» bucket
  // even though they've never responded.
  var STALE_MS = ((window._staleModemHours || 12)) * 3600 * 1000;
  for(var i in map){
    var m=map[i];
    var s=getModemStatus(m);
    var isOffline = (s==='offline');
    var hasTimestamp = !!m.lastSeenMs;
    var isStale =
      isOffline && (
        (hasTimestamp && (Date.now()-m.lastSeenMs > STALE_MS)) ||  // last seen >12h ago
        (!hasTimestamp)                                            // never seen alive
      );
    if(isStale){ stale++; continue; }
    total++;
    if(s==='online'||s==='rotating')online++;
  }
  // Stage 18.20 — «Клиентов: N» moved out of the header into the Клиенты
  // tab toolbar (renderClients already populates #clientSummary). Top bar
  // shows just the Online ratio now.
  // BOTH numbers come from the backend `fleet` (computed from one source) so the
  // ratio is always consistent — online ≤ total. Fall back to the local live
  // counts only if `fleet` is missing, and clamp so we never show online>total.
  var _fl=currentData.fleet||{};
  // Headline counts «рабочих»: онлайн сейчас + короткие блипы (<10 мин). Число
  // держится на parke и падает только при реальном отключении >10 мин, поэтому
  // не моргает на каждой ротации. Мгновенный live-онлайн остаётся в подсказке.
  var _flLive=(_fl.online!=null)?_fl.online:online;
  var _flWorking=(_fl.working!=null)?_fl.working:_flLive;
  var _flTotal=(_fl.total!=null)?_fl.total:total;
  if(_flTotal<_flWorking)_flTotal=_flWorking;
  var _flDown=Math.max(0,_flTotal-_flWorking);          // отключено >10 мин
  var _flBlip=Math.max(0,_flWorking-_flLive);           // молчат <10 мин (блип)
  var title='В парке: '+_flTotal+' · рабочих: '+_flWorking+' (онлайн сейчас '+_flLive+', блипов '+_flBlip+') · отключено >10м: '+_flDown;
  document.getElementById('headerStats').innerHTML='<div class="stat-badge" title="'+title+'">В работе: <span style="color:var(--success)">'+_flWorking+'</span>/<span>'+_flTotal+'</span></div>';
}
// Top progress bar = countdown to next auto-refresh. Pure CSS transition: snap to
// 0 (no transition), force reflow, then animate to 100% over REFRESH_MS linearly.
// Re-armed at the start of every loadData (auto or manual), so it always reflects
// the time left until the next refresh.
function _armRefreshBar(){var bar=document.getElementById('refreshBar');if(!bar)return;bar.style.transition='none';bar.style.width='0%';void bar.offsetWidth;bar.style.transition='width '+REFRESH_MS+'ms linear';bar.style.width='100%';}
function startAutoRefresh(){if(autoRefreshTimer)clearInterval(autoRefreshTimer);_armRefreshBar();autoRefreshTimer=setInterval(loadData,REFRESH_MS)}

// ========== PRICING TIERS ==========
function uploadDocument(clientId){
  var fileInput=document.getElementById('docFile_'+clientId);
  if(!fileInput||!fileInput.files.length){showToast('Выберите файл','error');return}
  var file=fileInput.files[0];
  var reader=new FileReader();
  reader.onload=function(e){
    var base64=e.target.result.split(',')[1];
    api(API+'/api/admin/clients/'+clientId+'/document',{method:'POST',json:{name:file.name,fileBase64:base64,mimeType:file.type}}).then(function(d){
      if(d.ok){showToast('Документ загружен','success');loadData()}else showToast(d.error||'Ошибка','error');
    }).catch(function(e){showToast(e.message,'error')});
  };
  reader.readAsDataURL(file);
}
function deleteDocument(clientId,docId){
  if(!confirm('Удалить документ?'))return;
  api(API+'/api/admin/clients/'+clientId+'/document/'+docId,{method:'DELETE'}).then(function(d){
    if(d.ok){showToast('Удалён','success');loadData()}else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message||'Ошибка сети','error')});
}

// ========== CLIENT OPERATIONS MODAL ==========
var currentOpsClientId = null;

function openClientOpsModal(clientId, tab) {
  currentOpsClientId = clientId;
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  document.getElementById('clientOpsTitle').textContent = client ? client.name : 'Клиент';
  document.getElementById('clientOpsModal').classList.add('show');
  switchOpsTab(tab || 'history');
}

function closeClientOpsModal() {
  document.getElementById('clientOpsModal').classList.remove('show');
  currentOpsClientId = null;
}
document.getElementById('clientOpsModal').addEventListener('click', function(e) { if (e.target === this) closeClientOpsModal(); });

function switchOpsTab(tab) {
  document.getElementById('opsTab_history').classList.toggle('active', tab === 'history');
  document.getElementById('opsTab_documents').classList.toggle('active', tab === 'documents');
  document.getElementById('opsTab_api').classList.toggle('active', tab === 'api');
  document.getElementById('opsTab_sla').classList.toggle('active', tab === 'sla');
  if (tab === 'history') renderOpsHistory(currentOpsClientId);
  else if (tab === 'documents') renderOpsDocuments(currentOpsClientId);
  else if (tab === 'api') renderOpsApi(currentOpsClientId);
  else if (tab === 'sla') renderOpsSla(currentOpsClientId);
}

function renderOpsSla(clientId) {
  var body = document.getElementById('clientOpsBody');
  body.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:40px;text-align:center">Загрузка...</div>';
  api(API + '/api/admin/clients/' + clientId + '/sla')
    .then(function(d) {
      if (d.error) { body.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(d.error) + '</div>'; return; }
      var m = d.metrics || {};
      var t = d.thresholds || {};
      var statusColor = d.status === 'breach' ? 'var(--danger)' : d.status === 'ok' ? 'var(--success)' : 'var(--text-3)';
      var statusLbl = d.status === 'breach' ? '⚠ Нарушение SLA' : d.status === 'ok' ? '✓ В норме' : '— Нет данных';
      var h = '<div style="padding:12px 16px;background:var(--bg-3);border-radius:8px;margin-bottom:12px;text-align:center">';
      h += '<div style="font-size:14px;font-weight:700;color:' + statusColor + '">' + statusLbl + '</div>';
      h += '</div>';
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:10px;margin-bottom:16px">';
      function slaTile(label, actual, expected, isOk) {
        var col = actual == null ? 'var(--text-3)' : isOk ? 'var(--success)' : 'var(--danger)';
        return '<div style="padding:12px;background:var(--bg-3);border-radius:8px">'
          + '<div style="font-size:10px;color:var(--text-2);text-transform:uppercase">' + label + '</div>'
          + '<div style="font-size:20px;font-weight:700;margin-top:4px;color:' + col + '">' + (actual == null ? '—' : actual) + '</div>'
          + '<div style="font-size:10px;color:var(--text-3);margin-top:2px">SLA: ' + expected + '</div>'
          + '</div>';
      }
      h += slaTile('Uptime', m.uptime_pct != null ? m.uptime_pct + '%' : null, '≥ ' + t.uptime_pct + '%', m.uptime_pct != null && m.uptime_pct >= t.uptime_pct);
      h += slaTile('Задержка', fmtMs(m.avg_latency_ms), '≤ ' + fmtMsShort(t.max_latency_ms), m.avg_latency_ms != null && m.avg_latency_ms <= t.max_latency_ms);
      h += slaTile('Ошибки', m.error_pct != null ? m.error_pct + '%' : null, '≤ ' + t.max_error_pct + '%', m.error_pct != null && m.error_pct <= t.max_error_pct);
      h += '</div>';
      h += '<div style="font-size:10px;color:var(--text-3);margin-bottom:10px;text-align:center">Uptime рассчитан за последние ' + (m.uptime_window_days || 30) + ' дней · задержка и ошибки за 24 часа</div>';
      h += '<div style="padding:10px 14px;background:var(--bg-2);border-radius:6px;margin-bottom:12px;font-size:11px;color:var(--text-2)">Авто-кредит: ' + (t.auto_credit ? '<span style="color:var(--success);font-weight:600">включён</span>' : '<span style="color:var(--text-3)">выключен</span>') + '</div>';
      h += '<div style="font-size:11px;color:var(--text-2);margin:0 0 6px 4px;text-transform:uppercase;letter-spacing:.05em">История нарушений</div>';
      if (!d.violations || !d.violations.length) {
        h += '<div style="color:var(--text-3);padding:20px;text-align:center">Нет нарушений</div>';
      } else {
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2)">Дата</th><th style="padding:6px 10px;text-align:left;color:var(--text-2)">Метрика</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Факт</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Норма</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Кредит</th></tr></thead><tbody>';
        d.violations.forEach(function(v) {
          h += '<tr><td style="padding:5px 10px">' + esc(v.date) + '</td><td style="padding:5px 10px;font-weight:600;color:var(--warning)">' + esc(v.metric) + '</td><td style="padding:5px 10px;text-align:right;color:var(--danger)">' + v.actual + '</td><td style="padding:5px 10px;text-align:right;color:var(--text-3)">' + v.expected + '</td><td style="padding:5px 10px;text-align:right;' + (v.credited_amount > 0 ? 'color:var(--success);font-weight:600' : '') + '">' + (v.credited_amount > 0 ? '+' + v.credited_amount : '—') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      body.innerHTML = h;
    })
    .catch(function(e) { body.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(e.message) + '</div>'; });
}

function renderOpsApi(clientId) {
  var body = document.getElementById('clientOpsBody');
  body.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:40px;text-align:center">Загрузка...</div>';
  var days = window._opsApiDays || 7;
  api(API + '/api/admin/api_usage?client_id=' + encodeURIComponent(clientId) + '&days=' + days + '&limit=50')
    .then(function(d) {
      if (d.error) { body.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(d.error) + '</div>'; return; }
      var s = d.summary || {};
      var h = '';
      // Header: period selector + status
      h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">';
      h += '<div style="display:flex;gap:4px">';
      [1,7,30].forEach(function(n){
        var active = n === days;
        h += '<button class="btn btn-sm" onclick="_opsApiDays=' + n + ';renderOpsApi(\'' + clientId + '\')" style="padding:3px 10px;font-size:11px;' + (active ? 'background:var(--accent);color:#fff' : 'background:var(--bg-3);color:var(--text-1)') + '">' + n + 'д</button>';
      });
      h += '</div>';
      var statusCol = d.active_24h ? 'var(--success)' : 'var(--text-3)';
      var statusLbl = d.active_24h ? '● Активен (' + d.requests_24h + ' запр./24ч)' : '○ Не использует API';
      h += '<span style="margin-left:auto;color:' + statusCol + ';font-size:12px;font-weight:600">' + statusLbl + '</span>';
      h += '</div>';

      // KPIs
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr));gap:10px;margin-bottom:12px">';
      var kpi = function(label, val, sub) {
        return '<div style="padding:10px;background:var(--bg-3);border-radius:8px">'
          + '<div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">' + label + '</div>'
          + '<div style="font-size:18px;font-weight:700;color:var(--text-0);margin-top:4px">' + val + '</div>'
          + (sub ? '<div style="font-size:10px;color:var(--text-3);margin-top:2px">' + sub + '</div>' : '')
          + '</div>';
      };
      h += kpi('Запросов', s.total || 0, 'за ' + days + 'д');
      h += kpi('Ошибок', (s.errors || 0) + ' (' + (s.error_rate_pct || 0) + '%)', '');
      h += kpi('Avg response', fmtMs(s.avg_response_ms), '');
      var lastReqLbl = '—';
      if (s.last_request) {
        try { lastReqLbl = new Date(s.last_request.replace(' ','T')+'Z').toLocaleString('ru-RU', {timeZone:'Europe/Moscow'}); } catch(e) {}
      }
      h += kpi('Последний', lastReqLbl, '');
      h += '</div>';

      // Chart (per-day request count)
      h += '<div style="background:var(--bg-3);border-radius:8px;padding:10px;margin-bottom:12px">';
      h += '<div style="font-size:11px;color:var(--text-2);margin-bottom:6px">Запросы по дням</div>';
      h += '<div style="height:120px"><canvas id="opsApiChart"></canvas></div>';
      h += '</div>';

      // Per-endpoint
      if (d.per_endpoint && d.per_endpoint.length) {
        h += '<div style="font-size:11px;color:var(--text-2);margin:0 0 6px 4px;text-transform:uppercase;letter-spacing:.05em">Endpoint\'ы</div>';
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:12px">';
        h += '<thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2)">Endpoint</th><th style="padding:6px 10px;text-align:center;color:var(--text-2)">Method</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Запросов</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Ошибок</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">Avg ms</th></tr></thead><tbody>';
        d.per_endpoint.forEach(function(r) {
          h += '<tr><td style="padding:5px 10px;font-family:var(--font-mono);color:var(--accent)">' + esc(r.endpoint) + '</td>';
          h += '<td style="padding:5px 10px;text-align:center">' + esc(r.method) + '</td>';
          h += '<td style="padding:5px 10px;text-align:right">' + r.count + '</td>';
          h += '<td style="padding:5px 10px;text-align:right;' + (r.errors > 0 ? 'color:var(--danger);font-weight:600' : '') + '">' + (r.errors || 0) + '</td>';
          h += '<td style="padding:5px 10px;text-align:right">' + (r.avg_ms != null ? Math.round(r.avg_ms) : '—') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }

      // Recent requests
      h += '<div style="font-size:11px;color:var(--text-2);margin:0 0 6px 4px;text-transform:uppercase;letter-spacing:.05em">Последние запросы</div>';
      if (!d.recent || !d.recent.length) {
        h += '<div style="color:var(--text-3);padding:20px;text-align:center">Нет записей</div>';
      } else {
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2)">Время</th><th style="padding:6px 10px;text-align:left;color:var(--text-2)">Endpoint</th><th style="padding:6px 10px;text-align:center;color:var(--text-2)">Статус</th><th style="padding:6px 10px;text-align:right;color:var(--text-2)">ms</th><th style="padding:6px 10px;text-align:left;color:var(--text-2)">IP</th></tr></thead><tbody>';
        d.recent.forEach(function(r) {
          var tsStr = r.timestamp;
          try { tsStr = new Date(r.timestamp.replace(' ','T')+'Z').toLocaleString('ru-RU', {timeZone:'Europe/Moscow'}); } catch(e) {}
          var stCol = r.status_code >= 400 ? 'color:var(--danger);font-weight:600' : 'color:var(--success)';
          h += '<tr><td style="padding:4px 10px;white-space:nowrap;color:var(--text-3)">' + esc(tsStr) + '</td>';
          h += '<td style="padding:4px 10px;font-family:var(--font-mono);color:var(--accent)">' + esc(r.method) + ' ' + esc(r.endpoint) + '</td>';
          h += '<td style="padding:4px 10px;text-align:center;' + stCol + '">' + r.status_code + '</td>';
          h += '<td style="padding:4px 10px;text-align:right">' + (r.response_time_ms != null ? r.response_time_ms : '—') + '</td>';
          h += '<td style="padding:4px 10px;font-family:var(--font-mono);color:var(--text-3)">' + esc(r.ip || '') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      body.innerHTML = h;

      // Chart
      setTimeout(function() {
        var cv = document.getElementById('opsApiChart');
        if (!cv || !window.Chart) return;
        var pd = d.per_day || [];
        var cc = getChartColors();
        newChartSafe(cv, {
          type: 'bar',
          data: {
            labels: pd.map(function(x){return x.date.slice(5)}),
            datasets: [{
              label: 'Запросов',
              data: pd.map(function(x){return x.count}),
              backgroundColor: '#3B9DD8'
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: cc.text, font: { size: 9 } }, grid: { display: false } },
              y: { beginAtZero: true, ticks: { color: cc.text, font: { size: 10 } }, grid: { color: cc.grid } }
            }
          }
        });
      }, 50);
    })
    .catch(function(e) { body.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(e.message) + '</div>'; });
}

// Месяцы / Кварталы toggle for the operations history segmentation.
function setOpsSegMode(mode, clientId) {
  window._opsSegMode = (mode === 'quarter') ? 'quarter' : 'month';
  renderOpsHistory(clientId);
}
function renderOpsHistory(clientId) {
  var body = document.getElementById('clientOpsBody');
  body.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:40px;text-align:center">Загрузка операций...</div>';
  api(API + '/api/admin/clients/' + clientId + '/ledger')
    .then(function(data) {
      var entries = data.entries || [];
      // Backend returns newest-first; each entry carries _idx = its absolute
      // position in the full ledger (the delete route indexes into that ASC
      // list). Re-sort defensively in case of a backdated manual entry.
      entries.sort(function(a, b) { return (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''); });
      var client = (currentData.clients || []).find(function(x) { return x.id === clientId; });
      var bal = client ? (client.balance !== undefined ? client.balance : 0) : 0;
      var balColor = bal >= 0 ? 'var(--success)' : 'var(--danger)';
      var h = '<div style="display:flex;gap:12px;align-items:stretch;margin-bottom:12px;flex-wrap:wrap">';
      h += '<div style="flex:1 1 260px;min-width:0;padding:12px 14px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">';
      h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Сумма</label><input class="form-input" type="number" id="opsPayAmount" placeholder="5000" style="width:100px;font-size:12px;padding:4px 8px"></div>';
      h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Дата</label><input class="form-input" type="date" id="opsPayDate" value="' + new Date().toISOString().slice(0, 10) + '" style="width:130px;font-size:12px;padding:4px 8px"></div>';
      h += '<div style="flex:1;min-width:100px"><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Комментарий</label><input class="form-input" id="opsPayNote" placeholder="Пополнение" style="width:100%;font-size:12px;padding:4px 8px"></div>';
      h += '<button class="btn btn-success btn-sm" onclick="addPaymentFromModal(\'' + clientId + '\')" style="white-space:nowrap;padding:4px 12px">+ Пополнить</button>';
      h += '<button class="btn btn-sm" onclick="manualChargeFromModal(\'' + clientId + '\')" style="white-space:nowrap;padding:4px 12px;background:var(--danger);color:#fff">− Списать</button>';
      h += '</div>';
      h += '<div style="padding:12px 18px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:110px"><div style="font-size:10px;color:var(--text-2)">Баланс</div><div style="font-size:20px;font-weight:700;color:' + balColor + '">' + Math.round(bal) + ' \u20BD</div></div>';
      h += '</div>';
      if (!entries.length) {
        h += '<div style="color:var(--text-3);font-size:13px;padding:30px;text-align:center">Нет операций</div>';
      } else {
      // Detect billing type — for per_modem clients show "Модемов" instead of "ГБ"
      var clientObj = (currentData.clients || []).find(function(x){return x.id===clientId;});
      var isPerModem = (clientObj && clientObj.billingType === 'per_modem')
        || entries.some(function(e){return e.billing_type === 'per_modem';});
      var qtyHeader = isPerModem ? 'Модемов' : 'ГБ';
      // Месяцы / Кварталы toggle for the period segmentation below.
      var _segModeNow = (window._opsSegMode === 'quarter') ? 'quarter' : 'month';
      var _segBtn = function(mode, label){ return '<button class="btn btn-sm" style="font-size:11px;padding:2px 10px;'+(_segModeNow===mode?'background:var(--accent);color:#fff':'')+'" onclick="setOpsSegMode(\''+mode+'\',\''+clientId+'\')">'+label+'</button>'; };
      h += '<div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-bottom:8px"><span style="font-size:11px;color:var(--text-3);margin-right:2px">Группировка:</span>' + _segBtn('month','Месяцы') + _segBtn('quarter','Кварталы') + '</div>';
      var _ths='padding:8px 10px;text-transform:uppercase;font-size:10px;letter-spacing:.5px;color:var(--text-3);font-weight:600';
      h += '<div style="overflow-x:auto;margin:0 -2px"><table class="ops-ledger" style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'
        + '<th style="text-align:left;'+_ths+'">Дата</th>'
        + '<th style="text-align:center;'+_ths+'">'+qtyHeader+'</th>'
        + '<th style="text-align:center;'+_ths+'">Ставка</th>'
        + '<th style="text-align:center;'+_ths+'">Сумма</th>'
        + '<th style="text-align:center;'+_ths+'">Баланс</th>'
        + '<th style="text-align:left;'+_ths+'">Примечание</th>'
        + '<th style="text-align:center;width:30px;'+_ths+'"></th>'
        + '</tr></thead><tbody>';
      // Period segmentation (Месяцы / Кварталы toggle — window._opsSegMode).
      // Totals come from the backend (`monthly`, computed over the FULL ledger
      // so they're complete even though the page shows only the newest 100
      // rows); quarters are derived from months. A divider row is inserted
      // whenever the period changes (entries are newest-first).
      var _segMode = (window._opsSegMode === 'quarter') ? 'quarter' : 'month';
      var _RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      var _RU_ROMAN = ['I','II','III','IV'];
      var _monthly = data.monthly || {};
      var _quarterly = {};
      Object.keys(_monthly).forEach(function(mk){ var p=mk.split('-'); var q=p[0]+'-Q'+Math.ceil(parseInt(p[1],10)/3); if(!_quarterly[q])_quarterly[q]={spent:0,topup:0,count:0}; _quarterly[q].spent+=_monthly[mk].spent||0; _quarterly[q].topup+=_monthly[mk].topup||0; _quarterly[q].count+=_monthly[mk].count||0; });
      var _curSeg = null;
      var _fmtRub = function(x){ return Math.round(x||0).toLocaleString('ru-RU') + ' ₽'; };
      var _segOf = function(e){ var ds=(e.date||e.timestamp||''); if(!/^\d{4}-\d{2}/.test(ds))return ''; var mk=ds.slice(0,7); if(_segMode==='quarter'){var p=mk.split('-');return p[0]+'-Q'+Math.ceil(parseInt(p[1],10)/3);} return mk; };
      var _segLabel = function(key){ if(_segMode==='quarter'){var p=key.split('-Q');return (_RU_ROMAN[parseInt(p[1],10)-1]||'')+' кв. '+p[0];} var p=key.split('-');return (_RU_MONTHS[parseInt(p[1],10)-1]||'')+' '+p[0]; };
      var _segAgg = function(key){ return (_segMode==='quarter'?_quarterly:_monthly)[key] || {spent:0,topup:0,count:0}; };
      entries.forEach(function(e, eIdx) {
        var _sk = _segOf(e);
        if (_sk && _sk !== _curSeg) {
          _curSeg = _sk;
          var _agg = _segAgg(_sk);
          var _net = (_agg.topup || 0) - (_agg.spent || 0);
          h += '<tr class="seg-divider"><td colspan="7" style="padding:7px 12px;background:var(--bg-2);border-top:2px solid var(--border);border-bottom:1px solid var(--border)">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
            + '<span style="font-weight:700;font-size:12px;color:var(--text-1)">' + _segLabel(_sk) + '</span>'
            + '<span style="font-size:11px;color:var(--text-3)">'
            + 'Списано <span style="color:var(--danger);font-weight:600">' + _fmtRub(_agg.spent) + '</span>'
            + ' · Пополнено <span style="color:var(--success);font-weight:600">' + _fmtRub(_agg.topup) + '</span>'
            + ' · Итог <span style="color:' + (_net >= 0 ? 'var(--success)' : 'var(--danger)') + ';font-weight:600">' + (_net >= 0 ? '+' : '') + _fmtRub(_net) + '</span>'
            + ' · ' + (_agg.count || 0) + ' оп.'
            + '</span></div></td></tr>';
        }
        var typeLabel = '', typeColor = '', amountStr = '', amountColor = '';
        var entryIsPerModem = e.billing_type === 'per_modem';
        if (e.type === 'charge') { typeLabel = 'Списание'; typeColor = 'color:var(--danger)'; amountStr = '-' + ((e.cost || 0).toFixed(2)) + ' \u20BD'; amountColor = 'color:var(--danger)'; }
        else if (e.type === 'payment') { typeLabel = 'Пополнение'; typeColor = 'color:var(--success)'; amountStr = '+' + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--success)'; }
        else if (e.type === 'payment_reversal') { typeLabel = 'Отмена'; typeColor = 'color:var(--warning)'; amountStr = (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--warning)'; }
        else if (e.type === 'adjustment') { typeLabel = 'Коррекция'; typeColor = 'color:var(--accent)'; amountStr = ((e.amount || 0) >= 0 ? '+' : '') + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = (e.amount || 0) >= 0 ? 'color:var(--success)' : 'color:var(--danger)'; }
        else if (e.type === 'bank_payment') { typeLabel = '\u{1F3E6} \u0411\u0430\u043D\u043A'; typeColor = 'color:#6366f1'; amountStr = '+' + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--success)'; }
        else if (e.type === 'manual_charge') { typeLabel = 'Ручное списание'; typeColor = 'color:var(--danger)'; amountStr = '-' + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--danger)'; }
        else if (e.type === 'correction') { typeLabel = 'Корректировка'; typeColor = 'color:var(--warning)'; amountStr = '-' + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--warning)'; }
        else { typeLabel = e.type || '\u2014'; amountStr = (e.cost || e.amount || 0) + ' \u20BD'; }
        var dateStr = '\u2014';
        var dateSource = e.date || e.timestamp;
        if (dateSource) { try { var d = new Date(dateSource); if (!isNaN(d.getTime())) { dateStr = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }); } } catch (ex) {} }
        // Quantity + rate columns:
        //   per_gb charge:    qty = GB, rate = price_per_unit \u20bd/\u0413\u0411
        //   per_modem charge: qty = modem count (derived if not stored), rate = price \u20bd/\u043c\u0435\u0441 (\u0437\u0430 \u043c\u043e\u0434\u0435\u043c-\u043c\u0435\u0441\u044f\u0446)
        //   non-charge:       qty = '\u2014', rate = '\u2014'
        var qtyStr = '\u2014', rateStr = '\u2014';
        if (e.type === 'charge') {
          if (entryIsPerModem) {
            var mc = e.modem_count;
            if (mc == null) {
              var ppu = e.price_per_unit;
              var dim = e.days_in_month || 30;
              if (ppu > 0 && e.cost > 0) mc = Math.round((e.cost * dim / ppu) * 100) / 100;
            }
            qtyStr = mc != null ? String(mc) : '\u2014';
            rateStr = e.price_per_unit ? e.price_per_unit + ' \u20bd/\u043c\u0435\u0441' : '\u2014';
          } else if (e.delta_gb !== undefined) {
            qtyStr = e.delta_gb.toFixed(3);
            rateStr = e.price_per_unit ? e.price_per_unit + ' \u20bd/\u0413\u0411' : '\u2014';
          }
        }
        var balAfter = e.balance_after !== undefined ? e.balance_after.toFixed(2) + ' \u20BD' : '\u2014';
        var note = e.note || '';
        h += '<tr>';
        h += '<td style="padding:6px 10px;white-space:nowrap">' + dateStr + '</td>';
        h += '<td style="padding:6px 10px;text-align:center">' + qtyStr + '</td>';
        h += '<td style="padding:6px 10px;text-align:center;color:var(--text-2);white-space:nowrap">' + rateStr + '</td>';
        h += '<td style="padding:6px 10px;text-align:center;font-family:var(--font-mono);' + amountColor + ';font-weight:600">' + amountStr + '</td>';
        h += '<td style="padding:6px 10px;text-align:center;font-family:var(--font-mono);color:var(--text-2)">' + balAfter + '</td>';
        h += '<td style="padding:6px 10px;color:var(--text-3);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(note) + '">' + esc(note) + '</td>';
        h += '<td style="padding:6px 10px;text-align:center"><button class="btn btn-sm" style="font-size:9px;padding:1px 4px;background:transparent;color:var(--danger);border:1px solid var(--danger)" onclick="deleteLedgerEntry(\'' + clientId + '\',' + e._idx + ')" title="\u0423\u0434\u0430\u043B\u0438\u0442\u044C">\u2716</button></td>';
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      }
      body.innerHTML = h;
    })
    .catch(function(e) { body.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(e.message) + '</div>'; });
}

function editPortCreds(imei,server,portId,currentLogin,currentPass){
  var area=document.getElementById('editPortForm');
  if(!area)return;
  area.innerHTML='<div class="detail-card" style="margin-top:8px"><h4>Изменить доступы порта: '+esc(portId)+'</h4><div class="form-row"><div class="form-group"><label>Логин</label><input class="form-input" id="editPortLogin" value="'+esc(currentLogin)+'"></div><div class="form-group"><label>Пароль</label><input class="form-input" id="editPortPass" value="'+esc(currentPass)+'"></div></div><div style="display:flex;gap:4px;margin-top:6px"><button class="btn btn-primary btn-sm" onclick="savePortCreds(\''+imei+'\',\''+server+'\',\''+portId+'\')">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById(\'editPortForm\').innerHTML=\'\'">Отмена</button></div></div>';
}
function savePortCreds(imei,server,portId){
  var newLogin=document.getElementById('editPortLogin').value;
  var newPass=document.getElementById('editPortPass').value;
  if(!newLogin&&!newPass){showToast('Введите логин или пароль','error');return}
  api(API+'/api/admin/update_port_creds',{method:'POST',json:{serverName:server,IMEI:imei,portID:portId,proxy_login:newLogin,proxy_password:newPass}}).then(function(d){
    if(d.ok){showToast('Доступы обновлены','success');document.getElementById('editPortForm').innerHTML='';setTimeout(loadData,2000)}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}

// ========== FULL PORT SETTINGS ==========
function editPortFull(imei,server,portId){
  var area=document.getElementById('editPortForm');if(!area)return;
  area.innerHTML='<div style="padding:12px;color:var(--text-3);font-size:12px;text-align:center">Загрузка настроек...</div>';
  api(API+'/api/admin/get_port_config?serverName='+encodeURIComponent(server)+'&portId='+encodeURIComponent(portId))
  .then(function(cfg){
    function sel(id,val,opts){var h='<select class="form-input" id="'+id+'">';opts.forEach(function(o){h+='<option value="'+o[0]+'"'+(o[0]===val?' selected':'')+'>'+o[1]+'</option>'});return h+'</select>'}
    var h='<div class="detail-card" style="margin-top:8px"><h4 style="margin-bottom:12px">⚙️ Настройки порта: '+esc(portId)+'</h4>';
    h+='<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Доступы</div>';
    h+='<div class="form-row"><div class="form-group"><label>Логин</label><input class="form-input" id="epLogin" value="'+esc(cfg.proxy_login||'')+'"></div><div class="form-group"><label>Пароль</label><input class="form-input" id="epPass" value="'+esc(cfg.proxy_password||'')+'"></div></div>';
    h+='<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px">Порты</div>';
    h+='<div class="form-row"><div class="form-group"><label>HTTP порт</label><input class="form-input" id="epHttp" value="'+esc(cfg.http_port||'')+'"></div><div class="form-group"><label>SOCKS5 порт</label><input class="form-input" id="epSocks" value="'+esc(cfg.socks_port||'')+'"></div></div>';
    h+='<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px">Лимиты подключений</div>';
    h+='<div class="form-row"><div class="form-group"><label>Max Conn</label><input class="form-input" id="epMaxconn" value="'+esc(cfg.MAXCONN||'')+'" placeholder="0 = без лимита"></div><div class="form-group"><label>Conn Limit</label><input class="form-input" id="epConnlim" value="'+esc(cfg.CONNLIM||'')+'" placeholder="0 = без лимита"></div></div>';
    h+='<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px">Ограничение скорости (Kbps)</div>';
    h+='<div class="form-row"><div class="form-group"><label>↓ Вх. (BANDLIMIN)</label><input class="form-input" id="epBwIn" value="'+esc(cfg.bandlimin||'')+'" placeholder="0 = без лимита"></div><div class="form-group"><label>↑ Исх. (BANDLIMOUT)</label><input class="form-input" id="epBwOut" value="'+esc(cfg.bandlimout||'')+'" placeholder="0 = без лимита"></div></div>';
    h+='<div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px">Дополнительно</div>';
    h+='<div class="form-row">';
    h+='<div class="form-group"><label>IP версия</label>'+sel('epIpVersion',cfg.IP_MODE||'',[[' ','Авто'],['4','IPv4'],['6','IPv6'],['46','IPv4→IPv6'],['64','IPv6→IPv4']])+'</div>';
    h+='<div class="form-group"><label>OS Spoofing</label>'+sel('epOsSpoof',cfg.OS||'',[['','--Выкл--'],['android:1','android:1 (p0f)'],['android:3','android:3 (real, ~Linux)'],['android:4','android:4 (Android 14)'],['macosx:3','macOS:3'],['macosx:4','macOS:4 (12.6/iPhone 13)'],['macosx:5','macOS:5 (Ventura)'],['ios:1','iOS:1 (p0f)'],['ios:2','iOS:2 (real iPhone)'],['ios:3','iOS:3 (iPhone 12 Pro Max)'],['windows:1','Win:1 (Win10 Server)'],['windows:4','Win:4 (Win10/11 Desktop)']])+'</div>';
    h+='</div>';
    h+='<div class="form-row"><div class="form-group"><label>Квота трафика (МБ)</label><input class="form-input" id="epBwQuota" value="'+esc(cfg.bw_quota||'')+'" placeholder="0 = без лимита"></div><div class="form-group"><label>Период квоты</label>'+sel('epQuotaType',cfg.QUOTA_TYPE||'',[['','Выкл'],['daily','Сутки'],['monthly','Месяц'],['lifetime','Всё время']])+'</div></div>';
    h+='<div class="form-row"><div class="form-group"><label>Действителен до</label><input class="form-input" type="date" id="epValidBefore" value="'+esc(cfg.PROXY_VALID_BEFORE||'')+'"></div></div>';
    h+='<div style="display:flex;gap:6px;margin-top:12px"><button class="btn btn-primary btn-sm" onclick="savePortFull(\''+esc(imei)+'\',\''+esc(server)+'\',\''+esc(portId)+'\')">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById(\'editPortForm\').innerHTML=\'\'">Отмена</button></div>';
    h+='</div>';
    area.innerHTML=h;
    area.scrollIntoView({behavior:'smooth',block:'nearest'});
  }).catch(function(e){area.innerHTML='<div style="color:var(--danger);padding:8px;font-size:12px">Ошибка загрузки: '+esc(e.message)+'</div>'});
}
function savePortFull(imei,server,portId){
  var d={serverName:server,portId:portId,IMEI:imei,portID:portId,
    proxy_login:document.getElementById('epLogin').value,
    proxy_password:document.getElementById('epPass').value,
    http_port:document.getElementById('epHttp').value,
    socks_port:document.getElementById('epSocks').value,
    MAXCONN:document.getElementById('epMaxconn').value,
    CONNLIM:document.getElementById('epConnlim').value,
    bandlimin:document.getElementById('epBwIn').value,
    bandlimout:document.getElementById('epBwOut').value,
    bw_quota:document.getElementById('epBwQuota').value,
    QUOTA_TYPE:document.getElementById('epQuotaType').value,
    PROXY_VALID_BEFORE:document.getElementById('epValidBefore').value,
    IP_VERSION:(document.getElementById('epIpVersion').value||'').trim(),
    OS_SPOOF:(document.getElementById('epOsSpoof').value||'').trim()
  };
  api(API+'/api/admin/save_port_config',{method:'POST',json:d})
  .then(function(r){
    if(r.ok){showToast('Настройки порта сохранены ✓','success');document.getElementById('editPortForm').innerHTML='';setTimeout(loadData,2000)}
    else showToast(r.error||'Ошибка сохранения','error');
  }).catch(function(e){showToast(e.message,'error')});
}

// ========== REGENERATE API KEY ==========
function regenerateApiKey(clientId){
  if(!confirm('Перегенерировать API ключ?'))return;
  api(API+'/api/admin/clients/'+clientId+'/regenerate_key',{method:'POST'}).then(function(d){
    if(d.ok){showToast('Новый ключ: '+d.apiKey,'success');loadData()}else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message||'Ошибка сети','error')});
}
function regenerateApiKeyInForm(){
  var clientId=document.getElementById('clientFormId').value;
  if(!clientId){showToast('Сначала сохраните клиента','error');return}
  if(!confirm('Перегенерировать API ключ?'))return;
  api(API+'/api/admin/clients/'+clientId+'/regenerate_key',{method:'POST'}).then(function(d){
    if(d.ok){document.getElementById('cfApiKey').value=d.apiKey;showToast('Ключ обновлён','success');loadData()}else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message||'Ошибка сети','error')});
}

// ========== INIT ==========
(function(){
  try{var s=JSON.parse(localStorage.getItem('admin_col_state_v2'));if(s)COLUMNS.forEach(function(c){if(s.hasOwnProperty(c.id))c.visible=s[c.id]})}catch(e){}
  try{window._modemsView=localStorage.getItem('admin_modems_view')||'table'}catch(e){window._modemsView='table'}
  renderColSelector();
  if(!authToken){window.location.href='/';return}
  // Validate admin token. Use retry so a transient RU↔CF network blip on first
  // load doesn't bounce the admin to the login screen (login can't reach the
  // server either — just wait and retry).
  function _bootAdmin(){
  _fetchRetry(API+'/api/admin/data',{headers:{'X-Auth-Token':authToken}},4)
    .then(function(r){
      if(r.status===401||r.status===403){localStorage.removeItem('pr_admin_token');localStorage.removeItem('pr_token');localStorage.removeItem('pr_login');window.location.href='/';return null}
      return _okJson(r)
    })
    .then(function(data){
      if(!data)return;
      document.body.style.visibility='visible';
      currentData=data;processData();renderServerFilter();renderClientFilterDD();renderTable();updateHeaderStats();populateAccClientFilter();
      if(window._heatmapInitialized){var _hmKey=_heatmapView+'|'+_heatmapId;if(_heatmapCache[_hmKey])renderHeatmap(_heatmapCache[_hmKey]);}
      // Load CRM reminders then generate notifications
      api(API+'/api/admin/crm_reminders').then(function(d){window._crmReminders=d.reminders||[];}).catch(function(){window._crmReminders=[];}).finally(function(){generateNotifications()});
      document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('ru-RU');
      var _st=localStorage.getItem('admin_active_tab')||'dashboard';var _te=document.querySelector('.nav-tab[onclick*="\''+_st+'\'"]');if(_te)switchMainTab(_st,_te);
      startAutoRefresh()
    })
    .catch(function(e){
      if(_isNetErr(e)||_isServerDownErr(e)){document.body.style.visibility='visible';showToast('Переподключение к серверу…','warning');setTimeout(_bootAdmin,3000);return;}
      window.location.href='/';
    });
  }
  _bootAdmin();
})();

// ═══════════════════════════════════════════════════════════════════════════
// LOAD SIMULATOR (Day 2 MVP)
// ═══════════════════════════════════════════════════════════════════════════
var _simState = {
  allModems: [],         // [{server,nick,operator,online,in_pool,...}]
  profiles: [],          // saved profiles
  currentProfileId: null,
  selectedModems: {},    // key "server|nick" → true (profile inclusion)
  urls: [{ url: 'https://httpbin.org/bytes/100000', weight: 1, method: 'GET' }],
  concurrency: { mode: 'constant', workers: 4 },
  duration_s: 60,
  timeout_ms: 15000,
  activeRun: null,
  sse: null,
  liveSeries: { ts: [], reqs: [], p95: [] },
  liveTimer: null,
};

function initSimulator(){
  simLoadAllModems();
  simLoadProfilesList();
  simRenderUrlList();
  simRenderConcParams();
  simLoadHistory();
  simRefreshActive();
}

// Loads ALL live modems + their is_test_pool flag, so the pool can be managed
// inline (no jumping to the modem detail modal).
function simLoadAllModems(){
  api(API+'/api/admin/simulator/all-modems')
    .then(function(d){
      _simState.allModems = d.items || [];
      simRenderAllModems();
    });
}

function _simFilteredModems(){
  var q = (document.getElementById('simModemFilter')||{}).value || '';
  var poolOnly = (document.getElementById('simPoolOnlyFilter')||{}).checked;
  var onlineOnly = (document.getElementById('simOnlineOnlyFilter')||{}).checked;
  var ql = q.toLowerCase();
  return _simState.allModems.filter(function(m){
    if(poolOnly && !m.in_pool) return false;
    if(onlineOnly && !m.online && !m.in_pool) return false; // keep pool ghosts visible
    if(ql && (m.nick||'').toLowerCase().indexOf(ql)<0 && (m.operator||'').toLowerCase().indexOf(ql)<0 && (m.server||'').toLowerCase().indexOf(ql)<0) return false;
    return true;
  });
}

function simRenderAllModems(){
  var box = document.getElementById('simAllModemsList');
  if(!_simState.allModems.length){
    box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:12px">Нет live данных по модемам. Подождите обновление кеша.</div>';
    document.getElementById('simModemCount').textContent = '—';
    simRenderSelectedSummary();
    return;
  }
  var rows = _simFilteredModems();
  // Group by server with sticky-ish dividers
  var byServer = {};
  rows.forEach(function(m){ if(!byServer[m.server]) byServer[m.server]=[]; byServer[m.server].push(m); });
  var servers = Object.keys(byServer).sort();
  var html = '<table class="sim-table" style="font-size:11px"><thead><tr>'+
    '<th style="width:60px;text-align:center">В пуле</th>'+
    '<th style="width:60px;text-align:center">В профиле</th>'+
    '<th>Ник</th>'+
    '<th>Сервер</th>'+
    '<th>Оператор</th>'+
    '<th>Модель</th>'+
    '<th style="width:60px">Статус</th>'+
    '</tr></thead><tbody>';
  var poolCount = 0, profileCount = 0;
  servers.forEach(function(srv){
    var arr = byServer[srv];
    html += '<tr style="background:var(--bg-2)"><td colspan="7" style="font-size:10px;font-weight:700;color:var(--text-2);padding:4px 8px">'+esc(srv)+' ('+arr.length+')</td></tr>';
    arr.forEach(function(m){
      var key = m.server+'|'+m.nick;
      var inProfile = !!_simState.selectedModems[key];
      if(m.in_pool) poolCount++;
      if(inProfile) profileCount++;
      var disProfile = m.in_pool ? '' : 'disabled';
      var ghostStyle = m._ghost ? 'opacity:.55' : '';
      html += '<tr style="'+ghostStyle+'">'+
        '<td style="text-align:center"><input type="checkbox" '+(m.in_pool?'checked':'')+' onchange="simTogglePool(\''+esc(m.server)+'\',\''+esc(m.nick)+'\',this)"></td>'+
        '<td style="text-align:center"><input type="checkbox" '+(inProfile?'checked':'')+' '+disProfile+' onchange="simToggleSelect(\''+esc(m.server)+'\',\''+esc(m.nick)+'\',this.checked)" title="'+(m.in_pool?'':'Сначала добавьте в пул')+'"></td>'+
        '<td><strong>'+esc(m.nick)+'</strong>'+(m._ghost?' <span style="font-size:9px;color:var(--text-3)">(ghost)</span>':'')+'</td>'+
        '<td><span style="font-size:10px;color:var(--text-2)">'+esc(m.server)+'</span></td>'+
        '<td>'+esc(m.operator||'')+'</td>'+
        '<td><span style="font-size:10px;color:var(--text-3)">'+esc(m.model||'')+'</span></td>'+
        '<td>'+(m.online?'<span style="color:#10B981">● онлайн</span>':'<span style="color:#EF4444">● оффлайн</span>')+'</td>'+
        '</tr>';
    });
  });
  html += '</tbody></table>';
  box.innerHTML = html;
  document.getElementById('simModemCount').textContent =
    'Показано: '+rows.length+' / '+_simState.allModems.length+
    ' · В пуле: '+poolCount+
    ' · В профиле: '+profileCount;
  simRenderSelectedSummary();
}

// Toggles is_test_pool on the backend, updates the local cache so the UI reflects
// the change without a full re-fetch. Re-renders so the profile checkbox enables/disables.
function simTogglePool(server, nick, checkboxEl){
  var enabled = checkboxEl.checked;
  checkboxEl.disabled = true;
  api(API+'/api/admin/modem/test-pool',{method:'POST',json:{ server: server, nick: nick, enabled: enabled }}).then(function(d){
    checkboxEl.disabled = false;
    if(!d.ok){ checkboxEl.checked = !enabled; alert(d.error||'Ошибка'); return; }
    // Mirror locally
    _simState.allModems.forEach(function(m){
      if(m.server===server && m.nick===nick) m.in_pool = enabled;
    });
    if(!enabled){
      // Removing from pool also removes from current-profile selection
      delete _simState.selectedModems[server+'|'+nick];
    }
    simRenderAllModems();
  }).catch(function(){ checkboxEl.disabled = false; checkboxEl.checked = !enabled; });
}

function simToggleSelect(server,nick,checked){
  var key = server + '|' + nick;
  if(checked) _simState.selectedModems[key] = true;
  else delete _simState.selectedModems[key];
  simRenderSelectedSummary();
  // Update the count without full re-render
  var el = document.getElementById('simModemCount');
  if(el){
    var n = Object.keys(_simState.selectedModems).length;
    el.textContent = el.textContent.replace(/В профиле: \d+/, 'В профиле: '+n);
  }
}

// Bulk operations on currently-filtered set
function simBulkPool(enable){
  var rows = _simFilteredModems().filter(function(m){ return m.in_pool !== enable; });
  if(!rows.length) return;
  if(!confirm((enable?'Добавить в пул':'Убрать из пула')+' '+rows.length+' модемов?')) return;
  Promise.all(rows.map(function(m){
    return api(API+'/api/admin/modem/test-pool',{method:'POST',json:{ server: m.server, nick: m.nick, enabled: enable }}).then(function(){
      m.in_pool = enable;
      if(!enable) delete _simState.selectedModems[m.server+'|'+m.nick];
    });
  })).then(simRenderAllModems);
}

function simSelectAllInProfile(enable){
  var rows = _simFilteredModems().filter(function(m){ return m.in_pool; });
  rows.forEach(function(m){
    var key = m.server+'|'+m.nick;
    if(enable) _simState.selectedModems[key] = true;
    else delete _simState.selectedModems[key];
  });
  simRenderAllModems();
}

function simRenderSelectedSummary(){
  var box = document.getElementById('simTargetModems');
  var keys = Object.keys(_simState.selectedModems);
  if(!keys.length){ box.innerHTML = '<span style="color:var(--text-3);font-size:11px">— Отметьте чекбоксы в пуле выше —</span>'; return; }
  box.innerHTML = keys.map(function(k){
    var p = k.split('|'); return '<span style="background:rgba(59,157,216,.12);color:#3B9DD8;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600">'+esc(p[1])+' <span style="opacity:.65">('+esc(p[0])+')</span></span>';
  }).join(' ');
}

function simRenderUrlList(){
  var box = document.getElementById('simUrlList');
  box.innerHTML = _simState.urls.map(function(u,i){
    return '<div class="sim-url-row">'+
      '<select onchange="_simState.urls['+i+'].method=this.value" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
        ['GET','POST','HEAD'].map(function(m){return '<option value="'+m+'"'+(u.method===m?' selected':'')+'>'+m+'</option>'}).join('')+
      '</select>'+
      '<input type="text" placeholder="https://..." value="'+esc(u.url||'')+'" oninput="_simState.urls['+i+'].url=this.value" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
      '<input type="number" class="w" min="1" max="100" value="'+(u.weight||1)+'" oninput="_simState.urls['+i+'].weight=parseInt(this.value)||1" title="Вес" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
      (_simState.urls.length>1?'<button class="btn btn-sm" onclick="simRemoveUrlRow('+i+')" style="font-size:10px;padding:2px 6px">✕</button>':'')+
    '</div>';
  }).join('');
}
function simAddUrlRow(){ _simState.urls.push({url:'',weight:1,method:'GET'}); simRenderUrlList(); }
function simRemoveUrlRow(i){ _simState.urls.splice(i,1); simRenderUrlList(); }

function simRenderConcParams(){
  var mode = document.getElementById('simConcMode').value;
  _simState.concurrency.mode = mode;
  var box = document.getElementById('simConcParams');
  var inp = function(label,id,val,min,max){
    return '<div style="display:flex;align-items:center;gap:6px;margin-top:4px"><label style="font-size:10px;color:var(--text-2);min-width:90px">'+label+'</label>'+
      '<input type="number" id="'+id+'" value="'+val+'" min="'+min+'" max="'+max+'" style="flex:1;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px"></div>';
  };
  if(mode==='constant'){
    box.innerHTML = inp('Воркеров','simConstWorkers',_simState.concurrency.workers||4,1,500);
  } else if(mode==='ramp'){
    box.innerHTML = inp('От','simRampStart',_simState.concurrency.start||1,1,500)+
      inp('До','simRampEnd',_simState.concurrency.end||20,1,500)+
      inp('За сколько сек','simRampSec',_simState.concurrency.ramp_seconds||30,1,3600);
  } else if(mode==='burst'){
    box.innerHTML = inp('Воркеров в берсте','simBurstWorkers',_simState.concurrency.workers||10,1,500)+
      inp('Время ON, сек','simBurstOn',_simState.concurrency.on_seconds||5,1,600)+
      inp('Время OFF, сек','simBurstOff',_simState.concurrency.off_seconds||5,1,600);
  }
}
function simReadConcParams(){
  var mode = _simState.concurrency.mode;
  if(mode==='constant'){
    return { mode:'constant', workers: parseInt(document.getElementById('simConstWorkers').value)||4 };
  } else if(mode==='ramp'){
    return { mode:'ramp',
      start: parseInt(document.getElementById('simRampStart').value)||1,
      end: parseInt(document.getElementById('simRampEnd').value)||20,
      ramp_seconds: parseInt(document.getElementById('simRampSec').value)||30 };
  } else {
    return { mode:'burst',
      workers: parseInt(document.getElementById('simBurstWorkers').value)||10,
      on_seconds: parseInt(document.getElementById('simBurstOn').value)||5,
      off_seconds: parseInt(document.getElementById('simBurstOff').value)||5 };
  }
}

function simBuildProfile(){
  var modems = Object.keys(_simState.selectedModems).map(function(k){
    var p = k.split('|'); return { server: p[0], nick: p[1] };
  });
  var urls = _simState.urls.filter(function(u){ return u.url && /^https?:\/\//.test(u.url); });
  return {
    name: 'ad-hoc',
    target_modems: modems,
    targets: urls,
    concurrency: simReadConcParams(),
    duration_ms: (parseInt(document.getElementById('simDuration').value)||60) * 1000,
    timeout_ms: parseInt(document.getElementById('simTimeout').value)||15000,
  };
}

function simStart(){
  var p = simBuildProfile();
  if(!p.target_modems.length) return alert('Выберите хотя бы один модем');
  if(!p.targets.length) return alert('Добавьте хотя бы один URL');
  document.getElementById('simStartStatus').textContent = 'Старт…';
  document.getElementById('simStartBtn').disabled = true;
  api(API+'/api/admin/simulator/run',{method:'POST',json:{ profile: p }}).then(function(d){return {ok:!(d&&d.__status>=400),d:d}})
    .then(function(o){
      document.getElementById('simStartBtn').disabled = false;
      if(!o.ok){
        document.getElementById('simStartStatus').textContent = '❌ ' + (o.d.error || 'ошибка');
        if(o.d.missing) document.getElementById('simStartStatus').textContent += ' · ' + o.d.missing.join(', ');
        return;
      }
      document.getElementById('simStartStatus').textContent = '✓ Запущен run #' + o.d.run_id;
      simAttachToRun(o.d.run_id);
    });
}

function simAbort(){
  if(!_simState.activeRun) return;
  if(!confirm('Остановить запуск?')) return;
  api(API+'/api/admin/simulator/run/'+_simState.activeRun+'/abort',{method:'POST'});
}

function simRefreshActive(){
  api(API+'/api/admin/simulator/active')
    .then(function(d){
      if(d.active && d.active.id){ simAttachToRun(d.active.id, d.active); }
      else simShowIdle();
    });
}

function simAttachToRun(runId, snapshot){
  _simState.activeRun = runId;
  _simState.liveSeries = { ts: [], reqs: [], p95: [] };
  document.getElementById('simLive').style.display = '';
  document.getElementById('simLiveRunId').textContent = runId;
  if(snapshot){ simRenderLiveSnapshot(snapshot); }
  if(_simState.sse){ try{_simState.sse.close()}catch(_){}; }
  _simState.sse = new EventSource(API+'/api/admin/simulator/run/'+runId+'/stream');
  _simState.sse.onmessage = function(ev){
    try {
      var msg = JSON.parse(ev.data);
      if(msg.type==='snapshot' || msg.type==='start' || msg.type==='tick'){
        if(msg.run) simRenderLiveSnapshot(msg.run);
        if(msg.snapshot) simRenderLiveSnapshot(msg.snapshot);
        if(msg.type==='tick') simFetchLiveAgg(runId);
      } else if(msg.type==='end'){
        document.getElementById('simHeaderState').textContent = '✓ Run #'+runId+' завершён: ' + (msg.reason||'');
        if(msg.summary) simRenderLiveSummary(msg.summary);
        setTimeout(function(){ simShowIdle(); simLoadHistory(); }, 3000);
      }
    } catch(e) {}
  };
  _simState.sse.onerror = function(){ /* silent reconnect happens automatically */ };
}

function simRenderLiveSnapshot(snap){
  document.getElementById('simLiveProfileName').textContent = snap.profile_name || 'ad-hoc';
  document.getElementById('simLiveWorkers').textContent = snap.active_workers || 0;
  document.getElementById('simLiveTarget').textContent = snap.target_workers || 0;
  document.getElementById('simLiveElapsed').textContent = snap.elapsed_sec || 0;
}

// On every "tick" event we fetch the running aggregate from /series + /by-modem.
// Aggregating server-side is cheaper than pulling raw samples.
function simFetchLiveAgg(runId){
  // KPI strip — use cheap /samples count + first-page status mix
  api(API+'/api/admin/simulator/run/'+runId+'/samples?limit=1').then(function(d){
      document.getElementById('simLiveReqs').textContent = d.total || 0;
    });
  // Series + by-modem
  api(API+'/api/admin/simulator/run/'+runId+'/series?bucket=2').then(function(d){
      simDrawTimeSeriesChart('simLiveChart', d.series || []);
      // Roll up KPI from series last 30s for "running" feel
      var s = d.series || [];
      if(s.length){
        var ok=0,to=0,n=0,lats=[];
        s.slice(-15).forEach(function(b){
          n += Math.round(b.rps * 2);
          to += Math.round(b.timeout_pct/100 * b.rps * 2);
          lats.push(b.p95_ms);
        });
        ok = n - to;
        document.getElementById('simLiveOk').textContent = n ? (Math.round(ok/n*1000)/10) + '%' : '0%';
        document.getElementById('simLiveTo').textContent = n ? (Math.round(to/n*1000)/10) + '%' : '0%';
        lats.sort(function(a,b){return a-b});
        document.getElementById('simLiveP95').textContent = (lats[Math.floor(lats.length*0.95)]||0) + ' мс';
      }
    });
  api(API+'/api/admin/simulator/run/'+runId+'/by-modem').then(function(d){
      simRenderByModemTable(document.getElementById('simLiveByModem'), d.items || []);
    });
  // Breaking-point detection (cheap; updates the banner if ramp run)
  api(API+'/api/admin/simulator/run/'+runId+'/breaking-point').then(function(d){
      var bp = document.getElementById('simBreakingPoint');
      if(d.applicable && d.breaking_point){
        bp.style.display = '';
        bp.innerHTML = '🔥 <strong>Breaking-point найден:</strong> ' + d.breaking_point.workers + ' воркеров на t='+d.breaking_point.t_sec+'с — таймаут '+d.breaking_point.timeout_pct+'%, P95 '+d.breaking_point.p95_ms+' мс (база '+d.breaking_point.base_p95_ms+' мс).';
      } else if(d.applicable) {
        bp.style.display = '';
        bp.innerHTML = '✓ Breaking-point не найден в этом ramp-прогоне (нагрузка стабильна).';
      } else {
        bp.style.display = 'none';
      }
    });
}

// Chart.js-based time series. Two y-axes: rps (left, blue bars) + P95 ms (right, red line).
// Singleton per canvas id — destroys previous instance before re-rendering.
function simDrawTimeSeriesChart(canvasId, series){
  var ctx = document.getElementById(canvasId);
  if(!ctx) return;
  if(window.Chart && Chart.getChart){
    var prev = Chart.getChart(ctx);
    if(prev) prev.destroy();
  }
  if(!series.length){
    var pctx = ctx.getContext('2d');
    pctx.clearRect(0,0,ctx.width,ctx.height);
    pctx.fillStyle = '#999';
    pctx.font = '11px Inter,sans-serif';
    pctx.textAlign='center';
    pctx.fillText('Ожидаем первые сэмплы…', ctx.width/2, ctx.height/2);
    return;
  }
  var labels = series.map(function(s){return s.t_sec+'с'});
  var rps = series.map(function(s){return s.rps});
  var p95 = series.map(function(s){return s.p95_ms});
  var toPct = series.map(function(s){return s.timeout_pct});
  new Chart(ctx, {
    type:'bar',
    data:{ labels: labels, datasets:[
      { type:'bar', label:'rps', data: rps, backgroundColor:'rgba(59,157,216,.45)', borderColor:'#3B9DD8', borderWidth:1, yAxisID:'yRps', order:2 },
      { type:'line', label:'P95 latency, мс', data: p95, borderColor:'#EF4444', backgroundColor:'rgba(239,68,68,.08)', borderWidth:2, pointRadius:0, tension:.3, yAxisID:'yLat', order:1 },
      { type:'line', label:'Таймаут, %', data: toPct, borderColor:'#EF9F27', backgroundColor:'transparent', borderWidth:1.5, borderDash:[4,4], pointRadius:0, tension:.3, yAxisID:'yPct', order:0 },
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{display:true, position:'top', labels:{font:{size:10},boxWidth:10,padding:8}} },
      scales:{
        x:{ display:true, ticks:{font:{size:9},maxRotation:0,autoSkipPadding:18}, grid:{display:false} },
        yRps:{ position:'left', beginAtZero:true, ticks:{font:{size:9},color:'#3B9DD8'}, title:{display:true,text:'rps',font:{size:9}}, grid:{color:'rgba(0,0,0,.05)'} },
        yLat:{ position:'right', beginAtZero:true, ticks:{font:{size:9},color:'#EF4444'}, title:{display:true,text:'мс',font:{size:9}}, grid:{display:false} },
        yPct:{ position:'right', display:false, beginAtZero:true, max:100 },
      }
    }
  });
}

function simRenderByModemTable(box, items){
  if(!items.length){ box.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-3);font-size:11px">Ожидаем сэмплов…</div>'; return; }
  var rows = items.map(function(m){
    var toCls = m.timeout_pct >= 5 ? 'sim-status-error' : m.timeout_pct > 0 ? 'sim-status-aborted' : 'sim-status-completed';
    return '<tr><td><strong>'+esc(m.modem_nick)+'</strong> <span style="font-size:9px;color:var(--text-3)">'+esc(m.server_name)+'</span></td>'+
      '<td>'+m.total+'</td>'+
      '<td>'+m.success_pct+'%</td>'+
      '<td><span class="'+toCls+'">'+m.timeout_pct+'%</span></td>'+
      '<td>'+m.error_pct+'%</td>'+
      '<td>'+m.p50_ms+'</td>'+
      '<td>'+m.p95_ms+'</td>'+
      '<td>'+m.avg_connect_ms+'</td>'+
      '<td>'+m.avg_ttfb_ms+'</td></tr>';
  }).join('');
  box.innerHTML = '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table class="sim-table"><thead><tr>'+
    '<th>Модем</th><th>Req</th><th>OK</th><th>TO</th><th>Err</th>'+
    '<th>P50</th><th>P95</th><th>Connect</th><th>TTFB</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function simRenderLiveSummary(s){
  document.getElementById('simLiveOk').textContent = (s.success_pct||0) + '%';
  document.getElementById('simLiveTo').textContent = (s.timeout_pct||0) + '%';
  document.getElementById('simLiveP95').textContent = (s.p95_ms||0) + ' мс';
  document.getElementById('simLiveReqs').textContent = s.total_requests||0;
}

function simShowIdle(){
  _simState.activeRun = null;
  if(_simState.sse){ try{_simState.sse.close()}catch(_){}; _simState.sse = null; }
  document.getElementById('simLive').style.display = 'none';
  document.getElementById('simHeaderState').textContent = '⏸ Бездействует';
}

var _simHistSel = {};  // run_id → true (for comparison selection)

function simLoadHistory(){
  api(API+'/api/admin/simulator/runs?limit=50')
    .then(function(d){
      var items = d.items || [];
      var box = document.getElementById('simHistoryTable');
      if(!items.length){ box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:12px">Запусков ещё не было.</div>'; simUpdateCompareBtn(); return; }
      var rows = items.map(function(r){
        var s = r.summary || {};
        var st = r.status;
        var stCls = 'sim-status-'+st;
        var when = new Date(r.started_at+'Z').toLocaleString('ru-RU');
        var checked = _simHistSel[r.id] ? 'checked' : '';
        return '<tr style="cursor:pointer" onclick="if(event.target.tagName!==\'INPUT\')simOpenRunDetail('+r.id+')">'+
          '<td onclick="event.stopPropagation()"><input type="checkbox" '+checked+' onchange="simToggleHistSel('+r.id+',this.checked)"></td>'+
          '<td><span class="'+stCls+'">'+st+'</span></td>'+
          '<td>#'+r.id+'</td><td>'+esc(r.profile_name||'—')+'</td>'+
          '<td>'+when+'</td>'+
          '<td>'+(s.total_requests||0)+'</td>'+
          '<td>'+(s.success_pct!=null?s.success_pct+'%':'—')+'</td>'+
          '<td>'+(s.timeout_pct!=null?s.timeout_pct+'%':'—')+'</td>'+
          '<td>'+(s.p95_ms!=null?s.p95_ms+' мс':'—')+'</td>'+
          '<td>'+(s.avg_throughput_mbps!=null?s.avg_throughput_mbps+' Mbps':'—')+'</td></tr>';
      }).join('');
      box.innerHTML = '<div style="overflow-x:auto"><table class="sim-table"><thead><tr>'+
        '<th></th><th>Статус</th><th>#</th><th>Профиль</th><th>Начало</th>'+
        '<th>Запросов</th><th>Успех</th><th>Таймаут</th><th>P95</th><th>Throughput</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
      simUpdateCompareBtn();
    });
}
function simToggleHistSel(id, on){
  if(on) _simHistSel[id] = true; else delete _simHistSel[id];
  simUpdateCompareBtn();
}
function simUpdateCompareBtn(){
  var n = Object.keys(_simHistSel).length;
  var btn = document.getElementById('simCompareBtn');
  var info = document.getElementById('simHistSelInfo');
  if(!btn) return;
  btn.disabled = !(n >= 2 && n <= 5);
  info.textContent = n ? 'Выбрано: '+n+' / 5' : 'Отметьте 2-5 чекбоксов для сравнения';
}

// ─── Run detail modal ─────────────────────────────────────────────────────
var _simCurrentDetailRunId = null;
function simCloseDetail(){
  document.getElementById('simDetailModal').style.display = 'none';
  _simCurrentDetailRunId = null;
}
function simExport(format){
  if(!_simCurrentDetailRunId) return;
  // NB: stays on raw fetch — binary/blob download, api() returns parsed data.
  fetch(API+'/api/admin/simulator/run/'+_simCurrentDetailRunId+'/export?format='+format,{headers:{'X-Auth-Token':authToken}})
    .then(function(r){return r.blob().then(function(b){return {blob:b,name:'simulator-run-'+_simCurrentDetailRunId+'.'+format}})})
    .then(function(o){
      var url = URL.createObjectURL(o.blob);
      var a = document.createElement('a'); a.href = url; a.download = o.name; a.click();
      setTimeout(function(){URL.revokeObjectURL(url)},500);
    });
}
function simOpenRunDetail(id){
  _simCurrentDetailRunId = id;
  document.getElementById('simDetailTitle').textContent = 'Run #'+id;
  document.getElementById('simDetailBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Загрузка…</div>';
  document.getElementById('simDetailModal').style.display = 'flex';
  Promise.all([
    api(API+'/api/admin/simulator/run/'+id),
    api(API+'/api/admin/simulator/run/'+id+'/series?bucket=2'),
    api(API+'/api/admin/simulator/run/'+id+'/by-modem'),
    api(API+'/api/admin/simulator/run/'+id+'/breaking-point'),
  ]).then(function(arr){
    var run = arr[0].run, ser = arr[1].series||[], byM = arr[2].items||[], bp = arr[3];
    var s = run.summary || {};
    var c = run.config;
    var when = run.started_at ? new Date(run.started_at+'Z').toLocaleString('ru-RU') : '—';
    var dur = s.duration_sec ? s.duration_sec + 'с' : '—';
    var concStr = c.concurrency ? (
      c.concurrency.mode==='constant' ? 'constant · '+c.concurrency.workers+' воркеров' :
      c.concurrency.mode==='ramp' ? 'ramp · '+c.concurrency.start+' → '+c.concurrency.end+' за '+c.concurrency.ramp_seconds+'с' :
      c.concurrency.mode==='burst' ? 'burst · '+c.concurrency.workers+' воркеров · '+c.concurrency.on_seconds+'с ON / '+c.concurrency.off_seconds+'с OFF' : c.concurrency.mode
    ) : '—';
    var bpHtml = '';
    if(bp.applicable && bp.breaking_point){
      bpHtml = '<div style="padding:10px 14px;border-radius:8px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);margin-bottom:12px;font-size:12px">🔥 <strong>Breaking-point:</strong> '+bp.breaking_point.workers+' воркеров на t='+bp.breaking_point.t_sec+'с — таймаут '+bp.breaking_point.timeout_pct+'%, P95 '+bp.breaking_point.p95_ms+' мс (база '+bp.breaking_point.base_p95_ms+' мс).</div>';
    } else if(bp.applicable){
      bpHtml = '<div style="padding:10px 14px;border-radius:8px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);margin-bottom:12px;font-size:12px">✓ Breaking-point не найден — модемы выдержали полную ramp-нагрузку.</div>';
    }
    var kpiHtml = '<div class="sim-grid-kpi" style="margin-bottom:12px">'+
      '<div class="sim-kpi accent-blue"><div class="l">Запросов</div><div class="v">'+(s.total_requests||0)+'</div></div>'+
      '<div class="sim-kpi accent-green"><div class="l">Успех</div><div class="v">'+(s.success_pct||0)+'%</div></div>'+
      '<div class="sim-kpi accent-red"><div class="l">Таймаут</div><div class="v">'+(s.timeout_pct||0)+'%</div></div>'+
      '<div class="sim-kpi accent-amber"><div class="l">P50 / P95 / P99</div><div class="v" style="font-size:14px">'+(s.p50_ms||0)+' / '+(s.p95_ms||0)+' / '+(s.p99_ms||0)+'</div></div>'+
      '<div class="sim-kpi accent-purple"><div class="l">Throughput</div><div class="v" style="font-size:16px">'+(s.avg_throughput_mbps||0)+' Mbps</div></div>'+
    '</div>';
    var metaHtml = '<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">'+
      '<div><strong>Профиль:</strong> '+esc(run.profile_name||'ad-hoc')+'</div>'+
      '<div><strong>Запущен:</strong> '+when+'</div>'+
      '<div><strong>Длительность:</strong> '+dur+'</div>'+
      '<div><strong>Concurrency:</strong> '+esc(concStr)+'</div>'+
      '<div><strong>Таймаут:</strong> '+(c.timeout_ms||0)+' мс</div>'+
      '<div><strong>Модемов:</strong> '+(c.target_modems||[]).length+' · <strong>URL:</strong> '+(c.targets||[]).length+'</div>'+
      '<div><strong>Кем запущен:</strong> '+esc(run.started_by||'—')+'</div>'+
      '<div><strong>Статус:</strong> <span class="sim-status-'+run.status+'">'+run.status+'</span></div>'+
      (run.error_msg ? '<div style="grid-column:1/-1;color:#EF4444"><strong>Ошибка:</strong> '+esc(run.error_msg)+'</div>' : '')+
    '</div>';
    var chartHtml = '<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:12px"><div style="font-size:11px;color:var(--text-2);font-weight:600;margin-bottom:6px">RPS / P95 / Таймаут %</div><div style="position:relative;height:220px"><canvas id="simDetailChart"></canvas></div></div>';
    var byMHtml = '<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px"><div style="font-size:11px;color:var(--text-2);font-weight:600;margin-bottom:6px">Разбивка по модемам ('+byM.length+')</div><div id="simDetailByModem"></div></div>';
    document.getElementById('simDetailBody').innerHTML = bpHtml + kpiHtml + metaHtml + chartHtml + byMHtml;
    simDrawTimeSeriesChart('simDetailChart', ser);
    simRenderByModemTable(document.getElementById('simDetailByModem'), byM);
  });
}

function simOpenCompare(){
  var ids = Object.keys(_simHistSel);
  if(ids.length < 2) return;
  _simCurrentDetailRunId = null;  // disable export buttons in comparison view
  document.getElementById('simDetailTitle').textContent = 'Сравнение запусков (' + ids.length + ')';
  document.getElementById('simDetailBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3)">Загрузка…</div>';
  document.getElementById('simDetailExportCsv').style.display='none';
  document.getElementById('simDetailExportJson').style.display='none';
  document.getElementById('simDetailModal').style.display = 'flex';
  api(API+'/api/admin/simulator/compare?run_ids='+ids.join(',')).then(function(d){
      var items = d.items || [];
      // Determine best/worst per metric for highlighting
      var winners = {};
      ['success_pct','timeout_pct','p50_ms','p95_ms','p99_ms','avg_throughput_mbps','total_requests'].forEach(function(k){
        var best=null,worst=null;
        items.forEach(function(it){
          var s = it.summary; if(!s||s[k]==null) return;
          var v = s[k];
          if(best==null || ((k==='success_pct'||k==='avg_throughput_mbps'||k==='total_requests') ? v>best.v : v<best.v)) best={id:it.id,v:v};
          if(worst==null || ((k==='success_pct'||k==='avg_throughput_mbps'||k==='total_requests') ? v<worst.v : v>worst.v)) worst={id:it.id,v:v};
        });
        winners[k] = { best: best && best.id, worst: worst && worst.id };
      });
      var cell = function(it,k,suffix){
        var s = it.summary; if(!s||s[k]==null) return '<td>—</td>';
        var w = winners[k]||{};
        var style = '';
        if(w.best===it.id && w.best!==w.worst) style = 'color:#10B981;font-weight:700';
        else if(w.worst===it.id && w.best!==w.worst) style = 'color:#EF4444;font-weight:700';
        return '<td style="'+style+'">'+s[k]+(suffix||'')+'</td>';
      };
      var headers = items.map(function(it){
        return '<th>#'+it.id+'<br><span style="font-weight:400;color:var(--text-3);font-size:9px">'+esc(it.profile_name||'')+'</span></th>';
      }).join('');
      var concRow = items.map(function(it){
        var c = it.concurrency||{};
        var s = c.mode==='constant'?c.workers:c.mode==='ramp'?c.start+'→'+c.end:c.mode==='burst'?c.workers+'×'+c.on_seconds+'on/'+c.off_seconds+'off':'';
        return '<td>'+(c.mode||'—')+' · '+s+'</td>';
      }).join('');
      var rows =
        '<tr><th>Concurrency</th>'+concRow+'</tr>'+
        '<tr><th>Длительность</th>'+items.map(function(it){return '<td>'+Math.round((it.duration_ms||0)/1000)+'с</td>'}).join('')+'</tr>'+
        '<tr><th>Таймаут профиля</th>'+items.map(function(it){return '<td>'+(it.timeout_ms||0)+' мс</td>'}).join('')+'</tr>'+
        '<tr><th>Модемов</th>'+items.map(function(it){return '<td>'+(it.target_modems_count||0)+'</td>'}).join('')+'</tr>'+
        '<tr><th>Запросов</th>'+items.map(function(it){return cell(it,'total_requests')}).join('')+'</tr>'+
        '<tr><th>Успех</th>'+items.map(function(it){return cell(it,'success_pct','%')}).join('')+'</tr>'+
        '<tr><th>Таймаут</th>'+items.map(function(it){return cell(it,'timeout_pct','%')}).join('')+'</tr>'+
        '<tr><th>P50</th>'+items.map(function(it){return cell(it,'p50_ms',' мс')}).join('')+'</tr>'+
        '<tr><th>P95</th>'+items.map(function(it){return cell(it,'p95_ms',' мс')}).join('')+'</tr>'+
        '<tr><th>P99</th>'+items.map(function(it){return cell(it,'p99_ms',' мс')}).join('')+'</tr>'+
        '<tr><th>Throughput</th>'+items.map(function(it){return cell(it,'avg_throughput_mbps',' Mbps')}).join('')+'</tr>';
      document.getElementById('simDetailBody').innerHTML =
        '<div style="margin-bottom:10px;font-size:11px;color:var(--text-3)">Зелёный = лучший, красный = худший в столбце.</div>'+
        '<div style="overflow-x:auto"><table class="sim-table" style="font-size:12px">'+
          '<thead><tr><th>Метрика</th>'+headers+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
    });
}

// Reset export buttons visibility when opening single-run detail
var _simOrigOpenRunDetail = simOpenRunDetail;
simOpenRunDetail = function(id){
  document.getElementById('simDetailExportCsv').style.display='';
  document.getElementById('simDetailExportJson').style.display='';
  _simOrigOpenRunDetail(id);
};

function simLoadProfilesList(){
  api(API+'/api/admin/simulator/profiles')
    .then(function(d){
      _simState.profiles = d.items || [];
      var sel = document.getElementById('simProfileSelect');
      sel.innerHTML = '<option value="">— Ad-hoc (без сохранения) —</option>' +
        _simState.profiles.map(function(p){ return '<option value="'+p.id+'">'+esc(p.name)+'</option>'; }).join('');
    });
}
function simLoadProfile(id){
  if(!id){ _simState.currentProfileId = null; document.getElementById('simDelProfBtn').style.display='none'; return; }
  _simState.currentProfileId = parseInt(id);
  var p = _simState.profiles.find(function(x){ return x.id === _simState.currentProfileId; });
  if(!p) return;
  var c = p.config;
  // Hydrate state from config
  _simState.selectedModems = {};
  (c.target_modems||[]).forEach(function(m){ _simState.selectedModems[m.server+'|'+m.nick] = true; });
  _simState.urls = (c.targets||[]).length ? c.targets.slice() : [{url:'',weight:1,method:'GET'}];
  _simState.concurrency = c.concurrency || { mode:'constant', workers:4 };
  document.getElementById('simConcMode').value = _simState.concurrency.mode;
  document.getElementById('simDuration').value = Math.round((c.duration_ms||60000)/1000);
  document.getElementById('simTimeout').value = c.timeout_ms||15000;
  simRenderConcParams();
  setTimeout(function(){
    // Inputs are now rendered, populate concurrency-specific fields.
    if(_simState.concurrency.mode==='constant'){
      document.getElementById('simConstWorkers').value = _simState.concurrency.workers||4;
    } else if(_simState.concurrency.mode==='ramp'){
      document.getElementById('simRampStart').value = _simState.concurrency.start||1;
      document.getElementById('simRampEnd').value = _simState.concurrency.end||20;
      document.getElementById('simRampSec').value = _simState.concurrency.ramp_seconds||30;
    } else {
      document.getElementById('simBurstWorkers').value = _simState.concurrency.workers||10;
      document.getElementById('simBurstOn').value = _simState.concurrency.on_seconds||5;
      document.getElementById('simBurstOff').value = _simState.concurrency.off_seconds||5;
    }
  },10);
  simRenderUrlList();
  // Reflect selection in pool list
  simLoadAllModems();
  document.getElementById('simDelProfBtn').style.display='';
}
function simSaveCurrentAsProfile(){
  var name = prompt('Имя профиля:');
  if(!name || !name.trim()) return;
  var p = simBuildProfile();
  p.name = name.trim();
  api(API+'/api/admin/simulator/profiles',{method:'POST',json:{ name: name.trim(), description: '', config: p }}).then(function(d){return {ok:!(d&&d.__status>=400),d:d}}).then(function(o){
    if(!o.ok) return alert(o.d.error || 'Ошибка сохранения');
    simLoadProfilesList();
  });
}
// Reads is_test_pool state from modem_meta via the test-pool list endpoint.
// (No dedicated single-modem endpoint — the list is small enough to scan.)
function loadTestPoolState(server, nick){
  api(API+'/api/admin/simulator/test-pool').then(function(d){
      var inPool = (d.items||[]).some(function(m){ return m.server===server && m.nick===nick; });
      var chk = document.getElementById('testPoolToggleChk');
      if(chk){ chk.checked = inPool; document.getElementById('testPoolToggleStatus').textContent = inPool ? 'В пуле' : ''; }
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Stage 17: lost-modem badge + manual delete + daily health timeline +
//           dynamic operator list + operator-country mapping settings.
// All new code lives in this single block at the end of admin.js so the
// existing minified renderer stays touched as little as possible.
// ═══════════════════════════════════════════════════════════════════════════

// Stage 17.3: «потерян N мин» badge removed per user request — was visually
// noisy and duplicated information already conveyed by the status pill.
// The status pill (.status-pill, see _statusPill below) is now the single
// source of truth for «modem is offline» at a glance.
function _lostBadge() { return ''; }

// ── Status pill — replaces the easy-to-miss 8-px colored dot.
// Stage 18.11: no length-of-downtime suffix anymore — pill is just
// "OFFLINE" / "ONLINE" / "РОТАЦИЯ" / "РЕБУТ". The lastSeenMs is still
// computed in processData() and used for SORTING (recently-died on top,
// stale at the bottom of each server group) + appears in the hover tooltip.
function _statusPill(status, modem) {
  var labels = { online: 'ONLINE', offline: 'OFFLINE', rotating: 'РОТАЦИЯ', rebooting: 'РЕБУТ' };
  var titles = {
    online:    'Модем на связи',
    offline:   'Модем не отвечает',
    rotating:  'Меняет IP (ротация)',
    rebooting: 'Перезагружается'
  };
  var label = labels[status] || (status || '?').toUpperCase();
  var title = titles[status] || ('Статус: ' + (status || 'неизвестно'));
  // Enrich tooltip only — pill text stays clean.
  if (status === 'offline' && modem && modem.lastSeenMs) {
    var ageMs = Date.now() - modem.lastSeenMs;
    if (ageMs > 60000) {
      var mins = Math.floor(ageMs / 60000);
      var ageLabel = mins < 60 ? mins + ' мин'
                  : mins < 1440 ? Math.floor(mins / 60) + ' ч'
                  : Math.floor(mins / 1440) + ' д';
      title = 'Не отвечает ' + ageLabel + ' (последний отклик: ' + new Date(modem.lastSeenMs).toLocaleString('ru-RU') + ')';
    }
  }
  return '<span class="status-pill ' + status + '" title="' + esc(title) + '">' + label + '</span>';
}

// ── 2) Manual modem deletion (server enforces "must be offline" rule) ──
function deleteModem(server, portId, nick) {
  // Через кастомный диалог (native confirm() глушится настройкой «не показывать
  // диалоги» — из-за этого офлайн-модемы «не удалялись»).
  confirmDialog('Удалить модем «'+nick+'» из дашборда?\n\nОфлайн/призрачный модем исчезнет навсегда. Если модем физически на связи — он вернётся при следующем опросе ProxySmart.', function(){
    api(API+'/api/admin/modems/'+encodeURIComponent(server)+'/'+encodeURIComponent(portId)+'?nick='+encodeURIComponent(nick||''),{method:'DELETE'})
      .then(function(j){ var st=(j&&typeof j==='object')?(j.__status||200):500; return { ok: st<400, status: st, body: (j&&typeof j==='object')?j:{error:'HTTP '+st+' (не-JSON). Обнови страницу и попробуй снова.'} }; })
      .then(function(r){
        if (!r.ok) { showToast('Ошибка удаления: ' + (r.body && (r.body.message || r.body.error) || ('HTTP '+r.status)), 'error'); return; }
        showToast('Модем «'+nick+'» удалён', 'success');
        // Оптимистично убираем строку/плитку сразу — иначе модем «висит» до конца
        // медленного loadData() и удаление кажется долгим.
        try{ document.querySelectorAll('tr.modem-row, .modem-tile').forEach(function(elm){ if(elm.dataset && elm.dataset.nick===nick && elm.dataset.server===server) elm.remove(); }); }catch(_){}
        if (typeof closeModal === 'function') closeModal();
        if (typeof loadData === 'function') setTimeout(loadData, 50); else location.reload();   // сверка фоном
      })
      .catch(function(e){ showToast('Сеть: ' + e.message, 'error'); });
  }, 'Удалить', 'Удаление модема', true);
}

// ── 3) Daily health timeline (30 cells) in the «Здоровье» tab ──
function renderHealthDailyTimeline(m) {
  var box = document.getElementById('healthDailyTimeline');
  if (!box) return;
  if (!m.rawImei) { box.innerHTML = ''; return; }
  box.innerHTML = '<div style="color:var(--text-3);font-size:11px;padding:8px 0">Загрузка истории за 30 дней…</div>';
  api(API+'/api/analytics/modem_health_history?server='+encodeURIComponent(m.server)+'&imei='+encodeURIComponent(m.rawImei)+'&days=30')
    .then(function(d){
      var rows = (d && d.rows) || [];
      // Build a map date → row, then iterate the last 30 days so missing days
      // appear as grey cells rather than being skipped.
      var byDate = {};
      rows.forEach(function(r){ byDate[r.date] = r; });
      var cells = '';
      var today = new Date();
      // We display the last 30 days ending YESTERDAY (today's snapshot lands
      // at 23:55 MSK; rendering it before that is misleading).
      for (var i = 30; i >= 1; i--) {
        var d2 = new Date(today.getTime() - i * 86400000);
        var date = d2.toISOString().slice(0, 10);
        var r = byDate[date];
        var bg, title;
        if (!r || r.score == null) {
          bg = 'var(--bg-3)';
          title = date + ' — нет данных';
        } else {
          if      (r.score >= 80) bg = 'rgb(52,199,89)';   // green
          else if (r.score >= 50) bg = 'rgb(255,159,10)';  // orange
          else                    bg = 'rgb(239,80,80)';   // red
          title = date + ' · Скор: ' + r.score +
                  (r.latency_ms != null ? ' · Латенси: ' + fmtMs(r.latency_ms) : '') +
                  (r.error_pct != null ? ' · Ошибки: ' + r.error_pct + '%' : '') +
                  (r.uptime_pct != null ? ' · Аптайм: ' + r.uptime_pct + '%' : '') +
                  ' · Проверок: ' + (r.total_checks || 0);
        }
        var dayLabel = d2.getDate();
        var weekStart = d2.getDay() === 1; // Monday — mark with subtle border
        cells += '<div title="'+title+'" style="flex:1;min-width:0;height:32px;background:'+bg+';border-radius:3px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:2px;font-size:8px;color:rgba(255,255,255,.7);font-weight:600;'+(weekStart?'box-shadow:inset 2px 0 0 rgba(255,255,255,.15)':'')+'">'+(i%5===0?dayLabel:'')+'</div>';
      }
      var html = '<div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;font-weight:600;display:flex;justify-content:space-between;align-items:baseline">';
      html += '<span>Здоровье по дням (30 дн.)</span>';
      html += '<span style="font-size:10px;color:var(--text-3);text-transform:none;letter-spacing:0">наведите на ячейку для деталей</span>';
      html += '</div>';
      html += '<div style="display:flex;gap:2px">'+cells+'</div>';
      html += '<div style="display:flex;gap:14px;font-size:10px;color:var(--text-3);margin-top:6px;align-items:center">';
      html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgb(52,199,89);border-radius:2px;vertical-align:middle;margin-right:4px"></span>≥ 80</span>';
      html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgb(255,159,10);border-radius:2px;vertical-align:middle;margin-right:4px"></span>50–79</span>';
      html += '<span><span style="display:inline-block;width:10px;height:10px;background:rgb(239,80,80);border-radius:2px;vertical-align:middle;margin-right:4px"></span>&lt; 50</span>';
      html += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--bg-3);border-radius:2px;vertical-align:middle;margin-right:4px"></span>нет данных</span>';
      html += '</div>';
      box.innerHTML = html;
    })
    .catch(function(e){ box.innerHTML = '<div style="color:var(--danger);font-size:11px;padding:8px 0">История недоступна: '+esc(e.message)+'</div>'; });
}

// ── 4) Dynamic operator list — replaces hardcoded _heatmapConfig.operator ──
// Called once at boot from the existing init flow (see admin.html); also
// re-callable whenever the operators settings card mutates the mapping.
function refreshOperatorList() {
  return api(API+'/api/admin/operators')
    .then(function(d){
      var ops = (d && d.operators) || [];
      // Keep only operators with at least 1 modem currently using them, sort
      // by usage descending, and convert into the {id, label, modems} shape.
      var FLAGS = { RO: '🇷🇴', MD: '🇲🇩', RU: '🇷🇺', UA: '🇺🇦' };
      var list = ops
        .filter(function(o){ return (o.modem_count || 0) > 0; })
        .sort(function(a,b){ return b.modem_count - a.modem_count; })
        .map(function(o){
          var flag = FLAGS[o.country] || '🌐';
          var label = flag + ' ' + (o.operator || o.operator_normalized);
          return { id: o.operator_normalized, label: label, modems: o.modem_count };
        });
      if (list.length) _heatmapConfig.operator = list;
      window._operatorsList = ops;
    })
    .catch(function(){ /* fall back to hardcoded list, no UX impact */ });
}

// ── 5) Operator-country mapping UI in Settings (snav_operators section) ──
function loadOperatorsMapping() {
  var box = document.getElementById('opMapList');
  if (!box) return;
  box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:12px">Загрузка…</div>';
  api(API+'/api/admin/operators')
    .then(function(d){
      var ops = (d && d.operators) || [];
      if (!ops.length) { box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:12px">Операторов пока не определено.</div>'; return; }
      var h = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
      h += '<thead><tr style="color:var(--text-3);font-size:10px;text-transform:uppercase;letter-spacing:.05em"><th style="text-align:left;padding:8px 6px">Оператор</th><th style="text-align:left;padding:8px 6px">Страна</th><th style="text-align:left;padding:8px 6px">Источник</th><th style="text-align:right;padding:8px 6px">Модемов</th><th style="padding:8px 6px"></th></tr></thead><tbody>';
      ops.forEach(function(o){
        var srcBadge = o.source === 'manual'
          ? '<span style="background:rgba(99,102,241,.15);color:var(--accent);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">вручную</span>'
          : o.source === 'auto'
            ? '<span style="background:rgba(52,199,89,.12);color:var(--green);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">авто</span>'
            : '<span style="color:var(--text-3);font-size:10px">—</span>';
        var FLAGS = { RO: '🇷🇴', MD: '🇲🇩', RU: '🇷🇺', UA: '🇺🇦' };
        var country = o.country || '';
        var flag = FLAGS[country] || '';
        h += '<tr>';
        h += '<td style="padding:8px 6px;color:var(--text-0)"><strong>'+esc(o.operator)+'</strong><div style="font-size:10px;color:var(--text-3);margin-top:2px">'+(o.servers || []).join(', ')+'</div></td>';
        h += '<td style="padding:8px 6px">';
        h += '<select onchange="setOperatorCountry(\''+encodeURIComponent(o.operator_normalized)+'\', this.value)" style="background:var(--bg-2);border:1px solid var(--border);color:var(--text-1);padding:4px 8px;border-radius:6px;font-size:12px;cursor:pointer">';
        h += '<option value="" '+(!country?'selected':'')+'>— не задана —</option>';
        ['RO','MD','RU','UA'].forEach(function(c){ h += '<option value="'+c+'" '+(country===c?'selected':'')+'>'+(FLAGS[c]||'')+' '+c+'</option>'; });
        h += '</select>';
        if (flag) h += ' <span style="font-size:14px;margin-left:6px">'+flag+'</span>';
        h += '</td>';
        h += '<td style="padding:8px 6px">'+srcBadge+'</td>';
        h += '<td style="text-align:right;padding:8px 6px;color:var(--text-0);font-weight:600">'+o.modem_count+'</td>';
        h += '<td style="text-align:right;padding:8px 6px">';
        if (o.source === 'manual') {
          h += '<button onclick="dropOperatorMapping(\''+encodeURIComponent(o.operator_normalized)+'\')" title="Снять ручной маппинг — следующий опрос восстановит \'auto\'" style="background:none;border:1px solid var(--border);color:var(--text-3);padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer">↺ авто</button>';
        }
        h += '</td></tr>';
      });
      h += '</tbody></table>';
      box.innerHTML = h;
    })
    .catch(function(e){ box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>'; });
}
function setOperatorCountry(opEnc, country) {
  if (!country) return; // ignore the "не задана" choice for now
  api(API+'/api/admin/operators/'+opEnc+'/country',{method:'PUT',json:{ country: country }})
    .then(function(){ loadOperatorsMapping(); refreshOperatorList(); })
    .catch(function(e){ alert('Ошибка: ' + e.message); });
}
function dropOperatorMapping(opEnc) {
  if (!confirm('Снять ручной маппинг? Следующий опрос восстановит автоматическую привязку по стране сервера.')) return;
  api(API+'/api/admin/operators/'+opEnc,{method:'DELETE'})
    .then(function(){ loadOperatorsMapping(); refreshOperatorList(); })
    .catch(function(e){ alert('Ошибка: ' + e.message); });
}

// ── 6) Inject delete button into info tab — only for offline modems ──
// Hook into renderTabContent: after the info tab renders, look for offline
// modem and append the delete button. We use a small wrapper to avoid
// touching the existing renderTabContent code path.
(function hookDeleteButton(){
  var origRender = window.renderTabContent;
  if (typeof origRender !== 'function') return;
  window.renderTabContent = function(tab) {
    origRender.apply(this, arguments);
    if (tab !== 'info') return;
    var m = window.currentDetailModem;
    if (!m) return;
    var status = getModemStatus(m);
    if (!_isStaleModem(m)) return;   // только давно офлайн (как и кнопка 🗑 в таблице/плитке)
    // Find the port_id for this modem. We need ONE port_id to identify the
    // known_modems entry. Pick the first port (any will resolve to same imei
    // server-side).
    var port = (m.ports && m.ports[0]) || {};
    var portId = port.portID || '';
    if (!portId) return;
    var portIdRaw = portId.replace(/^S\d+_/, ''); // strip server prefix the FE adds
    var body = document.getElementById('modalBody');
    if (!body) return;
    // Append once
    if (body.querySelector('#stage17DeleteRow')) return;
    var row = document.createElement('div');
    row.id = 'stage17DeleteRow';
    row.style.cssText = 'margin-top:14px;padding:12px 14px;background:rgba(239,80,80,.06);border:1px solid rgba(239,80,80,.25);border-radius:10px;display:flex;align-items:center;gap:12px';
    row.innerHTML = '<div style="flex:1"><div style="font-size:13px;font-weight:600;color:var(--text-0)">Модем отключён</div><div style="font-size:11px;color:var(--text-2);margin-top:2px">Можно удалить из дашборда. Действие нельзя отменить.</div></div>'
      + '<button onclick="deleteModem(\''+m.server+'\',\''+portIdRaw+'\',\''+esc(m.nick)+'\')" style="background:var(--danger);border:none;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">🗑 Удалить навсегда</button>';
    body.appendChild(row);
  };
})();

// ── 7) Bootstrap dyn operator list on auth — call after authToken is set ──
(function bootstrapDynOperators(){
  // Try shortly after auth; if no token yet, retry once a sec until found.
  var tries = 0;
  var iv = setInterval(function(){
    tries++;
    if (typeof authToken === 'string' && authToken) {
      clearInterval(iv);
      refreshOperatorList();
    } else if (tries > 30) {
      clearInterval(iv);
    }
  }, 1000);
})();

function toggleTestPool(server, nick, enabled){
  document.getElementById('testPoolToggleStatus').textContent = '…';
  api(API+'/api/admin/modem/test-pool',{method:'POST',json:{ server: server, nick: nick, enabled: enabled }}).then(function(d){
    if(d.ok){ document.getElementById('testPoolToggleStatus').textContent = enabled ? '✓ Добавлен' : '✓ Удалён'; }
    else { document.getElementById('testPoolToggleStatus').textContent = '❌ '+(d.error||''); }
  });
}

function simDeleteProfile(){
  if(!_simState.currentProfileId) return;
  if(!confirm('Удалить профиль?')) return;
  api(API+'/api/admin/simulator/profiles/'+_simState.currentProfileId,{method:'DELETE'}).then(function(){
    _simState.currentProfileId = null;
    document.getElementById('simProfileSelect').value = '';
    document.getElementById('simDelProfBtn').style.display='none';
    simLoadProfilesList();
  });
}

// ─── Stage 18.13: Telegram-уведомления UI ───────────────────────────────
function saveModemsDownThreshold(){
  var v=parseInt(document.getElementById('setModemsDownThreshold').value,10);
  if(isNaN(v)||v<0||v>100){showToast('Введите число 0–100','error');return}
  api(API+'/api/admin/settings',{method:'PUT',json:{modems_down_threshold:v}})
    .then(function(d){
      if(d.error){showToast(d.error,'error');return}
      var h=document.getElementById('mdtSaveHint');if(h){h.textContent='Сохранено';setTimeout(function(){h.textContent=''},2500)}
      showToast(v===0?'Сводка выключена':('Сводка при '+v+' модемах'),'success');
    }).catch(function(e){showToast(e.message||'Ошибка сети','error')});
}
function loadAlertRules(){
  try{var _mdt=document.getElementById('setModemsDownThreshold');if(_mdt&&currentData&&currentData.settings&&currentData.settings.modems_down_threshold!=null)_mdt.value=currentData.settings.modems_down_threshold;}catch(_){}
  var box = document.getElementById('alertsList');
  if(!box) return;
  box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:12px">Загрузка…</div>';
  api(API+'/api/admin/alerts')
    .then(function(d){
      var rules = (d && d.rules) || [];
      var groups = { critical: [], important: [], early: [] };
      rules.forEach(function(r){ (groups[r.priority] || groups.important).push(r); });
      var titles = {
        critical: { label: '🔴 Критические', desc: 'Срабатывают мгновенно при серьёзных сбоях' },
        important: { label: '🟡 Важные',     desc: 'Заметные события с защитой от спама (cooldown)' },
        early: { label: '🔵 Превентивные',    desc: 'Раннее предупреждение, пока ещё не критично' },
      };
      function _cdLabel(sec){
        if(!sec) return '';
        if(sec < 60) return sec+'с';
        if(sec < 3600) return Math.floor(sec/60)+'мин';
        if(sec < 86400) return Math.floor(sec/3600)+'ч';
        return Math.floor(sec/86400)+'д';
      }
      var h = '';
      ['critical','important','early'].forEach(function(p){
        if(!groups[p].length) return;
        var t = titles[p];
        h += '<div style="margin-bottom:18px">';
        h += '<div style="font-size:13px;font-weight:600;color:var(--text-0);margin-bottom:3px">'+t.label+'</div>';
        h += '<div style="font-size:11px;color:var(--text-3);margin-bottom:9px">'+t.desc+'</div>';
        h += '<div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;overflow:hidden">';
        groups[p].forEach(function(r, i){
          var sep = i > 0 ? 'border-top:1px solid var(--border);' : '';
          // Stage 18.15 — channel badge (TG+Bell vs Bell only).
          var isBell = r.channel === 'bell';
          var chColor = isBell ? 'var(--text-2)' : 'var(--accent)';
          var chBg    = isBell ? 'var(--bg-3)'  : 'rgba(0,122,255,0.12)';
          var chLabel = isBell ? '🔔 только в админке' : 'TG + 🔔';
          var testTitle = isBell ? 'Создать тестовую запись в колокольчике' : 'Отправить пример в Telegram';
          h += '<div style="display:flex;align-items:center;gap:12px;padding:11px 14px;'+sep+'">';
          h += '<div style="flex:1;min-width:0">';
          h += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span style="font-size:13px;font-weight:500;color:var(--text-0)">'+esc(r.title)+'</span>';
          h += '<span style="background:'+chBg+';color:'+chColor+';padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap">'+chLabel+'</span></div>';
          h += '<div style="font-size:10px;color:var(--text-3);margin-top:2px;font-family:var(--font-mono)">'+esc(r.id)+' · повтор не чаще '+_cdLabel(r.cooldownSec)+'</div>';
          h += '</div>';
          h += '<button class="btn btn-sm" style="font-size:11px;padding:4px 10px;flex-shrink:0" onclick="testAlertRule(\''+esc(r.id)+'\')" title="'+testTitle+'">📤 Тест</button>';
          h += '<label class="tgl"><input type="checkbox" '+(r.enabled?'checked':'')+' onchange="toggleAlertRule(\''+esc(r.id)+'\', this.checked)"><span></span></label>';
          h += '</div>';
        });
        h += '</div></div>';
      });
      box.innerHTML = h;
    })
    .catch(function(e){ box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>'; });
}
function toggleAlertRule(id, enabled){
  api(API+'/api/admin/alerts/'+encodeURIComponent(id),{method:'PUT',json:{ enabled: !!enabled }})
    .then(function(d){
      if(d && d.ok) showToast((enabled?'включено':'выключено')+': '+id, 'success');
      else showToast('Не сохранилось: '+(d && d.error || ''), 'error');
    })
    .catch(function(e){ showToast('Сеть: '+e.message, 'error'); });
}
function testAlertRule(id){
  api(API+'/api/admin/alerts/'+encodeURIComponent(id)+'/test',{method:'POST'})
    .then(function(d){
      showToast(d && d.ok ? 'Тест отправлен в Telegram' : (d && d.note || 'Не отправлено'), d && d.ok ? 'success' : 'warning');
    })
    .catch(function(e){ showToast('Сеть: '+e.message, 'error'); });
}

// ========================================================================
// Stage 18.23 — ⚡ NEW (unified analytics view)
// ========================================================================
// Lives parallel to the existing 3 sub-tabs (Трафик/Инфра/Доходность).
// Same render functions where they accept target IDs (renderSys*); for the
// heatmap / clients / daily / latency / matrix / top hosts blocks we
// write thin parallel renderers that hit the same endpoints. After UX
// validation this view will replace the three legacy tabs.
// ── персист UI-состояния дашборда: раскрывашки + вкладки/фильтры виджетов ──
var _dashUi=(function(){try{return JSON.parse(localStorage.getItem('dash_ui_state')||'{}')}catch(e){return {}}})();
function _dashUiSave(patch){try{Object.keys(patch).forEach(function(k){_dashUi[k]=patch[k]});localStorage.setItem('dash_ui_state',JSON.stringify(_dashUi))}catch(e){}}
var _newHmView=_dashUi.hmView||'country', _newHmId=_dashUi.hmId||'all';
var _newHmData=null;
var _newLatencyData=null;
var _newDailyChart=null;
var _newLatencyChart=null;

// ⚡ «Командный центр» — decision-first unified analytics view.
// Order = urgency: Пульс → Требует внимания → Финансы → Парк → Трафик.
// Always-visible: pulse, action-center, finance summary+flow, fleet servers+health,
// heatmap, daily, traffic-clients. Lazy (<details>): per-client P&L, reconciliation,
// infra (rotations/IP/capacity), latency dist, top hosts, traffic matrix.
function renderAccNew(){
  if(!currentData){return;}
  var d = collectTrafficData();
  if(!d){return;}
  window._newReconLoaded = false;          // re-arm reconciliation chip on each (re)render
  var _ua = document.getElementById('dashUpdatedAt');
  if(_ua){ var _n=new Date(); _ua.textContent='обновлено '+String(_n.getHours()).padStart(2,'0')+':'+String(_n.getMinutes()).padStart(2,'0'); }
  try{ renderNewExtWidgets(); }catch(e){}  // плитки «Требует внимания»
  renderNewFleetServers();                 // instant — детальные карточки серверов
  try{ renderNewTopProblems(); }catch(e){} // топ проблемных модемов
  renderNewClientTable(d);                 // traffic table (Трафик section)
  loadNewFinance();                        // → pulse + finance quality/trend + финсводка
  loadNewHeatmap();
  loadNewDailyChart();                      // потребление по дням (60д, по клиентам/странам)
  // Wire collapsibles' lazy-load (once per session)
  if(!window._newDetailsWired){
    document.querySelectorAll('#tab-dashboard details.acc-expand').forEach(function(el){
      el.addEventListener('toggle', onNewSectionToggle);
    });
    window._newDetailsWired = true;
  }
  // Восстановление сохранённого состояния дашборда (однократно за сессию)
  if(!window._dashUiApplied){
    window._dashUiApplied = true;
    var _sv = _dashUi.sec || {};
    document.querySelectorAll('#tab-dashboard details.acc-expand').forEach(function(el){
      var s = el.dataset.section;
      if(s && Object.prototype.hasOwnProperty.call(_sv, s)) el.open = !!_sv[s];
    });
    ['country','operator','client'].forEach(function(v){var b=document.getElementById('newHmTab'+v.charAt(0).toUpperCase()+v.slice(1));if(b)b.classList.toggle('active',v===_newHmView);});
    ['clients','countries'].forEach(function(x){var b=document.getElementById('newDailyMode_'+x);if(b)b.classList.toggle('active',x===_newDailyMode);});
    document.querySelectorAll('#tab-dashboard [onclick^="setNewInfraDays("]').forEach(function(c){c.classList.toggle('on',c.getAttribute('onclick').indexOf('setNewInfraDays('+_NEW_INFRA_DAYS+',')===0);});
  }
  // Секции, раскрытые по умолчанию (open в разметке), не получают событие toggle —
  // подгружаем их содержимое один раз здесь.
  document.querySelectorAll('#tab-dashboard details.acc-expand[open]').forEach(function(el){
    if(el.dataset.loaded === '1') return;
    el.dataset.loaded = '1';
    var s = el.dataset.section;
    if(s === 'latency'){ loadNewLatency(); }
    else if(s === 'infra'){ reloadNewInfra(); }
    else if(s === 'apiaccess'){ loadNewApiAccess(); }
    else if(s === 'matrix'){ renderNewMatrix(); }
    else if(s === 'finclients'){ renderNewFinClients(); }
    else if(s === 'recon'){ loadNewReconciliation(); }
    else if(s === 'resources'){ loadNewTopHosts(); }
  });
  // «Топ ресурсов» может быть закрыт — грузим заранее, чтобы при раскрытии данные были на месте.
  var resEl = document.querySelector('#tab-dashboard details.acc-expand[data-section="resources"]');
  if(resEl && resEl.dataset.loaded !== '1'){ resEl.dataset.loaded = '1'; loadNewTopHosts(); }
}

function onNewSectionToggle(ev){
  var el = ev.target;
  var section = el.dataset.section;
  if(section){var _sv=_dashUi.sec||{};_sv[section]=el.open?1:0;_dashUiSave({sec:_sv});}
  if(!el.open) return;
  // infra + finclients + apiaccess re-render cheaply on each open; others load once
  if(el.dataset.loaded === '1' && section !== 'infra' && section !== 'finclients' && section !== 'apiaccess') return;
  if(section === 'latency'){ loadNewLatency(); }
  else if(section === 'infra'){ reloadNewInfra(); }
  else if(section === 'matrix'){ renderNewMatrix(); }
  else if(section === 'finclients'){ renderNewFinClients(); }
  else if(section === 'recon'){ loadNewReconciliation(); }
  else if(section === 'apiaccess'){ loadNewApiAccess(); }
  else if(section === 'resources'){ loadNewTopHosts(); }
  el.dataset.loaded = '1';
}

// ── «Обращения к API» — журнал входящих обращений (кто · когда · зачем) ──────
var _apiAccessState = { hours: _dashUi.apiHours||24, type: _dashUi.apiType||'' };
function _apiTypeLabel(t){ return ({api_key:'API-ключ',portal:'Портал',reset_link:'Ротация по ссылке',webhook:'Вебхук',auth:'Вход'})[t] || t; }
function _apiTypeColor(t){ return ({api_key:'var(--accent)',portal:'var(--blue)',reset_link:'var(--success)',webhook:'var(--purple)',auth:'var(--text-2)'})[t] || 'var(--text-2)'; }
function _fmtApiTs(ts){
  if(!ts) return '';
  try{
    var d = new Date(String(ts).replace(' ','T')+'Z');
    var now = new Date();
    var t = d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
    return (d.toDateString()===now.toDateString()) ? t
      : d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+t;
  }catch(_){ return ts; }
}
function setApiAccessType(t){ _apiAccessState.type = (_apiAccessState.type===t ? '' : t); _dashUiSave({apiType:_apiAccessState.type}); loadNewApiAccess(); }
function setApiAccessHours(h){ _apiAccessState.hours = h; _dashUiSave({apiHours:h}); loadNewApiAccess(); }
function loadNewApiAccess(){
  var bar = document.getElementById('newApiAccessBar');
  var box = document.getElementById('newApiAccess');
  if(!box) return;
  var st = _apiAccessState;
  var url = API + '/api/admin/api_access_log?hours=' + st.hours + '&limit=150' + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
  api(url)
    .then(function(d){
      if(!d || d.error){ box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:8px">'+esc((d&&d.error)||'Ошибка')+'</div>'; return; }
      var typeCounts = {}; (d.by_type||[]).forEach(function(x){ typeCounts[x.caller_type] = x.c; });
      var chips = '';
      ['api_key','portal','reset_link','webhook'].forEach(function(t){
        var on = st.type===t;
        chips += '<button class="qf-chip'+(on?' active':'')+'" onclick="setApiAccessType(\''+t+'\')">'+_apiTypeLabel(t)+'</button>';
      });
      var opts = [[1,'1 час'],[24,'24 часа'],[168,'7 дней'],[720,'30 дней']];
      var hoursSel = '<select class="form-input" style="font-size:11px;padding:4px 8px;width:auto" onchange="setApiAccessHours(parseInt(this.value))">'
        + opts.map(function(o){ return '<option value="'+o[0]+'"'+(st.hours===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('') + '</select>';
      var s = d.summary || {};
      var n = s.total||0, _a=n%100, _b=n%10;
      var reqWord = (_a>10&&_a<20)?'запросов':(_b>1&&_b<5)?'запроса':(_b===1)?'запрос':'запросов';
      if(bar){
        bar.innerHTML = '<div class="qf-chips" style="display:flex;gap:6px;flex-wrap:wrap">'+chips+'</div>'
          + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--text-2)">'+hoursSel
          + '<span>· <strong style="color:var(--text-0)">'+n+'</strong> '+reqWord+'</span></div>';
      }
      var rows = d.recent || [];
      if(!rows.length){ box.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:14px;text-align:center">Нет обращений за выбранный период</div>'; return; }
      var _totalRows = rows.length; rows = rows.slice(0,_zxLim('api',12));
      var h = '<div style="overflow-x:auto"><table class="ztbl" style="width:100%"><thead><tr>'
        + '<th>Время</th><th style="text-align:left">Кто</th><th style="text-align:left">Тип</th><th style="text-align:left">Цель</th><th style="text-align:left">Запрос</th><th>Статус</th><th>мс</th><th>IP</th></tr></thead><tbody>';
      rows.forEach(function(r){
        var code = r.status||0;
        var stColor = code>=500 ? 'var(--danger)' : code>=400 ? 'var(--warning)' : 'var(--success)';
        h += '<tr>'
          + '<td style="white-space:nowrap;color:var(--text-2)">'+_fmtApiTs(r.ts)+'</td>'
          + '<td style="text-align:left"><strong>'+esc(r.client_name||'—')+'</strong>'+(r.identity?'<span style="color:var(--text-3);margin-left:5px;font-family:var(--font-mono);font-size:10px">'+esc(r.identity)+'</span>':'')+'</td>'
          + '<td style="text-align:left"><span style="color:'+_apiTypeColor(r.caller_type)+';font-weight:600">'+_apiTypeLabel(r.caller_type)+'</span></td>'
          + '<td style="text-align:left">'+esc(r.purpose||'—')+'</td>'
          + '<td style="text-align:left;color:var(--text-3);font-family:var(--font-mono);font-size:10px">'+esc((r.method||'')+' '+(r.path||''))+'</td>'
          + '<td style="color:'+stColor+';font-weight:600">'+code+'</td>'
          + '<td style="color:var(--text-3)">'+(r.duration_ms!=null?r.duration_ms:'')+'</td>'
          + '<td style="color:var(--text-3);font-family:var(--font-mono);font-size:10px">'+esc(r.ip||'')+'</td>'
          + '</tr>';
      });
      h += '</tbody></table></div>';
      box.innerHTML = h;
    })
    .catch(function(){ box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:8px">Ошибка загрузки</div>'; });
}

// ── 1. Пульс бизнеса (hero KPI) — Трафик «.widget» style ───────────
// Наша себестоимость трафика по операторам (₽/ГБ из настроек × месячный трафик).
function _opGbCosts(){ return (currentData&&currentData.settings&&currentData.settings.operator_gb_costs)||{}; }
function _operatorMonthGb(){ var d=collectTrafficData(); var byOp={}; if(d&&d.modemTraffic){d.modemTraffic.forEach(function(m){var op=m.operator||'Неизвестный';byOp[op]=(byOp[op]||0)+((m.monIn||0)+(m.monOut||0))/1e9;});} return byOp; }
function _operatorTrafficCost(){ var costs=_opGbCosts(),gb=_operatorMonthGb(),total=0; Object.keys(gb).forEach(function(op){total+=gb[op]*(costs[op]||0);}); return total; }
function renderNewPulse(fin){
  var s = (fin && fin.summary) || {};
  var clients = currentData.clients || [];
  var cashFloat = clients.reduce(function(a,c){var b=c.balance||0;return a+(b>0?b:0);},0);
  var gc = s.mrr_growth_pct;
  var nrrColor = (s.nrr_pct==null)?'var(--text-3)':(s.nrr_pct>=100?'var(--success)':s.nrr_pct>=90?'var(--warning)':'var(--danger)');
  // Бывший ряд «Пульс» удалён — заполняем его только если элемент ещё на странице.
  var el = document.getElementById('newPulseRow');
  if(el){
    var _td=collectTrafficData(), _today=0;
    if(_td&&_td.modemTraffic){_td.modemTraffic.forEach(function(m){_today+=(m.dayIn||0)+(m.dayOut||0);});}
    var _fl=(currentData.fleet&&currentData.fleet.byServer)||null, _fw=0, _ft=0;
    if(_fl){Object.keys(_fl).forEach(function(k){var b=_fl[k]||{};_fw+=(b.working!=null?b.working:(b.online||0));_ft+=(b.total||0);});}
    if(_ft<_fw)_ft=_fw;
    var growthSub = (gc==null) ? '<span style="color:var(--text-3)">нет данных М/М</span>'
      : '<span style="color:'+(gc>=0?'var(--success)':'var(--danger)')+'">'+(gc>=0?'▲ +':'▼ ')+gc+'% М/М</span>';
    el.innerHTML =
      _ncPulseCard('Трафик сегодня', fmtGb(_today), '<span style="color:var(--text-3)">по всему парку</span>', 'accent') +
      _ncPulseCard('Активные модемы', _fw+'/'+_ft, '<span style="color:var(--text-3)">в работе</span>', (_fw>=_ft?'success':'warn')) +
      // WP8: canonical revenue_30d (одно число со страницей клиентов); s.mrr — fallback для старых payload'ов.
      _ncPulseCard('Выручка за 30 дней', _fmtRub((s.metrics&&s.metrics.revenue_30d!=null)?s.metrics.revenue_30d:s.mrr), growthSub, 'accent') +
      _ncPulseCard('На балансах', _fmtRub(cashFloat), '<span style="color:var(--text-3)">предоплата клиентов</span>', 'success');
  }
  // Финсводка-виджет (верхний ряд, бывший слот «Ресурсы») — MRR / NRR / прирост M/M / на балансах
  var fsEl=document.getElementById('newFinSummaryBody');
  if(fsEl){
    function _fsRow(l,v,c,last){return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px'+(last?'':';border-bottom:1px solid var(--border)')+'"><span style="color:var(--text-2)">'+l+'</span><span style="font-weight:600'+(c?';color:'+c:'')+'">'+v+'</span></div>';}
    fsEl.innerHTML =
      _fsRow('Выручка 30д', _fmtRub((s.metrics&&s.metrics.revenue_30d!=null)?s.metrics.revenue_30d:s.mrr), 'var(--text-0)') +
      _fsRow('NRR', s.nrr_pct==null?'—':(s.nrr_pct+'%'), nrrColor) +
      _fsRow('Прирост M/M', gc==null?'—':((gc>=0?'+':'')+gc+'%'), gc==null?'var(--text-3)':(gc>=0?'var(--success)':'var(--danger)')) +
      _fsRow('На балансах', _fmtRub(cashFloat), 'var(--accent)', true);
  }
}

// ── 2. Требует внимания (action center) — Трафик «probItem» style ──
// Tinted pill rows like the «🔧 Проблемы инфраструктуры» card: colored dot +
// label + count, green-bg when 0, red/orange-bg when there's something to act on.
function _ncStatRow(label, count, sub, severity){
  var n = count || 0;
  var bg = n===0 ? 'var(--green-bg)' : severity==='danger' ? 'var(--red-bg)' : 'var(--orange-bg)';
  var col = n===0 ? 'var(--success)' : severity==='danger' ? 'var(--danger)' : 'var(--warning)';
  return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;background:'+bg+';font-size:11px">' +
    '<span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:'+col+'"></span>' +
    '<span style="flex:1;color:var(--text-2)">'+label+(sub?' <span style="color:var(--text-3)">· '+sub+'</span>':'')+'</span>' +
    '<span style="font-weight:700;color:'+col+';font-size:13px">'+n+'</span></div>';
}
function renderNewActionCenter(d){
  var el = document.getElementById('newActionRow'); if(!el) return;
  var fleet = currentData.fleet || {};
  var clients = currentData.clients || [];
  var disc = fleet.disconnected || 0;
  var issues = (currentData.proxyIssues || []).length;
  var debtors = clients.filter(function(c){return (c.balance||0) < -10;});
  var debtSum = debtors.reduce(function(a,c){return a+(c.balance||0);},0);
  var paused = clients.filter(function(c){return c.paused;}).length;
  var allOk = !disc && !issues && !debtors.length && !paused;
  var h = '<div class="analytics-card" style="margin-bottom:18px">';
  h += '<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px">⚠ Требует внимания'+(allOk?' <span style="color:var(--success);font-weight:500;font-size:11px">· всё спокойно</span>':'')+'</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px">';
  h += _ncStatRow('📴 Модемов отключено >10м', disc, null, 'danger');
  h += _ncStatRow('🐌 Сбоят прокси', issues, null, 'warn');
  h += _ncStatRow('💸 Клиентов в долгу', debtors.length, debtors.length?_fmtRub(debtSum):null, 'danger');
  h += _ncStatRow('⏸ На паузе', paused, null, 'warn');
  h += '<div id="newReconChip"></div>';   // filled async by loadNewReconciliation
  h += '</div></div>';
  el.innerHTML = h;
}

// ── 4a. Парк по серверам — Трафик «.widget» style ──────────────────
function _ncServerCard(name, working, total, disc, primary){
  working = working||0; total = total||0; disc = disc||0;
  if(total<working) total=working;
  var col = disc===0 ? 'var(--success)' : 'var(--warning)';
  var sub = disc>0 ? '<span style="color:var(--danger)">⚠ '+disc+' отключено</span>' : 'все на связи';
  return '<div class="widget">' +
    '<div class="widget-label">'+esc(name)+'</div>' +
    '<div class="widget-value" style="color:'+col+'">'+working+'<span style="font-size:13px;color:var(--text-3)">/'+total+'</span></div>' +
    '<div class="widget-sub">'+sub+'</div>' +
    '</div>';
}
function renderNewFleetServers(){
  var el = document.getElementById('newFleetServers'); if(!el) return;
  var fleet = currentData.fleet || {};
  var bs = fleet.byServer || {};
  var names = Object.keys(bs).sort();
  if(!names.length){ el.innerHTML = '<div style="color:var(--text-3);font-size:12px">Нет данных о парке</div>'; return; }
  var mm = currentData._modemMap || {};
  var agg = {};
  Object.keys(mm).forEach(function(k){ var m=mm[k]; var srv=m.server; if(!agg[srv]) agg[srv]={sig:0,sigN:0,prob:0,off:0,today:0,mon:0};
    var st=getModemStatus(m);
    if(st==='offline') agg[srv].off++;
    if(typeof _modemIssue==='function' && _modemIssue(m)) agg[srv].prob++;
    var sig=Number(m.signal)||0; if(sig>0){ agg[srv].sig+=sig; agg[srv].sigN++; }
    (m.ports||[]).forEach(function(p){ var w=p._bw||{}; agg[srv].today+=parseTraffic(w.bandwidth_bytes_day_in)+parseTraffic(w.bandwidth_bytes_day_out); agg[srv].mon+=parseTraffic(w.bandwidth_bytes_month_in)+parseTraffic(w.bandwidth_bytes_month_out); });
  });
  function fcard(srv, primary){
    var b = primary ? {working:fleet.working,total:fleet.total,disconnected:fleet.disconnected} : (bs[srv]||{});
    var working=b.working||0, total=b.total||0, disc=b.disconnected||0; if(total<working) total=working;
    var onlPct = total ? Math.round(working/total*100) : 0;
    var ci = primary ? {} : (COUNTRIES[srv]||{});
    var name = primary ? _dwIcon('sat')+'Весь парк' : ((ci.flag||'')+' '+esc(srv)+(ci.name?' · '+esc(ci.name):''));
    var col = disc===0 ? 'var(--success)' : 'var(--warning)';
    var today=0,mon=0,prob=0,sigAvg=0;
    if(primary){ Object.keys(agg).forEach(function(s){ today+=agg[s].today; mon+=agg[s].mon; prob+=agg[s].prob; }); }
    else { var a=agg[srv]||{sig:0,sigN:0,prob:0,today:0,mon:0}; today=a.today; mon=a.mon; prob=a.prob; sigAvg=a.sigN?Math.round(a.sig/a.sigN):0; }
    var h='<div class="analytics-card" style="margin:0;padding:14px">';
    h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px"><span style="font-weight:700;font-size:13px;font-family:var(--font-mono)">'+name+'</span><span style="font-size:12px;font-weight:700;color:'+col+'">'+working+'/'+total+'</span></div>';
    h+='<div style="font-size:10px;color:var(--text-3);margin-bottom:6px">'+(disc>0?'<span style="color:var(--danger)">'+disc+' отключено</span>':'&nbsp;')+'</div>';
    h+='<div style="height:5px;background:var(--bg-3);border-radius:3px;overflow:hidden;margin-bottom:11px" title="'+onlPct+'% в работе"><div style="height:100%;width:'+onlPct+'%;background:'+col+';border-radius:3px"></div></div>';
    h+='<div style="display:flex;flex-direction:column;gap:4px;font-size:11px">';
    h+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-2)">Трафик сегодня</span><span style="font-family:var(--font-mono)">'+fmtGb(today)+'</span></div>';
    if(primary) h+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-2)">Трафик месяц</span><span style="font-family:var(--font-mono);font-weight:600">'+fmtGb(mon)+'</span></div>';
    if(!primary) h+='<div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text-2)">Сред. сигнал</span><span>'+(sigAvg?renderSignalBars(sigAvg):'<span style="color:var(--text-3)">—</span>')+'</span></div>';
    h+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-2)">Проблемных</span><span style="color:'+(prob>0?'var(--warning)':'var(--text-3)')+';font-weight:600">'+prob+'</span></div>';
    h+='</div></div>';
    return h;
  }
  var html = fcard(null, true);
  names.forEach(function(n){ html += fcard(n, false); });
  el.innerHTML = html;
}
function _zxLim(key,cap){return (window._zxOpen&&window._zxOpen[key])?Infinity:cap;}
function zMore(key){(window._zxOpen=window._zxOpen||{})[key]=1;
  if(key==='tp')renderNewTopProblems();
  else if(key==='sn')reloadNewInfra();
  else if(key==='mx')renderNewMatrix();
  else if(key==='api')loadNewApiAccess();
  else if(key==='hosts')loadNewTopHosts();}
function renderNewTopProblems(){
  var el=document.getElementById('newTopProblems'); if(!el) return;
  var mm=currentData._modemMap||{}, probs=[];
  Object.keys(mm).forEach(function(k){ var m=mm[k];
    var iss=(typeof _modemIssue==='function')?_modemIssue(m):null;
    var off=(typeof _offlineReason==='function')?_offlineReason(m):null;
    if(off&&off.stale) return;   // давно офлайн (> порога, деф. 12ч) — не «проблема», в топ не включаем
    var r=off||iss; if(r) probs.push({m:m,reason:r.reason,sev:r.sev||3,kind:r.kind});
  });
  probs.sort(function(a,b){return (b.sev||0)-(a.sev||0);});
  if(!probs.length){ el.innerHTML='<div style="color:var(--success);font-size:12px;padding:6px">✓ Проблемных модемов нет</div>'; return; }
  var show=probs.slice(0,_zxLim('tp',8));
  var h='<table class="ztbl"><thead><tr><th style="text-align:left">Модем</th><th style="text-align:left">Причина</th><th>Действия</th></tr></thead><tbody>';
  show.forEach(function(p){ var m=p.m; var col=(typeof _mkColor!=='undefined'&&_mkColor[p.kind])||'var(--warning)'; var ci=COUNTRIES[m.server]||{}; var d='data-imei="'+(m.rawImei||'')+'" data-server="'+m.server+'" data-nick="'+esc(m.nick)+'"';
    var open='if(event.target.closest(\'button\'))return;openDetailAtTab(\''+esc(m.nick).replace(/'/g,"\\'")+'\',\''+m.server+'\',\'health\')';
    h+='<tr onclick="'+open+'" style="cursor:pointer" title="Открыть детали модема — где именно проблема"><td style="text-align:left"><span style="width:3px;height:18px;background:'+col+';border-radius:2px;display:inline-block;vertical-align:middle;margin-right:8px"></span><strong>'+esc(m.nick)+'</strong> <span style="font-size:10px;color:var(--text-3)">'+(ci.flag||'')+' '+m.server+(ci.name?' · '+esc(ci.name):'')+'</span></td><td style="text-align:left;color:'+col+'">'+esc(p.reason)+'</td><td style="text-align:right"><button class="row-act" '+d+' title="Перезагрузка" onclick="rebootModem(this)">⏻</button> <button class="row-act" '+d+' title="Re-Add" onclick="readdModem(this)">⟳</button></td></tr>';
  });
  h+='</tbody></table>';
  if(probs.length>show.length) h+='<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:8px 14px" onclick="zMore(\'tp\')">+ ещё '+(probs.length-show.length)+'</div>';
  el.innerHTML=h;
}

// «Требует внимания» — одна карточка с плитками алертов (по макету):
// 4 инфра-плитки (кликабельные, открывают попап со списком) + 2 бизнес-плитки
// (долги с суммой, паузы). Тренд/Операторы живут в раскрывашке «Тренд и операторы».
function _dwIcon(n){var P={gear:'<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z"/>',line:'<path d="M4 17l5-5 4 3 7-8"/>',ant:'<circle cx="12" cy="13" r="1"/><path d="M12 14v6"/><path d="M8.5 9.5a5 5 0 0 1 7 0"/><path d="M6 6.5a8.5 8.5 0 0 1 12 0"/>',sat:'<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><circle cx="6.5" cy="7.5" r=".4"/><circle cx="6.5" cy="16.5" r=".4"/>'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="flex-shrink:0;vertical-align:-3px;color:var(--accent);margin-right:6px">'+(P[n]||'')+'</svg>';}
function _dwT(t,ic){return '<div style="font-size:13px;font-weight:700;color:var(--text-0);margin-bottom:10px">'+_dwIcon(ic)+t+'</div>';}
function renderNewExtWidgets(){
  var el=document.getElementById('newExtWidgets'); if(!el) return;
  var d=collectTrafficData(); if(!d){ el.innerHTML=''; return; }
  var mm=currentData._modemMap||{};
  function _age(ms){if(!ms)return'';var a=Date.now()-ms;if(a<60000)return'только что';var m=Math.floor(a/60000);if(m<60)return m+' мин назад';if(m<1440)return Math.floor(m/60)+' ч назад';return Math.floor(m/1440)+' д назад';}
  var STALE_MS=((window._staleModemHours||12))*3600*1000;
  var rtOffline=[],rtLowSpeed=[],rtStuckIp=[];
  Object.values(mm).forEach(function(m){
    var st=getModemStatus(m);
    if(st==='offline'){var stale=!m.lastSeenMs||(Date.now()-m.lastSeenMs>STALE_MS);if(!stale){var ag=_age(m.lastSeenMs);rtOffline.push({nick:m.nick,server:m.server,detail:ag?'Отключён '+ag:'offline',lastSeenMs:m.lastSeenMs||0});}}
    if(m.lowSpeed)rtLowSpeed.push({nick:m.nick,server:m.server,detail:'↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Mbps'});
    if(m.ipStuck)rtStuckIp.push({nick:m.nick,server:m.server,detail:'IP не менялся '+m.ipSinceHours+'ч · '+esc(m.extIp||'')});
  });
  var _offSrc=(currentData.fleet&&(currentData.fleet.disconnectedList||currentData.fleet.offlineList))||null;
  if(Array.isArray(_offSrc)){rtOffline=_offSrc.map(function(o){var ag=o.lastOnline?_age(o.lastOnline):'';return{nick:o.nick,server:o.server,detail:ag?('Отключён '+ag):'offline',lastSeenMs:o.lastOnline||0};});}
  rtOffline.sort(function(a,b){return (Number(b.lastSeenMs)||0)-(Number(a.lastSeenMs)||0);});
  var flakyItems=(currentData.proxyIssues||[]).map(function(it){return{nick:it.nick,server:it.server,detail:it.detail,_meta:it};});
  window._problemData={offline:rtOffline,speed:rtLowSpeed,ipstuck:rtStuckIp,flaky:flakyItems};
  function attTile(label,key,n,extra,dot){
    var bg=n===0?'var(--green-bg)':dot==='var(--danger)'?'var(--red-bg)':'var(--orange-bg)';
    var vc=n===0?'var(--success)':dot==='var(--danger)'?'var(--danger)':'var(--warning)';
    var click=(key&&n>0)?' onclick="showProblemPopup(\''+esc(label)+'\',\''+key+'\')"':'';
    return '<div class="att-tile" style="background:'+bg+(key&&n>0?';cursor:pointer':'')+'"'+click+'>'+
      '<span class="att-dot" style="background:'+(n===0?'var(--success)':dot)+'"></span>'+
      '<span class="att-label">'+label+(extra?'<span class="att-extra">'+extra+'</span>':'')+'</span>'+
      '<span class="att-count" style="color:'+vc+'">'+n+'</span></div>';
  }
  var probCard='<div class="analytics-card" style="margin:0">'+_dwT('Проблемы инфраструктуры','gear')+'<div class="att-grid" style="flex:1">'+
    attTile('Модем отключен','offline',rtOffline.length,null,'var(--danger)')+
    attTile('Низкая скорость','speed',rtLowSpeed.length,null,'var(--warning)')+
    attTile('Завис IP','ipstuck',rtStuckIp.length,null,'var(--warning)')+
    attTile('Сбоит прокси','flaky',flakyItems.length,null,'var(--danger)')+
    '</div></div>';
  // «Потребление трафика» — тот же каркас, что у MRR: заголовок + легенда +
  // Chart.js-канвас (ось объёма с сеткой, месяцы внизу).
  var trendCard='<div class="analytics-card" style="margin:0;display:flex;flex-direction:column">'
    +'<div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:8px">'
    +'<span style="font-size:12px;font-weight:600;color:var(--text-0);white-space:nowrap">'+_dwIcon('line')+'Потребление трафика</span>'
    +'<span id="trendLegendNew" style="display:flex;gap:8px;font-size:9px;font-weight:600;color:var(--text-2)"></span></div>'
    +'<div style="flex:1;min-height:120px;position:relative"><canvas id="newTrendCanvas"></canvas></div></div>';
  var allOps={};Object.keys(d.serverOpTraffic).forEach(function(s){Object.keys(d.serverOpTraffic[s]).forEach(function(op){if(!op)return;if(!allOps[op])allOps[op]={t:0,cnt:0};var v=d.serverOpTraffic[s][op];allOps[op].t+=v.tIn+v.tOut;allOps[op].cnt+=v.count;});});
  var opDays=getDaysElapsed();var opList=Object.keys(allOps).filter(function(op){var l=String(op).toLowerCase();return op&&l!=='неизвестный'&&l!=='unknown';}).sort(function(a,b){return allOps[b].t-allOps[a].t});var opMax=opList.length?(allOps[opList[0]].t/opDays)||1:1;
  // Ряд «Требует внимания» = grid со stretch: карточки одной высоты по самой
  // высокой. У «Тренда» контент flex:1 и тянется, а у «Проблем»/«Операторов»
  // высота была по содержимому — снизу оставалась пустота. Даём обеим
  // растущий контейнер (см. также .att-grid{grid-auto-rows:1fr}).
  var opCard='<div class="analytics-card" style="margin:0">'+_dwT('Операторы','ant')
    +'<div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;gap:4px">';
  var _opCosts=_opGbCosts();
  opList.forEach(function(op,oi){var v=allOps[op];var avgpmd=fmtGb(v.cnt&&opDays?v.t/v.cnt/opDays:0);var tpd=v.t/opDays;var w=Math.max(tpd/opMax*100,2);var col=CHART_COLORS.operators[oi%CHART_COLORS.operators.length];var _cst=_opCosts[op]?'<span style="color:var(--accent);font-weight:600"> · '+_opCosts[op]+'₽/ГБ</span>':'';opCard+='<div style="margin-bottom:0"><div style="display:flex;align-items:baseline;font-size:10px;margin-bottom:2px;gap:4px"><span style="flex:1;color:var(--text-1);font-weight:500">'+esc(op)+'</span><span style="color:var(--text-2)">'+avgpmd+'/мод/сут</span><span style="color:var(--text-3)">· '+v.cnt+' мод.</span>'+_cst+'</div><div style="height:4px;background:var(--bg-3);border-radius:2px"><div style="height:4px;border-radius:2px;background:'+col+';width:'+w+'%"></div></div></div>';});
  opCard+='</div></div>';
  // MRR (тренд + прогноз по финансам) — между «Потреблением трафика» и «Операторами».
  var _fd=window._newFinData, _fc=(_fd&&_fd.summary)?_fd.summary.forecast_eom:null;
  var mrrCard='<div class="analytics-card" style="margin:0;display:flex;flex-direction:column">'
    +'<div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:8px">'
    +'<span style="font-size:12px;font-weight:600;color:var(--text-0);white-space:nowrap">📈 MRR'+(_fc!=null?' <span style="font-size:9px;font-weight:400;color:var(--text-3)">прогноз '+_fmtRub(_fc)+'</span>':'')+'</span>'
    +'<span id="mrrLegend" style="display:flex;gap:8px;font-size:9px;font-weight:600;color:var(--text-2)"></span></div>'
    +'<div style="flex:1;min-height:120px;position:relative"><canvas id="newFinTrendCanvas"></canvas></div></div>';
  el.innerHTML=probCard+trendCard+mrrCard+opCard;
  loadTrendData('New');
  try{ renderMrrChart(window._newFinData); }catch(_){}
}

// «Тренд и операторы» — раскрывашка в Инфраструктуре (по макету).
// Рендерит только когда секция открыта; вызывается из renderAccNew (каждые 10с)
// и из onNewSectionToggle при открытии.

// ── 3. Финансы (pulse + quality + flow + trend) ────────────────────
var _newFinAt=0;
function loadNewFinance(force){
  // Финансы меняются медленно, а дашборд перерисовывается каждые 10с. Без троттла
  // блок финансов и график MRR пересоздавались (и перемигивали) каждые 10с —
  // обновляем максимум раз в ~60с, иначе оставляем как есть.
  if(!force && window._newFinData && (Date.now()-_newFinAt)<55000){
    // Свежо: НЕ фетчим и НЕ пересоздаём график MRR (он-то и мигал). Но финсводку
    // (#newFinSummaryBody) renderNewExtWidgets пересобирает каждые 10с — поэтому её
    // дешёвую перерисовку из кэша оставляем, иначе она пустеет между обновлениями.
    try{ renderNewPulse(window._newFinData); }catch(_){}
    return;
  }
  api(API + '/api/admin/finance_dashboard')
    .then(function(d){
      if(d.error){ var q=document.getElementById('newFinQuality'); if(q) q.innerHTML='<div style="color:var(--danger);font-size:12px">'+esc(d.error)+'</div>'; return; }
      window._newFinData = d;
      _newFinAt = Date.now();
      renderNewPulse(d);
      renderNewFinance(d);
      try{ var _td = collectTrafficData(); if(_td) renderNewClientTable(_td); }catch(_){}  // объединённая таблица клиентов: подтянуть доходность сразу
    })
    .catch(function(e){ var q=document.getElementById('newFinQuality'); if(q) q.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>'; });
}
function renderNewFinance(d){
  var s = d.summary||{}, con = d.concentration||{};
  // Quality panel
  var q = document.getElementById('newFinQuality');
  if(q){
    var nrrColor = s.nrr_pct==null?null:(s.nrr_pct>=100?'var(--success)':s.nrr_pct>=90?'var(--warning)':'var(--danger)');
    var churnColor = s.churn_rate_pct>=5?'var(--danger)':'var(--success)';
    function qtile(l,v,c){ return '<div class="kpi-tile"><div class="l">'+l+'</div><div class="v" style="font-size:16px'+(c?';color:'+c:'')+'">'+v+'</div></div>'; }
    function cbar(l,sub,pct,col){ pct=pct||0; return '<div style="margin-bottom:9px">'+
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11px;margin-bottom:3px">'+
        '<span style="color:var(--text-1);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">'+l+(sub?' <span style="font-weight:400;color:var(--text-3)">'+sub+'</span>':'')+'</span>'+
        '<span style="font-family:var(--font-mono);font-weight:600;color:var(--text-0)">'+pct+'%</span></div>'+
      '<div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+Math.min(pct,100)+'%;background:'+col+';border-radius:3px"></div></div></div>'; }
    var hq = '<h3 style="margin:0 0 10px;font-size:14px;font-weight:700;color:var(--text-0)">Качество выручки</h3>';
    hq += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
    hq += qtile('NRR · 3 мес', s.nrr_pct==null?'—':s.nrr_pct+'%', nrrColor);
    hq += qtile('Churn · мес', s.churn_rate_pct==null?'—':s.churn_rate_pct+'%', churnColor);
    hq += qtile('ARPU', _fmtRub(s.arpu), null);
    hq += qtile('Активных клиентов', String(s.active_clients||0), null);
    hq += '</div>';
    hq += '<div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:8px">Концентрация выручки</div>';
    hq += cbar('Top-1', con.top1_name?esc(con.top1_name):'', con.top1_pct, con.top1_pct>=50?'#ef4444':con.top1_pct>=35?'#f0a533':'var(--accent)');
    hq += cbar('Top-3', '', con.top3_pct, 'var(--accent)');
    hq += cbar('Top-5', '', con.top5_pct, '#10b981');
    q.innerHTML = hq;
  }
  // Flow: new / churned / debtors
  var flow = document.getElementById('newFinFlow');
  if(flow){
    var clients = currentData.clients||[];
    var debtors = clients.filter(function(c){return (c.balance||0)<-10;}).sort(function(a,b){return (a.balance||0)-(b.balance||0);}).slice(0,6);
    function panel(title, color, countLabel, rowsHtml, empty){
      return '<div class="analytics-card" style="margin:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px">'+title+'</div>' +
        '<div style="font-size:24px;font-weight:700;color:'+color+';margin-bottom:10px">'+countLabel+'</div>' +
        (rowsHtml || ('<div style="font-size:11px;color:var(--text-3)">'+empty+'</div>')) + '</div>';
    }
    var nw = (d.new||[]);
    var nwRows = nw.slice(0,6).map(function(x){ return _ncListRow(esc(x.name), _fmtRub(x.mrr), 'var(--success)'); }).join('');
    var ch = (d.churned||[]);
    var chRows = ch.slice(0,6).map(function(x){ return _ncListRow(esc(x.name), _fmtRub(x.last_mrr), 'var(--text-2)'); }).join('');
    var dbRows = debtors.map(function(c){ return _ncListRow(esc(c.name), _fmtRub(c.balance), 'var(--danger)'); }).join('');
    flow.innerHTML =
      panel('➕ Новые клиенты', 'var(--success)', '+'+nw.length, nwRows, 'нет новых в этом месяце') +
      panel('➖ Ушли (churned)', ch.length?'var(--danger)':'var(--success)', String(ch.length), chRows, '✓ никто не ушёл') +
      panel('💸 Должники', debtors.length?'var(--danger)':'var(--success)', String(debtors.length), dbRows, '✓ все в плюсе');
  }
  // MRR перенесён в ряд «Требует внимания» (renderMrrChart), а в блоке Финансов
  // на его месте — «Выручка по дням» + «Последние платежи» (renderFinRevenue).
  renderFinRevenue(d);
  renderMrrChart(d);
}
// MRR-график (тренд «За ГБ»/«За модем» + прогноз) — живёт в ряду «Требует внимания».
// Вызывается и из renderNewFinance (когда пришли данные), и из renderNewExtWidgets
// (ряд перестраивается каждые 10с, канвас пересоздаётся — перерисовываем из кэша).
function renderNewFinClients(){
  var el = document.getElementById('newFinClients'); if(!el) return;
  var d = window._newFinData;
  if(!d){ el.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:8px">Финансовые данные ещё загружаются…</div>'; return; }
  var rows = (d.per_client||[]).filter(function(p){return !(p.mrr===0 && p.mrr_prev===0 && !p.balance);});
  if(!rows.length){ el.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:8px">Нет данных</div>'; return; }
  var h = '<table class="ztbl"><thead><tr><th>Клиент</th><th style="text-align:left">Тариф</th><th>MRR</th><th>Δ M/M</th><th>% MRR</th><th>Баланс</th></tr></thead><tbody>';
  rows.forEach(function(p){
    var pausedTag = p.paused?' <span style="font-size:9px;background:var(--warning);color:#fff;padding:1px 5px;border-radius:8px">пауза</span>':'';
    var deltaCol = p.mrr_delta_pct==null?'var(--text-3)':p.mrr_delta_pct>=0?'var(--success)':'var(--danger)';
    var deltaStr = p.mrr_delta_pct==null?'—':((p.mrr_delta_pct>0?'+':'')+p.mrr_delta_pct+'%');
    var tariffStr = p.billingType==='per_modem'?(p.price+'₽/мес·мод'):(p.price+'₽/ГБ');
    var balCol = p.balance<0?'var(--danger)':'var(--text-1)';
    h += '<tr>' +
      '<td style="font-weight:500;color:var(--text-1)">'+esc(p.name)+pausedTag+'</td>' +
      '<td style="text-align:left;color:var(--text-2)">'+tariffStr+'</td>' +
      '<td style="font-weight:600;color:var(--text-1)">'+_fmtRub(p.mrr)+'</td>' +
      '<td style="color:'+deltaCol+'">'+deltaStr+'</td>' +
      '<td style="color:var(--text-1)">'+(p.share_pct!=null?p.share_pct+'%':'—')+'</td>' +
      '<td style="color:'+balCol+'">'+_fmtRub(p.balance)+'</td></tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

// ── 4b. Здоровье парка (modem_health) ──────────────────────────────
function loadNewFleetHealth(){
  api(API + '/api/analytics/modem_health?days=7')
    .then(function(d){ if(d.error){ var el=document.getElementById('newFleetHealth'); if(el) el.innerHTML='<div style="color:var(--danger);font-size:12px">'+esc(d.error)+'</div>'; return; } renderNewFleetHealth(d); })
    .catch(function(e){ var el=document.getElementById('newFleetHealth'); if(el) el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>'; });
}
function _ncHealthReason(m){
  if(m.error_pct!=null && m.error_pct>10) return 'много ошибок ('+m.error_pct+'%)';
  if(m.uptime_pct!=null && m.uptime_pct<90) return 'низкий аптайм ('+m.uptime_pct+'%)';
  if(m.latency_ms!=null && m.latency_ms>2000) return 'медленный ('+fmtMs(m.latency_ms)+')';
  if(m.error_pct!=null && m.error_pct>3) return 'ошибки ('+m.error_pct+'%)';
  return 'низкий скоринг';
}
function renderNewFleetHealth(d){
  var el = document.getElementById('newFleetHealth'); if(!el) return;
  var s = d.summary||{};
  var total = s.total||0, good=s.good||0, warn=s.warn||0, bad=s.bad||0;
  var denom = total||1;
  var h = '<div style="display:flex;gap:14px;margin-bottom:10px">' +
    '<span style="font-size:12px"><b style="color:var(--success);font-size:16px">'+good+'</b> здоровых</span>' +
    '<span style="font-size:12px"><b style="color:var(--warning);font-size:16px">'+warn+'</b> внимание</span>' +
    '<span style="font-size:12px"><b style="color:var(--danger);font-size:16px">'+bad+'</b> проблемных</span></div>';
  h += '<div style="display:flex;height:10px;border-radius:999px;overflow:hidden;margin-bottom:12px;background:var(--bg-3)">';
  if(good) h += '<div style="width:'+(good/denom*100)+'%;background:var(--success)"></div>';
  if(warn) h += '<div style="width:'+(warn/denom*100)+'%;background:var(--warning)"></div>';
  if(bad) h += '<div style="width:'+(bad/denom*100)+'%;background:var(--danger)"></div>';
  h += '</div>';
  var worst = (d.modems||[]).slice().filter(function(m){return m.status!=='good';}).sort(function(a,b){return a.health_score-b.health_score;}).slice(0,6);
  if(worst.length){
    h += '<div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Худшие модемы — что чинить</div>';
    h += '<table class="ztbl"><tbody>';
    worst.forEach(function(m){
      var col = m.status==='warn'?'var(--warning)':'var(--danger)';
      h += '<tr>' +
        '<td style="text-align:left;font-weight:600">'+esc(m.nick)+'</td>' +
        '<td style="text-align:left;color:var(--text-2)">'+esc(m.server_name||'')+'</td>' +
        '<td style="text-align:left;color:var(--text-2)">'+esc(_ncHealthReason(m))+'</td>' +
        '<td>'+(m.uptime_pct!=null?m.uptime_pct+'%':'—')+'</td>' +
        '<td>'+fmtMs(m.latency_ms)+'</td>' +
        '<td style="text-align:center"><span style="display:inline-block;padding:2px 8px;border-radius:10px;background:'+col+';color:#fff;font-weight:700">'+m.health_score+'</span></td>' +
        '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--success);font-size:12px;padding:6px">✓ Все модемы здоровы</div>';
  }
  el.innerHTML = h;
}

// ── 3c. Сверка биллинга (reconciliation) ───────────────────────────
function loadNewReconciliation(){
  if(window._newReconLoaded) return;     // once per render (eager + lazy share this)
  window._newReconLoaded = true;
  var el = document.getElementById('newReconBody');
  api(API + '/api/admin/billing/reconciliation')
    .then(function(d){
      var clients = d.clients||[];
      var probs = clients.filter(function(c){return c.status && c.status!=='ok';});
      var chip = document.getElementById('newReconChip');
      if(chip) chip.innerHTML = _ncStatRow('🧾 Расхождений биллинга', probs.length, null, 'warn');
      if(!el) return;
      if(!probs.length){ el.innerHTML='<div style="color:var(--success);font-size:12px;padding:8px">✓ Расхождений нет — весь отданный трафик выставлен в счёт ('+clients.length+' клиентов проверено)</div>'; return; }
      var label = {mismatch:'расхождение по ГБ', missing_billing:'не выставлен счёт', missing_traffic:'счёт без трафика'};
      var hh = '<table class="ztbl"><thead><tr><th style="text-align:left">Клиент</th><th style="text-align:left">Тариф</th><th style="text-align:left">Проблема</th><th style="padding:6px 8px;text-align:right">Дней без счёта</th></tr></thead><tbody>';
      probs.forEach(function(c){
        var col = c.status==='missing_billing'?'var(--danger)':'var(--warning)';
        hh += '<tr>' +
          '<td style="text-align:left;font-weight:600">'+esc(c.client_name)+'</td>' +
          '<td style="text-align:left;color:var(--text-2)">'+esc(c.billing_type||'')+'</td>' +
          '<td style="text-align:left;color:'+col+'">'+esc(label[c.status]||c.status)+'</td>' +
          '<td style="text-align:left;text-align:right">'+((c.missing_days&&c.missing_days.length)||0)+'</td></tr>';
      });
      hh += '</tbody></table>';
      el.innerHTML = hh;
    })
    .catch(function(e){ window._newReconLoaded=false; if(el) el.innerHTML='<div style="color:var(--danger);font-size:12px;padding:8px">Ошибка: '+esc(e.message)+'</div>'; });
}

// ── Clients table (with revenue + balance columns merged) ─────────
// Объединённая таблица: «Клиенты-трафик» + «Клиенты по доходности» в одну.
// Сегодня/Вчера по трафику + Тариф/MRR/Δ/доля/Баланс. Всё центрировано, равные отступы.
function renderNewClientTable(d){
  var el = document.getElementById('newClientTable');
  if(!el) return;
  var clients = currentData.clients || [];
  var nameByPort = {}; clients.forEach(function(c){ if(c.portName) nameByPort[c.portName] = c.name; });
  var finList = (window._newFinData && window._newFinData.per_client) || [];
  var finByName = {}; finList.forEach(function(p){ finByName[p.name] = p; });
  var byName = {};
  function ensure(nm){ if(!byName[nm]) byName[nm] = {name:nm, today:0, yest:0, online:0, modems:0}; return byName[nm]; }
  (d.modemTraffic||[]).forEach(function(m){ var nm = nameByPort[m.pn] || m.pn; if(!nm) return; var r = ensure(nm); r.today += (m.dayIn||0)+(m.dayOut||0); r.yest += (m.yestIn||0)+(m.yestOut||0); });
  Object.keys(d.clientTraffic||{}).forEach(function(pn){ var ct = d.clientTraffic[pn]; if(!(ct.modems>0)) return; var nm = nameByPort[pn] || pn; var r = ensure(nm); r.online += ct.online||0; r.modems += ct.modems||0; });
  finList.forEach(function(p){ ensure(p.name); });
  var rows = Object.keys(byName).map(function(nm){
    var r = byName[nm], fin = finByName[nm] || {}, cl = clients.find(function(c){return c.name===nm;}) || {};
    return { name:nm, today:r.today, yest:r.yest, online:r.online, modems:r.modems,
      billingType:fin.billingType, price:fin.price, mrr:fin.mrr, delta:fin.mrr_delta_pct, share:fin.share_pct,
      balance: fin.balance!=null?fin.balance:(cl.balance||0), paused:fin.paused };
  }).filter(function(r){ return r.modems>0; });   // только активные (с модемами); неактивных на дашборде не показываем
  if(!rows.length){ el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3);font-size:12px">Нет данных</div>'; return; }
  rows.sort(function(a,b){ return (b.mrr||0)-(a.mrr||0) || (b.today-a.today); });
  var th = function(t,left){ return '<th'+(left?' style="text-align:left"':'')+'>'+t+'</th>'; };
  var h = '<table class="ztbl">';
  h += '<thead><tr>'+th('Клиент',1)+th('Live')+th('Сегодня')+th('Тариф')+th('MRR')+th('Δ M/M')+th('% MRR')+th('Баланс')+'</tr></thead><tbody>';
  rows.forEach(function(r,i){
    var col = CHART_COLORS.clients[i % CHART_COLORS.clients.length];
    var liveColor = r.modems===0 ? 'var(--text-3)' : (r.online===r.modems ? 'var(--success)' : (r.online>0 ? 'var(--warning)' : 'var(--danger)'));
    var tariff = r.billingType==='per_modem' ? (r.price+'₽/мод') : (r.price!=null ? r.price+'₽/ГБ' : '—');
    var deltaCol = r.delta==null ? 'var(--text-3)' : (r.delta>=0 ? 'var(--success)' : 'var(--danger)');
    var deltaStr = r.delta==null ? '—' : ((r.delta>0?'+':'')+r.delta+'%');
    var balCol = r.balance<0 ? 'var(--danger)' : (r.balance>0 ? 'var(--text-0)' : 'var(--text-3)');
    var paused = r.paused ? ' <span style="font-size:9px;background:var(--warning);color:#fff;padding:1px 5px;border-radius:8px">пауза</span>' : '';
    var td = function(content,left){ return '<td'+(left?' style="text-align:left"':'')+'>'+content+'</td>'; };
    h += '<tr>';
    h += td('<span style="display:inline-flex;align-items:center;gap:7px"><span style="width:3px;height:16px;background:'+col+';border-radius:2px"></span><strong style="color:var(--text-0)">'+esc(r.name)+'</strong>'+paused+'</span>',1);
    h += td('<span style="font-weight:600;color:'+liveColor+'">'+r.online+'/'+r.modems+'</span>');
    h += td('<span style="font-family:var(--font-mono)">'+fmtGb(r.today)+'</span>');
    h += td('<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;'+(r.billingType==='per_gb'?'background:var(--accent-dim);color:var(--accent)':'background:var(--bg-2);color:var(--text-2)')+'">'+tariff+'</span>');
    h += td('<span style="font-family:var(--font-mono);font-weight:600">'+(r.mrr!=null?_fmtRub(r.mrr):'—')+'</span>');
    h += td('<span style="color:'+deltaCol+'">'+deltaStr+'</span>');
    h += td(r.share!=null ? r.share+'%' : '—');
    h += td('<span style="font-family:var(--font-mono);font-weight:'+(r.balance<0?'600':'400')+';color:'+balCol+'">'+_fmtRub(r.balance)+'</span>');
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

// (renderNewFinPanel removed — superseded by renderNewFinance / renderNewFinClients,
//  which use the full /api/admin/finance_dashboard payload instead of the
//  in-memory clientMonthCharges snapshot.)

// ── Heatmap (parallel to loadHeatmapData, writes to new IDs) ────
// NEW «Командный центр» — почасовой трафик переиспользует движок «Трафика»
// через контекст _hmNew (тот же renderHeatmap/субтабы/тултип) → 1:1 со страницей.
function setNewHmView(view){ setHeatmapView(view, _hmNew); _dashUiSave({hmView:_newHmView,hmId:_newHmId}); }
function renderNewHmSubTabs(){ renderHeatmapSubTabs(_hmNew); }
function selectNewHmId(id){ selectHeatId(id, _hmNew); }
var _newHmAt = 0;
function loadNewHeatmap(force){
  // Дашборд перерисовывается каждые 10с, а почасовая карта меняется максимум раз
  // в 5 мин (TTL эндпоинта). Без троттла перерисовка каждые 10с = мигание.
  // Освежаем текущий срез максимум раз в ~55с. Смена вида/под-вкладки идёт по
  // СВОЕМУ ключу кэша (его ещё нет) — поэтому срабатывает сразу, без задержки.
  var k = (_hmNew.view||'') + '|' + (_hmNew.id||'');
  if(!force && _newHmCache[k] && (Date.now()-_newHmAt) < 55000) return;
  try{ delete _newHmCache[k]; }catch(_){}
  _newHmAt = Date.now();
  renderHeatmapSubTabs(_hmNew);
  loadHeatmapData(_hmNew);
}
function renderNewHeatmap(data){ renderHeatmap(data, _hmNew); }

// ── Daily chart ────────────────────────────────────────────────────
function loadNewDailyChart(){
  if(window._dailyTrafficCache){ renderNewDailyChart(window._dailyTrafficCache); return; }
  api(API+'/api/admin/daily_traffic')
    .then(function(d){if(d&&d.__status>=400) throw new Error('HTTP '+d.__status); return d;})
    .then(function(d){ window._dailyTrafficCache = d; renderNewDailyChart(d); })
    .catch(function(e){
      var canvas = document.getElementById('newDailyCanvas');
      if(canvas) canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>';
    });
}
var _newDailyMode=_dashUi.dailyMode||'clients';
// Скрытые в графике «Потребление по дням» ряды — только в памяти сессии (НЕ localStorage):
// переживают авто-рефреш дашборда (каждые 10с re-render), сбрасываются при ручной
// перезагрузке страницы или повторном клике по легенде. Ключ = подпись ряда.
var _dailyHidden={};
function setNewDailyMode(m){
  _newDailyMode=m;_dashUiSave({dailyMode:m});
  ['clients','countries'].forEach(function(x){var b=document.getElementById('newDailyMode_'+x);if(b)b.classList.toggle('active',x===m);});
  if(window._dailyTrafficCache) renderNewDailyChart(window._dailyTrafficCache);
}
function renderNewDailyChart(data){
  var canvas = document.getElementById('newDailyCanvas');
  if(!canvas || !data) return;
  var ctx = canvas.getContext('2d');
  if(_newDailyChart){ _newDailyChart.destroy(); _newDailyChart = null; }
  var cc = getChartColorsLight();
  // 60-day window
  var now = new Date(), dates = [];
  for(var i = 59; i >= 0; i--){ var dd = new Date(now.getTime() - i*86400000); dates.push(dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0')+'-'+String(dd.getDate()).padStart(2,'0')); }
  var labels = dates.map(function(d){ return d.slice(8,10)+'.'+d.slice(5,7); });
  // map client(portName) → dominant country (for «По странам»)
  var clientCountry = {};
  if(_newDailyMode === 'countries'){
    var cnt = {}, mm = currentData._modemMap || {};
    Object.keys(mm).forEach(function(k){ var m=mm[k]; var ci=COUNTRIES[m.server]||{}; var country=ci.name||m.server; (m.ports||[]).forEach(function(p){ var pn=p.portName; if(!pn)return; if(!cnt[pn])cnt[pn]={}; cnt[pn][country]=(cnt[pn][country]||0)+1; }); });
    Object.keys(cnt).forEach(function(pn){ var best='',bc=-1; Object.keys(cnt[pn]).forEach(function(c){ if(cnt[pn][c]>bc){bc=cnt[pn][c];best=c;} }); clientCountry[pn]=best; });
  }
  // Клиенты «без портов» не должны фигурировать на дашборде: в data приходят и
  // исторические portName, чьих портов уже нет в парке. Оставляем только тех, у кого
  // СЕЙЧАС есть хотя бы один порт (по live-модемам + суточному ростеру клиентов).
  // fail-open: если множество пусто (данные ещё не подъехали) — не фильтруем.
  var _validClients = {};
  var _mmv = currentData._modemMap || {};
  Object.keys(_mmv).forEach(function(k){ (_mmv[k].ports||[]).forEach(function(p){ if(p.portName) _validClients[p.portName]=1; }); });
  (currentData.clients||[]).forEach(function(c){ if(c.portName && c.modemCount>0) _validClients[c.portName]=1; });
  var _hasValid = Object.keys(_validClients).length>0;
  // groupKey → {date: bytes}
  var groups = {};
  Object.keys(data).forEach(function(client){
    if(typeof data[client] !== 'object') return;
    if(client === 'Не назначен') return;   // трафик незакреплённых за клиентом модемов — не показываем
    if(_hasValid && !_validClients[client]) return;   // клиент без портов — скрываем везде на дашборде
    if(_newDailyMode === 'countries'){
      // АВТОРИТЕТНАЯ разбивка: каждый день несёт data[client][date].servers — берём
      // трафик по странам прямо оттуда. Раньше бралась «доминантная страна на клиента»,
      // из-за чего румынский трафик уезжал в Молдову, а несопоставленное — в «Прочее».
      Object.keys(data[client]).forEach(function(date){
        var e = data[client][date]; if(!e) return;
        var srvs = e.servers;
        if(srvs && Object.keys(srvs).length){
          Object.keys(srvs).forEach(function(srv){
            var ci = COUNTRIES[srv] || {}; var country = ci.name || srv;
            if(!groups[country]) groups[country] = {};
            groups[country][date] = (groups[country][date]||0) + (srvs[srv].in||0) + (srvs[srv].out||0);
          });
        } else {
          var fb = clientCountry[client];   // запасной вариант, если у дня нет разбивки
          if(fb){ if(!groups[fb]) groups[fb]={}; groups[fb][date]=(groups[fb][date]||0)+((e.in||0)+(e.out||0)); }
        }
      });
    } else {
      if(!groups[client]) groups[client] = {};
      Object.keys(data[client]).forEach(function(date){ var e=data[client][date]; groups[client][date]=(groups[client][date]||0)+((e.in||0)+(e.out||0)); });
    }
  });
  var keys = Object.keys(groups).sort(function(a,b){ var sa=dates.reduce(function(s,d){return s+(groups[a][d]||0)},0), sb=dates.reduce(function(s,d){return s+(groups[b][d]||0)},0); return sb-sa; });
  var MAXG = _newDailyMode==='countries' ? 8 : 12;
  var top = keys.slice(0,MAXG), rest = keys.slice(MAXG);
  var palette = getChartPaletteLight();
  var datasets = top.map(function(key,i){ return Object.assign({ label:key, hidden:!!_dailyHidden[key], data:dates.map(function(d){ return (groups[key][d]||0)/1e9; }), backgroundColor:palette[i%palette.length], stack:'s', borderRadius:chartStackRadius() }, CHART_BAR_STACK); });
  if(rest.length){ datasets.push(Object.assign({ label:'Прочие', hidden:!!_dailyHidden['Прочие'], data:dates.map(function(d){ return rest.reduce(function(s,k){return s+(groups[k][d]||0)},0)/1e9; }), backgroundColor:'#cbd5e1', stack:'s', borderRadius:chartStackRadius() }, CHART_BAR_STACK)); }
  _newDailyChart = newChartSafe(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: cc.text, font: { size: 10.5 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 6, boxHeight: 6, padding: 12 },
          // Клик по клиенту в легенде запоминаем в _dailyHidden, чтобы авто-рефреш
          // (re-render каждые 10с) не возвращал скрытый ряд обратно.
          onClick: function(e, legendItem, legend){
            var ci = legend.chart, index = legendItem.datasetIndex;
            var label = ci.data.datasets[index] ? ci.data.datasets[index].label : legendItem.text;
            if(ci.isDatasetVisible(index)){ ci.hide(index); legendItem.hidden = true; _dailyHidden[label] = true; }
            else { ci.show(index); legendItem.hidden = false; delete _dailyHidden[label]; }
          } },
        tooltip: { mode: 'index', intersect: false, itemSort: function(a,b){ return b.parsed.y - a.parsed.y; },
          callbacks: {
            label: function(c){ return c.dataset.label+': '+c.parsed.y.toFixed(2)+' ГБ'; },
            footer: function(items){ var t=0; items.forEach(function(i){ t+=i.parsed.y; }); return 'Итого: '+t.toFixed(2)+' ГБ'; }
          } }
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 9 }, color: cc.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 20 }, grid: { display: false }, border: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 }, color: cc.text, callback: function(v){ return v+' ГБ'; } }, grid: { color: cc.grid, drawTicks: false }, border: { display: false } }
      }
    }
  });
}

// ── Latency (collapsible) — по макету: без чипов стран, всегда весь парк ──
function loadNewLatency(){
  var url = API + '/api/analytics/latency_stats?view=country&id=all&days=30';
  api(url)
    .then(function(d){ if(d&&d.__status>=400) throw new Error('HTTP '+d.__status); return d; })
    .then(function(d){ _newLatencyData = d; renderLatencySummary(d); })
    .catch(function(e){
      var c = document.getElementById('latencySummary');
      if(c) c.innerHTML = '<div style="padding:30px;color:var(--danger);font-size:12px;text-align:center">Ошибка: '+esc(e.message)+'</div>';
    });
}
function renderNewLatencyChart(data){
  if(!data || !data.days) return;
  var canvas = document.getElementById('newLatencyCanvas');
  if(!canvas) return;
  if(_newLatencyChart){ _newLatencyChart.destroy(); _newLatencyChart = null; }
  var ctx = canvas.getContext('2d');
  var cc = getChartColors();
  var labels = data.days.map(function(d){ return d.slice(8,10) + '.' + d.slice(5,7); });
  _newLatencyChart = newChartSafe(ctx, {
    type: 'line',
    data: { labels: labels, datasets: [
      { label: 'P50', data: data.median_ms, borderColor: 'var(--accent)', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2 },
      { label: 'P95', data: data.p95_ms, borderColor: '#EF9F27', fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2, borderDash: [4,3] },
      { label: 'P95 connect', data: data.connect_p95_ms||[], borderColor: '#7c3aed', fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2, borderDash: [2,3] }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: function(ctx){ return ctx.dataset.label + ': ' + fmtMs(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { font: { size: 10 }, color: '#9b9b98', maxRotation: 0, autoSkip: true }, grid: { color: cc.gridLine, drawTicks: false }, border: { display: false } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, color: '#6b6b68', callback: function(v){ return (v/1000).toFixed(v<1000?2:1) + ' с'; } }, grid: { color: cc.gridLine, drawTicks: false }, border: { display: false } }
      }
    }
  });
}

// ── «Ротации · IP · ёмкость» (по макету): hero-KPI ряд + 4 таблицы ──
// (по серверам · по операторам · топ-модемы · подсети на модем), период 7д.
// Один Promise.all на оба эндпоинта — KPI и таблицы из одного ответа.
var _NEW_INFRA_DAYS = _dashUi.infraDays || 7;
function setNewInfraDays(d,el){_NEW_INFRA_DAYS=d;_dashUiSave({infraDays:d});if(el&&el.parentNode){Array.prototype.forEach.call(el.parentNode.children,function(c){if(c.classList)c.classList.remove('on')});el.classList.add('on');}reloadNewInfra();}
function reloadNewInfra(){
  var kpiEl = document.getElementById('newInfraKpis');
  var tblEl = document.getElementById('newInfraTables');
  if(!kpiEl && !tblEl) return;
  var days = _NEW_INFRA_DAYS;
  Promise.all([
    api(API+'/api/analytics/rotations?days='+days).catch(function(){return {};}),
    api(API+'/api/analytics/ip_stats?days='+days).catch(function(){return {};}),
    api(API+'/api/analytics/capacity?days='+days).catch(function(){return {};})
  ]).then(function(res){
    var rot=res[0]||{}, ip=res[1]||{}, cap=(res[2]||{}).summary||{};
    var rs=rot.summary||{}, ips=ip.summary||{}, sn=ip.subnet_summary||{};
    if(kpiEl){
      var okCol = rs.success_pct==null?null : rs.success_pct>=95?'var(--success)' : rs.success_pct>=80?'var(--warning)' : 'var(--danger)';
      var kt=function(l,v,s,c){ return '<div class="kpi-tile"><div class="l">'+l+'</div><div class="v"'+(c?' style="color:'+c+'"':'')+'>'+v+'</div>'+(s?'<div class="s">'+s+'</div>':'')+'</div>'; };
      kpiEl.innerHTML = '<div class="kpi-row">'
        + kt('Ротаций ('+days+'д)', (rs.total||0).toLocaleString('ru-RU'), null, null)
        + kt('Успешность', rs.success_pct!=null?rs.success_pct+'%':'—', null, okCol)
        + kt('Уникальных IP', (ips.unique_ips||0).toLocaleString('ru-RU'), null, null)
        + kt('Подсетей/модем', (sn.avg!=null?sn.avg:'—'), '/24 · макс '+(sn.max||0), 'var(--accent)')
        + '</div>';
    }
    if(!tblEl) return;
    function h4(t,col){ return '<div style="font-size:11px;font-weight:700;color:'+col+';margin:14px 0 6px">'+t+'</div>'; }
    function tbl(head, rows){
      if(!rows) return '<div style="color:var(--text-3);font-size:11px;padding:6px">Нет данных</div>';
      return '<div style="overflow-x:auto"><table class="ztbl"><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
    }
    function th(t,left){ return '<th'+(left?' style="text-align:left"':'')+'>'+t+'</th>'; }
    function td(v,left,style){ var st=(left?'text-align:left;':'')+(style||''); return '<td'+(st?' style="'+st+'"':'')+'>'+v+'</td>'; }
    function _more(n,cap,key){ return n>cap?'<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:6px 2px 0" onclick="zMore(\''+key+'\')">+ ещё '+(n-cap)+'</div>':''; }
    var srvRows=(rot.per_server||[]).map(function(sv){ var fc=!sv.failed?'color:var(--text-3)':(sv.failed>25?'color:var(--danger)':'color:var(--warning)'); return '<tr>'+td('<b>'+esc(sv.server_name||'—')+'</b>',1)+td((sv.total||0).toLocaleString('ru-RU'))+td(sv.failed||0,0,fc)+td(sv.avg_sec!=null?Math.round(sv.avg_sec*10)/10:'—',0,'font-weight:600')+'</tr>'; }).join('');
    var srvT=h4('Ротации по серверам','#3b9dd8')+tbl(th('Сервер',1)+th('Всего')+th('Failed')+th('Avg с'), srvRows);
    var snAll=(ip.subnets||[]);
    var snLim=_zxLim('sn',8);var snRows=snAll.slice(0,snLim).map(function(x){ return '<tr>'+td('<b>'+esc(x.nick)+'</b>',1)+td(esc(x.server),1,'color:var(--text-2)')+td('<b style="color:var(--accent)">'+x.subnets+'</b>')+td(x.ips)+'</tr>'; }).join('');
    var snT=h4('Подсети на модем (/24)','#965ac8')+tbl(th('Модем',1)+th('Сервер',1)+th('Подсетей')+th('Уник. IP'), snRows)+_more(snAll.length,snLim,'sn');
    var ktc=function(l,v){ return '<div class="kpi-tile" style="text-align:center"><div class="l">'+l+'</div><div class="v">'+v+'</div></div>'; };
    var capH=h4('Ёмкость','#ef9f27')
      +'<div class="kpi-row" style="margin-bottom:0">'
      + ktc('Модемов', cap.total_modems!=null?cap.total_modems:'—')
      + ktc('Серверов', cap.total_servers!=null?cap.total_servers:'—')
      + ktc('Трафик ('+days+'д)', cap.total_gb!=null?fmtGb(cap.total_gb*1e9):'—')
      + ktc('Avg/модем', cap.avg_gb_per_modem!=null?fmtGb(cap.avg_gb_per_modem*1e9):'—')
      +'</div>';
    tblEl.innerHTML=srvT+snT+capH;
  });
}

// ── Top hosts (collapsible, предзагружается при рендере дашборда) ──
var _hostsClient = _dashUi.hostsClient || '';  // '' = все клиенты
var _hostsClientList = null;  // кэш списка клиентов для чипов (по хитам, из нефильтрованного ответа)
function setHostsClient(c){
  _hostsClient = (_hostsClient === c ? '' : c);
  _dashUiSave({hostsClient:_hostsClient});
  if(window._zxOpen) delete window._zxOpen.hosts;
  loadNewTopHosts();
}
function _renderHostChips(){
  var el = document.getElementById('newResChips');
  if(!el || !_hostsClientList) return;
  var h = '<button class="dchip'+(!_hostsClient?' on':'')+'" onclick="setHostsClient(\'\')">Все клиенты</button>';
  _hostsClientList.forEach(function(c){
    h += '<button class="dchip'+(_hostsClient===c?' on':'')+'" data-c="'+esc(c)+'" onclick="setHostsClient(this.dataset.c)">'+esc(c)+'</button>';
  });
  el.innerHTML = h;
}
function loadNewTopHosts(){
  var statusEl = document.getElementById('newResStatus');
  var listEl = document.getElementById('newTopHostsList');
  if(statusEl) statusEl.textContent = 'Загрузка...';
  var url = API+'/api/analytics/logs_domains_full?limit=1'+(_hostsClient ? '&client='+encodeURIComponent(_hostsClient) : '');
  api(url)
    .then(function(d){
      if(!_hostsClient && d.by_client){
        _hostsClientList = d.by_client.filter(function(c){ return c.client_name; }).map(function(c){ return c.client_name; });
      } else if(!_hostsClientList && d.facets && d.facets.clients){
        _hostsClientList = d.facets.clients;
      }
      _renderHostChips();
      var hosts = (d.top_hosts || []).slice(0, 50);
      if(!hosts.length){
        if(listEl) listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:11px">Нет данных</div>';
        if(statusEl) statusEl.textContent = '0 хостов';
        return;
      }
      var maxHits = hosts[0].hits || 1;
      function shortN(n){ return n>=1e6 ? (n/1e6).toFixed(1).replace(/\.0$/,'')+'M' : n>=1e3 ? (n/1e3).toFixed(1).replace(/\.0$/,'')+'k' : String(n); }
      var top = hosts.slice(0, _zxLim('hosts',10));
      var h = '<div style="display:grid;gap:4px;font-size:11px">';
      top.forEach(function(row){
        var pct = row.hits / maxHits * 100;
        h += '<div style="display:flex;align-items:center;gap:10px">';
        h += '<span style="flex:0 1 220px;min-width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(row.host)+'</span>';
        h += '<div style="flex:1;height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+pct.toFixed(0)+'%;background:var(--accent);border-radius:3px"></div></div>';
        h += '<span style="flex:0 0 56px;text-align:right;font-family:var(--font-mono);color:var(--text-2)">'+shortN(row.hits)+'</span>';
        h += '</div>';
      });
      if(hosts.length > top.length) h += '<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:4px 0 0" onclick="zMore(\'hosts\')">+ ещё '+(hosts.length-top.length)+'</div>';
      h += '</div>';
      if(listEl) listEl.innerHTML = h;
      if(statusEl) statusEl.textContent = hosts.length + ' хостов' + (_hostsClient ? ' · ' + _hostsClient : '');
    })
    .catch(function(e){
      if(statusEl) statusEl.textContent = 'Ошибка: '+e.message;
    });
}

// ── Matrix (collapsible) ──────────────────────────────────────────
function renderNewMatrix(){
  var el = document.getElementById('newMatrixTable');
  if(!el) return;
  var d = collectTrafficData();
  if(!d){ el.innerHTML = '<tr><td style="padding:20px;text-align:center;color:var(--text-3)">Нет данных</td></tr>'; return; }
  var fEl = document.getElementById('newMatrixFilter');
  var q = ((fEl && fEl.value) || '').trim().toLowerCase();
  var list = d.modemTraffic.filter(function(m){
    if(!q) return true;
    return (String(m.nick||'')+' '+String(m.pn||'')+' '+String(m.operator||'')+' '+String(m.server||'')).toLowerCase().indexOf(q) > -1;
  });
  list = list.slice().sort(function(a,b){ return ((b.monIn||0)+(b.monOut||0)) - ((a.monIn||0)+(a.monOut||0)); });
  var shown = list.slice(0, _zxLim('mx',10));
  var rows = shown.map(function(m){
    var tot = (m.monIn||0)+(m.monOut||0);
    var mt = (currentData.modemTrend||{})[m.server+'_'+m.portId];
    var tr = (mt!==undefined&&mt!==null)
      ? '<span style="font-size:10px;font-weight:600;color:'+(mt>=0?'var(--success)':'var(--danger)')+'">'+(mt>999?'+999%+':(mt<-99?'<−99%':((mt>=0?'+':'')+mt+'%')))+'</span>'
      : '<span style="font-size:10px;color:var(--text-3)">—</span>';
    return '<tr>'
      + '<td style="font-weight:600;color:var(--text-0)">'+esc(m.nick)+'</td>'
      + '<td style="text-align:left;color:var(--text-2)">'+esc(m.operator||'—')+'</td>'
      + '<td style="text-align:left;color:var(--text-2)">'+esc(m.server)+'</td>'
      + '<td style="text-align:left">'+esc(m.pn||'—')+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb((m.dayIn||0)+(m.dayOut||0))+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb(m.monIn||0)+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb(m.monOut||0)+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono);font-weight:600;color:var(--text-0)">'+fmtGb(tot)+'</td>'
      + '<td style="text-align:right">'+tr+'</td></tr>';
  }).join('');
  if(!rows) rows = '<tr><td colspan="9" style="padding:16px;text-align:center;color:var(--text-3)">Ничего не найдено</td></tr>';
  else if(list.length > shown.length) rows += '<tr><td colspan="9" style="padding:8px 10px;color:var(--accent);font-size:10.5px;cursor:pointer;text-align:left" onclick="zMore(\'mx\')">+ ещё '+(list.length-shown.length)+' · сортировка по Σ месяца</td></tr>';
  var cEl = document.getElementById('newMatrixCount');
  if(cEl) cEl.textContent = q ? (list.length + ' из ' + d.modemTraffic.length) : (d.modemTraffic.length + ' модемов');
  el.innerHTML = '<thead><tr><th style="text-align:left">Модем</th><th style="text-align:left">Оператор</th><th style="text-align:left">Сервер</th><th style="text-align:left">Клиент</th><th style="text-align:right">Сегодня</th><th style="text-align:right">↓ Вход</th><th style="text-align:right">↑ Выход</th><th style="text-align:right">Σ Всего</th><th style="text-align:right">Тренд</th></tr></thead><tbody>'+rows+'</tbody>';
}

// ========================================================================
// Stage 19 — Failover settings + manual controls + audit log
// ========================================================================
function loadFailoverSettings(){
  api(API+'/api/admin/settings')
    .then(function(s){
      var set=function(id,v){var el=document.getElementById(id);if(el){if(el.type==='checkbox')el.checked=!!v;else el.value=v;}};
      set('failoverEnabledInput', s.failover_enabled===true||s.failover_enabled===1);
      // dry_run defaults ON (only explicit false disables)
      set('failoverDryRunInput', !(s.failover_dry_run===false||s.failover_dry_run===0));
      set('failoverOfflineMinInput', s.failover_offline_min!=null?s.failover_offline_min:15);
      set('failoverGlitchFailsInput', s.failover_glitch_fails!=null?s.failover_glitch_fails:3);
      set('failoverProxyDeadMinInput', s.failover_proxy_dead_min!=null?s.failover_proxy_dead_min:45);
      set('failoverProxyDeadHardMinInput', s.failover_proxy_dead_hard_min!=null?s.failover_proxy_dead_hard_min:90);
      set('failoverUptimeFloorInput', s.failover_uptime_floor_pct!=null?s.failover_uptime_floor_pct:90);
      set('failoverSpareMinUptimeInput', s.failover_spare_min_uptime_pct!=null?s.failover_spare_min_uptime_pct:90);
      set('failoverCooldownHInput', s.failover_cooldown_h!=null?s.failover_cooldown_h:6);
      set('failoverMaxPerHourInput', s.failover_max_per_hour!=null?s.failover_max_per_hour:5);
    })
    .catch(function(){});
}
function saveFailoverSettings(){
  var body={
    failover_enabled: document.getElementById('failoverEnabledInput').checked,
    failover_dry_run: document.getElementById('failoverDryRunInput').checked,
    failover_offline_min: parseInt(document.getElementById('failoverOfflineMinInput').value)||15,
    failover_glitch_fails: parseInt(document.getElementById('failoverGlitchFailsInput').value)||3,
    failover_proxy_dead_min: parseInt(document.getElementById('failoverProxyDeadMinInput').value)||45,
    failover_proxy_dead_hard_min: parseInt(document.getElementById('failoverProxyDeadHardMinInput').value)||90,
    failover_uptime_floor_pct: (function(){var v=parseInt(document.getElementById('failoverUptimeFloorInput').value);return isNaN(v)?90:v;})(),
    failover_spare_min_uptime_pct: (function(){var v=parseInt(document.getElementById('failoverSpareMinUptimeInput').value);return isNaN(v)?90:v;})(),
    failover_cooldown_h: parseInt(document.getElementById('failoverCooldownHInput').value)||6,
    failover_max_per_hour: parseInt(document.getElementById('failoverMaxPerHourInput').value)||5
  };
  var st=document.getElementById('failoverSettingsStatus');
  api(API+'/api/admin/settings',{method:'PUT',json:body})
    .then(function(d){
      if(d&&!d.error){
        if(st)st.textContent='Сохранено · '+(body.failover_enabled?(body.failover_dry_run?'авто ВКЛ, но dry-run (тест) — реальных переносов нет':'⚠️ авто ВКЛ, реальные переносы активны'):'авто выкл')+'. Требуется перезапуск процесса.';
        showToast('Настройки failover сохранены','success');
        _showRestartBanner();
      } else { if(st)st.textContent='Ошибка: '+(d&&d.error||''); showToast('Не сохранилось','error'); }
    })
    .catch(function(e){if(st)st.textContent='Сеть: '+e.message;});
}
function loadFailoverCandidates(){
  var box=document.getElementById('failoverCandidates');
  if(box)box.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:12px">Загрузка…</div>';
  api(API+'/api/admin/failover/candidates')
    .then(function(d){
      var cands=(d&&d.candidates)||[];
      if(!cands.length){box.innerHTML='<div style="color:var(--success);font-size:12px;padding:12px">✓ Нет модемов, требующих failover прямо сейчас</div>';return;}
      var h='<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>';
      h+='<th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Сервер</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Модем</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Клиенты</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Причина</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Спейр</th><th style="padding:6px 8px"></th></tr></thead><tbody>';
      cands.forEach(function(c){
        var spareTxt=c.spare?('<span style="color:var(--success)">'+esc(c.spare)+'</span>'):'<span style="color:var(--danger)">нет спейра</span>';
        h+='<tr>';
        h+='<td style="padding:6px 8px">'+esc(c.server)+'</td>';
        h+='<td style="padding:6px 8px"><strong>'+esc(c.nick)+'</strong></td>';
        h+='<td style="padding:6px 8px;font-size:11px;color:var(--text-2)">'+esc((c.clients||[]).join(', '))+'</td>';
        h+='<td style="padding:6px 8px;font-size:11px">'+esc(c.reason)+' · '+esc(c.detail||'')+'</td>';
        h+='<td style="padding:6px 8px">'+spareTxt+'</td>';
        h+='<td style="padding:6px 8px;text-align:right">'+(c.spare?'<button class="btn btn-sm" style="font-size:11px" onclick="execFailover(\''+esc(c.server)+'\',\''+esc(c.imei)+'\',\''+esc(c.nick)+'\')">Перенести</button>':'—')+'</td>';
        h+='</tr>';
      });
      h+='</tbody></table>';
      box.innerHTML=h;
    })
    .catch(function(e){if(box)box.innerHTML='<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>';});
}
function execFailover(server,imei,nick){
  confirmDialog('Перенести клиента(ов) модема «'+nick+'» ('+server+') на здоровый спейр сейчас? Строка подключения клиента сохранится, внешний IP сменится.',function(){
    showToast('Выполняю перенос…','info');
    api(API+'/api/admin/failover/execute',{method:'POST',json:{server:server,imei:imei,nick:nick}})
      .then(function(d){
        if(d&&d.ok){
          var oks=(d.results||[]).filter(function(x){return x.result==='ok'}).length;
          var fails=(d.results||[]).filter(function(x){return x.result==='failed'||x.result==='no_spare'}).length;
          showToast('Перенос: '+oks+' ok'+(fails?', '+fails+' не удалось':''), fails?'warning':'success');
        } else { showToast('Не удалось: '+(d&&d.error||'?'),'error'); }
        loadFailoverCandidates();loadFailoverLog();
      })
      .catch(function(e){showToast('Сеть: '+e.message,'error')});
  },'Перенести','Failover модема');
}
function loadFailoverLog(){
  var box=document.getElementById('failoverLog');
  if(box)box.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:12px">Загрузка…</div>';
  api(API+'/api/admin/failover/log?limit=100')
    .then(function(d){
      var rows=(d&&d.log)||[];
      if(!rows.length){box.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:12px">История пуста</div>';return;}
      var resultBadge=function(r,dry){
        var map={ok:['#34c759','выполнен'],failed:['#e84141','ошибка'],dry_run:['#3b82f6','dry-run'],skipped_no_spare:['#e84141','нет спейра'],skipped_rate:['#EF9F27','лимит'],skipped_cooldown:['#9b9b98','cooldown']};
        var m=map[r]||['#9b9b98',r];
        return '<span style="background:'+m[0]+'22;color:'+m[0]+';padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600">'+m[1]+'</span>';
      };
      var h='<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>';
      h+='<th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Когда</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Сервер</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Клиент</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Перенос</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Причина</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Итог</th></tr></thead><tbody>';
      rows.forEach(function(r){
        var when=r.ts?new Date(r.ts.replace(' ','T')+'Z').toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'';
        var move=(r.dead_nick||'?')+' → '+(r.spare_nick||'?');
        h+='<tr>';
        h+='<td style="padding:6px 8px;color:var(--text-3);white-space:nowrap">'+esc(when)+'</td>';
        h+='<td style="padding:6px 8px">'+esc(r.server_name||'')+'</td>';
        h+='<td style="padding:6px 8px">'+esc(r.client_port_name||'')+'</td>';
        h+='<td style="padding:6px 8px;font-family:var(--font-mono)">'+esc(move)+'</td>';
        h+='<td style="padding:6px 8px;color:var(--text-2)">'+esc(r.trigger_reason||'')+'</td>';
        h+='<td style="padding:6px 8px">'+resultBadge(r.result,r.dry_run)+(r.error?'<div style="font-size:9px;color:var(--danger);margin-top:2px">'+esc(r.error)+'</div>':'')+'</td>';
        h+='</tr>';
      });
      h+='</tbody></table>';
      box.innerHTML=h;
    })
    .catch(function(e){if(box)box.innerHTML='<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>';});
}

// ── AI sales bots panel ──────────────────────────────────────────────────────
function aisVal(id){var e=document.getElementById(id);return e?String(e.value||'').trim():'';}
function loadAiSales(){aisStatus();aisLoadKeys();aisLoadQueue();}
function aisStatus(){
  api(API+'/api/admin/ai_sales/status').then(function(d){
    var el=document.getElementById('ais_status');if(!el)return;
    var k=d.keys||{},c=d.counts||{};
    el.innerHTML='Anthropic '+(k.anthropic?'✅':'❌')+' · Tavily '+(k.tavily?'✅':'❌')+' · CRM '+(d.crm&&d.crm.configured?'⚙️':'❌')
      +'  ·  ниш '+(c.niches||0)+' · компаний '+(c.companies||0)+' · контактов '+(c.contacts||0)+' (в Twenty '+(c.pushed||0)+')'
      +(d.running?'  ·  <span style="color:var(--warning)">▶ задача выполняется</span>':'');
    if(d.last_job&&d.last_job.status==='running')aisPollJob(d.last_job.id);
  }).catch(function(){});
}
function aisLoadKeys(){
  api(API+'/api/admin/settings').then(function(s){
    var a=document.getElementById('ais_anthropic'),t=document.getElementById('ais_tavily'),u=document.getElementById('ais_crmurl');
    if(a&&!a.value)a.value=s.anthropic_api_key||'';
    if(t&&!t.value)t.value=s.tavily_api_key||'';
    if(u&&!u.value)u.value=s.crm_db_url||'';
  }).catch(function(){});
}
function aisSaveKeys(){
  var body={anthropic_api_key:aisVal('ais_anthropic'),tavily_api_key:aisVal('ais_tavily'),crm_db_url:aisVal('ais_crmurl')};
  api(API+'/api/admin/settings',{method:'PUT',json:body}).then(function(d){
    showToast(d.ok?'Ключи сохранены':'Ошибка','success');aisStatus();
  }).catch(function(){showToast('Ошибка сети','error')});
}
function aisCrmPing(){
  var el=document.getElementById('ais_crmping');if(el)el.textContent='проверяю…';
  api(API+'/api/admin/ai_sales/crm_ping').then(function(d){
    if(!el)return;el.textContent=d.ok?('OK · компаний в CRM: '+d.companies):('Ошибка: '+(d.error||''));el.style.color=d.ok?'#2e9e5b':'var(--danger)';
  }).catch(function(){if(el)el.textContent='Ошибка сети'});
}
function aisRun(bot){
  var body={bot:bot};
  if(bot==='lookalikes'){body.seed=aisVal('ais_seed');body.count=parseInt(aisVal('ais_count')||'5',10);if(!body.seed){showToast('Укажите seed-компанию','error');return}}
  if(bot==='contacts'){body.count=20}
  if(bot==='push'&&!confirm('Залить найденные компании и контакты в Twenty CRM?'))return;
  api(API+'/api/admin/ai_sales/run',{method:'POST',json:body}).then(function(d){
    if(d.error){showToast(d.error,'error');return}
    showToast('Запущено (#'+d.jobId+')','success');aisPollJob(d.jobId);
  }).catch(function(){showToast('Ошибка сети','error')});
}
function aisPollJob(id){
  var box=document.getElementById('ais_job');if(!box)return;box.style.display='';
  (function tick(){
    api(API+'/api/admin/ai_sales/job/'+id).then(function(j){
      if(!j||j.error){box.innerHTML='—';return}
      var pct=j.total?Math.round((j.done/(j.total||1))*100):(j.status==='done'?100:8);
      box.innerHTML='<b>Задача #'+j.id+' ('+esc(j.bot)+')</b> — '+esc(j.progress||'')
        +'<div class="hbar-bar-wrap" style="height:8px;margin-top:6px;background:var(--bg-3);border-radius:4px"><div class="count-bar" style="width:'+pct+'%;height:8px;border-radius:4px"></div></div>'
        +(j.status==='error'?'<div style="color:var(--danger);margin-top:6px">Ошибка: '+esc(j.error||'')+'</div>':'')
        +(j.status==='done'?'<div style="color:#2e9e5b;margin-top:6px">✅ Готово: '+esc(j.result||'')+'</div>':'');
      if(j.status==='running'){setTimeout(tick,2500)}else{aisStatus();aisLoadQueue()}
    }).catch(function(){});
  })();
}
function aisLoadQueue(){
  api(API+'/api/admin/ai_sales/queue').then(function(d){
    var el=document.getElementById('ais_queue');if(!el)return;
    var comps=d.companies||[];
    if(!comps.length){el.innerHTML='<div style="color:var(--text-3)">Пусто — запусти бота «Похожие + ЛПР».</div>';return}
    var h='';
    comps.forEach(function(c){
      h+='<div style="border-bottom:1px solid var(--border);padding:7px 0">'
        +'<b style="color:var(--text-0)">'+esc(c.company)+'</b>'
        +(c.website?' · <a href="'+esc(c.website)+'" target="_blank" style="color:var(--accent);text-decoration:none">'+esc((c.website||'').replace(/^https?:\/\//,''))+'</a>':'')
        +(c.is_seed?' <span style="font-size:10px;color:var(--text-3)">SEED</span>':'')
        +(c.status==='pushed'?' <span style="font-size:10px;color:#2e9e5b">→ Twenty</span>':'');
      (c.contacts||[]).forEach(function(k){
        h+='<div style="margin-left:16px;color:var(--text-1);padding-top:2px">👤 '+esc(k.name)+' — '+esc(k.role)
          +(k.linkedin?' · <a href="'+esc(k.linkedin)+'" target="_blank" style="color:var(--accent)">LinkedIn</a>':'')
          +(k.contact?' · <span style="color:var(--text-3)">'+esc(k.contact)+'</span>':'')+'</div>';
      });
      h+='</div>';
    });
    el.innerHTML=h;
  }).catch(function(){});
}



// ===== Unified client detail modal (tabbed «Детали») =====
function switchDetailTab(tab){
  ['overview','billing','modems','payments'].forEach(function(t){
    var b=document.getElementById('cdTab_'+t),p=document.getElementById('cdPane_'+t);
    if(b)b.classList.toggle('active',t===tab);
    if(p)p.style.display=(t===tab)?'block':'none';
  });
  if(tab==='payments'){
    if(currentOpsClientId){ renderOpsHistory(currentOpsClientId); }
    else { var ob=document.getElementById('clientOpsBody'); if(ob)ob.innerHTML='<div style="color:var(--text-3);font-size:13px;padding:30px;text-align:center">Сначала сохраните клиента</div>'; }
  }
}
function _cdModemsFor(c){
  var map=currentData._modemMap||{},out=[];
  Object.keys(map).forEach(function(k){var m=map[k];if((m.ports||[]).some(function(p){return p.portName===c.portName;}))out.push(m);});
  return out;
}
function renderClientDetail(id, tab){
  var c=(currentData.clients||[]).find(function(x){return x.id===id;});
  if(!c)return;
  currentOpsClientId=id;
  showClientForm(c);
  var balance=c.balance!==undefined?c.balance:0;
  var mds=_cdModemsFor(c),mc=mds.length;
  var nm=(c.name||'').replace(/^(ООО|ИП|ЗАО|АО|ПАО)\s*/i,'').replace(/["«»]/g,'').trim();
  var ws=nm.split(/\s+/).filter(Boolean);
  var ini=((ws.length>=2?(ws[0].charAt(0)+ws[1].charAt(0)):nm.slice(0,2)).toUpperCase())||'?';
  document.getElementById('cdAvatar').textContent=ini;
  document.getElementById('cdName').textContent=c.name||'';
  var st=balance<0?['ДОЛЖНИК','var(--danger)','#fff']:(c.billingPaused?['ПАУЗА','var(--warning)','#000']:(mc===0?['НЕТ МОДЕМОВ','var(--bg-3)','var(--text-2)']:['АКТИВЕН','var(--success)','#fff']));
  var pl=document.getElementById('cdPill');pl.textContent=st[0];pl.style.background=st[1];pl.style.color=st[2];
  var charge=Math.round(((currentData.clientMonthCharges||{})[id]||0));
  var gb=Math.round(((currentData.clientLiveMonthGb||{})[id]||0)*10)/10;
  var be=document.getElementById('cdKpiBal');be.textContent=Math.round(balance).toLocaleString('ru-RU');be.style.color=balance<0?'var(--danger)':(balance>0?'var(--success)':'var(--text-0)');
  document.getElementById('cdKpiBalWrap').classList.toggle('is-green',balance>=0);
  document.getElementById('cdKpiCharge').textContent=charge.toLocaleString('ru-RU');
  document.getElementById('cdKpiModems').textContent=mc;
  document.getElementById('cdKpiTraffic').innerHTML=gb.toFixed(1)+'<span style="font-size:12px"> ГБ</span>';
  var ml=document.getElementById('cdModemsList');
  var mh='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin:6px 0 10px">Привязанные модемы ('+mc+')</div>';
  if(mc){mh+='<div style="display:flex;flex-wrap:wrap;gap:5px">'+mds.map(function(m){return '<span class="client-modem-tag">'+esc(m.nick)+' <span style="color:var(--text-3)">('+esc(m.server)+')</span></span>';}).join('')+'</div>';}
  else{mh+='<div style="font-size:12px;color:var(--text-3);padding:8px 0">Нет привязанных модемов. Привязка — на странице «Модемы».</div>';}
  ml.innerHTML=mh;
  document.getElementById('cdDeleteBtn').style.display='';
  switchDetailTab(tab||'overview');
}
function newClientForm(){
  currentOpsClientId=null;
  showClientForm(null);
  document.getElementById('cdAvatar').textContent='+';
  document.getElementById('cdName').textContent='Новый клиент';
  var pl=document.getElementById('cdPill');pl.textContent='';pl.style.background='transparent';
  ['cdKpiBal','cdKpiCharge','cdKpiModems','cdKpiTraffic'].forEach(function(k){var e=document.getElementById(k);if(e)e.textContent='—';});
  document.getElementById('cdModemsList').innerHTML='<div style="font-size:12px;color:var(--text-3);padding:8px 0">Сначала сохраните клиента</div>';
  document.getElementById('cdDeleteBtn').style.display='none';
  switchDetailTab('overview');
}

function setClientFilter2(f){_clientFilter=f;document.querySelectorAll('.cl-chip').forEach(function(ch){ch.classList.toggle('active',ch.getAttribute('data-f')===f);});renderClients();}
