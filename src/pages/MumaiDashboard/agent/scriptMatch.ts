/**
 * 小木脚本化交互的**模糊匹配**
 *
 * ── 为什么不能直接用语义向量匹配 ────────────────────────────────────
 * `matcher.ts` 的 `rankIntents()` 走的是 bigram 稀疏向量 + 余弦，
 * 判据是「整句与意图示例的相似度」。这套对**意图识别**很好，但对**对台词**不行：
 *   · 台词稿里一轮有 3~5 个触发说法，用户实际只会说其中一句的一部分；
 *   · ASR 会错字（"四柱"→"四住"）、会把词切错（"工单"→"公单"）；
 *   · 20 轮的用词彼此接近（⑯"汇总新旧模型的验证结果" vs ⑫"汇总本次异常证据"），
 *     整句余弦容易把它们排到接近的分数上。
 * 所以这里用**关键词组覆盖率**为主判据，并要求与第二名拉开距离（margin）。
 *
 * ── 打分模型 ────────────────────────────────────────────────────────
 * 对每一轮的每个触发说法 t，先算「用户说的话 u 里，t 的字符被覆盖了多少」：
 *
 *   coverage(u, t) = 命中 t 的字符数 / t 的字符总数      （顺序无关，容忍错位）
 *
 * 但只看覆盖率会偏爱**短**触发词（"工单"两个字很容易被覆盖）。
 * 所以再乘一个**长度可信度**：触发词越长，命中它越说明问题。
 *
 *   credibility(t) = min(1, len(t) / 6)                （6 字以上视为完全可信）
 *   score(round)   = max over t of  coverage(u,t) × credibility(t)
 *
 * 逐字匹配用**归一化后的字符**，并做同音近似（见 HOMOPHONE_GROUPS）——
 * ASR 最常见的错误是同音字，这一步比调阈值有效得多。
 *
 * ── 收口条件（三条同时满足才算命中，避免乱答）──────────────────────
 *   1. score ≥ MATCH_THRESHOLD
 *   2. 与第二名的差 ≥ MIN_MARGIN（否则说明这 20 轮里有歧义，宁可反问）
 *   3. 命中触发的字符数 ≥ MIN_HIT_CHARS（防止两个字碰巧撞上就播一整段台词）
 */

import { charsOf, normalize } from "./lang.ts";
import { PINYIN } from "./scriptPinyin.ts";
import { mainLineOf, SCRIPT_ROUNDS, type ScriptRound } from "./script.ts";

export const MATCH_THRESHOLD = 0.62;
export const MIN_MARGIN = 0.06;
export const MIN_HIT_CHARS = 3;

/**
 * 同音/近音归并组。
 *
 * 只收**这一份剧本里真实出现过、且 ASR 高频混**的字，不做通用同音表：
 * 通用表会把「四柱」和「四住」之外的无关词也并到一起，反而制造误命中。
 * 每组的第一个字是"标准写法"，其余是会被归并过来的常见误听。
 */
const HOMOPHONE_GROUPS: string[][] = [
  ["柱", "住", "注", "筑"],       // 四柱 / 四住
  ["单", "丹", "担"],             // 工单 / 工丹
  /*
    清洗 / 清晰 / 青洗 —— 真机实测到的那一条：用户说"数据清洗"，
    ASR 输出"数据清晰"，于是整轮匹配掉到阈值以下、回了兜底。
    这两个词同音（qīng xǐ / qīng xī），是 ASR 最容易混的一类，必须收进来。
  */
  ["洗", "晰", "悉", "夕", "希"],
  ["清", "青", "轻"],
  ["审", "沈", "婶"],             // 审核 / 沈核（剧本里"沈"是人名，仅作近似）
  ["标", "彪", "镖"],             // 标定 / 彪定
  ["复", "覆", "腹"],             // 复核 / 覆核
  ["核", "合", "河"],             // 核对 / 合对
  ["融", "容", "荣"],             // 融合 / 容合
  ["疑", "义", "易"],             // 疑点 / 义点
  ["采", "彩", "踩"],             // 补采 / 补彩
  ["模", "摸", "摩"],             // 模型 / 摸型
  ["训", "寻", "巡"],             // 训练 / 寻练
  ["划", "化", "画"],             // 划分 / 化分
  ["据", "剧", "巨"],             // 数据 / 数剧
  ["验", "严", "言"],             // 验证 / 严证
  ["账", "帐"],                   // 台账 / 台帐
  ["巡", "询", "循"],             // 巡检 / 询检
  ["检", "简", "减"],             // 检查 / 简查
  ["档", "当", "挡"],             // 建档 / 建当
  ["缝", "逢", "冯"],             // 渗漏缝 / 渗漏逢
];

/** 误听字 → 标准字（手写的小表，只收高频且拼音表覆盖不到的例外） */
const CANONICAL: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of HOMOPHONE_GROUPS) {
    const head = group[0];
    for (const ch of group) map.set(ch, head);
  }
  return map;
})();

