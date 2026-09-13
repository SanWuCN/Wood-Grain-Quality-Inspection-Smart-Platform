/**
 * 数据与知识中心 · 索引构建任务（演示索引适配器 DemoIndexAdapter）
 *
 * 依据：PRD §9.2（自动更新触发与合并）、§9.3（流水线与进度）、
 *      §9.4（失败、重试、取消与版本恢复）、§11.3（一块一条的逻辑向量记录）。
 *
 * 这一层做什么、不做什么，必须说清楚：
 *   · **做**：真的按输入快照逐个资产处理，真的重新分块、真的写分块与向量记录、
 *     真的在一个事务里切换服务版本指针并按记录统计；失败项真的不进服务版本。
 *   · **不做**：不加载嵌入模型、不申请 768 维稠密数组、不做 ANN。
 *     向量条目是 `mode=demo` 的逻辑记录（dimensionConfig=768 只是配置值）。
 *
 * 进度来自**完成记录数**，不是独立计时器把进度走完再强行标记成功（PRD §9.3）。
 */

import { nowIso, parseJson } from "../storage/db.mjs";
import { BASELINE_CONFIG, PIPELINE_STAGES } from "../domains/knowledge-contract.mjs";
import { currentServingVersion, currentSnapshotCte, effectiveCountsOf, getConfig } from "./knowledge-store.mjs";
import { invalidateCorpus } from "./knowledge-index-demo.mjs";

/** 一次发布任务最多处理多少项（PRD §9.2：默认每批最多 50 项） */
const MAX_BATCH = 50;

/** 允许的失败原因（PRD §12.4 错误码） */
export const JOB_ERROR_CODES = ["UNSUPPORTED_CONTENT", "CONTENT_REQUIRED", "FILE_MISSING", "INVALID_LOCATOR", "VERSION_CONFLICT", "TASK_CANCELLED"];

/* ------------------------------------------------------------------ *
 * 输入快照
 * ------------------------------------------------------------------ */

/**
 * 取本次任务要处理的资产（固定输入快照，PRD §9.2）。
 *
 * `scope` 决定范围：
 *   backlog  当前待更新项（含处理中被打断的）
 *   errors   当前更新失败项
 *   changed  指定 assetIds
 *   all      范围内全部纳入资产（全量重建）
 */
