/**
 * 小木语音智能体 · 意图库（技术方案 §13 / §38 / §39 / §40）
 *
 * 意图条数 = PRD 4.2 意图目录的 14 条（docs/prd-gap-analysis.md §4 R-4.2.1 指出原实现只有 10 条）
 *          + 第二章剧本要求的 7 条平台与小车控制意图（介绍平台 / 打开页面 / 查看工单 /
 *            打开 Z04 证据 / 查看四柱 / 查看回波 / 小车移动 / 开始巡检 / 停止 / 返回起点 /
 *            开始建图 / 查看批次 / 问设备状态）。
 *
 * 约束：所有业务文本与数字都来自 seed/scenario.ts，本文件只放「意图配置 + 模板」，
 * 模板里的 {占位符} 由 facts.ts 从 seed 里取真实值填充；一个数字都不在这里硬编码。
 *
 * 命名说明（方案 §18）：技术方案里 type 用大写枚举（RESPONSE / NAVIGATION / ACTION /
 * QUERY / AGENT），PRD §4.2 与 seed 用中文类型名（查询 / 解读 / 导航 / 操作 / 编排）。
 * 两者是同一套东西，这里以方案的大写枚举为准（IntentType），中文名见 TYPE_LABEL。
 */

import { XIAOMU_INTENTS } from "../seed/scenario";
import { indexBy } from "./lang";

/** 语义路由的五种出口（技术方案 §18） */
export type IntentType = "RESPONSE" | "NAVIGATION" | "ACTION" | "QUERY" | "AGENT";

export const TYPE_LABEL: Record<IntentType, string> = {
  RESPONSE: "固定回复",
  NAVIGATION: "页面导航",
  ACTION: "单步操作",
  QUERY: "数据查询",
  AGENT: "多步编排",
};

/** 置信度分级（技术方案 §15 / §41） */
export type ConfidenceLevel = "rule" | "high" | "low" | "fallback";

/** 槽位（技术方案 §17：Intent 只知道「做什么」，槽位补上「对谁做、在哪做」） */
export type SlotKind =
  | "pillar"
  | "zone"
  | "risk"
  | "order"
  | "batch"
  | "page"
  | "scene"
  | "map"
  | "number";

export type Slot = {
  name: string;
  kind: SlotKind;
  required: boolean;
  /** 喂给界面与槽位解析的提示，例如「构件编号 Z01–Z04」 */
  hint: string;
};

/** 回复（技术方案 §28 / §29 / §30） */
export type IntentResponse = {
  /** 模板文本，{key} 由 facts.ts 渲染 */
  text: string;
  /**
   * 同一意图的多个说法（方案 §30：同一意图准备多个版本随机播放，降低机械感）。
   * 只在 alternatives 之间随机，不会改变事实占位符。
   */
  alternatives?: string[];
  /**
   * 预留的预录音频路径（方案 §29：固定内容优先播放提前生成的音频）。
   * 本演示仓库内没有音频素材，因此实际播放前会先判断文件是否存在，
   * 不存在则回落到浏览器本地 speechSynthesis（方案 §31 的混合模式）。
   */
  audio?: string;
  /** 回复里要展示的事实键，顺序即展示顺序 */
  facts: string[];
};

/** 单步动作（方案 §39 / §40） */
export type IntentAction = {
  tool: string;
  params: Record<string, string>;
};

/** 多步任务的预置 plan（方案 §23）；也允许 planner 现算，见 planner.ts */
export type IntentPlan = {
  goal: string;
  steps: { tool: string; args: Record<string, string>; note: string }[];
};

export type Intent = {
  id: string;
  name: string;
  type: IntentType;
  /** 技术方案 §12：同一意图要覆盖多种自然语言说法，examples 就是向量化的语料 */
  examples: string[];
  slots: Slot[];
  response: IntentResponse;
  action?: IntentAction;
  /** 多步任务直接给出 plan；query 类可省 */
  plan?: IntentPlan;
  /** 高风险动作执行前必须二次确认（方案 §42），确认文案 |
   *  默认取 tools.ts 里的 requireConfirmation，这里用于覆盖措辞 */
  confirmText?: string;
};

