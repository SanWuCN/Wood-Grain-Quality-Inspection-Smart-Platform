/**
 * 共享服务 · 命令总线与状态机（PRD §7）
 *
 * 一次写操作的固定顺序：
 *   1. 幂等检查 —— 同一个 commandId 直接回放上次结果，不重复推事件
 *   2. 动作权限 —— 服务端权威校验（permissions.mjs）
 *   3. 前置状态 —— 读当前实体，按状态机判断这一步合不合法
 *   4. 事务 —— 写实体（revision +1）、写事件（seq +1）、登记 commandId
 *   5. 推送 —— 交给调用方广播给四端
 *
 * 「终态不可复活」是这一层的硬规则：任务进入 cancelled / succeeded / failed
 * 之后，任何延迟到达的推进事件都会被拒（409），这正是评审 F03 要的
 * 「取消后的任务不能复活」；地图保存只生成 MapVersion，不碰 Mission（F03 后半）。
 */

import { nowIso, parseJson } from "../storage/db.mjs";
import { checkAction } from "./permissions.mjs";
import { getFile, verifyFile } from "./assets.mjs";
import { DEFAULT_SCOPE } from "../domains/knowledge-contract.mjs";
import {
  applyKnowledgeConfig,
  currentServingVersion,
  deleteAsset,
  getAsset as getKnowledgeAsset,
  getConfig as getKnowledgeConfig,
  registerAsset,
  reviseAsset,
  setAssetInclusion,
  updateAssetMetadata,
} from "./knowledge-store.mjs";
import { activateVersion, cancelJob, createJob, getJobRow as getJob } from "./knowledge-jobs.mjs";
/* ------------------------------------------------------------------ *
 * 状态机定义
 * ------------------------------------------------------------------ */

/** 任务状态（PRD §7 统一口径），后三个是终态 */
export const TERMINAL_MISSION_STATES = ["succeeded", "failed", "cancelled"];

/** 配置流程：draft → validated → published → received → verified */
export const ENV_FLOW = ["draft", "validated", "published", "received", "verified"];

/** 产物流程：uploaded → checked → published → downloaded → verified */
export const ARTIFACT_FLOW = ["uploaded", "checked", "published", "downloaded", "verified"];

const MISSION_NEXT = {
  "mission.create": { from: ["none"], to: "queued" },
  // 实机控制必须收到车端 ack 才进入执行中（PRD §9.1）
  "mission.ack": { from: ["queued", "waiting_ack"], to: "running" },
  "mission.pause": { from: ["running"], to: "paused" },
  "mission.resume": { from: ["paused"], to: "running" },
  "mission.cancel": { from: ["queued", "waiting_ack", "running", "paused"], to: "cancelled" },
  "mission.complete": { from: ["running"], to: "succeeded" },
};

/* ------------------------------------------------------------------ *
 * 环境校验（PRD §3.1 硬规则；服务端与前端跑同一套判据）
 * ------------------------------------------------------------------ */

export function validateEnvironment(inputs) {
  const range = inputs.instrumentRange ?? { min: -20, max: 60, unit: "℃" };
  const checks = [
    {
      key: "humidity",
      label: "相对湿度 0 ≤ RH ≤ 100",
      ok: Number(inputs.relativeHumidityPct) >= 0 && Number(inputs.relativeHumidityPct) <= 100,
      field: "relativeHumidityPct",
      message: `当前 ${inputs.relativeHumidityPct}%（有效范围 0–100）`,
    },
    {
      key: "wind",
      label: "风速非负",
      ok: Number(inputs.windSpeedMs) >= 0,
      field: "windSpeedMs",
      message: `当前 ${inputs.windSpeedMs} m/s（仅作采集稳定性记录，不代入 HH）`,
    },
    {
      key: "temp",
      label: `温度在仪表量程 ${range.min}–${range.max} ${range.unit} 内`,
      ok: Number(inputs.airTempC) >= range.min && Number(inputs.airTempC) <= range.max,
      field: "airTempC",
      message: `当前 ${inputs.airTempC} ℃（量程 ${range.min}–${range.max}）`,
    },
    {
      key: "instrument",
      label: "仪表编号与测量位置已登记",
      ok: Boolean(inputs.instrumentId) && Boolean(inputs.position),
      field: "instrumentId",
      message: `${inputs.instrumentId || "未登记"} · ${inputs.position || "未登记"}`,
    },
  ];
  return { checks, ok: checks.every((item) => item.ok) };
}

/**
 * Hailwood-Horrobin（Simpson 式）平衡含水率估计。
 *
 * 只作环境先验：现场木柱未必已经平衡（知识库 method_env_compensation.md 的原话），
 * 所以这里返回的 EMC 必须与「实测含水率」分开显示，不能被当成检测结论。
 *
 * **分母写错过一次，会把结果算成负数**（26.4℃/78% 得 −15.2%）。
 * 原来的写法是 `(1 - kh) * (1 - kh + k1 * kh) - k1 * k2 * kh * kh`，
 * 展开后多出 `-2kh + kh²` 两项，`k1 * k2 * kh²` 在常见温湿度下会超过它，
 * 分母变负、第二项整体翻号 —— 平衡含水率不可能小于 0，页面上却照显不误。
 *
 * 正确形式（用木材学公认的两个参考点校过）：
 *
 *   EMC = (1800 / W) · [ Kh/(1 − Kh) + (K₁Kh + 2K₁K₂K²h²) / (1 + K₁Kh + K₁K₂K²h²) ]
 *
 *   20 ℃ / 65 % → 12.00 %（文献常引的基准点）
 *   26.4 ℃ / 78 % → 15.08 %
 *
 * T 用华氏度。改这里请重跑 npm run test:emc。
 */
