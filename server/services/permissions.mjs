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

  /*
   * 场景模型上传与成果提交是同一个动作：`scene.submit`。
   * 上传本身是「POST /api/files + scene.submit 绑定工单」两步，闸门在后者 ——
   * 所以这里**不**另立 `scene.upload` 动作（登记了却没有 handler 的动作码
   * 会在调用时抛 404 NO_HANDLER，看起来像功能没做）。
   */
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
/*
  沈 / 史 = 全部动作，但**场景上传除外**：上传高斯模型是饶（全栈开发工程师）的活，
  另外两个角色只能选择已上传的模型显示。写成显式剔除而不是把 scene.upload
  从 ALL 里漏掉 —— 漏掉会在下次新增动作时又把它带回来。
*/
const ALL = [...new Set(Object.values(ACTION_PERMISSION))].filter((item) => item !== "*");
const ALL_BUT_UPLOAD = ALL.filter((item) => item !== "scene:upload" && item !== "scene:submit");

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

/*
 * 工单指派与扫描仪下发（PRD-工单指派与扫描仪下发-v1.0 §6.2）
 *
 * 这两个权限**故意不放进 `ACTION_PERMISSION`**：那张表的取值会被 `ALL` 收走，
 * 一放进去，人工智能架构师（shi）就跟着拿到指派权了 —— 而 PRD 明令
 * 「人工智能架构师、管理员或小木智能体不能因为现有『全权限』集合而获得指派权」。
 * 所以指派权只按项目经理这一个岗位显式授予：
 *   workorder:assign   指派 / 更换负责人、参与人员与职责
 *   workorder:operate  本期属于项目经理的流程动作：运行环境校验、暂停/恢复/验收/归档
 * 被指派员工的写权限不在这里 —— 那是**按单**判定的（services/work-orders.mjs 的职责校验）。
 */
const WORK_ORDER_PERMISSIONS = ["workorder:assign", "workorder:operate"];

/*
 * 环境录入（PRD 3.1 的"录入环境记录"这一步）。
 *
 * ── 为什么单列一个权限（用户 2026-09-17 口径）────────────────────────
 * 用户原话：「我，shi账号下，应该是有权限填写环境记录与配置校验录入数据的，
 * 你干脆给我shi账号权限拉满得了」。
 *
 * 原来能不能录环境读数是**按岗/按单**判的（`work-orders.mjs` 的
 * `manager || duties.has("environment_entry")`）：人工智能架构师既不是负责人、
 * 默认职责里也没有「环境录入」，于是他在工单页看到的是灰掉的录入表单 ——
 * 而 PRD 的岗位表里，环境数据本来就是"现场谁先到谁先录"的一件事。
 *
 * 现在把它写成一条**明确的平台权限**（而不是再往职责字典里塞一条）：
 * 有 `env:entry` 就能录数、有 `env:validate` 就能跑校验出版本，
 * 与"是不是项目经理""有没有被指派"解耦。沈、史各拿一条，饶仍然只有 `env:ack`
 * （接收配置），马没有 —— 与 PRD 2.1 的可执行操作列一致。
 */
const ENV_ENTRY_PERMISSION = ["env:entry"];

export const ROLE_PERMISSIONS = {
  // 沈：项目经理。全量业务权限 + 工单指派权 + 环境录入
  shen: [
    ...new Set([
      ...ALL_BUT_UPLOAD,
      ...ARCHIVE_PERMISSIONS,
      ...CONSOLE_PERMISSIONS,
      ...KNOWLEDGE_PERMISSIONS,
      ...WORK_ORDER_PERMISSIONS,
      ...ENV_ENTRY_PERMISSION,
    ]),
  ],
  /*
    史：人工智能架构师。**除指派权与模型上传外全给**（用户 2026-09-17「拉满」）：
      · 加上 `workorder:operate` —— 运行环境校验、暂停/恢复/验收/归档这些流程动作，
        架构师在演示里是实际在操作平台的人（`work-orders.mjs` 的 capabilities
        按这条权限放行）；
      · 加上 `env:entry` —— 录环境读数（本次诉求的原话）；
      · 仍然**不给** `workorder:assign`：PRD §6.2 明令「人工智能架构师、管理员或
        小木智能体不能因为现有『全权限』集合而获得指派权」，而且演示动线里
        "别人那边选择人员调度"正是由项目经理做的，给了反而看不到协同。
      · 仍然**不给** `scene:submit` / `scene:upload`：高斯模型上传只有全栈开发工程师能做。
  */
  shi: [
    ...new Set([
      ...ALL_BUT_UPLOAD,
      ...ARCHIVE_PERMISSIONS,
      ...CONSOLE_PERMISSIONS,
      ...KNOWLEDGE_PERMISSIONS,
      "workorder:operate",
      ...ENV_ENTRY_PERMISSION,
    ]),
  ],
  rao: [
    "env:ack",
    "scan:capture",
    "data:upload",
    "scene:submit",
    "scene:upload",
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
