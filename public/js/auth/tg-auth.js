// Посадочная Telegram OIDC-входа: после callback'а сессия уже в httpOnly-cookie
// (pr_session). Забираем raw-токен из /api/auth/session_token (он читает cookie
// сервер-side) и кладём в localStorage — основной транспорт auth у клиента
// (X-Auth-Token, см. client.js).
(async function(){
  var err=document.getElementById('tgAuthError');
  var note=document.getElementById('tgAuthNote');
  var links=document.getElementById('tgAuthLinks');
  var q=new URLSearchParams(window.location.search);
  function fail(msg){
    note.textContent='';
    err.textContent=msg;
    links.style.display='';
  }
  if(q.get('error')){fail(q.get('error'));return}
  try{
    var resp=await fetch('/api/auth/session_token');
    var data=await resp.json();
    if(!resp.ok||!data.token){fail((data&&data.error)||'Сессия не найдена — войдите ещё раз');return}
    localStorage.setItem('pr_token',data.token);
    localStorage.setItem('pr_login',data.login);
    window.location.replace('/');
  }catch(e){
    fail('Ошибка соединения');
  }
})();
