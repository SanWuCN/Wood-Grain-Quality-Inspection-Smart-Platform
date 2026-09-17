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
 * 本项目用 INTENTS 里全部示例问句（当前 31 条意图 / 170 条，含同义改写）做了参数扫描与标定
 * （脚本：tools/agent-calib.mts；覆盖率权重 BASE 由扫描确定为 0.40）：
 *   Top-1 命中 170/170 = 100%，示例问句里 0 条落入 Fallback；
 *   边界问句（「今天天气怎么样」「把数据库删了」「你好」）全部正确落到 Fallback。
 * 标定后**没有**下调 0.82/0.68/0.08：字符 bigram 的类内相似度天然偏高，
 * 保留方案原值反而更严格 —— 分数落在 [0.68, 0.82) 的请求会走「低置信」路径，
 * 先回答再说明不确定，而不是直接执行高风险动作（§41 / §58 Safety）。
 *
 * ⚠ 这个 100% 是**示例自匹配**：每条示例都拿自己所属意图的语料去比，得分必然 1.000。
 * 它能证明「语料没写错别字、意图之间没有互相抢到 Top1」，**不能**证明阈值选得对，
 * 也发现不了「近义意图把 margin 吃掉」。阈值是否合适要看下面两条：
 *   · `tools/agent-calib.mts` 的**边界问句**段（不在示例集里，必须落 Fallback）；
 *   · 具体意图之间的护栏测试，例如
 *     `agent/patrolRiskSummary.test.ts` 钉住「查近三个月天气」仍归 site_weather
 *     且 margin 仍高于 min_margin（新增语料把它从 1.000 吃到 0.524 那次教训）。
 * 数字会随语料变化：改 examples 后请重跑脚本，并把本段里的条数改成**当时的实测值**，
 * 同时留意近义意图的 margin 护栏测试是否仍然通过（`patrolRiskSummary.test.ts`
 * 钉天气句、`introduceSelf.test.ts` 钉「介绍自己 / 介绍平台」这一对）。
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

/**
 * 「打开 / 进入 / 跳转 + 页面名」的一级规则用到的句式。
 *
 * 页面名是**确定性**的（写死在 NAV_ITEMS / ADAPT_TABS 里），不该让「打开脚本」
 * 这种 4 字短句去跟示例语料算相似度：字符 bigram 在短句上覆盖不足，实测八个一级页面里
 * 有四个（任务总览 / 工单档案 / 建图巡检 / 数字孪生）的「打开<label>」会掉进 Fallback——
 * 用户把页面名说对了，小木反而没反应。句式只截取「动词 + 页面说法」，
 * 页面说法是否成立由 `isPagePhrase()` 查别名表决定（见下方词典区）。
 */
const NAV_PAGE_PATTERN = /^(?:(?:请|帮我|帮忙|给我|麻烦|小木|你好))*(?:打开|进入|跳转(?:到)?|切换到?)(.{1,12})$/;

/** 规则表：按顺序匹配，先命中者生效（长词在前，避免「取消」吃掉「取消巡检」） */
const RULES: {
  intentId: string;
  pattern: RegExp;
  reason: string;
  label: string;
  /** 可选的二次判定：正则命中后还要过这一关才算命中（页面名必须精确落在别名表里） */
  guard?: (hit: RegExpExecArray) => boolean;
}[] = [
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
  {
    /*
      页面导航规则，**放在最后**：停止 / 返回 / 装载地图 / 开始建图的既有优先级不变
      （「切换地图」仍然先命中 load_map，不会被这里的「切换到」句式抢走）。
      guard 要求「动词后面那段话」精确落在页面别名表里，所以
      「打开当时的高斯场景」「打开旧场景对比一下外观」这类带修饰的说法不会被它截走，
      仍然交给相似度匹配（scene 类意图）。
    */
    intentId: "open_page",
    pattern: NAV_PAGE_PATTERN,
    guard: (hit) => isPagePhrase(hit[1] ?? ""),
    reason: "命中「打开 / 进入 / 跳转 + 页面名」确定性规则（§11：页面名与 NAV_ITEMS / ADAPT_TABS 的别名表同源，不靠相似度猜）",
    label: "打开页面",
  },
];

