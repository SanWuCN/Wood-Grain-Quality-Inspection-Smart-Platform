/**
 * 数据与知识中心 · 领域契约（服务端与验收脚本共用的唯一事实来源）
 *
 * 依据：PRD-数据与知识中心-v1.0.md §4（两层数据）、§7（量化指标与演示基线）、
 *      §9（状态与更新规则）、§11（演示实现边界）、§12.3（领域模型）。
 *
 * 这个文件只放**常量与纯函数**，不放 React、不放数据库句柄：
 *   · 服务端夹具生成器按它造数据；
 *   · 指标计算按它判口径；
 *   · tools/test-knowledge.mjs 按它做验收断言。
 *
 * 硬规则（PRD §7.1 译文）：
 *   1. 表里的数字是**夹具的验收约束**，不是写进卡片的常量。所有显示值必须
 *      从落库记录复算，测试会真的去数。
 *   2. 逻辑向量条目（一块一条）不是物理 768 维数组：768 只是 dimensionConfig。
 *   3. 「当前版覆盖资产」与「有可用索引资产」是两个口径：基线下都是 900，
 *      运行后替换资料才会分开（旧版仍可检索、当前版待更新）。
 */

/** 基线场景 ID（PRD §7.1） */
export const DEMO_SCENARIO_ID = "knowledge-demo-v1";

/** 演示索引适配器（PRD §11.3）：一块一条的逻辑记录 */
export const ADAPTER_MODE = "demo";
export const DIMENSION_CONFIG = 768;

/** 检索配置默认值（PRD §11.3：阈值、Top K、同义词规则版本化） */
export const SEARCH_CONFIG_DEFAULT = {
  minScoreLow: 0.15,
  minScoreMedium: 0.45,
  topKDefault: 10,
  ngramMin: 2,
  ngramMax: 4,
  synonymRevision: "SYN-demo-01",
};

/** 文件与内容处理限额（PRD §12.6） */
export const LIMITS = {
  maxFilesPerBatch: 50,
  maxFileBytes: 100 * 1024 * 1024,
  maxBatchBytes: 500 * 1024 * 1024,
  maxParseBytes: 5 * 1024 * 1024,
  autoSyncQuietWindowMs: 2000,
  autoSyncMaxWaitMs: 10000,
  autoSyncBatchSize: 50,
};

/**
 * 资产主类（PRD §4.2「资产类型」：六个互斥主类，用于数量统计）。
 *
 * 前六类与 PRD 一致。后四类是平台实际在收集、而 PRD 评审稿尚未单列的数据形态：
 * 扫描仪原始数据、高斯泼溅（.sog/.ply）、建模与建图产物、模型权重与音频。
 * 它们**必须**是独立的互斥主类，不能塞进「文档」或「业务记录」：
 *   · 纳不纳入索引的判定不同（二进制扫描数据/权重没有可检索文本）；
 *   · 统计口径不同（点云按点数、视频与音频按时长、权重按参数量）；
 *   · 页面上要看的是「哪些设备产出了什么」，和「文档写了什么」是两件事。
 */
export const ASSET_TYPES = [
  { key: "document", label: "文档报告", short: "文档" },
  { key: "image", label: "现场照片", short: "照片" },
  { key: "video", label: "巡检视频", short: "视频" },
  { key: "scanData", label: "扫描数据", short: "扫描" },
  { key: "gaussian", label: "高斯场景", short: "高斯" },
  { key: "modelFile", label: "建模与建图", short: "建模" },
  { key: "pointCloud", label: "点云数据", short: "点云" },
  { key: "modelWeight", label: "模型权重", short: "权重" },
  { key: "audio", label: "音频记录", short: "音频" },
  { key: "workOrder", label: "历史工单", short: "工单" },
  { key: "logBatch", label: "日志批次", short: "日志" },
  { key: "record", label: "业务记录", short: "记录" },
];

export const ASSET_TYPE_KEYS = ASSET_TYPES.map((item) => item.key);

export function assetTypeLabel(key) {
  return ASSET_TYPES.find((item) => item.key === key)?.label ?? key;
}

