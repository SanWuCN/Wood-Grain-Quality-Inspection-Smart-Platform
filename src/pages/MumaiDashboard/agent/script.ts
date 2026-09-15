/**
 * 小木脚本化交互 · 木脉智检第二章
 *
 * ── 这份数据从哪来 ──────────────────────────────────────────────────
 * 逐字摘自《小木交互提取-木脉智检第二章-v1.0.md》（由 `4.1木脉智检（第二章）(2).docx`
 * 全文 490 段提取、逐段核对）。**台词是原文，不许改写** —— 排演与验收都按这份稿子对字。
 *
 * ── 为什么单独一份表，而不是塞进 intents.ts ──────────────────────────
 * `intents.ts` 是**意图目录**（28 条，回答"用户想干什么"，走语义向量匹配）。
 * 这里是**剧本台词**（20 轮，回答"这一轮小木该说哪几句原话"）。
 * 两者的更新节奏完全不同：意图会随产品能力增删，台词是排练/演示时逐字对稿的。
 * 混在一张表里，改意图就会动到台词，改台词又会动到语义匹配的语料。
 *
 * ── 语音编号为什么必须显式写 ────────────────────────────────────────
 * 稿子里只有 5 轮带 `（AI语音3）`~`（AI语音8）` 标注（§168/§247/§299/§344/§410/§441）。
 * 现有 `voicePackOf()` 是按**数组下标**推 `AI语音${index+1}` ——
 * 一旦意图表增删，这些编号就会整体漂移，而稿子上的编号是固定的。
 * 所以这里显式声明 `voicePack`，对接语音资源时以它为准。
 *
 * ── 排演约束（稿子文末摘录，实现时必须遵守）──────────────────────────
 * · 未接通真实工具时读**预置演示结果**，且要明确标注"预设标注演示"；
 * · 不虚构放大定位、不创建不存在的证据、不按倒计时编造成功；
 * · 不补写尚未完成的训练成绩。
 * 这些落成每轮的 `demoNote`（该轮未接通时怎么如实说）与 `precondition`（必须先满足什么）。
 */

