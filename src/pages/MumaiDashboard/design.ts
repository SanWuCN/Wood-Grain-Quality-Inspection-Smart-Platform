/**
 * 木脉智检 · 视觉规范常量（JS 侧取色入口）
 *
 * 唯一来源：docs/design/视觉设计规范-v1.0.md §9 的 CSS Token，
 * 与 src/styles/tokens.css 一一对应（值必须保持一致，禁止另定一套色）。
 *
 * 分工：
 *   - CSS 里一律写 var(--primary) 这类 token，不写死色值
 *   - 只能写内联样式 / SVG 属性（stroke、fill、gradient stop）的地方，从这里取
 *
 * 规范要点（§1.2 / §1.3 / §5.1）：
 *   - #4EA8FF 是唯一 UI 主色：导航、按钮、当前选中、关键数据
 *   - #5DE4FF 只用于地图描边、飞线、光柱、扫描光效
 *   - 绿 / 黄 / 红只表达业务状态，禁止当装饰色
 */

/** 规范 §9 token 的 JS 镜像 */
export const COLORS = {
  /** 唯一 UI 主色 #4EA8FF —— 选中态、关键数据、按钮 */
  primary: "#4ea8ff",
  /** 主色 hover */
  primaryHover: "#69b7ff",
  /** 科技光效色 #5DE4FF —— 只给地图 / 飞线 / 光柱 / 扫描 */
  glowCyan: "#5de4ff",

  /** 面板填充（原 panelFill，收敛到主色） */
  panelFill: "#4ea8ff",
  /** 面板描边 / 次级线条（原 panelStroke，收敛到主色） */
  panelStroke: "#4ea8ff",
  /** 描边透明度：规范 §4.1 Normal 态 rgba(78,168,255,.16) ≈ .3 的视觉重量 */
  panelStrokeOpacity: 0.3,

  /** 地图侧壁扫光、底座光环（§5.2 扫描线） */
  glow: "#5de4ff",
  /** 侧壁底色（§1.1 BG-04） */
  wallBottom: "#102037",
  /** 地图轮廓（§5.2 边缘高亮） */
  boundary: "#63cbff",

  /** 文字（§1.4） */
  textPrimary: "#eaf3ff",
  textSecondary: "#aabbd0",
  textMuted: "#70849c",

  /** 背景（§1.1） */
  background: "#030812",
  pageBackground: "#060d18",

  /** 状态色（§1.3，业务语义专用） */
  ok: "#39d5a3",
  warn: "#f2b84b",
  danger: "#ff5c70",
  info: "#4ea8ff",
} as const;

/** 图表（§5.1 ECharts palette 与图表元素） */
export const CHART = {
  /** 单图主色系列不超过 3 种：默认只用蓝 + 青 */
  palette: ["#4ea8ff", "#5de4ff", "#39d5a3", "#f2b84b", "#ff5c70"],
  /** 网格线 */
  grid: "rgba(130, 180, 230, 0.08)",
  /** 坐标轴 / 基线 */
  axisLine: "rgba(130, 180, 230, 0.24)",
  /** 坐标轴文字 */
  axisText: "#647990",
  /** 工具栏背景：禁止白底 */
  tooltipBg: "#0b1726",
  /** 工具栏边框 */
  tooltipBorder: "rgba(78, 168, 255, 0.25)",
  /** 风险区间标注（danger 的图表内低饱和用法） */
  dangerFill: "rgba(255, 92, 112, 0.14)",
  dangerStroke: "rgba(255, 92, 112, 0.45)",
} as const;

/** 面板斜切（§4.1：全平台只有一套 —— 右上 + 左下 8px） */
export const PANEL_CUT = 8;

/** 顶栏高度（现行值，规范未另定义） */
export const HEADER_HEIGHT = 85;
/** 顶栏 SVG 基准尺寸 */
export const HEADER_VIEWBOX = "0 0 1920 85";

/**
 * 四人账号（PRD 2.1「四个账号」表）
 *
 *   id       账号标识（内部用，等于姓氏拼音）
 *   name     界面显示名。剧本只给出「沈 / 史 / 饶 / 马」的姓氏，
 *            唯一的全名出现在第二章 S19（沈：马昱天配合记录补扫位置），
 *            因此只有马带全名，其余三位保持剧本口径的姓氏。
 *   login    账号名 = 姓名拼音（登录页用）。马取剧本全名「马昱天」的
 *            全拼 mayutian，同时 auth.ts 里保留 ma 作为兜底输入。
 *   page     默认工作区路由（PRD 2.1 默认工作区一列）
 *
 * 密码统一 123456，凭据与校验逻辑在 auth.ts，不写在这里。
 */
