// public/js/portal/core.js — общие примитивы ЛК v3 (макет «Клиентский
// кабинет v3» + «попапы»): форматирование, модальные окна, тосты, выпадающие
// меню, столбчатый график с тултипом, состояние «чекбокс/тумблер».
// Грузится ПОСЛЕ client.js, ДО страниц portal/*.js.
//
// CSP: инлайн-обработчиков нет — разметка шлёт события через data-on-*
// (delegation.js), а всё, что не выражается этой грамматикой (mouseover по
// столбцам, Esc, клик мимо меню), вешается здесь addEventListener'ами.

var V3={};

// ---------- форматирование (как в макете: «1 453 ГБ», «54,0 ГБ», «23 ₽») ----------
V3.nbsp='\u00a0';
V3.group=function(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,'\u00a0')};
V3.num=function(v,d){v=Number(v);if(!isFinite(v))v=0;return v.toFixed(d==null?1:d).replace('.',',')};
V3.int=function(v){v=Number(v)||0;return (v<0?'−':'')+V3.group(Math.round(Math.abs(v)))};
V3.money=function(v,unit){return V3.int(v)+(unit==null?' ₽':unit)};
V3.moneySigned=function(v){return (v<0?'−':'+')+V3.group(Math.round(Math.abs(v)))+' ₽'};
V3.money2=function(v){v=Number(v)||0;var s=Math.abs(v).toFixed(2).replace('.',',').replace(/,00$/,'');var p=s.split(',');p[0]=V3.group(p[0]);return (v<0?'−':'')+p.join(',')+' ₽'};
// байты → «241,6 ГБ» / «1 453 ГБ» / «740 МБ»
V3.gb=function(bytes){
  var gb=(Number(bytes)||0)/1e9;
  if(gb>=100)return V3.group(Math.round(gb))+' ГБ';
  if(gb>=0.1||gb===0)return V3.num(gb)+' ГБ';
  return Math.round(gb*1000)+' МБ';
};
V3.gbv=function(gb){return V3.gb((Number(gb)||0)*1e9)};
V3.pct=function(v,d){return v==null||!isFinite(v)?'—':V3.num(v,d==null?1:d)+'%'};
V3.plural=function(n,a,b,c){var m=Math.abs(n)%100,k=m%10;if(m>10&&m<20)return c;if(k>1&&k<5)return b;if(k===1)return a;return c};
V3.MONTHS=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
V3.MONTHS_T=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
V3.MONTHS_GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
V3.MONTHS_S=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
V3.WD=['вс','пн','вт','ср','чт','пт','сб'];
V3.pad=function(n){return (n<10?'0':'')+n};
V3.ymd=function(d){return d.getFullYear()+'-'+V3.pad(d.getMonth()+1)+'-'+V3.pad(d.getDate())};
V3.parse=function(ymd){var p=String(ymd).split('-');return new Date(+p[0],(+p[1]||1)-1,+p[2]||1)};
V3.dm=function(ymd){var p=String(ymd).split('-');return p[2]+'.'+p[1]};
V3.dmy=function(ymd){var p=String(ymd).split('-');return p[2]+'.'+p[1]+'.'+p[0]};
V3.addDays=function(d,n){var x=new Date(d);x.setDate(x.getDate()+n);return x};
V3.daysBetween=function(a,b){return Math.round((V3.parse(b)-V3.parse(a))/864e5)+1};
// «сегодня» по Москве — как биллинг и daily_traffic на сервере
V3.today=function(){return new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'})};
V3.mskHour=function(){return parseInt(new Date().toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hour12:false}),10)%24};
// ISO/SQL-время → «30.03 14:21» по МСК
V3.dt=function(s,withYear){
  if(!s)return '—';
  var t=Date.parse(String(s).indexOf('T')<0&&String(s).indexOf(' ')>0?String(s).replace(' ','T')+'Z':s);
  if(isNaN(t))return String(s);
  var o={timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false};
  if(withYear)o.year='numeric';
  return new Date(t).toLocaleString('ru-RU',o).replace(',','');
};
V3.date=function(s){
  if(!s)return '—';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return V3.dmy(s);
  var t=Date.parse(s);if(isNaN(t))return String(s);
  return new Date(t).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'});
};
V3.esc=function(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')};
// безопасный литерал для data-on-click="fn('…')"
V3.q=function(s){return "'"+String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/</g,'&lt;')+"'"};
V3.cur=function(){var c=(typeof billingData!=='undefined'&&billingData&&billingData.currency)||'RUB';return c==='RUB'?'₽':c==='USD'?'$':c==='EUR'?'€':c};
V3.store={
  get:function(k,def){try{var v=localStorage.getItem('v3_'+k);return v==null?def:JSON.parse(v)}catch(e){return def}},
  set:function(k,v){try{localStorage.setItem('v3_'+k,JSON.stringify(v))}catch(e){}}
};

