/**
 * 数据与知识中心 · 前端领域类型
 *
 * 这一份与 `server/domains/knowledge-contract.mjs` 及
 * `server/services/knowledge-*.mjs` 的返回结构逐字对应，是页面**唯一**的
 * 类型来源。页面里不允许再写 `as any` 或者别的形状的临时对象。
 *
 * 依据：PRD §12.4（接口表）、§5.3–§5.5（各页签字段）、§7.2（指标定义）、
 *      §9.1（三套状态）。
 */

/* ------------------------------------------------------------------ *
 * 通用
 * ------------------------------------------------------------------ */

/**
 * 资产主类（与服务端 ASSET_TYPES 逐字对应）。
 *
 * 前六类是 PRD §4.2 的原始口径；后六类是平台实际在收集、评审稿尚未单列的数据形态：
 * 扫描仪原始数据、高斯泼溅场景、建模与建图产物、点云、模型权重、音频记录。
 * 它们必须是独立主类：纳不纳入索引的判定、统计口径（点数 / 时长 / 参数量）都不同。
 */
export type AssetTypeKey =
  | "document"
  | "image"
  | "video"
  | "scanData"
  | "gaussian"
  | "modelFile"
  | "pointCloud"
  | "modelWeight"
  | "audio"
  | "workOrder"
  | "logBatch"
  | "record";

/** 资产可用性（PRD §9.1 第一张表） */
export type AssetAvailability = "可用" | "待补充内容" | "文件缺失" | "已删除";

/** 单资产索引状态（PRD §9.1 第二张表） */
export type AssetIndexState = "未纳入" | "待更新" | "处理中" | "已覆盖" | "更新失败";

/** 构建任务状态（PRD §9.1 第三张表） */
export type JobStatus = "排队" | "运行" | "成功" | "部分成功" | "失败" | "已取消";

/** 来源定位（PRD §4.3）：不同类型的资产给出不同的定位形态 */
export type Locator =
  | { kind: "page"; page: number; paragraph?: number; region?: string | null }
  | { kind: "section"; section: string; paragraph: number }
  | { kind: "sheet"; sheet: string; range: string }
  | { kind: "image"; imageId: string; region?: string | null }
  | { kind: "timecode"; start: string; end: string; keyframe?: string }
  | { kind: "workorder"; orderNo: string; node: string }
  | { kind: "log"; deviceId: string; from: string; to: string; line: number }
  | { kind: "record"; entityId: string; revision: number };

/* ------------------------------------------------------------------ *
 * 资产
 * ------------------------------------------------------------------ */

export type KnowledgeAsset = {
  id: string;
  projectId: string;
  type: AssetTypeKey;
  title: string;
  /** 原始文件名（含扩展名）。演示夹具按各类型的真实命名习惯生成，中英混排 */
  filename: string | null;
  /** 是否有可展开的明细记录；规模样本（false）只参与统计，点不开详情 */
  materialized: boolean;
  format: string;
  businessCategories: string[];
  sourceSystem: string;
  sourceEntityId: string;
  mainSource: string;
  contentRevision: number;
  metadataRevision: number;
  revision: number;
  availability: AssetAvailability;
  indexState: AssetIndexState;
  excludedReason: string | null;
  sizeBytes: number;
  objectIds: string[];
  primaryObjectId: string | null;
  buildingId: string | null;
  zone: string | null;
  capturedAt: string | null;
  importedAt: string | null;
  updatedAt: string;
  owner: string | null;
  summary: string;
  textMode: string;
  sha256: string | null;
  fileId: string | null;
  deletedAt: string | null;
  /** 当前服务版本里该资产的成员来源版本；与 contentRevision 不一致即「来源版本存在更新」 */
  indexedRevision: number | null;
  indexedVersion: string | null;
  chunkCount: number;
  extra: Record<string, unknown>;
};

