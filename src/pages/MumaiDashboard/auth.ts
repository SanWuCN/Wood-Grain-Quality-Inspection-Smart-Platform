/**
 * 木脉智检 · 账号与会话权限
 *
 * 依据（不自己发挥）：
 *   - PRD 2.1「四个账号」表：账号 / 默认工作区 / 可执行操作
 *   - PRD 2.2「导航与页面」：左侧一级导航八项
 *   - PRD 3.x / 7.4 / 12：各按钮动作的责任人（环境校验 → 沈；ack → 饶；
 *     场景发布 → 史；封装下发 → 史；接收与执行模拟更新、读取设备版本 → 饶；
 *     任务下发 → 史（发布）/ 马（监视、接管）；演示快照 → 管理员）
 *   - 第二章剧本 S01–S23：每句台词里的操作人
 *
 * 本文件只放「数据 + 纯函数」，不放任何 React 组件，
 * 以免触发 eslint 的 react-refresh/only-export-components。
 */

import { ACCOUNTS, NAV_ITEMS, type Account } from "./design";

/* ------------------------------------------------------------------ *
 * 1. 权限清单
 * ------------------------------------------------------------------ */

/**
 * 全平台可授予的动作权限。
 *
 * 命名规则：`对象:动作`，对象与 PRD 的实体名一致（environment / scene /
 * package / deployment / mission / map / dataset / training / archive …），
 * 便于和 PRD 14.2 的必需接口表逐条对照。
 */
export type Permission =
  /* —— PRD 2.1 沈 · 项目经理：工单与审核 —— */
  /**
   * 环境记录录入（PRD 3.1「录入环境记录」）。
   *
   * 与「环境校验」分开：录入是**填读数**，校验是**跑判定并出版本**。
   * 用户口径（2026-09-17）：「我，shi账号下，应该是有权限填写环境记录与
   * 配置校验录入数据的」—— 架构师要能录数，所以这条权限给沈与史。
   * 服务端同一份权限名在 `server/services/permissions.mjs`，两边的判据一致。
   */
  | "env:entry"
  /** 环境校验（PATCH/POST /checks/environment），通过后生成不可变配置版本 */
  | "env:validate"
  /** 分组检查（POST /checks/group），读取训练/验证/测试的物理样本 ID 求交集 */
  | "dataset:groupcheck"
  /** 新旧评估对比（POST /evaluations/compare） */
  | "evaluation:compare"
  /** 工单审核：确认草稿、状态流转、验收与归档（PATCH /work-orders/{id}） */
  | "order:review"
  /** 交付摘要校验：归档完整性校验与报告输出（POST /archives） */
  | "archive:verify"
  | "archive:export"
  /* —— PRD 2.1 史 · 人工智能架构师：平台总览 —— */
  /** 小木调用（POST /assistant/messages） */
  | "assistant:invoke"
  /** 资料检索与索引发布（POST /knowledge/search、/knowledge/indexes） */
  | "knowledge:search"
  | "knowledge:index"
  /**
   * 数据与知识中心（PRD-数据与知识中心-v1.0 §13）细分的读取与资产管理权限。
   *
   * 为什么要把读取单独拆出来：这一页的读取对象是「本项目的资料清单」，
   * 与「能不能改」是两件事。评审 F04 的教训就是把页面读取和写动作混在一张表里，
   * 结果有接收动作的人进不去配置所在页面。
   */
  | "knowledge:read"
  | "knowledge:manage"
  /** 场景发布（POST /scenes/{id}/publish），全栈上传后由架构师检查并发布 */
  | "scene:publish"
  /**
   * 场景模型上传（POST /api/files + scene.submit）。
   *
   * 只有全栈开发工程师（饶）能上传：其他人只能**选择已上传的模型**来显示。
   * 与 `scene:submit` 分开放，是因为沈 / 史在前端持有 ALL_PERMISSIONS ——
   * 若沿用 `scene:submit`，项目经理与架构师会一并拿到上传权，与需求不符。
   */
  | "scene:upload"
  /** 训练演示（POST /training-jobs） */
  | "training:run"
  /** 封装下发（POST /packages、/packages/{id}/deliver） */
  | "package:deliver"
  /** 多模态分析（POST /fusions） */
  | "fusion:run"
  /* —— PRD 2.1 饶 · 全栈开发工程师：采集与交付 —— */
  /** 环境配置接收并返回 ack（POST /configs/{id}/ack） */
  | "env:ack"
  /** 手持参数确认与原始数据上传（POST /scan-batches、POST /uploads） */
  | "scan:capture"
  | "data:upload"
  /** 场景成果提交（POST /scenes），提交后处于「待检查」 */
  | "scene:submit"
  /** 更新包接收与回验：模拟更新、读取设备版本（POST /deployments、/receipt） */
  | "deployment:receive"
  /** 训练任务提交（选数据版本与配置，POST /training-jobs 的提交侧） */
  | "training:submit"
  /* —— PRD 2.1 马 · 具身智能工程师：建图巡检 —— */
  /** 地图检查与保存（地图版本保存） */
  | "map:save"
  /** 点位配置（巡检点位序列） */
  | "point:config"
  /** 巡检监视与任务下发（POST /missions、/missions/{id}/pause|cancel） */
  | "mission:monitor"
  | "mission:dispatch"
  /** 复巡计划（引用地图版本、观察点与视角书签） */
  | "revisit:plan"
  /* —— PRD 3.5 人工审核按职责分配 —— */
  /** 样本审核：饶查信号、马查来源与位置、沈查标签与分组、史确认版本 */
  | "sample:review"
  /** 数据集冻结（POST /datasets/{id}/freeze），冻结后训练只引用该版本 */
  | "dataset:freeze"
  /** 参考样本采集（异常排查完成后的补采任务） */
  | "sample:collect"
  /** 排练控制台：新建演示会话、捕获与恢复阶段快照、导出诊断包（PRD §11） */
  | "console:admin";

