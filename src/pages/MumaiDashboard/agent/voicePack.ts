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
 * 返回 `null` 表示"没录/没命中"，调用方应当回退到 `speechSynthesis`。
 * 这是异步的（要取 manifest）：**成功后**只在首次真正读一次，之后走内存缓存；
 * 读取失败不缓存，下一次播报会重试（见 `load()` 的缓存语义说明）。
 */
export async function audioUrlForText(text: string): Promise<string | null> {
  if (!text) return null;
  const pack = await load();
  const hit = pack[normalize(text)];
  return hit ?? null;
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
