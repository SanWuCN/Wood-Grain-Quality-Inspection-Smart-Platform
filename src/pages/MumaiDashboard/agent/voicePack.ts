/**
 * 小木播报的**预生成语音包**（用外部 TTS 合成的音频替换浏览器语音）
 *
 * ── 为什么是"按文本精确匹配"而不是"按意图播"──────────────────────
 * 播报要替换的是**用户看到的那句话**。而 `composeReply` 会在同义模板之间随机挑，
 * 同一意图每次说的字可能不一样（`weatherRange…` 那一串是固定的，别的未必）。
 * 如果按意图硬播一段录音，就会出现"气泡里写 A、喇叭里念 B"——
 * 比声音不好听严重得多（用户会以为系统答错了）。
 * 所以这里的规则是：
 *   · manifest 的键 = **完整播报文本**，值 = 音频文件路径；
 *   · 运行时拿"正要播的文本"去精确匹配，命中才播文件；
 *   · 没命中（换模板了 / 没录）→ 自动回退 `speechSynthesis`，界面文案不受影响。
 *
 * ── 文件怎么放 ──────────────────────────────────────────────────
 * 音频放 `public/voice/`，路径写进 `public/voice/manifest.json`；
 * 具体命名、生成步骤、以及"哪些句子值得录"见 `public/voice/README.md`。
 *
 * 加载失败（没有 manifest / 网络错 / JSON 坏）一律当作"空语音包"，
 * 绝不抛到调用方 —— 播报不该因为语音包缺失而中断。
 */

type VoicePack = Record<string, string>;

const MANIFEST_URL = "/voice/manifest.json";

let cache: VoicePack | null = null;
let loading: Promise<VoicePack> | null = null;

/**
 * 语音包键的比对口径：**只去掉空白**，标点保持原样。
 *
 * ── 为什么不能"顺手把标点也去掉"（这里踩过坑，写在最前面）──────────────
 * 容易误以为"既然匹配用的是 `lang.ts` 的 `normalize()`（去标点 + 全角半角 + 同音折叠），
 * 那这里也该同口径"。**不能**：
 *   · manifest 的键是**录音时逐字粘进 TTS 的那句话**，标点是音频内容的一部分；
 *   · 一旦在这里去掉标点，键会与"运行时播报文本"错位，命中面反而变窄，
 *     结果是**已录好的音频集体失配、静默回退浏览器合成音**——现场听起来只是"音色变了"，
 *     极难察觉（`voicePack` 的失败是静默的）。
 * 所以两种口径是**故意**不同的：语义匹配求宽容，音频匹配求逐字。
 * `manifest.json` 自己的 `_注意` 也写着"键必须与运行时文本逐字一致（含全角标点）"。
 */
function normalize(text: string): string {
  // 只处理空白差异（首尾空白、行内多余空格）——标点、全角字符、大小写一律保持
  return text.trim().replace(/[\s]+/g, "");
}