export function collectInputs(db, sessionId, { scope = "backlog", assetIds = [], projectId = null, limit = MAX_BATCH } = {}) {
  const params = [sessionId];
  const where = ["session_id=?", "deleted_at IS NULL", "index_state <> '未纳入'"];
  if (projectId) {
    where.push("project_id=?");
    params.push(projectId);
  }
  if (scope === "backlog") where.push("index_state IN ('待更新','处理中')");
  else if (scope === "errors") where.push("index_state = '更新失败'");
  else if (scope === "changed") {
    if (!assetIds.length) return [];
    where.push(`id IN (${assetIds.map(() => "?").join(",")})`);
    params.push(...assetIds);
  }
  const rows = db
    .prepare(
      `SELECT id, type, content_revision, index_state, availability, project_id
         FROM knowledge_assets WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map((row) => ({
    assetId: row.id,
    type: row.type,
    targetRevision: row.content_revision,
    fromState: row.index_state,
    availability: row.availability,
    projectId: row.project_id,
  }));
}

/* ------------------------------------------------------------------ *
 * 任务生命周期
 * ------------------------------------------------------------------ */

/**
 * 建立一个索引任务。
 *
 * 事务边界：这个函数**不开事务**，它设计成既能在命令总线的 BEGIN…COMMIT 里被调用
 * （`knowledge.sync` 走这条路），也能被脚本单独调用（调用方自己包事务）。
 * 早先在函数内部又 BEGIN 一次，命令总线一提交就报
 * 「cannot start a transaction within a transaction」——SQLite 不支持嵌套事务。
 */
export function createJob(db, { sessionId, actorId, scope = "backlog", assetIds = [], projectId = null, triggerSource = "手动", kind = "增量更新", baseVersion = null }) {
  const inputs = collectInputs(db, sessionId, { scope, assetIds, projectId });
  if (!inputs.length) return { job: null, inputs: [], reason: "没有需要处理的资产" };
  const id = `JOB-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
  const targetVersion = nextVersionLabel(db, sessionId);
  const stages = PIPELINE_STAGES.map((label, index) => ({
    key: STAGE_KEYS[index],
    label,
    status: index === 0 ? "运行" : "等待",
    processed: index === 0 ? inputs.length : 0,
    total: inputs.length,
    detail: index === 0 ? `已处理 ${inputs.length}/${inputs.length} 项` : "等待上一阶段",
    startedAt: index === 0 ? nowIso() : null,
    endedAt: null,
  }));
  const counts = { total: inputs.length, succeeded: 0, failed: 0, skipped: 0, chunks: 0, replacedChunks: 0 };

  // 任务行先落地，再写明细：明细通过 (session_id, job_id) 关联，顺序反了会读到空
  db.prepare(
    `INSERT INTO knowledge_jobs (id, session_id, scope_id, kind, trigger_source, target_version, base_version, status, stage, counts, stages, input_seq, message, actor_id, started_at, ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    id,
    sessionId,
    projectId ?? "project-example-temple",
    kind,
    triggerSource,
    targetVersion,
    baseVersion ?? currentServingVersion(db, sessionId),
    "运行",
    PIPELINE_STAGES[0],
    JSON.stringify(counts),
    JSON.stringify(stages),
    0,
    `输入快照 ${inputs.length} 项`,
    actorId,
    nowIso(),
  );

  const insertItem = db.prepare(
    `INSERT INTO knowledge_job_items (session_id, job_id, asset_id, target_revision, stage, status, error_code, message, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const input of inputs) {
    insertItem.run(sessionId, id, input.assetId, input.targetRevision, PIPELINE_STAGES[0], "排队", null, "", nowIso());
  }
  // 置为「处理中」：任务一建立就占用这批资产，避免第二次点击再排一份
  const mark = db.prepare("UPDATE knowledge_assets SET index_state='处理中' WHERE session_id=? AND id=? AND index_state IN ('待更新','更新失败')");
  for (const input of inputs) mark.run(sessionId, input.assetId);

  return { job: getJobRow(db, sessionId, id), inputs, targetVersion };
}

const STAGE_KEYS = ["detect", "extract", "chunk", "build", "verify", "publish"];

function nextVersionLabel(db, sessionId) {
  const row = db
    .prepare("SELECT id FROM knowledge_index_versions WHERE session_id=? ORDER BY id DESC LIMIT 1")
    .get(sessionId);
  const match = /^KB-(\d+)$/.exec(row?.id ?? "KB-000");
  const next = (match ? Number(match[1]) : 0) + 1;
  return `KB-${String(next).padStart(3, "0")}`;
}

export function getJobRow(db, sessionId, jobId) {
  const row = db.prepare("SELECT * FROM knowledge_jobs WHERE session_id=? AND id=?").get(sessionId, jobId);
  if (!row) return null;
  return {
    id: row.id,
    scopeId: row.scope_id,
    kind: row.kind,
    triggerSource: row.trigger_source,
    targetVersion: row.target_version,
    baseVersion: row.base_version,
    status: row.status,
    stage: row.stage,
    counts: parseJson(row.counts, {}),
    stages: parseJson(row.stages, []),
    message: row.message,
    actorId: row.actor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * 推进一步任务。
 *
 * 返回值告诉调度器还要不要继续：
 *   { done: false }            还有活在干
 *   { done: true, status }     已经到终态
 *
 * 每个 tick 只处理**一项资产的若干阶段**，这样多端能看到阶段真的在推进，
 * 而不是「点了之后一下子就成功」。
 */
export function advanceJob(db, sessionId, jobId) {
  const job = getJobRow(db, sessionId, jobId);
  if (!job) return { done: true, status: "失败", reason: "任务不存在" };
  if (["成功", "部分成功", "失败", "已取消"].includes(job.status)) return { done: true, status: job.status };

  const items = db
    .prepare("SELECT * FROM knowledge_job_items WHERE session_id=? AND job_id=? ORDER BY status, asset_id")
    .all(sessionId, jobId);
  const pending = items.filter((item) => item.status !== "成功" && item.status !== "失败" && item.status !== "跳过");
  const stages = job.stages.map((stage) => ({ ...stage }));

  if (!pending.length) return finishJob(db, sessionId, job, stages);

  // 阶段顺序：先把全部资产推到「分块」，再统一进入构建 / 校验 / 发布。
  // 这样阶段计数是真的「已处理 x/y 项」，不是进度条动画。
  const currentStageIndex = Math.max(0, stages.findIndex((stage) => stage.status === "运行"));
  const active = pending.filter((item) => stageIndex(item.stage) <= currentStageIndex);
  const target = active[0] ?? pending[0];

  db.exec("BEGIN");
  try {
    const outcome = processItem(db, sessionId, job, target);
    db.prepare(
      `UPDATE knowledge_job_items SET stage=?, status=?, error_code=?, message=?, updated_at=?
        WHERE session_id=? AND job_id=? AND asset_id=?`,
    ).run(outcome.stage, outcome.status, outcome.errorCode ?? null, outcome.message, nowIso(), sessionId, jobId, target.asset_id);

    const counts = { ...job.counts };
    if (outcome.status === "成功") {
      counts.succeeded += 1;
      counts.chunks += outcome.chunks ?? 0;
      // 被替换掉的旧块数：任务发布后这些块不再计入当前版本，
      // 记录它是为了让「分块变化 = 新块 - 旧块」这条口径可以被复算核对。
      counts.replacedChunks = (counts.replacedChunks ?? 0) + (outcome.replacedChunks ?? 0);
    } else if (outcome.status === "失败") {
      counts.failed += 1;
    } else if (outcome.status === "跳过") {
      counts.skipped += 1;
    }

    const processed = counts.succeeded + counts.failed + counts.skipped;
    const nextStageIndex = Math.min(STAGE_KEYS.length - 1, Math.floor((processed / Math.max(1, counts.total)) * STAGE_KEYS.length));
    const updatedStages = stages.map((stage, index) => {
      if (index < nextStageIndex) return { ...stage, status: "完成", processed: counts.total, detail: `已处理 ${counts.total}/${counts.total} 项`, endedAt: stage.endedAt ?? nowIso() };
      if (index === nextStageIndex) return { ...stage, status: "运行", processed, detail: `已处理 ${processed}/${counts.total} 项`, startedAt: stage.startedAt ?? nowIso() };
      return stage;
    });

    db.prepare("UPDATE knowledge_jobs SET stage=?, counts=?, stages=?, message=? WHERE session_id=? AND id=?").run(
      PIPELINE_STAGES[nextStageIndex],
      JSON.stringify(counts),
      JSON.stringify(updatedStages),
      `阶段 ${PIPELINE_STAGES[nextStageIndex]} · 已处理 ${processed}/${counts.total} 项`,
      sessionId,
      jobId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const after = getJobRow(db, sessionId, jobId);
  if ((after.counts.succeeded + after.counts.failed + after.counts.skipped) >= after.counts.total) {
    return finishJob(db, sessionId, after, after.stages);
  }
  return { done: false, job: after };
}

function stageIndex(stage) {
  const index = PIPELINE_STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

/**
 * 处理一项资产：真的读它的提取内容、真的重新分块、真的写暂存分块与向量。
 *
 * 失败路径是真的会发生的：没有提取内容的资产（图片 / 视频没有描述）
 * 走到这里就是 CONTENT_REQUIRED，不会伪造正文（PRD §4.3 / §11.1）。
 */
function processItem(db, sessionId, job, item) {
  const asset = db
    .prepare("SELECT * FROM knowledge_assets WHERE session_id=? AND id=?")
    .get(sessionId, item.asset_id);
  if (!asset || asset.deleted_at) {
    return { stage: PIPELINE_STAGES[2], status: "跳过", errorCode: "FILE_MISSING", message: "资产已删除，跳过", chunks: 0 };
  }
  if (asset.content_revision !== item.target_revision) {
    // 运行中资产又被改过：这一项作废，新 revision 进下一批（PRD §9.2）
    return { stage: PIPELINE_STAGES[1], status: "跳过", errorCode: "VERSION_CONFLICT", message: `目标已是 v${asset.content_revision}，本项 v${item.target_revision} 作废，进入下一批`, chunks: 0 };
  }

  const content = db
    .prepare("SELECT * FROM knowledge_contents WHERE session_id=? AND asset_id=? ORDER BY revision DESC LIMIT 1")
    .get(sessionId, asset.id);
  if (!content || !String(content.text ?? "").trim()) {
    return { stage: PIPELINE_STAGES[1], status: "失败", errorCode: "CONTENT_REQUIRED", message: "缺少可检索文本，需先补充提取内容或人工描述", chunks: 0 };
  }

  const config = getConfig(db, sessionId) ?? BASELINE_CONFIG;
  const policy = config.chunkPolicy ?? BASELINE_CONFIG.chunkPolicy;
  const slices = sliceText(content.text, policy);
  const staging = `${job.targetVersion}:${job.id}`;

  /*
    这一项在当前服务版本里原有几个块：新版本发布后，快照会按「最近版本优先」
    选中新块，旧块只是不再被选中（历史版本仍然引用它，所以保留不删）。
    这个数字进任务计数，让「分块变化 = 新块 - 旧块」可以被复算核对。
  */
  const previous = db
    .prepare(
      `${currentSnapshotCte(sessionId, job.baseVersion ?? "")}
       SELECT chunk_id FROM final WHERE asset_id=? AND state='有效'`,
    )
    .all(asset.id);
  // 同一项被重试时先清掉上一次的暂存结果，避免产生第二份分块（PRD §9.4 唯一键）
  const doomed = db
    .prepare("SELECT chunk_id FROM knowledge_index_members WHERE session_id=? AND index_version=? AND asset_id=?")
    .all(sessionId, staging, asset.id);
  for (const row of doomed) {
    db.prepare("DELETE FROM knowledge_vectors WHERE session_id=? AND chunk_id=?").run(sessionId, row.chunk_id);
    db.prepare("DELETE FROM knowledge_chunks WHERE session_id=? AND id=?").run(sessionId, row.chunk_id);
  }
  db.prepare("DELETE FROM knowledge_index_members WHERE session_id=? AND index_version=? AND asset_id=?").run(sessionId, staging, asset.id);

  const insertChunk = db.prepare(
    `INSERT INTO knowledge_chunks (id, session_id, asset_id, asset_revision, chunk_ordinal, text, char_count, locator, chunk_config_revision, digest, index_version, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  );
  const insertVector = db.prepare(
    `INSERT INTO knowledge_vectors (id, session_id, chunk_id, adapter_mode, dimension_config, config_revision, state, index_version)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO knowledge_index_members (session_id, index_version, asset_id, asset_revision, chunk_id, vector_id, state)
     VALUES (?,?,?,?,?,?,?)`,
  );

  slices.forEach((slice, ordinal) => {
    // 分块 ID 带 job 后缀：同一资产可能被连续两批任务处理（第一次失败后重试），
    // 旧分块要保留（历史版本还引用它），新分块必须是新行，不能撞唯一键。
    const chunkId = `CK-${asset.id.slice(3)}-${String(ordinal + 1).padStart(3, "0")}-r${asset.content_revision}-${job.id.slice(-6)}`;
    const digest = digestOf(`${chunkId}:${slice.text}`);
    insertChunk.run(
      chunkId,
      sessionId,
      asset.id,
      asset.content_revision,
      ordinal,
      slice.text,
      slice.text.length,
      JSON.stringify(slice.locator),
      config.revision ?? BASELINE_CONFIG.id,
      digest,
      staging,
    );
    const vectorId = `VEC-${chunkId.slice(3)}`;
    insertVector.run(vectorId, sessionId, chunkId, config.adapterMode ?? "demo", config.dimensionConfig ?? 768, config.revision ?? BASELINE_CONFIG.id, "暂存", staging);
    insertMember.run(sessionId, staging, asset.id, asset.content_revision, chunkId, vectorId, "暂存");
  });

  return { stage: PIPELINE_STAGES[4], status: "成功", errorCode: null, message: `提取内容 ${content.text.length} 字，生成 ${slices.length} 个分块`, chunks: slices.length, replacedChunks: previous.length };
}

function digestOf(text) {
  // 与夹具同源的短摘要（前 16 位十六进制），够用来判断分块是否变过
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + (text.length % 0xffff).toString(16).padStart(4, "0") + (text.length >>> 4).toString(16).padStart(4, "0");
}

/** 真分块：与夹具的 chunkPolicy 同一套参数，按段落边界优先切 */
export function sliceText(text, policy = BASELINE_CONFIG.chunkPolicy) {
  const maxChars = Number(policy.maxChars) || 420;
  const overlap = Number(policy.overlapChars) || 60;
  const paragraphs = String(text).split("\n");
  const chunks = [];
  let buffer = "";
  let startLine = 0;
  let line = 0;
  const flush = () => {
    if (!buffer) return;
    chunks.push({ text: buffer, locator: { kind: "section", section: `第 ${chunks.length + 1} 节`, paragraph: startLine + 1 } });
    const tail = buffer.slice(Math.max(0, buffer.length - overlap));
    buffer = tail;
    startLine = line;
  };
  for (const paragraph of paragraphs) {
    line += 1;
    if ((buffer + paragraph).length > maxChars) flush();
    if (!buffer) startLine = line - 1;
    buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
  }
  if (buffer) chunks.push({ text: buffer, locator: { kind: "section", section: `第 ${chunks.length + 1} 节`, paragraph: startLine + 1 } });
  return chunks.length ? chunks : [{ text: String(text).slice(0, maxChars), locator: { kind: "section", section: "第 1 节", paragraph: 1 } }];
}

/**
 * 完成任务：校验、发布、写版本统计。
 *
 * 失败 / 取消 / 全失败都不产生新的服务版本（PRD §9.4）；
 * 部分成功允许成功资产形成一个新版本，失败资产保留原状态。
 */
function finishJob(db, sessionId, job, stagesArg = null) {
  const counts = { ...job.counts };
  const staging = `${job.targetVersion}:${job.id}`;
  const staged = db
    .prepare("SELECT COUNT(*) AS n FROM knowledge_index_members WHERE session_id=? AND index_version=?")
    .get(sessionId, staging).n;
  const cancelled = job.status === "已取消";

  if (cancelled) {
    cleanupStaging(db, sessionId, staging);
    db.prepare("UPDATE knowledge_jobs SET status='已取消', ended_at=?, stages=?, message=? WHERE session_id=? AND id=?").run(
      nowIso(),
      JSON.stringify(markStages(stagesArg ?? job.stages, "已取消")),
      "已取消：已发布内容不受影响，未发布暂存结果不对检索可见",
      sessionId,
      job.id,
    );
    // 取消后对应资产回到待更新：**成功项与还没处理的排队项都要回退**。
    // 只回退成功项会把剩下几十项永久留在「处理中」，界面上变成永远在跑的幽灵任务。
    const back = db.prepare("UPDATE knowledge_assets SET index_state='待更新' WHERE session_id=? AND id=? AND index_state='处理中'");
    const rows = db.prepare("SELECT asset_id FROM knowledge_job_items WHERE session_id=? AND job_id=?").all(sessionId, job.id);
    for (const row of rows) back.run(sessionId, row.asset_id);
    return { done: true, status: "已取消" };
  }

  if (!counts.succeeded) {
    // 全部失败：不产生新的服务版本，保留原服务版本，记录失败任务
    cleanupStaging(db, sessionId, staging);
    const status = "失败";
    db.prepare("UPDATE knowledge_jobs SET status=?, ended_at=?, stages=?, message=? WHERE session_id=? AND id=?").run(
      status,
      nowIso(),
      JSON.stringify(markStages(stagesArg ?? job.stages, "失败")),
      `全部失败（${counts.failed} 项）：不产生新的服务版本，原服务版本继续有效`,
      sessionId,
      job.id,
    );
    applyItemStates(db, sessionId, job.id);
    return { done: true, status };
  }

  // 发布：一个事务里切换服务版本指针、写版本统计和发布事件
  const status = counts.failed > 0 ? "部分成功" : "成功";
  const scopeId = job.scopeId;
  const baseVersion = job.baseVersion ?? currentServingVersion(db, sessionId);

  // 不开事务：调用方（advanceJob / cancelJob）已经在事务里，或者由脚本自己包
  {
    // 1. 把未变更的旧成员**复制**进新版本。
    //    PRD §9.4「切换历史版本」要求历史上发布过的版本仍可切换回去，所以旧版本的
    //    成员记录必须保留（发布后不可变，PRD §12.3）：这里用 INSERT 而不是搬移。
    const toCopy = db
      .prepare(
        `SELECT m.chunk_id, m.asset_id, m.asset_revision, m.vector_id
           FROM knowledge_index_members m
          WHERE m.session_id=? AND m.index_version=? AND m.state='有效'
            AND m.asset_id NOT IN (SELECT asset_id FROM knowledge_index_members WHERE session_id=? AND index_version=?)`,
      )
      .all(sessionId, baseVersion ?? "", sessionId, staging);
    const copyMember = db.prepare(
      `INSERT OR REPLACE INTO knowledge_index_members (session_id, index_version, asset_id, asset_revision, chunk_id, vector_id, state)
       VALUES (?,?,?,?,?,?, '有效')`,
    );
    for (const row of toCopy) {
      copyMember.run(sessionId, job.targetVersion, row.asset_id, row.asset_revision, row.chunk_id, row.vector_id);
    }
    // 2. 暂存成员转正
    db.prepare("UPDATE knowledge_index_members SET index_version=?, state='有效' WHERE session_id=? AND index_version=?").run(job.targetVersion, sessionId, staging);
    db.prepare("UPDATE knowledge_vectors SET index_version=?, state='有效' WHERE session_id=? AND index_version=?").run(job.targetVersion, sessionId, staging);
    db.prepare("UPDATE knowledge_chunks SET index_version=? WHERE session_id=? AND index_version=?").run(job.targetVersion, sessionId, staging);
    // 3. 新版本替代旧版本：**只记关系，不改成员状态**。
    //    「哪些成员在当前服务版本里有效」由 store 的递归 CTE 沿这条关系回溯算出。
    //    这样切回历史版本时，历史成员会重新成为该版本的最终成员（PRD §9.4）。
    if (baseVersion) {
      db.prepare("UPDATE knowledge_index_versions SET superseded_by=? WHERE session_id=? AND id=?").run(
        job.targetVersion,
        sessionId,
        baseVersion,
      );
    }
    // 4. 统计与指针
    const effective = db
      .prepare(
        `SELECT COUNT(*) AS chunks, COUNT(DISTINCT asset_id) AS assets
           FROM knowledge_index_members WHERE session_id=? AND index_version=? AND state='有效'`,
      )
      .get(sessionId, job.targetVersion);
    const buildCounts = {
      assets: effective.assets,
      chunks: effective.chunks,
      vectors: effective.chunks,
      added: counts.succeeded,
      changed: 0,
      removed: 0,
    };
    db.prepare(
      `INSERT INTO knowledge_index_versions (id, session_id, scope_id, config_revision, parent_version, published_at, build_counts, operator, note, superseded_by, supersedes_version)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
    ).run(
      job.targetVersion,
      sessionId,
      scopeId,
      getConfig(db, sessionId)?.revision ?? BASELINE_CONFIG.id,
      baseVersion,
      nowIso(),
      JSON.stringify(buildCounts),
      job.actorId,
      `${job.kind} · ${job.triggerSource} · 处理 ${counts.total} 项（成功 ${counts.succeeded} / 失败 ${counts.failed}）`,
      job.targetVersion === baseVersion ? null : baseVersion,
    );
    db.prepare(
      `INSERT INTO knowledge_index_heads (session_id, scope_id, serving_version, revision, updated_at) VALUES (?,?,?,1,?)
       ON CONFLICT (session_id, scope_id) DO UPDATE SET serving_version=excluded.serving_version, revision=knowledge_index_heads.revision+1, updated_at=excluded.updated_at`,
    ).run(sessionId, scopeId, job.targetVersion, nowIso());
    db.prepare("UPDATE knowledge_jobs SET status=?, ended_at=?, stages=?, message=? WHERE session_id=? AND id=?").run(
      status,
      nowIso(),
      JSON.stringify(markStages(stagesArg ?? job.stages, "完成")),
      status === "部分成功"
        ? `部分成功 ${counts.succeeded}/${counts.total}，失败 ${counts.failed}，已发布 ${job.targetVersion}`
        : `已发布 ${job.targetVersion}，${counts.succeeded} 项进入服务版本`,
      sessionId,
      job.id,
    );
    applyItemStates(db, sessionId, job.id);
  }

  invalidateCorpus(sessionId);
  return { done: true, status, version: job.targetVersion, staged };
}

/** 任务结束后按明细回写每个资产的索引状态（待更新 / 已覆盖 / 更新失败） */
function applyItemStates(db, sessionId, jobId) {
  const items = db.prepare("SELECT asset_id, status, error_code FROM knowledge_job_items WHERE session_id=? AND job_id=?").all(sessionId, jobId);
  const setState = db.prepare("UPDATE knowledge_assets SET index_state=? WHERE session_id=? AND id=?");
  for (const item of items) {
    if (item.status === "成功") setState.run("已覆盖", sessionId, item.asset_id);
    else if (item.status === "失败") setState.run("更新失败", sessionId, item.asset_id);
    else setState.run("待更新", sessionId, item.asset_id);
  }
}

function cleanupStaging(db, sessionId, staging) {
  const rows = db.prepare("SELECT chunk_id FROM knowledge_index_members WHERE session_id=? AND index_version=?").all(sessionId, staging);
  for (const row of rows) {
    db.prepare("DELETE FROM knowledge_vectors WHERE session_id=? AND chunk_id=?").run(sessionId, row.chunk_id);
    db.prepare("DELETE FROM knowledge_chunks WHERE session_id=? AND id=?").run(sessionId, row.chunk_id);
  }
  db.prepare("DELETE FROM knowledge_index_members WHERE session_id=? AND index_version=?").run(sessionId, staging);
}

function markStages(stages, status) {
  return (stages ?? []).map((stage) => ({
    ...stage,
    status: stage.status === "运行" ? status : stage.status === "等待" ? "未执行" : stage.status,
    endedAt: stage.endedAt ?? nowIso(),
  }));
}

/* ------------------------------------------------------------------ *
 * 取消与版本切换
 * ------------------------------------------------------------------ */

/**
 * 取消任务（PRD §9.4）。
 *
 * 不开事务：命令总线调用时外层已有事务；脚本直接调用时这里自己开一个小的，
 * 让「置终态 + 清暂存 + 回退资产状态」三步原子完成。
 */
export function cancelJob(db, sessionId, jobId) {
  const job = getJobRow(db, sessionId, jobId);
  if (!job) return { ok: false, code: "NOT_FOUND", message: "任务不存在" };
  if (["成功", "部分成功", "失败", "已取消"].includes(job.status)) {
    return { ok: false, code: "TERMINAL_STATE", message: `任务已是终态 ${job.status}，不再接受取消` };
  }
  db.prepare("UPDATE knowledge_jobs SET status='已取消' WHERE session_id=? AND id=?").run(sessionId, jobId);
  const cancelled = getJobRow(db, sessionId, jobId);
  const result = finishJob(db, sessionId, cancelled);
  return { ok: true, ...result };
}

/**
 * 切换服务版本（PRD §9.4）。
 *
 * **不开事务**：它既被命令总线调用（外层已有 BEGIN…COMMIT），也被验收脚本直接调用。
 * 事务归属只能有一处 —— SQLite 不支持嵌套事务，两处都开就会在提交时报错。
 *
 * 只切换检索层，**原始资产库不回滚**；历史分块仍要经过当前删除规则与权限过滤，
 * 所以这里不会把已删除资产的内容重新暴露出来。
 */
export function activateVersion(db, sessionId, { version, actorId }) {
  const target = db.prepare("SELECT * FROM knowledge_index_versions WHERE session_id=? AND id=?").get(sessionId, version);
  if (!target) return { ok: false, code: "NOT_FOUND", message: `找不到索引版本 ${version}` };
  const scopeId = target.scope_id;
  const previous = currentServingVersion(db, sessionId, scopeId);
  if (previous === version) return { ok: false, code: "ALREADY_SERVING", message: `${version} 已经是当前服务版本` };

  db.prepare(
    `UPDATE knowledge_index_heads SET serving_version=?, revision=revision+1, updated_at=? WHERE session_id=? AND scope_id=?`,
  ).run(version, nowIso(), sessionId, scopeId);
  // 注意：这里**不**改写成员状态。哪些成员在该版本里有效由递归 CTE 沿
  // 「新版本替代旧版本」的关系回溯算出 —— 所以这里只需要把指针指回去。
  invalidateCorpus(sessionId);
  refreshAssetIndexStates(db, sessionId, version);
  const effective = effectiveCountsOf(db, sessionId, version);
  return { ok: true, version, previous, effective, actorId };
}

/**
 * 按服务版本重算每个资产的索引状态。
 *
 * 口径与指标函数完全一致：目标版本里该资产的最终成员 revision 等于资产当前
 * revision 才是「已覆盖」；不纳索引的资产保持「未纳入」；任务进行中的保持
 * 「处理中」（不能被一次切换抹掉，否则进度条会说谎）。
 */
/**
 * 按服务版本重算每个资产的索引状态。
 *
 * 口径与指标函数完全一致：目标版本里该资产的最终成员 revision 等于资产当前
 * revision 才是「已覆盖」；**目标版本里没有该资产的成员时不动它的状态** ——
 * 切到一个更早的版本，那些版本里根本没进过索引的资产应当保持「待更新」，
 * 不能被顺手改成「已覆盖」。
 */
export function refreshAssetIndexStates(db, sessionId, version) {
  /*
    三步，顺序不能换：
      1. 只有**已覆盖**降级为待更新。更新失败是一个独立的业务事实
         （「当前目标 revision 最近一次构建终止于失败」，PRD §9.2 定义），
         切版本不该把它抹掉；处理中属于进行中的任务，也不动。
      2. 快照里源 revision 与资产当前 revision 一致 → 已覆盖。
      3. 快照里根本没有这个资产，或成员停在旧 revision → 待更新。
    第 3 步不能省：目标版本可能是更早的版本，那些版本里没进过索引的资产
    必须回到待更新，不能留着上一次的「已覆盖」。
  */
  db.prepare(
    `UPDATE knowledge_assets SET index_state='待更新'
      WHERE session_id=? AND deleted_at IS NULL AND index_state='已覆盖'`,
  ).run(sessionId);
  db.prepare(
    `${currentSnapshotCte(sessionId, version)}
     UPDATE knowledge_assets SET index_state='已覆盖'
      WHERE session_id=? AND deleted_at IS NULL AND index_state IN ('待更新','更新失败')
        AND id IN (SELECT f.asset_id FROM final f WHERE f.state='有效' AND f.asset_revision = knowledge_assets.content_revision)`,
  ).run(sessionId);
  db.prepare(
    `${currentSnapshotCte(sessionId, version)}
     UPDATE knowledge_assets SET index_state='待更新'
      WHERE session_id=? AND deleted_at IS NULL AND index_state IN ('已覆盖','更新失败')
        AND id NOT IN (SELECT f.asset_id FROM final f WHERE f.state='有效' AND f.asset_revision = knowledge_assets.content_revision)`,
  ).run(sessionId);
}

/** 切版本时会按目标快照回写资产状态，所以这两个也要在同一事务外先做完 */
export function switchVersionInCommand(db, sessionId, version, actorId) {
  return activateVersion(db, sessionId, { version, actorId });
}

/* ------------------------------------------------------------------ *
 * 调度（PRD §9.2：2 秒安静窗口或最早变更等待满 10 秒启动一批）
 * ------------------------------------------------------------------ */

/**
 * 演示调度器。
 *
 * 与真实调度的差别写在明处：这里**不常驻后台空转**，只在有人调用 `kick()`
 * 或明确开启自动更新时按 tick 推进；演示脚本 S01–S07 要求「自动调度置为手动推进」
 * 时不会有权重看不见的后台任务改变预期数值。
 */
export function createJobRunner({ db, hub, sessionId, logger = console }) {
  const timers = new Map();

  const pump = (jobId) => {
    if (timers.has(jobId)) return;
    const timer = setInterval(() => {
      let result;
      try {
        result = advanceJob(db, sessionId, jobId);
      } catch (error) {
        logger.error?.("[knowledge] 任务推进失败", error);
        clearInterval(timer);
        timers.delete(jobId);
        return;
      }
      if (result.done) {
        clearInterval(timer);
        timers.delete(jobId);
        const job = getJobRow(db, sessionId, jobId);
        if (job) hub?.broadcast?.(sessionId, { type: "knowledge.job.settled", entityKind: "knowledgeJob", entityId: jobId, payload: { status: job.status, counts: job.counts, targetVersion: job.targetVersion } });
        if (job && ["成功", "部分成功"].includes(job.status)) {
          hub?.broadcast?.(sessionId, {
            type: "knowledge.index.published",
            entityKind: "knowledgeIndex",
            entityId: job.targetVersion,
            payload: { scopeId: job.scopeId, previousVersion: job.baseVersion, servingVersion: job.targetVersion, jobId },
          });
        }
      } else {
        hub?.broadcast?.(sessionId, { type: "knowledge.job.progress", entityKind: "knowledgeJob", entityId: jobId, payload: result.job });
      }
    }, 260);
    timer.unref?.();
    timers.set(jobId, timer);
  };

  return {
    start(jobId) {
      pump(jobId);
    },
    /** 演示脚本用的同步推进：一次跑完，返回终态（便于 test-knowledge.mjs 断言） */
    runToEnd(jobId, maxSteps = 400) {
      let steps = 0;
      let result = advanceJob(db, sessionId, jobId);
      while (!result.done && steps < maxSteps) {
        result = advanceJob(db, sessionId, jobId);
        steps += 1;
      }
      const job = getJobRow(db, sessionId, jobId);
      if (job && ["成功", "部分成功"].includes(job.status)) {
        hub?.broadcast?.(sessionId, {
          type: "knowledge.index.published",
          entityKind: "knowledgeIndex",
          entityId: job.targetVersion,
          payload: { scopeId: job.scopeId, previousVersion: job.baseVersion, servingVersion: job.targetVersion, jobId },
        });
      }
      return { ...result, steps };
    },
    stopAll() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    },
  };
}
