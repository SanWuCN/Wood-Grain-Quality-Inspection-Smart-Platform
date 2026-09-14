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
  BootCheckItem,
  CleanStep,
  ChannelStatus,
  ClockPhase,
  Component,
  ConfigDiffRow,
  CurrentRisk,
  Curve,
  DataPackage,
  DataPackageKind,
  DeliveryArtifact,
  Dataset,
  DemoEvent,
  DeviceLogEntry,
  DeviceReading,
  EnvRecord,
  Experiment,
  ForbiddenZone,
  GridMap,
  HistoryRisk,
  HotspotEvidence,
  JobLogLine,
  KnowledgeDoc,
  LogEntry,
  MapVersion,
  Member,
  Mission,
  NodeMetric,
  Order,
  PoseSample,
  RevisitPlan,
  Sample,
  ScanBatch,
  SceneAsset,
  SourceMode,
  StageDef,
  TrainingConfigField,
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
  { key: "source-switch", label: "切换数据来源：智能巡检车 / 算力服务器", detail: "只能在任务停止后进行（PRD 3.2）", effect: "通道来源改为「智能巡检车 · replay」或「算力服务器 · live」", tone: "amber" },
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
  { key: "map", label: "地图", state: "online", updatedAt: "14:22:31", ageSec: 2, source: "智能巡检车 · replay" },
  { key: "pose", label: "位姿", state: "online", updatedAt: "14:22:33", ageSec: 1, source: "智能巡检车 · replay" },
  { key: "video", label: "视频", state: "stale", updatedAt: "14:22:24", ageSec: 9, source: "MJPEG 同源转发" },
  /* key 仍是 vehicle（通道协议与权限口径不改），对外标签改为「算力」：
     这一路现在承载的是算力服务器的心跳，不是车端运动通道 */
  { key: "vehicle", label: "算力", state: "online", updatedAt: "14:22:32", ageSec: 2, source: "算力服务器 · 平台本体" },
];

/**
 * 设备档案。
 *
 * 三台设备的对外名称是这一份，页面一律引用 `DEVICES.*.name`，不再各写一遍：
 *   · `scanner`   毫米波扫描仪（手持采集设备）
 *   · `demoCart`  智能巡检车（回放建图与巡检轨迹）
 *   · `realCart`  算力服务器（平台本体的算力资源，只读监看）
 *
 * `realCart` 的 id 与 `live` 模式保持不变：它是「实机通道」的既有约定，
 * 换的只是对外名称与它在总览页承载的语义（从一台车变成平台算力）。
 * 算力服务器的**实时读数**（存储 / 内存 / GPU / 功耗 / 网络）不在这里写死，
 * 由 `/api/system/metrics` 采集运行后端那台机器的真实占用，见 platformData。
 */
export const DEVICES = {
  demoCart: { id: "cart-demo-01", name: "智能巡检车", mode: "replay" as SourceMode },
  realCart: { id: "cart-real-01", name: "算力服务器", mode: "live" as SourceMode },
  scanner: { id: "scan-dev-02", name: "毫米波扫描仪", mode: "simulation" as SourceMode },
};

/**
 * 扫描枪读数（硬件详情 · 硬件监看）
 *
 * 前三项带 `preflight`：知识库 SOP 要求「每次采集前核对设备电量、存储余量与
 * 时间同步状态，三项任一不满足即不开始采集」，所以它们各自带阈值，由页面
 * 按阈值判态 —— 采集条件的结论不在种子里写死，改了读数结论跟着变。
 *
 * 后两项只监看不判定（没有阈值就不出结论）。
 * 与其余设备数据一样属于 `source_mode = simulation` 的模拟读数，
 * 界面统一挂「模拟采集」来源标识（PRD 1.2）。
 */
export const SCANNER_TELEMETRY: DeviceReading[] = [
  { key: "battery", label: "电池电量", value: 68, unit: "%", min: 40, scale: 100, preflight: true, drift: 0.4, driftPeriod: 17 },
  { key: "storage", label: "存储余量", value: 12.4, unit: "GB", digits: 1, min: 2, scale: 32, preflight: true, drift: 0.06, driftPeriod: 23 },
  { key: "clock", label: "时钟偏差", value: 0.18, unit: "s", digits: 2, max: 1, preflight: true, note: "对工单时间基准", drift: 0.04, driftPeriod: 7 },
  { key: "temp", label: "机身温度", value: 41.6, unit: "℃", digits: 1, max: 55, drift: 0.5, driftPeriod: 11 },
  { key: "rssi", label: "无线信号", value: -58, unit: "dBm", min: -75, drift: 2.2, driftPeriod: 5 },
];

/**
 * 终端能上报的全部读数字段（**静态清单**，值不参与显示）
 *
 * 为什么单独列一份而不是等设备上报：硬件监看页要求「连接前与连接后的行数、
 * 排版完全一致」。字段清单如果来自上报本身，未连接时就只剩种子里的五行、
 * 连上之后变成十五行，布局会跳一次。
 *
 * 这份清单就是那张表的**行模板**：未连接时所有行显示「—」，
 * 连接后设备报什么就填什么（多出来的字段追加在后面）。
 * `value` 只作为字段类型与单位的占位，界面不会拿它当读数显示。
 */
export const SCANNER_READING_LAYOUT: DeviceReading[] = [
  { key: "battery", label: "电池电量", value: 0, unit: "%", digits: 0, min: 40, scale: 100 },
  { key: "storage", label: "存储余量", value: 0, unit: "GB", digits: 1, min: 2, scale: 32 },
  { key: "clock", label: "时钟偏差", value: 0, unit: "s", digits: 2, max: 1 },
  { key: "temp", label: "机身温度", value: 0, unit: "℃", digits: 1, max: 55 },
  { key: "rssi", label: "无线信号", value: 0, unit: "dBm", min: -75 },
  { key: "cpu", label: "CPU 利用率", value: 0, unit: "%", digits: 0 },
  { key: "memory", label: "内存占用", value: 0, unit: "%", digits: 0 },
  { key: "disk", label: "数据目录占用", value: 0, unit: "%", digits: 0 },
  { key: "cpuFreq", label: "CPU 频率", value: 0, unit: "MHz", digits: 0 },
  { key: "voltage", label: "5V 轨电压", value: 0, unit: "V", digits: 2, min: 4.75, max: 5.25 },
  { key: "power", label: "整机功耗", value: 0, unit: "W", digits: 1 },
  { key: "gpu", label: "GPU 利用率", value: 0, unit: "%", digits: 0 },
  { key: "netTx", label: "接口发送", value: 0, unit: "B/s", digits: 0 },
  { key: "netRx", label: "接口接收", value: 0, unit: "B/s", digits: 0 },
  { key: "throttle", label: "降频 / 欠压", value: 0, unit: "", digits: 0 },
];

/**
 * 采集设备画面（屏幕推流）。
 *
 * 与 `RvizView` 的 `RvizStreamConfig` 同一套口径：演示阶段给静态参考画面，
 * 接实机时把 `image` 留空、填 `url` + `kind`，界面**不用改**就能切到真实推流。
 * 现在 `url` 是 null —— 明确表达「未接入」，不拿静态图冒充实时画面
 * （PRD 3.4：暂停页面状态不等于实际传感器停止；同理，静态图不等于推流）。
 */