/** 权限中文名（PRD 用语，用于置灰提示；不带感叹号） */
export const PERMISSION_LABEL: Record<Permission, string> = {
  "env:entry": "环境记录录入",
  "env:validate": "环境校验",
  "dataset:groupcheck": "分组检查",
  "evaluation:compare": "新旧评估对比",
  "order:review": "工单审核",
  "archive:verify": "归档完整性校验",
  "archive:export": "归档报告输出",
  "assistant:invoke": "小木调用",
  "knowledge:search": "资料检索",
  "knowledge:index": "索引发布",
  "knowledge:read": "查看数据与知识中心",
  "knowledge:manage": "导入与维护资产",
  "scene:publish": "场景发布",
  "scene:upload": "场景模型上传",
  "training:run": "训练执行",
  "package:deliver": "封装下发",
  "fusion:run": "多模态分析",
  "env:ack": "环境配置接收并返回 ack",
  "scan:capture": "手持参数确认与采集",
  "data:upload": "原始数据上传",
  "scene:submit": "场景成果提交",
  "deployment:receive": "更新包接收与回验",
  "training:submit": "训练任务提交",
  "map:save": "地图检查与保存",
  "point:config": "点位配置",
  "mission:monitor": "巡检监视与接管",
  "mission:dispatch": "任务下发",
  "revisit:plan": "复巡计划",
  "sample:review": "样本审核",
  "dataset:freeze": "数据集冻结",
  "sample:collect": "参考样本采集",
  "console:admin": "排练控制台",
};

/** 全部权限，顺序与上面的联合类型一致；权限矩阵的自检基准 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.keys(
  PERMISSION_LABEL,
) as Permission[];

/* ------------------------------------------------------------------ *
 * 2. 角色 → 权限集合
 * ------------------------------------------------------------------ */

