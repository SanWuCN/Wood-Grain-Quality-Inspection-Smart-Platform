/**
 * 小木语音智能体 · 运行态 store
 *
 * 三件事：
 *   1. 会话流（用户 / 小木的轮次、工具卡片、步骤清单）—— 用 useSyncExternalStore 订阅；
 *   2. 实时快照（电量、航点位置、任务状态、地图、扫描）—— 工具通过它产生真实可见的变化；
 *   3. 确认层（§42）—— 高风险工具执行前挂起，Promise 等用户在界面上点确认 / 取消。
 *
 * 为什么不用 zustand：项目里已有 zustand（map/store.ts），但那个 store 是给
 * 三维场景逐帧订阅用的；小木的会话流更新频率低、结构深，用一个不可变快照 +
 * useSyncExternalStore 更简单，也不需要新增依赖。
 */

import { MISSION, WAYPOINTS } from "../seed/scenario";
import { clockStamp } from "../lib";
import { plannedPathLength } from "./lib/geo";
import type { ToolContext, LiveState } from "./tools";
import type { AgentState, AgentStep, ConfirmRequest, ToolRunRecord, Turn } from "./types";

/** 满电与展示态电量：从任务计划里程推导，避免凭空写一个百分比 */
function initialLive(): LiveState {
  return {
    // 演示车为回放态：电量按「计划里程越长、可用容量越低」的方式给出一个确定性值
    battery: Math.max(40, 100 - Math.round(plannedPathLength())),
    waypointIndex: WAYPOINTS.length - 1,
    waypointLabel: WAYPOINTS[WAYPOINTS.length - 1]?.label ?? "—",
    missionState: MISSION.state,
    mapId: MISSION.mapVersion,
    mapping: false,
    scanning: true,
    lastScanBatch: null,
    cameraLive: true,
    focusComponent: null,
    focusZone: null,
  };
}

export type AgentStoreState = {
  /** 语音控制台是否打开 */
  open: boolean;
  agentState: AgentState;
  /** 状态机的补充说明，显示在徽标旁边 */
  stateNote: string;
  live: LiveState;
  turns: Turn[];
  toolRuns: ToolRunRecord[];
  /** 多步任务的步骤清单（§24），单步意图时为空 */
  steps: AgentStep[];
  /** 当前实时字幕 */
  partial: string;
  finalText: string;
  /** 麦克风电平 0–1（真实音量或脚本模拟） */
  level: number;
  /** 录音是否在采集 */
  micActive: boolean;
  /** 待确认的高风险动作 */
  pendingConfirm: ConfirmRequest | null;
  /**
   * 打开控制台时携带的问句（来自 mumai:agent-open 的 detail.question）。
   * 放在 store 而不是 props，是为了让「应用内挂载」与「standalone 兜底挂载」
   * 两种路径都能拿到同一个待执行问句。
   */
  initialQuestion: string;
  /**
   * 本轮交互的唯一 ID（每次 mumai:agent-open 生成一个）。
   *
   * ── 为什么必须按 ID 去重，不能按文本（PRD FR-03 / FR-09）──
   * 原先 VoiceConsole 用 `lastAutoQuestionRef.current === question` 去重，
   * 于是**连续两次说同一句话，第二次被直接 return 掉**。
   * 实测复现：连续两次 open(question="介绍一下这套系统")，用户气泡只出 1 个。
   * 但"同一句话再说一遍"是完全合法的操作，必须产生新的一轮。
   *
   * 去重的真实目的是「同一个打开事件被重复消费」——那是**事件**层面的重复，
   * 所以判据也必须是事件 ID，而不是文本。
   */
  interactionId: string;
  /** 语音是否开启 */
  voiceOn: boolean;
  /** ASR 通道说明（真实 / 脚本降级） */
  asrNote: string;
};

