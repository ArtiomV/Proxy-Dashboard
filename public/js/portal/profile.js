// public/js/portal/profile.js — 3j «Профиль» + попапы 5e (смена пароля).
// /api/client/profile — учётная запись и реквизиты; /api/client/sla_report —
// SLA текущего месяца; email — POST /api/client/email; Telegram —
// tg_link_code / tg_unlink; пароль — POST /api/client/change_password.

var _prof=null,_sla=null;
function renderProfile(){
  var month=V3.today().slice(0,7);
  Promise.all([
    api('/api/client/profile').catch(function(){return null}),
    api('/api/client/sla_report?month='+month).catch(function(){return null})
  ]).then(function(r){
    _prof=r[0]&&!r[0].error?r[0]:null;_sla=r[1]&&!r[1].error?r[1]:null;
    if(!_prof){document.getElementById('profBody').innerHTML='<div class="v3-emptybox"><div class="t">Не удалось загрузить профиль</div></div>';return}
    _profRender();
  });
}
function _profRender(){
  var p=_prof,l=p.legal||{},cur=p.currency==='RUB'?'₽':p.currency;
  var row=function(k,v,a,mono){return '<div class="v3-prow"><span class="k">'+k+'</span><span class="v'+(mono?' mono':'')+'">'+(v||'<span style="color:var(--v3-faint)">—</span>')+'</span>'+(a||'')+'</div>'};
  var h='';
  if(p.email&&!p.emailVerified)h+='<div class="v3-banner warn" style="grid-column:1/-1;margin:0">Подтвердите email '+V3.esc(p.email)+' — на него приходят чеки и важные уведомления.<button type="button" class="v3-btn white sm" data-on-click="doResendVerification(this)">Отправить письмо ещё раз</button></div>';
  var tariff=p.price?(p.billingType==='per_modem'?V3.num(p.price,p.price%1?2:0)+' '+cur+' за модем в месяц':V3.num(p.price,p.price%1?2:0)+' '+cur+' за ГБ'):'';
  h+='<div class="v3-card"><h3 style="margin-bottom:10px">Учётная запись</h3>'+
    row('Логин',V3.esc(p.login),'',true)+
    row('Email',V3.esc(p.email)+(p.email?(p.emailVerified?' <span class="v3-pill green">подтверждён</span>':' <span class="v3-pill amber">не подтверждён</span>'):''),'<button type="button" class="a" data-on-click="profEmail()">'+(p.email?'Изменить':'Указать')+'</button>')+
    row('Тип клиента',V3.esc(p.clientTypeLabel))+
    row('Тариф',V3.esc(tariff))+
    row('Клиент с',p.createdAt?V3.esc(V3.date(p.createdAt)):'')+'</div>';
  h+='<div class="v3-card"><h3 style="margin-bottom:10px">Реквизиты для документов</h3>'+
    row('Название',V3.esc(l.name||p.name))+row('ИНН',V3.esc(l.inn),'',true)+row('КПП',V3.esc(l.kpp),'',true)+row('Адрес',V3.esc(l.address))+
    row('Договор',V3.esc([l.contract,l.contractDate?'от '+V3.date(l.contractDate):''].filter(Boolean).join(' ')))+
    '<div class="v3-note" style="margin-top:8px">Изменить реквизиты можно через менеджера — они попадают в акты и счета.</div></div>';
  h+='<div class="v3-card"><h3 style="margin-bottom:10px">Безопасность</h3><div style="display:flex;flex-direction:column;gap:10px">'+
    '<div class="v3-srow"><span class="k">Пароль</span><span class="v">'+(p.pwChangedAt?'Изменён '+V3.esc(V3.date(p.pwChangedAt)):'Задан')+'</span><button type="button" class="v3-btn sm link" data-on-click="profPassword()">Сменить</button></div>'+
    '<div class="v3-srow"><span class="k">Telegram</span><span class="v">'+(p.tgLinked?(p.tgUsername?'@'+V3.esc(p.tgUsername):'привязан'):'<span style="color:var(--v3-faint)">не привязан</span>')+'</span>'+
      (p.tgLinked?'<button type="button" class="v3-btn sm" data-on-click="profTgUnlink()">Отвязать</button>':'<button type="button" class="v3-btn sm link" data-on-click="profTgLink()">Привязать</button>')+'</div>'+
    '<div class="v3-note">'+(p.tgLinked?'В Telegram приходят зачисления, предупреждения о балансе и уведомления «прокси офлайн».':'Привяжите Telegram, чтобы получать зачисления, предупреждения о балансе и уведомления «прокси офлайн».')+'</div>'+
  '</div></div>';
  h+=_profSla();
  var body=document.getElementById('profBody');
  body.style.display='grid';body.style.gridTemplateColumns='repeat(auto-fit,minmax(min(100%,420px),1fr))';body.style.gap='12px';body.style.alignItems='start';
  body.innerHTML=h;
}
function _profSla(){
  var s=(rawData&&rawData.uptimeSummary30d)||null;
  var up=s&&s.uptime_pct!=null?parseFloat(s.uptime_pct):null;
  var checks=s?s.checks:null;
  var t=[
    {l:'Доступность',v:up!=null?V3.pct(up):'—',c:up==null?'':up>=99?'good':up>=95?'warn':'bad'},
    {l:'Проверок',v:checks!=null?V3.group(checks):'—'}
  ];
  return '<div class="v3-card"><h3 style="margin-bottom:10px">SLA за 30 дней</h3><div class="v3-tiles two">'+t.map(function(x){return '<div class="v3-tile"><div class="v3-tile-l">'+x.l+'</div><div class="v3-tile-v '+(x.c||'')+'">'+x.v+'</div></div>'}).join('')+'</div>'+
    '<div class="v3-hint" style="margin-top:10px">Отчёт формируется по тем же проверкам доступности, что показаны в колонке «Аптайм».</div></div>';
}

