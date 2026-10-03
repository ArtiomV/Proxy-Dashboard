// public/js/portal/overview.js — 3a «Обзор» (макет «Клиентский кабинет v3»).
// Источники: tableData (/api/dashboard_data) — сегодня/вчера/месяц по портам,
// статус, аптайм, скорость; /api/client/daily_traffic — история по дням (график,
// средний день, прогноз, М/М); /api/client/hourly_traffic?days=1 — «Сегодня».
// Фильтр страны режет всю страницу; поиск — таблицу.

var ovState={cc:'all',period:'month',q:'',from:'',to:''};
var _ovHourly=null;   // {hours:[bytes×24], ts, failed}
var _ovHist=null;     // {from,to,byDate}  — прошлый месяц → сегодня (+ ранее для квартала/периода)
var _ovLoading=0;

(function(){var p=V3.store.get('ov_period','month');if(/^(today|7d|month|quarter)$/.test(p))ovState.period=p})();

function _ovRows(){
  if(ovState.cc==='all')return tableData.slice();
  return tableData.filter(function(r){return V3.cc(r)===ovState.cc});
}
function _ovRange(){
  var t=V3.parse(V3.today()),p=ovState.period;
  if(p==='today')return {from:V3.ymd(t),to:V3.ymd(t)};
  if(p==='7d')return {from:V3.ymd(V3.addDays(t,-6)),to:V3.ymd(t)};
  if(p==='quarter'){var q=Math.floor(t.getMonth()/3);return {from:V3.ymd(new Date(t.getFullYear(),q*3,1)),to:V3.ymd(t)}}
  if(p==='custom'&&ovState.from&&ovState.to)return {from:ovState.from,to:ovState.to};
  // 'month' = последние 30 дней (не календарный месяц) — по решению 03.10
  return {from:V3.ymd(V3.addDays(t,-29)),to:V3.ymd(t)};
}
function _ovPrevMonthStart(){var t=V3.parse(V3.today());return V3.ymd(new Date(t.getFullYear(),t.getMonth()-1,1))}
// байты по странам за день (фильтр страны учтён)
function _ovDay(ymd){
  var day=_ovHist&&_ovHist.byDate[ymd];if(!day)return null;
  var out={};
  for(var pid in day){var inf=V3.portInfo(pid,day[pid].nick);out[inf.cc]=(out[inf.cc]||0)+day[pid].in+day[pid].out}
  return out;
}
function _ovPick(by){if(!by)return 0;if(ovState.cc!=='all')return by[ovState.cc]||0;var s=0;for(var k in by)s+=by[k];return s}

function _ovLoad(force){
  var r=_ovRange(),from=r.from<_ovPrevMonthStart()?r.from:_ovPrevMonthStart(),to=V3.today();
  var need=force||!_ovHist||_ovHist.from>from||_ovHist.to!==to||Date.now()-_ovHist.ts>5*60e3;
  if(need&&!_ovLoading){
    _ovLoading=1;
    V3.daily(from,to,force).then(function(res){_ovHist={from:from,to:to,byDate:res.byDate,ts:Date.now()}})
      .catch(function(e){console.error('[overview] daily:',e);_ovHist={from:from,to:to,byDate:{},ts:Date.now(),failed:true}})
      .then(function(){_ovLoading=0;renderOverview()});
  }
  if(ovState.period==='today'&&(force||!_ovHourly||Date.now()-_ovHourly.ts>5*60e3)&&!_ovLoad.h){
    _ovLoad.h=1;
    api('/api/client/hourly_traffic?days=1').then(function(d){
      var m=(d&&d.matrix&&d.matrix[0])||[];
      _ovHourly={hours:m.map(function(v){return (v||0)*1e9}),ts:Date.now()};
    }).catch(function(e){console.error('[overview] hourly:',e);_ovHourly={hours:[],ts:Date.now(),failed:true}})
      .then(function(){_ovLoad.h=0;renderOverview()});
  }
}

