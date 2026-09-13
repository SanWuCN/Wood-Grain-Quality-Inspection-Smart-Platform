import { useState } from "react";
import { useSearchParams } from "react-router";
import { Icon } from "../icons";
import { Btn, DataTable, Modal, StateBlock, StatusChip, WaveChart } from "../ui";
import { useMumai } from "../context";
import {
  BOOT_CHECKS,
  REFERENCE_BATCHES,
  SCAN_BATCHES,
  WAVEFORMS,
} from "../seed/scenario";
import type { BootCheckItem } from "../seed/types";
import CaptureScreen from "../sensors/CaptureScreen";
import SensorWorkspace from "../sensors/SensorWorkspace";

/** 采集状态机。三个状态之间只能顺着走，不能跳 */
type CapturePhase = "idle" | "checking" | "running";

const RECEIVE_TONE: Record<string, "ok" | "warn" | "muted"> = {
  完成: "ok",
  部分接收: "warn",
  未开始: "muted",
};

const GROUP_ORDER: BootCheckItem["group"][] = ["设备", "链路", "测区"];

/* ------------------------------------------------------------------ *
 * 设备启动检查
 * ------------------------------------------------------------------ */

/**
 * 逐条确认 + 签署。
 *
 * 每条要显示「对着什么看」（expected）和「不过会怎样」（onFail）：
 * 只给一个「通过」按钮，签了等于没签。
 * 签署人取检查项自带的 owner —— 设备类归硬件工程师（饶），测区类归具身（马），
 * 这跟 PRD 2.1 的角色分工一致，不是让同一个人把所有项都签了。
 *
 * **这份检查单在弹窗里，不在页面上。** 用户的原话是「比如那个启动采集，
 * 需要确认并参数，就可以弹出一个弹窗窗口，来让我确认和签署啊，而不是在平台
 * 一级页面上生成并堆元素，排版就乱了」—— 原来点一下按钮就往页面里挂一整块
 * 检查单，左列被撑高、右列跟着错位。
 */
