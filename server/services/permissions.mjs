/**
 * 共享服务 · 动作权限表
 *
 * 这张表是**服务端**的权威副本：前端 auth.ts 的权限表负责把没权限的按钮置灰，
 * 服务端这张表负责真正拦住请求（PRD §12「所有写接口由后端校验登录、动作权限、
 * session 与前置状态」）。两边分开是有意的 —— 前端可以被绕过，服务端不行。
 *
 * 权限名与前端 `Permission` 联合类型逐字一致，评审 F04 指出的
 * 「有接收动作却进不去配置所在页面」属于**页面读取**问题，不在本表处理：
 * 读取权限在前端的 ROUTE_READ 表里，写入权限在这里。
 */

/** 每个动作要求哪一个权限（动作名 = `<实体>.<动作>`，与 PRD §7 的状态机同名） */
export const ACTION_PERMISSION = {
  "environment.publish": "env:validate",
  "environment.receive": "env:ack",

  "mission.create": "mission:dispatch",
  "mission.ack": "mission:dispatch",
  "mission.pause": "mission:monitor",
  "mission.resume": "mission:monitor",
  "mission.cancel": "mission:monitor",
  "mission.complete": "mission:dispatch",

  "map.save": "map:save",

  "scene.submit": "scene:submit",
  "scene.check": "scene:publish",
  "scene.publish": "scene:publish",

  "artifact.build": "package:deliver",
  "artifact.publish": "package:deliver",
  "artifact.receipt": "deployment:receive",

  /*
    投屏不设动作权限：四个角色都可能上台讲解，谁当持有人由服务端的
    「同一时刻只有一个持有人」规则保证（PRD §7 / §10），不是靠角色。
    这里用 "*" 表示「任意已登录账号」，与「动作没登记」区分开。
  */
  "projection.set": "*",
  "projection.hold": "*",

  /* ---- 数据与知识中心（PRD-数据与知识中心-v1.0 §13 权限矩阵） ----
     读取权限不在这张表里：它由 /api/knowledge/* 的 requireKnowledgeRead 判定。
     这张表只管写动作。 */
  "asset.register": "knowledge:manage",
  "asset.revise": "knowledge:manage",
  "asset.updateMetadata": "knowledge:manage",
  "asset.setInclusion": "knowledge:index",
  "asset.delete": "knowledge:manage",
  "knowledge.sync": "knowledge:index",
  "knowledge.retry": "knowledge:index",
  "knowledge.cancel": "knowledge:index",
  "knowledge.activateVersion": "knowledge:index",
  "knowledge.configure": "knowledge:index",
};

/** 四个账号 → 权限集合（与 src/pages/MumaiDashboard/auth.ts 的 ROLE_ACTIONS 同源） */
const ALL = [...new Set(Object.values(ACTION_PERMISSION))].filter((item) => item !== "*");

/*
 * 数据与知识中心新增的三个细分权限（PRD §13）：
 *   knowledge:read    查看总览、资产与图谱 —— 四个业务角色都可查看其所属项目
 *   knowledge:manage  导入 / 更新资产、编辑分类与绑定对象
 *   knowledge:search  证据检索 —— 沈、史、饶；马本期仍按现有权限控制，未经调整不开放
 * 复用已有 knowledge:index（变更纳入规则、启动 / 取消任务、重试、切换索引）。
 */
const KNOWLEDGE_PERMISSIONS = ["knowledge:read", "knowledge:search", "knowledge:manage", "knowledge:index"];

const ARCHIVE_PERMISSIONS = ["archive:verify", "archive:export"];
const CONSOLE_PERMISSIONS = ["console:admin"];

export const ROLE_PERMISSIONS = {
  // 沈 / 史：评审要求「项目经理和人工智能架构师权限最大」
  shen: [...new Set([...ALL, ...ARCHIVE_PERMISSIONS, ...CONSOLE_PERMISSIONS, ...KNOWLEDGE_PERMISSIONS])],
  shi: [...new Set([...ALL, ...ARCHIVE_PERMISSIONS, ...CONSOLE_PERMISSIONS, ...KNOWLEDGE_PERMISSIONS])],
  rao: [
    "env:ack",
    "scan:capture",
    "data:upload",
    "scene:submit",
    "deployment:receive",
    "sample:review",
    "training:submit",
    "knowledge:search",
    // 饶负责导入与核对资料（PRD §13：导入 / 更新资产用 knowledge:manage + data:upload）
    "knowledge:read",
    "knowledge:manage",
  ],
  ma: [
    "map:save",
    "point:config",
    "mission:monitor",
    "mission:dispatch",
    "sample:review",
    "sample:collect",
    "revisit:plan",
    /*
      马只读数据与知识中心。
      PRD §13 明确「证据检索 knowledge:search 给沈、史、饶；马本期仍按现有权限控制，
      未经调整不开放」，所以这里只补 read，不补 search / manage / index。
    */
    "knowledge:read",
  ],
};

/** 账号 → 拼音登录名（登录接口用；与前端 ACCOUNT_LOGIN 一致） */
export const ACCOUNT_LOGIN = {
  shen: "shen",
  shi: "shi",
  rao: "rao",
  ma: "mayutian",
};

export const ACCOUNT_NAME = {
  shen: "沈",
  shi: "史",
  rao: "饶",
  ma: "马昱天",
};

export const DEMO_PASSWORD = "123456";

export function permissionsOf(accountId) {
  return ROLE_PERMISSIONS[accountId] ?? [];
}

export function allows(accountId, permission) {
  return permissionsOf(accountId).includes(permission);
}

/** 校验某账号能不能执行某动作；返回 null 表示通过，否则返回拒绝原因 */
export function checkAction(accountId, action) {
  if (!(action in ACTION_PERMISSION)) {
    return { code: "UNKNOWN_ACTION", message: `未登记的动作 ${action}` };
  }
  const permission = ACTION_PERMISSION[action];
  if (permission === "*") return null;
  if (!allows(accountId, permission)) {
    return {
      code: "FORBIDDEN",
      message: `账号 ${accountId} 无「${permission}」权限，不能执行 ${action}`,
      permission,
    };
  }
  return null;
}