// ---------- иконки (из макета) ----------
V3.ic={
  search:'<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  upload:'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M6.5 8.5 12 3l5.5 5.5"/><path d="M4 20h16"/></svg>',
  empty:'<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
};

// ---------- тосты (5f) ----------
// V3.toast({kind:'ok'|'err'|'info'|'warn', title, text, action:'Копировать', onAction:fn, ms})
V3.toast=function(o){
  if(typeof o==='string')o={title:o};
  var box=document.getElementById('v3Toasts');
  if(!box){box=document.createElement('div');box.id='v3Toasts';box.className='v3-toasts';document.body.appendChild(box)}
  var kind=o.kind||'ok';
  var sym={ok:'✓',err:'!',info:'i',warn:'!'}[kind]||'✓';
  var el=document.createElement('div');
  el.className='v3-toast';
  el.innerHTML='<span class="ic '+(kind==='ok'?'':kind)+'">'+sym+'</span><div class="bd"><div class="t">'+V3.esc(o.title||'')+'</div>'+(o.text?'<div class="d">'+V3.esc(o.text)+'</div>':'')+'</div>'+(o.action?'<button class="a" type="button">'+V3.esc(o.action)+'</button>':'');
  if(o.action&&o.onAction){el.querySelector('.a').addEventListener('click',function(){try{o.onAction()}finally{el.remove()}})}
  box.appendChild(el);
  while(box.children.length>4)box.removeChild(box.firstChild);
  setTimeout(function(){if(el.parentNode)el.remove()},o.ms||(o.action?7000:4000));
  return el;
};
// старый showToast(msg,type) из utils.js → в стиле v3
if(typeof window!=='undefined'){
  window.showToast=function(m,t){V3.toast({kind:t==='error'?'err':t==='warning'?'warn':t==='info'?'info':'ok',title:String(m||'')})};
}