function BootCheckModal({
  signed,
  onSign,
  onClose,
  onStart,
}: {
  signed: Record<string, string>;
  onSign: (item: BootCheckItem) => void;
  onClose: () => void;
  onStart: () => void;
}) {
  const done = Object.keys(signed).length;
  const allDone = done === BOOT_CHECKS.length;

  return (
    <Modal
      wide
      title="设备启动检查"
      subtitle={`${done}/${BOOT_CHECKS.length} 项已签署 · 全部签署后才能开始采集`}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {allDone ? "全部签署完成，可以开始采集" : `还有 ${BOOT_CHECKS.length - done} 项未签署`}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!allDone} onClick={onStart}>
            开始采集
          </Btn>
        </>
      }>
      {GROUP_ORDER.map((group) => (
        <section key={group} className="boot-group">
          <h4 className="sub">{group}</h4>
          <ul className="boot-list">
            {BOOT_CHECKS.filter((item) => item.group === group).map((item) => {
              const signer = signed[item.id];
              return (
                <li key={item.id} className={signer ? "is-done" : ""}>
                  <div className="boot-list__head">
                    <b>{item.label}</b>
                    {signer ? (
                      <StatusChip text={`已签署 ${signer}`} tone="ok" />
                    ) : (
                      <StatusChip text="待确认" tone="warn" />
                    )}
                  </div>
                  <dl className="boot-list__meta">
                    <div>
                      <dt>核对</dt>
                      <dd>{item.expected}</dd>
                    </div>
                    <div>
                      <dt>不通过</dt>
                      <dd>{item.onFail}</dd>
                    </div>
                  </dl>
                  {signer ? null : (
                    <Btn tone="primary" onClick={() => onSign(item)}>
                      确认并签署（{item.owner}）
                    </Btn>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Modal>
  );
}

export function CaptureTab() {
  const { toast, pushEvent } = useMumai();
  const [params, setParams] = useSearchParams();
  const batchId = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";
  const batch = SCAN_BATCHES.find((item)=>item.batchId===batchId) ?? SCAN_BATCHES[0];
  const waveform = WAVEFORMS.find((item)=>item.batchId===batch.batchId) ?? WAVEFORMS[0];
  const [phase,setPhase] = useState<CapturePhase>("idle");
  const [signed,setSigned] = useState<Record<string,string>>({});
  const [checkOpen,setCheckOpen] = useState(false);
  const [configOpen,setConfigOpen] = useState(false);
  const [dataTab,setDataTab] = useState("receive");
  const [manualMarks,setManualMarks] = useState<{x:number;label:string}[]>([]);
  const allSigned=Object.keys(signed).length===BOOT_CHECKS.length;
  const selectBatch=(id:string)=>{
    const next=new URLSearchParams(params);next.set("batch",id);next.set("tab","capture");setParams(next,{replace:true});
    setPhase("idle");setSigned({});setCheckOpen(false);setManualMarks([]);
  };
  const addMark=()=>{
    const points=waveform?.points ?? [];
    if(!points.length) return;
    const peak=points.reduce((a,b)=>a.y>b.y?a:b);
    setManualMarks([...manualMarks,{x:peak.x,label:`人工标记 ${manualMarks.length+1}`}]);
    toast("已标记当前批次最强回波，可清除", "ok");
  };
  if(!batch) return <StateBlock kind="empty" title="暂无采集批次"/>;
  return <div className="capture capture--workspace">
    <section className="capture-commandbar" aria-label="采集配置与操作">
      <div className="capture-commandbar__identity"><span className="capture-commandbar__eyebrow">当前采集作业</span><b>{batch.componentId}<small>{batch.zoneId} · {batch.round}</small></b></div>
      <label className="field capture-batch"><span>采集批次</span><select aria-label="切换采集批次" value={batch.batchId} onChange={(e)=>selectBatch(e.target.value)}>{SCAN_BATCHES.map((b)=><option key={b.batchId} value={b.batchId}>{b.batchId} · {b.round}</option>)}</select></label>
      <div className="capture-commandbar__versions"><span>配置 <b>{batch.configVersion}</b></span><span>模型 <b>{batch.modelVersion}</b></span><button type="button" onClick={()=>setConfigOpen(true)}>配置详情</button></div>
      <div className="capture-commandbar__checks"><StatusChip text={phase==='running'?'采集中（演示）':phase==='checking'?'启动检查中':'待启动'} tone={phase==='running'?'ok':phase==='checking'?'warn':'muted'} dot/><button type="button" onClick={()=>{setCheckOpen(true);if(phase==='idle')setPhase('checking');}}>启动检查 {Object.keys(signed).length}/{BOOT_CHECKS.length}</button></div>
      <div className="capture-commandbar__actions"><Btn tone="primary" disabled={phase==='running'} onClick={()=>{setCheckOpen(true);setPhase('checking');}}>{phase==='checking'?'继续检查':'启动采集'}</Btn><Btn disabled={phase!=='running'} onClick={()=>{setPhase('idle');pushEvent(`批次 ${batch.batchId} 演示采集已暂停`,"warn");toast('已暂停本页演示采集；扫描枪实时数据继续接收','info');}}>暂停采集</Btn></div>
    </section>
    <SensorWorkspace key={batch.batchId} batchId={batch.batchId} screen={<CaptureScreen/>} />
    <section className="capture-data" aria-label="采集数据详情">
      <div className="capture-data__header"><div className="capture-data__tabs" role="tablist" aria-label="采集数据视图">{[['receive','接收进度'],['wave','波形与标记'],['samples','参考样本']].map(([key,label])=><button role="tab" aria-selected={dataTab===key} aria-controls={`capture-data-${key}`} id={`capture-tab-${key}`} key={key} type="button" onClick={()=>setDataTab(key)}>{label}</button>)}</div><span className="muted">批次演示回放 · 姿态与实时数据独立接收</span></div>
      <div role="tabpanel" id={`capture-data-${dataTab}`} aria-labelledby={`capture-tab-${dataTab}`}>
        {dataTab==='receive' ? <div className="capture-receive">{(['radar','image','result'] as const).map((key)=>{const item=batch.receive[key];const pct=item.expected?Math.min(100,Math.round(item.received/item.expected*100)):100;return <div key={key}><header><b>{key==='radar'?'雷达原始数据':key==='image'?'表面图像':'结果文件'}</b><StatusChip text={item.state} tone={RECEIVE_TONE[item.state]??'muted'} dot/></header><div><strong>{item.received}<small> / {item.expected}</small></strong><span>{pct}%</span></div><progress max={100} value={pct} aria-label={`${key==='radar'?'雷达数据':key==='image'?'图像':'结果文件'}接收进度`}/></div>;})}</div> : null}
        {dataTab==='wave' ? <div className="capture-wave"><div className="capture-wave__actions"><span className="note">批次波形回放 · 人工标记 {manualMarks.length} 处</span><Btn disabled={!waveform?.points?.length} onClick={addMark}><Icon name="biz-manual-mark" size={16} aria-hidden/>人工标记</Btn><Btn disabled={!manualMarks.length} tone="ghost" onClick={()=>setManualMarks([])}>清除标记</Btn></div><WaveChart points={waveform?.points??[]} unit={waveform?.unit} axisLabel={waveform?.axisLabel} markers={[...(waveform?.markers??[]),...manualMarks.map((m)=>({...m,tone:'cyan' as const}))]}/></div> : null}
        {dataTab==='samples' ? <DataTable head={["批次","分组","材种来源","扫描次数","方向"]} rows={REFERENCE_BATCHES.map((r)=>[r.batchId,r.groupId,r.material,String(r.scans),r.direction])}/> : null}
      </div>
    </section>
    {checkOpen ? <BootCheckModal signed={signed} onSign={(item)=>setSigned({...signed,[item.id]:item.owner})} onClose={()=>{setCheckOpen(false);if(phase==='checking'&&!allSigned)setPhase('idle');}} onStart={()=>{if(!allSigned)return;setCheckOpen(false);setPhase('running');pushEvent(`批次 ${batch.batchId} 启动检查已完成，开始演示采集`,"ok");toast('启动检查完成，演示采集已开始','ok');}}/> : null}
    {configOpen ? <Modal title="采集配置" subtitle={batch.batchId} onClose={()=>setConfigOpen(false)} footer={<Btn onClick={()=>setConfigOpen(false)}>关闭</Btn>}><dl className="sensor-raw">{[['构件 / 测区',`${batch.componentId} / ${batch.zoneId}`],['轮次',batch.round],['配置版本',batch.configVersion],['模型版本',batch.modelVersion],['原始数据级别',batch.rawLevel],['批次开始时间',batch.startedAt]].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{batch.frozen?<StateBlock kind="partial" title="诊断输出已冻结" hint={batch.freezeReason??'等待适用域核验'}/>:null}</Modal>:null}
  </div>;
}

export default CaptureTab;
