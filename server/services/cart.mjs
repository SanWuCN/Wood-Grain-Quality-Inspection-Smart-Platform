/**
 * 小车链路（木脉智检 · 小车端接口 v1.0 的**平台侧唯一入口**）
 *
 * 为什么单独一层，而不是让页面直连小车：
 *   1. 控制令牌只能待在小车和平台服务端。文档 §1 明确「不要将令牌写进 URL
 *      或平台公开前端包」，页面直连就得把令牌交给浏览器；
 *   2. 小车对浏览器 POST/WS 校验 `Origin === Host`，页面从平台域跨源打过去
 *      会被 403；平台服务端调用没有这个限制；
 *   3. 小车在同一可信局域网里只有一个 HTTP 服务，多开页面时状态、视频、
 *      地图各拉一遍会把它压住。这里对小车**只保留一条状态 WS**，
 *      推到平台的事件通道，浏览器爱连几个连几个。
 *
 * 与手持终端那一路（`device-gateway.mjs`）的区别要写清楚：
 *   手持终端是**设备上行**到平台（register + device-events/batch），平台是接收方；
 *   小车这一路是**平台下行**（读状态、下指令、代理画面），小车自己不推平台
 *   （文档 §7 的 uplink 需要用户在车上配平台地址与令牌，当前 `platform.state`
 *   是 `unconfigured`）。所以这里不新增设备注册，直接按文档第 2、4、5、6 节
 *   调用小车已实现的接口。
 *
 * 令牌来源（照 `capture-screen.mjs` 的既有做法，二选一）：
 *   · 环境变量 `MUMAI_CART_URL` / `MUMAI_CART_TOKEN`
 *   · 本机安装配置 `server/data/cart.json`（.gitignore 忽略，权限 0600）
 *
 * 只读接口（state / map.png / MJPEG）在小车上不需要令牌，因此**没配令牌时
 * 这一页依然可看**，只是所有按钮置灰并说明原因；配了令牌才有控制权。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { get as httpGet, request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { WebSocket } from "ws";

/** 小车状态约 2 Hz 推送；超过这个年龄没有新状态就按文档 §2 判为断线 */
const STALE_AFTER_MS = 3000;
/**
 * 状态静默多久就认为这条连接已经「假活」（2026-09-18 实测踩到）。
 *
 * 现场结结实实遇到过一次：小车的状态 WS 半开 —— TCP 那头不发了，本端既不报错
 * 也不触发 `close`，`link` 一直写着 `online`，而页面上的「数据延迟」从 128 秒
 * 一路涨到 253 秒，运动操作全被禁用，看着就像"小车坏了"。同一时刻小车自己的
 * `/api/state` 与摄像头都是好的（2 Hz 推得好好的），说明只是这条连接烂在半路。
 *
 * 小车是 2 Hz 推状态，所以 8 秒一条都没有就已经不正常；发现后**主动 terminate**
 * 把它推回 `close → 退避重连` 这条已经验过的路上去（和浏览器端 45 秒失联自检同一套思路）。
 */
const QUIET_AFTER_MS = 8000;
/** 静默自检的节拍：比阈值小一个档，恢复得快一点 */
const QUIET_CHECK_MS = 3000;
/** 重连退避：1、2、4…最大 15 秒（文档 §2 要求客户端自行退避重连） */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** 控制请求默认超时。文档 §1：请求超时后先查询状态，再决定是否重试 */
const CONTROL_TIMEOUT_MS = 12000;
/** 取地图 PNG 的超时（800×800 的栅格图，局域网里很快） */
const MAP_TIMEOUT_MS = 8000;

/**
 * 小车的错误码 → 平台 HTTP 状态码。
 *
 * 两边的错误体形状本来就一致（`{ok:false,error:{code,message}}`），
 * 但状态码语义不同：小车把「没定位」也放在 409/422。平台这一侧对外的
 * `sendError` 只认 `WorkflowError(status, code, message)`，所以在这里翻译一次，
 * 让页面拿到的是**可判断**的状态码，而不是一律 502。
 */
