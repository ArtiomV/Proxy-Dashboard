// public/js/client.js — extracted from public/index.html (Stage 5).
// Client portal SPA: traffic dashboard, billing, modem list, IP reset, docs.
// Loads utils.js (esc, parseTraffic, fmtGb) before this file so duplicate
// helpers inside this file are dead code (TODO: dedup).

// esc, parseTraffic, fmtGb — moved to public/js/utils.js (loaded first).
// utils.js fmtGb has wider range (KB..TB) than the simple MB/GB version
// that was duplicated here; switch to the richer one for parity with admin.
function formatBytes(b){if(!b||b===0)return'0 B';var units=['B','KB','MB','GB','TB'];var i=0;while(b>=1024&&i<units.length-1){b/=1024;i++}return b.toFixed(1)+' '+units[i]}
function showToast(m,t){var c=document.getElementById('toastContainer');if(!c)return;var e=document.createElement('div');e.className='toast toast-'+(t||'info');e.textContent=m;c.appendChild(e);setTimeout(function(){e.remove()},4000)}
function getModemStatus(m){if(m.isRebooting)return'rebooting';if(m.isRotating)return'rotating';if(m.isOnline)return'online';return'offline'}
function bytesToGb(b){return b/1073741824}
function pct(v,max){return max?Math.round(v/max*100):0}
function formatUptime(s){if(!s||s<=0)return'-';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60);if(d>0)return d+'д '+h+'ч';if(h>0)return h+'ч '+mm+'м';return mm+'м'}
function getChartColors(){var d=document.documentElement.dataset.theme==='dark';return{grid:d?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)',text:d?'#8892a6':'#6b7280',bg:d?'#131720':'#ffffff'}}
// --- Theme ---
function getTheme(){return localStorage.getItem('pr_theme')||'dark'}

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  // Theme toggle is CSS-only (::after pseudo-element)
}

function toggleTheme(){
  var current=getTheme();
  var next=current==='dark'?'light':'dark';
  localStorage.setItem('pr_theme',next);
  applyTheme(next);
}

applyTheme(getTheme());

// --- Auth state ---
var authToken=localStorage.getItem('pr_token')||'';
var authLogin=localStorage.getItem('pr_login')||'';

// --- State ---
var tableData=[];
var modemLogins={};
var billingData=null;
var rawData=null;
var currentSort={key:'modemNick',dir:'asc'};

// --- Country config ---
var countryNames={'MD':'\ud83c\uddf2\ud83c\udde9 Молдова','RO':'\ud83c\uddf7\ud83c\uddf4 Румыния','??':'\ud83c\udf10 Другое'};
var countryOrder=['MD','RO','??'];
var COUNTRIES={}; // populated from server data in loadData

// --- Tabs ---
function switchTab(name,el){
  localStorage.setItem('pr_active_tab',name);
  document.querySelectorAll('.nav-tab').forEach(function(t){t.classList.remove('active')});
  document.querySelectorAll('.tab-pane').forEach(function(t){t.classList.remove('active')});
  if(el) el.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='traffic') renderProxyTable();
  if(name==='analytics') renderAnalytics();
  if(name==='documents') loadDocuments();
  if(name==='api') loadApiDocs();
  if(name==='referral') loadReferral();
  if(name==='billing') loadBillingHistory();
}

// --- Onboarding ---
var ONBOARDING_KEY='proxies_rent_onboarding_dismissed';
var onboardingStep=0;
var ONBOARDING_STEPS=[
  {label:'Панель управления',tab:'traffic',desc:'Здесь отображаются все активные модемы, их статус, трафик и настройки ротации IP. Вы можете скопировать реквизиты прокси и экспортировать список в нужном формате.'},
  {label:'Аналитика',tab:'analytics',desc:'Графики потребления по дням, сравнение локаций Молдовы и Румынии, топ модемов по трафику за месяц. Можно переключаться между месяцами.'},
  {label:'История баланса',tab:'billing',desc:'Подробная история всех списаний и пополнений. Списания происходят автоматически каждый день за предыдущие сутки трафика. Для пополнения — свяжитесь с менеджером.'},
  {label:'Документы',tab:'documents',desc:'Здесь хранятся закрывающие документы, счета и загруженные договоры. Документы появляются после подписания договора с менеджером.'},
  {label:'API',tab:'api',desc:'Полная документация для программной работы с прокси: получение списка, смена IP, мониторинг статуса. Есть готовые примеры на Python и JavaScript.'},
];
function initOnboarding(){
  if(localStorage.getItem(ONBOARDING_KEY))return;
  onboardingStep=0;
  _renderOnboarding();
  document.getElementById('onboardingBanner').style.display='';
}
function _renderOnboarding(){
  var s=ONBOARDING_STEPS[onboardingStep];
  var n=ONBOARDING_STEPS.length;
  document.getElementById('onboardingDesc').textContent=s.desc;
  document.getElementById('onboardingProgress').style.width=Math.round((onboardingStep+1)/n*100)+'%';
  document.getElementById('onboardingCounter').textContent=(onboardingStep+1)+' из '+n;
  document.getElementById('onboardingNextBtn').textContent=onboardingStep===n-1?'Завершить тур':'Следующий раздел →';
  var pills='';
  ONBOARDING_STEPS.forEach(function(st,i){
    var cls=i<onboardingStep?'#EAF3DE;color:#3B6D11':i===onboardingStep?'#185FA5;color:#fff':'var(--bg-2);color:var(--text-3)';
    var border=i<onboardingStep?'none':i===onboardingStep?'none':'1px solid var(--border)';
    pills+='<span style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:500;background:'+cls+';border:'+border+'">'+
      (i<onboardingStep?'✓ ':'')+st.label+'</span>';
  });
  document.getElementById('onboardingPills').innerHTML=pills;
}
function onboardingNext(){
  if(onboardingStep>=ONBOARDING_STEPS.length-1){dismissOnboarding();return;}
  onboardingStep++;
  var step=ONBOARDING_STEPS[onboardingStep];
  // Navigate to the tab
  var tabEl=document.querySelector('.nav-tab[onclick*="\''+step.tab+'\'"]');
  switchTab(step.tab,tabEl);
  // Move banner to new tab pane
  var banner=document.getElementById('onboardingBanner');
  var target=document.getElementById('tab-'+step.tab);
  if(target){
    var container=target.querySelector('.container')||target;
    container.insertBefore(banner,container.firstChild);
  }
  _renderOnboarding();
}
function dismissOnboarding(){
  localStorage.setItem(ONBOARDING_KEY,'1');
  var b=document.getElementById('onboardingBanner');
  if(b)b.style.display='none';
}

// --- Analytics ---
var analyticsCharts={};
var analyticsLoaded=false;
var chartViewMode='location'; // 'location'|'all'
var modemBarLimit=10; // 0 = all
var sortedModemData=[];
var dailyPeriod='month'; // 'week'|'month'|'quarter'|'year'|'all'|'custom'
var dailyNavMode='month'; // persists between arrow clicks
var dailyFrom=null; // Date (start of range)
var dailyTo=null;   // Date (end of range, null = today)
var dailyIncludeToday=true;

function _toYMD(d){var y=d.getFullYear(),m=d.getMonth()+1,dd=d.getDate();return y+'-'+(m<10?'0':'')+m+'-'+(dd<10?'0':'')+dd;}
function _today(){var d=new Date();d.setHours(0,0,0,0);return d;}
function _startOfWeek(d){var d2=new Date(d);d2.setHours(0,0,0,0);var dow=d2.getDay();d2.setDate(d2.getDate()+(dow===0?-6:1-dow));return d2;}
function _startOfMonth(d){return new Date(d.getFullYear(),d.getMonth(),1);}
function _endOfMonth(d){return new Date(d.getFullYear(),d.getMonth()+1,0);}
function _startOfQuarter(d){var q=Math.floor(d.getMonth()/3);return new Date(d.getFullYear(),q*3,1);}
function _endOfQuarter(d){var q=Math.floor(d.getMonth()/3);return new Date(d.getFullYear(),q*3+3,0);}

var _MN=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var _MNs=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

function getDailyPeriodLabel(){
  if(dailyPeriod==='all') return 'За все время';
  var mode=dailyNavMode||dailyPeriod;
  if(mode==='month'&&dailyFrom) return _MN[dailyFrom.getMonth()]+' '+dailyFrom.getFullYear();
  if(mode==='quarter'&&dailyFrom){var q=Math.floor(dailyFrom.getMonth()/3)+1;return 'Q'+q+' '+dailyFrom.getFullYear();}
  if(mode==='year'&&dailyFrom) return String(dailyFrom.getFullYear());
  if(dailyFrom&&dailyTo){
    var f=dailyFrom,t=dailyTo;
    var fD=f.getDate(),tD=t.getDate(),fM=_MNs[f.getMonth()],tM=_MNs[t.getMonth()],fY=f.getFullYear(),tY=t.getFullYear();
    if(f.getMonth()===t.getMonth()&&fY===tY) return fD+'–'+tD+' '+fM+' '+fY;
    return fD+' '+fM+(fY!==tY?' '+fY:'')+' — '+tD+' '+tM+' '+tY;
  }
  return '...';
}

function getDailyPeriodRange(){
  return {from:dailyFrom?_toYMD(dailyFrom):'',to:dailyTo?_toYMD(dailyTo):'',includeToday:dailyIncludeToday};
}

function _updateDailyNavUI(){
  var lbl=document.getElementById('dailyPeriodLabel');
  if(lbl) lbl.textContent=getDailyPeriodLabel();
  var disabled=dailyPeriod==='all';
  var L=document.getElementById('dailyNavLeft'),R=document.getElementById('dailyNavRight');
  if(L){L.disabled=disabled;L.style.opacity=disabled?'0.3':'1';L.style.cursor=disabled?'default':'pointer';}
  if(R){R.disabled=disabled;R.style.opacity=disabled?'0.3':'1';R.style.cursor=disabled?'default':'pointer';}
  // Highlight active option in dropdown
  ['week','month','quarter','year','all'].forEach(function(t){
    var el=document.getElementById('dpopt-'+t);
    if(el){el.style.fontWeight=t===dailyPeriod?'700':'400';el.style.color=t===dailyPeriod?'var(--accent)':'var(--text-0)';}
  });
}

function toggleDailyDropdown(show){
  var dd=document.getElementById('dailyPeriodDropdown');
  if(!dd)return;
  if(show===undefined) dd.style.display=dd.style.display==='none'?'':'none';
  else dd.style.display=show?'':'none';
}

function setDailyPeriod(period){
  dailyPeriod=period;
  dailyNavMode=period==='custom'?dailyNavMode:period;
  toggleDailyDropdown(false);
  var today=_today();
  if(period==='week'){dailyFrom=_startOfWeek(today);dailyTo=today;dailyIncludeToday=true;}
  else if(period==='month'){dailyFrom=_startOfMonth(today);dailyTo=today;dailyIncludeToday=true;}
  else if(period==='quarter'){dailyFrom=_startOfQuarter(today);dailyTo=today;dailyIncludeToday=true;}
  else if(period==='year'){dailyFrom=new Date(today.getFullYear(),0,1);dailyTo=today;dailyIncludeToday=true;}
  else if(period==='all'){dailyFrom=null;dailyTo=null;dailyIncludeToday=true;}
  // 'custom' — range set by applyDailyCustomRange
  _updateDailyNavUI();
  if(period!=='custom') reloadDailyChart();
}

function navigateDailyPeriod(dir){
  if(dailyPeriod==='all') return;
  var mode=dailyNavMode||dailyPeriod;
  var today=_today();
  if(mode==='week'){
    dailyFrom=new Date(dailyFrom);dailyFrom.setDate(dailyFrom.getDate()+dir*7);
    dailyTo=new Date(dailyFrom);dailyTo.setDate(dailyTo.getDate()+6);
  } else if(mode==='month'){
    var ref=new Date(dailyFrom);ref.setMonth(ref.getMonth()+dir);
    dailyFrom=_startOfMonth(ref);dailyTo=_endOfMonth(ref);
  } else if(mode==='quarter'){
    var ref=new Date(dailyFrom);ref.setMonth(ref.getMonth()+dir*3);
    dailyFrom=_startOfQuarter(ref);dailyTo=_endOfQuarter(ref);
  } else if(mode==='year'){
    var y=dailyFrom.getFullYear()+dir;
    dailyFrom=new Date(y,0,1);dailyTo=new Date(y,11,31);
  } else {
    // custom/fallback: shift by range duration
    var dur=(dailyTo?dailyTo.getTime():today.getTime())-(dailyFrom?dailyFrom.getTime():today.getTime());
    if(dur<=0) dur=86400000;
    dailyFrom=new Date((dailyFrom?dailyFrom.getTime():today.getTime())+dir*dur);
    dailyTo=new Date((dailyTo?dailyTo.getTime():today.getTime())+dir*dur);
  }
  // Cap future: if range end is >= today, use today as end and include live data
  if(dailyTo>today){dailyTo=today;dailyIncludeToday=true;}
  else{dailyIncludeToday=false;}
  dailyNavMode=mode;
  _updateDailyNavUI();
  reloadDailyChart();
}

function applyDailyCustomRange(){
  var fEl=document.getElementById('dailyCustomFrom'),tEl=document.getElementById('dailyCustomTo');
  var fStr=fEl?fEl.value:'',tStr=tEl?tEl.value:'';
  if(!fStr||!tStr){showToast('Укажите обе даты','error');return;}
  dailyFrom=new Date(fStr+'T00:00:00');
  dailyTo=new Date(tStr+'T00:00:00');
  var today=_today();
  dailyIncludeToday=_toYMD(dailyTo)===_toYMD(today);
  dailyPeriod='custom';
  dailyNavMode='custom';
  toggleDailyDropdown(false);
  _updateDailyNavUI();
  reloadDailyChart();
}

function setChartView(mode){
  chartViewMode=mode;
  ['location','all'].forEach(function(m){
    var btn=document.getElementById('cvbtn-'+m);
    if(btn){
      btn.style.background=m===mode?'var(--accent)':'transparent';
      btn.style.color=m===mode?'#fff':'var(--text-2)';
      btn.style.fontWeight=m===mode?'600':'400';
    }
  });
  reloadDailyChart();
}
function setModemBarLimit(limit){
  modemBarLimit=limit;
  var b10=document.getElementById('mbtn-top10');
  var bAll=document.getElementById('mbtn-all');
  if(b10){b10.style.background=limit===10?'var(--accent)':'transparent';b10.style.color=limit===10?'#fff':'var(--text-2)';b10.style.fontWeight=limit===10?'600':'400';}
  if(bAll){bAll.style.background=limit===0?'var(--accent)':'transparent';bAll.style.color=limit===0?'#fff':'var(--text-2)';bAll.style.fontWeight=limit===0?'600':'400';}
  renderModemBar();
}
function renderModemBar(){
  if(!sortedModemData.length) return;
  var isDark=document.documentElement.getAttribute('data-theme')!=='light';
  var textColor=isDark?'#c9d1d9':'#24292f';
  var gridColor=isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.08)';
  var data=modemBarLimit>0?sortedModemData.slice(0,modemBarLimit):sortedModemData;
  var barCount=data.length;
  var barH=Math.max(260, barCount*34+40);
  var mWrap=document.getElementById('analyticsModemWrap');
  if(mWrap) mWrap.style.height=barH+'px';
  // Sorted DESC → index 0 is top in horizontal bar → highest at top, no reverse needed
  var labels=data.map(function(r){return r.modemNick+(r.operator?' ('+r.operator+')':'')});
  var dataIn=data.map(function(r){return+(r.monthIn/1073741824).toFixed(2)});
  var dataOut=data.map(function(r){return+(r.monthOut/1073741824).toFixed(2)});
  var solidColors=['#1960C9','#e67e22'];
  var genBarLabels=function(chart){
    var labs=Chart.defaults.plugins.legend.labels.generateLabels(chart);
    labs.forEach(function(l,i){l.fillStyle=solidColors[i]||l.fillStyle;l.strokeStyle='transparent';l.lineWidth=0;});
    return labs;
  };
  if(analyticsCharts.modem){
    var ch=analyticsCharts.modem;
    ch.data.labels=labels;
    ch.data.datasets[0].data=dataIn;
    ch.data.datasets[1].data=dataOut;
    ch.options.plugins.legend.labels.generateLabels=genBarLabels;
    ch.update('none');
    return;
  }
  var ctx1=document.getElementById('analyticsModemChart').getContext('2d');
  analyticsCharts.modem=new Chart(ctx1,{type:'bar',data:{labels:labels,datasets:[
    {label:'Входящий (GB)',data:dataIn,backgroundColor:'rgba(25,96,201,0.75)',borderRadius:3},
    {label:'Исходящий (GB)',data:dataOut,backgroundColor:'rgba(230,126,34,0.65)',borderRadius:3}
  ]},options:{
    indexAxis:'y',
    responsive:true,maintainAspectRatio:false,
    plugins:{legend:{position:'top',labels:{color:textColor,font:{size:11},boxWidth:10,padding:12,generateLabels:genBarLabels}}},
    scales:{
      x:{stacked:true,ticks:{color:textColor,font:{size:10},callback:function(v){return v+' GB'}},grid:{color:gridColor}},
      y:{stacked:true,ticks:{color:textColor,font:{size:11}},grid:{display:false}}
    }
  }});
}

