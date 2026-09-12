/**
 * 共享服务 · 会话与快照
 *
 * 演示会话（demoSessionId）是四端共享的边界：PRD §6「本轮批次和结果必须按
 * demoSessionId 隔离」。新建会话 = 新开一场演示，上一轮的批次、产物、回执
 * 不会串进来（评审 F12 / 验收 T20）。
 *
 * 开一场新会话时会播种初始共享实体 —— 只播**可变**的那几个（环境配置、地图版本、
 * 场景、产物）。构件、风险、知识库这类只读参照数据仍在前端的 seed/ 里，
 * 不在服务端再存一份，避免出现「第三份工单数据」那种多源问题。
 */

import { nowIso, parseJson } from "../storage/db.mjs";
import { buildDemoPackage } from "../fixtures/demo-package.mjs";
import { estimateEmc, validateEnvironment } from "./workflow.mjs";

export const DEFAULT_SESSION_ID = process.env.MUMAI_SESSION ?? "demo-01";

export function createSession(db, scenarioId = "chapter2", sessionId = null) {
  const id = sessionId ?? `demo-${Date.now().toString(36)}`;
  const at = nowIso();
  db.prepare(
    "INSERT INTO sessions (id, scenario_id, stage, status, last_seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, scenarioId, "prepare", "active", 0, at, at);
  db.prepare("INSERT INTO projection (session_id, holder_id, view_type, focus_ids, updated_at) VALUES (?,?,?,?,?)").run(
    id,
    null,
    "map",
    JSON.stringify([]),
    at,
  );
  seedSession(db, id);
  return getSession(db, id);
}

export function getSession(db, sessionId) {
  const row = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    stage: row.stage,
    status: row.status,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSessions(db) {
  return db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
    .all()
    .map((row) => ({
      id: row.id,
      scenarioId: row.scenario_id,
      stage: row.stage,
      status: row.status,
      lastSeq: row.last_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function put(db, sessionId, kind, id, data) {
  db.prepare(
    `INSERT INTO entities (session_id, kind, id, revision, data, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run(sessionId, kind, id, 1, JSON.stringify(data), nowIso());
}

function pushEvent(db, sessionId, seq, type, entityKind, entityId, actorId, payload) {
  db.prepare(
    `INSERT INTO events (session_id, seq, type, entity_kind, entity_id, revision, actor_id, payload, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, seq, type, entityKind, entityId, 1, actorId, JSON.stringify(payload), nowIso());
}

/**
 * 播种开场状态。
 *
 * 与剧本第二章开场一致：环境配置 CFG-02 已发布且已由饶接收；
 * 地图 MAP-SH-06 已保存；一个历史场景已发布、本轮场景待检查；
 * 一个演示更新包已发布（含真实文件）。
 */
function seedSession(db, sessionId) {
  let seq = 0;

  /* ---- 环境配置 CFG-02：已发布 + 已接收 ---- */
  const inputs = {
    airTempC: 26.4,
    relativeHumidityPct: 78,
    windSpeedMs: 1.2,
    instrumentId: "TH-2207",
    position: "大雄宝殿东次间",
    instrumentRange: { min: -20, max: 60, unit: "℃" },
    measuredAt: "2026-09-12 09:12",
  };
  const { checks } = validateEnvironment(inputs);
  put(db, sessionId, "environment", "CFG-02", {
    version: "CFG-02",
    inputs,
    checks,
    emcPct: estimateEmc(inputs.airTempC, inputs.relativeHumidityPct),
    methodVersion: "HH-2026.08 / v1.4",
    state: "received",
    publishedBy: "shen",
    publishedAt: "2026-09-12T01:12:00.000Z",
    ackBy: "rao",
    ackAt: "2026-09-12T01:13:00.000Z",
  });
  pushEvent(db, sessionId, (seq += 1), "environment.published", "environment", "CFG-02", "shen", { version: "CFG-02" });
  pushEvent(db, sessionId, (seq += 1), "environment.received", "environment", "CFG-02", "rao", { version: "CFG-02", ackBy: "rao" });

  /* ---- 地图版本：已保存（地图与任务分离，这里只有地图版本，没有任务） ---- */
  put(db, sessionId, "mapVersion", "MAP-SH-06", {
    id: "MAP-SH-06",
    label: "示例寺大雄宝殿 · 06",
    resolutionM: 0.05,
    coveragePct: 96,
    sizeText: "2.6 MB",
    state: "已保存",
    savedBy: "ma",
    savedAt: "2026-09-12T01:20:00.000Z",
  });

  /* ---- 场景：历史已发布 / 本轮已发布 / 本轮原始导入待检查 ----
     场景 id 与前端 seed/scenario.ts 的 SCENES 逐字对齐：服务端持有检查与发布状态，
     前端那份只补标题与素材描述。两边 id 不一致会让场景库出现两套条目。 */
  const anchors = ["Z01", "Z02", "Z03", "Z04"].map((componentId) => ({
    componentId,
    zoneId: `${componentId}-low`,
    position: null,
  }));
  const bookmarks = ["BM-Z01-base", "BM-Z04-base", "BM-Z04-side"];

  put(db, sessionId, "scene", "scene-May", {
    id: "scene-May",
    title: "示例寺四柱 · 五月历史场景",
    round: "历史",
    assetId: "public/model/sog/gs.sog",
    format: "sog",
    componentAnchors: anchors,
    bookmarkIds: bookmarks,
    checkResult: { checks: [], pass: true, checkedBy: "shi", checkedAt: "2026-05-18T09:40:00.000Z" },
    state: "已发布",
    submittedBy: "rao",
    submittedAt: "2026-05-18T09:30:00.000Z",
    publishedBy: "shi",
    publishedAt: "2026-05-18T09:41:00.000Z",
  });
  pushEvent(db, sessionId, (seq += 1), "scene.published", "scene", "scene-May", "shi", { sceneId: "scene-May" });

  put(db, sessionId, "scene", "scene-SH-0901", {
    id: "scene-SH-0901",
    title: "示例寺四柱 · 本轮场景",
    round: "本轮",
    assetId: "public/model/sog/gs.sog",
    format: "sog",
    componentAnchors: anchors,
    bookmarkIds: bookmarks,
    checkResult: { checks: [], pass: true, checkedBy: "shi", checkedAt: "2026-09-11T21:40:00.000Z" },
    state: "已发布",
    submittedBy: "rao",
    submittedAt: "2026-09-11T21:30:00.000Z",
    publishedBy: "shi",
    publishedAt: "2026-09-11T21:41:00.000Z",
  });
  pushEvent(db, sessionId, (seq += 1), "scene.published", "scene", "scene-SH-0901", "shi", { sceneId: "scene-SH-0901" });

  // 等待检查的那一版：史在这一页跑检查 → 发布，演示 F06 的闭环。
  // 资源配置齐全（资源 + 4 个锚点 + 3 个书签），所以检查能通过；
  // 缺任何一项都会走到「检查未通过、不能发布」那一支 —— 检查是真的在判，不是走过场。
  put(db, sessionId, "scene", "scene-SH-0901-raw", {
    id: "scene-SH-0901-raw",
    title: "示例寺四柱 · 本轮原始导入",
    round: "本轮",
    assetId: "public/model/sog/gs.sog",
    format: "MipMap 导出目录",
    componentAnchors: anchors,
    bookmarkIds: bookmarks,
    checkResult: null,
    state: "待检查",
    submittedBy: "rao",
    submittedAt: "2026-09-11T21:12:00.000Z",
    publishedBy: null,
    publishedAt: null,
  });

  /* ---- 交付产物：一个已发布的演示包（真实文件） ---- */
  const pack = buildDemoPackage(db, {
    modelVersion: "DEMO-M02b",
    kind: "模型包",
    target: "硬件侧端模型",
    builtBy: "shi",
    sessionId,
  });
  put(db, sessionId, "artifact", "ART-01", {
    id: "ART-01",
    name: pack.packageName,
    kind: "模型包",
    target: "硬件侧端模型",
    modelVersion: "DEMO-M02b",
    demoOnly: true,
    fromJob: "EXP-2026-0911",
    files: [
      { fileId: pack.packageFileId, role: "整包" },
      { fileId: pack.manifestFileId, role: "清单" },
      ...pack.artifactFiles.map((item) => ({ fileId: item.id, role: item.role })),
    ],
    state: "已发布",
    sha256: pack.totalSha256,
    sizeText: `${(pack.totalSize / 1024).toFixed(1)} KB`,
    builtBy: "shi",
    builtAt: "2026-09-12T01:40:00.000Z",
    publishedBy: "shi",
    publishedAt: "2026-09-12T01:41:00.000Z",
    receipts: [],
  });
  pushEvent(db, sessionId, (seq += 1), "artifact.published", "artifact", "ART-01", "shi", { artifactId: "ART-01" });

  db.prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?").run(seq, nowIso(), sessionId);
}

/* ------------------------------------------------------------------ *
 * 快照与事件读取
 * ------------------------------------------------------------------ */

/**
 * 页面初次加载以快照为准，不以本地定时器猜任务进度（PRD §7）。
 *
 * 排序是 `updated_at DESC, id DESC`：前端一律把每种实体的**第一条**当「当前版本」，
 * 升序会把最老的那条当成当前版本（表现是发布了 CFG-03，页面还显示 CFG-02）。
 * id 作为次序键是为了同一毫秒内写入的两条也有确定顺序。
 */
export function snapshot(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const rows = db
    .prepare(
      "SELECT kind, id, revision, data, updated_at FROM entities WHERE session_id=? ORDER BY kind, updated_at DESC, id DESC",
    )
    .all(sessionId);
  const entities = {};
  for (const row of rows) {
    (entities[row.kind] ??= []).push({
      id: row.id,
      revision: row.revision,
      updatedAt: row.updated_at,
      data: parseJson(row.data, {}),
    });
  }
  const projection = db.prepare("SELECT * FROM projection WHERE session_id=?").get(sessionId);
  return {
    session,
    entities,
    projection: projection
      ? {
          holderId: projection.holder_id,
          viewType: projection.view_type,
          focusIds: parseJson(projection.focus_ids, []),
          updatedAt: projection.updated_at,
        }
      : { holderId: null, viewType: "map", focusIds: [], updatedAt: null },
  };
}

/** 重连补缺口：返回 afterSeq 之后的事件 */
export function eventsSince(db, sessionId, afterSeq = 0) {
  return db
    .prepare("SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq")
    .all(sessionId, afterSeq)
    .map((row) => ({
      seq: row.seq,
      type: row.type,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      revision: row.revision,
      actorId: row.actor_id,
      payload: parseJson(row.payload, {}),
      at: row.at,
    }));
}

/** 事件保留范围：超出就要求客户端拉全量快照（PRD §7） */
export function eventsWindow(db, sessionId, keep = 500) {
  const row = db.prepare("SELECT MIN(seq) AS oldest, MAX(seq) AS newest FROM events WHERE session_id=?").get(sessionId);
  return { oldest: row?.oldest ?? 0, newest: row?.newest ?? 0, keep };
}

/**
 * 追加一条事件（给命令总线之外的路径用，例如下载留痕）。
 *
 * 命令的实体变更走 workflow 的事务；下载这类「只留痕、不改实体」的动作
 * 不必要开事务，但也必须进同一条事件流，否则展示窗口和另一端的待办会漏掉它。
 */
export function appendEvent(db, sessionId, { type, entityKind = null, entityId = null, revision = null, actorId, payload = {} }) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const seq = session.lastSeq + 1;
  const at = nowIso();
  db.prepare(
    `INSERT INTO events (session_id, seq, type, entity_kind, entity_id, revision, actor_id, payload, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, seq, type, entityKind, entityId, revision, actorId, JSON.stringify(payload), at);
  db.prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?").run(seq, at, sessionId);
  return { seq, type, entityKind, entityId, revision, actorId, payload, at };
}
