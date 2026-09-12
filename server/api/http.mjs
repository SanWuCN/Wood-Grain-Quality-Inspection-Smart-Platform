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
import { permissionsOf } from "../services/permissions.mjs";

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

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const ROUTES = [];
const route = (method, pattern, handler, { auth = true } = {}) => {
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
  ROUTES.push({ method, regex, keys, handler, auth });
};

export function createApi({ db, hub, staticRoot = null, logger = console }) {
  ensureAssetsRoot();

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

  route("GET", "/api/auth/me", async (ctx) => ({ actor: ctx.actor, allowedActions: ctx.actions }));

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
  });

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
        const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJsonBody(req);
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
    "access-control-allow-headers": "authorization, content-type, x-file-name",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "x-file-sha256",
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
