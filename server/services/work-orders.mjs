/**
 * 木脉智检 · 工单指派与扫描仪下发（PRD-工单指派与扫描仪下发-v1.0）
 *
 * 这一层是**服务端权威**，回答四件事：
 *   1. 一张工单是怎么来的 —— 快捷键事件 → 小木转换 → 四根木柱 Z01—Z04（同一事务）；
 *   2. 谁能动它 —— 指派只有项目经理能改，其他人按**该单当前的指派版本**授权；
 *   3. 环境读数怎么变成可下发的配置版本 —— 空值判空、量程、气压单位、不可变版本；
 *   4. 下发出去的是什么 —— 工单 + 环境配置**一个不可变整包**，设备回执才算应用成功。
 *
 * 几条不能让步的规则（都是 PRD 里点名的验收项）：
 *   · `subjectId` 不可变、`subjectCode` 在工单内唯一：不能只凭「Z01」关联数据（A24/A26）；
 *   · 新建工单的环境读数为 **null**，不沿用演示值 26.4 / 78 / 1.2（A09）；
 *   · 空字符串、空白、null、undefined 先判空再转换，禁止 `Number(null)` / `Number('')` 变成 0（A10）；
 *   · 通过校验只代表「可以下发」，**不代表设备收到**；`accepted ≠ executed`（A14/A15）；
 *   · 设备回执必须与包里的工单/指派/配置版本逐项匹配，别的设备或旧回执不推进状态（A16/A18）。
 *
 * 存储：表在本模块内建（`work_order_*`），与 device-gateway 同一套做法 ——
 * 工单域是可选的一路，不装它平台照常跑。
 */

import { createHash, randomBytes } from "node:crypto";
import { nowIso, parseJson } from "../storage/db.mjs";
import { WorkflowError } from "./workflow.mjs";
import { appendEvent } from "./session.mjs";
import { allows } from "./permissions.mjs";

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 工单主表：revision 每次写 +1；trigger_event_id 保证同一触发事件只建一单
CREATE TABLE IF NOT EXISTS work_orders (
  id                  TEXT PRIMARY KEY,
  order_no            TEXT NOT NULL UNIQUE,
  revision            INTEGER NOT NULL DEFAULT 1,
  assignment_revision INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,
  paused_from         TEXT,
  title               TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'shortcut',
  commission          TEXT NOT NULL,
  location            TEXT NOT NULL,
  district            TEXT NOT NULL DEFAULT '',
  planned_start       TEXT,
  planned_end         TEXT,
  schedule_precision  TEXT NOT NULL DEFAULT 'date',
  time_zone           TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  requirements_text   TEXT NOT NULL,
  delivery_text       TEXT NOT NULL DEFAULT '',
  trigger_event_id    TEXT UNIQUE,
  created_at          TEXT NOT NULL,
  created_by          TEXT,
  updated_at          TEXT NOT NULL
);

-- 检测主体：Z01—Z04 由服务端确定性生成，客户端不许自编
CREATE TABLE IF NOT EXISTS work_order_subjects (
  subject_id      TEXT PRIMARY KEY,
  work_order_id   TEXT NOT NULL,
  subject_code    TEXT NOT NULL,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  position        TEXT,
  position_status TEXT NOT NULL DEFAULT 'pending',
  position_source TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (work_order_id, subject_code)
);

-- 指派历史：每次指派是一个新版本，旧版本保留（历史记录保持原作者归属）
CREATE TABLE IF NOT EXISTS work_order_assignments (
  assignment_id     TEXT PRIMARY KEY,
  work_order_id     TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  leader_account_id TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (work_order_id, revision)
);

CREATE TABLE IF NOT EXISTS work_order_assignment_members (
  assignment_id TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  role_code     TEXT NOT NULL,
  duties        TEXT NOT NULL,
  PRIMARY KEY (assignment_id, account_id)
);

-- 操作与转换日志：界面上「作业记录与成果」的时间线，也是 A23 的转换留痕
CREATE TABLE IF NOT EXISTS work_order_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id TEXT NOT NULL,
  type          TEXT NOT NULL,
  text          TEXT NOT NULL,
  actor_id      TEXT,
  at            TEXT NOT NULL
);

-- 环境草稿：一张工单一份，revision 每次保存 +1；未填的字段就是 null
CREATE TABLE IF NOT EXISTS work_order_env_drafts (
  work_order_id    TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL DEFAULT 0,
  inputs           TEXT NOT NULL,
  instruments      TEXT NOT NULL,
  pressure_input   TEXT,
  position         TEXT,
  measured_at      TEXT,
  needs_revalidate INTEGER NOT NULL DEFAULT 0,
  updated_by       TEXT,
  updated_at       TEXT
);

-- 不可变配置版本：通过校验才生成，生成后不可原地改写
CREATE TABLE IF NOT EXISTS work_order_configs (
  config_version  TEXT PRIMARY KEY,
  work_order_id   TEXT NOT NULL,
  draft_revision  INTEGER NOT NULL,
  inputs          TEXT NOT NULL,
  instruments     TEXT NOT NULL,
  position        TEXT NOT NULL,
  measured_at     TEXT NOT NULL,
  checks          TEXT NOT NULL,
  method_version  TEXT NOT NULL,
  validated_by    TEXT NOT NULL,
  validated_at    TEXT NOT NULL,
  superseded      INTEGER NOT NULL DEFAULT 0
);

