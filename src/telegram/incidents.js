'use strict';

// Correlation layer above modem alerts. An individual failure waits for the
// five-minute correlation window. Three distinct modems of one operator on
// one server become a single incident; otherwise the original alert is sent.
// Recovery closes the incident only when every member has recovered.

const crypto = require('crypto');

const OPEN_RULES = new Set(['modem_offline_20m', 'modem_ping_dead', 'modem_http_fail']);
const RECOVERY_RULES = new Set(['modem_recovered', 'modem_ping_recovered', 'modem_http_recovered']);
const RECOVERY_TO_OPEN = {
  modem_recovered: 'modem_offline_20m',
  modem_ping_recovered: 'modem_ping_dead',
  modem_http_recovered: 'modem_http_fail',
};

function create(deps) {
  const { db, logger, getSetting, emit } = deps;
  const pending = new Map();       // identity → candidate
  const open = new Map();          // incident id → incident
  let insertStmt=null, updateStmt=null;

  try {
    insertStmt=db.prepare(`INSERT INTO monitoring_incidents
      (id,correlation_key,server,operator,hypothesis,state,opened_at,last_seen_at,
       modem_count,client_count,members_json,reasons_json)
      VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)`);
    updateStmt=db.prepare(`UPDATE monitoring_incidents SET state=?,last_seen_at=?,closed_at=?,duration_sec=?,
      modem_count=?,client_count=?,members_json=?,reasons_json=? WHERE id=?`);
    const rows=db.prepare("SELECT * FROM monitoring_incidents WHERE state='open'").all();
    for(const row of rows){
      const members=new Map();
      for(const m of _json(row.members_json,[]))members.set(m.identity,m);
      open.set(row.id,{id:row.id,group:row.correlation_key,server:row.server,operator:row.operator,
        hypothesis:row.hypothesis,openedAt:Date.parse(row.opened_at)||Date.now(),lastSeenAt:Date.parse(row.last_seen_at)||Date.now(),
        members,reasons:new Set(_json(row.reasons_json,[]))});
    }
  } catch(e){
    logger&&logger.warn&&logger.warn('[Incidents] persistence unavailable: '+e.message);
  }

  function _json(s,fallback){try{return JSON.parse(s)}catch(_){return fallback}}
  function _enabled(){return getSetting('alert_incident_correlation_enabled',true)!==false;}
  function _windowMs(){return Math.max(1,Math.min(15,Number(getSetting('alert_incident_window_min',5))||5))*60000;}
  function _threshold(){return Math.max(3,Math.min(20,Number(getSetting('alert_incident_threshold',3))||3));}
  function _identity(p){return String(p.server||'')+'|'+String(p.imei||p.nick||'');}
  function _normOperator(v){return String(v||'').replace(/\s+/g,' ').trim()||'Оператор не определён';}
  function _memberPayload(p,ruleId){
    const out={identity:_identity(p),server:String(p.server||''),nick:String(p.nick||p.imei||''),imei:String(p.imei||''),active:true,
      rules:[ruleId],clients:Array.isArray(p.clients)?p.clients.filter(Boolean):[],last_seen:new Date().toISOString()};
    try{
      // DEEP-78 (2026-09-24): точный поиск server+imei ПЕРВЫМ; nick —
      // только fallback (один nick у двух IMEI раньше подменял оператора
      // более новой чужой строкой → группировка по чужому оператору).
      let meta=null;
      if(out.imei){
        meta=db.prepare('SELECT operator,nick,imei FROM modem_meta WHERE server_name=? AND imei=? ORDER BY updated_at DESC LIMIT 1')
          .get(out.server,out.imei);
      }
      if(!meta&&out.nick){
        meta=db.prepare('SELECT operator,nick,imei FROM modem_meta WHERE server_name=? AND nick=? ORDER BY updated_at DESC LIMIT 1')
          .get(out.server,out.nick);
      }
      if(meta){if(!out.nick)out.nick=meta.nick||'';if(!out.imei)out.imei=meta.imei||'';out.operator=meta.operator||'';}
    }catch(_){}
    if(!out.operator)out.operator=p.operator||'';
    if(!out.clients.length){
      try{
        const rows=db.prepare('SELECT data FROM known_modems WHERE server_name=?').all(out.server);
        for(const row of rows){const d=_json(row.data,{});if(String(d.imei||'')===out.imei||String(d.nick||'')===out.nick){const c=String(d.portName||'').trim();if(c&&!/^random/i.test(c)&&out.clients.indexOf(c)<0)out.clients.push(c);}}
      }catch(_){}
    }
    return out;
  }
  function _group(p,member){return member.server+'|'+_normOperator(p.operator||member.operator);}
  function _reason(ruleId){return ruleId==='modem_offline_20m'?'модемы отключились':ruleId==='modem_http_fail'?'HTTP-проверки не проходят':'пинг не проходит';}
  function _counts(incident){
    const clients=new Set();
    for(const m of incident.members.values())for(const c of(m.clients||[]))clients.add(c);
    return {modems:incident.members.size,clients:clients.size};
  }
  function _persist(incident,closed){
    if(!updateStmt)return true;   // persistence unavailable — degrade молча
    const counts=_counts(incident),now=new Date().toISOString();
    const members=Array.from(incident.members.values());
    // DEEP-76 (2026-09-24): ошибка записи — ЯВНЫЙ результат, а не warn в
    // пустоту. Вызывающий код не объявляет инцидент закрытым при отказе.
    try{updateStmt.run(closed?'closed':'open',now,closed?now:null,closed?Math.max(0,Math.round((Date.now()-incident.openedAt)/1000)):null,
      counts.modems,counts.clients,JSON.stringify(members),JSON.stringify(Array.from(incident.reasons)),incident.id);return true;}
    catch(e){logger.warn('[Incidents] update: '+e.message);return false;}
  }
  function _openIncident(group,candidates){
    let incident=Array.from(open.values()).find(x=>x.group===group);
    const first=candidates[0],now=Date.now();
    // DEEP-79 (2026-09-24): участник, открывшийся в НОВОЙ группе, деактивируем
    // в прежних инцидентах — иначе при смене/уточнении оператора один и тот же
    // identity оставался active в двух инцидентах, а recovery закрывало только
    // первый по порядку обхода Map.
    for(const c of candidates){
      for(const other of open.values()){
        if(other.group===group)continue;
        const m=other.members.get(c.member.identity);
        if(m&&m.active){
          m.active=false;m.moved_to=group;
          const active=Array.from(other.members.values()).filter(x=>x.active);
          if(active.length){_persist(other,false);}
          else{
            const dur=Math.max(0,Math.round((Date.now()-other.openedAt)/1000));
            const oc=_counts(other);
            if(_persist(other,true)){open.delete(other.id);
              emit('fleet_incident_closed',{incident_id:other.id,server:other.server,operator:other.operator,
                duration_sec:dur,modems:oc.modems,clients:oc.clients});}
          }
        }
      }
    }
    if(!incident){
      const operator=_normOperator(first.payload.operator||first.member.operator);
      const server=first.member.server;
      const hypothesis=operator==='Оператор не определён'
        ? 'Похоже на общую проблему сервера или канала'
        : 'Похоже на проблему оператора '+operator;
      incident={id:crypto.randomUUID(),group,server,operator,hypothesis,openedAt:now,lastSeenAt:now,members:new Map(),reasons:new Set()};
      for(const c of candidates){incident.members.set(c.member.identity,c.member);incident.reasons.add(_reason(c.ruleId));}
      open.set(incident.id,incident);
      const counts=_counts(incident);
      if(insertStmt){try{insertStmt.run(incident.id,group,server,operator,hypothesis,new Date(now).toISOString(),new Date(now).toISOString(),counts.modems,counts.clients,JSON.stringify(Array.from(incident.members.values())),JSON.stringify(Array.from(incident.reasons)));}catch(e){logger.warn('[Incidents] insert: '+e.message);}}
      emit('fleet_incident_opened',{incident_id:incident.id,server,operator,hypothesis,modems:counts.modems,clients:counts.clients,
        modem_list:Array.from(incident.members.values()).map(m=>m.nick).join(', '),reasons:Array.from(incident.reasons).join(', ')});
      return incident;
    }
    for(const c of candidates){
      const existing=incident.members.get(c.member.identity);
      if(existing){existing.active=true;existing.last_seen=new Date().toISOString();if(existing.rules.indexOf(c.ruleId)<0)existing.rules.push(c.ruleId);}
      else incident.members.set(c.member.identity,c.member);
      incident.reasons.add(_reason(c.ruleId));
    }
    incident.lastSeenAt=now;_persist(incident,false);return incident;
  }
  function _flush(identity){
    const c=pending.get(identity);if(!c)return;
    pending.delete(identity);clearTimeout(c.timer);emit(c.ruleId,c.payload);
  }
  function _handleOpen(ruleId,payload){
    const member=_memberPayload(payload,ruleId),identity=member.identity;
    if(!member.server||!member.nick)return {handled:false};
    // A new symptom for a member of an already open incident stays inside it.
    const existingIncident=Array.from(open.values()).find(x=>x.group===_group(payload,member));
    if(existingIncident){_openIncident(existingIncident.group,[{ruleId,payload,member,at:Date.now()}]);return {handled:true,accepted:true};}
    let c=pending.get(identity);
    if(c){
      c.payload={...c.payload,...payload};
      if(c.member.rules.indexOf(ruleId)<0)c.member.rules.push(ruleId);
      c.ruleId=c.ruleId==='modem_offline_20m'?c.ruleId:ruleId;
    }else{
      c={ruleId,payload:{...payload},member,at:Date.now(),timer:null};
      c.timer=setTimeout(()=>_flush(identity),_windowMs());
      if(c.timer&&typeof c.timer.unref==='function')c.timer.unref();
      pending.set(identity,c);
    }
    const group=_group(c.payload,c.member),cutoff=Date.now()-_windowMs();
    const grouped=Array.from(pending.values()).filter(x=>x.at>=cutoff&&_group(x.payload,x.member)===group);
    const unique=new Map();for(const x of grouped)unique.set(x.member.identity,x);
    if(unique.size>=_threshold()){
      const batch=Array.from(unique.values());
      for(const x of batch){clearTimeout(x.timer);pending.delete(x.member.identity);}
      _openIncident(group,batch);
    }
    return {handled:true,accepted:true};
  }
  function _handleRecovery(ruleId,payload){
    const identity=_identity(payload);
    const recoveredRule=RECOVERY_TO_OPEN[ruleId];
    const c=pending.get(identity);
    if(c){
      c.member.rules=(c.member.rules||[]).filter(r=>r!==recoveredRule);
      if(c.member.rules.length){c.ruleId=c.member.rules[0];return {handled:true,accepted:true};}
      clearTimeout(c.timer);pending.delete(identity);return {handled:true,accepted:true};
    }
    let any=false;
    // DEEP-79: recovery применяем во ВСЕХ инцидентах с этим identity, а не
    // только в первом по обходу Map (см. деактивацию при смене группы).
    for(const incident of Array.from(open.values())){
      const member=incident.members.get(identity);
      if(!member)continue;
      any=true;
      member.rules=(member.rules||[]).filter(r=>r!==recoveredRule);
      member.active=member.rules.length>0;
      if(!member.active)member.recovered_at=new Date().toISOString();
      incident.lastSeenAt=Date.now();
      const active=Array.from(incident.members.values()).filter(m=>m.active);
      if(active.length){_persist(incident,false);continue;}
      const counts=_counts(incident),durationSec=Math.max(0,Math.round((Date.now()-incident.openedAt)/1000));
      // DEEP-76: ошибка persistence — инцидент НЕ объявляем закрытым: emit и
      // удаление из Map только после подтверждённой записи (иначе SQLite
      // хранил open, память — closed, после рестарта эпизод воскресал).
      if(!_persist(incident,true)){
        const msg='[Incidents] close не сохранён (' + incident.id + ') — инцидент остаётся open, повтор при следующем событии';
        if(logger.error)logger.error(msg);else logger.warn(msg);
        continue;
      }
      open.delete(incident.id);
      emit('fleet_incident_closed',{incident_id:incident.id,server:incident.server,operator:incident.operator,
        duration_sec:durationSec,modems:counts.modems,clients:counts.clients});
    }
    return any?{handled:true,accepted:true}:{handled:false};
  }

  // DEEP-75 (2026-09-24): согласование сохранённых инцидентов со свежими
  // наблюдениями. Детектор шлёт recovery только на ПЕРЕХОДЕ своего локального
  // состояния — модем, восстановившийся во время рестарта, перехода не даёт,
  // и загруженный из SQLite инцидент висел открытым вечно. Вызывается из
  // детекторов после цикла опроса: подтверждённо онлайн-участники закрываются
  // тем же путём, что recovery (порог — факт онлайна в свежем фиде).
  function reconcile(entries){
    for(const e of entries||[]){
      if(!e||e.online!==true)continue;
      const identity=String(e.server||'')+'|'+String(e.imei||e.nick||'');
      for(const incident of Array.from(open.values())){
        const member=incident.members.get(identity);
        if(!member||!member.active)continue;
        member.active=false;member.rules=[];member.recovered_at=new Date().toISOString();
        incident.lastSeenAt=Date.now();
        const active=Array.from(incident.members.values()).filter(m=>m.active);
        if(active.length){_persist(incident,false);continue;}
        const counts=_counts(incident),durationSec=Math.max(0,Math.round((Date.now()-incident.openedAt)/1000));
        if(!_persist(incident,true))continue;
        open.delete(incident.id);
        emit('fleet_incident_closed',{incident_id:incident.id,server:incident.server,operator:incident.operator,
          duration_sec:durationSec,modems:counts.modems,clients:counts.clients});
      }
    }
  }
  function handle(ruleId,payload){
    if(!_enabled())return {handled:false};
    if(OPEN_RULES.has(ruleId))return _handleOpen(ruleId,payload||{});
    if(RECOVERY_RULES.has(ruleId))return _handleRecovery(ruleId,payload||{});
    return {handled:false};
  }
  function shutdown(){for(const c of pending.values())clearTimeout(c.timer);pending.clear();}
  return {handle,shutdown,reconcile,_pending:pending,_open:open};
}

module.exports={create,OPEN_RULES,RECOVERY_RULES};
