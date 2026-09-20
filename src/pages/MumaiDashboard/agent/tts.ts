/**
 * 小木语音智能体 · 语音播报（技术方案 §28 / §29 / §30 / §31）
 *
 * 方案的音频优先级：预录真人音频 > 提前生成的高质量 TTS > 运行时本地 TTS。
 * 本仓库没有任何音频素材（public/ 下没有 audio 目录），因此：
 *
 *   1. 先看意图声明的 response.audio 是否存在（存在就播预录音频，延迟最低）；
 *   2. 不存在则回落到浏览器内置的 speechSynthesis —— 它不是云端服务，
 *      Chromium 在 Windows 上会用系统本地语音（zh-CN），离线可用；
 *   3. speechSynthesis 不可用时**静默降级**：只显示字幕，不报错、不白屏
 *      （PRD 17：语音播放失败时字幕继续显示，不阻塞业务）。
 *
 * 同时提供方案 §7 的 Barge-in 所需能力：stop() 立即掐断当前播报，
 * 并把「是否正在播报」暴露给 VAD，用于「用户开口 → 停止播报 → 开新一轮识别」。
 *
 * 另外把播报状态的**每一次翻转**通过可选的 onSpeakingChange 播出去：
 * 输入侧据此在播报期间暂停聆听，从根上切断「AI 听见自己 → 又识别成用户输入」的自听回环。
 *
 * ── 音频优先级（本轮把第 2 条接通了）──────────────────────────────
 * 现在真的按方案的分层走：**预生成语音包 > speechSynthesis > 静默降级**。
 * 语音包放 `public/voice/`（按文本精确匹配，见 agent/voicePack.ts 与
 * `public/voice/README.md`）；没录到的句子自动回退，不会出现"气泡写 A、喇叭念 B"。
 */

import { audioUrlForText } from "./voicePack";

export type TtsStatus = {
  supported: boolean;
  speaking: boolean;
  muted: boolean;
  /** 当前使用的语音通道说明 */
  channel: string;
};

type SpeechSynthesisLike = {
  speak: (utterance: SpeechSynthesisUtterance) => void;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  speaking: boolean;
  pending: boolean;
  getVoices: () => SpeechSynthesisVoice[];
};

/** 预录音频探测结果缓存：同一个路径只探测一次，避免重复网络请求（**只缓存有结论的**，见 `decideProbe`） */
const audioProbe = new Map<string, boolean>();

/**
 * 语音包没命中时，**允许**回退浏览器合成音吗？
 *
 * ── 硬口径（用户 2026-10-01）────────────────────────────────────────
 * 「确保小木播放的都是音频而非合成音」。
 *
 * 所以默认是 **false**：没录音的句子**只出字幕，不出声**。
 * 为什么宁可静音也不合成：
 *   · 合成音与录音是**两个人的音色**。现场只要冒出一次，观众听到的就是
 *     "刚才那个是真人录的，这个是机器念的" —— 这一句比没声音更伤；
 *   · 而"没声音"当场一眼看得出来（字幕还在），也便于事后按 `[tts]` 那条 warn 定位。
 *
 * 回退路径本身**保留**（下面 `speakWithSynthesis` 整段都还在）：以后要是
 * 决定在某些场合允许合成（例如没有麦克风的讲解机环境），把这个常量改成 true 即可，
 * 不用重写播报逻辑。`tts.test.ts` 会核对"这个常量与 `speak()` 的行为一致"。
 */
export const SYNTHESIS_FALLBACK_ENABLED = false;

function synthesis(): SpeechSynthesisLike | null {
  if (typeof window === "undefined") return null;
  const scope = window as Window & { speechSynthesis?: SpeechSynthesisLike };
  return scope.speechSynthesis ?? null;
}

/** 一次探测的结论：有 / 确实没有 / 没在预算内给结论 */
export type ProbeResult = "ok" | "missing" | "timeout";

