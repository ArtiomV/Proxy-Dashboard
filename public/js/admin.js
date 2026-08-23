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
var autoRefreshTimer=null,charts={},REFRESH_MS=60000;   // 20.08: 10с → 60с (данные всё равно кэшированные, флапало при ререндере)

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

var COLUMNS=[{id:'rail',label:'',visible:true,sortable:false,width:'6px'},
  {id:'bulk',label:'<input type="checkbox" id="bulkSelectAll" data-on-click="bulkToggleAll(this)" style="cursor:pointer;margin:0">',visible:true,sortable:false,width:'28px'},
  {id:'status',label:'',visible:true,sortable:false,width:'24px'},
  {id:'nick',label:'Модем',visible:true,sortable:true},
  {id:'server',label:'Сервер',visible:false,sortable:true},
  {id:'portName',label:'Клиент',visible:true,sortable:true},
  {id:'creds',label:'Доступ',visible:true,sortable:false},
  {id:'extIp',label:'Внеш.IP',visible:false,sortable:false},
  {id:'netType',label:'Сеть',visible:true,sortable:true},
  {id:'phone',label:'Телефон',visible:false,sortable:false},
  {id:'ping',label:'Пинг <span class="th-hint" title="Замер ProxySmart через модем (~1/мин): задержка и потери&#10;Зелёный: норма&#10;Оранжевый: >800 мс или потери ≥30%&#10;Красный: интернета нет (loss 100%)&#10;Серый: данные протухли">'+icon('info',11)+'</span>',visible:true,sortable:true},
  {id:'http',label:'HTTP <span class="th-hint" title="HTTP-проверка через действующие реквизиты клиента&#10;Зелёный: ответ 2xx/3xx и контент прошёл проверку&#10;Красный: ошибка соединения, статуса или контента">'+icon('info',11)+'</span>',visible:true,sortable:false},
  {id:'trafficDay',label:'Трафик сегодня',visible:true,sortable:true},
  {id:'trafficMon',label:'Трафик месяц',visible:false,sortable:true},
  {id:'rateNow',label:'Трафик сейчас <span class="th-hint" title="Текущая скорость модема (Мбит/с) — дельта суточных счётчиков бокса за скользящее окно 10 мин.&#10;↑ исходящий / ↓ входящий">'+icon('info',11)+'</span>',visible:true,sortable:true},
  {id:'speed',label:'Скорость <span class="th-hint" title="Download ↓ / Upload ↑ в Mbps&#10;Зелёный: > 30 Mbps&#10;Синий: 10–30 Mbps&#10;Оранжевый: < 10 Mbps&#10;Внимание: значение аномально низкое">'+icon('info',11)+'</span>',visible:false,sortable:true},
  {id:'uptime',label:'Аптайм 30д',visible:false,sortable:true},
  {id:'conns',label:'TCP-подключения <span class="th-hint" title="Живые TCP-подключения через прокси (HTTP + SOCKS5), суммарно по портам модема&#10;Клик — настройки порта: лимиты Max Conn / Conn Limit">'+icon('info',11)+'</span>',visible:true,sortable:true,width:'152px'},
  {id:'rotation',label:'Ротация',visible:false,sortable:true},
  {id:'band',label:'Band',visible:false,sortable:true},
  {id:'actions',label:'',visible:true,sortable:false,width:'118px'}
];
var _countryFlags={'MD':flagIcon('MD'),'RO':flagIcon('RO'),'US':flagIcon('US'),'DE':flagIcon('DE')};
var _countryNamesRu={'Moldova':'\u041c\u043e\u043b\u0434\u043e\u0432\u0430','Romania':'\u0420\u0443\u043c\u044b\u043d\u0438\u044f'};
var COUNTRIES={};
var COUNTRY_ORDER=[];
function _initServers(servers){if(!servers||!servers.length)return;COUNTRIES={};COUNTRY_ORDER=[];servers.slice().sort(function(a,b){return a.name.localeCompare(b.name)}).forEach(function(s){COUNTRIES[s.name]={flag:_countryFlags[s.country]||'',name:_countryNamesRu[s.countryName]||s.countryName||s.name,displayName:s.displayName||s.name,serverIp:s.publicIp||'',country:s.country||'',address:s.address||''};COUNTRY_ORDER.push(s.name);});}
function _serverDisplayName(name){var c=COUNTRIES[name]||{};return c.displayName||name;}
// Старые S-коды из интерфейса убраны (23.08): сервера показываем только под
// названиями, заданными владельцем. Технический ключ остаётся лишь в БД.
function _serverDisplayLabel(name){return _serverDisplayName(name);}

// ========== THEME ==========
// Весь кабинет — СВЕТЛАЯ тема по умолчанию (Дашборд/Финансы и так scoped-light в
// finance.css; тёмная тема для их контента не реализована, поэтому базовый вид —
// единый светлый). Тумблер оставлен рабочим и сохраняет выбор, дефолт = light.
function toggleTheme(){var t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=t;try{localStorage.setItem('pr_admin_theme',t)}catch(e){}}
(function(){var t='light';try{t=localStorage.getItem('pr_admin_theme')||'light';}catch(e){}document.documentElement.dataset.theme=t;})();

// getChartColors moved to /js/utils.js

// ========== AUTH ==========
function doLogin(){window.location.href='/'}
function doLogout(){api(API+'/api/logout',{method:'POST'});authToken='';localStorage.removeItem('pr_admin_token');localStorage.removeItem('pr_token');localStorage.removeItem('pr_login');window.location.href='/'}

