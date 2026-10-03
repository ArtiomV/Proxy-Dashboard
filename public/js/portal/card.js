// public/js/portal/card.js — 3d «Карточка прокси» (+ 5a): вкладки Обзор ·
// Трафик · Ротации IP · Настройки.
// API: /api/client/daily_traffic (трафик порта по дням, вход/выход),
//      /api/client/rotation_log (журнал ротаций, счётчики),
//      /api/client/proxy_prefs (своё название, уведомления офлайн),
//      /api/client/set_rotation, /api/client/proxy_password, /api/client/reset_link/rotate.

var cdState={pid:null,tab:'overview',range:30,rotFilter:'all',rotLimit:10,rot:null,rotList:null,traffic:null,name:'',auto:false,interval:10,notify:false};
V3.notify={};V3.tgLinked=false;

function v3LoadLabels(){
  return api('/api/client/proxy_prefs').then(function(d){
    if(!d||d.error)return;
    V3.labels=d.labels||{};V3.notify=d.notifyOffline||{};V3.tgLinked=!!d.tgLinked;
    if(document.getElementById('tab-traffic').classList.contains('active'))renderProxies();
  }).catch(function(){});
}

function openCard(pid,tab){
  var r=_pxRow(pid);if(!r)return;
  cdState.pid=pid;cdState.tab=tab||'overview';cdState.rot=null;cdState.rotList=null;cdState.traffic=null;cdState.rotFilter='all';cdState.rotLimit=10;
  cdState.name=V3.label(r.modemNick);cdState.notify=!!V3.notify[r.modemNick];
  var rm=V3.rotMin(r);cdState.auto=rm>0;cdState.interval=rm>0?rm:10;
  V3.modal('<div id="cdRoot"></div>',{width:'',onClose:function(){cdState.pid=null}});
  _cdRender();
  _cdLoadRot();
}
function cdTab(t){cdState.tab=t;_cdRender();if(t==='traffic')_cdLoadTraffic()}
function cdRange(n){cdState.range=n;cdState.traffic=null;_cdRender();_cdLoadTraffic()}
function cdRotFilter(f){cdState.rotFilter=f;cdState.rotLimit=10;cdState.rotList=null;_cdRender();_cdLoadRotList()}
function cdRotMore(){cdState.rotLimit+=20;_cdLoadRotList()}
function cdCopy(what){
  var r=_pxRow(cdState.pid);if(!r)return;
  var ip=V3.serverIp(r),map={http:ip+':'+r.httpPort,socks:ip+':'+r.socksPort,login:r.proxyLogin,pass:r.proxyPassword,link:r.resetSecureLink,ip:r.extIp,port:r.portName};
  if(!map[what])return;
  V3.copy(map[what],{http:'HTTP-адрес скопирован',socks:'SOCKS5-адрес скопирован',login:'Логин скопирован',pass:'Пароль скопирован',link:'Ссылка смены IP скопирована',ip:'IP скопирован',port:'Скопировано'}[what],r.modemNick);
}
function cdResetIp(){var r=_pxRow(cdState.pid);if(r){V3.closeModal();v3ResetIpFlow(r)}}
function cdExport(){var p=cdState.pid;V3.closeModal();openExport('sel',p)}

function _cdLoadRot(){
  var r=_pxRow(cdState.pid);if(!r)return;
  api('/api/client/rotation_log?nick='+encodeURIComponent(r.modemNick)+'&serverName='+encodeURIComponent(r.serverName)+'&days=30&limit=10').then(function(d){
    cdState.rot=d&&!d.error?d:{error:(d&&d.error)||'нет данных',counts:{all:0,timer:0,manual:0,ext:0},entries:[],perDay:{}};
    if(cdState.rotFilter==='all')cdState.rotList=cdState.rot;
    _cdRender();
  }).catch(function(){cdState.rot={error:'нет связи',counts:{all:0,timer:0,manual:0,ext:0},entries:[],perDay:{}};_cdRender()});
}
function _cdLoadRotList(){
  var r=_pxRow(cdState.pid);if(!r)return;
  api('/api/client/rotation_log?nick='+encodeURIComponent(r.modemNick)+'&serverName='+encodeURIComponent(r.serverName)+'&days=30&reason='+cdState.rotFilter+'&limit='+cdState.rotLimit).then(function(d){
    cdState.rotList=d&&!d.error?d:{entries:[],total:0};_cdRender();
  });
}
function _cdLoadTraffic(){
  var r=_pxRow(cdState.pid);if(!r||cdState.traffic)return;
  var to=V3.today(),from=V3.ymd(V3.addDays(V3.parse(to),-(cdState.range-1)));
  V3.daily(from,to).then(function(res){
    var days=[];
    for(var i=0;i<cdState.range;i++){
      var ymd=V3.ymd(V3.addDays(V3.parse(from),i)),e=(res.byDate[ymd]||{})[r.portId]||{in:0,out:0};
      days.push({ymd:ymd,inB:e.in,outB:e.out});
    }
    cdState.traffic={from:from,to:to,days:days};_cdRender();
  }).catch(function(){cdState.traffic={failed:true,days:[]};_cdRender()});
}

