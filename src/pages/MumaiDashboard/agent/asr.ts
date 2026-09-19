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

/**
 * **快捷键**路径的"听"节奏（用户 2026-09-30：「加快些快捷键时小木听的速度」）。
 *
 * ── 为什么与上面那组分开，而不是把 100–300 改小 ────────────────────
 * 100–300ms/字 是**降级 ASR 字幕**的口径（方案 §46）：那条路径在模拟"人正在说话"，
 * 字幕一格一格跳才像真的在识别，改小它等于让控制台的实时字幕变得不像识别。
 * 而快捷键不是人在说话：**按下键就等于这句话已经听清了**，逐字动画只是给观众
 * 一个"小木收到了"的反馈 —— 所以这里可以快一个数量级（25–55ms/字）。
 *
 * 实测（`tools/探-快捷键响应时间.mjs`，按 Ctrl+B+2 / Ctrl+Y+5 / Ctrl+M+1）：
 * 改之前"听完"6.2–14.5 秒（平均 9.3 秒），改之后 1–3 秒 —— 那一段正是演示时
 * 讲解人站在台上干等的时间。
 */
export const SHORTCUT_TYPING = { minMs: 25, maxMs: 55 } as const;

/**
 * 播报期间的打断（Barge-in）判定参数。
 *
 * 为什么要单独一组参数：小木播报时识别已经被 abort（这是「自听回环」的根治手段），
 * 只剩音量这一路信号可用；而扬声器的声音同样会进麦克风，所以判定条件必须比平时的
 * VAD 更严 —— 既要绝对音量够大，又要「比播报本底明显更响」，还要持续够久。
 */
export const BARGE_IN_CONFIG = {
  /** 连续超线多久才算「用户插话」：人说话是持续的，爆音/播放起始的咔哒声是瞬态 */
  holdMs: 300,
  /** 比「播报本底」至少高出多少（没有 AEC 参考信号，只能靠这个相对量排除 AI 自己的声音） */
  margin: 0.1,
  /** 本底估计的每帧上爬上限：慢升快降，避免把持续的播报声一步步记成新的本底 */
  floorCreep: 0.003,
} as const;

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
  /**
   * 是否因为小木在播报而暂停了聆听。
   * 它与 micGranted 是**两件事**：麦克风可能开着（用户没关），只是识别被临时停掉。
   */
  suspended: boolean;
  notice: string;
};

