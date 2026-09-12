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
 */

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

/** 预录音频探测结果缓存：同一个路径只探测一次，避免重复网络请求 */
const audioProbe = new Map<string, boolean>();

function synthesis(): SpeechSynthesisLike | null {
  if (typeof window === "undefined") return null;
  const scope = window as Window & { speechSynthesis?: SpeechSynthesisLike };
  return scope.speechSynthesis ?? null;
}

/**
 * 探测预录音频是否存在。
 * 用 HEAD 请求 + <audio> 的 canplay 判定：不存在就直接回落 TTS，不抛错。
 */
export async function probeAudio(url: string): Promise<boolean> {
  const cached = audioProbe.get(url);
  if (cached !== undefined) return cached;
  const result = await new Promise<boolean>((resolve) => {
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      resolve(false);
      return;
    }
    const audio = new Audio();
    const done = (ok: boolean) => {
      audio.oncanplaythrough = null;
      audio.onerror = null;
      resolve(ok);
    };
    audio.oncanplaythrough = () => done(true);
    audio.onerror = () => done(false);
    audio.preload = "auto";
    audio.src = url;
    // 兜底超时：1.2s 内没有结论就认为没有素材
    window.setTimeout(() => done(false), 1200);
  });
  audioProbe.set(url, result);
  return result;
}

/** 选一个中文语音（优先本地离线语音，避免依赖联网语音服务） */
function pickVoice(synth: SpeechSynthesisLike): SpeechSynthesisVoice | null {
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const zh = voices.filter((voice) => voice.lang?.toLowerCase().startsWith("zh"));
  if (!zh.length) return null;
  return zh.find((voice) => voice.localService) ?? zh[0];
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
    try {
      this.current.pause();
      this.current.src = "";
    } catch {
      /* 忽略 */
    }
    this.current = null;
  }

  /** 播报一段文本；优先播放预录音频（若存在），否则用 speechSynthesis */
  async speak(text: string, audioUrl?: string): Promise<void> {
    if (this.muted || !text) return;
    // 新一段接替旧一段：先把还在响的 <audio> 收掉，避免两段声音叠在一起
    this.silenceCurrent();
    if (audioUrl && (await probeAudio(audioUrl))) {
      const played = await this.playAudio(audioUrl);
      if (played) return;
    }
    this.speakWithSynthesis(text);
  }

  private playAudio(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const audio = new Audio(url);
        this.generation += 1;
        const token = this.generation;
        this.current = audio;
        this.setSpeaking(true);
        const finish = (ok: boolean) => {
          // 迟到的回调（被 stop()/换段之后才触发）不许改状态：代次不匹配就只兑现 Promise
          if (token === this.generation) {
            if (this.current === audio) this.current = null;
            this.setSpeaking(false);
          }
          resolve(ok);
        };
        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);
        void audio.play().catch(() => finish(false));
      } catch {
        resolve(false);
      }
    });
  }

  private speakWithSynthesis(text: string) {
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
      this.generation += 1;
      const token = this.generation;
      const finish = () => {
        // cancel() / stop() 之后旧 utterance 的 end / error 事件可能迟到，
        // 代次不匹配就丢弃（否则它会把新一段的 speaking 提前压回 false）
        if (token !== this.generation) return;
        this.setSpeaking(false);
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      this.setSpeaking(true);
      synth.speak(utterance);
    } catch {
      this.setSpeaking(false);
    }
  }

  /** Barge-in（§7）：立即停止播报 */
  stop() {
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
