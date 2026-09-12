export type MapMode = "china" | "shanghai";

/**
 * 点位状态。四种状态对应用户要求的四类视觉表达：
 *   collected  已采集完成的古建
 *   inspected  已完成巡检
 *   risk       存在风险构件
 *   workorder  已生成工单
 * 另外「当前任务」用 workorder + current 标记（由 MapScene 传 current）。
 */
export type SiteStatus = "collected" | "inspected" | "risk" | "workorder";

export type Site = {
  id: string;
  name: string;
  province?: string;
  district?: string;
  coordinate: [number, number];
  status: SiteStatus;
  risk?: string;
  orderId?: string;
};

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

/** 首页中国地图上的古建点位（对应第二章剧本里的采集/巡检/风险/工单分布） */
export const chinaSites: Site[] = [
  { id: "sh", name: "示例寺", province: "上海", coordinate: [121.4737, 31.2304], status: "workorder", risk: "Z04 下部疑似空洞", orderId: "SH-2026-0901" },
  { id: "bj", name: "智化寺", province: "北京", coordinate: [116.4074, 39.9042], status: "collected" },
  { id: "sx", name: "华严寺", province: "山西", coordinate: [113.3001, 40.0768], status: "risk", risk: "含水率异常" },
  { id: "sc", name: "报国寺", province: "四川", coordinate: [103.4845, 29.5982], status: "risk", risk: "表面裂隙" },
  { id: "yn", name: "崇圣寺三塔", province: "云南", coordinate: [100.1437, 25.7048], status: "inspected" },
  { id: "gd", name: "陈家祠", province: "广东", coordinate: [113.2447, 23.1256], status: "collected" },
  { id: "zj", name: "灵隐寺", province: "浙江", coordinate: [120.1012, 30.2401], status: "inspected" },
  { id: "js", name: "寒山寺", province: "江苏", coordinate: [120.5752, 31.3117], status: "workorder", orderId: "JS-2026-0828" },
  { id: "fj", name: "开元寺", province: "福建", coordinate: [118.5885, 24.9139], status: "collected" },
  { id: "henan", name: "少林寺", province: "河南", coordinate: [112.9353, 34.5073], status: "inspected" },
  { id: "gs", name: "莫高窟", province: "甘肃", coordinate: [94.8096, 40.0405], status: "risk", risk: "壁画空鼓" },
  { id: "hb", name: "隆兴寺", province: "河北", coordinate: [114.5857, 38.1476], status: "collected" },
];

/** 上海地图上的古建点位（比赛实操所在区域） */
export const shanghaiSites: Site[] = [
  { id: "sh", name: "示例寺", district: "松江区", coordinate: [121.2235, 31.032], status: "workorder", risk: "Z04 下部疑似空洞", orderId: "SH-2026-0901" },
  { id: "gfl", name: "广富林", district: "松江区", coordinate: [121.195, 31.057], status: "collected" },
  { id: "zrs", name: "真如寺", district: "普陀区", coordinate: [121.399, 31.25], status: "inspected" },
  { id: "lg", name: "龙华寺", district: "徐汇区", coordinate: [121.4571, 31.1816], status: "inspected" },
  { id: "jn", name: "静安寺", district: "静安区", coordinate: [121.4453, 31.2231], status: "collected" },
  { id: "yl", name: "玉佛禅寺", district: "普陀区", coordinate: [121.4415, 31.2405], status: "risk", risk: "木构含水率偏高" },
];

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

export const workOrders: WorkOrder[] = [
  { id: "SH-2026-0901", site: "示例寺", component: "Z04", district: "松江区", level: "高风险", status: "待复核", finding: "疑似空洞", score: "0.87" },
  { id: "JS-2026-0828", site: "寒山寺", component: "Z02", district: "姑苏区", level: "中风险", status: "处理中", finding: "局部受潮", score: "0.71" },
  { id: "SC-2026-0826", site: "报国寺", component: "Z01", district: "峨眉山市", level: "高风险", status: "待处理", finding: "表面裂隙" },
  { id: "BJ-2026-0824", site: "智化寺", component: "Z03", district: "东城区", level: "低风险", status: "已完成", finding: "例行复核" },
  { id: "ZJ-2026-0823", site: "灵隐寺", component: "Z02", district: "西湖区", level: "中风险", status: "处理中", finding: "含水率偏高" },
];

export const moduleCopy: Record<string, { title: string; summary: string; action: string; steps: string[] }> = {
  "工单档案": { title: "工单档案", summary: "从风险发现到人工验收，所有证据与处理记录围绕同一工单沉淀。", action: "打开当前工单", steps: ["任务附件已关联", "环境配置已确认", "复核工单待审核"] },
  "建图巡检": { title: "建图巡检", summary: "占据栅格、机器人轨迹、巡检点与通信通道保持独立状态。", action: "预览巡检路线", steps: ["地图版本 MAP-SH-06", "点位序列 Z01 → Z04", "车辆状态 3 秒前"] },
  "数字孪生": { title: "数字孪生", summary: "打开示例寺预采场景，联动构件标签、表面疑点、回波与历史记录。", action: "定位 Z04", steps: ["场景版本 GS-2026.09", "Z04 热点已定位", "当前/历史视角可对比"] },
  "检测适配": { title: "检测适配", summary: "采集、异常排查、数据集、训练验证、更新交付与融合分析串成闭环。", action: "查看训练验证", steps: ["数据集 DS-06 已冻结", "适配任务已完成", "设备回执已归档"] },
  "知识库": { title: "知识库", summary: "本地资料检索与业务状态分开读取，来源可追溯到原文位置。", action: "查询五月巡检", steps: ["资料索引 KB-12", "检索结果 Top 5", "工单状态实时合并"] },
  "报告归档": { title: "报告归档", summary: "交付清单覆盖工单、环境、原始数据、图像、地图、模型与日志。", action: "运行完整性校验", steps: ["归档文件 48 项", "SHA-256 待校验", "报告打印版已生成"] },
};