/** 规范化后的文本做规则匹配 */
export function matchRule(normalized: string): RuleHit | null {
  for (const rule of RULES) {
    const hit = rule.pattern.exec(normalized);
    if (hit && (!rule.guard || rule.guard(hit))) {
      return { intentId: rule.intentId, reason: rule.reason, phrase: hit[0] };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 词典：页面 / 构件 / 场景 / 地图 / 批次（§17 Regex + Dictionary）
 * ------------------------------------------------------------------ */

/**
 * 一级页面的同义说法：**按 NAV key 挂，不按数组下标**。
 *
 * 这里原来是 `{ page: NAV_ITEMS[5].label, route: NAV_ITEMS[5].path, aliases: ["知识库", …] }`
 * 这种写法 —— 别名组一行一行地跟导航项按下标对齐。NAV_ITEMS 后来把「检测适配」拆成
 * 「硬件详情 + 固件及模型」（design.ts 的注释与 pages/Firmware.tsx 都说明了这次拆页），
 * 又把「演示控制台」移出八项一级导航，下标整体漂移，而代码本身**不会报任何错**：
 *   「打开知识库」→ /firmware、「打开报告归档」→ /knowledge、「打开演示控制台」→ /archive。
 * 改成按 key 查表后，导航项增删只影响它自己那一行，别的说法不会再跟着漂；
 * 新增 NAV key 时这里即使忘了补同义说法，也还有它的 label 兜底（不会指错页面）。
 */
const PAGE_ALIAS_EXTRAS: Record<string, string[]> = {
  overview: ["总览", "首页", "概览", "态势", "全国态势", "上海态势"],
  orders: ["工单", "工单列表", "档案", "当前工单", "工单页"],
  mapping: ["建图", "巡检", "巡检任务", "巡检页面", "巡航任务", "任务中心", "小车任务", "地图页", "slam"],
  twin: ["孪生", "三维", "三维模型", "高斯场景", "场景页面", "点云", "地图"],
  hardware: ["硬件", "设备详情", "硬件监看"],
  firmware: ["固件", "模型", "固件模型", "版本管理"],
  knowledge: ["资料库", "检索", "资料", "知识库页面"],
  report: ["归档", "报告", "校验", "报告页"],
};

/**
 * 页签 → 宿主页面 key（是 NAV key，不是下标）。
 *
 * design.ts 的 ADAPT_TABS 只说页签自己（key / label / icon），不说它挂在哪个页面，
 * 宿主必须另说一句。按拆页后的实际路由写：采集 / 异常排查在「硬件详情」，
 * 数据集 / 训练验证 / 更新交付 / 融合分析在「固件及模型」——与 tools.ts 的 open_panel、
 * pages/Hardware.tsx 与 pages/Firmware.tsx 里的页签一致。
 * 这里原来写死的是 `PAGE_ALIASES[4]`（旧「检测适配」页 /adapt）：拆页后这个下标变成了
 * 「硬件详情」，于是数据集 / 训练验证 / 更新交付 / 融合分析四个页签全被送到 /hardware。
 */
const ADAPT_TAB_HOST_KEY: Record<string, string> = {
  capture: "hardware",
  triage: "hardware",
  dataset: "firmware",
  training: "firmware",
  delivery: "firmware",
  fusion: "firmware",
};

/** 页签的额外说法；页签名一律由 ADAPT_TABS 派生，不在这里重抄一遍 */
const ADAPT_TAB_EXTRA_ALIASES: Record<string, string[]> = {
  capture: ["采集作业", "手持采集", "原始数据"],
  triage: ["排查"],
  dataset: ["清洗", "划分"],
  training: ["训练", "模型对比", "验证"],
  delivery: ["交付", "更新包", "下发"],
  fusion: ["融合"],
};

/**
 * 排练控制台（`/console`）—— 唯一不在八项一级导航里的页面。
 *
 * PRD §11「管理员排练控制独立于日常岗位」：它刻意不进 NAV_ITEMS（design.ts 的说明），
 * 入口在顶栏账号菜单旁，只有 console:admin 看得见（auth.ts 的 ROUTE_PERMISSION）。
 * 因此它没有 NAV key 可挂，只能单列一条，路由抄自 routes.tsx。
 * **不要**因为「它不在 NAV_ITEMS 里」就把它塞进某个导航项名下 —— 那正是这次错位的成因。
 */
const CONSOLE_PAGE = {
  label: "排练控制台",
  path: "/console",
  aliases: ["排练控制台", "演示控制台", "控制台", "演示控制", "演示台", "脚本"],
} as const;

/** 别名 = 页面/页签自己的 label + 同义说法（去重，label 在前） */
function aliasesWithLabel(label: string, extras: string[] | undefined): string[] {
  return [...new Set([label, ...(extras ?? [])])];
}

/** NAV key → 导航项（宿主页面、别名表都只按 key 找） */
function navItemOf(key: string): (typeof NAV_ITEMS)[number] | undefined {
  return NAV_ITEMS.find((item) => item.key === key);
}

/** 页面名词典：page / route 全部来自 NAV_ITEMS，别名按 NAV key 对齐 */
export const PAGE_ALIASES: { page: string; route: string; aliases: string[] }[] = [
  ...NAV_ITEMS.map((item) => ({
    page: item.label,
    route: item.path,
    aliases: aliasesWithLabel(item.label, PAGE_ALIAS_EXTRAS[item.key]),
  })),
  { page: CONSOLE_PAGE.label, route: CONSOLE_PAGE.path, aliases: [...CONSOLE_PAGE.aliases] },
];

/** 页签别名 → ADAPT_TABS.key（route 上加 ?tab=）；key 取自 ADAPT_TABS，不按下标 */
export const ADAPT_TAB_ALIASES: { key: string; aliases: string[] }[] = ADAPT_TABS.map((tab) => ({
  key: tab.key,
  aliases: aliasesWithLabel(tab.label, ADAPT_TAB_EXTRA_ALIASES[tab.key]),
}));

/**
 * 页面说法的**精确**集合，供一级规则判定用（'打开脚本' 这种短句在相似度里够不到阈值，
 * 但页面名本身是确定性的）。集合与上面两张别名表同源，别名表改了就自动跟上。
 */
const PAGE_PHRASES = new Set<string>();
for (const entry of PAGE_ALIASES) for (const alias of entry.aliases) PAGE_PHRASES.add(normalize(alias));
for (const entry of ADAPT_TAB_ALIASES) for (const alias of entry.aliases) PAGE_PHRASES.add(normalize(alias));

/** 「打开 / 进入 / 跳转 + 页面名」的规则判定（也认「…页面 / …页」这种说法） */
function isPagePhrase(phrase: string): boolean {
  if (PAGE_PHRASES.has(phrase)) return true;
  const stripped = phrase.replace(/(?:页面|页)$/, "");
  return stripped.length > 0 && PAGE_PHRASES.has(stripped);
}

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

/**
 * 在一张别名表里找**最先出现、且更长**的说法。
 *
 * 返回的是条目本身，不是下标 —— 调用方不需要知道它在表里的位置，
 * 这样导航项 / 页签增删都不会牵动调用方（下标漂移正是这次跳错页面的根因）。
 */
function findAlias<T extends { aliases: string[] }>(
  text: string,
  entries: readonly T[],
): { entry: T; alias: string; matched: string } | null {
  let best: { entry: T; alias: string; matched: string } | null = null;
  let bestAt = -1;
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const needle = normalize(alias);
      if (!needle) continue;
      const at = text.indexOf(needle);
      if (at < 0) continue;
      // 取最先出现、且更长的别名（长别名更具体，「一号木柱」优先于「一号」）
      const better = best === null || at < bestAt || (at === bestAt && needle.length > best.alias.length);
      if (better) {
        best = { entry, alias: needle, matched: alias };
        bestAt = at;
      }
    }
  }
  return best;
}

function pageEntities(normalized: string): EntityBag {
  // 先看页签（页签是宿主页面里的一个视图，说法更具体），再落到一级导航
  const tab = findAlias(normalized, ADAPT_TAB_ALIASES);
  if (tab && tab.alias.length >= 2) {
    const tabEntry = ADAPT_TABS.find((item) => item.key === tab.entry.key);
    const host = navItemOf(ADAPT_TAB_HOST_KEY[tab.entry.key] ?? "");
    // 宿主页面没登记（ADAPT_TABS 新增了页签、这张宿主表还没跟上）→ 不猜，落到一级导航/Fallback
    if (tabEntry && host) {
      return {
        page: host.label,
        pageLabel: `${host.label} · ${tabEntry.label}`,
        route: `${host.path}?tab=${tabEntry.key}`,
      };
    }
  }
  const page = findAlias(normalized, PAGE_ALIASES);
  if (!page) return {};
  return { page: page.entry.page, pageLabel: page.entry.page, route: page.entry.route };
}

/** 「三号木柱」这类说法里，位次词优先于 id 匹配，避免 Z03 与「三号」冲突 */
function pillarEntity(normalized: string): string | undefined {
  return findAlias(normalized, PILLAR_ALIASES)?.entry.componentId;
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
  if (hit) return hit.entry.sceneId;
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
 * 打分公式（tools/agent-calib.mts 里做过参数扫描，BASE=0.40 时 170/170 示例问句 Top-1 命中）：
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
 * 用完整示例后，长度接近的那条得分更高，天然打破并列（当前 170 条示例 0 失败）。
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
      /**
       * 示例侧一律用**归一化后**的串建向量，与查询侧同一口径。
       *
       * 原来这里是 `vectorize(example)`（原始串），而查询侧的 query 用归一化串 ——
       * 两边口径不一致的代价实测过：用户在语料里原样念一句，只要那句含有会被
       * 折叠的字（例如「巡检」里的字被折叠过），head 就凑不满、得分凑不到 1.000。
       */
      const normalizedExample = normalize(example);
      examples.push(vectorize(normalizedExample));
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
  /**
   * 查询向量必须用**归一化后**的串，不能用原始串。
   *
   * ── 这是本次实测挖出来的根因，值得写清楚 ────────────────────────
   * 原来这里是 `vectorize(raw)`，于是语音容错层（`lang.ts` 的 PHRASE_FIXES）
   * **只作用到 coverage，head（余弦）那一项还在拿错字去比干净示例** ——
   * 折叠等于只做了一半。实测对比：
   *
   *   「开始寻检」（巡检被听成寻检）
   *     折叠后 normalized = 「开始巡检」（正确！）
   *     但用 vectorize(raw) 算 head → 总分 0.635 → **判成未命中**
   *     改用 vectorize(normalized) → 与示例完全一致 → 1.000
   *
   * 也就是说：容错表写对了、normalize() 也折叠对了，但分数纹丝不动 ——
   * 只看 normalize 的输出根本发现不了，必须看**最终得分**。
   */
  const query = vectorize(normalized);
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
