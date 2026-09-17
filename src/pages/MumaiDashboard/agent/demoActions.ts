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

/** §10 阶段 D 点名的 10 个表面 + `order`（②③④⑪⑳㉓㉔㉕ 用的工单详情） */
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
  /**
   * 这一轮是**小木主动起头的预警**，浮层要渲染成"预警窗"：
   * 警示色描边 + 标题栏「预警」角标（见 `demoSurface.tsx` 的 `dsf--alert`）。
   *
   * ── 为什么预警窗必须带确认按钮（用户口径 2026-09-17）────────────────
   * 用户原话：「⑬ 这个触发时，会弹出预警窗口，然后带个确认按钮」。
   * 预警不同于普通数据面板：它是**要人回话的**，所以标了 `alert` 的轮次
   * 必须同时给 `button`（确认按钮）—— 这条由 `demoSurface.test.ts` 锁住，
   * 免得以后有人把按钮删掉、预警窗变成"看完就没了"。
   *
   * ⚠ 确认按钮只改本地状态（同 `button` 的既有约束）：
   *   它表示"架构师已收到并知悉"，**不代表**核验通过、更不向设备发任何指令。
   */
  alert?: boolean;
  /** 可选：表面底部的一个本地按钮（只改本地状态） */
  button?: string;
  /** 这个动作是否只影响本地状态（§10 阶段 D 要求；恒为 true，显式写出来） */
  simulated: boolean;
};

/**
 * 25 轮的动作，按剧本顺序（= 用户《小木对话总文案.txt》25 条的顺序）。
 *
 * 说明：`order` 这类既有表面（②③④⑪⑳㉓㉔㉕）在这里**也登记**，
 * 因为它们同样有"必须发生的可见动作"（跳转工单详情 + 逐组展开）。
 * 登记它们让"每一轮都有动作"成为一条可断言的事实，而不是靠记忆。
 *
 * ⚠ 2026-09-17 剧本重排：本表**逐轮重排过**，并补上新增的 ④（同步备份）
 * 与 ⑦（设备编号与数据来源核对）两轮的表面。`demoActions.test.ts` 会核对
 * "本表顺序 == SCRIPT_ROUNDS 顺序"、"每轮都有动作"、"数据键都取得到值"，
 * 顺序错了会直接红。
 */
