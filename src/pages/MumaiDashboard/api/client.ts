/**
 * 木脉智检 · 共享服务客户端
 *
 * 全部走同源相对路径（`/api`、`/ws`）：开发期由 Vite 代理，内网演示期由
 * 共享服务自己托管构建产物 —— 两种部署下前端代码完全一样，不需要构建期注入地址。
 *
 * 三条约定：
 *   1. **每个写操作带 commandId**：网络抖动重发同一 commandId，服务端回放结果，
 *      不会把一次点击变成两次状态迁移（PRD §7）。
 *   2. **不吞错误**：把服务端的 `{code, message, fieldErrors}` 原样抛给调用方，
 *      页面据此在字段旁显示原因。绝不把失败渲染成成功。
 *   3. **事件按 seq 消费**：重连带 lastSeq，缺口由服务端补发；收到重复 seq 直接忽略。
 */

import { readSession } from "../auth";
import type { DeviceEvent, DeviceHardwareView, DeviceLedgerEntry, DeviceLinkState } from "../device/types";

/* ------------------------------------------------------------------ *
 * 类型（与服务端 contracts 对应）
 * ------------------------------------------------------------------ */

export type ApiError = {
  status: number;
  code: string;
  message: string;
  fieldErrors: { field: string; message: string }[];
  retryable: boolean;
  [key: string]: unknown;
};

export type Actor = { id: string; login: string; name: string };

export type SharedEntity<T = Record<string, unknown>> = {
  id: string;
  revision: number;
  updatedAt: string;
  data: T;
};

export type Snapshot = {
  session: {
    id: string;
    scenarioId: string;
    stage: string;
    status: string;
    lastSeq: number;
    createdAt: string;
    updatedAt: string;
  };
  entities: Record<string, SharedEntity[]>;
  projection: { holderId: string | null; viewType: string; focusIds: string[]; updatedAt: string | null };
  serverTime: string;
};

export type StreamEvent = {
  seq: number;
  type: string;
  entityKind: string | null;
  entityId: string | null;
  revision: number | null;
  actorId: string | null;
  payload: Record<string, unknown>;
  at: string;
};

export type CommandResult = {
  replayed: boolean;
  action: string;
  result: Record<string, unknown>;
  entityKind: string;
  entity: SharedEntity;
  eventSeq: number;
};

/* ---- 各实体的业务字段（与服务端 workflow.mjs 写入的结构一致） ---- */

export type EnvironmentEntity = {
  version: string;
  inputs: Record<string, unknown>;
  checks: { key: string; label: string; ok: boolean; field: string; message: string }[];
  emcPct: number | null;
  methodVersion: string;
  state: "draft" | "validated" | "published" | "received" | "verified";
  publishedBy: string | null;
  publishedAt: string | null;
  ackBy: string | null;
  ackAt: string | null;
};

/**
 * 平台侧任务（服务端 `mission` 实体）。
 *
 * 两种来源：
 *   · `kind: "cruise"` —— **工单页下发的自主巡航任务**（用户 2026-09-18 口径：
 *     「在工单界面添加下发自主巡航任务功能……shi 派发，ma 接受去建图巡航」）；
 *     任务编号 `CR-<工单号里的日期段>-<两位流水>`，与工单对得上；
 *   · `kind: "general"` —— 不带工单的通用任务（旧调用，字段少，页面只显示状态）。
 *
 * ⚠ 与小车自己的任务不是一回事：小车状态里的 `mission`（`CartMission`，见 cart/api.ts）
 * 是车端在执行的那条；这里是**平台侧的任务单据**（谁派发、谁接受、带哪些构件）。
 * 两者在界面上要分开说，不能拿一个当另一个的证据。
 */
export type MissionWaypoint = {
  id: string;
  label: string;
  componentId: string | null;
  /** 栅格坐标（10 cm/格，口径来自 GRID_MAP.resolutionM） */
  cell: [number, number];
};

export type MissionEntity = {
  id: string;
  kind?: "cruise" | "general";
  /** 来源工单（自主巡航任务必有） */
  orderId?: string | null;
  orderNo?: string | null;
  /** 本次要巡到的构件编号（Z01—Z04） */
  componentIds?: string[];
  robotId: string;
  mapVersion: string | null;
  speedProfile: string;
  /** 速度（m/s）：小车自报的上限；取不到就是 null */
  speedMps?: number | null;
  laps?: number;
  state: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  waypoints?: MissionWaypoint[];
  plannedPath?: [number, number][];
  /** 派发人 / 派发时刻 */
  createdBy?: string | null;
  createdAt: string;
  /** 接受人 / 接受时刻（谁去建图巡航就是谁） */
  acceptedBy?: string | null;
  acceptedAt?: string | null;
  endedAt: string | null;
  cancelReason: string | null;
};

/**
 * 执行工作台的任务卡（服务端 `taskCard` 实体；剧本 ⑥ ⑭ ⑮）。
 *
 * 一张卡 = 一件要有人做的事，带执行人（按岗位分工预填）、输入与完成条件；
 * 状态只有三个，**没有"已完成"** —— 剧本明令「小木创建任务草稿……不直接把任务标成已完成」，
 * 服务端也不给这个状态（`server/services/workflow.mjs` 的 `TASK_NEXT`）。
 * 回执记的是"谁在什么时候接了这活"，与巡航任务的 `acceptedBy` 同一口径。
 */
export type TaskCardEntity = {
  id: string;
  orderId: string;
  orderNo: string | null;
  /** 批次标识：同一张工单的同一批次只生成一次（服务端幂等） */
  batchKey: string;
  /** 批次内序号（页面按它排，不按 id 的字典序） */
  seq: number;
  title: string;
  ownerAccountId: string;
  ownerLabel: string;
  /** 岗位文案（展示用，取自 `seed/scenario.ts` 的 MEMBERS）；判权限一律按 `ownerAccountId` */
  ownerRole: string | null;
  inputs: string[];
  doneCondition: string;
  note: string | null;
  /** 谁生成的：小木（剧本里由小木生成草稿）或人工 */
  source: string;
  state: "draft" | "saved" | "accepted";
  createdBy: string | null;
  createdAt: string;
  savedBy: string | null;
  savedAt: string | null;
  ackedBy: string | null;
  ackedAt: string | null;
  ackNote?: string | null;
};

/**
 * 小木回合留痕（服务端 `agentTurn` 实体；内网多主机内容同步用）。
 *
 * 演示机每讲一轮就往服务端写一条：轮次号、台词、页面落点、发起端 id。
 * 作用有两个：
 *   · **事件源**：其它机器在自己的 WS 事件流里收到 `xiaomu.round` 后跟随显示与页面动作
 *     （前端 `agent/roundSync.ts`；发起端 id 用来忽略自己的回声）；
 *   · **留痕**：事后能核对"哪台机器在哪一轮讲了什么"。
 */
