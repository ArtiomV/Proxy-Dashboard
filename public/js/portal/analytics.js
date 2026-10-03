// public/js/portal/analytics.js — 3e «Аналитика» с произвольным периодом.
// /api/client/daily_traffic — потребление за период (+ прошлый период для
// сравнения), /api/client/hourly_traffic?days=7 — теплокарта,
// /api/client/speed_monitor?hours=48 — скорость модемов клиента по операторам.

var anState={period:V3.store.get('an_period','month'),from:'',to:'',compare:false,view:'loc'};
if(!/^(week|month|quarter)$/.test(anState.period))anState.period='month';
var _anData=null,_anPrev=null,_anHeat=null,_anSpeed=null;
var spState={mode:'dl',country:'all',hover:47};
var SP_COLORS=['#2f6fe0','#8b5cf6','#10b981','#f59e0b','#ec4899','#14b8a6','#f97316','#6366f1'];
var AN_MODEM_COLORS=['#2f6fe0','#10b981','#f59e0b','#8b5cf6','#ec4899','#9aa4b3'];

function _anRange(){
  var t=V3.parse(V3.today()),p=anState.period;
  if(p==='week')return {from:V3.ymd(V3.addDays(t,-6)),to:V3.ymd(t)};
  if(p==='quarter'){var q=Math.floor(t.getMonth()/3);return {from:V3.ymd(new Date(t.getFullYear(),q*3,1)),to:V3.ymd(t)}}
  if(p==='custom'&&anState.from)return {from:anState.from,to:anState.to};
  // 'month' = последние 30 дней (не календарный месяц), как на «Обзоре» — 03.10
  return {from:V3.ymd(V3.addDays(t,-29)),to:V3.ymd(t)};
}
function _anPrevRange(r){
  var n=V3.daysBetween(r.from,r.to),end=V3.addDays(V3.parse(r.from),-1);
  return {from:V3.ymd(V3.addDays(end,-(n-1))),to:V3.ymd(end)};
}

// ---------- действия ----------
function anSetPeriod(p){anState.period=p;V3.store.set('an_period',p);V3.closeMenus();_anData=null;renderAnalytics()}
function anSetView(v){anState.view=v;_anChart()}
function anOpenCustom(){
  var r=_anRange();
  document.getElementById('anPop').innerHTML=V3.periodPop('an',{from:r.from,to:r.to,compare:anState.compare});
  V3.toggleMenu('anPop',document.getElementById('anRange'));
}
function anPreset(k){var r=V3.presetRange(k);document.getElementById('anFrom').value=r.from;document.getElementById('anTo').value=r.to}
function anToggleCompare(){anState.compare=!anState.compare;var c=document.getElementById('anCmp');if(c)c.classList.toggle('on',anState.compare)}
function anApplyCustom(){
  var f=document.getElementById('anFrom').value,t=document.getElementById('anTo').value;
  if(!f||!t){V3.toast({kind:'err',title:'Укажите обе даты'});return}
  if(f>t){var x=f;f=t;t=x}
  if(t>V3.today())t=V3.today();
  if(V3.daysBetween(f,t)>366){V3.toast({kind:'err',title:'Период — не больше года'});return}
  anState.from=f;anState.to=t;anState.period='custom';_anData=null;V3.closeMenus();renderAnalytics();
}
function anResetCustom(){anState.from=anState.to='';anState.compare=false;anSetPeriod('month')}

