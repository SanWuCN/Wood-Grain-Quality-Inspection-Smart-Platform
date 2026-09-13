import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { Panel } from '../Panel';
import { Btn, Modal, StatusChip } from '../ui';
import { useSharedStore } from '../store/shared';
import { sensorRequest, useSensor } from './useSensor';
import { freshness, type SensorFrame, type BridgeStatus } from './types';
import type { Quat, Readings } from '../../../../shared/sensortag.mjs';
import './sensors.css';
const ScannerModel = lazy(() => import('./ScannerModel'));
const identity: Quat = [0,0,0,1];
const timeLabel = (at?: number | null) => at ? new Date(at).toLocaleTimeString('zh-CN',{hour12:false}) : '尚无数据';
const toneOf = (state: string) => state === '实时' ? 'ok' : state === '数据延迟' ? 'warn' : 'muted';
const METRICS: { key: keyof Readings; label: string; unit: string; digits: number }[] = [
  {key:'ambientTemp',label:'环境温度',unit:'°C',digits:1},
  {key:'light',label:'环境光照',unit:'lux',digits:1},
  {key:'humidity',label:'相对湿度',unit:'% RH',digits:1},
  {key:'pressure',label:'大气压力',unit:'hPa',digits:1},
  {key:'battery',label:'扫描枪电量',unit:'%',digits:0},
];

function Trend({ history, field, label, unit, now }: { history: SensorFrame[]; field: 'ambientTemp' | 'light'; label: string; unit: string; now: number }) {
  const points = history.filter((f)=> typeof f.readings[field] === 'number' && f.receivedAt-(f.fieldAt[field] ?? 0)<=3000 && now-f.receivedAt<300000);
  const values = points.map((f)=>f.readings[field] as number);
  const lo = Math.min(...values), hi = Math.max(...values);
  const paths: string[] = [];
  let last=0;
  points.forEach((f,i)=> {
    const x=8+(f.receivedAt-(now-300000))/300000*584;
    const y=78-(values[i]-lo)/Math.max(1,hi-lo)*58;
    if (!i || f.receivedAt-last>3000) paths.push(`M ${x} ${y}`);
    else paths[paths.length-1]+=` L ${x} ${y}`;
    last=f.receivedAt;
  });
  return <div className="sensor-trend"><header><b>{label}</b><span>{values.length ? `${lo.toFixed(1)}–${hi.toFixed(1)} ${unit}` : '暂无历史数据'}</span></header>
    <svg viewBox="0 0 600 100" role="img" aria-label={`${label}最近五分钟趋势；断线处留空`}><path className="sensor-trend__grid" d="M8 20H592 M8 50H592 M8 80H592" />
      {paths.map((d,i)=><path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="2" />)}
      {points.length===1 ? <circle cx={8+(points[0].receivedAt-(now-300000))/300000*584} cy="78" r="3" fill="currentColor" /> : null}
    </svg><footer><span>5 分钟前</span><span>现在 · 中断不补值</span></footer></div>;
}

