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
import { actorFromRequest, login } from "../services/auth.mjs";
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
import { parseJson } from "../storage/db.mjs";
import { proxyScreen, screenStatus } from "../services/capture-screen.mjs";
import { createSensorService } from "../services/sensortag.mjs";

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

export function createApi({ db, hub, bridge, devices = null, staticRoot = null, logger = console }) {
  ensureAssetsRoot();
  /*
    路由表是**每个 API 实例一份**，不是模块级。
    模块级的话，同一个进程里起第二个服务（测试、预检都会这么干）时，
    新请求会先命中上一个实例注册的处理器 —— 那些闭包指着上一个已经关掉的库，
    表现为「database is not open」，排查起来离现场很远。
  */
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
    return requireGateway().ingestEvents(ctx.body?.events, ctx.req);
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

  const requireSensorControl = (ctx) => {
    if (!allows(ctx.actor, "scan:capture") && !allows(ctx.actor, "console:admin")) throw new WorkflowError(403,"FORBIDDEN","此账号没有传感器采集权限");
  };
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
  route("GET", "/api/auth/me", async (ctx) => (
    ctx.actor
      ? { actor: ctx.actor, allowedActions: ctx.actions }
      : { actor: null, allowedActions: [] }
  ), { auth: false });

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
    const record = await saveStream(ctx.req, {
      name: String(name),
      mediaType: ctx.query.mediaType ?? mediaTypeFor(String(name)),
      sessionId: ctx.query.sessionId ?? DEFAULT_SESSION_ID,
      uploadedBy: ctx.actor,
      dir: ctx.query.dir ?? "uploads",
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

  route("GET", "/api/files/:id/download", async (ctx) => {
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
  });

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

  /* ---- 健康与预检（PRD §11 预检清单） ---- */

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
      } catch (error) {
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".sog": "application/octet-stream",
  ".glb": "model/gltf-binary",
};

async function serveStatic(req, res, root, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(root, `.${safe}`);
  if (!filePath.startsWith(resolve(root))) return false; // 目录穿越
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA 兜底：非资源请求一律回 index.html（HashRouter 下其实很少用到）
    if (extname(pathname)) return false;
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
