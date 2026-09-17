/**
 * 小木语音智能体 · 事实表（业务状态）
 *
 * PRD 5.1：资料用于解释，业务状态来自结构化数据，两类来源分开。
 * 本文件就是「业务状态」的唯一出口：**所有数值与文案都从 seed/scenario.ts 推导**，
 * 意图模板里的 {占位符} 全部在这里填值。任何页面都不允许再另写一套数字。
 *
 * 与 tools.ts 的分工：
 *   - 查询类事实（历史统计、批次、地图版本、天气档案…）在 evaluate 时即时从 seed 读取；
 *   - 会随操作变化的实时状态（电量、小车位置、任务状态、装载的地图、扫描状态）
 *     由 store.ts 的 live snapshot 提供，通过 FactContext.live 传入。
 */

import {
  COMPONENTS,
  CURRENT_RISKS,
  DATASET,
  DEMO_BUSINESS_DATE,
  DEMO_SESSION,
  DEVICES,
  DRAFT_ORDER,
  ENV_RECORD,
  EXPERIMENT,
  FUSION_RECORD,
  HISTORIC_ORDERS,
  HISTORY_RISKS,
  HISTORY_STATS,
  KNOWLEDGE_DOCS,
  MAP_VERSIONS,
  MISSION,
  PATROL_WINDOW_STATS,
  REVISIT_PLAN,
  SCAN_BATCHES,
  SCENES,
  SCENE_BOOKMARKS,
  STAGES,
  UPDATE_PACKAGE,
  WAYPOINTS,
  WAVEFORMS,
  WORK_ORDER,
  componentById,
} from "../seed/scenario";
import { runEvaluation } from "../lib";
import { NAV_ITEMS } from "../design";
import { formatDistance, routeDistance } from "./lib/geo";
import type { EntityBag } from "./types";
import type { Intent } from "./intents";

/** 事实键 → 展示值（界面直接显示，不再二次格式化） */
export type FactRow = { key: string; value: string };

/** 事实语义，仅用于界面着色：风险=红、待处理=黄、成功=绿、普通=中性 */
export type FactTone = "neutral" | "risk" | "warn" | "ok" | "info";

/** 会随操作变化的实时状态，由 agent/store.ts 维护 */
export type LiveSnapshot = {
  /** 小车电量百分比（由 store 从任务路径进度推导，不由本文件编造） */
  battery: number;
  /** 小车当前所在点位 label */
  position: string;
  /** 任务状态（取自 Mission["state"] 的取值域） */
  missionState: string;
  /** 当前装载的地图版本 id */
  mapId: string;
  /** 是否正在建图 */
  mapping: boolean;
  /** 是否正在扫描 */
  scanning: boolean;
  /** 已完成 / 计划航点数（用于进度展示） */
  waypointDone: number;
  waypointTotal: number;
};

export type FactContext = {
  /** 会话当前阶段（STAGES[].key） */
  stageKey: string;
  /** 当前账号「姓名 · 角色」 */
  accountLabel: string;
  /** 演示数据来源：演示车 / 实机 */
  sourceMode: "demo" | "real";
  /** 四路通道一行摘要（由界面从 context.channels 拼好后传入） */
  channelSummary: string;
  /** 已抽取的槽位：pillar / batch / map / page / scene / speed / route / pageLabel */
  entities: EntityBag;
  /** 要渲染的回复模板（可能是 response.text，也可能是随机到的 alternatives） */
  template: string;
  /** 会随操作变化的实时状态 */
  live: LiveSnapshot;
  /** 多步任务时由 planner 提供的补充事实（goal / routeText 等） */
  extra?: Record<string, string>;
};

export type FactSet = {
  intentId: string;
  rows: FactRow[];
  /** 模板渲染结果 */
  text: string;
  /** 有占位符没取到值时为 true —— 回复降级为未命中话术，不猜数字（PRD 4.2） */
  missing: string[];
};

const NOT_MEASURED = "未采集";

/**
 * 知识库页面的路由：取自 design.ts 的导航表，本文件不另写一份页面路径
 * （兜底值 `/knowledge` 就是 routes.tsx 注册的那条路径，导航表改名时它保证不空指针）。
 */