/**
 * 四个账号的权限集合。
 *
 * 用户要求「项目经理和人工智能架构师权限最大，所有都可以操作」，
 * 后来（2026-09-17）又明确：「我，shi账号下，应该是有权限填写环境记录与配置校验
 * 录入数据的，你干脆给我 shi 账号权限拉满得了」。
 *
 * 因此沈 / 史在前端持有全量权限，例外只有两条**刻意的**：
 *   · `scene:submit` / `scene:upload` —— 高斯模型上传只有饶能做（见下）；
 *   · 指派权不在前端这张表里（它由服务端的 `workorder:assign` 判定，
 *     架构师没有，PRD §6.2 明令）。
 * 新增的 `env:entry`（环境记录录入）加进 `PERMISSION_LABEL` 即自动落到沈 / 史头上，
 * 与「拉满」的口径一致。
 */
const ROLE_ACTIONS: Record<string, readonly Permission[]> = {
  /*
    沈 / 史在前端持有全部权限，但**场景模型上传只给饶**：
    `scene:submit` 在这个数组里也要拿掉，否则「上传模型」按钮会对他们出现。
    服务端同样只认 `scene:submit` → 饶（见 server/services/permissions.mjs），
    前端去掉按钮只是不误导，真正的闸门在服务端。
  */
  shen: ALL_PERMISSIONS.filter((item) => item !== "scene:submit" && item !== "scene:upload"),

  shi: ALL_PERMISSIONS.filter((item) => item !== "scene:submit" && item !== "scene:upload"),

  /** 饶 · 全栈开发工程师（PRD 2.1：手持参数确认、原始数据上传、场景成果提交、更新包接收与回验） */
  rao: [
    "env:ack", // PRD 3.1 / S02–S03：饶接收环境配置并返回 ack
    "scan:capture", // PRD 3.4 / S09–S11：手持参数确认与采集
    "data:upload", // PRD 3.4 / S13：原始数据包提交
    "scene:submit", // PRD 3.3 / S06–S07：重建成果提交，状态「待检查」
    "scene:upload", // 高斯模型上传：只有全栈开发工程师可以上传（需求明确）
    "deployment:receive", // PRD 3.6 / S18：接收更新包、执行模拟更新、读取设备版本
    "sample:review", // PRD 3.5 / S14：饶负责硬件端数据复核（饱和、掉帧）
    "training:submit", // PRD 3.6 / S15：准备部署与恢复版本，提交本次数据集
    "knowledge:search", // PRD 5.1 / S06：文件来源与归档资料核对
    // 数据与知识中心（PRD §13）：饶负责导入资料、核对来源与绑定对象
    "knowledge:read",
    "knowledge:manage",
  ],

  /** 马 · 具身智能工程师（PRD 2.1：地图检查、点位配置、巡检监视、样本位置复核、复巡计划） */
  ma: [
    "map:save", // PRD 2.1 地图检查 / S05：检查无误后保存地图版本
    "point:config", // PRD 2.1 点位配置 / S11：巡检点位避开手持作业区
    "mission:monitor", // PRD 2.1 巡检监视 / S11：监视位置、路径与障碍物状态
    "mission:dispatch", // PRD 2.1 巡检 + S11：具身确认接管条件后发布任务
    "sample:review", // PRD 3.5：马查样本来源和位置
    "sample:collect", // PRD 2.1 样本位置复核 / S13：取出参考样块、登记批次
    "revisit:plan", // PRD 2.1 复巡计划 / S22：把 Z04 观察点加入复巡计划
    /*
      数据与知识中心只读（PRD §13）。
      「证据检索 knowledge:search 给沈、史、饶；马本期仍按现有权限控制，未经调整不开放」——
      所以这里只补 read，不补 search / manage / index。
    */
    "knowledge:read",
  ],
};

/* ------------------------------------------------------------------ *
 * 3. 页面 → 所需权限
 * ------------------------------------------------------------------ */