/**
 * 归一化 + **解码**后的字符序列 —— 匹配真正比对的就是它。
 *
 * 解码 = 手写同音组优先 → 拼音 → 原字。见 `decodeChar` 的说明。
 */
export function canonicalChars(raw: string): string[] {
  return charsOf(normalize(raw)).map((ch) => decodeChar(ch));
}

/**
 * 一个字符的**解码码**：手写同音组优先，其次取拼音，最后回落到它自己。
 *
 * ── 为什么要拼音这一层（真机实测逼出来的）────────────────────────────
 * 用户说「数据清洗」、ASR 输出「数据清晰」。原先只有手写同音组一条路，
 * 我必须**手工**把「洗 / 晰」并成一组才能修好 —— 那意味着每遇到一个新误听
 * 都要改一次代码，迟早会漏。
 * 拼音是同一件事的正确形式：`清` 与 `晰` 都是 `qing`，自动等价。
 * 表由 `tools/xiaomu/生成拼音表.mjs` 离线生成（只收剧本用到的 527 个字），
 * 运行时**零依赖**。
 *
 * ⚠ 顺序是先手写组、后拼音：手写组是可以覆盖拼音的**例外通道**
 *   （例如把某个字强行归到另一组），保留它便于局部微调而不必动生成流程。
 */
export function decodeChar(ch: string): string {
  const manual = CANONICAL.get(ch);
  if (manual) return manual;
  const py = PINYIN[ch];
  return py ? "py:" + py : ch;
}

/** 解码后的字符序列 */
export function decodedChars(raw: string): string[] {
  return charsOf(normalize(raw)).map((ch) => decodeChar(ch));
}

/** 一个触发说法的匹配明细，界面与测试都用得上 */
export type TriggerHit = {
  roundNo: string;
  trigger: string;
  /** 命中的字符数 */
  hitChars: number;
  /** 触发说法的字符总数 */
  totalChars: number;
  coverage: number;
  credibility: number;
  score: number;
};

export type ScriptMatch = {
  round: ScriptRound;
  score: number;
  /** 得分第二高的轮次（用于判断歧义） */
  runnerUp: { round: ScriptRound; score: number } | null;
  margin: number;
  /** 本轮所有触发说法的命中明细，按得分降序 */
  hits: TriggerHit[];
  /** 判定结论 */
  verdict: "hit" | "ambiguous" | "too-weak" | "none";
  /** 给界面/日志的一行人话解释 */
  reason: string;
};

/**
 * 覆盖率：u 覆盖了 t 的多少字符。
 *
 * 用**多重集合计数**而不是子串匹配 —— 用户会把词序说乱、会漏字，
 * 子串匹配在这种情况下直接归零，而计数覆盖仍能给出合理分数。
 */
export function coverageOf(uChars: string[], tChars: string[]): number {
  if (!tChars.length) return 0;
  const pool = new Map<string, number>();
  for (const ch of uChars) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of tChars) {
    const left = pool.get(ch) ?? 0;
    if (left > 0) {
      hit += 1;
      pool.set(ch, left - 1);
    }
  }
  return hit / tChars.length;
}

/**
 * 触发说法的**可信度**：越长越可信，避免短词碰巧撞上就播一整段台词。
 *
 * ⚠ 曲线改过一次，原因是**真机实测**出的缺陷：
 *   原实现是 `min(1, len / 6)` —— 4 个字的触发词（如「数据清洗」）只得 0.667，
 *   再乘覆盖率就掉到 0.33，**够不到 0.62 的阈值**。
 *   而"只说关键词"恰恰是最常见的用法：用户不会念整句
 *   「启动数据清洗，列出需要人工审核的记录」，只会说「数据清洗」。
 *   于是短关键词被**系统性惩罚** —— 实测现象是用户说「数据清洗」小木回兜底。
 *
 * 现在改成阶梯：**4 字及以上满分**，3 字 0.85，2 字 0.6，1 字 0。
 * 2 字仍拿不到 0.62（`MIN_HIT_CHARS` 也要求至少命中 3 字），
 * 所以"只说「工单」就播一整轮台词"不会发生。
 */
export function credibilityOf(tChars: string[]): number {
  const n = tChars.length;
  if (n <= 1) return 0;
  if (n === 2) return 0.6;
  if (n === 3) return 0.85;
  return 1;
}

