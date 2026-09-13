/**
 * 数据与知识中心 · 存储与夹具安装
 *
 * 依据：PRD §12.3（领域模型与数据表）、§12.6（文件与内容处理限制）、
 *      §11.2（夹具两层：可深入展示样本 + 规模样本）。
 *
 * 这一层只做三件事：把夹具**真的**写进库、把库里的事实读出来、把知识域从会话里清空。
 * 指标口径与检索算法分别在 knowledge-query.mjs / knowledge-index-demo.mjs。
 *
 * 性能约束（PRD §16.4）：安装夹具是 3.8 万行级别的批量写，必须在一个事务里
 * 用预编译语句完成；不能一行一个事务，那样首屏要等十几秒。
 */

import { nowIso, parseJson } from "../storage/db.mjs";
import {
  BASELINE_CONFIG,
  BASELINE_CONFIG_REVISION,
  BASELINE_PUBLISHED_AT,
  BASELINE_ROWS,
  BASELINE_SERVING_VERSION,
  BASELINE_VERSIONS,
  DEFAULT_SCOPE,
  DEMO_SCENARIO_ID,
} from "../domains/knowledge-contract.mjs";
import { buildKnowledgeFixture } from "../fixtures/knowledge.mjs";

/** 知识域涉及的全部表；重置会话时按此顺序清空（先明细后主表） */
const KNOWLEDGE_TABLES = [
  "knowledge_job_items",
  "knowledge_jobs",
  "knowledge_index_members",
  "knowledge_index_versions",
  "knowledge_index_heads",
  "knowledge_vectors",
  "knowledge_chunks",
  "knowledge_contents",
  "knowledge_relations",
  "knowledge_asset_revisions",
  "knowledge_assets",
  "knowledge_scale",
  "knowledge_configs",
  "knowledge_scopes",
  "knowledge_seeds",
];

export function clearKnowledge(db, sessionId) {
  for (const table of KNOWLEDGE_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
  }
}

export function knowledgeInstalled(db, sessionId) {
  const row = db.prepare("SELECT scenario_id, seed, report FROM knowledge_seeds WHERE session_id=?").get(sessionId);
  if (!row) return null;
  return { scenarioId: row.scenario_id, seed: row.seed, report: parseJson(row.report, {}) };
}

/**
 * 规模样本的说明文字（写进 `knowledge_scale.note`）。
 *
 * 放在安装函数**之前**：这些文字是安装夹具时逐类写入的，读者先看到台账、
 * 再看到写入点，比翻到文件末尾才知道 note 从哪来更顺。
 * 每一条都要回答界面上的那句「为什么这一类只有一部分能点开」。
 */
const SCALE_NOTES = {
  document: "规模样本：历史归档的同类报告与档案，只参与统计",
  image: "规模样本：现场照片按批次归档，只有带审核描述的部分纳入索引",
  video: "规模样本：巡检录像按批次归档，只有带转写片段的纳入索引",
  scanData: "规模样本：扫描仪原始数据，本期只登记与统计，不做文本提取",
  gaussian: "规模样本：高斯泼溅训练产物，来源可追溯但不做文本检索",
  modelFile: "规模样本：历史建模与建图产物，未补提取说明",
  pointCloud: "规模样本：点云数据，本期只登记与统计",
  modelWeight: "规模样本：历史模型权重，只登记版本与来源",
  audio: "规模样本：现场录音，未附转写片段",
  workOrder: "规模样本：历史工单归档",
  logBatch: "规模样本：设备原始调试日志，未纳入索引",
  record: "规模样本：历史业务记录归档",
};

/**
 * 规模样本的可用性：**一律「可用」**，这是刻意的。
 *
 * 「待补充内容」在这个域里的含义是「**这一条明细**还没有可检索内容」（PRD §9.1），
 * 是一个逐条记录的判断。规模样本没有可判断的单条记录（连文件名都没有生成），
 * 它们在平台里就是已登记、在架的历史归档 —— 把 16 万条规模样本标成「待补充内容」，
 * 等于凭空造出一堆待办，总览上会出现「待补充 16.6 万」这种假积压。
 * 它们真正缺的东西由 `note` 说清楚（「只参与统计，不提供逐条明细」）。
 */
const SCALE_AVAILABILITY = "可用";

/**
 * 规模样本的来源：按各主类的归档口径给，不是随手填的默认值。
 *
 * 与明细层同一套判断：扫描 / 点云 / 照片 / 视频 / 日志 / 音频由巡检设备产出，
 * 文档类里报告与检测表来自平台业务、其余是历史归档；工单、业务记录、模型
 * 与权重都是平台自己产生的。分布图因此能反映「平台的资料是从哪来的」，
 * 而不是「哪一类恰好被生成器展开过」。
 */
const SCALE_SOURCES = {
  document: "历史归档",
  image: "巡检设备",
  video: "巡检设备",
  scanData: "巡检设备",
  gaussian: "平台业务",
  modelFile: "平台业务",
  pointCloud: "巡检设备",
  modelWeight: "平台业务",
  audio: "巡检设备",
  workOrder: "平台业务",
  logBatch: "巡检设备",
  record: "平台业务",
};

/**
 * 安装 knowledge-demo-v1 夹具。
 *
 * `force` 用于「重置整个演示场景」（PRD §13：console:admin 在排练控制台执行），
 * 普通启动只在没有种子记录时安装，绝不覆盖演示中已经被改过的数据。
 *
 * 注意：这里**不**碰平台原有工单、设备、归档文件或其它会话（PRD §15）。
 */
