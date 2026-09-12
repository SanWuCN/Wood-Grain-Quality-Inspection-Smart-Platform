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

/** 四人账号（PRD 2.1） */
export const ACCOUNTS = [
  { id: "shen", name: "沈", role: "项目经理", workspace: "工单与审核", page: "/orders" },
  { id: "shi", name: "史", role: "人工智能架构师", workspace: "平台总览", page: "/" },
  { id: "rao", name: "饶", role: "全栈开发工程师", workspace: "采集与交付", page: "/adapt" },
  { id: "ma", name: "马", role: "具身智能工程师", workspace: "建图巡检", page: "/mapping" },
] as const;

/** 一级导航（PRD 2.2：控制在八项） */
export const NAV_ITEMS = [
  { key: "overview", label: "任务总览", path: "/" },
  { key: "orders", label: "工单档案", path: "/orders" },
  { key: "mapping", label: "建图巡检", path: "/mapping" },
  { key: "twin", label: "数字孪生", path: "/twin" },
  { key: "adapt", label: "检测适配", path: "/adapt" },
  { key: "knowledge", label: "知识库", path: "/knowledge" },
  { key: "archive", label: "报告归档", path: "/archive" },
  { key: "console", label: "演示控制", path: "/console" },
] as const;

/** 检测适配下的六个页签（PRD 2.2） */
export const ADAPT_TABS = [
  { key: "capture", label: "采集" },
  { key: "triage", label: "异常排查" },
  { key: "dataset", label: "数据集" },
  { key: "training", label: "训练验证" },
  { key: "delivery", label: "更新交付" },
  { key: "fusion", label: "融合分析" },
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
