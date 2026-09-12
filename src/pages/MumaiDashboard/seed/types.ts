/**
 * 木脉智检 · 演示种子数据类型（PRD 16 素材种子）
 *
 * 所有页面共用这里的类型与 scenario.ts 的同一份数据，禁止在页面源码里
 * 单独硬编码日期、风险数、版本号。
 *
 * 取值口径：
 *   - source_mode: live 实采 / replay 回放 / simulation 模拟（PRD 1.2）
 *   - 未检测一律用 null 表达「未采集」，不要用 0 冒充「无风险」
 */

/** PRD 1.2：每条记录必须标注来源模式 */
export type SourceMode = "live" | "replay" | "simulation";

/** 任务总览阶段，对齐 PRD 7.1 全程阶段表 */
export type StageKey =
  | "history"
  | "prepare"
  | "mapping"
  | "reconstruction"
  | "screening"
  | "scanning"
  | "exception"
  | "dataset"
  | "adaptation"
  | "deployment"
  | "rescan"
  | "fusion"
  | "delivery";

export type StageDef = {
  key: StageKey;
  label: string;
  /** 剧本定位（第二章 S01–S23） */
  script: string;
  /** 剧本时间节点 mm:ss */
  clock: string;
  detail: string;
};

/** 设备四路通道状态（PRD 3.2：地图 / 位姿 / 视频 / 车辆各自更新时间） */
export type ChannelKey = "map" | "pose" | "video" | "vehicle";
export type ChannelState = "online" | "stale" | "offline";

export type ChannelStatus = {
  key: ChannelKey;
  label: string;
  state: ChannelState;
  /** 上一次更新时间，界面直接显示 */
  updatedAt: string;
  /** 距今秒数，用于「3 秒前」这类表达 */
  ageSec: number;
  /** 数据来源标识，例如「演示车 · replay」 */
  source: string;
};

/**
 * 手持设备单条读数（硬件监看用）。
 *
 * `min` / `max` 是判定阈值，缺省表示该项只监看不判定；
 * `scale` 是画进度条的量程（如电量 100、存储 32GB），缺省不画条。
 * 判定一律由页面按阈值现算，种子只给读数与阈值，不给结论。
 */
export type DeviceReading = {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** 显示小数位，避免同一列里 68 与 68.0 混排 */
  digits?: number;
  /** 采集前必须核对项（SOP：电量 / 存储余量 / 时间同步），任一不满足即不开始采集 */
  preflight?: boolean;
  min?: number;
  max?: number;
  scale?: number;
  /** 读数来自哪一份记录，便于追溯 */
  note?: string;
  /**
   * 实时监看时的浮动幅度（与 value 同单位）。
   *
   * 手持设备在采集中读数本来就会小幅摆动，一条钉死的数字反而假。
   * 界面按这个幅度做确定性摆动（围绕 value，不产生超出幅度的漂移），
   * 幅度缺省表示该项不摆动 —— 版本号、采样时间这类不该抖。
   */
  drift?: number;
  /** 摆动周期（秒），不同项给不同周期，避免所有数字同频一起跳 */
  driftPeriod?: number;
};

/** 环境记录（PRD 3.1 / 12：温度℃、湿度 0–100、风速非负、仪表、位置、测量时间） */
export type EnvRecord = {
  recordId: string;
  airTempC: number;
  relativeHumidityPct: number;
  windSpeedMs: number;
  instrumentId: string;
  /** 仪表量程由配置给定 */
  instrumentRange: { min: number; max: number; unit: string };
  position: string;
  measuredAt: string;
  operator: string;
  /** 校验状态机：待校验 → 已提交 → 设备已确认 */
  submitState: "待校验" | "已提交" | "设备已确认";
  configVersion: string | null;
  sourceMode: SourceMode;
};

export type ConfigDiffRow = {
  field: string;
  before: string;
  after: string;
  note: string;
};

export type Member = {
  id: string;
  name: string;
  role: string;
  duty: string;
  workspace: string;
};