/**
 * 一级导航每一项的**写**权限：能对这一页的对象执行什么动作。
 *
 * 这张表不再决定「能不能进这一页」—— 那由下面的 `ROUTE_READ` 决定。
 * 评审 F04 的现象正是把两者混在一起造成的：饶有 `env:ack`（接收配置），
 * 却因为缺 `order:review` 而进不去配置所在的工单页；马同样进不去样本审核与孪生。
 * PRD §2 的原话是「页面权限不等于写入权限：按 read、review、publish、receive
 * 分别控制」，所以读写必须拆成两张表。
 */
export const ROUTE_PERMISSION: Record<string, readonly Permission[]> = {
  // 任务总览：四人共用的当轮任务与通道摘要，不做限制
  "/": [],
  // 工单档案：工单与审核工作区
  "/orders": ["order:review"],
  // 建图巡检：地图检查、点位配置、巡检监视
  "/mapping": ["mission:monitor"],
  // 数字孪生：场景发布（史）、场景成果提交（饶）
  "/twin": ["scene:publish", "scene:submit"],
  // 硬件详情：采集作业 / 异常排查 / 硬件监看 —— 设备侧工作区（饶）
  "/hardware": ["scan:capture", "data:upload"],
  // 固件及模型：版本配置 / 数据集 / 训练验证 / 更新交付 / 融合分析 —— 算法与交付侧
  //   饶要能提交训练任务、接收并回验更新包（PRD 3.6），沈 / 史 有全量权限
  "/firmware": ["training:submit", "deployment:receive"],
  // 知识库：资料检索与索引
  "/knowledge": ["knowledge:search"],
  // 报告归档：交付摘要校验与报告输出
  "/archive": ["archive:verify"],
  // 排练控制台：新建会话与回滚快照会改整场状态，属管理员排练控制（PRD §11）
  "/console": ["console:admin"],
};

/**
 * 页面**读取**资格：谁能打开这一页（只看，不代表能改）。
 *
 * 依据 PRD §2「四人均可读取本次工单及与自身交接有关的记录。马可只读孪生并审核样本，
 * 饶可只读工单并接收配置」。表里没登记的路径回退到 `ROUTE_PERMISSION`（写权限），
 * 保持其余页面原有行为不变 —— 这是一次有针对性的放权，不是把权限模型推倒重来。
 */
export const ROUTE_READ: Record<string, readonly string[]> = {
  // 工单是全部交接的上下文：饶要在这里接收环境配置（评审 F04）
  "/orders": ["shen", "shi", "rao"],
  // 孪生：马要只读场景并配合测区/样本位置审核（评审 F04）
  "/twin": ["shen", "shi", "rao", "ma"],
  // 数据集与样本审核页签在固件及模型页：马承担「查样本来源和位置」（评审 F04）
  "/firmware": ["shen", "shi", "rao", "ma"],
  /*
    数据与知识中心：四个业务角色都可查看其所属项目（PRD §13「查看总览、资产与图谱
    knowledge:read → 四个业务角色」）。写入与检索仍按各自的权限表判定，
    页面内部会把没有权限的按钮置灰并说明原因。
  */
  "/knowledge": ["shen", "shi", "rao", "ma"],
};

/** 取某个角色的可执行操作集合 */
export function actionsOf(accountId: string): readonly Permission[] {
  return ROLE_ACTIONS[accountId] ?? [];
}

/** 该角色是否具备某个操作权限 */
export function allows(accountId: string, permission: Permission): boolean {
  return actionsOf(accountId).includes(permission);
}

/**
 * 该角色是否可进入某条路由（**读取**判定）。
 *
 * 先看 `ROUTE_READ`（显式的读取资格），没有登记再回退到写权限表 ——
 * 于是「能改这一页」一定也「能看这一页」，而反过来不成立。
 * 未登记的路径视为不可进入。
 */
export function allowsPath(accountId: string, pathname: string): boolean {
  const readers = ROUTE_READ[pathname];
  if (readers) return readers.includes(accountId);

  const required = ROUTE_PERMISSION[pathname];
  if (!required) return false;
  return required.length === 0 || required.some((item) => allows(accountId, item));
}

