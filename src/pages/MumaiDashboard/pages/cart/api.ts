/**
 * 小车端接口（木脉智检 · 小车端接口 v1.0）在平台前端这一侧的**唯一入口**
 *
 * 页面不直连小车，所有请求都打到平台服务端的 `/api/cart/*`（原因见
 * `server/services/cart.mjs` 的文件头：控制令牌不出服务端、跨源与 Origin 校验）。
 * 这一层负责三件事：
 *
 *   1. **类型**：按文档第 2、8 节把小车的完整状态写成类型。
 *      字段一律可选/可 null —— 文档 §2 明确「`null` 不应渲染为 0」
 *      （IMU、里程计超过 2 秒未更新就是 null，不是 0）。
 *   2. **实时**：优先用小车 → 平台 → 页面的 WS 推送（约 2 Hz），
 *      同时保留一条**低频兜底轮询**：局域网里 WS 被中间设备掐掉是常态，
 *      没有兜底就会出现「页面显示 3 秒前的状态、其实早就断了」。
 *   3. **动作**：把 14 个控制动作按文档第 4、5 节的请求体形状发出去，
 *      并带 `X-Request-Id` —— 小车按它做幂等（文档 §1），
 *      同一逻辑操作重试时必须复用同一个编号。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, isApiError, readToken, type ApiError } from "../../api/client";

/* ------------------------------------------------------------------ *
 * 状态类型（文档 §2 / §8）
 * ------------------------------------------------------------------ */

export type CartPose = { x: number; y: number; yaw: number };

export type CartMission = {
  state:
    | "idle"
    | "accepting"
    | "running"
    | "pausing"
    | "paused"
    | "stopping"
    | "stopped"
    | "completed"
    | "failed";
  index: number;
  cycle: number;
  points: CartPose[];
  mode: "single" | "multi" | "loop";
  distance_remaining: number | null;
};

export type CartMapMeta = {
  width: number;
  height: number;
  resolution: number;
  origin: { x: number; y: number; yaw: number };
  frame_id: string;
  /** PNG 图像坐标的已知区域 `[left, top, right, bottom]`，右/下为开区间 */
  bounds: [number, number, number, number] | null;
  revision: number;
};

export type CartSavedMap = {
  id: string;
  name: string;
  created_at: string;
  map: CartMapMeta;
  saved_pose: CartPose | null;
  area_m2: number | null;
};

export type CartRoute = {
  id: string;
  name: string;
  map_id: string;
  points: CartPose[];
  mode: "single" | "multi" | "loop";
  speed_mps: number;
};

export type CartState = {
  schema_version?: string;
  device_id?: string;
  sampled_at?: number;
  simulated?: boolean;
  mode?: "idle" | "mapping" | "navigation";
  transition?: string | null;
  uptime_s?: number;
  active_map_id?: string | null;
  map?: CartMapMeta | null;
  pose?: CartPose | null;
  velocity?: { linear_mps: number; angular_rps: number; pose: CartPose | null } | null;
  imu?: {
    roll_deg: number;
    pitch_deg: number;
    yaw_deg: number;
    angular_velocity: { x: number; y: number; z: number };
    linear_acceleration: { x: number; y: number; z: number };
  } | null;
  imu_history?: [number, number, number, number][];
  lidar?: { state: "online" | "offline"; hz: number | null; age_s: number | null };
  camera?: { state: string; fps: number | null; age_s: number | null; size?: { width: number; height: number } };
  metrics?: { cpu_percent: number | null; memory_percent: number | null; temperature_c: number | null };
  battery_voltage?: number | null;
  battery?: {
    state?: string;
    voltage_v?: number | null;
    age_s?: number | null;
    percentage?: number | null;
    charging?: boolean | null;
    charging_current_a?: number | null;
    bms?: Record<string, number | string | null> | null;
  } | null;
  chassis?: {
    state?: string;
    model?: string | null;
    drive_type?: string | null;
    age_s?: number | null;
    odometry?: {
      pose?: CartPose | null;
      linear_mps?: number | null;
      lateral_mps?: number | null;
      angular_rps?: number | null;
      frame_id?: string;
      child_frame_id?: string;
    } | null;
    commanded_velocity?: { linear_mps: number; angular_rps: number } | null;
    command_age_s?: number | null;
  } | null;
  speed_mps?: number | null;
  max_speed_mps?: number | null;
  scan_points?: [number, number][];
  path?: CartPose[];
  localization?: {
    ready: boolean;
    match: number | null;
    amcl_received: boolean;
    match_age_s: number | null;
    covariance: { x_m2: number | null; y_m2: number | null; yaw_rad2: number | null } | null;
  };
  mission?: CartMission | null;
  navigation?: { ready: boolean; planner_ready: boolean };
  platform?: { state: "unconfigured" | "online" | "offline"; last_success: number | null; error: string | null };
  streams?: {
    rviz: string;
    camera: string;
    rviz_state?: string;
    rtmp?: { rviz: string; camera: string };
  };
  error?: string | null;
  last_error?: string | null;
};

