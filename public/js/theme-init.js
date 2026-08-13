// public/js/theme-init.js — раннее применение темы ЛК до построения CSSOM.
// client.js грузится в конце body, поэтому без этого файла страница с
// сохранённой светлой темой сначала отрисовывается тёмной (data-theme="dark"
// зашит в <html>) и дёргается при переключении. CSP режет инлайн-скрипты,
// поэтому это отдельный файл, подключённый в <head> до стилей.
(function(){
  var theme='dark';
  try{theme=localStorage.getItem('pr_theme')||'dark';}catch(e){}
  document.documentElement.setAttribute('data-theme',theme);
})();
