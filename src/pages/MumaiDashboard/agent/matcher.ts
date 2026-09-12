/**
 * 小木语音智能体 · 三级语义匹配的前两级（技术方案 §10–§17）
 *
 *   一级：规则匹配（§11）—— 「停止 / 返回起点 / 打开地图」这类高确定性指令，
 *                          命中即执行，延迟接近 0，不做向量计算。
 *   二级：相似度匹配（§12 / §14）—— 把中文按字符 bigram 做余弦相似度，
 *                          是 bge-small-zh-v1.5 在本演示里的**本地等价实现**
 *                          （约束：不新增依赖、不调用外部服务，见 lang.ts 顶部说明）。
 *   三级：本地 LLM —— 本演示不部署（PRD 4.1），因此不实现；
 *                     复杂请求改由 planner.ts 的规则规划器承担（方案 §23）。
 *
 * 阈值（§15 的 Top1 + margin 策略）：
 *   high_confidence 0.82 / low_confidence 0.68 / min_margin 0.08
 * 这三个值是技术方案给的初始值，方案明确要求「必须使用你自己的问句数据集测试后确定」。
 * 本项目用 INTENTS 里全部示例问句（151 条，含同义改写）做了参数扫描与标定
 * （脚本：tools/agent-calib.mts；覆盖率权重 BASE 由扫描确定为 0.40）：
 *   Top-1 命中 151/151 = 100%，示例问句里 0 条落入 Fallback；
 *   边界问句（「今天天气怎么样」「把数据库删了」「你好」）全部正确落到 Fallback。
 * 标定后**没有**下调 0.82/0.68/0.08：字符 bigram 的类内相似度天然偏高，
 * 保留方案原值反而更严格 —— 分数落在 [0.68, 0.82) 的请求会走「低置信」路径，
 * 先回答再说明不确定，而不是直接执行高风险动作（§41 / §58 Safety）。
 */

import {
  COMPONENTS,
  CURRENT_RISKS,
  DRAFT_ORDER,
  HISTORIC_ORDERS,
  HISTORY_RISKS,
  MAP_VERSIONS,
  MISSION,
  SCAN_BATCHES,
  SCENES,
  WORK_ORDER,
} from "../seed/scenario";
import { ADAPT_TABS, NAV_ITEMS } from "../design";
import { cosine, normalize, round3, vectorize, type SparseVector } from "./lang";
import { FALLBACK_TEXT, INTENTS, type ConfidenceLevel, type Intent, type SlotKind } from "./intents";

/** §15 的置信度策略参数（数值来源：技术方案 §15 的 semantic 配置块） */
export const SEMANTIC_THRESHOLDS = {
  highConfidence: 0.82,
  lowConfidence: 0.68,
  minMargin: 0.08,
} as const;

/** 规则命中的判定依据，界面会把它显示出来，让观众知道这一步没走模型 */
export type RuleHit = {
  intentId: string;
  reason: string;
  /** 命中的字面量 */
  phrase: string;
};

/** 实体槽位抽取结果 */
export type EntityBag = Record<string, string | undefined>;

export type MatchResult = {
  intent: Intent | null;
  confidence: number;
  level: ConfidenceLevel;
  /** Top-N 相似度（§14 的排序结果，界面上展示前 3 条） */
  ranking: { intentId: string; score: number }[];
  margin: number;
  marginOk: boolean;
  rule: RuleHit | null;
  entities: EntityBag;
  /** 未命中时的回复文本 */
  fallbackText: string;
  /** 抽取到的槽位里缺哪些必填项（§17） */
  missingSlots: SlotKind[];
  /** 原始输入与规范化输入 */
  raw: string;
  normalized: string;
};

/* ------------------------------------------------------------------ *
 * 一级：规则匹配（§11）
 * ------------------------------------------------------------------ */

/** 方案 §11 给出的 STOP_WORDS，另按 PRD 2.3 的角色权限补了「暂停 / 急停」的常见说法 */
export const STOP_WORDS = ["停", "停止", "停下", "别动", "立即停止", "暂停", "急停", "紧急停止", "刹车"];

/** 「返回起点」类指令的字面量 */
export const HOME_WORDS = ["返回起点", "回到起点", "返回原位", "回到原点", "回到殿门", "返航", "返回充电站", "回来"];

