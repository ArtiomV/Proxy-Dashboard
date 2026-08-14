// public/js/auth-utils.js — общие мелочи auth-форм (register/reset/login).
//
// 1) Telegram OIDC Login. Старый iframe-виджет (oauth.telegram.org/embed)
//    Telegram перевёл на OpenID Connect: попап /auth на embed-поток отвечает
//    «deprecated» (14.08.2026). Кнопка — обычная ссылка на серверный
//    code-flow /api/auth/telegram_oidc_start: без внешних скриптов, eval и
//    postMessage; размер — как .btn-login (на всю ширину).
// 2) «Глазик» у полей пароля — переключение type password/text.

function renderTelegramLoginButton(wrapId, label){
  var wrap=document.getElementById(wrapId);
  if(!wrap)return;
  wrap.innerHTML='';
  var a=document.createElement('a');
  a.className='btn-login btn-tg-login';
  a.href='/api/auth/telegram_oidc_start';
  a.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.04 15.31l-.38 5.32c.54 0 .78-.23 1.06-.51l2.55-2.44 5.28 3.87c.97.53 1.65.25 1.91-.9L22.9 3.77c.31-1.42-.51-1.98-1.45-1.63L2.4 9.33c-1.39.54-1.37 1.32-.24 1.67l4.88 1.52L18.4 5.94c.53-.35 1.02-.16.62.19"/></svg><span>'+(label||'Войти через Telegram')+'</span>';
  wrap.appendChild(a);
}

var _PW_EYE='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
var _PW_EYE_OFF='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function addPasswordToggle(inputId){
  var inp=document.getElementById(inputId);
  if(!inp||inp.dataset.pwToggle)return;
  inp.dataset.pwToggle='1';
  var wrap=document.createElement('div');
  wrap.className='pw-wrap';
  inp.parentNode.insertBefore(wrap,inp);
  wrap.appendChild(inp);
  var btn=document.createElement('button');
  btn.type='button';
  btn.className='pw-eye';
  btn.setAttribute('aria-label','Показать пароль');
  btn.innerHTML=_PW_EYE;
  btn.addEventListener('click',function(){
    var show=inp.type==='password';
    inp.type=show?'text':'password';
    btn.innerHTML=show?_PW_EYE_OFF:_PW_EYE;
    btn.setAttribute('aria-label',show?'Скрыть пароль':'Показать пароль');
  });
  wrap.appendChild(btn);
}
