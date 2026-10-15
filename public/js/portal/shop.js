'use strict';
// public/js/portal/shop.js — магазин и онбординг розницы (2026-10-15).
//
// 1) «Как вы будете работать?» — при первом входе самостоятельно
//    зарегистрированного клиента: физлицо (ничего не нужно) или юрлицо/ИП
//    (анкета реквизитов → договор по ЭДО, руководитель получает задачу).
//    API: GET/POST /api/client/onboarding.
// 2) «Купить прокси»:
//    Европа — страна, количество; ступень цены выбирается сама по общему
//    числу прокси клиента; покупка — POST /api/client/buy_proxies.
//    Россия — тип, гео, количество → заявка менеджеру
//    (POST /api/client/proxy_orders), список заявок со статусами.
//    Справочник — GET /api/client/shop_catalog.

// ================= онбординг =================
var _onb={asked:false};
function v3OnbStart(){
  if(_onb.asked)return;_onb.asked=true;
  api('/api/client/onboarding').then(function(d){if(d&&d.needsChoice)_onbChoice()}).catch(function(){});
}
function _onbChoice(){
  var m=V3.modal(
    '<div class="v3-mh"><h3>Как вы будете работать с нами?</h3></div>'+
    '<div class="v3-mb"><p class="v3-p" style="margin:0 0 12px;font-size:12.5px;color:var(--v3-muted)">От этого зависят документы и способ оплаты. Выбор можно уточнить позже через поддержку.</p>'+
    '<div class="v3-opts" style="display:grid;gap:10px">'+
      '<button type="button" class="v3-fmt" data-on-click="onbPick(\'individual\')"><div class="h"><span class="lb">Физическое лицо</span></div><div class="d">Оплата картой или СБП, документы не нужны. Можно сразу покупать прокси.</div></button>'+
      '<button type="button" class="v3-fmt" data-on-click="onbPick(\'legal\')"><div class="h"><span class="lb">Юридическое лицо или ИП</span></div><div class="d">Работа по договору: заполните реквизиты — мы подготовим договор, отправим его по ЭДО и свяжемся с вами. Оплата по счёту, закрывающие документы каждый месяц.</div></button>'+
    '</div></div>',
    {width:'w460',sticky:true});
  _onb.modal=m;
}
function onbPick(kind){
  if(kind==='individual'){
    api('/api/client/onboarding',{method:'POST',json:{entity_type:'individual'}}).then(function(d){
      if(d&&d.ok){V3.closeModal(_onb.modal);V3.toast({title:'Готово',text:'Вы работаете как физическое лицо'})}
      else V3.toast({kind:'err',title:(d&&d.error)||'Не удалось сохранить'});
    }).catch(function(){V3.toast({kind:'err',title:'Ошибка соединения'})});
    return;
  }
  _onbLegalForm();
}
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
function _onbLegalForm(){
  var h='<div class="v3-mh"><h3>Реквизиты для договора</h3><button class="v3-x" type="button" data-on-click="v3CloseModal()" aria-label="Закрыть">×</button></div>'+
    '<div class="v3-mb" style="max-height:62vh;overflow:auto"><p class="v3-p" style="margin:0 0 12px;font-size:12px;color:var(--v3-muted)">По этим данным мы подготовим договор и отправим его по ЭДО. Поля с пометкой «необязательно» или «если есть» можно оставить пустыми; КПП не нужен для ИП.</p>'+
    '<div class="v3-grid2" style="margin-bottom:0">';
  ONB_FIELDS.forEach(function(f){
    h+='<div class="v3-field"'+(f[3]?' style="grid-column:1 / -1"':'')+'><span class="v3-label">'+V3.esc(f[1])+'</span><input class="v3-input" id="onb_'+f[0]+'" placeholder="'+V3.esc(f[2])+'" autocomplete="off"></div>';
  });
  h+='</div><div id="onbErr" class="v3-note" style="color:var(--v3-red);margin-top:10px"></div></div>'+
    '<div class="v3-mf"><button class="v3-btn" type="button" data-on-click="v3CloseModal()">Позже</button><button class="v3-btn primary" type="button" id="onbSend" data-on-click="onbSendLegal()">Отправить реквизиты</button></div>';
  if(_onb.modal)V3.closeModal(_onb.modal);
  _onb.modal=V3.modal(h,{width:'w560',onClose:function(){_onb.asked=false}});
  var pos=document.getElementById('onb_signer_position');if(pos)pos.value='Генеральный директор';
  var bas=document.getElementById('onb_signer_basis');if(bas)bas.value='Устава';
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
      V3.modal('<div class="v3-dlg"><span class="ic">✓</span><h3>Реквизиты получены</h3><p>Мы подготовим договор и отправим его по ЭДО, менеджер свяжется с вами в течение рабочего дня.</p></div><div class="v3-mf"><button class="v3-btn primary" type="button" data-on-click="v3CloseModal()">Понятно</button></div>',{width:'w400'});
      return;
    }
    var err=document.getElementById('onbErr');if(err)err.textContent=(d&&d.error)||'Не удалось отправить';
    if(d&&d.field){var el=document.getElementById('onb_'+d.field);if(el){el.classList.add('bad');el.focus()}}
  }).catch(function(){btn.disabled=false;var err=document.getElementById('onbErr');if(err)err.textContent='Ошибка соединения'});
}

