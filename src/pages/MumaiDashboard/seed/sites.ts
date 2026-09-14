/**
 * 木脉智检 · 古建点位种子（地图点位与工单 / 任务共用同一份数据）
 *
 * 为什么单独一个文件而不是并进 `scenario.ts`：
 * `scenario.ts` 已经很大，且被 user 明确要求「可追加、不要改动已有导出」。
 * 这里把「我们去勘察、检测过的古建点位」独立成一份种子，`data.ts` 只做再导出，
 * 页面不再各自硬编码 —— PRD 16 要求全部页面从 seed 取数。
 *
 * 数据自洽（硬要求，由 `scripts` 之外的一次性校验脚本核对）：
 *   1. 每个带 `orderId` 的点位，其工单号必须真实存在于 `WORK_ORDER` / `HISTORIC_ORDERS`；
 *   2. `orderId` 指向的工单；其 `site` 必须与该点位 `name` 一致；
 *   3. 带 `risk` 的点位，风险描述来自工单 `scope` 或 `HISTORY_RISKS` / `CURRENT_RISKS`；
 *   4. 带 `missionId` 的点位，该任务必须真实存在于 `MISSION`。
 * 不允许出现「地图上有这个点位、工单列表里却没有」的断链。
 *
 * 状态口径（与用户原话对齐）：
 *   collected   已勘察 —— 已到现场做过勘察建档，未做内部检测
 *   inspected   已检测 —— 已用毫米波 / 影像做过检测并出结论
 *   risk        有风险 —— 检测发现风险构件，尚未建单
 *   workorder   有工单 —— 已生成工单（最高优先级，点击直接进工单页）
 * 四态之外不再扩展：用户要的是「勘察 / 检测 / 风险 / 工单」这一组可读的语义，
 * 再拆状态只会让图例和颜色映射变复杂。
 */

import { HISTORIC_ORDERS, MISSION, WORK_ORDER } from "./scenario";
import type { Order, Waypoint } from "./types";

/** 点位状态（地图点位图例与颜色映射的唯一来源，见 `map/status.ts`） */
export type SiteStatus = "collected" | "inspected" | "risk" | "workorder";

/**
 * 勘察 / 检测记录。
 *
 * 只有「去过现场」的点位才有这份记录 —— 没有记录的点位在地图上不会出现，
 * 因此每个点位都有 `survey`，区别只在检测项的多少。
 */
export type SiteSurvey = {
  /** 最近一次勘察 / 检测时间 */
  at: string;
  /** 现场 / 平台责任人（种子里的分工见 MEMBERS） */
  by: string;
  /** 本轮做了哪些检测项 */
  items: string[];
  /** 结论。未检测的部分不写成「正常」，只写「未检测」 */
  conclusion: string;
};

/** 一个「我们去勘察、检测过的古建点位」 */
export type Site = {
  id: string;
  name: string;
  /** 全国图上的省份，例如「山西」；上海图上的点位可为空 */
  province?: string;
  /** 上海图上的区，例如「松江区」；全国图上的点位可为空 */
  district?: string;
  /** [经度, 纬度]，WGS84 */
  coordinate: [number, number];
  status: SiteStatus;
  /** 风险描述；有风险 / 有工单的点位才有 */
  risk?: string;
  /** 关联工单号，必须真实存在于 WORK_ORDER / HISTORIC_ORDERS */
  orderId?: string;
  /** 关联巡检任务号，必须真实存在于 MISSION */
  missionId?: string;
  /** 勘察 / 检测记录 */
  survey: SiteSurvey;
};

/* ------------------------------------------------------------------ *
 * 0. 工单台账视图：地图点位与工单共用同一批工单号
 * ------------------------------------------------------------------ */

/** 平台上真实存在的全部工单（本轮 + 历史），地图点位只允许引用这里的编号 */
export const SITE_ORDERS: Order[] = [WORK_ORDER, ...HISTORIC_ORDERS];

export const siteOrderById = (id: string): Order | undefined =>
  SITE_ORDERS.find((item) => item.id === id);

/** 工单号 → 点位 id。右栏选中工单时靠它反查地图上要高亮的点位 */
export const orderSiteId: Record<string, string> = {};

/** 点位 id → 工单号。地图点位点击时靠它跳 `/orders?order=` */
export const siteOrderId: Record<string, string> = {};