// Close dropdown on outside click
document.addEventListener('click',function(e){
  var dd=document.getElementById('dailyPeriodDropdown');
  var btn=document.getElementById('dailyPeriodBtn');
  if(dd&&btn&&!btn.contains(e.target)&&!dd.contains(e.target)){dd.style.display='none';}
});

function renderAnalytics(){
  if(!tableData||!tableData.length) return;

  document.getElementById('analyticsSummary').style.display='';
  // Last hour card in analytics
  if(billingData&&billingData.lastHourGb>0){
    var lhGb=billingData.lastHourGb;
    var lhStr=lhGb>=1?lhGb.toFixed(2)+' ГБ':Math.round(lhGb*1024)+' МБ';
    document.getElementById('lastHourValue').textContent=lhStr;
    document.getElementById('lastHourCard').style.display='';
  }
  document.getElementById('analyticsMonthTotal').textContent='...';
  document.getElementById('analyticsAvgDay').textContent='...';
  document.getElementById('analyticsAvgPerModem').textContent='...';
  document.getElementById('analyticsMonthForecast').textContent='...';
  document.getElementById('analyticsForecastSub').textContent='';
  document.getElementById('analyticsMonthTrend').textContent='';

  // Destroy old charts on first render
  if(!analyticsLoaded){
    for(var k in analyticsCharts){if(analyticsCharts[k]){analyticsCharts[k].destroy();delete analyticsCharts[k]}}
    analyticsLoaded=true;
    setDailyPeriod('month');
  } else {
    reloadDailyChart();
  }
}

function reloadDailyChart(){
  var isDark=document.documentElement.getAttribute('data-theme')!=='light';
  var textColor=isDark?'#c9d1d9':'#24292f';
  var gridColor=isDark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.08)';
  // Don't destroy chart before API call — update in-place to avoid layout jump
  loadDailyTrafficChart(textColor,gridColor);
}

function loadDailyTrafficChart(textColor,gridColor){
  var loading=document.getElementById('dailyChartLoading');
  var r=getDailyPeriodRange();
  var fromDate=r.from;
  var toDate=r.to;
  var includeToday=r.includeToday;
  var url='/api/client/daily_traffic?';
  if(fromDate) url+='from='+fromDate+'&';
  if(toDate) url+='to='+toDate+'&';
  if(includeToday) url+='include_today=1&';
  fetch(url,{headers:{'X-Auth-Token':authToken}})
  .then(function(r){return r.json()})
  .then(function(data){
    if(loading)loading.style.display='none';

    // Collect all dates
    var allDates=new Set();
    var daily=data.daily||{};
    var today=data.today||{};
    var todayDate=data.todayDate||'';

    for(var pn in daily){
      for(var d in daily[pn]) allDates.add(d);
    }
    // Add today only if checkbox is checked and data exists
    if(includeToday&&todayDate&&Object.keys(today).length>0) allDates.add(todayDate);

    var dates=Array.from(allDates).sort();
    if(dates.length===0){
      document.getElementById('dailyChartWrap').style.display='none';
      document.getElementById('dailyChartEmpty').style.display='flex';
      return;
    }
    document.getElementById('dailyChartWrap').style.display='';
    document.getElementById('dailyChartEmpty').style.display='none';

    // Build per-modem datasets + total
    var modemNicks={};// portId -> nick
    tableData.forEach(function(r){modemNicks[r.portId]=r.modemNick});

    // Aggregate by nick
    var nickTotals={};// nick -> { date -> total GB }
    var totalByDate={};

    // Process historical daily data
    for(var pn in daily){
      for(var d in daily[pn]){
        var entry=daily[pn][d];
        var nick=entry.nick||pn;
        if(modemNicks[nick]) nick=modemNicks[nick];
        if(!nickTotals[nick]) nickTotals[nick]={};
        var gb=(entry.in+entry.out)/1073741824;
        nickTotals[nick][d]=(nickTotals[nick][d]||0)+gb;
        totalByDate[d]=(totalByDate[d]||0)+gb;
      }
    }

    // Add today's live data (only if checkbox checked)
    if(includeToday&&todayDate){
      for(var portId in today){
        var entry=today[portId];
        var nick=modemNicks[portId]||entry.nick||portId;
        if(!nickTotals[nick]) nickTotals[nick]={};
        var gb=(entry.in+entry.out)/1073741824;
        nickTotals[nick][todayDate]=(nickTotals[nick][todayDate]||0)+gb;
        totalByDate[todayDate]=(totalByDate[todayDate]||0)+gb;
      }
    }

    // Format date labels as DD.MM
    var dateLabels=dates.map(function(d){var parts=d.split('-');return parts[2]+'.'+parts[1]});

    // Colors for modems
    var modemColors=['#1960C9','#34C759','#FF383C','#FFCC00','#9b59b6','#e67e22','#1abc9c','#e74c3c','#3498db','#2ecc71','#f39c12','#8e44ad','#00bcd4','#ff5722','#795548','#607d8b','#cddc39','#ff9800','#4caf50','#2196f3'];

    var datasets=[];
    var nickList=Object.keys(nickTotals).sort(function(a,b){
      var ta=0,tb=0;
      for(var d in nickTotals[a])ta+=nickTotals[a][d];
      for(var d in nickTotals[b])tb+=nickTotals[b][d];
      return tb-ta;
    });

    // --- Top-day card update ---
    var peakDate='',peakVal=0;
    for(var dd in totalByDate){if(totalByDate[dd]>peakVal){peakVal=totalByDate[dd];peakDate=dd;}}
    var tdEl=document.getElementById('analyticsTopDay');
    var tdDEl=document.getElementById('analyticsTopDayDate');
    if(tdEl&&peakDate){
      tdEl.textContent=peakVal.toFixed(1)+' GB';
      var pp=peakDate.split('-');tdDEl.textContent=(pp[2]||'')+'.'+(pp[1]||'')+'.'+( pp[0]||'');
    }

    // === Update ALL analytics from filtered daily data ===
    // Total traffic for period
    var periodTotalIn=0,periodTotalOut=0;
    for(var pn in daily){
      for(var d in daily[pn]){
        periodTotalIn+=(daily[pn][d].in||0);
        periodTotalOut+=(daily[pn][d].out||0);
      }
    }
    if(includeToday&&todayDate){
      for(var pid in today){
        periodTotalIn+=(today[pid].in||0);
        periodTotalOut+=(today[pid].out||0);
      }
    }
    var periodTotal=periodTotalIn+periodTotalOut;
    document.getElementById('analyticsMonthTotal').textContent=formatBytes(periodTotal);

    // Daily average (non-zero days)
    var dayTotalsAvg={};
    for(var pn2 in daily){
      for(var d2 in daily[pn2]){
        dayTotalsAvg[d2]=(dayTotalsAvg[d2]||0)+(daily[pn2][d2].in||0)+(daily[pn2][d2].out||0);
      }
    }
    var nonZeroDays=[];
    for(var dt in dayTotalsAvg){if(dayTotalsAvg[dt]>0)nonZeroDays.push(dayTotalsAvg[dt]);}
    var modemCount=tableData.length||1;
    var avgDayBytes=nonZeroDays.length?nonZeroDays.reduce(function(a,b){return a+b},0)/nonZeroDays.length:0;
    document.getElementById('analyticsAvgDay').textContent=formatBytes(avgDayBytes);
    document.getElementById('analyticsAvgPerModem').textContent=formatBytes(modemCount?avgDayBytes/modemCount:0)+'/модем';

    // Forecast — only for current month period
    var now2=new Date();
    var curMonthFrom=now2.getFullYear()+'-'+String(now2.getMonth()+1).padStart(2,'0')+'-01';
    var isCurrentMonth=(!fromDate||fromDate<=curMonthFrom)&&(!toDate||toDate>=curMonthFrom);
    var fcEl=document.getElementById('analyticsMonthForecast');
    var fcSub=document.getElementById('analyticsForecastSub');
    if(isCurrentMonth&&periodTotal>0){
      var daysElapsed=now2.getDate();
      var daysInMonth=new Date(now2.getFullYear(),now2.getMonth()+1,0).getDate();
      var daysLeft=daysInMonth-daysElapsed;
      var forecast=periodTotal/daysElapsed*daysInMonth;
      fcEl.textContent=formatBytes(forecast);
      fcSub.textContent='ещё '+daysLeft+' дн. в месяце';
    } else {
      fcEl.textContent='—';
      fcSub.textContent='не текущий месяц';
    }

    // Trend vs prev month — hide if not current month
    var trendEl=document.getElementById('analyticsMonthTrend');
    if(trendEl) trendEl.textContent='';

    // Per-modem aggregation for bar chart
    var modemAgg={};// nick -> {in, out, nick, operator, serverName}
    for(var pn3 in daily){
      var modemRow=null;
      tableData.forEach(function(r){if(r.portId===pn3||r.modemNick===pn3) modemRow=r;});
      var mNick=modemRow?modemRow.modemNick:pn3;
      var mOp=modemRow?modemRow.operator:'';
      var mSn=modemRow?modemRow.serverName:'??';
      if(!modemAgg[mNick]) modemAgg[mNick]={in:0,out:0,nick:mNick,operator:mOp,serverName:mSn};
      for(var d3 in daily[pn3]){
        modemAgg[mNick].in+=(daily[pn3][d3].in||0);
        modemAgg[mNick].out+=(daily[pn3][d3].out||0);
      }
    }
    if(includeToday&&todayDate){
      for(var pid2 in today){
        var mr2=null;
        tableData.forEach(function(r){if(r.portId===pid2) mr2=r;});
        var mNick2=mr2?mr2.modemNick:pid2;
        var mOp2=mr2?mr2.operator:'';
        var mSn2=mr2?mr2.serverName:'??';
        if(!modemAgg[mNick2]) modemAgg[mNick2]={in:0,out:0,nick:mNick2,operator:mOp2,serverName:mSn2};
        modemAgg[mNick2].in+=(today[pid2].in||0);
        modemAgg[mNick2].out+=(today[pid2].out||0);
      }
    }
    var modemList=Object.values(modemAgg).sort(function(a,b){return(b.in+b.out)-(a.in+a.out)});
    sortedModemData=modemList.map(function(m){return{modemNick:m.nick,operator:m.operator,serverName:m.serverName,monthIn:m.in,monthOut:m.out}});
    renderModemBar();

    // Country cards from filtered data
    var _cFlags={'MD':'🇲🇩','RO':'🇷🇴'};
    var _cColors={'MD':{color:'rgba(25,96,201,0.8)',bg:'rgba(25,96,201,0.08)'},'RO':{color:'rgba(52,199,89,0.8)',bg:'rgba(52,199,89,0.08)'}};
    // Group by country instead of server
    var cnByCountry={};
    modemList.forEach(function(m){
      var sn=m.serverName||'??';
      var ci=COUNTRIES[sn]||{};
      var cc=ci.country||'??';
      if(!cnByCountry[cc])cnByCountry[cc]={in:0,out:0,count:0,name:ci.name||sn};
      cnByCountry[cc].in+=m.in;cnByCountry[cc].out+=m.out;cnByCountry[cc].count++;
    });
    var totalGB=periodTotal/1073741824;
    var ccHtml='';
    Object.keys(cnByCountry).sort().forEach(function(cc){
      var cData=cnByCountry[cc];
      var flag=_cFlags[cc]||'🌍';
      var clr=_cColors[cc]||{color:'var(--text-2)',bg:'var(--bg-2)'};
      var gb=(cData.in+cData.out)/1073741824;
      var pct=totalGB>0?Math.round(gb/totalGB*100):0;
      var inGb=(cData.in/1073741824).toFixed(1);
      var outGb=(cData.out/1073741824).toFixed(1);
      ccHtml+='<div style="margin-bottom:14px">';
      ccHtml+='<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">';
      ccHtml+='<span style="font-size:13px;font-weight:600;color:var(--text-0)">'+flag+' '+cData.name+'</span>';
      ccHtml+='<span style="font-size:12px;color:var(--text-1);font-weight:700">'+gb.toFixed(1)+' GB</span>';
      ccHtml+='</div>';
      ccHtml+='<div style="background:var(--bg-2);border-radius:4px;height:7px;overflow:hidden;margin-bottom:4px"><div style="background:'+clr.color+';height:100%;width:'+pct+'%;border-radius:4px;transition:width .4s"></div></div>';
      ccHtml+='<div style="font-size:11px;color:var(--text-3)">↓ '+inGb+' GB &nbsp;↑ '+outGb+' GB &nbsp;·&nbsp; '+cData.count+' мод. &nbsp;·&nbsp; '+pct+'%</div>';
      ccHtml+='</div>';
    });
    var ccEl=document.getElementById('analyticsCountryCards');
    if(ccEl) ccEl.innerHTML=ccHtml||'<div style="color:var(--text-3);font-size:13px">Нет данных</div>';

    // In/Out cards from filtered data
    var inGbTotal=periodTotalIn/1073741824,outGbTotal=periodTotalOut/1073741824;
    var inPct=periodTotal>0?Math.round(periodTotalIn/periodTotal*100):0;
    var outPct=100-inPct;
    var ioHtml=
      '<div style="display:flex;gap:16px;margin-bottom:18px">'+
      '<div style="flex:1;text-align:center;padding:14px;background:rgba(25,96,201,0.07);border-radius:10px;border:1px solid rgba(25,96,201,0.15)">'+
      '<div style="font-size:20px;font-weight:700;color:rgba(25,96,201,0.9)">↓ '+inGbTotal.toFixed(1)+' GB</div>'+
      '<div style="font-size:11px;color:var(--text-3);margin-top:3px">Входящий · '+inPct+'%</div>'+
      '</div>'+
      '<div style="flex:1;text-align:center;padding:14px;background:rgba(230,126,34,0.07);border-radius:10px;border:1px solid rgba(230,126,34,0.15)">'+
      '<div style="font-size:20px;font-weight:700;color:rgba(230,126,34,0.9)">↑ '+outGbTotal.toFixed(1)+' GB</div>'+
      '<div style="font-size:11px;color:var(--text-3);margin-top:3px">Исходящий · '+outPct+'%</div>'+
      '</div>'+
      '</div>'+
      '<div style="background:var(--bg-2);border-radius:6px;height:10px;overflow:hidden;display:flex">'+
      '<div style="background:rgba(25,96,201,0.75);width:'+inPct+'%;transition:width .4s"></div>'+
      '<div style="background:rgba(230,126,34,0.65);flex:1"></div>'+
      '</div>'+
      '<div style="font-size:11px;color:var(--text-3);margin-top:6px;text-align:center">Всего '+formatBytes(periodTotal)+'</div>';
    var ioEl=document.getElementById('analyticsInOutCards');
    if(ioEl) ioEl.innerHTML=ioHtml;

    // --- Build datasets based on chartViewMode ---
    if(chartViewMode==='total'){
      // Only ИТОГО line
      var totalData=dates.map(function(d){return+(totalByDate[d]||0).toFixed(3)});
      datasets.push({label:'ИТОГО',data:totalData,borderColor:'#1960C9',backgroundColor:'rgba(25,96,201,0.08)',borderWidth:2.5,pointRadius:3,tension:0.35,fill:true});

    } else if(chartViewMode==='location'){
      // Aggregate by serverName (S1=Moldova, S2=Romania)
      var locTotals={};
      for(var pn in daily){
        var firstEntry=Object.values(daily[pn])[0];
        // Try to find serverName from tableData portId
        var sn='??';
        tableData.forEach(function(r){if(r.portId===pn||r.modemNick===pn) sn=r.serverName||'??';});
        if(!locTotals[sn]) locTotals[sn]={};
        for(var d in daily[pn]){
          var e=daily[pn][d];
          var gb=(e.in+e.out)/1073741824;
          locTotals[sn][d]=(locTotals[sn][d]||0)+gb;
        }
      }
      // Add today's data to locTotals if included
      if(includeToday&&todayDate){
        for(var portId in today){
          var sn2='??';
          tableData.forEach(function(r){if(r.portId===portId) sn2=r.serverName||'??';});
          if(!locTotals[sn2]) locTotals[sn2]={};
          var gb2=(today[portId].in+today[portId].out)/1073741824;
          locTotals[sn2][todayDate]=(locTotals[sn2][todayDate]||0)+gb2;
        }
      }
      var _locFlags={'MD':'🇲🇩','RO':'🇷🇴'};
      var _locClr={'MD':{color:'rgba(25,96,201,0.85)',bg:'rgba(25,96,201,0.08)'},'RO':{color:'rgba(52,199,89,0.85)',bg:'rgba(52,199,89,0.08)'}};
      // Aggregate locTotals by country
      var locByCountry={};
      Object.keys(locTotals).forEach(function(sn){
        var ci=COUNTRIES[sn]||{};var cc=ci.country||sn;
        if(!locByCountry[cc])locByCountry[cc]={dates:{},name:ci.name||sn};
        for(var d in locTotals[sn])locByCountry[cc].dates[d]=(locByCountry[cc].dates[d]||0)+locTotals[sn][d];
      });
      Object.keys(locByCountry).sort().forEach(function(cc){
        var lc=locByCountry[cc];
        var clr=_locClr[cc]||{color:'rgba(255,204,0,0.85)',bg:'rgba(255,204,0,0.08)'};
        var flag=_locFlags[cc]||'🌍';
        var m={name:lc.name+' '+flag,color:clr.color,bg:clr.bg};
        var d2=dates.map(function(d){return+(lc.dates[d]||0).toFixed(3)});
        datasets.push({label:m.name,data:d2,borderColor:m.color,backgroundColor:m.bg,borderWidth:2,pointRadius:3,tension:0.35,fill:true});
      });
      // ИТОГО dashed
      var totalData2=dates.map(function(d){return+(totalByDate[d]||0).toFixed(3)});
      datasets.push({label:'ИТОГО',data:totalData2,borderColor:'rgba(150,150,150,0.8)',backgroundColor:'transparent',borderWidth:1.5,borderDash:[6,3],pointRadius:2,tension:0.35,fill:false});

    } else {
      // All modems — all visible, no ИТОГО
      nickList.forEach(function(nick,i){
        var lineData=dates.map(function(d){return+(nickTotals[nick][d]||0).toFixed(3)});
        datasets.push({label:nick,data:lineData,borderColor:modemColors[i%modemColors.length],backgroundColor:modemColors[i%modemColors.length],borderWidth:1.5,pointRadius:2,tension:0.3,fill:false,hidden:false});
      });
    }

    var genLineLabels=function(chart){
      var labs=Chart.defaults.plugins.legend.labels.generateLabels(chart);
      labs.forEach(function(l){l.fillStyle=l.strokeStyle;l.strokeStyle='transparent';l.lineWidth=0;});
      return labs;
    };
    var ctx=document.getElementById('analyticsDailyChart').getContext('2d');
    if(analyticsCharts.daily){
      var ch=analyticsCharts.daily;
      ch.data.labels=dateLabels;
      ch.data.datasets=datasets;
      ch.options.plugins.legend.labels.generateLabels=genLineLabels;
      ch.update('none');
    } else {
      analyticsCharts.daily=new Chart(ctx,{type:'line',data:{labels:dateLabels,datasets:datasets},options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        plugins:{
          legend:{position:'bottom',labels:{color:textColor,font:{size:10},boxWidth:12,padding:8,usePointStyle:false,generateLabels:genLineLabels}},
          tooltip:{mode:'index',intersect:false,callbacks:{label:function(ctx){return ctx.dataset.label+': '+ctx.parsed.y.toFixed(2)+' GB'}}}
        },
        scales:{
          x:{ticks:{color:textColor,font:{size:10}},grid:{color:gridColor}},
          y:{ticks:{color:textColor,font:{size:10},callback:function(v){return v.toFixed(1)+' GB'}},grid:{color:gridColor}}
        }
      }});
    }
  })
  .catch(function(err){
    if(loading)loading.textContent='Ошибка загрузки: '+err.message;
  });
}

