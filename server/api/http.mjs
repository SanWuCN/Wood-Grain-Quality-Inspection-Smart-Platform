/**
 * 共享服务 · HTTP 接口（契约对齐 PRD §12）
 *
 * 路由风格保持 PRD 表格里的路径与语义；错误体统一 `{code, message, fieldErrors, retryable}`，
 * 状态码 409 = 版本冲突、422 = 输入或阶段错误、403 = 权限不足、404 = 对象缺失。
 *
 * 静态资源：构建后由本服务一起提供（PRD §5.3「前端构建后由统一服务提供」），
 * 开发阶段则只提供 /api 与 /ws，页面仍走 Vite。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import {
  ASSETS_ROOT,
  ensureAssetsRoot,
  getFile,
  mediaTypeFor,
  registerFile,
  saveStream,
  verifyFile,
} from "../services/assets.mjs";
import { WorkflowError, estimateEmc, markArtifactDownloaded, runCommand, validateEnvironment } from "../services/workflow.mjs";
import {
  DEFAULT_SESSION_ID,
  appendEvent,
  createSession,
  eventsSince,
  getSession,
  listSessions,
  snapshot,
} from "../services/session.mjs";
import { actorFromRequest, actorOf, login, verifyToken } from "../services/auth.mjs";
import { allows, permissionsOf } from "../services/permissions.mjs";
import { ensureArchive, formatSize } from "../fixtures/archive.mjs";
import {
  DEMO_STAGES,
  captureSnapshot,
  deleteSnapshot,
  diagnosticsBundle,
  getSnapshot,
  listSnapshots,
  restoreSnapshot,
} from "../services/rehearsal.mjs";
import { preflightDetail } from "../fixtures/preflight.mjs";
import { fixtureReport as knowledgeFixtureReport } from "../fixtures/knowledge-samples.mjs";
import {
  getConfig as getKnowledgeConfig,
  listConfigs,
  listIndexVersions,
  listJobItems,
  listJobs,
  getJob,
  queryAssets,
} from "../services/knowledge-store.mjs";
import { readAssetDetail, readGraph, readOverview, searchKnowledge } from "../services/knowledge-query.mjs";
import { ingestArchivedWorkOrder } from "../services/knowledge-ingest.mjs";
import { parseJson } from "../storage/db.mjs";
import { proxyScreen, screenStatus } from "../services/capture-screen.mjs";
import { CART_ACTIONS } from "../services/cart.mjs";
import { createPhotoSet } from "../services/photo-set.mjs";
import { createDeviceReadiness } from "../services/device-readiness.mjs";
import { createSensorService } from "../services/sensortag.mjs";
import { createPlatformResources } from "../services/platform-resources.service.mjs";
import { registerUploadRoutes } from "../services/uploads.mjs";
import { addressLabel, createWriteLog, normalizeClientAddress, usableAddresses } from "../services/collab.mjs";

/** 归档副本的补传 / 重选属于「交付摘要校验」的写入侧，与前端 archive:verify 同一个权限 */
function hasAssetPermission(actorId) {
  return allows(actorId, "archive:verify");
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res, error) {
  if (error instanceof WorkflowError) {
    return sendJson(res, error.status, {
      code: error.code,
      message: error.message,
      fieldErrors: error.extra.fieldErrors ?? [],
      retryable: error.extra.retryable ?? false,
      ...error.extra,
    });
  }
  // 未预期的异常：不把堆栈丢给浏览器，但要在服务端日志里留全
  console.error("[api] 未处理异常:", error);
  return sendJson(res, 500, { code: "INTERNAL", message: "服务内部错误", fieldErrors: [], retryable: true });
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new WorkflowError(413, "BODY_TOO_LARGE", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new WorkflowError(422, "BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 二进制直传（设备预览图）：不解析 JSON，原样收字节 */
function readRawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new WorkflowError(413, "BODY_TOO_LARGE", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export function createApi({ db, hub, bridge, devices = null, workOrders = null, uploads = null, cart = null, voiceProxy = null, staticRoot = null, knowledgeRunner = null, dbFile = null, logger = console }) {
  ensureAssetsRoot();
  /**
   * 多机协同的现场读数（用户 2026-09-18「平台同步有问题」）。
   *
   * 三个都在服务端算，页面只念：
   *   · `serverInfo` —— 这台服务器是谁（主机名 / 端口 / 库文件 / 启动时刻），
   *     用来回答"我这台连的是哪一台服务器"；
   *   · `addresses` —— 同事能打开哪些地址（含虚拟局域网那条，原来被过滤掉了）；
   *   · `writeLog` —— 最近谁从哪台机器写了什么（写请求级留痕，内存环形）。
   */
  const startedAt = new Date().toISOString();
  const writeLog = createWriteLog();
  /**
   * 数据在哪个库文件里：优先用启动参数，其次问 SQLite 自己（`location()` 对内存库回 null，
   * 那就如实写 `:memory:` —— 测试跑的是内存库，不该被误报成一个磁盘路径）。
   */
  const databaseFile = (() => {
    if (dbFile) return dbFile;
    try {
      if (typeof db?.location !== "function") return null;
      return db.location() ?? ":memory:";
    } catch {
      return null;
    }
  })();
  const serverInfo = (port) => ({
    hostname: hostname(),
    port: port ?? null,
    dbFile: databaseFile,
    startedAt,
    serverTime: new Date().toISOString(),
  });
  /*
    路由表是**每个 API 实例一份**，不是模块级。
    模块级的话，同一个进程里起第二个服务（测试、预检都会这么干）时，
    新请求会先命中上一个实例注册的处理器 —— 那些闭包指着上一个已经关掉的库，
    表现为「database is not open」，排查起来离现场很远。
  */
  /* 平台资源：采集 + 映射，进程内单例（所有浏览器共用一份快照） */
  const platform = createPlatformResources();
  /*
    照片处理批次的素材挂载（用户 2026-09-22 给的「处理」包）：
    1,312 张处理后影像 + 27 张已标注原片留在工作区磁盘上，按 /photos/* 只读映射出去
    —— 见 services/photo-set.mjs 的文件头（为什么不塞 public/）。
    读接口只要登录态：内网任何账号都能看这批素材。
  */
  const photoSet = createPhotoSet();
  /*
    设备链路自检（用户 2026-09-22 给的「设备接入交接包」）：
    把原包 `smoke-devices.sh` 的 5 节判据从**服务内部**算一遍 ——
    判据全部取自既有服务（小车的 status/streamProbe、网关的 hardwareView、屏幕状态），
    页面与自检脚本看到的是同一套结论，不另算一套。
  */
  const deviceReadiness = createDeviceReadiness({
    staticRoot,
    cart,
    gateway: devices,
    screen: { status: screenStatus },
    health: () => ({
      service: "mumai-shared",
      version: "1.0.0",
      sessions: listSessions(db).length,
      clients: hub.clientCount(),
      devices: devices ? devices.status() : null,
    }),
  });
  void platform.start().catch((error) => logger.warn?.("平台资源采集启动失败", error));

  const ROUTES = [];
  const route = (method, pattern, handler, { auth = true, rawBody = false } = {}) => {
    // pattern 里的 :name 段编译成正则，顺序敏感（先注册的先生效）
    const keys = [];
    const regex = new RegExp(
      `^${pattern
        .split("/")
        .map((segment) => {
          if (segment.startsWith(":")) {
            keys.push(segment.slice(1));
            return "([^/]+)";
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/")}$`,
    );
    ROUTES.push({ method, regex, keys, handler, auth, rawBody });
  };

  const sensors = createSensorService(db, hub);
  route("GET", "/api/capture/screen/status", () => screenStatus());
  route("GET", "/api/capture/screen/stream", ({ req, res }) => proxyScreen(req, res));

  /* ------------------------------------------------------------------ *
   * 小车（建图巡航页的唯一数据源）
   *
   * 页面**不直连小车**：控制令牌只留在服务端，跨源与 Origin 校验的问题
   * 也在这里解决（原因见 services/cart.mjs 的文件头）。这一组路由做的只是
   * 「鉴权 → 转发 → 把小车错误码翻成平台状态码」，不加工任何数值。
   *
   * 读接口只要登录态：运维和项目经理都要能看到车况；
   * 写接口按动作逐个校验权限（与小车的能力一一对应，见 CART_ACTIONS）。
   * ------------------------------------------------------------------ */

  const requireCart = () => {
    if (!cart) throw new WorkflowError(503, "NO_CART", "小车链路未启用");
    return cart;
  };
  /** 没配令牌时小车侧是只读的，写动作要给出可读的原因，而不是一个 502 */
  const requireCartAction = (ctx, action) => {
    const service = requireCart();
    const entry = CART_ACTIONS.get(action);
    if (!entry) throw new WorkflowError(404, "BAD_ACTION", "未知的小车控制动作");
    if (!allows(ctx.actor, entry.permission)) {
      throw new WorkflowError(403, "FORBIDDEN", `此账号没有「${entry.permission}」权限，不能执行该操作`);
    }
    return service;
  };
  /** 把小车服务的异常翻成平台的错误体（错误码原样保留，页面按码判断） */
  const cartFail = (error) => {
    throw new WorkflowError(error?.status ?? 502, error?.code ?? "CART_ERROR", error?.message ?? "小车操作失败");
  };

  /** 照片素材可用性与计数：页面据此决定"贴图"还是"提示素材未挂载" */
  route("GET", "/api/photo-set", () => photoSet.status());

  route("GET", "/api/cart/status", () => requireCart().snapshot());
  route("GET", "/api/cart/info", async () => ({ ok: true, info: await requireCart().refreshInfo(), status: requireCart().status() }));

  route("GET", "/api/cart/read/:channel", async (ctx) => {
    try {
      return await requireCart().read(ctx.params.channel);
    } catch (error) {
      return cartFail(error);
    }
  });

  /** 当前栅格地图 PNG。页面靠 revision 判断要不要重取（文档 §3） */
  route("GET", "/api/cart/map.png", async (ctx) => {
    try {
      const image = await requireCart().mapImage();
      ctx.res.writeHead(200, {
        "content-type": "image/png",
        "content-length": image.length,
        "cache-control": "no-store",
      });
      ctx.res.end(image);
      return null;
    } catch (error) {
      return cartFail(error);
    }
  }, { auth: false });

  /** 已保存地图的预览图 / Nav2 文件（PGM / YAML / 元数据）原样转发 */
  route("GET", "/api/cart/maps/:mapId/:file", async (ctx) => {
    try {
      const body = await requireCart().savedMapImage(ctx.params.mapId, ctx.params.file);
      const type =
        ctx.params.file.endsWith(".png")
          ? "image/png"
          : ctx.params.file.endsWith(".yaml")
            ? "text/yaml; charset=utf-8"
            : ctx.params.file.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "application/octet-stream";
      ctx.res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
      ctx.res.end(body);
      return null;
    } catch (error) {
      return cartFail(error);
    }
  }, { auth: false });

  /**
   * 两路 MJPEG（RViz 画面 / 摄像头）。未就绪的通道回 502，不伪造图像。
   *
   * 路径写成 `/stream/:channel`（不带扩展名）而不是 `/stream/:channel.mjpeg`：
   * 路由编译规则是把 `:name` 整段替换成 `([^/]+)`，点号是**段内字符**，
   * 于是 `/stream/:channel.mjpeg` 编译出来的参数名是 `channel.mjpeg`、
   * 取到 `params.channel` 永远是 undefined —— 页面拿到 404「未知的视频通道」，
   * 而小车那边画面是好的。URL 由页面唯一决定（`streamUrl()`），
   * 这里不靠扩展名判类型，所以直接去掉它，参数名就和代码里写的一致了。
   */
  route("GET", "/api/cart/stream/:channel", ({ req, res, params }) =>
    requireCart().proxyStream(params.channel, req, res), { auth: false });

  /**
   * 控制动作转发。
   *
   * 动作名放请求体而不是 URL 路径：控制动作是 `mapping/start`、`navigation/load`
   * 这种**带斜杠的两段名**，塞进路径段里会被 `:param` 截断（`[^/]+` 到斜杠就停），
   * 要支持就得放宽成一层通配匹配 —— 那等于把小车全部 `/api/*` 暴露成可转发面。
   * 白名单在服务端（`CART_ACTIONS`），页面怎么拼都只能打到那 14 个动作上。
   *
   * `X-Request-Id` 由页面生成并在重试时复用 —— 小车按它做幂等（文档 §1），
   * 平台这层不自己生成：生成一次就得缓存映射，反而把「重试的是不是同一件事」
   * 这件事从页面手里拿走了。
   */
  route("POST", "/api/cart/action", async (ctx) => {
    const action = String(ctx.body?.action ?? "");
    const service = requireCartAction(ctx, action);
    const args = { ...(ctx.body ?? {}) };
    delete args.action;
    const requestId = ctx.req.headers["x-request-id"] ?? null;
    try {
      const result = await service.control(action, args, requestId);
      return result ?? { ok: true };
    } catch (error) {
      return cartFail(error);
    }
  });

  /* ------------------------------------------------------------------ *
   * 手持终端（树莓派 / woodpulse）设备网关
   *
   * 两条使用方：
   *   · 终端（设备）—— 带 `X-Device-Token` 上行，`auth: false`，令牌在网关里校验；
   *   · 浏览器页面 —— 读硬件页数据、下发命令，走正常登录令牌。
   * 所以这些路由**不能**统一挂 auth:true 或 auth:false，逐个判断：
   * 设备上行只有令牌，页面读取只有登录态。
   * ------------------------------------------------------------------ */

  /** 页面读取设备数据：登录态即可；也接受该设备自己的令牌（联调时用 curl 方便） */
  const requireDeviceView = (ctx, deviceId) => {
    const actor = actorFromRequest(ctx.req);
    if (actor) return actor;
    const token = String(ctx.req.headers["x-device-token"] ?? "");
    if (devices && token && devices.tokenAllowed(deviceId, token)) return null;
    throw new WorkflowError(401, "UNAUTHORIZED", "未登录或设备令牌无效");
  };
  const requireGateway = () => {
    if (!devices) throw new WorkflowError(503, "NO_DEVICE_GATEWAY", "设备网关未启用");
    return devices;
  };

  route("POST", "/api/devices/register", async (ctx) => requireGateway().register(ctx.body, ctx.req), { auth: false });

  route("POST", "/api/device-events/batch", async (ctx) => {
    // 响应结构不能变：accepted / duplicated 是 messageId 数组，不是计数（文档 §3.5）
    const result = requireGateway().ingestEvents(ctx.body?.events, ctx.req);
    /*
      命令回执还要喂给工单域：设备「已接收 / 已应用 / 失败」是发包状态唯一能推进的来源。
      只把网关真正收下的（accepted）交给它 —— duplicated 说明这条回执早就处理过了，
      再推一次会把已经 executed 的包按旧回执重放（A18）。
    */
    if (workOrders && result?.accepted?.length) {
      const accepted = new Set(result.accepted);
      workOrders.consumeDeviceEvents(
        (ctx.body?.events ?? []).filter((event) => accepted.has(event?.messageId)),
      );
    }
    return result;
  }, { auth: false });

  route("GET", "/api/devices", async (ctx) => {
    const actor = actorFromRequest(ctx.req);
    const token = String(ctx.req.headers["x-device-token"] ?? "");
    if (!actor && !token) throw new WorkflowError(401, "UNAUTHORIZED", "未登录或设备令牌无效");
    const gateway = requireGateway();
    return { devices: gateway.devices(), status: gateway.status(), serverTime: new Date().toISOString() };
  }, { auth: false });

  route("POST", "/api/devices/:deviceId/hardware", async (ctx) =>
    requireGateway().ingestHardware(ctx.params.deviceId, ctx.body, ctx.req), { auth: false });

  route("GET", "/api/devices/:deviceId/hardware", async (ctx) => {
    requireDeviceView(ctx, ctx.params.deviceId);
    // 页面不需要更高频率（终端本来就是 2 秒一份），但读取本身是幂等的
    return requireGateway().hardwareView(ctx.params.deviceId);
  }, { auth: false });

  route("GET", "/api/devices/:deviceId/history", async (ctx) => {
    requireDeviceView(ctx, ctx.params.deviceId);
    return { deviceId: ctx.params.deviceId, samples: requireGateway().hardwareHistory(ctx.params.deviceId, ctx.query.limit) };
  }, { auth: false });

  route("GET", "/api/devices/:deviceId/events", async (ctx) => {
    requireDeviceView(ctx, ctx.params.deviceId);
    return { deviceId: ctx.params.deviceId, events: requireGateway().events(ctx.params.deviceId, ctx.query.limit) };
  }, { auth: false });

  route("POST", "/api/devices/:deviceId/commands", async (ctx) => {
    if (!allows(ctx.actor, "scan:capture") && !allows(ctx.actor, "console:admin")) {
      throw new WorkflowError(403, "FORBIDDEN", "此账号没有设备指令权限");
    }
    return requireGateway().issueCommand(ctx.params.deviceId, {
      type: ctx.body?.type ?? ctx.body?.action,
      args: ctx.body?.args ?? {},
      ttlMs: ctx.body?.ttlMs,
    });
  });

  /** 现场调参回写（文档 §6.1）：本机调参不经过平台下发，平台只做记录 */
  route("POST", "/api/configs/:configVersion/ack", async (ctx) =>
    requireGateway().configAck(ctx.params.configVersion, ctx.body, ctx.req), { auth: false });

  /** 低帧率预览图：二进制直传，不是归档图像（文档 §3.9） */
  route("POST", "/api/devices/:deviceId/preview", async (ctx) => {
    const gateway = requireGateway();
    const frame = await readRawBody(ctx.req, 2 * 1024 * 1024);
    return gateway.ingestPreview(ctx.params.deviceId, frame, ctx.req.headers["x-frame-index"]);
  }, { auth: false, rawBody: true });

  route("GET", "/api/devices/:deviceId/preview/latest", async (ctx) => {
    requireDeviceView(ctx, ctx.params.deviceId);
    const frame = requireGateway().latestPreview(ctx.params.deviceId);
    if (!frame) {
      // 没有预览帧时明确回 404，页面显示「等待设备推流」而不是裂图
      throw new WorkflowError(404, "NO_PREVIEW", "设备还没有推过预览帧");
    }
    const body = frame.jpeg;
    ctx.res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-frame-index": String(frame.index),
    });
    ctx.res.end(body);
    return null;
  }, { auth: false });

  /* ------------------------------------------------------------------ *
   * 工单指派与扫描仪下发（PRD-工单指派与扫描仪下发-v1.0）
   *
   * 与设备网关的关系：工单域自己管工单、指派、环境版本与下发记录；
   * 真正把命令推给设备仍然走 device-gateway，工单侧只拿回 commandId。
   * 所以这里的路由**都要求登录**，只有设备下载包那两条额外认设备令牌。
   * ------------------------------------------------------------------ */

  const requireOrders = () => {
    if (!workOrders) throw new WorkflowError(503, "NO_WORK_ORDERS", "工单域未启用");
    return workOrders;
  };

  /** 设备侧取包：认设备令牌；页面查看同一条包也走登录态 */
  const requireDeviceOrActor = (ctx, deviceId) => {
    if (actorFromRequest(ctx.req)) return;
    const token = String(ctx.req.headers["x-device-token"] ?? "");
    if (devices && token && devices.tokenAllowed(deviceId, token)) return;
    throw new WorkflowError(401, "UNAUTHORIZED", "未登录或设备令牌无效");
  };

  /** 快捷键触发：任何已登录业务账号都能触发，但触发权限**不等于**指派权（PRD §3.1） */
  route("POST", "/api/work-orders/trigger", async (ctx) => {
    const orders = requireOrders();
    const eventId = ctx.body?.eventId ?? ctx.body?.triggerEventId;
    const outcome = orders.trigger({ eventId, actorId: ctx.actor });
    const detail = orders.detailFor(outcome.order.id, ctx.actor);
    return {
      ok: true,
      created: outcome.created,
      orderNo: outcome.order.order_no,
      orderId: outcome.order.id,
      status: outcome.order.status,
      detail,
      capabilities: detail.capabilities,
    };
  });

  route("GET", "/api/work-orders", async (ctx) => {
    const orders = requireOrders();
    return {
      orders: orders.list({ filter: ctx.query.filter ?? "all", q: ctx.query.q ?? "" }),
      accounts: orders.accounts(),
      targets: orders.deviceTargets(),
    };
  });

  route("GET", "/api/work-orders/:orderId", async (ctx) => {
    const orders = requireOrders();
    return orders.detailFor(ctx.params.orderId, ctx.actor);
  });

  route("PUT", "/api/work-orders/:orderId/assignment", async (ctx) => {
    const orders = requireOrders();
    const outcome = orders.assign({
      orderId: ctx.params.orderId,
      actorId: ctx.actor,
      leaderAccountId: ctx.body?.leaderAccountId,
      members: ctx.body?.members ?? [],
      expectedRevision: ctx.body?.expectedRevision ?? null,
    });
    return { ok: true, ...outcome, detail: orders.detailFor(ctx.params.orderId, ctx.actor) };
  });

  route("POST", "/api/work-orders/:orderId/status", async (ctx) => {
    const orders = requireOrders();
    const order = orders.setStatus({
      orderId: ctx.params.orderId,
      actorId: ctx.actor,
      action: ctx.body?.action,
      expectedRevision: ctx.body?.expectedRevision ?? null,
    });
    const detail = orders.detailFor(ctx.params.orderId, ctx.actor);
    /*
      工单归档 → 当场登进知识库（用户 2026-09-19：「最后工单结束得能归档进去」）。
      记录文本由工单实体**现算**（services/knowledge-ingest.mjs），登记完建索引任务、
      交给 knowledgeRunner 推进 —— 与 /api/commands 同一条口径：命令只建任务。
      只有「归档」这一个动作写知识库，其余流程动作不碰它。

      登记失败**不回滚归档**：工单已经归档是既成事实，把它退回去比"知识库少一条记录"更糟。
      所以这里兜住异常、把原因回给页面与日志，归档结果照常返回。
    */
    let knowledge = null;
    if (order.status === "已归档") {
      try {
        knowledge = ingestArchivedWorkOrder(db, DEFAULT_SESSION_ID, {
          detail,
          actorId: ctx.actor,
          actorLabel: orders.displayLabel(ctx.actor),
        });
        if (knowledge.jobId && knowledgeRunner) knowledgeRunner.start(knowledge.jobId);
      } catch (cause) {
        knowledge = { error: String(cause?.message ?? cause) };
        logger.error?.(`[知识库] 工单 ${order.orderNo} 归档登记失败：${knowledge.error}`);
      }
    }
    return { ok: true, order, detail, knowledge };
  });

  route("PUT", "/api/work-orders/:orderId/environment-draft", async (ctx) => {
    const orders = requireOrders();
    const environment = orders.saveDraft({
      orderId: ctx.params.orderId,
      actorId: ctx.actor,
      body: ctx.body ?? {},
      expectedRevision: ctx.body?.expectedRevision ?? null,
    });
    return { ok: true, environment };
  });

  route("POST", "/api/work-orders/:orderId/environment/validate", async (ctx) => {
    const orders = requireOrders();
    const environment = orders.validateOrderEnvironment({
      orderId: ctx.params.orderId,
      actorId: ctx.actor,
      expectedRevision: ctx.body?.expectedRevision ?? null,
    });
    return { ok: true, environment };
  });

  route("POST", "/api/work-orders/:orderId/dispatches", async (ctx) => {
    const orders = requireOrders();
    const outcome = orders.dispatch({
      orderId: ctx.params.orderId,
      actorId: ctx.actor,
      deviceId: ctx.body?.deviceId,
      configVersion: ctx.body?.configVersion ?? null,
      expectedRevision: ctx.body?.expectedRevision ?? null,
      idempotencyKey: ctx.body?.idempotencyKey ?? null,
    });
    return { ok: true, ...outcome };
  });

  route("GET", "/api/work-orders/:orderId/dispatches", async (ctx) => {
    const orders = requireOrders();
    return { orderId: ctx.params.orderId, dispatches: orders.dispatches(ctx.params.orderId) };
  });

  /** 删除工单（项目经理）：级联清掉主体、指派、环境版本、下发记录与日志，不可恢复 */
  route("DELETE", "/api/work-orders/:orderId", async (ctx) => {
    const outcome = requireOrders().deleteOrder({ orderId: ctx.params.orderId, actorId: ctx.actor });
    return { ok: true, ...outcome };
  });

  /** 设备主动拉取：只返回明确下发给它、且仍然有效的包（PRD §9.1） */
  route("GET", "/api/devices/:deviceId/work-order-bundles/pending", async (ctx) => {
    requireDeviceOrActor(ctx, ctx.params.deviceId);
    return requireOrders().pendingBundles(ctx.params.deviceId);
  }, { auth: false });

  /**
   * 终端「从平台获取」环境记录（接口清单 §4.4）：返回本设备当前工单已校验的那份读数。
   * 只给能给的项，缺的项不出现 —— 终端对缺失项沿用当前值，不会被清零。
   */
  route("GET", "/api/devices/:deviceId/environment", async (ctx) => {
    requireDeviceOrActor(ctx, ctx.params.deviceId);
    return requireOrders().deviceEnvironment(ctx.params.deviceId);
  }, { auth: false });

  /**
   * 包下载：响应体就是被摘要固化下来的那份 UTF-8 JSON 字节。
   * 这里**不能**走框架的 JSON 序列化 —— 重新 stringify 一遍摘要就对不上了。
   */
  route("GET", "/api/work-order-bundles/:bundleId", async (ctx) => {
    const token = String(ctx.req.headers["x-device-token"] ?? "");
    const deviceId = String(ctx.req.headers["x-device-id"] ?? ctx.query.deviceId ?? "") || null;
    if (deviceId) requireDeviceOrActor(ctx, deviceId);
    else if (!actorFromRequest(ctx.req)) throw new WorkflowError(401, "UNAUTHORIZED", "未登录或设备令牌无效");
    const bundle = requireOrders().readBundle(ctx.params.bundleId, deviceId);
    const body = Buffer.from(bundle.text, "utf8");
    ctx.res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-bundle-sha256": bundle.sha256,
      "x-bundle-status": bundle.status,
    });
    ctx.res.end(body);
    return null;
  }, { auth: false });

  const requireSensorControl = (ctx) => {
    if (!allows(ctx.actor, "scan:capture") && !allows(ctx.actor, "console:admin")) throw new WorkflowError(403,"FORBIDDEN","此账号没有传感器采集权限");
  };

  /*
    交付平台批次 B（《交付平台-新增接口清单》§3）：文件分片上传三步 + 批次清单。
    路由在 uploads.mjs 里自带注册函数 —— 那边是终端契约的落点，改它不用动这张路由表。
  */
  registerUploadRoutes(route, { service: uploads });
  route("GET", "/api/sensors/bridge", async () => bridge.status());
  route("POST", "/api/sensors/gyro-calibrate", async (ctx) => {
    requireSensorControl(ctx);
    const session=requireSession(ctx.body.sessionId);
    return sensors.calibrateGyro(session.id,ctx.body.batchId,ctx.body.deviceId);
  });
  route("GET", "/api/sensors/calibration/:id", async (ctx) => ({ calibration:sensors.calibration(ctx.params.id) }));
  route("POST", "/api/sensors/calibration/:id", async (ctx) => {
    requireSensorControl(ctx);
    return { calibration:sensors.calibrate(ctx.params.id,ctx.body,ctx.actor) };
  });
  route("POST", "/api/sensors/scan", async (ctx) => { requireSensorControl(ctx); return bridge.scan(); });
  route("POST", "/api/sensors/connect", async (ctx) => {
    requireSensorControl(ctx);
    const session = requireSession(ctx.body.sessionId);
    return bridge.start({ ...ctx.body, sessionId: session.id },ctx.actor);
  });
  route("POST", "/api/sensors/disconnect", async (ctx) => { requireSensorControl(ctx); bridge.stop(); return bridge.status(); });

  route("POST", "/api/sensors/frames", async (ctx) => {
    if (!allows(ctx.actor, "scan:capture") && !allows(ctx.actor, "console:admin")) {
      throw new WorkflowError(403, "FORBIDDEN", "此账号没有传感器采集权限");
    }
    const session = requireSession(ctx.body.sessionId);
    return { frame: sensors.ingest(session.id, ctx.body) };
  });
  route("GET", "/api/sensors/latest", async (ctx) => {
    const session = requireSession(ctx.query.sessionId);
    return { frame: sensors.latest(session.id, ctx.query.batchId ?? "", ctx.query.deviceId ?? null), serverTime: Date.now() };
  });
  route("GET", "/api/sensors/history", async (ctx) => {
    const session = requireSession(ctx.query.sessionId);
    const after = Number(ctx.query.after ?? 0);
    const from = Number(ctx.query.from ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new WorkflowError(422,"BAD_CURSOR","无效的历史游标");
    if (!Number.isFinite(from) || from < 0) throw new WorkflowError(422,"BAD_TIME","无效的历史起始时间");
    return { frames: sensors.history(session.id,ctx.query.batchId ?? "",ctx.query.deviceId ?? null,after,from) };
  });

  const requireSession = (sessionId) => {
    const session = getSession(db, sessionId ?? DEFAULT_SESSION_ID);
    if (!session) throw new WorkflowError(404, "NO_SESSION", `演示会话 ${sessionId} 不存在`);
    return session;
  };

  /* ---- 认证 ---- */

  route("POST", "/api/auth/login", async (ctx) => {
    const result = login(ctx.body.account, ctx.body.password);
    if (!result.ok) throw new WorkflowError(result.status, result.code, result.message);
    return { token: result.token, actor: result.actor, allowedActions: result.allowedActions };
  }, { auth: false });

  /*
   * 「当前令牌是谁」——没有令牌或令牌过期都是**正常答案**，不是错误。
   *
   * 原来它和别的接口一样要求有效令牌，返回 401；而令牌是自校验的、密钥每次启动
   * 随机，所以服务一重启，浏览器里那个旧令牌就会换来一个 401，
   * Chrome 会把它记成一条 "Failed to load resource: 401"，验收里算 console error。
   * 客户端本来就会在这之后重新登录，所以这里直接回 `actor: null` 让流程安静走完。
   */
  route("GET", "/api/auth/me", async (ctx) => {
    /*
      `auth:false` 的路由**不会**被分发器预先解析 actor（那一步只在 `auth:true` 的分支里做），
      所以这里必须自己解析一次 —— 这个接口存在的意义就是回答"我现在的令牌是谁"。
      实测踩到过两件事：① 不自己解析时它对任何令牌都回 `actor: null`，于是前端每次
      `ensureSession()` / 设备轮询探测都以为令牌过期、白跑一次登录；② actor 的**形状**
      必须与 `/api/auth/login` 一致（`{id, login, name}`），给裸 id 会让前端拿到
      "有时是对象有时是字符串"，表现为端明细里账号变成"未登录"。
    */
    const accountId = actorFromRequest(ctx.req);
    return accountId
      ? { actor: actorOf(accountId), allowedActions: permissionsOf(accountId) }
      : { actor: null, allowedActions: [] };
  }, { auth: false });

  /* ---- 会话与快照 ---- */

  route("GET", "/api/sessions", async () => ({ sessions: listSessions(db), defaultSessionId: DEFAULT_SESSION_ID }));

  route("POST", "/api/sessions", async (ctx) => {
    const session = createSession(db, ctx.body.scenarioId ?? "chapter2", ctx.body.sessionId ?? null);
    hub.broadcast(session.id, { type: "session.created", payload: { sessionId: session.id } });
    return { session };
  });

  route("GET", "/api/sessions/:id/snapshot", async (ctx) => {
    const snap = snapshot(db, requireSession(ctx.params.id).id);
    return { ...snap, serverTime: new Date().toISOString() };
  });

  route("GET", "/api/events", async (ctx) => {
    const session = requireSession(ctx.query.sessionId);
    const afterSeq = Number(ctx.query.afterSeq ?? 0);
    return { sessionId: session.id, events: eventsSince(db, session.id, afterSeq), lastSeq: session.lastSeq };
  });

  /**
   * 内网协同：这个会话现在有几台端连着 + 同事该用哪个地址打开。
   *
   * ── 为什么要有这个接口（用户口径 2026-09-17「完善平台内网同步」）──────
   * 多机演示有两件事只在页面上问得出来、在命令行里问不出来：
   *   1. **「别人连上了没有」** —— 现场最常见的疑问。端数是服务端数的**真实连接数**
   *      （`hub.peerCount`，WebSocket 房间大小），不是前端估的；
   *   2. **「同事该打开哪个地址」** —— 内网 IP 换个网络就可能变，
   *      让用户去 `ipconfig` 里翻是最容易念错的一步。
   *
   * ── 地址要挑，不能把网卡全列出来（实测踩到）─────────────────────────
   * 这台机器上 IPv4 有八条，其中五条是**虚拟网卡**：VPN 隧道（198.18/26.x）、
   * 以太网 2 与 VirtualBox Host-Only（169.254 自动私有地址）、VMware VMnet1/8
   * （192.168.62/75）。全列出来用户根本不知道念哪一个。
   * 所以地址由 `services/collab.mjs` 的 `usableAddresses()` 统一挑（分类规则
   * 与单测都在那里），这里只负责把结果发出去；过滤结果为空时**如实返回空数组**，
   * 由页面说明"这一台没读到内网地址"，不拿一个可能是错的地址糊上去。
   *
   * ── 2026-09-18 补：把「同一个虚拟局域网里的同事」也算进来 ──────────────
   * 用户报「我这边添加工单，沈那边收不到」。原来只报私有网段的地址，
   * 而 Radmin 这类虚拟局域网给的是 26.x —— 远程同事能连的地址**一个都没列**，
   * 他只能自己去猜。现在分两类报：局域网（lan）与虚拟局域网（vpn），
   * 每条都带网卡名，页面照念即可；同时把每台端的**对端地址**也报出来，
   * 于是"他到底连上没有"从"猜"变成"看一眼列表"。
   */
  route("GET", "/api/sessions/:id/peers", async (ctx) => {
    const session = requireSession(ctx.params.id);
    const port = ctx.req?.socket?.localPort ?? null;
    const addresses = usableAddresses(networkInterfaces(), port);
    return {
      sessionId: session.id,
      /* 这个房间里的 WebSocket 连接数 = 现在开着页面的端数（含本机这一台） */
      peers: hub.peerCount(session.id),
      clients: hub.clientCount(),
      /** 老字段：只含局域网地址（页面与被引用的工装都还读它） */
      lanUrls: addresses.filter((item) => item.kind === "lan").map((item) => item.url),
      /**
       * 每台端的明细（对端地址 + 账号 + 当前页面 + 打开多久 + 最近动静）。
       * 「沈那边收不到」的第一句诊断就是在这里：列表里没有他那个地址，
       * 说明他那台压根没连到这台服务器。
       */
      ends: hub.ends(session.id),
      /** 服务器身份：页面据此显示"我连的是哪一台" */
      server: { ...serverInfo(port), addressCount: addresses.length, endsTotal: hub.allEnds().length },
      /** 可达地址（lan 在前、vpn 在后；第一条是推荐念的那条） */
      addresses,
      port,
      serverTime: new Date().toISOString(),
    };
  });

  /* ---- 命令总线（PRD §12 /api/commands） ---- */

  route("POST", "/api/commands", async (ctx) => {
    const body = ctx.body;
    if (!body.action) throw new WorkflowError(422, "NO_ACTION", "缺少 action");
    const sessionId = body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const outcome = await runCommand(db, {
      sessionId,
      actorId: ctx.actor,
      action: body.action,
      entityId: body.entityId ?? null,
      expectedRevision: body.expectedRevision ?? null,
      commandId: body.commandId ?? null,
      payload: body.payload ?? {},
    });
    // 幂等回放不再广播（PRD §7：重复 commandId 返回同一结果）
    if (!outcome.replayed && outcome.events?.length) {
      for (const event of outcome.events) hub.broadcast(sessionId, event);
    }
    // 启动索引更新：任务建立后交给调度器按 tick 推进阶段。
    // 命令在这里**只**负责建立任务，进度不由前端伪造，也不由命令同步跑完。
    if (outcome.result?.started && outcome.result.jobId && knowledgeRunner) {
      knowledgeRunner.start(outcome.result.jobId);
    }
    const snap = snapshot(db, sessionId);
    return {
      replayed: outcome.replayed,
      action: body.action,
      result: outcome.result,
      entityKind: outcome.entityKind,
      entity: outcome.entity,
      eventSeq: outcome.eventSeq,
      session: snap.session,
    };
  });

  /* ------------------------------------------------------------------ *
   * 数据与知识中心（PRD-数据与知识中心-v1.0 §12.4）
   *
   * 读取接口全部走这里，写操作仍走命令总线。原因写在 PRD §12.5：
   * 命令要有 commandId 幂等、revision 冲突检测与 seq 事件，知识域也不例外；
   * 而读取是万级行数据，不能塞进会话快照里每次事件都搬一遍。
   * ------------------------------------------------------------------ */

  /** 读取权限：knowledge:read；检索另外要 knowledge:search（PRD §13） */
  const requireKnowledgeRead = (ctx) => {
    if (!allows(ctx.actor, "knowledge:read") && !allows(ctx.actor, "console:admin")) {
      throw new WorkflowError(403, "FORBIDDEN", "此账号没有查看数据与知识中心的权限");
    }
    return ctx.query.sessionId ?? DEFAULT_SESSION_ID;
  };
  const withKnowledge = (handler) => async (ctx) => {
    const sessionId = ctx.query.sessionId ?? DEFAULT_SESSION_ID;
    requireKnowledgeRead(ctx);
    requireSession(sessionId);
    return handler(ctx, sessionId);
  };

  /*
    GET /api/knowledge/overview —— 总览快照（PRD §12.4）。
    两层数据的规模信息一并返回：metrics 带 total / materialized / scale，
    coverage 每行带 total / scale / scaleNote / materialized，
    availability 与 sources 数的是**全部**资产（各状态相加 = metrics.total）。
  */
  route("GET", "/api/knowledge/overview", withKnowledge(async (ctx, sessionId) =>
    readOverview(db, sessionId, { projectId: ctx.query.projectId ?? undefined }),
  ));

  /*
    GET /api/knowledge/assets —— 资产列表（PRD §5.3）。
    返回体是 queryAssets 的**原样**结构：items / hasMore / nextCursor + 两个总数。
    两个总数缺一不可：total 是平台规模（含只贡献计数的规模样本），
    materialized 是其中能点开明细的条数，界面要同时显示「共 N 项 · 其中 M 项可展开明细」。
  */
  route("GET", "/api/knowledge/assets", withKnowledge(async (ctx, sessionId) =>
    queryAssets(db, sessionId, {
      projectId: ctx.query.projectId ?? undefined,
      type: ctx.query.type ?? null,
      query: ctx.query.q ?? null,
      objectId: ctx.query.objectId ?? null,
      source: ctx.query.source ?? null,
      category: ctx.query.category ?? null,
      indexState: ctx.query.state ?? null,
      // 可用性是 PRD §9.1 的第一套状态，列表筛选必须支持它（否则界面上那个下拉框是摆设）
      availability: ctx.query.availability ?? null,
      timeFrom: ctx.query.from ?? null,
      timeTo: ctx.query.to ?? null,
      cursor: ctx.query.cursor ?? null,
      limit: ctx.query.limit ? Number(ctx.query.limit) : 50,
    }),
  ));

  route("GET", "/api/knowledge/assets/:id", withKnowledge(async (ctx, sessionId) => {
    const detail = readAssetDetail(db, sessionId, ctx.params.id);
    if (!detail) throw new WorkflowError(404, "NOT_FOUND", `找不到资产 ${ctx.params.id}`);
    return detail;
  }));

  route("GET", "/api/knowledge/graph", withKnowledge(async (ctx, sessionId) =>
    readGraph(db, sessionId, {
      projectId: ctx.query.projectId ?? undefined,
      view: ctx.query.view === "lineage" ? "lineage" : "business",
      focusId: ctx.query.focusId ?? null,
      depth: ctx.query.depth ? Number(ctx.query.depth) : 1,
      nodeBudget: ctx.query.nodeBudget ? Number(ctx.query.nodeBudget) : ctx.query.full === "1" ? 250 : 120,
      edgeBudget: ctx.query.edgeBudget ? Number(ctx.query.edgeBudget) : ctx.query.full === "1" ? 600 : 240,
    }),
  ));

  route("GET", "/api/knowledge/indexes", withKnowledge(async (ctx, sessionId) => {
    const overview = readOverview(db, sessionId, { projectId: ctx.query.projectId ?? undefined });
    return {
      servingVersion: overview.servingVersion,
      configRevision: overview.configRevision,
      adapterMode: overview.adapterMode,
      dimensionConfig: overview.dimensionConfig,
      status: overview.indexStatus,
      versions: listIndexVersions(db, sessionId),
      config: getKnowledgeConfig(db, sessionId),
      configs: listConfigs(db, sessionId),
      coverage: overview.coverage,
      chunksByType: overview.coverage.map((row) => ({ type: row.type, label: row.label, chunks: row.chunks })),
      vectorCount: overview.metrics.vectors,
    };
  }));

  route("GET", "/api/knowledge/jobs", withKnowledge(async (ctx, sessionId) => ({
    jobs: listJobs(db, sessionId, { status: ctx.query.status ?? null, limit: ctx.query.limit ? Number(ctx.query.limit) : 20 }),
  })));

  route("GET", "/api/knowledge/jobs/:id", withKnowledge(async (ctx, sessionId) => {
    const job = getJob(db, sessionId, ctx.params.id);
    if (!job) throw new WorkflowError(404, "NOT_FOUND", `找不到任务 ${ctx.params.id}`);
    return { job, items: listJobItems(db, sessionId, ctx.params.id) };
  }));

  /** 检索是**读**操作，但要单独的 knowledge:search 权限（PRD §13） */
  route("POST", "/api/knowledge/search", async (ctx) => {
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    if (!allows(ctx.actor, "knowledge:search") && !allows(ctx.actor, "console:admin")) {
      throw new WorkflowError(403, "FORBIDDEN", "此账号没有证据检索权限");
    }
    requireSession(sessionId);
    const query = String(ctx.body.query ?? "").trim();
    if (!query) throw new WorkflowError(422, "QUERY_REQUIRED", "请输入检索内容");
    return searchKnowledge(db, sessionId, {
      query,
      projectId: ctx.body.projectId ?? undefined,
      filters: ctx.body.filters ?? {},
      topK: ctx.body.topK ?? null,
      version: ctx.body.version ?? null,
    });
  });

  /** 夹具报告：数据说明抽屉用它说明「哪些是合成资料、附件缺多少」（PRD §11.2） */
  route("GET", "/api/knowledge/fixture", withKnowledge(async (ctx, sessionId) => {
    const report = knowledgeFixtureReport(db, sessionId);
    if (!report) throw new WorkflowError(404, "NO_FIXTURE", "当前会话没有安装演示夹具");
    return report;
  }));

  /* ---- 环境校验（PRD §12 /api/environments/validate） ---- */
  route("POST", "/api/environments/validate", async (ctx) => {
    const inputs = ctx.body.inputs ?? ctx.body;
    const { checks, ok } = validateEnvironment(inputs);
    return {
      ok,
      checks,
      fieldErrors: checks.filter((item) => !item.ok).map((item) => ({ field: item.field, message: item.message })),
      emcPct: ok ? estimateEmc(inputs.airTempC, inputs.relativeHumidityPct) : null,
      methodVersion: "HH-2026.08 / v1.4",
      note: "EMC 是环境先验，不是木柱内部实测含水率。",
    };
  });

  /* ---- 文件（真实字节） ---- */

  // rawBody：上传要自己 pipe 请求流，见分发处的说明
  route("POST", "/api/files", async (ctx) => {
    const name = ctx.query.name ?? ctx.req.headers["x-file-name"];
    if (!name) throw new WorkflowError(422, "NO_NAME", "缺少文件名（?name=）");
    /*
     * 场景模型目录只允许持 `scene:submit` 的角色写。
     *
     * 为什么在这里补：`POST /api/files` 是通用上传口，原来只校验登录态 ——
     * 也就是说任何登录账号都能往 `scenes/` 目录里写字节，只是没法把它绑到工单。
     * 需求是「只有全栈开发工程师可以上传模型」，所以字节这一层也要拦。
     */
    const dir = String(ctx.query.dir ?? "uploads");
    if (dir === "scenes" || dir === "artifacts") {
      const requiredAction = dir === "scenes" ? "scene:submit" : "package:deliver";
      const allowed = (permissionsOf(ctx.actor) ?? []).includes(requiredAction);
      if (!allowed) {
        const label = dir === "scenes" ? "场景成果提交" : "交付产物提交";
        throw new WorkflowError(403, "FORBIDDEN", `账号 ${ctx.actor} 无「${label}」权限，不能上传到 ${dir} 目录`);
      }
    }
    const record = await saveStream(ctx.req, {
      name: String(name),
      mediaType: ctx.query.mediaType ?? mediaTypeFor(String(name)),
      sessionId: ctx.query.sessionId ?? DEFAULT_SESSION_ID,
      uploadedBy: ctx.actor,
      dir,
    });
    registerFile(db, record);
    hub.broadcast(record.session_id, {
      type: "file.uploaded",
      payload: { fileId: record.id, name: record.name, size: record.size, sha256: record.sha256, by: ctx.actor },
    });
    return {
      fileId: record.id,
      name: record.name,
      size: record.size,
      sha256: record.sha256,
      mediaType: record.media_type,
    };
  }, { rawBody: true });

  route("GET", "/api/files/:id", async (ctx) => {
    const file = getFile(db, ctx.params.id);
    if (!file) throw new WorkflowError(404, "NOT_FOUND", "文件不存在");
    return {
      fileId: file.id,
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      mediaType: file.media_type,
      uploadedBy: file.uploaded_by,
      uploadedAt: file.uploaded_at,
    };
  });

  /** 重新读字节算摘要：归档校验（评审 F11）与产物回验都走这里 */
  route("GET", "/api/files/:id/verify", async (ctx) => {
    const file = getFile(db, ctx.params.id);
    if (!file) throw new WorkflowError(404, "NOT_FOUND", "文件不存在");
    return verifyFile(file);
  });

  /*
   * 允许用 `?token=` 而不是 Authorization 头访问。
   *
   * 为什么需要：高斯泼溅的模型文件是由 Three.js 的加载器（SplatMesh）直接请求的，
   * 它加不了自定义请求头 —— 孪生页传 `/api/files/:id/download` 就必然 401。
   * 令牌本身是自校验的，放查询串里不额外泄露（同一浏览器里 localStorage 也存着它）。
   * 只对**下载**放行，其它接口仍只认 Authorization 头。
   */
  route("GET", "/api/files/:id/download", async (ctx) => {
    /*
     * 令牌可以走 Authorization 头，也可以走 `?token=`：
     * 这一条路由的调用方里有 Three.js 的模型加载器（加不了自定义头），
     * 所以 `auth:false` 之后在这里自己校验，两种取法等价。
     */
    const queryToken = String(ctx.query.token ?? "");
    ctx.actor =
      actorFromRequest(ctx.req) ??
      (queryToken ? verifyToken(queryToken) : null) ??
      (() => {
        throw new WorkflowError(401, "UNAUTHORIZED", "未登录或令牌无效");
      })();
    const file = getFile(db, ctx.params.id);
    if (!file) throw new WorkflowError(404, "NOT_FOUND", "文件不存在");
    if (!existsSync(file.stored_path)) throw new WorkflowError(410, "GONE", "文件已不在磁盘上");
    /*
     * 「下载」本身要留痕，而且要真的落到产物记录上：
     * 评审 F02 的现象是「点击下载只增加一条取用记录，切页回来产物又变回待发布」——
     * 所以这里写的是同一个产物实体的状态（已发布 → 已下载），不是另记一张流水。
     * 仍然不推进到「已回验」：那要等饶把摘要提交回来（PRD §7）。
     */
    const sessionId = file.session_id ?? DEFAULT_SESSION_ID;
    const marked = markArtifactDownloaded(db, { sessionId, fileId: file.id, actorId: ctx.actor });
    const downloadEvent = {
      type: "file.downloaded",
      payload: { fileId: file.id, name: file.name, by: ctx.actor, artifactId: marked?.artifactId ?? null },
    };
    if (marked) {
      appendEvent(db, sessionId, {
        ...downloadEvent,
        entityKind: "artifact",
        entityId: marked.artifactId,
        revision: marked.entity.revision,
        actorId: ctx.actor,
      });
    }
    hub.broadcast(sessionId, { ...downloadEvent, actorId: ctx.actor });

    const stat = statSync(file.stored_path);
    ctx.res.writeHead(200, {
      "content-type": file.media_type,
      "content-length": stat.size,
      // RFC 5987：中文名要用 filename*，否则浏览器会把名字截断
      "content-disposition": `attachment; filename="${asciiFallback(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-file-sha256": file.sha256,
      ...corsHeaders(),
    });
    createReadStream(file.stored_path).pipe(ctx.res);
    return null; // 已经自己接管了响应
  }, { auth: false });

  /*
   * 模型文件专用下载地址：`/api/files/:id/model/:name`
   *
   * 为什么不复用 `/download`：Three.js 的加载器按**URL 里的扩展名**判断格式，
   * 而 `/download?token=…` 的路径里没有 `.sog`，Spark 会报 Unknown file type。
   * 这里把文件名拼回路径（`:name` 只用于取扩展名与下载名，不参与寻址），
   * 让 `…/model/gs.sog?token=…` 既能带令牌、又保留扩展名。
   */
  route("GET", "/api/files/:id/model/:name", async (ctx) => {
    const token = String(ctx.query.token ?? "");
    ctx.actor =
      actorFromRequest(ctx.req) ??
      (token ? verifyToken(token) : null) ??
      (() => {
        throw new WorkflowError(401, "UNAUTHORIZED", "未登录或令牌无效");
      })();
    const file = getFile(db, ctx.params.id);
    if (!file) throw new WorkflowError(404, "NOT_FOUND", "文件不存在");
    if (!existsSync(file.stored_path)) throw new WorkflowError(410, "GONE", "文件已不在磁盘上");
    ctx.res.writeHead(200, {
      "content-type": mediaTypeFor(file.name),
      "content-length": String(file.size),
      "content-disposition": `inline; filename="${asciiFallback(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-file-sha256": file.sha256,
      ...corsHeaders(),
    });
    createReadStream(file.stored_path).pipe(ctx.res);
    return null;
  }, { auth: false });

  /* ---- 投屏（PRD §7 / §10） ---- */

  route("POST", "/api/projection", async (ctx) => {
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const current = snapshot(db, sessionId).projection;
    const takingOver = ctx.body.hold === true || !current.holderId || current.holderId === ctx.actor;
    if (!takingOver) {
      throw new WorkflowError(409, "NOT_HOLDER", `当前投屏持有人是 ${current.holderId}，不能直接切换`, {
        retryable: false,
        holderId: current.holderId,
      });
    }
    const viewType = ctx.body.viewType ?? current.viewType;
    const focusIds = ctx.body.focusIds ?? current.focusIds;
    db.prepare(
      `INSERT INTO projection (session_id, holder_id, view_type, focus_ids, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (session_id) DO UPDATE SET holder_id=excluded.holder_id, view_type=excluded.view_type, focus_ids=excluded.focus_ids, updated_at=excluded.updated_at`,
    ).run(sessionId, ctx.actor, viewType, JSON.stringify(focusIds), new Date().toISOString());
    const event = {
      seq: (getSession(db, sessionId)?.lastSeq ?? 0) + 1,
      type: "projection.changed",
      entityKind: "projection",
      entityId: sessionId,
      actorId: ctx.actor,
      payload: { holderId: ctx.actor, viewType, focusIds },
      at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO events (session_id, seq, type, entity_kind, entity_id, revision, actor_id, payload, at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(sessionId, event.seq, event.type, event.entityKind, event.entityId, null, ctx.actor, JSON.stringify(event.payload), event.at);
    db.prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?").run(event.seq, event.at, sessionId);
    hub.broadcast(sessionId, event);
    return { holderId: ctx.actor, viewType, focusIds, eventSeq: event.seq };
  });

  /* ---- 归档完整性校验（PRD §12 / 评审 F11） ---- */

  /**
   * 逐项读**真实字节**重算摘要，再与清单登记值比。
   *
   * 这是 F11 的核心：原来前端拿种子里的 `actualSha256` 直接和 `declaredSha256` 比，
   * 相当于自己跟自己比 —— 换台机器、把文件删了、改坏了，结论都一样。
   * 现在服务端流式读文件算（`verifyFile` 边读边喂 hash），缺文件就是缺文件。
   */
  route("POST", "/api/archives/check", async (ctx) => {
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const only = Array.isArray(ctx.body.assetIds) && ctx.body.assetIds.length ? new Set(ctx.body.assetIds) : null;

    const rows = db
      .prepare("SELECT id, revision, data, updated_at FROM entities WHERE session_id=? AND kind='archiveItem' ORDER BY id")
      .all(sessionId)
      .map((row) => ({ id: row.id, revision: row.revision, data: parseJson(row.data, {}), updatedAt: row.updated_at }))
      .filter((row) => !only || only.has(row.id));

    const results = [];
    for (const row of rows) {
      const item = row.data;
      const file = item.fileId ? getFile(db, item.fileId) : null;
      const verified = file ? await verifyFile(file) : null;
      const computed = verified?.present ? verified.actualSha256 : null;
      const status = !file || !verified?.present ? "缺失" : computed === item.declaredSha256 ? "通过" : "摘要不一致";
      results.push({
        assetId: item.assetId,
        group: item.group,
        name: item.name,
        sizeText: item.sizeText,
        fileId: item.fileId ?? null,
        declaredSha256: item.declaredSha256,
        computedSha256: computed,
        bytes: verified?.size ?? 0,
        status,
      });
    }

    const missing = results.filter((row) => row.status === "缺失").length;
    const mismatch = results.filter((row) => row.status === "摘要不一致").length;
    return {
      executedAt: new Date().toISOString(),
      total: results.length,
      passed: results.length - missing - mismatch,
      missing,
      mismatch,
      rows: results,
      // 校验方式写在响应里，报告与界面都照着它讲，避免两处口径不一致
      method: "服务端流式读取文件字节重算 SHA-256，与清单登记摘要逐项比对",
    };
  });

  /**
   * 补传 / 重选副本。
   *
   * 缺失项补一个文件、摘要不符项重选一份副本，都会把该项的登记摘要更新为新文件
   * 的**真实摘要**，并记下是谁在什么时候修的。所以「修复后重新校验能全部通过」
   * 不是把结论改成通过，而是磁盘上的字节与登记值真的对上了。
   */
  route("POST", "/api/archives/repair", async (ctx) => {
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const assetId = ctx.body.assetId;
    const fileId = ctx.body.fileId;
    if (!assetId || !fileId) throw new WorkflowError(422, "MISSING_FIELDS", "需要 assetId 与 fileId");

    const row = db
      .prepare("SELECT revision, data FROM entities WHERE session_id=? AND kind='archiveItem' AND id=?")
      .get(sessionId, assetId);
    if (!row) throw new WorkflowError(404, "NOT_FOUND", `清单里没有 ${assetId}`);
    const file = getFile(db, fileId);
    if (!file) throw new WorkflowError(404, "NO_FILE", `文件 ${fileId} 不存在`);

    if (!hasAssetPermission(ctx.actor)) {
      throw new WorkflowError(403, "FORBIDDEN", "当前角色无归档校验权限，不能修改归档副本");
    }

    const data = {
      ...parseJson(row.data, {}),
      fileId: file.id,
      sizeText: formatSize(file.size),
      declaredSha256: file.sha256,
      present: true,
      repairedBy: ctx.actor,
      repairedAt: new Date().toISOString(),
    };
    db.prepare(
      "UPDATE entities SET revision=revision+1, data=?, updated_at=? WHERE session_id=? AND kind='archiveItem' AND id=?",
    ).run(JSON.stringify(data), new Date().toISOString(), sessionId, assetId);

    const event = appendEvent(db, sessionId, {
      type: "archive.repaired",
      entityKind: "archiveItem",
      entityId: assetId,
      revision: row.revision + 1,
      actorId: ctx.actor,
      payload: { assetId, name: file.name, sha256: file.sha256, size: file.size },
    });
    if (event) hub.broadcast(sessionId, event);

    return { assetId, fileId: file.id, name: file.name, sizeText: data.sizeText, sha256: file.sha256, repairedBy: ctx.actor };
  });

  /* ---- 排练控制台（PRD §11 / 评审 F12） ---- */

  /** 需要管理员权限：重建会话、回滚快照都会改整场状态，不该让任何角色随手点 */
  const requireAdmin = (actorId) => {
    if (!allows(actorId, "console:admin")) {
      throw new WorkflowError(403, "FORBIDDEN", "当前角色没有排练控制台权限");
    }
  };

  route("GET", "/api/console/overview", async (ctx) => {
    const sessionId = ctx.query.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    return {
      currentSessionId: sessionId,
      sessions: listSessions(db).map((session) => ({
        ...session,
        entityCount: db.prepare("SELECT COUNT(*) AS n FROM entities WHERE session_id=?").get(session.id)?.n ?? 0,
      })),
      stages: DEMO_STAGES,
      snapshots: listSnapshots(db, sessionId),
      preflight: preflightDetail(db, sessionId),
    };
  });

  /**
   * 新建一场演示会话。
   *
   * 评审 F12 要的是「新一轮隔离」：新 sessionId 之下，上一轮的批次、产物、回执
   * 一条都不会串进来（PRD §6）。种子会把开场实体重新播一遍，
   * 所以新会话是**从开场开始**的，不是接到当前进度上。
   */
  route("POST", "/api/console/sessions", async (ctx) => {
    requireAdmin(ctx.actor);
    const session = createSession(db, ctx.body.scenarioId ?? "chapter2", null);
    /*
     * 新会话也要有自己的归档清单与真实文件。
     * `createSession` 只播实体，归档那 24 个文件是启动时给默认会话补的 ——
     * 不在这里补一遍，新会话打开归档页会是空的（实测 6 个实体 vs 30 个）。
     */
    ensureArchive(db, session.id);
    const event = appendEvent(db, session.id, {
      type: "session.created",
      entityKind: "session",
      entityId: session.id,
      actorId: ctx.actor,
      payload: { scenarioId: session.scenarioId, by: ctx.actor },
    });
    if (event) hub.broadcast(session.id, event);
    return { session, entityCount: db.prepare("SELECT COUNT(*) AS n FROM entities WHERE session_id=?").get(session.id)?.n ?? 0 };
  });

  route("POST", "/api/console/snapshots", async (ctx) => {
    requireAdmin(ctx.actor);
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const snapshot = captureSnapshot(db, {
      sessionId,
      stage: ctx.body.stage ?? "P11",
      label: ctx.body.label,
      actorId: ctx.actor,
    });
    const event = appendEvent(db, sessionId, {
      type: "snapshot.captured",
      entityKind: "snapshot",
      entityId: snapshot.id,
      actorId: ctx.actor,
      payload: { stage: snapshot.stage, label: snapshot.label, entities: snapshot.entitySeq },
    });
    if (event) hub.broadcast(sessionId, event);
    return {
      id: snapshot.id,
      stage: snapshot.stage,
      label: snapshot.label,
      entityCount: snapshot.entitySeq,
      createdAt: snapshot.createdAt,
    };
  });

  route("POST", "/api/console/snapshots/restore", async (ctx) => {
    requireAdmin(ctx.actor);
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const snapshot = getSnapshot(db, sessionId, ctx.body.snapshotId);
    if (!snapshot) throw new WorkflowError(404, "NOT_FOUND", "快照不存在");
    const result = restoreSnapshot(db, sessionId, snapshot, ctx.actor);
    const event = appendEvent(db, sessionId, {
      type: "snapshot.restored",
      entityKind: "snapshot",
      entityId: snapshot.id,
      actorId: ctx.actor,
      payload: { stage: snapshot.stage, label: snapshot.label, restored: result.restored, by: ctx.actor },
    });
    if (event) hub.broadcast(sessionId, event);
    return { ...result, snapshotId: snapshot.id, label: snapshot.label };
  });

  route("POST", "/api/console/snapshots/delete", async (ctx) => {
    requireAdmin(ctx.actor);
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const removed = deleteSnapshot(db, sessionId, ctx.body.snapshotId);
    if (!removed) throw new WorkflowError(404, "NOT_FOUND", "快照不存在");
    return { removed: true, snapshotId: ctx.body.snapshotId };
  });

  /** 导出诊断包：会话 + 实体 + 快照 + 事件 + 预检，一份 JSON */
  route("GET", "/api/console/diagnostics", async (ctx) => {
    const sessionId = ctx.query.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    return diagnosticsBundle(db, sessionId, preflightDetail(db, sessionId));
  });

  /* ------------------------------------------------------------------ *
   * 多机协同现场排查（用户 2026-09-18「平台同步有问题」）
   *
   * 用户原话：「我这边添加工单，沈那边收不到；沈那边派发人员，我这边也同步不到。」
   * 两边都不动只有两种可能：**写的不是同一台服务器**，或者**有一台的实时通道断了**。
   * 原来这两件事在页面上都看不出来，只能靠猜。所以补两条读数：
   *
   *   ① 同步实测（`POST /api/console/sync-probe`）——
   *      走和工单事件**同一条路**：真写一条事件 → 广播 → 每台端收到后回执。
   *      结论是「M/N 台端在 x 秒内收到」；哪几台没回也列出来。
   *      这条能把"同步坏了"从一个感觉变成一句可证伪的话。
   *
   *   ② 写入来源（`GET /api/console/write-log`）——
   *      最近谁从哪台机器写了什么（写请求级留痕，内存环形，重启即清）。
   *      「沈说他派了人」这句话对不对，看这里有没有一条来自他那台机器的写入；
   *      没有就说明他的写入**根本没到这台服务器**，问题在网络/地址，不在数据。
   * ------------------------------------------------------------------ */

  route("POST", "/api/console/sync-probe", async (ctx) => {
    requireAdmin(ctx.actor);
    const sessionId = ctx.body.sessionId ?? DEFAULT_SESSION_ID;
    requireSession(sessionId);
    const address = normalizeClientAddress(ctx.req?.socket?.remoteAddress);
    const probeId = `probe-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    /* 先真写一条事件（持久化 + 进事件流），再按下发那一刻的端列表打开实测簿 */
    const event = appendEvent(db, sessionId, {
      type: "sync.probe",
      entityKind: "session",
      entityId: sessionId,
      actorId: ctx.actor,
      payload: { probeId, by: ctx.actor, from: address },
    });
    const probe = hub.openProbe(sessionId, { probeId, seq: event?.seq ?? null, from: { address, actorId: ctx.actor } });
    if (event) hub.broadcast(sessionId, event);
    return { ...probe, event };
  });

  route("GET", "/api/console/sync-probe/:id", async (ctx) => {
    requireAdmin(ctx.actor);
    const probe = hub.probeStatus(ctx.params.id);
    if (!probe) throw new WorkflowError(404, "NO_PROBE", "这次实测已过期（实测结论只保留两分钟）");
    return probe;
  });

  /** 最近一次实测：页面刷新后仍能念出上一次的结论 */
  route("GET", "/api/console/sync-probe", async (ctx) => {
    requireAdmin(ctx.actor);
    return { probe: hub.latestProbe() };
  });

  route("GET", "/api/console/write-log", async (ctx) => {
    requireAdmin(ctx.actor);
    const limit = Math.max(1, Math.min(Number(ctx.query.limit ?? 20) || 20, 200));
    return {
      entries: writeLog.list(limit),
      kept: writeLog.size(),
      server: serverInfo(ctx.req?.socket?.localPort ?? null),
      /* 现场对表用：这台服务器看到的每台端 */
      ends: hub.allEnds().map((end) => ({ ...end, addressLabel: addressLabel(end.address) })),
    };
  });

  /* ---- 平台资源（总览「平台数据」与资源弹窗的唯一数据源，PRD §10.2） ---- */

  /*
   * 只读、不需要权限：这一屏是给大屏看的资源占用，前端每 2 秒轮询一次，
   * 落在权限校验后面只会白跑一趟鉴权。
   *
   * 夹具只允许在开发环境用（`?fixture=f1`）：验收要拿 F1–F4 验算映射公式，
   * 但夹具是**假输入**，生产构建里必须忽略，不能让夹具冒充真实采集。
   */
  const fixtureAllowed = process.env.NODE_ENV !== "production" || process.env.MUMAI_ALLOW_FIXTURE === "1";
  route(
    "GET",
    "/api/platform/resources",
    async (ctx) => platform.snapshot(fixtureAllowed ? ctx.query.fixture ?? null : null),
    { auth: false },
  );
  route(
    "GET",
    "/api/platform/resources/history",
    async (ctx) => platform.history(Number(ctx.query.windowSec ?? 60)),
    { auth: false },
  );

  /* ---- 健康与预检（PRD §11 预检清单） ---- */

  /** 设备链路自检：5 节结论 + 三份本地配置的落盘状态（读接口只要登录态） */
  route("GET", "/api/device-readiness", () => deviceReadiness.snapshot());

  route("GET", "/api/health", async () => {
    const packDir = join(ASSETS_ROOT, "demo-package");
    return {
      ok: true,
      service: "mumai-shared",
      version: "1.0.0",
      time: new Date().toISOString(),
      sessions: listSessions(db).length,
      assetsRoot: ASSETS_ROOT,
      assetsReady: existsSync(packDir),
      clients: hub.clientCount(),
      // 设备网关那一路的状态：终端能不能连上、有几台在线（诊断「平台离线」看这里）
      devices: devices ? devices.status() : null,
    };
  }, { auth: false });

  /* ------------------------------------------------------------------ *
   * 分发
   * ------------------------------------------------------------------ */

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    /*
      语音通道 `/voice-api/*`：**必须在静态兜底之前**转给本机语音桥接层。
      放在静态之后的话，桥接层不可用时会被 SPA 兜底回一张 HTML ——
      前端把 HTML 当 JSON 解析，报出 "Unexpected token <" 这种与真因无关的错
      （`voice-proxy.mjs` 里如实回 502 + JSON 就是为了避免这个）。
    */
    if (voiceProxy && voiceProxy.handleHttp(req, res)) return;

    /*
      素材挂载要排在静态兜底**之前**：排在后面的话，素材缺失时会被 SPA 兜底
      回一张 HTML，前端把 HTML 当图片解码，报出来的是"图挂了"而不是"文件不在"。
    */
    if (photoSet.serve(req, res, pathname)) return;

    // 静态资源：生产构建后由本服务提供（开发阶段 staticRoot 为 null）
    if (!pathname.startsWith("/api/")) {
      if (staticRoot && (await serveStatic(req, res, staticRoot, pathname))) return;
    }

    for (const entry of ROUTES) {
      if (entry.method !== req.method) continue;
      const match = entry.regex.exec(pathname);
      if (!match) continue;

      const params = {};
      entry.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });
      const query = Object.fromEntries(url.searchParams.entries());

      // OPTIONS 预检：开发阶段 Vite 与页面同源，但保留以便将来分离部署
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      let actor = null;
      if (entry.auth) {
        actor = actorFromRequest(req);
        if (!actor) {
          sendJson(res, 401, { code: "UNAUTHORIZED", message: "未登录或令牌无效", fieldErrors: [], retryable: false });
          return;
        }
      }

      /*
        写请求留痕（用户 2026-09-18「沈那边派发人员，我这边也同步不到」）。
        只记写请求、只记服务端能确证的事实（方法 / 路径 / 账号 / **TCP 对端地址** /
        状态码 / 耗时），放在这里是因为**所有写都必须经过这个循环** ——
        在每条路由里各记一次，迟早漏掉一条，而漏掉的那条正是要排查的那条。
      */
      const mutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
      const writeStartedAt = Date.now();
      const recordWrite = (status, body) => {
        if (!mutating) return;
        writeLog.record({
          method: req.method,
          path: pathname,
          action: typeof body?.action === "string" ? body.action : null,
          actorId: actor ?? null,
          address: req.socket?.remoteAddress,
          status,
          durationMs: Date.now() - writeStartedAt,
        });
      };

      try {
        /*
         * 上传接口要自己消费 `req` 这个流（边写盘边算摘要），
         * 所以标了 rawBody 的路由**不能**在这里先把请求体当 JSON 读掉 ——
         * 读掉之后处理器再读就是一个已经结束的流，表现为上传永远 0 字节，
         * 而请求体解析又会先把二进制当成坏 JSON 拒掉（BAD_JSON）。
         */
        const body =
          entry.rawBody || req.method === "GET" || req.method === "HEAD" ? {} : await readJsonBody(req);
        const result = await entry.handler({
          req,
          res,
          params,
          query,
          body,
          actor,
          actions: actor ? permissionsOf(actor) : [],
        });
        if (result !== null && !res.writableEnded) {
          res.writeHead(200, { ...JSON_HEADERS, ...corsHeaders() });
          res.end(JSON.stringify(result));
        }
        recordWrite(res.statusCode ?? 200, body);
      } catch (error) {
        recordWrite(error instanceof WorkflowError ? error.status : 500, null);
        if (!res.writableEnded) sendError(res, error);
        else logger.error?.("[api] 响应已开始，无法回写错误:", error?.message);
      }
      return;
    }

    sendJson(res, 404, { code: "NO_ROUTE", message: `没有这个接口：${req.method} ${pathname}`, fieldErrors: [], retryable: false });
  };
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    // 设备侧会带 X-Device-Token / X-Device-Id / X-Frame-Index（终端文档 §3）
    "access-control-allow-headers": "authorization, content-type, x-file-name, x-device-token, x-device-id, x-frame-index",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-expose-headers": "x-file-sha256, x-frame-index",
  };
}

/** Content-Disposition 的 ASCII 回退名：非 ASCII 一律换成下划线 */
function asciiFallback(name) {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".sog": "application/octet-stream",
  ".glb": "model/gltf-binary",
  /* PDF 给正确类型：浏览器才**内嵌预览**而不是下载一个 .bin（数字孪生里的成果质量报告用它） */
  ".pdf": "application/pdf",
};

async function serveStatic(req, res, root, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  /*
    ⚠ 静态路径**必须先解码**（2026-10-02 实测踩到）：
    `url.pathname` 是**百分号编码**的，而仓库里有中文名的静态素材
    （`public/reports/成果质量报告-….pdf`、照片批次的对照表），
    不解码就是拿 `%E6%88%90…` 去磁盘上找文件 —— 必然 404，
    而且这条路径在 SPA 兜底之前，浏览器那边只看到"文件不存在"。
    `decodeURIComponent` 对非法编码会抛，所以兜一层：抛了就用原串（宁可 404，不要 500）。
  */
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* 非法百分号编码：按原样处理 */
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(root, `.${safe}`);
  if (!filePath.startsWith(resolve(root))) return false; // 目录穿越
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA 兜底：非资源请求一律回 index.html（HashRouter 下其实很少用到）
    if (extname(decoded)) return false;
    filePath = join(root, "index.html");
    if (!existsSync(filePath)) return false;
  }
  const stat = statSync(filePath);
  res.writeHead(200, {
    "content-type": STATIC_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    createReadStream(filePath).pipe(res);
  }
  return true;
}
