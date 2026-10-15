'use strict';
// public/js/portal/shop.js — магазин и онбординг розницы (2026-10-15, переработан).
//
// 1) «Как вы будете работать?» — при первом входе самостоятельно
//    зарегистрированного клиента: физлицо или юрлицо/ИП (анкета реквизитов →
//    договор по ЭДО, руководитель получает задачу). Реквизиты можно менять до
//    подписания договора — из профиля (onbOpenLegal). API: /api/client/onboarding.
// 2) «Купить прокси» — баланс сверху; Европа: страна → количество → итог с
//    балансом «после покупки» (POST /api/client/buy_proxies, ступень цены по
//    общему числу прокси); Россия: заявка менеджеру (POST /api/client/proxy_orders).
//    Справочник — GET /api/client/shop_catalog.

// ================= онбординг =================
var _onb={asked:false,modal:null,data:null};
function v3OnbStart(){
  if(_onb.asked)return;_onb.asked=true;
  api('/api/client/onboarding').then(function(d){if(d&&d.needsChoice){_onb.data=d;_onbChoice()}}).catch(function(){});
}
function _onbChoice(){
  _onb.modal=V3.modal(
    '<div class="v3-mh"><h3>Как вы будете работать с нами?</h3></div>'+
    '<div class="v3-mb"><p class="v3-p" style="margin:0 0 12px;font-size:12.5px;color:var(--v3-muted)">От этого зависят документы и способ оплаты. Выбор можно изменить позже в профиле — до подписания договора.</p>'+
    '<div class="v3-opts" style="display:grid;gap:10px">'+
      '<button type="button" class="v3-fmt" data-on-click="onbPick(\'individual\')"><div class="h"><span class="lb">Физическое лицо</span></div><div class="d">Оплата картой или СБП, документы не нужны. Можно сразу покупать прокси.</div></button>'+
      '<button type="button" class="v3-fmt" data-on-click="onbPick(\'legal\')"><div class="h"><span class="lb">Юридическое лицо или ИП</span></div><div class="d">Работа по договору: заполните реквизиты — мы подготовим договор, отправим его по ЭДО и свяжемся с вами. Оплата по счёту, закрывающие документы каждый месяц.</div></button>'+
    '</div></div>',
    {width:'w460',sticky:true});
}
function onbPick(kind){
  if(kind==='individual'){
    api('/api/client/onboarding',{method:'POST',json:{entity_type:'individual'}}).then(function(d){
      if(d&&d.ok){if(_onb.modal)V3.closeModal(_onb.modal);V3.toast({title:'Готово',text:'Вы работаете как физическое лицо'});if(typeof renderProfile==='function')_profRefreshSoon()}
      else V3.toast({kind:'err',title:(d&&d.error)||'Не удалось сохранить'});
    }).catch(function(){V3.toast({kind:'err',title:'Ошибка соединения'})});
    return;
  }
  onbOpenLegal();
}
function _profRefreshSoon(){setTimeout(function(){if(document.getElementById('profBody')&&typeof renderProfile==='function')renderProfile()},200)}
var ONB_FIELDS=[
  ['legal_name','Название организации или ИП','ООО «Ромашка»',1],
  ['inn','ИНН','10 или 12 цифр',0],['kpp','КПП','9 цифр (у ИП не нужен)',0],
  ['ogrn','ОГРН / ОГРНИП (необязательно)','13 или 15 цифр',0],['legal_address','Юридический адрес','',1],
  ['postal_address','Почтовый адрес (если отличается)','',1],
  ['signer_name','ФИО подписанта','Иванов Иван Иванович',0],['signer_position','Должность подписанта','Генеральный директор',0],
  ['signer_basis','Действует на основании','Устава',0],['bank_name','Банк','',0],
  ['bik','БИК','9 цифр',0],['account','Расчётный счёт','20 цифр',0],['corr_account','Корреспондентский счёт (необязательно)','20 цифр',0],
  ['contact_name','Контактное лицо','',0],['contact_phone','Телефон','+7… (телефон или email)',0],['contact_email','Email','или телефон',0],
  ['edo_operator','Оператор ЭДО (если есть)','Диадок, СБИС, Контур…',0],['edo_id','ID участника ЭДО (если есть)','',0]
];
// Открывает форму реквизитов с подстановкой уже сохранённого; вызывается и из профиля.
function onbOpenLegal(){
  api('/api/client/onboarding').then(function(d){
    d=d||{};_onb.data=d;
    if(d.locked){V3.toast({kind:'warn',title:'Договор подписан',text:'Реквизиты после подписания меняет менеджер — нажмите «Связаться с нами».'});return}
    _onbLegalForm(d.requisites||{});
  }).catch(function(){_onbLegalForm({})});
}
function _onbLegalForm(pre){
  pre=pre||{};
  var editing=!!(_onb.data&&_onb.data.entityType==='legal'&&_onb.data.requisites&&_onb.data.requisites.inn);
  var h='<div class="v3-mh"><h3>Реквизиты для договора</h3><button class="v3-x" type="button" data-on-click="v3CloseModal()" aria-label="Закрыть">×</button></div>'+
    '<div class="v3-mb" style="max-height:62vh;overflow:auto"><p class="v3-p" style="margin:0 0 12px;font-size:12px;color:var(--v3-muted)">'+(editing?'Можно менять до подписания договора — после изменения мы подготовим договор заново. ':'По этим данным мы подготовим договор и отправим его по ЭДО. ')+'Поля с пометкой «необязательно» или «если есть» можно оставить пустыми; КПП не нужен для ИП.</p>'+
    '<div class="v3-grid2" style="margin-bottom:0">';
  ONB_FIELDS.forEach(function(f){
    h+='<div class="v3-field"'+(f[3]?' style="grid-column:1 / -1"':'')+'><span class="v3-label">'+V3.esc(f[1])+'</span><input class="v3-input" id="onb_'+f[0]+'" placeholder="'+V3.esc(f[2])+'" autocomplete="off" value="'+V3.esc(pre[f[0]]||'')+'"></div>';
  });
  h+='</div><div id="onbErr" class="v3-note" style="color:var(--v3-red);margin-top:10px"></div></div>'+
    '<div class="v3-mf"><button class="v3-btn" type="button" data-on-click="v3CloseModal()">Позже</button><button class="v3-btn primary" type="button" id="onbSend" data-on-click="onbSendLegal()">'+(editing?'Сохранить реквизиты':'Отправить реквизиты')+'</button></div>';
  if(_onb.modal)V3.closeModal(_onb.modal);
  _onb.modal=V3.modal(h,{width:'w560',onClose:function(){_onb.asked=false}});
  var pos=document.getElementById('onb_signer_position');if(pos&&!pos.value)pos.value='Генеральный директор';
  var bas=document.getElementById('onb_signer_basis');if(bas&&!bas.value)bas.value='Устава';
}
function onbSendLegal(){
  var q={};
  ONB_FIELDS.forEach(function(f){var el=document.getElementById('onb_'+f[0]);el.classList.remove('bad');q[f[0]]=el.value.trim()});
  ['inn','kpp','ogrn','bik','account','corr_account'].forEach(function(k){q[k]=q[k].replace(/\s+/g,'')});
  var btn=document.getElementById('onbSend');btn.disabled=true;
  api('/api/client/onboarding',{method:'POST',json:{entity_type:'legal',requisites:q}}).then(function(d){
    btn.disabled=false;
    if(d&&d.ok){
      V3.closeModal(_onb.modal);_onb.asked=true;
      V3.modal('<div class="v3-dlg"><span class="ic">✓</span><h3>Реквизиты сохранены</h3><p>Мы подготовим договор и отправим его по ЭДО, менеджер свяжется с вами в течение рабочего дня.</p></div><div class="v3-mf"><button class="v3-btn primary" type="button" data-on-click="v3CloseModal()">Понятно</button></div>',{width:'w400'});
      _profRefreshSoon();
      return;
    }
    var err=document.getElementById('onbErr');if(err)err.textContent=(d&&d.error)||'Не удалось отправить';
    if(d&&d.field){var el=document.getElementById('onb_'+d.field);if(el){el.classList.add('bad');el.focus()}}
  }).catch(function(){btn.disabled=false;var err=document.getElementById('onbErr');if(err)err.textContent='Ошибка соединения'});
}