export default function SensorWorkspace({ batchId, screen }: { batchId: string; screen: ReactNode }) {
  const sensor = useSensor(batchId);
  const actions = useSharedStore((s)=>s.allowedActions);
  const canControl = actions.includes('scan:capture') || actions.includes('console:admin');
  const [demo,setDemo] = useState(false);
  const [demoFrame,setDemoFrame] = useState<SensorFrame | null>(null);
  const [follow,setFollow] = useState(true);
  const [zero,setZero] = useState<Quat>(identity);
  const [mount,setMount] = useState<[number,number,number]>([0,0,0]);
  const [reset,setReset] = useState(0);
  const [dialog,setDialog] = useState<'connection' | 'details' | null>(null);
  const [busy,setBusy] = useState('');
  const [message,setMessage] = useState('');
  const [devices,setDevices] = useState<{deviceId:string;name:string;rssi:number}[]>([]);
  const [deviceId,setDeviceId] = useState('');
  const [calibration,setCalibration] = useState({temperatureOffset:0,lightScale:1,lightOffset:0,reason:''});
  const [detailsTab,setDetailsTab] = useState<'raw'|'trend'>('raw');
  const frame = demo ? demoFrame : sensor.frame;
  const currentDevice = frame?.deviceId ?? 'unbound';
  // Installation settings survive navigation; zero is scoped to the collector run.
  useEffect(()=> {
    try {
      const saved=JSON.parse(localStorage.getItem(`mumai.sensor.mount.${currentDevice}`) ?? 'null');
      setMount(Array.isArray(saved)&&saved.length===3&&saved.every(Number.isFinite) ? saved as [number,number,number] : [0,0,0]);
      const baseline=JSON.parse(sessionStorage.getItem(`mumai.sensor.zero.${currentDevice}.${frame?.streamId}`) ?? 'null');
      setZero(Array.isArray(baseline)&&baseline.length===4&&baseline.every(Number.isFinite) ? baseline as Quat : identity);
    } catch { setMount([0,0,0]); setZero(identity); }
  },[currentDevice,frame?.streamId]);
  useEffect(()=> {
    if (!demo) { setDemoFrame(null); return; }
    const start=performance.now();
    const timer=window.setInterval(()=> {
      const t=(performance.now()-start)/1000, at=Date.now();
      const q=new Quaternion().setFromEuler(new Euler(Math.sin(t*.8)*.3,Math.sin(t*.45)*.8,Math.sin(t*.6)*.22));
      setDemoFrame({sessionId:sensor.sessionId,batchId,deviceId:'demo-scanner',deviceName:'开发姿态演示',model:'GLB',firmware:'',streamId:'demo',seq:Math.floor(t*30),sampledAt:at,receivedAt:at,poseAt:at,readings:{},fieldAt:{},quaternion:q.toArray() as Quat,source:'demo',heading:'relative'});
    },33);
    return ()=>clearInterval(timer);
  },[demo,batchId,sensor.sessionId]);
  const calibrationAt=frame?.calibration?.at;
  const temperatureOffset=frame?.calibration?.temperatureOffset ?? 0;
  const lightScale=frame?.calibration?.lightScale ?? 1;
  const lightOffset=frame?.calibration?.lightOffset ?? 0;
  const calibrationReason=frame?.calibration?.reason ?? '';
  useEffect(()=> {
    setCalibration({temperatureOffset,lightScale,lightOffset,reason:calibrationReason});
  },[calibrationAt,currentDevice,temperatureOffset,lightScale,lightOffset,calibrationReason]);
  const poseState = freshness(frame?.poseAt,sensor.now);
  const displayPose = useMemo(()=> {
    const q=new Quaternion(...(frame?.quaternion ?? identity));
    const q0=new Quaternion(...zero).invert();
    const mounting=new Quaternion().setFromEuler(new Euler(...mount.map(MathUtils.degToRad) as [number,number,number],'XYZ'));
    // Sensor right-handed Z-up to Three.js Y-up; mounting is a basis change.
    const basis=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-Math.PI/2);
    const relative=mounting.clone().invert().multiply(q0).multiply(q).multiply(mounting).normalize();
    return { quaternion:basis.clone().multiply(relative).multiply(basis.clone().invert()).normalize().toArray() as Quat, angles:new Euler().setFromQuaternion(relative,'ZYX') };
  },[frame?.quaternion,zero,mount]);
  const { quaternion:displayQ, angles } = displayPose;
  const run = async (label: string, action: ()=>Promise<void>) => {
    setBusy(label);setMessage('');
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(''); }
  };
  const zeroPose = () => {
    if (!frame?.quaternion) return;
    setZero(frame.quaternion);
    setFollow(true);
    try { sessionStorage.setItem(`mumai.sensor.zero.${currentDevice}.${frame.streamId}`,JSON.stringify(frame.quaternion)); } catch { /* session-only fallback */ }
    setMessage('已将当前姿态设为零位');
  };
  const exportHistory = async () => {
    const all: SensorFrame[]=[];
    let after=0;
    while(true) {
      const query=new URLSearchParams({sessionId:sensor.sessionId,batchId,deviceId:currentDevice,after:String(after)});
      const result=await sensorRequest<{frames:SensorFrame[]}>(`history?${query}`);
      all.push(...result.frames);
      if(result.frames.length<1000) break;
      after=result.frames[result.frames.length-1].id ?? after;
      if(all.length>=100000) throw new Error('记录过多，请从后端按时间范围导出');
    }
    const rows=[['deviceId','batchId','sampledAt','source','temperatureRawC','temperatureCalibratedC','illuminanceRawLux','illuminanceCalibratedLux','temperatureStatus','lightStatus','humidityPct','pressureHpa','qx','qy','qz','qw'],...all.map((f)=>[f.deviceId,f.batchId,new Date(f.sampledAt).toISOString(),'ble:sensortag',f.readings.ambientTemp??'',f.calibrated?.ambientTemp??'',f.readings.light??'',f.calibrated?.light??'',freshness(f.fieldAt.ambientTemp,f.receivedAt),freshness(f.fieldAt.light,f.receivedAt),f.readings.humidity??'',f.readings.pressure??'',...(f.quaternion??['','','',''])])];
    const csv='\uFEFF'+rows.map((row)=>row.map((v)=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=`sensortag-${batchId}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setMessage(`已导出 ${all.length} 条真实记录`);
  };

  return <>
    <div className="capture-visuals">
      {screen}
      <Panel title="扫描枪姿态" className={`sensor-pose${demo?' is-demo':''}`} extra={<StatusChip text={demo?'开发调试 · 模拟姿态':poseState} tone={demo?'warn':toneOf(poseState)} dot />}>
        <div className="sensor-pose__caption"><span>{demo?'模型动作预览':frame ? '扫描枪 · 姿态跟随' : '扫描枪 · 等待连接'}</span><span>仅同步旋转</span></div>
        <div className="sensor-model" role="img" aria-label="扫描枪三维模型，拖动旋转视角，滚轮缩放">
          <Suspense fallback={<div className="sensor-model-error">正在准备 3D 模型…</div>}><ScannerModel key={demo ? "demo" : frame?.streamId ?? "waiting"} quaternion={displayQ} follow={follow && poseState==='实时'} reset={reset}/></Suspense>
          {demo ? <span className="sensor-demo-watermark">模拟姿态 · 非实机</span> : null}
          {!frame?.quaternion ? <span className="sensor-model__hint">模型已就绪 · 等待真实姿态数据</span> : !follow ? <span className="sensor-model__hint">跟随已暂停 · 读数继续接收</span> : poseState!=='实时' ? <span className="sensor-model__hint">保持最后姿态 · {timeLabel(frame.poseAt)}</span> : null}
        </div>
        <div className="sensor-angles">{[['俯仰 Pitch',angles.y],['偏航 Yaw',angles.z],['侧倾 Roll',angles.x]].map(([label,value])=><div key={String(label)}><span>{label}</span><b>{frame?.quaternion ? MathUtils.radToDeg(Number(value)).toFixed(1) : '—'}<small>°</small></b></div>)}</div>
        <div className="sensor-pose__actions"><Btn onClick={zeroPose} disabled={!frame?.quaternion || poseState!=='实时'}>姿态归零</Btn><Btn onClick={()=>setFollow(!follow)}>{follow?'暂停跟随':'开启跟随'}</Btn><Btn tone="ghost" onClick={()=>setReset(v=>v+1)}>恢复视角</Btn></div>
        <div className="sensor-pose__foot"><span>{zero !== identity ? '已归零 · ' : ''}相对航向 · 六轴融合</span><button type="button" onClick={()=>{setDemo(!demo);setZero(identity);setFollow(true);}}>{demo?'退出姿态演示':'姿态演示'}</button></div>
      </Panel>
    <section className="sensor-strip" aria-label="实时数据">
      <div className="sensor-strip__head"><div><b>实时数据</b><span>{demo?'演示仅展示模型，环境读数未模拟':sensor.bridge.state==='online' ? '扫描枪已连接' : '等待扫描枪连接'}</span></div><div><Btn tone="ghost" onClick={()=>{setDialog('details');setMessage('');}}>数据详情</Btn><Btn onClick={()=>{setDialog('connection');setMessage('');}}>连接设置</Btn></div></div>
      <div className="sensor-metrics">{METRICS.map(({key,label,unit,digits})=> {
        const value=demo ? undefined : (key==='ambientTemp' || key==='light') ? frame?.calibrated?.[key] ?? frame?.readings[key] : frame?.readings[key];
        const at=demo ? undefined : frame?.fieldAt[key];
        const state=freshness(at,sensor.now);
        return <div className={`sensor-metric${state!=='实时'?' is-stale':''}`} key={key}><header><span>{label}</span><StatusChip text={state} tone={toneOf(state)} dot /></header><strong>{typeof value==='number'?value.toFixed(digits):'—'}<small>{unit}</small></strong><footer>BLE {frame?.calibration && (key==='ambientTemp'||key==='light')?'已校准':'原始值'} · {timeLabel(at)}</footer></div>;
      })}</div>
      <div className="sensor-strip__foot"><span>{sensor.error ? `平台连接异常：${sensor.error}` : sensor.bridge.message}{sensor.bridge.batchId && sensor.bridge.batchId!==batchId ? ` · 当前采集绑定其他批次 ${sensor.bridge.batchId}` : ''}</span><span>姿态更新 {timeLabel(frame?.poseAt)} · 超过 3 秒标记延迟 / 10 秒离线</span></div>
    </section>
    </div>
    {dialog==='connection' ? <Modal title="SensorTag 连接与安装" subtitle="由平台后端电脑直接连接蓝牙；其他电脑可在同一平台查看数据" wide onClose={()=>setDialog(null)} footer={<><span className="muted">{message || sensor.bridge.message}</span><Btn onClick={()=>setDialog(null)}>完成</Btn></>}>
      <div className="sensor-connect">
        <section><h3>连接已绑定设备</h3><p className="note">打开 SensorTag，退出手机端的连接。扫描结果来自后端电脑，不是当前浏览器。</p>
          <div className="sensor-connect__row"><label className="field"><span>设备标识（MAC / UUID）</span><input value={deviceId} onChange={(e)=>setDeviceId(e.target.value)} placeholder={sensor.bridge.deviceId ?? '扫描选择或输入设备标识'} /></label><Btn disabled={!canControl||Boolean(busy)} onClick={()=>void run('scan',async()=>{const data=await sensorRequest<{devices:typeof devices}>('scan',{});setDevices(data.devices);setMessage(`发现 ${data.devices.length} 台设备，请选择 SensorTag`);})}>{busy==='scan'?'扫描中…':'扫描附近设备'}</Btn></div>
          {devices.length ? <ul className="sensor-devices">{devices.map((d)=><li key={d.deviceId}><button type="button" className={deviceId===d.deviceId?'is-selected':''} onClick={()=>setDeviceId(d.deviceId)}><b>{d.name}</b><span>{d.deviceId} · {d.rssi} dBm</span></button></li>)}</ul> : null}
          <div className="sensor-connect__row"><Btn tone="primary" disabled={!canControl||Boolean(busy)||!deviceId.trim()} onClick={()=>void run('connect',async()=>{await sensorRequest<BridgeStatus>('connect',{deviceId:deviceId.trim(),batchId,sessionId:sensor.sessionId});setMessage('已启动连接，请查看实时数据状态');sensor.reconnect();})}>绑定并连接本批次</Btn><Btn disabled={!canControl||Boolean(busy)} onClick={()=>void run('disconnect',async()=>{await sensorRequest('disconnect',{});sensor.reconnect();setMessage('已停止采集并取消自动连接');})}>断开连接</Btn><Btn tone="ghost" onClick={sensor.reconnect}>刷新连接状态</Btn></div>
          {sensor.bridge.profiles?.motion ? <p className="note">运动服务配置 {sensor.bridge.profiles.motion.config} · 固件采样周期 {parseInt(sensor.bridge.profiles.motion.period,16)*10} ms</p> : null}
          {sensor.bridge.warnings?.map((warning)=><p className="note" key={warning}>{warning}</p>)}
          {!canControl ? <p className="note">当前账号只读，使用有采集权限的账号连接设备。</p> : null}
          <details className="sensor-install"><summary>首次部署说明</summary><p>后端需安装 Python 3 与 Bleak，并允许终端使用蓝牙。将 MUMAI_BLE_PYTHON 指向已安装 Bleak 的 Python 后重启后端。</p><code>python3 -m pip install -r tools/sensortag/requirements.txt</code><p>不同固件可能提供不同传感器。无法订阅时保留空值，需检查实际 GATT 服务。</p></details>
        </section>
        <section><h3>安装方向</h3><p className="note">先设定 SensorTag 相对枪体的固定转角，再将实物水平指向正前方并归零。按设备保存。</p><div className="sensor-mount">{['X','Y','Z'].map((axis,i)=><label className="field" key={axis}><span>{axis} 轴修正</span><select value={mount[i]} onChange={(e)=>{const next=[...mount] as [number,number,number];next[i]=Number(e.target.value);setMount(next);try{localStorage.setItem(`mumai.sensor.mount.${currentDevice}`,JSON.stringify(next));}catch{/* in-memory fallback */}}}>{[-180,-90,0,90,180].map((angle)=><option key={angle} value={angle}>{angle}°</option>)}</select></label>)}</div><Btn disabled={!frame?.quaternion||poseState!=='实时'} onClick={zeroPose}>以当前姿态归零</Btn><Btn disabled={!canControl||!sensor.frame?.quaternion||demo||poseState!=='实时'||Boolean(busy)} onClick={()=>void run('gyro',async()=>{await sensorRequest('gyro-calibrate',{sessionId:sensor.sessionId,batchId,deviceId:currentDevice});setMessage('请保持扫描枪静止，正在收集 100 个稳定采样');})}>陀螺仪静置校准</Btn><p className="note">零偏校准：{frame?.gyroCalibration==='ready'?'已完成':frame?.gyroCalibration==='collecting'?'请静置，正在采样':'尚未执行'}</p><p className="note">安装参数仅影响本浏览器的模型显示。需要在最终安装后逐轴核对；偏航为相对角，长时间使用后可重新归零。</p></section>
      </div>
      <details className="sensor-install"><summary>温度与光照校准</summary><p>与参考仪表在同一环境稳定对照后填写。原始数据保留，温度增加偏移；光照乘以系数后增加偏移。</p><div className="sensor-calibration-fields">{([['temperatureOffset','温度偏移 °C'],['lightScale','光照系数'],['lightOffset','光照偏移 lux']] as const).map(([key,label])=><label className="field" key={key}><span>{label}</span><input type="number" step="0.1" value={calibration[key]} onChange={(e)=>setCalibration({...calibration,[key]:Number(e.target.value)})}/></label>)}<label className="field"><span>校准依据</span><input value={calibration.reason} onChange={(e)=>setCalibration({...calibration,reason:e.target.value})} placeholder="参考仪器及对照读数"/></label></div><Btn disabled={!canControl||!sensor.frame||demo||Boolean(busy)} onClick={()=>void run('calibrate',async()=>{await sensorRequest(`calibration/${encodeURIComponent(currentDevice)}`,calibration);setMessage('校准已保存，后续真实采样将使用新参数，原始值保持不变');})}>保存校准</Btn></details>
      {message ? <p role="status" className="sensor-message">{message}</p> : null}
    </Modal> : null}
    {dialog==='details' ? <Modal wide title="传感器数据详情" subtitle={`${batchId} · ${frame?.deviceName ?? '尚未连接'} · ${frame?.model ?? ''}`} onClose={()=>setDialog(null)} footer={<><span className="muted">{message || (frame?.calibration ? `已校准 · ${frame.calibration.actor} · ${timeLabel(frame.calibration.at)}` : '环境读数为原始实测值，未应用偏移校准')}</span><Btn disabled={!sensor.frame||demo||Boolean(busy)} onClick={()=>void run('export',exportHistory)}>{busy==='export'?'导出中…':'导出真实记录 CSV'}</Btn><Btn onClick={()=>setDialog(null)}>关闭</Btn></>}>
      <div className="sensor-detail-tabs"><Btn active={detailsTab==='raw'} onClick={()=>setDetailsTab('raw')}>原始读数</Btn><Btn active={detailsTab==='trend'} onClick={()=>setDetailsTab('trend')}>最近 5 分钟趋势</Btn></div>
      {detailsTab==='trend' ? <><Trend history={sensor.history} field="ambientTemp" label="环境温度" unit="°C" now={sensor.now}/><Trend history={sensor.history} field="light" label="光照" unit="lux" now={sensor.now}/><p className="note">展示最近五分钟真实记录，重新打开页面会恢复历史；完整记录可导出 CSV。</p></> : <>
        <dl className="sensor-raw"><div><dt>设备 ID</dt><dd>{frame?.deviceId ?? '—'}</dd></div><div><dt>固件版本</dt><dd>{frame?.firmware || '未提供'}</dd></div><div><dt>序号 / 采样时间</dt><dd>{frame?.seq ?? '—'} / {timeLabel(frame?.sampledAt)}</dd></div><div><dt>信号强度 RSSI</dt><dd>{frame?.readings.rssi ?? '未提供'} {frame?.readings.rssi!==undefined?'dBm':''}</dd></div>
          {([['accel','加速度','g'],['gyro','角速度','°/s'],['mag','磁场','µT']] as const).map(([key,label,unit])=><div key={key}><dt>{label} X / Y / Z</dt><dd>{frame?.readings[key]?.map((v)=>v.toFixed(3)).join(' / ') ?? '—'} {unit}<small>{freshness(frame?.fieldAt[key],sensor.now)} · {timeLabel(frame?.fieldAt[key])}</small></dd></div>)}
          <div><dt>原始环境温度 / 光照</dt><dd>{frame?.readings.ambientTemp?.toFixed(1) ?? '—'} °C / {frame?.readings.light?.toFixed(1) ?? '—'} lux</dd></div><div><dt>校准后温度 / 光照</dt><dd>{frame?.calibrated?.ambientTemp?.toFixed(1) ?? '—'} °C / {frame?.calibrated?.light?.toFixed(1) ?? '—'} lux</dd></div><div><dt>目标温度</dt><dd>{frame?.readings.objectTemp?.toFixed(1) ?? '—'} °C</dd></div><div><dt>按键位掩码</dt><dd>{frame?.readings.keys ?? '未提供'}</dd></div><div><dt>四元数 x / y / z / w</dt><dd>{frame?.quaternion?.map((v)=>v.toFixed(4)).join(' / ') ?? '—'}</dd></div>
        </dl><p className="note">磁力计全零可能表示未启用或固件不支持；不以零磁场推算绝对航向。RSSI 仅在采集端提供时展示。</p></>}
    </Modal> : null}
  </>;
}
