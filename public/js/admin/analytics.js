// public/js/admin/analytics.js — analytics tab (WP6.3 carve-out from admin.js,
// VERBATIM): category card, trend/heatmap/latency charts, traffic matrix,
// top resources. Classic script, shared global scope.

function chartExtTooltip(context){
  var tt=context.tooltip;
  var el=document.getElementById('chartExtTT');
  if(!el){
    el=document.createElement('div');el.id='chartExtTT';
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

function switchAccTab(name,el){
  document.querySelectorAll('.acc-sub-tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.acc-sub-content').forEach(function(t){t.classList.remove('active')});
  if(el)el.classList.add('active');
  var content=document.getElementById('acc-'+name);
  if(content)content.classList.add('active');
  // Stage 18.23 — ⚡ NEW lives parallel; route to its own renderer.
  if(name === 'new'){ try { renderAccNew(); } catch(e) { console.error(e); } return; }
  renderAccSubTab(name);
}

function setAccPeriod(p,el){
  accPeriod=p;
  window._dailyTrafficCache=null;window._spkData=null; // reset caches so chart reloads fresh
  document.querySelectorAll('.acc-period-btn').forEach(function(b){b.classList.remove('active')});
  if(el)el.classList.add('active');
  renderTrafficTab();
}

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
  var accClientFilter=(document.getElementById('accClientFilter')||{}).value||'';
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
      if(accClientFilter&&pn!==accClientFilter)continue;
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

function renderHBars(items,maxVal,colorClass){
  if(!items.length)return'<div style="color:var(--text-3);padding:10px;font-size:11px">Нет данных</div>';
  var h='<ul class="hbar-list">';
  items.forEach(function(item,i){
    h+='<li class="hbar-item"><span class="hbar-rank">'+(i+1)+'</span><span class="hbar-label" title="'+esc(item.label)+'">'+esc(item.label)+'</span><div class="hbar-bar-wrap"><div class="hbar-bar '+(item.color||colorClass||'blue')+'" style="width:'+pct(item.value,maxVal)+'%"></div></div><span class="hbar-value">'+fmtGbShort(item.value)+'</span></li>';
  });
  return h+'</ul>';
}

function populateAccClientFilter(){
  var sel=document.getElementById('accClientFilter');
  if(!sel||!currentData)return;
  var prev=sel.value;
  var cls=currentData.clients||[];
  var h='<option value="">Все клиенты</option>';
  cls.filter(function(c){return c.modemCount>0}).forEach(function(c){
    h+='<option value="'+esc(c.portName)+'">'+esc(c.name)+' ('+esc(c.portName)+')</option>';
  });
  sel.innerHTML=h;
  if(prev)sel.value=prev;
  // Also populate resClientFilter on resources tab
  var resSel=document.getElementById('resClientFilter');
  if(resSel){
    var resPrev=resSel.value;
    var rh='<option value="">Все клиенты</option>';
    cls.filter(function(c){return c.modemCount>0}).forEach(function(c){
      rh+='<option value="'+esc(c.portName)+'">'+esc(c.name)+'</option>';
    });
    resSel.innerHTML=rh;
    if(resPrev)resSel.value=resPrev;
  }
}

function renderTrafficTab(){
  var d=collectTrafficData();if(!d)return;
  // Top metric widgets removed (Task 1) — keep div empty. (WP1: the dead
  // summary computations that used to live here — avg/forecast/top-client/
  // online/revenue — were deleted with the div; the modem counters on this
  // page come from currentData.fleet, like everywhere else.)
  var twEl=document.getElementById('trafficWidgets');if(twEl)twEl.innerHTML='';

  // Render active sub-tab
  var activeSubTab=document.querySelector('.acc-sub-tab.active');
  var tabName=activeSubTab?activeSubTab.textContent.trim().split(' ')[0]:'Обзор';
  // find which tab is active
  var activeSub=document.querySelector('.acc-sub-content.active');
  if(activeSub)renderAccSubTab(activeSub.id.replace('acc-',''));
}

function getDaysElapsed(){
  if(accPeriod==='month')return new Date().getDate()||1;
  if(accPeriod==='yesterday')return 1;
  if(accPeriod==='day')return 1;
  if(accPeriod==='prevmonth'){var prev=new Date();prev.setDate(0);return prev.getDate()||30}
  if(accPeriod==='lifetime')return 30;
  return 1;
}
function renderAccSubTab(name){
  var d=collectTrafficData();if(!d)return;
  var cc=getChartColors();
  var chartOpts=function(stacked){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:cc.text,font:{size:11}}}},scales:{x:{stacked:!!stacked,ticks:{color:cc.text,font:{size:10}},grid:{color:cc.grid}},y:{stacked:!!stacked,ticks:{color:cc.text,font:{size:10}},grid:{color:cc.grid}}}}};

  if(name==='overview'){
    // Task 1: Clear top metric widgets
    var twEl=document.getElementById('trafficWidgets');if(twEl)twEl.innerHTML='';

    // Extended widgets: Аномалии (inline), Рекорды, Тренд (redesigned)
    var extRow=document.getElementById('extendedWidgetsRow');
    if(extRow){
      // --- Real-time issues from _modemMap (with details) ---
      var mm=currentData._modemMap||{};
      var rtOffline=[],rtLowSpeed=[],rtStuckIp=[];
      function _ageLabel(ms){
        if(!ms)return '';
        var ageMs=Date.now()-ms;
        if(ageMs<60000)return 'только что';
        var mins=Math.floor(ageMs/60000);
        if(mins<60)return mins+' мин назад';
        if(mins<1440)return Math.floor(mins/60)+' ч назад';
        return Math.floor(mins/1440)+' д назад';
      }
      // Stage 18.10: модемы которые перешли порог stale (>N часов offline,
      // настройка stale_modem_hours, default 12) НЕ показываются в карточке
      // «Отключённые». Они считаются «давно умершими» — оператору их видеть
      // среди свежих проблем бесполезно. Они остаются в общей таблице модемов
      // с пометкой OFFLINE без time-badge.
      var STALE_MS_OVERVIEW = ((window._staleModemHours || 12)) * 3600 * 1000;
      Object.values(mm).forEach(function(m){
        var st=getModemStatus(m);
        if(st==='offline'){
          var isStale = !m.lastSeenMs || (Date.now() - m.lastSeenMs > STALE_MS_OVERVIEW);
          if(isStale) return;  // skip stale modems from "Модем отключен" card
          var age=_ageLabel(m.lastSeenMs);
          rtOffline.push({nick:m.nick,server:m.server,detail:age?'Отключён '+age:'Статус: offline',lastSeenMs:m.lastSeenMs||0});
        }
        if(m.lowSpeed)rtLowSpeed.push({nick:m.nick,server:m.server,detail:'↓'+Number(m.lastSpeedDl||0).toFixed(1)+' / ↑'+Number(m.lastSpeedUl||0).toFixed(1)+' Mbps'});
        if(m.ipStuck)rtStuckIp.push({nick:m.nick,server:m.server,detail:'IP не менялся '+m.ipSinceHours+'ч · '+esc(m.extIp||'')});
      });
      // The «Модем отключен» count/list now come from the coherent fleet model
      // (consistent with the «X/Y» header): a modem online within 48h but not
      // online now. This replaces the old live-_modemMap list that hid modems
      // offline >12h, which caused «84 online / 0 offline» to disagree.
      // «Модем отключен» = модемы, которые молчат уже >10 мин (disconnectedList).
      // Кратковременный мигающий офлайн (один пропущенный опрос) сюда не попадает —
      // это тот же порог, на котором уходит уведомление в телегу/колокольчик.
      var _offSrc = (currentData.fleet && (currentData.fleet.disconnectedList || currentData.fleet.offlineList)) || null;
      if (Array.isArray(_offSrc)) {
        rtOffline = _offSrc.map(function(o){
          var age=o.lastOnline?_ageLabel(o.lastOnline):'';
          return {nick:o.nick,server:o.server,detail:age?('Отключён '+age):'offline',lastSeenMs:o.lastOnline||0};
        });
      }
      // Sort offline list: most recently disconnected first.
      rtOffline.sort(function(a,b){return (Number(b.lastSeenMs)||0) - (Number(a.lastSeenMs)||0);});

      // --- "Сбоит прокси": приходит уже посчитанным с сервера (latency/error/rotation) ---
      var flakyItems = (currentData.proxyIssues || []).map(function(it){
        return { nick: it.nick, server: it.server, detail: it.detail, _meta: it };
      });

      // Store globally for popup access
      window._problemData={offline:rtOffline,speed:rtLowSpeed,ipstuck:rtStuckIp,flaky:flakyItems};

      // --- Build problems card (2×2 grid) ---
      var anomH='<div class="analytics-card" style="margin:0;overflow:hidden">';
      anomH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px;flex-shrink:0">🔧 Проблемы инфраструктуры</div>';
      function probItem(label,key,items,dotColor){
        var n=items.length;var bg=n===0?'var(--green-bg)':dotColor==='var(--danger)'?'var(--red-bg)':'var(--orange-bg)';
        var valColor=n===0?'var(--success)':dotColor==='var(--danger)'?'var(--danger)':'var(--warning)';
        var r='<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;background:'+bg+';font-size:11px'+(n>0?';cursor:pointer':'')+'"'+(n>0?' onclick="showProblemPopup(\''+esc(label)+'\',\''+key+'\')"':'')+' >';
        r+='<span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:'+(n===0?'var(--success)':dotColor)+'"></span>';
        r+='<span style="flex:1;color:var(--text-2)">'+label+'</span>';
        r+='<span style="font-weight:600;color:'+valColor+'">'+n+'</span>';
        r+='</div>';return r;
      }
      anomH+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;flex:1">';
      anomH+=probItem('Модем отключен','offline',rtOffline,'var(--danger)');
      anomH+=probItem('Низкая скорость','speed',rtLowSpeed,'var(--warning)');
      anomH+=probItem('Завис IP','ipstuck',rtStuckIp,'var(--warning)');
      anomH+=probItem('Сбоит прокси','flaky',flakyItems,'var(--danger)');
      anomH+='</div>';
      anomH+='</div>';

      // --- Ресурсы по категориям (TOP 4) ---
      var recH='<div class="analytics-card" style="margin:0"><div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px;flex-shrink:0">🌐 Ресурсы по категориям</div><div id="analyticsCatBars"><div style="color:var(--text-3);font-size:11px;padding:4px 0">Загрузка...</div></div></div>';

      // --- Тренд месяца (6-bar vertical chart, data from API) ---
      var trendH='<div class="analytics-card" style="margin:0;display:flex;flex-direction:column">';
      trendH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:10px;flex-shrink:0">📈 Тренд</div>';
      trendH+='<div id="trendBarsWrap" style="display:flex;align-items:flex-end;gap:4px;flex:1;min-height:40px;margin-bottom:4px">';
      trendH+='<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:9px">...</div>';
      trendH+='</div>';
      trendH+='<div id="trendLabelsWrap" style="display:flex;gap:2px;margin-bottom:4px"></div>';
      trendH+='</div>';

      // Operators card
      var allOps={};
      Object.keys(d.serverOpTraffic).forEach(function(s){
        Object.keys(d.serverOpTraffic[s]).forEach(function(op){
          if(!op)return;
          if(!allOps[op])allOps[op]={t:0,cnt:0};
          var v=d.serverOpTraffic[s][op];
          allOps[op].t+=v.tIn+v.tOut;
          allOps[op].cnt+=v.count;
        });
      });
      var opDays=getDaysElapsed();
      var opList=Object.keys(allOps).sort(function(a,b){return allOps[b].t-allOps[a].t});
      var opMax=opList.length?(allOps[opList[0]].t/opDays)||1:1;
      var opH='<div class="analytics-card" style="margin:0">';
      opH+='<div style="font-size:12px;font-weight:600;color:var(--text-0);margin-bottom:8px">📡 Операторы</div>';
      opList.forEach(function(op,oi){
        var v=allOps[op];
        var flag='';var opL=op.toLowerCase();
        if(opL.indexOf('orange ro')!==-1||opL.indexOf('vodafone ro')!==-1)flag='🇷🇴 ';
        else if(opL.indexOf('orange md')!==-1||opL.indexOf('moldtelecom')!==-1)flag='🇲🇩 ';
        var avg_per_modem_day=fmtGb(v.cnt&&opDays?v.t/v.cnt/opDays:0);
        var total_per_day=v.t/opDays;
        var w=Math.max(total_per_day/opMax*100,2);
        var col=CHART_COLORS.operators[oi%CHART_COLORS.operators.length];
        var opTotalGb=fmtGb(v.t);
        var opTotalDay=fmtGb(total_per_day);
        var opEsc=op.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        opH+='<div style="margin-bottom:8px;cursor:pointer" onmouseenter="showOpTT(\''+opEsc+'\',\''+opTotalGb+'\',\''+opTotalDay+'\',\''+avg_per_modem_day+'\','+v.cnt+',event)" onmouseleave="hideFloatTooltip(\'opTT\')">';
        opH+='<div style="display:flex;align-items:baseline;font-size:10px;margin-bottom:2px;gap:4px">';
        opH+='<span style="flex:1;color:var(--text-1);font-weight:500">'+flag+esc(op)+'</span>';
        opH+='<span style="color:var(--text-2)">'+avg_per_modem_day+'/мод/сут</span>';
        opH+='<span style="color:var(--text-3)">·</span>';
        opH+='<span style="color:var(--text-3)">'+v.cnt+' мод.</span>';
        opH+='</div>';
        opH+='<div style="height:4px;background:var(--bg-3);border-radius:2px"><div style="height:4px;border-radius:2px;background:'+col+';width:'+w+'%"></div></div>';
        opH+='</div>';
      });
      opH+='</div>';

      // 4 cards: anomaly, resources-by-category, trend, operators
      extRow.style.gridTemplateColumns='repeat(4,1fr)';extRow.style.alignItems='stretch';
      extRow.innerHTML=anomH+recH+trendH+opH;
      loadTrendData();
      loadAnalyticsCategoryCard();
    }

    // Matrix
    renderTrafficMatrix(d);

    // Client table (flex layout with sparkline + trend)
    var clientNamesOv=Object.keys(d.clientTraffic).filter(function(n){return d.clientTraffic[n].modems>0}).sort(function(a,b){return(d.clientTraffic[b].tIn+d.clientTraffic[b].tOut)-(d.clientTraffic[a].tIn+d.clientTraffic[a].tOut)});
    var totalAllOv=d.totalIn+d.totalOut||1;
    var daysEl=getDaysElapsed();
    // Header row — flex proportional columns filling full width
    var hc='<div class="ct-header" style="display:flex;align-items:center;padding:4px 0;border-bottom:2px solid var(--border);font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">';
    hc+='<div style="width:4px;flex-shrink:0"></div>';
    hc+='<div style="flex:2.2;padding:0 10px;min-width:0">Клиент</div>';
    hc+='<div style="flex:0.7;text-align:center">Live</div>';
    hc+='<div style="flex:1;text-align:center">Посл.час</div>';
    hc+='<div style="flex:1;text-align:center">Сегодня</div>';
    hc+='<div style="flex:1;text-align:center">Вчера</div>';
    hc+='<div style="flex:1;text-align:center;font-weight:600">Месяц</div>';
    hc+='<div style="flex:1;text-align:center">Пр.месяц</div>';
    hc+='<div style="flex:0.9;text-align:center">14 дней</div>';
    hc+='<div style="flex:0.9;text-align:center">Тренд</div>';
    hc+='</div>';
    clientNamesOv.forEach(function(n,i){
      var c=d.clientTraffic[n];var total=c.tIn+c.tOut;
      var liveColor=c.online===c.modems?'var(--success)':(c.online>0?'var(--warning)':'var(--danger)');
      var clientColor=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
      var sharePct=pct(total,totalAllOv);
      // Compute today, yesterday, month from modemTraffic
      var clientModems=d.modemTraffic.filter(function(m){return m.pn===n});
      var todayBytes=clientModems.reduce(function(s,m){return s+(m.dayIn||0)+(m.dayOut||0)},0);
      var clientObj=(currentData.clients||[]).find(function(cl){return cl.portName===n});
      var lhGb=clientObj?((currentData.clientLastHourGb||{})[clientObj.id]||0):0;
      var lhStr=lhGb>0?(lhGb>=1?lhGb.toFixed(2)+' GB':Math.round(lhGb*1024)+' MB'):'—';
      var yestBytes=clientModems.reduce(function(s,m){return s+(m.yestIn||0)+(m.yestOut||0)},0);
      var monBytes=clientModems.reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
      var prevMonBytes=clientModems.reduce(function(s,m){return s+(m.prevIn||0)+(m.prevOut||0)},0);
      // Trend: first N days this month vs first N days prev month (from server clientTrend)
      var ctVal=(currentData.clientTrend||{})[n];
      var trendStr='—';var trendColor='var(--text-3)';
      if(ctVal!==undefined&&ctVal!==null){
        var tc=ctVal>=0?'var(--success)':'var(--danger)';
        var ts=ctVal>999?'+999%+':(ctVal<-99?'<−99%':(ctVal>=0?'+':'')+ctVal+'%');
        trendStr=ts;trendColor=tc;
      }
      // Sparkline: 14 bars from real daily cache data
      var spkDays=14,spkPts=[],spkDates=[];
      var spkNow=new Date();
      for(var di=spkDays-1;di>=0;di--){
        var spkD=new Date(spkNow);spkD.setDate(spkD.getDate()-di);
        var spkDs=spkD.getFullYear()+'-'+String(spkD.getMonth()+1).padStart(2,'0')+'-'+String(spkD.getDate()).padStart(2,'0');
        var spkEntry=window._dailyTrafficCache&&window._dailyTrafficCache[n]&&typeof window._dailyTrafficCache[n]==='object'&&window._dailyTrafficCache[n][spkDs];
        spkPts.push(spkEntry?((spkEntry.in||0)+(spkEntry.out||0)):0);
        spkDates.push(spkDs);
      }
      window._spkData=window._spkData||{};
      window._spkData[n]={dates:spkDates,pts:spkPts};
      var spkMax=Math.max.apply(null,spkPts)||1;
      var spkBarW=4;
      var spkClientKey=n.replace(/'/g,"\\'");
      var sparkH='<div style="display:inline-flex;align-items:flex-end;gap:1px;height:16px;width:'+(spkBarW*spkDays+spkDays-1)+'px;flex-shrink:0;vertical-align:middle">';
      for(var si=0;si<spkDays;si++){
        var hPx=spkPts[si]>0?Math.max(Math.round(spkPts[si]/spkMax*14),2):1;
        var isToday=si===spkDays-1;
        sparkH+='<div style="width:'+spkBarW+'px;height:'+hPx+'px;background:'+clientColor+';border-radius:1px 1px 0 0;opacity:'+(isToday?'1':'0.5')+';cursor:pointer"';
        sparkH+=' onmouseenter="showSpkTT(\''+spkClientKey+'\','+si+',event)" onmouseleave="hideFloatTooltip(\'spkTT\')"></div>';
      }
      sparkH+='</div>';
      hc+='<div class="ct-row" data-client="'+esc(n)+'" onclick="selectClient(\''+esc(n)+'\')">';
      hc+='<div class="ct-color" style="width:4px;height:36px;background:'+clientColor+';flex-shrink:0;border-radius:2px 0 0 2px"></div>';
      hc+='<div class="ct-name" style="flex:2.2;padding:0 10px;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">'+esc(n)+'</div>';
      hc+='<div class="ct-live" style="flex:0.7;text-align:center;font-size:11px;font-weight:600;color:'+liveColor+'">'+c.online+'/'+c.modems+'</div>';
      hc+='<div class="ct-metrics" style="display:contents">';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;font-family:var(--font-mono);color:'+(lhGb>0?'var(--text-0)':'var(--text-3)')+'"><span class="ct-metric-label">Посл.час</span><span class="ct-metric-value">'+lhStr+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;font-family:var(--font-mono)"><span class="ct-metric-label">Сегодня</span><span class="ct-metric-value">'+fmtGb(todayBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;color:var(--text-2);font-family:var(--font-mono)"><span class="ct-metric-label">Вчера</span><span class="ct-metric-value">'+fmtGb(yestBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:12px;font-weight:500;font-family:var(--font-mono)"><span class="ct-metric-label">Месяц</span><span class="ct-metric-value">'+fmtGb(monBytes)+'</span></div>';
      hc+='<div class="ct-metric" style="flex:1;text-align:center;font-size:11px;color:var(--text-2);font-family:var(--font-mono)"><span class="ct-metric-label">Пр.месяц</span><span class="ct-metric-value">'+fmtGb(prevMonBytes)+'</span></div>';
      hc+='<div class="ct-metric ct-trend-mobile" style="display:none"><span class="ct-metric-label">Тренд</span><span class="ct-metric-value" style="color:'+trendColor+'">'+trendStr+'</span></div>';
      hc+='</div>';
      hc+='<div class="ct-sparkline" style="flex:0.9;display:flex;align-items:center;justify-content:center">';
      hc+=sparkH;
      hc+='</div>';
      hc+='<div class="ct-trend" style="flex:0.9;text-align:center;font-size:10px;font-weight:600;color:'+trendColor+'">'+trendStr+'</div>';
      // share % removed
      hc+='</div>';
    });
    var ctEl=document.getElementById('clientTrafficTable');
    if(ctEl)ctEl.innerHTML=hc;

    // Anomaly data is shown in the "⚠ Проблемы" card — no separate block needed

    // Daily chart
    var chartEl=document.getElementById('chartDailyClientTraffic');
    if(!chartEl)return;
    if(!window._dailyTrafficCache){
      chartEl.parentElement.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:12px">Загрузка графика...</div>';
      api(API+'/api/admin/daily_traffic')
        .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
        .then(function(data){
          window._dailyTrafficCache=data;
          // restore canvas
          var wrap=document.querySelector('#acc-overview .chart-wrap-daily');
          if(wrap){wrap.innerHTML='<canvas id="chartDailyClientTraffic"></canvas>';}
          renderDailyClientChart(data,cc);
          // re-render client table now that cache is available (sparklines use real data)
          var activeSub=document.querySelector('.acc-sub-tab.active');
          if(activeSub&&activeSub.id.replace('acc-tab-','').replace('acc-','')!=='resources')renderAccSubTab('overview');
        })
        .catch(function(e){
          var w=document.querySelector('#acc-overview .chart-wrap-daily');
          if(w)w.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);font-size:12px">Ошибка загрузки графика: '+(esc(e.message))+'</div>';
        });
    } else {renderDailyClientChart(window._dailyTrafficCache,cc);}
    // Init heatmap once on first overview load
    if(!window._heatmapInitialized){
      window._heatmapInitialized=true;
      _heatmapConfig.client=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name,modems:c.modemCount||1}});
      renderHeatmapSubTabs();
      loadHeatmapData();
      renderLatencySubTabs();
      loadLatencyStats();
    }
    // Auto-load Top resources on first Трафик view. The aggregate endpoint
    // returns cached data (no server-side rescrape), so this is cheap.
    if (!topHostsCache) loadTopHosts();
  }
  else if(name==='infra'){
    // Combined «Инфраструктура» — Rotations + IP analytics + Capacity stacked.
    renderSysRotations('acc-infra-rotations', 'sysInfraDays');
    renderSysIp('acc-infra-ip', 'sysInfraDays');
    renderSysCapacity('acc-infra-capacity', 'sysInfraDays');
  }
  else if(name==='finances'){
    renderFinancesTab(d);
  }
}