// ---------- копирование ----------
V3.copy=function(text,title,sub){
  function ok(){V3.toast({title:title||'Скопировано',text:sub||''})}
  function fallback(){var a=document.createElement('textarea');a.value=text;a.style.cssText='position:fixed;left:-9999px;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');ok()}catch(e){V3.toast({kind:'err',title:'Не удалось скопировать'})}document.body.removeChild(a)}
  if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(String(text)).then(ok,fallback);else fallback();
};
function v3Copy(text,title){V3.copy(text,title)}
V3.download=function(content,filename,type){
  var blob=new Blob([content],{type:(type||'text/plain')+';charset=utf-8'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);
};

// ---------- модальные окна ----------
// V3.modal(html,{width:'w400',onClose}) → корневой .v3-modal. Закрытие: ×, Esc, клик по фону.
V3._modals=[];
V3.modal=function(html,opts){
  opts=opts||{};
  var ov=document.createElement('div');
  ov.className='v3-overlay';
  ov.innerHTML='<div class="v3-modal '+(opts.width||'')+'" role="dialog" aria-modal="true">'+html+'</div>';
  ov.addEventListener('mousedown',function(e){if(e.target===ov)ov._downOnScrim=true});
  ov.addEventListener('click',function(e){if(e.target===ov&&ov._downOnScrim&&!opts.sticky)V3.closeModal(ov);ov._downOnScrim=false});
  document.body.appendChild(ov);
  document.body.style.overflow='hidden';
  ov._opts=opts;
  V3._modals.push(ov);
  return ov.firstChild;
};
V3.closeModal=function(ov){
  if(!ov)ov=V3._modals[V3._modals.length-1];
  else if(ov.classList&&ov.classList.contains('v3-modal'))ov=ov.parentNode;
  if(!ov)return;
  var i=V3._modals.indexOf(ov);if(i>=0)V3._modals.splice(i,1);
  if(ov.parentNode)ov.parentNode.removeChild(ov);
  if(!V3._modals.length)document.body.style.overflow='';
  if(ov._opts&&ov._opts.onClose)try{ov._opts.onClose()}catch(e){}
};
function v3CloseModal(){V3.closeModal()}
V3.mh=function(title,extra,cls){return '<div class="v3-mh"><h3'+(cls?' class="'+cls+'"':'')+'>'+title+'</h3>'+(extra||'')+'<button class="v3-x" type="button" data-on-click="v3CloseModal()" aria-label="Закрыть">×</button></div>'};

// подтверждение опасного действия (5e) — Promise<boolean>
V3.confirm=function(o){
  return new Promise(function(resolve){
    var done=false;
    var m=V3.modal(
      '<div class="v3-dlg"><span class="ic '+(o.danger===false?'':'bad')+'">'+(o.icon||'!')+'</span><h3>'+V3.esc(o.title)+'</h3>'+(o.text?'<p>'+V3.esc(o.text)+'</p>':'')+(o.detail?'<div class="v3-detail">'+V3.esc(o.detail)+'</div>':'')+'</div>'+
      '<div class="v3-mf"><button class="v3-btn" type="button" data-act="no">Отмена</button><button class="v3-btn '+(o.danger===false?'primary':'danger')+'" type="button" data-act="yes">'+V3.esc(o.cta||'Подтвердить')+'</button></div>',
      {width:'w400',onClose:function(){if(!done){done=true;resolve(false)}}});
    m.querySelector('[data-act="no"]').addEventListener('click',function(){V3.closeModal(m)});
    m.querySelector('[data-act="yes"]').addEventListener('click',function(){done=true;V3.closeModal(m);resolve(true)});
  });
};

// ---------- выпадающие меню: одно открытое, клик мимо — закрыть ----------
V3.toggleMenu=function(id,btn){
  var m=document.getElementById(id);if(!m)return;
  var willOpen=!m.classList.contains('open');
  V3.closeMenus();
  if(willOpen){m.classList.add('open');if(btn)btn.classList.add('open');m._btn=btn}
};
V3.closeMenus=function(except){
  document.querySelectorAll('.v3-menu.open,.v3-pop.open').forEach(function(m){
    if(m===except)return;
    m.classList.remove('open');if(m._btn)m._btn.classList.remove('open');
  });
};
function v3ToggleMenu(id,btn){V3.toggleMenu(id,btn)}
document.addEventListener('click',function(e){
  var t=e.target;
  if(t.closest&&(t.closest('.v3-menu')||t.closest('.v3-pop')||t.closest('[data-menu-btn]')))return;
  V3.closeMenus();
});
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  if(document.querySelector('.v3-menu.open,.v3-pop.open')){V3.closeMenus();return}
  if(V3._modals.length){var ov=V3._modals[V3._modals.length-1];if(!(ov._opts&&ov._opts.sticky))V3.closeModal(ov)}
});

// ---------- переключение страниц ----------
V3.go=function(tab){
  var el=document.querySelector('.nav-tab[data-on-click*="\''+tab+'\'"]');
  switchTab(tab,el);
  window.scrollTo(0,0);
};
function v3Go(tab){V3.go(tab)}

