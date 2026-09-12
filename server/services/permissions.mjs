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
};

/** 四个账号 → 权限集合（与 src/pages/MumaiDashboard/auth.ts 的 ROLE_ACTIONS 同源） */
const ALL = [...new Set(Object.values(ACTION_PERMISSION))].filter((item) => item !== "*");

/*
 * 归档没有走命令总线（它是「读字节 + 写清单登记值」，不是实体状态机），
 * 所以这张表里没有对应的 action，权限名要单独列出来。
 * 与前端一致：沈 / 史 有归档校验与导出，饶 / 马 没有。
 *
 * `console:admin` 同理：排练控制台会重建会话、回滚整场状态，
 * 属于「管理员排练控制」而不是日常岗位动作（PRD §11：沈和史是否具有管理员权限
 * 由配置指定；这里按演示口径给这两位）。
 */
const ARCHIVE_PERMISSIONS = ["archive:verify", "archive:export"];
const CONSOLE_PERMISSIONS = ["console:admin"];

export const ROLE_PERMISSIONS = {
  // 沈 / 史：评审要求「项目经理和人工智能架构师权限最大」
  shen: [...new Set([...ALL, ...ARCHIVE_PERMISSIONS, ...CONSOLE_PERMISSIONS])],
  shi: [...new Set([...ALL, ...ARCHIVE_PERMISSIONS, ...CONSOLE_PERMISSIONS])],
  rao: [
    "env:ack",
    "scan:capture",
    "data:upload",
    "scene:submit",
    "deployment:receive",
    "sample:review",
    "training:submit",
    "knowledge:search",
  ],
  ma: [
    "map:save",
    "point:config",
    "mission:monitor",
    "mission:dispatch",
    "sample:review",
    "sample:collect",
    "revisit:plan",
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