-- 下发：一次尝试 = 一个不可变包 + 一条命令。bundle_id 唯一，供设备按 URL 下载
CREATE TABLE IF NOT EXISTS work_order_dispatches (
  id                  TEXT PRIMARY KEY,
  work_order_id       TEXT NOT NULL,
  bundle_id           TEXT NOT NULL UNIQUE,
  device_id           TEXT NOT NULL,
  command_id          TEXT,
  idempotency_key     TEXT NOT NULL,
  status              TEXT NOT NULL,
  reason              TEXT,
  activation_state    TEXT,
  config_version      TEXT NOT NULL,
  order_revision      INTEGER NOT NULL,
  assignment_revision INTEGER NOT NULL,
  body                TEXT NOT NULL,
  sha256              TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  accepted_at         TEXT,
  executed_at         TEXT,
  failed_at           TEXT,
  UNIQUE (work_order_id, idempotency_key)
);
`;

/* ------------------------------------------------------------------ *
 * 岗位、职责与仪表台账
 * ------------------------------------------------------------------ */

/**
 * 账号 → 岗位。界面、通知、导出文档和设备端**统一显示岗位**，
 * 不显示真实姓名（PRD §1.5）。同岗位多账号时用「全栈开发工程师 · 01」区分，
 * 这里每个岗位只有一个账号，所以 displayLabel 就是岗位名。
 */
export const ACCOUNT_ROLE = {
  shen: "project_manager",
  shi: "ai_architect",
  rao: "full_stack_engineer",
  ma: "embodied_engineer",
};

export const ROLE_LABEL = {
  project_manager: "项目经理",
  ai_architect: "人工智能架构师",
  full_stack_engineer: "全栈开发工程师",
  embodied_engineer: "具身智能工程师",
};

/** 职责字典（PRD §6.1 的建议默认职责） */
export const DUTIES = {
  environment_entry: "环境录入",
  scanner_dispatch: "扫描仪下发",
  capture_upload: "采集上传",
  mapping_patrol: "建图巡检",
  result_review: "算法及成果审核",
};

/** 按岗位给出的默认职责，项目经理可以改 */
export const DEFAULT_DUTIES = {
  project_manager: ["environment_entry", "scanner_dispatch", "result_review"],
  ai_architect: ["result_review"],
  full_stack_engineer: ["environment_entry", "scanner_dispatch", "capture_upload"],
  embodied_engineer: ["mapping_patrol", "capture_upload"],
};

/**
 * 仪表台账（量程来自配置，不偷偷回填演示仪表编号或量程 —— PRD §7.1）。
 * 录入时必须为每个参数挂一台仪表，量程按挂上的那台判定。
 */
export const INSTRUMENT_CATALOG = [
  {
    instrumentId: "TH-01",
    name: "温湿度计",
    fields: ["airTempC", "relativeHumidityPct"],
    ranges: {
      airTempC: { min: -20, max: 60, unit: "℃" },
      relativeHumidityPct: { min: 0, max: 100, unit: "%RH" },
    },
    source: "manual",
  },
  {
    instrumentId: "WS-01",
    name: "风速仪",
    fields: ["windSpeedMs"],
    ranges: { windSpeedMs: { min: 0, max: 30, unit: "m/s" } },
    source: "manual",
  },
  {
    instrumentId: "BP-01",
    name: "气压计",
    fields: ["atmosphericPressureHpa"],
    ranges: { atmosphericPressureHpa: { min: 300, max: 1100, unit: "hPa" } },
    source: "manual",
  },
];

/** 环境参数字典：单位、中文名、是否代进 HH 模型 */
export const ENV_FIELDS = [
  { key: "airTempC", label: "温度", unit: "℃" },
  { key: "relativeHumidityPct", label: "相对湿度", unit: "%RH" },
  { key: "windSpeedMs", label: "风速", unit: "m/s" },
  { key: "atmosphericPressureHpa", label: "大气压", unit: "hPa" },
];

/** 气压允许的输入单位：入库统一 hPa，原始值与单位一起留档（PRD §7.1） */
const PRESSURE_UNITS = {
  hpa: 1,
  kpa: 10,
  pa: 0.01,
};

/** 时钟误差允许上限：测量时间不得晚于服务端当前时间超过 60 秒（PRD §7.1） */
const CLOCK_TOLERANCE_MS = 60_000;

/** 命令有效期：沿用现有默认 5 分钟，过期不自动补发（PRD §8.2） */
const DISPATCH_TTL_MS = 5 * 60 * 1000;

/** 环境校验方法版本：写进配置版本，便于追溯判据 */
export const METHOD_VERSION = "env-validate/2.0";

export const ORDER_STATUSES = ["待指派", "待准备", "待作业", "作业中", "待验收", "已归档", "已暂停"];

/**
 * 下发状态机（PRD §8.2）。文案就是页面要显示的那句话，页面不再自己拼。
 */
export const DISPATCH_STATES = {
  none: "待下发",
  queued: "等待扫描仪上线",
  sent: "等待扫描仪接收",
  accepted: "扫描仪已接收，正在应用",
  executed: "扫描仪已应用",
  failed: "下发失败",
  expired: "下发超时，可重新下发",
  superseded: "已失效，需下发最新版本",
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const error = (status, code, message, extra = {}) => new WorkflowError(status, code, message, extra);

/** 空值判定：null / undefined / 空串 / 纯空白，一律算「没填」（PRD §7.1） */
export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/** 有限数值判定：只认 number 类型，不把 "12.5"、"" 、null 悄悄转成数 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function inTransaction(db, work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 回滚失败也要把原始错误抛出去 */
    }
    throw cause;
  }
}

function hex(size = 6) {
  return randomBytes(size).toString("hex");
}

/** 上海时区的「今天」：工单号、委托日期都按现场时间算，不按 UTC 跳日 */
function shanghaiParts(at = new Date()) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(at).map((item) => [item.type, item.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    stamp: `${parts.year}${parts.month}${parts.day}`,
    clock: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return shanghaiParts(date).date;
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 解析测量时间：接受带时区 ISO 8601 或本地 `YYYY-MM-DD HH:mm` */
function parseMeasuredAt(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const iso = local ? `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6] ?? "00"}+08:00` : text;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString(), text } : null;
}

/* ------------------------------------------------------------------ *
 * 委托样例（PRD §4.2）
 * ------------------------------------------------------------------ */

/**
 * 快捷键场景的预置委托样例。
 *
 * 两个口径照 PRD 抄：
 *   · 检测主体**只有现场四根木柱**，原始委托不带 Z 编号、不带位号方位猜测；
 *   · 样例时间按触发日生成相对日期，`2026 年 9 月 16 日` 那种固定日期不能永远用下去。
 */
export function sampleCommission(now = new Date()) {
  const today = shanghaiParts(now);
  const start = addDays(today.date, 2);
  const end = addDays(today.date, 4);
  const deliverBy = addDays(today.date, 9);
  const startCn = start.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y} 年 ${Number(m)} 月 ${Number(d)} 日`);
  const endCn = end.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${Number(m)} 月 ${Number(d)} 日`);
  const deliverCn = deliverBy.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y} 年 ${Number(m)} 月 ${Number(d)} 日`);
  const dateCn = today.date.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y} 年 ${Number(m)} 月 ${Number(d)} 日`);

  const requirements =
    `为掌握示例寺现场木柱保存状况，做好日常保护与资料建档工作，现委托贵方于 ${startCn} 至 ${endCn}，` +
    `对位于上海市松江区示例寺院内的四根木柱开展现场检测。本次检测范围限于上述四根木柱，` +
    `具体位置在进场时由本单位现场管理岗位与贵方核对。请结合现场开放安排开展作业，采用非破坏性检测方式，` +
    `逐根记录检测位置、环境条件和原始数据，形成可追溯的影像与检测资料，并于 ${deliverCn} 前提交检测记录及成果报告。` +
    `进场时间和资料交接事宜，请与本单位现场管理岗位联系。`;

  return {
    title: "关于开展示例寺四根木柱检测工作的委托",
    unit: "示例古建筑保护管理单位",
    date: today.date,
    dateText: dateCn,
    no: null,
    projectName: "示例寺古建筑检测",
    district: "上海市松江区",
    address: "示例寺院内",
    location: "上海市松江区示例寺院内",
    subjectType: "wood_column",
    subjectName: "木柱",
    subjectCount: 4,
    subjectNote: "示例寺院内，具体位置进场核对",
    plannedStart: start,
    plannedEnd: end,
    schedulePrecision: "date",
    timeZone: "Asia/Shanghai",
    scope: "现场四根木柱的非破坏性检测（逐根记录检测位置、环境条件与原始数据）",
    requirementsText: requirements,
    deliveryText: `检测记录及成果报告，${deliverBy} 前提交`,
    deliveryDue: deliverBy,
    contact: { role: "现场管理岗位", channel: "进场时间与资料交接由委托单位现场值班渠道联系" },
    /*
      原始附件单独保留（PRD §3.2）：它们是**单位随单资料**，
      不进平台编号体系，也不转成本次检测结论。
    */
    attachments: [
      { assetId: `asset-commission-${today.stamp}`, name: "示例寺建筑平面示意图.pdf", kind: "图纸", sizeText: "1.2 MB", sourceMode: "replay" },
      { assetId: `asset-commission-plan-${today.stamp}`, name: "现场进场与开放时间安排.docx", kind: "说明", sizeText: "86 KB", sourceMode: "replay" },
    ],
    sourceMode: "replay",
  };
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

export function createWorkOrderService({ db, hub = null, devices = null, sessionId = "demo-01", logger = console } = {}) {
  db.exec(SCHEMA);

  /* ---------------- 读侧：行 → 对象 ---------------- */

  const orderRow = (id) => db.prepare("SELECT * FROM work_orders WHERE id = ? OR order_no = ?").get(id, id);
  const subjectRows = (orderId) =>
    db.prepare("SELECT * FROM work_order_subjects WHERE work_order_id = ? ORDER BY subject_code").all(orderId);
  const assignmentRow = (orderId, revision = null) =>
    revision === null
      ? db.prepare("SELECT * FROM work_order_assignments WHERE work_order_id = ? ORDER BY revision DESC LIMIT 1").get(orderId)
      : db.prepare("SELECT * FROM work_order_assignments WHERE work_order_id = ? AND revision = ?").get(orderId, revision);
  const memberRows = (assignmentId) =>
    db.prepare("SELECT * FROM work_order_assignment_members WHERE assignment_id = ?").all(assignmentId);
  const draftRow = (orderId) => db.prepare("SELECT * FROM work_order_env_drafts WHERE work_order_id = ?").get(orderId);
  const configRow = (orderId, configVersion = null) =>
    configVersion
      ? db.prepare("SELECT * FROM work_order_configs WHERE work_order_id = ? AND config_version = ?").get(orderId, configVersion)
      : db.prepare("SELECT * FROM work_order_configs WHERE work_order_id = ? ORDER BY validated_at DESC, rowid DESC LIMIT 1").get(orderId);
  const dispatchRows = (orderId) =>
    db.prepare("SELECT * FROM work_order_dispatches WHERE work_order_id = ? ORDER BY created_at DESC, rowid DESC").all(orderId);
  const logRows = (orderId, limit = 60) =>
    db.prepare("SELECT * FROM work_order_logs WHERE work_order_id = ? ORDER BY id DESC LIMIT ?").all(orderId, limit);

  const roleOf = (accountId) => ACCOUNT_ROLE[accountId] ?? null;
  const labelOf = (accountId) => (roleOf(accountId) ? ROLE_LABEL[roleOf(accountId)] : null);

  /** 账号在界面、通知、导出与设备端统一显示岗位；没有岗位的账号不显示姓名 */
  function displayLabel(accountId) {
    const role = roleOf(accountId);
    return role ? ROLE_LABEL[role] : "未登记岗位";
  }

  function assignmentView(orderId) {
    const row = assignmentRow(orderId);
    if (!row) return null;
    const members = memberRows(row.assignment_id).map((member) => ({
      accountId: member.account_id,
      roleCode: member.role_code,
      label: displayLabel(member.account_id),
      duties: parseJson(member.duties, []).map((code) => ({ code, label: DUTIES[code] ?? code })),
    }));
    return {
      assignmentId: row.assignment_id,
      revision: row.revision,
      leaderAccountId: row.leader_account_id,
      leaderRoleCode: roleOf(row.leader_account_id),
      leaderLabel: displayLabel(row.leader_account_id),
      members,
      assignedBy: row.created_by,
      assignedByLabel: displayLabel(row.created_by),
      assignedAt: row.created_at,
    };
  }

  /** 该账号在当前指派版本下的职责集合；项目经理按角色拿全套流程权限 */
  function dutiesOf(orderId, accountId) {
    const assignment = assignmentRow(orderId);
    if (!assignment) return new Set();
    const set = new Set();
    if (assignment.leader_account_id === accountId) {
      const leaderRole = roleOf(accountId);
      for (const duty of DEFAULT_DUTIES[leaderRole] ?? []) set.add(duty);
    }
    for (const member of memberRows(assignment.assignment_id)) {
      if (member.account_id !== accountId) continue;
      for (const duty of parseJson(member.duties, [])) set.add(duty);
    }
    return set;
  }

  /**
   * 项目经理：指派权是**按岗位显式授予**的独立权限，
   * 不从「全权限」集合里推出来（PRD §6.2）。判据只有 permissions.mjs 一处。
   */
  function isProjectManager(accountId) {
    return allows(accountId, "workorder:assign");
  }

  function requireManager(accountId, action) {
    if (!isProjectManager(accountId)) {
      throw error(403, "FORBIDDEN", `「${action}」只有项目经理可以做（当前账号岗位：${displayLabel(accountId)}）`);
    }
  }

  /**
   * 流程动作（开始 / 提交验收 / 验收 / 归档 / 暂停 / 恢复）的放行判据。
   *
   * 2026-09-17 从"只有项目经理"改成**权限判据**（`workorder:operate`，沈与史都有）：
   * 用户要求给架构师放开（「shi 账号权限拉满」），而演示里实际在平台上点这些按钮的
   * 就是架构师。判据必须与 `capabilities()` 里算出来的 `canPause/canResume/…` **同源**，
   * 否则会出现"按钮亮着、点下去 403"——那是最难排查的一种不一致。
   */
  function requireOperator(accountId, action) {
    if (isProjectManager(accountId) || allows(accountId, "workorder:operate")) return;
    throw error(
      403,
      "FORBIDDEN",
      `「${action}」需要项目经理或「流程操作」权限（当前账号：${displayLabel(accountId)}）`,
    );
  }

  function log(orderId, type, text, actorId = null) {
    db.prepare("INSERT INTO work_order_logs (work_order_id, type, text, actor_id, at) VALUES (?,?,?,?,?)").run(
      orderId,
      type,
      text,
      actorId,
      nowIso(),
    );
  }

  /** 写事件 + 广播：四端与重新登录的账号都能看到新工单（A03） */
  function announce(type, orderId, actorId, payload = {}) {
    if (!sessionId) return;
    try {
      const event = appendEvent(db, sessionId, {
        type,
        entityKind: "workOrder",
        entityId: orderId,
        actorId,
        payload,
      });
      if (event && hub) hub.broadcast(sessionId, event);
    } catch (cause) {
      logger.warn?.("工单事件广播失败", cause);
    }
  }

  /* ------------------------------------------------------------------ *
   * 触发建单（Ctrl+Q+L 的服务端落点）
   * ------------------------------------------------------------------ */

  /**
   * 小木接单 → 平台工单。
   *
   * 幂等按 `triggerEventId`：同一触发事件重试返回**同一张工单**，不新建（A01/A24）。
   * 工单、四条主体记录与转换日志在同一事务里落库；失败不留缺主体的半成品（PRD §3.3）。
   */
  function trigger({ eventId, actorId }) {
    if (isBlank(eventId)) throw error(422, "NO_EVENT_ID", "缺少触发事件 ID，服务端无法保证幂等");

    const existing = db.prepare("SELECT * FROM work_orders WHERE trigger_event_id = ?").get(String(eventId));
    if (existing) return { order: existing, created: false };

    const now = new Date();
    const commission = sampleCommission(now);
    const stamp = shanghaiParts(now).stamp;

    return inTransaction(db, () => {
      // 单号按「当天已有多少单」顺序生成；在事务里数，避免两次触发撞号
      const seq = (db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE order_no LIKE ?").get(`WO-${stamp}-%`)?.n ?? 0) + 1;
      const serial = String(seq).padStart(4, "0");
      const id = `wo-${stamp}-${serial}`;
      const orderNo = `WO-${stamp}-${serial}`;
      const at = nowIso();

      db.prepare(
        `INSERT INTO work_orders
          (id, order_no, revision, assignment_revision, status, title, source, commission, location, district,
           planned_start, planned_end, schedule_precision, time_zone, requirements_text, delivery_text,
           trigger_event_id, created_at, created_by, updated_at)
         VALUES (?,?,1,0,'待指派',?,'shortcut',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        orderNo,
        `${commission.projectName} · 四根木柱检测`,
        JSON.stringify(commission),
        commission.location,
        commission.district,
        commission.plannedStart,
        commission.plannedEnd,
        commission.schedulePrecision,
        commission.timeZone,
        commission.requirementsText,
        commission.deliveryText,
        String(eventId),
        at,
        actorId ?? null,
        at,
      );

      // 四条主体：确定性生成 Z01—Z04，位置未知就标「待定位」，不猜方位
      for (let index = 1; index <= commission.subjectCount; index += 1) {
        const code = `Z${String(index).padStart(2, "0")}`;
        db.prepare(
          `INSERT INTO work_order_subjects
            (subject_id, work_order_id, subject_code, type, name, position, position_status, position_source, created_at)
           VALUES (?,?,?,?,?,NULL,'pending',NULL,?)`,
        ).run(`sub-${hex(6)}`, id, code, commission.subjectType, commission.subjectName, at);
      }

      // 环境草稿：全部为 null —— 新单不沿用任何演示读数（A09）
      db.prepare(
        `INSERT INTO work_order_env_drafts
          (work_order_id, revision, inputs, instruments, pressure_input, position, measured_at, needs_revalidate, updated_by, updated_at)
         VALUES (?,0,?,?,NULL,NULL,NULL,0,NULL,NULL)`,
      ).run(
        id,
        JSON.stringify({ airTempC: null, relativeHumidityPct: null, windSpeedMs: null, atmosphericPressureHpa: null }),
        JSON.stringify([]),
      );

      log(id, "convert", "小木已创建平台工单，并为四根木柱生成 Z01—Z04", actorId);
      log(id, "commission", `接收委托：${commission.unit}（${commission.date}）`, actorId);
      log(id, "assign", "等待项目经理指派负责人与参与人员", actorId);

      const row = orderRow(id);
      announce("workOrder.created", id, actorId, { orderNo, status: row.status });
      return { order: row, created: true };
    });
  }

  /* ------------------------------------------------------------------ *
   * 读取
   * ------------------------------------------------------------------ */

  const STATUS_FILTERS = {
    all: null,
    assign: ["待指派"],
    active: ["待准备", "待作业", "作业中", "待验收", "已暂停"],
    archived: ["已归档"],
  };

  function list({ filter = "all", q = "" } = {}) {
    const rows = db.prepare("SELECT * FROM work_orders ORDER BY created_at DESC, rowid DESC").all();
    const allow = STATUS_FILTERS[filter] ?? null;
    const needle = String(q ?? "").trim().toLowerCase();
    return rows
      .filter((row) => (allow ? allow.includes(row.status) : true))
      .filter((row) =>
        needle
          ? row.order_no.toLowerCase().includes(needle) ||
            String(row.title).toLowerCase().includes(needle) ||
            String(row.location).toLowerCase().includes(needle)
          : true,
      )
      .map((row) => ({
        id: row.id,
        orderNo: row.order_no,
        title: row.title,
        status: row.status,
        revision: row.revision,
        assignmentRevision: row.assignment_revision,
        location: row.location,
        district: row.district,
        plannedStart: row.planned_start,
        plannedEnd: row.planned_end,
        createdAt: row.created_at,
        source: row.source,
        leaderLabel: assignmentView(row.id)?.leaderLabel ?? null,
        dispatchState: dispatchRows(row.id)[0]?.status ?? "none",
      }));
  }

  /** 指派候选项：按岗位显示，同岗位多账号用「岗位 · 01」区分 */
  function accounts() {
    const byRole = new Map();
    for (const [accountId, roleCode] of Object.entries(ACCOUNT_ROLE)) {
      const bucket = byRole.get(roleCode) ?? [];
      bucket.push(accountId);
      byRole.set(roleCode, bucket);
    }
    return Object.entries(ROLE_LABEL).map(([roleCode, label]) => {
      const ids = byRole.get(roleCode) ?? [];
      return {
        roleCode,
        label,
        suggestedDuties: (DEFAULT_DUTIES[roleCode] ?? []).map((code) => ({ code, label: DUTIES[code] ?? code })),
        candidates:
          ids.length > 1
            ? ids.map((accountId, index) => ({
                accountId,
                displayLabel: `${label} · ${String(index + 1).padStart(2, "0")}`,
              }))
            : ids.map((accountId) => ({ accountId, displayLabel: label })),
      };
    });
  }

  function capabilities(orderId, accountId) {
    const row = orderRow(orderId);
    const manager = isProjectManager(accountId);
    const assignment = assignmentRow(orderId);
    const duties = dutiesOf(orderId, accountId);
    const assigned = Boolean(assignment) && (assignment.leader_account_id === accountId || duties.size > 0);
    const openStatus = ["待准备", "待作业", "作业中", "待验收"].includes(row.status);
    /*
      ── 流程动作的两种放行方式（用户 2026-09-17「shi 权限拉满」）─────────
      原来这些判据一律写 `manager && …`，于是"项目经理"这一个岗位既是**指派权**、
      又垄断了运行校验/暂停/恢复/验收/归档。架构师（史）在演示里是实际在操作平台的人，
      却连"运行环境校验""录环境读数"都点不动。

      现在按 PRD §6.2 的原意分成两条**权限**，而不是两个岗位：
        · `workorder:operate` —— 流程动作（校验、暂停/恢复/开始/提交/验收/归档）；
        · `env:entry`         —— 录环境读数（PRD 3.1 的录入这一步）。
      指派（`canAssign`）仍然**只认 `workorder:assign`**：
      PRD 明令架构师不得因"全权限"拿到指派权，且演示动线里这一步是项目经理做的。
    */
    const operator = manager || allows(accountId, "workorder:operate");
    const envEntry = manager || duties.has("environment_entry") || allows(accountId, "env:entry");
    return {
      /* 指派：只有项目经理（= 有 workorder:assign），且本单未归档 */
      canAssign: manager && row.status !== "已归档",
      /*
        删除不设权限：任何已登录账号都能删（产品口径 2026-09-14）。
        演示现场最常见的诉求就是「把刚才试出来的那几张清掉」，
        为它加一道岗位门槛只会让清场变慢。破坏性由界面的二次确认兜。
      */
      canDelete: true,
      canViewFull: manager || assigned || envEntry,
      assigned,
      isLeader: assignment?.leader_account_id === accountId,
      canEditEnvironment: row.status !== "已归档" && envEntry,
      canValidate: row.status !== "已归档" && (manager || allows(accountId, "env:validate")),
      canDispatch: row.status !== "已归档" && (manager || duties.has("scanner_dispatch")),
      canPause: operator && openStatus,
      canResume: operator && row.status === "已暂停",
      canStart: operator && row.status === "待作业",
      canSubmit: operator && row.status === "作业中",
      canAccept: operator && row.status === "待验收",
      canArchive: operator && ["待准备", "待作业", "作业中", "待验收", "已暂停"].includes(row.status),
    };
  }

  /** 环境草稿视图：空值就是 null，界面上显示「—」「待录入」 */
  function environmentView(orderId) {
    const draft = draftRow(orderId);
    const config = configRow(orderId);
    return {
      draftRevision: draft?.revision ?? 0,
      inputs: parseJson(draft?.inputs, {
        airTempC: null,
        relativeHumidityPct: null,
        windSpeedMs: null,
        atmosphericPressureHpa: null,
      }),
      instruments: parseJson(draft?.instruments, []),
      pressureInput: parseJson(draft?.pressure_input, null),
      position: draft?.position ?? null,
      measuredAt: draft?.measured_at ?? null,
      needsRevalidate: Boolean(draft?.needs_revalidate),
      updatedAt: draft?.updated_at ?? null,
      updatedBy: draft?.updated_by ?? null,
      updatedByLabel: draft?.updated_by ? displayLabel(draft.updated_by) : null,
      config: config
        ? {
            configVersion: config.config_version,
            draftRevision: config.draft_revision,
            inputs: parseJson(config.inputs, {}),
            instruments: parseJson(config.instruments, []),
            position: config.position,
            measuredAt: config.measured_at,
            checks: parseJson(config.checks, []),
            methodVersion: config.method_version,
            validatedBy: config.validated_by,
            validatedByLabel: displayLabel(config.validated_by),
            validatedAt: config.validated_at,
            superseded: Boolean(config.superseded),
          }
        : null,
      catalog: INSTRUMENT_CATALOG,
      fields: ENV_FIELDS,
    };
  }

  function dispatchView(row) {
    if (!row) {
      return { state: "none", stateText: DISPATCH_STATES.none, bundleId: null, deviceId: null, configVersion: null };
    }
    return {
      dispatchId: row.id,
      bundleId: row.bundle_id,
      deviceId: row.device_id,
      commandId: row.command_id,
      state: row.status,
      stateText: DISPATCH_STATES[row.status] ?? row.status,
      reason: row.reason ?? null,
      activationState: row.activation_state ?? null,
      configVersion: row.config_version,
      orderRevision: row.order_revision,
      assignmentRevision: row.assignment_revision,
      sha256: row.sha256,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      executedAt: row.executed_at,
      failedAt: row.failed_at,
      createdByLabel: row.created_by ? displayLabel(row.created_by) : null,
    };
  }

  /**
   * 工单详情。
   *
   * `actorId` 传进来时会算一次「这个人能不能看全」：未指派员工按 PRD §6.1
   * 只看得到摘要与进度，**委托原文与随单附件不下发给他**（页面同时提示
   * 「尚未指派到此工单」）。项目经理与被指派的人看全量。
   */
  function detail(orderId, actorId = null) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    const assignment = assignmentView(row.id);
    const environment = environmentView(row.id);
    const dispatches = dispatchRows(row.id).map(dispatchView);
    const restricted = actorId ? !capabilities(row.id, actorId).canViewFull : false;
    const commission = parseJson(row.commission, {});
    return {
      restricted,
      order: {
        id: row.id,
        orderNo: row.order_no,
        revision: row.revision,
        assignmentRevision: row.assignment_revision,
        status: row.status,
        pausedFrom: row.paused_from,
        title: row.title,
        source: row.source,
        location: row.location,
        district: row.district,
        plannedStart: row.planned_start,
        plannedEnd: row.planned_end,
        schedulePrecision: row.schedule_precision,
        timeZone: row.time_zone,
        // 未指派员工拿不到委托正文（页面显示「尚未指派到此工单」）
        requirementsText: restricted ? "" : row.requirements_text,
        deliveryText: row.delivery_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      commission: restricted ? { ...commission, attachments: [] } : commission,
      subjects: subjectRows(row.id).map((subject) => ({
        subjectId: subject.subject_id,
        code: subject.subject_code,
        type: subject.type,
        name: subject.name,
        position: subject.position,
        positionStatus: subject.position_status,
      })),
      assignment,
      environment,
      dispatch: dispatches[0] ?? dispatchView(null),
      dispatches,
      work: { records: [], attachments: [], report: null },
      logs: logRows(row.id).map((item) => ({
        at: item.at,
        type: item.type,
        text: item.text,
        actorId: item.actor_id,
        actorLabel: item.actor_id ? displayLabel(item.actor_id) : "系统",
      })),
    };
  }

  /**
   * 详情 + 当前账号的能力 + 指派候选项 + 可下发目标。
   *
   * 页面要的四样东西一次给全：**每条返回详情的路由都必须走这个函数** ——
   * 之前只有 GET 详情那条拼了 capabilities，触发器那条漏了，
   * 前端拿到的 detail 里没有 capabilities，一点开就白屏。
   */
  function detailFor(orderId, actorId) {
    return {
      ...detail(orderId, actorId),
      capabilities: capabilities(orderRow(orderId).id, actorId),
      accounts: accounts(),
      targets: deviceTargets(),
      assignmentCandidates: accounts().flatMap((group) =>
        group.candidates.map((candidate) => ({
          ...candidate,
          roleCode: group.roleCode,
          suggestedDuties: group.suggestedDuties,
        })),
      ),
    };
  }

  /* ------------------------------------------------------------------ *
   * 指派（PRD §6）
   * ------------------------------------------------------------------ */

  function assign({ orderId, actorId, leaderAccountId, members = [], expectedRevision = null }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    requireManager(actorId, "指派人员");
    if (row.status === "已归档") throw error(422, "ORDER_ARCHIVED", "已归档工单不能再改指派");
    if (expectedRevision !== null && Number(expectedRevision) !== row.assignment_revision) {
      throw error(409, "REVISION_CONFLICT", "指派版本已变化，请刷新后重试", {
        expected: Number(expectedRevision),
        actual: row.assignment_revision,
        retryable: true,
      });
    }
    if (isBlank(leaderAccountId) || !ACCOUNT_ROLE[leaderAccountId]) {
      throw error(422, "BAD_LEADER", "负责人必须是一个已登记岗位的账号");
    }
    const seen = new Set([leaderAccountId]);
    const cleanMembers = [];
    for (const member of members) {
      const accountId = member?.accountId;
      if (isBlank(accountId) || !ACCOUNT_ROLE[accountId]) {
        throw error(422, "BAD_MEMBER", "参与人员必须是已登记岗位的账号");
      }
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      const duties = [...new Set([].concat(member?.duties ?? []))].filter((code) => code in DUTIES);
      cleanMembers.push({ accountId, duties });
    }

    return inTransaction(db, () => {
      const revision = row.assignment_revision + 1;
      const assignmentId = `asg-${String(revision).padStart(4, "0")}-${hex(3)}`;
      const at = nowIso();
      db.prepare(
        `INSERT INTO work_order_assignments (assignment_id, work_order_id, revision, leader_account_id, created_by, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(assignmentId, row.id, revision, leaderAccountId, actorId, at);
      db.prepare(
        "INSERT INTO work_order_assignment_members (assignment_id, account_id, role_code, duties) VALUES (?,?,?,?)",
      ).run(assignmentId, leaderAccountId, roleOf(leaderAccountId), JSON.stringify(DEFAULT_DUTIES[roleOf(leaderAccountId)] ?? []));
      for (const member of cleanMembers) {
        db.prepare(
          "INSERT INTO work_order_assignment_members (assignment_id, account_id, role_code, duties) VALUES (?,?,?,?)",
        ).run(assignmentId, member.accountId, roleOf(member.accountId), JSON.stringify(member.duties));
      }

      // 换人 → 旧的下发包一律失效（PRD §6.3）
      const invalidated = supersedeDispatches(row.id, "人员指派已更新，需下发最新版本");

      const nextStatus = row.status === "待指派" ? "待准备" : row.status;
      db.prepare(
        "UPDATE work_orders SET assignment_revision = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      ).run(revision, nextStatus, at, row.id);

      const leaderLabel = displayLabel(leaderAccountId);
      const memberLabels = cleanMembers.map((member) => displayLabel(member.accountId));
      log(
        row.id,
        "assign",
        `指派负责人：${leaderLabel}${memberLabels.length ? `；参与：${memberLabels.join("、")}` : ""}`,
        actorId,
      );
      announce("workOrder.assigned", row.id, actorId, { assignmentRevision: revision, leaderLabel });
      return { order: orderRow(row.id), assignment: assignmentView(row.id), invalidatedDispatches: invalidated };
    });
  }

  /* ------------------------------------------------------------------ *
   * 删除工单
   * ------------------------------------------------------------------ */

  /**
   * 删除一张工单及其全部从属记录（主体、指派、环境草稿与版本、下发包与回执、日志）。
   *
   * 为什么是级联删而不是打标记：这是**演示现场的清场动作** ——
   * 用户要的是「把刚才试出来的那几张清掉」，留一堆软删记录只会在列表里继续出现。
   *
   * **不设权限**（产品口径 2026-09-14）：任何已登录账号都能删，
   * 破坏性由界面的二次确认兜住，不在服务端按岗位拦。
   *
   * 未执行的下发包会随工单一起消失：设备若之后才来取包，会拿到 404（明确的失败），
   * 不会应用一个已经被删掉的工单。已经应用过的设备侧副本平台收不回，界面上写清楚。
   */
  function deleteOrder({ orderId, actorId }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    const openDispatches = db
      .prepare("SELECT COUNT(*) AS n FROM work_order_dispatches WHERE work_order_id = ? AND status IN ('queued','sent','accepted')")
      .get(row.id)?.n ?? 0;

    inTransaction(db, () => {
      const assignments = db.prepare("SELECT assignment_id FROM work_order_assignments WHERE work_order_id = ?").all(row.id);
      for (const item of assignments) {
        db.prepare("DELETE FROM work_order_assignment_members WHERE assignment_id = ?").run(item.assignment_id);
      }
      for (const table of [
        "work_order_logs",
        "work_order_env_drafts",
        "work_order_configs",
        "work_order_dispatches",
        "work_order_assignments",
        "work_order_subjects",
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE work_order_id = ?`).run(row.id);
      }
      /*
        工单下的**自主巡航任务**（`mission` 实体，用户 2026-09-18）也要一起清：
        它们是共享会话里的实体，不删就成了"指着已删工单的孤儿任务"——
        建图巡航页的横幅会一直挂着一条来源工单已经不存在的任务。
        `orderId` 存在实体的 JSON 里，用 json_extract 精确匹配（不用 LIKE 猜）。
      */
      db.prepare("DELETE FROM entities WHERE kind='mission' AND json_extract(data,'$.orderId') = ?").run(row.id);
      db.prepare("DELETE FROM work_orders WHERE id = ?").run(row.id);
    });

    announce("workOrder.deleted", row.id, actorId, { orderNo: row.order_no });
    return { orderNo: row.order_no, status: row.status, openDispatches };
  }

  /* ------------------------------------------------------------------ *
   * 状态流转（暂停 / 恢复 / 开始 / 提交验收 / 验收 / 归档）
   * ------------------------------------------------------------------ */

  const TRANSITIONS = {
    start: { from: ["待作业"], to: "作业中", label: "开始作业" },
    submit: { from: ["作业中"], to: "待验收", label: "提交验收" },
    accept: { from: ["待验收"], to: "已归档", label: "验收通过并归档" },
    archive: { from: ["待准备", "待作业", "作业中", "待验收"], to: "已归档", label: "归档工单" },
    pause: { from: ["待准备", "待作业", "作业中", "待验收"], to: "已暂停", label: "暂停工单" },
    resume: { from: ["已暂停"], to: null, label: "恢复工单" },
  };

  function setStatus({ orderId, actorId, action, expectedRevision = null }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    const transition = TRANSITIONS[action];
    if (!transition) throw error(422, "BAD_ACTION", `不支持的状态动作 ${action}`);
    requireOperator(actorId, transition.label);
    if (expectedRevision !== null && Number(expectedRevision) !== row.revision) {
      throw error(409, "REVISION_CONFLICT", "工单已变化，请刷新后重试", { retryable: true });
    }
    if (!transition.from.includes(row.status)) {
      throw error(422, "BAD_STATE", `当前状态「${row.status}」不能执行「${transition.label}」`);
    }

    const at = nowIso();
    if (action === "pause") {
      db.prepare("UPDATE work_orders SET status='已暂停', paused_from=?, revision=revision+1, updated_at=? WHERE id=?").run(
        row.status,
        at,
        row.id,
      );
      log(row.id, "pause", `暂停工单（原状态：${row.status}），已生成记录全部保留`, actorId);
      announce("workOrder.paused", row.id, actorId, { from: row.status });
    } else if (action === "resume") {
      const back = row.paused_from ?? "待准备";
      db.prepare("UPDATE work_orders SET status=?, paused_from=NULL, revision=revision+1, updated_at=? WHERE id=?").run(
        back,
        at,
        row.id,
      );
      log(row.id, "resume", `恢复工单，回到「${back}」`, actorId);
      announce("workOrder.resumed", row.id, actorId, { to: back });
    } else {
      db.prepare("UPDATE work_orders SET status=?, revision=revision+1, updated_at=? WHERE id=?").run(
        transition.to,
        at,
        row.id,
      );
      log(row.id, transition.label, `工单状态：${row.status} → ${transition.to}`, actorId);
      if (action === "archive") supersedeDispatches(row.id, "工单已归档");
      announce("workOrder.status", row.id, actorId, { from: row.status, to: transition.to });
    }
    return orderRow(row.id);
  }

  /* ------------------------------------------------------------------ *
   * 环境草稿与校验（PRD §7）
   * ------------------------------------------------------------------ */

  /** 把客户端传来的读数整理成草稿：空值保持 null，不补默认值 */
  function normalizeDraftInput(body = {}) {
    const raw = body.inputs ?? {};
    const inputs = {
      airTempC: isBlank(raw.airTempC) ? null : raw.airTempC,
      relativeHumidityPct: isBlank(raw.relativeHumidityPct) ? null : raw.relativeHumidityPct,
      windSpeedMs: isBlank(raw.windSpeedMs) ? null : raw.windSpeedMs,
      atmosphericPressureHpa: null,
    };

    /*
      大气压允许用 Pa / kPa 录入：先判空、再按显式单位换算，原始值与单位一起留档。
      没写单位就不猜 —— 1008 是 hPa 还是 kPa 差 10 倍，猜错比留空更糟。
    */
    let pressureInput = null;
    const rawPressure = body.pressure ?? (body.pressureInput ?? null);
    if (!isBlank(rawPressure)) {
      const value = typeof rawPressure === "object" ? rawPressure.value : rawPressure;
      // 单位原样留档（kpa / kPa 都收），换算时再归一化比较
      const unitText = String((typeof rawPressure === "object" ? rawPressure.unit : body.pressureUnit) ?? "").trim();
      const unit = unitText.toLowerCase();
      if (isBlank(value)) {
        pressureInput = null;
      } else if (!(unit in PRESSURE_UNITS)) {
        throw error(422, "BAD_PRESSURE_UNIT", "大气压必须显式选择单位（hPa / kPa / Pa）", {
          fieldErrors: [{ field: "atmosphericPressureHpa", message: "缺少或无法识别的大气压单位" }],
        });
      } else if (!finiteNumber(value)) {
        pressureInput = { value, unit: unitText, hpa: null, invalid: true };
        inputs.atmosphericPressureHpa = value;
      } else {
        const hpa = Number((value * PRESSURE_UNITS[unit]).toFixed(2));
        pressureInput = { value, unit: unitText, hpa };
        inputs.atmosphericPressureHpa = hpa;
      }
    }

    const instruments = [].concat(body.instruments ?? []).map((item) => ({
      instrumentId: isBlank(item?.instrumentId) ? null : String(item.instrumentId).trim(),
      fields: [].concat(item?.fields ?? []).map(String),
      source: String(item?.source ?? "manual"),
    }));

    return {
      inputs,
      instruments,
      pressureInput,
      position: isBlank(body.position) ? null : String(body.position).trim(),
      measuredAt: isBlank(body.measuredAt) ? null : String(body.measuredAt).trim(),
    };
  }

  /**
   * 草稿指纹：用来判断「这次保存是否真的改了内容」。
   *
   * 测量时间必须**先归一化再比较**：草稿里存的是录入的原样字符串
   * （`2026-09-14T05:52`），配置版本里存的是解析后的 ISO
   * （`2026-09-14T05:52:00.000Z`）—— 直接比字符串会把「原样再存一次」
   * 判成改动，于是什么都没改也被标上「需重新校验」，旧版本再也发不出去。
   */
  function draftSignature(draft) {
    const measured = parseMeasuredAt(draft.measuredAt);
    return JSON.stringify({
      inputs: draft.inputs,
      instruments: draft.instruments,
      position: draft.position,
      measuredAt: measured ? measured.iso : (draft.measuredAt ?? null),
    });
  }

  function saveDraft({ orderId, actorId, body, expectedRevision = null }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    if (row.status === "已归档") throw error(422, "ORDER_ARCHIVED", "已归档工单不能再改环境读数");
    const caps = capabilities(row.id, actorId);
    if (!caps.canEditEnvironment) {
      throw error(
        403,
        "FORBIDDEN",
        caps.assigned
          ? "你在本单没有「环境录入」职责"
          : "当前账号既没有「环境录入」权限，也没有被指派到本工单（可用项目经理或架构师账号）",
      );
    }
    const current = draftRow(row.id);
    if (expectedRevision !== null && Number(expectedRevision) !== (current?.revision ?? 0)) {
      throw error(409, "REVISION_CONFLICT", "环境草稿已变化，请刷新后重试", { retryable: true });
    }

    const next = normalizeDraftInput(body);
    const at = nowIso();
    const config = configRow(row.id);
    // 有已生效版本时，任何改动都要重新校验（PRD §7.3.5）
    const changed = config ? draftSignature(next) !== draftSignature(parseConfigAsDraft(config)) : false;
    db.prepare(
      `INSERT INTO work_order_env_drafts
        (work_order_id, revision, inputs, instruments, pressure_input, position, measured_at, needs_revalidate, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(work_order_id) DO UPDATE SET
         revision = excluded.revision, inputs = excluded.inputs, instruments = excluded.instruments,
         pressure_input = excluded.pressure_input, position = excluded.position, measured_at = excluded.measured_at,
         needs_revalidate = excluded.needs_revalidate, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(
      row.id,
      (current?.revision ?? 0) + 1,
      JSON.stringify(next.inputs),
      JSON.stringify(next.instruments),
      next.pressureInput ? JSON.stringify(next.pressureInput) : null,
      next.position,
      next.measuredAt,
      changed ? 1 : 0,
      actorId,
      at,
    );
    log(row.id, "environment", `保存环境草稿 rev${(current?.revision ?? 0) + 1}`, actorId);
    announce("workOrder.environment", row.id, actorId, { draftRevision: (current?.revision ?? 0) + 1, needsRevalidate: changed });
    return environmentView(row.id);
  }

  function parseConfigAsDraft(config) {
    return {
      inputs: parseJson(config.inputs, {}),
      instruments: parseJson(config.instruments, []),
      position: config.position,
      measuredAt: config.measured_at,
    };
  }

  /**
   * 环境校验（服务端权威）。
   *
   * 判据逐条列出来，前端只是同一套规则的即时反馈；空值绝不能靠 `Number()` 过关。
   */
  function validate(inputsLike) {
    const checks = [];
    const fieldErrors = [];
    const push = (key, label, ok, field, message) => {
      checks.push({ key, label, ok, field, message });
      if (!ok) fieldErrors.push({ field, message });
    };

    for (const field of ENV_FIELDS) {
      const value = inputsLike.inputs?.[field.key];
      if (isBlank(value)) {
        push(field.key, `${field.label}已录入`, false, field.key, `${field.label}未录入（空值不能当成 0）`);
        continue;
      }
      if (!finiteNumber(value)) {
        push(field.key, `${field.label}是有限数值`, false, field.key, `${field.label}必须是数值，当前是 ${JSON.stringify(value)}`);
        continue;
      }
      push(field.key, `${field.label}是有限数值`, true, field.key, `当前 ${value} ${field.unit}`);
    }

    /*
      量程判定。
        · 挂了仪表 → 按那台仪表的量程；挂了一台台账里没有的表，仍然拒绝（量程无从判定）；
        · 没挂仪表 → 按**缺省量程**（仪表台账里该参数的量程）判边界。
      本期录入界面不再要求选仪表（产品口径：直接录数），但边界判据不能跟着丢：
      越界值仍要被拦住（验收 A10 / A11），只是不再声称用的是哪台表。
    */
    const instrumentFor = (key) => inputsLike.instruments?.find((item) => item.fields?.includes(key));
    for (const field of ENV_FIELDS) {
      const instrument = instrumentFor(field.key);
      let range = null;
      let source = "缺省量程";
      if (instrument?.instrumentId) {
        const catalogEntry = INSTRUMENT_CATALOG.find((item) => item.instrumentId === instrument.instrumentId);
        if (!catalogEntry) {
          push(`${field.key}.instrument`, `${field.label}仪表已登记`, false, "instruments", `仪表 ${instrument.instrumentId} 不在台账里，量程无法判定`);
          continue;
        }
        range = catalogEntry.ranges[field.key] ?? null;
        source = `仪表 ${catalogEntry.instrumentId} 量程`;
      } else {
        const fallback = INSTRUMENT_CATALOG.find((item) => item.ranges[field.key]);
        range = fallback?.ranges[field.key] ?? null;
      }
      const value = inputsLike.inputs?.[field.key];
      if (!range || !finiteNumber(value)) continue;
      push(
        `${field.key}.range`,
        `${field.label}在量程 ${range.min}–${range.max} ${range.unit} 内`,
        value >= range.min && value <= range.max,
        field.key,
        `当前 ${value} ${field.unit}（${source} ${range.min}–${range.max}）`,
      );
    }

    // 湿度 0–100、风速非负、气压为正：字段本身的硬边界
    const humidity = inputsLike.inputs?.relativeHumidityPct;
    if (finiteNumber(humidity)) {
      push("humidity.bound", "相对湿度 0 ≤ RH ≤ 100", humidity >= 0 && humidity <= 100, "relativeHumidityPct", `当前 ${humidity}%`);
    }
    const wind = inputsLike.inputs?.windSpeedMs;
    if (finiteNumber(wind)) {
      push(
        "wind.bound",
        "风速非负（0 是有效静风记录）",
        wind >= 0,
        "windSpeedMs",
        `当前 ${wind} m/s；风速只作采集稳定性记录，不代入含水率模型`,
      );
    }
    const pressure = inputsLike.inputs?.atmosphericPressureHpa;
    if (finiteNumber(pressure)) {
      push("pressure.bound", "大气压 > 0", pressure > 0, "atmosphericPressureHpa", `当前 ${pressure} hPa`);
    }

    // 测量位置
    push("position", "测量位置属于本单测区", !isBlank(inputsLike.position), "position", inputsLike.position || "未填写测量位置");

    // 测量时间：必须能解析，且不得晚于服务端当前时间 60 秒以上
    const parsed = parseMeasuredAt(inputsLike.measuredAt);
    if (!parsed) {
      push("measuredAt", "测量时间已填写", false, "measuredAt", inputsLike.measuredAt ? "测量时间无法解析" : "未填写测量时间");
    } else {
      const drift = parsed.ms - Date.now();
      push(
        "measuredAt.clock",
        "测量时间不晚于服务端时间（允许 60 秒时钟误差）",
        drift <= CLOCK_TOLERANCE_MS,
        "measuredAt",
        drift > CLOCK_TOLERANCE_MS ? `比服务端时间晚 ${Math.round(drift / 1000)} 秒` : `记录于 ${parsed.text}`,
      );
    }

    const ok = checks.every((item) => item.ok);
    return { checks, ok, fieldErrors };
  }

  function validateOrderEnvironment({ orderId, actorId, expectedRevision = null }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    const caps = capabilities(row.id, actorId);
    if (!caps.canValidate) {
      /*
        2026-09-17 起判据是**权限**而不是"是不是项目经理"（用户要求给架构师放开）：
        有 `env:validate` 的账号都能跑校验出版本（沈、史），其余账号仍被挡。
      */
      throw error(
        403,
        "FORBIDDEN",
        isProjectManager(actorId) || allows(actorId, "env:validate")
          ? "已归档工单不能运行校验"
          : "当前账号没有「环境校验」权限，不能生成配置版本",
      );
    }
    const draft = draftRow(row.id);
    if (!draft) throw error(422, "NO_DRAFT", "还没有环境草稿");
    if (expectedRevision !== null && Number(expectedRevision) !== draft.revision) {
      throw error(409, "REVISION_CONFLICT", "环境草稿已变化，请刷新后重试", { retryable: true });
    }
    const parsed = {
      inputs: parseJson(draft.inputs, {}),
      instruments: parseJson(draft.instruments, []),
      position: draft.position,
      measuredAt: draft.measured_at,
    };
    const result = validate(parsed);
    if (!result.ok) {
      throw error(422, "VALIDATION_FAILED", "环境数据未通过校验，未生成配置版本（草稿保留）", {
        fieldErrors: result.fieldErrors,
        checks: result.checks,
        retryable: true,
      });
    }

    const at = nowIso();
    const existing = db.prepare("SELECT COUNT(*) AS n FROM work_order_configs WHERE work_order_id = ?").get(row.id)?.n ?? 0;
    const stamp = shanghaiParts(new Date()).stamp;
    const serial = /-(\d{4})$/.exec(row.order_no)?.[1] ?? "0001";
    const configVersion = `CFG-WO-${stamp}-${serial}-${String(existing + 1).padStart(3, "0")}`;

    inTransaction(db, () => {
      db.prepare("UPDATE work_order_configs SET superseded = 1 WHERE work_order_id = ?").run(row.id);
      db.prepare(
        `INSERT INTO work_order_configs
          (config_version, work_order_id, draft_revision, inputs, instruments, position, measured_at, checks, method_version, validated_by, validated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        configVersion,
        row.id,
        draft.revision,
        JSON.stringify(parsed.inputs),
        JSON.stringify(parsed.instruments),
        parsed.position,
        parseMeasuredAt(parsed.measuredAt)?.iso ?? String(parsed.measuredAt),
        JSON.stringify(result.checks),
        METHOD_VERSION,
        actorId,
        at,
      );
      db.prepare("UPDATE work_order_env_drafts SET needs_revalidate = 0 WHERE work_order_id = ?").run(row.id);
      if (row.status === "待指派") {
        // 没指派就没人有权录数，走到这里说明状态机被绕过了
        throw error(422, "NOT_ASSIGNED", "工单还没有指派负责人，不能生成配置版本");
      }
      log(row.id, "validate", `环境校验通过，生成配置版本 ${configVersion}`, actorId);
    });
    announce("workOrder.configValidated", row.id, actorId, { configVersion });
    return environmentView(row.id);
  }

  /* ------------------------------------------------------------------ *
   * 下发扫描仪（整包下发，PRD §9）
   * ------------------------------------------------------------------ */

  function supersedeDispatches(orderId, reason) {
    const open = db
      .prepare("SELECT * FROM work_order_dispatches WHERE work_order_id = ? AND status IN ('queued','sent','accepted','failed','expired')")
      .all(orderId);
    for (const row of open) {
      db.prepare("UPDATE work_order_dispatches SET status='superseded', reason=? WHERE id=?").run(reason, row.id);
    }
    return open.length;
  }

  function buildBundle({ order, subjects, assignment, config, bundleId, deviceId, issuedAt, expiresAt }) {
    /*
      包的字段顺序固定：摘要算的就是这份响应体的字节，顺序变了摘要就变了。
      未知字段按版本约定兼容，未知主版本由设备侧拒绝（PRD §9.2）。
    */
    const body = {
      schemaVersion: "work-order-bundle/1.0",
      bundleId,
      deviceId,
      workOrder: {
        id: order.id,
        orderNo: order.order_no,
        revision: order.revision,
        assignmentRevision: order.assignment_revision,
        title: order.title,
        plannedStart: order.planned_start,
        plannedEnd: order.planned_end,
        schedulePrecision: order.schedule_precision,
        timeZone: order.time_zone,
        location: order.location,
        createdAt: order.created_at,
        responsible: assignment
          ? {
              assignmentId: assignment.assignmentId,
              roleCode: assignment.leaderRoleCode,
              displayLabel: assignment.leaderLabel,
              members: assignment.members.map((member) => ({
                roleCode: member.roleCode,
                displayLabel: member.label,
                duties: member.duties.map((duty) => duty.code),
              })),
            }
          : null,
        subjects: subjects.map((subject) => ({
          subjectId: subject.subject_id,
          subjectCode: subject.subject_code,
          type: subject.type,
          name: subject.name,
          position: subject.position,
          positionStatus: subject.position_status,
        })),
        requirementsText: order.requirements_text,
      },
      environment: {
        configVersion: config.config_version,
        draftRevision: config.draft_revision,
        airTempC: parseJson(config.inputs, {}).airTempC ?? null,
        relativeHumidityPct: parseJson(config.inputs, {}).relativeHumidityPct ?? null,
        windSpeedMs: parseJson(config.inputs, {}).windSpeedMs ?? null,
        atmosphericPressureHpa: parseJson(config.inputs, {}).atmosphericPressureHpa ?? null,
        measuredAt: config.measured_at,
        position: config.position,
        instruments: parseJson(config.instruments, []),
        validatedAt: config.validated_at,
        methodVersion: config.method_version,
      },
      issuedAt,
      expiresAt,
    };
    const text = JSON.stringify(body, null, 2);
    return { body, text, sha256: sha256(text) };
  }

  /** 命令参数：终端工单页要显示的九项 + 作业绑定 + 整包引用（PRD §9.2 / 接口清单 §4.3） */
  function commandArgs({ order, subjects, assignment, config, bundle, bundleUrl }) {
    const commission = parseJson(order.commission, {});
    const window =
      order.planned_start && order.planned_end && order.planned_start !== order.planned_end
        ? `${order.planned_start} ~ ${order.planned_end}`
        : order.planned_start ?? "";
    return {
      // 终端工单页直接显示的九项
      orderId: order.order_no,
      scheduledAt: window,
      site: order.location.slice(0, 20),
      createdAt: shanghaiParts(new Date(order.created_at)).clock,
      assignee: assignment?.leaderLabel ?? "未指派",
      // 本产品没有部门实体，「责任部门」这一格按岗位口径给出（PRD §5.2）
      department: assignment?.leaderLabel ?? "未指派",
      scope: commission.scope ?? order.title,
      // 新单没有来源风险，也不把历史演示结论灌进来
      risk: "未评估（本单为现场检测委托，无来源风险结论）",
      rescanPlan: "未生成",
      // 作业绑定：终端内部用，工单页不显示
      componentIds: subjects.map((subject) => subject.subject_code),
      subjectIds: subjects.map((subject) => ({ subjectId: subject.subject_id, subjectCode: subject.subject_code })),
      zoneId: null,
      round: "initial",
      scenarioId: null,
      configVersion: config.config_version,
      modelVersion: "DEMO-M02",
      taskRevision: order.revision,
      // 整包：设备凭 URL 下载、按摘要验包后原子应用
      bundleId: bundle.body.bundleId,
      bundleUrl,
      bundleSha256: bundle.sha256,
    };
  }

  function dispatch({ orderId, actorId, deviceId, configVersion = null, expectedRevision = null, idempotencyKey = null }) {
    const row = orderRow(orderId);
    if (!row) throw error(404, "ORDER_NOT_FOUND", `找不到工单 ${orderId}`);
    /*
      先判状态、再判指派、最后判职责：
      顺序反了会把「工单已归档」报成「尚未指派到此工单」，
      排查的人会去查指派记录，而真正的原因是这张单已经终态了。
    */
    if (["已归档", "已暂停"].includes(row.status)) {
      throw error(422, "BAD_STATE", `工单当前是「${row.status}」，不能下发`);
    }
    if (row.assignment_revision === 0) throw error(422, "NOT_ASSIGNED", "工单还没有指派负责人，不能下发");
    const caps = capabilities(row.id, actorId);
    if (!caps.canDispatch) {
      throw error(403, "FORBIDDEN", caps.assigned ? "你在本单没有「扫描仪下发」职责" : "尚未指派到此工单，不能下发");
    }
    if (!devices) throw error(503, "NO_DEVICE_GATEWAY", "设备网关未启用，无法下发");
    if (isBlank(deviceId)) throw error(422, "NO_DEVICE", "必须选择目标扫描仪");

    const config = configVersion ? configRow(row.id, configVersion) : configRow(row.id);
    if (!config) throw error(422, "NO_CONFIG", "本单还没有通过校验的环境配置版本，不能下发");
    if (config.superseded) {
      throw error(422, "CONFIG_SUPERSEDED", `配置版本 ${config.config_version} 已被更新的版本取代，不能下发`);
    }
    if (configVersion && config.config_version !== configRow(row.id)?.config_version) {
      throw error(422, "CONFIG_STALE", "选择的配置版本不是本单最新版本，不能下发");
    }
    const draft = draftRow(row.id);
    if (draft?.needs_revalidate) throw error(422, "NEEDS_REVALIDATE", "环境读数已改动但未重新校验，不能下发旧版本");

    if (expectedRevision !== null && Number(expectedRevision) !== row.revision) {
      throw error(409, "REVISION_CONFLICT", "工单已变化，请刷新后重试", { retryable: true });
    }
    const key = String(idempotencyKey ?? `${row.id}:${deviceId}:${config.config_version}`);
    const replay = db
      .prepare("SELECT * FROM work_order_dispatches WHERE work_order_id = ? AND idempotency_key = ?")
      .get(row.id, key);
    if (replay) return { dispatch: dispatchView(replay), replayed: true, hint: DISPATCH_STATES[replay.status] };

    const ledger = devices.ledger?.(deviceId) ?? null;
    if (!ledger) throw error(422, "UNKNOWN_DEVICE", `设备台账里没有 ${deviceId}，不能作为下发目标`);

    const stamp = shanghaiParts(new Date()).stamp;
    const seq = (db.prepare("SELECT COUNT(*) AS n FROM work_order_dispatches WHERE bundle_id LIKE ?").get(`BND-${stamp}-%`)?.n ?? 0) + 1;
    const bundleId = `BND-${stamp}-${String(seq).padStart(4, "0")}`;
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + DISPATCH_TTL_MS).toISOString();
    const subjects = subjectRows(row.id);
    const assignment = assignmentView(row.id);
    const bundle = buildBundle({ order: row, subjects, assignment, config, bundleId, deviceId, issuedAt, expiresAt });
    const bundleUrl = `/api/work-order-bundles/${bundleId}`;
    const args = commandArgs({ order: row, subjects, assignment, config, bundle, bundleUrl });

    /*
      终端契约有一个**实测踩到的错位**（2026-09-14 真机联调）：
        · 接口清单 §4.1 写的是业务字段放 `payload.args`；
        · 终端代码 `woodpulse/app.py::_cmd_assign_task` 读的却是 `command["payload"]`
          —— 它拿到的 command 就是平台 WS 信封的 payload，
          所以业务体要落在信封 payload 里再嵌一层的 `payload` 上。
      只发 `args` 时真机回 `command.failed / code = missing_order_id`：平台看着
      「命令已发出」，设备一个字都没绑上。两个键给同一份内容，终端不用改。
    */
    const issued = devices.issueCommand(deviceId, {
      type: "assign_task",
      args,
      body: args,
      ttlMs: DISPATCH_TTL_MS,
    });
    const status = issued.pushed ? "sent" : "queued";
    const dispatchId = `dsp-${hex(6)}`;
    db.prepare(
      `INSERT INTO work_order_dispatches
        (id, work_order_id, bundle_id, device_id, command_id, idempotency_key, status, reason, activation_state,
         config_version, order_revision, assignment_revision, body, sha256, created_by, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?)`,
    ).run(
      dispatchId,
      row.id,
      bundleId,
      deviceId,
      issued.command?.commandId ?? null,
      key,
      status,
      config.config_version,
      row.revision,
      row.assignment_revision,
      bundle.text,
      bundle.sha256,
      actorId,
      issuedAt,
      expiresAt,
    );
    log(row.id, "dispatch", `下发扫描仪 ${deviceId}：${DISPATCH_STATES[status]}（包 ${bundleId}）`, actorId);
    announce("workOrder.dispatched", row.id, actorId, { bundleId, deviceId, status });
    return { dispatch: dispatchView(db.prepare("SELECT * FROM work_order_dispatches WHERE id = ?").get(dispatchId)), replayed: false, hint: issued.hint };
  }

  function pendingBundles(deviceId) {
    expireStale();
    const rows = db
      .prepare(
        "SELECT * FROM work_order_dispatches WHERE device_id = ? AND status IN ('queued','sent','accepted') ORDER BY created_at DESC, rowid DESC",
      )
      .all(deviceId);
    return {
      deviceId,
      bundles: rows.map((row) => ({
        bundleId: row.bundle_id,
        workOrderId: row.work_order_id,
        configVersion: row.config_version,
        sha256: row.sha256,
        url: `/api/work-order-bundles/${row.bundle_id}`,
        status: row.status,
        expiresAt: row.expires_at,
      })),
      note: rows.length ? undefined : "暂无平台下发数据",
    };
  }

  /** 设备下载包：只给「明确下发给这台设备」的、仍然有效的包 */
  function readBundle(bundleId, deviceId) {
    expireStale();
    const row = db.prepare("SELECT * FROM work_order_dispatches WHERE bundle_id = ?").get(bundleId);
    if (!row) throw error(404, "BUNDLE_NOT_FOUND", `找不到下发包 ${bundleId}`);
    if (deviceId && row.device_id !== deviceId) {
      throw error(403, "BUNDLE_NOT_FOR_DEVICE", `包 ${bundleId} 不是下发给 ${deviceId} 的`);
    }
    return { row, text: row.body, sha256: row.sha256, status: row.status };
  }

  /** 超过命令有效期且未执行 → expired（不自动补发，重试是人工动作） */
  function expireStale() {
    const now = Date.now();
    const rows = db.prepare("SELECT * FROM work_order_dispatches WHERE status IN ('queued','sent','accepted')").all();
    for (const row of rows) {
      if (Date.parse(row.expires_at) < now) {
        db.prepare("UPDATE work_order_dispatches SET status='expired', reason=? WHERE id=?").run(
          "超过命令有效期且未执行",
          row.id,
        );
      }
    }
  }

  /**
   * 设备回执。
   *
   * 只认「身份 + 命令 + 版本」三者都对得上的回执：
   *   · 设备必须是这条命令的目标设备；
   *   · 包 ID、工单修订、指派修订、配置版本必须与包一致；
   *   · `accepted` 只到「已接收」，`executed` 才到「已应用」；
   *   · 旧回执不许把 executed 退回 accepted，也不许复活已归档/已暂停的工单。
   */
  function consumeDeviceEvents(events = []) {
    const applied = [];
    for (const event of events) {
      const type = String(event?.type ?? "");
      if (!type.startsWith("command.")) continue;
      const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
      const commandId = payload.commandId ?? event.commandId;
      if (!commandId) continue;
      const row = db.prepare("SELECT * FROM work_order_dispatches WHERE command_id = ?").get(String(commandId));
      if (!row) continue;
      if (event.deviceId && event.deviceId !== row.device_id) {
        log(row.work_order_id, "receipt-rejected", `忽略来自 ${event.deviceId} 的回执：命令目标不是这台设备`, null);
        continue;
      }
      const mismatch = [];
      if (payload.bundleId && payload.bundleId !== row.bundle_id) mismatch.push("bundleId");
      if (payload.workOrderRevision != null && Number(payload.workOrderRevision) !== row.order_revision) mismatch.push("workOrderRevision");
      if (payload.assignmentRevision != null && Number(payload.assignmentRevision) !== row.assignment_revision) mismatch.push("assignmentRevision");
      if (payload.configVersion && payload.configVersion !== row.config_version) mismatch.push("configVersion");
      if (mismatch.length) {
        log(row.work_order_id, "receipt-rejected", `回执与包不一致（${mismatch.join("、")}），不推进状态`, null);
        continue;
      }

      const at = payload.appliedAt ?? event.sentAt ?? nowIso();
      if (type === "command.accepted") {
        /*
          设备正在采集别的单时会先说 accepted + 「等待切换工单」，
          这种情况**不提前上报 executed**，也不让平台显示「已应用」（A19）。
        */
        const waiting = String(payload.reason ?? "").includes("等待切换") || payload.activationState === "pending";
        db.prepare("UPDATE work_order_dispatches SET status='accepted', accepted_at=?, reason=?, activation_state=? WHERE id=? AND status IN ('queued','sent')").run(
          at,
          waiting ? String(payload.reason ?? "等待切换工单") : null,
          waiting ? "pending" : "accepted",
          row.id,
        );
        log(row.work_order_id, "dispatch", `扫描仪 ${row.device_id} 已接收命令，正在应用`, null);
      } else if (type === "command.executed") {
        const fresh = db.prepare("SELECT * FROM work_order_dispatches WHERE id = ?").get(row.id);
        if (["superseded"].includes(fresh.status)) {
          log(row.work_order_id, "dispatch", "旧的已应用回执：保留为历史，不更新当前版本", null);
          continue;
        }
        db.prepare("UPDATE work_order_dispatches SET status='executed', executed_at=?, activation_state=? WHERE id=?").run(
          at,
          payload.activationState ?? "active",
          row.id,
        );
        const order = orderRow(row.work_order_id);
        if (order && order.status === "待准备") {
          db.prepare("UPDATE work_orders SET status='待作业', revision=revision+1, updated_at=? WHERE id=?").run(nowIso(), order.id);
        }
        log(row.work_order_id, "dispatch", `扫描仪 ${row.device_id} 已应用工单与环境配置（${row.config_version}）`, null);
      } else if (type === "command.failed") {
        db.prepare("UPDATE work_order_dispatches SET status='failed', failed_at=?, reason=? WHERE id=?").run(
          at,
          String(payload.reason ?? payload.code ?? "设备明确失败"),
          row.id,
        );
        log(row.work_order_id, "dispatch", `下发失败：${payload.reason ?? payload.code ?? "设备明确失败"}（工单与读数保留）`, null);
      } else {
        continue;
      }
      applied.push({ bundleId: row.bundle_id, type, orderId: row.work_order_id });
      announce("workOrder.dispatchState", row.work_order_id, null, { bundleId: row.bundle_id, type });
    }
    return applied;
  }

  /**
   * 终端「从平台获取」环境记录（《交付平台-新增接口清单》§4.4）。
   *
   * 给的是**已校验通过的那份环境记录**（不是配置下发），字段名按终端契约：
   * 气压换算成 kPa 另外给一份 `airPressureKpa`，同时保留平台内部的 hPa。
   * 拿不到的项直接不出现 —— 终端对缺失项沿用当前滑钮值，不会被清零。
   */
  function deviceEnvironment(deviceId) {
    const row = db
      .prepare(
        "SELECT * FROM work_order_dispatches WHERE device_id = ? AND status IN ('executed','accepted','sent','queued') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(deviceId);
    if (!row) {
      return { deviceId, source: "none", note: "本设备还没有收到平台下发的工单环境记录" };
    }
    const config = db.prepare("SELECT * FROM work_order_configs WHERE config_version = ?").get(row.config_version);
    if (!config) return { deviceId, source: "none", note: `配置版本 ${row.config_version} 已不存在` };
    const inputs = parseJson(config.inputs, {});
    const instruments = parseJson(config.instruments, []);
    const payload = {
      deviceId,
      orderId: row.work_order_id,
      orderNo: orderRow(row.work_order_id)?.order_no ?? null,
      configVersion: config.config_version,
      source: "manual-instrument",
    };
    if (inputs.airTempC != null) payload.airTempC = inputs.airTempC;
    if (inputs.relativeHumidityPct != null) payload.relativeHumidityPct = inputs.relativeHumidityPct;
    if (inputs.windSpeedMs != null) payload.windSpeedMs = inputs.windSpeedMs;
    if (inputs.atmosphericPressureHpa != null) {
      payload.atmosphericPressureHpa = inputs.atmosphericPressureHpa;
      payload.airPressureKpa = Number((inputs.atmosphericPressureHpa / 10).toFixed(2));
    }
    if (config.position) payload.position = config.position;
    if (config.measured_at) payload.measuredAt = config.measured_at;
    const firstInstrument = instruments.find((item) => item?.instrumentId);
    if (firstInstrument) payload.instrumentId = firstInstrument.instrumentId;
    return payload;
  }

  /** 设备台账里可用于下发的目标（页面选目标扫描仪用） */
  function deviceTargets() {
    if (!devices) return [];
    return (devices.devices?.() ?? []).map((device) => ({
      deviceId: device.deviceId,
      // 在线判定沿用网关那一份：数据断流算离线，WS 另给 socketConnected
      online: device.link?.state === "online",
      linkState: device.link?.state ?? "unknown",
      socketConnected: Boolean(device.link?.socketConnected),
      connectionState: device.connectionState,
      appVersion: device.appVersion ?? null,
      capabilities: device.capabilities ?? {},
      pendingCommands: device.pendingCommands ?? 0,
    }));
  }

  return {
    trigger,
    list,
    detail,
    detailFor,
    accounts,
    assign,
    deleteOrder,
    setStatus,
    saveDraft,
    validateOrderEnvironment,
    validate,
    dispatch,
    dispatches: (orderId) => dispatchRows(orderId).map(dispatchView),
    pendingBundles,
    readBundle,
    consumeDeviceEvents,
    deviceEnvironment,
    deviceTargets,
    expireStale,
    capabilities,
    displayLabel,
    dutiesOf,
    isProjectManager,
    _internal: { orderRow, subjectRows, assignmentRow, draftRow, configRow, log },
  };
}