export type AgentTurnEntity = {
  id: string;
  roundNo: string;
  text: string;
  nav: Record<string, unknown> | null;
  /** 发起端的浏览器 id（每台机器/每个标签页一个）；跟随端据此忽略自己发的 */
  hostId: string | null;
  by: string | null;
  at: string;
};

export type MapVersionEntity = {
  id: string;
  label: string;
  resolutionM: number;
  coveragePct: number;
  sizeText: string;
  state: string;
  savedBy: string;
  savedAt: string;
};

export type SceneEntity = {
  id: string;
  title: string;
  round: "历史" | "本轮";
  /** 绑定的工单：一个工单一份场景成果，孪生页按它取模型 */
  orderId?: string | null;
  /** 上传到平台的高斯模型文件 id（`/api/files/:id/download` 可取回渲染） */
  assetFileId?: string | null;
  assetId: string | null;
  format: string;
  componentAnchors: { componentId: string; zoneId: string; position: unknown }[];
  bookmarkIds: string[];
  /**
   * 机位关键帧（数字孪生页「打关键帧」写进来的，服务端 `scene.keyframe.add`）。
   *
   * 与 `bookmarkIds` 的关系：打一帧会把帧号并进 `bookmarkIds`（同一个东西的两种叫法），
   * 场景检查的「视角书签已建立」读的就是那份并集。
   */
  keyframes?: {
    id: string;
    componentId: string | null;
    label: string;
    pose: { azimuth: number; polar: number; distance: number; focus: { x: number; y: number; z: number } };
    addedBy: string;
    addedAt: string;
  }[];
  checkResult: { checks: { key: string; label: string; pass: boolean; detail: string }[]; pass: boolean; checkedBy: string; checkedAt: string } | null;
  state: string;
  submittedBy: string;
  submittedAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
};

/**
 * 内网协同（服务端 /api/sessions/:id/peers）。
 *
 * `peers` 是**服务端数的真实连接数**（WebSocket 房间大小，含本机这一台），
 * `lanUrls` 是服务端从网卡枚举出来的内网地址 —— 两个都不在前端猜，
 * 现场"别人连上了没有""同事该打开哪个地址"直接照这个念。
 *
 * 2026-09-18 补（用户报「我这边添加工单，沈那边收不到」）：端数与地址不够用了，
 * 还要能回答"他那台到底连到这台服务器没有"。于是服务端把**每台端的对端地址**
 * （TCP 事实，不是页面自报）、服务器身份（主机名 / 端口 / 库文件 / 启动时刻）、
 * 以及可达地址（局域网 + 虚拟局域网两类）一起报出来。
 */
export type CollabAddress = {
  url: string;
  address: string;
  /** 网卡名，例如 WLAN / Radmin VPN */
  iface: string;
  kind: "lan" | "vpn";
  kindLabel: string;
  /** 现场该念的那一条 */
  recommended: boolean;
};

export type CollabEnd = {
  id: string;
  address: string;
  sessionId: string;
  accountId: string | null;
  accountName: string | null;
  page: string | null;
  openedAt: string;
  lastSeenAt: string;
  /** 打开到现在多久（毫秒） */
  openedMs: number;
  /** 最近一次有动静是多久以前（毫秒） */
  idleMs: number;
};

export type CollabServer = {
  hostname: string;
  port: number | null;
  dbFile: string | null;
  startedAt: string;
  serverTime: string;
  addressCount?: number;
  endsTotal?: number;
};

export type LanPeers = {
  sessionId: string;
  /** 本会话房间里现在有几台端连着（含自己） */
  peers: number;
  /** 所有会话房间的总连接数（排查用：换过会话时它比 peers 大） */
  clients: number;
  /** 同事可直接打开的地址（内网网段） */
  lanUrls: string[];
  /** 每台端的明细：对端地址 + 账号 + 当前页面 + 打开多久 + 最近动静 */
  ends: CollabEnd[];
  /** 这台服务器是谁 */
  server: CollabServer;
  /** 可达地址（lan 在前、vpn 在后；第一条是推荐念的那条） */
  addresses: CollabAddress[];
  port: number | null;
  serverTime: string;
};

/** 同步实测结论（服务端 /api/console/sync-probe） */
export type SyncProbe = {
  probeId: string;
  sessionId: string;
  /** 实测事件在事件流里的序号（证明它是真写进去的一条，不是假消息） */
  seq: number | null;
  at: string;
  ageMs: number;
  from: { address?: string; addressLabel?: string; actorId?: string };
  /** 下发那一刻房间里**还活着**的端数（没动静的半开连接不进分母） */
  ends: number;
  /** 房间里已经没动静、不计入分母的端数（界面要说明"另有 N 台"） */
  stale?: number;
  acked: { endId: string; address: string; addressLabel: string; accountId: string | null; page: string | null; at: string; ms: number }[];
  /** 没回执的端 —— 现场要盯的就是这几个 */
  pending: { id: string; address: string; addressLabel: string; accountId: string | null; page: string | null }[];
  /** 全部端都回了执才算通过；一台都没连上时不算通过 */
  ok: boolean;
  /** 最后一台端回执的用时（"几秒内全网可见"） */
  lastAckMs: number | null;
};

/** 写入来源（服务端 /api/console/write-log）：最近谁从哪台机器写了什么 */
export type WriteLogEntry = {
  at: string;
  atMs: number;
  method: string;
  path: string;
  action: string | null;
  actorId: string | null;
  address: string;
  status: number | null;
  durationMs: number | null;
};

export type WriteLogPage = {
  entries: WriteLogEntry[];
  kept: number;
  server: CollabServer;
  ends: (CollabEnd & { addressLabel: string })[];
};

/** 排练控制台的总览（服务端 /api/console/overview） */
export type RehearsalOverview = {
  currentSessionId: string;
  sessions: {
    id: string;
    scenarioId: string;
    stage: string;
    status: string;
    lastSeq: number;
    createdAt: string;
    updatedAt: string;
    entityCount: number;
  }[];
  stages: { key: string; label: string }[];
  snapshots: {
    id: string;
    stage: string;
    label: string;
    entityCount: number;
    createdBy: string;
    createdAt: string;
  }[];
  preflight: { items: { key: string; label: string; pass: boolean; detail: string }[]; ok: boolean };
};

/** 归档清单项（服务端 archiveItem 实体）：登记摘要与真实文件是一一对应的 */
export type ArchiveItemEntity = {
  assetId: string;
  group: string;
  name: string;
  sizeText: string;
  declaredSha256: string;
  fileId: string | null;
  present: boolean;
  repairedBy: string | null;
  repairedAt: string | null;
};