// --- Billing History (Accordion by Month) ---
function loadBillingHistory(){
  fetch('/api/billing_history',{headers:{'X-Auth-Token':authToken}})
  .then(function(r){return r.json()})
  .then(function(data){
    if(data.error){
      document.getElementById('billingAccordion').innerHTML='<div style="text-align:center;padding:40px;color:var(--text-3)">'+esc(data.error)+'</div>';
      return;
    }

    var curr=data.currency||'RUB';
    var cs=curr==='RUB'?'\u20BD':(curr==='USD'?'$':(curr==='EUR'?'\u20AC':curr));

    // Update summary cards
    document.getElementById('billingBalanceVal').textContent=formatNumber(data.balance)+' '+cs;
    document.getElementById('billingBalanceVal').style.color=data.balance>=0?'var(--green)':'var(--red)';
    document.getElementById('billingMonthCharges').textContent=formatNumber(data.summary.monthCharges)+' '+cs;
    document.getElementById('billingAvgDaily').textContent=formatNumber(data.summary.avgDailyCharge7d||0)+' '+cs;
    var duz=data.summary.daysUntilZero;
    var duzEl=document.getElementById('billingDaysUntilZero');
    duzEl.textContent=duz!==null&&duz!==undefined?duz+' дн.':'—';
    duzEl.style.color=duz!==null&&duz<14?'var(--red)':(duz!==null&&duz<30?'var(--yellow)':'var(--green)');

    var entries=data.entries||[];
    if(!entries.length){
      document.getElementById('billingAccordion').innerHTML='<div style="text-align:center;padding:40px;color:var(--text-3)">Нет операций</div>';
      return;
    }

    // Group entries by month (YYYY-MM)
    var monthMap={};
    entries.forEach(function(e){
      var key='unknown';
      if(e.date) key=e.date.slice(0,7);
      else if(e.timestamp) key=e.timestamp.slice(0,7);
      if(!monthMap[key]) monthMap[key]={entries:[],totalCharge:0,totalPayment:0,totalTraffic:0};
      monthMap[key].entries.push(e);
      if(e.type==='charge'){monthMap[key].totalCharge+=(e.cost||0);monthMap[key].totalTraffic+=(e.delta_gb||0)}
      else if(e.type==='correction'){var cd=(e.balance_before!=null&&e.balance_after!=null)?(e.balance_before-e.balance_after):(e.amount||0);monthMap[key].totalCharge+=cd;if(e.delta_gb)monthMap[key].totalTraffic+=(cd>0?e.delta_gb:-e.delta_gb)}
      else if(e.type==='payment'||e.type==='bank_payment'){monthMap[key].totalPayment+=(e.amount||0)}
    });

    var sortedMonths=Object.keys(monthMap).sort().reverse();
    var monthNames=['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    var currentMonth=new Date().toISOString().slice(0,7);

    var html='';
    sortedMonths.forEach(function(monthKey, idx){
      var mg=monthMap[monthKey];
      var parts=monthKey.split('-');
      var mi=parseInt(parts[1]||0,10);
      var monthLabel=(mi>=1&&mi<=12)?monthNames[mi]+' '+parts[0]:monthKey;
      var isOpen=(idx===0);  // first month open by default
      var isCurrent=(monthKey===currentMonth);

      // Month header
      html+='<div style="border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden">';
      html+='<div onclick="toggleBillingMonth(this)" style="cursor:pointer;padding:14px 18px;background:var(--bg-2);display:flex;align-items:center;justify-content:space-between;gap:12px;user-select:none">';
      html+='<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
      html+='<span style="font-size:15px;font-weight:700;color:var(--text-1)">'+monthLabel+'</span>';
      if(isCurrent) html+='<span style="background:var(--green);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px;font-weight:600">Текущий</span>';
      html+='</div>';
      html+='<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">';
      if(mg.totalTraffic>0){
        html+='<div style="text-align:center"><div style="font-size:10px;color:var(--text-3)">Трафик</div><div style="font-size:14px;font-weight:600;color:var(--text-1)">'+mg.totalTraffic.toFixed(2)+' ГБ</div></div>';
      }
      if(mg.totalCharge>0){
        html+='<div style="text-align:center"><div style="font-size:10px;color:var(--text-3)">Списано</div><div style="font-size:14px;font-weight:600;color:var(--red)">-'+formatNumber(mg.totalCharge)+' '+cs+'</div></div>';
      }
      if(mg.totalPayment>0){
        html+='<div style="text-align:center"><div style="font-size:10px;color:var(--text-3)">Оплачено</div><div style="font-size:14px;font-weight:600;color:var(--green)">+'+formatNumber(mg.totalPayment)+' '+cs+'</div></div>';
      }
      html+='<span class="billing-chevron" style="font-size:18px;transition:transform .2s;transform:rotate('+(isOpen?'180':'0')+'deg)">\u25BC</span>';
      html+='</div></div>';

      // Type counts for filter buttons
      var typeCounts={all:mg.entries.length,charge:0,payment:0,correction:0};
      mg.entries.forEach(function(e){
        if(e.type==='charge')typeCounts.charge++;
        else if(e.type==='correction')typeCounts.correction++;
        else if(e.type==='payment'||e.type==='bank_payment')typeCounts.payment++;
      });

      // Month body (entries table)
      html+='<div class="billing-month-body" style="'+(isOpen?'':'display:none;')+'">';
      // Filter bar
      html+='<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:4px;background:var(--bg-1)">';
      [['all','Все'],['charge','Списания'],['payment','Пополнения'],['correction','Корректировки']].forEach(function(f){
        var isActive=f[0]==='all';
        var cnt=typeCounts[f[0]]||0;
        html+='<button onclick="filterBillingMonth(this,\''+monthKey+'\',\''+f[0]+'\')" data-ftype="'+f[0]+'" style="padding:4px 10px;border-radius:6px;border:'+(isActive?'1px solid var(--accent)':'1px solid var(--border)')+';background:'+(isActive?'var(--accent)':'var(--bg-2)')+';color:'+(isActive?'#fff':'var(--text-2)')+';font-size:11px;cursor:pointer;display:flex;align-items:center;gap:5px;font-weight:'+(isActive?'600':'400')+'">'+f[1]+'<span style="font-size:10px;padding:1px 5px;border-radius:8px;background:rgba(0,0,0,0.1);color:inherit">'+cnt+'</span></button>';
      });
      html+='</div>';
      html+='<table data-month="'+monthKey+'" style="width:100%;border-collapse:collapse;font-size:13px">';
      html+='<thead><tr style="background:var(--bg-3)"><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Дата</th><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Тип</th><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Сумма</th><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Трафик</th><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Баланс после</th><th style="padding:8px 12px;text-align:center;color:var(--text-2);font-weight:500">Примечание</th></tr></thead>';
      html+='<tbody>';

      // Sort entries within month: newest first
      mg.entries.sort(function(a,b){
        var da=a.timestamp||a.date||'';
        var db=b.timestamp||b.date||'';
        return db.localeCompare(da);
      });

      mg.entries.forEach(function(e){
        var typeLabel='',typeStyle='',amountStr='',amountStyle='',ftype='other';
        if(e.type==='charge'){typeLabel='Списание';typeStyle='color:var(--red)';amountStr='-'+formatNumber(e.cost||0)+' '+cs;amountStyle='color:var(--red)';ftype='charge';}
        else if(e.type==='correction'){
          var cDelta=(e.balance_before!=null&&e.balance_after!=null)?(e.balance_after-e.balance_before):(e.amount||0);
          var isDebit=cDelta<0;
          typeLabel='Корректировка';typeStyle='color:#8b5cf6';
          amountStr=(isDebit?'':'+') + formatNumber(cDelta) + ' ' + cs;
          amountStyle=isDebit?'color:var(--red)':'color:var(--green)';ftype='correction';
        }
        else if(e.type==='payment'){typeLabel='Пополнение';typeStyle='color:var(--green)';amountStr='+'+formatNumber(e.amount||0)+' '+cs;amountStyle='color:var(--green)';ftype='payment';}
        else if(e.type==='bank_payment'){typeLabel='🏦 Банк';typeStyle='color:#6366f1';amountStr='+'+formatNumber(e.amount||0)+' '+cs;amountStyle='color:var(--green)';ftype='payment';}
        else if(e.type==='payment_reversal'){typeLabel='Отмена';typeStyle='color:var(--orange,#f59e0b)';amountStr=formatNumber(e.amount||0)+' '+cs;amountStyle='color:var(--orange,#f59e0b)';}
        else if(e.type==='adjustment'){typeLabel='Корректировка';typeStyle='color:var(--blue)';amountStr=((e.amount||0)>=0?'+':'')+formatNumber(e.amount||0)+' '+cs;amountStyle=(e.amount||0)>=0?'color:var(--green)':'color:var(--red)';ftype='adjustment';}
        else{typeLabel=e.type||'—';amountStr=(e.cost||e.amount||0)+' '+cs;}

        var dateStr=e.date||'—';
        if(e.timestamp){try{var d=new Date(e.timestamp);dateStr=d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});}catch(ex){}}
        var trafficStr=(e.type==='charge'||e.type==='correction')&&e.delta_gb?e.delta_gb.toFixed(3)+' ГБ':'—';
        var balAfter=e.balance_after!==undefined?formatNumber(e.balance_after)+' '+cs:'—';
        var note=e.note||'';
        var noteTd=note.length>40
          ?'<div style="position:relative;display:inline-block;max-width:180px" class="billing-note-wrap"><span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default">'+escapeHtml(note)+'</span><div class="billing-note-tip">'+escapeHtml(note)+'</div></div>'
          :'<span style="color:var(--text-3)">'+escapeHtml(note)+'</span>';

        html+='<tr data-ftype="'+ftype+'" style="border-bottom:1px solid var(--border)">';
        html+='<td style="padding:7px 12px;text-align:center;white-space:nowrap">'+dateStr+'</td>';
        html+='<td style="padding:7px 12px;text-align:center;font-weight:600;'+typeStyle+'">'+typeLabel+'</td>';
        html+='<td style="padding:7px 12px;text-align:center;font-weight:600;'+amountStyle+'">'+amountStr+'</td>';
        html+='<td style="padding:7px 12px;text-align:center">'+trafficStr+'</td>';
        html+='<td style="padding:7px 12px;text-align:center">'+balAfter+'</td>';
        html+='<td style="padding:7px 12px;text-align:center;max-width:180px">'+noteTd+'</td>';
        html+='</tr>';
      });

      html+='</tbody></table>';
      html+='<div class="billing-empty-filter" style="display:none;text-align:center;padding:20px;font-size:13px;color:var(--text-3)">Нет операций этого типа за выбранный период</div>';
      html+='</div></div>';
    });

    document.getElementById('billingAccordion').innerHTML=html;
  })
  .catch(function(err){
    document.getElementById('billingAccordion').innerHTML='<div style="text-align:center;padding:40px;color:var(--red)">Ошибка загрузки: '+esc(err.message)+'</div>';
  });
}