// ---------- загрузка ----------
function renderAnalytics(){
  if(!rawData)return;
  var r=_anRange(),pr=_anPrevRange(r);
  document.querySelectorAll('#anSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-p')===anState.period)});
  document.getElementById('anRange').textContent=V3.rangeLabel(r.from,r.to)+' ▾';
  document.querySelectorAll('#anViewSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-v')===anState.view)});
  if(!_anData||_anData.from!==r.from||_anData.to!==r.to){
    _anData={from:r.from,to:r.to,loading:true};
    Promise.all([V3.daily(r.from,r.to),V3.daily(pr.from,pr.to).catch(function(){return {byDate:{}}})]).then(function(res){
      if(_anData.from!==r.from||_anData.to!==r.to)return;
      _anData={from:r.from,to:r.to,byDate:res[0].byDate};_anPrev={from:pr.from,to:pr.to,byDate:res[1].byDate};
      _anAll();
    }).catch(function(){_anData={from:r.from,to:r.to,byDate:{},failed:true};_anAll()});
  }
  _anAll();
  if(!_anHeat){_anHeat={loading:true};api('/api/client/hourly_traffic?days=7').then(function(d){_anHeat=d&&d.matrix?d:{failed:true,error:d&&d.error};_anHeatmap()}).catch(function(){_anHeat={failed:true};_anHeatmap()})}
  _anHeatmap();
  // 2026-10-03: список операторов — из operator_speed?mine=1 (ВСЕ операторы,
  // которые есть у клиента, а не только замеренные ники); почасовая серия —
  // из speed_monitor (замеры самих ников клиента, если есть).
  if(!_anSpeed||Date.now()-_anSpeed.ts>10*60e3){
    _anSpeed={loading:true,ts:Date.now()};
    Promise.all([
      api('/api/client/speed_monitor?hours=48'),
      api('/api/client/operator_speed?mine=1&hours=48'),
    ]).then(function(res){
      _anSpeed=_spPrepare(res[0],res[1]);_spRender();
    }).catch(function(){_anSpeed={failed:true,ts:Date.now()};_spRender()});
  }
  _spRender();
}
function _anAll(){_anPulse();_anChart();_anSides()}

// агрегаты периода
function _anAgg(byDate,from,to){
  var n=V3.daysBetween(from,to),days=[],tot=0,inB=0,outB=0,ports={},byCC={},byNick={};
  for(var i=0;i<n;i++){
    var ymd=V3.ymd(V3.addDays(V3.parse(from),i)),d=(byDate||{})[ymd]||{},dt=0,cc={},nk={};
    for(var pid in d){
      var e=d[pid],v=e.in+e.out,inf=V3.portInfo(pid,e.nick);
      dt+=v;inB+=e.in;outB+=e.out;if(v>0)ports[pid]=1;
      cc[inf.cc]=(cc[inf.cc]||0)+v;byCC[inf.cc]=(byCC[inf.cc]||0)+v;
      nk[inf.nick]=(nk[inf.nick]||0)+v;byNick[inf.nick]=(byNick[inf.nick]||0)+v;
    }
    tot+=dt;days.push({ymd:ymd,tot:dt,cc:cc,nick:nk});
  }
  return {n:n,days:days,tot:tot,inB:inB,outB:outB,ports:Object.keys(ports).length,byCC:byCC,byNick:byNick};
}

function _anPulse(){
  var box=document.getElementById('anPulse');
  if(!_anData||_anData.loading){return}
  var a=_anAgg(_anData.byDate,_anData.from,_anData.to),p=_anAgg(_anPrev&&_anPrev.byDate,_anPrev.from,_anPrev.to);
  var today=V3.today(),done=a.days.filter(function(d){return d.ymd!==today}),doneSum=done.reduce(function(s,d){return s+d.tot},0);
  var avg=done.length?doneSum/done.length:a.tot,pavg=p.n?p.tot/p.n:0;
  var delta=pavg>0?(avg/pavg-1)*100:null,peak=null;
  a.days.forEach(function(d){if(!peak||d.tot>peak.tot)peak=d});
  var pd=peak&&peak.tot>0?V3.parse(peak.ymd):null;
  var cards=[
    {l:'Трафик за период',v:V3.gb(a.tot),s:a.n+' '+V3.plural(a.n,'день','дня','дней')+' · '+V3.rangeLabel(_anData.from,_anData.to)},
    {l:'Среднесуточно',v:V3.gb(avg),s:delta==null?'нет данных за прошлый период':(delta>=0?'▲ +':'▼ −')+V3.num(Math.abs(delta))+'% к прошлому периоду',c:delta==null?'':delta>=0?'up':'down'},
    {l:'Пиковый день',v:pd?V3.gb(peak.tot):'—',s:pd?pd.getDate()+' '+V3.MONTHS_GEN[pd.getMonth()]:'—',g:1},
    {l:'Активных прокси',v:String(a.ports),s:'в выбранном периоде'}
  ];
  box.innerHTML=cards.map(function(c){return '<div class="v3-pulse'+(c.g?' green':'')+'"><div class="v3-pulse-l">'+c.l+'</div><div class="v3-pulse-v">'+c.v+'</div><div class="v3-pulse-s '+(c.c||'')+'">'+c.s+'</div></div>'}).join('');
}