export function installKnowledgeFixture(db, { sessionId, seed = 20260913, anchor = null, force = false } = {}) {
  const existing = knowledgeInstalled(db, sessionId);
  if (existing && !force) return { created: false, ...existing };

  const fixture = buildKnowledgeFixture({ sessionId, seed, anchor });
  if (fixture.report.errors.length) {
    // 夹具自身不满足 PRD §7.1 的等式：直接失败，绝不把错的基线装进库
    throw new Error(`knowledge-demo-v1 夹具自检未通过：${fixture.report.errors.join("；")}`);
  }

  /*
    列名清单与 VALUES 的 `?` 必须**逐个对齐**（31 列 + 末尾写死的 deleted_at NULL = 32）。
    这里少了任何一个 `?`，SQLite 会在 prepare 时直接抛「N values for M columns」——
    夹具根本装不进去，而且报错点离真正的原因很远（改列时最容易漏的就是 filename /
    materialized 这两个新增列）。
  */
  const insertAsset = db.prepare(
    `INSERT INTO knowledge_assets (id, session_id, project_id, type, title, filename, materialized, format, business_categories,
      source_system, source_entity_id, main_source, content_revision, metadata_revision, availability,
      index_state, excluded_reason, size_bytes, object_ids, primary_object_id, building_id, zone,
      captured_at, imported_at, updated_at, owner, summary, text_mode, sha256, file_id, extra, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  );
  const insertScale = db.prepare(
    `INSERT INTO knowledge_scale (session_id, type, count, note, availability, main_source) VALUES (?,?,?,?,?,?)`,
  );
  const insertRevision = db.prepare(
    `INSERT INTO knowledge_asset_revisions (session_id, asset_id, revision, file_id, content_hash, text_ref, content_mode, kind, label, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO knowledge_relations (id, session_id, project_id, from_id, to_id, relation_type, evidence_ref, origin)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insertContent = db.prepare(
    `INSERT INTO knowledge_contents (id, session_id, asset_id, revision, mode, text, locator_kind, extraction_mode)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
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
  const insertVersion = db.prepare(
    `INSERT INTO knowledge_index_versions (id, session_id, scope_id, config_revision, parent_version, published_at, build_counts, operator, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertConfig = db.prepare(
    `INSERT INTO knowledge_configs (id, session_id, revision, inclusion_rules, chunk_policy, aggregate_window, auto_sync, adapter_mode, dimension_config, search, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertScope = db.prepare(
    `INSERT INTO knowledge_scopes (session_id, id, label, meta) VALUES (?,?,?,?)`,
  );
  const insertSeed = db.prepare(
    `INSERT INTO knowledge_seeds (session_id, scenario_id, seed, report, installed_at) VALUES (?,?,?,?,?)`,
  );

  db.exec("BEGIN");
  try {
    clearKnowledge(db, sessionId);

    insertScope.run(sessionId, DEFAULT_SCOPE.id, DEFAULT_SCOPE.label, JSON.stringify({ buildings: DEFAULT_SCOPE.buildingIds }));

    // 规模样本：把「总量 − 可展开明细」的差额按主类落库。
    // 落库而不是写常量，是因为指标与分布查询要能把它当成事实读出来（见 knowledge_scale）。
    // 每一类都写：`total > materialized` 就是规模样本存在；差额为 0 的类不写空行。
    for (const row of BASELINE_ROWS) {
      const scale = row.total - row.materialized;
      if (scale <= 0) continue;
      insertScale.run(
        sessionId,
        row.type,
        scale,
        SCALE_NOTES[row.type] ?? "规模样本：只参与统计，不提供逐条明细",
        SCALE_AVAILABILITY,
        SCALE_SOURCES[row.type] ?? "历史归档",
      );
    }

    for (const asset of fixture.assets) {
      const extra = {
        ...(asset.durationSec ? { durationSec: asset.durationSec } : {}),
        ...(asset.lineCount ? { lineCount: asset.lineCount } : {}),
        ...(asset.windowFrom ? { windowFrom: asset.windowFrom, windowTo: asset.windowTo } : {}),
        ...(asset.orderNo ? { orderNo: asset.orderNo, orderState: asset.orderState } : {}),
      };
      const state = INDEX_STATE_TO_DB[asset.indexState] ?? asset.indexState;
      insertAsset.run(
        asset.id,
        sessionId,
        asset.projectId,
        asset.type,
        asset.title,
        asset.filename ?? null,
        1,
        asset.format,
        JSON.stringify(asset.businessCategories ?? []),
        asset.sourceSystem,
        asset.sourceEntityId,
        asset.mainSource,
        asset.contentRevision,
        asset.metadataRevision,
        asset.availability,
        state,
        asset.excludedReason ?? null,
        asset.sizeBytes ?? 0,
        JSON.stringify(asset.objectIds ?? []),
        asset.primaryObjectId ?? null,
        asset.buildingId ?? null,
        asset.zone ?? null,
        asset.capturedAt ?? null,
        asset.importedAt ?? null,
        asset.updatedAt,
        asset.owner ?? null,
        asset.summary ?? "",
        asset.textMode ?? "none",
        asset.sha256 ?? null,
        asset.fileId ?? null,
        JSON.stringify(extra),
      );
      // 版本历史：基线资产按 `revisionCount` 补代次记录（内容不可原地覆盖）。
      // 用 revisionCount 而不是 contentRevision：待更新项的内容版本会大于
      // 成员版本，两者都要有对应的版本行，否则「历史」页签会对不上号。
      for (let revision = 1; revision <= (asset.revisionCount ?? asset.contentRevision); revision += 1) {
        insertRevision.run(
          sessionId,
          asset.id,
          revision,
          asset.fileId ?? null,
          asset.sha256 ?? null,
          `/assets/${asset.id}/revisions/${revision}`,
          asset.textMode ?? "none",
          revision === 1 ? "registered" : "revise",
          revision === asset.contentRevision ? "当前版本" : `历史版本 v${revision}`,
          asset.owner ?? null,
          revision === asset.contentRevision ? asset.updatedAt : asset.capturedAt ?? asset.updatedAt,
        );
      }
    }

    for (const relation of fixture.relations) {
      insertRelation.run(relation.id, sessionId, DEFAULT_SCOPE.id, relation.fromId, relation.toId, relation.relationType, relation.evidenceRef, relation.origin);
    }

    for (const content of fixture.contents) {
      insertContent.run(content.id, sessionId, content.assetId, content.revision, content.mode, content.text, content.locatorKind, "fixture");
    }

    for (const chunk of fixture.chunks) {
      insertChunk.run(
        chunk.id,
        sessionId,
        chunk.assetId,
        chunk.assetRevision,
        chunk.chunkOrdinal,
        chunk.text,
        chunk.charCount,
        JSON.stringify(chunk.locator),
        chunk.chunkConfigRevision,
        chunk.digest,
        chunk.indexVersion,
      );
    }

    for (const vector of fixture.vectors) {
      insertVector.run(vector.id, sessionId, vector.chunkId, vector.adapterMode, vector.dimensionConfig, vector.configRevision, vector.state, vector.indexVersion);
    }

    for (const member of fixture.indexMembers) {
      insertMember.run(sessionId, member.indexVersion, member.assetId, member.assetRevision, member.chunkId, member.vectorId, "有效");
    }

    for (const version of BASELINE_VERSIONS) {
      insertVersion.run(
        version.id,
        sessionId,
        version.scopeId,
        version.configRevision,
        version.parentVersion ?? null,
        version.publishedAt,
        JSON.stringify(version.buildCounts),
        version.operator,
        version.note,
      );
    }

    db.prepare(
      `INSERT INTO knowledge_index_heads (session_id, scope_id, serving_version, revision, updated_at) VALUES (?,?,?,?,?)`,
    ).run(sessionId, DEFAULT_SCOPE.id, BASELINE_SERVING_VERSION, 1, BASELINE_PUBLISHED_AT);

    insertConfig.run(
      BASELINE_CONFIG.id,
      sessionId,
      BASELINE_CONFIG.id,
      JSON.stringify(BASELINE_CONFIG.inclusionRules),
      JSON.stringify(BASELINE_CONFIG.chunkPolicy),
      JSON.stringify(BASELINE_CONFIG.aggregateWindow),
      BASELINE_CONFIG.autoSync ? 1 : 0,
      BASELINE_CONFIG.adapterMode,
      BASELINE_CONFIG.dimensionConfig,
      JSON.stringify(BASELINE_CONFIG.search),
      "shi",
      BASELINE_PUBLISHED_AT,
    );

    insertSeed.run(sessionId, DEMO_SCENARIO_ID, seed, JSON.stringify(fixture.report), nowIso());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { created: true, scenarioId: DEMO_SCENARIO_ID, seed, report: fixture.report };
}

/** 生成器内部英文枚举 → 落库中文状态（PRD §9.1） */
const INDEX_STATE_TO_DB = {
  covered: "已覆盖",
  pending: "待更新",
  error: "更新失败",
  processing: "处理中",
  excluded: "未纳入",
};

/* ------------------------------------------------------------------ *
 * 读：资产
 * ------------------------------------------------------------------ */

/** 数据库行 → 接口资产 DTO（字段名与前端 types.ts 一致） */
export function assetFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    // 原始文件名：列表与详情要显示「哪一份文件」，也是规模样本与明细的直观区别之一
    filename: row.filename ?? null,
    /*
      materialized 以**布尔**返回（库里是 0/1）。
      界面靠它决定「这一条能不能点开、能不能显示分块」：规模样本只贡献计数，
      没有文件名 / 版本 / 分块，把它按明细渲染就会出现点开是空壳的条目。
    */
    materialized: row.materialized !== 0,
    format: row.format,
    businessCategories: parseJson(row.business_categories, []),
    sourceSystem: row.source_system,
    sourceEntityId: row.source_entity_id,
    mainSource: row.main_source,
    contentRevision: row.content_revision,
    metadataRevision: row.metadata_revision,
    revision: row.content_revision,
    availability: row.availability,
    indexState: row.index_state,
    excludedReason: row.excluded_reason,
    sizeBytes: row.size_bytes,
    objectIds: parseJson(row.object_ids, []),
    primaryObjectId: row.primary_object_id,
    buildingId: row.building_id,
    zone: row.zone,
    capturedAt: row.captured_at,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
    owner: row.owner,
    summary: row.summary,
    textMode: row.text_mode,
    sha256: row.sha256,
    fileId: row.file_id,
    deletedAt: row.deleted_at,
    indexedRevision: row.indexed_revision ?? null,
    indexedVersion: row.indexed_version ?? null,
    chunkCount: row.chunk_count ?? 0,
    extra: parseJson(row.extra, {}),
  };
}

/**
 * 资产筛选条件的**唯一**构造处。
 *
 * 列表查询与计数查询共用这一段。早先两边各写一份，计数那份只认项目 / 类型 / 索引状态，
 * 于是按业务分类或来源筛选时，列表里是对的资料、右上角的总数却是全量
 * （1,500）—— 数字与列表对不上，比没有这个数字更糟。
 *
 * `alias` 是表别名：列表查询里资产表别名为 `a`，计数时没有别名。
 *
 * **两个开关，管两件不同的事**（早先混成一个，导致「共 240 项」把平台规模藏掉了）：
 *   · `rowsMaterializedOnly` —— 管**列表行**：默认 true，只返回有明细记录的资产。
 *     规模样本没有文件名、没有版本、没有分块，混进列表里点开就是空壳，所以永远不能列。
 *   · `filters.countScale`     —— 管**计数**：true 时把规模样本一起数进来，
 *     得到「整个筛选范围内的总量」。界面要显示的是「共 54,160 项 · 其中 240 项可展开明细」，
 *     只数明细会把平台规模说小，两层数据模型就没有意义了。
 * 名字写全、不共用同一个字段，是因为两者口径可以同时成立：
 * 「总量数两层的、列表只列明细」才是默认行为。
 */
function buildAssetWhere({ sessionId, filters = {}, alias = "", materializedRowsOnly = false }) {
  const p = alias ? `${alias}.` : "";
  const where = [`${p}session_id = ?`, `${p}deleted_at IS NULL`];
  const params = [sessionId];
  if (materializedRowsOnly) where.push(`${p}materialized = 1`);
  if (filters.projectId) {
    where.push(`${p}project_id = ?`);
    params.push(filters.projectId);
  }
  if (filters.type) {
    where.push(`${p}type = ?`);
    params.push(filters.type);
  }
  if (filters.objectId) {
    where.push(`(${p}primary_object_id = ? OR ${p}object_ids LIKE ?)`);
    params.push(filters.objectId, `%"${filters.objectId}"%`);
  }
  if (filters.source) {
    where.push(`${p}main_source = ?`);
    params.push(filters.source);
  }
  if (filters.category) {
    where.push(`${p}business_categories LIKE ?`);
    params.push(`%"${filters.category}"%`);
  }
  if (filters.indexState) {
    where.push(`${p}index_state = ?`);
    params.push(filters.indexState);
  }
  if (filters.availability) {
    where.push(`${p}availability = ?`);
    params.push(filters.availability);
  }
  if (filters.timeFrom) {
    where.push(`${p}updated_at >= ?`);
    params.push(filters.timeFrom);
  }
  if (filters.timeTo) {
    where.push(`${p}updated_at <= ?`);
    params.push(filters.timeTo);
  }
  if (filters.query) {
    /*
      关键词同时匹配名称、摘要、来源编号、资产编号、关联对象与业务分类。
      只匹配前四项时，输入「Z04」或「修缮工艺」会返回 0 条 —— 而这两个恰恰是
      用户最可能输的东西（对象编号与业务分类在界面上到处都是）。
      正文里的词走「检索验证」页的词项检索，不在这个筛选框里做全表扫描。
    */
    const like = `%${filters.query}%`;
    where.push(
      `(${p}title LIKE ? OR ${p}summary LIKE ? OR ${p}source_entity_id LIKE ? OR ${p}id LIKE ?`
        + ` OR ${p}primary_object_id LIKE ? OR ${p}object_ids LIKE ? OR ${p}business_categories LIKE ?)`,
    );
    params.push(like, like, like, like, like, like, like);
  }
  return { clause: where.join(" AND "), params };
}

/**
 * 资产列表查询（PRD §5.3 默认筛选与分页）。
 *
 * 排序固定 `updated_at DESC, id DESC`：分页游标要稳定，两个不同资产在同一
 * 秒被写入时不能出现「翻页重复或漏项」。
 *
 * 返回**两个**总数，不能合成一个（PRD §11.2 的「共 N 项 · 其中 M 项可展开明细」）：
 *   · `total`        —— 筛选范围内的全部资产，含只贡献计数的规模样本；
 *   · `materialized` —— 其中有明细记录、能在列表里点开的条数（默认只列出这些）。
 */
export function queryAssets(db, sessionId, filters = {}) {
  /*
    列表行**永远**只列有明细记录的资产（materializedRowsOnly）。
    这与下面计数用的 countScale 是两件事：总量要数两层，列表只能列能点开的那一层。
  */
  const { clause, params } = buildAssetWhere({ sessionId, filters, alias: "a", materializedRowsOnly: true });
  // 游标条件与其他筛选拼在同一段 WHERE 里。游标值是上一页最后一行的排序键
  // (updated_at, id)，展开成三处占位符 —— SQLite 不能在一个 `?` 里绑定元组。
  const cursorAt = filters.cursor ? String(filters.cursor).split("|")[0] : null;
  const cursorId = filters.cursor ? String(filters.cursor).split("|")[1] : null;
  const where = cursorAt
    ? `${clause} AND (a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))`
    : clause;
  if (cursorAt) params.push(cursorAt, cursorAt, cursorId);

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const serving = currentServingVersion(db, sessionId);
  const rows = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.session_id=a.session_id AND c.asset_id=a.id AND c.deleted_at IS NULL) AS chunk_count,
              m.asset_revision AS indexed_revision,
              m.index_version  AS indexed_version
         FROM knowledge_assets a
         LEFT JOIN (${memberSnapshotSql(sessionId, serving)}) m
                ON m.asset_id = a.id
        WHERE ${where}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ?`,
    )
    .all(...params, limit);

  /*
    hasMore 必须**带上同样的筛选条件**再问一句「还有没有下一行」，而且必须是
    **同一套行口径**（materializedRowsOnly）：拿数两层的条件去问，翻页会问出一批
    永远列不出来的规模样本，用户点「加载更多」拿到空页 ——
    说好的翻页能力与实际列表不一致。
  */
  let more = null;
  const last = rows[rows.length - 1];
  if (last) {
    const tail = buildAssetWhere({ sessionId, filters, materializedRowsOnly: true });
    more = db
      .prepare(
        `SELECT 1 AS n FROM knowledge_assets
          WHERE ${tail.clause} AND (updated_at < ? OR (updated_at = ? AND id < ?))
          LIMIT 1`,
      )
      .get(...tail.params, last.updated_at, last.updated_at, last.id);
  }

  const items = rows.map(assetFromRow);
  return {
    items,
    hasMore: Boolean(more),
    nextCursor: more && last ? `${last.updated_at}|${last.id}` : null,
    /*
      两个总数必须分开给，且**口径不同**（PRD §11.2「共 N 项 · 其中 M 项可展开明细」）：
        total        —— 筛选范围内的**全部**资产，含只贡献计数的规模样本
                        （countScale: true，数两层）；
        materialized —— 其中有明细记录、能在列表里点开的条数（与 items 同一口径）。
      只给 materialized 会把平台规模说小：按「现场照片」筛选时界面会写「共 240 项」，
      而平台里这一类的真实规模是 54,160 —— 那正是两层数据模型要展示的东西。
      只给 total 又会出现「说 54,160 项却只列出 50 条」的困惑。
    */
    total: countAssets(db, sessionId, { ...filters, countScale: true }),
    materialized: countAssets(db, sessionId, filters),
  };
}

/**
 * 规模样本：按主类的计数层（不可展开的那部分），指标要把它算进总量。
 *
 * 除了按主类的 `byType`，还按**可用性 / 来源**各汇总一份：总览的两张分布图
 * 要数平台里的全部资料，而规模样本不在 knowledge_assets 里，
 * 分布查询必须能把这两个维度一起读出来，否则各状态相加对不上 `metrics.total`。
 */
export function readScale(db, sessionId) {
  const rows = db
    .prepare("SELECT type, count, note, availability, main_source FROM knowledge_scale WHERE session_id=?")
    .all(sessionId);
  const byType = new Map(
    rows.map((row) => [row.type, { count: row.count, note: row.note, availability: row.availability, mainSource: row.main_source }]),
  );
  return {
    byType,
    total: rows.reduce((sum, row) => sum + row.count, 0),
    notes: rows.map((row) => ({ type: row.type, count: row.count, note: row.note })),
    // 分布口径：与 groupCount 的返回结构一致（key + n），调用方可以直接合并
    availability: tally(rows, "availability"),
    sources: tally(rows, "main_source"),
  };
}

/** 把规模样本行按某一列汇总成 [{ key, n }]，与 groupCount 的输出同形 */
function tally(rows, column) {
  const counts = new Map();
  for (const row of rows) {
    const key = row[column] ?? "未标注";
    counts.set(key, (counts.get(key) ?? 0) + row.count);
  }
  return [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

/**
 * 资产计数：与列表共用同一段筛选条件，数字与列表永远对得上。
 *
 * **只数有明细记录的资产**，也就是与列表里的行同一口径 ——
 * 这个函数回答的是「能列出多少条」，所以它天然配合 `queryAssets().materialized`。
 *
 * 要「筛选范围内的总量」（含规模样本）就传 `filters.countScale: true`。
 * 规模样本在 knowledge_scale 里是**按主类**的一行计数，除了类型 / 来源 / 可用性，
 * 没有项目 / 关联对象 / 业务分类 / 索引状态 / 日期这些逐条维度。所以只有筛选条件
 * 全部落在它能表达的维度上（并且不是按关键词查）时才把规模样本加进来；
 * 否则如实只数明细 —— 宁可数字小一点，也不能把不满足条件的规模样本算进去，
 * 那会让「总数 − 明细数」不再等于该类规模样本，界面上的两个数字互相矛盾。
 */
export function countAssets(db, sessionId, filters = {}) {
  const { clause, params } = buildAssetWhere({ sessionId, filters });
  const assetCount = db.prepare(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE ${clause}`).get(...params).n;
  if (!filters.countScale) return assetCount;
  // 只有这几个维度规模样本也有：其余筛选（对象 / 分类 / 状态 / 日期 / 关键词）下不加
  if (["objectId", "category", "indexState", "timeFrom", "timeTo", "query"].some((key) => filters[key])) return assetCount;
  const scaleRows = db
    .prepare("SELECT type, count, availability, main_source FROM knowledge_scale WHERE session_id=?" + (filters.type ? " AND type=?" : ""))
    .all(...[sessionId, ...(filters.type ? [filters.type] : [])]);
  const scale = scaleRows
    .filter((row) => !filters.source || row.main_source === filters.source)
    .filter((row) => !filters.availability || row.availability === filters.availability)
    .reduce((sum, row) => sum + row.count, 0);
  return assetCount + scale;
}

export function getAsset(db, sessionId, assetId) {
  const serving = currentServingVersion(db, sessionId);
  const row = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.session_id=a.session_id AND c.asset_id=a.id AND c.deleted_at IS NULL) AS chunk_count,
              m.asset_revision AS indexed_revision,
              m.index_version  AS indexed_version
         FROM knowledge_assets a
         LEFT JOIN (${memberSnapshotSql(sessionId, serving)}) m
                ON m.asset_id = a.id
        WHERE a.session_id=? AND a.id=?`,
    )
    .get(sessionId, assetId);
  return assetFromRow(row);
}

export function listAssetRevisions(db, sessionId, assetId) {
  return db
    .prepare("SELECT * FROM knowledge_asset_revisions WHERE session_id=? AND asset_id=? ORDER BY revision DESC")
    .all(sessionId, assetId)
    .map((row) => ({
      revision: row.revision,
      fileId: row.file_id,
      contentHash: row.content_hash,
      textRef: row.text_ref,
      contentMode: row.content_mode,
      kind: row.kind,
      label: row.label,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
}

export function listAssetRelations(db, sessionId, assetId) {
  return db
    .prepare(
      `SELECT * FROM knowledge_relations WHERE session_id=? AND (from_id=? OR to_id=?) ORDER BY relation_type, id`,
    )
    .all(sessionId, assetId, assetId)
    .map(relationFromRow);
}

export function relationFromRow(row) {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relationType: row.relation_type,
    evidenceRef: row.evidence_ref,
    origin: row.origin,
  };
}

export function listAssetChunks(db, sessionId, assetId, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT c.*, v.id AS vector_id, v.state AS vector_state, v.adapter_mode, v.dimension_config
         FROM knowledge_chunks c
         LEFT JOIN knowledge_vectors v ON v.session_id=c.session_id AND v.chunk_id=c.id
        WHERE c.session_id=? AND c.asset_id=? AND c.deleted_at IS NULL
        ORDER BY c.chunk_ordinal
        LIMIT ?`,
    )
    .all(sessionId, assetId, limit)
    .map(chunkFromRow);
}

export function chunkFromRow(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    assetRevision: row.asset_revision,
    ordinal: row.chunk_ordinal,
    text: row.text,
    charCount: row.char_count,
    locator: parseJson(row.locator, null),
    chunkConfigRevision: row.chunk_config_revision,
    digest: row.digest,
    indexVersion: row.index_version,
    vectorId: row.vector_id ?? null,
    vectorState: row.vector_state ?? null,
    adapterMode: row.adapter_mode ?? null,
    dimensionConfig: row.dimension_config ?? null,
  };
}

export function getContent(db, sessionId, contentId) {
  const row = db.prepare("SELECT * FROM knowledge_contents WHERE session_id=? AND id=?").get(sessionId, contentId);
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    revision: row.revision,
    mode: row.mode,
    text: row.text,
    locatorKind: row.locator_kind,
    extractionMode: row.extraction_mode,
  };
}

export function getContentForAsset(db, sessionId, assetId) {
  const row = db
    .prepare("SELECT * FROM knowledge_contents WHERE session_id=? AND asset_id=? ORDER BY revision DESC LIMIT 1")
    .get(sessionId, assetId);
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    revision: row.revision,
    mode: row.mode,
    text: row.text,
    locatorKind: row.locator_kind,
    extractionMode: row.extraction_mode,
  };
}

/* ------------------------------------------------------------------ *
 * 读：索引与配置
 * ------------------------------------------------------------------ */

export function currentServingVersion(db, sessionId, scopeId = DEFAULT_SCOPE.id) {
  const row = db
    .prepare("SELECT serving_version FROM knowledge_index_heads WHERE session_id=? AND scope_id=?")
    .get(sessionId, scopeId);
  return row?.serving_version ?? null;
}

export function listIndexVersions(db, sessionId, scopeId = DEFAULT_SCOPE.id) {
  const serving = currentServingVersion(db, sessionId, scopeId);
  return db
    .prepare("SELECT * FROM knowledge_index_versions WHERE session_id=? AND scope_id=? ORDER BY published_at DESC")
    .all(sessionId, scopeId)
    .map((row) => ({
      id: row.id,
      scopeId: row.scope_id,
      configRevision: row.config_revision,
      parentVersion: row.parent_version,
      supersededBy: row.superseded_by ?? null,
      supersedesVersion: row.supersedes_version ?? null,
      publishedAt: row.published_at,
      buildCounts: parseJson(row.build_counts, {}),
      operator: row.operator,
      note: row.note,
      serving: row.id === serving,
      // 历史版本的 buildCounts 不因源资产后来删除而改写；有效数量另算
      effectiveCounts: effectiveCountsOf(db, sessionId, row.id),
    }));
}

/**
 * 派生 CTE：从某个服务版本出发回溯成员。
 *
 * 为什么需要它：「哪些成员在当前服务版本里有效」不是成员表上的一个静态标记。
 * 一个资产可能在不同版本各有一份成员，只有沿「新版本替代旧版本」的关系
 * 一路回溯，才能算出目标版本里每个资产的**最终**成员是谁。
 *
 * 快照语义：先取目标版本自己的成员，再补上祖先版本里「该资产还没有更新成员」
 * 的那些（PRD §12.3「一个版本内成员唯一；可复用未变更块」）。所以最终集合一定
 * 同时包含两种来源的行，**必须**用窗口函数挑出每个资产的赢家：
 *
 *   · `take`  = 'current' → 每个资产只有一份（该版本自己的优先），用于计数与检索；
 *   · `take`  = 'history' → 同一分块在旧版本里的副本，用于「历史」页签核对，
 *                            绝不参与任何指标。
 *
 * 两个坑都有测试守着：
 *   1. 分支写成「目标版本 ∪ 全部祖先」而不挑赢家，会把同一分块算两遍（18,420 变 36,108）；
 *   2. 递归种子如果包含目标版本自己，祖先分支会连它一起吞掉。
 */
export function snapshotCte(sessionId, indexVersion) {
  return `WITH RECURSIVE keep AS (
    SELECT id, superseded_by, parent_version FROM knowledge_index_versions
     WHERE session_id='${esc(sessionId)}' AND id='${esc(indexVersion)}'
    UNION ALL
    SELECT v.id, v.superseded_by, v.parent_version
      FROM knowledge_index_versions v JOIN keep k ON v.superseded_by = k.id
     WHERE v.session_id='${esc(sessionId)}'
  ),
  depth AS (
    -- 从目标版本沿「新版本替代旧版本」展开，并把深度记成「离目标版本多少步」：
    -- 目标版本 0、它的父版本 1、再往上 2……**取每个版本的最大值**即可得到最近距离
    -- （同一版本可能被多条路径到达，必须去重成最短那一条）。
    SELECT id, 0 AS depth FROM keep WHERE id = '${esc(indexVersion)}'
    UNION ALL
    SELECT k.id, d.depth - 1 AS depth
      FROM depth d JOIN keep k ON k.superseded_by = d.id
  ),
  best AS (SELECT id, MAX(depth) AS depth FROM depth GROUP BY id),
  raw AS (
    SELECT m.chunk_id, m.asset_id, m.asset_revision, m.vector_id, m.state, m.index_version,
           b.depth AS depth
      FROM knowledge_index_members m
      JOIN best b ON b.id = m.index_version
     WHERE m.session_id='${esc(sessionId)}' AND m.state <> '暂存'
  ),
  ranked AS (
    -- 按**资产**挑赢家，不是按分块：同一个资产在多个版本里各有一整套分块，
    -- 要么整份采用新版本，要么整份退回旧版本，不能一半新一半旧。
    -- 赢家 = 离目标版本最近的那一份（深度最大）。
    -- （按 chunk_id 排序取 rn=1 会让每个资产只剩一个分块，这个坑踩过一次。）
    SELECT raw.*, MAX(depth) OVER (PARTITION BY asset_id) AS best_depth
      FROM raw
  ),
  snapshot AS (
    SELECT chunk_id, asset_id, asset_revision, vector_id, state, index_version,
           CASE WHEN depth = best_depth THEN 'current' ELSE 'history' END AS take
      FROM ranked
  )`;
}

/** 只保留每个资产在当前服务版本里的最终成员（计数与检索用这一段） */
export function currentSnapshotCte(sessionId, indexVersion) {
  return `${snapshotCte(sessionId, indexVersion)},
  final AS (SELECT * FROM snapshot WHERE take='current')`;
}

/**
 * 资产列表 / 详情要用的成员子查询：每个资产只返回**一行**当前成员。
 *
 * 为什么不能直接 LEFT JOIN knowledge_index_members 再按 index_version 过滤：
 * 同一个资产在不同版本里各有一份成员，一 join 就会变成多行，
 * 表现是资产列表里同一个资产重复出现（React 还会报 key 重复）。
 * 这里复用同一段深度回溯，只取 take='current' 的那一份。
 */
function memberSnapshotSql(sessionId, indexVersion) {
  if (!indexVersion) return "SELECT NULL AS asset_id, NULL AS asset_revision, NULL AS index_version WHERE 0";
  const id = esc(indexVersion);
  const sid = esc(sessionId);
  return `WITH RECURSIVE keep AS (
    SELECT id, superseded_by FROM knowledge_index_versions WHERE session_id='${sid}' AND id='${id}'
    UNION ALL
    SELECT v.id, v.superseded_by FROM knowledge_index_versions v JOIN keep k ON v.superseded_by=k.id WHERE v.session_id='${sid}'
  ),
  ancestor AS (SELECT id FROM keep WHERE id <> '${id}'),
  raw AS (
    SELECT m.asset_id, m.asset_revision, m.index_version,
           0 AS depth
      FROM knowledge_index_members m
     WHERE m.session_id='${sid}' AND m.index_version='${id}' AND m.state='有效'
    UNION ALL
    SELECT m.asset_id, m.asset_revision, m.index_version,
           COALESCE((SELECT COUNT(*) FROM ancestor a WHERE a.id=m.index_version), 1) AS depth
      FROM knowledge_index_members m
     WHERE m.session_id='${sid}' AND m.state='有效' AND m.index_version IN (SELECT id FROM ancestor)
  )
  SELECT asset_id, asset_revision, index_version FROM (
    SELECT raw.*,
           ROW_NUMBER() OVER (
             PARTITION BY asset_id
             ORDER BY depth DESC, index_version DESC, asset_revision DESC
           ) AS rn
      FROM raw
  ) WHERE rn = 1`;
}

/** SQL 字面量转义：这些值只来自服务端自己生成的 ID，仍然按参数处理更稳妥 */
function esc(value) {
  return String(value ?? "").replace(/'/g, "''");
}

/** 当前服务版本下每个资产的最终成员（页面与检索都用这一段，口径唯一） */
export function servingMembersCte(sessionId, indexVersion) {
  return currentSnapshotCte(sessionId, indexVersion);
}

/**
 * 当前服务版本内每个资产的有效分块数（按资产汇总）。
 *
 * `JOIN knowledge_assets` 上带 `materialized = 1`：**规模样本没有分块记录**，
 * 也不可能出现在任何索引版本的成员里；这里把条件写死，是为了将来真有一行
 * 规模样本（比如种子数据或人工插入）时，它也绝不会被算进「有效分块」，
 * 让指标与「能点开、能检索」的资产口径保持一致。
 */
export function servingChunkCounts(db, sessionId, indexVersion, projectId = null) {
  if (!indexVersion) return { byType: new Map(), total: 0, rows: [] };
  const rows = db
    .prepare(
      `${currentSnapshotCte(sessionId, indexVersion)}
       SELECT a.type AS type, f.asset_id AS asset_id, COUNT(*) AS n
         FROM final f
         JOIN knowledge_assets a ON a.session_id=? AND a.id=f.asset_id AND a.deleted_at IS NULL AND a.materialized = 1
        WHERE f.state='有效' ${projectId ? "AND a.project_id=?" : ""}
        GROUP BY a.type, f.asset_id`,
    )
    .all(...[sessionId, ...(projectId ? [projectId] : [])]);
  const byType = new Map();
  let total = 0;
  for (const row of rows) {
    byType.set(row.type, (byType.get(row.type) ?? 0) + row.n);
    total += row.n;
  }
  return { byType, total, rows };
}

/**
 * 某个索引版本的有效数量（PRD §12.3）：应用当前删除与访问过滤后的真实可检索数。
 * 与 buildCounts 分开返回，界面上必须标成两个口径。
 *
 * `materializedOnly` 默认 false（版历史页签要如实统计那个版本里的全部成员）。
 * 总览的「有可用索引资产 / 分块 / 向量」传 true：规模样本没有成员、也永远检索不到，
 * 把它们算进去会让「有效数量」与「有效分块」两个数字的口径对不上。
 */
export function effectiveCountsOf(db, sessionId, indexVersion, { materializedOnly = false } = {}) {
  if (!indexVersion) return { assets: 0, chunks: 0, vectors: 0 };
  const row = db
    .prepare(
      `${currentSnapshotCte(sessionId, indexVersion)}
       SELECT COUNT(*) AS chunks, COUNT(DISTINCT f.asset_id) AS assets
         FROM final f
         JOIN knowledge_assets a ON a.session_id=? AND a.id=f.asset_id AND a.deleted_at IS NULL
          ${materializedOnly ? "AND a.materialized = 1" : ""}
        WHERE f.state='有效'`,
    )
    .get(sessionId);
  return { assets: row?.assets ?? 0, chunks: row?.chunks ?? 0, vectors: row?.chunks ?? 0 };
}

export function getConfig(db, sessionId) {
  const row = db
    .prepare("SELECT * FROM knowledge_configs WHERE session_id=? ORDER BY created_at DESC LIMIT 1")
    .get(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    inclusionRules: parseJson(row.inclusion_rules, {}),
    chunkPolicy: parseJson(row.chunk_policy, {}),
    aggregateWindow: parseJson(row.aggregate_window, {}),
    autoSync: row.auto_sync === 1,
    adapterMode: row.adapter_mode,
    dimensionConfig: row.dimension_config,
    search: parseJson(row.search, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function listConfigs(db, sessionId) {
  return db
    .prepare("SELECT revision, created_by, created_at FROM knowledge_configs WHERE session_id=? ORDER BY created_at DESC")
    .all(sessionId)
    .map((row) => ({ revision: row.revision, createdBy: row.created_by, createdAt: row.created_at }));
}

/* ------------------------------------------------------------------ *
 * 读：任务
 * ------------------------------------------------------------------ */

export function jobFromRow(row) {
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
    counts: parseJson(row.counts, { total: 0, succeeded: 0, failed: 0, skipped: 0, chunks: 0 }),
    stages: parseJson(row.stages, []),
    inputSeq: row.input_seq,
    message: row.message,
    actorId: row.actor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function listJobs(db, sessionId, { status = null, limit = 20 } = {}) {
  const where = ["session_id=?"];
  const params = [sessionId];
  if (status) {
    where.push("status=?");
    params.push(status);
  }
  return db
    .prepare(`SELECT * FROM knowledge_jobs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit)
    .map(jobFromRow);
}

/* ------------------------------------------------------------------ *
 * 写：资产登记 / 版本 / 删除
 *
 * 这一层的写入都被命令总线调用（在同一个 SQLite 事务里），所以这里**不开事务**，
 * 只保证「一次调用写一组一致的记录」。开事务的职责留在 runCommand。
 * ------------------------------------------------------------------ */

let assetSeq = 0;

/** 生成一个新的知识资产 ID（按主类前缀 + 会话内序号） */
export function nextAssetId(db, sessionId, type) {
  const prefix = { document: "D", image: "P", video: "V", workOrder: "W", logBatch: "L", record: "R" }[type] ?? "D";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND type=?`)
    .get(sessionId, type);
  assetSeq += 1;
  const base = (row?.n ?? 0) + 1;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `KA-${prefix}-${String(base + attempt).padStart(4, "0")}`;
    const exists = db.prepare("SELECT 1 AS n FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, id);
    if (!exists) return id;
  }
  return `KA-${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * 登记一个新资产。
 *
 * 内容就绪判定（PRD §4.3 / §11.1）：
 *   · 有可解析文本（用户粘贴 / 文本类文件 / 结构化记录）→ 索引状态「待更新」，进入更新队列；
 *   · 没有文本（任意新 PDF / Word / Excel、没有描述的图片视频）→ 「待补充内容」且「未纳入」，
 *     绝不按文件大小估算分块并当作已建立索引。
 */
export function registerAsset(db, sessionId, input) {
  const type = input.type ?? "document";
  const id = input.id ?? nextAssetId(db, sessionId, type);
  const hasText = Boolean(input.text && String(input.text).trim());
  const businessCategories = input.businessCategories ?? ["巡检报告"];
  const objectIds = input.objectIds ?? [];
  const projectId = input.projectId ?? DEFAULT_SCOPE.id;
  const at = nowIso();

  db.prepare(
    `INSERT INTO knowledge_assets (id, session_id, project_id, type, title, format, business_categories,
      source_system, source_entity_id, main_source, content_revision, metadata_revision, availability,
      index_state, excluded_reason, size_bytes, object_ids, primary_object_id, building_id, zone,
      captured_at, imported_at, updated_at, owner, summary, text_mode, sha256, file_id, extra, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    id,
    sessionId,
    projectId,
    type,
    input.title ?? `${type} ${id}`,
    input.format ?? "TXT",
    JSON.stringify(businessCategories),
    input.sourceSystem ?? "人工导入",
    input.sourceEntityId ?? id,
    input.mainSource ?? "人工导入",
    1,
    1,
    hasText ? "可用" : "待补充内容",
    hasText ? "待更新" : "未纳入",
    hasText ? null : "尚未提供可检索文本，导入后可继续补充描述或提取文本",
    input.sizeBytes ?? (hasText ? Buffer.byteLength(String(input.text), "utf8") : 0),
    JSON.stringify(objectIds),
    input.primaryObjectId ?? objectIds[0] ?? null,
    input.buildingId ?? null,
    input.zone ?? null,
    input.capturedAt ?? at,
    at,
    at,
    input.owner ?? null,
    input.summary ?? (hasText ? String(input.text).slice(0, 120) : "待补充提取文本"),
    hasText ? (input.textMode ?? "uploaded") : "none",
    input.sha256 ?? null,
    input.fileId ?? null,
    // 保留调用方给的类型专属字段（durationSec / lineCount / orderNo …），
    // 读出来时不至于丢掉工单编号这类业务口径
    JSON.stringify({ ...(input.extra ?? {}), ...(input.fileName ? { originalName: input.fileName } : {}) }),
  );

  db.prepare(
    `INSERT INTO knowledge_asset_revisions (session_id, asset_id, revision, file_id, content_hash, text_ref, content_mode, kind, label, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, id, 1, input.fileId ?? null, input.sha256 ?? null, `/assets/${id}/revisions/1`, hasText ? "uploaded" : "none", "registered", "首次登记", input.owner ?? null, at);

  if (hasText) {
    persistContent(db, sessionId, id, 1, input.textMode ?? "uploaded", String(input.text), input.locatorKind ?? "record");
  }

  // 关联对象：与业务字段一致的关系，来源标「人工维护」（PRD §8.4）
  let seq = db.prepare("SELECT COUNT(*) AS n FROM knowledge_relations WHERE session_id=?").get(sessionId).n;
  const link = (toId, relationType) => {
    seq += 1;
    db.prepare(
      `INSERT INTO knowledge_relations (id, session_id, project_id, from_id, to_id, relation_type, evidence_ref, origin)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(`REL-${sessionId}-${seq}-${Date.now().toString(36)}`, sessionId, projectId, id, toId, relationType, `asset.objectIds 含 ${toId}`, "人工维护");
  };
  for (const objectId of objectIds) {
    if (objectId === input.primaryObjectId) continue;
    link(objectId, objectId.startsWith("WO-") ? "处置对象" : "记录对象");
  }
  if (input.primaryObjectId) link(input.primaryObjectId, "记录对象");

  return { assetId: id, indexState: hasText ? "待更新" : "未纳入", availability: hasText ? "可用" : "待补充内容" };
}

/**
 * 内容替换（PRD §10.2）。
 *
 * revision +1；**不**立刻改内容分块，而是把索引状态置回「待更新」，
 * 老版本继续服务（结果带「来源版本 vN，存在更新」），新版发布后切换。
 * 只改名称或标签时不要调这里 —— 那属于元数据变更，走 updateAssetMetadata。
 */
export function reviseAsset(db, sessionId, input) {
  const asset = db.prepare("SELECT * FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, input.assetId);
  if (!asset) return { ok: false, code: "NOT_FOUND", message: `找不到资产 ${input.assetId}` };
  if (asset.deleted_at) return { ok: false, code: "NOT_FOUND", message: `资产 ${input.assetId} 已删除` };
  if (!input.text || !String(input.text).trim()) {
    return { ok: false, code: "CONTENT_REQUIRED", message: "新版本没有可检索文本，应改为补充元数据而不是内容版本" };
  }
  const revision = asset.content_revision + 1;
  const at = nowIso();
  const bytes = input.sizeBytes ?? Buffer.byteLength(String(input.text), "utf8");

  db.prepare(
    `UPDATE knowledge_assets SET content_revision=?, size_bytes=?, availability='可用', index_state='待更新',
            updated_at=?, sha256=COALESCE(?, sha256), file_id=COALESCE(?, file_id), summary=?
      WHERE session_id=? AND id=?`,
  ).run(revision, bytes, at, input.sha256 ?? null, input.fileId ?? null, input.summary ?? String(input.text).slice(0, 120), sessionId, input.assetId);

  db.prepare(
    `INSERT INTO knowledge_asset_revisions (session_id, asset_id, revision, file_id, content_hash, text_ref, content_mode, kind, label, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, input.assetId, revision, input.fileId ?? null, input.sha256 ?? null, `/assets/${input.assetId}/revisions/${revision}`, "uploaded", "revise", input.label ?? `内容替换 v${revision}`, input.actorId ?? null, at);

  persistContent(db, sessionId, input.assetId, revision, input.textMode ?? "uploaded", String(input.text), input.locatorKind ?? "record");
  return { ok: true, assetId: input.assetId, revision, previousRevision: revision - 1, indexState: "待更新", bytes };
}

/** 只改名称 / 标签 / 分类：metadataRevision +1，**不**触发向量重建（PRD §9.2） */
export function updateAssetMetadata(db, sessionId, input) {
  const asset = db.prepare("SELECT * FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, input.assetId);
  if (!asset) return { ok: false, code: "NOT_FOUND", message: `找不到资产 ${input.assetId}` };
  const metadataRevision = asset.metadata_revision + 1;
  const at = nowIso();
  db.prepare(
    `UPDATE knowledge_assets SET title=COALESCE(?, title), business_categories=COALESCE(?, business_categories),
            owner=COALESCE(?, owner), metadata_revision=?, updated_at=? WHERE session_id=? AND id=?`,
  ).run(
    input.title ?? null,
    input.businessCategories ? JSON.stringify(input.businessCategories) : null,
    input.owner ?? null,
    metadataRevision,
    at,
    sessionId,
    input.assetId,
  );
  return { ok: true, assetId: input.assetId, metadataRevision, indexState: asset.index_state, contentRevision: asset.content_revision, rebuildIndex: false };
}

/**
 * 删除资产（PRD §9.2「原始资产删除」）。
 *
 * 逻辑删除 + 在**当前服务版本**里把该资产的成员标记为已删除：
 * 检索即时屏蔽（列表与语料都过滤 deleted_at / state），
 * 历史版本的 buildCounts 不动，随后由清理任务发布一个新版本。
 */
export function deleteAsset(db, sessionId, input) {
  const asset = db.prepare("SELECT * FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, input.assetId);
  if (!asset) return { ok: false, code: "NOT_FOUND", message: `找不到资产 ${input.assetId}` };
  if (asset.deleted_at) return { ok: true, assetId: input.assetId, alreadyDeleted: true, chunksRemoved: 0 };
  const serving = currentServingVersion(db, sessionId);
  const at = nowIso();

  const chunks = db
    .prepare(
      `${currentSnapshotCte(sessionId, serving ?? "")}
       SELECT COUNT(*) AS n FROM final WHERE asset_id=? AND state='有效'`,
    )
    .get(input.assetId).n;

  db.prepare("UPDATE knowledge_assets SET deleted_at=?, index_state='未纳入', availability='已删除', updated_at=? WHERE session_id=? AND id=?").run(
    at,
    at,
    sessionId,
    input.assetId,
  );
  // 当前服务版本里的成员即时失效；历史版本里的副本保留（历史版本仍可切回查看）
  if (serving) {
    db.prepare(
      `UPDATE knowledge_index_members SET state='已删除' WHERE session_id=? AND index_version=? AND asset_id=?`,
    ).run(sessionId, serving, input.assetId);
  }
  return { ok: true, assetId: input.assetId, chunksRemoved: chunks, deletedAt: at, servingVersion: serving };
}

/** 写入提取内容（同一资产同版本只有一份：先删后插，避免重复正文） */
export function persistContent(db, sessionId, assetId, revision, mode, text, locatorKind) {
  db.prepare("DELETE FROM knowledge_contents WHERE session_id=? AND asset_id=?").run(sessionId, assetId);
  db.prepare(
    `INSERT INTO knowledge_contents (id, session_id, asset_id, revision, mode, text, locator_kind, extraction_mode)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(`KC-${assetId}`, sessionId, assetId, revision, mode, text, locatorKind, "uploaded");
  return `KC-${assetId}`;
}

/** 按 assetId 取用于检索的文本（导入 / 替换后由命令处理器调用） */
export function assetContentText(db, sessionId, assetId) {
  const row = db
    .prepare("SELECT text FROM knowledge_contents WHERE session_id=? AND asset_id=? ORDER BY revision DESC LIMIT 1")
    .get(sessionId, assetId);
  return row?.text ?? null;
}

/**
 * 纳入 / 移出索引（PRD §9.2「对象 / 权限 / 纳入策略变化」）。
 *
 * 只改成员资格，不重建文本向量：移出即时生效（检索立刻看不到），
 * 重新纳入则回到「待更新」，由下一次任务补上分块。
 */
export function setAssetInclusion(db, sessionId, { assetId, include }) {
  const asset = db.prepare("SELECT * FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, assetId);
  if (!asset) return { ok: false, code: "NOT_FOUND", message: `找不到资产 ${assetId}` };
  if (asset.deleted_at) return { ok: false, code: "NOT_FOUND", message: `资产 ${assetId} 已删除` };
  const hasText = Boolean(assetContentText(db, sessionId, assetId));
  const at = nowIso();

  if (!include) {
    const serving = currentServingVersion(db, sessionId);
    if (serving) {
      db.prepare("UPDATE knowledge_index_members SET state='已移出' WHERE session_id=? AND index_version=? AND asset_id=?").run(sessionId, serving, assetId);
    }
    db.prepare("UPDATE knowledge_assets SET index_state='未纳入', excluded_reason=?, updated_at=? WHERE session_id=? AND id=?").run(
      "由管理员手动移出索引范围",
      at,
      sessionId,
      assetId,
    );
    return { ok: true, assetId, include: false, indexState: "未纳入", rebuildIndex: false };
  }

  if (!hasText) {
    return { ok: false, code: "CONTENT_REQUIRED", message: "该资产还没有可检索文本，先补充内容再纳入索引" };
  }
  db.prepare("UPDATE knowledge_assets SET index_state='待更新', excluded_reason=NULL, updated_at=? WHERE session_id=? AND id=?").run(at, sessionId, assetId);
  return { ok: true, assetId, include: true, indexState: "待更新", rebuildIndex: true };
}

/**
 * 生成新的配置版本（PRD §5.4）。
 *
 * 关键约束：**不能原地改配置**。参数一变就写一条新的 knowledge_configs 行，
 * 旧索引继续带着它自己的 configRevision 服务；是否需要重建由调用方决定，
 * 这里只如实返回 `rebuildRequired`。
 */
export function applyKnowledgeConfig(db, sessionId, { actorId = null, patch = {} } = {}) {
  const current = getConfig(db, sessionId) ?? BASELINE_CONFIG;
  const next = {
    inclusionRules: patch.inclusionRules ?? current.inclusionRules,
    chunkPolicy: { ...current.chunkPolicy, ...(patch.chunkPolicy ?? {}) },
    aggregateWindow: { ...current.aggregateWindow, ...(patch.aggregateWindow ?? {}) },
    autoSync: patch.autoSync === undefined ? current.autoSync : Boolean(patch.autoSync),
    adapterMode: patch.adapterMode ?? current.adapterMode,
    dimensionConfig: patch.dimensionConfig ?? current.dimensionConfig,
    search: { ...current.search, ...(patch.search ?? {}) },
  };
  if (!(next.chunkPolicy.maxChars > 0)) {
    return { ok: false, code: "INVALID_CHUNK_POLICY", message: "分块长度上限必须大于 0" };
  }
  if (next.chunkPolicy.overlapChars >= next.chunkPolicy.maxChars) {
    return { ok: false, code: "INVALID_CHUNK_POLICY", message: "分块重叠必须小于分块长度上限，否则会切不出块" };
  }
  if (!(next.search.minScoreLow >= 0)) {
    return { ok: false, code: "INVALID_SEARCH_CONFIG", message: "相似度阈值不能为负数" };
  }

  const changed = [];
  if (JSON.stringify(next.chunkPolicy) !== JSON.stringify(current.chunkPolicy)) changed.push("chunkPolicy");
  if (JSON.stringify(next.search) !== JSON.stringify(current.search)) changed.push("search");
  if (JSON.stringify(next.inclusionRules) !== JSON.stringify(current.inclusionRules)) changed.push("inclusionRules");
  if (next.autoSync !== current.autoSync) changed.push("autoSync");
  if (JSON.stringify(next.aggregateWindow) !== JSON.stringify(current.aggregateWindow)) changed.push("aggregateWindow");

  // 版本号按现有配置数推导，不由前端写死
  const row = db.prepare("SELECT COUNT(*) AS n FROM knowledge_configs WHERE session_id=?").get(sessionId);
  const revision = `CFG-KB-${String((row?.n ?? 0) + 1).padStart(3, "0")}`;
  const at = nowIso();
  db.prepare(
    `INSERT INTO knowledge_configs (id, session_id, revision, inclusion_rules, chunk_policy, aggregate_window, auto_sync, adapter_mode, dimension_config, search, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    revision,
    sessionId,
    revision,
    JSON.stringify(next.inclusionRules),
    JSON.stringify(next.chunkPolicy),
    JSON.stringify(next.aggregateWindow),
    next.autoSync ? 1 : 0,
    next.adapterMode,
    next.dimensionConfig,
    JSON.stringify(next.search),
    actorId,
    at,
  );

  return {
    ok: true,
    revision,
    previousRevision: current.revision,
    changed,
    // 分块策略 / 纳入规则变化需要重建；只调自动同步或阈值则不必
    rebuildRequired: changed.includes("chunkPolicy") || changed.includes("inclusionRules"),
    config: { ...next, id: revision, revision, createdBy: actorId, createdAt: at },
  };
}

export function getJob(db, sessionId, jobId) {
  return jobFromRow(db.prepare("SELECT * FROM knowledge_jobs WHERE session_id=? AND id=?").get(sessionId, jobId));
}

export function listJobItems(db, sessionId, jobId) {
  return db
    .prepare("SELECT * FROM knowledge_job_items WHERE session_id=? AND job_id=? ORDER BY status, asset_id LIMIT 300")
    .all(sessionId, jobId)
    .map((row) => ({
      assetId: row.asset_id,
      targetRevision: row.target_revision,
      stage: row.stage,
      status: row.status,
      errorCode: row.error_code,
      message: row.message,
      updatedAt: row.updated_at,
    }));
}
