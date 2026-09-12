/**
 * 木脉智检 · 演示种子（PRD 16 素材种子清单）
 *
 * 全部页面从这一份种子取数：
 *   工单 SH-2026-0901 / 四柱 Z01–Z04 / 本轮风险 CUR-Z04-01~03 / 历史 R01–R06 /
 *   环境记录 / 人员分工 / 参考样本批次 / 数据集 DS-06 / 实验记录 / 更新包 /
 *   融合结果 / 复巡计划 / 地图与巡检任务 / 场景库 / 归档清单 / 知识库资料。
 *
 * 日期、风险数、版本号只在这里出现一次，页面不得各自硬编码。
 * 种子整体标 source_mode: replay，界面按 PRD 15 显示「演示回放」来源标识。
 */

import type {
  AnomalyEvent,
  ArchiveItem,
  CleanStep,
  ChannelStatus,
  ClockPhase,
  Component,
  ConfigDiffRow,
  CurrentRisk,
  Curve,
  Dataset,
  DemoEvent,
  EnvRecord,
  Experiment,
  ForbiddenZone,
  GridMap,
  HistoryRisk,
  HotspotEvidence,
  KnowledgeDoc,
  LogEntry,
  MapVersion,
  Member,
  Mission,
  Order,
  PoseSample,
  RevisitPlan,
  Sample,
  ScanBatch,
  SceneAsset,
  SourceMode,
  StageDef,
  TriageItem,
  UpdatePackage,
  Waveform,
  Waypoint,
} from "./types";

/* ------------------------------------------------------------------ *
 * 0. 会话与演示日历
 * ------------------------------------------------------------------ */

/** PRD 4.2：「今年」按平台业务日期解析，种子在启动时一次生成并冻结 */
export const DEMO_BUSINESS_DATE = "2026-09-11";
export const DEMO_SESSION = {
  sessionId: "session-A",
  scenarioId: "MAY-DEMO-01",
  scenarioTitle: "示例寺 · 第二轮巡检（第二章）",
  profile: "competition_demo",
  deviceModes: {
    robot: "replay",
    scanner: "simulation",
    training: "simulation",
    voice: "preset",
    rag: "local_tfidf",
  },
  sourceMode: "replay" as SourceMode,
  /** 界面统一显示「演示回放」标识 */
  sourceLabel: "演示回放",
  weatherArchive: {
    docId: "doc-weather-0901",
    range: "2026-06-11 至 2026-09-10（近三个月）",
    summary: "梅雨期累计降水 412mm，8 月 3 次连续降雨过程，平均相对湿度 78%，日温差最大 11.4℃",
    source: "归档天气档案 · 非实时联网查询",
  },
} as const;

/** PRD 7.1 全程阶段 */
export const STAGES: StageDef[] = [
  { key: "history", label: "历史资料", script: "第一章", clock: "07:00", detail: "MAY-DEMO-01 报告、R01–R06 状态与旧场景书签只读复用" },
  { key: "prepare", label: "工单与环境", script: "S01–S03", clock: "08:00–15:15", detail: "新工单建立、环境记录与校验、四路通道检查" },
  { key: "mapping", label: "建图", script: "S04–S05", clock: "15:15–18:15", detail: "占据栅格地图、位姿、建图版本 MAP-SH-06" },
  { key: "reconstruction", label: "场景重建", script: "S06–S07", clock: "18:15–21:30", detail: "预采全景视频、关键帧、场景版本 GS-2026.09" },
  { key: "screening", label: "风险初筛", script: "S08–S09", clock: "21:30–24:30", detail: "四柱关键帧对比，平台建议优先复核 Z04 下部" },
  { key: "scanning", label: "手持初扫", script: "S10–S11", clock: "24:30–28:00", detail: "初扫批次 scan-Z04-001，巡检任务并行执行" },
  { key: "exception", label: "异常排查", script: "S12", clock: "28:00–31:00", detail: "适用域待核验事件，冻结该批诊断输出" },
  { key: "dataset", label: "样本与数据集", script: "S13–S14", clock: "31:00–34:15", detail: "参考样本批次、清洗审核、DS-06 冻结" },
  { key: "adaptation", label: "训练验证", script: "S15–S16", clock: "34:15–37:00", detail: "小样本适配实验 EXP-2026-0911" },
  { key: "deployment", label: "更新交付", script: "S17–S18", clock: "37:00–39:00", detail: "INT8 量化、DEMO-PKG-02 下发与设备回执" },
  { key: "rescan", label: "复扫", script: "S19", clock: "39:00–41:00", detail: "复扫批次 scan-Z04-002 与三处样例异常" },
  { key: "fusion", label: "融合分析", script: "S20–S21", clock: "41:00–44:00", detail: "规则 FUSION-03，两路同测区异常列为优先复核" },
  { key: "delivery", label: "工单与归档", script: "S22–S23", clock: "44:00–47:00", detail: "复核工单 WO-2026-0912、复巡计划、SHA-256 归档校验" },
];

/** 演示控制台脚本阶段（第二章时间节点 08:00 → 47:00） */
export const CLOCK_PHASES: ClockPhase[] = [
  {
    key: "p1", start: "08:00", end: "10:30", title: "接单与装备整理", slides: "S01", speaker: "史 / 沈",
    stageKey: "prepare",
    keyLines: ["平台收到新的现场检测工单，任务包括巡检建档、风险点精扫和修复方案制定。", "本次完成巡检和辅助诊断，形成可追溯记录。"],
  },
  {
    key: "p2", start: "10:30", end: "12:00", title: "落地检查与开工指令", slides: "S01", speaker: "沈",
    stageKey: "prepare",
    keyLines: ["进行工装规范自检与互查。", "具身智能工程师完成小车建图和全景相机录制准备；架构师核对两路通信。"],
  },
  {
    key: "p3", start: "12:00", end: "15:15", title: "环境采集与设备校准", slides: "S02–S03", speaker: "沈 / 饶 / 马",
    stageKey: "prepare",
    keyLines: ["记录温度、相对湿度和风速，并备注测量位置与时间。", "HH 模型只作环境先验，风速不代入 HH 公式。"],
    eventKey: "env-publish",
  },
  {
    key: "p4", start: "15:15", end: "18:15", title: "遥控 SLAM 建图", slides: "S04–S05", speaker: "马 / 史",
    stageKey: "mapping",
    keyLines: ["雷达扫描得到不同方向的距离观测，里程计提供短时运动估计。", "地图、位姿、视频和车辆状态更新时间分别显示。"],
  },
  {
    key: "p5", start: "18:15", end: "21:30", title: "全景视频与高斯场景重建", slides: "S06–S07", speaker: "饶",
    stageKey: "reconstruction",
    keyLines: ["这里加载同场景的预采全景视频，展示预采数据的处理与成果导入。", "使用 MipMap 软件进行全景影像的高斯场景重建。"],
  },
  {
    key: "p6", start: "21:30", end: "24:30", title: "场景预览与智能体初筛", slides: "S08–S09", speaker: "史",
    stageKey: "screening",
    keyLines: ["小木，请比较这四组木构件，按可见异常给出优先复核顺序。", "当前 Z04 视角可见较明显的表面缺损和孔洞状疑点，建议优先复核 Z04 下部测区。"],
    eventKey: "preset-annotation",
  },
  {
    key: "p7", start: "24:30", end: "28:00", title: "平台派发巡检与手持初扫", slides: "S10–S11", speaker: "饶 / 马 / 史",
    stageKey: "scanning",
    keyLines: ["Z04 测区已确认，开始采集。", "已选中目标小车、地图版本和巡检点位，先显示任务预览，再执行下发。"],
    eventKey: "mission-dispatch",
  },
  {
    key: "p8", start: "28:00", end: "31:00", title: "异常喊停与原因排查", slides: "S12", speaker: "史 / 饶 / 马",
    stageKey: "exception",
    keyLines: ["请暂停当前采集，保留设备位置和这批原始数据！", "系统暂不输出病害结论，先查设备和数据，再查模型。"],
    eventKey: "domain-pending",
  },
  {
    key: "p9", start: "31:00", end: "33:00", title: "参考样本与新数据采集", slides: "S13", speaker: "马 / 饶",
    stageKey: "dataset",
    keyLines: ["参考样本与现场木柱分开编号。", "同一块样本的连续扫描属于同一组，后面不能拆散到训练集和测试集里。"],
  },
  {
    key: "p10", start: "33:00", end: "34:15", title: "清洗标注与数据集划分", slides: "S14", speaker: "史 / 沈",
    stageKey: "dataset",
    keyLines: ["清洗算法按顺序处理：空帧检查、相似度筛查、特征聚类。", "我用样本编号做交集检查，发现重复编号就整组调整。"],
    eventKey: "clean-and-split",
  },
  {
    key: "p11", start: "34:15", end: "37:00", title: "候选模型微调与独立验证", slides: "S15–S16", speaker: "史 / 沈",
    stageKey: "adaptation",
    keyLines: ["在已有轻量模型上更新材质相关参数，不必从头训练整套网络。", "固定测试清单、预处理配置和判定阈值，再运行两个版本逐项比较。"],
    eventKey: "compare-models",
  },
  {
    key: "p12", start: "37:00", end: "39:00", title: "量化导出与烧录验证", slides: "S17–S18", speaker: "史 / 饶",
    stageKey: "deployment",
    keyLines: ["模型已完成 INT8 量化和复测。", "更新包已下载，设备型号、版本和文件校验通过，旧版本已保留。"],
    eventKey: "deliver-package",
  },
  {
    key: "p13", start: "39:00", end: "41:00", title: "重新扫描与端侧初筛", slides: "S19", speaker: "饶 / 史",
    stageKey: "rescan",
    keyLines: ["木柱内部发现一处疑似严重受潮区域，模型置信度约为 71%；另有两处疑似虫蛀空洞，模型置信度均高于 80%。", "前后两次扫描可以在平台并排查看。"],
  },
  {
    key: "p14", start: "41:00", end: "44:00", title: "平台精细分析与数字孪生关联", slides: "S20–S21", speaker: "史 / 马",
    stageKey: "fusion",
    keyLines: ["多模态融合不能直接把两个置信度相加。", "两路都提示异常时列为重点，一致性不足时补充采集。"],
    eventKey: "run-fusion",
  },
  {
    key: "p15", start: "44:00", end: "46:00", title: "人工复核与工单跟踪", slides: "S22", speaker: "沈 / 史",
    stageKey: "delivery",
    keyLines: ["本次重点关注 Z04 下部，根据检测结果整理修缮建议和复核工单。", "工单状态分为待复核、待处理、处理中和待验收。"],
    eventKey: "draft-order",
  },
  {
    key: "p16", start: "46:00", end: "47:00", title: "数据归档与设备收整", slides: "S23", speaker: "沈",
    stageKey: "delivery",
    keyLines: ["运行完整性校验程序，逐项检查文件并核对 SHA-256 摘要。", "Z04 待专业复核，现场新增样本的训练任务按实际进度继续跟踪。"],
    eventKey: "archive-check",
  },
];

/** 演示控制台事件按钮 */
export const DEMO_EVENTS: DemoEvent[] = [
  { key: "domain-pending", label: "触发适用域待核验", detail: "冻结 scan-Z04-001 诊断输出，四柱状态置为待核验", effect: "该批诊断输出冻结，传感器状态置为等待操作员确认停止", tone: "red" },
  { key: "preset-annotation", label: "切换为预设标注演示", detail: "明确标注「预设标注演示」，不称为实时视觉推理", effect: "初筛结果来源标记为预设标注", tone: "amber" },
  { key: "source-switch", label: "切换数据来源：演示车 / 实机", detail: "只能在任务停止后进行（PRD 3.2）", effect: "通道来源改为「演示车 · replay」或「实机 · live」", tone: "amber" },
  { key: "deliver-package", label: "下发演示更新包", detail: "DEMO-PKG-02 · demo_nonflashable", effect: "交付步骤从「封装」推进到「下发」", tone: "cyan" },
  { key: "draft-order", label: "生成复核工单草稿", detail: "小木按所选风险生成草稿并带入证据", effect: "新建 WO-2026-0912，状态为草稿", tone: "cyan" },
  { key: "archive-check", label: "运行归档完整性校验", detail: "逐项存在性检查 + SHA-256 摘要对比", effect: "输出缺失与不一致文件清单", tone: "cyan" },
  { key: "present-open", label: "投到展示窗口", detail: "打开 #/present，presentation 角色，纯展示无导航", effect: "展示窗口接管大屏，显示控制权显式交接", tone: "cyan" },
  { key: "replay-reset", label: "装载阶段快照", detail: "先生成该阶段完整业务快照，再切换顶部阶段", effect: "阶段与业务记录同时回退，不删除素材原件", tone: "amber" },
];

