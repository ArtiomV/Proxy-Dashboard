// public/js/admin/finance.js — finance tabs (WP6.3 carve-out from admin.js,
// VERBATIM): Финансы tab (dashboard, costs), ops documents/acts/bills,
// bank config/documents/bills/payments, MRR/revenue charts.

function setFinPeriod(p,btn){
  _finPeriod=p;
  document.querySelectorAll('.fin-period-btn').forEach(function(b){b.classList.remove('active')});
  if(btn)btn.classList.add('active');
  var oldPeriod=accPeriod;
  setAccPeriodSilent(p);
  renderFinancesTab(collectTrafficData());
  setAccPeriodSilent(oldPeriod);
}
function setAccPeriodSilent(p){
  accPeriod=p;
  // update getTrafficFields without re-rendering traffic tab
}
function shortCurrency(val){return Math.round(val).toLocaleString('ru-RU')+' ₽'}
// Replaced by renderFinancesTabNew (calls /api/admin/finance_dashboard).
// Old per-client traffic table left below for reference / debug, but main entry
// point now hits the new SaaS-style dashboard.
function renderFinancesTab(d){
  return renderFinancesTabNew();
}
function _renderFinancesTabOld(d){
  if(!d)d=collectTrafficData();if(!d)return;
  var daysEl=getDaysElapsed();
  var sortedClients=(currentData.clients||[]).slice().sort(function(a,b){
    var aKey=a.portName||a.username||'';var bKey=b.portName||b.username||'';
    var aT=d.modemTraffic.filter(function(m){return m.pn===aKey}).reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    var bT=d.modemTraffic.filter(function(m){return m.pn===bKey}).reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    return bT-aT;
  });
  var clientStats=[];var totalRevenue=0;var totalTrafficBytes=0;var totalPaid=0;var totalCharged=0;
  sortedClients.forEach(function(cl,i){
    var ctKey=cl.portName||cl.username||cl.name||'';
    var clModems=d.modemTraffic.filter(function(m){return m.pn===ctKey});
    var modemCount=clModems.length;
    var monBytes=clModems.reduce(function(s,m){return s+(m.monIn||0)+(m.monOut||0)},0);
    var prevBytes=clModems.reduce(function(s,m){return s+(m.prevIn||0)+(m.prevOut||0)},0);
    var monGb=monBytes/1e9;var prevGb=prevBytes/1e9;
    var charged=0;var tariffStr='—';
    var bt=cl.billingType||'';var price=cl.price||0;
    if(bt==='per_gb'){charged=monGb*price;tariffStr=price+'₽/ГБ';}
    else if(bt==='per_modem'){charged=price*modemCount;tariffStr=price+'₽/мод';}
    totalRevenue+=charged;totalTrafficBytes+=monBytes;totalCharged+=charged;
    var paid=0;(cl.payments||[]).forEach(function(p){paid+=p.amount||0});totalPaid+=paid;
    var balance=cl.balance||0;
    var costPerGb=monGb>0?Math.round(charged/monGb):0;
    var vsPrev=prevGb>0?Math.round((monGb-prevGb)/prevGb*100):null;
    var color=CHART_COLORS.clients[i%CHART_COLORS.clients.length];
    // Sparkline: daily traffic last 7 days from modem data
    var sparkData=[];
    clModems.forEach(function(m){if(m.dailyArr&&m.dailyArr.length>0)for(var di=0;di<m.dailyArr.length;di++){sparkData[di]=(sparkData[di]||0)+m.dailyArr[di]}});
    var spark7=sparkData.slice(-7);while(spark7.length<7)spark7.unshift(0);
    clientStats.push({cl:cl,ctKey:ctKey,modemCount:modemCount,monBytes:monBytes,monGb:monGb,prevGb:prevGb,charged:charged,tariffStr:tariffStr,balance:balance,costPerGb:costPerGb,vsPrev:vsPrev,color:color,paid:paid,spark7:spark7});
  });
  var totalGb=totalTrafficBytes/1e9;
  var avgRubPerGb=totalGb>0?Math.round(totalRevenue/totalGb):0;
  var activeModemsCount=d.modemTraffic.filter(function(m){return(m.monIn||0)+(m.monOut||0)>0}).length;
  var debtClientsCount=clientStats.filter(function(s){return s.balance<0}).length;
  var projectedMonthly=daysEl>0?Math.round(totalRevenue/daysEl*30):0;
  var revenueVsPrev=clientStats.reduce(function(s,c){return s+(c.prevGb*(c.cl.price||0))},0);
  var revenueGrowth=revenueVsPrev>0?Math.round((totalRevenue-revenueVsPrev)/revenueVsPrev*100):null;
  var avgRevenuePerModem=activeModemsCount>0?Math.round(totalRevenue/activeModemsCount):0;
  var activeClients=clientStats.filter(function(s){return s.monBytes>0}).length;
  var arpu=activeClients>0?Math.round(totalRevenue/activeClients):0;
  var revenuePerDay=daysEl>0?Math.round(totalRevenue/daysEl):0;

  var out='<div style="padding:14px 24px">';

  // Block A: Header + period selector
  var finPeriod=localStorage.getItem('fin_period')||'7d';
  out+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  out+='<h2 style="font-size:18px;font-weight:700;color:var(--text-0);margin:0">Доходность</h2>';
  out+='<div class="fin-period-group">';
  ['1d:Сегодня','7d:7 дней','30d:30 дней','q:Квартал','y:Год'].forEach(function(p){var parts=p.split(':');out+='<button class="fin-period-btn'+(finPeriod===parts[0]?' active':'')+'" onclick="localStorage.setItem(\'fin_period\',\''+parts[0]+'\');this.parentElement.querySelectorAll(\'.fin-period-btn\').forEach(function(b){b.classList.remove(\'active\')});this.classList.add(\'active\')">'+parts[1]+'</button>'});
  out+='</div></div>';

  // Block B: KPI cards (4)
  out+='<div class="fin-summary">';
  out+='<div class="fin-card fin-card--accent"><div class="fc-label">Выручка за период</div><div class="fc-value">'+shortCurrency(totalRevenue)+'</div>'+(revenueGrowth!==null?'<div class="fc-sub '+(revenueGrowth>=0?'up':'dn')+'">'+(revenueGrowth>=0?'↑':'↓')+' '+Math.abs(revenueGrowth)+'% vs пр. период</div>':'')+'</div>';
  out+='<div class="fin-card"><div class="fc-label">Прогноз на месяц</div><div class="fc-value">'+shortCurrency(projectedMonthly)+'</div><div class="fc-sub">на основе '+daysEl+' дн.</div></div>';
  out+='<div class="fin-card"><div class="fc-label">Средний ₽/ГБ</div><div class="fc-value">'+avgRubPerGb+' ₽</div><div class="fc-sub">'+fmtGb(totalTrafficBytes)+' трафика</div></div>';
  out+='<div class="fin-card'+(debtClientsCount>0?' fin-card--alert':'')+'"><div class="fc-label">Долги</div><div class="fc-value" style="color:'+(debtClientsCount>0?'var(--danger)':'var(--success)')+'">'+debtClientsCount+'</div><div class="fc-sub">'+(debtClientsCount>0?'клиентов с отриц. балансом':'все балансы в норме')+'</div></div>';
  out+='</div>';

  // Block C: Widget grid (6)
  out+='<div class="widget-grid" style="grid-template-columns:repeat(6,1fr);margin-bottom:12px;padding:0">';
  out+='<div class="widget"><div class="widget-label">Трафик за период</div><div class="widget-value" style="font-size:16px">'+fmtGb(totalTrafficBytes)+'</div></div>';
  out+='<div class="widget"><div class="widget-label">Доход / модем</div><div class="widget-value" style="font-size:16px">'+avgRevenuePerModem.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Доход / сутки</div><div class="widget-value" style="font-size:16px">'+revenuePerDay.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Активных модемов</div><div class="widget-value" style="font-size:16px">'+activeModemsCount+'</div></div>';
  out+='<div class="widget"><div class="widget-label">ARPU</div><div class="widget-value" style="font-size:16px">'+arpu.toLocaleString('ru-RU')+' ₽</div></div>';
  out+='<div class="widget"><div class="widget-label">Маржа, ₽/ГБ</div><div class="widget-value" style="font-size:16px;color:var(--success)">'+avgRubPerGb+' ₽</div></div>';
  out+='</div>';

  // Block D: Revenue chart placeholder
  out+='<div class="analytics-card" style="margin-bottom:12px"><h3>Выручка по дням</h3><div id="finRevenueChartWrap" style="max-height:200px"><canvas id="finRevenueChart"></canvas></div></div>';

  // Block E: Client table
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Финансы по клиентам</div><div class="fin-table-badge">'+clientStats.length+' клиентов</div></div>';
  out+='<table class="fin-table"><thead><tr>';
  ['Клиент','Тариф','Трафик','Δ пр. период','Модемов','Начислено','₽/ГБ','Баланс','Тренд'].forEach(function(h){out+='<th>'+h+'</th>'});
  out+='</tr></thead><tbody>';
  clientStats.forEach(function(s){
    var inactive=s.monBytes===0&&s.modemCount===0;
    out+='<tr'+(inactive?' class="row-inactive"':'')+'>';
    out+='<td><div style="display:flex;align-items:center;gap:6px"><div class="client-dot" style="background:'+s.color+'"></div><span style="font-weight:600">'+esc(s.cl.name||s.ctKey)+'</span></div></td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-size:11px">'+esc(s.tariffStr)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-weight:600">'+fmtGb(s.monBytes)+'</td>';
    if(s.vsPrev!==null){out+='<td style="text-align:center"><span class="badge-delta '+(s.vsPrev>=0?'up':'dn')+'">'+(s.vsPrev>=0?'+':'')+s.vsPrev+'%</span></td>'}else{out+='<td style="text-align:center">—</td>'}
    out+='<td style="text-align:center">'+s.modemCount+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono)">'+shortCurrency(s.charged)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono)">'+(s.costPerGb>0?s.costPerGb+' ₽':'—')+'</td>';
    if(s.balance<0)out+='<td style="text-align:center"><span class="badge-neg">'+Math.round(s.balance).toLocaleString('ru-RU')+' ₽</span></td>';
    else if(s.balance>0)out+='<td style="text-align:center"><span class="badge-pos">+'+Math.round(s.balance).toLocaleString('ru-RU')+' ₽</span></td>';
    else out+='<td style="text-align:center;color:var(--text-3)">0 ₽</td>';
    // Sparkline
    var maxSp=Math.max.apply(null,s.spark7)||1;
    out+='<td style="text-align:center"><div class="widget-spark" style="display:inline-flex;height:18px;width:42px">';
    s.spark7.forEach(function(v){var h=Math.max(2,Math.round(v/maxSp*18));out+='<div class="widget-spark-bar" style="height:'+h+'px;background:'+s.color+';opacity:.6"></div>'});
    out+='</div></td>';
    out+='</tr>';
  });
  out+='</tbody></table></div>';

  // Block F: Two tables side by side
  out+='<div class="fin-bottom">';

  // Left: Operator efficiency
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Эффективность операторов</div></div>';
  out+='<table class="fin-table"><thead><tr>';
  ['Оператор','Модемов','Трафик','Выручка','₽/мод','₽/ГБ'].forEach(function(h){out+='<th>'+h+'</th>'});
  out+='</tr></thead><tbody>';
  var opStats={};
  d.modemTraffic.forEach(function(m){
    var op=m.operator;if(!op)return;
    if(!opStats[op])opStats[op]={cnt:0,t:0,rev:0};
    opStats[op].cnt++;opStats[op].t+=(m.monIn||0)+(m.monOut||0);
    var cl=(currentData.clients||[]).find(function(c){return(c.portName||c.username)===m.pn});
    if(cl){var tGb=((m.monIn||0)+(m.monOut||0))/1e9;var cbt=cl.billingType||'';var cp=cl.price||0;
      if(cbt==='per_gb')opStats[op].rev+=tGb*cp;else if(cbt==='per_modem')opStats[op].rev+=cp;}
  });
  Object.keys(opStats).sort(function(a,b){return opStats[b].rev-opStats[a].rev}).forEach(function(op){
    var v=opStats[op];var tGb=v.t/1e9;var rpm=v.cnt>0?Math.round(v.rev/v.cnt):0;var rpg=tGb>0?Math.round(v.rev/tGb):0;
    var flag='';var opL=op.toLowerCase();
    if(opL.indexOf('orange ro')>-1||opL.indexOf('vodafone')>-1)flag='🇷🇴 ';
    else if(opL.indexOf('orange md')>-1||opL.indexOf('moldtelecom')>-1)flag='🇲🇩 ';
    var rpgBadge=rpg<500?'background:rgba(52,199,89,.12);color:var(--success)':rpg>1000?'background:rgba(230,126,34,.12);color:#e67e22':'';
    out+='<tr><td>'+flag+esc(op)+'</td><td style="text-align:center">'+v.cnt+'</td><td style="text-align:center;font-family:var(--font-mono)">'+fmtGb(v.t)+'</td>';
    out+='<td style="text-align:center;font-family:var(--font-mono);font-weight:600">'+shortCurrency(v.rev)+'</td>';
    out+='<td style="text-align:center;color:var(--text-2)">'+rpm.toLocaleString('ru-RU')+' ₽</td>';
    out+='<td style="text-align:center">'+(rpgBadge?'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'+rpgBadge+'">'+rpg+' ₽</span>':rpg+' ₽')+'</td></tr>';
  });
  out+='</tbody></table></div>';

  // Right: Top modems by revenue
  var _finModSort=window._finModSort||'revenue';var _showAllMod=window._showAllModemRev||false;
  var modemRevMap={};
  d.modemTraffic.forEach(function(m){
    var cl=(currentData.clients||[]).find(function(c){return(c.portName||c.username)===m.pn});if(!cl)return;
    var tGb=((m.monIn||0)+(m.monOut||0))/1e9;var bt=cl.billingType||'';var price=cl.price||0;
    var rev=bt==='per_gb'?tGb*price:bt==='per_modem'?price:0;
    if(!modemRevMap[m.nick]){modemRevMap[m.nick]={nick:m.nick,operator:m.operator||'—',tGb:0,rev:0}}
    modemRevMap[m.nick].tGb+=tGb;modemRevMap[m.nick].rev+=rev;
  });
  var modemRevRows=Object.keys(modemRevMap).map(function(nick){var r=modemRevMap[nick];r.revPerGb=r.tGb>0?r.rev/r.tGb:0;return r});
  modemRevRows.sort(function(a,b){return _finModSort==='per_gb'?b.revPerGb-a.revPerGb:b.rev-a.rev});
  out+='<div class="fin-table-wrap"><div class="fin-table-header"><div class="fin-table-title">Топ модемов по доходу</div>';
  out+='<div class="view-toggle"><button class="'+(_finModSort==='revenue'?'active':'')+'" onclick="window._finModSort=\'revenue\';renderFinancesTab()">По доходу</button><button class="'+(_finModSort==='per_gb'?'active':'')+'" onclick="window._finModSort=\'per_gb\';renderFinancesTab()">По ₽/ГБ</button></div></div>';
  out+='<table class="fin-table"><thead><tr><th>Модем</th><th>Оператор</th><th>Трафик</th><th style="font-weight:700">Доход</th><th>₽/ГБ</th></tr></thead><tbody>';
  var visModems=_showAllMod?modemRevRows:modemRevRows.slice(0,6);
  visModems.forEach(function(r){
    var rpg=r.tGb>0?Math.round(r.rev/r.tGb):0;
    var flag='';var opL=(r.operator||'').toLowerCase();
    if(opL.indexOf('orange ro')>-1||opL.indexOf('vodafone')>-1)flag='🇷🇴 ';
    else if(opL.indexOf('orange md')>-1||opL.indexOf('moldtelecom')>-1)flag='🇲🇩 ';
    out+='<tr><td><span class="modem-link" onclick="var mm=currentData._modemMap;for(var k in mm){if(mm[k].nick===\''+esc(r.nick).replace(/'/g,"\\'")+'\'){showDetails(mm[k]);break}}">'+esc(r.nick)+'</span></td>';
    out+='<td style="color:var(--text-2)">'+flag+esc(r.operator)+'</td>';
    out+='<td style="font-family:var(--font-mono)">'+r.tGb.toFixed(1)+' ГБ</td>';
    out+='<td style="font-family:var(--font-mono);font-weight:600">'+shortCurrency(r.rev)+'</td>';
    out+='<td style="font-family:var(--font-mono)">'+rpg+' ₽</td></tr>';
  });
  out+='</tbody></table>';
  if(!_showAllMod&&modemRevRows.length>6){
    out+='<div class="show-more-row"><button onclick="window._showAllModemRev=true;renderFinancesTab()">Показать все '+modemRevRows.length+' ↓</button></div>';
  }
  out+='</div>';
  out+='</div>'; // fin-bottom

  out+='</div>'; // padding wrapper
  document.getElementById('acc-finances').innerHTML=out;
}

