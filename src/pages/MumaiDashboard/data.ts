export type MapMode = "china" | "shanghai";

/**
 * 点位状态与点位类型已归并到 `seed/sites.ts`（平台唯一数据源），
 * 这里只做再导出，保持既有 import 路径不变：
 *   点位状态。四种状态对应用户要求的四类语义：
 *     collected  已勘察（到过现场、建档，未做内部检测）
 *     inspected  已检测（做过毫米波 / 影像检测并出结论）
 *     risk       有风险（检测发现风险构件，尚未建单）
 *     workorder  有工单（已生成工单，点击直接进工单页）
 */
export type { SiteStatus, SiteSurvey, Site } from "./seed/sites";

export type WorkOrder = {
  id: string;
  site: string;
  component: string;
  district: string;
  level: "高风险" | "中风险" | "低风险";
  status: "待复核" | "待处理" | "处理中" | "已完成";
  finding: string;
  score?: string;
};

/**
 * 首页地图上的古建点位。
 *
 * 2026-09 归并：原来这里手写了 `chinaSites` / `shanghaiSites` 两套数组，
 * 点位名与工单里的点位名对得上、字段却各自为政，与 PRD「禁止页面各自硬编码」
 * 冲突。现在数据全部来自 `seed/sites.ts`，地图点位与工单 / 任务共用同一份：
 *   全国图 28 处、上海图 12 处，其中带工单的点位其工单号真实存在于
 *   `WORK_ORDER` / `HISTORIC_ORDERS`。
 */
export { CHINA_SITES as chinaSites, SHANGHAI_SITES as shanghaiSites } from "./seed/sites";

/** 飞线的起点（数据汇聚源），终点在场景里按当前模式动态计算 */
export const flyLineSeeds: { id: string; from: [number, number] }[] = [
  { id: "bj", from: [116.4074, 39.9042] },
  { id: "sx", from: [113.3001, 40.0768] },
  { id: "sc", from: [103.4845, 29.5982] },
  { id: "yn", from: [100.1437, 25.7048] },
  { id: "gd", from: [113.2447, 23.1256] },
  { id: "zj", from: [120.1012, 30.2401] },
  { id: "gs", from: [94.8096, 40.0405] },
  { id: "fj", from: [118.5885, 24.9139] },
];

/**
 * 旧版单页大屏（`MumaiDashboard/index.tsx`，已不参与路由）用的工单卡片视图。
 *
 * 注意：这里**不是**地图点位的数据源 —— 首页地图（`mapDemo/BusinessMarkers`）
 * 与右栏「风险与工单」都从 `seed/sites.ts` + `seed/scenario.ts` 取数，
 * 不再是两套。本数组只服务已下线的旧布局，保留是为了不改动既有导出。
 */
export const workOrders: WorkOrder[] = [
  { id: "SH-2026-0901", site: "示例寺", component: "Z04", district: "松江区", level: "高风险", status: "待复核", finding: "疑似空洞", score: "0.87" },
  { id: "JS-2026-0828", site: "寒山寺", component: "Z02", district: "姑苏区", level: "中风险", status: "处理中", finding: "局部受潮", score: "0.71" },
  { id: "SC-2026-0826", site: "报国寺", component: "Z01", district: "峨眉山市", level: "高风险", status: "待处理", finding: "表面裂隙" },
  { id: "BJ-2026-0824", site: "智化寺", component: "Z03", district: "东城区", level: "低风险", status: "已完成", finding: "例行复核" },
  { id: "ZJ-2026-0823", site: "灵隐寺", component: "Z02", district: "西湖区", level: "中风险", status: "处理中", finding: "含水率偏高" },
];

export const moduleCopy: Record<string, { title: string; summary: string; action: string; steps: string[] }> = {
  "工单档案": { title: "工单档案", summary: "从风险发现到人工验收，所有证据与处理记录围绕同一工单沉淀。", action: "打开当前工单", steps: ["任务附件已关联", "环境配置已确认", "复核工单待审核"] },
  "建图巡航": { title: "建图巡航", summary: "小车只有建图与巡航两个功能：栅格地图、位姿、雷达点、规划路径与七路车况分别判断。", action: "打开建图巡航", steps: ["小车链路 2 Hz 状态", "地图与 RViz 画面各自判断", "航点巡航需先定位就绪"] },
  "数字孪生": { title: "数字孪生", summary: "打开示例寺预采场景，联动构件标签、表面疑点、回波与历史记录。", action: "定位 Z04", steps: ["场景版本 GS-2026.09", "Z04 热点已定位", "当前/历史视角可对比"] },
  "检测适配": { title: "检测适配", summary: "采集、异常排查、数据集、训练验证、更新交付与融合分析串成闭环。", action: "查看训练验证", steps: ["数据集 DS-06 已冻结", "适配任务已完成", "设备回执已归档"] },
  "知识库": { title: "知识库", summary: "本地资料检索与业务状态分开读取，来源可追溯到原文位置。", action: "查询五月巡检", steps: ["资料索引 KB-12", "检索结果 Top 5", "工单状态实时合并"] },
  "报告归档": { title: "报告归档", summary: "交付清单覆盖工单、环境、原始数据、图像、地图、模型与日志。", action: "运行完整性校验", steps: ["归档文件 48 项", "SHA-256 待校验", "报告打印版已生成"] },
};
