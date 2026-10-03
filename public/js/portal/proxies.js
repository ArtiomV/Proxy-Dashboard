// public/js/portal/proxies.js — 3b «Прокси» + попапы 5c (смена IP, автосмена)
// и меню 5f (группировка, колонки). Выбор галочками → плашка массовых действий
// (экспорт реквизитов, смена IP, ротация). Данные — tableData (dashboard_data).
// Команды: POST /api/client/reset_ip {imei,serverName}, POST /api/client/set_rotation
// {nick,serverName,minutes}.

var pxState={filter:'all',q:'',group:V3.store.get('px_group','country'),cols:null};
var pxSel={};   // portId → true (переживает авторефреш)
var PX_COLS=[
  ['op','Оператор',1],['req','Реквизиты',1],['lp','Логин : пароль',1],['ip','Внешний IP',1],
  ['up','Аптайм',1],['rot','Ротация',1],['today','Сегодня',0],['month','За месяц',1]
];
(function(){
  var saved=V3.store.get('px_cols',null),c={};
  PX_COLS.forEach(function(x){c[x[0]]=saved&&saved[x[0]]!=null?!!saved[x[0]]:!!x[2]});
  pxState.cols=c;
})();
var PX_GROUPS=[['country','По стране'],['operator','По оператору'],['server','По серверу'],['none','Без группировки']];
var _pxRevealed={};   // portId → пароль показан

function _pxFiltered(){
  var q=pxState.q;
  return v3SortRows(tableData.filter(function(r){
    if(pxState.filter==='online'&&!V3.isOnline(r))return false;
    if(pxState.filter==='offline'&&V3.isOnline(r))return false;
    if(pxState.filter==='rot'&&!(V3.rotMin(r)>0))return false;
    return v3Match(r,q);
  }));
}
function pxSelected(){return tableData.filter(function(r){return pxSel[r.portId]})}

// ---------- действия фильтров/меню ----------
function pxSetFilter(f){pxState.filter=f;renderProxies()}
function pxSetSearch(v){pxState.q=String(v||'').trim().toLowerCase();renderProxies()}
function pxResetFilters(){pxState.filter='all';pxState.q='';var i=document.getElementById('pxSearch');if(i)i.value='';renderProxies()}
function pxSetGroup(g){pxState.group=g;V3.store.set('px_group',g);V3.closeMenus();renderProxies()}
function pxToggleCol(k){pxState.cols[k]=!pxState.cols[k];V3.store.set('px_cols',pxState.cols);_pxMenus();_pxTable()}
function pxResetCols(){PX_COLS.forEach(function(x){pxState.cols[x[0]]=!!x[2]});V3.store.set('px_cols',pxState.cols);_pxMenus();_pxTable()}
function pxToggle(pid){if(pxSel[pid])delete pxSel[pid];else pxSel[pid]=true;_pxTable();_pxSelBar()}
function pxToggleAll(){
  var rows=_pxFiltered(),all=rows.length&&rows.every(function(r){return pxSel[r.portId]});
  rows.forEach(function(r){if(all)delete pxSel[r.portId];else pxSel[r.portId]=true});
  _pxTable();_pxSelBar();
}
function pxToggleGroup(key){
  var rows=_pxFiltered().filter(function(r){return _pxGroupKey(r)===key});
  var all=rows.every(function(r){return pxSel[r.portId]});
  rows.forEach(function(r){if(all)delete pxSel[r.portId];else pxSel[r.portId]=true});
  _pxTable();_pxSelBar();
}
function pxClearSel(){pxSel={};_pxTable();_pxSelBar()}
function pxReveal(pid){_pxRevealed[pid]=!_pxRevealed[pid];_pxTable()}
function pxCopy(pid,what){
  var r=_pxRow(pid);if(!r)return;
  var ip=V3.serverIp(r),v='',t='Скопировано';
  if(what==='http'){v=ip+':'+r.httpPort;t='HTTP-адрес скопирован'}
  else if(what==='socks'){v=ip+':'+r.socksPort;t='SOCKS5-адрес скопирован'}
  else if(what==='lp'){v=r.proxyLogin+':'+r.proxyPassword;t='Логин и пароль скопированы'}
  else if(what==='ip'){v=r.extIp;t='IP скопирован'}
  V3.copy(v,t,r.modemNick);
}
function _pxRow(pid){for(var i=0;i<tableData.length;i++)if(tableData[i].portId===pid)return tableData[i];return null}

