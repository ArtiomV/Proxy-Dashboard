// public/js/portal/export.js — 3c «Экспорт реквизитов» (+ 5b): 4 вкладки
// (Базовые · Для разработчиков · Системные · Свой шаблон), протокол, ссылка
// смены IP, что выгружаем (выбранные / все / страна), предпросмотр, копирование
// и скачивание. Генерация — на клиенте из tableData (реквизиты уже в
// dashboard_data); пароль в файле не маскируется.

var EX_FORMATS={
  basic:[['txt','login:pass@ip:port','Generic TXT','.txt'],['ipfirst','ip:port:login:pass','Dolphin, AdsPower','.txt'],['url','URL','http://login:pass@ip:port','.txt'],['csv','CSV','с заголовками','.csv']],
  dev:[['py','Python','requests, список','.py'],['node','Node.js','undici ProxyAgent','.js'],['curl','cURL','команда на прокси','.sh'],['json','JSON','массив объектов','.json']],
  sys:[['ppx','Proxifier','профиль .ppx','.ppx'],['foxy','FoxyProxy','импорт JSON','.json'],['omega','SwitchyOmega','резервная копия','.bak'],['pac','PAC-файл','для браузера и ОС','.pac']]
};
var EX_TABS=[['basic','Базовые'],['dev','Для разработчиков'],['sys','Системные'],['tpl','Свой шаблон']];
var EX_HINT={
  basic:'Строка на прокси — для антидетект-браузеров, парсеров и таблиц.',
  dev:'Готовый фрагмент кода с вашими прокси — вставьте в проект.',
  sys:'Профиль для системного прокси-клиента или браузерного расширения.',
  tpl:'Соберите свою строку из переменных. Шаблон сохранится для следующих выгрузок.'
};
var EX_VARS=['{protocol}','{login}','{password}','{ip}','{port}','{nick}','{country}','{operator}','{change_ip_url}','{label}'];
var EX_SEPS=[['nl','Новая строка','\n'],['comma','Запятая',',\n'],['semi','Точка с запятой',';\n']];
var EX_SAVED_DEFAULT=[
  {name:'Для парсера',tpl:'{ip}:{port}:{login}:{password}'},
  {name:'С ником и ссылкой',tpl:'{protocol}://{login}:{password}@{ip}:{port}  # {nick} {change_ip_url}'}
];
var exState=(function(){
  var s=V3.store.get('export',{});
  return {
    tab:s.tab||'basic',fmt:s.fmt||{basic:'txt',dev:'py',sys:'ppx'},
    proto:s.proto||V3.store.get('export_proto','http'),ip:s.ip!=null?!!s.ip:false,
    tpl:s.tpl!=null?s.tpl:'{protocol}://{login}:{password}@{ip}:{port}  # {nick}',
    sep:s.sep||'nl',saved:s.saved||EX_SAVED_DEFAULT.slice(),scope:'all'
  };
})();
function _exSave(){V3.store.set('export',{tab:exState.tab,fmt:exState.fmt,proto:exState.proto,ip:exState.ip,tpl:exState.tpl,sep:exState.sep,saved:exState.saved})}

function _exAll(){return v3SortRows(tableData.filter(function(r){return r.proxyLogin&&(r.httpPort||r.socksPort)}))}
function _exScopes(){
  var all=_exAll(),sel=all.filter(function(r){return pxSel[r.portId]}),s=[];
  if(sel.length)s.push(['sel','Выбранные '+sel.length,function(r){return pxSel[r.portId]}]);
  s.push(['all','Все '+all.length,function(){return true}]);
  var ccs=V3.countries();
  if(ccs.length>1)ccs.forEach(function(cc){s.push(['cc:'+cc,V3.ccName(cc),function(r){return V3.cc(r)===cc}])});
  return s;
}
function _exRows(){
  var sc=_exScopes(),d=sc.filter(function(x){return x[0]===exState.scope})[0]||sc[0];
  exState.scope=d[0];
  return _exAll().filter(d[2]);
}