/* ------------------------------------------------------------------ *
 * 1. 全国图点位：27 处，覆盖 22 个省级区域
 *
 * 坐标取该古建所在位置的近似值（WGS84，小数 4 位约 10m 量级），
 * 省份用于地图光锥与标签去重，`survey.at` 与工单 `createdAt` / `discoveredAt`
 * 同源同月，保证「先勘察、后建单」的时序读得通。
 * ------------------------------------------------------------------ */

export const CHINA_SITES: Site[] = [
  {
    id: "sh", name: "示例寺", province: "上海", coordinate: [121.2235, 31.032], status: "workorder",
    risk: "Z04 下部疑似空洞",
    /**
     * 本轮工单只在**上海图**上挂：全国图这里是「示意点位」，点开更有用的是
     * 「去建图巡检页看这一轮的航点与轨迹」，所以全国态只挂 missionId，
     * 上海态（`SHANGHAI_SITES` 里同 id 的那条）才挂 orderId。
     * 这样两种地图态各自落到最合适的页面，也避免同一点位在两个层级给出两套口径。
     */
    missionId: MISSION.id,
    survey: {
      at: "2026-09-11 14:22", by: "马 · 具身智能工程师",
      items: ["SLAM 建图 MAP-SH-06", "四柱关键帧对比", "Z04 下部毫米波扫描仪精扫", "环境记录 CFG-02"],
      conclusion: "Z04 下部疑似严重受潮与两处疑似虫蛀空洞，已建工单 SH-2026-0901 并安排复核。",
    },
  },
  {
    id: "bj-zhihua", name: "智化寺", province: "北京", coordinate: [116.4189, 39.9163], status: "inspected",
    survey: {
      at: "2026-08-24 10:20", by: "史 · 人工智能架构师",
      items: ["转轮藏殿影像采集", "Z03 表面巡检", "历史档案核对"],
      conclusion: "Z03 漆层局部起翘，属例行复核范围；本轮采集已完成并归档，未建新工单。",
    },
  },
  {
    id: "tj-duyue", name: "独乐寺", province: "天津", coordinate: [117.4, 40.0459], status: "inspected",
    survey: {
      at: "2026-08-15 09:40", by: "饶 · 全栈开发工程师",
      items: ["观音阁影像采集", "梁架外观巡检"],
      conclusion: "未见新增缺损；未做内部检测的部分不判定为正常。",
    },
  },
  {
    id: "hb-longxing", name: "隆兴寺", province: "河北", coordinate: [114.5857, 38.1476], status: "risk",
    risk: "摩尼殿檐部排水不畅",
    survey: {
      at: "2026-08-12 11:05", by: "沈 · 项目经理",
      items: ["摩尼殿影像采集", "檐部渗水痕迹检查"],
      conclusion: "檐部存在渗水痕迹，排水路径需复核，暂未建单。",
    },
  },
  {
    id: "sx-yingxian", name: "应县木塔", province: "山西", coordinate: [113.1875, 39.5564], status: "workorder",
    orderId: "SX-2026-0813",
    risk: "二层西南侧斗栱变形观测",
    survey: {
      at: "2026-07-18 09:10", by: "马 · 具身智能工程师",
      items: ["塔身倾斜观测", "二层斗栱影像采集", "环境温湿度记录"],
      conclusion: "二层西南侧斗栱变形观测本轮已完成，工单 SX-2026-0813 验收关闭，后续按季度继续跟踪。",
    },
  },
  {
    id: "sx-huayan", name: "华严寺", province: "山西", coordinate: [113.3001, 40.0768], status: "risk",
    risk: "大雄宝殿檐柱含水率异常",
    survey: {
      at: "2026-08-09 15:30", by: "饶 · 全栈开发工程师",
      items: ["檐柱毫米波初扫", "环境温湿度记录"],
      conclusion: "檐柱含水率高于同批木构件，需补充采集后复核。",
    },
  },
  {
    id: "sx-zhenguo", name: "镇国寺", province: "山西", coordinate: [112.2432, 37.2264], status: "collected",
    survey: {
      at: "2026-07-30 10:50", by: "饶 · 全栈开发工程师",
      items: ["万佛殿影像采集", "构件编号复核"],
      conclusion: "勘察建档完成，尚未安排内部检测。",
    },
  },
  {
    id: "sd-kongmiao", name: "曲阜孔庙", province: "山东", coordinate: [116.9865, 35.5967], status: "inspected",
    survey: {
      at: "2026-07-22 14:10", by: "史 · 人工智能架构师",
      items: ["大成殿影像采集", "柱础外观巡检"],
      conclusion: "外观连续，未发现新增缺损；内部未检测。",
    },
  },
  {
    id: "henan-shaolin", name: "少林寺", province: "河南", coordinate: [112.9353, 34.5073], status: "collected",
    survey: {
      at: "2026-07-05 09:25", by: "饶 · 全栈开发工程师",
      items: ["初祖庵影像采集", "构件档案建立"],
      conclusion: "勘察建档完成，检测排期未定。",
    },
  },
  {
    id: "shaanxi-dayanta", name: "大雁塔", province: "陕西", coordinate: [108.9645, 34.2186], status: "risk",
    risk: "塔体倾斜长期观测超阈值",
    survey: {
      at: "2026-08-02 16:00", by: "马 · 具身智能工程师",
      items: ["塔体倾斜观测", "塔身影像采集"],
      conclusion: "倾斜观测值接近告警阈值，建议加密观测频次，暂未建单。",
    },
  },
  {
    id: "gs-mogao", name: "莫高窟", province: "甘肃", coordinate: [94.8096, 40.0405], status: "risk",
    risk: "壁画空鼓",
    survey: {
      at: "2026-06-28 10:15", by: "史 · 人工智能架构师",
      items: ["洞窟影像采集", "壁画空鼓区标注"],
      conclusion: "壁画空鼓范围已标注，需专业复核后确定处理方案。",
    },
  },
  {
    id: "qh-taer", name: "塔尔寺", province: "青海", coordinate: [101.5694, 36.4792], status: "collected",
    survey: {
      at: "2026-06-24 11:35", by: "饶 · 全栈开发工程师",
      items: ["大金瓦殿影像采集", "环境记录"],
      conclusion: "勘察建档完成，未做内部检测。",
    },
  },
  {
    id: "sc-baoguo", name: "报国寺", province: "四川", coordinate: [103.4845, 29.5982], status: "workorder",
    orderId: "SC-2026-0826",
    risk: "Z01 表面裂隙",
    survey: {
      at: "2026-08-26 15:10", by: "史 · 人工智能架构师",
      items: ["山门东侧 Z01 影像采集", "裂隙宽度测量"],
      conclusion: "Z01 存在表面裂隙，工单 SC-2026-0826 已完成：裂隙观测与灌浆建议通过人工验收。",
    },
  },
  {
    id: "sc-wenshu", name: "文殊院", province: "四川", coordinate: [104.0721, 30.6769], status: "collected",
    survey: {
      at: "2026-06-15 09:50", by: "饶 · 全栈开发工程师",
      items: ["天王殿影像采集", "构件编号复核"],
      conclusion: "勘察建档完成，未安排精扫。",
    },
  },
  {
    id: "cq-dazu", name: "大足石刻", province: "重庆", coordinate: [105.7976, 29.7039], status: "inspected",
    survey: {
      at: "2026-06-18 13:20", by: "史 · 人工智能架构师",
      items: ["宝顶山造像影像采集", "岩体渗水观察"],
      conclusion: "造像表面未见新增风化；渗水通道已记录。",
    },
  },
  {
    id: "yn-chongsheng", name: "崇圣寺三塔", province: "云南", coordinate: [100.1437, 25.7048], status: "workorder",
    orderId: "YN-2026-0820",
    risk: "主塔一层北侧外观复核",
    survey: {
      at: "2026-08-20 09:30", by: "沈 · 项目经理",
      items: ["主塔一层影像采集", "倾斜观测", "外观复核"],
      conclusion: "外观复核已完成，观测记录提交并通过人工验收，工单 YN-2026-0820 已完成。",
    },
  },
  {
    id: "gz-dong", name: "增冲鼓楼", province: "贵州", coordinate: [108.8631, 25.9276], status: "collected",
    survey: {
      at: "2026-06-08 10:40", by: "饶 · 全栈开发工程师",
      items: ["鼓楼影像采集", "木构编号建档"],
      conclusion: "勘察建档完成，未做内部检测。",
    },
  },
  {
    id: "hub-wudang", name: "武当山紫霄宫", province: "湖北", coordinate: [111.0097, 32.4008], status: "inspected",
    survey: {
      at: "2026-07-12 15:45", by: "马 · 具身智能工程师",
      items: ["紫霄殿影像采集", "柱网外观巡检"],
      conclusion: "柱网外观连续，未发现新增缺损。",
    },
  },
  {
    id: "hn-yuelu", name: "岳麓书院", province: "湖南", coordinate: [112.9364, 28.1853], status: "collected",
    survey: {
      at: "2026-07-08 14:05", by: "史 · 人工智能架构师",
      items: ["讲堂影像采集", "碑廊环境记录"],
      conclusion: "勘察建档完成，检测排期待定。",
    },
  },
  {
    id: "jx-tengwang", name: "滕王阁", province: "江西", coordinate: [115.8756, 28.6823], status: "inspected",
    survey: {
      at: "2026-07-15 16:30", by: "马 · 具身智能工程师",
      items: ["主体结构影像采集", "沉降观测点复核"],
      conclusion: "沉降观测无异常变化；木构件未精扫。",
    },
  },
  {
    id: "ah-hongcun", name: "宏村", province: "安徽", coordinate: [117.9846, 29.9273], status: "collected",
    survey: {
      at: "2026-06-30 11:15", by: "饶 · 全栈开发工程师",
      items: ["承志堂木雕影像采集", "环境记录"],
      conclusion: "木雕构件已完成影像建档，未做内部检测。",
    },
  },
  {
    id: "js-hanshan", name: "寒山寺", province: "江苏", coordinate: [120.5752, 31.3117], status: "workorder",
    orderId: "JS-2026-0828",
    risk: "Z02 局部受潮",
    survey: {
      at: "2026-08-28 10:05", by: "马 · 具身智能工程师",
      items: ["钟楼二层 Z02 影像采集", "受潮范围复核", "排水路径检查"],
      conclusion: "Z02 局部受潮，工单 JS-2026-0828 已完成：排水沟清理与受潮范围复核通过人工验收，雨季前后继续观察。",
    },
  },
  {
    id: "js-zhouzhuang", name: "周庄沈厅", province: "江苏", coordinate: [120.8497, 31.1145], status: "inspected",
    survey: {
      at: "2026-07-25 10:30", by: "饶 · 全栈开发工程师",
      items: ["厅堂梁架影像采集", "木构件外观巡检"],
      conclusion: "梁架外观完好，未做内部检测。",
    },
  },
  {
    id: "zj-lingyin", name: "灵隐寺", province: "浙江", coordinate: [120.1012, 30.2401], status: "workorder",
    orderId: "ZJ-2026-0823",
    risk: "Z02 含水率偏高",
    survey: {
      at: "2026-08-23 11:20", by: "史 · 人工智能架构师",
      items: ["大雄宝殿西次间 Z02 精扫", "含水率复测", "通风条件检查"],
      conclusion: "Z02 含水率偏高，工单 ZJ-2026-0823 已完成：增设通风口后复测含水率回落并通过验收，干燥季节继续复测。",
    },
  },
  {
    id: "zj-nanxun", name: "南浔张石铭旧宅", province: "浙江", coordinate: [120.4281, 30.8738], status: "collected",
    survey: {
      at: "2026-06-21 15:20", by: "饶 · 全栈开发工程师",
      items: ["懿德堂影像采集", "木雕构件建档"],
      conclusion: "勘察建档完成，未安排内部检测。",
    },
  },
  {
    id: "fj-kaiyuan", name: "泉州开元寺", province: "福建", coordinate: [118.5885, 24.9139], status: "collected",
    survey: {
      at: "2026-06-12 09:35", by: "史 · 人工智能架构师",
      items: ["东西塔影像采集", "大雄宝殿柱网记录"],
      conclusion: "勘察建档完成，未做内部检测。",
    },
  },
  {
    id: "gd-chenjiaci", name: "陈家祠", province: "广东", coordinate: [113.2447, 23.1256], status: "inspected",
    survey: {
      at: "2026-06-05 14:50", by: "马 · 具身智能工程师",
      items: ["聚贤堂木雕影像采集", "屋面外观巡检"],
      conclusion: "木雕与屋面外观未见新增缺损。",
    },
  },
];