// ---------- рендер ----------
function renderProxies(){
  if(!document.getElementById('tab-traffic'))return;
  v3NavCounts();
  if(!rawData)return;
  // выбор — только по существующим портам
  for(var k in pxSel)if(!_pxRow(k))delete pxSel[k];
  _pxChips();_pxMenus();_pxTable();_pxSelBar();
}
function _pxChips(){
  var n=tableData.length,on=tableData.filter(V3.isOnline).length,rot=tableData.filter(function(r){return V3.rotMin(r)>0}).length;
  var c=[['all','Все '+n],['online','Онлайн '+on],['offline','Офлайн '+(n-on)],['rot','С ротацией '+rot]];
  document.getElementById('pxChips').innerHTML=c.map(function(x){return '<button type="button" class="v3-chip'+(pxState.filter===x[0]?' on':'')+'" data-on-click="pxSetFilter(\''+x[0]+'\')">'+x[1]+'</button>'}).join('');
}
function _pxMenus(){
  var g=PX_GROUPS.filter(function(x){return x[0]===pxState.group})[0]||PX_GROUPS[0];
  document.getElementById('pxGroupBtn').textContent='Группировка: '+g[1].toLowerCase()+' ▾';
  document.getElementById('pxGroupMenu').innerHTML=PX_GROUPS.map(function(x){
    var on=x[0]===pxState.group;
    return '<div class="v3-menu-i'+(on?' on':'')+'" data-on-click="pxSetGroup(\''+x[0]+'\')">'+x[1]+'<span class="mk">'+(on?'✓':'')+'</span></div>';
  }).join('');
  document.getElementById('pxColsMenu').innerHTML=PX_COLS.map(function(x){
    return '<div class="v3-menu-i chk" data-on-click="pxToggleCol(\''+x[0]+'\')"><span class="v3-check'+(pxState.cols[x[0]]?' on':'')+'"></span>'+x[1]+'</div>';
  }).join('')+'<div class="v3-menu-foot" data-on-click="pxResetCols()">Сбросить по умолчанию</div>';
}
function _pxGroupKey(r){
  if(pxState.group==='operator')return r.operator||'Оператор не определён';
  if(pxState.group==='server')return r.serverName||'—';
  if(pxState.group==='none')return '';
  return V3.cc(r);
}
function _pxGroupName(key){
  if(pxState.group==='country')return V3.ccName(key);
  if(pxState.group==='server'){var c=COUNTRIES[key]||{};return (c.displayName&&c.displayName!==key?c.displayName:key)}
  return key;
}
function _pxTable(){
  var cols=pxState.cols,rows=_pxFiltered(),body=document.getElementById('pxBody');
  var allSel=rows.length&&rows.every(function(r){return pxSel[r.portId]}),someSel=rows.some(function(r){return pxSel[r.portId]});
  var th='<tr><th style="width:34px"><span class="v3-check'+(allSel?' on':someSel?' mixed':'')+'" data-on-click="pxToggleAll()"></span></th><th>Модем</th>';
  if(cols.req)th+='<th>Реквизиты</th>';
  if(cols.lp)th+='<th>Логин : пароль</th>';
  if(cols.ip)th+='<th>Внешний IP</th>';
  if(cols.up)th+='<th class="r">Аптайм</th>';
  if(cols.rot)th+='<th class="r">Ротация</th>';
  if(cols.today)th+='<th class="r">Сегодня</th>';
  if(cols.month)th+='<th class="r">За месяц</th>';
  th+='<th class="r">Действия</th></tr>';
  document.getElementById('pxHead').innerHTML=th;
  var ncol=3+['req','lp','ip','up','rot','today','month'].filter(function(k){return cols[k]}).length;
  if(!rows.length){
    var filtered=pxState.q||pxState.filter!=='all';
    body.innerHTML='<tr><td colspan="'+ncol+'">'+(filtered
      ?'<div class="v3-emptybox bare"><span class="ic">'+V3.ic.empty+'</span><div class="t">Ничего не нашлось</div><div class="d">'+(pxState.q?'По запросу «'+V3.esc(pxState.q)+'» нет прокси. ':'')+'Проверьте ник или сбросьте фильтр'+(pxState.filter!=='all'?' «'+{online:'Онлайн',offline:'Офлайн',rot:'С ротацией'}[pxState.filter]+'»':'')+'.</div><button type="button" class="v3-btn link" data-on-click="pxResetFilters()">Сбросить фильтры</button></div>'
      :'<div class="v3-emptybox bare"><span class="ic acc">⌁</span><div class="t">Прокси пока нет</div><div class="d">Когда прокси будут выданы, здесь появятся реквизиты и управление.</div></div>')+'</td></tr>';
    return;
  }
  var total=tableData.reduce(function(s,r){return s+V3.month(r)},0),avg=tableData.length?total/tableData.length:0;
  var groups=[],gi={};
  rows.forEach(function(r){var k=_pxGroupKey(r);if(!(k in gi)){gi[k]=groups.length;groups.push({key:k,rows:[]})}groups[gi[k]].rows.push(r)});
  var h='';
  groups.forEach(function(g){
    if(pxState.group!=='none'){
      var gm=g.rows.reduce(function(s,r){return s+V3.month(r)},0);
      var hosts={};g.rows.forEach(function(r){var ip=V3.serverIp(r);if(ip)hosts[ip]=1});
      var hl=Object.keys(hosts);
      var gsel=g.rows.every(function(r){return pxSel[r.portId]});
      h+='<tr class="grp"><td colspan="'+ncol+'"><span class="v3-grp-name" style="cursor:pointer" data-on-click="pxToggleGroup('+V3.q(g.key)+')" title="Выбрать группу">'+V3.esc(_pxGroupName(g.key))+(gsel?' ✓':'')+'</span><span class="v3-grp-meta">'+g.rows.length+' прокси · '+V3.gb(gm)+' за месяц'+(hl.length===1?' · сервер '+V3.esc(hl[0]):hl.length>1?' · серверов '+hl.length:'')+'</span></td></tr>';
    }
    g.rows.forEach(function(r,i){
      var f=v3RowFlags(r,avg,tableData.length),up=r.uptimePct!=null?parseFloat(r.uptimePct):null,ip=V3.serverIp(r);
      var sel=!!pxSel[r.portId],net=V3.netType(r.networkType),lbl=V3.label(r.modemNick);
      var sub=[r.operator,net,r.modemModel].filter(Boolean).join(' · ');
      var on=V3.isOnline(r);
      h+='<tr'+(i%2?' class="z"':'')+'>';
      h+='<td><span class="v3-check'+(sel?' on':'')+'" data-on-click="pxToggle('+V3.q(r.portId)+')"></span></td>';
      h+='<td><span class="v3-stripe'+f.stripe+'"></span><span class="mono ink b">'+V3.esc(r.modemNick)+'</span>'+f.badge+
        (cols.op||lbl?'<div class="v3-sub10" style="margin-left:10px">'+(lbl?'<span style="color:var(--v3-text)">'+V3.esc(lbl)+'</span>'+(cols.op&&sub?' · ':''):'')+(cols.op?V3.esc(sub||'—'):'')+'</div>':'')+'</td>';
      if(cols.req){
        h+='<td class="mono txt">'+(r.httpPort||r.socksPort
          ?(r.httpPort?'<div>HTTP <span class="ink" style="cursor:copy" data-on-click="pxCopy('+V3.q(r.portId)+',\'http\')" title="Скопировать">'+V3.esc(ip+':'+r.httpPort)+'</span></div>':'')+
           (r.socksPort?'<div>SOCKS5 <span class="ink" style="cursor:copy" data-on-click="pxCopy('+V3.q(r.portId)+',\'socks\')" title="Скопировать">'+V3.esc(ip+':'+r.socksPort)+'</span></div>':'')
          :'—')+'</td>';
      }
      if(cols.lp){
        h+='<td class="mono txt">'+(r.proxyLogin
          ?V3.esc(r.proxyLogin)+' : '+(_pxRevealed[r.portId]?'<span class="ink">'+V3.esc(r.proxyPassword)+'</span>':'••••••••')+
            ' <button type="button" class="v3-iconbtn" data-on-click="pxReveal('+V3.q(r.portId)+')" title="Показать/скрыть пароль">'+(_pxRevealed[r.portId]?'◡':'◉')+'</button>'+
            '<button type="button" class="v3-iconbtn" data-on-click="pxCopy('+V3.q(r.portId)+',\'lp\')" title="Скопировать логин:пароль">⧉</button>'
          :'—')+'</td>';
      }
      if(cols.ip)h+='<td class="mono txt"><div>'+V3.esc(on&&r.extIp&&r.extIp!=='IP_RESET'?r.extIp:'—')+'</div><div class="v3-sub10">'+V3.esc(V3.ipSince(r))+'</div></td>';
      if(cols.up)h+='<td class="r mono b '+v3UpCls(up)+'">'+(up!=null?V3.pct(up):'—')+'</td>';
      if(cols.rot)h+='<td class="r mono mut">'+(V3.rotMin(r)>0?V3.rotMin(r)+' мин':'—')+'</td>';
      if(cols.today)h+='<td class="r mono ink b">'+V3.gb(V3.today_(r))+'</td>';
      if(cols.month)h+='<td class="r mono ink b">'+V3.gb(V3.month(r))+'</td>';
      h+='<td class="r"><span style="display:inline-flex;gap:6px;justify-content:flex-end">'+
        '<button type="button" class="v3-btn sm link" data-on-click="pxResetIp('+V3.q(r.portId)+')"'+(r.rawImei?'':' disabled')+'>Сменить IP</button>'+
        '<button type="button" class="v3-btn sm" data-on-click="openCard('+V3.q(r.portId)+')">Детали</button></span></td>';
      h+='</tr>';
    });
  });
  body.innerHTML=h;
}
function _pxSelBar(){
  var n=pxSelected().length,bar=document.getElementById('pxSelBar');
  if(!bar)return;
  bar.classList.toggle('show',n>0);
  document.getElementById('pxSelN').textContent=n;
  document.getElementById('pxSelL').textContent=V3.plural(n,'прокси выбран','прокси выбрано','прокси выбрано');
}