// ---------- открыть ----------
// mode: 'sel' — выбранные, 'all' — все, 'auto' — выбранные, если есть; nick — один прокси
function openExport(mode,portId){
  if(!_exAll().length){V3.toast({kind:'info',title:'Реквизитов пока нет',text:'Экспорт станет доступен, когда прокси будут выданы.'});return}
  var hasSel=pxSelected().length>0;
  exState.scope=mode==='sel'||(mode==='auto'&&hasSel)?'sel':'all';
  if(portId){pxSel={};pxSel[portId]=true;exState.scope='sel';if(typeof _pxSelBar==='function'){_pxTable();_pxSelBar()}}
  V3.modal('<div id="exRoot"></div>',{width:''});
  _exRender();
}
function exTab(t){exState.tab=t;_exSave();_exRender()}
function exFmt(k){exState.fmt[exState.tab]=k;_exSave();_exRender()}
function exProto(p){exState.proto=p;_exSave();_exRender()}
function exIpToggle(){exState.ip=!exState.ip;_exSave();_exRender()}
function exScope(s){exState.scope=s;_exRender()}
function exSep(s){exState.sep=s;_exSave();_exRender()}
function exVar(v){
  var inp=document.getElementById('exTplInput');
  if(inp){var p=inp.selectionStart!=null?inp.selectionStart:inp.value.length;inp.value=inp.value.slice(0,p)+v+inp.value.slice(p);exState.tpl=inp.value}
  else exState.tpl+=v;
  _exSave();_exRender(true);
}
function exTplInput(v){exState.tpl=v;_exSave();_exPreview()}
function exTplClear(){exState.tpl='';_exSave();_exRender(true)}
function exUseSaved(i){var t=exState.saved[i];if(t){exState.tpl=t.tpl;_exSave();_exRender()}}
function exDelSaved(i){exState.saved.splice(i,1);_exSave();_exRender()}
function exSaveTpl(){
  if(!exState.tpl.trim()){V3.toast({kind:'err',title:'Шаблон пуст'});return}
  if(exState.saved.some(function(t){return t.tpl===exState.tpl})){V3.toast({kind:'info',title:'Такой шаблон уже сохранён'});return}
  var name=prompt('Название шаблона','Шаблон '+(exState.saved.length+1));
  if(name===null)return;
  exState.saved.push({name:String(name).trim().slice(0,40)||'Шаблон',tpl:exState.tpl});
  _exSave();_exRender();
  V3.toast({title:'Шаблон сохранён'});
}

