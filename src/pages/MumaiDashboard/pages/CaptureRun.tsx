import { useState } from "react";
import { useSearchParams } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { Icon } from "../icons";
import { Btn, DataTable, Modal, StateBlock, StatusChip, WaveChart } from "../ui";
import { useMumai } from "../context";
import {
  BOOT_CHECKS,
  DATA_PACKAGES,
  REFERENCE_BATCHES,
  SCAN_BATCHES,
  waveformFor,
} from "../seed/scenario";
import type { BootCheckItem } from "../seed/types";
import CaptureScreen from "../sensors/CaptureScreen";
import SensorWorkspace from "../sensors/SensorWorkspace";
import { buildCaptureInsights } from "./operationInsights";

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
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <Modal
      wide
      title="归档设备检查记录"
      subtitle={
        <span>归档批次未附现场签署记录，当前页面不执行启动采集</span>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">检查项用于复核归档条件，不能代替现场确认</span>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      {GROUP_ORDER.map((group) => (
        <section key={group} className="boot-group">
          <h4 className="sub">{group}</h4>
          <ul className="boot-list">
            {BOOT_CHECKS.filter((item) => item.group === group).map((item) => {
              return (
                <li key={item.id}>
                  <div className="boot-list__head">
                    <b>{item.label}</b>
                    <StatusChip text="未附签署记录" tone="warn" />
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
  const { toast } = useMumai();
  const [params, setParams] = useSearchParams();
  const batchId = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";
  const batch = SCAN_BATCHES.find((item)=>item.batchId===batchId) ?? SCAN_BATCHES[0];
  /* 采集页看的是**原始时域形状**（波形回放），所以取向取回波 */
  const waveform = waveformFor(batch.batchId, "echo");
  const [checkOpen,setCheckOpen] = useState(false);
  const [configOpen,setConfigOpen] = useState(false);
  const [dataTab,setDataTab] = useState("outcome");
  const [manualMarks,setManualMarks] = useState<{x:number;label:string}[]>([]);
  const selectBatch=(id:string)=>{
    const next=new URLSearchParams(params);next.set("batch",id);next.set("tab","capture");setParams(next,{replace:true});
    setCheckOpen(false);setManualMarks([]);
  };
  const addMark=()=>{
    const points=waveform?.points ?? [];
    if(!points.length) return;
    const peak=points.reduce((a,b)=>a.y>b.y?a:b);
    setManualMarks([...manualMarks,{x:peak.x,label:`人工标记 ${manualMarks.length+1}`}]);
    toast("已标记当前批次最强回波，可清除", "ok");
  };
  if(!batch) return <StateBlock kind="empty" title="暂无采集批次"/>;
  const insights=buildCaptureInsights(batch,DATA_PACKAGES);
  /*
    会随操作变的数交给 `NumberAnimation`：启动检查签署进度、接收条数 / 百分比、
    人工标记处数。**不参与滚动**的是记录字段与几何量 —— 批次号 / 构件号 / 轮次、
    配置与模型版本、批次开始时间（编号、版本、时间戳），以及 `<progress>` 的
    max/value 本身（进度条按数值直接画，滚动它只会让条子追不上数字）。
  */
  return <div className="capture capture--workspace">
    <section className="capture-commandbar" aria-label="采集配置与操作">
      <div className="capture-commandbar__identity"><span className="capture-commandbar__eyebrow">当前采集作业</span><b>{batch.componentId}<small>{batch.zoneId} · {batch.round}</small></b></div>
      <label className="field capture-batch"><span>采集批次</span><select aria-label="切换采集批次" value={batch.batchId} onChange={(e)=>selectBatch(e.target.value)}>{SCAN_BATCHES.map((b)=><option key={b.batchId} value={b.batchId}>{b.batchId} · {b.round}</option>)}</select></label>
      <div className="capture-commandbar__versions"><span>配置 <b>{batch.configVersion}</b></span><span>模型 <b>{batch.modelVersion}</b></span><button type="button" onClick={()=>setConfigOpen(true)}>配置详情</button></div>
      <div className="capture-commandbar__checks"><StatusChip text="归档检查记录" tone="muted" dot/><button type="button" onClick={()=>setCheckOpen(true)}>检查项 <NumberAnimation value={0}/>/{BOOT_CHECKS.length}</button></div>
      <div className="capture-commandbar__actions"><Btn tone="primary" onClick={()=>setCheckOpen(true)}>查看检查项</Btn></div>
    </section>
    <SensorWorkspace key={batch.batchId} batchId={batch.batchId} screen={<CaptureScreen/>} />
    <section className="capture-data" aria-label="采集数据详情">
      <div className="capture-data__header"><div className="capture-data__tabs" role="tablist" aria-label="采集数据视图">{[['outcome','成果概览'],['receive','接收进度'],['wave','波形与标记'],['samples','参考样本']].map(([key,label])=><button role="tab" aria-selected={dataTab===key} aria-controls={`capture-data-${key}`} id={`capture-tab-${key}`} key={key} type="button" onClick={()=>setDataTab(key)}>{label}</button>)}</div><span className="muted">归档批次记录 · 姿态与设备记录独立保存</span></div>
      <div role="tabpanel" id={`capture-data-${dataTab}`} aria-labelledby={`capture-tab-${dataTab}`}>
        {dataTab==='outcome' ? <div className="capture-outcome">
          <section className="capture-outcome__summary" aria-label="批次采集汇总">
            <div className="capture-outcome__progress"><span>批次接收完成度</span><strong><NumberAnimation value={insights.progress} group={false}/><small>%</small></strong><progress max={100} value={insights.progress} aria-label="批次接收完成度"/><em><NumberAnimation value={insights.received} group={false}/> / <NumberAnimation value={insights.expected} group={false}/> 条</em></div>
            <dl className="capture-outcome__metrics"><div><dt>成果文件</dt><dd><NumberAnimation value={insights.artifacts.length}/> 个</dd></div><div><dt>完整性校验</dt><dd><NumberAnimation value={insights.integrity.passed}/> / <NumberAnimation value={insights.integrity.total}/></dd></div><div className={insights.issues.length?'is-warn':''}><dt>待复核</dt><dd><NumberAnimation value={insights.issues.length}/> 项</dd></div><div><dt>开始时间</dt><dd>{batch.startedAt}</dd></div></dl>
          </section>
          <section className="capture-outcome__artifacts" aria-label="批次成果文件"><header><b>成果文件与时间线</b><span>{batch.batchId}</span></header><ol>{insights.artifacts.map((item)=><li key={item.id}><time>{item.capturedAt}</time><span><b>{item.name}</b><small>{item.kind} · {item.source}</small></span><StatusChip text={`${item.state} · 校验 ${item.passedChecks}/${item.totalChecks}`} tone={item.passedChecks===item.totalChecks?'ok':'warn'}/></li>)}</ol></section>
          <section className="capture-outcome__issues" aria-label="待复核记录"><header><b>待复核记录</b><Btn tone="ghost" onClick={()=>setDataTab('wave')}>查看波形依据</Btn></header>{insights.issues.length?<ul>{insights.issues.map((item)=><li key={item.key}><span>{item.source}</span><b>{item.detail}</b></li>)}</ul>:<StateBlock kind="empty" title="当前批次没有待复核记录"/>}</section>
        </div> : null}
        {dataTab==='receive' ? <div className="capture-receive">{insights.channels.map((item)=><div key={item.key}><header><b>{item.label}</b><StatusChip text={item.state} tone={RECEIVE_TONE[item.state]??'muted'} dot/></header><div><strong><NumberAnimation value={item.received} group={false}/><small> / <NumberAnimation value={item.expected} group={false}/></small></strong><span><NumberAnimation value={item.progress} group={false}/>%</span></div><progress max={100} value={item.progress} aria-label={`${item.label}接收进度`}/></div>)}</div> : null}
        {dataTab==='wave' ? <div className="capture-wave"><div className="capture-wave__actions"><span className="note">批次波形回放 · 人工标记 <NumberAnimation value={manualMarks.length}/> 处</span><Btn disabled={!waveform?.points?.length} onClick={addMark}><Icon name="biz-manual-mark" size={16} aria-hidden/>人工标记</Btn><Btn disabled={!manualMarks.length} tone="ghost" onClick={()=>setManualMarks([])}>清除标记</Btn></div><WaveChart points={waveform?.points??[]} unit={waveform?.unit} axisLabel={waveform?.axisLabel} bipolar={waveform?.bipolar} xTicks={waveform?.xTicks} paramLine={waveform?.paramLine} markers={[...(waveform?.markers??[]),...manualMarks.map((m)=>({...m,tone:'cyan' as const}))]}/></div> : null}
        {dataTab==='samples' ? <DataTable head={["批次","分组","材种来源","扫描次数","方向"]} rows={REFERENCE_BATCHES.map((r)=>[r.batchId,r.groupId,r.material,String(r.scans),r.direction])}/> : null}
      </div>
    </section>
    {checkOpen ? <BootCheckModal onClose={()=>setCheckOpen(false)}/> : null}
    {configOpen ? <Modal title="采集配置" subtitle={batch.batchId} onClose={()=>setConfigOpen(false)} footer={<Btn onClick={()=>setConfigOpen(false)}>关闭</Btn>}><dl className="sensor-raw">{[['构件 / 测区',`${batch.componentId} / ${batch.zoneId}`],['轮次',batch.round],['配置版本',batch.configVersion],['模型版本',batch.modelVersion],['原始数据级别',batch.rawLevel],['批次开始时间',batch.startedAt]].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{batch.frozen?<StateBlock kind="partial" title="诊断输出已冻结" hint={batch.freezeReason??'等待适用域核验'}/>:null}</Modal>:null}
  </div>;
}

export default CaptureTab;
