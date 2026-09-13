/**
 * 数据与知识中心 · 绘图常量
 *
 * 唯一依据：docs/design/视觉设计规范-v1.0.md §5.1（ECharts Palette 与图表元素）
 * 与 src/styles/tokens.css。组件里不允许再写死这些色值，一律从这里取。
 *
 * 为什么这些值必须在 JS 里再写一份：ECharts 的 option 对象没法写 CSS 变量。
 * 除此之外的样式一律走 knowledge.css 的 var(--token)。
 *
 * 改造前的 knowledge/constants.ts 里还有「分类配色、解析方式说明、队列状态色」，
 * 那些属于旧页面（浏览器内上传 + 按文件大小估算分块）的模型，随页面重写一并删除。
 */

/** §5.1 ECharts palette：默认只用蓝 + 青，绿 / 黄 / 红仅在语义需要时出现 */
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
  /** 画布底色透明：交给面板自己的背景，避免 ECharts 默认白底 */
  canvasBg: "transparent",
} as const;

/**
 * 关系图的类别顺序（图例与配色按这个顺序取 palette）。
 *
 * 顺序是有意的：先对象、再资产、最后索引版本 —— 恰好也是业务关联视图里
 * 「这些资料与哪些工程对象有关」的阅读顺序。固定顺序还能让配色在数据刷新前后
 * 保持不变：按返回顺序取色的话，多出一个类别就会让整张图的颜色换一遍。
 */
export const GRAPH_CATEGORIES = ["对象", "设备", "工单", "任务", "资料", "内容", "分块组", "索引版本"] as const;
