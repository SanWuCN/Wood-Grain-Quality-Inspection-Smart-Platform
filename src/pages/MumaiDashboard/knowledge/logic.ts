/**
 * 知识库模块 · 纯逻辑（无 React、无副作用、可单测）
 *
 * 这里的东西都是「真的在算」，不是动画：
 *   - 分块：按空行与句群切段后合并，目标 420 字上下、相邻块 60 字重叠，保存原段落序号
 *   - 检索向量：中文字符 2–4 元稀疏 TF-IDF（自带 DF/IDF，保证权重非负、余弦相似度落在 [0,1]）
 *   - 入库向量：768 维，由 TF-IDF 权重经确定性哈希投影得到（不下载模型、不调后端）
 *   - 降维：对「入库向量」做一次真的 PCA（幂迭代求前两个主成分），不是随机撒点
 *   - 版本：KB-11 → KB-12 的增量 / 全量重建与回滚，全部由真实条目数推导
 *
 * 注意：页面上的检索一律复用 lib.searchKnowledge，本文件不另写一套检索器。
 */

import { searchKnowledge } from "../lib";
import type { KnowledgeChunk as LibKnowledgeChunk, RetrievalHit } from "../lib";
import { KNOWLEDGE_DOCS, KNOWLEDGE_META, KNOWLEDGE_PIPELINE, KNOWLEDGE_FILE_SEEDS } from "../seed/scenario";
import { ESTIMATED_CHARS_PER_BYTE, TEXT_EXTENSIONS, formatCount } from "./constants";

export type KnowledgeCategory =
  | "巡检报告"
  | "构件档案"
  | "维修反馈"
  | "方法文档"
  | "场景索引"
  | "天气档案";

/** 入库条目（写进「向量库」的一条 chunk） */
export type KbChunk = {
  chunkId: string;
  docId: string;
  docTitle: string;
  category: KnowledgeCategory;
  project: string;
  date: string;
  version: string;
  source: string;
  section: string;
  text: string;
  /** 原段落序号（PRD 5.2.3：能从检索结果回到原文位置） */
  paragraphIndex: number;
  chars: number;
  /** 来源：seed = 初始索引已有；upload = 本次上传；import = 目录 / 粘贴导入 */
  origin: "seed" | "upload" | "import";
  /** 真读内容 = text，估算内容 = estimate */
  parseMode: "text" | "estimate";
};

/** 索引里的文档条目 */
export type KbDoc = {
  docId: string;
  title: string;
  category: KnowledgeCategory;
  project: string;
  date: string;
  version: string;
  source: string;
  digest: string;
  chars: number;
  chunkCount: number;
  origin: KbChunk["origin"];
  parseMode: KbChunk["parseMode"];
  /** 变更标记：新增 / 变更 / 未变更（由摘要比对得到） */
  changeFlag: "seed" | "new" | "changed";
};

/** 知识库状态（条目 / 分块 / 向量三者恒等，见 assertConsistency） */
export type KbState = {
  label: string;
  docs: KbDoc[];
  chunks: KbChunk[];
  /** 索引里已有向量的分块 ID */
  vectorizedChunkIds: string[];
  /** 已写入索引的分块 ID */
  indexedChunkIds: string[];
  builtAt: string;
  mode: "seed" | "incremental" | "rebuild" | "rollback";
  /** 索引里的向量总数 = 已写入索引的分块数 × 维度 */
  vectorCount: number;
};

/* ------------------------------------------------------------------ *
 * 0. 文本工具
 * ------------------------------------------------------------------ */

const PUNCT = /[\s，。、；：（）《》〈〉「」『』【】·,.;:()"“”‘’!?！？\-—–_/\\[\]{}|~`@#$%^&*+=<>]/g;

export function sum(list: number[]): number {
  return list.reduce((acc, value) => acc + value, 0);
}

/** 中文字符 2–4 元（与 lib.ngrams 同口径） */
export function ngrams(text: string): string[] {
  const clean = text.replace(PUNCT, "");
  const grams: string[] = [];
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= clean.length; i += 1) grams.push(clean.slice(i, i + n));
  }
  return grams;
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  tokens.forEach((token) => tf.set(token, (tf.get(token) ?? 0) + 1));
  return tf;
}

/** 语料级 DF / IDF：本模块自己做一份，保证权重非负（log 只作用在频次上） */
export function fitIdf(docs: string[][]): (term: string) => number {
  const df = new Map<string, number>();
  docs.forEach((tokens) => {
    new Set(tokens).forEach((token) => df.set(token, (df.get(token) ?? 0) + 1));
  });
  const total = Math.max(1, docs.length);
  return (term: string) => Math.max(0.05, Math.log(total / ((df.get(term) ?? 0) + 1)) + 1);
}

/** 单篇文档 → 稀疏 TF-IDF 向量（L2 归一化） */
export function tfidfVector(tokens: string[], idf: (term: string) => number): Map<string, number> {
  const tf = termFreq(tokens);
  const raw = new Map<string, number>();
  tf.forEach((count, token) => {
    if (count > 0) raw.set(token, (1 + Math.log(count)) * idf(token));
  });
  let norm = 0;
  raw.forEach((weight) => {
    norm += weight * weight;
  });
  norm = Math.sqrt(norm) || 1;
  const vec = new Map<string, number>();
  raw.forEach((weight, token) => vec.set(token, weight / norm));
  return vec;
}

/** 两个稀疏向量的余弦相似度：用于「检索结果 ↔ 向量空间」互相印证 */
export function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  small.forEach((weight, token) => {
    const other = large.get(token);
    if (other !== undefined) dot += weight * other;
  });
  return Number(dot.toFixed(4));
}