const KNOWLEDGE_ROUTE = NAV_ITEMS.find((item) => item.key === "knowledge")?.path ?? "/knowledge";

/** 数值格式化统一走 lib 的口径，避免同一数字在不同页面位数不同；null 表示未计算 */
function num(value: number | null, digits = 3): string {
  if (value === null || Number.isNaN(value)) return "未计算";
  return Number(value.toFixed(digits)).toString();
}

/** 柱号 → 观察点（取 WAYPOINTS 里 componentId 对应的那条） */
function waypointFor(componentId: string) {
  return WAYPOINTS.find((item) => item.componentId === componentId) ?? null;
}

/** 地图版本：优先按 id 找，找不到退回当前任务用的那版 */
function mapVersionOf(mapId: string) {
  return MAP_VERSIONS.find((item) => item.id === mapId) ?? MAP_VERSIONS.find((item) => item.id === MISSION.mapVersion) ?? MAP_VERSIONS[0];
}

/** 场景：历史场景取 round === "历史" 的那条，本轮取 mission 之外的「本轮」已发布场景 */
function sceneOf(kind: "history" | "current") {
  if (kind === "history") return SCENES.find((item) => item.round === "历史") ?? SCENES[0];
  return SCENES.find((item) => item.round === "本轮" && item.published === "已发布") ?? SCENES[0];
}

function batchOf(batchId: string | undefined) {
  return SCAN_BATCHES.find((item) => item.batchId === batchId) ?? SCAN_BATCHES[0];
}

/**
 * 取某批次要拿来"讲"的那条曲线：**优先频谱**。
 *
 * 同一个批次现在有两条（时域回波 + 频域频谱，见 `seed/radarEcho.ts`）。
 * 台词讲"主频 / 带宽 / 本底"最自然，所以这里固定取频谱；
 * 时域那条由孪生页并排画出来给现场看形状。
 */
function waveformOf(batchId: string) {
  const list = WAVEFORMS.filter((item) => item.batchId === batchId);
  return list.find((item) => item.kind === "spectrum") ?? list[0] ?? WAVEFORMS[0];
}

function receiveText(item: { received: number; expected: number; state: string }) {
  return `${item.received}/${item.expected}（${item.state}）`;
}

/** 四柱表：编号 / 名称 / 雷达响应。未检测一律写「未采集」，不用 0 冒充无风险 */
function pillarTableText(): string {
  return COMPONENTS.map((item) => {
    const score = item.radarScore === null ? NOT_MEASURED : num(item.radarScore);
    return `${item.id} ${item.name}：雷达响应 ${score}`;
  }).join("；");
}

/** 优先复核顺序：有雷达响应的构件按分值降序，其余保持档案顺序排在后面 */
function radarOrder(): { first: string; rest: string } {
  const scored = COMPONENTS.filter((item) => item.radarScore !== null).sort(
    (a, b) => (b.radarScore ?? 0) - (a.radarScore ?? 0),
  );
  const unscored = COMPONENTS.filter((item) => item.radarScore === null);
  const ordered = [...scored, ...unscored];
  const first = ordered[0];
  const rest = ordered.slice(1);
  return {
    first: first ? `${first.id} ${first.name}（${first.visibleNote}）` : "—",
    rest: rest.map((item) => item.id).join("、"),
  };
}

/** 未关闭风险：编号 + 下一步（PRD 5.3 的「剩下的」取自同一份历史风险表） */
function openRiskText(): string {
  const open = HISTORY_RISKS.filter((item) => !item.closed);
  if (open.length === 0) return "全部历史风险已关闭";
  return open.map((item) => `${item.id} ${item.next}`).join("；");
}

/** 历史巡检的追问建议：取第一条未关闭风险的下一步 */
function followupText(): string {
  const open = HISTORY_RISKS.find((item) => !item.closed);
  if (!open) return "历史风险已全部关闭。";
  return `下一步：${open.next}（${open.id} ${open.title}）。`;
}

