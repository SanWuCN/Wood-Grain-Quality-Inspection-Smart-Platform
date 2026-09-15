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
   * 写法取自稿子里那一轮的"上一句"（即操作者实际会说的话）。
   */
  triggers: string[];
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
    triggers: ["读取工单", "整理任务"],
    lines: [
      {
        role: "main",
        /*
          文案逐字取自《新工单红头委托与小木联动-AI交接文档 v1.0》的「小木回复 v1.0」。

          ⚠ 这四句的顺序**就是**模块展开的节拍（见下面的 reveal.beats），
            改句子顺序必须同时改 beats，否则会出现"念到第二句却亮了第四组"。
          ⚠ 产品文本本身不追加语气词（文档明令）。
          ⚠ 末句提到 Z01–Z04：那是**平台转换事实**（服务端事务生成的编号），
            文档允许在这里说；但红头委托原文里**不得**出现这些编号（见防幻觉规则）。
        */
        text:
          "读取中，工单摘要已生成。" +
          "任务范围和出发清单已生成。" +
          "已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付。" +
          "附件里未明确的信息，我已单独列出。本次任务涉及的木构主体为四根木柱，我已按照 Z01 至 Z04 编号。",
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
    triggers: ["查天气", "现场天气", "天气数据"],
    lines: [
      {
        role: "main",
        text:
          "已按工单地点建立天气查询，结果将按降雨、湿度和大风分类展示。" +
          "结合本次木构巡检，建议先检查柱脚积水、渗漏痕迹和表面风化，再用现场读数确认采集条件。",
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
    triggers: ["同步任务", "任务顺序"],
    lines: [
      {
        role: "main",
        text:
          "我已把任务顺序同步到工作台。环境配置、地图、场景和检测批次将关联本次工单，" +
          "交接时可直接查看上一岗位提交的结果。",
      },
      {
        role: "waiting",
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
    triggers: ["开工清单", "核对清单"],
    lines: [
      {
        role: "main",
        text:
          "检查状态已汇总，未完成项显示在清单顶部。是否开工，请项目经理根据现场检查确认。",
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
    triggers: ["补偿参数", "标定建议"],
    lines: [
      {
        role: "main",
        text:
          "我已生成参数对照表。建议优先采用与当前材种和采集条件匹配的标定配置；" +
          "没有对应记录的项目保留待核验。请全栈工程师用参考件复核后下发。",
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
    triggers: ["通道巡查", "检查通道"],
    lines: [
      {
        role: "main",
        text:
          "已开启通道巡查。我会分别检查更新时间和连接状态，出现持续中断时提示对应通道，" +
          "正常更新不重复播报。",
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
    triggers: ["重建素材", "检查素材"],
    lines: [
      {
        role: "main",
        text:
          "素材检查单已展开。文件缺项与低清晰度画面分开列出，请先检查标记片段，再提交重建任务。",
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
    triggers: ["四柱风险", "木构比较", "复核顺序"],
    lines: [
      {
        role: "main",
        text:
          "当前Z04视角可见较明显的表面缺损和孔洞状疑点，建议优先复核Z04下部测区。" +
          "图像可以提示外观异常，不能确认内部是否存在空洞，也不能直接判定承载能力。" +
          "建议补充近距离图像和手持检测数据。",
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
    triggers: ["打开原图", "疑点放大"],
    lines: [
      {
        role: "main",
        text: "对应原图已打开，标注与构件编号一起显示。请核对这处表面缺损。",
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
    triggers: ["任务预检", "巡检预检"],
    lines: [
      {
        role: "main",
        text:
          "任务预检结果已展开，地图版本和点位清单可在右侧核对。" +
          "请确认路线避开当前手持作业区后下发。",
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
    title: "异常预警（小木主动发起）",
    triggers: ["适用预警", "异常预警"],
    lines: [
      {
        role: "main",
        text: "Z04当前批次触发适用性预警，异常记录已打开，请架构师确认。",
      },
    ],
    next: "史：全栈开发工程师，请暂停当前采集，保留设备位置和这批原始数据！",
    voicePack: null,
    intentId: null,
    precondition:
      "**唯一由小木主动起头的一轮**，没有上一句问句 —— 由架构师在采集页看到「适用域待核验」事件后触发，不靠语音唤醒进入",
  },
  {
    roundNo: "⑫",
    paragraph: "§247–249",
    act: "第三幕 · 异常拒判与模型更新",
    title: "异常证据汇总",
    triggers: ["异常证据", "汇总证据"],
    lines: [
      {
        role: "main",
        text:
          "建议核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，并验证候选模型。" +
          "适配结果通过独立验证和设备端检查前，保留待复核状态。",
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
    triggers: ["任务卡", "拆分任务"],
    lines: [
      {
        role: "main",
        text:
          "任务卡已生成。补采交全栈执行，样本与测区由具身核对，" +
          "项目经理审核分组和验证结果，平台记录各项回执。",
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
    triggers: ["接收清单", "采样核对"],
    lines: [
      {
        role: "main",
        text:
          "我正在按样本编号核对文件和路径记录。缺失项会保留在补采清单中，" +
          "已接收文件不会重复要求上传。",
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
    triggers: ["数据清洗", "人工审核"],
    lines: [
      {
        role: "main",
        text: "清洗完成，待审核记录已列出，数据集已按物理样本分组。",
      },
      {
        role: "audit",
        text:
          "需要人工判断的记录已分为重复疑点、采集异常和标签待核验。" +
          "原文件保持不变，请在列表中确认保留、排除或补采。",
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
    triggers: ["模型验证", "部署条件"],
    lines: [
      {
        role: "main",
        text: "验证对照已打开。该归档版本通过离线验证，可以进入设备部署检查。",
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
    triggers: ["版本核对", "设备回报"],
    lines: [
      {
        role: "main",
        text:
          "我正在核对目标版本与设备回报。收到版本信息后还要检查自检结果，" +
          "两项一致才会更新交付状态。",
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
    triggers: ["批次分析", "融合结果"],
    lines: [
      {
        role: "main",
        text: "分析完成，图像标注与雷达结果已关联到Z04测区，融合视图已生成。",
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
    triggers: ["证据对照", "补核清单"],
    lines: [
      {
        role: "main",
        text:
          "证据对照已打开。两路共同提示的项目优先展示，" +
          "结果不一致或资料不齐的项目已列入补核清单。",
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
    triggers: ["工单草稿", "生成草稿"],
    lines: [
      {
        role: "main",
        text:
          "工单草稿已生成。Z04下部已列为重点复核项，检测图像和雷达分析已附上，" +
          "处理建议待专业审核。",
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
    triggers: ["任务复盘", "生成复盘"],
    lines: [
      {
        role: "main",
        text:
          "复盘草稿已生成，分为任务完成情况、异常处置、版本交付和后续待办。" +
          "未完成事项单独列出，项目经理可直接修改后纳入报告。",
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
    triggers: ["交付摘要", "整理摘要"],
    lines: [
      {
        role: "main",
        text:
          "交付摘要已更新。文件校验结果和待办清单分别列出，" +
          "复盘草稿已关联本次工单，等待项目经理审核。",
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





