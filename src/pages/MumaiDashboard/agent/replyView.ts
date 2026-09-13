/**
 * 小木 · 回复视图模型（语音入口与文字入口**共用这一份**）
 *
 * ── 为什么要有这个模块（PRD §10.2 / 评审 §3.8）──────────────────
 *
 * 平台有两个小木入口：右侧文字助手、语音控制台。它们的**执行**已经统一
 * （都走 `executor.ask` → 同一份意图目录 → 同一个工具白名单），
 * 但**输出**一直各算各的：
 *   · 文字助手 `SmallWoodPanel` 自己有一份 `searchDocs` 做资料检索；
 *   · 语音侧 `BotTurn` 里压根没有"资料引用"这个字段。
 * 于是同一个天气问题，两个入口能给出不同的引用（或者一个有引用、一个没有），
 * 而 PRD 4.2 要求"同一个问题在两个入口答案一致"。
 *
 * 解决办法不是让两边互相同步，而是**只留一个来源**：
 *   · 检索、事实整形、时间戳、声明提取 → 全部收在本文件；
 *   · 两个入口都从 `buildReplyView()` 拿数据，只负责各自的渲染。
 *
 * 本文件**不引入任何新依赖，也不产生任何新的业务数字** ——
 * 它只是把既有的 `BotTurn.facts` 和知识库文档重新整形给界面用。
 */

import { KNOWLEDGE_DOCS, KNOWLEDGE_META } from "../seed/scenario";
import { knowledgeDeepLink, sourcesOf } from "./facts";
import { intentById } from "./intents";
import type { BotTurn } from "./types";

/** 一条可追溯的资料引用 */
export type ReplySource = {
  /** 文档标题，例如「示例寺近三个月归档天气档案」 */
  title: string;
  /** 原文位置，格式 `章节 · 块号`，例如「降水与湿度 · w-01」 */
  locator: string;
  /** 块号，点击时用来定位原文 */
  chunkId: string;
  /** 命中的原文片段（点击后展示） */
  excerpt: string;
  /** 点击后的落点（知识库页面） */
  route: string;
  score: number;
};

/**
 * 本地关键词检索（PRD 5.2 首版检索）。
 *
 * **这是全平台唯一的实现**：文字助手原来自己抄了一份在 `SmallWoodPanel.tsx` 里，
 * 语音侧没有。两份实现必然漂移，所以合并到这里，两处都 import 它。
 */
export function searchKnowledge(text: string, topK = KNOWLEDGE_META.topK): ReplySource[] {
  const chars = Array.from(new Set(text.replace(/\s/g, ""))).slice(0, 40);
  if (chars.length === 0) return [];
  const scored: ReplySource[] = [];
  for (const doc of KNOWLEDGE_DOCS) {
    for (const chunk of doc.chunks) {
      let hit = 0;
      for (const ch of chars) if (chunk.text.includes(ch)) hit += 1;
      const score = hit / chars.length;
      if (score > KNOWLEDGE_META.noHitThreshold) {
        scored.push({
          title: doc.title,
          locator: `${chunk.section} · ${chunk.chunkId}`,
          chunkId: chunk.chunkId,
          excerpt: chunk.text,
          route: knowledgeDeepLink(doc.docId, chunk.chunkId),
          score,
        });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 一个可以直接渲染的回复 */
export type ReplyView = {
  /** 主回答。**永远不许折叠** —— 归档/非实时这类声明就写在它里面 */
  mainAnswer: string;
  /** 结构化业务状态（来自 executor 的事实表，不是从文本里抠的） */
  facts: { k: string; v: string }[];
  /** 资料引用：可折叠，但必须可点击追溯到原文位置 */
  sources: ReplySource[];
  /** 本轮实际生成时间 `HH:mm:ss`（来自 BotTurn.at，不是渲染时刻） */
  at: string;
  intentName: string;
  intentId: string | null;
  confidence: number;
  level: string;
  /** 这轮为什么这么答（低置信 / 回退 / 待确认…） */
  note: string;
  /** 语音包标签 */
  voice: string;
  /** 是否在等用户确认高风险动作 */
  awaitingConfirm: boolean;
};

/**
 * 把一轮小木回复整形给界面。
 *
 * @param turn  执行器产出的一轮回复
 * @param query 触发这轮的原始问句 —— **引用检索用它**，不用回复正文：
 *              回复正文里全是"归档天气档案""梅雨期"这类词，
 *              拿它去检索会把无关文档也捞进来，而用户的问句才代表他问的是什么。
 */
export function buildReplyView(turn: BotTurn, query: string): ReplyView {
  /**
   * 引用优先取**意图声明**的那条（`sourcesOf`），检索只作兜底。
   *
   * ── 为什么必须改成声明式（这是实测暴露的问题）────────────────────
   * 初版只用字符重叠检索决定引用。实测今天它"恰好"命中了要求的
   * `示例寺近三个月归档天气档案 / 降水与湿度 · w-01`，但同时还带出
   * 一条无关文档 —— 也就是说它命中靠的是**检索运气**：一旦调整检索参数、
   * 补充资料或改写问句，引用就会漂移，而 PRD FR-05 要求引用必须**可追溯**。
   *
   * 现在：意图在 `intents.ts` 里声明"我这条答案依据哪个文档的哪一块"
   * （`response.sources`），这里按声明解析；没有声明的意图才退回检索。
   */
  const declared = sourcesOf(intentById(turn.intentId));
  /**
   * 检索词 = 用户问句 + 命中的意图名。
   *
   * 为什么补上意图名：用户可能只说「查近三个月天气」，
   * 而知识库里那段讲的是"降水与湿度"—— 单靠问句的字面重叠捞不到。
   */
  const searchText = `${query} ${turn.intentName}`;
  return {
    mainAnswer: turn.text,
    facts: turn.facts.map((fact) => ({ k: fact.key, v: fact.value })),
    sources: declared.length
      ? declared.map((ref) => ({ ...ref, score: 1 }))
      : searchKnowledge(searchText),
    at: turn.at,
    intentName: turn.intentName,
    intentId: turn.intentId,
    confidence: turn.confidence,
    level: turn.level,
    note: turn.note,
    voice: turn.voice,
    awaitingConfirm: false,
  };
}

/** 从会话流里取最后一条小木回复（气泡只显示最近交互，不铺全屏历史） */
export function latestBotTurn(turns: readonly { kind: string }[]): BotTurn | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.kind === "bot") return turn as BotTurn;
  }
  return null;
}

/** 从会话流里取最后一条用户输入（气泡里的用户话） */
export function latestUserText(turns: readonly { kind: string; text?: string }[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.kind === "user") return turn.text ?? "";
  }
  return "";
}
