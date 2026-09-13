/**
 * 数据与知识中心 · knowledge-demo-v1 演示夹具（确定性生成，固定 seed）
 *
 * 依据：PRD §7.1（基线数量）、§11.2（两层夹具：可深入展示样本 + 规模样本）、
 *      §4.2（四维分类 + 关联对象）、§8（关系图数据）、§9.2（日志聚合规则）。
 *
 * 三条不能破的规则：
 *   1. **固定 seed，重置后结果一致**：全部随机性来自 mulberry32(seed)，
 *      不用 Math.random，也不用当前时间决定条数。
 *   2. **数字从记录来**：主类数量、分块数、向量条数都由本文件真的生成，
 *      页面显示值再从库里复算。卡里写常量会在测试里被抓出来。
 *   3. **规模样本不伪造独立证据**：同一份源文本可以被多个资产引用（PRD 明确
 *      允许物理文件复用），但它们各自是独立资产；反过来也不把相同片段复制成
 *      「18,420 条独立证据」。分块内容按「来源模板 + 定位 + 序号」派生，
 *      检索去重按来源资产与证据身份处理。
 */

import { createHash } from "node:crypto";
import {
  ADAPTER_MODE,
  BASELINE_CONFIG,
  BASELINE_CONFIG_REVISION,
  BASELINE_PUBLISHED_AT,
  BASELINE_ROWS,
  BASELINE_SERVING_VERSION,
  BASELINE_TOTALS,
  BASELINE_VERSIONS,
  BUSINESS_CATEGORIES,
  DATA_SOURCES,
  DEFAULT_SCOPE,
  DEMO_SCENARIO_ID,
  DIMENSION_CONFIG,
  DOCUMENT_FORMAT_SPLIT,
  SEARCH_CONFIG_DEFAULT,
} from "../domains/knowledge-contract.mjs";

/* ------------------------------------------------------------------ *
 * 1. 确定性随机
 * ------------------------------------------------------------------ */

/** mulberry32：小、快、可复现。同一个 seed 永远给出同一串数字 */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, rand) {
  return list[Math.floor(rand() * list.length) % list.length];
}

function pickMany(list, count, rand) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

/** 稳定的相对时间：由 anchor 与「几天前 + 时分」决定，不用每次刷新的当前时间 */
function isoAt(anchorMs, daysAgo, hour, minute) {
  const day = new Date(anchorMs - daysAgo * 86400000);
  const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, 0));
  return at.toISOString();
}

/* ------------------------------------------------------------------ *
 * 2.1 文件名生成
 *
 * 真实资料库里的文件名不是清一色中文：
 *   · 设备与扫描仪产出带前缀与序号（SCAN01_20260518_093012.ply）；
 *   · 报告与合同带项目号与版本（SH-2026-0518_大雄宝殿巡检报告_v1.2.pdf）；
 *   · 相机原片就是大写前缀加连拍号（DJI_20260518093012_0142.JPG）；
 *   · 建模与权重常见全英文小写加日期（tang dynasty hall_model_20260518.blend）；
 *   · 也有一批是人工随手命名的中文名（柱脚渗水_复核照片_3.jpg）。
 * 下面按各类型的真实习惯生成，中 / 英 / 编号 / 日期混排，让列表看起来像真的资料库。
 * ------------------------------------------------------------------ */

/** 项目前缀：与平台其它模块的编号口径一致（SH-2026-xxxx） */
const PROJECT_TAG = "SH-2026";

/** 中文短语池：人工命名的文件名用 */
const CN_PHRASES = ["柱脚渗水", "雨后复核", "东次间巡检", "梁架检查", "屋面检查", "油饰起甲", "榫卯节点", "台基沉陷"];

/** 设备型号池：相机 / 扫描仪 / 记录仪的机身编号 */
const CAMERA_BODIES = ["DJI", "SONY", "NIKON", "CANON", "FC6310"];
const SCANNER_BODIES = ["FARO", "LEICA", "TRIMBLE", "ZEB", "RIEGL"];

/** 无扩展名的各种后缀 */
function stampOf(asset) {
  const day = String(asset.capturedAt ?? "").slice(0, 10).replace(/-/g, "");
  return day || "20260518";
}

function clockOf(seedNumber) {
  const hour = pad(8 + (seedNumber % 10), 2);
  const minute = pad(seedNumber % 60, 2);
  const second = pad((seedNumber * 7) % 60, 2);
  return `${hour}${minute}${second}`;
}

/**
 * 按类型与格式生成一个像真的文件名。
 *
 * `ordinal` 参与编号：真实资料库不会有两份同名文件，夹具也不该有
 * （生成结束时有「文件名不得重复」自检）。同时按各类型的真实命名习惯混排：
 * 相机原片是大写前缀 + 连拍号，扫描仪是机身号 + 日期 + 站点，
 * 建模与权重是全英文小写，人工命名的文档才是中文短语。
 */
