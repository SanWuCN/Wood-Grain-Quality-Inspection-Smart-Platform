/**
 * 常驻唤醒通道（P0）—— 把麦克风的原始 PCM 一路送到本地语音服务
 *
 * ── 关于本文件唯一的 import（`./wakeGate.ts`）────────────────────────
 * 这个文件刻意**不 import 任何业务模块**：它的依赖（服务地址、回调、
 * 派发方式）全部由构造参数注入。原因见文件后半段那条注释 ——
 * `api.tsx` 会 import 本模块（关闭生命周期要调 `abortRound`），
 * 若本模块再反向 import 业务模块就会成环。
 *
 * `./wakeGate.ts` 是**例外且安全**：它是一个零依赖的纯函数模块
 * （不 import 任何东西、不碰 DOM、不读时间），所以不会构成环。
 * 它的作用是"播报期间与尾音期不接受唤醒"（工作清单 §9 硬要求）。
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────
 *
 * 现有的 `asr.ts` 只有 AnalyserNode，**拿得到电平、拿不到样本**。
 * 电平能判"有没有人在说话"，判不了"说的是什么" —— 而唤醒词恰恰要求后者。
 * 所以要有一条真正取 PCM 的通道：AudioWorklet 拿 Float32 样本 → 转 16k 单声道
 * int16 → 常驻 WebSocket 推给本地服务。
 *
 * ── 为什么单独一条连接，不复用 /voice-asr ──────────────────────────
 *
 *   /voice-asr（现有识别通道）：一次连接 = 一句话，服务端定稿后主动 close()
 *   /voice-wake（本文件）：      长连接一直在听，可能挂几个小时
 * 两者的生命周期模型完全相反，混用会出现"唤醒听着听着连接没了"。
 *
 * ── P0 的边界（说清楚，免得以后误会）──────────────────────────────
 *
 * 本阶段**不做唤醒判定**，只做"把音频送到 + 拿到实测统计"。
 * 判定在 P1 接 sherpa-onnx KWS 时加在服务端 —— 那时这个文件一行都不用改，
 * 它只负责"把音频可靠地推上去"这一件事。
 */

import { shouldRejectWake } from "./wakeGate.ts";

/** 采集参数。16k 单声道是语音模型的标准输入，浏览器会自动重采样 */

const SAMPLE_RATE = 16000;

/* ------------------------------------------------------------------ *
 * 常驻唤醒的「记住我的选择」
 * ------------------------------------------------------------------ */

/** 键名带 `mumai.` 前缀，与页面已有的本地会话键（`mumai.session`）同一命名空间 */
const WAKE_PREF_KEY = "mumai.wake.enabled";

/**
 * 用户上次是否开着常驻唤醒（localStorage）。
 *
 * 存在的理由（用户直接提的需求）："每次打开都要主动点一下启用呼唤"太烦。
 * 只记"显式开关"这一个布尔事实，不记任何音频数据；
 * 读不到（隐私模式、禁用存储）就返回 false，退化成原来的"默认不开麦"。
 */