export function evaluateFacts(intent: Intent, ctx: FactContext): FactSet {
  const live = ctx.live;
  const focus = CURRENT_RISKS[0];
  const focusComponent = componentById(focus.componentId) ?? COMPONENTS[0];
  const table: Record<string, string> = {};

  /* ---- 历史汇总（PRD 5.3：四个数字全部由 HISTORY_RISKS 算出） ---- */
  table.total = String(HISTORY_STATS.total);
  table.reportedDone = String(HISTORY_STATS.reportedDone);
  table.closed = String(HISTORY_STATS.closed);
  table.open = String(HISTORY_STATS.open);
  table.followup = followupText();
  table.items = openRiskText();

  /* ---- 近三个月巡检汇总（patrol_risk_summary：固定语句，数字来自 seed） ---- */
  table.patrolSiteCount = String(PATROL_WINDOW_STATS.siteCount);
  table.patrolRiskCount = String(PATROL_WINDOW_STATS.riskCount);
  table.patrolHighRiskCount = String(PATROL_WINDOW_STATS.highRiskCount);
  table.patrolRepairedCount = String(PATROL_WINDOW_STATS.repairedCount);
  table.patrolScheduledCount = String(PATROL_WINDOW_STATS.scheduledCount);
  table.patrolAcceptedCount = String(PATROL_WINDOW_STATS.acceptedCount);

  /* ---- 场景（技术方案 §17 实体：scene） ---- */
  const historyScene = sceneOf("history");
  const currentScene = sceneOf("current");
  table.sceneTitle = historyScene.title;
  table.sceneVersion = historyScene.version;
  table.sceneKeyframes = String(historyScene.keyframes);
  table.sceneBookmarks = SCENE_BOOKMARKS.filter((item) => item.componentId).map((item) => item.id).join(" / ");
  table.currentSceneTitle = currentScene.title;
  table.currentSceneVersion = currentScene.version;

  /* ---- 天气档案（PRD 5.3 / site_weather：只说归档，不说实时联网） ---- */
  const weatherDoc = KNOWLEDGE_DOCS.find((item) => item.category === "天气档案") ?? KNOWLEDGE_DOCS[0];
  table.weatherRange = DEMO_SESSION.weatherArchive.range;
  table.weatherSummary = DEMO_SESSION.weatherArchive.summary;
  table.weatherSource = DEMO_SESSION.weatherArchive.source;
  table.climate = `${DEMO_SESSION.weatherArchive.summary}（归档文档 ${weatherDoc.docId}，版本 ${weatherDoc.version}）`;
  table.weatherDoc = weatherDoc.title;

  /* ---- 四柱与优先顺序 ---- */
  const order = radarOrder();
  table.orderFirst = order.first;
  table.orderRest = order.rest;
  table.pillarTable = pillarTableText();
  table.z04Radar = focusComponent.radarScore === null ? NOT_MEASURED : num(focusComponent.radarScore);
  table.z04Visible = focusComponent.visibleNote;
  table.radarNote = `四柱中只有 ${focusComponent.id} 有雷达响应（${table.z04Radar}），其余三根${NOT_MEASURED}。`;
  table.z04Note = `${focusComponent.id} ${focusComponent.archive}`;
  table.riskIds = CURRENT_RISKS.map((item) => item.id).join("、");
  table.riskCount = String(CURRENT_RISKS.length);

  /* ---- 证据（PRD 5.3.4：先给证据再打开场景） ---- */
  table.evidenceIds = CURRENT_RISKS.flatMap((item) => item.evidence).join("、");
  table.evidenceImages = focus.evidence.filter((item) => item.startsWith("img-")).join(" / ") || NOT_MEASURED;
  table.evidenceEcho = focus.evidence.filter((item) => item.startsWith("echo-")).join(" / ") || NOT_MEASURED;
  table.echoPeak = num(focus.score);
  /* 口径：横轴是频率，距离轴仍未标定 —— 这一句不许改成任何形式的深度 */
  table.echoNote = "横轴为频率，距离轴未标定，不写作深度";
  table.historyNote = `历史关联：${HISTORY_RISKS.filter((item) => item.title.startsWith(focus.componentId))
    .map((item) => `${item.id} ${item.title}（${item.status}）`)
    .join("；")}`;

  /* ---- 回波曲线 ----
     `waveformOf` 给的这一条是**频谱**（同批次还有时域回波，见 seed 的 WAVEFORMS）：
     台词讲"主频 / 带宽 / 本底"最自然，也最经得起现场追问。 */
  const wave = waveformOf(batchOf(undefined).batchId);
  const peak = wave.points.reduce((best, point) => (point.y > best.y ? point : best), wave.points[0]);
  const waveMax = wave.xMax ?? 1;
  table.waveBatch = wave.batchId;
  table.waveAxis = wave.axisLabel;
  table.waveUnit = wave.unit;
  table.echoPeakIndex = num(peak?.x ?? 0, 4);
  table.echoAmplitude = num(peak?.y ?? 0, 3);
  /* 真实单位下的读数：主频 / −6 dB 带宽 / 本底，都由 `buildSpectrum` 算好存在 `stats` 里 */
  table.echoPeakMhz = String(Math.round((peak?.x ?? 0) * waveMax));
  table.echoBandwidthMhz = String(wave.stats?.bandwidthMhz ?? 0);
  table.echoFloorDb = String(wave.stats?.floorDb ?? 0);
  table.echoPeakLabel = `${table.echoPeakMhz} MHz（−6 dB 带宽约 ${table.echoBandwidthMhz} MHz）`;
  table.waveMarkers = wave.markers.length
    ? wave.markers.map((item) => `${item.label}（${Math.round(item.x * waveMax)} MHz）`).join("、")
    : "本批次无标记点";

  /* ---- 异常排查 ---- */
  const frozenBatch = SCAN_BATCHES.find((item) => item.frozen);
  table.anomalyId = frozenBatch?.batchId ?? SCAN_BATCHES[0].batchId;
  table.anomalyDetail = frozenBatch?.freezeReason ?? "本批次无冻结记录";
  table.nextActions = "先核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，再验证候选模型";

  /* ---- 数据集与训练验证（清洗步骤、审核任务、划分全部取自 seed 的 DS-06） ---- */
  table.datasetLabel = DATASET.label;
  table.datasetId = DATASET.id;
  table.datasetIndex = DATASET.indexVersion;
  table.datasetFrozenAt = DATASET.frozenAt ?? "—";
  table.datasetFrozen = DATASET.frozen ? `已冻结（${DATASET.frozenAt ?? "—"}）` : "未冻结";
  table.splitText = DATASET.splits.map((item) => `${item.name} ${item.sampleIds.length} 条`).join(" / ");
  table.cleanSteps = `${DATASET.cleanSteps.length} 步：${DATASET.cleanSteps.map((item) => item.label).join(" → ")}`;
  table.reviewCount = `${DATASET.cleanSteps.reduce((sum, item) => sum + item.review, 0)} 条待审核记录`;
  table.reviewPassed = String(DATASET.reviewAssign.filter((item) => item.state === "已通过").length);
  table.reviewTotal = String(DATASET.reviewAssign.length);
  table.reviewState = `${table.reviewPassed}/${table.reviewTotal} 已通过`;
  table.experimentTitle = EXPERIMENT.title;
  const evaluation = runEvaluation(EXPERIMENT);
  const acceptanceFailed = EXPERIMENT.acceptance.filter((item) => !item.pass);
  table.metrics = `精确率 ${num(evaluation.overall.old.precision)} → ${num(evaluation.overall.next.precision)}；召回率 ${num(evaluation.overall.old.recall)} → ${num(evaluation.overall.next.recall)}；F1 ${num(evaluation.overall.old.f1)} → ${num(evaluation.overall.next.f1)}`;
  table.acceptance = `${EXPERIMENT.acceptance.length - acceptanceFailed.length}/${EXPERIMENT.acceptance.length} 项规则通过`;

  /* ---- 更新交付 ---- */
  const compatBlock = UPDATE_PACKAGE.compatibility.filter((item) => !item.pass);
  table.packageId = UPDATE_PACKAGE.id;
  table.packageKind = UPDATE_PACKAGE.artifactKind;
  table.compatPass = String(UPDATE_PACKAGE.compatibility.length - compatBlock.length);
  table.compatBlock = String(compatBlock.length);
  table.blockNote = compatBlock.length
    ? `阻断项：${compatBlock.map((item) => `${item.label}（${item.detail}）`).join("；")}`
    : "无阻断项。";

  /* ---- 融合 ---- */
  table.fusionRecordId = FUSION_RECORD.recordId;
  table.fusionRule = FUSION_RECORD.ruleVersion;
  table.fusionBatch = FUSION_RECORD.batchId;
  table.outputs = FUSION_RECORD.outputs
    .map((item) => `${item.riskId} ${item.priority}（${item.quality}）`)
    .join("；");

  /* ---- 工单 ---- */
  table.orderId = DRAFT_ORDER.id;
  table.orderTitle = WORK_ORDER.title;
  table.orderStatus = WORK_ORDER.status;
  table.orderOwner = WORK_ORDER.owner;
  table.orderLevel = WORK_ORDER.level;
  table.orderComponents = WORK_ORDER.componentIds.join("、");
  table.orderAttachments = `${WORK_ORDER.attachments.length} 项：${WORK_ORDER.attachments.map((item) => item.name).join("、")}`;
  table.orderScope = WORK_ORDER.scope;
  table.orderCount = String(1 + HISTORIC_ORDERS.length);
  table.orderDraftAttachments = `${DRAFT_ORDER.attachments.length} 项：${DRAFT_ORDER.attachments.map((item) => item.name).join("、")}`;
  table.attachments = table.orderDraftAttachments;
  table.priority = DRAFT_ORDER.level;
  table.orderDraftId = DRAFT_ORDER.id;

  /* ---- 复巡计划 ---- */
  table.planId = REVISIT_PLAN.id;
  table.planDate = REVISIT_PLAN.date;
  table.planMap = REVISIT_PLAN.mapVersion;
  table.planCheckpoints = REVISIT_PLAN.checkpoints
    .map((item) => `${item.componentId}（${item.bookmark}）`)
    .join("、");
  table.planStatus = REVISIT_PLAN.dispatched ? "已下发" : "未下发";

  /* ---- 平台介绍 ---- */
  table.platformCopy = DEMO_SESSION.scenarioTitle;
  table.scenarioTitle = DEMO_SESSION.scenarioTitle;
  table.scenarioId = DEMO_SESSION.scenarioId;
  table.businessDate = DEMO_BUSINESS_DATE;
  table.stageCount = String(STAGES.length);
  table.stageLabel = STAGES.find((item) => item.key === ctx.stageKey)?.label ?? STAGES[0].label;
  table.sessionId = DEMO_SESSION.sessionId;
  table.profile = DEMO_SESSION.profile;

  /* ---- 小车与建图 ---- */
  const home = WAYPOINTS.find((item) => item.componentId === null) ?? WAYPOINTS[0];
  table.missionId = MISSION.id;
  table.missionRobot = MISSION.robotId;
  table.missionSpeed = MISSION.speedProfile;
  table.missionState = live.missionState;
  table.missionMap = live.mapId;
  table.robotPosition = live.position;
  table.homeLabel = home.label;
  table.battery = `${live.battery}%`;
  table.batteryValue = String(live.battery);
  table.robotName = DEVICES.demoCart.name;
  table.scannerName = DEVICES.scanner.name;
  table.scannerMode = DEVICES.scanner.mode;
  table.realCartName = DEVICES.realCart.name;
  table.sourceLabel = DEMO_SESSION.sourceLabel;
  table.channelSummary = ctx.channelSummary;
  table.accountLabel = ctx.accountLabel;
  const mapVersion = mapVersionOf(live.mapId);
  table.mapId = mapVersion.id;
  table.mapLabel = mapVersion.label;
  table.mapResolution = num(mapVersion.resolutionM, 2);
  table.mapCoverage = `${mapVersion.coveragePct}%`;
  table.mapState = mapVersion.state;
  table.mapUpdatedAt = mapVersion.updatedAt;
  table.mapNote = mapVersion.note;
  table.mapCount = String(MAP_VERSIONS.length);
  table.mapList = MAP_VERSIONS.map((item) => `${item.id}（${item.state}）`).join("、");
  table.envRecordId = ENV_RECORD.recordId;
  table.envMeasuredAt = ENV_RECORD.measuredAt;
  table.envAirTempC = String(ENV_RECORD.airTempC);
  table.envHumidity = String(ENV_RECORD.relativeHumidityPct);
  table.envWind = String(ENV_RECORD.windSpeedMs);
  table.envInstrument = ENV_RECORD.instrumentId;

  /* ---- 目标构件（实体槽位） ---- */
  const targetId = (ctx.entities.pillar ?? focusComponent.id).toUpperCase();
  const target = componentById(targetId) ?? focusComponent;
  const targetWaypoint = waypointFor(target.id);
  table.targetId = target.id;
  table.targetName = target.name;
  table.targetLabel = `${target.id} ${target.name}`;
  table.componentName = target.name;
  table.componentLabel = `${target.id} ${target.name}`;
  table.componentZone = target.zoneId;
  table.targetPart = target.part;
  table.targetZone = target.zoneId;
  table.targetArchive = target.archive;
  table.targetVisible = target.visibleNote;
  table.waypointLabel = targetWaypoint ? `${targetWaypoint.id} · ${targetWaypoint.label}` : "暂无对应观察点";
  table.distance = targetWaypoint
    ? formatDistance(
        routeDistance(
          [WAYPOINTS[0]?.cell[0] ?? 0, WAYPOINTS[0]?.cell[1] ?? 0],
          [targetWaypoint.cell[0], targetWaypoint.cell[1]],
        ),
      )
    : "—";  table.speed = ctx.entities.speed ? `${ctx.entities.speed} m/s` : MISSION.speedProfile;

  /* ---- 批次 ---- */
  const batch = batchOf(ctx.entities.batch);
  table.batchId = batch.batchId;
  table.batchRound = batch.round;
  table.batchComponent = batch.componentId;
  table.batchZone = batch.zoneId;
  table.batchModel = batch.modelVersion;
  table.batchConfig = batch.configVersion;
  table.batchStartedAt = batch.startedAt;
  table.radarReceive = receiveText(batch.receive.radar);
  table.imageReceive = receiveText(batch.receive.image);
  table.resultReceive = receiveText(batch.receive.result);
  table.batchFrozen = batch.frozen ? `已冻结（${batch.freezeReason ?? "—"}）` : "未冻结";
  table.batchCount = String(SCAN_BATCHES.length);

  /* ---- 页面（导航实体） ---- */
  const pageLabel = ctx.entities.pageLabel ?? "任务总览";
  table.pageLabel = pageLabel;
  table.route = ctx.entities.route ?? "/";

  /* ---- 多步任务：由 planner 提供的补充事实 ---- */
  Object.assign(table, ctx.extra ?? {});

  /* ---- 渲染模板 ---- */
  const template = ctx.template;
  const missing: string[] = [];
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = table[key];
    if (value === undefined) {
      missing.push(key);
      return "";
    }
    return value;
  });

  const rows = intent.response.facts.map((key) => ({ key, value: table[key] ?? "—" }));
  return { intentId: intent.id, rows, text, missing };
}

