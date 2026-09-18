/**
 * 数据接收页的数据装配（纯逻辑，Node 单测可覆盖）
 *
 * ── 这一页为什么存在（贴合剧本）────────────────────────────────────
 *   · 剧本第三句（讲解人）：「到达现场后我会分别检查**小车数据通道、手持设备通道和
 *     场景文件网络通道**。三类数据使用同一工单编号，采集时间各自独立记录」；
 *   · ⑦ 小木：「我按设备编号核对数据来源，确认平台显示的是本次设备数据，不串数据。
 *     发现异常立即叫停」；
 *   · ⑯ 小木：「我正在按样本编号核对文件和路径记录。缺失项会保留在补采清单中，
 *     已接收文件不会重复要求上传」；
 *   · 史的口播：「手持数据已进入接收页」。
 * 四句都落在这一页上：三路通道 → 本单接收清单 → 按样本编号核对（路径记录 + 补采清单）。
 *
 * ── 数字都从哪儿来 ──────────────────────────────────────────────────
 *   · 接收清单 `DATA_PACKAGES`（含每个文件各自的 `capturedAt` 与校验结论）；
 *   · 路径记录 `SAMPLES`（物理样本编号 + 路径 + 质量判定，就是 ⑯ 要核的那份东西）；
 *   · 通道现状由**服务端自检**（`/api/device-readiness`，与「设备接入」页同一份数据）
 *     现取 —— 探针没数据时通道状态如实写「未接通」，绝不写"在线"凑数。
 */

import type { DataPackage, Sample } from "../seed/types";
import { DATA_PACKAGES, REFERENCE_BATCHES, SAMPLES } from "../seed/scenario";

/** 三类通道（剧本点名的三个） */
export const RECEIVE_CHANNELS = ["cart", "handheld", "scene"] as const;
export type ReceiveChannelKey = (typeof RECEIVE_CHANNELS)[number];

/**
 * `/api/device-readiness` 的最小形状（字段与「设备接入」页读的是同一个接口）。
 * ⚠ 只取这一页要用的三个 section：`cart`（小车两路 MJPEG）、`device`（手持终端逐帧预览）、
 *   `screen`（树莓派桌面，可选）。场景文件通道**不来自探针** —— 它走平台的
 *   `/api/files` 上传通道，页面据实说"平台内网文件通道"。
 */
export type ReadinessLike = {
  sections: {
    key: string;
    title: string;
    items: { level: "ok" | "fail" | "warn"; title: string; detail?: string }[];
  }[];
  counts: { ok: number; fail: number; warn: number };
} | null;

export type ChannelState = "ok" | "warn" | "fail" | "unknown" | "checking";

export type ReceiveChannel = {
  key: ReceiveChannelKey;
  label: string;
  /** 通道形态（按代码里真实的通道写，不按设备说明书的美好说法写） */
  form: string;
  /** 来源设备/终端 */
  origin: string;
  state: ChannelState;
  /** 一句话现状（探针给的原话，或"未接通"） */
  detail: string;
};

const CHANNEL_META: Record<ReceiveChannelKey, { label: string; form: string; origin: string; section: string | null }> = {
  cart: {
    label: "小车数据通道",
    form: "两路 MJPEG 视频流（RViz 画面 / 摄像头）+ 状态通道",
    origin: "智能巡检车",
    section: "cart",
  },
  handheld: {
    label: "手持设备通道",
    form: "逐帧 JPEG 预览 + 原始数据包内网提交",
    origin: "手持毫米波扫描仪 / 树莓派终端",
    section: "device",
  },
  scene: {
    label: "场景文件网络通道",
    form: "平台内网文件通道（上传与下载走同一入口）",
    origin: "全栈开发工作站",
    /* 场景文件不走设备探针：平台本身在跑，这条通道就是通的；认证/权限另算 */
    section: null,
  },
};

/** 探针里某一节的最差一级（与「设备接入」页同一判据：fail > warn > ok） */
function worstLevel(items: { level: "ok" | "fail" | "warn" }[]): ChannelState {
  if (items.length === 0) return "unknown";
  if (items.some((item) => item.level === "fail")) return "fail";
  if (items.some((item) => item.level === "warn")) return "warn";
  return "ok";
}

/**
 * 三路通道现状。
 *
 * `readiness === null`（服务端自检没拿到）时**三路都写「未接通」**并给出原因，
 * 而不是按"平台在跑"推断成在线 —— 现场靠这一栏判断该去查哪一头，猜不得。
 *
 * `checking === true` 表示自检请求还在路上（服务端要逐路探设备，实测约 3 秒）。
 * 这时的状态是「正在自检」，**既不说通也不说断** —— 与"没有结论"分开写，
 * 免得演示时刚跳过来看到「无自检结论」就以为设备坏了。
 */