/** 平台服务端到小车的链路（服务端算好的，页面不自己判新鲜度） */
export type CartLink = "unconfigured" | "connecting" | "online" | "offline";

export type CartStatus = {
  configured: boolean;
  canControl: boolean;
  link: CartLink;
  /** 服务端判定：链路在线且状态年龄 ≤3 秒（文档 §2） */
  live: boolean;
  ageMs: number | null;
  lastError: string | null;
  state: CartState | null;
  info: CartInfo;
  serverTime: string;
};

export type CartInfo = {
  deviceId?: string | null;
  version?: string | null;
  simulated?: boolean | null;
  maxSpeedMps?: number | null;
  canControl?: boolean;
  platformUrl?: string;
  platformTokenSet?: boolean;
  rvizRtmpUrl?: string;
  cameraRtmpUrl?: string;
  telemetryIntervalS?: number | null;
};

/* ------------------------------------------------------------------ *
 * 只读请求
 * ------------------------------------------------------------------ */

function cartGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { signal });
}

/** 平台侧到底有没有配这台车的地址与令牌 */
export const cartApi = {
  status: () => cartGet<CartStatus>("/api/cart/status"),
  info: () => cartGet<{ ok: boolean; info: CartInfo; status: unknown }>("/api/cart/info"),
  /** 小车只读通道：health / session / state / map / maps / routes / battery / chassis */
  read: <T>(channel: string) => cartGet<T>(`/api/cart/read/${channel}`),
  maps: () => cartGet<{ maps: CartSavedMap[] }>("/api/cart/read/maps"),
  routes: () => cartGet<{ routes: CartRoute[] }>("/api/cart/read/routes"),

  /**
   * 控制动作（文档第 4、5 节）。
   *
   * `requestId` 由调用方生成并**在重试时复用**；不传就在这里现生成一个。
   * 动作名走请求体（`{action, ...args}`），服务端按白名单校验。
   */
  async action<T = Record<string, unknown>>(
    action: string,
    args: Record<string, unknown> = {},
    requestId?: string,
  ): Promise<T> {
    const id = requestId ?? newRequestId();
    const result = await apiRequest<T & { ok?: boolean }>("/api/cart/action", {
      method: "POST",
      headers: { "x-request-id": id },
      body: JSON.stringify({ action, ...args }),
    });
    return result as T;
  },
};

/** 逻辑操作编号：同一件事重试要复用，所以它由**发起动作的地方**决定何时生成 */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * 视频输出尺寸
 * ------------------------------------------------------------------ */

/**
 * 从一份 MJPEG 字节流里读出第一帧的宽高。
 *
 * 为什么要自己解析：小车的状态里只有摄像头的 `camera.size`，
 * RViz 那一路**没有任何尺寸字段**（文档 §2 的 streams 只给了路径与状态）。
 * 不知道原始尺寸就没法保证「按原始比例显示」—— 只能猜一个容器比例，
 * 猜错就成了黑边或者看起来像被压扁。JPEG 的 SOF 段里就有真实的宽高，
 * 取一帧解析一次是确定性的做法。
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2; // 跳过 SOI
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    // SOF0/1/2/3、SOF5–7、SOF9–11、SOF13–15：这些段里带宽高
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length <= 0) return null;
    i += 2 + length;
  }
  return null;
}

/**
 * 两路视频的**原生输出尺寸**。
 *
 * 取一帧（前 ~256 KB 足够包含第一帧的 SOF 段）解析一次就够，之后画面按这个
 * 比例显示：比例对齐了就不会有黑边，也不会有任何压缩变形。
 * 解析不出来（网络问题、不是 JPEG）就返回 null，页面退回一个保守比例。
 */