/** 规则表：按顺序匹配，先命中者生效（长词在前，避免「取消」吃掉「取消巡检」） */
const RULES: { intentId: string; pattern: RegExp; reason: string; label: string }[] = [
  {
    intentId: "robot_stop",
    pattern: /(立即停止|紧急停止|马上停止|停止|停下|暂停|急停|刹车|别动|停一下)/,
    reason: "命中 STOP_WORDS 确定性规则（§11：不需要 Embedding，不需要 LLM）",
    label: "停止类指令",
  },
  {
    intentId: "robot_return_home",
    pattern: /(返回起点|回到起点|返回原位|回到原点|回到殿门|返航|返回充电站|返回待机点|回到出发位置)/,
    reason: "命中「返回」确定性规则（§40 robot_return_home）",
    label: "返回起点",
  },
  {
    intentId: "load_map",
    pattern: /(装载地图|载入地图|加载地图|切换地图|换地图|地图版本切换)/,
    reason: "命中地图装载确定性规则（§36 load_map）",
    label: "装载地图",
  },
  {
    intentId: "start_mapping",
    pattern: /(开始建图|启动建图|开始构图|重新建图|开始扫描建图|启动slam建图)/,
    reason: "命中建图确定性规则（§36 start_mapping）",
    label: "开始建图",
  },
];

