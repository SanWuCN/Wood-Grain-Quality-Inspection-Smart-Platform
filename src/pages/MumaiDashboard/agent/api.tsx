/**
 * 小木语音智能体 · 对外接口（不含业务组件，只放常量 / 命令式函数 / 兜底挂载）
 *
 * 与 index.tsx 的分工：
 *   - api.tsx       事件名常量、命令式开关、standalone 兜底挂载
 *   - VoiceConsole  控制台本体（React 组件）
 *   - index.tsx     对外唯一入口，把上面两者一起导出
 *
 * 这样拆分是为了满足 eslint 的 react-refresh/only-export-components：
 * 导出组件的文件不再导出常量与函数。
 */

import { useEffect, useState } from "react";
import { getAgentState, setAgent, subscribeAgent } from "./store";

/** 全局事件约定（调用方不需要了解本模块的实现细节） */
export const AGENT_EVENT = {
  /** detail?: { question?: string } */
  OPEN: "mumai:agent-open",
  CLOSE: "mumai:agent-close",
} as const;

/** 命令式打开（等价于派发 mumai:agent-open） */
export function openAgent(question?: string): void {
  window.dispatchEvent(new CustomEvent(AGENT_EVENT.OPEN, { detail: question ? { question } : {} }));
}

/** 命令式关闭 */
export function closeAgent(): void {
  window.dispatchEvent(new CustomEvent(AGENT_EVENT.CLOSE));
}

/** 关闭控制台并把状态机复位 */
export function resetAgent(): void {
  setAgent({ open: false, agentState: "IDLE", stateNote: "待命", level: 0, partial: "" });
}

/** 已经渲染了几处 <AgentHost />：> 0 时不再启用 standalone 兜底 */
export function markHostMounted(delta: number): void {
  hostCount = Math.max(0, hostCount + delta);
}

/* ------------------------------------------------------------------ *
 * 兜底：调用方没有渲染 AgentHost 时，首次打开事件自动挂一个独立 root
 * ------------------------------------------------------------------ */

let hostCount = 0;
let standalone: { unmount: () => void; container: HTMLElement } | null = null;
let loading = false;
/**
 * 待执行问句。
 *
 * 为什么需要它：standalone 挂载是异步的（要动态 import react-dom/client），
 * 打开事件可能在 VoiceConsole 挂载**之前**就已经派发完了，
 * 组件里的监听器会错过那个事件。所以这里在模块级同步接住问句，
 * 由 VoiceConsole 挂载后取走（takePendingQuestion 取一次就清空）。
 */
let pendingQuestion = "";

/** 取走待执行问句（只返回一次，避免重复提问） */
export function takePendingQuestion(): string {
  const value = pendingQuestion;
  pendingQuestion = "";
  return value;
}

async function mountStandalone(): Promise<void> {
  if (standalone || loading || typeof document === "undefined") return;
  loading = true;
  const container = document.createElement("div");
  container.id = "mumai-agent-standalone";
  document.body.appendChild(container);
  const [{ createRoot }, { default: VoiceConsole }] = await Promise.all([
    import("react-dom/client"),
    import("./VoiceConsole"),
  ]);
  const root = createRoot(container);
  // standalone 模式下没有 Router，VoiceConsole 会把 navigate 降级为 hash 路由
  root.render(<VoiceConsole />);
  standalone = { unmount: () => root.unmount(), container };
  loading = false;
}

function unmountStandalone() {
  if (!standalone) return;
  standalone.unmount();
  standalone.container.remove();
  standalone = null;
}

if (typeof window !== "undefined") {
  window.addEventListener(AGENT_EVENT.OPEN, (event) => {
    const detail = (event as CustomEvent<{ question?: string }>).detail;
    const question = detail?.question?.trim();
    if (question) pendingQuestion = question;
    // 先同步置位，保证 VoiceConsole 挂载时就能看到「已打开」
    setAgent({ open: true });
    window.setTimeout(() => {
      if (hostCount === 0 && !standalone) void mountStandalone();
      else if (standalone) {
        // 已经挂载时（standalone 或应用内宿主）由组件自己的监听器处理
        setAgent({ initialQuestion: question ?? "" });
      }
    }, 0);
  });
  window.addEventListener(AGENT_EVENT.CLOSE, unmountStandalone);
}

/** 控制台是否打开（宿主组件订阅它决定渲染） */
export function useAgentOpen(): boolean {
  const [open, setOpen] = useState(() => getAgentState().open);
  useEffect(() => subscribeAgent(() => setOpen(getAgentState().open)), []);
  return open;
}
