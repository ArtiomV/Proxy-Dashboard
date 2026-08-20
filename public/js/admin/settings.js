// public/js/admin/settings.js — settings tab (WP6.3 carve-out from admin.js,
// VERBATIM): pricing tiers, servers list, all settings sections.

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

      h+='<div class="server-card" id="srv_'+sn+'">';
      // Header
      h+='<div class="server-header"><div class="server-header-left">';
      h+='<span class="server-id">'+sn+'</span>';
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
      h+='<div class="server-field"><div class="server-field-label">SSH Доступ</div><div class="server-field-value"><span>'+esc(s.osLogin||'—')+'</span> / <span id="sshPwdView_'+sn+'">'+(s.osPassword?'••••••••':'—')+'</span>'+(s.osPassword?'<button class="toggle-btn" data-on-click="togglePwdView(this,\'sshPwdView_'+sn+'\',\''+esc(s.osPassword).replace(/'/g,"\\'")+'\')">'+icon('eye',12)+'</button>':'')+'</div></div>';
      h+='<div class="server-field"><div class="server-field-label">Оборудование</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.hardware?'var(--text-1)':'var(--text-3)')+'">'+esc(s.hardware||'— не указаны —')+'</span></div></div>';
      h+='<div class="server-field" style="grid-column:1/-1"><div class="server-field-label">'+icon('pin',12)+' Адрес локации</div><div class="server-field-value" style="font-family:inherit"><span style="color:'+(s.address?'var(--text-1)':'var(--text-3)')+'">'+esc(s.address||'— не указан —')+'</span></div></div>';
      h+='</div>';
      // Edit body (hidden)
      h+='<div class="server-body" id="srvEdit_'+sn+'" style="display:none">';
      h+='<div class="server-field"><div class="server-field-label">Панель Логин</div><input class="form-input" id="panelUser_'+sn+'" value="'+esc(s.panelUser||'')+'" placeholder="proxy" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">Панель Пароль</div><input class="form-input" id="panelPass_'+sn+'" value="'+esc(s.panelPassword||'')+'" placeholder="пароль" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Логин</div><input class="form-input" id="osLogin_'+sn+'" value="'+esc(s.osLogin||'')+'" placeholder="root" style="font-size:12px"></div>';
      h+='<div class="server-field"><div class="server-field-label">SSH Пароль</div><input class="form-input" id="osPass_'+sn+'" value="'+esc(s.osPassword||'')+'" placeholder="пароль" style="font-size:12px"></div>';
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
      h+='<button class="btn btn-sm" style="color:var(--danger);font-size:10px" data-on-click="deleteServer(\''+sn+'\')">'+icon('x',11)+' Удалить</button>';
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
  var osLogin=document.getElementById('osLogin_'+name).value;
  var osPass=document.getElementById('osPass_'+name).value;
  var panelUser=document.getElementById('panelUser_'+name).value;
  var panelPass=document.getElementById('panelPass_'+name).value;
  var hw=document.getElementById('hw_'+name).value;
  var addr=(document.getElementById('addr_'+name)||{}).value||'';
  var st=document.getElementById('srvSaveStatus_'+name);
  st.textContent='Сохраняю и проверяю Панель...';st.style.color='var(--warning)';
  api(API+'/api/admin/servers/'+name,{method:'PATCH',json:{osLogin:osLogin,osPassword:osPass,panelUser:panelUser,panelPassword:panelPass,hardware:hw,address:addr}}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';setTimeout(function(){loadServersList()},1000)}
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
      h+='<div style="margin:8px 0 2px;font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">'+esc(srv)+'</div>';
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
    var _palEl=document.getElementById('proxyAlertLatencyInput');if(_palEl)_palEl.value=s.proxy_alert_latency_ms!=null?s.proxy_alert_latency_ms:1500;
    var _paeEl=document.getElementById('proxyAlertErrorPctInput');if(_paeEl)_paeEl.value=s.proxy_alert_error_pct!=null?s.proxy_alert_error_pct:5;
    var _pawEl=document.getElementById('proxyAlertWindowInput');if(_pawEl)_pawEl.value=s.proxy_alert_window_min!=null?s.proxy_alert_window_min:60;
    var _arE=document.getElementById('autoRebootEnabledInput');if(_arE)_arE.checked=!!s.auto_reboot_enabled;
    var _arI=document.getElementById('autoRebootIntervalInput');if(_arI)_arI.value=s.auto_reboot_min_interval_min!=null?s.auto_reboot_min_interval_min:60;
    var _rrE=document.getElementById('randomRebootEnabledInput');if(_rrE)_rrE.checked=(s.random_modem_reboot_enabled!==false);
    var _rcD=document.getElementById('reconcileDaysInput');if(_rcD)_rcD.value=s.reconcile_days||2;
    _pcWarnMs=s.proxy_check_warn_ms||500;
    _pcBadMs=s.proxy_check_bad_ms||2000;
    var pctEl=document.getElementById('proxyCheckTargetInput');if(pctEl)pctEl.value=s.proxy_check_target||'https://www.instagram.com/';
    var pcwEl=document.getElementById('proxyCheckWarnInput');if(pcwEl)pcwEl.value=_pcWarnMs;
    var pcbEl=document.getElementById('proxyCheckBadInput');if(pcbEl)pcbEl.value=_pcBadMs;
    var pciEl=document.getElementById('proxyCheckIntervalInput');if(pciEl)pciEl.value=s.proxy_check_interval_min||60;
    // Proxy check extended
    var pctmEl=document.getElementById('proxyCheckTimeoutInput');if(pctmEl)pctmEl.value=s.proxy_check_timeout_sec||15;
    var pccEl=document.getElementById('proxyCheckConcurrencyInput');if(pccEl)pccEl.value=s.proxy_check_concurrency||10;
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
  // Ники модемов почасового замера: отмеченные чекбоксы → CSV; если пикер не
  // отрендерился (ошибка загрузки) — фолбэк на скрытый input с текущим CSV.
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
  var palLatency=parseInt(document.getElementById('proxyAlertLatencyInput').value)||1500;
  var palErrPct=parseFloat(document.getElementById('proxyAlertErrorPctInput').value)||5;
  var palWindow=parseInt(document.getElementById('proxyAlertWindowInput').value)||60;
  var arEnabled=!!(document.getElementById('autoRebootEnabledInput')||{}).checked;
  var arInterval=parseInt(document.getElementById('autoRebootIntervalInput').value)||60;
  var recDays=parseInt((document.getElementById('reconcileDaysInput')||{}).value)||2;
  _minSpeedThreshold=minSpeed;
  _errorRateThreshold=errThresh;
  var staleH=parseInt(document.getElementById('staleModemHoursInput').value)||12;
  var offThMin=parseInt((document.getElementById('modemOfflineThresholdInput')||{}).value)||10;
  var rbs=parseInt((document.getElementById('rebootScoreAlertInput')||{}).value);
  if(isNaN(rbs))rbs=70;
  window._offlineThresholdMin=offThMin;
  api(API+'/api/admin/settings',{method:'PUT',json:{speedtest_modems:modems.join(','),min_speed_threshold:minSpeed,error_rate_threshold:errThresh,speedtest_max_history:maxHist,speedmon_retry_dl_threshold:smDl,speedmon_retry_round_min:smRm,speedmon_retry_rounds:smRr,retention_speed_monitor:smRet,proxy_alert_latency_ms:palLatency,proxy_alert_error_pct:palErrPct,proxy_alert_window_min:palWindow,auto_reboot_enabled:arEnabled,auto_reboot_min_interval_min:arInterval,reboot_score_alert_threshold:rbs,stale_modem_hours:staleH,modem_offline_threshold_min:offThMin,reconcile_days:recDays}}).then(function(d){
    if(d.ok){showToast('Настройки сохранены','success');document.getElementById('settingsStatus').textContent='Почасовой замер: '+(modems.join(', ')||'дефолтный список')+' — применится со следующего часа';renderTable()}
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
  var rndReboot=(document.getElementById('randomRebootEnabledInput')||{}).checked!==false;
  var st=document.getElementById('recoverySettingsStatus');
  st.textContent='Сохраняю...';st.style.color='var(--warning)';
  api(API+'/api/admin/settings',{method:'PUT',json:{recovery_enabled:enabled,recovery_offline_sec:offline,recovery_max_attempts:maxAtt,recovery_retry_min:retryMin,recovery_daily_cap:dailyCap,recovery_readd_after:readdAfter,recovery_skip_dead_sim:skipDeadSim,recovery_skip_unsold:skipUnsold,random_modem_reboot_enabled:rndReboot}}).then(function(d){
    if(d.ok){st.innerHTML='Сохранено '+icon('check',12);st.style.color='var(--success)';_showRestartBanner()}
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
    retention_proxy_checks:parseInt(document.getElementById('retProxyChecksInput').value)||30,
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
    auto_create_interval_min:parseInt(document.getElementById('autoCreateIntervalInput').value)||10
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
