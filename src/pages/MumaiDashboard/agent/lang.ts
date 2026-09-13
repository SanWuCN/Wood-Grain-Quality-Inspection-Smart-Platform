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
 * 词组级同音容错：**只在语料里出现过、且替换后不会撞到平台常用词**的错法。
 *
 * ── 为什么需要这一层（实测证据，不是预防性设计）──────────────────
 * AC-01 的录音验证里，用 Windows 中文语音合成的「查近三个月天气」
 * 被本地 whisper 定稿成 **「查件三个月天气」** —— 近(jìn) 听成 件(jiàn)，
 * 于是 `site_weather` 一次都命中不了，整条验收卡在这一步。
 *
 * ── 为什么只能做词组级，不能做逐字映射 ──────────────────────────
 * **「件」是这个平台的高频字**：构件、部件、文件、事件……
 * 写成逐字 `件 → 近` 会立刻把「构件」变成「构近」，
 * 而构件是四柱巡检的核心术语。词组级只在这两个字**连在一起**时才折，
 * 「查件」不是词，误伤面为零。
 *
 * 尺度：一条证据一条规则，不预先铺开。加之前先问"它会不会撞到业务词"。
 */
const PHRASE_FIXES: [RegExp, string][] = [
  /**
   * 「查近」是 AC-01 那句命令最脆弱的前两个字。
   *
   * 两轮实测各拿到一种错法（同一段音频、同一个模型）：
   *   第 1 轮 `茶井三个月天气`   第 2 轮 `查件三个月天气`
   * 也就是两个音节都各自被听错一次，而且**错法不稳定** ——
   * 只堵住其中一种，下一轮又会从另一种漏过去。
   *
   * 所以按「首字 ∈ {查,茶} × 次字 ∈ {件,井}」这一组收：
   * 这四种组合在平台域内**都不是词**（构件、部件、文件里的「件」都是单字出现，
   * 前面不会紧跟「查/茶」），误伤面为零。
   */
  [/[茶查][件井]/g, "查近"],

  /**
   * 「巡检」被听成「寻检」—— 这是**本平台最高频的业务动词**，
   * 由全量评估的 TTS 命令样本实测暴露（「开始巡检」→「开始寻检」，意图直接失配）。
   *
   * 只做词组级的「寻检 → 巡检」，**不做逐字 寻→巡**：
   * 「寻」单独出现时是正常字（寻找、搜寻），逐字折叠会误伤；
   * 而「寻检」不是词，只在听错时出现。
   */
  [/寻检/g, "巡检"],

  /**
   * 站点名「示例寺」被听成「势力寺」—— 同样是全量评估实测到的
   * （「查今年五月示例寺巡检」→「查今年5月 势力寺巡检」，意图失配）。
   *
   * 词组级折叠：势→示、力→例 单独映射会误伤「势力」「力度」这类正常词，
   * 只在三字连起来时折。
   */
  [/势力寺/g, "示例寺"],
  // 同一类错法的另一种：声调相近的「事例寺」
  [/事例寺/g, "示例寺"],
];

/** 词组级替换（在去标点、转小写之后做，保证「查 件」这类带空格的也能对上） */
function applyPhraseFixes(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PHRASE_FIXES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * 规范化（技术方案 §45 的 Normalize 环节）。
 * 全角转半角、去空白与标点、统一小写，再做**保守的**词组级同音容错。
 *
 * 说明：原注释写着"不做同义词替换"—— 那指的是**语义**层面的同义改写
 * （那仍然由意图库 examples 覆盖）。这里做的是**拼写**层面的同音纠错，
 * 属于 ASR 后处理的范畴，两者不是一回事。
 */
export function normalize(raw: string): string {
  return applyPhraseFixes(toHalfWidth(raw).replace(STRIP_PUNCTUATION, "").toLowerCase());
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