/* ------------------------------------------------------------------ *
 * 资料引用（PRD 5.1：事实来自结构化数据，引用来自资料本身）
 * ------------------------------------------------------------------ */

/**
 * 一条可追溯的资料引用。
 *
 * 界面拿到它就能直接渲染成可点击的入口：标题 + 原文位置 + 打开路由 + 原文片段。
 * 字段口径与文字助手/语音气泡已有的引用展示一致（`章节 · 块号`，见 replyView.ts
 * 的 ReplySource 与 SmallWoodPanel 的 locator），两处不各写一套格式。
 */
export type SourceRef = {
  /** 知识文档 id，例如 doc-weather */
  docId: string;
  /** 文档内的块号 / 原文位置锚点，例如 w-01 */
  chunkId: string;
  /** 文档标题，例如「示例寺近三个月归档天气档案」 */
  title: string;
  /** 原文位置，格式 `章节 · 块号`，例如「降水与湿度 · w-01」 */
  locator: string;
  /** 命中的原文片段（点击后展示，PRD FR-05 的「到底引用的是哪句话」） */
  excerpt: string;
  /** 打开入口：知识库页面 + 原文位置深链（见 knowledgeDeepLink） */
  route: string;
};

/**
 * 引用落点：知识库页面 + 原文位置深链 `#/knowledge?doc=<docId>&chunk=<chunkId>`。
 *
 * ── 为什么必须带上参数（这是实测暴露的缺陷）──────────────────────
 * 引用原先只跳 `#/knowledge`。`Knowledge.tsx` 明明已经实现了"按 doc/chunk
 * 定位并高亮那一块"（它的顶部会显示 `doc=… chunk=…` 的落点说明），
 * 但**没有任何地方生成过这个链接** —— 于是用户点开引用看到的是知识库默认视图，
 * 还得自己去一篇篇文档里找那句话，PRD FR-05 要的"打开原文位置"就落空了。
 *
 * 参数名是与读取端（`Knowledge.tsx` 的 `useSearchParams`，取 `doc` / `chunk`）
 * 的硬约定：只给 `chunk` 也能定位（检索兜底时拿不到 docId），两个都给最精确。
 */