/** 归档校验报告（服务端逐项读字节后的结论） */
export type ArchiveCheckReport = {
  executedAt: string;
  total: number;
  passed: number;
  missing: number;
  mismatch: number;
  method: string;
  rows: {
    assetId: string;
    group: string;
    name: string;
    sizeText: string;
    fileId: string | null;
    declaredSha256: string;
    computedSha256: string | null;
    bytes: number;
    status: "通过" | "缺失" | "摘要不一致";
  }[];
};

export type ArtifactEntity = {  id: string;
  name: string;
  kind: string;
  target: string;
  modelVersion: string;
  demoOnly: boolean;
  fromJob: string | null;
  files: { fileId: string; role: string }[];
  state: string;
  sha256: string;
  sizeText: string;
  publishedBy: string | null;
  publishedAt: string | null;
  downloadedBy?: string;
  downloadedAt?: string;
  downloadCount?: number;
  receivedFiles?: {
    fileId: string;
    actor: string;
    at: string;
    size: number | null;
    sha256: string | null;
  }[];
  receipts: {
    at: string;
    actor: string;
    reportedVersion: string | null;
    verifiedHash: string | null;
    pass: boolean;
    note: string;
    deviceMode: string;
  }[];
};

/* ------------------------------------------------------------------ *
 * 令牌（登录会话与演示会话分开：令牌只回答「你是谁」）
 * ------------------------------------------------------------------ */

const TOKEN_KEY = "mumai.token";

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式：本次会话内存里仍然有效 */
  }
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

function toApiError(status: number, body: unknown): ApiError {
  const record = (body ?? {}) as Record<string, unknown>;
  return {
    status,
    code: typeof record.code === "string" ? record.code : "UNKNOWN",
    message: typeof record.message === "string" ? record.message : `请求失败（HTTP ${status}）`,
    fieldErrors: Array.isArray(record.fieldErrors) ? (record.fieldErrors as ApiError["fieldErrors"]) : [],
    retryable: record.retryable === true,
    ...record,
  };
}

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/**
 * 服务重启会换掉签名密钥（`server/services/auth.mjs` 没设 `MUMAI_SECRET` 时每次启动随机），
 * 于是**页面还开着、令牌已经失效**：下一次点击就是 401。
 *
 * 这里补一次「用本地会话重新登录 + 重放原请求」，让用户不用手动刷新。
 * 并发的多个 401 共用同一次登录（`reloginInFlight`），不会打出四五个登录请求。
 */
let reloginInFlight: Promise<boolean> | null = null;

async function reloginWithSession(): Promise<boolean> {
  if (reloginInFlight) return reloginInFlight;
  reloginInFlight = (async () => {
    const session = readSession();
    const account = session?.login || session?.accountId;
    if (!account) return false;
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, password: DEMO_PASSWORD }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { token?: string };
      if (!body?.token) return false;
      writeToken(body.token);
      return true;
    } catch {
      return false;
    } finally {
      window.setTimeout(() => {
        reloginInFlight = null;
      }, 0);
    }
  })();
  return reloginInFlight;
}

/**
 * 统一的平台请求入口（登录令牌 + 401 自动补登录 + 统一错误体）。
 *
 * 导出给同源的其它数据源复用（小车链路 `cart/api.ts`）—— 那里如果自己写一份
 * fetch，就等于把「令牌失效补登录」「服务未启动给可识别错误」这两条规则复制一遍，
 * 迟早两边不一致（一边显示"未连接"、一边显示"登录过期"）。
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    // 服务没起 / 网线掉了：给一个可识别的错误，让页面显示「未连接」而不是假装成功
    throw {
      status: 0,
      code: "OFFLINE",
      message: "连接不上共享服务，请确认服务已启动",
      fieldErrors: [],
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    } satisfies ApiError;
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    // 令牌失效：补一次登录后**只重放一次**这个请求；补不上就给一句人能照着做的话
    const retried = (init as RequestInit & { __reloginRetried?: boolean }).__reloginRetried;
    if (response.status === 401 && token && !retried) {
      if (await reloginWithSession()) {
        return apiRequest<T>(path, { ...init, __reloginRetried: true } as RequestInit);
      }
      throw {
        status: 401,
        code: "SESSION_EXPIRED",
        message: "登录已过期，请刷新页面后重试",
        fieldErrors: [],
        retryable: false,
      } satisfies ApiError;
    }
    throw toApiError(response.status, body);
  }
  return body as T;
}

/**
 * 令牌保鲜的探测与补登录（给轮询类调用方复用）。
 *
 * ── 为什么要把这两个动作单独导出 ────────────────────────────────────
 * `useDeviceLink` 的轮询在"手里有令牌、但令牌已失效"时会打出一批必然 401 的请求。
 * `apiRequest` 内部虽然会自动补登录并重放成功，但那一次 401 响应**已经被浏览器
 * 记进控制台**，事后无法撤销 —— 而 `tools/accept.mjs` 的判据里有"console error = 0"，
 * 于是同一份代码连跑三遍时红时绿。
 *
 * 所以轮询在请求之前先做一次**不产生红字**的探测：`/api/auth/me` 对无效令牌回
 * `actor: null`（正常答案，不是 401）；拿到 null 就用本地会话补一次登录。
 * 详见 `src/pages/MumaiDashboard/device/tokenGate.ts`。
 */
export async function probeActor(): Promise<Actor | null> {
  const me = await apiRequest<{ actor: Actor | null }>("/api/auth/me");
  return me?.actor ?? null;
}

export { reloginWithSession };

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 平台资源（总览「平台数据」与资源弹窗的唯一数据源）
 *
 * 与服务端 `server/services/platform-resources.mjs` 的快照一一对应（PRD §10.2）。
 * 单位口径固定：存储十进制 TB、内存与显存 GiB、网络十进制 B/s。
 * 缺失一律是 `null`（不是 0、不是 -1），界面据此显示「—」。
 * ------------------------------------------------------------------ */

export type ResourceQuality = "fresh" | "stale" | "unavailable";
export type LoadState = "idle" | "low" | "medium" | "high" | "unknown";

export type PlatformServerResource = {
  id: string;
  volumeId: string | null;
  storage: { totalTb: number | null; usedTb: number | null; freeTb: number | null; ratio: number | null };
  memory: { totalGib: number | null; usedGib: number | null; ratio: number | null };
  gpu: {
    /** 无型号：CON1..CONn 是映射单元，不宣称每台装了哪张卡（主机实测卡名见 mappingExplain.gpuName） */
    percent: number | null;
    load: LoadState;
    vramUsedGib: number | null;
    vramRatio: number | null;
  };
  powerW: number | null;
};

