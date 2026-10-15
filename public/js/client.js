// public/js/client.js — extracted from public/index.html (Stage 5).
// Client portal SPA: traffic dashboard, billing, modem list, IP reset, docs.
// Loads utils.js BEFORE this file. Stage 7: removed duplicated helpers
// (formatBytes, showToast, getModemStatus, bytesToGb, pct, formatUptime,
// getChartColors) — their copies here used binary units (1024) while
// utils.js uses decimal SI (matches backend). Removing the dupes makes
// the client portal show the same byte values as the admin dashboard
// and as the billing ledger.
// --- Theme ---
function getTheme(){return localStorage.getItem('pr_theme')||'light'}

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  // Theme toggle is CSS-only (::after pseudo-element)
}

function toggleTheme(){
  var current=getTheme();
  var next=current==='dark'?'light':'dark';
  localStorage.setItem('pr_theme',next);
  applyTheme(next);
}

applyTheme(getTheme());

// --- Auth state ---
var authToken=localStorage.getItem('pr_token')||'';
var authLogin=localStorage.getItem('pr_login')||'';
// 2026-10-02 · fix вечной «Загрузка…»: _loadDataGen/_sessionGen были
// объявлены (var) НИЖЕ init-IIFE — при первом loadData из init переменная
// была ещё undefined, ++ давал NaN, NaN!==NaN делало ответ навсегда
// «устаревшим» (_stale), и loadData молча умирал до рендера. Объявление
// обязано стоять выше init. (Заведено с stale-гардом DEEP-59, cbddffb.)
var _loadDataGen=0,_sessionGen=0;

// --- State ---
var tableData=[];
var modemLogins={};
var billingData=null;
var rawData=null;
var currentSort={key:'modemNick',dir:'asc'};

// --- Country config ---
var countryNames={'MD':'\ud83c\uddf2\ud83c\udde9 Молдова','RO':'\ud83c\uddf7\ud83c\uddf4 Румыния','??':'\ud83c\udf10 Другое'};
var countryOrder=['MD','RO','??'];
var COUNTRIES={}; // populated from server data in loadData
function clientServerDisplayName(name){var c=COUNTRIES[name]||{};return c.displayName||name;}

// --- Tabs ---
function switchTab(name,el){
  localStorage.setItem('pr_active_tab',name);
  document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.tab-pane').forEach(function(t){t.classList.remove('active')});
  if(el) el.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  // ЛК v3: каждая страница — свой модуль public/js/portal/*.js
  var R={overview:'renderOverview',traffic:'renderProxies',analytics:'renderAnalytics',billing:'renderBalance',
    documents:'renderDocuments',api:'renderApiPage',referral:'renderReferral',profile:'renderProfile'};
  if(R[name]&&typeof window[R[name]]==='function')window[R[name]]();
  if(name==='shop') loadShop();
}

// --- B2C retail config (WP3) ---
// /api/public/auth_config — без auth; при ошибке/выкл рознице ссылки и вкладка
// «Купить прокси» просто остаются скрытыми.
var retailConfig=null;
function initRetailConfig(){
  fetch('/api/public/auth_config').then(function(r){return r.json()}).then(function(cfg){
    retailConfig=cfg||{};
    // Кнопка «Связаться» — Telegram поддержки (настройка support_telegram), даже если розница выключена.
    var ct=document.getElementById('navContact');
    if(ct&&retailConfig.support_telegram){ct.href='https://t.me/'+retailConfig.support_telegram;ct.style.display=''}
    if(!retailConfig.retail_enabled)return;
    var links=document.getElementById('retailAuthLinks');
    if(links)links.style.display='';
    var shopTab=document.getElementById('navTabShop');
    if(shopTab)shopTab.style.display='';
    // TG-вход на странице логина — OIDC-кнопка (auth-utils.js); старый
    // iframe-виджет oauth.telegram.org Telegram отключил («deprecated»).
    if(retailConfig.telegram_oidc_enabled){
      renderTelegramLoginButton('tgLoginWrap','Войти через Telegram');
    }
  }).catch(function(){});
}

