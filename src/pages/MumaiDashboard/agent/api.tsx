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
import { cancelRun } from "./executor";
import { getAgentState, hasPendingConfirm, resolveConfirm, setAgent, subscribeAgent } from "./store";
import { wakeChannel } from "./wakeChannel";

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

/** 命令式关闭 —— **所有关闭入口都必须走这里**（PRD FR-08） */
export function closeAgent(): void {
  window.dispatchEvent(new CustomEvent(AGENT_EVENT.CLOSE));
}

/** 关闭控制台并把状态机复位 */
export function resetAgent(): void {
  setAgent({ open: false, agentState: "IDLE", stateNote: "待命", level: 0, partial: "" });
}

/**
 * 本轮交互 ID。
 *
 * 每次打开事件生成一个，供调用方按**事件**去重（而不是按命令文本）。
 * 用「时间戳 + 自增序号」而不是纯随机：现场排查时能从 ID 看出先后顺序，
 * 而出错时最需要回答的恰恰是"这两轮到底是不是同一次"。
 */
let interactionSeq = 0;
export function nextInteractionId(): string {
  interactionSeq += 1;
  return `ia-${Date.now().toString(36)}-${interactionSeq}`;
}

/** 已经渲染了几处 <AgentHost />：> 0 时不再启用 standalone 兜底 */
export function markHostMounted(delta: number): void {
  hostCount = Math.max(0, hostCount + delta);
}

/**
 * 页面上是否开着**别人的**模态框（既不属于小木气泡，也不属于全屏控制台）。
 *
 * ── 为什么必须做成共享判据，而不是各自写一行 ──────────────────────
 * 小木有两层显示（右下角气泡 `.xd`、全屏诊断台 `.vc-root`），两层都监听 Esc；
 * 页面自己的 Modal（`ui.tsx`）也监听 Esc。三层互不知道对方，一次 Esc 能关掉两个 ——
 * 这就是 AC-04/FR-08 要防的"关掉眼前那个对话框，结果别的东西也一起没了"。
 *
 * 判据用 `[role="dialog"][aria-modal="true"]`：那是"当前有模态"的标准信号；
 * 同时**排除小木自己的两层**（控制台根节点本身就是 `role="dialog" aria-modal`，
 * 气泡的确认块也是 `role="alertdialog"`，不排除的话会把自己的键位也一起废掉）。
 */
export function hasForeignModal(): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(
    document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'),
  ).some((el) => !el.closest(".xd") && !el.closest(".vc-root"));
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
/**
 * 与 `pendingQuestion` 配对的交互 ID。
 *
 * 为什么必须一起暂存：问句和 ID 是**同一次打开事件**的两个字段，
 * 分开存就会出现"文本对上了、ID 是上一轮的"这种半新半旧的状态 ——
 * 而按 ID 去重的逻辑最怕的正是这个。
 */
let pendingInteractionId = "";

/** 取走待执行问句（只返回一次，避免重复提问） */
export function takePendingQuestion(): string {
  const value = pendingQuestion;
  pendingQuestion = "";
  return value;
}

/** 取走待执行的交互 ID（与问句同生命周期，取一次就清空） */
export function takePendingInteractionId(): string {
  const value = pendingInteractionId;
  pendingInteractionId = "";
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

/**
 * 浏览器环境判定 —— **不能只写 `typeof window !== "undefined"`**。
 *
 * 在 SSR / 只读探针环境（vite 的 `ssrLoadModule`）里 `window` 是存在的桩，
 * 但没有 `addEventListener`；只判 `typeof window` 会让模块级的事件订阅
 * 直接抛 `TypeError: window.addEventListener is not a function`，
 * 把整个探针打崩。实测代价：PRD 验收工装里 7 个检查项因此变成"证据不足"。
 *
 * 判据收紧成"确实有 DOM 事件接口"。
 */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(AGENT_EVENT.OPEN, (event) => {
    const detail = (event as CustomEvent<{ question?: string; interactionId?: string }>).detail;
    const question = detail?.question?.trim() ?? "";
    // 调用方没给 ID 时由这里补齐 —— 保证**任何**打开事件都有唯一 ID，
    // 忘记传的调用方不会退化成"又按文本去重"的旧行为
    const interactionId = detail?.interactionId?.trim() || nextInteractionId();
    if (question) {
      pendingQuestion = question;
      pendingInteractionId = interactionId;
    }
    // 先同步置位，保证 VoiceConsole 挂载时就能看到「已打开」和本轮 ID
    setAgent({ open: true, interactionId, initialQuestion: question });
    window.setTimeout(() => {
      if (hostCount === 0 && !standalone) void mountStandalone();
    }, 0);
  });
  /**
   * 统一关闭入口（PRD FR-08）。
   *
   * ── 这里原来是个真 bug，值得写下来 ──────────────────────────────
   * 原先关闭事件只挂 `unmountStandalone`：应用内挂载路径下 hostCount>0，
   * 卸载函数直接 return，**store 的 open 还是 true**，界面根本不消失；
   * 而 standalone 路径下 VoiceConsole 的关闭按钮又只 `setAgent({open:false})`、
   * 不派发本事件，于是容器与全屏遮罩永久留在 DOM 里拦截点击。
   * 实测：点关闭后 900ms，`.vc-root` 与 `#mumai-agent-standalone` 都还在，
   * 页面中心的 elementFromPoint 命中的是控制台里的元素。
   *
   * 现在两条路径都收敛到这里：**先复位 store，再卸载 standalone**，
   * 顺序不能反 —— standalone 卸载后 store 仍在，界面会停在"开着但没内容"。
   */
  window.addEventListener(AGENT_EVENT.CLOSE, () => {
    pendingQuestion = "";
    pendingInteractionId = "";
    /**
     * 统一关闭生命周期（AC-04）：**先把在飞的东西取消掉，再复位界面**。
     *
     * 顺序反了就会出现"关掉又自己冒出来"：`ask()` 是异步的，复位 store 之后
     * 它还在半空中，醒过来照样 `setAgent(RESPONDING)` 并重新播报。
     * 四件事都放在这里，是因为**任何一个关闭入口都必须做到它们**：
     *   · `cancelRun()`      —— 执行器这一轮代号作废，后续步骤全部退出；
     *   · `abortRound()`     —— 识别那一轮的字幕与收集态清掉，本轮命令丢弃；
     *   · `speechSynthesis.cancel()` —— 播报立刻停（原来只写在气泡的关闭按钮里，
     *                          于是"程序化关闭"这条入口漏掉了停播报）；
     *   · `resolveConfirm(false)` —— 未确认的高风险操作按"取消"处理，
     *                          绝不能因为关掉界面就当成已确认。
     * 都不碰常驻唤醒本身（FR-08：关气泡不释放麦克风）。
     */
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* 没在播就不用管 */
    }
    if (hasPendingConfirm()) resolveConfirm(false);
    cancelRun("界面已关闭");
    wakeChannel().abortRound();
    setAgent({
      open: false,
      initialQuestion: "",
      interactionId: "",
      agentState: "IDLE",
      stateNote: "待命",
      level: 0,
      partial: "",
      micActive: false,
    });
    unmountStandalone();
  });
}

/** 控制台是否打开（宿主组件订阅它决定渲染） */
export function useAgentOpen(): boolean {
  const [open, setOpen] = useState(() => getAgentState().open);
  useEffect(() => subscribeAgent(() => setOpen(getAgentState().open)), []);
  return open;
}
