// public/js/admin/analytics.js — analytics tab (WP6.3 carve-out from admin.js,
// VERBATIM): category card, trend/heatmap charts, traffic matrix,
// top resources. Classic script, shared global scope.

function chartExtTooltip(context){
  var tt=context.tooltip;
  var el=document.getElementById('chartExtTT');
  if(!el){
    el=document.createElement('div');el.id='chartExtTT';el.className='float-tt';
    el.style.cssText='position:fixed;z-index:10000;pointer-events:none;background:#fff;border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:150px;box-shadow:0 4px 20px rgba(0,0,0,0.10);opacity:0;transition:opacity .12s ease;font-family:Inter,-apple-system,sans-serif';
    document.body.appendChild(el);
  }
  if(!tt||tt.opacity===0){el.style.opacity='0';return;}
  var splitKV=function(s){var i=String(s).lastIndexOf(': ');return i>0?[s.slice(0,i),s.slice(i+2)]:[s,''];};
  var h='';
  (tt.title||[]).forEach(function(t){h+='<div style="font-size:11px;color:#9b9b98;margin-bottom:6px">'+t+'</div>';});
  var colors=tt.labelColors||[];
  (tt.body||[]).forEach(function(b,i){
    var c=colors[i]||{};
    var swatch=c.backgroundColor?'<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+c.backgroundColor+';margin-right:7px;flex:none"></span>':'';
    (b.lines||[]).forEach(function(ln){
      var kv=splitKV(ln.replace(/^\s+/,''));
      h+='<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:2px 0">'
        +'<span style="font-size:11px;color:#6b6b68;display:flex;align-items:center;min-width:0">'+swatch+'<span style="overflow:hidden;text-overflow:ellipsis">'+kv[0]+'</span></span>'
        +(kv[1]?'<span style="font-size:12px;font-weight:600;color:#1a1a1a;white-space:nowrap">'+kv[1]+'</span>':'')+'</div>';
    });
  });
  if(tt.footer&&tt.footer.length){
    h+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>';
    tt.footer.forEach(function(f){
      var kv=splitKV(f);
      h+='<div style="display:flex;justify-content:space-between;gap:16px"><span style="font-size:11px;color:#9b9b98">'+kv[0]+'</span>'
        +(kv[1]?'<span style="font-size:12px;font-weight:600;color:#1a1a1a">'+kv[1]+'</span>':'')+'</div>';
    });
  }
  el.innerHTML=h;
  var rect=context.chart.canvas.getBoundingClientRect();
  el.style.opacity='1';
  var w=el.offsetWidth,ht=el.offsetHeight;
  var x=rect.left+tt.caretX+14, y=rect.top+tt.caretY-10;
  if(x+w>window.innerWidth-8) x=rect.left+tt.caretX-w-14;
  if(x<8) x=8;
  if(y+ht>window.innerHeight-8) y=window.innerHeight-ht-8;
  if(y<8) y=8;
  el.style.left=x+'px';el.style.top=y+'px';
}

// Apply Chart.js global defaults
(function(){if(typeof Chart==='undefined')return;
  Chart.defaults.font.family="'Inter',-apple-system,sans-serif";
  Chart.defaults.font.size=12;
  Chart.defaults.plugins.legend.display=false;
  // Единый стиль ВСЕХ тултипов графиков = карточка «Почасового трафика»
  // (белая карточка с чёткой тенью, а не canvas-подложка, которая сливалась
  // со светлым фоном). Реализовано внешним HTML-тултипом chartExtTooltip:
  // отключаем встроенный рендер и вешаем внешний обработчик глобально —
  // так его наследуют все графики, а их callbacks (label/title/footer)
  // продолжают наполнять содержимое.
  Chart.defaults.plugins.tooltip.enabled=false;
  Chart.defaults.plugins.tooltip.external=chartExtTooltip;
})();

// Domain categorization
var DOMAIN_CATS={
  'Социальные сети':[/facebook|instagram|tiktok|vk\.com|twitter|x\.com|snapchat|pinterest|linkedin/i],
  'Поисковики':[/google\.|yandex\.|bing\.|duckduckgo|yahoo/i],
  'Видео':[/youtube|youtu\.be|vimeo|twitch|dailymotion|rutube/i],
  'Мессенджеры':[/telegram|whatsapp|viber|signal|discord/i],
  'CDN/Облако':[/cloudflare|amazonaws|akamai|fastly|cdn\.|azure|gstatic|googleusercontent/i],
  'Реклама':[/doubleclick|adservice|adsense|facebook.*ad|ads\.|analytics/i],
  'Почта':[/mail\.|outlook|gmail|smtp|imap|pop3/i],
  'Прочее':[]
};
function categorize(domain){for(var cat in DOMAIN_CATS){var patterns=DOMAIN_CATS[cat];for(var i=0;i<patterns.length;i++){if(patterns[i].test(domain))return cat}}return'Прочее'}

function getTrafficFields(){
  switch(accPeriod){
    case'day':return{inKey:'bandwidth_bytes_day_in',outKey:'bandwidth_bytes_day_out',label:'Сегодня'};
    case'yesterday':return{inKey:'bandwidth_bytes_yesterday_in',outKey:'bandwidth_bytes_yesterday_out',label:'Вчера'};
    case'month':return{inKey:'bandwidth_bytes_month_in',outKey:'bandwidth_bytes_month_out',label:'Текущий месяц'};
    case'prevmonth':return{inKey:'bandwidth_bytes_prevmonth_in',outKey:'bandwidth_bytes_prevmonth_out',label:'Прошлый месяц'};
    case'lifetime':return{inKey:'bandwidth_bytes_lifetime_in',outKey:'bandwidth_bytes_lifetime_out',label:'Всё время'};
    default:return{inKey:'bandwidth_bytes_month_in',outKey:'bandwidth_bytes_month_out',label:'Месяц'};
  }
}