export type Attachment = {
  assetId: string;
  name: string;
  kind: "报告" | "图像" | "原始数据" | "地图" | "场景" | "数据集" | "模型" | "日志" | "清单";
  sizeText: string;
  from: string;
  sourceMode: SourceMode;
};

/** Z01–Z04 构件档案（PRD 3.1 / 3.3） */
export type Component = {
  id: string;
  name: string;
  part: string;
  zoneId: string;
  /** 三维场景坐标（scene 坐标，非地图坐标） */
  scene: { x: number; z: number };
  /** 雷达响应状态；未检测必须为 null */
  radarScore: number | null;
  visibleNote: string;
  archive: string;
  defaultBookmark: string;
};

/** 本轮风险 CUR-Z04-01~03（PRD 3.7 三条样例响应 0.71 / 0.84 / 0.87） */
export type CurrentRisk = {
  id: string;
  componentId: string;
  zoneId: string;
  label: string;
  branch: "雷达" | "视觉" | "融合";
  score: number;
  /** PRD 3.7：融合是规则，不是分数相加平均 */
  priority: "优先复核" | "补充检测" | "待核对";
  quality: "合格" | "不合格" | "部分合格";
  evidence: string[];
  recommendation: string;
};

/** 历史风险 R01–R06（PRD 5.3 MAY-DEMO-01） */
export type HistoryRisk = {
  id: string;
  title: string;
  status: "验收关闭" | "待验收" | "待处理";
  reported: boolean;
  closed: boolean;
  next: string;
  sceneId: string;
  bookmark: string;
};

/** 工单状态机（PRD 3.8），design.ts ORDER_STATUS 为展示顺序 */
export type OrderStatus = "草稿" | "待复核" | "待处理" | "处理中" | "待验收" | "已关闭";

export type Order = {
  id: string;
  title: string;
  site: string;
  district: string;
  location: string;
  scope: string;
  componentIds: string[];
  status: OrderStatus;
  current: boolean;
  createdAt: string;
  /** 问题发现时间：可取来源风险的发现时刻，也可取建单时刻，由种子给定 */
  discoveredAt: string;
  owner: string;
  level: "高风险" | "中风险" | "低风险";
  sourceRiskIds: string[];
  attachments: Attachment[];
  acceptanceNote: string;
  revisitPlanId: string | null;
  sourceMode: SourceMode;
};

export type LogEntry = {
  at: string;
  actor: string;
  action: string;
  object: string;
  result: string;
};

export type MapVersion = {
  id: string;
  label: string;
  resolutionM: number;
  sizeText: string;
  coveragePct: number;
  updatedAt: string;
  state: "采集中" | "待检查" | "已保存";
  note: string;
};

/** 占据栅格地图（PRD 3.2） */
export type GridMap = {
  width: number;
  height: number;
  resolutionM: number;
  origin: [number, number];
  /** 行优先，0 可通行 / 1 占据 / 2 未知 */
  cells: number[];
  legend: { code: number; label: string; color: string }[];
};

export type Waypoint = {
  id: string;
  label: string;
  componentId: string | null;
  cell: [number, number];
  state: "已到达" | "当前目标" | "待执行";
};

export type ForbiddenZone = {
  id: string;
  label: string;
  cell: [number, number];
  w: number;
  h: number;
  reason: string;
};

export type PoseSample = { t: string; cell: [number, number] };

export type MissionStep = { at: string; label: string; actor: string; result: string };

export type Mission = {
  id: string;
  robotId: string;
  mapVersion: string;
  speedProfile: string;
  state: "草稿" | "已预览" | "等待机器人确认" | "执行中" | "已暂停" | "已完成" | "已取消";
  waypoints: Waypoint[];
  /** 平台计划路径（cell 序列） */
  plannedPath: [number, number][];
  /** 机器人实际路径（单独着色） */
  actualPath: [number, number][];
  steps: MissionStep[];
  takeover: { at: string; reason: string; operator: string }[];
  anomalies: { at: string; text: string }[];
};

