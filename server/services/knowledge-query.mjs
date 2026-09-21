/**
 * 数据与知识中心 · 查询服务
 *
 * 依据：PRD §5（信息架构与布局）、§7（量化指标，全部从记录复算）、
 *      §8（关系图：业务关联 / 索引血缘两套边集）、§9.1（三套状态分开表达）、
 *      §12.4（GET /api/knowledge/* 与 POST /api/knowledge/search）。
 *
 * 一条硬规则贯穿本文件：**页面上的数字必须能从落库记录复算**，
 * 所以这里没有一处写常量，全部走 COUNT / SUM / 分组查询。
 *
 * 两条贯穿全文的口径（两层数据，见 knowledge-contract.mjs 的 BASELINE_ROWS 注释）：
 *   · 指标 / 纳入 / 覆盖 / 分块只对**有明细记录**的资产成立（`materialized = 1`）；
 *   · 凡是「平台里一共有多少」的分布（可用性、来源）要数**全部**资产，
 *     明细层查出来的分布再与 knowledge_scale 的规模样本合并，各格相加 = metrics.total。
 *   · 关系图与检索语料只取明细层：规模样本没有文件名、版本与分块，
 *     作为节点点开是死路，作为检索命中也无法定位来源。
 */

import { parseJson } from "../storage/db.mjs";
import {
  ASSET_TYPES,
  BASELINE_CONFIG,
  DEFAULT_SCOPE,
  LIMITS,
  assetTypeLabel,
  computeMetrics,
  describeLocator,
  deriveRagStatus,
  SEARCH_CONFIG_DEFAULT,
} from "../domains/knowledge-contract.mjs";
import {
  currentServingVersion,
  effectiveCountsOf,
  getAsset,
  getConfig,
  getContentForAsset,
  listAssetChunks,
  listAssetRelations,
  listAssetRevisions,
  listIndexVersions,
  listJobItems,
  listJobs,
  queryAssets,
  readScale,
  relationFromRow,
  currentSnapshotCte,
  servingChunkCounts,
} from "./knowledge-store.mjs";
import { buildCorpus, getCorpus, invalidateCorpus, interpretQuery, makeSnippet, scoreCorpus } from "./knowledge-index-demo.mjs";

/* ------------------------------------------------------------------ *
 * 指标
 * ------------------------------------------------------------------ */

/**
 * 资产规模与覆盖分布。
 *
 * 口径（两层数据，见 knowledge-contract.mjs 的 BASELINE_ROWS 注释）：
 *   · `materialized` 层 —— 有文件名、版本、分块与索引成员记录，指标从这些记录复算；
 *   · 规模样本层（knowledge_scale）—— 平台里真实存在但不逐条生成的历史归档，
 *     只贡献 `total`，**不参与**纳入 / 覆盖 / 分块口径（它们没有分块记录）。
 *
 * 所以每个主类给出两组数：`total`（规模）与 `materialized`（可展开明细），
 * 界面必须同时显示，不能把两者混成一个数字（PRD §7、§11.2）。
 *
 * 这里的 `materialized = 1` 是关键：纳入 / 覆盖 / 分块三组数都只对明细层成立。
 * 规模样本没有分块记录，把它们算进分母会得到一个永远上不去、也无法解释的覆盖率。
 */
export function readMetrics(db, sessionId, { projectId = DEFAULT_SCOPE.id, type = null } = {}) {
  const serving = currentServingVersion(db, sessionId);
  const rows = db
    .prepare(
      `SELECT type, index_state AS state, COUNT(*) AS n
         FROM knowledge_assets
        WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized=1 ${type ? "AND type=?" : ""}
        GROUP BY type, index_state`,
    )
    .all(...[sessionId, projectId, ...(type ? [type] : [])]);

  const scale = readScale(db, sessionId);

  const byType = new Map(
    ASSET_TYPES.map((item) => [
      item.key,
      {
        type: item.key,
        label: item.label,
        total: 0,
        scale: scale.byType.get(item.key)?.count ?? 0,
        scaleNote: scale.byType.get(item.key)?.note ?? null,
        materialized: 0,
        included: 0,
        covered: 0,
        pending: 0,
        error: 0,
        processing: 0,
        excluded: 0,
        chunkCount: 0,
      },
    ]),
  );
  for (const row of rows) {
    const bucket = byType.get(row.type);
    if (!bucket) continue;
    bucket.materialized += row.n;
    if (row.state === "未纳入") bucket.excluded += row.n;
    else {
      bucket.included += row.n;
      if (row.state === "已覆盖") bucket.covered += row.n;
      else if (row.state === "待更新") bucket.pending += row.n;
      else if (row.state === "更新失败") bucket.error += row.n;
      else if (row.state === "处理中") bucket.processing += row.n;
    }
  }
  // 总量 = 规模样本 + 可展开明细
  for (const bucket of byType.values()) bucket.total = bucket.materialized + bucket.scale;

  // 有效分块 = 当前服务版本里可访问、未被删除规则屏蔽的分块（PRD §7.2）。
  // 走 servingChunkCounts：它按「新版本替代旧版本」回溯出该版本每个资产的最终
  // 成员，历史版本切换后口径依然正确。
  const chunkStats = servingChunkCounts(db, sessionId, serving, projectId);
  for (const [type, count] of chunkStats.byType) {
    const bucket = byType.get(type);
    if (bucket) bucket.chunkCount += count;
  }

  const list = [...byType.values()];
  const metrics = computeMetrics(list);
  return { servingVersion: serving, byType: list, metrics };
}
/**
 * 分组计数的小工具（资产可用性、来源分布、业务分类分布）。
 *
 * `materializedOnly` 默认 **false**：可用性与来源这两张分布图讲的是
 * 「平台里的资料整体是什么状态」，规模样本也是平台里真实存在的资料，
 * 必须一起数。若只数明细，各状态相加会比 `metrics.total` 少一大截
 * （基线少 165,610 项），读者看到的是「分布加起来不等于总量」。
 * 需要「只看可点开明细」的场合显式传 true，而不是让这里默默换口径。
 */