export function channelsOf(readiness: ReadinessLike, options: { checking?: boolean } = {}): ReceiveChannel[] {
  const checking = Boolean(options.checking && !readiness);
  return RECEIVE_CHANNELS.map((key) => {
    const meta = CHANNEL_META[key];
    if (checking) {
      return {
        key,
        label: meta.label,
        form: meta.form,
        origin: meta.origin,
        state: "checking" as const,
        detail: "平台正在逐路自检（实测约 3 秒），结论出来前不按推断写在线",
      };
    }
    if (!meta.section) {
      return {
        key,
        label: meta.label,
        form: meta.form,
        origin: meta.origin,
        state: readiness ? "ok" : "unknown",
        detail: readiness
          ? "平台内网文件通道在服务中：上传与下载走同一入口，取件凭令牌"
          : "未读到平台自检结论；文件通道是否可用以「设备接入」页的自检为准",
      };
    }
    const section = readiness?.sections.find((item) => item.key === meta.section);
    if (!section || section.items.length === 0) {
      return {
        key,
        label: meta.label,
        form: meta.form,
        origin: meta.origin,
        state: "unknown",
        detail: "未读到该通道的自检结论（设备未注册或服务未上报）",
      };
    }
    const bad = section.items.filter((item) => item.level !== "ok");
    return {
      key,
      label: meta.label,
      form: meta.form,
      origin: meta.origin,
      state: worstLevel(section.items),
      detail: bad.length
        ? bad.map((item) => `${item.title}${item.detail ? ` — ${item.detail}` : ""}`).join("；")
        : `${section.items.length} 项自检全部通过`,
    };
  });
}

/** 接收清单的一行（一个文件一条，**采集时间各自独立记录**） */
export type ReceiveRow = {
  id: string;
  name: string;
  kind: string;
  source: string;
  /** 关联批次；未关联批次（外部导入）为 null —— 页面照实写「未关联批次」 */
  batchId: string | null;
  componentId: string | null;
  /** 该文件自己的采集时刻（剧本：采集时间各自独立记录） */
  capturedAt: string;
  frames: number | null;
  sizeText: string;
  /** 与 `DataPackage.state` 同源：已入库 / 待审核 / 已驳回 */
  state: DataPackage["state"];
  checksPassed: number;
  checksTotal: number;
  /** 校验没过的条目（原话照抄，页面直接显示） */
  issues: string[];
};

export function receiveRows(packages: readonly DataPackage[] = DATA_PACKAGES): ReceiveRow[] {
  return packages.map((item) => {
    const failed = item.checks.filter((check) => !check.pass);
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      source: item.source,
      batchId: item.batchId,
      componentId: item.componentId ?? null,
      capturedAt: item.capturedAt,
      frames: typeof item.frames === "number" ? item.frames : null,
      sizeText: item.sizeText,
      state: item.state,
      checksPassed: item.checks.length - failed.length,
      checksTotal: item.checks.length,
      issues: failed.map((check) => `${check.label}：${check.detail}`),
    };
  });
}

/** 清点：已入库 / 待审核 / 已驳回，以及校验没过的条目总数 */
export function receiveTally(rows: readonly ReceiveRow[]): {
  total: number;
  stored: number;
  toReview: number;
  rejected: number;
  issueCount: number;
} {
  return {
    total: rows.length,
    stored: rows.filter((row) => row.state === "已入库").length,
    toReview: rows.filter((row) => row.state === "待审核").length,
    rejected: rows.filter((row) => row.state === "已驳回").length,
    issueCount: rows.reduce((sum, row) => sum + row.issues.length, 0),
  };
}

/** 按批次归拢（页面一个批次一块，批次内文件各自的采集时间排开） */
export function rowsByBatch(rows: readonly ReceiveRow[]): { batchId: string; label: string; rows: ReceiveRow[] }[] {
  const groups: { batchId: string; label: string; rows: ReceiveRow[] }[] = [];
  for (const row of rows) {
    const key = row.batchId ?? "（未关联批次）";
    let group = groups.find((item) => item.batchId === key);
    if (!group) {
      group = { batchId: key, label: key, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** 按样本编号核对的结果（⑯ 那句「按样本编号核对文件和路径记录」） */
export type SampleCheck = {
  physicalSampleId: string;
  records: number;
  /** 路径前缀（同一物理样本应当落在同一目录下） */
  folders: string[];
  usable: number;
  toReview: number;
  unusable: number;
  /** 需要补采/重看的条目（只列非「可用」的，附原话原因） */
  followUps: { recordId: string; path: string; reason: string }[];
  sourceBatch: string;
};

export function sampleChecks(samples: readonly Sample[] = SAMPLES): SampleCheck[] {
  const out: SampleCheck[] = [];
  for (const sample of samples) {
    let group = out.find((item) => item.physicalSampleId === sample.physicalSampleId);
    if (!group) {
      group = {
        physicalSampleId: sample.physicalSampleId,
        records: 0,
        folders: [],
        usable: 0,
        toReview: 0,
        unusable: 0,
        followUps: [],
        sourceBatch: sample.sourceBatch,
      };
      out.push(group);
    }
    group.records += 1;
    const folder = sample.path.includes("/") ? sample.path.slice(0, sample.path.lastIndexOf("/")) : "（根目录）";
    if (!group.folders.includes(folder)) group.folders.push(folder);
    if (sample.quality === "可用") group.usable += 1;
    else if (sample.quality === "待审核") group.toReview += 1;
    else group.unusable += 1;
    if (sample.quality !== "可用") {
      group.followUps.push({ recordId: sample.recordId, path: sample.path, reason: sample.qualityReason });
    }
  }
  return out;
}

/** 三份数据的口径声明（剧本原话 + 页面上必须写清的两条边界） */
export function receiveNotes(): string[] {
  return [
    "三类数据使用同一工单编号，采集时间各自独立记录。",
    "缺失项只保留在补采清单里：已接收的文件不会重复要求上传。",
    "通道现状取自平台自检（与「设备接入」页同一份结论）；探针没数据时如实写「未接通」，不按推断写在线。",
  ];
}

/** 参考样本批次（页面底部一张小表：分组 / 材种来源 / 扫描次数 / 方向） */
export function referenceRows(): string[][] {
  return REFERENCE_BATCHES.map((item) => [item.batchId, item.groupId, item.material, String(item.scans), item.direction]);
}