// ==================== RESOURCES BY CATEGORY CARD ====================
var _topHostsCacheGlobal=null;
function loadAnalyticsCategoryCard(elId){
  elId=elId||'analyticsCatBars';
  var el=document.getElementById(elId);
  if(!el)return;
  if(_topHostsCacheGlobal){renderAnalyticsCategoryCard(_topHostsCacheGlobal,el);return;}
  api(API+'/api/admin/top_hosts_aggregated')
    .then(function(d){_topHostsCacheGlobal=d.data||{};renderAnalyticsCategoryCard(_topHostsCacheGlobal,el);})
    .catch(function(){var el2=document.getElementById(elId);if(el2)el2.innerHTML='<div style="color:var(--text-3);font-size:11px">Нет данных</div>';});
}
var _catIcons={'Социальные сети':'👥','Поисковики':'🔍','Видео':'🎬','Мессенджеры':'💬','CDN/Облако':'☁️','Реклама':'📢','Почта':'📧','Прочее':'📦','Маркетплейсы':'🛒','Новости':'📰','Игры':'🎮'};
function renderAnalyticsCategoryCard(data,el){
  if(!el)return;
  var cats={};
  Object.keys(data).forEach(function(h){var cat=categorize(h);if(!cats[cat])cats[cat]=0;cats[cat]+=data[h]});
  var catList=Object.keys(cats).sort(function(a,b){return cats[b]-cats[a]}).slice(0,4);
  if(!catList.length){el.innerHTML='<div style="color:var(--text-3);font-size:11px">Нет данных</div>';return;}
  var total=catList.reduce(function(s,c){return s+cats[c]},0)||1;
  var h='';
  catList.forEach(function(cat){
    var cnt=cats[cat],p=Math.round(cnt/total*100);
    var col=CHART_COLORS.categories[cat]||'#B4B2A9';
    var icon=_catIcons[cat]||'📁';
    h+='<div style="margin-bottom:7px">';
    h+='<div style="display:flex;align-items:baseline;margin-bottom:2px;font-size:11px">';
    h+='<span style="flex:1;color:var(--text-0)">'+icon+' '+esc(cat)+'</span>';
    h+='<span style="font-size:10px;color:var(--text-2);font-weight:500">'+p+'%</span>';
    h+='</div>';
    h+='<div style="height:5px;background:var(--bg-3);border-radius:2px"><div style="height:5px;border-radius:2px;background:'+col+';width:'+p+'%"></div></div>';
    h+='</div>';
  });
  el.innerHTML=h;
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
function pluralPort(n){var a=Math.abs(n)%100,b=a%10;if(a>10&&a<20)return n+' портов';if(b>1&&b<5)return n+' порта';if(b===1)return n+' порт';return n+' портов';}
var _MSK_OFFSET=3;
function fmtHourMsk(hr){return String((hr+_MSK_OFFSET)%24).padStart(2,'0')+':00';}
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
    bH+=' onmouseenter="onTrendHover('+i+',event)" onmouseleave="onTrendLeave()">';
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
  if(!tt){tt=document.createElement('div');tt.id=id;tt.style.cssText='position:fixed;z-index:9999;background:var(--bg-0);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:130px;line-height:1.6';document.body.appendChild(tt);}
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
function showSpkTT(clientKey,idx,event){
  var d=window._spkData&&window._spkData[clientKey];
  if(!d)return;
  var dateStr=d.dates[idx]||'';
  var bytes=d.pts[idx]||0;
  var isToday=idx===d.dates.length-1;
  var label=isToday?'Сегодня':fmtDateRuLong(dateStr);
  var lines=['<b>'+label+'</b>',fmtGb(bytes)+(bytes?'':' — нет данных')];
  showFloatTooltip('spkTT',event,lines);
}
function showOpTT(op,total,perDay,perModem,cnt,event){
  var lines=['<b>'+op+'</b>','Всего: '+total,'В сутки: '+perDay,'На модем/сутки: '+perModem,'Модемов: '+cnt];
  showFloatTooltip('opTT',event,lines);
}

// ==================== HEATMAP ====================
var _heatmapView='country',_heatmapId='all',_heatmapCache={};
var _newHmCache={};
// Контексты тепловой карты: «Трафик» (по умолчанию) и NEW. Обе вкладки рендерятся
// ОДНИМ кодом (renderHeatmap/renderHeatmapSubTabs/...); ctx подменяет только
// состояние (view/id/cache) и DOM-id — поэтому NEW = 1:1 со страницей «Трафик».
var _hmTraffic={get view(){return _heatmapView;},set view(v){_heatmapView=v;},get id(){return _heatmapId;},set id(v){_heatmapId=v;},cache:_heatmapCache,grid:'heatmapGrid',summary:'heatmapSummary',subtabs:'heatmapSubTabs',tabPrefix:'hmTab',tabClass:false,ttId:'heatTT',dataKey:'_heatmapData',self:''};
var _hmNew={get view(){return _newHmView;},set view(v){_newHmView=v;},get id(){return _newHmId;},set id(v){_newHmId=v;},cache:_newHmCache,grid:'newHmGrid',summary:'newHmSummary',subtabs:'newHmSubTabs',tabPrefix:'newHmTab',tabClass:true,ttId:'newHeatTT',dataKey:'_newHeatmapData',self:'_hmNew'};
// Stage 17 — `operator` list is now built DYNAMICALLY from
// /api/admin/operators (see refreshOperatorList() at end of file). Hardcoded
// fallback below is used only during first paint, before the API answers,
// and gets replaced as soon as the list arrives. This way new operators like
// digi appear in the dropdown automatically without an admin.js edit.
var _heatmapConfig={
  country:[{id:'all',label:'🌍 Все страны',modems:51},{id:'moldova',label:'🇲🇩 Молдова',modems:28},{id:'romania',label:'🇷🇴 Румыния',modems:23}],
  operator:[{id:'orange_ro',label:'🇷🇴 Orange RO',modems:6},{id:'vodafone_ro',label:'🇷🇴 Vodafone RO',modems:17},{id:'moldtelecom',label:'🇲🇩 Moldtelecom',modems:23},{id:'orange_md',label:'🇲🇩 Orange MD',modems:5}],
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
  ctx=ctx||_hmTraffic;
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
  ctx=ctx||_hmTraffic;
  var c=document.getElementById(ctx.subtabs);if(!c)return;
  var view=ctx.view;
  var cfg=view==='client'?(currentData&&currentData.clients||[]).filter(function(x){return x.modemCount>0}).map(function(x){return{id:x.portName,label:x.name,modems:x.modemCount||1};}):(_heatmapConfig[view]||[]);
  var h='';
  cfg.forEach(function(item){
    var active=item.id===ctx.id;var col=hmAccent(view,item.id);
    // По макету чипы — чистый текст, без флагов/глобуса из конфига
    var lbl=String(item.label||'').replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}☀-➿]/gu,'').trim();
    h+='<button onclick="selectHeatId(\''+esc(item.id)+'\''+(ctx.self?','+ctx.self:'')+')" style="background:'+(active?col:'var(--bg-3)')+';color:'+(active?'#fff':'var(--text-1)')+';border:none;border-radius:999px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:'+(active?'600':'400')+';transition:all .15s">'+esc(lbl)+'</button>';
  });
  c.innerHTML=h;
}
function selectHeatId(id,ctx){ctx=ctx||_hmTraffic;ctx.id=id;if(ctx===_hmNew)_dashUiSave({hmId:id});renderHeatmapSubTabs(ctx);loadHeatmapData(ctx);}
function loadHeatmapData(ctx){
  ctx=ctx||_hmTraffic;
  var key=ctx.view+'|'+ctx.id;
  if(ctx.cache[key]){renderHeatmap(ctx.cache[key],ctx);return;}
  var g=document.getElementById(ctx.grid);
  if(g)g.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:160px;color:var(--text-3);font-size:12px">Загрузка...</div>';
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
  ctx=ctx||_hmTraffic;
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
      h+=' onmouseenter="showHeatTT('+di+','+hr+',event,this'+(ctx.self?','+ctx.self:'')+')" onmouseleave="hideFloatTooltip(\''+ctx.ttId+'\')">';
      if(isCorrected)h+='<span style="position:absolute;top:1px;right:2px;font-size:9px;line-height:1;color:rgba(0,0,0,0.55);font-weight:600" title="Час содержит данные восстановленные после сбоя счётчика — значение приблизительное">⚠</span>';
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
  ctx=ctx||_hmTraffic;
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
      var op=(function(){var r=(m.net_details?m.net_details.CELLOP:'')||'';var isRO=srv.indexOf('S2')===0;var _c=r.toLowerCase().replace(/\s+/g,' ').trim();var n={'unite':'Moldtelecom','moldtelecom':'Moldtelecom','moldtelecom moldtelecom':'Moldtelecom','orange':isRO?'Orange RO':'Orange MD','orange ro':'Orange RO','orange md':'Orange MD','vodafone ro':'Vodafone RO','vodafone':'Vodafone RO'};return n[_c]||r})();
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
  ctx=ctx||_hmTraffic;
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
  if(!tt){tt=document.createElement('div');tt.id=ctx.ttId;tt.style.cssText='position:fixed;z-index:9999;pointer-events:none;background:#fff;border:0.5px solid rgba(0,0,0,0.13);border-radius:10px;padding:12px 14px;min-width:170px;box-shadow:0 4px 20px rgba(0,0,0,0.09)';document.body.appendChild(tt);}

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
        opArr.sort(function(a,b){return b.total-a.total;});
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
    if(isCorrected)tt.innerHTML+='<div style="font-size:10px;color:#D4880F;margin-top:6px">⚠ Данные скорректированы</div>';
  }

  tt.style.display='block';tt.style.left='-9999px';tt.style.top='-9999px';
  var tw=tt.offsetWidth||200,th=tt.offsetHeight||100;
  var x=event.clientX+12,y=event.clientY-20;
  if(x+tw+8>window.innerWidth)x=event.clientX-tw-12;
  if(y+th+8>window.innerHeight)y=event.clientY-th-8;
  if(x<4)x=4;if(y<4)y=4;
  tt.style.left=x+'px';tt.style.top=y+'px';
}