// ========== ДОХОДНОСТЬ (новая SaaS-style страница) ==========
var _finCharts = {};
var _finCurrentPeriod = new Date().toISOString().slice(0, 7);

function renderFinancesTabNew() {
  var c = document.getElementById('bankOverviewSection') || document.getElementById('acc-finances');
  if (!c) return;
  c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">Загрузка финансовых данных…</div>';
  // Destroy old charts
  for (var k in _finCharts) { try { _finCharts[k].destroy(); } catch (_) {} }
  _finCharts = {};

  api(API + '/api/admin/finance_dashboard?period=' + encodeURIComponent(_finCurrentPeriod))
    .then(function(d) {
      if (d.error) { c.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(d.error) + '</div>'; return; }
      _renderFinanceDashboard(c, d);
    })
    .catch(function(e) { c.innerHTML = '<div style="color:var(--danger);padding:20px">' + esc(e.message) + '</div>'; });
}

function _fmtRub(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('ru-RU') + ' ₽';
}
function _fmtPct(v, signed) {
  if (v == null || isNaN(v)) return '—';
  var s = (signed && v > 0 ? '+' : '') + v;
  return s + '%';
}
function _kpiBig(label, value, sub, color) {
  var _grn = color && String(color).indexOf('success') >= 0;
  return '<div class="cd-kpi' + (_grn ? ' is-green' : '') + '" style="flex:1;min-width:170px;padding:12px 14px">'
    + '<div class="cd-kpi-l">' + esc(label) + '</div>'
    + '<div class="cd-kpi-v" style="font-size:22px;margin-top:4px;' + (color ? 'color:' + color : '') + '">' + value + '</div>'
    + (sub ? '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + sub + '</div>' : '')
    + '</div>';
}

function _injectFinxStyle() { /* finance styles now live in css/finance.css */ }

function _renderFinanceDashboard(c, d) {
  var s = d.summary || {};
  var costByCat = d.cost_by_category || {};
  _injectFinxStyle();

  var periods = [];
  for (var i = 0; i < 12; i++) { var dt = new Date(); dt.setMonth(dt.getMonth() - i); periods.push(dt.toISOString().slice(0, 7)); }

  function money(v) { return (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽'; }

  // Revenue is taken for the SELECTED period (from the monthly trend), so the
  // date picker actually drives the headline P&L. Current month → revenue so far.
  var curMonth = new Date().toISOString().slice(0, 7);
  var isCur = d.period === curMonth;
  var trendArr = d.trend || [];
  var pIdx = trendArr.map(function(t) { return t.month; }).indexOf(d.period);
  var revenue = pIdx >= 0 ? (trendArr[pIdx].total || 0) : (isCur ? (s.forecast_so_far || 0) : 0);
  var cost = s.total_cost || 0;
  var profit = revenue - cost;
  var costPct = revenue > 0 ? Math.round(cost / revenue * 100) : 0;
  var marginPct = (revenue > 0 && cost > 0) ? Math.round(profit / revenue * 100) : null;
  var profitForecast = (s.forecast_eom || 0) - cost;
  var posBal = (d.per_client || []).reduce(function(a, p) { return a + (p.balance > 0 ? p.balance : 0); }, 0);

  // M/M growth = selected period vs the previous month in the trend
  var prevRev = pIdx > 0 ? (trendArr[pIdx - 1].total || 0) : 0;
  var g = prevRev > 0 ? Math.round((revenue - prevRev) / prevRev * 1000) / 10 : null;
  var growthSub = (g == null)
    ? '<span style="color:var(--t3)">нет данных м/м</span>'
    : '<span style="color:' + (g >= 0 ? 'var(--gr)' : 'var(--rd)') + '">' + (g >= 0 ? '▲ +' : '▼ ') + Math.abs(g) + '%</span> м/м';

  var h = '<div class="fxw">';

  h += '<div class="fx-hd"><h2 class="fx-h">Финансы</h2><div class="fx-act">';
  h += '<button class="fx-btn" onclick="generateBulkActs()">📃 Сформировать акты</button>';
  h += '<button class="fx-btn" onclick="openFinanceCostsModal()">⚙ Затраты</button>';
  h += '<select id="finPeriodSelect" class="fx-sel" onchange="_finCurrentPeriod=this.value;renderFinancesTabNew()">';
  periods.forEach(function(p) { h += '<option value="' + p + '"' + (p === d.period ? ' selected' : '') + '>' + p + '</option>'; });
  h += '</select></div></div>';

  h += '<div class="fx-kpis">';
  h += '<div class="fx-kpi"><div class="fx-kl">Выручка</div><div class="fx-kv">' + money(revenue) + '</div><div class="fx-ks">' + growthSub + '</div></div>';
  var costSub = cost > 0
    ? (s.cost_carried_from ? '<span style="color:var(--am)">типовые из ' + esc(s.cost_carried_from) + '</span> · ' + costPct + '%' : (costPct + '% от выручки'))
    : '<span style="color:var(--am)">не введены</span>';
  h += '<div class="fx-kpi a"><div class="fx-kl">Затраты</div><div class="fx-kv">' + (cost > 0 ? money(cost) : '—') + '</div><div class="fx-ks">' + costSub + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Прибыль</div><div class="fx-kv" style="color:var(--gr)">' + money(profit) + '</div><div class="fx-ks">' + (isCur ? 'прогноз ' + shortCurrency(profitForecast) : 'за месяц') + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Маржа</div><div class="fx-kv" style="color:var(--gr)">' + (marginPct == null ? '—' : marginPct + '%') + '</div><div class="fx-ks">' + (s.margin_per_modem != null ? Math.round(s.margin_per_modem).toLocaleString('ru-RU') + ' ₽/модем' : '') + '</div></div>';
  h += '</div>';

  h += '<div class="fx-wgs">';
  h += '<div class="fx-wg"><div class="fx-wl">Активных клиентов</div><div class="fx-wv">' + (s.active_clients || 0) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">NRR</div><div class="fx-wv"' + (s.nrr_pct >= 100 ? ' style="color:var(--gr)"' : '') + '>' + (s.nrr_pct == null ? '—' : s.nrr_pct + '%') + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">На балансах</div><div class="fx-wv">' + shortCurrency(posBal) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">ARPU</div><div class="fx-wv">' + money(s.arpu) + '</div></div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Выручка по дням</span><span class="fx-cs">последние 30 дней · ₽</span></div>';
  h += '<div style="height:130px"><canvas id="fxDailyChart"></canvas></div></div>';

  h += '<div class="fx-row2">';
  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Затраты по категориям</span><span class="fx-lk" onclick="openFinanceCostsModal()">✎ править</span></div>';
  var catLabels = { server: 'Аренда серверов', sim: 'SIM-карты', electricity: 'Электричество', hosting: 'Хостинг', salary: 'Зарплата', other: 'Прочее' };
  var anyCost = false;
  Object.keys(catLabels).forEach(function(k) {
    var v = costByCat[k] || 0;
    if (v > 0) { anyCost = true; h += '<div class="fx-lr"><span class="fx-nm">' + catLabels[k] + '</span><span class="fx-vv">' + Math.round(v).toLocaleString('ru-RU') + '</span></div>'; }
  });
  if (anyCost) {
    if (s.cost_carried_from) h += '<div style="font-size:10px;color:var(--am);margin:2px 0 4px">⚠ Типовые значения из ' + esc(s.cost_carried_from) + ' — подтвердите через «править»</div>';
    h += '<div class="fx-tot"><span>Итого</span><span class="fx-vv" style="color:var(--am)">' + money(cost) + '</span></div>';
  }
  else h += '<div class="fx-empty">Затраты за ' + esc(d.period) + ' не введены — нажмите «править».</div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Последние платежи</span><span class="fx-lk" onclick="switchBankNav(\'payments\')">все →</span></div>';
  var rp = d.recent_payments || [];
  if (rp.length === 0) h += '<div class="fx-empty">Платежей пока нет.</div>';
  else rp.forEach(function(p) {
    var pos = p.amount >= 0;
    var sub = esc((p.date || '').slice(5)) + ' · ' + esc(p.source);
    if (p.kind === 'списание') sub += ' · ' + esc(p.note || 'списание');
    h += '<div class="fx-lr"><div><div class="fx-nm">' + esc(p.client) + '</div><div class="fx-sub">' + sub + '</div></div>'
      + '<span class="fx-vv ' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '−') + Math.abs(Math.round(p.amount)).toLocaleString('ru-RU') + '</span></div>';
  });
  h += '</div></div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Доходность по клиентам</span><span class="fx-cs">по MRR</span></div>';
  h += '<div style="overflow-x:auto"><table class="fx-tbl"><thead><tr><th>Клиент</th><th>Тариф</th><th>Выручка</th><th>Δ M/M</th><th>% MRR</th><th>Баланс</th></tr></thead><tbody>';
  var rows = (d.per_client || []).filter(function(p) { return !(p.mrr === 0 && p.mrr_prev === 0 && !p.balance); });
  rows.forEach(function(p, i) {
    var col = CHART_COLORS.clients[i % CHART_COLORS.clients.length];
    var pausedTag = p.paused ? ' <span class="fx-pause">пауза</span>' : '';
    var dc = p.mrr_delta_pct == null ? 'var(--t3)' : p.mrr_delta_pct >= 0 ? 'var(--gr)' : 'var(--rd)';
    var ds = p.mrr_delta_pct == null ? '—' : (p.mrr_delta_pct >= 0 ? '+' : '') + p.mrr_delta_pct + '%';
    var pill = p.billingType === 'per_modem' ? '<span class="fx-pill pm">per_modem</span>' : '<span class="fx-pill pg">per_gb</span>';
    var balCol = p.balance < 0 ? 'var(--rd)' : 'var(--t1)';
    h += '<tr><td><span class="fx-cn"><span class="fx-dot" style="background:' + col + '"></span>' + esc(p.name) + pausedTag + '</span></td>'
      + '<td>' + pill + '</td><td>' + money(p.mrr) + '</td>'
      + '<td style="color:' + dc + '">' + ds + '</td><td>' + (p.share_pct || 0) + '%</td>'
      + '<td style="color:' + balCol + '">' + money(p.balance) + '</td></tr>';
  });
  h += '</tbody></table></div></div>';

  h += '</div>';
  c.innerHTML = h;

  setTimeout(function() {
    var dcv = document.getElementById('fxDailyChart');
    if (dcv && window.Chart) {
      var dr = d.daily_revenue || [];
      var vals = dr.map(function(r) { return r.revenue; });
      var maxv = Math.max.apply(null, vals.concat([1]));
      var cols = vals.map(function(v) { return v >= maxv * 0.85 ? '#16a34a' : '#2f6fe0'; });
      _finCharts.daily = newChartSafe(dcv, {
        type: 'bar',
        data: { labels: dr.map(function(r) { return (r.date || '').slice(5); }), datasets: [Object.assign({ data: vals, backgroundColor: cols, borderRadius: chartStackRadius() }, CHART_BAR_STACK)] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { return (ctx.parsed.y || 0).toLocaleString('ru-RU') + ' ₽'; } } } },
          scales: {
            x: { ticks: { color: '#8b949e', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: '#8b949e', font: { size: 9 }, callback: function(v) { return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v; } }, grid: { color: 'rgba(0,0,0,.07)' } }
          }
        }
      });
    }
  }, 30);
}

