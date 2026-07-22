// public/js/admin/modems.js — the Модемы page (WP6.3 carve-out from admin.js,
// VERBATIM move): filters, tiles/grid, table, detail modal, modem actions,
// speedtest/SMS/USSD helpers. Classic script, shared global scope.

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
h+='<span onclick="event.stopPropagation();'+_con+'" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px" title="'+esc(_cparts.join('\n')||'нет активных подключений')+(_spark?'&#10;за час: макс '+_hmax:'')+'&#10;клик — лимиты порта">'+_spark+'<span class="mono" style="font-weight:'+(_ct>0?'600':'400')+';color:'+_cc+'">'+_ct+'</span></span>';break;}case'errors':{var ep=modem.pcErrorPct;if(ep!==null&&ep!==undefined){var eCls=ep>=_errorRateThreshold?'pc-bad':ep>0?'pc-warn':'pc-good';h+='<span class="pc-err '+eCls+'">'+ep+'%</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;}case'health':{var _hm=_getHealth(modem);if(_hm&&_hm.health_score!=null){var _hs=_hm.health_score;var _hCls=_hm.status==='good'?'pc-good':_hm.status==='warn'?'pc-warn':'pc-bad';h+='<span class="pc-err '+_hCls+'" title="P50 latency: '+(_hm.latency_ms||'?')+' мс, ошибки: '+(_hm.error_pct||0)+'%, аптайм: '+(_hm.uptime_pct||0)+'% · нажмите «Инфо» для подробностей" style="cursor:help;font-weight:600">'+_hs+'</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">\u2014</span>'}break;}case'rotation':{var _rr=modem.autoRotation;if(_rr===''||_rr==null){h+='<span style="color:var(--text-3);font-size:10px" title="Нет данных с сервера">?</span>'}else{var rotMin=parseInt(_rr)||0;if(rotMin>0){var rotStr=rotMin>=60?(rotMin/60).toFixed(0)+'ч':rotMin+'м';h+='<span class="mono" style="font-size:11px">'+rotStr+'</span>'}else{h+='<span style="color:var(--text-3);font-size:10px">Выкл</span>'}}break;}case'band':h+=modem.band?'<span class="mono" style="font-size:11px">'+esc(modem.band)+'</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'simStatus':{var _ss=(modem.simStatus||'');if(!_ss||_ss==='UNKNOWN'){h+='<span style="color:var(--text-3);font-size:10px">—</span>'}else{var _ok=/\bOK\b|READY/.test(_ss);h+='<span class="pc-err '+(_ok?'pc-good':'pc-bad')+'" style="font-size:10px" title="'+esc(_ss)+'">'+esc(_ss)+'</span>'}break;}case'rebootScore':{var _rs=modem.rebootScore;if(_rs==null){h+='<span style="color:var(--text-3);font-size:10px">—</span>'}else{var _rc=_rs>=70?'pc-bad':_rs>=50?'pc-warn':'pc-good';h+='<span class="pc-err '+_rc+'" style="font-size:10px">'+_rs+'</span>'}break;}case'httpRedirect':h+=modem.httpRedirect?'<span class="pc-err pc-bad" style="font-size:10px" title="Оператор навязал редирект — SIM без денег/блок">редирект</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'isLocked':h+=modem.isLocked?'<span title="Модем занят операцией/ротацией">🔒</span>':'<span style="color:var(--text-3);font-size:10px">—</span>';break;case'actions':{var d='data-imei="'+modem.rawImei+'" data-server="'+modem.server+'" data-nick="'+esc(modem.nick)+'"';h+='<div class="actions-cell" style="display:flex;gap:4px;align-items:center;justify-content:flex-end">'+(status!=='offline'?'<button class="row-act" '+d+' title="Сбросить IP" onclick="resetIp(this)">↻</button><button class="row-act" '+d+' title="Ребут модема" onclick="rebootModem(this)">⏻</button>':'')+'<button class="btn-details" '+d+' onclick="showDetails(this)"><svg width="12" height="12" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.1"/><line x1="4" y1="4.5" x2="9" y2="4.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4" y1="6.5" x2="9" y2="6.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4" y1="8.5" x2="7" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>Инфо</button>';
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
  net+=_ovRow('Тип сети',(m.netType?esc(m.netType):'—')+(m.band?' · '+esc(m.band):''));
  net+=_ovRow('SIM','<span style="color:'+(_simOk?'var(--success)':'var(--danger)')+'">'+esc(m.simStatus||'—')+'</span>');
  net+=_ovRow('ICCID',m.iccid?('<span style="font-family:var(--font-mono);font-size:10px;cursor:pointer" onclick="copyText(\''+esc(m.iccid)+'\',this)">'+esc(m.iccid)+' 📋</span>'):'—');
  net+=_ovRow('Reboot score','<span style="color:'+_rsc+'">'+(_rs!=null?_rs:'—')+'</span>');
  net+=_ovRow('Ротация',m.timeToRotation?esc(m.timeToRotation):((m.autoRotation===''||m.autoRotation==null)?'нет данных':(parseInt(m.autoRotation)>0?('каждые '+m.autoRotation+'м'):'выкл')));
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

// Инициатор ротации: перевод известных CALLER + режим сети.
function _rotCaller(caller,mode){
  var map={schedule:'По расписанию',link:'По ссылке клиента',api:'Через API',manual:'Вручную',webapp:'Из панели'};
  var c=caller?String(caller):'';
  var label=map[c.toLowerCase()]|| (c?esc(c):'—');
  var m=mode&&String(mode)!=='auto'?' <span style="font-size:10px;color:var(--text-3)">'+esc(String(mode))+'</span>':'';
  return label+m;
}
function _renderRotationLog(el,m){
  el.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Загрузка лога ротации...</div>';
  api(API+'/api/admin/rotation_log?nick='+encodeURIComponent(m.nick)+'&serverName='+m.server).then(function(data){
    var entries=Array.isArray(data)?data:(data.log||data.logs||data.data||[]);
    if(!entries.length){el.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Нет истории ротации</div>';return}
    function _fmtRot(v){if(!v||v==='—')return'—';var s=String(v).replace('@',' ').replace('T',' ');var d=new Date(s);if(isNaN(d.getTime())){var p=s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):?(\d{2})?/);if(p)return p[3]+'.'+p[2]+'.'+p[1]+' '+p[4]+':'+p[5]+(p[6]?':'+p[6]:'');return s}return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
    var h='<table class="log-table"><thead><tr><th>Начало</th><th>Инициатор</th><th>Сек</th><th>Попытка</th><th>Старый IP</th><th>Новый IP</th></tr></thead><tbody>';
    entries.forEach(function(e){
      var start=e.started_at||e.start_time||e.Start||e.start||'—';
      var took=e.took_sec||e.total_time||e.Took||e.took||'—';
      var attempt=e.attempt||e.Attempt||1;
      var oldIp=e.old_ip||e.OldIPv4||'—';
      var newIp=e.new_ip||e.NewIPv4||'—';
      var unchanged=(oldIp!=='—'&&newIp!=='—'&&String(oldIp)===String(newIp));
      h+='<tr>';
      h+='<td style="white-space:nowrap">'+_fmtRot(start)+'</td>';
      h+='<td style="white-space:nowrap">'+_rotCaller(e.caller,e.target_mode)+'</td>';
      h+='<td>'+(took!=='—'?parseFloat(took).toFixed(1):'—')+'</td>';
      h+='<td>'+esc(String(attempt))+'</td>';
      h+='<td style="font-family:var(--font-mono);color:var(--text-2)">'+esc(String(oldIp))+'</td>';
      h+='<td style="font-family:var(--font-mono);color:'+(unchanged?'var(--warning,#c60)':'var(--accent)')+'">'+esc(String(newIp))+(unchanged?' <span title="IP не сменился" style="font-size:10px;color:var(--warning,#c60)">⚠ не сменился</span>':'')+'</td>';
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
    var curRotUnknown=(m.autoRotation===''||m.autoRotation==null);var curRot=curRotUnknown?-1:(parseInt(m.autoRotation)||0);
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
      +'<select class="form-input" id="msAutoRot" style="max-width:180px">'+(curRotUnknown?'<option value="__u" disabled selected>— нет данных с сервера</option>':'')+ROT_OPTS.map(function(o){return'<option value="'+o.v+'"'+(curRot===o.v?' selected':'')+'>'+o.l+'</option>'}).join('')+'</select></div>'
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
function saveModemSettingsNew(imei,srv){var rotSel=document.getElementById('msAutoRot');var rotRaw=rotSel?rotSel.value:'';var payload={serverName:srv,IMEI:imei,name:document.getElementById('msNick').value,PHONE_NUMBER:document.getElementById('msPhone').value,TARGET_MODE:document.getElementById('msMode').value,NOTES:document.getElementById('msNotes').value};if(rotRaw!=='__u')payload.AUTO_IP_ROTATION=String(parseInt(rotRaw)||0);api(API+'/api/admin/store_modem',{method:'POST',json:payload}).then(function(r){if(r.ok){showToast('Сохранено, применяю...','success');api(API+'/api/admin/apply_modem',{method:'POST',json:{imei:imei,serverName:srv}}).then(function(r2){r2.ok?showToast('Применено ✓','success'):showToast('Сохранено, но не применено: '+(r2.error||''),'warning');setTimeout(loadData,3000)}).catch(function(e){showToast('Сохранено, но не применено: '+esc(e.message),'warning');setTimeout(loadData,3000)})}else{showToast(r.error||'Ошибка','error')}}).catch(function(e){showToast('Ошибка: '+esc(e.message),'error')})}
function applyModemSettings(imei,srv){api(API+'/api/admin/apply_modem',{method:'POST',json:{imei:imei,serverName:srv}}).then(function(r){r.ok?showToast('Применено','success'):showToast(r.error||'Ошибка','error');setTimeout(loadData,3000)}).catch(function(e){showToast(esc(e.message),'error')})}
function downloadVpn(pid,srv){window.open(API+'/api/admin/vpn_profile?portId='+encodeURIComponent(pid)+'&serverName='+srv+'&token='+authToken)}