let state: AgentStoreState = {
  open: false,
  agentState: "IDLE",
  stateNote: "待命",
  live: initialLive(),
  turns: [],
  toolRuns: [],
  steps: [],
  partial: "",
  finalText: "",
  level: 0,
  micActive: false,
  pendingConfirm: null,
  initialQuestion: "",
  interactionId: "",
  voiceOn: true,
  asrNote: "等待选择输入方式",
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeAgent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentState(): AgentStoreState {
  return state;
}

export function setAgent(patch: Partial<AgentStoreState>) {
  state = { ...state, ...patch };
  emit();
}

/**
 * 开发期调试句柄：`window.__mumaiAgent`。
 *
 * ── 为什么需要它（不是为了方便，是因为**没它就没法验证**）────────────
 * 形象有七个界面状态，但它们在浏览器里**很难自然构造**：
 * 要真实触发"播报中"得先有唤醒 + ASR + 意图命中 + TTS，而"出错"要通道断线。
 * 截图工装因此只能手改 DOM 的 `data-state` —— 但那是 React 的渲染产物，
 * 下一次重渲染就被覆盖，于是七个状态拍出来全是 idle（我确实这么白拍过一轮）。
 * 有了这个句柄，工装可以**驱动真实状态**，拍到的就是用户会看到的画面。
 *
 * ⚠ 只在开发构建暴露（`import.meta.env.DEV`），生产构建里这段是死代码。
 * 与既有的 `window.__mumaiWake`（唤醒通道）、`__mumaiInput` 同一口径。
 */
if (import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__mumaiAgent = {
    setAgent,
    getAgentState,
    /** 供工装一次设一个状态，语义比 setAgent({agentState}) 更直白 */
    setState: (agentState: AgentStoreState["agentState"]) => setAgent({ agentState }),
    /** 构造"等待确认"：形象在 confirming 态靠的是 pendingConfirm，不是 agentState */
    setPendingConfirm: (on: boolean) => setAgent({
      pendingConfirm: on
        ? {
            id: -1,
            title: "调试用确认",
            detail: "由 window.__mumaiAgent.setPendingConfirm 构造，仅用于截图工装验证 confirming 态。",
            risk: 3,
            tool: "debug_confirm",
            cancelText: "取消",
          }
        : null,
    }),
  };
}

export function patchLive(patch: Partial<LiveState>) {
  state = { ...state, live: { ...state.live, ...patch } };
  emit();
}

/* ------------------------------------------------------------------ *
 * 会话流
 * ------------------------------------------------------------------ */

let seq = 1;
export const nextId = () => {
  seq += 1;
  return seq;
};

export function pushTurn(turn: Turn) {
  setAgent({ turns: [...state.turns, turn] });
}

/** 就地更新最后一轮小木回复（执行过程中不断刷新步骤与工具状态） */
export function updateLastBot(patch: (turn: Extract<Turn, { kind: "bot" }>) => Partial<Extract<Turn, { kind: "bot" }>>) {
  const turns = [...state.turns];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.kind === "bot") {
      turns[i] = { ...turn, ...patch(turn) };
      break;
    }
  }
  setAgent({ turns });
}

export function clearTurns() {
  setAgent({ turns: [], toolRuns: [], steps: [], partial: "", finalText: "" });
}

/* ------------------------------------------------------------------ *
 * 工具调用记录（PRD 4.1：工具卡片显示实际调用状态）
 * ------------------------------------------------------------------ */

export function startToolRun(patch: { tool: string; label: string; args: Record<string, string>; risk: number; state: ToolRunRecord["state"] }): number {
  const id = nextId();
  const record: ToolRunRecord = {
    id,
    tool: patch.tool,
    label: patch.label,
    args: patch.args,
    state: patch.state,
    risk: patch.risk,
    result: "",
    at: clockStamp(),
    durationMs: 0,
  };
  setAgent({ toolRuns: [...state.toolRuns, record] });
  updateLastBot((turn) => ({ toolRuns: [...turn.toolRuns, record] }));
  return id;
}

export function finishToolRun(id: number, result: string, runState: ToolRunRecord["state"], durationMs: number) {
  const toolRuns = state.toolRuns.map((item) =>
    item.id === id ? { ...item, state: runState, result, durationMs } : item,
  );
  setAgent({ toolRuns });
  updateLastBot((turn) => ({
    toolRuns: turn.toolRuns.map((item) => (item.id === id ? { ...item, state: runState, result, durationMs } : item)),
  }));
}

/* ------------------------------------------------------------------ *
 * 步骤清单（§24：✓ / ● / ○ 三态）
 * ------------------------------------------------------------------ */

export function setSteps(steps: AgentStep[]) {
  setAgent({ steps });
  updateLastBot(() => ({ steps }));
}

export function patchStep(index: number, patch: Partial<AgentStep>) {
  const steps = state.steps.map((step) => (step.index === index ? { ...step, ...patch } : step));
  setSteps(steps);
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

export function pushLog(text: string) {
  updateLastBot((turn) => ({ note: turn.note ? `${turn.note}｜${text}` : text }));
}

/* ------------------------------------------------------------------ *
 * 确认层（§42）
 * ------------------------------------------------------------------ */

let confirmSeq = 1;
let pendingResolve: ((value: boolean) => void) | null = null;

export function requestConfirm(request: Omit<ConfirmRequest, "id">): Promise<boolean> {
  // 同一时刻只允许一个待确认动作；旧的直接按取消处理，避免误点
  if (pendingResolve) {
    pendingResolve(false);
    pendingResolve = null;
  }
  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
    setAgent({ pendingConfirm: { ...request, id: confirmSeq++ } });
  });
}

export function resolveConfirm(approved: boolean) {
  const resolver = pendingResolve;
  pendingResolve = null;
  setAgent({ pendingConfirm: null });
  resolver?.(approved);
}

export function hasPendingConfirm(): boolean {
  return pendingResolve !== null;
}

/* ------------------------------------------------------------------ *
 * 工具上下文
 * ------------------------------------------------------------------ */

export function makeToolContext(
  navigate: ((to: string) => void) | null,
  entities: Record<string, string | undefined>,
): ToolContext {
  return {
    navigate,
    entities,
    log: pushLog,
    live: {
      read: () => state.live,
      patch: patchLive,
    },
  };
}
