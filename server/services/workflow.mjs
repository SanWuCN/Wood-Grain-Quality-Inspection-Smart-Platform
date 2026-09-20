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
 * 场景「机位关键帧」（用户 2026-09-17 口径）
 *
 * 用户原话：「数字孪生那要加个操作点，添加打关键帧的功能，我把视角拉近木柱，
 * 然后可以打上关键帧」；并明确「所有服务都要让别人也能用」—— 所以帧存在**服务端**，
 * 内网任何一台机器、任何一个账号看到的是同一份，不是各存各的。
 *
 * 三条口径，改之前先看：
 *   1. **不改发布状态**：关键帧是给场景加"视角标注"，不是新版本。打一帧就把 `state`
 *      打回「待检查」的话，演示里刚发布的场景会因为讲解人随手标个机位而失效；
 *   2. **同步进 `bookmarkIds`**：`scene.check` 的「视角书签已建立」看的就是它 ——
 *      不同步会出现"页面里明明打了帧，检查还说没有书签"；
 *   3. **可追溯**：记谁打的、什么时候打的；删帧也一样，事件流留痕。
 * ------------------------------------------------------------------ */

/** 机位需要落库的四个量：水平角 / 极角 / 距离 / 看向的点 */
const KEYFRAME_POSE_FIELDS = ["azimuth", "polar", "distance"];

/**
 * 严格取数：**只有真正是数字**（或非空数字字符串）才算数。
 *
 * ⚠ 不能直接 `Number(value)`：`Number(null)` 是 **0**，`Number("")` 也是 0 ——
 * 前端漏传一个字段（JSON 里就是 `null`）会被悄悄当成"方位角 0°"存下来，
 * 别人打开场景时镜头停在一个"看起来正常但根本不是他标的机位"上。所以 null / 空串 / 布尔
 * 一律按"没给"处理，由调用方拒收。
 */
function poseNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 校验并规范化一个机位。
 *
 * 相机姿态是**渲染层读出来的浮点数**，可能带 NaN/Infinity（画布尺寸为 0、
 * 模型还没 fit 完就按了按钮）。这些东西一旦写进实体，别人打开这个场景时
 * 镜头会飞到"不存在的位置"，而页面不会报错 —— 所以这里当场拒掉，宁可 422。
 */
export function normalizeKeyframePose(input) {
  const pose = input && typeof input === "object" ? input : {};
  const out = {};
  for (const field of KEYFRAME_POSE_FIELDS) {
    const value = poseNumber(pose[field]);
    if (value === null) {
      throw new WorkflowError(422, "BAD_POSE", `机位的 ${field} 不是有限数字（收到 ${String(pose[field])}）`);
    }
    out[field] = Number(value.toFixed(4));
  }
  /* 距离必须为正：0 或负数会让相机落在模型里（画面全黑，看起来像坏了） */
  if (out.distance <= 0) {
    throw new WorkflowError(422, "BAD_POSE", `机位距离必须大于 0（收到 ${out.distance}）`);
  }
  const focus = pose.focus && typeof pose.focus === "object" ? pose.focus : null;
  if (!focus || !["x", "y", "z"].every((axis) => poseNumber(focus[axis]) !== null)) {
    throw new WorkflowError(422, "BAD_POSE", "机位缺少看向的点（focus.x/y/z 必须是有限数字）");
  }
  out.focus = {
    x: Number(poseNumber(focus.x).toFixed(4)),
    y: Number(poseNumber(focus.y).toFixed(4)),
    z: Number(poseNumber(focus.z).toFixed(4)),
  };
  return out;
}

/**
 * 关键帧配图（用户 2026-09-18：「打关键帧右侧应该显示相应的图，然后我给他打标签 Z01」）。
 *
 * ── 图为什么不进实体 ──────────────────────────────────────────────
 * 一张 1070×621 的 JPEG 上百 KB，而场景快照是**每台端都收一遍**的：图塞进
 * `keyframes[]` 等于每次刷新都在内网重传所有帧的图。所以图走既有的文件库 ——
 * 前端打帧时先把截图 `POST /api/files`（`dir=keyframes`），帧里只存 `imageFileId`；
 * 右栏用**带令牌的内联地址**取字节（`/api/files/:id/model/:name?token=…`，
 * 与模型同一条路由：`<img>` 同样加不了 Authorization 头）。
 *
 * ── 为什么必须校验 ────────────────────────────────────────────────
 * 不校验的话，任何已登记的 fileId 都能被挂成"机位画面"：挂一个 .sog 会让
 * 右栏出现一行乱码，挂一个几 MB 的 PNG 会让每次打开这一页都要下好几 MB。
 * 所以三条：文件必须在库里、必须是图片、体积有上限。
 */
