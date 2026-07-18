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

// Fetch /api/analytics/modem_health and index by server|nick for fast lookup
// from the table cell renderer and the «Здоровье» tab in the detail modal.
function loadHealthMap(){
  api(API+'/api/analytics/modem_health?days=7')
    .then(function(d){
      if (!d || !d.modems) return;
      var map = {};
      for (var i = 0; i < d.modems.length; i++) {
        var m = d.modems[i];
        map[m.server_name + '|' + m.nick] = m;
      }
      window._healthMap = map;
      window._healthMapAt = Date.now();
      // Re-render table so the new column populates if it was waiting on data
      if (typeof renderTable === 'function') { try { renderTable(); } catch(_){} }
    })
    .catch(function(e){ console.warn('loadHealthMap failed:', e.message); });
}

// Helper used by the table cell renderer and the modal Health tab.
function _getHealth(modem){
  if (!window._healthMap) return null;
  return window._healthMap[modem.server + '|' + modem.nick] || null;
}

// Stage 18.16 — mirrors the backend's getStaleNicks + getUnboundNicks filters
// (server.js). Returns the reason a modem is excluded from analytics
// (latency_stats, modem_health, latency_day, heatmap), or null if included.
// Stale takes precedence — "long-dead" is the more actionable signal.
function _excludeReason(modem){
  if(!modem) return null;
  var staleH = Number(window._staleModemHours) || 12;
  var lastMs = Number(modem.lastSeenMs)||0;
  // Backend treats "never been online" as stale too.
  var neverOnline = !lastMs;
  var staleOffline = lastMs > 0 && (Date.now() - lastMs) > staleH*3600*1000;
  if(neverOnline||staleOffline){
    var hours = lastMs ? Math.floor((Date.now()-lastMs)/3600000) : null;
    return {
      type:'stale',
      label:'Не в стат.',
      tooltip:'Исключён из статистики: модем не отвечает '+(hours!=null?(hours>=24?Math.floor(hours/24)+' дн.':hours+' ч'):'давно')+' (порог '+staleH+' ч).\nЗайди в «Настройки» → stale_modem_hours, если порог нужно изменить.'
    };
  }
  // Unbound: no port has a portName (no client attached). Mirrors backend
  // getUnboundNicks() in server.js (modems present in knownModems but with
  // zero bound ports).
  var anyBound = false;
  for(var i=0;i<(modem.ports||[]).length;i++){
    var pn = modem.ports[i] && modem.ports[i].portName;
    if(pn && String(pn).trim()){ anyBound=true; break; }
  }
  if(!anyBound){
    return {
      type:'unbound',
      label:'Без клиента',
      tooltip:'Исключён из статистики: нет привязки к клиенту (ни один порт не имеет portName). Привяжите модем к клиенту, чтобы он попадал в задержки/здоровье/heatmap.'
    };
  }
  return null;
}
// Compact chip for the «Модем» column.
function _excludeChip(modem){
  var r = _excludeReason(modem);
  if(!r) return '';
  var bg = r.type==='stale' ? 'rgba(155,155,152,0.18)' : 'rgba(232,159,39,0.18)';
  var fg = r.type==='stale' ? 'var(--text-3)' : '#a86b00';
  return ' <span class="excl-chip" title="'+esc(r.tooltip)+'" style="display:inline-block;background:'+bg+';color:'+fg+';padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;cursor:help;vertical-align:middle;margin-left:5px">'+esc(r.label)+'</span>';
}

// ========== MODEM TABLE ==========
function renderServerFilter(){var sv=currentData.servers||[];var ls='font-size:11px;display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;border-radius:3px';var h='<label style="'+ls+'"><input type="radio" name="srvF" '+(activeServerFilter==='all'?'checked':'')+' onchange="setServerFilter(\'all\')"> Все серверы</label>';
  // Group by country
  var seen={};sv.forEach(function(s){var c=COUNTRIES[s.name]||{};var cc=c.country||s.name;if(!seen[cc]){seen[cc]={flag:c.flag||'',name:c.name||cc,servers:[]};} seen[cc].servers.push(s.name)});
  Object.keys(seen).forEach(function(cc){var g=seen[cc];var ccActive=g.servers.indexOf(activeServerFilter)!==-1;
    h+='<label style="'+ls+';font-weight:600;font-size:10px;padding-top:6px"><input type="radio" name="srvF" '+(activeServerFilter==='country:'+cc?'checked':'')+' onchange="setServerFilter(\'country:'+cc+'\')"> '+g.flag+' '+g.name+' <span style="color:var(--text-3);font-weight:400">(все)</span></label>';
    g.servers.sort().forEach(function(sn){h+='<label style="'+ls+';padding-left:20px"><input type="radio" name="srvF" '+(activeServerFilter===sn?'checked':'')+' onchange="setServerFilter(\''+sn+'\')"> '+sn+'</label>'})});
  var _sfd=document.getElementById('serverFilterDD');if(_sfd)_sfd.innerHTML=h; // server/client/status moved inline; ⚙ keeps only columns
  // Status filter (legacy ⚙ slot — only render if present)
  var sh='';['all','online','offline'].forEach(function(v){var lbl=v==='all'?'Все статусы':v==='online'?'Online':'Offline';sh+='<label style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px"><input type="radio" name="stF" '+(activeStatusFilter===v?'checked':'')+' onchange="setStatusFilter(\''+v+'\')"> '+lbl+'</label>'});var _stfd=document.getElementById('statusFilterDD');if(_stfd)_stfd.innerHTML=sh}
function setServerFilter(v){activeServerFilter=v;localStorage.setItem('admin_srv_filter',v);renderTable()}
function setStatusFilter(v){activeStatusFilter=v;renderTable()}
function setClientFilter(v){activeClientFilter=v;renderTable()}
function renderClientFilterDD(){var el=document.getElementById('clientFilterDD');if(!el||!currentData)return;var cls=currentData.clients||[];var h='<label style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px"><input type="radio" name="clF" '+(activeClientFilter===''?'checked':'')+' onchange="setClientFilter(\'\')"> Все клиенты</label>';cls.filter(function(c){return c.portName&&c.modemCount>0}).forEach(function(c){h+='<label style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px"><input type="radio" name="clF" '+(activeClientFilter===c.portName?'checked':'')+' onchange="setClientFilter(\''+esc(c.portName)+'\')"> '+esc(c.name)+'</label>'});el.innerHTML=h}
function toggleFilterDropdown(){document.getElementById('filterDropdown').classList.toggle('show')}
document.addEventListener('click',function(e){if(!e.target.closest('.col-selector'))document.querySelectorAll('.col-dropdown').forEach(function(d){d.classList.remove('show')})})
function renderColSelector(){var h='';for(var i=0;i<COLUMNS.length;i++){var c=COLUMNS[i];if(c.id==='status'||c.id==='actions'||c.id==='bulk'||c.id==='rail')continue;h+='<label><input type="checkbox" '+(c.visible?'checked':'')+' onchange="toggleCol(\''+c.id+'\',this.checked)">'+c.label+'</label>'}document.getElementById('colDropdown').innerHTML=h}
function toggleCol(id,v){for(var i=0;i<COLUMNS.length;i++){if(COLUMNS[i].id===id){COLUMNS[i].visible=v;break}}var s={};COLUMNS.forEach(function(c){s[c.id]=c.visible});localStorage.setItem('admin_col_state_v2',JSON.stringify(s));renderTable()}
// getModemStatus, formatUptime, formatTraffic, renderSignalBars, renderNetBadge,
// esc, fmtDateRu, parseTraffic, bytesToGb moved to /js/utils.js

// ===== Redesign Phase 1: fleet summary chips + quick filters + needs-attention band =====
var activeQuickFilter='all';
function _fmtDur(ms){var s=Math.max(0,Math.floor(ms/1000));var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);if(h>0)return h+' ч '+m+' м';if(m>0)return m+' м';return s+' с';}
function _modemTrafGb(modem){var b=0;(modem.ports||[]).forEach(function(p){var w=p._bw||{};b+=parseTraffic(w.bandwidth_bytes_day_in)+parseTraffic(w.bandwidth_bytes_day_out)});return b/1e9;}
// Client/rental state. randomport* phantoms are already cleaned to '' upstream,
// so a non-empty portName = a real client. PROXY_VALID_BEFORE in the past = срок аренды истёк.
function _portExpired(p){var vb=p&&p.PROXY_VALID_BEFORE;if(!vb)return false;var t=Date.parse(vb);return !isNaN(t)&&t<Date.now();}
function _modemClients(m){var out=[];(m.ports||[]).forEach(function(p){var n=(p.portName||'').trim();if(n&&out.indexOf(n)===-1)out.push(n);});return out;}
function _hasActiveClient(m){return (m.ports||[]).some(function(p){return (p.portName||'').trim()&&!_portExpired(p);});}
function _allClientsExpired(m){var cp=(m.ports||[]).filter(function(p){return (p.portName||'').trim();});return cp.length>0&&cp.every(_portExpired);}
// A QUALITY problem on a present modem (independent of offline). Returns {reason,sev,kind} or null.
function _modemIssue(modem){
  if(modem.webappDown)return{reason:'WebApp недоступен — нужен рестарт',sev:5,kind:'webapp'};
  var ss=(modem.simStatus||'').toUpperCase();
  if(ss&&ss!=='UNKNOWN'&&!/\bOK\b|READY/.test(ss))return{reason:'SIM: '+(ss==='MODEM_SIM_UNDETECTED'?'не определена':ss.toLowerCase()),sev:5,kind:'sim'};
  if(modem.httpRedirect)return{reason:'редирект оператора · SIM без денег/блок',sev:5,kind:'sim'};
  var hm=_getHealth(modem);
  // «не отвечает» — только при УСТОЙЧИВОМ провале (≥50% чеков в окне), а не по
  // одному флапнувшему чеку: мобильный прокси изредка ловит таймаут (curl 15с),
  // но работает (трафик идёт). Латентность — по стабильному P50, не по последнему.
  // Proxy/error signals matter only for an ACTIVELY rented modem. A free or
  // expired port is blocked by us / is a phantom → its failures are not a fault.
  // Связь модема (по net_details, не зависит от клиента). ProxySmart считает
  // «Online» строго — модем с IS_ONLINE=yes, но разрывом / большими потерями он
  // НЕ считает работающим. Дублируем эту строгость, иначе деградировавшие модемы
  // молча числятся «в работе».
  if(modem.connDead||modem.pktLoss===100)return{reason:'нет связи · '+(modem.connDead?'разрыв соединения':'100% потерь'),sev:4,kind:'loss'};
  if(modem.pktLoss!=null&&modem.pktLoss>=40)return{reason:'плохая связь · потери '+modem.pktLoss+'%',sev:4,kind:'loss'};
  var _act=_hasActiveClient(modem);
  if(_act&&(modem.pcConsecFails||0)>=3)return{reason:'прокси не отвечает ('+modem.pcConsecFails+' подряд)',sev:4,kind:'proxy'};
  if(hm&&hm.latency_ms!=null&&hm.latency_ms>_pcBadMs)return{reason:'латентность '+fmtMs(hm.latency_ms),sev:3,kind:'lat'};
  if(modem.pktLoss!=null&&modem.pktLoss>=15)return{reason:'потери пакетов '+modem.pktLoss+'%',sev:3,kind:'loss'};
  if(_act&&modem.pcErrorPct!=null&&modem.pcErrorPct>=_errorRateThreshold)return{reason:'ошибки '+modem.pcErrorPct+'%',sev:3,kind:'err'};
  if(hm&&hm.health_score!=null&&hm.status==='bad')return{reason:'здоровье '+hm.health_score,sev:2,kind:'health'};
  if(modem.rebootScore!=null&&modem.rebootScore>=70)return{reason:'нужен ребут · score '+modem.rebootScore,sev:2,kind:'reboot'};
  return null;
}
// Inline status flags shown next to the modem nick — only when the condition
// is actually active (redirect / SIM problem / reboot-needed / locked). Sparse
// states get a symbol in-place instead of a mostly-empty dedicated column.
// ProxySmart MSG во время ротации/операции = служебный шум («IP rotated at the
// moment; Locked with other operation (IP rotation)») — он дублирует значок 🔒 и
// статус «Смена IP», показывать его флагом ⚠ не нужно. Реальные предупреждения
// (WebApp not available и т.п.) сюда не попадают и остаются видимыми.
function _msgIsNoise(s){s=String(s||'').toLowerCase();if(!s.trim())return true;
  var t=s.replace(/ip rotated at the moment/g,'').replace(/locked with other operation\s*\([^)]*\)/g,'').replace(/locked with other operation/g,'').replace(/ip rotation/g,'').replace(/rotation in progress/g,'').replace(/in progress/g,'').replace(/at the moment/g,'').replace(/\brotated\b/g,'').replace(/\brotation\b/g,'').replace(/\blocked\b/g,'');
  return t.replace(/[^a-zа-я0-9]+/gi,'').length===0;}
// Сервер «отключён» = отдаёт устаревший кеш (попал в currentData.cachedServers).
function _serverDownInfo(srv){var cs=(currentData&&currentData.cachedServers)||[];for(var i=0;i<cs.length;i++){if(cs[i].name===srv){var ca=cs[i].cachedAt||0;return{down:true,ageMin:ca?Math.round((Date.now()-ca)/60000):0}}}return{down:false,ageMin:0}}
function _serverDownBadge(srv){var d=_serverDownInfo(srv);if(!d.down)return'';return'<span class="srv-down-badge" title="Сервер не отвечает — показаны последние данные из кеша">⚠ Сервер недоступен'+(d.ageMin?' · '+d.ageMin+' мин назад':'')+'</span>';}
function _modemFlags(m){var f='';
  if(m.isTestPool)f+='<span class="mflag" style="color:var(--text-2)" title="Тестовый пул симулятора — в счётчики парка не входит">🧪</span>';
  if(m.httpRedirect)f+='<span class="mflag" style="color:var(--danger)" title="Оператор навязал редирект — SIM без денег / блок">⛔</span>';
  var ss=(m.simStatus||'').toUpperCase();if(ss&&ss!=='UNKNOWN'&&!/\bOK\b|READY/.test(ss))f+='<span class="mflag" style="color:var(--danger)" title="SIM: '+esc(ss)+'">\u{1F4F5}</span>';
  if(m.rebootScore!=null&&Number(m.rebootScore)>=70)f+='<span class="mflag" style="color:var(--warning)" title="Нужен ребут (score '+m.rebootScore+')">♻</span>';
  if(m.isLocked)f+='<span class="mflag" style="color:var(--text-2)" title="Модем занят операцией / ротацией">\u{1F512}</span>';
  if(m.webappDown)f+='<span class="mflag" style="color:var(--danger)" title="ProxySmart: '+esc(m.msg||'WebApp недоступен — перезагрузите модем')+'">\u{1F310}</span>';
  else if(m.msg&&!_msgIsNoise(m.msg))f+='<span class="mflag" style="color:var(--warning)" title="ProxySmart: '+esc(m.msg)+'">⚠</span>';
  return f;}
// «Давно офлайн» (снят с учёта): офлайн ≥ _staleModemHours (по умолч. 12ч) или
// никогда не был онлайн. Такие скрыты по умолчанию, показываются фильтром.
function _isStaleModem(m){if(m.webappDown)return false;if(getModemStatus(m)!=='offline')return false;var ms=Number(m.lastSeenMs)||0;if(!ms)return true;return ms<(Date.now()-(Number(window._staleModemHours)||12)*3600000);}
function _offlineReason(modem){if(getModemStatus(modem)!=='offline')return null;var ms=Number(modem.lastSeenMs)||0;var st=(window._staleModemHours?(Date.now()-ms>(Number(window._staleModemHours)||12)*3600000):false);return{reason:'оффлайн '+(ms?_fmtDur(Date.now()-ms):'давно'),sev:4,kind:'offline',ms:ms,stale:(ms?st:true)};}
function _attnReason(modem){var off=_offlineReason(modem);return off?off:_modemIssue(modem);}
function setQuickFilter(v){activeQuickFilter=(activeQuickFilter===v?'all':v);renderTable();}
function setModemsView(v){window._modemsView=v;try{localStorage.setItem('admin_modems_view',v)}catch(e){}renderTable();}
function tmClose(){var m=document.getElementById('tileMenu');if(m)m.style.display='none';}
function tileMenu(e,tile){e.stopPropagation();var n=tile.dataset.nick,s=tile.dataset.server,i=tile.dataset.imei||'',mdl=tile.dataset.model||'';var d='data-imei="'+i+'" data-server="'+s+'" data-nick="'+esc(n)+'"';var m=document.getElementById('tileMenu');if(!m){m=document.createElement('div');m.id='tileMenu';m.className='tile-menu';document.body.appendChild(m);}
  m.innerHTML='<div class="tm-h">'+esc(n)+' <span style="color:var(--text-3);font-weight:400">'+esc(s)+'</span></div>'
    +'<button class="tm-item" '+d+' onclick="rebootModem(this);tmClose()">⏻ Ребут</button>'
    +(/MF289/i.test(mdl)?'':'<button class="tm-item" '+d+' onclick="usbReset(this);tmClose()">⊘ USB-ресет</button>')
    +'<button class="tm-item" '+d+' onclick="readdModem(this);tmClose()">⟳ Re-Add (переподключить)</button>'
    +'<div style="height:1px;background:var(--border);margin:4px 0"></div>'
    +'<button class="tm-item" onclick="tmClose();openDetailAtTab(\''+esc(n).replace(/\x27/g,"\\\x27")+'\',\''+s+'\',\'info\')">ⓘ Подробнее</button>'+((i&&tile.dataset.stale==='1')?'<div style="height:1px;background:var(--border);margin:4px 0"></div><button class="tm-item" style="color:var(--danger)" onclick="tmClose();deleteModem(\''+s+'\',\'meta_'+i+'\',\''+esc(n).replace(/\x27/g,"\\\x27")+'\')">🗑 Удалить</button>':'');
  m.style.display='block';var r=tile.getBoundingClientRect(),mw=180,mh=m.offsetHeight||210;var left=r.left;if(left+mw>window.innerWidth-8)left=window.innerWidth-mw-8;var top=r.bottom+4;if(top+mh>window.innerHeight-8)top=Math.max(8,r.top-mh-4);m.style.left=left+'px';m.style.top=top+'px';}
document.addEventListener('click',function(e){if(!e.target.closest('#tileMenu')&&!e.target.closest('.modem-tile'))tmClose();});
function _tileRank(m){var st=getModemStatus(m);if(st==='offline')return 4;var iss=_modemIssue(m);if(iss)return iss.sev>=4?0:1;return 2;}
function _tileColor(m){var st=getModemStatus(m);if(st==='offline')return{b:'var(--text-3)',bg:'var(--bg-2)'};var iss=_modemIssue(m);if(iss)return iss.sev>=4?{b:'var(--danger)',bg:'rgba(255,56,60,.08)'}:{b:'var(--warning)',bg:'rgba(255,204,0,.10)'};return{b:'var(--success)',bg:''};}
// Единый порог цвета коннектов (весь UI): >700 красный, 300–700 жёлтый, <300 зелёный.
function _connColor(v){return v>700?'var(--danger)':(v>=300?'var(--warning)':'var(--success)');}
// Суммарные живые коннекты модема по портам.
function _connsTotal(modem){var t=0;(modem.ports||[]).forEach(function(p){if(p.conns_stats)t+=Number(p.conns_stats.total)||0;});return t;}
// Спарклайн истории коннектов за ~60 мин (connsHistory[imei] = [[секундНазад,total],…]).
// Возвращает {svg, hmax}; цвет линии — по пику за час (те же пороги).
function _connsSpark(modem,W,H){
  var hist=(currentData.connsHistory||{})[modem.imei]||[];
  var cur=_connsTotal(modem);
  if(hist.length<2)return{svg:'',hmax:0,cur:cur};
  var vs=hist.map(function(pt){return Number(pt[1])||0});
  var hmax=Math.max.apply(null,vs),sm=Math.max(hmax,1);
  W=W||52;H=H||15;var n=vs.length;
  var pts=vs.map(function(v,i){return(i/(n-1)*W).toFixed(1)+','+(H-1-(v/sm)*(H-2)).toFixed(1)}).join(' ');
  // Высота нормирована на пик модема, поэтому цифры на глаз не сопоставимы — даём
  // тултип (SVG <title>) с реальными значениями. Цвет линии = ТЕКУЩЕЕ число
  // (совпадает с цифрой рядом); пик за час — в подсказке.
  var ttl='Сейчас: '+cur+' коннектов · пик за 60 мин: '+hmax;
  return{svg:'<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" style="vertical-align:-3px;opacity:.9"><title>'+ttl+'</title><polyline points="'+pts+'" fill="none" stroke="'+_connColor(cur)+'" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',hmax:hmax,cur:cur};
}
function renderModemGrid(groups){var out='';COUNTRY_ORDER.forEach(function(srv){var modems=groups[srv];if(!modems||!modems.length)return;var ci=COUNTRIES[srv]||{};var online=0;modems.forEach(function(m){var s=getModemStatus(m);if(s==='online'||s==='rotating')online++});var fb=(currentData.fleet&&currentData.fleet.byServer&&currentData.fleet.byServer[srv])||null;var fOn=fb?((fb.working!=null)?fb.working:fb.online):online;var fN=fb?fb.total:modems.length;if(fN<fOn)fN=fOn;out+='<div style="font-size:12px;color:var(--text-2);margin:12px 24px 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent)">'+esc(srv)+'</span>'+(ci.name?'<span>· '+esc(ci.name)+'</span>':'')+(ci.address?'<span style="color:var(--text-3)">📍 '+esc(ci.address)+'</span>':'')+'<span style="color:'+(fOn>=fN?'var(--success)':'var(--warning)')+';font-weight:600">'+fOn+'/'+fN+' в работе</span>'+_serverDownBadge(srv)+'<span style="margin-left:auto;display:inline-flex;gap:6px"><button class="srv-act" onclick="reconnectAll(\''+srv+'\')" title="Re-Add всех офлайн-модемов сервера">↻ Переподключить модемы</button><button class="srv-act srv-act-danger" onclick="rebootServer(\''+srv+'\')" title="Перезагрузить весь сервер (нужен пароль)">⏻ Ребут сервера</button></span></div><div class="mtile-grid" style="padding:0 24px 4px">';var sorted=modems.slice().sort(function(a,b){return String(a.nick).localeCompare(String(b.nick),undefined,{numeric:true,sensitivity:'base'})});sorted.forEach(function(m){var c=_tileColor(m);var st=getModemStatus(m);var sub;var iss;if(m.webappDown){sub='<span style="color:var(--danger)">WebApp недоступен</span>';}else if(st==='rotating'){sub='<span style="color:var(--accent)">Смена IP…</span>';}else if(st==='rebooting'){sub='<span style="color:var(--accent)">Перезагрузка…</span>';}else if(st==='offline'){var off=_offlineReason(m);sub='<span style="color:var(--text-3)">'+(off?esc(off.reason):'офлайн')+'</span>';}else if(!_hasActiveClient(m)){sub='<span style="color:var(--text-3)">'+(_allClientsExpired(m)?'Оплата истекла':'Свободен')+'</span>';}else{iss=_modemIssue(m);if(iss&&iss.kind==='err')iss=null;var _pt=m.pcErrorPctToday;var _tBad=(m.pcErrToday>0&&_pt!=null&&_pt>=_errorRateThreshold);var _tWarn=(m.pcErrToday>0&&_pt!=null&&_pt>=5);if(iss&&iss.sev>=4){sub='<span style="color:var(--danger)">'+esc(iss.reason)+'</span>';}else if(_tBad||_tWarn){sub='<span style="color:'+(_tBad?'var(--danger)':'var(--warning)')+'">Ошибки: '+_pt+'%</span>';}else if(iss){sub='<span style="color:var(--warning)">'+esc(iss.reason)+'</span>';}else if(m.pcErrToday>0){sub='<span style="color:var(--text-3)">Ошибки: '+(_pt>=1?_pt+'%':'<1%')+'</span>';}else{sub='<span style="color:var(--text-3)">'+(m.pcChecksToday>0?'Без ошибок':'Ок')+'</span>';}}var _cls=_modemClients(m);var _clf=esc(_cls.join(', '));var _hm=_getHealth(m);var _hs='';if(_hm&&_hm.health_score!=null&&!(iss&&iss.kind==='health')){var _hc=_hm.status==='good'?'var(--success)':_hm.status==='warn'?'var(--warning)':_hm.status==='bad'?'var(--danger)':'var(--text-3)';_hs='<div class="mt-health"><span style="color:'+_hc+'" title="Health-score (7 дн): латентность + ошибки + аптайм">Здоровье: '+_hm.health_score+'</span></div>';}
// Коннекты: количество + спарклайн за 60 мин (тот же график, что в таблице).
var _cs=_connsSpark(m);var _ctot=_connsTotal(m);
var _cTitle='Живые TCP-коннекты: '+_ctot+(_cs.hmax?' · пик за 60 мин: '+_cs.hmax:'')+' · график за последний час';
var _cConn='<div class="mt-conns" title="'+_cTitle+'"><span class="mt-conns-spark">'+(_cs.svg||'')+'</span><span class="mt-conns-n" style="color:'+(_ctot>0?_connColor(_ctot):'var(--text-3)')+'">'+_ctot+'</span><span class="mt-conns-lbl">конн · 60м</span></div>';
out+='<div class="modem-tile" data-nick="'+esc(m.nick)+'" data-server="'+m.server+'" data-imei="'+(m.rawImei||'')+'" data-model="'+esc(m.model||'')+'" data-stale="'+(_isStaleModem(m)?'1':'')+'" onclick="tileMenu(event,this)" style="border-left-color:'+c.b+';'+(c.bg?'background:'+c.bg+';':'')+'"><div class="mt-nick">'+esc(m.nick)+_modemFlags(m)+'</div><div class="mt-client" title="'+_clf+'">'+(_cls.length?_clf:'<span style="color:var(--text-3)">—</span>')+'</div>'+(m.operator?'<div class="mt-op" title="Оператор"><i></i>'+esc(m.operator)+'</div>':'')+'<div class="mt-sub">'+sub+'</div>'+_hs+_cConn+'</div>';});out+='</div>';});return out||'<div style="padding:40px;text-align:center;color:var(--text-3)">Нет модемов по фильтру</div>';}
var _mkColor={webapp:'var(--danger)',sim:'var(--danger)',proxy:'var(--danger)',offline:'var(--danger)',loss:'var(--danger)',lat:'var(--warning)',err:'var(--warning)',health:'var(--warning)',reboot:'var(--warning)'};
function renderModemsTopBar(){
  var map=(currentData&&currentData._modemMap)||{};
  // «Все»/«Онлайн» — ТЕ ЖЕ числа, что на карточке дашборда и в заголовках
  // серверов: ростер fleet (без тест-пула 🧪, soft-deleted и random),
  // «Онлайн» = working (онлайн + блип <10 мин). Раньше тут был живой подсчёт
  // по _modemMap — отсюда и расхождения вида «91/90» против «89/90».
  var _fl=(currentData&&currentData.fleet)||null;
  var total,online;
  if(_fl&&typeof _fl.total==='number'){
    total=_fl.total;
    online=(_fl.working!=null)?_fl.working:_fl.online;
  }else{
    total=0;online=0;
    for(var k0 in map){var m0=map[k0];if(m0.isTestPool)continue;if(_isStaleModem(m0))continue;total++;var s0=getModemStatus(m0);if(s0==='online'||s0==='rotating')online++;}
  }
  // Остальные чипы — по живой карте, но тоже без тест-пула (это не парк).
  var offline=0,problem=0,free=0,stale=0,sim=0;
  for(var k in map){var m=map[k];if(m.isTestPool)continue;
    if(_isStaleModem(m)){stale++;continue;}
    var st=getModemStatus(m);if(st==='offline')offline++;
    var _mi=_modemIssue(m);if(_mi)problem++;if(_mi&&_mi.kind==='sim')sim++;
    if(!_hasActiveClient(m))free++;
  }
  function chip(id,label,count,clr){var on=activeQuickFilter===id;return '<button class="qf-chip'+(on?' active':'')+'" data-f="'+id+'" onclick="setQuickFilter(\''+id+'\')">'+label+'<span class="qf-count"'+(clr&&!on?' style="color:'+clr+'"':'')+'>'+count+'</span></button>';}
  var chips='<div class="qf-chips" title="Все/Онлайн — по парку (fleet): активные / в работе (онлайн + блип &lt;10 мин), как на дашборде. Тест-пул (🧪) в счётчики не входит">'
    +chip('all','Все',total,'')
    +chip('online','Онлайн',online,'var(--success)')
    +chip('problem','Проблемы',problem,'var(--warning)')
    +chip('sim','SIM',sim,'var(--danger)')
    +chip('offline','Офлайн',offline,'var(--text-2)')
    +chip('free','Свободные',free,'var(--accent)')
    +chip('stale','Оффлайн >12ч',stale,'var(--text-3)')
    +'</div>';
  // Сервер (сгруппирован по стране) + Клиент — инлайн-селекты
  var sv=(currentData&&currentData.servers)||[];var seen={};sv.forEach(function(s){var c=COUNTRIES[s.name]||{};var cc=c.country||s.name;if(!seen[cc])seen[cc]={flag:c.flag||'',name:c.name||cc,servers:[]};seen[cc].servers.push(s.name);});
  var srvSel='<select class="flt-select" onchange="setServerFilter(this.value)"><option value="all"'+(activeServerFilter==='all'?' selected':'')+'>Все серверы</option>';
  Object.keys(seen).forEach(function(cc){var g=seen[cc];srvSel+='<optgroup label="'+esc(g.name)+'"><option value="country:'+cc+'"'+(activeServerFilter==='country:'+cc?' selected':'')+'>'+esc(g.name)+' — все</option>';g.servers.sort().forEach(function(sn){srvSel+='<option value="'+esc(sn)+'"'+(activeServerFilter===sn?' selected':'')+'>'+esc(sn)+'</option>';});srvSel+='</optgroup>';});
  srvSel+='</select>';
  var cls=(currentData&&currentData.clients)||[];
  var clSel='<select class="flt-select" onchange="setClientFilter(this.value)"><option value=""'+(activeClientFilter===''?' selected':'')+'>Все клиенты</option>';
  // Только клиенты с портами — «без портов» (неактивные) в фильтр не выводим (как в аналитике).
  cls.filter(function(c){return c.portName&&c.modemCount>0}).forEach(function(c){clSel+='<option value="'+esc(c.portName)+'"'+(activeClientFilter===c.portName?' selected':'')+'>'+esc(c.name)+'</option>';});
  clSel+='</select>';
  var toggle='<div class="acc-period-group" style="display:inline-flex"><button class="acc-period-btn'+(window._modemsView==='grid'?'':' active')+'" onclick="setModemsView(\'table\')">Таблица</button><button class="acc-period-btn'+(window._modemsView==='grid'?' active':'')+'" onclick="setModemsView(\'grid\')">Сетка</button></div>';
  var bar='<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 24px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px">'+chips+'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'+srvSel+clSel+toggle+'</div></div>';
  var tb=document.getElementById('modemsTopBar');if(tb)tb.innerHTML=bar;
  var na=document.getElementById('needsAttention');if(na)na.innerHTML='';
}

function renderTable(){
  if(!currentData||!currentData._modemMap)return;try{renderModemsTopBar()}catch(_e){}var map=currentData._modemMap,search=(((document.getElementById('modemSearch')||document.getElementById('searchBox')||{}).value)||'').toLowerCase(),cols=COLUMNS.filter(function(c){return c.visible}),wrap=document.getElementById('tableWrap');
  var groups={};COUNTRY_ORDER.forEach(function(s){groups[s]=[]});
  var totalFiltered=0;
  for(var imei in map){var modem=map[imei],srv=modem.server;if(_isStaleModem(modem)&&activeQuickFilter!=='stale'&&activeStatusFilter!=='offline')continue;if(activeQuickFilter!=='all'){var _qst=getModemStatus(modem);if(activeQuickFilter==='online'){if(_qst!=='online'&&_qst!=='rotating')continue}else if(activeQuickFilter==='offline'){if(_qst!=='offline')continue}else if(activeQuickFilter==='stale'){if(!_isStaleModem(modem))continue}else if(activeQuickFilter==='problem'){if(!_modemIssue(modem)&&!_offlineReason(modem))continue}else if(activeQuickFilter==='sim'){var _qi=_modemIssue(modem);if(!_qi||_qi.kind!=='sim')continue}else if(activeQuickFilter==='idle'){if(_qst==='offline'||_modemTrafGb(modem)>0.05)continue}else if(activeQuickFilter==='free'){if(_hasActiveClient(modem))continue}}if(activeServerFilter!=='all'){if(activeServerFilter.indexOf('country:')===0){var _fc=activeServerFilter.slice(8);var _sc=(COUNTRIES[srv]||{}).country||'';if(_sc!==_fc)continue}else if(srv!==activeServerFilter)continue}var status=getModemStatus(modem);if(activeStatusFilter==='online'&&status!=='online'&&status!=='rotating')continue;if(activeStatusFilter==='offline'&&status!=='offline')continue;if(activeClientFilter){var pns=modem.ports.map(function(p){return p.portName||''});if(pns.indexOf(activeClientFilter)===-1)continue}if(search){var ss=[modem.nick,modem.extIp,modem.operator,modem.phone].join(' ').toLowerCase();modem.ports.forEach(function(p){ss+=' '+(p.portName||'')+' '+(p.LOGIN||'')});if(ss.indexOf(search)===-1)continue}if(!groups[srv])groups[srv]=[];groups[srv].push(modem);totalFiltered++}
  var totalAll=Object.keys(map).length;
  var ctr=document.getElementById('searchCounter');
  if(ctr){var hasFilter=search||activeClientFilter||activeServerFilter!=='all'||activeStatusFilter!=='all';ctr.style.display=hasFilter?'':'none';if(hasFilter)ctr.textContent='Найдено: '+totalFiltered+' из '+totalAll}
  var sortFn=function(a,b){var va=getSortValue(a,sortCol),vb=getSortValue(b,sortCol);if(va==null)va='';if(vb==null)vb='';var cmp=typeof va==='number'&&typeof vb==='number'?va-vb:String(va).localeCompare(String(vb));return sortDir==='asc'?cmp:-cmp};for(var g in groups)groups[g].sort(sortFn);if(window._modemsView==='grid'){wrap.innerHTML=renderModemGrid(groups);return;}
  // ── Single combined table — one <thead> at the top, server divider rows
  // (with colspan) replace the old per-server header bar + repeated thead.
  // Saves one row per server group versus the old multi-table layout.
  var colCount=cols.length;
  var html='<table><thead><tr>';
  cols.forEach(function(col){var w=col.width?' style="width:'+col.width+'"':'';var ar=col.sortable&&sortCol===col.id?' '+(sortDir==='asc'?'\u25B2':'\u25BC'):'';var cl=col.sortable?' onclick="setSort(\''+col.id+'\')"':'';html+='<th'+w+cl+'>'+col.label+ar+'</th>'});
  html+='</tr></thead><tbody>';
  COUNTRY_ORDER.forEach(function(srv){var modems=groups[srv];if(!modems||!modems.length)return;var ci=COUNTRIES[srv]||{};var online=0;modems.forEach(function(m){var s=getModemStatus(m);if(s==='online'||s==='rotating')online++});
    // Server section divider (spans all columns) — replaces both the country-
    // group header and the per-server bar/thead from the old layout.
    html+='<tr class="server-divider"><td colspan="'+colCount+'" style="padding:6px 14px;background:var(--bg-2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">';
    html+='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">';
    // Per-server bulk-select. Toggling this checkbox selects/deselects all
    // visible modems on this server. updateBulkPanel() syncs its tri-state
    // (checked / unchecked / indeterminate) when individual rows change.
    html+='<input type="checkbox" class="srv-bulk-chk" data-server="'+esc(srv)+'" onchange="bulkToggleServer(\''+esc(srv)+'\',this)" style="cursor:pointer;margin:0" title="Выбрать все модемы '+esc(srv)+'">';
    html+='<span style="font-size:14px">'+(ci.flag||'')+'</span>';
    html+='<span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--accent)">'+esc(srv)+'</span>';
    if(ci.name)html+='<span style="font-size:11px;color:var(--text-2)">'+esc(ci.name)+'</span>';
    if(ci.address)html+='<span style="font-size:11px;color:var(--text-2)">\u{1F4CD} '+esc(ci.address)+'</span>';
    html+=(function(){var fb=(currentData.fleet&&currentData.fleet.byServer&&currentData.fleet.byServer[srv])||null;var fOn=fb?((fb.working!=null)?fb.working:fb.online):online;var fN=fb?fb.total:modems.length;if(fN<fOn)fN=fOn;return'<span style="font-size:11px;font-weight:600;color:'+(fOn>=fN?'var(--success)':'var(--warning)')+'" title="рабочих (онлайн + блип <10 мин) / активных в парке. Падает только при реальном отключении >10 мин">'+fOn+'/'+fN+' в работе</span>';})();
    html+=_serverDownBadge(srv);
    html+='<div style="margin-left:auto;display:flex;gap:6px"><button class="srv-act" onclick="resetCompleteServer(\''+srv+'\')">↻ Сброс IP</button><button class="srv-act srv-act-danger" onclick="rebootServer(\''+srv+'\')">⏻ Ребут</button></div>';
    html+='</div></td></tr>';
    // Stage 18.7: within each server group, sort by ONLINE→OFFLINE,
    // Stage 18.19: only LONG-offline modems sink to the bottom. A modem that
    // just went offline still belongs with its peers — the operator is
    // actively triaging it, so it should stay where it normally sorts.
    // ≥window._staleModemHours (default 12 h) offline = «снят с учёта», same
    // threshold the backend uses to drop modems from latency_stats /
    // modem_health (see getStaleNicks in server.js). Modems that have never
    // been online (no lastSeenMs) count as stale too — matches backend.
    //
    // V8 sort is stable since 2018, so the second-pass sort below preserves
    // the user's chosen sortCol within each tier (it was already applied via
    // sortFn just above). For the stale block we still want recent-died at
    // the top of the bottom group — easier to find a freshly-stalled modem.
    var _staleHrs = Number(window._staleModemHours) || 12;
    var _staleCutoffMs = Date.now() - _staleHrs * 3600 * 1000;
    function _isStale(m){
      if(getModemStatus(m) !== 'offline') return false;
      var ms = Number(m.lastSeenMs) || 0;
      if(!ms) return true;                                       // never online
      return ms < _staleCutoffMs;                                // offline ≥ N h
    }
    modems.sort(function(a,b){
      var oa = _isStale(a)?1:0, ob = _isStale(b)?1:0;
      if(oa !== ob) return oa - ob;                              // stale block last
      if(oa === 1){                                              // both stale
        var ta = Number(a.lastSeenMs)||0, tb = Number(b.lastSeenMs)||0;
        return tb - ta;                                          // recent-died first
      }
      return 0;                                                  // live + recent-offline → preserve sortFn order
    });
    modems.forEach(function(modem){var status=getModemStatus(modem),port=modem.ports[0]||{},bw=port._bw||{},ci=COUNTRIES[modem.server]||{};var isSel=!!(window._bulkSel&&window._bulkSel[modem.rawImei]);var h='<tr class="modem-row" data-nick="'+esc(modem.nick)+'" data-server="'+modem.server+'" onclick="rowOpen(event,this)" style="cursor:pointer">';cols.forEach(function(col){var _dl=(col.label||'').replace(/<[^>]*>/g,'').replace(/"/g,'').trim();h+='<td class="cell-'+col.id+'" data-label="'+_dl+'"'+(col.id==='rail'?' style="padding:0;text-align:center"':'')+'>';switch(col.id){case'rail':{var _ar=_attnReason(modem);var _rc=_ar?((_ar.kind==='offline'&&_ar.stale)?'var(--text-3)':(_mkColor[_ar.kind]||'var(--warning)')):null;h+=_rc?'<span class="mk-row-rail" style="background:'+_rc+'"></span>':'';break;}case'bulk':h+='<input type="checkbox" class="bulk-chk" data-imei="'+modem.rawImei+'" data-server="'+modem.server+'" data-nick="'+esc(modem.nick)+'" '+(isSel?'checked':'')+' onchange="updateBulkPanel()" style="cursor:pointer;margin:0">';break;case'status':h+=_statusPill(status,modem);break;case'nick':h+='<strong>'+esc(modem.nick)+'</strong>'+_excludeChip(modem)+_modemFlags(modem);break;case'server':h+='<span style="font-size:10px">'+(ci.flag||'')+' '+modem.server+'</span>';break;case'portName':{var un=modem.ports.map(function(p){return p.portName}).filter(function(v,i,a){return v&&a.indexOf(v)===i});var _on='openDetailAtTab(\''+esc(modem.nick)+'\',\''+modem.server+'\',\'settings\')';if(!un.length){h+='<button class="btn btn-sm" style="font-size:10px;padding:2px 7px" onclick="'+_on+'">+ Порт</button>'}else{h+=un.slice(0,2).map(function(n){return'<span class="port-badge" style="background:var(--bg-3);color:var(--accent);padding:1px 8px;border-radius:20px;font-size:10px;border:1px solid var(--border);cursor:pointer" onclick="'+_on+'" title="Настройки порта">'+esc(n)+'</span>'}).join(' ');if(un.length>2)h+=' <span class="port-badge" title="'+esc(un.slice(2).join(', '))+'" style="background:var(--accent-dim);color:var(--accent);padding:1px 6px;border-radius:20px;font-size:10px;cursor:pointer" onclick="'+_on+'">+'+(un.length-2)+'</span>';h+=' <button class="btn btn-sm" style="font-size:10px;padding:2px 7px;opacity:0.5" onclick="'+_on+'" title="Добавить порт">+</button>'}break;}case'creds':{var sip=ci.serverIp||'';var _hasPort=false;modem.ports.forEach(function(p){if(!p.HTTP_PORT&&!p.SOCKS_PORT)return;_hasPort=true;var _pport=p.HTTP_PORT||p.SOCKS_PORT;var _auth=p.LOGIN?':'+esc(p.LOGIN)+':'+esc(p.PASSWORD||''):'';if(modem.ports.length>1&&(p.portName||p.portID))h+='<div style="font-size:9px;color:var(--accent);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.portName||p.portID||'')+'</div>';h+='<div style="display:flex;align-items:center;gap:4px"><span class="mono" style="font-size:10px">'+sip+':'+_pport+'</span><button class="copy-btn" title="Копировать ip:port:login:pass" onclick="copyText(\''+sip+':'+_pport+_auth+'\',this)">\u{1F4CB}</button></div>'});if(!_hasPort)h+='-';break;}case'loginpass':{var _hasLogin=false;modem.ports.forEach(function(p){if(!p.LOGIN)return;_hasLogin=true;if(modem.ports.length>1&&(p.portName||p.portID))h+='<div style="font-size:9px;color:var(--accent);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.portName||p.portID||'')+'</div>';h+='<div><span class="mono">'+esc(p.LOGIN)+':••••</span> <button class="copy-btn" onclick="copyText(\''+esc(p.LOGIN)+':'+esc(p.PASSWORD||'')+'\',this)">\u{1F4CB}</button></div>'});if(!_hasLogin)h+='-';break;}case'extIp':if(modem.extIp==='IP_RESET'||modem.isRotating){h+='<span class="mono" style="color:var(--warning)">Ротация</span>'}else if(modem.extIp){h+='<span class="mono'+(modem.ipStuck?' ip-stuck':'')+'">'+modem.extIp+(modem.ipStuck?'<span class="ip-stuck-badge" title="IP не менялся '+modem.ipSinceHours+'ч"> '+modem.ipSinceHours+'ч</span>':'')+'</span>'}else{h+='-'}break;case'netType':{var _op=modem.operator?esc(modem.operator):'<span style="color:var(--text-3)">—</span>';var _nt=(modem.netType||'').toString().toUpperCase();var _ntc=/3G|HSPA|UMTS/.test(_nt)?'var(--warning)':(/2G|GPRS|EDGE/.test(_nt)?'var(--danger)':'var(--text-3)');var _nth=_nt?'<span style="font-size:9px;font-weight:600;color:'+_ntc+'">'+esc(_nt)+'</span>':'';h+='<div style="display:flex;align-items:center;gap:7px"><span style="font-size:12px;color:var(--text-1)">'+_op+'</span>'+_nth+renderSignalBars(modem.signal)+'</div>';break;}case'signal':h+=renderSignalBars(modem.signal);break;case'operator':h+=esc(modem.operator)||'-';break;case'phone':h+=modem.phone?'<span class="mono">'+esc(modem.phone)+'</span>':'-';break;case'trafficDay':{var _dinSum=0,_doutSum=0;modem.ports.forEach(function(p){var _pb=p._bw||{};_dinSum+=parseTraffic(_pb.bandwidth_bytes_day_in);_doutSum+=parseTraffic(_pb.bandwidth_bytes_day_out)});h+='<span class="mono">'+fmtGb(_dinSum+_doutSum)+'</span>';break;}case'trafficMon':{var _minSum=0,_moutSum=0;modem.ports.forEach(function(p){var _pb=p._bw||{};_minSum+=parseTraffic(_pb.bandwidth_bytes_month_in);_moutSum+=parseTraffic(_pb.bandwidth_bytes_month_out)});h+='<span class="mono">'+fmtGb(_minSum+_moutSum)+'</span>';break;}case'speed':{var _dl=Number(modem.lastSpeedDl||0),_ul=Number(modem.lastSpeedUl||0);if(_dl||_ul){var _isLow=_dl<_minSpeedThreshold||_ul<_minSpeedThreshold;var _spDateMs=modem.lastSpeedDate?Date.parse(modem.lastSpeedDate):0;var _ageH=_spDateMs?Math.floor((Date.now()-_spDateMs)/3600000):null;var _STALE_H=48;if(_ageH!==null&&_ageH>_STALE_H){var _ageLbl=_ageH<48?_ageH+'\u0447 \u043D\u0430\u0437\u0430\u0434':Math.floor(_ageH/24)+'\u0434 \u043D\u0430\u0437\u0430\u0434';h+='<span class="speed-cell" title="\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u0437\u0430\u043C\u0435\u0440: '+(_ageLbl)+' \u00B7 '+esc(modem.lastSpeedDate||'')+'\\n\u2193'+_dl.toFixed(1)+' / \u2191'+_ul.toFixed(1)+' Mbps" style="color:var(--text-3);font-size:11px;cursor:help">\u2014 <span style="font-size:9px">('+_ageLbl+')</span></span>'}else{h+='<span class="speed-cell" title="\u0417\u0430\u043C\u0435\u0440: '+esc(modem.lastSpeedDate||'')+'" style="'+(_isLow?'background:rgba(255,56,60,.15);border-radius:4px;padding:2px 4px':'')+'"><span class="speed-dl">\u2193'+_dl.toFixed(1)+'</span> / <span class="speed-ul">\u2191'+_ul.toFixed(1)+'</span>'+(_isLow?' \u26A0':'')+'</span>'}}else{h+='-'}break;}case'uptime':if(modem.uptimePct!==undefined){var upCls=parseFloat(modem.uptimePct)>=99?'good':parseFloat(modem.uptimePct)>=95?'warn':'bad';h+='<span class="uptime-pct '+upCls+'">'+modem.uptimePct+'%</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;case'latency':{var lms=modem.pcLastMs;if(lms!==null&&lms!==undefined&&!modem.pcLastError){var lCls=lms>_pcBadMs?'pc-bad':lms>_pcWarnMs?'pc-warn':'pc-good';h+='<span class="pc-lat '+lCls+'" title="Connect: '+(modem.pcLastMs!=null?fmtMs(modem.pcLastMs):'?')+'">'+fmtMs(lms)+'</span>'}else if(modem.pcLastError){h+='<span class="pc-lat pc-bad" title="'+esc(modem.pcLastError)+'">err</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;}case'conns':{var _ct=0,_cparts=[];modem.ports.forEach(function(p){var cs=p.conns_stats;if(!cs)return;var t=Number(cs.total)||0;_ct+=t;if(t>0)_cparts.push((p.portName||p.portID||'порт')+': '+t+' (http '+(Number(cs.http)||0)+' · socks '+(Number(cs.socks5)||0)+')');});var _con='openDetailAtTab(\''+esc(modem.nick).replace(/'/g,"\\'")+'\',\''+modem.server+'\',\'settings\')';var _cc=_ct>0?_connColor(_ct):'var(--text-3)';
// спарклайн: история за последний час из connsHistory (общий помощник, что и в «Сетке»)
var _sp=_connsSpark(modem);var _spark=_sp.svg;var _hmax=_sp.hmax;
h+='<span onclick="event.stopPropagation();'+_con+'" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px" title="'+esc(_cparts.join('\n')||'нет активных подключений')+(_spark?'&#10;за час: макс '+_hmax:'')+'&#10;клик — лимиты порта">'+_spark+'<span class="mono" style="font-weight:'+(_ct>0?'600':'400')+';color:'+_cc+'">'+_ct+'</span></span>';break;}case'errors':{var ep=modem.pcErrorPct;if(ep!==null&&ep!==undefined){var eCls=ep>=_errorRateThreshold?'pc-bad':ep>0?'pc-warn':'pc-good';h+='<span class="pc-err '+eCls+'">'+ep+'%</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;}case'health':{var _hm=_getHealth(modem);if(_hm&&_hm.health_score!=null){var _hs=_hm.health_score;var _hCls=_hm.status==='good'?'pc-good':_hm.status==='warn'?'pc-warn':'pc-bad';h+='<span class="pc-err '+_hCls+'" title="P50 latency: '+(_hm.latency_ms||'?')+' мс, ошибки: '+(_hm.error_pct||0)+'%, аптайм: '+(_hm.uptime_pct||0)+'% · нажмите «Инфо» для подробностей" style="cursor:help;font-weight:600">'+_hs+'</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;}case'rotation':{var rotMin=parseInt(modem.autoRotation)||0;if(rotMin>0){var rotStr=rotMin>=60?(rotMin/60).toFixed(0)+'ч':rotMin+'м';h+='<span class="mono" style="font-size:11px">'+rotStr+'</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">Выкл</span>'}break;}case'band':h+=modem.band?'<span class="mono" style="font-size:11px">'+esc(modem.band)+'</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'simStatus':{var _ss=(modem.simStatus||'');if(!_ss||_ss==='UNKNOWN'){h+='<span style="color:var(--text-3);font-size:10px">—</span>'}else{var _ok=/\bOK\b|READY/.test(_ss);h+='<span class="pc-err '+(_ok?'pc-good':'pc-bad')+'" style="font-size:10px" title="'+esc(_ss)+'">'+esc(_ss)+'</span>'}break;}case'rebootScore':{var _rs=modem.rebootScore;if(_rs==null){h+='<span style="color:var(--text-3);font-size:10px">—</span>'}else{var _rc=_rs>=70?'pc-bad':_rs>=50?'pc-warn':'pc-good';h+='<span class="pc-err '+_rc+'" style="font-size:10px">'+_rs+'</span>'}break;}case'httpRedirect':h+=modem.httpRedirect?'<span class="pc-err pc-bad" style="font-size:10px" title="Оператор навязал редирект — SIM без денег/блок">редирект</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'isLocked':h+=modem.isLocked?'<span title="Модем занят операцией/ротацией">🔒</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'actions':{var d='data-imei="'+modem.rawImei+'" data-server="'+modem.server+'" data-nick="'+esc(modem.nick)+'"';h+='<div class="actions-cell" style="display:flex;gap:4px;align-items:center;justify-content:flex-end">'+(status!=='offline'?'<button class="row-act" '+d+' title="Сбросить IP" onclick="resetIp(this)">↻</button><button class="row-act" '+d+' title="Ребут модема" onclick="rebootModem(this)">⏻</button>':'')+'<button class="btn-details" '+d+' onclick="showDetails(this)"><svg width="12" height="12" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.1"/><line x1="4" y1="4.5" x2="9" y2="4.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4" y1="6.5" x2="9" y2="6.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4" y1="8.5" x2="7" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>Инфо</button>';
// Stage 18.1: inline delete button for offline modems — was previously
// hidden inside the Info-tab modal and easy to miss. Only renders for
// status==='offline' so live modems can't be killed accidentally.
if(_isStaleModem(modem)){var _pid='';if(modem.ports&&modem.ports[0]&&modem.ports[0].portID){_pid=modem.ports[0].portID.replace(/^S\d+_/,'');}
// Stage 18.1 fix: modems restored via Stage 18 (fallback from modem_meta) have
// no client-binding port — only a synthetic id. Fall back to "meta_<imei>" so
// the delete button still shows. Server-side recognizes the prefix and routes
// to the IMEI-based delete path.
if(!_pid&&modem.rawImei){_pid='meta_'+modem.rawImei;}
if(_pid){h+='<button class="btn-delete-modem" title="Удалить модем из дашборда" onclick="deleteModem(\''+modem.server+'\',\''+_pid+'\',\''+esc(modem.nick)+'\')">🗑</button>';}}
h+='</div>';break;}}h+='</td>'});html+=h+'</tr>'});
  });
  html+='</tbody></table>';
  wrap.innerHTML=html;
}
function setSort(c){if(sortCol===c)sortDir=sortDir==='asc'?'desc':'asc';else{sortCol=c;sortDir='asc'}renderTable()}
function getSortValue(m,col){var p=m.ports[0]||{},bw=p._bw||{};switch(col){case'nick':return m.nick;case'server':return m.server;case'portName':return m.ports.map(function(p){return p.portName||''}).join(',');case'creds':return parseInt(p.HTTP_PORT)||0;case'loginpass':return(p.LOGIN||'');case'netType':return m.operator||'';case'signal':return m.signal;case'operator':return m.operator;case'trafficDay':return m.ports.reduce(function(s,p){var _pb=p._bw||{};return s+parseTraffic(_pb.bandwidth_bytes_day_in)+parseTraffic(_pb.bandwidth_bytes_day_out)},0);case'trafficMon':return m.ports.reduce(function(s,p){var _pb=p._bw||{};return s+parseTraffic(_pb.bandwidth_bytes_month_in)+parseTraffic(_pb.bandwidth_bytes_month_out)},0);case'speed':return(m.lastSpeedDl||0)+(m.lastSpeedUl||0);case'uptime':return parseFloat(m.uptimePct)||m.uptime||0;case'latency':return m.pcLastMs||99999;case'errors':return m.pcErrorPct||0;case'conns':return m.ports.reduce(function(s,p){return s+((p.conns_stats&&Number(p.conns_stats.total))||0)},0);case'health':{var _hm=_getHealth(m);return _hm&&_hm.health_score!=null?_hm.health_score:-1;}case'rotation':return parseInt(m.autoRotation)||0;case'band':return m.band||'';case'simStatus':return m.simStatus||'';case'rebootScore':return m.rebootScore==null?-1:m.rebootScore;default:return''}}

// ========== PROXY CHECK LOG ==========
var _proxyLogCache={};
function toggleProxyLog(nick,server,el){
  var tr=el.closest('tr');if(!tr)return;
  var existing=tr.nextElementSibling;
  if(existing&&existing.classList.contains('pc-detail-row')){existing.remove();return}
  document.querySelectorAll('.pc-detail-row').forEach(function(r){r.remove()});
  var cKey=server+'_'+nick;
  var detailTr=document.createElement('tr');detailTr.className='pc-detail-row';
  var colSpan=COLUMNS.filter(function(c){return c.visible}).length;
  detailTr.innerHTML='<td colspan="'+colSpan+'" style="padding:0"><div class="pc-log-wrap"><div style="color:var(--text-3);font-size:11px;padding:8px 12px">Загрузка...</div></div></td>';
  tr.after(detailTr);
  if(_proxyLogCache[cKey]&&Date.now()-_proxyLogCache[cKey].ts<60000){
    renderProxyLog(detailTr,_proxyLogCache[cKey].data);return;
  }
  api(API+'/api/admin/proxy_checks?nick='+encodeURIComponent(nick)+'&days=7').then(function(data){
    _proxyLogCache[cKey]={data:data,ts:Date.now()};
    renderProxyLog(detailTr,data);
  }).catch(function(){detailTr.querySelector('.pc-log-wrap').innerHTML='<div style="color:var(--danger);padding:8px 12px;font-size:11px">Ошибка загрузки</div>'});
}
function renderProxyLog(detailTr,data){
  var checks=data.checks||[];
  if(!checks.length){detailTr.querySelector('.pc-log-wrap').innerHTML='<div style="color:var(--text-3);padding:8px 12px;font-size:11px">Нет данных за 7 дней</div>';return}
  var h='<table class="pc-log-table"><thead><tr><th>Время</th><th>Connect</th><th>Total</th><th>Статус</th><th>Ошибка</th></tr></thead><tbody>';
  checks.forEach(function(c){
    var hasErr=!!c.error;
    var cls=hasErr?'pc-row-err':'';
    var dt=fmtPcDate(c.checked_at);
    var conn=c.connect_ms!==null?c.connect_ms+'ms':'—';
    var total=c.total_ms!==null?c.total_ms+'ms':'—';
    var st=c.status_code||'—';
    var stCls=c.status_code===200?'pc-st-ok':c.status_code?'pc-st-warn':'';
    var err=c.error?esc(c.error):'—';
    h+='<tr class="'+cls+'"><td>'+dt+'</td><td>'+conn+'</td><td>'+total+'</td><td><span class="'+stCls+'">'+st+'</span></td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+err+'</td></tr>';
  });
  h+='</tbody></table>';
  detailTr.querySelector('.pc-log-wrap').innerHTML=h;
}
function fmtPcDate(iso){if(!iso)return'—';var d=new Date(iso);var dd=String(d.getDate()).padStart(2,'0'),mm=String(d.getMonth()+1).padStart(2,'0'),hh=String(d.getHours()).padStart(2,'0'),mi=String(d.getMinutes()).padStart(2,'0');return dd+'.'+mm+' '+hh+':'+mi}

// ========== PROXY CHECK IN INFO TAB ==========
var _pcChartInstance=null;
function runManualProxyCheck(nick,server){
  var btn=document.getElementById('infoProxyCheckBtn');
  var resEl=document.getElementById('proxyCheckResult');
  if(!btn||!resEl)return;
  btn.disabled=true;btn.textContent='Замер...';
  resEl.innerHTML='<div style="text-align:center;padding:12px"><div class="spinner" style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite"></div><span style="color:var(--text-2);font-size:11px;margin-left:8px">Проверка прокси...</span></div>';
  api(API+'/api/admin/proxy_check',{method:'POST',json:{nick:nick,server:server}})
  .then(function(d){
    btn.disabled=false;btn.textContent='Запустить замер';
    if(!d.ok||!d.checks||!d.checks.length){resEl.innerHTML='<div style="color:var(--danger);font-size:11px;padding:4px">'+esc(d.error||'Ошибка')+'</div>';return}
    var c=d.checks[0];
    if(c.error){
      resEl.innerHTML='<div style="display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;background:var(--red-bg);color:var(--red);margin-bottom:8px">Ошибка: '+esc(c.error)+'</div>';
    }else{
      var lCls=c.total_ms>_pcBadMs?'pc-bad':c.total_ms>_pcWarnMs?'pc-warn':'pc-good';
      resEl.innerHTML='<div style="display:flex;gap:12px;margin-bottom:8px">'
        +'<div style="text-align:center;padding:8px 14px;background:var(--bg-2);border-radius:8px"><div style="font-size:9px;color:var(--text-3);margin-bottom:2px">CONNECT</div><div style="font-size:18px;font-weight:700" class="'+lCls+'">'+(c.connect_ms||'—')+'<span style="font-size:10px">ms</span></div></div>'
        +'<div style="text-align:center;padding:8px 14px;background:var(--bg-2);border-radius:8px"><div style="font-size:9px;color:var(--text-3);margin-bottom:2px">TOTAL</div><div style="font-size:18px;font-weight:700" class="'+lCls+'">'+(c.total_ms||'—')+'<span style="font-size:10px">ms</span></div></div>'
        +'<div style="text-align:center;padding:8px 14px;background:var(--bg-2);border-radius:8px"><div style="font-size:9px;color:var(--text-3);margin-bottom:2px">STATUS</div><div style="font-size:18px;font-weight:700;color:var(--text-0)">'+(c.status_code||'—')+'</div></div>'
        +'</div>';
    }
    _proxyLogCache={};
    loadInfoProxyData(nick,server);
  }).catch(function(e){btn.disabled=false;btn.textContent='Запустить замер';resEl.innerHTML='<div style="color:var(--danger);font-size:11px">Ошибка сети</div>'});
}

function loadInfoProxyData(nick,server){
  api(API+'/api/admin/proxy_checks?nick='+encodeURIComponent(nick)+'&days=7')
  .then(function(data){
    var checks=data.checks||[];
    // Render chart
    var chartWrap=document.getElementById('proxyLatencyChart');
    if(chartWrap&&checks.length>=2){
      chartWrap.innerHTML='<canvas id="pcChartCanvas" height="160"></canvas>';
      var sorted=checks.slice().reverse();
      var labels=sorted.map(function(c){return fmtPcDate(c.checked_at)});
      var totalData=sorted.map(function(c){return c.total_ms||null});
      var connectData=sorted.map(function(c){return c.connect_ms||null});
      if(_pcChartInstance){_pcChartInstance.destroy();_pcChartInstance=null}
      var ctx=document.getElementById('pcChartCanvas').getContext('2d');
      _pcChartInstance=newChartSafe(ctx,{type:'line',data:{labels:labels,datasets:[
        {label:'Total ms',data:totalData,borderColor:'#185FA5',backgroundColor:'rgba(24,95,165,.1)',fill:true,tension:.3,pointRadius:2,borderWidth:2},
        {label:'Connect ms',data:connectData,borderColor:'#1D9E75',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:1.5,borderDash:[4,3]}
      ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{boxWidth:10,font:{size:10}}},tooltip:{callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y!==null?ctx.parsed.y+'ms':'—')}}}},scales:{x:{display:true,ticks:{font:{size:9},maxRotation:45,maxTicksLimit:12}},y:{display:true,beginAtZero:true,ticks:{font:{size:9},callback:function(v){return v+'ms'}}}}}});
    }else if(chartWrap){chartWrap.innerHTML=''}
    // Render history table
    var histWrap=document.getElementById('proxyCheckHistory');
    if(!histWrap)return;
    if(!checks.length){histWrap.innerHTML='<div style="color:var(--text-3);font-size:11px;padding:8px">Нет данных за 7 дней</div>';return}
    var h='<table class="pc-log-table"><thead><tr><th>Время</th><th>Connect</th><th>Total</th><th>Статус</th><th>Ошибка</th></tr></thead><tbody>';
    checks.slice(0,50).forEach(function(c){
      var hasErr=!!c.error;var cls=hasErr?'pc-row-err':'';
      var conn=c.connect_ms!==null?c.connect_ms+'ms':'—';
      var total=c.total_ms!==null?c.total_ms+'ms':'—';
      var st=c.status_code||'—';
      var stCls=c.status_code===200?'pc-st-ok':c.status_code?'pc-st-warn':'';
      var err=c.error?esc(c.error):'—';
      h+='<tr class="'+cls+'"><td>'+fmtPcDate(c.checked_at)+'</td><td>'+conn+'</td><td>'+total+'</td><td><span class="'+stCls+'">'+st+'</span></td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+err+'</td></tr>';
    });
    h+='</tbody></table>';
    histWrap.innerHTML=h;
  }).catch(function(){
    var histWrap=document.getElementById('proxyCheckHistory');
    if(histWrap)histWrap.innerHTML='<div style="color:var(--danger);font-size:11px;padding:8px">Ошибка загрузки</div>';
  });
}

// ========== ACTIONS ==========
function modemAction(btn,url,body,msg,delay){btn.classList.add('loading');btn.disabled=true;api(API+url,{method:'POST',json:body}).then(function(d){btn.classList.remove('loading');btn.disabled=false;if(d.ok)showToast(msg,'success');else showToast(d.error||'Ошибка','error');setTimeout(loadData,delay||3000)}).catch(function(){btn.classList.remove('loading');btn.disabled=false;showToast('Ошибка сети','error')})}
// In-page confirm/prompt. Native confirm()/prompt() get permanently muted once
// the user ticks «не показывать диалоги» → they silently return null/false and
// every action (incl. the reboot password) breaks. These custom modals aren't
// subject to that browser suppression.
function uiDialog(o){return new Promise(function(resolve){var prev=document.getElementById('uiDlg');if(prev)prev.remove();var ov=document.createElement('div');ov.id='uiDlg';ov.className='ui-dlg-ov';ov.tabIndex=-1;var inp=o.input?'<input id="uiDlgInput" class="ui-dlg-input" type="'+(o.password?'password':'text')+'" autocomplete="off"'+(o.placeholder?' placeholder="'+esc(o.placeholder)+'"':'')+'>':'';ov.innerHTML='<div class="ui-dlg">'+(o.title?'<div class="ui-dlg-title">'+esc(o.title)+'</div>':'')+'<div class="ui-dlg-msg">'+String(o.message||'').split('\n').map(esc).join('<br>')+'</div>'+inp+'<div class="ui-dlg-btns"><button type="button" class="ui-dlg-btn" id="uiDlgC">Отмена</button><button type="button" class="ui-dlg-btn '+(o.danger?'ui-dlg-danger':'ui-dlg-ok')+'" id="uiDlgK">'+esc(o.okText||'OK')+'</button></div></div>';document.body.appendChild(ov);var f=document.getElementById('uiDlgInput');setTimeout(function(){(f||ov).focus()},30);var settled=false;function done(v){if(settled)return;settled=true;ov.remove();resolve(v)}document.getElementById('uiDlgC').onclick=function(){done(o.input?null:false)};document.getElementById('uiDlgK').onclick=function(){done(o.input?(f?f.value:''):true)};ov.addEventListener('mousedown',function(e){if(e.target===ov)done(o.input?null:false)});ov.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();done(o.input?(f?f.value:''):true)}else if(e.key==='Escape'){e.preventDefault();done(o.input?null:false)}})})}
function uiConfirm(msg,o){o=o||{};return uiDialog({title:o.title||'Подтверждение',message:msg,okText:o.okText||'Да',danger:o.danger})}
function uiPrompt(msg,o){o=o||{};return uiDialog({title:o.title||'',message:msg,input:true,password:o.password,placeholder:o.placeholder,okText:o.okText||'OK',danger:o.danger})}
function rebootServer(srv){uiPrompt('Перезагрузить сервер '+srv+'?\nВсе модемы будут недоступны на время перезагрузки.\n\nВведите пароль для подтверждения:',{title:'Ребут сервера '+srv,password:true,okText:'Перезагрузить',danger:true}).then(function(pwd){if(!pwd)return;showToast('Перезагрузка сервера '+srv+'…','info');api(API+'/api/admin/reboot_server',{method:'POST',json:{serverName:srv,password:pwd}}).then(function(r){r.ok?showToast('Сервер '+srv+' перезагружается','success'):showToast(r.error||'Ошибка','error')}).catch(function(){showToast('Ошибка сети','error')})})}
function resetCompleteServer(srv){uiPrompt('Сбросить IP на ВСЕХ модемах сервера '+srv+'?\n\nВведите пароль для подтверждения:',{title:'Сброс IP · '+srv,password:true,okText:'Сбросить',danger:true}).then(function(pwd){if(!pwd)return;showToast('Сброс IP всех модемов '+srv+'...','info');api(API+'/api/admin/reset_complete',{method:'POST',json:{serverName:srv,password:pwd}}).then(function(r){r.ok?showToast('Сброшено '+r.reset+'/'+r.total+' модемов','success'):showToast(r.error||'Ошибка','error');setTimeout(loadData,5000)}).catch(function(){showToast('Ошибка сети','error')})})}
function resetIp(b){uiConfirm('Сбросить IP '+b.dataset.nick+'?').then(function(ok){if(ok)modemAction(b,'/api/admin/reset_ip',{imei:b.dataset.imei,serverName:b.dataset.server},'IP сброшен',3000)})}
function rebootModem(b){uiConfirm('Ребут '+b.dataset.nick+'?',{okText:'Ребут'}).then(function(ok){if(ok)modemAction(b,'/api/admin/reboot',{imei:b.dataset.imei,serverName:b.dataset.server},'Ребут запущен',5000)})}
function usbReset(b){uiConfirm('USB-ресет '+b.dataset.nick+'?',{okText:'USB-ресет'}).then(function(ok){if(ok)modemAction(b,'/api/admin/usb_reset',{nick:b.dataset.nick,serverName:b.dataset.server},'USB ресет',10000)})}
function reconnectAll(srv){uiConfirm('Переподключить отвалившиеся модемы на '+srv+'?\n\nRe-Add всех офлайн-модемов сервера. Рабочие модемы не трогаются.',{title:'Переподключить модемы · '+srv,okText:'Переподключить'}).then(function(ok){if(!ok)return;showToast('Переподключение модемов '+srv+'…','info');api(API+'/api/admin/reconnect_all',{method:'POST',json:{serverName:srv}}).then(function(r){r.ok?showToast('Переподключено '+r.reconnected+'/'+r.total+' офлайн-модемов на '+srv,'success',7000):showToast(r.error||'Ошибка','error');setTimeout(loadData,8000)}).catch(function(){showToast('Ошибка сети','error')})})}
function readdModem(b){uiConfirm('Re-Add (переподключить) модем '+b.dataset.nick+'?',{okText:'Re-Add'}).then(function(ok){if(!ok)return;b.classList.add('loading');b.disabled=true;api(API+'/api/admin/readd_modem',{method:'POST',json:{nick:b.dataset.nick,serverName:b.dataset.server}}).then(function(d){b.classList.remove('loading');b.disabled=false;if(d.ok){showToast('Re-Add '+b.dataset.nick+': '+(d.message||d.result||'OK'),'success',7000);setTimeout(loadData,8000)}else showToast(d.error||'Ошибка','error')}).catch(function(){b.classList.remove('loading');b.disabled=false;showToast('Ошибка сети','error')})})}

// ========== DETAIL MODAL ==========
var currentDetailModem=null;
function showDetails(btn){var nick=btn.dataset.nick,server=btn.dataset.server,map=currentData&&currentData._modemMap;if(!map)return;for(var imei in map){var m=map[imei];if(m.nick===nick&&m.server===server){currentDetailModem=m;break}}if(!currentDetailModem)return;document.getElementById('modalTitle').textContent=nick+' ('+server+')';switchTab('info',document.querySelector('.modal-tab[data-tab="info"]'));document.getElementById('detailModal').classList.add('show')}
function openDetailAtTab(nick,srv,tab){var map=currentData&&currentData._modemMap;if(!map)return;currentDetailModem=null;for(var imei in map){var m=map[imei];if(m.nick===nick&&m.server===srv){currentDetailModem=m;break}}if(!currentDetailModem)return;document.getElementById('modalTitle').textContent=nick+' ('+srv+')';var tabEl=document.querySelector('.modal-tab[data-tab="'+tab+'"]');switchTab(tab,tabEl);document.getElementById('detailModal').classList.add('show')}
function rowOpen(e,tr){if(e.target.closest('button,input,a,select,.copy-btn,.port-badge,.bulk-chk,.actions-cell'))return;openDetailAtTab(tr.dataset.nick,tr.dataset.server,'info')}
function closeModal(){document.getElementById('detailModal').classList.remove('show');currentDetailModem=null}
document.getElementById('detailModal').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeModal();closeClientModal()}});
function switchTab(tab,el){document.querySelectorAll('#modalTabs .modal-tab').forEach(function(t){t.classList.remove('active')});if(el)el.classList.add('active');renderTabContent(tab)}

// Detail-modal "Здоровье" tab. Shows score + per-factor breakdown.
// Re-fetches modem_health for the current modem so the data is fresh
// (cache may be up to 5min old).
function renderHealthTab(body, m){
  body.innerHTML = '<div style="color:var(--text-3);padding:24px;text-align:center">Загрузка данных о здоровье…</div>';
  api(API + '/api/analytics/modem_health?days=7')
    .then(function(d){
      if (!d || !d.modems) { body.innerHTML = '<div style="color:var(--danger);padding:24px">Не удалось загрузить данные.</div>'; return }
      var entry = d.modems.find(function(x){ return x.server_name === m.server && x.nick === m.nick });
      if (!entry) { body.innerHTML = '<div style="color:var(--text-3);padding:24px;text-align:center">Нет данных о здоровье этого модема за последние 7 дней.<br><small>Возможно, модем был добавлен недавно или не выполнял проверки.</small></div>'; return }
      // Refresh global cache while we're here
      if (!window._healthMap) window._healthMap = {};
      window._healthMap[entry.server_name + '|' + entry.nick] = entry;

      var statusColors = { good: 'var(--success,#0a8)', warn: 'var(--warning,#e88)', bad: 'var(--danger,#d33)', unknown: 'var(--text-3,#999)' };
      var scoreColor = statusColors[entry.status] || statusColors.unknown;
      var scoreLabel = entry.status === 'good' ? 'Хорошо' : entry.status === 'warn' ? 'Предупреждение' : 'Проблемы';

      var html = '';
      // Big score card
      html += '<div style="display:flex;gap:20px;align-items:center;background:var(--bg-1);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:18px">';
      html += '<div style="font-size:48px;font-weight:700;color:'+scoreColor+';line-height:1;min-width:90px;text-align:center">'+entry.health_score+'<div style="font-size:11px;font-weight:500;color:var(--text-2);margin-top:6px;text-transform:uppercase;letter-spacing:.05em">из 100</div></div>';
      html += '<div style="flex:1">';
      html += '<div style="font-size:18px;font-weight:600;color:'+scoreColor+';margin-bottom:6px">'+scoreLabel+'</div>';
      html += '<div style="font-size:12px;color:var(--text-2);line-height:1.5">Скор рассчитывается за последние 7 дней по трём метрикам с разными весами. Подробности по каждому фактору — ниже.</div>';
      html += '<div style="font-size:11px;color:var(--text-3);margin-top:8px">Период: '+(d.days||7)+' дней · Proxy-проверок: '+(entry.total_checks||0)+' · Пингов: '+(entry.uptime_online_checks||0)+'/'+(entry.uptime_total_checks||0)+'</div>';
      html += '</div></div>';

      // Stage 17: 30-day health timeline strip rendered after the big card.
      // Container is filled async by renderHealthDailyTimeline below — keeping
      // it inline so the rest of the existing layout stays untouched.
      html += '<div id="healthDailyTimeline" style="margin-bottom:18px"></div>';

      // Breakdown rows
      html += '<div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;font-weight:600">Разложение скора</div>';
      var rows = entry.breakdown || [];
      rows.forEach(function(f){
        var col = statusColors[f.status] || statusColors.unknown;
        var valStr = f.value == null ? '—' : (f.value + (f.unit ? ' '+f.unit : ''));
        var impactStr = f.impact === 0 ? '<span style="color:var(--text-3)">не влияет</span>' :
                        f.impact > 0 ? '<span style="color:var(--success,#0a8)">+'+f.impact+'</span>' :
                                       '<span style="color:var(--danger,#d33);font-weight:600">'+f.impact+'</span>';
        html += '<div style="background:var(--bg-1);border:1px solid var(--border);border-left:3px solid '+col+';border-radius:8px;padding:12px 14px;margin-bottom:8px">';
        html += '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px">';
        html += '<div style="display:flex;align-items:baseline;gap:10px">';
        html += '<span style="font-size:14px;font-weight:600;color:var(--text-0)">'+esc(f.label)+'</span>';
        html += '<span style="font-size:16px;font-weight:700;color:'+col+'">'+esc(valStr)+'</span>';
        html += '</div>';
        html += '<div style="font-size:13px;font-weight:600">Влияние: '+impactStr+'</div>';
        html += '</div>';
        html += '<div style="font-size:11px;color:var(--text-2);line-height:1.5">';
        html += '<b>Норма:</b> '+esc(f.norm||'—');
        if (f.warn_at) html += ' · <b>Внимание:</b> '+esc(f.warn_at);
        if (f.bad_at) html += ' · <b>Плохо:</b> '+esc(f.bad_at);
        html += '</div>';
        if (f.impact_explain) html += '<div style="font-size:11px;color:var(--text-3);margin-top:4px;font-style:italic">'+esc(f.impact_explain)+'</div>';
        html += '</div>';
      });

      // Formula footnote
      html += '<div style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-top:14px;font-size:11px;color:var(--text-2);line-height:1.6">';
      html += '<b>Как считается:</b> Базовый скор = 100. Вычитаются баллы за ошибки (× 2, max 60). Затем умножается на 0.7, если латентность превышает порог. Затем умножается на долю активных часов из ожидаемых. Дополнительные метрики (ротации, проверки) — справочные.';
      html += '</div>';

      body.innerHTML = html;
      // Stage 17: fill the 30-day timeline strip after the main render so the
      // user sees the big card immediately while the history loads.
      renderHealthDailyTimeline(m);
    })
    .catch(function(e){ body.innerHTML = '<div style="color:var(--danger);padding:24px">Ошибка: '+esc(e.message)+'</div>'; });
}
function dr(l,v){return'<div class="detail-row"><span class="detail-label">'+l+'</span><span class="detail-value">'+esc(String(v||'-'))+'</span></div>'}

// ===== Modem detail modal — redesigned «Обзор» + consolidated tabs (5) =====
function _ovKpiCard(label,val,sub,col){return '<div style="position:relative;background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:11px;overflow:hidden"><div style="position:absolute;top:0;left:0;right:0;height:3px;background:'+(col||'var(--accent)')+'"></div><div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">'+label+'</div><div style="font-size:21px;font-weight:700;color:var(--text-0);line-height:1.1">'+val+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px">'+(sub||'')+'</div></div>';}
function _ovRow(l,v){return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;gap:8px"><span style="font-size:11px;color:var(--text-2);white-space:nowrap">'+l+'</span><span style="font-size:10px;color:var(--text-0);font-family:var(--font-mono);text-align:right;overflow:hidden;text-overflow:ellipsis">'+v+'</span></div>';}
function _ovChip(txt,col,bg){return '<span style="font-size:11px;color:'+(col||'var(--text-1)')+';background:'+(bg||'var(--bg-2)')+';border:1px solid var(--border);padding:3px 9px;border-radius:20px;white-space:nowrap">'+txt+'</span>';}
function _ovActBtn(inner,attrs,onclick){return '<button '+(attrs||'')+' onclick="'+onclick+'" style="flex:1 1 110px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;color:var(--text-1);font-size:12px;cursor:pointer">'+inner+'</button>';}
function _ovCredStr(m,ci){var sip=ci.serverIp||'';var p=(m.ports||[])[0];if(!p)return '';var pp=p.HTTP_PORT||p.SOCKS_PORT;if(!pp)return '';return sip+':'+pp+(p.LOGIN?':'+p.LOGIN+':'+(p.PASSWORD||''):'');}

function _renderOverview(body,m){
  var ci=COUNTRIES[m.server]||{};
  var st=(typeof getModemStatus==='function')?getModemStatus(m):'';
  var att=(typeof _attnReason==='function')?_attnReason(m):null;
  var bBg,bBd,bCol,bIcon,bTxt;
  if(att){var _d=(att.sev||3)>=4;bCol=_d?'var(--danger)':'var(--warning)';bBg=_d?'rgba(255,56,60,0.08)':'rgba(255,204,0,0.10)';bBd=_d?'rgba(255,56,60,0.25)':'rgba(255,204,0,0.28)';bIcon=_d?'⛔':'⚠';bTxt=att.reason;}
  else if(st==='rotating'){bCol='var(--accent)';bBg='var(--accent-dim)';bBd='var(--border)';bIcon='↻';bTxt='Смена IP…';}
  else if(st==='rebooting'){bCol='var(--accent)';bBg='var(--accent-dim)';bBd='var(--border)';bIcon='⏻';bTxt='Перезагрузка…';}
  else {bCol='var(--success)';bBg='rgba(52,199,89,0.09)';bBd='rgba(52,199,89,0.25)';bIcon='✓';bTxt='Онлайн — активных проблем нет';}
  var banner='<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:'+bBg+';border:1px solid '+bBd+';border-radius:10px;margin-bottom:12px"><span style="font-size:15px;color:'+bCol+'">'+bIcon+'</span><span style="font-size:13px;color:'+bCol+';font-weight:500">'+esc(bTxt)+'</span></div>';

  var clients=(typeof _modemClients==='function')?_modemClients(m):[];
  var rentTxt,rentCol='var(--text-2)';
  if(typeof _hasActiveClient==='function'&&!_hasActiveClient(m)){rentTxt=(typeof _allClientsExpired==='function'&&_allClientsExpired(m))?'Оплата истекла':'Свободен';rentCol='var(--text-3)';}
  else {rentTxt='В работе';var _near=null;(m.ports||[]).forEach(function(p){var vb=p.PROXY_VALID_BEFORE;if(!vb)return;var t=Date.parse(String(vb).replace(' ','T'));if(!isNaN(t)&&(_near===null||t<_near))_near=t;});if(_near){var _dl=Math.ceil((_near-Date.now())/86400000);if(_dl<0){rentTxt='Аренда истекла';rentCol='var(--danger)';}else{rentTxt='В работе · истекает через '+_dl+' дн';if(_dl<=3)rentCol='var(--warning)';}}}

  var chips='';
  if(m.operator)chips+=_ovChip(esc(m.operator));
  var _nt=(m.netType||'').toUpperCase();var _ntc=/3G|HSPA|UMTS/.test(_nt)?'var(--warning)':(/2G|GPRS|EDGE/.test(_nt)?'var(--danger)':'var(--success)');
  if(_nt)chips+=_ovChip(esc(_nt)+(m.band?' · '+esc(m.band):''),_ntc,'transparent');
  if(m.model)chips+=_ovChip(esc(m.model));
  chips+=_ovChip('IMEI …'+String(m.rawImei||'').slice(-6),'var(--text-2)');
  clients.forEach(function(c){chips+=_ovChip('👤 '+esc(c),'var(--accent)','var(--accent-dim)');});
  chips+=_ovChip(rentTxt,rentCol);
  var chipsWrap='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:13px">'+chips+'</div>';

  var d='data-imei="'+m.rawImei+'" data-server="'+m.server+'" data-nick="'+esc(m.nick)+'"';
  var _cred=_ovCredStr(m,ci);
  var acts='<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">';
  if(st!=='offline'){acts+=_ovActBtn('<span style="color:var(--accent)">↻</span> Сбросить IP',d,'resetIp(this)');acts+=_ovActBtn('<span style="color:var(--warning)">⏻</span> Ребут',d,'rebootModem(this)');}
  acts+=_ovActBtn('<span style="color:var(--text-2)">⟳</span> Re-Add',d,'readdModem(this)');
  if(_cred)acts+=_ovActBtn('<span style="color:var(--text-2)">📋</span> Доступ','',"copyText('"+_cred+"',this)");
  acts+=_ovActBtn('<span style="color:var(--text-2)">⚙</span> Настройки','',"document.querySelector('.modal-tab[data-tab=&quot;settings&quot;]').click()");
  acts+='</div>';

  var hm=(typeof _getHealth==='function')?_getHealth(m):null;
  var _kc=function(s){return s==='good'?'var(--success)':s==='warn'?'var(--warning)':s==='bad'?'var(--danger)':'var(--text-3)';};
  var kHealth=_ovKpiCard('Здоровье',(hm&&hm.health_score!=null)?String(hm.health_score):'—',hm?(hm.status==='good'?'хорошо':hm.status==='warn'?'внимание':'проблемы'):'нет данных',hm?_kc(hm.status):'var(--text-3)');
  var _up=m.uptimePct;var kUp=_ovKpiCard('Аптайм 7д',_up!=null?_up+'%':'—',(hm&&hm.uptime_online_checks!=null)?(hm.uptime_online_checks+'/'+hm.uptime_total_checks):'пинги',_up!=null?(parseFloat(_up)>=99?'var(--success)':parseFloat(_up)>=95?'var(--warning)':'var(--danger)'):'var(--text-3)');
  var kLat,_lms=m.pcLastMs;
  if(m.pcLastError){kLat=_ovKpiCard('Латентность','ошибка',esc(String(m.pcLastError).slice(0,18)),'var(--danger)');}
  else if(_lms!=null){kLat=_ovKpiCard('Латентность',fmtMs(_lms),m.pcAvgMs!=null?('ср. '+fmtMs(m.pcAvgMs)):'',_lms>_pcBadMs?'var(--danger)':_lms>_pcWarnMs?'var(--warning)':'var(--success)');}
  else {kLat=_ovKpiCard('Латентность','—','нет замеров','var(--text-3)');}
  var _ep=m.pcErrorPctToday;var kErr=_ovKpiCard('Ошибки сег.',_ep!=null?_ep+'%':'—',(m.pcChecksToday!=null)?((m.pcErrToday||0)+' / '+m.pcChecksToday):'нет проверок',_ep!=null?(_ep>=_errorRateThreshold?'var(--danger)':_ep>0?'var(--warning)':'var(--success)'):'var(--text-3)');
  var kpis='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr));gap:10px;margin-bottom:12px">'+kHealth+kUp+kLat+kErr+'</div>';

  var _simOk=/\bOK\b|READY/.test(m.simStatus||'');
  var _rs=m.rebootScore;var _rsc=_rs==null?'var(--text-0)':(_rs>=70?'var(--danger)':_rs>=50?'var(--warning)':'var(--text-0)');
  var net='<div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:14px">';
  net+='<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:9px">Сеть и сигнал</div>';
  net+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0"><span style="font-size:11px;color:var(--text-2)">Сигнал</span>'+((typeof renderSignalBars==='function')?renderSignalBars(m.signal):'<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-0)">'+(m.signal||0)+'/5</span>')+'</div>';
  net+=_ovRow('IP',m.extIp?('<span style="cursor:pointer" onclick="copyText(\''+esc(m.extIp)+'\',this)">'+esc(m.extIp)+' 📋</span>'+(m.ipStuck?' <span style="color:var(--warning)" title="IP не менялся '+m.ipSinceHours+'ч">⚠</span>':'')):'—');
  net+=_ovRow('Пинг / потери',(m.ping?esc(String(m.ping)):'—')+(m.pktLoss!=null?(' · '+m.pktLoss+'%'):''));
  net+=_ovRow('SIM','<span style="color:'+(_simOk?'var(--success)':'var(--danger)')+'">'+esc(m.simStatus||'—')+'</span>');
  net+=_ovRow('Reboot score','<span style="color:'+_rsc+'">'+(_rs!=null?_rs:'—')+'</span>');
  net+=_ovRow('Ротация',m.timeToRotation?esc(m.timeToRotation):(parseInt(m.autoRotation)>0?('каждые '+m.autoRotation+'м'):'выкл'));
  net+=_ovRow('APN',m.apn?esc(m.apn):'—');
  net+='</div>';

  var _ports=(m.ports&&m.ports.length)?m.ports:[];
  var conn='<div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:14px">';
  conn+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px"><span style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;font-weight:600">Подключение</span>'+(_cred?'<span style="font-size:10px;color:var(--accent);cursor:pointer" onclick="copyText(\''+_cred+'\',this)">📋 строка</span>':'')+'</div>';
  if(!_ports.length){conn+='<div style="font-size:11px;color:var(--text-3);padding:6px 0">Нет портов — модем свободен</div>';}
  _ports.forEach(function(port,pi){
    if(pi>0)conn+='<div style="height:1px;background:var(--border);margin:8px 0"></div>';
    var sip=ci.serverIp||'';
    if(_ports.length>1||port.portName)conn+='<div style="font-size:10px;font-weight:600;color:var(--accent);margin:2px 0 4px">'+esc(port.portName||('Порт '+(pi+1)))+'</div>';
    conn+=_ovRow('HTTP',port.HTTP_PORT?(sip+':'+port.HTTP_PORT):'—');
    conn+=_ovRow('SOCKS5',port.SOCKS_PORT?(sip+':'+port.SOCKS_PORT):'—');
    if(port.conns_stats){var _pcs=port.conns_stats;var _pct=Number(_pcs.total)||0;conn+=_ovRow('TCP-коннекты','<span style="font-family:var(--font-mono);font-weight:600;color:'+(_pct>0?_connColor(_pct):'var(--text-0)')+'">'+_pct+'</span> <span style="font-size:9px;color:var(--text-3)">http '+(Number(_pcs.http)||0)+' · socks '+(Number(_pcs.socks5)||0)+'</span>');}
    conn+=_ovRow('Логин',port.LOGIN?esc(port.LOGIN):'—');
    var _pid='ovPwd'+pi;
    conn+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0"><span style="font-size:11px;color:var(--text-2)">Пароль</span><span style="font-size:10px;color:var(--text-0);font-family:var(--font-mono)"><span id="'+_pid+'">'+(port.LOGIN?'••••••••':'—')+'</span>'+(port.LOGIN?' <span style="cursor:pointer;color:var(--text-2)" onclick="(function(){var v=document.getElementById(\''+_pid+'\');v.textContent=v.textContent===\'••••••••\'?\''+esc(port.PASSWORD||'')+'\':\'••••••••\'})()">👁</span> <span style="cursor:pointer;color:var(--text-2)" onclick="copyText(\''+esc(port.PASSWORD||'')+'\',this)">📋</span>':'')+'</span></div>';
    if(port.PROXY_VALID_BEFORE){var _t=Date.parse(String(port.PROXY_VALID_BEFORE).replace(' ','T'));var _exp=!isNaN(_t)&&_t<Date.now();conn+=_ovRow('Аренда до','<span style="color:'+(_exp?'var(--danger)':'var(--text-0)')+'">'+esc(String(port.PROXY_VALID_BEFORE).slice(0,10))+'</span>');}
  });
  conn+='</div>';
  var cards='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px;margin-bottom:10px">'+net+conn+'</div>';

  var _tdi=0,_tdo=0,_yi=0,_yo=0,_mi=0,_mo=0,_lf=0;
  (m.ports||[]).forEach(function(p){var b=p._bw||{};_tdi+=parseTraffic(b.bandwidth_bytes_day_in);_tdo+=parseTraffic(b.bandwidth_bytes_day_out);_yi+=parseTraffic(b.bandwidth_bytes_yesterday_in);_yo+=parseTraffic(b.bandwidth_bytes_yesterday_out);_mi+=parseTraffic(b.bandwidth_bytes_month_in);_mo+=parseTraffic(b.bandwidth_bytes_month_out);_lf+=parseTraffic(b.bandwidth_bytes_lifetime_in)+parseTraffic(b.bandwidth_bytes_lifetime_out);});
  var traf='<div style="background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:14px">';
  traf+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><span style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;font-weight:600">Трафик</span><span style="font-size:10px;color:var(--accent);cursor:pointer" onclick="document.querySelector(\'.modal-tab[data-tab=&quot;traffic&quot;]\').click()">тепловая карта →</span></div>';
  traf+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr));gap:10px;text-align:center">';
  traf+='<div><div style="font-size:16px;font-weight:700;color:var(--text-0);font-family:var(--font-mono)">'+fmtGb(_tdi+_tdo)+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px">Сегодня</div></div>';
  traf+='<div><div style="font-size:16px;font-weight:700;color:var(--text-0);font-family:var(--font-mono)">'+fmtGb(_yi+_yo)+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px">Вчера</div></div>';
  traf+='<div><div style="font-size:16px;font-weight:700;color:var(--text-0);font-family:var(--font-mono)">'+fmtGb(_mi+_mo)+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px">Месяц</div></div>';
  traf+='<div><div style="font-size:16px;font-weight:700;color:var(--text-0);font-family:var(--font-mono)">'+fmtGb(_lf)+'</div><div style="font-size:10px;color:var(--text-2);margin-top:2px">Всего</div></div>';
  traf+='</div></div>';

  var testPool='<div id="testPoolToggleRow" style="margin-top:12px;padding:9px 12px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;gap:10px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:11px"><input type="checkbox" id="testPoolToggleChk" onchange="toggleTestPool(\''+m.server+'\',\''+esc(m.nick)+'\',this.checked)"><span><strong>Тестовый пул</strong> — пускать через модем синтетическую нагрузку симулятора</span></label><span id="testPoolToggleStatus" style="font-size:10px;color:var(--text-3);margin-left:auto"></span></div>';

  body.innerHTML=banner+chipsWrap+acts+kpis+cards+traf+testPool;
  if(typeof loadTestPoolState==='function')loadTestPoolState(m.server,m.nick);
}

function _renderProxyLat(el,m){
  el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;padding:0 2px">'
    + '<div><h4 style="margin:0;font-size:14px;color:var(--text-0)">Задержка прокси для '+esc(m.nick)+'</h4>'
    + '<div style="font-size:11px;color:var(--text-3);margin-top:3px">Connect (TCP-handshake до модема) + Total (полный запрос через прокси). Замер вручную или по расписанию.</div></div>'
    + '<button class="btn btn-sm btn-primary" id="infoProxyCheckBtn" onclick="runManualProxyCheck(\''+esc(m.nick)+'\',\''+m.server+'\')" style="font-size:11px;padding:5px 14px;white-space:nowrap">▶ Запустить замер</button>'
    + '</div>'
    + '<div id="proxyCheckResult" style="margin-bottom:12px"></div>'
    + '<div id="proxyLatencyChart" style="margin-bottom:16px"></div>'
    + '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;font-weight:600">История проверок</div>'
    + '<div id="proxyCheckHistory"><div style="color:var(--text-3);font-size:11px;padding:8px">Загрузка…</div></div>';
  loadInfoProxyData(m.nick, m.server);
}

function _renderSpeed(el,m){var sh='<div style="margin-bottom:10px;text-align:center"><button class="btn btn-primary" onclick="runSpeedtest(\''+esc(m.nick)+'\',\''+m.server+'\',\''+m.rawImei+'\')">Запустить Speedtest (~1.5 мин)</button></div>';
  sh+='<div id="speedHistoryArea"><div style="color:var(--text-3);padding:8px">Загрузка истории...</div></div>';
  el.innerHTML=sh;
  loadSpeedHistory(m.server+'_'+m.rawImei)}

function _renderHosts(el,m){var port=m.ports[0];if(!port){el.innerHTML='<div style="color:var(--text-3);padding:12px">Нет порта</div>';return}el.innerHTML='<div style="color:var(--text-3)">Загрузка...</div>';api(API+'/api/admin/top_hosts?portId='+encodeURIComponent((port.portID||'').replace(/^S[12]_/,''))+'&serverName='+m.server).then(function(data){var entries=[];if(Array.isArray(data))entries=data;else{for(var k in data){if(typeof data[k]!=='object')entries.push({host:k,count:data[k]})}}entries.sort(function(a,b){return(b.count||0)-(a.count||0)});if(!entries.length){el.innerHTML='<div style="color:var(--text-3);padding:12px">Нет данных</div>';return}var maxCnt=entries[0]?(entries[0].count||1):1;var h='<table class="res-table"><thead><tr><th style="width:24px">#</th><th>Домен</th><th style="width:60px">Кат.</th><th style="width:150px">Запросов</th><th style="width:55px">Кол-во</th></tr></thead><tbody>';entries.forEach(function(e,i){var cat=categorize(e.host||'');var pw=pct(e.count||0,maxCnt);h+='<tr><td style="color:var(--text-3);font-size:10px">'+(i+1)+'</td><td class="domain" title="'+esc(e.host||'')+'">'+esc(e.host||'')+'</td><td style="font-size:9px;color:var(--text-3)">'+cat.substring(0,6)+'</td><td><div class="hbar-bar-wrap" style="height:10px"><div class="count-bar" style="width:'+pw+'%"></div></div></td><td style="font-family:monospace;font-size:10px;color:var(--text-0)">'+(e.count||'-')+'</td></tr>'});el.innerHTML=h+'</tbody></table>'}).catch(function(e){el.innerHTML='<div style="color:var(--danger)">'+(esc(e.message))+'</div>'})}

function _renderTrafficHeatmap(el,m){
  el.innerHTML='<div style="color:var(--text-3);text-align:center;padding:20px">Загрузка тепловой карты...</div>';
  api(API+'/api/analytics/modem_heatmap?nick='+encodeURIComponent(m.nick)+'&serverName='+encodeURIComponent(m.server)+'&days=7')
  .then(function(data){
    if(!data.ports||!Object.keys(data.ports).length){el.innerHTML='<div style="color:var(--text-3);text-align:center;padding:20px">Нет данных за 7 дней</div>';return;}
    var days=data.days||[],dm=data.day_meta||[];
    var DAYS_RU=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    var h='';
    for(var portLabel in data.ports){
      var portData=data.ports[portLabel];
      var mat=portData.matrix;
      var maxV=0;mat.forEach(function(row){row.forEach(function(v){if(v>maxV)maxV=v})});
      h+='<div style="margin-bottom:20px">';
      h+='<div style="font-size:13px;font-weight:600;color:var(--text-0);margin-bottom:8px">'+esc(portLabel)+'</div>';
      h+='<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><div style="min-width:400px">';
      h+='<div style="display:flex;margin-left:50px;margin-bottom:3px">';
      for(var hi=0;hi<24;hi+=2)h+='<div style="flex:1;text-align:center;font-size:8px;color:#9b9b98">'+String(hi).padStart(2,'0')+'</div><div style="flex:1"></div>';
      h+='</div>';
      mat.forEach(function(row,di){
        var ds=days[di]||'';var d=new Date(ds+'T00:00:00');
        var dn=DAYS_RU[d.getDay()]||(dm[di]&&dm[di].label)||'';
        h+='<div style="display:flex;align-items:center;margin-bottom:2px">';
        h+='<div style="width:50px;font-size:9px;color:#6b6b68;flex-shrink:0;text-align:right;padding-right:6px">'+dn+' '+ds.slice(8)+'.'+ds.slice(5,7)+'</div>';
        h+='<div style="display:flex;flex:1;gap:1px">';
        row.forEach(function(val){
          var col=val>0?heatColor(val,maxV,'#185FA5'):'var(--bg-3)';
          h+='<div style="flex:1;height:20px;border-radius:2px;background:'+col+'" title="'+trendFmt(val)+'"></div>';
        });
        h+='</div></div>';
      });
      h+='<div style="display:flex;align-items:center;gap:4px;margin-top:6px;font-size:9px;color:#9b9b98">';
      h+='<span>0</span><div style="display:flex;gap:1px">';
      for(var li=0;li<=6;li++)h+='<div style="width:12px;height:8px;border-radius:1px;background:'+heatColor(li/6*maxV,maxV,'#185FA5')+'"></div>';
      h+='</div><span>'+trendFmt(maxV)+'</span></div>';
      h+='</div></div></div></div>';
    }
    el.innerHTML=h;
  })
  .catch(function(e){el.innerHTML='<div style="color:var(--danger)">'+esc(e.message)+'</div>'});
}

function _renderRotationLog(el,m){
  el.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Загрузка лога ротации...</div>';
  api(API+'/api/admin/rotation_log?nick='+encodeURIComponent(m.nick)+'&serverName='+m.server).then(function(data){
    var entries=Array.isArray(data)?data:(data.log||data.logs||data.data||[]);
    if(!entries.length){el.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Нет истории ротации</div>';return}
    function _fmtRot(v){if(!v||v==='—')return'—';var s=String(v).replace('@',' ').replace('T',' ');var d=new Date(s);if(isNaN(d.getTime())){var p=s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):?(\d{2})?/);if(p)return p[3]+'.'+p[2]+'.'+p[1]+' '+p[4]+':'+p[5]+(p[6]?':'+p[6]:'');return s}return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
    var h='<table class="log-table"><thead><tr><th>Начало</th><th>Конец</th><th>Сек</th><th>Попытка</th><th>Старый IP</th><th>Новый IP</th></tr></thead><tbody>';
    entries.forEach(function(e){
      var start=e.started_at||e.start_time||e.Start||e.start||'—';
      var end=e.ended_at||e.end_time||e.End||e.end||'—';
      var took=e.took_sec||e.total_time||e.Took||e.took||'—';
      var attempt=e.attempt||e.Attempt||1;
      var oldIp=e.old_ip||e.OldIPv4||'—';
      var newIp=e.new_ip||e.NewIPv4||'—';
      h+='<tr>';
      h+='<td style="white-space:nowrap">'+_fmtRot(start)+'</td>';
      h+='<td style="white-space:nowrap">'+_fmtRot(end)+'</td>';
      h+='<td>'+(took!=='—'?parseFloat(took).toFixed(1):'—')+'</td>';
      h+='<td>'+esc(String(attempt))+'</td>';
      h+='<td style="font-family:var(--font-mono);color:var(--text-2)">'+esc(String(oldIp))+'</td>';
      h+='<td style="font-family:var(--font-mono);color:var(--accent)">'+esc(String(newIp))+'</td>';
      h+='</tr>';
    });
    el.innerHTML=h+'</tbody></table>';
  }).catch(function(e){el.innerHTML='<div style="color:var(--danger)">'+(esc(e.message))+'</div>'});
}

function _ovSecLabel(t){return '<div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;font-weight:600">'+t+'</div>';}
function _ovDivider(){return '<div style="height:1px;background:var(--border);margin:22px 0 16px"></div>';}

function _renderHealthTab2(body,m){
  body.innerHTML='<div id="ovSecHealth"></div>'+_ovDivider()+_ovSecLabel('Задержка прокси')+'<div id="ovSecLat"></div>';
  renderHealthTab(document.getElementById('ovSecHealth'),m);
  _renderProxyLat(document.getElementById('ovSecLat'),m);
}
function _renderTrafficTab(body,m){
  body.innerHTML=_ovSecLabel('Тепловая карта трафика (7 дней)')+'<div id="ovSecHeat"></div>'+_ovDivider()+_ovSecLabel('Топ доменов')+'<div id="ovSecHosts"></div>';
  _renderTrafficHeatmap(document.getElementById('ovSecHeat'),m);
  _renderHosts(document.getElementById('ovSecHosts'),m);
}
function _renderHistoryTab(body,m){
  body.innerHTML=_ovSecLabel('Ротации IP')+'<div id="ovSecRot"></div>'+_ovDivider()+_ovSecLabel('История скорости')+'<div id="ovSecSpeed"></div>';
  _renderRotationLog(document.getElementById('ovSecRot'),m);
  _renderSpeed(document.getElementById('ovSecSpeed'),m);
}

function renderTabContent(tab){var body=document.getElementById('modalBody'),m=currentDetailModem;if(!m)return;
  if(tab==='info'){_renderOverview(body,m);return}
  if(tab==='health'){_renderHealthTab2(body,m);return}
  if(tab==='traffic'){_renderTrafficTab(body,m);return}
  if(tab==='history'){_renderHistoryTab(body,m);return}
  if(tab==='proxylat'){_renderProxyLat(body,m);return}
  if(tab==='iphistory'){_renderRotationLog(body,m);return}
  if(tab==='speed'){_renderSpeed(body,m);return}
  if(tab==='hosts'){_renderHosts(body,m);return}
  if(false){}
  else if(tab==='settings'){
    var actH='';
    var ROT_OPTS=[{v:0,l:'Выкл.'},{v:5,l:'5 мин'},{v:10,l:'10 мин'},{v:15,l:'15 мин'},{v:30,l:'30 мин'},{v:60,l:'1 час'},{v:120,l:'2 часа'},{v:240,l:'4 часа'},{v:480,l:'8 часов'},{v:720,l:'12 часов'},{v:1440,l:'24 часа'}];
    var curRot=parseInt(m.autoRotation)||0;
    var ci=COUNTRIES[m.server]||{};
    // Ports section
    var portsH='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
      +'<span style="font-size:12px;color:var(--text-2)">'+m.ports.length+' порт(ов)</span>'
      +'<button class="btn btn-primary btn-sm" onclick="showNewPortForm(\''+m.rawImei+'\',\''+m.server+'\')">+ Добавить</button>'
      +'</div>';
    if(!m.ports.length){portsH+='<div style="color:var(--text-3);font-size:12px">Нет портов</div>'}
    else{m.ports.forEach(function(p){var pid=(p.portID||'').replace(/^S\d+_/,'');var osTag=p.OS?'<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;background:rgba(25,96,201,.1);color:var(--accent);margin-left:6px">🛡 '+esc(p.OS)+'</span>':'';
      // Stage 18.12: surface ProxySmart's per-port metadata that was previously
      // hidden — PROXY_VALID_BEFORE (expiry), CREATED_AT, and the IS_EXPIRED /
      // IS_OVER_QUOTA flags. Showing them inline so the operator doesn't have to
      // open ProxySmart UI separately to check expiry.
      function _fmtDate(s){if(!s)return'';try{var d=new Date(s);if(isNaN(d.getTime()))return s;return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});}catch(_){return s;}}
      var expiry=p.PROXY_VALID_BEFORE||'';
      var created=p.CREATED_AT||'';
      var expired=p.IS_EXPIRED==='1'||p.IS_EXPIRED===1||p.IS_EXPIRED===true;
      var overQuota=p.IS_OVER_QUOTA==='1'||p.IS_OVER_QUOTA===1||p.IS_OVER_QUOTA===true;
      // expiry date relative
      var expSoonTag='';
      if(expiry&&!expired){var ms=Date.parse(expiry);if(!isNaN(ms)){var days=Math.floor((ms-Date.now())/86400000);if(days<7&&days>=0)expSoonTag=' <span style="color:var(--warning);font-size:9px;font-weight:600">истекает через '+days+'д</span>';}}
      var statusTags='';
      if(expired)statusTags+='<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;background:rgba(232,65,65,.15);color:var(--danger);margin-left:6px">⏰ ИСТЁК</span>';
      if(overQuota)statusTags+='<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;background:rgba(239,159,39,.15);color:var(--warning);margin-left:6px">📦 ЛИМИТ</span>';
      portsH+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-2);border-radius:8px;border:1px solid var(--border);margin-bottom:6px">'
      +'<div><div style="font-size:12px;font-weight:600;color:var(--text-0)">'+esc(p.portName||pid)+osTag+statusTags+'</div>'
      +'<div style="font-size:11px;color:var(--text-2);margin-top:2px">HTTP: '+(ci.serverIp||'')+':'+esc(p.HTTP_PORT||'—')+' · SOCKS5: '+(ci.serverIp||'')+':'+esc(p.SOCKS_PORT||'—')+'</div>'
      +'<div style="font-size:11px;color:var(--text-3);font-family:monospace;margin-top:1px">'+esc(p.LOGIN||'')+'</div>'
      +(expiry||created?'<div style="font-size:10px;color:var(--text-3);margin-top:3px">'+(expiry?'<b>Действует до:</b> '+esc(_fmtDate(expiry))+expSoonTag:'')+(expiry&&created?' · ':'')+(created?'<b>Создан:</b> '+esc(_fmtDate(created)):'')+'</div>':'')
      +'</div>'
      +'<div style="display:flex;gap:4px"><button class="btn btn-sm" onclick="movePortPrompt(\''+pid+'\',\''+m.server+'\',\''+esc(p.portName||pid)+'\')" title="Перекинуть на другой модем">↔</button>'
      +'<button class="btn btn-sm" onclick="editPortFull(\''+m.rawImei+'\',\''+m.server+'\',\''+pid+'\')" title="Настройки порта">⚙️</button>'
      +'<button class="btn btn-danger btn-sm" onclick="purgePort(\''+pid+'\',\''+m.server+'\')" title="Удалить">✕</button></div>'
      +'</div>'});}
    portsH+='<div id="newPortForm"></div><div id="editPortForm"></div>';

    body.innerHTML='<div style="display:flex;flex-direction:column;gap:16px;padding:4px 0">'
      +actH
      // Section 1: Идентификация
      +'<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">'
      +'<div style="padding:7px 14px;background:var(--bg-2);font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Идентификация</div>'
      +'<div style="padding:14px;display:flex;flex-direction:column;gap:12px">'
      +'<div style="display:grid;grid-template-columns:110px 1fr;align-items:center;gap:10px"><label style="font-size:12px;color:var(--text-2)">Ник модема</label><input class="form-input" id="msNick" value="'+esc(m.nick)+'"></div>'
      +'<div style="display:grid;grid-template-columns:110px 1fr;align-items:center;gap:10px"><label style="font-size:12px;color:var(--text-2)">Телефон SIM</label><input class="form-input" id="msPhone" value="'+esc(m.phone)+'"></div>'
      +'<div style="display:grid;grid-template-columns:110px 1fr;align-items:flex-start;gap:10px"><label style="font-size:12px;color:var(--text-2);padding-top:6px">Заметки</label><textarea class="form-input" id="msNotes" rows="2" style="resize:vertical">'+esc(m.notes)+'</textarea></div>'
      +'</div></div>'
      // Section 2: Сеть и ротация
      +'<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">'
      +'<div style="padding:7px 14px;background:var(--bg-2);font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Сеть и ротация</div>'
      +'<div style="padding:14px;display:flex;flex-direction:column;gap:14px">'
      +'<div style="display:grid;grid-template-columns:110px 1fr;align-items:center;gap:10px"><label style="font-size:12px;color:var(--text-2)">Режим сети</label>'
      +'<select class="form-input" id="msMode" style="max-width:160px"><option value="auto"'+(m.targetMode==='auto'?' selected':'')+'>Авто</option><option value="4g"'+(m.targetMode==='4g'?' selected':'')+'>4G / LTE</option><option value="3g"'+(m.targetMode==='3g'?' selected':'')+'>3G</option></select></div>'
      +'<div style="display:grid;grid-template-columns:110px 1fr;align-items:center;gap:10px"><label style="font-size:12px;color:var(--text-2)">Авторотация</label>'
      +'<select class="form-input" id="msAutoRot" style="max-width:180px">'+ROT_OPTS.map(function(o){return'<option value="'+o.v+'"'+(curRot===o.v?' selected':'')+'>'+o.l+'</option>'}).join('')+'</select></div>'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm btn-warning" onclick="(function(){var b=document.querySelector(\'[data-imei=\\\"'+m.rawImei+'\\\"]\');if(b){resetIp(b)}else{fetch(API+\'/api/admin/reset_ip\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\',\'X-Auth-Token\':authToken},body:JSON.stringify({imei:\''+m.rawImei+'\',serverName:\''+m.server+'\'})}).then(function(r){return r.json()}).then(function(d){showToast(d.ok?\'IP сброшен\':d.error,d.ok?\'success\':\'error\')}).catch(function(){showToast(\'Ошибка сети\',\'error\')})}})()" style="font-size:11px">🔄 Сбросить IP сейчас</button>'
      +(/MF289/i.test(m.model||'')?'':'<button class="btn btn-sm" data-nick="'+esc(m.nick)+'" data-server="'+m.server+'" onclick="usbReset(this)" style="font-size:11px" title="Перезапустить USB-порт модема (usb reset)">🔌 USB Reset</button>')
      +'<button class="btn btn-sm" data-nick="'+esc(m.nick)+'" data-server="'+m.server+'" onclick="readdModem(this)" style="font-size:11px" title="Переподключить модем в системе ProxySmart (Re-Add device)">➕ Re-Add</button>'
      +'</div>'
      +'</div></div>'
      // Section 3: Порты
      +'<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">'
      +'<div style="padding:7px 14px;background:var(--bg-2);font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Порты</div>'
      +'<div style="padding:14px">'+portsH+'</div>'
      +'</div>'
      // Save buttons
      +'<div style="display:flex;gap:8px;padding-top:4px">'
      +'<button class="btn btn-primary" onclick="saveModemSettingsNew(\''+m.rawImei+'\',\''+m.server+'\')">Сохранить</button>'
      +'<button class="btn btn-sm" style="color:var(--text-2);font-size:11px" onclick="applyModemSettings(\''+m.rawImei+'\',\''+m.server+'\')" title="Сохранить и перезапустить модем">Сохранить и перезапустить</button>'
      +'</div>'
      +'</div>';
  }
}
function runSpeedtest(nick,srv,imei){
  var body=document.getElementById('modalBody');
  body.innerHTML='<div style="text-align:center;padding:24px"><div class="spinner" style="display:inline-block;width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite"></div><p style="color:var(--text-2);margin-top:12px;font-size:12px">Замер скорости <b>'+esc(nick)+'</b>…<br><span style="font-size:10px;color:var(--text-3)">Идёт <span id="stElapsed">0 с</span> · обычно 30–90 с</span></p></div>';
  // 2026-07-16: замер идёт 30–90 с — синхронный запрос рвал nginx (30 с) и
  // отдавал HTML-страницу 504 («Unexpected token '<'»). Теперь стартуем джоб
  // и опрашиваем статус: каждый HTTP-запрос короткий, прокси не при делах.
  var _stStarted=Date.now();
  var _stTick=null;
  function _stElapsed(){
    var sec=Math.round((Date.now()-_stStarted)/1000);
    var el=document.getElementById('stElapsed');
    if(el)el.textContent=sec+' с';
  }
  _stTick=setInterval(_stElapsed,1000);
  function _stStop(){ if(_stTick){clearInterval(_stTick);_stTick=null;} }
  function _stFinish(d){ _stStop(); _stRender(d); }
  api(API+'/api/admin/speedtest/start',{method:'POST',json:{nick:nick,serverName:srv,imei:imei||''}})
    .then(function(j){
      if(j.error) throw new Error(j.error);
      var deadline=Date.now()+200000;   // 200 с — потолок самого замера
      (function poll(){
        if(Date.now()>deadline){ _stFinish({error:'Замер не завершился за 200 с'}); return; }
        setTimeout(function(){
          api(API+'/api/admin/speedtest/status?jobId='+encodeURIComponent(j.jobId))
            .then(function(st){
              if(st.status==='running'){ poll(); return; }
              if(st.status==='done'){ _stFinish(st.result||{}); return; }
              _stFinish({error:st.error||'Замер не удался',details:st.details});
            })
            .catch(function(e){ _stFinish({error:e.message||'Ошибка сети'}); });
        },2500);
      })();
    })
    .catch(function(e){ _stFinish({error:e.message||'Ошибка сети'}); });

  function _stRender(d){
      var reloadBtn='<button class="btn btn-sm btn-primary" onclick="runSpeedtest(\''+esc(nick)+'\',\''+srv+'\',\''+esc(imei||'')+'\')">Повторить</button> ';
      if(d.error){
        body.innerHTML='<div style="padding:16px"><div style="color:var(--danger);font-size:12px;margin-bottom:8px">⚠ Ошибка: '+esc(d.error)+'</div>'+(d.details?'<div style="font-size:10px;color:var(--text-3);font-family:monospace;word-break:break-all">'+esc(d.details)+'</div>':'')+'<div style="margin-top:12px">'+reloadBtn+'</div></div>';
        return;
      }
      var dl=parseFloat(d.download||d.Download||d.dl||0)||0;
      var ul=parseFloat(d.upload||d.Upload||d.ul||0)||0;
      var ping=parseFloat(d.ping||d.Ping||d.latency||0)||0;
      var dlColor=dl>=30?'var(--success)':dl>=10?'var(--accent)':'var(--danger)';
      var ulColor=ul>=10?'var(--success)':ul>=5?'var(--accent)':'var(--danger)';
      var h='<div style="padding:16px">';
      h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">';
      h+='<div style="text-align:center;padding:12px;background:var(--bg-2);border-radius:8px"><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">↓ DOWNLOAD</div><div style="font-size:22px;font-weight:700;color:'+dlColor+'">'+dl.toFixed(1)+'</div><div style="font-size:10px;color:var(--text-3)">Mbps</div></div>';
      h+='<div style="text-align:center;padding:12px;background:var(--bg-2);border-radius:8px"><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">↑ UPLOAD</div><div style="font-size:22px;font-weight:700;color:'+ulColor+'">'+ul.toFixed(1)+'</div><div style="font-size:10px;color:var(--text-3)">Mbps</div></div>';
      h+='<div style="text-align:center;padding:12px;background:var(--bg-2);border-radius:8px"><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">PING</div><div style="font-size:22px;font-weight:700;color:var(--text-0)">'+ping.toFixed(0)+'</div><div style="font-size:10px;color:var(--text-3)">ms</div></div>';
      h+='</div>';
      var histKey=imei?(srv+'_'+imei):srv;
      h+='<div style="margin-top:4px">'+reloadBtn+'<button class="btn btn-sm" onclick="loadSpeedHistory(\''+histKey+'\')">История</button></div>';
      // raw data
      if(Object.keys(d).length>0){h+='<details style="margin-top:12px"><summary style="font-size:10px;color:var(--text-3);cursor:pointer">Raw данные</summary><pre style="font-size:9px;color:var(--text-2);margin-top:6px;white-space:pre-wrap;word-break:break-all">'+esc(JSON.stringify(d,null,2))+'</pre></details>';}
      h+='</div>';
      body.innerHTML=h;
  }
}
function sendSms(imei,srv){var ph=document.getElementById('smsPhone').value,tx=document.getElementById('smsText').value;if(!ph||!tx)return showToast('Заполните поля','error');api(API+'/api/admin/send_sms',{method:'POST',json:{imei:imei,serverName:srv,phone:ph,sms:tx}}).then(function(d){d.ok?showToast('Отправлено','success'):showToast(d.error,'error')}).catch(function(){showToast('Ошибка','error')})}
function purgeSms(nick,srv){confirmDialog('Удалить все SMS для модема «'+nick+'»? Это действие нельзя отменить.',function(){api(API+'/api/admin/purge_sms',{method:'POST',json:{nick:nick,serverName:srv}}).then(function(d){d.ok?showToast('Удалено','success'):showToast(d.error,'error')}).catch(function(){showToast('Ошибка','error')});},'Удалить','Удалить SMS')}
function sendUssd(imei,srv){var code=document.getElementById('ussdCode').value;if(!code)return;document.getElementById('ussdResult').innerHTML='<span style="color:var(--text-3)">Отправка...</span>';api(API+'/api/admin/send_ussd',{method:'POST',json:{imei:imei,serverName:srv,ussd:code}}).then(function(d){var r=d.result||d;document.getElementById('ussdResult').innerHTML='<div class="detail-card"><pre style="font-size:11px;color:var(--text-1);white-space:pre-wrap">'+esc(typeof r==='object'?JSON.stringify(r,null,2):String(r))+'</pre></div>'}).catch(function(e){document.getElementById('ussdResult').innerHTML='<span style="color:var(--danger)">'+(esc(e.message))+'</span>'})}
function showNewPortForm(imei,srv){api(API+'/api/admin/free_ports?serverName='+srv).then(function(data){var fp=Array.isArray(data)?data:data.free_tcp_ports||[];var h='<div class="detail-card" style="margin-top:8px"><h4>Новый порт</h4><div class="form-row"><div class="form-group"><label>Port ID</label><input class="form-input" id="npPid" value="port'+rnd(8)+'"></div><div class="form-group"><label>Имя</label><input class="form-input" id="npName"></div></div><div class="form-group"><label>HTTP / SOCKS порты</label><input class="form-input" id="npHttp" value="авто" readonly style="opacity:.6;cursor:not-allowed"><input type="hidden" id="npSocks" value="auto"><div style="font-size:11px;color:var(--text-3);margin-top:4px">Сервер назначит корректную пару портов автоматически</div></div><div class="form-row"><div class="form-group"><label>Логин</label><input class="form-input" id="npLogin" value="'+rnd(8)+'"></div><div class="form-group"><label>Пароль</label><input class="form-input" id="npPass" value="'+rnd(8)+'"></div></div><button class="btn btn-primary" onclick="createPort(\''+imei+'\',\''+srv+'\')">Создать</button></div>';document.getElementById('newPortForm').innerHTML=h}).catch(function(e){showToast('Ошибка загрузки портов: '+esc(e.message),'error')})}
function createPort(imei,srv){
  var pn=document.getElementById('npName').value;
  if(pn.length<4){showToast('Имя порта должно быть не менее 4 символов','error');return}
  // portID input is left visible for debugging but ignored by backend —
  // ProxySmart generates the authoritative portID and we trust the server.
  var d={serverName:srv,IMEI:imei,portName:pn,
    http_port:document.getElementById('npHttp').value,
    socks_port:document.getElementById('npSocks').value,
    proxy_login:document.getElementById('npLogin').value,
    proxy_password:document.getElementById('npPass').value};
  api(API+'/api/admin/store_port',{method:'POST',json:d})
    .then(function(r){
      if(!r.ok){showToast(r.error||'Ошибка','error');return}
      if(r.applied){
        showToast('Порт создан: HTTP '+(r.http_port||'?')+' · SOCKS '+(r.socks_port||'?')+' · логин '+(r.proxy_login||'?')+' (id '+r.portId+')','success');
      } else {
        // Fallback: try apply once more with the real portID returned from server
        api(API+'/api/admin/apply_port',{method:'POST',json:{portId:r.portId,serverName:srv}})
          .then(function(){showToast('Порт создан и применён (id: '+r.portId+')','success')})
          .catch(function(e){showToast('Порт сохранён, но не применён: '+esc(e.message),'warning')});
      }
      setTimeout(loadData,2000);
    })
    .catch(function(e){showToast('Ошибка: '+esc(e.message),'error')});
}
function movePortPrompt(pid,srv,label){
  // Build list of available modems on this server
  var modemList=[];
  if(currentData&&currentData._modemMap){
    for(var imei in currentData._modemMap){
      var m=currentData._modemMap[imei];
      if(m.server===srv)modemList.push({imei:m.rawImei,nick:m.nick});
    }
  }
  modemList.sort(function(a,b){return a.nick.localeCompare(b.nick)});
  var opts=modemList.map(function(m){return'<option value="'+esc(m.imei)+'">'+esc(m.nick)+' ('+m.imei+')</option>'}).join('');
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=function(e){if(e.target===overlay)overlay.remove()};
  overlay.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:400px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)" onclick="event.stopPropagation()">'
    +'<h3 style="margin:0 0 12px;font-size:14px;color:var(--text-0)">Перекинуть порт '+esc(label)+'</h3>'
    +'<p style="font-size:12px;color:var(--text-2);margin-bottom:12px">Выберите модем, на который нужно перекинуть порт:</p>'
    +'<select id="movePortTarget" class="form-input" style="width:100%;margin-bottom:12px">'+opts+'</select>'
    +'<div style="display:flex;gap:8px;justify-content:flex-end">'
    +'<button class="btn btn-sm" onclick="this.closest(\'div[style*=fixed]\').remove()">Отмена</button>'
    +'<button class="btn btn-primary btn-sm" id="movePortBtn" onclick="doMovePort(\''+esc(pid)+'\',\''+esc(srv)+'\',this)">Перекинуть</button>'
    +'</div></div>';
  document.body.appendChild(overlay);
}
function doMovePort(pid,srv,btn){
  var newIMEI=document.getElementById('movePortTarget').value;
  if(!newIMEI)return showToast('Выберите модем','error');
  btn.disabled=true;btn.textContent='Перекидываю...';
  api(API+'/api/admin/move_port',{method:'POST',json:{serverName:srv,portID:pid,newIMEI:newIMEI}})
  .then(function(d){
    if(d.ok){showToast('Порт перекинут','success');btn.closest('div[style*=fixed]').remove();setTimeout(loadData,3000);}
    else showToast(d.error||'Ошибка','error');
    btn.disabled=false;btn.textContent='Перекинуть';
  }).catch(function(e){showToast(esc(e.message),'error');btn.disabled=false;btn.textContent='Перекинуть';});
}
function purgePort(pid,srv){confirmDialog('Удалить порт «'+pid+'»? Это действие нельзя отменить.',function(){api(API+'/api/admin/purge_port',{method:'POST',json:{portId:pid,serverName:srv}}).then(function(d){d.ok?showToast('Удалён','success'):showToast(d.error,'error');setTimeout(loadData,2000)}).catch(function(e){showToast(esc(e.message),'error')});},'Удалить','Удалить порт')}
function switchSimTab(t){['sms','ussd'].forEach(function(n){var tab=document.getElementById('simTab_'+n);var cnt=document.getElementById('simContent_'+n);if(tab){tab.style.borderBottomColor=n===t?'var(--accent)':'transparent';tab.style.color=n===t?'var(--accent)':'var(--text-2)'}if(cnt)cnt.style.display=n===t?'':'none'})}
function saveModemSettingsNew(imei,srv){var rotSel=document.getElementById('msAutoRot');var rotVal=rotSel?parseInt(rotSel.value)||0:0;api(API+'/api/admin/store_modem',{method:'POST',json:{serverName:srv,IMEI:imei,name:document.getElementById('msNick').value,PHONE_NUMBER:document.getElementById('msPhone').value,AUTO_IP_ROTATION:String(rotVal),TARGET_MODE:document.getElementById('msMode').value,NOTES:document.getElementById('msNotes').value}}).then(function(r){if(r.ok){showToast('Сохранено, применяю...','success');api(API+'/api/admin/apply_modem',{method:'POST',json:{imei:imei,serverName:srv}}).then(function(r2){r2.ok?showToast('Применено ✓','success'):showToast('Сохранено, но не применено: '+(r2.error||''),'warning');setTimeout(loadData,3000)}).catch(function(e){showToast('Сохранено, но не применено: '+esc(e.message),'warning');setTimeout(loadData,3000)})}else{showToast(r.error||'Ошибка','error')}}).catch(function(e){showToast('Ошибка: '+esc(e.message),'error')})}
function applyModemSettings(imei,srv){api(API+'/api/admin/apply_modem',{method:'POST',json:{imei:imei,serverName:srv}}).then(function(r){r.ok?showToast('Применено','success'):showToast(r.error||'Ошибка','error');setTimeout(loadData,3000)}).catch(function(e){showToast(esc(e.message),'error')})}
function downloadVpn(pid,srv){window.open(API+'/api/admin/vpn_profile?portId='+encodeURIComponent(pid)+'&serverName='+srv+'&token='+authToken)}
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
function chartExtTooltip(context){
  var tt=context.tooltip;
  var el=document.getElementById('chartExtTT');
  if(!el){
    el=document.createElement('div');el.id='chartExtTT';
    el.style.cssText='position:fixed;z-index:10000;pointer-events:none;background:#fff;border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:150px;box-shadow:0 4px 20px rgba(0,0,0,0.10);opacity:0;transition:opacity .12s ease;font-family:Inter,-apple-system,sans-serif';
    document.body.appendChild(el);
  }
  if(!tt||tt.opacity===0){el.style.opacity='0';return;}
  var splitKV=function(s){var i=String(s).lastIndexOf(': ');return i>0?[s.slice(0,i),s.slice(i+2)]:[s,''];};
  var h='';
  (tt.title||[]).forEach(function(t){h+='<div style="font-size:11px;color:#9b9b98;margin-bottom:6px">'+t+'</div>';});
  var colors=tt.labelColors||[];
  (tt.body||[]).forEach(function(b,i){
    var c=colors[i]||{};
    var swatch=c.backgroundColor?'<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+c.backgroundColor+';margin-right:7px;flex:none"></span>':'';
    (b.lines||[]).forEach(function(ln){
      var kv=splitKV(ln.replace(/^\s+/,''));
      h+='<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:2px 0">'
        +'<span style="font-size:11px;color:#6b6b68;display:flex;align-items:center;min-width:0">'+swatch+'<span style="overflow:hidden;text-overflow:ellipsis">'+kv[0]+'</span></span>'
        +(kv[1]?'<span style="font-size:12px;font-weight:600;color:#1a1a1a;white-space:nowrap">'+kv[1]+'</span>':'')+'</div>';
    });
  });
  if(tt.footer&&tt.footer.length){
    h+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>';
    tt.footer.forEach(function(f){
      var kv=splitKV(f);
      h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;color:#9b9b98">'+kv[0]+'</span>'
        +(kv[1]?'<span style="font-size:12px;font-weight:600;color:#1a1a1a">'+kv[1]+'</span>':'')+'</div>';
    });
  }
  el.innerHTML=h;
  var rect=context.chart.canvas.getBoundingClientRect();
  el.style.opacity='1';
  var w=el.offsetWidth,ht=el.offsetHeight;
  var x=rect.left+tt.caretX+14, y=rect.top+tt.caretY-10;
  if(x+w>window.innerWidth-8) x=rect.left+tt.caretX-w-14;
  if(x<8) x=8;
  if(y+ht>window.innerHeight-8) y=window.innerHeight-ht-8;
  if(y<8) y=8;
  el.style.left=x+'px';el.style.top=y+'px';
}

// Apply Chart.js global defaults
(function(){if(typeof Chart==='undefined')return;
  Chart.defaults.font.family="'Inter',-apple-system,sans-serif";
  Chart.defaults.font.size=12;
  Chart.defaults.plugins.legend.display=false;
  // Единый стиль ВСЕХ тултипов графиков = карточка «Почасового трафика»
  // (белая карточка с чёткой тенью, а не canvas-подложка, которая сливалась
  // со светлым фоном). Реализовано внешним HTML-тултипом chartExtTooltip:
  // отключаем встроенный рендер и вешаем внешний обработчик глобально —
  // так его наследуют все графики, а их callbacks (label/title/footer)
  // продолжают наполнять содержимое.
  Chart.defaults.plugins.tooltip.enabled=false;
  Chart.defaults.plugins.tooltip.external=chartExtTooltip;
})();

// Domain categorization
var DOMAIN_CATS={
  'Социальные сети':[/facebook|instagram|tiktok|vk\.com|twitter|x\.com|snapchat|pinterest|linkedin/i],
  'Поисковики':[/google\.|yandex\.|bing\.|duckduckgo|yahoo/i],
  'Видео':[/youtube|youtu\.be|vimeo|twitch|dailymotion|rutube/i],
  'Мессенджеры':[/telegram|whatsapp|viber|signal|discord/i],
  'CDN/Облако':[/cloudflare|amazonaws|akamai|fastly|cdn\.|azure|gstatic|googleusercontent/i],
  'Реклама':[/doubleclick|adservice|adsense|facebook.*ad|ads\.|analytics/i],
  'Почта':[/mail\.|outlook|gmail|smtp|imap|pop3/i],
  'Прочее':[]
};
function categorize(domain){for(var cat in DOMAIN_CATS){var patterns=DOMAIN_CATS[cat];for(var i=0;i<patterns.length;i++){if(patterns[i].test(domain))return cat}}return'Прочее'}

function switchAccTab(name,el){
  document.querySelectorAll('.acc-sub-tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.acc-sub-content').forEach(function(t){t.classList.remove('active')});
  if(el)el.classList.add('active');
  var content=document.getElementById('acc-'+name);
  if(content)content.classList.add('active');
  // Stage 18.23 — ⚡ NEW lives parallel; route to its own renderer.
  if(name === 'new'){ try { renderAccNew(); } catch(e) { console.error(e); } return; }
  renderAccSubTab(name);
}

function setAccPeriod(p,el){
  accPeriod=p;
  window._dailyTrafficCache=null;window._spkData=null; // reset caches so chart reloads fresh
  document.querySelectorAll('.acc-period-btn').forEach(function(b){b.classList.remove('active')});
  if(el)el.classList.add('active');
  renderTrafficTab();
}

function getTrafficFields(){
  switch(accPeriod){
    case'day':return{inKey:'bandwidth_bytes_day_in',outKey:'bandwidth_bytes_day_out',label:'Сегодня'};
    case'yesterday':return{inKey:'bandwidth_bytes_yesterday_in',outKey:'bandwidth_bytes_yesterday_out',label:'Вчера'};
    case'month':return{inKey:'bandwidth_bytes_month_in',outKey:'bandwidth_bytes_month_out',label:'Текущий месяц'};
    case'prevmonth':return{inKey:'bandwidth_bytes_prevmonth_in',outKey:'bandwidth_bytes_prevmonth_out',label:'Прошлый месяц'};
    case'lifetime':return{inKey:'bandwidth_bytes_lifetime_in',outKey:'bandwidth_bytes_lifetime_out',label:'Всё время'};
    default:return{inKey:'bandwidth_bytes_month_in',outKey:'bandwidth_bytes_month_out',label:'Месяц'};
  }
}

function collectTrafficData(){
  if(!currentData||!currentData._modemMap)return null;
  var map=currentData._modemMap,fields=getTrafficFields();
  var accClientFilter=(document.getElementById('accClientFilter')||{}).value||'';
  var totalModems=0,totalOnline=0,totalIn=0,totalOut=0;
  var modemTraffic=[],clientTraffic={},serverTraffic={},serverIn={},serverOut={},serverOpTraffic={};
  // Only track portNames that belong to registered clients
  var registeredPortNames=new Set((currentData.clients||[]).map(function(c){return c.portName}).filter(Boolean));
  for(var imei in map){
    var m=map[imei];
    var st=getModemStatus(m);
    var isOn=st==='online'||st==='rotating';
    // Iterate ALL ports of this modem (each port = separate client/portName)
    var ports=m.ports.length?m.ports:[{}];
    for(var pi=0;pi<ports.length;pi++){
      var port=ports[pi],bw=port._bw||{};
      var pn=port.portName||'Не назначен';
      if(accClientFilter&&pn!==accClientFilter)continue;
      totalModems++;
      if(isOn)totalOnline++;
      var din=parseTraffic(bw[fields.inKey]),dout=parseTraffic(bw[fields.outKey]);
      var dayIn=parseTraffic(bw.bandwidth_bytes_day_in),dayOut=parseTraffic(bw.bandwidth_bytes_day_out);
      var yestIn=parseTraffic(bw.bandwidth_bytes_yesterday_in),yestOut=parseTraffic(bw.bandwidth_bytes_yesterday_out);
      var monIn=parseTraffic(bw.bandwidth_bytes_month_in),monOut=parseTraffic(bw.bandwidth_bytes_month_out);
      var prevIn=parseTraffic(bw.bandwidth_bytes_prevmonth_in),prevOut=parseTraffic(bw.bandwidth_bytes_prevmonth_out);
      var lifeIn=parseTraffic(bw.bandwidth_bytes_lifetime_in),lifeOut=parseTraffic(bw.bandwidth_bytes_lifetime_out);
      var rawOp=m.operator||'Неизвестный';
      var op=rawOp;
      totalIn+=din;totalOut+=dout;
      modemTraffic.push({nick:m.nick,operator:op,server:m.server,pn:pn,portId:port.portID||'',tIn:din,tOut:dout,dayIn:dayIn,dayOut:dayOut,yestIn:yestIn,yestOut:yestOut,monIn:monIn,monOut:monOut,prevIn:prevIn,prevOut:prevOut,lifeIn:lifeIn,lifeOut:lifeOut,online:isOn});
      // Only add to clientTraffic if this portName belongs to a registered client
      if(!registeredPortNames.has(pn))continue;
      if(!clientTraffic[pn])clientTraffic[pn]={tIn:0,tOut:0,modems:0,online:0};
      clientTraffic[pn].tIn+=din;clientTraffic[pn].tOut+=dout;clientTraffic[pn].modems++;
      if(isOn)clientTraffic[pn].online++;
      if(!serverTraffic[m.server])serverTraffic[m.server]=0;
      serverTraffic[m.server]+=din+dout;
      if(!serverIn[m.server])serverIn[m.server]=0;serverIn[m.server]+=din;
      if(!serverOut[m.server])serverOut[m.server]=0;serverOut[m.server]+=dout;
      if(!serverOpTraffic[m.server])serverOpTraffic[m.server]={};
      if(!serverOpTraffic[m.server][op])serverOpTraffic[m.server][op]={tIn:0,tOut:0,count:0};
      serverOpTraffic[m.server][op].tIn+=din;serverOpTraffic[m.server][op].tOut+=dout;serverOpTraffic[m.server][op].count++;
    }
  }
  modemTraffic.sort(function(a,b){return(b.tIn+b.tOut)-(a.tIn+a.tOut)});
  // Stable per-client modem TOTAL: override the volatile live count (which drops
  // when a modem briefly goes offline) with the backend's 24h-roster count
  // (client.modemCount). Online count stays live. So a client shows e.g. 12/15
  // instead of flickering 12/13. Rows are created for clients whose modems are
  // all offline right now so their total doesn't collapse to 0.
  (currentData.clients||[]).forEach(function(c){
    if(!c.portName || typeof c.modemCount!=='number' || c.modemCount<=0) return;
    if(!clientTraffic[c.portName]) clientTraffic[c.portName]={tIn:0,tOut:0,modems:0,online:0};
    // «в работе» по клиенту — fleet-семантика из backend (modemWorking), а не
    // живой getModemStatus: иначе числитель расходился с шапкой («31/31» при
    // «90/91» наверху — модем, тёмный для fleet, ещё считался онлайн тут).
    if(typeof c.modemWorking==='number') clientTraffic[c.portName].online=c.modemWorking;
    // Показываем 24ч-ростер (стабильнее живого счётчика), НО итог не может быть
    // меньше числа онлайн-модемов прямо сейчас — иначе выходит «32/30» (ростер
    // отстаёт от только что добавленных модемов). max() держит инвариант online≤total.
    clientTraffic[c.portName].modems = Math.max(c.modemCount, clientTraffic[c.portName].online || 0);
  });
  return{totalModems:totalModems,totalOnline:totalOnline,totalIn:totalIn,totalOut:totalOut,modemTraffic:modemTraffic,clientTraffic:clientTraffic,serverTraffic:serverTraffic,serverIn:serverIn,serverOut:serverOut,serverOpTraffic:serverOpTraffic,label:fields.label};
}

// fmtGb, fmtGbShort, pct moved to /js/utils.js

function renderHBars(items,maxVal,colorClass){
  if(!items.length)return'<div style="color:var(--text-3);padding:10px;font-size:11px">Нет данных</div>';
  var h='<ul class="hbar-list">';
  items.forEach(function(item,i){
    h+='<li class="hbar-item"><span class="hbar-rank">'+(i+1)+'</span><span class="hbar-label" title="'+esc(item.label)+'">'+esc(item.label)+'</span><div class="hbar-bar-wrap"><div class="hbar-bar '+(item.color||colorClass||'blue')+'" style="width:'+pct(item.value,maxVal)+'%"></div></div><span class="hbar-value">'+fmtGbShort(item.value)+'</span></li>';
  });
  return h+'</ul>';
}

function populateAccClientFilter(){
  var sel=document.getElementById('accClientFilter');
  if(!sel||!currentData)return;
  var prev=sel.value;
  var cls=currentData.clients||[];
  var h='<option value="">Все клиенты</option>';
  cls.filter(function(c){return c.modemCount>0}).forEach(function(c){
    h+='<option value="'+esc(c.portName)+'">'+esc(c.name)+' ('+esc(c.portName)+')</option>';
  });
  sel.innerHTML=h;
  if(prev)sel.value=prev;
  // Also populate resClientFilter on resources tab
  var resSel=document.getElementById('resClientFilter');
  if(resSel){
    var resPrev=resSel.value;
    var rh='<option value="">Все клиенты</option>';
    cls.filter(function(c){return c.modemCount>0}).forEach(function(c){
      rh+='<option value="'+esc(c.portName)+'">'+esc(c.name)+'</option>';
    });
    resSel.innerHTML=rh;
    if(resPrev)resSel.value=resPrev;
  }
}

function renderTrafficTab(){
  var d=collectTrafficData();if(!d)return;
  // Top metric widgets removed (Task 1) — keep div empty. (WP1: the dead
  // summary computations that used to live here — avg/forecast/top-client/
  // online/revenue — were deleted with the div; the modem counters on this
  // page come from currentData.fleet, like everywhere else.)
  var twEl=document.getElementById('trafficWidgets');if(twEl)twEl.innerHTML='';

  // Render active sub-tab
  var activeSubTab=document.querySelector('.acc-sub-tab.active');
  var tabName=activeSubTab?activeSubTab.textContent.trim().split(' ')[0]:'Обзор';
  // find which tab is active
  var activeSub=document.querySelector('.acc-sub-content.active');
  if(activeSub)renderAccSubTab(activeSub.id.replace('acc-',''));
}

function getDaysElapsed(){
  if(accPeriod==='month')return new Date().getDate()||1;
  if(accPeriod==='yesterday')return 1;
  if(accPeriod==='day')return 1;
  if(accPeriod==='prevmonth'){var prev=new Date();prev.setDate(0);return prev.getDate()||30}
  if(accPeriod==='lifetime')return 30;
  return 1;
}
function renderAccSubTab(name){
  var d=collectTrafficData();if(!d)return;
  var cc=getChartColors();
  var chartOpts=function(stacked){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:cc.text,font:{size:11}}}},scales:{x:{stacked:!!stacked,ticks:{color:cc.text,font:{size:10}},grid:{color:cc.grid}},y:{stacked:!!stacked,ticks:{color:cc.text,font:{size:10}},grid:{color:cc.grid}}}}};

  if(name==='overview'){
    // Task 1: Clear top metric widgets
    var twEl=document.getElementById('trafficWidgets');if(twEl)twEl.innerHTML='';

    // Extended widgets: Аномалии (inline), Рекорды, Тренд (redesigned)
    var extRow=document.getElementById('extendedWidgetsRow');
    if(extRow){
      // --- Real-time issues from _modemMap (with details) ---
      var mm=currentData._modemMap||{};
      var rtOffline=[],rtLowSpeed=[],rtStuckIp=[];
      function _ageLabel(ms){
        if(!ms)return '';
        var ageMs=Date.now()-ms;
        if(ageMs<60000)return 'только что';
        var mins=Math.floor(ageMs/60000);
        if(mins<60)return mins+' мин назад';
        if(mins<1440)return Math.floor(mins/60)+' ч назад';
        return Math.floor(mins/1440)+' д назад';
      }
      // Stage 18.10: модемы которые перешли порог stale (>N часов offline,
      // настройка stale_modem_hours, default 12) НЕ показываются в карточке
      // «Отключённые». Они считаются «давно умершими» — оператору их видеть
      // среди свежих проблем бесполезно. Они остаются в общей таблице модемов
      // с пометкой OFFLINE без time-badge.
      var STALE_MS_OVERVIEW = ((window._staleModemHours || 12)) * 3600 * 1000;
      Object.values(mm).forEach(function(m){
        var st=getModemStatus(m);
        if(st==='offline'){
          var isStale = !m.lastSeenMs || (Date.now() - m.lastSeenMs > STALE_MS_OVERVIEW);
          if(isStale) return;  // skip stale modems from "Модем отключен" card
          var age=_ageLabel(m.lastSeenMs);
          rtOffline.push({nick:m.nick,server:m.server,detail:age?'Отключён '+age:'Статус: offline',lastSeenMs:m.lastSeenMs||0});
        }
        if(m.lowSpeed)rtLowSpeed.push({nick:m.nick,server:m.server,detail:'↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Mbps'});
        if(m.ipStuck)rtStuckIp.push({nick:m.nick,server:m.server,detail:'IP не менялся '+m.ipSinceHours+'ч · '+esc(m.extIp||'')});
      });
      // The «Модем отключен» count/list now come from the coherent fleet model
      // (consistent with the «X/Y» header): a modem online within 48h but not
      // online now. This replaces the old live-_modemMap list that hid modems
      // offline >12h, which caused «84 online / 0 offline» to disagree.
      // «Модем отключен» = модемы, которые молчат уже >10 мин (disconnectedList).
      // Кратковременный мигающий офлайн (один пропущенный опрос) сюда не попадает —
      // это тот же порог, на котором уходит уведомление в телегу/колокольчик.
      var _offSrc = (currentData.fleet && (currentData.fleet.disconnectedList || currentData.fleet.offlineList)) || null;
      if (Array.isArray(_offSrc)) {
        rtOffline = _offSrc.map(function(o){
          var age=o.lastOnline?_ageLabel(o.lastOnline):'';
          return {nick:o.nick,server:o.server,detail:age?('Отключён '+age):'offline',lastSeenMs:o.lastOnline||0};
        });
      }
      // Sort offline list: most recently disconnected first.
      rtOffline.sort(function(a,b){return (Number(b.lastSeenMs)||0) - (Number(a.lastSeenMs)||0);});

      // --- "Сбоит прокси": приходит уже посчитанным с сервера (latency/error/rotation) ---
      var flakyItems = (currentData.proxyIssues || []).map(function(it){
        return { nick: it.nick, server: it.server, detail: it.detail, _meta: it };
      });

      // Store globally for popup access
      window._problemData={offline:rtOffline,speed:rtLowSpeed,ipstuck:rtStuckIp,flaky:flakyItems};

      // --- Build problems card (2×2 grid) ---
      var anomH='<div class="analytics-card" style="margin:0;overflow:hidden">';
      anomH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px;flex-shrink:0">🔧 Проблемы инфраструктуры</div>';
      function probItem(label,key,items,dotColor){
        var n=items.length;var bg=n===0?'var(--green-bg)':dotColor==='var(--danger)'?'var(--red-bg)':'var(--orange-bg)';
        var valColor=n===0?'var(--success)':dotColor==='var(--danger)'?'var(--danger)':'var(--warning)';
        var r='<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;background:'+bg+';font-size:11px'+(n>0?';cursor:pointer':'')+'"'+(n>0?' onclick="showProblemPopup(\''+esc(label)+'\',\''+key+'\')"':'')+' >';
        r+='<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:'+(n===0?'var(--success)':dotColor)+'"></span>';
        r+='<span style="flex:1;color:var(--text-2)">'+label+'</span>';
        r+='<span style="font-weight:600;color:'+valColor+'">'+n+'</span>';
        r+='</div>';return r;
      }
      anomH+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;flex:1">';
      anomH+=probItem('Модем отключен','offline',rtOffline,'var(--danger)');
      anomH+=probItem('Низкая скорость','speed',rtLowSpeed,'var(--warning)');
      anomH+=probItem('Завис IP','ipstuck',rtStuckIp,'var(--warning)');
      anomH+=probItem('Сбоит прокси','flaky',flakyItems,'var(--danger)');
      anomH+='</div>';
      anomH+='</div>';

      // --- Ресурсы по категориям (TOP 4) ---
      var recH='<div class="analytics-card" style="margin:0"><div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px;flex-shrink:0">🌐 Ресурсы по категориям</div><div id="analyticsCatBars"><div style="color:var(--text-3);font-size:11px;padding:4px 0">Загрузка...</div></div></div>';

      // --- Тренд месяца (6-bar vertical chart, data from API) ---
      var trendH='<div class="analytics-card" style="margin:0;display:flex;flex-direction:column">';
      trendH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:10px;flex-shrink:0">📈 Тренд</div>';
      trendH+='<div id="trendBarsWrap" style="display:flex;align-items:flex-end;gap:4px;flex:1;min-height:40px;margin-bottom:4px">';
      trendH+='<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:9px">...</div>';
      trendH+='</div>';
      trendH+='<div id="trendLabelsWrap" style="display:flex;gap:2px;margin-bottom:4px"></div>';
      trendH+='</div>';

      // Operators card
      var allOps={};
      Object.keys(d.serverOpTraffic).forEach(function(s){
        Object.keys(d.serverOpTraffic[s]).forEach(function(op){
          if(!op)return;
          if(!allOps[op])allOps[op]={t:0,cnt:0};
          var v=d.serverOpTraffic[s][op];
          allOps[op].t+=v.tIn+v.tOut;
          allOps[op].cnt+=v.count;
        });
      });
      var opDays=getDaysElapsed();
      var opList=Object.keys(allOps).sort(function(a,b){return allOps[b].t-allOps[a].t});
      var opMax=opList.length?(allOps[opList[0]].t/opDays)||1:1;
      var opH='<div class="analytics-card" style="margin:0">';
      opH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px">📡 Операторы</div>';
      opList.forEach(function(op,oi){
        var v=allOps[op];
        var flag='';var opL=op.toLowerCase();
        if(opL.indexOf('orange ro')!==-1||opL.indexOf('vodafone ro')!==-1)flag='🇷🇴 ';
        else if(opL.indexOf('orange md')!==-1||opL.indexOf('moldtelecom')!==-1)flag='🇲🇩 ';
        var avg_per_modem_day=fmtGb(v.cnt&&opDays?v.t/v.cnt/opDays:0);
        var total_per_day=v.t/opDays;
        var w=Math.max(total_per_day/opMax*100,2);
        var col=CHART_COLORS.operators[oi%CHART_COLORS.operators.length];
        var opTotalGb=fmtGb(v.t);
        var opTotalDay=fmtGb(total_per_day);
        var opEsc=op.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        opH+='<div style="margin-bottom:8px;cursor:pointer" onmouseenter="showOpTT(\''+opEsc+'\',\''+opTotalGb+'\',\''+opTotalDay+'\',\''+avg_per_modem_day+'\','+v.cnt+',event)" onmouseleave="hideFloatTooltip(\'opTT\')">';
        opH+='<div style="display:flex;align-items:baseline;font-size:10px;margin-bottom:2px;gap:4px">';
        opH+='<span style="flex:1;color:var(--text-1);font-weight:500">'+flag+esc(op)+'</span>';
        opH+='<span style="color:var(--text-2)">'+avg_per_modem_day+'/мод/сут</span>';
        opH+='<span style="color:var(--text-3)">·</span>';
        opH+='<span style="color:var(--text-3)">'+v.cnt+' мод.</span>';
        opH+='</div>';
        opH+='<div style="height:4px;background:var(--bg-3);border-radius:2px"><div style="height:4px;border-radius:2px;background:'+col+';width:'+w+'%"></div></div>';
        opH+='</div>';
      });
      opH+='</div>';

      // 4 cards: anomaly, resources-by-category, trend, operators
      extRow.style.gridTemplateColumns='repeat(4,1fr)';extRow.style.alignItems='stretch';
      extRow.innerHTML=anomH+recH+trendH+opH;
      loadTrendData();
      loadAnalyticsCategoryCard();
    }

    // Matrix
    renderTrafficMatrix(d);

    // Client table (flex layout with sparkline + trend)
    var clientNamesOv=Object.keys(d.clientTraffic).filter(function(n){return d.clientTraffic[n].modems>0}).sort(function(a,b){return(d.clientTraffic[b].tIn+d.clientTraffic[b].tOut)-(d.clientTraffic[a].tIn+d.clientTraffic[a].tOut)});
    var totalAllOv=d.totalIn+d.totalOut||1;
    var daysEl=getDaysElapsed();
    // Header row — flex proportional columns filling full width
    var hc='<div class="ct-header" style="display:flex;align-items:center;padding:4px 0;border-bottom:2px solid var(--border);font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">';
    hc+='<div style="width:4px;flex-shrink:0"></div>';
    hc+='<div style="flex:2.2;padding:0 10px;min-width:0">Клиент</div>';
    hc+='<div style="flex:0.7;text-align:center">Live</div>';
    hc+='<div style="flex:1;text-align:center">Посл.час</div>';
    hc+='<div style="flex:1;text-align:center">Сегодня</div>';
    hc+='<div style="flex:1;text-align:center">Вчера</div>';
    hc+='<div style="flex:1;text-align:center;font-weight:600">Месяц</div>';
    hc+='<div style="flex:1;text-align:center">Пр.месяц</div>';
    hc+='<div style="flex:0.9;text-align:center">14 дней</div>';
    hc+='<div style="flex:0.9;text-align:center">Тренд</div>';
    hc+='</div>';
    clientNamesOv.forEach(function(n,i){
      var c=d.clientTraffic[n];var total=c.tIn+c.tOut;
      var liveColor=c.online===c.modems?'var(--success)':(c.online>0?'var(--warning)':'var(--danger)');
      var clientColor=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
      var sharePct=pct(total,totalAllOv);
      // Compute today, yesterday, month from modemTraffic
      var clientModems=d.modemTraffic.filter(function(m){return m.pn===n});
      var todayBytes=clientModems.reduce(function(s,m){return s+(m.dayIn||0)+(m.dayOut||0)},0);
      var clientObj=(currentData.clients||[]).find(function(cl){return cl.portName===n});
      var lhGb=clientObj?((currentData.clientLastHourGb||{})[clientObj.id]||0):0;
      var lhStr=lhGb>0?(lhGb>=1?lhGb.toFixed(2)+' GB':Math.round(lhGb*1024)+' MB'):'—';
      var yestBytes=clientModems.reduce(function(s,m){return s+(m.yestIn||0)+(m.yestOut||0)},0);
      var monBytes=clientModems.reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
      var prevMonBytes=clientModems.reduce(function(s,m){return s+(m.prevIn||0)+(m.prevOut||0)},0);
      // Trend: first N days this month vs first N days prev month (from server clientTrend)
      var ctVal=(currentData.clientTrend||{})[n];
      var trendStr='—';var trendColor='var(--text-3)';
      if(ctVal!==undefined&&ctVal!==null){
        var tc=ctVal>=0?'var(--success)':'var(--danger)';
        var ts=ctVal>999?'+999%+':(ctVal<-99?'<−99%':(ctVal>=0?'+':'')+ctVal+'%');
        trendStr=ts;trendColor=tc;
      }
      // Sparkline: 14 bars from real daily cache data
      var spkDays=14,spkPts=[],spkDates=[];
      var spkNow=new Date();
      for(var di=spkDays-1;di>=0;di--){
        var spkD=new Date(spkNow);spkD.setDate(spkD.getDate()-di);
        var spkDs=spkD.getFullYear()+'-'+String(spkD.getMonth()+1).padStart(2,'0')+'-'+String(spkD.getDate()).padStart(2,'0');
        var spkEntry=window._dailyTrafficCache&&window._dailyTrafficCache[n]&&typeof window._dailyTrafficCache[n]==='object'&&window._dailyTrafficCache[n][spkDs];
        spkPts.push(spkEntry?((spkEntry.in||0)+(spkEntry.out||0)):0);
        spkDates.push(spkDs);
      }
      window._spkData=window._spkData||{};
      window._spkData[n]={dates:spkDates,pts:spkPts};
      var spkMax=Math.max.apply(null,spkPts)||1;
      var spkBarW=4;
      var spkClientKey=n.replace(/'/g,"\\'");
      var sparkH='<div style="display:inline-flex;align-items:flex-end;gap:1px;height:16px;width:'+(spkBarW*spkDays+spkDays-1)+'px;flex-shrink:0;vertical-align:middle">';
      for(var si=0;si<spkDays;si++){
        var hPx=spkPts[si]>0?Math.max(Math.round(spkPts[si]/spkMax*14),2):1;
        var isToday=si===spkDays-1;
        sparkH+='<div style="width:'+spkBarW+'px;height:'+hPx+'px;background:'+clientColor+';border-radius:1px 1px 0 0;opacity:'+(isToday?'1':'0.5')+';cursor:pointer"';
        sparkH+=' onmouseenter="showSpkTT(\''+spkClientKey+'\','+si+',event)" onmouseleave="hideFloatTooltip(\'spkTT\')"></div>';
      }
      sparkH+='</div>';
      hc+='<div class="ct-row" data-client="'+esc(n)+'" onclick="selectClient(\''+esc(n)+'\')">';
      hc+='<div class="ct-color" style="width:4px;height:36px;background:'+clientColor+';flex-shrink:0;border-radius:2px 0 0 2px"></div>';
      hc+='<div class="ct-name" style="flex:2.2;padding:0 10px;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">'+esc(n)+'</div>';
      hc+='<div class="ct-live" style="flex:0.7;text-align:center;font-size:11px;font-weight:600;color:'+liveColor+'">'+c.online+'/'+c.modems+'</div>';
      hc+='<div class="ct-metrics" style="display:contents">';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;font-family:var(--font-mono);color:'+(lhGb>0?'var(--text-0)':'var(--text-3)')+'"><span class="ct-metric-label">Посл.час</span><span class="ct-metric-value">'+lhStr+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;font-family:var(--font-mono)"><span class="ct-metric-label">Сегодня</span><span class="ct-metric-value">'+fmtGb(todayBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;color:var(--text-2);font-family:var(--font-mono)"><span class="ct-metric-label">Вчера</span><span class="ct-metric-value">'+fmtGb(yestBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:12px;font-weight:500;font-family:var(--font-mono)"><span class="ct-metric-label">Месяц</span><span class="ct-metric-value">'+fmtGb(monBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;color:var(--text-2);font-family:var(--font-mono)"><span class="ct-metric-label">Пр.месяц</span><span class="ct-metric-value">'+fmtGb(prevMonBytes)+'</span></div>';
      hc+='<div class="ct-metric ct-trend-mobile" style="display:none"><span class="ct-metric-label">Тренд</span><span class="ct-metric-value" style="color:'+trendColor+'">'+trendStr+'</span></div>';
      hc+='</div>';
      hc+='<div class="ct-sparkline" style="flex:0.9;display:flex;align-items:center;justify-content:center">';
      hc+=sparkH;
      hc+='</div>';
      hc+='<div class="ct-trend" style="flex:0.9;text-align:center;font-size:10px;font-weight:600;color:'+trendColor+'">'+trendStr+'</div>';
      // share % removed
      hc+='</div>';
    });
    var ctEl=document.getElementById('clientTrafficTable');
    if(ctEl)ctEl.innerHTML=hc;

    // Anomaly data is shown in the "⚠ Проблемы" card — no separate block needed

    // Daily chart
    var chartEl=document.getElementById('chartDailyClientTraffic');
    if(!chartEl)return;
    if(!window._dailyTrafficCache){
      chartEl.parentElement.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:12px">Загрузка графика...</div>';
      api(API+'/api/admin/daily_traffic')
        .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
        .then(function(data){
          window._dailyTrafficCache=data;
          // restore canvas
          var wrap=document.querySelector('#acc-overview .chart-wrap-daily');
          if(wrap){wrap.innerHTML='<canvas id="chartDailyClientTraffic"></canvas>';}
          renderDailyClientChart(data,cc);
          // re-render client table now that cache is available (sparklines use real data)
          var activeSub=document.querySelector('.acc-sub-tab.active');
          if(activeSub&&activeSub.id.replace('acc-tab-','').replace('acc-','')!=='resources')renderAccSubTab('overview');
        })
        .catch(function(e){
          var w=document.querySelector('#acc-overview .chart-wrap-daily');
          if(w)w.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);font-size:12px">Ошибка загрузки графика: '+(esc(e.message))+'</div>';
        });
    } else {renderDailyClientChart(window._dailyTrafficCache,cc);}
    // Init heatmap once on first overview load
    if(!window._heatmapInitialized){
      window._heatmapInitialized=true;
      _heatmapConfig.client=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:c.modemCount||1}});
      renderHeatmapSubTabs();
      loadHeatmapData();
      renderLatencySubTabs();
      loadLatencyStats();
    }
    // Auto-load Top resources on first Трафик view. The aggregate endpoint
    // returns cached data (no server-side rescrape), so this is cheap.
    if (!topHostsCache) loadTopHosts();
  }
  else if(name==='infra'){
    // Combined «Инфраструктура» — Rotations + IP analytics + Capacity stacked.
    renderSysRotations('acc-infra-rotations', 'sysInfraDays');
    renderSysIp('acc-infra-ip', 'sysInfraDays');
    renderSysCapacity('acc-infra-capacity', 'sysInfraDays');
  }
  else if(name==='finances'){
    renderFinancesTab(d);
  }
}


// ==================== RESOURCES BY CATEGORY CARD ====================
var _topHostsCacheGlobal=null;
function loadAnalyticsCategoryCard(elId){
  elId=elId||'analyticsCatBars';
  var el=document.getElementById(elId);
  if(!el)return;
  if(_topHostsCacheGlobal){renderAnalyticsCategoryCard(_topHostsCacheGlobal,el);return;}
  api(API+'/api/admin/top_hosts_aggregated')
    .then(function(d){_topHostsCacheGlobal=d.data||{};renderAnalyticsCategoryCard(_topHostsCacheGlobal,el);})
    .catch(function(){var el2=document.getElementById(elId);if(el2)el2.innerHTML='<div style="color:var(--text-3);font-size:11px">Нет данных</div>';});
}
var _catIcons={'Социальные сети':'👥','Поисковики':'🔍','Видео':'🎬','Мессенджеры':'💬','CDN/Облако':'☁️','Реклама':'📢','Почта':'📧','Прочее':'📦','Маркетплейсы':'🛒','Новости':'📰','Игры':'🎮'};
function renderAnalyticsCategoryCard(data,el){
  if(!el)return;
  var cats={};
  Object.keys(data).forEach(function(h){var cat=categorize(h);if(!cats[cat])cats[cat]=0;cats[cat]+=data[h]});
  var catList=Object.keys(cats).sort(function(a,b){return cats[b]-cats[a]}).slice(0,4);
  if(!catList.length){el.innerHTML='<div style="color:var(--text-3);font-size:11px">Нет данных</div>';return;}
  var total=catList.reduce(function(s,c){return s+cats[c]},0)||1;
  var h='';
  catList.forEach(function(cat){
    var cnt=cats[cat],p=Math.round(cnt/total*100);
    var col=CHART_COLORS.categories[cat]||'#B4B2A9';
    var icon=_catIcons[cat]||'📁';
    h+='<div style="margin-bottom:7px">';
    h+='<div style="display:flex;align-items:baseline;margin-bottom:2px;font-size:11px">';
    h+='<span style="flex:1;color:var(--text-0)">'+icon+' '+esc(cat)+'</span>';
    h+='<span style="font-size:10px;color:var(--text-2);font-weight:500">'+p+'%</span>';
    h+='</div>';
    h+='<div style="height:5px;background:var(--bg-3);border-radius:2px"><div style="height:5px;border-radius:2px;background:'+col+';width:'+p+'%"></div></div>';
    h+='</div>';
  });
  el.innerHTML=h;
}

// ==================== TREND CARD ====================
var _trendData=null;
function loadTrendData(sfx){
  if(_trendData){renderTrendCard(_trendData,sfx);return;}
  api(API+'/api/analytics/monthly_traffic?months=6')
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_trendData=data;renderTrendCard(data,sfx);})
    .catch(function(){});
}
function trendFmt(gb){if(!gb&&gb!==0)return'0 МБ';if(gb>=1000)return(gb/1000).toFixed(1)+' ТБ';if(gb>=1)return gb.toFixed(1)+' ГБ';return Math.round(gb*1024)+' МБ';}
var _MONTHS_RU_GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function fmtDateRuLong(ds){if(!ds)return'—';var p=ds.split('-');if(p.length<3)return ds;var m=parseInt(p[1],10)-1,day=parseInt(p[2],10);return day+' '+(_MONTHS_RU_GEN[m]||'');}
function pluralModem(n){var a=Math.abs(n)%100,b=a%10;if(a>10&&a<20)return n+' модемов';if(b>1&&b<5)return n+' модема';if(b===1)return n+' модем';return n+' модемов';}
function pluralPort(n){var a=Math.abs(n)%100,b=a%10;if(a>10&&a<20)return n+' портов';if(b>1&&b<5)return n+' порта';if(b===1)return n+' порт';return n+' портов';}
var _MSK_OFFSET=3;
function fmtHourMsk(hr){return String((hr+_MSK_OFFSET)%24).padStart(2,'0')+':00';}
function renderTrendCard(months,sfx){sfx=sfx||'';
  // Дашбордная карточка «Потребление трафика» — полноценный Chart.js как MRR.
  // Старая карточка «Тренд» на Трафике осталась на DOM-столбиках (sfx='').
  if(sfx==='New'){ renderTrendChartNew(months); return; }
  var wrap=document.getElementById('trendBarsWrap'+sfx);
  var labWrap=document.getElementById('trendLabelsWrap'+sfx);
  if(!wrap||!labWrap||!months||!months.length)return;
  var maxVal=Math.max.apply(null,months.map(function(m){return m.forecast_gb||m.total_gb}));
  if(!maxVal)maxVal=1;
  var CHART_H=Math.max(wrap.offsetHeight-4,40)||68;
  function bPx(gb){return Math.max(Math.round(gb/maxVal*CHART_H),2);}
  var bH='';
  months.forEach(function(m,i){
    var factPx=bPx(m.total_gb);
    var fcPx=m.is_current&&m.forecast_gb>m.total_gb?bPx(m.forecast_gb-m.total_gb):0;
    var bg='#185FA5';
    // Ширина/зазор столбца — как в MRR: столбец занимает ~48% слота по центру
    // (barPercentage 0.6 × categoryPercentage 0.8), потолок = maxBarThickness 22.
    bH+='<div style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer"';
    bH+=' onmouseenter="onTrendHover('+i+',event)" onmouseleave="onTrendLeave()">';
    if(fcPx>0)bH+='<div style="width:48%;max-width:22px;height:'+fcPx+'px;background:#85B7EB;border-radius:3px 3px 0 0;opacity:.7"></div>';
    bH+='<div style="width:48%;max-width:22px;height:'+factPx+'px;background:'+bg+';border-radius:'+(fcPx>0?'0':'3px 3px')+' 0 0;transition:opacity .12s"></div>';
    bH+='</div>';
  });
  wrap.innerHTML=bH;
  var lH='';
  months.forEach(function(m){
    lH+='<div style="flex:1;text-align:center;font-size:8px;color:'+(m.is_current?'#185FA5':'#9b9b98')+';font-weight:'+(m.is_current?'600':'400')+'">'+(/^\d{4}-\d{2}/.test(m.label||'')?_ymRu(m.label,true):(m.label||''))+'</div>';
  });
  labWrap.innerHTML=lH;
  // Зазор больше не нужен: расстояние задаётся свободными 52% внутри слота (как в MRR).
  // Тот же gap у подписей, иначе месяцы уедут относительно столбцов.
  wrap.style.gap='0px';
  labWrap.style.gap='0px';
  window._trendMonths=months;
  var sumEl=document.getElementById('trendSum'+sfx);
  if(sumEl){
    var tot=months.reduce(function(a,m){return a+(m.total_gb||0);},0);
    var cur=months[months.length-1]||{}, prev=months[months.length-2]||{};
    var cv=(cur.is_current&&cur.forecast_gb)?cur.forecast_gb:(cur.total_gb||0);
    var pv=prev.total_gb||0;
    var dl=pv>0?Math.round((cv-pv)/pv*100):null;
    sumEl.innerHTML='<span>Σ '+trendFmt(tot)+'</span>'+(dl==null?'':'<span style="color:'+(dl>=0?'var(--success)':'var(--danger)')+'">'+(dl>=0?'↑ +':'↓ −')+Math.abs(dl)+'% к пред. мес</span>');
  }
}
// «Потребление трафика» (дашборд) — 1:1 с MRR: та же геометрия столбцов
// (CHART_BAR_STACK + chartStackRadius + maxBarThickness 22), сетка и ось объёма
// слева, названия месяцев внизу, стек Факт + Прогноз (как «За ГБ»/«За модем»).
function renderTrendChartNew(months){
  if(!months||!months.length) return;
  window._trendMonths=months;
  var lg=document.getElementById('trendLegendNew');
  if(lg) lg.innerHTML=[['Факт','#185FA5'],['Прогноз','#85B7EB']].map(function(x){
    return '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[1]+'"></span>'+x[0]+'</span>';
  }).join('');
  var cv=document.getElementById('newTrendCanvas'); if(!cv||!window.Chart) return;
  if(window._newTrendChart){ try{window._newTrendChart.destroy();}catch(_){} window._newTrendChart=null; }
  var cc=getChartColorsLight();
  var barOpts=Object.assign({stack:'t', borderRadius:chartStackRadius()}, CHART_BAR_STACK, {maxBarThickness:22});
  // Короткие названия месяцев (Фев/Мар) — влезают горизонтально, без поворота,
  // поэтому карточка ниже. Как в MRR.
  var labels=months.map(function(m){ return m.month ? _ymRu(m.month,true) : (m.label||''); });
  var fact=months.map(function(m){ return m.total_gb||0; });
  var fcast=months.map(function(m){ return (m.is_current && m.forecast_gb>m.total_gb) ? (m.forecast_gb-m.total_gb) : 0; });
  window._newTrendChart=newChartSafe(cv,{
    type:'bar',
    data:{ labels:labels, datasets:[
      Object.assign({label:'Факт', data:fact, backgroundColor:'#185FA5'}, barOpts),
      Object.assign({label:'Прогноз', data:fcast, backgroundColor:'#85B7EB'}, barOpts)
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{mode:'index',intersect:false,
          callbacks:{label:function(ctx){return ctx.dataset.label+': '+trendFmt(ctx.parsed.y||0);},
            footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+trendFmt(t);}}}},
      scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,minRotation:0,autoSkip:false},grid:{display:false},border:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v===0?'0':(v>=1000?(v/1000)+' ТБ':v+' ГБ');}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
  });
}
function onTrendHover(idx,event){
  var months=window._trendMonths;if(!months)return;
  var m=months[idx];if(!m)return;
  var prev=idx>0?months[idx-1]:null;
  var ch=prev&&prev.total_gb>0?Math.round((m.total_gb-prev.total_gb)/prev.total_gb*100):null;
  var lines=[m.label+': <b>'+trendFmt(m.total_gb)+'</b>'];
  if(m.forecast_gb)lines.push('Прогноз: ~'+trendFmt(m.forecast_gb));
  if(ch!==null){var cc2=ch>=0?'#3B6D11':'#A32D2D';lines.push('vs предыдущий: <span style="color:'+cc2+';font-weight:600">'+(ch>=0?'+':'')+ch+'%</span>');}
  showFloatTooltip('trendTT',event,lines);
}
function onTrendLeave(){
  hideFloatTooltip('trendTT');
}
function showFloatTooltip(id,event,lines){
  var tt=document.getElementById(id);
  if(!tt){tt=document.createElement('div');tt.id=id;tt.style.cssText='position:fixed;z-index:9999;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:130px;line-height:1.6';document.body.appendChild(tt);}
  tt.innerHTML=lines.join('<br>');tt.style.display='block';
  tt.style.left='-9999px';tt.style.top='-9999px';
  var tw=tt.offsetWidth||200,th=tt.offsetHeight||100;
  var x=event.clientX+12,y=event.clientY-20;
  if(x+tw+8>window.innerWidth)x=event.clientX-tw-12;
  if(y+th+8>window.innerHeight)y=event.clientY-th-8;
  if(x<4)x=4;if(y<4)y=4;
  tt.style.left=x+'px';tt.style.top=y+'px';
}
function hideFloatTooltip(id){var tt=document.getElementById(id);if(tt)tt.style.display='none';}
function showSpkTT(clientKey,idx,event){
  var d=window._spkData&&window._spkData[clientKey];
  if(!d)return;
  var dateStr=d.dates[idx]||'';
  var bytes=d.pts[idx]||0;
  var isToday=idx===d.dates.length-1;
  var label=isToday?'Сегодня':fmtDateRuLong(dateStr);
  var lines=['<b>'+label+'</b>',fmtGb(bytes)+(bytes?'':' — нет данных')];
  showFloatTooltip('spkTT',event,lines);
}
function showOpTT(op,total,perDay,perModem,cnt,event){
  var lines=['<b>'+op+'</b>','Всего: '+total,'В сутки: '+perDay,'На модем/сутки: '+perModem,'Модемов: '+cnt];
  showFloatTooltip('opTT',event,lines);
}

// ==================== HEATMAP ====================
var _heatmapView='country',_heatmapId='all',_heatmapCache={};
var _newHmCache={};
// Контексты тепловой карты: «Трафик» (по умолчанию) и NEW. Обе вкладки рендерятся
// ОДНИМ кодом (renderHeatmap/renderHeatmapSubTabs/...); ctx подменяет только
// состояние (view/id/cache) и DOM-id — поэтому NEW = 1:1 со страницей «Трафик».
var _hmTraffic={get view(){return _heatmapView;},set view(v){_heatmapView=v;},get id(){return _heatmapId;},set id(v){_heatmapId=v;},cache:_heatmapCache,grid:'heatmapGrid',summary:'heatmapSummary',subtabs:'heatmapSubTabs',tabPrefix:'hmTab',tabClass:false,ttId:'heatTT',dataKey:'_heatmapData',self:''};
var _hmNew={get view(){return _newHmView;},set view(v){_newHmView=v;},get id(){return _newHmId;},set id(v){_newHmId=v;},cache:_newHmCache,grid:'newHmGrid',summary:'newHmSummary',subtabs:'newHmSubTabs',tabPrefix:'newHmTab',tabClass:true,ttId:'newHeatTT',dataKey:'_newHeatmapData',self:'_hmNew'};
// Stage 17 — `operator` list is now built DYNAMICALLY from
// /api/admin/operators (see refreshOperatorList() at end of file). Hardcoded
// fallback below is used only during first paint, before the API answers,
// and gets replaced as soon as the list arrives. This way new operators like
// digi appear in the dropdown automatically without an admin.js edit.
var _heatmapConfig={
  country:[{id:'all',label:'🌍 Все страны',modems:51},{id:'moldova',label:'🇲🇩 Молдова',modems:28},{id:'romania',label:'🇷🇴 Румыния',modems:23}],
  operator:[{id:'orange_ro',label:'🇷🇴 Orange RO',modems:6},{id:'vodafone_ro',label:'🇷🇴 Vodafone RO',modems:17},{id:'moldtelecom',label:'🇲🇩 Moldtelecom',modems:23},{id:'orange_md',label:'🇲🇩 Orange MD',modems:5}],
  client:[]
};
function hmAccent(view,id){
  var m={all:'#185FA5',moldova:'#185FA5',romania:'#1D9E75',orange_ro:'#185FA5',vodafone_ro:'#1D9E75',moldtelecom:'#D85A30',orange_md:'#BA7517'};
  if(m[id])return m[id];
  var cls=currentData&&currentData.clients||[];
  var i=cls.findIndex(function(c){return c.portName===id});
  return CHART_COLORS.clients[Math.max(i,0)%CHART_COLORS.clients.length]||'#185FA5';
}
function setHeatmapView(view,ctx){
  ctx=ctx||_hmTraffic;
  ctx.view=view;
  if(view==='client'){_heatmapConfig.client=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:c.modemCount||1}});}
  var cfg=_heatmapConfig[view]||[];
  if(cfg.length)ctx.id=cfg[0].id;
  ['country','operator','client'].forEach(function(v){
    var btn=document.getElementById(ctx.tabPrefix+v.charAt(0).toUpperCase()+v.slice(1));
    if(!btn)return;var active=v===view;
    if(ctx.tabClass){ btn.classList.toggle('active',active); }
    else{ btn.style.borderBottomColor=active?'var(--accent)':'transparent';
      btn.style.color=active?'var(--accent)':'var(--text-2)';btn.style.fontWeight=active?'600':'500'; }
  });
  renderHeatmapSubTabs(ctx);loadHeatmapData(ctx);
}
function renderHeatmapSubTabs(ctx){
  ctx=ctx||_hmTraffic;
  var c=document.getElementById(ctx.subtabs);if(!c)return;
  var view=ctx.view;
  var cfg=view==='client'?(currentData&&currentData.clients||[]).filter(function(x){return x.modemCount>0}).map(function(x){return{id:x.portName,label:x.name,modems:x.modemCount||1};}):(_heatmapConfig[view]||[]);
  var h='';
  cfg.forEach(function(item){
    var active=item.id===ctx.id;var col=hmAccent(view,item.id);
    // По макету чипы — чистый текст, без флагов/глобуса из конфига
    var lbl=String(item.label||'').replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}☀-➿]/gu,'').trim();
    h+='<button onclick="selectHeatId(\''+esc(item.id)+'\''+(ctx.self?','+ctx.self:'')+')" style="background:'+(active?col:'var(--bg-3)')+';color:'+(active?'#fff':'var(--text-1)')+';border:none;border-radius:999px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:'+(active?'600':'400')+';transition:all .15s">'+esc(lbl)+'</button>';
  });
  c.innerHTML=h;
}
function selectHeatId(id,ctx){ctx=ctx||_hmTraffic;ctx.id=id;if(ctx===_hmNew)_dashUiSave({hmId:id});renderHeatmapSubTabs(ctx);loadHeatmapData(ctx);}
function loadHeatmapData(ctx){
  ctx=ctx||_hmTraffic;
  var key=ctx.view+'|'+ctx.id;
  if(ctx.cache[key]){renderHeatmap(ctx.cache[key],ctx);return;}
  var g=document.getElementById(ctx.grid);
  if(g)g.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:160px;color:var(--text-3);font-size:12px">Загрузка...</div>';
  api(API+'/api/analytics/heatmap?view='+ctx.view+'&id='+encodeURIComponent(ctx.id)+'&days=7')
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){ctx.cache[key]=data;renderHeatmap(data,ctx);})
    .catch(function(e){var g=document.getElementById(ctx.grid);if(g)g.innerHTML='<div style="padding:20px;color:var(--danger);font-size:12px">Ошибка: '+(esc(e.message))+'</div>';});
}
function lerpCol(a,b,t){
  var ah=parseInt(a.slice(1),16),bh=parseInt(b.slice(1),16);
  var r=Math.round(((ah>>16)&255)+(((bh>>16)&255)-((ah>>16)&255))*t);
  var g=Math.round(((ah>>8)&255)+(((bh>>8)&255)-((ah>>8)&255))*t);
  var bl=Math.round((ah&255)+((bh&255)-(ah&255))*t);
  return'#'+(r<16?'0':'')+r.toString(16)+(g<16?'0':'')+g.toString(16)+(bl<16?'0':'')+bl.toString(16);
}
function darkenCol(hex,amt){
  var h=parseInt(hex.slice(1),16);
  return'#'+[[(h>>16)&255],[(h>>8)&255],[h&255]].map(function(v){return Math.max(0,Math.round(v[0]*(1-amt))).toString(16).padStart(2,'0')}).join('');
}
function heatColor(val,maxV,accent){
  if(!val||!maxV)return'var(--bg-3)';
  var t=Math.pow(val/maxV,0.55);
  if(t<0.4)return lerpCol('#F1F1EF','#85B7EB',t/0.4);
  if(t<0.8)return lerpCol('#85B7EB',accent,(t-0.4)/0.4);
  return lerpCol(accent,darkenCol(accent,0.35),(t-0.8)/0.2);
}
function renderHeatmap(data,ctx){
  ctx=ctx||_hmTraffic;
  var g=document.getElementById(ctx.grid),sum=document.getElementById(ctx.summary);
  if(!g||!data||!data.matrix)return;
  var mat=data.matrix,days=data.meta&&data.meta.days||[],dm=data.meta&&data.meta.day_meta||[];
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var accent=hmAccent(ctx.view,ctx.id);
  // Build per-modem matrix for coloring and display
  var perModem=mat.map(function(row){return row.map(function(v){return v/mDiv;})});
  var maxV=0;perModem.forEach(function(row){row.forEach(function(v){if(v>maxV)maxV=v;})});
  var DAYS_RU=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  var h='<div style="min-width:560px">';
  h+='<div style="display:flex;margin-left:58px;margin-bottom:4px">';
  for(var hi=0;hi<24;hi+=2){
    h+='<div style="flex:1;text-align:center;font-size:9px;color:#9b9b98">'+String(hi).padStart(2,'0')+'</div>';
    h+='<div style="flex:1"></div>';
  }
  h+='</div>';
  mat.forEach(function(row,di){
    var ds=days[di]||'';var dMeta=dm[di]||{};
    var d=new Date(ds+'T00:00:00');
    var dn=DAYS_RU[d.getDay()]||dMeta.label||'';
    var dShort=fmtDateRuLong(ds);
    h+='<div style="display:flex;align-items:center;margin-bottom:3px">';
    h+='<div style="width:58px;font-size:10px;color:#6b6b68;flex-shrink:0;text-align:right;padding-right:8px;line-height:1.3">';
    h+='<div style="font-weight:500">'+dn+'</div><div style="font-size:9px;color:#9b9b98">'+dShort+'</div></div>';
    h+='<div style="display:flex;flex:1;gap:2px">';
    row.forEach(function(val,hr){
      var pmVal=perModem[di][hr];
      var col=heatColor(pmVal,maxV,accent);
      var isCorrected=data.meta&&data.meta.corrected&&data.meta.corrected[di]&&data.meta.corrected[di][hr];
      // Diagonal-stripe overlay marks cells whose underlying hour rows have
      // uncertain>0 (counter anomaly or gap-fill). Base colour still encodes
      // the value so the heatmap stays readable.
      var bg = isCorrected
        ? col+';background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 3px, transparent 3px 6px)'
        : col;
      h+='<div style="flex:1;height:28px;border-radius:3px;background:'+bg+';cursor:pointer;transition:opacity .1s;position:relative"';
      h+=' onmouseenter="showHeatTT('+di+','+hr+',event,this'+(ctx.self?','+ctx.self:'')+')" onmouseleave="hideFloatTooltip(\''+ctx.ttId+'\')">';
      if(isCorrected)h+='<span style="position:absolute;top:1px;right:2px;font-size:9px;line-height:1;color:rgba(0,0,0,0.55);font-weight:600" title="Час содержит данные восстановленные после сбоя счётчика — значение приблизительное">⚠</span>';
      h+='</div>';
    });
    h+='</div></div>';
  });
  // Legend (per-modem scale)
  h+='<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:10px;color:#9b9b98">';
  h+='<span>0</span><div style="display:flex;gap:2px">';
  for(var li=0;li<=8;li++)h+='<div style="width:16px;height:10px;border-radius:2px;background:'+heatColor(li/8*maxV,maxV,accent)+'"></div>';
  h+='</div><span>'+trendFmt(maxV)+'/мод</span></div>';
  h+='</div>';
  g.innerHTML=h;
  // Summary metrics
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var flat=[];mat.forEach(function(r){r.forEach(function(v){flat.push(v);})});
  var total=flat.reduce(function(a,b){return a+b},0);
  var n=mat.length||7;
  var dTotals=mat.map(function(r){return r.reduce(function(a,b){return a+b},0)});
  var hTotals=Array.from({length:24},function(_,hh){return mat.reduce(function(s,r){return s+(r[hh]||0)},0)});
  var peakH=hTotals.indexOf(Math.max.apply(null,hTotals));
  var positiveHours=hTotals.filter(function(v){return v>0});
  var quietH=positiveHours.length>0?hTotals.indexOf(Math.min.apply(null,positiveHours)):0;
  var peakD=dTotals.indexOf(Math.max.apply(null,dTotals));
  var nightTotal=flat.filter(function(_,i){var hh=i%24;return hh>=0&&hh<=5;}).reduce(function(a,b){return a+b},0);
  var nightPct=total>0?Math.round(nightTotal/total*100):0;

  if(sum){
    sum.style.display='flex';
    sum.innerHTML=
      hmSumItem('Всего за 7 дней',trendFmt(total),pluralModem(mCnt),false)
      +hmSumItem('Ср. на модем/сут',(n&&mDiv)?trendFmt(total/n/mDiv):'—',(n?trendFmt(total/n):'—')+' среднесуточно',false)
      +hmSumItem('Пиковый час',String(peakH).padStart(2,'0')+':00',(n&&mDiv)?trendFmt(hTotals[peakH]/n/mDiv)+'/мод в среднем':'—',true)
      +hmSumItem('Тихий час',String(quietH).padStart(2,'0')+':00','Лучшее время для тех. работ',false)
      +hmSumItem('Пиковый день',(dm[peakD]?dm[peakD].label+', '+fmtDateRuLong(days[peakD]||''):fmtDateRuLong(days[peakD]||'')),mDiv?trendFmt(dTotals[peakD]/mDiv)+'/мод':'—',true)
      +hmSumItem('Ночной трафик',nightPct+'%','00:00–06:00',false);
  }
  window[ctx.dataKey]=data;
}
function hmSumItem(label,val,sub,isPeak){
  return'<div style="flex:1;display:flex;flex-direction:column;gap:3px;padding:0 20px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:15px;font-weight:500;line-height:1.2;white-space:nowrap;'+(isPeak?'color:#185FA5':'color:var(--text-0)')+'">'+val+'</div>'
    +(sub?'<div style="font-size:10px;color:#9b9b98;white-space:nowrap">'+sub+'</div>':'')
    +'</div>';
}
// (removed _getOpModemsForView — the heatmap tooltip now derives per-operator
//  modem counts from the same historical breakdown as the bytes, so live counts
//  no longer mismatch the hour's traffic.)
function getHeatmapModems(ctx){
  ctx=ctx||_hmTraffic;
  var view=ctx.view,id=ctx.id;
  // Count unique modems (IMEIs) from status — not ports from bandwidth
  if(currentData&&currentData.status){
    var status=currentData.status||[];
    var byCountry={},byOp={},byClient={},totalModems=0;
    var seen={};
    status.forEach(function(m){
      var imei=m.modem_details&&m.modem_details.IMEI;if(!imei||seen[imei])return;
      seen[imei]=true;
      totalModems++;
      var srv=m._server||'';
      var cn=(COUNTRIES[srv]||{}).name||srv;
      byCountry[cn]=(byCountry[cn]||0)+1;
      var op=(function(){var r=(m.net_details?m.net_details.CELLOP:'')||'';var isRO=srv.indexOf('S2')===0;var _c=r.toLowerCase().replace(/\s+/g,' ').trim();var n={'unite':'Moldtelecom','moldtelecom':'Moldtelecom','moldtelecom moldtelecom':'Moldtelecom','orange':isRO?'Orange RO':'Orange MD','orange ro':'Orange RO','orange md':'Orange MD','vodafone ro':'Vodafone RO','vodafone':'Vodafone RO'};return n[_c]||r})();
      if(op)byOp[op]=(byOp[op]||0)+1;
      // Map IMEI to client portName via ports
      var ports=currentData.ports&&currentData.ports[imei];
      if(ports&&ports.length>0){var pn=ports[0].portName;if(pn)byClient[pn]=(byClient[pn]||0)+1;}
    });
    // Map country config ids to COUNTRIES names
    var _countryIdToName={'moldova':'Молдова','romania':'Румыния'};
    _heatmapConfig.country.forEach(function(c){
      if(c.id==='all')c.modems=totalModems;
      else{var target=_countryIdToName[c.id]||c.id;c.modems=byCountry[target]||0;}
    });
    _heatmapConfig.operator.forEach(function(o){
      var opName=o.label.replace(/[^\w\s]/g,'').trim();
      o.modems=byOp[opName]||0;
    });
  }
  // For clients — count PORTS (bandwidth entries), not modems
  // Each port generates its own traffic, so per-client heatmap divides by port count
  var cfg;
  if(view==='client'){
    var _byClient={};
    if(currentData&&currentData.bandwidth){for(var _bk in currentData.bandwidth){var _pn=currentData.bandwidth[_bk].portName;if(_pn)_byClient[_pn]=(_byClient[_pn]||0)+1;}}
    cfg=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:_byClient[c.portName]||0};});
  } else {
    cfg=_heatmapConfig[view]||[];
  }
  var found=cfg.find(function(s){return s.id===id});
  if(found&&found.modems!==undefined)return found.modems||0;
  // Fallback for 'all': use totalModems from status
  if(id==='all'&&currentData&&currentData.status){
    var _seen={};var _t=0;currentData.status.forEach(function(m){var i=m.modem_details&&m.modem_details.IMEI;if(i&&!_seen[i]){_seen[i]=1;_t++;}});
    return _t;
  }
  return 0;
}
function showHeatTT(di,hr,event,cell,ctx){
  ctx=ctx||_hmTraffic;
  var data=window[ctx.dataKey];if(!data||!data.matrix||!data.matrix[di])return;
  var mat=data.matrix;var days=data.meta&&data.meta.days||[];var dm=data.meta&&data.meta.day_meta||[];
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var val=mat[di][hr]||0;
  var DAYS_RU=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  var ds=days[di]||'';var d=new Date(ds+'T00:00:00');
  var dn=DAYS_RU[d.getDay()]||(dm[di]&&dm[di].label)||'';
  var dShort=fmtDateRuLong(ds);
  var hrEnd=String((hr+1)%24).padStart(2,'0');

  var tt=document.getElementById(ctx.ttId);
  if(!tt){tt=document.createElement('div');tt.id=ctx.ttId;tt.style.cssText='position:fixed;z-index:9999;pointer-events:none;background:#fff;border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:170px;box-shadow:0 4px 20px rgba(0,0,0,0.09)';document.body.appendChild(tt);}

  if(val<0.01){
    tt.innerHTML='<div style="font-size:11px;color:#9b9b98;margin-bottom:5px">'+dn+', '+dShort+' · '+String(hr).padStart(2,'0')+':00–'+hrEnd+':00</div>'
      +'<div style="font-size:20px;font-weight:500;color:#1a1a1a;line-height:1">—</div>'
      +'<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:8px 0"></div>'
      +'<div style="font-size:11px;color:#9b9b98;font-style:italic">Нет трафика</div>';
  } else {
    // Per-operator breakdown (scoped to current view). Counts AND bytes both come
    // from the same historical hour, so the tooltip is internally consistent:
    // the modem counts sum to the active-modem total used for "на модем", and the
    // per-operator GB sum to the cell total. Modems with an unresolved carrier are
    // shown under "Неизвестный" — never silently dropped from the count.
    var ops=(data.operator_breakdown&&data.operator_breakdown[di])?data.operator_breakdown[di][hr]:null;
    var histModems=0;
    if(ops){for(var _ok in ops){histModems+=((ops[_ok]&&ops[_ok].modems)||0);}}
    var mDivH=histModems||mDiv;
    var perModem=val/mDivH;

    tt.innerHTML='<div style="font-size:11px;color:#9b9b98;margin-bottom:5px">'+dn+', '+dShort+' · '+String(hr).padStart(2,'0')+':00–'+hrEnd+':00</div>'
      +'<div style="font-size:20px;font-weight:500;color:#1a1a1a;line-height:1">'+trendFmt(perModem)+' <span style="font-size:11px;font-weight:400;color:#9b9b98">на модем</span></div>';
    if(ops){
      var opArr=Object.keys(ops).map(function(k){var o=ops[k]||{};var m=o.modems||1;return{name:k,gb:(o.gb||0)/m,modems:o.modems||0,total:o.gb||0};}).filter(function(o){return o.total>0.0001;});
      if(opArr.length>0){
        opArr.sort(function(a,b){return b.total-a.total;});
        tt.innerHTML+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>';
        opArr.forEach(function(o){
          tt.innerHTML+='<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:2px 0"><span style="font-size:11px;color:#9b9b98">'+esc(o.name)+' <span style="font-size:9px">('+o.modems+')</span></span><span style="font-size:12px;font-weight:500;color:#1a1a1a">'+trendFmt(o.gb)+'</span></div>';
        });
      }
    }
    tt.innerHTML+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>'
      +'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:2px 0"><span style="font-size:11px;color:#9b9b98">Общий трафик</span><span style="font-size:12px;font-weight:500;color:#1a1a1a">'+trendFmt(val)+'</span></div>';
    // Сноска: всего модемов в выборке (у клиента) и по скольким пришли данные за этот час.
    if(mCnt>0){
      var _hm=Math.min(histModems||0,mCnt);
      tt.innerHTML+='<div style="font-size:10px;color:#9b9b98;margin-top:6px">Модемов: <b style="color:#1a1a1a;font-weight:600">'+mCnt+'</b> · с данными за час: <b style="color:#1a1a1a;font-weight:600">'+_hm+'</b></div>';
    }
    var isCorrected=data.meta&&data.meta.corrected&&data.meta.corrected[di]&&data.meta.corrected[di][hr];
    if(isCorrected)tt.innerHTML+='<div style="font-size:10px;color:#D4880F;margin-top:6px">⚠ Данные скорректированы</div>';
  }

  tt.style.display='block';tt.style.left='-9999px';tt.style.top='-9999px';
  var tw=tt.offsetWidth||200,th=tt.offsetHeight||100;
  var x=event.clientX+12,y=event.clientY-20;
  if(x+tw+8>window.innerWidth)x=event.clientX-tw-12;
  if(y+th+8>window.innerHeight)y=event.clientY-th-8;
  if(x<4)x=4;if(y<4)y=4;
  tt.style.left=x+'px';tt.style.top=y+'px';
}

// ========== LATENCY ANALYTICS ==========
var _latencyView='country',_latencyId='all',_latencyCache={},_latencyChart=null;
function setLatencyView(view){
  _latencyView=view;
  var cfg;
  if(view==='client'){cfg=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name}});}
  else{cfg=_heatmapConfig[view]||[];}
  if(cfg.length)_latencyId=cfg[0].id;
  ['country','operator','client'].forEach(function(v){
    var btn=document.getElementById('latTab'+v.charAt(0).toUpperCase()+v.slice(1));
    if(!btn)return;var active=v===view;
    btn.style.borderBottomColor=active?'var(--accent)':'transparent';
    btn.style.color=active?'var(--accent)':'var(--text-2)';btn.style.fontWeight=active?'600':'500';
  });
  renderLatencySubTabs();if(_latencyMode==='day'){_latencyDayCache={};loadLatencyDay();}else{_latencyCache={};loadLatencyStats();}
}
function renderLatencySubTabs(){
  var c=document.getElementById('latencySubTabs');if(!c)return;
  var view=_latencyView;
  var cfg=view==='client'?(currentData&&currentData.clients||[]).filter(function(x){return x.modemCount>0}).map(function(x){return{id:x.portName,label:x.name};}):(_heatmapConfig[view]||[]);
  var h='';
  cfg.forEach(function(item){
    var active=item.id===_latencyId;var col=hmAccent(view,item.id);
    h+='<button onclick="selectLatId(\''+esc(item.id)+'\')" style="background:'+(active?col:'var(--bg-3)')+';color:'+(active?'#fff':'var(--text-1)')+';border:none;border-radius:999px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:'+(active?'600':'400')+';transition:all .15s">'+esc(item.label)+'</button>';
  });
  c.innerHTML=h;
}
function selectLatId(id){_latencyId=id;renderLatencySubTabs();loadLatencyStats();}
// Stage 18.7: fixed 30-day window (was 14, user asked to match the
// «Почасовой трафик» card style + show longer history). setLatencyDays
// stays as a no-op for any cached HTML referencing it.
var _latencyDays = 30;
function setLatencyDays(){ /* deprecated — fixed 30-day window */ }
function loadLatencyStats(){
  var key=_latencyView+'|'+_latencyId+'|'+_latencyDays;
  if(_latencyCache[key]){renderLatencyChart(_latencyCache[key]);return;}
  api(API+'/api/analytics/latency_stats?view='+_latencyView+'&id='+encodeURIComponent(_latencyId)+'&days='+_latencyDays)
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_latencyCache[key]=data;renderLatencyChart(data);})
    .catch(function(e){var el=document.getElementById('latencySummary');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>';});
}
function renderLatencyChart(data){
  if(!data||!data.days||!data.median_ms||!data.p95_ms)return;
  var labels=data.days.map(function(d){return fmtDateRuLong(d)});
  var accent=hmAccent(_latencyView,_latencyId);
  if(_latencyChart){_latencyChart.destroy();_latencyChart=null;}
  var canvas=document.getElementById('latencyChartCanvas');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var cc=getChartColors();
  // Stage 18.8: 4 lines. Latency (left Y, ms): P50 + P95 + P95-connect.
  // Errors (right Y, %): line, not bars — keeps the chart light.
  // All fonts/colors matched to the «Почасовой трафик» card style
  // (10px axis labels in muted gray, same as the heatmap header).
  var latDatasets=[
    {label:'P50 (медиана)',data:data.median_ms,borderColor:accent,backgroundColor:accent+'1a',fill:true,tension:.3,pointRadius:3,borderWidth:2.5,pointBackgroundColor:accent,yAxisID:'y'},
    {label:'P95 (запрос)',data:data.p95_ms,borderColor:'#EF9F27',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,borderDash:[4,3],pointBackgroundColor:'#EF9F27',yAxisID:'y'},
    {label:'P95 connect (TCP)',data:data.connect_p95_ms||[],borderColor:'#7c3aed',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,borderDash:[2,3],pointBackgroundColor:'#7c3aed',yAxisID:'y'},
    {label:'Ошибки',data:data.error_pct||[],borderColor:'#e84141',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,pointBackgroundColor:'#e84141',yAxisID:'y2'}
  ];
  // Stage 18.5: axis legibility pass.
  //   - bumped font 10 → 12 px (was unreadable on retina + dark theme)
  //   - axis labels now use --text-2 (much higher contrast than the soft
  //     grid color, which is meant for the lines themselves)
  //   - x-axis: skip every other label when > 10 points so dates don't
  //     visually collide (14d fits exactly 14 labels, but font bump makes
  //     them overlap on narrow screens — auto-skip handles it)
  //   - y-axis: explicit padding + maxTicksLimit for cleaner steps
  //   - tooltip: dark/light themed background + bigger title font
  // Stage 18.8: axis styles match «Почасовой трафик» — small muted labels,
  // not the heavier 12px text used previously.
  var axisColor    = '#6b6b68';   // matches heatmap day labels
  var axisColorDim = '#9b9b98';   // matches heatmap hour labels and dates
  _latencyChart=newChartSafe(ctx,{
    type:'line',
    data:{labels:labels,datasets:latDatasets},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      layout:{padding:{top:8,right:8,bottom:4,left:4}},
      interaction:{intersect:false,mode:'index'},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(13,13,14,0.92)',
          titleColor:'#fff',titleFont:{size:11,weight:'600'},
          bodyColor:'#e0e0e0',bodyFont:{size:11},
          padding:10,cornerRadius:6,displayColors:true,boxPadding:4,
          callbacks:{label:function(ctx){
            var v=ctx.parsed.y;
            if(v==null)return ' '+ctx.dataset.label+': —';
            // Errors are percentages, latencies always in seconds (Stage 18.14).
            if(ctx.dataset.yAxisID==='y2')return ' '+ctx.dataset.label+': '+v+'%';
            return ' '+ctx.dataset.label+': '+fmtMs(v);
          }}
        }
      },
      scales:{
        x:{
          ticks:{
            font:{size:10},
            color:axisColorDim,
            maxRotation:0,
            autoSkip:true,
            autoSkipPadding:12
          },
          grid:{color:cc.gridLine,drawTicks:false},
          border:{display:false}
        },
        y:{
          beginAtZero:true,
          ticks:{
            font:{size:10},
            color:axisColor,
            padding:6,
            maxTicksLimit:6,
            // Stage 18.14: axis ticks always in seconds (no mс branch).
            callback:function(v){return (v/1000).toFixed(v<1000?2:1)+' с'}
          },
          grid:{color:cc.gridLine,drawTicks:false},
          border:{display:false}
        },
        y2:{
          position:'right',
          beginAtZero:true,
          grid:{display:false},
          ticks:{
            font:{size:10},
            color:'rgba(232,65,65,0.85)',
            padding:6,
            maxTicksLimit:5,
            callback:function(v){return v+'%'}
          },
          border:{display:false}
        }
      }
    }
  });
  // Stage 18.7: summary panel removed — chart itself is now the summary.
}
// Stage 18.14: render all latency values in seconds (user preference — easier
// to compare across the 0.05 c … 15 c range than mixing 591 мс and 2.9 с).
// Smart decimals: <0.1 c keeps 3 places so sub-100 мс is still legible.
function fmtMs(ms){
  if(ms==null)return'—';
  var s=ms/1000;
  if(s<0.1)return s.toFixed(3)+' с';
  if(s<10) return s.toFixed(2)+' с';
  return s.toFixed(1)+' с';
}
// Short variant for threshold labels — strips trailing zeros so 500/2000/4000
// render as «0.5 с», «2 с», «4 с» (instead of «0.50 с»).
function fmtMsShort(ms){
  if(ms==null)return'—';
  var s=ms/1000;
  return (s%1===0?s.toFixed(0):s.toFixed(2).replace(/\.?0+$/,''))+' с';
}

// Percentile card with delta-vs-prior-period indicator.
// `cur` and `prev` are ms values (or null). Lower-is-better — green = improvement.
function latPctileCard(label,cur,prev,baseStyle){
  var deltaHtml='';
  if(cur!=null&&prev!=null&&prev>0){
    var diff=cur-prev;
    var pct=Math.round(diff/prev*100);
    var arrow=diff>0?'▲':diff<0?'▼':'•';
    // For latency, lower is better → improvement is green
    var col=Math.abs(pct)<5?'var(--text-2)':diff<0?'var(--green)':'var(--red)';
    deltaHtml='<div style="font-size:10px;color:'+col+';line-height:1.1;white-space:nowrap;margin-top:2px">'+arrow+' '+(pct>0?'+':'')+pct+'% к пред.</div>';
  }else if(cur!=null){
    deltaHtml='<div style="font-size:10px;color:var(--text-3);line-height:1.1;white-space:nowrap;margin-top:2px">нет пред. данных</div>';
  }
  return'<div style="flex:1;min-width:90px;display:flex;flex-direction:column;gap:3px;padding:0 16px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:18px;font-weight:600;line-height:1.2;white-space:nowrap;'+(baseStyle||'color:var(--text-0)')+'">'+fmtMs(cur)+'</div>'
    +deltaHtml
    +'</div>';
}

// Renders distribution stacked bar + percentile cards. Falls back gracefully
// if backend hasn't returned overall/buckets/prior (older API).
function renderLatencySummary(data){
  // Stage 17 — compact rebuild. Previous version stacked three full-width
  // blocks (distribution + connect strip + percentile cards) taking ~150px.
  // New layout: a single row with percentile chips + an inline distribution
  // bar with the legend baked into the segments. TCP-handshake details
  // moved behind a «Подробнее» toggle (rare-use). Total ~50px vs ~150px.
  var sum=document.getElementById('latencySummary');if(!sum)return;
  var ov=data.overall||{};
  var pr=data.prior||{};
  var bk=data.buckets||{};
  var th=data.thresholds||{warn_ms:_pcWarnMs,bad_ms:_pcBadMs,very_slow_ms:_pcBadMs*2};
  var okN=ov.ok_checks||0;
  var html='';

  // ── Row 1: KPI-плитки перцентилей (по макету: P50 медиана / P75 / P99 + Ошибки) ──
  html+='<div class="kpi-row">';
  function pct(label,sub,cur,prev,thresholdBad,thresholdWarn){
    var col='var(--text-0)';
    if(cur!=null){
      if(thresholdBad&&cur>thresholdBad)col='var(--red)';
      else if(thresholdWarn&&cur>thresholdWarn)col='var(--orange)';
      else col='var(--green)';
    }
    var delta='';
    if(cur!=null&&prev!=null&&prev>0){
      var diff=cur-prev,dpct=Math.round(diff/prev*100);
      if(Math.abs(dpct)>=5){
        var dCol=diff<0?'var(--green)':'var(--red)';
        delta=' <span style="font-size:10px;color:'+dCol+';font-weight:500">'+(diff<0?'▼':'▲')+Math.abs(dpct)+'%</span>';
      }
    }
    return'<div class="kpi-tile"><div class="l">'+label+(sub?' <span style="text-transform:none;letter-spacing:0">'+sub+'</span>':'')+'</div><div class="v" style="color:'+col+'">'+fmtMs(cur)+delta+'</div></div>';
  }
  html+=pct('P50 медиана',null,ov.p50,pr.p50,_pcBadMs,_pcWarnMs);
  html+=pct('P75',null,ov.p75,pr.p75,_pcBadMs,_pcWarnMs);
  html+=pct('P99',null,ov.p99,pr.p99,_pcBadMs,_pcWarnMs);
  html+='</div>';

  // ── Row 2: compact distribution bar with inline thresholds ──
  if(okN>0){
    var f=bk.fast||0,o=bk.ok||0,s=bk.slow||0,vs=bk.very_slow||0;
    var pf=f/okN*100,po=o/okN*100,ps=s/okN*100,pvs=vs/okN*100;
    function seg(pct,col,label,cnt){
      if(pct<=0)return'';
      return'<div title="'+esc(label)+': '+cnt+' ('+pct.toFixed(1)+'%)" style="flex:'+pct+';background:'+col+';display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:600;min-width:0;overflow:hidden;white-space:nowrap">'+(pct>=10?pct.toFixed(0)+'%':'')+'</div>';
    }
    html+='<div style="margin-top:4px;padding:0 4px">';
    html+='<div style="display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--bg-3)">';
    html+=seg(pf,'rgb(52,199,89)','< '+fmtMsShort(th.warn_ms),f);
    html+=seg(po,'rgb(255,159,10)',fmtMsShort(th.warn_ms)+'–'+fmtMsShort(th.bad_ms),o);
    html+=seg(ps,'rgb(255,99,71)',fmtMsShort(th.bad_ms)+'–'+fmtMsShort(th.very_slow_ms),s);
    html+=seg(pvs,'rgb(165,40,40)','≥ '+fmtMsShort(th.very_slow_ms),vs);
    html+='</div>';
    // Словесная легенда (по макету): Быстрые · ОК · Медленные · Оч. медл.
    html+='<div style="display:flex;gap:12px 16px;flex-wrap:wrap;margin-top:7px;font-size:11px;color:var(--text-2)" title="< '+th.warn_ms+' мс — быстро; '+th.warn_ms+'–'+th.bad_ms+' — норма; '+th.bad_ms+'–'+th.very_slow_ms+' — медленно; ≥ '+th.very_slow_ms+' — очень медленно">';
    [['rgb(52,199,89)','Быстрые',pf],['rgb(255,159,10)','ОК',po],['rgb(255,99,71)','Медленные',ps],['rgb(165,40,40)','Оч. медл.',pvs]].forEach(function(x){
      html+='<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[0]+'"></span>'+x[1]+' <b>'+Math.round(x[2])+'%</b></span>';
    });
    html+='</div></div>';
  }

  sum.innerHTML=html;
}

// Compact chip used in the connect-only strip. Smaller than full card: value
// inline with delta, single-line.
function latConnectChip(label,cur,prev){
  var deltaHtml='';
  if(cur!=null&&prev!=null&&prev>0){
    var diff=cur-prev;var pct=Math.round(diff/prev*100);
    var arrow=diff>0?'▲':diff<0?'▼':'•';
    var col=Math.abs(pct)<5?'var(--text-2)':diff<0?'var(--green)':'var(--red)';
    deltaHtml='<span style="font-size:10px;color:'+col+';margin-left:4px">'+arrow+(pct>0?'+':'')+pct+'%</span>';
  }
  return'<span style="display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap"><span style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">'+label+'</span><span style="font-size:14px;font-weight:600;color:var(--text-0)">'+fmtMs(cur)+'</span>'+deltaHtml+'</span>';
}

// ========== LATENCY DAY SCATTER ==========
var _latencyMode='7d'; // '7d' or 'day'
var _latencyDate=null;  // YYYY-MM-DD (MSK), set when mode='day'
var _latencyDayCache={};

function getMskToday(){
  var now=new Date();var msk=new Date(now.getTime()+3*3600*1000);
  return msk.toISOString().slice(0,10);
}
function getMskYesterday(){
  var now=new Date();var msk=new Date(now.getTime()+3*3600*1000-86400000);
  return msk.toISOString().slice(0,10);
}

function setLatencyMode(mode,dateHint){
  _latencyMode=mode;
  if(mode==='day'){
    if(dateHint==='today')_latencyDate=getMskToday();
    else if(dateHint==='yesterday')_latencyDate=getMskYesterday();
    else if(dateHint&&/^\d{4}-\d{2}-\d{2}$/.test(dateHint))_latencyDate=dateHint;
    else if(!_latencyDate)_latencyDate=getMskToday();
  }
  updateLatencyPeriodUI();
  if(mode==='7d'){
    _latencyCache={};
    loadLatencyStats();
  }else{
    loadLatencyDay();
  }
}

function updateLatencyPeriodUI(){
  var btns=document.querySelectorAll('.lat-period-btn');
  var today=getMskToday(),yesterday=getMskYesterday();
  btns.forEach(function(b){
    // Stage 17.1: the 7d/14d/30d buttons (.latency-period-btn) have their
    // own active-highlight logic in setLatencyDays(); don't trample it here.
    if (b.classList.contains('latency-period-btn')) return;
    b.style.background='var(--bg-3)';b.style.color='var(--text-1)';b.style.fontWeight='400';
  });
  if(_latencyMode==='7d'){
    // Mark whichever days-button matches the currently selected _latencyDays.
    var lbtns=document.querySelectorAll('.latency-period-btn');
    lbtns.forEach(function(b){
      var active = parseInt(b.dataset.days) === _latencyDays;
      b.style.background = active ? 'var(--accent)' : 'var(--bg-2)';
      b.style.color      = active ? '#fff' : 'var(--text-2)';
      b.style.borderColor= active ? 'var(--accent)' : 'var(--border)';
    });
  }else{
    // In single-day mode, dim the days-buttons so the user sees they're inactive.
    var lbtns2=document.querySelectorAll('.latency-period-btn');
    lbtns2.forEach(function(b){
      b.style.background = 'var(--bg-2)';
      b.style.color = 'var(--text-3)';
      b.style.borderColor = 'var(--border)';
    });
    if(_latencyDate===today){
      var bt=document.getElementById('latPeriodToday');
      if(bt){bt.style.background='var(--accent)';bt.style.color='#fff';bt.style.fontWeight='600';}
    }else if(_latencyDate===yesterday){
      var by=document.getElementById('latPeriodYesterday');
      if(by){by.style.background='var(--accent)';by.style.color='#fff';by.style.fontWeight='600';}
    }
  }
  // Show/hide date nav
  var showNav=(_latencyMode==='day');
  var prev=document.getElementById('latDatePrev');
  var next=document.getElementById('latDateNext');
  var lbl=document.getElementById('latDateLabel');
  if(prev)prev.style.display=showNav?'':'none';
  if(next)next.style.display=showNav?'':'none';
  if(lbl){
    lbl.style.display=showNav?'':'none';
    if(showNav&&_latencyDate)lbl.textContent=fmtDateRuLong(_latencyDate);
  }
}

function shiftLatencyDate(dir){
  if(!_latencyDate)_latencyDate=getMskToday();
  var d=new Date(_latencyDate+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+dir);
  var today=getMskToday();
  var candidate=d.toISOString().slice(0,10);
  if(candidate>today)return;
  _latencyDate=candidate;
  updateLatencyPeriodUI();
  loadLatencyDay();
}

function loadLatencyDay(){
  var key=_latencyView+'|'+_latencyId+'|'+_latencyDate;
  if(_latencyDayCache[key]){renderLatencyScatter(_latencyDayCache[key]);return;}
  api(API+'/api/analytics/latency_day?view='+_latencyView+'&id='+encodeURIComponent(_latencyId)+'&date='+_latencyDate)
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_latencyDayCache[key]=data;renderLatencyScatter(data);})
    .catch(function(e){var el=document.getElementById('latencySummary');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>';});
}

function renderLatencyScatter(data){
  if(!data||!data.points)return;
  if(_latencyChart){_latencyChart.destroy();_latencyChart=null;}
  var canvas=document.getElementById('latencyChartCanvas');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var cc=getChartColors();

  // Build scatter datasets: ok points split by color, error points
  var green=[],orange=[],red=[],gray=[],allMs=[];
  for(var i=0;i<data.points.length;i++){
    var p=data.points[i];
    var pt={x:p.min,y:p.total,nick:p.nick,op:p.op,client:p.client,time:p.t,connect:p.connect,status:p.status,error:p.error};
    if(p.error){pt.y=0;gray.push(pt);}
    else if(p.total==null){continue;}
    else{
      allMs.push(p.total);
      if(p.total>=_pcBadMs){red.push(pt);}
      else if(p.total>=_pcWarnMs){orange.push(pt);}
      else{green.push(pt);}
    }
  }
  // Compute Y cap: P98 * 1.2, max 15s
  var yMax=undefined;
  if(allMs.length>10){
    var sorted=allMs.slice().sort(function(a,b){return a-b});
    var p98=sorted[Math.min(Math.ceil(sorted.length*0.98)-1,sorted.length-1)];
    yMax=Math.min(Math.round(p98*1.2),15000);
  }

  var scatterDatasets=[
    {label:'< '+fmtMsShort(_pcWarnMs),color:'rgb(52,199,89)',data:green,backgroundColor:'rgba(52,199,89,0.35)',pointRadius:2,pointHoverRadius:4,order:1},
    {label:fmtMsShort(_pcWarnMs)+'–'+fmtMsShort(_pcBadMs),color:'rgb(255,159,10)',data:orange,backgroundColor:'rgba(255,159,10,0.35)',pointRadius:2,pointHoverRadius:4,order:2},
    {label:'> '+fmtMsShort(_pcBadMs),color:'rgb(255,59,48)',data:red,backgroundColor:'rgba(255,59,48,0.3)',pointRadius:2,pointHoverRadius:4,order:3},
    {label:'Ошибки',color:'rgb(142,142,147)',data:gray,backgroundColor:'rgba(142,142,147,0.4)',pointRadius:1.5,pointHoverRadius:4,pointStyle:'crossRot',order:4}
  ];
  var scLegendEl=document.getElementById('latencyLegend');
  if(scLegendEl){
    scLegendEl.innerHTML=scatterDatasets.map(function(ds){
      var dot='<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+ds.color+'"></span>';
      if(ds.label==='Ошибки')dot='<span style="display:inline-block;width:10px;height:10px;color:'+ds.color+';font-size:12px;line-height:10px;text-align:center;font-weight:700">×</span>';
      return'<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-1)">'+dot+esc(ds.label)+'</span>';
    }).join('');
  }
  _latencyChart=newChartSafe(ctx,{type:'scatter',data:{datasets:scatterDatasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:function(items){if(!items.length)return'';var d=items[0].raw;return d.nick+(d.op?' · '+d.op:'');},label:function(ctx2){var d=ctx2.raw;if(d.error)return'Ошибка: '+d.error;return(d.total!=null?fmtMs(d.total):'—')+' · '+d.time+(d.client?' · '+d.client:'');}}}},scales:{x:{type:'linear',min:0,max:1440,ticks:{font:{size:10},color:cc.grid,stepSize:120,callback:function(v){var h=Math.floor(v/60);return String(h).padStart(2,'0')+':00'}},grid:{color:cc.gridLine}},y:{beginAtZero:true,suggestedMax:yMax,ticks:{font:{size:10},color:cc.grid,callback:function(v){return (v/1000).toFixed(v<1000?2:1)+' с'}},grid:{color:cc.gridLine}}}}});

  // Summary
  var sum=document.getElementById('latencySummary');if(!sum||!data.summary)return;
  var s=data.summary;
  var mCls=s.median_ms===null?'':s.median_ms>_pcBadMs?'color:var(--red)':s.median_ms>_pcWarnMs?'color:var(--orange)':'color:var(--green)';
  var eCls=s.total>0?(s.errors/s.total*100>15?'color:var(--red)':s.errors>0?'color:var(--orange)':'color:var(--green)'):'';
  sum.innerHTML=latSumItem('Медиана',s.median_ms!==null?fmtMs(s.median_ms):'—',mCls)
    +latSumItem('P95',s.p95_ms!==null?fmtMs(s.p95_ms):'—','')
    +latSumItem('Ошибки',s.total>0?Math.round(s.errors/s.total*100)+'%':'—',eCls)
    +latSumItem('Проверок',String(s.total),'');
}

function latSumItem(label,val,style){
  return'<div style="flex:1;display:flex;flex-direction:column;gap:3px;padding:0 20px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:18px;font-weight:600;line-height:1.2;white-space:nowrap;'+(style||'color:var(--text-0)')+'">'+val+'</div></div>';
}

var _dailyMonthOffset=0; // 0=current, -1=prev, etc
var _MONTHS_RU_NOM=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var _MONTHS_RU_SHORT=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
// «2026-03» → «Март» (или «Мар» при short). Возвращает исходную строку, если формат иной.
function _ymRu(ym,short){ if(ym==null)return ''; var s=String(ym); var m=/^(\d{4})-(\d{2})/.exec(s); if(!m)return s; var mi=parseInt(m[2],10)-1; return (short?_MONTHS_RU_SHORT:_MONTHS_RU_NOM)[mi]||s; }
function shiftDailyMonth(dir){
  _dailyMonthOffset+=dir;
  if(_dailyMonthOffset>0)_dailyMonthOffset=0;
  if(_dailyMonthOffset<-11)_dailyMonthOffset=-11;
  renderDailyClientChart(window._dailyTrafficCache);
}
function renderDailyClientChart(data,cc){
  if(!cc)cc=getChartColors();
  if(!data)return;
  window._dailyTrafficCache=data;
  var serverFilter=(document.getElementById('dailyServerFilter')||{}).value||'all';
  var mode=(document.getElementById('dailyModeFilter')||{}).value||'clients';

  // Collect all available servers for the filter dropdown
  var allServers={};
  for(var client in data){
    for(var dt in data[client]){
      var srvs=data[client][dt].servers;
      if(srvs){for(var s in srvs)allServers[s]=true}
    }
  }
  // Populate dropdown (only once or when servers change)
  var sel=document.getElementById('dailyServerFilter');
  if(sel&&sel.options.length<=1){
    var srvNames=Object.keys(allServers).sort();
    var seen={};
    srvNames.forEach(function(s){
      var ci=COUNTRIES[s]||{};
      var cc=ci.country||s;
      if(seen[cc])return;seen[cc]=true;
      var opt=document.createElement('option');
      opt.value=cc;
      opt.textContent=(ci.flag||'')+' '+(ci.name||s);
      sel.appendChild(opt);
    });
    sel.value=serverFilter;
  }

  // Build date labels for selected month
  var now=new Date();
  var targetDate=new Date(now.getFullYear(),now.getMonth()+_dailyMonthOffset,1);
  var year=targetDate.getFullYear(),month=targetDate.getMonth();
  var daysInMonth=new Date(year,month+1,0).getDate();
  var isCurrentMonth=(_dailyMonthOffset===0);
  var today=isCurrentMonth?now.getDate():daysInMonth;
  var labels=[];
  for(var d=1;d<=Math.min(today,daysInMonth);d++){
    var dd=String(d).padStart(2,'0');
    var mm=String(month+1).padStart(2,'0');
    labels.push(year+'-'+mm+'-'+dd);
  }
  var displayLabels=labels.map(function(l){return l.slice(8)+'.'+l.slice(5,7)});
  // Update month label
  var lbl=document.getElementById('dailyMonthLabel');
  if(lbl)lbl.textContent=_MONTHS_RU_NOM[month]+' '+year;

  var datasets;
  var clients;

  if(mode==='countries'){
    // Build datasets per server (country)
    var countryColors={'MD':'#3B9DD8','RO':'#E05C2C'};
    var countryLabels={'MD':'🇲🇩 Молдова','RO':'🇷🇴 Румыния'};
    var countryTotals={};
    for(var client in data){
      if(_selectedClient&&client!==_selectedClient)continue;
      for(var dt in data[client]){
        var srvs=data[client][dt].servers;
        if(!srvs)continue;
        for(var s in srvs){
          var ci=COUNTRIES[s]||{};
          var cc=ci.country||s;
          if(!countryTotals[cc])countryTotals[cc]={};
          if(!countryTotals[cc][dt])countryTotals[cc][dt]=0;
          if(serverFilter==='all'||serverFilter===cc){
            countryTotals[cc][dt]+=(srvs[s].in||0)+(srvs[s].out||0);
          }
        }
      }
    }
    datasets=Object.keys(countryTotals).sort().map(function(cc,i){
      var color=countryColors[cc]||CHART_COLORS.clients[i];
      var values=labels.map(function(dt){return parseFloat((countryTotals[cc][dt]||0)/1e9).toFixed(2)});
      return{label:countryLabels[cc]||cc,clientName:cc,data:values,borderColor:color,backgroundColor:color+'26',fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:2};
    });
    clients=Object.keys(countryTotals);
  } else {
  // Sort clients by total traffic desc (with server filter)
  // If a client is selected in the table, show only that client
  var clientTotals={};
  var _cfVal=(document.getElementById('dailyClientFilter')||{}).value||'all';
  for(var client in data){
    if(client==='Не назначен')continue;
    if(_selectedClient&&client!==_selectedClient)continue;
    if(_cfVal!=='all'&&client!==_cfVal)continue;
    var total=0;
    for(var dt in data[client]){
      var entry=data[client][dt];
      if(serverFilter==='all'){
        total+=(entry.in||0)+(entry.out||0);
      } else if(entry.servers){
        for(var _s in entry.servers){var _ci=COUNTRIES[_s]||{};if((_ci.country||_s)===serverFilter){total+=(entry.servers[_s].in||0)+(entry.servers[_s].out||0);}}
      }
    }
    if(total>0)clientTotals[client]=total;
  }
  clients=Object.keys(clientTotals).sort(function(a,b){return clientTotals[b]-clientTotals[a]});

  // Build datasets using CHART_COLORS palette
  datasets=clients.map(function(client,i){
    var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
    var values=labels.map(function(dt){
      var entry=data[client]&&data[client][dt];
      if(!entry)return 0;
      if(serverFilter==='all'){
        return parseFloat(((entry.in||0)+(entry.out||0))/1e9).toFixed(2);
      } else if(entry.servers){
        var _t=0;for(var _s in entry.servers){var _ci=COUNTRIES[_s]||{};if((_ci.country||_s)===serverFilter){_t+=(entry.servers[_s].in||0)+(entry.servers[_s].out||0);}}
        return parseFloat(_t/1e9).toFixed(2);
      }
      return 0;
    });
    return{label:client,clientName:client,data:values,borderColor:color,backgroundColor:color+'26',fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:2};
  });
  }
  if(mode==='modems'){
    // Per-modem view using modem data from API
    var modemData=window._modemTrafficCache;
    if(modemData){
      var modemTotals={};
      for(var nick in modemData){
        var md=modemData[nick];
        // Filter by selected client
        if(_selectedClient&&md.portName!==_selectedClient)continue;
        // Filter by server
        if(serverFilter!=='all'&&md.server!==serverFilter)continue;
        var t=0;for(var dt in md.days)t+=md.days[dt];
        if(t>0)modemTotals[nick]=t;
      }
      clients=Object.keys(modemTotals).sort(function(a,b){return modemTotals[b]-modemTotals[a]});
      datasets=clients.map(function(key,i){
        // `key` is the backend's "nick:portName" map key. UI presents:
        //   - legend label: just the nick (e.g. MD2_66)
        //   - tooltip title: nick + operator (e.g. MD2_66:Orange MD)
        var md=modemData[key]||{};
        var nick=md.nick||key.split(':')[0];
        var op=md.operator||'';
        var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
        var values=labels.map(function(dt){return parseFloat((md.days&&md.days[dt]||0)/1e9).toFixed(2)});
        return{
          label:nick,                             // shown in legend
          tooltipTitle:nick+(op?':'+op:''),       // shown in tooltip title (we read this in callbacks below)
          clientName:nick,
          data:values,
          borderColor:color,backgroundColor:color+'26',
          fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:1.5
        };
      });
    }
  } // end modems mode

  // Add "Все" (Total) line — only for countries mode
  if(mode==='countries'){
    var totalValues=labels.map(function(dt,idx){
      var sum=0;
      datasets.forEach(function(ds){sum+=parseFloat(ds.data[idx])||0;});
      return sum.toFixed(2);
    });
    datasets.unshift({label:'Все',clientName:'__total__',data:totalValues,borderColor:'#1A1A1A',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2.5,borderDash:[6,3]});
  }

  // Custom HTML legend
  var legendEl=document.getElementById('dailyClientLegend');
  if(legendEl){
    legendEl.innerHTML=datasets.map(function(ds){
      return'<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-2)">'+
        '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:'+ds.borderColor+'"></span>'+esc(ds.label)+'</span>';
    }).join('');
  }

  if(charts.dailyClient){charts.dailyClient.destroy();delete charts.dailyClient;}
  var dailyCanvas=document.getElementById('chartDailyClientTraffic');
  if(!dailyCanvas)return;
  charts.dailyClient=newChartSafe(dailyCanvas,{type:'line',data:{labels:displayLabels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){var ds=ctx.dataset||{};var name=ds.tooltipTitle||ds.label;return' '+name+': '+ctx.parsed.y+' GB'}}}},scales:{x:{ticks:{color:cc.text,font:{size:9}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:cc.text,font:{size:10},callback:function(v){return v+' GB'}},grid:{color:cc.grid}}}}});
}

function onDailyModeChange(){
  var mode=document.getElementById('dailyModeFilter').value;
  var cf=document.getElementById('dailyClientFilter');
  cf.style.display=(mode==='clients')?'':'none';
  // Populate client filter if empty
  if(mode==='clients'&&cf.options.length<=1&&window._dailyTrafficCache){
    var cls=Object.keys(window._dailyTrafficCache).filter(function(c){return c!=='Не назначен'}).sort();
    cls.forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c;cf.appendChild(o)});
  }
  if(mode==='modems'&&!window._modemTrafficCache&&!window._modemFetchInProgress){
    window._modemFetchInProgress=true;
    api(API+'/api/admin/daily_traffic?detail=modems')
      .then(function(d){
        window._dailyTrafficCache=d.clients;
        window._modemTrafficCache=d.modems;
        window._modemFetchInProgress=false;
        renderDailyClientChart(d.clients);
      })
      .catch(function(e){window._modemFetchInProgress=false;showToast('Ошибка: '+esc(e.message),'error')});
    return;
  }
  renderDailyClientChart(window._dailyTrafficCache);
}
var _selectedClient=null;
function selectClient(name){
  _selectedClient=_selectedClient===name?null:name;
  document.querySelectorAll('.ct-row').forEach(function(r){r.classList.toggle('active',r.dataset.client===name&&_selectedClient===name)});
  // Re-render chart showing only selected client (or all if deselected)
  renderDailyClientChart(window._dailyTrafficCache);
}
var _matrixSortKey='total',_matrixSortDir=-1,_matrixView='modem',_matrixShowAll=false;
function matrixSort(key){
  if(_matrixSortKey===key){_matrixSortDir*=-1}else{_matrixSortKey=key;_matrixSortDir=-1}
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function setMatrixView(v){
  _matrixView=v;_matrixShowAll=false;
  var bm=document.getElementById('matrixViewModem'),bc=document.getElementById('matrixViewClient');
  if(bm&&bc){
    bm.style.color=v==='modem'?'var(--accent)':'var(--text-2)';
    bm.style.fontWeight=v==='modem'?'600':'500';
    bm.style.borderBottomColor=v==='modem'?'var(--accent)':'transparent';
    bc.style.color=v==='client'?'var(--accent)':'var(--text-2)';
    bc.style.fontWeight=v==='client'?'600':'500';
    bc.style.borderBottomColor=v==='client'?'var(--accent)':'transparent';
  }
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function showAllMatrixRows(){
  _matrixShowAll=true;
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function _matrixRowHtml(m,clientColor){
  var total=m.tIn+m.tOut;var ci=COUNTRIES[m.server]||{};
  // Trend: N days this month vs N days prev month (from server modemTrend)
  var trendKey=m.server+'_'+m.portId;
  var mt=(currentData.modemTrend||{})[trendKey];
  var trendHtml='';
  if(mt!==undefined&&mt!==null){var chg=mt;var chgColor=chg>=0?'var(--success)':'var(--danger)';var chgStr;if(chg>999){chgStr='+999%+'}else if(chg<-99){chgStr='<−99%'}else{chgStr=(chg>=0?'+':'')+chg+'%'}trendHtml='<span style="font-size:10px;font-weight:600;color:'+chgColor+'" title="Первые N дней этого vs прошлого месяца">'+chgStr+'</span>'}
  else if(m.dayIn+m.dayOut>0){trendHtml='<span style="font-size:10px;color:var(--text-3)">—</span>'}
  var row='<tr>';
  row+='<td style="padding:0;width:3px"><div style="width:3px;height:100%;min-height:32px;background:'+clientColor+'"></div></td>';
  row+='<td style="color:var(--accent);font-weight:500">'+esc(m.nick)+'</td>';
  row+='<td style="font-size:10px;color:var(--text-2)">'+esc(m.operator||'')+'</td>';
  row+='<td style="font-size:10px">'+(ci.flag||'')+' '+m.server+'</td>';
  row+='<td style="font-size:10px">'+esc(m.pn)+'</td>';
  row+='<td class="mono" style="color:var(--text-2)">'+fmtGb(m.tIn)+'</td>';
  row+='<td class="mono" style="color:var(--text-2)">'+fmtGb(m.tOut)+'</td>';
  row+='<td class="mono" style="color:var(--text-0);font-weight:600">'+fmtGb(total)+'</td>';
  row+='<td class="mono" style="font-size:10px">'+fmtGbShort(m.dayIn+m.dayOut)+'</td>';
  row+='<td class="mono" style="font-size:10px">'+fmtGbShort(m.monIn+m.monOut)+'</td>';
  row+='<td style="text-align:center">'+trendHtml+'</td>';
  row+='</tr>';
  return row;
}
function renderTrafficMatrix(d){
  if(!d)d=collectTrafficData();if(!d)return;
  // Build client→color map
  var clientNames=Object.keys(d.clientTraffic).sort(function(a,b){return(d.clientTraffic[b].tIn+d.clientTraffic[b].tOut)-(d.clientTraffic[a].tIn+d.clientTraffic[a].tOut)});
  var clientColorMap={};clientNames.forEach(function(n,i){clientColorMap[n]=CHART_COLORS.clients[i%CHART_COLORS.clients.length]});
  // Sort
  var sorted=d.modemTraffic.slice().sort(function(a,b){
    var av,bv;
    if(_matrixSortKey==='nick'){return _matrixSortDir*(a.nick.localeCompare(b.nick))}
    if(_matrixSortKey==='tIn'){av=a.tIn;bv=b.tIn}
    else if(_matrixSortKey==='tOut'){av=a.tOut;bv=b.tOut}
    else{av=a.tIn+a.tOut;bv=b.tIn+b.tOut}
    return _matrixSortDir*(av-bv);
  });
  var sortArrow=function(k){return _matrixSortKey===k?(_matrixSortDir>0?' ↑':' ↓'):''};
  var thead='<thead><tr><th style="cursor:pointer;width:3px;padding:0"></th><th style="cursor:pointer" onclick="matrixSort(\'nick\')">Модем'+sortArrow('nick')+'</th><th>Оператор</th><th>Сервер</th><th>Клиент</th><th style="cursor:pointer" onclick="matrixSort(\'tIn\')">↓ Вход'+sortArrow('tIn')+'</th><th style="cursor:pointer" onclick="matrixSort(\'tOut\')">↑ Выход'+sortArrow('tOut')+'</th><th style="cursor:pointer" onclick="matrixSort(\'total\')">Σ Всего'+sortArrow('total')+'</th><th>Сегодня</th><th>Месяц</th><th style="width:90px">Тренд мес.</th></tr></thead>';
  var h=thead+'<tbody>';
  if(_matrixView==='client'){
    // Group by client with colored header rows
    clientNames.forEach(function(pn){
      var color=clientColorMap[pn]||'var(--border)';
      var clientModems=sorted.filter(function(m){return m.pn===pn});
      if(!clientModems.length)return;
      var ctIn=clientModems.reduce(function(s,m){return s+m.tIn},0);
      var ctOut=clientModems.reduce(function(s,m){return s+m.tOut},0);
      h+='<tr style="background:'+color+'22"><td colspan="11" style="padding:4px 8px;font-size:11px;font-weight:600;color:var(--text-0)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+color+';margin-right:6px"></span>'+esc(pn)+' — '+clientModems.length+' мод. | ↓'+fmtGb(ctIn)+' ↑'+fmtGb(ctOut)+'</td></tr>';
      var toShow=_matrixShowAll?clientModems:clientModems.slice(0,10);
      toShow.forEach(function(m){h+=_matrixRowHtml(m,color)});
    });
  } else {
    // "По модемам": aggregate all ports/clients per modem nick
    var modemAgg={};
    sorted.forEach(function(m){
      var key=m.nick+'|'+m.server;
      if(!modemAgg[key]){
        modemAgg[key]={nick:m.nick,server:m.server,operator:m.operator,
          tIn:0,tOut:0,dayIn:0,dayOut:0,monIn:0,monOut:0,prevIn:0,prevOut:0,
          clients:[],online:m.online};
      }
      var agg=modemAgg[key];
      agg.tIn+=m.tIn;agg.tOut+=m.tOut;
      agg.dayIn+=m.dayIn;agg.dayOut+=m.dayOut;
      agg.monIn+=m.monIn;agg.monOut+=m.monOut;
      agg.prevIn+=m.prevIn||0;agg.prevOut+=m.prevOut||0;
      if(m.pn&&agg.clients.indexOf(m.pn)===-1)agg.clients.push(m.pn);
    });
    var aggList=Object.values(modemAgg).sort(function(a,b){
      if(_matrixSortKey==='nick')return _matrixSortDir*(a.nick.localeCompare(b.nick));
      if(_matrixSortKey==='tIn')return _matrixSortDir*(a.tIn-b.tIn);
      if(_matrixSortKey==='tOut')return _matrixSortDir*(a.tOut-b.tOut);
      return _matrixSortDir*((a.tIn+a.tOut)-(b.tIn+b.tOut));
    });
    var toShow=_matrixShowAll?aggList:aggList.slice(0,10);
    toShow.forEach(function(m){
      // pick color by first client or mixed
      var col=m.clients.length===1?(clientColorMap[m.clients[0]]||'var(--border)'):'var(--border)';
      // pn = joined clients list
      var origPn=m.pn;m.pn=m.clients.join(', ');
      h+=_matrixRowHtml(m,col);
      m.pn=origPn;
    });
    // update show-more count to reflect aggregated rows
    var showMoreEl=document.getElementById('trafficMatrixShowMore');
    if(showMoreEl){
      if(!_matrixShowAll&&aggList.length>10){
        showMoreEl.style.display='';
        showMoreEl.querySelector('button').textContent='Показать все '+aggList.length+' модемов ↓';
      } else {showMoreEl.style.display='none';}
    }
  }
  document.getElementById('trafficMatrix').innerHTML=h+'</tbody>';
  // show-more for client view (modem view handles it inline above)
  if(_matrixView==='client'){
  var showMoreEl=document.getElementById('trafficMatrixShowMore');
  if(showMoreEl){
    var totalRows=sorted.length;
    if(!_matrixShowAll&&totalRows>10){
      showMoreEl.style.display='';
      showMoreEl.querySelector('button').textContent='Показать все '+totalRows+' строк ↓';
    } else {
      showMoreEl.style.display='none';
    }
  }
  }
}

// ========== FINANCES TAB ==========
var _finPeriod='month';
function setFinPeriod(p,btn){
  _finPeriod=p;
  document.querySelectorAll('.fin-period-btn').forEach(function(b){b.classList.remove('active')});
  if(btn)btn.classList.add('active');
  var oldPeriod=accPeriod;
  setAccPeriodSilent(p);
  renderFinancesTab(collectTrafficData());
  setAccPeriodSilent(oldPeriod);
}
function setAccPeriodSilent(p){
  accPeriod=p;
  // update getTrafficFields without re-rendering traffic tab
}
function shortCurrency(val){return Math.round(val).toLocaleString('ru-RU')+' ₽'}
// Replaced by renderFinancesTabNew (calls /api/admin/finance_dashboard).
// Old per-client traffic table left below for reference / debug, but main entry
// point now hits the new SaaS-style dashboard.
function renderFinancesTab(d){
  return renderFinancesTabNew();
}
function _renderFinancesTabOld(d){
  if(!d)d=collectTrafficData();if(!d)return;
  var daysEl=getDaysElapsed();
  var sortedClients=(currentData.clients||[]).slice().sort(function(a,b){
    var aKey=a.portName||a.username||'';var bKey=b.portName||b.username||'';
    var aT=d.modemTraffic.filter(function(m){return m.pn===aKey}).reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    var bT=d.modemTraffic.filter(function(m){return m.pn===bKey}).reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    return bT-aT;
  });
  var clientStats=[];var totalRevenue=0;var totalTrafficBytes=0;var totalPaid=0;var totalCharged=0;
  sortedClients.forEach(function(cl,i){
    var ctKey=cl.portName||cl.username||cl.name||'';
    var clModems=d.modemTraffic.filter(function(m){return m.pn===ctKey});
    var modemCount=clModems.length;
    var monBytes=clModems.reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    var prevBytes=clModems.reduce(function(s,m){return s+(m.prevIn||0)+(m.prevOut||0)},0);
    var monGb=monBytes/1e9;var prevGb=prevBytes/1e9;
    var charged=0;var tariffStr='—';
    var bt=cl.billingType||'';var price=cl.price||0;
    if(bt==='per_gb'){charged=monGb*price;tariffStr=price+'₽/ГБ';}
    else if(bt==='per_modem'){charged=price*modemCount;tariffStr=price+'₽/мод';}
    totalRevenue+=charged;totalTrafficBytes+=monBytes;totalCharged+=charged;
    var paid=0;(cl.payments||[]).forEach(function(p){paid+=p.amount||0});totalPaid+=paid;
    var balance=cl.balance||0;
    var costPerGb=monGb>0?Math.round(charged/monGb):0;
    var vsPrev=prevGb>0?Math.round((monGb-prevGb)/prevGb*100):null;
    var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
    // Sparkline: daily traffic last 7 days from modem data
    var sparkData=[];
    clModems.forEach(function(m){if(m.dailyArr&&m.dailyArr.length>0)for(var di=0;di<m.dailyArr.length;di++){sparkData[di]=(sparkData[di]||0)+m.dailyArr[di]}});
    var spark7=sparkData.slice(-7);while(spark7.length<7)spark7.unshift(0);
    clientStats.push({cl:cl,ctKey:ctKey,modemCount:modemCount,monBytes:monBytes,monGb:monGb,prevGb:prevGb,charged:charged,tariffStr:tariffStr,balance:balance,costPerGb:costPerGb,vsPrev:vsPrev,color:color,paid:paid,spark7:spark7});
  });
  var totalGb=totalTrafficBytes/1e9;
  var avgRubPerGb=totalGb>0?Math.round(totalRevenue/totalGb):0;
  var activeModemsCount=d.modemTraffic.filter(function(m){return(m.monIn||0)+(m.monOut||0)>0}).length;
  var debtClientsCount=clientStats.filter(function(s){return s.balance<0}).length;
  var projectedMonthly=daysEl>0?Math.round(totalRevenue/daysEl*30):0;
  var revenueVsPrev=clientStats.reduce(function(s,c){return s+(c.prevGb*(c.cl.price||0))},0);
  var revenueGrowth=revenueVsPrev>0?Math.round((totalRevenue-revenueVsPrev)/revenueVsPrev*100):null;
  var avgRevenuePerModem=activeModemsCount>0?Math.round(totalRevenue/activeModemsCount):0;
  var activeClients=clientStats.filter(function(s){return s.monBytes>0}).length;
  var arpu=activeClients>0?Math.round(totalRevenue/activeClients):0;
  var revenuePerDay=daysEl>0?Math.round(totalRevenue/daysEl):0;

  var out='<div style="padding:14px 24px">';

  // Block A: Header + period selector
  var finPeriod=localStorage.getItem('fin_period')||'7d';
  out+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  out+='<h2 style="font-size:18px;font-weight:700;color:var(--text-0);margin:0">Доходность</h2>';
  out+='<div class="fin-period-group">';
  ['1d:Сегодня','7d:7 дней','30d:30 дней','q:Квартал','y:Год'].forEach(function(p){var parts=p.split(':');out+='<button class="fin-period-btn'+(finPeriod===parts[0]?' active':'')+'" onclick="localStorage.setItem(\'fin_period\',\''+parts[0]+'\');this.parentElement.querySelectorAll(\'.fin-period-btn\').forEach(function(b){b.classList.remove(\'active\')});this.classList.add(\'active\')">'+parts[1]+'</button>'});
  out+='</div></div>';

  // Block B: KPI cards (4)
  out+='<div class="fin-summary">';
  out+='<div class="fin-card fin-card--accent"><div class="fc-label">Выручка за период</div><div class="fc-value">'+shortCurrency(totalRevenue)+'</div>'+(revenueGrowth!==null?'<div class="fc-sub '+(revenueGrowth>=0?'up':'dn')+'">'+(revenueGrowth>=0?'↑':'↓')+' '+Math.abs(revenueGrowth)+'% vs пр. период</div>':'')+'</div>';
  out+='<div class="fin-card"><div class="fc-label">Прогноз на месяц</div><div class="fc-value">'+shortCurrency(projectedMonthly)+'</div><div class="fc-sub">на основе '+daysEl+' дн.</div></div>';
  out+='<div class="fin-card"><div class="fc-label">Средний ₽/ГБ</div><div class="fc-value">'+avgRubPerGb+' ₽</div><div class="fc-sub">'+fmtGb(totalTrafficBytes)+' трафика</div></div>';
  out+='<div class="fin-card'+(debtClientsCount>0?' fin-card--alert':'')+'"><div class="fc-label">Долги</div><div class="fc-value" style="color:'+(debtClientsCount>0?'var(--danger)':'var(--success)')+'">'+debtClientsCount+'</div><div class="fc-sub">'+(debtClientsCount>0?'клиентов с отриц. балансом':'все балансы в норме')+'</div></div>';
  out+='</div>';

  // Block C: Widget grid (6)
  out+='<div class="widget-grid" style="grid-template-columns:repeat(6,1fr);margin-bottom:12px;padding:0">';
  out+='<div class="widget"><div class="widget-label">Трафик за период</div><div class="widget-value" style="font-size:16px">'+fmtGb(totalTrafficBytes)+'</div></div>';
  out+='<div class="widget"><div class="widget-label">Доход / модем</div><div class="widget-value" style="font-size:16px">'+avgRevenuePerModem.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Доход / сутки</div><div class="widget-value" style="font-size:16px">'+revenuePerDay.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Активных модемов</div><div class="widget-value" style="font-size:16px">'+activeModemsCount+'</div></div>';
  out+='<div class="widget"><div class="widget-label">ARPU</div><div class="widget-value" style="font-size:16px">'+arpu.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Маржа, ₽/ГБ</div><div class="widget-value" style="font-size:16px;color:var(--success)">'+avgRubPerGb+' ₽</div></div>';
  out+='</div>';

  // Block D: Revenue chart placeholder
  out+='<div class="analytics-card" style="margin-bottom:12px"><h3>Выручка по дням</h3><div id="finRevenueChartWrap" style="max-height:200px"><canvas id="finRevenueChart"></canvas></div></div>';

  // Block E: Client table
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Финансы по клиентам</div><div class="fin-table-badge">'+clientStats.length+' клиентов</div></div>';
  out+='<table class="fin-table"><thead><tr>';
  ['Клиент','Тариф','Трафик','Δ пр. период','Модемов','Начислено','₽/ГБ','Баланс','Тренд'].forEach(function(h){out+='<th>'+h+'</th>'});
  out+='</tr></thead><tbody>';
  clientStats.forEach(function(s){
    var inactive=s.monBytes===0&&s.modemCount===0;
    out+='<tr'+(inactive?' class="row-inactive"':'')+'>';
    out+='<td><div style="display:flex;align-items:center;gap:6px"><div class="client-dot" style="background:'+s.color+'"></div><span style="font-weight:600">'+esc(s.cl.name||s.ctKey)+'</span></div></td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-size:11px">'+esc(s.tariffStr)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-weight:600">'+fmtGb(s.monBytes)+'</td>';
    if(s.vsPrev!==null){out+='<td style="text-align:center"><span class="badge-delta '+(s.vsPrev>=0?'up':'dn')+'">'+(s.vsPrev>=0?'+':'')+s.vsPrev+'%</span></td>'}else{out+='<td style="text-align:center">—</td>'}
    out+='<td style="text-align:center">'+s.modemCount+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono)">'+shortCurrency(s.charged)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono)">'+(s.costPerGb>0?s.costPerGb+' ₽':'—')+'</td>';
    if(s.balance<0)out+='<td style="text-align:center"><span class="badge-neg">'+Math.round(s.balance).toLocaleString('ru-RU')+' ₽</span></td>';
    else if(s.balance>0)out+='<td style="text-align:center"><span class="badge-pos">+'+Math.round(s.balance).toLocaleString('ru-RU')+' ₽</span></td>';
    else out+='<td style="text-align:center;color:var(--text-3)">0 ₽</td>';
    // Sparkline
    var maxSp=Math.max.apply(null,s.spark7)||1;
    out+='<td style="text-align:center"><div class="widget-spark" style="display:inline-flex;height:18px;width:42px">';
    s.spark7.forEach(function(v){var h=Math.max(2,Math.round(v/maxSp*18));out+='<div class="widget-spark-bar" style="height:'+h+'px;background:'+s.color+';opacity:.6"></div>'});
    out+='</div></td>';
    out+='</tr>';
  });
  out+='</tbody></table></div>';

  // Block F: Two tables side by side
  out+='<div class="fin-bottom">';

  // Left: Operator efficiency
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Эффективность операторов</div></div>';
  out+='<table class="fin-table"><thead><tr>';
  ['Оператор','Модемов','Трафик','Выручка','₽/мод','₽/ГБ'].forEach(function(h){out+='<th>'+h+'</th>'});
  out+='</tr></thead><tbody>';
  var opStats={};
  d.modemTraffic.forEach(function(m){
    var op=m.operator;if(!op)return;
    if(!opStats[op])opStats[op]={cnt:0,t:0,rev:0};
    opStats[op].cnt++;opStats[op].t+=(m.monIn||0)+(m.monOut||0);
    var cl=(currentData.clients||[]).find(function(c){return(c.portName||c.username)===m.pn});
    if(cl){var tGb=((m.monIn||0)+(m.monOut||0))/1e9;var cbt=cl.billingType||'';var cp=cl.price||0;
      if(cbt==='per_gb')opStats[op].rev+=tGb*cp;else if(cbt==='per_modem')opStats[op].rev+=cp;}
  });
  Object.keys(opStats).sort(function(a,b){return opStats[b].rev-opStats[a].rev}).forEach(function(op){
    var v=opStats[op];var tGb=v.t/1e9;var rpm=v.cnt>0?Math.round(v.rev/v.cnt):0;var rpg=tGb>0?Math.round(v.rev/tGb):0;
    var flag='';var opL=op.toLowerCase();
    if(opL.indexOf('orange ro')>-1||opL.indexOf('vodafone')>-1)flag='🇷🇴 ';
    else if(opL.indexOf('orange md')>-1||opL.indexOf('moldtelecom')>-1)flag='🇲🇩 ';
    var rpgBadge=rpg<500?'background:rgba(52,199,89,.12);color:var(--success)':rpg>1000?'background:rgba(230,126,34,.12);color:#e67e22':'';
    out+='<tr><td>'+flag+esc(op)+'</td><td style="text-align:center">'+v.cnt+'</td><td style="text-align:center;font-family:var(--font-mono)">'+fmtGb(v.t)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-weight:600">'+shortCurrency(v.rev)+'</td>';
    out+='<td style="text-align:center;color:var(--text-2)">'+rpm.toLocaleString('ru-RU')+' ₽</td>';
    out+='<td style="text-align:center">'+(rpgBadge?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'+rpgBadge+'">'+rpg+' ₽</span>':rpg+' ₽')+'</td></tr>';
  });
  out+='</tbody></table></div>';

  // Right: Top modems by revenue
  var _finModSort=window._finModSort||'revenue';var _showAllMod=window._showAllModemRev||false;
  var modemRevMap={};
  d.modemTraffic.forEach(function(m){
    var cl=(currentData.clients||[]).find(function(c){return(c.portName||c.username)===m.pn});if(!cl)return;
    var tGb=((m.monIn||0)+(m.monOut||0))/1e9;var bt=cl.billingType||'';var price=cl.price||0;
    var rev=bt==='per_gb'?tGb*price:bt==='per_modem'?price:0;
    if(!modemRevMap[m.nick]){modemRevMap[m.nick]={nick:m.nick,operator:m.operator||'—',tGb:0,rev:0}}
    modemRevMap[m.nick].tGb+=tGb;modemRevMap[m.nick].rev+=rev;
  });
  var modemRevRows=Object.keys(modemRevMap).map(function(nick){var r=modemRevMap[nick];r.revPerGb=r.tGb>0?r.rev/r.tGb:0;return r});
  modemRevRows.sort(function(a,b){return _finModSort==='per_gb'?b.revPerGb-a.revPerGb:b.rev-a.rev});
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Топ модемов по доходу</div>';
  out+='<div class="view-toggle"><button class="'+(_finModSort==='revenue'?'active':'')+'" onclick="window._finModSort=\'revenue\';renderFinancesTab()">По доходу</button><button class="'+(_finModSort==='per_gb'?'active':'')+'" onclick="window._finModSort=\'per_gb\';renderFinancesTab()">По ₽/ГБ</button></div></div>';
  out+='<table class="fin-table"><thead><tr><th>Модем</th><th>Оператор</th><th>Трафик</th><th style="font-weight:700">Доход</th><th>₽/ГБ</th></tr></thead><tbody>';
  var visModems=_showAllMod?modemRevRows:modemRevRows.slice(0,6);
  visModems.forEach(function(r){
    var rpg=r.tGb>0?Math.round(r.rev/r.tGb):0;
    var flag='';var opL=(r.operator||'').toLowerCase();
    if(opL.indexOf('orange ro')>-1||opL.indexOf('vodafone')>-1)flag='🇷🇴 ';
    else if(opL.indexOf('orange md')>-1||opL.indexOf('moldtelecom')>-1)flag='🇲🇩 ';
    out+='<tr><td><span class="modem-link" onclick="var mm=currentData._modemMap;for(var k in mm){if(mm[k].nick===\''+esc(r.nick).replace(/'/g,"\\'")+'\'){showDetails(mm[k]);break}}">'+esc(r.nick)+'</span></td>';
    out+='<td style="color:var(--text-2)">'+flag+esc(r.operator)+'</td>';
    out+='<td style="font-family:var(--font-mono)">'+r.tGb.toFixed(1)+' ГБ</td>';
    out+='<td style="font-family:var(--font-mono);font-weight:600">'+shortCurrency(r.rev)+'</td>';
    out+='<td style="font-family:var(--font-mono)">'+rpg+' ₽</td></tr>';
  });
  out+='</tbody></table>';
  if(!_showAllMod&&modemRevRows.length>6){
    out+='<div class="show-more-row"><button onclick="window._showAllModemRev=true;renderFinancesTab()">Показать все '+modemRevRows.length+' ↓</button></div>';
  }
  out+='</div>';
  out+='</div>'; // fin-bottom

  out+='</div>'; // padding wrapper
  document.getElementById('acc-finances').innerHTML=out;
}

// ========== ДОХОДНОСТЬ (новая SaaS-style страница) ==========
var _finCharts = {};
var _finCurrentPeriod = new Date().toISOString().slice(0, 7);

function renderFinancesTabNew() {
  var c = document.getElementById('bankOverviewSection') || document.getElementById('acc-finances');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">Загрузка финансовых данных…</div>';
  // Destroy old charts
  for (var k in _finCharts) { try { _finCharts[k].destroy(); } catch (_) {} }
  _finCharts = {};

  api(API + '/api/admin/finance_dashboard?period=' + encodeURIComponent(_finCurrentPeriod))
    .then(function(d) {
      if (d.error) { c.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(d.error) + '</div>'; return; }
      _renderFinanceDashboard(c, d);
    })
    .catch(function(e) { c.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(e.message) + '</div>'; });
}

function _fmtRub(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('ru-RU') + ' ₽';
}
function _fmtPct(v, signed) {
  if (v == null || isNaN(v)) return '—';
  var s = (signed && v > 0 ? '+' : '') + v;
  return s + '%';
}
function _kpiBig(label, value, sub, color) {
  var _grn = color && String(color).indexOf('success') >= 0;
  return '<div class="cd-kpi' + (_grn ? ' is-green' : '') + '" style="flex:1;min-width:170px;padding:12px 14px">'
    + '<div class="cd-kpi-l">' + esc(label) + '</div>'
    + '<div class="cd-kpi-v" style="font-size:22px;margin-top:4px;' + (color ? 'color:' + color : '') + '">' + value + '</div>'
    + (sub ? '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + sub + '</div>' : '')
    + '</div>';
}

function _injectFinxStyle() { /* finance styles now live in css/finance.css */ }

function _renderFinanceDashboard(c, d) {
  var s = d.summary || {};
  var costByCat = d.cost_by_category || {};
  _injectFinxStyle();

  var periods = [];
  for (var i = 0; i < 12; i++) { var dt = new Date(); dt.setMonth(dt.getMonth() - i); periods.push(dt.toISOString().slice(0, 7)); }

  function money(v) { return (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽'; }

  // Revenue is taken for the SELECTED period (from the monthly trend), so the
  // date picker actually drives the headline P&L. Current month → revenue so far.
  var curMonth = new Date().toISOString().slice(0, 7);
  var isCur = d.period === curMonth;
  var trendArr = d.trend || [];
  var pIdx = trendArr.map(function(t) { return t.month; }).indexOf(d.period);
  var revenue = pIdx >= 0 ? (trendArr[pIdx].total || 0) : (isCur ? (s.forecast_so_far || 0) : 0);
  var cost = s.total_cost || 0;
  var profit = revenue - cost;
  var costPct = revenue > 0 ? Math.round(cost / revenue * 100) : 0;
  var marginPct = (revenue > 0 && cost > 0) ? Math.round(profit / revenue * 100) : null;
  var profitForecast = (s.forecast_eom || 0) - cost;
  var posBal = (d.per_client || []).reduce(function(a, p) { return a + (p.balance > 0 ? p.balance : 0); }, 0);

  // M/M growth = selected period vs the previous month in the trend
  var prevRev = pIdx > 0 ? (trendArr[pIdx - 1].total || 0) : 0;
  var g = prevRev > 0 ? Math.round((revenue - prevRev) / prevRev * 1000) / 10 : null;
  var growthSub = (g == null)
    ? '<span style="color:var(--t3)">нет данных м/м</span>'
    : '<span style="color:' + (g >= 0 ? 'var(--gr)' : 'var(--rd)') + '">' + (g >= 0 ? '▲ +' : '▼ ') + Math.abs(g) + '%</span> м/м';

  var h = '<div class="fxw">';

  h += '<div class="fx-hd"><h2 class="fx-h">Финансы</h2><div class="fx-act">';
  h += '<button class="fx-btn" onclick="generateBulkActs()">📃 Сформировать акты</button>';
  h += '<button class="fx-btn" onclick="openFinanceCostsModal()">⚙ Затраты</button>';
  h += '<select id="finPeriodSelect" class="fx-sel" onchange="_finCurrentPeriod=this.value;renderFinancesTabNew()">';
  periods.forEach(function(p) { h += '<option value="' + p + '"' + (p === d.period ? ' selected' : '') + '>' + p + '</option>'; });
  h += '</select></div></div>';

  h += '<div class="fx-kpis">';
  h += '<div class="fx-kpi"><div class="fx-kl">Выручка</div><div class="fx-kv">' + money(revenue) + '</div><div class="fx-ks">' + growthSub + '</div></div>';
  var costSub = cost > 0
    ? (s.cost_carried_from ? '<span style="color:var(--am)">типовые из ' + esc(s.cost_carried_from) + '</span> · ' + costPct + '%' : (costPct + '% от выручки'))
    : '<span style="color:var(--am)">не введены</span>';
  h += '<div class="fx-kpi a"><div class="fx-kl">Затраты</div><div class="fx-kv">' + (cost > 0 ? money(cost) : '—') + '</div><div class="fx-ks">' + costSub + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Прибыль</div><div class="fx-kv" style="color:var(--gr)">' + money(profit) + '</div><div class="fx-ks">' + (isCur ? 'прогноз ' + shortCurrency(profitForecast) : 'за месяц') + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Маржа</div><div class="fx-kv" style="color:var(--gr)">' + (marginPct == null ? '—' : marginPct + '%') + '</div><div class="fx-ks">' + (s.margin_per_modem != null ? Math.round(s.margin_per_modem).toLocaleString('ru-RU') + ' ₽/модем' : '') + '</div></div>';
  h += '</div>';

  h += '<div class="fx-wgs">';
  h += '<div class="fx-wg"><div class="fx-wl">Активных клиентов</div><div class="fx-wv">' + (s.active_clients || 0) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">NRR</div><div class="fx-wv"' + (s.nrr_pct >= 100 ? ' style="color:var(--gr)"' : '') + '>' + (s.nrr_pct == null ? '—' : s.nrr_pct + '%') + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">На балансах</div><div class="fx-wv">' + shortCurrency(posBal) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">ARPU</div><div class="fx-wv">' + money(s.arpu) + '</div></div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Выручка по дням</span><span class="fx-cs">последние 30 дней · ₽</span></div>';
  h += '<div style="height:130px"><canvas id="fxDailyChart"></canvas></div></div>';

  h += '<div class="fx-row2">';
  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Затраты по категориям</span><span class="fx-lk" onclick="openFinanceCostsModal()">✎ править</span></div>';
  var catLabels = { server: 'Аренда серверов', sim: 'SIM-карты', electricity: 'Электричество', hosting: 'Хостинг', salary: 'Зарплата', other: 'Прочее' };
  var anyCost = false;
  Object.keys(catLabels).forEach(function(k) {
    var v = costByCat[k] || 0;
    if (v > 0) { anyCost = true; h += '<div class="fx-lr"><span class="fx-nm">' + catLabels[k] + '</span><span class="fx-vv">' + Math.round(v).toLocaleString('ru-RU') + '</span></div>'; }
  });
  if (anyCost) {
    if (s.cost_carried_from) h += '<div style="font-size:10px;color:var(--am);margin:2px 0 4px">⚠ Типовые значения из ' + esc(s.cost_carried_from) + ' — подтвердите через «править»</div>';
    h += '<div class="fx-tot"><span>Итого</span><span class="fx-vv" style="color:var(--am)">' + money(cost) + '</span></div>';
  }
  else h += '<div class="fx-empty">Затраты за ' + esc(d.period) + ' не введены — нажмите «править».</div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Последние платежи</span><span class="fx-lk" onclick="switchBankNav(\'payments\')">все →</span></div>';
  var rp = d.recent_payments || [];
  if (rp.length === 0) h += '<div class="fx-empty">Платежей пока нет.</div>';
  else rp.forEach(function(p) {
    var pos = p.amount >= 0;
    var sub = esc((p.date || '').slice(5)) + ' · ' + esc(p.source);
    if (p.kind === 'списание') sub += ' · ' + esc(p.note || 'списание');
    h += '<div class="fx-lr"><div><div class="fx-nm">' + esc(p.client) + '</div><div class="fx-sub">' + sub + '</div></div>'
      + '<span class="fx-vv ' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '−') + Math.abs(Math.round(p.amount)).toLocaleString('ru-RU') + '</span></div>';
  });
  h += '</div></div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Доходность по клиентам</span><span class="fx-cs">по MRR</span></div>';
  h += '<div style="overflow-x:auto"><table class="fx-tbl"><thead><tr><th>Клиент</th><th>Тариф</th><th>Выручка</th><th>Δ M/M</th><th>% MRR</th><th>Баланс</th></tr></thead><tbody>';
  var rows = (d.per_client || []).filter(function(p) { return !(p.mrr === 0 && p.mrr_prev === 0 && !p.balance); });
  rows.forEach(function(p, i) {
    var col = CHART_COLORS.clients[i % CHART_COLORS.clients.length];
    var pausedTag = p.paused ? ' <span class="fx-pause">пауза</span>' : '';
    var dc = p.mrr_delta_pct == null ? 'var(--t3)' : p.mrr_delta_pct >= 0 ? 'var(--gr)' : 'var(--rd)';
    var ds = p.mrr_delta_pct == null ? '—' : (p.mrr_delta_pct >= 0 ? '+' : '') + p.mrr_delta_pct + '%';
    var pill = p.billingType === 'per_modem' ? '<span class="fx-pill pm">per_modem</span>' : '<span class="fx-pill pg">per_gb</span>';
    var balCol = p.balance < 0 ? 'var(--rd)' : 'var(--t1)';
    h += '<tr><td><span class="fx-cn"><span class="fx-dot" style="background:' + col + '"></span>' + esc(p.name) + pausedTag + '</span></td>'
      + '<td>' + pill + '</td><td>' + money(p.mrr) + '</td>'
      + '<td style="color:' + dc + '">' + ds + '</td><td>' + (p.share_pct || 0) + '%</td>'
      + '<td style="color:' + balCol + '">' + money(p.balance) + '</td></tr>';
  });
  h += '</tbody></table></div></div>';

  h += '</div>';
  c.innerHTML = h;

  setTimeout(function() {
    var dcv = document.getElementById('fxDailyChart');
    if (dcv && window.Chart) {
      var dr = d.daily_revenue || [];
      var vals = dr.map(function(r) { return r.revenue; });
      var maxv = Math.max.apply(null, vals.concat([1]));
      var cols = vals.map(function(v) { return v >= maxv * 0.85 ? '#16a34a' : '#2f6fe0'; });
      _finCharts.daily = newChartSafe(dcv, {
        type: 'bar',
        data: { labels: dr.map(function(r) { return (r.date || '').slice(5); }), datasets: [Object.assign({ data: vals, backgroundColor: cols, borderRadius: chartStackRadius() }, CHART_BAR_STACK)] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return (ctx.parsed.y || 0).toLocaleString('ru-RU') + ' ₽'; } } } },
          scales: {
            x: { ticks: { color: '#8b949e', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: '#8b949e', font: { size: 9 }, callback: function(v) { return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v; } }, grid: { color: 'rgba(0,0,0,.07)' } }
          }
        }
      });
    }
  }, 30);
}

// ===== Costs modal =====
function openFinanceCostsModal() {
  api(API + '/api/admin/monthly_costs?period=' + encodeURIComponent(_finCurrentPeriod))
    .then(function(d){ _renderCostsModal(d); })
    .catch(function(e){ showToast(e.message, 'error') });
}
function _renderCostsModal(d) {
  var ov = document.createElement('div');
  ov.id = '_finCostsOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
  var rows = (d.rows && d.rows.length) ? d.rows : (d.template || []).map(function(t){return Object.assign({},t)});
  var byCat = {};
  rows.forEach(function(r){ (byCat[r.category]=byCat[r.category]||[]).push(r); });

  var cats = d.categories || {};
  // One labelled cost row in the Settings idiom (left title, right input + ₽ unit).
  // data-cat / data-key on the <input> are READ BY saveCostsModal — must be preserved.
  function _costRow(label, cls, cat, key, step, val){
    return '<div class="set-row"><div class="set-row-t">'+label+'</div>'
      + '<span class="set-inp"><input class="'+cls+'" data-cat="'+cat+'"'+(key!=null?' data-key="'+esc(key)+'"':'')
      + ' type="number" min="0" step="'+step+'" value="'+(val!=null?val:'')+'" placeholder="0" style="width:108px;text-align:right"><span>₽</span></span></div>';
  }
  var inputs = '';
  // Server costs
  var srvList = (d.meta && d.meta.servers) || ['S1','S2','S3','S4'];
  inputs += '<div class="set-grp-label">'+(cats.server?cats.server.label:'Аренда серверов')+'</div><div class="set-card">';
  srvList.forEach(function(s){
    var existing = (byCat.server||[]).find(function(r){return r.subkey===s});
    inputs += _costRow(esc(s), 'form-input fc-server', 'server', s, 100, existing?existing.amount:null);
  });
  inputs += '</div>';
  // SIM (per operator)
  var ops = (d.meta && d.meta.operators) || [];
  inputs += '<div class="set-grp-label">'+(cats.sim?cats.sim.label:'SIM-карты')+' (₽/SIM в месяц)</div><div class="set-card">';
  if (ops.length === 0) {
    inputs += '<div class="set-row"><div class="set-row-d" style="max-width:none">Операторы не определены — укажите общую сумму через «Прочее»</div></div>';
  } else {
    ops.forEach(function(op){
      var existing = (byCat.sim||[]).find(function(r){return r.subkey===op});
      inputs += _costRow(esc(op), 'form-input fc-sim', 'sim', op, 10, existing?existing.amount:null);
    });
  }
  inputs += '</div>';
  // Other (single value, no subkey)
  inputs += '<div class="set-grp-label">Прочие затраты</div><div class="set-card">';
  ['electricity','hosting','salary','other'].forEach(function(k){
    var existing = (byCat[k]||[])[0];
    inputs += _costRow((cats[k]?cats[k].label:k), 'form-input fc-other', k, null, 100, existing?existing.amount:null);
  });
  inputs += '</div>';

  ov.innerHTML = '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;width:560px;max-width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
    + '<h3 style="margin:0;font-size:14px">⚙ Затраты — ' + esc(d.period) + '</h3>'
    + '<button onclick="document.getElementById(\'_finCostsOverlay\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-2)">&times;</button>'
    + '</div>'
    + (rows.length === 0 && (d.template || []).length > 0 ? '<div style="font-size:11px;color:var(--accent);margin-bottom:6px">⚠ Подставлены значения из предыдущего месяца — отредактируйте и сохраните</div>' : '')
    + inputs
    + '<div class="set-save-bar" style="justify-content:flex-end">'
    + '<button class="btn" onclick="document.getElementById(\'_finCostsOverlay\').remove()">Отмена</button>'
    + '<button class="btn btn-primary" onclick="saveCostsModal()">💾 Сохранить</button>'
    + '</div></div>';
  document.body.appendChild(ov);
}
function saveCostsModal() {
  var items = [];
  document.querySelectorAll('#_finCostsOverlay input').forEach(function(inp){
    var v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) return;
    items.push({ category: inp.dataset.cat, subkey: inp.dataset.key || null, amount: v });
  });
  api(API + '/api/admin/monthly_costs',{method:'POST',json:{ period: _finCurrentPeriod, items: items }})
    .then(function(d){
      if (d.ok) {
        showToast('Затраты сохранены: ' + d.saved + ' позиций', 'success');
        document.getElementById('_finCostsOverlay').remove();
        renderFinancesTabNew();
      } else {
        showToast(d.error || 'Ошибка', 'error');
      }
    })
    .catch(function(e){ showToast(e.message, 'error') });
}

// Top Resources — uses server-side aggregated cache (auto-refreshes nightly at 03:00)
function loadTopHosts(forceRefresh){
  document.getElementById('resLoading').style.display='flex';
  document.getElementById('resLastLoad').textContent='Загрузка...';
  var url=forceRefresh?API+'/api/admin/top_hosts_refresh':API+'/api/admin/top_hosts_aggregated';
  var opts=forceRefresh?{method:'POST',headers:{'X-Auth-Token':authToken}}:{headers:{'X-Auth-Token':authToken}};
  fetch(url,opts).then(function(r){return r.json()}).then(function(result){
    if(forceRefresh){
      return api(API+'/api/admin/top_hosts_aggregated').catch(function(){return {data:{}};});
    }
    return result;
  }).then(function(cache){
    var data=cache.data||{};
    if(Object.keys(data).length===0&&!forceRefresh){
      // No cached data yet — trigger server-side refresh
      return loadTopHosts(true);
    }
    topHostsCache=data;
    topHostsCachePerPort=cache.perPort||null;
    document.getElementById('resLoading').style.display='none';
    var updatedAt=cache.updatedAt?new Date(cache.updatedAt).toLocaleString('ru-RU'):'нет данных';
    var stats=cache.stats||{};
    document.getElementById('resLastLoad').textContent='Обновлено: '+updatedAt+(stats.portsScanned?' | '+stats.portsScanned+' портов, '+stats.errors+' ошибок':'');
    document.getElementById('resCount').textContent=Object.keys(data).length;
    renderTopResources();
  }).catch(function(e){
    document.getElementById('resLoading').style.display='none';
    document.getElementById('resLastLoad').textContent='Ошибка: '+(e.message||e);
  });
}

function renderTopResources(){
  if(!topHostsCache){
    document.getElementById('topResourcesList').innerHTML='<div style="color:var(--text-3);padding:30px;text-align:center;font-size:13px"><div class="spinner" style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin-bottom:8px"></div><br>Загрузка данных о ресурсах...</div>';
    return;
  }
  // Use resClientFilter on resources page
  var clientFilter=document.getElementById('resClientFilter');
  var filterPortName=clientFilter?clientFilter.value:'';
  var dataSource=topHostsCache;
  var showAll=false;
  if(filterPortName&&topHostsCachePerPort){
    if(topHostsCachePerPort[filterPortName]){
      dataSource=topHostsCachePerPort[filterPortName];
      showAll=true;
    }else{
      document.getElementById('topResourcesList').innerHTML='<div style="color:var(--text-3);padding:30px;text-align:center;font-size:13px">Нет данных для этого клиента.<br>Нажмите «Обновить ресурсы» для загрузки.</div>';
      return;
    }
  }
  var sorted=Object.keys(dataSource).sort(function(a,b){return dataSource[b]-dataSource[a]});
  var displayItems=showAll?sorted:sorted.slice(0,50);
  var maxCount=displayItems.length?dataSource[displayItems[0]]:0;

  // Horizontal bars (no quick filters)
  var items=displayItems.map(function(h,i){return{label:h,value:dataSource[h],color:['blue','green','orange','purple','red'][i%5]}});
  document.getElementById('topResourcesList').innerHTML='<div style="max-height:600px;overflow-y:auto">'+renderHBarsRes(items,maxCount)+'</div>';

  // Categories — progress bars
  var categoryCounts={};sorted.forEach(function(h){var cat=categorize(h);if(!categoryCounts[cat])categoryCounts[cat]=0;categoryCounts[cat]+=dataSource[h]});
  var catH='<div style="padding:8px 0">';
  var cats=Object.keys(categoryCounts).sort(function(a,b){return categoryCounts[b]-categoryCounts[a]});
  var catTotal=cats.reduce(function(s,c){return s+categoryCounts[c]},0)||1;
  cats.forEach(function(cat){
    var cnt=categoryCounts[cat];
    var pct=Math.round(cnt/catTotal*100);
    var col=CHART_COLORS.categories[cat]||'#B4B2A9';
    catH+='<div style="margin-bottom:10px">';
    catH+='<div style="display:flex;align-items:baseline;margin-bottom:3px;font-size:12px">';
    catH+='<span style="flex:1;color:var(--text-0)">'+esc(cat)+'</span>';
    catH+='<span style="font-size:11px;color:var(--text-2);margin-right:8px">'+cnt.toLocaleString('ru-RU')+' запросов</span>';
    catH+='<span style="font-weight:500;width:36px;text-align:center;font-size:12px">'+pct+'%</span>';
    catH+='</div>';
    catH+='<div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">';
    catH+='<div style="height:6px;border-radius:3px;background:'+col+';width:'+pct+'%"></div>';
    catH+='</div></div>';
  });
  catH+='</div>';
  var catEl=document.getElementById('catBars');
  if(catEl)catEl.innerHTML=cats.length?catH:'<div style="color:var(--text-3);font-size:11px">Нет данных</div>';

  // "Без соцсетей" top domains panel
  var nsEl=document.getElementById('catBarsNoSocial');
  if(nsEl){
    var nsSorted=Object.keys(dataSource).filter(function(h){return!_socialPat.test(h)}).sort(function(a,b){return dataSource[b]-dataSource[a]}).slice(0,10);
    var nsMax=nsSorted.length?dataSource[nsSorted[0]]:1;
    var nsH='';
    nsSorted.forEach(function(h,i){
      var val=dataSource[h];var pw=Math.round(val/nsMax*100);
      nsH+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px">';
      nsH+='<div style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent)" title="'+esc(h)+'">'+esc(h)+'</div>';
      nsH+='<div style="flex:1;height:8px;background:var(--bg-3);border-radius:2px;overflow:hidden"><div style="height:8px;border-radius:2px;background:var(--accent);opacity:.6;width:'+pw+'%"></div></div>';
      nsH+='<div style="width:50px;text-align:right;font-family:var(--font-mono);font-size:10px;color:var(--text-1)">'+val.toLocaleString()+'</div></div>';
    });
    nsEl.innerHTML=nsH||'<div style="color:var(--text-3);font-size:11px">Нет данных</div>';
  }

}

function renderHBarsRes(items,maxVal){
  if(!items.length)return'';
  var h='<table class="res-table"><thead><tr><th style="width:24px">#</th><th>Домен</th><th style="width:50px">Кат.</th><th style="width:180px">Запросов</th><th style="width:60px">Кол-во</th></tr></thead><tbody>';
  items.forEach(function(item,i){
    var cat=categorize(item.label);
    var catShort=cat.substring(0,6);
    h+='<tr><td style="color:var(--text-3);font-size:10px">'+(i+1)+'</td><td class="domain" title="'+esc(item.label)+'">'+esc(item.label)+'</td><td style="font-size:9px;color:var(--text-3)">'+catShort+'</td><td><div class="hbar-bar-wrap" style="height:10px"><div class="count-bar" style="width:'+pct(item.value,maxVal)+'%"></div></div></td><td style="font-family:monospace;font-size:10px;color:var(--text-0)">'+item.value.toLocaleString()+'</td></tr>';
  });
  return h+'</tbody></table>';
}

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
  var _cnt={all:0,active:0,debtors:0,expiring:0},_mrr=0;cl.forEach(function(c){var b=c.balance!==undefined?c.balance:0;var ch=((currentData.clientMonthCharges||{})[c.id]||0);var md=(pnm[c.portName]||[]).length;_cnt.all++;_mrr+=ch;if(b<0){_cnt.debtors++;}else{if(md>0)_cnt.active++;if(ch>0&&b/(ch/30)<5)_cnt.expiring++;}});
  var h='';var count=0;var colors=CHART_COLORS.clients;
  cl.forEach(function(c,i){
    var modems=pnm[c.portName]||[];
    if(search&&(c.name+' '+c.portName+' '+c.login+' '+(c.contact||'')+' '+(c.legalName||'')).toLowerCase().indexOf(search)===-1)return;
    var balance=c.balance!==undefined?c.balance:0;
    var _ch0=((currentData.clientMonthCharges||{})[c.id]||0);if(_clientFilter==='active'&&!(balance>=0&&modems.length>0))return;if(_clientFilter==='debtors'&&balance>=0)return;if(_clientFilter==='expiring'&&!(balance>=0&&_ch0>0&&balance/(_ch0/30)<5))return;
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
function renderPricingTiers() {
  var tiers = (currentData && currentData.settings && currentData.settings.pricing_tiers) || [{min_proxies:1,price:30,label:'1-4'},{min_proxies:5,price:25,label:'5-9'},{min_proxies:10,price:23,label:'10-19'},{min_proxies:20,price:20,label:'20+'}];
  var h = '<table class="log-table"><thead><tr><th>От (портов)</th><th>Цена (руб/мод)</th><th>Описание</th></tr></thead><tbody>';
  tiers.forEach(function(t, i) {
    h += '<tr><td><input class="form-input" type="number" id="tierMin_'+i+'" value="'+t.min_proxies+'" style="width:80px"></td><td><input class="form-input" type="number" id="tierPrice_'+i+'" value="'+t.price+'" style="width:80px"></td><td><input class="form-input" id="tierLabel_'+i+'" value="'+(t.label||'')+'" style="width:120px"></td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('pricingTiersArea').innerHTML = h;
}
function savePricingTiers() {
  var tiers = [];
  for (var i = 0; i < 10; i++) {
    var minEl = document.getElementById('tierMin_'+i);
    var priceEl = document.getElementById('tierPrice_'+i);
    var labelEl = document.getElementById('tierLabel_'+i);
    if (!minEl) break;
    tiers.push({min_proxies: parseInt(minEl.value)||1, price: parseFloat(priceEl.value)||0, label: labelEl.value||''});
  }
  api(API+'/api/admin/settings',{method:'PUT',json:{pricing_tiers:tiers}}).then(function(d){
    if(d.ok) showToast('Тарифы сохранены','success');
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}

// ========== SERVERS ==========
function loadServersList(){
  api(API+'/api/admin/servers').then(function(d){
    var el=document.getElementById('serversList');if(!el)return;
    if(!d.servers||!d.servers.length){el.innerHTML='<div style="color:var(--text-3);font-size:12px">Нет серверов</div>';return}
    var h='';
    d.servers.forEach(function(s){
      var cn=s.country||{};
      var cc=cn.country||'';
      var flag=cc==='MD'?'🇲🇩':cc==='RO'?'🇷🇴':'🌍';
      var cName=cn.name||cc;
      // «Модемов» и «в работе» — строго fleet (WP1: единый источник на все
      // страницы). Живой fallback-подсчёт удалён: он и давал расхождения.
      var _fb=currentData&&currentData.fleet&&currentData.fleet.byServer&&currentData.fleet.byServer[s.name];
      var onlineCount=_fb?((_fb.working!=null)?_fb.working:_fb.online):0;
      var modemCount=_fb?_fb.total:0;
      if(modemCount<onlineCount)modemCount=onlineCount;
      var isOnline=onlineCount>0;
      var sn=esc(s.name);

      h+='<div class="server-card" id="srv_'+sn+'">';
      // Header
      h+='<div class="server-header"><div class="server-header-left">';
      h+='<span class="server-id">'+sn+'</span>';
      h+='<div class="server-country">'+flag+' '+esc(cName)+'</div>';
      h+='<div class="server-meta"><span class="meta-sep"></span>'+modemCount+' модемов<span class="meta-sep"></span>'+onlineCount+' в работе</div>';
      h+='</div>';
      h+='<span class="status-pill '+(isOnline?'online':'offline')+'">'+(isOnline?'ONLINE':'OFFLINE')+'</span>';
      h+='</div>';
      // Body (view mode)
      h+='<div class="server-body" id="srvBody_'+sn+'">';
      h+='<div class="server-field"><div class="server-field-label">API Endpoint</div><div class="server-field-value"><span>'+esc(s.url)+'</span><button class="copy-btn" onclick="copyText(\''+esc(s.url).replace(/'/g,"\\'")+'\',this)">📋</button></div></div>';
      h+='<div class="server-field"><div class="server-field-label">Public IP</div><div class="server-field-value"><span>'+esc(s.publicIp||'—')+'</span>'+(s.publicIp?'<button class="copy-btn" onclick="copyText(\''+esc(s.publicIp)+'\',this)">📋</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель (API)</div><div class="server-field-value"><span>'+esc(s.panelUser||'—')+'</span> / <span id="panelPwdView_'+sn+'">'+(s.panelPassword?'••••••••':'—')+'</span>'+(s.panelPassword?'<button class="toggle-btn" onclick="var sp=document.getElementById(\'panelPwdView_'+sn+'\');if(sp.dataset.shown){sp.textContent=\'••••••••\';sp.dataset.shown=\'\';this.textContent=\'👁\'}else{sp.textContent=\''+esc(s.panelPassword).replace(/'/g,"\\'")+'\';sp.dataset.shown=\'1\';this.textContent=\'🔒\'}">👁</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Доступ</div><div class="server-field-value"><span>'+esc(s.osLogin||'—')+'</span> / <span id="sshPwdView_'+sn+'">'+(s.osPassword?'••••••••':'—')+'</span>'+(s.osPassword?'<button class="toggle-btn" onclick="var sp=document.getElementById(\'sshPwdView_'+sn+'\');if(sp.dataset.shown){sp.textContent=\'••••••••\';sp.dataset.shown=\'\';this.textContent=\'👁\'}else{sp.textContent=\''+esc(s.osPassword).replace(/'/g,"\\'")+'\';sp.dataset.shown=\'1\';this.textContent=\'🔒\'}">👁</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Оборудование</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.hardware?'var(--text-1)':'var(--text-3)')+'">'+esc(s.hardware||'— не указаны —')+'</span></div></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">📍 Адрес локации</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.address?'var(--text-1)':'var(--text-3)')+'">'+esc(s.address||'— не указан —')+'</span></div></div>';
      h+='</div>';
      // Edit body (hidden)
      h+='<div class="server-body" id="srvEdit_'+sn+'" style="display:none">';
      h+='<div class="server-field"><div class="server-field-label">Панель Логин</div><input class="form-input" id="panelUser_'+sn+'" value="'+esc(s.panelUser||'')+'" placeholder="proxy" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель Пароль</div><input class="form-input" id="panelPass_'+sn+'" value="'+esc(s.panelPassword||'')+'" placeholder="пароль" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Логин</div><input class="form-input" id="osLogin_'+sn+'" value="'+esc(s.osLogin||'')+'" placeholder="root" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Пароль</div><input class="form-input" id="osPass_'+sn+'" value="'+esc(s.osPassword||'')+'" placeholder="пароль" style="font-size:12px"></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">Оборудование</div><input class="form-input" id="hw_'+sn+'" value="'+esc(s.hardware||'')+'" placeholder="CPU, RAM, Disk, OS..." style="font-size:12px;width:100%"></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">📍 Адрес локации</div><input class="form-input" id="addr_'+sn+'" value="'+esc(s.address||'')+'" placeholder="Город, ул. Примерная, д. 1" style="font-size:12px;width:100%"></div>';
      h+='</div>';
      // Footer
      h+='<div class="server-footer"><div class="server-actions">';
      h+='<button class="btn btn-sm" id="srvEditBtn_'+sn+'" onclick="toggleServerEdit(\''+sn+'\')" style="font-size:11px">✏️ Редактировать</button>';
      h+='<button class="btn btn-sm" id="srvSaveBtn_'+sn+'" onclick="saveServerMeta(\''+sn+'\')" style="font-size:11px;display:none">💾 Сохранить</button>';
      h+='<button class="btn btn-sm" id="srvCancelBtn_'+sn+'" onclick="toggleServerEdit(\''+sn+'\',true)" style="font-size:11px;display:none">Отмена</button>';
      h+='<span id="srvSaveStatus_'+sn+'" style="font-size:11px;margin-left:6px"></span>';
      h+='</div>';
      h+='<button class="btn btn-sm" style="color:var(--danger);font-size:10px" onclick="deleteServer(\''+sn+'\')">✕ Удалить</button>';
      h+='</div>';
      h+='</div>';
    });
    el.innerHTML=h;
  }).catch(function(e){var el=document.getElementById('serversList');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>'})
}
function toggleServerEdit(name,cancel){
  var body=document.getElementById('srvBody_'+name);
  var edit=document.getElementById('srvEdit_'+name);
  var editBtn=document.getElementById('srvEditBtn_'+name);
  var saveBtn=document.getElementById('srvSaveBtn_'+name);
  var cancelBtn=document.getElementById('srvCancelBtn_'+name);
  if(cancel||edit.style.display!=='none'){
    body.style.display='';edit.style.display='none';
    editBtn.style.display='';saveBtn.style.display='none';cancelBtn.style.display='none';
    if(cancel)loadServersList();
  }else{
    body.style.display='none';edit.style.display='';
    editBtn.style.display='none';saveBtn.style.display='';cancelBtn.style.display='';
  }
}
function saveServerMeta(name){
  var osLogin=document.getElementById('osLogin_'+name).value;
  var osPass=document.getElementById('osPass_'+name).value;
  var panelUser=document.getElementById('panelUser_'+name).value;
  var panelPass=document.getElementById('panelPass_'+name).value;
  var hw=document.getElementById('hw_'+name).value;
  var addr=(document.getElementById('addr_'+name)||{}).value||'';
  var st=document.getElementById('srvSaveStatus_'+name);
  st.textContent='Сохраняю и проверяю Панель...';st.style.color='var(--warning)';
  api(API+'/api/admin/servers/'+name,{method:'PATCH',json:{osLogin:osLogin,osPassword:osPass,panelUser:panelUser,panelPassword:panelPass,hardware:hw,address:addr}}).then(function(d){
    if(d.ok){st.textContent='Сохранено ✓';st.style.color='var(--success)';setTimeout(function(){loadServersList()},1000)}
    else{st.textContent=(d.error||'Ошибка')+(d.details?' ('+esc(d.details)+')':'');st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'})
}
function addServer(){
  var name=document.getElementById('newSrvName').value.trim();
  var url=document.getElementById('newSrvUrl').value.trim();
  var user=document.getElementById('newSrvUser').value.trim()||'proxy';
  var pass=document.getElementById('newSrvPass').value.trim();
  var publicIp=document.getElementById('newSrvIp').value.trim();
  var country=document.getElementById('newSrvCountry').value;
  var countryName=country==='MD'?'Moldova':'Romania';
  var tz=country==='MD'?'Europe/Chisinau':'Europe/Bucharest';
  var status=document.getElementById('addSrvStatus');
  if(!name||!url||!pass){status.textContent='Заполните имя, URL и пароль';status.style.color='var(--danger)';return}
  status.textContent='Проверяю подключение...';status.style.color='var(--warning)';
  api(API+'/api/admin/servers',{method:'POST',json:{name:name,url:url,user:user,pass:pass,publicIp:publicIp,country:country,countryName:countryName,tz:tz}}).then(function(d){
    if(d.ok){status.textContent='Добавлен! '+d.modemCount+' модемов';status.style.color='var(--success)';loadServersList();setTimeout(loadData,2000)}
    else{status.textContent=d.error||'Ошибка';status.style.color='var(--danger)'}
  }).catch(function(e){status.textContent=e.message;status.style.color='var(--danger)'})
}

function deleteServer(name){
  if(!confirm('Удалить сервер '+name+'?'))return;
  api(API+'/api/admin/servers/'+name,{method:'DELETE'}).then(function(d){
    if(d.ok){showToast('Сервер '+name+' удалён','success');loadServersList();setTimeout(loadData,2000)}
    else showToast(d.error||'Ошибка','error')
  }).catch(function(e){showToast(e.message||'Ошибка сети','error')})
}

// ========== SETTINGS ==========
var _minSpeedThreshold=2;
var _errorRateThreshold=15;
function loadSettings(){
  api(API+'/api/admin/settings').then(function(s){
    var times=s.speedtest_times||['02:00','14:00'];
    document.getElementById('speedtestTimesInput').value=times.join(', ');
    document.getElementById('settingsStatus').textContent='Текущее расписание: '+times.join(', ')+' UTC';
    _minSpeedThreshold=s.min_speed_threshold!=null?s.min_speed_threshold:2;
    document.getElementById('minSpeedInput').value=_minSpeedThreshold;
    _errorRateThreshold=s.error_rate_threshold!=null?s.error_rate_threshold:15;
    var _ertEl=document.getElementById('errorRateThresholdInput');if(_ertEl)_ertEl.value=_errorRateThreshold;
    // Stage 18.8: stale_modem_hours — threshold for "offline modem" exclusion from aggregations.
    var _smhEl=document.getElementById('staleModemHoursInput');if(_smhEl)_smhEl.value=s.stale_modem_hours!=null?s.stale_modem_hours:12;
    window._staleModemHours = s.stale_modem_hours != null ? s.stale_modem_hours : 12;
    var _palEl=document.getElementById('proxyAlertLatencyInput');if(_palEl)_palEl.value=s.proxy_alert_latency_ms!=null?s.proxy_alert_latency_ms:1500;
    var _paeEl=document.getElementById('proxyAlertErrorPctInput');if(_paeEl)_paeEl.value=s.proxy_alert_error_pct!=null?s.proxy_alert_error_pct:5;
    var _pawEl=document.getElementById('proxyAlertWindowInput');if(_pawEl)_pawEl.value=s.proxy_alert_window_min!=null?s.proxy_alert_window_min:60;
    var _arE=document.getElementById('autoRebootEnabledInput');if(_arE)_arE.checked=!!s.auto_reboot_enabled;
    var _arI=document.getElementById('autoRebootIntervalInput');if(_arI)_arI.value=s.auto_reboot_min_interval_min!=null?s.auto_reboot_min_interval_min:60;
    _pcWarnMs=s.proxy_check_warn_ms||500;
    _pcBadMs=s.proxy_check_bad_ms||2000;
    var pctEl=document.getElementById('proxyCheckTargetInput');if(pctEl)pctEl.value=s.proxy_check_target||'https://www.instagram.com/';
    var pcwEl=document.getElementById('proxyCheckWarnInput');if(pcwEl)pcwEl.value=_pcWarnMs;
    var pcbEl=document.getElementById('proxyCheckBadInput');if(pcbEl)pcbEl.value=_pcBadMs;
    var pciEl=document.getElementById('proxyCheckIntervalInput');if(pciEl)pciEl.value=s.proxy_check_interval_min||60;
    // Proxy check extended
    var pctmEl=document.getElementById('proxyCheckTimeoutInput');if(pctmEl)pctmEl.value=s.proxy_check_timeout_sec||15;
    var pccEl=document.getElementById('proxyCheckConcurrencyInput');if(pccEl)pccEl.value=s.proxy_check_concurrency||10;
    // Speedtest extended
    var stlEl=document.getElementById('speedtestLowThresholdInput');if(stlEl)stlEl.value=s.speedtest_low_threshold||1;
    var strEl=document.getElementById('speedtestRetestDelayInput');if(strEl)strEl.value=s.speedtest_retest_delay_min||10;
    var stmEl=document.getElementById('speedtestMaxHistoryInput');if(stmEl)stmEl.value=s.speedtest_max_history||30;
    // Recovery
    var reEl=document.getElementById('recoveryEnabledInput');if(reEl)reEl.checked=(s.recovery_enabled!==false);
    var roEl=document.getElementById('recoveryOfflineSecInput');if(roEl)roEl.value=s.recovery_offline_sec||300;
    var rmEl=document.getElementById('recoveryMaxAttemptsInput');if(rmEl)rmEl.value=s.recovery_max_attempts||3;
    var rrEl=document.getElementById('recoveryRetryMinInput');if(rrEl)rrEl.value=s.recovery_retry_min||5;
    var rdcEl=document.getElementById('recoveryDailyCapInput');if(rdcEl)rdcEl.value=s.recovery_daily_cap||6;
    var rraEl=document.getElementById('recoveryReaddAfterInput');if(rraEl)rraEl.checked=(s.recovery_readd_after!==false);
    var rsdEl=document.getElementById('recoverySkipDeadSimInput');if(rsdEl)rsdEl.checked=(s.recovery_skip_dead_sim!==false);
    var rsuEl=document.getElementById('recoverySkipUnsoldInput');if(rsuEl)rsuEl.checked=(s.recovery_skip_unsold===true);
    // Tracking & rotation
    var tiEl=document.getElementById('trackingIntervalMinInput');if(tiEl)tiEl.value=s.tracking_interval_min||3;
    var rcEl=document.getElementById('rotationCacheTtlInput');if(rcEl)rcEl.value=s.rotation_cache_ttl_min||30;
    var rsEl=document.getElementById('rotationSyncIntervalInput');if(rsEl)rsEl.value=s.rotation_sync_interval_min||30;
    // Retention
    var r1=document.getElementById('retTrafficHourlyInput');if(r1)r1.value=s.retention_traffic_hourly||90;
    var r2=document.getElementById('retAuditLogInput');if(r2)r2.value=s.retention_audit_log||90;
    var r3=document.getElementById('retSystemLogInput');if(r3)r3.value=s.retention_system_log||30;
    var r4=document.getElementById('retRotationLogInput');if(r4)r4.value=s.retention_rotation_log||90;
    var r5=document.getElementById('retProxyChecksInput');if(r5)r5.value=s.retention_proxy_checks||30;
    var r6=document.getElementById('retModemMetaInput');if(r6)r6.value=s.retention_modem_meta||30;
    // Session, billing, CRM
    var stEl=document.getElementById('sessionTtlDaysInput');if(stEl)stEl.value=s.session_ttl_days||30;
    var brEl=document.getElementById('billingRetryHoursInput');if(brEl)brEl.value=s.billing_retry_delay_hours||1;
    var rtEl=document.getElementById('reconciliationToleranceInput');if(rtEl)rtEl.value=s.reconciliation_tolerance_gb||0.01;
    var acEl=document.getElementById('autoCreateIntervalInput');if(acEl)acEl.value=s.auto_create_interval_min||10;
    var ccEl=document.getElementById('crmCheckIntervalInput');if(ccEl)ccEl.value=s.crm_check_interval_min||10;
    var crEl=document.getElementById('crmReminderDaysInput');if(crEl)crEl.value=s.crm_reminder_days||3;
    // Telegram
    var tgT=document.getElementById('tgBotToken');if(tgT)tgT.value=s.telegram_bot_token||'';
    var tgC=document.getElementById('tgChatId');if(tgC)tgC.value=s.telegram_chat_id||'';
    var tgTm=document.getElementById('tgSummaryTime');if(tgTm)tgTm.value=s.telegram_summary_time||'08:00';
    var tgEn=document.getElementById('tgSummaryEnabled');if(tgEn)tgEn.checked=!!s.telegram_summary_enabled;
    if(currentData) currentData.settings = s;
    renderPricingTiers();
  }).catch(function(){});
}
// Telegram: save fields when changed (debounced)
function tgSaveSettings(){
  var data={
    telegram_bot_token:(document.getElementById('tgBotToken').value||'').trim(),
    telegram_chat_id:(document.getElementById('tgChatId').value||'').trim(),
    telegram_summary_time:(document.getElementById('tgSummaryTime').value||'').trim(),
    telegram_summary_enabled:!!document.getElementById('tgSummaryEnabled').checked
  };
  return api(API+'/api/admin/settings',{method:'PUT',json:data});
}
function tgPreview(){
  var st=document.getElementById('tgStatus');
  st.textContent='Готовим превью...';st.style.color='var(--warning)';
  api(API+'/api/admin/telegram/preview').then(function(d){
    if(d.ok){
      var pa=document.getElementById('tgPreviewArea');
      pa.style.display='block';
      // strip HTML tags for plain-text preview
      pa.textContent=(d.text||'').replace(/<[^>]+>/g,'');
      st.textContent='Превью за '+d.date;st.style.color='var(--text-3)';
    } else {
      st.textContent=d.error||'Ошибка';st.style.color='var(--danger)';
    }
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function tgSendTest(){
  var st=document.getElementById('tgStatus');
  st.textContent='Сохраняю настройки и отправляю...';st.style.color='var(--warning)';
  tgSaveSettings().then(function(){
    return fetch(API+'/api/admin/telegram/send_test',{method:'POST',headers:{'Content-Type':'application/json','X-Auth-Token':authToken},body:'{}'}).then(function(r){return r.json()});
  }).then(function(d){
    if(d.ok){st.textContent='✅ Отправлено за '+d.date;st.style.color='var(--success)';showToast('Сводка отправлена в Telegram','success')}
    else{st.textContent='❌ '+(d.error||'Ошибка');st.style.color='var(--danger)';showToast(d.error||'Ошибка','error')}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)';showToast(e.message,'error')});
}
var _pcWarnMs=500,_pcBadMs=2000;
function saveProxyCheckSettings(){
  var target=document.getElementById('proxyCheckTargetInput').value.trim();
  if(!target||!/^https?:\/\/.+/.test(target)){showToast('Неверный URL','error');return}
  var warn=parseInt(document.getElementById('proxyCheckWarnInput').value)||500;
  var bad=parseInt(document.getElementById('proxyCheckBadInput').value)||2000;
  var interval=parseInt(document.getElementById('proxyCheckIntervalInput').value)||60;
  var timeout=parseInt(document.getElementById('proxyCheckTimeoutInput').value)||15;
  var concurrency=parseInt(document.getElementById('proxyCheckConcurrencyInput').value)||10;
  if(warn>=bad){showToast('Порог жёлтого должен быть меньше красного','error');return}
  if(interval<5||interval>1440){showToast('Интервал: от 5 до 1440 мин','error');return}
  _pcWarnMs=warn;_pcBadMs=bad;
  api(API+'/api/admin/settings',{method:'PUT',json:{proxy_check_target:target,proxy_check_warn_ms:warn,proxy_check_bad_ms:bad,proxy_check_interval_min:interval,proxy_check_timeout_sec:timeout,proxy_check_concurrency:concurrency}}).then(function(d){
    if(d.ok){showToast('Настройки замера сохранены','success');document.getElementById('proxyCheckSettingsStatus').textContent='Сохранено: '+target+' | каждые '+interval+' мин | зелёный <'+warn+'мс | жёлтый <'+bad+'мс | красный >'+bad+'мс';renderTable()}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}
function saveSettings(){
  var val=document.getElementById('speedtestTimesInput').value;
  var times=val.split(',').map(function(t){return t.trim()}).filter(function(t){return/^\d{1,2}:\d{2}$/.test(t)});
  if(!times.length){showToast('Неверный формат','error');return}
  var minSpeed=parseFloat(document.getElementById('minSpeedInput').value)||2;
  var errThresh=parseInt(document.getElementById('errorRateThresholdInput').value)||15;
  var lowThresh=parseFloat(document.getElementById('speedtestLowThresholdInput').value)||1;
  var retestDelay=parseInt(document.getElementById('speedtestRetestDelayInput').value)||10;
  var maxHist=parseInt(document.getElementById('speedtestMaxHistoryInput').value)||30;
  var palLatency=parseInt(document.getElementById('proxyAlertLatencyInput').value)||1500;
  var palErrPct=parseFloat(document.getElementById('proxyAlertErrorPctInput').value)||5;
  var palWindow=parseInt(document.getElementById('proxyAlertWindowInput').value)||60;
  var arEnabled=!!(document.getElementById('autoRebootEnabledInput')||{}).checked;
  var arInterval=parseInt(document.getElementById('autoRebootIntervalInput').value)||60;
  _minSpeedThreshold=minSpeed;
  _errorRateThreshold=errThresh;
  var staleH=parseInt(document.getElementById('staleModemHoursInput').value)||12;
  api(API+'/api/admin/settings',{method:'PUT',json:{speedtest_times:times,min_speed_threshold:minSpeed,error_rate_threshold:errThresh,speedtest_low_threshold:lowThresh,speedtest_retest_delay_min:retestDelay,speedtest_max_history:maxHist,proxy_alert_latency_ms:palLatency,proxy_alert_error_pct:palErrPct,proxy_alert_window_min:palWindow,auto_reboot_enabled:arEnabled,auto_reboot_min_interval_min:arInterval,stale_modem_hours:staleH}}).then(function(d){
    if(d.ok){showToast('Настройки сохранены','success');document.getElementById('settingsStatus').textContent='Расписание обновлено: '+times.join(', ')+' UTC';renderTable()}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}

// Stage 19.2 — restart-needed state is GLOBAL + persistent. Any settings save
// that requires a process restart calls _showRestartBanner(); the banner sits
// at the top of every settings section and survives reloads/section-switches
// (localStorage flag) until the dashboard is actually restarted.
function _showRestartBanner(){
  try{localStorage.setItem('pr_restart_needed','1');}catch(_){}
  var g=document.getElementById('globalRestartBanner');if(g)g.style.display='flex';
  var b=document.getElementById('restartBanner');if(b)b.classList.add('visible'); // legacy banner in «Прочее»
}
// Restore the banner on load if a restart is still pending.
function restoreRestartBanner(){
  try{ if(localStorage.getItem('pr_restart_needed')==='1') _showRestartBanner(); }catch(_){}
}
function restartDashboard(){
  if(!confirm('Перезапустить дашборд? Страница обновится через несколько секунд. Это не трогает прокси-серверы — только процесс админки.'))return;
  var btns=[document.getElementById('restartDashboardBtn'),document.getElementById('globalRestartBtn')];
  btns.forEach(function(btn){if(btn){btn.disabled=true;btn.textContent='Перезапуск...'}});
  try{localStorage.removeItem('pr_restart_needed');}catch(_){}
  api(API+'/api/admin/restart_dashboard',{method:'POST'}).then(function(d){
    if(d.ok){showToast('Дашборд перезапускается...','warning');setTimeout(function(){location.reload()},4000)}
    else{showToast(d.error||'Ошибка','error');btns.forEach(function(btn){if(btn){btn.disabled=false;btn.textContent='Перезапустить сейчас'}});}
  }).catch(function(){showToast('Дашборд перезапускается...','warning');setTimeout(function(){location.reload()},4000)});
}
function saveRecoverySettings(){
  var offline=parseInt(document.getElementById('recoveryOfflineSecInput').value)||300;
  var maxAtt=parseInt(document.getElementById('recoveryMaxAttemptsInput').value)||3;
  var retryMin=parseInt(document.getElementById('recoveryRetryMinInput').value)||5;
  var dailyCap=parseInt(document.getElementById('recoveryDailyCapInput').value)||6;
  var enabled=document.getElementById('recoveryEnabledInput').checked;
  var readdAfter=document.getElementById('recoveryReaddAfterInput').checked;
  var skipDeadSim=document.getElementById('recoverySkipDeadSimInput').checked;
  var skipUnsold=document.getElementById('recoverySkipUnsoldInput').checked;
  var st=document.getElementById('recoverySettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{recovery_enabled:enabled,recovery_offline_sec:offline,recovery_max_attempts:maxAtt,recovery_retry_min:retryMin,recovery_daily_cap:dailyCap,recovery_readd_after:readdAfter,recovery_skip_dead_sim:skipDeadSim,recovery_skip_unsold:skipUnsold}}).then(function(d){
    if(d.ok){st.textContent='Сохранено ✓';st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveTrackingSettings(){
  var tracking=parseInt(document.getElementById('trackingIntervalMinInput').value)||3;
  var cacheTtl=parseInt(document.getElementById('rotationCacheTtlInput').value)||30;
  var syncInt=parseInt(document.getElementById('rotationSyncIntervalInput').value)||30;
  var st=document.getElementById('trackingSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{tracking_interval_min:tracking,rotation_cache_ttl_min:cacheTtl,rotation_sync_interval_min:syncInt}}).then(function(d){
    if(d.ok){st.textContent='Сохранено ✓';st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveRetentionSettings(){
  var data={
    retention_traffic_hourly:parseInt(document.getElementById('retTrafficHourlyInput').value)||90,
    retention_audit_log:parseInt(document.getElementById('retAuditLogInput').value)||90,
    retention_system_log:parseInt(document.getElementById('retSystemLogInput').value)||30,
    retention_rotation_log:parseInt(document.getElementById('retRotationLogInput').value)||90,
    retention_proxy_checks:parseInt(document.getElementById('retProxyChecksInput').value)||30,
    retention_modem_meta:parseInt(document.getElementById('retModemMetaInput').value)||30
  };
  var st=document.getElementById('retentionSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.textContent='Сохранено ✓';st.style.color='var(--success)'}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveSessionBillingSettings(){
  var data={
    session_ttl_days:parseInt(document.getElementById('sessionTtlDaysInput').value)||30,
    billing_retry_delay_hours:parseFloat(document.getElementById('billingRetryHoursInput').value)||1,
    reconciliation_tolerance_gb:parseFloat(document.getElementById('reconciliationToleranceInput').value)||0.01,
    auto_create_interval_min:parseInt(document.getElementById('autoCreateIntervalInput').value)||10,
    crm_check_interval_min:parseInt(document.getElementById('crmCheckIntervalInput').value)||10,
    crm_reminder_days:parseInt(document.getElementById('crmReminderDaysInput').value)||3
  };
  var st=document.getElementById('sessionBillingSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.textContent='Сохранено ✓';st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}

// ========== DOCUMENTS ==========
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

function renderOpsDocuments(clientId) {
  var body = document.getElementById('clientOpsBody');
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var actDocs = client ? (client.closingDocuments || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var bills = client ? (client.bills || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var fileDocs = client ? client.documents || [] : [];

  var h = '<div style="padding:4px 0">';

  // === SECTION: АКТЫ ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">📃 Закрывающие документы (акты)</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="actPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="createAct(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">➕ Создать акт</button>';
  h += '</div>';
  if (actDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    actDocs.forEach(function(d) {
      var isSigned = d.status === 'signed';
      var statusHtml = isSigned
        ? '<span style="color:var(--success);font-size:11px">✅ Подписан</span>'
        : '<span style="color:var(--danger);font-size:11px">❌ Не подписан</span>';
      var toggleBtn = isSigned
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'unsigned\')">❌</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'signed\')">✅</button>';
      var pdfBtn = (d.tochkaDocumentId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadActPdf(\'' + clientId + '\',\'' + d.id + '\')">📥 PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.open(API+\'/api/admin/clients/'+clientId+'/closing_documents/'+d.id+'/print?token=\'+authToken,\'_blank\')">🖨</button>';
      h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(d.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="\u041f\u0435\u0440\u0435\u0432\u044b\u0441\u0442\u0430\u0432\u0438\u0442\u044c: \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u0438 \u0441\u043e\u0437\u0434\u0430\u0442\u044c \u0437\u0430\u043d\u043e\u0432\u043e \u043f\u043e \u0442\u0435\u043a\u0443\u0449\u0438\u043c \u0434\u0430\u043d\u043d\u044b\u043c" onclick="reissueAct(\'' + clientId + '\',\'' + d.id + '\',\'' + esc(d.period) + '\')">\u21bb</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0430\u043a\u0442" onclick="deleteAct(\'' + clientId + '\',\'' + d.id + '\')">\ud83d\uddd1</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет закрывающих документов</div>';
  }
  h += '</div>';

  // === SECTION: СЧЕТА ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">💳 Счета на оплату</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="billPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Сумма (авто)</label><input class="form-input" type="number" id="billAmount" placeholder="авто" style="width:100px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="createBill(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">➕ Выставить счёт</button>';
  h += '</div>';
  if (bills.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    bills.forEach(function(b) {
      var isPaid = b.status === 'paid';
      var statusHtml = isPaid
        ? '<span style="color:var(--success);font-size:11px">✅ Оплачен</span>'
        : '<span style="color:var(--danger);font-size:11px">⏳ Не оплачен</span>';
      var toggleBtn = isPaid
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'paid\')">✅</button>';
      var pdfBtn = (b.tochkaBillId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadBillPdf(\'' + clientId + '\',\'' + b.id + '\')">📥 PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.open(API+\'/api/admin/clients/'+clientId+'/bills/'+b.id+'/print?token=\'+authToken,\'_blank\')">🖨</button>';
      h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(b.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u0447\u0451\u0442" onclick="deleteBill(\'' + clientId + '\',\'' + b.id + '\')">\ud83d\uddd1</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет выставленных счетов</div>';
  }
  h += '</div>';

  // === SECTION: ФАЙЛЫ ===
  h += '<div>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">📎 Загруженные документы</h4></div>';
  if (fileDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Документ</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Дата</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    fileDocs.forEach(function(d) {
      h += '<tr>';
      h += '<td style="padding:5px 10px;font-size:12px">' + esc(d.name) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + new Date(d.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) + '</td>';
      h += '<td style="padding:5px 10px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" onclick="deleteDocumentModal(\'' + clientId + '\',\'' + d.id + '\')">Удалить</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет загруженных документов</div>';
  }
  h += '<div style="padding:10px 0;margin-top:8px;display:flex;align-items:center;gap:8px">';
  h += '<input type="file" id="docFileModal" style="font-size:11px;flex:1">';
  h += '<button class="btn btn-primary btn-sm" onclick="uploadDocumentModal(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">Загрузить</button>';
  h += '</div></div>';

  h += '</div>';
  body.innerHTML = h;
}

function uploadDocumentModal(clientId) {
  var fileInput = document.getElementById('docFileModal');
  if (!fileInput || !fileInput.files.length) { showToast('Выберите файл', 'error'); return; }
  var file = fileInput.files[0];
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result.split(',')[1];
    api(API + '/api/admin/clients/' + clientId + '/document',{method:'POST',json:{ name: file.name, fileBase64: base64, mimeType: file.type }})
      .then(function(d) {
        if (d.ok) { showToast('Документ загружен', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
        else showToast(d.error || 'Ошибка', 'error');
      }).catch(function(e) { showToast(e.message, 'error'); });
  };
  reader.readAsDataURL(file);
}

function deleteLedgerEntry(clientId, entryIndex) {
  if (!confirm('\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u044D\u0442\u0443 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u044E? \u0411\u0430\u043B\u0430\u043D\u0441 \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u043D.')) return;
  api(API + '/api/admin/clients/' + clientId + '/ledger/' + entryIndex,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u044F \u0443\u0434\u0430\u043B\u0435\u043D\u0430', 'success'); renderOpsHistory(clientId); loadData(); }
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function addPaymentFromModal(clientId) {
  var amount = document.getElementById('opsPayAmount').value;
  var date = document.getElementById('opsPayDate').value;
  var note = document.getElementById('opsPayNote').value;
  if (!amount || !date) return showToast('Заполните сумму и дату', 'error');
  api(API + '/api/admin/clients/' + clientId + '/payment',{method:'POST',json:{ amount: amount, date: date, note: note }})
    .then(function(d) {
      if (d.ok) { showToast('Платёж добавлен', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsHistory(clientId); }, 1500); }
      else showToast(d.error, 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function manualChargeFromModal(clientId) {
  var amount = document.getElementById('opsPayAmount').value;
  var date = document.getElementById('opsPayDate').value;
  var note = document.getElementById('opsPayNote').value;
  if (!amount || !date) return showToast('Заполните сумму и дату', 'error');
  if (!confirm('Списать ' + amount + ' ₽ с баланса клиента?')) return;
  api(API + '/api/admin/clients/' + clientId + '/charge',{method:'POST',json:{ amount: amount, date: date, note: note || 'Ручное списание' }})
    .then(function(d) {
      if (d.ok) { showToast('Списание выполнено', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsHistory(clientId); }, 1500); }
      else showToast(d.error, 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function deleteDocumentModal(clientId, docId) {
  if (!confirm('Удалить документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== CLOSING DOCUMENTS (ACTS) — helper functions ==========
function createAct(clientId) {
  var period = document.getElementById('actPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  api(API + '/api/admin/tochka/create_act',{method:'POST',json:{ clientId: clientId, period: period }})
    .then(function(d) {
      if (d.ok) {
        if (d.tochkaPushed) showToast('Акт создан и отправлен в Точку', 'success');
        else showToast('Акт сохранён локально, но НЕ ушёл в Точку: ' + (d.tochkaStatus || 'причина неизвестна'), 'error', 12000);
        loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500);
      }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function toggleActStatus(clientId, docId, status) {
  api(API + '/api/admin/clients/' + clientId + '/closing_document_status',{method:'POST',json:{ docId: docId, status: status }})
    .then(function(d) {
      if (d.ok) { showToast(status === 'signed' ? 'Отмечен как подписанный' : 'Подпись снята', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function downloadActPdf(clientId, docId) {
  window.open(API + '/api/admin/clients/' + clientId + '/closing_documents/' + docId + '/pdf?token=' + authToken, '_blank');
}

// Re-issue an act when something is wrong: delete the old one, then regenerate it
// for the same period from the current ledger data (and re-push to Tochka). Reuses
// the existing DELETE + create_act routes — no new backend surface.
function reissueAct(clientId, docId, period) {
  if (!confirm('Перевыставить акт за ' + period + '?\nСтарый будет удалён и создан заново по текущим данным.')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || 'Не удалось удалить старый акт');
      return api(API + '/api/admin/tochka/create_act',{method:'POST',json:{ clientId: clientId, period: period }});
    })
    .then(function(d) {
      if (d.ok) {
        if (d.tochkaPushed) showToast('Акт перевыставлен и отправлен в Точку', 'success');
        else showToast('Акт пересоздан локально, но НЕ ушёл в Точку: ' + (d.tochkaStatus || 'причина неизвестна'), 'error', 12000);
        loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); if (typeof renderBankDocuments === 'function') renderBankDocuments(); }, 1500);
      }
      else showToast(d.error || 'Старый удалён, но новый не создался — нажмите «Создать акт»', 'error');
    })
    .catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function deleteAct(clientId, docId) {
  if (!confirm('Удалить закрывающий документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BILLS (СЧЕТА НА ОПЛАТУ) — helper functions ==========
function createBill(clientId) {
  var period = document.getElementById('billPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var amountVal = document.getElementById('billAmount').value;
  var payload = { clientId: clientId, period: period };
  if (amountVal && parseFloat(amountVal) > 0) payload.amount = parseFloat(amountVal);
  api(API + '/api/admin/tochka/create_bill',{method:'POST',json:payload})
    .then(function(d) {
      if (d.ok) { showToast('Счёт выставлен: ' + (d.amount || 0).toLocaleString('ru-RU') + ' \u20BD', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function toggleBillStatus(clientId, billId, status) {
  api(API + '/api/admin/clients/' + clientId + '/bill_status',{method:'POST',json:{ billId: billId, status: status }})
    .then(function(d) {
      if (d.ok) { showToast(status === 'paid' ? 'Отмечен как оплаченный' : 'Отмечен как неоплаченный', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function downloadBillPdf(clientId, billId) {
  window.open(API + '/api/admin/clients/' + clientId + '/bills/' + billId + '/pdf?token=' + authToken, '_blank');
}

function deleteBill(clientId, billId) {
  if (!confirm('Удалить счёт?')) return;
  api(API + '/api/admin/clients/' + clientId + '/bill/' + billId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Счёт удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK CONFIG (Tochka) ==========
function renderBankConfig() {
  var container = document.getElementById('bankConfigSection');
  if (!container) return;
  var tc = currentData.tochkaConfig || {};
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  h += '<h3 style="margin:0">\u{1F3E6} \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0422\u043E\u0447\u043A\u0430 \u0411\u0430\u043D\u043A</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">\u2705 API \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">\u274C API \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D</span>';
  }
  h += '</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:10px;margin-bottom:12px">';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;font-weight:600">JWT \u0422\u043E\u043A\u0435\u043D *</label><input class="form-input" id="bankJwt" placeholder="\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 JWT \u0442\u043E\u043A\u0435\u043D" style="font-size:12px" value="' + esc(tc.jwt || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;font-weight:600">Client ID *</label><input class="form-input" id="bankClientId" placeholder="client_id" style="font-size:12px" value="' + esc(tc.clientId || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Customer Code</label><input class="form-input" id="bankCustomerCode" placeholder="customer_code" style="font-size:12px" value="' + esc(tc.customerCode || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Account ID</label><input class="form-input" id="bankAccountId" placeholder="account_id" style="font-size:12px" value="' + esc(tc.accountId || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Название компании</label><input class="form-input" id="bankCompanyName" placeholder=\'ООО "Компания"\' style="font-size:12px" value="' + esc(tc.companyName || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">ИНН компании</label><input class="form-input" id="bankCompanyInn" placeholder="1234567890" style="font-size:12px" value="' + esc(tc.companyInn || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">КПП компании</label><input class="form-input" id="bankCompanyKpp" placeholder="123456789" style="font-size:12px" value="' + esc(tc.companyKpp || '') + '"></div>';
  h += '<div style="grid-column:1/-1"><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Адрес компании</label><input class="form-input" id="bankCompanyAddress" placeholder="119334, г. Москва, ул. ..." style="font-size:12px" value="' + esc(tc.companyAddress || '') + '"></div>';
  h += '</div>';
  // Bank details fields removed from UI (still stored in tochka_config if set)
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
  h += '<button class="btn btn-primary" onclick="saveBankConfig()">\u{1F4BE} \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>';
  if (tochkaOk) {
    h += '<button class="btn" style="background:#f59e0b;color:#fff" onclick="autodetectBank()">\u{1F50D} \u0410\u0432\u0442\u043E\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C</button>';
    h += '<button class="btn btn-success" onclick="registerWebhook()">\u{1F517} \u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C webhook</button>';
    h += '<button class="btn" style="background:#6366f1;color:#fff" onclick="syncPayments()">\u{1F504} \u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043F\u043B\u0430\u0442\u0435\u0436\u0438</button>';
  }
  h += '</div>';
  if (tochkaOk) {
    h += '<div style="margin-top:12px;padding:10px;background:var(--bg-3);border-radius:8px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">';
    h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">\u0421 \u0434\u0430\u0442\u044B</label><input class="form-input" type="date" id="syncDateFrom" value="2024-01-01" style="font-size:12px;padding:4px 8px"></div>';
    h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">\u041F\u043E \u0434\u0430\u0442\u0443</label><input class="form-input" type="date" id="syncDateTo" value="' + new Date().toISOString().slice(0, 10) + '" style="font-size:12px;padding:4px 8px"></div>';
    h += '<div id="syncStatus" style="font-size:12px;color:var(--text-3)"></div>';
    h += '</div>';
  }
  h += '</div>';
  container.innerHTML = h;
  // Load full config (with unmasked jwt) for editing
  api(API + '/api/admin/tochka/config')
    .then(function(cfg) {
      if (cfg.jwt) document.getElementById('bankJwt').value = cfg.jwt;
      if (cfg.clientId) document.getElementById('bankClientId').value = cfg.clientId;
      if (cfg.customerCode) document.getElementById('bankCustomerCode').value = cfg.customerCode;
      if (cfg.accountId) document.getElementById('bankAccountId').value = cfg.accountId;
      if (cfg.companyName) document.getElementById('bankCompanyName').value = cfg.companyName;
      if (cfg.companyInn) document.getElementById('bankCompanyInn').value = cfg.companyInn;
    }).catch(function() {});
}

function saveBankConfig() {
  var _jwt = (document.getElementById('bankJwt') || {}).value || '';
  var data = {
    clientId: document.getElementById('bankClientId').value,
    customerCode: document.getElementById('bankCustomerCode').value,
    accountId: document.getElementById('bankAccountId').value,
    companyName: document.getElementById('bankCompanyName').value,
    companyInn: document.getElementById('bankCompanyInn').value,
    companyKpp: document.getElementById('bankCompanyKpp').value,
    companyAddress: document.getElementById('bankCompanyAddress').value
    // bank details inputs removed from UI; omit them so the backend keeps stored values
  };
  // jwt шлём только если введён новый (не пустой и не маска «****…» из GET) — иначе бэкенд хранит старый
  if (_jwt && _jwt.indexOf('****') !== 0) data.jwt = _jwt;
  api(API + '/api/admin/tochka/config',{method:'POST',json:data})
    .then(function(d) {
      if (d.ok) { showToast('\u041A\u043E\u043D\u0444\u0438\u0433 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u0435\u0440\u0432\u0435\u0440 \u0434\u043B\u044F \u043F\u0440\u0438\u043C\u0435\u043D\u0435\u043D\u0438\u044F', 'success'); loadData(); }
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function autodetectBank() {
  showToast('\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0434\u0430\u043D\u043D\u044B\u0435 \u0438\u0437 \u0422\u043E\u0447\u043A\u0438...', 'info');
  api(API + '/api/admin/tochka/autodetect',{method:'POST'})
    .then(function(d) {
      if (d.ok && d.detected) {
        var det = d.detected;
        var msg = '\u041D\u0430\u0439\u0434\u0435\u043D\u043E:';
        if (det.customerCode) { document.getElementById('bankCustomerCode').value = det.customerCode; msg += ' CustomerCode=' + det.customerCode; }
        if (det.accountId) { document.getElementById('bankAccountId').value = det.accountId; msg += ' AccountID=' + det.accountId; }
        if (det.companyName) { document.getElementById('bankCompanyName').value = det.companyName; msg += ' ' + det.companyName; }
        if (det.companyInn) { document.getElementById('bankCompanyInn').value = det.companyInn; }
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { renderBankConfig(); }, 500);
      } else {
        showToast(d.error || '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C', 'error');
      }
    })
    .catch(function(e) { showToast(e.message, 'error'); });
}

function registerWebhook() {
  var url = window.location.origin + '/api/tochka/webhook';
  if (!confirm('\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C webhook?\n\nURL: ' + url)) return;
  api(API + '/api/admin/tochka/register_webhook',{method:'POST',json:{ webhookUrl: url }})
    .then(function(d) {
      if (d.ok) showToast('Webhook \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D!', 'success');
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function syncPayments() {
  var dateFrom = document.getElementById('syncDateFrom') ? document.getElementById('syncDateFrom').value : '2024-01-01';
  var dateTo = document.getElementById('syncDateTo') ? document.getElementById('syncDateTo').value : new Date().toISOString().slice(0, 10);
  var statusEl = document.getElementById('syncStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">\u23F3 \u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0432\u044B\u043F\u0438\u0441\u043A\u0443... (\u0434\u043E 30 \u0441\u0435\u043A)</span>';
  api(API + '/api/admin/tochka/sync',{method:'POST',json:{ dateFrom: dateFrom, dateTo: dateTo }})
    .then(function(d) {
      if (d.ok) {
        var msg = '\u2705 \u0413\u043E\u0442\u043E\u0432\u043E! \u0412\u0441\u0435\u0433\u043E: ' + d.total + ', \u0438\u043C\u043F\u043E\u0440\u0442: ' + d.imported + ', \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043E: ' + d.matched + ', \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E: ' + d.skipped;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
      } else {
        var errMsg = d.error || '\u041E\u0448\u0438\u0431\u043A\u0430';
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + errMsg + '</span>';
        showToast(errMsg, 'error');
      }
    })
    .catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

// ========== BANK DOCUMENTS (Closing Documents / Акты) ==========
function renderBankDocuments() {
  var container = document.getElementById('bankDocumentsSection');
  if (!container) return;
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">📃 Документооборот</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="document.getElementById(\'bulkActPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkActPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="generateBulkActs()" style="white-space:nowrap;padding:4px 12px">📃 Сгенерировать акты для всех клиентов</button>';
  h += '<div id="bulkActStatus" style="font-size:12px;color:var(--text-3)"></div>';
  h += '</div>';

  // Load and display all acts
  h += '<div id="allActsList"><div style="color:var(--text-3);font-size:12px;text-align:center;padding:10px">Загрузка...</div></div>';
  h += '</div>';
  container.innerHTML = h;
  loadAllActs();
}

function loadAllActs() {
  api(API + '/api/admin/tochka/all_acts')
    .then(function(data) {
      var docs = data.documents || [];
      var el = document.getElementById('allActsList');
      if (!el) return;
      if (!docs.length) {
        el.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:20px;text-align:center">Закрывающих документов пока нет. Выберите период и нажмите «Сгенерировать акты».</div>';
        return;
      }
      // Group by period
      var periods = {};
      docs.forEach(function(d) {
        var p = d.period || 'unknown';
        if (!periods[p]) periods[p] = [];
        periods[p].push(d);
      });
      var sortedPeriods = Object.keys(periods).sort(function(a, b) { return b.localeCompare(a); });
      var months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      var h = '';
      sortedPeriods.forEach(function(period, pi) {
        var pdocs = periods[period];
        var totalSum = pdocs.reduce(function(s, d) { return s + (d.totalAmount || 0); }, 0);
        var unsigned = pdocs.filter(function(d) { return d.status !== 'signed'; }).length;
        var signed = pdocs.length - unsigned;
        var parts = period.split('-');
        var monthLabel = months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
        var isOpen = pi === 0;
        h += '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">';
        h += '<div onclick="toggleActPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
        h += '<div style="display:flex;align-items:center;gap:10px">';
        h += '<span style="font-size:14px;transition:transform .2s;transform:rotate(' + (isOpen ? '90' : '0') + 'deg)">▶</span>';
        h += '<span style="font-weight:600;font-size:14px">' + esc(monthLabel) + '</span>';
        h += '<span style="font-size:11px;color:var(--text-3)">' + pdocs.length + ' акт' + (pdocs.length > 1 ? (pdocs.length < 5 ? 'а' : 'ов') : '') + '</span>';
        h += '</div>';
        h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
        h += '<span style="font-weight:600;font-size:13px">' + totalSum.toLocaleString('ru-RU') + ' ₽</span>';
        if (unsigned > 0) h += '<span style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + unsigned + ' не подписан</span>';
        if (signed > 0) h += '<span style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + signed + ' подписан</span>';
        h += '</div></div>';
        h += '<div style="display:' + (isOpen ? 'block' : 'none') + ';padding:0;overflow-x:auto;-webkit-overflow-scrolling:touch">';
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-2)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Клиент</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">ИНН</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
        pdocs.forEach(function(d) {
          var isSigned = d.status === 'signed';
          var statusHtml = isSigned
            ? '<span style="color:var(--success);font-weight:600">✅ Подписан</span>'
            : '<span style="color:var(--danger);font-weight:600">❌ Не подписан</span>';
          var toggleBtn = isSigned
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'unsigned\')">❌</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'signed\')">✅</button>';
          var pdfBtn = d.tochkaDocumentId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadActPdf(\'' + d.clientId + '\',\'' + d.id + '\')">📥</button>'
            : '';
          h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(d.clientName || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' ₽</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Перевыставить: удалить и создать заново" onclick="reissueAct(\'' + d.clientId + '\',\'' + d.id + '\',\'' + esc(d.period || '') + '\')">↻</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить акт" onclick="deleteActFromBank(\'' + d.clientId + '\',\'' + d.id + '\')">🗑</button></td>';
          h += '</tr>';
        });
        h += '</tbody></table></div></div>';
      });
      el.innerHTML = h;
    }).catch(function(e) {
      var el = document.getElementById('allActsList');
      if (el) el.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:10px">' + esc(e.message) + '</div>';
    });
}

function toggleActPeriod(header) {
  var content = header.nextElementSibling;
  var arrow = header.querySelector('span');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    content.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

function generateBulkActs() {
  var period = document.getElementById('bulkActPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var statusEl = document.getElementById('bulkActStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">⏳ Генерирую акты...</span>';
  api(API + '/api/admin/tochka/generate_acts',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = '✅ Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllActs(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">❌ ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

function deleteActFromBank(clientId, docId) {
  if (!confirm('Удалить закрывающий документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { loadAllActs(); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK BILLS (Счета на оплату) ==========
function renderBankBills() {
  var container = document.getElementById('bankBillsSection');
  if (!container) return;
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">💳 Счета на оплату</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="document.getElementById(\'bulkBillPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkBillPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="generateBulkBills()" style="white-space:nowrap;padding:4px 12px">💳 Выставить счета всем клиентам</button>';
  h += '<div id="bulkBillStatus" style="font-size:12px;color:var(--text-3)"></div>';
  h += '</div>';

  // Load and display all bills
  h += '<div id="allBillsList"><div style="color:var(--text-3);font-size:12px;text-align:center;padding:10px">Загрузка...</div></div>';
  h += '</div>';
  container.innerHTML = h;
  loadAllBills();
}

function loadAllBills() {
  api(API + '/api/admin/tochka/all_bills')
    .then(function(data) {
      var bills = data.bills || [];
      var el = document.getElementById('allBillsList');
      if (!el) return;
      if (!bills.length) {
        el.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:20px;text-align:center">Счетов пока нет. Выберите период и нажмите «Выставить счета всем клиентам».</div>';
        return;
      }
      // Group by period
      var periods = {};
      bills.forEach(function(b) {
        var p = b.period || 'unknown';
        if (!periods[p]) periods[p] = [];
        periods[p].push(b);
      });
      var sortedPeriods = Object.keys(periods).sort(function(a, b) { return b.localeCompare(a); });
      var months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      var h = '';
      sortedPeriods.forEach(function(period, pi) {
        var pbills = periods[period];
        var totalSum = pbills.reduce(function(s, b) { return s + (b.amount || 0); }, 0);
        var unpaid = pbills.filter(function(b) { return b.status !== 'paid'; }).length;
        var paid = pbills.length - unpaid;
        var parts = period.split('-');
        var monthLabel = months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
        var isOpen = pi === 0;
        h += '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">';
        h += '<div onclick="toggleBillPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
        h += '<div style="display:flex;align-items:center;gap:10px">';
        h += '<span style="font-size:14px;transition:transform .2s;transform:rotate(' + (isOpen ? '90' : '0') + 'deg)">▶</span>';
        h += '<span style="font-weight:600;font-size:14px">' + esc(monthLabel) + '</span>';
        h += '<span style="font-size:11px;color:var(--text-3)">' + pbills.length + ' счёт' + (pbills.length > 1 ? (pbills.length < 5 ? 'а' : 'ов') : '') + '</span>';
        h += '</div>';
        h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
        h += '<span style="font-weight:600;font-size:13px">' + totalSum.toLocaleString('ru-RU') + ' \u20BD</span>';
        if (unpaid > 0) h += '<span style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + unpaid + ' не оплачен</span>';
        if (paid > 0) h += '<span style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + paid + ' оплачен</span>';
        h += '</div></div>';
        h += '<div style="display:' + (isOpen ? 'block' : 'none') + ';padding:0;overflow-x:auto;-webkit-overflow-scrolling:touch">';
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-2)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Клиент</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">ИНН</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
        pbills.forEach(function(b) {
          var isPaid = b.status === 'paid';
          var statusHtml = isPaid
            ? '<span style="color:var(--success);font-weight:600">✅ Оплачен</span>'
            : '<span style="color:var(--danger);font-weight:600">⏳ Не оплачен</span>';
          var toggleBtn = isPaid
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'paid\')">✅</button>';
          var pdfBtn = b.tochkaBillId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadBillPdf(\'' + b.clientId + '\',\'' + b.id + '\')">📥</button>'
            : '';
          h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(b.clientName || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить счёт" onclick="deleteBillFromBank(\'' + b.clientId + '\',\'' + b.id + '\')">🗑</button></td>';
          h += '</tr>';
        });
        h += '</tbody></table></div></div>';
      });
      el.innerHTML = h;
    }).catch(function(e) {
      var el = document.getElementById('allBillsList');
      if (el) el.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:10px">' + esc(e.message) + '</div>';
    });
}

function toggleBillPeriod(header) {
  var content = header.nextElementSibling;
  var arrow = header.querySelector('span');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    content.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

function generateBulkBills() {
  var period = document.getElementById('bulkBillPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var statusEl = document.getElementById('bulkBillStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">⏳ Генерирую счета...</span>';
  api(API + '/api/admin/tochka/generate_bills',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = '✅ Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllBills(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">❌ ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

function deleteBillFromBank(clientId, billId) {
  if (!confirm('Удалить счёт?')) return;
  api(API + '/api/admin/clients/' + clientId + '/bill/' + billId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Счёт удалён', 'success'); loadData(); setTimeout(function() { loadAllBills(); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK PAYMENTS (Tochka) ==========
var _paymentsSearch='';
function filterPayments(){_paymentsSearch=(document.getElementById('paymentsSearchInput')||{}).value||'';renderBankPayments();}
function renderBankPayments() {
  var container = document.getElementById('bankPaymentsSection');
  if (!container) return;
  var bp = currentData.bankPayments || [];
  var tochkaOk = currentData.tochkaConfigured;
  var searchVal=_paymentsSearch.toLowerCase();
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">\u{1F3E6} Банк Точка</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API подключён</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API не настроен</span>';
  }
  h += '</div>';
  // Search toolbar
  h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:8px 10px;background:var(--bg-3);border-radius:8px">';
  h += '<input id="paymentsSearchInput" class="form-input" placeholder="Поиск по плательщику, ИНН, назначению..." oninput="filterPayments()" value="'+esc(searchVal)+'" style="flex:1;font-size:12px;padding:5px 10px">';
  var unmatchedCount=bp.filter(function(p){return!p.matched&&!p.dismissed&&p.webhookType==='incomingPayment'}).length;
  if(unmatchedCount>0)h+='<span style="font-size:11px;color:var(--danger);font-weight:600;white-space:nowrap">⚠ Неопознанных: '+unmatchedCount+'</span>';
  h += '</div>';
  var unmatched = bp.filter(function(p) { return !p.matched && !p.dismissed && p.webhookType === 'incomingPayment'; }).sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
  if(searchVal){unmatched=unmatched.filter(function(p){return(p.payerName||'').toLowerCase().indexOf(searchVal)!==-1||(p.payerInn||'').toLowerCase().indexOf(searchVal)!==-1||(p.purpose||'').toLowerCase().indexOf(searchVal)!==-1;})}
  if (unmatched.length > 0) {
    h += '<div style="background:rgba(220,38,38,0.1);border:1px solid var(--danger);border-radius:8px;padding:10px;margin-bottom:12px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    h += '<span style="font-weight:600;color:var(--danger)">\u26A0\uFE0F \u041D\u0435\u043E\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u044B\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438: ' + unmatched.length + '</span>';
    h += '<button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:var(--bg-3)" onclick="dismissAllUnmatched()">\u2716 \u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435</button>';
    h += '</div>';
    h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr><th style="padding:4px 6px;text-align:left">\u0414\u0430\u0442\u0430</th><th style="padding:4px 6px;text-align:left">\u041F\u043B\u0430\u0442\u0435\u043B\u044C\u0449\u0438\u043A</th><th style="padding:4px 6px;text-align:left">\u0418\u041D\u041D</th><th style="padding:4px 6px;text-align:center">\u0421\u0443\u043C\u043C\u0430</th><th style="padding:4px 6px;text-align:left">\u041D\u0430\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435</th><th style="padding:4px 6px">\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F</th></tr></thead><tbody>';
    unmatched.forEach(function(p) {
      h += '<tr>';
      h += '<td style="padding:4px 6px">' + fmtDateRu(p.date) + '</td>';
      h += '<td style="padding:4px 6px" title="' + esc(p.payerName || '') + '">' + esc(p.payerName || '') + '</td>';
      h += '<td style="padding:4px 6px">' + esc(p.payerInn) + '</td>';
      h += '<td style="padding:4px 6px;text-align:center;font-weight:600;white-space:nowrap">' + p.amount + ' \u20BD</td>';
      h += '<td style="padding:4px 6px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.purpose) + '">' + esc(p.purpose || '') + '</td>';
      h += '<td style="padding:4px 6px;white-space:nowrap"><select id="matchClient_' + p.id + '" style="font-size:10px;padding:2px;max-width:100px">';
      h += '<option value="">---</option>';
      (currentData.clients || []).forEach(function(c) { h += '<option value="' + c.id + '">' + esc(c.name) + '</option>'; });
      h += '</select> <button class="btn btn-sm btn-primary" style="font-size:9px;padding:1px 6px" onclick="matchPayment(\'' + p.id + '\')">OK</button>';
      h += ' <button class="btn btn-sm" style="font-size:9px;padding:1px 4px;background:var(--bg-3)" onclick="dismissPayment(\'' + p.id + '\')" title="\u0423\u0431\u0440\u0430\u0442\u044C">\u2716</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }
  var matched = bp.filter(function(p) { return p.matched && p.webhookType === 'incomingPayment'; }).sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
  if(searchVal){matched=matched.filter(function(p){return(p.payerName||'').toLowerCase().indexOf(searchVal)!==-1||(p.payerInn||'').toLowerCase().indexOf(searchVal)!==-1||(p.purpose||'').toLowerCase().indexOf(searchVal)!==-1||(p.matchedClientName||'').toLowerCase().indexOf(searchVal)!==-1;});}
  matched=matched.slice(0,50);
  if (matched.length > 0) {
    h += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:var(--bg-3)"><th style="padding:4px 6px;text-align:left">\u0414\u0430\u0442\u0430</th><th style="padding:4px 6px;text-align:left">\u041F\u043B\u0430\u0442\u0435\u043B\u044C\u0449\u0438\u043A</th><th style="padding:4px 6px;text-align:center">\u0421\u0443\u043C\u043C\u0430</th><th style="padding:4px 6px;text-align:left">\u041A\u043B\u0438\u0435\u043D\u0442</th></tr></thead><tbody>';
    matched.forEach(function(p) {
      var isUnmatched=!p.client_id&&!p.matchedClientName;
      h += '<tr style="'+(isUnmatched?'background:rgba(220,38,38,0.06)':'')+'">';
      h += '<td style="padding:4px 6px">' + fmtDateRu(p.date) + '</td>';
      h += '<td style="padding:4px 6px" title="' + esc(p.payerName || '') + '">' + esc(p.payerName || '') + '</td>';
      h += '<td style="padding:4px 6px;text-align:center;font-weight:500'+(isUnmatched?';color:var(--danger)':'')+'">' + p.amount + ' \u20BD</td>';
      h += '<td style="padding:4px 6px;color:var(--success);font-weight:500">'+(isUnmatched?'<span style="color:var(--danger)">⚠ Не привязан</span>':'\u2705 ' + esc(p.matchedClientName || ''))+'</td>';
      h += '</tr>';
    });
    h += '</tbody></table>' + '</div>';
  } else if (tochkaOk) {
    h += '<div style="color:var(--text-3);font-size:12px;padding:20px;text-align:center">\u041F\u043B\u0430\u0442\u0435\u0436\u0435\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</div>';
  }
  h += '</div>';
  container.innerHTML = h;
}

function matchPayment(paymentId) {
  var sel = document.getElementById('matchClient_' + paymentId);
  if (!sel || !sel.value) return showToast('Выберите клиента', 'error');
  api(API + '/api/admin/tochka/match_payment',{method:'POST',json:{ paymentId: paymentId, clientId: sel.value }})
    .then(function(d) {
      if (d.ok) { showToast('Платёж привязан', 'success'); loadData(); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function dismissPayment(paymentId) {
  api(API + '/api/admin/tochka/dismiss_payment',{method:'POST',json:{ paymentId: paymentId }})
    .then(function(d) { if (d.ok) { loadData(); } }).catch(function(){});
}

function dismissAllUnmatched() {
  if (!confirm('\u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435 \u043D\u0435\u043E\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u044B\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438?')) return;
  api(API + '/api/admin/tochka/dismiss_unmatched',{method:'POST'})
    .then(function(d) { if (d.ok) { showToast('\u0423\u0431\u0440\u0430\u043D\u043E: ' + d.dismissed, 'success'); loadData(); } }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== EDIT PORT CREDENTIALS ==========
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
function _ncPulseCard(label, value, sub, accent){
  var cls = (accent && accent !== 'var(--text-0)') ? ' '+accent : '';
  return '<div class="pulse-card'+cls+'">' +
    '<div class="pulse-label">'+esc(label)+'</div>' +
    '<div class="pulse-value">'+value+'</div>' +
    (sub?'<div class="pulse-sub">'+sub+'</div>':'') +
    '</div>';
}
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
      _ncPulseCard('Выручка (MRR)', _fmtRub(s.mrr), growthSub, 'accent') +
      _ncPulseCard('На балансах', _fmtRub(cashFloat), '<span style="color:var(--text-3)">предоплата клиентов</span>', 'success');
  }
  // Финсводка-виджет (верхний ряд, бывший слот «Ресурсы») — MRR / NRR / прирост M/M / на балансах
  var fsEl=document.getElementById('newFinSummaryBody');
  if(fsEl){
    function _fsRow(l,v,c,last){return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px'+(last?'':';border-bottom:1px solid var(--border)')+'"><span style="color:var(--text-2)">'+l+'</span><span style="font-weight:600'+(c?';color:'+c:'')+'">'+v+'</span></div>';}
    fsEl.innerHTML =
      _fsRow('MRR', _fmtRub(s.mrr), 'var(--text-0)') +
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
function _ncListRow(name, val, valColor){
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">' +
    '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">'+name+'</span>' +
    '<span style="font-family:var(--font-mono);font-size:11px;color:'+valColor+';font-weight:600;white-space:nowrap">'+val+'</span></div>';
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
function renderMrrChart(d){
  d = d || window._newFinData; if(!d) return;
  var lg = document.getElementById('mrrLegend');
  if(lg) lg.innerHTML = [['За ГБ','#2f6fe0'],['За модем','#10b981']].map(function(x){
    return '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[1]+'"></span>'+x[0]+'</span>';
  }).join('');
  var cv = document.getElementById('newFinTrendCanvas');
  if(!cv || !window.Chart) return;
  if(window._newFinTrendChart){ try{window._newFinTrendChart.destroy();}catch(_){} window._newFinTrendChart=null; }
  var cc = getChartColorsLight();
  // Тонкие столбцы под узкую карточку ряда «Требует внимания» (маленький maxBarThickness),
  // остальная геометрия — из общего CHART_BAR_STACK. Скругление: плоский низ, круглый верх.
  var barOpts = Object.assign({stack:'a', borderRadius:chartStackRadius()}, CHART_BAR_STACK, {maxBarThickness:22});
  window._newFinTrendChart = newChartSafe(cv, {
    type:'bar',
    data:{ labels:(d.trend||[]).map(function(t){return _ymRu(t.month,true);}),
      datasets:[
        Object.assign({label:'За ГБ', data:(d.trend||[]).map(function(t){return t.per_gb||0;}), backgroundColor:'#2f6fe0'}, barOpts),
        Object.assign({label:'За модем', data:(d.trend||[]).map(function(t){return t.per_modem||0;}), backgroundColor:'#10b981'}, barOpts)
      ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{mode:'index',intersect:false,
          callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
            footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
      scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,minRotation:0,autoSkip:false},grid:{display:false},border:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
  });
}
// «Выручка по дням» + «Последние платежи» — в блоке Финансов на месте бывшего MRR.
function renderFinRevenue(d){
  var el = document.getElementById('newFinRevenue'); if(!el) return;
  var h = '<h3 style="margin:0 0 8px;font-size:14px;font-weight:700;color:var(--text-0)">Выручка по дням <span style="font-size:10px;font-weight:400;color:var(--text-3)">30 дней · по клиентам · ₽</span></h3>';
  h += '<div style="height:118px;position:relative"><canvas id="newFinRevCanvas"></canvas></div>';
  h += '<div style="height:0.5px;background:var(--border);margin:11px 0 9px"></div>';
  h += '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px"><span style="font-size:13px;font-weight:700;color:var(--text-0)">Последние пополнения</span><span style="font-size:11px;color:var(--accent);cursor:pointer" onclick="var b=document.querySelector(&quot;.nav-tab[onclick*=bank]&quot;);if(b)b.click()">все →</span></div>';
  // Только ПОПОЛНЕНИЯ (положительные), последние 3.
  var rp = (d.recent_payments || []).filter(function(p){return p.amount >= 0;}).slice(0, 3);
  if(!rp.length) h += '<div style="color:var(--text-3);font-size:12px">Пополнений пока нет.</div>';
  else rp.forEach(function(p){
    var sub = esc((p.date||'').slice(5)) + ' · ' + esc(p.source||'');
    h += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0"><div style="min-width:0"><div style="font-size:12px;color:var(--text-1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.client)+'</div><div style="font-size:10px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+sub+'</div></div>'
      + '<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;white-space:nowrap;color:var(--success)">+'+Math.abs(Math.round(p.amount)).toLocaleString('ru-RU')+'</span></div>';
  });
  el.innerHTML = h;
  setTimeout(function(){
    var cv = document.getElementById('newFinRevCanvas'); if(!cv || !window.Chart) return;
    if(window._newFinRevChart){ try{window._newFinRevChart.destroy();}catch(_){} }
    var cc = getChartColorsLight();
    var dr = d.daily_revenue || []; var dates = dr.map(function(r){return r.date;});
    var byClient = d.daily_revenue_by_client || {};
    // топ-клиенты по суммарной выручке за окно, остальные — «Прочие»
    var names = Object.keys(byClient).sort(function(a,b){
      var sa=dates.reduce(function(s,dt){return s+(byClient[a][dt]||0);},0), sb=dates.reduce(function(s,dt){return s+(byClient[b][dt]||0);},0);
      return sb-sa;
    });
    var MAXG=6, top=names.slice(0,MAXG), rest=names.slice(MAXG);
    var palette=getChartPaletteLight();
    var datasets=top.map(function(nm,i){ return Object.assign({label:nm, data:dates.map(function(dt){return (byClient[nm][dt]||0);}), backgroundColor:palette[i%palette.length], stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK); });
    if(rest.length) datasets.push(Object.assign({label:'Прочие', data:dates.map(function(dt){return rest.reduce(function(s,nm){return s+(byClient[nm][dt]||0);},0);}), backgroundColor:'#cbd5e1', stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK));
    // fallback: если разбивки нет — единый ряд из daily_revenue
    if(!datasets.length) datasets=[Object.assign({label:'Выручка', data:dr.map(function(r){return r.revenue;}), backgroundColor:'#2f6fe0', stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK)];
    window._newFinRevChart = newChartSafe(cv, {
      type:'bar',
      data:{ labels:dates.map(function(dt){return (dt||'').slice(5);}), datasets:datasets },
      options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},
          tooltip:{mode:'index',intersect:false,itemSort:function(a,b){return b.parsed.y-a.parsed.y;},
            callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
              footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
        scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:10},grid:{display:false},border:{display:false}},
          y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
    });
  }, 30);
}
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