/* ------------------------------------------------------------------ *
 * 1. 设备四路通道（PRD 3.2 / 3.4）
 * ------------------------------------------------------------------ */

export const CHANNELS: ChannelStatus[] = [
  { key: "map", label: "地图", state: "online", updatedAt: "14:22:31", ageSec: 2, source: "演示车 · replay" },
  { key: "pose", label: "位姿", state: "online", updatedAt: "14:22:33", ageSec: 1, source: "演示车 · replay" },
  { key: "video", label: "视频", state: "stale", updatedAt: "14:22:24", ageSec: 9, source: "MJPEG 同源转发" },
  { key: "vehicle", label: "车辆", state: "online", updatedAt: "14:22:32", ageSec: 2, source: "ROS1 rosbridge · 只读" },
];

/** 设备档案：演示车与实机名称明显不同（PRD 3.2） */
export const DEVICES = {
  demoCart: { id: "cart-demo-01", name: "演示车 DEMO-CART-01", mode: "replay" as SourceMode },
  realCart: { id: "cart-real-01", name: "实机 FIREBAT-N100", mode: "live" as SourceMode },
  scanner: { id: "scan-dev-02", name: "手持毫米波 02 号机", mode: "simulation" as SourceMode },
};

/* ------------------------------------------------------------------ *
 * 2. 四柱构件档案
 * ------------------------------------------------------------------ */

export const COMPONENTS: Component[] = [
  {
    id: "Z01", name: "檐柱 Z01", part: "檐柱下部", zoneId: "Z01-lower",
    scene: { x: -2.2, z: 2.2 }, radarScore: null,
    visibleNote: "外观连续，未见明显缺损",
    archive: "Z01 档案：杉木，直径 320mm，2019 年更换柱础", defaultBookmark: "BM-Z01-lower",
  },
  {
    id: "Z02", name: "檐柱 Z02", part: "檐柱下部", zoneId: "Z02-lower",
    scene: { x: 2.2, z: 2.2 }, radarScore: null,
    visibleNote: "表面轻微褪色，无结构疑点",
    archive: "Z02 档案：杉木，直径 318mm，柱脚包镶完好", defaultBookmark: "BM-Z02-lower",
  },
  {
    id: "Z03", name: "金柱 Z03", part: "金柱下部", zoneId: "Z03-lower",
    scene: { x: -2.2, z: -2.2 }, radarScore: null,
    visibleNote: "漆层局部起翘，未精扫",
    archive: "Z03 档案：楠木，直径 356mm，2021 年做过地仗修补", defaultBookmark: "BM-Z03-lower",
  },
  {
    id: "Z04", name: "金柱 Z04", part: "金柱下部", zoneId: "Z04-lower",
    scene: { x: 2.2, z: -2.2 }, radarScore: 0.87,
    visibleNote: "表面缺损与孔洞状疑点，建议优先复核下部测区",
    archive: "Z04 档案：楠木，直径 360mm，柱脚有历史修补痕迹；本轮无有效标定记录",
    defaultBookmark: "BM-Z04-lower",
  },
];

export const componentById = (id: string): Component | undefined => COMPONENTS.find((item) => item.id === id);

/* ------------------------------------------------------------------ *
 * 3. 工单
 * ------------------------------------------------------------------ */

export const WORK_ORDER: Order = {
  id: "SH-2026-0901",
  title: "示例寺木构巡检建档与风险点精扫",
  site: "示例寺",
  district: "上海市松江区",
  location: "大雄宝殿东次间四柱区域（北纬 31.0320°，东经 121.2235°）",
  scope: "四柱影像覆盖、SLAM 建图、Z04 下部测区手持精扫、场景重建与风险初筛；不含修缮施工",
  componentIds: ["Z01", "Z02", "Z03", "Z04"],
  status: "处理中",
  current: true,
  createdAt: "2026-09-11 08:12",
  discoveredAt: "2026-09-11 08:12",
  owner: "沈 · 项目经理",
  level: "高风险",
  sourceRiskIds: ["CUR-Z04-01", "CUR-Z04-02", "CUR-Z04-03"],
  attachments: [
    { assetId: "asset-img-04", name: "Z04_下部_表面图像_*.jpg（12 帧）", kind: "图像", sizeText: "38.4 MB", from: "scan-Z04-001", sourceMode: "simulation" },
    { assetId: "asset-radar-04", name: "Z04_lower_radar.csv", kind: "原始数据", sizeText: "12.1 MB", from: "scan-Z04-001", sourceMode: "simulation" },
    { assetId: "asset-map-06", name: "MAP-SH-06.pgm + map.yaml", kind: "地图", sizeText: "2.6 MB", from: "建图批次 mapping-0911", sourceMode: "replay" },
    { assetId: "asset-scene-09", name: "GS-2026.09_manifest.json", kind: "场景", sizeText: "184 MB", from: "预采场景包", sourceMode: "replay" },
    { assetId: "asset-ds-06", name: "DS-06_frozen_manifest.json", kind: "数据集", sizeText: "46 KB", from: "数据集 DS-06", sourceMode: "simulation" },
    { assetId: "asset-pkg-02", name: "DEMO-PKG-02.demo.zip", kind: "模型", sizeText: "3.2 MB", from: "更新包 DEMO-PKG-02", sourceMode: "simulation" },
    { assetId: "asset-log-dev", name: "device_update_log.txt", kind: "日志", sizeText: "24 KB", from: "设备代理回执", sourceMode: "simulation" },
  ],
  acceptanceNote: "施工反馈与验收为两个独立操作：上传完工资料只进入待验收，人工验收通过才关闭。",
  revisitPlanId: "RV-2026-1009",
  sourceMode: "replay",
};

/** 历史工单（PRD 3.1：历史工单与当前工单分列表显示） */
export const HISTORIC_ORDERS: Order[] = [
  {
    id: "MAY-DEMO-01",
    title: "示例寺五月巡检（历史只读）",
    site: "示例寺",
    district: "上海市松江区",
    location: "大雄宝殿四柱区域",
    scope: "四柱影像采集与表面巡检，发现 6 处风险",
    componentIds: ["Z01", "Z02", "Z03", "Z04"],
    status: "待验收",
    current: false,
    createdAt: "2026-05-18 09:30",
    discoveredAt: "2026-05-18 09:30",
    owner: "沈 · 项目经理",
    level: "中风险",
    sourceRiskIds: ["R01", "R02", "R03", "R04", "R05", "R06"],
    attachments: [
      { assetId: "asset-may-report", name: "MAY-DEMO-01_巡检报告.pdf", kind: "报告", sizeText: "4.8 MB", from: "历史资料包", sourceMode: "replay" },
      { assetId: "asset-may-scene", name: "scene-May_bookmarks.json", kind: "场景", sizeText: "16 KB", from: "旧场景书签", sourceMode: "replay" },
    ],
    acceptanceNote: "R01–R03 已验收关闭；R04 待验收；R05、R06 待处理。",
    revisitPlanId: null,
    sourceMode: "replay",
  },
  {
    id: "JS-2026-0828",
    title: "寒山寺 Z02 局部受潮复核",
    site: "寒山寺",
    district: "江苏省苏州市",
    location: "钟楼二层 Z02 测区",
    scope: "受潮范围复核与排水检查",
    componentIds: ["Z02"],
    status: "处理中",
    current: false,
    createdAt: "2026-08-28 10:05",
    discoveredAt: "2026-08-28 10:05",
    owner: "沈 · 项目经理",
    level: "中风险",
    sourceRiskIds: [],
    attachments: [],
    acceptanceNote: "施工单位已完成排水沟清理，等待雨季复测。",
    revisitPlanId: null,
    sourceMode: "replay",
  },
  {
    id: "SC-2026-0826",
    title: "报国寺 Z01 表面裂隙处理",
    site: "报国寺",
    district: "四川省峨眉山市",
    location: "山门东侧 Z01",
    scope: "裂隙观测与灌浆建议",
    componentIds: ["Z01"],
    status: "待处理",
    current: false,
    createdAt: "2026-08-26 15:40",
    discoveredAt: "2026-08-26 15:40",
    owner: "沈 · 项目经理",
    level: "低风险",
    sourceRiskIds: [],
    attachments: [],
    acceptanceNote: "等待责任部门确认处理时间。",
    revisitPlanId: null,
    sourceMode: "replay",
  },
  {
    id: "ZJ-2026-0823",
    title: "灵隐寺 Z02 含水率偏高复测",
    site: "灵隐寺",
    district: "浙江省杭州市西湖区",
    location: "大雄宝殿西次间 Z02 测区",
    scope: "含水率复测与通风改善建议",
    componentIds: ["Z02"],
    status: "处理中",
    current: false,
    createdAt: "2026-08-23 11:20",
    discoveredAt: "2026-08-23 11:20",
    owner: "沈 · 项目经理",
    level: "中风险",
    sourceRiskIds: [],
    attachments: [],
    acceptanceNote: "已增设通风口，等待干燥季节复测确认。",
    revisitPlanId: null,
    sourceMode: "replay",
  },
  {
    id: "YN-2026-0820",
    title: "崇圣寺三塔 Z03 例行结构复核",
    site: "崇圣寺三塔",
    district: "云南省大理市",
    location: "主塔一层北侧 Z03",
    scope: "外观复核与倾斜观测，不含内部检测",
    componentIds: ["Z03"],
    status: "待验收",
    current: false,
    createdAt: "2026-08-20 09:05",
    discoveredAt: "2026-08-20 09:05",
    owner: "沈 · 项目经理",
    level: "低风险",
    sourceRiskIds: [],
    attachments: [],
    acceptanceNote: "施工单位已提交观测记录，等待人工验收关闭。",
    revisitPlanId: null,
    sourceMode: "replay",
  },
];

/** 复核工单草稿（PRD 3.8：小木生成草稿 → 经理确认 → 待复核） */
export const DRAFT_ORDER: Order = {
  id: "WO-2026-0912",
  title: "Z04 下部重点复核（融合结果驱动）",
  site: "示例寺",
  district: "上海市松江区",
  location: "大雄宝殿东次间 Z04 下部测区，参考标高 +0.35m",
  scope: "重点复核疑似受潮与两处疑似空洞测区；先查周边积水、排水与渗漏来源，再安排进一步检测",
  componentIds: ["Z04"],
  status: "草稿",
  current: false,
  createdAt: "2026-09-11 14:31",
  discoveredAt: "2026-09-11 14:31",
  owner: "史 · 人工智能架构师（草稿）",
  level: "高风险",
  sourceRiskIds: ["CUR-Z04-01", "CUR-Z04-02", "CUR-Z04-03"],
  attachments: [
    { assetId: "asset-fusion-03", name: "fusion_record_FUSION-03.json", kind: "清单", sizeText: "42 KB", from: "融合记录", sourceMode: "simulation" },
    { assetId: "asset-img-04", name: "Z04_lower_annotations.json", kind: "图像", sizeText: "88 KB", from: "视觉标注", sourceMode: "simulation" },
  ],
  acceptanceNote: "验收不通过回到处理中；本演示不建立外部施工登录端。",
  revisitPlanId: "RV-2026-1009",
  sourceMode: "simulation",
};

/* ------------------------------------------------------------------ *
 * 4. 风险：历史 R01–R06 与本轮 CUR-Z04-01~03
 * ------------------------------------------------------------------ */