/* ------------------------------------------------------------------ *
 * 2. 上海图点位：12 处，集中在松江 / 普陀 / 徐汇 / 静安等区
 *
 * 「示例寺」与全国图共用同一个 id，两处坐标分别对应
 * 「全国图上的示意位置」与「松江区实际位置」，与 WORK_ORDER.location 一致。
 * ------------------------------------------------------------------ */

export const SHANGHAI_SITES: Site[] = [
  {
    id: "sh", name: "示例寺", district: "松江区", coordinate: [121.2235, 31.032], status: "workorder",
    risk: "Z04 下部疑似空洞", orderId: "SH-2026-0901", missionId: MISSION.id,
    survey: {
      at: "2026-09-11 14:22", by: "马 · 具身智能工程师",
      items: ["SLAM 建图 MAP-SH-06", "四柱关键帧对比", "Z04 下部毫米波扫描仪精扫", "环境记录 CFG-02"],
      conclusion: "Z04 下部疑似严重受潮与两处疑似虫蛀空洞，已建工单 SH-2026-0901 并安排复核。",
    },
  },
  {
    id: "sh-gfl", name: "广富林遗址", district: "松江区", coordinate: [121.195, 31.057], status: "collected",
    survey: {
      at: "2026-08-06 10:10", by: "饶 · 全栈开发工程师",
      items: ["知也禅寺木构影像采集", "构件编号建档"],
      conclusion: "勘察建档完成，未做内部检测。",
    },
  },
  {
    id: "sh-zuibaichi", name: "醉白池", district: "松江区", coordinate: [121.2392, 31.0062], status: "inspected",
    survey: {
      at: "2026-08-11 15:35", by: "马 · 具身智能工程师",
      items: ["池上草堂影像采集", "柱础外观巡检"],
      conclusion: "外观连续，未发现新增缺损。",
    },
  },
  {
    id: "sh-fangta", name: "松江方塔", district: "松江区", coordinate: [121.2408, 31.0063], status: "inspected",
    survey: {
      at: "2026-08-11 16:20", by: "马 · 具身智能工程师",
      items: ["塔身影像采集", "倾斜观测"],
      conclusion: "塔身外觀与倾斜观测记录均无异常变化。",
    },
  },
  {
    id: "sh-zhenru", name: "真如寺", district: "普陀区", coordinate: [121.399, 31.25], status: "inspected",
    survey: {
      at: "2026-08-05 09:45", by: "饶 · 全栈开发工程师",
      items: ["大殿梁架影像采集", "木构件外观巡检"],
      conclusion: "梁架外观完好；内部未检测，不作正常判定。",
    },
  },
  {
    id: "sh-yufo", name: "玉佛禅寺", district: "普陀区", coordinate: [121.4415, 31.2405], status: "risk",
    risk: "大雄宝殿木构含水率偏高",
    survey: {
      at: "2026-08-19 11:00", by: "史 · 人工智能架构师",
      items: ["大雄宝殿木构初扫", "环境温湿度记录"],
      conclusion: "木构含水率高于同批构件，需补充采集后复核，暂未建单。",
    },
  },
  {
    id: "sh-longhua", name: "龙华寺", district: "徐汇区", coordinate: [121.4571, 31.1816], status: "inspected",
    survey: {
      at: "2026-08-02 09:30", by: "马 · 具身智能工程师",
      items: ["龙华塔影像采集", "塔身外观巡检"],
      conclusion: "塔身外观未见新增缺损，倾斜观测待补测。",
    },
  },
  {
    id: "sh-jingan", name: "静安寺", district: "静安区", coordinate: [121.4453, 31.2231], status: "collected",
    survey: {
      at: "2026-07-28 16:10", by: "饶 · 全栈开发工程师",
      items: ["大殿影像采集", "构件编号复核"],
      conclusion: "勘察建档完成，检测排期待定。",
    },
  },
  {
    id: "sh-wenmiao", name: "上海文庙", district: "黄浦区", coordinate: [121.4839, 31.2205], status: "collected",
    survey: {
      at: "2026-07-19 10:25", by: "饶 · 全栈开发工程师",
      items: ["大成殿影像采集", "环境记录"],
      conclusion: "勘察建档完成，未做内部检测。",
    },
  },
  {
    id: "sh-yuyuan", name: "豫园", district: "黄浦区", coordinate: [121.4922, 31.2273], status: "inspected",
    survey: {
      at: "2026-07-16 14:40", by: "史 · 人工智能架构师",
      items: ["三穗堂木构影像采集", "戏台外观巡检"],
      conclusion: "木构外观未见新增缺损。",
    },
  },
  {
    id: "sh-kongmiao", name: "嘉定孔庙", district: "嘉定区", coordinate: [121.2506, 31.3856], status: "collected",
    survey: {
      at: "2026-06-26 10:05", by: "饶 · 全栈开发工程师",
      items: ["大成殿影像采集", "构件建档"],
      conclusion: "勘察建档完成，未安排精扫。",
    },
  },
  {
    id: "sh-qingxi", name: "青浦青龙寺", district: "青浦区", coordinate: [121.1147, 31.1503], status: "inspected",
    survey: {
      at: "2026-06-14 15:00", by: "马 · 具身智能工程师",
      items: ["大殿影像采集", "塔基外观巡检"],
      conclusion: "塔基外观稳定，木构未精扫。",
    },
  },
];