function filterBillingMonth(btn,monthKey,ftype){
  // Reset all filter buttons in this bar
  var bar=btn.parentElement;
  bar.querySelectorAll('button').forEach(function(b){
    var active=b.getAttribute('data-ftype')===ftype;
    b.style.background=active?'var(--accent)':'var(--bg-2)';
    b.style.color=active?'#fff':'var(--text-2)';
    b.style.border='1px solid '+(active?'var(--accent)':'var(--border)');
    b.style.fontWeight=active?'600':'400';
  });
  // Filter rows in the table for this month
  var table=bar.parentElement.querySelector('table[data-month="'+monthKey+'"]');
  var emptyMsg=bar.parentElement.querySelector('.billing-empty-filter');
  if(!table)return;
  var rows=table.querySelectorAll('tbody tr');
  var visible=0;
  rows.forEach(function(row){
    var show=ftype==='all'||row.getAttribute('data-ftype')===ftype;
    row.style.display=show?'':'none';
    if(show)visible++;
  });
  if(emptyMsg)emptyMsg.style.display=visible===0?'':'none';
}

function toggleBillingMonth(header){
  var body=header.nextElementSibling;
  var chevron=header.querySelector('.billing-chevron');
  if(body.style.display==='none'){
    body.style.display='';
    if(chevron)chevron.style.transform='rotate(180deg)';
  } else {
    body.style.display='none';
    if(chevron)chevron.style.transform='rotate(0deg)';
  }
}

function formatNumber(n){
  if(n===undefined||n===null) return '0';
  return parseFloat(n).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
}

// --- Init ---
(function init(){
  // Support admin impersonation via ?impersonate=TOKEN
  var params=new URLSearchParams(window.location.search);
  var impToken=params.get('impersonate');
  if(impToken){
    authToken=impToken;
    authLogin='(admin view)';
    localStorage.setItem('pr_token',impToken);
    localStorage.setItem('pr_login','(admin view)');
    // Clean URL without reloading
    window.history.replaceState({},'',window.location.pathname);
    console.log('[Impersonate] Token set, calling showApp');
  }
  console.log('[Init] authToken='+(authToken?authToken.slice(0,8)+'...':'(empty)')+', impToken='+(impToken||'none'));
  if(authToken){showApp()}else{showLogin()}
  document.getElementById('passwordInput').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
  document.getElementById('loginInput').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('passwordInput').focus()});
})();

function showLogin(){
  document.getElementById('loginOverlay').style.display='flex';
  document.getElementById('appMain').style.display='none';
  document.getElementById('loginInput').focus();
}

var refreshInterval=null;

function showApp(){
  document.getElementById('loginOverlay').style.display='none';
  document.getElementById('appMain').style.display='block';
  document.getElementById('currentUser').textContent=authLogin;
  loadData();
  if(refreshInterval) clearInterval(refreshInterval);
  refreshInterval=setInterval(loadData,60*60*1000);
}

async function doLogin(){
  var login=document.getElementById('loginInput').value.trim();
  var password=document.getElementById('passwordInput').value;
  var errorEl=document.getElementById('loginError');
  var btn=document.getElementById('btnLogin');

  if(!login||!password){errorEl.textContent='Введите логин и пароль';return}
  btn.disabled=true;errorEl.textContent='';

  try{
    var resp=await fetch('/api/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({login:login,password:password})
    });
    var data=await resp.json();
    if(!resp.ok){errorEl.textContent=data.error||'Ошибка входа';return}
    authToken=data.token;
    authLogin=data.login;
    localStorage.setItem('pr_token',authToken);
    localStorage.setItem('pr_login',authLogin);
    if(data.isAdmin){
      localStorage.setItem('pr_admin_token',authToken);
      window.location.href='/admin';
      return;
    }
    showApp();
  }catch(err){
    errorEl.textContent='Ошибка соединения';
  }finally{
    btn.disabled=false;
  }
}

function doLogout(){
  fetch('/api/logout',{method:'POST',headers:{'X-Auth-Token':authToken}}).catch(function(){});
  authToken='';authLogin='';
  localStorage.removeItem('pr_token');localStorage.removeItem('pr_login');
  tableData=[];billingData=null;rawData=null;
  if(refreshInterval){clearInterval(refreshInterval);refreshInterval=null}
  showLogin();
}

// parseBW and formatBytes moved to /js/utils.js
var parseBW=parseTraffic; // alias for backward compatibility

// Cost display without spaces - use Math.round for proper rounding
function formatCost(amount){
  return Math.round(amount).toString();
}

function formatCurrencyLabel(currency){
  return currency||'';
}

async function fetchJSON(url){
  var resp=await fetch(url,{headers:{'X-Auth-Token':authToken}});
  if(resp.status===401){doLogout();throw new Error('Сессия истекла')}
  if(!resp.ok) throw new Error('HTTP '+resp.status+': '+resp.statusText);
  return resp.json();
}

function setStatus(state,text){
  var dot=document.getElementById('statusDot');
  var txt=document.getElementById('statusText');
  dot.className='status-indicator status-'+state;
  txt.textContent=text;
}

function escapeHtml(str){return esc(str)}

// --- Clipboard with fallback ---
function copyText(t,b){
  function onOk(){if(b){var o=b.innerHTML;b.innerHTML='\u2714';setTimeout(function(){b.innerHTML=o},1500)}showToast('Скопировано','info')}
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(onOk).catch(doFallback)}else{doFallback()}
  function doFallback(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;left:-9999px;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');onOk()}catch(e){showToast('Ошибка','error')}document.body.removeChild(a)}
}

// --- Load Data ---
async function loadData(){
  var btn=document.getElementById('btnRefresh');
  if(btn)btn.disabled=true;
  setStatus('loading','Загрузка...');
  document.getElementById('errorContainer').innerHTML='';

  try{
    var data=await fetchJSON('/api/dashboard_data');
    rawData=data;
    // Populate COUNTRIES from server data
    if(data.servers&&data.servers.length){
      COUNTRIES={};
      data.servers.forEach(function(s){COUNTRIES[s.name]={serverIp:s.publicIp||'',country:s.country||'',name:s.countryName||s.name}});
    }
    var bwData=data.bandwidth;
    var statusData=data.status;
    var portsData=data.ports;
    modemLogins=data.modemLogins||{};
    billingData=data.billing||null;

    var ipTracking=data.ipTracking||{};
    var uptimeTracking=data.uptimeTracking||{};
    var speedtestLatest=data.speedtestLatest||{};

    var modemMap={};
    if(Array.isArray(statusData)){
      statusData.forEach(function(m){
        var imei=m.modem_details&&m.modem_details.IMEI;
        if(imei){
          modemMap[imei]={
            nick:m.modem_details.NICK||imei,
            model:m.modem_details.MODEL_SHOWN||m.modem_details.MODEL||'',
            online:(m.net_details&&m.net_details.IS_ONLINE)||'no',
            extIp:(m.net_details&&m.net_details.EXT_IP)||'',
            operator:(function(){var raw=(m.net_details&&m.net_details.CELLOP)||'';var n={'unite':'Moldtelecom','orange':'Orange','vodafone ro':'Vodafone RO','moldtelecom':'Moldtelecom'};return n[raw.toLowerCase()]||raw})(),
            networkType:(m.net_details&&m.net_details.CurrentNetworkType)||'',
            server:m._server||'',
            autoRotation:m.modem_details.AUTO_IP_ROTATION||'',
            timeToRotation:m.modem_details.TIME_TO_IP_ROTATION||''
          };
        }
      });
    }

    var portImeiMap={};
    if(portsData&&typeof portsData==='object'){
      for(var imeiKey in portsData){
        var ports=portsData[imeiKey];
        if(Array.isArray(ports)){
          ports.forEach(function(p){if(p.portID) portImeiMap[p.portID]=imeiKey});
        }
      }
    }

    tableData=[];
    if(bwData&&typeof bwData==='object'){
      for(var portId in bwData){
        var bw=bwData[portId];
        var imei=portImeiMap[portId]||'';
        var modem=modemMap[imei]||{nick:imei||'?',model:'',online:'?',extIp:'',operator:'',networkType:'',server:''};

        var country=modem.nick.startsWith('MD')?'MD':modem.nick.startsWith('RO')?'RO':'??';
        var serverName=modem.server||bw._server||(imei.match(/^(S\d+)_/)?imei.match(/^(S\d+)_/)[1]:'')||(portId.match(/^(S\d+)_/)?portId.match(/^(S\d+)_/)[1]:'');
        var rawImei=imei.replace(/^S\d+_/,'');

        // IP tracking info
        var ipInfo=ipTracking[imei]||null;

        // Uptime percentage — prefer 30-day window from server, fall back to all-time
        var uptimePct=null;
        if(uptimeTracking[imei]){
          var ut=uptimeTracking[imei];
          if(ut.uptime30d!==null&&ut.uptime30d!==undefined){
            uptimePct=parseFloat(ut.uptime30d).toFixed(1);
          } else if(ut.total_checks>0){
            uptimePct=(ut.online_checks/ut.total_checks*100).toFixed(1);
          }
        }

        // Speed
        var speedDl=0,speedUl=0;
        if(speedtestLatest[imei]){
          speedDl=speedtestLatest[imei].download||0;
          speedUl=speedtestLatest[imei].upload||0;
        }

        // Port info
        var portInfo=null;
        if(portsData&&portsData[imei]&&Array.isArray(portsData[imei])){
          portInfo=portsData[imei][0];
        }

        tableData.push({
          portId:portId,
          imei:imei,
          rawImei:rawImei,
          serverName:serverName,
          country:country,
          modemNick:modem.nick,
          modemLogin:modemLogins[modem.nick]||'',
          modemModel:modem.model,
          online:modem.online,
          extIp:modem.extIp,
          ipSince:ipInfo&&ipInfo.since?ipInfo.since:null,
          operator:modem.operator,
          networkType:modem.networkType,
          portName:bw.portName||portId,
          uptimePct:uptimePct,
          speedDl:speedDl,
          speedUl:speedUl,
          httpPort:portInfo?portInfo.HTTP_PORT:'',
          socksPort:portInfo?portInfo.SOCKS_PORT:'',
          proxyLogin:portInfo?portInfo.LOGIN:'',
          proxyPassword:portInfo?portInfo.PASSWORD:'',
          httpCreds:portInfo?portInfo.http_creds:'',
          socks5Creds:portInfo?portInfo.socks5_creds:'',
          resetSecureLink:portInfo&&portInfo.RESET_SECURE_LINK?portInfo.RESET_SECURE_LINK.URL:'',
          autoRotation:modem.autoRotation||'',
          timeToRotation:modem.timeToRotation||'',
          dayIn:parseBW(bw.bandwidth_bytes_day_in),
          dayOut:parseBW(bw.bandwidth_bytes_day_out),
          yesterdayIn:parseBW(bw.bandwidth_bytes_yesterday_in),
          yesterdayOut:parseBW(bw.bandwidth_bytes_yesterday_out),
          monthIn:parseBW(bw.bandwidth_bytes_month_in),
          monthOut:parseBW(bw.bandwidth_bytes_month_out),
          _cached:!!bw._cached,
          _offline:!!bw._offline,
          _end:0
        });
      }
    }

    // Show warning if some servers returned cached data
    var cachedServers=data.cachedServers||[];
    if(cachedServers.length>0){
      var cacheWarnings=cachedServers.map(function(s){
        var ago=Math.round((Date.now()-s.cachedAt)/60000);
        return s.name+' (данные '+ago+' мин. назад)';
      }).join(', ');
      document.getElementById('errorContainer').innerHTML=
        '<div style="padding:10px 16px;background:rgba(255,204,0,0.15);border:1px solid rgba(255,204,0,0.3);border-radius:8px;color:var(--warning);font-size:12px;margin-bottom:12px">'+
        '\u26A0\uFE0F Сервер недоступен: '+escapeHtml(cacheWarnings)+'. Трафик и доступы отображаются из кеша. Модемы помечены как offline.</div>';
    }

    try{renderTable()}catch(e){console.error('[loadData] renderTable:',e)}
    try{renderProxyTable()}catch(e){console.error('[loadData] renderProxyTable:',e)}
    try{updateSummary()}catch(e){console.error('[loadData] updateSummary:',e)}
    try{initOnboarding()}catch(e){console.error('[loadData] initOnboarding:',e)}

    // Restore saved tab
    var _savedTab=localStorage.getItem('pr_active_tab');
    if(_savedTab){var _tabEl=document.querySelector('.nav-tab[onclick*="\''+_savedTab+'\'"]');if(_tabEl)switchTab(_savedTab,_tabEl)}

    var now=new Date().toLocaleString('ru-RU');
    document.getElementById('lastUpdate').textContent='Обновлено: '+now;
    setStatus(cachedServers.length>0?'loading':'ok',cachedServers.length>0?'Частичные данные':'OK');

  }catch(err){
    if(err.message==='Сессия истекла') return;
    setStatus('error','Ошибка');
    document.getElementById('errorContainer').innerHTML=
      '<div class="error-msg">Не удалось загрузить данные: '+escapeHtml(err.message)+'</div>';
  }finally{
    if(btn)btn.disabled=false;
  }
}