export function readWakePreference(): boolean {
  try {
    return window.localStorage.getItem(WAKE_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeWakePreference(on: boolean): void {
  try {
    window.localStorage.setItem(WAKE_PREF_KEY, on ? "1" : "0");
  } catch {
    /* 存储不可用就只是"记不住"，不影响本次开关 */
  }
}

/** 每片 100ms：与服务端既有的分片节奏一致，也够小到不影响唤醒延迟 */
const CHUNK_MS = 100;
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000;

/**
 * 前端能量门限：**只为省 CPU/带宽，不承担判定责任**。
 *
 * ── 为什么从 0.008 降到 0.0015（2026-09-16 实测，别改回去）─────────────
 * 现场反馈"人离得远一点就喊不出来、说出来的话被识别得离谱"。量了本机真人录音的
 * 每 100ms 帧 RMS，结论是**门限卡在最敏感的位置**：
 *
 *   样本（16 kHz wav）        门限 0.008 过帧率   门限 0.0015 过帧率
 *   验收整句 · 近场                  49.6%             72.7%
 *   验收整句 · −12 dB（≈4× 距离）     42.1%             57.0%
 *   验收整句 · −18 dB（≈8× 距离）     29.8%             46.3%
 *   日常谈话 · −18 dB                 4.6%             60.3%
 *
 * 危害不是"少推几帧"这么轻：下面的逻辑是**静音累计超过 SILENCE_SKIP_MS(1000ms)
 * 才停止推流**，而远场时七成以上的帧都低于 0.008 —— 喊完第一遍「小木小木」后
 * 那个自然停顿一旦超过 1 秒，推流就被切断，**第二遍根本没送到服务端**，
 * 唤醒自然出不来（这正是"离远点就呼不出"的机制）。识别偏差同源：
 * 送上去的音频被门限啃掉大半，识别器拿到的是一段段残缺波形。
 *
 * 0.0015 的取法不是拍的：本机静音底噪实测 p05–p10 ≈ 0.0005–0.0013
 * （真人日常与验收整句两个样本都是这个量级），取略高于底噪、
 * 又远低于最小声的近场语音，既能把远场小声留住，也不会把本底噪声当语音推上去。
 * 代价只是多推一些本底噪声帧（本机链路上可忽略）。
 */
const GATE_RMS = 0.0015;
/**
 * 静音超过这么久就不再推流（仍在采集，一有声立刻续上）。
 *
 * **必须与 service/server.py 的 COMMAND_END_SILENCE_MS 一致**：
 * 服务端在"已唤醒、正在收集命令"时，收到这条跳过通知就视为命令说完；
 * 两个数字不一致，命令会被切早或拖久（改一个必须改另一个）。
 *
 * ── 为什么从 1000ms 提到 1500ms（2026-09-16 实测）───────────────────
 * `tools/诊断-远场电平.py` 量出：**连近场整句**（验收录音 0 dB）在正常句间停顿处
 * 都有 1000–1500ms 的低电平段。也就是说 1000ms 这条线本来就压在"正常停顿"上，
 * 一旦触发，推流被切断 —— 而唤醒判定（尤其"只命中一次 → 交给 whisper 复核预滚音频"
 * 那条分支）**依赖音频真的送上来**，断流等于把这轮唤醒判废。
 * 提到 1500ms 后，正常停顿不再触发跳过；代价只是多推一点本底噪声帧（本机链路可忽略）。
 */
const SILENCE_SKIP_MS = 1500;

/**
 * 命令交出去之后多久自动恢复常驻聆听。
 *
 * ── 为什么要有它（这是实测暴露的问题）──────────────────────────
 * 第一版是"唤醒后暂停，等控制台关闭再恢复"。结果是：**只采集一次就停了**。
 * 用户喊完一次命令，小木回完话、控制台还开着，唤醒就一直是暂停的 ——
 * 看起来像"唤醒坏了"，其实是被自己的暂停逻辑锁住了。
 *
 * 现在改成定时自动恢复：小木播报通常 3–6 秒，2.5 秒后恢复聆听，
 * 即使听到自己的声音也不会误解 —— 唤醒要求**两遍「小木小木」**，
 * 播报里出现这种叠词的概率极低，而且浏览器侧还有回声消除。
 * 控制台关闭时会**立即**恢复，不用等这个定时。
 */
const RESUME_AFTER_COMMAND_MS = 2500;

/** 重连退避（毫秒）。服务端不在时不要每秒重试一次，日志会刷屏 */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export type WakeChannelState = "idle" | "starting" | "live" | "reconnecting" | "stopped" | "error";

/**
 * 通道的一份完整快照。
 *
 * 为什么用"快照"而不是拆成好几个回调：界面要同时看状态、字幕、命令三样东西，
 * 拆开就会出现"字幕更新了但组件只订阅了状态所以不重渲染"这类问题，
 * 而排查这种问题要花的时间远超多传一个对象。**一个来源、一份快照**最省事。
 */
export type WakeSnapshot = {
  state: WakeChannelState;
  note: string;
  wakeCount: number;
  commandCount: number;
  /** 唤醒之后正在说的那句话（累积后的完整文本，空串表示当前没在说） */
  partial: string;
  /**
   * 是否正处于「已唤醒、正在收集命令」这一段。
   *
   * ── 为什么需要它（实测发现的缺陷）──────────────────────────────
   * 界面原先只能靠 `partial` 判断"它听见我了没有"，而流式字幕要等
   * 音频攒够 0.35 秒、再等一次 300ms 的推送才有内容 —— 也就是**唤醒之后
   * 有近一秒的完全静默**。用户以为没反应就会重复喊，反而把命令说乱；
   * PRD §9 要求"唤醒结束到可见反馈 ≤800ms"。
   *
   * `collecting` 在**收到唤醒事件的那一刻**就为真，与音频处理进度无关，
   * 界面据此立刻切到「正在听」。
   */
  collecting: boolean;
  lastWake: { route: string; detail: string; decisionMs: number } | null;
  lastCommand: { text: string; raw: string; reason: string; interactionId: string } | null;
};

export type WakeStats = {
  /** 服务端收到的帧数（**不是**前端发出的帧数 —— 只有服务端能证明真的到了） */
  serverFrames: number;
  serverBytes: number;
  serverLevel: number;
  serverPeakRms: number;
  serverVoicedRatio: number;
  serverMaxGapMs: number;
  serverBufferedS: number;
  /** 服务端记录的"前端在跳过静音"次数：用来解释 max_gap 为什么可以很大 */
  serverSkips: number;
  /** 前端自己发出去的帧数与丢掉的静音帧数，用于和上面那组对账 */
  sentFrames: number;
  skippedSilentMs: number;
};

export type WakeChannelOptions = {  /** 采集与推流的开关。true = 开始常驻聆听 */
  onState?: (state: WakeChannelState, note: string) => void;
  /** 服务端每 500ms 回一次统计 */
  onStats?: (stats: WakeStats) => void;
  /** 服务端判定了一次唤醒 */
  onWake?: (info: { route: string; detail: string; decisionMs: number }) => void;
  /** 唤醒之后的命令识别结果 */
  onCommand?: (info: { text: string; raw: string; reason: string }) => void;
  /** 唤醒之后正在说的那句话（流式，累积后的完整文本） */
  onPartial?: (text: string) => void;
  /** 服务端回的任何原始消息（诊断用） */
  onMessage?: (payload: Record<string, unknown>) => void;
};

/**
 * AudioWorklet 处理器源码。
 *
 * 为什么内联成字符串再 Blob 成 URL，而不是放 public/ 下一个 .js 文件：
 *   放 public/ 会多一个"构建产物里必须存在"的隐式依赖，路径前缀（base）一变就 404，
 *   而这类失败在浏览器里只表现为"麦克风没反应"，非常难查。
 *   内联则与这段代码同生共死：文件在，处理器就在。
 */
const WORKLET_SOURCE = `
class WakeTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // 只取第一路（单声道）；多路时求平均，避免只取左声道导致右声道说话听不见
    const channels = input.length;
    const frames = input[0].length;
    const out = new Float32Array(frames);
    for (let c = 0; c < channels; c += 1) {
      const data = input[c];
      for (let i = 0; i < frames; i += 1) out[i] += data[i] / channels;
    }
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}
registerProcessor("wake-tap", WakeTap);
`;

export class WakeChannel {
  private options: WakeChannelOptions;
  private state: WakeChannelState = "idle";
  private note = "";

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;

  /** 累积到 CHUNK_SAMPLES 才发一片：太小会让 WS 帧数暴涨，太大抬高唤醒延迟 */
  private pending: number[] = [];
  private nativeSampleRate = 0;
  private silentSince = 0;
  /** 页面卸载/主动 stop 之后，迟到的回调一律作废 */
  private disposed = false;

  private stats: WakeStats = {
    serverFrames: 0,
    serverBytes: 0,
    serverLevel: 0,
    serverPeakRms: 0,
    serverVoicedRatio: 0,
    serverMaxGapMs: 0,
    serverBufferedS: 0,
    serverSkips: 0,
    sentFrames: 0,
    skippedSilentMs: 0,
  };

  /** 最近一次唤醒信息（验收脚本与界面提示都用它） */
  private lastWake: { route: string; detail: string; decisionMs: number } | null = null;
  private wakeCount = 0;
  /** 最近一次识别出的命令（验收脚本用它判断"唤醒之后那句话说对了没有"） */
  private lastCommand: { text: string; raw: string; reason: string; interactionId: string } | null = null;
  private commandCount = 0;
  /** 语音命令的轮次序号：与 commandCount 同源，用来拼唯一 interactionId */
  private commandSeq = 0;
  /**
   * 收集命令期间的流式字幕。
   *
   * 服务端每 300ms 推一小段新增文字，这里累积成完整句子给界面。
   * 为什么累积而不是每次替换：服务端推的是**增量**（它与上一次结果做差分），
   * 直接替换就会只剩最后几个字。
   */
  private partialText = "";
  /** 已唤醒、正在收集命令（见 WakeSnapshot.collecting 的说明） */
  private collecting = false;
  /**
   * TTS 是否正在播报，以及上次播报结束的时刻（用于「播报期间不唤醒」的门控）。
   *
   * 值由外部通过 `noteSpeaking()` 写入 —— 通道本身不持有 `VoiceOutput`
   * （那是播报侧的实例，两边的生命周期不同）。这样唤醒通道只依赖一个
   * "布尔 + 时间戳"的最小契约，而不必认识 TTS 的实现。
   */
  private speaking = false;
  private lastSpeechEndAt = 0;
  private resumeTimer: number | null = null;

  get wakeCountValue(): number {
    return this.wakeCount;
  }

  get lastWakeData(): { route: string; detail: string; decisionMs: number } | null {
    return this.lastWake;
  }

  get commandCountValue(): number {
    return this.commandCount;
  }

  get lastCommandData(): { text: string; raw: string; reason: string; interactionId: string } | null {
    return this.lastCommand;
  }

  get partialValue(): string {
    return this.partialText;
  }

  constructor(options: WakeChannelOptions = {}) {
    this.options = options;
  }

  get currentState(): WakeChannelState {
    return this.state;
  }

  get currentStats(): WakeStats {
    return { ...this.stats };
  }

  private setState(state: WakeChannelState, note: string) {
    this.state = state;
    this.note = note;
    this.options.onState?.(state, note);
    this.emit();
  }

  /**
   * 告知通道"小木现在是否在播报"（工作清单 v1.0 §9：TTS 不得反向唤醒自己）。
   *
   * 由播报侧在 `VoiceOutput.onSpeakingChange` 里调用。放在这里的理由：
   * 通道只需要一个"布尔 + 时间戳"的最小契约，不需要认识 `VoiceOutput`；
   * 两边生命周期不同，让通道持有 TTS 实例会引出释放顺序问题。
   *
   * 播报结束时记时间戳，供 `shouldRejectWake` 判"尾音静默期"。
   */
  noteSpeaking(speaking: boolean): void {
    if (!speaking && this.speaking) {
      this.lastSpeechEndAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    }
    this.speaking = speaking;
  }

  /** 当前快照（界面与验收脚本都读它） */
  snapshot(): WakeSnapshot {
    return {
      state: this.state,
      note: this.note,
      wakeCount: this.wakeCount,
      commandCount: this.commandCount,
      partial: this.partialText,
      collecting: this.collecting,
      lastWake: this.lastWake,
      lastCommand: this.lastCommand,
    };
  }

  /**
   * 订阅任何变化（状态 / 流式字幕 / 唤醒 / 命令）。
   *
   * 为什么让界面订阅、而不是让它自己存一份开关状态：通道是**模块级单例**，
   * 面板或浮层卸载重挂时自己存的状态会显示成"关闭"，而通道其实还在听。
   * 状态必须只有一个来源。
   */
  subscribe(listener: (snapshot: WakeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private listeners = new Set<(snapshot: WakeSnapshot) => void>();

  /**
   * 开始常驻聆听。
   *
   * 需要用户手势触发（浏览器对 getUserMedia 与 AudioContext 的要求），
   * 所以**不自动启动** —— 页面加载就弹麦克风授权是很打扰人的行为。
   */
  async start(): Promise<boolean> {
    if (this.state === "live" || this.state === "starting") return true;
    this.disposed = false;
    /**
     * 用户**显式**开启 → 记住这个选择（下次加载自动恢复，见 main.tsx）。
     * 写在 start() 里而不是各个 UI 里，是为了让"点开关 / Alt+W / 助手面板的按钮"
     * 三条入口共用同一份记忆，不会各记各的。
     */
    writeWakePreference(true);
    this.setState("starting", "正在申请麦克风…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          /**
           * 回声消除开着：小木播报时喇叭的声音会漏回麦克风，
           * 不加这个，唤醒阈值再严也可能被自己的声音触发。
           * 但**不能只靠它** —— 播报期间前端仍应主动停推流（见 suspend）。
           */
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.setState("error", "浏览器不支持 Web Audio，无法采集音频");
        return false;
      }
      const context = new Ctor();
      this.context = context;
      this.nativeSampleRate = context.sampleRate;
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" })));
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "wake-tap");
      node.port.onmessage = (event) => this.onSamples(event.data as Float32Array);
      source.connect(node);
      /**
       * 关键：worklet 必须连到 destination 才会被驱动。
       * 但它**不能出声** —— 所以中间插一个增益为 0 的节点，
       * 而不是把它直接接到 destination（那会把麦克风原声放出来，啸叫）。
       */
      const mute = context.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(context.destination);
      this.node = node;
      if (context.state === "suspended") await context.resume().catch(() => undefined);

      this.connectSocket();
      this.setState("live", "常驻唤醒已开启（P0：只采集与统计，尚未做唤醒判定）");
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      this.setState(
        "error",
        name === "NotAllowedError" ? "麦克风权限被拒绝，唤醒不可用" : `麦克风不可用（${name}）`,
      );
      return false;
    }
  }

  /**
   * 暂停推流（小木播报期间调用）。
   *
   * 与 stop() 的区别：这里**不关麦克风、不断连接**，只是不再把音频推上去。
   * 为什么不做成"停掉采集"：AudioContext 反复起停的代价远大于丢弃几帧，
   * 而且重新 start 会有一个几百毫秒的空窗，用户在这期间喊就漏了。
   */
  suspend() {
    this.suspended = true;
    this.pending = [];
  }

  resume() {
    this.suspended = false;
    this.silentSince = 0;
    this.clearResumeTimer();
  }

  /**
   * 取消"当前这一轮识别"（AC-04「关闭时正在识别也必须正确取消」）。
   *
   * 与 stop() 的区别同样是**别把麦克风关掉**：常驻唤醒是用户显式开的能力，
   * 关气泡不该顺手把它关了（FR-08）。所以这里只做两件事：
   *   · 把本轮的流式字幕与收集态清掉，界面立刻回到"待机"；
   *   · 记住"下一句命令要丢" —— 只在**确实正在收集**时才置位，
   *     否则用户关完气泡后正常喊的那一句会被误丢。
   *
   * 服务端仍会把这一轮的 utterances 判完并回一条 command，客户端丢弃它，
   * 语义上等价于"这一轮被取消了"；不需要改服务端协议。
   */
  abortRound(): boolean {
    const wasCollecting = this.collecting;
    this.collecting = false;
    this.partialText = "";
    this.dropNextCommand = wasCollecting;
    this.emit();
    return wasCollecting;
  }

  /** 关闭时是否取消了正在收集的那一轮（给验收脚本读，避免靠时间猜） */
  private dropNextCommand = false;

  /** 排一次"命令处理完之后自动恢复聆听"，重复调用只保留最后一次 */
  private scheduleResume() {
    this.clearResumeTimer();
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null;
      this.resume();
      this.options.onState?.("live", "已自动恢复常驻聆听，可以继续喊「小木小木」");
    }, RESUME_AFTER_COMMAND_MS);
  }

  private clearResumeTimer() {
    if (this.resumeTimer !== null) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private suspended = false;

  /**
   * 当前是否处于"暂停推流"（命令已交出去、小木正在说话的那一段）。
   *
   * 暴露出来是为了让验收脚本能**直接读状态**，而不是靠掐时间数帧数 ——
   * 数帧数会被 2.5 秒的自动恢复切成两段，测出来的东西根本说不清。
   */
  get suspendedValue(): boolean {
    return this.suspended;
  }

  /** 停止：断开连接、关麦克风、释放 AudioContext */
  stop() {
    this.disposed = true;
    this.suspended = false;
    /** 用户**显式**关闭 → 也记住，免得下次一进页面又自己开起来 */
    writeWakePreference(false);
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pending = [];
    try {
      this.socket?.close();
    } catch {
      /* 已经关了 */
    }
    this.socket = null;
    if (this.node) {
      if ("port" in this.node) this.node.port.onmessage = null;
      else this.node.onaudioprocess = null;
      this.node.disconnect();
      this.node = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.setState("stopped", "常驻唤醒已关闭");
  }

  /* ---------------- 音频 → 16k int16 → WebSocket ---------------- */

  private onSamples(input: Float32Array) {
    if (this.disposed || this.suspended || !this.socket) return;
    // 浏览器的 AudioContext 常是 48k，服务端要 16k：按比例抽样（下采样）
    const step = this.nativeSampleRate / SAMPLE_RATE;
    const out: number[] = [];
    if (step <= 1.0001) {
      for (let i = 0; i < input.length; i += 1) out.push(input[i]);
    } else {
      // 每 step 个样本取一个；不做抗混叠滤波 —— 唤醒是宽带特征，
      // 且 8k 以下的语音能量本来就占绝大部分，简单抽取足够。
      for (let x = 0; x < input.length; x += step) out.push(input[Math.floor(x)]);
    }
    for (let i = 0; i < out.length; i += 1) this.pending.push(out[i]);
    this.flush(false);
  }

  /** 把累积的样本按 100ms 一片发出去；静音则跳过（只省流量，不承担判定） */
  private flush(force: boolean) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.pending.length >= CHUNK_SAMPLES || (force && this.pending.length > 0)) {
      const slice = this.pending.splice(0, CHUNK_SAMPLES);
      let sum = 0;
      for (let i = 0; i < slice.length; i += 1) sum += slice[i] * slice[i];
      const rms = Math.sqrt(sum / slice.length);
      if (rms < GATE_RMS) {
        this.silentSince += (slice.length / SAMPLE_RATE) * 1000;
        if (this.silentSince > SILENCE_SKIP_MS) {
          this.stats.skippedSilentMs += (slice.length / SAMPLE_RATE) * 1000;
          this.announceSkip();
          this.options.onStats?.(this.currentStats);
          continue;
        }
      } else {
        this.silentSince = 0;
        this.skipping = false;
      }
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i += 1) {
        const v = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      this.socket.send(pcm.buffer);
      this.stats.sentFrames += 1;
    }
  }

  /**
   * 告诉服务端「我这边在跳过静音，没推流不是链路卡住了」。
   *
   * 为什么需要这个：服务端靠"相邻两片音频的到达间隔"判断前端有没有卡。
   * 而静音跳过是**设计如此** —— 不告诉它，那段有意的空档就会被算成
   * 2089ms 的"异常间隔"，把真卡顿和正常行为混成一个数。
   * 只在进入跳过状态时发一次（不是每片都发），一条消息几字节。
   */
  private announceSkip() {
    if (this.skipping) return;
    this.skipping = true;
    try {
      this.socket?.send(JSON.stringify({ type: "skip" }));
    } catch {
      /* 连接刚断，重连后会重新进入跳过状态 */
    }
  }

  private skipping = false;

  /* ---------------- 常驻连接 ---------------- */

  private connectSocket() {
    if (this.disposed) return;
    // 同源相对路径：https 页面自动走 wss，不用前端判断环境
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/voice-wake`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.scheduleReconnect(`WebSocket 创建失败：${String(error)}`);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.silentSince = 0;
      this.setState("live", `唤醒通道已连接 ${url}`);
    };
    socket.onmessage = (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.options.onMessage?.(payload);
      if (payload.type === "ready") {
        this.setState("live", `服务端就绪（${String(payload.stage ?? "")}）`);
        return;
      }
      /**
       * 唤醒命中：**先不要打开控制台、也不要暂停推流**。
       *
       * 原因：服务端此刻刚进入"收集命令"状态，它要靠后续音频才能听清
       * 「打开地图」这句话。这时候如果去开控制台或者停推流，
       * 命令就断了 —— 用户会觉得"喊醒了但不理我"。
       * 打开控制台等 command 事件到了再做。
       */
      if (payload.type === "wake") {
        const route = String(payload.route ?? "");
        const decision = Number(payload.decision_ms ?? 0);
        /*
          ── 播报期间与尾音期不接受唤醒（工作清单 v1.0 §9）──────────────
          小木自己的 TTS 会从扬声器出来被麦克风收回去。通道虽然开了
          `echoCancellation` 且麦克风不接扬声器，但**回声消除不保证消除自身 TTS**
          （取决于音量、设备与外放/耳机），所以这里再加一层显式门控：
          播报中一律拒绝，播报结束后再留一小段静默期挡尾音与混响。
          不加这一层的后果是"自己念到含触发词的那句就把自己唤醒"，
          演示现场表现为小木自说自话停不下来。
        */
        const gate = shouldRejectWake({
          speaking: this.speaking,
          sinceSpeechEndMs: this.lastSpeechEndAt > 0 ? performance.now() - this.lastSpeechEndAt : Number.POSITIVE_INFINITY,
        });
        if (gate.reject) {
          console.info(`[wake] 忽略本次唤醒：${gate.reason}`);
          return;
        }
        this.wakeCount += 1;
        this.lastWake = { route, detail: String(payload.detail ?? ""), decisionMs: decision };
        // 新的一轮开始：清掉上一轮的字幕，否则界面会先显示上一句再跳到新的
        this.partialText = "";
        /**
         * 立刻进入「正在收集命令」，与音频处理进度无关。
         * 这样界面在唤醒的**同一帧**就能切到「正在听」，
         * 不必等流式字幕攒够音频（那条路要近一秒）。
         */
        this.collecting = true;
        console.info(`[wake] 唤醒（${route}，判定滞后 ${decision}ms）`);
        this.options.onWake?.(this.lastWake);
        this.emit();
        return;
      }

      /**
       * 流式字幕：唤醒之后正在说的那句话，边说边出字。
       *
       * 服务端推的是**当前整句**转写，这里**整句替换**（不是累加）。
       * 累加过的版本会重复：模型回头改字（事例寺 → 势力寺）时前缀一变，
       * 差分就把后半段又追加一遍，界面上出现「…事例寺巡检勢力寺巡检」。
       * 整句替换天然没有这个问题。
       *
       * 这一路是给用户"看见它在听"的 —— 没有它，唤醒之后到出命令之间
       * 有一秒多的静默，用户会以为没反应，然后重复喊，反而把命令说乱。
       */
      if (payload.type === "partial") {
        const text = String(payload.text ?? "");
        /**
         * **命令定稿之后到达的 partial 一律丢弃。**
         *
         * 实测缺陷（`验收停顿边界.mjs` 抓到）：命令事件到达时会把 `collecting`
         * 置假、字幕清空，界面本应显示**定稿后的命令文本**；但此时往往还有
         * 一两条 partial 在网络上飞 —— 它们是在命令之前发出来的，到达却晚于命令事件，
         * 于是把刚清空的字幕又填回**半截识别**（屏幕上从「查近三个月天气」
         * 退回到「小木小木查警三個月天氣」）。用户看到的是"识别结果自己变差了"。
         *
         * 判据用 `collecting`：它只在"唤醒之后、命令定稿之前"为真，
         * 正是流式字幕该出现的窗口；窗口之外的字幕消息没有意义，丢掉即可。
         * 关掉气泡取消本轮时也走同一条路（`collecting` 已被清），不会误伤。
         */
        if (!this.collecting) return;
        if (!text || text === this.partialText) return;
        this.partialText = text;
        this.options.onPartial?.(this.partialText);
        this.emit();
        return;
      }
      /**
       * 命令识别完成：交给小木执行。
       *
       * ── 派发的是 `mumai:xiaomu-ask`，不是 `mumai:agent-open`（PRD FR-02 / FR-06）──
       * 两者的区别正是本次改造的核心：
       *   `mumai:agent-open`  → 挂起**全屏控制台**（现在只作开发诊断入口保留）
       *   `mumai:xiaomu-ask`  → 右下角气泡直接跑，主页面不被遮挡
       * 唤醒一句就把主业务页面整个盖住，是 PRD 明确要改掉的行为。
       *
       * 两条路最终都调同一个 `ask()`，所以业务结果一致（FR-04 / AC-06）；
       * 页面跳转、风险确认、工具日志都不会被绕过。
       */
      if (payload.type === "command") {
        const text = String(payload.text ?? "").trim();
        const raw = String(payload.raw ?? "");
        console.info(`[wake] 命令：「${text}」（原始转写「${raw}」）`);
        this.commandCount += 1;
        this.lastCommand = { text, raw, reason: String(payload.reason ?? ""), interactionId: "" };
        /**
         * 收尾：退出收集态并清掉流式字幕。
         *
         * 不清的后果是实测出来的：字幕留着 → 界面的状态推导里
         * 「正在听」（优先级高于「思考中」）会一直成立 → 小木明明在执行了，
         * 徽标却还写着「正在听」，用户以为它没听见、接着重复说。
         */
        this.collecting = false;
        this.partialText = "";
        /**
         * 「关闭 → 取消本轮」（AC-04）。
         *
         * 用户在识别过程中把气泡关掉，这一轮就不该再冒出来 —— 否则他刚关掉，
         * 半秒后同一句回答又把气泡顶开，看起来像"关不掉"。
         * 这里丢的是**已经作废的那一轮**：只丢一次，且只丢"关闭时正在收集"的
         * 那一轮；常驻唤醒本身不动（FR-08：关气泡不释放麦克风），
         * 下一轮唤醒照常工作。
         */
        if (this.dropNextCommand) {
          this.dropNextCommand = false;
          console.info("[wake] 本轮已在关闭时取消，丢弃这条命令");
          this.emit();
          return;
        }
        /**
         * 唤醒词不属于命令。
         *
         * 服务端的命令段有时会把唤醒词一起带进来（实测出现过
         * 「小木小木查警三个月天气」这种整段），如果不剥掉：
         *   · 字幕里会多出「小木小木」，用户看到的"命令"不是他说的那句；
         *   · 语义层要额外容忍前缀，命令文本也进了日志，事后排查更乱。
         * 只剥**开头连续两遍**「小木」（允许中间有顿号/逗号/空格），
         * 剥一次就够 —— 句中出现的小木是用户的实际用词，不能动。
         */
        const spoken = text.replace(/^\s*(?:小木[\s，,、]*){2}\s*/, "");
        const cleaned = spoken || text;
        /**
         * **每轮带唯一 interactionId**（AC-03 第 1 条）。
         *
         * 诊断控制台那条路早就有（`nextInteractionId()`），语音这条路一直没有：
         * 事件里只有 question，于是"按 id 去重"在语音侧根本无从谈起 ——
         * 同一条 WS 命令被重复投递两次就会执行两轮。
         * 这里不让 wakeChannel 去 import api.tsx：api.tsx 现在已经 import 本模块
         * （关闭生命周期要调 abortRound），反向 import 会成环。所以就地生成，
         * 格式与 `nextInteractionId()` 保持一致的约定（时间戳 + 序号 + 来源标签），
         * 现场排查时一眼能看出这轮是语音来的。
         */
        this.commandSeq += 1;
        const interactionId = `ia-${Date.now().toString(36)}-wake${this.commandSeq}`;
        this.lastCommand = { text: cleaned, raw, reason: String(payload.reason ?? ""), interactionId };
        /**
         * **空命令也要往下传**（PRD FR-10 第 1 条「未听清」）。
         *
         * 原先这里是 `if (text) { … }` —— 空串直接丢掉，于是"喊醒了、
         * 说了句没人听懂的话"在界面上**什么都不会发生**，比说错话更糟。
         * 现在照常派发，由 `executor.ask("")` 走 `replyNotHeard` 给出一条
         * 可见提示，并且一个工具都不调用。
         */
        window.dispatchEvent(new CustomEvent("mumai:xiaomu-ask", { detail: { question: cleaned, interactionId } }));
        this.options.onCommand?.(this.lastCommand);
        this.emit();
        /**
         * 交出去之后暂停推流（小木要说话，喇叭声音会漏回麦克风），
         * 但**定时自动恢复** —— 不恢复就会出现"只采集一次就停了"。
         * 关掉气泡时会立即恢复，不用等这个定时。
         */
        this.suspend();
        this.scheduleResume();
        return;
      }
      if (payload.type === "stats") {
        this.stats.serverFrames = Number(payload.frames ?? 0);
        this.stats.serverBytes = Number(payload.bytes ?? 0);
        this.stats.serverLevel = Number(payload.level ?? 0);
        this.stats.serverPeakRms = Number(payload.peak_rms ?? 0);
        this.stats.serverVoicedRatio = Number(payload.voiced_ratio ?? 0);
        this.stats.serverMaxGapMs = Number(payload.max_gap_ms ?? 0);
        this.stats.serverBufferedS = Number(payload.buffered_s ?? 0);
        this.stats.serverSkips = Number(payload.skips ?? 0);
        this.options.onStats?.(this.currentStats);
      }
    };
    socket.onclose = () => {
      if (this.disposed) return;
      this.scheduleReconnect("唤醒通道断开，正在重连…");
    };
    socket.onerror = () => {
      /* onclose 会紧随其后，统一在那里处理重连，避免两条路径重复调度 */
    };
  }

  private scheduleReconnect(note: string) {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.setState("reconnecting", `${note}（${delay}ms 后第 ${this.reconnectAttempt} 次重试）`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  }

  /** 主动向服务端要一次预滚缓冲回执（验收用） */
  requestPreroll() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "preroll" }));
    }
  }

  /** 给诊断用的一句话状态 */
  describe(): string {
    return `[wake] state=${this.state} ${this.note} | 已发 ${this.stats.sentFrames} 帧，服务端收到 ${this.stats.serverFrames} 帧，峰值 rms ${this.stats.serverPeakRms}`;
  }
}

/**
 * 页面级单例 + 全局挂点。
 *
 * 挂 `window.__mumaiWake` 的理由和既有的 `__mumaiInput`、`__mumaiVoice` 一致：
 * 现场排查时能在控制台直接驱动它，不用为了验一条链路去点一串 UI。
 */
let singleton: WakeChannel | null = null;

export function wakeChannel(): WakeChannel {
  if (!singleton) {
    singleton = new WakeChannel({
      onState: (state, note) => {
        if (state === "error" || state === "reconnecting") console.warn("[wake]", note);
      },
    });
  }
  return singleton;
}

/**
 * 浏览器环境判定 —— **不能只写 `typeof window !== "undefined"`**。
 *
 * ── 这是实测踩出来的（而且代价不小）──────────────────────────────
 * PRD 验收工装里有一个只读探针，用 vite 的 `ssrLoadModule` 在 **Node** 里
 * 加载本模块来读它的导出。那种环境下 `window` 是存在的（SSR 兼容层给的桩），
 * 但**没有 `addEventListener`** —— 于是模块级那几行直接把整个探针打崩：
 *
 *     TypeError: window.addEventListener is not a function
 *     at src/pages/MumaiDashboard/agent/wakeChannel.ts
 *
 * 后果是一整片验收项变成「证据不足」（FR-05 主回答逐字、三个业务字段、
 * 引用、时间戳、TTS 播报…），看起来像产品没做，其实只是模块在非浏览器
 * 环境下不该执行 DOM 代码。
 *
 * 判据因此收紧成"**确实有 DOM 事件接口**"：有才做事件订阅与自动启动，
 * 没有就只导出类与单例（纯逻辑部分照样可用）。
 */
const HAS_DOM = typeof window !== "undefined" && typeof window.addEventListener === "function";

if (HAS_DOM) {
  /**
   * 醒目的状态提示与流式字幕现在由右下角的常驻小木（`XiaomuDock`）负责。
   *
   * 这里原来挂过一个独立浮层（`WakeOverlay`），本次按 PRD FR-06/FR-07 删掉了：
   * 它的职责（右下角状态、流式字幕、结果回执）已经被小木气泡完全覆盖，
   * 两个都留着会在右下角叠出两块面板，而且气泡还拿不到会话上下文
   * （挂到 body 上用不了 `useMumai()`，事实值会和点击/文字入口不一致）。
   *
   * 本模块因此回到"只管音频与判定"这一件事：采集、推流、唤醒事件、命令事件。
   * 界面从 `wakeChannel().subscribe()` 读状态，不再由这里创建 DOM。
   */

  /**
   * 控制台关闭 → **立即**恢复常驻聆听。
   *
   * 与"命令交出去之后暂停"配对：小木要说话，喇叭声音会漏回麦克风，
   * 所以那段时间停推流。恢复有两条路 —— 控制台关闭时立即恢复，
   * 或者 RESUME_AFTER_COMMAND_MS 之后自动恢复（见 scheduleResume）。
   * 只留前者就会出现"只采集一次就停了"。
   */
  window.addEventListener("mumai:agent-close", () => {
    const channel = singleton;
    if (channel) channel.resume();
  });

  /**
   * 免手敲的启动方式：地址后面带 `?wake=1`（或 `#/xxx?wake=1`）。
   *
   * 为什么需要：默认不自动开麦是有意的（一进页面就弹麦克风授权太打扰人），
   * 但现场测试时每次都去 F12 敲 `__mumaiWake.start()` 很烦。
   * 带上这个参数就等于说"这次我要测唤醒"。
   *
   * 为什么还要挂一次性交互监听：浏览器要求 AudioContext 在用户手势之后才能出声/采集，
   * 自动 start() 可能拿到一个 suspended 的上下文 —— 那样采集是静音的，
   * 现象和"喊了没反应"一模一样，极难查。所以第一次点击/按键时再确认一次。
   */
  const wantsAutoStart = /(^|[?&])wake=1(&|$)/.test(location.search) || location.hash.includes("wake=1");
  if (wantsAutoStart) {
    const kick = () => {
      void wakeChannel()
        .start()
        .then(() => console.info("[wake] 自动启动（?wake=1）"));
    };
    kick();
    const once = () => {
      window.removeEventListener("pointerdown", once);
      window.removeEventListener("keydown", once);
      // 已经 live 就不用再 start；start() 自己幂等，这里只是兜住 suspended 的情况
      kick();
    };
    window.addEventListener("pointerdown", once, { once: true });
    window.addEventListener("keydown", once, { once: true });
  }

  (window as unknown as { __mumaiWake?: unknown }).__mumaiWake = {
    start: () => wakeChannel().start(),
    stop: () => wakeChannel().stop(),
    suspend: () => wakeChannel().suspend(),
    resume: () => wakeChannel().resume(),
    preroll: () => wakeChannel().requestPreroll(),
    stats: () => wakeChannel().currentStats,
    state: () => wakeChannel().currentState,
    describe: () => wakeChannel().describe(),
    /** 本轮已唤醒次数 / 最近一次唤醒信息 —— 现场排查先看这两个 */
    wakes: () => wakeChannel().wakeCountValue,
    lastWake: () => wakeChannel().lastWakeData,
    /** 命令次数与最近一条 —— 判断"唤醒之后那句话说对了没有" */
    commands: () => wakeChannel().commandCountValue,
    lastCommand: () => wakeChannel().lastCommandData,
    /** 当前流式字幕（唤醒后正在说的那句话） */
    partial: () => wakeChannel().partialValue,
    /** 是否正在暂停推流（命令交出去之后那一小段） */
    suspended: () => wakeChannel().suspendedValue,
    /** 完整快照，界面与验收脚本共用 */
    snapshot: () => wakeChannel().snapshot(),
  };
}