export type SceneAsset = {
  id: string;
  title: string;
  round: "历史" | "本轮";
  sourceVideo: string;
  keyframes: number;
  version: string;
  published: "已发布" | "待检查" | "草稿";
  format: string;
  bbox: string;
  updatedAt: string;
  sourceMode: SourceMode;
};

export type HotspotEvidence = {
  hotspotId: string;
  componentId: string;
  zoneId: string;
  label: string;
  image: { name: string; note: string };
  echo: { peakIndex: number; amplitude: number; unit: string; note: string };
  screening: { material: string; score: number; note: string };
  fusion: { ruleVersion: string; priority: string; branches: string[] };
  history: { at: string; text: string; operator: string }[];
};

/** 手持采集批次（PRD 9.2 原始数据包契约） */
export type ScanBatch = {
  batchId: string;
  componentId: string;
  zoneId: string;
  round: "初扫" | "复扫" | "补扫";
  configVersion: string;
  modelVersion: string;
  rawLevel: "ADC" | "IQ" | "spectrum" | "features" | "result_only" | "opaque";
  startedAt: string;
  /** 三路分别呈现接收情况：原始数据 / 表面图像 / 结果文件 */
  receive: {
    radar: { received: number; expected: number; state: "完成" | "部分接收" | "未开始"; }
    image: { received: number; expected: number; state: "完成" | "部分接收" | "未开始"; }
    result: { received: number; expected: number; state: "完成" | "部分接收" | "未开始"; }
  };
  frozen: boolean;
  freezeReason: string | null;
  sourceMode: SourceMode;
};

export type WaveSample = { x: number; y: number };

export type Waveform = {
  id: string;
  batchId: string;
  /** 横轴口径：频谱已是频谱，不再做 FFT */
  axisLabel: string;
  unit: string;
  points: WaveSample[];
  markers: { x: number; label: string; tone: "red" | "amber" | "cyan" }[];
};

/**
 * 硬件日志的一条输出记录。
 *
 * 来源分设备侧进程（上位机 / 下位机 / 毫米波模块）与链路（传输 / 供电），
 * 对应剧本 S09 里饶讲的分工：「上位机检查图像与文件，下位机检查采集时序与
 * 模型输入，异常也更容易定位」—— 所以日志必须带 `source`，只按时间排一条
 * 流水账就分不出该查哪一层。
 */
export type DeviceLogEntry = {
  id: string;
  /** 相对时间戳 mm:ss，与剧本时间轴同口径 */
  at: string;
  level: "INFO" | "WARN" | "ERROR";
  source: DeviceLogSource;
  text: string;
};

export type DeviceLogSource =
  | "ESP32-S3"
  | "树莓派"
  | "毫米波模块"
  | "传输"
  | "供电";

/**
 * 异常事件。
 *
 * 列表页一行一条，点开看详情 —— 所以除了列表要显示的摘要，还要有
 * 详情弹窗用的证据与处置过程。证据按剧本 S12 分「设备证据 / 模型证据」：
 * 沈的原话是「设备是否正常有设备证据，模型是否适用有模型证据，
 * 请分别核对」，混成一堆会让人以为换个账号就能解决。
 */
export type AnomalyEvent = {
  id: string;
  at: string;
  kind: string;
  /** 一句话说清发生了什么，列表里显示这一条 */
  summary: string;
  detail: string;
  frozenBatch: string;
  outputsFrozen: boolean;
  trigger: "演示控制事件" | "实机检查结果";
  /** 证据分两类：设备侧看设备是否正常，模型侧看模型是否适用 */
  deviceEvidence: { at: string; text: string; result: string }[];
  modelEvidence: { at: string; text: string; result: string }[];
  /** 处置过程：谁在什么时候做了什么，形成可追溯的处理链 */
  handling: { at: string; owner: string; text: string }[];
  /** 结论；未结案时为 null，不要用空字符串冒充「已处理」 */
  conclusion: string | null;
  state: "待处理" | "处理中" | "已结案";
  owner: string;
};

