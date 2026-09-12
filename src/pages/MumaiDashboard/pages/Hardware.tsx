/**
 * 硬件详情（`/hardware`）
 *
 * 由原「检测适配」页拆出：把**设备侧**的三件事收在一页 ——
 *   1. 采集作业：手持毫米波扫描枪按测区采集，落盘与接收状态
 *   2. 异常排查：设备 / 信号 / 测区 / 适用域四项排查与签名
 *   3. 硬件监看：扫描枪的固件、配置、连接、电量、温度与三路接收实况
 *
 * 前两个页签的实现原样复用 `adaptTabs.tsx`（那部分已经按 PRD 做完，不重写）；
 * 「硬件监看」是本页新增 —— 用户明确要求「可以采集数据、监看硬件数据
 * （毫米波扫描枪），做数据分析」。
 *
 * 所有设备数据来自 `seed/`，页面不硬编码任何版本号或读数。
 */

import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, DataTable, KV, Metric, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { useMumai } from "../context";
import { CaptureTab, TriageTab } from "./adaptTabs";
import { CHANNELS, DEVICES, REFERENCE_BATCHES, SCAN_BATCHES } from "../seed/scenario";
import { VERSION_ITEMS } from "../seed/versions";
import type { Tone } from "../lib";

const TABS = [
  { key: "capture", label: "采集作业" },
  { key: "triage", label: "异常排查" },
  { key: "monitor", label: "硬件监看" },
] as const;

const CHANNEL_TONE: Record<string, Tone> = {
  online: "ok",
  stale: "warn",
  offline: "danger",
};

const RECEIVE_TONE: Record<string, Tone> = {
  完成: "ok",
  部分接收: "warn",
  未开始: "muted",
};

const versionOf = (key: string) =>
  VERSION_ITEMS.find((item) => item.key === key)?.current ?? "—";

/**
 * 硬件监看
 *
 * 只展示「设备现在是什么状态」：固件 / 配置 / 连接 / 电量 / 温度 / 三路接收。
 * 不在这里做结论判定 —— 缺陷结论属于模型侧，混在一起会让口径不清（PRD 3.4）。
 */
function MonitorTab() {
  const { toast } = useMumai();

  /** 三路接收汇总：这一批到底收全了没有，是采集侧最常被问到的问题 */
  const receiveRows = useMemo(() => {
    const rows: { k: string; v: React.ReactNode }[] = [];
    for (const batch of SCAN_BATCHES) {
      for (const [channel, label] of [
        ["radar", "原始数据"],
        ["image", "表面图像"],
        ["result", "结果文件"],
      ] as const) {
        const item = batch.receive[channel];
        rows.push({
          k: `${batch.batchId} · ${label}`,
          v: (
            <span className="hw-receive">
              <StatusChip text={item.state} tone={RECEIVE_TONE[item.state] ?? "muted"} dot />
              <em>
                {item.received} / {item.expected}
              </em>
              {batch.frozen ? <b className="hw-frozen">批次已冻结</b> : null}
            </span>
          ),
        });
      }
    }
    return rows;
  }, []);

  return (
    <div className="hw-monitor">
      <Panel
        title="设备状态"
        extra={<StatusChip text="模拟采集" tone="warn" dot />}
        className="hw-panel">
        <div className="hw-metrics">
          <Metric label="固件版本" value={versionOf("scanner-firmware")} />
          <Metric label="采集配置" value={versionOf("scanner-config")} />
          <Metric label="运行模型" value={versionOf("model")} />
          <Metric label="推理流水线" value={versionOf("pipeline")} />
        </div>
        <KV
          columns={2}
          items={[
            { k: "设备", v: DEVICES.scanner.name },
            { k: "设备编号", v: DEVICES.scanner.id },
            { k: "数据来源", v: <SourceTag label="模拟采集" /> },
            {
              k: "连接",
              v: <StatusChip text="已连接 · 只读监视" tone="ok" dot />,
            },
          ]}
        />
      </Panel>

      <Panel
        title="通道状态"
        extra={<span className="muted">四路独立</span>}
        className="hw-panel">
        <DataTable
          head={["通道", "状态", "更新时间", "数据来源"]}
          rows={CHANNELS.map((channel) => [
            channel.label,
            <StatusChip
              key={channel.key}
              text={
                channel.state === "online" ? "正常" : channel.state === "stale" ? "延迟" : "断开"
              }
              tone={CHANNEL_TONE[channel.state] ?? "muted"}
              dot
            />,
            `${channel.updatedAt} · ${channel.ageSec}s`,
            channel.source,
          ])}
        />
      </Panel>

      <Panel
        title="采集接收"
        extra={
          <Btn tone="ghost" onClick={() => toast("已向扫描枪请求重传未接收分片", "info")}>
            补传
          </Btn>
        }
        className="hw-panel">
        <KV columns={1} items={receiveRows} />
      </Panel>

      <Panel title="参考样本" extra={<span className="muted">{REFERENCE_BATCHES.length} 组</span>} className="hw-panel">
        <DataTable
          head={["批次", "物理样本组", "材质来源", "扫描次数", "方向"]}
          rows={REFERENCE_BATCHES.map((batch) => [
            batch.batchId,
            batch.groupId,
            batch.material,
            `${batch.scans} 次`,
            batch.direction,
          ])}
        />
      </Panel>
    </div>
  );
}

export default function Hardware() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? TABS[0].key;
  const batch = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";

  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    // PRD 2.2：切换页签保留筛选条件与当前批次
    next.set("batch", batch);
    setParams(next, { replace: true });
  };

  const frozen = SCAN_BATCHES.find((item) => item.batchId === batch)?.frozen ?? false;

  return (
    <div className="page page--adapt">
      <Toolbar
        note={
          <>
            <SourceTag label="演示回放" />
            <span>当前批次 {batch}</span>
            <span>只读</span>
          </>
        }>
        {TABS.map((item) => (
          <Btn key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
            {item.label}
          </Btn>
        ))}
      </Toolbar>

      {frozen ? (
        <StateBlock
          kind="partial"
          title="该批次已冻结诊断输出"
          hint="适用域待核验：缺少该批次木材的有效标定记录，平台不输出病害结论，等待专业复核。"
        />
      ) : null}

      <div className="adapt-body">
        {tab === "capture" ? <CaptureTab /> : null}
        {tab === "triage" ? <TriageTab /> : null}
        {tab === "monitor" ? <MonitorTab /> : null}
      </div>
    </div>
  );
}