// ========== LATENCY ANALYTICS ==========
var _latencyView='country',_latencyId='all',_latencyCache={},_latencyChart=null;
function setLatencyView(view){
  _latencyView=view;
  var cfg;
  if(view==='client'){cfg=(currentData&&currentData.clients||[]).filter(function(c){return c.modemCount>0}).map(function(c){return{id:c.portName,label:c.name}});}
  else{cfg=_heatmapConfig[view]||[];}
  if(cfg.length)_latencyId=cfg[0].id;
  ['country','operator','client'].forEach(function(v){
    var btn=document.getElementById('latTab'+v.charAt(0).toUpperCase()+v.slice(1));
    if(!btn)return;var active=v===view;
    btn.style.borderBottomColor=active?'var(--accent)':'transparent';
    btn.style.color=active?'var(--accent)':'var(--text-2)';btn.style.fontWeight=active?'600':'500';
  });
  renderLatencySubTabs();if(_latencyMode==='day'){_latencyDayCache={};loadLatencyDay();}else{_latencyCache={};loadLatencyStats();}
}
function renderLatencySubTabs(){
  var c=document.getElementById('latencySubTabs');if(!c)return;
  var view=_latencyView;
  var cfg=view==='client'?(currentData&&currentData.clients||[]).filter(function(x){return x.modemCount>0}).map(function(x){return{id:x.portName,label:x.name};}):(_heatmapConfig[view]||[]);
  var h='';
  cfg.forEach(function(item){
    var active=item.id===_latencyId;var col=hmAccent(view,item.id);
    h+='<button onclick="selectLatId(\''+esc(item.id)+'\')" style="background:'+(active?col:'var(--bg-3)')+';color:'+(active?'#fff':'var(--text-1)')+';border:none;border-radius:999px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:'+(active?'600':'400')+';transition:all .15s">'+esc(item.label)+'</button>';
  });
  c.innerHTML=h;
}
function selectLatId(id){_latencyId=id;renderLatencySubTabs();loadLatencyStats();}
// Stage 18.7: fixed 30-day window (was 14, user asked to match the
// «Почасовой трафик» card style + show longer history). setLatencyDays
// stays as a no-op for any cached HTML referencing it.
var _latencyDays = 30;
function setLatencyDays(){ /* deprecated — fixed 30-day window */ }
function loadLatencyStats(){
  var key=_latencyView+'|'+_latencyId+'|'+_latencyDays;
  if(_latencyCache[key]){renderLatencyChart(_latencyCache[key]);return;}
  api(API+'/api/analytics/latency_stats?view='+_latencyView+'&id='+encodeURIComponent(_latencyId)+'&days='+_latencyDays)
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_latencyCache[key]=data;renderLatencyChart(data);})
    .catch(function(e){var el=document.getElementById('latencySummary');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>';});
}
function renderLatencyChart(data){
  if(!data||!data.days||!data.median_ms||!data.p95_ms)return;
  var labels=data.days.map(function(d){return fmtDateRuLong(d)});
  var accent=hmAccent(_latencyView,_latencyId);
  if(_latencyChart){_latencyChart.destroy();_latencyChart=null;}
  var canvas=document.getElementById('latencyChartCanvas');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var cc=getChartColors();
  // Stage 18.8: 4 lines. Latency (left Y, ms): P50 + P95 + P95-connect.
  // Errors (right Y, %): line, not bars — keeps the chart light.
  // All fonts/colors matched to the «Почасовой трафик» card style
  // (10px axis labels in muted gray, same as the heatmap header).
  var latDatasets=[
    {label:'P50 (медиана)',data:data.median_ms,borderColor:accent,backgroundColor:accent+'1a',fill:true,tension:.3,pointRadius:3,borderWidth:2.5,pointBackgroundColor:accent,yAxisID:'y'},
    {label:'P95 (запрос)',data:data.p95_ms,borderColor:'#EF9F27',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,borderDash:[4,3],pointBackgroundColor:'#EF9F27',yAxisID:'y'},
    {label:'P95 connect (TCP)',data:data.connect_p95_ms||[],borderColor:'#7c3aed',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,borderDash:[2,3],pointBackgroundColor:'#7c3aed',yAxisID:'y'},
    {label:'Ошибки',data:data.error_pct||[],borderColor:'#e84141',backgroundColor:'transparent',fill:false,tension:.3,pointRadius:2,borderWidth:2,pointBackgroundColor:'#e84141',yAxisID:'y2'}
  ];
  // Stage 18.5: axis legibility pass.
  //   - bumped font 10 → 12 px (was unreadable on retina + dark theme)
  //   - axis labels now use --text-2 (much higher contrast than the soft
  //     grid color, which is meant for the lines themselves)
  //   - x-axis: skip every other label when > 10 points so dates don't
  //     visually collide (14d fits exactly 14 labels, but font bump makes
  //     them overlap on narrow screens — auto-skip handles it)
  //   - y-axis: explicit padding + maxTicksLimit for cleaner steps
  //   - tooltip: dark/light themed background + bigger title font
  // Stage 18.8: axis styles match «Почасовой трафик» — small muted labels,
  // not the heavier 12px text used previously.
  var axisColor    = '#6b6b68';   // matches heatmap day labels
  var axisColorDim = '#9b9b98';   // matches heatmap hour labels and dates
  _latencyChart=newChartSafe(ctx,{
    type:'line',
    data:{labels:labels,datasets:latDatasets},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      layout:{padding:{top:8,right:8,bottom:4,left:4}},
      interaction:{intersect:false,mode:'index'},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(13,13,14,0.92)',
          titleColor:'#fff',titleFont:{size:11,weight:'600'},
          bodyColor:'#e0e0e0',bodyFont:{size:11},
          padding:10,cornerRadius:6,displayColors:true,boxPadding:4,
          callbacks:{label:function(ctx){
            var v=ctx.parsed.y;
            if(v==null)return ' '+ctx.dataset.label+': —';
            // Errors are percentages, latencies always in seconds (Stage 18.14).
            if(ctx.dataset.yAxisID==='y2')return ' '+ctx.dataset.label+': '+v+'%';
            return ' '+ctx.dataset.label+': '+fmtMs(v);
          }}
        }
      },
      scales:{
        x:{
          ticks:{
            font:{size:10},
            color:axisColorDim,
            maxRotation:0,
            autoSkip:true,
            autoSkipPadding:12
          },
          grid:{color:cc.gridLine,drawTicks:false},
          border:{display:false}
        },
        y:{
          beginAtZero:true,
          ticks:{
            font:{size:10},
            color:axisColor,
            padding:6,
            maxTicksLimit:6,
            // Stage 18.14: axis ticks always in seconds (no mс branch).
            callback:function(v){return (v/1000).toFixed(v<1000?2:1)+' с'}
          },
          grid:{color:cc.gridLine,drawTicks:false},
          border:{display:false}
        },
        y2:{
          position:'right',
          beginAtZero:true,
          grid:{display:false},
          ticks:{
            font:{size:10},
            color:'rgba(232,65,65,0.85)',
            padding:6,
            maxTicksLimit:5,
            callback:function(v){return v+'%'}
          },
          border:{display:false}
        }
      }
    }
  });
  // Stage 18.7: summary panel removed — chart itself is now the summary.
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
// Short variant for threshold labels — strips trailing zeros so 500/2000/4000
// render as «0.5 с», «2 с», «4 с» (instead of «0.50 с»).
function fmtMsShort(ms){
  if(ms==null)return'—';
  var s=ms/1000;
  return (s%1===0?s.toFixed(0):s.toFixed(2).replace(/\.?0+$/,''))+' с';
}

