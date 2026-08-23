// public/js/admin/finance.js — finance tabs (WP6.3 carve-out from admin.js,
// VERBATIM): Финансы tab (dashboard, costs), ops documents/acts/bills,
// bank config/documents/bills/payments, revenue charts.

function shortCurrency(val){return Math.round(val).toLocaleString('ru-RU')+' ₽'}
// Entry point kept for delegated-helpers finSetPeriod; delegates to
// renderFinancesTabNew (calls /api/admin/finance_dashboard). The old
// per-client traffic table was removed with #tab-traffic (C4).
function renderFinancesTab(d){
  return renderFinancesTabNew();
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
  h += '<button class="fx-btn" data-on-click="generateBulkActs()">' + icon('doc', 13) + ' Сформировать акты</button>';
  h += '<button class="fx-btn" data-on-click="openFinanceCostsModal()">' + icon('gear', 13) + ' Затраты</button>';
  h += '<select id="finPeriodSelect" class="fx-sel" data-on-change="_finCurrentPeriod=this.value;renderFinancesTabNew()">';
  periods.forEach(function(p) { h += '<option value="' + p + '"' + (p === d.period ? ' selected' : '') + '>' + p + '</option>'; });
  h += '</select></div></div>';

  h += '<div class="fx-kpis">';
  h += '<div class="fx-kpi"><div class="fx-kl">Выручка (факт)</div><div class="fx-kv">' + money(revenue) + '</div><div class="fx-ks">' + growthSub + '</div></div>';
  var costSub = cost > 0
    ? (s.cost_carried_from ? '<span style="color:var(--am)">типовые из ' + esc(s.cost_carried_from) + '</span> · ' + costPct + '%' : (costPct + '% от выручки'))
    : '<span style="color:var(--am)">не введены</span>';
  h += '<div class="fx-kpi a"><div class="fx-kl">Затраты</div><div class="fx-kv">' + (cost > 0 ? money(cost) : '—') + '</div><div class="fx-ks">' + costSub + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Прибыль</div><div class="fx-kv" style="color:var(--gr)">' + money(profit) + '</div><div class="fx-ks">' + (isCur ? 'run-rate ' + shortCurrency(profitForecast) + ' (ожидание)' : 'за месяц') + '</div></div>';
  h += '<div class="fx-kpi g"><div class="fx-kl">Маржа</div><div class="fx-kv" style="color:var(--gr)">' + (marginPct == null ? '—' : marginPct + '%') + '</div><div class="fx-ks">' + (s.margin_per_modem != null ? Math.round(s.margin_per_modem).toLocaleString('ru-RU') + ' ₽/модем' : '') + '</div></div>';
  h += '</div>';

  h += '<div class="fx-wgs">';
  h += '<div class="fx-wg"><div class="fx-wl">Активных клиентов</div><div class="fx-wv">' + (s.active_clients || 0) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">NRR</div><div class="fx-wv"' + (s.nrr_pct >= 100 ? ' style="color:var(--gr)"' : '') + '>' + (s.nrr_pct == null ? '—' : s.nrr_pct + '%') + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">На балансах</div><div class="fx-wv">' + shortCurrency(posBal) + '</div></div>';
  h += '<div class="fx-wg"><div class="fx-wl">ARPU</div><div class="fx-wv">' + money(s.arpu) + '</div></div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Выручка за 30 дней</span></div>';
  h += '<div style="height:130px"><canvas id="fxDailyChart"></canvas></div></div>';

  h += '<div class="fx-row2">';
  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Затраты по категориям</span><span class="fx-lk" data-on-click="openFinanceCostsModal()">' + icon('edit', 11) + ' править</span></div>';
  var catLabels = { server: 'Аренда серверов', sim: 'SIM-карты', electricity: 'Электричество', hosting: 'Хостинг', salary: 'Зарплата', other: 'Прочее' };
  var anyCost = false;
  Object.keys(catLabels).forEach(function(k) {
    var v = costByCat[k] || 0;
    if (v > 0) { anyCost = true; h += '<div class="fx-lr"><span class="fx-nm">' + catLabels[k] + '</span><span class="fx-vv">' + Math.round(v).toLocaleString('ru-RU') + '</span></div>'; }
  });
  if (anyCost) {
    if (s.cost_carried_from) h += '<div style="font-size:10px;color:var(--am);margin:2px 0 4px">' + icon('alert', 10) + ' Типовые значения из ' + esc(s.cost_carried_from) + ' — подтвердите через «править»</div>';
    h += '<div class="fx-tot"><span>Итого</span><span class="fx-vv" style="color:var(--am)">' + money(cost) + '</span></div>';
  }
  else h += '<div class="fx-empty">Затраты за ' + esc(d.period) + ' не введены — нажмите «править».</div>';
  h += '</div>';

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Последние платежи</span><span class="fx-lk" data-on-click="switchBankNav(\'payments\')">все →</span></div>';
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

  h += '<div class="fx-card"><div class="fx-ch"><span class="fx-ct">Доходность по клиентам</span><span class="fx-cs">по выручке за 30 дн (факт)</span></div>';
  h += '<div style="overflow-x:auto"><table class="fx-tbl"><thead><tr><th>Клиент</th><th>Тариф</th><th>Выручка 30д</th><th>Δ M/M</th><th>% выручки</th><th>Баланс</th></tr></thead><tbody>';
  var rows = (d.per_client || []).filter(function(p) { return !(p.mrr === 0 && p.mrr_prev === 0 && !p.balance); });
  rows.forEach(function(p, i) {
    var col = CHART_COLORS.clients[i % CHART_COLORS.clients.length];
    var pausedTag = p.paused ? pauseBadge() : '';
    var _cl = (typeof currentData !== 'undefined' && currentData.clients || []).find(function(c) { return c.name === p.name; });
    var blkTag = blockBadge(_cl);
    var dc = p.mrr_delta_pct == null ? 'var(--t3)' : p.mrr_delta_pct >= 0 ? 'var(--gr)' : 'var(--rd)';
    var ds = p.mrr_delta_pct == null ? '—' : (p.mrr_delta_pct >= 0 ? '+' : '') + p.mrr_delta_pct + '%';
    var pill = p.billingType === 'per_modem' ? '<span class="fx-pill pm">per_modem</span>' : '<span class="fx-pill pg">per_gb</span>';
    var balCol = p.balance < 0 ? 'var(--rd)' : 'var(--t1)';
    h += '<tr><td><span class="fx-cn"><span class="fx-dot" style="background:' + col + '"></span>' + esc(p.name) + blkTag + pausedTag + '</span></td>'
      + '<td>' + pill + '</td><td>' + money(p.mrr) + '</td>'
      + '<td style="color:' + dc + '">' + ds + '</td><td>' + (p.share_pct || 0) + '%</td>'
      + '<td style="color:' + balCol + '">' + money(p.balance) + '</td></tr>';
  });
  h += '</tbody></table></div></div>';

  // WP1: сверка трафика (наш daily_traffic vs pmacct боксов) — контейнер,
  // данные подтягиваются отдельным запросом после отрисовки дашборда.

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
// v2.10.8: валюта затрат. Дефолт — из сохранённой строки, иначе по стране
// (MD → MDL, RO → RON), иначе RUB.
function _costCurDefault(existing, country) {
  if (existing && existing.currency) return existing.currency;
  if (country === 'MD') return 'MDL';
  if (country === 'RO') return 'RON';
  return 'RUB';
}
function _costCurSelect(cur) {
  return '<select class="form-input" data-role="currency" style="width:66px;padding:3px 4px;font-size:11px">'
    + ['RUB','MDL','RON'].map(function(c){ return '<option value="'+c+'"'+(c===cur?' selected':'')+'>'+c+'</option>'; }).join('')
    + '</select>';
}
function _fmtFxRate(v){ return v == null ? '—' : Number(v).toFixed(2); }
// Пересчёт ручных строк и автоматических SIM-пакетов в один рублёвый итог.
// Ручной курс в шапке (если задан) перебивает курс ЦБ.
function _finCostsRecalc(ov) {
  var rates = (ov && ov._fxRates) || {};
  var mdlOvEl = document.getElementById('fxMdlOv'), ronOvEl = document.getElementById('fxRonOv');
  var mdlOv = mdlOvEl ? parseFloat(mdlOvEl.value) : NaN;
  var ronOv = ronOvEl ? parseFloat(ronOvEl.value) : NaN;
  var rate = {
    MDL: (isFinite(mdlOv) && mdlOv > 0) ? mdlOv : rates.MDL,
    RON: (isFinite(ronOv) && ronOv > 0) ? ronOv : rates.RON
  };
  var manualRub=0,simRub=0;
  ov.querySelectorAll('.set-row[data-cat]').forEach(function(row){
    var curEl = row.querySelector('[data-role="currency"]');
    var cur = curEl ? curEl.value : 'RUB';
    var unitEl = row.querySelector('[data-role="cur-unit"]');
    if (unitEl) unitEl.textContent = cur === 'RUB' ? '₽' : cur;
    var amount = parseFloat((row.querySelector('[data-role="amount"]') || {}).value) || 0;
    var rub=cur==='RUB'?amount:(amount*(rate[cur]||0));manualRub+=rub;
    var eqEl = row.querySelector('[data-role="rub-eq"]');
    if (eqEl) {
      var r = rate[cur];
      eqEl.textContent = (cur !== 'RUB' && amount > 0 && r)
        ? '≈ ' + (Math.round(amount * r * 100) / 100).toLocaleString('ru-RU') + ' ₽'
        : '';
    }
  });
  ov.querySelectorAll('[data-auto-amount]').forEach(function(row){
    var amount=parseFloat(row.dataset.autoAmount)||0,cur=row.dataset.autoCurrency||'RUB';
    simRub+=cur==='RUB'?amount:(amount*(rate[cur]||0));
    var eq=row.querySelector('[data-role="auto-rub"]');
    if(eq)eq.textContent=amount>0&&cur!=='RUB'&&rate[cur]?'≈ '+Math.round(amount*rate[cur]).toLocaleString('ru-RU')+' ₽':'';
  });
  var setMoney=function(id,value){var el=document.getElementById(id);if(el)el.textContent=Math.round(value).toLocaleString('ru-RU')+' ₽';};
  setMoney('fcManualTotal',manualRub);setMoney('fcAutoSimTotal',simRub);setMoney('fcGrandTotal',manualRub+simRub);
}
function _finCostNative(amount,currency){
  return (Number(amount)||0).toLocaleString('ru-RU')+' '+(currency==='RUB'?'₽':currency);
}
function openOperatorPackagesFromCosts(){
  var ov=document.getElementById('_finCostsOverlay');if(ov)ov.remove();
  var tab=null;document.querySelectorAll('.nav-tab').forEach(function(el){if((el.getAttribute('data-on-click')||'').indexOf("switchMainTab('analytics'")===0)tab=el;});
  switchMainTab('analytics',tab);
  setTimeout(function(){switchSettingsSection('operators');},60);
}
function _renderCostsModal(d) {
  var ov = document.createElement('div');
  ov.id = '_finCostsOverlay';
  ov.className = 'fcm-overlay';
  ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
  ov._fxRates = (d.fx && d.fx.rates) || {};
  var rows = (d.rows && d.rows.length) ? d.rows : (d.template || []).map(function(t){return Object.assign({},t)});
  var byCat = {};
  rows.forEach(function(r){ (byCat[r.category]=byCat[r.category]||[]).push(r); });
  var cats = d.categories || {},meta=d.meta||{},serverLabels=meta.serverLabels||{};

  function editRow(label,sub,cat,key,existing,country){
    var cur=_costCurDefault(existing,country);
    return '<div class="fcm-edit-row set-row" data-cat="'+cat+'"'+(key!=null?' data-key="'+esc(key).replace(/"/g,'&quot;')+'"':'')+'>'
      +'<div class="fcm-edit-label"><b>'+label+'</b>'+(sub?'<small>'+sub+'</small>':'')+'</div>'
      +'<div class="fcm-edit-input">'+_costCurSelect(cur)
      +'<input class="form-input" data-role="amount" type="number" min="0" step="100" value="'+(existing&&existing.amount!=null?existing.amount:'')+'" placeholder="0">'
      +'<span data-role="cur-unit">'+cur+'</span><small data-role="rub-eq"></small></div></div>';
  }

  var automatic=(d.operator_costs||[]).slice(),seenAuto={};
  automatic.forEach(function(c){seenAuto[String(c.operator||'').toLowerCase()]=true;});
  (d.unconfigured_operators||[]).forEach(function(c){
    var key=String(c.operator||'').toLowerCase();if(seenAuto[key])return;seenAuto[key]=true;
    automatic.push({operator:c.operator,sim_count:c.sim_count||0,type:'shared',configured:false,missing:c.missing||['пакет оператора'],bundle_count:null,max_sims:0,price:0,currency:'RUB',amount:0});
  });
  (byCat.sim||[]).forEach(function(r){
    var key=String(r.subkey||'').toLowerCase();if(seenAuto[key])return;seenAuto[key]=true;
    automatic.push({operator:r.subkey,sim_count:r.qty||0,type:'shared',configured:false,missing:['пакет оператора'],bundle_count:null,max_sims:0,price:0,currency:r.currency||'RUB',amount:0});
  });
  var missingCount=0,autoHtml='';
  automatic.sort(function(a,b){return String(a.operator).localeCompare(String(b.operator),'ru');}).forEach(function(c){
    var legacy=(byCat.sim||[]).find(function(r){return String(r.subkey||'').toLowerCase()===String(c.operator||'').toLowerCase();});
    var configured=!!c.configured,effectiveAmount=configured?(Number(c.amount)||0):(legacy?(Number(legacy.amount)||0):0);
    var effectiveCurrency=configured?(c.currency||'RUB'):(legacy?(legacy.currency||'RUB'):(c.currency||'RUB'));
    if(!configured)missingCount++;
    var typeLabel=c.type==='per_sim'?'на SIM':c.type==='unlimited'?'безлимит':'бандл';
    var formula=configured
      ? (c.sim_count+' SIM ÷ '+c.max_sims+' = '+c.bundle_count+' '+(c.bundle_count===1?'бандл':'бандла')+' × '+_finCostNative(c.price,c.currency))
      : 'Нужно заполнить: '+((c.missing||[]).join(', ')||'параметры пакета');
    var traffic=c.type==='unlimited'?'Безлимитный трафик':((c.volume_gb||0).toLocaleString('ru-RU')+' ГБ/бандл'+(c.total_volume_gb!=null?' · '+Number(c.total_volume_gb).toLocaleString('ru-RU')+' ГБ всего':''));
    var source=configured?'из «Пакетов операторов»':(legacy?'временно используется старая ручная сумма':'в расчёт пока не входит');
    var legacyAttrs=(!configured&&legacy)
      ? ' data-legacy-amount="'+(Number(legacy.amount)||0)+'" data-legacy-currency="'+esc(legacy.currency||'RUB')+'" data-legacy-qty="'+(Number(legacy.qty)||0)+'" data-legacy-key="'+esc(legacy.subkey||c.operator).replace(/"/g,'&quot;')+'"'
      : '';
    autoHtml+='<div class="fcm-auto-row'+(configured?'':' is-missing')+'" data-auto-amount="'+effectiveAmount+'" data-auto-currency="'+esc(effectiveCurrency)+'"'+legacyAttrs+'>'
      +'<div class="fcm-auto-op"><b>'+esc(c.operator)+'</b><span>'+esc(typeLabel)+' · '+c.sim_count+' активных SIM</span></div>'
      +'<div class="fcm-auto-formula"><span>'+esc(formula)+'</span><small>'+esc(traffic)+'</small></div>'
      +'<div class="fcm-auto-total"><b>'+_finCostNative(effectiveAmount,effectiveCurrency)+'</b><small data-role="auto-rub"></small><em>'+esc(source)+'</em></div></div>';
  });
  if(!autoHtml)autoHtml='<div class="fcm-empty">В базе пока нет операторов с SIM. Добавьте пакет, когда появится оператор.</div>';

  var serverHtml='',srvList=meta.servers||[];
  srvList.forEach(function(s){
    var existing=(byCat.server||[]).find(function(r){return r.subkey===s});
    serverHtml+=editRow(esc(serverLabels[s]||s),'Аренда сервера','server',s,existing,(meta.serverCountry||{})[s]);
  });
  if(!serverHtml)serverHtml='<div class="fcm-empty">Серверы не найдены</div>';

  var otherHtml='';
  ['electricity','hosting','salary','other'].forEach(function(k){
    var existing=(byCat[k]||[])[0];
    otherHtml+=editRow(esc(cats[k]?cats[k].label:k),'Вводится вручную',k,null,existing,'');
  });

  var fxBlock='';
  if(d.fx){
    var ovM=(d.fx_overrides&&d.fx_overrides.MDL)||0,ovR=(d.fx_overrides&&d.fx_overrides.RON)||0;
    fxBlock='<details class="fcm-fx"><summary>Курсы пересчёта <span>1 MDL = '+_fmtFxRate(d.fx.rates&&d.fx.rates.MDL)+' ₽ · 1 RON = '+_fmtFxRate(d.fx.rates&&d.fx.rates.RON)+' ₽</span></summary>'
      +'<div><label>Свой MDL <input id="fxMdlOv" type="number" min="0" step="0.01" placeholder="'+_fmtFxRate(d.fx.rates&&d.fx.rates.MDL)+'" value="'+(ovM>0?ovM:'')+'"> ₽</label>'
      +'<label>Свой RON <input id="fxRonOv" type="number" min="0" step="0.01" placeholder="'+_fmtFxRate(d.fx.rates&&d.fx.rates.RON)+'" value="'+(ovR>0?ovR:'')+'"> ₽</label>'
      +'<small>Пусто — автоматический курс на '+esc(d.fx.date||'сегодня')+'</small></div></details>';
  }

  var missingBanner=missingCount
    ? '<div class="fcm-missing"><div>'+icon('alert',14)+' <span><b>Нужно дополнить пакеты: '+missingCount+'</b><small>Без цены, объёма или лимита SIM автоматический расчёт невозможен.</small></span></div><button class="btn btn-sm" data-on-click="openOperatorPackagesFromCosts()">Заполнить пакеты →</button></div>'
    : '';

  ov.innerHTML='<div class="fcm-modal">'
    +'<div class="fcm-head"><div><small>Финансы · '+esc(d.period)+'</small><h3>Затраты месяца</h3><p>SIM считаются автоматически, остальные расходы вводятся вручную.</p></div>'
    +'<button class="fcm-close" data-on-click="document.getElementById(\'_finCostsOverlay\').remove()">&times;</button></div>'
    +'<div class="fcm-summary"><div><span>SIM и бандлы</span><b id="fcAutoSimTotal">0 ₽</b></div><div><span>Ручные расходы</span><b id="fcManualTotal">0 ₽</b></div><div class="is-total"><span>Итого за месяц</span><b id="fcGrandTotal">0 ₽</b></div></div>'
    +(rows.length===0&&(d.template||[]).length>0?'<div class="fcm-carried">'+icon('info',12)+' Ручные значения подставлены из предыдущего месяца — проверьте их перед сохранением.</div>':'')
    +missingBanner
    +'<section class="fcm-section"><div class="fcm-section-head"><div><h4>SIM и пакеты операторов</h4><p>Только для чтения · данные берутся из базы и настроек пакета</p></div><button class="btn btn-sm" data-on-click="openOperatorPackagesFromCosts()">Настроить</button></div><div class="fcm-auto-list">'+autoHtml+'</div></section>'
    +'<div class="fcm-two-col"><section class="fcm-section"><div class="fcm-section-head"><div><h4>Серверы</h4><p>Ежемесячная аренда площадок</p></div></div>'+serverHtml+'</section>'
    +'<section class="fcm-section"><div class="fcm-section-head"><div><h4>Прочее</h4><p>Электричество, связь и команда</p></div></div>'+otherHtml+'</section></div>'
    +fxBlock
    +'<div class="fcm-save"><button class="btn" data-on-click="document.getElementById(\'_finCostsOverlay\').remove()">Отмена</button><button class="btn btn-primary" data-on-click="saveCostsModal()">'+icon('save',13)+' Сохранить ручные расходы</button></div>'
    +'</div>';
  document.body.appendChild(ov);
  ov.addEventListener('input',function(){_finCostsRecalc(ov);});
  ov.addEventListener('change',function(){_finCostsRecalc(ov);});
  _finCostsRecalc(ov);
}
function saveCostsModal() {
  var ov = document.getElementById('_finCostsOverlay');
  if (!ov) return;
  // Ручной курс: пусто = авто (0), иначе число >= 0.
  function _ovRate(id) {
    var el = document.getElementById(id);
    if (!el || el.value.trim() === '') return 0;
    var v = parseFloat(el.value);
    if (!isFinite(v) || v < 0) return null;
    return v;
  }
  var fxMdl = _ovRate('fxMdlOv'), fxRon = _ovRate('fxRonOv');
  if (fxMdl === null || fxRon === null) {
    showToast('Курс должен быть числом ≥ 0 (пусто = авто по ЦБ)', 'error');
    return;
  }
  var items = [];
  ov.querySelectorAll('.set-row[data-cat]').forEach(function(row){
    var cat = row.dataset.cat;
    var curEl = row.querySelector('[data-role="currency"]');
    var cur = curEl ? curEl.value : 'RUB';
    var qty = null;
    var amount = parseFloat((row.querySelector('[data-role="amount"]') || {}).value);
    if (!isFinite(amount) || amount <= 0) return;
    items.push({ category: cat, subkey: row.dataset.key || null, amount: amount, currency: cur, qty: qty });
  });
  // Пока пакет не заполнен, модалка может явно показать старую ручную сумму
  // как fallback. Переносим только такой видимый fallback; готовые пакеты
  // остаются полностью автоматическими и никогда не дублируются.
  ov.querySelectorAll('.fcm-auto-row[data-legacy-amount]').forEach(function(row){
    var amount=parseFloat(row.dataset.legacyAmount)||0;if(!(amount>0))return;
    items.push({category:'sim',subkey:row.dataset.legacyKey||null,amount:amount,
      currency:row.dataset.legacyCurrency||'RUB',qty:parseFloat(row.dataset.legacyQty)||null});
  });
  // Сначала ручной курс (если модалка его показывала), потом сами затраты.
  var saveFx = document.getElementById('fxMdlOv')
    ? api(API + '/api/admin/settings', { method: 'PUT', json: { fx_rate_mdl: fxMdl, fx_rate_ron: fxRon } })
    : Promise.resolve({ ok: true });
  saveFx.then(function(sd){
    if (sd && sd.error) { showToast(sd.error, 'error'); return; }
    api(API + '/api/admin/monthly_costs',{method:'POST',json:{ period: _finCurrentPeriod, items: items }})
      .then(function(d){
        if (d.ok) {
          showToast('Ручные расходы сохранены. SIM пересчитаны по пакетам операторов.', 'success');
          document.getElementById('_finCostsOverlay').remove();
          renderFinancesTabNew();
        } else {
          showToast(d.error || 'Ошибка', 'error');
        }
      })
      .catch(function(e){ showToast(e.message, 'error') });
  }).catch(function(e){ showToast(e.message, 'error') });
}

// Top Resources — uses server-side aggregated cache (auto-refreshes nightly at 03:00)

// ─── Построчное редактирование акта / суммы счёта (2026-08-04) ────────────
function openActEditor(clientId, docId) {
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var doc = client && (client.closingDocuments || []).find(function(d) { return d.id === docId; });
  if (!doc) return;
  var rows = (doc.items || []).map(function(it) {
    return { name: it.name || '', quantity: it.quantity || 1, unit: it.unit || 'шт', price: it.price || 0 };
  });
  var h = '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1600;display:flex;align-items:center;justify-content:center" id="actEditorOverlay">';
  h += '<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:18px;width:640px;max-width:94vw;max-height:84vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.5)">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><span style="font-size:14px;font-weight:600;color:var(--text-0)">' + icon('edit', 14) + ' Акт ' + esc(doc.actNumber || '') + ' · ' + esc(doc.period || '') + '</span><button style="background:none;border:none;font-size:18px;color:var(--text-2);cursor:pointer;padding:0 4px" data-on-click="document.getElementById(\'actEditorOverlay\').remove()">&times;</button></div>';
  h += '<div style="font-size:10px;color:var(--text-3);margin-bottom:10px">Изменения сохраняются в нашей базе (история в админке). Документ в интернет-банке не меняется — для замены есть «перевыставить».</div>';
  h += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px"><thead><tr style="background:var(--bg-3)"><th style="padding:5px 8px;text-align:left;font-size:10px;color:var(--text-2)">Название</th><th style="padding:5px 8px;font-size:10px;color:var(--text-2);width:80px">Кол-во</th><th style="padding:5px 8px;font-size:10px;color:var(--text-2);width:70px">Ед.</th><th style="padding:5px 8px;font-size:10px;color:var(--text-2);width:100px">Цена</th><th style="padding:5px 8px;font-size:10px;color:var(--text-2);width:90px">Сумма</th><th style="width:30px"></th></tr></thead><tbody id="actEditRows"></tbody></table>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><button class="btn btn-sm" data-on-click="actEditorAddRow()" style="font-size:11px">' + icon('plus', 11) + ' Позиция</button><span style="font-size:13px;font-weight:600">Итого: <span id="actEditTotal">0</span> ₽</span></div>';
  h += '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-sm" data-on-click="document.getElementById(\'actEditorOverlay\').remove()">Отмена</button><button class="btn btn-sm" title="Удалить документ в банке и создать заново с отредактированными позициями" data-on-click="actEditorReissue(\'' + clientId + '\',\'' + docId + '\',\'' + esc(doc.period || '') + '\')" style="color:var(--warning)">↻ В Точку с правками</button><button class="btn btn-primary btn-sm" data-on-click="actEditorSave(\'' + clientId + '\',\'' + docId + '\')">' + icon('save', 12) + ' Сохранить</button></div>';
  h += '</div></div>';
  document.body.insertAdjacentHTML('beforeend', h);
  window._actEditRows = rows;
  actEditorRenderRows();
}

function actEditorRenderRows() {
  var tb = document.getElementById('actEditRows');
  if (!tb) return;
  var h = '', total = 0;
  window._actEditRows.forEach(function(r, i) {
    var amount = Math.round((Number(r.quantity) || 0) * (Number(r.price) || 0) * 100) / 100;
    total += amount;
    h += '<tr>' +
      '<td style="padding:4px 6px"><input class="form-input" data-idx="' + i + '" data-f="name" value="' + esc(r.name).replace(/"/g, '&quot;') + '" style="width:100%;font-size:11px;padding:4px 6px" data-on-change="actEditorField(this)"></td>' +
      '<td style="padding:4px 6px"><input class="form-input" type="number" step="any" data-idx="' + i + '" data-f="quantity" value="' + r.quantity + '" style="width:100%;font-size:11px;padding:4px 6px" data-on-change="actEditorField(this)"></td>' +
      '<td style="padding:4px 6px"><select class="form-input" data-idx="' + i + '" data-f="unit" style="width:100%;font-size:11px;padding:3px 4px" data-on-change="actEditorField(this)">' + ['шт','услуга','ГБ','мес','день','ч','компл'].map(function(u){ return '<option value="' + u + '"' + (r.unit === u ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></td>' +
      '<td style="padding:4px 6px"><input class="form-input" type="number" step="any" data-idx="' + i + '" data-f="price" value="' + r.price + '" style="width:100%;font-size:11px;padding:4px 6px" data-on-change="actEditorField(this)"></td>' +
      '<td style="padding:4px 6px;text-align:right;font-family:var(--font-mono);font-size:11px" id="actEditAmt' + i + '">' + amount.toLocaleString('ru-RU') + '</td>' +
      '<td style="padding:4px 2px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:1px 5px;color:var(--danger)" data-on-click="actEditorDelRow(' + i + ')">' + icon('x', 10) + '</button></td></tr>';
  });
  tb.innerHTML = h;
  document.getElementById('actEditTotal').textContent = (Math.round(total * 100) / 100).toLocaleString('ru-RU');
}

function actEditorField(inp) {
  var i = Number(inp.dataset.idx), f = inp.dataset.f;
  var r = window._actEditRows[i];
  if (!r) return;
  r[f] = (f === 'quantity' || f === 'price') ? (parseFloat(inp.value) || 0) : inp.value;
  var amount = Math.round((Number(r.quantity) || 0) * (Number(r.price) || 0) * 100) / 100;
  var amtEl = document.getElementById('actEditAmt' + i);
  if (amtEl) amtEl.textContent = amount.toLocaleString('ru-RU');
  var total = window._actEditRows.reduce(function(s, x) { return s + (Number(x.quantity) || 0) * (Number(x.price) || 0); }, 0);
  document.getElementById('actEditTotal').textContent = (Math.round(total * 100) / 100).toLocaleString('ru-RU');
}

function actEditorAddRow() {
  window._actEditRows.push({ name: '', quantity: 1, unit: 'шт', price: 0 });
  actEditorRenderRows();
}

function actEditorDelRow(i) {
  window._actEditRows.splice(i, 1);
  actEditorRenderRows();
}

function actEditorSave(clientId, docId) {
  var items = window._actEditRows.map(function(r) {
    return { name: String(r.name || '').trim(), quantity: Number(r.quantity) || 0, unit: r.unit || 'шт', price: Number(r.price) || 0 };
  });
  api(API + '/api/admin/clients/' + clientId + '/closing_documents/' + docId, { method: 'PUT', json: { items: items } })
    .then(function(d) {
      if (d.ok) {
        showToast('Акт обновлён: ' + d.document.totalAmount.toLocaleString('ru-RU') + ' ₽', 'success');
        var ov = document.getElementById('actEditorOverlay'); if (ov) ov.remove();
        loadData();
      } else showToast(d.error || 'Ошибка', 'error');
    })
    .catch(function(e) { showToast(e.message, 'error'); });
}

function actEditorReissue(clientId, docId, period) {
  // Перевыставить с ОТРЕДАКТИРОВАННЫМИ позициями: Точка API не умеет
  // редактировать закрывающий документ (только create/delete/get/send),
  // поэтому единственный путь — удалить старый в банке и создать заново
  // уже с правками. Позиции берём прямо из редактора (сохранять не обязательно).
  var items = window._actEditRows.map(function(r) {
    return { name: String(r.name || '').trim(), quantity: Number(r.quantity) || 0, unit: r.unit || 'шт', price: Number(r.price) || 0 };
  }).filter(function(it) { return it.name; });
  if (!items.length) return showToast('Нет позиций для акта', 'error');
  for (var i = 0; i < items.length; i++) {
    if (!(items[i].quantity > 0) || !(items[i].price >= 0)) return showToast('Позиция ' + (i + 1) + ': проверьте количество и цену', 'error');
  }
  if (!confirm('Перевыставить акт ' + period + ' в Точке с отредактированными позициями?\nСтарый документ в банке будет УДАЛЁН, новый создан с этими позициями.')) return;
  api(API + '/api/admin/clients/' + clientId + '/closing_document/' + docId, { method: 'DELETE' })
    .then(function(d) {
      if (!d.ok) throw new Error(d.error || 'Не удалось удалить старый акт');
      return api(API + '/api/admin/tochka/create_act', { method: 'POST', json: { clientId: clientId, period: period, items: items } });
    })
    .then(function(d) {
      if (d.ok) {
        if (d.tochkaPushed) showToast('Акт перевыставлен в Точке с отредактированными позициями', 'success');
        else showToast('Акт пересоздан локально, но НЕ ушёл в Точку: ' + (d.tochkaStatus || 'причина неизвестна'), 'error', 12000);
        var ov = document.getElementById('actEditorOverlay'); if (ov) ov.remove();
        loadData(); setTimeout(function() { if (currentOpsClientId === clientId) renderOpsDocuments(clientId); if (typeof renderBankDocuments === 'function') renderBankDocuments(); }, 1500);
      }
      else showToast(d.error || 'Старый удалён, но новый не создался — создайте акт заново', 'error');
    })
    .catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

function editBillAmount(clientId, billId) {
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var bill = client && (client.bills || []).find(function(b) { return b.id === billId; });
  if (!bill) return;
  uiPrompt('Новая сумма счёта ' + (bill.billNumber || '') + ' (сейчас ' + (bill.amount || 0).toLocaleString('ru-RU') + ' ₽):', { title: 'Изменить сумму счёта', okText: 'Сохранить', placeholder: String(bill.amount || '') }).then(function(v) {
    var amount = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.'));
    if (!v || !(amount > 0)) return;
    api(API + '/api/admin/clients/' + clientId + '/bills/' + billId, { method: 'PUT', json: { amount: amount } })
      .then(function(d) {
        if (d.ok) { showToast('Сумма счёта обновлена', 'success'); loadData(); }
        else showToast(d.error || 'Ошибка', 'error');
      })
      .catch(function(e) { showToast(e.message, 'error'); });
  });
}

function renderOpsDocuments(clientId) {
  var body = document.getElementById('clientOpsBody');
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var actDocs = client ? (client.closingDocuments || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var bills = client ? (client.bills || []).slice().sort(function(a,b){ return (b.period||'').localeCompare(a.period||''); }) : [];
  var fileDocs = client ? client.documents || [] : [];

  var h = '<div style="padding:4px 0">';

  // === SECTION: АКТЫ ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">' + icon('doc', 13) + ' Закрывающие документы (акты)</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="actPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" data-on-click="createAct(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">' + icon('plus', 11) + ' Создать акт</button>';
  h += '</div>';
  if (actDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    actDocs.forEach(function(d) {
      var isSigned = d.status === 'signed';
      var statusHtml = isSigned
        ? '<span style="color:var(--success);font-size:11px">' + icon('check', 11) + ' Подписан</span>'
        : '<span style="color:var(--danger);font-size:11px">' + icon('x', 11) + ' Не подписан</span>';
      var toggleBtn = isSigned
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'unsigned\')">' + icon('x', 11) + '</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleActStatus(\'' + clientId + '\',\'' + d.id + '\',\'signed\')">' + icon('check', 11) + '</button>';
      var pdfBtn = (d.tochkaDocumentId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="downloadActPdf(\'' + clientId + '\',\'' + d.id + '\')">' + icon('download', 11) + ' PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="window.open(API+\'/api/admin/clients/'+clientId+'/closing_documents/'+d.id+'/print?token=\'+authToken,\'_blank\')">' + icon('print', 11) + '</button>';
      h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(d.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Редактировать позиции акта" data-on-click="openActEditor(\'' + clientId + '\',\'' + d.id + '\')">' + icon('edit', 11) + '</button> ' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="\u041f\u0435\u0440\u0435\u0432\u044b\u0441\u0442\u0430\u0432\u0438\u0442\u044c: \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u0438 \u0441\u043e\u0437\u0434\u0430\u0442\u044c \u0437\u0430\u043d\u043e\u0432\u043e \u043f\u043e \u0442\u0435\u043a\u0443\u0449\u0438\u043c \u0434\u0430\u043d\u043d\u044b\u043c" data-on-click="reissueAct(\'' + clientId + '\',\'' + d.id + '\',\'' + esc(d.period) + '\')">\u21bb</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0430\u043a\u0442" data-on-click="deleteAct(\'' + clientId + '\',\'' + d.id + '\')">' + icon('trash', 11) + '</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет закрывающих документов</div>';
  }
  h += '</div>';

  // === SECTION: СЧЕТА ===
  h += '<div style="margin-bottom:16px">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">' + icon('card', 13) + ' Счета на оплату</h4></div>';
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px;padding:8px 10px;background:var(--bg-3);border-radius:6px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период</label><input class="form-input" type="month" id="billPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Сумма (авто)</label><input class="form-input" type="number" id="billAmount" placeholder="авто" style="width:100px;font-size:12px;padding:4px 8px"></div>';
  h += '<button class="btn btn-primary btn-sm" data-on-click="createBill(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">' + icon('plus', 11) + ' Выставить счёт</button>';
  h += '</div>';
  if (bills.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Период</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Номер</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Сумма</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Статус</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    bills.forEach(function(b) {
      var isPaid = b.status === 'paid';
      var statusHtml = isPaid
        ? '<span style="color:var(--success);font-size:11px">' + icon('check', 11) + ' Оплачен</span>'
        : '<span style="color:var(--danger);font-size:11px">' + icon('hourglass', 11) + ' Не оплачен</span>';
      var toggleBtn = isPaid
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
        : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleBillStatus(\'' + clientId + '\',\'' + b.id + '\',\'paid\')">' + icon('check', 11) + '</button>';
      var pdfBtn = (b.tochkaBillId
        ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="downloadBillPdf(\'' + clientId + '\',\'' + b.id + '\')">' + icon('download', 11) + ' PDF</button> '
        : '') + '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="window.open(API+\'/api/admin/clients/'+clientId+'/bills/'+b.id+'/print?token=\'+authToken,\'_blank\')">' + icon('print', 11) + '</button>';
      h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
      h += '<td style="padding:5px 10px;font-weight:500;font-size:12px">' + esc(b.period) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;font-weight:600;font-size:12px">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
      h += '<td style="padding:5px 10px;text-align:center">' + statusHtml + '</td>';
      h += '<td style="padding:5px 10px;text-align:center;white-space:nowrap"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Изменить сумму счёта" data-on-click="editBillAmount(\'' + clientId + '\',\'' + b.id + '\')">' + icon('edit', 11) + '</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--warning)" title="Перевыставить с новой суммой" data-on-click="reissueBillEdited(\'' + clientId + '\',\'' + b.id + '\')">↻</button> ' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u0447\u0451\u0442" data-on-click="deleteBill(\'' + clientId + '\',\'' + b.id + '\')">' + icon('trash', 11) + '</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет выставленных счетов</div>';
  }
  h += '</div>';

  // === SECTION: ФАЙЛЫ ===
  h += '<div>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h4 style="margin:0;font-size:13px;color:var(--text-1)">' + icon('link', 13) + ' Загруженные документы</h4></div>';
  if (fileDocs.length) {
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--bg-3)"><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Документ</th><th style="padding:6px 10px;text-align:left;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Дата</th><th style="padding:6px 10px;text-align:center;color:var(--text-2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Действия</th></tr></thead><tbody>';
    fileDocs.forEach(function(d) {
      h += '<tr>';
      h += '<td style="padding:5px 10px;font-size:12px">' + esc(d.name) + '</td>';
      h += '<td style="padding:5px 10px;color:var(--text-3);font-size:11px">' + new Date(d.date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) + '</td>';
      h += '<td style="padding:5px 10px;text-align:center"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" data-on-click="deleteDocumentModal(\'' + clientId + '\',\'' + d.id + '\')">Удалить</button></td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
  } else {
    h += '<div style="color:var(--text-3);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:6px">Нет загруженных документов</div>';
  }
  h += '<div style="padding:10px 0;margin-top:8px;display:flex;align-items:center;gap:8px">';
  h += '<input type="file" id="docFileModal" style="font-size:11px;flex:1">';
  h += '<button class="btn btn-primary btn-sm" data-on-click="uploadDocumentModal(\'' + clientId + '\')" style="padding:4px 10px;font-size:11px">Загрузить</button>';
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

// A4: физическое удаление ledger-записей запрещено на бэке (405). Платёж
// сторнируется через существующий идемпотентный роут — payment_reversal
// в одной транзакции с откатом баланса и реферальной комиссии.
function reverseLedgerPayment(clientId, ledgerDbId) {
  if (!confirm('Сторнировать этот платёж? Баланс и реферальная комиссия будут откачены (запись payment_reversal останется в истории).')) return;
  api(API + '/api/admin/clients/' + clientId + '/payment/by-ledger/' + ledgerDbId,{method:'DELETE'})
    .then(function(d) {
      if (d.ok) { showToast(d.already ? 'Платёж уже был сторнирован' : 'Платёж сторнирован', 'success'); renderOpsHistory(clientId); loadData(); }
      else showToast(d.error || 'Ошибка', 'error');
    }).catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
}

// WP6 (Р28): ручная выплата партнёрской комиссии деньгами оператором.
// Списывает referral_balance и пишет payout в ledger; баланс клиента не трогает.
function payoutReferral(clientId, balance) {
  var amount = prompt('Сумма выплаты партнёрской комиссии, ₽ (доступно ' + Math.round(balance) + ' ₽):', Math.round(balance));
  if (amount === null) return;
  amount = parseFloat(amount);
  if (!(amount > 0)) return showToast('Укажите сумму', 'error');
  var note = prompt('Комментарий (как выплачено: карта/наличные):', 'Выплата на карту');
  api(API + '/api/admin/clients/' + clientId + '/referral_payout',{method:'POST',json:{ amount: amount, note: note || '' }})
    .then(function(d) {
      if (d.ok) { showToast('Выплата ' + amount + ' ₽ записана', 'success'); renderOpsHistory(clientId); loadData(); }
      else showToast(d.error || 'Ошибка', 'error');
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
  h += '<h3 style="margin:0">' + icon('bank', 15) + ' \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0422\u043E\u0447\u043A\u0430 \u0411\u0430\u043D\u043A</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">' + icon('check', 11) + ' API \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:11px;padding:3px 10px;border-radius:8px">' + icon('x', 11) + ' API \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D</span>';
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
  h += '<button class="btn btn-primary" data-on-click="saveBankConfig()">' + icon('save', 13) + ' \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>';
  if (tochkaOk) {
    h += '<button class="btn" style="background:#f59e0b;color:#fff" data-on-click="autodetectBank()">' + icon('search', 13) + ' \u0410\u0432\u0442\u043E\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C</button>';
    h += '<button class="btn btn-success" data-on-click="registerWebhook()">' + icon('link', 13) + ' \u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C webhook</button>';
    h += '<button class="btn" style="background:#6366f1;color:#fff" data-on-click="syncPayments()">' + icon('refresh', 13) + ' \u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043F\u043B\u0430\u0442\u0435\u0436\u0438</button>';
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
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">' + icon('hourglass', 12) + ' \u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0432\u044B\u043F\u0438\u0441\u043A\u0443... (\u0434\u043E 30 \u0441\u0435\u043A)</span>';
  api(API + '/api/admin/tochka/sync',{method:'POST',json:{ dateFrom: dateFrom, dateTo: dateTo }})
    .then(function(d) {
      if (d.ok) {
        var msg = '\u0413\u043E\u0442\u043E\u0432\u043E! \u0412\u0441\u0435\u0433\u043E: ' + d.total + ', \u0438\u043C\u043F\u043E\u0440\u0442: ' + d.imported + ', \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u043E: ' + d.matched + ', \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E: ' + d.skipped;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + icon('check', 12) + ' ' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
      } else {
        var errMsg = d.error || '\u041E\u0448\u0438\u0431\u043A\u0430';
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + errMsg + '</span>';
        showToast(errMsg, 'error');
      }
    })
    .catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + esc(e.message) + '</span>';
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
  h += '<h3 style="margin:0">' + icon('doc', 15) + ' Документооборот</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" data-on-click="document.getElementById(\'bulkActPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkActPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" data-on-click="generateBulkActs()" style="white-space:nowrap;padding:4px 12px">' + icon('doc', 12) + ' Сгенерировать акты для всех клиентов</button>';
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
        h += '<div data-on-click="toggleActPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
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
            ? '<span style="color:var(--success);font-weight:600">' + icon('check', 12) + ' Подписан</span>'
            : '<span style="color:var(--danger);font-weight:600">' + icon('x', 12) + ' Не подписан</span>';
          var toggleBtn = isSigned
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'unsigned\')">' + icon('x', 11) + '</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleActStatus(\'' + d.clientId + '\',\'' + d.id + '\',\'signed\')">' + icon('check', 11) + '</button>';
          var pdfBtn = d.tochkaDocumentId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="downloadActPdf(\'' + d.clientId + '\',\'' + d.id + '\')">' + icon('download', 11) + '</button>'
            : '';
          h += '<tr style="' + (isSigned ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(d.clientName || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(d.actNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (d.totalAmount || 0).toLocaleString('ru-RU') + ' ₽</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Редактировать позиции акта" data-on-click="openActEditor(\'' + d.clientId + '\',\'' + d.id + '\')">' + icon('edit', 11) + '</button> ' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Перевыставить: удалить и создать заново" data-on-click="reissueAct(\'' + d.clientId + '\',\'' + d.id + '\',\'' + esc(d.period || '') + '\')">↻</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить акт" data-on-click="deleteActFromBank(\'' + d.clientId + '\',\'' + d.id + '\')">' + icon('trash', 11) + '</button></td>';
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
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">' + icon('hourglass', 12) + ' Генерирую акты...</span>';
  api(API + '/api/admin/tochka/generate_acts',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = 'Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + icon('check', 12) + ' ' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllActs(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + esc(e.message) + '</span>';
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
  h += '<h3 style="margin:0">' + icon('card', 15) + ' Счета на оплату</h3>';
  h += '</div>';

  // Bulk generation form
  h += '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px;padding:10px 12px;background:var(--bg-3);border-radius:8px;flex-wrap:wrap">';
  h += '<div><label style="font-size:10px;color:var(--text-2);display:block;margin-bottom:2px">Период (ГГГГ-ММ)</label><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+(function(){var btns='';var now=new Date();for(var mi=0;mi<4;mi++){var d2=new Date(now.getFullYear(),now.getMonth()-mi,1);var val=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0');var months=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];var lbl=months[d2.getMonth()]+' '+d2.getFullYear();btns+='<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" data-on-click="document.getElementById(\'bulkBillPeriod\').value=\''+val+'\'">'+lbl+'</button>';}return btns;}())+'<input class="form-input" type="month" id="bulkBillPeriod" style="width:140px;font-size:12px;padding:4px 8px"></div></div>';
  h += '<button class="btn btn-primary btn-sm" data-on-click="generateBulkBills()" style="white-space:nowrap;padding:4px 12px">' + icon('card', 12) + ' Выставить счета всем клиентам</button>';
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
        h += '<div data-on-click="toggleBillPeriod(this)" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-3);user-select:none">';
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
            ? '<span style="color:var(--success);font-weight:600">' + icon('check', 12) + ' Оплачен</span>'
            : '<span style="color:var(--danger);font-weight:600">' + icon('hourglass', 12) + ' Не оплачен</span>';
          var toggleBtn = isPaid
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'unpaid\')">↩</button>'
            : '<button class="btn btn-success btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="toggleBillStatus(\'' + b.clientId + '\',\'' + b.id + '\',\'paid\')">' + icon('check', 11) + '</button>';
          var pdfBtn = b.tochkaBillId
            ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" data-on-click="downloadBillPdf(\'' + b.clientId + '\',\'' + b.id + '\')">' + icon('download', 11) + '</button>'
            : '';
          var _fHtml = '';
          if (b.billingType === 'per_gb' && b.formula && b.formula.kind === 'per_gb') {
            var _f = b.formula;
            var _mmNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
            var _mm = _f.prev_period ? parseInt(_f.prev_period.slice(5, 7), 10) : 0;
            var _mn = _mmNames[_mm - 1] || 'прошлый мес.';
            var _rub = function(v) { return Math.round(v).toLocaleString('ru-RU') + ' ₽'; };
            _fHtml = '<div style="font-weight:400;font-size:9.5px;color:var(--text-3);margin-top:2px;line-height:1.35" title="Как посчитана сумма счёта">'
              + 'MAX (' + esc(_rub(_f.prev_amount)) + ' за ' + esc(_mn) + ' или ';
            if (_f.avg_daily_gb != null) {
              // Текущая формула (2026-08-02): среднесуточное за 7 дней.
              _fHtml += '<span style="text-decoration:underline dotted;cursor:help" title="Среднесуточное потребление за последние 7 дней по биллингу: ' + esc(String(_f.run_rate_gb)) + ' ГБ за 7 дн. ÷ 7">' + esc(String(_f.avg_daily_gb)) + ' ГБ</span>'
                + ' × ' + esc(String(_f.days_in_month)) + ' дн. × ' + esc(String(_f.price)) + ' ₽';
            } else {
              // Легаси-формула (run-rate месяц-к-дате × 1.1) — старые счета.
              _fHtml += esc(String(_f.run_rate_gb)) + ' ГБ ÷ ' + esc(String(_f.days_elapsed)) + ' дн. × ' + esc(String(_f.days_in_month)) + ' дн. × ' + esc(String(_f.price)) + ' ₽' + (_f.margin && _f.margin !== 1 ? ' × ' + esc(String(_f.margin)) : '');
            }
            _fHtml += ' = ' + esc(_rub(_f.forecast_amount)) + ')'
              + (_f.debt ? ' + долг ' + esc(_rub(_f.debt)) : '')
              + (_f.rounded_to ? ' → ↑' + (_f.rounded_to / 1000) + 'k' : '') + '</div>';
          } else if (b.billingType === 'per_gb' && b.formulaText) {
            _fHtml = '<div style="font-weight:400;font-size:9.5px;color:var(--text-3);margin-top:2px;line-height:1.35">Σ: ' + esc(b.formulaText) + '</div>';
          }
          h += '<tr style="' + (isPaid ? '' : 'background:rgba(220,38,38,0.04)') + '">';
          h += '<td style="padding:6px 10px;font-weight:500">' + esc(b.clientName || '') + _fHtml + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.clientInn || '') + '</td>';
          h += '<td style="padding:6px 10px;color:var(--text-3);font-size:11px">' + esc(b.billNumber || '') + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;font-weight:600">' + (b.amount || 0).toLocaleString('ru-RU') + ' \u20BD</td>';
          h += '<td style="padding:6px 10px;text-align:center">' + statusHtml + '</td>';
          h += '<td style="padding:6px 10px;text-align:center;white-space:nowrap"><button class="btn btn-sm" style="font-size:10px;padding:2px 6px" title="Изменить сумму счёта" data-on-click="editBillAmount(\'' + b.clientId + '\',\'' + b.id + '\')">' + icon('edit', 11) + '</button> <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--warning)" title="Перевыставить с новой суммой: удалить старый в банке и создать заново" data-on-click="reissueBillEdited(\'' + b.clientId + '\',\'' + b.id + '\')">↻</button> ' + pdfBtn + ' ' + toggleBtn + ' <button class="btn btn-sm" style="font-size:10px;padding:2px 6px;color:var(--danger)" title="Удалить счёт" data-on-click="deleteBillFromBank(\'' + b.clientId + '\',\'' + b.id + '\')">' + icon('trash', 11) + '</button></td>';
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
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent)">' + icon('hourglass', 12) + ' Генерирую счета...</span>';
  api(API + '/api/admin/tochka/generate_bills',{method:'POST',json:{ period: period }})
    .then(function(d) {
      if (d.ok) {
        var msg = 'Создано: ' + d.generated + ', пропущено: ' + d.skipped;
        if (d.errors > 0) msg += ', ошибок: ' + d.errors;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">' + icon('check', 12) + ' ' + msg + '</span>';
        showToast(msg, 'success');
        loadData();
        setTimeout(function() { loadAllBills(); }, 1500);
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + esc(d.error || 'Ошибка') + '</span>';
        showToast(d.error || 'Ошибка', 'error');
      }
    }).catch(function(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + icon('x', 12) + ' ' + esc(e.message) + '</span>';
      showToast(e.message, 'error');
    });
}

function reissueBillEdited(clientId, billId) {
  // «В Точку с правками» для счёта: API Точки не редактирует счета — удаляем
  // старый в банке и выставляем новый с изменённой суммой.
  var client = (currentData.clients || []).find(function(c) { return c.id === clientId; });
  var bill = client && (client.bills || []).find(function(b) { return b.id === billId; });
  if (!bill) return;
  uiPrompt('Сумма НОВОГО счёта (старый ' + (bill.amount || 0).toLocaleString('ru-RU') + ' ₽ будет удалён в банке):', { title: 'Перевыставить счёт', okText: 'Перевыставить', danger: true, placeholder: String(bill.amount || '') }).then(function(v) {
    var amount = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.'));
    if (!v || !(amount > 0)) return;
    api(API + '/api/admin/clients/' + clientId + '/bill/' + billId, { method: 'DELETE' })
      .then(function(d) {
        if (!d.ok) throw new Error(d.error || 'Не удалось удалить старый счёт');
        return api(API + '/api/admin/tochka/create_bill', { method: 'POST', json: { clientId: clientId, period: bill.period, amount: amount } });
      })
      .then(function(d) {
        if (d.ok) {
          showToast('Счёт перевыставлен: ' + amount.toLocaleString('ru-RU') + ' ₽', 'success');
          loadData(); setTimeout(function() { loadAllBills(); if (currentOpsClientId === clientId) renderOpsDocuments(clientId); }, 1500);
        } else showToast(d.error || 'Старый удалён, но новый не создался', 'error');
      })
      .catch(function(e) { showToast(e.message || 'Ошибка сети', 'error'); });
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
  h += '<h3 style="margin:0">' + icon('bank', 15) + ' Банк Точка</h3>';
  if (tochkaOk) {
    h += '<span class="badge" style="background:var(--success);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API подключён</span>';
  } else {
    h += '<span class="badge" style="background:var(--danger);color:#fff;font-size:10px;padding:2px 8px;border-radius:8px">API не настроен</span>';
  }
  h += '</div>';
  // Search toolbar
  h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding:8px 10px;background:var(--bg-3);border-radius:8px">';
  h += '<input id="paymentsSearchInput" class="form-input" placeholder="Поиск по плательщику, ИНН, назначению..." data-on-input="filterPayments()" value="'+esc(searchVal)+'" style="flex:1;font-size:12px;padding:5px 10px">';
  var unmatchedCount=bp.filter(function(p){return!p.matched&&!p.dismissed&&p.webhookType==='incomingPayment'}).length;
  if(unmatchedCount>0)h+='<span style="font-size:11px;color:var(--danger);font-weight:600;white-space:nowrap">' + icon('alert', 11) + ' Неопознанных: '+unmatchedCount+'</span>';
  h += '</div>';
  var unmatched = bp.filter(function(p) { return !p.matched && !p.dismissed && p.webhookType === 'incomingPayment'; }).sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
  if(searchVal){unmatched=unmatched.filter(function(p){return(p.payerName||'').toLowerCase().indexOf(searchVal)!==-1||(p.payerInn||'').toLowerCase().indexOf(searchVal)!==-1||(p.purpose||'').toLowerCase().indexOf(searchVal)!==-1;})}
  if (unmatched.length > 0) {
    h += '<div style="background:rgba(220,38,38,0.1);border:1px solid var(--danger);border-radius:8px;padding:10px;margin-bottom:12px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    h += '<span style="font-weight:600;color:var(--danger)">' + icon('alert', 12) + ' \u041D\u0435\u043E\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u044B\u0435 \u043F\u043B\u0430\u0442\u0435\u0436\u0438: ' + unmatched.length + '</span>';
    h += '<button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:var(--bg-3)" data-on-click="dismissAllUnmatched()">' + icon('x', 11) + ' \u0423\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435</button>';
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
      h += '</select> <button class="btn btn-sm btn-primary" style="font-size:9px;padding:1px 6px" data-on-click="matchPayment(\'' + p.id + '\')">OK</button>';
      h += ' <button class="btn btn-sm" style="font-size:9px;padding:1px 4px;background:var(--bg-3)" data-on-click="dismissPayment(\'' + p.id + '\')" title="\u0423\u0431\u0440\u0430\u0442\u044C">' + icon('x', 10) + '</button></td>';
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
      h += '<td style="padding:4px 6px;color:var(--success);font-weight:500">'+(isUnmatched?'<span style="color:var(--danger)">' + icon('alert', 11) + ' Не привязан</span>':icon('check', 11) + ' ' + esc(p.matchedClientName || ''))+'</td>';
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
  var skel = document.getElementById('mrrSkel');
  if(skel) skel.style.display = 'none';   // финданные пришли — скелетон убираем
  var lg = document.getElementById('mrrLegend');
  var cc = getChartColorsLight();
  // Текущий месяц — стек «Факт к дате» + «остаток прогноза» (2026-08-04),
  // как в карточке трафика: сплошная часть растёт каждый день, сверху
  // полупрозрачный остаток до forecast_eom, общая высота = прогноз месяца.
  // Раньше факт ЗАМЕНЯЛСЯ прогнозом целиком — месяц визуально не «заполнялся».
  var trend = (d.trend || []).map(function(t){ return { month: t.month, per_gb: t.per_gb || 0, per_modem: t.per_modem || 0 }; });
  var fc = (d.summary && typeof d.summary.forecast_eom === 'number') ? d.summary.forecast_eom : 0;
  var fcOn = false, fcRestGb = 0, fcRestPm = 0;
  if (fc > 0 && trend.length) {
    var last = trend[trend.length - 1];
    var lastTotal = last.per_gb + last.per_modem;
    if (fc > lastTotal) {
      var ratio = lastTotal > 0 ? (last.per_gb / lastTotal) : 1;
      var fcGb = Math.round(fc * ratio);
      var fcPm = fc - fcGb;
      fcRestGb = Math.max(0, fcGb - last.per_gb);
      fcRestPm = Math.max(0, fcPm - last.per_modem);
      fcOn = true;
    }
  }
  if(lg) lg.innerHTML = [['За ГБ','#2f6fe0'],['За модем','#10b981']].map(function(x){
    return '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:'+x[1]+'"></span>'+x[0]+'</span>';
  }).join('') + (fcOn ? '<span style="display:inline-flex;align-items:center;gap:5px" title="Прогноз текущего месяца"><span style="width:8px;height:8px;border-radius:50%;background:rgba(47,111,224,.35);border:1px dashed #2f6fe0"></span>прогноз</span>' : '');
  var cv = document.getElementById('newFinTrendCanvas');
  if(!cv || !window.Chart) return;
  if(window._newFinTrendChart){ try{window._newFinTrendChart.destroy();}catch(_){} window._newFinTrendChart=null; }
  // Тонкие столбцы под узкую карточку ряда «Требует внимания» (маленький maxBarThickness),
  // остальная геометрия — из общего CHART_BAR_STACK. Скругление: плоский низ, круглый верх.
  var barOpts = Object.assign({stack:'a', borderRadius:chartStackRadius()}, CHART_BAR_STACK, {maxBarThickness:22});
  var n = trend.length;
  var fcGbSeries = trend.map(function(_,i){ return (fcOn && i === n - 1) ? fcRestGb : 0; });
  var fcPmSeries = trend.map(function(_,i){ return (fcOn && i === n - 1) ? fcRestPm : 0; });
  window._newFinTrendChart = newChartSafe(cv, {
    type:'bar',
    data:{ labels:trend.map(function(t){return _ymRu(t.month,true);}),
      datasets:[
        Object.assign({label:'За ГБ', data:trend.map(function(t){return t.per_gb;}), backgroundColor:'#2f6fe0'}, barOpts),
        Object.assign({label:'За модем', data:trend.map(function(t){return t.per_modem;}), backgroundColor:'#10b981'}, barOpts),
        Object.assign({label:'Прогноз ГБ', data:fcGbSeries, backgroundColor:'rgba(47,111,224,.35)'}, barOpts),
        Object.assign({label:'Прогноз модем', data:fcPmSeries, backgroundColor:'rgba(16,185,129,.35)'}, barOpts)
      ]},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{mode:'index',intersect:false,
          callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
            title:function(items){var base=items&&items.length?items[0].label:'';return (fcOn&&items.length&&items[0].dataIndex===n-1)?base+' (факт + прогноз)':base;},
            footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
      scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9},maxRotation:0,minRotation:0,autoSkip:false},grid:{display:false},border:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9},callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:cc.grid,drawTicks:false},border:{display:false}}}}
  });
}
// «Выручка за 30 дней» + «Последние платежи» — в блоке Финансов на месте бывшего MRR.
function renderFinRevenue(d){
  var el = document.getElementById('newFinRevenue'); if(!el) return;
  var dr = d.daily_revenue || [], dates = dr.map(function(r){return r.date;});
  var byClient = d.daily_revenue_by_client || {};
  // Топ-клиенты по суммарной выручке за окно, остальные — «Прочие».
  var names = Object.keys(byClient).sort(function(a,b){
    var sa=dates.reduce(function(s,dt){return s+(byClient[a][dt]||0);},0), sb=dates.reduce(function(s,dt){return s+(byClient[b][dt]||0);},0);
    return sb-sa;
  });
  var MAXG=6, top=names.slice(0,MAXG), rest=names.slice(MAXG), palette=getChartPaletteLight();
  var h = '<div class="fin-card-head"><div class="fin-card-heading"><h3 class="fin-card-title">Выручка за 30 дней</h3>'
    +'<span class="fin-card-subtitle">Динамика поступлений с разбивкой по клиентам</span></div></div>';
  h += '<div class="fin-revenue-chart"><canvas id="newFinRevCanvas"></canvas></div>';
  h += '<section class="fin-recent-block"><div class="fin-subhead"><span class="fin-subhead-title"><span class="fin-subhead-icon">'+icon('plus',14)+'</span>Последние пополнения</span>'
    +'<button type="button" class="fin-link" data-on-click="finNavBank()">Все платежи <span class="fin-link-arrow">→</span></button></div>';
  // Только ПОПОЛНЕНИЯ (положительные), последние 5 — как на странице «Финансы».
  var rp = (d.recent_payments || []).filter(function(p){return p.amount >= 0;}).slice(0, 5);
  if(!rp.length) h += '<div class="fin-empty">Пополнений пока нет.</div>';
  else {
    h += '<div class="fin-payment-list">';
    rp.forEach(function(p){
      var sub = esc((p.date||'').slice(5)) + (p.source?' · '+esc(p.source):'');
      h += '<div class="fin-payment-row"><span class="fin-payment-icon">'+icon('money',14)+'</span><span class="fin-payment-copy">'
        +'<span class="fin-payment-client">'+esc(p.client)+'</span><span class="fin-payment-meta">'+sub+'</span></span>'
        +'<span class="fin-payment-amount">+'+Math.abs(Math.round(p.amount)).toLocaleString('ru-RU')+' ₽</span></div>';
    });
    h += '</div>';
  }
  h += '</section>';
  el.innerHTML = h;
  setTimeout(function(){
    var cv = document.getElementById('newFinRevCanvas'); if(!cv || !window.Chart) return;
    if(window._newFinRevChart){ try{window._newFinRevChart.destroy();}catch(_){} }
    var cc = getChartColorsLight();
    var finBarOpts=Object.assign({},CHART_BAR_STACK,{maxBarThickness:28,barPercentage:.64,categoryPercentage:.82});
    var datasets=top.map(function(nm,i){ return Object.assign({label:nm, data:dates.map(function(dt){return (byClient[nm][dt]||0);}), backgroundColor:palette[i%palette.length], stack:'r', borderRadius:chartStackRadius()}, finBarOpts); });
    if(rest.length) datasets.push(Object.assign({label:'Прочие', data:dates.map(function(dt){return rest.reduce(function(s,nm){return s+(byClient[nm][dt]||0);},0);}), backgroundColor:'#cbd5e1', stack:'r', borderRadius:chartStackRadius()}, finBarOpts));
    // fallback: если разбивки нет — единый ряд из daily_revenue
    if(!datasets.length) datasets=[Object.assign({label:'Выручка', data:dr.map(function(r){return r.revenue;}), backgroundColor:'#2f6fe0', stack:'r', borderRadius:chartStackRadius()}, finBarOpts)];
    window._newFinRevChart = newChartSafe(cv, {
      type:'bar',
      data:{ labels:dates.map(function(dt){return (dt||'').slice(5);}), datasets:datasets },
      options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},
        layout:{padding:{top:2}},
        plugins:{legend:{display:false},
          tooltip:{mode:'index',intersect:false,itemSort:function(a,b){return b.parsed.y-a.parsed.y;},
            callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y||0).toLocaleString('ru-RU')+' ₽';},
              footer:function(items){var t=0;items.forEach(function(i){t+=i.parsed.y||0;});return 'Итого: '+t.toLocaleString('ru-RU')+' ₽';}}}},
        scales:{x:{stacked:true,ticks:{color:cc.text,font:{size:9.5},maxRotation:0,autoSkip:true,maxTicksLimit:10,padding:6},grid:{display:false},border:{display:false}},
          y:{stacked:true,beginAtZero:true,ticks:{color:cc.text,font:{size:9.5},padding:6,callback:function(v){return v>=1000?(v/1000).toFixed(0)+'k':v;}},grid:{color:'rgba(47,63,85,.065)',drawTicks:false},border:{display:false}}}}
    });
  }, 30);
}