/**
 * 设备启动检查项。
 *
 * 由原「四项检查」改造而来：原来在异常排查页里事后逐项填结论，现在是
 * **采集启动前的硬门槛** —— 硬件工程师点「启动采集」后逐条确认并签署，
 * 全部签完才真正进入采集。判据来自知识库 SOP
 * 「每次采集前核对设备电量、存储余量与时间同步状态，三项任一不满足即不开始采集」，
 * 另外补上传感器响应、通道连通与测区方向。
 */
export type BootCheckItem = {
  id: string;
  label: string;
  /** 期望值：签署时要对着看的东西，不能只有一个「通过」按钮 */
  expected: string;
  /** 这一项不过会怎样 */
  onFail: string;
  owner: string;
  /** 检查项归属的子过程，界面上按这个分组 */
  group: "设备" | "链路" | "测区";
};

/** 数据集与样本（PRD 3.5 / 11.1） */
export type Sample = {
  physicalSampleId: string;
  recordId: string;
  path: string;
  materialSource: string;
  knownState: "正常" | "已知缺陷" | "未知待核验";
  labelBasis: string;
  quality: "可用" | "不可用" | "待审核";
  qualityReason: string;
  groupId: string;
  distanceMm: number;
  direction: string;
  saturationPct: number;
  duplicateOf: string | null;
  sourceBatch: string;
};

export type CleanStep = {
  key: string;
  label: string;
  input: number;
  kept: number;
  review: number;
  reason: string;
};

export type SplitGroup = {
  name: "训练集" | "验证集" | "测试集";
  sampleIds: string[];
};

export type Dataset = {
  id: string;
  label: string;
  frozen: boolean;
  frozenAt: string | null;
  reviewAssign: { owner: string; task: string; state: "已通过" | "待处理" | "已退回" }[];
  cleanSteps: CleanStep[];
  splits: SplitGroup[];
  indexVersion: string;
  sourceMode: SourceMode;
};

/** 训练与验证（PRD 3.6 / 11.2） */
export type Curve = { id: string; label: string; color: string; points: WaveSample[] };

export type Prediction = {
  sampleId: string;
  groupId: string;
  label: 0 | 1;
  score: number;
  materialGroup: string;
  material: string;
};

export type Experiment = {
  id: string;
  title: string;
  baselineVersion: string;
  candidateVersion: string;
  datasetVersion: string;
  learningRate: number;
  stopCondition: string;
  updateScope: string;
  inputSpec: string;
  threshold: number;
  jobSteps: { key: string; label: string; state: "等待" | "进行中" | "已完成"; at: string | null }[];
  curveOld: Curve;
  curveNew: Curve;
  /**
   * 候选模型的训练 / 验证损失。
   *
   * 与 `curveOld / curveNew` 的区别：那两条是「旧版 / 新版同一条口径」的对比，
   * 这两条是**同一个候选模型**在训练集与验证集上的损失 —— 剧本 S16 让架构师
   * 口播的正是这两条（「训练误差下降、验证误差却持续上升，说明开始过拟合」）。
   * 没有这一对曲线，页面上就没法判断候选版本是学好了还是背下来了。
   */
  curveTrain: Curve;
  curveVal: Curve;
  predictionsOld: Prediction[];
  predictionsNew: Prediction[];
  acceptance: { key: string; label: string; detail: string; pass: boolean }[];
  /** 本次实验的训练配置（剧本 S15：数据版本、学习率、更新范围、停止条件） */
  config: TrainingConfigField[];
  /** 任务控制台日志，任务逐步读取实验包形成可点击的真实记录（PRD 11.2） */
  log: JobLogLine[];
  /** 执行节点占用曲线，与日志播放同步（PRD 11.2 的 epochs.csv 口径） */
  node: NodeMetric[];
  sourceMode: SourceMode;
};