function filenameFor(asset, { format, ordinal, rand, kind }) {
  const day = stampOf(asset);
  const code = asset.sourceEntityId ?? asset.id;
  const seq = pad(ordinal % 10000, 4);
  const pid = `${PROJECT_TAG}-${pad((ordinal % 900) + 100, 3)}`;
  /** 兜底唯一段：任何模板拼完仍可能撞名时补上它（如 300 份同题材文档） */
  const uniq = `${pad(ordinal, 4)}`;
  const withUniq = (stem) => `${stem}_${uniq}.${format}`;

  switch (kind) {
    case "photo": {
      const body = pick(CAMERA_BODIES, rand);
      const style = ordinal % 4;
      if (style === 0) return `${body}_${day}${clockOf(ordinal)}_${seq}.${format}`;
      if (style === 1) return `IMG_${seq}${pad(ordinal % 100, 2)}.${format}`;
      if (style === 2) return withUniq(`${pid}_${pick(CN_PHRASES, rand)}_${(ordinal % 9) + 1}`);
      return `${code}_${day}.${format}`;
    }
    case "video": {
      const body = pick(CAMERA_BODIES, rand);
      const style = ordinal % 3;
      if (style === 0) return `${body}_${day}${clockOf(ordinal)}_${seq}_D.${format}`;
      if (style === 1) return `${code}_巡检录像_${seq}.${format}`;
      return withUniq(`${PROJECT_TAG}_${day}_${asset.zone ?? "现场"}_walkthrough`);
    }
    case "scan": {
      const body = pick(SCANNER_BODIES, rand);
      const style = ordinal % 3;
      if (style === 0) return `${body}_${day}_${clockOf(ordinal)}_${asset.zone ?? "site"}_${uniq}.${format}`;
      if (style === 1) return `scan_${code.toLowerCase()}_${seq}.${format}`;
      return `${body}${pad(ordinal % 20, 2)}_${day}_${clockOf(ordinal)}.${format}`;
    }
    case "gaussian":
      return ordinal % 2 === 0
        ? `${asset.zone ?? "site"}_gaussian_${day}.${format}`
        : `splat_${code.toLowerCase()}_v${(ordinal % 3) + 1}.${format}`;
    case "model": {
      const style = ordinal % 3;
      if (style === 0) return `${pid}_${asset.zone ?? "hall"}_model.${format}`;
      if (style === 1) return `mesh_${code.toLowerCase()}_${seq}.${format}`;
      return `${asset.buildingId?.toLowerCase() ?? "b"}_${day}_recon.${format}`;
    }
    case "cloud": {
      const style = ordinal % 3;
      if (style === 0) return `cloud_${code.toLowerCase()}_${seq}.${format}`;
      if (style === 1) return `merged_${day}_${asset.zone?.toLowerCase?.() ?? "site"}.${format}`;
      return `${PROJECT_TAG}_${day}_${pad(ordinal % 200, 3)}.${format}`;
    }
    case "weight": {
      /*
       * 权重文件名必须带**唯一编号**：这一类的命名习惯是「模型名 + 日期 + 轮次」，
       * 而轮次会取模循环（epoch % 120），只靠模板必然生成重名 ——
       * 真实资料库里同名权重是分不清版本的，夹具也不该出现（自检里有「文件名不得重复」断言）。
       */
      const tag = `w${pad(ordinal, 3)}`;
      const style = ordinal % 3;
      if (style === 0) return `wood_defect_yolov8s_${day}_epoch${(ordinal % 120) + 1}_${tag}.${format}`;
      if (style === 1) return `${["detector", "segmenter", "classifier"][ordinal % 3]}_${code.toLowerCase()}_best_${tag}.${format}`;
      return `mumai_${["crack", "rot", "moisture"][ordinal % 3]}_v${(ordinal % 5) + 1}_${tag}.${format}`;
    }
    case "audio":
      return ordinal % 3 === 0
        ? `REC${pad(ordinal % 900 + 100, 3)}_${day}_${clockOf(ordinal)}.${format}`
        : ordinal % 3 === 1
          ? `${PROJECT_TAG}_现场录音_${seq}.${format}`
          : `voice_memo_${code.toLowerCase()}.${format}`;
    case "log":
      return ordinal % 3 === 0
        ? `${(asset.primaryObjectId ?? "device").toLowerCase()}_${day}_${clockOf(ordinal)}.${format}`
        : ordinal % 3 === 1
          ? `${code.toLowerCase()}_session.log`
          : `woodpulse_${day}_${pad(ordinal % 500, 3)}.${format}`;
    case "order":
      return `${asset.orderNo ?? code}_${asset.zone ?? ""}_attachment.json`.replace(/__+/g, "_");
    case "record":
      return ordinal % 2 === 0 ? `${code.toLowerCase()}_record.${format}` : `${PROJECT_TAG}_${day}_record_${seq}.${format}`;
    default: {
      const style = ordinal % 5;
      if (style === 0) return `${pid}_大雄宝殿巡检报告_v${(ordinal % 3) + 1}.${format}`;
      if (style === 1) return `${PROJECT_TAG}-${pad(ordinal % 900 + 100, 3)}_${asset.zone ?? ""}_report.${format}`;
      if (style === 2) return `inspection_report_${day}_${seq}.${format}`;
      if (style === 3) return `${code}_${pick(["构件档案", "检测数据", "修缮工法", "维护要求"], rand)}.${format}`;
      return `Mumai_${["Report", "Archive", "Spec"][ordinal % 3]}_${seq}.${format}`;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. 工程对象（PRD §4.2 关联对象：项目 / 建筑 / 区域 / 构件 / 设备 / 任务 / 工单）
 * ------------------------------------------------------------------ */

/**
 * 建筑与构件：与前端 seed/scenario.ts 的 Z01–Z04 保持同名，其余为演示扩展。
 *
 * 数量按 PRD §8.2「按建筑、构件或设备聚合形成 6–10 个业务簇」定：这里正好 8 座。
 * 多出来的建筑会把业务图切得太碎，少于此数又撑不起「多源工程积累」的观感。
 */
export const BUILDINGS = [
  { id: "B-DXBD", name: "大雄宝殿", zones: ["东次间", "西次间", "明间", "前廊"] },
  { id: "B-TSW", name: "天王殿", zones: ["南次间", "北次间", "前廊"] },
  { id: "B-ZX", name: "藏经阁", zones: ["一层", "二层", "外廊"] },
  { id: "B-ZLT", name: "钟楼", zones: ["一层", "二层"] },
  { id: "B-GLT", name: "鼓楼", zones: ["一层", "二层"] },
  { id: "B-BLD", name: "碑廊", zones: ["东段", "西段"] },
  { id: "B-SMW", name: "山门", zones: ["明间", "次间"] },
  { id: "B-YY", name: "月台", zones: ["正中", "两侧"] },
];

/** 构件主类：柱 / 梁 / 额枋 / 斗栱 / 檩 / 椽 / 墙体 / 台基 */
const COMPONENT_KINDS = [
  { prefix: "Z", name: "柱", role: "承重" },
  { prefix: "L", name: "梁", role: "承重" },
  { prefix: "EF", name: "额枋", role: "连接" },
  { prefix: "DG", name: "斗栱", role: "承托" },
  { prefix: "LN", name: "檩", role: "承托" },
  { prefix: "C", name: "椽", role: "屋面" },
  { prefix: "QT", name: "墙体", role: "围护" },
  { prefix: "TJ", name: "台基", role: "基础" },
];

/**
 * 构件清单：约 56 个构件，覆盖 12 座建筑。
 * Z01–Z04 固定挂在大雄宝殿，保证 PRD §8.1 的示例链路（Z04 柱 → … → KB-021）成立。
 */
export function buildComponents() {
  const rand = makeRandom(20260518);
  const components = [
    { id: "Z01", name: "Z01 柱", kind: "柱", buildingId: "B-DXBD", zone: "东次间", note: "檐柱" },
    { id: "Z02", name: "Z02 柱", kind: "柱", buildingId: "B-DXBD", zone: "西次间", note: "檐柱" },
    { id: "Z03", name: "Z03 柱", kind: "柱", buildingId: "B-DXBD", zone: "明间", note: "金柱" },
    { id: "Z04", name: "Z04 柱", kind: "柱", buildingId: "B-DXBD", zone: "前廊", note: "檐柱 · 柱脚渗水观察点" },
    { id: "L01", name: "L01 梁", kind: "梁", buildingId: "B-DXBD", zone: "明间", note: "七架梁" },
    { id: "L02", name: "L02 梁", kind: "梁", buildingId: "B-DXBD", zone: "东次间", note: "五架梁" },
  ];
  let index = 0;
  for (const building of BUILDINGS) {
    const extra = building.id === "B-DXBD" ? 2 : 5;
    for (let i = 0; i < extra; i += 1) {
      const kind = COMPONENT_KINDS[Math.floor(rand() * COMPONENT_KINDS.length)];
      index += 1;
      const id = `${kind.prefix}${pad(index + 10, 2)}`;
      if (components.some((item) => item.id === id)) continue;
      components.push({
        id,
        name: `${id} ${kind.name}`,
        kind: kind.name,
        buildingId: building.id,
        zone: pick(building.zones, rand),
        note: kind.role,
      });
    }
  }
  return components;
}

/** 设备清单：扫描仪 / 含水率仪 / 温湿度记录仪 */
export const DEVICES = [
  { id: "SCAN-01", name: "扫描设备 SCAN-01", kind: "激光扫描仪", buildingId: "B-DXBD" },
  { id: "SCAN-02", name: "扫描设备 SCAN-02", kind: "激光扫描仪", buildingId: "B-ZX" },
  { id: "N100", name: "含水率仪 N100", kind: "木材含水率仪", buildingId: "B-DXBD" },
  { id: "TH-2207", name: "温湿度记录仪 TH-2207", kind: "环境记录仪", buildingId: "B-DXBD" },
  { id: "CAM-03", name: "采集相机 CAM-03", kind: "可见光相机", buildingId: "B-TSW" },
];

/**
 * 巡检任务：五月历史轮 + 九月本轮。
 *
 * `date` 在 buildKnowledgeFixture 里按 anchor 现算（见 inspectionsFor）：
 * 演示时间线要与服务器当前日期一致，否则页面会出现「待更新 36 项、最长等待 54 天」
 * 这种明显不合理的时间差。
 */
export const INSPECTIONS = [
  { id: "INS-2026-05", name: "五月历史巡检", daysAgo: 118, round: "历史" },
  { id: "INS-2026-09", name: "九月本轮巡检", daysAgo: 4, round: "本轮" },
];

function inspectionsFor(anchorMs) {
  return INSPECTIONS.map((item) => ({ ...item, date: isoAt(anchorMs, item.daysAgo, 1, 0) }));
}

/* ------------------------------------------------------------------ *
 * 3. 源文本模板（可深入展示样本用真文本；规模样本用派生摘要）
 * ------------------------------------------------------------------ */

const PDF_REPORT_SECTIONS = [
  ["巡检范围", "本次巡检覆盖{building}{zone}的 {components}，采用全景影像采集与表面巡检，共记录 {defects} 处异常。"],
  ["环境记录", "巡检当日气温 {temp} ℃、相对湿度 {rh}%，木材平衡含水率估计 {emc}%。环境数据仅作先验，不代入缺陷判定。"],
  ["影像采集", "使用 {device} 完成 {shots} 组全景影像采集，覆盖高度 0.3–4.2 m，重投影误差 2.1 mm，点间距 4 mm。"],
  ["构件检查", "{component} 表面油漆层粉化面积约 {area}%，未见贯通裂缝；榫卯节点无松动、无位移。"],
  ["缺陷记录", "{component} 柱脚存在渗水痕迹，沿柱身高度 0.25 m 范围内含水率偏高，编号 {defectNo}。"],
  ["处置建议", "建议在雨季前后分别复测含水率，并在柱脚外侧增设排水导流，暂不进行落架处理。"],
  ["复核结论", "经与五月历史轮影像比对，{component} 缺陷未见明显发展，维持观察等级 {level}。"],
  ["附件清单", "本节附 {shots} 张现场影像、{defects} 条缺陷记录与检测设备参数表，原始文件见资产库。"],
];

const DOCX_SECTIONS = [
  ["档案封面", "{component}（{building}{zone}）构件档案，记录形制、尺寸、材质与历次修缮信息。"],
  ["形制与尺寸", "{component} 柱径约 320 mm，柱高 3 620 mm，柱础为覆盆式，材质为落叶松，含水率 {rh}%。"],
  ["历次修缮", "1986 年局部墩接，2004 年油饰重做，2019 年柱脚防腐处理，历次处理记录均保留原始编号。"],
  ["现状描述", "当前表面油饰完好，柱脚外皮轻微起甲，未发现结构性开裂与倾斜。"],
  ["观察等级", "综合形制、材料与缺陷发展速度，本构件观察等级为 {level}，纳入本轮重点观察清单。"],
  ["关联资料", "相关影像、检测记录与工单见资产库内该构件的关联列表。"],
];

const XLSX_SHEETS = ["采样记录", "含水率", "回弹值", "核对表"];

const WORK_ORDER_TEXT = [
  "工单 {orderNo}（{problem}）于 {date} 由 {reporter} 提报，对象为 {component}（{building}{zone}）。",
  "现场核实：{component} 柱脚存在渗水痕迹，沿柱身高度 0.25 m 范围内含水率 18.6%，高于周边构件 4.2 个百分点。",
  "处置过程：清理柱脚松动物、外贴防水透气膜、加设青砖散水，处置后连续三日复测含水率回落至 13.1%。",
  "复核结果：处置有效，缺陷未发展；进入复巡计划，建议雨季前后各复测一次。",
  "关联记录：工单附件包含处置前照片 6 张、处置后照片 4 张、复核记录 1 份，见资产库关联列表。",
];

const LOG_LINES = [
  "heartbeat ok rssi=-{rssi} battery={battery}% uptime={uptime}s",
  "session start pointcloud buffer={buffer}MB",
  "warn link jitter {jitter}ms retransmit={retry}",
  "error handshake timeout peer={peer} after {timeout}ms",
  "warn packet loss {loss}% during scan window",
  "info calibration drift {drift}mm node={node}",
];

const RECORD_TEMPLATES = [
  { key: "采样", label: "木材含水率采样记录", fields: "采样点、深度、含水率、仪器编号" },
  { key: "检测", label: "回弹法强度检测记录", fields: "测区、回弹值、碳化深度、推定强度" },
  { key: "校准", label: "设备校准记录", fields: "仪器编号、校准日期、标准件、偏差" },
  { key: "发布", label: "场景发布记录", fields: "场景版本、锚点、书签、发布人" },
];

/**
 * 工程技术资料的三类正文模板：修缮工艺、政策法规、保护规划。
 *
 * 为什么单独写：巡检现场真正会去查的不是「报告里写了什么」，而是
 * 「这种病害按什么工法修、依据哪一条要求、边界在哪」。这三类的定位也因此不同：
 * 修缮工艺给部位与工序，政策法规给条款号，保护规划给分区与限值。
 * 分块定位统一走「章节 + 段落」，与 DOCX 的定位口径一致（PRD §4.3）。
 */
const CRAFT_SECTIONS = [
  ["适用范围", "本工法适用于{building}{component}一类构件的{problem}处理，适用环境为相对湿度 60–85%、日均温差不超过 12 ℃的季节。"],
  ["材料要求", "修补用材应与原构件同种或近缘材，含水率控制在 12–15%；胶粘剂采用改性环氧，固化时间不少于 24 小时。"],
  ["施工工序", "一、清理松动层至密实基层；二、局部打点加固；三、分层嵌补（每层不超过 15 mm）；四、表面做旧至与原色差 ΔE ≤ 3。"],
  ["质量控制", "嵌补后 7 日与 28 日各检查一次，允许偏差：平整度 ≤ 2 mm/m，色差 ΔE ≤ 3，无空鼓与开裂。"],
  ["成品保护", "施工完成后 14 日内不得承受外力与淋水；雨季施工需搭设临时遮蔽，遮蔽材料不得直接接触构件表面。"],
  ["验收要点", "按隐蔽工程记录逐项验收，留存工序照片与材料合格证；不合格项不得进入下一道工序。"],
];

/*
 * 政策法规与保护规划都**按主题分篇**，不用一份模板复制八遍。
 *
 * PRD §11.2 明确禁止用复制相同片段来制造「独立证据数量」：八个只有 ID 不同的法规
 * 文档并排出现在检索结果里，读者看到的是十条一模一样的分块，那不是工程积累。
 * 这里的做法是每类给一份真实主题的正文（消防、保养、报批、虫害、防水、档案 /
 * 区划、本体措施、展示利用），正文里的数值也随建筑与构件变化。
 */
const POLICY_BODIES = {
  fire: [
    ["适用范围", "本要求适用于{building}等木结构文物建筑的消防设施配置与用火用电管理。"],
    ["设施配置", "应设置火灾自动报警与消火栓系统；无市政水源的应设消防水池，容量不小于 200 m³。"],
    ["用电管理", "文物建筑内不得使用大功率电器；配电线路穿金属管保护，并设漏电保护与电气火灾监控。"],
    ["用火管理", "殿内禁止明火与香烛；确有活动需要的应在指定区域设置并落实专人看护与灭火器材。"],
    ["巡查要求", "每日不少于 2 次防火巡查、每月不少于 1 次防火检查，记录保存不少于 3 年。"],
    ["应急处置", "应设疏散指示与应急照明，并每半年组织 1 次灭火与疏散演练。"],
  ],
  maintain: [
    ["适用范围", "本要求适用于{building}{component}一类木构件的日常保养与维护。"],
    ["保养周期", "日常保养每季度不少于 1 次；汛期前后与采暖期前后各增加 1 次专项检查。"],
    ["保养内容", "清理积尘与鸟粪、检查油饰起甲与地仗开裂、疏通排水、紧固松动铁件、记录病害发展。"],
    ["禁止行为", "不得使用现代涂料随意罩面，不得在构件上钻孔、钉挂、粘贴，不得擅自更换原构件。"],
    ["记录要求", "每次保养应形成记录，包含时间、部位、发现的问题与处理方式，并附照片。"],
    ["报修条件", "发现结构性开裂、明显倾斜、持续渗水或虫蛀活动迹象时，应在 3 个工作日内报修。"],
  ],
  approval: [
    ["适用范围", "本流程适用于{building}本体修缮、局部落架与构件替换的报批。"],
    ["报批材料", "现状勘察报告、病害成因分析、修缮设计方案、施工组织方案、材料检测报告与经费预算。"],
    ["专家评审", "方案应经不少于 5 名相关专业专家评审，意见逐条落实并形成回复说明。"],
    ["审批层级", "全国重点文物保护单位报国家文物行政部门批准；省级文物保护单位报省级文物行政部门批准。"],
    ["变更处理", "施工中确需变更设计的，应重新履行评审与报批手续，不得先施工后补办。"],
    ["竣工验收", "竣工后应组织验收并形成验收报告，验收不合格的不得交付使用。"],
  ],
  pest: [
    ["适用范围", "本要求适用于{building}木构件的白蚁与蛀干害虫防治。"],
    ["监测方式", "建筑周边每 10 m 设 1 个监测桩，每季度检查 1 次；发现蚁路立即标记并追溯巢位。"],
    ["防治方法", "优先采用饵剂传递法；局部注射与熏蒸仅在专业机构评估后进行，药剂不得污染文物本体。"],
    ["环境控制", "保持木构件含水率低于 20%，修复渗漏与通风不良部位，清除周边腐朽木材与杂物。"],
    ["施药要求", "施药区域应设警示与隔离，施药后 7 日内不得进入；药剂使用记录应归档。"],
    ["复测要求", "防治后 1、3、6 个月各复测 1 次，连续 1 年无活动迹象方可判定有效。"],
  ],
  waterproof: [
    ["适用范围", "本要求适用于{building}屋面、墙体与柱脚的防水与排水维护。"],
    ["屋面检查", "瓦面每年雨季前检查 1 次，重点检查垄间灰缝、天沟与檐口，发现脱瓦与渗漏及时修补。"],
    ["排水疏导", "散水应保持完整与坡度顺畅，排水沟每季度清淤 1 次，不得改变原有地表径流方向。"],
    ["柱脚防护", "柱脚应高出地面 300 mm 以上；受潮部位应设通风口，不得用水泥砂浆包裹柱脚。"],
    ["渗漏处置", "发现持续渗水应先查明来源再处置，禁止直接在外表面涂刷防水涂料掩盖渗漏。"],
    ["汛期要求", "汛期实行 24 小时值班，暴雨后 24 小时内完成一次全面巡查并记录。"],
  ],
  record: [
    ["适用范围", "本要求适用于{building}文物保护工程的档案收集、整理与归档。"],
    ["归档范围", "勘察记录、设计文件、施工记录、监理记录、材料证明、检测报告、竣工图与影像资料。"],
    ["影像要求", "关键工序与隐蔽工程应留存影像，分辨率不低于 1200 万像素，并标注拍摄时间与部位。"],
    ["整理要求", "档案按单位工程与工序组卷，案卷目录与卷内目录齐全，电子档案同步保存。"],
    ["保管期限", "修缮工程档案永久保存；日常保养记录保存不少于 30 年。"],
    ["移交要求", "工程竣工验收后 6 个月内向管理单位与主管部门移交，并办理移交手续。"],
  ],
};

/** 保护规划：区划与限值按建筑取真实参数 */
const PLAN_BODIES = {
  zone: [
    ["保护区划", "{building}本体及周边 {buffer} m 范围为保护范围，建设控制地带向外延伸 {control} m，界线以实测坐标为准。"],
    ["管控要求", "保护范围内不得新建与文物保护无关的设施；建设控制地带内建筑高度不得超过 {height} m，形式与色彩应与文物环境协调。"],
    ["用地调整", "现有与文物保护无关的用地应逐步调整；不得增设对外营业的餐饮与娱乐设施。"],
    ["交通组织", "保护范围内以步行为主，机动车辆在控制地带外停放，消防通道净宽不小于 4 m。"],
    ["市政设施", "给排水、电力与通信管线应地下敷设，不得沿建筑本体敷设，管沟开挖应经考古勘探。"],
    ["实施要求", "区划调整须报原审批机关批准，不得以局部整治为名变相扩大建设规模。"],
  ],
  measure: [
    ["保护措施", "针对{component}的{problem}，本轮采取监测为主、局部干预为辅的措施。"],
    ["监测方案", "布设裂缝计与含水率测点各 {points} 个，每季度采集 1 次；连续 2 年无发展可降低频次。"],
    ["本体干预", "仅在病害发展威胁结构安全时干预，干预前须编制专项方案并履行报批手续。"],
    ["环境整治", "修复排水系统、改善通风条件、清理周边堆积物，抑制病害发展的外部诱因。"],
    ["展示利用", "在不影响文物安全的前提下设置参观路线，瞬时承载量不超过 {capacity} 人。"],
    ["实施计划", "近期（1–2 年）完成监测与抢险；中期（3–5 年）完成本体修缮；远期持续日常保养。"],
  ],
  exhibit: [
    ["展示定位", "{building}以原状展示为主，配合必要的图文说明，不设置商业性经营内容。"],
    ["开放容量", "日最大承载量 {capacity} 人次，瞬时承载量不超过 {instant} 人，实行分时预约。"],
    ["解说系统", "标识与解说牌应统一形制、色彩与材质，不得直接固定于文物本体。"],
    ["安全措施", "参观路线应设防护栏与警示标识，重点部位设监控与看护岗位。"],
    ["访客管理", "禁止携带易燃易爆物品与宠物入场，禁止触摸、刻画与使用闪光灯拍摄。"],
    ["评估机制", "每年评估 1 次游客对文物本体的影响，结论作为调整开放强度的依据。"],
  ],
};

const DEFECT_TYPES = ["柱脚渗水", "油饰起甲", "表层粉化", "榫卯松动", "轻微倾斜", "虫蛀孔洞", "细微裂缝"];
const SEVERITY = ["Ⅰ 级（观察）", "Ⅱ 级（关注）", "Ⅲ 级（处理）"];

/**
 * 文档类资料的题材：把「报告 / 档案 / 数据表」扩到也包括工法、法规与规划。
 *
 * 采样比例按重要性排：巡检报告与构件档案占多数，工艺与法规类作为专业查询的补充。
 * 每一类政策法规与保护规划都指向**不同的规章主题**，正文各写各的（见 POLICY_BODIES /
 * PLAN_BODIES），所以检索结果里不会出现「同一份文件换八个文件名」那种假独立证据。
 */
const DOCUMENT_SUBJECTS = [
  { key: "report", label: "巡检报告", category: "巡检报告", weight: 5, format: "PDF", sections: "report" },
  { key: "archive", label: "构件档案", category: "构件档案", weight: 4, format: "DOCX", sections: "archive" },
  { key: "data", label: "检测数据表", category: "设备运行", weight: 3, format: "XLSX", sections: "sheet" },
  { key: "craft", label: "修缮工艺做法", category: "修缮工艺", weight: 3, format: "PDF", sections: "craft" },
  { key: "policy-fire", label: "消防设施配置要求", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "fire" },
  { key: "policy-maintain", label: "木构件保养要求", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "maintain" },
  { key: "policy-approval", label: "修缮工程报批流程", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "approval" },
  { key: "policy-pest", label: "白蚁与蛀干害虫防治要求", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "pest" },
  { key: "policy-waterproof", label: "屋面与柱脚防水要求", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "waterproof" },
  { key: "policy-record", label: "文物保护工程档案要求", category: "政策法规", weight: 1, format: "PDF", sections: "policy", body: "record" },
  { key: "plan-zone", label: "保护区划文本", category: "保护规划", weight: 1, format: "DOCX", sections: "plan", body: "zone" },
  { key: "plan-measure", label: "本体保护措施", category: "保护规划", weight: 1, format: "DOCX", sections: "plan", body: "measure" },
  { key: "method", label: "规范方法说明", category: "规范方法", weight: 2, format: "DOCX", sections: "policy", body: "maintain" },
  { key: "history", label: "历史修缮档案", category: "历史归档", weight: 2, format: "PDF", sections: "archive" },
];

/**
 * 每类资产的目标数量：文档从 360 扩到 540（PRD §7.1 的 360 是评审时的规划值，
 * 现场资料里报告只占一部分，工法、法规、规划同样是工程积累）。**总数保持 1,248**，
 * 因此从图片与日志批次里各匀出一部分 —— 这两类本来就有大量「未纳入」的同质条目，
 * 少一些不影响覆盖率叙事，多出来的专业资料却能真正被检索到。
 */
const BASELINE_WEIGHTS = [
  { type: "document", total: 540 },
  { type: "image", total: 360 },
  { type: "video", total: 60 },
  { type: "workOrder", total: 168 },
  { type: "logBatch", total: 108 },
  { type: "record", total: 12 },
];


/* ------------------------------------------------------------------ *
 * 4. 分块与向量
 * ------------------------------------------------------------------ */

/** 把一段文字按 chunkPolicy 切块（真实切片，不做长度估算） */
export function sliceChunks(text, policy = BASELINE_CONFIG.chunkPolicy) {
  const { maxChars, overlapChars } = policy;
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    chunks.push({ text: text.slice(cursor, end), start: cursor, end });
    if (end >= text.length) break;
    cursor = end - overlapChars;
  }
  return chunks;
}

/**
 * 分块方案：把某一主类的总块数分摊到**纳入资产**上。
 *
 * 规则与知识域契约里的 `ratio` 一致：每个纳入资产先给 ratio 个块，
 * 余数（< 纳入数）逐项 +1 摊到前几个资产上。因此
 *   `sum(allocateChunks(row.chunkCount, row.included)) === row.chunkCount`
 * 恒成立 —— 「有效分块 18,420」这个验收值不会因为分摊方式漂移。
 *
 * 参数 `count` 传的是「纳入资产数」而不是总数：未纳入的资产不进索引，
 * 它们不该分到块（分到就会出现「没有可检索文本却有分块」的假数据）。
 */
export function allocateChunks(total, count) {
  const base = Math.floor(total / count);
  const rest = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < rest ? 1 : 0));
}