export function knowledgeDeepLink(docId?: string, chunkId?: string): string {
  const params = new URLSearchParams();
  if (docId) params.set("doc", docId);
  if (chunkId) params.set("chunk", chunkId);
  const query = params.toString();
  return query ? `${KNOWLEDGE_ROUTE}?${query}` : KNOWLEDGE_ROUTE;
}

/**
 * 意图 → 资料引用。入参允许 null，调用方可以直接传 `intentById(turn.intentId)`。
 *
 * 引用由意图**声明**（`response.sources` 的 docId + chunkId），这里只负责把它
 * 翻译成种子里真实存在的标题与原文位置：
 *   - 标题 / 章节 / 片段一律从 KNOWLEDGE_DOCS 取，不在意图目录里抄一遍；
 *   - 声明的资料或块在种子里找不到时**直接不返回这一条** —— 引用指向不存在的原文，
 *     比没有引用更糟（PRD 5.1 / 4.2：宁可说没有，不许编造出处）。
 */
export function sourcesOf(intent: Intent | null | undefined): SourceRef[] {
  const declared = intent?.response.sources ?? [];
  const refs: SourceRef[] = [];
  for (const ref of declared) {
    const doc = KNOWLEDGE_DOCS.find((item) => item.docId === ref.docId);
    const chunk = doc?.chunks.find((item) => item.chunkId === ref.chunkId);
    if (!doc || !chunk) continue;
    refs.push({
      docId: doc.docId,
      chunkId: chunk.chunkId,
      title: doc.title,
      locator: `${chunk.section} · ${chunk.chunkId}`,
      excerpt: chunk.text,
      route: knowledgeDeepLink(doc.docId, chunk.chunkId),
    });
  }
  return refs;
}

/** 事实行 → 语义色调，供界面按「红黄绿只表达状态」的规范着色 */
export function factToneOf(key: string, value: string): FactTone {
  if (/risk|open|block|frozen|anomal|danger/i.test(key) || /不合格|冻结|阻断|待处理/.test(value)) {
    if (/^(0|0%|未冻结|无阻断项)$/.test(value) || /无阻断项/.test(value)) return "ok";
    return "risk";
  }
  if (/battery|plan|review|compat|state|status|missing/i.test(key)) {
    if (/未下发|待|部分|模拟|未采集/.test(value)) return "warn";
    if (/已下发|已通过|完成|正常|在线|执行中/.test(value)) return "ok";
  }
  if (/mission|map|batch|robot|channel/i.test(key)) return "info";
  return "neutral";
}
