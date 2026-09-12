/**
 * 硬件详情（`/hardware`）
 *
 * 由原「检测适配」页拆出：把**设备侧**的三件事收在一页 ——
 *   1. 采集作业：手持毫米波扫描枪按测区采集，落盘与接收状态
 *   2. 异常排查：设备 / 信号 / 测区 / 适用域四项排查与签名
 *   3. 硬件监看：扫描枪的固件、配置、连接与实时读数，四路通道，
 *      以及三个采集批次的逐路接收进度
 *
 * 前两个页签的实现原样复用 `adaptTabs.tsx`（那部分已经按 PRD 做完，不重写）；
 * 「硬件监看」是本页新增 —— 用户明确要求「可以采集数据、监看硬件数据
 * （毫米波扫描枪），做数据分析」。
 *
 * 所有设备数据来自 `seed/`，页面不硬编码任何版本号或读数。
 * 读数是否合格由页面按种子里的阈值现算（`readingState`），结论不写进种子，
 * 避免「读数已经不合格、结论还写着合格」。
 */

import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, DataTable, KV, Metric, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { useMumai } from "../context";
import { CaptureTab, TriageTab } from "./adaptTabs";
import {
  CHANNELS,
  DEVICES,
  REFERENCE_BATCHES,
  SCAN_BATCHES,
  SCANNER_TELEMETRY,
  SCANNER_TELEMETRY_AT,
} from "../seed/scenario";
import { VERSION_ITEMS } from "../seed/versions";
import type { DeviceReading } from "../seed/types";
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
 * 单条读数的判定。
 *
 * 阈值在种子里，结论在页面现算 —— 改一条读数，采集条件跟着变，
 * 不会出现「读数已经不合格、结论还写着合格」的假一致。
 * 没有阈值的项只监看不判定（返回「仅监看」而不是硬凑一个结论）。
 */
function readingState(item: DeviceReading): { tone: Tone; text: string } {
  const bad = item.min !== undefined && item.value < item.min
    ? "低于下限"
    : item.max !== undefined && item.value > item.max
      ? "超出上限"
      : null;
  if (bad) {
    // 采集前核对项不合格 = 不满足采集条件，这是 SOP 的硬门槛，不只是「偏低」
    return item.preflight
      ? { tone: "danger", text: "不满足采集条件" }
      : { tone: "warn", text: bad };
  }
  if (item.min !== undefined || item.max !== undefined) return { tone: "ok", text: "合格" };
  return { tone: "muted", text: "仅监看" };
}

/** 读数带单位显示：小数位由种子给定，同一列不会 68 与 68.0 混排 */
function readingValue(item: DeviceReading): string {
  return item.digits === undefined ? String(item.value) : item.value.toFixed(item.digits);
}

/**
 * 设备读数
 *
 * 手持设备的实时读数。前三项是知识库 SOP 要求的采集前核对项
 * （电量 / 存储余量 / 时间同步），任一不满足即不开始采集，所以
 * 面板标题右侧直接给「核对几项通过」，而不是让操作员自己逐条比阈值。
 */
function ReadingsPanel() {
  const preflight = SCANNER_TELEMETRY.filter((item) => item.preflight);
  const failed = preflight.filter((item) => readingState(item).tone !== "ok");

  return (
    <Panel
      title="设备读数"
      extra={
        <StatusChip
          text={
            failed.length === 0
              ? `采集前核对 ${preflight.length}/${preflight.length} 通过`
              : `采集前核对 ${failed.length} 项不满足`
          }
          tone={failed.length === 0 ? "ok" : "danger"}
          dot
        />
      }
      className="hw-panel">
      <ul className="hw-readings">
        {SCANNER_TELEMETRY.map((item) => {
          const state = readingState(item);
          const filled =
            item.scale === undefined
              ? null
              : Math.min(100, Math.max(0, (item.value / item.scale) * 100));
          return (
            <li key={item.key}>
              <span className="hw-readings__label">
                {item.label}
                {item.preflight ? <i title="采集前必须核对项">核对</i> : null}
              </span>
              <b>
                {readingValue(item)}
                <em>{item.unit}</em>
              </b>
              {filled === null ? (
                <span className="hw-readings__bar is-none" />
              ) : (
                <span className="hw-readings__bar">
                  <i style={{ width: `${filled}%` }} />
                </span>
              )}
              <StatusChip text={state.text} tone={state.tone} dot />
            </li>
          );
        })}
      </ul>
      <p className="note">
        采样时间 {SCANNER_TELEMETRY_AT}
        {SCANNER_TELEMETRY.some((item) => item.note)
          ? ` · ${SCANNER_TELEMETRY.filter((item) => item.note)
              .map((item) => `${item.label}${item.note}`)
              .join(" · ")}`
          : ""}
      </p>
    </Panel>
  );
}

