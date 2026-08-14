// Извлечено из register.html (CSP: script-src без unsafe-inline — инлайн-скрипты заблокированы helmet).
// Telegram Login Widget БЕЗ telegram-widget.js: он разбирает data-onauth через
// eval(), что запрещено нашим CSP (script-src без unsafe-eval) — виджет молча
// не рендерился. Рендерим iframe oauth.telegram.org напрямую и ловим
// postMessage {event:'auth_user', auth_data} — протокол виджета (widget.js:315).
function mountTelegramLogin(wrapId, botUsername, onAuth){
  var wrap=document.getElementById(wrapId);
  if(!wrap||!botUsername)return;
  var ifr=document.createElement('iframe');
  ifr.src='https://oauth.telegram.org/embed/'+encodeURIComponent(botUsername)
    +'?origin='+encodeURIComponent(location.origin)
    +'&return_to='+encodeURIComponent(location.href)
    +'&size=large&request_access=write';
  ifr.width=238; ifr.height=40;
  ifr.setAttribute('frameborder','0');
  ifr.setAttribute('scrolling','no');
  ifr.style.border='none'; ifr.style.overflow='hidden';
  wrap.appendChild(ifr);
  window.addEventListener('message',function(e){
    if(e.origin!=='https://oauth.telegram.org')return;
    var d=e.data;
    if(typeof d==='string'){try{d=JSON.parse(d)}catch(_){return}}
    if(d&&d.event==='auth_user'&&!d.init&&d.auth_data)onAuth(d.auth_data);
  });
}
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
  if(_cfg.telegram_bot_username){
    mountTelegramLogin('tgWrap', _cfg.telegram_bot_username, onTelegramAuth);
  }
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

// Telegram Login Widget callback (глобальное имя — так требует виджет)
async function onTelegramAuth(user){
  var err=document.getElementById('regError');
  err.textContent='';
  try{
    var resp=await fetch('/api/auth/telegram',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(user)
    });
    var data=await resp.json();
    if(!resp.ok){err.textContent=data.error||'Ошибка входа через Telegram';return}
    _saveSession(data);
  }catch(e){
    err.textContent='Ошибка соединения';
  }
}

document.getElementById('regPassword').addEventListener('keydown',function(e){if(e.key==='Enter')doRegister()});