// PRD 5.3 MAY-DEMO-01：6 个风险 R01–R06，其中只有 R01–R04 已有施工完成反馈，
// R05 与 R06 仍是待处理，因此 reported 为 false —— reportedDone 由数据算出 4。
export const HISTORY_RISKS: HistoryRisk[] = [
  { id: "R01", title: "Z01 柱脚漆层剥落", status: "验收关闭", reported: true, closed: true, next: "已闭合，无需处理", sceneId: "scene-May", bookmark: "BM-Z01-base" },
  { id: "R02", title: "Z02 表面污渍", status: "验收关闭", reported: true, closed: true, next: "已闭合，无需处理", sceneId: "scene-May", bookmark: "BM-Z02-base" },
  { id: "R03", title: "Z03 地仗修补痕迹", status: "验收关闭", reported: true, closed: true, next: "已闭合，无需处理", sceneId: "scene-May", bookmark: "BM-Z03-base" },
  { id: "R04", title: "Z04 柱脚渗水痕迹", status: "待验收", reported: true, closed: false, next: "核对完工资料并安排人工验收", sceneId: "scene-May", bookmark: "BM-Z04-base" },
  { id: "R05", title: "东次间排水沟淤积", status: "待处理", reported: false, closed: false, next: "分配责任部门并确认处理时间", sceneId: "scene-May", bookmark: "BM-drain-east" },
  { id: "R06", title: "台基西侧苔藓覆盖", status: "待处理", reported: false, closed: false, next: "纳入下次复巡观察点", sceneId: "scene-May", bookmark: "BM-plinth-west" },
];

/**
 * 历史问答固定答案（PRD 5.3）：6 处风险 / 施工反馈完成 4 处 / 验收关闭 3 处 / 尚未关闭 3 处。
 * 四项全部由 HISTORY_RISKS 算出，页面不再另写一套数字。
 */
export const HISTORY_STATS = {
  total: HISTORY_RISKS.length,
  reportedDone: HISTORY_RISKS.filter((item) => item.reported).length,
  closed: HISTORY_RISKS.filter((item) => item.closed).length,
  open: HISTORY_RISKS.filter((item) => !item.closed).length,
};

export const CURRENT_RISKS: CurrentRisk[] = [
  {
    id: "CUR-Z04-01", componentId: "Z04", zoneId: "Z04-lower",
    label: "疑似严重受潮区域", branch: "雷达", score: 0.71,
    priority: "优先复核", quality: "合格",
    evidence: ["echo-Z04-lower-seg-07", "img-Z04-lower-f08"],
    recommendation: "先检查周边积水、排水和渗漏来源，再安排复测",
  },
  {
    id: "CUR-Z04-02", componentId: "Z04", zoneId: "Z04-lower",
    label: "疑似虫蛀空洞（上部响应区）", branch: "融合", score: 0.84,
    priority: "优先复核", quality: "合格",
    evidence: ["echo-Z04-lower-seg-11", "img-Z04-lower-f05", "anno-box-03"],
    recommendation: "安排进一步检测，标注内部异常响应区，不预画虫道深度与形状",
  },
  {
    id: "CUR-Z04-03", componentId: "Z04", zoneId: "Z04-lower",
    label: "疑似虫蛀空洞（下部响应区）", branch: "融合", score: 0.87,
    priority: "待核对", quality: "不合格",
    evidence: ["echo-Z04-lower-seg-13", "img-Z04-lower-f11"],
    recommendation: "雷达单路质量不合格，需补充采集后重新融合",
  },
];

/* ------------------------------------------------------------------ *
 * 5. 环境记录与补偿（PRD 3.1）
 * ------------------------------------------------------------------ */

export const ENV_RECORD: EnvRecord = {
  recordId: "env-2026-0911-01",
  airTempC: 26.4,
  relativeHumidityPct: 78,
  windSpeedMs: 1.6,
  instrumentId: "THM-2207（温湿度）/ ANE-3310（风速）",
  instrumentRange: { min: -20, max: 60, unit: "℃" },
  position: "四柱区域入口，距 Z04 2.4m，离地 1.1m",
  measuredAt: "2026-09-11 12:26",
  operator: "沈 · 项目经理",
  submitState: "设备已确认",
  configVersion: "CFG-02",
  sourceMode: "simulation",
};

/** 历史环境记录（用于补偿前后对比的基础工况） */
export const ENV_HISTORY: EnvRecord[] = [
  { ...ENV_RECORD, recordId: "env-2026-0910-02", airTempC: 24.8, relativeHumidityPct: 71, windSpeedMs: 2.2, measuredAt: "2026-09-10 16:40", submitState: "设备已确认", configVersion: "CFG-01" },
  { ...ENV_RECORD, recordId: "env-2026-0910-01", airTempC: 23.1, relativeHumidityPct: 66, windSpeedMs: 3.4, measuredAt: "2026-09-10 09:15", submitState: "已提交", configVersion: "CFG-01" },
];

/** 已校验配置版本与上一版的差异 */
export const CONFIG_DIFF: ConfigDiffRow[] = [
  { field: "配置版本", before: "CFG-01", after: "CFG-02", note: "环境校验通过后生成，不可原地修改" },
  { field: "参考温度", before: "20.0 ℃", after: "26.4 ℃", note: "取本次实测值" },
  { field: "参考相对湿度", before: "60 %", after: "78 %", note: "0 ≤ RH ≤ 100 断言通过" },
  { field: "基线偏移量", before: "+0.0 dB", after: "-1.8 dB", note: "由参考件回波基线确定" },
  { field: "归一化方式", before: "固定尺度", after: "参考件归一化", note: "让送入模型的数据尺度稳定" },
  { field: "风速", before: "2.2 m/s", after: "1.6 m/s", note: "仅作采集稳定性记录，不代入 HH 公式" },
  { field: "处理函数版本", before: "comp-v1.3", after: "comp-v1.4", note: "每条曲线保存来源文件和处理配置" },
];

/** HH 平衡含水率只作环境先验（PRD 3.1） */
export const HH_PRIOR = {
  model: "Hailwood-Horrobin",
  estimatedEmcPct: 14.2,
  note: "该值描述木材与环境充分平衡时的状态；现场木柱未必已平衡，不能直接当成木柱内部实测含水率。",
  windExcluded: true,
  functionVersion: "hh-emc-v1.2（已核对的现有函数，非凭空生成实测值）",
};

/* ------------------------------------------------------------------ *
 * 6. 人员分工与操作记录
 * ------------------------------------------------------------------ */

export const MEMBERS: Member[] = [
  { id: "shen", name: "沈", role: "项目经理", duty: "环境校验、分组检查、新旧评估对比、工单审核、交付摘要校验", workspace: "工单与审核" },
  { id: "shi", name: "史", role: "人工智能架构师", duty: "小木调用、资料检索、场景发布、训练演示、封装下发、多模态分析", workspace: "平台总览" },
  { id: "rao", name: "饶", role: "全栈开发工程师", duty: "手持参数确认、原始数据上传、场景成果提交、更新包接收与回验", workspace: "采集与交付" },
  { id: "ma", name: "马", role: "具身智能工程师", duty: "地图检查、点位配置、巡检监视、样本位置复核、复巡计划", workspace: "建图巡检" },
];

export const ORDER_LOGS: LogEntry[] = [
  { at: "2026-09-11 08:12", actor: "史", action: "建立工单", object: "SH-2026-0901", result: "构件清单 Z01–Z04 已关联" },
  { at: "2026-09-11 12:26", actor: "沈", action: "录入环境记录", object: "env-2026-0911-01", result: "等待校验" },
  { at: "2026-09-11 12:41", actor: "沈", action: "环境校验", object: "env-2026-0911-01", result: "通过，生成 CFG-02" },
  { at: "2026-09-11 12:44", actor: "饶", action: "设备接收配置", object: "CFG-02", result: "ack 已返回，设备已确认" },
  { at: "2026-09-11 15:20", actor: "马", action: "保存地图版本", object: "MAP-SH-06", result: "待检查" },
  { at: "2026-09-11 21:38", actor: "史", action: "发布场景", object: "GS-2026.09", result: "已发布，各客户端收到通知" },
  { at: "2026-09-11 28:04", actor: "史", action: "异常事件", object: "scan-Z04-001", result: "适用域待核验，诊断输出冻结" },
  { at: "2026-09-11 33:52", actor: "沈", action: "分组检查", object: "DS-06", result: "三组物理样本 ID 交集为空" },
  { at: "2026-09-11 36:47", actor: "沈", action: "新旧评估对比", object: "EXP-2026-0911", result: "验收规则 5 项通过" },
  { at: "2026-09-11 38:26", actor: "饶", action: "执行模拟更新", object: "DEMO-PKG-02", result: "版本回执 DEMO-M02b" },
  { at: "2026-09-11 43:19", actor: "马", action: "核对测区", object: "Z04-lower", result: "柱号、标高与扫描方向一致" },
  { at: "2026-09-11 44:31", actor: "史", action: "生成工单草稿", object: "WO-2026-0912", result: "等待经理确认" },
];

/* ------------------------------------------------------------------ *
 * 7. 建图与巡检（PRD 3.2）
 * ------------------------------------------------------------------ */

export const MAP_VERSIONS: MapVersion[] = [
  { id: "MAP-SH-05", label: "MAP-SH-05", resolutionM: 0.05, sizeText: "2.1 MB", coveragePct: 82, updatedAt: "2026-09-10 17:12", state: "已保存", note: "上一轮建图，通道口有重影" },
  { id: "MAP-SH-06", label: "MAP-SH-06", resolutionM: 0.05, sizeText: "2.6 MB", coveragePct: 96, updatedAt: "2026-09-11 15:20", state: "待检查", note: "本轮建图，柱体边缘轮廓已对齐" },
  { id: "MAP-SH-06a", label: "MAP-SH-06a", resolutionM: 0.05, sizeText: "2.4 MB", coveragePct: 93, updatedAt: "2026-09-11 15:31", state: "采集中", note: "补扫合并候选，尚未保存" },
];

const GW = 40;
const GH = 26;

/** 占据栅格：0 可通行 / 1 占据 / 2 未知（PRD 8.2 未知格与可通行格分别着色） */
function buildGrid(): number[] {
  const cells: number[] = new Array(GW * GH).fill(2);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= GW || y >= GH) return;
    cells[y * GW + x] = v;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(x, y, v);
  };
  // 大殿室内可通行区
  rect(4, 4, 35, 20, 0);
  // 墙体
  rect(3, 3, 36, 3, 1);
  rect(3, 21, 36, 21, 1);
  rect(3, 3, 3, 21, 1);
  rect(36, 3, 36, 21, 1);
  // 四柱（2x2 占据块）
  const pillar = (cx: number, cy: number) => rect(cx, cy, cx + 1, cy + 1, 1);
  pillar(8, 8); // Z01
  pillar(15, 8); // Z02
  pillar(23, 8); // Z03
  pillar(30, 8); // Z04
  // 佛坛台阶（占据）
  rect(6, 15, 33, 16, 1);
  // 柱础
  rect(7, 11, 32, 11, 1);
  // 入口通道
  rect(18, 22, 22, 25, 0);
  // 殿内几处未知残留（模拟未完全覆盖）
  rect(5, 5, 6, 6, 2);
  rect(33, 18, 35, 19, 2);
  return cells;
}

export const GRID_MAP: GridMap = {
  width: GW,
  height: GH,
  resolutionM: 0.1,
  origin: [-2.0, -1.3],
  cells: buildGrid(),
  legend: [
    { code: 0, label: "可通行", color: "#173a63" },
    { code: 1, label: "占据", color: "#8fc2ff" },
    { code: 2, label: "未知", color: "#0a1526" },
  ],
};

export const WAYPOINTS: Waypoint[] = [
  { id: "P1", label: "起点 / 殿门", componentId: null, cell: [20, 24], state: "已到达" },
  { id: "P2", label: "Z01 观察点", componentId: "Z01", cell: [6, 10], state: "已到达" },
  { id: "P3", label: "Z02 观察点", componentId: "Z02", cell: [14, 10], state: "已到达" },
  { id: "P4", label: "Z03 观察点", componentId: "Z03", cell: [22, 10], state: "当前目标" },
  { id: "P5", label: "Z04 观察点（避开手持作业区）", componentId: "Z04", cell: [31, 12], state: "待执行" },
  { id: "P6", label: "东侧回廊", componentId: null, cell: [34, 19], state: "待执行" },
];