export type PlatformMappingExplain = {
  hostId: string;
  note: string;
  storageTotalTB: number;
  memoryTotalGiB: number;
  /** 逐台显存总量的分母 = 主机实测显存（采样不到 GPU 时为 null，界面显示「—」） */
  vramTotalGiB: number | null;
  powerRangeW: [number, number];
  networkScale: number;
  mappingVersion: string;
  platform?: string;
  arch?: string;
  cpuCores?: number;
  gpuSource?: string | null;
  gpuName?: string | null;
  networkInterfaces?: string[];
  topologyVersion?: number;
  epoch?: number;
  errors?: Record<string, string | null>;
  startedAt?: string;
};

export type PlatformResources = {
  schemaVersion: number;
  snapshotId: string;
  hostId: string;
  epoch: number;
  topologyVersion: number;
  mappingVersion: string;
  sampledAt: string;
  quality: ResourceQuality;
  serverCount: number;
  /** 一个有效卷都没识别到时给原因；界面据此显示「未识别存储卷」 */
  noVolumeReason: string | null;
  /** 显存展示总量的分母（GiB，主机实测显存）；读不到就是 null */
  gpuVramTotalGib: number | null;
  /** 验收夹具标识；真实采集时为 null。界面会把它标出来，不让夹具冒充实测 */
  fixture: { name: string; label: string } | null;
  summary: {
    storageTotalTB: number;
    storageUsedTB: number | null;
    storageRatio: number | null;
    memoryTotalGiB: number;
    memoryUsedGiB: number | null;
    memoryRatio: number | null;
    gpuBasePercent: number | null;
    loadState: LoadState;
    powerTotalW: number | null;
    uploadBytesPerSec: number | null;
    downloadBytesPerSec: number | null;
  };
  servers: PlatformServerResource[];
  metricQuality: { gpu: ResourceQuality; memory: ResourceQuality; storage: ResourceQuality; network: ResourceQuality };
  metricSampledAt: { gpu: number | null; memory: number | null; storage: number | null; network: number | null };
  mappingExplain: PlatformMappingExplain;
};

export type PlatformHistoryPoint = { at: string; atMs: number; uploadBytesPerSec: number | null; downloadBytesPerSec: number | null };
export type PlatformHistory = { windowSec: number; scale: number; points: PlatformHistoryPoint[] };