// Traffic table: 8 columns: Модем, Реквизиты, Логин:Пароль, Смена IP, Ротация, Сегодня, Вчера, Месяц
function renderTable(){
  var rows=tableData.slice();


  rows.sort(function(a,b){
    var ca=countryOrder.indexOf(a.country);
    var cb=countryOrder.indexOf(b.country);
    if(ca!==cb) return ca-cb;

    var va=a[currentSort.key];
    var vb=b[currentSort.key];
    if(va===null||va===undefined) va='';
    if(vb===null||vb===undefined) vb='';
    if(typeof va==='string'&&typeof vb==='string'){va=va.toLowerCase();vb=vb.toLowerCase()}
    if(va<vb) return currentSort.dir==='asc'?-1:1;
    if(va>vb) return currentSort.dir==='asc'?1:-1;
    return 0;
  });

  var groups={};
  for(var i=0;i<rows.length;i++){
    var r=rows[i];
    if(!groups[r.country]) groups[r.country]=[];
    groups[r.country].push(r);
  }

  var html='';

  for(var ci=0;ci<countryOrder.length;ci++){
    var country=countryOrder[ci];
    var groupRows=groups[country];
    if(!groupRows||groupRows.length===0) continue;

    var name=countryNames[country]||country;
    var count=groupRows.length;

    // colspan=8 for 8 columns (Модем, Реквизиты, Логин:Пароль, Смена IP, Ротация, Сегодня, Вчера, Месяц)
    html+='<tr class="country-header">'+
      '<td colspan="8">'+
        name+
        '<span class="country-count">'+count+' модемов</span>'+
      '</td>'+
    '</tr>';

    for(var k=0;k<groupRows.length;k++){
      var row=groupRows[k];

      // Arrow notation for traffic
      var dayHtml='\u2193 '+formatBytes(row.dayIn)+' / \u2191 '+formatBytes(row.dayOut);
      var yesterdayHtml='\u2193 '+formatBytes(row.yesterdayIn)+' / \u2191 '+formatBytes(row.yesterdayOut);
      var monthHtml='\u2193 '+formatBytes(row.monthIn)+' / \u2191 '+formatBytes(row.monthOut);

      // Status dot: online=green, rotating/IP_RESET=yellow blinking, offline=blue
      var statusDotCls;
      if(row.extIp==='IP_RESET'||row.online==='rotating'){statusDotCls='rotating'}
      else if(row.online==='yes'){statusDotCls='online'}
      else{statusDotCls='offline'}

      // Реквизиты cell: HTTP and SOCKS5 on separate lines with labels
      var ci2=COUNTRIES[row.serverName]||{};
      var serverIp=ci2.serverIp||'';
      var reqHtml='-';
      if(row.httpPort||row.socksPort){
        reqHtml='';
        if(row.httpPort){
          reqHtml+='<div><span style="color:var(--text-2);font-size:11px">HTTP:</span> <span class="mono">'+serverIp+':'+row.httpPort+'</span> <button class="copy-btn" onclick="copyText(\''+serverIp+':'+row.httpPort+'\',this)">\ud83d\udccb</button></div>';
        }
        if(row.socksPort){
          reqHtml+='<div><span style="color:var(--text-2);font-size:11px">SOCKS5:</span> <span class="mono">'+serverIp+':'+row.socksPort+'</span> <button class="copy-btn" onclick="copyText(\''+serverIp+':'+row.socksPort+'\',this)">\ud83d\udccb</button></div>';
        }
      }

      // Логин:Пароль cell: one line, plain text, single copy button
      var loginPassHtml='-';
      if(row.proxyLogin||row.proxyPassword){
        var loginPassStr=escapeHtml(row.proxyLogin)+':'+escapeHtml(row.proxyPassword);
        loginPassHtml='<span class="mono">'+loginPassStr+'</span> <button class="copy-btn" onclick="copyText(\''+escapeHtml(row.proxyLogin)+':'+escapeHtml(row.proxyPassword)+'\',this)">\ud83d\udccb</button>';
      }

      // Смена IP cell: reset link + copy button + IP history button
      var changeIpHtml='';
      if(row.resetSecureLink){
        changeIpHtml+='<a href="'+escapeHtml(row.resetSecureLink)+'" target="_blank" style="color:var(--accent);text-decoration:none;font-size:12px" title="Сброс IP">\ud83d\udd04 Сброс</a> ';
        changeIpHtml+='<button class="copy-btn" onclick="copyText(\''+escapeHtml(row.resetSecureLink).replace(/'/g,"\\'")+'\',this)" title="Копировать ссылку">\ud83d\udccb</button> ';
      }else{
        changeIpHtml+='<button class="action-btn-sm" onclick="resetIp(\''+escapeHtml(row.rawImei)+'\',\''+escapeHtml(row.serverName)+'\',this)" title="Сброс IP">\ud83d\udd04</button> ';
      }
      changeIpHtml+='<button class="action-btn-sm" onclick="showIpHistory(\''+escapeHtml(row.modemNick)+'\',\''+escapeHtml(row.serverName)+'\',\''+escapeHtml(row.imei)+'\')" title="IP история" style="font-size:12px">\ud83d\udcc3</button>';

      var rowStyle=row._cached?'opacity:0.6':(row._offline?'opacity:0.45':'');
      html+='<tr style="'+rowStyle+'">'+
        '<td>'+
          '<div style="display:flex;align-items:center;gap:10px">'+
            '<span class="status-dot '+statusDotCls+'"></span>'+
            '<div style="display:flex;flex-direction:column;gap:2px">'+
              '<span class="modem-nick">'+escapeHtml(row.modemNick)+'</span>'+
              (row._offline?' <span style="font-size:9px;color:var(--danger);font-weight:600;background:rgba(239,68,68,0.15);padding:1px 5px;border-radius:3px" title="Модем отключён от сервера">OFFLINE</span>':'')+
              (row._cached&&!row._offline?' <span style="font-size:9px;color:var(--warning);font-weight:600" title="Данные из кеша — сервер недоступен">КЕШ</span>':'')+
              '<span style="font-size:11px;color:var(--text-3)">'+escapeHtml(row.operator)+'</span>'+
            '</div>'+
          '</div>'+
        '</td>'+
        '<td>'+reqHtml+'</td>'+
        '<td>'+loginPassHtml+'</td>'+
        '<td style="text-align:center;white-space:nowrap">'+changeIpHtml+'</td>'+
        '<td style="text-align:center;white-space:nowrap">'+buildRotationCell(row)+'</td>'+
        '<td style="text-align:center;white-space:nowrap">'+dayHtml+'</td>'+
        '<td style="text-align:center;white-space:nowrap">'+yesterdayHtml+'</td>'+
        '<td style="text-align:center;white-space:nowrap">'+monthHtml+'</td>'+
      '</tr>';
    }
  }

  document.getElementById('tableBody').innerHTML=html;
  document.getElementById('loading').style.display='none';
  document.getElementById('dataTable').style.display='table';

  document.querySelectorAll('.sort-arrow').forEach(function(el){el.textContent=''});
  var arrow=document.getElementById('sort_'+currentSort.key);
  if(arrow) arrow.textContent=currentSort.dir==='asc'?'\u25B2':'\u25BC';

  // Mobile cards rendering
  var mobileHtml='';
  for(var mci=0;mci<countryOrder.length;mci++){
    var country=countryOrder[mci];
    var groupRows=groups[country];
    if(!groupRows||groupRows.length===0) continue;
    var cname=countryNames[country]||country;
    mobileHtml+='<div class="mc-location-header">'+cname+' \u2014 '+groupRows.length+' \u043c\u043e\u0434\u0435\u043c\u043e\u0432</div>';
    for(var mk=0;mk<groupRows.length;mk++){
      var mrow=groupRows[mk];
      var mci2=COUNTRIES[mrow.serverName]||{};
      var mServerIp=mci2.serverIp||'';
      var mStatusCls;
      if(mrow.extIp==='IP_RESET'||mrow.online==='rotating'){mStatusCls='rotating'}
      else if(mrow.online==='yes'){mStatusCls='online'}
      else{mStatusCls='offline'}
      var mTodayVal=formatBytes((mrow.dayIn||0)+(mrow.dayOut||0));
      var mYestVal=formatBytes((mrow.yesterdayIn||0)+(mrow.yesterdayOut||0));
      var mMonthVal=formatBytes((mrow.monthIn||0)+(mrow.monthOut||0));
      var mUid='mc_'+mci+'_'+mk;
      mobileHtml+='<div class="mc" id="'+mUid+'">';
      mobileHtml+='<div class="mc-top" onclick="toggleMc(\''+mUid+'\')">';
      mobileHtml+='<div class="mc-left">';
      mobileHtml+='<span class="status-dot '+mStatusCls+'"></span>';
      mobileHtml+='<div><div class="mc-name">'+escapeHtml(mrow.modemNick)+'</div><div class="mc-operator">'+escapeHtml(mrow.operator||'')+'</div></div>';
      mobileHtml+='</div>';
      mobileHtml+='<div class="mc-right"><div class="mc-today-label">\u0421\u0435\u0433\u043e\u0434\u043d\u044f</div><div class="mc-today-val">'+mTodayVal+'</div></div>';
      mobileHtml+='<span class="mc-chevron">\u25BC</span>';
      mobileHtml+='</div>';
      mobileHtml+='<div class="mc-stats">';
      mobileHtml+='<div class="mc-stat"><span class="mc-stat-lbl">\u0412\u0447\u0435\u0440\u0430</span><span class="mc-stat-val">'+mYestVal+'</span></div>';
      mobileHtml+='<div class="mc-stat"><span class="mc-stat-lbl">\u041c\u0435\u0441\u044f\u0446</span><span class="mc-stat-val">'+mMonthVal+'</span></div>';
      mobileHtml+='</div>';
      mobileHtml+='<div class="mc-expanded">';
      if(mServerIp&&mrow.httpPort){
        mobileHtml+='<div class="mc-req-row"><span class="mc-req-lbl">HTTP</span><span class="mc-req-val">'+mServerIp+':'+mrow.httpPort+'</span><button class="mc-copy" onclick="copyText(\''+mServerIp+':'+mrow.httpPort+'\',this)">\ud83d\udccb</button></div>';
      }
      if(mServerIp&&mrow.socksPort){
        mobileHtml+='<div class="mc-req-row"><span class="mc-req-lbl">SOCKS5</span><span class="mc-req-val">'+mServerIp+':'+mrow.socksPort+'</span><button class="mc-copy" onclick="copyText(\''+mServerIp+':'+mrow.socksPort+'\',this)">\ud83d\udccb</button></div>';
      }
      if(mrow.proxyLogin){
        mobileHtml+='<div class="mc-req-row"><span class="mc-req-lbl">\u041b\u043e\u0433\u0438\u043d</span><span class="mc-req-val">'+escapeHtml(mrow.proxyLogin)+'</span><button class="mc-copy" onclick="copyText(\''+escapeHtml(mrow.proxyLogin)+'\',this)">\ud83d\udccb</button></div>';
      }
      if(mrow.proxyPassword){
        mobileHtml+='<div class="mc-req-row"><span class="mc-req-lbl">\u041f\u0430\u0440\u043e\u043b\u044c</span><span class="mc-req-val">'+escapeHtml(mrow.proxyPassword)+'</span><button class="mc-copy" onclick="copyText(\''+escapeHtml(mrow.proxyPassword)+'\',this)">\ud83d\udccb</button></div>';
      }
      if(mrow.resetSecureLink){
        mobileHtml+='<a href="'+escapeHtml(mrow.resetSecureLink)+'" target="_blank" class="mc-reset-btn" style="display:block;text-align:center;text-decoration:none">\ud83d\udd04 \u0421\u0431\u0440\u043e\u0441\u0438\u0442\u044c IP</a>';
      }else if(mrow.rawImei){
        mobileHtml+='<button class="mc-reset-btn" onclick="resetIp(\''+escapeHtml(mrow.rawImei)+'\',\''+mrow.serverName+'\',this)">\ud83d\udd04 \u0421\u0431\u0440\u043e\u0441\u0438\u0442\u044c IP</button>';
      }
      mobileHtml+='</div>';
      mobileHtml+='</div>';
    }
  }
  var mobileEl=document.getElementById('mobileModemCards');
  if(mobileEl) mobileEl.innerHTML=mobileHtml;
}

function sortTable(key){
  if(currentSort.key===key){currentSort.dir=currentSort.dir==='asc'?'desc':'asc'}
  else{currentSort.key=key;currentSort.dir='asc'}
  renderTable();
}
function toggleMc(id){
  var el=document.getElementById(id);
  if(el) el.classList.toggle('open');
}

function updateSummary(){
  // --- Ports card: active / total, split by country ---
  var total=tableData.length;
  // Group by country (not server) using COUNTRIES data
  var byCountry={};
  tableData.forEach(function(r){
    var sn=r.serverName||'??';
    var ci=COUNTRIES[sn]||{};
    var cc=ci.country||'??';
    if(!byCountry[cc])byCountry[cc]={count:0,name:ci.name||sn};
    byCountry[cc].count++;
  });
  var countryFlags={'MD':'🇲🇩','RO':'🇷🇴'};
  document.getElementById('totalPorts').textContent=total+' / '+total;
  var splitParts=Object.keys(byCountry).sort().map(function(cc){
    return (countryFlags[cc]||'🌍')+' '+byCountry[cc].name+': '+byCountry[cc].count;
  });
  document.getElementById('portsCountrySplit').textContent=splitParts.join(' · ');

  // --- Traffic ---
  var totalDayIn=0,totalDayOut=0,totalMonthIn=0,totalMonthOut=0;
  for(var i=0;i<tableData.length;i++){
    totalDayIn+=tableData[i].dayIn;
    totalDayOut+=tableData[i].dayOut;
    totalMonthIn+=tableData[i].monthIn;
    totalMonthOut+=tableData[i].monthOut;
  }
  document.getElementById('totalDayTotal').innerHTML=formatBytes(totalDayIn+totalDayOut);
  document.getElementById('totalDaySplit').innerHTML='\u2193 '+formatBytes(totalDayIn)+' / \u2191 '+formatBytes(totalDayOut);
  document.getElementById('totalMonthTotal').innerHTML=formatBytes(totalMonthIn+totalMonthOut);
  document.getElementById('totalMonthSplit').innerHTML='\u2193 '+formatBytes(totalMonthIn)+' / \u2191 '+formatBytes(totalMonthOut);

  // --- Balance card ---
  var monthTotal=totalMonthIn+totalMonthOut;
  var monthGb=monthTotal/(1024*1024*1024);
  if(billingData&&billingData.price>0){
    var displayExpense=billingData.monthExpense||0;
    var liveGb=billingData.liveMonthGb||Math.round(monthGb*1000)/1000;
    var curr=billingData.currency||'RUB';
    var cs=curr==='RUB'?'₽':(curr==='USD'?'$':(curr==='EUR'?'€':curr));
    var balanceEl=document.getElementById('balanceValue');
    var balanceInfoEl=document.getElementById('balanceInfo');
    if(billingData.balance!==undefined){
      var balance=billingData.balance;
      balanceEl.textContent=formatCost(balance)+' '+cs;
      balanceEl.className='card-value '+(balance>=0?'balance-positive':'balance-negative');

      // Days remaining estimate
      var daysElapsed=new Date().getDate()||1;
      var avgDailySpend=daysElapsed>0&&displayExpense>0?displayExpense/daysElapsed:0;
      var daysLeft=avgDailySpend>0?Math.floor(balance/avgDailySpend):null;
      if(daysLeft!==null&&balance>0){
        var dColor=daysLeft<7?'var(--danger)':daysLeft<30?'var(--warning)':'var(--success)';
        balanceInfoEl.innerHTML='<span style="color:'+dColor+';font-weight:600">Хватит ~'+daysLeft+' дн.</span>';
      } else {
        balanceInfoEl.innerHTML='';
      }

      if(balance<0){
        document.getElementById('balanceWarning').innerHTML='<div class="balance-warning">\u26A0\uFE0F Баланс отрицательный. Пожалуйста, свяжитесь с администратором для пополнения.</div>';
      } else {
        document.getElementById('balanceWarning').innerHTML='';
      }
    }
  }

  // --- Uptime card ---
  var uptimePcts=tableData.filter(function(r){return r.uptimePct!==null}).map(function(r){return parseFloat(r.uptimePct)});
  if(uptimePcts.length>0){
    var avgUp=uptimePcts.reduce(function(a,b){return a+b},0)/uptimePcts.length;
    var upEl=document.getElementById('avgUptime');
    upEl.textContent=avgUp.toFixed(1)+'%';
    upEl.className='card-value '+(avgUp>=99?'uptime-good':avgUp>=95?'uptime-warn':'uptime-bad');
  }

  document.getElementById('summaryCards').style.display='grid';
}

// --- Rotation ---
function parseTimeToMin(s){
  if(!s||s==='None'||s==='null')return 0;
  var total=0;
  var h=s.match(/(\d+)\s*h/);if(h)total+=parseInt(h[1])*60;
  var m=s.match(/(\d+)\s*min/);if(m)total+=parseInt(m[1]);
  var sec=s.match(/(\d+)\s*sec/);if(sec)total+=Math.ceil(parseInt(sec[1])/60);
  return total;
}
function buildRotationCell(row){
  if(row._offline)return'<span style="color:var(--text-3);font-size:11px">—</span>';
  var timeLeft=row.timeToRotation||'';
  var hasRotation=timeLeft&&timeLeft!=='None'&&timeLeft!=='null';
  var opts=[{v:0,l:'Выкл'},{v:5,l:'5 мин'},{v:10,l:'10 мин'},{v:15,l:'15 мин'},{v:30,l:'30 мин'},{v:60,l:'1 час'},{v:120,l:'2 часа'},{v:180,l:'3 часа'},{v:360,l:'6 часов'},{v:720,l:'12 часов'},{v:1440,l:'24 часа'}];
  var cur=parseInt(row.autoRotation)||0;
  // If API doesn't give autoRotation value but timer is running, guess the interval
  if(cur===0&&hasRotation){
    var leftMin=parseTimeToMin(timeLeft);
    // Find the smallest preset >= leftMin (the interval must be >= time remaining)
    for(var i=1;i<opts.length;i++){if(opts[i].v>=leftMin){cur=opts[i].v;break}}
    if(cur===0)cur=1440;
  }
  var h='<select class="rotation-select" onchange="setRotation(\''+escapeHtml(row.modemNick)+'\',\''+escapeHtml(row.serverName)+'\',this.value,this)" style="font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg-2);color:var(--text-1);cursor:pointer">';
  var matched=false;
  for(var i=0;i<opts.length;i++){
    var sel=opts[i].v===cur?' selected':'';
    if(opts[i].v===cur)matched=true;
    h+='<option value="'+opts[i].v+'"'+sel+'>'+opts[i].l+'</option>';
  }
  if(!matched&&cur>0)h+='<option value="'+cur+'" selected>'+cur+' мин</option>';
  h+='</select>';
  if(hasRotation)h+='<div style="font-size:9px;color:var(--accent);margin-top:2px">\u23F1 '+escapeHtml(timeLeft)+'</div>';
  return h;
}

function setRotation(nick,serverName,minutes,sel){
  sel.disabled=true;
  fetch('/api/client/set_rotation',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Auth-Token':authToken},
    body:JSON.stringify({nick:nick,serverName:serverName,minutes:parseInt(minutes)})
  }).then(function(r){return r.json()}).then(function(d){
    sel.disabled=false;
    if(d.ok){showToast('Ротация: '+(parseInt(minutes)===0?'выключена':minutes+' мин'),'success')}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(){sel.disabled=false;showToast('Ошибка сети','error')});
}

// --- Actions ---
function resetIp(imei,serverName,btn){
  if(!confirm('Сбросить IP?')) return;
  btn.disabled=true;
  fetch('/api/client/reset_ip',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Auth-Token':authToken},
    body:JSON.stringify({imei:imei,serverName:serverName})
  }).then(function(r){return r.json()}).then(function(d){
    btn.disabled=false;
    if(d.ok){showToast('IP сброшен','success');setTimeout(loadData,3000)}
    else showToast(d.error||'Ошибка','error');
  }).catch(function(){btn.disabled=false;showToast('Ошибка сети','error')});
}

