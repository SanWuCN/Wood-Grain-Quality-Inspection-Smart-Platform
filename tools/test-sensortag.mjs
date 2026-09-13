import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { decodeSensor, AttitudeFilter } from '../shared/sensortag.mjs';
import { createSensorService, validateFrame } from '../server/services/sensortag.mjs';
const near=(a,b,tolerance=.01)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

test('TI little-endian decode: motion units, signed temperature, optical exponent',()=>{
  const b=Buffer.alloc(18); b.writeInt16LE(16384,0); b.writeInt16LE(4096,10); b.writeInt16LE(-100,12);
  const d=decodeSensor('motion',b); near(d.gyro[0],125); near(d.accel[2],1); near(d.mag[0],-14.9902);
  const temp=Buffer.alloc(4);temp.writeInt16LE(-1280,0);temp.writeInt16LE(3200,2);
  assert.deepEqual(decodeSensor('temperature',temp),{objectTemp:-10,ambientTemp:25});
  const light=Buffer.alloc(2);light.writeUInt16LE(0x2123);near(decodeSensor('light',light).light,11.64);
  assert.throws(()=>decodeSensor('motion',Buffer.alloc(17)));
});
test('six-axis quaternion: level, roll, yaw integration, norm and gyro bias calibration',()=>{
  const f=new AttitudeFilter();f.update([0,0,1],[0,0,0],0);
  for(let i=1;i<=50;i++) f.update([0,0,1],[0,0,90],i*20);
  near(f.q[2],Math.SQRT1_2,.001);near(f.q[3],Math.SQRT1_2,.001);near(Math.hypot(...f.q),1,.000001);
  const tilted=new AttitudeFilter();tilted.update([0,1,0],[0,0,0],0);near(tilted.q[0],Math.SQRT1_2);
  const still=new AttitudeFilter();still.calibrate();for(let i=0;i<101;i++)still.update([0,0,1],[.1,-.2,.3],i*20);
  assert.equal(still.calibration,'ready');near(still.bias[2],.3);
  const q=[...still.q];for(let i=101;i<201;i++)still.update([0,0,1],[.1,-.2,.3],i*20);
  near(still.q[2],q[2],.001);
});
test('validation rejects invalid numeric values, partial IMU, unknown data, stale timestamps',()=>{
  const base={deviceId:'tag-1',batchId:'scan-1',streamId:'run-1',seq:1,sampledAt:Date.now(),readings:{light:0}};
  assert.equal(validateFrame(base).readings.light,0);
  for(const readings of [{light:NaN},{humidity:101},{accel:[0,0,1]},{gyro:[1,2]},{unknown:1}]) assert.throws(()=>validateFrame({...base,readings}));
  assert.throws(()=>validateFrame({...base,sampledAt:Date.now()-70000}));
});
test('persistence, isolation, freshness, calibration audit, out-of-order suppression',()=>{
  const db=new DatabaseSync(':memory:');const sent=[];const svc=createSensorService(db,{broadcastSensor:(s,f)=>sent.push([s,f])});
  const t=Date.now()-2000;
  const base={deviceId:'tag-1',batchId:'scan-1',streamId:'run-1',seq:1,sampledAt:t,readings:{accel:[0,0,1],gyro:[0,0,0],ambientTemp:25,light:100}};
  const first=svc.ingest('session-a',base);assert.equal(first.source,'ble:sensortag');assert.equal(first.simulated,false);
  assert.equal(svc.latest('session-b','scan-1',null),null);assert.equal(svc.latest('session-a','scan-2',null),null);
  assert.throws(()=>svc.ingest('session-a',base),e=>e.code==='OLD_SENSOR_FRAME');
  svc.calibrate('tag-1',{temperatureOffset:1,lightScale:2,lightOffset:5,reason:'参考仪表 26°C'},'rao');
  const next=svc.ingest('session-a',{...base,seq:2,sampledAt:t+20,readings:{light:120}});
  assert.equal(next.poseAt,first.poseAt);assert.equal(next.fieldAt.ambientTemp,first.fieldAt.ambientTemp);
  assert.equal(next.readings.ambientTemp,25);assert.equal(next.calibrated.ambientTemp,26);assert.equal(next.calibrated.light,245);
  assert.equal(svc.latest('session-a','scan-1','tag-1').seq,2);assert.equal(sent.length,2);
  assert.equal(db.prepare('SELECT count(*) as n FROM sensor_calibration_events').get().n,1);
  const reload=createSensorService(db,{broadcastSensor:()=>{}});assert.equal(reload.latest('session-a','scan-1','tag-1').seq,1);
  assert.equal(svc.history('session-a','scan-1','tag-1').length,1);
  assert.throws(()=>svc.calibrate('tag-1',{temperatureOffset:99,lightScale:1,lightOffset:0,reason:'bad'},'rao'));
  db.close();
});

