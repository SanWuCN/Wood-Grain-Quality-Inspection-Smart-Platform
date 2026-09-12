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

export type MissionEntity = {
  id: string;
  robotId: string;
  mapVersion: string | null;
  speedProfile: string;
  state: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  endedAt: string | null;
  cancelReason: string | null;
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
  assetId: string | null;
  format: string;
  componentAnchors: { componentId: string; zoneId: string; position: unknown }[];
  bookmarkIds: string[];
  checkResult: { checks: { key: string; label: string; pass: boolean; detail: string }[]; pass: boolean; checkedBy: string; checkedAt: string } | null;
  state: string;
  submittedBy: string;
  submittedAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (!response.ok) throw toApiError(response.status, body);
  return body as T;
}

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

export const api = {
  async login(account: string, password: string) {
    const result = await request<{ token: string; actor: Actor; allowedActions: string[] }>("/api/auth/login", {
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
        const me = await request<{ actor: Actor | null; allowedActions: string[] }>("/api/auth/me");
        if (me.actor) return { actor: me.actor, allowedActions: me.allowedActions };
      } catch {
        /* 服务没起来之类：下面统一走登录，失败会在登录那一步报出来 */
      }
      writeToken(null);
    }
    return api.login(account, password);
  },

  snapshot(sessionId: string) {
    return request<Snapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  },

  createSession(scenarioId = "chapter2") {
    return request<{ session: Snapshot["session"] }>("/api/sessions", {
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
    return request<T>("/api/commands", {
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
    return request<{
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
    return request<{ holderId: string; viewType: string; focusIds: string[]; eventSeq: number }>(
      "/api/projection",
      { method: "POST", body: JSON.stringify({ sessionId, ...body }) },
    );
  },

  fileMeta(fileId: string) {
    return request<{ fileId: string; name: string; size: number; sha256: string; mediaType: string }>(
      `/api/files/${encodeURIComponent(fileId)}`,
    );
  },

  verifyFile(fileId: string) {
    return request<{ fileId: string; name: string; present: boolean; match: boolean; declaredSha256?: string; actualSha256: string | null }>(
      `/api/files/${encodeURIComponent(fileId)}/verify`,
    );
  },

  /** 真实下载：走浏览器原生下载，产物落到「下载」目录而不是只写一条记录 */
  downloadUrl(fileId: string) {
    return `/api/files/${encodeURIComponent(fileId)}/download`;
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
    return request<{ fileId: string; name: string; size: number; sha256: string }>(`/api/files?${query}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    });
  },

  health() {
    return request<{ ok: boolean; service: string; sessions: number; assetsReady: boolean; clients: number }>("/api/health");
  },

  /**
   * 归档完整性校验（PRD §12 / 评审 F11）。
   *
   * 服务端逐项流式读文件字节重算 SHA-256，再与清单登记值比 ——
   * 客户端**不再自己算**：以前是拿种子里的 actualSha256 和 declaredSha256 比，
   * 等于自己跟自己比，把文件删了结论也一样。
   */
  archiveCheck(sessionId: string, assetIds?: string[]) {
    return request<ArchiveCheckReport>("/api/archives/check", {
      method: "POST",
      body: JSON.stringify({ sessionId, assetIds: assetIds ?? [] }),
    });
  },

  /** 补传 / 重选副本：把清单项指向一份真实文件，登记摘要取该文件的真实摘要 */
  archiveRepair(sessionId: string, assetId: string, fileId: string) {
    return request<{ assetId: string; fileId: string; name: string; sizeText: string; sha256: string; repairedBy: string }>(
      "/api/archives/repair",
      { method: "POST", body: JSON.stringify({ sessionId, assetId, fileId }) },
    );
  },

  /* ---- 排练控制台（PRD §11 / 评审 F12） ---- */

  consoleOverview(sessionId: string) {
    return request<RehearsalOverview>(`/api/console/overview?sessionId=${encodeURIComponent(sessionId)}`);
  },

  /** 新建一场演示会话：新一轮隔离，从开场状态开始 */
  consoleNewSession(scenarioId = "chapter2") {
    return request<{ session: RehearsalOverview["sessions"][number]; entityCount: number }>(
      "/api/console/sessions",
      { method: "POST", body: JSON.stringify({ scenarioId }) },
    );
  },

  consoleCapture(sessionId: string, stage: string, label: string) {
    return request<{ id: string; stage: string; label: string; entityCount: number; createdAt: string }>(
      "/api/console/snapshots",
      { method: "POST", body: JSON.stringify({ sessionId, stage, label }) },
    );
  },

  /** 恢复阶段快照：把整场实体换回快照内容，历史事件流不动 */
  consoleRestore(sessionId: string, snapshotId: string) {
    return request<{ restored: number; stage: string; at: string; label: string; snapshotId: string }>(
      "/api/console/snapshots/restore",
      { method: "POST", body: JSON.stringify({ sessionId, snapshotId }) },
    );
  },

  consoleDeleteSnapshot(sessionId: string, snapshotId: string) {
    return request<{ removed: boolean }>("/api/console/snapshots/delete", {
      method: "POST",
      body: JSON.stringify({ sessionId, snapshotId }),
    });
  },

  /** 导出诊断包：会话 + 实体 + 快照 + 事件 + 预检，一份 JSON */
  consoleDiagnostics(sessionId: string) {
    return request<Record<string, unknown>>(`/api/console/diagnostics?sessionId=${encodeURIComponent(sessionId)}`);
  },
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

export type StreamHandle = { close: () => void };

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
  },
): StreamHandle {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let lastSeq = 0;
  let retryTimer = 0;
  let pingTimer = 0;

  const url = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${lastSeq}`;
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
      handlers.onStatus?.("open");
      // 应用层保活：局域网里空闲连接会被中间设备掐掉
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
      }, 15000);
    };
    socket.onmessage = (raw) => {
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
      socket?.close();
    },
  };
}

/** 供 store 初始化时取用：当前登录账号（localStorage 会话） */
export function currentAccountId(): string {
  return readSession()?.accountId ?? "shen";
}

export const DEMO_PASSWORD = "123456";
