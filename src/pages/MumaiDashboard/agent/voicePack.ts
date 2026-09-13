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

function normalize(text: string): string {
  // 与匹配同一条口径：去掉首尾空白与句末标点差异带来的假不命中
  return text.trim().replace(/[\s]+/g, "");
}

async function load(): Promise<VoicePack> {
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
 * 这是异步的（要取 manifest），但只在首次真正读一次，之后走内存缓存。
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