/* ------------------------------------------------------------------ *
 * 3. 派生索引与统计：页面只从这里读，不各自算
 * ------------------------------------------------------------------ */

/** 全国图 / 上海图使用同一套点位结构，只有数据集不同 */
export const SITES_BY_MODE: Record<"china" | "shanghai", Site[]> = {
  china: CHINA_SITES,
  shanghai: SHANGHAI_SITES,
};

for (const sites of [CHINA_SITES, SHANGHAI_SITES]) {
  for (const site of sites) {
    if (!site.orderId) continue;
    siteOrderId[site.id] = site.orderId;
    if (!orderSiteId[site.orderId]) orderSiteId[site.orderId] = site.id;
  }
}

/** 某模式下实际存在的状态，按图例固定顺序返回 —— 图例与点位一一对应 */
export const SITE_STATUS_ORDER: SiteStatus[] = ["collected", "inspected", "risk", "workorder"];

export function statusesOf(sites: Site[]): SiteStatus[] {
  const present = new Set(sites.map((site) => site.status));
  return SITE_STATUS_ORDER.filter((status) => present.has(status));
}

/** 点位数与状态分布，页面与验收脚本共用同一份口径 */
export function summariseSites(sites: Site[]): { total: number; byStatus: Record<SiteStatus, number> } {
  const byStatus: Record<SiteStatus, number> = { collected: 0, inspected: 0, risk: 0, workorder: 0 };
  for (const site of sites) byStatus[site.status] += 1;
  return { total: sites.length, byStatus };
}