// IP history — same format as admin panel
function showIpHistory(nick,serverName,imei){
  document.getElementById('ipModalTitle').textContent='IP история: '+nick;
  document.getElementById('ipModalBody').innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Загрузка лога ротации...</div>';
  document.getElementById('ipModal').classList.add('show');

  if(!nick||!serverName){
    document.getElementById('ipModalBody').innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Нет данных</div>';
    return;
  }

  fetch('/api/client/rotation_log?nick='+encodeURIComponent(nick)+'&serverName='+encodeURIComponent(serverName),{headers:{'X-Auth-Token':authToken}})
  .then(function(r){return r.json()}).then(function(data){
    var entries=Array.isArray(data)?data:(data.log||data.logs||data.data||[]);
    if(!entries.length){
      document.getElementById('ipModalBody').innerHTML='<div style="text-align:center;padding:20px;color:var(--text-3)">Нет истории ротации</div>';
      return;
    }
    function _fmtRot(v){if(!v||v==='\u2014')return'\u2014';var s=String(v).replace('@',' ').replace('T',' ');var d=new Date(s);if(isNaN(d.getTime())){var p=s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):?(\d{2})?/);if(p)return p[3]+'.'+p[2]+'.'+p[1]+' '+p[4]+':'+p[5]+(p[6]?':'+p[6]:'');return s}return d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
    var h='<table class="log-table"><thead><tr><th>Начало</th><th>Конец</th><th>Сек</th><th>Попытка</th><th>Старый IP</th><th>Новый IP</th></tr></thead><tbody>';
    entries.forEach(function(e){
      var start=e.started_at||e.start_time||e.Start||e.start||'\u2014';
      var end=e.ended_at||e.end_time||e.End||e.end||'\u2014';
      var took=e.took_sec||e.total_time||e.Took||e.took||'\u2014';
      var attempt=e.attempt||e.Attempt||1;
      var oldIp=e.old_ip||e.OldIPv4||'\u2014';
      var newIp=e.new_ip||e.NewIPv4||'\u2014';
      h+='<tr>';
      h+='<td style="white-space:nowrap">'+_fmtRot(start)+'</td>';
      h+='<td style="white-space:nowrap">'+_fmtRot(end)+'</td>';
      h+='<td>'+(took!=='\u2014'?parseFloat(took).toFixed(1):'\u2014')+'</td>';
      h+='<td>'+escapeHtml(String(attempt))+'</td>';
      h+='<td class="mono" style="color:var(--text-2)">'+escapeHtml(String(oldIp))+'</td>';
      h+='<td class="mono" style="color:var(--accent)">'+escapeHtml(String(newIp))+'</td>';
      h+='</tr>';
    });
    document.getElementById('ipModalBody').innerHTML=h+'</tbody></table>';
  }).catch(function(e){
    document.getElementById('ipModalBody').innerHTML='<div style="color:var(--danger)">'+e.message+'</div>';
  });
}

// Change #9: Helper to format date+time as "DD.MM.YYYY, HH:MM:SS"
function formatDateTime(d){
  var day=String(d.getDate()).padStart(2,'0');
  var month=String(d.getMonth()+1).padStart(2,'0');
  var year=d.getFullYear();
  var hours=String(d.getHours()).padStart(2,'0');
  var minutes=String(d.getMinutes()).padStart(2,'0');
  var seconds=String(d.getSeconds()).padStart(2,'0');
  return day+'.'+month+'.'+year+', '+hours+':'+minutes+':'+seconds;
}

function closeIpModal(){document.getElementById('ipModal').classList.remove('show')}
document.getElementById('ipModal').addEventListener('click',function(e){if(e.target===this) closeIpModal()});
document.addEventListener('keydown',function(e){if(e.key==='Escape') closeIpModal()});

// --- Proxy table: credentials are now inline in the main traffic table ---
function renderProxyTable(){
  var hasProxy=tableData.some(function(r){return !!r.proxyLogin});

  // Show/hide export buttons
  if(hasProxy){
    document.getElementById('proxyExportButtons').style.display='flex';
  }else{
    document.getElementById('proxyExportButtons').style.display='none';
  }

}

// Use RESET_SECURE_LINK from API data
function getResetUrl(row){
  return row.resetSecureLink||'';
}

function exportCredentials(){
  var lines=[];
  tableData.forEach(function(row){
    if(!row.proxyLogin) return;
    var ci=COUNTRIES[row.serverName]||{};
    var serverIp=ci.serverIp||'';
    var resetUrl=row.resetSecureLink||'';
    lines.push(serverIp+':'+row.httpPort+':'+row.proxyLogin+':'+row.proxyPassword+'|'+resetUrl);
  });
  if(!lines.length){showToast('Нет данных для экспорта','error');return}
  downloadFile(lines.join('\n'),'proxies_rent.txt','text/plain');
  showToast('Файл скачан','success');
}

function exportCredentialsCSV(){
  var lines=['Modem,Server,Protocol,IP,Port,Login,Password,Full'];
  tableData.forEach(function(row){
    if(!row.proxyLogin) return;
    var ci=COUNTRIES[row.serverName]||{};
    var serverIp=ci.serverIp||'';
    lines.push([row.modemNick,row.serverName,'HTTP',serverIp,row.httpPort,row.proxyLogin,row.proxyPassword,row.httpCreds||''].join(','));
    lines.push([row.modemNick,row.serverName,'SOCKS5',serverIp,row.socksPort,row.proxyLogin,row.proxyPassword,row.socks5Creds||''].join(','));
  });
  if(lines.length<=1){showToast('Нет данных для экспорта','error');return}
  downloadFile(lines.join('\n'),'proxies_rent_credentials.csv','text/csv');
  showToast('CSV скачан','success');
}

function downloadFile(content,filename,type){
  var blob=new Blob([content],{type:type});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
}

