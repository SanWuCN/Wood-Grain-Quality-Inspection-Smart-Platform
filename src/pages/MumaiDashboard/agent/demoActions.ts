/**
 * 单一动作注册表（工作清单 v1.0 §10 阶段 C / 阶段 D）
 *
 * ── 它同时解决两件事，所以放在一起而不是做成两份东西 ────────────────
 *   · §10 阶段 C：「建立**单一动作注册表**，把'播报片段—状态更新—页面展开'
 *     绑定为可回放事件」；
 *   · §10 阶段 D：「补齐天气四分类、素材质检、异常帧、接收清单、清洗漏斗、
 *     模型对照、部署演习、三路融合、复盘、交付差异」。
 * 若表面组件各写各的数据、动作表再抄一遍轮次，两份必然分叉。
 * 这里用一份注册表表达：**哪一轮 → 播完打开哪个表面 → 表面展示哪些数据键**。
 *
 * ── 数据键而不是字面量（§11.5）──────────────────────────────────────
 * 表面里的每个数字都必须给**数据键**（指向 `DEMO_SCENARIO_V3`）。
 * 这样"同一指标在三个文件里手写三个数值"在结构上就不可能发生 ——
 * 组件拿不到字面量，只能按键取值。
 *
 * ── 与剧本的关系 ────────────────────────────────────────────────────
 * 本表按 `roundNo` 与 `SCRIPT_ROUNDS` 对齐（顺序也一致，便于逐轮核对）；
 * 剧本负责"说什么"，本表负责"说完页面做什么"。两者都不重复对方的内容。
 */