// ---------- столбчатый график с тултипом ----------
// V3.bars(container,{bars:[{parts:[{v,color}],label,tip:{title,rows:[{color,name,val,cls}],total}}],
//                    cls:'r4 small-lbl', gap:6, empty:'Нет данных', hover:idx})
// Высота столбца — доля от максимума суммы parts; parts рисуются снизу вверх.
V3.bars=function(box,o){
  if(!box)return;
  var bars=o.bars||[],max=0;
  bars.forEach(function(b){var t=0;(b.parts||[]).forEach(function(p){t+=p.v>0?p.v:0});b._t=t;if(t>max)max=t;if(b.ghost>max)max=b.ghost});
  if(!bars.length||max<=0){box.innerHTML='<div class="v3-bars-empty" style="height:'+(o.height||230)+'px">'+V3.esc(o.empty||'Нет данных за выбранный период')+'</div>';return}
  var n=bars.length,gap=o.gap!=null?o.gap:(n>60?2:n>40?3:n>31?4:6);
  var h='<div class="v3-bars '+(o.cls||'')+'" style="gap:'+gap+'px'+(o.height?';height:'+o.height+'px':'')+'">';
  bars.forEach(function(b,i){
    var segs='';
    for(var k=b.parts.length-1;k>=0;k--){var p=b.parts[k];if(!(p.v>0))continue;segs+='<i style="height:'+(p.v/max*100).toFixed(2)+'%;background:'+p.color+'"></i>'}
    if(b.ghost>0)segs='<s class="v3-ghost" style="height:'+(b.ghost/max*100).toFixed(2)+'%"></s>'+segs;
    h+='<div class="v3-bar'+(i===o.hover?' on':'')+'" data-i="'+i+'"'+(b.dim?' style="opacity:.35"':'')+'>'+segs+(b.label?'<span class="v3-bar-lbl">'+V3.esc(b.label)+'</span>':'')+'</div>';
  });
  h+='<div class="v3-tip"></div></div>';
  box.innerHTML=h;
  var wrap=box.firstChild,tip=wrap.querySelector('.v3-tip');
  function show(i){
    wrap.querySelectorAll('.v3-bar.on').forEach(function(x){x.classList.remove('on')});
    if(i<0||!bars[i]||!bars[i].tip){tip.style.display='none';return}
    var b=bars[i],bel=wrap.querySelector('.v3-bar[data-i="'+i+'"]');
    bel.classList.add('on');
    var t=b.tip,s='<div class="v3-tip-d">'+V3.esc(t.title||'')+'</div>';
    (t.rows||[]).forEach(function(r){s+='<div class="v3-tip-r">'+(r.color?'<i class="v3-dot" style="background:'+r.color+'"></i>':'')+V3.esc(r.name)+(r.tag?'<em>'+V3.esc(r.tag)+'</em>':'')+'<b class="'+(r.cls||'')+'">'+V3.esc(r.val)+'</b></div>'});
    if(t.total)s+='<div class="v3-tip-r tot">'+V3.esc(t.total.name||'Всего')+'<b>'+V3.esc(t.total.val)+'</b></div>';
    tip.innerHTML=s;tip.style.display='block';
    var W=wrap.clientWidth,H=wrap.clientHeight-16,cx=bel.offsetLeft+bel.offsetWidth/2,tw=tip.offsetWidth,th=tip.offsetHeight;
    var left=Math.max(0,Math.min(W-tw,cx-tw/2));
    var top=Math.max(0,H-(b._t/max*H)-th-10);
    tip.style.left=left+'px';tip.style.top=top+'px';
    if(o.onHover)o.onHover(i);
  }
  wrap.addEventListener('mouseover',function(e){var el=e.target.closest&&e.target.closest('.v3-bar');if(el)show(parseInt(el.getAttribute('data-i'),10))});
  wrap.addEventListener('mouseleave',function(){show(-1)});
  if(o.hover!=null&&o.hover>=0)show(o.hover);
};
// подпись оси: каждые step дней (1, 5, 10, …) или dd.mm при разных месяцах
V3.dayLabel=function(i,n,ymd,multiMonth){
  var d=V3.parse(ymd);
  if(n<=10)return multiMonth?V3.dm(ymd):(d.getDate()+' '+V3.WD[d.getDay()]);
  var step=n<=31?5:n<=62?7:15;
  if(multiMonth)return i%step===0?V3.dm(ymd):'';
  return (i===0||d.getDate()%step===0)?String(d.getDate()):'';
};
V3.dayTitle=function(ymd,withYear){var d=V3.parse(ymd);return d.getDate()+' '+V3.MONTHS_GEN[d.getMonth()]+(withYear?' '+d.getFullYear():'')+', '+V3.WD[d.getDay()]};