/**
 * 训练配置的一项。
 *
 * `readonly` 的项由数据集冻结状态或模型结构决定，不让改 —— 界面上要说明
 * 为什么不能改，而不是灰着不解释。可改项带范围，越界一律拦下来。
 */
export type TrainingConfigField = {
  key: string;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 小数位，保证同一列里不出现 0.0005 与 0.5 混排 */
  digits?: number;
  readonly?: boolean;
  /** 这一项为什么是这个值 / 为什么不能改 */
  note: string;
};

/** 任务控制台的一行日志 */
export type JobLogLine = {
  /** 相对时间戳 mm:ss，与 EXPERIMENT.jobSteps 的 at 同一口径 */
  at: string;
  level: "INFO" | "WARN" | "ERROR";
  /** 归属阶段，对应 Experiment.jobSteps 的 key */
  step: string;
  /**
   * 这一行发生时的轮次。执行节点占用按它取对应的采样点，
   * 所以回放时资源曲线会跟着日志一起走，而不是各播各的。
   * 缺省表示该行不推进轮次（沿用上一行的值）。
   */
  epoch?: number;
  text: string;
};

/** 执行节点的一项占用指标 */
export type NodeMetric = {
  key: string;
  label: string;
  unit: string;
  digits?: number;
  /** 整轮训练按 epoch 采样的序列，长度与损失曲线一致 */
  series: number[];
  /** 量程上限，用于画占用条与 sparkline */
  scale: number;
  /** 超过这个值算吃紧（仅用于着色，不改变数值） */
  warnAbove?: number;
};

/** 更新交付（PRD 3.6 / 11.3） */
export type DeliveryStep = {
  key: string;
  label: string;
  owner: string;
  state: "等待" | "进行中" | "已完成" | "失败";
  at: string | null;
  note: string;
};

export type UpdatePackage = {
  id: string;
  artifactKind: "demo_nonflashable" | "model_only" | "firmware_integrated";
  modelVersion: string;
  preprocess: string;
  inputSpec: string;
  outputSpec: string;
  targetEnv: string;
  sha256: string;
  sizeText: string;
  fallbackVersion: string;
  quantization: { key: string; label: string; detail: string }[];
  compatibility: { key: string; label: string; pass: boolean; detail: string }[];
  steps: DeliveryStep[];
  deviceVersion: { liveReported: string; demoReported: string };
  sourceMode: SourceMode;
};

export type RevisitPlan = {
  id: string;
  mapVersion: string;
  checkpoints: { componentId: string; bookmark: string; note: string }[];
  date: string;
  dispatched: boolean;
  owner: string;
};

/** 归档清单（PRD 3.8：运行真实 SHA-256 校验演示） */
export type ArchiveItem = {
  group: "工单" | "环境" | "原始数据" | "图像" | "地图" | "场景" | "数据集" | "模型记录" | "更新日志" | "报告";
  assetId: string;
  name: string;
  sizeText: string;
  /** 清单登记的摘要 */
  declaredSha256: string;
  /** 演示用的「实际重新计算」摘要，故意留两处不一致 */
  actualSha256: string;
  present: boolean;
  sourceMode: SourceMode;
};

/** RAG 知识库（PRD 5） */
export type KnowledgeDoc = {
  docId: string;
  title: string;
  category: "巡检报告" | "构件档案" | "维修反馈" | "方法文档" | "场景索引" | "天气档案";
  project: string;
  date: string;
  version: string;
  digest: string;
  source: string;
  chunks: { chunkId: string; section: string; text: string }[];
};

/** 演示控制台脚本阶段（第二章时间节点） */
export type ClockPhase = {
  key: string;
  start: string;
  end: string;
  title: string;
  slides: string;
  speaker: string;
  stageKey: StageKey;
  keyLines: string[];
  eventKey?: string;
};

/** 演示控制台可选事件 */
export type DemoEvent = {
  key: string;
  label: string;
  detail: string;
  /** 触发后置位的异常/状态 */
  effect: string;
  tone: "red" | "amber" | "cyan";
};