/** §10 阶段 D 点名的 10 个表面 + `order`（①④⑧⑩⑰⑳㉑㉒ 用的工单详情） */
export const SURFACE_KINDS = [
  "order", // 工单详情（既有：逐组展开）
  "weather", // 天气四分类
  "material", // 素材质检
  "anomaly", // 异常帧
  "receipt", // 接收清单
  "clean", // 清洗漏斗
  "model", // 模型对照
  "deploy", // 部署演习
  "fusion", // 三路融合
  "review", // 复盘
  "delivery", // 交付差异
  "tasks", // 任务卡（③⑬：本地任务卡列表）
  "params", // 参数对比卡（⑤：环境补偿参数建议）
  "channels", // 通道状态（⑥：地图与视频）
  "evidence", // 证据查看器（⑨⑲）
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export type DemoAction = {
  roundNo: string;
  /** 表面标题（页面上显示；与剧本 `title` 不同 —— 它说的是"页面在做什么"） */
  title: string;
  surface: SurfaceKind;
  /**
   * 这个表面要展示的数据键（点分路径，取自 `DEMO_SCENARIO_V3`）。
   * 组件按这些键取值渲染，**不接收字面量**。
   */
  dataKeys: string[];
  /** 可选：表面底部的一个本地按钮（只改演习状态） */
  button?: string;
  /** 这个动作是否只影响本地演习状态（§10 阶段 D 要求；恒为 true，显式写出来） */
  simulated: boolean;
};

/**
 * 22 轮的动作，按剧本顺序。
 *
 * 说明：`order` 这类既有表面（①④⑧⑩⑰⑳㉑㉒）在这里**也登记**，
 * 因为它们同样有"必须发生的可见动作"（跳转工单详情 + 逐组展开）。
 * 登记它们让"22 轮每轮都有动作"成为一条可断言的事实，而不是靠记忆。
 */
export const DEMO_ACTIONS: readonly DemoAction[] = Object.freeze([
  {
    roundNo: "①",
    title: "打开新工单档案，四组模块随播报展开",
    surface: "order",
    dataKeys: ["components.codes", "components.focus", "draftOrder.no"],
    simulated: true,
  },
  {
    roundNo: "②",
    title: "打开平台环境档案（本地演习数据）",
    surface: "weather",
    dataKeys: [
      "weather.panelTitle",
      "weather.rangeStart",
      "weather.rangeEnd",
      "weather.rain.totalMm",
      "weather.rain.rainyDays",
      "weather.rain.stormDays",
      "weather.rain.longestWetSpellDays",
      "weather.rain.peakDailyMm",
      "weather.humidity.avgPct",
      "weather.humidity.highHumidityDays",
      "weather.humidity.maxDailyAvgPct",
      "weather.wind.maxGustMs",
      "weather.wind.strongWindDays",
      "weather.temperature.maxDailyDeltaC",
      "weather.badge",
    ],
    simulated: true,
  },
  {
    roundNo: "③",
    title: "工作台生成四张任务卡，第一张进入进行中",
    surface: "tasks",
    dataKeys: ["components.codes", "components.focus"],
    button: "在本地演练中标记已同步",
    simulated: true,
  },
  {
    roundNo: "④",
    title: "定位开工清单里唯一待确认项",
    surface: "order",
    dataKeys: ["components.codes", "siteEnv.airTempC"],
    simulated: true,
  },
  {
    roundNo: "⑤",
    title: "打开环境补偿参数对比卡",
    surface: "params",
    dataKeys: ["siteEnv.airTempC", "siteEnv.relativeHumidityPct", "siteEnv.windSpeedMs"],
    button: "应用演习参数",
    simulated: true,
  },
  {
    roundNo: "⑥",
    title: "并排显示地图质量与视频通道状态",
    surface: "channels",
    dataKeys: ["map.version", "map.coveragePct", "map.resolutionM", "mission.routeLengthM"],
    simulated: true,
  },
  {
    roundNo: "⑦",
    title: "打开素材质检，定位两处低清晰度片段",
    surface: "material",
    dataKeys: [
      "material.videoCount",
      "material.durationText",
      "material.resolutionText",
      "material.keyFrames",
      "material.missingFiles",
      "material.lowQualityClips",
      "material.lowQualityMarks",
    ],
    simulated: true,
  },
  {
    roundNo: "⑧",
    title: "四柱卡片按风险重排并高亮 Z04",
    surface: "order",
    dataKeys: ["components.codes", "components.focus", "components.focusRegion"],
    simulated: true,
  },
  {
    roundNo: "⑨",
    title: "打开 Z04 原始证据查看器",
    surface: "evidence",
    dataKeys: ["components.focus", "anomaly.batchId"],
    simulated: true,
  },
  {
    roundNo: "⑩",
    title: "打开路线预览与确认按钮（不真实下发）",
    surface: "channels",
    dataKeys: ["mission.id", "mission.waypointCount", "mission.routeLengthM"],
    button: "演习下发（仅改本地状态）",
    simulated: true,
  },
  {
    roundNo: "⑪",
    title: "顶部出现主动提醒，检查项逐条置为完成",
    surface: "channels",
    dataKeys: ["mission.id", "components.codes"],
    simulated: true,
  },
  {
    roundNo: "⑫",
    title: "打开异常卡与帧缺口分布，结论栏显示待补采",
    surface: "anomaly",
    dataKeys: [
      "anomaly.batchId",
      "anomaly.plannedFrames",
      "anomaly.receivedFrames",
      "anomaly.missingFrames",
      "anomaly.featureShiftSigma",
      "anomaly.conclusion",
    ],
    simulated: true,
  },
  {
    roundNo: "⑬",
    title: "生成四张本地任务卡（负责人 / 输入 / 完成条件）",
    surface: "tasks",
    dataKeys: ["anomaly.batchId", "anomaly.missingFrames", "components.focus"],
    simulated: true,
  },
  {
    roundNo: "⑭",
    title: "打开接收清单并筛选三条待审核记录",
    surface: "receipt",
    dataKeys: ["clean.rawCount", "material.missingFiles"],
    simulated: true,
  },
  {
    roundNo: "⑮",
    title: "展开清洗漏斗与分组校验",
    surface: "clean",
    dataKeys: [
      "clean.rawCount",
      "clean.keptCount",
      "clean.excludedCount",
      "clean.physicalGroups",
      "clean.split.train",
      "clean.split.validation",
      "clean.split.test",
    ],
    simulated: true,
  },
  {
    roundNo: "⑯",
    title: "打开固定测试集的对照页（禁止只显示单个总分）",
    surface: "model",
    dataKeys: [
      "model.missedBefore",
      "model.missedAfter",
      "model.falsePositiveBefore",
      "model.falsePositiveAfter",
      "model.recallBefore",
      "model.recallAfter",
      "model.deployChecksPassed",
      "model.deployChecksTotal",
    ],
    simulated: true,
  },
  {
    roundNo: "⑰",
    title: "打开部署检查页，显著标注演习不刷写",
    surface: "deploy",
    dataKeys: [
      "package.id",
      "package.sizeMb",
      "package.targetVersion",
      "package.rollbackVersion",
      "package.selfCheckPassed",
    ],
    button: "演习核对（不执行真实刷写）",
    simulated: true,
  },
  {
    roundNo: "⑱",
    title: "展开三路数据时间轴并生成融合记录卡",
    surface: "fusion",
    dataKeys: [
      "fusion.recordId",
      "fusion.radarFrames",
      "fusion.imageFrames",
      "fusion.edgeResults",
      "fusion.preprocessVersion",
    ],
    simulated: true,
  },
  {
    roundNo: "⑲",
    title: "显示两张优先复核与一张待补采证据卡",
    surface: "evidence",
    dataKeys: [
      "fusion.reliableCount",
      "fusion.pendingCount",
      "fusion.effectiveRatioPct",
      "fusion.effectiveRatioThresholdPct",
    ],
    simulated: true,
  },
  {
    roundNo: "⑳",
    title: "跳转工单草稿页，附件 / 范围 / 证据 / 审核栏随播报展开",
    surface: "order",
    dataKeys: ["draftOrder.no", "components.focusRegion", "delivery.total"],
    simulated: true,
  },
  {
    roundNo: "㉑",
    title: "打开复盘页，左右分栏显示已验证与待处理",
    surface: "review",
    dataKeys: ["delivery.total", "delivery.passed", "delivery.missing", "delivery.summaryMismatch"],
    simulated: true,
  },
  {
    roundNo: "㉒",
    title: "打开交付摘要并自动筛选三项待办",
    surface: "delivery",
    dataKeys: ["delivery.total", "delivery.passed", "delivery.missing", "delivery.summaryMismatch"],
    simulated: true,
  },
]);

/** 按圈号取动作（找不到返回 null，调用方决定如何处理） */
export function actionFor(roundNo: string): DemoAction | null {
  return DEMO_ACTIONS.find((a) => a.roundNo === roundNo) ?? null;
}