// ========== NAV ==========
var _activeBankTab='acts';
var _bankEverRendered=false;
function switchBankNav(name){
  // Вкладка «Обзор» со страницы финансов убрана (2026-08-04): сводка живёт на
  // дашборде (ряд «Требует внимания» + финсводка), здесь только документы/деньги.
  ['acts','bills','payments'].forEach(function(t){
    var nav=document.getElementById('bnav_'+t);
    var secMap={acts:'bankDocumentsSection',bills:'bankBillsSection',payments:'bankPaymentsSection'};
    var sec=document.getElementById(secMap[t]);
    if(nav)nav.classList.toggle('active',t===name);
    if(sec)sec.style.display=t===name?'':'none';
  });
  _activeBankTab=name;
  if(name==='acts'&&currentData)renderBankDocuments();
  else if(name==='bills'&&currentData)renderBankBills();
  else if(name==='payments'&&currentData)renderBankPayments();
}
var _activeSettingsSection='audit';
function switchSettingsSection(name){
  if(name==='packages')name='operators'; // legacy bookmark after section merge
  try{if(window.matchMedia('(max-width:480px)').matches){var _c=document.querySelector('.tab-sidebar-layout>div:last-child');if(_c)setTimeout(function(){_c.scrollIntoView({behavior:'smooth',block:'start'});},60);}}catch(_){}
  // recovery / proxycheck / speedtest / data are VIEWS of the shared
  // settingsSection_data: show that section and filter its cards by
  // [data-subsec]. Cards without a data-subsec belong to the «Система» (data)
  // view. «alerts» — тоже смешанный вид: settingsSection_alerts (правила
  // уведомлений) + data-карточки с subsec=alerts (Telegram, пороги доступности).
  var DATA_VIEWS={recovery:1,proxycheck:1,speedtest:1,alerts:1,data:1};
  ['bank','audit','dguard','servers','syslog','serverHealth','simulator','operators','maintenance','sla','alerts','failover','tariffs'].forEach(function(s){
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
  ['bank','data','audit','dguard','servers','syslog','serverHealth','simulator','operators','maintenance','sla','alerts','failover','recovery','proxycheck','speedtest','tariffs'].forEach(function(s){
    var nav=document.getElementById('snav_'+s);
    if(nav){nav.classList.toggle('active',s===name);}
  });
  _activeSettingsSection=name;
  localStorage.setItem('admin_settings_section',name);
  if(name==='audit')loadAuditLog();
  if(name==='dguard')loadDomainGuard();
  if(name==='servers')loadServersList();
  if(name==='syslog')loadSystemLog();
  if(name==='serverHealth')renderSysDashboard('serverHealthContent');
  if(name==='simulator')initSimulator();
  if(name==='operators')loadOperatorsMapping();
  if(name==='alerts')loadAlertRules();
  if(name==='maintenance')loadMaintenanceWindows();
  if(name==='sla')initSlaReport();
  if(name==='failover'){loadFailoverSettings();loadFailoverCandidates();loadFailoverLog();}
  if(name==='tariffs')loadTariffsAdmin();
}
// «Грязные» поля настроек: пока админ редактирует форму (или держит фокус в
// поле), авторефреш каждые REFRESH_MS не должен перезаписывать значения —
// switchMainTab('analytics',…,auto=true) пропускает перезагрузку секции.
// Флаги снимаются после любого успешного сохранения (см. hook в api(), utils.js).
document.addEventListener('input',function(e){var t=e.target;if(t&&t.dataset&&t.closest&&t.closest('#tab-analytics')&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'))t.dataset.dirty='1'});
document.addEventListener('change',function(e){var t=e.target;if(t&&t.dataset&&t.closest&&t.closest('#tab-analytics')&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'))t.dataset.dirty='1'});
function _analyticsDirty(){var t=document.getElementById('tab-analytics');if(!t)return false;var ae=document.activeElement;if(ae&&t.contains(ae)&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.tagName==='SELECT'))return true;return !!t.querySelector('[data-dirty="1"]')}
function _clearSettingsDirty(){var t=document.getElementById('tab-analytics');if(!t)return;t.querySelectorAll('[data-dirty="1"]').forEach(function(el){el.dataset.dirty=''})}
function switchMainTab(name,el,auto){var nt=document.querySelector('.nav-tabs');if(nt)nt.classList.remove('burger-open');localStorage.setItem('admin_active_tab',name);document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active')});if(el)el.classList.add('active');var tc=document.getElementById('tab-'+name);if(tc)tc.classList.add('active');var sa=document.getElementById('modemSearchArea');if(sa)sa.style.display=name==='modems'?'flex':'none';if(name==='dashboard'&&!auto){try{renderAccNew();}catch(e){console.error(e);}}if(name==='clients'&&!auto)renderClients();if(name==='analytics'&&!auto){initAnalyticsSelectors();loadSettings();renderBankConfig();var ss=localStorage.getItem('admin_settings_section')||'serverHealth';switchSettingsSection(ss);if(typeof restoreRestartBanner==='function')restoreRestartBanner();}if(name==='bank'){if(!auto||!_bankEverRendered){_bankEverRendered=true;switchBankNav(_activeBankTab||'acts');}}}

// Polling/SSE refreshes already rendered blocks in place. Re-entering the tab
// used to reset asynchronous screens to their «Загрузка» skeleton every minute.
function refreshActiveTabInPlace(name){
  if(name==='dashboard'){
    try{renderNewExtWidgets();}catch(e){}
    try{renderNewFleetServers();}catch(e){}
    try{var d=collectTrafficData();if(d)renderNewClientTable(d);}catch(e){}
  }else if(name==='clients'){
    try{renderClients();}catch(e){}
  }
}

// ── Тарифы розницы (B2C, WP3) — минимальный CRUD поверх /api/admin/tariffs ──
var _tariffsCache=[];
var _adminServersCache=null;   // кэш GET /api/admin/servers для селектов
function _loadAdminServers(cb){
  if(_adminServersCache){cb(_adminServersCache);return}
  api(API+'/api/admin/servers').then(function(d){
    _adminServersCache=(d&&d.servers)||[];
    cb(_adminServersCache);
  }).catch(function(){cb([])});
}
// Поле «Сервер» тарифа — select из реальных боксов + «по умолчанию» (пусто).
// Значение вне списка (legacy) добавляем опцией, чтобы не потерять.
function _fillTariffServerSelect(selected){
  var sel=document.getElementById('tfServer');
  if(!sel)return;
  _loadAdminServers(function(servers){
    var h='<option value="">— по умолчанию (из retail_pool_servers)</option>';
    var found=!selected;
    servers.forEach(function(s){
      if(s.name===selected)found=true;
      h+='<option value="'+esc(s.name)+'">'+esc(s.displayName||s.name)+'</option>';
    });
    if(!found)h+='<option value="'+esc(selected)+'">'+esc(selected)+' (нет в списке)</option>';
    sel.innerHTML=h;
    sel.value=selected||'';
  });
}
async function loadTariffsAdmin(){
  var box=document.getElementById('tariffsTable');
  if(!box)return;
  _fillTariffServerSelect(document.getElementById('tfServer').value||'');
  loadRetailPoolAdmin();
  loadRetailPoolPorts();
  // WP3 (B2C Э4): эквайринг — настройки провайдера + журнал карточных платежей
  loadAcquiringSettings();
  loadCardPaymentsAdmin();
  loadPromoCodesAdmin();
  try{
    var data=await api(API+'/api/admin/tariffs');
    if(!data||data.error){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">'+esc((data&&data.error)||'Ошибка загрузки')+'</div>';return}
    _tariffsCache=data.tariffs||[];
    renderTariffsAdmin();
  }catch(e){
    box.innerHTML='<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">Ошибка соединения</div>';
  }
}

// ── Пул розницы (retail_pool_servers) — чекбоксы боксов, хранение CSV-строкой ──
function loadRetailPoolAdmin(){
  var box=document.getElementById('retailPoolServersBox');
  if(!box)return;
  Promise.all([api(API+'/api/admin/servers'),api(API+'/api/admin/settings')]).then(function(rs){
    var servers=(rs[0]&&rs[0].servers)||[];
    _adminServersCache=servers;
    var selected={};
    String((rs[1]&&rs[1].retail_pool_servers)||'').split(',').map(function(t){return t.trim()}).filter(Boolean).forEach(function(n){selected[n]=true});
    var h='';
    servers.forEach(function(s){
      var on=!!selected[s.name];
      if(on)delete selected[s.name];
      h+='<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12px;cursor:pointer"><input type="checkbox" class="retail-pool-chk" value="'+esc(s.name)+'"'+(on?' checked':'')+'> '+esc(s.displayName||s.name)+'</label>';
    });
    // Имена из CSV, которых нет среди серверов, — отдельно, чтобы не потерять.
    Object.keys(selected).forEach(function(n){
      h+='<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12px;cursor:pointer;color:var(--warning)"><input type="checkbox" class="retail-pool-chk" value="'+esc(n)+'" checked> '+esc(n)+' (нет в списке серверов)</label>';
    });
    box.innerHTML=h||'<div style="font-size:11px;color:var(--text-3)">Серверов нет — добавьте в «Инфраструктуре»</div>';
  }).catch(function(){
    box.innerHTML='<div style="font-size:11px;color:var(--danger)">Ошибка загрузки</div>';
  });
}
function saveRetailPoolAdmin(){
  var st=document.getElementById('retailPoolStatus');
  var names=[].slice.call(document.querySelectorAll('.retail-pool-chk:checked')).map(function(c){return c.value});
  api(API+'/api/admin/settings',{method:'PUT',json:{retail_pool_servers:names.join(',')}}).then(function(d){
    if(d.ok){st.style.color='var(--success)';st.textContent='Сохранено: '+(names.map(_serverDisplayLabel).join(', ')||'пусто');showToast('Пул розницы сохранён','success')}
    else{st.style.color='var(--danger)';st.textContent=d.error||'Ошибка'}
  }).catch(function(e){st.style.color='var(--danger)';st.textContent='Ошибка соединения'});
}

// ── Пул портов розницы (B2C Этап 2): таблица retail_pool + пополнение +
// legacy-импорт. Секция целиком видна только при retail_enabled — карточку
// прячем по /api/admin/settings (эндпоинты пула всё равно отдают 404 без флага).
var _retailPoolRows=null;
function _fmtIsoDt(iso){
  if(!iso)return '—';
  var t=Date.parse(iso);
  if(isNaN(t))return esc(iso);
  return new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
async function loadRetailPoolPorts(){
  var card=document.getElementById('retailPoolPortsCard');
  if(!card)return;
  // Админская карточка: видна всегда — розница может быть ещё выключена,
  // а пул уже надо наполнить. retail_enabled гейтит витрину, не конфиг.
  card.style.display='';
  var box=document.getElementById('retailPoolTable');
  if(!_retailPoolRows)box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Загрузка...</div>';
  try{
    var data=await api(API+'/api/admin/retail/pool');
    if(!data||data.error){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">'+esc((data&&data.error)||'Ошибка загрузки')+'</div>';return}
    _retailPoolRows=data.rows||[];
    renderRetailPoolPorts(data.counts||{});
  }catch(e){
    box.innerHTML='<div style="text-align:center;padding:24px;color:var(--danger);font-size:12px">Ошибка соединения</div>';
  }
}
function renderRetailPoolPorts(counts){
  var box=document.getElementById('retailPoolTable');
  var cEl=document.getElementById('retailPoolCounts');
  if(cEl){
    var parts=[];
    [['free','свободно'],['reserved','резерв'],['leased','арендовано'],['blocked','заблокировано']].forEach(function(p){
      if(counts[p[0]])parts.push(p[1]+': '+counts[p[0]]);
    });
    cEl.textContent=parts.length?' — '+parts.join(', '):'';
  }
  var rows=_retailPoolRows||[];
  if(!rows.length){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Пул пуст — добавьте порты или импортируйте существующие</div>';return}
  var badges={
    free:['Свободен','rgba(16,185,129,.15)','#10B981'],
    reserved:['Резерв','rgba(150,90,200,.15)','#965AC8'],
    leased:['Арендован','rgba(59,157,216,.15)','#3B9DD8'],
    blocked:['Заблокирован','rgba(239,68,68,.15)','#EF4444']
  };
  var h='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Сервер</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Порт</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Статус</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Клиент</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Hold до</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Тест до</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)"></th>'+
    '</tr></thead><tbody>';
  rows.forEach(function(r){
    var b=badges[r.status]||[r.status,'var(--bg-2)','var(--text-2)'];
    // WP7 (Э5): blocked-строка с клиентом — кандидат на реабилитацию (антифрод/
    // долг — эндпоинт сам решит по kv-маркеру abuse_hold).
    var act=(r.status==='blocked'&&r.client_id!=null)
      ?'<button class="btn btn-sm" style="font-size:11px;padding:3px 10px" data-on-click="rehabilitatePoolRow(\''+esc(r.client_id)+'\')">Реабилитировать</button>'
      :'';
    h+='<tr>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(_serverDisplayLabel(r.server))+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(r.port_id)+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)"><span style="background:'+b[1]+';color:'+b[2]+';padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600">'+b[0]+'</span></td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+(r.client_id!=null?esc(r.client_id):'<span style="color:var(--text-3)">—</span>')+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+_fmtIsoDt(r.hold_until)+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+_fmtIsoDt(r.test_expires_at)+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+act+'</td>'+
    '</tr>';
  });
  h+='</tbody></table>';
  box.innerHTML=h;
}
// Кнопка «Реабилитировать» в строке пула (WP7, Э5): тот же endpoint, после
// успеха — перезагрузка таблицы пула (строка уйдёт из blocked в leased).
function rehabilitatePoolRow(clientId){
  rehabilitateClientPorts(clientId,function(){_retailPoolRows=null;loadRetailPoolPorts();});
}
// «Добавить порты»: select бокса (кэш /api/admin/servers, как у тарифов) + N (1–50).
// POST долгий — кнопка дизейблится со спиннером до ответа.
function togglePoolAddForm(){
  var f=document.getElementById('poolAddForm');
  if(!f)return;
  f.style.display=f.style.display==='none'?'':'none';
  if(f.style.display!=='none')_fillPoolAddServerSelect();
}
function _fillPoolAddServerSelect(){
  var sel=document.getElementById('poolAddServer');
  if(!sel)return;
  _loadAdminServers(function(servers){
    sel.innerHTML=servers.map(function(s){return '<option value="'+esc(s.name)+'">'+esc(s.displayName||s.name)+'</option>'}).join('')||
      '<option value="">— нет серверов —</option>';
  });
}
async function submitPoolAdd(){
  var btn=document.getElementById('poolAddBtn');
  var st=document.getElementById('poolAddStatus');
  var server=document.getElementById('poolAddServer').value;
  var count=parseInt(document.getElementById('poolAddCount').value,10);
  if(!server){st.style.color='var(--danger)';st.textContent='Выберите сервер';return}
  if(!count||count<1||count>50){st.style.color='var(--danger)';st.textContent='Количество: целое 1–50';return}
  btn.disabled=true;
  st.style.color='var(--text-2)';st.textContent='Создание портов, это может занять несколько минут...';
  try{
    var data=await api(API+'/api/admin/retail/pool/add',{method:'POST',json:{server:server,count:count}});
    var created=(data&&data.created)||[];
    var errors=(data&&data.errors)||[];
    if(data&&data.ok){
      st.style.color='var(--success)';st.textContent='Создано: '+created.length+(errors.length?', ошибок: '+errors.length:'');
      showToast('Создано портов: '+created.length+(errors.length?' · ошибок: '+errors.length:''),errors.length?'error':'success');
    }else{
      st.style.color='var(--danger)';st.textContent=(data&&data.error)||'Ошибка создания';
      showToast((data&&data.error)||'Ошибка создания портов','error');
    }
    if(errors.length)console.warn('[RetailPool] add errors:',errors);
    _retailPoolRows=null;
    loadRetailPoolPorts();
  }catch(e){
    st.style.color='var(--danger)';st.textContent='Ошибка соединения';
    showToast('Ошибка соединения','error');
  }finally{
    btn.disabled=false;
  }
}
// Legacy-импорт: preview портов, выданных физикам вне пула → выбор чекбоксами
// (все отмечены) → import выбранных → обновление таблицы пула.
async function loadLegacyPreview(btn){
  var box=document.getElementById('retailLegacyBox');
  if(!box)return;
  if(btn)btn.disabled=true;
  box.style.display='';
  box.innerHTML='<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px;border:1px solid var(--border);border-radius:10px">Сканируем порты всех серверов...</div>';
  try{
    var data=await api(API+'/api/admin/retail/pool/legacy_preview');
    if(!data||data.error){box.innerHTML='<div style="padding:12px;color:var(--danger);font-size:12px">'+esc((data&&data.error)||'Ошибка загрузки')+'</div>';return}
    var items=data.items||[];
    if(!items.length){
      box.innerHTML='<div style="padding:12px;color:var(--text-2);font-size:12px">Портов для импорта не найдено — все порты физиков уже в пуле.</div>';
      return;
    }
    var h='<div style="border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--bg-2)">'+
      '<div style="font-size:12px;font-weight:600;margin-bottom:6px">Импорт существующих портов ('+items.length+')</div>'+
      '<div style="font-size:11px;color:var(--text-3);margin-bottom:10px">Порты, уже выданные физикам вне пула. Отмеченные попадут в пул со статусом «Арендован» — дальше ими владеет конвейер автоблока.</div>'+
      '<div style="max-height:260px;overflow-y:auto;margin-bottom:10px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'+
      '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)"></th>'+
      '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Сервер</th>'+
      '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Порт</th>'+
      '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Логин</th>'+
      '</tr></thead><tbody>';
    items.forEach(function(it,i){
      h+='<tr>'+
        '<td style="padding:4px 8px;border-bottom:1px solid var(--border)"><input type="checkbox" class="legacy-import-chk" data-i="'+i+'" checked></td>'+
        '<td style="padding:4px 8px;border-bottom:1px solid var(--border)">'+esc(_serverDisplayLabel(it.server))+'</td>'+
        '<td style="padding:4px 8px;border-bottom:1px solid var(--border)">'+esc(it.port_id)+'</td>'+
        '<td style="padding:4px 8px;border-bottom:1px solid var(--border)">'+esc(it.login)+'</td>'+
      '</tr>';
    });
    h+='</tbody></table></div>'+
      '<button class="btn btn-primary btn-sm" id="legacyImportBtn" data-on-click="submitLegacyImport()">Импортировать выбранные</button> '+
      '<button class="btn btn-sm" data-on-click="cancelLegacyImport()">Отмена</button> '+
      '<span id="legacyImportStatus" style="font-size:11px"></span></div>';
    box.innerHTML=h;
    window._legacyPreviewItems=items;
  }catch(e){
    box.innerHTML='<div style="padding:12px;color:var(--danger);font-size:12px">Ошибка соединения</div>';
  }finally{
    if(btn)btn.disabled=false;
  }
}
function cancelLegacyImport(){
  var box=document.getElementById('retailLegacyBox');
  if(box){box.style.display='none';box.innerHTML=''}
  window._legacyPreviewItems=null;
}
async function submitLegacyImport(){
  var items=window._legacyPreviewItems||[];
  var selected=[].slice.call(document.querySelectorAll('.legacy-import-chk:checked')).map(function(c){return items[+c.getAttribute('data-i')]}).filter(Boolean)
    .map(function(it){return {server:it.server,port_id:it.port_id,client_id:it.client_id}});
  var st=document.getElementById('legacyImportStatus');
  var btn=document.getElementById('legacyImportBtn');
  if(!selected.length){st.style.color='var(--danger)';st.textContent='Ничего не выбрано';return}
  if(btn)btn.disabled=true;
  st.style.color='var(--text-2)';st.textContent='Импорт...';
  try{
    var data=await api(API+'/api/admin/retail/pool/legacy_import',{method:'POST',json:{items:selected}});
    if(data&&data.ok){
      var skipped=(data.skipped||[]).length;
      showToast('Импортировано: '+data.imported+(skipped?' · пропущено: '+skipped:''),'success');
      cancelLegacyImport();
      _retailPoolRows=null;
      loadRetailPoolPorts();
    }else{
      st.style.color='var(--danger)';st.textContent=(data&&data.error)||'Ошибка импорта';
    }
  }catch(e){
    st.style.color='var(--danger)';st.textContent='Ошибка соединения';
  }finally{
    if(btn)btn.disabled=false;
  }
}
// ===== WP3 (B2C Э4): эквайринг розницы — настройки провайдера + журнал платежей =====
var _CARD_PAYMENT_STATUS_RU={created:'Создан',paid:'Оплачен',credited:'Зачтён',failed:'Ошибка',refunded:'Возвращён'};
var _CARD_PAYMENT_STATUS_COLOR={created:'var(--text-3)',paid:'var(--warning)',credited:'var(--success)',failed:'var(--danger)',refunded:'var(--text-2)'};
async function loadCardPaymentsAdmin(){
  var card=document.getElementById('cardPaymentsCard');
  if(!card)return;
  try{
    // Журнал платежей показываем всегда (настройка — до включения розницы).
    card.style.display='';
    var box=document.getElementById('cardPaymentsTable');
    box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Загрузка...</div>';
    var data=await api(API+'/api/admin/card_payments?limit=100');
    var rows=(data&&data.payments)||[];
    if(!rows.length){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Платежей пока нет</div>';return}
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Заказ</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Клиент</th>'+
      '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)">Сумма</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Метод</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Статус</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Дата</th>'+
      '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)"></th>'+
      '</tr></thead><tbody>';
    rows.forEach(function(p){
      var st=_CARD_PAYMENT_STATUS_RU[p.status]||p.status;
      var clr=_CARD_PAYMENT_STATUS_COLOR[p.status]||'var(--text-2)';
      h+='<tr>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace;font-size:11px">'+esc(p.order_id)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(p.client_login||('#'+p.client_id))+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">'+esc(String(p.amount))+' ₽</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+(p.method==='sbp'?'СБП':'Карта')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);color:'+clr+'">'+esc(st)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+_fmtIsoDt(p.created_at)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">'+(p.status==='credited'?'<button class="btn btn-sm" data-on-click="refundCardPayment(\''+esc(p.order_id)+'\','+p.amount+')">Возврат</button>':'')+'</td>'+
      '</tr>';
    });
    h+='</tbody></table>';
    box.innerHTML=h;
  }catch(e){card.style.display='none';}
}
// ===== WP6 (B2C Э7): промокоды розницы — CRUD =====
var _PROMO_TYPE_RU={percent:'Процент',fixed:'Фикс. сумма'};
async function loadPromoCodesAdmin(){
  var card=document.getElementById('promoCodesCard');
  if(!card)return;
  try{
    // Промокоды настраиваются и до включения розницы — карточка видна всегда.
    card.style.display='';
    var box=document.getElementById('promoCodesTable');
    var data=await api(API+'/api/admin/promo-codes');
    var rows=(data&&data.promo_codes)||[];
    if(!rows.length){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Промокодов пока нет</div>';return}
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Код</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Тип</th>'+
      '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)">Значение</th>'+
      '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)">Использовано</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">До</th>'+
      '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Статус</th>'+
      '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)"></th>'+
      '</tr></thead><tbody>';
    rows.forEach(function(p){
      h+='<tr>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">'+esc(p.code)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(_PROMO_TYPE_RU[p.type]||p.type)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">'+esc(String(p.value))+(p.type==='percent'?'%':' ₽')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">'+p.used+(p.max_uses?' / '+p.max_uses:'')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+(p.expires_at?esc(String(p.expires_at).slice(0,10)):'—')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);color:'+(p.active?'var(--success)':'var(--text-3)')+'">'+(p.active?'Активен':'Выключен')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">'+
          '<button class="btn btn-sm" data-on-click="togglePromoCode('+p.id+')">'+(p.active?'Выключить':'Включить')+'</button> '+
          '<button class="btn btn-sm btn-danger" data-on-click="deletePromoCode('+p.id+',\''+esc(p.code)+'\')">Удалить</button></td>'+
      '</tr>';
    });
    h+='</tbody></table>';
    box.innerHTML=h;
  }catch(e){card.style.display='none';}
}
async function submitPromoCode(){
  var st=document.getElementById('promoFormStatus');
  var body={
    code:(document.getElementById('promoCode').value||'').trim(),
    type:document.getElementById('promoType').value,
    value:parseFloat(document.getElementById('promoValue').value),
    max_uses:parseInt(document.getElementById('promoMaxUses').value,10)||null,
    expires_at:document.getElementById('promoExpires').value||null
  };
  try{
    var data=await api(API+'/api/admin/promo-codes',{method:'POST',json:body});
    if(data&&data.ok){
      if(st){st.textContent='Создан';st.style.color='var(--success)'}
      showToast('Промокод создан','success');
      document.getElementById('promoCode').value='';
      document.getElementById('promoValue').value='';
      loadPromoCodesAdmin();
    }else{
      var msg=(data&&data.error)||'Ошибка';
      if(data&&data.details){var k=Object.keys(data.details)[0];if(k&&data.details[k][0])msg=k+': '+data.details[k][0];}
      if(st){st.textContent=msg;st.style.color='var(--danger)'}
    }
  }catch(e){if(st){st.textContent='Ошибка соединения';st.style.color='var(--danger)'}}
}
async function togglePromoCode(id){
  try{
    var data=await api(API+'/api/admin/promo-codes/'+id+'/toggle',{method:'POST'});
    if(data&&data.ok)showToast(data.active?'Промокод включён':'Промокод выключен','success');
    else showToast((data&&data.error)||'Ошибка','error');
  }catch(e){showToast('Ошибка соединения','error');}
  loadPromoCodesAdmin();
}
async function deletePromoCode(id,code){
  if(!confirm('Удалить промокод '+code+'?'))return;
  try{
    var data=await api(API+'/api/admin/promo-codes/'+id,{method:'DELETE'});
    if(data&&data.ok)showToast('Промокод удалён','success');
    else showToast((data&&data.error)||'Ошибка','error');
  }catch(e){showToast('Ошибка соединения','error');}
  loadPromoCodesAdmin();
}
async function refundCardPayment(orderId,amount){
  if(!confirm('Вернуть платёж '+orderId+' на '+amount+' ₽? Деньги уйдут клиенту на карту, баланс будет сторнирован.'))return;
  try{
    var data=await api(API+'/api/admin/card_payments/'+encodeURIComponent(orderId)+'/refund',{method:'POST'});
    if(data&&data.ok){showToast(data.already?'Платёж уже был возвращён':'Возврат выполнен','success');}
    else{showToast((data&&data.error)||'Ошибка возврата','error');}
  }catch(e){showToast('Ошибка соединения','error');}
  loadCardPaymentsAdmin();
}
async function loadAcquiringSettings(){
  var card=document.getElementById('acquiringCard');
  if(!card)return;
  try{
    var s=await api(API+'/api/admin/settings');
    // Настройки эквайринга доступны и при выключенной рознице — иначе
    // ключи невозможно ввести до запуска. Карточка видна всегда.
    card.style.display='';
    var pv=document.getElementById('acqProvider');
    pv.value=(s.retail_acquiring_provider==='tochka')?'tochka':'none';
    // JWT — секрет: GET отдаёт маску '••••••••'. Пустое поле при сохранении = «не менять».
    var jwt=document.getElementById('acqJwt');
    if(s.tochka_acq_jwt==='••••••••'){jwt.value='';jwt.placeholder='•••••••• (сохранён)';jwt.dataset.masked='1';}
    else{jwt.value=s.tochka_acq_jwt||'';jwt.dataset.masked='';}
    document.getElementById('acqCustomerCode').value=s.tochka_acq_customer_code||'';
    document.getElementById('acqMerchantId').value=s.tochka_acq_merchant_id||'';
    document.getElementById('acqTaxSystem').value=s.tochka_acq_tax_system||'';
    document.getElementById('acqMinTopup').value=s.retail_min_topup!=null?s.retail_min_topup:0;
    document.getElementById('acqMaxTopup').value=s.retail_max_topup!=null?s.retail_max_topup:100000;
  }catch(e){card.style.display='none';}
}
async function saveAcquiringSettings(){
  var st=document.getElementById('acqSaveStatus');
  var btn=document.getElementById('acqSaveBtn');
  var data={
    retail_acquiring_provider:document.getElementById('acqProvider').value,
    tochka_acq_customer_code:(document.getElementById('acqCustomerCode').value||'').trim(),
    tochka_acq_merchant_id:(document.getElementById('acqMerchantId').value||'').trim(),
    tochka_acq_tax_system:document.getElementById('acqTaxSystem').value
  };
  // JWT: при замаскированном значении пустое поле = «не менять».
  var jwt=document.getElementById('acqJwt');
  var tok=(jwt.value||'').trim();
  if(tok||!jwt.dataset.masked)data.tochka_acq_jwt=tok;
  var mn=parseInt(document.getElementById('acqMinTopup').value);
  data.retail_min_topup=isNaN(mn)?0:mn;
  var mx=parseInt(document.getElementById('acqMaxTopup').value);
  data.retail_max_topup=isNaN(mx)?100000:mx;
  if(btn)btn.disabled=true;
  st.style.color='var(--text-2)';st.textContent='Сохранение...';
  try{
    var d=await api(API+'/api/admin/settings',{method:'PUT',json:data});
    if(d&&d.error){st.style.color='var(--danger)';st.textContent=d.error;showToast(d.error,'error');}
    else{st.style.color='var(--success)';st.textContent='Сохранено';showToast('Настройки эквайринга сохранены','success');showCredVerdict(d);loadAcquiringSettings();}
  }catch(e){
    st.style.color='var(--danger)';st.textContent='Ошибка соединения';
  }finally{
    if(btn)btn.disabled=false;
  }
}
function renderTariffsAdmin(){
  var box=document.getElementById('tariffsTable');
  if(!_tariffsCache.length){box.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px">Тарифов пока нет — создайте первый ниже</div>';return}
  var h='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">ID</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Название</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Гео</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Сервер</th>'+
    '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)">₽/мес</th>'+
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)">Флаги</th>'+
    '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border)"></th>'+
    '</tr></thead><tbody>';
  _tariffsCache.forEach(function(t){
    var flags=[];
    if(t.public)flags.push('<span style="color:var(--accent)">public</span>');
    if(t.active)flags.push('<span style="color:var(--success)">active</span>');
    else flags.push('<span style="color:var(--text-3)">off</span>');
    if(t.duration_hours===24)flags.push('<span style="color:var(--warning)">тест-день</span>');
    h+='<tr>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+t.id+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(t.name)+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(t.geo||'')+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+esc(t.server||'—')+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">'+Math.round(t.price).toLocaleString('ru-RU')+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">'+flags.join(' · ')+'</td>'+
      '<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">'+
        '<button class="btn btn-sm" data-on-click="editTariffAdmin('+t.id+')">Изм.</button> '+
        '<button class="btn btn-sm btn-danger" data-on-click="deleteTariffAdmin('+t.id+')">Удалить</button>'+
      '</td>'+
    '</tr>';
  });
  h+='</tbody></table>';
  box.innerHTML=h;
}
function editTariffAdmin(id){
  var t=_tariffsCache.find(function(x){return x.id===id});
  if(!t)return;
  document.getElementById('tariffFormTitle').textContent='Тариф #'+t.id;
  document.getElementById('tfId').value=t.id;
  document.getElementById('tfName').value=t.name||'';
  document.getElementById('tfGeo').value=t.geo||'';
  _fillTariffServerSelect(t.server||'');
  document.getElementById('tfPrice').value=t.price;
  document.getElementById('tfDuration').value=t.duration_hours!=null?t.duration_hours:'';
  document.getElementById('tfMinTopup').value=t.min_topup_days||1;
  document.getElementById('tfPublic').checked=!!t.public;
  document.getElementById('tfActive').checked=!!t.active;
  document.getElementById('tariffFormStatus').textContent='';
}
function resetTariffForm(){
  document.getElementById('tariffFormTitle').textContent='Новый тариф';
  ['tfId','tfName','tfGeo','tfServer','tfPrice','tfDuration'].forEach(function(id){document.getElementById(id).value=''});
  _fillTariffServerSelect('');   // select: гарантируем опции + «по умолчанию»
  document.getElementById('tfMinTopup').value='1';
  document.getElementById('tfPublic').checked=false;
  document.getElementById('tfActive').checked=true;
  document.getElementById('tariffFormStatus').textContent='';
}
async function saveTariffAdmin(){
  var st=document.getElementById('tariffFormStatus');
  var id=document.getElementById('tfId').value;
  var body={
    name:document.getElementById('tfName').value.trim(),
    geo:document.getElementById('tfGeo').value.trim(),
    server:document.getElementById('tfServer').value.trim(),
    price:parseFloat(document.getElementById('tfPrice').value),
    min_topup_days:parseInt(document.getElementById('tfMinTopup').value)||1,
    public:document.getElementById('tfPublic').checked,
    active:document.getElementById('tfActive').checked
  };
  var dur=parseInt(document.getElementById('tfDuration').value);
  if(dur)body.duration_hours=dur; // пусто = обычный подписочный тариф
  if(!body.name||!body.geo||!(body.price>0)){st.style.color='var(--danger)';st.textContent='Заполните название, гео и цену';return}
  st.style.color='var(--text-2)';st.textContent='Сохранение...';
  try{
    var data=await api(API+'/api/admin/tariffs'+(id?'/'+id:''),{method:id?'PUT':'POST',json:body});
    if(data&&data.ok){
      st.style.color='var(--success)';st.textContent='Сохранено';
      resetTariffForm();
      loadTariffsAdmin();
    }else{
      st.style.color='var(--danger)';st.textContent=(data&&data.error)||'Ошибка сохранения';
    }
  }catch(e){
    st.style.color='var(--danger)';st.textContent='Ошибка соединения';
  }
}
async function deleteTariffAdmin(id){
  if(!confirm('Удалить тариф #'+id+'?'))return;
  try{
    var data=await api(API+'/api/admin/tariffs/'+id,{method:'DELETE'});
    if(data&&data.ok){showToast('Тариф удалён','success');loadTariffsAdmin();}
    else showToast((data&&data.error)||'Ошибка удаления','error');
  }catch(e){
    showToast('Ошибка соединения','error');
  }
}

// ========== PHASE 3: SYSTEM TAB ==========
var _sysCharts = {};
// switchSysTab/refreshSysTab removed — the Система tab no longer exists.
// Its analytical sub-tabs (rotations/IP/capacity) lived in the hidden
// ACC view and were removed together with #tab-traffic (C4); Системный лог
// lives in Настройки → Состояние сервера; Логи доменов was removed entirely.
// KPI card. `accent` (optional) drives the left border + soft tinted bg.
// Falls back to `color` if no explicit accent is given.
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
function _sysLoader(){return '<div style="color:var(--text-3);padding:40px;text-align:center">Загрузка...</div>'}
function _sysError(msg){return '<div style="color:var(--danger);padding:20px">'+esc(msg)+'</div>'}


// ----- 3.6 System dashboard -----
function _renderSysDashboardLegacy(targetId){
  var c = document.getElementById(targetId || 'sys-content');
  c.innerHTML = _sysLoader();
  api(API + '/api/admin/system_health')
    .then(function(d){
      if(d.error){c.innerHTML=_sysError(d.error);return}
      var h = '';
      h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      h += _sysKpi('Uptime', Math.floor((d.uptime_sec||0)/3600)+'ч '+Math.floor(((d.uptime_sec||0)%3600)/60)+'мин');
      h += _sysKpi('DB', (d.db&&d.db.size_mb||0)+' MB');
      if(d.disk)h += _sysKpi('Диск', d.disk.free_gb+' ГБ своб.', d.disk.used_pct+'% занято из '+d.disk.total_gb+' ГБ', d.disk.used_pct>=85?'var(--danger)':(d.disk.used_pct>=75?'var(--warning)':null));
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
      // Server downtime history (mig 035). Эпизоды одного сервера с паузой
      // <10 мин между ними сливаем в один — иначе флапящий бокс (упал-поднялся
      // каждые 2 мин) забивает таблицу десятками строк по 1–3 минуты (20.08).
      if (d.server_downtime && d.server_downtime.length) {
        var dtRows = d.server_downtime.slice().sort(function(a, b){
          if (a.server_name !== b.server_name) return a.server_name < b.server_name ? -1 : 1;
          return String(a.down_from) < String(b.down_from) ? -1 : 1;
        });
        var merged = [];
        dtRows.forEach(function(r){
          var fromMs = Date.parse(r.down_from);
          var last = merged[merged.length - 1];
          if (last && last.server_name === r.server_name && Number.isFinite(fromMs) && (fromMs - last._toMs) < 10 * 60e3) {
            var toMs2 = Date.parse(r.down_to || r.down_from);
            if (toMs2 > last._toMs) { last._toMs = toMs2; last.down_to = r.down_to || r.down_from; }
            last._flaps = (last._flaps || 1) + 1;
          } else {
            var toMs = Date.parse(r.down_to || r.down_from);
            merged.push({ server_name: r.server_name, down_from: r.down_from, down_to: r.down_to, _toMs: Number.isFinite(toMs) ? toMs : fromMs, _flaps: 1 });
          }
        });
        merged.sort(function(a, b){ return String(b.down_from) < String(a.down_from) ? -1 : 1; });   // свежие сверху
        h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:14px">';
        h += '<div style="font-size:11px;color:var(--text-2);text-transform:uppercase;margin-bottom:6px">'+icon('alert',11)+' Недоступность серверов (история) <span style="text-transform:none;font-weight:400">· эпизоды с паузой &lt;10 мин объединены · данные с момента включения учёта (20.08, 09:00 МСК)</span></div>';
        h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;min-width:520px;font-size:11px;border-collapse:collapse"><thead><tr style="color:var(--text-2)"><th style="padding:4px 8px;text-align:left">Сервер</th><th style="padding:4px 8px;text-align:left">С</th><th style="padding:4px 8px;text-align:left">По</th><th style="padding:4px 8px;text-align:right">Длительность</th><th style="padding:4px 8px;text-align:right">Эпизодов</th></tr></thead><tbody>';
        merged.slice(0, 30).forEach(function(r){
          var durSec = Math.max(0, Math.round((r._toMs - Date.parse(r.down_from)) / 1000));
          var mins = Math.round(durSec / 60);
          var dur = mins >= 60 ? (Math.floor(mins/60)+'ч '+(mins%60)+'м') : (mins+' мин');
          h += '<tr><td style="padding:4px 8px;font-weight:600">'+esc(_serverDisplayLabel(r.server_name))+'</td><td style="padding:4px 8px">'+esc((r.down_from||"").slice(5,16).replace("T"," "))+'</td><td style="padding:4px 8px">'+esc((r.down_to||"…").slice(5,16).replace("T"," "))+'</td><td style="padding:4px 8px;text-align:right;color:var(--danger);font-weight:600">'+dur+'</td><td style="padding:4px 8px;text-align:right;color:var(--text-3)">'+(r._flaps > 1 ? r._flaps : '—')+'</td></tr>';
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

// «Состояние сервера» v2: операционный экран в той же светлой карточной
// стилистике, что дашборд/финансы. На первом экране — вердикт, серверы и
// ресурсы; подробные события и история остаются ниже.
function renderSysDashboard(targetId){
  var c=document.getElementById(targetId||'serverHealthContent');if(!c)return;
  c.innerHTML=_sysLoader();
  api(API+'/api/admin/system_health').then(function(d){
    if(d.error){c.innerHTML=_sysError(d.error);return;}
    var cached={};((currentData&&currentData.cachedServers)||[]).forEach(function(s){cached[s.name]=s;});
    var fleet=(currentData&&currentData.fleet&&currentData.fleet.byServer)||{};
    var critical=(d.recent_critical||[]), errorCount=critical.filter(function(x){return x.level==='error';}).length;
    var diskBad=d.disk&&d.disk.used_pct>=85, warn=Number(d.api_errors_24h)>0||diskBad||Object.keys(cached).length>0;
    var h='<section class="sh-shell">';
    h+='<header class="sh-head"><div><span class="sh-eyebrow">Мониторинг платформы</span><h2>Состояние сервера</h2><p>Приложение, база, системные ресурсы и доступность ProxySmart-боксов</p></div>'
      +'<div class="sh-head-actions"><span class="sh-verdict '+(warn?'is-warn':'is-ok')+'"><i></i>'+(warn?'Требует внимания':'Система в норме')+'</span><button class="btn btn-sm" data-on-click="renderSysDashboard(\'serverHealthContent\')">'+icon('refresh',12)+' Обновить</button></div></header>';
    function kpi(ic,label,value,sub,tone){return '<article class="sh-kpi '+(tone||'')+'"><span class="sh-kpi-icon">'+icon(ic,18)+'</span><span><small>'+label+'</small><b>'+value+'</b><em>'+sub+'</em></span></article>';}
    var up=Math.max(0,Number(d.uptime_sec)||0),upText=Math.floor(up/86400)+'д '+Math.floor((up%86400)/3600)+'ч';
    h+='<div class="sh-kpis">'
      +kpi('pulse','Аптайм приложения',upText,'с последнего запуска','is-green')
      +kpi('alert','API-ошибки за 24ч',String(d.api_errors_24h||0),errorCount+' error-событий в ленте',d.api_errors_24h?'is-red':'is-green')
      +kpi('database','База данных',((d.db&&d.db.size_mb)||0)+' МБ','SQLite · рабочий файл','is-blue')
      +kpi('users','Активные сессии',String(d.sessions||0),'администраторы и клиенты','is-purple')+'</div>';

    h+='<div class="sh-grid"><article class="sh-card sh-servers"><div class="sh-card-head"><div><small>Инфраструктура</small><h3>Серверы ProxySmart</h3></div><span>'+(d.servers||[]).length+' шт.</span></div><div class="sh-server-list">';
    (d.servers||[]).forEach(function(s){var off=!!cached[s.name],f=fleet[s.name]||{},on=f.working!=null?f.working:(f.online||0),tot=f.total||0;h+='<div class="sh-server-row"><span class="sh-server-dot '+(off?'is-off':'is-on')+'"></span><span class="sh-server-name"><b>'+esc(s.displayName||s.name)+'</b><small>'+esc(s.country||'Без страны')+'</small></span><span class="sh-server-modems"><b>'+on+'/'+tot+'</b><small>модемов</small></span><span class="sh-server-state '+(off?'is-off':'is-on')+'">'+(off?'Нет связи':'В сети')+'</span></div>';});
    h+='</div></article>';

    var mem=d.memory||{},disk=d.disk||{};function bar(label,pct,meta,tone){pct=Math.max(0,Math.min(100,Number(pct)||0));return '<div class="sh-resource"><div><span>'+label+'</span><b>'+meta+'</b></div><div class="sh-bar"><i class="'+(tone||'')+'" style="width:'+pct+'%"></i></div></div>';}
    var memPct=mem.heap_total_mb?Math.round(mem.heap_mb/mem.heap_total_mb*100):0;
    h+='<article class="sh-card sh-resources"><div class="sh-card-head"><div><small>Ресурсы</small><h3>Запас мощности</h3></div></div>'
      +bar('Диск',disk.used_pct||0,(disk.free_gb!=null?disk.free_gb+' ГБ свободно':'нет данных'),disk.used_pct>=85?'is-red':disk.used_pct>=75?'is-orange':'is-green')
      +bar('Heap Node.js',memPct,(mem.heap_mb||0)+' / '+(mem.heap_total_mb||0)+' МБ',memPct>=85?'is-red':'is-blue')
      +'<div class="sh-resource-note"><span>RSS процесса</span><b>'+(mem.rss_mb||0)+' МБ</b></div></article>';

    h+='<article class="sh-card sh-chart"><div class="sh-card-head"><div><small>7 дней</small><h3>Ошибки и предупреждения</h3></div></div><div class="sh-chart-box"><canvas id="sysErrChart"></canvas></div></article>';
    h+='<article class="sh-card sh-events"><div class="sh-card-head"><div><small>Последние</small><h3>События, требующие внимания</h3></div><button class="btn btn-sm" data-on-click="switchSettingsSection(\'syslog\')">Открыть лог →</button></div><div class="sh-event-list">';
    if(!critical.length)h+='<div class="sh-empty">'+icon('check',18)+' Новых проблем нет</div>';
    critical.slice(0,8).forEach(function(e){h+='<div class="sh-event"><span class="sh-event-level '+(e.level==='error'?'is-error':'is-warn')+'">'+icon(e.level==='error'?'alert':'info',14)+'</span><span><b>'+esc(e.message||e.action||'Событие')+'</b><small>'+esc(e.category||'system')+(e.target?' · '+esc(e.target):'')+'</small></span><time>'+esc((e.timestamp||'').slice(5,16).replace('T',' '))+'</time></div>';});
    h+='</div></article></div>';

    if(d.server_downtime&&d.server_downtime.length){h+='<article class="sh-card sh-downtime"><div class="sh-card-head"><div><small>История</small><h3>Недоступность серверов</h3></div></div><div class="sh-down-list">';d.server_downtime.slice(0,12).forEach(function(x){var mins=Math.max(1,Math.round((x.duration_sec||0)/60));h+='<div><b>'+esc(_serverDisplayLabel(x.server_name))+'</b><span>'+esc((x.down_from||'').slice(5,16).replace('T',' '))+' → '+esc((x.down_to||'').slice(5,16).replace('T',' '))+'</span><strong>'+mins+' мин</strong></div>';});h+='</div></article>';}
    h+='</section>';c.innerHTML=h;
    setTimeout(function(){var cv=document.getElementById('sysErrChart');if(!cv||!window.Chart)return;if(_sysCharts.err)try{_sysCharts.err.destroy();}catch(_){}var cc=getChartColorsLight(),e7=d.errors_by_day||[];_sysCharts.err=newChartSafe(cv,{type:'bar',data:{labels:e7.map(function(x){return x.date.slice(5)}),datasets:[{label:'Ошибки',data:e7.map(function(x){return x.errors}),backgroundColor:'#ef4444',borderRadius:5,maxBarThickness:26},{label:'Предупреждения',data:e7.map(function(x){return x.warns}),backgroundColor:'#f59e0b',borderRadius:5,maxBarThickness:26}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,pointStyle:'circle',boxWidth:6,color:cc.text,font:{size:10}}}},scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:10}},grid:{display:false},border:{display:false}},y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,precision:0},grid:{color:cc.grid},border:{display:false}}}}});},20);
  }).catch(function(e){c.innerHTML=_sysError(e.message);});
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
    return '<b>'+esc(_serverDisplayLabel(s.name))+'</b> ('+(ageMin>0?ageMin+' мин назад':'недоступен')+')';
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
      // Ререндер не должен дёргать скролл: запоминаем позицию до перерисовки
      // (контейнеры временно схлопываются → браузер подбрасывал наверх) и
      // возвращаем после двух кадров, когда layout устаканился (20.08).
      var _sy=window.scrollY;
      processData();renderServerFilter();renderTable(true);updateHeaderStats();
      document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('ru-RU');
      var _st=localStorage.getItem('admin_active_tab')||'dashboard';
      refreshActiveTabInPlace(_st);
      requestAnimationFrame(function(){requestAnimationFrame(function(){window.scrollTo(0,_sy)})});
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
    showToast('Cmd+K — поиск · / — поиск · Esc — закрыть модалку','info',5000);
  }
});

function processData(){if(!currentData)return;_initServers(currentData.servers);var downSet={};(currentData.cachedServers||[]).forEach(function(s){downSet[s.name]=true;});var mm={},sa=currentData.status||[];for(var i=0;i<sa.length;i++){var m=sa[i],imei=m.modem_details?m.modem_details.IMEI:null;if(!imei)continue;mm[imei]={raw:m,server:m._server,_cached:!!m._cached,_serverDown:!!downSet[m._server],nick:m.modem_details.NICK||'',imei:imei,rawImei:imei.replace(/^S\d+_/,''),phone:m.modem_details.PHONE_NUMBER||'',contractRenewalDate:m.modem_details.CONTRACT_RENEWAL_DATE||'',model:m.modem_details.MODEL_SHOWN||m.modem_details.MODEL||'',uptime:m.modem_details.UDEV_UPTIME||0,notes:m.modem_details.NOTES||'',usbId:m.modem_details.USB_ID||'',extIp:(m.net_details?m.net_details.EXT_IP:'')||'',netType:(m.net_details?m.net_details.CurrentNetworkType:'')||'',iccid:(function(){var v=(m.net_details?String(m.net_details.ICCID||''):'').trim();return(v&&v.toLowerCase()!=='unknown')?v:''})(),signal:parseInt(m.net_details?m.net_details.SIGNAL_STRENGTH:'0')||0,operator:(function(){var r=(m.net_details?m.net_details.CELLOP:'')||'';var srv=m._server||'';var isRO=srv.indexOf('S2')===0||srv==='S2';var _c=r.toLowerCase().replace(/\s+/g,' ').trim();var n={'unite':'Moldtelecom','moldtelecom':'Moldtelecom','moldtelecom moldtelecom':'Moldtelecom','moldcell':'Moldcell','orange':isRO?'Orange RO':'Orange MD','orange ro':'Orange RO','orange md':'Orange MD','vf-ro':'Vodafone RO','vfro':'Vodafone RO','vodafone ro':'Vodafone RO','vodafone':'Vodafone RO'};return n[_c]||r})(),apn:(m.net_details?m.net_details.APN:'')||'',isTestPool:!!m.isTestPool,isOnline:!m._cached&&!downSet[m._server]&&(m.net_details?m.net_details.IS_ONLINE==='yes':false),isRotating:m.IS_ROTATED==='true',isRebooting:m.IS_REBOOTING==='true',state:m.STATE,connectionStatus:(m.net_details?m.net_details.ConnectionStatus:'')||'',timeToRotation:m.modem_details.TIME_TO_IP_ROTATION||'',autoRotation:m.modem_details.AUTO_IP_ROTATION||'',targetMode:m.modem_details.TARGET_MODE||'',ping:(m.net_details?m.net_details.ping_stats:'')||'',band:(function(){var b=(m.net_details?String(m.net_details.BAND||''):'').trim();return(b&&b!=='?')?b:''})(),simStatus:(m.net_details?String(m.net_details.SimStatus||'').toUpperCase().trim():''),httpRedirect:(function(){var r=m.net_details?m.net_details.HTTP_REDIRECT_IMPOSED:null;if(r==null)return false;var s=String(r).toLowerCase().trim();return!!s&&['no','null','0','false','none'].indexOf(s)<0})(),rebootScore:(function(){var r=m.modem_details?m.modem_details.REBOOT_SCORE:null;return(r!=null&&r!==''&&isFinite(+r))?Math.round(+r):null})(),isLocked:(m.IS_LOCKED===true||m.IS_LOCKED==='true'),msg:(function(){var b=m.MSGS;b=Array.isArray(b)?b.join(' '):(b||'');return [m.MSG||'',b].filter(Boolean).join('; ').trim()})(),webappDown:(function(){var b=m.MSGS;b=Array.isArray(b)?b.join(' '):(b||'');return /web ?app|not available|restart the modem/i.test(String(m.MSG||'')+' '+b)})(),pktLoss:(function(){var p=(m.net_details?m.net_details.ping_stats:'')||'';var mm=/(\d+)\s*%\s*loss/i.exec(p);return mm?parseInt(mm[1],10):null})(),connDead:(function(){var c=String((m.net_details?m.net_details.ConnectionStatus:'')||'').toLowerCase();return /disconnect|ppp_disc|no carrier|down/.test(c)})(),ports:[]}}
  var po=currentData.ports||{};for(var pi in po){if(mm[pi])mm[pi].ports=po[pi]}
  var bw=currentData.bandwidth||{};for(var mi in mm){var mod=mm[mi];for(var p=0;p<mod.ports.length;p++){var pt=mod.ports[p];if(bw[pt.portID])pt._bw=bw[pt.portID]}}
  // IP tracking & uptime tracking
  var ipt=currentData.ipTracking||{};
  var iph=currentData.ipHistory||{};
  var upt=currentData.uptimeTracking||{};
  var spt=currentData.speedtestLatest||{};
  var now=Date.now();
  for(var imei in mm){
    var m=mm[imei];
    // Stuck IP detection. Источник — ip_history (долговечная): cleanup периодически
    // прунит ipTracking у долго-офлайн модемов, и по возвращении модем получает
    // СВЕЖИЙ since — застой прячется от правила 24ч на сутки (2026-08-02).
    // ip_history переживает прунинг, поэтому берём max возраста из обоих источников.
    var _sinceMs=null;
    var _ent=iph[imei];
    if(_ent&&_ent.length){var _lf=Number(_ent[_ent.length-1].from)||0;if(_lf)_sinceMs=now-_lf;}
    if(ipt[imei]){
      // since бывает epoch-числом ИЛИ ISO-строкой (modem-tracking пишет ISO) —
      // Number(ISO)=NaN, поэтому оба формата парсим.
      var _sv=ipt[imei].since,_sn=Number(_sv),_sm=isNaN(_sn)?(isNaN(Date.parse(_sv))?null:now-Date.parse(_sv)):now-_sn;
      if(_sm!=null&&(_sinceMs==null||_sm>_sinceMs))_sinceMs=_sm;
    }
    if(_sinceMs!=null){
      m.ipStuck=_sinceMs>24*60*60*1000;
      m.ipSinceHours=Math.floor(_sinceMs/3600000);
    }
    // Uptime percentage
    if(upt[imei]&&upt[imei].total_checks>0){
      m.uptimePct=(upt[imei].online_checks/upt[imei].total_checks*100).toFixed(1);
      m.uptimeOnlineChecks=upt[imei].online_checks||0;
      m.uptimeTotalChecks=upt[imei].total_checks||0;
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
  var pcSumMap={};
  for(var pi=0;pi<pcSummary.length;pi++){var p=pcSummary[pi];pcSumMap[p.server_name+'_'+p.nick]={total:p.total_checks||0,errors:p.error_count||0}}
  var pcConsecMap={},pcConsec=pcs.consec||[];for(var ci=0;ci<pcConsec.length;ci++){pcConsecMap[pcConsec[ci].server_name+'_'+pcConsec[ci].nick]=pcConsec[ci].consec||0}
  var pcTodayMap={},pcToday=pcs.today||[];for(var ti=0;ti<pcToday.length;ti++){var pt=pcToday[ti];pcTodayMap[pt.server_name+'_'+pt.nick]={total:pt.total_checks||0,errors:pt.error_count||0}}
  for(var imei in mm){
    var m=mm[imei],pKey=m.server+'_'+m.nick;
    var sm=pcSumMap[pKey];
    m.pcErrorPct=sm&&sm.total>0?Math.round((sm.errors||0)/sm.total*100):null;
    var td=pcTodayMap[pKey];
    m.pcChecksToday=td?td.total:0;
    m.pcErrToday=td?td.errors:0;
    m.pcErrorPctToday=td&&td.total>0?Math.round((td.errors||0)/td.total*100):null;
    m.pcConsecFails=pcConsecMap[pKey]||0;
  }
  currentData._modemMap=mm;
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
    var backFn=m?'switchTab(\'speed\',document.querySelector(\'.modal-tab[data-tab="speed"]\'))':'';
    mb.innerHTML='<div style="padding:12px"><div style="margin-bottom:10px;display:flex;gap:6px;align-items:center">'
      +'<button class="btn btn-sm" data-on-click="'+backFn+'">← Назад</button>'
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
  overlay.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:420px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)">'
    +'<h3 style="margin:0 0 12px;font-size:14px;color:var(--text-0)">'+icon('shield',15)+' OS Spoofing — '+portsList.length+' портов</h3>'
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
    +'<button class="btn btn-sm" data-on-click="this.closest(\'div[style*=fixed]\').remove()">Отмена</button>'
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
  overlay.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:20px;width:420px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)">'
    +'<h3 style="margin:0 0 12px;font-size:14px;color:var(--text-0)">'+icon('clock',15)+' Авторотация — '+modems.length+' модемов</h3>'
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
    +'<button class="btn btn-sm" data-on-click="this.closest(\'div[style*=fixed]\').remove()">Отмена</button>'
    +'<button class="btn btn-primary btn-sm" id="bulkRotBtn">Применить</button>'
    +'</div></div>';
  document.body.appendChild(overlay);
  document.getElementById('bulkRotBtn').onclick=function(){
    var rot=parseInt(document.getElementById('bulkRotSelect').value);
    if(window._bulkRotRunning){showToast('Массовая ротация уже выполняется','warning');return}
    overlay.remove();   // модалку закрываем сразу — дальше прогресс живёт в тосте
    window._bulkRotRunning=true;
    var c=document.getElementById('toastContainer');
    var prog=null;
    // Один живой тост-прогресс: текст обновляется по каждому модему
    // («3/10 — MD_04»). По одному модему за запрос: bulk-эндпоинт делает
    // GET формы + POST + verify-after-write на каждый модем, а за один
    // HTTP-запрос это не укладывается в разумный таймаут — отсюда и
    // «ротация не применяется»: запрос обрывался на середине пачки.
    function setProgress(txt){
      if(!c)return;
      if(!prog){prog=document.createElement('div');prog.className='toast toast-info';
        prog.innerHTML='<span class="toast-icon">'+icon('clock',10)+'</span><span class="toast-text"></span><button class="toast-close" data-on-click="this.closest(\'.toast\').remove()">'+icon('x',11)+'</button>';
        c.appendChild(prog);}
      prog.querySelector('.toast-text').textContent=txt;
    }
    var ok=0, failures=[], i=0;
    function finish(){
      window._bulkRotRunning=false;
      if(prog&&prog.parentNode)prog.remove();
      if(failures.length){
        var fl=failures.map(function(f){return '<div style="font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)"><b>'+esc(f.nick)+'</b> — '+esc(f.reason)+'</div>';}).join('');
        var ov2=document.createElement('div');
        ov2.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10001;display:flex;align-items:center;justify-content:center';
        ov2.onclick=function(e){if(e.target===ov2)ov2.remove()};
        ov2.innerHTML='<div style="background:var(--bg-1);border-radius:12px;padding:18px;width:440px;max-width:92vw;box-shadow:0 24px 64px rgba(0,0,0,.5)">'
          +'<div style="font-size:13px;font-weight:600;color:var(--danger);margin-bottom:10px">Не применено: '+failures.length+' из '+modems.length+'</div>'
          +'<div style="max-height:50vh;overflow-y:auto;margin-bottom:12px">'+fl+'</div>'
          +'<div style="font-size:10px;color:var(--text-3);margin-bottom:10px">У этих модемов показ ротации сброшен до «нет данных» — обновится из бокса сам. Обычные причины: модем в ротации/ребуте — повторите через минуту.</div>'
          +'<div style="text-align:right"><button class="btn btn-primary btn-sm" data-on-click="this.closest(\'div[style*=fixed]\').remove()">Понял</button></div></div>';
        document.body.appendChild(ov2);
        showToast('Ротация: применено '+ok+' из '+modems.length,'error');
      } else {
        showToast('Ротация установлена: '+ok+' модемов','success');
      }
      clearBulkSel();setTimeout(loadData,1500);
    }
    function next(){
      if(i>=modems.length){finish();return}
      var m=modems[i];var s=window._bulkSel[m.imei]||{};
      var label=s.nick||m.imei;
      setProgress('Ротация: '+(i+1)+'/'+modems.length+' — '+label);
      api(API+'/api/admin/bulk_rotation',{method:'POST',json:{modems:[m],rotation:rot}})
      .then(function(d){
        if(d.ok)ok++;
        else{var f=(d.failures&&d.failures[0])||{imei:m.imei,reason:d.error||'ошибка'};failures.push({nick:label,reason:f.reason||'ошибка'});}
      })
      .catch(function(e){failures.push({nick:label,reason:String(e.message||e).slice(0,80)});})
      .then(function(){i++;next();});
    }
    setProgress('Ротация: 0/'+modems.length+'…');
    next();
  };
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
  // Окно (переключатели клиента/протокола, список, копирование) — глобальные
  // хелперы в admin/delegated-helpers.js: delegation работает только с globals.
  aeOpen(proxies);
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
  var iconForPrio={critical:icon('siren',14),important:icon('alert',14),early:icon('info',14),info:'•'};
  var h='';
  notifs.forEach(function(n){
    var prio=n.priority||'info';
    var read=!!n.read_at;
    var icon=iconForPrio[prio]||'•';
    // First line of message: keep the original emoji (if any) by stripping
    // none; the rendered message already starts with one in most rules.
    h+='<div class="notif-item '+(read?'read':'unread')+'" data-id="'+n.id+'" data-on-click="onNotifClick(event,'+n.id+')">';
    h+='<span class="notif-item-strip notif-item-strip--'+prio+'"></span>';
    h+='<div class="notif-icon notif-icon--'+prio+'">'+icon+'</div>';
    h+='<div class="notif-body">';
    h+='<div class="notif-title">'+esc(n.title||'')+'</div>';
    h+='<div class="notif-text">'+(n.message||'').replace(/\n/g,'<br>')+'</div>';
    h+='<div class="notif-time">'+timeAgo(n.created_at)+'</div>';
    h+='</div>';
    h+='<button class="notif-dismiss" title="Скрыть" data-on-click="event.stopPropagation();dismissNotif('+n.id+')">×</button>';
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
        if(found&&typeof openDetailAtTab==='function')openDetailAtTab(nick,found.server,'info');
      }
    } else if(n.entity_kind==='client'){
      switchMainTab('clients');
      if(n.entity_id&&typeof showClientDetail==='function'){setTimeout(function(){showClientDetail(n.entity_id)},150);}
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

// Bootstrap runtime thresholds before Settings is opened.
function _loadRuntimeThresholds(){
  if(!authToken)return;
  api(API+'/api/admin/settings')
    .then(function(d){return (d&&d.__status>=400)?null:d})
    .then(function(s){
      if(!s)return;
      var changed=false;
      var ert=Number(s.error_rate_threshold);
      if(ert>0&&ert!==_errorRateThreshold){_errorRateThreshold=ert;changed=true;}
      // Stage 18.16: same bootstrap issue applies to stale_modem_hours — the
      // «Не в стат.» chip uses it to decide who's excluded from analytics.
      var smh=Number(s.stale_modem_hours);
      if(smh>0&&window._staleModemHours!==smh){window._staleModemHours=smh;changed=true;}
      // 2026-07-28: same bootstrap for modem_offline_threshold_min — the
      // «отключено >N мин» labels and the блип tooltip read it.
      var mot=Number(s.modem_offline_threshold_min);
      if(mot>0&&window._offlineThresholdMin!==mot){window._offlineThresholdMin=mot;changed=true;}
      if(changed&&currentData&&typeof renderTable==='function'){try{renderTable(true);}catch(_){}}
    })
    .catch(function(){});
}
if(typeof window!=='undefined'){
  setTimeout(_loadRuntimeThresholds,300);
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
    h+='<td style="font-size:11px">'+(isClient?'<span style="color:var(--accent)">'+icon('user',11)+'</span> ':'')+esc(e.admin||'—')+'</td>';
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
  var _cnt={all:0,active:0,debtors:0,expiring:0,inactive:0},_mrr=0;cl.forEach(function(c){var b=c.balance!==undefined?c.balance:0;var ch=((currentData.clientRevenue30d||{})[c.id]||0);var md=(pnm[c.portName]||[]).length;if(md===0){_cnt.inactive++;return;}_cnt.all++;_mrr+=ch;if(b<0){_cnt.debtors++;}else{if(md>0)_cnt.active++;if(ch>0&&b/(ch/30)<5)_cnt.expiring++;}});
  var h='';var count=0;var colors=CHART_COLORS.clients;
  cl.forEach(function(c,i){
    var modems=pnm[c.portName]||[];
    // 21.08: «Неактивные» — клиенты без модемов (порты удалены BlockedPortCleanup
    // после hold, отвязаны вручную или ещё не выдавались). Скрыты из всех
    // фильтров, показываются только на своей вкладке.
    var _isInact=modems.length===0;
    if(_clientFilter==='inactive'){if(!_isInact)return;}
    else if(_isInact)return;
    if(search&&(c.name+' '+c.portName+' '+c.login+' '+(c.contact||'')+' '+(c.legalName||'')).toLowerCase().indexOf(search)===-1)return;
    var balance=c.balance!==undefined?c.balance:0;
    var _ch0=((currentData.clientRevenue30d||{})[c.id]||0);if(_clientFilter==='active'&&!(balance>=0&&modems.length>0))return;if(_clientFilter==='debtors'&&balance>=0)return;if(_clientFilter==='expiring'&&!(balance>=0&&_ch0>0&&balance/(_ch0/30)<5))return;
    count++;var bt=c.billingType||'per_gb';var price=c.price||0;
    var cost=Math.round(((currentData.clientMonthCharges||{})[c.id]||0)*100)/100;
    // «Трафик/мес» — биллинговый объём из ledger (clientMonthGb), совпадает с
    // актом. Живые счётчики (clientLiveMonthGb) теряют трафик при рестартах.
    var monthGbLive=Math.round(((currentData.clientMonthGb||{})[c.id]||0)*10)/10;
    var tariffLabel=price+(bt==='per_modem'?'\u20BD/мод':'\u20BD/\u0413\u0411');
    var ctLabel=(c.clientType||'legal')==='individual'?'Физ. лицо':'Юр. лицо';
    var balWarn='';
    var color=colors[(count-1)%colors.length];
    var isInactive=!modems.length;
    // Метка «пауза начислений» — перечёркнутый рубль (title поясняет), а не
    // текст ПАУЗА; БЛОК (антифрод ИЛИ автоблок портов за долг) — приоритетнее
    // должника: порт заблокирован важнее, чем минус на балансе.
    var _pauseMark='<span title="Пауза начислений — списания остановлены" style="display:inline-flex;align-items:center">'+icon('moneyOff',11)+'</span>';
    var _blkMark=c.blocked?'<span title="Аккаунт заблокирован (антифрод)">БЛОК</span>':(c.debtBlocked?'<span title="Порты заблокированы за долг: прокси уже не работают, через несколько дней будут удалены — доступ восстановится после оплаты">БЛОК</span>':null);
    var _isBlocked=!!_blkMark;
    var _stp=_blkMark?[_blkMark,'var(--danger)','#fff']:(balance<0?['ДОЛЖНИК','var(--danger)','#fff']:(c.billingPaused?[_pauseMark,'var(--warning)','#000']:(isInactive?['НЕТ МОДЕМОВ','var(--bg-3)','var(--text-2)']:['АКТИВЕН','var(--success)','#fff'])));
    var stPill='<span style="font-size:9px;font-weight:600;color:'+_stp[2]+';background:'+_stp[1]+';padding:3px 9px;border-radius:6px;letter-spacing:.5px;white-space:nowrap">'+_stp[0]+'</span>';
    h+='<div class="client-card'+(isInactive?' client-card--inactive':'')+'"'+(_isBlocked?' style="border-color:var(--danger);box-shadow:0 0 0 1px rgba(232,65,65,.35)"':'')+'>';
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
    var ms=[['Тариф',tariffLabel,'var(--text-1)'],['Расход/мес',Math.round(cost).toLocaleString('ru-RU')+' ₽','var(--accent)'],['Трафик/мес',monthGbLive.toFixed(1)+' GB','var(--text-1)'],['Модемов',(typeof c.modemWorking==='number'&&typeof c.modemCount==='number')?(c.modemWorking+'/'+c.modemCount):(''+_pm),isInactive?'var(--text-3)':'var(--text-1)']];
    ms.forEach(function(m){h+='<div><div style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">'+m[0]+'</div><div style="font-size:13px;font-weight:600;color:'+m[2]+';font-family:var(--font-mono)">'+m[1]+'</div></div>';});
    h+='</div>';
    h+='<div style="display:flex;gap:6px">';
    h+='<button class="btn btn-sm btn-primary" data-on-click="renderClientDetail(\''+c.id+'\',\'payments\')" style="flex:1;font-size:11px;justify-content:center">Платежи</button>';
    h+='<button class="btn btn-sm" data-on-click="renderClientDetail(\''+c.id+'\')" style="flex:1;font-size:11px;justify-content:center" title="Детали и настройки">Детали</button>';
    h+='<button class="btn btn-sm" data-on-click="impersonateClient(\''+c.id+'\',\''+esc(c.name)+'\')" style="font-size:11px" title="Войти как клиент">'+icon('user',12)+'</button>';
    h+='</div>';
    h+='</div>';
    // Expandable modems
    h+='<div id="clientCard_'+c.id+'" style="display:none;padding:0 16px 14px;border-top:1px solid var(--border)">';
    h+='<div style="display:flex;align-items:center;gap:8px;margin:10px 0 8px">';
    h+='<span style="font-size:11px;font-weight:600;color:var(--text-0)">Модемы ('+modems.length+')</span>';
    h+='<button class="btn btn-sm" data-on-click="openAssignModemModal(\''+c.id+'\',\''+esc(c.portName)+'\')" style="font-size:9px;padding:1px 6px;background:var(--accent);color:#fff">+ Модем</button>';
    h+='</div>';
    if(modems.length){h+='<div style="display:flex;flex-wrap:wrap;gap:4px">';modems.forEach(function(md){var mn=md.nick+' ('+_serverDisplayLabel(md.server)+')';h+='<span class="client-modem-tag" style="display:inline-flex;align-items:center;gap:4px">'+esc(mn)+' <span data-on-click="unassignModem(\''+esc(md.nick)+'\',\''+esc(c.portName)+'\',\''+esc(md.server)+'\')" style="cursor:pointer;color:var(--danger);font-size:12px;line-height:1" title="Отвязать">&times;</span></span>';});h+='</div>';}
    else{h+='<div style="font-size:11px;color:var(--text-3)">Нет подключённых модемов</div>';}
    h+='<div id="paymentArea_'+c.id+'" style="margin-top:8px"></div>';
    h+='</div>';
    h+='</div>';
  });
  if(!count)h='<div style="text-align:center;padding:60px;color:var(--text-3);font-size:14px">Нет клиентов</div>';
  var summary=document.getElementById('clientSummary');
  if(summary)summary.textContent=count+' клиент'+(count===1?'':'ов');
  var _st=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};_st('clCntAll',_cnt.all);_st('clCntActive',_cnt.active);_st('clCntDebt',_cnt.debtors);_st('clCntExp',_cnt.expiring);_st('clCntInact',_cnt.inactive);var _me=document.getElementById('clMrrTotal');if(_me)_me.textContent=Math.round(_mrr).toLocaleString('ru-RU')+' ₽';
  container.innerHTML=h;
  // Update debt count badge on "Проблемные" button
  var debtCount=(currentData.clients||[]).filter(function(c){return(c.balance!==undefined?c.balance:0)<0}).length;
  var dcBadge=document.getElementById('debtCountBadge');
  if(dcBadge){if(debtCount>0){dcBadge.textContent=debtCount;dcBadge.style.display='';}else{dcBadge.style.display='none';}}
}
function toggleBankFields(){var isLegal=document.getElementById('cfClientType').value==='legal';var el=document.getElementById('bankFieldsSection');if(el)el.style.display=isLegal?'':'none';if(!document.getElementById('clientFormId').value){document.getElementById('cfAllowDebt').checked=isLegal}}
function showClientForm(data){document.getElementById('clientFormId').value=data?data.id:'';document.getElementById('clientModalTitle').textContent=data?'Редактировать':'Новый клиент';document.getElementById('cfName').value=data?data.name:'';document.getElementById('cfPortName').value=data?data.portName:'';document.getElementById('cfLogin').value=data?data.login:'client_'+rnd(8);document.getElementById('cfPassword').value=data?'':rnd(12);document.getElementById('cfPassword').placeholder=data?'Без изменений':'';document.getElementById('cfContact').value=data?(data.contact||''):'';document.getElementById('cfBillingType').value=data?(data.billingType||'per_modem'):'per_modem';document.getElementById('cfPrice').value=data?(data.price||0):0;document.getElementById('cfNotes').value=data?(data.notes||''):'';document.getElementById('cfClientType').value=data?(data.clientType||'legal'):'individual';toggleBankFields();document.getElementById('cfInn').value=data?(data.inn||''):'';document.getElementById('cfKpp').value=data?(data.kpp||''):'';document.getElementById('cfLegalName').value=data?(data.legalName||''):'';document.getElementById('cfAddress').value=data?(data.address||''):'';document.getElementById('cfContractInfo').value=data?(data.contractInfo||''):'';document.getElementById('cfContractDate').value=data?((data.contractDate||'').slice(0,10)):'';document.getElementById('cfAutoActs').checked=data?(data.autoActs!==false):true;document.getElementById('cfAutoBills').checked=data?(data.autoBills!==false):true;document.getElementById('cfBillingPaused').checked=data?!!data.billingPaused:false;document.getElementById('cfAllowDebt').checked=data?!!data.allowDebt:(document.getElementById('cfClientType').value==='legal');document.getElementById('cfMaxDebt').value=data&&typeof data.maxDebt==='number'?data.maxDebt:'';var apiSec=document.getElementById('cfApiKeySection');if(data&&data.apiKey){apiSec.style.display='block';document.getElementById('cfApiKey').value=data.apiKey}else{apiSec.style.display='none';document.getElementById('cfApiKey').value=''}document.getElementById('clientModal').classList.add('show')}
function closeClientModal(){document.getElementById('clientModal').classList.remove('show');currentOpsClientId=null;}
document.getElementById('clientModal').addEventListener('click',function(e){if(e.target===this)closeClientModal()});
function editClient(id){var c=(currentData.clients||[]).find(function(x){return x.id===id});if(c)showClientForm(c)}
function saveClient(){var id=document.getElementById('clientFormId').value;var maxDebtRaw=document.getElementById('cfMaxDebt').value;var d={name:document.getElementById('cfName').value,portName:document.getElementById('cfPortName').value,login:document.getElementById('cfLogin').value,password:document.getElementById('cfPassword').value,contact:document.getElementById('cfContact').value,billingType:document.getElementById('cfBillingType').value,price:document.getElementById('cfPrice').value,notes:document.getElementById('cfNotes').value,clientType:document.getElementById('cfClientType').value,inn:document.getElementById('cfInn').value,kpp:document.getElementById('cfKpp').value,legalName:document.getElementById('cfLegalName').value,address:document.getElementById('cfAddress').value,contractInfo:document.getElementById('cfContractInfo').value,contractDate:document.getElementById('cfContractDate').value,autoActs:document.getElementById('cfAutoActs').checked,autoBills:document.getElementById('cfAutoBills').checked,billingPaused:document.getElementById('cfBillingPaused').checked,allowDebt:document.getElementById('cfAllowDebt').checked,maxDebt:maxDebtRaw!==''?parseFloat(maxDebtRaw):undefined};if(!d.name||!d.portName||!d.login||(!id&&!d.password))return showToast('Заполните обязательные поля','error');api(API+(id?'/api/admin/clients/'+id:'/api/admin/clients'),{method:id?'PUT':'POST',json:d}).then(function(r){if(r.ok||r.client){showToast(id?'Обновлён':'Создан','success');closeClientModal();loadData()}else showToast(r.error,'error')}).catch(function(e){showToast(e.message,'error')})}
function deleteClient(id,name){confirmDialog('Удалить клиента «'+name+'»? Это действие нельзя отменить.',function(){api(API+'/api/admin/clients/'+id,{method:'DELETE'}).then(function(d){d.ok?showToast('Удалён','success'):showToast(d.error,'error');loadData()}).catch(function(e){showToast(esc(e.message),'error')});},'Удалить','Удалить клиента')}
// ── WP7 (B2C Э5): антифрод розницы — разблокировка только админом ──
// «Снять блок»: blocked=0; при подтверждении — strikes тоже обнуляем (иначе
// следующее нарушение снова доберётся до порога и переблокирует аккаунт).
function unblockClientAbuse(id){
  if(!id)return;
  confirmDialog('Снять блокировку аккаунта и обнулить счётчик нарушений (strikes)? Замороженные порты при этом НЕ восстанавливаются — для этого «Реабилитировать порт».',function(){
    api(API+'/api/admin/clients/'+id+'/unblock',{method:'POST',json:{reset_strikes:true}}).then(function(d){
      if(d&&d.ok){
        showToast('Блокировка снята','success');
        // loadData() — fire-and-forget (не возвращает promise): обновим
        // локальный объект сразу, чтобы дравер перерисовался без гонки.
        var c=(currentData.clients||[]).find(function(x){return x.id===id});
        if(c){c.blocked=false;c.abuseStrikes=0;renderClientDetail(id)}
        loadData();
      }
      else showToast((d&&d.error)||'Ошибка','error');
    }).catch(function(e){showToast(esc(e.message),'error')});
  },'Снять блок','Антифрод');
}
// Ручная блокировка клиента и всех его соединений: blocked=1, сброс сессий,
// гашение всех портов (B2B «дата до» = сегодня, розница — пул → blocked).
function blockClientAdmin(id){
  if(!id)return;
  confirmDialog('Заблокировать клиента и ВСЕ его соединения? Сессии будут сброшены, все порты погашены (доступ отключится сразу). Списания по заблокированным портам остановятся.',function(){
    showToast('Блокирую: гашение портов на боксах, до ~30 сек…','info');
    api(API+'/api/admin/clients/'+id+'/block',{method:'POST',json:{}}).then(function(d){
      if(d&&d.ok){
        showToast('Заблокирован: портов погашено '+(d.b2b||0)+(d.retail?', розницы '+d.retail:'')+(d.errors&&d.errors.length?' (ошибки: '+d.errors.length+')':''),d.errors&&d.errors.length?'warning':'success');
        var c=(currentData.clients||[]).find(function(x){return x.id===id});
        if(c){c.blocked=true;renderClientDetail(id)}
        loadData();
      }
      else showToast((d&&d.error)||'Ошибка','error');
    }).catch(function(e){showToast(esc(e.message),'error')});
  },'Заблокировать','Блокировка клиента');
}
// «Реабилитировать порт»: возврат портов, замороженных антифродом
// (kv-маркер abuse_hold), «дата до» продлевается по балансу.
function rehabilitateClientPorts(id,onDone){
  if(!id)return;
  confirmDialog('Вернуть клиенту порты, замороженные антифродом? «Дата до» будет продлена по текущему балансу.',function(){
    api(API+'/api/admin/retail/client/rehabilitate',{method:'POST',json:{client_id:id}}).then(function(d){
      if(d&&d.ok){showToast('Портов восстановлено: '+(d.restored||[]).length,'success')}
      else if(d&&(d.restored||[]).length){showToast('Частично: '+d.restored.length+', ошибок: '+(d.errors||[]).length,'error')}
      else showToast((d&&(d.note||d.error))||'Нечего восстанавливать','error');
      if(typeof onDone==='function')onDone(); else loadData();
    }).catch(function(e){showToast(esc(e.message),'error')});
  },'Реабилитировать','Антифрод');
}

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
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0;font-size:14px">Добавить модем клиенту</h3><button data-on-click="document.getElementById(\'assignModemOverlay\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-2)">&times;</button></div>' +
    '<div style="font-size:11px;color:var(--text-2);margin-bottom:8px">portName: <b>' + esc(clientPortName) + '</b></div>' +
    '<input id="assignModemSearch" class="form-input" placeholder="Поиск по нику модема..." style="width:100%;margin-bottom:8px;font-size:12px" data-on-input="filterAssignModemList()">' +
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
    h += '<td style="padding:6px 8px;font-size:10px;color:var(--text-2)">' + esc(_serverDisplayLabel(m.server)) + '</td>';
    h += '<td style="padding:6px 8px;font-size:10px;color:' + clr + '">' + esc(assigned) + '</td>';
    h += '<td style="padding:6px 8px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:var(--accent);color:#fff" data-on-click="assignModem(\'' + esc(m.server) + '\',\'' + esc(m.portID) + '\',\'' + esc(data.clientPortName) + '\',\'' + esc(m.nick) + '\')">Назначить</button></td>';
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

function unassignModem(nick, clientPortName, server) {
  if (!confirm('Отвязать ' + nick + ' от клиента?')) return;
  // Find modem portID by nick
  api(API + '/api/admin/available_modems')
    .then(function(data) {
      var modem = (data.modems || []).find(function(m) { return m.nick === nick && m.portName === clientPortName && (!server || m.server === server); });
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
  function onOk(){if(b){var o=b.innerHTML;b.innerHTML=icon('check',12);setTimeout(function(){b.innerHTML=o},1500)}showToast('Скопировано','info')}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(onOk).catch(doFallback)}else{doFallback()}
  function doFallback(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;left:-9999px;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');onOk()}catch(e){showToast('Ошибка копирования','error')}document.body.removeChild(a)}
}
function togglePass(el){if(el.classList.contains('revealed')){el.textContent='\u2022\u2022\u2022\u2022';el.classList.remove('revealed');el.style.color='';el.style.letterSpacing=''}else{el.textContent=el.dataset.pass;el.classList.add('revealed');el.style.color='var(--text-0)';el.style.letterSpacing='normal'}}
// showToast moved to /js/utils.js
var _confirmCb=null;
function showProblemPopup(label,key){
  var items=(window._problemData&&window._problemData[key])||[];
  if(!items.length)return;
  var h='<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1500;display:flex;align-items:center;justify-content:center" data-on-click="this.remove()">';
  h+='<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;min-width:340px;max-width:520px;max-height:70vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)">';
  h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="font-size:14px;font-weight:600;color:var(--text-0)">'+esc(label)+' <span style="color:var(--text-3);font-weight:400">('+items.length+')</span></span><button style="background:none;border:none;font-size:18px;color:var(--text-2);cursor:pointer;padding:0 4px" data-on-click="this.closest(\'div[style*=fixed]\').remove()">&times;</button></div>';
  if(key==='flaky'){
    h+='<div style="margin:0 0 12px;padding:11px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:9px;color:var(--text-2);font-size:11px;line-height:1.5">';
    h+='<div style="font-weight:600;color:var(--text-0);margin-bottom:5px">В список попадают только активные клиентские прокси при:</div>';
    h+='<ul style="margin:0;padding-left:18px">'
      +'<li>устойчивых потерях или трёх ping-провалах подряд;</li>'
      +'<li>двух HTTP-провалах подряд;</li>'
      +'<li>разрыве соединения;</li>'
      +'<li>проблеме SIM или редиректе оператора;</li>'
      +'<li>недоступности ProxySmart WebApp.</li>'
      +'</ul></div>';
  }
  h+='<div style="display:flex;flex-direction:column;gap:6px">';
  items.forEach(function(item){
    var n=item.nick||item;
    var detail=item.detail||'';
    var srv=item.server||'';
    var srvLabel=srv?_serverDisplayLabel(srv):'';
    h+='<div style="padding:8px 12px;background:var(--bg-2);border-radius:8px;border:1px solid var(--border);cursor:pointer" data-on-click="openModemDetailByNick(\''+esc(n).replace(/\x27/g,"\\\x27")+'\',\''+esc(srv).replace(/\x27/g,"\\\x27")+'\')">';
    h+='<div style="font-size:12px;font-weight:500;color:var(--text-0);margin-bottom:2px">'+esc(n)+(srvLabel?' <span style="font-size:10px;color:var(--text-3);font-weight:400">· '+esc(srvLabel)+'</span>':'')+'</div>';
    if(detail)h+='<div style="font-size:11px;color:var(--text-2)">'+esc(detail)+'</div>';
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
  var _flDown=Math.max(0,_flTotal-_flWorking);          // отключено >N мин (порог)
  var _flBlip=Math.max(0,_flWorking-_flLive);           // молчат <N мин (блип)
  var _offMin=window._offlineThresholdMin||10;
  var title='В парке: '+_flTotal+' · рабочих: '+_flWorking+' (онлайн сейчас '+_flLive+', блипов '+_flBlip+') · отключено >'+_offMin+'м: '+_flDown;
  document.getElementById('headerStats').innerHTML='<div class="stat-badge" title="'+title+'">В работе: <span style="color:var(--success)">'+_flWorking+'</span>/<span>'+_flTotal+'</span></div>';
}
// Top progress bar = countdown to next auto-refresh. Pure CSS transition: snap to
// 0 (no transition), force reflow, then animate to 100% over REFRESH_MS linearly.
// Re-armed at the start of every loadData (auto or manual), so it always reflects
// the time left until the next refresh.
function _armRefreshBar(){var bar=document.getElementById('refreshBar');if(!bar)return;bar.style.transition='none';bar.style.width='0%';void bar.offsetWidth;bar.style.transition='width '+REFRESH_MS+'ms linear';bar.style.width='100%';}
function startAutoRefresh(){if(autoRefreshTimer)clearInterval(autoRefreshTimer);_armRefreshBar();autoRefreshTimer=setInterval(loadData,REFRESH_MS)}
// SSE (23.08): при живом realtime-канале polling урежается до 5 мин
// (страховка), при обрыве возвращается к 60 сек. Вызывается из sse.js.
function setPollingInterval(ms){if(REFRESH_MS===ms)return;REFRESH_MS=ms;if(autoRefreshTimer)startAutoRefresh();}

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
  if (tab === 'history') renderOpsHistory(currentOpsClientId);
  else if (tab === 'documents') renderOpsDocuments(currentOpsClientId);
  else if (tab === 'api') renderOpsApi(currentOpsClientId);
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
        h += '<button class="btn btn-sm" data-on-click="_opsApiDays=' + n + ';renderOpsApi(\'' + clientId + '\')" style="padding:3px 10px;font-size:11px;' + (active ? 'background:var(--accent);color:#fff' : 'background:var(--bg-3);color:var(--text-1)') + '">' + n + 'д</button>';
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
      // Backend returns newest-first; each entry carries ledgerDbId = stable
      // id строки billing_ledger. A4: физическое удаление запрещено — платежи
      // сторнируются через DELETE /payment/by-ledger/:ledgerDbId.
      entries.sort(function(a, b) { return (b.timestamp || b.date || '').localeCompare(a.timestamp || a.date || ''); });
      var client = (currentData.clients || []).find(function(x) { return x.id === clientId; });
      var bal = client ? (client.balance !== undefined ? client.balance : 0) : 0;
      var balColor = bal >= 0 ? 'var(--success)' : 'var(--danger)';
      var h = '<div style="display:flex;gap:12px;align-items:stretch;margin-bottom:12px;flex-wrap:wrap">';
      h += '<div style="flex:1 1 260px;min-width:0;padding:12px 14px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">';
      h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Сумма</label><input class="form-input" type="number" id="opsPayAmount" placeholder="5000" style="width:100px;font-size:12px;padding:4px 8px"></div>';
      h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Дата</label><input class="form-input" type="date" id="opsPayDate" value="' + new Date().toISOString().slice(0, 10) + '" style="width:130px;font-size:12px;padding:4px 8px"></div>';
      h += '<div style="flex:1;min-width:100px"><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Комментарий</label><input class="form-input" id="opsPayNote" placeholder="Пополнение" style="width:100%;font-size:12px;padding:4px 8px"></div>';
      h += '<button class="btn btn-success btn-sm" data-on-click="addPaymentFromModal(\'' + clientId + '\')" style="white-space:nowrap;padding:4px 12px">+ Пополнить</button>';
      h += '<button class="btn btn-sm" data-on-click="manualChargeFromModal(\'' + clientId + '\')" style="white-space:nowrap;padding:4px 12px;background:var(--danger);color:#fff">− Списать</button>';
      // WP6: ручная выплата партнёрской комиссии деньгами (Р28) — ledger payout.
      var refBal = client ? (client.referral_balance || 0) : 0;
      if (refBal > 0) {
        h += '<button class="btn btn-sm" data-on-click="payoutReferral(\'' + clientId + '\',' + refBal + ')" style="white-space:nowrap;padding:4px 12px" title="Выплата деньгами оператором — комиссия спишется, баланс клиента не изменится">Партнёрка: ' + Math.round(refBal) + ' ₽ → выплатить</button>';
      }
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
      var _segBtn = function(mode, label){ return '<button class="btn btn-sm" style="font-size:11px;padding:2px 10px;'+(_segModeNow===mode?'background:var(--accent);color:#fff':'')+'" data-on-click="setOpsSegMode(\''+mode+'\',\''+clientId+'\')">'+label+'</button>'; };
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
        else if (e.type === 'bank_payment') { typeLabel = icon('bank',11)+' \u0411\u0430\u043D\u043A'; typeColor = 'color:#6366f1'; amountStr = '+' + (e.amount || 0).toFixed(2) + ' \u20BD'; amountColor = 'color:var(--success)'; }
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
        // A4: удалять операции нельзя. Сторнировать можно только платежи
        // (payment/bank_payment) — создаётся payment_reversal с откатом
        // баланса и реферальной комиссии. Списания/корректировки правятся
        // новой корректировкой (кнопка «− Списать» / balance_adjust).
        var _reverseBtn = '';
        if ((e.type === 'payment' || e.type === 'bank_payment') && e.ledgerDbId) {
          _reverseBtn = '<button class="btn btn-sm" style="font-size:9px;padding:1px 4px;background:transparent;color:var(--warning);border:1px solid var(--warning)" data-on-click="reverseLedgerPayment(\'' + clientId + '\',' + e.ledgerDbId + ')" title="\u0421\u0442\u043E\u0440\u043D\u0438\u0440\u043E\u0432\u0430\u0442\u044C">\u21A9</button>';
        }
        h += '<td style="padding:6px 10px;text-align:center">' + _reverseBtn + '</td>';
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
  area.innerHTML='<div class="detail-card" style="margin-top:8px"><h4>Изменить доступы порта: '+esc(portId)+'</h4><div class="form-row"><div class="form-group"><label>Логин</label><input class="form-input" id="editPortLogin" value="'+esc(currentLogin)+'"></div><div class="form-group"><label>Пароль</label><input class="form-input" id="editPortPass" value="'+esc(currentPass)+'"></div></div><div style="display:flex;gap:4px;margin-top:6px"><button class="btn btn-primary btn-sm" data-on-click="savePortCreds(\''+imei+'\',\''+server+'\',\''+portId+'\')">Сохранить</button><button class="btn btn-sm" data-on-click="document.getElementById(\'editPortForm\').innerHTML=\'\'">Отмена</button></div></div>';
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
    var h='<div class="detail-card" style="margin-top:8px"><h4 style="margin-bottom:12px">'+icon('gear',14)+' Настройки порта: '+esc(portId)+'</h4>';
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
    h+='<div style="display:flex;gap:6px;margin-top:12px"><button class="btn btn-primary btn-sm" data-on-click="savePortFull(\''+esc(imei)+'\',\''+esc(server)+'\',\''+esc(portId)+'\')">Сохранить</button><button class="btn btn-sm" data-on-click="document.getElementById(\'editPortForm\').innerHTML=\'\'">Отмена</button></div>';
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
    if(r.ok){showToast('Настройки порта сохранены','success');document.getElementById('editPortForm').innerHTML='';setTimeout(loadData,2000)}
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
      currentData=data;processData();renderServerFilter();renderClientFilterDD();renderTable();updateHeaderStats();
      generateNotifications();
      document.getElementById('lastUpdate').textContent=new Date().toLocaleTimeString('ru-RU');
      var _st=localStorage.getItem('admin_active_tab')||'dashboard';var _te=document.querySelector('.nav-tab[data-on-click*="\''+_st+'\'"]');if(_te)switchMainTab(_st,_te);
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
    html += '<tr style="background:var(--bg-2)"><td colspan="7" style="font-size:10px;font-weight:700;color:var(--text-2);padding:4px 8px">'+esc(_serverDisplayLabel(srv))+' ('+arr.length+')</td></tr>';
    arr.forEach(function(m){
      var key = m.server+'|'+m.nick;
      var inProfile = !!_simState.selectedModems[key];
      if(m.in_pool) poolCount++;
      if(inProfile) profileCount++;
      var disProfile = m.in_pool ? '' : 'disabled';
      var ghostStyle = m._ghost ? 'opacity:.55' : '';
      html += '<tr style="'+ghostStyle+'">'+
        '<td style="text-align:center"><input type="checkbox" '+(m.in_pool?'checked':'')+' data-on-change="simTogglePool(\''+esc(m.server)+'\',\''+esc(m.nick)+'\',this)"></td>'+
        '<td style="text-align:center"><input type="checkbox" '+(inProfile?'checked':'')+' '+disProfile+' data-on-change="simToggleSelect(\''+esc(m.server)+'\',\''+esc(m.nick)+'\',this.checked)" title="'+(m.in_pool?'':'Сначала добавьте в пул')+'"></td>'+
        '<td><strong>'+esc(m.nick)+'</strong>'+(m._ghost?' <span style="font-size:9px;color:var(--text-3)">(ghost)</span>':'')+'</td>'+
        '<td><span style="font-size:10px;color:var(--text-2)">'+esc(_serverDisplayLabel(m.server))+'</span></td>'+
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
      '<select data-on-change="_simState.urls['+i+'].method=this.value" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
        ['GET','POST','HEAD'].map(function(m){return '<option value="'+m+'"'+(u.method===m?' selected':'')+'>'+m+'</option>'}).join('')+
      '</select>'+
      '<input type="text" placeholder="https://..." value="'+esc(u.url||'')+'" data-on-input="_simState.urls['+i+'].url=this.value" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
      '<input type="number" class="w" min="1" max="100" value="'+(u.weight||1)+'" data-on-input="_simState.urls['+i+'].weight=parseInt(this.value)||1" title="Вес" style="padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);font-size:11px">'+
      (_simState.urls.length>1?'<button class="btn btn-sm" data-on-click="simRemoveUrlRow('+i+')" style="font-size:10px;padding:2px 6px">'+icon('x',10)+'</button>':'')+
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
        document.getElementById('simStartStatus').innerHTML = icon('x',12) + ' ' + esc(o.d.error || 'ошибка');
        if(o.d.missing) document.getElementById('simStartStatus').insertAdjacentHTML('beforeend', ' · ' + esc(o.d.missing.join(', ')));
        return;
      }
      document.getElementById('simStartStatus').innerHTML = icon('check',12) + ' Запущен run #' + esc(String(o.d.run_id));
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
      // D11: показываем баннер «выключено», когда simulator_enabled=false
      var banner=document.getElementById('simDisabledBanner');
      if(banner)banner.style.display=(d&&d.enabled===false)?'':'none';
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
        document.getElementById('simHeaderState').innerHTML = icon('check',12) + ' Run #'+runId+' завершён: ' + esc(msg.reason||'');
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
        bp.innerHTML = icon('fire',12) + ' <strong>Breaking-point найден:</strong> ' + d.breaking_point.workers + ' воркеров на t='+d.breaking_point.t_sec+'с — таймаут '+d.breaking_point.timeout_pct+'%, P95 '+d.breaking_point.p95_ms+' мс (база '+d.breaking_point.base_p95_ms+' мс).';
      } else if(d.applicable) {
        bp.style.display = '';
        bp.innerHTML = icon('check',12) + ' Breaking-point не найден в этом ramp-прогоне (нагрузка стабильна).';
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
    return '<tr><td><strong>'+esc(m.modem_nick)+'</strong> <span style="font-size:9px;color:var(--text-3)">'+esc(_serverDisplayLabel(m.server_name))+'</span></td>'+
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
  document.getElementById('simHeaderState').innerHTML = icon('pause',11) + ' Бездействует';
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
        return '<tr style="cursor:pointer" data-on-click="if(event.target.tagName!==\'INPUT\')simOpenRunDetail('+r.id+')">'+
          '<td data-on-click="event.stopPropagation()"><input type="checkbox" '+checked+' data-on-change="simToggleHistSel('+r.id+',this.checked)"></td>'+
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
      bpHtml = '<div style="padding:10px 14px;border-radius:8px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);margin-bottom:12px;font-size:12px">'+icon('fire',12)+' <strong>Breaking-point:</strong> '+bp.breaking_point.workers+' воркеров на t='+bp.breaking_point.t_sec+'с — таймаут '+bp.breaking_point.timeout_pct+'%, P95 '+bp.breaking_point.p95_ms+' мс (база '+bp.breaking_point.base_p95_ms+' мс).</div>';
    } else if(bp.applicable){
      bpHtml = '<div style="padding:10px 14px;border-radius:8px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);margin-bottom:12px;font-size:12px">'+icon('check',12)+' Breaking-point не найден — модемы выдержали полную ramp-нагрузку.</div>';
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
// Modem status helpers + dynamic operator list and operator-country settings.

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

// ── 4) Dynamic operator list — replaces hardcoded _heatmapConfig.operator ──
// Called once at boot from the existing init flow (see admin.html); also
// re-callable whenever the operators settings card mutates the mapping.
function refreshOperatorList() {
  return api(API+'/api/admin/operators')
    .then(function(d){
      var ops = (d && d.operators) || [];
      // Keep only operators with at least 1 modem currently using them, sort
      // by usage descending, and convert into the {id, label, modems} shape.
      var list = ops
        .filter(function(o){ return (o.modem_count || 0) > 0; })
        .sort(function(a,b){ return b.modem_count - a.modem_count; })
        .map(function(o){
          // Чипы хитмапы (analytics.js) всё равно вырезают флаги из label — храним чистое имя.
          var label = (o.operator || o.operator_normalized);
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
      var dl=document.getElementById('opCanonicalOptions');
      if(dl)dl.innerHTML=ops.map(function(o){return '<option value="'+esc(o.operator||o.operator_normalized)+'"></option>';}).join('');
      var h = '<table style="width:100%;border-collapse:collapse;font-size:12px">';
      h += '<thead><tr style="color:var(--text-3);font-size:10px;text-transform:uppercase;letter-spacing:.05em"><th style="text-align:left;padding:8px 6px">Оператор</th><th style="text-align:left;padding:8px 6px">Алиасы</th><th style="text-align:left;padding:8px 6px">Страна</th><th style="text-align:left;padding:8px 6px">Источник</th><th style="text-align:right;padding:8px 6px">Модемов</th><th style="padding:8px 6px"></th></tr></thead><tbody>';
      ops.forEach(function(o){
        var srcBadge = o.source === 'manual'
          ? '<span style="background:rgba(99,102,241,.15);color:var(--accent);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">вручную</span>'
          : o.source === 'auto'
            ? '<span style="background:rgba(52,199,89,.12);color:var(--green);padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">авто</span>'
            : '<span style="color:var(--text-3);font-size:10px">—</span>';
        var FLAGS = { RO: flagIcon('RO'), MD: flagIcon('MD'), RU: flagIcon('RU') };
        var country = o.country || '';
        var flag = FLAGS[country] || '';
        h += '<tr>';
        h += '<td style="padding:8px 6px;color:var(--text-0)"><strong>'+esc(o.operator)+'</strong><div style="font-size:10px;color:var(--text-3);margin-top:2px">'+(o.servers || []).join(', ')+'</div></td>';
        h += '<td style="padding:8px 6px;max-width:260px">'+((o.aliases||[]).length?(o.aliases||[]).map(function(a){return '<span style="display:inline-flex;align-items:center;gap:3px;margin:1px 4px 1px 0;padding:2px 6px;border-radius:999px;background:var(--bg-3);color:var(--text-2)">'+esc(a)+' <button type="button" title="Удалить алиас" data-on-click="dropOperatorAlias(\''+encodeURIComponent(a)+'\')" style="border:0;background:none;color:var(--text-3);padding:0;cursor:pointer">×</button></span>';}).join(''):'<span style="color:var(--text-3)">—</span>')+'</td>';
        h += '<td style="padding:8px 6px">';
        h += '<select data-on-change="setOperatorCountry(\''+encodeURIComponent(o.operator_normalized)+'\', this.value)" style="background:var(--bg-2);border:1px solid var(--border);color:var(--text-1);padding:4px 8px;border-radius:6px;font-size:12px;cursor:pointer">';
        h += '<option value="" '+(!country?'selected':'')+'>— не задана —</option>';
        ['RO','MD','RU'].forEach(function(c){ h += '<option value="'+c+'" '+(country===c?'selected':'')+'>'+c+'</option>'; });
        h += '</select>';
        if (flag) h += ' <span style="font-size:14px;margin-left:6px">'+flag+'</span>';
        h += '</td>';
        h += '<td style="padding:8px 6px">'+srcBadge+'</td>';
        h += '<td style="text-align:right;padding:8px 6px;color:var(--text-0);font-weight:600">'+o.modem_count+'</td>';
        h += '<td style="text-align:right;padding:8px 6px">';
        if (o.source === 'manual') {
          h += '<button data-on-click="dropOperatorMapping(\''+encodeURIComponent(o.operator_normalized)+'\')" title="Снять ручной маппинг — следующий опрос восстановит \'auto\'" style="background:none;border:1px solid var(--border);color:var(--text-3);padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer">↺ авто</button>';
        }
        h += '</td></tr>';
      });
      h += '</tbody></table>';
      box.innerHTML = h;
    })
    .catch(function(e){ box.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>'; });
}
function mergeOperatorAlias(){
  var alias=(document.getElementById('opAliasInput').value||'').trim();
  var canonical=(document.getElementById('opCanonicalInput').value||'').trim();
  var st=document.getElementById('opAliasStatus');
  if(!alias||!canonical||alias.toLowerCase()===canonical.toLowerCase()){st.style.color='var(--danger)';st.textContent='Укажите два разных названия';return;}
  st.style.color='var(--warning)';st.textContent='Объединяю…';
  api(API+'/api/admin/operators/'+encodeURIComponent(alias)+'/alias',{method:'PUT',json:{canonical:canonical}})
    .then(function(d){
      if(!d.ok)throw new Error(d.error||'Ошибка');
      document.getElementById('opAliasInput').value='';document.getElementById('opCanonicalInput').value='';
      st.style.color='var(--success)';st.textContent='Объединено'+(d.rewritten?' · обновлено строк: '+d.rewritten:'');
      loadOperatorsMapping();refreshOperatorList();
    }).catch(function(e){st.style.color='var(--danger)';st.textContent=e.message;});
}
function dropOperatorAlias(aliasEnc){
  api(API+'/api/admin/operators/'+aliasEnc+'/alias',{method:'DELETE'})
    .then(function(){loadOperatorsMapping();refreshOperatorList();})
    .catch(function(e){showToast(e.message,'error');});
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
      + '<button data-on-click="deleteModem(\''+m.server+'\',\''+portIdRaw+'\',\''+esc(m.nick)+'\')" style="background:var(--danger);border:none;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">'+icon('trash',12)+' Удалить навсегда</button>';
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
    if(d.ok){ document.getElementById('testPoolToggleStatus').innerHTML = icon('check',12) + (enabled ? ' Добавлен' : ' Удалён'); }
    else { document.getElementById('testPoolToggleStatus').innerHTML = icon('x',12) + ' ' + esc(d.error||''); }
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
        critical: { label: iconDot('#e84141') + ' Критические', desc: 'Срабатывают мгновенно при серьёзных сбоях' },
        important: { label: iconDot('#FFCC00') + ' Важные',     desc: 'Заметные события с защитой от спама (cooldown)' },
        early: { label: iconDot('#3498db') + ' Превентивные',    desc: 'Раннее предупреждение, пока ещё не критично' },
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
          var chLabel = isBell ? icon('bell',10) + ' только в админке' : 'TG + ' + icon('bell',10);
          var testTitle = isBell ? 'Создать тестовую запись в колокольчике' : 'Отправить пример в Telegram';
          h += '<div style="display:flex;align-items:center;gap:12px;padding:11px 14px;'+sep+'">';
          h += '<div style="flex:1;min-width:0">';
          h += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span style="font-size:13px;font-weight:500;color:var(--text-0)">'+esc(r.title)+'</span>';
          h += '<span style="background:'+chBg+';color:'+chColor+';padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap">'+chLabel+'</span></div>';
          h += '<div style="font-size:10px;color:var(--text-3);margin-top:2px;font-family:var(--font-mono)">'+esc(r.id)+' · повтор не чаще '+_cdLabel(r.cooldownSec)+'</div>';
          h += '</div>';
          h += '<button class="btn btn-sm" style="font-size:11px;padding:4px 10px;flex-shrink:0" data-on-click="testAlertRule(\''+esc(r.id)+'\')" title="'+testTitle+'">'+icon('upload',11)+' Тест</button>';
          h += '<label class="tgl"><input type="checkbox" '+(r.enabled?'checked':'')+' data-on-change="toggleAlertRule(\''+esc(r.id)+'\', this.checked)"><span></span></label>';
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
      showToast((d&&d.note)||'Тест выполнен', d&&d.ok?'success':'warning');
    })
    .catch(function(e){ showToast('Сеть: '+e.message, 'error'); });
}

// ========================================================================
// Stage 18.23 — ⚡ NEW (unified analytics view)
// ========================================================================
// Lives parallel to the existing 3 sub-tabs (Трафик/Инфра/Доходность).
// Same render functions where they accept target IDs (renderSys*); for the
// heatmap / clients / daily / matrix / top hosts blocks we
// write thin parallel renderers that hit the same endpoints. After UX
// validation this view will replace the three legacy tabs.
// ── персист UI-состояния дашборда: раскрывашки + вкладки/фильтры виджетов ──
var _dashUi=(function(){try{return JSON.parse(localStorage.getItem('dash_ui_state')||'{}')}catch(e){return {}}})();
function _dashUiSave(patch){try{Object.keys(patch).forEach(function(k){_dashUi[k]=patch[k]});localStorage.setItem('dash_ui_state',JSON.stringify(_dashUi))}catch(e){}}
var _newHmView=_dashUi.hmView||'country', _newHmId=_dashUi.hmId||'all';
var _newHmData=null;
var _newDailyChart=null;

// ⚡ «Командный центр» — decision-first unified analytics view.
// Order = urgency: Пульс → Требует внимания → Финансы → Парк → Трафик.
// Always-visible: pulse, action-center, finance summary+flow, fleet servers,
// heatmap, daily, traffic-clients. Lazy (<details>): per-client P&L, reconciliation,
// infra (rotations/IP/capacity), top hosts, traffic matrix.
function renderAccNew(){
  if(!currentData){return;}
  var d = collectTrafficData();
  if(!d){return;}
  window._newReconLoaded = false;          // re-arm reconciliation chip on each (re)render
  var _ua = document.getElementById('dashUpdatedAt');
  if(_ua){ var _n=new Date(); _ua.textContent='обновлено '+String(_n.getHours()).padStart(2,'0')+':'+String(_n.getMinutes()).padStart(2,'0'); }
  try{ renderNewExtWidgets(); }catch(e){}  // плитки «Требует внимания»
  renderNewFleetServers();                 // instant — детальные карточки серверов
  renderNewClientTable(d);                 // traffic table (Трафик section)
  loadNewFinance();                        // → pulse + finance quality/trend + финсводка
  loadNewHeatmap();
  loadNewDailyChart();                      // потребление по дням (60д, по клиентам/странам)
  try{ loadSpeedMonitor(); }catch(e){}       // почасовая скорость модемов (SpeedMonitor)
  try{ loadServerMetrics(); }catch(e){}      // загрузка серверов (ServerMetrics: SSH + /system_status)
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
    document.querySelectorAll('#tab-dashboard [data-on-click^="setNewInfraDays("]').forEach(function(c){c.classList.toggle('on',c.getAttribute('data-on-click').indexOf('setNewInfraDays('+_NEW_INFRA_DAYS+',')===0);});
  }
  // Секции, раскрытые по умолчанию (open в разметке), не получают событие toggle —
  // подгружаем их содержимое один раз здесь.
  document.querySelectorAll('#tab-dashboard details.acc-expand[open]').forEach(function(el){
    if(el.dataset.loaded === '1') return;
    el.dataset.loaded = '1';
    var s = el.dataset.section;
    if(s === 'infra'){ reloadNewInfra(); }
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
  if(section === 'infra'){ reloadNewInfra(); }
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
        chips += '<button class="qf-chip'+(on?' active':'')+'" data-on-click="setApiAccessType(\''+t+'\')">'+_apiTypeLabel(t)+'</button>';
      });
      var opts = [[1,'1 час'],[24,'24 часа'],[168,'7 дней'],[720,'30 дней']];
      var hoursSel = '<select class="form-input" style="font-size:11px;padding:4px 8px;width:auto" data-on-change="setApiAccessHours(parseInt(this.value))">'
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
      // Раскрытие/сворачивание полного списка — как «+ ещё» в «Топ доменов»,
      // плюс обратная кнопка «Свернуть» (zLess), чтобы вернуться к 12 строкам.
      if(_totalRows > 12){
        var _apiOpened = window._zxOpen && window._zxOpen.api;
        if(_apiOpened){
          h += '<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:6px 2px 0" data-on-click="zLess(\'api\')">Свернуть к 12 строкам</div>';
        } else {
          h += '<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:6px 2px 0" data-on-click="zMore(\'api\')">+ ещё ' + (_totalRows - 12) + '</div>';
        }
      }
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
      // A9: факт за 30д — revenue_30d_fact (канон metrics.revenue_30d); s.mrr — fallback для старых payload'ов.
      _ncPulseCard('Выручка 30д (факт)', _fmtRub(s.revenue_30d_fact!=null?s.revenue_30d_fact:s.mrr), growthSub, 'accent') +
      _ncPulseCard('На балансах', _fmtRub(cashFloat), '<span style="color:var(--text-3)">предоплата клиентов</span>', 'success');
  }
  // Финсводка-виджет (верхний ряд, бывший слот «Ресурсы») — выручка 30д / NRR / прирост M/M / на балансах.
  // NB: #newFinSummaryBody в текущей разметке отсутствует — блок не рендерится;
  // экономика живёт в «Качество выручки» (прибыль/маржа/затраты, 2026-08-04).
  var fsEl=document.getElementById('newFinSummaryBody');
  if(fsEl){
    function _fsRow(l,v,c,last){return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px'+(last?'':';border-bottom:1px solid var(--border)')+'"><span style="color:var(--text-2)">'+l+'</span><span style="font-weight:600'+(c?';color:'+c:'')+'">'+v+'</span></div>';}
    fsEl.innerHTML =
      _fsRow('Выручка 30д (факт)', _fmtRub(s.revenue_30d_fact!=null?s.revenue_30d_fact:s.mrr), 'var(--text-0)') +
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
  var issues = _collectProxyProblemItems(currentData._modemMap||{}).length;
  var debtors = clients.filter(function(c){return (c.balance||0) < -10;});
  var debtSum = debtors.reduce(function(a,c){return a+(c.balance||0);},0);
  var paused = clients.filter(function(c){return c.paused;}).length;
  var allOk = !disc && !issues && !debtors.length && !paused;
  var h = '<div class="analytics-card" style="margin-bottom:18px">';
  h += '<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px">'+icon('alert',12)+' Требует внимания'+(allOk?' <span style="color:var(--success);font-weight:500;font-size:11px">· всё спокойно</span>':'')+'</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px">';
  h += _ncStatRow(icon('off',11) + ' Модемов отключено >'+(window._offlineThresholdMin||10)+'м', disc, null, 'danger');
  h += _ncStatRow(icon('snail',11) + ' Сбоит прокси', issues, null, 'warn');
  h += _ncStatRow(icon('money',11) + ' Клиентов в долгу', debtors.length, debtors.length?_fmtRub(debtSum):null, 'danger');
  h += _ncStatRow(icon('pause',11) + ' На паузе', paused, null, 'warn');
  h += '<div id="newReconChip"></div>';   // filled async by loadNewReconciliation
  h += '</div></div>';
  el.innerHTML = h;
}

// ── 4a. Парк по серверам — Трафик «.widget» style ──────────────────
function _ncServerCard(name, working, total, disc, primary){
  working = working||0; total = total||0; disc = disc||0;
  if(total<working) total=working;
  var col = disc===0 ? 'var(--success)' : 'var(--warning)';
  var sub = disc>0 ? '<span style="color:var(--danger)">'+icon('alert',11)+' '+disc+' отключено</span>' : 'все на связи';
  return '<div class="widget">' +
    '<div class="widget-label">'+esc(name)+'</div>' +
    '<div class="widget-value" style="color:'+col+'">'+working+'<span style="font-size:13px;color:var(--text-3)">/'+total+'</span></div>' +
    '<div class="widget-sub">'+sub+'</div>' +
    '</div>';
}

function openServerOverviewSection(section){
  var tab=null;
  document.querySelectorAll('.nav-tab').forEach(function(el){
    if((el.getAttribute('data-on-click')||'').indexOf("switchMainTab('analytics'")===0) tab=el;
  });
  if(tab) switchMainTab('analytics',tab);
  setTimeout(function(){ switchSettingsSection(section); },80);
}

// Единая характеристика «Сбоит прокси» для дашборда. В список попадает
// только действующий клиентский прокси, который сейчас не относится к
// отдельным категориям «Модем отключён», «Низкая скорость» или «Завис IP».
// Один неудачный ping/HTTP-замер не считается проблемой: нужны устойчивые
// потери/три ping-провала, два HTTP-провала либо явное состояние ProxySmart.
function _collectProxyProblemItems(modemMap){
  var mm=modemMap||{}, out=[];
  var sustained={};
  (currentData.proxyIssues||[]).forEach(function(it){
    sustained[String(it.server||'')+'|'+String(it.nick||'')]=it;
  });
  Object.keys(mm).forEach(function(k){
    var m=mm[k]; if(!m)return;
    var status=getModemStatus(m);
    if(status==='offline'||status==='rotating'||status==='rebooting')return;
    if(typeof _hasActiveClient==='function'&&!_hasActiveClient(m))return;
    if(m.lowSpeed||m.ipStuck)return;

    var reasons=[],severity=3;
    if(m.webappDown){reasons.push('ProxySmart WebApp недоступен');severity=5;}
    var sim=String(m.simStatus||'').toUpperCase();
    if(sim&&sim!=='UNKNOWN'&&!/\bOK\b|READY/.test(sim)){reasons.push('SIM: '+(sim==='MODEM_SIM_UNDETECTED'?'не определена':sim.toLowerCase()));severity=5;}
    if(m.httpRedirect){reasons.push('редирект оператора — SIM без денег или заблокирована');severity=5;}
    if(m.connDead){reasons.push('разрыв соединения модема');severity=Math.max(severity,4);}

    var id=String(m.server||'')+'|'+String(m.nick||'');
    var ping=(currentData.modemPing||{})[m.server+'_'+m.nick];
    var hist=sustained[id];
    if(hist&&(!ping||ping.fresh!==false)){
      reasons.push('пинг: '+(hist.detail||('потери '+hist.errorPct+'%')));
      severity=Math.max(severity,4);
    }else if(ping&&ping.fresh!==false&&(m.pcConsecFails||0)>=3){
      reasons.push('пинг: '+m.pcConsecFails+' провала подряд');
      severity=Math.max(severity,4);
    }

    var hc=(currentData.modemHttpCheck||{})[m.server+'_'+m.nick];
    var hcAge=hc&&hc.ts?Date.now()-Date.parse(hc.ts):Infinity;
    if(hc&&hc.failing===true&&hcAge<=30*60000){
      reasons.push('HTTP: '+(hc.error||('status '+(hc.status||'—'))));
      severity=Math.max(severity,4);
    }
    if(!reasons.length)return;
    out.push({
      nick:m.nick,server:m.server,imei:m.rawImei||'',
      detail:reasons.join(' · '),severity:severity
    });
  });
  out.sort(function(a,b){return b.severity-a.severity||String(a.nick).localeCompare(String(b.nick),undefined,{numeric:true});});
  return out;
}

function renderNewFleetServers(){
  var el = document.getElementById('newFleetServers'); if(!el) return;
  var fleet = currentData.fleet || {};
  var bs = fleet.byServer || {};
  var names = Object.keys(bs).sort();
  if(!names.length){ el.innerHTML = '<div style="color:var(--text-3);font-size:12px">Нет данных о парке</div>'; return; }
  var mm = currentData._modemMap || {};
  var proxyProblems=_collectProxyProblemItems(mm),problemByServer={};
  proxyProblems.forEach(function(it){problemByServer[it.server]=(problemByServer[it.server]||0)+1;});
  var agg = {};
  Object.keys(mm).forEach(function(k){ var m=mm[k]; var srv=m.server; if(!agg[srv]) agg[srv]={sig:0,sigN:0,prob:0,off:0,today:0,mon:0};
    var st=getModemStatus(m);
    if(st==='offline') agg[srv].off++;
    agg[srv].prob=problemByServer[srv]||0;
    var sig=Number(m.signal)||0; if(sig>0){ agg[srv].sig+=sig; agg[srv].sigN++; }
    (m.ports||[]).forEach(function(p){ var w=p._bw||{}; agg[srv].today+=parseTraffic(w.bandwidth_bytes_day_in)+parseTraffic(w.bandwidth_bytes_day_out); agg[srv].mon+=parseTraffic(w.bandwidth_bytes_month_in)+parseTraffic(w.bandwidth_bytes_month_out); });
  });
  function fcard(srv, primary){
    var b = primary ? {working:fleet.working,total:fleet.total,disconnected:fleet.disconnected} : (bs[srv]||{});
    var working=b.working||0, total=b.total||0, disc=b.disconnected||0; if(total<working) total=working;
    var onlPct = total ? Math.round(working/total*100) : 0;
    var ci = primary ? {} : (COUNTRIES[srv]||{});
    var col = disc===0 ? 'var(--success)' : 'var(--warning)';
    var today=0,mon=0,prob=0,sigAvg=0;
    if(primary){ Object.keys(agg).forEach(function(s){ today+=agg[s].today; mon+=agg[s].mon; prob+=agg[s].prob; }); }
    else { var a=agg[srv]||{sig:0,sigN:0,prob:0,today:0,mon:0}; today=a.today; mon=a.mon; prob=a.prob; sigAvg=a.sigN?Math.round(a.sig/a.sigN):0; }
    // Трафик из собственного учёта (бекенд, traffic_hourly/daily_traffic) —
    // устойчив к обнулению счётчиков бокса при рестарте ProxySmart (23.08).
    // Живые счётчики (agg) — fallback, если бэкенд-суммы не пришли.
    if(primary){
      if(typeof fleet.todayBytes==='number') today=fleet.todayBytes;
      if(typeof fleet.monthBytes==='number') mon=fleet.monthBytes;
    } else {
      var fb2=bs[srv]||{};
      if(typeof fb2.todayBytes==='number') today=fb2.todayBytes;
      if(typeof fb2.monthBytes==='number') mon=fb2.monthBytes;
    }
    var met=null, addr='';
    if(!primary && window._srvMetData){
      met = ((window._srvMetData.metrics||{})[srv])||null;
      addr = (window._srvMetData.addresses||{})[srv]||'';
    }
    if(primary){
      var h='<div class="analytics-card" style="margin:0;padding:14px;grid-column:1/-1">';
      h+='<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px">'
        +'<span style="font-weight:700;font-size:13px;font-family:var(--font-mono)">'+_dwIcon('sat')+'Весь парк</span>'
        +'<span style="text-align:right;flex-shrink:0"><span style="font-size:18px;font-weight:700;color:'+col+';font-family:var(--font-mono)">'+working+'<span style="font-size:12px;color:var(--text-3)">/'+total+'</span></span>'
        +'<span style="display:block;font-size:9px;color:var(--text-3)">'+(disc>0?disc+' отключено':'Модемы')+'</span></span></div>';
      h+='<div style="height:5px;background:var(--bg-3);border-radius:3px;overflow:hidden;margin-bottom:11px" title="'+onlPct+'% в работе"><div style="height:100%;width:'+onlPct+'%;background:'+col+';border-radius:3px"></div></div>';
      h+='<div style="display:flex;flex-wrap:wrap;gap:4px 22px;font-size:11px">';
      h+='<div style="display:flex;gap:6px"><span style="color:var(--text-2)">Трафик сегодня</span><span style="font-family:var(--font-mono)">'+fmtGb(today)+'</span></div>';
      h+='<div style="display:flex;gap:6px"><span style="color:var(--text-2)">Трафик месяц</span><span style="font-family:var(--font-mono);font-weight:600">'+fmtGb(mon)+'</span></div>';
      h+='<div style="display:flex;gap:6px"><span style="color:var(--text-2)">Сбоит прокси</span><span style="color:'+(prob>0?'var(--warning)':'var(--text-3)')+';font-weight:600">'+prob+'</span></div>';
      h+='</div></div>';
      return h;
    }
    addr=addr||ci.address||'';
    var flag=(typeof flagIcon==='function'&&ci.country)?flagIcon(ci.country,32):(ci.flag||'');
    var isDown=!!(met&&met.error);   // ssh+http failed → вся карточка красная
    var h='<article class="server-overview-card'+(isDown?' server-overview-card--down':'')+'" data-srv-spark="'+esc(srv)+'">';
    h+='<header class="server-overview-header">'
      +'<div class="server-overview-identity"><span class="server-overview-flag">'+flag+'</span><span class="server-overview-heading">'
      +'<span class="server-overview-title">'+esc(ci.displayName||srv)+(ci.name?' <span class="server-overview-bullet">•</span> '+esc(ci.name):'')+'</span>'
      +(addr?'<span class="server-overview-address">'+esc(addr)+'</span>':'')+'</span></div>'
      +'<div class="server-overview-services"><span class="server-overview-services-value" style="color:'+(isDown?'var(--danger)':col)+'">'+working+'/'+total+'</span>'
      +'<span class="server-overview-services-label">'+(isDown?'Бокс недоступен':(disc>0?disc+' отключено':'Модемы'))+'</span></div>'
      +'</header>';
    // B3 (23.08): бейдж «🔧 Обслуживание до HH:MM» при активном окне (данные —
    // maintenance.active из /api/admin/data).
    var _mw=((currentData.maintenance||{}).active||[]).filter(function(w){return w.target_type==='server'&&w.target_id===srv;})[0];
    if(_mw){var _mtd=new Date(_mw.to_ts);
      h+='<div style="margin:2px 0 6px;font-size:11px;color:var(--warning)">🔧 Обслуживание до '+String(_mtd.getHours()).padStart(2,'0')+':'+String(_mtd.getMinutes()).padStart(2,'0')+(_mw.comment?' · '+esc(_mw.comment):'')+'</div>';}
    // Строка статуса: точка + текст (недоступность / отключённые / стабильно).
    var stDot='var(--success)', stTxt='Сервер работает стабильно';
    if(met&&met.error){ stDot='var(--danger)'; stTxt='Бокс недоступен: '+met.error; }
    else if(disc>0){ stDot='var(--warning)'; stTxt=disc+' отключено'; }
    else if(met&&met.anomalies&&met.anomalies.length){
      stDot='var(--warning)';
      stTxt='Отклонение от нормы: '+met.anomalies.map(function(a){return a.label||a.metric;}).join(', ');
    }
    if(met&&met.age_sec>20*60&&met.collected_at){ var dt=new Date(Date.parse(met.collected_at)); stTxt+=' · данные на '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0'); }
    h+='<div class="server-overview-status"><span class="server-overview-status-dot" style="background:'+stDot+'"></span>'+esc(stTxt)+'</div>';
    // Единая панель из трёх KPI с вертикальными разделителями, как в макете.
    function tile(ic,label,val,tone,title){
      return '<div class="server-summary-item server-summary-item--'+tone+'"'+(title?' title="'+esc(title)+'"':'')+'>'
        +'<span class="server-icon-box server-summary-icon">'+icon(ic,18)+'</span>'
        +'<span class="server-summary-copy"><span class="server-summary-label">'+esc(label)+'</span>'
        +'<span class="server-summary-value">'+esc(val)+'</span></span></div>';
    }
    h+='<div class="server-summary-strip">'
      +tile('traffic','Трафик сегодня',fmtGb(today),'green')
      +tile('signal','Средний сигнал',sigAvg?sigAvg+'/5':'—','green','Боксы отдают шкалу 0–5, не dBm')
      +tile('alert','Сбоит прокси',String(prob),prob>0?'warning':'muted')
      +'</div>';
    // Новый макет: два оперативных графика, затем флапание, системное событие
    // и общий нижний ряд аппаратных показателей (RAM/диск переехали вниз).
    if(met&&typeof srvMetRowV2==='function'){
      var a24=met.avg24||{}, s24=met.series24||{};
      // Ряды для ховер-тултипа: время + все метрики точки (21.08).
      if(s24&&s24.ts&&s24.ts.length) (window._srvFleetSeries=window._srvFleetSeries||{})[srv]={ts:s24.ts,cpu:s24.cpu,mem:s24.mem,conns:s24.conns};
      h+='<div class="server-metrics-list">';
      // Подпись CPU — реальная модель с бокса (SSH, поле cpu_model): «i3-10100 · 8 пот.»
      var cpuSub='Загрузка процессора';
      if(met.cpu_model){ var cm=String(met.cpu_model).replace(/\(R\)|\(TM\)|Intel|Core|CPU/gi,'').replace(/@.*$/,'').replace(/\s+/g,' ').trim(); if(cm) cpuSub=cm+(met.cpu_cores?' · '+met.cpu_cores+' пот.':''); }
      h+=srvMetRowV2('cpu','CPU',cpuSub,met.cpu_pct,null,a24.cpu_pct,s24.cpu);
      h+=srvMetRowV2('connections','Соединения','TCP-подключения',met.conns,null,a24.conns,s24.conns,{unit:'',integer:true,tone:'purple',relativeScale:true});
      h+='</div>';

      var down=met.downtime24||{episodes:0,duration_sec:0,events:[]};
      var hasFlaps=Number(down.episodes)>0;
      var ongoing=(down.events||[]).some(function(e){return e.ongoing;});
      var lastFlap=hasFlaps?_srvMetLastFlap(down):'';
      h+='<section class="server-flap-card'+(ongoing?' server-flap-card--danger':(hasFlaps?' server-flap-card--warning':''))+'">'
        +'<span class="server-icon-box server-flap-icon">'+icon('pulse',20)+'</span>'
        +'<span class="server-flap-copy"><b>'+(ongoing?'Сервер недоступен сейчас':'Флапание за 24 часа')+'</b><span class="server-flap-meta">'
        +'<span class="server-flap-count">'+esc(_srvMetEpisodeLabel(down.episodes))+'</span>'
        +'<strong>'+esc(_srvMetMinutes(down.duration_sec))+'</strong><span>недоступности</span>'
        +(hasFlaps?'<span class="server-flap-last">'+(ongoing?'Идёт':'Последний')+': '+esc(lastFlap)+'</span>':'')
        +'</span></span>'
        +_srvMetFlapTimeline(down,(window._srvMetData||{}).generated_at)
        +(hasFlaps?'<span class="server-flap-last-mobile">'+(ongoing?'Идёт':'Последний')+': '+esc(lastFlap)+'</span>':'')
        +'<button type="button" class="server-card-link server-card-link--warning" data-on-click="openServerOverviewSection(\'serverHealth\')">История <span class="server-card-arrow">→</span></button>'
        +'</section>';

      var ev=met.latest_event||null;
      var evStamp=ev&&ev.timestamp?_srvMetEventStamp(ev.timestamp):'';
      h+='<section class="server-event-card"><span class="server-event-icon">'+icon('info',22)+'</span>'
        +'<span class="server-event-copy"><span class="server-event-meta">Системное событие'
        +(ev&&ev.source?' <i>•</i> '+esc(ev.source):'')
        +(evStamp?' <span class="server-event-date-inline"><i>•</i> '+esc(evStamp)+'</span>':'')+'</span>'
        +'<b>'+(ev?esc(ev.message):'Новых событий нет')+'</b></span>'
        +(evStamp?'<span class="server-event-date">'+esc(evStamp)+'</span>':'')
        +'<button type="button" class="server-card-link" data-on-click="openServerOverviewSection(\'syslog\')"><span class="server-link-long">Открыть лог</span><span class="server-link-short">Лог</span> <span class="server-card-arrow">→</span></button></section>';

      function footerStat(mod,ic,val,label,extra){
        var info=extra?'<span class="server-footer-info" tabindex="0" role="img" aria-label="'+esc(label)+': '+esc(extra)+'" data-tip="'+esc(extra)+'">i</span>':'';
        return '<span class="server-footer-stat server-footer-stat--'+mod+'"><span class="server-footer-icon">'+icon(ic,18)+'</span>'
          +'<span class="server-footer-copy"><b>'+esc(val||'—')+'</b>'+(label?'<small>'+esc(label)+info+'</small>':info)+'</span></span>';
      }
      var up=typeof _srvMetUptime==='function'?_srvMetUptime(met.uptime_sec):'';
      var diskExtra=_srvMetGb(met.disk_used_mb,met.disk_total_mb);
      var diskFc=met.disk_forecast||null;
      if(diskFc&&diskFc.status==='growing'&&diskFc.days_left!=null){
        diskExtra=(diskExtra?diskExtra+' · ':'')+'прогноз: ~'+Math.max(0,Math.round(diskFc.days_left))+' д, до '+diskFc.full_date;
      }else if(diskFc&&diskFc.status==='stable'){
        diskExtra=(diskExtra?diskExtra+' · ':'')+'рост не подтверждён';
      }else if(diskFc&&diskFc.status==='insufficient_history'){
        diskExtra=(diskExtra?diskExtra+' · ':'')+'прогноз после накопления истории';
      }
      h+='<footer class="server-overview-footer">'
        +footerStat('temp','thermo',met.temp_c==null?'—':String(_fmtP(met.temp_c))+'°C','')
        +footerStat('uptime','clock',up||'—','')
        +footerStat('ram','ram',met.mem_used_pct==null?'—':_fmtP(met.mem_used_pct)+'%','RAM',_srvMetGb(met.mem_used_mb,met.mem_total_mb))
        +footerStat('disk','disk',met.disk_used_pct==null?'—':_fmtP(met.disk_used_pct)+'%','Диск',diskExtra)
        +'</footer>';
    } else {
      h+='<div class="server-overview-empty">Данных о загрузке ещё нет — джоба пишет раз в 10 мин</div>';
    }
    h+='</article>';
    return h;
  }
  var html = '';
  names.forEach(function(n){ html += fcard(n, false); });
  el.innerHTML = html;
}
// Ховер-тултип спарклайнов карточек серверов (21.08): при наведении на любой
// спарклайн карточки показываем время точки и значения CPU/RAM/conns в ней.
(function bindSrvSparkTip(){
  if(window._srvSparkTipBound) return; window._srvSparkTipBound=1;
  var tip=null;
  function ensureTip(){
    if(!tip){ tip=document.createElement('div'); tip.className='srv-spark-tip'; tip.style.display='none'; document.body.appendChild(tip); }
    return tip;
  }
  document.addEventListener('mousemove', function(e){
    var t=ensureTip();
    var svg=e.target&&e.target.closest?e.target.closest('.server-spark'):null;
    var card=svg&&svg.closest?svg.closest('[data-srv-spark]'):null;
    var d=card?(window._srvFleetSeries||{})[card.getAttribute('data-srv-spark')]:null;
    if(!d||!d.ts||!d.ts.length){ if(t.style.display!=='none') t.style.display='none'; return; }
    var r=svg.getBoundingClientRect();
    var frac=r.width?Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)):0;
    var i=Math.round(frac*(d.ts.length-1));
    var dt=new Date(d.ts[i]);
    var fv=function(v,u){ return v==null?'—':String(Math.round(v*10)/10).replace('.',',')+u; };
    t.innerHTML='<b>'+dt.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+'</b>'
      +'<span>CPU: '+fv(d.cpu&&d.cpu[i],' %')+'</span>'
      +'<span>RAM: '+fv(d.mem&&d.mem[i],' %')+'</span>'
      +'<span>Соединения: '+((d.conns&&d.conns[i])!=null?d.conns[i]:'—')+'</span>';
    t.style.display='flex';
    var tw=t.offsetWidth, th=t.offsetHeight;
    var x=e.clientX+14, y=e.clientY-th-10;
    if(x+tw>window.innerWidth-8) x=e.clientX-tw-14;
    if(y<8) y=e.clientY+16;
    t.style.left=x+'px'; t.style.top=y+'px';
  }, {passive:true});
})();
function _zxLim(key,cap){return (window._zxOpen&&window._zxOpen[key])?Infinity:cap;}
function zMore(key){(window._zxOpen=window._zxOpen||{})[key]=1;
  if(key==='sn')reloadNewInfra();
  else if(key==='mx')renderNewMatrix();
  else if(key==='api')loadNewApiAccess();
  else if(key==='hosts')loadNewTopHosts();}
// Обратное сворачивание к исходному капу после zMore.
function zLess(key){if(window._zxOpen)delete window._zxOpen[key];
  if(key==='sn')reloadNewInfra();
  else if(key==='mx')renderNewMatrix();
  else if(key==='api')loadNewApiAccess();
  else if(key==='hosts')loadNewTopHosts();}
// «Требует внимания» — одна карточка с плитками алертов (по макету):
// 4 инфра-плитки (кликабельные, открывают попап со списком) + 2 бизнес-плитки
// (долги с суммой, паузы). Тренд/Операторы живут в раскрывашке «Тренд и операторы».
function _dwIcon(n){var P={gear:'<circle cx="12" cy="12" r="3.2"/><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>',line:'<path d="M4 17l5-5 4 3 7-8"/>',ant:'<circle cx="12" cy="13" r="1"/><path d="M12 14v6"/><path d="M8.5 9.5a5 5 0 0 1 7 0"/><path d="M6 6.5a8.5 8.5 0 0 1 12 0"/>',sat:'<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><circle cx="6.5" cy="7.5" r=".4"/><circle cx="6.5" cy="16.5" r=".4"/>'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="flex-shrink:0;vertical-align:-3px;color:var(--accent);margin-right:6px">'+(P[n]||'')+'</svg>';}
function _dwT(t,ic){return '<div style="font-size:13px;font-weight:700;color:var(--text-0);margin-bottom:10px">'+_dwIcon(ic)+t+'</div>';}
function renderNewExtWidgets(){
  var el=document.getElementById('newExtWidgets'); if(!el) return;
  var d=collectTrafficData(); if(!d){ el.innerHTML=''; return; }
  var mm=currentData._modemMap||{};
  function _age(ms){if(!ms)return'';var a=Date.now()-ms;if(a<60000)return'только что';var m=Math.floor(a/60000);if(m<60)return m+' мин назад';if(m<1440)return Math.floor(m/60)+' ч назад';return Math.floor(m/1440)+' д назад';}
  var STALE_MS=((window._staleModemHours||12))*3600*1000;
  var flakyItems=_collectProxyProblemItems(mm),flakyKeys={};
  flakyItems.forEach(function(it){flakyKeys[it.server+'|'+it.nick]=true;});
  var rtOffline=[],rtLowSpeed=[],rtStuckIp=[];
  Object.values(mm).forEach(function(m){
    var st=getModemStatus(m);
    if(st==='offline'){var stale=!m.lastSeenMs||(Date.now()-m.lastSeenMs>STALE_MS);if(!stale){var ag=_age(m.lastSeenMs);rtOffline.push({nick:m.nick,server:m.server,detail:ag?'Отключён '+ag:'offline',lastSeenMs:m.lastSeenMs||0});}}
    var isFlaky=!!flakyKeys[m.server+'|'+m.nick];
    if(st!=='offline'&&!isFlaky&&m.lowSpeed)rtLowSpeed.push({nick:m.nick,server:m.server,detail:'↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Mbps'});
    if(st!=='offline'&&!isFlaky&&!m.lowSpeed&&m.ipStuck)rtStuckIp.push({nick:m.nick,server:m.server,detail:'IP не менялся '+m.ipSinceHours+'ч · '+(m.extIp||'')});
  });
  var _offSrc=(currentData.fleet&&(currentData.fleet.disconnectedList||currentData.fleet.offlineList))||null;
  if(Array.isArray(_offSrc)){rtOffline=_offSrc.map(function(o){var ag=o.lastOnline?_age(o.lastOnline):'';return{nick:o.nick,server:o.server,detail:ag?('Отключён '+ag):'offline',lastSeenMs:o.lastOnline||0};});}
  rtOffline.sort(function(a,b){return (Number(b.lastSeenMs)||0)-(Number(a.lastSeenMs)||0);});
  window._problemData={offline:rtOffline,speed:rtLowSpeed,ipstuck:rtStuckIp,flaky:flakyItems};
  function attTile(label,key,n,extra,dot){
    var bg=n===0?'var(--green-bg)':dot==='var(--danger)'?'var(--red-bg)':'var(--orange-bg)';
    var vc=n===0?'var(--success)':dot==='var(--danger)'?'var(--danger)':'var(--warning)';
    var click=(key&&n>0)?' data-on-click="showProblemPopup(\''+esc(label)+'\',\''+key+'\')"':'';
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
  // Выручка по месяцам (тренд-факт + run-rate прогноз столбцом в графике) — между «Потреблением трафика» и «Операторами».
  var mrrCard='<div class="analytics-card" style="margin:0;display:flex;flex-direction:column">'
    +'<div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:8px">'
    +'<span style="font-size:12px;font-weight:600;color:var(--text-0);white-space:nowrap">'+icon('trend',12)+' Выручка</span>'
    +'<span style="display:flex;gap:8px;font-size:9px;font-weight:600;color:var(--text-2);align-items:center"><span id="mrrLegend" style="display:flex;gap:8px"></span>'
    +'<span class="mrr-fb" style="position:relative;display:inline-flex">'
    +'<span data-on-click="toggleMrrFormula(this)" style="cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:0 7px;font-size:9px;color:var(--text-2);font-weight:500">Формула</span>'
    +'<span class="mrr-fp" style="display:none;position:absolute;top:18px;right:0;z-index:60;background:var(--bg-1);border:1px solid var(--border);border-radius:8px;padding:9px 11px;width:290px;font-size:10px;font-weight:400;color:var(--text-1);box-shadow:var(--card-shadow);line-height:1.55">'
    +'<b>Выручка 30д (факт)</b> = списания + корректировки за скользящие 30 дн., без клиентов на паузе.<br>'
    +'<b>Прогноз месяца</b> = НЕ выручка, а ожидание при текущем темпе: Σ по клиентам — среднесуточное потребление за последние 7 дней × дней в месяце × тариф (per-GB); per-modem — цена × живые модемы.'
    +'</span></span></span></div>'
    +'<div style="flex:1;min-height:120px;position:relative"><canvas id="newFinTrendCanvas"></canvas><div id="mrrSkel" class="skel" style="position:absolute;inset:0"></div></div></div>';
  el.innerHTML=probCard+trendCard+mrrCard+opCard;
  // Пока финданные едут — столбцы-скелетон в карточке «Выручка» (Stage: скелетоны).
  var _mrrSkel = document.getElementById('mrrSkel');
  if(_mrrSkel && !window._newFinData) _mrrSkel.innerHTML = skelBars(12);
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
    var nrrTone = s.nrr_pct==null?'neutral':(s.nrr_pct>=100?'success':s.nrr_pct>=90?'warning':'danger');
    var churnTone = s.churn_rate_pct==null?'neutral':(s.churn_rate_pct>=5?'danger':'success');
    // 2026-08-04: порядок по решению оператора — Выручка, Расходы, Прибыль,
    // Маржинальность, дальше остальное; кнопка ввода затрат прямо в карточке.
    var _cost = s.total_cost||0, _rev30 = (s.revenue_30d_fact!=null?s.revenue_30d_fact:s.mrr)||0, _profit = _rev30-_cost;
    var _marginPct = _rev30>0 ? Math.round(_profit/_rev30*1000)/10 : null;
    function qtile(l,v,tone){ return '<div class="fin-quality-tile fin-quality-tile--'+(tone||'neutral')+'"><span class="fin-quality-label">'+l+'</span><span class="fin-quality-value">'+v+'</span></div>'; }
    function cbar(l,sub,pct,tone){
      pct=Number(pct)||0;
      return '<div class="fin-concentration-row"><div class="fin-concentration-meta"><span class="fin-concentration-label">'+l
        +(sub?' <span class="fin-concentration-client">'+sub+'</span>':'')+'</span><span class="fin-concentration-value">'+pct+'%</span></div>'
        +'<div class="fin-concentration-track"><div class="fin-concentration-fill fin-concentration-fill--'+(tone||'accent')+'" style="width:'+Math.min(Math.max(pct,0),100)+'%"></div></div></div>';
    }
    var hq = '<div class="fin-quality-head"><div class="fin-card-heading"><h3 class="fin-card-title">Качество выручки</h3>'
      +'<span class="fin-card-subtitle">Доходность, удержание и структура клиентов</span></div>'
      +'<button class="btn btn-sm fin-cost-btn" title="Ввести затраты месяца (себестоимость)" data-on-click="openFinanceCostsModal()">'+icon('gear',11)+' Затраты</button></div>';
    hq += '<div class="fin-quality-grid">';
    hq += qtile('Выручка 30д (факт)', _fmtRub(_rev30), 'accent');
    hq += qtile('Расходы (мес.)', _cost>0?_fmtRub(_cost):'—', 'neutral');
    hq += qtile('Прибыль 30д', _cost>0?_fmtRub(_profit):'—', _cost>0?(_profit>=0?'success':'danger'):'neutral');
    hq += qtile('Маржинальность', (_marginPct==null||!_cost)?'—':_marginPct+'%', (_marginPct!=null&&_cost)?(_marginPct>=50?'success':_marginPct>=25?'warning':'danger'):'neutral');
    hq += qtile('NRR · 3 мес', s.nrr_pct==null?'—':s.nrr_pct+'%', nrrTone);
    hq += qtile('Churn · мес', s.churn_rate_pct==null?'—':s.churn_rate_pct+'%', churnTone);
    hq += qtile('ARPU', _fmtRub(s.arpu), 'neutral');
    hq += qtile('Активных клиентов', String(s.active_clients||0), 'accent');
    hq += '</div>';
    hq += '<div class="fin-concentration"><div class="fin-concentration-title">Концентрация выручки</div>';
    hq += cbar('Top-1', con.top1_name?esc(con.top1_name):'', con.top1_pct, con.top1_pct>=50?'danger':con.top1_pct>=35?'warning':'accent');
    hq += cbar('Top-3', '', con.top3_pct, 'accent');
    hq += cbar('Top-5', '', con.top5_pct, 'success');
    hq += '</div>';
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
      panel(icon('plus',12) + ' Новые клиенты', 'var(--success)', '+'+nw.length, nwRows, 'нет новых в этом месяце') +
      panel(icon('minus',12) + ' Ушли (churned)', ch.length?'var(--danger)':'var(--success)', String(ch.length), chRows, icon('check',11) + ' никто не ушёл') +
      panel(icon('money',12) + ' Должники', debtors.length?'var(--danger)':'var(--success)', String(debtors.length), dbRows, icon('check',11) + ' все в плюсе');
  }
  // MRR перенесён в ряд «Требует внимания» (renderMrrChart), а в блоке Финансов
  // на его месте — «Выручка за 30 дней» + «Последние платежи» (renderFinRevenue).
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
  var h = '<table class="ztbl"><thead><tr><th>Клиент</th><th style="text-align:left">Тариф</th><th>Выручка 30д</th><th>Δ M/M</th><th>% выручки</th><th>Баланс</th></tr></thead><tbody>';
  rows.forEach(function(p){
    var pausedTag = p.paused?pauseBadge():'';
    // Флаги блокировки — из карточки клиента (per_client их не несёт).
    var _cl=(currentData.clients||[]).find(function(c){return c.name===p.name;});
    var blkTag = blockBadge(_cl);
    var deltaCol = p.mrr_delta_pct==null?'var(--text-3)':p.mrr_delta_pct>=0?'var(--success)':'var(--danger)';
    var deltaStr = p.mrr_delta_pct==null?'—':((p.mrr_delta_pct>0?'+':'')+p.mrr_delta_pct+'%');
    var tariffStr = p.billingType==='per_modem'?(p.price+'₽/мес·мод'):(p.price+'₽/ГБ');
    var balCol = p.balance<0?'var(--danger)':'var(--text-1)';
    h += '<tr>' +
      '<td style="font-weight:500;color:var(--text-1)">'+esc(p.name)+blkTag+pausedTag+'</td>' +
      '<td style="text-align:left;color:var(--text-2)">'+tariffStr+'</td>' +
      '<td style="font-weight:600;color:var(--text-1)">'+_fmtRub(p.mrr)+'</td>' +
      '<td style="color:'+deltaCol+'">'+deltaStr+'</td>' +
      '<td style="color:var(--text-1)">'+(p.share_pct!=null?p.share_pct+'%':'—')+'</td>' +
      '<td style="color:'+balCol+'">'+_fmtRub(p.balance)+'</td></tr>';
  });
  h += '</tbody></table>';
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
      if(chip) chip.innerHTML = _ncStatRow(icon('receipt',11) + ' Расхождений биллинга', probs.length, null, 'warn');
      if(!el) return;
      if(!probs.length){ el.innerHTML='<div style="color:var(--success);font-size:12px;padding:8px">'+icon('check',12)+' Расхождений нет — весь отданный трафик выставлен в счёт ('+clients.length+' клиентов проверено)</div>'; return; }
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
// Сегодня/Вчера по трафику + Тариф/Выручка 30д/Δ/доля/Баланс. Всё центрировано, равные отступы.
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
      balance: fin.balance!=null?fin.balance:(cl.balance||0), paused:fin.paused,
      blocked:!!cl.blocked, debtBlocked:!!cl.debtBlocked };
  }).filter(function(r){ return r.modems>0; });   // только активные (с модемами); неактивных на дашборде не показываем
  if(!rows.length){ el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3);font-size:12px">Нет данных</div>'; return; }
  rows.sort(function(a,b){ return (b.mrr||0)-(a.mrr||0) || (b.today-a.today); });
  var th = function(t,left){ return '<th'+(left?' style="text-align:left"':'')+'>'+t+'</th>'; };
  var h = '<table class="ztbl">';
  h += '<thead><tr>'+th('Клиент',1)+th('Live')+th('Сегодня')+th('Тариф')+th('Выручка 30д')+th('Δ M/M')+th('% выручки')+th('Баланс')+'</tr></thead><tbody>';
  rows.forEach(function(r,i){
    var col = CHART_COLORS.clients[i % CHART_COLORS.clients.length];
    var liveColor = r.modems===0 ? 'var(--text-3)' : (r.online===r.modems ? 'var(--success)' : (r.online>0 ? 'var(--warning)' : 'var(--danger)'));
    var tariff = r.billingType==='per_modem' ? (r.price+'₽/мод') : (r.price!=null ? r.price+'₽/ГБ' : '—');
    var deltaCol = r.delta==null ? 'var(--text-3)' : (r.delta>=0 ? 'var(--success)' : 'var(--danger)');
    var deltaStr = r.delta==null ? '—' : ((r.delta>0?'+':'')+r.delta+'%');
    var balCol = r.balance<0 ? 'var(--danger)' : (r.balance>0 ? 'var(--text-0)' : 'var(--text-3)');
    var paused = r.paused ? pauseBadge() : '';
    var blk = blockBadge(r);
    var td = function(content,left){ return '<td'+(left?' style="text-align:left"':'')+'>'+content+'</td>'; };
    h += '<tr>';
    h += td('<span style="display:inline-flex;align-items:center;gap:7px"><span style="width:3px;height:16px;background:'+col+';border-radius:2px"></span><strong style="color:var(--text-0)">'+esc(r.name)+'</strong>'+blk+paused+'</span>',1);
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
  var skel = document.getElementById('newDailySkel');
  if(window._dailyTrafficCache){
    if(skel) skel.style.display = 'none';
    renderNewDailyChart(window._dailyTrafficCache); return;
  }
  // Столбцы-скелетон вместо пустого канваса, пока daily_traffic едет (Stage: скелетоны).
  if(skel) skel.innerHTML = skelBars(30);
  api(API+'/api/admin/daily_traffic')
    .then(function(d){if(d&&d.__status>=400) throw new Error('HTTP '+d.__status); return d;})
    .then(function(d){ window._dailyTrafficCache = d; renderNewDailyChart(d); })
    .catch(function(e){
      var canvas = document.getElementById('newDailyCanvas');
      if(skel) skel.style.display = 'none';
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
  var skel = document.getElementById('newDailySkel');
  if(skel) skel.style.display = 'none';   // данные пришли — скелетон убираем
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

// ── «Ротации IP и ёмкость»: три итога + две короткие расшифровки ──
// Все части грузятся одним Promise.all, чтобы период и момент среза совпадали.
var _NEW_INFRA_DAYS = _dashUi.infraDays || 7;
function setNewInfraDays(d,el){_NEW_INFRA_DAYS=d;_dashUiSave({infraDays:d});if(el&&el.parentNode){Array.prototype.forEach.call(el.parentNode.children,function(c){if(c.classList)c.classList.remove('on')});el.classList.add('on');}reloadNewInfra();}
function reloadNewInfra(){
  var kpiEl=document.getElementById('newInfraKpis'),tblEl=document.getElementById('newInfraTables');
  if(!kpiEl&&!tblEl)return;
  var days=_NEW_INFRA_DAYS;
  Promise.all([
    api(API+'/api/analytics/rotations?days='+days).catch(function(){return {};}),
    api(API+'/api/analytics/ip_stats?days='+days).catch(function(){return {};}),
    api(API+'/api/analytics/capacity?days='+days).catch(function(){return {};})
  ]).then(function(res){
    var rot=res[0]||{},ip=res[1]||{},cap=(res[2]||{}).summary||{};
    var rs=rot.summary||{},ips=ip.summary||{},sn=ip.subnet_summary||{};
    var success=rs.success_pct==null?null:Number(rs.success_pct),failed=Math.max(0,Number(rs.failed)||0);
    function summaryCard(iconName,title,value,meta,tone){
      return '<article class="infra-summary-card '+(tone||'')+'"><span class="infra-summary-icon">'+icon(iconName,17)+'</span><div><span>'+title+'</span><b>'+value+'</b><small>'+meta+'</small></div></article>';
    }
    if(kpiEl){
      var rotTone=success==null?'':success>=95?'is-good':success>=80?'is-warn':'is-bad';
      kpiEl.innerHTML='<div class="infra-summary">'
        +summaryCard('refresh','Ротации',(rs.total||0).toLocaleString('ru-RU'),(success==null?'нет данных':success+'% успешно')+(failed?' · '+failed+' сбоев':''),rotTone)
        +summaryCard('globe','IP-разнообразие',(ips.unique_ips||0).toLocaleString('ru-RU')+' IP',(sn.avg!=null?sn.avg:'—')+' подсети / модем · максимум '+(sn.max||0),'is-accent')
        +summaryCard('server','Ёмкость парка',(cap.total_modems!=null?cap.total_modems:'—')+' модемов',(cap.total_servers!=null?cap.total_servers:'—')+' серверов · '+(cap.total_gb!=null?fmtGb(cap.total_gb*1e9):'—')+' за '+days+'д','')
        +'</div>';
    }
    if(!tblEl)return;
    var serverRows=(rot.per_server||[]).map(function(sv){
      var total=Number(sv.total)||0,bad=Number(sv.failed)||0,pct=total?Math.round((total-bad)/total*1000)/10:null;
      var tone=pct==null?'':pct>=95?'is-good':pct>=80?'is-warn':'is-bad';
      return '<div class="infra-list-row"><div class="infra-list-name"><b>'+esc(_serverDisplayLabel(sv.server_name)||'—')+'</b><small>'+total.toLocaleString('ru-RU')+' ротаций</small></div>'
        +'<div class="infra-list-metric '+tone+'"><b>'+(pct==null?'—':pct+'%')+'</b><small>'+bad+' сбоев</small></div>'
        +'<div class="infra-list-metric"><b>'+(sv.avg_sec!=null?Math.round(sv.avg_sec*10)/10+' с':'—')+'</b><small>среднее</small></div></div>';
    }).join('');
    if(!serverRows)serverRows='<div class="infra-empty">За период ротаций не было</div>';

    var subnetAll=ip.subnets||[],limit=_zxLim('sn',8),maxSubnet=Math.max(1,sn.max||0);
    var subnetRows=subnetAll.slice(0,limit).map(function(x){
      var width=Math.max(4,Math.round((Number(x.subnets)||0)/maxSubnet*100));
      return '<div class="infra-ip-row"><div class="infra-list-name"><b>'+esc(x.nick)+'</b><small>'+esc(_serverDisplayLabel(x.server))+'</small></div>'
        +'<div class="infra-ip-bar"><i style="width:'+width+'%"></i></div>'
        +'<div class="infra-list-metric is-accent"><b>'+x.subnets+'</b><small>подсетей · '+x.ips+' IP</small></div></div>';
    }).join('');
    if(!subnetRows)subnetRows='<div class="infra-empty">Данных об IP пока нет</div>';
    var more=subnetAll.length>limit?'<button class="infra-more" data-on-click="zMore(\'sn\')">Показать ещё '+(subnetAll.length-limit)+'</button>':'';

    tblEl.innerHTML='<div class="infra-panels">'
      +'<section class="infra-panel"><div class="infra-panel-head"><div><h4>Надёжность ротаций</h4><p>По каждому серверу за выбранный период</p></div><span>'+days+'д</span></div><div class="infra-list">'+serverRows+'</div></section>'
      +'<section class="infra-panel"><div class="infra-panel-head"><div><h4>Разнообразие IP</h4><p>Модемы с наибольшим числом /24 подсетей</p></div><span>топ</span></div><div class="infra-list">'+subnetRows+more+'</div></section>'
      +'</div>';
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
  var h = '<button class="dchip'+(!_hostsClient?' on':'')+'" data-on-click="setHostsClient(\'\')">Все клиенты</button>';
  _hostsClientList.forEach(function(c){
    h += '<button class="dchip'+(_hostsClient===c?' on':'')+'" data-c="'+esc(c)+'" data-on-click="setHostsClient(this.dataset.c)">'+esc(c)+'</button>';
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
      if(hosts.length > top.length) h += '<div style="font-size:10.5px;color:var(--accent);cursor:pointer;padding:4px 0 0" data-on-click="zMore(\'hosts\')">+ ещё '+(hosts.length-top.length)+'</div>';
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
      + '<td style="text-align:left;color:var(--text-2)">'+esc(_serverDisplayLabel(m.server))+'</td>'
      + '<td style="text-align:left">'+esc(m.pn||'—')+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb((m.dayIn||0)+(m.dayOut||0))+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb(m.monIn||0)+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono)">'+fmtGb(m.monOut||0)+'</td>'
      + '<td style="text-align:right;font-family:var(--font-mono);font-weight:600;color:var(--text-0)">'+fmtGb(tot)+'</td>'
      + '<td style="text-align:right">'+tr+'</td></tr>';
  }).join('');
  if(!rows) rows = '<tr><td colspan="9" style="padding:16px;text-align:center;color:var(--text-3)">Ничего не найдено</td></tr>';
  else if(list.length > shown.length) rows += '<tr><td colspan="9" style="padding:8px 10px;color:var(--accent);font-size:10.5px;cursor:pointer;text-align:left" data-on-click="zMore(\'mx\')">+ ещё '+(list.length-shown.length)+' · сортировка по Σ месяца</td></tr>';
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
        if(st)st.innerHTML='Сохранено · '+(body.failover_enabled?(body.failover_dry_run?'авто ВКЛ, но dry-run (тест) — реальных переносов нет':icon('alert',11) + ' авто ВКЛ, реальные переносы активны'):'авто выкл')+'. Требуется перезапуск процесса.';
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
      if(!cands.length){box.innerHTML='<div style="color:var(--success);font-size:12px;padding:12px">'+icon('check',12)+' Нет модемов, требующих failover прямо сейчас</div>';return;}
      var h='<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>';
      h+='<th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Сервер</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Модем</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Клиенты</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Причина</th><th style="text-align:left;padding:6px 8px;font-size:10px;color:var(--text-3);text-transform:uppercase;font-weight:600;letter-spacing:.5px">Спейр</th><th style="padding:6px 8px"></th></tr></thead><tbody>';
      cands.forEach(function(c){
        var spareTxt=c.spare?('<span style="color:var(--success)">'+esc(c.spare)+'</span>'):'<span style="color:var(--danger)">нет спейра</span>';
        h+='<tr>';
        h+='<td style="padding:6px 8px">'+esc(_serverDisplayLabel(c.server))+'</td>';
        h+='<td style="padding:6px 8px"><strong>'+esc(c.nick)+'</strong></td>';
        h+='<td style="padding:6px 8px;font-size:11px;color:var(--text-2)">'+esc((c.clients||[]).join(', '))+'</td>';
        h+='<td style="padding:6px 8px;font-size:11px">'+esc(c.reason)+' · '+esc(c.detail||'')+'</td>';
        h+='<td style="padding:6px 8px">'+spareTxt+'</td>';
        h+='<td style="padding:6px 8px;text-align:right">'+(c.spare?'<button class="btn btn-sm" style="font-size:11px" data-on-click="execFailover(\''+esc(c.server)+'\',\''+esc(c.imei)+'\',\''+esc(c.nick)+'\')">Перенести</button>':'—')+'</td>';
        h+='</tr>';
      });
      h+='</tbody></table>';
      box.innerHTML=h;
    })
    .catch(function(e){if(box)box.innerHTML='<div style="color:var(--danger);font-size:12px;padding:12px">Ошибка: '+esc(e.message)+'</div>';});
}
function execFailover(server,imei,nick){
  confirmDialog('Перенести клиента(ов) модема «'+nick+'» ('+_serverDisplayLabel(server)+') на здоровый спейр сейчас? Строка подключения клиента сохранится, внешний IP сменится.',function(){
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
        var map={ok:['#34c759','выполнен'],failed:['#e84141','ошибка'],dry_run:['#3b82f6','dry-run'],skipped_no_spare:['#e84141','нет спейра'],skipped_rate:['#FFCC00','лимит'],skipped_cooldown:['#9b9b98','cooldown']};
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
        h+='<td style="padding:6px 8px">'+esc(_serverDisplayLabel(r.server_name)||'')+'</td>';
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
  var _cdBlk=c.blocked?'<span title="Аккаунт заблокирован (антифрод)">БЛОК</span>':(c.debtBlocked?'<span title="Порты заблокированы за долг — доступ восстановится после оплаты">БЛОК</span>':null);
  var st=_cdBlk?[_cdBlk,'var(--danger)','#fff']:(balance<0?['ДОЛЖНИК','var(--danger)','#fff']:(c.billingPaused?['<span title="Пауза начислений — списания остановлены" style="display:inline-flex;align-items:center">'+icon('moneyOff',11)+'</span>','var(--warning)','#000']:(mc===0?['НЕТ МОДЕМОВ','var(--bg-3)','var(--text-2)']:['АКТИВЕН','var(--success)','#fff'])));
  var pl=document.getElementById('cdPill');pl.innerHTML=st[0];pl.style.background=st[1];pl.style.color=st[2];
  var charge=Math.round(((currentData.clientMonthCharges||{})[id]||0));
  var gb=Math.round(((currentData.clientMonthGb||{})[id]||0)*10)/10;
  var be=document.getElementById('cdKpiBal');be.textContent=Math.round(balance).toLocaleString('ru-RU');be.style.color=balance<0?'var(--danger)':(balance>0?'var(--success)':'var(--text-0)');
  document.getElementById('cdKpiBalWrap').classList.toggle('is-green',balance>=0);
  document.getElementById('cdKpiCharge').textContent=charge.toLocaleString('ru-RU');
  document.getElementById('cdKpiModems').textContent=(typeof c.modemWorking==='number'&&typeof c.modemCount==='number')?(c.modemWorking+'/'+c.modemCount):mc;
  document.getElementById('cdKpiTraffic').innerHTML=gb.toFixed(1)+'<span style="font-size:12px"> ГБ</span>';
  var ml=document.getElementById('cdModemsList');
  var mh='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin:6px 0 10px">Привязанные модемы ('+mc+')</div>';
  if(mc){mh+='<div style="display:flex;flex-wrap:wrap;gap:5px">'+mds.map(function(m){return '<span class="client-modem-tag">'+esc(m.nick)+' <span style="color:var(--text-3)">('+esc(_serverDisplayLabel(m.server))+')</span></span>';}).join('')+'</div>';}
  else{mh+='<div style="font-size:12px;color:var(--text-3);padding:8px 0">Нет привязанных модемов. Привязка — на странице «Модемы».</div>';}
  ml.innerHTML=mh;
  document.getElementById('cdDeleteBtn').style.display='';
  // Блокировка/антифрод — секция видна для любого существующего клиента.
  var ab=document.getElementById('cdAbuseSection');
  if(ab){
    ab.style.display='';
    var stEl=document.getElementById('cdAbuseStatus');
    stEl.textContent=c.blocked?'Аккаунт ЗАБЛОКИРОВАН':'Аккаунт активен';
    stEl.style.color=c.blocked?'var(--danger)':'var(--text-0)';
    document.getElementById('cdAbuseStrikes').textContent='Нарушений AUP (strikes): '+(c.abuseStrikes||0);
    document.getElementById('cdUnblockBtn').style.display=c.blocked?'':'none';
    var bb=document.getElementById('cdBlockBtn');if(bb)bb.style.display=c.blocked?'none':'';
    var rb=document.getElementById('cdRehabBtn');if(rb)rb.style.display=(c.clientType==='individual'||c.blocked||(c.abuseStrikes>0))?'':'none';
  }
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
  var nab=document.getElementById('cdAbuseSection');if(nab)nab.style.display='none';   // WP7: антифрод — только у существующего клиента
  switchDetailTab('overview');
}

function setClientFilter2(f){_clientFilter=f;document.querySelectorAll('.cl-chip').forEach(function(ch){ch.classList.toggle('active',ch.getAttribute('data-f')===f);});renderClients();}