function groupCount(db, sessionId, projectId, column, { extraWhere = "", materializedOnly = false } = {}) {
  return db
    .prepare(
      `SELECT ${column} AS key, COUNT(*) AS n
         FROM knowledge_assets
        WHERE session_id=? AND project_id=? AND deleted_at IS NULL
          ${materializedOnly ? "AND materialized=1" : ""} ${extraWhere}
        GROUP BY ${column}
        ORDER BY n DESC`,
    )
    .all(sessionId, projectId)
    .map((row) => ({ key: row.key, n: row.n }));
}

/**
 * 把明细层的分布与规模样本的分布合并成一份。
 *
 * 两张分布图要回答的是「平台里的资料整体是什么状态」，明细层与规模样本
 * 缺一不可；分开返回会让调用方各取一半，数字对不上总量。
 * 合并后按数量降序 —— 与 groupCount 的输出顺序一致，界面不必再排一次。
 */
function mergeScaleCounts(assetCounts, scaleCounts) {
  const merged = new Map(assetCounts.map((row) => [row.key, row.n]));
  for (const row of scaleCounts) merged.set(row.key, (merged.get(row.key) ?? 0) + row.n);
  return [...merged.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

/* ------------------------------------------------------------------ *
 * 总览快照（PRD §12.4 GET /api/knowledge/overview）
 * ------------------------------------------------------------------ */

export function readOverview(db, sessionId, { projectId = DEFAULT_SCOPE.id } = {}) {
  const { servingVersion, byType, metrics } = readMetrics(db, sessionId, { projectId });
  // 规模样本的可用性 / 来源汇总：与明细层的分布合并后才是「全部资产」的分布
  const scaleTotals = readScale(db, sessionId);
  const config = getConfig(db, sessionId) ?? BASELINE_CONFIG;
  const running = listJobs(db, sessionId, { status: "运行", limit: 5 });
  const recentJobs = listJobs(db, sessionId, { limit: 3 });
  const versions = listIndexVersions(db, sessionId);
  const latest = versions[0] ?? null;

  // 最近成功发布：最新一次索引发布事务完成时间（PRD §7.2）
  const lastSuccess = db
    .prepare("SELECT published_at FROM knowledge_index_versions WHERE session_id=? ORDER BY published_at DESC LIMIT 1")
    .get(sessionId);

  const metricsFull = {
    ...metrics,
    pending: metrics.pending,
    error: metrics.error,
    longestWaitSeconds: longestWaitSeconds(db, sessionId, projectId),
    rawBytes: rawBytesOf(db, sessionId, projectId),
    lastPublishedAt: lastSuccess?.published_at ?? null,
    /*
      「有可用索引资产」只数**有明细记录**的资产（materializedOnly）。
      规模样本只贡献计数、没有分块与成员，把它算进来会让这个数字里混进
      一批永远检索不到的条目；它与 chunks / vectors 的口径必须一致。
    */
    assetsInServingIndex: servingVersion
      ? effectiveCountsOf(db, sessionId, servingVersion, { materializedOnly: true }).assets
      : 0,
  };

  const ragStatus = deriveRagStatus({
    servingVersion,
    pending: metrics.pending + metrics.processing,
    error: metrics.error,
    runningJobs: running.length,
    autoSync: config.autoSync !== false,
  });

  return {
    scope: { id: projectId, label: DEFAULT_SCOPE.label },
    servingVersion,
    configRevision: config.revision ?? BASELINE_CONFIG.id,
    adapterMode: config.adapterMode ?? "demo",
    dimensionConfig: config.dimensionConfig ?? 768,
    metrics: metricsFull,
    coverage: byType.map((row) => ({
      type: row.type,
      label: row.label,
      covered: row.covered,
      pending: row.pending,
      error: row.error,
      excluded: row.excluded,
      processing: row.processing,
      /*
        两层数字必须一起下发：`total` 是平台规模，`materialized` 是能点开明细的部分，
        差额 `scale` 与它的 `scaleNote` 就是界面上那句「其中 N 项可展开明细」的依据。
        只给 total，界面只能把 54,160 画成一页列表；只给 materialized，又会把规模说小。
      */
      total: row.total,
      scale: row.scale,
      scaleNote: row.scaleNote,
      materialized: row.materialized,
      included: row.included,
      chunks: row.chunkCount,
    })),
    indexStatus: {
      ...ragStatus,
      autoSync: config.autoSync !== false,
      pending: metrics.pending,
      processing: metrics.processing,
      error: metrics.error,
      servingVersion,
      lastPublishedAt: lastSuccess?.published_at ?? null,
      effective: servingVersion
        ? effectiveCountsOf(db, sessionId, servingVersion, { materializedOnly: true })
        : { assets: 0, chunks: 0 },
      buildCounts: latest?.buildCounts ?? null,
    },
    /*
      可用性 / 来源两张分布讲的是「平台里的资料整体是什么状态、从哪来」，
      所以数**全部**资产：明细层走 groupCount（不加 materialized 过滤），
      规模样本在 knowledge_scale 里，按同样的两个维度汇总后合并。
      两段相加 = metrics.total，分布图的各扇区加起来必须等于顶上的总量数字，
      否则读者会以为「有一批资料既不属于任何状态、也不属于任何来源」。
    */
    availability: mergeScaleCounts(groupCount(db, sessionId, projectId, "availability"), scaleTotals.availability),
    sources: mergeScaleCounts(groupCount(db, sessionId, projectId, "main_source"), scaleTotals.sources),
    recentAssets: queryAssets(db, sessionId, { projectId, limit: 8 }).items,
    recentJobs,
    runningJobs: running,
    versions: versions.slice(0, 6),
    limits: LIMITS,
    searchConfig: config.search ?? SEARCH_CONFIG_DEFAULT,
    snapshotSeq: snapshotSeq(db, sessionId),
    serverTime: new Date().toISOString(),
  };
}

function snapshotSeq(db, sessionId) {
  const row = db.prepare("SELECT last_seq FROM sessions WHERE id=?").get(sessionId);
  return row?.last_seq ?? 0;
}

/**
 * 最长等待：最早一个待处理变更到服务端当前时间的间隔（PRD §7.2）。
 *
 * 时间在库里一律是 ISO 8601 UTC，所以这里必须 `new Date(iso)` 解析后再相减。
 * 用 SQLite 的 `julianday('now') - julianday(updated_at)` 会把 `T`/`Z` 当成
 * 普通字符处理，算出来的等待时长直接翻倍（实测 30 天被算成 59 天）。
 * 无待处理变更时返回 null，界面显示「—」。
 */
function longestWaitSeconds(db, sessionId, projectId) {
  const row = db
    .prepare(
      `SELECT MIN(updated_at) AS oldest FROM knowledge_assets
        WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND index_state IN ('待更新','处理中')`,
    )
    .get(sessionId, projectId);
  if (!row?.oldest) return null;
  const at = new Date(row.oldest).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

/** 原始数据容量：存在真实文件的去重文件字节总和（未随包携带的不计入） */
function rawBytesOf(db, sessionId, projectId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(f.size),0) AS bytes
         FROM knowledge_assets a
         JOIN files f ON f.id = a.file_id
        WHERE a.session_id=? AND a.project_id=? AND a.deleted_at IS NULL`,
    )
    .get(sessionId, projectId);
  return row?.bytes ?? 0;
}

/* ------------------------------------------------------------------ *
 * 资产详情（PRD §5.3 四个页签）
 * ------------------------------------------------------------------ */

export function readAssetDetail(db, sessionId, assetId) {
  const asset = getAsset(db, sessionId, assetId);
  if (!asset) return null;
  const serving = currentServingVersion(db, sessionId);
  const content = getContentForAsset(db, sessionId, assetId);
  const chunks = listAssetChunks(db, sessionId, assetId);
  const revisions = listAssetRevisions(db, sessionId, assetId);
  const relations = listAssetRelations(db, sessionId, assetId);
  const jobRows = db
    .prepare(
      `SELECT j.id, j.status, j.stage, i.status AS item_status, i.error_code, i.message, i.updated_at
         FROM knowledge_job_items i
         JOIN knowledge_jobs j ON j.session_id=i.session_id AND j.id=i.job_id
        WHERE i.session_id=? AND i.asset_id=?
        ORDER BY i.updated_at DESC LIMIT 10`,
    )
    .all(sessionId, assetId);

  const indexedRevision = asset.indexedRevision;
  // 「来源版本 v1，存在更新」：旧索引继续服务时结果要带这个提示（PRD §10.2）
  const staleSource = indexedRevision !== null && indexedRevision !== asset.contentRevision;

  return {
    asset,
    content: content
      ? {
          id: content.id,
          revision: content.revision,
          mode: content.mode,
          locatorKind: content.locatorKind,
          extractionMode: content.extractionMode,
          chars: content.text.length,
          preview: content.text.slice(0, 4000),
          text: content.text,
        }
      : null,
    chunks,
    revisions,
    relations: relations.map((relation) => ({ ...relation, title: titleOf(db, sessionId, relation.fromId === assetId ? relation.toId : relation.fromId) })),
    jobItems: jobRows.map((row) => ({
      jobId: row.id,
      jobStatus: row.status,
      stage: row.stage,
      status: row.item_status,
      errorCode: row.error_code,
      message: row.message,
      updatedAt: row.updated_at,
    })),
    index: {
      servingVersion: serving,
      indexedRevision,
      currentRevision: asset.contentRevision,
      staleSource,
      note: staleSource
        ? `当前索引来源为 v${indexedRevision}，资产已是 v${asset.contentRevision}；旧版继续提供服务。`
        : null,
      chunkCount: chunks.length,
      vectorCount: chunks.filter((chunk) => chunk.vectorId).length,
      configRevision: chunks[0]?.chunkConfigRevision ?? null,
      dimensionConfig: chunks[0]?.dimensionConfig ?? null,
      adapterMode: chunks[0]?.adapterMode ?? null,
    },
    // 原始附件是否随演示包提供（PRD §11.2：没有就不能出现可点却无文件的下载按钮）
    file: asset.fileId ? { fileId: asset.fileId, provided: true } : { fileId: null, provided: false, note: "原始附件未随演示包提供" },
  };
}

function titleOf(db, sessionId, id) {
  const row = db.prepare("SELECT title FROM knowledge_assets WHERE session_id=? AND id=?").get(sessionId, id);
  return row?.title ?? id;
}

/* ------------------------------------------------------------------ *
 * 关系图（PRD §8）
 * ------------------------------------------------------------------ */

/** 业务关联边集合（白名单，避免把索引血缘混进来） */
const BUSINESS_RELATIONS = ["属于", "采集自", "附件属于", "记录对象", "处置对象", "引用"];
/** 索引血缘边集合 */
const LINEAGE_RELATIONS = ["提取自", "切分自", "索引于", "更新自"];

/**
 * 范围关系子图。
 *
 * 预算（PRD §8.2）：普通视图 ≤180 节点 / 400 边，全屏 ≤250 / 600；
 * 初始目标 80–120 个实际显示节点、边上限 240、6–10 个业务簇。
 * 超出预算时截断并明确返回 truncated，不假装画完了。
 */
export function readGraph(db, sessionId, { projectId = DEFAULT_SCOPE.id, view = "business", focusId = null, depth = 1, nodeBudget = 120, edgeBudget = 240 } = {}) {
  if (view === "lineage") return readLineageGraph(db, sessionId, { projectId, focusId, nodeBudget, edgeBudget });
  return readBusinessGraph(db, sessionId, { projectId, focusId, depth, nodeBudget, edgeBudget });
}

function readBusinessGraph(db, sessionId, { projectId, focusId, depth, nodeBudget, edgeBudget }) {
  const placeholders = BUSINESS_RELATIONS.map(() => "?").join(",");
  const edges = db
    .prepare(
      `SELECT * FROM knowledge_relations
        WHERE session_id=? AND project_id=? AND relation_type IN (${placeholders})
        ORDER BY id`,
    )
    .all(sessionId, projectId, ...BUSINESS_RELATIONS)
    .map(relationFromRow);

  /*
    资产节点只取 `materialized = 1`：图上的节点是**可点的**。
    规模样本没有文件名、没有版本、没有分块与成员，也没有关联关系，
    作为节点画出来点开就是死路（既看不到详情也搜不到内容），
    所以它们只进计数，不进图（业务图与血缘图同一口径）。
  */
  const assetRows = db
    .prepare(
      `SELECT id, title, type, building_id, primary_object_id, index_state, availability, updated_at
         FROM knowledge_assets WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized = 1`,
    )
    .all(sessionId, projectId);
  const assetById = new Map(assetRows.map((row) => [row.id, row]));

  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }

  // 簇 = 建筑：每个建筑是一个业务簇（PRD §8.2「按建筑、构件或设备聚合」）
  const buildingNodes = new Map();
  for (const row of assetRows) {
    if (!row.building_id) continue;
    const bucket = buildingNodes.get(row.building_id) ?? { id: row.building_id, count: 0 };
    bucket.count += 1;
    buildingNodes.set(row.building_id, bucket);
  }

  /*
    节点挑选要**先选后发**：对象节点（建筑 / 构件 / 设备 / 工单 / 任务）与资产
    节点共用同一份预算。早先是边挑边加，对象节点会先把预算吃满，
    资产节点只能靠 addNode 的硬上限被截断，总数仍然会越过预算。
  */
  const assetBudget = Math.max(1, Math.floor(nodeBudget / 3));
  const objectBudget = Math.max(1, nodeBudget - assetBudget);
  const assetCandidates = assetRows
    .map((row) => ({ row, d: degree.get(row.id) ?? 0 }))
    .sort((a, b) => b.d - a.d || a.row.id.localeCompare(b.row.id));
  const chosenAssets = new Set(assetCandidates.slice(0, assetBudget).map((item) => item.row.id));

  /** 节点集合：建筑 / 构件 / 设备 / 工单 / 任务 + 高关联度资产 */
  const nodes = new Map();
  const addNode = (id, node) => {
    if (!nodes.has(id)) nodes.set(id, node);
    return nodes.get(id);
  };

  for (const [buildingId, bucket] of buildingNodes) {
    if (nodes.size >= objectBudget) break;    addNode(buildingId, {
      id: buildingId,
      label: buildingId,
      kind: "building",
      category: "对象",
      degree: degree.get(buildingId) ?? 0,
      count: bucket.count,
      detail: `建筑 · 关联资产 ${bucket.count} 项`,
    });
  }

  // 构件 / 设备 / 工单编号：从资产的关联对象与 relations 的 toId 推出来
  const objectCandidates = [];
  for (const edge of edges) {
    for (const id of [edge.fromId, edge.toId]) {
      if (assetById.has(id) || nodes.has(id) || objectCandidates.includes(id)) continue;
      if (/^(Z|L|EF|DG|LN|C|QT|TJ)\d/.test(id)) {
        objectCandidates.push(id);
        addNodeIfBudget(id, { id, label: id, kind: "component", category: "对象", degree: degree.get(id) ?? 0, detail: "构件" });
      } else if (/^(SCAN|N\d|TH-|CAM)/.test(id)) {
        objectCandidates.push(id);
        addNodeIfBudget(id, { id, label: id, kind: "device", category: "设备", degree: degree.get(id) ?? 0, detail: "设备" });
      } else if (/^WO-/.test(id)) {
        objectCandidates.push(id);
        addNodeIfBudget(id, { id, label: id, kind: "workOrder", category: "工单", degree: degree.get(id) ?? 0, detail: "历史工单" });
      } else if (/^INS-/.test(id)) {
        objectCandidates.push(id);
        addNodeIfBudget(id, { id, label: id, kind: "inspection", category: "任务", degree: degree.get(id) ?? 0, detail: "巡检任务" });
      } else if (/^B-/.test(id)) {
        objectCandidates.push(id);
        addNodeIfBudget(id, { id, label: id, kind: "building", category: "对象", degree: degree.get(id) ?? 0, detail: "建筑" });
      }
    }
  }
  function addNodeIfBudget(id, node) {
    if (nodes.has(id) || nodes.size >= nodeBudget - assetBudget) return null;
    return addNode(id, node);
  }

  // 资产节点：默认只放高关联度资产，避免首屏糊成一片
  for (const row of assetRows) {
    if (!chosenAssets.has(row.id)) continue;
    addNode(row.id, {
      id: row.id,
      label: row.title,
      kind: "asset",
      assetType: row.type,
      category: assetTypeLabel(row.type),
      degree: degree.get(row.id) ?? 0,
      state: row.indexState,
      detail: `${assetTypeLabel(row.type)} · ${row.indexState}`,
    });
  }

  // focusId 展开：把焦点节点的邻居一并加入（PRD §8.3 双击或「展开关联」加载下一层）
  // 展开同样受 nodeBudget 约束：预算之上只提示「继续筛选或收起其他节点」，
  // 不能因为展开了某个节点就把图撑到画不动。
  if (focusId) {
    const focus = addNode(focusId, nodes.get(focusId) ?? {
      id: focusId,
      label: assetById.get(focusId)?.title ?? focusId,
      kind: assetById.has(focusId) ? "asset" : "object",
      category: "焦点",
      degree: degree.get(focusId) ?? 0,
      detail: "当前焦点",
    });
    if (focus) focus.focus = true;
    let frontier = new Set([focusId]);
    for (let hop = 0; hop < Math.max(1, Math.min(depth, 2)) && nodes.size < nodeBudget; hop += 1) {
      const next = new Set();
      for (const edge of edges) {
        if (nodes.size >= nodeBudget) break;
        for (const [a, b] of [[edge.fromId, edge.toId], [edge.toId, edge.fromId]]) {
          if (nodes.size >= nodeBudget) break;
          if (!frontier.has(a) || nodes.has(b)) continue;
          const row = assetById.get(b);
          if (!addNode(b, row
            ? { id: b, label: row.title, kind: "asset", assetType: row.type, category: assetTypeLabel(row.type), degree: degree.get(b) ?? 0, state: row.indexState, detail: `${assetTypeLabel(row.type)} · ${row.indexState}` }
            : { id: b, label: b, kind: "object", category: "对象", degree: degree.get(b) ?? 0, detail: "关联对象" })) break;
          next.add(b);
        }
      }
      frontier = next;
    }
  }

  const visibleEdges = edges.filter((edge) => nodes.has(edge.fromId) && nodes.has(edge.toId));
  const truncatedEdges = visibleEdges.length > edgeBudget;
  const keptEdges = truncatedEdges
    ? visibleEdges
        .slice()
        .sort((a, b) => (degree.get(b.fromId) + degree.get(b.toId)) - (degree.get(a.fromId) + degree.get(a.toId)))
        .slice(0, edgeBudget)
    : visibleEdges;

  const scopeCounts = db
    .prepare("SELECT COUNT(*) AS assets FROM knowledge_assets WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized = 1")
    .get(sessionId, projectId);

  return {
    view: "business",
    relationTypes: BUSINESS_RELATIONS,
    nodes: [...nodes.values()].map((node) => ({ ...node, degree: degree.get(node.id) ?? node.degree ?? 0 })),
    edges: keptEdges.map((edge) => ({
      id: edge.id,
      source: edge.fromId,
      target: edge.toId,
      relationType: edge.relationType,
      evidenceRef: edge.evidenceRef,
      origin: edge.origin,
    })),
    clusters: buildingNodes.size,
    scopeCounts: { assets: scopeCounts.assets, relations: edges.length },
    truncated: { nodes: nodes.size >= nodeBudget, edges: truncatedEdges },
    focusId: focusId ?? null,
  };
}

function readLineageGraph(db, sessionId, { projectId, focusId, nodeBudget, edgeBudget }) {
  const serving = currentServingVersion(db, sessionId);
  // 血缘图节点同样是可点的：规模样本没有成员、没有分块，不能进图（口径与业务图一致）
  const scope = db
    .prepare("SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized = 1")
    .get(sessionId, projectId);

  /*
    预算要先算再取：血缘图每个资产固定贡献「资产版本 + 提取内容 + N 个分块组」，
    最后再加一个服务版本节点。先按公式反推能装下几个资产，再按这个数取数，
    就不会出现「取回来又截断」——那种写法会把版本节点切掉，图看着像没画完。
  */
  const groupBudget = Math.max(1, Math.min(4, Math.max(1, Math.floor((nodeBudget - 1) / 3) - 2)));
  const assetCount = Math.max(1, Math.floor((nodeBudget - 1) / (2 + groupBudget)));
  const assets = db
    .prepare(
      `SELECT a.id, a.title, a.type, a.content_revision, a.primary_object_id,
              (SELECT COUNT(*) FROM knowledge_index_members m WHERE m.session_id=a.session_id AND m.asset_id=a.id AND m.index_version=?) AS chunks
         FROM knowledge_assets a
        WHERE a.session_id=? AND a.project_id=? AND a.deleted_at IS NULL AND a.materialized = 1
          AND EXISTS (SELECT 1 FROM knowledge_index_members m WHERE m.session_id=a.session_id AND m.asset_id=a.id AND m.index_version=?)
        ORDER BY chunks DESC, a.id
        LIMIT ?`,
    )
    .all(serving ?? "", sessionId, projectId, serving ?? "", assetCount);

  const nodes = [];
  const edges = [];
  const perAsset = groupBudget;

  // 固定分层坐标（PRD §8.2：血缘图使用固定分层坐标，不做力导向）
  const layer = { asset: 0.08, content: 0.3, chunk: 0.56, version: 0.86 };
  assets.forEach((asset, index) => {
    const y = (index + 1) / (assets.length + 1);
    const assetId = `L:${asset.id}`;
    nodes.push({ id: assetId, label: asset.title, kind: "assetVersion", category: assetTypeLabel(asset.type), layer: "asset", x: layer.asset, y, detail: `${asset.title} v${asset.content_revision}`, assetType: asset.type, count: asset.chunks });
    const contentId = `L:${asset.id}:content`;
    nodes.push({ id: contentId, label: "提取内容", kind: "content", category: "内容", layer: "content", x: layer.content, y, detail: `提取自 ${asset.title} v${asset.content_revision}` });
    edges.push({ id: `E:${assetId}>${contentId}`, source: assetId, target: contentId, relationType: "提取自", evidenceRef: `asset.${asset.id}.revision=${asset.content_revision}`, origin: "业务字段" });
    const groups = Math.max(1, Math.min(perAsset, asset.chunks));
    for (let group = 0; group < groups; group += 1) {
      const span = asset.chunks / groups;
      const from = Math.round(group * span) + 1;
      const to = Math.round((group + 1) * span);
      const groupId = `L:${asset.id}:g${group + 1}`;
      nodes.push({
        id: groupId,
        label: `分块 ×${to - from + 1}`,
        kind: "chunkGroup",
        category: "分块组",
        layer: "chunk",
        x: layer.chunk,
        y: Math.min(0.98, Math.max(0.02, y + (group - (groups - 1) / 2) * 0.05)),
        count: to - from + 1,
        detail: `${asset.title} 分块 C-${String(from).padStart(3, "0")} – C-${String(to).padStart(3, "0")}`,
        assetId: asset.id,
        range: [from, to],
      });
      edges.push({ id: `E:${contentId}>${groupId}`, source: contentId, target: groupId, relationType: "切分自", evidenceRef: `chunk.ordinal ∈ [${from}, ${to}]`, origin: "演示夹具规则" });
      edges.push({ id: `E:${groupId}>KB`, source: groupId, target: `L:${serving}`, relationType: "索引于", evidenceRef: `member.indexVersion=${serving}`, origin: "业务字段" });
    }
  });
  nodes.push({
    id: `L:${serving ?? "未就绪"}`,
    label: serving ?? "未就绪",
    kind: "indexVersion",
    category: "索引版本",
    layer: "version",
    x: layer.version,
    y: 0.5,
    count: scope.n,
    detail: `当前服务版本 · 范围 ${scope.n} 项资产`,
  });

  const keptEdges = edges.slice(0, edgeBudget);
  return {
    view: "lineage",
    relationTypes: LINEAGE_RELATIONS,
    nodes,
    edges: keptEdges,
    clusters: 1,
    scopeCounts: { assets: scope.n, relations: edges.length },
    // 预算是先算后取的，所以节点一定不会超；被截断的是「范围内还有更多资产没画」
    truncated: { nodes: scope.n > assets.length, edges: edges.length > edgeBudget },
    focusId: focusId ?? null,
    servingVersion: serving,
  };
}

/* ------------------------------------------------------------------ *
 * 检索（PRD §12.4 POST /api/knowledge/search）
 * ------------------------------------------------------------------ */

/**
 * 服务版本快照的成员 CTE（与 knowledge-store 的 servingChunkCounts 同一段 SQL）。
 * 检索只读 `final`：每次查询绑定单一已发布版本，不会混读新旧成员（PRD §16.3 R07）。
 */
function snapshotMembersSql(sessionId, indexVersion) {
  return currentSnapshotCte(sessionId, indexVersion);
}

/** 语料装载器：只读当前服务版本的有效成员（PRD §16.3 R07 单一版本） */
export function loadCorpus(db, sessionId, { projectId = DEFAULT_SCOPE.id } = {}) {
  const serving = currentServingVersion(db, sessionId);
  const key = `${sessionId}|${serving ?? "none"}|${projectId}`;
  return getCorpus(key, () => {
    /*
      ── 为什么分三步取，而不是一条三表 JOIN（2026-10-01 实测）──────────────
      原来是一条 `final JOIN knowledge_chunks JOIN knowledge_assets`。执行计划里
      两个 join 都只用到 `session_id` 这一列（`SEARCH c USING INDEX idx_kb_chunks_asset
      (session_id=?)`），也就是**每个成员行都要扫一遍全表**：18,048 × 18,048。
      实测：新服务版本发布后的第一次检索要 **22–24 秒**（`corpusBuiltMs` 只有 259 ms，
      时间全在这条 SQL 上），页面上就是"小木念完了，检索验证页一直显示正在检索"。

      拆成三步后（同一份 18,048 行、2.1 MB 文本）：
        · 资产白名单（明细层、未删、本工作区）：2 ms
        · 快照成员 id（`final` 单独取）：192 ms
        · 分块正文按**主键**分批取（每批 500）：42 ms
      合计约 240 ms 而不是 24 秒 —— 而且不依赖查询规划器"愿不愿意"用主键。

      ⚠ 语义与原 SQL 逐条对齐，别在改写时丢掉：
        · `f.state='有效'` 只取快照里的有效成员；
        · 资产层三个条件（本工作区 / 未删 / `materialized=1`）挡的是规模样本
          ——它没有分块，混进来会让用户搜到一条点不开、说不清来源的命中；
        · `asset_id` 与 `asset_revision` 取**分块行自己的**（原来就是 `c.asset_id`），
          不是快照里的那个。
    */
    const allowedAssets = new Set(
      db
        .prepare(
          `SELECT id FROM knowledge_assets
            WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized = 1`,
        )
        .all(sessionId, projectId)
        .map((row) => row.id),
    );

    const members = db
      .prepare(
        `${snapshotMembersSql(sessionId, serving ?? "")}
         SELECT f.chunk_id AS chunkId, f.asset_id AS assetId FROM final f WHERE f.state='有效'`,
      )
      .all()
      .filter((member) => allowedAssets.has(member.assetId));

    const byChunkId = new Map();
    const BATCH = 500;
    for (let index = 0; index < members.length; index += BATCH) {
      const ids = members.slice(index, index + BATCH).map((member) => member.chunkId);
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, asset_id AS assetId, asset_revision AS assetRevision, chunk_ordinal AS ordinal,
                  text, locator
             FROM knowledge_chunks
            WHERE session_id=? AND id IN (${placeholders}) AND deleted_at IS NULL`,
        )
        .all(sessionId, ...ids);
      for (const row of rows) byChunkId.set(row.id, row);
    }

    /* 按快照成员顺序还原（同一分块在快照里只应出现一次；重复时以第一条为准） */
    const chunks = [];
    const seen = new Set();
    for (const member of members) {
      if (seen.has(member.chunkId)) continue;
      const row = byChunkId.get(member.chunkId);
      if (!row) continue; // 分块行被删/不存在：与原来的 JOIN 一样，这一行不出现
      seen.add(member.chunkId);
      chunks.push({ ...row, locator: parseJson(row.locator, null) });
    }

    // 资产元信息同样只取明细层：检索结果的标题 / 对象 / 分类都从这里来
    const assets = db
      .prepare(
        `SELECT id, title, summary, type, primary_object_id AS primaryObjectId, object_ids AS objectIds,
                content_revision AS contentRevision, updated_at AS updatedAt, captured_at AS capturedAt,
                main_source AS mainSource, business_categories AS businessCategories,
                source_entity_id AS sourceEntityId, zone, building_id AS buildingId
           FROM knowledge_assets WHERE session_id=? AND project_id=? AND deleted_at IS NULL AND materialized = 1`,
      )
      .all(sessionId, projectId)
      .map((row) => ({
        ...row,
        objectIds: parseJson(row.objectIds, []),
        businessCategories: parseJson(row.businessCategories, []),
      }));

    return buildCorpus({ sessionId, servingVersion: serving, chunks, assets });
  });
}

