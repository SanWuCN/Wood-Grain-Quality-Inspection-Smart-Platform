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

  /** 播报一段文本；优先播放预录音频（若存在），否则用 speechSynthesis */
  async speak(text: string, audioUrl?: string): Promise<void> {
    if (this.muted || !text) return;
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
        this.current = audio;
        this.speaking = true;
        this.emit();
        const finish = (ok: boolean) => {
          this.speaking = false;
          this.current = null;
          this.emit();
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
      // 静默降级：字幕继续显示，不抛错（PRD 17）
      this.speaking = false;
      this.emit();
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
      utterance.onend = () => {
        this.speaking = false;
        this.emit();
      };
      utterance.onerror = () => {
        this.speaking = false;
        this.emit();
      };
      this.speaking = true;
      this.emit();
      synth.speak(utterance);
    } catch {
      this.speaking = false;
      this.emit();
    }
  }

  /** Barge-in（§7）：立即停止播报 */
  stop() {
    const synth = synthesis();
    try {
      synth?.cancel();
    } catch {
      /* 忽略 */
    }
    if (this.current) {
      try {
        this.current.pause();
        this.current.src = "";
      } catch {
        /* 忽略 */
      }
      this.current = null;
    }
    if (this.speaking) {
      this.speaking = false;
      this.emit();
    }
  }

  /** 重播上一段（PRD 4.3 要求提供重播） */
  async replay(text: string, audioUrl?: string): Promise<void> {
    const wasMuted = this.muted;
    this.muted = false;
    await this.speak(text, audioUrl);
    this.muted = wasMuted;
    this.emit();
  }
}
