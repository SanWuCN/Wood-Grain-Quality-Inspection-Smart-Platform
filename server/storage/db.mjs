/**
 * 共享服务 · 存储层（SQLite）
 *
 * 用 Node 24 自带的 `node:sqlite`，不引第三方驱动 —— 演示要在断网的内网机器上
 * 单进程跑起来，少一个原生依赖就少一类装不上的风险。
 *
 * 表结构围绕 PRD §6「数据模型与版本规则」：
 *   - 所有业务记录带 revision，发布后不可原地改，改了就是新版本
 *   - 事件流带 seq，客户端按 seq 顺序消费，重连带 lastSeq
 *   - commandId 落库做幂等：重复提交返回同一结果，不会推两遍事件
 *   - 文件存**真实字节**（落在 server/assets），库里只存路径与流式摘要
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 建表语句：全部 IF NOT EXISTS，启动时可以反复执行 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 演示会话：四台电脑加入同一个 demoSessionId（PRD §5.3）
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 共享实体：按 kind + id 存 JSON，revision 每次写 +1
-- kind 取值见 server/services/kinds.mjs，与前端 store 一一对应
CREATE TABLE IF NOT EXISTS entities (
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, id)
);

-- 事件流：客户端按 seq 消费；重连时带 lastSeq 补缺口
CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  entity_kind TEXT,
  entity_id   TEXT,
  revision    INTEGER,
  actor_id    TEXT,
  payload     TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- 命令幂等表：同一 commandId 重放返回第一次的结果
CREATE TABLE IF NOT EXISTS commands (
  session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  result     TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (session_id, command_id)
);

-- 文件资产：真实字节，摘要由服务端流式读取计算（PRD §10.3）
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL
);

-- 投屏持有人与当前视图（PRD §7：同一时刻只有一个持有人，别人抢不走画面）
CREATE TABLE IF NOT EXISTS projection (
  session_id TEXT PRIMARY KEY,
  holder_id  TEXT,
  view_type  TEXT NOT NULL,
  focus_ids  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 阶段快照（PRD §11 排练恢复）：把某一刻的全部实体存下来，排练时能退回去
CREATE TABLE IF NOT EXISTS snapshots (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  stage      TEXT NOT NULL,
  label      TEXT NOT NULL,
  entity_seq INTEGER NOT NULL,
  data       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

/* ====================================================================
 * 数据与知识中心（PRD-数据与知识中心-v1.0 §12.3 领域模型）
 *
 * 为什么单开表而不是复用 entities 表：知识域是**万级行**（1,500 条明细资产 /
 * 18,000 分块 / 18,000 向量条目，另有 165,610 项只落计数与台账）。
 * entities 表的快照接口会把整场数据读成
 * 一个 JSON 交给四端，把知识域塞进去会让事件驱动的每次 refresh 都搬几兆
 * 字节。这里按用途分表，页面走 /api/knowledge 的分页与聚合查询。
 *
 * 所有表带 session_id：重置某一会话不会污染另一场演示（PRD §12.3）。
 * ==================================================================== */

-- 资产主表：一条记录 = 一个逻辑资产（多版本计一次）
CREATE TABLE IF NOT EXISTS knowledge_assets (
  id                 TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  type               TEXT NOT NULL,
  title              TEXT NOT NULL,
  -- 原始文件名（含扩展名）。演示里按各类型的真实命名习惯生成：
  -- 中文名、纯英文、编号+日期混排都有，不是清一色中文。
  filename           TEXT,
  -- 0/1：是否有**可展开的明细记录**。规模样本只贡献计数，见 knowledge_scale。
  materialized       INTEGER NOT NULL DEFAULT 1,
  format             TEXT NOT NULL,
  business_categories TEXT NOT NULL,
  source_system      TEXT NOT NULL,
  source_entity_id   TEXT NOT NULL,
  main_source        TEXT NOT NULL,
  content_revision   INTEGER NOT NULL,
  metadata_revision  INTEGER NOT NULL,
  availability       TEXT NOT NULL,
  index_state        TEXT NOT NULL,
  excluded_reason    TEXT,
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  object_ids         TEXT NOT NULL,
  primary_object_id  TEXT,
  building_id        TEXT,
  zone               TEXT,
  captured_at        TEXT,
  imported_at        TEXT,
  updated_at         TEXT NOT NULL,
  owner              TEXT,
  summary            TEXT NOT NULL DEFAULT '',
  text_mode          TEXT NOT NULL DEFAULT 'none',
  sha256             TEXT,
  file_id            TEXT,
  extra              TEXT NOT NULL DEFAULT '{}',
  deleted_at         TEXT,
  PRIMARY KEY (session_id, id)
);