// --- Proxy Checker ---
function checkProxies(){
  var input=document.getElementById('checkProxyInput').value.trim();
  if(!input){showToast('Введите список прокси','error');return}
  var lines=input.split('\n').filter(function(l){return l.trim()});
  var btn=document.getElementById('btnCheckProxy');
  btn.disabled=true;
  btn.textContent='Проверка...';
  document.getElementById('checkProxyResults').innerHTML='<div class="loading-overlay" style="padding:20px"><div class="spinner"></div><span>Проверяем '+lines.length+' прокси...</span></div>';

  var proxies=lines.map(function(l){
    var p=l.trim().split(':');
    return {ip:p[0],port:parseInt(p[1])||0,login:p[2]||'',password:p[3]||''};
  });

  fetch('/api/tools/check_proxy',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Auth-Token':authToken},
    body:JSON.stringify({proxies:proxies})
  }).then(function(r){return r.json()}).then(function(results){
    btn.disabled=false;btn.textContent='Проверить';
    var arr=Array.isArray(results)?results:results.results||[];
    if(!arr.length){document.getElementById('checkProxyResults').innerHTML='<p style="color:var(--text-2)">Нет результатов</p>';return}
    var h='<table class="data-table"><thead><tr><th>Прокси</th><th>Статус</th><th>Время (мс)</th><th>IP</th><th>Ошибка</th></tr></thead><tbody>';
    arr.forEach(function(r){
      var cls=r.working?'check-result-ok':'check-result-fail';
      var proxyLabel=r.ip+':'+r.port;
      h+='<tr><td class="mono">'+escapeHtml(proxyLabel)+'</td><td class="'+cls+'">'+(r.working?'OK':'Fail')+'</td><td>'+(r.responseTime||'-')+'</td><td class="mono">'+(r.detectedIp||'-')+'</td><td>'+(r.error?escapeHtml(r.error):'-')+'</td></tr>';
    });
    document.getElementById('checkProxyResults').innerHTML=h+'</tbody></table>';
  }).catch(function(e){
    btn.disabled=false;btn.textContent='Проверить';
    document.getElementById('checkProxyResults').innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

// --- Format Converter ---
function parseProxyLine(line,format){
  line=line.trim();if(!line) return null;
  var parts;
  if(format==='ipportloginpass'){
    parts=line.split(':');
    if(parts.length>=4) return {ip:parts[0],port:parts[1],login:parts[2],pass:parts.slice(3).join(':')};
    if(parts.length===2) return {ip:parts[0],port:parts[1],login:'',pass:''};
  }else if(format==='loginpassipport'){
    var at=line.indexOf('@');
    if(at>-1){
      var cred=line.substring(0,at).split(':');
      var addr=line.substring(at+1).split(':');
      return {ip:addr[0]||'',port:addr[1]||'',login:cred[0]||'',pass:cred.slice(1).join(':')||''};
    }
    parts=line.split(':');
    if(parts.length>=2) return {ip:parts[0],port:parts[1],login:'',pass:''};
  }else if(format==='loginpassatipport'){
    parts=line.split(':');
    if(parts.length>=4) return {ip:parts[2],port:parts[3],login:parts[0],pass:parts[1]};
    if(parts.length===2) return {ip:parts[0],port:parts[1],login:'',pass:''};
  }
  return null;
}

function formatProxyLine(p,format){
  if(!p) return '';
  if(format==='ipportloginpass'){
    return p.login?p.ip+':'+p.port+':'+p.login+':'+p.pass:p.ip+':'+p.port;
  }else if(format==='loginpassipport'){
    return p.login?p.login+':'+p.pass+'@'+p.ip+':'+p.port:p.ip+':'+p.port;
  }else if(format==='loginpassatipport'){
    return p.login?p.login+':'+p.pass+':'+p.ip+':'+p.port:p.ip+':'+p.port;
  }
  return '';
}

function convertFormat(){
  var input=document.getElementById('convertInput').value.trim();
  var fromFmt=document.getElementById('convertFrom').value;
  var toFmt=document.getElementById('convertTo').value;
  if(!input){showToast('Введите данные','error');return}
  var lines=input.split('\n');
  var out=[];
  lines.forEach(function(line){
    var p=parseProxyLine(line,fromFmt);
    if(p) out.push(formatProxyLine(p,toFmt));
  });
  document.getElementById('convertOutput').value=out.join('\n');
  showToast('Конвертировано: '+out.length+' строк','success');
}

// --- Documents ---
function loadDocuments(){
  loadClosingDocs();
  loadBills();
  fetch('/api/client/documents',{headers:{'X-Auth-Token':authToken}}).then(function(r){return r.json()}).then(function(docs){
    var el=document.getElementById('documentsList');
    if(!docs.length){el.innerHTML='<p style="color:var(--text-2);text-align:center;padding:40px">Документов пока нет</p>';return}
    var h='<table class="data-table"><thead><tr><th>Документ</th><th>Дата</th><th></th></tr></thead><tbody>';
    docs.forEach(function(d){
      h+='<tr><td>'+escapeHtml(d.name)+'</td><td>'+new Date(d.date).toLocaleDateString('ru-RU')+'</td><td><a href="/api/client/documents/'+d.id+'/download" class="btn btn-sm">Скачать</a></td></tr>';
    });
    el.innerHTML=h+'</tbody></table>';
  }).catch(function(e){
    document.getElementById('documentsList').innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

// --- Closing Documents (Acts) ---
function loadClosingDocs(){
  fetch('/api/client/closing_documents',{headers:{'X-Auth-Token':authToken}}).then(function(r){return r.json()}).then(function(data){
    var docs=data.documents||[];
    var el=document.getElementById('closingDocsList');
    var badge=document.getElementById('unsignedBadge');
    var unsigned=docs.filter(function(d){return d.status!=='signed'});
    if(badge){
      if(unsigned.length>0){badge.style.display='inline';badge.textContent=unsigned.length+' не подписан'+(unsigned.length>1?'о':'');}
      else{badge.style.display='none';}
    }
    if(!docs.length){el.innerHTML='<div style="text-align:center;padding:32px 16px"><div style="font-size:32px;margin-bottom:12px;opacity:.4">📄</div><p style="font-size:14px;font-weight:500;color:var(--text-1);margin:0 0 6px">Актов пока нет</p><p style="font-size:13px;color:var(--text-3);line-height:1.6;max-width:340px;margin:0 auto">Акты формируются по итогам каждого месяца после подписания договора. Первый акт появится в начале следующего месяца.</p></div>';return}
    var h='<table class="data-table" style="width:100%"><thead><tr><th style="text-align:left;padding:10px 12px">Период</th><th style="text-align:left;padding:10px 12px">Номер</th><th style="text-align:right;padding:10px 12px">Сумма</th><th style="text-align:center;padding:10px 12px">Статус</th><th style="text-align:center;padding:10px 12px">Действия</th></tr></thead><tbody>';
    docs.sort(function(a,b){return (b.period||'').localeCompare(a.period||'')});
    docs.forEach(function(d){
      var isSigned=d.status==='signed';
      var rowBg=isSigned?'':'background:rgba(239,68,68,0.08);';
      var statusHtml=isSigned
        ?'<span style="color:var(--green);font-weight:600">\u2705 \u041f\u043e\u0434\u043f\u0438\u0441\u0430\u043d</span>'
        :'<span style="color:var(--red);font-weight:600">\u274c \u041d\u0435 \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d</span>';
      var periodLabel=d.period||'\u2014';
      if(d.period&&d.period.length===7){
        var parts=d.period.split('-');
        var months=['\u042f\u043d\u0432','\u0424\u0435\u0432','\u041c\u0430\u0440','\u0410\u043f\u0440','\u041c\u0430\u0439','\u0418\u044e\u043d','\u0418\u044e\u043b','\u0410\u0432\u0433','\u0421\u0435\u043d','\u041e\u043a\u0442','\u041d\u043e\u044f','\u0414\u0435\u043a'];
        var mi=parseInt(parts[1],10)-1;
        if(mi>=0&&mi<12) periodLabel=months[mi]+' '+parts[0];
      }
      h+='<tr style="border-bottom:1px solid var(--border);'+rowBg+'">';
      h+='<td style="padding:10px 12px;font-weight:500">'+escapeHtml(periodLabel)+'</td>';
      h+='<td style="padding:10px 12px;color:var(--text-3)">'+(d.actNumber||'\u2014')+'</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-weight:600">'+formatNumber(d.totalAmount||0)+' \u20BD</td>';
      h+='<td style="padding:10px 12px;text-align:center">'+statusHtml+'</td>';
      h+='<td style="padding:10px 12px;text-align:center"><button class="btn btn-sm" onclick="downloadClosingPdf(\''+d.id+'\')" style="font-size:12px;padding:4px 10px">\u{1F4E5} PDF</button></td>';
      h+='</tr>';
    });
    h+='</tbody></table>';
    el.innerHTML=h;
  }).catch(function(e){
    document.getElementById('closingDocsList').innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

function downloadClosingPdf(docId){
  window.open('/api/client/closing_documents/'+docId+'/pdf?token='+encodeURIComponent(authToken),'_blank');
}

// --- Bills (Счета на оплату) ---
function loadBills(){
  fetch('/api/client/bills',{headers:{'X-Auth-Token':authToken}}).then(function(r){return r.json()}).then(function(data){
    var bills=data.bills||[];
    var el=document.getElementById('billsList');
    var badge=document.getElementById('unpaidBadge');
    var unpaid=bills.filter(function(b){return b.status!=='paid'});
    if(badge){
      if(unpaid.length>0){badge.style.display='inline';badge.textContent=unpaid.length+' не оплачен';}
      else{badge.style.display='none';}
    }
    if(!bills.length){el.innerHTML='<div style="text-align:center;padding:32px 16px"><div style="font-size:32px;margin-bottom:12px;opacity:.4">🧾</div><p style="font-size:14px;font-weight:500;color:var(--text-1);margin:0 0 6px">Счетов на оплату пока нет</p><p style="font-size:13px;color:var(--text-3);line-height:1.6;max-width:340px;margin:0 auto 16px">Счета выставляются по запросу. Для получения счёта — свяжитесь с менеджером.</p><a href="https://t.me/proxies_rent" target="_blank" style="display:inline-block;padding:7px 18px;border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text-0);text-decoration:none;background:var(--bg-2)">✈️ Написать менеджеру</a></div>';return}
    var h='<table class="data-table" style="width:100%"><thead><tr><th style="text-align:left;padding:10px 12px">Период</th><th style="text-align:left;padding:10px 12px">Номер</th><th style="text-align:right;padding:10px 12px">Сумма</th><th style="text-align:center;padding:10px 12px">Статус</th><th style="text-align:center;padding:10px 12px">Действия</th></tr></thead><tbody>';
    bills.sort(function(a,b){return (b.period||'').localeCompare(a.period||'')});
    bills.forEach(function(b){
      var isPaid=b.status==='paid';
      var rowBg=isPaid?'':'background:rgba(239,68,68,0.08);';
      var statusHtml=isPaid
        ?'<span style="color:var(--green);font-weight:600">✅ Оплачен</span>'
        :'<span style="color:var(--red);font-weight:600">⏳ Не оплачен</span>';
      var periodLabel=b.period||'—';
      if(b.period&&b.period.length===7){
        var parts=b.period.split('-');
        var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
        var mi=parseInt(parts[1],10)-1;
        if(mi>=0&&mi<12) periodLabel=months[mi]+' '+parts[0];
      }
      h+='<tr style="border-bottom:1px solid var(--border);'+rowBg+'">';
      h+='<td style="padding:10px 12px;font-weight:500">'+escapeHtml(periodLabel)+'</td>';
      h+='<td style="padding:10px 12px;color:var(--text-3)">'+(b.billNumber||'—')+'</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-weight:600">'+formatNumber(b.amount||0)+' ₽</td>';
      h+='<td style="padding:10px 12px;text-align:center">'+statusHtml+'</td>';
      h+='<td style="padding:10px 12px;text-align:center"><button class="btn btn-sm" onclick="downloadBillPdf(\''+b.id+'\')" style="font-size:12px;padding:4px 10px">📥 PDF</button></td>';
      h+='</tr>';
    });
    h+='</tbody></table>';
    el.innerHTML=h;
  }).catch(function(e){
    document.getElementById('billsList').innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

function downloadBillPdf(billId){
  window.open('/api/client/bills/'+billId+'/pdf?token='+encodeURIComponent(authToken),'_blank');
}

// --- API Docs ---
var apiBase=window.location.origin;

function loadApiDocs(){
  var keyEl=document.getElementById('apiDocKey');
  var realKey=billingData && billingData.apiKey ? billingData.apiKey : '';
  if(realKey){
    keyEl.textContent=realKey;
    // Replace YOUR_API_KEY with real key in all code blocks, highlighted
    document.querySelectorAll('#tab-api .code-block, #tab-api code, #tab-api td').forEach(function(el){
      if(el.innerHTML.indexOf('YOUR_API_KEY')!==-1){
        el.innerHTML=el.innerHTML.replace(/YOUR_API_KEY/g,'<span class="api-key-highlight">'+realKey+'</span>');
      }
    });
  } else {
    keyEl.textContent='Загрузите данные на вкладке «Панель управления»';
  }
}

function switchLang(el,lang,group){
  el.parentElement.querySelectorAll('.lang-tab').forEach(function(t){t.classList.remove('active')});
  el.classList.add('active');
  document.querySelectorAll('.lang-code[data-group="'+group+'"]').forEach(function(c){
    c.classList.toggle('active',c.getAttribute('data-lang')===lang);
  });
}

function copyCodeBlock(btn){
  var block=btn.parentElement;
  var code=block.textContent.replace('Копировать','').trim();
  copyText(code,btn);
}

// Change #3: Referral simplification - only show stats, no referral code/link
function loadReferral(){
  fetch('/api/client/referral',{headers:{'X-Auth-Token':authToken}}).then(function(r){return r.json()}).then(function(data){
    document.getElementById('referralContent').innerHTML=
      '<div class="referral-info">'+
      '<div class="referral-hero"><h3>Партнёрская программа</h3><p>Рекомендуйте нас и получайте <strong>10%</strong> от каждого платежа на баланс или личную карту. За дополнительной информацией обращайтесь к менеджеру.</p></div>'+
      '<div class="referral-cards">'+
      '<div class="card"><div class="card-label">Привлечено клиентов</div><div class="card-value">'+(data.referrals_count||0)+'</div></div>'+
      '<div class="card"><div class="card-label">Заработано</div><div class="card-value">'+Math.floor(data.referral_balance||0).toString()+'</div></div>'+
      '</div></div>';
  }).catch(function(e){
    document.getElementById('referralContent').innerHTML='<div class="error-msg">'+escapeHtml(e.message)+'</div>';
  });
}

// ==================== EXPORT MODAL ====================
// ==================== EXPORT PROXY MODULE ====================
var exportTab='basic';
var exportFormat='txt_login_at';
var exportProto='http';
var exportRotation=true;
var exportTxtOrder='login_at'; // 'login_at' | 'host_colon'
var exportLocFilter=[];   // [] = все, ['MD'] = Молдова, ['RO'] = Румыния
var exportModemFilter=[]; // [] = все, [...nicks]

var EXPORT_FORMATS={
  basic:[
    {id:'txt_login_at',label:'Generic TXT',sub:'user:pass@ip:port',ext:'txt',icon:'📄'},
    {id:'json',label:'JSON',sub:'Массив объектов',ext:'json',icon:'{}'},
    {id:'csv',label:'CSV',sub:'С заголовками',ext:'csv',icon:'📊'},
  ],
  devtools:[
    {id:'curl',label:'cURL',sub:'Для терминала',ext:'sh',icon:'$_'},
    {id:'python',label:'Python requests',sub:'Готовый код',ext:'py',icon:'🐍'},
    {id:'dotenv',label:'.env',sub:'Env-переменные',ext:'env',icon:'🔑'},
  ],
  system:[
    {id:'pac',label:'PAC',sub:'Auto-config файл',ext:'pac',icon:'🔧'},
    {id:'foxyproxy',label:'FoxyProxy',sub:'JSON config',ext:'json',icon:'🦊'},
    {id:'proxifier',label:'Proxifier',sub:'XML profile',ext:'ppx',icon:'🔷'},
  ],
  custom:[
    {id:'custom',label:'Свой шаблон',sub:'Настраиваемый',ext:'txt',icon:'⌨️'},
  ]
};

function _loadExportState(){
  try{
    var s=JSON.parse(localStorage.getItem('exportState')||'{}');
    if(s.tab&&EXPORT_FORMATS[s.tab])exportTab=s.tab;
    var fmts=EXPORT_FORMATS[exportTab]||[];
    if(s.format&&fmts.find(function(f){return f.id===s.format;}))exportFormat=s.format;
    else exportFormat=fmts.length?fmts[0].id:'txt_login_at';
    if(s.proto)exportProto=s.proto;
  }catch(e){}
}
function _saveExportState(){
  try{localStorage.setItem('exportState',JSON.stringify({tab:exportTab,format:exportFormat,proto:exportProto}));}catch(e){}
}

function openExportModal(){
  var proxies=tableData.filter(function(r){return r.proxyLogin;});
  if(!proxies.length){showToast('Нет прокси для экспорта','error');return;}
  _loadExportState();
  exportLocFilter=[];exportModemFilter=[];
  var m=document.getElementById('exportModal');
  if(!m){buildExportModal();m=document.getElementById('exportModal');}
  m.style.display='flex';
  document.body.style.overflow='hidden';
  _rebuildExportModal();
}
function closeExportModal(){
  var m=document.getElementById('exportModal');
  if(m)m.style.display='none';
  document.body.style.overflow='';
}

function buildExportModal(){
  var div=document.createElement('div');
  div.id='exportModal';
  div.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;align-items:center;justify-content:center;padding:16px';
  div.onclick=function(e){if(e.target===div)closeExportModal();};
  div.innerHTML=
    '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:16px;width:min(720px,100%);height:min(640px,92vh);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3)">'+
    '<div style="padding:18px 24px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0">'+
    '<div><div style="display:flex;align-items:center;gap:8px;margin-bottom:3px"><span style="font-size:18px">📤</span><h2 style="font-size:15px;font-weight:700;color:var(--text-0);margin:0">Экспорт прокси</h2></div>'+
    '</div>'+
    '<button onclick="closeExportModal()" style="background:var(--bg-2);border:1px solid var(--border);border-radius:8px;width:28px;height:28px;cursor:pointer;color:var(--text-1);font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>'+
    '</div>'+
    '<div style="padding:0 24px;border-bottom:1px solid var(--border);display:flex;gap:0;flex-shrink:0;overflow-x:auto" id="exportTabBar">'+
    '<button onclick="switchExportTab(\'basic\')" id="etab-basic" style="padding:9px 14px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-2);white-space:nowrap">📄 Базовые</button>'+
    '<button onclick="switchExportTab(\'devtools\')" id="etab-devtools" style="padding:9px 14px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-2);white-space:nowrap">💻 Для разработчиков</button>'+
    '<button onclick="switchExportTab(\'system\')" id="etab-system" style="padding:9px 14px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-2);white-space:nowrap">⚙️ Системные</button>'+
    '<button onclick="switchExportTab(\'custom\')" id="etab-custom" style="padding:9px 14px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-2);white-space:nowrap">⌨️ Свой шаблон</button>'+
    '</div>'+
    '<div id="exportFormatGrid" style="padding:12px 24px;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;min-height:104px"></div>'+
    '<div id="exportCustomTemplateRow" style="display:none;padding:0 24px 10px;border-bottom:1px solid var(--border);flex-shrink:0">'+
    '<div style="font-size:11px;color:var(--text-2);margin-bottom:6px">Шаблон строки:</div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">'+
    '<button onclick="setCustomTpl(\'{{LOGIN}}:{{PASS}}@{{HOST}}:{{PORT}}\')" style="padding:4px 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;color:var(--text-0)">LOGIN:PASS@ADDRESS:PORT</button>'+
    '<button onclick="setCustomTpl(\'{{LOGIN}}:{{PASS}}:{{HOST}}:{{PORT}}\')" style="padding:4px 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;color:var(--text-0)">LOGIN:PASS:ADDRESS:PORT</button>'+
    '<button onclick="setCustomTpl(\'{{HOST}}:{{PORT}}@{{LOGIN}}:{{PASS}}\')" style="padding:4px 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;color:var(--text-0)">ADDRESS:PORT@LOGIN:PASS</button>'+
    '<button onclick="setCustomTpl(\'{{HOST}}:{{PORT}}:{{LOGIN}}:{{PASS}}\')" style="padding:4px 8px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;color:var(--text-0)">ADDRESS:PORT:LOGIN:PASS</button>'+
    '</div>'+
    '<input id="exportCustomTpl" type="text" value="{{LOGIN}}:{{PASS}}@{{HOST}}:{{PORT}}" oninput="refreshExportPreview()" style="width:100%;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;color:var(--text-0);font-size:12px;padding:6px 10px;font-family:monospace;box-sizing:border-box">'+
    '<div style="font-size:10px;color:var(--text-3);margin-top:4px">Переменные: {{LOGIN}} {{PASS}} {{HOST}} {{PORT}} {{PROTO}} {{CHANGEIP}}</div>'+
    '</div>'+
    '<div style="padding:10px 24px;border-bottom:1px solid var(--border);flex-shrink:0">'+
    '<div style="font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Настройки</div>'+
    '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">'+
    '<div><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">Протокол</div>'+
    '<div style="display:flex">'+
    '<button id="eproto-http" onclick="setExportProto(\'http\')" style="padding:4px 12px;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px 0 0 6px;font-size:11px;cursor:pointer;font-weight:500">HTTP</button>'+
    '<button id="eproto-socks5" onclick="setExportProto(\'socks5\')" style="padding:4px 12px;background:var(--bg-2);color:var(--text-1);border:1px solid var(--border);border-left:none;border-radius:0 6px 6px 0;font-size:11px;cursor:pointer">SOCKS5</button>'+
    '</div></div>'+
    '<div><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">Ссылка смены IP</div>'+
    '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:var(--text-1);height:27px">'+
    '<input type="checkbox" id="exportRotationCheck" checked onchange="exportRotation=this.checked;refreshExportPreview()"> Включить</label>'+
    '</div>'+
    '<div><div style="font-size:10px;color:var(--text-3);margin-bottom:4px">Локация</div>'+
    '<div style="display:flex;gap:4px">'+
    '<button onclick="toggleExportLoc(\'\')" id="eloc-all" style="padding:3px 10px;font-size:11px;cursor:pointer;border-radius:5px;border:1px solid var(--accent);background:var(--accent);color:#fff">Все</button>'+
    (function(){var _cf={'MD':'🇲🇩','RO':'🇷🇴'};var btns='';var seen={};Object.keys(COUNTRIES).forEach(function(sn){var ci=COUNTRIES[sn];var cc=ci.country||sn;if(seen[cc])return;seen[cc]=true;var flag=_cf[cc]||'🌍';btns+='<button onclick="toggleExportLoc(\''+cc+'\')" id="eloc-'+cc+'" style="padding:3px 10px;font-size:11px;cursor:pointer;border-radius:5px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1)">'+flag+' '+ci.name+'</button>'});return btns})()+
    '</div></div>'+
    '</div></div>'+
    '<div style="padding:8px 24px 4px;flex-shrink:0;display:flex;justify-content:space-between;align-items:center">'+
    '<span id="exportPreviewLabel" style="font-size:11px;color:var(--text-2);font-family:monospace;letter-spacing:0"></span>'+
    '</div>'+
    '<div style="padding:0 24px 12px;flex:1;min-height:0;overflow:hidden">'+
    '<pre id="exportPreviewArea" style="margin:0;height:100%;min-height:180px;max-height:200px;overflow:auto;background:var(--bg-0);border:1px solid var(--border);border-radius:8px;color:var(--text-1);font-size:11px;font-family:monospace;padding:10px 12px;line-height:1.6;white-space:pre"></pre>'+
    '</div>'+
    '<div style="padding:12px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">'+
    '<button id="exportCopyBtn" onclick="copyExportData()" style="padding:7px 18px;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;color:var(--text-0);font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">📋 Скопировать</button>'+
    '<button onclick="downloadExportData()" style="padding:7px 18px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:13px;cursor:pointer;font-weight:600;display:flex;align-items:center;gap:6px">📥 Скачать файл</button>'+
    '</div>'+
    '</div>';
  document.body.appendChild(div);
}

function _rebuildExportModal(){
  switchExportTab(exportTab);
}

function _renderExportModemButtons(){
  var wrap=document.getElementById('exportModemFilterWrap');
  if(!wrap)return;
  var seen={};
  var modems=tableData.filter(function(r){return r.proxyLogin;}).map(function(r){return r.modemNick;}).filter(function(n){if(seen[n])return false;seen[n]=true;return true;});
  var html='<button onclick="clearExportModemFilter()" id="emod-all" style="padding:3px 9px;font-size:10px;cursor:pointer;border-radius:5px;border:1px solid var(--accent);background:var(--accent);color:#fff;white-space:nowrap">Все</button>';
  modems.forEach(function(nick){
    var eid='emod-'+nick.replace(/[^a-z0-9]/gi,'_');
    html+='<button onclick="toggleExportModem(\''+nick.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')" id="'+eid+'" style="padding:3px 9px;font-size:10px;cursor:pointer;border-radius:5px;border:1px solid var(--border);background:var(--bg-2);color:var(--text-1);white-space:nowrap">'+nick+'</button>';
  });
  wrap.innerHTML=html;
}

function toggleExportLoc(cc){
  if(cc===''){exportLocFilter=[];}
  else{var i=exportLocFilter.indexOf(cc);if(i===-1)exportLocFilter.push(cc);else exportLocFilter.splice(i,1);}
  var none=exportLocFilter.length===0;
  // Update all location buttons
  var allBtn=document.getElementById('eloc-all');
  if(allBtn){allBtn.style.background=none?'var(--accent)':'var(--bg-2)';allBtn.style.color=none?'#fff':'var(--text-1)';allBtn.style.border='1px solid '+(none?'var(--accent)':'var(--border)');}
  var seen={};
  Object.keys(COUNTRIES).forEach(function(sn){var c=COUNTRIES[sn].country||sn;if(seen[c])return;seen[c]=true;var btn=document.getElementById('eloc-'+c);if(!btn)return;var active=exportLocFilter.indexOf(c)!==-1;btn.style.background=active?'var(--accent)':'var(--bg-2)';btn.style.color=active?'#fff':'var(--text-1)';btn.style.border='1px solid '+(active?'var(--accent)':'var(--border)');});
  refreshExportPreview();
}
function toggleExportModem(nick){
  var i=exportModemFilter.indexOf(nick);if(i===-1)exportModemFilter.push(nick);else exportModemFilter.splice(i,1);
  _syncExportModemBtns();refreshExportPreview();
}
function clearExportModemFilter(){exportModemFilter=[];_syncExportModemBtns();refreshExportPreview();}
function _syncExportModemBtns(){
  var none=exportModemFilter.length===0;
  var ab=document.getElementById('emod-all');
  if(ab){ab.style.background=none?'var(--accent)':'var(--bg-2)';ab.style.color=none?'#fff':'var(--text-1)';ab.style.border='1px solid '+(none?'var(--accent)':'var(--border)');}
  var seen={};
  tableData.filter(function(r){return r.proxyLogin;}).forEach(function(r){
    if(seen[r.modemNick])return;seen[r.modemNick]=true;
    var btn=document.getElementById('emod-'+r.modemNick.replace(/[^a-z0-9]/gi,'_'));if(!btn)return;
    var act=exportModemFilter.indexOf(r.modemNick)!==-1;
    btn.style.background=act?'var(--accent)':'var(--bg-2)';btn.style.color=act?'#fff':'var(--text-1)';btn.style.border='1px solid '+(act?'var(--accent)':'var(--border)');
  });
}

function renderExportGrid(){
  var tab=exportTab;
  var fmts=EXPORT_FORMATS[tab]||[];
  var grid=document.getElementById('exportFormatGrid');
  if(!grid)return;
  if(tab==='custom'){grid.style.display='none';return;}
  grid.style.display='';
  var html='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">';
  fmts.forEach(function(f){
    var active=f.id===exportFormat;
    html+='<div onclick="selectExportFormat(\''+f.id+'\')" style="cursor:pointer;padding:10px 14px;border-radius:10px;border:2px solid '+(active?'var(--accent)':'var(--border)')+';background:'+(active?'rgba(25,96,201,0.08)':'var(--bg-2)')+';width:130px;height:96px;position:relative;transition:border-color .15s,background .15s;user-select:none;display:flex;flex-direction:column;flex-shrink:0">';
    html+='<div style="font-size:15px;margin-bottom:4px;font-family:monospace;font-weight:700;color:var(--text-0)">'+f.icon+'</div>';
    html+='<div style="font-size:12px;font-weight:600;color:var(--text-0)">'+f.label+'</div>';
    html+='<div style="font-size:10px;color:var(--text-3);margin-top:2px;line-height:1.3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+f.sub+'</div>';
    html+='<div style="margin-top:6px;display:inline-block;padding:1px 6px;background:var(--bg-0);border:1px solid var(--border);border-radius:4px;font-size:9px;color:var(--text-3);font-family:monospace">.'+f.ext+'</div>';
    if(active)html+='<div style="position:absolute;top:6px;right:8px;color:var(--accent);font-size:13px;font-weight:700">✓</div>';
    html+='</div>';
  });
  html+='</div>';
  grid.innerHTML=html;
}

function setTxtOrder(order){
  exportTxtOrder=order;
  renderExportGrid();
  refreshExportPreview();
}

function switchExportTab(tab){
  exportTab=tab;
  var fmts=EXPORT_FORMATS[tab]||[];
  exportFormat=fmts.length?fmts[0].id:(tab==='custom'?'custom':'');
  ['basic','devtools','system','custom'].forEach(function(t){
    var btn=document.getElementById('etab-'+t);
    if(btn){btn.style.borderBottom=t===tab?'2px solid var(--accent)':'2px solid transparent';btn.style.color=t===tab?'var(--accent)':'var(--text-2)';}
  });
  var ctr=document.getElementById('exportCustomTemplateRow');
  if(ctr)ctr.style.display=tab==='custom'?'':'none';
  renderExportGrid();
  refreshExportPreview();
  _saveExportState();
}

function selectExportFormat(fmtId){
  exportFormat=fmtId;
  renderExportGrid();
  refreshExportPreview();
  _saveExportState();
}

function setExportProto(proto){
  exportProto=proto;
  var hb=document.getElementById('eproto-http'),sb=document.getElementById('eproto-socks5');
  if(hb){hb.style.background=proto==='http'?'var(--accent)':'var(--bg-2)';hb.style.color=proto==='http'?'#fff':'var(--text-1)';hb.style.border='1px solid '+(proto==='http'?'var(--accent)':'var(--border)');}
  if(sb){sb.style.background=proto==='socks5'?'var(--accent)':'var(--bg-2)';sb.style.color=proto==='socks5'?'#fff':'var(--text-1)';sb.style.border='1px solid '+(proto==='socks5'?'var(--accent)':'var(--border)');sb.style.borderLeft='none';}
  refreshExportPreview();
  _saveExportState();
}

function setCustomTpl(tpl){
  var inp=document.getElementById('exportCustomTpl');
  if(inp){inp.value=tpl;refreshExportPreview();}
}

function getExportProxies(){
  var proto=exportProto;
  var rows=tableData.filter(function(r){return r.proxyLogin;});
  if(exportLocFilter.length>0) rows=rows.filter(function(r){var ci=COUNTRIES[r.serverName]||{};return exportLocFilter.indexOf(ci.country||r.serverName)!==-1;});
  if(exportModemFilter.length>0) rows=rows.filter(function(r){return exportModemFilter.indexOf(r.modemNick)!==-1;});
  var mapped=rows.map(function(r){
    var ci=COUNTRIES[r.serverName]||{};
    var host=ci.serverIp||r.serverName||'';
    var port=proto==='http'?(r.httpPort||''):(r.socksPort||'');
    return {host:host,port:port,login:r.proxyLogin,pass:r.proxyPassword,proto:proto,changeip:r.resetSecureLink||'',nick:r.modemNick||''};
  }).filter(function(p){return p.port;});
  // Deduplicate by login:pass@host:port (not just host:port — same IP may serve different modems)
  var seen={};
  var deduped=mapped.filter(function(p){
    var key=p.login+':'+p.pass+'@'+p.host+':'+p.port;
    if(seen[key])return false;
    seen[key]=true;return true;
  });
  if(deduped.length!==mapped.length) console.warn('Export: removed '+(mapped.length-deduped.length)+' duplicate proxies');
  return deduped;
}

function buildExportContent(fmt){
  var proxies=getExportProxies();
  if(!fmt)fmt=exportFormat;
  var lines=[];
  var proto=exportProto;
  var withRot=!!(document.getElementById('exportRotationCheck')||{}).checked;

  if(fmt==='txt_login_at'){
    proxies.forEach(function(p){
      lines.push(exportTxtOrder==='host_colon'?p.host+':'+p.port+':'+p.login+':'+p.pass:p.login+':'+p.pass+'@'+p.host+':'+p.port);
    });
  } else if(fmt==='json'){
    var arr=proxies.map(function(p){
      var obj={host:p.host,port:parseInt(p.port)||p.port,login:p.login,password:p.pass,protocol:p.proto};
      if(withRot&&p.changeip)obj.change_ip_url=p.changeip;
      return obj;
    });
    return JSON.stringify(arr,null,2);
  } else if(fmt==='csv'){
    var hdr=['host','port','login','password','protocol'];
    if(withRot)hdr.push('change_ip_url');
    lines.push(hdr.join(','));
    proxies.forEach(function(p){
      var row=[p.host,p.port,p.login,p.pass,p.proto];
      if(withRot)row.push(p.changeip||'');
      lines.push(row.join(','));
    });
  } else if(fmt==='curl'){
    proxies.forEach(function(p){lines.push('curl -x '+p.proto+'://'+p.login+':'+p.pass+'@'+p.host+':'+p.port+' https://example.com');});
  } else if(fmt==='python'){
    var py=['import requests','','proxies_list = ['];
    proxies.forEach(function(p,i){
      var u=p.proto+'://'+p.login+':'+p.pass+'@'+p.host+':'+p.port;
      var c=i<proxies.length-1?',':'';
      py.push('    {"http": "'+u+'",');py.push('     "https": "'+u+'"}'+c);
    });
    py.push(']','','# Используйте proxies_list[0] для первого прокси','response = requests.get("https://example.com", proxies=proxies_list[0])');
    return py.join('\n');
  } else if(fmt==='dotenv'){
    proxies.forEach(function(p,i){lines.push('PROXY_'+(i+1)+'='+p.proto+'://'+p.login+':'+p.pass+'@'+p.host+':'+p.port);});
    lines.push('PROXY_COUNT='+proxies.length);
  } else if(fmt==='pac'){
    var ps=proxies.map(function(p){return 'PROXY '+p.host+':'+p.port;}).join('; ');
    return 'function FindProxyForURL(url, host) {\n  return "'+ps+'";\n}';
  } else if(fmt==='foxyproxy'){
    var fp={mode:'patterns',proxySettings:proxies.map(function(p,i){return {id:i+1,type:proto==='http'?3:2,host:p.host,port:parseInt(p.port)||0,username:p.login,password:p.pass};})};
    return JSON.stringify(fp,null,2);
  } else if(fmt==='proxifier'){
    var xl=['<?xml version="1.0" encoding="UTF-8" ?>','<ProxifierProfile version="3.00">','  <ProxyList>'];
    proxies.forEach(function(p,i){
      xl.push('    <Proxy id="'+(i+1)+'" type="'+(proto==='http'?'HTTPS':'SOCKS5')+'">');
      xl.push('      <Address>'+p.host+'</Address><Port>'+p.port+'</Port>');
      xl.push('      <Authentication enabled="1"><Username>'+p.login+'</Username><Password>'+p.pass+'</Password></Authentication>');
      xl.push('    </Proxy>');
    });
    xl.push('  </ProxyList>','</ProxifierProfile>');
    return xl.join('\n');
  } else if(fmt==='custom'){
    var tpl=(document.getElementById('exportCustomTpl')||{}).value||'{{LOGIN}}:{{PASS}}@{{HOST}}:{{PORT}}';
    proxies.forEach(function(p){
      lines.push(tpl.replace(/\{\{LOGIN\}\}/g,p.login).replace(/\{\{PASS\}\}/g,p.pass).replace(/\{\{HOST\}\}/g,p.host).replace(/\{\{PORT\}\}/g,p.port).replace(/\{\{PROTO\}\}/g,p.proto).replace(/\{\{CHANGEIP\}\}/g,p.changeip||''));
    });
  }
  return lines.join('\n');
}

function getExportExt(){
  var all=[].concat(EXPORT_FORMATS.basic,EXPORT_FORMATS.devtools,EXPORT_FORMATS.system,EXPORT_FORMATS.custom);
  var f=all.find(function(x){return x.id===exportFormat;});
  return f?f.ext:'txt';
}

function refreshExportPreview(){
  var content=buildExportContent(exportFormat);
  var area=document.getElementById('exportPreviewArea');
  var lbl=document.getElementById('exportPreviewLabel');
  var proxies=getExportProxies();
  var all=[].concat(EXPORT_FORMATS.basic,EXPORT_FORMATS.devtools,EXPORT_FORMATS.system,EXPORT_FORMATS.custom);
  var f=all.find(function(x){return x.id===exportFormat;});
  if(lbl)lbl.textContent=proxies.length+' прокси · формат: '+(f?f.label:exportFormat)+' · файл: .'+getExportExt();
  if(area){
    var lines=content.split('\n');
    var preview=lines.slice(0,10).join('\n');
    if(lines.length>10)preview+='\n\n... и ещё '+(lines.length-10)+' строк';
    area.textContent=preview;
  }
}

function copyExportData(){
  var content=buildExportContent(exportFormat);
  var btn=document.getElementById('exportCopyBtn');
  var ok=function(){if(btn){var o=btn.innerHTML;btn.innerHTML='✓ Скопировано';btn.style.color='var(--success)';setTimeout(function(){btn.innerHTML=o;btn.style.color='';},2000);}};
  navigator.clipboard.writeText(content).then(ok).catch(function(){
    var ta=document.createElement('textarea');ta.value=content;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok();
  });
}

function downloadExportData(){
  var content=buildExportContent(exportFormat);
  var ext=getExportExt();
  var all=[].concat(EXPORT_FORMATS.basic,EXPORT_FORMATS.devtools,EXPORT_FORMATS.system,EXPORT_FORMATS.custom);
  var f=all.find(function(x){return x.id===exportFormat;});
  var fn=f?f.label.toLowerCase().replace(/[\s.]+/g,'_').replace(/[^a-z0-9_]/g,''):exportFormat;
  var d=new Date();
  var ds=d.getFullYear()+'-'+(d.getMonth()<9?'0':'')+(d.getMonth()+1)+'-'+(d.getDate()<10?'0':'')+d.getDate();
  var fname='proxies_'+fn+'_'+ds+'.'+ext;
  var mime=ext==='json'?'application/json':ext==='csv'?'text/csv':ext==='pac'?'application/x-ns-proxy-autoconfig':ext==='ppx'?'application/xml':ext==='py'?'text/x-python':ext==='sh'?'text/x-shellscript':'text/plain';
  downloadFile(content,fname,mime);
  showToast('Файл скачан','success');
}