/**
 * 业务分类（可多标签，PRD §4.2「业务分类」）。
 *
 * 除「巡检报告 / 构件档案 / 维修记录 / 设备运行 / 规范方法 / 历史归档」这六个
 * PRD 原列的口径外，另有三类工程技术资料：修缮工艺、政策法规、保护规划。
 * 它们是古建巡检现场真实会查的东西（做法、依据、边界），
 * 有了这三类，「检索验证」才回答得了「这类病害按什么工艺修、依据哪条要求」。
 */
export const BUSINESS_CATEGORIES = [
  "巡检报告",
  "构件档案",
  "维修记录",
  "设备运行",
  "规范方法",
  "历史归档",
  "修缮工艺",
  "政策法规",
  "保护规划",
];

/** 数据来源（单一主来源，PRD §4.2「数据来源」） */
export const DATA_SOURCES = ["人工导入", "平台业务", "巡检设备", "历史归档"];
/** 资产可用性状态（PRD §9.1 第一张表） */
export const ASSET_AVAILABILITY = ["可用", "待补充内容", "文件缺失", "已删除"];

/** 单资产索引状态（PRD §9.1 第二张表） */
export const ASSET_INDEX_STATES = ["未纳入", "待更新", "处理中", "已覆盖", "更新失败"];

/** 构建任务状态（PRD §9.1 第三张表） */
export const JOB_STATES = ["排队", "运行", "成功", "部分成功", "失败", "已取消"];

/** 六个流水线阶段（PRD §9.3） */
export const PIPELINE_STAGES = ["检测变更", "提取内容", "分块", "构建索引", "一致性校验", "发布"];

/** 错误码（PRD §12.4） */
export const ERROR_CODES = [
  "UNSUPPORTED_CONTENT",
  "CONTENT_REQUIRED",
  "FILE_TOO_LARGE",
  "FILE_MISSING",
  "VERSION_CONFLICT",
  "INDEX_NOT_READY",
  "FORBIDDEN",
  "INVALID_LOCATOR",
  "TASK_CANCELLED",
];

/**
 * 各主类的规模与基线数量。
 *
 * 这一节要同时满足两件互相拉扯的事，所以口径必须写清楚：
 *
 * **一、规模要像真的。** 现场照片五万余张、巡检视频一万余条、文档八千余份、
 * 扫描与点云数据数万份 —— 这是古建巡检干几年之后的真实量级。演示库不会把
 * 七万条记录逐条生成：那既没必要（没人会翻到第 40,000 条），首次启动也会慢到不可用。
 *
 * **二、能点开的必须真有。** 所以每个主类分两层：
 *   · `total`        —— 平台里的总量，参与所有指标统计；
 *   · `materialized` —— **生成的明细记录**：有文件名、有版本、有来源、有分块，
 *                       可以筛选、可以打开详情、参与检索。
 * 不可展开的那部分只贡献计数，界面必须**明说**它是采样：
 * 「共 54,160 项 · 其中 240 项可展开明细」。把七万条虚数画成一页列表才是不诚实的做法。
 *
 * `included / covered / pending / error / chunkCount` 都只针对 `materialized`
 * 这一层 —— 只有它们**真的**有分块与索引成员记录，指标必须能从落库记录复算。
 *
 * 逐行等式（测试逐条断言）：
 *   total ≥ materialized
 *   materialized = included + excluded
 *   included     = covered + pending + error
 *   chunkCount   = ratio × included（生成器给每个纳入资产恰好 ratio 个块）
 */