// ================= магазин =================
var _shop={cat:null,region:'eu',geo:null,qty:1,ru:{type:null,geo:null,qty:10,comment:''},orders:[]};
var FLAGS={MD:'🇲🇩',RO:'🇷🇴',RU:'🇷🇺'};
function shopLoad(){
  var box=document.getElementById('shopContent');if(!box)return;
  if(!_shop.cat)box.innerHTML='<div class="v3-card"><div class="v3-skel" style="height:240px"></div></div>';
  Promise.all([api('/api/client/shop_catalog'),api('/api/client/proxy_orders').catch(function(){return {orders:[]}})]).then(function(r){
    var cat=r[0];
    if(!cat||cat.error){box.innerHTML='<div class="v3-card"><p class="v3-p">'+V3.esc((cat&&cat.error)||'Магазин временно недоступен')+'</p></div>';return}
    _shop.cat=cat;_shop.orders=(r[1]&&r[1].orders)||[];
    var eu=cat.europe||[];
    if(!_shop.geo||!eu.some(function(g){return g.geo===_shop.geo}))_shop.geo=(cat.currentGeo&&eu.some(function(g){return g.geo===cat.currentGeo}))?cat.currentGeo:(eu[0]&&eu[0].geo);
    if(!_shop.ru.type)_shop.ru.type=(cat.russia.types||[])[0];
    if(!_shop.ru.geo)_shop.ru.geo=(cat.russia.geos||[])[0];
    _shopRender();
  }).catch(function(){box.innerHTML='<div class="v3-card"><p class="v3-p">Ошибка соединения</p></div>'});
}
function shopRegion(r){_shop.region=r;_shopRender()}
function shopGeo(g){_shop.geo=g;_shopRender()}
function shopSetQty(n){_shop.qty=Math.max(1,Math.min(50,parseInt(n,10)||1));_shopRender()}
function shopQtyInput(v){var n=parseInt(String(v).replace(/\D/g,''),10);_shop.qty=Math.max(1,Math.min(50,n||1));_shopSummary()}
function shopStep(d){_shop.qty=Math.max(1,Math.min(50,(_shop.qty||1)+d));var el=document.getElementById('shQty');if(el)el.value=_shop.qty;_shopSummary();_shopChips()}
function _shopGeoObj(){return (_shop.cat.europe||[]).find(function(g){return g.geo===_shop.geo})||null}
function _shopTier(g,total){var t=null;(g.tiers||[]).forEach(function(x){if((x.min_proxies||1)<=total)t=x});return t||(g.tiers||[])[0]}
function _perDay(price){var c=_shop.cat;return Math.round(price/(c.daysInMonth||30)*100)/100}
function _daysWord(n){return V3.plural(n,'день','дня','дней')}
function _px(n){return V3.plural(n,'прокси','прокси','прокси')}