async function load(): Promise<VoicePack> {
  /*
    缓存语义（与下面的注释一致，别只看其一）：
      · 成功 → 写入 `cache`，之后不再请求；
      · **失败（HTTP 非 200 / JSON 坏 / 网络错）→ 不写 `cache`**，
        下次调用会重新尝试。这是刻意的：演示中途把语音包补上、或服务端刚起来时，
        下一次播报就能命中，而不是"一次失败、整场都走合成音"。
      · 无论成败都清 `loading`，避免一次失败把后续调用永久挂在同一个 Promise 上。
  */
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) return {};
      const raw = (await res.json()) as unknown;
      if (!raw || typeof raw !== "object") return {};
      const pack: VoicePack = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string" && value) pack[normalize(key)] = value;
      }
      cache = pack;
      return pack;
    } catch {
      return {};
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * 这段文本有没有对应的预生成音频？
 *
 * 返回 `null` 表示"没录/没命中"，调用方**不再回退浏览器合成音**（见 `tts.ts` 的
 * `SYNTHESIS_FALLBACK_ENABLED`）：用户口径是「播放的都是音频而非合成音」。
 * 这是异步的（要取 manifest）：**成功后**只在首次真正读一次，之后走内存缓存；
 * 读取失败不缓存，下一次播报会重试（见 `load()` 的缓存语义说明）。
 */
export async function audioUrlForText(text: string): Promise<string | null> {
  if (!text) return null;
  const pack = await load();
  return resolveAudio(pack, text);
}

/**
 * 匹配判据：两句的**最长公共子序列**要占到其中较长那句的这么多。
 *
 * ── 为什么是 LCS 而不是前缀/编辑距离（2026-10-01 量的）────────────────
 * 实测七组真实句对，只有 LCS 能一刀切开"同一句漂移"和"不是同一句"：
 *
 * | 组 | 占较长句 | 结论 |
 * |---|---|---|
 * | 同一句 · 末尾取值漂移（91%→86%、执行中→idle） | 83% | 认 |
 * | 同一句 · 中间插入目标（`{goal}` 由 planner 现算） | 74% | 认 |
 * | 同一句 · 状态词漂移 | 84% | 认 |
 * | **不是**同一句 · 只说了半句（"已开始执行巡检任务" vs 整句录音） | 13% | 不认 |
 * | **不是**同一句 · 同开头不同事 | 6% | 不认 |
 * | **不是**同一句 · 六字短句 | 33% | 不认 |
 *
 * 编辑距离那条路走不通：末尾漂移 16.7%（可认）与六字短句 66.7%（不能认）之间
 * 没有安全地带；前缀那条更差（数字一出现前缀就断在 18 个字）。
 */
export const AUDIO_MATCH_RATIO = 0.6;

/**
 * 录音键比运行时文本**最长**能多多少（比例）。
 *
 * 为什么需要这条：短句不该去认领一条长录音 —— 那是"说了半句就开始念别的"。
 * LCS 判据对"半句 vs 整句"本来就会因为分母是长句而落到 13%，这条是第二道闸。
 */
export const AUDIO_LENGTH_SLACK = 1.6;

/** 两句文本的公共前缀长度（按字符；输入是已归一化、无空白的文本） */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

/** 两句文本的公共后缀长度（按字符） */
export function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

/**
 * 最长公共子序列长度（滚动数组，O(n·m)）。
 *
 * 本句与录音键都在 100 字以内，一次匹配要跑约 90 个候选 —— 几万次操作，
 * 相对一次播报的开销可以忽略；换来的是"取值漂移也能认回录音"。
 */
export function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/**
 * 两句是不是"同一句、只有一小段取值不同"。
 *
 * 判据（三条同时成立才认）：
 *   ① LCS ≥ 较长那句的 `AUDIO_MATCH_RATIO`；
 *   ② 录音不比本句长太多（`AUDIO_LENGTH_SLACK`）—— 说了半句不许去念一整段；
 *   ③ 逐字相同当然直接算同一句。
 */
export function looksLikeSameSentence(spoken: string, recorded: string): boolean {
  if (spoken === recorded) return true;
  if (recorded.length > spoken.length * AUDIO_LENGTH_SLACK) return false;
  const lcs = lcsLength(spoken, recorded);
  return lcs >= Math.max(spoken.length, recorded.length) * AUDIO_MATCH_RATIO;
}

/**
 * 在语音包里找这一句对应的音频：**先逐字，再认"同一句、取值漂移"**。
 *
 * ── 为什么需要这一步（2026-10-01 实测出来的真缺口）──────────────────
 * 录音是**按当时的演示取值**录的，而这些句子里带着会变的东西：
 *   · 录音：「…（电池 **91%**），到位后任务状态为 **执行中**。」
 *   · 现在：「…（电池 **86%**），到位后任务状态为 **idle**。」
 * 两句只差取值，但逐字匹配必然落空 —— 语音包里有这条录音却用不上，
 * 现场听到的就是"没声音"（关掉合成音之后）或"机器音"（以前）。
 * 判据见 `looksLikeSameSentence`；两条并列最高（分不出是哪句）时**不猜**。
 */
export function resolveAudio(pack: VoicePack, text: string): string | null {
  const key = normalize(text);
  if (!key) return null;
  /* ① 逐字命中：这是常态，也优先 */
  const exact = pack[key];
  if (exact) return exact;

  /* ② 同一句、取值漂移：按 LCS 最高取，并列就不猜 */
  let best: { url: string; score: number } | null = null;
  let tied = 0;
  for (const [candidate, url] of Object.entries(pack)) {
    if (!looksLikeSameSentence(key, candidate)) continue;
    const score = lcsLength(candidate, key);
    if (!best || score > best.score) {
      best = { url, score };
      tied = 1;
    } else if (score === best.score) {
      tied += 1;
    }
  }
  return best && tied === 1 ? best.url : null;
}

/** 给验收/运维看的：语音包里有多少条（不触发网络请求也要能读到缓存） */
export function voicePackSize(): number {
  return cache ? Object.keys(cache).length : 0;
}

/**
 * 语音包里**实际存在的音频条数**（惰性加载清单后统计）。
 *
 * 与 `voicePackSize()` 的区别：那个只读缓存、缓存没热时返回 0；
 * 这个是异步的，会触发一次清单加载 —— 需要**一个真实段数**、
 * 且不想编数字的地方用它（例如同步备份小窗里的"…段播报语音已同步"）。
 * 清单加载失败一律按 0 计，调用方据此隐藏该行，而不是显示一个假数。
 */
export async function voicePackEntryCount(): Promise<number> {
  const pack = await load();
  return Object.keys(pack).length;
}