/**
 * 探测结论该怎么处理（纯函数，`tts.test.ts` 钉住）。
 *
 * ── 为什么要区分 `missing` 与 `timeout`（2026-09-17 实测的现场事故）────
 * 老实现把两者都当"没有素材"，而且**把 false 也缓存**：
 * 首屏正忙（刚登录进来、包刚解析完）时第一轮按键，1.2 秒预算内 `canplaythrough`
 * 还没来 → 判定"没有语音包" → 这一轮**直接回退浏览器合成音**，
 * 而且这个 false 被缓存住，后面的轮次也一起受影响。
 * 现场表现是"第一轮声音是机器的、后面又好了"或者"整场都是机器的"，且不报任何错。
 *
 * 现在的口径：
 *   · `ok`      → 有素材，缓存"有"；
 *   · `missing` → `onerror`，浏览器明确说读不了（多半是文件真不在），缓存"没有"；
 *   · `timeout` → **只是没来得及**，再审一次（更长预算），且**绝不缓存"没有"**。
 */
export function decideProbe(
  result: ProbeResult,
  alreadyRetried: boolean,
): { retry: boolean; cache: boolean; value: boolean } {
  if (result === "ok") return { retry: false, cache: true, value: true };
  if (result === "missing") return { retry: false, cache: true, value: false };
  return { retry: !alreadyRetried, cache: false, value: false };
}

/** 探一次：`canplaythrough` 说有、`onerror` 说没有、超时说不确定 */
function probeOnce(url: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      resolve("missing");
      return;
    }
    const audio = new Audio();
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      audio.oncanplaythrough = null;
      audio.onerror = null;
      resolve(result);
    };
    audio.oncanplaythrough = () => done("ok");
    audio.onerror = () => done("missing");
    audio.preload = "auto";
    audio.src = url;
    window.setTimeout(() => done("timeout"), timeoutMs);
  });
}

/**
 * 探测预录音频是否存在。
 * 用 `<audio>` 的 `canplaythrough` 判定：不存在就直接回落 TTS，不抛错。
 * 超时不算"不存在"—— 再审一次，且不缓存否定结论（见 `decideProbe`）。
 */
export async function probeAudio(url: string): Promise<boolean> {
  const cached = audioProbe.get(url);
  if (cached !== undefined) return cached;
  let retried = false;
  for (;;) {
    const result = await probeOnce(url, retried ? 2600 : 1200);
    const decision = decideProbe(result, retried);
    if (decision.cache) audioProbe.set(url, decision.value);
    if (!decision.retry) return decision.value;
    retried = true;
  }
}

/** 选一个中文语音（优先本地离线语音，避免依赖联网语音服务） */
function pickVoice(synth: SpeechSynthesisLike): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const zh = voices.filter((voice) => voice.lang?.toLowerCase().startsWith("zh"));
  if (!zh.length) return null;
  return zh.find((voice) => voice.localService) ?? zh[0];
}

/**
 * 看门狗窗口：有真实音频时长就按它 + 余量，没有才按文本估（不短于 2.5 秒）。
 *
 * ── 为什么必须能按真实时长算（2026-09-18 实测踩到）──────────────────────
 * 原来只有"字数 × 260ms"这一个口径。第④轮台词换成短句
 * 「收到，已启用同步备份。」（11 字 → 2.86 秒）而**录音本身有 3.12 秒**：
 * 看门狗先到点，把音频 `pause()` 掉 —— 于是 `ended` 永远不来，
 * `playAudio()` 那个 Promise **永远不兑现**，而 `executor` 正等着它
 * （「念完才弹同步备份小窗」、工单详情的逐组展开都挂在同一个 Promise 上）。
 * 现象：小木念完了，但小窗/展开再也不动。
 *
 * 所以：时长能读到就以它为准（录音比估时慢是常态，短句尤其明显），
 * 读不到（`loadedmetadata` 没来）才退回文本估时 —— 但**两条路都必须兑现 Promise**。
 */
export function watchdogMsFor(text: string, audioDurationSec?: number | null): number {
  const fromAudio =
    typeof audioDurationSec === "number" && Number.isFinite(audioDurationSec) && audioDurationSec > 0
      ? audioDurationSec * 1000 + 1200
      : null;
  return Math.max(2500, fromAudio ?? text.length * 260);
}

