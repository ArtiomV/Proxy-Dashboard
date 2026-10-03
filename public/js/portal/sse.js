// ========== SSE (03.10): realtime-канал клиентского кабинета ==========
// EventSource к /api/client/events — scoped-события этого клиента:
//   modem_status {nick,server,up} — модем ушёл/вернулся;
//   ip_changed  {nick,server,ip}  — сменился внешний IP;
//   balance     {balance,...}     — списание/зачисление.
// Точечные обновления tableData + перерисовка текущей вкладки; часовой
// loadData() остаётся страховочным контуром. SSE недоступен/выключен —
// поведение как раньше (только polling).
(function(){
  var es=null,_fails=0,_dead=false,_reconnectT=null,_backoff=3000;

  function _row(nick){
    if(typeof tableData==='undefined'||!tableData)return null;
    for(var i=0;i<tableData.length;i++)if(tableData[i].modemNick===nick)return tableData[i];
    return null;
  }
  function _rerenderCurrent(){
    // перерисовываем только активную вкладку — дёшево и без скачков
    try{
      if(document.getElementById('tab-traffic')&&document.getElementById('tab-traffic').classList.contains('active')&&typeof renderProxies==='function')renderProxies();
      else if(document.getElementById('tab-overview')&&document.getElementById('tab-overview').classList.contains('active')&&typeof renderOverview==='function')renderOverview();
      else if(document.getElementById('tab-billing')&&document.getElementById('tab-billing').classList.contains('active')&&typeof renderBalance==='function')renderBalance();
    }catch(_){/* best-effort */}
  }

  function _onModemStatus(d){
    var r=_row(d.nick);if(!r)return;
    r.online=d.up?'yes':'no';if(d.up)delete r._offline;
    _rerenderCurrent();
  }
  function _onIpChanged(d){
    var r=_row(d.nick);if(!r)return;
    r.extIp=d.ip;
    _rerenderCurrent();
    // открытая карточка этого прокси — перерисуем её
    try{if(typeof cdState!=='undefined'&&cdState&&cdState.pid&&r.portId===cdState.pid&&typeof _cdRender==='function')_cdRender();}catch(_){/* best-effort */}
  }
  function _onBalance(d){
    try{
      if(typeof billingData!=='undefined'&&billingData){billingData.balance=d.balance}
      _rerenderCurrent();
    }catch(_){/* best-effort */}
  }

  function _connect(){
    if(_dead)return;
    if(typeof authToken==='undefined'||!authToken)return;
    if(typeof EventSource==='undefined'){_dead=true;return;}
    try{es=new EventSource('/api/client/events?token='+encodeURIComponent(authToken));}
    catch(_){_dead=true;return;}

    es.onopen=function(){_fails=0;_backoff=3000;};
    es.onerror=function(){
      _fails++;
      // 503 (sse_enabled=false) или устойчивый отказ → прекращаем попытки,
      // остаётся штатный часовой polling.
      if(_fails>=3){_dead=true;try{es.close()}catch(_){/* best-effort */}es=null;}
    };
    // pm2 restart: сервер шлёт bye перед закрытием — переподключаемся сами
    // с backoff (нативный retry EventSource может не дождаться подъёма pm2).
    es.addEventListener('bye',function(){
      try{es.close()}catch(_){/* best-effort */}es=null;
      if(_dead)return;
      if(_reconnectT)clearTimeout(_reconnectT);
      _reconnectT=setTimeout(function(){_backoff=Math.min(_backoff*2,30000);_connect()},_backoff);
    });
    es.addEventListener('modem_status',function(e){try{_onModemStatus(JSON.parse(e.data))}catch(_){/* best-effort */}});
    es.addEventListener('ip_changed',function(e){try{_onIpChanged(JSON.parse(e.data))}catch(_){/* best-effort */}});
    es.addEventListener('balance',function(e){try{_onBalance(JSON.parse(e.data))}catch(_){/* best-effort */}});
  }

  // Старт после логина: ждём появления токена (страница грузится и без него).
  var _waitT=setInterval(function(){
    if(typeof authToken!=='undefined'&&authToken){clearInterval(_waitT);_connect();}
  },2000);
  setTimeout(function(){clearInterval(_waitT)},60000);
})();