export const FORBIDDEN_ZONES: ForbiddenZone[] = [
  { id: "FZ-01", label: "Z04 手持作业区", cell: [29, 13], w: 3, h: 3, reason: "精扫进行中，小车点位避开该区域" },
  { id: "FZ-02", label: "佛坛台阶", cell: [6, 15], w: 28, h: 2, reason: "高差与文物本体，禁止通行" },
  { id: "FZ-03", label: "临时器材区", cell: [4, 18], w: 3, h: 3, reason: "现场工具箱与参考件摆放区" },
];

/** 平台计划路径（围绕四柱外侧一圈） */
export const PLANNED_PATH: [number, number][] = [
  [20, 24], [20, 20], [20, 22], [20, 18], [16, 18], [10, 18], [6, 17], [5, 12], [6, 10],
  [10, 6], [14, 6], [14, 10], [18, 6], [22, 6], [22, 10], [26, 6], [31, 6], [34, 8],
  [34, 12], [31, 12], [34, 16], [34, 19],
];

/** 机器人实际路径单独着色：与计划路径存在可观察的偏差 */
export const ACTUAL_PATH: [number, number][] = [
  [20, 24], [20, 20], [19, 22], [19, 18], [16, 17], [11, 17], [6, 17], [5, 12], [6, 10],
  [10, 6], [14, 6], [14, 10], [18, 7], [22, 6], [22, 10], [26, 6], [31, 6], [34, 8],
  [34, 12], [31, 12], [33, 16],
];

export const POSE_TRACK: PoseSample[] = [
  { t: "14:18:02", cell: [20, 24] },
  { t: "14:19:10", cell: [16, 18] },
  { t: "14:20:05", cell: [10, 17] },
  { t: "14:20:44", cell: [6, 12] },
  { t: "14:21:20", cell: [14, 10] },
  { t: "14:22:02", cell: [22, 7] },
  { t: "14:22:33", cell: [31, 10] },
];

export const MISSION: Mission = {
  id: "MSN-2026-0911-02",
  robotId: DEVICES.demoCart.name,
  mapVersion: "MAP-SH-06",
  speedProfile: "SP-02 低速巡检（0.25 m/s，转弯 0.12 m/s）",
  state: "执行中",
  waypoints: WAYPOINTS,
  plannedPath: PLANNED_PATH,
  actualPath: ACTUAL_PATH,
  steps: [
    { at: "14:16:40", label: "任务预览已生成", actor: "史", result: "计划摘要与里程 24.6m" },
    { at: "14:17:05", label: "等待机器人确认", actor: "平台", result: "已下发，HTTP 成功不等于车端接收" },
    { at: "14:17:22", label: "小车已接收任务", actor: "马", result: "accepted" },
    { at: "14:17:30", label: "进入执行中", actor: "马", result: "running" },
    { at: "14:19:10", label: "到达 Z01 观察点", actor: "平台", result: "已到达 P2" },
    { at: "14:22:33", label: "到达 Z03 观察点", actor: "平台", result: "当前目标 P4" },
  ],
  takeover: [
    { at: "14:20:58", reason: "临时器材区边缘人工减速通过", operator: "马" },
    { at: "14:21:46", reason: "地面线缆，局部路径重规划后继续", operator: "马" },
  ],
  anomalies: [
    { at: "14:19:52", text: "视频通道延迟 9 秒，仅影响该通道，不影响车辆在线判断" },
    { at: "14:21:12", text: "位姿短时抖动 0.04m，已由激光观测校正" },
  ],
};

/* ------------------------------------------------------------------ *
 * 8. 场景库与热点（PRD 3.3）
 * ------------------------------------------------------------------ */

export const SCENES: SceneAsset[] = [
  {
    id: "scene-May", title: "示例寺四柱 · 五月历史场景", round: "历史",
    sourceVideo: "may_round1_pano.mp4（离线预采）", keyframes: 168, version: "GS-2026.05",
    published: "已发布", format: "spark-splat / manifest json", bbox: "18.4m × 11.2m × 6.8m",
    updatedAt: "2026-05-18 17:40", sourceMode: "replay",
  },
  {
    id: "scene-SH-0901", title: "示例寺四柱 · 本轮场景", round: "本轮",
    sourceVideo: "precollected_sh_0901_pano.mp4（预采，现场录像稍后归档）", keyframes: 214, version: "GS-2026.09",
    published: "已发布", format: "spark-splat / manifest json", bbox: "18.6m × 11.4m × 6.9m",
    updatedAt: "2026-09-11 21:38", sourceMode: "replay",
  },
  {
    id: "scene-SH-0901-raw", title: "示例寺四柱 · 本轮原始导入（待检查）", round: "本轮",
    sourceVideo: "precollected_sh_0901_pano.mp4", keyframes: 214, version: "GS-2026.09-rc1",
    published: "待检查", format: "MipMap 导出目录", bbox: "18.6m × 11.4m × 6.9m",
    updatedAt: "2026-09-11 21:12", sourceMode: "replay",
  },
];

export const SCENE_BOOKMARKS = [
  { id: "BM-Z01-lower", componentId: "Z01", label: "Z01 下部正视", azimuth: 12, polar: 78 },
  { id: "BM-Z02-lower", componentId: "Z02", label: "Z02 下部正视", azimuth: 12, polar: 78 },
  { id: "BM-Z03-lower", componentId: "Z03", label: "Z03 下部正视", azimuth: 12, polar: 78 },
  { id: "BM-Z04-lower", componentId: "Z04", label: "Z04 下部正视", azimuth: 348, polar: 82 },
  { id: "BM-Z04-side", componentId: "Z04", label: "Z04 内侧侧视", azimuth: 300, polar: 74 },
  { id: "BM-hall-overview", componentId: "", label: "殿内总览（复位）", azimuth: 0, polar: 62 },
];

export const HOTSPOTS: HotspotEvidence[] = [
  {
    hotspotId: "hs-Z04-lower", componentId: "Z04", zoneId: "Z04-lower", label: "Z04 下部测区热点",
    image: { name: "img-Z04-lower-f11.jpg", note: "表面缺损与孔洞状疑点，视觉标注来源 JSON" },
    echo: { peakIndex: 0.62, amplitude: 0.87, unit: "归一化幅值", note: "横轴为频点索引，未标定距离轴，不写作深度" },
    screening: { material: "疑似楠木（低置信，不足以判定材种）", score: 0.87, note: "端侧初筛结果，需融合复核" },
    fusion: { ruleVersion: "FUSION-03", priority: "待核对", branches: ["视觉：异常", "雷达：异常", "质量：雷达单路不合格"] },
    history: [
      { at: "2026-05-18", text: "R04 柱脚渗水痕迹，已施工反馈，待验收", operator: "沈" },
      { at: "2026-09-11 28:04", text: "初扫触发适用域待核验，诊断输出冻结", operator: "史" },
      { at: "2026-09-11 39:44", text: "复扫批次 scan-Z04-002 三处样例异常回传", operator: "饶" },
    ],
  },
  {
    hotspotId: "hs-Z03-lower", componentId: "Z03", zoneId: "Z03-lower", label: "Z03 下部测区热点",
    image: { name: "img-Z03-lower-f02.jpg", note: "漆层局部起翘" },
    echo: { peakIndex: 0.34, amplitude: 0.41, unit: "归一化幅值", note: "未精扫，仅保留观察记录" },
    screening: { material: "楠木（档案）", score: 0.41, note: "外观提示，未做内部判断" },
    fusion: { ruleVersion: "FUSION-03", priority: "补充检测", branches: ["视觉：异常", "雷达：无对应响应"] },
    history: [{ at: "2026-05-18", text: "R03 地仗修补痕迹，已验收关闭", operator: "沈" }],
  },
  {
    hotspotId: "hs-Z01-lower", componentId: "Z01", zoneId: "Z01-lower", label: "Z01 下部测区热点",
    image: { name: "img-Z01-lower-f01.jpg", note: "外观连续" },
    echo: { peakIndex: 0.18, amplitude: 0.22, unit: "归一化幅值", note: "未精扫" },
    screening: { material: "杉木（档案）", score: 0.22, note: "保留观察记录" },
    fusion: { ruleVersion: "FUSION-03", priority: "补充检测", branches: ["视觉：正常", "雷达：未采集"] },
    history: [{ at: "2026-05-18", text: "R01 柱脚漆层剥落，已验收关闭", operator: "沈" }],
  },
];

/* ------------------------------------------------------------------ *
 * 9. 手持采集批次与波形（PRD 3.4 / 9.2）
 * ------------------------------------------------------------------ */

export const SCAN_BATCHES: ScanBatch[] = [
  {
    batchId: "scan-Z04-001", componentId: "Z04", zoneId: "Z04-lower", round: "初扫",
    configVersion: "CFG-02", modelVersion: "DEMO-M02", rawLevel: "spectrum", startedAt: "2026-09-11 27:36",
    receive: {
      radar: { received: 386, expected: 420, state: "部分接收" },
      image: { received: 12, expected: 12, state: "完成" },
      result: { received: 0, expected: 1, state: "未开始" },
    },
    frozen: true, freezeReason: "适用域待核验：当前部署模型缺少该批次木材的有效标定记录", sourceMode: "simulation",
  },
  {
    batchId: "scan-Z04-002", componentId: "Z04", zoneId: "Z04-lower", round: "复扫",
    configVersion: "CFG-02", modelVersion: "DEMO-M02b", rawLevel: "spectrum", startedAt: "2026-09-11 39:26",
    receive: {
      radar: { received: 420, expected: 420, state: "完成" },
      image: { received: 14, expected: 14, state: "完成" },
      result: { received: 3, expected: 3, state: "完成" },
    },
    frozen: false, freezeReason: null, sourceMode: "simulation",
  },
  {
    batchId: "ref-batch-01", componentId: "REF", zoneId: "REF-A", round: "初扫",
    configVersion: "CFG-02", modelVersion: "DEMO-M02", rawLevel: "ADC", startedAt: "2026-09-11 31:22",
    receive: {
      radar: { received: 168, expected: 168, state: "完成" },
      image: { received: 8, expected: 8, state: "完成" },
      result: { received: 0, expected: 0, state: "完成" },
    },
    frozen: false, freezeReason: null, sourceMode: "simulation",
  },
];

/** 频率轴（已是频谱，不再做 FFT；横轴标频点索引，不写作深度） */
function specPoints(seed: number, peaks: { x: number; h: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= 240; i += 1) {
    const x = i / 240;
    let y =
      0.16 +
      0.05 * Math.sin(i * 0.21 + seed) +
      0.035 * Math.sin(i * 0.63 + seed * 2) +
      0.02 * Math.sin(i * 1.7 + seed * 3);
    for (const peak of peaks) {
      const d = x - peak.x;
      y += peak.h * Math.exp(-(d * d) / 0.0009);
    }
    out.push({ x: Number(x.toFixed(4)), y: Number(Math.max(0.02, Math.min(0.99, y)).toFixed(4)) });
  }
  return out;
}

export const WAVEFORMS: Waveform[] = [
  {
    id: "wf-Z04-001", batchId: "scan-Z04-001", axisLabel: "频点索引（未标定距离轴）", unit: "归一化幅值",
    points: specPoints(1.2, [{ x: 0.62, h: 0.52 }, { x: 0.29, h: 0.2 }]),
    markers: [{ x: 0.62, label: "疑点响应段 seg-11", tone: "amber" }],
  },
  {
    id: "wf-Z04-002", batchId: "scan-Z04-002", axisLabel: "频点索引（未标定距离轴）", unit: "归一化幅值",
    points: specPoints(2.4, [{ x: 0.62, h: 0.58 }, { x: 0.47, h: 0.31 }, { x: 0.29, h: 0.26 }]),
    markers: [
      { x: 0.29, label: "疑似受潮 0.71", tone: "amber" },
      { x: 0.47, label: "疑似空洞 0.84", tone: "red" },
      { x: 0.62, label: "疑似空洞 0.87", tone: "red" },
    ],
  },
  {
    id: "wf-ref-01", batchId: "ref-batch-01", axisLabel: "频点索引（未标定距离轴）", unit: "归一化幅值",
    points: specPoints(0.6, [{ x: 0.33, h: 0.18 }]),
    markers: [],
  },
  {
    id: "wf-comp-before", batchId: "env-2026-0911-01", axisLabel: "参考件频点索引", unit: "归一化幅值",
    points: specPoints(3.1, [{ x: 0.33, h: 0.44 }]),
    markers: [{ x: 0.33, label: "补偿前基线", tone: "cyan" }],
  },
  {
    id: "wf-comp-after", batchId: "env-2026-0911-01", axisLabel: "参考件频点索引", unit: "归一化幅值",
    points: specPoints(3.1, [{ x: 0.33, h: 0.2 }]),
    markers: [{ x: 0.33, label: "补偿后基线", tone: "cyan" }],
  },
];