// ================= магазин =================
var _shop={cat:null,region:'eu',geo:null,qty:1,ru:{type:null,geo:null,qty:10,comment:''},orders:[]};
function shopLoad(){
  var box=document.getElementById('shopContent');if(!box)return;
  box.innerHTML='<div class="v3-card"><div class="v3-skel" style="height:220px"></div></div>';
  Promise.all([api('/api/client/shop_catalog'),api('/api/client/proxy_orders').catch(function(){return {orders:[]}})]).then(function(r){
    var cat=r[0];
    if(!cat||cat.error){box.innerHTML='<div class="v3-card"><p class="v3-p">'+V3.esc((cat&&cat.error)||'Магазин временно недоступен')+'</p></div>';return}
    _shop.cat=cat;_shop.orders=(r[1]&&r[1].orders)||[];
    if(!_shop.geo){var eu=cat.europe||[];_shop.geo=(cat.currentGeo&&eu.some(function(g){return g.geo===cat.currentGeo}))?cat.currentGeo:(eu[0]&&eu[0].geo)}
    if(!_shop.ru.type)_shop.ru.type=(cat.russia.types||[])[0];
    if(!_shop.ru.geo)_shop.ru.geo=(cat.russia.geos||[])[0];
    _shopRender();
  }).catch(function(){box.innerHTML='<div class="v3-card"><p class="v3-p">Ошибка соединения</p></div>'});
}
function shopRegion(r){_shop.region=r;_shopRender()}
function shopGeo(g){_shop.geo=g;_shopRender()}
function shopQty(v){var n=parseInt(String(v).replace(/\D/g,''),10);_shop.qty=Math.max(1,Math.min(50,n||1));_shopSummary()}
function shopStep(d){_shop.qty=Math.max(1,Math.min(50,(_shop.qty||1)+d));var el=document.getElementById('shQty');if(el)el.value=_shop.qty;_shopSummary()}
function _shopGeoObj(){return (_shop.cat.europe||[]).find(function(g){return g.geo===_shop.geo})||null}
function _shopTier(g,total){var t=null;(g.tiers||[]).forEach(function(x){if((x.min_proxies||1)<=total)t=x});return t||(g.tiers||[])[0]}
function _shopRender(){
  var box=document.getElementById('shopContent'),c=_shop.cat;
  var seg='<div class="v3-seg" style="margin-bottom:12px"><button type="button" class="'+(_shop.region==='eu'?'on':'')+'" data-on-click="shopRegion(\'eu\')">Европа</button><button type="button" class="'+(_shop.region==='ru'?'on':'')+'" data-on-click="shopRegion(\'ru\')">Россия</button></div>';
  box.innerHTML=seg+(_shop.region==='eu'?_shopEu(c):_shopRu(c));
  if(_shop.region==='eu')_shopSummary();
}
function _shopEu(c){
  var eu=c.europe||[];
  if(!eu.length)return '<div class="v3-card"><p class="v3-p">Тарифы скоро появятся</p></div>';
  var g=_shopGeoObj()||eu[0];_shop.geo=g.geo;
  var h='<div class="v3-card"><div class="v3-grid2" style="margin-bottom:12px">'+
    '<div class="v3-field"><span class="v3-label">Страна</span><div class="v3-seg">'+eu.map(function(x){return '<button type="button" class="'+(x.geo===g.geo?'on':'')+'" data-on-click="shopGeo(\''+x.geo+'\')">'+V3.esc(x.name)+'</button>'}).join('')+'</div></div>'+
    '<div class="v3-field"><span class="v3-label">Тип прокси</span><div><span class="v3-chip on static">'+V3.esc(g.type)+'</span></div></div>'+
    '<div class="v3-field"><span class="v3-label">Количество</span><div style="display:flex;gap:6px;align-items:center"><button type="button" class="v3-btn" data-on-click="shopStep(-1)">−</button><input class="v3-input mono" id="shQty" inputmode="numeric" style="width:80px;text-align:center" value="'+_shop.qty+'" data-on-input="shopQty(this.value)"><button type="button" class="v3-btn" data-on-click="shopStep(1)">+</button><span class="v3-note">до 50 за заказ</span></div></div>'+
    '<div class="v3-field"><span class="v3-label">Цена зависит от числа ваших прокси</span><div id="shTiers"></div></div>'+
    '</div><div id="shSum"></div></div>';
  if(c.testDay&&c.testDayAvailable){
    h+='<div class="v3-card" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:200px"><h3>Тест-день</h3><p class="v3-p" style="margin:4px 0 0">Одна прокси на 24 часа за '+V3.money(c.testDay.price)+' — чтобы проверить перед покупкой. Доступно один раз.</p></div><button type="button" class="v3-btn" data-on-click="buyProxy('+c.testDay.id+',this)">Взять тест-день</button></div>';
  }
  return h;
}
function _shopSummary(){
  var g=_shopGeoObj();if(!g)return;
  var c=_shop.cat,owned=c.currentGeo&&c.currentGeo!==g.geo?0:(c.owned||0),total=owned+_shop.qty,t=_shopTier(g,total);
  var tiersEl=document.getElementById('shTiers');
  if(tiersEl)tiersEl.innerHTML=(g.tiers||[]).map(function(x,i,arr){
    var next=arr[i+1],range=next?('от '+x.min_proxies+' до '+(next.min_proxies-1)):('от '+x.min_proxies);
    return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 6px;border-radius:6px;'+(t&&x.id===t.id?'background:var(--v3-accent-dim);font-weight:600':'color:var(--v3-muted)')+'"><span>'+range+' прокси</span><span>'+V3.money(x.price)+' / мес за прокси</span></div>';
  }).join('');
  var now=new Date(),days=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  var perDay=Math.round(t.price/days*100)/100,today=Math.round(perDay*_shop.qty*100)/100;
  var lockMsg=c.currentGeo&&c.currentGeo!==g.geo?'<div class="v3-banner warn" style="margin-top:10px">У вас прокси другой страны — чтобы добавить вторую страну, напишите в поддержку.</div>':'';
  var sum=document.getElementById('shSum');if(!sum)return;
  sum.innerHTML='<div class="v3-tiles three" style="margin-top:4px">'+
    '<div class="v3-tile"><div class="v3-tile-l">Цена за прокси</div><div class="v3-tile-v">'+V3.money(t.price)+'</div><div class="v3-note">в месяц</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">В месяц за все</div><div class="v3-tile-v">'+V3.money(t.price*total)+'</div><div class="v3-note">'+total+' '+V3.plural(total,'прокси','прокси','прокси')+'</div></div>'+
    '<div class="v3-tile"><div class="v3-tile-l">Сейчас</div><div class="v3-tile-v">'+V3.money(today)+'</div><div class="v3-note">спишется за первые сутки</div></div></div>'+
    (owned?'<p class="v3-note" style="margin-top:8px">У вас уже '+owned+' '+V3.plural(owned,'прокси','прокси','прокси')+' — цена ступени действует на все ваши прокси.</p>':'<p class="v3-note" style="margin-top:8px">Дальше списывается посуточно с баланса. Цена ступени действует на все ваши прокси.</p>')+
    lockMsg+
    '<div style="margin-top:12px;display:flex;justify-content:flex-end"><button type="button" class="v3-btn primary" id="shBuy" data-on-click="shopBuy()"'+(lockMsg?' disabled':'')+'>Купить '+_shop.qty+' '+V3.plural(_shop.qty,'прокси','прокси','прокси')+'</button></div>';
}
function shopBuy(){
  var g=_shopGeoObj();if(!g)return;
  V3.confirm({title:'Купить '+_shop.qty+' '+V3.plural(_shop.qty,'прокси','прокси','прокси')+' — '+g.name+'?',text:'Первые сутки спишутся сразу, дальше — посуточно с баланса.',cta:'Купить',danger:false,icon:'₽'}).then(function(ok){
    if(!ok)return;
    var btn=document.getElementById('shBuy');if(btn)btn.disabled=true;
    api('/api/client/buy_proxies',{method:'POST',json:{geo:g.geo,quantity:_shop.qty}}).then(function(d){
      if(btn)btn.disabled=false;
      if(d&&d.bought){
        V3.toast({title:'Выдано '+d.bought+' '+V3.plural(d.bought,'прокси','прокси','прокси'),text:d.error||('Тариф: '+d.tier.name+'. Доступы — в разделе «Прокси».')});
        _shop.cat=null;shopLoad();if(typeof loadData==='function')loadData();
        return;
      }
      if(d&&d.code==='INSUFFICIENT_BALANCE'){
        V3.toast({kind:'warn',title:'Недостаточно средств',text:d.error,action:'Пополнить',onAction:function(){window._topupPrefill=Math.ceil(d.required||0);if(typeof openTopup==='function')openTopup()}});
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
  var h='<div class="v3-card"><p class="v3-p" style="margin:0 0 12px">'+V3.esc(ru.note||'')+'</p><div class="v3-grid2" style="margin-bottom:12px">'+
    '<div class="v3-field"><span class="v3-label">Тип прокси</span><div class="v3-seg" style="flex-wrap:wrap">'+(ru.types||[]).map(function(t){return '<button type="button" class="'+(t===_shop.ru.type?'on':'')+'" data-on-click="shopRuSet(\'type\',\''+V3.esc(t).replace(/'/g,'')+'\')">'+V3.esc(t)+'</button>'}).join('')+'</div></div>'+
    '<div class="v3-field"><span class="v3-label">Гео</span><div class="v3-seg" style="flex-wrap:wrap">'+(ru.geos||[]).map(function(g){return '<button type="button" class="'+(g===_shop.ru.geo?'on':'')+'" data-on-click="shopRuSet(\'geo\',\''+V3.esc(g).replace(/'/g,'')+'\')">'+V3.esc(g)+'</button>'}).join('')+'</div></div>'+
    '<div class="v3-field"><span class="v3-label">Количество</span><input class="v3-input mono" inputmode="numeric" style="width:120px" value="'+_shop.ru.qty+'" data-on-input="shopRuSet(\'qty\',this.value)"></div>'+
    '<div class="v3-field"><span class="v3-label">Комментарий</span><input class="v3-input" maxlength="1000" placeholder="задача, срок аренды, пожелания по городу" value="'+V3.esc(_shop.ru.comment)+'" data-on-input="shopRuSet(\'comment\',this.value)"></div>'+
    '</div><div style="display:flex;justify-content:flex-end"><button type="button" class="v3-btn primary" id="shRuSend" data-on-click="shopRuSend()">Отправить заявку</button></div></div>';
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