export const CAPTURE_SCREEN_STREAM: {
  image?: string;
  url: string | null;
  kind: "mjpeg" | "webrtc";
  source: string;
  note: string;
} = {
  image: "/rviz-reference.png",
  url: null,
  kind: "mjpeg",
  source: "毫米波扫描仪 · 上位机屏幕",
  note: "采集端上位机屏幕推流；未接入时显示最近一帧静态画面，不标作实时。",
};

/** 读数采样时间：与 CHANNELS 的更新时间同属一次会话快照 */
export const SCANNER_TELEMETRY_AT = "14:22:33";

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
  {
    id: "SX-2026-0813",
    title: "应县木塔二层斗栱变形跟踪",
    site: "应县木塔",
    district: "山西省朔州市应县",
    location: "塔身二层西南侧斗栱区",
    scope: "斗栱变形观测与塔身倾斜复核，不含落架维修",
    componentIds: ["Z02"],
    status: "处理中",
    current: false,
    createdAt: "2026-08-13 09:15",
    discoveredAt: "2026-07-18 09:10",
    owner: "马 · 具身智能工程师",
    level: "中风险",
    sourceRiskIds: [],
    attachments: [],
    acceptanceNote: "变形观测按季度跟踪，本轮记录已归档，等待下一轮观测对比。",
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

/**
 * HH 平衡含水率只作环境先验（PRD 3.1）。
 *
 * **这里不写数值**：EMC 由服务端在发布配置时按 Hailwood-Horrobin 算好、
 * 落在 `environment` 实体的 `emcPct` 上，页面读实体。原来这里写死
 * `estimatedEmcPct: 14.2`，而按现场工况（26.4℃ / 78%）真算出来是 15.081 ——
 * 页面上一旦两个数都出现就是对不上的。种子只留文案与口径声明。
 */
export const HH_PRIOR = {
  model: "Hailwood-Horrobin",
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
    id: "scene-SH-0901-raw", title: "示例寺四柱 · 本轮原始导入", round: "本轮",
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

/**
 * 孪生场景内的巡航线（**示意**）。
 *
 * ⚠️ 与 `MISSION.plannedPath` 不是同一套坐标：那条是地图栅格坐标（10 cm/格），
 * 这条是孪生场景坐标（四柱立于 ±2.2，院子 ±3.7）。PRD 3.3 明确
 * 「未完成坐标标定时以柱号与人工热点对应，不让车辆直接追踪三维点击位置」，
 * 所以这条线是按航点编号人工对应的示意路线，**不是标定后的真实轨迹** ——
 * 界面上必须标出来，不能让它看起来像实测路径。
 *
 * 观察位取在柱位朝院内偏移 0.8 处：车站在柱子与院子中间看得见柱身，
 * 不会贴着柱子走。
 */
export const TWIN_ROUTE: { id: string; x: number; z: number; label: string }[] = [
  { id: "P1", x: 0, z: 3.3, label: "殿门起点" },
  { id: "P2", x: -1.4, z: 2.2, label: "Z01 观察位" },
  { id: "P3", x: 1.4, z: 2.2, label: "Z02 观察位" },
  { id: "P4", x: -1.4, z: -2.2, label: "Z03 观察位" },
  { id: "P5", x: 1.4, z: -2.2, label: "Z04 观察位" },
  { id: "P6", x: 3.2, z: 0.2, label: "东侧回廊" },
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
/**
 * 异常事件。
 *
 * 列表一行一条，点开看详情（设备证据 / 模型证据 / 处置过程）。
 * 证据分两类的依据是剧本 S12 沈的原话：「设备是否正常有设备证据，
 * 模型是否适用有模型证据。请分别核对，不能把低分直接解释为木柱出了严重病害」——
 * 混成一堆会让人以为换个账号或重跑一次就能解决。
 *
 * 首版异常由演示控制事件触发，关联预置证据；真实模式只有实际检查结果或
 * 检测程序输出才能触发（PRD 3.4）。
 */
/**
 * 异常事件。
 *
 * ⚠️ 这里的 `ANOMALY_EVENTS` 与下面的 `DEVICE_LOGS` **已不再被页面使用**。
 *
 * 异常排查页（pages/TriageLog.tsx）现在读 `seed/deviceLogs.ts`：
 * 异常事件从 4 条扩到 16 条（多数已结案），设备日志从 16 条平铺改成
 * 「一次启动一个日志包」（每包两三百条）。本文件里这两份保留下来是因为：
 *   · `DEVICE_LOGS` 的 16 条是**手工写的原始记录**，deviceLogs.ts 里当日
 *     日志包的锚点直接沿用了它们的措辞与时间戳（27:52 / 27:53 / 27:54 /
 *     27:56 / 28:01 / …），删掉就失去了「这句话当初为什么这么写」的出处；
 *   · `ANOMALY_EVENTS` 的前四条同样被 deviceLogs.ts 原样承接。
 * 改名加 `_LEGACY` 后缀，避免下一个人误以为改这里能改到页面。
 */
export const ANOMALY_EVENTS_LEGACY: AnomalyEvent[] = [
  {
    id: "evt-domain-01",
    at: "2026-09-11 28:04",
    kind: "适用域待核验",
    summary: "Z04 初扫批次触发模型适用性检查，诊断输出已冻结",
    detail:
      "输入质量合格、特征偏移超限、模型配置不覆盖该材种，三项合并后触发。该批次暂不输出病害结论。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: true,
    trigger: "演示控制事件",
    deviceEvidence: [
      { at: "28:12", text: "供电电压 12.4V，传感器响应正常", result: "正常" },
      { at: "28:40", text: "参考件回波与出厂基线一致（偏差 0.3dB）", result: "正常" },
      { at: "29:05", text: "USB 传输无丢包，落盘 386/420 帧", result: "部分接收" },
    ],
    modelEvidence: [
      { at: "30:02", text: "输入质量：信号完整度 91.9%", result: "合格" },
      { at: "30:20", text: "特征偏移：与参考分布偏离 2.7σ", result: "超限" },
      { at: "30:38", text: "模型配置：DEMO-M02 缺少该批次木材标定记录", result: "不适用" },
    ],
    handling: [
      { at: "28:04", owner: "史", text: "发现适用域事件，要求暂停当前采集并保留原始数据" },
      { at: "28:20", owner: "饶", text: "停止采集，封存批次 scan-Z04-001，记录设备位置" },
      { at: "29:30", owner: "马", text: "确认小车已到安全点暂停，核对 Z04 编号与扫描方向" },
      { at: "30:50", owner: "饶", text: "参考件复核与设备日志检查完成，未发现足以解释异常的明显设备问题" },
    ],
    conclusion: null,
    state: "处理中",
    owner: "史",
  },
  {
    id: "evt-recv-01",
    at: "2026-09-11 28:41",
    kind: "接收不完整",
    summary: "scan-Z04-001 雷达原始数据 386/420，34 帧未回传",
    detail:
      "整批校验未通过，不报「数据全部回传」。缺帧集中在批次后段，与暂停时间点吻合。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: false,
    trigger: "演示控制事件",
    deviceEvidence: [
      { at: "28:41", text: "雷达 386/420、图像 12/12、结果 0/1", result: "部分接收" },
      { at: "28:44", text: "缺帧区间与 28:20 暂停时刻重叠", result: "记录" },
    ],
    modelEvidence: [],
    handling: [
      { at: "28:45", owner: "饶", text: "已向扫描枪请求重传未接收分片，等待设备回报" },
    ],
    conclusion: null,
    state: "处理中",
    owner: "饶",
  },
  {
    id: "evt-signal-01",
    at: "2026-09-11 28:52",
    kind: "信号质量",
    summary: "有效数据比例 91.9%，低于整批校验阈值",
    detail: "信号可用但有效比例偏低。整批校验未通过前不进入后续分析；需补采后再判定。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: false,
    trigger: "演示控制事件",
    deviceEvidence: [
      { at: "28:18", text: "空帧 0，非有限值 0，饱和帧比例 2.1%", result: "合格" },
      { at: "28:52", text: "有效数据比例 91.9%", result: "待复核" },
    ],
    modelEvidence: [],
    handling: [
      { at: "28:55", owner: "饶", text: "标记该批次待补采，保持当前配置不变" },
    ],
    conclusion: "信号可用但有效比例偏低，需补采后再判定",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-img-01",
    at: "2026-09-11 22:06",
    kind: "表面疑点",
    summary: "四柱关键帧对比，Z04 视角可见表面缺损与孔洞状疑点",
    detail:
      "图像可提示外观异常，不能确认内部是否存在空洞，也不能直接判定承载能力。已建立 Z04 下部精扫任务。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "演示控制事件",
    deviceEvidence: [
      { at: "22:06", text: "关键帧 keyframe-Z04-03 与 Z01-02 对比", result: "记录" },
    ],
    modelEvidence: [
      { at: "22:08", text: "视觉初筛：表面缺损与孔洞状疑点", result: "优先复核" },
    ],
    handling: [
      { at: "22:10", owner: "史", text: "在平台标注建立 Z04 下部精扫任务" },
      { at: "22:15", owner: "沈", text: "核对现场编号，指定对 Z04 测区开展手持精扫" },
    ],
    conclusion: "已转入 Z04 下部测区精扫，内部情况待精扫确认",
    state: "已结案",
    owner: "史",
  },
];

/**
 * 硬件日志输出记录。
 *
 * 来源分五类：下位机（ESP32-S3，管采集时序与模型输入）、上位机（树莓派，
 * 管数据汇集 / 界面 / 文件）、毫米波模块、传输链路、供电 —— 剧本 S09 里
 * 饶讲的分工，出问题时先按 source 分层再看时间，比按时间翻一条流水账快。
 *
 * 前四条沿用原「四项检查」里已经写好的记录（供电、参考件、落盘、信号），
 * 那几条本来就是设备日志的口径，放在检查单里反而埋没了。
 */
export const DEVICE_LOGS_LEGACY: DeviceLogEntry[] = [
  { id: "log-001", at: "27:52", level: "INFO", source: "供电", text: "上电自检完成，电池电量 68%，供电电压 12.4V" },
  { id: "log-002", at: "27:53", level: "INFO", source: "ESP32-S3", text: "固件 FW-2.4.1 启动，采集配置 CFG-02 已加载" },
  { id: "log-003", at: "27:54", level: "INFO", source: "树莓派", text: "上位机服务就绪，存储余量 12.4 GB，时间同步偏差 0.18s" },
  { id: "log-004", at: "27:56", level: "INFO", source: "毫米波模块", text: "模块自检通过，频段与增益按 CFG-02 下发" },
  { id: "log-005", at: "28:01", level: "INFO", source: "毫米波模块", text: "参考件回波与出厂基线一致（偏差 0.3dB）" },
  { id: "log-006", at: "28:04", level: "WARN", source: "树莓派", text: "适用域检查未通过：模型 DEMO-M02 缺少该批次木材标定记录" },
  { id: "log-007", at: "28:04", level: "WARN", source: "树莓派", text: "特征偏移 2.7σ 超限，诊断输出已冻结，暂停输出结论" },
  { id: "log-008", at: "28:18", level: "INFO", source: "毫米波模块", text: "信号质量：空帧 0，非有限值 0，饱和帧比例 2.1%" },
  { id: "log-009", at: "28:20", level: "WARN", source: "ESP32-S3", text: "收到暂停请求，停止采集控制；等待上位机确认落盘" },
  { id: "log-010", at: "28:41", level: "WARN", source: "传输", text: "批次 scan-Z04-001 雷达原始数据 386/420 帧，34 帧未回传" },
  { id: "log-011", at: "28:44", level: "WARN", source: "传输", text: "缺帧区间与 28:20 暂停时刻重叠，判定为暂停导致而非链路丢包" },
  { id: "log-012", at: "28:52", level: "WARN", source: "树莓派", text: "有效数据比例 91.9%，低于整批校验阈值 95%" },
  { id: "log-013", at: "29:05", level: "INFO", source: "传输", text: "USB 传输无丢包，落盘 386/420 帧" },
  { id: "log-014", at: "29:30", level: "INFO", source: "树莓派", text: "批次 scan-Z04-001 已封存，原始数据保留，未做清理" },
  { id: "log-015", at: "31:12", level: "INFO", source: "ESP32-S3", text: "切换到参考样本采集模式，等待新批次下发" },
  { id: "log-016", at: "31:20", level: "ERROR", source: "传输", text: "参考样本批次 ref-Z04-g1 第 3 条重传失败一次，已自动重试成功" },
];

/**
 * 设备启动检查。
 *
 * 采集启动前的硬门槛：硬件工程师点「启动采集」后逐条确认并签署，
 * 全部签完才真正进入采集。前三项来自知识库 SOP
 * 「每次采集前核对设备电量、存储余量与时间同步状态，三项任一不满足即不开始采集」，
 * 后三项补传感器响应、通道连通与测区方向。
 *
 * `expected` 必须写清楚「对着什么看」，否则检查单只剩一个「通过」按钮，
 * 签了等于没签。
 */
export const BOOT_CHECKS: BootCheckItem[] = [
  {
    id: "chk-power", group: "设备", label: "供电与电量", owner: "饶",
    expected: "电池电量 ≥ 40%，供电电压 12.0–13.0V",
    onFail: "电量不足会中途掉电，本批次作废",
  },
  {
    id: "chk-storage", group: "设备", label: "存储余量", owner: "饶",
    expected: "可用空间 ≥ 2 GB，落盘目录可写",
    onFail: "空间不足会截断原始数据，无法复算",
  },
  {
    id: "chk-clock", group: "设备", label: "时间同步", owner: "饶",
    expected: "对工单时间基准偏差 ≤ 1s",
    onFail: "时间戳错位，环境记录与雷达数据无法按时间对齐",
  },
  {
    id: "chk-sensor", group: "设备", label: "传感器响应", owner: "饶",
    expected: "参考件回波与出厂基线偏差 ≤ 1.0dB",
    onFail: "响应异常时后续结论不可信，须先排查模块",
  },
  {
    id: "chk-link", group: "链路", label: "通道连通", owner: "饶",
    expected: "地图 / 位姿 / 视频 / 车辆四路均在线",
    onFail: "任一通道断开都会造成测区对应关系缺失",
  },
  {
    id: "chk-zone", group: "测区", label: "测区与扫描方向", owner: "马",
    expected: "柱号、参考标高与扫描方向与任务一致",
    onFail: "测区错位会把数据挂到错误的构件编号下",
  },
];

/* ------------------------------------------------------------------ *
 * 10. 数据集与样本（PRD 3.5 / 11.1）
 * ------------------------------------------------------------------ */

/** 参考样本批次：同一块样本的连续扫描属于同一 group，不能拆散到不同集合 */
/**
 * 数据包清单（训练验证页 · 采集数据）
 *
 * 分两类摆在一起，因为训练要用的是这两类：
 *   原始雷达数据 —— ADC / IQ / spectrum，传感器直接输出的，模型换了还能重跑比对；
 *   成果数据     —— 表面图像 / 结果文件，已经过端侧处理，不能用来复算算法变化。
 * 混在一起会让人以为「有数据就能重训」，而只有原始级别的那几种才行。
 *
 * 校验项按 PRD 11.1 的顺序：格式字段 → 重复摘要 → 分组交叉 → 时间戳与配置版本。
 * `state` 只有经过审核才从「待审核」转「已入库」；被驳回的留在列表里，
 * 不删 —— 排查时要知道是哪些包没过、为什么没过。
 */
export const DATA_PACKAGES: DataPackage[] = [
  {
    id: "pkg-Z04-001-raw", name: "scan-Z04-001_radar_spectrum.zip", kind: "原始雷达数据",
    rawLevel: "spectrum", source: "毫米波扫描仪", batchId: "scan-Z04-001", componentId: "Z04",
    frames: 386, sizeText: "412 MB", capturedAt: "2026-09-11 27:36", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "420 点频谱 / 每帧含时间戳与测区编号" },
      { key: "dup", label: "重复摘要", pass: true, detail: "无重复帧段" },
      { key: "group", label: "分组交叉", pass: true, detail: "归属 G-SAMPLE-04，未跨集合" },
      { key: "stamp", label: "时间戳与配置版本", pass: false, detail: "缺 34 帧（暂停导致），配置版本 CFG-02 记录一致" },
    ],
  },
  {
    id: "pkg-Z04-001-img", name: "scan-Z04-001_images.zip", kind: "表面图像",
    rawLevel: "opaque", source: "毫米波扫描仪", batchId: "scan-Z04-001", componentId: "Z04",
    frames: 12, sizeText: "38.4 MB", capturedAt: "2026-09-11 27:52", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "JPEG 12 帧，含张号与拍摄方向" },
      { key: "dup", label: "重复摘要", pass: true, detail: "无重复图像" },
    ],
  },
  {
    id: "pkg-Z04-002-raw", name: "scan-Z04-002_radar_spectrum.zip", kind: "原始雷达数据",
    rawLevel: "spectrum", source: "毫米波扫描仪", batchId: "scan-Z04-002", componentId: "Z04",
    frames: 420, sizeText: "448 MB", capturedAt: "2026-09-11 39:26", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "420 点频谱，帧号连续" },
      { key: "dup", label: "重复摘要", pass: true, detail: "与初扫无重叠帧段" },
      { key: "group", label: "分组交叉", pass: true, detail: "归属 G-SAMPLE-04" },
      { key: "stamp", label: "时间戳与配置版本", pass: true, detail: "与工单时间基准偏差 0.18s" },
    ],
  },
  {
    id: "pkg-ref-g1", name: "ref-Z04-g1_radar_adc.zip", kind: "原始雷达数据",
    rawLevel: "ADC", source: "毫米波扫描仪", batchId: "ref-batch-01", componentId: "REF",
    frames: 168, sizeText: "196 MB", capturedAt: "2026-09-11 31:22", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "ADC 原始采样，含距离与方向标注" },
      { key: "dup", label: "重复摘要", pass: false, detail: "r-0003 与 r-0002 摘要高度相似，疑似重复" },
      { key: "group", label: "分组交叉", pass: true, detail: "G-SAMPLE-01 三帧同组" },
    ],
  },
  {
    id: "pkg-ref-g3", name: "ref-Z04-g3_radar_adc.zip", kind: "原始雷达数据",
    rawLevel: "ADC", source: "毫米波扫描仪", batchId: "ref-batch-01", componentId: "REF",
    frames: 96, sizeText: "112 MB", capturedAt: "2026-09-11 32:05", state: "待审核",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "ADC 原始采样" },
      { key: "sat", label: "饱和比例", pass: false, detail: "r-0007 饱和比例 11.8%，超出阈值 5%" },
      { key: "label", label: "标签依据", pass: false, detail: "来源卡缺失，标记为未知待核验" },
    ],
  },
  {
    id: "pkg-may", name: "legacy_may-round1.zip", kind: "混合包",
    rawLevel: "result_only", source: "历史归档 · 五月批次", batchId: "may-round1", componentId: null,
    frames: 3, sizeText: "8.2 MB", capturedAt: "2026-05-18 17:40", state: "已驳回",
    checks: [
      { key: "schema", label: "格式与字段", pass: false, detail: "Z01_scan.csv 列数不一致，无法解析" },
      { key: "raw", label: "原始级别", pass: false, detail: "仅存结果分数，无原始回波，不能用于复算" },
    ],
  },
  {
    id: "pkg-Z01-may", name: "may-round1_Z02_scan.csv", kind: "原始雷达数据",
    rawLevel: "features", source: "历史归档 · 五月批次", batchId: "may-round1", componentId: "Z02",
    frames: 1, sizeText: "0.6 MB", capturedAt: "2026-05-18 17:44", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "特征级数据，字段完整" },
      { key: "raw", label: "原始级别", pass: false, detail: "features 级，可用于对照但不可复算原始回波" },
    ],
  },
  {
    id: "pkg-Z04-result", name: "scan-Z04-002_result.json", kind: "结果文件",
    rawLevel: "result_only", source: "扫描枪推理进程", batchId: "scan-Z04-002", componentId: "Z04",
    frames: 3, sizeText: "24 KB", capturedAt: "2026-09-11 39:41", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "含模型版本、阈值与逐段判定" },
      { key: "ver", label: "模型版本可追溯", pass: true, detail: "DEMO-M02b / PIPE-A" },
    ],
  },
  {
    id: "pkg-cart-map", name: "MAP-SH-06_slam.tar", kind: "混合包",
    rawLevel: "opaque", source: "智能巡检车", batchId: null, componentId: null,
    frames: 1, sizeText: "86 MB", capturedAt: "2026-09-11 22:40", state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "栅格地图 + 位姿轨迹" },
    ],
  },
  {
    id: "pkg-ref-g2", name: "ref-Z04-g2_radar_adc.zip", kind: "原始雷达数据",
    rawLevel: "ADC", source: "毫米波扫描仪", batchId: "ref-batch-01", componentId: "REF",
    frames: 84, sizeText: "98 MB", capturedAt: "2026-09-11 31:48", state: "待审核",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "ADC 原始采样" },
      { key: "file", label: "文件完整性", pass: false, detail: "scan_001.csv 为 0 字节空文件" },
    ],
  },
];