export function useStreamSize(channel: "rviz" | "camera", enabled: boolean) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!enabled || size) return undefined;
    const controller = new AbortController();
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(streamUrl(channel), { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) return;
        let buffer = new Uint8Array(0);
        // 一帧可能上百 KB；读到解析出 SOF 为止，最多 2 MB 防呆
        while (alive && buffer.length < 2 * 1024 * 1024) {
          const { value, done } = await reader.read();
          if (done) break;
          const next = new Uint8Array(buffer.length + value.length);
          next.set(buffer);
          next.set(value, buffer.length);
          buffer = next;
          const parsed = jpegSize(buffer);
          if (parsed) {
            if (alive) setSize(parsed);
            break;
          }
        }
        await reader.cancel().catch(() => undefined);
      } catch {
        /* 通道离线或探测被中断：保持 null，页面用兜底比例 */
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [channel, enabled, size]);

  return size;
}

/* ------------------------------------------------------------------ *
 * 实时状态
 * ------------------------------------------------------------------ */

/** 兜底轮询周期。小车 2 Hz，这里 2 秒一次足够发现「WS 悄悄断了」 */
const FALLBACK_POLL_MS = 2000;

/**
 * 已保存地图的地址。
 *
 * `preview.png` 走平台代理，因此可以在 `<img>` 里直接用（同源、不要令牌头）；
 * 加 `?v=revision` 只是为了让浏览器换图 —— 服务端本身带 `cache-control: no-store`。
 */
export function savedMapPreviewUrl(map: CartSavedMap): string {
  return `/api/cart/maps/${encodeURIComponent(map.id)}/preview.png?v=${map.map?.revision ?? 0}`;
}

/** 当前栅格地图 PNG 的地址；`revision` 变了页面才重取（文档 §3） */
export function liveMapUrl(revision: number | null | undefined): string {
  return `/api/cart/map.png?v=${revision ?? 0}`;
}

/**
 * 两路 MJPEG 的平台代理地址。
 *
 * 不带扩展名：平台路由的参数段是 `([^/]+)`，段里带点号会让参数名变成
 * `channel.mjpeg` 而取不到值（详见 `server/api/http.mjs` 该路由的注释）。
 * 通道是白名单里的枚举值，本来也不需要靠扩展名判类型。
 */
export function streamUrl(channel: "rviz" | "camera"): string {
  return `/api/cart/stream/${channel}`;
}

/**
 * 画面比例的选择顺序：状态里的 `camera.size`（小车自己报的，权威）→ 探测到的
 * 原生尺寸 → 保守的 4:3。**任何情况下都用 contain 显示**，所以最坏也只是留边。
 */
export function streamAspectRatio(
  state: CartState | null,
  channel: "rviz" | "camera",
  probed: { width: number; height: number } | null,
): string {
  if (channel === "camera" && state?.camera?.size?.width && state.camera.size.height) {
    return `${state.camera.size.width} / ${state.camera.size.height}`;
  }
  if (probed?.width && probed.height) return `${probed.width} / ${probed.height}`;
  return "4 / 3";
}

export type CartLive = {
  /** 第一份数据还没到手 */
  loading: boolean;
  status: CartStatus | null;
  state: CartState | null;
  info: CartInfo;
  /** 页面自己算的「数据新鲜度」：服务端判的 live + 本地收到时刻，避免页面在 WS 静默时假装在线 */
  live: boolean;
  ageMs: number | null;
  /** 平台服务端 → 小车的链路 */
  link: CartLink;
  canControl: boolean;
  error: string;
  /** 强制重取一次（下发动作后立刻对齐状态） */
  refresh: () => void;
  updatedAt: number;
};

/**
 * 小车实时状态。
 *
 * 数据来源两条，**优先级不同**：
 *   1. 平台事件通道 `/ws` 的 `kind:"cart"` 帧（2 Hz，服务端已判过新鲜度）；
 *   2. 兜底轮询 `/api/cart/status`（2 秒一次）—— 只在收到最近一帧
 *      超过 `FALLBACK_POLL_MS × 2` 时才真正发请求，避免双份流量。
 *
 * 不新增 WS 连接：平台页面本来就连着 `/ws`（共享 store 用同一条），
 * 这里只是多读一种帧。
 */