// ---------- действия ----------
function ovSetPeriod(p){ovState.period=p;V3.store.set('ov_period',p);V3.closeMenus();renderOverview()}
function ovSetCountry(cc){ovState.cc=cc;renderOverview()}
function ovSetSearch(v){ovState.q=String(v||'').trim().toLowerCase();_ovTable()}
function ovGotoProxies(){V3.go('traffic')}
function ovOpenCustom(){
  var pop=document.getElementById('ovPop');
  var r=ovState.from?{from:ovState.from,to:ovState.to}:_ovRange();
  pop.innerHTML=V3.periodPop('ov',{from:r.from,to:r.to});
  V3.toggleMenu('ovPop',document.getElementById('ovRange'));
}
function ovPreset(k){var r=V3.presetRange(k);document.getElementById('ovFrom').value=r.from;document.getElementById('ovTo').value=r.to}
function ovApplyCustom(){
  var f=document.getElementById('ovFrom').value,t=document.getElementById('ovTo').value;
  if(!f||!t){V3.toast({kind:'err',title:'Укажите обе даты'});return}
  if(f>t){var x=f;f=t;t=x}
  if(t>V3.today())t=V3.today();
  ovState.from=f;ovState.to=t;ovState.period='custom';
  V3.closeMenus();renderOverview();
}
function ovResetCustom(){ovState.from=ovState.to='';ovSetPeriod('month')}

// ---------- рендер ----------
function renderOverview(force){
  if(!document.getElementById('tab-overview'))return;
  v3NavCounts();
  if(!rawData)return;
  _ovLoad(force===true);
  _ovHead();_ovPulse();_ovChart();_ovQuality();_ovTop();_ovTable();
}

function _ovHead(){
  var ccs=V3.countries();
  if(ovState.cc!=='all'&&ccs.indexOf(ovState.cc)<0)ovState.cc='all';
  var h='<button type="button" class="v3-chip'+(ovState.cc==='all'?' on':'')+'" data-on-click="ovSetCountry(\'all\')">Все '+tableData.length+'</button>';
  if(ccs.length>1)ccs.forEach(function(cc){
    var n=tableData.filter(function(r){return V3.cc(r)===cc}).length;
    h+='<button type="button" class="v3-chip'+(ovState.cc===cc?' on':'')+'" data-on-click="ovSetCountry('+V3.q(cc)+')">'+V3.esc(V3.ccName(cc))+' '+n+'</button>';
  });
  document.getElementById('ovChips').innerHTML=h;
  document.querySelectorAll('#ovSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-p')===ovState.period)});
  var r=_ovRange();
  document.getElementById('ovRange').textContent=V3.rangeLabel(r.from,r.to);
  document.getElementById('ovExportBtn').style.display=tableData.some(function(x){return !!x.proxyLogin})?'':'none';
}