const FALLBACK_TEXT = "当前设备不可用真实语音识别，已切换到预置语句模式：点示例问句即可使用完整链路。";

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
 *   asr.current.suspend();            // 小木开始播报：暂停聆听（自听回环治理，幂等）
 *   asr.current.resume();             // 播报结束/被打断：恢复聆听（幂等）
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
  /**
   * 播报期间暂停聆听（自听回环治理）。
   * 语义上只表示「临时别听」，**不等于**用户关掉了麦克风 —— 用户开麦/关麦是
   * stream 的有无，两者互不覆盖（见 suspend/resume/stopMic）。
   */
  private suspended = false;
  /** 暂停前麦克风是否真的在采集：resume 只按这个快照恢复，用户手动关麦后不会被它重新打开 */
  private resumeListening = false;
  /** 暂停前真实识别通道是否在跑：没有跑过的就别在恢复时凭空启动一条 */
  private resumeRecognition = false;
  /** 真实识别通道是否建立过（suspended 期间 recognition 会被置空，status 不能因此谎报成脚本模式） */
  private recognitionChannel = false;
  /** 播报期间的电平本底估计，只用于打断判定 */
  private playbackFloor = 0;
  /** 打断候选的计时起点；0 表示当前不在候选状态 */
  private bargeStartedAt = 0;
  /** 一次播报只报一次打断，避免持续超线时反复 stop() */
  private bargeFired = false;

  constructor(handlers: AsrHandlers) {
    this.handlers = handlers;
  }

  /* ---------------- B：麦克风 VAD ---------------- */

  /** 抢麦克风权限并启动电平分析；失败时返回 false（调用方自动切脚本模式） */
  async startMic(): Promise<boolean> {
    if (!microphoneSupported()) {
      this.handlers.onNotice("当前环境没有麦克风接口（非安全上下文或浏览器不支持），已切换到预置语句模式。");
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
      // 用户主动开麦 = 明确要听：清掉播报暂停标记。
      // VoiceConsole 在按「按住说话」时已经先 stop() 了播报，所以这里不会放行自听回环；
      // 反过来，如果不清，识别会被 suspend 守卫挡住而起不来 —— 用户按了没反应更糟。
      this.suspended = false;
      this.resumeListening = false;
      this.resumeRecognition = false;
      this.bargeStartedAt = 0;
      this.bargeFired = false;
      this.handlers.onListening();
      this.tick();
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      this.handlers.onNotice(
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，已切换到预置语句模式：点示例问句同样可使用完整链路。"
          : `麦克风不可用（${name}），已切换到预置语句模式。`,
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

    if (this.suspended) {
      // 播报期间（自听回环治理）：VAD 一律不判「说话开始」，也就不会触发 onSpeechStart /
      // onFinal —— 小木自己的声音不会变成一轮新的用户输入。
      // 但电平仍在算：它是播报期间唯一能用来判断「用户插话」的信号（§7 Barge-in）。
      this.detectBargeIn(this.levelSmoothed, now);
      // 电平不往界面上报：此刻话筒里主要是小木自己的声音，
      // 让它去驱动电平条和声波只会让人误以为「麦克风听见了我」。
      // （暂停瞬间已经上报过一次 0，见 suspend()。）
      this.frame = window.requestAnimationFrame(this.tick);
      return;
    }

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

  /**
   * 播报期间的打断判定（§7 Barge-in × 自听回环 的矛盾点，如实记录在这里）。
   *
   * 矛盾：要根治自听回环，播报时就必须停掉识别；可识别一停，VAD 也就「听不见」用户了，
   * 于是 §7 要求的「用户一开口就掐断播报」似乎失去了依据。
   * 本实现的取舍：**识别停、只保留一路音量检测**，再用两个额外条件把「用户插话」
   * 和「扬声器漏音」分开：
   *   1) 相对本底：播放本身就会把电平抬起来，所以不能只看绝对阈值，还要比「播报本底」
   *      高出 BARGE_IN_CONFIG.margin。本底慢升快降 —— 跟随播报音量，而不跟随用户的插话；
   *   2) 持续时间：人插话是持续的，而爆音、播放起始的咔哒声只是一帧的瞬态。
   *
   * 这是纯声学启发式（没有 AEC、拿不到播放参考信号），做不到 100% 准确：
   * 设计上**宁可漏判也不错判** —— 漏判时用户仍可按 Mute 或再按一次「按住说话」，
   * 这两条路都会立刻 stop() 播报；错判则会在没人说话时凭空起一轮识别。
   */
  private detectBargeIn(level: number, now: number) {
    // 本底：下降立刻跟随（播报安静下来就跟着降），上升每帧只允许爬 floorCreep
    this.playbackFloor = level < this.playbackFloor ? level : Math.min(level, this.playbackFloor + BARGE_IN_CONFIG.floorCreep);
    const candidate = level > VAD_CONFIG.speechLevel && level > this.playbackFloor + BARGE_IN_CONFIG.margin;
    if (!candidate) {
      this.bargeStartedAt = 0;
      this.bargeFired = false;
      return;
    }
    if (this.bargeStartedAt === 0) {
      this.bargeStartedAt = now;
      return;
    }
    if (this.bargeFired || now - this.bargeStartedAt < BARGE_IN_CONFIG.holdMs) return;
    this.bargeFired = true;
    // 只发 onBargeIn：它在本项目里就是「立刻停播」的钩子，
    // stop() → speaking=false → onSpeakingChange(false) → resume()，
    // 打断之后自动开新一轮识别，§7 的链路是闭环的。
    // 这里**不补发 onSpeechStart**：播报期间并没有真正进入「聆听中说话」的状态，
    // 补发会让控制台把一次打断记成一整句话的开始。
    this.handlers.onBargeIn();
  }

  /* ---------------- 自听回环治理：暂停 / 恢复聆听 ---------------- */

  /**
   * 暂停聆听（小木开始播报时由 VoiceConsole 调用）。
   *
   * 为什么需要它：speechSynthesis / <audio> 的声音会从扬声器漏回麦克风，
   * 识别器会把小木自己的话当成用户输入，于是「AI 自问自答」停不下来。
   *
   * 用 abort() 而不是 stop() 是刻意的：stop() 的语义是「我说完了，把结果给你」，
   * 播报期间那些在途结果恰恰是**最不该要**的部分；abort() 才是「当没听见」。
   *
   * 幂等：重复调用只有第一次生效。否则会重复 abort，还会把「暂停前是否在监听」
   * 的快照覆盖成暂停后的状态，导致 resume 时要么不恢复、要么恢复错。
   */
  suspend() {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.bargeStartedAt = 0;
    this.bargeFired = false;
    // 本底从「暂停那一刻的电平」起步：刚说完话的余音也算本底，随后快降跟到播报音量
    this.playbackFloor = this.levelSmoothed;
    // 只快照"当时确实在跑"的东西：用户没开麦，恢复时就不能替他开麦
    this.resumeListening = this.stream !== null;
    this.resumeRecognition = this.recognition !== null;
    // VAD 状态归零。这里**不补发 onSpeechEnd**：此刻的"静音"是播报造成的，
    // 不是用户把话说完了，补发会把控制台状态机误推成 RECOGNIZING。
    this.speaking = false;
    // 界面电平立刻归零，别停在播报前那一帧的读数上
    this.handlers.onLevel(0);
    this.abortRecognition();
  }

  /**
   * 恢复聆听（播报自然结束 / 被 stop() 打断 / 被静音时由 VoiceConsole 调用）。
   * 与 suspend 对称：只有真的被暂停过才恢复，而且只恢复"暂停前确实在跑"的东西。
   * 同样幂等：没暂停过就什么都不做（避免把用户手动关掉的麦克风重新拉起来）。
   */
  resume() {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.bargeStartedAt = 0;
    this.bargeFired = false;
    // 快照先取再清：这两个标志只对"紧接着的这一次恢复"有效
    const wasListening = this.resumeListening && this.stream !== null;
    const wasRecognizing = this.resumeRecognition;
    this.resumeListening = false;
    this.resumeRecognition = false;
    if (!wasListening) return;
    // 时间基准重置：否则恢复后的第一帧就会拿暂停前的时间戳判出
    // 「已静音 500ms → 一句话结束」，凭空触发一轮语义链路
    this.lastVoiceAt = performance.now();
    this.speaking = false;
    // abort 之后必须重新 start：旧实例已经作废（startRecognition 内部会先清掉它）
    if (wasRecognizing) this.startRecognition();
    // VAD 循环在暂停期间并没有停（要留着测打断电平），这里只是兜底
    if (!this.frame) this.tick();
    this.handlers.onListening();
  }

  /**
   * 掐掉当前识别实例：先摘回调，再 abort。
   * 摘回调是必须的 —— abort() 之后浏览器仍会异步补一个 onend，
   * 而 onend 里的「自动重启」逻辑正是自听回环的另一条入口（播报中又被拉起来）。
   */
  private abortRecognition() {
    const current = this.recognition;
    if (!current) return;
    this.recognition = null;
    current.onresult = null;
    current.onerror = null;
    current.onend = null;
    current.onstart = null;
    try {
      current.abort();
    } catch {
      /* 未启动或已结束时忽略 */
    }
  }

  /* ---------------- A：真实流式识别 ---------------- */

  /** 启动浏览器 SpeechRecognition（可用时优先用它出 partial 字幕） */
  startRecognition(): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) return false;
    // 播报期间不启动识别：那正是「小木听见自己」的源头。
    // 用户此刻按「按住说话」时，VoiceConsole 会先 stop() 播报再开麦，所以不会卡在这里。
    if (this.suspended) return false;
    // 一个类只跑一条识别通道：先掐掉旧实例。否则 Chromium 会抛 InvalidStateError，
    // 而且两条通道的结果会串成两遍用户输入（同一句话被处理两次）。
    this.abortRecognition();
    try {
      const recognition = new Ctor();
      recognition.lang = "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      let tail = "";
      recognition.onresult = (event) => {
        // 暂停期间（含 abort 之后仍在途的）结果一律丢弃：那多半是小木自己的声音
        if (this.disposed || this.suspended) return;
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
        // abort 造成的 aborted / interrupted 不是故障，别拿它去打扰用户
        if (this.disposed || this.suspended) return;
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.handlers.onNotice("浏览器的语音识别服务拒绝了请求，已切换到预置语句模式。");
        } else if (event.error === "no-speech") {
          this.handlers.onNotice("没有检测到语音，可以点示例问句或直接输入文本。");
        } else {
          this.handlers.onNotice(`语音识别返回 ${event.error}，预置语句模式仍然可用。`);
        }
      };
      recognition.onend = () => {
        // continuous 模式在部分浏览器会自动结束，这里按需重启。
        // 三个守卫缺一不可：已销毁、正在播报（绝不重启，否则自听回环复发）、
        // 已经不是当前实例（旧实例迟到的 onend 会拉起第二条识别通道）。
        if (this.disposed || this.suspended || this.recognition !== recognition || !this.stream) return;
        try {
          recognition.start();
        } catch {
          /* 已经在跑，忽略 */
        }
      };
      recognition.start();
      this.recognition = recognition;
      this.recognitionChannel = true;
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
      // 用 recognitionChannel 而不是 recognition：暂停期间实例会被 abort 并置空，
      // 但通道本身并没有退回脚本模式，status 不该在这里说谎
      mode: this.recognitionChannel ? "real" : "simulated",
      micGranted: this.stream !== null,
      recognitionSupported: recognitionSupported(),
      active: this.stream !== null || this.simulatedTimer !== null,
      suspended: this.suspended,
      notice: this.suspended
        ? "小木正在播报，聆听已暂停（避免把自己的声音收进来当成用户输入）"
        : this.recognitionChannel
          ? "真实语音识别通道"
          : this.stream
            ? "麦克风 VAD（识别走脚本或文本）"
            : FALLBACK_TEXT,
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
    // 用户手动关麦：清掉「暂停前在监听」的快照。
    // 否则播报结束时那次 resume() 会把麦克风重新拉起来 —— 用户明明已经关了。
    this.resumeListening = false;
    this.resumeRecognition = false;
    this.speaking = false;
    this.handlers.onLevel(0);
  }

  stopAll() {
    this.cancelSimulation();
    this.stopMic();
    // 用 abort 语义收尾：stop() 会把在途结果吐出来，而关闭控制台时那些结果
    // 只会触发一次没人看的回复。abortRecognition 同时摘掉回调，杜绝迟到的 onend/onresult。
    this.abortRecognition();
    this.recognitionChannel = false;
  }

  dispose() {
    this.disposed = true;
    // 先松开暂停相关状态再拆：dispose 之后任何 resume() 都必须是纯 no-op
    this.suspended = false;
    this.resumeListening = false;
    this.resumeRecognition = false;
    this.bargeStartedAt = 0;
    this.bargeFired = false;
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