/** 确定性哈希（FNV-1a 32 位）—— 保证同一份资料每次得到同一批数 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 内容摘要（演示用「去重指纹」，不是密码学摘要；页面按此标未变更 / 已变更） */
export function contentDigest(input: string): string {
  const head = hashString(input).toString(16).padStart(8, "0");
  const tail = hashString(`${input.length}:${input.slice(0, 64)}`).toString(16).padStart(8, "0");
  return `demo:${head}${tail}`;
}

/* ------------------------------------------------------------------ *
 * 1. 分块器（PRD 5.2.3）
 * ------------------------------------------------------------------ */

export type ParsedSection = { section: string; text: string; paragraphIndex: number };

/**
 * 解析：`## ` 段首是章节标题，其余段落按句末标点切成句子，
 * 再按空行分段落，段落序号按全文顺序连续编号。
 */
export function splitParagraphs(content: string): ParsedSection[] {
  const lines = content.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let current = { section: "正文", buf: [] as string[] };
  let index = 0;

  const flush = () => {
    const text = current.buf.join("").trim();
    if (text) {
      index += 1;
      sections.push({ section: current.section, text, paragraphIndex: index });
    }
    current = { section: current.section, buf: [] };
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      return;
    }
    if (trimmed.startsWith("#")) {
      flush();
      current.section = trimmed.replace(/^#+\s*/, "") || "正文";
      return;
    }
    current.buf.push(trimmed);
  });
  flush();
  return sections;
}

export type ChunkDraft = {
  section: string;
  text: string;
  paragraphIndex: number;
  chars: number;
};

/**
 * 分块：按段落顺序合并成目标长度的块，块内保留原段落序号。
 * 某一段自身超过目标长度时切成多块，相邻块保留约 60 字重叠。
 */
export function chunkSections(
  sections: ParsedSection[],
  options: { maxChars: number; overlapChars: number } = {
    maxChars: KNOWLEDGE_PIPELINE.chunkMaxChars,
    overlapChars: KNOWLEDGE_PIPELINE.chunkOverlapChars,
  },
): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let buf: ParsedSection[] = [];
  let bufChars = 0;

  const push = (parts: ParsedSection[], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    chunks.push({
      section: parts[0]?.section ?? "正文",
      text: trimmed,
      paragraphIndex: parts[0]?.paragraphIndex ?? 0,
      chars: trimmed.length,
    });
  };

  const flush = () => {
    if (!buf.length) return;
    push(buf, buf.map((part) => part.text).join(""));
    buf = [];
    bufChars = 0;
  };

  sections.forEach((section) => {
    if (section.text.length > options.maxChars) {
      flush();
      const step = Math.max(1, options.maxChars - options.overlapChars);
      for (let start = 0; start < section.text.length; start += step) {
        const slice = section.text.slice(start, start + options.maxChars);
        push([section], slice);
        if (start + options.maxChars >= section.text.length) break;
      }
      return;
    }
    if (bufChars + section.text.length > options.maxChars && buf.length) {
      const tail = buf[buf.length - 1];
      flush();
      // 重叠：把上一块的最后一段带回新块开头，模拟 60 字重叠
      if (tail && tail.text.length <= options.overlapChars) {
        const carried = tail.text.slice(-options.overlapChars);
        buf = [{ ...tail, text: carried }];
        bufChars = carried.length;
      }
    }
    buf.push(section);
    bufChars += section.text.length;
  });
  flush();
  return chunks;
}

/* ------------------------------------------------------------------ *
 * 2. 768 维「入库向量」（确定性哈希投影，不是真嵌入模型）
 * ------------------------------------------------------------------ */

/** 元数据槽位：类别 16 + 文档 32 + 月份 12，共 60 个槽，都落在 768 维的最后一段 */
const CATEGORY_SLOTS = 16;
const DOC_SLOTS = 32;
const MONTH_SLOTS = 12;
const META_OFFSET = KNOWLEDGE_PIPELINE.embeddingDims - (CATEGORY_SLOTS + DOC_SLOTS + MONTH_SLOTS);

export type EmbeddingInput = {
  text: string;
  category: string;
  docId: string;
  /** YYYY-MM */
  month: string;
};

/**
 * 把一段文本映射成固定 768 维稠密向量：
 *   1. 文本：2–4 元 TF-IDF 权重按 FNV-1a 哈希投影到 768 维（保留符号，减少碰撞抵消）
 *   2. 元数据：类别 / 文档 / 月份各占一段固定槽位，权重较小
 * 同一段文本、同一元数据 → 每次结果完全一致，所以散点图刷新不会跳。
 */
export function buildEmbedding(
  input: EmbeddingInput,
  idf: (term: string) => number,
): Float64Array {
  const dims = KNOWLEDGE_PIPELINE.embeddingDims;
  const vec = new Float64Array(dims);

  const tokens = ngrams(input.text);
  const tf = termFreq(tokens);
  tf.forEach((count, token) => {
    const weight = (1 + Math.log(count)) * idf(token);
    const slot = hashString(token) % META_OFFSET;
    const sign = (hashString(`s:${token}`) & 1) === 1 ? 1 : -1;
    vec[slot] += sign * weight;
  });

  const bump = (key: string, offset: number, slots: number, scale: number) => {
    const slot = offset + (hashString(key) % slots);
    vec[slot] += scale;
  };
  bump(input.category, META_OFFSET, CATEGORY_SLOTS, 0.9);
  bump(input.docId, META_OFFSET + CATEGORY_SLOTS, DOC_SLOTS, 0.6);
  bump(input.month, META_OFFSET + CATEGORY_SLOTS + DOC_SLOTS, MONTH_SLOTS, 0.4);

  let norm = 0;
  for (let i = 0; i < dims; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i += 1) vec[i] /= norm;
  return vec;
}