// ---------- общие данные по прокси ----------
V3.CC_NAMES={MD:'Молдова',RO:'Румыния'};
V3.CC_COLORS=['#2f6fe0','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6'];
V3.cc=function(r){var c=COUNTRIES[r.serverName];return (c&&c.country)||r.country||'??'};
V3.ccName=function(cc){
  for(var sn in COUNTRIES){var c=COUNTRIES[sn];if(c.country===cc&&c.name&&c.name!==sn)return c.name}
  return V3.CC_NAMES[cc]||(cc==='??'?'Другое':cc);
};
V3.countries=function(){
  var seen={},list=[];
  tableData.forEach(function(r){var cc=V3.cc(r);if(!seen[cc]){seen[cc]=1;list.push(cc)}});
  list.sort(function(a,b){var ia=countryOrder.indexOf(a),ib=countryOrder.indexOf(b);if(ia<0)ia=99;if(ib<0)ib=99;return ia-ib||(a<b?-1:1)});
  return list;
};
V3.ccColor=function(cc){var i=V3.countries().indexOf(cc);return V3.CC_COLORS[(i<0?0:i)%V3.CC_COLORS.length]};
V3.serverIp=function(r){var c=COUNTRIES[r.serverName]||{};return c.serverIp||''};
V3.isRotating=function(r){return r.online==='rotating'||r.extIp==='IP_RESET'};
V3.isOnline=function(r){return !r._offline&&(r.online==='yes'||V3.isRotating(r))};
V3.netType=function(t){
  if(!t)return '';
  if(/5g|\bnr\b/i.test(t))return '5G';
  if(/lte|4g/i.test(t))return 'LTE';
  if(/3g|hspa|umts|wcdma/i.test(t))return '3G';
  if(/2g|edge|gprs|gsm/i.test(t))return '2G';
  return String(t).slice(0,6);
};
V3.month=function(r){return (r.monthIn||0)+(r.monthOut||0)};
V3.today_=function(r){return (r.dayIn||0)+(r.dayOut||0)};
V3.yest=function(r){return (r.yesterdayIn||0)+(r.yesterdayOut||0)};
// секунды до следующей автосмены из TIME_TO_IP_ROTATION («1 h 4 min 12 sec»), null — нет таймера
V3.rotLeft=function(r){
  var s=r.timeToRotation;if(!s||s==='None'||s==='null')return null;
  var t=0,h=String(s).match(/(\d+)\s*h/),m=String(s).match(/(\d+)\s*min/),c=String(s).match(/(\d+)\s*sec/);
  if(h)t+=parseInt(h[1],10)*3600;if(m)t+=parseInt(m[1],10)*60;if(c)t+=parseInt(c[1],10);
  return h||m||c?t:null;
};
// интервал автосмены, мин (0 — выключена). Если бокс не отдал AUTO_IP_ROTATION,
// но таймер идёт — берём ближайший пресет ≥ остатка (как раньше в ЛК).
V3.rotMin=function(r){
  var n=parseInt(r.autoRotation,10);
  if(n>0)return n;
  var left=V3.rotLeft(r);
  if(left==null)return 0;
  var mins=Math.ceil(left/60),P=[2,5,10,15,30,60,120,180,360,720,1440];
  for(var i=0;i<P.length;i++)if(P[i]>=mins)return P[i];
  return 1440;
};
V3.byNick=function(nick){for(var i=0;i<tableData.length;i++)if(tableData[i].modemNick===nick)return tableData[i];return null};
// «с 09:12» / «нет связи»
V3.ipSince=function(r){
  if(!V3.isOnline(r))return 'нет связи';
  if(V3.isRotating(r))return 'смена IP…';
  if(!r.ipSince)return '';
  var t=Date.parse(r.ipSince);if(isNaN(t))return '';
  var d=new Date(t),today=V3.today();
  var dd=d.toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'});
  var hm=d.toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
  return dd===today?'с '+hm:'с '+V3.dm(dd)+' '+hm;
};
// свои названия прокси (3d «Настройки»): {nick: label}, грузит portal/card.js
V3.labels={};
V3.label=function(nick){return V3.labels[nick]||''};