// ================= Смена IP (5c): подтверждение → процесс → результат =================
function pxResetIp(pid){var r=_pxRow(pid);if(r)v3ResetIpFlow(r)}
function v3ResetIpFlow(r){
  var oldIp=V3.isOnline(r)&&r.extIp&&r.extIp!=='IP_RESET'?r.extIp:'—';
  var m=V3.modal('<div id="ipDlg"></div>',{width:'w400'});
  var box=m.querySelector('#ipDlg');
  function state(s,o){
    o=o||{};
    var ic=s==='done'?'<span class="ic ok">✓</span>':s==='fail'?'<span class="ic bad">!</span>':'<span class="ic">'+(s==='run'?'…':'↻')+'</span>';
    var title=s==='ask'?'Сменить IP у '+r.modemNick+'?':s==='run'?'Меняем IP…':s==='done'?o.title:'Не удалось сменить IP';
    var text=s==='ask'?'Активные соединения через этот прокси оборвутся на 5–15 секунд.'+(V3.rotMin(r)>0?' Автосмена продолжит считать интервал заново.':'')
      :s==='run'?'Модем переподключается к сети оператора. Окно можно закрыть — новый IP появится в списке.'
      :s==='done'?'Прокси снова принимает соединения. Логин, пароль и порт не изменились.':o.text||'';
    var to=s==='done'?'<span class="to ok">'+V3.esc(o.newIp)+'</span>':s==='run'?'<span class="to">ожидание</span>':'<span class="to">новый IP</span>';
    box.innerHTML='<div class="v3-dlg">'+ic+'<h3>'+V3.esc(title)+'</h3><p>'+V3.esc(text)+'</p>'+
      '<div class="v3-ipflow"><span class="from">'+V3.esc(oldIp)+'</span><span class="arr">→</span>'+to+'</div>'+
      (s==='run'?'<div class="v3-progress"><span></span></div>':'')+'</div>'+
      '<div class="v3-mf">'+
        (s==='ask'?'<button type="button" class="v3-btn" data-a="cancel">Отмена</button><button type="button" class="v3-btn primary" data-a="go">Сменить IP</button>':'')+
        (s==='run'?'<button type="button" class="v3-btn" data-a="cancel">Свернуть</button>':'')+
        (s==='done'?'<button type="button" class="v3-btn" data-a="copy">Копировать IP</button><button type="button" class="v3-btn primary" data-a="cancel">Готово</button>':'')+
        (s==='fail'?'<button type="button" class="v3-btn" data-a="cancel">Закрыть</button><button type="button" class="v3-btn primary" data-a="go">Повторить</button>':'')+
      '</div>';
    box.querySelectorAll('[data-a]').forEach(function(b){b.addEventListener('click',function(){
      var a=b.getAttribute('data-a');
      if(a==='cancel')V3.closeModal(m);
      else if(a==='go')run();
      else if(a==='copy')V3.copy(o.newIp,'IP скопирован',r.modemNick);
    })});
  }
  function run(){
    state('run');
    var t0=Date.now();
    v3ResetIp(r).then(function(){
      return v3WaitNewIp(r,oldIp);
    }).then(function(newIp){
      var sec=Math.round((Date.now()-t0)/1000);
      if(newIp){
        if(m.isConnected)state('done',{title:'IP сменён за '+sec+' '+V3.plural(sec,'секунду','секунды','секунд'),newIp:newIp});
        V3.toast({title:'IP сменён · '+r.modemNick,text:oldIp+' → '+newIp,action:'Копировать',onAction:function(){V3.copy(newIp,'IP скопирован')}});
      }else{
        if(m.isConnected)state('done',{title:'Команда на смену IP отправлена',newIp:'обновится в списке'});
      }
    }).catch(function(e){
      if(m.isConnected)state('fail',{text:e.message||'Попробуйте ещё раз через минуту.'});
      else V3.toast({kind:'err',title:'Не удалось сменить IP',text:r.modemNick+': '+(e.message||''),action:'Повторить',onAction:function(){v3ResetIpFlow(r)}});
    });
  }
  state('ask');
}
function v3ResetIp(r){
  return api('/api/client/reset_ip',{method:'POST',json:{imei:r.rawImei,serverName:r.serverName}}).then(function(d){
    if(!d||d.ok===false||d.error)throw new Error((d&&(d.error||d.details))||'Смена IP не удалась');
    return d;
  });
}
// ждём новый IP: обновляем данные через ~10 и ~25 с (dashboard_data тяжёлый — не чаще)
function v3WaitNewIp(r,oldIp){
  var tries=[10000,15000];
  function step(){
    if(!tries.length)return Promise.resolve(null);
    var wait=tries.shift();
    return new Promise(function(res){setTimeout(res,wait)}).then(function(){return loadData()}).then(function(){
      var cur=_pxRow(r.portId);
      if(cur&&V3.isOnline(cur)&&cur.extIp&&cur.extIp!=='IP_RESET'&&cur.extIp!==oldIp)return cur.extIp;
      return step();
    });
  }
  return step();
}