// месячные показатели: средний день, прогноз, М/М
function _ovStats(){
  var rows=_ovRows(),t=V3.parse(V3.today()),dom=t.getDate();
  var monthLen=new Date(t.getFullYear(),t.getMonth()+1,0).getDate();
  var todayB=rows.reduce(function(s,r){return s+V3.today_(r)},0);
  var live=rows.reduce(function(s,r){return s+V3.month(r)},0);
  // «все страны»: биллинговый объём (совпадает с актом, по вчера) + сегодня
  var month=(ovState.cc==='all'&&billingData&&billingData.billedMonthGb)?billingData.billedMonthGb*1e9+todayB:live;
  var st={todayB:todayB,month:month,dom:dom,monthLen:monthLen,avg:null,forecast:null,mom:null};
  if(!_ovHist||_ovHist.failed)return st;
  var mtd=0,prev=0,prevHas=false;
  for(var d=1;d<dom;d++){
    mtd+=_ovPick(_ovDay(V3.ymd(new Date(t.getFullYear(),t.getMonth(),d))));
    var pd=new Date(t.getFullYear(),t.getMonth()-1,d);
    if(pd.getMonth()===(t.getMonth()+11)%12){var pb=_ovDay(V3.ymd(pd));if(pb)prevHas=true;prev+=_ovPick(pb)}
  }
  if(dom>1&&mtd>0){st.avg=mtd/(dom-1);st.forecast=st.avg*monthLen}
  if(dom>1&&prevHas&&prev>0)st.mom=(mtd/prev-1)*100;
  return st;
}
function _ovUptime(rows){
  var s=(ovState.cc==='all'&&rawData&&rawData.uptimeSummary30d)||null;
  if(s&&s.checks>0&&s.uptime_pct!=null)return parseFloat(s.uptime_pct);
  var p=rows.filter(function(r){return r.uptimePct!=null}).map(function(r){return parseFloat(r.uptimePct)});
  return p.length?p.reduce(function(a,b){return a+b},0)/p.length:null;
}
function _ovPulse(){
  var rows=_ovRows(),st=_ovStats(),up=_ovUptime(rows);
  var online=rows.filter(V3.isOnline).length;
  var mom={s:_ovHist?'с 1 числа месяца':'…',c:''};
  if(st.mom!=null)mom={s:(st.mom>=0?'▲ +':'▼ −')+V3.num(Math.abs(st.mom))+'% М/М',c:st.mom>=0?'up':'down'};
  var todaySub=_ovHist?'—':'…';
  if(st.avg){var dv=Math.round((st.todayB/st.avg-1)*100);todaySub='на '+Math.abs(dv)+'% '+(dv>=0?'выше':'ниже')+' среднего дня'}
  var cards=[
    {l:'Трафик за месяц',v:V3.gb(st.month),s:mom.s,c:mom.c},
    {l:'Сегодня',v:V3.gb(st.todayB),s:todaySub},
    {l:'Прогноз до конца месяца',v:st.forecast!=null?V3.gb(st.forecast):'—',s:st.forecast!=null?'при текущем темпе':'появится со 2-го числа',g:1},
    {l:'Прокси в работе',v:online+' из '+rows.length,s:up!=null?'аптайм '+V3.pct(up)+' за 30 дней':'аптайм ещё не посчитан',g:1}
  ];
  document.getElementById('ovPulse').innerHTML=cards.map(function(c){
    return '<div class="v3-pulse'+(c.g?' green':'')+'"><div class="v3-pulse-l">'+c.l+'</div><div class="v3-pulse-v">'+c.v+'</div><div class="v3-pulse-s '+(c.c||'')+'">'+c.s+'</div></div>';
  }).join('');
}