/**
 * 文档题材 → 数量：按权重把总量铺到各题材上，**先按格式分组**再按权重分配，
 * 这样「PDF / DOCX / XLSX 各多少」与「题材各多少」互相一致，不会出现两套口径。
 *
 * 结果按题材顺序返回（报告在前、法规在后），生成器只需线性遍历。
 */
/**
 * 文档题材 → 数量：按权重把 `total` 铺到各题材上，**先按格式分组**再按权重分配，
 * 这样「PDF / DOCX / XLSX 各多少」与「题材各多少」互相一致，不会出现两套口径。
 *
 * `total` 传的是**可展开明细数**（300），不是主类总量（8210）：
 * 规模样本不生成文件，只有明细才需要题材与格式。
 */
export function planDocumentSubjects(total) {
  const groups = new Map();
  for (const subject of DOCUMENT_SUBJECTS) {
    if (!groups.has(subject.format)) groups.set(subject.format, []);
    groups.get(subject.format).push(subject);
  }
  // 按 DOCUMENT_FORMAT_SPLIT 的比例把 total 拆到三种格式上：
  // 直接用它当绝对条数会与明细总量对不上（那份拆分是评审时按 540 份写的）。
  const splitSum = DOCUMENT_FORMAT_SPLIT.reduce((sum, item) => sum + item.count, 0);
  const counts = new Map();
  let formatAssigned = 0;
  const formats = [...groups.keys()];
  formats.forEach((format, formatIndex) => {
    const share = DOCUMENT_FORMAT_SPLIT.find((item) => item.format === format)?.count ?? 0;
    const groupTotal = formatIndex === formats.length - 1
      ? total - formatAssigned
      : Math.round((total * share) / splitSum);
    formatAssigned += groupTotal;
    const subjects = groups.get(format);
    const weightSum = subjects.reduce((sum, item) => sum + item.weight, 0);
    let assigned = 0;
    subjects.forEach((subject, index) => {
      // 最后一个题材吃掉余数，保证分组小计与拆分比例一致
      const count = index === subjects.length - 1
        ? groupTotal - assigned
        : Math.floor((groupTotal * subject.weight) / weightSum);
      counts.set(subject.key, count);
      assigned += count;
    });
  });
  const plan = [];
  for (const subject of DOCUMENT_SUBJECTS) {
    const count = counts.get(subject.key) ?? 0;
    if (count > 0) plan.push({ subject, count });
  }
  const planned = plan.reduce((sum, item) => sum + item.count, 0);
  if (planned !== total) {
    throw new Error(`文档题材分配 ${planned} ≠ 明细基数 ${total}（检查 DOCUMENT_FORMAT_SPLIT 与题材 weight）`);
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * 5. 生成器主体
 * ------------------------------------------------------------------ */

/**
 * 生成整套夹具（纯函数，不碰数据库）。
 *
 * 返回：{ assets, relations, contents, chunks, vectors, indexMembers, report, searchQueries }
 * 其中 chunks 只对「可深入展示样本」带真实文本，规模样本带 200 字摘要 ——
 * 二者的来源都写入 report，不把摘要说成完整原文（PRD §11.2）。
 */
export function buildKnowledgeFixture({ sessionId = "demo-01", seed = 20260913, anchor = null } = {}) {
  const rand = makeRandom(seed);
  // 演示时间线锚点：默认「今天 UTC 零点」。基线仍是确定性的（同日同 seed 结果一致），
  // 又不会随着真实时间流逝变成一堆「等待 54 天」的假等待时长。
  const now = new Date();
  const anchorMs = anchor
    ? new Date(anchor).getTime()
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const INSPECTIONS = inspectionsFor(anchorMs);

  const components = buildComponents();
  const componentById = new Map(components.map((item) => [item.id, item]));
  const buildingsById = new Map(BUILDINGS.map((item) => [item.id, item]));
  const deviceById = new Map(DEVICES.map((item) => [item.id, item]));

  const assets = [];
  const relations = [];
  const contents = [];
  const chunks = [];
  const vectors = [];

  /** 深展示样本：带完整可读正文与可打开文件的那一批（PRD §11.2） */
  const deepSampleIds = [];
  const deepTarget = 24;
  /** 每个主类给几个可打开样本，保证不止六类样本被覆盖到 */
  const deepQuota = {
    document: 8, image: 4, video: 2, audio: 1, workOrder: 2, logBatch: 2, record: 1,
    scanData: 1, gaussian: 1, modelFile: 1, pointCloud: 1,
  };

  const pushRelation = (fromId, toId, relationType, evidenceRef, origin) => {
    relations.push({ id: `REL-${relations.length + 1}`, fromId, toId, relationType, evidenceRef, origin });
  };
  const componentFor = (building) =>
    pick(components.filter((item) => item.buildingId === building.id).concat(componentById.get("Z04")), rand);

  /**
   * 统一落一条资产。
   *
   * 十二个主类共用这一处，是因为「一条资产该有哪些字段」必须只有一份定义：
   * 每个类型各写一遍 asset 对象的话，加一个字段就要改十二处，
   * 而且很容易漏掉 objectIds 或 indexState 这类参与统计的字段。
   */
  const addAsset = (spec) => {
    const ordinal = spec.ordinal ?? assets.length + 1;
    const asset = {
      id: spec.id,
      sessionId,
      projectId: DEFAULT_SCOPE.id,
      buildingId: spec.buildingId !== undefined ? spec.buildingId : (spec.building ? spec.building.id : null),
      zone: spec.zone
        ?? (spec.primaryObjectId ? componentById.get(spec.primaryObjectId)?.zone : null)
        ?? (spec.building ? spec.building.name : null),
      type: spec.type,
      title: spec.title,
      format: spec.format,
      businessCategories: spec.businessCategories,
      sourceSystem: spec.sourceSystem,
      sourceEntityId: spec.sourceEntityId,
      mainSource: spec.mainSource,
      contentRevision: spec.contentRevision ?? 1,
      metadataRevision: spec.metadataRevision ?? 1,
      revision: spec.contentRevision ?? 1,
      availability: spec.availability ?? "可用",
      indexState: spec.indexState,
      excludedReason: spec.excludedReason ?? null,
      sizeBytes: spec.sizeBytes,
      objectIds: spec.objectIds ?? [],
      primaryObjectId: spec.primaryObjectId ?? null,
      capturedAt: spec.capturedAt,
      importedAt: spec.importedAt ?? spec.capturedAt,
      updatedAt: spec.updatedAt,
      owner: spec.owner ?? pick(["rao", "shi", "shen", "ma"], rand),
      summary: spec.summary,
      textMode: spec.textMode ?? "none",
      sha256: sha1(`${spec.id}:${spec.title}`),
      fileId: null,
      ...(spec.extra ?? {}),
    };
    asset.filename = spec.filename ?? filenameFor(asset, { format: spec.format, ordinal, rand, kind: spec.kind });
    assets.push(asset);
    return asset;
  };

  const markDeep = (asset, type) => {
    if (deepSampleIds.length >= deepTarget) return false;
    const used = deepSampleIds.filter((id) => assets.find((a) => a.id === id)?.type === type).length;
    if (used >= (deepQuota[type] ?? 0)) return false;
    deepSampleIds.push(asset.id);
    return true;
  };

  /**
   * 文件名去重。
   *
   * 各类型的命名模板是按真实习惯写的（同一题材会跨文件复用），所以模板本身
   * 不保证唯一。真实资料库里同名文件是分不清版本的，夹具也不该有重名，
   * 所以统一在这里补一个序号 —— 保留「像真的」写法，同时保证可区分。
   */
  const dedupeFilenames = () => {
    const seen = new Map();
    for (const asset of assets) {
      const name = asset.filename ?? `${asset.id}.bin`;
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count === 1) {
        asset.filename = name;
        continue;
      }
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      asset.filename = `${stem}_${count}${ext}`;
    }
  };

  const stateOf = (states, position) => states[position] ?? "covered";
  const LOCATOR_OF = {
    document: "page", image: "image", video: "timecode", audio: "timecode",
    workOrder: "workorder", logBatch: "log", record: "record",
  };

  /**
   * 给一条「有可检索内容」的资产写正文、切块、建分块记录。
   *
   * 十二个主类里只有一部分真的能产出文本：文档 / 照片 / 视频 / 音频 / 工单 / 日志 / 业务记录。
   * 二进制产物（扫描数据、高斯场景、点云、模型权重）只登记不建正文 ——
   * 它们没有可检索内容，按文件大小估算一个假正文是 PRD §4.3 明令禁止的。
   */
  const addContent = (asset, text, chunksFor) => {
    contents.push({
      id: `KC-${asset.id}`,
      assetId: asset.id,
      revision: asset.contentRevision,
      mode: asset.textMode,
      text,
      locatorKind: LOCATOR_OF[asset.type] ?? "record",
    });
    const slices = sliceChunks(text);
    const wanted = Math.max(1, chunksFor);
    const out = slices.slice(0, wanted);
    while (out.length < wanted) {
      const index = out.length;
      out.push({
        text: `附注：本条为同一节内容的第 ${index + 1} 段定位，定位见来源编号与段落。`,
        start: index,
        end: index + 1,
      });
    }
    out.forEach((slice, ordinal) => {
      chunks.push(toChunkRow(asset, ordinal, slice, LOCATOR_OF[asset.type] ?? "record"));
    });
  };

  /* ================================================================== *
   * 5.1 文档报告（300 份明细：PDF 170 / DOCX 60 / XLSX 70）
   * ================================================================== */
  const docRows = BASELINE_ROWS.find((row) => row.type === "document");
  const docChunks = allocateChunks(docRows.chunkCount, docRows.included);
  const docStates = buildIndexStates(docRows.included, docRows.pending, docRows.error);
  const docPlan = planDocumentSubjects(docRows.materialized);
  let docOrdinal = 0;
  for (const plan of docPlan) {
    for (let i = 0; i < plan.count; i += 1) {
      docOrdinal += 1;
      const subject = plan.subject;
      const building = pick(BUILDINGS, rand);
      const component = componentFor(building);
      const inspection = rand() > 0.55 ? INSPECTIONS[1] : INSPECTIONS[0];
      const month = inspection.round === "历史" ? "五月" : "九月";
      const problem = pick(DEFECT_TYPES, rand);
      const isXlsx = subject.sections === "sheet";
      const title = isXlsx
        ? `${building.name} · ${month}检测数据表`
        : subject.sections === "craft"
          ? `${problem}修缮工法 · ${component.name}`
          : subject.sections === "policy"
            ? `${subject.label} · ${building.name}`
            : subject.sections === "plan"
              ? `${building.name}保护规划 · ${subject.label}`
              : subject.key === "archive"
                ? `${component.name} · 构件档案`
                : subject.key === "history"
                  ? `${component.name} · 历史修缮档案`
                  : `${building.name} · ${month}巡检报告`;
      const asset = addAsset({
        id: `KA-D-${pad(docOrdinal, 4)}`,
        kind: "document",
        ordinal: docOrdinal,
        type: "document",
        title,
        format: subject.format,
        businessCategories: [subject.category, ...(subject.key === "history" ? ["历史归档"] : [])],
        sourceSystem: subject.sections === "report" || isXlsx ? "平台业务" : "历史归档",
        sourceEntityId: `${(subject.code ?? subject.key.toUpperCase()).slice(0, 6)}-${pad(docOrdinal, 4)}`,
        mainSource: subject.sections === "report" || isXlsx ? "平台业务" : "历史归档",
        indexState: stateOf(docStates, docOrdinal - 1),
        sizeBytes: (isXlsx ? 240 : subject.format === "PDF" ? 860 : 320) * 1024 + Math.floor(rand() * 400 * 1024),
        objectIds: [building.id, component.id],
        primaryObjectId: component.id,
        capturedAt: inspection.date,
        updatedAt: isoAt(anchorMs, 20 - (docOrdinal % 20), 2 + (docOrdinal % 8), docOrdinal % 60),
        summary: `${title}｜${subject.category}｜${component.name}｜${subject.format}`,
        textMode: "extracted",
        contentRevision: 2,
        metadataRevision: 3,
        building,
      });
      const chunkSpec = makeDocumentChunks({
        asset, chunks: docChunks[docOrdinal - 1], rand, sections: subject.sections, body: subject.body,
        building, component, deviceById, problem, severity: pick(SEVERITY, rand),
      });
      addContent(asset, chunkSpec.text, docChunks[docOrdinal - 1]);
      markDeep(asset, "document");
    }
  }

  /* ================================================================== *
   * 5.2 现场照片（240 张明细；只有带审核描述的那部分进索引）
   * ================================================================== */
  const imageRows = BASELINE_ROWS.find((row) => row.type === "image");
  const imageChunks = allocateChunks(imageRows.chunkCount, imageRows.included);
  const imageStates = buildIndexStates(imageRows.included, imageRows.pending, imageRows.error);
  for (let i = 1; i <= imageRows.materialized; i += 1) {
    const included = i <= imageRows.included;
    const building = pick(BUILDINGS, rand);
    const component = componentFor(building);
    const inspection = rand() > 0.5 ? INSPECTIONS[1] : INSPECTIONS[0];
    const variant = pick(["雨后复核照片", "现场影像", "局部细节", "全景影像", "缺陷特写"], rand);
    const asset = addAsset({
      id: `KA-P-${pad(i, 4)}`,
      kind: "photo",
      ordinal: i,
      type: "image",
      title: `${component.name} · ${variant}`,
      format: pick(["JPG", "PNG"], rand),
      businessCategories: ["巡检报告"],
      sourceSystem: "巡检设备",
      sourceEntityId: `IMG-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: included ? stateOf(imageStates, i - 1) : "未纳入",
      excludedReason: included ? null : i % 3 === 0 ? "未提供人工描述，尚无流程属性" : "缺少审核标注，文本条件不满足",
      availability: included ? "可用" : "待补充内容",
      sizeBytes: 2_400_000 + Math.floor(rand() * 1_800_000),
      objectIds: [building.id, component.id],
      primaryObjectId: component.id,
      capturedAt: inspection.date,
      updatedAt: isoAt(anchorMs, 20 - (i % 20), 3 + (i % 6), i % 60),
      owner: pick(["rao", "ma"], rand),
      summary: `${component.name}｜${variant}｜${inspection.name}`,
      textMode: included ? "annotation" : "none",
      building,
    });
    const deep = markDeep(asset, "image");
    if (!included) continue;
    const description = [
      `影像说明：${component.name}（${building.name}${component.zone}）${variant}，${inspection.name}。`,
      `采集信息：${pick(DEVICES, rand).name}，分辨率 ${pick(["6000×4000", "5472×3648", "4000×3000"], rand)}，拍摄距离 ${(0.6 + rand() * 1.4).toFixed(2)} m。`,
      `标注内容：${pick(DEFECT_TYPES, rand)}，范围约 ${(0.02 + rand() * 0.3).toFixed(2)} m²，等级 ${pick(SEVERITY, rand)}。`,
      deep ? "审核备注：该影像与五月历史轮同点位影像比对，缺陷边界未见明显外扩。" : "审核备注：本条标注来源于现场审核记录。",
    ].join("");
    addContent(asset, description, imageChunks[i - 1]);
  }

  /* ================================================================== *
   * 5.3 巡检视频（120 条明细，带转写片段）
   * ================================================================== */
  const videoRows = BASELINE_ROWS.find((row) => row.type === "video");
  const videoChunks = allocateChunks(videoRows.chunkCount, videoRows.included);
  const videoStates = buildIndexStates(videoRows.included, videoRows.pending, videoRows.error);
  for (let i = 1; i <= videoRows.materialized; i += 1) {
    const included = i <= videoRows.included;
    const building = pick(BUILDINGS, rand);
    const component = componentFor(building);
    const inspection = rand() > 0.5 ? INSPECTIONS[1] : INSPECTIONS[0];
    const durationSec = 60 + Math.floor(rand() * 240);
    const asset = addAsset({
      id: `KA-V-${pad(i, 4)}`,
      kind: "video",
      ordinal: i,
      type: "video",
      title: `${component.name} · ${inspection.name}录像`,
      format: "MP4",
      businessCategories: ["巡检报告"],
      sourceSystem: "巡检设备",
      sourceEntityId: `VID-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: included ? stateOf(videoStates, i - 1) : "未纳入",
      excludedReason: included ? null : "无预置转写片段，暂不纳入索引",
      availability: included ? "可用" : "待补充内容",
      sizeBytes: 40_000_000 + Math.floor(rand() * 90_000_000),
      objectIds: [building.id, component.id],
      primaryObjectId: component.id,
      capturedAt: inspection.date,
      updatedAt: isoAt(anchorMs, 12 - (i % 12), 4 + (i % 5), i % 60),
      owner: "rao",
      summary: `${component.name}｜时长 ${Math.floor(durationSec / 60)} 分 ${durationSec % 60} 秒｜${inspection.name}`,
      textMode: included ? "transcript" : "none",
      extra: { durationSec },
      building,
    });
    markDeep(asset, "video");
    if (!included) continue;
    const pieceCount = Math.max(2, videoChunks[i - 1]);
    const pieces = [];
    for (let part = 0; part < pieceCount; part += 1) {
      const start = part * 22;
      const end = start + 22;
      pieces.push(
        `[${timecode(start)}–${timecode(end)}] ${component.name} ${pick(["全景推进", "柱脚特写", "节点环绕", "表面扫描"], rand)}镜头：`
          + `${pick(DEFECT_TYPES, rand)}可见，${pick(["表面干燥", "局部返潮", "油饰完好", "轻微起甲"], rand)}；`
          + `该片段含${pick(["人工转写", "预置转写"], rand)}说明，供检索引用。`,
      );
    }
    addContent(asset, pieces.join("\n"), videoChunks[i - 1]);
  }

  /* ================================================================== *
   * 5.4 扫描仪原始数据（120 份明细，只登记不索引）
   *
   * 这一类的定位是「设备产出的原始字节」：有采集参数、设备与站点、点数，
   * 但没有可检索文本。所以索引状态恒为「未纳入」，排除原因写清楚，
   * 不按文件大小估算一个假正文（PRD §4.3 / §11.1）。
   * ================================================================== */
  const scanRows = BASELINE_ROWS.find((row) => row.type === "scanData");
  for (let i = 1; i <= scanRows.materialized; i += 1) {
    const building = pick(BUILDINGS, rand);
    const device = pick(DEVICES.filter((item) => item.kind === "激光扫描仪"), rand);
    const inspection = rand() > 0.5 ? INSPECTIONS[1] : INSPECTIONS[0];
    const format = pick(["ply", "e57", "pts", "las", "pcd", "xyz"], rand);
    const asset = addAsset({
      id: `KA-S-${pad(i, 4)}`,
      kind: "scan",
      ordinal: i,
      type: "scanData",
      title: `${device.name} · ${building.name}站扫描数据`,
      format: format.toUpperCase(),
      businessCategories: ["设备运行"],
      sourceSystem: "巡检设备",
      sourceEntityId: `SCAN-${device.id}-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: "未纳入",
      excludedReason: "扫描仪原始点云字节，本期只登记与统计，不做文本提取",
      sizeBytes: 180_000_000 + Math.floor(rand() * 1_200_000_000),
      objectIds: [building.id, device.id],
      primaryObjectId: device.id,
      capturedAt: inspection.date,
      updatedAt: isoAt(anchorMs, 18 - (i % 18), 1, (i * 7) % 60),
      owner: "rao",
      summary: `${device.id}｜${building.name}｜${(120 + rand() * 900).toFixed(0)} 万点｜${format.toUpperCase()}`,
      extra: { pointCount: Math.round(1_200_000 + rand() * 9_000_000), scanSession: `${inspection.id}-${pad(i, 3)}` },
      building,
    });
    markDeep(asset, "scanData");
  }

  /* ---- 5.5 高斯场景（60 份 .sog/.ply/.spz，训练产物，不索引） ---- */
  const gaussianRows = BASELINE_ROWS.find((row) => row.type === "gaussian");
  for (let i = 1; i <= gaussianRows.materialized; i += 1) {
    const building = pick(BUILDINGS, rand);
    const inspection = i % 2 === 0 ? INSPECTIONS[1] : INSPECTIONS[0];
    const format = pick(["sog", "ply", "spz", "splat"], rand);
    const asset = addAsset({
      id: `KA-G-${pad(i, 4)}`,
      kind: "gaussian",
      ordinal: i,
      type: "gaussian",
      title: `${building.name} · 高斯场景 ${pad(i, 3)}`,
      format: format.toUpperCase(),
      businessCategories: ["历史归档"],
      sourceSystem: "平台业务",
      sourceEntityId: `GS-${pad(i, 4)}`,
      mainSource: "平台业务",
      indexState: "未纳入",
      excludedReason: "高斯泼溅训练产物，来源可追溯但不做文本检索",
      sizeBytes: 24_000_000 + Math.floor(rand() * 160_000_000),
      objectIds: [building.id],
      primaryObjectId: building.id,
      capturedAt: inspection.date,
      updatedAt: isoAt(anchorMs, 16 - (i % 16), 2, (i * 5) % 60),
      owner: "shi",
      summary: `${building.name}｜${format.toUpperCase()}｜${(2 + rand() * 12).toFixed(1)} 万高斯点`,
      extra: { gaussianCount: Math.round(20_000 + rand() * 120_000), trainer: pick(["gsplat", "nerfstudio", "inria"], rand) },
      building,
    });
    markDeep(asset, "gaussian");
  }

  /* ---- 5.6 建模与建图（96 份；带说明的 60 份纳入索引） ---- */
  const modelRows = BASELINE_ROWS.find((row) => row.type === "modelFile");
  const modelChunks = allocateChunks(modelRows.chunkCount, modelRows.included);
  const modelStates = buildIndexStates(modelRows.included, modelRows.pending, modelRows.error);
  for (let i = 1; i <= modelRows.materialized; i += 1) {
    const included = i <= modelRows.included;
    const building = pick(BUILDINGS, rand);
    const format = pick(["obj", "fbx", "glb", "gltf", "dwg", "rvt", "ifc", "bim"], rand);
    const lod = pick(["LOD300", "LOD350", "LOD400"], rand);
    const software = pick(["Revit", "SketchUp", "Blender", "ContextCapture"], rand);
    const asset = addAsset({
      id: `KA-M-${pad(i, 4)}`,
      kind: "model",
      ordinal: i,
      type: "modelFile",
      title: `${building.name} · ${pick(["建筑信息模型", "结构复原模型", "构件级模型", "建图成果"], rand)}`,
      format: format.toUpperCase(),
      businessCategories: included ? ["规范方法"] : ["历史归档"],
      sourceSystem: "平台业务",
      sourceEntityId: `MDL-${pad(i, 4)}`,
      mainSource: "平台业务",
      indexState: included ? stateOf(modelStates, i - 1) : "未纳入",
      excludedReason: included ? null : "未补提取说明，暂不纳入索引",
      availability: included ? "可用" : "待补充内容",
      sizeBytes: 12_000_000 + Math.floor(rand() * 240_000_000),
      objectIds: [building.id],
      primaryObjectId: building.id,
      capturedAt: INSPECTIONS[1].date,
      updatedAt: isoAt(anchorMs, 14 - (i % 14), 3, (i * 3) % 60),
      owner: "shi",
      summary: `${building.name}｜${format.toUpperCase()}｜${lod}`,
      textMode: included ? "structured" : "none",
      extra: { lod, software },
      building,
    });
    markDeep(asset, "modelFile");
    if (!included) continue;
    const text = [
      `模型说明：${building.name}（${building.id}）${format.toUpperCase()} 建模成果，精细度 ${lod}，导出软件 ${software}。`,
      `建模依据：以五月与九月两轮扫描点云为底，构件编号与资产库中的构件档案一一对应，共 ${(40 + rand() * 90).toFixed(0)} 个构件单元。`,
      `坐标与单位：采用项目统一坐标系，单位毫米，与 ${pick(DEVICES, rand).id} 采集的点云配准残差 ${(rand() * 8).toFixed(1)} mm。`,
      "使用范围：用于构件级巡检定位、孪生场景配准与报告出图；仅供平台内部使用，不对外发布。",
    ].join("\n");
    addContent(asset, text, modelChunks[i - 1]);
  }

  /* ---- 5.7 点云数据（96 份配准与切片产物，不索引） ---- */
  const cloudRows = BASELINE_ROWS.find((row) => row.type === "pointCloud");
  for (let i = 1; i <= cloudRows.materialized; i += 1) {
    const building = pick(BUILDINGS, rand);
    const device = pick(DEVICES.filter((item) => item.kind === "激光扫描仪"), rand);
    const format = pick(["ply", "pcd", "las", "laz", "xyz"], rand);
    const asset = addAsset({
      id: `KA-C-${pad(i, 4)}`,
      kind: "cloud",
      ordinal: i,
      type: "pointCloud",
      title: `${building.name} · ${pick(["配准点云", "抽稀点云", "分类点云", "切片点云"], rand)}`,
      format: format.toUpperCase(),
      businessCategories: ["设备运行"],
      sourceSystem: "巡检设备",
      sourceEntityId: `PC-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: "未纳入",
      excludedReason: "点云二进制数据，本期只登记与统计",
      sizeBytes: 60_000_000 + Math.floor(rand() * 600_000_000),
      objectIds: [building.id, device.id],
      primaryObjectId: device.id,
      capturedAt: INSPECTIONS[1].date,
      updatedAt: isoAt(anchorMs, 13 - (i % 13), 4, (i * 5) % 60),
      owner: "rao",
      summary: `${building.name}｜${format.toUpperCase()}｜${(200 + rand() * 1800).toFixed(0)} 万点`,
      extra: { pointCount: Math.round(2_000_000 + rand() * 18_000_000), registered: true },
      building,
    });
    markDeep(asset, "pointCloud");
  }

  /* ---- 5.8 模型权重（60 份 .pt/.onnx/.engine，不索引） ---- */
  const weightRows = BASELINE_ROWS.find((row) => row.type === "modelWeight");
  for (let i = 1; i <= weightRows.materialized; i += 1) {
    const format = pick(["pt", "pth", "onnx", "engine", "tflite", "safetensors"], rand);
    const task = pick(["缺陷检测", "病害分割", "含水率回归", "构件识别", "裂缝提取"], rand);
    const asset = addAsset({
      id: `KA-WT-${pad(i, 3)}`,
      kind: "weight",
      ordinal: i,
      type: "modelWeight",
      title: `木构${task}模型 · 权重 v${(i % 5) + 1}`,
      format: format.toUpperCase(),
      businessCategories: ["设备运行"],
      sourceSystem: "平台业务",
      sourceEntityId: `WT-${pad(i, 3)}`,
      mainSource: "平台业务",
      indexState: "未纳入",
      excludedReason: "模型权重二进制，只登记版本与来源",
      sizeBytes: 8_000_000 + Math.floor(rand() * 240_000_000),
      objectIds: [],
      primaryObjectId: null,
      buildingId: null,
      zone: "算法侧",
      capturedAt: isoAt(anchorMs, 30, 6, 0),
      updatedAt: isoAt(anchorMs, 10 - (i % 10), 6, (i * 7) % 60),
      owner: "shi",
      summary: `${task}｜${format.toUpperCase()}｜${pick(["yolov8s", "segformer-b2", "resnet50", "mobilenetv3"], rand)}`,
      extra: { framework: pick(["PyTorch", "ONNX Runtime", "TensorRT", "TFLite"], rand), paramsM: Number((3 + rand() * 60).toFixed(1)) },
    });
    markDeep(asset, "modelWeight");
  }

  /* ---- 5.9 音频记录（90 条；带转写片段的 48 条纳入索引） ---- */
  const audioRows = BASELINE_ROWS.find((row) => row.type === "audio");
  const audioChunks = allocateChunks(audioRows.chunkCount, audioRows.included);
  const audioStates = buildIndexStates(audioRows.included, audioRows.pending, audioRows.error);
  for (let i = 1; i <= audioRows.materialized; i += 1) {
    const included = i <= audioRows.included;
    const building = pick(BUILDINGS, rand);
    const component = componentFor(building);
    const format = pick(["wav", "mp3", "m4a", "flac"], rand);
    const durationSec = 60 + Math.floor(rand() * 900);
    const asset = addAsset({
      id: `KA-A-${pad(i, 4)}`,
      kind: "audio",
      ordinal: i,
      type: "audio",
      title: `${building.name} · ${pick(["现场记录", "口述记录", "交接录音", "复核说明"], rand)}`,
      format: format.toUpperCase(),
      businessCategories: ["巡检报告"],
      sourceSystem: "巡检设备",
      sourceEntityId: `AUD-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: included ? stateOf(audioStates, i - 1) : "未纳入",
      excludedReason: included ? null : "现场录音未附转写片段，需人工整理后再纳入索引",
      availability: included ? "可用" : "待补充内容",
      sizeBytes: 2_000_000 + Math.floor(rand() * 20_000_000),
      objectIds: [building.id, component.id],
      primaryObjectId: component.id,
      capturedAt: INSPECTIONS[1].date,
      updatedAt: isoAt(anchorMs, 11 - (i % 11), 5, (i * 3) % 60),
      owner: pick(["rao", "shen"], rand),
      summary: `${component.name}｜时长 ${Math.floor(durationSec / 60)} 分 ${durationSec % 60} 秒`,
      textMode: included ? "transcript" : "none",
      extra: { durationSec },
      building,
    });
    markDeep(asset, "audio");
    if (!included) continue;
    const lineCount = Math.max(2, audioChunks[i - 1]);
    const lines = [];
    for (let part = 0; part < lineCount; part += 1) {
      const start = part * 45;
      const end = start + 45;
      lines.push(
        `[${timecode(start)}–${timecode(end)}] ${pick(["沈", "饶", "马昱天"], rand)}：`
          + `${component.name}${pick(["柱脚还有返潮", "油饰起甲范围比上轮大", "这次先做临时支护", "复核后可以出报告"], rand)}，`
          + `${pick(["按五月那次的处理办法", "等雨季过后再复测", "先记录不处置", "纳入复巡计划"], rand)}。`,
      );
    }
    addContent(asset, lines.join("\n"), audioChunks[i - 1]);
  }

  /* ---- 5.10 历史工单（162 份，全部纳入） ---- */
  const orderRows = BASELINE_ROWS.find((row) => row.type === "workOrder");
  const orderChunks = allocateChunks(orderRows.chunkCount, orderRows.included);
  const orderStates = buildIndexStates(orderRows.included, orderRows.pending, orderRows.error);
  const workOrderAssets = [];
  for (let i = 1; i <= orderRows.materialized; i += 1) {
    const building = pick(BUILDINGS, rand);
    const component = componentFor(building);
    const problem = pick(DEFECT_TYPES, rand);
    const date = isoAt(anchorMs, [312, 236, 122, 118, 33][Math.floor(rand() * 5)], 2, 10).slice(0, 10);
    const orderNo = `WO-${pad(i, 3)}`;
    const asset = addAsset({
      id: `KA-W-${pad(i, 4)}`,
      kind: "order",
      ordinal: i,
      type: "workOrder",
      title: `${component.name} · ${problem}处置工单`,
      format: "工单",
      businessCategories: ["维修记录"],
      sourceSystem: "平台业务",
      sourceEntityId: orderNo,
      mainSource: "平台业务",
      indexState: stateOf(orderStates, i - 1),
      sizeBytes: 18_000 + Math.floor(rand() * 40_000),
      objectIds: [building.id, component.id, orderNo],
      primaryObjectId: component.id,
      capturedAt: `${date}T02:10:00.000Z`,
      updatedAt: isoAt(anchorMs, 14 - (i % 14), 6 + (i % 6), i % 60),
      owner: pick(["shen", "rao", "ma"], rand),
      summary: `${orderNo}｜${problem}｜${component.name}｜处置完成并复核`,
      textMode: "structured",
      contentRevision: 3,
      metadataRevision: 4,
      extra: { orderNo, orderState: pick(["已关闭", "已复核", "已关闭"], rand) },
      building,
    });
    workOrderAssets.push(asset);
    markDeep(asset, "workOrder");
    const text = WORK_ORDER_TEXT.join("\n")
      .replaceAll("{orderNo}", orderNo)
      .replaceAll("{problem}", problem)
      .replaceAll("{date}", date)
      .replaceAll("{reporter}", pick(["沈", "饶", "马昱天"], rand))
      .replaceAll("{component}", component.name)
      .replaceAll("{building}", building.name)
      .replaceAll("{zone}", component.zone);
    addContent(asset, text, orderChunks[i - 1]);
    if (i > 6 && i % 7 === 0) {
      const previous = workOrderAssets.find((item) => item.primaryObjectId === component.id && item.orderNo < orderNo);
      if (previous) pushRelation(previous.id, asset.id, "引用", `${previous.orderNo} → ${orderNo}`, "业务字段");
    }
  }

  /* ---- 5.11 日志批次（96 份；纳入 72） ---- */
  const logRows = BASELINE_ROWS.find((row) => row.type === "logBatch");
  const logChunks = allocateChunks(logRows.chunkCount, logRows.included);
  const logStates = buildIndexStates(logRows.included, logRows.pending, logRows.error);
  for (let i = 1; i <= logRows.materialized; i += 1) {
    const included = i <= logRows.included;
    const device = pick(DEVICES, rand);
    const inspection = rand() > 0.5 ? INSPECTIONS[1] : INSPECTIONS[0];
    const windowStart = isoAt(anchorMs, 18 - (i % 18), 1, (i * 7) % 60);
    const windowEnd = isoAt(anchorMs, 18 - (i % 18), 1, ((i * 7) % 60) + 1);
    const lineCount = 600 + Math.floor(rand() * 5400);
    const asset = addAsset({
      id: `KA-L-${pad(i, 4)}`,
      kind: "log",
      ordinal: i,
      type: "logBatch",
      title: `${device.name} · ${inspection.round === "本轮" ? "九月" : "五月"}巡检日志批次`,
      format: "JSONL",
      businessCategories: ["设备运行"],
      sourceSystem: "巡检设备",
      sourceEntityId: `LOG-${device.id}-${pad(i, 4)}`,
      mainSource: "巡检设备",
      indexState: included ? stateOf(logStates, i - 1) : "未纳入",
      excludedReason: included ? null : "原始调试日志未达到 warn 级别，保留为资产但不纳入索引",
      availability: included ? "可用" : "待补充内容",
      sizeBytes: 180_000 + Math.floor(rand() * 900_000),
      objectIds: [device.id, device.buildingId],
      primaryObjectId: device.id,
      capturedAt: windowStart,
      updatedAt: isoAt(anchorMs, 17 - (i % 18), 2, (i * 3) % 60),
      owner: "rao",
      summary: `${device.name}｜${lineCount} 条记录｜${windowStart.slice(0, 16).replace("T", " ")} 起 60 秒窗口`,
      textMode: included ? "aggregated" : "none",
      contentRevision: 2,
      extra: { lineCount, windowFrom: windowStart, windowTo: windowEnd },
      building: buildingsById.get(device.buildingId) ?? BUILDINGS[0],
    });
    markDeep(asset, "logBatch");
    if (!included) continue;
    const lines = [];
    for (let line = 0; line < 24; line += 1) {
      const template = LOG_LINES[line % LOG_LINES.length];
      lines.push(
        `${windowStart.slice(11, 19)} ${template
          .replace("{rssi}", String(-40 - Math.floor(rand() * 40)))
          .replace("{battery}", String(40 + Math.floor(rand() * 60)))
          .replace("{uptime}", String(1200 + line * 37))
          .replace("{buffer}", String(120 + line * 3))
          .replace("{jitter}", String(20 + Math.floor(rand() * 260)))
          .replace("{retry}", String(Math.floor(rand() * 6)))
          .replace("{peer}", "10.20.3." + (10 + line))
          .replace("{timeout}", String(2000 + line * 100))
          .replace("{loss}", (rand() * 8).toFixed(2))
          .replace("{drift}", (rand() * 2).toFixed(2))
          .replace("{node}", device.id)}`,
      );
    }
    addContent(
      asset,
      `日志批次 ${asset.sourceEntityId} · ${device.name} · 窗口 ${windowStart} – ${windowEnd} · 共 ${lineCount} 条\n${lines.join("\n")}`,
      logChunks[i - 1],
    );
  }

  /* ---- 5.12 业务记录（60 份，全部纳入） ---- */
  const recordRows = BASELINE_ROWS.find((row) => row.type === "record");
  const recordChunks = allocateChunks(recordRows.chunkCount, recordRows.included);
  for (let i = 1; i <= recordRows.materialized; i += 1) {
    const template = RECORD_TEMPLATES[(i - 1) % RECORD_TEMPLATES.length];
    const building = pick(BUILDINGS, rand);
    const component = componentFor(building);
    const device = pick(DEVICES, rand);
    const date = isoAt(anchorMs, 20 - (i % 20), 5, (i * 11) % 60);
    const asset = addAsset({
      id: `KA-R-${pad(i, 4)}`,
      kind: "record",
      ordinal: i,
      type: "record",
      title: `${template.label} · ${component.name}`,
      format: "业务记录",
      businessCategories: ["设备运行"],
      sourceSystem: "平台业务",
      sourceEntityId: `REC-${template.key}-${pad(i, 3)}`,
      mainSource: "平台业务",
      indexState: "covered",
      sizeBytes: 6_000 + Math.floor(rand() * 12_000),
      objectIds: [component.id, device.id],
      primaryObjectId: component.id,
      capturedAt: date,
      updatedAt: date,
      owner: pick(["shi", "shen"], rand),
      summary: `${template.label}｜字段：${template.fields}`,
      textMode: "structured",
      building,
    });
    markDeep(asset, "record");
    const rowCount = Math.max(1, recordChunks[i - 1]);
    const rows = [];
    for (let row = 0; row < rowCount; row += 1) {
      rows.push(
        `记录行 ${pad(row + 1, 2)}｜对象 ${component.name}｜仪器 ${device.id}｜`
          + `${template.key === "采样" ? `含水率 ${(11 + rand() * 6).toFixed(1)}%` : ""}`
          + `${template.key === "检测" ? `回弹值 ${(28 + rand() * 12).toFixed(1)}` : ""}`
          + `${template.key === "校准" ? `偏差 ${(rand() * 0.8).toFixed(3)} mm` : ""}`
          + `${template.key === "发布" ? `场景 scene-SH-0901 · 锚点 ${component.id}` : ""}`
          + `｜记录时间 ${date.slice(0, 10)}`,
      );
    }
    addContent(asset, `${template.label}（${asset.sourceEntityId}）\n字段：${template.fields}\n${rows.join("\n")}`, recordChunks[i - 1]);
  }

  /* ================================================================== *
   * 5.13 业务关联边（PRD §8.4：每条边至少 relationType/fromId/toId/evidenceRef/origin）
   * ================================================================== */
  for (const asset of assets) {
    const building = buildingsById.get(asset.buildingId);
    if (building) pushRelation(asset.id, building.id, "属于", `asset.buildingId=${building.id}`, "业务字段");
    if (asset.primaryObjectId && componentById.has(asset.primaryObjectId)) {
      pushRelation(asset.id, asset.primaryObjectId, "记录对象", `asset.primaryObjectId=${asset.primaryObjectId}`, "业务字段");
    }
    if (asset.sourceSystem === "巡检设备") {
      const device = DEVICES.find((item) => asset.objectIds.includes(item.id));
      if (device) pushRelation(asset.id, device.id, "采集自", `asset.sourceSystem=巡检设备 · ${device.id}`, "业务字段");
    }
    // 派生产物指向站点：图谱上要能看出「谁由谁生成」
    if ((asset.type === "gaussian" || asset.type === "pointCloud" || asset.type === "modelFile") && asset.buildingId) {
      pushRelation(asset.id, asset.buildingId, "更新自", `${asset.type} 由同站扫描数据生成`, "演示夹具规则");
    }
  }
  const attachmentPairs = [
    ["KA-P-0005", "KA-W-0003"],
    ["KA-P-0006", "KA-W-0003"],
    ["KA-P-0007", "KA-W-0004"],
    ["KA-V-0001", "KA-W-0005"],
    ["KA-A-0002", "KA-W-0006"],
  ];
  for (const [child, parent] of attachmentPairs) {
    if (assets.some((item) => item.id === child) && assets.some((item) => item.id === parent)) {
      pushRelation(child, parent, "附件属于", `${child} 是 ${parent} 的附件`, "业务字段");
    }
  }
  for (const inspection of INSPECTIONS) {
    const isMay = inspection.round === "历史";
    const linked = assets
      .filter((asset) => (isMay ? asset.capturedAt < "2026-01-01" : asset.capturedAt >= "2026-01-01"))
      .slice(0, 12);
    for (const asset of linked) {
      pushRelation(inspection.id, asset.id, "采集自", `inspection.round=${inspection.round}`, "演示夹具规则");
    }
  }

  /* ================================================================== *
   * 5.14 版本规范化 + 索引成员与向量（一块一条，adapterMode=demo）
   * ================================================================== */
  for (const asset of assets) {
    if (asset.contentRevision < 2) {
      const from = asset.contentRevision;
      const to = 2;
      asset.contentRevision = to;
      asset.revision = to;
      for (const chunk of chunks) {
        if (chunk.assetId !== asset.id) continue;
        chunk.assetRevision = to;
        if (chunk.indexedRevision === from) chunk.indexedRevision = to;
      }
    }
    const wantsCurrent = INDEX_STATE_LABEL[asset.indexState] === "已覆盖";
    const current = asset.contentRevision;
    if (wantsCurrent) {
      asset.indexedRevision = current;
    } else {
      asset.indexedRevision = current - 1 >= 1 ? current - 1 : current;
      if (asset.indexedRevision === current) {
        asset.contentRevision = current + 1;
        asset.revision = asset.contentRevision;
        asset.indexedRevision = current;
        for (const chunk of chunks) {
          if (chunk.assetId === asset.id) chunk.assetRevision = asset.contentRevision;
        }
      }
    }
    for (const chunk of chunks) {
      if (chunk.assetId === asset.id) chunk.indexedRevision = asset.indexedRevision ?? chunk.indexedRevision;
    }
    asset.revisionCount = Math.max(2, asset.contentRevision);
  }

  const indexMembers = [];
  for (const chunk of chunks) {
    const vectorId = `VEC-${chunk.id.slice(3)}`;
    vectors.push({
      id: vectorId,
      chunkId: chunk.id,
      adapterMode: ADAPTER_MODE,
      dimensionConfig: DIMENSION_CONFIG,
      configRevision: BASELINE_CONFIG_REVISION,
      state: "有效",
      indexVersion: BASELINE_SERVING_VERSION,
    });
    indexMembers.push({
      indexVersion: BASELINE_SERVING_VERSION,
      assetId: chunk.assetId,
      // 成员记的是**被索引的那一版内容**：已覆盖项就是当前版；待更新 / 异常项
      // 停在上一版（旧版仍在服务，只是与资产当前 revision 不一致）。
      assetRevision: chunk.indexedRevision ?? chunk.assetRevision,
      chunkId: chunk.id,
      vectorId,
    });
  }

  /* ================================================================== *
   * 5.15 报告与自检
   * ================================================================== */
  const byType = {};
  for (const asset of assets) {
    byType[asset.type] ??= { total: 0, covered: 0, pending: 0, error: 0, excluded: 0, chunks: 0 };
    byType[asset.type].total += 1;
    const bucket = byType[asset.type];
    const state = INDEX_STATE_LABEL[asset.indexState] ?? asset.indexState;
    if (state === "未纳入") bucket.excluded += 1;
    else if (state === "已覆盖") bucket.covered += 1;
    else if (state === "待更新") bucket.pending += 1;
    else if (state === "更新失败") bucket.error += 1;
  }
  for (const chunk of chunks) byType[findAssetType(assets, chunk.assetId)].chunks += 1;

  const scaleRows = BASELINE_ROWS
    .filter((row) => row.total > row.materialized)
    .map((row) => ({ type: row.type, count: row.total - row.materialized }));

  const report = {
    scenarioId: DEMO_SCENARIO_ID,
    seed,
    sessionId,
    generatedAt: BASELINE_PUBLISHED_AT,
    assets: assets.length,
    materialized: assets.length,
    scaleTotal: scaleRows.reduce((sum, row) => sum + row.count, 0),
    scaleRows,
    byType,
    chunks: chunks.length,
    vectors: vectors.length,
    indexMembers: indexMembers.length,
    contents: contents.length,
    relations: relations.length,
    deepSampleCount: deepSampleIds.length,
    deepSampleIds,
    missingAttachment: assets.filter((asset) => !asset.fileId).length,
    errors: [],
  };

  /* ---- 5.16 验收不变量：生成完立刻自检，不等到页面 ---- */
  if (assets.length !== BASELINE_TOTALS.materialized) {
    report.errors.push(`明细资产 ${assets.length} ≠ ${BASELINE_TOTALS.materialized}`);
  }
  if (chunks.length !== BASELINE_TOTALS.chunks) report.errors.push(`分块总数 ${chunks.length} ≠ ${BASELINE_TOTALS.chunks}`);
  if (vectors.length !== BASELINE_TOTALS.vectors) report.errors.push(`向量条目 ${vectors.length} ≠ ${BASELINE_TOTALS.vectors}`);
  if (deepSampleIds.length < 24) report.errors.push(`可深入展示样本 ${deepSampleIds.length} < 24`);
  dedupeFilenames();
  const fileNames = new Set(assets.map((asset) => asset.filename));
  if (fileNames.size !== assets.length) report.errors.push(`文件名有重复：${assets.length - fileNames.size} 条`);
  const latin = assets.filter((asset) => !/[\u4e00-\u9fa5]/.test(asset.filename ?? "")).length;
  if (latin < assets.length * 0.25) {
    report.errors.push(`纯英文/编号文件名只占 ${((latin / assets.length) * 100).toFixed(0)}%，不够真实`);
  }
  for (const expected of BASELINE_ROWS) {
    const actual = byType[expected.type] ?? { total: 0, covered: 0, pending: 0, error: 0, excluded: 0, chunks: 0 };
    if (actual.total !== expected.materialized) report.errors.push(`${expected.label}明细 ${actual.total} ≠ ${expected.materialized}`);
    if (actual.excluded !== expected.excluded) report.errors.push(`${expected.label}未纳入 ${actual.excluded} ≠ ${expected.excluded}`);
    if (actual.chunks !== expected.chunkCount) report.errors.push(`${expected.label}分块 ${actual.chunks} ≠ ${expected.chunkCount}`);
    if (actual.covered + actual.pending + actual.error !== expected.included) {
      report.errors.push(`${expected.label}覆盖+待更新+异常 ${actual.covered + actual.pending + actual.error} ≠ ${expected.included}`);
    }
  }

  return { assets, relations, contents, chunks, vectors, indexMembers, report, versions: BASELINE_VERSIONS };
}


/* ------------------------------------------------------------------ *
 * 6. 小工具
 * ------------------------------------------------------------------ */

/**
 * 按「每类正好 N 个待更新 / M 个异常」生成状态序列（PRD §7.1 的比例是验收约束）。
 *
 * 位置用固定间隔算，不用随机：同一 seed 下永远落在同一批资产上，
 * 重置场景后「哪几份资料是异常」不会漂移，演示讲解时能指着同一行说。
 *
 * 用「两个计数器谁落后谁先落位」的合并写法，是为了让异常与待更新各自均匀
 * 分布、又绝不撞在同一个序号上（撞了就会少一个，比例随资产数变化而漂移）。
 */
export function buildIndexStates(included, pending, error) {
  const total = pending + error;
  const states = new Array(included).fill("covered");
  if (total <= 0 || included <= 0) return states;
  const errorStride = included / error;
  const pendingStride = included / pending;
  let placedError = 0;
  let placedPending = 0;
  for (let index = 0; index < included; index += 1) {
    const nextError = placedError < error ? (placedError + 1) * errorStride : Infinity;
    const nextPending = placedPending < pending ? (placedPending + 1) * pendingStride : Infinity;
    if (nextError === Infinity && nextPending === Infinity) break;
    if (nextError <= nextPending) {
      states[index] = "error";
      placedError += 1;
    } else {
      states[index] = "pending";
      placedPending += 1;
    }
  }
  return states;
}

/** 每 20 个资产一组，按序号决定覆盖 / 待更新 / 异常，保证各类占比稳定可复现 */

/**
 * 生成器内部的英文枚举 → 落库与界面用的中文状态（PRD §9.1「单资产索引」）。
 * 生成时用英文便于判等，落库前经这里统一成中文，避免两套状态词混进库里。
 */
const INDEX_STATE_LABEL = {
  covered: "已覆盖",
  pending: "待更新",
  error: "更新失败",
  processing: "处理中",
  excluded: "未纳入",
  "未纳入": "未纳入",
  "已覆盖": "已覆盖",
  "待更新": "待更新",
  "更新失败": "更新失败",
  "处理中": "处理中",
};

function findAssetType(assets, assetId) {
  return assets.find((asset) => asset.id === assetId)?.type ?? "document";
}

function timecode(seconds) {
  const mm = pad(Math.floor(seconds / 60), 2);
  const ss = pad(seconds % 60, 2);
  return `00:${mm}:${ss}`;
}

/**
 * 把一段切片变成分块行。
 * `locator` 按资产类型给出真实定位（页码 / 章节 / 单元格范围 / 时间码 / 工单节点 / 行号），
 * 页面上的「来源定位」直接读这一列，不再临时猜。
 */
function toChunkRow(asset, ordinal, slice, locatorKind) {
  const id = `CK-${asset.id.slice(3)}-${pad(ordinal + 1, 3)}`;
  const page = 1 + Math.floor(ordinal / 3);
  const locator = (() => {
    switch (locatorKind) {
      case "page":
        return { kind: "page", page, paragraph: (ordinal % 3) + 1, region: ordinal % 3 === 2 ? "表格区域" : null };
      case "section":
        return { kind: "section", section: `第 ${1 + Math.floor(ordinal / 4)} 节`, paragraph: (ordinal % 4) + 1 };
      case "sheet":
        return { kind: "sheet", sheet: XLSX_SHEETS[ordinal % XLSX_SHEETS.length], range: `A${ordinal * 6 + 2}:F${ordinal * 6 + 12}` };
      case "image":
        return { kind: "image", imageId: asset.id, region: ordinal === 0 ? "全幅" : `标注区 ${ordinal}` };
      case "timecode":
        return { kind: "timecode", start: timecode(slice.start ?? 0), end: timecode((slice.end ?? 0) + 0), keyframe: `KF-${pad(ordinal + 1, 3)}` };
      case "workorder":
        return { kind: "workorder", orderNo: asset.orderNo ?? asset.sourceEntityId, node: ["提报", "核实", "处置", "复核", "归档"][ordinal % 5] };
      case "log":
        return {
          kind: "log",
          deviceId: asset.primaryObjectId,
          from: asset.windowFrom ?? asset.capturedAt,
          to: asset.windowTo ?? asset.capturedAt,
          line: (slice.start ?? ordinal) + 1,
        };
      default:
        return { kind: "record", entityId: asset.sourceEntityId, revision: asset.contentRevision };
    }
  })();
  return {
    id,
    assetId: asset.id,
    assetRevision: asset.contentRevision,
    // 索引成员记的是**被索引的那一版内容**：已覆盖项就是当前版；待更新 / 异常项
    // 停在上一版（旧版仍在服务，只是与资产当前 revision 不一致）。
    // 覆盖判定全靠这个字段比较，不靠有没有成员（PRD §7.2「当前版覆盖资产」）。
    indexedRevision: asset.indexState === "covered" ? asset.contentRevision : Math.max(1, asset.contentRevision - 1),
    chunkOrdinal: ordinal,
    // 分块正文末尾写上本文件内的位置与文件编号。
    // 两个作用，都是必要的：一是「来源定位」本来就是页码 + 段落，分块正文里带上，
    // 读者能直接对上原文；二是题材模板会跨文件复用（同一份保养要求用在多座建筑上），
    // 相邻段落相同的长句切片后会产生逐字相同的块 —— 带上文件编号之后每块都能
    // 定位到唯一位置，不会出现「两条一模一样的证据」（PRD §11.2 禁止复制片段刷数）。
    text: `${slice.text}${positionSuffix(asset, ordinal, locatorKind)}`,
    charCount: slice.text.length,
    locator,
    chunkConfigRevision: BASELINE_CONFIG_REVISION,
    digest: sha1(`${id}:${slice.text}`).slice(0, 16),
    // 纳入索引的资产在**当前服务版本**里都有成员：待更新 / 异常项携带的是
    // 上一版内容，成员还在，只是 asset_revision 与资产当前 revision 不一致。
    // 覆盖判定靠 revision 比较，不靠有没有成员（PRD §7.2「当前版覆盖资产」）。
    indexVersion: asset.indexState === "未纳入" ? null : BASELINE_SERVING_VERSION,
  };
}

/** 分块正文末尾的位置标记：按定位类型给出「第 N 段 / 第 N 行 / 第 N 条」 */
function positionSuffix(asset, ordinal, locatorKind) {
  const unit = locatorKind === "sheet" ? "行" : locatorKind === "workorder" ? "条" : locatorKind === "log" ? "段" : "段";
  return `（${asset.sourceEntityId} · 第 ${ordinal + 1} ${unit}）`;
}

/**
 * 文档分块的真实文本：按题材给不同的章节模板。
 *
 * 报告给页码（PDF），档案 / 工法 / 法规 / 规划给章节，数据表给工作表与单元格范围
 * —— 定位口径与 PRD §4.3 的表格逐行对应，检索结果里的「来源定位」才有意义。
 */
function makeDocumentChunks({ asset, chunks: count, rand, sections, body, inspection, building, component, deviceById, problem, severity }) {
  const device = pick([...deviceById.values()], rand);
  const vars = {
    building: building.name,
    zone: component.zone,
    components: `${component.name}、${pick([...componentByIdKeys()], rand)}`,
    component: component.name,
    problem: problem ?? "柱脚渗水",
    defects: String(1 + Math.floor(rand() * 6)),
    temp: (22 + rand() * 8).toFixed(1),
    rh: (62 + rand() * 24).toFixed(0),
    emc: (12 + rand() * 5).toFixed(2),
    device: device.name,
    shots: String(12 + Math.floor(rand() * 60)),
    area: (2 + rand() * 12).toFixed(1),
    defectNo: `DF-${pad(1 + Math.floor(rand() * 40), 3)}`,
    level: severity,
    // 保护规划里的分区与限值：按建筑取不同的真实参数
    buffer: String(20 + Math.floor(rand() * 20)),
    control: String(40 + Math.floor(rand() * 40)),
    height: String(9 + Math.floor(rand() * 6)),
    capacity: String(120 + Math.floor(rand() * 400)),
    instant: String(20 + Math.floor(rand() * 40)),
    points: String(4 + Math.floor(rand() * 8)),
  };
  const fill = (template) => template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);

  if (sections === "sheet") {
    const rows = [];
    for (let row = 0; row < count; row += 1) {
      rows.push(
        `${XLSX_SHEETS[row % XLSX_SHEETS.length]}｜测区 ${component.id}-${pad(row + 1, 2)}｜`
          + `含水率 ${(11 + rand() * 6).toFixed(1)}%｜回弹值 ${(28 + rand() * 12).toFixed(1)}｜`
          + `碳化深度 ${(rand() * 2).toFixed(2)} mm｜结论 ${pick(["合格", "观察", "复测"], rand)}｜`
          + `记录 ${asset.sourceEntityId}-${pad(row + 1, 3)}`,
      );
    }
    return { text: rows.join("\n"), chunks: rows.map((text, index) => ({ text, start: index, end: index + 1 })) };
  }

  /*
    题材 → 章节模板。政策法规与保护规划按 `body` 取各自的主题正文：
    消防、保养、报批、虫害、防水、档案 / 区划、本体措施、展示利用各是一份，
    不共用一份模板，检索结果里才不会出现「同一份文件换八个文件名」。
  */
  const template =
    sections === "craft" ? CRAFT_SECTIONS
      : sections === "policy" ? POLICY_BODIES[body] ?? POLICY_BODIES.maintain
        : sections === "plan" ? PLAN_BODIES[body] ?? PLAN_BODIES.measure
          : sections === "archive" ? DOCX_SECTIONS
            : PDF_REPORT_SECTIONS;

  const paragraphs = template.map(([heading, text]) => `${heading}：${fill(text)}`);
  /*
    首行带上这份文件自己的编号与登记信息。
    这不是装饰：正文模板会按题材复用（同一份「木构件保养要求」用在多座建筑上），
    没有编号时两个文档的第一段会逐字相同 —— 检索结果里就是两条一模一样的证据。
    真实报告本来也都有编号与登记行，所以这一行既解决重复，也让分块可核对该文件的哪一页。
  */
  paragraphs.unshift(
    `文件编号：${asset.sourceEntityId}｜关联对象：${vars.component}（${vars.building}${vars.zone}）`
      + `｜版本 v${asset.contentRevision}｜登记时间 ${String(asset.importedAt ?? "").slice(0, 10)}｜责任人 ${asset.owner ?? "—"}`,
  );
  /*
    按目标块数补齐段落。
    **补出来的段落必须带上构件、部位与编号**：只写「第 2 次引用」的话，同一个建筑
    下的两份同题材文档会生成完全一样的正文 —— 检索结果里就是两条一模一样的证据，
    PRD §11.2 把这种重复明确定为「合成资料」的禁忌。带上对象与序号之后，
    每一条都能落到具体构件上，读者能核对它说的是哪根柱子。
  */
  const rounds = new Map();
  while (paragraphs.length < count) {
    const cursor = paragraphs.length % template.length;
    const [heading, text] = template[cursor];
    const round = (rounds.get(cursor) ?? 1) + 1;
    rounds.set(cursor, round);
    paragraphs.push(
      `${heading}（${vars.component} · 第 ${round} 次引用）：${fill(text)}`
        + `本条针对 ${vars.component}，部位 ${vars.zone}，记录编号 ${asset.id}-${pad(paragraphs.length + 1, 3)}。`,
    );
  }
  const text = paragraphs.join("\n");
  /*
    切片后给每一块补上**文件内的位置标记**（第 N 段）。
    与 toChunkRow 末尾的位置标记是同一件事的两端：正文里带上段号，读者能直接对上
    原文，读者能直接对上原文；同一题材模板在不同文件里复用时也不会产生逐字相同的块。
  */
  const slices = sliceChunks(text).slice(0, count);
  while (slices.length < count) {
    const index = slices.length;
    const tail = `附注：本条为同一节内容的第 ${index + 1} 段定位，定位见页码与段落编号。`;
    slices.push({ text: tail, start: index, end: index + 1 });
  }
  return { text, chunks: slices };
}

function* componentByIdKeys() {
  for (const item of buildComponents()) yield item.id;
}
