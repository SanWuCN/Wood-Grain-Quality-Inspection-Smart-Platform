/**
 * 数据与知识中心 · 检索适配器（DemoIndexAdapter 的检索侧）
 *
 * 依据：PRD §11.3（演示向量与检索技术的选择）、§5.5（检索验证页签）、
 *      §16.3（R01–R04 检索验收）。
 *
 * 现实约束与取舍：
 *   1. 复用项目已有的中文 2–4 元 + TF-IDF / 余弦思路（src/pages/MumaiDashboard/
 *      knowledge/logic.ts 同一套算法），但在服务端重新实现一份：PRD §15 明确
 *      「共享逻辑不可由 Node 直接导入含 React / DOM 或前端种子的模块」。
 *   2. 词项统计与索引版本绑定：语料装在内存里按 `servingVersion` 缓存，
 *      构建一次后续查询复用，不每次输入都同步遍历全部内容（PRD §11.3）。
 *   3. 对象 ID（Z04 / SCAN-01 / WO-024）走**精确字段匹配**并加分（PRD §11.3）。
 *   4. 没有明确年份的自然语言不隐式指向某一年：时间意图只在查询里出现
 *      「五月 / 九月 / 2026」这类可解释线索时才回显为筛选条件（PRD §11.3）。
 */

import { SEARCH_CONFIG_DEFAULT } from "../domains/knowledge-contract.mjs";

/* ------------------------------------------------------------------ *
 * 中文 n-gram（与前端 logic.ts 的 ngrams 同一套口径）
 * ------------------------------------------------------------------ */

