/**
 * Shared utility functions for admin and client dashboards.
 * Loaded BEFORE inline / page-specific scripts via <script src="/js/utils.js">.
 *
 * UNIT SEMANTICS — DECIMAL (SI), matches backend src/utils/traffic.js:
 *   1 KB = 1e3 bytes
 *   1 MB = 1e6 bytes
 *   1 GB = 1e9 bytes
 *   1 TB = 1e12 bytes
 * The backend uses these decimal multipliers for billing math
 * (trafficBytesToGb(1e9) === 1, locked by tests/billing-atomic.test.js).
 * The admin SPA already used decimal here, the client SPA used to use
 * binary (1024) — Stage 7 unified both to decimal so the same byte value
 * renders identically on /admin and /client.
 */

// HTML escape
function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}

// Date formatting
function fmtDateRu(d){if(!d)return'';var p=d.split('-');return p.length===3?(p[2]+'.'+p[1]+'.'+p[0]):d}

// Traffic parsing/formatting — DECIMAL (matches src/utils/traffic.js).
function parseTraffic(v){if(!v||v===0)return 0;if(typeof v==='number')return v;var s=String(v).slice(0,30),m=s.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);if(!m)return parseFloat(s)||0;var n=parseFloat(m[1]),u=m[2].toUpperCase();return n*(u==='KB'?1e3:u==='MB'?1e6:u==='GB'?1e9:u==='TB'?1e12:1)}
function bytesToGb(b){return b/1e9}
function fmtGb(b){if(!b||b===0||isNaN(b))return'0 Б';if(b<1e6)return(b/1e3).toFixed(1)+' КБ';if(b<1e9)return(b/1e6).toFixed(1)+' МБ';var gb=b/1e9;if(gb>=1000)return(gb/1000).toFixed(1)+' ТБ';if(gb>=100)return Math.round(gb)+' ГБ';return gb.toFixed(1)+' ГБ'}
function fmtGbShort(b){if(!b||isNaN(b)||b<1e9)return((b||0)/1e6).toFixed(0)+' МБ';return(b/1e9).toFixed(1)+' ГБ'}
function pct(v,max){return max?Math.round(v/max*100):0}

// Format bytes with auto-unit (used by client portal) — decimal.
function formatBytes(b){if(!b||b===0)return'0 B';if(b<1e3)return b+' B';if(b<1e6)return(b/1e3).toFixed(1)+' KB';if(b<1e9)return(b/1e6).toFixed(1)+' MB';var gb=b/1e9;if(gb>=1000)return(gb/1000).toFixed(2)+' TB';return gb.toFixed(1)+' GB'}

// Modem helpers.
// _cached / _serverDown flags are admin-side annotations injected on stale
// data — checking them here is a no-op on client.js modems (fields absent
// in the client API response) and keeps admin behavior intact.
function getModemStatus(m){if(m._cached||m._serverDown)return'offline';if(m.isRebooting)return'rebooting';if(m.isRotating)return'rotating';if(m.isOnline)return'online';if(m.connectionStatus&&m.connectionStatus.includes('connected'))return'online';if(m.state==='added'&&m.extIp&&m.extIp!=='IP_RESET')return'online';if(m.extIp==='IP_RESET')return'rotating';return'offline'}
function formatUptime(s){if(!s||s<=0)return'-';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60);if(d>0)return d+'д '+h+'ч';if(h>0)return h+'ч '+mm+'м';return mm+'м'}
function formatTraffic(v){if(!v||v===0||v==='0')return'-';return String(v)}
function renderSignalBars(s){var h='<div class="signal-bars">';for(var i=1;i<=5;i++){h+='<div class="signal-bar'+(i<=s?' active':'')+'" style="height:'+(2+i*2)+'px"></div>'}return h+'</div>'}
function renderNetBadge(t){if(!t)return'<span class="net-badge net-unknown">?</span>';var c='net-unknown',l=t;if(/lte|4g/i.test(t)){c='net-lte';l='LTE'}else if(/3g|hspa|umts/i.test(t)){c='net-3g';l='3G'}else if(/2g|edge|gprs/i.test(t)){c='net-2g';l='2G'}return'<span class="net-badge '+c+'">'+l+'</span>'}

// Chart colors helper
function getChartColors(){var d=document.documentElement.dataset.theme==='dark';return{grid:d?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)',text:d?'#8892a6':'#6b7280',bg:d?'#131720':'#ffffff'}}
function getChartColorsLight(){return{grid:'rgba(0,0,0,.07)',text:'#6b7280',bg:'#ffffff'}}
// Категориальная палитра для графиков на светлых страницах (Дашборд/Финансы)
function getChartPaletteLight(){return['#2f6fe0','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16','#0ea5e9','#e11d48','#a855f7']}

// ЕДИНЫЙ стиль всех столбчатых графиков — берётся из ОДНОГО места, чтобы MRR,
// «Потребление по дням» (по клиентам и по странам) и «Выручка по дням» выглядели
// одинаково. Геометрия столбца:
var CHART_BAR_STACK = { borderSkipped:false, borderWidth:0, maxBarThickness:42, barPercentage:0.6, categoryPercentage:0.8 };
// Столбец ПЛОСКИЙ снизу и СКРУГЛЁННЫЙ сверху: скругляем только верх самого
// верхнего непустого сегмента стека, всё остальное (включая низ) — плоское.
// Универсально для любого числа датасетов, учитывает скрытые ряды. ds[0] = низ стека.
function chartStackRadius(r){
  r = r || 4;
  return function(ctx){
    var i = ctx.dataIndex, ch = ctx.chart, ds = ch.data.datasets, di = ctx.datasetIndex;
    var last = -1;
    for (var k = 0; k < ds.length; k++){
      if (typeof ch.isDatasetVisible === 'function' && !ch.isDatasetVisible(k)) continue;
      var v = Number((ds[k].data || [])[i]) || 0;
      if (v) last = k;   // самый верхний непустой сегмент
    }
    if (di !== last) return 0;   // не верхушка стека — плоский
    return { topLeft: r, topRight: r, bottomLeft: 0, bottomRight: 0 };   // верх скруглён, низ плоский
  };
}

// Toast notification — escapes the message body to avoid XSS via
// admin-injected text. (The admin.js copy of this function did NOT
// escape — that was a latent XSS path closed by the dedup.)
function showToast(m,t,dur){
  var c=document.getElementById('toastContainer');if(!c)return;
  var tp=t||'info';var icons={success:'✓',error:'✕',warning:'!',info:'i'};
  var ms=dur||(tp==='error'?6000:4000);
  var e=document.createElement('div');e.className='toast toast-'+tp;
  e.innerHTML='<span class="toast-icon">'+icons[tp]+'</span><span class="toast-text">'+esc(m)+'</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
  c.appendChild(e);
  setTimeout(function(){if(e.parentNode)e.remove();},ms);
}

// CommonJS export so the same source can be unit-tested in Node without a DOM.
// Browsers see the `if (typeof module !== 'undefined')` guard as false and
// continue with the bare function declarations above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    esc, fmtDateRu, parseTraffic, bytesToGb, fmtGb, fmtGbShort, pct,
    formatBytes, getModemStatus, formatUptime, formatTraffic,
    renderSignalBars, renderNetBadge,
  };
}
