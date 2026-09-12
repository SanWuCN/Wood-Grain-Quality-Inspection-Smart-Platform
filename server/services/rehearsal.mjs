/**
 * 共享服务 · 排练快照（PRD §11 / 评审 F12）
 *
 * 评审原文：「业务默认从融合阶段开始，缺少可用的统一分段恢复与新一轮隔离」，
 * 要求「新建演示会话从开场开始；设管理员排练控制台，恢复阶段快照」。
 *
 * 这里的快照是**整场实体的完整转储**，不是「跳到某个阶段就假装成那样」：
 *   - 捕获：把当前 session 的全部实体存一份，记下是谁在什么时候存的
 *   - 恢复：把实体表换回快照里的内容，并写一条事件
 *   - 不篡改历史：恢复产生的是新事件、新 revision，旧事件流仍在（PRD §11
 *     「恢复操作不篡改历史会话」）
 *
 * 快照只存实体，不存事件与文件 —— 文件在磁盘上按 fileId 引用，回滚实体不会动它们；
 * 事件流是审计记录，回滚不该把它抹掉。
 */

import { randomUUID } from "node:crypto";
import { nowIso, parseJson } from "../storage/db.mjs";

/** 阶段标签：与 PRD §3 的 P00–P11 对齐，供控制台下拉选择 */
export const DEMO_STAGES = [
  { key: "P00", label: "P00 历史查询" },
  { key: "P01", label: "P01 工单与环境" },
  { key: "P02", label: "P02 建图" },
  { key: "P03", label: "P03 场景构建" },
  { key: "P04", label: "P04 风险选区" },
  { key: "P05", label: "P05 初扫与巡检" },
  { key: "P06", label: "P06 异常与补采" },
  { key: "P07", label: "P07 清洗与分组" },
  { key: "P08", label: "P08 训练与比较" },
  { key: "P09", label: "P09 封装与交付" },
  { key: "P10", label: "P10 复扫与融合" },
  { key: "P11", label: "P11 孪生与归档" },
];

/** 把某场会话的全部实体读成一份可存可还原的转储 */
function dumpEntities(db, sessionId) {
  return db
    .prepare("SELECT kind, id, revision, data, updated_at FROM entities WHERE session_id=?")
    .all(sessionId)
    .map((row) => ({
      kind: row.kind,
      id: row.id,
      revision: row.revision,
      data: parseJson(row.data, {}),
      updatedAt: row.updated_at,
    }));
}

function entityCount(db, sessionId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM entities WHERE session_id=?").get(sessionId);
  return row?.n ?? 0;
}

export function captureSnapshot(db, { sessionId, stage, label, actorId }) {
  const snapshot = {
    id: `snap-${randomUUID()}`,
    sessionId,
    stage,
    label: label?.trim() || DEMO_STAGES.find((item) => item.key === stage)?.label || stage,
    entitySeq: entityCount(db, sessionId),
    data: dumpEntities(db, sessionId),
    createdBy: actorId,
    createdAt: nowIso(),
  };
  db.prepare(
    "INSERT INTO snapshots (id, session_id, stage, label, entity_seq, data, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    snapshot.id,
    sessionId,
    snapshot.stage,
    snapshot.label,
    snapshot.entitySeq,
    JSON.stringify(snapshot.data),
    snapshot.createdBy,
    snapshot.createdAt,
  );
  return snapshot;
}

export function listSnapshots(db, sessionId) {
  return db
    .prepare("SELECT id, stage, label, entity_seq, created_by, created_at FROM snapshots WHERE session_id=? ORDER BY created_at DESC")
    .all(sessionId)
    .map((row) => ({
      id: row.id,
      stage: row.stage,
      label: row.label,
      entityCount: row.entity_seq,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
}

export function getSnapshot(db, sessionId, id) {
  const row = db.prepare("SELECT * FROM snapshots WHERE session_id=? AND id=?").get(sessionId, id);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    stage: row.stage,
    label: row.label,
    entityCount: row.entity_seq,
    data: parseJson(row.data, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function deleteSnapshot(db, sessionId, id) {
  const info = db.prepare("DELETE FROM snapshots WHERE session_id=? AND id=?").run(sessionId, id);
  return info.changes > 0;
}

/**
 * 恢复：把实体表换回快照内容。
 *
 * 做法是先清空该会话的实体再按快照重建 —— 只覆盖「快照里有」的实体是不够的，
 * 快照之后新建的（比如刚发布的配置版本）必须一起消失，否则回滚出来的状态
 * 是「旧的 + 新的」混在一起，比不回滚更难判断。
 *
 * 文件不删：files 表与磁盘是共享资产，别的会话也可能引用。
 */
export function restoreSnapshot(db, sessionId, snapshot, actorId) {
  const at = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM entities WHERE session_id=?").run(sessionId);
    const insert = db.prepare(
      "INSERT INTO entities (session_id, kind, id, revision, data, updated_at) VALUES (?,?,?,?,?,?)",
    );
    for (const entity of snapshot.data) {
      // revision 在快照值上 +1：恢复是一次**新的**写入，不是把时钟拨回去
      insert.run(sessionId, entity.kind, entity.id, entity.revision + 1, JSON.stringify(entity.data), at);
    }
    db.prepare("UPDATE sessions SET stage=?, updated_at=? WHERE id=?").run(snapshot.stage, at, sessionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { restored: snapshot.data.length, stage: snapshot.stage, at };
}

/**
 * 导出诊断包（PRD §11）。
 *
 * 只是一份 JSON：会话、实体、快照清单、事件流、预检结果。
 * 不含文件字节 —— 那由 fileId 指向，需要时单独取。
 */
export function diagnosticsBundle(db, sessionId, preflight) {
  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
  const events = db
    .prepare("SELECT seq, type, entity_kind, entity_id, revision, actor_id, payload, at FROM events WHERE session_id=? ORDER BY seq")
    .all(sessionId)
    .map((row) => ({ ...row, payload: parseJson(row.payload, {}) }));
  return {
    exportedAt: nowIso(),
    service: "mumai-shared",
    session: session
      ? {
          id: session.id,
          scenarioId: session.scenario_id,
          stage: session.stage,
          status: session.status,
          lastSeq: session.last_seq,
          createdAt: session.created_at,
        }
      : null,
    entities: dumpEntities(db, sessionId),
    snapshots: listSnapshots(db, sessionId),
    events,
    preflight,
  };
}