/**
 * 该角色进入这一页是不是**只读**的（能看、但这一页没有任何他能执行的动作）。
 *
 * 用于在页面上挂一条「只读查阅」的说明 —— 评审 F04 要求「允许协作查阅，
 * 仅限制修改动作」，那么放权之后必须让人知道自己在这里只能看，
 * 而不是对着一排灰按钮猜原因。
 */
export function isReadOnlyPath(accountId: string, pathname: string): boolean {
  if (!allowsPath(accountId, pathname)) return false;
  const required = ROUTE_PERMISSION[pathname];
  if (!required || required.length === 0) return false;
  return !required.some((item) => allows(accountId, item));
}

/**
 * 该地址是不是本平台登记过的一级路由。
 *
 * 必须和 `allowsPath` 分开：`allowsPath` 对「地址不存在」与「有地址但没权限」
 * 都返回 false，可这两件事对用户完全不同，提示语也该不同。
 *
 * 为什么需要它：路由表里没有兜底项时，访问一个未登记的地址（例如拆页前的
 * `#/adapt`）会让 React Router 一个 route 都不匹配 —— 连外壳都不挂载，
 * 整页没有 DOM，现象是纯黑屏、只有 console 里一行 "No routes matched"。
 * Shell 靠这个函数把「不存在」交给 routes.tsx 的 `*` 兜底去渲染，而不是
 * 误报成「当前角色无此页面权限」。
 *
 * `/present` 是展示窗口专用路由，不进权限表、由 Shell 单独放行，所以算登记过。
 */
const PATHLESS_ROUTES: readonly string[] = ["/present"];

export function isRegisteredPath(pathname: string): boolean {
  return pathname in ROUTE_PERMISSION || PATHLESS_ROUTES.includes(pathname);
}

/** 该角色可见的一级导航（按 ROUTE_PERMISSION 过滤后再渲染） */
export function navFor(accountId: string): readonly (typeof NAV_ITEMS)[number][] {
  return NAV_ITEMS.filter((item) => allowsPath(accountId, item.path));
}

/** 无权限时的中性说明，可直接放进 title 或行内小字 */
export function permissionHint(permission: Permission): string {
  return `当前角色无「${PERMISSION_LABEL[permission]}」权限`;
}

/* ------------------------------------------------------------------ *
 * 4. 账号与登录凭据
 * ------------------------------------------------------------------ */

/** 账号名即姓名拼音；密码为演示用固定口令（PRD 2.1：比赛环境提供固定账号快捷登录） */
export const DEMO_PASSWORD = "123456";

/** 姓名拼音 → 账号（唯一凭据表，登录页快捷入口与登录校验共用） */
export const ACCOUNT_LOGIN: Record<string, string> = {
  shen: "shen",
  shi: "shi",
  rao: "rao",
  ma: "mayutian",
};

/**
 * 兼容写法：这几个拼音一律视为有效账号名。
 *
 * `ma` 是姓氏拼音，`mayutian` 是剧本第二章 S19 里唯一的全名「马昱天」的全拼。
 * 其余三位剧本只给了姓氏，因此账号名就是姓氏拼音，与上表一致。
 * 兜底写法集中在这里，不散落到匹配逻辑里。
 */
const LOGIN_ALIASES: Record<string, string> = {
  shen: "shen",
  shi: "shi",
  rao: "rao",
  ma: "ma",
};

/** 默认落地账号（PRD 2.1 第 1 行） */
export const DEFAULT_ACCOUNT_ID = "shen";

/** 会话在 localStorage 里的键 */
export const SESSION_STORAGE_KEY = "mumai.session";

/**
 * 按账号名或姓名拼音找账号。
 *
 * 匹配顺序：登录名精确匹配 → 兼容写法（别名的首选账号）→ 账号 id →
 * 登录名前缀 → 显示名拼音前缀。首尾空格与大小写都不敏感，
 * 手输 `Ma`、` ma `、`mayutian` 都能进同一个账号。
 */