function _anChart(){
  var box=document.getElementById('anChart');
  document.querySelectorAll('#anViewSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-v')===anState.view)});
  if(!_anData||_anData.loading){box.innerHTML='<div class="v3-skel" style="height:230px"></div>';return}
  var a=_anAgg(_anData.byDate,_anData.from,_anData.to),p=anState.compare?_anAgg(_anPrev.byDate,_anPrev.from,_anPrev.to):null;
  document.getElementById('anChartNote').textContent=V3.rangeLabel(_anData.from,_anData.to)+' · '+a.n+' '+V3.plural(a.n,'день','дня','дней')+(p?' · пунктир — прошлый период':'');
  var series;
  if(anState.view==='modem'){
    var top=Object.keys(a.byNick).sort(function(x,y){return a.byNick[y]-a.byNick[x]}).slice(0,5);
    series=top.map(function(n,i){return {key:n,name:n,color:AN_MODEM_COLORS[i],get:function(d){return d.nick[n]||0}}});
    if(Object.keys(a.byNick).length>5)series.push({key:'_rest',name:'Остальные',color:AN_MODEM_COLORS[5],get:function(d){var s=d.tot;top.forEach(function(n){s-=d.nick[n]||0});return Math.max(0,s)}});
  }else{
    series=V3.countries().map(function(cc){return {key:cc,name:V3.ccName(cc),color:V3.ccColor(cc),get:function(d){return d.cc[cc]||0}}});
    Object.keys(a.byCC).forEach(function(cc){if(!series.some(function(s){return s.key===cc}))series.push({key:cc,name:V3.ccName(cc),color:'#9aa4b3',get:function(d){return d.cc[cc]||0}})});
  }
  var multi=_anData.from.slice(0,7)!==_anData.to.slice(0,7),n=a.n;
  V3.bars(box,{cls:'r5 tiny-lbl',gap:n>60?2:4,empty:_anData.failed?'Не удалось загрузить историю трафика':'Нет трафика за выбранный период',
    bars:a.days.map(function(d,i){
      var rows=series.map(function(s){return {color:s.color,name:s.name,val:V3.gb(s.get(d))}}).filter(function(x,j){return anState.view==='loc'||series[j].get(d)>0});
      var ghost=p&&p.days[i]?p.days[i].tot:0;
      if(p)rows.push({name:'Прошлый период',val:V3.gb(ghost)});
      var dd=V3.parse(d.ymd);
      return {parts:series.map(function(s){return {v:s.get(d),color:s.color}}),ghost:ghost,
        label:n<=10?V3.dayLabel(i,n,d.ymd,multi):(i%7===0?V3.dm(d.ymd):''),
        tip:{title:V3.dm(d.ymd)+'.'+dd.getFullYear()+', '+V3.WD[dd.getDay()],rows:rows,total:{name:'Всего',val:V3.gb(d.tot)}}};
    })});
}

function _anSides(){
  if(!_anData||_anData.loading)return;
  var a=_anAgg(_anData.byDate,_anData.from,_anData.to),t=a.inB+a.outB;
  var m=function(label,sub,val,w,color){return '<div><div class="v3-meter-h"><span>'+label+(sub?' <i>'+sub+'</i>':'')+'</span><span>'+val+'</span></div><div class="v3-track"><span style="width:'+w+'%;background:'+color+'"></span></div></div>'};
  document.getElementById('anInOut').innerHTML=t>0
    ?m('Входящий','',V3.gb(a.inB),Math.round(a.inB/t*100),'#2f6fe0')+m('Исходящий','',V3.gb(a.outB),Math.round(a.outB/t*100),'#10b981')
    :'<div class="v3-empty">Нет трафика за период</div>';
  var ccs=V3.countries();Object.keys(a.byCC).forEach(function(cc){if(ccs.indexOf(cc)<0)ccs.push(cc)});
  document.getElementById('anLoc').innerHTML=ccs.map(function(cc){
    var n=tableData.filter(function(r){return V3.cc(r)===cc}).length,v=a.byCC[cc]||0;
    return m(V3.esc(V3.ccName(cc)),n+' прокси',V3.gb(v),a.tot?Math.round(v/a.tot*100):0,V3.ccColor(cc));
  }).join('')||'<div class="v3-empty">Нет данных</div>';
}

