/**
 * 知识库模块 · 常量（无 React，不进 fast-refresh 组件文件）
 *
 * 唯一依据：docs/design/视觉设计规范-v1.0.md + src/styles/tokens.css
 *   - 分类配色只用 §5.1 palette：蓝 / 青为主，绿、黄只在语义需要时出现
 *   - 图表网格、坐标轴文字、Tooltip 底色一律引用 tokens 的同一组值
 *
 * 组件里不允许再写死这些色值，一律从这里取。
 */

import type { KnowledgeCategory } from "./logic";

/** §5.1 ECharts palette（与 src/pages/MumaiDashboard/design.ts 的 CHART.palette 同源） */
export const KB_CHART = {
  palette: ["#4ea8ff", "#5de4ff", "#39d5a3", "#f2b84b", "#ff5c70"],
  grid: "rgba(130, 180, 230, 0.08)",
  axisLine: "rgba(130, 180, 230, 0.24)",
  axisText: "#647990",
  tooltipBg: "#0b1726",
  tooltipBorder: "rgba(78, 168, 255, 0.25)",
  textPrimary: "#eaf3ff",
  textSecondary: "#aabbd0",
  textTertiary: "#70849c",
} as const;

/**
 * 资料类别 → 图表系列色。
 * 六类资料用「蓝 + 青 + 绿 + 黄」四种即可区分，红不参与——红色只表达风险，
 * 不是分类装饰色。
 */
export const CATEGORY_COLOR: Record<KnowledgeCategory, string> = {
  巡检报告: "#4ea8ff",
  构件档案: "#5de4ff",
  维修反馈: "#39d5a3",
  方法文档: "#f2b84b",
  场景索引: "#8fb4ff",
  天气档案: "#70c4ff",
};

/** 类别固定顺序（图例、分布图、筛选器共用一套顺序，避免每次渲染顺序漂移） */
export const KB_CATEGORIES: KnowledgeCategory[] = [
  "巡检报告",
  "构件档案",
  "维修反馈",
  "方法文档",
  "场景索引",
  "天气档案",
];

export function categoryColor(category: string): string {
  return CATEGORY_COLOR[category as KnowledgeCategory] ?? KB_CHART.palette[0];
}

/** 上传入口：按扩展名判定是否可按文本真读 */
export const TEXT_EXTENSIONS = ["md", "markdown", "txt", "csv", "json", "log"] as const;

/**
 * 解析方式说明：文本类真读，其它类型只登记清单 + 按经验比值估算字符数。
 * 页面必须把这个区别显示出来，不能把估算值说成解析结果。
 */
export const PARSE_MODE_NOTE = {
  text: "浏览器内按文本真读：字符数 = String.length，分块由分块器真算",
  estimated: "不解析内容：只读文件名 / 大小 / 类型，字符数 = 字节数 × 0.32 估算，分块为估算值",
} as const;

/** 估算字符数的经验比值（非文本文件） */
export const ESTIMATED_CHARS_PER_BYTE = 0.32;

/** 文件大小显示 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 千分位 */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 毫秒 → 秒，用于步骤耗时 */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 队列状态色（只表达状态语义，不做装饰） */
export const QUEUE_TONE: Record<string, "ok" | "warn" | "info" | "muted" | "danger"> = {
  待解析: "muted",
  解析中: "info",
  已分块: "info",
  已向量化: "info",
  已入库: "ok",
  解析失败: "danger",
};