const KEYFRAME_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

export function normalizeKeyframeImage(db, input) {
  const fileId = String(input ?? "").trim();
  if (!fileId) return null;
  const file = getFile(db, fileId);
  if (!file) {
    throw new WorkflowError(422, "NO_IMAGE_FILE", `关键帧配图 ${fileId} 不在文件库里（截图要先上传）`);
  }
  if (!String(file.media_type ?? "").startsWith("image/")) {
    throw new WorkflowError(422, "NOT_IMAGE", `关键帧配图 ${fileId} 不是图片（${file.media_type ?? "未知类型"}）`);
  }
  if (Number(file.size) > KEYFRAME_IMAGE_MAX_BYTES) {
    const mb = (Number(file.size) / 1024 / 1024).toFixed(1);
    throw new WorkflowError(422, "IMAGE_TOO_BIG", `关键帧配图 ${mb}MB 超过上限 ${KEYFRAME_IMAGE_MAX_BYTES / 1024 / 1024}MB`);
  }
  return { imageFileId: file.id, imageName: file.name };
}

/**
 * 下一个帧号：`KF-<构件>-NN`，**按构件各自编号**（Z04 的第 1 帧是 `KF-Z04-01`）。
 *
 * 为什么按构件分：现场说的就是"Z04 柱脚这个机位"，讲解与对照表都按构件找；
 * 全局流水号（KF-07）在台上没法一眼对上柱子。
 */