// --- Onboarding ---
var ONBOARDING_KEY='proxies_rent_onboarding_dismissed';
var onboardingStep=0;
var ONBOARDING_STEPS=[
  {label:'Обзор',tab:'overview',desc:'Сводка по вашему парку: трафик за месяц и сегодня, прогноз, качество связи и самые загруженные прокси.'},
  {label:'Прокси',tab:'traffic',desc:'Все прокси с реквизитами: выбирайте галочками, меняйте IP, настраивайте автосмену и выгружайте реквизиты в нужном формате.'},
  {label:'Аналитика',tab:'analytics',desc:'Потребление за любой период по локациям и модемам, почасовая тепловая карта и скорость по операторам.'},
  {label:'Баланс',tab:'billing',desc:'Баланс, расход по дням и история операций по месяцам. Списания — автоматически каждый день за предыдущие сутки.'},
  {label:'Документы',tab:'documents',desc:'Акты, счета на оплату и договоры — скачиваются в PDF.'},
  {label:'API',tab:'api',desc:'Ваш API-ключ и готовые примеры запросов на cURL, Python и JavaScript.'},
];
function initOnboarding(){
  if(localStorage.getItem(ONBOARDING_KEY))return;
  onboardingStep=0;
  _renderOnboarding();
  document.getElementById('onboardingBanner').style.display='';
}
function _renderOnboarding(){
  var s=ONBOARDING_STEPS[onboardingStep];
  var n=ONBOARDING_STEPS.length;
  document.getElementById('onboardingDesc').textContent=s.desc;
  document.getElementById('onboardingProgress').style.width=Math.round((onboardingStep+1)/n*100)+'%';
  document.getElementById('onboardingCounter').textContent=(onboardingStep+1)+' из '+n;
  document.getElementById('onboardingNextBtn').textContent=onboardingStep===n-1?'Завершить тур':'Следующий раздел →';
  var pills='';
  ONBOARDING_STEPS.forEach(function(st,i){
    var cls=i<onboardingStep?'#EAF3DE;color:#3B6D11':i===onboardingStep?'#185FA5;color:#fff':'var(--bg-2);color:var(--text-3)';
    var border=i<onboardingStep?'none':i===onboardingStep?'none':'1px solid var(--border)';
    pills+='<span style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:500;background:'+cls+';border:'+border+'">'+
      (i<onboardingStep?icon('check',10)+' ':'')+st.label+'</span>';
  });
  document.getElementById('onboardingPills').innerHTML=pills;
}
function onboardingNext(){
  if(onboardingStep>=ONBOARDING_STEPS.length-1){dismissOnboarding();return;}
  onboardingStep++;
  var step=ONBOARDING_STEPS[onboardingStep];
  // Navigate to the tab
  var tabEl=document.querySelector('.nav-tab[data-on-click*="\''+step.tab+'\'"]');
  switchTab(step.tab,tabEl);
  // Move banner to new tab pane
  var banner=document.getElementById('onboardingBanner');
  var target=document.getElementById('tab-'+step.tab);
  if(target){
    var container=target.querySelector('.v3-body')||target.querySelector('.container')||target;
    container.insertBefore(banner,container.firstChild);
  }
  _renderOnboarding();
}
function dismissOnboarding(){
  localStorage.setItem(ONBOARDING_KEY,'1');
  var b=document.getElementById('onboardingBanner');
  if(b)b.style.display='none';
}

