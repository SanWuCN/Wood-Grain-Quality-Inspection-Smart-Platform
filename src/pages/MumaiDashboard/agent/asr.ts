/**
 * 小木语音智能体 · 语音识别层（技术方案 §6 / §7 / §8 / §46 / §49）
 *
 * 三条路径，按可用性依次降级，任何一条失败都不抛错、不白屏：
 *
 *   A. 真实流式 ASR（首选）
 *      浏览器 SpeechRecognition（Chromium 内核是 webkitSpeechRecognition），
 *      lang = 'zh-CN'，continuous + interimResults = true → 真·逐字 partial 字幕。
 *      方案 §8 的「帮 → 帮我 → 帮我打开…」就是这条路径的效果。
 *      局限（PRD 4.3 也写明）：需要安全上下文与浏览器自带服务，兼容性不稳定，
 *      所以**不能作为唯一入口**。
 *
 *   B. 麦克风 VAD（真实音量）
 *      getUserMedia + AudioContext + AnalyserNode 算 RMS 电平：
 *        - 电平超过阈值 → speech_start（LISTENING）
 *        - 持续静音 end_silence_ms(500ms) → sentence_end（触发最终语义判断）
 *        - 播报期间检测到 speech_start → Barge-in，立即打断当前播报（§7）
 *      方案推荐 FSMN-VAD / Silero VAD 在后端做；本演示没有后端，
 *      用「音量阈值 + 静音时长」做 VAD 的等价判定，并且**不写 AudioWorklet PCM**
 *      （没有 WebSocket、没有 ASR 服务，写 PCM 只会平白多一层复杂度）。
 *      参数沿用方案 §7 的初始值：start_threshold_ms 150 / end_silence_ms 500 / max_utterance_ms 15000。
 *
 *   C. 脚本化降级（SIMULATED）
 *      点「示例问句」时按 100–300ms 的节奏逐字吐出 partial，再给 final。
 *      这条路径保证**没有麦克风权限的机器**（包括无头浏览器、评委的临时电脑）
 *      也能完整演示「实时字幕 → 语义理解 → 工具执行 → 语音反馈」。
 *      PRD 4.3 的要求：麦克风不可用时按钮必须明确进入「演示语句选择」。
 */