export function estimateEmc(tempC, rhPct) {
  const tC = Number(tempC);
  const h = Number(rhPct) / 100;
  if (!Number.isFinite(tC) || !Number.isFinite(h) || h <= 0 || h >= 1) return null;
  const t = tC * 1.8 + 32;
  const k = 0.791 + 0.000463 * t - 0.000000844 * t * t;
  const k1 = 6.34 + 0.000775 * t - 0.0000935 * t * t;
  const k2 = 1.09 + 0.0284 * t - 0.0000904 * t * t;
  const w = 330 + 0.452 * t + 0.00415 * t * t;
  const kh = k * h;
  const k1kh = k1 * kh;
  const k1k2kh2 = k1 * k2 * kh * kh;
  const denom = 1 + k1kh + k1k2kh2;
  if (!Number.isFinite(denom) || denom === 0) return null;
  const emc = (1800 / w) * (kh / (1 - kh) + (k1kh + 2 * k1k2kh2) / denom);
  if (!Number.isFinite(emc)) return null;
  return Number(emc.toFixed(3));
}

/* ------------------------------------------------------------------ *
 * 存储读写
 * ------------------------------------------------------------------ */

function readEntity(db, sessionId, kind, id) {
  const row = db
    .prepare("SELECT id, revision, data, updated_at FROM entities WHERE session_id=? AND kind=? AND id=?")
    .get(sessionId, kind, id);
  if (!row) return null;
  return { id: row.id, revision: row.revision, data: parseJson(row.data, {}), updatedAt: row.updated_at };
}

function listKind(db, sessionId, kind) {
  return db
    .prepare("SELECT id, revision, data, updated_at FROM entities WHERE session_id=? AND kind=? ORDER BY updated_at DESC")
    .all(sessionId, kind)
    .map((row) => ({ id: row.id, revision: row.revision, data: parseJson(row.data, {}), updatedAt: row.updated_at }));
}

/** 写入实体并返回新的 revision */
function writeEntity(db, sessionId, kind, id, data) {
  const at = nowIso();
  const current = db
    .prepare("SELECT revision FROM entities WHERE session_id=? AND kind=? AND id=?")
    .get(sessionId, kind, id);
  const revision = (current?.revision ?? 0) + 1;
  db.prepare(
    `INSERT INTO entities (session_id, kind, id, revision, data, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT (session_id, kind, id) DO UPDATE SET revision=excluded.revision, data=excluded.data, updated_at=excluded.updated_at`,
  ).run(sessionId, kind, id, revision, JSON.stringify(data), at);
  return { id, revision, data, updatedAt: at };
}

