/**
 * 手持终端（树莓派 Pi 5 · woodpulse）设备数据的类型
 *
 * 这些字段**不是平台自己定的**，是终端 `device_report.build_report()` 的形状，
 * 契约见终端侧两份文档：
 *   · `手持扫描仪/docs/设备数据接口说明.md` —— 硬件页四块（设备状态 / 读数 / 通道 / 批次）
 *   · `手持扫描仪/docs/平台接入实施说明.md` —— 注册、心跳、事件、命令
 *
 * 两条口径在这里落成类型，页面照着写就不会走偏：
 *   1. `readings[].source` 必须原样显示（实测 / 推算 / 估算）——终端分了这三档，
 *      页面不能一律当实测值；
 *   2. 终端不发的字段就是**没有**（比如没有电量计就没有 `battery`），
 *      类型里一律可选，页面不做默认值填充。
 */

import type { ChannelStatus, DeviceReading, ScanBatch } from "../seed/types";

/** 读数来源：实测 / 由实测推算 / 本机没有该采集接口时的动态估算 */
export type ReadingSource = "real" | "derived" | "estimated";

/**
 * 手持终端的设备号。
 *
 * 与终端 `/var/lib/woodpulse/config.json` 的 `platform.device_id` 一致，
 * 也是设备台账里的主键 —— 页面与顶栏都用这一个常量，不在各处写死字符串。
 */
export const HANDHELD_DEVICE_ID = "handheld-02";

export const READING_SOURCE_LABEL: Record<ReadingSource, string> = {
  real: "实测",
  derived: "推算",
  estimated: "估算",
};

export type ReceiveChannel = { received: number; expected: number; state: "完成" | "部分接收" | "未开始" };

/** 终端上报的批次（平台 `ScanBatch` 的字段 + 终端独有字段） */
export type DeviceReportBatch = {
  batchId: string;
  componentId?: string;
  zoneId?: string;
  round?: string;
  configVersion?: string;
  modelVersion?: string;
  state?: string;
  /** 两端各自算过的数据集摘要，平台据此确认「收到的就是终端封存的那一份」 */
  datasetHash?: string;
  startedAt?: string;
  frameCount?: number;
  receive?: Partial<Record<"radar" | "image" | "result", ReceiveChannel>>;
};

export type DeviceHardware = {
  model?: string;
  hostname?: string;
  kernel?: string;
  python?: string;
  cpuCount?: number;
  isRaspberryPi?: boolean;
};

export type DeviceVersions = {
  app?: string;
  adapter?: string;
  /** 当前生效的环境配置版本 */
  config?: string;
  /** 演示模型版本 */
  model?: string;
  /** 实际控制器（ESP32）固件版本；未接入时为 null —— 不能拿演示模型顶替 */
  controller?: string | null;
};

export type DeviceState = {
  task?: string;
  taskLabel?: string;
  connection?: string;
  connectionLabel?: string;
  latencyMs?: number;
  thermalThrottled?: boolean;
  estimatedCount?: number;
  derivedCount?: number;
};

export type DeviceReport = {
  schemaVersion?: string;
  deviceId?: string;
  bootId?: string;
  generatedAt?: string;
  /** 界面直接显示的本地采样时刻 */
  sampledAt?: string;
  sourceMode?: string;
  hardware?: DeviceHardware;
  versions?: DeviceVersions;
  state?: DeviceState;
  readings?: DeviceReading[];
  channels?: ChannelStatus[];
  batches?: DeviceReportBatch[];
  /** 能力声明：camera / radar / imu / battery / telemetry / gpu / preview */
  capabilities?: Record<string, string>;
  note?: string;
};

export type DeviceLinkState = {
  state: "online" | "stale" | "offline" | "unknown";
  ageSec: number | null;
  lastSeenAt: string | null;
  socketConnected: boolean;
};

export type DeviceTelemetry = {
  receivedAt: string;
  ageSec: number | null;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  socTempC?: number | null;
  netTxBps?: number | null;
  netRxBps?: number | null;
  diskPercent?: number | null;
  [key: string]: unknown;
};

export type DeviceEvent = {
  messageId: string;
  type: string;
  seq: number | null;
  sentAt: string | null;
  receivedAt: string;
  ageSec: number | null;
  payload: Record<string, unknown>;
};

export type DeviceCommand = {
  commandId: string;
  action: string;
  state: "queued" | "sent" | "accepted" | "executed" | "failed";
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  executedAt: string | null;
  failedAt: string | null;
  reason: string | null;
  errorCode: string | null;
  result: Record<string, unknown>;
  scope: string | null;
};

export type DeviceConfigAck = {
  configVersion: string;
  /** applied = 平台下发后操作者确认；local-tuned = 现场本机调参 */
  state: string;
  appliedAt: string | null;
  receivedAt: string;
  diff: [string, string, string][];
};

