// Извлечено из verify.html (CSP: script-src без unsafe-inline — инлайн-скрипты заблокированы helmet).
// Подтверждение — автоматически по ?token= из письма (ссылка живёт 24ч)
(async function(){
  var st=document.getElementById('vfStatus');
  var btn=document.getElementById('vfBtn');
  var token=new URLSearchParams(window.location.search).get('token')||'';
  if(!token){
    st.textContent='Ссылка недействительна — нет токена';
    st.className='auth-note fail';
    btn.style.display='block';
    return;
  }
  try{
    var resp=await fetch('/api/verify_email',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token})
    });
    if(resp.ok){
      st.textContent='Email подтверждён. Теперь вы можете покупать прокси.';
      st.className='auth-note ok';
    }else{
      var data=await resp.json();
      st.textContent=data.error||'Ссылка недействительна или устарела';
      st.className='auth-note fail';
    }
  }catch(e){
    st.textContent='Ошибка соединения — попробуйте открыть ссылку ещё раз';
    st.className='auth-note fail';
  }
  btn.style.display='block';
})();
