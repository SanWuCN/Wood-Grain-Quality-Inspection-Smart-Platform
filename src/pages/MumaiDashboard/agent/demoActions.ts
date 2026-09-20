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

/**
 * 通道巡查窗口（⑨）的轮次号。
 *
 * 这个窗口有两个打开方式，都指向**同一份**表面与同一轮声明：
 *   · 小木 ⑨ 说完「已开启通道巡查…」时自动弹出（`executor`）；
 *   · 人自己点建图巡航页上的「通道巡查」按钮（剧本 §102：
 *     「等待时选用：小车继续建图，**史在平台开启数据通道巡查**」）。
 * 页面不写死 `"⑨"` 这个字面量，就是这个常量的用处。
 */
export const CHANNEL_PATROL_ROUND_NO = "⑨";

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
   * 这一轮的可见动作是**切数字孪生主视图**（不是弹浮层，也不是工单页逐组展开）。
   *
   * ── 为什么要一个声明字段（用户 2026-10-01）──────────────────────────
   * ㉒ 的台词是「证据对照已打开。两路共同提示的项目优先展示…」——
   * 页面动作就该是"把证据对照那一屏打开"。原先这件事写成 `executor` 里一句
   * `if (round.roundNo === "㉒")`，于是"标了 revealOnly 却没有页面揭示声明"
   * 这条自检把它当成孤儿轮次（既没浮层也没动作）。
   * 改成声明式之后：`demoActions.test.ts` 能统一判「revealOnly 的轮次必须有
   * `reveal` 或 `viewSwitch`」，executor 也只按声明办事，不再认识某个轮号。
   */
  viewSwitch?: "twin-evidence" | "twin-internal-cloud";
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
        ① 工单详情页按台词逐组展开（`script.ts` 的 reveal 声明）；
        ② 播报收尾由 executor 派发 `mumai:sync-backup` 弹出**同步备份小窗**
           （用户 2026-09-18 口径：「小木：收到，已启用同步备份，然后展开一个动态备份窗口做显示」）。
      所以标 revealOnly（不叠演示浮层），否则就是"页面 + 浮层 + 小窗"三层打架。
    */
    title: "启用同步备份，弹出动态备份小窗",
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
    /*
      这一轮的页面动作就是**执行工作台本身**（`/workbench`）：卡片由 ⑥ 幂等生成，
      并按 `script.ts` 的 `reveal.workbench-cards` 逐张铺开。
      原先这里还叠一个浮层（标题「工作台生成四张任务卡」）——页面已经跳过去了，
      旁边再挂一句同样的话就是"两个页面打架"（与 ②③④⑪⑳ 同一处处理）。
    */
    title: "执行工作台生成「开工四项」任务卡（执行人 / 输入 / 完成条件）",
    surface: "tasks",
    revealOnly: true,
    dataKeys: ["components.codes", "components.focus"],
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
    /*
      ── 剧本 §104 的「弹出个监听窗口」────────────────────────────────
      原文：小木「已开启通道巡查，我会先查看当前建图效果，然后通过小车视频流
      分析现场情况。（弹出个监听窗口）」
      所以这个窗口要同时给出**两路**：建图效果（版本 / 覆盖率 / 分辨率 / 航线长度）
      与视频通道（状态 / 延迟 / 来源）+ 地图与位姿的刷新时间。
      原先只列了 `map.*` 与航线长度，标题却写着"地图质量与视频通道状态" ——
      窗口里压根没有视频那一行（用户口径："该有展示的地方要真的有"）。
    */
    title: "通道巡查 · 监听窗口：建图效果与现场视频流",
    surface: "channels",
    dataKeys: [
      "map.version",
      "map.coveragePct",
      "map.resolutionM",
      "mission.routeLengthM",
      "channels.mapAgeSec",
      "channels.poseAgeSec",
      "channels.videoState",
      "channels.videoAgeSec",
      "channels.videoSource",
    ],
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
    /*
      同 ⑥：这一轮的可见动作就是**执行工作台**上的四张卡（异常适配那一批），
      跟着台词一句一张地铺开。卡片存在服务端（`taskCard` 实体），不是"本地卡片"——
      换台电脑看到的是同一份，所以标题里不再写"本地"。
    */
    title: "执行工作台生成「异常适配四项」任务卡（执行人 / 输入 / 完成条件）",
    surface: "tasks",
    revealOnly: true,
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

      ⚠ 2026-10-01 改落点 + 加操作（用户：「针对一些只有跳转不太合适的对话加上特殊页面或操作」）：
        这一轮原来落在「固件及模型 · 训练验证」——可讲的是**归档版本**的验证摘要，
        那一页上没有这张摘要，观众只看到"跳了一页 + 弹一个浮层"。
        现在落在**报告归档页**（交付清单 10 组 24 项 + 校验结果：一致 / 缺失 / 摘要不一致
        + 逐项 SHA-256），并带 `nav.op: "archive-verify"`：跳过去**把真实的交付文件校验
        跑一遍**（那一页默认写着「尚未运行校验」）。所以这一轮屏幕上同时有：
        页面里的真实验证摘要（服务端逐项比对）+ 浮层里的"现场任务 / 归档验证"分栏。
    */
    title: "报告归档页：真实验证摘要（24 项校验结果）+ 现场任务与归档记录分栏",
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
    /*
      ⑳ 的页面动作是**固件及模型 · 更新交付**（`script.ts` 的 nav 已指过去）：
      交付包、下载与接收、以及「回验与取用记录」（版本回执 + 自检结论）都在那一屏。
      所以浮层重新挂上（不再是 revealOnly —— 那一页没有"逐块展开"的语义，
      这一轮讲的是**等待**），标题也跟着改：不再说"工单页"。
      ⚠ "不得真实刷写"这条约束由两层保证：
        ① 工具门槛（高风险工具剧本一律不执行，由 验剧本工具链 工装核对）；
        ② 台词自己只说"收到版本信息后还要检查自检结果"，没有任何"已刷写"的说法。
    */
    title: "更新交付页：交付包与目标版本就位，等设备回执",
    surface: "deploy",
    dataKeys: [
      "package.id",
      "package.sizeMb",
      "package.targetVersion",
      "package.rollbackVersion",
      "package.selfCheckPassed",
    ],
    /*
      ⚠ 同 ④：这一轮的风险边界不变 —— "不得真实刷写"由工具门槛与台词本身保证
      （见上面标题旁那段说明），浮层只是把交付包与目标版本摆出来。
    */
    simulated: true,
  },
  {
    roundNo: "㉑",
    /*
      ⚠ 2026-10-01 改成 revealOnly（用户：「针对一些只有跳转不太合适的对话加上
        特殊页面或操作」）：这一轮的可见动作现在是**页面本身** ——
        融合分析页四块跟着台词逐段跑出来（`script.ts` 的 reveal: fusion-flow，
        状态在 `fusionReveal.ts`，页面侧是 `adaptTabs.tsx` 的 FusionTab）。
        页面已经在演"流程被调用"，再叠一张浮层就是两处讲同一件事（同 ②③④⑥⑪⑰）。
    */
    title: "融合分析页逐段跑出：输入校验 → 图像标注 → 雷达分析 → 测区融合",
    surface: "fusion",
    revealOnly: true,
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
    title: "证据对照页：两路共同提示优先展示 + 补核清单",
    surface: "evidence",
    /*
      这一轮的页面动作就是**证据对照那一屏本身**（数字孪生主视图的第三个页签，
      视觉 ↔ 雷达 ↔ 凭什么算一致 + 补核清单 + 资料完整性），所以不再叠浮层 ——
      `revealOnly: true` 与 ㉓㉔㉕ 同一条口径。

      ⚠ 原先这里会弹一张「显示两张优先复核与一张待补采证据卡」的浮层，
        用户 2026-10-01 追加"要做具体的东西"之后，那张浮层正好**盖住**对照表
        （实测截图：表头看得见、表体被浮层压住）。同一件事不再画两遍。
    */
    revealOnly: true,
    /* 播完切到数字孪生主视图的「证据对照」那一屏（executor 按这个声明办事） */
    viewSwitch: "twin-evidence",
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
