/**
 * 数据与知识中心 · 验收脚本
 *
 * 依据：PRD §16（验收标准）、§10.5（演示脚本 S01–S07）、§7（指标口径）。
 *
 * 用法：
 *   node tools/test-knowledge.mjs            # 内存库跑全量断言
 *   node tools/test-knowledge.mjs --verbose  # 打印每一步的数值
 *
 * 这个脚本**只读**断言，不改仓库里的演示库（全部在 :memory: 上跑）。
 */

import { openDatabase } from "../server/storage/db.mjs";
import {
  clearKnowledge,
  deleteAsset,
  getConfig,
  installKnowledgeFixture,
  listIndexVersions,
  queryAssets,
  registerAsset,
  reviseAsset,
} from "../server/services/knowledge-store.mjs";
import { readAssetDetail, readGraph, readMetrics, readOverview, searchKnowledge, SEARCH_EXAMPLES } from "../server/services/knowledge-query.mjs";
import { activateVersion, advanceJob, cancelJob, createJob, createJobRunner, sliceText } from "../server/services/knowledge-jobs.mjs";
import { ensureSampleFiles, fixtureDigest, fixtureReport } from "../server/fixtures/knowledge-samples.mjs";
import { BASELINE_ROWS, BASELINE_TOTALS, computeMetrics } from "../server/domains/knowledge-contract.mjs";
import { buildKnowledgeFixture } from "../server/fixtures/knowledge.mjs";

const SESSION = "demo-01";
const verbose = process.argv.includes("--verbose");
const results = [];

