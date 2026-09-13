/**
 * 数据与知识中心 · 来源定位的文案
 *
 * 依据：PRD §4.3（各类资产的可检索内容与来源定位）、§16.3 R03（来源定位必须能打开）。
 *
 * 与 `server/domains/knowledge-contract.mjs` 的 `describeLocator` 保持同一套措辞。
 * 为什么要在前端再写一遍：服务端在 Node 里跑，前端模块（含 React / DOM 依赖）
 * 不能被 Node 直接导入（PRD §15 明确禁止），所以两边各留一份**逐字一致**的实现，
 * 而不是把服务端的 .mjs 塞进前端包。
 */

import type { Locator } from "../types";

export function describeLocatorText(locator: Locator | null | undefined): string {
  if (!locator) return "无来源定位";
  switch (locator.kind) {
    case "page":
      return `第 ${locator.page} 页 · ${locator.paragraph ? `第 ${locator.paragraph} 段` : locator.region ?? "整页"}`;
    case "section":
      return `${locator.section ?? "正文"} · 第 ${locator.paragraph} 段`;
    case "sheet":
      return `${locator.sheet} · ${locator.range}`;
    case "image":
      return `${locator.imageId}${locator.region ? ` · ${locator.region}` : ""}`;
    case "timecode":
      return `${locator.start}–${locator.end}${locator.keyframe ? ` · ${locator.keyframe}` : ""}`;
    case "workorder":
      return `${locator.orderNo} · ${locator.node}`;
    case "log":
      return `${locator.deviceId} · ${locator.from}–${locator.to} · 第 ${locator.line} 行`;
    case "record":
      return `${locator.entityId} · revision ${locator.revision}`;
    default:
      return "自定义定位";
  }
}

/** 定位类型的中文名：详情抽屉里显示「页码 / 时间码 / 单元格范围」这类口径 */
export function locatorKindLabel(kind: string): string {
  const map: Record<string, string> = {
    page: "页码与段落",
    section: "章节与段落",
    sheet: "工作表与单元格范围",
    image: "图片与标注区域",
    timecode: "时间码与关键帧",
    workorder: "工单编号与记录节点",
    log: "设备与时间范围",
    record: "业务实体与 revision",
  };
  return map[kind] ?? kind;
}