export type AssetPage = {
  items: KnowledgeAsset[];
  /** 筛选范围内的全部资产（含规模样本） */
  total: number;
  /** 其中有明细记录、能在列表里点开的条数 */
  materialized: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type AssetFilters = {
  type?: AssetTypeKey | null;
  query?: string;
  objectId?: string | null;
  source?: string | null;
  category?: string | null;
  indexState?: AssetIndexState | null;
  availability?: AssetAvailability | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  limit?: number;
  cursor?: string | null;
};

export type Chunk = {
  id: string;
  assetId: string;
  assetRevision: number;
  ordinal: number;
  text: string;
  charCount: number;
  locator: Locator | null;
  chunkConfigRevision: string;
  digest: string;
  indexVersion: string | null;
  vectorId: string | null;
  vectorState: string | null;
  adapterMode: string | null;
  dimensionConfig: number | null;
};

export type AssetRevisionRow = {
  revision: number;
  fileId: string | null;
  contentHash: string | null;
  textRef: string | null;
  contentMode: string;
  kind: string;
  label: string;
  createdBy: string | null;
  createdAt: string;
};

export type AssetRelationRow = {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
  evidenceRef: string;
  origin: string;
  title: string;
};

export type AssetDetail = {
  asset: KnowledgeAsset;
  content: {
    id: string;
    revision: number;
    mode: string;
    locatorKind: string;
    extractionMode: string;
    chars: number;
    preview: string;
    text: string;
  } | null;
  chunks: Chunk[];
  revisions: AssetRevisionRow[];
  relations: AssetRelationRow[];
  jobItems: {
    jobId: string;
    jobStatus: JobStatus;
    stage: string;
    status: string;
    errorCode: string | null;
    message: string;
    updatedAt: string;
  }[];
  index: {
    servingVersion: string | null;
    indexedRevision: number | null;
    currentRevision: number;
    staleSource: boolean;
    note: string | null;
    chunkCount: number;
    vectorCount: number;
    configRevision: string | null;
    dimensionConfig: number | null;
    adapterMode: string | null;
  };
  file: { fileId: string | null; provided: boolean; note?: string };
};

/* ------------------------------------------------------------------ *
 * 指标与总览
 * ------------------------------------------------------------------ */

export type Metrics = {
  /** 平台总量 = materialized + scale */
  total: number;
  /** 有明细记录（有文件名、版本、分块）的条数 */
  materialized: number;
  /** 规模样本：只参与统计、不提供逐条明细的历史归档 */
  scale: number;
  included: number;
  covered: number;
  excluded: number;
  pending: number;
  error: number;
  /** 分母为 0 时为 null，界面显示「—」而不是 100% */
  coveragePct: number | null;
  chunks: number;
  vectors: number;
  processing?: number;
  longestWaitSeconds: number | null;
  rawBytes: number;
  lastPublishedAt: string | null;
  assetsInServingIndex?: number;
};

export type CoverageRow = {
  type: AssetTypeKey;
  label: string;
  /** 规模（含不可展开的历史归档） */
  total: number;
  /** 其中不可展开的条数 */
  scale: number;
  scaleNote: string | null;
  /** 有明细、可展开的条数 */
  materialized: number;
  covered: number;
  pending: number;
  error: number;
  excluded: number;
  processing: number;
  included: number;
  chunks: number;
};

export type RagStatus = {
  service: "可检索" | "未就绪" | "不可用";
  update: "已同步" | "待更新" | "更新中" | "有更新异常" | "已暂停" | "连接中断";
  tone: "ok" | "warn" | "info" | "danger";
  note?: string;
  autoSync: boolean;
  pending: number;
  processing: number;
  error: number;
  servingVersion: string | null;
  lastPublishedAt: string | null;
  effective: { assets: number; chunks: number; vectors: number };
  buildCounts: Record<string, number> | null;
};

export type IndexVersionRow = {
  id: string;
  scopeId: string;
  configRevision: string;
  parentVersion: string | null;
  supersededBy: string | null;
  publishedAt: string;
  buildCounts: { assets?: number; chunks?: number; vectors?: number; added?: number; changed?: number; removed?: number };
  effectiveCounts: { assets: number; chunks: number; vectors: number };
  operator: string | null;
  note: string;
  serving: boolean;
};

export type IndexConfig = {
  id: string;
  revision: string;
  inclusionRules: Record<string, unknown>;
  chunkPolicy: { maxChars: number; overlapChars: number; strategy: string };
  aggregateWindow: { deviceLogWindowSeconds: number; deviceLogGroupBy: string };
  autoSync: boolean;
  adapterMode: string;
  dimensionConfig: number;
  search: {
    minScoreLow: number;
    minScoreMedium: number;
    topKDefault: number;
    ngramMin: number;
    ngramMax: number;
    synonymRevision: string;
  };
  createdBy: string | null;
  createdAt: string;
};

export type JobCounts = { total: number; succeeded: number; failed: number; skipped: number; chunks: number; replacedChunks?: number };

export type JobStage = {
  key: string;
  label: string;
  status: string;
  processed: number;
  total: number;
  detail: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type KnowledgeJob = {
  id: string;
  scopeId: string;
  kind: string;
  triggerSource: string;
  targetVersion: string;
  baseVersion: string | null;
  status: JobStatus;
  stage: string;
  counts: JobCounts;
  stages: JobStage[];
  message: string;
  actorId: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type JobItem = {
  assetId: string;
  targetRevision: number;
  stage: string;
  status: string;
  errorCode: string | null;
  message: string;
  updatedAt: string;
};

export type JobDetail = { job: KnowledgeJob; items: JobItem[] };

export type Overview = {
  scope: { id: string; label: string };
  servingVersion: string | null;
  configRevision: string;
  adapterMode: string;
  dimensionConfig: number;
  metrics: Metrics;
  coverage: CoverageRow[];
  indexStatus: RagStatus;
  availability: { key: string; n: number }[];
  sources: { key: string; n: number }[];
  recentAssets: KnowledgeAsset[];
  recentJobs: KnowledgeJob[];
  runningJobs: KnowledgeJob[];
  versions: IndexVersionRow[];
  limits: Record<string, number>;
  searchConfig: IndexConfig["search"];
  snapshotSeq: number;
  serverTime: string;
};

/* ------------------------------------------------------------------ *
 * 关系图（PRD §8）
 * ------------------------------------------------------------------ */

export type GraphNode = {
  id: string;
  label: string;
  kind: "building" | "component" | "device" | "workOrder" | "inspection" | "asset" | "assetVersion" | "content" | "chunkGroup" | "indexVersion" | "object";
  category: string;
  degree?: number;
  count?: number;
  detail?: string;
  state?: AssetIndexState;
  assetType?: AssetTypeKey;
  assetId?: string;
  layer?: string;
  x?: number;
  y?: number;
  range?: [number, number];
  focus?: boolean;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  evidenceRef: string;
  origin: string;
};

export type GraphView = "business" | "lineage";

export type RelationGraphData = {
  view: GraphView;
  relationTypes: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: number;
  scopeCounts: { assets: number; relations: number };
  truncated: { nodes: boolean; edges: boolean };
  focusId: string | null;
  servingVersion?: string | null;
};

/* ------------------------------------------------------------------ *
 * 检索（PRD §5.5 / §11.3）
 * ------------------------------------------------------------------ */

export type SearchHit = {
  chunkId: string;
  assetId: string;
  assetRevision: number;
  currentRevision: number;
  title: string;
  assetType: AssetTypeKey;
  assetTypeLabel: string;
  objectIds: string[];
  primaryObjectId: string | null;
  /** 旧版继续服务时的提示：「来源版本 v1，存在更新」 */
  versionNote: string | null;
  snippet: string;
  locator: Locator | null;
  locatorText: string;
  score: number;
  low: boolean;
  matchedObjects: string[];
  digest: string | null;
  charCount: number;
};

export type SearchResult = {
  query: string;
  interpreted: {
    objectIds: string[];
    months: { key: string; label: string; year: string }[];
    years: string[];
    timeRange: { from: string; to: string; label: string } | null;
  };
  threshold: number;
  topK: number;
  version: string | null;
  servingVersion: string | null;
  adapterMode: string;
  configRevision: string | null;
  hits: SearchHit[];
  lowCandidates: SearchHit[];
  elapsedMs: number;
  corpusBuiltMs: number;
  totalQualified: number;
  snapshotSeq: number;
  serverTime: string;
};

/* ------------------------------------------------------------------ *
 * 写操作
 * ------------------------------------------------------------------ */

export type KnowledgeCommand =
  | "asset.register"
  | "asset.revise"
  | "asset.updateMetadata"
  | "asset.setInclusion"
  | "asset.delete"
  | "knowledge.sync"
  | "knowledge.retry"
  | "knowledge.cancel"
  | "knowledge.activateVersion"
  | "knowledge.configure";

/**
 * 夹具报告（GET /api/knowledge/fixture）。
 *
 * 形状与服务端 `fixtureReport()` 的返回逐字对应。规模样本与可展开明细分开报：
 * 前者是平台里的历史归档计数，后者才是有文件名与分块的记录。
 */
export type FixtureReport = {
  scenarioId: string;
  seed: number;
  installedAt: string;
  counts: {
    assets: number;
    withFile: number;
    chunks: number;
    vectors: number;
    relations: number;
    contents: number;
    byType: { type: AssetTypeKey; count: number }[];
  };
  /** 可展开明细的 id 列表（带完整正文与可打开文件的那一批） */
  deepSampleIds: string[];
  deepSampleCount: number;
  /** 没有随演示包提供原始附件的条数 */
  missingAttachment: number;
  errors: string[];
};

/** 页签（PRD §5.1）：四个页签可独立访问、筛选可恢复 */
export type KnowledgeTab = "overview" | "assets" | "indexes" | "search";