/** 一轮脚本交互 */
export type ScriptRound = {
  /** 稿子里的圈号，如 "⑧"，用于对稿 */
  roundNo: string;
  /** 段落号，如 "§168–170" */
  paragraph: string;
  /** 幕 */
  act: string;
  /** 这一轮在做什么（一句短标题） */
  title: string;
  /**
   * 触发关键词组 —— 这一轮要匹配的「后文关键词」。
   * 每一项是**独立可选**的触发说法；匹配时不必全中，按覆盖率打分。
   *
   * ⚠ 口径来自工作清单 v1.0 §8 的「语义短语，**不得只匹配单个泛词**」列，
   *   以及 §9.2 的听写变体表。两条硬要求：
   *   · 每条短语**至少 3 个汉字**（§9.2 末：不得把「工单/天气/模型/清单/打开」
   *     这类单个泛词直接映射为动作）；
   *   · 相邻轮的字面要能区分开（例如 ① 必须含「读取+工单」、④ 必须含「开工+清单」 ——
   *     §9.2 点名要消除「打开工单」命中 ④ 的歧义）。
   *   `scriptRounds22.test.ts` 会逐条核对这三件事。
   */
  triggers: string[];
  /**
   * 这一轮的**触发来源**（§8 表第一列）。
   *
   *   "voice"       —— 由唤醒词 + 说法触发（22 轮里的 21 轮）
   *   "local-event" —— **只**由本地任务事件触发，语音不得抢触发（⑪）
   *
   * 为什么要把这件事写成数据而不是靠约定：⑪ 是"小木主动起头"的提醒，
   * 它对应的页面事件是"任务状态进入巡检前检查"。若语音也能触发它，
   * 演示时任何相近说法都会让页面凭空冒出提醒，且与真实因果脱节。
   */
  triggerSource: "voice" | "local-event";
  /** 小木这次要说的话。两句的情况见 ⑮（第 2 句是"等待时选用"） */
  lines: ScriptLine[];
  /** 对接的语音编号；稿子未标注的为 null（走 TTS 或未录制） */
  voicePack: string | null;
  /**
   * 对应哪个既有意图（`intents.ts` 的 id）。
   * 有值表示这一轮除了播台词，还应触发该意图的动作/导航；
   * null 表示纯播报（如 ⑪ 主动预警、③ 等待时段播报）。
   */
  intentId: string | null;
  /**
   * 小木说完之后，**按稿子**该由谁做什么 ——「预期下一动作」。
   *
   * 交互稿的备注里点名要这一列（"编号、触发条件、文本、预期下一动作"），
   * 它也是排练时最实用的一列：念完台词该谁接、接什么，一眼能看到。
   * 文案取自稿子里各轮的"下一句"。
   */
  next?: string;
  /** 这一轮开始前必须先满足的条件（排演约束） */
  precondition?: string;
  /** 交给 TTS 时的语音风格提示 */
  style?: string;
  /**
   * 「随播报逐组展开」的声明（可选）。
   *
   * ── 为什么从"计数"改成"命名"（v1.1）────────────────────────────────
   * 旧写法是 `{ target, panels: 3 }` —— 一个数字，语义只活在
   * `WorkOrderDetail.tsx` 的下标约定里（`stage > 0` / `> 1` / `> 2`）。
   * 客户交接文档《新工单红头委托与小木联动-AI交接文档 v1.0》要求
   * "四组模块**按播报语义节点**依次展开"，而计数无法表达"这一句对应哪一组"，
   * 只能把总时长平均分配 —— 于是"人员 / 环境 / 下发 / 成果"被挤在同一段里
   * 一起冒出来，而文档明令它们**不得提前出现**。
   *
   * ── 两个字段的关系 ──────────────────────────────────────────────────
   * `sections` 是这一轮**允许**揭示的组（顺序即播报顺序，取值见
   * `ordersReveal.ts` 的 `ORDER_DETAIL_SECTIONS`）；
   * `beats[i]` 是**第 i 段台词念完时**该揭示的组。
   * 拍点时间由 `buildRevealSchedule()` 按段累加算出（不是平均分配）。
   */
  reveal?: {
    target: "order-detail";
    sections: string[];
    beats: string[][];
  };
  /**
   * 页码联动：这一轮说完后页面该**跳到哪**。
   *
   * ── 为什么需要它（实测暴露的缺口）──────────────────────────────────
   * 原先"跳转"是靠**该轮 intent 的 action** 顺带完成的（第①轮正好是
   * `view_current_order` → `open_order`）。但 22 轮里只有少数几轮的 intent
   * 恰好指向工单页：
   *   · ④ ㉑ ㉒ 的 `intentId` 是 `null` —— 根本没有 action 可跑，页面纹丝不动；
   *   · ⑧ ⑩ ⑰ 的动作指向别的页面（构件对比 / 巡检 / 部署检查）；
   *   · ⑳ 跳到了字面量 `?order=draft` —— 占位符没人替换，选中不到任何工单。
   * 逐轮验证时这几条全是"跳转失败"。所以把导航**显式声明出来**，
   * 不再依赖"该轮的意图碰巧是导航类"。
   */
  nav?: {
    /** 目标页面：目前只有工单详情一种 */
    route: "order";
    /**
     * 选中哪张工单：
     *   "bound"   = **显式绑定**的那张（用户点「查看」通知时绑上的）—— 第①轮用这个。
     *               防幻觉规则 3：不许用 `orders[0]` 猜用户想看哪张；
     *   "current" = 列表最新那张（其余轮次的既有口径）；
     *   字符串    = 明确指定。
     */
    order: "bound" | "current" | string;
  };
};

/** 一句台词 */
export type ScriptLine = {
  text: string;
  /**
   * "main"     = 这一轮的主回复
   * "waiting"  = 等待时段选用的备用播报（稿子标了"等待时选用"的那些）
   * "audit"    = 人工审核未结束时的备用播报
   */
  role: "main" | "waiting" | "audit";
};

