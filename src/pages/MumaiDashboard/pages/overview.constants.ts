/**
 * 任务总览（`/`）专用常量
 *
 * 单独一个文件而不是写在 `Overview.tsx` 里，是为了满足 eslint 的
 * `react-refresh/only-export-components`：一个 `.tsx` 里导出了组件，
 * 就不要再导出常量。
 *
 * 这里只放「页面级派生量」——工单等级/状态到语义色的映射、设计稿
 * （`docs/design/china-dashboard-concept.png`）底部的品牌 slogan 与
 * 演示位置。所有业务数字仍然从 `../seed/scenario` 现算，不在此写死。
 */

import type * as echarts from "echarts/core";
import { CHART } from "../design";
import type { Tone } from "../lib";
import type { Order, OrderStatus } from "../seed/types";
import type { SiteStatus } from "../seed/sites";
import { STATUS_TEXT } from "../map/status";

/**
 * 点位状态中文名 → key 的反查表。
 *
 * 图表图例的 `formatter` 只拿得到「名字」这一项，而名字就是 `STATUS_TEXT`
 * 的值，所以用它反查回 key 再取数量。**不在这里另写一份中文名** ——
 * 地图、页面图例、图表三处必须永远是同一个口径。
 */
export const STATUS_KEY_BY_TEXT: Record<string, SiteStatus> = Object.fromEntries(
  (Object.keys(STATUS_TEXT) as SiteStatus[]).map((key) => [STATUS_TEXT[key], key]),
);

/**
 * 设计稿底部状态条左侧的 slogan。
 * 属于文案资产而非业务数据，与 `scenario.ts` 里的业务种子分开放。
 */
export const OVERVIEW_SLOGAN = "让古建被看见 · 让历史有未来";

/**
 * 大屏展示用的实时位置（设计稿底部状态条）。
 * 当前状态为「演示」：数值取自 `data.ts:37` 示例寺的点位坐标（WGS84），
 * 与 PRD 1.2 的 source_mode 口径一致，不作为实时定位结论使用。
 * 真实演示时由车辆/手持设备上送后替换。
 */
export const DEMO_GEO_POSITION = { lat: 31.2304, lon: 121.4737 };

/** 工单风险等级 → 语义色（取值来自种子里的 level 字面量） */
export const ORDER_LEVEL_TONE: Record<Order["level"], Tone> = {
  高风险: "danger",
  中风险: "warn",
  低风险: "info",
};

/** 工单状态机（`design.ts` ORDER_STATUS） → 语义色 */
export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  草稿: "muted",
  待复核: "warn",
  待处理: "warn",
  处理中: "info",
  待验收: "warn",
  已完成: "ok",
  已关闭: "ok",
};

/**
 * 新流程工单状态（PRD-工单指派与扫描仪下发-v1.0 §8.1）→ 语义色。
 *
 * 与 `ORDER_STATUS_TONE` 分开：那一张是演示回放老工单的词汇
 * （草稿 / 待复核 / 处理中 / 已完成…），这一张是本期的
 * 待指派 → 待准备 → 待作业 → 作业中 → 待验收 → 已归档（另加已暂停）。
 * 两套状态同时出现在工单档案页，各自取各自的色，不互相将就。
 */
export const WORK_ORDER_STATUS_TONE: Record<string, Tone> = {
  待指派: "warn",
  待准备: "warn",
  待作业: "info",
  作业中: "info",
  待验收: "warn",
  已归档: "ok",
  已暂停: "muted",
};

/* ------------------------------------------------------------------ *
 * 渐进披露（规范 §3.3）：一个 Panel 最多三层，明细默认收起
 *
 * 数量都是「大屏演示够用」的下限，不是分页：收起态保证首屏不出现
 * 第 4 行之后的工单、第 4 条之后的待办与事件。
 * ------------------------------------------------------------------ */

/** 「风险与工单」工单列表默认可见行数（表头不占行）。当前选中的工单始终可见 */
export const ORDER_PREVIEW_ROWS = 4;

/** 「待办与最近事件」默认可见的待办条数 */
export const TODO_PREVIEW_ITEMS = 3;

/** 「待办与最近事件」默认可见的最近事件条数 */
export const EVENT_PREVIEW_ITEMS = 3;

/** 右侧「风险与工单」顶部的三个计数口径 */
export const ORDER_COUNTERS: { key: string; label: string; tone: Tone; match: (order: Order) => boolean }[] = [
  { key: "high", label: "高风险", tone: "danger", match: (order) => order.level === "高风险" },
  { key: "pending", label: "待处理", tone: "warn", match: (order) => order.status === "待处理" || order.status === "待复核" },
  { key: "running", label: "处理中", tone: "info", match: (order) => order.status === "处理中" },
];

/**
 * 全页共用的图表基底。
 *
 * 每张图只需要给 `series` 与自己的坐标轴/图例，**配色、Tooltip 外观、文字字体
 * 由这里统一注入**，避免四张图各写一份样式后慢慢跑偏（规范 §10 P2
 * 「统一 ECharts Palette 与 Tooltip」）。
 */
export const CHART_BASE: echarts.EChartsCoreOption = {
  /* 展开成新数组：CHART.palette 是 `as const` 的只读元组，ECharts 要可变数组 */
  color: [...CHART.palette],
  textStyle: {
    fontFamily: "var(--font-data-mixed)",
    fontSize: 13,
    color: CHART.axisText,
  },
  tooltip: {
    backgroundColor: CHART.tooltipBg,
    borderColor: CHART.tooltipBorder,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: "#eaf3ff", fontSize: 13, fontFamily: "var(--font-data-mixed)" },
    extraCssText: "border-radius:2px;box-shadow:none;",
  },
};

/**
 * GPU 负载档位 → 图表用色（PRD §9.5 的四个档位 + 未知）。
 *
 * 取值来自规范 §1.3 的状态色：空闲用中性灰（它不是一个「好」状态，
 * 只是没在跑）、低负载绿、中负载黄、高负载红。**未知也是灰**，
 * 但界面上必须配文字（「负载未知」），不能只靠颜色区分。
 */
export const LOAD_COLOR: Record<"idle" | "low" | "medium" | "high" | "unknown", string> = {
  idle: "#687a91",
  low: "#39d5a3",
  medium: "#f2b84b",
  high: "#ff5c70",
  unknown: "#465a70",
};