/** 无命中回复（PRD 4.2 指定文案，方案 §41） */
export const FALLBACK_TEXT = "我没有理解你的指令，可以换一种说法。";
/** 兜底时可选的下一步（PRD 4.2：可查询巡检资料、查看构件或启动当前业务流程） */
export const FALLBACK_HINT = "可查询巡检资料、查看构件或启动当前业务流程";

/* ------------------------------------------------------------------ *
 * 意图库
 * ------------------------------------------------------------------ */

export const INTENTS: Intent[] = [
  /* ---------- PRD 4.2 意图目录 14 条 ---------- */
  {
    id: "history_summary",
    name: "查历史巡检风险汇总",
    type: "QUERY",
    examples: [
      "查今年五月示例寺巡检",
      "五月巡检发现几个风险",
      "五月那轮巡检一共查出多少处问题",
      "历史巡检的报告给我看一下",
      "上一次巡检发现的风险都处理完了吗",
    ],
    slots: [],
    response: {
      text:
        "共 {total} 处风险，施工反馈完成 {reportedDone} 处，验收关闭 {closed} 处，尚未关闭 {open} 处。" +
        "{followup}",
      alternatives: [
        "五月巡检汇总：共 {total} 处风险，施工反馈完成 {reportedDone} 处，验收关闭 {closed} 处，尚未关闭 {open} 处。{followup}",
        "已读取历史巡检报告，风险 {total} 处，反馈完成 {reportedDone} 处，验收关闭 {closed} 处，尚未关闭 {open} 处。{followup}",
      ],
      facts: ["total", "reportedDone", "closed", "open", "followup"],
    },
  },
  {
    id: "open_history_scene",
    name: "打开历史高斯场景",
    type: "NAVIGATION",
    examples: [
      "打开当时的高斯场景",
      "把五月那次的高斯场景调出来",
      "我要看历史三维场景",
      "回到当时采集的那个视角",
      "打开旧场景对比一下外观",
    ],
    slots: [{ name: "scene", kind: "scene", required: false, hint: "历史场景 scene-May" }],
    response: {
      text:
        "{sceneTitle} 已打开（{sceneVersion}，关键帧 {sceneKeyframes}）。历史书签：{sceneBookmarks}；" +
        "书签选择需要在页面内点击，语音只负责跳转到该场景所在页面。",
      alternatives: [
        "已定位 {sceneTitle}（{sceneVersion}），历史书签为 {sceneBookmarks}。",
      ],
      facts: ["sceneTitle", "sceneVersion", "sceneKeyframes", "sceneBookmarks"],
    },
    action: { tool: "open_scene", params: { scene: "{scene}" } },
  },
  {
    id: "unresolved_followup",
    name: "查未关闭项与下一步",
    type: "QUERY",
    examples: [
      "还有几个没处理完",
      "剩下的那几处怎么处理",
      "未关闭的风险还有哪些",
      "剩下的问题下一步做什么",
      "还没闭环的有哪几个",
    ],
    slots: [],
    response: {
      text: "尚未关闭 {open} 处：{items}",
      alternatives: ["还有 {open} 处没闭环：{items}", "未关闭 {open} 处，下一步分别是：{items}"],
      facts: ["open", "items"],
    },
  },
  {
    id: "site_weather",
    name: "查近三个月天气档案",
    type: "QUERY",
    examples: [
      "查近三个月天气",
      "最近三个月的天气怎么样",
      "这段时间下雨多不多",
      "环境采集时的天气档案在哪",
      "梅雨期的降水记录给我看看",
    ],
    slots: [],
    response: {
      text:
        "归档天气档案（{weatherRange}）：{weatherSummary}。数据来源：{weatherSource}；" +
        "这是归档数据，不是实时联网查询。",
      alternatives: [
        "近三个月天气来自归档档案（{weatherRange}）：{weatherSummary}。来源：{weatherSource}。",
      ],
      facts: ["weatherRange", "weatherSummary", "weatherSource"],
    },
  },
  {
    id: "compare_columns",
    name: "比较四根木柱",
    type: "QUERY",
    examples: [
      "比较四根木柱",
      "四根柱子的情况对比一下",
      "哪根柱子问题最大",
      "按可见异常给我一个优先复核顺序",
      "四柱体检结果排个序",
    ],
    slots: [],
    response: {
      text:
        "{radarNote}按可见异常，优先复核顺序是 {orderFirst}，其次 {orderRest}。{z04Note}",
      alternatives: [
        "{radarNote}建议先复核 {orderFirst}，再依次看 {orderRest}。{z04Note}",
      ],
      facts: ["radarNote", "orderFirst", "orderRest", "z04Note"],
    },
  },
  {
    id: "anomaly_summary",
    name: "汇总异常并生成补采清单",
    type: "ACTION",
    examples: [
      "汇总异常并生成任务",
      "把异常记录汇总成检查清单",
      "异常排查的结论是什么",
      "生成补采检查清单",
      "这批异常要怎么排查",
    ],
    slots: [],
    response: {
      text: "{anomalyId}：{anomalyDetail} 处理结论：{nextActions}",
      alternatives: ["异常记录 {anomalyId}（{anomalyDetail}）；建议动作：{nextActions}"],
      facts: ["anomalyId", "anomalyDetail", "nextActions"],
    },
    action: { tool: "navigate_page", params: { route: "/adapt" } },
  },
  {
    id: "clean_dataset",
    name: "启动清洗并列出待审核",
    type: "ACTION",
    examples: [
      "启动清洗并列出待审核",
      "把样本清洗一遍",
      "清洗数据集看看留下多少条",
      "有哪些样本需要人工审核",
      "跑一次数据清洗流程",
    ],
    slots: [],
    response: {
      text: "清洗流程共 {cleanSteps}；产生待审核记录 {reviewCount}。",
      alternatives: ["清洗完成：{cleanSteps}，待审核 {reviewCount}。"],
      facts: ["cleanSteps", "reviewCount"],
    },
    action: { tool: "navigate_page", params: { route: "/adapt", tab: "dataset" } },
  },
  {
    id: "prepare_split",
    name: "生成数据集划分",
    type: "ACTION",
    examples: [
      "生成数据集划分",
      "按物理样本分组切训练集和测试集",
      "数据集怎么划分的",
      "把数据集分成训练验证测试三份",
      "帮我划分数据集",
    ],
    slots: [],
    response: {
      text:
        "{datasetLabel}（索引 {datasetIndex}，冻结时间 {datasetFrozenAt}）划分为：{splitText}；" +
        "人工审核 {reviewState}。",
      alternatives: [
        "{datasetLabel} 的划分是 {splitText}，索引 {datasetIndex}，审核 {reviewState}。",
      ],
      facts: ["datasetLabel", "datasetIndex", "datasetFrozenAt", "splitText", "reviewState"],
    },
    action: { tool: "open_panel", params: { panel: "dataset" } },
  },
  {
    id: "compare_models",
    name: "对比新旧模型",
    type: "QUERY",
    examples: [
      "对比新旧模型",
      "新模型比旧模型好多少",
      "训练验证的指标怎么样",
      "把两个版本的评估结果拿出来比一比",
      "DEMO-M02b 的离线验证过了吗",
    ],
    slots: [],
    response: {
      text:
        "在 {experimentTitle} 上，{metrics}；验收规则 {acceptance}。",
      alternatives: [
        "{experimentTitle}：{metrics}。验收情况：{acceptance}。",
      ],
      facts: ["experimentTitle", "metrics", "acceptance"],
    },
    action: { tool: "navigate_page", params: { route: "/adapt", tab: "training" } },
  },
  {
    id: "deployment_check",
    name: "检查是否可以部署",
    type: "QUERY",
    examples: [
      "检查是否可以部署",
      "这个更新包能下发吗",
      "部署前还有哪些条件没满足",
      "兼容性检查结果如何",
      "烧录能力这一项通过了吗",
    ],
    slots: [],
    response: {
      text:
        "{packageId}（{packageKind}）：审核 {reviewState}；兼容性检查 {compatPass} 项通过、{compatBlock} 项阻断。{blockNote}",
      alternatives: [
        "{packageId} 的部署检查结果：审核 {reviewState}，兼容性 {compatPass} 通过 / {compatBlock} 阻断。{blockNote}",
      ],
      facts: ["packageId", "packageKind", "reviewState", "compatPass", "compatBlock", "blockNote"],
    },
  },
  {
    id: "run_fusion",
    name: "分析本批次并融合结果",
    type: "ACTION",
    examples: [
      "分析本批次并融合结果",
      "把雷达和视觉两路结果融合一下",
      "融合分析的结论是什么",
      "跑一次多模态融合",
      "两路证据对得上吗",
    ],
    slots: [{ name: "batch", kind: "batch", required: false, hint: "复扫批次 scan-Z04-002" }],
    response: {
      text:
        "{fusionRecordId}（规则 {fusionRule}，批次 {fusionBatch}）已生成，输出 {outputs}；" +
        "融合是规则判定，不做分数相加。",
      alternatives: [
        "融合记录 {fusionRecordId} 已生成（规则 {fusionRule}）：{outputs}。",
      ],
      facts: ["fusionRecordId", "fusionRule", "fusionBatch", "outputs"],
    },
    action: { tool: "navigate_page", params: { route: "/adapt", tab: "fusion" } },
  },
  {
    id: "open_evidence",
    name: "打开 Z04 下部记录",
    type: "NAVIGATION",
    examples: [
      "打开Z04下部的记录",
      "把四号柱下面的检测记录调出来",
      "我要看 Z04 的原始记录",
      "Z04 下部测区的证据在哪里",
      "调出金柱 Z04 的检测档案",
    ],
    slots: [
      { name: "pillar", kind: "pillar", required: false, hint: "构件编号 Z01–Z04，缺省 Z04" },
      { name: "zone", kind: "zone", required: false, hint: "测区，例如 Z04-lower" },
    ],
    response: {
      text:
        "已打开 {componentName}（{zoneId}）：图像 {evidenceImages}，回波峰值 {echoPeak}（{echoNote}）。" +
        "{historyNote}",
      alternatives: [
        "{componentName}（{zoneId}）的记录已打开：图像 {evidenceImages}，回波峰值 {echoPeak}。{historyNote}",
      ],
      facts: ["componentName", "zoneId", "evidenceImages", "echoPeak", "echoNote", "historyNote"],
    },
    action: {
      tool: "focus_component",
      params: { component: "{pillar}", zone: "{zone}" },
    },
  },
  {
    id: "draft_workorder",
    name: "生成复核工单草稿",
    type: "ACTION",
    examples: [
      "生成复核工单",
      "按这次的风险建一个工单",
      "帮我把复核工单草稿建起来",
      "生成工单等经理确认",
      "根据 Z04 的检测结果开单",
    ],
    slots: [],
    response: {
      text:
        "工单草稿 {orderId} 已生成，等级 {priority}，附件 {attachments}；" +
        "草稿需要经理确认后才进入待复核。",
      alternatives: [
        "{orderId} 草稿已生成（{priority}），附件 {attachments}。",
      ],
      facts: ["orderId", "priority", "attachments"],
    },
    action: { tool: "open_order", params: { order: "draft" } },
  },
  {
    id: "create_revisit",
    name: "安排下次复巡",
    type: "ACTION",
    examples: [
      "安排下次复巡",
      "复巡计划定在哪一天",
      "把复巡计划下发下去",
      "下次什么时候再来复测",
      "复巡要检查哪些点位",
    ],
    slots: [],
    response: {
      text:
        "复巡计划 {planId}：日期 {planDate}，地图版本 {planMap}，点位 {planCheckpoints}；" +
        "当前状态 {planStatus}。",
      alternatives: [
        "{planId} 已保存：{planDate}，基于 {planMap}，点位 {planCheckpoints}，状态 {planStatus}。",
      ],
      facts: ["planId", "planDate", "planMap", "planCheckpoints", "planStatus"],
    },
    action: { tool: "open_panel", params: { panel: "revisit" } },
  },

  /* ---------- 第二章剧本新增：平台介绍与页面导航 ---------- */
  {
    id: "introduce_platform",
    name: "介绍平台",
    type: "RESPONSE",
    examples: [
      "介绍一下这套系统",
      "介绍一下这个平台",
      "你们这个项目是干什么的",
      "这个平台主要实现什么功能",
      "木脉智检是做什么的",
    ],
    slots: [],
    response: {
      text:
        "{platformCopy}当前演示场景：{scenarioTitle}（{scenarioId}）；业务日期 {businessDate}，" +
        "全程阶段共 {stageCount} 个，已完成到「{stageLabel}」。本平台不部署本地大模型，" +
        "小木按意图目录调用白名单工具，回复用模板加真实工具结果。",
      alternatives: [
        "{platformCopy}本次演示是 {scenarioTitle}，业务日期 {businessDate}，共 {stageCount} 个阶段，当前阶段「{stageLabel}」。",
      ],
      facts: [
        "platformCopy",
        "scenarioTitle",
        "scenarioId",
        "businessDate",
        "stageCount",
        "stageLabel",
      ],
    },
  },
  {
    id: "open_page",
    name: "打开某个页面",
    type: "NAVIGATION",
    examples: [
      "打开地图",
      "我要看地图",
      "打开知识库",
      "进入工单档案",
      "帮我打开巡检任务页面",
      "让我看看数字孪生",
      "打开演示控制台",
      "进入报告归档页面",
    ],
    slots: [{ name: "page", kind: "page", required: true, hint: "页面名，例如地图 / 知识库 / 工单档案" }],
    response: {
      text: "好的，正在打开{pageLabel}。",
      alternatives: ["{pageLabel}已经打开。", "正在跳转到{pageLabel}。"],
      facts: ["pageLabel"],
    },
    action: { tool: "navigate_page", params: { route: "{route}" } },
  },
  {
    id: "view_current_order",
    name: "查看当前工单",
    type: "QUERY",
    examples: [
      "查看当前工单",
      "现在的工单是什么",
      "当前工单进度到哪了",
      "这个工单谁负责",
      "把当前工单的状态调出来",
    ],
    slots: [{ name: "order", kind: "order", required: false, hint: "工单号，例如 SH-2026-0901" }],
    response: {
      text:
        "{orderId}（{orderTitle}）：状态 {orderStatus}，负责人 {orderOwner}，等级 {orderLevel}，" +
        "构件 {orderComponents}，附件 {orderAttachments}。范围：{orderScope}。",
      alternatives: [
        "当前工单 {orderId} 状态 {orderStatus}，负责人 {orderOwner}，构件 {orderComponents}。",
      ],
      facts: [
        "orderId",
        "orderTitle",
        "orderStatus",
        "orderOwner",
        "orderLevel",
        "orderComponents",
        "orderAttachments",
        "orderScope",
      ],
    },
    action: { tool: "open_order", params: { order: "{order}" } },
  },
  {
    id: "view_four_pillars",
    name: "查看四柱状态",
    type: "QUERY",
    examples: [
      "查看四柱状态",
      "四根柱子的雷达响应是多少",
      "四柱的构件档案给我",
      "Z01 到 Z04 现在什么状态",
      "柱子的材种和直径是多少",
    ],
    slots: [],
    response: {
      text: "{pillarTable}本轮风险来自 {riskIds}；Z04 雷达响应 {z04Radar}（{z04Visible}）。",
      alternatives: [
        "{pillarTable}本轮共 {riskCount} 条风险：{riskIds}，其中 Z04 雷达响应 {z04Radar}。",
      ],
      facts: ["pillarTable", "riskIds", "z04Radar", "z04Visible", "riskCount"],
    },
    action: { tool: "navigate_page", params: { route: "/twin", component: "{pillar}" } },
  },
  {
    id: "view_echo",
    name: "查看回波",
    type: "QUERY",
    examples: [
      "查看回波",
      "回波曲线在哪看",
      "给我看看雷达回波",
      "复扫批次的频谱曲线打开一下",
      "这个频点上有多大的响应",
    ],
    slots: [
      { name: "batch", kind: "batch", required: false, hint: "批次号，例如 scan-Z04-002" },
      { name: "pillar", kind: "pillar", required: false, hint: "构件编号，缺省 Z04" },
    ],
    response: {
      text:
        "{waveBatch} 的回波（{waveAxis}，单位 {waveUnit}）：峰值位于频点索引 {echoPeakIndex}，" +
        "归一化幅值 {echoAmplitude}；标记点 {waveMarkers}。{echoNote}",
      alternatives: [
        "{waveBatch} 回波峰值频点 {echoPeakIndex}，幅值 {echoAmplitude}（单位 {waveUnit}）；标记：{waveMarkers}。",
      ],
      facts: [
        "waveBatch",
        "waveAxis",
        "waveUnit",
        "echoPeakIndex",
        "echoAmplitude",
        "waveMarkers",
        "echoNote",
      ],
    },
    action: { tool: "navigate_page", params: { route: "/adapt", tab: "capture", batch: "{batch}" } },
  },
  /* ---------- 第二章剧本新增：小车与建图控制 ---------- */
  {
    id: "robot_move",
    name: "让小车去指定柱",
    type: "ACTION",
    examples: [
      "让小车去一号木柱",
      "让小车去二号木柱",
      "让机器人开到三号柱",
      "把小车派到四号木柱",
      "让小车去 Z02 观察点",
      "小车去一号柱",
      "让小车移动过去",
    ],
    slots: [
      { name: "pillar", kind: "pillar", required: true, hint: "构件编号 Z01–Z04" },
      { name: "speed", kind: "number", required: false, hint: "速度，单位 m/s" },
    ],
    response: {
      text: "好的，正在让小车前往{targetLabel}（{waypointLabel}，{distance}）。",
      alternatives: ["已下发导航目标：{targetLabel}（{waypointLabel}）。", "小车正在前往{targetLabel}。"],
      facts: ["targetLabel", "waypointLabel", "distance"],
    },
    action: { tool: "robot_move", params: { target: "{pillar}", speed: "{speed}" } },
  },
  {
    id: "start_patrol",
    name: "开始巡检",
    type: "ACTION",
    examples: [
      "开始巡检",
      "让小车开始巡检",
      "启动巡检任务",
      "按计划把巡检跑起来",
      "开始执行巡视任务",
    ],
    slots: [],
    response: {
      text: "已开始执行巡检任务 {missionId}（{missionRobot}，{missionSpeed}）。",
      alternatives: ["巡检任务 {missionId} 已进入执行中，{missionSpeed}。"],
      facts: ["missionId", "missionRobot", "missionSpeed"],
    },
    action: { tool: "start_patrol", params: {} },
  },
  {
    id: "robot_stop",
    name: "停止 / 急停",
    type: "ACTION",
    examples: ["停止", "停下", "停止巡检", "让小车停下来", "别动", "紧急停止", "暂停当前任务"],
    slots: [],
    response: {
      text: "已下发停止指令，巡检任务 {missionId} 状态 {missionState}，小车当前位置 {robotPosition}。",
      alternatives: ["已停止。{missionId} 状态 {missionState}，位置 {robotPosition}。"],
      facts: ["missionId", "missionState", "robotPosition"],
    },
    action: { tool: "robot_stop", params: {} },
  },
  {
    id: "cancel_patrol",
    name: "取消巡检任务",
    type: "ACTION",
    examples: ["取消当前任务", "取消巡检", "这个任务不做了，取消掉"],
    slots: [],
    response: {
      text: "巡检任务 {missionId} 已取消，状态 {missionState}；已到达点位仍保留在任务记录里。",
      alternatives: ["{missionId} 已取消（{missionState}），已到达点位保留记录。"],
      facts: ["missionId", "missionState"],
    },
    action: { tool: "cancel_patrol", params: {} },
  },
  {
    id: "robot_return_home",
    name: "让小车返回起点",
    type: "ACTION",
    examples: [
      "让小车回来",
      "让机器人返回起点",
      "回到起点",
      "让小车返回充电站",
      "让小车回殿门",
    ],
    slots: [],
    response: {
      text: "好的，正在让小车返回 {homeLabel}（电池 {battery}），到位后任务状态为 {missionState}。",
      alternatives: ["已下发返航指令，目标 {homeLabel}，电池 {battery}。"],
      facts: ["homeLabel", "battery", "missionState"],
    },
    action: { tool: "robot_return_home", params: {} },
  },
  {
    id: "start_mapping",
    name: "开始建图",
    type: "ACTION",
    examples: ["开始建图", "让小车开始扫描建图", "启动 SLAM 建图", "重新建一张地图", "开始构图"],
    slots: [],
    response: {
      text: "已开始建图，基于 {mapId}（分辨率 {mapResolution}m，覆盖 {mapCoverage}，状态 {mapState}）。",
      alternatives: ["建图已启动：{mapId}，分辨率 {mapResolution}m，覆盖 {mapCoverage}。"],
      facts: ["mapId", "mapResolution", "mapCoverage", "mapState"],
    },
    action: { tool: "start_mapping", params: {} },
  },
  {
    id: "load_map",
    name: "装载地图版本",
    type: "ACTION",
    examples: ["装载地图版本", "换成本轮那张地图", "把 MAP-SH-06 载入进来", "切换地图到上一轮版本"],
    slots: [{ name: "map", kind: "map", required: false, hint: "地图版本号，例如 MAP-SH-06" }],
    response: {
      text: "已装载 {mapId}（{mapResolution}m，覆盖 {mapCoverage}，更新于 {mapUpdatedAt}）。",
      alternatives: ["地图已切换为 {mapId}，{mapResolution}m，覆盖 {mapCoverage}。"],
      facts: ["mapId", "mapResolution", "mapCoverage", "mapUpdatedAt"],
    },
    action: { tool: "load_map", params: { map: "{map}" } },
  },
  {
    id: "view_batch",
    name: "查看采集批次",
    type: "QUERY",
    examples: [
      "查看复扫批次",
      "打开 scan-Z04-002 这批数据",
      "初扫批次的接收情况怎么样",
      "这个批次为什么冻结了",
      "采集批次回传了多少帧",
    ],
    slots: [{ name: "batch", kind: "batch", required: false, hint: "批次号，例如 scan-Z04-001 / scan-Z04-002" }],
    response: {
      text:
        "{batchId}（{batchRound} · {batchComponent} {batchZone}，模型 {batchModel}）：" +
        "雷达 {radarReceive}，图像 {imageReceive}，结果文件 {resultReceive}；冻结状态 {batchFrozen}。",
      alternatives: [
        "{batchId}（{batchRound}）：雷达 {radarReceive}、图像 {imageReceive}、结果 {resultReceive}，冻结 {batchFrozen}。",
      ],
      facts: [
        "batchId",
        "batchRound",
        "batchComponent",
        "batchZone",
        "batchModel",
        "radarReceive",
        "imageReceive",
        "resultReceive",
        "batchFrozen",
      ],
    },
    action: { tool: "navigate_page", params: { route: "/adapt", tab: "capture", batch: "{batch}" } },
  },
  {
    id: "device_status",
    name: "查询设备状态",
    type: "QUERY",
    examples: [
      "小车现在电量多少",
      "设备状态怎么样",
      "机器人现在在哪",
      "四路通道都正常吗",
      "手柄采集端在线吗",
      "现在连的是演示车还是实机",
    ],
    slots: [],
    response: {
      text:
        "{robotName}：电量 {battery}，位置 {robotPosition}，任务 {missionId} 状态 {missionState}；" +
        "通道 {channelSummary}；采集端 {scannerName}（{scannerMode}），数据来源 {sourceLabel}。",
      alternatives: [
        "{robotName} 电量 {battery}，位于 {robotPosition}，任务状态 {missionState}；通道：{channelSummary}。",
      ],
      facts: [
        "robotName",
        "battery",
        "robotPosition",
        "missionId",
        "missionState",
        "channelSummary",
        "scannerName",
        "scannerMode",
        "sourceLabel",
      ],
    },
    action: { tool: "get_robot_status", params: {} },
  },
];