/** 演示素材包：导入弹窗里可以直接选这些，不需要真的传文件 */
export const IMPORTABLE_PACKAGES: {
  id: string;
  name: string;
  kind: DataPackageKind;
  rawLevel: DataPackage["rawLevel"];
  sizeText: string;
  detail: string;
}[] = [
  { id: "imp-01", name: "ref-Z04-g4_radar_adc.zip", kind: "原始雷达数据", rawLevel: "ADC", sizeText: "134 MB", detail: "楠木参考样本第 4 组，来源卡齐全" },
  { id: "imp-02", name: "scan-Z05-001_radar_spectrum.zip", kind: "原始雷达数据", rawLevel: "spectrum", sizeText: "396 MB", detail: "檐柱 Z05 初扫，新构件编号" },
  { id: "imp-03", name: "site-survey-images.zip", kind: "表面图像", rawLevel: "opaque", sizeText: "212 MB", detail: "现场补充拍摄的表面图像 48 帧" },
  { id: "imp-04", name: "external_lab_samples.zip", kind: "混合包", rawLevel: "result_only", sizeText: "18 MB", detail: "外单位提供，仅结果分数，无原始回波" },
];

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
  // 30 = 本轮实际跑过的轮数（maxEpochs=40，早停在第 30 轮触发）。
  // 曲线长度必须等于实际轮数，界面上「跟着回放画到第几轮」才有意义。
  for (let e = 1; e <= 30; e += 1) {
    const y = floor + (base - floor) * Math.exp(-decay * e) + 0.004 * Math.sin(e * 0.9);
    points.push({ x: e, y: Number(y.toFixed(4)) });
  }
  return { id, label, color, points };
}