// ===== Costs modal =====
function openFinanceCostsModal() {
  api(API + '/api/admin/monthly_costs?period=' + encodeURIComponent(_finCurrentPeriod))
    .then(function(d){ _renderCostsModal(d); })
    .catch(function(e){ showToast(e.message, 'error') });
}
function _renderCostsModal(d) {
  var ov = document.createElement('div');
  ov.id = '_finCostsOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
  var rows = (d.rows && d.rows.length) ? d.rows : (d.template || []).map(function(t){return Object.assign({},t)});
  var byCat = {};
  rows.forEach(function(r){ (byCat[r.category]=byCat[r.category]||[]).push(r); });

  var cats = d.categories || {};
  // One labelled cost row in the Settings idiom (left title, right input + ₽ unit).
  // data-cat / data-key on the <input> are READ BY saveCostsModal — must be preserved.
  function _costRow(label, cls, cat, key, step, val){
    return '<div class="set-row"><div class="set-row-t">'+label+'</div>'
      + '<span class="set-inp"><input class="'+cls+'" data-cat="'+cat+'"'+(key!=null?' data-key="'+esc(key)+'"':'')
      + ' type="number" min="0" step="'+step+'" value="'+(val!=null?val:'')+'" placeholder="0" style="width:108px;text-align:right"><span>₽</span></span></div>';
  }
  var inputs = '';
  // Server costs
  var srvList = (d.meta && d.meta.servers) || ['S1','S2','S3','S4'];
  inputs += '<div class="set-grp-label">'+(cats.server?cats.server.label:'Аренда серверов')+'</div><div class="set-card">';
  srvList.forEach(function(s){
    var existing = (byCat.server||[]).find(function(r){return r.subkey===s});
    inputs += _costRow(esc(s), 'form-input fc-server', 'server', s, 100, existing?existing.amount:null);
  });
  inputs += '</div>';
  // SIM (per operator)
  var ops = (d.meta && d.meta.operators) || [];
  inputs += '<div class="set-grp-label">'+(cats.sim?cats.sim.label:'SIM-карты')+' (₽/SIM в месяц)</div><div class="set-card">';
  if (ops.length === 0) {
    inputs += '<div class="set-row"><div class="set-row-d" style="max-width:none">Операторы не определены — укажите общую сумму через «Прочее»</div></div>';
  } else {
    ops.forEach(function(op){
      var existing = (byCat.sim||[]).find(function(r){return r.subkey===op});
      inputs += _costRow(esc(op), 'form-input fc-sim', 'sim', op, 10, existing?existing.amount:null);
    });
  }
  inputs += '</div>';
  // Other (single value, no subkey)
  inputs += '<div class="set-grp-label">Прочие затраты</div><div class="set-card">';
  ['electricity','hosting','salary','other'].forEach(function(k){
    var existing = (byCat[k]||[])[0];
    inputs += _costRow((cats[k]?cats[k].label:k), 'form-input fc-other', k, null, 100, existing?existing.amount:null);
  });
  inputs += '</div>';

  ov.innerHTML = '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;width:560px;max-width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
    + '<h3 style="margin:0;font-size:14px">⚙ Затраты — ' + esc(d.period) + '</h3>'
    + '<button onclick="document.getElementById(\'_finCostsOverlay\').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-2)">&times;</button>'
    + '</div>'
    + (rows.length === 0 && (d.template || []).length > 0 ? '<div style="font-size:11px;color:var(--accent);margin-bottom:6px">⚠ Подставлены значения из предыдущего месяца — отредактируйте и сохраните</div>' : '')
    + inputs
    + '<div class="set-save-bar" style="justify-content:flex-end">'
    + '<button class="btn" onclick="document.getElementById(\'_finCostsOverlay\').remove()">Отмена</button>'
    + '<button class="btn btn-primary" onclick="saveCostsModal()">💾 Сохранить</button>'
    + '</div></div>';
  document.body.appendChild(ov);
}
function saveCostsModal() {
  var items = [];
  document.querySelectorAll('#_finCostsOverlay input').forEach(function(inp){
    var v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) return;
    items.push({ category: inp.dataset.cat, subkey: inp.dataset.key || null, amount: v });
  });
  api(API + '/api/admin/monthly_costs',{method:'POST',json:{ period: _finCurrentPeriod, items: items }})
    .then(function(d){
      if (d.ok) {
        showToast('Затраты сохранены: ' + d.saved + ' позиций', 'success');
        document.getElementById('_finCostsOverlay').remove();
        renderFinancesTabNew();
      } else {
        showToast(d.error || 'Ошибка', 'error');
      }
    })
    .catch(function(e){ showToast(e.message, 'error') });
}