export type DeviceLedgerEntry = {
  deviceId: string;
  bootId: string | null;
  connectionState: string | null;
  link: DeviceLinkState;
  registeredAt: string | null;
  lastSeenAt: string | null;
  appVersion: string | null;
  adapterVersion: string | null;
  modelVersion: string | null;
  host: Record<string, unknown>;
  capabilities: Record<string, string>;
  hardware: DeviceHardware | null;
  state: DeviceState | null;
  sampledAt: string | null;
  receivedAt: string | null;
  pendingCommands: number;
  previewFrames: number;
};

/** `GET /api/devices/{id}/hardware` 的完整返回 */
export type DeviceHardwareView = {
  ok: boolean;
  deviceId: string;
  /** 平台收到最后一份上报的时刻；`report` 为 null 表示设备从没上报过 */
  receivedAt: string | null;
  report: DeviceReport | null;
  stale: boolean;
  ageSec: number | null;
  link: DeviceLinkState;
  ledger: DeviceLedgerEntry | null;
  telemetry: DeviceTelemetry | null;
  lastEvent: DeviceEvent | null;
  configAck: DeviceConfigAck | null;
  recentCommands: DeviceCommand[];
  serverTime: string;
};

/* ------------------------------------------------------------------ *
 * 能力声明
 * ------------------------------------------------------------------ */

export const CAPABILITY_LABEL: Record<string, string> = {
  camera: "相机",
  radar: "毫米波响应序列",
  imu: "IMU 姿态",
  battery: "电量计",
  telemetry: "系统遥测",
  gpu: "GPU",
  preview: "低帧率预览",
};

/** 能力取值的口径说明：这台设备的边界要写在页面上，不是让人猜 */
export const CAPABILITY_NOTE: Record<string, string> = {
  "radar:replay": "响应序列来自预制样例包，不是真实毫米波回波",
  "imu:unavailable": "本机未配置 IMU，不提供枪体姿态与轨迹",
  "battery:unavailable": "本机没有电量计，不提供电量与续航",
  "gpu:unavailable": "Pi 5 无该采集节点",
  "camera:live": "相机实采",
  "telemetry:live": "psutil / procfs / sysfs 实测",
  "preview:live": "低帧率监看画面，不是归档图像",
};

export const CAPABILITY_VALUE_LABEL: Record<string, string> = {
  live: "实采",
  replay: "回放（样例包）",
  unavailable: "未接入",
};

/* ------------------------------------------------------------------ *
 * 与平台既有结构的换算
 * ------------------------------------------------------------------ */

/**
 * 终端批次 → 平台的 `ScanBatch`。
 *
 * 平台的 `ScanBatch` 是给演示种子设计的（带 `rawLevel` / `frozen` / `sourceMode`），
 * 终端的批次没有这几项，用中性值补齐而不是编造：
 *   · `frozen = false` —— 冻结是平台侧的动作，终端不管；
 *   · `rawLevel = "opaque"` —— 终端不声明原始级别时按「未声明」处理；
 *   · `sourceMode = "live"` —— 这份数据确实来自设备。
 */
export function toScanBatch(batch: DeviceReportBatch): ScanBatch {
  const empty: ReceiveChannel = { received: 0, expected: 0, state: "未开始" };
  return {
    batchId: batch.batchId,
    componentId: batch.componentId ?? "—",
    zoneId: batch.zoneId ?? "—",
    round: roundLabel(batch.round),
    configVersion: batch.configVersion ?? "—",
    modelVersion: batch.modelVersion ?? "—",
    rawLevel: "opaque",
    startedAt: batch.startedAt ?? "—",
    receive: {
      radar: batch.receive?.radar ?? empty,
      image: batch.receive?.image ?? empty,
      result: batch.receive?.result ?? empty,
    },
    frozen: false,
    freezeReason: null,
    sourceMode: "live",
  };
}

/**
 * 轮次口径：平台的种子用中文（初扫 / 复扫 / 补扫），终端用英文枚举
 * （`initial` / `rescan` / `reference`）。两边都要能显示，所以在这里对齐 —
 * 页面上不会出现「initial」这种只有开发看得懂的词。
 */
export function roundLabel(round?: string): ScanBatch["round"] {
  switch (String(round ?? "")) {
    case "rescan":
      return "复扫";
    case "reference":
      return "参考";
    case "补扫":
      return "补扫";
    case "初扫":
      return "初扫";
    case "复扫":
      return "复扫";
    default:
      return "初扫";
  }
}

/** 批次状态：终端给的是英文枚举，页面上写中文 */
export const BATCH_STATE_LABEL: Record<string, string> = {
  sealed: "已封存",
  open: "采集中",
  collecting: "采集中",
  uploading: "上传中",
  delivered: "已交付",
  interrupted: "已中断",
};