/**
 * 验证损失曲线。
 *
 * `overfitFrom` 之后验证损失开始反向抬升 —— 剧本 S16 让架构师口播的
 * 「训练误差下降、验证误差却持续上升」就是这一段。成功案例给 null（不发散）。
 * 用同一个衰减核加上一段可控的抬升，保证两套案例的曲线形状同源、可比。
 */
function valCurve(
  base: number,
  floor: number,
  decay: number,
  id: string,
  label: string,
  color: string,
  overfitFrom: number | null = null,
): Curve {
  const points: { x: number; y: number }[] = [];
  for (let e = 1; e <= 30; e += 1) {
    let y = floor + 0.03 + (base - floor) * Math.exp(-decay * 0.72 * e) + 0.008 * Math.sin(e * 1.3);
    if (overfitFrom !== null && e > overfitFrom) {
      // 抬升斜率固定，且不叠正弦 —— 发散段要干净可读，不然像噪声
      y += 0.011 * (e - overfitFrom);
    }
    points.push({ x: e, y: Number(Math.max(0.02, y).toFixed(4)) });
  }
  return { id, label, color, points };
}

/**
 * 执行节点占用序列。
 *
 * 按 epoch 采样，与控制台日志、损失曲线共用同一个 epoch 轴 —— PRD 11.2
 * 要求「不同页面必须来自同一实验ID，禁止各用随机数」，所以这里同样是
 * 确定性生成（同一个 seed 恒定），不是每次渲染随机。
 * 形状上刻意让 `warm` 段先低后高再回落，读起来像一轮真实训练，
 * 而不是一条直线加抖动。
 */