export function resolveAccount(input: string): Account | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;

  const byLogin = ACCOUNTS.find((item) => ACCOUNT_LOGIN[item.id] === value);
  if (byLogin) return byLogin;

  const alias = LOGIN_ALIASES[value];
  const byAlias = ACCOUNTS.find((item) => item.id === alias);
  if (byAlias) return byAlias;

  const byId = ACCOUNTS.find((item) => item.id === value);
  if (byId) return byId;

  const byLoginPrefix = ACCOUNTS.find((item) =>
    (ACCOUNT_LOGIN[item.id] ?? "").startsWith(value),
  );
  if (byLoginPrefix) return byLoginPrefix;

  return ACCOUNTS.find((item) => item.name.toLowerCase().startsWith(value));
}

/** 取账号的默认工作区路由（PRD 2.1「默认工作区」一列） */
export function workspacePath(accountId: string): string {
  return ACCOUNTS.find((item) => item.id === accountId)?.page ?? "/";
}

/** 按拼音登录名取账号（登录页快捷入口用） */
export function accountByLogin(login: string): Account | undefined {
  return ACCOUNTS.find((item) => ACCOUNT_LOGIN[item.id] === login);
}

/* ------------------------------------------------------------------ *
 * 5. 会话读写（localStorage，刷新后保持）
 * ------------------------------------------------------------------ */

/** 落盘的会话：只存 accountId，姓名 / 角色 / 默认工作区始终从 ACCOUNTS 现算 */
export type MumaiSession = { accountId: string; login: string; at: string };

export type LoginResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "unknown-account" | "wrong-password" };

/** localStorage 里可能出现的脏数据：只认「有字符串 accountId 的对象」 */
function isSessionShape(value: unknown): value is { accountId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "accountId" in value &&
    typeof (value as { accountId?: unknown }).accountId === "string"
  );
}

/**
 * 读取当前会话。
 *
 * 兜底（题目要求）：localStorage 为空、JSON 解析失败、结构不对、
 * accountId 不在四个账号里 —— 一律返回 null，按未登录处理，绝不抛异常。
 */
export function readSession(): MumaiSession | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSessionShape(parsed)) return null;

  const account = ACCOUNTS.find((item) => item.id === parsed.accountId);
  if (!account) return null;

  return {
    accountId: account.id,
    login: ACCOUNT_LOGIN[account.id] ?? account.id,
    at: "",
  };
}

/** 写入会话（登录成功后调用；同步落盘，紧接着跳转也读得到） */
export function writeSession(accountId: string, at: string): void {
  const account = ACCOUNTS.find((item) => item.id === accountId);
  if (!account) return;
  const session: MumaiSession = {
    accountId: account.id,
    login: ACCOUNT_LOGIN[account.id] ?? account.id,
    at,
  };
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* 隐私模式下写入失败：本次会话仍在内存里生效，不阻断登录 */
  }
}

/** 退出登录：清掉会话键，回到登录页 */
export function clearSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* 同上，忽略 */
  }
}

/**
 * 会话是否有效：键不存在时算「未登录」，不算脏数据
 * （首次访问不该被当成异常处理，也不该在控制台留下痕迹）。
 */
export function hasSessionKey(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** 兜底：会话键存在但读不出有效会话（坏 JSON / 结构不对 / 未知 accountId）时清掉 */
export function dropInvalidSession(): void {
  if (!hasSessionKey()) return;
  if (readSession()) return;
  clearSession();
}

/**
 * 登录校验。
 *
 * PRD 2.1：比赛环境提供固定账号快捷登录，密码由部署配置设置。
 * 演示版把口令固定为 123456 并只存在前端；这里不打印、不回显密码。
 */
export function login(loginName: string, password: string): LoginResult {
  const account = resolveAccount(loginName);
  if (!account) return { ok: false, reason: "unknown-account" };
  if (password !== DEMO_PASSWORD) return { ok: false, reason: "wrong-password" };
  return { ok: true, account };
}