const CART_ERROR_STATUS = {
  MAP_UNAVAILABLE: 409,
  MAP_NOT_FOUND: 404,
  INVALID_MAP_ID: 422,
  INVALID_NAME: 422,
  INVALID_WAYPOINTS: 422,
  INVALID_POSE: 422,
  OUTSIDE_MAP: 422,
  POINT_BLOCKED: 422,
  MAP_MISMATCH: 409,
  NOT_NAVIGATING: 409,
  NOT_LOCALIZED: 409,
  NAV_NOT_READY: 409,
  PLAN_REJECTED: 422,
  NO_PATH: 422,
  MISSION_ACTIVE: 409,
  NOT_RUNNING: 409,
  NOT_PAUSED: 409,
  PROCESS_CONFLICT: 409,
  LAUNCH_FAILED: 500,
  CANCEL_UNCONFIRMED: 409,
  NAV_SHUTDOWN: 503,
  ROS_TIMEOUT: 504,
  CONTROL_LOCKED: 403,
  UNAUTHORIZED: 403,
  IDEMPOTENCY_CONFLICT: 409,
};

/** 允许平台转发的控制路径（白名单，不做通用反代：小车的每个接口语义都要对得上页面动作） */
export const CART_ACTIONS = new Map([
  ["mapping/start", { path: "/api/mapping/start", permission: "map:save" }],
  ["mapping/restart", { path: "/api/mapping/restart", permission: "map:save" }],
  ["mapping/save", { path: "/api/mapping/save", permission: "map:save" }],
  ["mapping/stop", { path: "/api/mapping/stop", permission: "map:save" }],
  ["navigation/load", { path: "/api/navigation/load", permission: "mission:dispatch" }],
  ["navigation/auto-localize", { path: "/api/navigation/auto-localize", permission: "mission:dispatch" }],
  ["navigation/localize", { path: "/api/navigation/localize", permission: "mission:dispatch" }],
  ["navigation/preview", { path: "/api/navigation/preview", permission: "mission:dispatch" }],
  ["navigation/start", { path: "/api/navigation/start", permission: "mission:dispatch" }],
  ["navigation/pause", { path: "/api/navigation/pause", permission: "mission:monitor" }],
  ["navigation/resume", { path: "/api/navigation/resume", permission: "mission:monitor" }],
  ["navigation/speed", { path: "/api/navigation/speed", permission: "mission:dispatch" }],
  ["control/stop", { path: "/api/control/stop", permission: "mission:monitor" }],
  ["routes/save", { path: "/api/routes/save", permission: "map:save" }],
]);

/** MJPEG 通道白名单：只有文档第 6 节的两路，不把 `/api/*` 全部暴露出去 */
const STREAM_PATHS = {
  rviz: "/api/streams/rviz.mjpeg",
  camera: "/api/streams/camera.mjpeg",
};

const READ_PATHS = {
  health: "/api/health",
  session: "/api/session",
  state: "/api/state",
  config: "/api/config",
  map: "/api/map",
  maps: "/api/maps",
  routes: "/api/routes",
  battery: "/api/battery",
  chassis: "/api/chassis",
};

/** 控制令牌与地址：环境变量优先，其次本机安装配置（不写进仓库） */
export function cartConfig() {
  let local = {};
  try {
    local = JSON.parse(readFileSync(resolve("server/data/cart.json"), "utf8"));
  } catch {
    /* 没有安装配置是正常状态：这一页仍可只读 */
  }
  const url = String(process.env.MUMAI_CART_URL ?? local.url ?? "").replace(/\/+$/, "");
  const token = String(process.env.MUMAI_CART_TOKEN ?? local.token ?? "");
  return { url, token, configured: Boolean(url), canControl: Boolean(url && token) };
}