// ---------- email ----------
function profEmail(){
  var m=V3.modal(V3.mh('Email')+'<div class="v3-mb"><div class="v3-field"><span class="v3-label">Новый email</span><input class="v3-input" type="email" id="pfEmail" maxlength="200" value="'+V3.esc((_prof&&_prof.email)||'')+'"><span class="v3-note">Пришлём письмо для подтверждения. На этот адрес уходят чеки и счета.</span></div></div><div class="v3-mf"><button type="button" class="v3-btn" data-on-click="v3CloseModal()">Отмена</button><button type="button" class="v3-btn primary" data-a="s">Сохранить</button></div>',{width:'w420'});
  m.querySelector('#pfEmail').focus();
  m.querySelector('[data-a="s"]').addEventListener('click',function(){
    var b=this,email=m.querySelector('#pfEmail').value.trim();
    if(!email){V3.toast({kind:'err',title:'Укажите email'});return}
    b.disabled=true;
    api('/api/client/email',{method:'POST',json:{email:email}}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось сохранить');
      V3.closeModal(m);V3.toast({title:d.verificationSent?'Письмо с подтверждением отправлено':'Email сохранён',text:email});renderProfile();
    }).catch(function(e){b.disabled=false;V3.toast({kind:'err',title:e.message})});
  });
}