/* ------------------------------------------------------------------ *
 * 多步任务（方案 §23 / §24）
 *
 * 这类请求的共同点：一句话里出现「先…再…然后…最后」或并列的多个动作，
 * 单个意图放不下，交给 planner 逐步规划执行。
 * 它也有自己的 examples —— 否则「让小车先去一号木柱，再绕一圈，然后回来」
 * 这类长句会因为覆盖率低而掉到 Fallback（tools/agent-calib.mts 里能看到这一点）。
 * ------------------------------------------------------------------ */

export const AGENT_TASK_ID = "robot_patrol_route";

export const AGENT_TASK_EXAMPLES = [
  "让小车先去一号木柱，再绕一圈，然后回来",
  "让小车去一号木柱拍摄一圈，然后回来",
  "先去一号柱，再环绕一圈，最后返回起点",
  "让小车去二号木柱绕一圈然后回起点",
  "让小车先去一号木柱，再去二号木柱，然后返回起点",
  "让小车沿四根柱子走一圈再返回起点",
];

INTENTS.push({
  id: AGENT_TASK_ID,
  name: "多步巡检任务编排",
  type: "AGENT",
  examples: AGENT_TASK_EXAMPLES,
  slots: [
    { name: "pillar", kind: "pillar", required: false, hint: "首个目标构件（缺省取风险最高的 Z04）" },
    { name: "pillar2", kind: "pillar", required: false, hint: "第二个目标构件（可缺省）" },
  ],
  response: {
    text:
      "任务已下发：{goal}。小车从 {homeLabel} 出发，依次经过 {routeText}，" +
      "全程使用 {missionSpeed}，结束后返回 {homeLabel} 并上报结果。",
    alternatives: [
      "已按你的说法生成执行计划：{goal}。路线为 {routeText}，速度档位 {missionSpeed}。",
    ],
    facts: ["goal", "homeLabel", "routeText", "missionSpeed"],
  },
});