function hitsOfRound(round: ScriptRound, uChars: string[]): TriggerHit[] {
  return round.triggers
    .map((trigger) => {
      const tChars = canonicalChars(trigger);
      const coverage = coverageOf(uChars, tChars);
      const credibility = credibilityOf(tChars);
      /* 命中的字符数按覆盖率折算，用于 MIN_HIT_CHARS 收口 */
      const hitChars = Math.round(coverage * tChars.length);
      return {
        roundNo: round.roundNo,
        trigger,
        hitChars,
        totalChars: tChars.length,
        coverage: Number(coverage.toFixed(4)),
        credibility: Number(credibility.toFixed(4)),
        score: Number((coverage * credibility).toFixed(4)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 在一句话里找最匹配的剧本轮次。
 *
 * @param utterance 用户说的话（唤醒词之后的整句；调用方负责先把"小木小木"剥掉）
 */
export function matchScriptRound(utterance: string): ScriptMatch | null {
  const uChars = canonicalChars(utterance);
  if (!uChars.length) return null;

  const scored = SCRIPT_ROUNDS.map((round) => {
    const hits = hitsOfRound(round, uChars);
    const best = hits[0];
    return { round, score: best ? best.score : 0, hits, bestHit: best };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;
  const second = scored[1] ?? null;
  const margin = Number((top.score - (second ? second.score : 0)).toFixed(4));

  const hitChars = top.bestHit ? top.bestHit.hitChars : 0;
  const base = {
    round: top.round,
    score: top.score,
    runnerUp: second ? { round: second.round, score: second.score } : null,
    margin,
    hits: top.hits,
  };

  if (top.score < MATCH_THRESHOLD) {
    return {
      ...base,
      verdict: "too-weak",
      reason:
        `最强命中只有 ${top.score.toFixed(2)}（阈值 ${MATCH_THRESHOLD}）：` +
        `「${top.bestHit ? top.bestHit.trigger : "-"}」只覆盖 ${hitChars} 字。`,
    };
  }
  if (hitChars < MIN_HIT_CHARS) {
    return {
      ...base,
      verdict: "too-weak",
      reason: `命中字符太少（${hitChars} < ${MIN_HIT_CHARS}），不足以确定是哪一轮。`,
    };
  }
  if (margin < MIN_MARGIN && second) {
    return {
      ...base,
      verdict: "ambiguous",
      reason:
        `「${top.round.roundNo} ${top.round.title}」与「${second.round.roundNo} ` +
        `${second.round.title}」得分接近（差 ${margin.toFixed(2)}），先反问确认。`,
    };
  }
  return {
    ...base,
    verdict: "hit",
    reason:
      `命中 ${top.round.roundNo}「${top.round.title}」：` +
      `触发说法「${top.bestHit ? top.bestHit.trigger : "-"}」覆盖 ${hitChars} 字，` +
      `得分 ${top.score.toFixed(2)}，领先第二名 ${margin.toFixed(2)}。`,
  };
}

/** 供界面列出候选（不判定，只排序） */
export function rankScriptRounds(utterance: string, topN = 5): { round: ScriptRound; score: number }[] {
  const uChars = canonicalChars(utterance);
  if (!uChars.length) return [];
  return SCRIPT_ROUNDS.map((round) => {
    const hits = hitsOfRound(round, uChars);
    return { round, score: hits[0] ? hits[0].score : 0 };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/**
 * 从一句话里剥出唤醒词之后的部分。
 *
 * 唤醒词本身可能被 ASR 写成"小木小木""小木，小木""小木小沐"等，
 * 所以这里不是精确匹配，而是**在归一化后的串里找最靠前的一次"小木"重复**，
 * 找不到就整句返回（调用方可能已经在播放链路里处理过唤醒词）。
 */
export function stripWakeWord(raw: string): string {
  const normalized = normalize(raw);
  const idx = normalized.indexOf("小木小木");
  if (idx >= 0) return normalized.slice(idx + 4);
  /* 退一步：只出现一次"小木"也当作唤醒词剥掉（唤醒通道已确认叫醒了） */
  const once = normalized.indexOf("小木");
  if (once >= 0) return normalized.slice(once + 2);
  return normalized;
}

/**
 * 唤醒链路的**路由结果**：这句话该由剧本回答，还是交回原有意图链路。
 *
 * ── 为什么把它单独抽出来 ────────────────────────────────────────────
 * `executor.ts` 的 `ask()` 里那一段只有几行，但它决定"这句话走剧本还是走意图"，
 * 是整个功能**唯一的分叉点**。留在 `ask()` 里就只能靠浏览器手测 ——
 * 那个文件的导入链没写 `.ts` 扩展名，Node 原生 ESM 解析不了，单测进不去
 * （实测报 `Cannot find module '../lib'`，链式波及整个模块树）。
 * 抽成这个纯函数之后，"分叉判得对不对"完全可以在单测里钉住，
 * `ask()` 里只剩一行调用。
 *
 * 判据（与 `ask()` 里的注释一致）：
 *   · `verdict === "hit"` 才走剧本 —— 逐字台词是对稿用的，命中就不能被模板文案改写
 *   · `ambiguous`（两轮得分接近）与 `too-weak`（没够阈值）一律交回原链路：
 *     宁可走原本的意图/兜底，也不"猜错轮次播错台词"（演示现场最难堪的错）
 */
export type UtteranceRoute =
  | { kind: "script"; round: ScriptRound; match: ScriptMatch; line: string }
  | { kind: "intent"; match: ScriptMatch | null };

export function routeUtterance(raw: string): UtteranceRoute {
  const utterance = stripWakeWord(raw);
  const m = matchScriptRound(utterance);
  if (m && m.verdict === "hit") {
    return { kind: "script", round: m.round, match: m, line: mainLineOf(m.round) };
  }
  return { kind: "intent", match: m };
}