export class VoiceOutput {
  private muted = false;
  private speaking = false;
  private current: HTMLAudioElement | null = null;
  private onStateChange: (status: TtsStatus) => void;
  /**
   * 播报「代次」。cancel() / stop() 会让在途的 utterance / audio 回调**迟到**触发，
   * 迟到回调若照样翻转状态，就会出现「新一段刚开始播、状态却被上一段改回未播报」——
   * 麦克风提前恢复聆听，又把小木自己的声音收进来。回调只在代次匹配时生效。
   */
  private generation = 0;

  /** 看门狗句柄：`onend`/`onerror` 都没来时的兜底（见 speakWithSynthesis 里的说明） */
  private watchdog: number | null = null;

  private clearWatchdog() {
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * 播报状态变化的旁路回调（可选）。
   *
   * VoiceConsole 用它把小木的「开口 / 说完」翻译成「暂停聆听 / 恢复聆听」，
   * 这是自听回环（AI 的声音被麦克风重新采集 → 又被识别成用户输入 → 再回一句）
   * 的根治手段。可选是刻意的：不接线时 VoiceOutput 的行为与以前完全一致。
   */
  onSpeakingChange?: (speaking: boolean) => void;

  constructor(onStateChange: (status: TtsStatus) => void = () => undefined) {
    this.onStateChange = onStateChange;
    // 语音列表在部分浏览器是异步返回的，预热一次
    const synth = synthesis();
    if (synth) synth.getVoices();
  }

  get status(): TtsStatus {
    return {
      supported: synthesis() !== null,
      speaking: this.speaking,
      muted: this.muted,
      channel: this.muted ? "已静音" : synthesis() ? "浏览器本地语音合成（zh-CN）" : "环境不支持语音合成，仅显示字幕",
    };
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.stop();
    this.emit();
  }

  private emit() {
    this.onStateChange(this.status);
  }

  /**
   * `speaking` 的**唯一**写入点。
   *
   * 之所以收敛成一个方法：开始播报 / 自然结束 / 被 stop() 打断 / setMuted(true) 触发停止 /
   * replay / 播放失败，每一处都要翻转它。只要漏掉一个分支，状态就会卡住 ——
   * 卡在 true 表现为「麦克风再也不恢复」，卡在 false 表现为「播报期间照样收音」（自听回环复发）。
   * 收敛在这里，翻转与通知（onStateChange + onSpeakingChange）就永远不会脱节。
   */
  private setSpeaking(next: boolean) {
    if (this.speaking === next) return;
    this.speaking = next;
    this.emit();
    try {
      this.onSpeakingChange?.(next);
    } catch {
      // 旁路回调：它抛错不能影响播报本身，也不该冒泡进 React 的渲染流程
    }
  }

  /** 收掉当前 <audio>（换一段播报时用）：只清资源，不动 speaking 状态 */
  private silenceCurrent() {
    if (!this.current) return;
    const audio = this.current;
    this.current = null;
    try {
      /**
       * 摘掉回调再清 src：`src = ""` 会让元素异步抛
       * `MEDIA_ELEMENT_ERROR: Empty src attribute`，若不摘回调，这条错会去兑现
       * **上一轮** playAudio 的 Promise（详见 playAudio 里 finish 的说明）。
       */
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    } catch {
      /* 忽略 */
    }
  }

  /** 播报一段文本；优先播放**预生成语音包**里的音频，其次 audioUrl，最后 speechSynthesis */
  async speak(text: string, audioUrl?: string): Promise<void> {
    if (this.muted || !text) return;
    /**
     * ⚠ 代次必须在**最前面**推进，不能等 `playAudio()`（2026-09-19 现场修）。
     *
     * `speak()` 里有两次 `await`（查语音包清单 + 探音频），期间它**什么都没作废**：
     *   · 旧的 `silenceCurrent()` 只能掐掉"已经在响的 <audio>"，
     *     掐不掉**还停在探测阶段**的那一次；
     *   · 旧代码把 `generation += 1` 放在 `playAudio()` 里 —— 那是探测**之后**，
     *     窗口早就过去了。
     *
     * 于是连着按两次快捷键（剧本一条龙 / 快速连按）时：
     *   第一轮的 `speak()` 还挂在探测上 → 第二轮的 `silenceCurrent()` 收了个空
     *   → 第一轮探测完照样 `play()` → **两段录音同时响**。
     *
     * 同理，探测超时会让这一轮回退合成音（用户听到的"有时候是机器的"）：
     * 令牌在入口就推进之后，作废的那一轮会在两个检查点安静收场 ——
     * 既不叠音，也不会补一遍合成音去盖住正在播的新录音。
     */
    const token = ++this.generation;
    // 新一段接替旧一段：先把还在响的 <audio> 收掉，避免两段声音叠在一起
    this.silenceCurrent();
    /**
     * 语音包优先：调用方没显式给 URL 时，按**文本精确匹配**去语音包里找
     * （见 agent/voicePack.ts 的说明：命中才播，不命中自动回退，绝不会出现
     * "气泡写 A、喇叭念 B"）。放在这里而不是各个调用点，是为了让
     * 气泡与控制台两条播报路径共用同一份规则。
     */
    const resolved = (audioUrl || (await audioUrlForText(text))) || undefined;
    /* 查清单这几毫秒里可能已经有新的一段接替（连按快捷键）：作废就安静收场 */
    if (token !== this.generation) return;
    /**
     * ⚠ **不再让"探测"挡住已知存在的音频**（2026-09-20 现场修）。
     *
     * 旧写法是 `if (resolved && (await probeAudio(resolved)))` —— 探测有 1.2 秒预算
     * （超时再审一次，共约 3.8 秒）。现场踩到的是**首屏那一次**：
     * 页面冷启动时 JS 正忙、音频还没进缓存，`canplaythrough` 在预算内没来 →
     * 探测判"没素材" → **这一轮直接回退浏览器合成音**，而文件其实存在；
     * 之后再按同一轮就好了 —— 用户看到的就是"有时候是合成音"，且毫无规律。
     *
     * 现在分两种情况，各用各的判据：
     *   · **清单里指明了音频**（`audioUrl` 显式给了，或语音包命中）→ 直接播，
     *     慢就慢一点，让 `onerror` 来决定"真的没有"（真没有时它会回退合成音）；
     *   · **没有明确 URL** → 保留探测：它省掉一次注定失败的请求，也避免
     *     浏览器因为 404 在控制台记一笔（仓库的验收判据里有"console error = 0"）。
     */
    if (resolved) {
      const playedDirect = await this.playAudio(resolved, text, token);
      if (playedDirect) return;
    }
    /*
      ── 走到这里 = 这一句没有可用音频（语音包没这条键 / 文件放不出来）──
      用户口径（2026-10-01）：「确保小木播放的都是音频而非合成音」。
      所以默认**不合成**：只留字幕，并记一条 warn 便于定位（"哪句没录音"是可查的事实，
      而不是靠耳朵猜）。要恢复旧行为把 `SYNTHESIS_FALLBACK_ENABLED` 改成 true。
    */
    if (!SYNTHESIS_FALLBACK_ENABLED) {
      if (token !== this.generation) return;
      console.warn(`[tts] 没有对应音频，按口径不出合成音（只显示字幕）：${text.slice(0, 40)}…`);
      this.setSpeaking(false);
      return;
    }
    this.speakWithSynthesis(text, token);
  }

  private playAudio(url: string, text = "", token = this.generation): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const audio = new Audio(url);
        /*
          令牌由 `speak()` 在入口发放（见那里的说明）。这里**不再自增**：
          自增会让"第二轮已经作废第一轮"这件事在探测结束前失效。
          被顶掉的那一轮由 `finish()` 的 `token !== this.generation` 分支安静收场。
        */
        if (token !== this.generation) {
          resolve(true);
          return;
        }
        this.current = audio;
        this.setSpeaking(true);
        const finish = (ok: boolean) => {
          /**
           * 代次不匹配 = 这一轮已被 `stop()` / 下一段播报取代，**必须当作"已处理"，
           * 绝不能回退到合成音**。
           *
           * 探针实测出来的真实故障（用户听到的"互动后还是合成音"）：连着问两次时，
           * 第二轮的 `speak()` 一进来就 `silenceCurrent()` 把上一轮的 <audio> 清掉，
           * 上一轮元素随即抛错 → 上一轮那个**早就作废**的 `finish(false)` 兑现了它
           * 挂起的 Promise → 作废的 `speak()` 以为"音频没放成"，于是又合成了一遍
           * **旧文本**，和正在播的新录音叠在一起响。
           *
           * 这里返回 true：作废的那一轮安静收场，不合成、不改状态（`speaking`
           * 由新的那一轮负责）。
           */
          if (token !== this.generation) {
            resolve(true);
            return;
          }
          this.clearWatchdog();
          if (this.current === audio) this.current = null;
          this.setSpeaking(false);
          resolve(ok);
        };
        /**
         * **音频路径也要看门狗**（这是探针实测出来的缺口）。
         *
         * 先只给合成路径加了看门狗，跑 `验收录音链路.mjs` 的看门狗段时
         * `speaking` 仍然是 true —— 因为那次走的正是 <audio> 这条：
         * `onended` / `onerror` 都可能永远不来（文件被缓存层截断、
         * 标签页被节流、`play()` 永远挂起），于是状态卡在"正在说话"。
         * 两条路都必须有兜底。
         *
         * ⚠ 2026-09-18 修的两处（第④轮短句暴露出来的）：
         *   ① **看门狗必须兑现 Promise**：原来只 `pause()` + 清状态，
         *      等 `speak()` 的那些调用方（`executor` 的"念完才弹小窗"、工单详情逐组展开）
         *      会**永远挂住**——录像里就是"话念完了，界面再也不动"。
         *      所以到点就 `finish(true)`：当作这一段已说完，安静收场。
         *   ② 窗口口径改成 `watchdogMsFor()`：**优先用音频真实时长**（+1.2 秒余量），
         *      读不到时长才退回"字数 × 260ms"。11 字录音 3.12 秒 > 估时 2.86 秒，
         *      旧口径必然在看门狗处把音频掐掉。
         */
        const armWatchdog = (ms: number) => {
          this.clearWatchdog();
          this.watchdog = window.setTimeout(() => {
            if (token !== this.generation) return;
            try {
              audio.pause();
            } catch {
              /* 已经停了 */
            }
            /* 兑现挂起的 Promise：只清状态不兑现，等它的人就再也醒不过来 */
            finish(true);
          }, ms);
        };
        if (text) armWatchdog(watchdogMsFor(text));
        /* 元数据到了就按真实时长重排一次看门狗（本地小文件，毫秒级就到） */
        audio.onloadedmetadata = () => {
          if (token !== this.generation) return;
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            armWatchdog(watchdogMsFor(text, audio.duration));
          }
        };
        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);
        /**
         * ⚠ 这里**不再一句 `.catch(() => finish(false))` 就回退合成音**（2026-09-19 现场修）。
         *
         * `play()` 的拒绝与"文件不存在"是两件事，而 `speak()` 里那个 `finish(false)`
         * 会把两者都当成"没录到"，去走 `speakWithSynthesis()`：
         *   · 文件不存在 —— 早被 `probeAudio()` 拦掉了，根本走不到这里；
         *   · `play()` 被拒  —— 自动播放策略（页面还没发生过用户手势）、
         *     音频输出设备切换、标签页被节流、元素被别的播放抢占，
         *     都是**可以被下一次重试或下一次播报解决的临时状态**。
         *
         * 真实现场（用户听到的"大幅度那句变成合成音 / 合成音和录音一起响"）：
         * 两轮挨得近时，`play()` 的拒绝是异步来的，落到 `finish(false)` 上，
         * 于是**旧文本的合成音**被补了一遍，压在新录音上。
         *
         * 所以：确认存在过的文件，`play()` 失败**先重试一次**；仍然失败就安静收场
         * （只记一条 warn）。宁可这一句没声音，也不要错误的音色盖在录音上 ——
         * "没声音"现场一眼看得出来，"错的音色"会被当成"语音包又坏了"。
         */
        const started = (attempt: number): void => {
          /* 已被新的一段顶掉：安静收场，什么都不做 */
          if (token !== this.generation) return;
          try {
            void audio.play().catch(() => {
              if (token !== this.generation) return; /* 重试期间被顶掉：安静 */
              if (attempt === 0) {
                /* 一次重试：自动播放策略 / 设备切换 / 元素被抢占多半是临时的 */
                started(1);
                return;
              }
              console.warn(`[tts] 预录音频播放被浏览器拒绝（文件已确认存在，按"没放成"处理，不回退合成音）：${url}`);
              finish(false);
            });
          } catch {
            /* 同步抛出（元素状态已坏）：同样不回退合成音 */
            console.warn(`[tts] 预录音频起播失败（文件已确认存在，不回退合成音）：${url}`);
            finish(false);
          }
        };
        started(0);
      } catch {
        resolve(false);
      }
    });
  }

  private speakWithSynthesis(text: string, token = this.generation) {
    /*
      令牌同样由 `speak()` 在入口发放。被新一段顶掉的这一轮**连合成音也不许补**：
      否则用户听到的正是"录音和合成音一起响"（旧文本的合成音盖在新录音上）。
    */
    if (token !== this.generation) return;
    const synth = synthesis();
    if (!synth) {
      // 静默降级：字幕继续显示，不抛错（PRD 17）。
      // 也要走 setSpeaking(false)：万一上一段留下了 true，麦克风必须能恢复。
      this.setSpeaking(false);
      return;
    }
    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.rate = 1.05;
      utterance.pitch = 1;
      const voice = pickVoice(synth);
      if (voice) utterance.voice = voice;
      /*
        令牌已在 `speak()` 入口发放（这里**不再自增**）：自增会让"这一轮已被新一段
        顶掉"的判定失去依据，被顶掉的旧 utterance 反倒会把自己的代次认成最新的。
      */
      const finish = () => {
        // cancel() / stop() 之后旧 utterance 的 end / error 事件可能迟到，
        // 代次不匹配就丢弃（否则它会把新一段的 speaking 提前压回 false）
        if (token !== this.generation) return;
        this.clearWatchdog();
        this.setSpeaking(false);
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      /**
       * **看门狗：onend / onerror 都不来时，必须自己把 speaking 放回 false。**
       *
       * 为什么必须有：`speaking` 不只影响界面文案 —— 它还被用来判断
       * "小木正在说话"（barge-in 抢话、播报期间的横幅、恢复聆听的时机）。
       * 实测环境里 `speechSynthesis` 有两种吞事件的方式：
       *   · 浏览器在标签页失去焦点/被节流时直接不发 `end`；
       *   · 音色缺失时 `speak()` 静默丢弃 utterance，既不报错也不结束。
       * 一旦卡在 true，用户按唤醒词也抢不回话（barge-in 不触发），
       * 看起来就是"它哑了但我喊不动它"。
       * 窗口取"按文本长度估的时长 + 余量"，并且**不短于 2.5s**：
       * 太短会在正常朗读中被误判成结束，反而把状态提前放掉。
       */
      const watchdogMs = watchdogMsFor(text);
      this.watchdog = window.setTimeout(() => {
        if (token !== this.generation) return;
        this.setSpeaking(false);
      }, watchdogMs);
      this.setSpeaking(true);
      synth.speak(utterance);
    } catch {
      this.setSpeaking(false);
    }
  }

  /** Barge-in（§7）：立即停止播报 */
  stop() {
    // 看门狗也要一起撤：这段已经停了，不该再有一次"迟到"的状态收尾
    this.clearWatchdog();
    // 先让在途回调失效，再做真正的停止：cancel()/pause() 会让它们的
    // onend/onerror 迟到触发，代次一变就不会再把状态改回来
    this.generation += 1;
    const synth = synthesis();
    try {
      synth?.cancel();
    } catch {
      /* 忽略 */
    }
    this.silenceCurrent();
    // 幂等：本来就没在播报时不会重复通知（setSpeaking 内部挡掉了同值写入）
    this.setSpeaking(false);
  }

  /**
   * 重播上一段（PRD 4.3 要求提供重播）。
   * speaking 的翻转全部由 speak() 内部完成，这里不需要（也不应该）自己再写一次 ——
   * 重播期间同样要暂停聆听，否则重播的声音会被麦克风收进去。
   */
  async replay(text: string, audioUrl?: string): Promise<void> {
    const wasMuted = this.muted;
    this.muted = false;
    await this.speak(text, audioUrl);
    this.muted = wasMuted;
    this.emit();
  }
}