/**
 * 证据检索。
 *
 * 返回的每条命中都带：来源资产、版本、定位、摘要、分数、低相关标记。
 * 低于阈值的结果不丢弃，而是放进 `lowCandidates`：PRD §5.5 要求
 * 「无合格命中显示未检索到匹配证据，允许展开低相关候选，不把低分结果写成回答」。
 */
export function searchKnowledge(db, sessionId, { query, projectId = DEFAULT_SCOPE.id, filters = {}, topK = null, version = null } = {}) {
  const started = Date.now();
  const config = (getConfig(db, sessionId)?.search ?? SEARCH_CONFIG_DEFAULT);
  const serving = currentServingVersion(db, sessionId);
  const corpus = loadCorpus(db, sessionId, { projectId });
  const interpreted = interpretQuery(query);
  const limit = Math.min(Math.max(Number(topK) || config.topKDefault || 10, 1), 50);

  const scored = scoreCorpus(corpus, query);

  const toHit = (item, low) => {
    const asset = item.asset ?? {};
    const locator = item.chunk.locator;
    // 旧版继续服务时结果要带「来源版本 v1，存在更新」（PRD §10.2）
    const stale = asset.contentRevision !== undefined && item.chunk.assetRevision !== asset.contentRevision;
    return {
      chunkId: item.chunk.id,
      assetId: item.chunk.assetId,
      assetRevision: item.chunk.assetRevision,
      currentRevision: asset.contentRevision ?? item.chunk.assetRevision,
      title: asset.title ?? item.chunk.assetId,
      assetType: asset.type ?? "document",
      assetTypeLabel: assetTypeLabel(asset.type ?? "document"),
      objectIds: [asset.primaryObjectId, ...(asset.objectIds ?? [])].filter(Boolean).slice(0, 4),
      primaryObjectId: asset.primaryObjectId ?? null,
      versionNote: stale ? `来源版本 v${item.chunk.assetRevision}，存在更新` : null,
      snippet: makeSnippet(item.chunk.text, []).text,
      locator,
      locatorText: describeLocator(locator),
      score: Number(item.score.toFixed(4)),
      low,
      matchedObjects: item.hitObjects ?? [],
      digest: item.chunk.digest ?? null,
      charCount: item.chunk.text.length,
    };
  };

  // 资产级过滤（PRD §11.3：先按项目、权限、对象、日期与版本过滤候选，再排名）
  const passes = (item) => {
    const asset = item.asset ?? {};
    if (filters.assetType && asset.type !== filters.assetType) return false;
    if (filters.objectId && !(asset.objectIds ?? []).includes(filters.objectId) && asset.primaryObjectId !== filters.objectId) return false;
    if (filters.source && asset.mainSource !== filters.source) return false;
    if (interpreted.timeRange && asset.capturedAt) {
      const at = String(asset.capturedAt).slice(0, 10);
      if (at < interpreted.timeRange.from || at > interpreted.timeRange.to) return false;
    }
    return true;
  };

  const threshold = Number(config.minScoreLow ?? SEARCH_CONFIG_DEFAULT.minScoreLow);
  const qualified = scored.filter((item) => item.score >= threshold && passes(item));
  // 低相关候选也要有内容可看：被覆盖门槛挡掉的结果留在 `lowCandidates`，
  // 页面显示「未检索到匹配证据」时允许展开它们（PRD §5.5）。
  const low = scored
    .filter((item) => item.score < threshold && passes(item))
    .slice(0, 8);

  return {
    query,
    interpreted,
    threshold,
    topK: limit,
    version: version ?? serving,
    servingVersion: serving,
    adapterMode: "demo",
    configRevision: getConfig(db, sessionId)?.revision ?? null,
    hits: diversify(qualified, limit).map((item) => toHit(item, false)),
    lowCandidates: low.map((item) => toHit(item, true)),
    elapsedMs: Date.now() - started,
    corpusBuiltMs: corpus.builtMs,
    totalQualified: qualified.length,
    snapshotSeq: snapshotSeq(db, sessionId),
    serverTime: new Date().toISOString(),
  };
}