// ---------- поповер «Произвольный период» (3e; тот же на «Обзоре») ----------
// V3.periodPop(pref,{from,to,compare}) — разметка; кнопки дергают
// <pref>ApplyCustom() / <pref>ResetCustom() / <pref>Preset('…') / <pref>ToggleCompare().
V3.periodPop=function(pref,o){
  var max=V3.today();
  return '<div class="v3-cap">Произвольный период</div>'+
    '<div style="display:flex;align-items:center;gap:8px">'+
      '<input type="date" class="v3-input mono sunken" id="'+pref+'From" value="'+V3.esc(o.from||'')+'" max="'+max+'" style="flex:1;padding:7px 8px">'+
      '<span style="color:var(--v3-faint)">—</span>'+
      '<input type="date" class="v3-input mono sunken" id="'+pref+'To" value="'+V3.esc(o.to||'')+'" max="'+max+'" style="flex:1;padding:7px 8px">'+
    '</div>'+
    '<div style="display:flex;flex-wrap:wrap;gap:6px">'+
      ['yesterday:Вчера','last30:Последние 30 дней','prevMonth:Прошлый месяц','ytd:С начала года'].map(function(x){
        var k=x.split(':');return '<button type="button" class="v3-chip" data-on-click="'+pref+'Preset(\''+k[0]+'\')">'+k[1]+'</button>';
      }).join('')+
    '</div>'+
    (o.compare!=null?'<span class="v3-check-row" style="font-size:11px;color:var(--v3-muted)" data-on-click="'+pref+'ToggleCompare()"><span class="v3-check'+(o.compare?' on':'')+'" id="'+pref+'Cmp"></span>сравнить с предыдущим периодом</span>':'')+
    '<div style="display:flex;justify-content:flex-end;gap:8px">'+
      '<button type="button" class="v3-btn" style="padding:6px 12px" data-on-click="'+pref+'ResetCustom()">Сбросить</button>'+
      '<button type="button" class="v3-btn primary" style="padding:6px 12px" data-on-click="'+pref+'ApplyCustom()">Применить</button>'+
    '</div>';
};
V3.presetRange=function(k){
  var t=V3.parse(V3.today());
  if(k==='yesterday'){var y=V3.ymd(V3.addDays(t,-1));return {from:y,to:y}}
  if(k==='last30')return {from:V3.ymd(V3.addDays(t,-29)),to:V3.ymd(t)};
  if(k==='prevMonth')return {from:V3.ymd(new Date(t.getFullYear(),t.getMonth()-1,1)),to:V3.ymd(new Date(t.getFullYear(),t.getMonth(),0))};
  if(k==='ytd')return {from:V3.ymd(new Date(t.getFullYear(),0,1)),to:V3.ymd(t)};
  return null;
};
V3.rangeLabel=function(from,to){
  if(!from)return '—';
  if(from===to)return V3.dmy(from);
  return (from.slice(0,4)===to.slice(0,4)?V3.dm(from):V3.dmy(from))+' — '+V3.dmy(to);
};

// ---------- daily_traffic: кэш по диапазону ----------
// Ответ → {byDate:{ymd:{portId:{in,out,nick}}}, todayDate}. Сегодня — живой счётчик.
V3._dailyCache={};
V3.daily=function(from,to,force){
  var key=from+'|'+to;
  var c=V3._dailyCache[key];
  if(c&&!force&&Date.now()-c.ts<5*60e3)return c.p;
  var p=api('/api/client/daily_traffic?from='+from+'&to='+to+'&include_today=1').then(function(data){
    var byDate={},daily=(data&&data.daily)||{},today=(data&&data.today)||{};
    var td=(data&&data.todayDate)||V3.today();
    for(var pid in daily){for(var d in daily[pid]){if(d===td)continue;var e=daily[pid][d];(byDate[d]=byDate[d]||{})[pid]={in:e.in||0,out:e.out||0,nick:e.nick||''}}}
    for(var tp in today){var te=today[tp];(byDate[td]=byDate[td]||{})[tp]={in:te.in||0,out:te.out||0,nick:te.nick||''}}
    return {byDate:byDate,todayDate:td};
  });
  p.catch(function(){delete V3._dailyCache[key]});
  V3._dailyCache[key]={ts:Date.now(),p:p};
  return p;
};
// порт истории → ник / страна (по текущему составу, иначе по префиксу ника)
V3.portInfo=function(pid,nick){
  for(var i=0;i<tableData.length;i++){var r=tableData[i];if(r.portId===pid)return {nick:r.modemNick,cc:V3.cc(r),row:r}}
  var n=String(nick||pid||'');
  return {nick:nick||pid,cc:/^MD/i.test(n)?'MD':/^RO/i.test(n)?'RO':'??',row:null};
};
