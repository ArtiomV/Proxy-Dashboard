// Извлечено из reset.html (CSP: script-src без unsafe-inline — инлайн-скрипты заблокированы helmet).
var _token=new URLSearchParams(window.location.search).get('token')||'';
if(!_token){
  document.getElementById('rsForm').style.display='none';
  document.getElementById('rsError').textContent='Ссылка недействительна — нет токена';
}else{
  document.getElementById('rsPassword').focus();
}

async function doReset(){
  var err=document.getElementById('rsError');
  var note=document.getElementById('rsNote');
  var btn=document.getElementById('btnReset');
  err.textContent='';note.textContent='';
  var p1=document.getElementById('rsPassword').value;
  var p2=document.getElementById('rsPassword2').value;
  if(p1.length<8){err.textContent='Пароль — минимум 8 символов';return}
  if(p1!==p2){err.textContent='Пароли не совпадают';return}
  btn.disabled=true;
  try{
    var resp=await fetch('/api/reset_password',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:_token,password:p1})
    });
    var data=await resp.json();
    if(!resp.ok){err.textContent=data.error||'Ошибка сброса';return}
    document.getElementById('rsForm').style.display='none';
    note.textContent='Пароль сохранён. Перенаправляем на страницу входа…';
    setTimeout(function(){window.location.href='/'},1500);
  }catch(e){
    err.textContent='Ошибка соединения';
  }finally{
    btn.disabled=false;
  }
}

document.getElementById('rsPassword2').addEventListener('keydown',function(e){if(e.key==='Enter')doReset()});