// Percentile card with delta-vs-prior-period indicator.
// `cur` and `prev` are ms values (or null). Lower-is-better — green = improvement.
function latPctileCard(label,cur,prev,baseStyle){
  var deltaHtml='';
  if(cur!=null&&prev!=null&&prev>0){
    var diff=cur-prev;
    var pct=Math.round(diff/prev*100);
    var arrow=diff>0?'▲':diff<0?'▼':'•';
    // For latency, lower is better → improvement is green
    var col=Math.abs(pct)<5?'var(--text-2)':diff<0?'var(--green)':'var(--red)';
    deltaHtml='<div style="font-size:10px;color:'+col+';line-height:1.1;white-space:nowrap;margin-top:2px">'+arrow+' '+(pct>0?'+':'')+pct+'% к пред.</div>';
  }else if(cur!=null){
    deltaHtml='<div style="font-size:10px;color:var(--text-3);line-height:1.1;white-space:nowrap;margin-top:2px">нет пред. данных</div>';
  }
  return'<div style="flex:1;min-width:90px;display:flex;flex-direction:column;gap:3px;padding:0 16px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:18px;font-weight:600;line-height:1.2;white-space:nowrap;'+(baseStyle||'color:var(--text-0)')+'">'+fmtMs(cur)+'</div>'
    +deltaHtml
    +'</div>';
}