// --- Debt/block banner (B3, Р13) ---
// Рендерится вверху вкладки «Трафик» и «История баланса»: факт блокировки,
// отрицательный баланс до гашения портов, прогноз «за 3 дня» и истекающая
// «дата до». Данные — billing.debtStatus / billing.expiresAt (dashboard_data,
// billing_history); юрлица и allow_debt=1 получают null — баннера нет.
function renderDebtBanner(debtStatus,expiresAt){
  var banner=document.getElementById('debtBanner');
  var html='';
  var bg='';
  if(debtStatus&&debtStatus.state==='blocked'){
    bg='var(--red)';
    html=icon('lock',14)+' <b>Доступ приостановлен за неоплату.</b> Баланс: '+formatNumber(debtStatus.balance)+' ₽. Порты погашены («дата до» истекла). После пополнения доступ восстановится автоматически (до ~30 мин). Для пополнения — свяжитесь с менеджером.';
  }else if(debtStatus&&debtStatus.state==='debt'){
    bg='var(--red)';
    html=icon('alert',14)+' <b>Отрицательный баланс: '+formatNumber(debtStatus.balance)+' ₽.</b> При следующем списании порты будут заблокированы. Пополните баланс — для этого свяжитесь с менеджером.';
  }else if(debtStatus&&debtStatus.state==='warning'){
    bg='var(--yellow,#b8860b)';
    html=icon('hourglass',14)+' <b>Баланса хватит примерно на '+debtStatus.daysLeft+' дн.</b> ('+formatNumber(debtStatus.balance)+' ₽). При уходе в ноль порты будут заблокированы автоматически. Рекомендуем пополнить заранее.';
  }
  if(!html&&expiresAt){
    var t=Date.parse(expiresAt);
    if(!isNaN(t)){
      var daysLeft=Math.ceil((t-Date.now())/86400000);
      if(daysLeft>=0&&daysLeft<=3){
        bg='var(--yellow,#b8860b)';
        html=icon('clock',14)+' <b>Срок действия прокси истекает '+expiresAt+'</b> (осталось '+daysLeft+' дн.). Продлите аренду через менеджера.';
      }
    }
  }
  if(!html){
    if(banner)banner.style.display='none';
    return;
  }
  if(!banner){
    banner=document.createElement('div');
    banner.id='debtBanner';
    var target=document.querySelector('#tab-overview .v3-body');
    if(target)target.insertBefore(banner,target.firstChild);
  }
  banner.style.cssText='display:block;margin:0 0 14px;padding:12px 16px;border-radius:8px;background:'+bg+';color:#fff;font-size:13px;line-height:1.5';
  banner.innerHTML=html;
}

// --- B2C Э2: баннер конвейера автоблока (grace → блок → hold) ---
// Данные — data.retail из /api/dashboard_data (есть ТОЛЬКО при retail_enabled;
// у B2B-клиентов поля нет — баннер не создаётся и не мигает при загрузке).
// Состояния: blocked (хотя бы один порт blocked) > grace (баланс ≤ 0,
// порты ещё leased) > тест-день (testExpiresAt в будущем, компактная плашка).
function _fmtRetailDt(ms){
  return new Date(ms).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function gotoBilling(){
  var tabEl=document.querySelector('.nav-tab[data-on-click*="\'billing\'"]');
  switchTab('billing',tabEl);
}
function renderRetailBanner(retail,balance){
  var banner=document.getElementById('retailBanner');
  if(!retail){
    if(banner)banner.style.display='none';
    return;
  }
  var ports=retail.ports||[];
  var blocked=ports.filter(function(p){return p.status==='blocked'});
  var testExp=null;
  ports.forEach(function(p){
    var t=p.testExpiresAt&&Date.parse(p.testExpiresAt);
    if(t&&t>Date.now()&&(testExp===null||t<testExp))testExp=t;
  });
  var topupBtn=' <button data-on-click="gotoBilling()" style="margin-left:10px;padding:3px 12px;background:#fff;color:#1f2937;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;vertical-align:1px">Пополнить баланс</button>';
  var html='',bg='';
  if(blocked.length){
    bg='var(--red)';
    var hold=null;
    blocked.forEach(function(p){
      var t=p.holdUntil&&Date.parse(p.holdUntil);
      if(t&&(hold===null||t<hold))hold=t;
    });
    html=icon('lock',14)+' <b>Прокси заблокирован.</b> '+(hold!==null
      ?'Храним порт до <b>'+_fmtRetailDt(hold)+'</b> — после этого он будет удалён безвозвратно.'
      :'Пополните баланс для восстановления.')+topupBtn;
  }else if(retail.balanceNegativeSince&&(balance||0)<=0){
    var since=Date.parse(retail.balanceNegativeSince);
    if(!isNaN(since)){
      bg='var(--yellow,#b8860b)';
      var deadline=since+(retail.graceHours||24)*3600000;
      html=icon('hourglass',14)+' <b>Баланс закончился.</b> Прокси работает до <b>'+_fmtRetailDt(deadline)+'</b> — пополните баланс.'+topupBtn;
    }
  }
  // Тест-день: независимая компактная плашка — строкой в основном баннере
  // либо отдельным info-баннером, когда других состояний нет.
  if(testExp!==null){
    var testLine=icon('flask',13)+' Тестовый период до <b>'+_fmtRetailDt(testExp)+'</b>';
    if(html)html+='<div style="margin-top:6px;font-size:12px;opacity:.92">'+testLine+'</div>';
    else{bg='var(--accent)';html=testLine;}
  }
  if(!html){
    if(banner)banner.style.display='none';
    return;
  }
  if(!banner){
    banner=document.createElement('div');
    banner.id='retailBanner';
    var target=document.querySelector('#tab-overview .v3-body');
    if(target)target.insertBefore(banner,target.firstChild);
  }
  banner.style.cssText='display:block;margin:0 0 14px;padding:12px 16px;border-radius:8px;background:'+bg+';color:#fff;font-size:13px;line-height:1.5';
  banner.innerHTML=html;
}

function formatNumber(n){
  if(n===undefined||n===null) return '0';
  return parseFloat(n).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
}

// --- Init ---
(function init(){
  // Support admin impersonation via ?impersonate=TOKEN
  var params=new URLSearchParams(window.location.search);
  var impToken=params.get('impersonate');
  if(impToken){
    authToken=impToken;
    authLogin='(admin view)';
    localStorage.setItem('pr_token',impToken);
    localStorage.setItem('pr_login','(admin view)');
    // Clean URL without reloading
    window.history.replaceState({},'',window.location.pathname);
  }
  if(authToken){showApp()}else{showLogin()}
  initRetailConfig();
  document.getElementById('passwordInput').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
  document.getElementById('loginInput').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('passwordInput').focus()});
})();