function _shopBalance(){
  var c=_shop.cat,bal=c.balance||0,day=c.dailyCharge||0;
  var runway=day>0?Math.floor(bal/day):null;
  var runCls=runway==null?'':(runway<3?'bad':runway<7?'warn':'good');
  return '<div class="v3-card v3-bal"><div class="tiles">'+
    '<div class="tile"><div class="l">Баланс</div><div class="v'+(bal<0?' bad':'')+'">'+V3.money(bal)+'</div></div>'+
    '<div class="tile"><div class="l">Расход в день</div><div class="v">'+(day>0?V3.money(day):'—')+'</div></div>'+
    '<div class="tile"><div class="l">Хватит на</div><div class="v '+runCls+'">'+(runway==null?'—':runway+' '+_daysWord(runway))+'</div></div>'+
    '</div><button type="button" class="v3-btn primary" data-on-click="shopTopup(0)">Пополнить</button></div>';
}
function shopTopup(amount){window._topupPrefill=amount>0?Math.ceil(amount):null;if(typeof openTopup==='function')openTopup()}
function _shopRender(){
  var box=document.getElementById('shopContent'),c=_shop.cat;
  var seg='<div class="v3-seg" style="margin-bottom:12px"><button type="button" class="'+(_shop.region==='eu'?'on':'')+'" data-on-click="shopRegion(\'eu\')">Европа</button><button type="button" class="'+(_shop.region==='ru'?'on':'')+'" data-on-click="shopRegion(\'ru\')">Россия</button></div>';
  box.innerHTML=_shopBalance()+seg+(_shop.region==='eu'?_shopEu(c):_shopRu(c));
  if(_shop.region==='eu'){_shopSummary();_shopChips()}
}
function _shopEu(c){
  var eu=c.europe||[];
  if(!eu.length)return '<div class="v3-card"><p class="v3-p">Тарифы скоро появятся</p></div>';
  var g=_shopGeoObj()||eu[0];_shop.geo=g.geo;
  var locked=c.currentGeo&&c.currentGeo!==g.geo;
  var h='<div class="v3-shop"><div>'+
    '<div class="v3-card"><div class="v3-step"><span class="n">1</span>Страна</div><div class="v3-geos">'+
      eu.map(function(x){var low=(x.tiers||[]).reduce(function(m,t){return Math.min(m,t.price)},Infinity);
        return '<button type="button" class="v3-geo'+(x.geo===g.geo?' on':'')+'" data-on-click="shopGeo(\''+x.geo+'\')"><div class="t">'+(FLAGS[x.geo]||'')+' '+V3.esc(x.name)+'</div><div class="s">'+V3.esc(x.type)+'</div><div class="p">от '+V3.money(low)+' / мес за прокси</div></button>'}).join('')+
    '</div><div class="v3-step"><span class="n">2</span>Сколько прокси</div>'+
    '<div class="v3-qty" id="shChips"></div>'+
    '<div style="display:flex;gap:6px;align-items:center"><button type="button" class="v3-btn" data-on-click="shopStep(-1)">−</button><input class="v3-input mono" id="shQty" inputmode="numeric" style="width:84px;text-align:center" value="'+_shop.qty+'" data-on-input="shopQtyInput(this.value)"><button type="button" class="v3-btn" data-on-click="shopStep(1)">+</button><span class="v3-note">до 50 за один заказ</span></div>'+
    (locked?'<div class="v3-banner warn" style="margin-top:12px">У вас прокси другой страны — чтобы добавить вторую страну, напишите нам: кнопка «Связаться с нами» в меню.</div>':'')+
    '</div>'+
    '<div class="v3-card" style="margin-top:12px"><div class="v3-step"><span class="n">3</span>Чем больше прокси — тем дешевле каждая</div><div class="v3-ladder" id="shTiers"></div><div class="v3-note" id="shNext" style="margin-top:8px"></div></div>';
  if(c.testDay&&c.testDayAvailable){
    h+='<div class="v3-card" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:200px"><h3>Тест-день</h3><p class="v3-p" style="margin:4px 0 0">Одна прокси на 24 часа за '+V3.money(c.testDay.price)+' — проверить перед покупкой. Доступно один раз.</p></div><button type="button" class="v3-btn" data-on-click="buyProxy('+c.testDay.id+',this)">Взять тест-день</button></div>';
  }
  h+='</div><div class="v3-shop-side"><div class="v3-card" id="shSum"></div></div></div>';
  return h;
}
function _shopChips(){
  var el=document.getElementById('shChips');if(!el)return;
  el.innerHTML=[1,3,5,10,25,50].map(function(n){return '<button type="button" class="'+(n===_shop.qty?'on':'')+'" data-on-click="shopSetQty('+n+')">'+n+'</button>'}).join('');
}
function _shopSummary(){
  var g=_shopGeoObj();if(!g)return;
  var c=_shop.cat,locked=c.currentGeo&&c.currentGeo!==g.geo;
  var owned=locked?0:(c.owned||0),total=owned+_shop.qty,t=_shopTier(g,total);
  var tiersEl=document.getElementById('shTiers');
  if(tiersEl)tiersEl.innerHTML=(g.tiers||[]).map(function(x,i,arr){
    var next=arr[i+1],range=next?('от '+x.min_proxies+' до '+(next.min_proxies-1)):('от '+x.min_proxies);
    return '<div class="r'+(t&&x.id===t.id?' on':'')+'"><span>'+range+' '+_px(x.min_proxies)+'</span><span>'+V3.money(x.price)+' / мес за прокси</span></div>';
  }).join('');
  var nx=null;(g.tiers||[]).forEach(function(x){if((x.min_proxies||1)>total&&!nx)nx=x});
  var nextEl=document.getElementById('shNext');
  if(nextEl)nextEl.textContent=nx?('До следующей ступени — ещё '+(nx.min_proxies-total)+' '+_px(nx.min_proxies-total)+': цена каждой станет '+V3.money(nx.price)+' / мес.'):'У вас самая выгодная ступень.';
  var today=Math.round(_perDay(t.price)*_shop.qty*100)/100,bal=c.balance||0,after=Math.round((bal-today)*100)/100;
  var dayAfter=Math.round(_perDay(t.price)*total*100)/100,runway=dayAfter>0?Math.floor(Math.max(0,after)/dayAfter):0;
  var enough=bal>=today,short=Math.ceil(today-bal);
  var sum=document.getElementById('shSum');if(!sum)return;
  sum.innerHTML='<h3 style="margin-bottom:6px">Ваш заказ</h3><div class="v3-note">'+(FLAGS[g.geo]||'')+' '+V3.esc(g.name)+' · '+V3.esc(g.type)+'</div>'+
    '<div class="v3-sumrows" style="margin-top:12px">'+
    '<div class="r"><span>Количество</span><b>'+_shop.qty+' '+_px(_shop.qty)+'</b></div>'+
    '<div class="r"><span>Цена за прокси</span><b>'+V3.money(t.price)+' / мес</b></div>'+
    (owned?'<div class="r"><span>Уже у вас</span><b>'+owned+' '+_px(owned)+'</b></div>':'')+
    '<div class="r"><span>Всего после покупки</span><b>'+total+' '+_px(total)+' · '+V3.money(Math.round(t.price*total))+' / мес</b></div>'+
    '<div class="r total"><span>Спишется сейчас</span><b>'+V3.money(today)+'</b></div>'+
    '<div class="r"><span>Баланс сейчас</span><b>'+V3.money(bal)+'</b></div>'+
    '<div class="r"><span>Баланс после покупки</span><b style="color:'+(enough?'var(--v3-green)':'var(--v3-red)')+'">'+V3.money(after)+'</b></div>'+
    (enough?'<div class="r"><span>Хватит примерно на</span><b>'+runway+' '+_daysWord(runway)+'</b></div>':'')+'</div>'+
    (enough
      ?'<button type="button" class="v3-btn primary v3-shop-cta" id="shBuy" data-on-click="shopBuy()"'+(locked?' disabled':'')+'>Купить '+_shop.qty+' '+_px(_shop.qty)+' за '+V3.money(today)+'</button>'
      :'<div class="v3-banner warn" style="margin:0 0 10px">Не хватает '+V3.money(short)+' на первые сутки.</div><button type="button" class="v3-btn primary v3-shop-cta" data-on-click="shopTopup('+short+')">Пополнить на '+V3.money(short)+'</button>')+
    '<div class="v3-note" style="margin-top:10px;text-align:center">Дальше — посуточно с баланса. Остановить можно в любой момент.</div>';
}
function shopBuy(){
  var g=_shopGeoObj();if(!g)return;
  V3.confirm({title:'Купить '+_shop.qty+' '+_px(_shop.qty)+' — '+g.name+'?',text:'Первые сутки спишутся сразу, дальше — посуточно с баланса.',cta:'Купить',danger:false,icon:'₽'}).then(function(ok){
    if(!ok)return;
    var btn=document.getElementById('shBuy');if(btn)btn.disabled=true;
    api('/api/client/buy_proxies',{method:'POST',json:{geo:g.geo,quantity:_shop.qty}}).then(function(d){
      if(btn)btn.disabled=false;
      if(d&&d.bought){
        V3.toast({title:'Выдано '+d.bought+' '+_px(d.bought),text:d.error||('Ступень: '+d.tier.name+'. Доступы — в разделе «Прокси».')});
        _shop.cat=null;shopLoad();if(typeof loadData==='function')loadData();
        return;
      }
      if(d&&d.code==='INSUFFICIENT_BALANCE'){
        V3.toast({kind:'warn',title:'Недостаточно средств',text:d.error,action:'Пополнить',onAction:function(){shopTopup(d.required||0)}});
        return;
      }
      if(d&&d.code==='EMAIL_NOT_VERIFIED'){var b=document.getElementById('shopVerifyBanner');if(b)b.style.display=''}
      V3.toast({kind:'err',title:'Покупка не выполнена',text:(d&&d.error)||'Попробуйте позже'});
    }).catch(function(){if(btn)btn.disabled=false;V3.toast({kind:'err',title:'Ошибка соединения'})});
  });
}
// ---- Россия: заявка менеджеру ----
function shopRuSet(k,v){_shop.ru[k]=k==='qty'?Math.max(1,Math.min(1000,parseInt(String(v).replace(/\D/g,''),10)||1)):v;if(k!=='qty'&&k!=='comment')_shopRender()}
function _shopRu(c){
  var ru=c.russia||{};
  var STATUS={new:'Новая',in_progress:'В работе',done:'Выдано',cancelled:'Отменена'};
  var h='<div class="v3-shop"><div class="v3-card"><p class="v3-p" style="margin:0 0 14px">'+V3.esc(ru.note||'')+'</p>'+
    '<div class="v3-step"><span class="n">1</span>Тип прокси</div><div class="v3-seg" style="flex-wrap:wrap;margin-bottom:16px">'+(ru.types||[]).map(function(t){return '<button type="button" class="'+(t===_shop.ru.type?'on':'')+'" data-on-click="shopRuSet(\'type\',\''+V3.esc(t).replace(/'/g,'')+'\')">'+V3.esc(t)+'</button>'}).join('')+'</div>'+
    '<div class="v3-step"><span class="n">2</span>Гео</div><div class="v3-seg" style="flex-wrap:wrap;margin-bottom:16px">'+(ru.geos||[]).map(function(g){return '<button type="button" class="'+(g===_shop.ru.geo?'on':'')+'" data-on-click="shopRuSet(\'geo\',\''+V3.esc(g).replace(/'/g,'')+'\')">'+V3.esc(g)+'</button>'}).join('')+'</div>'+
    '<div class="v3-step"><span class="n">3</span>Количество и пожелания</div>'+
    '<div class="v3-grid2" style="margin-bottom:0"><div class="v3-field"><span class="v3-label">Количество</span><input class="v3-input mono" inputmode="numeric" style="width:140px" value="'+_shop.ru.qty+'" data-on-input="shopRuSet(\'qty\',this.value)"></div>'+
    '<div class="v3-field"><span class="v3-label">Комментарий</span><input class="v3-input" maxlength="1000" placeholder="задача, срок аренды, город" value="'+V3.esc(_shop.ru.comment)+'" data-on-input="shopRuSet(\'comment\',this.value)"></div></div></div>'+
    '<div class="v3-shop-side"><div class="v3-card"><h3 style="margin-bottom:6px">Заявка менеджеру</h3><div class="v3-note">'+(FLAGS.RU||'')+' Россия</div>'+
    '<div class="v3-sumrows" style="margin-top:12px"><div class="r"><span>Тип</span><b>'+V3.esc(_shop.ru.type||'—')+'</b></div><div class="r"><span>Гео</span><b>'+V3.esc(_shop.ru.geo||'—')+'</b></div><div class="r total"><span>Количество</span><b>'+_shop.ru.qty+' '+_px(_shop.ru.qty)+'</b></div></div>'+
    '<div class="v3-note" style="margin-bottom:10px">Деньги сейчас не списываются: менеджер согласует цену и выдаст доступы.</div>'+
    '<button type="button" class="v3-btn primary v3-shop-cta" id="shRuSend" data-on-click="shopRuSend()">Отправить заявку</button></div></div></div>';
  if(_shop.orders.length){
    h+='<div class="v3-section gap">Ваши заявки</div><div class="v3-card flush"><div class="v3-table-wrap"><table class="v3-table"><thead><tr><th>№</th><th>Дата</th><th>Тип</th><th>Гео</th><th class="r">Кол-во</th><th>Статус</th></tr></thead><tbody>'+
      _shop.orders.map(function(o,i){return '<tr'+(i%2?' class="z"':'')+'><td class="mono">'+o.id+'</td><td class="mono mut">'+V3.esc(String(o.created_at||'').slice(0,10))+'</td><td>'+V3.esc(o.proxy_type)+'</td><td>'+V3.esc(o.geo)+'</td><td class="r mono">'+o.quantity+'</td><td>'+V3.esc(STATUS[o.status]||o.status)+'</td></tr>'}).join('')+
      '</tbody></table></div></div>';
  }
  return h;
}
function shopRuSend(){
  var btn=document.getElementById('shRuSend');if(btn)btn.disabled=true;
  api('/api/client/proxy_orders',{method:'POST',json:{proxy_type:_shop.ru.type,geo:_shop.ru.geo,quantity:_shop.ru.qty,comment:_shop.ru.comment}}).then(function(d){
    if(btn)btn.disabled=false;
    if(d&&d.ok){V3.toast({title:'Заявка №'+d.order.id+' отправлена',text:'Менеджер свяжется с вами, согласует цену и выдаст прокси.'});_shop.ru.comment='';_shop.cat=null;shopLoad();return}
    V3.toast({kind:'err',title:(d&&d.error)||'Не удалось отправить заявку'});
  }).catch(function(){if(btn)btn.disabled=false;V3.toast({kind:'err',title:'Ошибка соединения'})});
}