/* ------------------------------------------------------------------ *
 * 索引与工具函数
 * ------------------------------------------------------------------ */

export const INTENT_BY_ID: Record<string, Intent> = indexBy(INTENTS, (item) => item.id);

/** 意图总条数（PRD 4.2 的 14 条 + 剧本新增的平台与小车控制意图），界面显示用 */
export const INTENT_COUNT = INTENTS.length;

export function intentById(id: string | null | undefined): Intent | null {
  if (!id) return null;
  return INTENT_BY_ID[id] ?? null;
}

/**
 * seed 里的语音包标签（PRD 4.2 的 voice 列）。
 * 老意图复用 seed 已有的「AI语音1..10」，新意图沿用同一条语音包命名规则。
 * 这样界面上显示的语音包名仍然只有一个来源（seed/scenario.ts）。
 */
export function voicePackOf(intentId: string): string {
  const seedIndex = XIAOMU_INTENTS.findIndex((item) => item.intentId === intentId);
  if (seedIndex >= 0) return XIAOMU_INTENTS[seedIndex].voice;
  const fallbackIndex = INTENTS.filter((item) => !XIAOMU_INTENTS.some((s) => s.intentId === item.id)).findIndex(
    (item) => item.id === intentId,
  );
  return `AI语音${XIAOMU_INTENTS.length + fallbackIndex + 1}`;
}

/** 与 seed 意图目录的对应关系，用于向 PRD 4.2 的 14 条对照（演示控制台与自检用） */
export function seedIntentOf(intentId: string) {
  return XIAOMU_INTENTS.find((item) => item.intentId === intentId) ?? null;
}