// ---------- генерация ----------
function _exScheme(){return exState.proto==='socks5'?'socks5':'http'}
function _exPort(r){return exState.proto==='socks5'?(r.socksPort||r.httpPort):(r.httpPort||r.socksPort)}
function _exFields(r){
  return {protocol:_exScheme(),login:r.proxyLogin,password:r.proxyPassword,ip:V3.serverIp(r),port:String(_exPort(r)),
    nick:r.modemNick,country:V3.cc(r),operator:r.operator||'',change_ip_url:r.resetSecureLink||'',label:V3.label(r.modemNick)};
}
function _exCurFmt(){var l=EX_FORMATS[exState.tab]||[];return l.filter(function(x){return x[0]===exState.fmt[exState.tab]})[0]||l[0]}
function _exComment(f){return f.nick+(f.label?' · '+f.label:'')}
function exBuild(){
  var rows=_exRows(),sch=_exScheme(),ipOn=exState.ip,anyLabel=rows.some(function(r){return !!V3.label(r.modemNick)});
  var F=rows.map(_exFields);
  if(exState.tab==='tpl'){
    var sep=(EX_SEPS.filter(function(x){return x[0]===exState.sep})[0]||EX_SEPS[0])[2];
    return F.map(function(f){return exState.tpl.replace(/\{(\w+)\}/g,function(m,k){return k in f?f[k]:m})}).join(sep);
  }
  var tail=function(f){return ipOn&&f.change_ip_url?'  '+f.change_ip_url:''};
  var cred=function(f){return f.login+':'+f.password};
  switch(_exCurFmt()[0]){
    case 'txt':return F.map(function(f){return cred(f)+'@'+f.ip+':'+f.port+tail(f)}).join('\n');
    case 'ipfirst':return F.map(function(f){return f.ip+':'+f.port+':'+cred(f)+tail(f)}).join('\n');
    case 'url':return F.map(function(f){return sch+'://'+cred(f)+'@'+f.ip+':'+f.port+tail(f)}).join('\n');
    case 'csv':
      var head=['nick','protocol','ip','port','login','password','country'].concat(anyLabel?['label']:[]).concat(ipOn?['change_ip_url']:[]);
      var q=function(v){v=String(v==null?'':v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
      return [head.join(',')].concat(F.map(function(f){return [f.nick,sch,f.ip,f.port,f.login,f.password,f.country].concat(anyLabel?[f.label]:[]).concat(ipOn?[f.change_ip_url]:[]).map(q).join(',')})).join('\n');
    case 'py':
      return 'import requests\n\nPROXIES = [\n'+F.map(function(f){return '    "'+sch+'://'+cred(f)+'@'+f.ip+':'+f.port+'",  # '+_exComment(f)}).join('\n')+'\n]\n\nr = requests.get("https://api.ipify.org", proxies={"http": PROXIES[0], "https": PROXIES[0]})'+
        (ipOn?'\n\nCHANGE_IP = {\n'+F.filter(function(f){return f.change_ip_url}).map(function(f){return '    "'+f.nick+'": "'+f.change_ip_url+'",'}).join('\n')+'\n}':'');
    case 'node':
      return "import { ProxyAgent, fetch } from 'undici';\n\nconst proxies = [\n"+F.map(function(f){return "  '"+sch+'://'+cred(f)+'@'+f.ip+':'+f.port+"', // "+_exComment(f)}).join('\n')+"\n];\n\nconst res = await fetch('https://api.ipify.org', { dispatcher: new ProxyAgent(proxies[0]) });"+
        (ipOn?"\n\nconst changeIp = {\n"+F.filter(function(f){return f.change_ip_url}).map(function(f){return "  '"+f.nick+"': '"+f.change_ip_url+"',"}).join('\n')+'\n};':'');
    case 'curl':
      return F.map(function(f){return 'curl -x '+sch+'://'+cred(f)+'@'+f.ip+':'+f.port+' https://api.ipify.org   # '+_exComment(f)}).join('\n')+
        (ipOn?'\n\n# смена IP\n'+F.filter(function(f){return f.change_ip_url}).map(function(f){return 'curl "'+f.change_ip_url+'"   # '+f.nick}).join('\n'):'');
    case 'json':
      return JSON.stringify(F.map(function(f){var o={nick:f.nick,protocol:sch,host:f.ip,port:Number(f.port),login:f.login,password:f.password,country:f.country};if(f.label)o.label=f.label;if(ipOn&&f.change_ip_url)o.change_ip_url=f.change_ip_url;return o}),null,2);
    case 'ppx':
      var x=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ProxifierProfile version="102" platform="Windows" product_id="0" product_minver="400">\n  <ProxyList>\n'+F.map(function(f,i){
        return '    <Proxy id="'+(100+i)+'" type="'+(sch==='socks5'?'SOCKS5':'HTTPS')+'">\n      <Address>'+x(f.ip)+'</Address>\n      <Port>'+f.port+'</Port>\n      <Options>48</Options>\n      <Authentication enabled="true">\n        <Username>'+x(f.login)+'</Username>\n        <Password>'+x(f.password)+'</Password>\n      </Authentication>\n    </Proxy>';
      }).join('\n')+'\n  </ProxyList>\n</ProxifierProfile>';
    case 'foxy':
      return JSON.stringify({mode:'patterns',data:F.map(function(f){return {title:f.nick+(f.label?' · '+f.label:''),type:sch,hostname:f.ip,port:String(f.port),username:f.login,password:f.password,active:true}})},null,2);
    case 'omega':
      var o={'-confirmDeletion':true,'-refreshOnProfileChange':true,'-startupProfileName':'','schemaVersion':2};
      F.forEach(function(f){o['+'+f.nick]={name:f.nick,profileType:'FixedProfile',color:'#2f6fe0',fallbackProxy:{scheme:sch==='socks5'?'socks5':'http',host:f.ip,port:Number(f.port)},auth:{fallbackProxy:{username:f.login,password:f.password}},bypassList:[{conditionType:'BypassCondition',pattern:'127.0.0.1'},{conditionType:'BypassCondition',pattern:'localhost'}]}});
      return JSON.stringify(o,null,2);
    case 'pac':
      return 'function FindProxyForURL(url, host) {\n  // '+F.map(function(f){return f.nick}).join(', ')+'\n  // авторизация: логин и пароль спросит браузер\n  return "'+F.map(function(f){return (sch==='socks5'?'SOCKS5 ':'PROXY ')+f.ip+':'+f.port}).join('; ')+'";\n}';
  }
  return '';
}
function _exExt(){return exState.tab==='tpl'?'.txt':_exCurFmt()[3]}

