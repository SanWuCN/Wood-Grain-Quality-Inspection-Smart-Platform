/**
 * 小木语音智能体 · 语音控制台（技术方案 §24 / §25 的界面部分）
 *
 * 界面分区（从上到下）：
 *   1. 状态机徽标（IDLE…FINISHED）+ 麦克风电平条（真实音量驱动）+ 声波动画
 *   2. 实时字幕：partial 灰色 / final 高亮，下面是命中的意图、置信度与抽取到的槽位
 *   3. 对话流：用户气泡 + 小木气泡；多步 Agent 任务在气泡里嵌入 ✓/●/○ 步骤清单
 *   4. 底部：示例问句按钮（点击即模拟一次完整交互）+ 按住说话 + 文本输入
 *   5. 高风险动作的确认层（§42）
 *
 * 所有数字与文案都来自 seed/scenario.ts（通过 facts.ts 渲染），界面本身不写业务数字。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { useMumai } from "../context";
import { CHANNELS, KNOWLEDGE_META } from "../seed/scenario";
import { AGENT_TASK_EXAMPLES, INTENTS, voicePackOf } from "./intents";
import { SEMANTIC_THRESHOLDS, PILLAR_ALIASES } from "./matcher";
import { ask, RETRIEVAL_NOTE, type Runtime } from "./executor";
import { VoiceInput, recognitionSupported } from "./asr";
import { takePendingQuestion } from "./api";
import { VoiceOutput, type TtsStatus } from "./tts";
import {
  clearTurns,
  getAgentState,
  resolveConfirm,
  setAgent,
  subscribeAgent,
} from "./store";
import { AGENT_STATE_LABEL, type AgentState, type AgentStep, type BotTurn, type Turn } from "./types";
import "./agent.css";

/** 示例问句：从意图库的 examples 里取，覆盖不同意图类型（方案 §12 的多种说法） */
const EXAMPLE_PICKS: { intentId: string; example: string }[] = [
  { intentId: "introduce_platform", example: "介绍一下这套系统" },
  { intentId: "open_page", example: "打开地图" },
  { intentId: "view_current_order", example: "查看当前工单" },
  { intentId: "open_evidence", example: "打开Z04下部的记录" },
  { intentId: "view_four_pillars", example: "查看四柱状态" },
  { intentId: "view_echo", example: "查看回波" },
  { intentId: "device_status", example: "小车现在电量多少" },
  { intentId: "view_batch", example: "查看复扫批次" },
  { intentId: "site_weather", example: "查近三个月天气" },
  { intentId: "history_summary", example: "查今年五月示例寺巡检" },
  { intentId: "compare_models", example: "对比新旧模型" },
  { intentId: "run_fusion", example: "分析本批次并融合结果" },
  { intentId: "robot_move", example: "让小车去一号木柱" },
  { intentId: "start_patrol", example: "开始巡检" },
  { intentId: "robot_return_home", example: "让小车回来" },
  { intentId: "robot_stop", example: "停止" },
  { intentId: "start_mapping", example: "开始建图" },
];

/** 状态机 → 视觉语义（技术方案：识别中=蓝、成功=绿、风险=红、待处理=黄） */
const STATE_TONE: Record<AgentState, "idle" | "active" | "ok" | "warn" | "danger"> = {
  IDLE: "idle",
  LISTENING: "active",
  RECOGNIZING: "active",
  UNDERSTANDING: "active",
  PLANNING: "active",
  EXECUTING: "active",
  WAITING_TOOL: "warn",
  RESPONDING: "active",
  FINISHED: "ok",
  ERROR: "danger",
};

const TOOL_STATE_LABEL: Record<string, string> = {
  running: "调用中",
  waiting: "等待确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const RISK_LABEL: Record<number, string> = {
  0: "查询",
  1: "UI 操作",
  2: "设备操作",
  3: "机器人运动",
  4: "危险操作",
};

/**
 * Barge-in 提示文案（§7）。
 * 抽成常量是为了让「播报中检测到用户开口」和「播报期间靠电平判定出的打断」
 * 说同一句话，避免两处措辞慢慢漂移。
 */
const BARGE_IN_NOTE = "检测到你开始说话，已停止当前播报并开始新一轮识别（Barge-in）";

function useAgentState() {
  return useSyncExternalStore(subscribeAgent, getAgentState, getAgentState);
}

/** 会话上下文的只读快照；不在 MumaiProvider 内时退回 seed 里的通道数据 */
type SessionInfo = {
  stageKey: string;
  accountLabel: string;
  sourceMode: "demo" | "real";
  channelSummary: string;
};