// ---------- рендер ----------
function _cdRender(){
  var root=document.getElementById('cdRoot'),r=_pxRow(cdState.pid);
  if(!root)return;
  if(!r){root.innerHTML=V3.mh('Прокси')+'<div class="v3-mb">Прокси больше не назначен вашему аккаунту.</div>';return}
  var on=V3.isOnline(r),rot=V3.isRotating(r);
  var st=rot?'<span class="v3-status rot">Смена IP</span>':on?'<span class="v3-status">Online</span>':'<span class="v3-status off">Offline</span>';
  var sub=[V3.label(r.modemNick),r.operator,V3.ccName(V3.cc(r))].filter(Boolean).join(' · ');
  var stripe=on?'':' bad';
  var h='<div class="v3-mh"><span class="v3-stripe'+stripe+'" style="margin:0"></span><h3 class="mono">'+V3.esc(r.modemNick)+'</h3>'+st+'<span class="sub">'+V3.esc(sub)+'</span><button class="v3-x" type="button" data-on-click="v3CloseModal()" aria-label="Закрыть">×</button></div>';
  var rc=cdState.rot&&cdState.rot.counts?cdState.rot.counts.all:null;
  h+='<div class="v3-tabs">'+[['overview','Обзор'],['traffic','Трафик'],['rot','Ротации IP'],['settings','Настройки']].map(function(t){
    return '<button type="button" class="v3-tab'+(cdState.tab===t[0]?' on':'')+'" data-on-click="cdTab(\''+t[0]+'\')">'+t[1]+(t[0]==='rot'&&rc!=null?'<span class="n">'+V3.group(rc)+'</span>':'')+'</button>';
  }).join('')+'</div>';
  if(cdState.tab==='overview')h+=_cdOverview(r);
  else if(cdState.tab==='traffic')h+=_cdTraffic(r);
  else if(cdState.tab==='rot')h+=_cdRot(r);
  else h+=_cdSettings(r);
  root.innerHTML=h;
  if(cdState.tab==='traffic')_cdBars();
}
function _cdRotSummary(r){
  var m=V3.rotMin(r);
  if(!(m>0))return 'выключена — IP меняется только вручную или по ссылке';
  var left=V3.rotLeft(r);
  return 'каждые '+m+' мин'+(left!=null?' · следующая смена через '+V3.pad(Math.floor(left/60))+':'+V3.pad(left%60):'');
}
function _cdOverview(r){
  var ip=V3.serverIp(r),up=r.uptimePct!=null?parseFloat(r.uptimePct):null;
  var link=r.resetSecureLink?String(r.resetSecureLink).replace(/^https?:\/\//,''):'';
  if(link.length>30)link=link.slice(0,27)+'…';
  var kv=function(k,v,c){return '<div class="v3-kv"><span class="k">'+k+'</span><span class="v">'+V3.esc(v||'—')+'</span>'+(c&&v?'<button type="button" class="c" data-on-click="cdCopy(\''+c+'\')" title="Скопировать">⧉</button>':'')+'</div>'};
  var c=COUNTRIES[r.serverName]||{};
  var h='<div class="v3-mb">';
  h+='<div class="v3-grid2" style="margin:0">';
  h+='<div class="v3-box"><div class="v3-cap" style="margin-bottom:8px">Доступ</div>'+
    kv('HTTP',r.httpPort?ip+':'+r.httpPort:'','http')+kv('SOCKS5',r.socksPort?ip+':'+r.socksPort:'','socks')+
    kv('Логин',r.proxyLogin,'login')+kv('Пароль',r.proxyPassword?'••••••••':'','pass')+
    kv('Ссылка смены IP',link,'link')+kv('Порт клиента',r.portName,'port')+'</div>';
  h+='<div class="v3-box"><div class="v3-cap" style="margin-bottom:8px">Устройство и сеть</div>'+
    kv('Оператор',r.operator)+kv('Тип сети',V3.netType(r.networkType))+kv('Модель модема',r.modemModel)+
    kv('Внешний IP',V3.isOnline(r)&&r.extIp!=='IP_RESET'?r.extIp:'','ip')+kv('IP получен',(V3.ipSince(r)||'').replace(/^с /,''))+
    kv('Локация',V3.ccName(V3.cc(r))+' · сервер '+(c.displayName&&c.displayName!==r.serverName?c.displayName:r.serverName))+'</div>';
  h+='</div>';
  var rc=cdState.rot&&cdState.rot.counts?V3.group(cdState.rot.counts.all):'…';
  h+='<div class="v3-tiles">'+
    '<div class="v3-tile"><div class="v3-tile-l">Сегодня</div><div class="v3-tile-v">'+V3.gb(V3.today_(r))+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">За месяц</div><div class="v3-tile-v">'+V3.gb(V3.month(r))+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">Аптайм 30 дн</div><div class="v3-tile-v '+(up==null?'':up>=99?'good':up>=95?'warn':'bad')+'">'+(up!=null?V3.pct(up):'—')+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">Ротаций за месяц</div><div class="v3-tile-v">'+rc+'</div></div></div>';
  h+='<div class="v3-box" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div><div style="font-size:11px;color:var(--v3-muted);margin-bottom:4px">Автосмена IP</div><div style="font-size:12.5px;color:var(--v3-ink);font-weight:600">'+V3.esc(_cdRotSummary(r))+'</div></div>'+
    '<span style="margin-left:auto;display:inline-flex;gap:8px;flex-wrap:wrap">'+
      (r.resetSecureLink?'<button type="button" class="v3-btn white" data-on-click="cdCopy(\'link\')">Ссылка смены IP ⧉</button>':'')+
      '<button type="button" class="v3-btn primary" data-on-click="cdResetIp()"'+(r.rawImei?'':' disabled')+'>Сменить IP сейчас</button></span></div>';
  h+='</div>';
  return h;
}
function _cdTraffic(){
  var t=cdState.traffic;
  var h='<div class="v3-mb"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="v3-seg">'+[[7,'7 дней'],[14,'14 дней'],[30,'30 дней']].map(function(x){return '<button type="button" class="'+(cdState.range===x[0]?'on':'')+'" data-on-click="cdRange('+x[0]+')">'+x[1]+'</button>'}).join('')+'</span>'+
    '<span class="v3-legend"><span><i class="v3-dot" style="background:#2f6fe0"></i>Входящий</span><span><i class="v3-dot" style="background:#10b981"></i>Исходящий</span></span></div>';
  h+='<div id="cdBars">'+(t?'':'<div class="v3-skel" style="height:190px"></div>')+'</div>';
  if(t&&!t.failed){
    var sumIn=0,sumOut=0,peak=0;t.days.forEach(function(d){sumIn+=d.inB;sumOut+=d.outB;peak=Math.max(peak,d.inB+d.outB)});
    h+='<div class="v3-tiles">'+
      '<div class="v3-tile"><div class="v3-tile-l">За '+cdState.range+' дн</div><div class="v3-tile-v">'+V3.gb(sumIn+sumOut)+'</div></div>'+
      '<div class="v3-tile"><div class="v3-tile-l">Входящий</div><div class="v3-tile-v">'+V3.gb(sumIn)+'</div></div>'+
      '<div class="v3-tile"><div class="v3-tile-l">В среднем в день</div><div class="v3-tile-v">'+V3.gb((sumIn+sumOut)/cdState.range)+'</div></div>'+
      '<div class="v3-tile"><div class="v3-tile-l">Пик</div><div class="v3-tile-v">'+V3.gb(peak)+'</div></div></div>';
    h+='<div style="display:flex;justify-content:flex-end"><button type="button" class="v3-btn" data-on-click="cdCsv()">Скачать CSV за период</button></div>';
  }
  return h+'</div>';
}
function _cdBars(){
  var t=cdState.traffic,box=document.getElementById('cdBars');if(!t||!box)return;
  if(t.failed){box.innerHTML='<div class="v3-bars-empty" style="height:190px">Не удалось загрузить трафик</div>';return}
  var per=(cdState.rot&&cdState.rot.perDay)||{},n=t.days.length;
  V3.bars(box,{cls:'h190 r4 small-lbl',gap:n<=7?14:n<=14?8:4,empty:'Трафика за период не было',
    bars:t.days.map(function(d,i){
      var dd=V3.parse(d.ymd);
      return {parts:[{v:d.inB,color:'#2f6fe0'},{v:d.outB,color:'#10b981'}],
        label:n<=7?V3.dm(d.ymd):(i%5===0?String(dd.getDate()):''),
        tip:{title:V3.dayTitle(d.ymd),rows:[{color:'#2f6fe0',name:'Входящий',val:V3.gb(d.inB)},{color:'#10b981',name:'Исходящий',val:V3.gb(d.outB)}],total:{name:'Ротаций IP',val:String(per[d.ymd]||0)}}};
    })});
}
function cdCsv(){
  var r=_pxRow(cdState.pid),t=cdState.traffic;if(!r||!t)return;
  var per=(cdState.rot&&cdState.rot.perDay)||{};
  var lines=['date,in_gb,out_gb,total_gb,ip_rotations'].concat(t.days.map(function(d){return [d.ymd,(d.inB/1e9).toFixed(3),(d.outB/1e9).toFixed(3),((d.inB+d.outB)/1e9).toFixed(3),per[d.ymd]||0].join(',')}));
  V3.download(lines.join('\n'),r.modemNick+'_traffic_'+t.from+'_'+t.to+'.csv','text/csv');
}
var CD_REASON={timer:['по таймеру',''],manual:['вручную','acc'],link:['по ссылке','green'],api:['через API','violet']};
function _cdRot(){
  var rot=cdState.rot,list=cdState.rotList;
  if(!rot)return '<div class="v3-mb"><div class="v3-skel" style="height:220px"></div></div>';
  var c=rot.counts||{all:0,timer:0,manual:0,ext:0};
  var h='<div class="v3-mb"><div class="v3-tiles">'+
    '<div class="v3-tile"><div class="v3-tile-l">Сегодня</div><div class="v3-tile-v">'+V3.group(rot.today||0)+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">За месяц</div><div class="v3-tile-v">'+V3.group(c.all)+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">Средняя смена</div><div class="v3-tile-v">'+(rot.avgTook!=null?V3.num(rot.avgTook)+' с':'—')+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">Уникальных IP</div><div class="v3-tile-v">'+V3.group(rot.uniqueIps||0)+'</div></div></div>';
  h+='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'+[['all','Все '+c.all],['timer','По таймеру '+c.timer],['manual','Вручную '+c.manual],['ext','Ссылка и API '+c.ext]].map(function(x){
    return '<button type="button" class="v3-chip'+(cdState.rotFilter===x[0]?' on':'')+'" data-on-click="cdRotFilter(\''+x[0]+'\')">'+x[1]+'</button>';
  }).join('')+'</div>';
  if(!list){h+='<div class="v3-skel" style="height:180px"></div></div>';return h}
  var e=list.entries||[];
  if(!e.length){h+='<div class="v3-emptybox bare"><span class="ic acc">↻</span><div class="t">Ротаций за 30 дней нет</div><div class="d">'+(rot.error?'Журнал временно недоступен.':'Смены IP появятся здесь после первой автосмены или ручной смены.')+'</div></div></div>';return h}
  h+='<div class="v3-table-wrap"><table class="v3-table tight"><thead><tr><th>Время</th><th>Был IP</th><th>Стал IP</th><th>Причина</th><th class="r">Заняло</th></tr></thead><tbody>'+
    e.map(function(x,i){
      var rs=CD_REASON[x.reason]||CD_REASON.timer,t=String(x.time||'');
      var tm=t.length>=16?t.slice(8,10)+'.'+t.slice(5,7)+' '+t.slice(11,16):t;
      return '<tr'+(i%2?' class="z"':'')+'><td class="mono mut">'+V3.esc(tm)+'</td><td class="mono fnt">'+V3.esc(x.from||'—')+'</td><td class="mono ink b">'+V3.esc(x.to||'—')+'</td><td><span class="v3-pill '+rs[1]+'">'+rs[0]+'</span></td><td class="r mono '+(x.took>30?'v3-up-warn':'mut')+'">'+(x.took!=null?V3.num(x.took,x.took%1?1:0)+' с':'—')+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  h+='<div style="display:flex;align-items:center"><span class="v3-note">Показано '+e.length+' из '+V3.group(list.total||e.length)+' за 30 дней</span>'+
    (e.length<(list.total||0)?'<button type="button" class="v3-more" style="margin-left:auto;padding:0" data-on-click="cdRotMore()">Показать ещё</button>':'')+'</div>';
  return h+'</div>';
}
function _cdSettings(r){
  var h='<div class="v3-mb" style="gap:14px">';
  h+='<div class="v3-field"><span class="v3-label">Своё название</span><input class="v3-input" id="cdName" maxlength="60" placeholder="Например: Парсер WB — поток 2" value="'+V3.esc(cdState.name)+'" data-on-input="cdNameInput(this.value)"><span class="v3-note">Видно только вам. Попадает в экспорт как комментарий к строке.</span></div>';
  h+='<div class="v3-box" style="display:flex;flex-direction:column;gap:10px;border-radius:10px"><div style="display:flex;align-items:center;gap:12px"><div style="flex:1"><div style="font-size:12.5px;font-weight:600;color:var(--v3-ink)">Автосмена IP</div><div style="font-size:11px;color:var(--v3-muted)">'+
    (cdState.auto?'каждые '+cdState.interval+' мин'+(V3.rotMin(r)===cdState.interval&&V3.rotLeft(r)!=null?' · следующая смена через '+V3.pad(Math.floor(V3.rotLeft(r)/60))+':'+V3.pad(V3.rotLeft(r)%60):''):'выключена — IP меняется только вручную или по ссылке')+'</div></div>'+
    '<button type="button" class="v3-toggle'+(cdState.auto?' on':'')+'" data-on-click="cdAutoToggle()" aria-label="Автосмена IP"></button></div>'+
    (cdState.auto?'<div style="display:flex;flex-wrap:wrap;gap:6px">'+[2,5,10,15,30,60].map(function(m){return '<button type="button" class="v3-chip solid white'+(cdState.interval===m?' on':'')+'" data-on-click="cdInterval('+m+')">'+m+' мин</button>'}).join('')+'</div>':'')+
  '</div>';
  var proto=(typeof exState!=='undefined'?exState.proto:'http')==='socks5'?'SOCKS5':'HTTP';
  var rows=[
    {t:'Пароль прокси',s:'Новый пароль сразу применится к HTTP и SOCKS5',a:'Сгенерировать',fn:'cdNewPassword()',c:'link'},
    {t:'Протокол в экспорте',s:'Какой адрес подставлять по умолчанию',a:proto+' ▾',fn:'cdProto()',c:''},
    {t:'Уведомлять, если офлайн',s:V3.tgLinked?'В Telegram, если прокси недоступен больше 5 минут':'Нужен привязанный Telegram — включите в профиле',a:cdState.notify?'Включено':'Выключено',fn:'cdNotify()',c:cdState.notify?'green':''}
  ];
  h+='<div style="display:flex;flex-direction:column">'+rows.map(function(x){
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--v3-line)"><div style="flex:1;min-width:0"><div style="font-size:12.5px;font-weight:600;color:var(--v3-ink)">'+x.t+'</div><div style="font-size:11px;color:var(--v3-muted)">'+x.s+'</div></div>'+
      '<button type="button" class="v3-btn xs '+x.c+'"'+(x.c==='green'?' style="color:var(--v3-green)"':'')+' data-on-click="'+x.fn+'">'+x.a+'</button></div>';
  }).join('')+'</div>';
  h+='<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="v3-btn" data-on-click="v3CloseModal()">Отмена</button><button type="button" class="v3-btn primary" id="cdSave" data-on-click="cdSave()">Сохранить</button></div>';
  return h+'</div>';
}
function cdNameInput(v){cdState.name=v}
function cdAutoToggle(){cdState.auto=!cdState.auto;_cdRender()}
function cdInterval(m){cdState.interval=m;_cdRender()}
function cdProto(){
  if(typeof exState==='undefined')return;
  exState.proto=exState.proto==='socks5'?'http':'socks5';_exSave();_cdRender();
  V3.toast({title:'Протокол в экспорте: '+(exState.proto==='socks5'?'SOCKS5':'HTTP')});
}
function cdNotify(){
  var r=_pxRow(cdState.pid);if(!r)return;
  if(!V3.tgLinked&&!cdState.notify){
    V3.toast({kind:'info',title:'Привяжите Telegram',text:'Уведомления приходят в Telegram — привязать можно в профиле.',action:'Открыть профиль',onAction:function(){V3.closeModal();v3Go('profile')}});
    return;
  }
  var want=!cdState.notify;
  api('/api/client/proxy_prefs',{method:'POST',json:{nick:r.modemNick,serverName:r.serverName,notifyOffline:want}}).then(function(d){
    if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось сохранить');
    V3.notify=d.notifyOffline||{};cdState.notify=want;_cdRender();
    V3.toast({title:want?'Уведомления включены':'Уведомления выключены',text:r.modemNick});
  }).catch(function(e){V3.toast({kind:'err',title:e.message})});
}
function cdSave(){
  var r=_pxRow(cdState.pid);if(!r)return;
  var btn=document.getElementById('cdSave');if(btn){btn.disabled=true;btn.textContent='Сохраняем…'}
  var jobs=[];
  var name=String(cdState.name||'').trim();
  if(name!==V3.label(r.modemNick)){
    jobs.push(api('/api/client/proxy_prefs',{method:'POST',json:{nick:r.modemNick,serverName:r.serverName,label:name}}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Название не сохранено');V3.labels=d.labels||{};
    }));
  }
  var want=cdState.auto?cdState.interval:0;
  if(want!==V3.rotMin(r)){
    jobs.push(v3SetRotation(r,want).then(function(){r.autoRotation=String(want)}));
  }
  Promise.all(jobs).then(function(){
    if(jobs.length)V3.toast({title:'Настройки сохранены',text:r.modemNick});
    V3.closeModal();renderProxies();_ovTable();
  }).catch(function(e){
    V3.toast({kind:'err',title:'Не удалось сохранить',text:e.message});
    if(btn){btn.disabled=false;btn.textContent='Сохранить'}
  });
}
function cdNewPassword(){
  var r=_pxRow(cdState.pid);if(!r)return;
  V3.confirm({title:'Сгенерировать новый пароль?',text:'Старый пароль перестанет работать сразу — обновите его во всех программах, где используется этот прокси.',detail:r.modemNick+' · '+r.proxyLogin,cta:'Сгенерировать'}).then(function(ok){
    if(!ok)return;
    api('/api/client/proxy_password',{method:'POST',json:{portId:r.portId,serverName:r.serverName}}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&(d.error||d.details))||'Не удалось сменить пароль');
      r.proxyPassword=d.password;
      var m=V3.modal('<div class="v3-dlg"><span class="ic ok">✓</span><h3>Новый пароль для '+V3.esc(r.modemNick)+'</h3><p>Пароль уже действует для HTTP и SOCKS5. Скопируйте его — в кабинете он тоже будет виден.</p><div class="v3-detail">'+V3.esc(r.proxyLogin+':'+d.password)+'</div></div><div class="v3-mf"><button type="button" class="v3-btn" data-a="c">Скопировать</button><button type="button" class="v3-btn primary" data-a="x">Готово</button></div>',{width:'w400'});
      m.querySelector('[data-a="c"]').addEventListener('click',function(){V3.copy(r.proxyLogin+':'+d.password,'Логин и пароль скопированы')});
      m.querySelector('[data-a="x"]').addEventListener('click',function(){V3.closeModal(m)});
      setTimeout(function(){loadData()},4000);
    }).catch(function(e){V3.toast({kind:'err',title:'Пароль не изменён',text:e.message})});
  });
}