function showLogin(){
  document.getElementById('loginOverlay').style.display='flex';
  document.getElementById('appMain').style.display='none';
  document.getElementById('loginInput').focus();
}

var refreshInterval=null;

function showApp(){
  document.getElementById('loginOverlay').style.display='none';
  document.getElementById('appMain').style.display='block';
  loadData();
  // 2026-10-15: «физлицо или юрлицо» — один раз для самостоятельно зарегистрированных.
  if(typeof v3OnbStart==='function')setTimeout(v3OnbStart,1200);
  if(refreshInterval) clearInterval(refreshInterval);
  refreshInterval=setInterval(loadData,60*60*1000);
}

async function doLogin(){
  var login=document.getElementById('loginInput').value.trim();
  var password=document.getElementById('passwordInput').value;
  var errorEl=document.getElementById('loginError');
  var btn=document.getElementById('btnLogin');

  if(!login||!password){errorEl.textContent='Введите логин и пароль';return}
  btn.disabled=true;errorEl.textContent='';

  try{
    var resp=await fetch('/api/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({login:login,password:password})
    });
    var data=await resp.json();
    if(!resp.ok){errorEl.textContent=data.error||'Ошибка входа';return}
    authToken=data.token;
    authLogin=data.login;
    localStorage.setItem('pr_token',authToken);
    localStorage.setItem('pr_login',authLogin);
    if(data.isAdmin){
      localStorage.setItem('pr_admin_token',authToken);
      window.location.href='/admin';
      return;
    }
    showApp();
  }catch(err){
    errorEl.textContent='Ошибка соединения';
  }finally{
    btn.disabled=false;
  }
}

function doLogout(){
  _sessionGen++;_loadDataGen++;   // DEEP-59: все запросы прежней сессии инвалидированы
  api('/api/logout',{method:'POST'}).catch(function(){});
  authToken='';authLogin='';
  localStorage.removeItem('pr_token');localStorage.removeItem('pr_login');
  tableData=[];billingData=null;rawData=null;
  if(refreshInterval){clearInterval(refreshInterval);refreshInterval=null}
  showLogin();
}

// parseBW and formatBytes moved to /js/utils.js
var parseBW=parseTraffic; // alias for backward compatibility