function channelSummaryOf(channels: { label: string; state: string; ageSec: number }[]): string {
  return channels
    .map((item) => `${item.label}${item.state === "online" ? "在线" : item.state === "stale" ? `延迟${item.ageSec}s` : "离线"}`)
    .join("、");
}

/**
 * 控制台可能挂在两处：应用 React 树内（有 Router + MumaiProvider），
 * 或 agent/index.tsx 的 standalone root（没有 Provider）。
 * 因此这里对 useMumai / useNavigate 做可选处理 —— 缺上下文时不抛错，
 * 只是把上下文类信息退回到 seed 的默认值、把导航降级为 hash 路由。
 */
function useSession(): SessionInfo {
  let mumai: ReturnType<typeof useMumai> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 该 hook 在 Provider 内永远可用，脱离 Provider 时由 catch 兜底
    mumai = useMumai();
  } catch {
    mumai = null;
  }
  const channels = mumai?.channels ?? CHANNELS;
  return {
    stageKey: mumai?.stage ?? "",
    accountLabel: mumai?.accountId ?? "未登录会话",
    sourceMode: mumai?.deviceSource ?? "demo",
    channelSummary: channelSummaryOf(channels),
  };
}

/** 导航：优先用 react-router 的 navigate，没有 Router 时写 hash（HashRouter 认 hash 变化） */
function useAgentNavigate(): (to: string) => void {
  let navigate: ReturnType<typeof useNavigate> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上：脱离 Router 时由 catch 兜底
    navigate = useNavigate();
  } catch {
    navigate = null;
  }
  return useCallback(
    (to: string) => {
      if (navigate) {
        navigate(to);
        return;
      }
      if (typeof window !== "undefined") window.location.hash = `#${to}`;
    },
    [navigate],
  );
}

/** 声波：用音量驱动高度，青色只用于光效（设计规范 1.2） */
function Waveform({ level, active }: { level: number; active: boolean }) {
  const bars = useMemo(() => [0.5, 0.75, 1, 1.35, 1, 0.75, 0.5], []);
  return (
    <div className={`vc-wave ${active ? "is-active" : ""}`} aria-hidden="true">
      {bars.map((weight, index) => (
        <i
          key={index}
          style={{
            height: `${Math.max(3, Math.min(26, 3 + level * 26 * weight))}px`,
            opacity: active ? 0.35 + level * 0.65 : 0.25,
          }}
        />
      ))}
    </div>
  );
}