// Top Resources — uses server-side aggregated cache (auto-refreshes nightly at 03:00)

function renderOpsDocuments(clientId) {
  var body = document.getElementById('clientOpsBody');
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var actDocs = client ? (client.closingDocuments || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var bills = client ? (client.bills || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var fileDocs = client ? client.documents || [] : [];

  var h = '<div style="padding:4px 0">';

  // === SECTION: АКТЫ ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">📃 Закрывающие документы (акты)</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="actPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="createAct(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">➕ Создать акт</button>';
  h += '</div>';
  if (actDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    actDocs.forEach(function(d) {
      var isSigned = d.status === 'signed';
      var statusHtml = isSigned
        ? '<span style="color:var(--success);font-size:11px">✅ Подписан</span>'
        : '<span style="color:var(--danger);font-size:11px">❌ Не подписан</span>';
      var toggleBtn = isSigned
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'unsigned\')">❌</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'signed\')">✅</button>';
      var pdfBtn = (d.tochkaDocumentId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadActPdf(\'' + clientId + '\',\'' + d.id + '\')">📥 PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.open(API+\'/api/admin/clients/'+clientId+'/closing_documents/'+d.id+'/print?token=\'+authToken,\'_blank\')">🖨</button>';
      h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(d.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="\u041f\u0435\u0440\u0435\u0432\u044b\u0441\u0442\u0430\u0432\u0438\u0442\u044c: \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u0438 \u0441\u043e\u0437\u0434\u0430\u0442\u044c \u0437\u0430\u043d\u043e\u0432\u043e \u043f\u043e \u0442\u0435\u043a\u0443\u0449\u0438\u043c \u0434\u0430\u043d\u043d\u044b\u043c" onclick="reissueAct(\'' + clientId + '\',\'' + d.id + '\',\'' + esc(d.period) + '\')">\u21bb</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0430\u043a\u0442" onclick="deleteAct(\'' + clientId + '\',\'' + d.id + '\')">\ud83d\uddd1</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет закрывающих документов</div>';
  }
  h += '</div>';

  // === SECTION: СЧЕТА ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">💳 Счета на оплату</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="billPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Сумма (авто)</label><input class="form-input" type="number" id="billAmount" placeholder="авто" style="width:100px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="createBill(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">➕ Выставить счёт</button>';
  h += '</div>';
  if (bills.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    bills.forEach(function(b) {
      var isPaid = b.status === 'paid';
      var statusHtml = isPaid
        ? '<span style="color:var(--success);font-size:11px">✅ Оплачен</span>'
        : '<span style="color:var(--danger);font-size:11px">⏳ Не оплачен</span>';
      var toggleBtn = isPaid
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'paid\')">✅</button>';
      var pdfBtn = (b.tochkaBillId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadBillPdf(\'' + clientId + '\',\'' + b.id + '\')">📥 PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.open(API+\'/api/admin/clients/'+clientId+'/bills/'+b.id+'/print?token=\'+authToken,\'_blank\')">🖨</button>';
      h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(b.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u0447\u0451\u0442" onclick="deleteBill(\'' + clientId + '\',\'' + b.id + '\')">\ud83d\uddd1</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет выставленных счетов</div>';
  }
  h += '</div>';

  // === SECTION: ФАЙЛЫ ===
  h += '<div>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">📎 Загруженные документы</h4></div>';
  if (fileDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Документ</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Дата</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    fileDocs.forEach(function(d) {
      h += '<tr>';
      h += '<td style="padding:5px 10px;font-size:12px">' + esc(d.name) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + new Date(d.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) + '</td>';
      h += '<td style="padding:5px 10px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" onclick="deleteDocumentModal(\'' + clientId + '\',\'' + d.id + '\')">Удалить</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет загруженных документов</div>';
  }
  h += '<div style="padding:10px 0;margin-top:8px;display:flex;align-items:center;gap:8px">';
  h += '<input type="file" id="docFileModal" style="font-size:11px;flex:1">';
  h += '<button class="btn btn-primary btn-sm" onclick="uploadDocumentModal(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">Загрузить</button>';
  h += '</div></div>';

  h += '</div>';
  body.innerHTML = h;
}

function uploadDocumentModal(clientId) {
  var fileInput = document.getElementById('docFileModal');
  if (!fileInput || !fileInput.files.length) { showToast('Выберите файл', 'error'); return; }
  var file = fileInput.files[0];
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result.split(',')[1];
    api(API + '/api/admin/clients/' + clientId + '/document',{method:'POST',json:{ name: file.name, fileBase64: base64, mimeType: file.type }})
      .then(function(d) {
        if (d.ok) { showToast('Документ загружен', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
        else showToast(d.error || 'Ошибка', 'error');
      }).catch(function(e) { showToast(e.message, 'error'); });
  };
  reader.readAsDataURL(file);
}

function deleteLedgerEntry(clientId, entryIndex) {
  if (!confirm('\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u044D\u0442\u0443 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u044E? \u0411\u0430\u043B\u0430\u043D\u0441 \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u043D.')) return;
  api(API + '/api/admin/clients/' + clientId + '/ledger/' + entryIndex,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u044F \u0443\u0434\u0430\u043B\u0435\u043D\u0430', 'success'); renderOpsHistory(clientId); loadData(); }
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function addPaymentFromModal(clientId) {
  var amount = document.getElementById('opsPayAmount').value;
  var date = document.getElementById('opsPayDate').value;
  var note = document.getElementById('opsPayNote').value;
  if (!amount || !date) return showToast('Заполните сумму и дату', 'error');
  api(API + '/api/admin/clients/' + clientId + '/payment',{method:'POST',json:{ amount: amount, date: date, note: note }})
    .then(function(d) {
      if (d.ok) { showToast('Платёж добавлен', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsHistory(clientId); }, 1500); }
      else showToast(d.error, 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function manualChargeFromModal(clientId) {
  var amount = document.getElementById('opsPayAmount').value;
  var date = document.getElementById('opsPayDate').value;
  var note = document.getElementById('opsPayNote').value;
  if (!amount || !date) return showToast('Заполните сумму и дату', 'error');
  if (!confirm('Списать ' + amount + ' ₽ с баланса клиента?')) return;
  api(API + '/api/admin/clients/' + clientId + '/charge',{method:'POST',json:{ amount: amount, date: date, note: note || 'Ручное списание' }})
    .then(function(d) {
      if (d.ok) { showToast('Списание выполнено', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsHistory(clientId); }, 1500); }
      else showToast(d.error, 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function deleteDocumentModal(clientId, docId) {
  if (!confirm('Удалить документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== CLOSING DOCUMENTS (ACTS) — helper functions ==========
function createAct(clientId) {
  var period = document.getElementById('actPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  api(API + '/api/admin/tochka/create_act',{method:'POST',json:{ clientId: clientId, period: period }})
    .then(function(d) {
      if (d.ok) {
        if (d.tochkaPushed) showToast('Акт создан и отправлен в Точку', 'success');
        else showToast('Акт сохранён локально, но НЕ ушёл в Точку: ' + (d.tochkaStatus || 'причина неизвестна'), 'error', 12000);
        loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500);
      }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function toggleActStatus(clientId, docId, status) {
  api(API + '/api/admin/clients/' + clientId + '/closing_document_status',{method:'POST',json:{ docId: docId, status: status }})
    .then(function(d) {
      if (d.ok) { showToast(status === 'signed' ? 'Отмечен как подписанный' : 'Подпись снята', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function downloadActPdf(clientId, docId) {
  window.open(API + '/api/admin/clients/' + clientId + '/closing_documents/' + docId + '/pdf?token=' + authToken, '_blank');
}

// Re-issue an act when something is wrong: delete the old one, then regenerate it
// for the same period from the current ledger data (and re-push to Tochka). Reuses
// the existing DELETE + create_act routes — no new backend surface.
function reissueAct(clientId, docId, period) {
  if (!confirm('Перевыставить акт за ' + period + '?\nСтарый будет удалён и создан заново по текущим данным.')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || 'Не удалось удалить старый акт');
      return api(API + '/api/admin/tochka/create_act',{method:'POST',json:{ clientId: clientId, period: period }});
    })
    .then(function(d) {
      if (d.ok) {
        if (d.tochkaPushed) showToast('Акт перевыставлен и отправлен в Точку', 'success');
        else showToast('Акт пересоздан локально, но НЕ ушёл в Точку: ' + (d.tochkaStatus || 'причина неизвестна'), 'error', 12000);
        loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); if (typeof renderBankDocuments === 'function') renderBankDocuments(); }, 1500);
      }
      else showToast(d.error || 'Старый удалён, но новый не создался — нажмите «Создать акт»', 'error');
    })
    .catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function deleteAct(clientId, docId) {
  if (!confirm('Удалить закрывающий документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BILLS (СЧЕТА НА ОПЛАТУ) — helper functions ==========
function createBill(clientId) {
  var period = document.getElementById('billPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var amountVal = document.getElementById('billAmount').value;
  var payload = { clientId: clientId, period: period };
  if (amountVal && parseFloat(amountVal) > 0) payload.amount = parseFloat(amountVal);
  api(API + '/api/admin/tochka/create_bill',{method:'POST',json:payload})
    .then(function(d) {
      if (d.ok) { showToast('Счёт выставлен: ' + (d.amount || 0).toLocaleString('ru-RU') + ' \u20BD', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message, 'error'); });
}

function toggleBillStatus(clientId, billId, status) {
  api(API + '/api/admin/clients/' + clientId + '/bill_status',{method:'POST',json:{ billId: billId, status: status }})
    .then(function(d) {
      if (d.ok) { showToast(status === 'paid' ? 'Отмечен как оплаченный' : 'Отмечен как неоплаченный', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function downloadBillPdf(clientId, billId) {
  window.open(API + '/api/admin/clients/' + clientId + '/bills/' + billId + '/pdf?token=' + authToken, '_blank');
}

function deleteBill(clientId, billId) {
  if (!confirm('Удалить счёт?')) return;
  api(API + '/api/admin/clients/' + clientId + '/bill/' + billId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Счёт удалён', 'success'); loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK CONFIG (Tochka) ==========
function renderBankConfig() {
  var container = document.getElementById('bankConfigSection');
  if (!container) return;
  var tc = currentData.tochkaConfig || {};
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  h += '<h3 style="margin:0">\u{1F3E6} \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0422\u043E\u0447\u043A\u0430 \u0411\u0430\u043D\u043A</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">\u2705 API \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">\u274C API \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D</span>';
  }
  h += '</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:10px;margin-bottom:12px">';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;font-weight:600">JWT \u0422\u043E\u043A\u0435\u043D *</label><input class="form-input" id="bankJwt" placeholder="\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 JWT \u0442\u043E\u043A\u0435\u043D" style="font-size:12px" value="' + esc(tc.jwt || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px;font-weight:600">Client ID *</label><input class="form-input" id="bankClientId" placeholder="client_id" style="font-size:12px" value="' + esc(tc.clientId || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Customer Code</label><input class="form-input" id="bankCustomerCode" placeholder="customer_code" style="font-size:12px" value="' + esc(tc.customerCode || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Account ID</label><input class="form-input" id="bankAccountId" placeholder="account_id" style="font-size:12px" value="' + esc(tc.accountId || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Название компании</label><input class="form-input" id="bankCompanyName" placeholder=\'ООО "Компания"\' style="font-size:12px" value="' + esc(tc.companyName || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">ИНН компании</label><input class="form-input" id="bankCompanyInn" placeholder="1234567890" style="font-size:12px" value="' + esc(tc.companyInn || '') + '"></div>';
  h += '<div><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">КПП компании</label><input class="form-input" id="bankCompanyKpp" placeholder="123456789" style="font-size:12px" value="' + esc(tc.companyKpp || '') + '"></div>';
  h += '<div style="grid-column:1/-1"><label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px">Адрес компании</label><input class="form-input" id="bankCompanyAddress" placeholder="119334, г. Москва, ул. ..." style="font-size:12px" value="' + esc(tc.companyAddress || '') + '"></div>';
  h += '</div>';
  // Bank details fields removed from UI (still stored in tochka_config if set)
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
  h += '<button class="btn btn-primary" onclick="saveBankConfig()">\u{1F4BE} \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>';
  if (tochkaOk) {
    h += '<button class="btn" style="background:#f59e0b;color:#fff" onclick="autodetectBank()">\u{1F50D} \u0410\u0432\u0442\u043E\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C</button>';
    h += '<button class="btn btn-success" onclick="registerWebhook()">\u{1F517} \u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C webhook</button>';
    h += '<button class="btn" style="background:#6366f1;color:#fff" onclick="syncPayments()">\u{1F504} \u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043F\u043B\u0430\u0442\u0435\u0436\u0438</button>';
  }
  h += '</div>';
  if (tochkaOk) {
    h += '<div style="margin-top:12px;padding:10px;background:var(--bg-3);border-radius:8px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">';
    h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">\u0421 \u0434\u0430\u0442\u044B</label><input class="form-input" type="date" id="syncDateFrom" value="2024-01-01" style="font-size:12px;padding:4px 8px"></div>';
    h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">\u041F\u043E \u0434\u0430\u0442\u0443</label><input class="form-input" type="date" id="syncDateTo" value="' + new Date().toISOString().slice(0, 10) + '" style="font-size:12px;padding:4px 8px"></div>';
    h += '<div id="syncStatus" style="font-size:12px;color:var(--text-3)"></div>';
    h += '</div>';
  }
  h += '</div>';
  container.innerHTML = h;
  // Load full config (with unmasked jwt) for editing
  api(API + '/api/admin/tochka/config')
    .then(function(cfg) {
      if (cfg.jwt) document.getElementById('bankJwt').value = cfg.jwt;
      if (cfg.clientId) document.getElementById('bankClientId').value = cfg.clientId;
      if (cfg.customerCode) document.getElementById('bankCustomerCode').value = cfg.customerCode;
      if (cfg.accountId) document.getElementById('bankAccountId').value = cfg.accountId;
      if (cfg.companyName) document.getElementById('bankCompanyName').value = cfg.companyName;
      if (cfg.companyInn) document.getElementById('bankCompanyInn').value = cfg.companyInn;
    }).catch(function() {});
}

function saveBankConfig() {
  var _jwt = (document.getElementById('bankJwt') || {}).value || '';
  var data = {
    clientId: document.getElementById('bankClientId').value,
    customerCode: document.getElementById('bankCustomerCode').value,
    accountId: document.getElementById('bankAccountId').value,
    companyName: document.getElementById('bankCompanyName').value,
    companyInn: document.getElementById('bankCompanyInn').value,
    companyKpp: document.getElementById('bankCompanyKpp').value,
    companyAddress: document.getElementById('bankCompanyAddress').value
    // bank details inputs removed from UI; omit them so the backend keeps stored values
  };
  // jwt шлём только если введён новый (не пустой и не маска «****…» из GET) — иначе бэкенд хранит старый
  if (_jwt && _jwt.indexOf('****') !== 0) data.jwt = _jwt;
  api(API + '/api/admin/tochka/config',{method:'POST',json:data})
    .then(function(d) {
      if (d.ok) { showToast('\u041A\u043E\u043D\u0444\u0438\u0433 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u0435\u0440\u0432\u0435\u0440 \u0434\u043B\u044F \u043F\u0440\u0438\u043C\u0435\u043D\u0435\u043D\u0438\u044F', 'success'); loadData(); }
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function autodetectBank() {
  showToast('\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0434\u0430\u043D\u043D\u044B\u0435 \u0438\u0437 \u0422\u043E\u0447\u043A\u0438...', 'info');
  api(API + '/api/admin/tochka/autodetect',{method:'POST'})
    .then(function(d) {
      if (d.ok && d.detected) {
        var det = d.detected;
        var msg = '\u041D\u0430\u0439\u0434\u0435\u043D\u043E:';
        if (det.customerCode) { document.getElementById('bankCustomerCode').value = det.customerCode; msg += ' CustomerCode=' + det.customerCode; }
        if (det.accountId) { document.getElementById('bankAccountId').value = det.accountId; msg += ' AccountID=' + det.accountId; }
        if (det.companyName) { document.getElementById('bankCompanyName').value = det.companyName; msg += ' ' + det.companyName; }
        if (det.companyInn) { document.getElementById('bankCompanyInn').value = det.companyInn; }
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { renderBankConfig(); }, 500);
      } else {
        showToast(d.error || '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C', 'error');
      }
    })
    .catch(function(e) { showToast(e.message, 'error'); });
}

function registerWebhook() {
  var url = window.location.origin + '/api/tochka/webhook';
  if (!confirm('\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C webhook?\n\nURL: ' + url)) return;
  api(API + '/api/admin/tochka/register_webhook',{method:'POST',json:{ webhookUrl: url }})
    .then(function(d) {
      if (d.ok) showToast('Webhook \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D!', 'success');
      else showToast(d.error || '\u041E\u0448\u0438\u0431\u043A\u0430', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function syncPayments() {
  var dateFrom = document.getElementById('syncDateFrom') ? document.getElementById('syncDateFrom').value : '2024-01-01';
  var dateTo = document.getElementById('syncDateTo') ? document.getElementById('syncDateTo').value : new Date().toISOString().slice(0, 10);
  var statusEl = document.getElementById('syncStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">\u23F3 \u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0432\u044B\u043F\u0438\u0441\u043A\u0443... (\u0434\u043E 30 \u0441\u0435\u043A)</span>';
  api(API + '/api/admin/tochka/sync',{method:'POST',json:{ dateFrom: dateFrom, dateTo: dateTo }})
    .then(function(d) {
      if (d.ok) {
        var msg = '\u2705 \u0413\u043E\u0442\u043E\u0432\u043E! \u0412\u0441\u0435\u0433\u043E: ' + d.total + ', \u0438\u043C\u043F\u043E\u0440\u0442: ' + d.imported + ', \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043E: ' + d.matched + ', \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E: ' + d.skipped;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
      } else {
        var errMsg = d.error || '\u041E\u0448\u0438\u0431\u043A\u0430';
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + errMsg + '</span>';
        showToast(errMsg, 'error');
      }
    })
    .catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

// ========== BANK DOCUMENTS (Closing Documents / Акты) ==========
function renderBankDocuments() {
  var container = document.getElementById('bankDocumentsSection');
  if (!container) return;
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">📃 Документооборот</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="document.getElementById(\'bulkActPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkActPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="generateBulkActs()" style="white-space:nowrap;padding:4px 12px">📃 Сгенерировать акты для всех клиентов</button>';
  h += '<div id="bulkActStatus" style="font-size:12px;color:var(--text-3)"></div>';
  h += '</div>';

  // Load and display all acts
  h += '<div id="allActsList"><div style="color:var(--text-3);font-size:12px;text-align:center;padding:10px">Загрузка...</div></div>';
  h += '</div>';
  container.innerHTML = h;
  loadAllActs();
}

function loadAllActs() {
  api(API + '/api/admin/tochka/all_acts')
    .then(function(data) {
      var docs = data.documents || [];
      var el = document.getElementById('allActsList');
      if (!el) return;
      if (!docs.length) {
        el.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:20px;text-align:center">Закрывающих документов пока нет. Выберите период и нажмите «Сгенерировать акты».</div>';
        return;
      }
      // Group by period
      var periods = {};
      docs.forEach(function(d) {
        var p = d.period || 'unknown';
        if (!periods[p]) periods[p] = [];
        periods[p].push(d);
      });
      var sortedPeriods = Object.keys(periods).sort(function(a, b) { return b.localeCompare(a); });
      var months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      var h = '';
      sortedPeriods.forEach(function(period, pi) {
        var pdocs = periods[period];
        var totalSum = pdocs.reduce(function(s, d) { return s + (d.totalAmount || 0); }, 0);
        var unsigned = pdocs.filter(function(d) { return d.status !== 'signed'; }).length;
        var signed = pdocs.length - unsigned;
        var parts = period.split('-');
        var monthLabel = months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
        var isOpen = pi === 0;
        h += '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">';
        h += '<div onclick="toggleActPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
        h += '<div style="display:flex;align-items:center;gap:10px">';
        h += '<span style="font-size:14px;transition:transform .2s;transform:rotate(' + (isOpen ? '90' : '0') + 'deg)">▶</span>';
        h += '<span style="font-weight:600;font-size:14px">' + esc(monthLabel) + '</span>';
        h += '<span style="font-size:11px;color:var(--text-3)">' + pdocs.length + ' акт' + (pdocs.length > 1 ? (pdocs.length < 5 ? 'а' : 'ов') : '') + '</span>';
        h += '</div>';
        h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
        h += '<span style="font-weight:600;font-size:13px">' + totalSum.toLocaleString('ru-RU') + ' ₽</span>';
        if (unsigned > 0) h += '<span style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + unsigned + ' не подписан</span>';
        if (signed > 0) h += '<span style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + signed + ' подписан</span>';
        h += '</div></div>';
        h += '<div style="display:' + (isOpen ? 'block' : 'none') + ';padding:0;overflow-x:auto;-webkit-overflow-scrolling:touch">';
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-2)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Клиент</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">ИНН</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
        pdocs.forEach(function(d) {
          var isSigned = d.status === 'signed';
          var statusHtml = isSigned
            ? '<span style="color:var(--success);font-weight:600">✅ Подписан</span>'
            : '<span style="color:var(--danger);font-weight:600">❌ Не подписан</span>';
          var toggleBtn = isSigned
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'unsigned\')">❌</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'signed\')">✅</button>';
          var pdfBtn = d.tochkaDocumentId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadActPdf(\'' + d.clientId + '\',\'' + d.id + '\')">📥</button>'
            : '';
          h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(d.clientName || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' ₽</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Перевыставить: удалить и создать заново" onclick="reissueAct(\'' + d.clientId + '\',\'' + d.id + '\',\'' + esc(d.period || '') + '\')">↻</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить акт" onclick="deleteActFromBank(\'' + d.clientId + '\',\'' + d.id + '\')">🗑</button></td>';
          h += '</tr>';
        });
        h += '</tbody></table></div></div>';
      });
      el.innerHTML = h;
    }).catch(function(e) {
      var el = document.getElementById('allActsList');
      if (el) el.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:10px">' + esc(e.message) + '</div>';
    });
}

function toggleActPeriod(header) {
  var content = header.nextElementSibling;
  var arrow = header.querySelector('span');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    content.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

function generateBulkActs() {
  var period = document.getElementById('bulkActPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var statusEl = document.getElementById('bulkActStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">⏳ Генерирую акты...</span>';
  api(API + '/api/admin/tochka/generate_acts',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = '✅ Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllActs(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">❌ ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

function deleteActFromBank(clientId, docId) {
  if (!confirm('Удалить закрывающий документ?')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Удалён', 'success'); loadData(); setTimeout(function() { loadAllActs(); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK BILLS (Счета на оплату) ==========
function renderBankBills() {
  var container = document.getElementById('bankBillsSection');
  if (!container) return;
  var tochkaOk = currentData.tochkaConfigured;
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">💳 Счета на оплату</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="document.getElementById(\'bulkBillPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkBillPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" onclick="generateBulkBills()" style="white-space:nowrap;padding:4px 12px">💳 Выставить счета всем клиентам</button>';
  h += '<div id="bulkBillStatus" style="font-size:12px;color:var(--text-3)"></div>';
  h += '</div>';

  // Load and display all bills
  h += '<div id="allBillsList"><div style="color:var(--text-3);font-size:12px;text-align:center;padding:10px">Загрузка...</div></div>';
  h += '</div>';
  container.innerHTML = h;
  loadAllBills();
}

function loadAllBills() {
  api(API + '/api/admin/tochka/all_bills')
    .then(function(data) {
      var bills = data.bills || [];
      var el = document.getElementById('allBillsList');
      if (!el) return;
      if (!bills.length) {
        el.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:20px;text-align:center">Счетов пока нет. Выберите период и нажмите «Выставить счета всем клиентам».</div>';
        return;
      }
      // Group by period
      var periods = {};
      bills.forEach(function(b) {
        var p = b.period || 'unknown';
        if (!periods[p]) periods[p] = [];
        periods[p].push(b);
      });
      var sortedPeriods = Object.keys(periods).sort(function(a, b) { return b.localeCompare(a); });
      var months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      var h = '';
      sortedPeriods.forEach(function(period, pi) {
        var pbills = periods[period];
        var totalSum = pbills.reduce(function(s, b) { return s + (b.amount || 0); }, 0);
        var unpaid = pbills.filter(function(b) { return b.status !== 'paid'; }).length;
        var paid = pbills.length - unpaid;
        var parts = period.split('-');
        var monthLabel = months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
        var isOpen = pi === 0;
        h += '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">';
        h += '<div onclick="toggleBillPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
        h += '<div style="display:flex;align-items:center;gap:10px">';
        h += '<span style="font-size:14px;transition:transform .2s;transform:rotate(' + (isOpen ? '90' : '0') + 'deg)">▶</span>';
        h += '<span style="font-weight:600;font-size:14px">' + esc(monthLabel) + '</span>';
        h += '<span style="font-size:11px;color:var(--text-3)">' + pbills.length + ' счёт' + (pbills.length > 1 ? (pbills.length < 5 ? 'а' : 'ов') : '') + '</span>';
        h += '</div>';
        h += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
        h += '<span style="font-weight:600;font-size:13px">' + totalSum.toLocaleString('ru-RU') + ' \u20BD</span>';
        if (unpaid > 0) h += '<span style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + unpaid + ' не оплачен</span>';
        if (paid > 0) h += '<span style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:10px">' + paid + ' оплачен</span>';
        h += '</div></div>';
        h += '<div style="display:' + (isOpen ? 'block' : 'none') + ';padding:0;overflow-x:auto;-webkit-overflow-scrolling:touch">';
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-2)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Клиент</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">ИНН</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
        pbills.forEach(function(b) {
          var isPaid = b.status === 'paid';
          var statusHtml = isPaid
            ? '<span style="color:var(--success);font-weight:600">✅ Оплачен</span>'
            : '<span style="color:var(--danger);font-weight:600">⏳ Не оплачен</span>';
          var toggleBtn = isPaid
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" onclick="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'paid\')">✅</button>';
          var pdfBtn = b.tochkaBillId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="downloadBillPdf(\'' + b.clientId + '\',\'' + b.id + '\')">📥</button>'
            : '';
          h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(b.clientName || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap">' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить счёт" onclick="deleteBillFromBank(\'' + b.clientId + '\',\'' + b.id + '\')">🗑</button></td>';
          h += '</tr>';
        });
        h += '</tbody></table></div></div>';
      });
      el.innerHTML = h;
    }).catch(function(e) {
      var el = document.getElementById('allBillsList');
      if (el) el.innerHTML = '<div style="color:var(--danger);font-size:12px;padding:10px">' + esc(e.message) + '</div>';
    });
}

function toggleBillPeriod(header) {
  var content = header.nextElementSibling;
  var arrow = header.querySelector('span');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    content.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

function generateBulkBills() {
  var period = document.getElementById('bulkBillPeriod').value;
  if (!period) return showToast('Выберите период', 'error');
  var statusEl = document.getElementById('bulkBillStatus');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">⏳ Генерирую счета...</span>';
  api(API + '/api/admin/tochka/generate_bills',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = '✅ Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllBills(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">❌ ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">\u274C ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

function deleteBillFromBank(clientId, billId) {
  if (!confirm('Удалить счёт?')) return;
  api(API + '/api/admin/clients/' + clientId + '/bill/' + billId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast('Счёт удалён', 'success'); loadData(); setTimeout(function() { loadAllBills(); }, 1500); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== BANK PAYMENTS (Tochka) ==========
var _paymentsSearch='';
function filterPayments(){_paymentsSearch=(document.getElementById('paymentsSearchInput')||{}).value||'';renderBankPayments();}
function renderBankPayments() {
  var container = document.getElementById('bankPaymentsSection');
  if (!container) return;
  var bp = currentData.bankPayments || [];
  var tochkaOk = currentData.tochkaConfigured;
  var searchVal=_paymentsSearch.toLowerCase();
  var h = '<div class="detail-card">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<h3 style="margin:0">\u{1F3E6} Банк Точка</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API подключён</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API не настроен</span>';
  }
  h += '</div>';
  // Search toolbar
  h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:8px 10px;background:var(--bg-3);border-radius:8px">';
  h += '<input id="paymentsSearchInput" class="form-input" placeholder="Поиск по плательщику, ИНН, назначению..." oninput="filterPayments()" value="'+esc(searchVal)+'" style="flex:1;font-size:12px;padding:5px 10px">';
  var unmatchedCount=bp.filter(function(p){return!p.matched&&!p.dismissed&&p.webhookType==='incomingPayment'}).length;
  if(unmatchedCount>0)h+='<span style="font-size:11px;color:var(--danger);font-weight:600;white-space:nowrap">⚠ Неопознанных: '+unmatchedCount+'</span>';
  h += '</div>';
  var unmatched = bp.filter(function(p) { return !p.matched && !p.dismissed && p.webhookType === 'incomingPayment'; }).sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
  if(searchVal){unmatched=unmatched.filter(function(p){return(p.payerName||'').toLowerCase().indexOf(searchVal)!==-1||(p.payerInn||'').toLowerCase().indexOf(searchVal)!==-1||(p.purpose||'').toLowerCase().indexOf(searchVal)!==-1;})}
  if (unmatched.length > 0) {
    h += '<div style="background:rgba(220,38,38,0.1);border:1px solid var(--danger);border-radius:8px;padding:10px;margin-bottom:12px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    h += '<span style="font-weight:600;color:var(--danger)">\u26A0\uFE0F \u041D\u0435\u043E\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u044B\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438: ' + unmatched.length + '</span>';
    h += '<button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:var(--bg-3)" onclick="dismissAllUnmatched()">\u2716 \u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435</button>';
    h += '</div>';
    h += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">';
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr><th style="padding:4px 6px;text-align:left">\u0414\u0430\u0442\u0430</th><th style="padding:4px 6px;text-align:left">\u041F\u043B\u0430\u0442\u0435\u043B\u044C\u0449\u0438\u043A</th><th style="padding:4px 6px;text-align:left">\u0418\u041D\u041D</th><th style="padding:4px 6px;text-align:center">\u0421\u0443\u043C\u043C\u0430</th><th style="padding:4px 6px;text-align:left">\u041D\u0430\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435</th><th style="padding:4px 6px">\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F</th></tr></thead><tbody>';
    unmatched.forEach(function(p) {
      h += '<tr>';
      h += '<td style="padding:4px 6px">' + fmtDateRu(p.date) + '</td>';
      h += '<td style="padding:4px 6px" title="' + esc(p.payerName || '') + '">' + esc(p.payerName || '') + '</td>';
      h += '<td style="padding:4px 6px">' + esc(p.payerInn) + '</td>';
      h += '<td style="padding:4px 6px;text-align:center;font-weight:600;white-space:nowrap">' + p.amount + ' \u20BD</td>';
      h += '<td style="padding:4px 6px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.purpose) + '">' + esc(p.purpose || '') + '</td>';
      h += '<td style="padding:4px 6px;white-space:nowrap"><select id="matchClient_' + p.id + '" style="font-size:10px;padding:2px;max-width:100px">';
      h += '<option value="">---</option>';
      (currentData.clients || []).forEach(function(c) { h += '<option value="' + c.id + '">' + esc(c.name) + '</option>'; });
      h += '</select> <button class="btn btn-sm btn-primary" style="font-size:9px;padding:1px 6px" onclick="matchPayment(\'' + p.id + '\')">OK</button>';
      h += ' <button class="btn btn-sm" style="font-size:9px;padding:1px 4px;background:var(--bg-3)" onclick="dismissPayment(\'' + p.id + '\')" title="\u0423\u0431\u0440\u0430\u0442\u044C">\u2716</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }
  var matched = bp.filter(function(p) { return p.matched && p.webhookType === 'incomingPayment'; }).sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
  if(searchVal){matched=matched.filter(function(p){return(p.payerName||'').toLowerCase().indexOf(searchVal)!==-1||(p.payerInn||'').toLowerCase().indexOf(searchVal)!==-1||(p.purpose||'').toLowerCase().indexOf(searchVal)!==-1||(p.matchedClientName||'').toLowerCase().indexOf(searchVal)!==-1;});}
  matched=matched.slice(0,50);
  if (matched.length > 0) {
    h += '<div style="font-size:12px;font-weight:600;margin-bottom:6px">\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:var(--bg-3)"><th style="padding:4px 6px;text-align:left">\u0414\u0430\u0442\u0430</th><th style="padding:4px 6px;text-align:left">\u041F\u043B\u0430\u0442\u0435\u043B\u044C\u0449\u0438\u043A</th><th style="padding:4px 6px;text-align:center">\u0421\u0443\u043C\u043C\u0430</th><th style="padding:4px 6px;text-align:left">\u041A\u043B\u0438\u0435\u043D\u0442</th></tr></thead><tbody>';
    matched.forEach(function(p) {
      var isUnmatched=!p.client_id&&!p.matchedClientName;
      h += '<tr style="'+(isUnmatched?'background:rgba(220,38,38,0.06)':'')+'">';
      h += '<td style="padding:4px 6px">' + fmtDateRu(p.date) + '</td>';
      h += '<td style="padding:4px 6px" title="' + esc(p.payerName || '') + '">' + esc(p.payerName || '') + '</td>';
      h += '<td style="padding:4px 6px;text-align:center;font-weight:500'+(isUnmatched?';color:var(--danger)':'')+'">' + p.amount + ' \u20BD</td>';
      h += '<td style="padding:4px 6px;color:var(--success);font-weight:500">'+(isUnmatched?'<span style="color:var(--danger)">⚠ Не привязан</span>':'\u2705 ' + esc(p.matchedClientName || ''))+'</td>';
      h += '</tr>';
    });
    h += '</tbody></table>' + '</div>';
  } else if (tochkaOk) {
    h += '<div style="color:var(--text-3);font-size:12px;padding:20px;text-align:center">\u041F\u043B\u0430\u0442\u0435\u0436\u0435\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</div>';
  }
  h += '</div>';
  container.innerHTML = h;
}

function matchPayment(paymentId) {
  var sel = document.getElementById('matchClient_' + paymentId);
  if (!sel || !sel.value) return showToast('Выберите клиента', 'error');
  api(API + '/api/admin/tochka/match_payment',{method:'POST',json:{ paymentId: paymentId, clientId: sel.value }})
    .then(function(d) {
      if (d.ok) { showToast('Платёж привязан', 'success'); loadData(); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function dismissPayment(paymentId) {
  api(API + '/api/admin/tochka/dismiss_payment',{method:'POST',json:{ paymentId: paymentId }})
    .then(function(d) { if (d.ok) { loadData(); } }).catch(function(){});
}

function dismissAllUnmatched() {
  if (!confirm('\u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435 \u043D\u0435\u043E\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u044B\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438?')) return;
  api(API + '/api/admin/tochka/dismiss_unmatched',{method:'POST'})
    .then(function(d) { if (d.ok) { showToast('\u0423\u0431\u0440\u0430\u043D\u043E: ' + d.dismissed, 'success'); loadData(); } }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// ========== EDIT PORT CREDENTIALS ==========

function renderMrrChart(d){
  d = d || window._newFinData; if(!d) return;
  var lg = document.getElementById('mrrLegend');
  if(lg) lg.innerHTML = [['За ГБ','#2f6fe0'],['За модем','#10b981']].map(function(x){
    return '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[1]+'"></span>'+x[0]+'</span>';
  }).join('');
  var cv = document.getElementById('newFinTrendCanvas');
  if(!cv || !window.Chart) return;
  if(window._newFinTrendChart){ try{window._newFinTrendChart.destroy();}catch(_){} window._newFinTrendChart=null; }
  var cc = getChartColorsLight();
  // Тонкие столбцы под узкую карточку ряда «Требует внимания» (маленький maxBarThickness),
  // остальная геометрия — из общего CHART_BAR_STACK. Скругление: плоский низ, круглый верх.
  var barOpts = Object.assign({stack:'a', borderRadius:chartStackRadius()}, CHART_BAR_STACK, {maxBarThickness:22});
  window._newFinTrendChart = newChartSafe(cv, {
    type:'bar',
    data:{ labels:(d.trend||[]).map(function(t){return _ymRu(t.month,true);}),
      datasets:[
        Object.assign({label:'За ГБ', data:(d.trend||[]).map(function(t){return t.per_gb||0;}), backgroundColor:'#2f6fe0'}, barOpts),
        Object.assign({label:'За модем', data:(d.trend||[]).map(function(t){return t.per_modem||0;}), backgroundColor:'#10b981'}, barOpts)
      ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{mode:'index',intersect:false,
          callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
            footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
      scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,minRotation:0,autoSkip:false},grid:{display:false},border:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
  });
}
// «Выручка по дням» + «Последние платежи» — в блоке Финансов на месте бывшего MRR.
function renderFinRevenue(d){
  var el = document.getElementById('newFinRevenue'); if(!el) return;
  var h = '<h3 style="margin:0 0 8px;font-size:14px;font-weight:700;color:var(--text-0)">Выручка по дням <span style="font-size:10px;font-weight:400;color:var(--text-3)">30 дней · по клиентам · ₽</span></h3>';
  h += '<div style="height:118px;position:relative"><canvas id="newFinRevCanvas"></canvas></div>';
  h += '<div style="height:0.5px;background:var(--border);margin:11px 0 9px"></div>';
  h += '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px"><span style="font-size:13px;font-weight:700;color:var(--text-0)">Последние пополнения</span><span style="font-size:11px;color:var(--accent);cursor:pointer" onclick="var b=document.querySelector(&quot;.nav-tab[onclick*=bank]&quot;);if(b)b.click()">все →</span></div>';
  // Только ПОПОЛНЕНИЯ (положительные), последние 3.
  var rp = (d.recent_payments || []).filter(function(p){return p.amount >= 0;}).slice(0, 3);
  if(!rp.length) h += '<div style="color:var(--text-3);font-size:12px">Пополнений пока нет.</div>';
  else rp.forEach(function(p){
    var sub = esc((p.date||'').slice(5)) + ' · ' + esc(p.source||'');
    h += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0"><div style="min-width:0"><div style="font-size:12px;color:var(--text-1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(p.client)+'</div><div style="font-size:10px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+sub+'</div></div>'
      + '<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;white-space:nowrap;color:var(--success)">+'+Math.abs(Math.round(p.amount)).toLocaleString('ru-RU')+'</span></div>';
  });
  el.innerHTML = h;
  setTimeout(function(){
    var cv = document.getElementById('newFinRevCanvas'); if(!cv || !window.Chart) return;
    if(window._newFinRevChart){ try{window._newFinRevChart.destroy();}catch(_){} }
    var cc = getChartColorsLight();
    var dr = d.daily_revenue || []; var dates = dr.map(function(r){return r.date;});
    var byClient = d.daily_revenue_by_client || {};
    // топ-клиенты по суммарной выручке за окно, остальные — «Прочие»
    var names = Object.keys(byClient).sort(function(a,b){
      var sa=dates.reduce(function(s,dt){return s+(byClient[a][dt]||0);},0), sb=dates.reduce(function(s,dt){return s+(byClient[b][dt]||0);},0);
      return sb-sa;
    });
    var MAXG=6, top=names.slice(0,MAXG), rest=names.slice(MAXG);
    var palette=getChartPaletteLight();
    var datasets=top.map(function(nm,i){ return Object.assign({label:nm, data:dates.map(function(dt){return (byClient[nm][dt]||0);}), backgroundColor:palette[i%palette.length], stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK); });
    if(rest.length) datasets.push(Object.assign({label:'Прочие', data:dates.map(function(dt){return rest.reduce(function(s,nm){return s+(byClient[nm][dt]||0);},0);}), backgroundColor:'#cbd5e1', stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK));
    // fallback: если разбивки нет — единый ряд из daily_revenue
    if(!datasets.length) datasets=[Object.assign({label:'Выручка', data:dr.map(function(r){return r.revenue;}), backgroundColor:'#2f6fe0', stack:'r', borderRadius:chartStackRadius()}, CHART_BAR_STACK)];
    window._newFinRevChart = newChartSafe(cv, {
      type:'bar',
      data:{ labels:dates.map(function(dt){return (dt||'').slice(5);}), datasets:datasets },
      options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},
          tooltip:{mode:'index',intersect:false,itemSort:function(a,b){return b.parsed.y-a.parsed.y;},
            callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
              footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
        scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:10},grid:{display:false},border:{display:false}},
          y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
    });
  }, 30);
}