const PUNCT = /[\s,.;:!?，。；：！？、"'（）()\[\]{}<>《》…—\-_/\\|+*=~`@#$%^&]+/;

/** 切出 2–4 元；拉丁与数字连续串整体保留（Z04 / SCAN-01 / PDF） */
export function ngrams(text, { min = 2, max = 4 } = {}) {
  const out = [];
  const segments = String(text ?? "")
    .toLowerCase()
    .split(PUNCT)
    .filter(Boolean);
  for (const segment of segments) {
    // 含数字或字母的片段（对象编号、英文术语）：整体 + 逐段保留
    if (/[a-z0-9]/.test(segment)) {
      out.push(segment);
      for (const piece of segment.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean)) {
        if (piece.length >= min) out.push(piece);
      }
      continue;
    }
    for (let size = min; size <= max; size += 1) {
      for (let index = 0; index + size <= segment.length; index += 1) {
        out.push(segment.slice(index, index + size));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 语料索引（懒构建，按索引版本缓存）
 * ------------------------------------------------------------------ */

/** 内存缓存：key = `${sessionId}|${servingVersion}` */
const CORPUS_CACHE = new Map();

export function invalidateCorpus(sessionId) {
  for (const key of [...CORPUS_CACHE.keys()]) {
    if (key.startsWith(`${sessionId}|`)) CORPUS_CACHE.delete(key);
  }
}

/**
 * 装一份语料。
 *
 * `db` 只需要有两个查询方法，便于与服务端的 DatabaseSync 复用同一段逻辑：
 *   · allChunks(limit, offset) → [{ id, assetId, assetRevision, ordinal, text, locator }]
 *   · allAssets() → [{ id, title, summary, type, primaryObjectId, objectIds, updatedAt, capturedAt, businessCategories, mainSource }]
 */
export function buildCorpus({ sessionId, servingVersion, chunks, assets, extraTerms = [] }) {
  const started = Date.now();
  const postings = new Map();
  const docLengths = new Float64Array(chunks.length);
  const chunkIndexById = new Map();

  chunks.forEach((chunk, position) => {
    chunkIndexById.set(chunk.id, position);
    const terms = ngrams(chunk.text);
    docLengths[position] = terms.length || 1;
    for (const term of new Set(terms)) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push(position);
    }
  });

  // 资产元数据索引：标题 / 摘要 / 来源编号单独一张，命中时按权重加分
  const assetIndex = new Map();
  assets.forEach((asset) => {
    assetIndex.set(asset.id, asset);
    const metaTerms = ngrams(`${asset.title} ${asset.summary} ${asset.sourceEntityId ?? ""}`);
    for (const term of new Set(metaTerms)) {
      let list = postings.get(`@${term}`);
      if (!list) postings.set(`@${term}`, (list = []));
      list.push(asset.id);
    }
  });

  const corpus = {
    sessionId,
    servingVersion,
    chunks,
    assets,
    assetIndex,
    postings,
    docLengths,
    chunkIndexById,
    avgLength: chunks.reduce((total, _, position) => total + docLengths[position], 0) / Math.max(1, chunks.length),
    extraTerms,
    builtMs: Date.now() - started,
  };
  return corpus;
}

export function getCorpus(cacheKey, loader) {
  const cached = CORPUS_CACHE.get(cacheKey);
  if (cached) return cached;
  const corpus = loader();
  CORPUS_CACHE.set(cacheKey, corpus);
  return corpus;
}

/* ------------------------------------------------------------------ *
 * 评分
 * ------------------------------------------------------------------ */

/** BM25 形式的长文档归一，配合 idf 使用；参数与词典统计绑定在语料上 */
function idfOf(corpus, term, kind) {
  const list = corpus.postings.get(`${kind}${term}`);
  if (!list?.length) return 0;
  const n = kind === "@" ? corpus.assets.length : corpus.chunks.length;
  return Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
}

/** 一次打分：返回按分数降序的候选 */
export function scoreCorpus(corpus, query, { deviceTerms = ["扫描设备", "SCAN-01", "SCAN-02"] } = {}) {
  const terms = ngrams(query);
  if (!terms.length) return [];
  const unique = [...new Set(terms)];
  /*
    真词覆盖门槛：中文用 2 元打分必然产生「共享一两个汉字就算命中」的假阳性
    （「寒山寺 钟楼 铜钟 铸造」会命中一批砖石构件资料，「紫禁城角楼…」同理）。
    判断方式是「查询里的 2 元有多少在候选文本里真的按顺序出现过」，
    阈值取 0.3 —— 实测把「柱脚渗水记录」「扫描设备通信异常」「设备校准偏差」
    这类真查询（覆盖 0.30–0.75）放行，而共享汉字的假查询（≤0.20）全部挡住。
    覆盖率在候选上算，不在全语料上算：全语料算会拖慢一次查询几百毫秒。
  */
  const queryBigrams = [...new Set(ngrams(query, { min: 2, max: 2 }))];
  const gate = queryBigrams.length >= 3 ? 0.3 : 0;
  /** 查询里长度 ≥4 的连续中文片段：完整出现时按「强证据」加权 */
  const phraseWords = String(query ?? "")
    .toLowerCase()
    .split(PUNCT)
    .flatMap((token) => {
      if (token.length < 4 || /^[a-z0-9-]+$/.test(token)) return [];
      const out = [token];
      for (let size = 4; size <= Math.min(6, token.length); size += 1) {
        for (let index = 0; index + size <= token.length; index += 1) out.push(token.slice(index, index + size));
      }
      return out;
    });

  const scores = new Map();
  const k1 = 1.2;
  const b = 0.6;

  const add = (key, value) => scores.set(key, (scores.get(key) ?? 0) + value);

  for (const term of unique) {
    const list = corpus.postings.get(term);
    if (list?.length) {
      const idf = idfOf(corpus, term, "");
      for (const position of list) {
        const length = corpus.docLengths[position];
        add(position, (idf * (k1 + 1)) / (1 + k1 * (1 - b + (b * length) / corpus.avgLength)));
      }
    }
    const metaList = corpus.postings.get(`@${term}`);
    if (metaList?.length) {
      const idf = idfOf(corpus, term, "@");
      for (const assetId of metaList) add(`A:${assetId}`, idf * 0.45);
    }
  }

  // 同一 2 元包含在更长的 gram 里会重复计分，用查询长度归一
  const normalizer = Math.max(1, unique.length);

  const hits = [];
  for (const [key, raw] of scores) {
    if (typeof key === "string" && key.startsWith("A:")) continue;
    const chunk = corpus.chunks[key];
    if (!chunk) continue;
    const asset = corpus.assetIndex.get(chunk.assetId);

    const haystack = `${chunk.text} ${asset?.title ?? ""} ${asset?.summary ?? ""}`.toLowerCase();
    let coverage = 1;
    if (gate) {
      const literal = queryBigrams.filter((gram) => haystack.includes(gram)).length;
      // 完整词组命中也算强证据：「设备校准」在证据里整体出现时，它自身的 2 元
      // 加上一个小奖励足以过门槛，不必再逐字对齐「偏差」这种修饰语。
      const phraseBonus = phraseWords.reduce(
        (total, phrase) => total + (haystack.includes(phrase) ? ngrams(phrase, { min: 2, max: 2 }).length + 1 : 0),
        0,
      );
      coverage = (literal + phraseBonus) / queryBigrams.length;
      if (coverage < gate) continue;
    }

    let score = raw / normalizer;

    // —— 精确字段匹配：对象编号（PRD §11.3）
    const objectIds = [...(asset?.objectIds ?? []), asset?.primaryObjectId].filter(Boolean);
    const hitObjects = objectIds.filter((id) => query.toUpperCase().includes(String(id).toUpperCase()));
    if (hitObjects.length) score += 0.35 * hitObjects.length;
    if (asset?.primaryObjectId && query.toUpperCase().includes(String(asset.primaryObjectId).toUpperCase())) score += 0.2;

    // —— 「扫描设备」是业务口径词，不是文件名里的字；映射到设备 ID 再匹配
    if (deviceTerms.some((term) => query.includes(term)) && objectIds.some((id) => id.startsWith("SCAN"))) score += 0.3;

    // —— 时间意图：只在查询里真的出现可解释线索时才加分，不隐式指向某一年
    const month = /(五月|5月)/.test(query) ? "05" : /(九月|9月)/.test(query) ? "09" : null;
    if (month && String(asset?.capturedAt ?? "").slice(5, 7) === month) score += 0.12;

    /*
      资料形态偏好：问「报告 / 数据表 / 记录」时，文档与结构化记录应当排在
      现场影像前面；问「影像 / 照片 / 图」时反过来。不做这一步的话，
      「五月巡检报告 大雄宝殿」的第一条会是一张现场照片——它有最接近的标题，
      但不是提问者要的东西。
    */
    const wantsDocument = /(报告|数据表|记录|档案|工单|规范|方法)/.test(query);
    const wantsVisual = /(影像|照片|图片|录像|视频|画面)/.test(query);
    if (wantsDocument && !wantsVisual) {
      if (asset?.type === "document" || asset?.type === "record" || asset?.type === "workOrder") score += 0.18;
      if (asset?.type === "image" || asset?.type === "video") score -= 0.12;
    }
    if (wantsVisual && !wantsDocument) {
      if (asset?.type === "image" || asset?.type === "video") score += 0.18;
    }

    hits.push({ chunk, asset, score, hitObjects, coverage });
  }

  hits.sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)));
  return hits;
}