test('authenticated HTTP ingest → WebSocket → latest/history, permission and batch isolation',async()=>{
  const { startService }=await import('../server/index.mjs');
  const { WebSocket }=await import('ws');
  const service=await startService({port:0,host:'127.0.0.1',dbFile:':memory:',quiet:true});
  let socket;
  try {
    const login=async(account)=>(await (await fetch(service.url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account,password:'123456'})})).json()).token;
    const token=await login('rao');
    const send=async(path,method='GET',body,auth=token)=>fetch(service.url+'/api/sensors/'+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},...(body?{body:JSON.stringify(body)}:{})});
    const received=new Promise((resolve,reject)=>{
      socket=new WebSocket(service.url.replace('http','ws')+'/ws?sessionId='+service.sessionId);
      socket.on('message',(raw)=>{const msg=JSON.parse(raw);if(msg.kind==='sensor')resolve(msg.frame);});
      socket.on('error',reject);
    });
    await new Promise((r)=>socket.on('open',r));
    const frame={sessionId:service.sessionId,deviceId:'test-tag',batchId:'test-batch',streamId:'run-1',seq:1,sampledAt:Date.now(),readings:{accel:[0,0,1],gyro:[0,0,0],ambientTemp:25,light:420}};
    assert.equal((await send('frames','POST',frame,'invalid')).status,401);
    assert.equal((await send('frames','POST',frame,await login('ma'))).status,403);
    assert.equal((await send('frames','POST',frame)).status,200);
    const live=await Promise.race([received,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WebSocket timeout')),2000))]);
    assert.equal(live.batchId,'test-batch');assert.deepEqual(live.quaternion,[0,0,0,1]);
    const result=await (await send(`latest?sessionId=${service.sessionId}&batchId=test-batch`)).json();assert.equal(result.frame.readings.light,420);
    const unrelated=await(await send(`latest?sessionId=${service.sessionId}&batchId=other`)).json();assert.equal(unrelated.frame,null);
    assert.equal((await send('frames','POST',frame)).status,409);
    const history=await(await send(`history?sessionId=${service.sessionId}&batchId=test-batch`)).json();assert.equal(history.frames.length,1);
    assert.equal((await send('calibration/test-tag','POST',{temperatureOffset:1,lightScale:1,lightOffset:0,reason:'测试参考仪表'})).status,200);
    assert.equal((await send('gyro-calibrate','POST',{sessionId:service.sessionId,batchId:'other',deviceId:'test-tag'})).status,409);
    assert.equal((await send('bridge')).status,200);
  } finally {
    if(socket) { const closed=new Promise(r=>socket.once('close',r));socket.close();await closed; }
    await service.close();
  }
});

test('stationary gyro calibration persists per device and survives collector restart',()=>{
  const db=new DatabaseSync(':memory:');const svc=createSensorService(db,{broadcastSensor:()=>{}});const at=Date.now()-5000;
  const base={deviceId:'biased-tag',batchId:'scan-1',streamId:'run-1',sampledAt:at,seq:1,readings:{accel:[0,0,1.16],gyro:[-9.2,9.6,-.6]}};
  svc.ingest('session-a',base);svc.calibrateGyro('session-a','scan-1','biased-tag');
  let frame;for(let i=1;i<=101;i++) frame=svc.ingest('session-a',{...base,sampledAt:at+i*20,seq:i+1});
  assert.equal(frame.gyroCalibration,'ready');near(frame.gyroBias[0],-9.2);
  const next=svc.ingest('session-a',{...base,streamId:'run-2',sampledAt:at+2200,seq:1});assert.equal(next.gyroCalibration,'ready');near(next.gyroBias[1],9.6);
  assert.equal(db.prepare('SELECT count(*) as n FROM sensor_calibration_events').get().n,1);db.close();
});