function collectTrafficData(){
  if(!currentData||!currentData._modemMap)return null;
  var map=currentData._modemMap,fields=getTrafficFields();
  var totalModems=0,totalOnline=0,totalIn=0,totalOut=0;
  var modemTraffic=[],clientTraffic={},serverTraffic={},serverIn={},serverOut={},serverOpTraffic={};
  // Only track portNames that belong to registered clients
  var registeredPortNames=new Set((currentData.clients||[]).map(function(c){return c.portName}).filter(Boolean));
  for(var imei in map){
    var m=map[imei];
    var st=getModemStatus(m);
    var isOn=st==='online'||st==='rotating';
    // Iterate ALL ports of this modem (each port = separate client/portName)
    var ports=m.ports.length?m.ports:[{}];
    for(var pi=0;pi<ports.length;pi++){
      var port=ports[pi],bw=port._bw||{};
      var pn=port.portName||'Не назначен';
      totalModems++;
      if(isOn)totalOnline++;
      var din=parseTraffic(bw[fields.inKey]),dout=parseTraffic(bw[fields.outKey]);
      var dayIn=parseTraffic(bw.bandwidth_bytes_day_in),dayOut=parseTraffic(bw.bandwidth_bytes_day_out);
      var yestIn=parseTraffic(bw.bandwidth_bytes_yesterday_in),yestOut=parseTraffic(bw.bandwidth_bytes_yesterday_out);
      var monIn=parseTraffic(bw.bandwidth_bytes_month_in),monOut=parseTraffic(bw.bandwidth_bytes_month_out);
      var prevIn=parseTraffic(bw.bandwidth_bytes_prevmonth_in),prevOut=parseTraffic(bw.bandwidth_bytes_prevmonth_out);
      var lifeIn=parseTraffic(bw.bandwidth_bytes_lifetime_in),lifeOut=parseTraffic(bw.bandwidth_bytes_lifetime_out);
      var rawOp=m.operator||'Неизвестный';
      var op=rawOp;
      totalIn+=din;totalOut+=dout;
      modemTraffic.push({nick:m.nick,operator:op,server:m.server,pn:pn,portId:port.portID||'',tIn:din,tOut:dout,dayIn:dayIn,dayOut:dayOut,yestIn:yestIn,yestOut:yestOut,monIn:monIn,monOut:monOut,prevIn:prevIn,prevOut:prevOut,lifeIn:lifeIn,lifeOut:lifeOut,online:isOn});
      // Only add to clientTraffic if this portName belongs to a registered client
      if(!registeredPortNames.has(pn))continue;
      if(!clientTraffic[pn])clientTraffic[pn]={tIn:0,tOut:0,modems:0,online:0};
      clientTraffic[pn].tIn+=din;clientTraffic[pn].tOut+=dout;clientTraffic[pn].modems++;
      if(isOn)clientTraffic[pn].online++;
      if(!serverTraffic[m.server])serverTraffic[m.server]=0;
      serverTraffic[m.server]+=din+dout;
      if(!serverIn[m.server])serverIn[m.server]=0;serverIn[m.server]+=din;
      if(!serverOut[m.server])serverOut[m.server]=0;serverOut[m.server]+=dout;
      if(!serverOpTraffic[m.server])serverOpTraffic[m.server]={};
      if(!serverOpTraffic[m.server][op])serverOpTraffic[m.server][op]={tIn:0,tOut:0,count:0};
      serverOpTraffic[m.server][op].tIn+=din;serverOpTraffic[m.server][op].tOut+=dout;serverOpTraffic[m.server][op].count++;
    }
  }
  modemTraffic.sort(function(a,b){return(b.tIn+b.tOut)-(a.tIn+a.tOut)});
  // Stable per-client modem TOTAL: override the volatile live count (which drops
  // when a modem briefly goes offline) with the backend's 24h-roster count
  // (client.modemCount). Online count stays live. So a client shows e.g. 12/15
  // instead of flickering 12/13. Rows are created for clients whose modems are
  // all offline right now so their total doesn't collapse to 0.
  (currentData.clients||[]).forEach(function(c){
    if(!c.portName || typeof c.modemCount!=='number' || c.modemCount<=0) return;
    if(!clientTraffic[c.portName]) clientTraffic[c.portName]={tIn:0,tOut:0,modems:0,online:0};
    // «в работе» по клиенту — fleet-семантика из backend (modemWorking), а не
    // живой getModemStatus: иначе числитель расходился с шапкой («31/31» при
    // «90/91» наверху — модем, тёмный для fleet, ещё считался онлайн тут).
    if(typeof c.modemWorking==='number') clientTraffic[c.portName].online=c.modemWorking;
    // Показываем 24ч-ростер (стабильнее живого счётчика), НО итог не может быть
    // меньше числа онлайн-модемов прямо сейчас — иначе выходит «32/30» (ростер
    // отстаёт от только что добавленных модемов). max() держит инвариант online≤total.
    clientTraffic[c.portName].modems = Math.max(c.modemCount, clientTraffic[c.portName].online || 0);
  });
  return{totalModems:totalModems,totalOnline:totalOnline,totalIn:totalIn,totalOut:totalOut,modemTraffic:modemTraffic,clientTraffic:clientTraffic,serverTraffic:serverTraffic,serverIn:serverIn,serverOut:serverOut,serverOpTraffic:serverOpTraffic,label:fields.label};
}

// fmtGb, fmtGbShort, pct moved to /js/utils.js

function getDaysElapsed(){
  if(accPeriod==='month')return new Date().getDate()||1;
  if(accPeriod==='yesterday')return 1;
  if(accPeriod==='day')return 1;
  if(accPeriod==='prevmonth'){var prev=new Date();prev.setDate(0);return prev.getDate()||30}
  if(accPeriod==='lifetime')return 30;
  return 1;
}

