/**
 * 常驻唤醒通道（P0）—— 把麦克风的原始 PCM 一路送到本地语音服务
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

/** 采集参数。16k 单声道是语音模型的标准输入，浏览器会自动重采样 */
import { createElement } from "react";

const SAMPLE_RATE = 16000;
/** 每片 100ms：与服务端既有的分片节奏一致，也够小到不影响唤醒延迟 */
const CHUNK_MS = 100;
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000;

/** 前端能量门限：**只为省 CPU/带宽，不承担判定责任**，所以定得很松 */
const GATE_RMS = 0.008;
/**
 * 静音超过这么久就不再推流（仍在采集，一有声立刻续上）。
 *
 * **必须与 service/server.py 的 COMMAND_END_SILENCE_MS 一致**：
 * 服务端收不到静音帧，它把"前端开始跳静音"当作命令说完的信号。
 * 两个数字不一致，命令就会被切早或拖久（改一个必须改另一个）。
 */
const SILENCE_SKIP_MS = 1000;

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
  lastWake: { route: string; detail: string; decisionMs: number } | null;
  lastCommand: { text: string; raw: string; reason: string } | null;
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
  private lastCommand: { text: string; raw: string; reason: string } | null = null;
  private commandCount = 0;
  /**
   * 收集命令期间的流式字幕。
   *
   * 服务端每 300ms 推一小段新增文字，这里累积成完整句子给界面。
   * 为什么累积而不是每次替换：服务端推的是**增量**（它与上一次结果做差分），
   * 直接替换就会只剩最后几个字。
   */
  private partialText = "";
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

  get lastCommandData(): { text: string; raw: string; reason: string } | null {
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

  /** 当前快照（界面与验收脚本都读它） */
  snapshot(): WakeSnapshot {
    return {
      state: this.state,
      note: this.note,
      wakeCount: this.wakeCount,
      commandCount: this.commandCount,
      partial: this.partialText,
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
        this.wakeCount += 1;
        this.lastWake = { route, detail: String(payload.detail ?? ""), decisionMs: decision };
        // 新的一轮开始：清掉上一轮的字幕，否则界面会先显示上一句再跳到新的
        this.partialText = "";
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
        if (!text || text === this.partialText) return;
        this.partialText = text;
        this.options.onPartial?.(this.partialText);
        this.emit();
        return;
      }
      /**
       * 命令识别完成：这时才打开控制台并把命令交给小木。
       *
       * 走的是**既有的 `mumai:agent-open` 事件**（带 question），
       * 不是新入口 —— 这样语音唤醒、串口语音、点击/文本三个入口
       * 最终都落到同一个执行链路上，风险确认、工具日志、页面跳转都不会被绕过。
       */
      if (payload.type === "command") {
        const text = String(payload.text ?? "").trim();
        const raw = String(payload.raw ?? "");
        console.info(`[wake] 命令：「${text}」（原始转写「${raw}」）`);
        this.commandCount += 1;
        this.lastCommand = { text, raw, reason: String(payload.reason ?? "") };
        if (text) {
          window.dispatchEvent(new CustomEvent("mumai:agent-open", { detail: { question: text } }));
        } else {
          // 只喊了唤醒词、没说做什么：把控制台打开，让用户看到并在里面直接说
          window.dispatchEvent(new CustomEvent("mumai:agent-open", {}));
        }
        this.options.onCommand?.(this.lastCommand);
        this.emit();
        /**
         * 交出去之后暂停推流（小木要说话，喇叭声音会漏回麦克风），
         * 但**定时自动恢复** —— 不恢复就会出现"只采集一次就停了"。
         * 控制台关闭时会立即恢复，不用等这个定时。
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

if (typeof window !== "undefined") {
  /**
   * 挂唤醒浮层（右下角状态 + 流式字幕 + 中央回执）。
   *
   * 为什么不放进应用的 React 树：唤醒要在**任何页面、控制台关着**的时候都能用，
   * 而应用树会随路由挂载/卸载。这里自己建容器和 root，
   * 与 api.tsx 挂独立控制台是同一套路。
   *
   * 浮层是提示、不是功能：挂载失败只打一行日志，唤醒本身照常工作。
   */
  const mountOverlay = () => {
    if (document.getElementById("mumai-wake-overlay")) return;
    const container = document.createElement("div");
    container.id = "mumai-wake-overlay";
    document.body.appendChild(container);
    void Promise.all([import("react-dom/client"), import("./WakeOverlay")])
      .then(([{ createRoot }, mod]) => {
        createRoot(container).render(createElement(mod.default));
      })
      .catch((error: unknown) => {
        console.warn("[wake] 浮层挂载失败（不影响唤醒本身）", error);
      });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
  } else {
    mountOverlay();
  }

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
