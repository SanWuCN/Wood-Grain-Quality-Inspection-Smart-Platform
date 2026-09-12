/**
 * 小木语音智能体 · 阈值标定（技术方案 §15：阈值必须用自己的问句数据集测出来）
 *
 * 为什么要独立脚本：项目源码内部用无扩展名相对导入（Vite + bundler resolution），
 * 而 Node 原生类型剥离要求显式 .ts 后缀，因此这里**内联**中文向量化与匹配算法，
 * 只从 tools/agent-calib-data.mts 读问句集。
 *
 * 算法与 agent/lang.ts、agent/matcher.ts 保持一致：
 *   - bigram 权重 1、unigram 权重 0.35，余弦相似度
 *   - ratio = 查询的 bigram 有多少能在该意图示例语料里找到（覆盖率）
 *   - head  = 与示例「头 8 个字」的余弦（中文意图句的动词与宾语都在前半句）
 *   - score = ratio × (BASE + (1-BASE) × head)
 *   - 阈值 high 0.82 / low 0.68 / margin 0.08
 *
 * 运行：node tools/agent-calib.mts     验收后删除本文件与 tools/agent-calib-data.mts
 */

import { EXAMPLE_ROWS } from "./agent-calib-data.mts";

const THRESHOLDS = { highConfidence: 0.82, lowConfidence: 0.68, minMargin: 0.08 };
const UNIGRAM_WEIGHT = 0.35;
const HEAD_CHARS = 8;
/** 覆盖率与头部相似度的权重（0.40 = 覆盖率至少带来 40% 的分，剩下 60% 由头部相似度决定） */
const DEFAULT_BASE = 0.4;