function nodeSeries(seed: number, start: number, peak: number, end: number, jitter: number): number[] {
  const out: number[] = [];
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let e = 1; e <= 30; e += 1) {
    // 三段时间线：前 15% 爬升（显卡还没跑满）→ 中段平台 → 尾段缓降（早停临近、批次变小）
    const t = (e - 1) / 29;
    const shape =
      t < 0.15
        ? start + (peak - start) * (t / 0.15)
        : t < 0.8
          ? peak
          : peak + (end - peak) * ((t - 0.8) / 0.2);
    // 兜底夹到 0：抖动不能把「占用」算成负数（实测出现过 CPU -1%、内存 -0.2 GB）
    const value = Math.max(0, shape + (rand() - 0.5) * jitter);
    out.push(Number(value.toFixed(2)));
  }
  return out;
}

/**
 * 训练配置（剧本 S15：训练配置会记录数据版本、学习率、更新范围和停止条件）。
 *
 * 这几项就是「调整模型参数」能改的东西。小样本适配的关键是**控制需要更新的
 * 参数数量**（剧本 S15 原话），所以「可训练参数占比」与「解冻层」是只读的 ——
 * 它们由模型结构决定，不是操作员能随手填的数字。
 */
const TRAINING_CONFIG: TrainingConfigField[] = [
  { key: "baseline", label: "基线版本", value: 0, readonly: true, note: "本轮对照基线" },
  { key: "dataset", label: "数据集版本", value: 0, readonly: true, note: "DS-06 已冻结" },
  { key: "scope", label: "可训练参数", value: 8.4, unit: "%", digits: 1, readonly: true, note: "最后 2 个卷积块 + 分类头；主干冻结" },
  { key: "lr", label: "学习率", value: 0.0005, digits: 4, min: 0.00001, max: 0.01, step: 0.0001, note: "本轮小样本微调取值" },
  { key: "batch", label: "批大小", value: 16, min: 4, max: 128, step: 4, note: "上限受设备侧单批内存限制" },
  { key: "epochs", label: "最大轮数", value: 40, min: 12, max: 120, step: 4, note: "上限 120" },
  { key: "patience", label: "早停耐心", value: 6, min: 2, max: 20, step: 1, note: "验证损失连续多少轮不下降即停止，当前 6" },
  { key: "threshold", label: "判定阈值", value: 0.5, digits: 2, min: 0.05, max: 0.95, step: 0.05, note: "新旧版本共用同一阈值" },
  { key: "seed", label: "随机种子", value: 20260911, readonly: true, note: "固定种子" },
];

/**
 * 任务控制台日志（PRD 11.2：任务逐步读取实验包，形成可点击的真实记录）。
 *
 * 时间戳与 `EXPERIMENT.jobSteps` 的 at 同一口径（mm:ss），五段分别对应
 * 排队 / 数据准备 / 适配 / 验证 / 完成。内容写实际操作与判据，
 * 不写「正在努力训练中」这类没有信息量的进度话术。
 */