export const BASELINE_ROWS = [
  // 文档报告：巡检报告、构件档案、检测数据表、修缮工艺、政策法规、保护规划、规范方法、历史修缮档案
  { type: "document", label: "文档报告", total: 8210, materialized: 300, included: 300, covered: 274, pending: 20, error: 6, excluded: 0, chunkCount: 11400, ratio: 38 },
  // 现场照片：每份 2 块（人工描述 / 审核标注），纳不纳入取决于有没有文本
  { type: "image", label: "现场照片", total: 54160, materialized: 240, included: 120, covered: 112, pending: 4, error: 4, excluded: 120, chunkCount: 240, ratio: 2 },
  { type: "video", label: "巡检视频", total: 10420, materialized: 120, included: 48, covered: 40, pending: 4, error: 4, excluded: 72, chunkCount: 384, ratio: 8 },
  // 扫描仪原始数据：结构化二进制，本期只登记、不进索引（没有可检索文本）
  { type: "scanData", label: "扫描数据", total: 24300, materialized: 120, included: 0, covered: 0, pending: 0, error: 0, excluded: 120, chunkCount: 0, ratio: 0 },
  // 高斯泼溅场景：.sog 是训练产物，来源可追溯，但不做文本检索
  { type: "gaussian", label: "高斯场景", total: 3860, materialized: 60, included: 0, covered: 0, pending: 0, error: 0, excluded: 60, chunkCount: 0, ratio: 0 },
  { type: "modelFile", label: "建模与建图", total: 6450, materialized: 96, included: 60, covered: 54, pending: 4, error: 2, excluded: 36, chunkCount: 180, ratio: 3 },
  { type: "pointCloud", label: "点云数据", total: 18740, materialized: 96, included: 0, covered: 0, pending: 0, error: 0, excluded: 96, chunkCount: 0, ratio: 0 },
  { type: "modelWeight", label: "模型权重", total: 2310, materialized: 60, included: 0, covered: 0, pending: 0, error: 0, excluded: 60, chunkCount: 0, ratio: 0 },
  // 音频：带转写片段的才纳入索引
  { type: "audio", label: "音频记录", total: 15920, materialized: 90, included: 48, covered: 42, pending: 2, error: 4, excluded: 42, chunkCount: 192, ratio: 4 },
  { type: "workOrder", label: "历史工单", total: 4820, materialized: 162, included: 162, covered: 154, pending: 4, error: 4, excluded: 0, chunkCount: 1944, ratio: 12 },
  { type: "logBatch", label: "日志批次", total: 12680, materialized: 96, included: 72, covered: 66, pending: 6, error: 0, excluded: 24, chunkCount: 3600, ratio: 50 },
  { type: "record", label: "业务记录", total: 5240, materialized: 60, included: 60, covered: 60, pending: 0, error: 0, excluded: 0, chunkCount: 60, ratio: 1 },
];

/**
 * 文档格式拆分（按 materialized 的 300 份）：PDF 170 / DOCX 60 / XLSX 70。
 * 工法、法规、规划用 PDF / DOCX，检测数据表与台账才是 XLSX。
 */
export const DOCUMENT_FORMAT_SPLIT = [
  { format: "PDF", count: 170 },
  { format: "DOCX", count: 60 },
  { format: "XLSX", count: 70 },
];

/** 基线合计（由 BASELINE_ROWS 推导，改行不改这里，避免两个地方各写一份） */
export const BASELINE_TOTALS = {
  total: BASELINE_ROWS.reduce((sum, row) => sum + row.total, 0),
  materialized: BASELINE_ROWS.reduce((sum, row) => sum + row.materialized, 0),
  included: BASELINE_ROWS.reduce((sum, row) => sum + row.included, 0),
  covered: BASELINE_ROWS.reduce((sum, row) => sum + row.covered, 0),
  pending: BASELINE_ROWS.reduce((sum, row) => sum + row.pending, 0),
  error: BASELINE_ROWS.reduce((sum, row) => sum + row.error, 0),
  excluded: BASELINE_ROWS.reduce((sum, row) => sum + row.excluded, 0),
  chunks: BASELINE_ROWS.reduce((sum, row) => sum + row.chunkCount, 0),
  vectors: BASELINE_ROWS.reduce((sum, row) => sum + row.chunkCount, 0),
};

/** 基线服务版本（PRD §7.1）：构建任务空闲，更新方式为自动 */
export const BASELINE_SERVING_VERSION = "KB-021";
export const BASELINE_PUBLISHED_AT = "2026-09-13T01:20:00.000Z"; // 09-13 09:20 Asia/Shanghai
export const BASELINE_CONFIG_REVISION = "CFG-KB-003";

