const { createRequire } = require('module');
const requireApp = createRequire(process.cwd() + '/package.json');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = requireApp('better-sqlite3');
const logger = { info() {}, warn() {}, error() {} };
const evidence = [];
async function main() {
  const client = { id:'c', bills:[{ id:'b', billNumber:'INV-100', amount:10000, status:'unpaid' }] };
  requireApp('./src/billing/bill-settle').settleBillsOnPayment(client, 1, 'INV-100', { documentsDb:{ updateBillStatus(){} }, logger });
  assert.equal(client.bills[0].status, 'paid');
  evidence.push({case:'partial_payment', payment:1, invoice:10000, actualStatus:'paid'});

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-audit-'));
  try {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE daily_traffic(port_name TEXT, date TEXT)');
    const old = new Date(Date.now()-5*864e5).toISOString().slice(0,10);
    db.prepare('INSERT INTO daily_traffic VALUES (?,?)').run('S4_port',old);
    const cachePath = path.join(tmp,'cache.json');
    fs.writeFileSync(cachePath,JSON.stringify({S1:{cachedAt:Date.now(),bw:{live:{}}},S4:{cachedAt:Date.now()-864e5,bw:{port:{}}}}));
    const dailyTraffic = {S4_port:{[old]:{in:123,out:0}}};
    const result = requireApp('./src/jobs/cleanup').create({db,logger,fs,SERVER_CACHE_FILE:cachePath,appSettings:{},dailyTraffic,logActivity(){}}).cleanupStalePortMappings();
    assert.equal(result.dtDeleted,1); assert.equal(dailyTraffic.S4_port,undefined);
    evidence.push({case:'retention_unreachable',...result}); db.close();

    const pingDb = new Database(':memory:');
    pingDb.exec(`CREATE TABLE modem_ping(ts TEXT,server TEXT,nick TEXT,latency_ms REAL,loss_pct REAL,ok INTEGER);
      CREATE TABLE known_modems(server_name TEXT,data TEXT,updated_at TEXT);
      CREATE TABLE modem_meta(server_name TEXT,nick TEXT,operator TEXT,updated_at TEXT);`);
    const ping = requireApp('./src/jobs/modem-ping').create({db:pingDb,logger,alerts:{trigger(){}},getSetting:(_k,d)=>d});
    const now = Date.now();
    for(let i=0;i<66;i++) ping.ingest('S1',[{modem_details:{IMEI:'i',NICK:'M'},net_details:{IS_ONLINE:'yes',ping_stats:'0ms, 100% loss'}}],now-65*60000+i*60000);
    const issues = requireApp('./src/services/proxy-issues').create({db:pingDb,logger,appSettings:{}}).computeProxyIssues();
    assert.equal(ping.latest().S1_M.fresh,false); assert.equal(issues.length,1);
    evidence.push({case:'stale_ping_still_reboot_candidate',fresh:ping.latest().S1_M.fresh,historyRows:pingDb.prepare('SELECT COUNT(*) n FROM modem_ping').get().n,issues});
    ping.ingest('S1',[{modem_details:{IMEI:'i2',NICK:'M2'},net_details:{IS_ONLINE:'yes',ping_stats:'20ms, 0% loss'}}],now-864e5);
    ping.ingest('S1',[{modem_details:{IMEI:'i2',NICK:'M2'},net_details:{IS_ONLINE:'yes',ping_stats:''}}],now);
    assert.equal(ping.alive('S1','i2'),true);
    evidence.push({case:'missing_ping_preserves_old_fresh_state',lastAgeHours:24,alive:ping.alive('S1','i2'),fresh:ping.latest().S1_M2.fresh}); pingDb.close();

    const validity = requireApp('./src/services/port-validity').create({getMoscowNow:()=>new Date('2026-09-13T12:00:00Z'),ledgerDb:{listByClient:()=>Array.from({length:7},(_,i)=>({type:'charge',date:'2026-09-'+String(6+i).padStart(2,'0'),cost:100}))}});
    assert.equal(validity.avgDailyCharge7d('c'),85.71);
    evidence.push({case:'six_days_divided_by_seven',dailyCharges:100,expectedAverage:100,actualAverage:85.71});

    const payDb = new Database(':memory:');
    payDb.exec(`CREATE TABLE card_payments(id INTEGER PRIMARY KEY,order_id TEXT UNIQUE,client_id TEXT,amount REAL,method TEXT,status TEXT,created_at TEXT,promo_code TEXT,provider_payment_id TEXT,raw_json TEXT,credited_at TEXT)`);
    const repo = requireApp('./src/db/card-payments'); repo.init(payDb); repo.insertCreated('o','c',100,'card');
    let creditCalls=0;
    const pass=(_req,_res,next)=>next();
    const router=requireApp('./src/routes/payments')({logger,authMiddleware:pass,adminMiddleware:pass,topupLimiter:pass,webhookLimiter:pass,validate:()=>pass,clients:[{id:'c'}],clientById:new Map([['c',{id:'c'}]]),cardPaymentsDb:repo,createProvider:()=>({verify_webhook:async()=>({ok:true,order_id:'o',status:'paid',amount:100,provider_payment_id:'p'})}),atomicCredit(){creditCalls++;throw Error('simulated temporary db failure');},alerts:{trigger(){}},getClientIp:()=> 'local'});
    const handler=router.stack.find(l=>l.route?.path==='/api/payments/webhook/tochka').route.stack.at(-1).handle;
    const response=()=>({code:200,status(n){this.code=n;return this;},json(data){this.data=data;return this;}});
    const r1=response(),r2=response(); await handler({headers:{},body:''},r1);await handler({headers:{},body:''},r2);
    assert.equal(r1.code,500);assert.equal(r2.data.duplicate,true);assert.equal(creditCalls,1);
    evidence.push({case:'paid_webhook_cannot_retry_credit',firstStatus:r1.code,retry:r2.data,creditCalls,dbStatus:repo.byOrderId('o').status});payDb.close();

    let restoreAttempts=0;
    const retailClient={id:'r',login:'retail',portName:'retail',clientType:'individual',balance:100,balanceNegativeSince:'2026-09-01',debtBlocked:true};
    const poolRow={id:1,client_id:'r',status:'blocked',server:'S1',port_id:'p'};
    const messages=[];
    const guard=requireApp('./src/jobs/retail-guard').create({
      logger,logActivity(){},auditLog(){},alerts:{trigger(){}},saveClients(){},
      clients:[retailClient],getMoscowNow:()=>new Date('2026-09-13T12:00:00Z'),
      getSetting:(k,d)=>k==='retail_enabled'?true:d,
      kvGet:()=>null,kvSet(){},notifyClient:async(_c,text)=>messages.push(text),
      ledgerDb:{listByClient:()=>[]},findServer:()=>({name:'S1'}),
      retailPoolDb:{byClient:()=>[poolRow],byStatus:status=>poolRow.status===status?[poolRow]:[],unblock(){poolRow.status='leased';}},
      fetchAllServersDataCached:async()=>[{serverName:'S1',ports:{i:[{portID:'p',portName:'retail',PROXY_VALID_BEFORE:'2026-09-01'}]}}],
      proxyConf:{getConfForm:async()=>{restoreAttempts++;return {ok:false,reason:'simulated unreachable'};}},
    });
    const first=await guard.runOnce(); const second=await guard.runOnce();
    assert.deepEqual(first.restored,['r']);assert.equal(restoreAttempts,1);assert.equal(poolRow.status,'leased');assert.equal(retailClient.balanceNegativeSince,null);
    evidence.push({case:'restore_failure_reported_as_success',restoreAttemptsAfterTwoRuns:restoreAttempts,poolStatus:poolRow.status,firstRestored:first.restored,secondRestored:second.restored,messages});

    const file=path.join(tmp,'missing.db');fs.writeFileSync(file+'.gz','previous archive');
    await assert.rejects(requireApp('./src/jobs/backup').gzipFile(file));
    await new Promise(r=>setTimeout(r,30));
    assert.equal(fs.statSync(file+'.gz').size,0);
    evidence.push({case:'gzip_failure_overwrites_previous_archive',oldBytes:16,newBytes:0});
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