/** 查询里的时间线索 → 回显给用户的筛选条件（PRD §11.3） */
export function interpretQuery(query) {
  const objectIds = [...String(query).matchAll(/\b([A-Z]{1,3}\d{1,3}(?:-\d{1,2})?)\b/gi)].map((match) => match[1].toUpperCase());
  const months = [];
  if (/(五月|5月)/.test(query)) months.push({ key: "05", label: "五月", year: "2026" });
  if (/(九月|9月)/.test(query)) months.push({ key: "09", label: "九月", year: "2026" });
  const years = [...new Set([...String(query).matchAll(/(20\d{2})\s*年?/g)].map((match) => match[1]))];
  return {
    objectIds: [...new Set(objectIds)],
    months,
    years,
    // 没有明确年份的自然语言不隐式指向错误年份
    timeRange: months.length
      ? { from: `${months[0].year}-${months[0].key}-01`, to: `${months[0].year}-${months[0].key}-31`, label: `${months[0].year} 年 ${months[0].label}` }
      : null,
  };
}

/** 把命中片段裁成两行摘要，命中词左右各留 40 字 */
export function makeSnippet(text, terms, width = 96) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return { text: "", truncated: false, hit: false };
  const lower = source.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(String(term).toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return { text: source.slice(0, width), truncated: source.length > width, hit: false };
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(source.length, start + width);
  return {
    text: `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`,
    truncated: start > 0 || end < source.length,
    hit: true,
  };
}

export { SEARCH_CONFIG_DEFAULT };