/**
 * 结果去重与配比。
 *
 * 两个问题要一起解决：
 *   1. **同一资产霸榜**：Z04 相关查询下，168 张工单的分块会占满前 10 条，
 *      而 PRD §5.5 / §8.1 的示例链路要的是「报告 + 工单 + 照片 + 复核记录」。
 *      做法是按命中分组的资产 ID 去重（同一资产的多个块只保留最高分那条）。
 *   2. **同类目霸榜**：同一主类最多占 Top 10 的 4 条，剩下的位置留给其它主类，
 *      让人一眼看出证据来自多种资料（不是把同类结果藏起来：总命中数照常返回）。
 */
function diversify(hits, limit) {
  const bestPerAsset = new Map();
  for (const item of hits) {
    if (!bestPerAsset.has(item.chunk.assetId)) bestPerAsset.set(item.chunk.assetId, item);
  }
  const unique = [...bestPerAsset.values()].sort((a, b) => b.score - a.score);
  const perType = new Map();
  const chosen = [];
  const deferred = [];
  const cap = Math.max(1, Math.ceil(limit * 0.4));
  for (const item of unique) {
    const type = item.asset?.type ?? "document";
    const used = perType.get(type) ?? 0;
    if (used < cap) {
      perType.set(type, used + 1);
      chosen.push(item);
    } else {
      deferred.push(item);
    }
    if (chosen.length >= limit) break;
  }
  if (chosen.length < limit) chosen.push(...deferred.slice(0, limit - chosen.length));
  return chosen.slice(0, limit);
}

function ngramsForSnippet() {
  return [];
}

/** 无查询时的 3 条工作场景示例（PRD §5.5，不展示算法教程） */
export const SEARCH_EXAMPLES = [
  "Z04 柱脚历次渗水记录与处置结果",
  "扫描设备在九月巡检期间的通信异常",
  "某工单对应的报告、现场照片和复核记录",
];

export { invalidateCorpus };