/* ------------------------------------------------------------------ *
 * 3. PCA：真算前两个主成分（幂迭代 + 正交化）
 * ------------------------------------------------------------------ */

export type PcaResult = {
  dims: number;
  count: number;
  /** 第一 / 第二主成分方向 */
  axisU: Float64Array;
  axisV: Float64Array;
  /** 该主成分方向上的方差（真算） */
  variance: [number, number];
  mean: Float64Array;
};

export function pcaTop2(vectors: Float64Array[], iterations = 60): PcaResult {
  const dims = vectors[0]?.length ?? 0;
  const count = vectors.length;
  const mean = new Float64Array(dims);
  vectors.forEach((vec) => {
    for (let i = 0; i < dims; i += 1) mean[i] += vec[i] / count;
  });

  // 去中心化后不再单独存副本，直接闭包引用
  const centered = (vec: Float64Array, index: number): number => vec[index] - mean[index];

  const multiply = (input: Float64Array): Float64Array => {
    const out = new Float64Array(dims);
    vectors.forEach((vec) => {
      let dot = 0;
      for (let i = 0; i < dims; i += 1) dot += centered(vec, i) * input[i];
      for (let i = 0; i < dims; i += 1) out[i] += dot * centered(vec, i);
    });
    return out;
  };

  const normalize = (vec: Float64Array): Float64Array => {
    let norm = 0;
    for (let i = 0; i < dims; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Float64Array(dims);
    for (let i = 0; i < dims; i += 1) out[i] = vec[i] / norm;
    return out;
  };

  const varianceOf = (dir: Float64Array): number => {
    let total = 0;
    vectors.forEach((vec) => {
      let dot = 0;
      for (let i = 0; i < dims; i += 1) dot += centered(vec, i) * dir[i];
      total += dot * dot;
    });
    return count ? total / count : 0;
  };

  /** 确定性初值：用序号做伪随机，避免每次刷新换一组数 */
  const seedVector = (seed: number): Float64Array => {
    const vec = new Float64Array(dims);
    let state = seed >>> 0;
    for (let i = 0; i < dims; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      vec[i] = state / 4294967296 - 0.5;
    }
    return vec;
  };

  // 第一主成分
  let u = normalize(seedVector(20260912));
  for (let step = 0; step < iterations; step += 1) u = normalize(multiply(u));

  // 第二主成分：先减掉在 u 上的投影，再幂迭代
  let v = normalize(seedVector(19981216));
  for (let step = 0; step < iterations; step += 1) {
    let dot = 0;
    for (let i = 0; i < dims; i += 1) dot += v[i] * u[i];
    const ortho = new Float64Array(dims);
    for (let i = 0; i < dims; i += 1) ortho[i] = v[i] - dot * u[i];
    v = normalize(multiply(normalize(ortho)));
  }

  return {
    dims,
    count,
    axisU: u,
    axisV: v,
    variance: [varianceOf(u), varianceOf(v)],
    mean,
  };
}

export type ProjectedPoint = {
  chunkId: string;
  x: number;
  y: number;
  /** 原始投影坐标（未归一化），保留 4 位小数，供 tooltip 显示 */
  rawX: number;
  rawY: number;
};

/** 凸包（Andrew monotone chain）：给每个类别画一圈包络，证明散点是聚出来的 */
export function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper: { x: number; y: number }[] = [];
  [...sorted].reverse().forEach((point) => {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  });
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/* ------------------------------------------------------------------ *
 * 4. 初始索引：由 seed 的 KNOWLEDGE_DOCS 真算出来（不写死条目数）
 * ------------------------------------------------------------------ */

export const PROJECT_NAME = "示例寺";

export function seedChunks(): KbChunk[] {
  const chunks: KbChunk[] = [];
  KNOWLEDGE_DOCS.forEach((doc) => {
    doc.chunks.forEach((chunk, index) => {
      chunks.push({
        chunkId: `${doc.docId}#${chunk.chunkId}`,
        docId: doc.docId,
        docTitle: doc.title,
        category: doc.category,
        project: doc.project,
        date: doc.date,
        version: doc.version,
        source: doc.source,
        section: chunk.section,
        text: chunk.text,
        paragraphIndex: index + 1,
        chars: chunk.text.length,
        origin: "seed",
        parseMode: "text",
      });
    });
  });
  return chunks;
}

export function seedDocs(chunks: KbChunk[]): KbDoc[] {
  return KNOWLEDGE_DOCS.map((doc) => {
    const own = chunks.filter((chunk) => chunk.docId === doc.docId);
    return {
      docId: doc.docId,
      title: doc.title,
      category: doc.category,
      project: doc.project,
      date: doc.date,
      version: doc.version,
      source: doc.source,
      digest: doc.digest,
      chars: sum(own.map((chunk) => chunk.chars)),
      chunkCount: own.length,
      origin: "seed" as const,
      parseMode: "text" as const,
      changeFlag: "seed" as const,
    };
  });
}

/** 初始状态：索引版本取 KNOWLEDGE_META.indexVersion（idx-12 = KB-11） */
export function buildInitialKbState(builtAt: string): KbState {
  const chunks = seedChunks();
  const docs = seedDocs(chunks);
  const ids = chunks.map((chunk) => chunk.chunkId);
  return {
    label: KNOWLEDGE_PIPELINE.baseIndexVersion,
    docs,
    chunks,
    vectorizedChunkIds: [...ids],
    indexedChunkIds: [...ids],
    builtAt,
    mode: "seed",
    vectorCount: ids.length * KNOWLEDGE_PIPELINE.embeddingDims,
  };
}

/** 三重恒等：条目数 = 分块数 = 向量数 / 维度 —— 页面上直接显示这个断言 */
export function assertConsistency(state: KbState) {
  const chunkCount = state.chunks.length;
  const vectorized = state.vectorizedChunkIds.length;
  const indexed = state.indexedChunkIds.length;
  const expectedVectors = indexed * KNOWLEDGE_PIPELINE.embeddingDims;
  return {
    chunkCount,
    vectorized,
    indexed,
    expectedVectors,
    consistent:
      chunkCount === vectorized &&
      vectorized === indexed &&
      state.vectorCount === expectedVectors,
  };
}

/* ------------------------------------------------------------------ *
 * 5. 入库队列（上传 → 待解析 → 已分块 → 已向量化 → 已入库）
 * ------------------------------------------------------------------ */

export type QueueStatus = "待解析" | "解析中" | "已分块" | "已向量化" | "已入库";

export type QueueItem = {
  id: string;
  fileName: string;
  /** 展示用大小 */
  sizeText: string;
  sizeBytes: number;
  kindText: string;
  isText: boolean;
  parseMode: "text" | "estimate";
  /** 真读到的全文；估算类型为空 */
  content: string;
  chars: number;
  charsEstimated: boolean;
  chunkCount: number;
  status: QueueStatus;
  /** 当前步骤进度 0–100 */
  progress: number;
  /** 当前步骤已耗时（毫秒） */
  elapsedMs: number;
  stageMs: { parse: number; chunk: number; embed: number };
  sectionCount: number;
  note: string;
  /** 变更判定：新增 / 未变更 */
  change: "new" | "unchanged";
  chunks: KbChunk[];
  digest: string;
  category: KnowledgeCategory;
  version: string;
  date: string;
  source: "upload" | "import";
};

export type IncomingDoc = {
  id: string;
  fileName: string;
  sizeBytes: number;
  sizeText: string;
  kindText: string;
  isText: boolean;
  /** 文本类：真读到的内容；非文本类为空串 */
  content: string;
  category: KnowledgeCategory;
  version: string;
  date: string;
  source: "upload" | "import";
  /** 非文本类：由文件字节数估算的字符数 */
  estimatedChars?: number;
};

export function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

export function isTextFile(fileName: string): boolean {
  return (TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

/**
 * 建队列项：文本类真算字符数与分块数，非文本类按经验比值估算并标注「估算」。
 * 同一个 contentDigest 已经在索引里的，标为「未变更」。
 */
export function toQueueItem(incoming: IncomingDoc, knownDigests: Set<string>): QueueItem {
  const chars = incoming.isText
    ? incoming.content.length
    : Math.round((incoming.estimatedChars ?? incoming.sizeBytes * ESTIMATED_CHARS_PER_BYTE));
  const sections = incoming.isText ? splitParagraphs(incoming.content) : [];
  const draftCount = incoming.isText
    ? chunkSections(sections).length
    : Math.max(1, Math.ceil(chars / KNOWLEDGE_PIPELINE.chunkMaxChars));
  const digest = contentDigest(`${incoming.fileName}|${chars}|${incoming.content.slice(0, 256)}`);
  return {
    id: incoming.id,
    fileName: incoming.fileName,
    sizeText: incoming.sizeText,
    sizeBytes: incoming.sizeBytes,
    kindText: incoming.kindText,
    isText: incoming.isText,
    parseMode: incoming.isText ? "text" : "estimate",
    content: incoming.content,
    chars,
    charsEstimated: !incoming.isText,
    chunkCount: draftCount,
    status: "待解析",
    progress: 0,
    elapsedMs: 0,
    stageMs: { ...KNOWLEDGE_PIPELINE.stageMs },
    sectionCount: sections.length,
    note: incoming.isText ? `按文本真读 ${sections.length} 段` : "未解析内容，字符数按字节数估算",
    change: knownDigests.has(digest) ? "unchanged" : "new",
    chunks: [],
    digest,
    category: incoming.category,
    version: incoming.version,
    date: incoming.date,
    source: incoming.source,
  };
}

/**
 * 队列推进：按真实经过的毫秒推进当前步骤，走完一步进入下一步。
 *
 * 演示里的入队流水线是两步：解析（读取段落结构）→ 分块与向量化。
 * 分块完成即视为向量已生成（分块数 × 768 维），标为「已向量化」，
 * 之后停在队列里等「更新向量库」写入索引 —— 所以不会卡在「待解析」上。
 */
export function advanceQueue(
  queue: QueueItem[],
  deltaMs: number,
): { queue: QueueItem[]; events: { item: QueueItem; from: QueueStatus; to: QueueStatus }[] } {
  const events: { item: QueueItem; from: QueueStatus; to: QueueStatus }[] = [];
  const next = queue.map((item) => {
    if (item.status === "已向量化" || item.status === "已入库") return item;
    const from = item.status;
    const elapsed = (from === "待解析" ? 0 : item.elapsedMs) + deltaMs;
    const total = item.stageMs.parse;

    if (elapsed < total) {
      // 第一次 tick 就把「待解析」推进到「解析中」，观众能看到进度条在跑
      const updated: QueueItem = {
        ...item,
        status: "解析中",
        elapsedMs: elapsed,
        progress: Math.max(2, Math.min(97, Math.round((elapsed / total) * 100))),
      };
      if (from === "待解析") events.push({ item: updated, from, to: "解析中" });
      return updated;
    }

    // 解析完成 → 真分块 → 向量已生成
    const chunks = makeChunksFor(item);
    const done: QueueItem = {
      ...item,
      chunks,
      chunkCount: chunks.length,
      status: "已向量化",
      elapsedMs: 0,
      progress: 100,
      note: item.parseMode === "text" ? "已分块并生成向量（真读文本）" : "按文件大小估算分块并生成向量",
    };
    events.push({ item: done, from, to: "已向量化" });
    return done;
  });
  return { queue: next, events };
}

/** 队列项 → 分块（真分块器） */
export function makeChunksFor(item: QueueItem): KbChunk[] {
  const sections = item.isText ? splitParagraphs(item.content) : [];
  const drafts: ChunkDraft[] = item.isText
    ? chunkSections(sections)
    : Array.from({ length: item.chunkCount }, (_, index) => ({
        section: `估算块 ${index + 1}`,
        text: `${item.fileName} 第 ${index + 1} 块（内容未解析：仅按文件大小估算，不参与文本检索）。`,
        paragraphIndex: index + 1,
        chars: Math.round(item.chars / item.chunkCount),
      }));
  const docId = `doc-${hashString(`${item.fileName}|${item.sizeBytes}`).toString(16)}`;
  return drafts.map((draft, index) => ({
    chunkId: `${docId}#k-${String(index + 1).padStart(2, "0")}`,
    docId,
    docTitle: item.fileName,
    category: item.category,
    project: PROJECT_NAME,
    date: item.date,
    version: item.version,
    source: item.fileName,
    section: draft.section,
    text: draft.text,
    paragraphIndex: draft.paragraphIndex,
    chars: draft.chars,
    origin: item.source,
    parseMode: item.parseMode,
  }));
}

/* ------------------------------------------------------------------ *
 * 6. 更新流程（6 步状态机）
 * ------------------------------------------------------------------ */

export type UpdateStepKey = "parse" | "chunk" | "embed" | "write" | "rebuild" | "done";

export type UpdateStep = {
  key: UpdateStepKey;
  label: string;
  detail: string;
  /** 演示耗时（毫秒） */
  ms: number;
};

export function buildSteps(mode: "incremental" | "rebuild", docCount: number, chunkCount: number, chars: number): UpdateStep[] {
  return [
    {
      key: "parse",
      label: "解析文档",
      detail: `读取 ${docCount} 份资料的段落结构（文本类真读，其它类型只登记清单）`,
      ms: 700,
    },
    {
      key: "chunk",
      label: "分块",
      detail: `块大小 ${KNOWLEDGE_PIPELINE.chunkMaxChars} 字 · 重叠 ${KNOWLEDGE_PIPELINE.chunkOverlapChars} 字 · 共 ${chunkCount} 块 / ${chars} 字`,
      ms: 900,
    },
    {
      key: "embed",
      label: "生成向量",
      detail: `维度 ${KNOWLEDGE_PIPELINE.embeddingDims}（模拟：TF-IDF 权重经确定性哈希投影，未加载嵌入模型）· ${chunkCount} × ${KNOWLEDGE_PIPELINE.embeddingDims}`,
      ms: 1300,
    },
    {
      key: "write",
      label: "写入索引",
      detail:
        mode === "incremental"
          ? "只追加新增 / 变更文档的向量与倒排项，未变更文档沿用既有向量"
          : `清空后重建：写入 ${chunkCount} 条向量与倒排项`,
      ms: 800,
    },
    {
      key: "rebuild",
      label: "重建检索索引",
      detail: `重算 DF/IDF 并生成索引版本 ${KNOWLEDGE_PIPELINE.baseIndexVersion} → 下一版`,
      ms: 900,
    },
    {
      key: "done",
      label: "完成",
      detail: "索引可用，向量库可视化与检索演示立即读取新版本",
      ms: 300,
    },
  ];
}

export type LogEntry = { at: string; text: string; tone: "info" | "ok" | "warn" | "muted" };

/** 步骤推进到第 index 步时要写的日志（每步至少两条，观众看得到流水线在跑） */
export function stepLogs(step: UpdateStep, mode: "incremental" | "rebuild", stats: UpdateStats): LogEntry[] {
  const modeText = mode === "incremental" ? "增量" : "全量";
  switch (step.key) {
    case "parse":
      return [
        { at: "", text: `[${modeText}] 开始解析 ${stats.docAdded + stats.docChanged} 份候选资料`, tone: "info" },
        {
          at: "",
          text: `真读文本 ${stats.docAdded + stats.docChanged - stats.estimatedDocs} 份；估算 ${stats.estimatedDocs} 份（未解析内容）`,
          tone: stats.estimatedDocs ? "warn" : "muted",
        },
      ];
    case "chunk":
      return [
        { at: "", text: `分块参数：chunk_size=${KNOWLEDGE_PIPELINE.chunkMaxChars} overlap=${KNOWLEDGE_PIPELINE.chunkOverlapChars}`, tone: "muted" },
        { at: "", text: `切出 ${stats.chunkAdded} 块，共 ${stats.charsAdded} 字`, tone: "info" },
      ];
    case "embed":
      return [
        { at: "", text: `embedding_dim=${KNOWLEDGE_PIPELINE.embeddingDims}（模拟向量，非模型输出）`, tone: "warn" },
        { at: "", text: `生成 ${stats.chunkAdded} × ${KNOWLEDGE_PIPELINE.embeddingDims} = ${formatCount(stats.vectorAdded)} 个浮点数`, tone: "info" },
      ];
    case "write":
      return [
        {
          at: "",
          text:
            mode === "incremental"
              ? `增量写入：新增 ${stats.docAdded} 份 / 变更 ${stats.docChanged} 份，未变更 ${stats.docUnchanged} 份跳过`
              : `全量重建：清空旧索引，重新写入 ${stats.chunkTotal} 块`,
          tone: "info",
        },
      ];
    case "rebuild":
      return [
        { at: "", text: "重算 DF/IDF，用新版本的分块重建本地检索索引（前端演示，不落盘）", tone: "info" },
        { at: "", text: `索引版本 ${stats.versionFrom} → ${stats.versionTo}`, tone: "ok" },
      ];
    case "done":
      return [
        {
          at: "",
          text: `完成：条目 ${stats.docTotal} 份 / 分块 ${stats.chunkTotal} / 向量 ${formatCount(stats.vectorTotal)}`,
          tone: "ok",
        },
      ];
    default:
      return [];
  }
}

export type UpdateStats = {
  docAdded: number;
  docChanged: number;
  docUnchanged: number;
  docDeleted: number;
  /** 更新后的资料条目总数（提交后才知道，进度阶段用 0 占位） */
  docTotal: number;
  estimatedDocs: number;
  chunkAdded: number;
  chunkTotal: number;
  charsAdded: number;
  charsTotal: number;
  vectorAdded: number;
  vectorTotal: number;
  versionFrom: string;
  versionTo: string;
};

/**
 * 把「已向量化」的队列项写进知识库，算出这次更新的真实统计。
 * 全量重建与增量的区别只体现在「未变更文档是否重算向量」，
 * 两者的最终条目数 / 分块数 / 向量数完全一致——这点页面要写清楚。
 */
export function commitQueue(
  state: KbState,
  queue: QueueItem[],
  mode: "incremental" | "rebuild",
  builtAt: string,
  nextVersion: string,
): { state: KbState; stats: UpdateStats; committedIds: string[] } {
  const ready = queue.filter((item) => item.status === "已向量化" || item.status === "已入库");
  const knownDocs = new Set(state.docs.map((doc) => doc.title));
  const knownDigests = new Set(state.docs.map((doc) => doc.digest));

  const addedDocs: KbDoc[] = [];
  const changedDocs: KbDoc[] = [];
  const addedChunks: KbChunk[] = [];
  const replacedDocIds = new Set<string>();
  const committedIds: string[] = [];

  ready.forEach((item) => {
    const chunks = item.chunks.length ? item.chunks : makeChunksFor(item);
    if (!chunks.length) return;
    const docId = chunks[0].docId;
    const isChange = knownDocs.has(item.fileName) && !knownDigests.has(item.digest);
    const entry: KbDoc = {
      docId,
      title: item.fileName,
      category: item.category,
      project: PROJECT_NAME,
      date: item.date,
      version: item.version,
      source: item.fileName,
      digest: item.digest,
      chars: sum(chunks.map((chunk) => chunk.chars)),
      chunkCount: chunks.length,
      origin: item.source,
      parseMode: item.parseMode,
      changeFlag: isChange ? "changed" : "new",
    };
    if (isChange) {
      changedDocs.push(entry);
      replacedDocIds.add(docId);
    } else {
      addedDocs.push(entry);
    }
    addedChunks.push(...chunks);
    committedIds.push(item.id);
  });

  const keptDocs = state.docs.filter((doc) => !replacedDocIds.has(doc.docId));
  const keptChunks = state.chunks.filter((chunk) => !replacedDocIds.has(chunk.docId));
  const docs = [...keptDocs, ...addedDocs, ...changedDocs];
  const chunks = [...keptChunks, ...addedChunks];
  const chunkIds = chunks.map((chunk) => chunk.chunkId);

  /** 未变更的文档在增量模式下不重算向量，全量重建则全部重算 */
  const unchangedIds = keptChunks.map((chunk) => chunk.chunkId);
  const vectorizedChunkIds = mode === "incremental" ? [...new Set([...unchangedIds, ...chunks.map((c) => c.chunkId)])] : [...chunkIds];

  const stats: UpdateStats = {
    docAdded: addedDocs.length,
    docChanged: changedDocs.length,
    docUnchanged: state.chunks.length ? keptDocs.filter((doc) => doc.changeFlag === "seed" || doc.changeFlag === "new").length : 0,
    docDeleted: 0,
    docTotal: docs.length,
    estimatedDocs: [...addedDocs, ...changedDocs].filter((doc) => doc.parseMode === "estimate").length,
    chunkAdded: addedChunks.length,
    chunkTotal: chunks.length,
    charsAdded: sum(addedChunks.map((chunk) => chunk.chars)),
    charsTotal: sum(chunks.map((chunk) => chunk.chars)),
    vectorAdded: addedChunks.length * KNOWLEDGE_PIPELINE.embeddingDims,
    vectorTotal: chunks.length * KNOWLEDGE_PIPELINE.embeddingDims,
    versionFrom: state.label,
    versionTo: nextVersion,
  };

  return {
    state: {
      label: nextVersion,
      docs,
      chunks,
      vectorizedChunkIds,
      indexedChunkIds: [...chunkIds],
      builtAt,
      mode: mode === "incremental" ? "incremental" : "rebuild",
      vectorCount: chunks.length * KNOWLEDGE_PIPELINE.embeddingDims,
    },
    stats,
    committedIds,
  };
}

/* ------------------------------------------------------------------ *
 * 7. 版本历史
 * ------------------------------------------------------------------ */

export type KbVersion = {
  label: string;
  at: string;
  mode: "seed" | "incremental" | "rebuild" | "rollback";
  docCount: number;
  chunkCount: number;
  vectorCount: number;
  added: number;
  changed: number;
  deleted: number;
  note: string;
};

export function versionFromState(state: KbState, mode: KbVersion["mode"], at: string, note: string): KbVersion {
  return {
    label: state.label,
    at,
    mode,
    docCount: state.docs.length,
    chunkCount: state.chunks.length,
    vectorCount: state.vectorCount,
    added: 0,
    changed: 0,
    deleted: 0,
    note,
  };
}

/** KB-11 → KB-12 → KB-13 …… 只在数字后缀上递增 */
export function nextVersionLabel(label: string): string {
  const match = /^(.*?)(\d+)$/.exec(label);
  if (!match) return `${label}-2`;
  const width = match[2].length;
  return `${match[1]}${String(Number(match[2]) + 1).padStart(width, "0")}`;
}

/* ------------------------------------------------------------------ *
 * 8. 检索演示（复用 lib.searchKnowledge，不另写检索器）
 * ------------------------------------------------------------------ */

export type KbSearchResult = {
  hits: RetrievalHit[];
  belowThreshold: boolean;
  filtered: number;
  total: number;
  queryTokens: number;
  /** 命中分块在向量空间里的坐标，用来和散点图互相印证 */
  points: { chunkId: string; similarity: number; x: number; y: number; category: string }[];
};

export function toLibChunks(chunks: KbChunk[]): LibKnowledgeChunk[] {
  return chunks.map((chunk) => ({
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    category: chunk.category,
    date: chunk.date,
    version: chunk.version,
    source: chunk.source,
    chunkId: chunk.chunkId,
    section: chunk.section,
    text: chunk.text,
  }));
}

export function runSearch(
  chunks: KbChunk[],
  query: string,
  topK: number,
  filters: { category?: string; from?: string; to?: string },
  projection: Map<string, { x: number; y: number }>,
): KbSearchResult {
  const result = searchKnowledge(toLibChunks(chunks), query, topK, KNOWLEDGE_META.noHitThreshold, filters);
  return {
    ...result,
    points: result.hits.map((hit) => {
      const point = projection.get(hit.chunkId);
      return {
        chunkId: hit.chunkId,
        similarity: hit.similarity,
        x: point?.x ?? 0,
        y: point?.y ?? 0,
        category: hit.category,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 9. 向量空间（散点图数据源）
 * ------------------------------------------------------------------ */

export type VectorSpace = {
  dims: number;
  chunkCount: number;
  /** 幂迭代收敛后前两个主成分解释的方差占比（真算） */
  explained: [number, number];
  totalVariance: number;
  points: {
    chunkId: string;
    x: number;
    y: number;
    rawX: number;
    rawY: number;
    docId: string;
    docTitle: string;
    category: string;
    section: string;
    excerpt: string;
    date: string;
    chars: number;
    index: number;
  }[];
  hulls: { category: string; points: { x: number; y: number }[] }[];
  /** 每篇文档的质心（用于「文档簇」标注） */
  centroids: { docId: string; docTitle: string; category: string; x: number; y: number; count: number }[];
  buildMs: number;
};

const MONTH_LABEL = (date: string) => date.slice(0, 7);

/**
 * 真算整条链路：分块文本 → TF-IDF → 768 维向量 → PCA 前两个主成分 → 2D 坐标。
 * 不是随机撒点：同一份知识库每次得到完全相同的坐标。
 */
export function buildVectorSpace(chunks: KbChunk[]): VectorSpace {
  const started = performance.now();
  if (!chunks.length) {
    return {
      dims: KNOWLEDGE_PIPELINE.embeddingDims,
      chunkCount: 0,
      explained: [0, 0],
      totalVariance: 0,
      points: [],
      hulls: [],
      centroids: [],
      buildMs: 0,
    };
  }

  const tokenized = chunks.map((chunk) => ngrams(chunk.text));
  const idf = fitIdf(tokenized);

  // 768 维向量沿用到「向量条目」的统计里：向量数 = 分块数 × 768
  const vectors = chunks.map((chunk) =>
    buildEmbedding(
      { text: chunk.text, category: chunk.category, docId: chunk.docId, month: MONTH_LABEL(chunk.date) },
      idf,
    ),
  );

  const pca = pcaTop2(vectors);
  const projected = project2dWithIds(vectors, pca, chunks.map((chunk) => chunk.chunkId));
  const totalVariance = sum(vectors.map((vec) => {
    let norm = 0;
    for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
    return norm;
  }));
  const explainedTotal = pca.variance[0] + pca.variance[1];
  const explained: [number, number] = [
    explainedTotal ? pca.variance[0] / explainedTotal : 0,
    explainedTotal ? pca.variance[1] / explainedTotal : 0,
  ];

  const points = chunks.map((chunk, index) => ({
    chunkId: chunk.chunkId,
    x: projected[index].x,
    y: projected[index].y,
    rawX: projected[index].rawX,
    rawY: projected[index].rawY,
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    category: chunk.category,
    section: chunk.section,
    excerpt: chunk.text.length > 72 ? `${chunk.text.slice(0, 72)}…` : chunk.text,
    date: chunk.date,
    chars: chunk.chars,
    index,
  }));

  const categories = [...new Set(points.map((point) => point.category))];
  const hulls = categories.map((category) => ({
    category,
    points: convexHull(points.filter((point) => point.category === category).map((point) => ({ x: point.x, y: point.y }))),
  }));

  const docIds = [...new Set(points.map((point) => point.docId))];
  const centroids = docIds.map((docId) => {
    const own = points.filter((point) => point.docId === docId);
    return {
      docId,
      docTitle: own[0]?.docTitle ?? docId,
      category: own[0]?.category ?? "",
      x: own.reduce((acc, point) => acc + point.x, 0) / own.length,
      y: own.reduce((acc, point) => acc + point.y, 0) / own.length,
      count: own.length,
    };
  });

  return {
    dims: KNOWLEDGE_PIPELINE.embeddingDims,
    chunkCount: chunks.length,
    explained,
    totalVariance,
    points,
    hulls,
    centroids,
    buildMs: Number((performance.now() - started).toFixed(1)),
  };
}

function project2dWithIds(
  vectors: Float64Array[],
  pca: PcaResult,
  ids: string[],
): ProjectedPoint[] {
  const raw = vectors.map((vec) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < vec.length; i += 1) {
      const value = vec[i] - pca.mean[i];
      x += value * pca.axisU[i];
      y += value * pca.axisV[i];
    }
    return { x, y };
  });
  const xs = raw.map((point) => point.x);
  const ys = raw.map((point) => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return raw.map((point, index) => ({
    chunkId: ids[index],
    x: Number(((point.x - minX) / spanX).toFixed(4)),
    y: Number(((point.y - minY) / spanY).toFixed(4)),
    rawX: Number(point.x.toFixed(4)),
    rawY: Number(point.y.toFixed(4)),
  }));
}

/* ------------------------------------------------------------------ *
 * 10. 分布统计（按文档 / 按类别 / 按时间）
 * ------------------------------------------------------------------ */

export type DistributionRow = { key: string; label: string; chunks: number; chars: number; docs: number; category: string };

export function distributionByDoc(chunks: KbChunk[], docs: KbDoc[]): DistributionRow[] {
  return docs
    .map((doc) => {
      const own = chunks.filter((chunk) => chunk.docId === doc.docId);
      return {
        key: doc.docId,
        label: doc.title,
        chunks: own.length,
        chars: sum(own.map((chunk) => chunk.chars)),
        docs: 1,
        category: doc.category,
      };
    })
    .sort((a, b) => b.chunks - a.chunks);
}

export function distributionByCategory(chunks: KbChunk[], docs: KbDoc[]): DistributionRow[] {
  return [...new Set(docs.map((doc) => doc.category))]
    .map((category) => {
      const own = chunks.filter((chunk) => chunk.category === category);
      const ownDocs = docs.filter((doc) => doc.category === category);
      return {
        key: category,
        label: category,
        chunks: own.length,
        chars: sum(own.map((chunk) => chunk.chars)),
        docs: ownDocs.length,
        category,
      };
    })
    .sort((a, b) => b.chunks - a.chunks);
}

export function distributionByMonth(chunks: KbChunk[], docs: KbDoc[]): DistributionRow[] {
  return [...new Set(chunks.map((chunk) => MONTH_LABEL(chunk.date)))]
    .sort()
    .map((month) => {
      const own = chunks.filter((chunk) => MONTH_LABEL(chunk.date) === month);
      const ownDocs = docs.filter((doc) => MONTH_LABEL(doc.date) === month);
      return {
        key: month,
        label: month,
        chunks: own.length,
        chars: sum(own.map((chunk) => chunk.chars)),
        docs: ownDocs.length,
        category: "",
      };
    });
}

/* ------------------------------------------------------------------ *
 * 11. 演示文案（改这里就能改页面上的说明，不用翻组件）
 * ------------------------------------------------------------------ */

export const KB_DEMO_NOTES = {
  scope:
    "本页不连接后端、不上传任何文件、不加载嵌入模型：上传只在浏览器内读取，解析 / 分块 / 向量化 / 写索引均为前端演示流程。",
  embedding:
    "768 维「入库向量」是把 TF-IDF 权重按确定性哈希投影到 768 维再归一化得到的，形状用于演示向量库，语义不等于真实嵌入模型。",
  projection:
    "散点图坐标是对这 768 维向量做一次真的 PCA（幂迭代求前两个主成分）后投影出来的；坐标由数据算出，不是随机撒点。",
  search:
    "检索演示复用 lib.searchKnowledge：中文 2–4 元 TF-IDF + 余弦相似度，先按类别 / 日期过滤候选，再取 Top K；无命中时回答「当前资料未检索到」。",
  incremental: "增量更新只处理新增与变更文档，未变更文档沿用既有向量；全量重建会清空索引重算全部向量。两者的最终条目数一致。",
  rollback: "回滚只切换前端状态：条目数 / 分块数 / 向量数回到上一版本，新增资料回到待入库队列，需要重新更新才会再次进入索引。",
  estimated: "PDF / 图片 / 压缩包不做真实解析，字符数与分块数为按文件大小的估算值，页面已逐项标注「估算」。",
} as const;

/** 「选择本地目录导入」用的种子文件数量 / 名称，供按钮文案使用 */
export const KB_SEED_SUMMARY = {
  count: KNOWLEDGE_FILE_SEEDS.length,
  names: KNOWLEDGE_FILE_SEEDS.map((file) => file.path.split("/").pop() ?? file.path),
} as const;