/**
 * 采集接收
 *
 * 按批次给整批完成度 + 逐路进度条。原来只有「386 / 420」这样的两列数字，
 * 操作员要自己心算这一批到底收全了没有；进度条把「还差多少」直接画出来，
 * 整批百分比也是从同一份 receive 现算的，没有第二个口径。
 */
function ReceivePanel() {
  const { toast } = useMumai();

  const batches = useMemo(
    () =>
      SCAN_BATCHES.map((batch) => {
        const channels = (["radar", "image", "result"] as const).map((key) => ({
          key,
          label: key === "radar" ? "原始数据" : key === "image" ? "表面图像" : "结果文件",
          ...batch.receive[key],
        }));
        const received = channels.reduce((sum, item) => sum + item.received, 0);
        const expected = channels.reduce((sum, item) => sum + item.expected, 0);
        return {
          batch,
          channels,
          received,
          expected,
          /* 预期为 0（该批次本就不产生这一路）时按已完成算，不做除零 */
          pct: expected === 0 ? 100 : Math.round((received / expected) * 100),
        };
      }),
    [],
  );

  return (
    <Panel
      title="采集接收"
      extra={
        <Btn tone="ghost" onClick={() => toast("已向扫描枪请求重传未接收分片", "info")}>
          补传
        </Btn>
      }
      className="hw-panel">
      <ul className="hw-batches">
        {batches.map(({ batch, channels, received, expected, pct }) => (
          <li key={batch.batchId}>
            <header>
              <b>{batch.batchId}</b>
              <span className="muted">{batch.round}</span>
              {batch.frozen ? <b className="hw-frozen">批次已冻结</b> : null}
              <em>
                {received} / {expected}
                <strong>{pct}%</strong>
              </em>
            </header>
            <span className="hw-batches__bar">
              <i style={{ width: `${pct}%` }} />
            </span>
            <ul className="hw-channels">
              {channels.map((item) => (
                <li key={item.key}>
                  <span>{item.label}</span>
                  <span className="hw-channels__bar">
                    <i
                      style={{
                        width: `${
                          item.expected === 0
                            ? 100
                            : Math.min(100, (item.received / item.expected) * 100)
                        }%`,
                      }}
                    />
                  </span>
                  <em>
                    {item.received} / {item.expected}
                  </em>
                  <StatusChip text={item.state} tone={RECEIVE_TONE[item.state] ?? "muted"} dot />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * 硬件监看
 *
 * 只展示「设备现在是什么状态」：固件 / 配置 / 连接 / 读数 / 三路接收。
 * 不在这里做结论判定 —— 缺陷结论属于模型侧，混在一起会让口径不清（PRD 3.4）。
 * 阈值判定是例外：采集条件属于设备侧，且 SOP 就要求采集前核对。
 */
function MonitorTab() {
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

      <ReadingsPanel />

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

      <ReceivePanel />

      <Panel
        title="参考样本"
        extra={<span className="muted">{REFERENCE_BATCHES.length} 组</span>}
        className="hw-panel hw-panel--samples">
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
          hint="缺少该批次木材的有效标定记录，暂不输出病害结论，等待专业复核。"
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