/** 步骤清单：✓ 已完成 / ● 正在做 / ○ 待执行（技术方案 §24） */
function StepList({ steps }: { steps: AgentStep[] }) {
  const done = steps.filter((step) => step.status === "done").length;
  if (steps.length === 0) return null;
  return (
    <div className="vc-steps">
      <header>
        <span>执行步骤</span>
        <em>
          {done}/{steps.length}
        </em>
      </header>
      <div className="vc-steps__bar" aria-hidden="true">
        <i style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step.index} className={`is-${step.status}`}>
            <b aria-hidden="true">
              {step.status === "done" ? "✓" : step.status === "running" ? "●" : step.status === "failed" ? "×" : step.status === "skipped" ? "–" : "○"}
            </b>
            <span>{step.name}</span>
            <em>{step.message}</em>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BotBubble({ turn, onReplay, tts }: { turn: BotTurn; onReplay: (turn: BotTurn) => void; tts: TtsStatus }) {
  const [factOpen, setFactOpen] = useState(false);
  return (
    <article className="vc-bubble vc-bubble--bot">
      <div className="vc-bubble__head">
        <span className="vc-bubble__who">小木</span>
        <span className={`vc-intent vc-intent--${turn.level}`}>
          {turn.intentId ?? "no_hit"} · {turn.intentName}
        </span>
        <span className="vc-bubble__conf" title="技术方案 §15 的 Top1 相似度">
          置信度 {turn.confidence.toFixed(3)}
        </span>
        <span className="vc-bubble__voice" title="语音包">
          {turn.voice}
        </span>
      </div>

      {turn.rule ? <p className="vc-bubble__rule">⚑ {turn.rule}</p> : null}

      {turn.toolRuns.length ? (
        <div className="vc-tools">
          {turn.toolRuns.map((run) => (
            <div key={run.id} className={`vc-tool is-${run.state}`}>
              <header>
                <b>{run.label}</b>
                <em>{run.tool}</em>
                <i>风险 {run.risk} · {RISK_LABEL[run.risk] ?? "—"}</i>
                <span>{TOOL_STATE_LABEL[run.state] ?? run.state}</span>
              </header>
              <p>{run.result || "调用中…"}</p>
              <small>
                {run.at}
                {run.durationMs > 0 ? ` · ${run.durationMs} ms` : ""} · 参数 {JSON.stringify(run.args)}
              </small>
            </div>
          ))}
        </div>
      ) : null}

      <StepList steps={turn.steps} />

      <p className="vc-bubble__text">{turn.text}</p>

      {turn.entities.length ? (
        <div className="vc-entities">
          <small>抽取到的槽位</small>
          {turn.entities.map((item) => (
            <span key={item.name}>
              {item.name} <b>{item.value}</b>
            </span>
          ))}
        </div>
      ) : null}

      {turn.facts.length ? (
        <div className="vc-facts">
          <button type="button" className="vc-facts__toggle" onClick={() => setFactOpen((open) => !open)}>
            业务状态（结构化数据）{factOpen ? "▾" : "▸"} {turn.facts.length} 项
          </button>
          {factOpen ? (
            <dl>
              {turn.facts.map((fact) => (
                <div key={fact.key} className={`is-${fact.tone}`}>
                  <dt>{fact.key}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}

      <footer>
        <time>{turn.at}</time>
        <button type="button" onClick={() => onReplay(turn)} disabled={!tts.supported}>
          重播
        </button>
        <span>{turn.note}</span>
      </footer>
    </article>
  );
}

export default function VoiceConsole() {
  const state = useAgentState();
  const session = useSession();
  const navigate = useAgentNavigate();
  const [input, setInput] = useState("");
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ supported: false, speaking: false, muted: false, channel: "" });
  const [pushHold, setPushHold] = useState(false);
  const [banner, setBanner] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<VoiceOutput | null>(null);
  const inputAsrRef = useRef<VoiceInput | null>(null);
  const lastSpokenRef = useRef<{ text: string; audio?: string }>({ text: "" });
  const lastAutoQuestionRef = useRef("");

  /* ---------- 运行时：把路由与会话状态注入执行器 ---------- */
  const runtime = useMemo<Runtime>(
    () => ({
      navigate,
      session: {
        stageKey: session.stageKey,
        accountLabel: session.accountLabel,
        sourceMode: session.sourceMode,
        channelSummary: session.channelSummary,
      },
      speak: (text: string) => {
        lastSpokenRef.current = { text };
        void outputRef.current?.speak(text);
      },
    }),
    [navigate, session],
  );

  // runtime 用 ref 持有：它是每次渲染都会新建的对象。
  // 如果进 effect 依赖数组，音量回调引发的高频重渲染会不停重建 VoiceInput
  // （cleanup 里 stopMic → onLevel → setAgent → 再渲染），最终撞上 React 的
  // "Maximum update depth exceeded"。生命周期只跟组件挂载绑定。
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  /* ---------- 语音输出 ---------- */
  useEffect(() => {
    const output = new VoiceOutput(setTtsStatus);
    /**
     * 自听回环治理（本次修复的核心接线）：
     * speechSynthesis / <audio> 的声音会从扬声器漏回麦克风，识别器会把小木自己的话
     * 当成用户输入，于是来回自我对话停不下来。所以播报一开始就让输入侧暂停聆听
     * （VoiceInput.suspend 会 abort 掉在途识别），说完 / 被打断 / 被静音后再恢复。
     *
     * 这里只做转发，不需要自己记状态：VoiceOutput 保证每次翻转都通知一次，
     * VoiceInput 的 suspend/resume 自己保证幂等。
     */
    output.onSpeakingChange = (speaking) => {
      if (speaking) inputAsrRef.current?.suspend();
      else inputAsrRef.current?.resume();
    };
    outputRef.current = output;
    setTtsStatus(output.status);
    return () => {
      // 先摘回调再 stop()：卸载（含 StrictMode 的复挂）时 stop() 会触发
      // onSpeakingChange(false)，那一刻输入侧正在拆，不需要它再去恢复聆听
      output.onSpeakingChange = undefined;
      output.stop();
      outputRef.current = null;
    };
  }, []);

  /* ---------- 语音输入 + VAD + Barge-in ---------- */
  useEffect(() => {
    const input$ = new VoiceInput({
      onListening: () => setAgent({ agentState: "LISTENING", stateNote: "麦克风已开启，等待说话" }),
      onPartial: (text, final) => setAgent({ partial: final ? "" : text, agentState: final ? "RECOGNIZING" : "LISTENING" }),
      onLevel: (level) => setAgent({ level }),
      onSpeechStart: () => {
        // §7 Barge-in：播报中检测到用户开口，立即停止播报并开新一轮。
        // 注意播报期间识别是暂停的（见上面的 onSpeakingChange），所以真正在播报中
        // 触发打断的是下面的 onBargeIn；这里的判断保留下来作为兜底，
        // 覆盖「识别还活着、但播报已经开始」的那一瞬。
        if (outputRef.current?.status.speaking) {
          outputRef.current.stop();
          setBanner(BARGE_IN_NOTE);
        }
      },
      onSpeechEnd: () => setAgent({ agentState: "RECOGNIZING", stateNote: "检测到静音，正在收尾识别" }),
      onFinal: (text) => {
        if (!text.trim()) return;
        setAgent({ finalText: text, partial: "" });
        void ask(text, runtimeRef.current, "mic");
      },
      onNotice: (text) => {
        setBanner(text);
        setAgent({ agentState: "IDLE", stateNote: "麦克风不可用，使用演示语句或文本输入", asrNote: text, micActive: false });
      },
      onError: (text) => setBanner(text),
      onBargeIn: () => {
        // 播报期间的打断：此时识别已经停了（不让小木听见自己），VoiceInput 靠
        // 「一路只测音量的检测」判断用户插话 —— 连续超阈值且高于播报本底才算数。
        // stop() 会翻转 speaking → onSpeakingChange(false) → 输入侧自动 resume()，
        // 于是打断之后立刻进入新一轮识别，§7 的链路是闭环的。
        if (!outputRef.current?.status.speaking) return;
        outputRef.current.stop();
        setBanner(BARGE_IN_NOTE);
      },
    });
    inputAsrRef.current = input$;
    return () => {
      // 先置空再 dispose：卸载期间若还有 onSpeakingChange 之类的回调迟到，
      // 它们拿到的就是 null，而不是一个已经拆掉的 VoiceInput
      inputAsrRef.current = null;
      input$.dispose();
    };
  }, []);

  /* ---------- 全局事件：外部通过 mumai:agent-open 打开控制台 ---------- */
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string }>).detail;
      setAgent({ open: true, initialQuestion: detail?.question?.trim() ?? "" });
    };
    const onClose = () => setAgent({ open: false });
    window.addEventListener("mumai:agent-open", onOpen);
    window.addEventListener("mumai:agent-close", onClose);
    return () => {
      window.removeEventListener("mumai:agent-open", onOpen);
      window.removeEventListener("mumai:agent-close", onClose);
    };
  }, []);

  /* ---------- 打开时携带的问句：自动跑一次完整交互 ---------- */
  useEffect(() => {
    // 两个来源：组件在挂载前派发的事件由 api.tsx 的模块级监听器暂存，
    // 挂载后派发的走 store 的 initialQuestion。
    const question = state.initialQuestion || takePendingQuestion();
    if (!question) return;
    // 同一句话只自动跑一次（重复打开同一个问题不应重复执行）
    if (lastAutoQuestionRef.current === question) return;
    lastAutoQuestionRef.current = question;
    setAgent({ initialQuestion: "", finalText: question });
    // 略微延后，等控制台渲染完成再跑链路，观众能看到字幕与状态机的推进
    const timer = window.setTimeout(() => void ask(question, runtimeRef.current, "example"), 420);
    return () => window.clearTimeout(timer);
  }, [state.initialQuestion, state.open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [state.turns]);

  const close = useCallback(() => {
    outputRef.current?.stop();
    inputAsrRef.current?.stopAll();
    setAgent({ open: false, agentState: "IDLE", stateNote: "待命", level: 0, partial: "", micActive: false });
  }, []);

  const submit = useCallback(
    (text: string, via: "text" | "mic" | "example") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setInput("");
      if (via === "text") {
        setAgent({ finalText: trimmed, partial: "" });
        void ask(trimmed, runtime, "text");
        return;
      }
      // 示例问句走脚本化 ASR：逐字吐 partial，再给 final（§8 的效果）
      inputAsrRef.current?.simulate(trimmed);
    },
    [runtime],
  );

  /** 按住说话：抢麦克风（失败自动降到脚本模式并提示） */
  const pressToTalk = useCallback(
    async (down: boolean) => {
      setPushHold(down);
      const input$ = inputAsrRef.current;
      if (!input$) return;
      if (!down) {
        input$.stopMic();
        setAgent({ micActive: false, level: 0, agentState: "FINISHED", stateNote: "已松开，等待识别结果" });
        return;
      }
      setBanner("");
      // 用户主动按「按住说话」= 最明确的打断意图：先把播报掐掉。
      // 顺序很重要 —— stop() → speaking=false → onSpeakingChange(false) → resume()，
      // 聆听先恢复，随后 startMic 才能把识别干净地拉起来（否则会被 suspend 守卫挡掉）。
      outputRef.current?.stop();
      const granted = await input$.startMic();
      setAgent({
        micActive: granted,
        asrNote: granted
          ? recognitionSupported()
            ? "真实语音识别通道（webkitSpeechRecognition · zh-CN · interimResults）"
            : "麦克风电平可用，但浏览器不支持 SpeechRecognition，请用示例问句或文本输入"
          : "脚本化演示模式：点示例问句即可",
      });
      if (granted && recognitionSupported()) input$.startRecognition();
      if (!granted) {
        setBanner("没有拿到麦克风权限，已切换到脚本化演示：点任意示例问句即可看到完整链路。");
      }
    },
    [],
  );

  /** 脚本化「按住说话」的替身：没有麦克风时按住按钮也走示例问句 */
  const scriptedHold = useCallback(() => {
    const pick = EXAMPLE_PICKS[Math.floor(Math.random() * EXAMPLE_PICKS.length)];
    inputAsrRef.current?.simulate(pick.example);
    setBanner("当前处于脚本化演示模式：正在逐字模拟流式识别（真实麦克风路径需要权限）。");
  }, []);

  const activeTone = STATE_TONE[state.agentState];

  return (
    <div className="vc-root" role="dialog" aria-modal="true" aria-label="小木语音智能体">
      <button type="button" className="vc-backdrop" aria-label="关闭语音控制台" onClick={close} />

      <section className="vc">
        {/* 1. 状态机 + 电平 ------------------------------------------------------------------ */}
        <header className="vc__head">
          <div className="vc__title">
            <b>小木 · 语音智能体</b>
            <small>
              意图目录 {INTENTS.length} 条 · 工具白名单 · {KNOWLEDGE_META.retriever}
            </small>
          </div>

          <div className={`vc-state is-${activeTone}`}>
            <i aria-hidden="true" />
            <b>{state.agentState}</b>
            <span>{AGENT_STATE_LABEL[state.agentState]}</span>
            <em>{state.stateNote}</em>
          </div>

          <div className="vc-meter" title="麦克风电平（真实音量或脚本模拟）">
            <div className="vc-meter__bar">
              <i style={{ width: `${Math.round(state.level * 100)}%` }} />
            </div>
            <Waveform level={state.level} active={state.agentState === "LISTENING" || state.agentState === "RECOGNIZING"} />
            <small>{state.micActive ? "麦克风采集中" : "未采集"}</small>
          </div>

          <div className="vc__actions">
            <button
              type="button"
              className={`vc-btn ${state.voiceOn ? "is-on" : ""}`}
              onClick={() => {
                const next = !state.voiceOn;
                outputRef.current?.setMuted(!next);
                setAgent({ voiceOn: next });
                if (!next) outputRef.current?.stop();
              }}>
              {state.voiceOn ? "语音开" : "语音关"}
            </button>
            <button type="button" className="vc-btn" onClick={() => clearTurns()}>
              清空对话
            </button>
            <button type="button" className="vc-btn vc-btn--ghost" onClick={close} aria-label="关闭">
              ✕
            </button>
          </div>
        </header>

        {/* 2. 实时字幕 ---------------------------------------------------------------------- */}
        <section className="vc-subtitle" aria-live="polite">
          <div className="vc-subtitle__line">
            {state.partial ? <span className="is-partial">{state.partial}</span> : null}
            {!state.partial && state.finalText ? <span className="is-final">{state.finalText}</span> : null}
            {!state.partial && !state.finalText ? (
              <span className="is-idle">按「按住说话」或直接点下面的示例问句，字幕会实时出现</span>
            ) : null}
            {state.partial ? <i className="vc-caret" aria-hidden="true" /> : null}
          </div>
          <div className="vc-subtitle__meta">
            <span>
              ASR 通道：{state.micActive ? "真实麦克风" : "脚本化演示（逐字模拟流式识别）"}
            </span>
            <span>{state.asrNote}</span>
            <span>
              置信阈值 high {SEMANTIC_THRESHOLDS.highConfidence} / low {SEMANTIC_THRESHOLDS.lowConfidence} / margin{" "}
              {SEMANTIC_THRESHOLDS.minMargin}
            </span>
            <span>{RETRIEVAL_NOTE}</span>
            <span>语音输出：{ttsStatus.channel}</span>
          </div>
        </section>

        {banner ? (
          <div className="vc-banner" role="status">
            {banner}
            <button type="button" onClick={() => setBanner("")} aria-label="关闭提示">
              ✕
            </button>
          </div>
        ) : null}

        {/* 3. 对话流 ------------------------------------------------------------------------ */}
        <div className="vc__list" ref={listRef}>
          {state.turns.length === 0 ? (
            <div className="vc-empty">
              <b>演示链路</b>
              <ol>
                <li>麦克风 / 示例问句 → VAD 判定说话开始与结束</li>
                <li>流式 ASR → 实时字幕（partial → final）</li>
                <li>规则匹配 → 相似度匹配（字符 bigram 余弦，bge-small 的本地等价实现）</li>
                <li>槽位抽取 → Intent Router → 白名单工具执行</li>
                <li>多步任务进入 Agent 编排，界面显示 ✓ / ● / ○ 步骤清单</li>
                <li>回复优先预录音频，缺失则浏览器本地语音合成</li>
              </ol>
            </div>
          ) : null}

          {state.turns.map((turn: Turn) =>
            turn.kind === "user" ? (
              <div key={turn.id} className="vc-bubble vc-bubble--user">
                <p>{turn.text}</p>
                <footer>
                  <time>{turn.at}</time>
                  <span>{turn.via === "mic" ? "按住说话" : turn.via === "example" ? "示例问句（脚本化 ASR）" : "文本输入"}</span>
                </footer>
              </div>
            ) : (
              <BotBubble
                key={turn.id}
                turn={turn}
                tts={ttsStatus}
                onReplay={(item) => void outputRef.current?.replay(item.text, lastSpokenRef.current.audio)}
              />
            ),
          )}
        </div>

        {/* 4. 输入区 ------------------------------------------------------------------------ */}
        <footer className="vc__foot">
          <div className="vc-examples">
            {EXAMPLE_PICKS.map((pick) => (
              <button key={pick.intentId + pick.example} type="button" onClick={() => submit(pick.example, "example")}>
                {pick.example}
              </button>
            ))}
            <button
              type="button"
              className="vc-examples__task"
              onClick={() => submit(AGENT_TASK_EXAMPLES[0], "example")}>
              ★ 多步任务：{AGENT_TASK_EXAMPLES[0]}
            </button>
          </div>

          <div className="vc-input">
            <button
              type="button"
              className={`vc-ptt ${pushHold ? "is-hold" : ""}`}
              aria-label="按住说话"
              onPointerDown={() => {
                void pressToTalk(true);
              }}
              onPointerUp={() => {
                void pressToTalk(false);
              }}
              onPointerLeave={() => {
                if (pushHold) void pressToTalk(false);
              }}
              onDoubleClick={scriptedHold}
              title="按住说话（双击 = 脚本化演示一次）">
              按住说话
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit(input, "text");
              }}>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="也可以直接输入识别文本，例如：让小车去一号木柱"
                aria-label="输入指令"
              />
              <button type="submit">发送</button>
            </form>
            <span className="vc-input__hint">
              槽位示例：{PILLAR_ALIASES.slice(0, 4).map((item) => item.componentId).join(" / ")}；语音包 {voicePackOf("robot_move")}
            </span>
          </div>
        </footer>

        {/* 5. 高风险动作确认层（§42）------------------------------------------------------- */}
        {state.pendingConfirm ? (
          <div className="vc-confirm" role="alertdialog" aria-modal="true">
            <div className="vc-confirm__box">
              <header>
                <b>需要确认</b>
                <em>风险等级 {state.pendingConfirm.risk}/4</em>
              </header>
              <p className="vc-confirm__title">{state.pendingConfirm.title}</p>
              <p className="vc-confirm__detail">{state.pendingConfirm.detail}</p>
              <div className="vc-confirm__actions">
                <button type="button" className="vc-btn vc-btn--danger" onClick={() => resolveConfirm(true)}>
                  确认执行
                </button>
                <button type="button" className="vc-btn" onClick={() => resolveConfirm(false)}>
                  取消
                </button>
              </div>
              <small>{state.pendingConfirm.cancelText}</small>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