// ---------- теплокарта ----------
function _anHeatmap(){
  var box=document.getElementById('anHeat');if(!box||!_anHeat||_anHeat.loading)return;
  if(_anHeat.failed){box.innerHTML='<div class="v3-bars-empty" style="height:150px">'+V3.esc(_anHeat.error||'Почасовые данные недоступны')+'</div>';return}
  var mx=_anHeat.matrix||[],meta=(_anHeat.meta&&_anHeat.meta.day_meta)||[],corr=(_anHeat.meta&&_anHeat.meta.corrected)||[],max=0;
  mx.forEach(function(row){row.forEach(function(v){if(v>max)max=v})});
  var h='<div class="v3-heat">';
  mx.forEach(function(row,di){
    var dm=meta[di]||{},lbl=(dm.label||'').toLowerCase();
    h+='<div class="v3-heat-row"><span class="v3-heat-day" title="'+V3.esc(dm.date||'')+'">'+V3.esc(lbl)+'</span><div class="v3-heat-cells">';
    row.forEach(function(v,hr){
      var a=max>0?Math.min(0.92,Math.max(0.06,v/max)):0.06;
      h+='<span class="v3-heat-c'+(corr[di]&&corr[di][hr]?' corr':'')+'" data-d="'+di+'" data-h="'+hr+'" style="background:rgba(47,111,224,'+a.toFixed(2)+')"></span>';
    });
    h+='</div></div>';
  });
  h+='<div class="v3-heat-row" style="margin-top:2px"><span class="v3-heat-day"></span><div class="v3-heat-x"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div></div>';
  box.innerHTML=h+'<div class="v3-tip" id="anHeatTip"></div>';
  box.style.position='relative';
  var tip=box.querySelector('#anHeatTip');
  box.querySelector('.v3-heat').addEventListener('mouseover',function(e){
    var c=e.target.closest&&e.target.closest('.v3-heat-c');if(!c)return;
    box.querySelectorAll('.v3-heat-c.on').forEach(function(x){x.classList.remove('on')});c.classList.add('on');
    var di=+c.getAttribute('data-d'),hr=+c.getAttribute('data-h'),dm=meta[di]||{};
    tip.innerHTML='<div class="v3-tip-d">'+V3.esc((dm.label||'').toLowerCase()+(dm.date?' '+V3.dm(dm.date):'')+' · '+V3.pad(hr)+':00–'+V3.pad((hr+1)%24)+':00')+'</div><div style="font-family:var(--font-mono);font-weight:600;font-size:12px">'+V3.gbv(mx[di][hr])+'</div>'+(corr[di]&&corr[di][hr]?'<div class="v3-tip-d" style="margin:4px 0 0">часть трафика восстановлена по счётчикам</div>':'');
    tip.style.display='block';tip.style.minWidth='0';
    var br=box.getBoundingClientRect(),cr=c.getBoundingClientRect();
    tip.style.left=Math.max(0,Math.min(box.clientWidth-tip.offsetWidth,cr.left-br.left+cr.width/2-tip.offsetWidth/2))+'px';
    tip.style.top=(cr.top-br.top-tip.offsetHeight-8)+'px';
  });
  box.querySelector('.v3-heat').addEventListener('mouseleave',function(){tip.style.display='none';box.querySelectorAll('.v3-heat-c.on').forEach(function(x){x.classList.remove('on')})});
}

