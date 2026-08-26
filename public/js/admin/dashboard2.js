'use strict';

// Dashboard 2 deliberately stays independent from the legacy command centre.
// It only consumes the already loaded admin snapshot and the existing finance
// endpoint, so switching tabs never blanks the page during background refresh.
var _d2SpareCache={};
var _d2SpareAt=0;
var _d2PackageCache=null;
var _d2PackageAt=0;

function _d2Money(v){
  if(v==null||isNaN(v))return '—';
  return Math.round(Number(v)||0).toLocaleString('ru-RU')+' ₽';
}
function _d2Plural(n,one,few,many){
  n=Math.abs(Number(n)||0)%100;var n1=n%10;
  return n>10&&n<20?many:n1===1?one:n1>=2&&n1<=4?few:many;
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
  var incidents=((currentData.incidents||{}).active||[]);
  var incidentMembers={};
  incidents.forEach(function(it){
    var members=[];try{members=JSON.parse(it.members_json||'[]')}catch(_){}
    members.forEach(function(member){incidentMembers[String(member.server||it.server||'')+'|'+String(member.nick||'')]=true;});
  });
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
    if(!proxyKeys[m.server+'|'+m.nick]&&(m.lowSpeed||m.baselineDegraded)){
      var speedDetail=m.baselineDegraded
        ? 'Сейчас '+Number(m.speedBaselineCurrent||0).toFixed(1)+' · норма '+Number(m.speedBaselineDl||0).toFixed(1)+' Мбит/с'
        : '↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Мбит/с';
      low.push({nick:m.nick,server:m.server,detail:speedDetail});
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
  // Members of an active correlated incident must not reappear as N separate
  // action rows. They remain visible inside the incident popup.
  offline=offline.filter(function(x){return !incidentMembers[x.server+'|'+x.nick];});
  proxy=proxy.filter(function(x){return !incidentMembers[x.server+'|'+x.nick];});
  low=low.filter(function(x){return !incidentMembers[x.server+'|'+x.nick];});
  stuck=stuck.filter(function(x){return !incidentMembers[x.server+'|'+x.nick];});
  return {mm:mm,active:active,offline:offline,proxy:proxy,low:low,stuck:stuck,incidents:incidents,
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
  var totalProblems=m.incidents.length+m.offline.length+m.proxy.length+m.low.length+m.stuck.length+m.downServers.length;
  var fin=window._newFinData||{};
  var fs=fin.summary||{};
  var forecast30=fin.revenue_forecast_30d||{};
  var aging=fin.receivables||{};
  var bankRec=fin.bank_reconciliation||{};
  var revenue=fs.revenue_30d_fact!=null?fs.revenue_30d_fact:fs.mrr;
  var cost=Number(fs.total_cost||0);
  var profit=revenue==null?null:Number(revenue)-cost;
  var activeTone=totalProblems?'bad':'good';
  var coverageTone=m.coverage>=95?'good':m.coverage>=80?'warn':'bad';
  var profitTone=profit==null?'':(profit>=0?'good':'bad');
  var spareTotal=Object.keys(_d2SpareCache).reduce(function(sum,k){return sum+Number(_d2SpareCache[k]||0);},0);
  var spareKnown=Object.keys(_d2SpareCache).length>0;

  document.getElementById('d2Kpis').innerHTML=
    _d2Kpi('Нужно проверить',String(totalProblems),totalProblems?m.affectedClients+' '+_d2Plural(m.affectedClients,'клиент затронут','клиента затронуто','клиентов затронуто'):'Инфраструктура работает штатно',activeTone)+
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
  if(m.incidents.length){
    actions+='<button class="d2-action is-danger" data-on-click="showDashboard2Incidents()"><span class="d2-action-mark">!</span><span><span class="d2-action-title">Групповые инциденты</span><span class="d2-action-sub">Связанные сбои объединены по серверу и оператору</span></span><span class="d2-action-count">'+m.incidents.length+'</span></button>';
  }
  actions+=_d2Action('Модемы отключены','d2offline',m.offline,'Активная аренда без связи','danger','!');
  actions+=_d2Action('Сбоит прокси','flaky',m.proxy,'Подтверждённые ping / HTTP / SIM проблемы','danger','!');
  actions+=_d2Action('Низкая скорость','d2speed',m.low,'Ниже рабочего порога','', '↓');
  actions+=_d2Action('IP не ротируется','d2stuck',m.stuck,'Не менялся более суток','', '↻');
  if(m.downServers.length){
    actions+='<button class="d2-action is-danger" data-on-click="d2OpenSettings(\'serverHealth\')"><span class="d2-action-mark">!</span><span><span class="d2-action-title">Сервер недоступен</span><span class="d2-action-sub">'+esc(m.downServers.map(_d2ServerName).join(', '))+'</span></span><span class="d2-action-count">'+m.downServers.length+'</span></button>';
  }
  if(m.debtors.length){
    var oldest=(aging.rows||[])[0];
    actions+='<button class="d2-action is-business" data-on-click="d2OpenFinance()"><span class="d2-action-mark">₽</span><span><span class="d2-action-title">Клиенты в долгу</span><span class="d2-action-sub">'+_d2Money(m.debtSum)+' к получению'+(oldest?' · до '+oldest.age_days+' д':'')+'</span></span><span class="d2-action-count">'+m.debtors.length+'</span></button>';
  }
  if(Number(bankRec.unmatched_count||0)||Number(bankRec.credited_missing_count||0)){
    var bankCount=Number(bankRec.unmatched_count||0)+Number(bankRec.credited_missing_count||0);
    actions+='<button class="d2-action is-business" data-on-click="d2OpenPayments()"><span class="d2-action-mark">₽</span><span><span class="d2-action-title">Сверка банка</span><span class="d2-action-sub">Платежи требуют сопоставления или проверки ledger</span></span><span class="d2-action-count">'+bankCount+'</span></button>';
  }
  document.getElementById('d2Actions').innerHTML=actions||'<div class="d2-all-clear"><div><strong>Всё спокойно</strong>Нет событий, которые требуют действий.</div></div>';

  var byServer={};
  m.active.forEach(function(x){
    if(!byServer[x.server])byServer[x.server]={active:0,online:0,problems:0};
    byServer[x.server].active++;
    if(getModemStatus(x)!=='offline')byServer[x.server].online++;
  });
  m.offline.concat(m.proxy).concat(m.low).concat(m.stuck).forEach(function(x){if(byServer[x.server])byServer[x.server].problems++;});
  m.incidents.forEach(function(it){
    if(!byServer[it.server])byServer[it.server]={active:0,online:0,problems:0,incidents:0};
    byServer[it.server].incidents=(byServer[it.server].incidents||0)+1;
  });
  var downSet={};m.downServers.forEach(function(s){downSet[s]=true;});
  var serverNames=(currentData.servers||[]).map(function(s){return s.name;});
  Object.keys(byServer).forEach(function(s){if(serverNames.indexOf(s)<0)serverNames.push(s);});
  var serversHtml=serverNames.map(function(s){
    var b=byServer[s]||{active:0,online:0,problems:0};
    var pct=b.active?Math.round(b.online/b.active*100):100;
    var incidentCount=Number(b.incidents||0);
    var meter=(downSet[s]||incidentCount)?'bad':(pct<95?'warn':'');
    var serverSub=downSet[s]?'Сервер недоступен':incidentCount
      ?incidentCount+' '+_d2Plural(incidentCount,'групповой инцидент','групповых инцидента','групповых инцидентов')
      :(b.problems?b.problems+' прокси требуют проверки':'Без активных проблем');
    return '<div class="d2-server"><div class="d2-server-name"><strong>'+esc(_d2ServerName(s))+'</strong><small>'+serverSub+'</small></div>'
      +'<div class="d2-server-meter '+(meter?'is-'+meter:'')+'"><span style="width:'+pct+'%"></span></div>'
      +'<div class="d2-server-stat"><strong>'+b.online+'/'+b.active+'</strong><small>прокси</small></div></div>';
  }).join('');
  document.getElementById('d2Servers').innerHTML=serversHtml||'<div class="d2-all-clear">Нет данных по серверам</div>';

  var capHtml=serverNames.map(function(s){
    var known=_d2SpareCache.hasOwnProperty(s),n=Number(_d2SpareCache[s]||0);
    var cls=known?(n===0?'is-bad':n<2?'is-warn':''):'';
    var met=((window._srvMetData||{}).metrics||{})[s]||{};
    var details=[];
    if(known)details.push(n?n+' резерв. мод.':'нет здорового резерва');else details.push('проверяем резерв');
    var cpu=met.cpu_forecast||{};
    if(cpu.status==='capacity_reached')details.push('CPU достиг '+Math.round(cpu.limit_pct||85)+'%');
    else if(cpu.status==='growing'&&cpu.days_left!=null){
      var cpuDays=Math.max(0,Math.round(cpu.days_left));
      details.push('CPU до '+Math.round(cpu.limit_pct||85)+'%: '+(cpuDays>=14?Math.round(cpuDays/7)+' нед':cpuDays+' д'));
    }
    var disk=met.disk_forecast||{};
    if(disk.status==='full')details.push('диск заполнен');
    else if(disk.status==='growing'&&disk.days_left!=null)details.push('диск: '+Math.max(0,Math.round(disk.days_left))+' д');
    if(cpu.status==='capacity_reached'||disk.status==='full')cls='is-bad';
    else if((cpu.status==='growing'&&cpu.days_left<35)||(disk.status==='growing'&&disk.days_left<30))cls='is-warn';
    return '<div class="d2-capacity-row"><span><strong>'+esc(_d2ServerName(s))+'</strong><small>'+esc(details.join(' · '))+'</small></span><span class="d2-capacity-value '+cls+'">'+(known?n:'—')+'</span></div>';
  }).join('');
  document.getElementById('d2Capacity').innerHTML=capHtml+'<div class="d2-fin-note">'+(spareKnown?'Всего готовых резервов: '+spareTotal:'Резерв уточняется без блокировки экрана')+'</div>';

  document.getElementById('d2Finance').innerHTML='<div class="d2-fin-grid">'
    +'<div class="d2-fin"><span>Выручка 30д</span><strong>'+_d2Money(revenue)+'</strong></div>'
    +'<div class="d2-fin"><span>Расходы месяца</span><strong>'+(cost?_d2Money(cost):'—')+'</strong></div>'
    +'<div class="d2-fin '+(profitTone?'is-'+profitTone:'')+'"><span>Прибыль</span><strong>'+_d2Money(profit)+'</strong></div></div>'
    +'<div class="d2-fin-note">Без продлений: '+_d2Money(forecast30.without_renewals)+' за 30 д'+(Number(forecast30.revenue_at_risk)>0?' · под риском '+_d2Money(forecast30.revenue_at_risk):'')+'.</div>';

  var packageBox=document.getElementById('d2Packages');
  if(packageBox){
    if(!_d2PackageCache){
      packageBox.innerHTML='<div class="d2-fin-note">Считаем прошлый тарифный период…</div>';
    }else if(!_d2PackageCache.length){
      packageBox.innerHTML='<div class="d2-fin-note">Пакеты операторов ещё не настроены.</div>';
    }else{
      packageBox.innerHTML=_d2PackageCache.slice(0,4).map(function(p){
        var unlimited=p.type==='unlimited';
        var pct=p.utilization_pct==null?null:Math.round(Number(p.utilization_pct));
        var tone=p.status==='overrun'?'is-bad':(pct!=null&&pct<50?'is-warn':'');
        var value=unlimited?Number(p.used_gb||0).toLocaleString('ru-RU')+' ГБ':pct==null?'—':pct+'%';
        var detail=unlimited?'безлимит · '+p.sim_count+' SIM':Number(p.unused_gb||0).toLocaleString('ru-RU')+' ГБ не использовано';
        if(Number(p.wasted_cost||0)>0)detail+=' · ~'+Math.round(p.wasted_cost).toLocaleString('ru-RU')+' '+esc(p.currency||'');
        return '<div class="d2-package-row"><span><strong>'+esc(p.operator||'Оператор')+'</strong><small>'+detail+'</small></span><span class="d2-package-value '+tone+'">'+value+'</span></div>';
      }).join('')+'<div class="d2-fin-note">Завершённый тарифный период: сколько оплаченного трафика не использовано.</div>';
    }
  }

  var stamp=document.getElementById('d2UpdatedAt');
  if(stamp)stamp.textContent='обновлено '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  if(typeof loadNewFinance==='function')loadNewFinance();
  _d2LoadSpares(serverNames);
  _d2LoadPackages();
}
function _d2LoadPackages(){
  if(Date.now()-_d2PackageAt<5*60000)return;
  _d2PackageAt=Date.now();
  api(API+'/api/admin/operator-package-forecast').then(function(d){
    _d2PackageCache=(d&&d.efficiency)||[];
    if(localStorage.getItem('admin_active_tab')==='dashboard2')renderDashboard2();
  }).catch(function(){_d2PackageAt=0;});
}
function showDashboard2Incidents(){
  var rows=((currentData&&currentData.incidents||{}).active||[]);if(!rows.length)return;
  var h='<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1500;display:flex;align-items:center;justify-content:center;padding:16px" data-on-click="if(event.target===this)this.remove()">'
    +'<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:14px;padding:20px;width:620px;max-width:100%;max-height:78vh;overflow:auto;box-shadow:0 24px 64px rgba(0,0,0,.35)">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px"><div><div class="d2-panel-kicker">Корреляция алертов</div><h3 style="margin:3px 0 0;font-size:16px">Активные инциденты</h3></div><button class="modal-close" data-on-click="this.closest(\'div[style*=fixed]\').remove()">&times;</button></div>';
  rows.forEach(function(it){
    var members=[];try{members=JSON.parse(it.members_json||'[]')}catch(_){}
    var mins=Math.max(1,Math.round((Date.now()-Date.parse(it.opened_at||new Date()))/60000));
    h+='<div style="padding:13px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-0);margin-bottom:8px">'
      +'<div style="display:flex;justify-content:space-between;gap:10px"><strong style="font-size:12px;color:var(--text-0)">'+esc(it.hypothesis||it.operator||'Общая проблема')+'</strong><span style="font:600 10px var(--font-mono);color:var(--danger);white-space:nowrap">'+mins+' мин</span></div>'
      +'<div style="margin-top:5px;font-size:10px;color:var(--text-2)">'+esc(_d2ServerName(it.server))+' · '+(it.modem_count||members.length)+' '+_d2Plural(it.modem_count||members.length,'модем','модема','модемов')+' · '+(it.client_count||0)+' '+_d2Plural(it.client_count||0,'клиент','клиента','клиентов')+'</div>'
      +'<div style="margin-top:8px;font-size:10px;color:var(--text-3);line-height:1.5">'+esc(members.map(function(x){return x.nick;}).filter(Boolean).join(', ')||'Состав уточняется')+'</div></div>';
  });
  h+='</div></div>';document.body.insertAdjacentHTML('beforeend',h);
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
  setTimeout(function(){if(typeof switchBankNav==='function')switchBankNav('overview');},50);
}
function d2OpenPayments(){
  var tab=document.querySelector('.nav-tab[data-on-click*="switchMainTab(\'bank\'"]');
  if(tab)switchMainTab('bank',tab);
  setTimeout(function(){if(typeof switchBankNav==='function')switchBankNav('payments');},50);
}