// Cost display without spaces - use Math.round for proper rounding
function formatCost(amount){
  return Math.round(amount).toString();
}

function formatCurrencyLabel(currency){
  return currency||'';
}

async function fetchJSON(url){
  var d=await api(url);
  if(d&&d.__status===401){doLogout();throw new Error('Сессия истекла')}
  if(d&&d.__status>=400) throw new Error('HTTP '+d.__status);
  return d;
}

function setStatus(state,text){
  var txt=document.getElementById('statusText');
  // «OK» не показываем — текст только при проблемах
  if(txt)txt.textContent=state==='ok'?'':text;
}

function escapeHtml(str){return esc(str)}

// --- Clipboard with fallback ---
function copyIcon(){return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'}
function copyText(t,b){
  function onOk(){if(b){var o=b.innerHTML;b.innerHTML=icon('check',13);setTimeout(function(){b.innerHTML=o},1500)}showToast('Скопировано','info')}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(onOk).catch(doFallback)}else{doFallback()}
  function doFallback(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;left:-9999px;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');onOk()}catch(e){showToast('Ошибка','error')}document.body.removeChild(a)}
}

// --- Password visibility toggle (masked by default) ---
function togglePassVis(btn){
  var span=btn.parentElement.querySelector('.pass-val');
  if(!span)return;
  var full=span.getAttribute('data-full');
  var masked=span.getAttribute('data-masked');
  if(span.textContent===masked){span.textContent=full;btn.innerHTML=icon('eyeOff',12);_revealMark(full,true);}
  else{span.textContent=masked;btn.innerHTML=icon('eye',12);_revealMark(full,false);}
}

// --- Load Data ---
// 2026-09-24 · DEEP-59: request generation + session generation. После await
// принимаем только ответ АКТУАЛЬНОГО запроса ТЕКУЩЕЙ сессии: медленный первый
// запрос больше не откатывает данные быстрого второго, а logout не пускает
// запоздалый ответ прежней сессии в память.
// Объявление — вверху файла (см. строку ~34): var-дубль здесь бы перезаписал
// счётчик ПОСЛЕ первого loadData из init.
async function loadData(){
  var gen=++_loadDataGen;
  var sessGen=_sessionGen;
  function _stale(){return gen!==_loadDataGen||sessGen!==_sessionGen;}
  var btn=document.getElementById('btnRefresh');
  if(btn)btn.disabled=true;
  setStatus('loading','Загрузка...');
  document.getElementById('errorContainer').innerHTML='';

  try{
    var data=await fetchJSON('/api/dashboard_data');
    if(_stale())return;   // DEEP-59: устаревший ответ — ничего не меняем
    rawData=data;
    // Populate COUNTRIES from server data
    if(data.servers&&data.servers.length){
      COUNTRIES={};
      data.servers.forEach(function(s){COUNTRIES[s.name]={serverIp:s.publicIp||'',country:s.country||'',name:s.countryName||s.name,displayName:s.displayName||s.name}});
    }
    var bwData=data.bandwidth;
    var statusData=data.status;
    var portsData=data.ports;
    modemLogins=data.modemLogins||{};
    billingData=data.billing||null;
    renderDebtBanner(billingData&&billingData.debtStatus,billingData&&billingData.expiresAt);
    renderRetailBanner(data.retail,billingData&&billingData.balance);

    var ipTracking=data.ipTracking||{};
    var uptimeTracking=data.uptimeTracking||{};
    var speedtestLatest=data.speedtestLatest||{};

    var modemMap={};
    if(Array.isArray(statusData)){
      statusData.forEach(function(m){
        var imei=m.modem_details&&m.modem_details.IMEI;
        if(imei){
          modemMap[imei]={
            nick:m.modem_details.NICK||imei,
            model:m.modem_details.MODEL_SHOWN||m.modem_details.MODEL||'',
            online:(m.net_details&&m.net_details.IS_ONLINE)||'no',
            extIp:(m.net_details&&m.net_details.EXT_IP)||'',
            operator:(function(){var raw=(m.net_details&&m.net_details.CELLOP)||'';var n={'unite':'Moldtelecom','orange':'Orange','vodafone ro':'Vodafone RO','moldtelecom':'Moldtelecom'};return n[raw.toLowerCase()]||raw})(),
            networkType:(m.net_details&&m.net_details.CurrentNetworkType)||'',
            server:m._server||'',
            autoRotation:m.modem_details.AUTO_IP_ROTATION||'',
            timeToRotation:m.modem_details.TIME_TO_IP_ROTATION||''
          };
        }
      });
    }

    var portImeiMap={};
    if(portsData&&typeof portsData==='object'){
      for(var imeiKey in portsData){
        var ports=portsData[imeiKey];
        if(Array.isArray(ports)){
          ports.forEach(function(p){if(p.portID) portImeiMap[p.portID]=imeiKey});
        }
      }
    }

    tableData=[];
    if(bwData&&typeof bwData==='object'){
      for(var portId in bwData){
        var bw=bwData[portId];
        var imei=portImeiMap[portId]||'';
        var modem=modemMap[imei]||{nick:imei||'?',model:'',online:'?',extIp:'',operator:'',networkType:'',server:''};

        var country=modem.nick.startsWith('MD')?'MD':modem.nick.startsWith('RO')?'RO':'??';
        var serverName=modem.server||bw._server||(imei.match(/^(S\d+)_/)?imei.match(/^(S\d+)_/)[1]:'')||(portId.match(/^(S\d+)_/)?portId.match(/^(S\d+)_/)[1]:'');
        var rawImei=imei.replace(/^S\d+_/,'');

        // IP tracking info
        var ipInfo=ipTracking[imei]||null;

        // Uptime percentage — the same 30-day periodic counters as client SLA.
        var uptimePct=null;
        if(uptimeTracking[imei]){
          var ut=uptimeTracking[imei];
          if(ut.uptime30d!==null&&ut.uptime30d!==undefined){
            uptimePct=parseFloat(ut.uptime30d).toFixed(1);
          } else if(ut.total_checks>0){
            uptimePct=(ut.online_checks/ut.total_checks*100).toFixed(1);
          }
        }

        // Speed
        var speedDl=0,speedUl=0;
        if(speedtestLatest[imei]){
          speedDl=speedtestLatest[imei].download||0;
          speedUl=speedtestLatest[imei].upload||0;
        }

        // Port info
        var portInfo=null;
        if(portsData&&portsData[imei]&&Array.isArray(portsData[imei])){
          portInfo=portsData[imei][0];
        }

        tableData.push({
          portId:portId,
          imei:imei,
          rawImei:rawImei,
          serverName:serverName,
          country:country,
          modemNick:modem.nick,
          modemLogin:modemLogins[modem.nick]||'',
          modemModel:modem.model,
          online:modem.online,
          extIp:modem.extIp,
          ipSince:ipInfo&&ipInfo.since?ipInfo.since:null,
          operator:modem.operator,
          networkType:modem.networkType,
          portName:bw.portName||portId,
          uptimePct:uptimePct,
          speedDl:speedDl,
          speedUl:speedUl,
          httpPort:portInfo?portInfo.HTTP_PORT:'',
          socksPort:portInfo?portInfo.SOCKS_PORT:'',
          proxyLogin:portInfo?portInfo.LOGIN:'',
          proxyPassword:portInfo?portInfo.PASSWORD:'',
          httpCreds:portInfo?portInfo.http_creds:'',
          socks5Creds:portInfo?portInfo.socks5_creds:'',
          resetSecureLink:portInfo&&portInfo.RESET_SECURE_LINK?portInfo.RESET_SECURE_LINK.URL:'',
          autoRotation:modem.autoRotation||'',
          timeToRotation:modem.timeToRotation||'',
          dayIn:parseBW(bw.bandwidth_bytes_day_in),
          dayOut:parseBW(bw.bandwidth_bytes_day_out),
          yesterdayIn:parseBW(bw.bandwidth_bytes_yesterday_in),
          yesterdayOut:parseBW(bw.bandwidth_bytes_yesterday_out),
          monthIn:parseBW(bw.bandwidth_bytes_month_in),
          monthOut:parseBW(bw.bandwidth_bytes_month_out),
          _cached:!!bw._cached,
          _offline:!!bw._offline,
          _end:0
        });
      }
    }

    // Show warning if some servers returned cached data
    var cachedServers=data.cachedServers||[];
    if(cachedServers.length>0){
      var cacheWarnings=cachedServers.map(function(s){
        var ago=Math.round((Date.now()-s.cachedAt)/60000);
        return s.name+' (данные '+ago+' мин. назад)';
      }).join(', ');
      document.getElementById('errorContainer').innerHTML=
        '<div style="padding:10px 16px;background:rgba(255,204,0,0.15);border:1px solid rgba(255,204,0,0.3);border-radius:8px;color:var(--warning);font-size:12px;margin-bottom:12px">'+
        icon('alert',13)+' Сервер недоступен: '+escapeHtml(cacheWarnings)+'. Трафик и доступы отображаются из кеша. Модемы помечены как offline.</div>';
    }

    // Скролл не дёргаем при ререндере (контейнеры схлопываются → прыгало наверх).
    var _sy=window.scrollY;
    try{if(typeof v3OnData==='function')v3OnData()}catch(e){console.error('[loadData] v3OnData:',e)}
    try{initOnboarding()}catch(e){console.error('[loadData] initOnboarding:',e)}

    // Restore saved tab
    var _savedTab=localStorage.getItem('pr_active_tab');
    // v3: «Панель управления» (traffic) разделилась на «Обзор» и «Прокси» —
    // старое сохранённое значение один раз уводим на новый «Обзор».
    if(_savedTab==='traffic'&&!localStorage.getItem('pr_tab_v3'))_savedTab='overview';
    try{localStorage.setItem('pr_tab_v3','1')}catch(e){}
    if(_savedTab&&!window._v3TabRestored){window._v3TabRestored=true;var _tabEl=document.querySelector('.nav-tab[data-on-click*="\''+_savedTab+'\'"]');if(_tabEl)switchTab(_savedTab,_tabEl)}

    setStatus(cachedServers.length>0?'loading':'ok',cachedServers.length>0?'Частичные данные':'OK');
    requestAnimationFrame(function(){requestAnimationFrame(function(){window.scrollTo(0,_sy)})});

  }catch(err){
    if(err.message==='Сессия истекла') return;
    if(_stale())return;   // DEEP-59: ошибка старого запроса не заменяет актуальное состояние
    setStatus('error','Ошибка');
    document.getElementById('errorContainer').innerHTML=
      '<div class="error-msg">Не удалось загрузить данные: '+escapeHtml(err.message)+'</div>';
  }finally{
    if(!_stale()&&btn)btn.disabled=false;
  }
}

// ==================== B2C: вкладка «Купить прокси» (WP3) ====================
// Витрина /api/client/tariffs (только при retail_enabled — вкладку прячет
// initRetailConfig). Покупка — /api/client/buy_proxy; ошибки с полем code
// маппим на понятные сообщения (Р38).

var _shopLoaded=false;

function loadShop(){
  var box=document.getElementById('shopContent');
  // Баннер верификации на витрине — тот же, что в профиле (EMAIL_NOT_VERIFIED
  // приходит и от buy_proxy, если клиент ещё не подтвердил адрес).
  api('/api/client/referral').then(function(p){
    var b=document.getElementById('shopVerifyBanner');
    if(b&&p&&!p.error)b.style.display=p.emailVerified?'none':'';
  }).catch(function(){});
  // 2026-10-15: магазин v3 — страна + количество (ступени цены), Россия — заявка менеджеру.
  if(typeof shopLoad==='function'){shopLoad();return}
  if(_shopLoaded)return;
  api('/api/client/tariffs').then(function(data){
    if(!data||data.error||!data.tariffs){
      box.innerHTML='<div class="error-msg">'+escapeHtml((data&&data.error)||'Не удалось загрузить тарифы')+'</div>';
      return;
    }
    _shopLoaded=true;
    renderShop(data.tariffs);
  }).catch(function(e){
    box.innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

function renderShop(tariffs){
  var box=document.getElementById('shopContent');
  if(!tariffs.length){
    box.innerHTML='<div class="shop-grid"><div class="shop-empty">Тарифы скоро появятся</div></div>';
    return;
  }
  var h='<div class="shop-grid">';
  tariffs.forEach(function(t){
    var isTest=t.duration_hours===24;
    h+='<div class="shop-card">'+
      (isTest?'<span class="shop-card-badge">Тест-день</span>':'')+
      '<div class="shop-card-name">'+escapeHtml(t.name)+'</div>'+
      '<div class="shop-card-geo">'+escapeHtml(t.geo||'')+(t.server?' · '+escapeHtml(clientServerDisplayName(t.server)):'')+'</div>'+
      '<div class="shop-card-price">'+Math.round(t.price).toLocaleString('ru-RU')+' ₽<small>/мес</small></div>'+
      (t.price_day?'<div class="shop-card-day">≈ '+t.price_day.toLocaleString('ru-RU')+' ₽/день</div>':'')+
      '<button class="btn btn-accent shop-card-buy" data-on-click="buyProxy('+t.id+',this)">Купить</button>'+
    '</div>';
  });
  h+='</div>';
  box.innerHTML=h;
}

async function buyProxy(tariffId,btn){
  if(btn)btn.disabled=true;
  try{
    var data=await api('/api/client/buy_proxy',{method:'POST',json:{tariff_id:tariffId}});
    if(data&&data.ok){
      showToast('Прокси выдан — показываю реквизиты','success');
      loadData(); // обновить порты/баланс ЛК
      // Сразу ведём к реквизитам — не заставляем клиента искать вкладку.
      var tabEl=document.querySelector('.nav-tab[data-on-click*="\'traffic\'"]');
      switchTab('traffic',tabEl);
      return;
    }
    var code=data&&data.code;
    if(code==='EMAIL_NOT_VERIFIED'){
      showToast('Сначала подтвердите email','error');
      // К баннеру верификации — он на вкладке «Профиль»
      var tabEl=document.querySelector('.nav-tab[data-on-click*="\'profile\'"]');
      switchTab('profile',tabEl);
      setTimeout(function(){
        var b=document.getElementById('profileVerifyBanner');
        if(b)b.scrollIntoView({behavior:'smooth',block:'center'});
      },150);
    }else if(code==='INSUFFICIENT_BALANCE'){
      // Не просто тост: ведём на вкладку «Баланс» и подставляем нужную сумму
      // в форму пополнения (округляем вверх до рубля).
      showToast('Недостаточно средств — открыл пополнение с нужной суммой','warning');
      if(data.required!=null)window._topupPrefill=Math.ceil(data.required);
      var tabB=document.querySelector('.nav-tab[data-on-click*="\'billing\'"]');
      switchTab('billing',tabB);
      setTimeout(function(){
        var sec=document.getElementById('topupSection');
        if(sec)sec.scrollIntoView({behavior:'smooth',block:'center'});
      },400);
    }else if(code==='POOL_EMPTY'){
      showToast('Свободные прокси этой локации закончились','error');
    }else if(code==='TEST_USED'){
      showToast('Тест-день уже использован','error');
    }else if(code==='TARIFF_LOCKED'){
      showToast('Смена тарифа через поддержку','error');
    }else{
      showToast((data&&data.error)||'Ошибка покупки','error');
    }
  }catch(e){
    showToast('Ошибка соединения','error');
  }finally{
    if(btn)btn.disabled=false;
  }
}

// Повторная отправка письма верификации (баннер витрины). POST /api/auth/resend_verification.
async function doResendVerification(btn){
  if(btn)btn.disabled=true;
  try{
    var data=await api('/api/auth/resend_verification',{method:'POST',json:{}});
    if(data&&data.ok){
      showToast(data.message||'Письмо отправлено','success');
    }else{
      showToast((data&&data.error)||'Не удалось отправить письмо','error');
      if(btn)btn.disabled=false;
    }
  }catch(e){
    showToast('Ошибка соединения','error');
    if(btn)btn.disabled=false;
  }
}
function gotoProfile(){v3Go('profile')}