// ---------- скорость по операторам (медиана замеров за час) ----------
// 2026-10-03: список операторов полный (mine=1: все, что есть у клиента),
// почасовая серия — где speed_monitor реально мерил ники клиента.
function _median(a){if(!a.length)return null;var s=a.slice().sort(function(x,y){return x-y});return s[Math.floor(s.length/2)]}
function _spPrepare(d, opSpeed){
  if(!d||d.error||!Array.isArray(d.rows))d={rows:[],modems:[]};
  var meta={};(d.modems||[]).forEach(function(m){meta[m.nick]=m});
  // часы окна (МСК) — последние 48 часов
  var now=new Date(Date.now()+3*3600e3),hours=[];
  for(var i=47;i>=0;i--){var t=new Date(now.getTime()-i*3600e3);hours.push(t.toISOString().slice(0,13).replace('T',' ')+':00')}
  var ops={};
  // 1) полный список операторов клиента из operator_speed (медиана по флоту)
  ((opSpeed&&opSpeed.rows)||[]).forEach(function(r){
    var key=(r.operator||'Оператор не определён')+'|'+(r.location||'');
    if(!ops[key])ops[key]={name:r.operator||'Оператор не определён',loc:r.location||'',dl:{},ul:{},dlMed:r.median_dl!=null?r.median_dl:null,ulMed:r.median_ul!=null?r.median_ul:null,ping:r.median_ping};
  });
  // 2) почасовая серия: по флоту (оператор+страна), фолбэк — замеры ников клиента
  var fleetRows=Array.isArray(d.fleet)?d.fleet:null;
  if(fleetRows){
    fleetRows.forEach(function(r){
      var key=(r.operator||'Оператор не определён')+'|'+(r.location||'');
      if(!ops[key])ops[key]={name:r.operator||'Оператор не определён',loc:r.location||'',dl:{},ul:{},dlMed:null,ulMed:null};
      var hi=hours.indexOf(r.hour_msk);if(hi<0)return;
      if(r.avg_dl>0)(ops[key].dl[hi]=ops[key].dl[hi]||[]).push(r.avg_dl);
      if(r.avg_ul>0)(ops[key].ul[hi]=ops[key].ul[hi]||[]).push(r.avg_ul);
    });
  }else{
    d.rows.forEach(function(r){
      var m=meta[r.nick]||{},op=m.operator||(V3.byNick(r.nick)||{}).operator||'Оператор не определён';
      var loc=m.location||'';
      var key=op+'|'+loc;
      if(!ops[key])ops[key]={name:op,loc:loc,dl:{},ul:{},dlMed:null,ulMed:null};
      var hi=hours.indexOf(r.hour_msk);if(hi<0)return;
      if(r.avg_dl>0)(ops[key].dl[hi]=ops[key].dl[hi]||[]).push(r.avg_dl);
      if(r.avg_ul>0)(ops[key].ul[hi]=ops[key].ul[hi]||[]).push(r.avg_ul);
    });
  }
  var list=Object.keys(ops).sort().map(function(k,i){
    var o=ops[k];o.color=SP_COLORS[i%SP_COLORS.length];
    ['dl','ul'].forEach(function(mode){
      var arr=[],all=[];for(var h=0;h<48;h++){var v=o[mode][h]?_median(o[mode][h]):null;arr.push(v);if(v!=null)all.push(v)}
      o[mode+'S']=arr;
      var computed=_median(all);
      o[mode+'Med']=computed!=null?computed:o[mode+'Med'];   // нет серии клиента — медиана флота по оператору
    });
    return o;
  });
  // операторы совсем без данных (ни серии замеров, ни медианы флота) не
  // показываем — иначе в легенде висят «пустые» строки с прочерками
  list=list.filter(function(o){return o.dlMed!=null||o.ulMed!=null});
  var locs=[];list.forEach(function(o){if(o.loc&&locs.indexOf(o.loc)<0)locs.push(o.loc)});
  // порядок локаций — как у стран кабинета (Молдова, Румыния, …)
  var ord=V3.countries().map(V3.ccName),oi=function(l){var i=ord.indexOf(l);return i<0?99:i};
  locs.sort(function(a,b){return oi(a)-oi(b)||(a<b?-1:1)});
  list.sort(function(a,b){return oi(a.loc)-oi(b.loc)||(a.name<b.name?-1:1)});
  list.forEach(function(o,i){o.color=SP_COLORS[i%SP_COLORS.length]});
  return {ts:Date.now(),hours:hours,ops:list,locs:locs};
}
function spSetMode(m){spState.mode=m;_spRender()}
function spSetCountry(c){spState.country=c;_spRender()}
function _spRender(){
  var box=document.getElementById('spBox');if(!box||!_anSpeed||_anSpeed.loading)return;
  document.querySelectorAll('#spModes button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-m')===spState.mode)});
  if(_anSpeed.failed||!_anSpeed.ops.length){
    document.getElementById('spCountries').innerHTML='';
    box.innerHTML='<div class="v3-emptybox bare"><span class="ic acc">⌁</span><div class="t">Замеров пока нет</div><div class="d">Скорость меряется каждый час через ваши прокси. График появится после первых замеров.</div></div>';return;
  }
  var S=_anSpeed,mode=spState.mode;
  document.getElementById('spCountries').innerHTML=[['all','Все операторы']].concat(S.locs.map(function(l){return [l,l]})).map(function(x){
    return '<button type="button" class="v3-chip'+(spState.country===x[0]?' on':'')+'" data-on-click="spSetCountry('+V3.q(x[0])+')">'+V3.esc(x[1])+'</button>';
  }).join('');
  var vis=function(o){return spState.country==='all'||o.loc===spState.country};
  var mx=0;S.ops.forEach(function(o){if(!vis(o))return;o[mode+'S'].forEach(function(v){if(v>mx)mx=v})});
  var step=mode==='dl'?20:6,yMax=Math.max(step,Math.ceil(mx*1.1/step)*step);
  var ticks=[0,.25,.5,.75,1];
  var h='<div class="v3-speed"><div class="v3-speed-y">'+ticks.map(function(f){return '<span style="bottom:'+(f*100)+'%">'+Math.round(yMax*f)+'</span>'}).join('')+'</div>';
  h+='<div class="v3-speed-plot" id="spPlot">'+ticks.map(function(f){return '<span class="gl" style="bottom:'+(f*100)+'%"></span>'}).join('');
  h+='<svg viewBox="0 0 1000 200" preserveAspectRatio="none">';
  S.ops.forEach(function(o){
    if(!vis(o))return;
    // разрывы на часах без замеров — отдельные отрезки
    var seg=[],out='';
    o[mode+'S'].forEach(function(v,i){
      if(v==null){if(seg.length)out+='<polyline points="'+seg.join(' ')+'" style="stroke:'+o.color+'"></polyline>';seg=[];return}
      seg.push((i/47*1000).toFixed(1)+','+(200-v/yMax*200).toFixed(1));
    });
    if(seg.length)out+='<polyline points="'+seg.join(' ')+'" style="stroke:'+o.color+'"></polyline>';
    h+=out;
  });
  h+='</svg><span class="v3-speed-guide" id="spGuide"></span><span id="spDots"></span><div class="v3-speed-hover">';
  for(var i=0;i<48;i++)h+='<span data-i="'+i+'"></span>';
  h+='</div><div class="v3-tip" id="spTip"></div></div></div>';
  h+='<div class="v3-speed-x">'+[0,8,16,24,32,40,47].map(function(i){var t=S.hours[i];return '<span style="left:'+(i/47*100).toFixed(2)+'%'+(i===47?';transform:translateX(-100%)':i===0?';transform:none':'')+'">'+V3.esc(t.slice(8,10)+'.'+t.slice(5,7)+' '+t.slice(11,16))+'</span>'}).join('')+'</div>';
  var groups=S.locs.length?S.locs:[''];
  h+='<div class="v3-speed-leg">'+groups.map(function(l){
    var items=S.ops.filter(function(o){return o.loc===l});
    return '<div><div class="v3-cap" style="margin-bottom:6px">'+V3.esc(l||'Операторы')+' · медиана за 48 ч</div><div class="items">'+items.map(function(o){
      var med=o[mode+'Med'];
      return '<span class="it" style="opacity:'+(vis(o)?1:.35)+'"><i style="background:'+o.color+'"></i>'+V3.esc(o.name)+'<b>'+(med!=null?V3.num(med)+' Мбит/с':'—')+'</b></span>';
    }).join('')+'</div></div>';
  }).join('')+'</div>';
  box.innerHTML=h;
  var plot=document.getElementById('spPlot');
  function show(i){
    spState.hover=i;
    var g=document.getElementById('spGuide'),tip=document.getElementById('spTip'),dots=document.getElementById('spDots');
    var x=(i/47*100).toFixed(2)+'%';g.style.left=x;g.style.display='block';
    var rows='',dh='';
    S.ops.forEach(function(o){
      if(!vis(o))return;var v=o[mode+'S'][i];
      if(v!=null)dh+='<span class="v3-speed-dot" style="left:'+x+';bottom:'+(v/yMax*100).toFixed(1)+'%;background:'+o.color+'"></span>';
      rows+='<div class="v3-tip-r"><i class="v3-dot" style="background:'+o.color+'"></i>'+V3.esc(o.name)+'<em>'+V3.esc(o.loc)+'</em><b>'+(v!=null?V3.num(v)+' Мбит/с':'—')+'</b></div>';
    });
    dots.innerHTML=dh;
    var t=S.hours[i];
    tip.innerHTML='<div class="v3-tip-d">'+V3.esc(t.slice(8,10)+'.'+t.slice(5,7)+' '+t.slice(11,16))+' · '+(mode==='dl'?'загрузка':'отдача')+'</div>'+rows;
    tip.style.display='block';tip.style.left=x;tip.style.transform=i>30?'translateX(calc(-100% - 12px))':'translateX(12px)';
  }
  plot.querySelector('.v3-speed-hover').addEventListener('mouseover',function(e){var s=e.target.getAttribute&&e.target.getAttribute('data-i');if(s!=null)show(+s)});
  plot.addEventListener('mouseleave',function(){document.getElementById('spTip').style.display='none';document.getElementById('spGuide').style.display='none';document.getElementById('spDots').innerHTML=''});
}