export const ACCOUNTS = [
  { id: "shen", login: "shen", name: "沈", role: "项目经理", workspace: "工单与审核", page: "/orders" },
  { id: "shi", login: "shi", name: "史", role: "人工智能架构师", workspace: "平台总览", page: "/" },
  // 饶的默认工作区是「硬件详情」而不是已下线的 /adapt：
  // 「检测适配」拆成 /hardware + /firmware 时漏改了这一个字段，
  // 结果 rao 一登录就被 workspacePath() 送到一个不存在的路由 —— 纯黑屏。
  // 改完请连同 auth.ts 的 ROUTE_PERMISSION 一起核对（这个字段必须落在
  // 该角色 allowsPath 为真的路径上，否则登录后立刻吃一个「无权限」）。
  { id: "rao", login: "rao", name: "饶", role: "全栈开发工程师", workspace: "采集与交付", page: "/hardware" },
  { id: "ma", login: "mayutian", name: "马昱天", role: "具身智能工程师", workspace: "建图巡检", page: "/mapping" },
];

/** 账号类型（auth.ts 与顶栏 / 登录页共用） */
export type Account = (typeof ACCOUNTS)[number];

/**
 * 一级导航（PRD 2.2：控制在八项）。
 *
 * 排练控制台刻意**不在这里** —— 它是管理员排练时用的，不是业务岗位的日常动作
 * （PRD §11「管理员排练控制独立于日常岗位」）。放在顶栏的账号菜单旁边，
 * 只有具备 console:admin 的角色看得见，导航栏保持业务八项不变。
 *
 * icon 一列来自 UI 视觉素材 v2.0（2026-09-13）：按 PRD §5「公共导航与工具栏：
 * 使用 8 枚 nav 图标，统一大小、标签基线和当前项」接入，PRD §4 规定导航图标默认
 * 20px。八个 key 与素材包的 8 枚 nav-* 图标一一对应，没有重复用同一枚。
 *
 * nav-capture 用在「硬件详情」是按页面语义而非图标字面：这一页的主体是采集相机、
 * 二维响应与设备状态，取景框语义比齿轮准确。页面内部的参数调整控件仍走
 * action-settings，两者不混用（PRD §3.3 迁移表：参数调整与系统设置分开）。
 */
export const NAV_ITEMS = [
  { key: "overview", label: "任务总览", path: "/", icon: "nav-overview" },
  { key: "orders", label: "工单档案", path: "/orders", icon: "nav-orders" },
  { key: "mapping", label: "建图巡检", path: "/mapping", icon: "nav-mapping" },
  { key: "twin", label: "数字孪生", path: "/twin", icon: "nav-twin" },
  { key: "hardware", label: "硬件详情", path: "/hardware", icon: "nav-capture" },
  { key: "firmware", label: "固件及模型", path: "/firmware", icon: "nav-model" },
  { key: "knowledge", label: "知识库", path: "/knowledge", icon: "nav-knowledge" },
  { key: "report", label: "报告归档", path: "/archive", icon: "nav-report" },
] as const;

/**
 * 检测适配下的六个页签（PRD 2.2）
 *
 * icon 一列是 UI 视觉素材 v2.0 的业务图标，按 PRD §5「固件及模型：清洗、分组、
 * 适配、校验使用业务图标」接入，页签尺寸用 16px（PRD §4「工具栏 16 至 20px」）。
 * 对应关系：
 *   采集     → nav-capture        取景框（与一级导航「硬件详情」同一枚，同语义复用）
 *   异常排查 → status-warning     告警（异常排查是状态语义，用 status-* 系列）
 *   数据集   → biz-sample-group   物理样本分组（CHANGELOG：九点密集结构改为三组分离主块）
 *   训练验证 → biz-package-verify 包裹与校验（验证结果的校验语义）
 *   更新交付 → biz-material-adapt 样本片与调参滑杆（材料适配/版本适配）
 *   融合分析 → biz-multimodal     图像与波形汇入结果点（多模态融合）
 */
export const ADAPT_TABS = [
  { key: "capture", label: "采集", icon: "nav-capture" },
  { key: "triage", label: "异常排查", icon: "status-warning" },
  { key: "dataset", label: "数据集", icon: "biz-sample-group" },
  { key: "training", label: "训练验证", icon: "biz-package-verify" },
  { key: "delivery", label: "更新交付", icon: "biz-material-adapt" },
  { key: "fusion", label: "融合分析", icon: "biz-multimodal" },
] as const;

/** 工单状态机（PRD 3.8） */
export const ORDER_STATUS = [
  "草稿",
  "待复核",
  "待处理",
  "处理中",
  "待验收",
  "已关闭",
] as const;