/** 从 base 取 Origin，供小车校验（文档 §1：浏览器 Origin 必须与 Host 一致） */
function originOf(base) {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export function createCartService({ logger = console } = {}) {
  const config = cartConfig();
  const origin = originOf(config.url);

  /** 小车最近一份完整状态 + 本地收到的时刻 */
  let state = null;
  let stateAt = 0;
  /** 与小车状态 WS 的连接状态 */
  let link = config.configured ? "connecting" : "unconfigured";
  let lastError = null;
  let lastAttemptAt = 0;
  let socket = null;
  /** 这条连接最近一次收到**任何**消息的时刻：静默自检按它判断"是不是假活" */
  let lastMessageAt = 0;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let disposed = false;
  /** 平台侧订阅者：平台自己的浏览器 WS 连接，由 http.mjs 注册 */
  const listeners = new Set();
  /** 小车只读信息（health / session / config）缓存，避免每次开页面都打一遍 */
  let info = { deviceId: null, version: null, simulated: null, maxSpeedMps: null, canControl: false, platformUrl: "" };

  const now = () => Date.now();

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn?.("[cart] 订阅者回调失败:", error?.message);
      }
    }
  }

  function ageMs() {
    return stateAt ? now() - stateAt : null;
  }

  /**
   * 对外的状态快照。
   *
   * 文档 §2：超过 3 秒没有新状态就应显示断线并禁用运动操作 —— 这个判定放在
   * 服务端算一次，页面不再各算各的（两台电脑时钟不一样，各算会给出不同结论）。
   * `ageMs === null` 表示这一轮还没收到过任何状态，与「刚断线」是两回事。
   */
  function snapshot() {
    const age = ageMs();
    const live = link === "online" && age !== null && age <= STALE_AFTER_MS;
    return {
      configured: config.configured,
      canControl: config.canControl,
      /** 平台服务端到小车的连接状态：unconfigured / connecting / online / offline */
      link,
      /** 状态数据是否新鲜（≤3 秒）。页面用它决定运动按钮能不能点 */
      live,
      ageMs: age,
      lastError,
      state,
      info,
      /** 服务端时刻，页面据此算「数据延迟」而不是拿自己的时钟去减小车时间戳 */
      serverTime: new Date().toISOString(),
    };
  }

  /* ---------------- 与小车状态 WS ---------------- */

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // 只是重连计时器，不该拖住进程退出
    reconnectTimer.unref?.();
  }

  function connect() {
    if (disposed || !config.configured) return;
    lastAttemptAt = now();
    let url;
    try {
      url = new URL("/api/ws", config.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    } catch {
      link = "offline";
      lastError = "小车地址不是合法 URL";
      emit({ type: "link" });
      return;
    }

    try {
      socket = new WebSocket(url, { headers: origin ? { origin } : {} });
    } catch (error) {
      link = "offline";
      lastError = error?.message ?? "无法建立连接";
      emit({ type: "link" });
      scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      link = "online";
      lastError = null;
      lastMessageAt = now();
      reconnectDelay = RECONNECT_MIN_MS;
      emit({ type: "link" });
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // 坏帧丢掉，不打断这条流
      }
      /* 任何一帧都算"这条连接还活着"：不只是 state，小车别的消息也证明对端在 */
      lastMessageAt = now();
      if (message?.type !== "state" || !message.payload) return;
      state = message.payload;
      stateAt = now();
      if (link !== "online") {
        link = "online";
        emit({ type: "link" });
      }
      emit({ type: "state", payload: state });
    });

    socket.on("close", () => {
      socket = null;
      if (disposed) return;
      link = "offline";
      // 保持上一份状态：页面要能看到「最后一份数据 + 已断线」，而不是一片空白
      emit({ type: "link" });
      scheduleReconnect();
    });

    socket.on("error", (error) => {
      lastError = error?.message ?? "小车连接错误";
      if (link !== "offline") {
        link = "offline";
        emit({ type: "link" });
      }
    });
  }

  /**
   * 静默自检：连着但很久没有消息 → 主动断开，走退避重连。
   *
   * 只在 `link === "online"` 时判：`offline` 本来就在重连，`connecting` 还没连上，
   * 拿它们开刀只会把正常流程打断。
   */
  const quietTimer = setInterval(() => {
    if (disposed || link !== "online") return;
    const quietMs = lastMessageAt ? now() - lastMessageAt : 0;
    if (!quietMs || quietMs <= QUIET_AFTER_MS) return;
    lastError = `小车状态已静默 ${Math.round(quietMs / 1000)} 秒（连接看着还在，其实已经不通），正在重连`;
    link = "offline";
    emit({ type: "link" });
    try {
      /* terminate 而不是 close：半开的连接上 close 会等握手，terminate 直接把它推回 close 事件 */
      socket?.terminate();
    } catch {
      /* 已经烂掉的 socket，terminate 抛错也无所谓：下面的 close 会兜住重连 */
    }
  }, QUIET_CHECK_MS);
  // 只是自检计时器，不该拖住进程退出
  quietTimer.unref?.();

  /* ---------------- HTTP ---------------- */

  function baseHeaders({ control = false, requestId = null, json = false } = {}) {
    const headers = {};
    if (json) headers["content-type"] = "application/json";
    if (origin) headers.origin = origin;
    if (control && config.token) headers["x-control-token"] = config.token;
    if (requestId) headers["x-request-id"] = String(requestId).slice(0, 120);
    return headers;
  }

  /**
   * 调小车接口。
   *
   * `binary: true` 时不解析 JSON，返回 Buffer（地图 PNG 走这条路）。
   * 小车的错误体在 4xx/5xx 上也可能是合法 JSON，所以先读全再判断。
   */
  function call(path, { method = "GET", body = null, control = false, requestId = null, timeout = CONTROL_TIMEOUT_MS } = {}) {
    return new Promise((resolvePromise, reject) => {
      if (!config.configured) {
        reject(Object.assign(new Error("没有配置小车地址"), { code: "CART_UNCONFIGURED", status: 503 }));
        return;
      }
      let url;
      try {
        url = new URL(path, config.url);
      } catch {
        reject(Object.assign(new Error("小车地址不是合法 URL"), { code: "CART_BAD_URL", status: 503 }));
        return;
      }
      const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
      const headers = baseHeaders({ control, requestId, json: payload !== null });
      if (payload) headers["content-length"] = String(payload.length);

      const send = url.protocol === "https:" ? httpsGet : httpRequest;
      const request = send(
        url,
        { method, headers, timeout },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const raw = Buffer.concat(chunks);
            const text = raw.toString("utf8");
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = null;
            }
            if (parsed && parsed.ok === false && parsed.error) {
              const code = parsed.error.code ?? "CART_ERROR";
              reject(
                Object.assign(new Error(parsed.error.message ?? "小车拒绝了这次操作"), {
                  code,
                  status: CART_ERROR_STATUS[code] ?? (response.statusCode >= 500 ? 502 : 409),
                  upstreamStatus: response.statusCode,
                }),
              );
              return;
            }
            if (response.statusCode >= 400) {
              reject(
                Object.assign(new Error(parsed?.error?.message ?? `小车返回 HTTP ${response.statusCode}`), {
                  code: parsed?.error?.code ?? "UPSTREAM_ERROR",
                  status: response.statusCode >= 500 ? 502 : response.statusCode,
                }),
              );
              return;
            }
            resolvePromise({ status: response.statusCode, headers: response.headers, json: parsed, raw });
          });
        },
      );
      request.on("timeout", () => request.destroy(Object.assign(new Error("小车响应超时"), { code: "ROS_TIMEOUT", status: 504 })));
      request.on("error", (error) => {
        if (error?.status) reject(error);
        else
          reject(
            Object.assign(new Error(`连不上小车：${error?.message ?? "网络错误"}`), {
              code: "CART_UNREACHABLE",
              status: 502,
            }),
          );
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** 只读接口的统一入口：小车返回什么原样给出（文档 §1：查询直接返回资源，不包 data） */
  async function read(name) {
    const path = READ_PATHS[name];
    if (!path) throw Object.assign(new Error("未知的只读通道"), { code: "BAD_CHANNEL", status: 404 });
    const result = await call(path, { control: name === "config", timeout: 6000 });
    return result.json;
  }

  /** 地图 PNG：与元信息组合使用（文档 §3），未就绪时小车回 404 */
  async function mapImage() {
    const result = await call("/api/map.png", { timeout: MAP_TIMEOUT_MS });
    return result.raw;
  }

  async function savedMapImage(mapId, file) {
    const allowed = new Set(["preview.png", "map.yaml", "map.pgm", "metadata.json"]);
    if (!allowed.has(file)) throw Object.assign(new Error("不支持的地图文件"), { code: "BAD_FILE", status: 404 });
    /*
      预览图与 Nav2 文件的路径**不一样**（文档 §2 的两条）：
        · 预览图   GET /api/maps/{id}/preview.png
        · Nav2 文件 GET /api/maps/{id}/files/{map.yaml|map.pgm|metadata.json}
      把 preview.png 也拼到 `/files/` 下面，小车回 404「文件不存在」，
      页面上的缩略图就全裂了 —— 实测踩过这个。
    */
    const path =
      file === "preview.png"
        ? `/api/maps/${encodeURIComponent(mapId)}/preview.png`
        : `/api/maps/${encodeURIComponent(mapId)}/files/${file}`;
    const result = await call(path, { timeout: MAP_TIMEOUT_MS });
    return result.raw;
  }

  /** 转发一个控制动作。白名单里的路径才允许（见 CART_ACTIONS） */
  async function control(action, body, requestId) {
    const entry = CART_ACTIONS.get(action);
    if (!entry) throw Object.assign(new Error("未知的控制动作"), { code: "BAD_ACTION", status: 404 });
    if (!config.canControl) {
      throw Object.assign(new Error("平台侧未配置小车控制令牌，只能查看不能操作"), {
        code: "CONTROL_LOCKED",
        status: 403,
      });
    }
    const result = await call(entry.path, { method: "POST", body: body ?? {}, control: true, requestId });
    return result.json;
  }

  /**
   * 刷新只读信息（device_id / 版本 / 上限速度 / 平台上报配置）。
   * 页面每 10 秒问一次 `/api/cart/info` 就够了，这里不设定时器。
   */
  async function refreshInfo() {
    const next = { ...info };
    const [health, session, configView] = await Promise.allSettled([
      read("health"),
      read("session"),
      read("config"),
    ]);
    if (health.status === "fulfilled" && health.value) {
      next.version = health.value.version ?? null;
      next.simulated = Boolean(health.value.simulated);
    }
    if (session.status === "fulfilled" && session.value) {
      next.deviceId = session.value.device_id ?? next.deviceId;
      next.maxSpeedMps = session.value.max_speed_mps ?? next.maxSpeedMps;
      // 平台服务端调用时小车看到的是局域网来源，can_control 会是 false；
      // 真正的控制权以平台侧有没有令牌为准（config.canControl）
      next.canControl = config.canControl;
    }
    if (configView.status === "fulfilled" && configView.value) {
      next.platformUrl = configView.value.platform_url ?? "";
      next.platformTokenSet = Boolean(configView.value.platform_token_set);
      next.rvizRtmpUrl = configView.value.rviz_rtmp_url ?? "";
      next.cameraRtmpUrl = configView.value.camera_rtmp_url ?? "";
      next.telemetryIntervalS = configView.value.telemetry_interval_s ?? null;
    }
    info = next;
    return info;
  }

  /**
   * MJPEG 直通（照 `capture-screen.mjs` 的做法）。
   *
   * 不做转码、不缓冲整段：小车的 multipart 流原样 pipe 给浏览器，
   * 浏览器 `<img>` 就能播。带宽是「每个观看者一条」，局域网内可接受 ——
   * 换成服务端解帧再分发的收益要在多路观看时才出现，不值得现在就引入解码依赖。
   * 未就绪的通道不上抛假图（文档 §6）：上游不是 multipart 就回 502，页面显示离线。
   */
  function proxyStream(channel, req, res) {
    const path = STREAM_PATHS[channel];
    if (!path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("未知的视频通道");
      return null;
    }
    if (!config.configured) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("未配置小车地址");
      return null;
    }
    const url = new URL(path, config.url);
    const getter = url.protocol === "https:" ? httpsGet : httpGet;
    const upstream = getter(url, { headers: baseHeaders(), timeout: 8000 });
    /*
      「连不上」与「连上了但没出帧」要分开报（接真车实测）：小车那一头 RViz 没起时，
      上游会回 200 + 正确的 content-type 然后一直不吐帧 —— 这时说「连不上小车视频通道」
      会把人送到网络方向去查。用一个标记区分，502 的文案才说得准。
    */
    let sawResponse = false;
    upstream.on("timeout", () => {
      upstream.destroy(Object.assign(new Error("上游没有出帧"), { noFrames: true }));
    });
    upstream.on("response", (stream) => {
      sawResponse = true;
      if (stream.statusCode !== 200 || !String(stream.headers["content-type"]).startsWith("multipart/x-mixed-replace")) {
        stream.resume();
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end("该视频通道当前不可用");
        }
        return;
      }
      res.writeHead(200, {
        "content-type": stream.headers["content-type"],
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    });
    upstream.on("error", (error) => {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(error?.noFrames || sawResponse ? "小车这一路没有出帧（RViz / 摄像头可能没起）" : "连不上小车视频通道");
      } else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    return null;
  }

  /**
   * 探一路 MJPEG：**等到第一块数据**才判定出帧。
   *
   * ⚠ 只回 200 + multipart 不代表有画面（接上真车实测出来的）：
   *   小车那一头 RViz 没起时，`/api/streams/rviz.mjpeg` 会「200 + 正确的 content-type，
   *   然后一直不吐帧」—— 只看响应头会把它报成"有真实出帧"，页面却是黑的。
   *   所以这里等第一块数据（最多 `FIRST_FRAME_MS`），等不到就是 `no-frames`。
   *
   * 语义与 `proxyStream` 完全一致：未配置 → 503、连不上 → 502(unreachable)、
   * 连上了但没帧 → 502(no-frames)、出帧 → 200。
   */
  function streamProbe(channel, { firstFrameMs = 1500, timeoutMs = 4000 } = {}) {
    const path = STREAM_PATHS[channel];
    if (!path) return Promise.resolve({ channel, code: null, contentType: null, reason: "unknown-channel" });
    if (!config.configured) return Promise.resolve({ channel, code: 503, contentType: null, reason: "unconfigured" });
    const url = new URL(path, config.url);
    const getter = url.protocol === "https:" ? httpsGet : httpGet;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(firstFrameTimer);
        resolve({ channel, ...result });
      };
      let firstFrameTimer = setTimeout(() => {
        upstream.destroy();
        finish({ code: 502, contentType, reason: "no-frames" });
      }, firstFrameMs);
      let contentType = null;
      const upstream = getter(url, { headers: baseHeaders(), timeout: timeoutMs });
      upstream.on("timeout", () => {
        upstream.destroy();
        finish({ code: 502, contentType, reason: "timeout" });
      });
      upstream.on("response", (stream) => {
        contentType = String(stream.headers["content-type"] ?? "");
        if (stream.statusCode !== 200 || !contentType.startsWith("multipart/x-mixed-replace")) {
          stream.destroy();
          finish({ code: 502, contentType, reason: "not-multipart" });
          return;
        }
        stream.once("data", (chunk) => {
          stream.destroy();
          finish({ code: 200, contentType, reason: "frames", firstChunkBytes: chunk.length });
        });
        stream.on("error", () => finish({ code: 502, contentType, reason: "stream-error" }));
      });
      upstream.on("error", (error) => finish({ code: 502, contentType, reason: error?.code ?? "unreachable" }));
    });
  }

  /* ---------------- 生命周期 ---------------- */

  if (config.configured) {    connect();
    void refreshInfo().catch(() => {
      /* 小车还没起来时静默：状态 WS 的重连会给出最终结论 */
    });
  } else {
    logger.warn?.("[cart] 未配置小车地址（server/data/cart.json 或 MUMAI_CART_URL），建图巡航页按未接入显示");
  }

  return {
    snapshot,
    read,
    mapImage,
    savedMapImage,
    control,
    proxyStream,
    streamProbe,
    refreshInfo,
    status: () => ({
      configured: config.configured,
      canControl: config.canControl,
      link,
      ageMs: ageMs(),
      lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
      listeners: listeners.size,
      deviceId: info.deviceId,
      simulated: info.simulated,
    }),
    /** 平台自己的浏览器事件通道接进来；返回退订函数 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      disposed = true;
      clearInterval(quietTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        socket?.close();
      } catch {
        /* 关连接失败无所谓，进程要退了 */
      }
      socket = null;
    },
  };
}
