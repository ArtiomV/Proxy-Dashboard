'use strict';

// Dashboard 2 deliberately stays independent from the legacy command centre.
// It only consumes the already loaded admin snapshot and the existing finance
// endpoint, so switching tabs never blanks the page during background refresh.
var _d2SpareCache={};
var _d2SpareAt=0;

function _d2Money(v){
  if(v==null||isNaN(v))return '—';
  return Math.round(Number(v)||0).toLocaleString('ru-RU')+' ₽';
}
function _d2ServerName(name){
  return typeof _serverDisplayLabel==='function'?_serverDisplayLabel(name):name;
}
function _d2ClientNames(m){
  var out=[];
  (m.ports||[]).forEach(function(p){
    var n=String(p.portName||'').trim();
    var expired=typeof _portExpired==='function'&&_portExpired(p);
    if(n&&!expired&&out.indexOf(n)<0)out.push(n);
  });
  return out;
}
function _d2IsActive(m){
  return typeof _hasActiveClient==='function'?_hasActiveClient(m):_d2ClientNames(m).length>0;
}
function _d2AgeLabel(ts){
  var t=ts?Date.parse(ts):NaN;
  if(isNaN(t))return 'время неизвестно';
  var min=Math.max(0,Math.floor((Date.now()-t)/60000));
  if(min<2)return 'только что';
  if(min<60)return min+' мин назад';
  var h=Math.floor(min/60);
  if(h<24)return h+' ч назад';
  return Math.floor(h/24)+' дн назад';
}
function _d2Model(){
  var mm=(currentData&&currentData._modemMap)||{};
  var active=[],offline=[],low=[],stuck=[],affected={};
  var proxy=typeof _collectProxyProblemItems==='function'?_collectProxyProblemItems(mm):[];
  var proxyKeys={};
  proxy.forEach(function(it){proxyKeys[it.server+'|'+it.nick]=true;});
  Object.keys(mm).forEach(function(k){
    var m=mm[k]; if(!m||m.isTestPool||!_d2IsActive(m))return;
    active.push(m);
    var status=typeof getModemStatus==='function'?getModemStatus(m):(m.isOnline?'online':'offline');
    var clients=_d2ClientNames(m);
    if(status==='offline'){
      offline.push({nick:m.nick,server:m.server,detail:'Клиенты: '+(clients.join(', ')||'—')});
      clients.forEach(function(c){affected[c]=true;});
      return;
    }
    if(proxyKeys[m.server+'|'+m.nick])clients.forEach(function(c){affected[c]=true;});
    if(!proxyKeys[m.server+'|'+m.nick]&&m.lowSpeed){
      low.push({nick:m.nick,server:m.server,detail:'↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Мбит/с'});
      clients.forEach(function(c){affected[c]=true;});
    }else if(!proxyKeys[m.server+'|'+m.nick]&&m.ipStuck){
      stuck.push({nick:m.nick,server:m.server,detail:'IP не менялся '+Number(m.ipSinceHours||0)+' ч'});
      clients.forEach(function(c){affected[c]=true;});
    }
  });
  proxy.forEach(function(it){
    Object.keys(mm).forEach(function(k){var m=mm[k];if(m&&m.server===it.server&&m.nick===it.nick)_d2ClientNames(m).forEach(function(c){affected[c]=true;});});
  });

  var pingFresh=0,httpFresh=0,httpEligible=0;
  active.forEach(function(m){
    var pg=(currentData.modemPing||{})[m.server+'_'+m.nick];
    if(pg&&pg.fresh!==false)pingFresh++;
    var eligible=typeof _httpEligibility==='function'?_httpEligibility(m):{ok:true};
    if(eligible.ok){
      httpEligible++;
      var hc=(currentData.modemHttpCheck||{})[m.server+'_'+m.nick];
      if(hc&&hc.error!=='offline'&&hc.error!=='no_valid_client_credentials'&&(!hc.ts||Date.now()-Date.parse(hc.ts)<30*60000))httpFresh++;
    }
  });
  var coverageDen=active.length+httpEligible;
  var coverage=coverageDen?Math.round((pingFresh+httpFresh)/coverageDen*100):100;
  var downServers=(currentData.cachedServers||[]).map(function(s){return s.name;});
  var debtors=(currentData.clients||[]).filter(function(c){return Number(c.balance||0)<-10;});
  var debtSum=debtors.reduce(function(sum,c){return sum+Math.abs(Number(c.balance||0));},0);
  return {mm:mm,active:active,offline:offline,proxy:proxy,low:low,stuck:stuck,
    affectedClients:Object.keys(affected).length,coverage:coverage,pingFresh:pingFresh,
    httpFresh:httpFresh,httpEligible:httpEligible,downServers:downServers,
    debtors:debtors,debtSum:debtSum};
}
function _d2Kpi(label,value,sub,tone){
  return '<div class="d2-kpi '+(tone?'is-'+tone:'')+'"><div class="d2-kpi-label">'+esc(label)+'</div><div class="d2-kpi-value">'+value+'</div><div class="d2-kpi-sub">'+sub+'</div></div>';
}
function _d2Action(label,key,items,sub,tone,mark){
  if(!items.length)return '';
  return '<button class="d2-action '+(tone?'is-'+tone:'')+'" data-on-click="showProblemPopup(\''+esc(label)+'\',\''+key+'\')">'
    +'<span class="d2-action-mark">'+mark+'</span><span><span class="d2-action-title">'+esc(label)+'</span><span class="d2-action-sub">'+esc(sub)+'</span></span><span class="d2-action-count">'+items.length+'</span></button>';
}
function renderDashboard2(){
  var root=document.getElementById('tab-dashboard2');
  if(!root||!currentData)return;
  var m=_d2Model();
  var totalProblems=m.offline.length+m.proxy.length+m.low.length+m.stuck.length+m.downServers.length;
  var fin=window._newFinData||{};
  var fs=fin.summary||{};
  var revenue=fs.revenue_30d_fact!=null?fs.revenue_30d_fact:fs.mrr;
  var cost=Number(fs.total_cost||0);
  var profit=revenue==null?null:Number(revenue)-cost;
  var activeTone=totalProblems?'bad':'good';
  var coverageTone=m.coverage>=95?'good':m.coverage>=80?'warn':'bad';
  var profitTone=profit==null?'':(profit>=0?'good':'bad');
  var spareTotal=Object.keys(_d2SpareCache).reduce(function(sum,k){return sum+Number(_d2SpareCache[k]||0);},0);
  var spareKnown=Object.keys(_d2SpareCache).length>0;

  document.getElementById('d2Kpis').innerHTML=
    _d2Kpi('Нужно проверить',String(totalProblems),totalProblems?m.affectedClients+' клиент'+(m.affectedClients===1?' затронут':'ов затронуто'):'Инфраструктура работает штатно',activeTone)+
    _d2Kpi('Активные прокси',String(m.active.length),'Только действующие клиентские аренды','')+
    _d2Kpi('Свежесть контроля',m.coverage+'%','Ping '+m.pingFresh+'/'+m.active.length+' · HTTP '+m.httpFresh+'/'+m.httpEligible,coverageTone)+
    _d2Kpi('Прибыль 30 дней',profit==null?'—':_d2Money(profit),cost>0?'Выручка минус учтённые расходы':'Ждём финансовые данные',profitTone);

  window._problemData=window._problemData||{};
  window._problemData.d2offline=m.offline;
  window._problemData.d2proxy=m.proxy;
  window._problemData.flaky=m.proxy;
  window._problemData.d2speed=m.low;
  window._problemData.d2stuck=m.stuck;
  var actions='';
  actions+=_d2Action('Модемы отключены','d2offline',m.offline,'Активная аренда без связи','danger','!');
  actions+=_d2Action('Сбоит прокси','flaky',m.proxy,'Подтверждённые ping / HTTP / SIM проблемы','danger','!');
  actions+=_d2Action('Низкая скорость','d2speed',m.low,'Ниже рабочего порога','', '↓');
  actions+=_d2Action('IP не ротируется','d2stuck',m.stuck,'Не менялся более суток','', '↻');
  if(m.downServers.length){
    actions+='<button class="d2-action is-danger" data-on-click="d2OpenSettings(\'serverHealth\')"><span class="d2-action-mark">!</span><span><span class="d2-action-title">Сервер недоступен</span><span class="d2-action-sub">'+esc(m.downServers.map(_d2ServerName).join(', '))+'</span></span><span class="d2-action-count">'+m.downServers.length+'</span></button>';
  }
  if(m.debtors.length){
    actions+='<button class="d2-action is-business" data-on-click="d2OpenFinance()"><span class="d2-action-mark">₽</span><span><span class="d2-action-title">Клиенты в долгу</span><span class="d2-action-sub">'+_d2Money(m.debtSum)+' к получению</span></span><span class="d2-action-count">'+m.debtors.length+'</span></button>';
  }
  document.getElementById('d2Actions').innerHTML=actions||'<div class="d2-all-clear"><div><strong>Всё спокойно</strong>Нет событий, которые требуют действий.</div></div>';

  var byServer={};
  m.active.forEach(function(x){
    if(!byServer[x.server])byServer[x.server]={active:0,online:0,problems:0};
    byServer[x.server].active++;
    if(getModemStatus(x)!=='offline')byServer[x.server].online++;
  });
  m.offline.concat(m.proxy).concat(m.low).concat(m.stuck).forEach(function(x){if(byServer[x.server])byServer[x.server].problems++;});
  var downSet={};m.downServers.forEach(function(s){downSet[s]=true;});
  var serverNames=(currentData.servers||[]).map(function(s){return s.name;});
  Object.keys(byServer).forEach(function(s){if(serverNames.indexOf(s)<0)serverNames.push(s);});
  var serversHtml=serverNames.map(function(s){
    var b=byServer[s]||{active:0,online:0,problems:0};
    var pct=b.active?Math.round(b.online/b.active*100):100;
    var bad=downSet[s]||b.problems>0;
    var meter=downSet[s]?'bad':(pct<95?'warn':'');
    return '<div class="d2-server"><div class="d2-server-name"><strong>'+esc(_d2ServerName(s))+'</strong><small>'+(downSet[s]?'Сервер недоступен':(b.problems?b.problems+' требуют проверки':'Без активных проблем'))+'</small></div>'
      +'<div class="d2-server-meter '+(meter?'is-'+meter:'')+'"><span style="width:'+pct+'%"></span></div>'
      +'<div class="d2-server-stat"><strong>'+b.online+'/'+b.active+'</strong><small>прокси</small></div></div>';
  }).join('');
  document.getElementById('d2Servers').innerHTML=serversHtml||'<div class="d2-all-clear">Нет данных по серверам</div>';

  var capHtml=serverNames.map(function(s){
    var known=_d2SpareCache.hasOwnProperty(s),n=Number(_d2SpareCache[s]||0);
    var cls=known?(n===0?'is-bad':n<2?'is-warn':''):'';
    return '<div class="d2-capacity-row"><span><strong>'+esc(_d2ServerName(s))+'</strong><small>'+(known?(n?'Готовы принять failover':'Нет здорового свободного модема'):'Проверяем резерв…')+'</small></span><span class="d2-capacity-value '+cls+'">'+(known?n:'—')+'</span></div>';
  }).join('');
  document.getElementById('d2Capacity').innerHTML=capHtml+'<div class="d2-fin-note">'+(spareKnown?'Всего готовых резервов: '+spareTotal:'Резерв уточняется без блокировки экрана')+'</div>';

  document.getElementById('d2Finance').innerHTML='<div class="d2-fin-grid">'
    +'<div class="d2-fin"><span>Выручка 30д</span><strong>'+_d2Money(revenue)+'</strong></div>'
    +'<div class="d2-fin"><span>Расходы месяца</span><strong>'+(cost?_d2Money(cost):'—')+'</strong></div>'
    +'<div class="d2-fin '+(profitTone?'is-'+profitTone:'')+'"><span>Прибыль</span><strong>'+_d2Money(profit)+'</strong></div></div>'
    +'<div class="d2-fin-note">Финансы обновляются отдельно и не заставляют основной экран мигать.</div>';

  var stamp=document.getElementById('d2UpdatedAt');
  if(stamp)stamp.textContent='обновлено '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  if(typeof loadNewFinance==='function')loadNewFinance();
  _d2LoadSpares(serverNames);
}
function _d2LoadSpares(serverNames){
  if(!serverNames||!serverNames.length||Date.now()-_d2SpareAt<60000)return;
  _d2SpareAt=Date.now();
  Promise.all(serverNames.map(function(server){
    return api(API+'/api/admin/failover/spares?server='+encodeURIComponent(server))
      .then(function(d){_d2SpareCache[server]=Array.isArray(d.spares)?d.spares.length:0;})
      .catch(function(){delete _d2SpareCache[server];});
  })).then(function(){
    var active=localStorage.getItem('admin_active_tab');
    if(active==='dashboard2')renderDashboard2();
  });
}
function d2OpenModems(filter){
  var tab=document.querySelector('.nav-tab[data-on-click*="switchMainTab(\'modems\'"]');
  if(tab)switchMainTab('modems',tab);
  if(filter){activeQuickFilter=filter;renderTable();}
}
function d2OpenSettings(section){
  var tab=document.querySelector('.nav-tab[data-on-click*="switchMainTab(\'analytics\'"]');
  if(tab)switchMainTab('analytics',tab);
  setTimeout(function(){if(typeof switchSettingsSection==='function')switchSettingsSection(section);},60);
}
function d2OpenFinance(){
  var tab=document.querySelector('.nav-tab[data-on-click*="switchMainTab(\'bank\'"]');
  if(tab)switchMainTab('bank',tab);
}
