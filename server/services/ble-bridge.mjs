import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { issueToken } from './auth.mjs';
import { WorkflowError } from './workflow.mjs';
const script = fileURLToPath(new URL('../../tools/sensortag/bridge.py',import.meta.url));

export function createBleBridge(db) {
  db.exec('CREATE TABLE IF NOT EXISTS sensor_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let process = null;
  let status = { state: 'idle', message: '未连接 SensorTag' };
  let apiUrl = null;
  const localPython = resolve('.venv-sensortag',globalThis.process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = globalThis.process.env.MUMAI_BLE_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
  const saved = () => JSON.parse(db.prepare("SELECT value FROM sensor_settings WHERE key='binding'").get()?.value ?? 'null');
  const launch = (args, callback, token) => {
    const child = spawn(python,[script,...args],{ env: { ...globalThis.process.env, ...(token ? { MUMAI_SENSOR_TOKEN: token } : {}) }, stdio:['ignore','pipe','pipe'] });
    let buffer='';
    child.stdout.on('data',(chunk) => {
      buffer += chunk.toString();
      const lines=buffer.split('\n'); buffer=lines.pop() ?? '';
      for (const line of lines) { try { callback(JSON.parse(line)); } catch { /* malformed diagnostic */ } }
    });
    child.stderr.on('data',()=>{});
    return child;
  };
  const stop = (persist=true) => {
    if (process) { const previous=process; process=null; previous.kill(); }
    status={...status,state:'idle',message:'采集服务已停止'};
    if (persist) db.prepare("DELETE FROM sensor_settings WHERE key='binding'").run();
  };
  const start = (config, actor='rao') => {
    if (!apiUrl) throw new WorkflowError(503,'BLE_NOT_READY','后端尚未监听');
    const {deviceId,batchId,sessionId}=config;
    if (![deviceId,batchId,sessionId].every((v)=>typeof v==='string' && /^[\w.:-]{1,100}$/.test(v))) throw new WorkflowError(422,'BAD_BINDING','设备、批次或会话标识无效');
    stop(false);
    db.prepare("INSERT OR REPLACE INTO sensor_settings(key,value) VALUES('binding',?)").run(JSON.stringify({deviceId,batchId,sessionId}));
    status={state:'connecting',message:'正在启动本机 BLE 采集服务',deviceId,batchId,sessionId};
    const child = launch(['--device',deviceId,'--batch',batchId,'--session',sessionId,'--api',apiUrl],(next)=>{
      if (process===child) status={...status,...next};
    },issueToken(actor));
    process=child;
    child.on('error',()=> { if (process===child) {status={...status,state:'error',message:'无法启动 Python，请配置 MUMAI_BLE_PYTHON'};process=null;} });
    child.on('exit',(code)=> { if(process===child) {status={...status,state:'error',message:status.state==='error'?status.message:`BLE 采集进程已退出（${code}），请重新连接`};process=null;} });
    return status;
  };
  return {
    status:()=>({...status,binding:saved()}), start, stop,
    ready(url) { apiUrl=url; const config=saved(); if(config) start(config); },
    close:()=>stop(false),
    scan() {
      return new Promise((resolve,reject)=>{
        let result=null;
        const child=launch(['--scan'],(data)=>{result=data;});
        const timer=setTimeout(()=>{child.kill();reject(new WorkflowError(504,'BLE_SCAN_TIMEOUT','蓝牙扫描超时'));},12000);
        child.on('error',()=>{clearTimeout(timer);reject(new WorkflowError(503,'BLE_PYTHON_MISSING','无法启动 Python，请配置 MUMAI_BLE_PYTHON'));});
        child.on('exit',()=>{
          clearTimeout(timer);
          if(result?.devices) resolve(result);
          else reject(new WorkflowError(503,result?.code ?? 'BLE_SCAN_FAILED',result?.message ?? '蓝牙扫描失败'));
        });
      });
    },
  };
}