/** 追加一条事件并推进 session.last_seq */
function emitEvent(db, sessionId, { type, entityKind = null, entityId = null, revision = null, actorId, payload = {} }) {
  const row = db.prepare("SELECT last_seq FROM sessions WHERE id=?").get(sessionId);
  const seq = (row?.last_seq ?? 0) + 1;
  const at = nowIso();
  db.prepare(
    `INSERT INTO events (session_id, seq, type, entity_kind, entity_id, revision, actor_id, payload, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, seq, type, entityKind, entityId, revision, actorId, JSON.stringify(payload), at);
  db.prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?").run(seq, at, sessionId);
  return { seq, type, entityKind, entityId, revision, actorId, payload, at };
}

/** 业务错误：带上 HTTP 状态与 PRD §12 的 code/message/fieldErrors/retryable */
export class WorkflowError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ *
 * 各动作的处理器
 * ------------------------------------------------------------------ */

/**
 * 每个处理器签名：(ctx, payload) => { entityKind, entity, events[], result }
 * ctx = { db, sessionId, actorId, entityId, expectedRevision }
 */
const HANDLERS = {
  /* ---- 环境配置：沈发布 → 饶接收（评审 F01） ---- */

  "environment.publish": (ctx, payload) => {
    const inputs = payload.inputs ?? {};
    const { checks, ok } = validateEnvironment(inputs);
    if (!ok) {
      const failed = checks.filter((item) => !item.ok);
      throw new WorkflowError(422, "VALIDATION_FAILED", "环境数据未通过校验，未生成配置版本", {
        fieldErrors: failed.map((item) => ({ field: item.field, message: item.message })),
        checks,
        retryable: true,
      });
    }

    const history = listKind(ctx.db, ctx.sessionId, "environment");
    // 版本号由已发布版本数推导，不由前端写死（评审 F10 的同一条原则）
    const version = `CFG-${String(history.length + 2).padStart(2, "0")}`;
    const data = {
      version,
      inputs,
      checks,
      emcPct: estimateEmc(inputs.airTempC, inputs.relativeHumidityPct),
      methodVersion: payload.methodVersion ?? "HH-2026.08 / v1.4",
      state: "published",
      publishedBy: ctx.actorId,
      publishedAt: nowIso(),
      ackBy: null,
      ackAt: null,
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "environment", version, data);
    return {
      entityKind: "environment",
      entity,
      result: { version, state: "published" },
      events: [{ type: "environment.published", payload: { version, publishedBy: ctx.actorId } }],
    };
  },

  "environment.receive": (ctx) => {
    const target = ctx.entityId ? readEntity(ctx.db, ctx.sessionId, "environment", ctx.entityId) : latestEnvironment(ctx);
    if (!target) throw new WorkflowError(404, "NOT_FOUND", "没有可接收的环境配置版本");
    if (target.data.state === "received" || target.data.state === "verified") {
      // 幂等：已经接收过就回放当前状态，不报错也不重复推事件
      return { entityKind: "environment", entity: target, result: { version: target.id, state: target.data.state }, events: [] };
    }
    if (target.data.state !== "published") {
      throw new WorkflowError(422, "BAD_STATE", `配置 ${target.id} 当前是 ${target.data.state}，不可接收`);
    }
    const entity = writeEntity(ctx.db, ctx.sessionId, "environment", target.id, {
      ...target.data,
      state: "received",
      ackBy: ctx.actorId,
      ackAt: nowIso(),
    });
    return {
      entityKind: "environment",
      entity,
      result: { version: target.id, state: "received", ackBy: ctx.actorId },
      events: [{ type: "environment.received", payload: { version: target.id, ackBy: ctx.actorId } }],
    };
  },

  /* ---- 巡检任务：终态不可复活（评审 F03） ---- */

  "mission.create": (ctx, payload) => {
    const id = payload.missionId ?? `MS-${Date.now().toString(36).toUpperCase()}`;
    const data = {
      id,
      robotId: payload.robotId ?? "DEMO-R01",
      mapVersion: payload.mapVersion ?? null,
      speedProfile: payload.speedProfile ?? "标准",
      state: "queued",
      waypoints: payload.waypoints ?? [],
      createdAt: nowIso(),
      endedAt: null,
      cancelReason: null,
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "mission", id, data);
    return {
      entityKind: "mission",
      entity,
      result: { missionId: id, state: "queued" },
      events: [{ type: "mission.created", payload: { missionId: id, mapVersion: data.mapVersion } }],
    };
  },

  "map.save": (ctx, payload) => {
    // 只生成地图版本，**不碰 Mission**（评审 F03：保存地图不能把任务改成已完成）
    const id = payload.mapVersionId ?? `MAP-${Date.now().toString(36).toUpperCase()}`;
    const entity = writeEntity(ctx.db, ctx.sessionId, "mapVersion", id, {
      id,
      label: payload.label ?? id,
      resolutionM: payload.resolutionM ?? 0.05,
      coveragePct: payload.coveragePct ?? 0,
      sizeText: payload.sizeText ?? "—",
      state: "已保存",
      savedBy: ctx.actorId,
      savedAt: nowIso(),
    });
    return {
      entityKind: "mapVersion",
      entity,
      result: { mapVersionId: id, state: "已保存" },
      events: [{ type: "map.saved", payload: { mapVersionId: id } }],
    };
  },

  /* ---- 场景版本：检查 → 发布（评审 F06） ---- */
  "scene.submit": (ctx, payload) => {
    const id = payload.sceneId ?? `SCN-${Date.now().toString(36).toUpperCase()}`;
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", id, {
      id,
      title: payload.title ?? id,
      round: payload.round ?? "本轮",
      assetId: payload.assetId ?? null,
      format: payload.format ?? "sog",
      componentAnchors: payload.componentAnchors ?? [],
      bookmarkIds: payload.bookmarkIds ?? [],
      checkResult: null,
      state: "待检查",
      submittedBy: ctx.actorId,
      submittedAt: nowIso(),
      publishedBy: null,
      publishedAt: null,
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: id, state: "待检查" },
      events: [{ type: "scene.submitted", payload: { sceneId: id } }],
    };
  },

  "scene.check": (ctx) => {
    const target = requireEntity(ctx, "scene");
    if (target.data.state === "已发布") {
      throw new WorkflowError(409, "ALREADY_PUBLISHED", `场景 ${target.id} 已发布，不能重新检查`);
    }
    // 检查项：锚点、书签、资源三者齐全才算通过
    const anchors = target.data.componentAnchors ?? [];
    const checks = [
      { key: "asset", label: "重建资源已登记", pass: Boolean(target.data.assetId), detail: target.data.assetId ?? "未登记" },
      { key: "anchors", label: "构件锚点已标定", pass: anchors.length > 0, detail: `${anchors.length} 个锚点` },
      { key: "bookmarks", label: "视角书签已建立", pass: (target.data.bookmarkIds ?? []).length > 0, detail: `${(target.data.bookmarkIds ?? []).length} 个书签` },
    ];
    const pass = checks.every((item) => item.pass);
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", target.id, {
      ...target.data,
      checkResult: { checks, pass, checkedBy: ctx.actorId, checkedAt: nowIso() },
      state: pass ? "已检查" : "待检查",
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: target.id, pass, state: entity.data.state },
      events: [{ type: "scene.checked", payload: { sceneId: target.id, pass } }],
    };
  },

  "scene.publish": (ctx) => {
    const target = requireEntity(ctx, "scene");
    if (target.data.state === "已发布") {
      return { entityKind: "scene", entity: target, result: { sceneId: target.id, state: "已发布" }, events: [] };
    }
    if (!target.data.checkResult?.pass) {
      throw new WorkflowError(422, "CHECK_REQUIRED", "场景尚未通过检查，不能发布");
    }
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", target.id, {
      ...target.data,
      state: "已发布",
      publishedBy: ctx.actorId,
      publishedAt: nowIso(),
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: target.id, state: "已发布" },
      events: [{ type: "scene.published", payload: { sceneId: target.id, assetId: target.data.assetId } }],
    };
  },

  /* ---- 交付产物：构建 → 发布 → 回验（评审 F02 / PRD §10.3） ---- */

  "artifact.build": (ctx, payload) => {
    const files = payload.files ?? [];
    if (!files.length) throw new WorkflowError(422, "NO_FILES", "没有文件，不能生成产物");
    const id = payload.artifactId ?? `ART-${Date.now().toString(36).toUpperCase()}`;
    const entity = writeEntity(ctx.db, ctx.sessionId, "artifact", id, {
      id,
      name: payload.name ?? `${id}.zip`,
      kind: payload.kind ?? "模型包",
      target: payload.target ?? "硬件侧端模型",
      modelVersion: payload.modelVersion ?? "DEMO-M02b",
      demoOnly: payload.demoOnly !== false,
      fromJob: payload.fromJob ?? null,
      // 真实文件：fileId 指向 files 表里的实际字节，下载走 /api/files/{id}/download
      files,
      state: "checked",
      builtBy: ctx.actorId,
      builtAt: nowIso(),
      publishedBy: null,
      publishedAt: null,
      receipts: [],
    });
    return {
      entityKind: "artifact",
      entity,
      result: { artifactId: id, state: "checked", files: files.length },
      events: [{ type: "artifact.built", payload: { artifactId: id, files: files.length } }],
    };
  },

  "artifact.publish": (ctx) => {
    const target = requireEntity(ctx, "artifact");
    if (target.data.state === "已发布") {
      return { entityKind: "artifact", entity: target, result: { artifactId: target.id, state: "已发布" }, events: [] };
    }
    const entity = writeEntity(ctx.db, ctx.sessionId, "artifact", target.id, {
      ...target.data,
      state: "已发布",
      publishedBy: ctx.actorId,
      publishedAt: nowIso(),
    });
    return {
      entityKind: "artifact",
      entity,
      result: { artifactId: target.id, state: "已发布" },
      events: [{ type: "artifact.published", payload: { artifactId: target.id, by: ctx.actorId } }],
    };
  },

  "artifact.receipt": (ctx, payload) => {
    const target = requireEntity(ctx, "artifact");
    if (target.data.state !== "已发布" && target.data.state !== "已下载") {
      throw new WorkflowError(422, "BAD_STATE", `产物 ${target.id} 尚未发布，不能回验`);
    }
    /*
     * 回验的口径（PRD §7：downloaded 只证明文件下载，verified 需要目标端提交版本和摘要）：
     *   - 产物在发布时登记的整包摘要 = 平台这一侧的权威值
     *   - 饶下载后自己重算摘要，把结果作为 verifiedHash 提交上来
     *   - 两者相等才算通过；同时服务端再读一遍磁盘字节复核，防止库里的摘要与文件已经不一致
     * 所以比较的是「提交值 vs 平台登记值」，不是两个都来自同一个请求字段。
     *
     * 磁盘复核在事务外先做完（见 PREPARE），这里只做纯计算 ——
     * 事务里不 await，避免两个请求交错时把 BEGIN/COMMIT 搅在一起。
     */
    const registered = target.data.sha256 ?? null;
    const submitted = payload.verifiedHash ?? null;
    const hashMatch = Boolean(registered) && Boolean(submitted) && registered === submitted;
    const disk = ctx.disk ?? null;
    const diskMatch = Boolean(disk?.match) && disk.actualSha256 === registered;
    const pass = hashMatch && diskMatch;

    const receipt = {
      at: nowIso(),
      actor: ctx.actorId,
      reportedVersion: payload.reportedVersion ?? null,
      verifiedHash: submitted,
      registeredSha256: registered,
      diskSha256: disk?.actualSha256 ?? null,
      deviceMode: payload.deviceMode ?? "demo",
      pass,
      note: !hashMatch
        ? "提交的摘要与平台登记值不一致，回验失败"
        : !diskMatch
          ? "平台侧磁盘字节与登记摘要不一致，回验失败"
          : "摘要一致，演示版本已更新",
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "artifact", target.id, {
      ...target.data,
      state: pass ? "已回验" : "已下载",
      receipts: [...(target.data.receipts ?? []), receipt],
    });
    return {
      entityKind: "artifact",
      entity,
      result: { artifactId: target.id, pass, state: entity.data.state, receipt },
      events: [{ type: "artifact.verified", payload: { artifactId: target.id, pass, actor: ctx.actorId } }],
    };
  },
};

/**
 * 事务外的异步准备。
 *
 * 只有「要读磁盘算摘要」的动作需要它：SQLite 的事务是同步的，
 * 不能在 BEGIN 与 COMMIT 之间 await，否则并发请求会把事务边界搅乱。
 */
const PREPARE = {
  "artifact.receipt": async (ctx) => {
    if (!ctx.entityId) return {};
    const target = readEntity(ctx.db, ctx.sessionId, "artifact", ctx.entityId);
    if (!target) return {};
    const entry = (target.data.files ?? []).find((item) => item.role === "整包");
    const file = entry ? getFile(ctx.db, entry.fileId) : null;
    return { disk: file ? await verifyFile(file) : null };
  },
};

/**
 * 记录一次下载。
 *
 * 由 /api/files/{id}/download 调用：下载本身要留下「谁在什么时候取走了」的记录，
 * 但**不能**推进到 verified —— 那要等饶把摘要提交回来（PRD §7 明确二者不能合并）。
 */
export function markArtifactDownloaded(db, { sessionId, fileId, actorId }) {
  const rows = db
    .prepare("SELECT id, revision, data FROM entities WHERE session_id=? AND kind='artifact'")
    .all(sessionId);
  for (const row of rows) {
    const data = parseJson(row.data, {});
    if (!(data.files ?? []).some((item) => item.fileId === fileId)) continue;
    if (data.state === "已回验") return null; // 已回验的产物不再回退
    const entity = writeEntity(db, sessionId, "artifact", row.id, {
      ...data,
      state: "已下载",
      downloadedBy: actorId,
      downloadedAt: nowIso(),
      downloadCount: (data.downloadCount ?? 0) + 1,
    });
    return { entityKind: "artifact", entity, artifactId: row.id };
  }
  return null;
}

/**
 * 任务状态迁移。
 *
 * 五个动作共用一段逻辑：目标状态取自 MISSION_NEXT，合法性由 assertMissionTransition
 * 在进处理器之前统一判定（终态一律 409）。这里只负责写实体、发事件。
 *
 * 注意 `mission.cancel` 与 `mission.pause` 的区别：暂停可恢复，取消是终态 ——
 * 评审 F03 的现象「取消后约 1.5 秒又变成执行中」在设计上就不可能发生，
 * 因为取消之后任何迁移都会被 assertMissionTransition 拦掉。
 */
function missionTransition(action) {
  return (ctx, payload) => {
    const target = requireEntity(ctx, "mission");
    const rule = MISSION_NEXT[action];
    const nextState = rule.to;
    const data = {
      ...target.data,
      state: nextState,
      ...(nextState === "cancelled"
        ? { endedAt: nowIso(), cancelReason: payload.reason ?? "操作员取消" }
        : {}),
      ...(nextState === "succeeded" ? { endedAt: nowIso() } : {}),
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "mission", target.id, data);
    const label = { running: "执行中", paused: "已暂停", cancelled: "已取消", succeeded: "已完成" }[nextState] ?? nextState;
    return {
      entityKind: "mission",
      entity,
      result: { missionId: target.id, state: nextState, from: target.data.state },
      events: [
        {
          type: `mission.${nextState}`,
          payload: { missionId: target.id, from: target.data.state, to: nextState, reason: payload.reason ?? null },
        },
      ],
      label,
    };
  };
}

for (const action of ["mission.ack", "mission.pause", "mission.resume", "mission.cancel", "mission.complete"]) {
  HANDLERS[action] = missionTransition(action);
}

/* ------------------------------------------------------------------ *
 * 数据与知识中心（PRD-数据与知识中心-v1.0 §12.4 命令表）
 *
 * 这些处理器都跑在 runCommand 的同一个事务里，所以它们**自己不开事务**，
 * 失败直接抛错让外层 ROLLBACK。知识域的实体写在专用表里（万级行），
 * 不能塞进 entities 表的 JSON 快照 —— 那样每次事件驱动的 refresh 都要搬几兆字节。
 *
 * 事件名统一 `knowledge.<动作>`，客户端收到后按 seq 拉同一快照，不做「总数 +1」。
 * ------------------------------------------------------------------ */

/** 知识域命令的公共上下文：会话、项目范围与当前服务版本 */
function knowledgeCtx(ctx) {
  const config = getKnowledgeConfig(ctx.db, ctx.sessionId);
  return {
    ...ctx,
    projectId: ctx.payload?.projectId ?? DEFAULT_SCOPE.id,
    servingVersion: currentServingVersion(ctx.db, ctx.sessionId),
    config,
  };
}

/** 把推理结果里的资产 DTO 读回来当命令结果（命令返回体必须与服务端真值一致） */
function assetOutcome(ctx, assetId) {
  const asset = getKnowledgeAsset(ctx.db, ctx.sessionId, assetId);
  if (!asset) throw new WorkflowError(500, "ASSET_LOST", `资产 ${assetId} 写入后读不回来`);
  return asset;
}

HANDLERS["asset.register"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  const payload = ctx.payload ?? {};
  const text = String(payload.text ?? "");
  if (!text.trim()) {
    /*
      没有正文时**必须**走「待补充内容」这条路，不能登记成「待更新」再让任务失败。
      但也要挡住「调用方以为传了正文、字段名写错」的情况：那种静默降级比报错更难查，
      所以要求调用方显式声明 `noContent: true` 才允许空正文登记。
    */
    if (payload.noContent !== true) {
      throw new WorkflowError(422, "CONTENT_REQUIRED", "登记资产必须提供 text，或显式声明 noContent: true 表示暂无提取文本");
    }
  }
  const result = registerAsset(ctx.db, ctx.sessionId, {
    type: payload.type ?? "document",
    title: payload.title,
    format: payload.format,
    text,
    businessCategories: payload.businessCategories,
    objectIds: payload.objectIds ?? [],
    primaryObjectId: payload.primaryObjectId ?? null,
    buildingId: payload.buildingId ?? null,
    zone: payload.zone ?? null,
    sourceSystem: payload.sourceSystem,
    sourceEntityId: payload.sourceEntityId,
    mainSource: payload.mainSource,
    owner: ctx.actorId,
    fileName: payload.fileName,
    fileId: payload.fileId ?? null,
    sha256: payload.sha256 ?? null,
    sizeBytes: payload.sizeBytes,
    summary: payload.summary,
    textMode: payload.textMode,
    locatorKind: payload.locatorKind,
    capturedAt: payload.capturedAt,
    extra: payload.extra ?? {},
  });
  const asset = assetOutcome(ctx, result.assetId);
  return {
    entityKind: "knowledgeAsset",
    entity: { id: asset.id, revision: asset.contentRevision, data: asset, updatedAt: asset.updatedAt },
    result: { ...result, needsIndex: result.indexState === "待更新" },
    events: [
      {
        type: "knowledge.asset.registered",
        payload: {
          assetId: result.assetId,
          indexState: result.indexState,
          availability: result.availability,
          // 内容就绪的资产直接进更新队列（PRD §10.1 流程的最后一步）
          enqueue: result.indexState === "待更新",
        },
      },
    ],
  };
};

HANDLERS["asset.revise"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  if (!ctx.entityId) throw new WorkflowError(422, "ASSET_REQUIRED", "内容替换必须指定资产");
  const payload = ctx.payload ?? {};
  const outcome = reviseAsset(ctx.db, ctx.sessionId, {
    assetId: ctx.entityId,
    text: payload.text,
    actorId: ctx.actorId,
    fileId: payload.fileId ?? null,
    sha256: payload.sha256 ?? null,
    sizeBytes: payload.sizeBytes,
    summary: payload.summary,
    textMode: payload.textMode,
    locatorKind: payload.locatorKind,
    label: payload.label,
  });
  if (!outcome.ok) {
    const status = outcome.code === "NOT_FOUND" ? 404 : 422;
    throw new WorkflowError(status, outcome.code, outcome.message, { retryable: false });
  }
  const asset = assetOutcome(ctx, ctx.entityId);
  return {
    entityKind: "knowledgeAsset",
    entity: { id: asset.id, revision: asset.contentRevision, data: asset, updatedAt: asset.updatedAt },
    result: { ...outcome, // 旧索引继续服务，新版发布后才原子替换（PRD §10.2）
      servingVersionUnchanged: ctx.servingVersion,
    },
    events: [{ type: "knowledge.asset.revised", payload: { assetId: ctx.entityId, revision: outcome.revision, previousRevision: outcome.previousRevision } }],
  };
};

HANDLERS["asset.updateMetadata"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  if (!ctx.entityId) throw new WorkflowError(422, "ASSET_REQUIRED", "元数据更新必须指定资产");
  const outcome = updateAssetMetadata(ctx.db, ctx.sessionId, {
    assetId: ctx.entityId,
    title: ctx.payload?.title,
    businessCategories: ctx.payload?.businessCategories,
    owner: ctx.payload?.owner,
  });
  if (!outcome.ok) throw new WorkflowError(404, outcome.code, outcome.message);
  const asset = assetOutcome(ctx, ctx.entityId);
  return {
    entityKind: "knowledgeAsset",
    entity: { id: asset.id, revision: asset.metadataRevision, data: asset, updatedAt: asset.updatedAt },
    result: { ...outcome, note: "仅名称 / 展示标签变化，不重建文本向量（PRD §9.2）" },
    events: [{ type: "knowledge.asset.metadataChanged", payload: { assetId: ctx.entityId, metadataRevision: outcome.metadataRevision } }],
  };
};

/** 纳入 / 移出索引：改的是纳入成员，不重建文本（PRD §9.2「纳入策略变化」） */
HANDLERS["asset.setInclusion"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  if (!ctx.entityId) throw new WorkflowError(422, "ASSET_REQUIRED", "纳入设置必须指定资产");
  const include = ctx.payload?.include !== false;
  const outcome = setAssetInclusion(ctx.db, ctx.sessionId, { assetId: ctx.entityId, include });
  if (!outcome.ok) throw new WorkflowError(404, outcome.code, outcome.message);
  const asset = assetOutcome(ctx, ctx.entityId);
  return {
    entityKind: "knowledgeAsset",
    entity: { id: asset.id, revision: asset.metadataRevision, data: asset, updatedAt: asset.updatedAt },
    result: outcome,
    events: [{ type: "knowledge.asset.inclusionChanged", payload: { assetId: ctx.entityId, include, indexState: outcome.indexState } }],
  };
};

HANDLERS["asset.delete"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  if (!ctx.entityId) throw new WorkflowError(422, "ASSET_REQUIRED", "删除必须指定资产");
  const outcome = deleteAsset(ctx.db, ctx.sessionId, { assetId: ctx.entityId });
  if (!outcome.ok) throw new WorkflowError(404, outcome.code, outcome.message);
  return {
    entityKind: "knowledgeAsset",
    entity: { id: ctx.entityId, revision: 0, data: { id: ctx.entityId, deletedAt: outcome.deletedAt }, updatedAt: outcome.deletedAt },
    result: { ...outcome, note: "检索已即时屏蔽，随后由清理任务发布新版本（PRD §9.2）" },
    events: [{ type: "knowledge.asset.deleted", payload: { assetId: ctx.entityId, chunksRemoved: outcome.chunksRemoved, servingVersion: outcome.servingVersion } }],
  };
};

/**
 * 启动一次索引更新。
 *
 * `scope` 决定范围：backlog（积压）/ errors（失败重试）/ changed（指定资产）/ all（全量重建）。
 * 任务由 runner 按 tick 推进，进度来自完成记录数（PRD §9.3）。
 */
function startKnowledgeJob(ctx, scope) {
  const payload = ctx.payload ?? {};
  const created = createJob(ctx.db, {
    sessionId: ctx.sessionId,
    actorId: ctx.actorId,
    scope,
    assetIds: payload.assetIds ?? (ctx.entityId ? [ctx.entityId] : []),
    projectId: ctx.projectId,
    triggerSource: payload.triggerSource ?? `${ctx.actorId} 手动`,
    kind: payload.kind ?? (scope === "all" ? "全量重建" : scope === "errors" ? "失败重试" : "增量更新"),
    baseVersion: ctx.servingVersion,
  });
  if (!created.job) {
    // 没有输入不是错误，但不能假装启动了一个任务（页面据 result.started 决定提示语）
    return {
      entityKind: "knowledgeJob",
      entity: null,
      result: { started: false, reason: created.reason, inputs: 0 },
      events: [],
    };
  }
  return {
    entityKind: "knowledgeJob",
    entity: { id: created.job.id, revision: 1, data: created.job, updatedAt: created.job.startedAt },
    result: { started: true, jobId: created.job.id, targetVersion: created.targetVersion, inputs: created.inputs.length, scope },
    events: [
      {
        type: "knowledge.job.started",
        payload: { jobId: created.job.id, scope, targetVersion: created.targetVersion, inputs: created.inputs.length, baseVersion: ctx.servingVersion },
      },
    ],
  };
}

HANDLERS["knowledge.sync"] = (rawCtx) => startKnowledgeJob(knowledgeCtx(rawCtx), rawCtx.payload?.scope ?? "backlog");
HANDLERS["knowledge.retry"] = (rawCtx) => startKnowledgeJob(knowledgeCtx(rawCtx), "errors");

HANDLERS["knowledge.cancel"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  const jobId = ctx.entityId ?? ctx.payload?.jobId;
  if (!jobId) throw new WorkflowError(422, "JOB_REQUIRED", "取消必须指定任务");
  const outcome = cancelJob(ctx.db, ctx.sessionId, jobId);
  if (!outcome.ok) {
    const status = outcome.code === "NOT_FOUND" ? 404 : 409;
    throw new WorkflowError(status, outcome.code, outcome.message, { retryable: false });
  }
  return {
    entityKind: "knowledgeJob",
    entity: { id: jobId, revision: 1, data: getJob(ctx.db, ctx.sessionId, jobId), updatedAt: nowIso() },
    result: outcome,
    events: [{ type: "knowledge.job.cancelled", payload: { jobId, status: outcome.status } }],
  };
};

/** 切换历史服务版本（PRD §9.4）：只切检索层，原始资产库不回滚 */
HANDLERS["knowledge.activateVersion"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  const version = ctx.payload?.version ?? ctx.entityId;
  if (!version) throw new WorkflowError(422, "VERSION_REQUIRED", "必须指定要切换到的索引版本");
  const outcome = activateVersion(ctx.db, ctx.sessionId, { version, actorId: ctx.actorId });
  if (!outcome.ok) {
    // 已经是当前版本属于「重复操作」而不是失败：返回原状态，不产生事件。
    // （界面按钮会因此保持禁用，不会弹一个没有意义的红色错误。）
    if (outcome.code === "ALREADY_SERVING") {
      return {
        entityKind: "knowledgeIndex",
        entity: { id: version, revision: 0, data: { id: version, servingVersion: version }, updatedAt: nowIso() },
        result: { ...outcome, unchanged: true },
        events: [],
      };
    }
    const status = outcome.code === "NOT_FOUND" ? 404 : 409;
    throw new WorkflowError(status, outcome.code, outcome.message, { retryable: false });
  }
  return {
    entityKind: "knowledgeIndex",
    entity: { id: version, revision: 1, data: { id: version, servingVersion: version }, updatedAt: nowIso() },
    result: outcome,
    events: [
      {
        type: "knowledge.index.activated",
        payload: { previousVersion: outcome.previous, servingVersion: version, effective: outcome.effective },
      },
    ],
  };
};

/**
 * 配置变更（PRD §5.4）：参数调整必须产生**新的配置版本**，不能偷偷改变旧索引。
 * 旧索引继续用它自己的 configRevision 服务，直到下一次重建。
 */
HANDLERS["knowledge.configure"] = (rawCtx) => {
  const ctx = knowledgeCtx(rawCtx);
  const payload = ctx.payload ?? {};
  const outcome = applyKnowledgeConfig(ctx.db, ctx.sessionId, {
    actorId: ctx.actorId,
    patch: payload,
  });
  if (!outcome.ok) throw new WorkflowError(422, outcome.code, outcome.message);
  return {
    entityKind: "knowledgeConfig",
    entity: { id: outcome.revision, revision: 1, data: outcome.config, updatedAt: nowIso() },
    result: outcome,
    events: [
      {
        type: "knowledge.config.created",
        payload: { configRevision: outcome.revision, previousRevision: outcome.previousRevision, autoSync: outcome.config.autoSync, rebuildRequired: outcome.rebuildRequired },
      },
    ],
  };
};

function requireEntity(ctx, kind) {
  const target = ctx.entityId ? readEntity(ctx.db, ctx.sessionId, kind, ctx.entityId) : null;
  if (!target) throw new WorkflowError(404, "NOT_FOUND", `找不到 ${kind} ${ctx.entityId ?? "(未指定)"}`);
  return target;
}

function latestEnvironment(ctx) {
  const list = listKind(ctx.db, ctx.sessionId, "environment");
  return list.length ? readEntity(ctx.db, ctx.sessionId, "environment", list[0].id) : null;
}

/* ------------------------------------------------------------------ *
 * 命令入口
 * ------------------------------------------------------------------ */

/**
 * 执行一条命令。
 *
 * 返回 `{ replayed, result, entity, events }`；`replayed: true` 表示这次是
 * 幂等回放，调用方**不要**再广播事件。
 */
export async function runCommand(db, { sessionId, actorId, action, entityId = null, expectedRevision = null, commandId, payload = {} }) {
  const denied = checkAction(actorId, action);
  if (denied) throw new WorkflowError(403, denied.code, denied.message, { retryable: false });

  if (commandId) {
    const seen = db
      .prepare("SELECT result FROM commands WHERE session_id=? AND command_id=?")
      .get(sessionId, commandId);
    if (seen) return { replayed: true, ...parseJson(seen.result, {}) };
  }

  const session = db.prepare("SELECT id, last_seq FROM sessions WHERE id=?").get(sessionId);
  if (!session) throw new WorkflowError(404, "NO_SESSION", `演示会话 ${sessionId} 不存在`);

  /*
    ctx 里必须带上 payload：处理器签名虽然也接收 payload 作为第二个参数，
    但知识域的那批处理器统一从 ctx 读（因为它们要在公共上下文里合并范围与配置）。
    早先忘了塞这一个字段，`asset.register` 的正文一直是空的，
    资产被静默登记成「待补充内容」——这正是 PRD §4.3 最不想看到的那种错。
  */
  const ctx = { db, sessionId, actorId, entityId, expectedRevision, payload };

  // 任务类动作先查状态机与 revision，再进处理器
  if (action.startsWith("mission.") && action !== "mission.create") {
    assertMissionTransition(ctx, action);
  }
  if (expectedRevision !== null && entityId && !action.startsWith("mission.")) {
    const row = db
      .prepare("SELECT revision FROM entities WHERE session_id=? AND id=? LIMIT 1")
      .get(sessionId, entityId);
    if (row && row.revision !== expectedRevision) {
      throw new WorkflowError(409, "REVISION_CONFLICT", "对象已被其他客户端更新，请刷新后重试", {
        retryable: true,
        currentRevision: row.revision,
      });
    }
  }

  const handler = HANDLERS[action];
  if (!handler) throw new WorkflowError(404, "NO_HANDLER", `动作 ${action} 还没有服务端实现`);

  // 事务外先做完需要异步的准备（例如读磁盘复核产物摘要）
  if (PREPARE[action]) Object.assign(ctx, await PREPARE[action](ctx, payload));

  db.exec("BEGIN");
  let outcome;
  try {
    outcome = handler(ctx, payload);
    const events = (outcome.events ?? []).map((event) =>
      emitEvent(db, sessionId, {
        ...event,
        entityKind: outcome.entityKind,
        entityId: outcome.entity?.id ?? null,
        revision: outcome.entity?.revision ?? null,
        actorId,
      }),
    );
    const result = {
      action,
      actorId,
      result: outcome.result ?? {},
      entityKind: outcome.entityKind,
      entity: outcome.entity,
      eventSeq: events.length ? events[events.length - 1].seq : session.last_seq,
    };
    if (commandId) {
      db.prepare("INSERT INTO commands (session_id, command_id, result, at) VALUES (?,?,?,?)").run(
        sessionId,
        commandId,
        JSON.stringify(result),
        nowIso(),
      );
    }
    db.exec("COMMIT");
    return { replayed: false, ...result, events };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 任务状态机：终态一律拒绝，返回 409（评审 F03 的服务端一半） */
function assertMissionTransition(ctx, action) {
  const rule = MISSION_NEXT[action];
  const current = ctx.entityId ? readEntity(ctx.db, ctx.sessionId, "mission", ctx.entityId) : null;
  if (!current) throw new WorkflowError(404, "NOT_FOUND", `找不到任务 ${ctx.entityId ?? "(未指定)"}`);
  const state = current.data.state;
  if (TERMINAL_MISSION_STATES.includes(state)) {
    throw new WorkflowError(409, "TERMINAL_STATE", `任务已是终态 ${state}，不再接受 ${action}`, {
      retryable: false,
      currentState: state,
    });
  }
  if (rule && !rule.from.includes(state)) {
    throw new WorkflowError(422, "BAD_STATE", `任务当前是 ${state}，不能执行 ${action}`, {
      retryable: false,
      currentState: state,
    });
  }
  if (ctx.expectedRevision !== null && current.revision !== ctx.expectedRevision) {
    throw new WorkflowError(409, "REVISION_CONFLICT", "任务已被其他客户端更新，请刷新后重试", {
      retryable: true,
      currentRevision: current.revision,
    });
  }
}
