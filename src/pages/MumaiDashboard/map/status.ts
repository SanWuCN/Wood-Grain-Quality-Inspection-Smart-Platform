/**
 * 地图点位状态 → 视觉常量
 *
 * 单独放一个文件，是为了让 SiteMarker.tsx 只导出组件
 * （react-refresh 的 only-export-components 规则要求）。
 *
 * 色值直接取《木脉智检视觉设计规范 v1.0》§5.2「地图视觉优先级」：
 *   已巡检 #39D5A3 / 工单 #F2B84B / 风险 #FF5C70；
 *   「已采集」规范未单列，用唯一 UI 主色 #4EA8FF。
 * 红黄绿在这里是**业务语义色**（风险 / 工单 / 完成），不是装饰色。
 */

import type { SiteStatus } from "../data";

export const STATUS_COLOR: Record<SiteStatus, string> = {
  collected: "#4EA8FF",
  inspected: "#39D5A3",
  risk: "#FF5C70",
  workorder: "#F2B84B",
};

export const STATUS_TEXT: Record<SiteStatus, string> = {
  collected: "已采集",
  inspected: "已巡检",
  risk: "有风险",
  workorder: "有工单",
};

/** 图例顺序 */
export const STATUS_ORDER: SiteStatus[] = ["collected", "inspected", "risk", "workorder"];