// ---------- рендер ----------
function _exRender(keepFocus){
  var root=document.getElementById('exRoot');if(!root)return;
  var rows=_exRows(),all=_exAll(),tab=exState.tab,fmt=_exCurFmt();
  var h=V3.mh('Экспорт прокси','<span class="v3-chip on static">'+rows.length+' из '+all.length+' прокси</span>');
  h+='<div class="v3-tabs">'+EX_TABS.map(function(t){
    return '<button type="button" class="v3-tab'+(tab===t[0]?' on':'')+'" data-on-click="exTab(\''+t[0]+'\')">'+t[1]+(t[0]!=='tpl'?'<span class="n">'+EX_FORMATS[t[0]].length+'</span>':'')+'</button>';
  }).join('')+'</div>';
  h+='<div style="padding:14px 24px 0;font-size:12px;color:var(--v3-muted);line-height:1.5">'+EX_HINT[tab]+'</div>';
  if(tab!=='tpl'){
    h+='<div class="v3-mb tight sep"><div class="v3-fmts">'+EX_FORMATS[tab].map(function(x){
      return '<button type="button" class="v3-fmt'+(x[0]===fmt[0]?' on':'')+'" data-on-click="exFmt(\''+x[0]+'\')"><div class="h"><span class="v3-radio"></span><span class="lb">'+V3.esc(x[1])+'</span></div><div class="sb">'+V3.esc(x[2])+'</div></button>';
    }).join('')+'</div></div>';
  }else{
    h+='<div class="v3-mb tight sep" style="gap:10px">'+
      '<div class="v3-field"><span class="v3-label">Шаблон строки</span>'+
        '<div class="v3-tplbox"><input id="exTplInput" value="'+V3.esc(exState.tpl)+'" placeholder="шаблон пуст" data-on-input="exTplInput(this.value)" spellcheck="false"><button type="button" data-on-click="exTplClear()">Очистить</button></div>'+
        '<span class="v3-note">Нажмите на переменную, чтобы добавить её в шаблон.</span></div>'+
      '<div class="v3-vars">'+EX_VARS.map(function(v){return '<span class="v3-var" data-on-click="exVar(\''+v+'\')">'+v+'</span>'}).join('')+'</div>'+
      '<div style="display:flex;gap:24px;flex-wrap:wrap">'+
        '<div><div class="v3-cap" style="margin-bottom:5px">Разделитель строк</div><span class="v3-seg">'+EX_SEPS.map(function(s){return '<button type="button" class="'+(exState.sep===s[0]?'on':'')+'" data-on-click="exSep(\''+s[0]+'\')">'+s[1]+'</button>'}).join('')+'</span></div>'+
        '<div style="flex:1;min-width:220px"><div class="v3-cap" style="margin-bottom:5px;display:flex">Сохранённые шаблоны<span style="margin-left:auto;color:var(--v3-accent);cursor:pointer;text-transform:none;letter-spacing:0" data-on-click="exSaveTpl()">+ Сохранить текущий</span></div><div class="v3-saved">'+
          (exState.saved.length?exState.saved.map(function(t,i){return '<div class="v3-saved-i'+(exState.tpl===t.tpl?' on':'')+'" data-on-click="exUseSaved('+i+')"><b>'+V3.esc(t.name)+'</b><span>'+V3.esc(t.tpl)+'</span><button type="button" class="del" title="Удалить" data-on-click="event.stopPropagation();exDelSaved('+i+')">×</button></div>'}).join(''):'<div class="v3-note">Пока нет сохранённых шаблонов</div>')+
        '</div></div>'+
      '</div></div>';
  }
  var sc=_exScopes();
  h+='<div class="v3-opts">'+
    '<div><div class="v3-cap">Протокол</div><span class="v3-seg">'+[['http','HTTP'],['socks5','SOCKS5']].map(function(p){return '<button type="button" class="'+(exState.proto===p[0]?'on':'')+'" data-on-click="exProto(\''+p[0]+'\')">'+p[1]+'</button>'}).join('')+'</span></div>'+
    (tab!=='tpl'?'<div><div class="v3-cap">Ссылка смены IP</div><span class="v3-check-row" style="padding-top:4px" data-on-click="exIpToggle()"><span class="v3-check'+(exState.ip?' on':'')+'"></span>добавить в файл</span></div>':'')+
    '<div><div class="v3-cap">Что выгружаем</div><span style="display:inline-flex;gap:6px;flex-wrap:wrap">'+sc.map(function(s){return '<button type="button" class="v3-chip'+(exState.scope===s[0]?' on':'')+'" data-on-click="exScope('+V3.q(s[0])+')">'+V3.esc(s[1])+'</button>'}).join('')+'</span></div>'+
  '</div>';
  h+='<div style="padding:12px 24px"><div style="display:flex;align-items:center;margin-bottom:6px"><span class="v3-cap">Предпросмотр</span><span style="margin-left:auto;font-size:10.5px;color:var(--v3-faint);font-family:var(--font-mono)" id="exMeta"></span></div><pre class="v3-pre'+(tab==='dev'?' dark':'')+'" id="exPre"></pre></div>';
  h+='<div class="v3-mf"><span class="left">Пароли в файле не маскируются — храните его в надёжном месте.</span><button type="button" class="v3-btn" data-on-click="exCopy()">Скопировать</button><button type="button" class="v3-btn primary" data-on-click="exDownload()">'+(tab==='tpl'?'Сохранить и скачать':'Скачать '+_exExt())+'</button></div>';
  root.innerHTML=h;
  _exPreview();
  if(keepFocus){var inp=document.getElementById('exTplInput');if(inp){inp.focus();inp.setSelectionRange(inp.value.length,inp.value.length)}}
}
function _exPreview(){
  var pre=document.getElementById('exPre');if(!pre)return;
  var txt=exBuild(),lines=txt.split('\n'),MAX=14;
  pre.textContent=lines.length>MAX?lines.slice(0,MAX).join('\n')+'\n… ещё '+(lines.length-MAX)+' '+V3.plural(lines.length-MAX,'строка','строки','строк'):(txt||'— нет прокси в выборке —');
  var meta=document.getElementById('exMeta');
  if(meta)meta.textContent=_exRows().length+' прокси · '+_exScheme().toUpperCase()+' · '+_exExt();
}
function exCopy(){
  var n=_exRows().length;if(!n)return;
  var f=exState.tab==='tpl'?'по шаблону':_exCurFmt()[1];
  V3.copy(exBuild(),'Реквизиты скопированы',n+' '+V3.plural(n,'прокси','прокси','прокси')+' в формате '+f);
}
function exDownload(){
  var n=_exRows().length;if(!n)return;
  if(exState.tab==='tpl'&&exState.tpl.trim()&&!exState.saved.some(function(t){return t.tpl===exState.tpl})){
    exState.saved.push({name:'Шаблон '+(exState.saved.length+1),tpl:exState.tpl});_exSave();
  }
  var ext=_exExt(),d=V3.today();
  var mime={'.json':'application/json','.csv':'text/csv','.pac':'application/x-ns-proxy-autoconfig','.ppx':'application/xml','.py':'text/x-python','.sh':'text/x-shellscript','.js':'text/javascript'}[ext]||'text/plain';
  var name=exState.tab==='tpl'?'template':_exCurFmt()[0];
  V3.download(exBuild(),'proxies_'+name+'_'+d+ext,mime);
  V3.toast({title:'Файл скачан',text:n+' '+V3.plural(n,'прокси','прокси','прокси')+' · '+ext});
  if(exState.tab==='tpl')_exRender();
}