// ==================== TREND CARD ====================
var _trendData=null;
function loadTrendData(sfx){
  if(_trendData){renderTrendCard(_trendData,sfx);return;}
  api(API+'/api/analytics/monthly_traffic?months=6')
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_trendData=data;renderTrendCard(data,sfx);})
    .catch(function(){});
}
function trendFmt(gb){if(!gb&&gb!==0)return'0 МБ';if(gb>=1000)return(gb/1000).toFixed(1)+' ТБ';if(gb>=1)return gb.toFixed(1)+' ГБ';return Math.round(gb*1024)+' МБ';}
var _MONTHS_RU_GEN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function fmtDateRuLong(ds){if(!ds)return'—';var p=ds.split('-');if(p.length<3)return ds;var m=parseInt(p[1],10)-1,day=parseInt(p[2],10);return day+' '+(_MONTHS_RU_GEN[m]||'');}
function pluralModem(n){var a=Math.abs(n)%100,b=a%10;if(a>10&&a<20)return n+' модемов';if(b>1&&b<5)return n+' модема';if(b===1)return n+' модем';return n+' модемов';}
function renderTrendCard(months,sfx){sfx=sfx||'';
  // Дашбордная карточка «Потребление трафика» — полноценный Chart.js как MRR.
  // Старая карточка «Тренд» на Трафике осталась на DOM-столбиках (sfx='').
  if(sfx==='New'){ renderTrendChartNew(months); return; }
  var wrap=document.getElementById('trendBarsWrap'+sfx);
  var labWrap=document.getElementById('trendLabelsWrap'+sfx);
  if(!wrap||!labWrap||!months||!months.length)return;
  var maxVal=Math.max.apply(null,months.map(function(m){return m.forecast_gb||m.total_gb}));
  if(!maxVal)maxVal=1;
  var CHART_H=Math.max(wrap.offsetHeight-4,40)||68;
  function bPx(gb){return Math.max(Math.round(gb/maxVal*CHART_H),2);}
  var bH='';
  months.forEach(function(m,i){
    var factPx=bPx(m.total_gb);
    var fcPx=m.is_current&&m.forecast_gb>m.total_gb?bPx(m.forecast_gb-m.total_gb):0;
    var bg='#185FA5';
    // Ширина/зазор столбца — как в MRR: столбец занимает ~48% слота по центру
    // (barPercentage 0.6 × categoryPercentage 0.8), потолок = maxBarThickness 22.
    bH+='<div style="flex:1;display:flex;flex-direction:column;align-items:center;cursor:pointer"';
    bH+=' data-on-mouseenter="onTrendHover('+i+',event)" data-on-mouseleave="onTrendLeave()">';
    if(fcPx>0)bH+='<div style="width:48%;max-width:22px;height:'+fcPx+'px;background:#85B7EB;border-radius:3px 3px 0 0;opacity:.7"></div>';
    bH+='<div style="width:48%;max-width:22px;height:'+factPx+'px;background:'+bg+';border-radius:'+(fcPx>0?'0':'3px 3px')+' 0 0;transition:opacity .12s"></div>';
    bH+='</div>';
  });
  wrap.innerHTML=bH;
  var lH='';
  months.forEach(function(m){
    lH+='<div style="flex:1;text-align:center;font-size:8px;color:'+(m.is_current?'#185FA5':'#9b9b98')+';font-weight:'+(m.is_current?'600':'400')+'">'+(/^\d{4}-\d{2}/.test(m.label||'')?_ymRu(m.label,true):(m.label||''))+'</div>';
  });
  labWrap.innerHTML=lH;
  // Зазор больше не нужен: расстояние задаётся свободными 52% внутри слота (как в MRR).
  // Тот же gap у подписей, иначе месяцы уедут относительно столбцов.
  wrap.style.gap='0px';
  labWrap.style.gap='0px';
  window._trendMonths=months;
  var sumEl=document.getElementById('trendSum'+sfx);
  if(sumEl){
    var tot=months.reduce(function(a,m){return a+(m.total_gb||0);},0);
    var cur=months[months.length-1]||{}, prev=months[months.length-2]||{};
    var cv=(cur.is_current&&cur.forecast_gb)?cur.forecast_gb:(cur.total_gb||0);
    var pv=prev.total_gb||0;
    var dl=pv>0?Math.round((cv-pv)/pv*100):null;
    sumEl.innerHTML='<span>Σ '+trendFmt(tot)+'</span>'+(dl==null?'':'<span style="color:'+(dl>=0?'var(--success)':'var(--danger)')+'">'+(dl>=0?'↑ +':'↓ −')+Math.abs(dl)+'% к пред. мес</span>');
  }
}
// «Потребление трафика» (дашборд) — 1:1 с MRR: та же геометрия столбцов
// (CHART_BAR_STACK + chartStackRadius + maxBarThickness 22), сетка и ось объёма
// слева, названия месяцев внизу, стек Факт + Прогноз (как «За ГБ»/«За модем»).
function renderTrendChartNew(months){
  if(!months||!months.length) return;
  window._trendMonths=months;
  var lg=document.getElementById('trendLegendNew');
  if(lg) lg.innerHTML=[['Факт','#185FA5'],['Прогноз','#85B7EB']].map(function(x){
    return '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[1]+'"></span>'+x[0]+'</span>';
  }).join('');
  var cv=document.getElementById('newTrendCanvas'); if(!cv||!window.Chart) return;
  if(window._newTrendChart){ try{window._newTrendChart.destroy();}catch(_){} window._newTrendChart=null; }
  var cc=getChartColorsLight();
  var barOpts=Object.assign({stack:'t', borderRadius:chartStackRadius()}, CHART_BAR_STACK, {maxBarThickness:22});
  // Короткие названия месяцев (Фев/Мар) — влезают горизонтально, без поворота,
  // поэтому карточка ниже. Как в MRR.
  var labels=months.map(function(m){ return m.month ? _ymRu(m.month,true) : (m.label||''); });
  var fact=months.map(function(m){ return m.total_gb||0; });
  var fcast=months.map(function(m){ return (m.is_current && m.forecast_gb>m.total_gb) ? (m.forecast_gb-m.total_gb) : 0; });
  window._newTrendChart=newChartSafe(cv,{
    type:'bar',
    data:{ labels:labels, datasets:[
      Object.assign({label:'Факт', data:fact, backgroundColor:'#185FA5'}, barOpts),
      Object.assign({label:'Прогноз', data:fcast, backgroundColor:'#85B7EB'}, barOpts)
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{mode:'index',intersect:false,
          callbacks:{label:function(ctx){return ctx.dataset.label+': '+trendFmt(ctx.parsed.y||0);},
            footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+trendFmt(t);}}}},
      scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,minRotation:0,autoSkip:false},grid:{display:false},border:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v===0?'0':(v>=1000?(v/1000)+' ТБ':v+' ГБ');}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
  });
}
function onTrendHover(idx,event){
  var months=window._trendMonths;if(!months)return;
  var m=months[idx];if(!m)return;
  var prev=idx>0?months[idx-1]:null;
  var ch=prev&&prev.total_gb>0?Math.round((m.total_gb-prev.total_gb)/prev.total_gb*100):null;
  var lines=[m.label+': <b>'+trendFmt(m.total_gb)+'</b>'];
  if(m.forecast_gb)lines.push('Прогноз: ~'+trendFmt(m.forecast_gb));
  if(ch!==null){var cc2=ch>=0?'#3B6D11':'#A32D2D';lines.push('vs предыдущий: <span style="color:'+cc2+';font-weight:600">'+(ch>=0?'+':'')+ch+'%</span>');}
  showFloatTooltip('trendTT',event,lines);
}
function onTrendLeave(){
  hideFloatTooltip('trendTT');
}
function showFloatTooltip(id,event,lines){
  var tt=document.getElementById(id);
  if(!tt){tt=document.createElement('div');tt.id=id;tt.className='float-tt';tt.style.cssText='position:fixed;z-index:9999;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:130px;line-height:1.6';document.body.appendChild(tt);}
  tt.innerHTML=lines.join('<br>');tt.style.display='block';
  tt.style.left='-9999px';tt.style.top='-9999px';
  var tw=tt.offsetWidth||200,th=tt.offsetHeight||100;
  var x=event.clientX+12,y=event.clientY-20;
  if(x+tw+8>window.innerWidth)x=event.clientX-tw-12;
  if(y+th+8>window.innerHeight)y=event.clientY-th-8;
  if(x<4)x=4;if(y<4)y=4;
  tt.style.left=x+'px';tt.style.top=y+'px';
}
function hideFloatTooltip(id){var tt=document.getElementById(id);if(tt)tt.style.display='none';}
// ==================== HEATMAP ====================
var _newHmCache={};
// Контекст тепловой карты дашборда (вкладка NEW). Рендер — renderHeatmap/
// renderHeatmapSubTabs/...; ctx подменяет состояние (view/id/cache) и DOM-id.
var _hmNew={get view(){return _newHmView;},set view(v){_newHmView=v;},get id(){return _newHmId;},set id(v){_newHmId=v;},cache:_newHmCache,grid:'newHmGrid',summary:'newHmSummary',subtabs:'newHmSubTabs',tabPrefix:'newHmTab',tabClass:true,ttId:'newHeatTT',dataKey:'_newHeatmapData',self:'_hmNew'};
// Stage 17 — `operator` list is now built DYNAMICALLY from
// /api/admin/operators (see refreshOperatorList() at end of file). Hardcoded
// fallback below is used only during first paint, before the API answers,
// and gets replaced as soon as the list arrives. This way new operators like
// digi appear in the dropdown automatically without an admin.js edit.
var _heatmapConfig={
  country:[{id:'all',label:'Все страны',modems:51},{id:'moldova',label:'Молдова',modems:28},{id:'romania',label:'Румыния',modems:23}],
  operator:[{id:'orange_ro',label:'Orange RO',modems:6},{id:'vodafone_ro',label:'Vodafone RO',modems:17},{id:'moldtelecom',label:'Moldtelecom',modems:23},{id:'orange_md',label:'Orange MD',modems:5}],
  client:[]
};
function hmAccent(view,id){
  var m={all:'#185FA5',moldova:'#185FA5',romania:'#1D9E75',orange_ro:'#185FA5',vodafone_ro:'#1D9E75',moldtelecom:'#D85A30',orange_md:'#BA7517'};
  if(m[id])return m[id];
  var cls=currentData&&currentData.clients||[];
  var i=cls.findIndex(function(c){return c.portName===id});
  return CHART_COLORS.clients[Math.max(i,0)%CHART_COLORS.clients.length]||'#185FA5';
}
function setHeatmapView(view,ctx){
  ctx=ctx||_hmNew;
  ctx.view=view;
  if(view==='client'){_heatmapConfig.client=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:c.modemCount||1}});}
  var cfg=_heatmapConfig[view]||[];
  if(cfg.length)ctx.id=cfg[0].id;
  ['country','operator','client'].forEach(function(v){
    var btn=document.getElementById(ctx.tabPrefix+v.charAt(0).toUpperCase()+v.slice(1));
    if(!btn)return;var active=v===view;
    if(ctx.tabClass){ btn.classList.toggle('active',active); }
    else{ btn.style.borderBottomColor=active?'var(--accent)':'transparent';
      btn.style.color=active?'var(--accent)':'var(--text-2)';btn.style.fontWeight=active?'600':'500'; }
  });
  renderHeatmapSubTabs(ctx);loadHeatmapData(ctx);
}
function renderHeatmapSubTabs(ctx){
  ctx=ctx||_hmNew;
  var c=document.getElementById(ctx.subtabs);if(!c)return;
  var view=ctx.view;
  var cfg=view==='client'?(currentData&&currentData.clients||[]).filter(function(x){return x.modemCount>0}).map(function(x){return{id:x.portName,label:x.name,modems:x.modemCount||1};}):(_heatmapConfig[view]||[]);
  var h='';
  cfg.forEach(function(item){
    var active=item.id===ctx.id;var col=hmAccent(view,item.id);
    // По макету чипы — чистый текст, без флагов/глобуса из конфига
    var lbl=String(item.label||'').replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu,'').trim();
    h+='<button data-on-click="selectHeatId(\''+esc(item.id)+'\''+(ctx.self?','+ctx.self:'')+')" style="background:'+(active?col:'var(--bg-3)')+';color:'+(active?'#fff':'var(--text-1)')+';border:none;border-radius:999px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:'+(active?'600':'400')+';transition:all .15s">'+esc(lbl)+'</button>';
  });
  c.innerHTML=h;
}
function selectHeatId(id,ctx){ctx=ctx||_hmNew;ctx.id=id;if(ctx===_hmNew)_dashUiSave({hmId:id});renderHeatmapSubTabs(ctx);loadHeatmapData(ctx);}
function loadHeatmapData(ctx){
  ctx=ctx||_hmNew;
  var key=ctx.view+'|'+ctx.id;
  if(ctx.cache[key]){renderHeatmap(ctx.cache[key],ctx);return;}
  var g=document.getElementById(ctx.grid);
  if(g)g.innerHTML='<div class="skel" style="height:160px">'+skelHeat(24,3)+'</div>';
  api(API+'/api/analytics/heatmap?view='+ctx.view+'&id='+encodeURIComponent(ctx.id)+'&days=7')
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){ctx.cache[key]=data;renderHeatmap(data,ctx);})
    .catch(function(e){var g=document.getElementById(ctx.grid);if(g)g.innerHTML='<div style="padding:20px;color:var(--danger);font-size:12px">Ошибка: '+(esc(e.message))+'</div>';});
}
function lerpCol(a,b,t){
  var ah=parseInt(a.slice(1),16),bh=parseInt(b.slice(1),16);
  var r=Math.round(((ah>>16)&255)+(((bh>>16)&255)-((ah>>16)&255))*t);
  var g=Math.round(((ah>>8)&255)+(((bh>>8)&255)-((ah>>8)&255))*t);
  var bl=Math.round((ah&255)+((bh&255)-(ah&255))*t);
  return'#'+(r<16?'0':'')+r.toString(16)+(g<16?'0':'')+g.toString(16)+(bl<16?'0':'')+bl.toString(16);
}
function darkenCol(hex,amt){
  var h=parseInt(hex.slice(1),16);
  return'#'+[[(h>>16)&255],[(h>>8)&255],[h&255]].map(function(v){return Math.max(0,Math.round(v[0]*(1-amt))).toString(16).padStart(2,'0')}).join('');
}
function heatColor(val,maxV,accent){
  if(!val||!maxV)return'var(--bg-3)';
  var t=Math.pow(val/maxV,0.55);
  if(t<0.4)return lerpCol('#F1F1EF','#85B7EB',t/0.4);
  if(t<0.8)return lerpCol('#85B7EB',accent,(t-0.4)/0.4);
  return lerpCol(accent,darkenCol(accent,0.35),(t-0.8)/0.2);
}
function renderHeatmap(data,ctx){
  ctx=ctx||_hmNew;
  var g=document.getElementById(ctx.grid),sum=document.getElementById(ctx.summary);
  if(!g||!data||!data.matrix)return;
  var mat=data.matrix,days=data.meta&&data.meta.days||[],dm=data.meta&&data.meta.day_meta||[];
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var accent=hmAccent(ctx.view,ctx.id);
  // Build per-modem matrix for coloring and display
  var perModem=mat.map(function(row){return row.map(function(v){return v/mDiv;})});
  var maxV=0;perModem.forEach(function(row){row.forEach(function(v){if(v>maxV)maxV=v;})});
  var DAYS_RU=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  var h='<div style="min-width:560px">';
  h+='<div style="display:flex;margin-left:58px;margin-bottom:4px">';
  for(var hi=0;hi<24;hi+=2){
    h+='<div style="flex:1;text-align:center;font-size:9px;color:#9b9b98">'+String(hi).padStart(2,'0')+'</div>';
    h+='<div style="flex:1"></div>';
  }
  h+='</div>';
  mat.forEach(function(row,di){
    var ds=days[di]||'';var dMeta=dm[di]||{};
    var d=new Date(ds+'T00:00:00');
    var dn=DAYS_RU[d.getDay()]||dMeta.label||'';
    var dShort=fmtDateRuLong(ds);
    h+='<div style="display:flex;align-items:center;margin-bottom:3px">';
    h+='<div style="width:58px;font-size:10px;color:#6b6b68;flex-shrink:0;text-align:right;padding-right:8px;line-height:1.3">';
    h+='<div style="font-weight:500">'+dn+'</div><div style="font-size:9px;color:#9b9b98">'+dShort+'</div></div>';
    h+='<div style="display:flex;flex:1;gap:2px">';
    row.forEach(function(val,hr){
      var pmVal=perModem[di][hr];
      var col=heatColor(pmVal,maxV,accent);
      var isCorrected=data.meta&&data.meta.corrected&&data.meta.corrected[di]&&data.meta.corrected[di][hr];
      // Diagonal-stripe overlay marks cells whose underlying hour rows have
      // uncertain>0 (counter anomaly or gap-fill). Base colour still encodes
      // the value so the heatmap stays readable.
      var bg = isCorrected
        ? col+';background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 3px, transparent 3px 6px)'
        : col;
      h+='<div style="flex:1;height:28px;border-radius:3px;background:'+bg+';cursor:pointer;transition:opacity .1s;position:relative"';
      h+=' data-on-mouseenter="showHeatTT('+di+','+hr+',event,this'+(ctx.self?','+ctx.self:'')+')" data-on-mouseleave="hideFloatTooltip(\''+ctx.ttId+'\')">';
      if(isCorrected)h+='<span style="position:absolute;top:1px;right:2px;font-size:9px;line-height:1;color:rgba(0,0,0,0.55);font-weight:600" title="Час содержит данные восстановленные после сбоя счётчика — значение приблизительное">'+icon('alert',9)+'</span>';
      h+='</div>';
    });
    h+='</div></div>';
  });
  // Legend (per-modem scale)
  h+='<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:10px;color:#9b9b98">';
  h+='<span>0</span><div style="display:flex;gap:2px">';
  for(var li=0;li<=8;li++)h+='<div style="width:16px;height:10px;border-radius:2px;background:'+heatColor(li/8*maxV,maxV,accent)+'"></div>';
  h+='</div><span>'+trendFmt(maxV)+'/мод</span></div>';
  h+='</div>';
  g.innerHTML=h;
  // Summary metrics
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var flat=[];mat.forEach(function(r){r.forEach(function(v){flat.push(v);})});
  var total=flat.reduce(function(a,b){return a+b},0);
  var n=mat.length||7;
  var dTotals=mat.map(function(r){return r.reduce(function(a,b){return a+b},0)});
  var hTotals=Array.from({length:24},function(_,hh){return mat.reduce(function(s,r){return s+(r[hh]||0)},0)});
  var peakH=hTotals.indexOf(Math.max.apply(null,hTotals));
  var positiveHours=hTotals.filter(function(v){return v>0});
  var quietH=positiveHours.length>0?hTotals.indexOf(Math.min.apply(null,positiveHours)):0;
  var peakD=dTotals.indexOf(Math.max.apply(null,dTotals));
  var nightTotal=flat.filter(function(_,i){var hh=i%24;return hh>=0&&hh<=5;}).reduce(function(a,b){return a+b},0);
  var nightPct=total>0?Math.round(nightTotal/total*100):0;

  if(sum){
    sum.style.display='flex';
    sum.innerHTML=
      hmSumItem('Всего за 7 дней',trendFmt(total),pluralModem(mCnt),false)
      +hmSumItem('Ср. на модем/сут',(n&&mDiv)?trendFmt(total/n/mDiv):'—',(n?trendFmt(total/n):'—')+' среднесуточно',false)
      +hmSumItem('Пиковый час',String(peakH).padStart(2,'0')+':00',(n&&mDiv)?trendFmt(hTotals[peakH]/n/mDiv)+'/мод в среднем':'—',true)
      +hmSumItem('Тихий час',String(quietH).padStart(2,'0')+':00','Лучшее время для тех. работ',false)
      +hmSumItem('Пиковый день',(dm[peakD]?dm[peakD].label+', '+fmtDateRuLong(days[peakD]||''):fmtDateRuLong(days[peakD]||'')),mDiv?trendFmt(dTotals[peakD]/mDiv)+'/мод':'—',true)
      +hmSumItem('Ночной трафик',nightPct+'%','00:00–06:00',false);
  }
  window[ctx.dataKey]=data;
}
function hmSumItem(label,val,sub,isPeak){
  return'<div style="flex:1;display:flex;flex-direction:column;gap:3px;padding:0 20px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:15px;font-weight:500;line-height:1.2;white-space:nowrap;'+(isPeak?'color:#185FA5':'color:var(--text-0)')+'">'+val+'</div>'
    +(sub?'<div style="font-size:10px;color:#9b9b98;white-space:nowrap">'+sub+'</div>':'')
    +'</div>';
}
// (removed _getOpModemsForView — the heatmap tooltip now derives per-operator
//  modem counts from the same historical breakdown as the bytes, so live counts
//  no longer mismatch the hour's traffic.)
function getHeatmapModems(ctx){
  ctx=ctx||_hmNew;
  var view=ctx.view,id=ctx.id;
  // Count unique modems (IMEIs) from status — not ports from bandwidth
  if(currentData&&currentData.status){
    var status=currentData.status||[];
    var byCountry={},byOp={},byClient={},totalModems=0;
    var seen={};
    status.forEach(function(m){
      var imei=m.modem_details&&m.modem_details.IMEI;if(!imei||seen[imei])return;
      seen[imei]=true;
      totalModems++;
      var srv=m._server||'';
      var cn=(COUNTRIES[srv]||{}).name||srv;
      byCountry[cn]=(byCountry[cn]||0)+1;
      var op=(function(){var r=(m.net_details?m.net_details.CELLOP:'')||'';var isRO=srv.indexOf('S2')===0;var _c=r.toLowerCase().replace(/\s+/g,' ').trim();var n={'unite':'Moldtelecom','moldtelecom':'Moldtelecom','moldtelecom moldtelecom':'Moldtelecom','moldcell':'Moldcell','orange':isRO?'Orange RO':'Orange MD','orange ro':'Orange RO','orange md':'Orange MD','vf-ro':'Vodafone RO','vfro':'Vodafone RO','vodafone ro':'Vodafone RO','vodafone':'Vodafone RO'};return n[_c]||r})();
      if(op)byOp[op]=(byOp[op]||0)+1;
      // Map IMEI to client portName via ports
      var ports=currentData.ports&&currentData.ports[imei];
      if(ports&&ports.length>0){var pn=ports[0].portName;if(pn)byClient[pn]=(byClient[pn]||0)+1;}
    });
    // Map country config ids to COUNTRIES names
    var _countryIdToName={'moldova':'Молдова','romania':'Румыния'};
    _heatmapConfig.country.forEach(function(c){
      if(c.id==='all')c.modems=totalModems;
      else{var target=_countryIdToName[c.id]||c.id;c.modems=byCountry[target]||0;}
    });
    _heatmapConfig.operator.forEach(function(o){
      var opName=o.label.replace(/[^\w\s]/g,'').trim();
      o.modems=byOp[opName]||0;
    });
  }
  // For clients — count PORTS (bandwidth entries), not modems
  // Each port generates its own traffic, so per-client heatmap divides by port count
  var cfg;
  if(view==='client'){
    var _byClient={};
    if(currentData&&currentData.bandwidth){for(var _bk in currentData.bandwidth){var _pn=currentData.bandwidth[_bk].portName;if(_pn)_byClient[_pn]=(_byClient[_pn]||0)+1;}}
    cfg=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:_byClient[c.portName]||0};});
  } else {
    cfg=_heatmapConfig[view]||[];
  }
  var found=cfg.find(function(s){return s.id===id});
  if(found&&found.modems!==undefined)return found.modems||0;
  // Fallback for 'all': use totalModems from status
  if(id==='all'&&currentData&&currentData.status){
    var _seen={};var _t=0;currentData.status.forEach(function(m){var i=m.modem_details&&m.modem_details.IMEI;if(i&&!_seen[i]){_seen[i]=1;_t++;}});
    return _t;
  }
  return 0;
}
function showHeatTT(di,hr,event,cell,ctx){
  ctx=ctx||_hmNew;
  var data=window[ctx.dataKey];if(!data||!data.matrix||!data.matrix[di])return;
  var mat=data.matrix;var days=data.meta&&data.meta.days||[];var dm=data.meta&&data.meta.day_meta||[];
  var mCnt=getHeatmapModems(ctx),mDiv=mCnt||1;
  var val=mat[di][hr]||0;
  var DAYS_RU=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  var ds=days[di]||'';var d=new Date(ds+'T00:00:00');
  var dn=DAYS_RU[d.getDay()]||(dm[di]&&dm[di].label)||'';
  var dShort=fmtDateRuLong(ds);
  var hrEnd=String((hr+1)%24).padStart(2,'0');

  var tt=document.getElementById(ctx.ttId);
  if(!tt){tt=document.createElement('div');tt.id=ctx.ttId;tt.className='float-tt';tt.style.cssText='position:fixed;z-index:9999;pointer-events:none;background:#fff;border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:170px;box-shadow:0 4px 20px rgba(0,0,0,0.09)';document.body.appendChild(tt);}

  if(val<0.01){
    tt.innerHTML='<div style="font-size:11px;color:#9b9b98;margin-bottom:5px">'+dn+', '+dShort+' · '+String(hr).padStart(2,'0')+':00–'+hrEnd+':00</div>'
      +'<div style="font-size:20px;font-weight:500;color:#1a1a1a;line-height:1">—</div>'
      +'<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:8px 0"></div>'
      +'<div style="font-size:11px;color:#9b9b98;font-style:italic">Нет трафика</div>';
  } else {
    // Per-operator breakdown (scoped to current view). Counts AND bytes both come
    // from the same historical hour, so the tooltip is internally consistent:
    // the modem counts sum to the active-modem total used for "на модем", and the
    // per-operator GB sum to the cell total. Modems with an unresolved carrier are
    // shown under "Неизвестный" — never silently dropped from the count.
    var ops=(data.operator_breakdown&&data.operator_breakdown[di])?data.operator_breakdown[di][hr]:null;
    var histModems=0;
    if(ops){for(var _ok in ops){histModems+=((ops[_ok]&&ops[_ok].modems)||0);}}
    var mDivH=histModems||mDiv;
    var perModem=val/mDivH;

    tt.innerHTML='<div style="font-size:11px;color:#9b9b98;margin-bottom:5px">'+dn+', '+dShort+' · '+String(hr).padStart(2,'0')+':00–'+hrEnd+':00</div>'
      +'<div style="font-size:20px;font-weight:500;color:#1a1a1a;line-height:1">'+trendFmt(perModem)+' <span style="font-size:11px;font-weight:400;color:#9b9b98">на модем</span></div>';
    if(ops){
      var opArr=Object.keys(ops).map(function(k){var o=ops[k]||{};var m=o.modems||1;return{name:k,gb:(o.gb||0)/m,modems:o.modems||0,total:o.gb||0};}).filter(function(o){return o.total>0.0001;});
      if(opArr.length>0){
        // Фиксированный алфавитный порядок — операторы не «прыгают» между часами.
        opArr.sort(function(a,b){return a.name.localeCompare(b.name,'ru');});
        tt.innerHTML+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>';
        opArr.forEach(function(o){
          tt.innerHTML+='<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:2px 0"><span style="font-size:11px;color:#9b9b98">'+esc(o.name)+' <span style="font-size:9px">('+o.modems+')</span></span><span style="font-size:12px;font-weight:500;color:#1a1a1a">'+trendFmt(o.gb)+'</span></div>';
        });
      }
    }
    tt.innerHTML+='<div style="height:0.5px;background:rgba(0,0,0,0.08);margin:6px 0"></div>'
      +'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:2px 0"><span style="font-size:11px;color:#9b9b98">Общий трафик</span><span style="font-size:12px;font-weight:500;color:#1a1a1a">'+trendFmt(val)+'</span></div>';
    // Сноска: всего модемов в выборке (у клиента) и по скольким пришли данные за этот час.
    if(mCnt>0){
      var _hm=Math.min(histModems||0,mCnt);
      tt.innerHTML+='<div style="font-size:10px;color:#9b9b98;margin-top:6px">Модемов: <b style="color:#1a1a1a;font-weight:600">'+mCnt+'</b> · с данными за час: <b style="color:#1a1a1a;font-weight:600">'+_hm+'</b></div>';
    }
    var isCorrected=data.meta&&data.meta.corrected&&data.meta.corrected[di]&&data.meta.corrected[di][hr];
    if(isCorrected)tt.innerHTML+='<div style="font-size:10px;color:var(--warning);margin-top:6px">'+icon('alert',10)+' Данные скорректированы</div>';
  }

  tt.style.display='block';tt.style.left='-9999px';tt.style.top='-9999px';
  var tw=tt.offsetWidth||200,th=tt.offsetHeight||100;
  var x=event.clientX+12,y=event.clientY-20;
  if(x+tw+8>window.innerWidth)x=event.clientX-tw-12;
  if(y+th+8>window.innerHeight)y=event.clientY-th-8;
  if(x<4)x=4;if(y<4)y=4;
  tt.style.left=x+'px';tt.style.top=y+'px';
}