const STRIP = /[\s，。、！？；："'（）《》【】…—·,.;:!?"'()<>[\]{}|/\\~`@#$%^&*+=_-]/g;

function normalize(raw: string): string {
  return raw
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(STRIP, "")
    .toLowerCase();
}

function vectorize(raw: string): Map<string, number> {
  const chars = Array.from(normalize(raw));
  const vector = new Map<string, number>();
  const add = (key: string, weight: number) => vector.set(key, (vector.get(key) ?? 0) + weight);
  chars.forEach((ch) => add(`1:${ch}`, UNIGRAM_WEIGHT));
  for (let i = 0; i + 1 < chars.length; i += 1) add(`2:${chars[i]}${chars[i + 1]}`, 1);
  return vector;
}

function norm(vector: Map<string, number>): number {
  let sum = 0;
  vector.forEach((value) => {
    sum += value * value;
  });
  return Math.sqrt(sum);
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [short, long] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  short.forEach((value, key) => {
    const other = long.get(key);
    if (other !== undefined) dot += value * other;
  });
  const denominator = norm(a) * norm(b);
  return denominator ? dot / denominator : 0;
}

function bigramsOf(text: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalize(text);
  for (let i = 0; i + 2 <= normalized.length; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}

type Entry = { id: string; vector: Map<string, number>; heads: Map<string, number>[] };
type Query = { vector: Map<string, number>; bigrams: Set<string> };

const INDEX: Entry[] = EXAMPLE_ROWS.map((row) => {
  const vector = new Map<string, number>();
  const heads: Map<string, number>[] = [];
  for (const example of row.examples) {
    vectorize(example).forEach((value, key) => vector.set(key, Math.max(vector.get(key) ?? 0, value)));
    // 头部向量用**完整示例**而不是示例前 N 字：否则「让小车去一号木柱」会同时高分命中
    // robot_move 与 agent_patrol_route（后者的示例比它长，前 8 字完全一样）。
    // 用完整示例后，与示例长度接近的那条得分更高，天然打破并列。
    heads.push(vectorize(example));
  }
  return { id: row.id, vector, heads };
});

function queryOf(raw: string): Query {
  return { vector: vectorize(raw), bigrams: bigramsOf(raw) };
}

function scoreOf(query: Query, entry: Entry, base: number): number {
  let matched = 0;
  query.bigrams.forEach((gram) => {
    if (entry.vector.has(`2:${gram}`)) matched += 1;
  });
  const ratio = query.bigrams.size ? matched / query.bigrams.size : 0;
  let head = 0;
  entry.heads.forEach((headVector) => {
    head = Math.max(head, cosine(query.vector, headVector));
  });
  return Math.min(1, ratio * (base + (1 - base) * Math.min(head, 1)));
}

function rank(raw: string, topN: number, base: number) {
  const query = queryOf(raw);
  return INDEX.map((entry) => ({ id: entry.id, score: Math.round(scoreOf(query, entry, base) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/** 与 agent/matcher.ts 的 understand() 同构：阈值 + margin 判定 */
function decide(raw: string, base: number) {
  const ranking = rank(raw, 3, base);
  const top = ranking[0];
  const margin = Math.round((top.score - (ranking[1]?.score ?? 0)) * 1000) / 1000;
  const level =
    top.score >= THRESHOLDS.highConfidence ? "high" : top.score >= THRESHOLDS.lowConfidence ? "low" : "fallback";
  const accepted = level === "high" || (level === "low" && margin >= THRESHOLDS.minMargin);
  return { id: accepted ? top.id : "(fallback)", score: top.score, margin, level, ranking };
}

function evaluate(base: number) {
  const rows = EXAMPLE_ROWS.flatMap((row) =>
    row.examples.map((example) => {
      const decision = decide(example, base);
      return { text: example, expect: row.id, ...decision };
    }),
  );
  const failures = rows.filter((row) => row.id !== row.expect);
  const scores = rows.map((row) => row.score).sort((a, b) => a - b);
  const levels = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.level] = (acc[row.level] ?? 0) + 1;
    return acc;
  }, {});
  return { rows, failures, scores, levels };
}

console.log(`意图 ${EXAMPLE_ROWS.length} 条 / 示例问句 ${EXAMPLE_ROWS.reduce((sum, row) => sum + row.examples.length, 0)} 条`);
console.log(`阈值 high=${THRESHOLDS.highConfidence} low=${THRESHOLDS.lowConfidence} margin=${THRESHOLDS.minMargin}\n`);

console.log("--- BASE 取值扫描 ---");
for (const base of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  const { rows, failures, scores } = evaluate(base);
  const hit = rows.length - failures.length;
  console.log(
    `BASE=${base.toFixed(2)}  命中 ${hit}/${rows.length} (${((hit / rows.length) * 100).toFixed(1)}%)  min=${scores[0]} median=${scores[Math.floor(scores.length / 2)]} max=${scores[scores.length - 1]}`,
  );
}

const { rows, failures, scores, levels } = evaluate(DEFAULT_BASE);
console.log(`\n--- 选定 BASE=${DEFAULT_BASE} ---`);
console.log(`Top-1 命中 ${rows.length - failures.length}/${rows.length} = ${(((rows.length - failures.length) / rows.length) * 100).toFixed(1)}%`);
console.log(`score  min=${scores[0]} p25=${scores[Math.floor(scores.length * 0.25)]} median=${scores[Math.floor(scores.length / 2)]} max=${scores[scores.length - 1]}`);
console.log(`level  分布 ${JSON.stringify(levels)}`);
const margins = rows.map((row) => row.margin).sort((a, b) => a - b);
console.log(`margin min=${margins[0]} p25=${margins[Math.floor(margins.length * 0.25)]} median=${margins[Math.floor(margins.length / 2)]}`);

if (failures.length) {
  console.log("\n--- 未命中 ---");
  for (const row of failures) console.log(`  got=${row.id} expect=${row.expect} score=${row.score} margin=${row.margin}  "${row.text}"`);
}

console.log("\n--- 最低分 12 条示例 ---");
for (const row of [...rows].sort((a, b) => a.score - b.score).slice(0, 12)) {
  console.log(`  ${row.score.toFixed(3)} m=${row.margin.toFixed(3)} ${row.level.padEnd(8)} ${row.expect.padEnd(20)} "${row.text}"`);
}

console.log("\n--- 边界问句（不在示例集内；期望 fallback 或规则命中） ---");
const RULES: { pattern: RegExp; intentId: string }[] = [
  { pattern: /(立即停止|紧急停止|马上停止|停止|停下|暂停|急停|刹车|别动|停一下)/, intentId: "robot_stop(rule)" },
  { pattern: /(返回起点|回到起点|返回原位|回到原点|回到殿门|返航|返回充电站|返回待机点|回到出发位置)/, intentId: "robot_return_home(rule)" },
  { pattern: /(装载地图|载入地图|加载地图|切换地图|换地图|地图版本切换)/, intentId: "load_map(rule)" },
  { pattern: /(开始建图|启动建图|开始构图|重新建图|开始扫描建图|启动slam建图)/, intentId: "start_mapping(rule)" },
];
for (const text of [
  "今天天气怎么样",
  "帮我订一张去北京的机票",
  "把数据库删了",
  "你好",
  "四号柱",
  "打开那个页面",
  "让小车去五号木柱",
  "把全部地图删掉",
  "让小车先去一号木柱，再绕一圈，然后回来",
  "先去一号柱，再环绕一圈，最后返回起点",
  "停止",
  "让小车停下来",
  "回到起点",
  "开始建图",
  "装载地图版本",
]) {
  const normalized = normalize(text);
  const rule = RULES.find((item) => item.pattern.test(normalized));
  const decision = decide(text, DEFAULT_BASE);
  console.log(
    `  "${text}" -> ${rule ? rule.intentId : decision.id}  score=${decision.score} margin=${decision.margin} level=${decision.level} top3=${decision.ranking.map((item) => `${item.id}:${item.score}`).join(" ")}`,
  );
}
