// Извлечено из forgot.html (CSP: script-src без unsafe-inline — инлайн-скрипты заблокированы helmet).
// Turnstile подключаем, только если розница включена и задан site-key
(async function init(){
  var cfg=null;
  try{
    var resp=await fetch('/api/public/auth_config');
    cfg=await resp.json();
  }catch(e){cfg={retail_enabled:false}}
  if(!cfg||!cfg.retail_enabled){
    document.getElementById('fgClosed').style.display='block';
    return;
  }
  document.getElementById('fgForm').style.display='block';
  if(cfg.turnstile_site_key){
    var d=document.createElement('div');
    d.className='cf-turnstile';
    d.setAttribute('data-sitekey',cfg.turnstile_site_key);
    d.setAttribute('data-theme','dark');
    document.getElementById('turnstileWrap').appendChild(d);
    var s=document.createElement('script');
    s.src='https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async=true;s.defer=true;
    document.head.appendChild(s);
  }
  document.getElementById('fgEmail').focus();
})();

async function doForgot(){
  var err=document.getElementById('fgError');
  var note=document.getElementById('fgNote');
  var btn=document.getElementById('btnForgot');
  err.textContent='';note.textContent='';
  var email=document.getElementById('fgEmail').value.trim();
  if(!email){err.textContent='Введите email';return}
  var turnstileToken='';
  var tsInput=document.querySelector('#turnstileWrap [name="cf-turnstile-response"]');
  if(tsInput)turnstileToken=tsInput.value;
  btn.disabled=true;
  try{
    var resp=await fetch('/api/forgot_password',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:email,turnstile:turnstileToken||undefined})
    });
    var data=await resp.json();
    if(!resp.ok){err.textContent=data.error||'Ошибка отправки';return}
    // Ответ одинаковый независимо от наличия аккаунта — так задумано на сервере
    note.textContent='Если аккаунт существует — письмо отправлено. Проверьте почту.';
    document.getElementById('fgEmail').value='';
  }catch(e){
    err.textContent='Ошибка соединения';
  }finally{
    btn.disabled=false;
  }
}

document.getElementById('fgEmail').addEventListener('keydown',function(e){if(e.key==='Enter')doForgot()});