export const DEMO_ACTIONS: readonly DemoAction[] = Object.freeze([
  {
    roundNo: "①",
    /*
      ⚠ 用户 2026-09-17 的统计问答（文档第 1 条）：
      「过去三个月到过多少个地方巡检、发现多少个风险点、已修复多少」。
      展示面用 `evidence`（资料检索结果），与台词「我正在检索 RAG 知识库」对应。

      ⚠ **不挂统计数字的 dataKeys**：台词里的统计数字（4 处 / 14 个风险点 / 2 处高风险 /
      7 处已修复 / 2 处施工中 / 5 处已受理）在冻结数据包里**没有出处**
      （已全仓扫描确认）。没有数据键就不出数字卡片，
      避免"台词念 14、卡片显示别的数"这种同屏矛盾。
    */
    title: "检索知识库，汇总近三个月巡检地点与风险处置情况",
    surface: "evidence",
    /*
      ⚠ 挂的是**真实存在**的数据键（`SCENARIO_KEYS` 里能查到）：
      `components.count`（构件数）、`weather.rain.risks`（降雨风险项）、
      `clean.rawCount`（原始记录数）——它们支撑"巡检了什么、看了哪些风险"这层叙述。
    */
    dataKeys: ["components.count", "weather.rain.risks", "clean.rawCount"],
    simulated: true,
  },
  {
    roundNo: "②",
    title: "打开工单档案，任务范围与执行模块就位",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["components.codes", "components.focus", "draftOrder.no"],
    simulated: true,
  },
  {
    roundNo: "③",
    title: "定位开工清单里唯一待确认项",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["components.codes", "siteEnv.airTempC"],
    simulated: true,
  },
  {
    roundNo: "④",
    /*
      ⚠ 这一轮有两处可见动作，**都不在浮层里**：
        ① 工单详情页按三段台词逐组展开（`script.ts` 的 reveal 声明）；
        ② 播报收尾由 executor 派发 `mumai:sync-backup` 弹出同步备份小窗。
      所以标 revealOnly（不叠演示浮层），否则就是"页面 + 浮层 + 小窗"三层打架。
    */
    title: "平台服务可访问，三类数据通道分别核对",
    surface: "order",
    revealOnly: true,
    dataKeys: ["components.codes", "mission.id", "map.version"],
    simulated: true,
  },
  {
    roundNo: "⑤",
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
    roundNo: "⑥",
    title: "工作台生成四张任务卡，第一张进入进行中",
    surface: "tasks",
    dataKeys: ["components.codes", "components.focus"],
    button: "在平台上标记已同步",
    simulated: true,
  },
  {
    roundNo: "⑦",
    /*
      用户文档第 7 条：「我按设备编号核对数据来源，确认平台显示的是本次设备数据，
      不串数据。发现异常立即叫停。」
      展示面用 `material`（本次采集的设备数据：段数 / 分辨率 / 构件编号）——
      正是"平台显示的这批数据"本身。
    */
    title: "按设备编号核对数据来源，确认是本次数据",
    surface: "material",
    dataKeys: ["material.videoCount", "material.resolutionText", "components.codes"],
    simulated: true,
  },
  {
    roundNo: "⑧",
    title: "打开环境补偿参数对比卡",
    surface: "params",
    dataKeys: ["siteEnv.airTempC", "siteEnv.relativeHumidityPct", "siteEnv.windSpeedMs"],
    button: "应用建议参数",
    simulated: true,
  },
  {
    roundNo: "⑨",
    title: "并排显示地图质量与视频通道状态",
    surface: "channels",
    dataKeys: ["map.version", "map.coveragePct", "map.resolutionM", "mission.routeLengthM"],
    simulated: true,
  },
  {
    roundNo: "⑩",
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
    roundNo: "⑪",
    title: "四柱卡片按风险重排并高亮 Z04",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["components.codes", "components.focus", "components.focusRegion"],
    simulated: true,
  },
  {
    roundNo: "⑫",
    title: "打开 Z04 原始证据查看器",
    surface: "evidence",
    dataKeys: ["components.focus", "anomaly.batchId"],
    simulated: true,
  },
  {
    roundNo: "⑬",
    /*
      用户口径（2026-09-17）：「⑬ 这个触发时，会弹出预警窗口，然后带个确认按钮」。
      所以这一轮不是普通数据面板，而是**预警窗**：`alert: true` 给警示描边与「预警」角标，
      `button` 给确认按钮 —— 两者缺一，`demoSurface.test.ts` 会红。

      ⚠ 展示的每一行都取真实数据键，不写死数字：
        · 重点构件 / 异常批次 / 特征偏移 —— 适用性预警就是由特征偏移触发的那条叙事；
        · 当前部署模型 —— 预警原因（`seed/scenario.ts` 的批次 `freezeReason`、
          `seed/deviceLogs.ts` 的 28:04 日志）说的正是"模型 DEMO-M02 缺少该批次
          木材的有效标定记录"，而 DEMO-M02 就是 `package.rollbackVersion`（未升级前的版本）。
      ⚠ 不挂统计口径的键（缺失帧、有效比例那些属于 ⑭ 的异常证据），避免两轮讲同一件事。
    */
    title: "适用性预警：Z04 当前批次诊断输出已冻结，请架构师确认",
    alert: true,
    surface: "anomaly",
    dataKeys: [
      "components.focus",
      "anomaly.batchId",
      "anomaly.featureShiftSigma",
      "package.rollbackVersion",
      "anomaly.conclusion",
    ],
    button: "确认收到",
    simulated: true,
  },
  {
    roundNo: "⑭",
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
    roundNo: "⑮",
    title: "生成四张本地任务卡（负责人 / 输入 / 完成条件）",
    surface: "tasks",
    dataKeys: ["anomaly.batchId", "anomaly.missingFrames", "components.focus"],
    simulated: true,
  },
  {
    roundNo: "⑯",
    title: "打开接收清单并筛选三条待审核记录",
    surface: "receipt",
    dataKeys: ["clean.rawCount", "material.missingFiles"],
    simulated: true,
  },
  {
    roundNo: "⑰",
    /*
      用户口径 2026-09-18：「…这个对话需要小木跳转到固件及模型，数据集，
      直接一步一步引导到人工核验」——**页面自己就是那个动作**（清洗流程逐拍推进到人工核验），
      再叠一层浮层就是「页面 + 浮层」打架（同 ②③④⑪⑳ 的处理）。
    */
    title: "数据清洗流程逐拍推进到人工核验",
    surface: "clean",
    revealOnly: true,
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
    roundNo: "⑱",
    /*
      用户文档第 18 条：「跟踪现场任务状态，同时打开归档版本的验证摘要。
      两项记录已分开显示。」—— 展示面用 `review`（左右分栏），
      左栏现场任务、右栏归档验证记录，正好对应"两项记录分开显示"。
    */
    title: "现场任务与归档验证记录分开显示",
    surface: "review",
    dataKeys: ["delivery.total", "delivery.passed", "delivery.missing"],
    simulated: true,
  },
  {
    roundNo: "⑲",
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
    roundNo: "⑳",
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
      ⚠ 同 ④：浮层不显示了，就不再挂浮层按钮。
      "不得真实刷写"这条约束没有丢，它由两层保证 ——
      ① 工具门槛（高风险工具剧本一律不执行，由 验剧本工具链 工装核对）；
      ② 台词自己只说"收到版本信息后还要检查自检结果"，没有任何"已刷写"的说法。
    */
    simulated: true,
  },
  {
    roundNo: "㉑",
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
    roundNo: "㉒",
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
    roundNo: "㉓",
    title: "跳转工单草稿页，附件、范围、证据与审核栏就位",
    surface: "order",
    /* 这一轮的页面动作就是工单详情页本身（逐组展开），不再叠加浮层 —— 现场实测会像两个页面打架 */
    revealOnly: true,
    dataKeys: ["draftOrder.no", "components.focusRegion", "delivery.total"],
    simulated: true,
  },
  {
    roundNo: "㉔",
    title: "打开复盘页，左右分栏显示已验证与待处理",
    surface: "review",
    /* 这一轮会跳到工单详情页（剧本里有 nav + reveal），不再叠浮层 */
    revealOnly: true,
    dataKeys: ["delivery.total", "delivery.passed", "delivery.missing", "delivery.summaryMismatch"],
    simulated: true,
  },
  {
    roundNo: "㉕",
    title: "打开交付摘要并自动筛选三项待办",
    surface: "delivery",
    /* 这一轮会跳到工单详情页（剧本里有 nav + reveal），不再叠浮层 */
    revealOnly: true,
    dataKeys: ["delivery.total", "delivery.passed", "delivery.missing", "delivery.summaryMismatch"],
    simulated: true,
  },
]);

/** 按圈号取动作（找不到返回 null，调用方决定如何处理） */
export function actionFor(roundNo: string): DemoAction | null {
  return DEMO_ACTIONS.find((a) => a.roundNo === roundNo) ?? null;
}