/**
 * 基线历史版本记录（PRD §5.4「版本记录」）。
 *
 * KB-021 是当前服务版本，它的 buildCounts 必须与同一份基线里的 BASELINE_ROWS 合计
 * **逐项**对得上（测试会核对）：当前版本说 18,000 块、这里写 18,420，
 * 就会让「构建统计」与「有效数量」在同一张卡片上互相矛盾。
 *
 * `assets` 取 **870（纳入资产数）而不是 1,500（明细总数）**：构建统计说的是
 * 「本次构建处理了多少个资产」——扫描数据、高斯场景、点云、模型权重这四类
 * 二进制产物只有元数据、没有可提取文本，它们不进入构建。用 1,500 会让
 * 「构建处理 1,500 项」与「纳入了多少」这两件事被混在一起。
 *
 * 之前两版保留它们各自的原始构建计数 —— 历史版本不因后来的重建或删除而改写。
 * 注意 KB-019 / KB-020 是这条版本线自己的历史，与 KB-021 之间不必保持
 * 逐项递推（它们是演示时间线上的三次发布，中间还有未被本次基线覆盖的资料变更）。
 */
export const BASELINE_VERSIONS = [
  {
    id: "KB-019",
    publishedAt: "2026-08-26T02:05:00.000Z",
    scopeId: "project-example-temple",
    configRevision: "CFG-KB-002",
    parentVersion: null,
    operator: "shi",
    buildCounts: { assets: 1180, chunks: 17204, vectors: 17204, added: 1180, changed: 0, removed: 0 },
    note: "首次全量构建 · 演示夹具初始化",
  },
  {
    id: "KB-020",
    publishedAt: "2026-09-05T01:40:00.000Z",
    scopeId: "project-example-temple",
    configRevision: "CFG-KB-003",
    parentVersion: "KB-019",
    operator: "shi",
    buildCounts: { assets: 1236, chunks: 18112, vectors: 18112, added: 68, changed: 42, removed: 12 },
    note: "九月巡检资料归档后增量更新",
  },
  {
    id: "KB-021",
    publishedAt: BASELINE_PUBLISHED_AT,
    scopeId: "project-example-temple",
    configRevision: "CFG-KB-003",
    parentVersion: "KB-020",
    operator: "shi",
    buildCounts: { assets: BASELINE_TOTALS.included, chunks: BASELINE_TOTALS.chunks, vectors: BASELINE_TOTALS.vectors, added: 46, changed: 18, removed: 0 },
    note: "柱脚复核资料发布 · 当前服务版本",
  },
];

/** 基线配置版本（PRD §5.4 配置抽屉：参数调整必须产生配置版本） */
export const BASELINE_CONFIG = {
  id: BASELINE_CONFIG_REVISION,
  inclusionRules: {
    document: { maxBytes: 100 * 1024 * 1024, formats: ["PDF", "DOCX", "XLSX"] },
    image: { requireText: true, note: "无人工描述 / 审核标注的图片不纳入索引" },
    video: { requireTranscript: true, note: "无预置转写片段的视频不纳入索引" },
    workOrder: { states: ["已关闭", "已复核"] },
    logBatch: { minLevel: "warn", note: "原始调试日志不纳入，保留为资产" },
    record: { templates: ["采样", "检测", "校准", "发布"] },
  },
  chunkPolicy: { maxChars: 420, overlapChars: 60, strategy: "段落聚合" },
  aggregateWindow: { deviceLogWindowSeconds: 60, deviceLogGroupBy: "device+session" },
  autoSync: true,
  adapterMode: ADAPTER_MODE,
  dimensionConfig: DIMENSION_CONFIG,
  search: SEARCH_CONFIG_DEFAULT,
};

/**
 * 范围（PRD §7.3）：顶部项目筛选作用于六项指标、资产卡、图谱与任务列表。
 * 项目 ID 与平台其它模块一致，名称变更不破坏关系（PRD §4.2）。
 */