/** 最小化的 SpeechRecognition 接口声明（TS 标准库没有它，不用 any 满屏） */
type SpeechRecognitionAlternativeLike = { transcript: string; confidence: number };
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
type SpeechRecognitionErrorLike = { error: string; message?: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

/** VAD 参数（数值来源：技术方案 §7 的 vad 配置块） */
export const VAD_CONFIG = {
  /** 电平超过它就算「有人在说话」 */
  speechLevel: 0.055,
  /** 说话开始需要维持的时间（方案 start_threshold_ms: 150） */
  startThresholdMs: 150,
  /** 静音多久算一句话说完（方案 end_silence_ms: 500） */
  endSilenceMs: 500,
  /** 单句最长时长（方案 max_utterance_ms: 15000），超时强制收尾 */
  maxUtteranceMs: 15000,
} as const;

/** 脚本化降级时逐字吐字的节奏（方案 §46：实时字幕 100–300ms 级更新） */
export const SIMULATED_TYPING = { minMs: 100, maxMs: 300 } as const;

/** 电平上报节流：60fps 每帧 emit 会把 React 打爆（Maximum update depth），压到约 20Hz */
const LEVEL_REPORT_MS = 50;

export type AsrMode = "real" | "simulated";

export type AsrHandlers = {
  /** 开始收音 */
  onListening: () => void;
  /** 实时字幕（partial） */
  onPartial: (text: string, final: boolean) => void;
  /** 麦克风电平 0–1 */
  onLevel: (level: number) => void;
  /** 一句话结束，交给语义链路 */
  onFinal: (text: string, via: "mic" | "example") => void;
  /** VAD 事件：说话开始 / 结束（也用于 Barge-in 判定） */
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  /** 通道说明与错误提示（不抛错，只提示） */
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  /** 播报中的打断钩子：检测到用户开始说话时调用 */
  onBargeIn: () => void;
};

export type AsrStatus = {
  mode: AsrMode;
  /** 真实麦克风是否拿到了权限 */
  micGranted: boolean;
  /** 浏览器是否支持 SpeechRecognition */
  recognitionSupported: boolean;
  /** 是否正在采集 */
  active: boolean;
  notice: string;
};

const FALLBACK_TEXT = "当前设备不可用真实语音识别，已切换到脚本化演示：点示例问句即可看到完整链路。";

/** 浏览器是否提供 SpeechRecognition（Chromium 需要 webkit 前缀） */
export function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as SpeechWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function recognitionSupported(): boolean {
  return recognitionCtor() !== null;
}

/** 麦克风 API 是否可用（http 非 localhost 时 navigator.mediaDevices 是 undefined） */
export function microphoneSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * 语音输入通道。
 *
 * 用法（VoiceConsole 里）：
 *   const asr = useRef(new VoiceInput(handlers));
 *   await asr.current.startMic();     // 抢权限 + 开 VAD（+ 真实 ASR）
 *   asr.current.simulate("查今年五月示例寺巡检");   // 脚本化降级
 *   asr.current.stopAll();
 */
export class VoiceInput {
  private handlers: AsrHandlers;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private frame = 0;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private simulatedTimer: number | null = null;
  private lastVoiceAt = 0;
  private speaking = false;
  private utteranceStartedAt = 0;
  private levelSmoothed = 0;
  private lastReportAt = 0;
  private disposed = false;
  private lastTranscript = "";

  constructor(handlers: AsrHandlers) {
    this.handlers = handlers;
  }

  /* ---------------- B：麦克风 VAD ---------------- */

  /** 抢麦克风权限并启动电平分析；失败时返回 false（调用方自动切脚本模式） */
  async startMic(): Promise<boolean> {
    if (!microphoneSupported()) {
      this.handlers.onNotice("当前环境没有麦克风接口（非安全上下文或浏览器不支持），已切换到演示语句模式。");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;
      const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        this.handlers.onNotice("浏览器不支持 Web Audio，音量电平不可用；语义与执行链路不受影响。");
        return true;
      }
      this.audioContext = new AudioContextCtor();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      source.connect(this.analyser);
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      this.speaking = false;
      this.lastVoiceAt = performance.now();
      this.utteranceStartedAt = 0;
      this.handlers.onListening();
      this.tick();
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      this.handlers.onNotice(
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，已切换到演示语句模式：点示例问句同样能看到完整链路。"
          : `麦克风不可用（${name}），已切换到演示语句模式。`,
      );
      return false;
    }
  }

  /** 每帧算 RMS 电平并跑 VAD 状态机；电平上报按 LEVEL_REPORT_MS 节流 */
  private tick = () => {
    if (this.disposed || !this.analyser || !this.buffer) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    // 略微平滑，避免电平条抖动
    this.levelSmoothed = this.levelSmoothed * 0.7 + Math.min(1, rms * 4.2) * 0.3;

    const now = performance.now();
    if (now - this.lastReportAt >= LEVEL_REPORT_MS) {
      this.lastReportAt = now;
      // 保留两位小数：界面够用，也能让 React 少做无用渲染
      this.handlers.onLevel(Math.round(this.levelSmoothed * 100) / 100);
    }

    const loud = this.levelSmoothed > VAD_CONFIG.speechLevel;
    if (loud) {
      this.lastVoiceAt = now;
      if (!this.speaking) {
        // speech_start：既用于 VAD 计时，也用于 Barge-in（§7）
        this.speaking = true;
        this.utteranceStartedAt = now;
        this.handlers.onSpeechStart();
      }
    } else if (this.speaking && now - this.lastVoiceAt > VAD_CONFIG.endSilenceMs) {
      // sentence_end：静音约 500ms → 触发最终语义判断
      this.speaking = false;
      this.handlers.onSpeechEnd();
      this.handlers.onFinal(this.lastTranscript, "mic");
    }
    if (this.speaking && now - this.utteranceStartedAt > VAD_CONFIG.maxUtteranceMs) {
      // 超长语音强制收尾，避免一直不触发 sentence_end
      this.speaking = false;
      this.handlers.onSpeechEnd();
      this.handlers.onFinal(this.lastTranscript, "mic");
    }
    this.frame = window.requestAnimationFrame(this.tick);
  };

  /* ---------------- A：真实流式识别 ---------------- */

  /** 启动浏览器 SpeechRecognition（可用时优先用它出 partial 字幕） */
  startRecognition(): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) return false;
    try {
      const recognition = new Ctor();
      recognition.lang = "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let tail = "";
      recognition.onresult = (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interim += transcript;
        }
        if (finalText) {
          tail = `${tail}${finalText}`;
          this.handlers.onPartial(tail, true);
          this.handlers.onFinal(tail.trim(), "mic");
          tail = "";
        } else if (interim) {
          this.handlers.onPartial(`${tail}${interim}`, false);
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.handlers.onNotice("浏览器的语音识别服务拒绝了请求，已切换到演示语句模式。");
        } else if (event.error === "no-speech") {
          this.handlers.onNotice("没有检测到语音，可以点示例问句或直接输入文本。");
        } else {
          this.handlers.onNotice(`语音识别返回 ${event.error}，脚本化演示仍然可用。`);
        }
      };
      recognition.onend = () => {
        // continuous 模式在部分浏览器会自动结束，这里按需重启
        if (!this.disposed && this.recognition && this.stream) {
          try {
            recognition.start();
          } catch {
            /* 已经在跑，忽略 */
          }
        }
      };
      recognition.start();
      this.recognition = recognition;
      return true;
    } catch {
      return false;
    }
  }

  /** 语音识别或脚本模式给出的当前字幕（外部只读） */
  setTranscript(text: string) {
    this.lastTranscript = text;
  }

  /* ---------------- C：脚本化降级 ---------------- */

  /**
   * 逐字吐出一句话，模拟流式 ASR。
   * 节奏 100–300ms/字（方案 §46：字幕 100–300ms 级更新），最后给 final。
   * 返回一个可取消的句柄。
   */
  simulate(text: string, options: { perCharMs?: number; silent?: boolean } = {}): () => void {
    this.cancelSimulation();
    const chars = Array.from(text);
    let index = 0;
    this.handlers.onListening();
    this.setTranscript("");
    const step = () => {
      if (this.disposed) return;
      index += 1;
      const partial = chars.slice(0, index).join("");
      this.setTranscript(partial);
      this.handlers.onPartial(partial, false);
      if (!options.silent) {
        // 脚本模式没有真实麦克风，用电平的确定性起伏驱动电平条与声波
        const wave = 0.45 + 0.35 * Math.abs(Math.sin(index * 0.8));
        this.handlers.onLevel(wave);
      }
      if (index >= chars.length) {
        this.simulatedTimer = window.setTimeout(() => {
          this.handlers.onSpeechEnd();
          this.handlers.onLevel(0);
          this.handlers.onPartial(text, true);
          this.handlers.onFinal(text, "example");
        }, 180);
        return;
      }
      const gap = options.perCharMs ?? SIMULATED_TYPING.minMs + Math.random() * (SIMULATED_TYPING.maxMs - SIMULATED_TYPING.minMs);
      this.simulatedTimer = window.setTimeout(step, gap);
    };
    this.simulatedTimer = window.setTimeout(step, 120);
    return () => this.cancelSimulation();
  }

  cancelSimulation() {
    if (this.simulatedTimer !== null) {
      window.clearTimeout(this.simulatedTimer);
      this.simulatedTimer = null;
    }
  }

  /* ---------------- 生命周期 ---------------- */

  get status(): AsrStatus {
    return {
      mode: this.recognition ? "real" : "simulated",
      micGranted: this.stream !== null,
      recognitionSupported: recognitionSupported(),
      active: this.stream !== null || this.simulatedTimer !== null,
      notice: this.recognition ? "真实语音识别通道" : this.stream ? "麦克风 VAD（识别走脚本或文本）" : FALLBACK_TEXT,
    };
  }

  stopMic() {
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.handlers.onLevel(0);
  }

  stopAll() {
    this.cancelSimulation();
    this.stopMic();
    try {
      this.recognition?.stop();
    } catch {
      /* 未启动时忽略 */
    }
    this.recognition = null;
  }

  dispose() {
    this.disposed = true;
    this.stopAll();
  }

  /** 用户是否正在说话（Barge-in 判定用） */
  get isSpeaking(): boolean {
    return this.speaking;
  }
}

/** 一句话的展示时长估计（毫秒）：用于「按住说话」松开后给一个合理的 VAD 收尾时间 */
export function estimatedUtteranceMs(text: string): number {
  return Math.min(VAD_CONFIG.maxUtteranceMs, 600 + Array.from(text).length * 120);
}