// ---------- пароль (5e) ----------
function _pwScore(p){
  var s=0;if(p.length>=8)s++;if(p.length>=12)s++;if(/\d/.test(p)&&/[a-zа-я]/i.test(p))s++;if(/[A-ZА-Я]/.test(p)&&/[a-zа-я]/.test(p)||/[^\w]/.test(p))s++;
  return s;
}
function profPassword(){
  var m=V3.modal(V3.mh('Сменить пароль')+'<div class="v3-mb">'+
    '<div class="v3-field"><span class="v3-label">Текущий пароль</span><input class="v3-input" type="password" id="pwOld" autocomplete="current-password"></div>'+
    '<div class="v3-field"><span class="v3-label">Новый пароль</span><input class="v3-input" type="password" id="pwNew" autocomplete="new-password"><span class="v3-note" id="pwNote1">Минимум 8 символов</span></div>'+
    '<div class="v3-field"><span class="v3-label">Повторите</span><input class="v3-input" type="password" id="pwRep" autocomplete="new-password"><span class="v3-note" id="pwNote2"></span></div>'+
    '<div class="v3-strength" id="pwBar"><i></i><i></i><i></i><i></i></div>'+
    '<div class="v3-note">После смены пароля все сессии завершатся — войдите заново. Прокси продолжат работать.</div>'+
  '</div><div class="v3-mf"><button type="button" class="v3-btn" data-on-click="v3CloseModal()">Отмена</button><button type="button" class="v3-btn primary" data-a="s">Сохранить</button></div>',{width:'w420'});
  var nw=m.querySelector('#pwNew'),rp=m.querySelector('#pwRep');
  function check(){
    var p=nw.value,s=_pwScore(p),bar=m.querySelector('#pwBar'),n1=m.querySelector('#pwNote1'),n2=m.querySelector('#pwNote2');
    bar.className='v3-strength'+(s<=1?' weak':s===2?' mid':'');
    bar.querySelectorAll('i').forEach(function(i,k){i.classList.toggle('on',p&&k<s)});
    n1.textContent=!p?'Минимум 8 символов':p.length<8?'Слишком короткий — минимум 8 символов':s>=3?'Надёжный: '+p.length+' символов':'Можно надёжнее: добавьте цифры и заглавные буквы';
    n1.style.color=!p?'':p.length<8?'var(--v3-red)':s>=3?'var(--v3-green)':'var(--v3-amber)';
    nw.classList.toggle('bad',p&&p.length<8);
    var mis=rp.value&&rp.value!==p;
    n2.textContent=mis?'Пароли не совпадают':'';n2.style.color='var(--v3-red)';rp.classList.toggle('bad',!!mis);
  }
  nw.addEventListener('input',check);rp.addEventListener('input',check);
  m.querySelector('[data-a="s"]').addEventListener('click',function(){
    var b=this,o=m.querySelector('#pwOld').value,p=nw.value;
    if(!o||!p){V3.toast({kind:'err',title:'Заполните все поля'});return}
    if(p.length<8){V3.toast({kind:'err',title:'Новый пароль — минимум 8 символов'});return}
    if(p!==rp.value){V3.toast({kind:'err',title:'Пароли не совпадают'});return}
    b.disabled=true;
    api('/api/client/change_password',{method:'POST',json:{old:o,new:p}}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось сменить пароль');
      V3.closeModal(m);V3.toast({title:'Пароль изменён',text:'Войдите с новым паролем'});setTimeout(doLogout,1200);
    }).catch(function(e){b.disabled=false;V3.toast({kind:'err',title:e.message})});
  });
}

// ---------- Telegram ----------
function profTgLink(){
  api('/api/client/tg_link_code',{method:'POST',json:{}}).then(function(d){
    if(!d||!d.ok)throw new Error((d&&d.error)||'Не удалось получить код привязки');
    var m=V3.modal(V3.mh('Привязать Telegram')+'<div class="v3-mb"><p class="v3-hint" style="margin:0">Откройте бота'+(_prof&&_prof.botUsername?' @'+V3.esc(_prof.botUsername):'')+' и нажмите «Запустить» — аккаунт привяжется автоматически. Код действует '+(d.ttlMin||15)+' минут.</p>'+
      '<div class="v3-detail">/start link_'+V3.esc(d.code)+'</div></div><div class="v3-mf"><button type="button" class="v3-btn" data-a="c">Скопировать команду</button><a class="v3-btn primary" href="'+V3.esc(d.url)+'" target="_blank" rel="noopener">Открыть Telegram</a></div>',{width:'w420',onClose:function(){renderProfile();v3LoadLabels()}});
    m.querySelector('[data-a="c"]').addEventListener('click',function(){V3.copy('/start link_'+d.code,'Команда скопирована')});
  }).catch(function(e){V3.toast({kind:'err',title:e.message})});
}
function profTgUnlink(){
  V3.confirm({title:'Отвязать Telegram?',text:'Перестанут приходить зачисления, предупреждения о балансе и уведомления «прокси офлайн».',cta:'Отвязать'}).then(function(ok){
    if(!ok)return;
    api('/api/client/tg_unlink',{method:'POST',json:{}}).then(function(d){
      if(!d||!d.ok)throw new Error((d&&d.error)||'Ошибка отвязки');
      V3.toast({title:'Telegram отвязан'});renderProfile();v3LoadLabels();
    }).catch(function(e){V3.toast({kind:'err',title:e.message})});
  });
}
