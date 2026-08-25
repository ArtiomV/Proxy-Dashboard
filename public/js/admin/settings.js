// public/js/admin/settings.js — settings tab (WP6.3 carve-out from admin.js,
// VERBATIM): pricing tiers, servers list, all settings sections.

function renderPricingTiers() {
  var area = document.getElementById('pricingTiersArea');
  if (!area) return;   // UI блока тарифов убран из admin.html; вызов из loadSettings остаётся
  var tiers = (currentData && currentData.settings && currentData.settings.pricing_tiers) || [{min_proxies:1,price:30,label:'1-4'},{min_proxies:5,price:25,label:'5-9'},{min_proxies:10,price:23,label:'10-19'},{min_proxies:20,price:20,label:'20+'}];
  var h = '<table class="log-table"><thead><tr><th>От (портов)</th><th>Цена (руб/мод)</th><th>Описание</th></tr></thead><tbody>';
  tiers.forEach(function(t, i) {
    h += '<tr><td><input class="form-input" type="number" id="tierMin_'+i+'" value="'+t.min_proxies+'" style="width:80px"></td><td><input class="form-input" type="number" id="tierPrice_'+i+'" value="'+t.price+'" style="width:80px"></td><td><input class="form-input" id="tierLabel_'+i+'" value="'+(t.label||'')+'" style="width:120px"></td></tr>';
  });
  h += '</tbody></table>';
  area.innerHTML = h;
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
      var flag=cc==='MD'?flagIcon('MD'):cc==='RO'?flagIcon('RO'):icon('globe');
      var cName=cn.name||cc;
      // «Модемов» и «в работе» — строго fleet (WP1: единый источник на все
      // страницы). Живой fallback-подсчёт удалён: он и давал расхождения.
      var _fb=currentData&&currentData.fleet&&currentData.fleet.byServer&&currentData.fleet.byServer[s.name];
      var onlineCount=_fb?((_fb.working!=null)?_fb.working:_fb.online):0;
      var modemCount=_fb?_fb.total:0;
      if(modemCount<onlineCount)modemCount=onlineCount;
      var isOnline=onlineCount>0;
      var sn=esc(s.name);
      var displayName=esc(s.displayName||s.name);

      h+='<div class="server-card" id="srv_'+sn+'">';
      // Header
      h+='<div class="server-header"><div class="server-header-left">';
      h+='<span class="server-id">'+displayName+'</span>';
      if((s.displayName||s.name)!==s.name)h+='<span title="Внутренний неизменяемый ID" style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);background:var(--bg-3);padding:2px 6px;border-radius:7px">'+sn+'</span>';
      h+='<div class="server-country">'+flag+' '+esc(cName)+'</div>';
      h+='<div class="server-meta"><span class="meta-sep"></span>'+modemCount+' модемов<span class="meta-sep"></span>'+onlineCount+' в работе<span id="srvStats_'+sn+'"></span></div>';
      h+='</div>';
      h+='<span class="status-pill '+(isOnline?'online':'offline')+'">'+(isOnline?'ONLINE':'OFFLINE')+'</span>';
      h+='</div>';
      // Body (view mode)
      h+='<div class="server-body" id="srvBody_'+sn+'">';
      h+='<div class="server-field"><div class="server-field-label">API Endpoint</div><div class="server-field-value"><span>'+esc(s.url)+'</span><button class="copy-btn" data-on-click="copyText(this.dataset.text,this)" data-text="'+esc(s.url)+'">'+icon('copy',12)+'</button></div></div>';
      h+='<div class="server-field"><div class="server-field-label">Public IP</div><div class="server-field-value"><span>'+esc(s.publicIp||'—')+'</span>'+(s.publicIp?'<button class="copy-btn" data-on-click="copyText(\''+esc(s.publicIp)+'\',this)">'+icon('copy',12)+'</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель (API)</div><div class="server-field-value"><span>'+esc(s.panelUser||'—')+'</span> / <span id="panelPwdView_'+sn+'">'+(s.panelPassword?'••••••••':'—')+'</span>'+(s.panelPassword?'<button class="toggle-btn" data-on-click="togglePwdView(this,\'panelPwdView_'+sn+'\',\''+esc(s.panelPassword).replace(/'/g,"\\'")+'\')">'+icon('eye',12)+'</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Доступ</div><div class="server-field-value"><span>'+esc(s.osLogin||'—')+(s.sshPort?'<span style="color:var(--text-3)">:'+esc(String(s.sshPort))+'</span>':'')+'</span> / <span id="sshPwdView_'+sn+'">'+(s.osPassword?'••••••••':'—')+'</span>'+(s.osPassword?'<button class="toggle-btn" data-on-click="togglePwdView(this,\'sshPwdView_'+sn+'\',\''+esc(s.osPassword).replace(/'/g,"\\'")+'\')">'+icon('eye',12)+'</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Оборудование</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.hardware?'var(--text-1)':'var(--text-3)')+'">'+esc(s.hardware||'— не указаны —')+'</span></div></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">'+icon('pin',12)+' Адрес локации</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.address?'var(--text-1)':'var(--text-3)')+'">'+esc(s.address||'— не указан —')+'</span></div></div>';
      h+='</div>';
      // Edit body (hidden)
      h+='<div class="server-body" id="srvEdit_'+sn+'" style="display:none">';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">Отображаемое название</div><input class="form-input" id="displayName_'+sn+'" maxlength="60" value="'+displayName+'" placeholder="Например, Кишинёв — Армянская" style="font-size:12px;width:100%"><div style="font-size:10px;color:var(--text-3);margin-top:4px">Внутренний технический код '+sn+' не меняется: так сохраняются история метрик и связи модемов.</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель Логин</div><input class="form-input" id="panelUser_'+sn+'" value="'+esc(s.panelUser||'')+'" placeholder="proxy" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель Пароль</div><input class="form-input" id="panelPass_'+sn+'" value="'+esc(s.panelPassword||'')+'" placeholder="пароль" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Логин</div><input class="form-input" id="osLogin_'+sn+'" value="'+esc(s.osLogin||'')+'" placeholder="root" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Пароль</div><input class="form-input" id="osPass_'+sn+'" value="'+esc(s.osPassword||'')+'" placeholder="пароль (пусто = вход по ключу)" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Порт</div><input class="form-input" id="sshPort_'+sn+'" value="'+esc(s.sshPort?String(s.sshPort):'')+'" placeholder="2222 (пусто = 2222/22)" style="font-size:12px"></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">Оборудование</div><input class="form-input" id="hw_'+sn+'" value="'+esc(s.hardware||'')+'" placeholder="CPU, RAM, Disk, OS..." style="font-size:12px;width:100%"></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">'+icon('pin',12)+' Адрес локации</div><input class="form-input" id="addr_'+sn+'" value="'+esc(s.address||'')+'" placeholder="Город, ул. Примерная, д. 1" style="font-size:12px;width:100%"></div>';
      h+='</div>';
      // Footer
      h+='<div class="server-footer"><div class="server-actions">';
      h+='<button class="btn btn-sm" id="srvEditBtn_'+sn+'" data-on-click="toggleServerEdit(\''+sn+'\')" style="font-size:11px">'+icon('edit',12)+' Редактировать</button>';
      h+='<button class="btn btn-sm" id="srvSaveBtn_'+sn+'" data-on-click="saveServerMeta(\''+sn+'\')" style="font-size:11px;display:none">'+icon('save',12)+' Сохранить</button>';
      h+='<button class="btn btn-sm" id="srvCancelBtn_'+sn+'" data-on-click="toggleServerEdit(\''+sn+'\',true)" style="font-size:11px;display:none">Отмена</button>';
      h+='<span id="srvSaveStatus_'+sn+'" style="font-size:11px;margin-left:6px"></span>';
      h+='</div>';
      h+='</div>';
      h+='</div>';
    });
    el.innerHTML=h;
    _loadServerStats();
  }).catch(function(e){var el=document.getElementById('serversList');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>'})
}
// WP5+WP6: живые плашки RPS + уникальность IP на карточках серверов.
// Отдельный запрос после отрисовки — unique_ips это 14-дн скан (бэкенд кэширует 10 мин).
function _loadServerStats(){
  api(API+'/api/admin/server_stats').then(function(d){
    var st=(d&&d.stats)||{};
    Object.keys(st).forEach(function(name){
      var el=document.getElementById('srvStats_'+name);if(!el)return;
      var s=st[name];if(!s){el.innerHTML='';return}
      var bits='';
      if(s.rps!=null)bits+='<span class="meta-sep"></span><span title="Запросов в секунду по всему боксу (сейчас)">'+icon('bolt',11)+' '+s.rps+' rps</span>';
      if(s.uniqueIpPct!=null)bits+='<span class="meta-sep"></span><span title="Доля уникальных IP среди ротаций за '+(s.uniqDays||14)+' дн ('+(s.rotations||0).toLocaleString('ru-RU')+' ротаций)" style="color:'+(s.uniqueIpPct>=90?'var(--success)':s.uniqueIpPct>=75?'var(--warning)':'var(--danger)')+'">'+s.uniqueIpPct+'% уник. IP</span>';
      el.innerHTML=bits;
    });
  }).catch(function(){/* плашки необязательны */});
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
  var displayName=document.getElementById('displayName_'+name).value;
  var osLogin=document.getElementById('osLogin_'+name).value;
  var osPass=document.getElementById('osPass_'+name).value;
  var panelUser=document.getElementById('panelUser_'+name).value;
  var panelPass=document.getElementById('panelPass_'+name).value;
  var hw=document.getElementById('hw_'+name).value;
  var addr=(document.getElementById('addr_'+name)||{}).value||'';
  var sshPort=(document.getElementById('sshPort_'+name)||{}).value||'';
  var st=document.getElementById('srvSaveStatus_'+name);
  st.textContent='Сохраняю и проверяю Панель...';st.style.color='var(--warning)';
  api(API+'/api/admin/servers/'+name,{method:'PATCH',json:{displayName:displayName,osLogin:osLogin,osPassword:osPass,sshPort:sshPort,panelUser:panelUser,panelPassword:panelPass,hardware:hw,address:addr}}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';setTimeout(function(){loadServersList();loadData()},700)}
    else{st.textContent=(d.error||'Ошибка')+(d.details?' ('+esc(d.details)+')':'');st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'})
}
function addServer(){
  var name=document.getElementById('newSrvName').value.trim();
  var displayName=(document.getElementById('newSrvDisplayName')||{}).value||'';
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
  api(API+'/api/admin/servers',{method:'POST',json:{name:name,displayName:displayName.trim(),url:url,user:user,pass:pass,publicIp:publicIp,country:country,countryName:countryName,tz:tz}}).then(function(d){
    if(d.ok){status.textContent='Добавлен! '+d.modemCount+' модемов';status.style.color='var(--success)';loadServersList();setTimeout(loadData,2000)}
    else{status.textContent=d.error||'Ошибка';status.style.color='var(--danger)'}
  }).catch(function(e){status.textContent=e.message;status.style.color='var(--danger)'})
}

// ========== SETTINGS ==========
var _minSpeedThreshold=2;
var _errorRateThreshold=15;
var _sseSaveSeq=0,_sseSavePending=false,_sseConfirmed=null;

// Чекбокс-пикер ников почасового замера: известные модемы группами по серверу
// («ник — оператор»), ники из текущего CSV вне списка — блоком «неизвестные»,
// чтобы сохранение их не потеряло.
function _renderSpeedtestModemPicker(currentCsv){
  var box=document.getElementById('speedtestModemsBox');
  if(!box)return;
  var selected={};
  String(currentCsv||'').split(',').map(function(t){return t.trim()}).filter(Boolean).forEach(function(n){selected[n]=true});
  api(API+'/api/admin/known_modems').then(function(d){
    var items=(d&&d.items)||[];
    var bySrv={};
    items.forEach(function(m){
      if(!m||!m.nick)return;
      (bySrv[m.server]=bySrv[m.server]||[]).push(m);
    });
    var h='';
    Object.keys(bySrv).sort().forEach(function(srv){
      h+='<div style="margin:8px 0 2px;font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">'+esc(typeof _serverDisplayLabel==='function'?_serverDisplayLabel(srv):srv)+'</div>';
      bySrv[srv].forEach(function(m){
        var on=!!selected[m.nick];
        if(on)delete selected[m.nick];
        h+='<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12px;cursor:pointer"><input type="checkbox" class="speedtest-modem-chk" value="'+esc(m.nick)+'"'+(on?' checked':'')+'> '+esc(m.nick)+(m.operator?'<span style="color:var(--text-3)"> — '+esc(m.operator)+'</span>':'')+'</label>';
      });
    });
    var unknown=Object.keys(selected);
    if(unknown.length){
      h+='<div style="margin:8px 0 2px;font-size:10px;font-weight:700;color:var(--warning);text-transform:uppercase;letter-spacing:.5px">Неизвестные (нет в списке модемов)</div>';
      unknown.forEach(function(n){
        h+='<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12px;cursor:pointer;color:var(--warning)"><input type="checkbox" class="speedtest-modem-chk" value="'+esc(n)+'" checked> '+esc(n)+'</label>';
      });
    }
    box.innerHTML=h||'<div style="font-size:11px;color:var(--text-3)">Модемы не найдены</div>';
  }).catch(function(){
    box.innerHTML='<div style="font-size:11px;color:var(--danger)">Не удалось загрузить список модемов — при сохранении останется текущий CSV</div>';
  });
}
function loadSettings(){
  api(API+'/api/admin/settings').then(function(s){
    // Restore the persisted realtime toggle first. This must not depend on
    // rendering any of the dozens of settings below: an unrelated missing
    // element/renderer used to throw before the old last-line assignment and
    // leave the checkbox visually OFF even while the DB/API value was true.
    var _sseE=document.getElementById('sseEnabledInput');
    if(_sseE&&!_sseSavePending){_sseConfirmed=(s.sse_enabled!==false);_sseE.checked=_sseConfirmed;}
    // Модемы почасового замера: чекбокс-пикер из /api/admin/known_modems
    // (скрытый input — фолбэк для сохранения, если список не загрузился).
    var _smodCsv=s.speedtest_modems||'MD2_40,MD2_44,MD_01,MD_04,MD_10';
    var _smodEl=document.getElementById('speedtestModemsInput');
    if(_smodEl)_smodEl.value=_smodCsv;
    _renderSpeedtestModemPicker(_smodCsv);
    document.getElementById('settingsStatus').textContent='Почасовой замер: '+_smodCsv;
    _minSpeedThreshold=s.min_speed_threshold!=null?s.min_speed_threshold:2;
    document.getElementById('minSpeedInput').value=_minSpeedThreshold;
    _errorRateThreshold=s.error_rate_threshold!=null?s.error_rate_threshold:15;
    var _ertEl=document.getElementById('errorRateThresholdInput');if(_ertEl)_ertEl.value=_errorRateThreshold;
    // Stage 18.8: stale_modem_hours — threshold for "offline modem" exclusion from aggregations.
    var _smhEl=document.getElementById('staleModemHoursInput');if(_smhEl)_smhEl.value=s.stale_modem_hours!=null?s.stale_modem_hours:12;
    window._staleModemHours = s.stale_modem_hours != null ? s.stale_modem_hours : 12;
    // 2026-07-28: modem_offline_threshold_min — минут тишины до статуса «отключен».
    window._offlineThresholdMin = s.modem_offline_threshold_min != null ? s.modem_offline_threshold_min : 10;
    var _motEl=document.getElementById('modemOfflineThresholdInput');if(_motEl)_motEl.value=window._offlineThresholdMin;
    var _paeEl=document.getElementById('proxyAlertErrorPctInput');if(_paeEl)_paeEl.value=s.proxy_alert_error_pct!=null?s.proxy_alert_error_pct:5;
    var _pawEl=document.getElementById('proxyAlertWindowInput');if(_pawEl)_pawEl.value=s.proxy_alert_window_min!=null?s.proxy_alert_window_min:60;
    var _arE=document.getElementById('autoRebootEnabledInput');if(_arE)_arE.checked=!!s.auto_reboot_enabled;
    var _arI=document.getElementById('autoRebootIntervalInput');if(_arI)_arI.value=s.auto_reboot_min_interval_min!=null?s.auto_reboot_min_interval_min:60;
    var _rrE=document.getElementById('randomRebootEnabledInput');if(_rrE)_rrE.checked=(s.random_modem_reboot_enabled!==false);
    var _rcD=document.getElementById('reconcileDaysInput');if(_rcD)_rcD.value=s.reconcile_days||2;
    // Speedtest extended (выборочный почасовой замер — SpeedMonitor)
    var stmEl=document.getElementById('speedtestMaxHistoryInput');if(stmEl)stmEl.value=s.speedtest_max_history||30;
    var smDl=document.getElementById('speedmonRetryDlInput');if(smDl)smDl.value=s.speedmon_retry_dl_threshold!=null?s.speedmon_retry_dl_threshold:5;
    var smRm=document.getElementById('speedmonRetryRoundMinInput');if(smRm)smRm.value=s.speedmon_retry_round_min||5;
    var smRr=document.getElementById('speedmonRetryRoundsInput');if(smRr)smRr.value=s.speedmon_retry_rounds!=null?s.speedmon_retry_rounds:10;
    var smRet=document.getElementById('retSpeedMonitorInput');if(smRet)smRet.value=s.retention_speed_monitor||60;
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
    var tiEl=document.getElementById('trackingIntervalMinInput');if(tiEl)tiEl.value=s.tracking_interval_min||1;
    var rcEl=document.getElementById('rotationCacheTtlInput');if(rcEl)rcEl.value=s.rotation_cache_ttl_min||30;
    var rsEl=document.getElementById('rotationSyncIntervalInput');if(rsEl)rsEl.value=s.rotation_sync_interval_min||30;
    // Retention
    var r1=document.getElementById('retTrafficHourlyInput');if(r1)r1.value=s.retention_traffic_hourly||90;
    var r2=document.getElementById('retAuditLogInput');if(r2)r2.value=s.retention_audit_log||90;
    var r3=document.getElementById('retSystemLogInput');if(r3)r3.value=s.retention_system_log||30;
    var r4=document.getElementById('retRotationLogInput');if(r4)r4.value=s.retention_rotation_log||90;
    var r5=document.getElementById('retProxyChecksInput');if(r5)r5.value=s.retention_modem_ping||30;
    var r6=document.getElementById('retModemMetaInput');if(r6)r6.value=s.retention_modem_meta||30;
    // Session, billing
    var stEl=document.getElementById('sessionTtlDaysInput');if(stEl)stEl.value=s.session_ttl_days||30;
    var brEl=document.getElementById('billingRetryHoursInput');if(brEl)brEl.value=s.billing_retry_delay_hours||1;
    var rtEl=document.getElementById('reconciliationToleranceInput');if(rtEl)rtEl.value=s.reconciliation_tolerance_gb||0.01;
    var acEl=document.getElementById('autoCreateIntervalInput');if(acEl)acEl.value=s.auto_create_interval_min||10;
    // Telegram
    // Токен — секрет (enc1: в kv): GET отдаёт маску '••••••••'. Показываем
    // пустое поле с плейсхолдером; пустое при сохранении = «не менять».
    var tgT=document.getElementById('tgBotToken');
    if(tgT){
      if(s.telegram_bot_token==='••••••••'){tgT.value='';tgT.placeholder='•••••••• (сохранён)';tgT.dataset.masked='1';}
      else{tgT.value=s.telegram_bot_token||'';tgT.placeholder='123456:ABC...';tgT.dataset.masked='';}
    }
    var tgC=document.getElementById('tgChatId');if(tgC)tgC.value=s.telegram_chat_id||'';
    var tgTm=document.getElementById('tgSummaryTime');if(tgTm)tgTm.value=s.telegram_summary_time||'08:00';
    var tgEn=document.getElementById('tgSummaryEnabled');if(tgEn)tgEn.checked=!!s.telegram_summary_enabled;
    // WP5 (B2C Э3): whitelist админов бота + username-fallback
    var tgA=document.getElementById('tgAdminIds');if(tgA)tgA.value=s.telegram_admin_ids||'';
    var tgU=document.getElementById('tgBotUsername');if(tgU)tgU.value=s.telegram_bot_username||'';
    // Розница — секция «Розница» (настройки, алерты, антифрод, рега/письма)
    var ren=document.getElementById('retailEnabledInput');if(ren)ren.checked=!!s.retail_enabled;
    var rtp=document.getElementById('retailTestDayPriceInput');if(rtp)rtp.value=s.retail_test_day_price!=null?s.retail_test_day_price:100;
    var rgh=document.getElementById('retailGraceHoursInput');if(rgh)rgh.value=s.retail_grace_hours||24;
    var rhd=document.getElementById('retailHoldDaysInput');if(rhd)rhd.value=s.retail_hold_days||7;
    var rrl=document.getElementById('retailRegLimitInput');if(rrl)rrl.value=s.retail_reg_limit_per_ip_day||10;
    var rbb=document.getElementById('retailBulkBuyThresholdInput');if(rbb)rbb.value=s.retail_bulk_buy_threshold!=null?s.retail_bulk_buy_threshold:3;
    var rpf=document.getElementById('retailPoolMinFreeInput');if(rpf)rpf.value=s.retail_pool_min_free!=null?s.retail_pool_min_free:3;
    // Шаринг портов (15.08): лимит на SIM + якорный клиент
    var rmc=document.getElementById('retailMaxClientsPerModemInput');if(rmc)rmc.value=s.retail_max_clients_per_modem!=null?s.retail_max_clients_per_modem:1;
    var rsa=document.getElementById('retailShareAnchorLoginInput');if(rsa)rsa.value=s.retail_share_anchor_login||'';
    var dgs=document.getElementById('domainGuardSuspendHitsInput');if(dgs)dgs.value=s.domain_guard_suspend_hits!=null?s.domain_guard_suspend_hits:1;
    var asb=document.getElementById('abuseStrikesBlockInput');if(asb)asb.value=s.abuse_strikes_block!=null?s.abuse_strikes_block:2;
    var rma=document.getElementById('retailMaxAccountsPerIpInput');if(rma)rma.value=s.retail_max_accounts_per_ip!=null?s.retail_max_accounts_per_ip:2;
    var rmu=document.getElementById('retailMinUniqueIpsInput');if(rmu)rmu.value=s.retail_min_unique_ips!=null?s.retail_min_unique_ips:50;
    // Turnstile + SendPulse (секреты — маска GET: пустое поле при сохранении = не менять)
    var tsk=document.getElementById('turnstileSiteKeyInput');if(tsk)tsk.value=s.turnstile_site_key||'';
    var tsec=document.getElementById('turnstileSecretKeyInput');
    if(tsec){if(s.turnstile_secret_key==='••••••••'){tsec.value='';tsec.dataset.masked='1';}else{tsec.value=s.turnstile_secret_key||'';tsec.dataset.masked='';}}
    var spU=document.getElementById('sendpulseUserInput');if(spU)spU.value=s.sendpulse_smtp_user||'';
    var spP=document.getElementById('sendpulsePassInput');
    if(spP){if(s.sendpulse_smtp_pass==='••••••••'){spP.value='';spP.dataset.masked='1';}else{spP.value=s.sendpulse_smtp_pass||'';spP.dataset.masked='';}}
    var spF=document.getElementById('sendpulseFromInput');if(spF)spF.value=s.sendpulse_from||'';
    // Twenty CRM DSN — секрет (enc1:), та же схема маски, что у SMTP-пароля
    var crmD=document.getElementById('crmDbUrlInput');
    if(crmD){if(s.crm_db_url==='••••••••'){crmD.value='';crmD.dataset.masked='1';}else{crmD.value=s.crm_db_url||'';crmD.dataset.masked='';}}
    // Доменный контроль: боксы (CSV)
    var dgs2=document.getElementById('domainGuardServersInput');if(dgs2)dgs2.value=s.domain_guard_servers||'';
    // Telegram-доп.: публичный URL, AI-инсайты, Anthropic key (маска)
    var puI=document.getElementById('publicUrlInput');if(puI)puI.value=s.public_url||'';
    var aiE=document.getElementById('aiInsightsEnabledInput');if(aiE)aiE.checked=(s.ai_insights_enabled!==false);
    var anK=document.getElementById('anthropicApiKeyInput');
    if(anK){if(s.anthropic_api_key==='••••••••'){anK.value='';anK.dataset.masked='1';}else{anK.value=s.anthropic_api_key||'';anK.dataset.masked='';}}
    // Авто-ребут: порог алерта по reboot score
    var rbs=document.getElementById('rebootScoreAlertInput');if(rbs)rbs.value=s.reboot_score_alert_threshold!=null?s.reboot_score_alert_threshold:70;
    // Хранение: топ-хосты доменного контроля
    var rth=document.getElementById('retTopHostsDailyInput');if(rth)rth.value=s.retention_top_hosts_daily||90;
    // Симулятор нагрузки
    var simE=document.getElementById('simEnabledInput');if(simE)simE.checked=!!s.simulator_enabled;
    var simW=document.getElementById('simMaxWorkersInput');if(simW)simW.value=s.simulator_max_workers||50;
    var simS=document.getElementById('simMaxSseInput');if(simS)simS.value=s.simulator_max_sse||10;
    var simD=document.getElementById('simMaxDurationInput');if(simD)simD.value=s.simulator_max_duration_min||30;
    if(currentData) currentData.settings = s;
    renderPricingTiers();
    if(window._operatorsList)opPkgRender(s);
    else refreshOperatorList().then(function(){opPkgRender(s);});
    opPkgLoadForecasts();
    var _vE=document.getElementById('volumeEnabledInput');if(_vE)_vE.checked=(s.volume_enabled!==false);
    // B2 (23.08): TTL кнопки «В работе» (секция «Уведомления»)
    var _ackT=document.getElementById('ackTtlHoursInput');if(_ackT)_ackT.value=s.ack_ttl_hours!=null?s.ack_ttl_hours:2;
  }).catch(function(){});
}
// Live-проверка кредов при сохранении (15.08): сервер возвращает cred_checks
// (проверка прошла) и cred_warnings (проверка не состоялась по сети — креды
// сохранены, но не подтверждены). Фатальные ошибки приходят как d.error.
function showCredVerdict(d){
  if(!d)return;
  (d.cred_checks||[]).forEach(function(m){showToast(m,'success')});
  (d.cred_warnings||[]).forEach(function(m){showToast(m,'warning')});
}
// Telegram: save fields when changed (debounced)
function tgSaveSettings(){
  var tgT=document.getElementById('tgBotToken');
  var anK=document.getElementById('anthropicApiKeyInput');
  var data={
    telegram_chat_id:(document.getElementById('tgChatId').value||'').trim(),
    telegram_summary_time:(document.getElementById('tgSummaryTime').value||'').trim(),
    telegram_summary_enabled:!!document.getElementById('tgSummaryEnabled').checked,
    telegram_admin_ids:(document.getElementById('tgAdminIds').value||'').trim(),
    telegram_bot_username:(document.getElementById('tgBotUsername').value||'').trim(),
    public_url:(document.getElementById('publicUrlInput').value||'').trim(),
    ai_insights_enabled:!!document.getElementById('aiInsightsEnabledInput').checked
  };
  // Токен: при замаскированном значении пустое поле = «не менять» (иначе
  // сохранение нетронутой формы затирало бы реальный токен enc1:).
  var tok=(tgT.value||'').trim();
  if(tok||!tgT.dataset.masked) data.telegram_bot_token=tok;
  // Anthropic key — та же схема маски.
  if(anK){var ak=(anK.value||'').trim();if(ak||!anK.dataset.masked)data.anthropic_api_key=ak;}
  return api(API+'/api/admin/settings',{method:'PUT',json:data});
}
// Розница: общие настройки + алерты/антифрод (секция «Розница»).
function saveRetailSettings(){
  function _num(id,def,min,max){var v=parseInt(document.getElementById(id).value);if(isNaN(v))v=def;return Math.max(min,Math.min(max,v))}
  var data={
    retail_enabled:!!document.getElementById('retailEnabledInput').checked,
    retail_test_day_price:_num('retailTestDayPriceInput',100,0,100000),
    retail_grace_hours:_num('retailGraceHoursInput',24,1,720),
    retail_hold_days:_num('retailHoldDaysInput',7,1,365),
    retail_reg_limit_per_ip_day:_num('retailRegLimitInput',10,1,1000),
    retail_bulk_buy_threshold:_num('retailBulkBuyThresholdInput',3,0,100),
    retail_pool_min_free:_num('retailPoolMinFreeInput',0,0,1000),
    retail_max_clients_per_modem:_num('retailMaxClientsPerModemInput',1,1,20),
    retail_share_anchor_login:((document.getElementById('retailShareAnchorLoginInput')||{}).value||'').trim(),
    domain_guard_suspend_hits:_num('domainGuardSuspendHitsInput',1,0,1000),
    abuse_strikes_block:_num('abuseStrikesBlockInput',2,1,100),
    retail_max_accounts_per_ip:_num('retailMaxAccountsPerIpInput',2,0,100),
    retail_min_unique_ips:_num('retailMinUniqueIpsInput',50,0,100),
    domain_guard_servers:(document.getElementById('domainGuardServersInput').value||'').trim()
  };
  var st=document.getElementById('retailSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';showToast('Настройки розницы сохранены','success');loadTariffsAdmin()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
// Розница: Turnstile + SendPulse (секреты — пустое замаскированное поле = не менять).
function saveRetailInfraSettings(){
  var tsec=document.getElementById('turnstileSecretKeyInput');
  var spP=document.getElementById('sendpulsePassInput');
  var data={
    turnstile_site_key:(document.getElementById('turnstileSiteKeyInput').value||'').trim(),
    sendpulse_smtp_user:(document.getElementById('sendpulseUserInput').value||'').trim(),
    sendpulse_from:(document.getElementById('sendpulseFromInput').value||'').trim()
  };
  var ts=(tsec.value||'').trim(); if(ts||!tsec.dataset.masked)data.turnstile_secret_key=ts;
  var sp=(spP.value||'').trim(); if(sp||!spP.dataset.masked)data.sendpulse_smtp_pass=sp;
  // Twenty CRM DSN — секрет, та же схема маски.
  var crmD=document.getElementById('crmDbUrlInput');
  if(crmD){var cd=(crmD.value||'').trim();if(cd||!crmD.dataset.masked)data.crm_db_url=cd;}
  var st=document.getElementById('retailInfraStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';showToast('Настройки регистрации сохранены','success');showCredVerdict(d)}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
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
    if(d.ok){st.innerHTML=icon('check',12)+' Отправлено за '+esc(d.date);st.style.color='var(--success)';showToast('Сводка отправлена в Telegram','success')}
    else{st.innerHTML=icon('x',12)+' '+esc(d.error||'Ошибка');st.style.color='var(--danger)';showToast(d.error||'Ошибка','error')}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)';showToast(e.message,'error')});
}
function saveProxyCheckSettings(){
  var palErrPct=parseFloat(document.getElementById('proxyAlertErrorPctInput').value)||5;
  var palWindow=parseInt(document.getElementById('proxyAlertWindowInput').value)||60;
  api(API+'/api/admin/settings',{method:'PUT',json:{proxy_alert_error_pct:palErrPct,proxy_alert_window_min:palWindow}}).then(function(d){
    if(d.ok){showToast('Порог сбоев пинга сохранён','success');document.getElementById('proxyCheckSettingsStatus').textContent='Сохранено: потери >'+palErrPct+'% за '+palWindow+' мин';renderTable()}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}
function saveSettings(){
  // Ники модемов почасового замера: отмеченные чекбоксы → CSV; если пикер не
  // отрендерился (ошибка загрузки) — фолбэк на скрытый input с текущим CSV.
  // Раздел «Спидтесты»: только замер скорости и подсветка в таблицах.
  // Пороги «Сбоит прокси» — saveProxyCheckSettings, авто-ребут —
  // saveRecoverySettings, пороги оффлайна — saveAlertThresholds,
  // reconcile_days — saveSessionBillingSettings.
  var modems;
  var chks=document.querySelectorAll('.speedtest-modem-chk');
  if(chks.length){
    modems=[].slice.call(chks).filter(function(c){return c.checked}).map(function(c){return c.value});
  }else{
    var modemsRaw=(document.getElementById('speedtestModemsInput')||{}).value||'';
    modems=modemsRaw.split(',').map(function(t){return t.trim()}).filter(Boolean);
  }
  if(modems.some(function(n){return !/^[\w-]{1,64}$/.test(n)})){showToast('Ники: только латиница, цифры, _ и -','error');return}
  var minSpeed=parseFloat(document.getElementById('minSpeedInput').value)||2;
  var errThresh=parseInt(document.getElementById('errorRateThresholdInput').value)||15;
  var maxHist=parseInt(document.getElementById('speedtestMaxHistoryInput').value)||30;
  var smDl=parseFloat(document.getElementById('speedmonRetryDlInput').value)||5;
  var smRm=parseInt(document.getElementById('speedmonRetryRoundMinInput').value)||5;
  var smRr=parseInt(document.getElementById('speedmonRetryRoundsInput').value);
  if(isNaN(smRr))smRr=10;
  var smRet=parseInt(document.getElementById('retSpeedMonitorInput').value)||60;
  _minSpeedThreshold=minSpeed;
  _errorRateThreshold=errThresh;
  api(API+'/api/admin/settings',{method:'PUT',json:{speedtest_modems:modems.join(','),min_speed_threshold:minSpeed,error_rate_threshold:errThresh,speedtest_max_history:maxHist,speedmon_retry_dl_threshold:smDl,speedmon_retry_round_min:smRm,speedmon_retry_rounds:smRr,retention_speed_monitor:smRet}}).then(function(d){
    if(d.ok){showToast('Настройки сохранены','success');document.getElementById('settingsStatus').textContent='Почасовой замер: '+(modems.join(', ')||'дефолтный список')+' — применится со следующего часа';renderTable()}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message,'error')});
}
// Раздел «Уведомления» → «Пороги доступности модемов»: stale_modem_hours +
// modem_offline_threshold_min (исключение из агрегаций и TG-алерты оффлайна).
function saveAlertThresholds(){
  var staleH=parseInt(document.getElementById('staleModemHoursInput').value)||12;
  var offThMin=parseInt((document.getElementById('modemOfflineThresholdInput')||{}).value)||10;
  window._staleModemHours=staleH;
  window._offlineThresholdMin=offThMin;
  var st=document.getElementById('alertThresholdsStatus');
  if(st){st.textContent='Сохраняю...';st.style.color='var(--warning)';}
  api(API+'/api/admin/settings',{method:'PUT',json:{stale_modem_hours:staleH,modem_offline_threshold_min:offThMin}}).then(function(d){
    if(d.ok){if(st){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';}showToast('Пороги доступности сохранены','success');renderTable()}
    else{if(st){st.textContent=d.error||'Ошибка';st.style.color='var(--danger)';}showToast(d.error||'Ошибка','error');}
  }).catch(function(e){if(st){st.textContent=e.message;st.style.color='var(--danger)';}showToast(e.message,'error')});
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
  var rndReboot=(document.getElementById('randomRebootEnabledInput')||{}).checked!==false;
  // Авто-ребут проблемных (группа в той же карточке «Восстановление»).
  var arEnabled=!!(document.getElementById('autoRebootEnabledInput')||{}).checked;
  var arInterval=parseInt((document.getElementById('autoRebootIntervalInput')||{}).value)||60;
  var rbs=parseInt((document.getElementById('rebootScoreAlertInput')||{}).value);
  if(isNaN(rbs))rbs=70;
  var st=document.getElementById('recoverySettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{recovery_enabled:enabled,recovery_offline_sec:offline,recovery_max_attempts:maxAtt,recovery_retry_min:retryMin,recovery_daily_cap:dailyCap,recovery_readd_after:readdAfter,recovery_skip_dead_sim:skipDeadSim,recovery_skip_unsold:skipUnsold,random_modem_reboot_enabled:rndReboot,auto_reboot_enabled:arEnabled,auto_reboot_min_interval_min:arInterval,reboot_score_alert_threshold:rbs}}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveTrackingSettings(){
  var tracking=parseInt(document.getElementById('trackingIntervalMinInput').value)||1;
  var cacheTtl=parseInt(document.getElementById('rotationCacheTtlInput').value)||30;
  var syncInt=parseInt(document.getElementById('rotationSyncIntervalInput').value)||30;
  var st=document.getElementById('trackingSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{tracking_interval_min:tracking,rotation_cache_ttl_min:cacheTtl,rotation_sync_interval_min:syncInt}}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveRetentionSettings(){
  var data={
    retention_traffic_hourly:parseInt(document.getElementById('retTrafficHourlyInput').value)||90,
    retention_audit_log:parseInt(document.getElementById('retAuditLogInput').value)||90,
    retention_system_log:parseInt(document.getElementById('retSystemLogInput').value)||30,
    retention_rotation_log:parseInt(document.getElementById('retRotationLogInput').value)||90,
    retention_modem_ping:parseInt(document.getElementById('retProxyChecksInput').value)||30,
    retention_modem_meta:parseInt(document.getElementById('retModemMetaInput').value)||30,
    retention_top_hosts_daily:parseInt((document.getElementById('retTopHostsDailyInput')||{}).value)||90
  };
  var st=document.getElementById('retentionSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)'}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function saveSessionBillingSettings(){
  var data={
    session_ttl_days:parseInt(document.getElementById('sessionTtlDaysInput').value)||30,
    billing_retry_delay_hours:parseFloat(document.getElementById('billingRetryHoursInput').value)||1,
    reconciliation_tolerance_gb:parseFloat(document.getElementById('reconciliationToleranceInput').value)||0.01,
    auto_create_interval_min:parseInt(document.getElementById('autoCreateIntervalInput').value)||10,
    reconcile_days:parseInt((document.getElementById('reconcileDaysInput')||{}).value)||2
  };
  var st=document.getElementById('sessionBillingSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';_showRestartBanner()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
// Симулятор нагрузки (секция «Симулятор»): включение + потолки прогона.
function saveSimulatorSettings(){
  var data={
    simulator_enabled:!!document.getElementById('simEnabledInput').checked,
    simulator_max_workers:parseInt(document.getElementById('simMaxWorkersInput').value)||50,
    simulator_max_sse:parseInt(document.getElementById('simMaxSseInput').value)||10,
    simulator_max_duration_min:parseInt(document.getElementById('simMaxDurationInput').value)||30
  };
  var st=document.getElementById('simSettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:data}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';if(typeof initSimulator==='function')initSimulator()}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}

// ========== DOCUMENTS ==========

// ========== A4 (23.08): Пакеты операторов (объёмные алерты) ==========
// JSON-массив в настройке operator_packages; сохранение без рестарта.
function _opPkgParse(s){
  try{var a=JSON.parse((s&&s.operator_packages)||'[]');return Array.isArray(a)?a:[];}
  catch(e){return [];}
}
function _opPkgOptions(selected){
  var names=[];
  (window._operatorsList||[]).forEach(function(o){
    var n=String(o.operator||'').trim();
    if(n&&!names.some(function(x){return x.toLowerCase()===n.toLowerCase()}))names.push(n);
  });
  if(selected&&!names.some(function(x){return x.toLowerCase()===String(selected).toLowerCase()}))names.push(String(selected));
  names.sort(function(a,b){return a.localeCompare(b,'ru',{sensitivity:'base'});});
  return '<option value="">Выберите оператора</option>'+names.map(function(n){return '<option value="'+esc(n)+'"'+(String(n).toLowerCase()===String(selected||'').toLowerCase()?' selected':'')+'>'+esc(n)+'</option>';}).join('');
}
var _opPkgForecasts=[];
function _opPkgForecastText(operator,type){
  if(type==='unlimited')return '∞ безлимит';
  var op=String(operator||'').toLowerCase();
  var rows=_opPkgForecasts.filter(function(f){return String(f.operator||'').toLowerCase()===op;});
  if(!rows.length)return 'нет данных';
  var known=rows.filter(function(f){return f.days_left!=null;}).sort(function(a,b){return a.days_left-b.days_left;});
  if(!known.length)return rows.some(function(f){return f.status==='not_configured';})?'задайте объём':'нет расхода';
  var f=known[0],days=Math.max(0,Math.round(f.days_left));
  var reset=f.reset_date?' · обновление '+String(f.reset_date).slice(8,10)+'.'+String(f.reset_date).slice(5,7):'';
  return '~'+days+' д'+(f.scope==='sim'&&f.nick?' · '+f.nick:'')+reset;
}
function opPkgLoadForecasts(){
  api(API+'/api/admin/operator-package-forecast').then(function(d){
    _opPkgForecasts=(d&&d.forecasts)||[];
    document.querySelectorAll('#opPkgRows .op-pkg-row').forEach(function(r){
      var cell=r.querySelector('.opp-forecast');
      if(cell)cell.textContent=_opPkgForecastText(r.querySelector('.opp-op').value,r.querySelector('.opp-type').value);
    });
  }).catch(function(){});
}
function _opPkgMeta(operator){
  var key=String(operator||'').toLowerCase();
  return (window._operatorsList||[]).find(function(o){return String(o.operator||o.operator_normalized||'').toLowerCase()===key;})||{};
}
function _opPkgCurrency(p,operator){
  if(p&&['RUB','MDL','RON'].indexOf(String(p.currency||'').toUpperCase())>=0)return String(p.currency).toUpperCase();
  var c=_opPkgMeta(operator).country;
  return c==='MD'?'MDL':c==='RO'?'RON':'RUB';
}
function _opPkgCollectRow(r){
  var type=r.querySelector('.opp-type').value;
  return {operator:r.querySelector('.opp-op').value.trim(),type:type,
    volume_gb:type==='unlimited'?0:(parseFloat(r.querySelector('.opp-vol').value)||0),
    max_sims:type==='per_sim'?1:type==='shared'?(parseInt(r.querySelector('.opp-max').value,10)||0):0,
    price:parseFloat(r.querySelector('.opp-price').value)||0,
    currency:r.querySelector('.opp-cur').value,
    hourly_gb:parseFloat(r.querySelector('.opp-hour').value)||0,
    pace_pct:type==='unlimited'?0:(parseFloat(r.querySelector('.opp-pace').value)||0),
    renewal_day:Math.min(31,Math.max(1,parseInt(r.querySelector('.opp-renewal').value,10)||1))};
}
function opPkgRecalcRow(row){
  if(!row)return;
  var p=_opPkgCollectRow(row),meta=_opPkgMeta(p.operator),sim=Number(meta.modem_count)||0;
  var units=p.type==='unlimited'?(sim>0?1:0):p.type==='per_sim'?sim:(sim===0?0:(p.max_sims>0?Math.ceil(sim/p.max_sims):null));
  var total=units==null?null:Math.round(units*p.price*100)/100;
  var capacity=p.type==='unlimited'?null:(units==null?null:Math.round(units*p.volume_gb*10)/10);
  var set=function(sel,value){row.querySelectorAll(sel).forEach(function(el){el.textContent=value;});};
  set('.opp-sim-count',sim+' SIM');
  set('.opp-unit-label',p.type==='per_sim'?'SIM к оплате':'К оплате бандлов');
  set('.opp-bundle-count',units==null?'—':p.type==='per_sim'?units+' SIM':units+' '+(units===1?'бандл':'бандла'));
  set('.opp-total',total==null?'заполните лимит':total.toLocaleString('ru-RU')+' '+p.currency+'/мес');
  set('.opp-total-label',p.type==='unlimited'?'Фиксированная цена':'Оплата оператору');
  set('.opp-capacity',p.type==='unlimited'?(sim>0?'безлимитный трафик':'нет активных SIM'):capacity==null?'объём не рассчитан':capacity.toLocaleString('ru-RU')+' ГБ всего');
  var missing=[];if(!(p.price>0))missing.push('цена');if(p.type==='shared'&&!(p.max_sims>0))missing.push('SIM в бандле');if(p.type!=='unlimited'&&!(p.volume_gb>0))missing.push('объём');
  var note=row.querySelector('.opp-missing');
  if(note){note.textContent=missing.length?'Нужно заполнить: '+missing.join(', '):'Расчёт заполнен';note.classList.toggle('is-ok',!missing.length);}
  var forecast=row.querySelector('.opp-forecast');
  if(forecast)forecast.textContent=_opPkgForecastText(p.operator,p.type);
}
function opPkgTypeChanged(row){
  if(!row)return;
  var type=row.querySelector('.opp-type').value,unlimited=type==='unlimited',perSim=type==='per_sim';
  var shared=type==='shared',volume=row.querySelector('.opp-vol'),pace=row.querySelector('.opp-pace'),max=row.querySelector('.opp-max');
  row.dataset.packageType=type;
  var fields=row.querySelector('.opp-fields');if(fields)fields.className='opp-fields fields-'+(unlimited?'1':perSim?'2':'3');
  var volumeField=row.querySelector('.opp-field-volume'),maxField=row.querySelector('.opp-field-max');
  if(volumeField)volumeField.style.display=unlimited?'none':'';
  if(maxField)maxField.style.display=shared?'':'none';
  var priceLabel=row.querySelector('.opp-price-label');if(priceLabel)priceLabel.textContent=unlimited?'Цена в месяц':perSim?'Цена за SIM в месяц':'Цена бандла в месяц';
  var volumeLabel=row.querySelector('.opp-volume-label');if(volumeLabel)volumeLabel.textContent=perSim?'Трафик на SIM':'Общий трафик бандла';
  volume.disabled=unlimited;pace.disabled=unlimited;volume.placeholder='ГБ';
  max.disabled=!shared;if(perSim)max.value='1';if(unlimited)max.value='';
  var calc=row.querySelector('.opp-calc');if(calc)calc.classList.toggle('is-unlimited',unlimited);
  opPkgRecalcRow(row);
}
function opPkgRender(s){
  var box=document.getElementById('opPkgRows');if(!box)return;
  var pkgs=_opPkgParse(s),h='';
  pkgs.forEach(function(p,i){
    var type=p.type==='shared'||p.type==='unlimited'?p.type:'per_sim',unlimited=type==='unlimited',perSim=type==='per_sim';
    var meta=_opPkgMeta(p.operator),sim=Number(meta.modem_count)||0,cur=_opPkgCurrency(p,p.operator),max=perSim?1:type==='shared'?(Number(p.max_sims)||0):'';
    h+='<article class="op-pkg-row">'
      +'<div class="opp-head"><div class="opp-title"><select class="input opp-op" data-on-change="opPkgRecalcRow(this.closest(\'.op-pkg-row\'))">'+_opPkgOptions(p.operator||'')+'</select><span class="opp-live"><i></i><span class="opp-sim-count">'+sim+' SIM</span> из базы</span></div>'
      +'<div class="opp-head-actions"><select class="input opp-type" data-on-change="opPkgTypeChanged(this.closest(\'.op-pkg-row\'))"><option value="per_sim"'+(perSim?' selected':'')+'>На SIM</option><option value="shared"'+(type==='shared'?' selected':'')+'>Бандл</option><option value="unlimited"'+(unlimited?' selected':'')+'>Безлимит</option></select><button class="opp-remove" data-on-click="opPkgDelRow(this)" title="Удалить пакет">×</button></div></div>'
      +'<div class="opp-fields">'
      +'<label class="opp-field-price"><span class="opp-price-label">Цена бандла в месяц</span><div class="opp-input-pair"><input class="input opp-price" type="number" min="0" step="0.01" value="'+(p.price||'')+'" placeholder="0" data-on-input="opPkgRecalcRow(this.closest(\'.op-pkg-row\'))"><select class="input opp-cur" data-on-change="opPkgRecalcRow(this.closest(\'.op-pkg-row\'))"><option value="RUB"'+(cur==='RUB'?' selected':'')+'>RUB</option><option value="MDL"'+(cur==='MDL'?' selected':'')+'>MDL</option><option value="RON"'+(cur==='RON'?' selected':'')+'>RON</option></select></div></label>'
      +'<label class="opp-field-volume"><span class="opp-volume-label">Общий трафик бандла</span><div class="opp-input-unit"><input class="input opp-vol" type="number" min="0" value="'+(unlimited?'':(Number(p.volume_gb)||''))+'" placeholder="ГБ" data-on-input="opPkgRecalcRow(this.closest(\'.op-pkg-row\'))"><b>ГБ</b></div></label>'
      +'<label class="opp-field-max"><span>Максимум SIM в бандле</span><div class="opp-input-unit"><input class="input opp-max" type="number" min="1" step="1" value="'+max+'" placeholder="шт" data-on-input="opPkgRecalcRow(this.closest(\'.op-pkg-row\'))"><b>SIM</b></div></label>'
      +'</div>'
      +'<div class="opp-calc"><div class="opp-calc-connected"><span>Подключено</span><b class="opp-sim-count">'+sim+' SIM</b></div><em>→</em><div class="opp-calc-units"><span class="opp-unit-label">К оплате бандлов</span><b class="opp-bundle-count">—</b></div><em>→</em><div class="is-total"><span class="opp-total-label">Оплата оператору</span><b class="opp-total">—</b><small class="opp-capacity"></small></div></div>'
      +'<div class="opp-foot"><span class="opp-missing"></span><span>Прогноз: <b class="opp-forecast">'+esc(_opPkgForecastText(p.operator,type))+'</b></span></div>'
      +'<details class="opp-advanced"><summary>Обновление тарифа и пороги</summary><div><label>День обновления тарифа <input class="input opp-renewal" type="number" min="1" max="31" step="1" value="'+(Math.min(31,Math.max(1,parseInt(p.renewal_day,10)||1)))+'" placeholder="1" title="Число месяца, когда оператор обнуляет пакет. Остаток и темп считаются от этой даты"></label><label>Аномалия за час, ГБ <input class="input opp-hour" type="number" min="0" value="'+(p.hourly_gb||'')+'" placeholder="авто"></label><label>Темп пакета, %/сут <input class="input opp-pace" type="number" min="0" max="100" value="'+(unlimited?0:(p.pace_pct||0))+'" '+(unlimited?'disabled ':'')+'placeholder="0"></label></div></details>'
      +'</article>';
  });
  box.innerHTML='<div class="op-pkg-list">'+h+(pkgs.length?'':'<div class="opp-empty">Пакеты не заданы — добавьте оператора</div>')+'</div>';
  box.querySelectorAll('.op-pkg-row').forEach(function(row){opPkgTypeChanged(row);});
}
function opPkgAddRow(){
  var box=document.getElementById('opPkgRows');if(!box)return;
  var cur=[];box.querySelectorAll('.op-pkg-row').forEach(function(r){
    cur.push(_opPkgCollectRow(r));
  });
  cur.push({operator:'',type:'per_sim',volume_gb:0,max_sims:1,price:0,currency:'RUB',hourly_gb:0,pace_pct:0,renewal_day:1});
  opPkgRender({operator_packages:JSON.stringify(cur)});
}
function opPkgDelRow(btn){
  var row=btn.closest('.op-pkg-row');if(row)row.remove();
}
function opPkgSave(){
  var rows=[];var bad=false;
  document.querySelectorAll('#opPkgRows .op-pkg-row').forEach(function(r){
    var p=_opPkgCollectRow(r),op=p.operator;
    if(!op){bad=true;return;}
    rows.push(p);
  });
  var st=document.getElementById('opPkgStatus');
  if(bad){st.textContent='Заполните имя оператора в каждой строке';st.style.color='var(--danger)';return;}
  var seen={};for(var i=0;i<rows.length;i++){var key=rows[i].operator.toLowerCase();if(seen[key]){st.textContent='Оператор «'+rows[i].operator+'» добавлен дважды';st.style.color='var(--danger)';return;}seen[key]=true;}
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{
    operator_packages:JSON.stringify(rows),
    volume_enabled:!!document.getElementById('volumeEnabledInput').checked
  }}).then(function(d){
    if(d.ok){var incomplete=rows.filter(function(p){return !(p.price>0)||(p.type==='shared'&&!(p.max_sims>0))||(p.type!=='unlimited'&&!(p.volume_gb>0));}).length;st.innerHTML='Сохранено '+icon('check',12)+(incomplete?' · нужно дополнить пакетов: '+incomplete:' · оплата пересчитана автоматически');st.style.color=incomplete?'var(--warning)':'var(--success)';if(currentData)currentData.settings=d.settings||currentData.settings;opPkgLoadForecasts();}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)';}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)';});
}

// ========== B2 (23.08): TTL «В работе» для ack-кнопок алертов ==========
function saveAckTtl(){
  var ttl=parseInt(document.getElementById('ackTtlHoursInput').value)||2;
  if(ttl<1||ttl>72){showToast('TTL: от 1 до 72 часов','error');return}
  var st=document.getElementById('ackTtlSaveHint');
  api(API+'/api/admin/settings',{method:'PUT',json:{ack_ttl_hours:ttl}}).then(function(d){
    if(d.ok){if(st)st.textContent='Сохранено';setTimeout(function(){if(st)st.textContent=''},2500);showToast('TTL «В работе» сохранён','success')}
    else{if(st)st.textContent=d.error||'Ошибка';showToast(d.error||'Ошибка','error')}
  }).catch(function(e){if(st)st.textContent=e.message;showToast(e.message,'error')});
}

// ========== SSE (23.08): realtime-обновления админки ==========
function saveSseEnabled(v){
  var seq=++_sseSaveSeq;
  var el=document.getElementById('sseEnabledInput');
  _sseSavePending=true;if(el){el.disabled=true;el.checked=!!v;}
  api(API+'/api/admin/settings',{method:'PUT',json:{sse_enabled:!!v}}).then(function(d){
    if(seq!==_sseSaveSeq)return;
    _sseSavePending=false;if(el)el.disabled=false;
    if(d&&d.ok){
      var actual=d.settings?(d.settings.sse_enabled!==false):!!v;
      _sseConfirmed=actual;if(el)el.checked=actual;
      if(currentData){currentData.settings=currentData.settings||{};currentData.settings.sse_enabled=actual;}
      if(typeof window.setAdminSseEnabled==='function')window.setAdminSseEnabled(actual);
      showToast(actual?'Realtime-обновления включены':'Realtime выключен — обновление по таймеру','success');
    }else{
      if(el&&_sseConfirmed!==null)el.checked=_sseConfirmed;
      showToast(d&&d.error||'Настройка не сохранилась','error');
    }
  }).catch(function(e){
    if(seq!==_sseSaveSeq)return;
    _sseSavePending=false;if(el){el.disabled=false;if(_sseConfirmed!==null)el.checked=_sseConfirmed;}
    showToast(e.message,'error');
  });
}

// ========== B3 (23.08): окна обслуживания ==========
function _maintFmt(ts){
  var d=new Date(ts);
  if(!isFinite(d.getTime()))return '—';
  return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
// Подсказки в поле «Объект»: сервера из fleet, модемы — известные ники.
function _maintFillTargets(){
  var dl=document.getElementById('maintTargetList');if(!dl)return;
  var type=(document.getElementById('maintTypeInput')||{}).value||'server';
  var h='';
  if(type==='server'){
    var bs=(currentData&&currentData.fleet&&currentData.fleet.byServer)||{};
    Object.keys(bs).sort().forEach(function(s){h+='<option value="'+esc(s)+'">';});
    dl.innerHTML=h;
  }else{
    api(API+'/api/admin/known_modems').then(function(d){
      var items=(d&&d.items)||[];
      var seen={};
      items.forEach(function(m){if(m&&m.nick&&!seen[m.nick]){seen[m.nick]=1;h+='<option value="'+esc(m.nick)+'">';}});
      dl.innerHTML=h;
    }).catch(function(){});
  }
}
function loadMaintenanceWindows(){
  var box=document.getElementById('maintList');if(!box)return;
  _maintFillTargets();
  api(API+'/api/admin/maintenance').then(function(d){
    var ws=(d&&d.windows)||[];
    var now=Date.now();
    if(!ws.length){box.innerHTML='<div style="color:var(--text-3);font-size:12px;padding:14px;text-align:center">Окон нет</div>';return}
    var h='';
    ws.forEach(function(w,i){
      var active=w.from_ts<=now&&now<=w.to_ts;
      var future=w.from_ts>now;
      var st=active?'<span style="color:var(--success);font-weight:600">активно</span>'
        :future?'<span style="color:var(--text-2)">будущее</span>'
        :'<span style="color:var(--text-3)">завершено</span>';
      h+='<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;font-size:12px'+(i?';border-top:1px solid var(--border)':'')+'">'
        +'<span style="font-family:var(--font-mono);font-weight:600">'+esc(w.target_id)+'</span>'
        +'<span style="color:var(--text-3);font-size:10px">'+(w.target_type==='server'?'сервер':'модем')+'</span>'
        +'<span style="color:var(--text-2)">'+_maintFmt(w.from_ts)+' — '+_maintFmt(w.to_ts)+'</span>'
        +st
        +(w.comment?'<span style="color:var(--text-3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.comment)+'</span>':'<span style="flex:1"></span>')
        +(w.created_by?'<span style="color:var(--text-3);font-size:10px">'+esc(w.created_by)+'</span>':'')
        +'<button class="btn btn-sm" style="padding:2px 8px;color:var(--danger)" data-on-click="deleteMaintenanceWindow('+w.id+')" title="Удалить окно">×</button></div>';
    });
    box.innerHTML=h;
  }).catch(function(e){box.innerHTML='<div style="color:var(--danger);font-size:12px;padding:14px">Ошибка: '+esc(e.message)+'</div>'});
}
function createMaintenanceWindow(){
  var type=document.getElementById('maintTypeInput').value;
  var target=(document.getElementById('maintTargetInput').value||'').trim();
  var fromV=document.getElementById('maintFromInput').value;
  var toV=document.getElementById('maintToInput').value;
  var comment=(document.getElementById('maintCommentInput').value||'').trim();
  var st=document.getElementById('maintCreateStatus');
  if(!target){st.textContent='Укажите объект (сервер или ник модема)';st.style.color='var(--danger)';return}
  var fromTs=fromV?new Date(fromV).getTime():NaN;
  var toTs=toV?new Date(toV).getTime():NaN;
  if(!isFinite(fromTs)||!isFinite(toTs)||toTs<=fromTs){st.textContent='Некорректный интервал «с — до»';st.style.color='var(--danger)';return}
  st.textContent='Создаю...';st.style.color='var(--warning)';
  api(API+'/api/admin/maintenance',{method:'POST',json:{target_type:type,target_id:target,from_ts:fromTs,to_ts:toTs,comment:comment}}).then(function(d){
    if(d.ok){st.textContent='Окно создано — алерты по объекту заглушены на период окна';st.style.color='var(--success)';loadMaintenanceWindows();setTimeout(loadData,1500)}
    else{st.textContent=d.error||'Ошибка';st.style.color='var(--danger)'}
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)'});
}
function deleteMaintenanceWindow(id){
  if(!confirm('Удалить окно обслуживания?'))return;
  api(API+'/api/admin/maintenance/'+id,{method:'DELETE'}).then(function(d){
    if(d.ok){showToast('Окно удалено','success');loadMaintenanceWindows();setTimeout(loadData,1500)}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(e){showToast(e.message||'Ошибка сети','error')});
}

// ========== УЧЁТ ОБОРУДОВАНИЯ ПО ЛОКАЦИЯМ ==========
var _equipmentData=null,_equipmentLoadSeq=0;
function loadEquipmentInventory(){
  var seq=++_equipmentLoadSeq;
  api(API+'/api/admin/equipment').then(function(d){
    if(seq!==_equipmentLoadSeq)return;
    if(!d||d.error)throw new Error(d&&d.error||'Не удалось загрузить оборудование');
    _equipmentData=d;
    var sel=document.getElementById('equipmentLocationInput');
    if(sel){
      var old=sel.value;
      sel.innerHTML=(d.locations||[]).filter(function(l){return !l.missing}).map(function(l){return '<option value="'+esc(l.key)+'">'+esc(l.label)+(l.country?' · '+esc(l.country):'')+'</option>';}).join('');
      if(old&&Array.prototype.some.call(sel.options,function(o){return o.value===old}))sel.value=old;
    }
    var s=d.summary||{};
    var el=document.getElementById('equipmentTotalUnits');if(el)el.textContent=(s.total_units||0).toLocaleString('ru-RU');
    el=document.getElementById('equipmentTotalTypes');if(el)el.textContent=(s.equipment_types||0).toLocaleString('ru-RU');
    el=document.getElementById('equipmentLocationCount');if(el)el.textContent=(s.locations_with_equipment||0).toLocaleString('ru-RU');
    renderEquipmentInventory();
  }).catch(function(e){var box=document.getElementById('equipmentLocations');if(box)box.innerHTML='<div class="inv-error">'+esc(e.message)+'</div>';});
}
function renderEquipmentInventory(){
  var box=document.getElementById('equipmentLocations');if(!box||!_equipmentData)return;
  var items=_equipmentData.items||[];
  var groups={};items.forEach(function(item){(groups[item.location_key]=groups[item.location_key]||[]).push(item);});
  var h='';
  (_equipmentData.locations||[]).forEach(function(location){
    var rows=groups[location.key]||[];
    var serverNames=(location.servers||[]).map(function(s){return s.displayName||s.name}).join(', ');
    h+='<section class="equipment-location-card'+(location.missing?' is-missing':'')+'">';
    h+='<header><div class="equipment-location-pin">'+icon('pin',15)+'</div><div><h3>'+esc(location.label)+'</h3><p>'+(location.missing?'Локация больше не связана с сервером':esc(serverNames||'Серверы не указаны'))+'</p></div><strong>'+rows.reduce(function(sum,row){return sum+row.quantity},0)+' шт.</strong></header>';
    if(!rows.length)h+='<div class="equipment-empty">Оборудование пока не добавлено</div>';
    else{
      h+='<div class="equipment-row equipment-row-head"><span>Тип</span><span>Количество</span><span>Примечание</span><span></span></div>';
      rows.forEach(function(row){
        h+='<div class="equipment-row">'
          +'<input class="form-input" id="eqType_'+row.id+'" maxlength="120" value="'+esc(row.equipment_type)+'" aria-label="Тип оборудования">'
          +'<input class="form-input eq-qty" id="eqQty_'+row.id+'" type="number" min="0" max="1000000" step="1" value="'+row.quantity+'" aria-label="Количество">'
          +'<input class="form-input" id="eqNotes_'+row.id+'" maxlength="500" value="'+esc(row.notes||'')+'" placeholder="Примечание" aria-label="Примечание">'
          +'<div class="equipment-row-actions"><button class="btn btn-sm" data-on-click="saveEquipmentItem('+row.id+')" title="Сохранить">'+icon('save',13)+'</button><button class="btn btn-sm is-danger" data-on-click="deleteEquipmentItem('+row.id+')" title="Удалить">×</button></div>'
          +'</div>';
      });
    }
    h+='</section>';
  });
  box.innerHTML=h||'<div class="equipment-empty is-page">Сначала укажите адрес локации в разделе «Серверы»</div>';
}
function addEquipmentItem(){
  var st=document.getElementById('equipmentAddStatus');
  var payload={
    location_key:(document.getElementById('equipmentLocationInput')||{}).value||'',
    equipment_type:(document.getElementById('equipmentTypeInput')||{}).value||'',
    quantity:parseInt((document.getElementById('equipmentQuantityInput')||{}).value,10),
    notes:(document.getElementById('equipmentNotesInput')||{}).value||''
  };
  if(!payload.location_key||!payload.equipment_type.trim()||!isFinite(payload.quantity)){if(st){st.textContent='Заполните локацию, тип и количество';st.style.color='var(--danger)';}return}
  if(st){st.textContent='Сохраняю…';st.style.color='var(--warning)';}
  api(API+'/api/admin/equipment',{method:'POST',json:payload}).then(function(d){
    if(!d.ok)throw new Error(d.error||'Ошибка сохранения');
    document.getElementById('equipmentTypeInput').value='';document.getElementById('equipmentNotesInput').value='';document.getElementById('equipmentQuantityInput').value='1';
    if(st){st.textContent='Позиция сохранена';st.style.color='var(--success)';}loadEquipmentInventory();
  }).catch(function(e){if(st){st.textContent=e.message;st.style.color='var(--danger)';}});
}
function saveEquipmentItem(id){
  var row=(_equipmentData&&_equipmentData.items||[]).find(function(item){return item.id===id});if(!row)return;
  var payload={location_key:row.location_key,equipment_type:document.getElementById('eqType_'+id).value,quantity:parseInt(document.getElementById('eqQty_'+id).value,10),notes:document.getElementById('eqNotes_'+id).value};
  api(API+'/api/admin/equipment/'+id,{method:'PATCH',json:payload}).then(function(d){if(!d.ok)throw new Error(d.error||'Ошибка');showToast('Оборудование сохранено','success');loadEquipmentInventory();}).catch(function(e){showToast(e.message,'error');});
}
function deleteEquipmentItem(id){
  var row=(_equipmentData&&_equipmentData.items||[]).find(function(item){return item.id===id});if(!row)return;
  confirmDialog('Удалить «'+row.equipment_type+'» из учёта?',function(){api(API+'/api/admin/equipment/'+id,{method:'DELETE'}).then(function(d){if(!d.ok)throw new Error(d.error||'Ошибка');showToast('Позиция удалена','success');loadEquipmentInventory();}).catch(function(e){showToast(e.message,'error');});},'Удалить','Удалить позицию');
}

// ========== ICCID -> НОМЕР ТЕЛЕФОНА ==========
var _simRegistryData=null,_simRegistryLoadSeq=0;
function loadSimRegistry(){
  var seq=++_simRegistryLoadSeq;
  api(API+'/api/admin/sim_registry').then(function(d){
    if(seq!==_simRegistryLoadSeq)return;
    if(!d||d.error)throw new Error(d&&d.error||'Не удалось загрузить реестр');
    _simRegistryData=d;
    var s=d.summary||{},ids={simRegistryTotal:s.registry_total||0,simRegistryMatched:s.registry_matched||0,simRegistryUnregistered:s.detected_not_registered||0,simRegistryMissingPhone:s.phone_missing||0,simRegistryMissingIccid:s.modems_without_iccid||0};
    Object.keys(ids).forEach(function(id){var el=document.getElementById(id);if(el)el.textContent=ids[id].toLocaleString('ru-RU');});
    renderSimRegistry();
  }).catch(function(e){var box=document.getElementById('simRegistryTable');if(box)box.innerHTML='<div class="inv-error">'+esc(e.message)+'</div>';});
}
function renderSimRegistry(){
  var box=document.getElementById('simRegistryTable');if(!box||!_simRegistryData)return;
  var q=((document.getElementById('simRegistrySearch')||{}).value||'').trim().toLowerCase();
  var items=(_simRegistryData.items||[]).filter(function(item){
    if(!q)return true;
    var bindings=(item.bindings||[]).map(function(b){return [b.server_name,b.server,b.nick,b.imei].join(' ')}).join(' ');
    return [item.iccid,item.phone,item.operator,item.notes,bindings].join(' ').toLowerCase().indexOf(q)>=0;
  });
  var hint=document.getElementById('simRegistryListHint');if(hint)hint.textContent=' · '+items.length+' из '+(_simRegistryData.items||[]).length;
  if(!items.length){box.innerHTML='<div class="equipment-empty is-page">Ничего не найдено</div>';return}
  var h='<div class="sim-registry-row sim-registry-head"><span>ICCID / статус</span><span>Номер телефона</span><span>Оператор</span><span>Привязан к модему</span><span>Примечание</span><span></span></div>';
  items.forEach(function(item){
    var bindings=item.bindings||[];
    var bindHtml=bindings.length?bindings.slice(0,2).map(function(b){return '<b>'+esc(b.nick||b.imei)+'</b><small>'+esc(b.server_name||b.server)+'</small>';}).join(''):'<span class="sim-muted">Пока не найдено</span>';
    if(bindings.length>2)bindHtml+='<small>+'+(bindings.length-2)+' ещё</small>';
    var badge=item.conflict?'<em class="sim-state is-red">Конфликт номера</em>':item.registered?(item.matched?'<em class="sim-state is-green">Сопоставлено</em>':'<em class="sim-state">В резерве</em>'):'<em class="sim-state is-orange">Нет в реестре</em>';
    h+='<div class="sim-registry-row'+(item.conflict?' has-conflict':'')+'">'
      +'<div class="sim-identity"><code>'+esc(item.iccid)+'</code>'+badge+'</div>'
      +'<input class="form-input" id="simPhone_'+item.iccid+'" value="'+esc(item.phone||'')+'" placeholder="+373…" aria-label="Номер телефона">'
      +'<input class="form-input" id="simOperator_'+item.iccid+'" value="'+esc(item.operator||'')+'" placeholder="Оператор" aria-label="Оператор">'
      +'<div class="sim-binding">'+bindHtml+'</div>'
      +'<input class="form-input" id="simNotes_'+item.iccid+'" value="'+esc(item.notes||'')+'" maxlength="500" placeholder="Примечание" aria-label="Примечание">'
      +'<div class="sim-row-actions"><button class="btn btn-sm" data-on-click="saveSimRegistryRow(\''+item.iccid+'\')">'+(item.registered?'Сохранить':'Внести')+'</button>'+(item.registered?'<button class="btn btn-sm is-danger" data-on-click="deleteSimRegistryRow(\''+item.iccid+'\')" title="Удалить">×</button>':'')+'</div>'
      +'</div>';
  });
  box.innerHTML=h;
}
function readSimRegistryFile(files){
  var file=files&&files[0],st=document.getElementById('simRegistryImportStatus');if(!file)return;
  if(file.size>75000){if(st){st.textContent='Файл больше 75 КБ — разделите его на части';st.style.color='var(--danger)';}return}
  var reader=new FileReader();
  reader.onload=function(){document.getElementById('simRegistryImportText').value=String(reader.result||'');if(st){st.textContent='Файл загружен: '+file.name;st.style.color='var(--text-2)';}};
  reader.onerror=function(){if(st){st.textContent='Не удалось прочитать файл';st.style.color='var(--danger)';}};
  reader.readAsText(file);
}
function importSimRegistry(){
  var text=(document.getElementById('simRegistryImportText')||{}).value||'',st=document.getElementById('simRegistryImportStatus');
  if(!text.trim()){st.textContent='Вставьте таблицу или выберите файл';st.style.color='var(--danger)';return}
  st.textContent='Сопоставляю ICCID…';st.style.color='var(--warning)';
  api(API+'/api/admin/sim_registry/import',{method:'POST',json:{text:text}}).then(function(d){
    if(!d.ok)throw new Error(d.error||'Ошибка импорта');
    var errorText=d.errors&&d.errors.length?' · пропущено '+d.errors.length:'';
    st.textContent='Обработано '+d.processed+' · новых '+d.inserted+' · обновлено '+d.updated+' · найдено в модемах '+d.matched+errorText;st.style.color=d.errors&&d.errors.length?'var(--warning)':'var(--success)';
    loadSimRegistry();if(typeof loadData==='function')setTimeout(loadData,300);
  }).catch(function(e){st.textContent=e.message;st.style.color='var(--danger)';});
}
function _saveSimRegistryPayload(payload,st,done){
  if(st){st.textContent='Сохраняю…';st.style.color='var(--warning)';}
  api(API+'/api/admin/sim_registry',{method:'POST',json:payload}).then(function(d){
    if(!d.ok)throw new Error(d.error||'Ошибка сохранения');
    if(st){st.textContent=d.matched?'Сохранено и сопоставлено с модемом':'Сохранено в реестр';st.style.color='var(--success)';}
    if(done)done();loadSimRegistry();if(typeof loadData==='function')setTimeout(loadData,300);
  }).catch(function(e){if(st){st.textContent=e.message;st.style.color='var(--danger)';}else showToast(e.message,'error');});
}
function addSimRegistryRow(){
  var payload={iccid:(document.getElementById('simManualIccid')||{}).value||'',phone:(document.getElementById('simManualPhone')||{}).value||'',operator:(document.getElementById('simManualOperator')||{}).value||'',notes:(document.getElementById('simManualNotes')||{}).value||''};
  _saveSimRegistryPayload(payload,document.getElementById('simManualStatus'),function(){['simManualIccid','simManualPhone','simManualOperator','simManualNotes'].forEach(function(id){document.getElementById(id).value='';});});
}
function saveSimRegistryRow(iccid){
  var payload={iccid:iccid,phone:document.getElementById('simPhone_'+iccid).value,operator:document.getElementById('simOperator_'+iccid).value,notes:document.getElementById('simNotes_'+iccid).value};
  _saveSimRegistryPayload(payload,null,function(){showToast('Связка ICCID и номера сохранена','success');});
}
function deleteSimRegistryRow(iccid){
  confirmDialog('Удалить ICCID '+iccid+' из загруженного реестра?',function(){api(API+'/api/admin/sim_registry/'+encodeURIComponent(iccid),{method:'DELETE'}).then(function(d){if(!d.ok)throw new Error(d.error||'Ошибка');showToast('Строка удалена из реестра','success');loadSimRegistry();}).catch(function(e){showToast(e.message,'error');});},'Удалить','Удалить связку');
}