function _ovChart(){
  var hourly=ovState.period==='today',r=_ovRange(),box=document.getElementById('ovChart');
  document.getElementById('ovChartTitle').textContent=hourly?'Трафик по часам':'Трафик по дням';
  document.getElementById('ovChartNote').textContent=hourly?V3.dmy(r.from)+' · ГБ в час · МСК':V3.rangeLabel(r.from,r.to)+' · ГБ в сутки';
  var ccs=ovState.cc==='all'?V3.countries():[ovState.cc];
  document.getElementById('ovLegend').innerHTML=hourly?'':ccs.map(function(cc){return '<span><i class="v3-dot" style="background:'+V3.ccColor(cc)+'"></i>'+V3.esc(V3.ccName(cc))+'</span>'}).join('');
  var st=_ovStats(),tiles=document.getElementById('ovTiles');
  function tilesHtml(arr){return arr.map(function(t){return '<div class="v3-tile"><div class="v3-tile-l">'+V3.esc(t.l)+'</div><div class="v3-tile-v">'+t.v+'</div></div>'}).join('')}
  if(hourly){
    if(!_ovHourly){box.innerHTML='<div class="v3-skel" style="height:230px"></div>';tiles.innerHTML='';return}
    var curH=V3.mskHour(),bars=[],max=0,peakH=0,sumDone=0;
    for(var h=0;h<24;h++){
      var v=_ovHourly.hours[h]||0;if(v>max){max=v;peakH=h}if(h<=curH)sumDone+=v;
      bars.push({parts:[{v:v,color:'var(--v3-accent)'}],label:h%3===0?V3.pad(h):'',dim:h>curH,
        tip:{title:V3.pad(h)+':00 — '+V3.pad((h+1)%24)+':00',rows:[{color:'var(--v3-accent)',name:'Трафик',val:V3.gb(v)}]}});
    }
    V3.bars(box,{bars:bars,cls:'',empty:_ovHourly.failed?'Не удалось загрузить почасовые данные':'Сегодня трафика пока нет'});
    tiles.innerHTML=tilesHtml([
      {l:'Сегодня',v:V3.gb(st.todayB)},
      {l:'В среднем за час',v:V3.gb(sumDone/(curH+1))},
      {l:'Пик · '+V3.pad(peakH)+':00',v:V3.gb(max)},
      {l:'Прогноз месяца',v:st.forecast!=null?V3.gb(st.forecast):'—'}
    ]);
    return;
  }
  if(!_ovHist||_ovHist.from>r.from){box.innerHTML='<div class="v3-skel" style="height:230px"></div>';tiles.innerHTML='';return}
  var n=V3.daysBetween(r.from,r.to),start=V3.parse(r.from),multi=r.from.slice(0,7)!==r.to.slice(0,7);
  var out=[],peak=null,peakV=0,done=0,doneSum=0,today=V3.today();
  for(var i=0;i<n;i++){
    var ymd=V3.ymd(V3.addDays(start,i)),by=_ovDay(ymd)||{},parts=[],tot=0,rowsT=[];
    ccs.forEach(function(cc){var v=by[cc]||0;parts.push({v:v,color:V3.ccColor(cc)});tot+=v;rowsT.push({color:V3.ccColor(cc),name:V3.ccName(cc),val:V3.gb(v)})});
    if(tot>peakV){peakV=tot;peak=ymd}
    if(ymd!==today){done++;doneSum+=tot}
    out.push({parts:parts,label:V3.dayLabel(i,n,ymd,multi),
      tip:{title:V3.dayTitle(ymd),rows:rowsT,total:ccs.length>1?{name:'Всего',val:V3.gb(tot)}:null}});
  }
  V3.bars(box,{bars:out,cls:'r5',empty:_ovHist.failed?'Не удалось загрузить историю трафика':'Нет трафика за выбранный период'});
  var pd=peak?V3.parse(peak):null;
  tiles.innerHTML=tilesHtml([
    {l:'Сегодня',v:V3.gb(_ovPick(_ovDay(today))||st.todayB)},
    {l:'Среднесуточно',v:V3.gb(done?doneSum/done:0)},
    {l:'Пик · '+(pd?pd.getDate()+' '+V3.MONTHS_GEN[pd.getMonth()]:'—'),v:peakV>0?V3.gb(peakV):'—'},
    {l:'Прогноз месяца',v:st.forecast!=null?V3.gb(st.forecast):'—'}
  ]);
}

function _ovQuality(){
  var rows=_ovRows(),up=_ovUptime(rows),online=rows.filter(V3.isOnline).length;
  var live=rows.filter(function(r){return r.speedDl>0});
  var dl=live.length?live.reduce(function(s,r){return s+r.speedDl},0)/live.length:null;
  var ul=live.length?live.reduce(function(s,r){return s+(r.speedUl||0)},0)/live.length:null;
  var q=[
    {l:'Аптайм 30 дней',v:up!=null?V3.pct(up):'—',c:up==null?'':up>=99?'good':up>=95?'warn':'bad'},
    {l:'Онлайн сейчас',v:online+'/'+rows.length},
    {l:'Средняя загрузка',v:dl!=null?V3.num(dl)+' Мбит':'—'},
    {l:'Средняя отдача',v:ul!=null?V3.num(ul)+' Мбит':'—'}
  ];
  document.getElementById('ovQuality').innerHTML=q.map(function(t){return '<div class="v3-tile"><div class="v3-tile-l">'+t.l+'</div><div class="v3-tile-v '+(t.c||'')+'">'+t.v+'</div></div>'}).join('');
}

