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
      const meta=db.prepare('SELECT operator,nick,imei FROM modem_meta WHERE server_name=? AND (imei=? OR nick=?) ORDER BY updated_at DESC LIMIT 1')
        .get(out.server,out.imei||out.nick,out.nick);
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
    if(!updateStmt)return;
    const counts=_counts(incident),now=new Date().toISOString();
    const members=Array.from(incident.members.values());
    try{updateStmt.run(closed?'closed':'open',now,closed?now:null,closed?Math.max(0,Math.round((Date.now()-incident.openedAt)/1000)):null,
      counts.modems,counts.clients,JSON.stringify(members),JSON.stringify(Array.from(incident.reasons)),incident.id);}catch(e){logger.warn('[Incidents] update: '+e.message);}
  }
  function _openIncident(group,candidates){
    let incident=Array.from(open.values()).find(x=>x.group===group);
    const first=candidates[0],now=Date.now();
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
    for(const incident of open.values()){
      const member=incident.members.get(identity);
      if(!member)continue;
      member.rules=(member.rules||[]).filter(r=>r!==recoveredRule);
      member.active=member.rules.length>0;
      if(!member.active)member.recovered_at=new Date().toISOString();
      incident.lastSeenAt=Date.now();
      const active=Array.from(incident.members.values()).filter(m=>m.active);
      if(active.length){_persist(incident,false);return {handled:true,accepted:true};}
      const counts=_counts(incident),durationSec=Math.max(0,Math.round((Date.now()-incident.openedAt)/1000));
      _persist(incident,true);open.delete(incident.id);
      emit('fleet_incident_closed',{incident_id:incident.id,server:incident.server,operator:incident.operator,
        duration_sec:durationSec,modems:counts.modems,clients:counts.clients});
      return {handled:true,accepted:true};
    }
    return {handled:false};
  }
  function handle(ruleId,payload){
    if(!_enabled())return {handled:false};
    if(OPEN_RULES.has(ruleId))return _handleOpen(ruleId,payload||{});
    if(RECOVERY_RULES.has(ruleId))return _handleRecovery(ruleId,payload||{});
    return {handled:false};
  }
  function shutdown(){for(const c of pending.values())clearTimeout(c.timer);pending.clear();}
  return {handle,shutdown,_pending:pending,_open:open};
}

module.exports={create,OPEN_RULES,RECOVERY_RULES};