// Renders distribution stacked bar + percentile cards. Falls back gracefully
// if backend hasn't returned overall/buckets/prior (older API).
function renderLatencySummary(data){
  // Stage 17 — compact rebuild. Previous version stacked three full-width
  // blocks (distribution + connect strip + percentile cards) taking ~150px.
  // New layout: a single row with percentile chips + an inline distribution
  // bar with the legend baked into the segments. TCP-handshake details
  // moved behind a «Подробнее» toggle (rare-use). Total ~50px vs ~150px.
  var sum=document.getElementById('latencySummary');if(!sum)return;
  var ov=data.overall||{};
  var pr=data.prior||{};
  var bk=data.buckets||{};
  var th=data.thresholds||{warn_ms:_pcWarnMs,bad_ms:_pcBadMs,very_slow_ms:_pcBadMs*2};
  var okN=ov.ok_checks||0;
  var html='';

  // ── Row 1: KPI-плитки перцентилей (по макету: P50 медиана / P75 / P99 + Ошибки) ──
  html+='<div class="kpi-row">';
  function pct(label,sub,cur,prev,thresholdBad,thresholdWarn){
    var col='var(--text-0)';
    if(cur!=null){
      if(thresholdBad&&cur>thresholdBad)col='var(--red)';
      else if(thresholdWarn&&cur>thresholdWarn)col='var(--orange)';
      else col='var(--green)';
    }
    var delta='';
    if(cur!=null&&prev!=null&&prev>0){
      var diff=cur-prev,dpct=Math.round(diff/prev*100);
      if(Math.abs(dpct)>=5){
        var dCol=diff<0?'var(--green)':'var(--red)';
        delta=' <span style="font-size:10px;color:'+dCol+';font-weight:500">'+(diff<0?'▼':'▲')+Math.abs(dpct)+'%</span>';
      }
    }
    return'<div class="kpi-tile"><div class="l">'+label+(sub?' <span style="text-transform:none;letter-spacing:0">'+sub+'</span>':'')+'</div><div class="v" style="color:'+col+'">'+fmtMs(cur)+delta+'</div></div>';
  }
  html+=pct('P50 медиана',null,ov.p50,pr.p50,_pcBadMs,_pcWarnMs);
  html+=pct('P75',null,ov.p75,pr.p75,_pcBadMs,_pcWarnMs);
  html+=pct('P99',null,ov.p99,pr.p99,_pcBadMs,_pcWarnMs);
  html+='</div>';

  // ── Row 2: compact distribution bar with inline thresholds ──
  if(okN>0){
    var f=bk.fast||0,o=bk.ok||0,s=bk.slow||0,vs=bk.very_slow||0;
    var pf=f/okN*100,po=o/okN*100,ps=s/okN*100,pvs=vs/okN*100;
    function seg(pct,col,label,cnt){
      if(pct<=0)return'';
      return'<div title="'+esc(label)+': '+cnt+' ('+pct.toFixed(1)+'%)" style="flex:'+pct+';background:'+col+';display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:600;min-width:0;overflow:hidden;white-space:nowrap">'+(pct>=10?pct.toFixed(0)+'%':'')+'</div>';
    }
    html+='<div style="margin-top:4px;padding:0 4px">';
    html+='<div style="display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--bg-3)">';
    html+=seg(pf,'rgb(52,199,89)','< '+fmtMsShort(th.warn_ms),f);
    html+=seg(po,'rgb(255,159,10)',fmtMsShort(th.warn_ms)+'–'+fmtMsShort(th.bad_ms),o);
    html+=seg(ps,'rgb(255,99,71)',fmtMsShort(th.bad_ms)+'–'+fmtMsShort(th.very_slow_ms),s);
    html+=seg(pvs,'rgb(165,40,40)','≥ '+fmtMsShort(th.very_slow_ms),vs);
    html+='</div>';
    // Словесная легенда (по макету): Быстрые · ОК · Медленные · Оч. медл.
    html+='<div style="display:flex;gap:12px 16px;flex-wrap:wrap;margin-top:7px;font-size:11px;color:var(--text-2)" title="< '+th.warn_ms+' мс — быстро; '+th.warn_ms+'–'+th.bad_ms+' — норма; '+th.bad_ms+'–'+th.very_slow_ms+' — медленно; ≥ '+th.very_slow_ms+' — очень медленно">';
    [['rgb(52,199,89)','Быстрые',pf],['rgb(255,159,10)','ОК',po],['rgb(255,99,71)','Медленные',ps],['rgb(165,40,40)','Оч. медл.',pvs]].forEach(function(x){
      html+='<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[0]+'"></span>'+x[1]+' <b>'+Math.round(x[2])+'%</b></span>';
    });
    html+='</div></div>';
  }

  sum.innerHTML=html;
}

// Compact chip used in the connect-only strip. Smaller than full card: value
// inline with delta, single-line.
function latConnectChip(label,cur,prev){
  var deltaHtml='';
  if(cur!=null&&prev!=null&&prev>0){
    var diff=cur-prev;var pct=Math.round(diff/prev*100);
    var arrow=diff>0?'▲':diff<0?'▼':'•';
    var col=Math.abs(pct)<5?'var(--text-2)':diff<0?'var(--green)':'var(--red)';
    deltaHtml='<span style="font-size:10px;color:'+col+';margin-left:4px">'+arrow+(pct>0?'+':'')+pct+'%</span>';
  }
  return'<span style="display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap"><span style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">'+label+'</span><span style="font-size:14px;font-weight:600;color:var(--text-0)">'+fmtMs(cur)+'</span>'+deltaHtml+'</span>';
}

// ========== LATENCY DAY SCATTER ==========
var _latencyMode='7d'; // '7d' or 'day'
var _latencyDate=null;  // YYYY-MM-DD (MSK), set when mode='day'
var _latencyDayCache={};

function getMskToday(){
  var now=new Date();var msk=new Date(now.getTime()+3*3600*1000);
  return msk.toISOString().slice(0,10);
}
function getMskYesterday(){
  var now=new Date();var msk=new Date(now.getTime()+3*3600*1000-86400000);
  return msk.toISOString().slice(0,10);
}

function setLatencyMode(mode,dateHint){
  _latencyMode=mode;
  if(mode==='day'){
    if(dateHint==='today')_latencyDate=getMskToday();
    else if(dateHint==='yesterday')_latencyDate=getMskYesterday();
    else if(dateHint&&/^\d{4}-\d{2}-\d{2}$/.test(dateHint))_latencyDate=dateHint;
    else if(!_latencyDate)_latencyDate=getMskToday();
  }
  updateLatencyPeriodUI();
  if(mode==='7d'){
    _latencyCache={};
    loadLatencyStats();
  }else{
    loadLatencyDay();
  }
}

function updateLatencyPeriodUI(){
  var btns=document.querySelectorAll('.lat-period-btn');
  var today=getMskToday(),yesterday=getMskYesterday();
  btns.forEach(function(b){
    // Stage 17.1: the 7d/14d/30d buttons (.latency-period-btn) have their
    // own active-highlight logic in setLatencyDays(); don't trample it here.
    if (b.classList.contains('latency-period-btn')) return;
    b.style.background='var(--bg-3)';b.style.color='var(--text-1)';b.style.fontWeight='400';
  });
  if(_latencyMode==='7d'){
    // Mark whichever days-button matches the currently selected _latencyDays.
    var lbtns=document.querySelectorAll('.latency-period-btn');
    lbtns.forEach(function(b){
      var active = parseInt(b.dataset.days) === _latencyDays;
      b.style.background = active ? 'var(--accent)' : 'var(--bg-2)';
      b.style.color      = active ? '#fff' : 'var(--text-2)';
      b.style.borderColor= active ? 'var(--accent)' : 'var(--border)';
    });
  }else{
    // In single-day mode, dim the days-buttons so the user sees they're inactive.
    var lbtns2=document.querySelectorAll('.latency-period-btn');
    lbtns2.forEach(function(b){
      b.style.background = 'var(--bg-2)';
      b.style.color = 'var(--text-3)';
      b.style.borderColor = 'var(--border)';
    });
    if(_latencyDate===today){
      var bt=document.getElementById('latPeriodToday');
      if(bt){bt.style.background='var(--accent)';bt.style.color='#fff';bt.style.fontWeight='600';}
    }else if(_latencyDate===yesterday){
      var by=document.getElementById('latPeriodYesterday');
      if(by){by.style.background='var(--accent)';by.style.color='#fff';by.style.fontWeight='600';}
    }
  }
  // Show/hide date nav
  var showNav=(_latencyMode==='day');
  var prev=document.getElementById('latDatePrev');
  var next=document.getElementById('latDateNext');
  var lbl=document.getElementById('latDateLabel');
  if(prev)prev.style.display=showNav?'':'none';
  if(next)next.style.display=showNav?'':'none';
  if(lbl){
    lbl.style.display=showNav?'':'none';
    if(showNav&&_latencyDate)lbl.textContent=fmtDateRuLong(_latencyDate);
  }
}

function shiftLatencyDate(dir){
  if(!_latencyDate)_latencyDate=getMskToday();
  var d=new Date(_latencyDate+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+dir);
  var today=getMskToday();
  var candidate=d.toISOString().slice(0,10);
  if(candidate>today)return;
  _latencyDate=candidate;
  updateLatencyPeriodUI();
  loadLatencyDay();
}

function loadLatencyDay(){
  var key=_latencyView+'|'+_latencyId+'|'+_latencyDate;
  if(_latencyDayCache[key]){renderLatencyScatter(_latencyDayCache[key]);return;}
  api(API+'/api/analytics/latency_day?view='+_latencyView+'&id='+encodeURIComponent(_latencyId)+'&date='+_latencyDate)
    .then(function(d){if(d&&d.__status>=400)throw new Error('HTTP '+d.__status);return d})
    .then(function(data){_latencyDayCache[key]=data;renderLatencyScatter(data);})
    .catch(function(e){var el=document.getElementById('latencySummary');if(el)el.innerHTML='<div style="color:var(--danger);font-size:12px">Ошибка: '+esc(e.message)+'</div>';});
}

