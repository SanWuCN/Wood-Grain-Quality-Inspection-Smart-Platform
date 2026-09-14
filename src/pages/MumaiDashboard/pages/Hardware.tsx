/**
 * 硬件详情（`/hardware`）
 *
 * 由原「检测适配」页拆出：把**设备侧**的三件事收在一页 ——
 *   1. 采集作业：毫米波扫描仪按测区采集，落盘与接收状态
 *   2. 异常排查：设备 / 信号 / 测区 / 适用域四项排查与签名
 *   3. 硬件监看：扫描枪的固件、配置、连接与实时读数，四路通道，
 *      以及采集批次的逐路接收进度
 *
 * 前两个页签的实现原样复用 `adaptTabs.tsx`（那部分已经按 PRD 做完，不重写）；
 * 「硬件监看」是本页新增 —— 用户明确要求「可以采集数据、监看硬件数据
 * （毫米波扫描枪），做数据分析」。
 *
 * ## 数据来源：真机优先，种子兜底
 *
 * 这一页的四块（设备状态 / 设备读数 / 通道状态 / 采集接收）原来全是
 * `seed/scenario.ts` 的种子。现在接的是手持终端（树莓派 Pi 5 · `woodpulse`）
 * 真实上报的那一份：终端每 2 秒 `POST /api/devices/{id}/hardware`，
 * 页面按同样的节奏取 `GET`（见 `device/useDeviceLink.ts`）。
 *
 * 三条必须守住的显示口径（终端文档 §2.5 / §4）：
 *   · **来源要能一眼看出来**：`readings[].source` 分实测 / 推算 / 估算三档，
 *     面板上逐条标出来，种子兜底时则整块挂「模拟采集」；
 *   · **没有的就是没有**：终端没有电量计就不发 `battery`，页面也**不补默认值**
 *     （补一个 68% 会让人以为设备有电量计，现场换电池时误导人）；
 *   · **断流只影响该设备**：设备离线时保留最后一份真机数据并标「离线」，
 *     不静默回退成种子（那会让人以为设备还在上报）。
 *
 * 判定永远在页面现算（`readingState`），种子与真机走同一套阈值逻辑：
 * 改了读数，结论跟着变，不会出现「读数已经不合格、结论还写着合格」。
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, DataTable, KV, Metric, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { Icon } from "../icons";
import { useMumai } from "../context";
import { CaptureTab } from "./CaptureRun";
import { TriageTab } from "./TriageLog";
import { api } from "../api/client";
import { useDeviceLink, useDevicePreview, type DeviceLink } from "../device/useDeviceLink";
import { BATCH_STATE_LABEL, HANDHELD_DEVICE_ID, toScanBatch, type DeviceReport } from "../device/types";
import { CHANNELS, DEVICES, SCAN_BATCHES, SCANNER_READING_LAYOUT } from "../seed/scenario";
import { VERSION_ITEMS } from "../seed/versions";
import type { ChannelStatus, DeviceReading, ScanBatch } from "../seed/types";
import type { Tone } from "../lib";

/*
  页签图标（PRD §5「硬件详情与采集：mapping、cart、设备离线等按用途接入」）。
  本页三个页签是设备侧的三件事，图标按语义取：
    采集作业 → nav-capture        取景框（采集）
    异常排查 → status-warning     告警（异常排查）
    硬件监看 → status-device-offline 的**反向语义**不能用（那是离线）；
               这里用 identity-agent（设备主体）表达「看设备本身的状态」
*/
const TABS = [
  { key: "capture", label: "采集作业", icon: "nav-capture" },
  { key: "triage", label: "异常排查", icon: "status-warning" },
  { key: "monitor", label: "硬件监看", icon: "identity-agent" },
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

const clockOf = (value?: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString("zh-CN", { hour12: false });
};

/**
 * 单条读数的判定。
 *
 * 阈值随读数一起来（种子与终端上报都有），结论在页面现算 ——
 * 改一条读数，采集条件跟着变，不会出现「读数已经不合格、结论还写着合格」的假一致。
 * 没有阈值的项只监看不判定（返回「仅监看」而不是硬凑一个结论）。
 *
 * `value` 由调用方传入（种子兜底时是浮动后的值），判定永远针对**当前显示的那个数**，
 * 不能拿种子里的基准值去判态 —— 否则屏幕上写着 39%，结论却说合格。
 */
function readingState(item: DeviceReading, value: number): { tone: Tone; text: string } {
  const bad = item.min !== undefined && value < item.min
    ? "低于下限"
    : item.max !== undefined && value > item.max
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

/** 读数带单位显示：小数位由数据给定，同一列不会 68 与 68.0 混排 */
function readingValue(item: DeviceReading, value: number): string {
  return item.digits === undefined ? String(Math.round(value)) : value.toFixed(item.digits);
}

/* ------------------------------------------------------------------ *
 * 数字动效的格式化器
 * ------------------------------------------------------------------ */

/**
 * 交给 `NumberAnimation` 的格式化器一律放模块作用域，不写成内联箭头。
 *
 * 组件把 `format` 存进 ref 里逐帧调用，所以滚动过程中的每一帧与最终落值
 * 走的是同一个函数 —— 小数位与单位不会在动画中途跳变。写成模块级常量，
 * 「这一处的数字到底怎么写」也能一眼查到；下面的实现全是**复用既有口径**，
 * 不在这里另写一份 round / toFixed。
 */

/** 单条读数：小数位由读数项自己给（同一列不会 68 与 68.0 混排） */
const readingFormat = (item: DeviceReading) => (value: number) => readingValue(item, value);

/** 平台延迟：一位小数 + ms（与遥测行原来的模板串逐字一致） */
const latencyText = (value: number) => `${value.toFixed(1)} ms`;

/**
 * 运行时长：总秒数 →「X 分 Y 秒」。
 *
 * 一行里有两个数（分、秒），但它们同出一个总秒数，所以整行交给**一个**
 * `NumberAnimation`：动的是总秒数，分秒由这个格式化器现算，两个数字不会各滚各的。
 */
const uptimeText = (value: number) => `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒`;

/** 网卡流量：整数 B/s（与遥测行原来的 `Math.round` 逐字一致） */
const byteRateText = (value: number) => `${Math.round(value)} B/s`;

/**
 * 千分位的口径（PRD「数量使用千位分隔」）：
 *   · **计数**（几项 / 几帧 / 几份 / 几台）用组件默认的分组，`1,234`；
 *   · **测量值**（ms / 秒 / GiB / TB / %）一律 `group={false}` —— 它们不是「数量」，
 *     改造前也是裸数字，加逗号等于改了读数口径。
 * 走 `format` 的那些（本文件的 `latencyText` / `uptimeText` / `byteRateText` /
 * `readingValue` 等）自带 `toFixed` 或 `Math.round`，天然不分组，不必再写 `group`。
 */

/**
 * 数字动效铺开时踩到的既有选择器：`.metric span`、`.hw-notice span`。
 *
 * 它们按「容器 → 裸 `span`」写，本意是选中**标签文本**那一个 span；而
 * `NumberAnimation` 渲染出来的也是一个 `span`，会被一起命中 —— 指标块里的数字
 * 会变成块级、被压成辅助字号，说明条里的数字会被染成次要色。
 * CSS 不在本次改动范围内，所以在数字这一层用行内样式把继承关系恢复回去：
 * 屏幕上仍然只有数字在滚，排版与改造前逐像素相同。
 *
 * 若后续把这两条收紧为 `.metric > span`（`Metric` 的注释 span 本来就是直接子元素）
 * 与 `.hw-notice > span`，这个常量与各处显式传的 `style=` 即可删除。
 */
const NUMBER_INHERIT_STYLE: CSSProperties = { display: "inline", color: "inherit", fontSize: "inherit" };

/**
 * 本页数据源：真机优先、种子兜底。
 *
 * 只要终端推过数据就用终端的（哪怕已经 stale/offline —— 那时页面标「离线」
 * 并保留最后一份）。**没有上报时不退回演示数据**：读数按静态行模板全部显示
 * 「—」，布局与连接后完全一致。
 */
function useHardwareSource(link: DeviceLink) {
  const report: DeviceReport | null = link.view?.report ?? null;
  const live = Boolean(report);

  /**
   * 读数列表：**行数与顺序在连接前后完全一致**。
   *
   * 行模板是 `SCANNER_READING_LAYOUT`（静态清单），不是设备上报的字段 ——
   * 字段清单如果来自上报本身，未连接时只有 5 行、连上之后 15 行，布局会跳。
   * 未连接时每行都是 `undefined`，界面显示「—」；
   * 连接后按 key 填真值，设备多出来的字段追加在后面。
   */
  const readings = useMemo(() => {
    const fromDevice = report?.readings?.filter((item) => Number.isFinite(item.value)) ?? [];
    const deviceByKey = new Map(fromDevice.map((item) => [item.key, item]));
    const extra = fromDevice.filter((item) => !SCANNER_READING_LAYOUT.some((row) => row.key === item.key));
    return [...SCANNER_READING_LAYOUT, ...extra].map((item) => {
      const device = deviceByKey.get(item.key);
      return {
        item: device ? { ...item, ...device } : item,
        value: live && device ? device.value : undefined,
      };
    });
  }, [live, report]);

  const channels: ChannelStatus[] = useMemo(
    () => (report?.channels?.length ? report.channels : CHANNELS),
    [report],
  );

  const batches: ScanBatch[] = useMemo(
    () => (report?.batches?.length ? report.batches.map(toScanBatch) : SCAN_BATCHES),
    [report],
  );

  return { live, report, readings, channels, batches };
}

/* ------------------------------------------------------------------ *
 * 链路状态
 * ------------------------------------------------------------------ */

/**
 * 设备通道状态：一句话说清「现在这份数据是不是真的、新不新」。
 *
 * 返回的是 `node` 而不是拼好的字符串：三种在线状态里都带着「距今多少秒」，
 * 这个数每 2 秒轮询就变一次，得留在自己的文本节点上交 `NumberAnimation` 滚 ——
 * 先拼成字符串再传进 `StatusChip`，数字就没法逐帧改写了。
 * 除秒数以外的文案与改造前逐字相同。
 */
function linkChip(link: DeviceLink): { node: ReactNode; tone: Tone } {
  const age = link.view?.ageSec ?? 0;
  /*
    年龄是秒数（测量值），三处一律 `group={false}` —— 设备离线很久、
    年龄到 3600 秒时也不写成 `3,600s`（那不是「数量」，是时长）。
  */
  switch (link.phase) {
    case "live":
      return { node: <>真机接入 · 在线 <NumberAnimation value={age} group={false} />s</>, tone: "ok" };
    case "stale":
      return { node: <>设备延迟 <NumberAnimation value={age} group={false} />s</>, tone: "warn" };
    case "offline":
      return { node: <>设备离线 <NumberAnimation value={age} group={false} />s</>, tone: "danger" };
    case "waiting":
      return { node: "等待设备上报", tone: "muted" };
    case "unavailable":
      return { node: "设备通道不可达", tone: "danger" };
    default:
      return { node: "正在读取设备数据", tone: "info" };
  }
}

/* ------------------------------------------------------------------ *
 * 设备状态
 * ------------------------------------------------------------------ */

function DeviceStatusPanel({ link, deviceId }: { link: DeviceLink; deviceId: string }) {
  const { toast } = useMumai();
  const report = link.view?.report ?? null;
  const live = Boolean(report);
  const chip = linkChip(link);
  const [busy, setBusy] = useState(false);

  const ask = async (type: "query_status" | "request_upload", reason: string) => {
    setBusy(true);
    try {
      const result = await api.deviceCommand(deviceId, type, { reason });
      toast(result.hint, result.pushed ? "info" : "warn");
    } catch (error) {
      toast(error instanceof Error ? error.message : "命令下发失败", "warn");
    } finally {
      setBusy(false);
    }
  };

  const hardware = report?.hardware;
  const state = report?.state;
  const versions = report?.versions;
  const ack = link.view?.configAck ?? null;

  const facts = live
    ? [
        { k: "设备", v: hardware?.model || DEVICES.scanner.name },
        {
          k: "设备编号",
          v: (
            <>
              {report?.deviceId ?? deviceId}
              {hardware?.hostname ? <span className="muted"> · {hardware.hostname}</span> : null}
            </>
          ),
        },
        {
          k: "数据来源",
          v: (
            <>
              <SourceTag label="真机上报" />
              <span className="muted" style={{ marginLeft: 6 }}>
                {report?.note ?? "终端每 2 秒上报一份"}
              </span>
            </>
          ),
        },
        {
          k: "连接",
          v: (
            <>
              {/*
                连接状态平台自己算一份（按「最近一次上报距今多久」），终端也自报一份
                （它按 WS 与心跳算）。两份不一致时**两个都显示** —— 悄悄用一份盖掉另一份，
                现场就会争论「到底连没连上」。
              */}
              <StatusChip
                text={
                  <>
                    平台判定 {link.phase === "live" ? "在线" : link.phase === "stale" ? "延迟" : "离线"} ·{" "}
                    <NumberAnimation value={link.view?.ageSec ?? 0} group={false} />s 前上报
                  </>
                }
                tone={link.phase === "live" ? "ok" : link.phase === "stale" ? "warn" : "danger"}
                dot
              />
              {Number.isFinite(state?.latencyMs) ? (
                <span className="muted">
                  {" · 往返 "}
                  {/* 往返时延是测量值：1234ms 不写成 1,234ms */}
                  <NumberAnimation value={state?.latencyMs} group={false} />
                  {" ms"}
                </span>
              ) : null}
              {state?.connection && link.phase === "live" && state.connection !== "online" ? (
                <span className="muted"> · 终端自述「{state.connectionLabel ?? state.connection}」</span>
              ) : null}
              {state?.thermalThrottled ? (
                <>
                  {" "}
                  <StatusChip text="降频 / 欠压" tone="warn" dot />
                </>
              ) : null}
            </>
          ),
        },
        {
          k: "任务",
          v: (
            <>
              {state?.taskLabel ?? "—"}
              {link.view?.ledger?.pendingCommands ? (
                <span className="muted">
                  {" · 待执行命令 "}
                  <NumberAnimation value={link.view?.ledger?.pendingCommands} />
                </span>
              ) : null}
            </>
          ),
        },
        {
          k: "最近上报",
          v: (
            <>
              {clockOf(link.view?.receivedAt)}
              <span className="muted">
                {" · "}
                {/* 距最近一次上报的秒数：沿用原来的 `?? 0`，没有样本时仍然写 0，不改成「—」 */}
                <NumberAnimation value={link.view?.ageSec ?? 0} group={false} /> 秒前
              </span>
            </>
          ),
        },
      ]
    : [
        { k: "设备", v: DEVICES.scanner.name },
        { k: "设备编号", v: DEVICES.scanner.id },
        { k: "数据来源", v: <SourceTag label="模拟采集" /> },
        { k: "连接", v: <StatusChip text="已连接 · 只读监视" tone="ok" dot /> },
      ];

  /*
    配置版本有两个来源：设备数据里的 `versions.config`（注册握手后由平台下发的那一版）
    与终端遥测里的 `versions.configVersion`（终端"当前生效"的那一版）。
    前者为空时用后者兜底 —— 终端只在开机时注册一次，重启前这一段不该显示成「—」。
  */
  const telemetryVersions = (link.view?.telemetry?.versions ?? {}) as {
    configVersion?: string;
    appVersion?: string;
    adapterVersion?: string;
    demoModelVersion?: string;
  };

  const metrics: { label: string; value: string; note?: string }[] = live
    ? [
        {
          label: "固件版本",
          value: versions?.controller || "未接入",
          note: versions?.controller ? undefined : "控制器未接入",
        },
        {
          label: "采集配置",
          value: versions?.config || telemetryVersions.configVersion || "—",
          note: versions?.config ? undefined : "取自终端遥测",
        },
        { label: "运行模型", value: versions?.model || telemetryVersions.demoModelVersion || "—" },
        {
          label: "应用版本",
          value: versions?.app || telemetryVersions.appVersion || "—",
          note:
            versions?.adapter || telemetryVersions.adapterVersion
              ? `适配器 ${versions?.adapter || telemetryVersions.adapterVersion}`
              : undefined,
        },
      ]
    : [
        { label: "固件版本", value: versionOf("scanner-firmware") },
        { label: "采集配置", value: versionOf("scanner-config") },
        { label: "运行模型", value: versionOf("model") },
        { label: "推理流水线", value: versionOf("pipeline") },
      ];

  return (
    <Panel
      title="设备状态"
      extra={
        <StatusChip text={live ? chip.node : "未连接"} tone={live ? chip.tone : "muted"} dot />
      }
      className="hw-panel hw-col-6">
      <KV columns={2} items={facts} />
      <div className="hw-metrics">
        {metrics.map((item) => (
          <Metric key={item.label} label={item.label} value={item.value} note={item.note} />
        ))}
      </div>
      {live ? (
        <p className="note hw-device__meta">
          系统 {hardware?.kernel || "—"} · Python {hardware?.python || "—"} · {hardware?.cpuCount ?? "—"} 核
          {hardware?.isRaspberryPi === false ? "（非树莓派，终端跑在其它主机上）" : ""} · 启动标识{" "}
          {link.view?.ledger?.bootId ?? "—"}
          {ack ? ` · 现场调参 ${ack.configVersion}（${ack.state === "local-tuned" ? "本机生效" : ack.state}）` : ""}
        </p>
      ) : null}
      <div className="hw-actions">
        <Btn tone="ghost" disabled={busy || !live} onClick={() => ask("query_status", "平台请求状态快照")}>
          查询设备状态
        </Btn>
        <Btn tone="ghost" disabled={busy || !live} onClick={() => ask("request_upload", "平台请求上传当前批次")}>
          请求上传当前批次
        </Btn>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 设备读数
 * ------------------------------------------------------------------ */

function ReadingsPanel({ link }: { link: DeviceLink }) {
  const { live, readings } = useHardwareSource(link);

  return (
    <Panel
      title="设备读数"
      extra={<StatusChip text={live ? "在线" : "未连接"} tone={live ? "ok" : "muted"} dot />}
      className="hw-panel hw-col-3">
      {/*
        行数与连接状态无关：设备报什么就填什么，没报的与未连接的一律显示「—」。
        界面上不出现来源标签（实测 / 推算 / 估算）与采集口径说明 ——
        那些是内部实现口径，不属于操作界面。
      */}
      <ul className="hw-readings">
        {readings.map(({ item, value }) => {
          const known = typeof value === "number" && Number.isFinite(value);
          const state = known ? readingState(item, value) : { tone: "muted" as Tone, text: "无" };
          const filled =
            !known || item.scale === undefined
              ? null
              : Math.min(100, Math.max(0, (value / item.scale) * 100));
          return (
            <li key={item.key}>
              <span className="hw-readings__label">{item.label}</span>
              <b>
                {known ? (
                  <>
                    <NumberAnimation value={value} format={readingFormat(item)} />
                    <em>{item.unit}</em>
                  </>
                ) : (
                  <em>—</em>
                )}
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
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 通道状态
 * ------------------------------------------------------------------ */

function ChannelsPanel({ link }: { link: DeviceLink }) {
  const { live, channels } = useHardwareSource(link);
  return (
    <Panel
      title="通道状态"
      extra={
        <>
          <span className="muted">四路独立</span>
          {live ? <SourceTag label="真机上报" /> : null}
        </>
      }
      className="hw-panel hw-col-3">
      <DataTable
        head={["通道", "状态", "更新时间", "数据来源"]}
        rows={channels.map((channel) => [
          channel.label,
          <StatusChip
            key={channel.key}
            text={
              channel.state === "online" ? "正常" : channel.state === "stale" ? "延迟" : "断开"
            }
            tone={CHANNEL_TONE[channel.state] ?? "muted"}
            dot
          />,
          <>
            {channel.updatedAt}
            {" · "}
            {/* 更新时间是时刻（不动），后面的「距今几秒」是活数（动）；秒数是时长，不分组 */}
            <NumberAnimation value={channel.ageSec} group={false} />s
          </>,
          channel.source,
        ])}
      />
      
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 采集接收
 * ------------------------------------------------------------------ */

/**
 * 采集接收
 *
 * 按批次给整批完成度 + 逐路进度条。原来只有「386 / 420」这样的两列数字，
 * 操作员要自己心算这一批到底收全了没有；进度条把「还差多少」直接画出来，
 * 整批百分比也是从同一份 receive 现算的，没有第二个口径。
 */
function ReceivePanel({ link, deviceId }: { link: DeviceLink; deviceId: string }) {
  const { toast } = useMumai();
  const { live, batches, report } = useHardwareSource(link);

  const rows = useMemo(
    () =>
      batches.map((batch) => {
        const channels = (["radar", "image", "result"] as const).map((key) => ({
          key,
          label: key === "radar" ? "原始数据" : key === "image" ? "表面图像" : "结果文件",
          ...batch.receive[key],
        }));
        const received = channels.reduce((sum, item) => sum + item.received, 0);
        const expected = channels.reduce((sum, item) => sum + item.expected, 0);
        /*
          整批百分比：
            · 该批次本就不产生某一路时 `expected = 0` —— 按终端的 `state` 判定
              （一份都没收 = 未开始，而不是「0/0 已完成 100%」）；
            · 有预期数就按实收比例算。
        */
        const done = channels.every((item) => item.expected === 0 && item.state === "完成");
        const pct = expected === 0 ? (done ? 100 : 0) : Math.round((received / expected) * 100);
        return { batch, channels, received, expected, pct };
      }),
    [batches],
  );

  const rawById = new Map((report?.batches ?? []).map((item) => [item.batchId, item]));

  const requestResend = async (batchId: string) => {
    if (!live) {
      toast("已向扫描枪请求重传未接收分片", "info");
      return;
    }
    try {
      const result = await api.deviceCommand(deviceId, "request_upload", {
        batchId,
        reason: "平台发现该批次有未接收分片，请求补传",
      });
      toast(result.hint, result.pushed ? "info" : "warn");
    } catch (error) {
      toast(error instanceof Error ? error.message : "补传命令下发失败", "warn");
    }
  };

  return (
    <Panel
      title="采集接收"
      extra={
        <>
          {live ? <SourceTag label="真机上报" /> : null}
          <Btn tone="ghost" onClick={() => requestResend(rows[0]?.batch.batchId ?? "")}>
            补传
          </Btn>
        </>
      }
      className="hw-panel hw-col-6">
      <ul className="hw-batches">
        {rows.map(({ batch, channels, received, expected, pct }) => {
          const raw = rawById.get(batch.batchId);
          return (
            <li key={batch.batchId}>
              <header>
                <b>{batch.batchId}</b>
                <span className="muted">{batch.round}</span>
                {batch.frozen ? <b className="hw-frozen">批次已冻结</b> : null}
                <em>
                  {/* 实收 / 应收与整批百分比同出一份 receive，三个数一起滚 */}
                  <NumberAnimation value={received} /> / <NumberAnimation value={expected} />
                  <strong>
                    {/* 百分比也是测量值（0–100），不分组 */}
                    <NumberAnimation value={pct} suffix="%" group={false} />
                  </strong>
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
                      {/* 逐路实收 / 应收：进度条宽度是几何值（CSS 管），这里只动数字 */}
                      <NumberAnimation value={item.received} /> / <NumberAnimation value={item.expected} />
                    </em>
                    <StatusChip text={item.state} tone={RECEIVE_TONE[item.state] ?? "muted"} dot />
                  </li>
                ))}
              </ul>
              {live ? (
                <p className="note">
                  构件 {batch.componentId} · 测区 {batch.zoneId} · 配置 {batch.configVersion} · 模型{" "}
                  {batch.modelVersion}
                  {raw?.frameCount !== undefined ? (
                    <>
                      {" · 帧数 "}
                      {/* 帧数随批次上报变；构件 / 测区 / 版本号 / 摘要都是标识，不动 */}
                      <NumberAnimation value={raw.frameCount} />
                    </>
                  ) : null}
                  {raw?.datasetHash ? ` · 数据集摘要 ${raw.datasetHash.slice(0, 12)}…` : ""}
                  {raw?.state ? ` · 批次状态 ${BATCH_STATE_LABEL[raw.state] ?? raw.state}` : ""}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 设备能力 · 遥测 · 事件 · 预览（终端能给的、平台原来没有的那几块）
 * ------------------------------------------------------------------ */

/**
 * 终端遥测
 *
 * 终端每 1 秒推一条遥测，但**各项的采集周期不同**（CPU 1 秒、内存与温度 2 秒、
 * 磁盘 10 秒），所以一份里可能只有其中几项 —— 这里按「这一份里有什么就显示什么」
 * 渲染，缺的项不补 0（补了就成了编数据）。
 */
function TelemetryPanel({ link }: { link: DeviceLink }) {
  const telemetry = link.view?.telemetry ?? null;
  const num = (key: string): number | null => {
    const value = telemetry?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  /**
   * 一行遥测。
   *
   * `value` 收节点而不是拼好的字符串：这一块的每个数都跟着 1 秒一条的遥测变，
   * 得留在自己的文本节点上交 `NumberAnimation` 滚。`null` 仍然表示「这一份里
   * 没有这一项」—— 整行不出现，缺项不补 0。
   * 单位是数字后面的**纯文本**，所以走 `format` / `suffix`，不用 `Metric` 的
   * `unit`（那个会另起一个 `em`，字号与颜色都不同，等于改了排版）。
   */
  const items: { label: string; value: ReactNode }[] = [];
  const push = (label: string, value: ReactNode) => {
    if (value === null) return;
    items.push({ label, value });
  };
  /**
   * 指标块里的一行数字。`sample === null`（这一份遥测里没有这一项）时返回 `null`，
   * 上面的 `push` 会整行略过 —— 缺项不补 0。
   * `group={false}`：用 `digits`/`suffix` 的四行（CPU / 内存 / 温度 / 数据目录）
   * 都是测量值而不是「数量」，不补千分位；走 `format` 的行本来就不分组。
   * `style` 的理由见 `NUMBER_INHERIT_STYLE`：`.metric span` 会命中裸 span。
   */
  const metricNumber = (
    sample: number | null,
    props: { format?: (value: number) => string; digits?: number; suffix?: string },
  ) => (
    sample === null ? null : (
      <NumberAnimation value={sample} group={false} style={NUMBER_INHERIT_STYLE} {...props} />
    )
  );
  if (telemetry) {
    push("平台延迟", metricNumber(num("platformLatencyMs"), { format: latencyText }));
    push("运行时长", metricNumber(num("uptimeSeconds"), { format: uptimeText }));
    push("CPU 利用率", metricNumber(num("cpuPercent"), { digits: 1, suffix: "%" }));
    push("内存占用", metricNumber(num("memoryPercent"), { digits: 1, suffix: "%" }));
    push("机身温度", metricNumber(num("socTempC"), { digits: 1, suffix: "℃" }));
    push("数据目录", metricNumber(num("diskPercent"), { digits: 1, suffix: "%" }));
    push("接口发送", metricNumber(num("netTxBps"), { format: byteRateText }));
    push("接口接收", metricNumber(num("netRxBps"), { format: byteRateText }));
    const upload = telemetry.upload as { queued?: number; lastError?: string | null } | undefined;
    if (upload) {
      push(
        "上传队列",
        <>
          {/* 沿用原来的 `?? 0`：队列深度缺省就是 0 项，这里不改成「—」 */}
          <NumberAnimation value={upload.queued ?? 0} style={NUMBER_INHERIT_STYLE} /> 项
          {upload.lastError ? ` · 最近错误 ${upload.lastError}` : ""}
        </>,
      );
    }
    const versions = telemetry.versions as { configVersion?: string; demoModelVersion?: string } | undefined;
    if (versions?.configVersion) push("生效配置", versions.configVersion);
    if (versions?.demoModelVersion) push("演示模型", versions.demoModelVersion);
  }
  return (
    <Panel
      title="终端遥测"
      extra={
        telemetry ? (
          <StatusChip
            text={<><NumberAnimation value={telemetry.ageSec ?? 0} group={false} /> 秒前</>}
            tone={(telemetry.ageSec ?? 99) <= 5 ? "ok" : "warn"}
            dot
          />
        ) : (
          <span className="muted">未上报</span>
        )
      }
      className="hw-panel hw-col-3">
      {telemetry && items.length ? (
        <>
          <div className="hw-metrics">
            {items.map((item) => (
              <Metric key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
          
        </>
      ) : (
        <StateBlock kind="empty" title="暂无遥测" hint="终端每 1 秒推一条系统遥测，平台只保留最新一份。" />
      )}
    </Panel>
  );
}

/**
 * 设备预览
 *
 * 终端以 1—2 fps 推 640px 宽的 JPEG，用于现场监看。它不是归档图像，
 * 平台不把它当「完整原始图像」入库 —— 这一点写在面板说明里。
 */
function PreviewPanel({ link, deviceId }: { link: DeviceLink; deviceId: string }) {
  const enabled = Boolean(link.view?.report) && link.phase !== "offline" && link.phase !== "unavailable";
  const preview = useDevicePreview(deviceId, enabled);
  return (
    <Panel
      title="设备预览"
      extra={
        <StatusChip
          text={preview.url ? "低帧率监看" : "等待推流"}
          tone={preview.url ? "ok" : "muted"}
          dot
        />
      }
      className="hw-panel hw-col-3">
      {preview.url ? (
        <>
          <img className="hw-preview" src={preview.url} alt="手持终端低帧率预览画面" />
          
        </>
      ) : (
        <StateBlock
          kind="empty"
          title="等待设备推流"
          hint={preview.error || "终端开启预览上传后，这里显示它本机的低帧率画面。"}
        />
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 硬件监看
 * ------------------------------------------------------------------ */

/**
 * 面板的排版位置：`[行, 列]`。
 *
 * 配对原则：同排两块的自然高度尽量接近，等高拉伸后的留白最小。
 * （自然高度实测，单位 px：设备读数 613 · 采集接收 422 · 设备状态 374 ·
 *   设备预览 330 · 通道状态 246 · 终端遥测 147）
 *
 *   第 1 排  设备状态(374) · 通道状态(246)   → 拉到 374，留白 246
 *   第 2 排  采集接收(422) · 设备预览(330)   → 拉到 422，留白 330
 *   第 3 排  设备读数(613) · 终端遥测(147)   → 拉到 613（最矮的一块无论和谁
 *            配对都会被拉，放最后不挤占上面的行）
 *
 * 面板自然高度随后端数据变（通道与接收的行数不是固定的），所以这里是配对顺序，
 * 不是硬编码高度；同排两块一律等高对齐。
 */
const MONITOR_LAYOUT: Record<string, [number, number]> = {
  status: [1, 1],
  channels: [1, 2],
  receive: [2, 1],
  preview: [2, 2],
  readings: [3, 1],
  telemetry: [3, 2],
};

/** 把排版位置写成 CSS 变量，CSS 侧用 grid-row / grid-column 读取 */
const place = (key: keyof typeof MONITOR_LAYOUT) => {
  const [row, col] = MONITOR_LAYOUT[key];
  return { style: { "--hw-row": row, "--hw-col": col } as CSSProperties };
};

function MonitorTab({ link, deviceId }: { link: DeviceLink; deviceId: string }) {
  return (
    <div className="hw-monitor">
      <div {...place("status")}>
        <DeviceStatusPanel link={link} deviceId={deviceId} />
      </div>
      <div {...place("readings")}>
        <ReadingsPanel link={link} />
      </div>
      <div {...place("channels")}>
        <ChannelsPanel link={link} />
      </div>
      <div {...place("receive")}>
        <ReceivePanel link={link} deviceId={deviceId} />
      </div>
      <div {...place("telemetry")}>
        <TelemetryPanel link={link} />
      </div>
      <div {...place("preview")}>
        <PreviewPanel link={link} deviceId={deviceId} />
      </div>
    </div>
  );
}

export default function Hardware() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? TABS[0].key;
  const batch = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";
  const deviceId = params.get("device") ?? HANDHELD_DEVICE_ID;

  // 设备链路在这一层取：工具栏的来源标识与「硬件监看」用的是同一份状态
  const link = useDeviceLink(deviceId);

  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    // PRD 2.2：切换页签保留筛选条件与当前批次
    next.set("batch", batch);
    setParams(next, { replace: true });
  };

  const frozen = SCAN_BATCHES.find((item) => item.batchId === batch)?.frozen ?? false;
  const live = Boolean(link.view?.report);
  const chip = linkChip(link);

  return (
    <div className="page page--adapt">
      <Toolbar
        note={
          <>
            {/*
              来源标识**按页签**给：只有「硬件监看」这一屏的数据真的接了设备；
              采集作业与异常排查仍是演示工作台（它们的批次、波形来自种子），
              挂着「真机接入」会让人以为整页都是设备数据。
            */}
            <SourceTag
              label={
                tab === "monitor"
                  ? live
                    ? "真机接入"
                    : "演示回放"
                  : tab === "capture"
                    ? "采集工作台"
                    : "演示回放"
              }
            />
            <span>当前批次 {batch}</span>
            <span>
              {tab === "capture" ? (
                "扫描枪实时接入"
              ) : tab === "monitor" ? (
                <>
                  {/* 设备号是标识（不动），后面的链路状态里带活的秒数（动） */}
                  {deviceId} · {chip.node}
                </>
              ) : (
                "只读"
              )}
            </span>
          </>
        }>
        {TABS.map((item) => (
          <Btn key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
            <Icon name={item.icon} size={16} aria-hidden />
            {item.label}
          </Btn>
        ))}
      </Toolbar>

      {frozen && tab !== "capture" ? (
        <StateBlock
          kind="partial"
          title="该批次已冻结诊断输出"
          hint="缺少该批次木材的有效标定记录，暂不输出病害结论，等待专业复核。"
        />
      ) : null}

      {frozen && tab === "capture" ? <div className="capture-freeze-note"><b>诊断输出已冻结</b><span>该批次缺少有效标定记录，等待专业复核；仍可监看采集画面和传感器数据。</span></div> : null}
      {/*
        异常排查页要求「两列等高、整页不滚动」（所以列表在面板内部滚），
        所以这一档把 .adapt-body 自己的滚动关掉。其余页签内容较长、
        仍然需要整页滚，保持原样。
      */}
      <div className={`adapt-body${tab === "triage" ? " adapt-body--fixed" : ""}`}>
        {tab === "capture" ? <CaptureTab /> : null}
        {tab === "triage" ? <TriageTab /> : null}
        {tab === "monitor" ? (
          <MonitorTab link={link} deviceId={deviceId} />
        ) : null}
      </div>
    </div>
  );
}
