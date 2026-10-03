// public/js/portal/api.js — 3h «API»: ключ (маска; полный — один раз после
// перевыпуска), основные методы, примеры cURL / Python / JavaScript.
// Перевыпуск — POST /api/client/api_key/regenerate (прежний ключ живёт ещё 24 ч).

var _apiFresh='';     // полный ключ, выданный в этой сессии
var _apiLang='curl';

// Хелперы для полной документации (api-docs-data.js, классы api-*).
// copyText уже определён глобально в client.js.
var apiBase=window.location.origin;
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
function renderApiPage(){
  var info=(billingData&&billingData.apiKeyInfo)||{};
  var key=_apiFresh||(info.prefix?info.prefix+'••••••••':(billingData&&billingData.apiKey)||'');
  var shown=_apiFresh||'ВАШ_API_КЛЮЧ';
  var base=window.location.origin;
  var h='<div class="v3-card mb12"><h3 style="margin-bottom:6px">Ваш API-ключ</h3>'+
    '<p class="v3-p" style="max-width:78ch">Передавайте его заголовком <span class="v3-code">X-API-Key</span> или параметром <span class="v3-code">?apiKey=</span>. При перевыпуске старый ключ работает ещё 24 часа.</p>'+
    '<div class="v3-keyline"><span>'+V3.esc(key||'Ключ ещё не выпущен')+'</span>'+
      (_apiFresh?'<button type="button" class="v3-btn solid-sm" data-on-click="apiCopyKey()">Копировать</button>':(key?'<span class="v3-note" style="white-space:nowrap">полный ключ показывается один раз</span>':'<button type="button" class="v3-btn solid-sm" data-on-click="apiRegenerate()">Выпустить</button>'))+'</div>';
  if(_apiFresh)h+='<div class="v3-banner warn" style="margin:10px 0 0">Сохраните ключ сейчас — после обновления страницы будет видна только маска.</div>';
  if(info.prefix)h+='<div class="v3-note" style="margin-top:8px">Выдан '+V3.esc(info.createdAt?V3.dt(info.createdAt,true):'—')+' · последнее использование '+V3.esc(info.lastUsedAt?V3.dt(info.lastUsedAt,true):'—')+' · запросов за 24 ч: '+(info.requests24h||0)+'</div>';
  if(info.prevExpiresAt)h+='<div class="v3-banner warn" style="margin:10px 0 0">Идёт ротация: прежний ключ перестанет работать '+V3.esc(V3.dt(info.prevExpiresAt,true))+'. Обновите ключ в интеграциях.</div>';
  h+='</div>';
  var eps=[
    ['GET','Получить прокси','/api/v1/proxy','Все ваши прокси с реквизитами, ссылками смены IP и балансом одним запросом.'],
    ['GET','Список прокси','/api/v1/proxies','Короткий список без биллинга — удобно для автоматической подстановки в софт. Формат: ?format=json | txt | csv.'],
    ['GET','Сменить IP','change_ip_url из ответа','Ссылка уникальна для каждого прокси. Не чаще одного раза в 30 секунд на модем.'],
    ['GET','Экспорт реквизитов','/api/v1/proxies?format=txt','Готовые строки ip:port:login:pass|ссылка — тот же список, что выгружает «Экспорт прокси».']
  ];
  h+='<div class="v3-grid2">'+eps.map(function(e){
    return '<div class="v3-card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span class="v3-ep-m">'+e[0]+'</span><span style="font-size:13px;font-weight:600;color:var(--v3-ink)">'+e[1]+'</span></div><div class="v3-ep-path">'+V3.esc(e[2])+'</div><div style="font-size:12px;color:var(--v3-muted);line-height:1.55">'+e[3]+'</div></div>';
  }).join('')+'</div>';
  var code={
    curl:'curl -H "X-API-Key: '+shown+'" \\\n     '+base+'/api/v1/proxy',
    python:'import requests\n\nr = requests.get(\n    "'+base+'/api/v1/proxy",\n    headers={"X-API-Key": "'+shown+'"},\n    timeout=30,\n)\ndata = r.json()\nfor p in data.get("proxies", []):\n    print(p)',
    js:"const res = await fetch('"+base+"/api/v1/proxy', {\n  headers: { 'X-API-Key': '"+shown+"' },\n});\nconst data = await res.json();\nconsole.log(data.proxies);"
  };
  h+='<div class="v3-card"><div class="v3-codetabs">'+[['curl','cURL'],['python','Python'],['js','JavaScript']].map(function(l){return '<button type="button" class="'+(_apiLang===l[0]?'on':'')+'" data-on-click="apiLang(\''+l[0]+'\')">'+l[1]+'</button>'}).join('')+
    '<button type="button" style="margin-left:auto;color:var(--v3-accent)" data-on-click="apiCopyCode()">Копировать</button></div><pre class="v3-codepre" id="apiCode">'+V3.esc(code[_apiLang])+'</pre></div>';
  if(typeof API_DOCS_HTML!=='undefined')h+=API_DOCS_HTML;
  document.getElementById('apiBody').innerHTML=h;
}
function apiLang(l){_apiLang=l;renderApiPage()}
function apiCopyCode(){var el=document.getElementById('apiCode');if(el)V3.copy(el.textContent,'Пример скопирован')}
function apiCopyKey(){if(_apiFresh)V3.copy(_apiFresh,'API-ключ скопирован')}
function apiRegenerate(){
  var info=(billingData&&billingData.apiKeyInfo)||{};
  V3.confirm({title:'Перевыпустить API-ключ?',text:'Старый ключ будет работать ещё 24 часа, затем перестанет. Обновите его во всех скриптах.',detail:info.prefix?info.prefix+'••••••••':'',cta:'Перевыпустить'}).then(function(ok){
    if(!ok)return;
    api('/api/client/api_key/regenerate',{method:'POST'}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось перевыпустить ключ');
      _apiFresh=d.apiKey;renderApiPage();
      V3.toast({title:'Ключ перевыпущен — сохраните его',action:'Копировать',onAction:apiCopyKey});
      loadData().then(function(){if(document.getElementById('tab-api').classList.contains('active'))renderApiPage()});
    }).catch(function(e){V3.toast({kind:'err',title:e.message})});
  });
}