export const DEFAULT_SCOPE = {
  id: "project-example-temple",
  label: "示例寺",
  buildingIds: ["B-DXBD", "B-TSW", "B-ZX"],
};

/**
 * 指标口径（PRD §7.2）。纯函数，测试与页面共用同一段逻辑。
 *
 * 两层数据的公式（与 BASELINE_ROWS 的注释对应）：
 *   total        = materialized + scale        （平台总量）
 *   materialized = included + excluded         （有明细记录、能点开的那一层）
 *   included     = covered + pending + error
 *   coveragePct  = covered / included          （分母为 0 时 null，显示「—」）
 *
 * **覆盖率的分母是 included 而不是 total**：规模样本没有分块记录，
 * 把它们算进分母会得到一个永远上不去、也无法解释的百分比。
 * 所以界面必须同时给出 total 与 materialized，读者才知道 100% 是对谁说的。
 */
export function computeMetrics(rows) {
  const sum = (key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const included = sum("included");
  const covered = sum("covered");
  const materialized = sum("materialized");
  /*
    scale（规模样本）在两种入参下都能算出来：
      · 契约行（BASELINE_ROWS）只给 total 与 materialized，差额即规模；
      · 查询层已经查过 knowledge_scale，带上 scale 字段，此时以它为准 ——
        这样即使 total 尚未回填，指标也不会凭空多出一截。
  */
  const scale = rows.some((row) => typeof row.scale === "number")
    ? sum("scale")
    : Math.max(0, sum("total") - materialized);
  return {
    total: materialized + scale,
    materialized,
    scale,
    included,
    covered,
    excluded: sum("excluded"),
    pending: sum("pending"),
    error: sum("error"),
    // 无纳入资产时覆盖率显示「—」，不能显示误导性的 100%（PRD §7.2）
    coveragePct: included > 0 ? Number(((covered / included) * 100).toFixed(1)) : null,
    chunks: sum("chunkCount"),
    vectors: sum("chunkCount"),
  };
}

/** RAG 总状态：检索服务 + 更新状态（PRD §9.1） */
export function deriveRagStatus({ servingVersion, pending, error, runningJobs, autoSync, reachable = true }) {
  if (!reachable) return { service: "不可用", update: "连接中断", tone: "danger" };
  const service = servingVersion ? "可检索" : "未就绪";
  let update = "已同步";
  if (!autoSync) update = "已暂停";
  else if (runningJobs > 0) update = "更新中";
  else if (error > 0) update = "有更新异常";
  else if (pending > 0) update = "待更新";
  // 同时更新中和有失败项时主标签显示「更新中」，异常计数仍可见（PRD §9.1）
  if (update === "更新中" && error > 0) return { service, update, tone: "info", note: `异常 ${error} 项` };
  return { service, update, tone: service === "可检索" ? (update === "已同步" ? "ok" : "warn") : "danger" };
}

/** 定位联合类型（PRD §4.3）：不同资产给出不同的来源定位 */
export function describeLocator(locator) {
  if (!locator) return "无来源定位";
  switch (locator.kind) {
    case "page":
      return `第 ${locator.page} 页 · ${locator.paragraph ? `第 ${locator.paragraph} 段` : locator.region ?? "整页"}`;
    case "section":
      return `${locator.section ?? "正文"} · 第 ${locator.paragraph} 段`;
    case "sheet":
      return `${locator.sheet} · ${locator.range}`;
    case "image":
      return `${locator.imageId}${locator.region ? ` · ${locator.region}` : ""}`;
    case "timecode":
      return `${locator.start}–${locator.end}${locator.keyframe ? ` · ${locator.keyframe}` : ""}`;
    case "workorder":
      return `${locator.orderNo} · ${locator.node}`;
    case "log":
      return `${locator.deviceId} · ${locator.from}–${locator.to} · 第 ${locator.line} 行`;
    case "record":
      return `${locator.entityId} · revision ${locator.revision}`;
    default:
      return locator.text ?? "自定义定位";
  }
}