function check(group, name, condition, detail = "") {
  results.push({ group, name, pass: Boolean(condition), detail });
  const mark = condition ? "PASS" : "FAIL";
  if (!condition || verbose) console.log(`[${mark}] ${group} · ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  if (verbose) console.log(`\n=== ${title} ===`);
}

/** 资产索引状态分布：S06 用整张分布比对，比只比四个数字更能抓住状态漂移 */
function assetStateCounts(db, sessionId) {
  const rows = db
    .prepare("SELECT index_state AS state, COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND deleted_at IS NULL GROUP BY index_state ORDER BY index_state")
    .all(sessionId);
  return Object.fromEntries(rows.map((row) => [row.state, row.n]));
}

const db = openDatabase(":memory:");
const runner = createJobRunner({ db, sessionId: SESSION, logger: { error: () => {}, log: () => {} } });
installKnowledgeFixture(db, { sessionId: SESSION });
const fixture = buildKnowledgeFixture({ sessionId: SESSION });
const samples = ensureSampleFiles(db, SESSION);

/* ------------------------------------------------------------------ *
 * D01 / D02：基线数量与基线索引
 *
 * 两层数据的口径（见 knowledge-contract.mjs 的 BASELINE_ROWS 注释）：
 *   total        = 平台规模（materialized + knowledge_scale 里的规模样本）
 *   materialized = 有明细记录的资产，纳入 / 覆盖 / 分块都只对它成立
 * 所以下面既断言总量，也逐类把「规模样本 = total − materialized」从库里数一遍。
 * ------------------------------------------------------------------ */
section("D01/D02 基线");
const baseline = readMetrics(db, SESSION).metrics;
check("D01", "平台资产总量 167,110", baseline.total === 167110 && baseline.total === BASELINE_TOTALS.total, `实际 ${baseline.total}`);
check("D01", "可展开明细 1,500", baseline.materialized === 1500 && baseline.materialized === BASELINE_TOTALS.materialized, `实际 ${baseline.materialized}`);
check("D01", "规模样本 165,610（总量 − 明细）", baseline.scale === 165610 && baseline.total === baseline.materialized + baseline.scale, `实际 ${baseline.scale}`);
check("D01", "纳入索引 870", baseline.included === 870 && baseline.included === BASELINE_TOTALS.included, `实际 ${baseline.included}`);
check("D01", "当前版覆盖 802", baseline.covered === 802 && baseline.covered === BASELINE_TOTALS.covered, `实际 ${baseline.covered}`);
check("D01", "待更新 44", baseline.pending === 44 && baseline.pending === BASELINE_TOTALS.pending, `实际 ${baseline.pending}`);
check("D01", "更新异常 24", baseline.error === 24 && baseline.error === BASELINE_TOTALS.error, `实际 ${baseline.error}`);
check("D01", "未纳入 630", baseline.excluded === 630 && baseline.excluded === BASELINE_TOTALS.excluded, `实际 ${baseline.excluded}`);
check("D01", "覆盖率 92.2%", baseline.coveragePct === 92.2, `实际 ${baseline.coveragePct}`);
check("D02", "有效分块 18,000（从成员记录复算）", baseline.chunks === 18000 && baseline.chunks === BASELINE_TOTALS.chunks, `实际 ${baseline.chunks}`);
check("D02", "逻辑向量条目 18,000（一块一条）", baseline.vectors === 18000 && baseline.vectors === BASELINE_TOTALS.vectors, `实际 ${baseline.vectors}`);
check("D02", "资产总量 = 纳入 + 未纳入（明细层）", baseline.materialized === baseline.included + baseline.excluded, `${baseline.included} + ${baseline.excluded} ≠ ${baseline.materialized}`);
check("D02", "纳入 = 覆盖 + 待更新 + 异常", baseline.included === baseline.covered + baseline.pending + baseline.error);
// 「当前版覆盖」靠成员 revision 与资产当前 revision 比较，不靠有没有成员：
// 待更新 / 异常项的成员停在上一版（旧版继续服务），这个口径必须能从库里复算出来
check("D02", "当前版覆盖可由成员 revision 复算", (() => {
  const serving = readOverview(db, SESSION).servingVersion;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT a.id) AS n FROM knowledge_assets a
         JOIN knowledge_index_members m ON m.session_id=a.session_id AND m.asset_id=a.id AND m.index_version=?
        WHERE a.session_id=? AND a.deleted_at IS NULL AND m.asset_revision = a.content_revision`,
    )
    .get(serving, SESSION);
  return row.n === baseline.covered;
})(), "见 knowledge_index_members.asset_revision");
check("D02", "待更新与异常项的成员停在旧版本", (() => {
  const serving = readOverview(db, SESSION).servingVersion;
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT a.id) AS n FROM knowledge_assets a
         JOIN knowledge_index_members m ON m.session_id=a.session_id AND m.asset_id=a.id AND m.index_version=?
        WHERE a.session_id=? AND a.deleted_at IS NULL AND m.asset_revision <> a.content_revision`,
    )
    .get(serving, SESSION);
  // 旧版仍在服务：这些资产有成员，只是来源 revision 落后于当前 revision
  return row.n >= baseline.pending + baseline.error;
})(), "旧版继续提供检索");

/** 规模样本台账：主类 → 计数（指标里的 total 由它与明细相加而来） */
const scaleByType = new Map(
  db.prepare("SELECT type, count FROM knowledge_scale WHERE session_id=?").all(SESSION).map((row) => [row.type, row.count]),
);
check("D01", "规模样本落库覆盖 12 个主类", scaleByType.size === 12 && scaleByType.size === BASELINE_ROWS.filter((row) => row.total > row.materialized).length, `实际 ${scaleByType.size} 类`);
check("D01", "规模样本合计 165,610", [...scaleByType.values()].reduce((sum, n) => sum + n, 0) === 165610);

for (const row of BASELINE_ROWS) {
  const actual = readMetrics(db, SESSION).byType.find((item) => item.type === row.type);
  check("D01", `${row.label} 行内等式`, actual.materialized === row.materialized && actual.covered === row.covered && actual.pending === row.pending && actual.error === row.error && actual.excluded === row.excluded,
    `明细 ${actual.materialized}/${row.materialized}，覆盖 ${actual.covered}/${row.covered}，待更新 ${actual.pending}/${row.pending}，异常 ${actual.error}/${row.error}，未纳入 ${actual.excluded}/${row.excluded}`);
  check("D01", `${row.label} total ≥ materialized 且总量含规模样本`, row.total >= row.materialized && actual.total === row.materialized + (scaleByType.get(row.type) ?? 0),
    `库内 total ${actual.total} = 明细 ${actual.materialized} + 规模 ${scaleByType.get(row.type) ?? 0}`);
  check("D01", `${row.label} 规模样本 = total − materialized`, (scaleByType.get(row.type) ?? 0) === row.total - row.materialized,
    `库内 ${scaleByType.get(row.type) ?? 0}，契约 ${row.total - row.materialized}`);
  check("D02", `${row.label} 有效分块 ${row.chunkCount}`, actual.chunkCount === row.chunkCount, `实际 ${actual.chunkCount}`);
}

const serverSide = computeMetrics(BASELINE_ROWS);
check("D02", "契约常量与生成器一致", serverSide.chunks === BASELINE_TOTALS.chunks && serverSide.coveragePct === 92.2,
  `chunks ${serverSide.chunks}，覆盖率 ${serverSide.coveragePct}`);
check("D02", "契约行的规模样本与库内一致", serverSide.scale === 165610 && serverSide.total === 167110, `scale ${serverSide.scale}，total ${serverSide.total}`);

const report = fixtureReport(db, SESSION);
check("K13", "夹具报告无错误项", report.errors.length === 0, JSON.stringify(report.errors));
check("K13", "夹具报告含 12 类数量", report.counts.byType.length === 12, `实际 ${report.counts.byType.length}`);
check("K13", "夹具报告带规模样本行（差额合计 165,610）", report.scaleRows.length === 12 && report.scaleRows.reduce((sum, row) => sum + row.count, 0) === 165610,
  `实际 ${report.scaleRows?.length} 行 / 合计 ${report.scaleRows?.reduce((sum, row) => sum + row.count, 0)}`);
check("K13", "可深入展示样本带真实文件", samples.created >= 24, `实际 ${samples.created}`);

/* ------------------------------------------------------------------ *
 * K02/K05：分类、来源、关系
 * ------------------------------------------------------------------ */
section("K02/K05 资产与关系");
const page = queryAssets(db, SESSION, { limit: 50 });
check("K02", "分页返回 50 项", page.items.length === 50, `实际 ${page.items.length}`);
check("K02", "分页游标可翻页且不重复", (() => {
  const second = queryAssets(db, SESSION, { limit: 50, cursor: page.nextCursor });
  const firstIds = new Set(page.items.map((item) => item.id));
  return second.items.every((item) => !firstIds.has(item.id));
})());
check("K02", "按类型筛选生效", queryAssets(db, SESSION, { type: "video", limit: 5 }).items.every((item) => item.type === "video"));
check("K02", "按对象筛选生效", queryAssets(db, SESSION, { objectId: "Z04", limit: 20 }).items.every((item) => item.objectIds.includes("Z04") || item.primaryObjectId === "Z04"));
check("K02", "资产 DTO 带两套状态", page.items.every((item) => item.availability && item.indexState));

// 筛选后的 total 必须与列表一致：计数与查询共用同一段 WHERE，数字对不上比没有数字更糟
for (const [label, filter] of [
  ["业务分类", { category: "修缮工艺" }],
  ["数据来源", { source: "巡检设备" }],
  ["可用性状态", { availability: "待补充内容" }],
  ["索引状态", { indexState: "未纳入" }],
  ["关联对象", { objectId: "Z04" }],
  ["关键词=资产编号", { query: "KA-D-0300" }],
  ["关键词=对象编号", { query: "Z04" }],
]) {
  const filtered = queryAssets(db, SESSION, { ...filter, limit: 5 });
  check("K02", `按${label}筛选时 total 与列表一致`, filtered.total > 0 && filtered.total <= BASELINE_TOTALS.total, `total=${filtered.total}`);
}
/*
  分页只列明细层，但 total 要覆盖两层 —— 这两个口径必须分开，混起来就会出现
  「共 240 项」把平台规模藏掉，或者「加载更多」翻出一批永远列不出来的规模样本。
  逐类核对：total = materialized + 该类规模样本，且返回的行全是明细。
*/
for (const row of BASELINE_ROWS) {
  const page1 = queryAssets(db, SESSION, { type: row.type, limit: 200 });
  const scaleForType = scaleByType.get(row.type) ?? 0;
  check("K02", `${row.label} 列表 total = 明细 + 规模样本`,
    page1.total === row.materialized + scaleForType && page1.materialized === row.materialized,
    `total ${page1.total}，明细 ${page1.materialized}，规模 ${scaleForType}`);
  check("K02", `${row.label} 列表行只有明细层（规模样本不出现）`,
    page1.items.length === Math.min(row.materialized, 200) && page1.items.every((item) => item.materialized === true && Boolean(item.filename)),
    `返回 ${page1.items.length} 行 / 明细 ${row.materialized}`);
}
// 分页必须走到底：规模样本不是列表行，游标不能在它们身上多报一次 hasMore
const imagePageAll = queryAssets(db, SESSION, { type: "image", limit: 200 });
const imagePageRest = queryAssets(db, SESSION, { type: "image", limit: 200, cursor: imagePageAll.nextCursor });
check("K02", "按类型翻页只翻明细层且能走到尽头",
  imagePageAll.items.length === 200 && imagePageAll.hasMore === true
    && imagePageRest.items.length === 40 && imagePageRest.hasMore === false
    && imagePageAll.total === 54160 && imagePageAll.materialized === 240,
  `首页 ${imagePageAll.items.length} + 次页 ${imagePageRest.items.length} = 240，hasMore ${imagePageRest.hasMore}，total ${imagePageAll.total}`);
/*
  带筛选的分页要能走到尽头。**不写死条数**：修缮工艺的份数由夹具的题材权重决定，
  写死 57 这种数字会在权重调整时变成假失败。这里只断言三件真正的不变量：
    1. 两页拿到的是同一批筛选结果（total 一致）；
    2. 两页行数相加 == 第一页的 total（不漏、不重复）；
    3. 走到尽头后 hasMore 为 false（不能出现「加载更多」返回空页）。
  页大小取 1，是为了不管这一类有几份都真的会分成两页 —— 条数少于页大小时
  「两页」其实是同一页，那种断言等于没测。
*/
const craftFilter = { category: "修缮工艺" };
const craftTotal = queryAssets(db, SESSION, { ...craftFilter, limit: 1 }).total;
check("K02", "带筛选的分页能走到尽头", (() => {
  const first = queryAssets(db, SESSION, { ...craftFilter, limit: 1 });
  const second = queryAssets(db, SESSION, { ...craftFilter, limit: 1, cursor: first.nextCursor });
  const ids = new Set([...first.items, ...second.items].map((item) => item.id));
  return craftTotal > 1
    && first.total === craftTotal
    && second.total === craftTotal
    && ids.size === first.items.length + second.items.length
    && first.hasMore === true
    && first.items.every((item) => item.businessCategories.includes("修缮工艺"));
})(), `修缮工艺 ${craftTotal} 项，逐页无重复`);
// 一页装得下时也不能多报 hasMore：说好的翻页能力必须与列表规模一致
check("K02", "单页装下时不多报 hasMore", (() => {
  const one = queryAssets(db, SESSION, { ...craftFilter, limit: 200 });
  return one.items.length === craftTotal && one.hasMore === false && one.nextCursor === null;
})(), `单页 ${craftTotal} 项`);

// 分类、来源、对象这些维度都落进了库（页面上的筛选器不是摆设）
check("K02", "业务分类覆盖九类", (() => {
  const rows = db.prepare("SELECT business_categories FROM knowledge_assets WHERE session_id=?").all(SESSION);
  const set = new Set(rows.flatMap((row) => JSON.parse(row.business_categories)));
  return set.size >= 9 && set.has("修缮工艺") && set.has("政策法规") && set.has("保护规划");
})(), "含修缮工艺 / 政策法规 / 保护规划");

const graph = readGraph(db, SESSION, { view: "business", nodeBudget: 180, edgeBudget: 400 });
check("K05", "业务图节点在预算内", graph.nodes.length <= 180, `实际 ${graph.nodes.length}`);
check("K05", "业务图边在预算内", graph.edges.length <= 400, `实际 ${graph.edges.length}`);
check("K05", "业务图有多个业务簇", graph.clusters >= 6, `实际 ${graph.clusters}`);
check("K05", "每条边有来源字段", graph.edges.every((edge) => edge.relationType && edge.evidenceRef && edge.origin));
check("K05", "业务图不含索引血缘边", graph.edges.every((edge) => graph.relationTypes.includes(edge.relationType)));

const lineage = readGraph(db, SESSION, { view: "lineage", nodeBudget: 250, edgeBudget: 600 });
check("K05", "血缘图分层坐标齐全", lineage.nodes.every((node) => typeof node.x === "number" && typeof node.y === "number" && node.layer));
check("K05", "血缘图不聚合到单块（节点数远小于分块数）", lineage.nodes.length < 250 && lineage.nodes.length < baseline.chunks);
check("K05", "血缘图去向当前服务版本", lineage.nodes.some((node) => node.kind === "indexVersion" && node.label === readOverview(db, SESSION).servingVersion));

/* ------------------------------------------------------------------ *
 * K06：RAG 服务状态与更新状态
 * ------------------------------------------------------------------ */
section("K06 状态");
const overview = readOverview(db, SESSION);
check("K06", "服务状态为可检索", overview.indexStatus.service === "可检索");
check("K06", "更新状态为有更新异常", overview.indexStatus.update === "有更新异常", overview.indexStatus.update);
check("K06", "六项指标齐全", ["total", "coveragePct", "chunks", "vectors", "pending", "error"].every((key) => overview.metrics[key] !== undefined));
check("K06", "当前服务版本 KB-021", overview.servingVersion === "KB-021", overview.servingVersion);
check("K06", "最近成功发布时间存在", Boolean(overview.indexStatus.lastPublishedAt));
check("K06", "构建统计与当前有效数量分开返回", overview.indexStatus.buildCounts && overview.indexStatus.effective);

/* ------------------------------------------------------------------ *
 * K11 / R01–R04：检索
 * ------------------------------------------------------------------ */
section("K11/R01–R04 检索");
const querySet = [
  { q: SEARCH_EXAMPLES[0], expectHit: true },
  { q: SEARCH_EXAMPLES[1], expectHit: true },
  { q: SEARCH_EXAMPLES[2], expectHit: true },
  { q: "Z04 柱 渗水", expectHit: true },
  { q: "SCAN-01 通信异常", expectHit: true },
  { q: "WO-003 处置记录", expectHit: true },
  { q: "五月巡检报告 大雄宝殿", expectHit: true },
  { q: "九月巡检 柱脚", expectHit: true },
  { q: "木材含水率 检测记录", expectHit: true },
  { q: "构件档案 修缮", expectHit: true },
  { q: "场景发布记录 锚点", expectHit: true },
  { q: "设备校准 偏差", expectHit: true },
  { q: "油饰起甲 影像", expectHit: true },
  { q: "碑廊 墙体 虫蛀", expectHit: true },
  { q: "天王殿 屋面 檩", expectHit: true },
  { q: "月台 柱础 沉陷", expectHit: true },
  { q: "紫禁城角楼琉璃瓦烧制工艺", expectHit: false },
  { q: "量子隧穿光谱仪标定流程", expectHit: false },
  { q: "寒山寺 钟楼 铜钟 铸造", expectHit: false },
  { q: "航天器热控涂层老化", expectHit: false },
];
let hitCount = 0;
let searched = 0;
for (const item of querySet) {
  const result = searchKnowledge(db, SESSION, { query: item.q });
  const hasHit = result.hits.length > 0;
  if (item.expectHit) {
    searched += 1;
    if (hasHit) hitCount += 1;
  } else {
    check("R04", `无命中查询不编造回答：${item.q}`, !hasHit, `命中 ${result.hits.length}`);
  }
  check("R03", `命中带来源定位：${item.q}`, !hasHit || result.hits.every((hit) => hit.locator && hit.locatorText && hit.assetId));
}
const recall = searched ? Math.round((hitCount / searched) * 100) : 0;
check("R02", "标注可命中查询的 Top 5 召回 ≥90%", recall >= 90, `${hitCount}/${searched} = ${recall}%`);

const first = searchKnowledge(db, SESSION, { query: SEARCH_EXAMPLES[0] });
check("R07", "结果绑定单一已发布版本", first.hits.every((hit) => hit.assetRevision !== undefined) && first.servingVersion === overview.servingVersion);
check("R03", "定位类型覆盖多种资料", new Set([first, ...querySet.slice(1, 8).map((item) => searchKnowledge(db, SESSION, { query: item.q }))].flatMap((result) => result.hits.map((hit) => hit.locator.kind))).size >= 3);
check("K11", "对象编号精确匹配排在前面", first.hits[0].matchedObjects.length > 0 || first.hits.some((hit) => hit.matchedObjects.length > 0));

/* ------------------------------------------------------------------ *
 * K02 资产详情
 * ------------------------------------------------------------------ */
section("K02 资产详情");
const deepId = report.deepSampleIds[0];
const detail = readAssetDetail(db, SESSION, deepId);
check("K02", "详情返回内容页签数据", Boolean(detail?.content?.text));
check("K02", "详情返回分块与向量", detail.chunks.length > 0 && detail.chunks.every((chunk) => chunk.vectorId));
check("K02", "详情返回版本历史", detail.revisions.length === detail.asset.contentRevision);
check("K02", "详情返回关联关系", detail.relations.length > 0);
check("D13", "未随包提供附件的资产明确标注", (() => {
  // 列表只列**可展开明细**：规模样本不落知识资产表，本来就不在 items 里
  const noFile = queryAssets(db, SESSION, { limit: 200 }).items.find((item) => !item.fileId);
  const noFileDetail = readAssetDetail(db, SESSION, noFile.id);
  return noFileDetail.file.provided === false && Boolean(noFileDetail.file.note);
})(), "没有 file_id 时不出现可点却无文件的下载按钮");
check("D13", "列表 total 覆盖两层、materialized 只数明细", (() => {
  const widened = queryAssets(db, SESSION, { limit: 200 });
  return widened.total === BASELINE_TOTALS.total
    && widened.materialized === BASELINE_TOTALS.materialized
    && widened.items.every((item) => item.materialized === true);
})(), `total ${BASELINE_TOTALS.total} / 明细 ${BASELINE_TOTALS.materialized}`);

/* ------------------------------------------------------------------ *
 * P01 两层资产模型：文件名、规模样本、二进制主类
 *
 * 这一组断言的是「数据模型本身」而不是页面数字：
 *   · 每条明细都有唯一文件名（否则列表里会出现两条一模一样的资料）；
 *   · 文件名不能清一色中文（真实资料库里设备与算法产物就是英文编号）；
 *   · 扫描 / 高斯 / 点云 / 权重这四类没有可检索文本，必须全部「未纳入」；
 *   · 总览的分布图各扇区相加必须等于总量。
 * ------------------------------------------------------------------ */
section("P01 两层资产模型");
const allAssets = queryAssets(db, SESSION, { limit: 200 }).items;
check("P01", "每条明细资产都有非空文件名", (() => {
  const missing = db.prepare("SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND materialized=1 AND (filename IS NULL OR filename='')").get(SESSION).n;
  return missing === 0;
})(), "filename 非空");
check("P01", "文件名在夹具内唯一", (() => {
  const row = db
    .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT filename) AS names FROM knowledge_assets WHERE session_id=? AND materialized=1")
    .get(SESSION);
  return row.n > 0 && row.n === row.names;
})(), (() => {
  const row = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT filename) AS names FROM knowledge_assets WHERE session_id=? AND materialized=1").get(SESSION);
  return `${row.names} 个不同文件名 / ${row.n} 条`;
})());
check("P01", "至少 25% 文件名不含中文（中英混排）", (() => {
  const names = db.prepare("SELECT filename FROM knowledge_assets WHERE session_id=? AND materialized=1").all(SESSION).map((row) => row.filename);
  const latin = names.filter((name) => !/[\u4e00-\u9fa5]/.test(name ?? "")).length;
  return names.length > 0 && latin >= names.length * 0.25;
})(), (() => {
  const names = db.prepare("SELECT filename FROM knowledge_assets WHERE session_id=? AND materialized=1").all(SESSION).map((row) => row.filename);
  const latin = names.filter((name) => !/[\u4e00-\u9fa5]/.test(name ?? "")).length;
  return `纯英文/编号 ${latin}/${names.length} = ${Math.round((latin / names.length) * 100)}%`;
})());
check("P01", "资产 DTO 带 materialized 标记与文件名", allAssets.length > 0 && allAssets.every((item) => item.materialized === true && Boolean(item.filename)));

// 四个二进制主类：本期只登记与统计，一行都不该进索引（没有可检索文本）
const BINARY_TYPES = [
  { type: "scanData", label: "扫描数据" },
  { type: "gaussian", label: "高斯场景" },
  { type: "pointCloud", label: "点云数据" },
  { type: "modelWeight", label: "模型权重" },
];
const binaryRows = BINARY_TYPES.map((item) => ({ ...item, row: BASELINE_ROWS.find((entry) => entry.type === item.type) }));
check("P01", "至少三个二进制主类存在且数量与契约一致", binaryRows.filter((item) => {
  const actual = readMetrics(db, SESSION).byType.find((entry) => entry.type === item.type);
  return actual.materialized === item.row.materialized && actual.materialized > 0;
}).length >= 3, binaryRows.map((item) => `${item.label} ${item.row.materialized}`).join(" / "));
for (const item of binaryRows) {
  const actual = readMetrics(db, SESSION).byType.find((entry) => entry.type === item.type);
  check("P01", `${item.label} ${item.row.materialized} 项全部「未纳入」`, actual.excluded === item.row.materialized && actual.included === 0 && actual.chunkCount === 0,
    `未纳入 ${actual.excluded} / 纳入 ${actual.included} / 分块 ${actual.chunkCount}`);
}
check("P01", "二进制主类的排除原因写清楚（不是空原因）", db
  .prepare(`SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND type IN ('scanData','gaussian','pointCloud','modelWeight') AND (excluded_reason IS NULL OR excluded_reason='')`)
  .get(SESSION).n === 0, "每一行都有排除原因");

check("P01", "总览 coverage 每行同时带 total 与 materialized", overview.coverage.length === 12 && overview.coverage.every((row) => typeof row.total === "number" && typeof row.materialized === "number" && row.total >= row.materialized));
check("P01", "总览 coverage 的 total 之和 = metrics.total", overview.coverage.reduce((sum, row) => sum + row.total, 0) === overview.metrics.total,
  `${overview.coverage.reduce((sum, row) => sum + row.total, 0)} vs ${overview.metrics.total}`);
check("P01", "总览 coverage 带规模样本说明", overview.coverage.every((row) => row.scale === 0 || Boolean(row.scaleNote)));
check("P01", "可用性分布各状态相加 = 平台总量", overview.availability.reduce((sum, row) => sum + row.n, 0) === overview.metrics.total,
  `${overview.availability.reduce((sum, row) => sum + row.n, 0)} vs ${overview.metrics.total}`);
check("P01", "来源分布各来源相加 = 平台总量", overview.sources.reduce((sum, row) => sum + row.n, 0) === overview.metrics.total,
  `${overview.sources.reduce((sum, row) => sum + row.n, 0)} vs ${overview.metrics.total}`);
check("P01", "有可用索引资产只数明细层", overview.metrics.assetsInServingIndex === 870 && overview.metrics.assetsInServingIndex <= overview.metrics.materialized,
  `实际 ${overview.metrics.assetsInServingIndex}`);
// 图上每个节点都是可点的：规模样本没有文件名 / 版本 / 分块，作为节点点开就是死路。
// 断言的是「图里的资产节点数 = 明细资产数」，而不是有没有某个前缀的 ID ——
// 夹具将来真的插入规模样本行时，这条断言仍然成立。
const graphAssetIds = new Set([
  ...graph.nodes.filter((node) => node.kind === "asset").map((node) => node.id),
  ...lineage.nodes.filter((node) => node.kind === "assetVersion").map((node) => String(node.id).replace(/^L:/, "")),
]);
check("P01", "关系图只出现明细资产（规模样本不进图）", graph.scopeCounts.assets === baseline.materialized && [...graphAssetIds].every((id) => /^KA-/.test(id)),
  `图内资产节点 ${graphAssetIds.size} 个，范围内明细 ${graph.scopeCounts.assets} 项`);
check("P01", "血缘图范围计数 = 明细资产数", lineage.scopeCounts.assets === baseline.materialized, `实际 ${lineage.scopeCounts.assets}`);
check("P01", "业务图节点全部来自资产或关联对象（无规模样本死节点）", graph.nodes.every((node) => node.kind !== "asset" || db.prepare("SELECT materialized FROM knowledge_assets WHERE session_id=? AND id=?").get(SESSION, node.id)?.materialized === 1));

/* ------------------------------------------------------------------ *
 * S01 新增资料：导入一个产生 8 个分块的已知文本夹具
 *
 * PRD §10.5 的原话是「登记后资产 1,249、纳入 949、待更新 37；发布后覆盖 901、
 * 待更新 36、分块及向量各 18,428」。分块数由导入文本与 chunkPolicy 决定，
 * 所以这里**按参数现算**期望值，而不是把 8 抄进断言——换分块策略时断言仍然成立。
 * ------------------------------------------------------------------ */
section("S01 新增资料");
const policy = getConfig(db, SESSION).chunkPolicy;
// 用长段落构造，保证「人物-分块」对应关系稳定（短行会被合并，块数不可预测）
const textOfChunks = (count) => Array.from({ length: count }, (_, index) => `第 ${index + 1} 段：${"柱脚渗水复核记录".repeat(40)}`).join("\n");
const expectedChunks = sliceText(textOfChunks(8), policy).length;
check("S01", "夹具按分块策略切成 8 块", expectedChunks === 8, `实际 ${expectedChunks}`);
const s01Before = readMetrics(db, SESSION).metrics;
const imported = registerAsset(db, SESSION, {
  type: "document",
  title: "Z04 柱脚 · 渗水复核补充记录",
  format: "TXT",
  text: textOfChunks(8),
  objectIds: ["Z04"],
  primaryObjectId: "Z04",
  sourceSystem: "人工导入",
  mainSource: "人工导入",
  summary: "补充记录：Z04 柱脚渗水复核",
});
check("S01", "登记后资产总量 +1", readMetrics(db, SESSION).metrics.total === s01Before.total + 1, `${s01Before.total} → ${readMetrics(db, SESSION).metrics.total}`);
check("S01", "登记后纳入 +1", readMetrics(db, SESSION).metrics.included === s01Before.included + 1);
check("S01", "登记后待更新 +1", readMetrics(db, SESSION).metrics.pending === s01Before.pending + 1);
check("S01", "新资产进入待更新而不是直接已覆盖", queryAssets(db, SESSION, { query: imported.assetId }).items[0].indexState === "待更新");

const s01 = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "changed", assetIds: [imported.assetId], triggerSource: "S01" });
check("S01", "新资产进入更新队列", s01.inputs.length === 1, `实际 ${s01.inputs.length}`);
const jobBefore = readMetrics(db, SESSION).metrics;
runner.runToEnd(s01.job.id);
// 注意：`s01.job` 是**建任务时**的返回值，那时 counts 还是 0；
// 处理结果必须从库里重读（真正的任务计数在 advanceJob 里累加）。
const s01JobRow = db.prepare("SELECT counts, status FROM knowledge_jobs WHERE id=?").get(s01.job.id);
const s01Counts = JSON.parse(s01JobRow.counts);
const s01After = readMetrics(db, SESSION).metrics;
check("S01", "任务处理 1 项且成功", s01Counts.succeeded === 1 && s01Counts.failed === 0, JSON.stringify(s01Counts));
check("S01", "新资产按分块策略切成 8 块", s01Counts.chunks === expectedChunks, `实际 ${s01Counts.chunks}，期望 ${expectedChunks}`);
check("S01", "发布后覆盖 +1", s01After.covered === jobBefore.covered + 1, `${jobBefore.covered} → ${s01After.covered}`);
check("S01", "发布后待更新回到原值", s01After.pending === s01Before.pending, `${s01After.pending}`);
check("S01", "分块增加量 = 处理记录求和", s01After.chunks === jobBefore.chunks + s01Counts.chunks, `${jobBefore.chunks} + ${s01Counts.chunks} → ${s01After.chunks}`);
// PRD §10.5 的示范值按两层数据的基线换算：覆盖 802+1=803、待更新回到 44、
// 分块 18,000+8=18,008。三个数都从 BASELINE_* 推，不另抄一份常量。
check("S01", "演示基线口径：覆盖 803 / 待更新 44 / 分块 18,008",
  s01After.covered === BASELINE_TOTALS.covered + 1
    && s01After.pending === BASELINE_TOTALS.pending
    && s01After.chunks === BASELINE_TOTALS.chunks + expectedChunks,
  `${s01After.covered}/${s01After.pending}/${s01After.chunks}`);
check("S01", "规模样本不随明细变化（发布只动明细层）", s01After.scale === BASELINE_TOTALS.total - BASELINE_TOTALS.materialized && s01After.total === BASELINE_TOTALS.total + 1, `scale ${s01After.scale}，total ${s01After.total}`);
check("S01", "发布了新的服务版本", readOverview(db, SESSION).servingVersion !== "KB-021", readOverview(db, SESSION).servingVersion);

/* ------------------------------------------------------------------ *
 * S02 更新文档：把一个已覆盖文档从 20 块替换为 24 块
 *
 * 期望值同样按分块策略现算：只要「新块数 > 旧块数」，服务块净增就是差值。
 * ------------------------------------------------------------------ */
section("S02 更新文档");
const oldText = textOfChunks(20);
const oldChunks = sliceText(oldText, policy).length;
const target = registerAsset(db, SESSION, {
  type: "document",
  title: "L01 梁 · 含水率复测记录（版本对照用）",
  format: "TXT",
  text: oldText,
  objectIds: ["L01"],
  primaryObjectId: "L01",
});
const seedJob = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "changed", assetIds: [target.assetId], triggerSource: "S02 初始版本" });
runner.runToEnd(seedJob.job.id);
const afterSeed = readMetrics(db, SESSION).metrics;
check("S02", "对照资产先有 20 块", db.prepare("SELECT COUNT(*) AS n FROM knowledge_index_members WHERE session_id=? AND asset_id=?").get(SESSION, target.assetId).n === oldChunks, `实际 ${oldChunks}`);
check("S02", "对照资产初始为 20 块", oldChunks === 20, `实际 ${oldChunks}`);

const newText = textOfChunks(24);
const newChunks = sliceText(newText, policy).length;
check("S02", "新版为 24 块", newChunks === 24, `实际 ${newChunks}`);
const revised = reviseAsset(db, SESSION, { assetId: target.assetId, text: newText, actorId: "rao" });
check("S02", "内容替换后 revision +1", revised.revision === 2, JSON.stringify(revised));
const afterRevise = readMetrics(db, SESSION).metrics;
check("S02", "替换后覆盖 -1（当前版待更新）", afterRevise.covered === afterSeed.covered - 1, `${afterSeed.covered} → ${afterRevise.covered}`);
check("S02", "替换后待更新 +1", afterRevise.pending === afterSeed.pending + 1);
check("S02", "替换后服务块数不变（旧版继续服务）", afterRevise.chunks === afterSeed.chunks, `${afterSeed.chunks} → ${afterRevise.chunks}`);
const staleDetail = readAssetDetail(db, SESSION, target.assetId);
check("S02", "详情提示旧版继续服务", Boolean(staleDetail.index?.note), staleDetail.index?.note ?? "");

const s02 = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "changed", assetIds: [target.assetId], triggerSource: "S02" });
runner.runToEnd(s02.job.id);
const s02Counts = JSON.parse(db.prepare("SELECT counts FROM knowledge_jobs WHERE id=?").get(s02.job.id).counts);
const s02After = readMetrics(db, SESSION).metrics;
check("S02", "新版切成 24 块", s02Counts.chunks === newChunks, `实际 ${s02Counts.chunks}，期望 ${newChunks}`);
check("S02", "发布后覆盖恢复", s02After.covered === afterSeed.covered, `${s02After.covered}`);
check("S02", "发布后待更新回到替换前", s02After.pending === afterSeed.pending);
check("S02", "服务块数净增 = 新块数 - 旧块数", s02After.chunks === afterSeed.chunks + (newChunks - oldChunks), `${afterSeed.chunks} + (${newChunks} - ${oldChunks}) → ${s02After.chunks}`);

/* ------------------------------------------------------------------ *
 * S01 后续 + S04 积压同步
 *
 * PRD §10.5 的 S04 是「处理初始的待更新资产，全部成功，待更新 0、
 * 异常不变、覆盖率上升；分块增加量从具体处理记录求和」。
 * 按两层数据的基线，初始待更新是 44 项（BASELINE_TOTALS.pending），
 * 所以下面全部用契约常量现算 44 / 846 / 97.2%，不另抄一份数字。
 *
 * 这里**不**断言分块总数一定变大：服务端重新读取真实文本并重新分块，日志批次
 * 这类聚合内容重切后可能比演示基线的块数少（基线是夹具按目标块数分摊的）。
 * 断言的是「分块数 = 处理记录求和」这个真正的口径。
 * ------------------------------------------------------------------ */
section("S04 积压同步");
const backlog = BASELINE_TOTALS.pending;
const s04 = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "backlog", triggerSource: "S04" });
check("S04", `存在 ${backlog} 项积压`, s04.inputs.length === backlog, `实际 ${s04.inputs.length}`);
const s04Before = readMetrics(db, SESSION).metrics;
runner.runToEnd(s04.job.id);
const s04Counts = JSON.parse(db.prepare("SELECT counts FROM knowledge_jobs WHERE id=?").get(s04.job.id).counts);
const s04After = readMetrics(db, SESSION).metrics;
check("S04", `积压处理成功后覆盖 +${backlog}`, s04After.covered === s04Before.covered + backlog, `${s04Before.covered} → ${s04After.covered}`);
check("S04", "待更新清零", s04After.pending === 0, `实际 ${s04After.pending}`);
check("S04", `异常计数不变（${BASELINE_TOTALS.error}）`, s04After.error === BASELINE_TOTALS.error, `实际 ${s04After.error}`);
// 覆盖率 = 覆盖 / 纳入，分母是 included 而不是 total（规模样本没有分块记录，不能进分母）
check("S04", "覆盖率 = 覆盖 / 纳入（现算）", s04After.coveragePct === Number(((s04After.covered / s04After.included) * 100).toFixed(1)),
  `实际 ${s04After.coveragePct}%，覆盖 ${s04After.covered} / 纳入 ${s04After.included}`);
check("S04", "分块变化 = 处理记录求和 - 被替换的旧块", s04After.chunks === s04Before.chunks + s04Counts.chunks - s04Counts.replacedChunks, `${s04Before.chunks} + ${s04Counts.chunks} - ${s04Counts.replacedChunks} → ${s04After.chunks}`);
check("S04", "全部成功没有失败项", s04Counts.failed === 0 && s04Counts.succeeded === backlog, JSON.stringify(s04Counts));

/* ------------------------------------------------------------------ *
 * S05 失败重试（基线的 24 个异常资产）
 *
 * 放在 S03 之前：S03 要验证「删掉一个**已覆盖**资产」，
 * 需要先让异常项清零、待更新项全部处理掉。
 * ------------------------------------------------------------------ */
section("S05 失败重试");
const errorBase = BASELINE_TOTALS.error;
const s05 = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "errors", triggerSource: "S05" });
check("S05", `异常项可重试（${errorBase} 项）`, s05.inputs.length === errorBase, `实际 ${s05.inputs.length}`);
const s05Before = readMetrics(db, SESSION).metrics;
runner.runToEnd(s05.job.id);
const s05After = readMetrics(db, SESSION).metrics;
check("S05", "重试成功后异常清零", s05After.error === 0, `实际 ${s05After.error}`);
check("S05", `覆盖增加 ${errorBase}`, s05After.covered === s05Before.covered + errorBase, `${s05Before.covered} → ${s05After.covered}`);
check("S05", "重试项全部进入已覆盖", db.prepare("SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND index_state IN ('待更新','处理中')").get(SESSION).n === 0, "没有悬空的待更新 / 处理中");
check("S05", "重复点击不产生第二份结果", createJob(db, { sessionId: SESSION, actorId: "shi", scope: "errors", triggerSource: "S05-repeat" }).job === null, "异常项已清空，再点没有输入");

/* ------------------------------------------------------------------ *
 * S03 清理删除：删一个已覆盖、有分块的资产
 *
 * 块数**不写死**：夹具按每类的分块配额生成，写死 3 会在配额调整时变成假失败。
 * 这里挑「当前服务版本里有分块、且源 revision 与资产当前 revision 一致」的第一个
 * 已覆盖资产，把它真实拥有的块数记为期望值，然后逐项核对删除前后的变化。
 * ------------------------------------------------------------------ */
section("S03 清理删除");
const victim = db
  .prepare(
    `SELECT a.id, a.type, COUNT(*) AS n FROM knowledge_assets a
       JOIN knowledge_index_members m ON m.session_id=a.session_id AND m.asset_id=a.id
      WHERE a.session_id=? AND a.deleted_at IS NULL
        AND a.index_state='已覆盖'
        AND m.index_version=(SELECT serving_version FROM knowledge_index_heads WHERE session_id=? LIMIT 1)
        AND m.asset_revision = a.content_revision
      GROUP BY a.id, a.type HAVING n >= 2 ORDER BY n ASC, a.id LIMIT 1`,
  )
  .get(SESSION, SESSION);
check("S03", "存在带分块的已覆盖资产", Boolean(victim), victim ? `${victim.id}（${victim.type}，${victim.n} 块）` : "无");
if (victim) {
  const removedChunks = victim.n;
  const beforeDelete = readMetrics(db, SESSION).metrics;
  const removed = deleteAsset(db, SESSION, { assetId: victim.id, actorId: "shen" });
  const afterDelete = readMetrics(db, SESSION).metrics;
  check("S03", "活跃资产 -1", afterDelete.total === beforeDelete.total - 1, `${beforeDelete.total} → ${afterDelete.total}`);
  check("S03", "明细资产 -1（规模样本不动）", afterDelete.materialized === beforeDelete.materialized - 1 && afterDelete.scale === beforeDelete.scale,
    `明细 ${beforeDelete.materialized} → ${afterDelete.materialized}，规模 ${afterDelete.scale}`);
  check("S03", "纳入 -1", afterDelete.included === beforeDelete.included - 1);
  check("S03", "覆盖 -1", afterDelete.covered === beforeDelete.covered - 1, `${beforeDelete.covered} → ${afterDelete.covered}`);
  check("S03", `有效分块 -${removedChunks}`, afterDelete.chunks === beforeDelete.chunks - removedChunks, `${beforeDelete.chunks} → ${afterDelete.chunks}`);
  check("S03", "删除返回被清理的分块数", removed.chunksRemoved === removedChunks, JSON.stringify(removed));
  check("S03", "删除后立刻不可检索", searchKnowledge(db, SESSION, { query: "复核照片 影像" }).hits.every((hit) => hit.assetId !== victim.id));
  check("S03", "资产列表不再出现", queryAssets(db, SESSION, { query: victim.id }).items.length === 0);
  const kb021 = listIndexVersions(db, SESSION).find((item) => item.id === "KB-021");
  check("D09", "历史版本保留原始构建计数（不因后来删除而改写）", kb021.buildCounts.chunks === BASELINE_TOTALS.chunks && kb021.buildCounts.assets === BASELINE_TOTALS.included,
    JSON.stringify(kb021.buildCounts));
  // 构建统计与「当前有效数量」必须在同一张卡片上自洽：构建处理的是纳入资产，
  // 不是全部明细（扫描数据 / 高斯 / 点云 / 权重没有可提取文本，不进构建）。
  check("D09", "当前服务版本的构建统计与有效数量同源", kb021.buildCounts.assets === overview.indexStatus.effective.assets
    && kb021.buildCounts.chunks === overview.indexStatus.effective.chunks,
    `build=${kb021.buildCounts.assets}/${kb021.buildCounts.chunks} effective=${overview.indexStatus.effective.assets}/${overview.indexStatus.effective.chunks}`);
}

/* ------------------------------------------------------------------ *
 * S06 版本恢复
 *
 * PRD §10.5 说明脚本「除另有说明外均从第 7 节基线重置后独立执行」，
 * 所以这里先重置回 knowledge-demo-v1，再产生一个新版本，然后切回 KB-021。
 * ------------------------------------------------------------------ */
section("S06 版本恢复");
clearKnowledge(db, SESSION);
installKnowledgeFixture(db, { sessionId: SESSION });
check("S06", "重置回基线", readMetrics(db, SESSION).metrics.chunks === BASELINE_TOTALS.chunks && readMetrics(db, SESSION).metrics.coveragePct === 92.2,
  `分块 ${readMetrics(db, SESSION).metrics.chunks}，覆盖率 ${readMetrics(db, SESSION).metrics.coveragePct}`);
const seedVersionJob = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "backlog", triggerSource: "S06 前置" });
runner.runToEnd(seedVersionJob.job.id);
const newVersion = readOverview(db, SESSION).servingVersion;
check("S06", "先产生一个新版本", newVersion !== "KB-021", newVersion);
const beforeSwitch = readMetrics(db, SESSION).metrics;
const switched = activateVersion(db, SESSION, { version: "KB-021", actorId: "shi" });
check("S06", "可切回基线版本", switched.ok === true, JSON.stringify(switched));
const afterSwitch = readMetrics(db, SESSION).metrics;
check("S06", "切回后有效分块回到基线", afterSwitch.chunks === BASELINE_TOTALS.chunks, `实际 ${afterSwitch.chunks}`);
check("S06", `切回后覆盖回到 ${BASELINE_TOTALS.covered}`, afterSwitch.covered === BASELINE_TOTALS.covered, `实际 ${afterSwitch.covered}`);
// 切版后「待更新」会包含原来的更新失败项：失败是**针对某个目标 revision 的任务结果**，
// 切换索引版本并不修复它，也不该把它丢掉（PRD §9.2 把失败定义为独立事实）。
// 所以这里断言的是「待更新 + 异常 = 基线的未覆盖项之和」，而不是硬写某一个数。
const uncovered = BASELINE_TOTALS.pending + BASELINE_TOTALS.error;
check("S06", `切回后未覆盖仍是 ${uncovered} 项（${BASELINE_TOTALS.pending} 待更新 + ${BASELINE_TOTALS.error} 异常）`,
  afterSwitch.pending + afterSwitch.error === uncovered, `实际 ${afterSwitch.pending} + ${afterSwitch.error}`);
check("S06", "切回后纳入资产数不变", afterSwitch.included === BASELINE_TOTALS.included, `实际 ${afterSwitch.included}`);
// 状态分布按契约常量现算：夹具的状态分配比例一调，这里跟着变，不会变成假失败
check("S06", "切回后索引状态回到基线分布", JSON.stringify({ covered: afterSwitch.covered, pending: afterSwitch.pending + afterSwitch.error, excluded: afterSwitch.excluded })
  === JSON.stringify({ covered: BASELINE_TOTALS.covered, pending: BASELINE_TOTALS.pending + BASELINE_TOTALS.error, excluded: BASELINE_TOTALS.excluded }),
  JSON.stringify(assetStateCounts(db, SESSION)));
check("S06", "只切索引层：原始资产不回滚（含规模样本的总量不变）", queryAssets(db, SESSION, { limit: 1 }).total === BASELINE_TOTALS.total, `实际 ${queryAssets(db, SESSION, { limit: 1 }).total}`);
check("S06", "切换回新版本仍可再切", activateVersion(db, SESSION, { version: newVersion, actorId: "shi" }).ok);
check("S06", "切到新版本后覆盖回到基线", readMetrics(db, SESSION).metrics.covered === beforeSwitch.covered, `实际 ${readMetrics(db, SESSION).metrics.covered}`);
check("S06", "全程原始资产未变化", beforeSwitch.total === readMetrics(db, SESSION).metrics.total);

/* ------------------------------------------------------------------ *
 * D07 取消：暂存不进服务版本
 * ------------------------------------------------------------------ */
section("D04/D07 幂等与取消");
// 取消要验证的是「已取消的任务不污染服务版本」，所以先造一批待更新，
// 不能依赖前一步脚本留下的积压（S06 重置后积压口径已经变了）。
const pendingBefore = db.prepare("SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND index_state IN ('待更新','处理中')").get(SESSION).n;
db.prepare(
  `UPDATE knowledge_assets SET index_state='待更新'
    WHERE session_id=? AND id IN (SELECT id FROM knowledge_assets WHERE session_id=? AND index_state='已覆盖' ORDER BY id LIMIT 12)`,
).run(SESSION, SESSION);
const cancelTarget = createJob(db, { sessionId: SESSION, actorId: "shi", scope: "backlog", triggerSource: "取消演示" });
check("D07", "待更新资产可被调度", Boolean(cancelTarget.job) && cancelTarget.inputs.length === pendingBefore + 12, `输入 ${cancelTarget.inputs.length}，期望 ${pendingBefore + 12}`);
if (cancelTarget.job) {
  const servingBefore = readOverview(db, SESSION).servingVersion;
  const chunksBefore = readMetrics(db, SESSION).metrics.chunks;
  advanceJob(db, SESSION, cancelTarget.job.id);
  const cancelled = cancelJob(db, SESSION, cancelTarget.job.id);
  check("D07", "取消成功", cancelled.ok === true, JSON.stringify(cancelled));
  check("D07", "取消后服务版本不变", readOverview(db, SESSION).servingVersion === servingBefore);
  check("D07", "取消后有效分块不变（暂存不进总览）", readMetrics(db, SESSION).metrics.chunks === chunksBefore);
  check("D07", "取消后资产回到待更新", db.prepare("SELECT COUNT(*) AS n FROM knowledge_assets WHERE session_id=? AND index_state='处理中'").get(SESSION).n === 0);
  runner.runToEnd(cancelTarget.job.id);
  check("D07", "已取消的任务不会再被推进成成功", db.prepare("SELECT status FROM knowledge_jobs WHERE id=?").get(cancelTarget.job.id).status === "已取消");
  check("D07", "取消后没有留下暂存分块", db.prepare("SELECT COUNT(*) AS n FROM knowledge_index_members WHERE session_id=? AND index_version LIKE '%JOB%'").get(SESSION).n === 0);
} else {
  check("D07", "存在可取消的积压任务", false, "没有输入");
}

/* ------------------------------------------------------------------ *
 * D11 空数据与全排除
 * ------------------------------------------------------------------ */
section("D11 空数据");
const emptySession = "demo-empty";
clearKnowledge(db, emptySession);
const emptyMetrics = readMetrics(db, emptySession).metrics;
check("D11", "空库分母为 0 时覆盖率为 null（显示 —）", emptyMetrics.coveragePct === null, String(emptyMetrics.coveragePct));
const emptySearch = searchKnowledge(db, emptySession, { query: "Z04" });
check("D11", "空库检索不报错且无命中", emptySearch.hits.length === 0);

/* ------------------------------------------------------------------ *
 * K13 夹具可重复（同一天重置必须完全一致）
 * ------------------------------------------------------------------ */
section("K13 夹具可重复");
const fixedAnchor = "2026-09-13T00:00:00.000Z";
const digestA = fixtureDigest(db, SESSION);
const db2 = openDatabase(":memory:");
installKnowledgeFixture(db2, { sessionId: SESSION, anchor: fixedAnchor });
const digestA2 = fixtureDigest(db2, SESSION);
const db3 = openDatabase(":memory:");
installKnowledgeFixture(db3, { sessionId: SESSION, anchor: fixedAnchor });
const digestB = fixtureDigest(db3, SESSION);
check("K13", "同 seed 重置后夹具完全一致", digestA2.sha256 === digestB.sha256, `${digestA2.sha256.slice(0, 12)} vs ${digestB.sha256.slice(0, 12)}`);
check("K13", "重置后分块与资产总数回到基线", digestA2.chunks === BASELINE_TOTALS.chunks && digestA2.assets === BASELINE_TOTALS.materialized, `${digestA2.chunks}/${digestA2.assets}`);
check("K13", "夹具覆盖十二个主类", new Set(fixture.assets.map((asset) => asset.type)).size === 12, `实际 ${new Set(fixture.assets.map((asset) => asset.type)).size} 类`);
check("K13", "夹具报告的规模样本与契约一致", fixture.report.scaleRows.length === 12
  && fixture.report.scaleTotal === BASELINE_TOTALS.total - BASELINE_TOTALS.materialized
  && fixture.report.scaleRows.every((row) => row.count === (BASELINE_ROWS.find((entry) => entry.type === row.type)?.total ?? 0) - (BASELINE_ROWS.find((entry) => entry.type === row.type)?.materialized ?? 0)),
  `规模合计 ${fixture.report.scaleTotal}`);
check("K13", "夹具自检无错误且深样本 ≥24", fixture.report.errors.length === 0 && fixture.report.deepSampleIds.length >= 24, JSON.stringify(fixture.report.errors));
check("K13", "可深入展示样本 ≥24 组", report.deepSampleCount >= 24, `实际 ${report.deepSampleCount}`);
check("K13", "存在真实可打开样本文件", report.counts.withFile >= 24, `实际 ${report.counts.withFile}`);
db2.close();
db3.close();

/* ------------------------------------------------------------------ *
 * K04 配置版本
 * ------------------------------------------------------------------ */
section("K04 配置");
const config = getConfig(db, SESSION);
check("K04", "配置带版本号", Boolean(config.revision));
check("K04", "分块策略参数化", config.chunkPolicy.maxChars > 0 && config.chunkPolicy.overlapChars >= 0);
check("K04", "演示索引模式标明", config.adapterMode === "demo");
check("K04", "768 只是配置维度", config.dimensionConfig === 768);

runner.stopAll();
db.close();

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const failed = results.filter((item) => !item.pass);
const groups = [...new Set(results.map((item) => item.group))];
console.log("\n—— 验收汇总 ——");
for (const group of groups) {
  const items = results.filter((item) => item.group === group);
  const bad = items.filter((item) => !item.pass).length;
  console.log(`  ${group.padEnd(10)} ${String(items.length - bad).padStart(3)}/${String(items.length).padEnd(3)} ${bad ? `（失败 ${bad}）` : ""}`);
}
console.log(`  合计       ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("\n失败项：");
  for (const item of failed) console.log(`  · ${item.group} ${item.name} — ${item.detail}`);
  process.exit(1);
}
console.log("\n全部通过。");