/** 异常排查四项（PRD 3.4） */
export const TRIAGE_ITEMS: TriageItem[] = [
  {
    id: "tr-device", key: "device", title: "设备状态", owner: "饶",
    records: [
      { at: "28:12", text: "供电电压 12.4V，传感器响应正常", result: "正常" },
      { at: "28:40", text: "参考件回波与出厂基线一致（偏差 0.3dB）", result: "正常" },
      { at: "29:05", text: "USB 传输无丢包，落盘 386/420 帧", result: "部分接收" },
    ],
    conclusion: "未发现足以解释本次异常的明显设备问题", signature: "饶", state: "已签名",
  },
  {
    id: "tr-signal", key: "signal", title: "信号质量", owner: "饶",
    records: [
      { at: "28:18", text: "空帧 0，非有限值 0，饱和帧比例 2.1%", result: "合格" },
      { at: "28:52", text: "有效数据比例 91.9%，低于整批校验阈值", result: "待复核" },
    ],
    conclusion: "信号可用但有效比例偏低，需补采后再判定", signature: "饶", state: "已签名",
  },
  {
    id: "tr-zone", key: "zone", title: "测区条件", owner: "马",
    records: [
      { at: "29:20", text: "柱号 Z04、参考标高 +0.35m 与现场标尺一致", result: "一致" },
      { at: "29:44", text: "表面存在反光与遮挡，距离变化 ±18mm", result: "记录" },
    ],
    conclusion: "测区位置与扫描方向已核对；表面反光需在复扫时避开", signature: "马", state: "已签名",
  },
  {
    id: "tr-applicability", key: "applicability", title: "模型适用范围", owner: "史",
    records: [
      { at: "30:02", text: "输入质量：信号完整度 91.9%", result: "合格" },
      { at: "30:20", text: "特征偏移：与参考分布偏离 2.7σ", result: "超限" },
      { at: "30:38", text: "模型配置：DEMO-M02 缺少该批次木材标定记录", result: "不适用" },
    ],
    conclusion: "触发适用域待核验，冻结该批诊断输出；仅凭低置信度不判定材种", signature: "史", state: "已签名",
  },
];

export const ANOMALY_EVENTS: AnomalyEvent[] = [
  {
    id: "evt-domain-01", at: "2026-09-11 28:04", kind: "适用域待核验",
    detail: "输入质量合格、特征偏移超限、模型配置不覆盖该材种，三项合并后触发",
    frozenBatch: "scan-Z04-001", outputsFrozen: true, trigger: "演示控制事件",
    evidence: ["输入质量报告 q-0911", "参考分布对比 chart-ref", "模型卡模型卡 DEMO-M02"],
  },
  {
    id: "evt-img-01", at: "2026-09-11 22:06", kind: "表面疑点",
    detail: "四柱关键帧对比，Z04 视角可见表面缺损与孔洞状疑点",
    frozenBatch: "—", outputsFrozen: false, trigger: "演示控制事件",
    evidence: ["keyframe-Z04-03", "keyframe-Z01-02"],
  },
];

/* ------------------------------------------------------------------ *
 * 10. 数据集与样本（PRD 3.5 / 11.1）
 * ------------------------------------------------------------------ */

/** 参考样本批次：同一块样本的连续扫描属于同一 group，不能拆散到不同集合 */
export const REFERENCE_BATCHES = [
  { batchId: "ref-Z04-g1", groupId: "G-SAMPLE-01", material: "楠木（来源：修缮余料库）", scans: 3, direction: "0° / 45° / 90°" },
  { batchId: "ref-Z04-g2", groupId: "G-SAMPLE-02", material: "杉木（来源：同批旧料）", scans: 2, direction: "0° / 90°" },
  { batchId: "ref-Z04-g3", groupId: "G-SAMPLE-03", material: "楠木（来源：待核验）", scans: 2, direction: "0° / 30°" },
];