var OV_TOP=['#2f6fe0','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6'];
function _ovTop(){
  var rows=_ovRows().filter(function(r){return V3.month(r)>0}).sort(function(a,b){return V3.month(b)-V3.month(a)}).slice(0,6);
  var box=document.getElementById('ovTop');
  if(!rows.length){box.innerHTML='<div class="v3-empty">В этом месяце трафика пока нет</div>';return}
  var max=V3.month(rows[0]);
  box.innerHTML=rows.map(function(r,i){
    return '<div class="v3-top-row"><span class="v3-top-nick" title="'+V3.esc(V3.label(r.modemNick))+'">'+V3.esc(r.modemNick)+'</span><div class="v3-track"><span style="width:'+(V3.month(r)/max*100).toFixed(1)+'%;background:'+OV_TOP[i]+'"></span></div><span class="v3-top-val">'+V3.gb(V3.month(r))+'</span></div>';
  }).join('');
}
// попап «Все модемы» — полный список по убыванию трафика за месяц
function ovTopAll(){
  var rows=_ovRows().slice().sort(function(a,b){return V3.month(b)-V3.month(a)});
  if(!rows.length){V3.toast({title:'Модемов пока нет'});return}
  var total=rows.reduce(function(s,r){return s+V3.month(r)},0);
  var max=Math.max(1,V3.month(rows[0]));
  var body=rows.map(function(r,i){
    var m=V3.month(r),share=total>0?(m/total*100):0;
    return '<div class="v3-top-row"><span class="v3-top-nick" title="'+V3.esc(V3.label(r.modemNick))+'">'+V3.esc(r.modemNick)+'</span><div class="v3-track"><span style="width:'+(m/max*100).toFixed(1)+'%;background:'+OV_TOP[i%OV_TOP.length]+'"></span></div><span class="v3-top-val">'+V3.gb(m)+'</span><span class="v3-note" style="width:52px;text-align:right;flex:none">'+(share>=0.05?share.toFixed(1):'&lt;0.1')+'%</span></div>';
  }).join('');
  V3.modal(V3.mh('Трафик по модемам за месяц')+'<div class="v3-mb"><div class="v3-hint" style="margin-bottom:10px">'+rows.length+' '+V3.plural(rows.length,'модем','модема','модемов')+' · всего '+V3.gb(total)+' · по убыванию'+(ovState.cc!=='all'?' · фильтр: '+V3.esc(V3.ccName(ovState.cc)):'')+'</div><div style="max-height:60vh;overflow:auto">'+body+'</div></div><div class="v3-mf"><button type="button" class="v3-btn primary" data-on-click="v3CloseModal()">Закрыть</button></div>',{width:'w560'});
}

