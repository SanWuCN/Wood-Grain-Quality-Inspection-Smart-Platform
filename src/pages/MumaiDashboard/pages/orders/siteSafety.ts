export type SiteSafetyLocation = {
  readonly key: "boundary" | "zone" | "entrance" | "assembly";
  readonly label: string;
  readonly value: string | null;
  readonly state: "已登记" | "待现场标定";
  readonly note: string;
};

function freezeLocations(items: SiteSafetyLocation[]): readonly Readonly<SiteSafetyLocation>[] {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
}

/**
 * 现场安全登记来自脚本 (3) 第 55、60、64、65 段喵
 * 文档只明确了边界与入口，没有给出应急集合点的具体方位，因此保持待标定喵
 *
 * 批注 `木柱四周出入口，设备摆放区`（ull N，锚在第 65 段）要求把「木柱四周的
 * 出入口」与「设备摆放区」登记进来：第 65 段管前者（出入口，已登记），
 * 第 64 段管后者 —— 原文「以四柱外围为界，设置警戒带或围栏，**划分人员作业区和
 * 设备暂存区**；门口放置警示牌」。所以：
 *   · 出入口沿用原有登记项，不另起一条重复项；
 *   · 新增一条 `zone`「区域划分」，值逐字取自第 64 段，不自行改写区域名。
 */
export const SITE_SAFETY_RECORD = Object.freeze({
  status: "隔离到位，无未排除隐患",
  statusTone: "ok" as const,
  updatedAt: "落地检查与开工指令（10:30—12:00）",
  notification: "现场条件变化时通知各岗位",
  source: "脚本 (3) 第 55、60、64、65 段现场登记",
  locations: freezeLocations([
    {
      key: "boundary",
      label: "隔离区边界",
      value: "四根木柱外围",
      state: "已登记",
      note: "设置警戒带或围栏，人员只在隔离区内按路线活动",
    },
    {
      /* 第 64 段：划分人员作业区和设备暂存区 —— 批注要的「设备摆放区」就是它 */
      key: "zone",
      label: "区域划分",
      value: "人员作业区、设备暂存区",
      state: "已登记",
      note: "以四柱外围为界划分，设备集中暂存，不在作业通道内摆放",
    },
    {
      key: "entrance",
      label: "出入口",
      value: "四柱区域入口",
      state: "已登记",
      note: "门口放置警示牌，撤离路线保持畅通",
    },
    {
      key: "assembly",
      label: "应急集合点",
      value: null,
      state: "待现场标定",
      note: "原始登记未提供具体位置，待现场标定后更新",
    },
  ]),
});

export function getSiteSafetyRecord(orderId: string) {
  return orderId === "SH-2026-0901" ? SITE_SAFETY_RECORD : null;
}
