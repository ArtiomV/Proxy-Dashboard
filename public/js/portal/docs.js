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
  }).join('');
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