export const SAMPLES: Sample[] = [
  { physicalSampleId: "S-01", recordId: "r-0001", path: "ref/ref-Z04-g1/scan_000.csv", materialSource: "修缮余料库 · 楠木", knownState: "正常", labelBasis: "来源卡 + 目视复核", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-01", distanceMm: 25, direction: "0°", saturationPct: 0.4, duplicateOf: null, sourceBatch: "ref-Z04-g1" },
  { physicalSampleId: "S-01", recordId: "r-0002", path: "ref/ref-Z04-g1/scan_001.csv", materialSource: "修缮余料库 · 楠木", knownState: "正常", labelBasis: "来源卡 + 目视复核", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-01", distanceMm: 30, direction: "45°", saturationPct: 0.6, duplicateOf: null, sourceBatch: "ref-Z04-g1" },
  { physicalSampleId: "S-01", recordId: "r-0003", path: "ref/ref-Z04-g1/scan_002.csv", materialSource: "修缮余料库 · 楠木", knownState: "正常", labelBasis: "来源卡 + 目视复核", quality: "待审核", qualityReason: "与 r-0002 摘要高度相似，疑似重复", groupId: "G-SAMPLE-01", distanceMm: 30, direction: "45°", saturationPct: 0.6, duplicateOf: "r-0002", sourceBatch: "ref-Z04-g1" },
  { physicalSampleId: "S-02", recordId: "r-0004", path: "ref/ref-Z04-g2/scan_000.csv", materialSource: "同批旧料 · 杉木", knownState: "正常", labelBasis: "来源卡 + 目视复核", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-02", distanceMm: 25, direction: "0°", saturationPct: 1.1, duplicateOf: null, sourceBatch: "ref-Z04-g2" },
  { physicalSampleId: "S-02", recordId: "r-0005", path: "ref/ref-Z04-g2/scan_001.csv", materialSource: "同批旧料 · 杉木", knownState: "正常", labelBasis: "来源卡 + 目视复核", quality: "不可用", qualityReason: "空文件（0 字节）", groupId: "G-SAMPLE-02", distanceMm: 25, direction: "90°", saturationPct: 0, duplicateOf: null, sourceBatch: "ref-Z04-g2" },
  { physicalSampleId: "S-03", recordId: "r-0006", path: "ref/ref-Z04-g3/scan_000.csv", materialSource: "待核验来源 · 楠木", knownState: "已知缺陷", labelBasis: "人工标记（含空洞）", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-03", distanceMm: 22, direction: "0°", saturationPct: 2.4, duplicateOf: null, sourceBatch: "ref-Z04-g3" },
  { physicalSampleId: "S-03", recordId: "r-0007", path: "ref/ref-Z04-g3/scan_001.csv", materialSource: "待核验来源 · 楠木", knownState: "未知待核验", labelBasis: "无标签依据，保留待核验", quality: "待审核", qualityReason: "标签待核验，不进入监督训练", groupId: "G-SAMPLE-03", distanceMm: 22, direction: "30°", saturationPct: 11.8, duplicateOf: null, sourceBatch: "ref-Z04-g3" },
  { physicalSampleId: "S-04", recordId: "r-0008", path: "rescan/scan-Z04-002/frame_018.csv", materialSource: "现场 Z04 复扫", knownState: "未知待核验", labelBasis: "无标签依据，单列待核验集合", quality: "待审核", qualityReason: "数值离群（距组中心 3.4σ）", groupId: "G-SAMPLE-04", distanceMm: 28, direction: "0°", saturationPct: 4.2, duplicateOf: null, sourceBatch: "scan-Z04-002" },
  { physicalSampleId: "S-04", recordId: "r-0009", path: "rescan/scan-Z04-002/frame_031.csv", materialSource: "现场 Z04 复扫", knownState: "已知缺陷", labelBasis: "融合规则 FUSION-03 标注 + 人工确认", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-04", distanceMm: 28, direction: "0°", saturationPct: 3.1, duplicateOf: null, sourceBatch: "scan-Z04-002" },
  { physicalSampleId: "S-05", recordId: "r-0010", path: "legacy/may-round1/Z01_scan.csv", materialSource: "五月批次 · 杉木", knownState: "正常", labelBasis: "历史报告 MAY-DEMO-01", quality: "不可用", qualityReason: "格式损坏（列数不一致）", groupId: "G-SAMPLE-05", distanceMm: 25, direction: "0°", saturationPct: 0, duplicateOf: null, sourceBatch: "may-round1" },
  { physicalSampleId: "S-05", recordId: "r-0011", path: "legacy/may-round1/Z02_scan.csv", materialSource: "五月批次 · 杉木", knownState: "正常", labelBasis: "历史报告 MAY-DEMO-01", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-05", distanceMm: 25, direction: "0°", saturationPct: 0.8, duplicateOf: null, sourceBatch: "may-round1" },
  { physicalSampleId: "S-06", recordId: "r-0012", path: "legacy/may-round1/Z03_scan.csv", materialSource: "五月批次 · 楠木", knownState: "正常", labelBasis: "历史报告 MAY-DEMO-01", quality: "可用", qualityReason: "字段完整", groupId: "G-SAMPLE-06", distanceMm: 25, direction: "0°", saturationPct: 1.2, duplicateOf: null, sourceBatch: "may-round1" },
];

export const CLEAN_STEPS: CleanStep[] = [
  { key: "schema", label: "字段与空值检查", input: 12, kept: 9, review: 0, reason: "3 条空文件 / 格式损坏，确定不可用，不进审核队列" },
  { key: "dup", label: "重复摘要筛查", input: 9, kept: 8, review: 1, reason: "r-0003 与 r-0002 摘要高度相似，先待审核" },
  { key: "range", label: "数值范围与饱和检查", input: 8, kept: 7, review: 1, reason: "r-0007 饱和比例 11.8% 超限，待审核" },
  { key: "cluster", label: "特征相似度与聚类（固定随机种子）", input: 7, kept: 6, review: 1, reason: "r-0008 距组中心 3.4σ，作为审核建议而非自动删除" },
  { key: "group", label: "按物理样本分组并输出组清单", input: 6, kept: 6, review: 0, reason: "同一 physical_sample_id 编入同一 group_id，训练集不做跨组拆分" },
];

export const DATASET: Dataset = {
  id: "DS-06",
  label: "DS-06 · 楠木适配样本集（冻结）",
  frozen: true,
  frozenAt: "2026-09-11 34:12",
  reviewAssign: [
    { owner: "饶", task: "信号复核：饱和、掉帧与采集异常", state: "已通过" },
    { owner: "马", task: "来源与位置复核：样本编号、扫描方向、测区", state: "已通过" },
    { owner: "沈", task: "标签与集合分组复核（受限 Python 校验单元）", state: "已通过" },
    { owner: "史", task: "版本确认与冻结", state: "已通过" },
  ],
  cleanSteps: CLEAN_STEPS,
  splits: [
    { name: "训练集", sampleIds: ["S-01", "S-02", "S-03"] },
    { name: "验证集", sampleIds: ["S-04", "S-05"] },
    { name: "测试集", sampleIds: ["S-06"] },
  ],
  indexVersion: "idx-12",
  sourceMode: "simulation",
};

/* ------------------------------------------------------------------ *
 * 11. 训练验证实验（PRD 3.6 / 11.2）
 * ------------------------------------------------------------------ */

function lossCurve(base: number, floor: number, decay: number, id: string, label: string, color: string): Curve {
  const points: { x: number; y: number }[] = [];
  for (let e = 1; e <= 40; e += 1) {
    const y = floor + (base - floor) * Math.exp(-decay * e) + 0.004 * Math.sin(e * 0.9);
    points.push({ x: e, y: Number(y.toFixed(4)) });
  }
  return { id, label, color, points };
}

const MATERIALS = ["楠木", "杉木", "松木"];

function predictions(version: "old" | "new"): Experiment["predictionsOld"] {
  const rows: Experiment["predictionsOld"] = [];
  const testIds = ["S-06", "S-07", "S-08", "S-09", "S-10", "S-11", "S-12", "S-13", "S-14", "S-15", "S-16", "S-17"];
  testIds.forEach((sampleId, index) => {
    const material = MATERIALS[index % MATERIALS.length];
    const label: 0 | 1 = index % 3 === 0 ? 1 : 0;
    const oldScore = [0.58, 0.41, 0.33, 0.62, 0.44, 0.29, 0.66, 0.38, 0.52, 0.47, 0.36, 0.6][index];
    const newScore = [0.88, 0.19, 0.12, 0.83, 0.21, 0.09, 0.79, 0.16, 0.74, 0.24, 0.13, 0.81][index];
    rows.push({
      sampleId,
      groupId: `G-${String(index + 6).padStart(2, "0")}`,
      label,
      score: version === "old" ? oldScore : newScore,
      materialGroup: material,
      material,
    });
  });
  return rows;
}

export const EXPERIMENT: Experiment = {
  id: "EXP-2026-0911",
  title: "Z04 新材适配 · 小样本微调（演示记录）",
  baselineVersion: "DEMO-M02",
  candidateVersion: "DEMO-M02b",
  datasetVersion: "DS-06（已冻结）",
  learningRate: 0.0005,
  stopCondition: "验证损失连续 6 轮未下降即停止；最少 12 轮，最多 40 轮",
  updateScope: "仅材质相关分支：最后 2 个卷积块 + 分类头（约 8.4% 参数）",
  inputSpec: "输入 1×420 频谱向量（均匀采样），float32 → INT8 量化，输出 3 类材质 + 异常二分类",
  threshold: 0.5,
  jobSteps: [
    { key: "queue", label: "排队", state: "已完成", at: "34:20" },
    { key: "prepare", label: "数据准备", state: "已完成", at: "34:34" },
    { key: "adapt", label: "适配", state: "已完成", at: "35:58" },
    { key: "validate", label: "验证", state: "已完成", at: "36:41" },
    { key: "done", label: "完成", state: "已完成", at: "36:47" },
  ],
  curveOld: lossCurve(1.24, 0.36, 0.09, "old", "DEMO-M02 旧版损失", "#789EFF"),
  curveNew: lossCurve(1.18, 0.19, 0.13, "new", "DEMO-M02b 新版损失", "#8fc2ff"),
  predictionsOld: predictions("old"),
  predictionsNew: predictions("new"),
  acceptance: [
    { key: "same-test", label: "测试集一致", detail: "新旧版本使用同一测试清单与同一预处理版本", pass: true },
    { key: "label-full", label: "标签完整", detail: "测试集全部样本 label_basis 非空；未知标签不进入监督训练", pass: true },
    { key: "no-cross", label: "无分组交叉", detail: "训练 / 验证 / 测试物理样本 ID 交集为空", pass: true },
    { key: "preprocess", label: "预处理版本一致", detail: "preprocess=comp-v1.4 / norm=ref-normalized", pass: true },
    { key: "metric", label: "必要指标条件", detail: "漏检率不高于基线，原有材种召回不低于基线 -0.02", pass: true },
    { key: "regression", label: "原有材种回归", detail: "杉木 / 松木分组召回未退化", pass: true },
  ],
  sourceMode: "simulation",
};

/** 失败案例：供排练与答辩演示「阻止进入发布」（PRD 3.6 / 11.2） */
export const FAILED_EXPERIMENT: Experiment = {
  ...EXPERIMENT,
  id: "EXP-2026-0911-FAIL",
  title: "Z04 新材适配 · 失败案例（漏检增加 + 旧材退化）",
  predictionsNew: predictions("old"),
  acceptance: [
    { key: "same-test", label: "测试集一致", detail: "新旧版本使用同一测试清单与同一预处理版本", pass: true },
    { key: "label-full", label: "标签完整", detail: "测试集全部样本 label_basis 非空", pass: true },
    { key: "no-cross", label: "无分组交叉", detail: "训练 / 验证 / 测试物理样本 ID 交集为空", pass: true },
    { key: "preprocess", label: "预处理版本一致", detail: "preprocess=comp-v1.4 / norm=ref-normalized", pass: true },
    { key: "metric", label: "必要指标条件", detail: "漏检率 0.333 高于基线 0.25，未通过", pass: false },
    { key: "regression", label: "原有材种回归", detail: "杉木分组召回由 0.92 降至 0.78，退化超限", pass: false },
  ],
};

/* ------------------------------------------------------------------ *
 * 12. 更新交付（PRD 3.6 / 11.3）
 * ------------------------------------------------------------------ */

export const UPDATE_PACKAGE: UpdatePackage = {
  id: "DEMO-PKG-02",
  artifactKind: "demo_nonflashable",
  modelVersion: "DEMO-M02b（候选）",
  preprocess: "comp-v1.4 / ref-normalized（与训练完全一致）",
  inputSpec: "1×420 频谱向量，float32 输入，INT8 权重",
  outputSpec: "3 类材质概率 + 异常二分类分数（不做两路分数相加）",
  targetEnv: "手持采集端 ESP32-S3 + 树莓派上位机（模拟设备记录）",
  sha256: "3f9c1d2a7b45e8c0a1d6f3b29c7e5408a2b6d19f4c8e3a70d5b2f61c9e0a4d78",
  sizeText: "3.2 MB",
  fallbackVersion: "DEMO-M02（旧版本已保留，可恢复）",
  quantization: [
    { key: "q1", label: "INT8 量化", detail: "缩放系数与零点由代表性数据确定；边界样本复测" },
    { key: "q2", label: "量化后复测", detail: "复测集 24 条，异常分类一致 22 条，2 条边界样本回退到 float 分支" },
    { key: "q3", label: "算子与内存检查", detail: "输入长度 420、算子支持列表与可用内存均满足" },
  ],
  compatibility: [
    { key: "c1", label: "目标设备型号", pass: true, detail: "手持毫米波 02 号机（scan-dev-02）" },
    { key: "c2", label: "输入长度", pass: true, detail: "420 ≤ 设备最大输入 512" },
    { key: "c3", label: "算子支持", pass: true, detail: "conv2d / bn / relu / gap / fc 均在支持列表" },
    { key: "c4", label: "恢复版本可用", pass: true, detail: "DEMO-M02 备份完整，摘要一致" },
    { key: "c5", label: "烧录能力", pass: false, detail: "演示包 artifact_kind=demo_nonflashable，禁止调用刷写工具" },
  ],
  steps: [
    { key: "quant", label: "量化记录", owner: "史", state: "已完成", at: "37:12", note: "INT8 量化与复测完成" },
    { key: "compat", label: "兼容性检查", owner: "史", state: "已完成", at: "37:26", note: "4 项通过，烧录能力项按演示包标记为不适用" },
    { key: "pack", label: "封装", owner: "史", state: "已完成", at: "37:48", note: "生成 DEMO-PKG-02.demo.zip" },
    { key: "deliver", label: "下发", owner: "史", state: "已完成", at: "38:02", note: "指定接收人饶、设备 scan-dev-02" },
    { key: "receive", label: "接收", owner: "饶", state: "已完成", at: "38:14", note: "摘要校验通过，旧版本已保留" },
    { key: "update", label: "更新", owner: "饶", state: "已完成", at: "38:26", note: "模拟更新写入完成" },
    { key: "selfcheck", label: "重启自检", owner: "饶", state: "已完成", at: "38:52", note: "固定参考输入回验通过" },
    { key: "confirm", label: "版本确认", owner: "史", state: "已完成", at: "39:04", note: "demo_reported_version = DEMO-M02b" },
  ],
  deviceVersion: { liveReported: "FW-1.4.2（实机未变，演示期间继续使用已验证程序）", demoReported: "DEMO-M02b / FW-DEMO-1.4.2" },
  sourceMode: "simulation",
};

/* ------------------------------------------------------------------ *
 * 13. 融合分析（PRD 3.7）
 * ------------------------------------------------------------------ */

export type FusionBranch = {
  key: string;
  label: string;
  detail: string;
  state: "合格" | "不合格" | "未采集";
};

export type FusionRecord = {
  recordId: string;
  ruleVersion: string;
  batchId: string;
  branches: FusionBranch[];
  completeness: { label: string; value: string; ok: boolean; note: string }[];
  annotations: { boxId: string; image: string; label: string; confidence: number; zone: string; source: string }[];
  radarFeatures: { segment: string; zone: string; amplitude: number; quality: "合格" | "不合格" }[];
  zoneMatch: { visual: string; radar: string; matched: boolean; note: string }[];
  outputs: {
    riskId: string;
    label: string;
    priority: CurrentRisk["priority"];
    rule: string;
    basis: string;
    nextAction: string;
    quality: CurrentRisk["quality"];
  }[];
  sourceMode: SourceMode;
};

export const FUSION_RECORD: FusionRecord = {
  recordId: "fusion-2026-0911-01",
  ruleVersion: "FUSION-03",
  batchId: "scan-Z04-002",
  branches: [
    { key: "vision", label: "视觉分支", detail: "图像标注 JSON 载入，定位裂缝、孔洞等表面疑点", state: "合格" },
    { key: "radar", label: "雷达分支", detail: "统一预处理后的回波特征，按构件与测区匹配", state: "合格" },
    { key: "quality", label: "质量门槛", detail: "seg-13 有效数据比例 88.4%，低于 90% 门槛", state: "不合格" },
  ],
  completeness: [
    { label: "原始数据完整性", value: "420/420 帧", ok: true, note: "雷达与图像按同一批次、测区和时间容差匹配" },
    { label: "表面图像", value: "14/14 帧", ok: true, note: "时间戳匹配，超限记录单独标记" },
    { label: "结果文件", value: "3/3 个", ok: true, note: "端侧初筛结果文件齐全" },
    { label: "预处理版本", value: "comp-v1.4", ok: true, note: "平台与手持端一致" },
  ],
  annotations: [
    { boxId: "anno-box-03", image: "img-Z04-lower-f05.jpg", label: "孔洞状疑点", confidence: 0.84, zone: "Z04-lower", source: "视觉标注 JSON（预设标注演示）" },
    { boxId: "anno-box-07", image: "img-Z04-lower-f08.jpg", label: "疑似受潮区", confidence: 0.71, zone: "Z04-lower", source: "视觉标注 JSON（预设标注演示）" },
    { boxId: "anno-box-11", image: "img-Z04-lower-f11.jpg", label: "孔洞状疑点", confidence: 0.87, zone: "Z04-lower", source: "视觉标注 JSON（预设标注演示）" },
  ],
  radarFeatures: [
    { segment: "echo-Z04-lower-seg-07", zone: "Z04-lower", amplitude: 0.71, quality: "合格" },
    { segment: "echo-Z04-lower-seg-11", zone: "Z04-lower", amplitude: 0.84, quality: "合格" },
    { segment: "echo-Z04-lower-seg-13", zone: "Z04-lower", amplitude: 0.87, quality: "不合格" },
  ],
  zoneMatch: [
    { visual: "anno-box-07", radar: "seg-07", matched: true, note: "同一测区 Z04-lower，构图与扫描方向一致" },
    { visual: "anno-box-03", radar: "seg-11", matched: true, note: "同一测区，两路均提示异常且质量合格" },
    { visual: "anno-box-11", radar: "seg-13", matched: true, note: "位置一致，但雷达单路质量不合格" },
  ],
  outputs: [
    { riskId: "CUR-Z04-01", label: "疑似受潮区域", priority: "优先复核", rule: "两路在同一测区提示异常且质量合格", basis: "anno-box-07（0.71）与 seg-07（0.71）测区一致、质量合格", nextAction: "先检查周边积水、排水和渗漏来源，再安排复测", quality: "合格" },
    { riskId: "CUR-Z04-02", label: "疑似虫蛀空洞（上部响应区）", priority: "优先复核", rule: "两路在同一测区提示异常且质量合格", basis: "anno-box-03（0.84）与 seg-11（0.84）测区一致、质量合格", nextAction: "安排进一步检测，标注内部异常响应区", quality: "合格" },
    { riskId: "CUR-Z04-03", label: "疑似虫蛀空洞（下部响应区）", priority: "待核对", rule: "任一路质量不合格", basis: "seg-13 有效数据比例 88.4%，低于质量门槛 90%", nextAction: "补充采集后重新融合，暂不输出确定性结论", quality: "不合格" },
  ],
  sourceMode: "simulation",
};

export const FUSION_RULES = [
  { key: "both", label: "规则一：两路在同一测区提示异常且质量合格", result: "优先复核" as const, note: "先检查各自数据质量，再比较对应位置的结果" },
  { key: "one", label: "规则二：仅一路提示异常", result: "补充检测" as const, note: "另一路补充采集后再判定，不做分数相加" },
  { key: "mismatch", label: "规则三：位置不一致或任一路质量不合格", result: "待核对" as const, note: "暂不输出确定性结论，返回待核对" },
];

/* ------------------------------------------------------------------ *
 * 14. 复巡计划（PRD 3.8）
 * ------------------------------------------------------------------ */

export const REVISIT_PLAN: RevisitPlan = {
  id: "RV-2026-1009",
  mapVersion: "MAP-SH-06",
  checkpoints: [
    { componentId: "Z04", bookmark: "BM-Z04-lower", note: "同一测区、同一标高 +0.35m，按相同视角采集比较外观变化" },
    { componentId: "Z04", bookmark: "BM-Z04-side", note: "内侧侧视补拍，核对表面反光条件" },
    { componentId: "Z03", bookmark: "BM-Z03-lower", note: "漆层起翘观察点" },
  ],
  date: "2026-10-09",
  dispatched: false,
  owner: "马 · 具身智能工程师",
};

/* ------------------------------------------------------------------ *
 * 15. 归档清单（PRD 3.8 / 第二章 S23）
 * ------------------------------------------------------------------ */

export const ARCHIVE_ITEMS: ArchiveItem[] = [
  { group: "工单", assetId: "A-01", name: "SH-2026-0901_workorder.json", sizeText: "62 KB", declaredSha256: "a71f0c3d94be2a5817cd6f0b3e94a2c75d81f60b3a9c4e2718b5d30f9a6c4e12", actualSha256: "a71f0c3d94be2a5817cd6f0b3e94a2c75d81f60b3a9c4e2718b5d30f9a6c4e12", present: true, sourceMode: "replay" },
  { group: "工单", assetId: "A-02", name: "WO-2026-0912_draft.json", sizeText: "18 KB", declaredSha256: "5c2e9b70a41d38f6c0b7e29a5d1348f6b07c29e1d4a385f6c0b7e29a5d1348f6", actualSha256: "5c2e9b70a41d38f6c0b7e29a5d1348f6b07c29e1d4a385f6c0b7e29a5d1348f6", present: true, sourceMode: "simulation" },
  { group: "环境", assetId: "A-03", name: "env-2026-0911-01.json", sizeText: "12 KB", declaredSha256: "0d47a1e6c8b9352f7e10a4c6d89b3e524f70a1c6d89b3e524f70a1c6d89b3e52", actualSha256: "0d47a1e6c8b9352f7e10a4c6d89b3e524f70a1c6d89b3e524f70a1c6d89b3e52", present: true, sourceMode: "simulation" },
  { group: "环境", assetId: "A-04", name: "CFG-02_compensation.json", sizeText: "26 KB", declaredSha256: "9b3f7c0e5a281d4f6b9c3e70a5d281f4b6c9e30a5d281f4b6c9e30a5d281f4b6", actualSha256: "9b3f7c0e5a281d4f6b9c3e70a5d281f4b6c9e30a5d281f4b6c9e30a5d281f4b6", present: true, sourceMode: "simulation" },
  { group: "原始数据", assetId: "A-05", name: "scan-Z04-001/radar.csv", sizeText: "12.1 MB", declaredSha256: "2f8a6c1d90b37e45a2c8f61d90b37e45a2c8f61d90b37e45a2c8f61d90b37e45", actualSha256: "2f8a6c1d90b37e45a2c8f61d90b37e45a2c8f61d90b37e45a2c8f61d90b37e45", present: true, sourceMode: "simulation" },
  { group: "原始数据", assetId: "A-06", name: "scan-Z04-002/radar.csv", sizeText: "12.6 MB", declaredSha256: "7e1b4d0a93c62f857b1e4d0a93c62f857b1e4d0a93c62f857b1e4d0a93c62f85", actualSha256: "7e1b4d0a93c62f857b1e4d0a93c62f857b1e4d0a93c62f857b1e4d0a93c62f85", present: true, sourceMode: "simulation" },
  { group: "原始数据", assetId: "A-07", name: "ref-batch-01/scan_002.csv", sizeText: "0 KB", declaredSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", actualSha256: "—", present: false, sourceMode: "simulation" },
  { group: "图像", assetId: "A-08", name: "Z04_lower_frames/*.jpg（14 帧）", sizeText: "41.2 MB", declaredSha256: "c4a7f1e0b936d285c4a7f1e0b936d285c4a7f1e0b936d285c4a7f1e0b936d285", actualSha256: "c4a7f1e0b936d285c4a7f1e0b936d285c4a7f1e0b936d285c4a7f1e0b936d285", present: true, sourceMode: "simulation" },
  { group: "图像", assetId: "A-09", name: "Z04_lower_annotations.json", sizeText: "88 KB", declaredSha256: "1a9d6b04e3c7f2851a9d6b04e3c7f2851a9d6b04e3c7f2851a9d6b04e3c7f285", actualSha256: "6f2c8e13a904b7d56f2c8e13a904b7d56f2c8e13a904b7d56f2c8e13a904b7d5", present: true, sourceMode: "simulation" },
  { group: "地图", assetId: "A-10", name: "MAP-SH-06.pgm", sizeText: "2.6 MB", declaredSha256: "8d4b0f6a1c39e7258d4b0f6a1c39e7258d4b0f6a1c39e7258d4b0f6a1c39e725", actualSha256: "8d4b0f6a1c39e7258d4b0f6a1c39e7258d4b0f6a1c39e7258d4b0f6a1c39e725", present: true, sourceMode: "replay" },
  { group: "地图", assetId: "A-11", name: "MAP-SH-06.yaml", sizeText: "4 KB", declaredSha256: "3c7a1e904b26d8f53c7a1e904b26d8f53c7a1e904b26d8f53c7a1e904b26d8f5", actualSha256: "3c7a1e904b26d8f53c7a1e904b26d8f53c7a1e904b26d8f53c7a1e904b26d8f5", present: true, sourceMode: "replay" },
  { group: "场景", assetId: "A-12", name: "GS-2026.09_manifest.json", sizeText: "184 MB", declaredSha256: "6e2d8c0a471b39f56e2d8c0a471b39f56e2d8c0a471b39f56e2d8c0a471b39f5", actualSha256: "6e2d8c0a471b39f56e2d8c0a471b39f56e2d8c0a471b39f56e2d8c0a471b39f5", present: true, sourceMode: "replay" },
  { group: "场景", assetId: "A-13", name: "GS-2026.05_manifest.json", sizeText: "168 MB", declaredSha256: "b0f5a2c79e14d386b0f5a2c79e14d386b0f5a2c79e14d386b0f5a2c79e14d386", actualSha256: "b0f5a2c79e14d386b0f5a2c79e14d386b0f5a2c79e14d386b0f5a2c79e14d386", present: true, sourceMode: "replay" },
  { group: "数据集", assetId: "A-14", name: "DS-06_frozen_manifest.json", sizeText: "46 KB", declaredSha256: "d1c8b6e0a3f72954d1c8b6e0a3f72954d1c8b6e0a3f72954d1c8b6e0a3f72954", actualSha256: "d1c8b6e0a3f72954d1c8b6e0a3f72954d1c8b6e0a3f72954d1c8b6e0a3f72954", present: true, sourceMode: "simulation" },
  { group: "数据集", assetId: "A-15", name: "DS-06_clean_report.json", sizeText: "72 KB", declaredSha256: "4b6e0a1c8d37f2954b6e0a1c8d37f2954b6e0a1c8d37f2954b6e0a1c8d37f295", actualSha256: "4b6e0a1c8d37f2954b6e0a1c8d37f2954b6e0a1c8d37f2954b6e0a1c8d37f295", present: true, sourceMode: "simulation" },
  { group: "模型记录", assetId: "A-16", name: "EXP-2026-0911/epochs.csv", sizeText: "38 KB", declaredSha256: "7a3c9e1b064d28f57a3c9e1b064d28f57a3c9e1b064d28f57a3c9e1b064d28f5", actualSha256: "7a3c9e1b064d28f57a3c9e1b064d28f57a3c9e1b064d28f57a3c9e1b064d28f5", present: true, sourceMode: "simulation" },
  { group: "模型记录", assetId: "A-17", name: "EXP-2026-0911/predictions_new.csv", sizeText: "14 KB", declaredSha256: "2d8f6b0a4c19e7352d8f6b0a4c19e7352d8f6b0a4c19e7352d8f6b0a4c19e735", actualSha256: "2d8f6b0a4c19e7352d8f6b0a4c19e7352d8f6b0a4c19e7352d8f6b0a4c19e735", present: true, sourceMode: "simulation" },
  { group: "模型记录", assetId: "A-18", name: "model_card_DEMO-M02b.json", sizeText: "9 KB", declaredSha256: "9c1a7e3b0d648f259c1a7e3b0d648f259c1a7e3b0d648f259c1a7e3b0d648f25", actualSha256: "9c1a7e3b0d648f259c1a7e3b0d648f259c1a7e3b0d648f259c1a7e3b0d648f25", present: true, sourceMode: "simulation" },
  { group: "模型记录", assetId: "A-19", name: "quantization_report.json", sizeText: "11 KB", declaredSha256: "5e0b8d2a7c41f3965e0b8d2a7c41f3965e0b8d2a7c41f3965e0b8d2a7c41f396", actualSha256: "5e0b8d2a7c41f3965e0b8d2a7c41f3965e0b8d2a7c41f3965e0b8d2a7c41f396", present: true, sourceMode: "simulation" },
  { group: "更新日志", assetId: "A-20", name: "DEMO-PKG-02.demo.zip", sizeText: "3.2 MB", declaredSha256: "3f9c1d2a7b45e8c0a1d6f3b29c7e5408a2b6d19f4c8e3a70d5b2f61c9e0a4d78", actualSha256: "3f9c1d2a7b45e8c0a1d6f3b29c7e5408a2b6d19f4c8e3a70d5b2f61c9e0a4d78", present: true, sourceMode: "simulation" },
  { group: "更新日志", assetId: "A-21", name: "device_update_log.txt", sizeText: "24 KB", declaredSha256: "8a2f5c9e0b37d1468a2f5c9e0b37d1468a2f5c9e0b37d1468a2f5c9e0b37d146", actualSha256: "b71e4a8d0c39f526b71e4a8d0c39f526b71e4a8d0c39f526b71e4a8d0c39f526", present: true, sourceMode: "simulation" },
  { group: "报告", assetId: "A-22", name: "SH-2026-0901_inspection_report.html", sizeText: "1.8 MB", declaredSha256: "c0d9b7e1a4f38625c0d9b7e1a4f38625c0d9b7e1a4f38625c0d9b7e1a4f38625", actualSha256: "c0d9b7e1a4f38625c0d9b7e1a4f38625c0d9b7e1a4f38625c0d9b7e1a4f38625", present: true, sourceMode: "replay" },
  { group: "报告", assetId: "A-23", name: "MAY-DEMO-01_report.pdf", sizeText: "4.8 MB", declaredSha256: "1f7a3c9e0b26d4851f7a3c9e0b26d4851f7a3c9e0b26d4851f7a3c9e0b26d485", actualSha256: "1f7a3c9e0b26d4851f7a3c9e0b26d4851f7a3c9e0b26d4851f7a3c9e0b26d485", present: true, sourceMode: "replay" },
  { group: "报告", assetId: "A-24", name: "fusion_record_FUSION-03.json", sizeText: "42 KB", declaredSha256: "6b0d8f2a5c19e7346b0d8f2a5c19e7346b0d8f2a5c19e7346b0d8f2a5c19e734", actualSha256: "6b0d8f2a5c19e7346b0d8f2a5c19e7346b0d8f2a5c19e7346b0d8f2a5c19e734", present: true, sourceMode: "simulation" },
];

/* ------------------------------------------------------------------ *
 * 16. 知识库资料（PRD 5）
 * ------------------------------------------------------------------ */

export const KNOWLEDGE_DOCS: KnowledgeDoc[] = [
  {
    docId: "doc-may-report", title: "示例寺五月巡检报告", category: "巡检报告", project: "示例寺", date: "2026-05-18", version: "v1.2", digest: "sha256:1f7a3c9e…26d485", source: "MAY-DEMO-01_report.pdf",
    chunks: [
      { chunkId: "c-01", section: "第 2 节 · 巡检概况", text: "本次巡检覆盖大雄宝殿四柱 Z01 至 Z04，采用全景影像采集与表面巡检，共记录 6 处风险，编号 R01 至 R06。其中 Z04 柱脚渗水痕迹列为 R04，建议在雨季前后分别复测。" },
      { chunkId: "c-02", section: "第 4 节 · 风险清单", text: "R01 Z01 柱脚漆层剥落；R02 Z02 表面污渍；R03 Z03 地仗修补痕迹；R04 Z04 柱脚渗水痕迹；R05 东次间排水沟淤积；R06 台基西侧苔藓覆盖。所有风险均给出责任部门建议与复巡日期。" },
      { chunkId: "c-03", section: "第 6 节 · 处理进展", text: "截至报告编制日，R01 至 R04 已有施工完成反馈，其中 R01 至 R03 已通过人工验收并关闭，R04 处于待验收状态；R05 与 R06 仍为待处理，需分配责任部门后确认处理时间。" },
      { chunkId: "c-04", section: "附录 · 场景索引", text: "本报告关联历史场景 scene-May，书签包括 BM-Z01-base、BM-Z04-base 与 BM-drain-east。打开书签可回到当时采集视角，用于纵向外观比较。" },
    ],
  },
  {
    docId: "doc-weather", title: "示例寺近三个月归档天气档案", category: "天气档案", project: "示例寺", date: "2026-09-10", version: "v1.0", digest: "sha256:44b0c7a1…9e30d2", source: "weather_archive_2026Q3.csv（归档，非实时联网）",
    chunks: [
      { chunkId: "w-01", section: "降水与湿度", text: "2026 年 6 月 11 日至 9 月 10 日，梅雨期累计降水 412mm，8 月出现 3 次连续降雨过程；期间平均相对湿度 78%，最高单日 94%，日温差最大 11.4℃。数据来自归档天气档案，非实时联网查询。" },
      { chunkId: "w-02", section: "对木构的影响提示", text: "持续高湿条件下，木构件表层与内部含水状态可能不同步；环境记录用于判断采集条件，并为参数补偿提供输入。归档数据只能作为环境先验，不能替代现场实测。" },
    ],
  },
  {
    docId: "doc-method-hh", title: "环境补偿与 HH 平衡含水率方法说明", category: "方法文档", project: "平台方法", date: "2026-08-30", version: "v1.4", digest: "sha256:7c3a91e5…18b6f0", source: "method_env_compensation.md",
    chunks: [
      { chunkId: "m-01", section: "HH 模型的定位", text: "Hailwood-Horrobin 模型用于估计木材与环境充分平衡时的平衡含水率（EMC）。它描述的是平衡态，现场木柱未必已经平衡，因此估计值只能作为环境先验，不能直接当成木柱内部的实测含水率。" },
      { chunkId: "m-02", section: "输入与边界", text: "模型输入为温度与相对湿度；相对湿度必须满足 0 ≤ relative_humidity_pct ≤ 100。风速不代入 HH 公式，风速仅作为采集稳定性与环境记录项。" },
      { chunkId: "m-03", section: "补偿与适配的分工", text: "环境补偿解决日常工况变化，调整补偿系数与信号归一化参数；模型适配处理新的材料特征。两层分开，检测人员才能判断本次需要重新校准，还是需要补充样本。" },
    ],
  },
  {
    docId: "doc-archive-index", title: "示例寺构件档案与场景索引", category: "构件档案", project: "示例寺", date: "2026-09-01", version: "v2.0", digest: "sha256:0d47a1e6…3e52c8", source: "components_SY.json",
    chunks: [
      { chunkId: "a-01", section: "四柱档案", text: "Z01、Z02 为杉木檐柱，直径约 320mm；Z03、Z04 为楠木金柱，直径约 356mm 与 360mm。Z04 柱脚有历史修补痕迹，本轮采集前缺少该批次木材的有效标定记录。" },
      { chunkId: "a-02", section: "场景与书签", text: "历史场景 scene-May 对应五月批次，本轮场景 scene-SH-0901 对应 GS-2026.09。四柱下部各有正视书签，Z04 另设内侧侧视书签 BM-Z04-side。" },
    ],
  },
  {
    docId: "doc-repair-feedback", title: "维修反馈与验收说明（历史）", category: "维修反馈", project: "示例寺", date: "2026-07-22", version: "v1.1", digest: "sha256:9b3f7c0e…81f4b6", source: "feedback_2026Q2.md",
    chunks: [
      { chunkId: "f-01", section: "反馈记录", text: "R01 至 R04 的施工单位反馈材料已提交，R01 至 R03 验收通过并关闭。R04 的完工资料只进入待验收，人工验收通过后才关闭；上传材料不等于处理完成。" },
      { chunkId: "f-02", section: "两段式流程", text: "施工反馈与验收使用两个独立操作。首版不建立外部施工登录端，由授权演示账号录入反馈与验收案例。" },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 17. 小木工具与意图（PRD 4.2）
 * ------------------------------------------------------------------ */

export type XiaomuIntent = {
  intentId: string;
  utterance: string;
  tools: string[];
  answerTemplate: string;
  /** 需要拼接的实时业务状态键 */
  facts: string[];
  voice: string;
};

export const XIAOMU_INTENTS: XiaomuIntent[] = [
  {
    intentId: "history_summary", utterance: "查今年五月示例寺巡检",
    tools: ["检索报告", "查询风险状态"],
    answerTemplate: "共 {total} 处风险，施工反馈完成 {reportedDone} 处，验收关闭 {closed} 处，尚未关闭 {open} 处。",
    facts: ["total", "reportedDone", "closed", "open"], voice: "AI语音1",
  },
  {
    intentId: "open_history_scene", utterance: "打开当时的高斯场景",
    tools: ["检索报告", "打开场景"],
    answerTemplate: "已定位历史场景 {sceneId} 与书签 {bookmark}；场景不存在时仅说明预览不可用，保留文字结果。",
    facts: ["sceneId", "bookmark"], voice: "AI语音2",
  },
  {
    intentId: "compare_columns", utterance: "比较四根木柱",
    tools: ["读取图像", "视觉分析", "结果汇总"],
    answerTemplate: "当前 Z04 视角可见较明显的表面缺损和孔洞状疑点，建议优先复核 Z04 下部测区。图像可以提示外观异常，不能确认内部是否存在空洞。",
    facts: ["componentId", "imageIds"], voice: "AI语音3",
  },
  {
    intentId: "anomaly_summary", utterance: "汇总异常并生成任务",
    tools: ["读取异常记录", "建立补采检查清单"],
    answerTemplate: "建议核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，并验证候选模型。",
    facts: ["anomalyId", "nextActions"], voice: "AI语音4",
  },
  {
    intentId: "clean_dataset", utterance: "启动清洗并列出待审核",
    tools: ["执行清洗 job", "返回审核清单"],
    answerTemplate: "清洗完成，待审核记录已列出，数据集已按物理样本分组。",
    facts: ["cleanSteps", "reviewCount"], voice: "AI语音5",
  },
  {
    intentId: "compare_models", utterance: "对比新旧模型",
    tools: ["读取同一测试集预测", "计算指标"],
    answerTemplate: "验证对照已打开。该归档版本通过离线验证，可以进入设备部署检查。",
    facts: ["metrics", "acceptance"], voice: "AI语音6",
  },
  {
    intentId: "run_fusion", utterance: "分析本批次并融合结果",
    tools: ["启动预置分析任务", "生成 fusion_record"],
    answerTemplate: "分析完成，图像标注与雷达结果已关联到 Z04 测区，融合视图已生成。",
    facts: ["fusionRecordId", "outputs"], voice: "AI语音7",
  },
  {
    intentId: "draft_workorder", utterance: "生成复核工单",
    tools: ["按模板建草稿"],
    answerTemplate: "工单草稿已生成。Z04 下部已列为重点复核项，检测图像和雷达分析已附上，处理建议待专业审核。",
    facts: ["orderId", "priority", "attachments"], voice: "AI语音8",
  },
  {
    intentId: "unresolved_followup", utterance: "还有几个没处理完",
    tools: ["查未关闭项及下一步"],
    answerTemplate: "尚未关闭 {open} 处：{items}",
    facts: ["open", "items"], voice: "AI语音9",
  },
  {
    intentId: "deployment_check", utterance: "检查是否可以部署",
    tools: ["查审核与兼容条件"],
    answerTemplate: "审核 {reviewState}；兼容性检查 {compatPass} 项通过、{compatBlock} 项阻断。",
    facts: ["reviewState", "compatPass", "compatBlock"], voice: "AI语音10",
  },
];

/** 小木工具卡片（PRD 4.1：内容是实际调用状态） */
export const XIAOMU_TOOLS = [
  { key: "search", label: "查询资料", detail: "本地 TF-IDF 索引 idx-12", state: "就绪" },
  { key: "order", label: "读取工单状态", detail: "SH-2026-0901 · 处理中", state: "就绪" },
  { key: "scene", label: "打开场景", detail: "scene-SH-0901 · 已授权", state: "就绪" },
  { key: "robot", label: "读取巡检任务", detail: "MSN-2026-0911-02 · 执行中", state: "就绪" },
  { key: "train", label: "训练演示任务", detail: "EXP-2026-0911 · 模拟标志", state: "模拟" },
  { key: "fusion", label: "启动融合分析", detail: "FUSION-03 · 规则融合", state: "就绪" },
];

/* ------------------------------------------------------------------ *
 * 18. 总览待办与事件
 * ------------------------------------------------------------------ */

export const TODO_ITEMS = [
  { id: "T-01", text: "Z04 下部重点复核项待专业审核方案", owner: "沈", due: "2026-09-13", state: "待处理", level: "high" as const },
  { id: "T-02", text: "复巡计划 RV-2026-1009 尚未下发", owner: "马", due: "2026-10-09", state: "待处理", level: "mid" as const },
  { id: "T-03", text: "R04 柱脚渗水痕迹待人工验收", owner: "沈", due: "2026-09-15", state: "待验收", level: "mid" as const },
  { id: "T-04", text: "现场新增样本训练任务继续跟踪", owner: "史", due: "2026-09-12", state: "处理中", level: "low" as const },
];

export const RECENT_EVENTS = [
  { at: "14:22", text: "巡检任务执行中，当前目标 P4（Z03 观察点）", tone: "cyan" as const },
  { at: "14:19", text: "视频通道延迟 9 秒，仅影响该通道", tone: "amber" as const },
  { at: "39:44", text: "复扫批次 scan-Z04-002 回传三处样例异常", tone: "red" as const },
  { at: "38:52", text: "设备重启自检通过，demo_reported_version = DEMO-M02b", tone: "ok" as const },
  { at: "36:47", text: "新旧模型评估对比完成，验收规则 5 项通过", tone: "ok" as const },
  { at: "34:12", text: "数据集 DS-06 冻结，训练只引用冻结版本", tone: "cyan" as const },
  { at: "28:04", text: "适用域待核验：scan-Z04-001 诊断输出已冻结", tone: "red" as const },
];

/* ------------------------------------------------------------------ *
 * 19. 知识库检索的轻量打分（纯前端演示，标注为检索相似度）
 * ------------------------------------------------------------------ */

export const KNOWLEDGE_META = {
  indexVersion: "idx-12",
  retriever: "本地 TF-IDF（中文字符 2–4 元）· 余弦相似度",
  topK: 5,
  noHitThreshold: 0.15,
  chunkSize: "300–500 汉字，重叠约 60 字，保存原段落序号",
  note: "相似度标为「检索相似度」，不能标为病害置信度；查询向量为空或无命中时回答「当前资料未检索到」。",
};