-- 资产版本：内容不可原地覆盖，改了就是新 revision（PRD §12.3 / §10.2）
CREATE TABLE IF NOT EXISTS knowledge_asset_revisions (
  session_id   TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  file_id      TEXT,
  content_hash TEXT,
  text_ref     TEXT,
  content_mode TEXT NOT NULL,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, asset_id, revision)
);

-- 业务关系：每条边都有来源（PRD §8.4）
CREATE TABLE IF NOT EXISTS knowledge_relations (
  id            TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  evidence_ref  TEXT NOT NULL,
  origin        TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

-- 提取内容：绑定资产版本与原始文件摘要（PRD §12.3）
CREATE TABLE IF NOT EXISTS knowledge_contents (
  id             TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  text           TEXT NOT NULL,
  locator_kind   TEXT NOT NULL,
  extraction_mode TEXT NOT NULL DEFAULT 'fixture',
  PRIMARY KEY (session_id, id)
);

-- 分块：唯一键 = 资产版 + 分块配置 + 序号（PRD §12.3）
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                   TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  asset_id             TEXT NOT NULL,
  asset_revision       INTEGER NOT NULL,
  chunk_ordinal        INTEGER NOT NULL,
  text                 TEXT NOT NULL,
  char_count           INTEGER NOT NULL,
  locator              TEXT NOT NULL,
  chunk_config_revision TEXT NOT NULL,
  digest               TEXT NOT NULL,
  index_version        TEXT,
  deleted_at           TEXT,
  PRIMARY KEY (session_id, id)
);

-- 演示向量条目：一块一条，adapterMode=demo，dimensionConfig=768 只是配置值
CREATE TABLE IF NOT EXISTS knowledge_vectors (
  id               TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  chunk_id         TEXT NOT NULL,
  adapter_mode     TEXT NOT NULL,
  dimension_config INTEGER NOT NULL,
  config_revision  TEXT NOT NULL,
  state            TEXT NOT NULL,
  index_version    TEXT,
  PRIMARY KEY (session_id, id)
);

-- 索引版本：发布后不可变，记录构建当时统计
CREATE TABLE IF NOT EXISTS knowledge_index_versions (
  id                TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  scope_id          TEXT NOT NULL,
  config_revision   TEXT NOT NULL,
  parent_version    TEXT,
  published_at      TEXT NOT NULL,
  build_counts      TEXT NOT NULL,
  operator          TEXT,
  note              TEXT NOT NULL DEFAULT '',
  superseded_by     TEXT,
  supersedes_version TEXT,
  PRIMARY KEY (session_id, id)
);-- 索引成员：一个版本内成员唯一
CREATE TABLE IF NOT EXISTS knowledge_index_members (
  session_id     TEXT NOT NULL,
  index_version  TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  asset_revision INTEGER NOT NULL,
  chunk_id       TEXT NOT NULL,
  vector_id      TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT '有效',
  PRIMARY KEY (session_id, index_version, chunk_id)
);

-- 服务版本指针：原子比较并切换
CREATE TABLE IF NOT EXISTS knowledge_index_heads (
  session_id      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  serving_version TEXT,
  revision        INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, scope_id)
);

-- 构建任务：固定输入快照，不能由前端自行标记成功（PRD §12.3）
CREATE TABLE IF NOT EXISTS knowledge_jobs (
  id             TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  scope_id       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  target_version TEXT NOT NULL,
  base_version   TEXT,
  status         TEXT NOT NULL,
  stage          TEXT NOT NULL,
  counts         TEXT NOT NULL,
  stages         TEXT NOT NULL DEFAULT '[]',
  input_seq      INTEGER NOT NULL DEFAULT 0,
  message        TEXT NOT NULL DEFAULT '',
  actor_id       TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  PRIMARY KEY (session_id, id)
);

-- 任务明细：每项可重试、可恢复
CREATE TABLE IF NOT EXISTS knowledge_job_items (
  session_id      TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  stage           TEXT NOT NULL,
  status          TEXT NOT NULL,
  error_code      TEXT,
  message         TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, job_id, asset_id)
);

-- 配置版本：参数调整必须产生配置版本（PRD §5.4）
CREATE TABLE IF NOT EXISTS knowledge_configs (
  id              TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  revision        TEXT NOT NULL,
  inclusion_rules TEXT NOT NULL,
  chunk_policy    TEXT NOT NULL,
  aggregate_window TEXT NOT NULL,
  auto_sync       INTEGER NOT NULL,
  adapter_mode    TEXT NOT NULL,
  dimension_config INTEGER NOT NULL,
  search          TEXT NOT NULL,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);

