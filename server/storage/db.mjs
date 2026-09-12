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

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots (session_id, created_at);
`;

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