// строка прокси для «Обзора» (и общая логика бейджей для «Прокси»)
function v3RowFlags(r,avg,n){
  var f={badge:'',stripe:'',bar:''};
  if(!V3.isOnline(r)){f.badge='<span class="v3-badge bad">офлайн</span>';f.stripe=' bad';f.bar='bad'}
  else if(V3.isRotating(r))f.badge='<span class="v3-badge acc">ротация</span>';
  else if(avg>0&&n>2&&V3.month(r)>avg*2){f.badge='<span class="v3-badge warn">×'+V3.num(V3.month(r)/avg)+'</span>';f.stripe=' warn';f.bar='warn'}
  if(r._cached&&!r._offline)f.badge+='<span class="v3-badge warn" title="Данные из кеша — сервер недоступен">кеш</span>';
  return f;
}
function v3UpCls(up){return up==null?'mut':up>=99?'v3-up-good':up>=95?'v3-up-warn':'v3-up-bad'}
function v3SortRows(rows){
  var ccs=V3.countries();
  return rows.sort(function(a,b){
    var ca=ccs.indexOf(V3.cc(a)),cb=ccs.indexOf(V3.cc(b));
    if(ca!==cb)return ca-cb;
    return String(a.modemNick).localeCompare(String(b.modemNick),'ru',{numeric:true});
  });
}
function v3Match(r,q){
  if(!q)return true;
  return [r.modemNick,r.extIp,r.operator,V3.netType(r.networkType),V3.label(r.modemNick),r.proxyLogin].some(function(v){return v&&String(v).toLowerCase().indexOf(q)>=0});
}
var OV_LIMIT=8;
function _ovTable(){
  var body=document.getElementById('ovTable');if(!body)return;
  var all=v3SortRows(_ovRows());
  var total=all.reduce(function(s,r){return s+V3.month(r)},0),avg=all.length?total/all.length:0;
  var maxM=all.reduce(function(m,r){return Math.max(m,V3.month(r))},0);
  var q=ovState.q,rows=q?all.filter(function(r){return v3Match(r,q)}):all;
  var shown=q?rows:rows.slice(0,OV_LIMIT);
  document.getElementById('ovProxiesTitle').textContent='Прокси · '+all.length;
  if(!shown.length){
    body.innerHTML='<tr><td colspan="8">'+(q?'<div class="v3-emptybox bare"><span class="ic">'+V3.ic.empty+'</span><div class="t">Ничего не нашлось</div><div class="d">По запросу «'+V3.esc(ovState.q)+'» нет прокси. Проверьте ник или IP.</div></div>':'<div class="v3-emptybox bare"><span class="ic acc">⌁</span><div class="t">Прокси пока нет</div></div>')+'</td></tr>';
  }else{
    body.innerHTML=shown.map(function(r,i){
      var m=V3.month(r),f=v3RowFlags(r,avg,all.length),up=r.uptimePct!=null?parseFloat(r.uptimePct):null;
      var net=V3.netType(r.networkType);
      return '<tr class="clickable'+(i%2?' z':'')+'" data-on-click="openCard('+V3.q(r.portId)+')">'+
        '<td><span class="v3-stripe'+f.stripe+'"></span><span class="mono ink b">'+V3.esc(r.modemNick)+'</span>'+f.badge+'</td>'+
        '<td class="mut">'+V3.esc(r.operator||'—')+(net?' <span class="v3-net">'+net+'</span>':'')+'</td>'+
        '<td class="mono txt">'+V3.esc(V3.isOnline(r)&&r.extIp&&r.extIp!=='IP_RESET'?r.extIp:'—')+'</td>'+
        '<td class="r mono ink b">'+V3.gb(V3.today_(r))+'</td>'+
        '<td class="r mono mut">'+V3.gb(V3.yest(r))+'</td>'+
        '<td class="r mono ink b">'+V3.gb(m)+'</td>'+
        '<td><div class="v3-share"><div class="v3-track"><span class="'+f.bar+'" style="width:'+(maxM?m/maxM*100:0).toFixed(1)+'%"></span></div><span class="v3-share-v">'+(total>0?Math.round(m/total*100):0)+'%</span></div></td>'+
        '<td class="r mono b '+v3UpCls(up)+'">'+(up!=null?V3.pct(up):'—')+'</td>'+
      '</tr>';
    }).join('');
  }
  var more=document.getElementById('ovMore'),rest=all.length-shown.length;
  if(!q&&rest>0){more.style.display='';more.textContent='+ ещё '+rest+' · открыть страницу «Прокси»'}
  else more.style.display='none';
}

// счётчики в сайдбаре: «Прокси 14», «Документы 2» (непоплаченные счета + неподписанные акты)
function v3NavCounts(){
  var c=document.getElementById('navCountProxies');if(c)c.textContent=tableData.length?String(tableData.length):'';
}
// хук из loadData: перерисовать «Обзор» и активную страницу
function v3OnData(){
  renderOverview(true);
  var act=document.querySelector('.tab-pane.active');
  if(!act)return;
  var id=act.id.replace('tab-','');
  if(id==='traffic'&&typeof renderProxies==='function')renderProxies();
  if(typeof v3DocsBadge==='function')v3DocsBadge();
  if(typeof v3LoadLabels==='function')v3LoadLabels();
}
