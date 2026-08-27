import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import { bootApp, asAdmin } from './_helpers/app.js';

const require=createRequire(import.meta.url);
const locationWan=require('../src/jobs/location-wan-speed.js');
let db;
beforeAll(()=>{db=bootApp().db;});

describe('проводной интернет по локациям',()=>{
  it('разбирает Ookla, speedtest-cli и Cloudflare без путаницы bits/bytes',()=>{
    expect(locationWan.parseWanSpeedOutput('__METHOD_OOKLA__\n'+JSON.stringify({download:{bandwidth:12500000},upload:{bandwidth:2500000},ping:{latency:12.4,jitter:1.2},isp:'ISP'})))
      .toMatchObject({method:'ookla',download_mbps:100,upload_mbps:20,ping_ms:12.4});
    expect(locationWan.parseWanSpeedOutput('__METHOD_SPEEDTEST_CLI__\n'+JSON.stringify({download:80000000,upload:12000000,ping:18})))
      .toMatchObject({method:'speedtest-cli',download_mbps:80,upload_mbps:12,ping_ms:18});
    expect(locationWan.parseWanSpeedOutput('__METHOD_CLOUDFLARE__\n12500000|0.014|1.2.3.4\n2500000'))
      .toMatchObject({method:'cloudflare',download_mbps:100,upload_mbps:20,ping_ms:14,external_ip:'1.2.3.4'});
  });

  it('делает один замер на общий адрес и переключается на второй сервер локации',async()=>{
    db.prepare('DELETE FROM location_wan_speed').run();
    const apiServers=[
      {name:'S1',displayName:'А — первый',address:'Кишинёв, Армянская 30',publicIp:'10.0.0.1',osLogin:'mon',sshPort:22},
      {name:'S2',displayName:'Б — второй',address:'  кишинёв,  армянская 30 ',publicIp:'10.0.0.2',osLogin:'mon',sshPort:22},
    ];
    const calls=[];
    const execFile=(bin,args,_opts,callback)=>{
      calls.push({bin,args});
      const target=args.find(value=>String(value).includes('@'))||'';
      if(target.includes('10.0.0.1'))return callback(new Error('ssh down'),'');
      callback(null,'__METHOD_OOKLA__\n'+JSON.stringify({download:{bandwidth:10000000},upload:{bandwidth:2000000},ping:{latency:15}}));
    };
    const job=locationWan.create({db,apiServers,execFile,logger:{info(){},warn(){},error(){}}});
    expect(await job.runLocationWanSpeed()).toMatchObject({ok:1,failed:0});
    const rows=db.prepare('SELECT * FROM location_wan_speed').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({server_name:'S2',download_mbps:80,upload_mbps:16,ok:1});
    expect(calls.some(call=>call.args.some(value=>String(value).includes('10.0.0.1')))).toBe(true);
    expect(calls.some(call=>call.args.some(value=>String(value).includes('10.0.0.2')))).toBe(true);
  });

  it('отдаёт историю через административный API',async()=>{
    const {app}=bootApp();
    const res=await request(app).get('/api/admin/location_wan_speed?hours=24').set('X-Auth-Token',asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.hours).toBe(24);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(Array.isArray(res.body.locations)).toBe(true);
  });
});