-- 夹具种子记录：一个会话只播种一次，重置时整表删除后重建
CREATE TABLE IF NOT EXISTS knowledge_seeds (
  session_id   TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  report       TEXT NOT NULL,
  installed_at TEXT NOT NULL
);

-- 规模样本（不可展开的计数层）
--
-- 现场照片五万余张、点云两万余份，演示库不会逐条生成：没人会翻到第 40,000 条，
-- 逐条入库还会让首次启动慢到不可用。但「总量」又必须是可查询的事实而不是页面常量，
-- 所以把差额存在这里，指标与分布查询**同时读** knowledge_assets（明细）
-- 与这张表（规模），页面再明确区分两者（PRD §7、§11.2）。
--
-- availability / main_source 两列的必要性：总览的「可用性分布」与「来源分布」
-- 讲的是平台里**全部**资料，各状态相加必须等于指标里的 total。规模样本也是
-- 平台里真实登记过的资料，本身就有可用状态与来源；少了这两列，两张分布图
-- 只能数到明细层（1,500），与 167,110 的总量对不上 —— 分布图加起来不等于总数，
-- 比不画这张图更糟。它们的取值来自各主类的真实归档口径（见 knowledge-store 的
-- SCALE_AVAILABILITY / SCALE_SOURCES），不是随手填的默认值。
CREATE TABLE IF NOT EXISTS knowledge_scale (
  session_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  count        INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT '可用',
  main_source  TEXT NOT NULL DEFAULT '历史归档',
  PRIMARY KEY (session_id, type)
);

-- 范围（项目）：顶部项目筛选作用于指标、资产卡、图谱与任务列表（PRD §7.3）
CREATE TABLE IF NOT EXISTS knowledge_scopes (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  label      TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, id)
);

CREATE INDEX IF NOT EXISTS idx_kb_assets_type ON knowledge_assets (session_id, project_id, type, index_state);
CREATE INDEX IF NOT EXISTS idx_kb_assets_updated ON knowledge_assets (session_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_asset ON knowledge_chunks (session_id, asset_id, asset_revision, chunk_ordinal);
CREATE INDEX IF NOT EXISTS idx_kb_members_version ON knowledge_index_members (session_id, index_version, asset_id);
CREATE INDEX IF NOT EXISTS idx_kb_relations_from ON knowledge_relations (session_id, from_id);
CREATE INDEX IF NOT EXISTS idx_kb_relations_to ON knowledge_relations (session_id, to_id);
CREATE INDEX IF NOT EXISTS idx_kb_jobs_status ON knowledge_jobs (session_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots (session_id, created_at);
`;

/** 建表语句之后要补的列：已有库靠 ALTER TABLE 追上，新库建表时已经带上 */
const COLUMN_MIGRATIONS = [
  { table: "knowledge_assets", column: "filename", definition: "TEXT" },
  { table: "knowledge_assets", column: "materialized", definition: "INTEGER NOT NULL DEFAULT 1" },
  { table: "knowledge_scale", column: "availability", definition: "TEXT NOT NULL DEFAULT '可用'" },
  { table: "knowledge_scale", column: "main_source", definition: "TEXT NOT NULL DEFAULT '历史归档'" },
];

/**
 * 补列（幂等）。
 *
 * 为什么必须有：上面对知识域各表用的是 `CREATE TABLE IF NOT EXISTS` ——
 * 表已经存在时它**什么都不做**，新加的列不会自己出现。演示库是长期存在的文件
 * （server/data/mumai.db），列一改，旧库上的 INSERT 会直接报
 * 「table has no column named …」，而报错点离真正的原因很远。
 *
 * 所以建表之后统一比对一次 PRAGMA table_info，缺哪列补哪列。
 * 只加列、不改类型、不删列：ALTER TABLE ADD COLUMN 是 SQLite 上唯一
 * 不需要重建表结构的操作，对已有数据零风险。
 */
function migrateSchema(db) {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * 打开数据库。
 *
 * 传 ":memory:" 可以开一个纯内存库 —— 单元测试与预检都靠它，
 * 不会污染演示数据。
 */
export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/** 把一行 JSON 列解出来；解不开就当 null，不让脏数据把整次快照打崩 */
export function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** ISO 8601 + Asia/Shanghai（PRD §6：日期一律存 ISO 时间戳，显示时再本地化） */
export function nowIso() {
  return new Date().toISOString();
}