/* ------------------------------------------------------------------ *
 * 剧本（20 轮，按幕顺序）
 * ------------------------------------------------------------------ */

export const SCRIPT_ROUNDS: ScriptRound[] = [
  /* ---------------- 第一幕 工单进入与现场部署 ---------------- */
  {
    roundNo: "①",
    paragraph: "§8–10",
    act: "第一幕 · 工单进入与现场部署",
    title: "接单整理",
    /*
      ⚠ 这里原先还有一条 2 字短语「工单」，已去掉。
      触发器精简成短关键词之后（22c2b6f），它是全表唯一的 2 字项，
      而匹配规则**刻意**让 2 字拿不到阈值（可信度 0.6 < 0.62）——
      防的就是"只说两个字就播一整轮"。「工单」又过于泛（"打开工单""工单列表"都会撞），
      留着它只会是一条永远不命中的死条目。同轮已有「读取工单 / 整理任务」够用。
    */
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["读取这份工单", "解读任务范围", "整理出发清单", "读取工单"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "读取中，工单已建立。已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付。附件未明确的信息已单列，四根木柱已按Z01至Z04编号。",
      },
    ],
    next: "沈：收到。我来核对范围。本次完成巡检和辅助诊断，形成可追溯记录。请各岗位报告出发前准备情况。",
    voicePack: null,
    /**
     * ⚠ 这一轮原来绑的是 `history_summary`（查历史巡检风险汇总）——
     * 与台词说的「读取这份工单」根本不是一件事，结果是**只播报、不跳转**：
     * 按 Ctrl+Q+L 建单后说「读取这份工单」，页面停在原地不动。
     *
     * 改绑 `view_current_order`（查看当前工单）：它的 action 是 `open_order`。
     */
    intentId: "view_current_order",
    /**
     * 四组模块按播报**语义段**依次展开。
     *
     * `beats[i]` 与正文按标点切出的第 i 段对齐（顺序即播报顺序）：
     *   ① 读取中，工单摘要已生成        → 工单摘要
     *   ② 任务范围和出发清单已生成      → 任务范围与出发清单
     *   ③ 已整理为四项任务…            → 四项任务
     *   ④ 附件里未明确的信息…四柱编号   → 待确认信息 + 检测主体 + 后续执行模块
     *
     * ⚠ 第四组一次带出"待确认 + 主体 + 人员/环境/下发/成果"，是因为文档把
     *   它们归在同一个播报节点下（见交接文档「模块展开节拍」表末行）。
     *   人员在未指派时显示"未指派"、下发保持空态 —— 空态也是确定性事实，不算提前展示。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "tasks", "pending"],
      beats: [["order"], ["scope"], ["tasks"], ["pending"]],
    },
    /** 导航到**显式绑定**的那张工单（不是列表第一条）—— 见防幻觉规则 3 */
    nav: { route: "order", order: "bound" },
  },
  {
    roundNo: "②",
    paragraph: "§25–27",
    act: "第一幕 · 工单进入与现场部署",
    title: "天气风险查询",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["近三个月天气", "天气数据", "古建风险", "现场情况"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "已完成近三个月天气查询。累计降雨412.0毫米，降雨37天，平均相对湿度78%，最大阵风17.8米每秒。建议优先检查柱脚返潮、屋面排水、漆层起翘和迎风面连接，现场结论以实测为准。",
      },
    ],
    next: "沈：收到。现场共四根核心古木主体，巡检以 Z01 至 Z04 分别对应四根构件。",
    voicePack: null,
    intentId: "site_weather",
  },
  {
    roundNo: "③",
    paragraph: "§30–32",
    act: "第一幕 · 工单进入与现场部署",
    title: "任务顺序同步",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["同步工单任务", "同步到工作台"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "四项任务已同步，当前进入现场建档阶段。",
      },
      {
        role: "waiting",
        /* 备用播报：工作清单未替换该句，原样保留；只在对应时机播，不主动念 */
        text: "进场搬运尚未结束时由小木播报，队员继续整理装备。",
      },
    ],
    next: "（等待时选用）进场搬运尚未结束时由小木播报，队员继续整理装备。",
    voicePack: null,
    intentId: null,
    precondition: "操作者先说「现场共四根核心古木主体…」（本轮的上一句）",
  },
  {
    roundNo: "④",
    paragraph: "§58–60",
    act: "第一幕 · 工单进入与现场部署",
    title: "开工清单核对",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["核对开工清单", "开工检查", "需要完成的项目"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "开工清单已核对，设备、人员和资料三类共12项，11项就绪，1项待现场确认。",
      },
    ],
    next: "沈：现在开始执行任务。具身智能工程师做好小车建图和全景相机录制准备。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "⑤",
    paragraph: "§75–77",
    act: "第一幕 · 工单进入与现场部署",
    title: "补偿参数建议",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["环境补偿", "补偿参数建议"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "已按26.4摄氏度、78%湿度和1.6米每秒风速生成CFG-02建议，需现场确认后应用。",
      },
    ],
    next: "饶：收到，正在根据环境数据调整补偿参数。",
    voicePack: null,
    intentId: null,
  },

  /* ---------------- 第二幕 建图重建与风险初筛 ---------------- */
  {
    roundNo: "⑥",
    paragraph: "§119–120",
    act: "第二幕 · 建图重建与风险初筛",
    title: "地图/视频通道巡查",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["检查建图和视频", "影响作业的异常", "现场视频流"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "地图覆盖率96%，视频流连续，当前未发现阻断作业的问题。",
      },
    ],
    next: "马：我现在沿四根木柱外侧缓慢移动，再回到已走过的区域。",
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "⑦",
    paragraph: "§139–141",
    act: "第二幕 · 建图重建与风险初筛",
    title: "重建素材检查",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["检查重建素材", "缺失文件", "重看画面"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "素材检查完成：视频1段，时长4分18秒，分辨率3840×1920，共214个关键帧。缺失文件0个，低清晰度片段2处，已在00:43和02:17标记。",
      },
    ],
    next: "饶：我们使用 MipMap 软件进行全景影像的高斯场景重建。",
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "⑧",
    paragraph: "§168–170",
    act: "第二幕 · 建图重建与风险初筛",
    title: "四柱风险初筛",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["对比四根木柱", "按风险排序", "检测结果排序"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "Z04优先复核，Z03、Z02、Z01依次降低；其中Z04有两项可靠疑点和一项待补采记录。",
      },
    ],
    next: "史：小木，打开你标记的原图，把疑点区域放大。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: "AI语音3",
    intentId: "compare_columns",
    precondition: "真实视觉模型未接通时，结果须明确标注为「预设标注演示」",
  },
  {
    roundNo: "⑨",
    paragraph: "§171–173",
    act: "第二幕 · 建图重建与风险初筛",
    title: "打开标注原图",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["打开Z04证据", "标记原图", "原始证据"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "已打开Z04原始证据，并保留采集时间、设备和图片编号。",
      },
    ],
    next: "史：报告项目经理，平台建议优先复核 Z04 下部。",
    voicePack: null,
    intentId: "open_evidence",
    precondition: "不得虚构放大定位",
  },
  {
    roundNo: "⑩",
    paragraph: "§210–212",
    act: "第二幕 · 建图重建与风险初筛",
    title: "巡检任务预检",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["检查巡检任务配置", "任务预览"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "任务MSN-2026-0911-02已核对，6个航点、24.6米路线，预览已打开，尚未真实下发。",
      },
    ],
    next: "史：已选中目标小车、地图版本和巡检点位，显示任务预览后执行下发。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: null,
    intentId: "start_patrol",
  },

  /* ---------------- 第三幕 异常拒判与模型更新 ---------------- */
  {
    roundNo: "⑪",
    paragraph: "§230",
    act: "第三幕 · 异常拒判与模型更新",
    title: "巡检前检查（小木主动发起）",
    /* 触发来源：本地任务事件（语音不得抢触发） */
    triggerSource: "local-event",
    triggers: [],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "巡检前检查完成，路线、构件编号和采集模板一致，可以进入演习执行。",
      },
    ],
    next: "史：全栈开发工程师，请暂停当前采集，保留设备位置和这批原始数据！",
    voicePack: null,
    intentId: null,
    precondition:
      "**唯一由小木主动起头的一轮**（工作清单 §8 明文：不接受语音抢触发）。" +
      "触发来源是本地任务事件「任务状态进入巡检前检查」—— 即任务推进到该节点时由平台自动播报，" +
      "不靠语音唤醒进入；`triggerSource: \"local-event\"` 与空 `triggers` 一起把这条约束写成数据。",
  },
  {
    roundNo: "⑫",
    paragraph: "§247–249",
    act: "第三幕 · 异常拒判与模型更新",
    title: "异常证据汇总",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["汇总采集异常", "有证据的异常"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "scan-Z04-001缺失34帧，特征偏移2.7个标准差。当前只标记为采集异常，不生成病害结论。",
      },
    ],
    next: "史：小木，把补采、数据审核和适配验证拆成任务卡，关联本次异常批次。",
    voicePack: "AI语音4",
    intentId: "anomaly_summary",
  },
  {
    roundNo: "⑬",
    paragraph: "§250–252",
    act: "第三幕 · 异常拒判与模型更新",
    title: "任务卡拆分",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["拆分异常任务", "生成任务卡"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "已拆为四项：定位缺帧、补采雷达、复核图像、提交证据。",
      },
    ],
    next: "沈：启动适配流程。只用提前授权、来源明确的参考样本。",
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "⑭",
    paragraph: "§276–277",
    act: "第三幕 · 异常拒判与模型更新",
    title: "采样计划与接收清单核对",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["核对接收清单", "缺了什么"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "计划12条，收到12条；3条进入待审核，分别是重复疑点、空文件和标签待核验。",
      },
    ],
    next: "饶：本轮样本采集结束。原始数据包已提交。",
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "⑮",
    paragraph: "§299–303",
    act: "第三幕 · 异常拒判与模型更新",
    title: "数据清洗与人工审核",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["清洗这批数据", "物理样本分组", "数据清洗"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "清洗完成：12条保留9条，排除3条；6个样本组按4、1、1划分，组间编号无交叉。",
      },
      {
        role: "audit",
        /* 备用播报：工作清单未替换该句，原样保留；只在对应时机播，不主动念 */
        text: "需要人工判断的记录已分为重复疑点、采集异常和标签待核验。原文件保持不变，请在列表中确认保留、排除或补采。",
      },
    ],
    next: "沈：我来检查数据划分。同一块木样的连续扫描很相似。",
    voicePack: "AI语音5",
    intentId: "clean_dataset",
    precondition: "第 2 句是人工审核未结束时的备用播报，只在审核未完成时播",
  },
  {
    roundNo: "⑯",
    paragraph: "§344–346",
    act: "第三幕 · 异常拒判与模型更新",
    title: "新旧模型验证汇总",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["对比两个模型", "固定测试集", "新旧模型"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "漏检由3降至2，误报由4降至2，原有材种召回率由0.92升至0.94，6项部署条件通过。",
      },
    ],
    next: "史：本次部署使用屏幕上的归档版本，准备执行量化与封装。",
    voicePack: "AI语音6",
    intentId: "compare_models",
    precondition: "不补写尚未完成的训练成绩",
  },
  {
    roundNo: "⑰",
    paragraph: "§372–373",
    act: "第三幕 · 异常拒判与模型更新",
    title: "设备版本回报核对",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["核对目标版本", "设备版本回报"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "目标版本DEMO-M02b与本地设备回报一致，自检7项通过，回退版本DEMO-M02完整。",
      },
    ],
    next: "饶：更新完成，版本核对一致，参考输入检查通过。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: null,
    intentId: "deployment_check",
    precondition: "不按倒计时编造成功",
  },

  /* ---------------- 第四幕 复扫融合与任务交付 ---------------- */
  {
    roundNo: "⑱",
    paragraph: "§410–412",
    act: "第四幕 · 复扫融合与任务交付",
    title: "本批次分析流程",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["精细分析", "雷达图像融合"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "分析完成，Z04下部已关联420帧雷达、14帧图像和3份端侧结果，融合记录已生成。",
      },
    ],
    next: "史：小木，把图像疑点和同测区响应放在一起，列出需要补核的项目。",
    voicePack: "AI语音7",
    intentId: "run_fusion",
  },
  {
    roundNo: "⑲",
    paragraph: "§413–415",
    act: "第四幕 · 复扫融合与任务交付",
    title: "证据对照与补核清单",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["打开证据对照", "可靠疑点", "待补采"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "两项两路证据一致，列为优先复核；一项有效数据比例88.4%，低于90%，进入补采。",
      },
    ],
    next: "史：多模态融合不能直接把两个置信度相加。",
    voicePack: null,
    intentId: "open_evidence",
  },
  {
    roundNo: "⑳",
    paragraph: "§441–443",
    act: "第四幕 · 复扫融合与任务交付",
    title: "工单草稿生成",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["生成工单草稿", "根据当前证据", "工单草稿"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "工单草稿WO-2026-0912已生成，Z04下部列为重点复核项，处理建议保持待专业审核。",
      },
    ],
    next: "沈：工单里要写清楚后续责任人。持续受潮的区域先排查积水、排水和渗漏源头。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: "AI语音8",
    intentId: "draft_workorder",
  },
  {
    roundNo: "㉑",
    paragraph: "§454–456",
    act: "第四幕 · 复扫融合与任务交付",
    title: "任务复盘生成",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["生成任务复盘", "已经验证", "仍待处理"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "复盘已生成，已验证链路、数据质量和模型对照，仍待处理现场复核、一次补采和归档差异。",
      },
    ],
    next: "史：我们将工单状态分为待复核、待处理、处理中和待验收。",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: null,
    intentId: null,
  },
  {
    roundNo: "㉒",
    paragraph: "§476–478",
    act: "第四幕 · 复扫融合与任务交付",
    title: "交付摘要整理",
    /* 触发来源：唤醒词 + 说法 */
    triggerSource: "voice",
    triggers: ["整理交付摘要", "打开待处理条目"],
    lines: [
      {
        role: "main",
        /* 台词逐字冻结：工作清单 v1.0 §8「小木固定回答摘要」（数据取自 §6，措辞按 §7） */
        text: "24项中21项通过，1项缺失，2项摘要不一致；三项待办已打开。",
      },
    ],
    next: "沈：本次待办事项是否已登记？",
    /*
     * 这一轮讲的正是工单详情里的东西 → 让详情跟着台词逐段展开。
     * 数量 3 = WorkOrderDetail 的三个可揭示分区（摘要 / 指派 / 环境·下发）。
     */
    reveal: {
      target: "order-detail",
      sections: ["order", "scope", "pending"],
      /* 三段节拍：摘要 → 任务范围 → 后续执行模块（与 `ordersReveal.ts` 的组名对齐） */
      beats: [["order"], ["scope"], ["pending"]],
    },
    nav: { route: "order", order: "current" },
    voicePack: null,
    intentId: "unresolved_followup",
  },
];

/** 按圈号取一轮 */
export function roundByNo(roundNo: string): ScriptRound | null {
  return SCRIPT_ROUNDS.find((r) => r.roundNo === roundNo) ?? null;
}

/** 这一轮要播的主台词（不含备用播报） */
export function mainLineOf(round: ScriptRound): string {
  const main = round.lines.find((l) => l.role === "main");
  return main ? main.text : "";
}

export const SCRIPT_ROUND_COUNT = SCRIPT_ROUNDS.length;