const JOB_LOG: JobLogLine[] = [
  { at: "34:20", level: "INFO", step: "queue", text: "job EXP-2026-0911 已入队，等待执行节点" },
  { at: "34:22", level: "INFO", step: "queue", text: "调度到 node-train-02（GPU 1 张，可用显存 24 GB）" },
  { at: "34:24", level: "INFO", step: "queue", text: "载入实验包：config.json / epochs.csv / predictions_*.csv / model_card.json" },
  { at: "34:26", level: "INFO", step: "queue", text: "artifact_kind=demo_nonflashable · 归档演示任务，与现场任务分开记录" },

  { at: "34:34", level: "INFO", step: "prepare", text: "数据集 DS-06 校验通过：12 条记录 / 6 个物理样本组" },
  { at: "34:36", level: "INFO", step: "prepare", text: "排除不可用 3 条（空文件 1、列数不一致 2），保留 9 条" },
  { at: "34:38", level: "WARN", step: "prepare", text: "r-0003 与 r-0002 摘要高度相似，标记疑似重复，转入待审核" },
  { at: "34:41", level: "WARN", step: "prepare", text: "r-0007 饱和比例 11.8% 超限，转入待审核，不进入监督训练" },
  { at: "34:44", level: "INFO", step: "prepare", text: "未知标签 2 条单列待核验集合，不作为已知病害标签使用" },
  { at: "34:47", level: "INFO", step: "prepare", text: "按 physical_sample_id 分组：训练 4 组 / 验证 1 组 / 测试 1 组" },
  { at: "34:49", level: "INFO", step: "prepare", text: "分组交集检查：train∩val=∅ train∩test=∅ val∩test=∅" },
  { at: "34:52", level: "INFO", step: "prepare", text: "增强仅作用于训练集；同一原始样本的衍生记录保留同一 group_id" },

  { at: "35:58", level: "INFO", step: "adapt", epoch: 0, text: "加载基线 DEMO-M02，冻结主干，解冻最后 2 个卷积块 + 分类头" },
  { at: "35:59", level: "INFO", step: "adapt", epoch: 0, text: "可训练参数 8.4%（小样本适配，不重训整套网络）" },
  { at: "36:00", level: "INFO", step: "adapt", epoch: 0, text: "optimizer=AdamW lr=5e-4 batch=16 seed=20260911（固定种子）" },
  { at: "36:02", level: "INFO", step: "adapt", epoch: 1, text: "epoch 01/30 train_loss=1.1732 val_loss=0.7204" },
  { at: "36:06", level: "INFO", step: "adapt", epoch: 4, text: "epoch 04/30 train_loss=0.6218 val_loss=0.4306" },
  { at: "36:11", level: "INFO", step: "adapt", epoch: 8, text: "epoch 08/30 train_loss=0.3541 val_loss=0.2887" },
  { at: "36:17", level: "INFO", step: "adapt", epoch: 12, text: "epoch 12/30 train_loss=0.2540 val_loss=0.2319" },
  { at: "36:23", level: "INFO", step: "adapt", epoch: 16, text: "epoch 16/30 train_loss=0.2147 val_loss=0.2188" },
  { at: "36:29", level: "INFO", step: "adapt", epoch: 20, text: "epoch 20/30 train_loss=0.1983 val_loss=0.2151" },
  { at: "36:35", level: "INFO", step: "adapt", epoch: 24, text: "epoch 24/30 train_loss=0.1912 val_loss=0.2144" },
  { at: "36:38", level: "WARN", step: "adapt", epoch: 30, text: "验证损失连续 6 轮未下降，第 30 轮触发早停（耐心 6）" },
  { at: "36:41", level: "INFO", step: "adapt", epoch: 24, text: "取第 24 轮权重作为候选版本 DEMO-M03-candidate；第 25–30 轮权重丢弃" },

  { at: "36:44", level: "INFO", step: "validate", epoch: 30, text: "固定测试清单、预处理 comp-v1.4 与判定阈值 0.50" },
  { at: "36:47", level: "INFO", step: "validate", epoch: 30, text: "同一测试集 12 条，新旧版本各跑一次" },
  { at: "36:52", level: "INFO", step: "validate", epoch: 30, text: "漏检 3 → 2，误报 4 → 2；原有材种杉木分组召回 0.92 → 0.94" },
  { at: "36:56", level: "INFO", step: "validate", epoch: 30, text: "验收规则 6 项全部通过，无回归退化" },
  { at: "36:58", level: "INFO", step: "validate", epoch: 30, text: "INT8 量化：缩放系数按代表性数据确定，复测集 24 条" },
  { at: "37:02", level: "WARN", step: "validate", epoch: 30, text: "复测 2 条边界样本量化后判定翻转，回退 float 分支，不计入量化收益" },

  { at: "37:08", level: "INFO", step: "done", epoch: 30, text: "封装 DEMO-PKG-02.demo.zip（模型 3.2 MB + 预处理配置 + 版本信息）" },
  { at: "37:10", level: "INFO", step: "done", epoch: 30, text: "SHA-256 3f9c1d2a7b45… · 恢复版本 DEMO-M02 备份完整" },
  { at: "37:12", level: "INFO", step: "done", epoch: 30, text: "任务结束：产物已装载。训练状态不代表现场模型已更新" },
];

/**
 * 失败案例的日志：前四段与成功案例完全一致（同一份数据、同一套流程），
 * 只在验收段分叉 —— 这样对照看的时候，能看出差别出在「验证不通过」，
 * 而不是出在流程本身。
 */
const FAILED_JOB_LOG: JobLogLine[] = [
  ...JOB_LOG.filter((line) => line.step !== "done"),
  { at: "36:56", level: "ERROR", step: "validate", epoch: 30, text: "必要指标条件未通过：漏检率 0.333 高于基线 0.250" },
  { at: "36:58", level: "ERROR", step: "validate", epoch: 30, text: "原有材种回归退化：杉木分组召回 0.92 → 0.78，超出容差 0.02" },
  { at: "37:02", level: "ERROR", step: "done", epoch: 30, text: "验收未通过，候选版本阻止进入封装与发布" },
];

/** 执行节点占用：与损失曲线共用同一个 epoch 轴 */
const NODE_METRICS: NodeMetric[] = [
  { key: "gpu", label: "GPU 利用率", unit: "%", digits: 0, series: nodeSeries(7, 46, 97, 88, 4), scale: 100, warnAbove: 95 },
  { key: "gpumem", label: "显存占用", unit: "GB", digits: 1, series: nodeSeries(13, 6.2, 15.4, 14.1, 0.35), scale: 24, warnAbove: 21 },
  { key: "gputemp", label: "GPU 温度", unit: "℃", digits: 0, series: nodeSeries(23, 48, 74, 71, 1.6), scale: 100, warnAbove: 83 },
  { key: "fan", label: "风扇转速", unit: "%", digits: 0, series: nodeSeries(29, 38, 82, 78, 2.4), scale: 100 },
  { key: "cpu", label: "CPU 利用率", unit: "%", digits: 0, series: nodeSeries(31, 22, 68, 54, 5.5), scale: 100, warnAbove: 92 },
  { key: "ram", label: "内存占用", unit: "GB", digits: 1, series: nodeSeries(37, 9.4, 26.8, 24.2, 0.7), scale: 64, warnAbove: 58 },
];

/** 执行节点档案：这几项在真实监看里和占用曲线一样常驻 */
export const TRAIN_NODE = {
  host: "node-train-02",
  accelerator: "GPU 1 × 24 GB",
  cpu: "16 vCPU",
  ram: "64 GB",
  driver: "535.161.07 · CUDA 12.2",
  runtime: "torch 2.3.1 · python 3.11",
  queue: "本节点队列 1 个任务（当前）",
};

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
  curveOld: lossCurve(1.24, 0.36, 0.09, "old", "DEMO-M02 基线验证损失", "#789EFF"),
  curveNew: lossCurve(1.18, 0.19, 0.13, "new", "DEMO-M02b 新版损失", "#8fc2ff"),
  curveTrain: lossCurve(1.18, 0.185, 0.135, "train", "候选 · 训练损失", "#4ea8ff"),
  // 成功案例：验证损失贴着训练损失收敛，不发散（对照 S16 的过拟合判据）
  curveVal: valCurve(1.22, 0.2, 0.135, "val", "候选 · 验证损失", "#5fd4c4"),
  predictionsOld: predictions("old"),
  predictionsNew: predictions("new"),
  config: TRAINING_CONFIG,
  log: JOB_LOG,
  node: NODE_METRICS,
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
  // 失败案例的判据就在曲线上：第 18 轮后验证损失反向抬升、训练损失继续下降
  // —— 典型的过拟合，剧本 S16 讲的正是这一现象。界面据此阻止进入发布。
  curveVal: valCurve(1.22, 0.2, 0.135, "val", "候选 · 验证损失", "#5fd4c4", 18),
  log: FAILED_JOB_LOG,
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

