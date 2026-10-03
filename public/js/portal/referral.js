// public/js/portal/referral.js — 3i «Партнёрская программа» + попап 5e
// «Вывести на баланс». /api/client/referral_stats — ставка, остаток,
// «начислено всего», рефералы и начисления; вывод — withdraw_to_balance.

var _ref=null;
function renderReferral(){
  api('/api/client/referral_stats').then(function(d){
    if(!d||d.error){document.getElementById('refBody').innerHTML='<div class="v3-emptybox"><div class="t">Не удалось загрузить данные</div></div>';return}
    _ref=d;_refRender();
  }).catch(function(){document.getElementById('refBody').innerHTML='<div class="v3-emptybox"><div class="t">Нет связи с сервером</div></div>'});
}
function _refLink(){return _ref&&_ref.code?window.location.origin+'/register?ref='+_ref.code:''}
function _refRender(){
  var d=_ref,pct=Math.round((d.rate||0)*100),link=_refLink();
  document.getElementById('refWithdrawBtn').disabled=!(d.balance>0);
  var h='<div class="v3-card mb12"><h3 style="margin-bottom:6px">Ваша ссылка</h3><p class="v3-p">'+pct+'% от каждой оплаты приведённого клиента начисляются на партнёрский баланс. Вывод — на основной баланс кабинета; вывод деньгами — через менеджера.</p>'+
    '<div class="v3-keyline"><span>'+V3.esc(link||'Ссылка появится после активации программы — напишите менеджеру')+'</span>'+(link?'<button type="button" class="v3-btn solid-sm" data-on-click="refCopy()">Копировать</button>':'')+'</div></div>';
  var since=d.since?V3.parse(d.since):null;
  var cards=[
    {l:'Партнёрский баланс',v:V3.money2(d.balance||0),s:d.balance>0?'доступно к выводу':'пока нечего выводить',top:'green'},
    {l:'Приведено клиентов',v:String(d.referrals||0),s:(d.active||0)+' '+V3.plural(d.active||0,'активный','активных','активных'),top:''},
    {l:'Начислено всего',v:V3.money2(d.totalEarned||0),s:since?'с '+V3.MONTHS_GEN[since.getMonth()]+' '+since.getFullYear():'—',top:''},
    {l:'Ставка',v:pct+'%',s:'от каждой оплаты',top:''}
  ];
  h+='<div class="v3-grid4">'+cards.map(function(c){return '<div class="v3-pulse '+c.top+'"><div class="v3-pulse-l">'+c.l+'</div><div class="v3-pulse-v">'+c.v+'</div><div class="v3-pulse-s">'+c.s+'</div></div>'}).join('')+'</div>';
  h+='<div class="v3-card"><h3 style="margin-bottom:10px">Начисления</h3>';
  if(!d.accruals||!d.accruals.length){
    h+='<div class="v3-emptybox bare"><span class="ic acc">%</span><div class="t">Начислений пока нет</div><div class="d">Поделитесь ссылкой — комиссия начислится с первой оплаты приведённого клиента.</div></div>';
  }else{
    h+='<div class="v3-table-wrap"><table class="v3-table"><thead><tr><th>Дата</th><th>Клиент</th><th class="r">Оплата</th><th class="r">Ваши '+pct+'%</th></tr></thead><tbody>'+
      d.accruals.map(function(a,i){return '<tr'+(i%2?' class="z"':'')+'><td class="mono mut">'+V3.esc(a.date?V3.dm(a.date)+(a.date.slice(0,4)!==V3.today().slice(0,4)?'.'+a.date.slice(0,4):''):'—')+'</td><td class="txt">'+V3.esc(a.client)+'</td><td class="r mono mut">'+V3.money2(a.pay)+'</td><td class="r mono b" style="color:'+(a.fee<0?'var(--v3-red)':'var(--v3-green)')+'">'+(a.fee<0?'−':'+')+V3.money2(Math.abs(a.fee))+'</td></tr>'}).join('')+
      '</tbody></table></div><div class="v3-note" style="margin-top:8px">Начисления рассчитаны по оплатам приведённых клиентов; возвраты платежей уменьшают комиссию.</div>';
  }
  document.getElementById('refBody').innerHTML=h+'</div>';
}
function refCopy(){var l=_refLink();if(l)V3.copy(l,'Партнёрская ссылка скопирована')}
function openRefWithdraw(){
  if(!_ref){renderReferral();return}
  var amt=Math.round((_ref.balance||0)*100)/100;
  if(!(amt>0)){V3.toast({kind:'info',title:'Пока нечего выводить'});return}
  var m=V3.modal(V3.mh('Вывести на баланс')+'<div class="v3-mb">'+
    '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:12px;border-radius:8px;background:var(--v3-sunken)"><span style="font-size:12px;color:var(--v3-muted)">Доступно</span><span style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--v3-green)">'+V3.money2(amt)+'</span></div>'+
    '<div class="v3-field"><span class="v3-label">Сумма вывода</span><div class="v3-amount"><input value="'+V3.money2(amt).replace(' ₽','')+'" readonly style="font-size:16px"><button type="button" class="all">Всё</button></div><span class="v3-note">Выводится весь партнёрский баланс целиком.</span></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--v3-muted)">Основной баланс станет</span><span style="font-family:var(--font-mono);font-weight:600;color:var(--v3-ink)">'+V3.money2((_ref.mainBalance||0)+amt)+'</span></div>'+
    '</div><div class="v3-mf"><button type="button" class="v3-btn primary" data-a="go">Вывести '+V3.money2(amt)+'</button></div>',{width:'w420'});
  m.querySelector('[data-a="go"]').addEventListener('click',function(){
    var b=this;b.disabled=true;
    api('/api/client/referral/withdraw_to_balance',{method:'POST'}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось выполнить вывод');
      V3.closeModal(m);
      V3.toast({title:'Комиссия зачислена на баланс',text:V3.money2(d.amount)+' · баланс '+V3.money2(d.balance)});
      renderReferral();loadData();
    }).catch(function(e){b.disabled=false;V3.toast({kind:'err',title:e.message})});
  });
}
