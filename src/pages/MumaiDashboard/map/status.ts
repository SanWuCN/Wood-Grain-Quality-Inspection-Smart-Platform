/**
 * 地图点位状态 → 视觉常量
 *
 * 单独放一个文件，是为了让 SiteMarker.tsx 只导出组件
 * （react-refresh 的 only-export-components 规则要求）。
 *
 * 色值直接取《木脉智检视觉设计规范 v1.0》§5.2「地图视觉优先级」：
 *   已检测 #39D5A3 / 工单 #F2B84B / 风险 #FF5C70；
 *   「已勘察」规范未单列，用唯一 UI 主色 #4EA8FF。
 * 红黄绿在这里是**业务语义色**（风险 / 工单 / 完成），不是装饰色。
 *
 * 文案口径与用户原话对齐：去现场做过勘察 → 已勘察；做过检测 → 已检测；
 * 检测出问题 → 有风险；已关联工单或巡检任务 → 有工单/任务（点了能进界面）。
 * 图例与点位一一对应，因此这里不再额外造第五种状态。
 */

import type { SiteStatus } from "../data";
import { SITE_STATUS_ORDER } from "../seed/sites";

export const STATUS_COLOR: Record<SiteStatus, string> = {
  collected: "#4EA8FF",
  inspected: "#39D5A3",
  risk: "#FF5C70",
  workorder: "#F2B84B",
};

export const STATUS_TEXT: Record<SiteStatus, string> = {
  collected: "已勘察",
  inspected: "已检测",
  risk: "有风险",
  /** 含「有巡检任务」：两种点位点击后都会离开地图进到对应界面 */
  workorder: "有工单/任务",
};

/** 点击行为的一句话说明，详情浮层与图例共用，避免两处文案不一致 */
export const STATUS_ACTION: Record<SiteStatus, string> = {
  collected: "勘察建档已完成，点击看勘察记录",
  inspected: "检测结论已归档，点击看检测记录",
  risk: "已发现风险，点击看风险与处置建议",
  workorder: "已关联工单或巡检任务，点击直接进入对应界面",
};

/** 图例顺序：从「刚去过」到「已建单」，与点位状态一一对应。
 *  顺序取自种子（`seed/sites.ts`），图例 / 详情浮层 / 点位渲染共用同一份。 */
export const STATUS_ORDER: SiteStatus[] = SITE_STATUS_ORDER;