/**
 * 交付产物（更新交付页）。
 *
 * 这一页回答的是「训好的东西怎么交到别人手上」：
 *   · 待提交 —— 训练产出的模型 / 固件 / OTA 包，还没上平台；
 *   · 已发布 —— 已上传到平台，其他工程师可以下载、烧录，`used` 是取用记录。
 *
 * 三类目标按用户点名的分：硬件侧端模型（烧进手持设备）、平台模型（平台侧推理）、
 * 小车 OTA（推给演示车）。三类不能混在一张表里比大小 —— 它们的校验项、
 * 目标载体、回退方式都不一样。
 */
export const DELIVERY_ARTIFACTS: DeliveryArtifact[] = [
  {
    id: "art-int8-engine", name: "best_int8.engine", target: "硬件侧端模型",
    modelVersion: "EF-Nano-v1.2 + RadarNet-Lite-v1.0", fromJob: "蒸馏与量化（distill_int8_quant.py）",
    producedAt: "2026-09-11 21:41", sizeText: "3.12 MB", sha256: "b7e4a0913cf8", state: "待提交",
    checks: [
      { key: "input", label: "输入规格", pass: true, detail: "1×420 频谱向量，与采集配置 CFG-02 一致" },
      { key: "op", label: "算子支持", pass: true, detail: "conv2d / bn / relu / gap / fc 均在端侧支持列表" },
      { key: "mem", label: "内存容量", pass: true, detail: "模型区占用 3.12 MB ≤ 可用 6 MB" },
      { key: "digest", label: "摘要复核", pass: true, detail: "与训练侧导出的摘要一致" },
      { key: "calib", label: "标定覆盖", pass: true, detail: "覆盖本批次使用的杉木与楠木参考样本" },
    ],
  },
  {
    id: "art-m03-candidate", name: "demo_m03_candidate.pt", target: "平台模型",
    modelVersion: "DEMO-M03-candidate", fromJob: "本轮适配（EXP-2026-0911）",
    producedAt: "2026-09-11 21:36", sizeText: "3.21 MB", sha256: "e2f71b4c9a08", state: "待提交",
    checks: [
      { key: "preprocess", label: "预处理版本", pass: true, detail: "comp-v1.4，与训练完全一致" },
      { key: "contract", label: "接口契约", pass: true, detail: "输入输出定义未变，调用方无需改动" },
      { key: "metric", label: "验收指标", pass: true, detail: "漏检 3→2，误报 4→2，原有材种无退化" },
      { key: "domain", label: "适用域", pass: false, detail: "该批次木材缺有效标定记录，结论仍待核验" },
    ],
  },
  {
    id: "art-cart-rc2", name: "DEMO-CART-1.7.0-rc2.tar", target: "小车 OTA",
    modelVersion: "DEMO-CART-1.7.0-rc2", fromJob: null,
    producedAt: "2026-09-10 18:02", sizeText: "18.4 MB", sha256: "7a3d15e8b062", state: "待提交",
    checks: [
      { key: "map", label: "地图版本兼容", pass: true, detail: "适配 MAP-SH-06" },
      { key: "fallback", label: "回退包可用", pass: true, detail: "DEMO-CART-1.6.0 备份完整" },
      { key: "field", label: "整机验证", pass: false, detail: "仅在智能巡检车上跑过，算力服务器未接运动通道" },
    ],
  },
  {
    id: "art-fw-mumai", name: "fw_mumai_v3.6.0.bin", target: "硬件侧端模型",
    modelVersion: "EFCW-YOLO v3.6 + RadarNet v2.4", fromJob: "蒸馏与量化（distill_int8_quant.py）",
    producedAt: "2026-09-11 21:40", sizeText: "4.08 MB", sha256: "3f9c1d2a7b45", state: "已发布",
    checks: [
      { key: "input", label: "输入规格", pass: true, detail: "与采集配置 CFG-02 一致" },
      { key: "sign", label: "签名", pass: true, detail: "SHA256-HMAC 校验通过" },
      { key: "fallback", label: "回退版本", pass: true, detail: "FW-2.4.1 备份完整，可恢复" },
    ],
  },
  {
    id: "art-demo-pkg", name: "DEMO-PKG-02.demo.zip", target: "硬件侧端模型",
    modelVersion: "DEMO-M02b（候选）", fromJob: "本轮适配（EXP-2026-0911）",
    producedAt: "2026-09-11 21:37", sizeText: "3.2 MB", sha256: "a17e5b93c204", state: "已发布",
    checks: [
      { key: "kind", label: "包类型", pass: true, detail: "artifact_kind=demo_nonflashable，不可烧录" },
      { key: "compat", label: "兼容性", pass: true, detail: "4 项通过，烧录能力项按演示包标记为不适用" },
    ],
  },
  {
    id: "art-agent-rc1", name: "AGENT-1.3.0-rc1.tar.gz", target: "平台模型",
    modelVersion: "AGENT-1.3.0-rc1", fromJob: null,
    producedAt: "2026-09-08 15:30", sizeText: "1.1 MB", sha256: "6f14d0b83a25", state: "已发布",
    checks: [
      { key: "tools", label: "工具白名单", pass: true, detail: "与 1.3 白名单一致" },
      { key: "rollback", label: "回滚点", pass: true, detail: "多步编排任一步失败可退到该步之前" },
    ],
  },
  {
    id: "art-map-sh06", name: "MAP-SH-06_slam.tar", target: "小车 OTA",
    modelVersion: "MAP-SH-06", fromJob: null,
    producedAt: "2026-09-11 22:40", sizeText: "86 MB", sha256: "c42b809f1de7", state: "已发布",
    checks: [
      { key: "quality", label: "建图质量", pass: true, detail: "回环成功，重定位耗时 3s" },
      { key: "zone", label: "禁区一致", pass: true, detail: "3 处禁入区已随地图下发" },
    ],
  },
];

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
    { key: "c1", label: "目标设备型号", pass: true, detail: "毫米波扫描仪（scan-dev-02）" },
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

/** 小木工具卡片（PRD 4.1：内容是实际调用状态） */
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

/* ------------------------------------------------------------------ *
 * 20. 知识库入库流水线（PRD 5.3）—— 只供 /knowledge 使用，追加不改上文
 * ------------------------------------------------------------------ */

/**
 * 分块与向量参数的单一来源：页面上所有参数、分块数、向量数都由它算出来，
 * 不允许在组件里另写一套数字。
 */
export const KNOWLEDGE_PIPELINE = {
  /** 分块目标长度（汉字） */
  chunkMaxChars: 420,
  /** 分块下限：短于此长度的段落不再单独成块 */
  chunkMinChars: 300,
  /** 相邻分块重叠字数（PRD 5.2.3：每段 300–500 字、重叠约 60 字） */
  chunkOverlapChars: 60,
  /**
   * 检索向量空间维度：中文字符 2–4 元稀疏 TF-IDF。
   * 这个数字是「候选词表容量上限」，实际非零维由语料决定。
   */
  retrievalSpaceDims: 262144,
  /**
   * 入库向量维度：演示固定 768 维。
   * 本项目不接后端、不下载任何嵌入模型，这 768 个数由
   * TF-IDF 权重经确定性哈希投影得到（见 knowledge/logic.ts buildEmbedding）。
   */
  embeddingDims: 768,
  /** 演示用的「向量库」起始版本 */
  baseIndexVersion: "KB-11",
  /** 上传队列每一步的演示耗时（毫秒，进度条按它推进） */
  stageMs: { parse: 900, chunk: 700, embed: 1100 },
} as const;