function renderLatencyScatter(data){
  if(!data||!data.points)return;
  if(_latencyChart){_latencyChart.destroy();_latencyChart=null;}
  var canvas=document.getElementById('latencyChartCanvas');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var cc=getChartColors();

  // Build scatter datasets: ok points split by color, error points
  var green=[],orange=[],red=[],gray=[],allMs=[];
  for(var i=0;i<data.points.length;i++){
    var p=data.points[i];
    var pt={x:p.min,y:p.total,nick:p.nick,op:p.op,client:p.client,time:p.t,connect:p.connect,status:p.status,error:p.error};
    if(p.error){pt.y=0;gray.push(pt);}
    else if(p.total==null){continue;}
    else{
      allMs.push(p.total);
      if(p.total>=_pcBadMs){red.push(pt);}
      else if(p.total>=_pcWarnMs){orange.push(pt);}
      else{green.push(pt);}
    }
  }
  // Compute Y cap: P98 * 1.2, max 15s
  var yMax=undefined;
  if(allMs.length>10){
    var sorted=allMs.slice().sort(function(a,b){return a-b});
    var p98=sorted[Math.min(Math.ceil(sorted.length*0.98)-1,sorted.length-1)];
    yMax=Math.min(Math.round(p98*1.2),15000);
  }

  var scatterDatasets=[
    {label:'< '+fmtMsShort(_pcWarnMs),color:'rgb(52,199,89)',data:green,backgroundColor:'rgba(52,199,89,0.35)',pointRadius:2,pointHoverRadius:4,order:1},
    {label:fmtMsShort(_pcWarnMs)+'–'+fmtMsShort(_pcBadMs),color:'rgb(255,159,10)',data:orange,backgroundColor:'rgba(255,159,10,0.35)',pointRadius:2,pointHoverRadius:4,order:2},
    {label:'> '+fmtMsShort(_pcBadMs),color:'rgb(255,59,48)',data:red,backgroundColor:'rgba(255,59,48,0.3)',pointRadius:2,pointHoverRadius:4,order:3},
    {label:'Ошибки',color:'rgb(142,142,147)',data:gray,backgroundColor:'rgba(142,142,147,0.4)',pointRadius:1.5,pointHoverRadius:4,pointStyle:'crossRot',order:4}
  ];
  var scLegendEl=document.getElementById('latencyLegend');
  if(scLegendEl){
    scLegendEl.innerHTML=scatterDatasets.map(function(ds){
      var dot='<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+ds.color+'"></span>';
      if(ds.label==='Ошибки')dot='<span style="display:inline-block;width:10px;height:10px;color:'+ds.color+';font-size:12px;line-height:10px;text-align:center;font-weight:700">×</span>';
      return'<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-1)">'+dot+esc(ds.label)+'</span>';
    }).join('');
  }
  _latencyChart=newChartSafe(ctx,{type:'scatter',data:{datasets:scatterDatasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:function(items){if(!items.length)return'';var d=items[0].raw;return d.nick+(d.op?' · '+d.op:'');},label:function(ctx2){var d=ctx2.raw;if(d.error)return'Ошибка: '+d.error;return(d.total!=null?fmtMs(d.total):'—')+' · '+d.time+(d.client?' · '+d.client:'');}}}},scales:{x:{type:'linear',min:0,max:1440,ticks:{font:{size:10},color:cc.grid,stepSize:120,callback:function(v){var h=Math.floor(v/60);return String(h).padStart(2,'0')+':00'}},grid:{color:cc.gridLine}},y:{beginAtZero:true,suggestedMax:yMax,ticks:{font:{size:10},color:cc.grid,callback:function(v){return (v/1000).toFixed(v<1000?2:1)+' с'}},grid:{color:cc.gridLine}}}}});

  // Summary
  var sum=document.getElementById('latencySummary');if(!sum||!data.summary)return;
  var s=data.summary;
  var mCls=s.median_ms===null?'':s.median_ms>_pcBadMs?'color:var(--red)':s.median_ms>_pcWarnMs?'color:var(--orange)':'color:var(--green)';
  var eCls=s.total>0?(s.errors/s.total*100>15?'color:var(--red)':s.errors>0?'color:var(--orange)':'color:var(--green)'):'';
  sum.innerHTML=latSumItem('Медиана',s.median_ms!==null?fmtMs(s.median_ms):'—',mCls)
    +latSumItem('P95',s.p95_ms!==null?fmtMs(s.p95_ms):'—','')
    +latSumItem('Ошибки',s.total>0?Math.round(s.errors/s.total*100)+'%':'—',eCls)
    +latSumItem('Проверок',String(s.total),'');
}

function latSumItem(label,val,style){
  return'<div style="flex:1;display:flex;flex-direction:column;gap:3px;padding:0 20px;border-right:0.5px solid rgba(0,0,0,0.08)">'
    +'<div style="font-size:10px;color:#9b9b98;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">'+label+'</div>'
    +'<div style="font-size:18px;font-weight:600;line-height:1.2;white-space:nowrap;'+(style||'color:var(--text-0)')+'">'+val+'</div></div>';
}

var _dailyMonthOffset=0; // 0=current, -1=prev, etc
var _MONTHS_RU_NOM=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var _MONTHS_RU_SHORT=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
// «2026-03» → «Март» (или «Мар» при short). Возвращает исходную строку, если формат иной.
function _ymRu(ym,short){ if(ym==null)return ''; var s=String(ym); var m=/^(\d{4})-(\d{2})/.exec(s); if(!m)return s; var mi=parseInt(m[2],10)-1; return (short?_MONTHS_RU_SHORT:_MONTHS_RU_NOM)[mi]||s; }
function shiftDailyMonth(dir){
  _dailyMonthOffset+=dir;
  if(_dailyMonthOffset>0)_dailyMonthOffset=0;
  if(_dailyMonthOffset<-11)_dailyMonthOffset=-11;
  renderDailyClientChart(window._dailyTrafficCache);
}
function renderDailyClientChart(data,cc){
  if(!cc)cc=getChartColors();
  if(!data)return;
  window._dailyTrafficCache=data;
  var serverFilter=(document.getElementById('dailyServerFilter')||{}).value||'all';
  var mode=(document.getElementById('dailyModeFilter')||{}).value||'clients';

  // Collect all available servers for the filter dropdown
  var allServers={};
  for(var client in data){
    for(var dt in data[client]){
      var srvs=data[client][dt].servers;
      if(srvs){for(var s in srvs)allServers[s]=true}
    }
  }
  // Populate dropdown (only once or when servers change)
  var sel=document.getElementById('dailyServerFilter');
  if(sel&&sel.options.length<=1){
    var srvNames=Object.keys(allServers).sort();
    var seen={};
    srvNames.forEach(function(s){
      var ci=COUNTRIES[s]||{};
      var cc=ci.country||s;
      if(seen[cc])return;seen[cc]=true;
      var opt=document.createElement('option');
      opt.value=cc;
      opt.textContent=(ci.flag||'')+' '+(ci.name||s);
      sel.appendChild(opt);
    });
    sel.value=serverFilter;
  }

  // Build date labels for selected month
  var now=new Date();
  var targetDate=new Date(now.getFullYear(),now.getMonth()+_dailyMonthOffset,1);
  var year=targetDate.getFullYear(),month=targetDate.getMonth();
  var daysInMonth=new Date(year,month+1,0).getDate();
  var isCurrentMonth=(_dailyMonthOffset===0);
  var today=isCurrentMonth?now.getDate():daysInMonth;
  var labels=[];
  for(var d=1;d<=Math.min(today,daysInMonth);d++){
    var dd=String(d).padStart(2,'0');
    var mm=String(month+1).padStart(2,'0');
    labels.push(year+'-'+mm+'-'+dd);
  }
  var displayLabels=labels.map(function(l){return l.slice(8)+'.'+l.slice(5,7)});
  // Update month label
  var lbl=document.getElementById('dailyMonthLabel');
  if(lbl)lbl.textContent=_MONTHS_RU_NOM[month]+' '+year;

  var datasets;
  var clients;

  if(mode==='countries'){
    // Build datasets per server (country)
    var countryColors={'MD':'#3B9DD8','RO':'#E05C2C'};
    var countryLabels={'MD':'🇲🇩 Молдова','RO':'🇷🇴 Румыния'};
    var countryTotals={};
    for(var client in data){
      if(_selectedClient&&client!==_selectedClient)continue;
      for(var dt in data[client]){
        var srvs=data[client][dt].servers;
        if(!srvs)continue;
        for(var s in srvs){
          var ci=COUNTRIES[s]||{};
          var cc=ci.country||s;
          if(!countryTotals[cc])countryTotals[cc]={};
          if(!countryTotals[cc][dt])countryTotals[cc][dt]=0;
          if(serverFilter==='all'||serverFilter===cc){
            countryTotals[cc][dt]+=(srvs[s].in||0)+(srvs[s].out||0);
          }
        }
      }
    }
    datasets=Object.keys(countryTotals).sort().map(function(cc,i){
      var color=countryColors[cc]||CHART_COLORS.clients[i];
      var values=labels.map(function(dt){return parseFloat((countryTotals[cc][dt]||0)/1e9).toFixed(2)});
      return{label:countryLabels[cc]||cc,clientName:cc,data:values,borderColor:color,backgroundColor:color+'26',fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:2};
    });
    clients=Object.keys(countryTotals);
  } else {
  // Sort clients by total traffic desc (with server filter)
  // If a client is selected in the table, show only that client
  var clientTotals={};
  var _cfVal=(document.getElementById('dailyClientFilter')||{}).value||'all';
  for(var client in data){
    if(client==='Не назначен')continue;
    if(_selectedClient&&client!==_selectedClient)continue;
    if(_cfVal!=='all'&&client!==_cfVal)continue;
    var total=0;
    for(var dt in data[client]){
      var entry=data[client][dt];
      if(serverFilter==='all'){
        total+=(entry.in||0)+(entry.out||0);
      } else if(entry.servers){
        for(var _s in entry.servers){var _ci=COUNTRIES[_s]||{};if((_ci.country||_s)===serverFilter){total+=(entry.servers[_s].in||0)+(entry.servers[_s].out||0);}}
      }
    }
    if(total>0)clientTotals[client]=total;
  }
  clients=Object.keys(clientTotals).sort(function(a,b){return clientTotals[b]-clientTotals[a]});

  // Build datasets using CHART_COLORS palette
  datasets=clients.map(function(client,i){
    var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
    var values=labels.map(function(dt){
      var entry=data[client]&&data[client][dt];
      if(!entry)return 0;
      if(serverFilter==='all'){
        return parseFloat(((entry.in||0)+(entry.out||0))/1e9).toFixed(2);
      } else if(entry.servers){
        var _t=0;for(var _s in entry.servers){var _ci=COUNTRIES[_s]||{};if((_ci.country||_s)===serverFilter){_t+=(entry.servers[_s].in||0)+(entry.servers[_s].out||0);}}
        return parseFloat(_t/1e9).toFixed(2);
      }
      return 0;
    });
    return{label:client,clientName:client,data:values,borderColor:color,backgroundColor:color+'26',fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:2};
  });
  }
  if(mode==='modems'){
    // Per-modem view using modem data from API
    var modemData=window._modemTrafficCache;
    if(modemData){
      var modemTotals={};
      for(var nick in modemData){
        var md=modemData[nick];
        // Filter by selected client
        if(_selectedClient&&md.portName!==_selectedClient)continue;
        // Filter by server
        if(serverFilter!=='all'&&md.server!==serverFilter)continue;
        var t=0;for(var dt in md.days)t+=md.days[dt];
        if(t>0)modemTotals[nick]=t;
      }
      clients=Object.keys(modemTotals).sort(function(a,b){return modemTotals[b]-modemTotals[a]});
      datasets=clients.map(function(key,i){
        // `key` is the backend's "nick:portName" map key. UI presents:
        //   - legend label: just the nick (e.g. MD2_66)
        //   - tooltip title: nick + operator (e.g. MD2_66:Orange MD)
        var md=modemData[key]||{};
        var nick=md.nick||key.split(':')[0];
        var op=md.operator||'';
        var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
        var values=labels.map(function(dt){return parseFloat((md.days&&md.days[dt]||0)/1e9).toFixed(2)});
        return{
          label:nick,                             // shown in legend
          tooltipTitle:nick+(op?':'+op:''),       // shown in tooltip title (we read this in callbacks below)
          clientName:nick,
          data:values,
          borderColor:color,backgroundColor:color+'26',
          fill:false,tension:0.3,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:color,borderWidth:1.5
        };
      });
    }
  } // end modems mode

  // Add "Все" (Total) line — only for countries mode
  if(mode==='countries'){
    var totalValues=labels.map(function(dt,idx){
      var sum=0;
      datasets.forEach(function(ds){sum+=parseFloat(ds.data[idx])||0;});
      return sum.toFixed(2);
    });
    datasets.unshift({label:'Все',clientName:'__total__',data:totalValues,borderColor:'#1A1A1A',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2.5,borderDash:[6,3]});
  }

  // Custom HTML legend
  var legendEl=document.getElementById('dailyClientLegend');
  if(legendEl){
    legendEl.innerHTML=datasets.map(function(ds){
      return'<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-2)">'+
        '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:'+ds.borderColor+'"></span>'+esc(ds.label)+'</span>';
    }).join('');
  }

  if(charts.dailyClient){charts.dailyClient.destroy();delete charts.dailyClient;}
  var dailyCanvas=document.getElementById('chartDailyClientTraffic');
  if(!dailyCanvas)return;
  charts.dailyClient=newChartSafe(dailyCanvas,{type:'line',data:{labels:displayLabels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){var ds=ctx.dataset||{};var name=ds.tooltipTitle||ds.label;return' '+name+': '+ctx.parsed.y+' GB'}}}},scales:{x:{ticks:{color:cc.text,font:{size:9}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:cc.text,font:{size:10},callback:function(v){return v+' GB'}},grid:{color:cc.grid}}}}});
}

