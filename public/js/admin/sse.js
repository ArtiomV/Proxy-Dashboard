// ========== SSE (23.08): realtime-канал админки ==========
// EventSource к /api/admin/events. По событиям — точечные рефетчи блоков
// (НЕ полная перезагрузка: loadData уже сохраняет скролл/фильтры/пароли).
// SSE недоступен/выключен → остаётся штатный polling 60 сек (запасной контур).
// При живом SSE polling урежен до 5 мин — страховка от пропущенного события.
(function(){
  var es=null,_fails=0,_dead=false,_reconnectT=null,_backoff=3000;
  var _debT=null;

  function _ind(state){
    var el=document.getElementById('sseIndicator');
    if(!el)return;
    if(state==='live'){el.style.display='';el.className='sse-ind sse-live';el.title='Realtime-обновления активны';el.innerHTML='<span class="sse-dot"></span>live';}
    else if(state==='offline'){el.style.display='';el.className='sse-ind sse-offline';el.title='Realtime-канал недоступен — работает обновление по таймеру';el.innerHTML='<span class="sse-dot"></span>offline';}
    else{el.style.display='none';}
  }

  function _setPolling(ms){
    if(typeof setPollingInterval==='function')setPollingInterval(ms);
  }

  // Дебаунсированный loadData для «шумных» событий модемов: цикл tracking
  // (3 мин) может прислать несколько типов подряд — схлопываем в один рефетч.
  function _debouncedLoad(){
    if(_debT)clearTimeout(_debT);
    _debT=setTimeout(function(){_debT=null;try{loadData()}catch(_){/* best-effort */}},2000);
  }

  function _onEvent(type){
    return function(){
      if(type==='alert'){
        try{refreshNotifBadge()}catch(_){/* best-effort */}
        try{var p=document.getElementById('notifPanel');if(p&&p.style.display!=='none'&&p.style.display!=='')refreshNotifPanel()}catch(_){/* best-effort */}
        return;
      }
      if(type==='metrics_update'){try{loadServerMetrics()}catch(_){/* best-effort */}return;}
      // fleet_update / ping_result / modem_rate / httpcheck_result
      _debouncedLoad();
    };
  }

  function _connect(){
    if(_dead)return;
    if(typeof authToken==='undefined'||!authToken)return;
    if(typeof EventSource==='undefined'){_dead=true;_ind('offline');return;}
    try{es=new EventSource(API+'/api/admin/events?token='+encodeURIComponent(authToken));}
    catch(_){_dead=true;_ind('offline');return;}

    es.onopen=function(){
      _fails=0;_backoff=3000;_ind('live');
      _setPolling(300000);   // SSE жив — polling страховочный, раз в 5 мин
    };
    es.onerror=function(){
      _fails++;_ind('offline');_setPolling(60000);
      // 503 (sse_enabled=false) или устойчивый отказ → прекращаем попытки,
      // поведение как раньше (polling). Нативный reconnect EventSource при этом
      // останавливаем явно, чтобы не ддосить недоступный эндпоинт.
      if(_fails>=3){_dead=true;try{es.close()}catch(_){};es=null;}
    };
    // pm2 restart: сервер шлёт bye перед закрытием — переподключаемся сами
    // с backoff (нативный retry EventSource может не дождаться подъёма pm2).
    es.addEventListener('bye',function(){
      try{es.close()}catch(_){/* best-effort */}es=null;
      if(_dead)return;
      if(_reconnectT)clearTimeout(_reconnectT);
      _reconnectT=setTimeout(function(){_backoff=Math.min(_backoff*2,30000);_connect()},_backoff);
    });
    ['alert','metrics_update','fleet_update','ping_result','modem_rate','httpcheck_result']
      .forEach(function(t){es.addEventListener(t,_onEvent(t))});
  }

  // Старт после логина: ждём появления токена (страница грузится и без него).
  var _waitT=setInterval(function(){
    if(typeof authToken!=='undefined'&&authToken){clearInterval(_waitT);_connect();}
  },2000);
  setTimeout(function(){clearInterval(_waitT)},60000);
})();