// массовая смена IP
function pxBulkResetIp(){
  var rows=pxSelected().filter(function(r){return r.rawImei});
  if(!rows.length)return;
  V3.confirm({title:'Сменить IP у '+rows.length+' '+V3.plural(rows.length,'прокси','прокси','прокси')+'?',
    text:'Активные соединения через выбранные прокси оборвутся на 5–15 секунд.',
    detail:rows.map(function(r){return r.modemNick}).join(', '),cta:'Сменить IP',danger:false,icon:'↻'}).then(function(ok){
    if(!ok)return;
    var okN=0,fail=[];
    var chain=Promise.resolve();
    rows.forEach(function(r){chain=chain.then(function(){return v3ResetIp(r).then(function(){okN++},function(e){fail.push(r.modemNick+': '+(e.message||'ошибка'))})})});
    V3.toast({kind:'info',title:'Меняем IP у '+rows.length+' прокси…'});
    chain.then(function(){
      if(okN)V3.toast({title:'IP меняется у '+okN+' прокси',text:'Новые адреса появятся в списке через несколько секунд.'});
      if(fail.length)V3.toast({kind:'err',title:'Не удалось у '+fail.length+' прокси',text:fail.slice(0,3).join('; ')});
      setTimeout(function(){loadData()},12000);
    });
  });
}

