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
  /** 场景发布（POST /scenes/{id}/publish），全栈上传后由架构师检查并发布 */
  | "scene:publish"
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
  | "sample:collect";

/** 权限中文名（PRD 用语，用于置灰提示；不带感叹号） */
export const PERMISSION_LABEL: Record<Permission, string> = {
  "env:validate": "环境校验",
  "dataset:groupcheck": "分组检查",
  "evaluation:compare": "新旧评估对比",
  "order:review": "工单审核",
  "archive:verify": "归档完整性校验",
  "archive:export": "归档报告输出",
  "assistant:invoke": "小木调用",
  "knowledge:search": "资料检索",
  "knowledge:index": "索引发布",
  "scene:publish": "场景发布",
  "training:run": "训练演示",
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
 * 因此沈 / 史直接取全量；饶 / 马严格按 PRD 2.1「可执行操作」一列给，
 * 不额外放权。逐条对应关系见每行注释里的 PRD 出处。
 */
const ROLE_ACTIONS: Record<string, readonly Permission[]> = {
  /** 沈 · 项目经理（PRD 2.1：环境校验、分组检查、新旧评估对比、工单审核、交付摘要校验） */
  shen: ALL_PERMISSIONS,

  /** 史 · 人工智能架构师（PRD 2.1：小木调用、资料检索、场景发布、训练演示、封装下发、多模态分析） */
  shi: ALL_PERMISSIONS,

  /** 饶 · 全栈开发工程师（PRD 2.1：手持参数确认、原始数据上传、场景成果提交、更新包接收与回验） */
  rao: [
    "env:ack", // PRD 3.1 / S02–S03：饶接收环境配置并返回 ack
    "scan:capture", // PRD 3.4 / S09–S11：手持参数确认与采集
    "data:upload", // PRD 3.4 / S13：原始数据包提交
    "scene:submit", // PRD 3.3 / S06–S07：重建成果提交，状态「待检查」
    "deployment:receive", // PRD 3.6 / S18：接收更新包、执行模拟更新、读取设备版本
    "sample:review", // PRD 3.5 / S14：饶负责硬件端数据复核（饱和、掉帧）
    "training:submit", // PRD 3.6 / S15：准备部署与恢复版本，提交本次数据集
    "knowledge:search", // PRD 5.1 / S06：文件来源与归档资料核对
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
  ],
};

/* ------------------------------------------------------------------ *
 * 3. 页面 → 所需权限
 * ------------------------------------------------------------------ */

/**
 * 一级导航每一项的进入条件。
 *
 * 读写都在这里：左侧导航过滤、直接输入 URL 的拦截共用同一张表，
 * 不会出现「导航里没有、但地址栏能进」的缺口。
 *
 * 之所以用 `anyOf` 而不是给每个角色单独列页面：与 PRD 2.1 的口径一致 ——
 * 页面可见性由「该角色能执行的操作」推导，权限集合是唯一事实来源。
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
  //   样本审核（sample:review）刻意不作为进入条件 —— 马也承担「查样本来源和位置」
  //   （PRD 3.5），但本页主流程是设备采集与排查，与 PRD 2.1 给马的
  //   「建图巡检」工作区不符，因此马不进这一页。
  "/hardware": ["scan:capture", "data:upload"],
  // 固件及模型：版本配置 / 数据集 / 训练验证 / 更新交付 / 融合分析 —— 算法与交付侧
  //   饶要能提交训练任务、接收并回验更新包（PRD 3.6），沈 / 史 有全量权限
  "/firmware": ["training:submit", "deployment:receive"],
  // 知识库：资料检索与索引
  "/knowledge": ["knowledge:search"],
  // 报告归档：交付摘要校验与报告输出
  "/archive": ["archive:verify"],
};

/** 取某个角色的可执行操作集合 */
export function actionsOf(accountId: string): readonly Permission[] {
  return ROLE_ACTIONS[accountId] ?? [];
}

/** 该角色是否具备某个操作权限 */
export function allows(accountId: string, permission: Permission): boolean {
  return actionsOf(accountId).includes(permission);
}

/** 该角色是否可进入某条路由；未登记的路径视为不可进入 */
export function allowsPath(accountId: string, pathname: string): boolean {
  const required = ROUTE_PERMISSION[pathname];
  if (!required) return false;
  return required.length === 0 || required.some((item) => allows(accountId, item));
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