export function useCartLive({ sessionId, enabled = true }: { sessionId: string; enabled?: boolean }): CartLive {
  const [status, setStatus] = useState<CartStatus | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const lastFrameAt = useRef(0);
  const disposed = useRef(false);

  const refresh = useCallback(() => setPollKey((n) => n + 1), []);

  /* ---- 1. WS 订阅（小车状态的主通道） ---- */
  useEffect(() => {
    if (!enabled) return undefined;
    disposed.current = false;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer = 0;
    let pingTimer = 0;

    const connect = () => {
      if (closed || !readToken()) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      try {
        socket = new WebSocket(
          `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&afterSeq=0`,
        );
      } catch {
        retry();
        return;
      }
      socket.onopen = () => {
        attempt = 0;
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 15000);
      };
      socket.onmessage = (raw) => {
        let message: { kind?: string; type?: string; payload?: CartStatus };
        try {
          message = JSON.parse(String(raw.data));
        } catch {
          return;
        }
        if (message.kind !== "cart" || !message.payload) return;
        lastFrameAt.current = Date.now();
        setStatus(message.payload);
        setError("");
        setUpdatedAt(Date.now());
      };
      socket.onclose = () => {
        window.clearInterval(pingTimer);
        if (!closed) retry();
      };
      socket.onerror = () => socket?.close();
    };

    const retry = () => {
      if (closed) return;
      attempt += 1;
      retryTimer = window.setTimeout(connect, Math.min(800 * attempt, 5000));
    };

    connect();
    return () => {
      closed = true;
      disposed.current = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      socket?.close();
    };
  }, [enabled, sessionId]);

  /* ---- 2. 兜底轮询：只在 WS 静默时才真的发请求 ---- */
  useEffect(() => {
    if (!enabled) return undefined;
    let running = false;
    const tick = async () => {
      if (running || !readToken()) return;
      const silent = Date.now() - lastFrameAt.current;
      if (silent < FALLBACK_POLL_MS * 2 && updatedAt) return;
      running = true;
      try {
        const next = await cartApi.status();
        if (disposed.current) return;
        setStatus(next);
        setError("");
        setUpdatedAt(Date.now());
      } catch (cause) {
        if (disposed.current) return;
        setError(isApiError(cause) ? (cause as ApiError).message : "小车状态读取失败");
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, pollKey, updatedAt]);

  /* 只读信息（device_id / 版本 / 上限速度 / 平台上报配置）：开页面取一次 */
  useEffect(() => {
    if (!enabled || !readToken()) return undefined;
    let alive = true;
    void cartApi
      .info()
      .then((result) => {
        if (!alive) return;
        setStatus((current) => (current ? { ...current, info: result.info } : current));
      })
      .catch(() => {
        /* 信息是附注，取不到不影响主状态 */
      });
    return () => {
      alive = false;
    };
  }, [enabled, pollKey]);

  /*
    本机时钟每 500 ms 走一格，用来把「服务端最后一帧的时刻」换算成会自己变大的
    延迟数字。不这样做的话，车停住（状态不再变化）时页面上的「延迟」会冻在
    一个旧值上，看起来像数据是新的。
  */
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const ageMs = useMemo(() => {
    if (!updatedAt) return status?.ageMs ?? null;
    // 本地收到时刻 + 服务端算出的上游年龄 ≈ 现在的真实年龄
    const local = clock - updatedAt;
    const upstream = status?.ageMs ?? 0;
    return local + upstream;
  }, [clock, status?.ageMs, updatedAt]);

  const live = Boolean(status?.link === "online") && ageMs !== null && ageMs <= 3000;

  return {
    loading: !status && !error,
    status,
    state: status?.state ?? null,
    info: status?.info ?? {},
    live,
    ageMs,
    link: status?.link ?? (error ? "offline" : "connecting"),
    canControl: Boolean(status?.canControl),
    error: error || status?.lastError || "",
    refresh,
    updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * 数据来源标注（页面顶部那条「实时 / 回放」用）
 * ------------------------------------------------------------------ */

/**
 * 小车的 `simulated` 是**权威**口径（文档 §1：只有显式 `--simulate` 才返回 true）。
 * 页面绝不能把演示数据说成实车数据，也不能反过来；未取到时显示「未知」。
 */
export function sourceLabel(state: CartState | null): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!state) return { text: "数据源未知", tone: "muted" };
  if (state.simulated) return { text: `演示数据 · ${state.device_id ?? "未命名设备"}`, tone: "warn" };
  return { text: `实车数据 · ${state.device_id ?? "未命名设备"}`, tone: "ok" };
}

/* ------------------------------------------------------------------ *
 * 电池：3S 锂电池的电压口径
 * ------------------------------------------------------------------ */

/**
 * 电池组规格。小车只提供电压（`/PowerVoltage`），没有库仑计，
 * 所以「剩余电量」只能由电压推算 —— 这是**标称 10.8 V 的 3S 锂电池**：
 *   · 满电 12.6 V（3 × 4.20 V）
 *   · 标称 10.8 V（3 × 3.60 V）
 *   · 截止 9.0 V（3 × 3.00 V，留了安全余量，不取 2.75 V 的极限值）
 * 参考：3S 锂离子满电 12.6 V / 标称 11.1 V / 参考截止 8.25 V
 * （<https://www.batterypkcell.com/news/lithium-battery-voltage-chart-li-ion-vs-lifepo4-from-1s-to-4s/>）。
 * 本机标称写成 10.8 V（3.6 V/节），比常见的 11.1 V 更保守，所以下限按 9.0 V 取。
 */
export const BATTERY_PACK = { series: 3, fullV: 12.6, nominalV: 10.8, emptyV: 9.0 };

/**
 * 单节电压 → 剩余电量。取锂离子电池静置放电曲线的常用查表点
 * （4.20 / 4.10 / 4.00 / 3.93 / 3.87 / 3.80 / 3.73 / 3.67 / 3.60 / 3.53 / 3.47 / 3.40 / 3.30 / 3.20 / 3.00 V），
 * 段内线性插值 —— 比拿 9.0–12.6 V 直接线性折算准得多（锂电池中段很平，
 * 线性折算会在 3.7 V 附近高估二十多个百分点）。
 */
const CELL_CURVE: [number, number][] = [
  [4.2, 100],
  [4.1, 90],
  [4.0, 80],
  [3.93, 70],
  [3.87, 60],
  [3.8, 50],
  [3.73, 40],
  [3.67, 30],
  [3.6, 20],
  [3.53, 14],
  [3.47, 10],
  [3.4, 6],
  [3.3, 3],
  [3.2, 1],
  [3.0, 0],
];

export function cellPercent(cellV: number): number {
  if (!Number.isFinite(cellV)) return 0;
  if (cellV >= CELL_CURVE[0][0]) return 100;
  const last = CELL_CURVE[CELL_CURVE.length - 1];
  if (cellV <= last[0]) return 0;
  for (let i = 0; i < CELL_CURVE.length - 1; i += 1) {
    const [vHigh, pHigh] = CELL_CURVE[i];
    const [vLow, pLow] = CELL_CURVE[i + 1];
    if (cellV <= vHigh && cellV >= vLow) {
      const ratio = (cellV - vLow) / (vHigh - vLow);
      return pLow + ratio * (pHigh - pLow);
    }
  }
  return 0;
}

/**
 * 剩余电量（本地推算，0–100 的整数）。
 *
 * 三条边界写清楚，避免给出误导性的数字：
 *   · 小车已经报了合法 BMS 百分比 → 直接用它（那是实测，比推算可信）；
 *   · 电压明显高于 3S 满电（> 13.0 V）→ 说明不是这组电池，**不给推算值**；
 *   · 电压缺失 → null。
 * 充电时电压会被充电器抬高，此时的百分比只能当参考 —— 页面在充电时
 * 干脆显示「充电中」而不显示读数。
 */
export function batteryPercent(state: CartState | null): number | null {
  const reported = state?.battery?.percentage;
  if (typeof reported === "number" && Number.isFinite(reported)) {
    return Math.round(Math.min(100, Math.max(0, reported)));
  }
  const voltage = state?.battery?.voltage_v ?? state?.battery_voltage ?? null;
  if (typeof voltage !== "number" || !Number.isFinite(voltage) || voltage <= 0) return null;
  if (voltage > BATTERY_PACK.fullV + 0.4) return null;
  return Math.round(cellPercent(voltage / BATTERY_PACK.series));
}

export function isCharging(state: CartState | null): boolean {
  return state?.battery?.charging === true;
}

/** 电压读数：充电时显示「充电中」（此时电压被充电器抬高，读数没有参考意义） */
export function voltageText(state: CartState | null): string {
  if (isCharging(state)) return "充电中";
  const voltage = state?.battery?.voltage_v ?? state?.battery_voltage ?? null;
  if (typeof voltage !== "number" || !Number.isFinite(voltage) || voltage <= 0) return "—";
  return `${voltage.toFixed(2)} V`;
}

export function cartErrorText(error: unknown): string {
  if (isApiError(error)) return (error as ApiError).message;
  return error instanceof Error ? error.message : "小车操作失败";
}