// ================= Автосмена IP (5c, массово) =================
var ROT_PRESETS=[0,2,5,10,15,30,60];
function pxBulkRotation(){var rows=pxSelected();if(rows.length)v3RotationModal(rows)}
function v3RotationModal(rows){
  var cur=rows.map(V3.rotMin),same=cur.every(function(v){return v===cur[0]});
  var pick=same&&ROT_PRESETS.indexOf(cur[0])>=0&&cur[0]>0?cur[0]:10;
  var m=V3.modal(V3.mh('Автосмена IP','<span class="v3-chip on static">'+rows.length+' прокси</span>')+'<div class="v3-mb" id="rotBody"></div><div class="v3-mf"><button type="button" class="v3-btn" data-a="off">Выключить автосмену</button><button type="button" class="v3-btn primary" data-a="apply">Применить к '+rows.length+'</button></div>',{width:'w460'});
  var body=m.querySelector('#rotBody');
  function draw(){
    var diff=rows.filter(function(r){return V3.rotMin(r)!==pick});
    body.innerHTML='<div class="v3-nicks">'+rows.map(function(r){return '<span>'+V3.esc(r.modemNick)+'</span>'}).join('')+'</div>'+
      '<div class="v3-field"><span class="v3-label">Интервал смены</span><div style="display:flex;flex-wrap:wrap;gap:6px">'+
      ROT_PRESETS.filter(function(x){return x>0}).map(function(x){return '<button type="button" class="v3-chip'+(x===pick?' on':'')+'" data-v="'+x+'">'+x+' мин</button>'}).join('')+'</div></div>'+
      diff.filter(function(r){return V3.rotMin(r)>0}).slice(0,3).map(function(r){return '<div class="v3-warnline">У '+V3.esc(r.modemNick)+' сейчас '+V3.rotMin(r)+' мин — значение будет заменено.</div>'}).join('');
    body.querySelectorAll('[data-v]').forEach(function(b){b.addEventListener('click',function(){pick=parseInt(b.getAttribute('data-v'),10);draw()})});
  }
  draw();
  function apply(mins,btn){
    btn.disabled=true;var t=btn.textContent;
    var done=0,fail=[];
    var chain=Promise.resolve();
    rows.forEach(function(r){chain=chain.then(function(){
      btn.textContent='Применяем… '+(done+fail.length+1)+'/'+rows.length;
      return v3SetRotation(r,mins).then(function(){done++},function(e){fail.push(r.modemNick+': '+(e.message||'ошибка'))});
    })});
    chain.then(function(){
      btn.disabled=false;btn.textContent=t;
      if(done){
        V3.toast({title:mins?'Автосмена '+mins+' мин · '+done+' прокси':'Автосмена выключена · '+done+' прокси'});
        rows.forEach(function(r){if(fail.join('|').indexOf(r.modemNick+':')<0)r.autoRotation=String(mins)});
        renderProxies();
      }
      if(fail.length)V3.toast({kind:'err',title:'Не применилось у '+fail.length+' прокси',text:fail.slice(0,3).join('; ')});
      if(!fail.length)V3.closeModal(m);
    });
  }
  m.querySelector('[data-a="apply"]').addEventListener('click',function(){apply(pick,this)});
  m.querySelector('[data-a="off"]').addEventListener('click',function(){apply(0,this)});
}
function v3SetRotation(r,mins){
  return api('/api/client/set_rotation',{method:'POST',json:{nick:r.modemNick,serverName:r.serverName,minutes:mins}}).then(function(d){
    if(!d||!d.ok)throw new Error((d&&(d.error||d.details))||'не удалось');
    return d;
  });
}