function onDailyModeChange(){
  var mode=document.getElementById('dailyModeFilter').value;
  var cf=document.getElementById('dailyClientFilter');
  cf.style.display=(mode==='clients')?'':'none';
  // Populate client filter if empty
  if(mode==='clients'&&cf.options.length<=1&&window._dailyTrafficCache){
    var cls=Object.keys(window._dailyTrafficCache).filter(function(c){return c!=='Не назначен'}).sort();
    cls.forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c;cf.appendChild(o)});
  }
  if(mode==='modems'&&!window._modemTrafficCache&&!window._modemFetchInProgress){
    window._modemFetchInProgress=true;
    api(API+'/api/admin/daily_traffic?detail=modems')
      .then(function(d){
        window._dailyTrafficCache=d.clients;
        window._modemTrafficCache=d.modems;
        window._modemFetchInProgress=false;
        renderDailyClientChart(d.clients);
      })
      .catch(function(e){window._modemFetchInProgress=false;showToast('Ошибка: '+esc(e.message),'error')});
    return;
  }
  renderDailyClientChart(window._dailyTrafficCache);
}
var _selectedClient=null;
function selectClient(name){
  _selectedClient=_selectedClient===name?null:name;
  document.querySelectorAll('.ct-row').forEach(function(r){r.classList.toggle('active',r.dataset.client===name&&_selectedClient===name)});
  // Re-render chart showing only selected client (or all if deselected)
  renderDailyClientChart(window._dailyTrafficCache);
}
var _matrixSortKey='total',_matrixSortDir=-1,_matrixView='modem',_matrixShowAll=false;
function matrixSort(key){
  if(_matrixSortKey===key){_matrixSortDir*=-1}else{_matrixSortKey=key;_matrixSortDir=-1}
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function setMatrixView(v){
  _matrixView=v;_matrixShowAll=false;
  var bm=document.getElementById('matrixViewModem'),bc=document.getElementById('matrixViewClient');
  if(bm&&bc){
    bm.style.color=v==='modem'?'var(--accent)':'var(--text-2)';
    bm.style.fontWeight=v==='modem'?'600':'500';
    bm.style.borderBottomColor=v==='modem'?'var(--accent)':'transparent';
    bc.style.color=v==='client'?'var(--accent)':'var(--text-2)';
    bc.style.fontWeight=v==='client'?'600':'500';
    bc.style.borderBottomColor=v==='client'?'var(--accent)':'transparent';
  }
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function showAllMatrixRows(){
  _matrixShowAll=true;
  var d=collectTrafficData();if(d)renderTrafficMatrix(d);
}
function _matrixRowHtml(m,clientColor){
  var total=m.tIn+m.tOut;var ci=COUNTRIES[m.server]||{};
  // Trend: N days this month vs N days prev month (from server modemTrend)
  var trendKey=m.server+'_'+m.portId;
  var mt=(currentData.modemTrend||{})[trendKey];
  var trendHtml='';
  if(mt!==undefined&&mt!==null){var chg=mt;var chgColor=chg>=0?'var(--success)':'var(--danger)';var chgStr;if(chg>999){chgStr='+999%+'}else if(chg<-99){chgStr='<−99%'}else{chgStr=(chg>=0?'+':'')+chg+'%'}trendHtml='<span style="font-size:10px;font-weight:600;color:'+chgColor+'" title="Первые N дней этого vs прошлого месяца">'+chgStr+'</span>'}
  else if(m.dayIn+m.dayOut>0){trendHtml='<span style="font-size:10px;color:var(--text-3)">—</span>'}
  var row='<tr>';
  row+='<td style="padding:0;width:3px"><div style="width:3px;height:100%;min-height:32px;background:'+clientColor+'"></div></td>';
  row+='<td style="color:var(--accent);font-weight:500">'+esc(m.nick)+'</td>';
  row+='<td style="font-size:10px;color:var(--text-2)">'+esc(m.operator||'')+'</td>';
  row+='<td style="font-size:10px">'+(ci.flag||'')+' '+m.server+'</td>';
  row+='<td style="font-size:10px">'+esc(m.pn)+'</td>';
  row+='<td class="mono" style="color:var(--text-2)">'+fmtGb(m.tIn)+'</td>';
  row+='<td class="mono" style="color:var(--text-2)">'+fmtGb(m.tOut)+'</td>';
  row+='<td class="mono" style="color:var(--text-0);font-weight:600">'+fmtGb(total)+'</td>';
  row+='<td class="mono" style="font-size:10px">'+fmtGbShort(m.dayIn+m.dayOut)+'</td>';
  row+='<td class="mono" style="font-size:10px">'+fmtGbShort(m.monIn+m.monOut)+'</td>';
  row+='<td style="text-align:center">'+trendHtml+'</td>';
  row+='</tr>';
  return row;
}
function renderTrafficMatrix(d){
  if(!d)d=collectTrafficData();if(!d)return;
  // Build client→color map
  var clientNames=Object.keys(d.clientTraffic).sort(function(a,b){return(d.clientTraffic[b].tIn+d.clientTraffic[b].tOut)-(d.clientTraffic[a].tIn+d.clientTraffic[a].tOut)});
  var clientColorMap={};clientNames.forEach(function(n,i){clientColorMap[n]=CHART_COLORS.clients[i%CHART_COLORS.clients.length]});
  // Sort
  var sorted=d.modemTraffic.slice().sort(function(a,b){
    var av,bv;
    if(_matrixSortKey==='nick'){return _matrixSortDir*(a.nick.localeCompare(b.nick))}
    if(_matrixSortKey==='tIn'){av=a.tIn;bv=b.tIn}
    else if(_matrixSortKey==='tOut'){av=a.tOut;bv=b.tOut}
    else{av=a.tIn+a.tOut;bv=b.tIn+b.tOut}
    return _matrixSortDir*(av-bv);
  });
  var sortArrow=function(k){return _matrixSortKey===k?(_matrixSortDir>0?' ↑':' ↓'):''};
  var thead='<thead><tr><th style="cursor:pointer;width:3px;padding:0"></th><th style="cursor:pointer" onclick="matrixSort(\'nick\')">Модем'+sortArrow('nick')+'</th><th>Оператор</th><th>Сервер</th><th>Клиент</th><th style="cursor:pointer" onclick="matrixSort(\'tIn\')">↓ Вход'+sortArrow('tIn')+'</th><th style="cursor:pointer" onclick="matrixSort(\'tOut\')">↑ Выход'+sortArrow('tOut')+'</th><th style="cursor:pointer" onclick="matrixSort(\'total\')">Σ Всего'+sortArrow('total')+'</th><th>Сегодня</th><th>Месяц</th><th style="width:90px">Тренд мес.</th></tr></thead>';
  var h=thead+'<tbody>';
  if(_matrixView==='client'){
    // Group by client with colored header rows
    clientNames.forEach(function(pn){
      var color=clientColorMap[pn]||'var(--border)';
      var clientModems=sorted.filter(function(m){return m.pn===pn});
      if(!clientModems.length)return;
      var ctIn=clientModems.reduce(function(s,m){return s+m.tIn},0);
      var ctOut=clientModems.reduce(function(s,m){return s+m.tOut},0);
      h+='<tr style="background:'+color+'22"><td colspan="11" style="padding:4px 8px;font-size:11px;font-weight:600;color:var(--text-0)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+color+';margin-right:6px"></span>'+esc(pn)+' — '+clientModems.length+' мод. | ↓'+fmtGb(ctIn)+' ↑'+fmtGb(ctOut)+'</td></tr>';
      var toShow=_matrixShowAll?clientModems:clientModems.slice(0,10);
      toShow.forEach(function(m){h+=_matrixRowHtml(m,color)});
    });
  } else {
    // "По модемам": aggregate all ports/clients per modem nick
    var modemAgg={};
    sorted.forEach(function(m){
      var key=m.nick+'|'+m.server;
      if(!modemAgg[key]){
        modemAgg[key]={nick:m.nick,server:m.server,operator:m.operator,
          tIn:0,tOut:0,dayIn:0,dayOut:0,monIn:0,monOut:0,prevIn:0,prevOut:0,
          clients:[],online:m.online};
      }
      var agg=modemAgg[key];
      agg.tIn+=m.tIn;agg.tOut+=m.tOut;
      agg.dayIn+=m.dayIn;agg.dayOut+=m.dayOut;
      agg.monIn+=m.monIn;agg.monOut+=m.monOut;
      agg.prevIn+=m.prevIn||0;agg.prevOut+=m.prevOut||0;
      if(m.pn&&agg.clients.indexOf(m.pn)===-1)agg.clients.push(m.pn);
    });
    var aggList=Object.values(modemAgg).sort(function(a,b){
      if(_matrixSortKey==='nick')return _matrixSortDir*(a.nick.localeCompare(b.nick));
      if(_matrixSortKey==='tIn')return _matrixSortDir*(a.tIn-b.tIn);
      if(_matrixSortKey==='tOut')return _matrixSortDir*(a.tOut-b.tOut);
      return _matrixSortDir*((a.tIn+a.tOut)-(b.tIn+b.tOut));
    });
    var toShow=_matrixShowAll?aggList:aggList.slice(0,10);
    toShow.forEach(function(m){
      // pick color by first client or mixed
      var col=m.clients.length===1?(clientColorMap[m.clients[0]]||'var(--border)'):'var(--border)';
      // pn = joined clients list
      var origPn=m.pn;m.pn=m.clients.join(', ');
      h+=_matrixRowHtml(m,col);
      m.pn=origPn;
    });
    // update show-more count to reflect aggregated rows
    var showMoreEl=document.getElementById('trafficMatrixShowMore');
    if(showMoreEl){
      if(!_matrixShowAll&&aggList.length>10){
        showMoreEl.style.display='';
        showMoreEl.querySelector('button').textContent='Показать все '+aggList.length+' модемов ↓';
      } else {showMoreEl.style.display='none';}
    }
  }
  document.getElementById('trafficMatrix').innerHTML=h+'</tbody>';
  // show-more for client view (modem view handles it inline above)
  if(_matrixView==='client'){
  var showMoreEl=document.getElementById('trafficMatrixShowMore');
  if(showMoreEl){
    var totalRows=sorted.length;
    if(!_matrixShowAll&&totalRows>10){
      showMoreEl.style.display='';
      showMoreEl.querySelector('button').textContent='Показать все '+totalRows+' строк ↓';
    } else {
      showMoreEl.style.display='none';
    }
  }
  }
}

// ========== FINANCES TAB ==========
var _finPeriod='month';

function loadTopHosts(forceRefresh){
  document.getElementById('resLoading').style.display='flex';
  document.getElementById('resLastLoad').textContent='Загрузка...';
  var url=forceRefresh?API+'/api/admin/top_hosts_refresh':API+'/api/admin/top_hosts_aggregated';
  var opts=forceRefresh?{method:'POST',headers:{'X-Auth-Token':authToken}}:{headers:{'X-Auth-Token':authToken}};
  fetch(url,opts).then(function(r){return r.json()}).then(function(result){
    if(forceRefresh){
      return api(API+'/api/admin/top_hosts_aggregated').catch(function(){return {data:{}};});
    }
    return result;
  }).then(function(cache){
    var data=cache.data||{};
    if(Object.keys(data).length===0&&!forceRefresh){
      // No cached data yet — trigger server-side refresh
      return loadTopHosts(true);
    }
    topHostsCache=data;
    topHostsCachePerPort=cache.perPort||null;
    document.getElementById('resLoading').style.display='none';
    var updatedAt=cache.updatedAt?new Date(cache.updatedAt).toLocaleString('ru-RU'):'нет данных';
    var stats=cache.stats||{};
    document.getElementById('resLastLoad').textContent='Обновлено: '+updatedAt+(stats.portsScanned?' | '+stats.portsScanned+' портов, '+stats.errors+' ошибок':'');
    document.getElementById('resCount').textContent=Object.keys(data).length;
    renderTopResources();
  }).catch(function(e){
    document.getElementById('resLoading').style.display='none';
    document.getElementById('resLastLoad').textContent='Ошибка: '+(e.message||e);
  });
}

function renderTopResources(){
  if(!topHostsCache){
    document.getElementById('topResourcesList').innerHTML='<div style="color:var(--text-3);padding:30px;text-align:center;font-size:13px"><div class="spinner" style="display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin-bottom:8px"></div><br>Загрузка данных о ресурсах...</div>';
    return;
  }
  // Use resClientFilter on resources page
  var clientFilter=document.getElementById('resClientFilter');
  var filterPortName=clientFilter?clientFilter.value:'';
  var dataSource=topHostsCache;
  var showAll=false;
  if(filterPortName&&topHostsCachePerPort){
    if(topHostsCachePerPort[filterPortName]){
      dataSource=topHostsCachePerPort[filterPortName];
      showAll=true;
    }else{
      document.getElementById('topResourcesList').innerHTML='<div style="color:var(--text-3);padding:30px;text-align:center;font-size:13px">Нет данных для этого клиента.<br>Нажмите «Обновить ресурсы» для загрузки.</div>';
      return;
    }
  }
  var sorted=Object.keys(dataSource).sort(function(a,b){return dataSource[b]-dataSource[a]});
  var displayItems=showAll?sorted:sorted.slice(0,50);
  var maxCount=displayItems.length?dataSource[displayItems[0]]:0;

  // Horizontal bars (no quick filters)
  var items=displayItems.map(function(h,i){return{label:h,value:dataSource[h],color:['blue','green','orange','purple','red'][i%5]}});
  document.getElementById('topResourcesList').innerHTML='<div style="max-height:600px;overflow-y:auto">'+renderHBarsRes(items,maxCount)+'</div>';

  // Categories — progress bars
  var categoryCounts={};sorted.forEach(function(h){var cat=categorize(h);if(!categoryCounts[cat])categoryCounts[cat]=0;categoryCounts[cat]+=dataSource[h]});
  var catH='<div style="padding:8px 0">';
  var cats=Object.keys(categoryCounts).sort(function(a,b){return categoryCounts[b]-categoryCounts[a]});
  var catTotal=cats.reduce(function(s,c){return s+categoryCounts[c]},0)||1;
  cats.forEach(function(cat){
    var cnt=categoryCounts[cat];
    var pct=Math.round(cnt/catTotal*100);
    var col=CHART_COLORS.categories[cat]||'#B4B2A9';
    catH+='<div style="margin-bottom:10px">';
    catH+='<div style="display:flex;align-items:baseline;margin-bottom:3px;font-size:12px">';
    catH+='<span style="flex:1;color:var(--text-0)">'+esc(cat)+'</span>';
    catH+='<span style="font-size:11px;color:var(--text-2);margin-right:8px">'+cnt.toLocaleString('ru-RU')+' запросов</span>';
    catH+='<span style="font-weight:500;width:36px;text-align:center;font-size:12px">'+pct+'%</span>';
    catH+='</div>';
    catH+='<div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">';
    catH+='<div style="height:6px;border-radius:3px;background:'+col+';width:'+pct+'%"></div>';
    catH+='</div></div>';
  });
  catH+='</div>';
  var catEl=document.getElementById('catBars');
  if(catEl)catEl.innerHTML=cats.length?catH:'<div style="color:var(--text-3);font-size:11px">Нет данных</div>';

  // "Без соцсетей" top domains panel
  var nsEl=document.getElementById('catBarsNoSocial');
  if(nsEl){
    var nsSorted=Object.keys(dataSource).filter(function(h){return!_socialPat.test(h)}).sort(function(a,b){return dataSource[b]-dataSource[a]}).slice(0,10);
    var nsMax=nsSorted.length?dataSource[nsSorted[0]]:1;
    var nsH='';
    nsSorted.forEach(function(h,i){
      var val=dataSource[h];var pw=Math.round(val/nsMax*100);
      nsH+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px">';
      nsH+='<div style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent)" title="'+esc(h)+'">'+esc(h)+'</div>';
      nsH+='<div style="flex:1;height:8px;background:var(--bg-3);border-radius:2px;overflow:hidden"><div style="height:8px;border-radius:2px;background:var(--accent);opacity:.6;width:'+pw+'%"></div></div>';
      nsH+='<div style="width:50px;text-align:right;font-family:var(--font-mono);font-size:10px;color:var(--text-1)">'+val.toLocaleString()+'</div></div>';
    });
    nsEl.innerHTML=nsH||'<div style="color:var(--text-3);font-size:11px">Нет данных</div>';
  }

}

function renderHBarsRes(items,maxVal){
  if(!items.length)return'';
  var h='<table class="res-table"><thead><tr><th style="width:24px">#</th><th>Домен</th><th style="width:50px">Кат.</th><th style="width:180px">Запросов</th><th style="width:60px">Кол-во</th></tr></thead><tbody>';
  items.forEach(function(item,i){
    var cat=categorize(item.label);
    var catShort=cat.substring(0,6);
    h+='<tr><td style="color:var(--text-3);font-size:10px">'+(i+1)+'</td><td class="domain" title="'+esc(item.label)+'">'+esc(item.label)+'</td><td style="font-size:9px;color:var(--text-3)">'+catShort+'</td><td><div class="hbar-bar-wrap" style="height:10px"><div class="count-bar" style="width:'+pct(item.value,maxVal)+'%"></div></div></td><td style="font-family:monospace;font-size:10px;color:var(--text-0)">'+item.value.toLocaleString()+'</td></tr>';
  });
  return h+'</tbody></table>';
}