export const api = {
  async login(account: string, password: string) {
    const result = await apiRequest<{ token: string; actor: Actor; allowedActions: string[] }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ account, password }),
    });
    writeToken(result.token);
    return result;
  },

  /**
   * 用当前账号换取令牌；页面刷新后令牌还在就直接复用。
   *
   * `/api/auth/me` 对「没有令牌 / 令牌过期」回的是 `actor: null`（正常答案，不是 401），
   * 所以这里不需要靠异常来发现令牌失效 —— 少一次 401，控制台就少一条噪音。
   */
  async ensureSession(account: string, password: string) {
    if (readToken()) {
      try {
        const me = await apiRequest<{ actor: Actor | null; allowedActions: string[] }>("/api/auth/me");
        if (me.actor) return { actor: me.actor, allowedActions: me.allowedActions };
      } catch {
        /* 服务没起来之类：下面统一走登录，失败会在登录那一步报出来 */
      }
      writeToken(null);
    }
    return api.login(account, password);
  },

  snapshot(sessionId: string) {
    return apiRequest<Snapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  },

  createSession(scenarioId = "chapter2") {
    return apiRequest<{ session: Snapshot["session"] }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ scenarioId }),
    });
  },

  /**
   * 提交一条命令。
   *
   * commandId 由调用方传，默认按「动作 + 实体 + 时间片」生成：
   * 同一个 tick 内重复点击会得到同一个 id，服务端只执行一次。
   */
  command<T = CommandResult>(body: {
    action: string;
    sessionId: string;
    entityId?: string | null;
    expectedRevision?: number | null;
    payload?: Record<string, unknown>;
    commandId?: string;
  }) {
    return apiRequest<T>("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        commandId: body.commandId ?? makeCommandId(body.action, body.entityId ?? null),
        sessionId: body.sessionId,
        action: body.action,
        entityId: body.entityId ?? null,
        expectedRevision: body.expectedRevision ?? null,
        payload: body.payload ?? {},
      }),
    });
  },

  validateEnvironment(inputs: Record<string, unknown>) {
    return apiRequest<{
      ok: boolean;
      checks: { key: string; label: string; ok: boolean; field: string; message: string }[];
      fieldErrors: { field: string; message: string }[];
      emcPct: number | null;
      methodVersion: string;
      note: string;
    }>("/api/environments/validate", { method: "POST", body: JSON.stringify({ inputs }) });
  },

  /**
   * 投屏（PRD §12 的 `POST /api/projection`）。
   *
   * 不走命令总线：PRD 把投屏单列成一个接口，而且它的前置条件不是实体 revision
   * 而是「持有人」——`hold: true` 表示显式接管（换人时要有这个动作），
   * 否则非持有人会被服务端用 409 NOT_HOLDER 拒掉。
   */
  setProjection(
    sessionId: string,
    body: { viewType: string; focusIds: string[]; hold?: boolean },
  ) {
    return apiRequest<{ holderId: string; viewType: string; focusIds: string[]; eventSeq: number }>(
      "/api/projection",
      { method: "POST", body: JSON.stringify({ sessionId, ...body }) },
    );
  },

  fileMeta(fileId: string) {
    return apiRequest<{ fileId: string; name: string; size: number; sha256: string; mediaType: string }>(
      `/api/files/${encodeURIComponent(fileId)}`,
    );
  },

  verifyFile(fileId: string) {
    return apiRequest<{ fileId: string; name: string; present: boolean; match: boolean; declaredSha256?: string; actualSha256: string | null }>(
      `/api/files/${encodeURIComponent(fileId)}/verify`,
    );
  },

  /** 真实下载：走浏览器原生下载，产物落到「下载」目录而不是只写一条记录 */
  downloadUrl(fileId: string) {
    return `/api/files/${encodeURIComponent(fileId)}/download`;
  },

  /**
   * 给渲染器用的模型地址：**带 `?token=`**。
   *
   * 高斯泼溅的模型是由 Three.js 的加载器（SplatMesh）直接请求的，加不了
   * `Authorization` 头，所以这一条地址把令牌放进查询串（服务端只对下载放行这种取法）。
   * 下载给人用的那一条（`downloadUrl`）不带 —— 它走带头的原生下载。
   */
  modelUrl(fileId: string, fileName?: string | null) {
    const token = readToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    /*
     * 路径里必须留文件名：加载器按**扩展名**判格式（`.sog` / `.spz`），
     * 只有 id 的地址它会报 Unknown file type。`:name` 不参与寻址，只给扩展名与下载名。
     */
    const name = fileName?.trim() || "model.sog";
    return `/api/files/${encodeURIComponent(fileId)}/model/${encodeURIComponent(name)}${query}`;
  },

  /**
   * 下载一个文件资产。
   *
   * **不能直接 `<a href="/api/files/…/download">`**：导航式下载带不上
   * `Authorization` 头，服务端会回 401（这是实测定出来的 —— 锚点点了没反应，
   * 抓到的 href 正确但请求被拒）。所以先走 fetch 把字节拿回来，
   * 再用 blob URL 触发保存；文件名从 Content-Disposition 解析，中文名不会丢。
   *
   * 大文件不适用的道理要写在代码里：这里是整包读进内存。
   * 演示更新包是几十 KB 量级，够用；真要下几百 MB 的产物应改成
   * 「服务端签发一次性下载地址」。
   */
  async download(fileId: string, fallbackName: string) {
    const token = readToken();
    let response: Response;
    try {
      response = await fetch(api.downloadUrl(fileId), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    } catch (error) {
      throw {
        status: 0,
        code: "OFFLINE",
        message: "连接不上共享服务，无法下载",
        fieldErrors: [],
        retryable: true,
        cause: error instanceof Error ? error.message : String(error),
      } satisfies ApiError;
    }
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { message: text };
      }
      throw toApiError(response.status, body);
    }

    const blob = await response.blob();
    const name = filenameFromDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立刻 revoke 会让部分浏览器来不及取内容，延后释放
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { name, size: blob.size, sha256: response.headers.get("x-file-sha256") };
  },

  upload(file: File, sessionId: string, dir = "uploads") {
    const query = new URLSearchParams({ name: file.name, sessionId, dir, mediaType: file.type || "application/octet-stream" });
    return apiRequest<{ fileId: string; name: string; size: number; sha256: string }>(`/api/files?${query}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    });
  },

  health() {
    return apiRequest<{ ok: boolean; service: string; sessions: number; assetsReady: boolean; clients: number }>("/api/health");
  },

  /**
   * 设备链路自检（用户 2026-09-22 给的「设备接入交接包」）。
   *
   * 判据在服务端算（既有服务里现取事实），这里只取结论 ——
   * 页面（硬件详情 → 设备接入）与小木的回答读的是**同一份**结论。
   */
  deviceReadiness() {
    return apiRequest<{
      generatedAt: string;
      counts: { ok: number; fail: number; warn: number };
      exitCode: 0 | 1;
      verdict: "ok" | "fail";
      sections: {
        key: string;
        title: string;
        items: { level: "ok" | "fail" | "warn"; title: string; detail?: string; hints?: string[] }[];
      }[];
      configs: { key: string; file: string; present: boolean; placeholder: boolean; purpose: string; env: string }[];
    }>("/api/device-readiness");
  },

  /**
   * 归档完整性校验（PRD §12 / 评审 F11）。
   *
   * 服务端逐项流式读文件字节重算 SHA-256，再与清单登记值比 ——
   * 客户端**不再自己算**：以前是拿种子里的 actualSha256 和 declaredSha256 比，
   * 等于自己跟自己比，把文件删了结论也一样。
   */
  archiveCheck(sessionId: string, assetIds?: string[]) {
    return apiRequest<ArchiveCheckReport>("/api/archives/check", {
      method: "POST",
      body: JSON.stringify({ sessionId, assetIds: assetIds ?? [] }),
    });
  },

  /** 补传 / 重选副本：把清单项指向一份真实文件，登记摘要取该文件的真实摘要 */
  archiveRepair(sessionId: string, assetId: string, fileId: string) {
    return apiRequest<{ assetId: string; fileId: string; name: string; sizeText: string; sha256: string; repairedBy: string }>(
      "/api/archives/repair",
      { method: "POST", body: JSON.stringify({ sessionId, assetId, fileId }) },
    );
  },

  /* ---- 排练控制台（PRD §11 / 评审 F12） ---- */

  consoleOverview(sessionId: string) {
    return apiRequest<RehearsalOverview>(`/api/console/overview?sessionId=${encodeURIComponent(sessionId)}`);
  },

  /**
   * 内网协同：本会话有几台端连着 + 同事该打开哪个地址（用户口径 2026-09-17）。
   * 端数是服务端数的真实 WebSocket 连接数，内网地址由服务端从网卡枚举出来，
   * 两边都不在前端猜。
   */
  sessionPeers(sessionId: string) {
    return apiRequest<LanPeers>(`/api/sessions/${encodeURIComponent(sessionId)}/peers`);
  },

  /**
   * 同步实测：真写一条 `sync.probe` 事件并下发，每台端收到后回执。
   *
   * 结论是「M/N 台端在 x 秒内收到」—— 用户 2026-09-18 报的
   * 「我这边添加工单，沈那边收不到」，到这里就从一句感觉变成一条可证伪的读数。
   * 权限：排练控制台（console:admin）。
   */
  syncProbe(sessionId: string) {
    return apiRequest<SyncProbe>("/api/console/sync-probe", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  },

  /** 查实测结论（端回执是异步的，页面按 probeId 轮询到齐） */
  syncProbeStatus(probeId: string) {
    return apiRequest<SyncProbe>(`/api/console/sync-probe/${encodeURIComponent(probeId)}`);
  },

  /** 最近一次实测（页面刷新后还能念出上一次的结论） */
  latestSyncProbe() {
    return apiRequest<{ probe: SyncProbe | null }>("/api/console/sync-probe");
  },

  /** 最近谁从哪台机器写了什么（写请求级留痕，权限：console:admin） */
  writeLog(limit = 20) {
    return apiRequest<WriteLogPage>(`/api/console/write-log?limit=${limit}`);
  },

  /** 新建一场演示会话：新一轮隔离，从开场状态开始 */
  consoleNewSession(scenarioId = "chapter2") {
    return apiRequest<{ session: RehearsalOverview["sessions"][number]; entityCount: number }>(
      "/api/console/sessions",
      { method: "POST", body: JSON.stringify({ scenarioId }) },
    );
  },

  consoleCapture(sessionId: string, stage: string, label: string) {
    return apiRequest<{ id: string; stage: string; label: string; entityCount: number; createdAt: string }>(
      "/api/console/snapshots",
      { method: "POST", body: JSON.stringify({ sessionId, stage, label }) },
    );
  },

  /** 恢复阶段快照：把整场实体换回快照内容，历史事件流不动 */
  consoleRestore(sessionId: string, snapshotId: string) {
    return apiRequest<{ restored: number; stage: string; at: string; label: string; snapshotId: string }>(
      "/api/console/snapshots/restore",
      { method: "POST", body: JSON.stringify({ sessionId, snapshotId }) },
    );
  },

  consoleDeleteSnapshot(sessionId: string, snapshotId: string) {
    return apiRequest<{ removed: boolean }>("/api/console/snapshots/delete", {
      method: "POST",
      body: JSON.stringify({ sessionId, snapshotId }),
    });
  },

  /** 导出诊断包：会话 + 实体 + 快照 + 事件 + 预检，一份 JSON */
  consoleDiagnostics(sessionId: string) {
    return apiRequest<Record<string, unknown>>(`/api/console/diagnostics?sessionId=${encodeURIComponent(sessionId)}`);
  },

  /* ---- 平台资源（运行后端这台机器的真实占用） ---- */

  /**
   * 平台资源快照（主卡与弹窗共用同一份，PRD §10.2）。
   *
   * `fixture` 只在开发环境生效：验收要用 F1–F4 夹具验算映射公式，
   * 生产构建里后端会忽略这个参数。
   */
  platformResources(fixture?: string) {
    const query = fixture ? `?fixture=${encodeURIComponent(fixture)}` : "";
    return apiRequest<PlatformResources>(`/api/platform/resources${query}`);
  },

  platformResourceHistory(windowSec = 60) {
    return apiRequest<PlatformHistory>(`/api/platform/resources/history?windowSec=${windowSec}`);
  },

  /* ---- 手持终端（树莓派 / woodpulse）设备网关 ---- */

  /**
   * 硬件页数据：终端最后一次上报 + 平台算出来的链路状态。
   *
   * 读不到（设备从没上报过 / 服务不可达）时由调用方兜底 —— 硬件页在设备离线时
   * 要退回种子数据继续演示，而不是整页报错。
   */
  deviceHardware(deviceId: string) {
    return apiRequest<DeviceHardwareView>(`/api/devices/${encodeURIComponent(deviceId)}/hardware`);
  },

  deviceEvents(deviceId: string, limit = 40) {
    return apiRequest<{ deviceId: string; events: DeviceEvent[] }>(
      `/api/devices/${encodeURIComponent(deviceId)}/events?limit=${limit}`,
    );
  },

  deviceLedger() {
    return apiRequest<{ devices: DeviceLedgerEntry[]; status: Record<string, unknown>; serverTime: string }>("/api/devices");
  },

  /** 下发设备命令。终端的回执是异步的（accepted → executed），这里只负责发出去 */
  deviceCommand(deviceId: string, type: string, args: Record<string, unknown> = {}) {
    return apiRequest<{ command: { commandId: string; state: string; action: string }; pushed: boolean; hint: string }>(
      `/api/devices/${encodeURIComponent(deviceId)}/commands`,
      { method: "POST", body: JSON.stringify({ type, args }) },
    );
  },

  /* ---- 「重启服务」按钮（2026-09-19 用户口径） ---- */

  /**
   * 重置平台↔小车那**一条**连接。
   *
   * ⚠ 它**不重启平台、也不重启小车**：平台进程不动（浏览器这条 `/ws` 不断，
   * 页面不刷新、不用重新登录），车上的建图/导航进程也不中断。
   * 只把连接作废，由平台既有的退避重连立刻接手（退避被拨回最小值）。
   */
  cartReconnect() {
    return apiRequest<{ ok: boolean; hadConnection?: boolean; code?: string; message: string }>(
      "/api/cart/reconnect",
      { method: "POST" },
    );
  },

  /**
   * 重置某一台设备的通道（精扫终端 / 手持终端）。
   *
   * ⚠ 终端命令白名单里**没有重启**，所以这是平台侧能做到的极限：
   * 断开这条通道、等终端自己重连并重新握手。若终端自身卡在「离线」
   * （`ConnectionMachine` 不允许 OFFLINE→ONLINE 迁移），只有重启终端进程才行，
   * 页面必须如实显示，不能把"重置成功"说成"设备已恢复"。
   */
  deviceReconnect(deviceId: string) {
    return apiRequest<{
      ok: boolean;
      deviceId: string;
      closed: number;
      hadChannel: boolean;
      channelConnected: boolean;
      link: DeviceLinkState | null;
      message: string;
    }>(`/api/devices/${encodeURIComponent(deviceId)}/reconnect`, { method: "POST" });
  },

  /* ---- 工单指派与扫描仪下发（PRD-工单指派与扫描仪下发-v1.0） ---- */

  /**
   * 快捷键触发：`eventId` 由前端在**一次完整按键序列**上生成，
   * 服务端按它幂等 —— 断网重试同一个 ID，拿到的是同一张工单（PRD §3.1）。
   */
  triggerWorkOrder(eventId: string) {
    return apiRequest<WorkOrderTriggerResult>("/api/work-orders/trigger", {
      method: "POST",
      body: JSON.stringify({ eventId }),
    });
  },

  workOrders(filter: WorkOrderFilter = "all", q = "") {
    const query = new URLSearchParams({ filter, q });
    return apiRequest<{ orders: WorkOrderSummary[]; accounts: AssignmentGroup[]; targets: DispatchTarget[] }>(
      `/api/work-orders?${query}`,
    );
  },

  workOrder(orderId: string) {
    return apiRequest<WorkOrderDetail>(`/api/work-orders/${encodeURIComponent(orderId)}`);
  },

  assignWorkOrder(
    orderId: string,
    body: { leaderAccountId: string; members: { accountId: string; duties: string[] }[]; expectedRevision: number },
  ) {
    return apiRequest<{ ok: boolean; detail: WorkOrderDetail }>(
      `/api/work-orders/${encodeURIComponent(orderId)}/assignment`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  },

  /**
   * 流程动作。除了工单详情，服务端还会带回**这次动作顺带做了什么** ——
   * 目前只有「归档」会顺带把这张单登进知识库（`services/knowledge-ingest.mjs`），
   * 字段形如 `{ assetId, created, revision, jobId }`；登记失败时是 `{ error }`，
   * 老的响应里则没有这个字段，所以调用方一律按可选处理。
   */
  setWorkOrderStatus(orderId: string, action: WorkOrderAction, expectedRevision?: number) {
    return apiRequest<{
      ok: boolean;
      detail: WorkOrderDetail;
      knowledge?: { assetId?: string; created?: boolean; revision?: number; jobId?: string | null; error?: string } | null;
    }>(
      `/api/work-orders/${encodeURIComponent(orderId)}/status`,
      { method: "POST", body: JSON.stringify({ action, expectedRevision }) },
    );
  },

  /** 保存环境草稿：未填的项传 null，服务端保持 null，不补 0 也不补标准气压 */
  saveWorkOrderEnvironment(
    orderId: string,
    body: {
      inputs: Partial<Record<EnvironmentFieldKey, number | null>>;
      pressure?: { value: number | null; unit: string } | null;
      instruments: { instrumentId: string; fields: string[]; source?: string }[];
      position: string;
      measuredAt: string;
      expectedRevision: number;
    },
  ) {
    return apiRequest<{ ok: boolean; environment: EnvironmentView }>(
      `/api/work-orders/${encodeURIComponent(orderId)}/environment-draft`,
      { method: "PUT", body: JSON.stringify(body) },
    );
  },

  validateWorkOrderEnvironment(orderId: string, expectedRevision: number) {
    return apiRequest<{ ok: boolean; environment: EnvironmentView }>(
      `/api/work-orders/${encodeURIComponent(orderId)}/environment/validate`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    );
  },

  /** 删除工单（项目经理）：级联清掉主体、指派、环境版本与下发记录，不可恢复 */
  deleteWorkOrder(orderId: string) {
    return apiRequest<{ ok: boolean; orderNo: string; status: string; openDispatches: number }>(
      `/api/work-orders/${encodeURIComponent(orderId)}`,
      { method: "DELETE" },
    );
  },

  dispatchWorkOrder(
    orderId: string,
    body: { deviceId: string; configVersion?: string | null; expectedRevision?: number; idempotencyKey: string },
  ) {
    return apiRequest<{ ok: boolean; dispatch: DispatchView; replayed: boolean; hint?: string }>(
      `/api/work-orders/${encodeURIComponent(orderId)}/dispatches`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
};

/* ------------------------------------------------------------------ *
 * 工单域类型（与服务端 services/work-orders.mjs 的返回结构一一对应）
 * ------------------------------------------------------------------ */

export type WorkOrderFilter = "all" | "assign" | "active" | "archived";

export type WorkOrderStatus = "待指派" | "待准备" | "待作业" | "作业中" | "待验收" | "已归档" | "已暂停";

export type WorkOrderAction = "start" | "submit" | "accept" | "archive" | "pause" | "resume";

export type EnvironmentFieldKey =
  | "airTempC"
  | "relativeHumidityPct"
  | "windSpeedMs"
  | "atmosphericPressureHpa";

export type WorkOrderSubject = {
  subjectId: string;
  code: string;
  type: string;
  name: string;
  position: string | null;
  positionStatus: "pending" | "confirmed";
};

export type WorkOrderSummary = {
  id: string;
  orderNo: string;
  title: string;
  status: WorkOrderStatus;
  revision: number;
  assignmentRevision: number;
  location: string;
  district: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  createdAt: string;
  source: string;
  leaderLabel: string | null;
  dispatchState: string;
};

export type AssignmentMember = {
  accountId: string;
  roleCode: string;
  label: string;
  duties: { code: string; label: string }[];
};

export type AssignmentView = {
  assignmentId: string;
  revision: number;
  leaderAccountId: string;
  leaderRoleCode: string;
  leaderLabel: string;
  members: AssignmentMember[];
  assignedBy: string;
  assignedByLabel: string;
  assignedAt: string;
};

export type AssignmentCandidate = { accountId: string; displayLabel: string; roleCode: string; suggestedDuties: { code: string; label: string }[] };
export type AssignmentGroup = { roleCode: string; label: string; suggestedDuties: { code: string; label: string }[]; candidates: { accountId: string; displayLabel: string }[] };

export type EnvironmentView = {
  draftRevision: number;
  inputs: Record<EnvironmentFieldKey, number | null>;
  instruments: { instrumentId: string; fields: string[]; source?: string }[];
  pressureInput: { value: number; unit: string; hpa: number | null; invalid?: boolean } | null;
  position: string | null;
  measuredAt: string | null;
  needsRevalidate: boolean;
  updatedAt: string | null;
  updatedByLabel: string | null;
  config: {
    configVersion: string;
    draftRevision: number;
    inputs: Record<EnvironmentFieldKey, number>;
    instruments: { instrumentId: string; fields: string[] }[];
    position: string;
    measuredAt: string;
    checks: { key: string; label: string; ok: boolean; field: string; message: string }[];
    methodVersion: string;
    validatedByLabel: string;
    validatedAt: string;
    superseded: boolean;
  } | null;
  catalog: { instrumentId: string; name: string; fields: string[]; ranges: Record<string, { min: number; max: number; unit: string }>; source: string }[];
  fields: { key: EnvironmentFieldKey; label: string; unit: string }[];
};

export type DispatchView = {
  dispatchId?: string;
  bundleId: string | null;
  deviceId: string | null;
  commandId?: string | null;
  state: "none" | "queued" | "sent" | "accepted" | "executed" | "failed" | "expired" | "superseded";
  stateText: string;
  reason: string | null;
  activationState: string | null;
  configVersion: string | null;
  orderRevision?: number;
  assignmentRevision?: number;
  sha256?: string;
  createdAt?: string;
  expiresAt?: string;
  acceptedAt?: string | null;
  executedAt?: string | null;
  failedAt?: string | null;
  createdByLabel?: string | null;
};

export type DispatchTarget = {
  deviceId: string;
  online: boolean;
  linkState: string;
  socketConnected: boolean;
  connectionState: string;
  appVersion: string | null;
  capabilities: Record<string, unknown>;
  pendingCommands: number;
};

export type WorkOrderCapabilities = {
  canAssign: boolean;
  canDelete: boolean;
  canViewFull: boolean;
  assigned: boolean;
  isLeader: boolean;
  canEditEnvironment: boolean;
  canValidate: boolean;
  canDispatch: boolean;
  canPause: boolean;
  canResume: boolean;
  canStart: boolean;
  canSubmit: boolean;
  canAccept: boolean;
  canArchive: boolean;
};

export type WorkOrderDetail = {
  /** 未指派到此工单：只给摘要，委托正文与随单附件不下发（PRD §6.1） */
  restricted?: boolean;
  order: {
    id: string;
    orderNo: string;
    revision: number;
    assignmentRevision: number;
    status: WorkOrderStatus;
    pausedFrom: string | null;
    title: string;
    source: string;
    location: string;
    district: string;
    plannedStart: string | null;
    plannedEnd: string | null;
    schedulePrecision: string;
    timeZone: string;
    requirementsText: string;
    deliveryText: string;
    createdAt: string;
    updatedAt: string;
  };
  commission: {
    title: string;
    unit: string;
    date: string;
    no: string | null;
    projectName: string;
    address: string;
    subjectNote: string;
    scope: string;
    deliveryText: string;
    contact: { role: string; channel: string };
    attachments: { assetId: string; name: string; kind: string; sizeText: string; sourceMode: string }[];
    sourceMode: string;
  };
  subjects: WorkOrderSubject[];
  assignment: AssignmentView | null;
  environment: EnvironmentView;
  dispatch: DispatchView;
  dispatches: DispatchView[];
  work: { records: unknown[]; attachments: unknown[]; report: null };
  logs: { at: string; type: string; text: string; actorId: string | null; actorLabel: string }[];
  capabilities: WorkOrderCapabilities;
  accounts: AssignmentGroup[];
  targets: DispatchTarget[];
  assignmentCandidates: AssignmentCandidate[];
};

export type WorkOrderTriggerResult = {
  ok: boolean;
  created: boolean;
  orderId: string;
  orderNo: string;
  status: WorkOrderStatus;
  detail: WorkOrderDetail;
  capabilities: WorkOrderCapabilities;
};

let commandSeq = 0;
function makeCommandId(action: string, entityId: string | null) {
  commandSeq += 1;
  return `cmd-${action}-${entityId ?? "none"}-${Date.now().toString(36)}-${commandSeq}`;
}

/**
 * 从 Content-Disposition 里取文件名。
 *
 * 服务端按 RFC 5987 同时给了 `filename=`（ASCII 回退）和 `filename*=UTF-8''…`，
 * 优先用后者，否则中文名会变成一串下划线。
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      /* 编码坏了就退回 ASCII 名 */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}

/* ------------------------------------------------------------------ *
 * 事件流
 * ------------------------------------------------------------------ */

export type StreamHandle = {
  close: () => void;
  /**
   * 往这条实时通道发一条控制消息。
   *
   * 实时通道**只走控制消息**，业务写入一律走 POST /api/commands（文件头那条约定）：
   *   · `who`      页面自报"我是谁、在哪一页" —— 服务端据此把端对上人；
   *   · `sync-ack` 收到同步实测事件后回执（服务端算"M/N 台端在 x 秒内收到"）。
   * 权限判定只认 HTTP 令牌，这里自报的身份仅用于现场对表。
   */
  send: (message: Record<string, unknown>) => boolean;
};

/**
 * 订阅演示会话的事件流。
 *
 * 浏览器 WebSocket 不会自己重连，所以这里手写退避重连；重连时带上
 * `afterSeq`，服务端把断线期间的事件补发一遍（PRD §7）。
 */
export function subscribe(
  sessionId: string,
  handlers: {
    onHello?: (info: { lastSeq: number; replayed: number }) => void;
    onEvent?: (event: StreamEvent) => void;
    onStatus?: (status: "connecting" | "open" | "closed") => void;
    /** 连接建立时报一次身份（账号 + 当前页面），服务端用来把端对上人 */
    onIdentify?: () => { accountId?: string; accountName?: string } | null;
  },
): StreamHandle {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let lastSeq = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let watchdogTimer = 0;
  /** 最近一次**收到任何消息**的时刻（事件 / hello / pong 都算） */
  let lastMessageAt = Date.now();

  const STALE_AFTER_MS = 45_000;
  const PING_EVERY_MS = 15_000;

  const url = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${lastSeq}`;
  };

  /** 当前页面：端明细里"他在哪一页"就是它（切换路由不需要重连，心跳会带上新的） */
  const currentPage = () => (typeof window === "undefined" ? null : window.location.hash || "#/");

  const send = (message: Record<string, unknown>): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const identify = () => {
    const identity = handlers.onIdentify?.() ?? {};
    send({ kind: "who", page: currentPage(), ...identity });
  };

  const connect = () => {
    if (closed) return;
    handlers.onStatus?.("connecting");
    try {
      socket = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      lastMessageAt = Date.now();
      handlers.onStatus?.("open");
      identify();
      // 应用层保活：局域网里空闲连接会被中间设备掐掉
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          /* 带 JSON 的 ping 顺手上报当前页面：端明细里的"在哪一页"跟着路由走 */
          if (!send({ kind: "ping", page: currentPage() })) socket.send("ping");
        }
      }, PING_EVERY_MS);
      /*
        ── 失联自检（2026-09-17 加）─────────────────────────────────────
        局域网里笔记本休眠、切 Wi-Fi、拔网线之后，TCP 会变成**半开**：
        浏览器既不报错也不触发 `onclose`，`readyState` 一直显示 OPEN。
        此时页面收不到任何事件，顶栏却还写着「正常」—— 用户看到的就是
        「这边改了，那边不动」，与"同步坏了"完全一样。

        所以按"最近一次收到消息"计时：服务端每收到一次 `ping` 就回 `pong`
        （见 hub.mjs），而客户端每 15 秒发一次；45 秒还一条消息都没有，
        就说明这条链路已经不通 —— 主动 `close()` 把它推回重连退避，
        重连时会带上 `afterSeq` 把断线期间的事件补回来（PRD §7）。
      */
      watchdogTimer = window.setInterval(() => {
        if (closed) return;
        if (Date.now() - lastMessageAt <= STALE_AFTER_MS) return;
        try {
          socket?.close();
        } catch {
          /* 已经烂掉的 socket，close 抛错也无所谓，下面的 onclose 会兜住 */
        }
      }, 10_000);
    };
    socket.onmessage = (raw) => {
      lastMessageAt = Date.now();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw.data));
      } catch {
        return;
      }
      if (message.kind === "hello") {
        lastSeq = Number(message.lastSeq ?? lastSeq);
        handlers.onHello?.({ lastSeq, replayed: Number(message.replayed ?? 0) });
        return;
      }
      if (message.kind !== "event") return;
      const event = message as unknown as StreamEvent;
      // 重复事件直接忽略：重连补发与实时推送可能重叠
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      handlers.onEvent?.(event);
    };
    socket.onclose = () => {
      window.clearInterval(pingTimer);
      window.clearInterval(watchdogTimer);
      handlers.onStatus?.("closed");
      scheduleRetry();
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  const scheduleRetry = () => {
    if (closed) return;
    attempt += 1;
    const delay = Math.min(800 * attempt, 5000);
    retryTimer = window.setTimeout(connect, delay);
  };

  connect();

  return {
    close: () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      window.clearInterval(watchdogTimer);
      socket?.close();
    },
    send,
  };
}

/** 供 store 初始化时取用：当前登录账号（localStorage 会话） */
export function currentAccountId(): string {
  return readSession()?.accountId ?? "shen";
}

export const DEMO_PASSWORD = "123456";
