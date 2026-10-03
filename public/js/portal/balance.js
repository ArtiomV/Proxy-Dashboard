// public/js/portal/balance.js — 3f «Баланс» + попапы 5d (пополнение, выписка).
// /api/billing_history — баланс, сводка, операции; пополнение картой/СБП —
// /api/client/payments + /api/client/topup (эквайринг, только когда включён);
// счёт для юрлица — /api/client/bill_request (запрос оператору).

var _bal=null;          // ответ billing_history
var _balOpen={};        // открытые месяцы
var _balHover=-1;

function renderBalance(force){
  if(_bal&&!force){_balRender();}
  api('/api/billing_history?limit=5000').then(function(d){
    if(!d||d.error){document.getElementById('balMonths').innerHTML='<div class="v3-emptybox"><div class="t">Не удалось загрузить историю</div><div class="d">'+V3.esc((d&&d.error)||'')+'</div></div>';return}
    _bal=d;_balRender();
  }).catch(function(e){document.getElementById('balMonths').innerHTML='<div class="v3-emptybox"><div class="t">Нет связи с сервером</div><div class="d">'+V3.esc(e.message)+'</div></div>'});
}
function _balCharge(e){
  if(e.type==='charge')return e.cost||0;
  if(e.type==='correction'){return (e.balance_before!=null&&e.balance_after!=null)?(e.balance_before-e.balance_after):(e.amount||0)}
  return 0;
}
var BAL_PAY={payment:1,bank_payment:1,card_payment:1};
function _balKind(e){
  if(e.type==='charge')return e.billing_type==='per_modem'?'Списание за аренду':'Списание за трафик';
  if(e.type==='payment')return 'Оплата';
  if(e.type==='bank_payment')return 'Оплата, банковский перевод';
  if(e.type==='card_payment')return 'Оплата картой / СБП';
  if(e.type==='correction')return 'Корректировка списания';
  if(e.type==='adjustment')return 'Корректировка баланса';
  if(e.type==='payment_reversal')return 'Отмена оплаты';
  if(e.type==='referral_withdraw')return 'Партнёрская комиссия';
  return e.note||e.type||'Операция';
}
function _balAmount(e){
  if(e.type==='charge')return -(e.cost||0);
  if(e.type==='correction')return -_balCharge(e);
  if(e.balance_before!=null&&e.balance_after!=null&&e.type!=='payout')return e.balance_after-e.balance_before;
  return e.amount||0;
}
function _balRender(){
  var d=_bal;if(!d)return;
  var cur=V3.cur(),bal=d.balance||0,sum=d.summary||{},price=(billingData&&billingData.price)||0;
  var entries=(d.entries||[]).slice().sort(function(a,b){return String(b.timestamp||b.date||'').localeCompare(String(a.timestamp||a.date||''))});
  var mk=V3.today().slice(0,7),monthGb=0,monthSpend=0;
  entries.forEach(function(e){if((e.date||'').slice(0,7)===mk){monthSpend+=_balCharge(e);if(e.type==='charge')monthGb+=e.delta_gb||0}});
  var elapsed=Math.max(1,V3.parse(V3.today()).getDate()-1);
  var daySpend=monthSpend>0?monthSpend/elapsed:(sum.avgDailyCharge7d||0);
  var duz=sum.daysUntilZero!=null?sum.daysUntilZero:(daySpend>0&&bal>0?Math.floor(bal/daySpend):null);
  // баннер долга/блокировки (те же состояния, что раньше на «Истории баланса»)
  var ds=d.debtStatus,bb='';
  if(ds&&ds.state==='blocked')bb='<div class="v3-banner bad"><b>Доступ приостановлен за неоплату.</b> Баланс '+V3.money2(ds.balance)+'. После пополнения доступ восстановится автоматически (до ~30 мин).<button class="v3-btn primary sm" type="button" data-on-click="openTopup()">Пополнить</button></div>';
  else if(ds&&ds.state==='debt')bb='<div class="v3-banner bad"><b>Отрицательный баланс: '+V3.money2(ds.balance)+'.</b> При следующем списании прокси будут заблокированы.<button class="v3-btn primary sm" type="button" data-on-click="openTopup()">Пополнить</button></div>';
  else if(ds&&ds.state==='warning')bb='<div class="v3-banner warn"><b>Баланса хватит примерно на '+ds.daysLeft+' дн.</b> Рекомендуем пополнить заранее — при нуле прокси блокируются автоматически.<button class="v3-btn primary sm" type="button" data-on-click="openTopup()">Пополнить</button></div>';
  document.getElementById('balBanner').innerHTML=bb;
  var perGb=!billingData||!billingData.billingType||billingData.billingType==='per_gb';
  var cards=[
    {l:'Баланс',v:V3.money(bal),s:duz!=null&&bal>0?'хватит на ~'+duz+' '+V3.plural(duz,'день','дня','дней'):bal<0?'задолженность':'—',c:bal<0?'red':'',top:bal<0?'red':'green'},
    {l:'Расход за месяц',v:V3.money(monthSpend),s:perGb&&price?V3.group(Math.round(monthGb))+' ГБ × '+V3.num(price,price%1?2:0)+' '+cur:'с 1 числа месяца',top:''},
    {l:'Средний расход в день',v:V3.money(daySpend),s:monthSpend>0?'за '+elapsed+' '+V3.plural(elapsed,'день','дня','дней')+' месяца':'за последние 7 дней',top:''},
    {l:'Дней до нуля',v:duz!=null&&bal>0?String(duz):'—',s:'при текущем темпе',c:'amber',top:'amber'}
  ];
  document.getElementById('balPulse').innerHTML=cards.map(function(c){return '<div class="v3-pulse '+(c.top||'')+'"><div class="v3-pulse-l">'+c.l+'</div><div class="v3-pulse-v">'+c.v+'</div><div class="v3-pulse-s '+(c.c||'')+'">'+c.s+'</div></div>'}).join('');
  // списания по дням — последние 30 дней (не календарный месяц), 03.10
  var t=V3.parse(V3.today()),days=[];
  for(var i=29;i>=0;i--){
    var dd0=V3.addDays(t,-i),ymd=V3.ymd(dd0),ch=0,gb=0,after=null;
    entries.forEach(function(e){if(e.date===ymd&&(e.type==='charge'||e.type==='correction')){ch+=_balCharge(e);if(e.type==='charge')gb+=e.delta_gb||0;if(after==null&&e.balance_after!=null)after=e.balance_after}});
    days.push({ymd:ymd,ch:ch,gb:gb,after:after});
  }
  document.getElementById('balChartNote').textContent='последние 30 дней · '+cur+' в сутки';
  document.getElementById('balTariff').innerHTML=price?'тариф <span class="v3-pill acc">'+V3.num(price,price%1?2:0)+' '+cur+(perGb?'/ГБ':'/мес')+'</span>':'';
  V3.bars(document.getElementById('balChart'),{cls:'h170',height:170,empty:'За последние 30 дней списаний не было',
    bars:days.map(function(x,i){
      var dd=V3.parse(x.ymd);
      return {parts:[{v:x.ch,color:'var(--v3-accent)'}],label:(i===0||(i+1)%5===0)?String(dd.getDate()):'',
        tip:{title:dd.getDate()+' '+V3.MONTHS_GEN[dd.getMonth()]+', '+V3.WD[dd.getDay()],rows:[{name:'Списано',val:'−'+V3.money2(x.ch),cls:'neg'},{name:'Трафик',val:V3.gbv(x.gb)},{name:'Баланс после',val:x.after!=null?V3.money2(x.after):'—'}]}};
    })});
  // история по месяцам
  var months={},order=[];
  entries.forEach(function(e){var k=(e.date||e.timestamp||'').slice(0,7)||'—';if(!months[k]){months[k]={rows:[],gb:0,spent:0,paid:0};order.push(k)}var m=months[k];m.rows.push(e);m.spent+=_balCharge(e);if(e.type==='charge')m.gb+=e.delta_gb||0;if(BAL_PAY[e.type])m.paid+=e.amount||0});
  if(!order.length){document.getElementById('balMonths').innerHTML='<div class="v3-emptybox"><span class="ic acc">₽</span><div class="t">Операций пока нет</div><div class="d">Списания появятся после первых суток работы прокси.</div></div>';return}
  if(!Object.keys(_balOpen).length)_balOpen[order[0]]=true;
  document.getElementById('balMonths').innerHTML=order.map(function(k){
    var m=months[k],p=k.split('-'),name=p.length===2?V3.MONTHS_T[+p[1]-1]+' '+p[0]:k;
    var h='<div class="v3-month'+(_balOpen[k]?' open':'')+'"><div class="v3-month-h" data-on-click="balToggle('+V3.q(k)+')"><span class="chev">›</span>'+name+
      '<span class="sums"><span class="g">'+(m.gb>0?V3.gbv(m.gb):'')+'</span><span class="s">'+(m.spent>0?'−'+V3.money(m.spent):'')+'</span><span class="p">'+(m.paid>0?'+'+V3.money(m.paid):'')+'</span></span></div>';
    if(_balOpen[k]){
      h+='<div class="v3-month-b"><div class="v3-table-wrap"><table class="v3-table"><thead><tr><th>Дата</th><th>Операция</th><th class="r">Трафик</th><th class="r">Сумма</th><th class="r">Баланс после</th></tr></thead><tbody>'+
        m.rows.map(function(e,i){
          var a=_balAmount(e),dt=e.date?V3.dm(e.date):'—';
          return '<tr'+(i%2?' class="z"':'')+' title="'+V3.esc(e.note||'')+'"><td class="mono mut">'+dt+'</td><td class="txt">'+V3.esc(_balKind(e))+'</td><td class="r mono mut">'+(e.delta_gb?V3.gbv(e.delta_gb):'—')+'</td><td class="r mono b" style="color:'+(a<0?'var(--v3-red)':'var(--v3-green)')+'">'+(a<0?'−':'+')+V3.money2(Math.abs(a))+'</td><td class="r mono ink">'+(e.balance_after!=null?V3.money2(e.balance_after):'—')+'</td></tr>';
        }).join('')+'</tbody></table></div></div>';
    }
    return h+'</div>';
  }).join('');
}
function balToggle(k){if(_balOpen[k])delete _balOpen[k];else _balOpen[k]=true;_balRender()}