/** 点位覆盖的省份数（全国态势用） */
export const CHINA_PROVINCE_COUNT = new Set(
  CHINA_SITES.map((site) => site.province).filter((name): name is string => !!name),
).size;

/** 点位地址一行话：全国图给省份，上海图给区 */
export function siteRegion(site: Site): string {
  return site.district ?? site.province ?? "—";
}

/** 经纬度显示口径，与 WORK_ORDER.location 的写法一致 */
export function siteCoordinateText(site: Site): string {
  const [lng, lat] = site.coordinate;
  return `北纬 ${lat.toFixed(4)}°，东经 ${lng.toFixed(4)}°`;
}

/**
 * 点位 → 本轮任务的航点（用于 `/mapping?site=` 定位并高亮）。
 *
 * 返回**该点位这一轮要看的构件观察点**，即任务航点里带 `componentId` 的那几个。
 * 示例寺返回 P2–P5（Z01–Z04 四个观察点），不含 P1 起点与 P6 东侧回廊 ——
 * 后两个是通行航点，不是「这个点位要看的东西」，一起高亮等于没高亮。
 *
 * 原来这里写的是 `MISSION.waypoints.find((point) => point.componentId !== null)`，
 * 即**忽略传入的点位**、永远返回第一个带构件的航点（P2），而且只返回一个。
 * 那个函数从来没有被调用过，所以这个错误一直没暴露 —— `/mapping` 侧压根没读
 * `?site=` 参数。现在两边一起补上。
 *
 * 点位没有 `missionId`（只勘察过、没排任务）时返回空数组：
 * 「这个点位没有本轮航点」是一个正常结果，不编一个最近的点位顶上。
 */
export function waypointsForSite(site: Site): Waypoint[] {
  if (!site.missionId) return [];
  return MISSION.waypoints.filter((point) => point.componentId !== null);
}