export function nextKeyframeId(frames, componentId) {
  const scope = (componentId ?? "SCENE").toUpperCase();
  const prefix = `KF-${scope}-`;
  const used = frames
    .map((item) => String(item.id ?? ""))
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number.parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isInteger(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${String(next).padStart(2, "0")}`;
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

  /**
   * 建任务。工单页的「下发自主巡航任务」走的就是这一条（用户 2026-09-18 口径：
   * 「在工单界面添加下发自主巡航任务功能……这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」）。
   *
   * ── 任务编号怎么来 ────────────────────────────────────────────────
   * `CR-<工单号里的日期段>-<两位流水>`：工单 `WO-20260918-0006` 的第 1 次自主巡航是
   * `CR-20260918-01`。日期段直接取自**工单号**而不是再问一次时钟：
   * 工单号里的日期已经是现场日期（上海时区，见 work-orders.mjs 的 shanghaiParts），
   * 再从时钟取一次"今天"就多了一个可能不一致的来源（跨零点、机器时区不同）。
   * 流水在事务里数（与工单号同一套做法），两次点击不会撞号。
   *
   * 与「巡检任务」原有的通用字段保持兼容：老的调用只传 robotId / mapVersion /
   * speedProfile，照样能用（任务号退化成时间戳式）。
   */
  "mission.create": (ctx, payload) => {
    const orderId = payload.orderId ?? null;
    const orderNo = payload.orderNo ?? null;
    if (orderId && !orderNo) {
      throw new WorkflowError(422, "NO_ORDER_NO", "下发自主巡航任务要带工单号：任务编号按工单号生成");
    }
    const id = payload.missionId ?? nextCruiseTaskNo(ctx, orderNo);
    const laps = Number(payload.laps);
    const speedMps = Number(payload.speedMps);
    const data = {
      id,
      /** cruise = 工单下发的自主巡航任务；general = 不带工单的通用任务（旧调用） */
      kind: orderId ? "cruise" : "general",
      orderId,
      orderNo,
      /** 本次要巡到的构件（Z01—Z04）；页面按它显示"巡检对象" */
      componentIds: Array.isArray(payload.componentIds) ? payload.componentIds.map(String) : [],
      robotId: payload.robotId ?? "DEMO-R01",
      mapVersion: payload.mapVersion ?? null,
      speedProfile: payload.speedProfile ?? "标准",
      /** 速度（m/s）：来自小车自报的上限，取不到就是 null —— 不写一个假的默认速度 */
      speedMps: Number.isFinite(speedMps) && speedMps > 0 ? speedMps : null,
      laps: Number.isFinite(laps) ? Math.min(5, Math.max(1, Math.round(laps))) : 1,
      state: "queued",
      waypoints: Array.isArray(payload.waypoints) ? payload.waypoints : [],
      plannedPath: Array.isArray(payload.plannedPath) ? payload.plannedPath : [],
      createdBy: ctx.actorId,
      createdAt: nowIso(),
      acceptedBy: null,
      acceptedAt: null,
      endedAt: null,
      cancelReason: null,
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "mission", id, data);
    return {
      entityKind: "mission",
      entity,
      result: { missionId: id, taskNo: id, state: "queued", orderId, laps: data.laps },
      events: [
        {
          type: "mission.created",
          payload: { missionId: id, orderId, orderNo, mapVersion: data.mapVersion, createdBy: ctx.actorId },
        },
      ],
    };
  },

  /**
   * 执行工作台的任务卡（剧本 ⑥ ⑭ ⑮）。
   *
   * 剧本原话：
   *   · ⑥ 小木：「我已把工单任务同步到工作台。环境配置、地图、场景和检测批次将关联本次工单」；
   *   · ⑭ 小木：「建议核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，并验证候选模型」；
   *   · ⑮ 小木：「任务卡已生成。补采交全栈执行，样本与测区由具身核对，项目经理审核分组和验证结果，
   *              平台记录各项回执」+ 夹注「小木创建任务草稿，按本轮岗位分工预填执行人；
   *              史核对后保存，**不直接把任务标成已完成**」。
   *
   * ── 为什么是一批卡而不是一张（`batchKey`）───────────────────────────
   * 现场是"一次生成四张卡"，而命令总线一次只写一个实体（`CommandResult.entity`
   * 只有一个）。所以这里一次写 N 条 `taskCard` 实体，并用 `batchKey` 把它们绑成一批：
   *   · **幂等**：同一张工单的同一个批次只生成一次 —— 连按两次快捷键、两台电脑
   *     同时触发，都不会出现八张卡（返回 `created:false` 与已有那一批）；
   *   · 卡片编号 `TK-<工单号日期段>-<两位流水>`，与巡航任务号同一套做法
   *     （日期取自工单号，不再问时钟；流水在事务里数）。
   *
   * ── 状态机（三条，缺一不可）─────────────────────────────────────────
   *   draft（小木生成的草稿）─task.save→ saved（项目经理/架构师核对后保存）
   *   ─task.ack→ accepted（执行人回执，记下是谁在什么时候回的）
   * **没有 `done`**：剧本明令"不直接把任务标成已完成"，服务端干脆不给这个状态，
   * 免得以后有人顺手加一个按钮就把没做完的活标完成。
   */
  "task.create": (ctx, payload) => {
    const orderId = payload.orderId ?? null;
    const orderNo = payload.orderNo ?? null;
    const batchKey = String(payload.batchKey ?? "").trim();
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    if (!orderId) throw new WorkflowError(422, "NO_ORDER", "任务卡要挂在某张工单下：先建单或选中一张工单");
    if (!batchKey) throw new WorkflowError(422, "NO_BATCH_KEY", "任务卡批次缺少标识（batchKey）");
    if (cards.length === 0) throw new WorkflowError(422, "NO_CARDS", "没有要生成的任务卡");
    for (const card of cards) {
      if (!card?.title || !card?.ownerAccountId || !card?.doneCondition) {
        throw new WorkflowError(422, "BAD_CARD", "每张任务卡都要有标题、执行人与完成条件");
      }
    }

    const sameBatch = listKind(ctx.db, ctx.sessionId, "taskCard").filter(
      (item) => item.data.orderId === orderId && item.data.batchKey === batchKey,
    );
    if (sameBatch.length) {
      return {
        entityKind: "taskCard",
        entity: sameBatch[0],
        result: {
          created: false,
          orderId,
          batchKey,
          cardIds: sameBatch.map((item) => item.id),
          cards: sameBatch.map((item) => item.data),
        },
        events: [],
      };
    }

    const day = /^WO-(\d{8})-\d+$/.exec(String(orderNo ?? ""))?.[1] ?? null;
    const prefix = day ? `TK-${day}-` : "TK-";
    /*
      ⚠ 取当天**已有编号的最大值 + 1**，不能取 COUNT(*)：任务卡被清掉几张之后，
      COUNT 会回退，新卡就会撞上已存在的 id（与工单号 2026-09-20 踩到的是同一个坑）。
    */
    const used =
      ctx.db
        .prepare(
          "SELECT MAX(CAST(substr(id, -2) AS INTEGER)) AS n FROM entities WHERE session_id=? AND kind='taskCard' AND id LIKE ?",
        )
        .get(ctx.sessionId, `${prefix}%`)?.n ?? 0;

    const created = cards.map((card, index) => {
      const id = `${prefix}${String(used + index + 1).padStart(2, "0")}`;
      const data = {
        id,
        orderId,
        orderNo,
        batchKey,
        /** 批次内的序号（页面按它排，不按 id 的字典序） */
        seq: index + 1,
        title: String(card.title),
        ownerAccountId: String(card.ownerAccountId),
        ownerLabel: card.ownerLabel ? String(card.ownerLabel) : String(card.ownerAccountId),
        /* 岗位文案（取自 seed 的 MEMBERS，展示用）；判权限一律按 ownerAccountId */
        ownerRole: card.ownerRole ? String(card.ownerRole) : null,
        inputs: Array.isArray(card.inputs) ? card.inputs.map(String) : [],
        doneCondition: String(card.doneCondition),
        note: card.note ? String(card.note) : null,
        source: card.source ? String(card.source) : "小木",
        state: "draft",
        createdBy: ctx.actorId,
        createdAt: nowIso(),
        savedBy: null,
        savedAt: null,
        ackedBy: null,
        ackedAt: null,
      };
      return writeEntity(ctx.db, ctx.sessionId, "taskCard", id, data);
    });

    return {
      entityKind: "taskCard",
      entity: created[0],
      result: {
        created: true,
        orderId,
        orderNo,
        batchKey,
        cardIds: created.map((item) => item.id),
        cards: created.map((item) => item.data),
      },
      events: [
        {
          type: "task.created",
          payload: { orderId, orderNo, batchKey, count: created.length, by: ctx.actorId },
        },
      ],
    };
  },

  /**
   * 小木回合广播（**内网多主机内容同步**，用户 2026-09-23：
   * 「实际上项目就是面向结果展示的，但得做到内网多主机内容同步」）。
   *
   * ── 为什么需要它 ──────────────────────────────────────────────────
   * 小木这一层（回合、台词、页面落点、揭示节奏、浮层）原先全跑在**浏览器本地**：
   * agent store 在内存里、页面跳转走本地路由、浮层靠 window 事件。
   * 于是只有"演示机"那一台看得到，第二台机器屏幕上什么都没有 ——
   * 业务数据（工单 / 环境读数 / 任务卡）是同步的，**讲解过程不同步**。
   *
   * 现在把"这一轮开讲了"写成一条服务端事件：演示机发 `xiaomu.round`，
   * 其它机器在自己的 WS 事件流里收到后**跟随显示与页面动作**（不出声，见前端 `roundSync.ts`）。
   *
   * ── 三条口径 ──────────────────────────────────────────────────────
   *   · **幂等性不做**：同一轮再讲一次就该再广播一次（现场会重讲），每条是一回合；
   *   · **带 hostId**：发起方的浏览器 id。跟随端据此**忽略自己发的**回声，
   *     否则两台机器会互相跟随、来回跳页（这条不加就是死循环）；
   *   · **只记"说过什么"**：实体里存轮次号、台词、页面落点与发起人，
   *     便于事后核对"哪台机器在哪一轮讲了什么"（面向结果展示也要留痕）。
   *
   * ── 2026-09-30 增补：`orderId`（发起端**解析出来**的那张工单）──────────
   * `nav` 是声明（"打开显式绑定的那张"），"哪一张"是发起端那一刻才算得出的本机状态。
   * 只带 `nav` 时跟随端得自己再算一遍，而它没有那份绑定 → 退回"列表最新那张"，
   * 于是史点「工单识别」读的是 A 单、另一台机器跳到 B 单，两块屏各说一套。
   * 现在把解析结果原样带过去（没有就 null），跟随端据此绑同一张单。
   */
  "xiaomu.round": (ctx, payload) => {
    const roundNo = String(payload.roundNo ?? "").trim();
    const text = String(payload.text ?? "").trim();
    if (!roundNo || !text) throw new WorkflowError(422, "BAD_ROUND", "回合广播要带轮次号与台词");
    const hostId = payload.hostId ? String(payload.hostId) : null;
    /** 发起端解析出来的工单 id（非工单轮次没有）；空串一律当没有，不让它变成一张"空工单" */
    const orderId = payload.orderId ? String(payload.orderId) : null;
    const used =
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE session_id=? AND kind='agentTurn'")
        .get(ctx.sessionId)?.n ?? 0;
    const id = `TURN-${String(used + 1).padStart(4, "0")}`;
    const data = {
      id,
      roundNo,
      text,
      /** 这一轮的页面落点（原样带过去，跟随端照着跳，不自己猜） */
      nav: payload.nav ?? null,
      /** 这一轮实际读的那张工单（跟随端要绑同一张，见上面的增补说明） */
      orderId,
      hostId,
      by: ctx.actorId,
      at: nowIso(),
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "agentTurn", id, data);
    return {
      entityKind: "agentTurn",
      entity,
      result: { turnId: id, roundNo, hostId, by: ctx.actorId },
      events: [
        {
          type: "xiaomu.round",
          /*
            ⚠ **台词必须进事件载荷**（第一版漏了，现场表现为"跟随端一点反应都没有"）：
            跟随端是拿 WS 事件直接跟随的（`agent/roundSync.ts` 的 `remoteRoundOf`），
            它不查快照 —— 事件里只有 roundNo、text 为空时那一轮会被判成"不是有效回合"，
            于是页面不跳、气泡不显示，而服务端这边看起来一切正常（实体写进去了）。
            `orderId` 同理：**载荷里不放，跟随端就拿不到**（这条是同一类坑）。
          */
          payload: { turnId: id, roundNo, text, hostId, by: ctx.actorId, nav: data.nav, orderId },
        },
      ],
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

  /* ---- 场景版本：上传 → 检查 → 发布（评审 F06 / PRD 3.3） ---- */
  "scene.submit": (ctx, payload) => {
    /*
     * 高斯模型**按工单绑定**：一个工单一份场景成果。
     * 同一个工单再次上传是**替换**（返回同一个 sceneId），
     * 不是又建一条 —— 否则数字孪生页会列出同一工单的好几份模型，
     * 谁也说不清该看哪一份。
     */
    const orderId = payload.orderId ?? null;
    if (!orderId) throw new WorkflowError(422, "NO_ORDER", "场景必须绑定工单（orderId）");
    const existing = listKind(ctx.db, ctx.sessionId, "scene").find((item) => item.data.orderId === orderId);
    const id = payload.sceneId ?? existing?.id ?? `SCN-${Date.now().toString(36).toUpperCase()}`;
    /*
     * 未提供的字段**保留上一版的值**，不用 null 覆盖。
     *
     * 这是一条踩过的坑：`assetFileId: payload.assetFileId ?? null` 会让
     * 「只改标题」这类提交把已绑定的模型清空 —— 孪生页随即变成
     * 「未收到模型文件」，而用户什么都没删。工单绑定同理：
     * 一个工单只允许一份场景成果，重复提交的语义是**更新**，不是重建。
     */
    const previous = existing?.data ?? {};
    const keep = (next, fallback) => (next === undefined || next === null ? fallback : next);
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", id, {
      id,
      orderId: keep(orderId, previous.orderId ?? null),
      assetFileId: keep(payload.assetFileId, previous.assetFileId ?? null),
      title: keep(payload.title, previous.title ?? id),
      round: keep(payload.round, previous.round ?? "本轮"),
      assetId: keep(payload.assetId, previous.assetId ?? null),
      format: keep(payload.format, previous.format ?? "sog"),
      /* 锚点与书签：给了就用给的（哪怕空数组是明确的意思），没给才沿用 */
      componentAnchors: payload.componentAnchors ?? previous.componentAnchors ?? [],
      bookmarkIds: payload.bookmarkIds ?? previous.bookmarkIds ?? [],
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
      events: [{ type: "scene.submitted", payload: { sceneId: id, orderId } }],
    };
  },

  "scene.check": (ctx) => {
    const target = requireEntity(ctx, "scene");
    if (target.data.state === "已发布") {
      throw new WorkflowError(409, "ALREADY_PUBLISHED", `场景 ${target.id} 已发布，不能重新检查`);
    }
    /*
     * 检查项：锚点、书签、资源三者齐全才算通过。
     *
     * ⚠ 书签这一项读的是「机位关键帧 ∪ bookmarkIds」的**并集**：页面里"打关键帧"写的
     * 是 `keyframes`，同时会把帧号并进 `bookmarkIds`（见 scene.keyframe.add）。
     * 取并集是为了兼容两种历史数据 —— 老库里只有 seed 的书签号，
     * 而新打的帧可能因为手工改库、旧版本写入等原因只落在一边。
     */
    const anchors = target.data.componentAnchors ?? [];
    const keyframes = target.data.keyframes ?? [];
    const bookmarks = new Set([...(target.data.bookmarkIds ?? []), ...keyframes.map((item) => item.id)]);
    const checks = [
      { key: "asset", label: "重建资源已登记", pass: Boolean(target.data.assetId), detail: target.data.assetId ?? "未登记" },
      { key: "anchors", label: "构件锚点已标定", pass: anchors.length > 0, detail: `${anchors.length} 个锚点` },
      {
        key: "bookmarks",
        label: "视角书签已建立",
        pass: bookmarks.size > 0,
        detail: `${bookmarks.size} 个书签${keyframes.length ? `（含 ${keyframes.length} 个机位关键帧）` : ""}`,
      },
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

  /*
   * 机位关键帧：数字孪生页里"把镜头拉近木柱 → 打一帧"。
   * 口径与理由见文件上方「场景机位关键帧」那段注释（不改发布状态 / 同步 bookmarkIds / 可追溯）。
   * 权限是 "*"（任意已登录账号）：用户口径「所有服务都要让别人也能用」。
   */
  "scene.keyframe.add": (ctx, payload) => {
    const target = requireEntity(ctx, "scene");
    const pose = normalizeKeyframePose(payload.pose);
    const componentId = String(payload.componentId ?? "").trim() || null;
    /* 配图可缺（截图失败也要能把机位记下来），但给了就必须是真图片 */
    const image = normalizeKeyframeImage(ctx.db, payload.imageFileId);
    const frames = [...(target.data.keyframes ?? [])];
    const id = nextKeyframeId(frames, componentId);
    const frame = {
      id,
      componentId,
      label:
        String(payload.label ?? "").trim() ||
        `${componentId ?? "场景"} · 机位 ${frames.filter((item) => item.componentId === componentId).length + 1}`,
      pose,
      ...(image ?? {}),
      addedBy: ctx.actorId,
      addedAt: nowIso(),
    };
    frames.push(frame);
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", target.id, {
      ...target.data,
      keyframes: frames,
      /* 书签与关键帧是同一件事的两种叫法：检查项读 bookmarkIds，这里保持同步（去重） */
      bookmarkIds: [...new Set([...(target.data.bookmarkIds ?? []), id])],
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: target.id, keyframeId: id, count: frames.length },
      events: [
        { type: "scene.keyframe.added", payload: { sceneId: target.id, keyframeId: id, componentId } },
      ],
    };
  },

  /**
   * 改一帧：改名 / 用当前机位覆盖。
   *
   * 为什么需要它（现场用法）：打帧时是「随手拉近木柱就记一帧」，回头讲解时要的是
   * 「柱脚虫道入口」这种能直接念出来的名字；镜头微调之后也不想删了重打
   * （删了重打会换帧号，讲稿上的 KF-Z04-02 就对不上了）。
   *
   * 口径：帧号（id）与构件绑定**不可改**（编号是讲稿与对照表的锚点）；
   * 只允许改 label、pose 与配图，并记下是谁在什么时候改的（现场会问"这帧谁改的"）。
   */
  "scene.keyframe.update": (ctx, payload) => {
    const target = requireEntity(ctx, "scene");
    const keyframeId = String(payload.keyframeId ?? "").trim();
    const frames = [...(target.data.keyframes ?? [])];
    const index = frames.findIndex((item) => item.id === keyframeId);
    if (index < 0) {
      throw new WorkflowError(404, "NO_KEYFRAME", `场景 ${target.id} 上没有机位关键帧 ${keyframeId}`);
    }
    const current = frames[index];
    const next = { ...current };

    if (payload.label !== undefined) {
      const label = String(payload.label ?? "").trim();
      if (label.length > 40) {
        throw new WorkflowError(422, "BAD_LABEL", `关键帧标签最长 40 个字（收到 ${label.length} 个字）`);
      }
      /* 清空 = 回到自动标签（不写空串，列表里那一行不能没有名字） */
      next.label = label || `${current.componentId ?? "场景"} · 机位（未命名）`;
    }
    if (payload.pose !== undefined) {
      next.pose = normalizeKeyframePose(payload.pose);
    }
    /*
     * 配图跟着机位走：`更新机位` 是"镜头微调后不用删了重打"，如果只换机位不换图，
     * 右栏那张缩略图就变成了**上一版机位**拍的画面（图与机位对不上，比没有图更坏）。
     * 页面在更新机位时会重新截一张传上来；显式传空串 = 把图摘掉。
     */
    if (payload.imageFileId !== undefined) {
      const image = normalizeKeyframeImage(ctx.db, payload.imageFileId);
      if (image) {
        next.imageFileId = image.imageFileId;
        next.imageName = image.imageName;
      } else {
        delete next.imageFileId;
        delete next.imageName;
      }
    }
    next.updatedBy = ctx.actorId;
    next.updatedAt = nowIso();
    frames[index] = next;

    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", target.id, {
      ...target.data,
      keyframes: frames,
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: target.id, keyframeId, label: next.label },
      events: [{ type: "scene.keyframe.updated", payload: { sceneId: target.id, keyframeId } }],
    };
  },

  "scene.keyframe.remove": (ctx, payload) => {
    const target = requireEntity(ctx, "scene");
    const keyframeId = String(payload.keyframeId ?? "").trim();
    const frames = target.data.keyframes ?? [];
    if (!frames.some((item) => item.id === keyframeId)) {
      throw new WorkflowError(404, "NO_KEYFRAME", `场景 ${target.id} 上没有机位关键帧 ${keyframeId}`);
    }
    const rest = frames.filter((item) => item.id !== keyframeId);
    const entity = writeEntity(ctx.db, ctx.sessionId, "scene", target.id, {
      ...target.data,
      keyframes: rest,
      bookmarkIds: (target.data.bookmarkIds ?? []).filter((id) => id !== keyframeId),
    });
    return {
      entityKind: "scene",
      entity,
      result: { sceneId: target.id, keyframeId, count: rest.length },
      events: [{ type: "scene.keyframe.removed", payload: { sceneId: target.id, keyframeId } }],
    };
  },

  /* ---- 交付产物：构建 → 发布 → 回验（评审 F02 / PRD §10.3） ---- */

  "artifact.build": (ctx, payload) => {
    const files = payload.files ?? [];
    if (!files.length) throw new WorkflowError(422, "NO_FILES", "没有文件，不能生成产物");
    const id = payload.artifactId ?? `ART-${Date.now().toString(36).toUpperCase()}`;
    const packageFile = files.find((item) => item.role === "整包") ?? files[0];
    const packageMeta = packageFile ? getFile(ctx.db, packageFile.fileId) : null;
    if (!packageMeta) throw new WorkflowError(422, "FILE_REQUIRED", "整包文件未登记，不能生成产物");
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
      sha256: packageMeta.sha256,
      sizeText: `${(packageMeta.size / 1024 / 1024).toFixed(2)} MB`,
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
    if (["已发布", "已下载", "已回验"].includes(target.data.state)) {
      return { entityKind: "artifact", entity: target, result: { artifactId: target.id, state: target.data.state }, events: [] };
    }
    if (target.data.state !== "checked") {
      throw new WorkflowError(422, "CHECK_REQUIRED", "产物尚未完成服务端校验，不能发布");
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
          : "摘要一致，更新包已完成回验",
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
    const file = getFile(db, fileId);
    const downloadedAt = nowIso();
    const entity = writeEntity(db, sessionId, "artifact", row.id, {
      ...data,
      state: "已下载",
      downloadedBy: actorId,
      downloadedAt,
      downloadCount: (data.downloadCount ?? 0) + 1,
      receivedFiles: [
        ...(data.receivedFiles ?? []),
        {
          fileId,
          actor: actorId,
          at: downloadedAt,
          size: file?.size ?? null,
          sha256: file?.sha256 ?? null,
        },
      ],
    });
    return { entityKind: "artifact", entity, artifactId: row.id };
  }
  return null;
}

/**
 * 自主巡航任务号：`CR-<工单号里的日期段>-<两位流水>`。
 *
 * 拿不到工单号（通用任务、旧调用）时退回时间戳式编号 —— 编号仍然唯一，
 * 只是不带日期语义，页面照实显示，不假装它是按天流水。
 */
function nextCruiseTaskNo(ctx, orderNo) {
  const day = /^WO-(\d{8})-\d+$/.exec(String(orderNo ?? ""))?.[1] ?? null;
  if (!day) return `MS-${Date.now().toString(36).toUpperCase()}`;
  const prefix = `CR-${day}-`;
  /* 同工单号那个坑：取最大值 + 1（巡航任务会被撤销/删除，COUNT 会回退） */
  const used =
    ctx.db
      .prepare(
        "SELECT MAX(CAST(substr(id, -2) AS INTEGER)) AS n FROM entities WHERE session_id=? AND kind='mission' AND id LIKE ?",
      )
      .get(ctx.sessionId, `${prefix}%`)?.n ?? 0;
  return `${prefix}${String(used + 1).padStart(2, "0")}`;
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
 *
 * `mission.ack` 额外记下**是谁在什么时候接的**：工单页要显示「马昱天 已接受」，
 * 现场问"这活谁接的"时不能靠猜（用户 2026-09-18：shi 派发、ma 接受去建图巡航）。
 */
function missionTransition(action) {
  return (ctx, payload) => {
    const target = requireEntity(ctx, "mission");
    const rule = MISSION_NEXT[action];
    const nextState = rule.to;
    const data = {
      ...target.data,
      state: nextState,
      ...(action === "mission.ack" ? { acceptedBy: ctx.actorId, acceptedAt: nowIso() } : {}),
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
      result: {
        missionId: target.id,
        state: nextState,
        from: target.data.state,
        ...(action === "mission.ack" ? { acceptedBy: ctx.actorId } : {}),
      },
      events: [
        {
          type: `mission.${nextState}`,
          payload: {
            missionId: target.id,
            orderId: target.data.orderId ?? null,
            from: target.data.state,
            to: nextState,
            by: ctx.actorId,
            reason: payload.reason ?? null,
          },
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
 * 执行工作台的任务卡 · 状态迁移（剧本 ⑥ ⑭ ⑮，见上面 "task.create" 的注释）
 *
 * 只有两条迁移，且**没有 `done`**：
 *   task.save  draft   → saved     （核对后保存）
 *   task.ack   saved   → accepted  （执行人回执，记下是谁、什么时候）
 *
 * 与 mission 的迁移分开写而不是硬塞进同一段：两者的状态名、记的字段、
 * 事件名都不同，混在一起改一处就会影响另一处（巡航任务那边已经验收过了）。
 * ------------------------------------------------------------------ */

const TASK_NEXT = {
  "task.save": { from: ["draft"], to: "saved" },
  "task.ack": { from: ["saved"], to: "accepted" },
};

function taskTransition(action) {
  return (ctx, payload) => {
    const target = requireEntity(ctx, "taskCard");
    const rule = TASK_NEXT[action];
    const current = target.data.state;
    if (!rule.from.includes(current)) {
      const label = { draft: "草稿", saved: "已保存", accepted: "已回执" }[current] ?? current;
      throw new WorkflowError(409, "BAD_TASK_STATE", `任务卡当前是「${label}」，不能执行这一步`);
    }
    const nextState = rule.to;
    const data = {
      ...target.data,
      state: nextState,
      ...(action === "task.save" ? { savedBy: ctx.actorId, savedAt: nowIso() } : {}),
      ...(action === "task.ack" ? { ackedBy: ctx.actorId, ackedAt: nowIso(), ackNote: payload.note ?? null } : {}),
    };
    const entity = writeEntity(ctx.db, ctx.sessionId, "taskCard", target.id, data);
    return {
      entityKind: "taskCard",
      entity,
      result: { cardId: target.id, state: nextState, from: current, orderId: target.data.orderId ?? null },
      events: [
        {
          type: `task.${nextState}`,
          payload: {
            cardId: target.id,
            orderId: target.data.orderId ?? null,
            batchKey: target.data.batchKey ?? null,
            from: current,
            to: nextState,
            by: ctx.actorId,
            ownerAccountId: target.data.ownerAccountId ?? null,
          },
        },
      ],
    };
  };
}

for (const action of Object.keys(TASK_NEXT)) {
  HANDLERS[action] = taskTransition(action);
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
