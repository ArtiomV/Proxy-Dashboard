// public/js/admin/fleet-ui.js — fleet counter rendering, ONE place (WP6.3).
// Everything that draws modem online/total counters on the admin pages lives
// here and reads currentData.fleet (the single source of truth). Classic script,
// shared global scope with admin.js core.

function _ncPulseCard(label, value, sub, accent){
  var cls = (accent && accent !== 'var(--text-0)') ? ' '+accent : '';
  return '<div class="pulse-card'+cls+'">' +
    '<div class="pulse-label">'+esc(label)+'</div>' +
    '<div class="pulse-value">'+value+'</div>' +
    (sub?'<div class="pulse-sub">'+sub+'</div>':'') +
    '</div>';
}

function _ncListRow(name, val, valColor){
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">' +
    '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">'+name+'</span>' +
    '<span style="font-family:var(--font-mono);font-size:11px;color:'+valColor+';font-weight:600;white-space:nowrap">'+val+'</span></div>';
}

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

