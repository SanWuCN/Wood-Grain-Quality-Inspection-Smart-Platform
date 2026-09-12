/**
 * 小木语音智能体 · 中文文本工具
 *
 * 技术方案 §12 / §14：Embedding Intent 匹配需要「把一句话变成向量再算余弦相似度」。
 * 本演示不引入任何外部模型或依赖（约束：不新增 npm 依赖、不调用外部服务），
 * 因此这里用**字符二元组（bigram）词频向量**做本地等价实现：
 *
 *   真实链路：bge-small-zh-v1.5 → 768 维稠密向量 → 余弦相似度
 *   本演示：  中文字符 bigram + 少量 unigram → 稀疏词频向量 → 余弦相似度
 *
 * 两者在数学形式上是同一个东西（都是单位化向量后取点积），差别只在特征来源。
 * 方案 §16 也说明：Intent 数量在 20–500 条时用「NumPy + 余弦相似度」即可，
 * 不必上向量数据库。
 *
 * bigram 而不是单字：单字命中会把「柱子」和「柱脚」判成同一件事，
 * bigram 能保留「木柱 / 木桩 / 木构」这类近义词的局部顺序信息。
 */

/** 单字符标点判定：用非 global 正则，避免 lastIndex 状态残留 */
const IS_PUNCTUATION = /[\s，。、！？；："'（）《》【】…—·,.;:!?"'()<>[\]{}|/\\~`@#$%^&*+=_-]/;
/** 整体去标点：同一字符类的 global 版本 */
const STRIP_PUNCTUATION = /[\s，。、！？；："'（）《》【】…—·,.;:!?"'()<>[\]{}|/\\~`@#$%^&*+=_-]/g;

/** 全角 → 半角（数字、字母、常见符号），让「１号柱」与「1号柱」等价 */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/**
 * 规范化（技术方案 §45 的 Normalize 环节）。
 * 只做无损处理：全角转半角、去空白与标点、统一小写。
 * 不做同义词替换 —— 同义说法由意图库的 examples 覆盖（方案 §12）。
 */
export function normalize(raw: string): string {
  return toHalfWidth(raw).replace(STRIP_PUNCTUATION, "").toLowerCase();
}

/** 逐字切分（中文字符），过滤掉空白与标点 */
export function charsOf(raw: string): string[] {
  const text = toHalfWidth(raw);
  const out: string[] = [];
  for (const ch of text) {
    if (IS_PUNCTUATION.test(ch)) continue;
    out.push(ch.toLowerCase());
  }
  return out;
}

/**
 * 稀疏向量：bigram 为主特征，unigram 以较低权重入列。
 * unigram 的作用是兜底短句（「停止」只有 2 个字，bigram 只有 1 个），
 * 权重压到 0.35 是为了不让它主导排序。
 */
export type SparseVector = Map<string, number>;

const UNIGRAM_WEIGHT = 0.35;

export function vectorize(raw: string): SparseVector {
  const chars = charsOf(raw);
  const vector: SparseVector = new Map();
  const add = (key: string, weight: number) => {
    vector.set(key, (vector.get(key) ?? 0) + weight);
  };
  chars.forEach((ch) => add(`1:${ch}`, UNIGRAM_WEIGHT));
  for (let i = 0; i + 1 < chars.length; i += 1) add(`2:${chars[i]}${chars[i + 1]}`, 1);
  return vector;
}

export function vectorNorm(vector: SparseVector): number {
  let sum = 0;
  vector.forEach((value) => {
    sum += value * value;
  });
  return Math.sqrt(sum);
}

/** 余弦相似度；任一向量为空时返回 0（不抛错） */
export function cosine(a: SparseVector, b: SparseVector): number {
  const [short, long] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  short.forEach((value, key) => {
    const other = long.get(key);
    if (other !== undefined) dot += value * other;
  });
  const denominator = vectorNorm(a) * vectorNorm(b);
  if (!denominator) return 0;
  return dot / denominator;
}

/**
 * 归一化后的「整句包含」检查。
 * 用于确定性规则：短指令（「停止」「返回起点」）被完整说进一句话里时直接命中，
 * 属于方案 §11 的一级规则匹配，不走相似度。
 */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 0 && normalizedText.includes(needle);
}

/** 四舍五入到 3 位，界面与日志统一口径 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 从数组里按 key 建索引（意图库、工具表共用） */
export function indexBy<T, K extends string>(items: readonly T[], keyOf: (item: T) => K): Record<K, T> {
  const out = {} as Record<K, T>;
  items.forEach((item) => {
    out[keyOf(item)] = item;
  });
  return out;
}