// ================= Пополнение (5d) =================
var _tp={tab:null,amount:60000,info:null,profile:null};
function openTopup(){
  V3.modal('<div id="tpRoot"><div class="v3-mb"><div class="v3-skel" style="height:220px"></div></div></div>',{width:'w460'});
  var online=retailConfig&&retailConfig.retail_enabled;
  Promise.all([
    online?api('/api/client/payments').catch(function(){return null}):Promise.resolve(null),
    api('/api/client/profile').catch(function(){return null})
  ]).then(function(res){
    _tp.info=res[0]&&res[0].topup?res[0].topup:null;_tp.profile=res[1]&&!res[1].error?res[1]:null;
    var onlineOk=_tp.info&&_tp.info.enabled;
    _tp.tab=onlineOk?'card':'bill';
    if(onlineOk&&_tp.info.min&&_tp.amount<_tp.info.min)_tp.amount=_tp.info.min;
    if(window._topupPrefill){_tp.amount=window._topupPrefill;window._topupPrefill=null}
    _tpRender();
  });
}
function tpTab(t){_tp.tab=t;_tpRender()}
function tpPreset(v){_tp.amount=v;_tpRender()}
function tpAmount(v){_tp.amount=parseInt(String(v).replace(/\D/g,''),10)||0;_tpSummary()}
function _tpSummary(){
  var el=document.getElementById('tpSum');if(!el)return;
  var a=_tp.amount,bal=(_bal&&_bal.balance)||(billingData&&billingData.balance)||0;
  var day=(_bal&&_bal.summary&&_bal.summary.avgDailyCharge7d)||0,price=(billingData&&billingData.price)||0;
  var rows=_tp.tab==='bill'
    ?[['Сумма счёта',V3.money(a)],['Срок оплаты','5 рабочих дней'],['Акт','в конце месяца']]
    :[['Хватит примерно на',day>0?'~'+Math.floor(a/day)+' '+V3.plural(Math.floor(a/day),'день','дня','дней'):'—'],['Это трафик',price>0?V3.group(Math.floor(a/price))+' ГБ':'—'],['Баланс станет',V3.money(bal+a)]];
  el.innerHTML=rows.map(function(r){return '<div><span>'+r[0]+'</span><span>'+r[1]+'</span></div>'}).join('');
  var cta=document.getElementById('tpCta');
  if(cta)cta.textContent=_tp.tab==='bill'?'Запросить счёт':'Оплатить '+V3.money(a);
}
function _tpRender(){
  var root=document.getElementById('tpRoot');if(!root)return;
  var onlineOk=_tp.info&&_tp.info.enabled,p=_tp.profile||{};
  var h=V3.mh('Пополнить баланс');
  h+='<div class="v3-tabs">'+[['card','Картой'],['sbp','СБП'],['bill','Счёт для юрлица']].map(function(t){return '<button type="button" class="v3-tab'+(_tp.tab===t[0]?' on':'')+'" data-on-click="tpTab(\''+t[0]+'\')">'+t[1]+'</button>'}).join('')+'</div>';
  h+='<div class="v3-mb">';
  if(_tp.tab!=='bill'&&!onlineOk){
    h+='<div class="v3-emptybox bare"><span class="ic acc">₽</span><div class="t">Онлайн-оплата недоступна</div><div class="d">'+(_tp.info&&!_tp.info.emailVerified?'Подтвердите email в профиле — на него приходит чек об оплате.':'Пополните баланс по счёту — сформируем его за вас.')+'</div><button type="button" class="v3-btn primary" data-on-click="tpTab(\'bill\')">Счёт для юрлица</button></div></div>';
    root.innerHTML=h;return;
  }
  var presets=[10000,30000,60000,100000];
  h+='<div class="v3-field"><span class="v3-label">Сумма</span><label class="v3-amount"><input inputmode="numeric" value="'+V3.group(_tp.amount)+'" data-on-input="tpAmount(this.value)"><span class="u">₽</span></label>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap">'+presets.map(function(v){return '<button type="button" class="v3-chip'+(_tp.amount===v?' on':'')+'" data-on-click="tpPreset('+v+')">'+V3.group(v)+'</button>'}).join('')+'</div>'+
    (_tp.tab!=='bill'&&_tp.info?'<span class="v3-note">От '+V3.money(_tp.info.min||100)+' до '+V3.money(_tp.info.max||100000)+(_tp.tab==='sbp'?' · СБП — комиссия ниже':'')+'</span>':'')+'</div>';
  if(_tp.tab==='bill'){
    var payer=(p.legal&&p.legal.name)||p.name||'—';
    h+='<div class="v3-field"><span class="v3-label">Плательщик</span><div class="v3-box" style="font-size:12px;line-height:1.55">'+V3.esc(payer)+(p.legal&&p.legal.inn?' · ИНН '+V3.esc(p.legal.inn):'')+'<br>'+(p.email?'Счёт уйдёт на '+V3.esc(p.email):'Менеджер пришлёт счёт в рабочем чате')+'</div></div>';
  }
  h+='<div class="v3-sum" id="tpSum"></div><div id="tpStatus" class="v3-note"></div></div>';
  h+='<div class="v3-mf"><button type="button" class="v3-btn primary" id="tpCta" data-on-click="tpSubmit()"></button></div>';
  root.innerHTML=h;_tpSummary();
}
function tpSubmit(){
  var a=_tp.amount,btn=document.getElementById('tpCta'),st=document.getElementById('tpStatus');
  if(!(a>0)){st.textContent='Укажите сумму';st.style.color='var(--v3-red)';return}
  btn.disabled=true;
  if(_tp.tab==='bill'){
    api('/api/client/bill_request',{method:'POST',json:{amount:a}}).then(function(d){
      btn.disabled=false;
      if(!d||!d.ok){st.textContent=(d&&d.error)||'Не удалось отправить запрос';st.style.color='var(--v3-red)';return}
      document.getElementById('tpRoot').innerHTML='<div class="v3-dlg"><span class="ic ok">✓</span><h3>Запрос счёта отправлен</h3><p>Менеджер выставит счёт '+(d.email?'и пришлёт его на '+V3.esc(d.email):'и пришлёт его вам')+'. Баланс пополнится после поступления оплаты, обычно в течение рабочего дня. Счёт появится в разделе «Документы».</p><div class="v3-sum"><div><span>Сумма</span><span>'+V3.money(a)+'</span></div></div></div><div class="v3-mf"><button type="button" class="v3-btn" data-on-click="v3CloseModal()">Закрыть</button><button type="button" class="v3-btn primary" data-on-click="v3CloseModal();v3Go(\'documents\')">Открыть документы</button></div>';
    }).catch(function(){btn.disabled=false;st.textContent='Ошибка соединения';st.style.color='var(--v3-red)'});
    return;
  }
  api('/api/client/topup',{method:'POST',json:{amount:a,method:_tp.tab==='sbp'?'sbp':'card'}}).then(function(d){
    if(d&&d.ok&&d.confirmation_url){st.textContent='Счёт создан — переходим к оплате…';st.style.color='var(--v3-green)';window.location.href=d.confirmation_url;return}
    btn.disabled=false;
    st.textContent=(d&&d.error)||'Ошибка создания платежа';st.style.color='var(--v3-red)';
    if(d&&d.code==='EMAIL_NOT_VERIFIED'){V3.closeModal();v3Go('profile')}
  }).catch(function(){btn.disabled=false;st.textContent='Ошибка соединения';st.style.color='var(--v3-red)'});
}
// старые вызовы (витрина: «недостаточно средств»)
function gotoBilling(){v3Go('billing');setTimeout(openTopup,200)}

