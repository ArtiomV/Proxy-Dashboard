/**
 * Shared utility functions for admin and client dashboards
 * Loaded before inline scripts via <script src="/js/utils.js">
 */

// HTML escape
function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}

// Date formatting
function fmtDateRu(d){if(!d)return'';var p=d.split('-');return p.length===3?(p[2]+'.'+p[1]+'.'+p[0]):d}

// Traffic parsing/formatting
function parseTraffic(v){if(!v||v===0)return 0;if(typeof v==='number')return v;var s=String(v).slice(0,30),m=s.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);if(!m)return parseFloat(s)||0;var n=parseFloat(m[1]),u=m[2].toUpperCase();return n*(u==='KB'?1024:u==='MB'?1048576:u==='GB'?1073741824:u==='TB'?1099511627776:1)}
function bytesToGb(b){return b/1073741824}
function fmtGb(b){if(!b||b===0)return'0 B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';var gb=b/1073741824;if(gb>=1000)return(gb/1024).toFixed(1)+' TB';if(gb>=100)return Math.round(gb)+' GB';return gb.toFixed(1)+' GB'}
function fmtGbShort(b){if(b<1073741824)return(b/1048576).toFixed(0)+' MB';return(b/1073741824).toFixed(1)+' GB'}
function pct(v,max){return max?Math.round(v/max*100):0}

// Format bytes with auto-unit (for client portal)
function formatBytes(b){if(!b||b===0)return'0 B';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';var gb=b/1073741824;if(gb>=1024)return(gb/1024).toFixed(2)+' TB';return gb.toFixed(1)+' GB'}

// Modem helpers
function getModemStatus(m){if(m.isRebooting)return'rebooting';if(m.isRotating)return'rotating';if(m.isOnline)return'online';if(m.connectionStatus&&m.connectionStatus.includes('connected'))return'online';if(m.state==='added'&&m.extIp&&m.extIp!=='IP_RESET')return'online';return'offline'}
function formatUptime(s){if(!s||s<=0)return'-';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),mm=Math.floor(s%3600/60);if(d>0)return d+'д '+h+'ч';if(h>0)return h+'ч '+mm+'м';return mm+'м'}
function formatTraffic(v){if(!v||v===0||v==='0')return'-';return String(v)}
function renderSignalBars(s){var h='<div class="signal-bars">';for(var i=1;i<=5;i++){h+='<div class="signal-bar'+(i<=s?' active':'')+'" style="height:'+(2+i*2)+'px"></div>'}return h+'</div>'}
function renderNetBadge(t){if(!t)return'<span class="net-badge net-unknown">?</span>';var c='net-unknown',l=t;if(/lte|4g/i.test(t)){c='net-lte';l='LTE'}else if(/3g|hspa|umts/i.test(t)){c='net-3g';l='3G'}else if(/2g|edge|gprs/i.test(t)){c='net-2g';l='2G'}return'<span class="net-badge '+c+'">'+l+'</span>'}

// Chart colors helper
function getChartColors(){var d=document.documentElement.dataset.theme==='dark';return{grid:d?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)',text:d?'#8892a6':'#6b7280',bg:d?'#131720':'#ffffff'}}

// Toast notification
function showToast(m,t,dur){
  var c=document.getElementById('toastContainer');if(!c)return;
  var tp=t||'info';var icons={success:'✓',error:'✕',warning:'!',info:'i'};
  var ms=dur||(tp==='error'?6000:4000);
  var e=document.createElement('div');e.className='toast toast-'+tp;
  e.innerHTML='<span class="toast-icon">'+icons[tp]+'</span><span class="toast-text">'+m+'</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
  c.appendChild(e);
  setTimeout(function(){if(e.parentNode)e.remove();},ms);
}
