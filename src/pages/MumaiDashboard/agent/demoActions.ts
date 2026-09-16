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
  /**
   * 这一轮的可见动作**只在工单详情页发生**（导航 + 逐组展开），不再弹演示表面。
   *
   * ── 为什么要这个标记（现场实测出的穿帮）────────────────────────────
   * ①④⑧⑩⑰⑳ 这 6 轮都会跳到工单详情页。原先它们**同时**弹一个左下角浮层，
   * 而浮层标题是写给排练者看的（例如「打开新工单档案，四组模块随播报展开」）——
   * 页面已经跳过去了，旁边还挂一句"随播报展开"，讲解人当场被拆台。
   * ⑩⑰ 更糟：它们的 `surface` 指向别的类型，于是"跳到工单页"又"弹一个
   * 路线预览 / 部署检查浮层"，看着像两个页面打架。
   *
   * 现在这 6 轮只用工单页本身表达动作（它本来就有四组逐段展开）。
   * 约束由 `demoActions.test.ts` 保证：标了 `revealOnly` 的轮次**必须**在
   * `script.ts` 里有 `reveal.order-detail` 声明，否则就成了"既没浮层也没页面动作"。
   */
  revealOnly?: boolean;
  /** 可选：表面底部的一个本地按钮（只改本地状态） */
  button?: string;
  /** 这个动作是否只影响本地状态（§10 阶段 D 要求；恒为 true，显式写出来） */
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
    title: "打开工单档案，任务范围与执行模块就位",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["components.codes", "components.focus", "draftOrder.no"],
    simulated: true,
  },
  {
    roundNo: "②",
    title: "打开平台环境档案",
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
    button: "在平台上标记已同步",
    simulated: true,
  },
  {
    roundNo: "④",
    title: "定位开工清单里唯一待确认项",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["components.codes", "siteEnv.airTempC"],
    simulated: true,
  },
  {
    roundNo: "⑤",
    title: "打开环境补偿参数对比卡",
    surface: "params",
    dataKeys: ["siteEnv.airTempC", "siteEnv.relativeHumidityPct", "siteEnv.windSpeedMs"],
    button: "应用建议参数",
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
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
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
    title: "工单页展开下发区，路线预览可见（未下发）",
    surface: "channels",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["mission.id", "mission.waypointCount", "mission.routeLengthM"],
    /*
      ⚠ 这里**不能**再挂按钮：浮层不显示了，按钮就没有落点（测试会拦）。
      这一轮真正该有的"确认下发"在工单页的下发区里（`DispatchPanel`），
      不是浮层上的一个演习按钮。台词也已经说清"预览已打开，尚未真实下发"。
    */
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
    title: "工单页展开下发区，版本与自检结果可见",
    surface: "deploy",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: [
      "package.id",
      "package.sizeMb",
      "package.targetVersion",
      "package.rollbackVersion",
      "package.selfCheckPassed",
    ],
    /*
      ⚠ 同 ⑩：浮层不显示了，就不再挂浮层按钮。
      "不得真实刷写"这条约束没有丢，它由两层保证 ——
      ① 工具门槛（高风险工具剧本一律不执行，由 验剧本工具链 工装核对）；
      ② 台词第⑰轮自己只说"自检7项通过、回退版本完整"，没有任何"已刷写"的说法。
    */
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
    title: "跳转工单草稿页，附件、范围、证据与审核栏就位",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
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