// Stage 18.14: render all latency values in seconds (user preference — easier
// to compare across the 0.05 c … 15 c range than mixing 591 мс and 2.9 с).
// Smart decimals: <0.1 c keeps 3 places so sub-100 мс is still legible.
function fmtMs(ms){
  if(ms==null)return'—';
  var s=ms/1000;
  if(s<0.1)return s.toFixed(3)+' с';
  if(s<10) return s.toFixed(2)+' с';
  return s.toFixed(1)+' с';
}
var _MONTHS_RU_NOM=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var _MONTHS_RU_SHORT=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
// «2026-03» → «Март» (или «Мар» при short). Возвращает исходную строку, если формат иной.
function _ymRu(ym,short){ if(ym==null)return ''; var s=String(ym); var m=/^(\d{4})-(\d{2})/.exec(s); if(!m)return s; var mi=parseInt(m[2],10)-1; return (short?_MONTHS_RU_SHORT:_MONTHS_RU_NOM)[mi]||s; }

// ========== C1 (23.08): SLA/uptime-отчёт ==========
var _slaMonth='';
// Дефолт месяца — текущий; вызывается при входе в раздел.
function initSlaReport(){
  var inp=document.getElementById('slaMonthInput');
  if(inp&&!inp.value){
    var d=new Date();
    inp.value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  }
  _slaMonth=inp?inp.value:'';
  if(_slaMonth)loadSlaReport();
}
function _slaPctCell(p){
  if(p==null)return '—';
  var c=p>=99.9?'var(--success)':p>=99?'var(--text-1)':p>=95?'var(--warning)':'var(--danger)';
  return '<span style="color:'+c+';font-weight:600">'+String(p).replace('.',',')+'%</span>';
}
function loadSlaReport(){
  var inp=document.getElementById('slaMonthInput');
  var area=document.getElementById('slaReportArea');
  if(!inp||!area)return;
  var month=inp.value;
  if(!/^\d{4}-\d{2}$/.test(month)){area.innerHTML='<div style="color:var(--danger);font-size:12px">Выберите месяц</div>';return}
  _slaMonth=month;
  area.innerHTML='<div style="color:var(--text-3);font-size:12px">Строю отчёт…</div>';
  api(API+'/api/admin/sla_report?month='+encodeURIComponent(month)).then(function(d){
    if(d.error){area.innerHTML='<div style="color:var(--danger);font-size:12px">'+esc(d.error)+'</div>';return}
    var h='<div style="font-size:11px;color:var(--text-3);margin-bottom:10px">Месяц: '+esc(d.month)+' ('+(d.minutes_in_month||0).toLocaleString('ru-RU')+' мин) · сформирован '+esc(new Date(d.generated_at).toLocaleString('ru-RU'))+'</div>';
    // Серверы
    h+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin:10px 0 6px">Серверы</div>';
    if(!d.servers||!d.servers.length){
      h+='<div style="font-size:11px;color:var(--success)">Простоев за месяц не зафиксировано — все серверы 100%.</div>';
    }else{
      h+='<table class="log-table"><thead><tr><th>Сервер</th><th>Uptime</th><th>Эпизоды</th><th>Простой, мин</th><th>Обслуживание, мин</th></tr></thead><tbody>';
      d.servers.forEach(function(s){
        h+='<tr><td style="font-family:var(--font-mono);font-weight:600">'+esc(_serverDisplayLabel(s.server))+'</td><td>'+_slaPctCell(s.uptime_pct)+'</td><td>'+s.episodes+'</td><td>'+String(s.downtime_min).replace('.',',')+'</td><td style="color:var(--text-3)">'+String(s.maintenance_min).replace('.',',')+'</td></tr>';
      });
      h+='</tbody></table>';
    }
    // Операторы
    if(d.operators&&d.operators.length){
      h+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin:14px 0 6px">По операторам (средний uptime модемов)</div>';
      h+='<table class="log-table"><thead><tr><th>Оператор</th><th>Uptime</th><th>Модемов</th></tr></thead><tbody>';
      d.operators.forEach(function(o){
        h+='<tr><td>'+esc(o.operator)+'</td><td>'+_slaPctCell(o.uptime_pct)+'</td><td>'+o.modems+'</td></tr>';
      });
      h+='</tbody></table>';
    }
    // Модемы
    h+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin:14px 0 6px">Модемы (минутные проверки доступности)</div>';
    if(!d.modems||!d.modems.length){
      h+='<div style="font-size:11px;color:var(--text-3)">За выбранный месяц нет периодических проверок доступности.</div>';
    }else{
      h+='<div style="max-height:420px;overflow-y:auto"><table class="log-table"><thead><tr><th>Модем</th><th>Сервер</th><th>Оператор</th><th>Uptime</th><th>Проверок</th></tr></thead><tbody>';
      d.modems.forEach(function(m){
        h+='<tr><td style="font-family:var(--font-mono)">'+esc(m.nick)+'</td><td>'+esc(_serverDisplayLabel(m.server))+'</td><td style="color:var(--text-2)">'+esc(m.operator||'—')+'</td><td>'+_slaPctCell(m.uptime_pct)+'</td><td>'+m.checks+'</td></tr>';
      });
      h+='</tbody></table></div>';
    }
    area.innerHTML=h;
  }).catch(function(e){area.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>'});
}
// CSV идёт с auth-заголовком — простая ссылка не подходит, качаем через fetch→Blob.
function slaExportCsv(){
  var month=_slaMonth||((document.getElementById('slaMonthInput')||{}).value||'');
  if(!month){showToast('Сначала постройте отчёт за месяц','error');return}
  fetch(API+'/api/admin/sla_report?month='+encodeURIComponent(month)+'&format=csv',{headers:{'X-Auth-Token':authToken}})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob()})
    .then(function(blob){
      var a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download='sla-'+month+'.csv';
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(function(){URL.revokeObjectURL(a.href)},5000);
      showToast('CSV сохранён','success');
    }).catch(function(e){showToast('Экспорт: '+e.message,'error')});
}
