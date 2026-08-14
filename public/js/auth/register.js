// Извлечено из register.html (CSP: script-src без unsafe-inline — инлайн-скрипты заблокированы helmet).
// Telegram-вход — OIDC-кнопка из /js/auth-utils.js (старый iframe-виджет
// oauth.telegram.org Telegram отключил: попап /auth отвечает «deprecated»).
var _cfg=null;
var _ref=new URLSearchParams(window.location.search).get('ref')||'';

// Виджеты подключаем только если включена розница и заданы ключи
(async function init(){
  try{
    var resp=await fetch('/api/public/auth_config');
    _cfg=await resp.json();
  }catch(e){_cfg={retail_enabled:false}}
  if(!_cfg||!_cfg.retail_enabled){
    document.getElementById('regClosed').style.display='block';
    return;
  }
  document.getElementById('regForm').style.display='block';
  if(_cfg.turnstile_site_key){
    var d=document.createElement('div');
    d.className='cf-turnstile';
    d.setAttribute('data-sitekey',_cfg.turnstile_site_key);
    d.setAttribute('data-theme','dark');
    document.getElementById('turnstileWrap').appendChild(d);
    var s=document.createElement('script');
    s.src='https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async=true;s.defer=true;
    document.head.appendChild(s);
  }
  if(_cfg.telegram_oidc_enabled){
    renderTelegramLoginButton('tgWrap','Войти через Telegram');
  }
  addPasswordToggle('regPassword');
  document.getElementById('regEmail').focus();
})();

function _saveSession(data){
  localStorage.setItem('pr_token',data.token);
  localStorage.setItem('pr_login',data.login);
  window.location.href='/';
}

async function doRegister(){
  var err=document.getElementById('regError');
  var note=document.getElementById('regNote');
  var btn=document.getElementById('btnRegister');
  err.textContent='';note.textContent='';
  var email=document.getElementById('regEmail').value.trim();
  var password=document.getElementById('regPassword').value;
  var consent=document.getElementById('regConsent').checked;
  if(!email){err.textContent='Введите email';return}
  if(password.length<8){err.textContent='Пароль — минимум 8 символов';return}
  if(!consent){err.textContent='Подтвердите согласие с условиями';return}
  var turnstileToken='';
  var tsInput=document.querySelector('#turnstileWrap [name="cf-turnstile-response"]');
  if(tsInput)turnstileToken=tsInput.value;
  btn.disabled=true;
  try{
    var resp=await fetch('/api/register',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        email:email,password:password,consent:true,
        ref:_ref||undefined,
        turnstile:turnstileToken||undefined,
        website:document.getElementById('regWebsite').value
      })
    });
    var data=await resp.json();
    if(!resp.ok){err.textContent=data.error||'Ошибка регистрации';return}
    if(!data.token){ // honeypot-«успех»: сервер вернул {ok:true} без сессии
      note.textContent='Проверьте почту — мы отправили письмо с подтверждением.';
      return;
    }
    note.textContent='Аккаунт создан! Проверьте почту для подтверждения email.';
    _saveSession(data);
  }catch(e){
    err.textContent='Ошибка соединения';
  }finally{
    btn.disabled=false;
  }
}

document.getElementById('regPassword').addEventListener('keydown',function(e){if(e.key==='Enter')doRegister()});
