// public/js/portal/docs.js — 3g «Документы»: закрывающие документы (акты),
// счета на оплату, загруженные документы (договоры). PDF — через API с
// заголовком авторизации (blob), без токена в URL.

var _docs=null;
function _docPeriod(p){
  if(!p)return '—';
  if(/^\d{4}-\d{2}$/.test(p)){var x=p.split('-');return V3.MONTHS[+x[1]-1]+' '+x[0]}
  return p;
}
function v3DocsBadge(){
  if(!_docs)return _docsLoad().then(v3DocsBadge);
  var n=_docs.bills.filter(function(b){return b.status!=='paid'}).length+_docs.acts.filter(function(d){return d.status!=='signed'}).length;
  var el=document.getElementById('navCountDocs');if(el)el.textContent=n?String(n):'';
}
function _docsLoad(){
  return Promise.all([
    api('/api/client/closing_documents').catch(function(){return null}),
    api('/api/client/bills').catch(function(){return null}),
    api('/api/client/documents').catch(function(){return null})
  ]).then(function(r){
    _docs={acts:(r[0]&&r[0].documents)||[],bills:(r[1]&&r[1].bills)||[],files:Array.isArray(r[2])?r[2]:[],failed:!r[0]&&!r[1]&&!r[2]};
    return _docs;
  });
}
function renderDocuments(){
  _docsLoad().then(function(d){v3DocsBadge();_docsRender(d)});
}
function _docsRender(d){
  var unpaid=d.bills.filter(function(b){return b.status!=='paid'}).length;
  document.getElementById('docHeadChip').innerHTML=unpaid?'<span class="v3-chip bad static">'+unpaid+' '+V3.plural(unpaid,'счёт не оплачен','счёта не оплачены','счетов не оплачено')+'</span>':'';
  if(d.failed){document.getElementById('docBody').innerHTML='<div class="v3-emptybox"><div class="t">Не удалось загрузить документы</div></div>';return}
  var acts=d.acts.slice().sort(function(a,b){return String(b.period||'').localeCompare(String(a.period||''))});
  var bills=d.bills.slice().sort(function(a,b){return String(b.period||b.createdAt||'').localeCompare(String(a.period||a.createdAt||''))});
  var files=d.files.slice().sort(function(a,b){return String(b.date||'').localeCompare(String(a.date||''))});
  var sections=[
    {title:'Закрывающие документы',empty:'Акты формируются по итогам каждого месяца после подписания договора.',rows:acts.map(function(a){
      var ok=a.status==='signed';
      return {name:a.actNumber?'Акт № '+a.actNumber:'Акт',period:_docPeriod(a.period),sum:V3.money2(a.totalAmount||0),st:ok?['подписан','green']:['не подписан','red'],dl:'docAct('+V3.q(a.id)+','+V3.q(a.actNumber||'act')+')'};
    })},
    {title:'Счета на оплату',empty:'Счета выставляются по запросу — «Баланс» → «Пополнить» → «Счёт для юрлица».',rows:bills.map(function(b){
      var ok=b.status==='paid';
      return {name:b.billNumber?'Счёт № '+b.billNumber:'Счёт',period:_docPeriod(b.period),sum:V3.money2(b.amount||0),st:ok?['оплачен','green']:['не оплачен','red'],dl:b.hasPdf===false?'':'docBill('+V3.q(b.id)+','+V3.q(b.billNumber||'bill')+')'};
    })},
    {title:'Загруженные документы',empty:'Договор и другие документы появятся здесь после подписания.',rows:files.map(function(f){
      return {name:f.name,period:f.date?'от '+V3.date(f.date):'—',sum:'—',st:['действует','acc'],dl:'docFile('+V3.q(f.id)+','+V3.q(f.name)+')'};
    })}
  ];
  document.getElementById('docBody').innerHTML=sections.map(function(s){
    var h='<div class="v3-card mb12"><h3 style="margin-bottom:10px">'+s.title+'</h3>';
    if(!s.rows.length)return h+'<div class="v3-empty">'+s.empty+'</div></div>';
    return h+'<div class="v3-table-wrap"><table class="v3-table"><thead><tr><th>Документ</th><th>Период</th><th class="r">Сумма</th><th>Статус</th><th class="r">Файл</th></tr></thead><tbody>'+
      s.rows.map(function(r,i){
        return '<tr'+(i%2?' class="z"':'')+'><td class="ink b wrap">'+V3.esc(r.name)+'</td><td class="mut">'+V3.esc(r.period)+'</td><td class="r mono ink">'+r.sum+'</td><td><span class="v3-pill '+r.st[1]+'">'+r.st[0]+'</span></td><td class="r">'+(r.dl?'<button type="button" class="v3-btn sm link" data-on-click="'+r.dl+'">Скачать PDF</button>':'<span class="v3-note">PDF нет</span>')+'</td></tr>';
      }).join('')+'</tbody></table></div></div>';
  }).join('')+_docSlaCard();
}
// 03.10: SLA-отчёт за месяц — печатная страница (для юрлиц/апселла).
// Данные — /api/client/sla_report (та же методология, что аптайм в ЛК).
function _docSlaCard(){
  var months=[],t=new Date();
  for(var i=0;i<3;i++){months.push(t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0'));t=new Date(t.getFullYear(),t.getMonth()-1,1)}
  return '<div class="v3-card mb12"><h3 style="margin-bottom:10px">SLA-отчёт</h3>'+
    '<div class="v3-note" style="margin-bottom:10px">Доступность ваших прокси по месяцам: доля успешных проверок, простои по дням. Открывается печатной страницей — можно сохранить в PDF.</div>'+
    '<div class="v3-table-wrap"><table class="v3-table"><thead><tr><th>Отчёт</th><th>Период</th><th class="r">Открыть</th></tr></thead><tbody>'+
    months.map(function(m,i){
      return '<tr'+(i%2?' class="z"':'')+'><td class="ink b">SLA-отчёт</td><td class="mut">'+_docPeriod(m)+'</td><td class="r"><button type="button" class="v3-btn sm link" data-on-click="docSla('+V3.q(m)+')">Открыть / Печать</button></td></tr>';
    }).join('')+'</tbody></table></div></div>';
}
function docSla(month){
  V3.toast({kind:'info',title:'Готовим отчёт…',ms:1500});
  api('/api/client/sla_report?month='+encodeURIComponent(month)).then(function(d){
    if(!d||d.error)throw new Error((d&&d.error)||'Нет данных за месяц');
    var s=d.summary||{},days=(d.days||[]).filter(function(x){return x.failed_checks>0});
    var rows=days.length?days.map(function(x){
      return '<tr><td>'+x.day+'</td><td style="text-align:right">'+(x.uptime_pct!=null?x.uptime_pct+'%':'—')+'</td><td style="text-align:right">'+x.failed_checks+'</td></tr>';
    }).join(''):'<tr><td colspan="3" style="text-align:center;color:#666">Простоев не зафиксировано</td></tr>';
    var w=window.open('','_blank');
    if(!w){V3.toast({kind:'err',title:'Разрешите всплывающие окна'});return}
    w.document.write('<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>SLA-отчёт — '+_docPeriod(month)+'</title><style>'+
      'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111}'+
      'h1{font-size:20px;margin-bottom:4px}h2{font-size:14px;margin:24px 0 8px}.muted{color:#666;font-size:12px}'+
      '.big{font-size:34px;font-weight:700;margin:12px 0}table{width:100%;border-collapse:collapse;font-size:12px}'+
      'td,th{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left}th{color:#666;text-transform:uppercase;font-size:10px}'+
      '@media print{.noprint{display:none}}</style></head><body>'+
      '<div class="muted">arendaproxy.ru · отчёт сформирован '+new Date().toLocaleString('ru-RU')+'</div>'+
      '<h1>SLA-отчёт — '+_docPeriod(month)+'</h1>'+
      '<div class="big">'+(s.uptime_pct!=null?s.uptime_pct+'%':'нет данных')+'</div>'+
      '<div class="muted">доступность прокси ('+(s.modems||0)+' шт.) · проверок: '+(s.checks||0)+', из них неуспешных: '+(s.failed_checks||0)+'</div>'+
      '<h2>Дни с простоями</h2><table><thead><tr><th>Дата</th><th style="text-align:right">Доступность</th><th style="text-align:right">Неуспешных проверок</th></tr></thead><tbody>'+rows+'</tbody></table>'+
      '<h2>Методология</h2><div class="muted">Доступность = доля успешных периодических проверок каждого прокси за период его аренды. Плановые окна и периоды исчерпания операторского пакета из расчёта исключены.</div>'+
      '<p class="noprint" style="margin-top:24px"><button id="slaPrintBtn" style="padding:8px 16px">Печать / Сохранить в PDF</button></p>'+
      '</body></html>');
    w.document.close();
    // delegation-правило: без инлайн-обработчиков даже в сгенерированном окне
    var pb=w.document.getElementById('slaPrintBtn');
    if(pb)pb.addEventListener('click',function(){w.print()});
  }).catch(function(e){V3.toast({kind:'err',title:'Отчёт не готов',text:e.message})});
}
// скачивание файла с авторизацией заголовком
V3.fetchFile=function(url,name){
  V3.toast({kind:'info',title:'Готовим файл…',ms:2000});
  fetch(url,{headers:{'X-Auth-Token':authToken}}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return {}}).then(function(j){throw new Error(j.error||('Ошибка '+r.status))});
    return r.blob();
  }).then(function(b){
    var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},1000);
  }).catch(function(e){V3.toast({kind:'err',title:'Файл недоступен',text:e.message})});
};
function docAct(id,num){V3.fetchFile('/api/client/closing_documents/'+encodeURIComponent(id)+'/pdf',num+'.pdf')}
function docBill(id,num){V3.fetchFile('/api/client/bills/'+encodeURIComponent(id)+'/pdf',num+'.pdf')}
function docFile(id,name){V3.fetchFile('/api/client/documents/'+encodeURIComponent(id)+'/download',name)}