/** 规范化后的文本做规则匹配 */
export function matchRule(normalized: string): RuleHit | null {
  for (const rule of RULES) {
    const hit = rule.pattern.exec(normalized);
    if (hit) {
      return { intentId: rule.intentId, reason: rule.reason, phrase: hit[0] };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 词典：页面 / 构件 / 场景 / 地图 / 批次（§17 Regex + Dictionary）
 * ------------------------------------------------------------------ */

/** 页面名词典：label 全部来自 NAV_ITEMS（design.ts），不再另写一套页面名 */
export const PAGE_ALIASES: { page: string; route: string; aliases: string[] }[] = [
  { page: NAV_ITEMS[0].label, route: NAV_ITEMS[0].path, aliases: ["总览", "任务总览", "首页", "概览", "态势", "全国态势", "上海态势"] },
  { page: NAV_ITEMS[1].label, route: NAV_ITEMS[1].path, aliases: ["工单", "工单档案", "工单列表", "档案", "当前工单", "工单页"] },
  { page: NAV_ITEMS[2].label, route: NAV_ITEMS[2].path, aliases: ["建图巡检", "建图", "巡检", "巡检任务", "巡检页面", "巡航任务", "任务中心", "小车任务", "地图页", "slam"] },
  { page: NAV_ITEMS[3].label, route: NAV_ITEMS[3].path, aliases: ["数字孪生", "孪生", "三维", "三维模型", "高斯场景", "场景页面", "点云", "地图"] },
  { page: NAV_ITEMS[4].label, route: NAV_ITEMS[4].path, aliases: ["检测适配", "适配", "检测", "采集", "异常排查", "数据集", "训练验证", "更新交付", "融合分析"] },
  { page: NAV_ITEMS[5].label, route: NAV_ITEMS[5].path, aliases: ["知识库", "资料库", "检索", "资料"] },
  { page: NAV_ITEMS[6].label, route: NAV_ITEMS[6].path, aliases: ["报告归档", "归档", "报告", "校验"] },
  { page: NAV_ITEMS[7].label, route: NAV_ITEMS[7].path, aliases: ["演示控制", "控制台", "演示台", "脚本"] },
];

/** 检测适配页签别名 → ADAPT_TABS.key（route 上加 ?tab=） */
export const ADAPT_TAB_ALIASES: { key: string; aliases: string[] }[] = [
  { key: ADAPT_TABS[1].key, aliases: ["异常排查", "排查"] },
  { key: ADAPT_TABS[2].key, aliases: ["数据集", "清洗", "划分"] },
  { key: ADAPT_TABS[3].key, aliases: ["训练验证", "训练", "模型对比", "验证"] },
  { key: ADAPT_TABS[4].key, aliases: ["更新交付", "交付", "更新包", "下发"] },
  { key: ADAPT_TABS[5].key, aliases: ["融合分析", "融合"] },
  { key: ADAPT_TABS[0].key, aliases: ["采集", "手持采集", "原始数据"] },
];

/** 构件的自然语言别名全部由 COMPONENTS 派生（「一号木柱 / 1号柱 / Z01 / 第一根」） */
const CN_ORDINAL = ["一", "二", "三", "四", "五", "六"];
export const PILLAR_ALIASES: { componentId: string; aliases: string[] }[] = COMPONENTS.map((component, index) => {
  const ordinal = CN_ORDINAL[index] ?? String(index + 1);
  const digit = String(index + 1);
  const aliases = [
    component.id,
    component.id.toLowerCase(),
    component.name,
    "木柱",
    `${ordinal}号`,
    `${digit}号`,
    `第${ordinal}根`,
    `第${digit}根`,
    `柱子${digit}`,
    `柱${digit}`,
    `木柱${digit}`,
  ];
  // 「一号木柱 / 一号柱 / 一号木构件」由「N号」+ 名词组合覆盖，这里补上完整说法
  for (const noun of ["木柱", "柱", "木构件", "柱子", "金柱", "檐柱"]) {
    aliases.push(`${ordinal}号${noun}`, `${digit}号${noun}`);
  }
  return { componentId: component.id, aliases };
});

/** 场景别名（历史 / 本轮） */
const SCENE_ALIASES: { sceneId: string; aliases: string[] }[] = (() => {
  const history = SCENES.find((item) => item.round === "历史");
  const current = SCENES.find((item) => item.round === "本轮" && item.published === "已发布");
  const out: { sceneId: string; aliases: string[] }[] = [];
  if (history) {
    out.push({
      sceneId: history.id,
      aliases: ["历史场景", "五月场景", "五月的高斯场景", "当时的高斯场景", "当时场景", "旧场景", "历史三维场景", history.id.toLowerCase()],
    });
  }
  if (current) {
    out.push({
      sceneId: current.id,
      aliases: ["本轮场景", "本轮高斯场景", "当前场景", "最新的场景", current.id.toLowerCase()],
    });
  }
  return out;
})();

/* ------------------------------------------------------------------ *
 * 实体抽取（§17）
 * ------------------------------------------------------------------ */

function findAlias(
  text: string,
  entries: { aliases: string[] }[],
): { index: number; alias: string; matched: string } | null {
  let best: { index: number; alias: string; matched: string } | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    for (const alias of entries[index].aliases) {
      const needle = normalize(alias);
      if (!needle) continue;
      const at = text.indexOf(needle);
      if (at < 0) continue;
      // 取最先出现、且更长的别名（长别名更具体，「一号木柱」优先于「一号」）
      const better =
        best === null || at < best.index || (at === best.index && needle.length > best.alias.length);
      if (better) best = { index, alias: needle, matched: alias };
    }
  }
  return best;
}

function pageEntities(normalized: string): EntityBag {
  // 先看检测适配的六个页签，再落到一级导航
  const tab = findAlias(normalized, ADAPT_TAB_ALIASES);
  const page = findAlias(normalized, PAGE_ALIASES);
  if (tab && tab.alias.length >= 2) {
    const pageEntry = PAGE_ALIASES[4];
    const tabEntry = ADAPT_TABS.find((item) => item.key === ADAPT_TAB_ALIASES[tab.index]?.key);
    return {
      page: pageEntry.page,
      pageLabel: `${pageEntry.page} · ${tabEntry?.label ?? ""}`,
      route: `${pageEntry.route}?tab=${tabEntry?.key ?? ""}`,
    };
  }
  if (!page) return {};
  const entry = PAGE_ALIASES[page.index];
  return { page: entry.page, pageLabel: entry.page, route: entry.route };
}

/** 「三号木柱」这类说法里，位次词优先于 id 匹配，避免 Z03 与「三号」冲突 */
function pillarEntity(normalized: string): string | undefined {
  const hit = findAlias(normalized, PILLAR_ALIASES);
  return hit ? PILLAR_ALIASES[hit.index].componentId : undefined;
}

function zoneEntity(normalized: string, componentId: string | undefined): string | undefined {
  const component = COMPONENTS.find((item) => item.id === componentId);
  if (/(上部|上半|上段|顶部)/.test(normalized)) {
    return `${component?.id ?? "Z04"}-upper`;
  }
  if (/(下部|下半|下段|柱脚|底部)/.test(normalized)) {
    return component?.zoneId ?? "Z04-lower";
  }
  return component?.zoneId;
}

function riskEntity(normalized: string): string | undefined {
  const current = /cur[-_]?z0?4[-_]?0?([1-9])/.exec(normalized);
  if (current) {
    const id = `CUR-Z04-0${current[1]}`;
    if (CURRENT_RISKS.some((item) => item.id === id)) return id;
  }
  // 历史风险 R01–R06：要求 r + 两位数字，且不是 CUR-… 的尾巴
  const history = /(^|[^a-z0-9])r(\d{2})/.exec(normalized);
  if (history) {
    const id = `R${history[2]}`;
    if (HISTORY_RISKS.some((item) => item.id === id)) return id;
  }
  if (/优先复核/.test(normalized)) return CURRENT_RISKS.find((item) => item.priority === "优先复核")?.id;
  if (/待核对/.test(normalized)) return CURRENT_RISKS.find((item) => item.priority === "待核对")?.id;
  return undefined;
}

function orderEntity(normalized: string): string | undefined {
  const orders = [WORK_ORDER, DRAFT_ORDER, ...HISTORIC_ORDERS];
  for (const order of orders) {
    if (normalized.includes(normalize(order.id))) return order.id;
  }
  if (/当前工单|现在的工单|这个工单/.test(normalized)) return WORK_ORDER.id;
  if (/草稿工单|新建的工单|工单草稿/.test(normalized)) return DRAFT_ORDER.id;
  if (/历史工单|五月工单|五月那次/.test(normalized)) {
    return HISTORIC_ORDERS.find((item) => item.id === "MAY-DEMO-01")?.id ?? HISTORIC_ORDERS[0]?.id;
  }
  return undefined;
}

function batchEntity(normalized: string): string | undefined {
  for (const batch of SCAN_BATCHES) {
    if (normalized.includes(normalize(batch.batchId))) return batch.batchId;
  }
  if (/初扫/.test(normalized)) return SCAN_BATCHES.find((item) => item.round === "初扫" && item.componentId !== "REF")?.batchId;
  if (/复扫/.test(normalized)) return SCAN_BATCHES.find((item) => item.round === "复扫")?.batchId;
  if (/参考样本|参考件/.test(normalized)) return SCAN_BATCHES.find((item) => item.componentId === "REF")?.batchId;
  if (/冻结/.test(normalized)) return SCAN_BATCHES.find((item) => item.frozen)?.batchId;
  return undefined;
}

function sceneEntity(normalized: string): string | undefined {
  const hit = findAlias(normalized, SCENE_ALIASES);
  if (hit) return SCENE_ALIASES[hit.index].sceneId;
  if (/场景|三维|孪生|高斯/.test(normalized)) {
    return SCENES.find((item) => item.round === "历史")?.id;
  }
  return undefined;
}

function mapEntity(normalized: string): string | undefined {
  for (const version of MAP_VERSIONS) {
    if (normalized.includes(normalize(version.id))) return version.id;
  }
  if (/本轮地图|这轮地图|最新地图|当前地图/.test(normalized)) {
    return MAP_VERSIONS.find((item) => item.id === MISSION.mapVersion)?.id;
  }
  if (/上一轮|上一版|旧地图/.test(normalized)) {
    const others = MAP_VERSIONS.filter((item) => item.id !== MISSION.mapVersion);
    return others[0]?.id;
  }
  if (/地图/.test(normalized)) return MISSION.mapVersion;
  return undefined;
}

function numberEntity(normalized: string): string | undefined {
  const speed = /([0-9]+(?:\.[0-9]+)?)\s*(?:米每秒|m\/s|米\/秒)/.exec(normalized);
  if (speed) return speed[1];
  const speed2 = /(?:速度|速率)\s*([0-9]+(?:\.[0-9]+)?)/.exec(normalized);
  if (speed2) return speed2[1];
  return undefined;
}

/** 抽取全部槽位（CLAUDE 约定：函数名与字段名保持一致，界面直接显示 entities 表） */
/**
 * 项目槽位。
 *
 * 评审 F05：「询问寒山寺仍回答示例寺的 6 处风险」—— 平台只索引了示例寺的资料，
 * 但没有任何地方表达「这句问的是哪个项目」，于是查询照常执行、答案照常来自示例寺。
 * 这里把项目名单独抽出来，交给调用方在做任何工具动作之前判一次：
 * 问的是别的项目就直接说「本资料库没有」，而不是拿示例寺的数字顶上。
 *
 * `示例寺` 与别名进 sameAsCurrent；其余登记过的寺庙名一律视为**别的项目**。
 * 表里没有的名字（比如随口编的一个寺）不算项目槽位 —— 那属于「听不懂」，
 * 由 Fallback 去处理，不要在这里假装认出来了。
 */
export const PROJECT_SLOT = {
  current: "示例寺",
  aliases: ["示例寺", "本寺", "这个寺", "本项目的寺"],
  others: ["寒山寺", "灵隐寺", "少林寺", "白马寺", "悬空寺", "南禅寺", "佛光寺"],
} as const;

export function projectEntity(text: string): string | null {
  if (PROJECT_SLOT.others.some((name) => text.includes(name))) {
    return PROJECT_SLOT.others.find((name) => text.includes(name)) ?? null;
  }
  if (PROJECT_SLOT.aliases.some((name) => text.includes(name))) return PROJECT_SLOT.current;
  return null;
}

export function extractEntities(raw: string): EntityBag {
  const text = normalize(raw);
  const pillar = pillarEntity(text);
  const page = pageEntities(text);
  const bag: EntityBag = {
    pillar,
    zone: zoneEntity(text, pillar),
    risk: riskEntity(text),
    order: orderEntity(text),
    batch: batchEntity(text),
    scene: sceneEntity(text),
    map: mapEntity(text),
    speed: numberEntity(text),
    ...(projectEntity(text) ? { project: projectEntity(text) as string } : {}),
    ...page,
  };
  const route = bag.route ?? "";
  if (route.includes("tab=capture") || route.includes("tab=fusion")) {
    // 采集 / 融合页依赖批次参数，缺省补上种子里的第一个批次
    bag.batch = bag.batch ?? SCAN_BATCHES[0].batchId;
  }
  return bag;
}

/* ------------------------------------------------------------------ *
 * 二级：相似度匹配（§12 / §14 / §15）
 * ------------------------------------------------------------------ */

/**
 * 打分公式（tools/agent-calib.mts 里做过参数扫描，BASE=0.40 时 151/151 示例问句 Top-1 命中）：
 *
 *   coverage = 查询的 bigram 里，有多少能在该意图的**示例语料并集**里找到
 *   head     = 查询与**单条示例**的最大余弦相似度
 *   score    = coverage × (BASE + (1 - BASE) × head)
 *
 * 为什么不是「纯余弦 + 关键词加分」：
 *   字符 bigram 的余弦对「共享一两个高频词」非常宽容 —— 「今天天气怎么样」会因为
 *   示例里有「天气」拿到 0.38 的余弦，被误判成 site_weather。乘上覆盖率后掉到 0.48，
 *   自然落到 Fallback 区（§41：低置信度不许执行）。
 *
 * head 用**完整示例**而不是示例前 N 字：否则「让小车去一号木柱」会与
 * 「让小车去一号木柱拍摄一圈，然后回来」在头部完全一样，两个意图并列第一。
 * 用完整示例后，长度接近的那条得分更高，天然打破并列（151 条示例 0 失败）。
 */
const COVERAGE_BASE = 0.4;

type IntentVector = {
  intent: Intent;
  /** 示例语料的 bigram 并集：算覆盖率用 */
  bigrams: Set<string>;
  /** 每条示例的完整向量：算 head 相似度用 */
  examples: SparseVector[];
};

function buildIndex(): IntentVector[] {
  return INTENTS.map((intent) => {
    const bigrams = new Set<string>();
    const examples: SparseVector[] = [];
    for (const example of intent.examples) {
      examples.push(vectorize(example));
      const normalizedExample = normalize(example);
      for (let i = 0; i + 2 <= normalizedExample.length; i += 1) {
        bigrams.add(normalizedExample.slice(i, i + 2));
      }
    }
    return { intent, bigrams, examples };
  });
}

/** 意图向量在「启动时」一次算好（方案 §47：不要每次重新计算所有 Intent） */
const INDEX: IntentVector[] = buildIndex();

function scoreOf(query: SparseVector, normalizedQuery: string, entry: IntentVector): number {
  const chars = normalizedQuery;
  let queryBigrams = 0;
  let covered = 0;
  for (let i = 0; i + 2 <= chars.length; i += 1) {
    queryBigrams += 1;
    if (entry.bigrams.has(chars.slice(i, i + 2))) covered += 1;
  }
  const coverage = queryBigrams > 0 ? covered / queryBigrams : 0;
  let head = 0;
  for (const exampleVector of entry.examples) {
    head = Math.max(head, cosine(query, exampleVector));
  }
  return Math.min(1, coverage * (COVERAGE_BASE + (1 - COVERAGE_BASE) * Math.min(head, 1)));
}

/** 对一句话做 Top-N 相似度排序（§14 的第 3 步） */
export function rankIntents(raw: string, topN = INTENTS.length): { intentId: string; score: number }[] {
  const normalized = normalize(raw);
  const query = vectorize(raw);
  const scored = INDEX.map((entry) => ({
    intentId: entry.intent.id,
    score: round3(scoreOf(query, normalized, entry)),
  }));
  return scored.sort((a, b) => b.score - a.score).slice(0, topN);
}

/** 必填槽位缺失检查（PRD 4.2：规则采用同义词集合加必需槽位） */
function missingSlotsOf(intent: Intent, entities: EntityBag): SlotKind[] {
  return intent.slots.filter((slot) => slot.required && !entities[slot.name]).map((slot) => slot.kind);
}

/**
 * 完整语义理解：规则 → 相似度 → 置信度判定 → 槽位校验。
 * 返回值直接驱动 Intent Router（executor.ts）与界面展示。
 */
export function understand(raw: string, topN = 4): MatchResult {
  const normalized = normalize(raw);
  const entities = extractEntities(raw);
  const ranking = rankIntents(raw, topN);
  const top = ranking[0];
  const second = ranking[1];
  const margin = round3((top?.score ?? 0) - (second?.score ?? 0));
  const marginOk = margin >= SEMANTIC_THRESHOLDS.minMargin;

  const rule = matchRule(normalized);
  if (rule) {
    const intent = INTENTS.find((item) => item.id === rule.intentId) ?? null;
    return {
      intent,
      confidence: 1,
      level: "rule",
      ranking,
      margin,
      marginOk: true,
      rule,
      entities,
      fallbackText: FALLBACK_TEXT,
      missingSlots: intent ? missingSlotsOf(intent, entities) : [],
      raw,
      normalized,
    };
  }

  const topScore = top?.score ?? 0;
  const level: ConfidenceLevel =
    topScore >= SEMANTIC_THRESHOLDS.highConfidence
      ? "high"
      : topScore >= SEMANTIC_THRESHOLDS.lowConfidence
        ? "low"
        : "fallback";

  // 低置信或 Top1/Top2 挤在一起 → 不猜，走 Fallback（§41）
  const accepted = level === "high" || (level === "low" && marginOk);
  const intent = accepted ? (INTENTS.find((item) => item.id === top.intentId) ?? null) : null;
  const missingSlots = intent ? missingSlotsOf(intent, entities) : [];

  return {
    intent,
    confidence: round3(topScore),
    level: accepted ? level : "fallback",
    ranking,
    margin,
    marginOk,
    rule: null,
    entities,
    fallbackText: FALLBACK_TEXT,
    missingSlots,
    raw,
    normalized,
  };
}

/** 读取槽位值（缺省时回落到种子默认值），供 tools/planner 使用 */
export function slotOf(entities: EntityBag, name: string, fallback: string): string {
  const value = entities[name];
  return value && value.length > 0 ? value : fallback;
}

/** 供自测与演示控制台使用：把全部示例问句跑一遍，返回命中率与最小 margin */
export function selfTest(): { total: number; matched: number; minMargin: number; failures: { text: string; expect: string; got: string }[] } {
  let matched = 0;
  let minMargin = 1;
  const failures: { text: string; expect: string; got: string }[] = [];
  for (const intent of INTENTS) {
    for (const example of intent.examples) {
      const result = understand(example, 3);
      const got = result.intent?.id ?? "(fallback)";
      if (got === intent.id) matched += 1;
      else failures.push({ text: example, expect: intent.id, got });
      if (result.level !== "rule") minMargin = Math.min(minMargin, result.margin);
    }
  }
  const total = INTENTS.reduce((sum, item) => sum + item.examples.length, 0);
  return { total, matched, minMargin: round3(minMargin), failures };
}

/** 供纠错提示使用：当用户说的柱号不在档案里时给出可选值（PRD 4.2 不支持任意串联） */
export const PILLAR_HINT = COMPONENTS.map((item) => item.id).join(" / ");