/**
 * 「选择本地目录导入」用的种子语料：整批导入时用的就是这些真实全文，
 * 字符数由 String.length 真算，分块数由分块器真算。
 */
export const KNOWLEDGE_FILE_SEEDS: {
  fileId: string;
  title: string;
  category: KnowledgeDoc["category"];
  path: string;
  version: string;
  /** 文件内容：段首 "## " 为章节标题，其余按句群切段 */
  content: string;
  /** 文本类文件按真实内容 counted；这份种子就是真内容 */
  sourceMode: "live" | "replay";
}[] = [
  {
    fileId: "f-recheck",
    title: "示例寺 Z04 柱汛后复检记录",
    category: "巡检报告",
    path: "D:/巡检资料/2026Q3/Z04_recheck_20260912.md",
    version: "v1.0",
    sourceMode: "live",
    content: `## 复检范围与方法
2026 年 9 月 12 日对示例寺大雄宝殿 Z04 柱下部一米范围做汛后复检，沿用五月批次的正视与内侧侧视两个视角。复检只做表面巡检与雷达复扫，不对构件做任何接触式取样。外观结论按「可见缺损、疑似孔洞、表面污渍」三类记录，内部结论以雷达回波为准。

## 渗水痕迹变化
与五月批次对比，Z04 柱脚渗水痕迹范围由约 180mm 扩大到约 260mm，边缘出现轻微起翘，但尚未见木纤维外露。柱脚周边地仗完整，无新增裂缝。该变化属于外观量测结果，不能据此判断内部是否存在空洞或腐朽。

## 雷达复扫结果
本柱下部一米范围布置三条测线，回波在距表面约四十毫米处出现一处弱异常反射，幅值低于五月同位置读数。弱异常可能来自含水率差异、修补层界面或真实缺陷，需要与视觉结果在同一测区比对后再定级，本轮不下确定性结论。

## 结论与下一步
建议在十月复巡时对同一测区重复采集，并在环境记录中补充当日温湿度与降雨情况。若两次复扫异常位置一致且幅值继续上升，再申请补充检测。当前所有结论只用于安排复巡，不作为结构安全判定依据。`,
  },
  {
    fileId: "f-drone",
    title: "巡检机器人航线与采集规范",
    category: "方法文档",
    path: "D:/巡检资料/规范/robot_route_standard.md",
    version: "v2.1",
    sourceMode: "live",
    content: `## 航线规划原则
航线以构件为单位编排，一根构件至少覆盖正视与侧视两个视角，柱脚一米范围必须单独设观察点。相邻观察点的重叠率不低于百分之三十，避免出现没有影像覆盖的盲区。航线高度按构件实际尺寸调整，不套用固定模板。

## 采集前检查
每次采集前核对设备电量、存储余量与时间同步状态，三项任一不满足即不开始采集。时间戳必须与工单时间基准一致，否则后续按时间对齐环境记录与雷达数据时会错位。

## 采集中的约束
同一构件在同一轮次内的采集参数应保持一致；确需调整时，在记录中写明调整原因与调整前后的参数值。光照不足时优先补光而不是提高增益，提高增益会把噪声一起放大，影响后续表面巡检的判断。

## 交付与归档
采集完成后按构件编号整理影像与原始数据，生成批次记录并归档。归档清单只说明文件是否齐全、是否发生变化，不替代内容审核。缺少原始数据的批次不得进入诊断流程。`,
  },
  {
    fileId: "f-rain",
    title: "雨季前后木构件外观复查要点",
    category: "方法文档",
    path: "D:/巡检资料/规范/rainy_season_review.md",
    version: "v1.3",
    sourceMode: "replay",
    content: `## 为什么要分雨季前后两次
木构件在持续高湿条件下的表层与内部含水状态可能不同步。雨季前采集的读数更接近长期平衡状态，雨季后的读数反映短期吸湿结果。两次数据都比较，才能判断变化是季节性波动还是持续发展趋势。

## 复查顺序
先看排水，再看台基，最后看柱脚。排水沟淤积会把水引向台基，台基积水会沿柱脚向上渗透。排水与台基的问题不解决，柱脚的处理只能暂时缓解表面现象。

## 记录要求
每次复查记录当日天气、降雨间隔天数与构件表面状态，并保留同一视角的照片。照片只用于外观比较，不能代替实测。同一位置出现颜色变深、起翘或霉斑时，先排除光照与镜头污渍，再作为变化记录。

## 与其他资料的关系
本要点与巡检报告、构件档案配合使用。外观变化需要结合构件档案中的树种与历史修补记录一起看，单看照片容易把修补痕迹误判成新增缺陷。`,
  },
  {
    fileId: "f-accept",
    title: "维修反馈与验收操作手册",
    category: "维修反馈",
    path: "D:/巡检资料/流程/maintenance_acceptance_manual.md",
    version: "v2.0",
    sourceMode: "replay",
    content: `## 两段式流程
施工反馈与验收使用两个独立操作。施工单位提交反馈材料后，风险状态变为待验收；只有授权人员完成人工验收，风险才能关闭。上传材料不等于处理完成，这两件事在系统里必须分开记录。

## 反馈材料要求
反馈材料应包含施工范围、处理工艺、使用材料与完成日期，并附处理后同视角照片。缺少完成日期或照片的反馈退回补充，不进入待验收状态。

## 验收判定
验收按结构安全与外观要求分别判断。结构安全不满足的，无论外观是否达标都不能关闭；结构安全满足但外观仍可见缺陷的，可以关闭并备注后续观察要求。

## 权限与留痕
反馈与验收均记录操作人、时间与依据。首版不建立外部施工登录端，由授权演示账号录入反馈与验收案例，操作留痕用于演示追溯链路。`,
  },
  {
    fileId: "f-quarantine",
    title: "资料导入与解析说明",
    category: "场景索引",
    path: "D:/巡检资料/流程/ingest_parse_note.md",
    version: "v1.0",
    sourceMode: "replay",
    content: `## 支持的文件类型
文本类文件（Markdown、TXT、CSV）按段落实读字符数；PDF 与图片类文件只读取文件名、大小与类型，字符数按经验比值估算，不做真实解析；压缩包只登记清单，不解压。所有估算值在页面上必须标注为估算。

## 分块规则
文本按空行与句群切段后合并成块，目标长度四百二十字上下，相邻块保留约六十字重叠，并保存原段落序号，便于从检索结果回到原文位置。段落短于三百字时不单独成块，会与前一段合并。

## 重复与变更识别
导入时对文件内容计算摘要，摘要相同的文件标为未变更、不重复入库；摘要变化的文件标为已变更，只重新处理该文件。整批重跑时先清空索引再全量重建，历史版本仍然保留可回滚。

## 演示边界
本页不连接后端、不调用嵌入模型。上传只在浏览器内读取文件，解析、分块、向量化与写索引均为前端演示流程，页面上的每一个数字都由种子数据或真实计算得到。`,
  },
];