// ================= Выписка (5d) =================
var _st={fmt:'pdf',split:true};
function openStatement(){
  var t=V3.parse(V3.today());
  var from=V3.ymd(new Date(t.getFullYear(),Math.floor(t.getMonth()/3)*3,1)),to=V3.today();
  V3.modal(V3.mh('Выписка по балансу')+'<div class="v3-mb" id="stBody"></div><div class="v3-mf"><button type="button" class="v3-btn primary" id="stGo" data-on-click="stDownload()">Скачать</button></div>',{width:'w420'});
  document.getElementById('stBody').innerHTML='<div class="v3-field"><span class="v3-label">Период</span><div style="display:flex;align-items:center;gap:8px"><input type="date" class="v3-input mono" id="stFrom" value="'+from+'" max="'+to+'" style="flex:1"><span style="color:var(--v3-faint)">—</span><input type="date" class="v3-input mono" id="stTo" value="'+to+'" max="'+to+'" style="flex:1"></div></div>'+
    '<div class="v3-field"><span class="v3-label">Формат</span><span class="v3-seg" style="align-self:flex-start" id="stFmt"></span></div>'+
    '<span class="v3-check-row" style="font-size:12px" data-on-click="stSplit()"><span class="v3-check" id="stSplitCk"></span>Разбивка списаний по прокси</span>';
  _stDraw();
}
function _stDraw(){
  document.getElementById('stFmt').innerHTML=[['pdf','PDF'],['xls','Excel'],['csv','CSV']].map(function(f){return '<button type="button" class="'+(_st.fmt===f[0]?'on':'')+'" data-on-click="stFmt(\''+f[0]+'\')">'+f[1]+'</button>'}).join('');
  document.getElementById('stSplitCk').classList.toggle('on',_st.split);
}
function stFmt(f){_st.fmt=f;_stDraw()}
function stSplit(){_st.split=!_st.split;_stDraw()}
function stDownload(){
  var from=document.getElementById('stFrom').value,to=document.getElementById('stTo').value;
  if(!from||!to||from>to){V3.toast({kind:'err',title:'Проверьте период'});return}
  var btn=document.getElementById('stGo');btn.disabled=true;btn.textContent='Готовим…';
  var hist=_bal?Promise.resolve(_bal):api('/api/billing_history?limit=5000');
  Promise.all([hist,_st.split?V3.daily(from,to).catch(function(){return {byDate:{}}}):Promise.resolve(null)]).then(function(res){
    _bal=res[0];
    var ent=(res[0].entries||[]).filter(function(e){return e.date&&e.date>=from&&e.date<=to}).sort(function(a,b){return String(a.timestamp||a.date).localeCompare(String(b.timestamp||b.date))});
    var rows=[];
    ent.forEach(function(e){
      var a=_balAmount(e);
      rows.push({date:V3.dmy(e.date),kind:_balKind(e),gb:e.delta_gb||null,amount:a,after:e.balance_after,note:e.note||'',sub:false});
      if(_st.split&&e.type==='charge'&&res[1]){
        var day=res[1].byDate[e.date]||{},tot=0,parts=[];
        for(var pid in day){var v=day[pid].in+day[pid].out;if(v>0){tot+=v;parts.push({nick:V3.portInfo(pid,day[pid].nick).nick,v:v})}}
        parts.sort(function(x,y){return y.v-x.v}).forEach(function(p){
          rows.push({date:'',kind:'  в т.ч. '+p.nick,gb:(e.delta_gb||0)*p.v/tot,amount:-(e.cost||0)*p.v/tot,after:null,note:'пропорционально трафику порта',sub:true});
        });
      }
    });
    var who=(typeof authLogin!=='undefined'?authLogin:'client'),title='Выписка по балансу · '+V3.dmy(from)+' — '+V3.dmy(to);
    var num=function(v,d){return v==null?'':Number(v).toFixed(d)};
    if(_st.fmt==='csv'){
      var q=function(v){v=String(v==null?'':v);return /[";\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
      var lines=['Дата;Операция;Трафик, ГБ;Сумма, ₽;Баланс после, ₽;Примечание'].concat(rows.map(function(r){return [r.date,r.kind,num(r.gb,3),num(r.amount,2),num(r.after,2),r.note].map(q).join(';')}));
      V3.download('﻿'+lines.join('\n'),'statement_'+from+'_'+to+'.csv','text/csv');
    }else if(_st.fmt==='xls'){
      var x=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')};
      var cell=function(v,t){return v==null||v===''?'<Cell/>':'<Cell><Data ss:Type="'+(t||'String')+'">'+x(v)+'</Data></Cell>'};
      var xml='<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Выписка"><Table>'+
        '<Row>'+cell(title)+'</Row><Row/><Row>'+['Дата','Операция','Трафик, ГБ','Сумма, ₽','Баланс после, ₽','Примечание'].map(function(h){return cell(h)}).join('')+'</Row>'+
        rows.map(function(r){return '<Row>'+cell(r.date)+cell(r.kind)+(r.gb!=null?cell(num(r.gb,3),'Number'):'<Cell/>')+cell(num(r.amount,2),'Number')+(r.after!=null?cell(num(r.after,2),'Number'):'<Cell/>')+cell(r.note)+'</Row>'}).join('')+
        '</Table></Worksheet></Workbook>';
      V3.download(xml,'statement_'+from+'_'+to+'.xls','application/vnd.ms-excel');
    }else{
      var html='<!doctype html><html><head><meta charset="utf-8"><title>'+V3.esc(title)+'</title><style>body{font:12px Inter,Arial,sans-serif;color:#10151f;margin:24px}h1{font-size:16px;margin:0 0 4px}p{color:#697587;margin:0 0 16px}table{width:100%;border-collapse:collapse}th{background:#e8eaef;color:#697587;font-size:10px;text-transform:uppercase;text-align:left;padding:6px 8px}td{padding:6px 8px;border-bottom:1px solid #eceff3}.r{text-align:right;font-family:monospace}.sub td{color:#697587;font-size:11px}.neg{color:#dc3a34}.pos{color:#16a34a}</style></head><body>'+
        '<h1>'+V3.esc(title)+'</h1><p>Клиент: '+V3.esc(who)+' · сформировано '+new Date().toLocaleString('ru-RU')+'</p><table><thead><tr><th>Дата</th><th>Операция</th><th class="r">Трафик</th><th class="r">Сумма</th><th class="r">Баланс после</th></tr></thead><tbody>'+
        rows.map(function(r){return '<tr'+(r.sub?' class="sub"':'')+'><td>'+V3.esc(r.date)+'</td><td>'+V3.esc(r.kind)+'</td><td class="r">'+(r.gb!=null?V3.esc(V3.gbv(r.gb)):'—')+'</td><td class="r '+(r.amount<0?'neg':'pos')+'">'+(r.amount<0?'−':'+')+V3.esc(V3.money2(Math.abs(r.amount)))+'</td><td class="r">'+(r.after!=null?V3.esc(V3.money2(r.after)):'')+'</td></tr>'}).join('')+
        '</tbody></table></body></html>';
      var fr=document.createElement('iframe');fr.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';document.body.appendChild(fr);
      fr.contentDocument.open();fr.contentDocument.write(html);fr.contentDocument.close();
      setTimeout(function(){try{fr.contentWindow.focus();fr.contentWindow.print()}catch(e){V3.toast({kind:'err',title:'Печать недоступна'})}setTimeout(function(){fr.remove()},60000)},300);
      V3.toast({kind:'info',title:'Выберите «Сохранить как PDF» в окне печати'});
    }
    btn.disabled=false;btn.textContent='Скачать';
    if(_st.fmt!=='pdf')V3.toast({title:'Выписка скачана',text:rows.length+' '+V3.plural(rows.length,'строка','строки','строк')});
  }).catch(function(e){btn.disabled=false;btn.textContent='Скачать';V3.toast({kind:'err',title:'Не удалось сформировать выписку',text:e.message})});
}
