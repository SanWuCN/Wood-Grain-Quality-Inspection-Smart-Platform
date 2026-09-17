/**
 * 小木 · 右下角常驻形象与气泡（PRD FR-06 / FR-07）
 *
 * ── 这是默认交互面，不再弹覆盖大半屏幕的语音窗口 ────────────────
 *
 * 原来的语音控制台是全屏遮罩（`.vc-root` 铺满 + `.vc-backdrop` 拦截点击），
 * 唤出一句话就把主业务页面整个盖住。本组件把它换成右下角局部区域：
 * 形象 + 气泡，主页面始终可见可点。
 *
 * ── 三个必须守住的约束（都来自 PRD，实现时刻意写在注释里）──────
 *
 * 1. **主回答永远不折叠**。归档/非实时这类声明就写在主回答正文里
 *    （FR-05 规定的那段话结尾就是"这是归档数据，不是非实时联网查询"），
 *    所以只要主回答可见，声明就可见，不需要单独再抽一个字段。
 *    可以折叠的只有「业务状态」和「资料引用」。
 * 2. **常驻唤醒与显示层解耦**（FR-08）。关掉气泡 ≠ 关掉麦克风；
 *    只有显式点「关闭常驻唤醒」才释放麦克风、断开 `/voice-wake`。
 * 3. **尊重 prefers-reduced-motion**（FR-06）。关掉动效后，
 *    状态仍要能靠文字和颜色分辨 —— 不能把状态只做在动画里。
 *
 * ── 为什么挂点是 AppShell（见那边的注释）────────────────────────
 * 它需要 router 与会话上下文，否则事实值与点击/文字入口不一致（AC-06）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import XiaomuFace from "./XiaomuFace";
import { ask, type Runtime } from "./executor";
import { closeAgent, hasForeignModal, nextInteractionId } from "./api";
import { stableNote, wakeErrorHint, WAKE_REPLY_TEXT } from "./degrade";
import { useAgentNavigate, useAgentSession } from "./agentSession";
import { getAgentState, resolveConfirm, setAgent, subscribeAgent } from "./store";
import { microphoneSupported } from "./asr";
import { shortcutSheetRows, walkShortcutNote } from "./shortcutSheet";
import { wakeChannel, type WakeSnapshot } from "./wakeChannel";
import { buildReplyView, latestBotTurn, latestUserText, type ReplyView } from "./replyView";
import { VoiceOutput } from "./tts";
import {
  clampPos,
  maxSizeForViewport,
  clampSize,
  defaultSizeForViewport,
  posFromDrag,
  readStageMemory,
  resizeKeepingTopLeft,
  sizeFromResize,
  writeStageMemory,
  type StagePos,
} from "./XiaomuStage";
import "./xiaomuDock.css";

/**
 * 界面状态（PRD FR-06 要求至少这七种）。
 *
 * 为什么不直接复用 `AgentState`：那十个状态是**执行器**的语义
 * （PLANNING / WAITING_TOOL 之类），而这里是**用户看得见**的语义。
 * 两者近似但不等价 —— 例如"播报中"在执行器里仍是 FINISHED。
 * 硬把执行器状态当界面状态用，就会出现"小木正在说话但界面显示已完成"。
 */
type DockState =
  | "idle"
  | "listening"
  | "recognizing"
  | "thinking"
  | "speaking"
  | "confirming"
  | "error";

const DOCK_STATE_LABEL: Record<DockState, string> = {
  idle: "待机",
  listening: "正在听",
  recognizing: "识别中",
  thinking: "思考中",
  speaking: "播报中",
  confirming: "等待确认",
  error: "出错了",
};

export default function XiaomuDock() {
  /**
   * 导航与会话上下文走**共用**的取用函数（`agentSession.ts`），不自己写一份。
   *
   * 本组件挂在 `AppShell` 里，理论上 Provider 与 Router 都在，
   * 但仍然用共用函数：全屏控制台（standalone root）没有 Provider/Router，
   * 两处若各写一份"取不到就退回默认值"的逻辑，事实值迟早漂移，
   * 而 AC-06 要求四个入口对同一意图返回同一事实值。
   */
  const navigate = useAgentNavigate();
  const session = useAgentSession();
  const agent = useSyncExternalStore(subscribeAgent, getAgentState);
  const [wake, setWake] = useState<WakeSnapshot>(() => wakeChannel().snapshot());
  const [expanded, setExpanded] = useState(false);
  /**
   * 用户已经按过 × 的**那一条**通道错误。
   *
   * ── 为什么必须有这个状态（用户实测"这个窗口关不掉"）──────────────
   * 本地没有语音服务时 `/voice-wake` 连不上，`wakeChannel` 会按退避表**一直重连**，
   * `wake.state` 因此长期停在 `reconnecting` → `dockState` 恒为 `error`
   * → `active` 恒为真 → 面板**关了立刻又回来**。× 只能关掉 `expanded` 与
   * `agent.open`，关不掉"通道正在重连"这个事实。
   *
   * 判据用「状态 + 说明」而不是布尔量：记住了这一条，下一条**新的**错误
   * （比如从"重连中"变成"权限被拒"）仍会照常弹出来提醒，不会一并静音。
   */
  const [dismissedWakeError, setDismissedWakeError] = useState<string | null>(null);
  /** 当前错误签名的 ref：close() 要先于签名计算拿到它（见 close 里的说明） */
  const errorSignatureRef = useRef<string | null>(null);
  const [factsOpen, setFactsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [openSource, setOpenSource] = useState<string | null>(null);
  /** 快捷键一览展开态（默认收起：它是说明书，不是每次都要看） */
  const [keysOpen, setKeysOpen] = useState(false);
  /*
    一览表的行只在挂载时算一次：它来自剧本与条目表（编译期常量），运行时不会变。
    `useMemo` 而不是每次渲染都调，是因为它内部会做一致性校验（对不上会抛错），
    每渲染一次跑一遍校验没有意义。
  */
  const sheetRows = useMemo(() => shortcutSheetRows(), []);
  /**
   * 麦克风是否可用（= 浏览器是否处于安全上下文）。
   *
   * 同事用 `http://192.168.x.x:8000` 打开时 `navigator.mediaDevices` 是 undefined，
   * 唤醒与语音输入都用不了 —— 那时候要把话说清楚，并把快捷键指给他。
   * 在 `useEffect` 里读而不是直接读：这是一个只在浏览器里存在的全局，
   * 服务端渲染/首帧读到 undefined 会让提示闪一下。
   */
  const [micOk, setMicOk] = useState(true);
  useEffect(() => setMicOk(microphoneSupported()), []);

  useEffect(() => wakeChannel().subscribe(setWake), []);

  /* ---------- 运行时（与语音控制台同一份构造方式，事实值才不会分叉）---------- */
  /**
   * 播报统一交给 `VoiceOutput`（**与全屏控制台同一个实现**）。
   *
   * ── 这里原来有个真缺陷，值得写清楚（用户实测"放的还是合成音"）────────
   * 气泡原先自己调 `window.speechSynthesis.speak()`，**绕过了 `VoiceOutput`**。
   * 后果：我把"预生成语音包"接在 `VoiceOutput.speak()` 里之后，
   * 控制台那条路会播录音，而**气泡这条（用户日常交互看到的那条）永远走浏览器合成音** ——
   * 两条播报路径各写一遍，能力自然只落在其中一条上。
   * 现在只保留一个实现：语音包 → speechSynthesis → 静默降级（含看门狗与 barge-in），
   * 全部由 `VoiceOutput` 负责，两个入口共用。
   */
  const outputRef = useRef<VoiceOutput | null>(null);
  if (!outputRef.current && typeof window !== "undefined") {
    outputRef.current = new VoiceOutput((status) => {
      // 与旧实现等价的界面反馈：播报中 → RESPONDING，播完 → FINISHED
      setAgent({ agentState: status.speaking ? "RESPONDING" : "FINISHED" });
    });
  }
  const runtime = useMemo<Runtime>(
    () => ({
      navigate,
      session,
      speak: (text: string) => {
        /**
         * FR-05 要求"TTS 只播报主回答，不逐项朗读字段名、来源定位和时间戳" ——
         * 所以这里**只**传 mainAnswer，绝不把 facts / sources / at 拼进去。
         *
         * 并把 Promise 透出去：剧本轮次用它把"逐段展开"校准到真实播报时长
         * （见 executor 的 startOrderDetailReveal）。吞掉它就只能按字数估算。
         */
        return outputRef.current?.speak(text);
      },
    }),
    [navigate, session],
  );
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  /**
   * 语音命令入口（供 wakeChannel 与串口通道调用）。
   *
   * 走的是 `mumai:xiaomu-ask` 事件而不是 `mumai:agent-open`：
   * 后者会挂起/显示独立的全屏控制台（诊断入口），而语音的默认落点是本气泡。
   * 两条路最终都调同一个 `ask()`，所以业务结果是同一份（FR-04 / AC-06）。
   */
  const askQueue = useRef<Promise<void>>(Promise.resolve());
  /**
   * 已经处理过的 interactionId（AC-03 第 1 条：**按 interactionId 去重**）。
   *
   * 为什么语音这条路必须有它：诊断控制台早就是按 id 去重的，而气泡这条
   * （wakeChannel / 串口都派发到它）原先只看 `question` ——
   * 同一条 WS 命令被重复投递两次（重连重放、服务端重复 emit）就会真的执行两轮，
   * 用户看到同一个问题被回答两遍。id 由派发方给出（wakeChannel 每轮生成），
   * 没有 id 的调用（例如页面上的示例按钮）照旧执行，不因此被挡。
   */
  const lastAskId = useRef("");
  /** 队列里还压着几条命令（>0 时标题行显示「排队中 N 条」，见 onAsk 里的说明） */
  const [queueDepth, setQueueDepth] = useState(0);
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string; interactionId?: string }>).detail;
      /**
       * ⚠ 这里不能写成 `if (!question) return;` —— 那会把「未听清」整条路径挡掉。
       *
       * `mumai:xiaomu-ask` 带 `question` 字段时，**空串也是有意义的信息**：
       * 它表示"唤醒成功了、但这句话没听懂"（服务端如实回的空命令）。
       * 丢掉它，用户看到的就是"喊醒了却毫无反应"——比说错话更糟。
       *
       * 判据因此是"**有没有 question 字段**"，而不是"question 是否非空"：
       *   · 有字段（哪怕空串）→ 照常走 `ask()`，空串由 executor 走 `replyNotHeard`
       *   · 没字段（例如只是想打开气泡）→ 忽略，不产生一轮交互
       */
      if (!detail || typeof detail.question !== "string") return;
      const question = detail.question.trim();
      /**
       * 缺 id 就补一个 —— 与 `api.tsx` 的打开事件同一条约定：
       * 「调用方没给 ID 时由这里补齐，保证**任何**打开事件都有唯一 ID」。
       *
       * 为什么气泡也要补：AC-03 要求「每轮生成并携带唯一 interactionId」，
       * 而派发方不止一个（wakeChannel 会带、串口桥会带、页面示例按钮和验收脚本
       * 可能不带）。只在"带了的"那几条路上有 id，等于这条验收标准漏了一半。
       * 用同一个 `nextInteractionId()`，不另造格式。
       */
      const interactionId = detail.interactionId?.trim() || nextInteractionId();
      if (interactionId === lastAskId.current) {
        console.info(`[xiaomu] 重复的 interactionId=${interactionId}，本轮不再执行（AC-03 去重）`);
        return;
      }
      lastAskId.current = interactionId;
      setAgent({ interactionId });
      /**
       * FR-09：同一时刻只处理一个语音命令，新命令**排队**而不是并发。
       *
       * 为什么必须串行：两个 `ask()` 并发写同一个 Agent store，
       * 会交叉 push 用户轮次与小木轮次，界面上出现"回答 A 挂在问题 B 下面"。
       * 排队用 Promise 链实现：上一条跑完才跑下一条，顺序与用户说话顺序一致。
       *
       * ── 排队必须**看得见**（诊断-语音入口丢命令.mjs 实测出来的缺口）──────
       * 队列本身没问题：待确认期间来的新命令会老老实实排在后面、取消确认后照常执行，
       * 不会死锁。但界面上**一点提示都没有** —— 用户喊了新命令，屏幕上没有任何变化，
       * 既看不到"已收到"，也看不到"在排队"，只能以为又坏了。
       * AC-03 允许的三种纪律是"排队 / 明确打断 / 提示忙碌"，选了排队就得让排队可见。
       * 所以这里维护一个队列深度，渲染成标题行的「排队中 N 条」，
       * 并在容器上暴露 `data-queued` 供验收直接读。
       */
      setQueueDepth((n) => n + 1);
      askQueue.current = askQueue.current.then(async () => {
        setAgent({ open: true, finalText: question, partial: "" });
        try {
          await ask(question, runtimeRef.current, "mic");
        } catch (error) {
          console.warn("[xiaomu] 命令执行失败", error);
          setAgent({ agentState: "ERROR", stateNote: `执行失败：${String(error)}` });
        } finally {
          setQueueDepth((n) => Math.max(0, n - 1));
        }
      });
    };
    window.addEventListener("mumai:xiaomu-ask", onAsk);
    return () => window.removeEventListener("mumai:xiaomu-ask", onAsk);
  }, []);

  /**
   * 开发期调试句柄（`window.__mumaiAsk`）：直接驱动 `ask()`。
   *
   * ── 为什么需要它（不是为了方便，是因为**没有它就没法端到端验证**）──
   * 「说小木小木 + 关键词 → 播对应台词」这条链路，我原本只能在单测里验证到
   * `routeUtterance`（纯路由判定）那一层 —— `ask()` 所在的 executor.ts 导入链没写
   * `.ts` 扩展名，Node 原生 ESM 解析不了，单测进不去；而浏览器里 CDP 派发的输入事件
   * 登录后收不到（工装问题），也驱不动。
   * 有了这个句柄，工装可以**绕开输入模拟**、直接走唤醒通道那一行调用
   * （`ask(question, runtime, "mic")`），把"唤醒事件 → 应答 → 会话流"整条链路跑完。
   *
   * ⚠ 只在开发构建暴露（`import.meta.env.DEV`），与既有的 `window.__mumaiWake`、
   * `window.__mumaiAgent` 同一口径；生产构建里这段是死代码。
   */
  useEffect(() => {
    if (!import.meta.env?.DEV) return undefined;
    const handle = {
      /** 与唤醒链路完全相同的调用方式 */
      ask: (text: string) => ask(text, runtimeRef.current, "mic"),
      /** 直接派发唤醒事件，走真实监听器 */
      fire: (text: string) => {
        window.dispatchEvent(new CustomEvent("mumai:xiaomu-ask", { detail: { question: text, interactionId: nextInteractionId() } }));
      },
    };
    (window as unknown as Record<string, unknown>).__mumaiAsk = handle;
    return () => { delete (window as unknown as Record<string, unknown>).__mumaiAsk; };
  }, []);

  /**
   * 用户主动再打开一次（点形象 / Alt+E）时清掉「已确认」。
   *
   * 否则会有个反直觉的表现：错误被 × 掉之后，用户点形象想再看看小木，
   * 面板里却没有那条错误了 —— 而那正是他此刻想看的东西。
   */
  const reopen = useCallback(() => {
    setDismissedWakeError(null);
    setExpanded(true);
  }, []);

  /* ---------- 关闭：统一入口 ---------- */
  const close = useCallback(() => {
    setExpanded(false);
    /*
     * 记下"这条通道错误我看过了"。
     *
     * 只关显示层：常驻唤醒仍然在后台重连（FR-08 要求关气泡不释放麦克风），
     * 用户想停重连要点「关闭常驻唤醒」——所以这里**不**去动 wakeChannel。
     */
    setDismissedWakeError(errorSignatureRef.current);
    /**
     * 关闭后把焦点还回去（FR-08 最后一条；键控无障碍探针 C6 抓到过）。
     *
     * 原来关闭后 `document.activeElement` 掉到 `BODY`：键盘用户按 Esc 或点关闭之后，
     * 焦点丢失，接着按 Tab 要**从头开始**走一遍整页才能回到原来的位置。
     * 做法是记住"面板出现之前焦点在谁身上"，关闭时还给它；记不到就还给形象按钮
     * （它是小木的常驻入口，永远是合理的落点）。
     */
    const target = focusReturnRef.current;
    focusReturnRef.current = null;
    window.setTimeout(() => {
      const candidate = (target && document.contains(target) ? target : avatarRef.current) as HTMLElement | null;
      candidate?.focus?.();
    }, 0);
    /**
     * 走统一入口 `closeAgent()`（FR-08 / AC-04）。
     *
     * 不能在本地直接 `setAgent({open:false})` —— 那样 standalone 控制台不会被卸载，
     * 全屏遮罩会留在 DOM 里拦截页面点击（这是已经复现并修过的缺陷）。
     * 本组件与全屏控制台共用同一个 store，所以关闭也必须共用同一条路径。
     *
     * 停播报 / 取消未确认的高风险 / 作废执行中的这一轮，**都不在这里做** ——
     * 它们已经收敛到 `mumai:agent-close` 的统一处理里（api.tsx）。放两份的代价
     * 是实测过的：程序化关闭那条入口漏掉了停播报，播报会在"关掉之后"又响起来。
     *
     * 注意：这里**只关显示层**。常驻唤醒由 wakeChannel 自己管，
     * 关气泡不会释放麦克风（FR-08）—— 用户要停的是"看见的东西"，不是"在听这件事"。
     */
    closeAgent();
  }, []);

  /**
   * 键控编排（本次新增，按操作逻辑分组，不是随手挑几个键）。
   *
   * 分组依据是"用户此刻想干什么"：
   *   · 想说话       → Alt+W 开关常驻唤醒（Wake）
   *   · 想让它闭嘴   → Esc   停止播报并收起气泡（最常用的打断）
   *   · 想看详情     → Alt+E 展开/收起历史（Expand）
   *   · 想重看上一句 → Alt+R 重播主回答（Replay）
   *   · 想重新说     → Alt+M 重开麦克风（Mic）
   * 刻意**不使用单键**（除了 Esc）：单键会和页面上的输入框、地图快捷键打架。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        /**
         * 页面里有别的模态框开着时**不抢 Esc**。
         *
         * ── 这里原来有个真 bug，值得写清楚（AC-04 的一次 Esc 关掉两个东西）──
         * 最早的写法是在**冒泡阶段**监听，然后当场查一次"有没有别人的模态框"。
         * 看起来对，实际不可靠：本 effect 的依赖数组里有 `expanded`，
         * 按过 Alt+E 之后它会把监听器**重新注册**一遍 —— 于是气泡的监听器
         * 排到了页面 Modal 的监听器**后面**。一次 Esc 的执行顺序变成：
         *   ① Modal 的监听器先跑 → 弹窗关掉、`aria-modal` 节点从 DOM 消失；
         *   ② 气泡的监听器再跑 → 再查"有没有别人的模态框"已经查不到了 → 把自己也关了。
         * 实测证据（诊断-Esc冲突.mjs）：`mumai:agent-close` 的调用栈落在
         * `XiaomuDock.onKey`，而同一时刻捕获阶段记到的 `foreignModals=1`。
         *
         * 修法两点，缺一不可：
         *   · 改到**捕获阶段**监听 —— 捕获一定早于任何冒泡监听器，
         *     不再依赖"谁先注册"，判据才是确定的；
         *   · 用共享判据 `hasForeignModal()`（与全屏控制台同一份），
         *     避免两处各写一套、各自漂移。
         * 注意只 return、**不 stopPropagation**：让事件继续走到 Modal 那边，
         * 用户的意图是"关掉眼前那个对话框"，那个还得照关。
         */
        if (hasForeignModal()) return;
        /**
         * 全屏诊断台正开着时，Esc 归它 —— 它是更上面的一层。
         *
         * 两层共用同一个 store 的 `open`，所以"谁都不让路"时一次 Esc 会把两层一起关掉
         * （键控无障碍探针 B3 实测：控制台=true 气泡=true → 按一次都变成 false）。
         * 用户此刻看到的是全屏控制台，意图是"关掉眼前这层"；
         * 气泡该保持原样（它自己还有 Alt+E 的展开态，下一按再关它）。
         */
        if (typeof document !== "undefined" && document.querySelector(".vc-root")) return;
        if (!agent.open && !expanded) return;
        event.preventDefault();
        close();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      /**
       * 按住不放会连续触发 keydown（`repeat`），Alt+R 会变成狂暴重播 —— 必须挡。
       *
       * ── 这里原来还有一条"焦点在输入框里就不响应"，已经删掉 ──────────
       * 原来的理由是"alt 组合在部分布局下会往输入框里打字符"。实测与规范都对不上：
       *   · AltGr（真正的"打字符"用法）在 Windows 上是 **Ctrl+Alt**，
       *     上面那行 `event.ctrlKey` 已经把它排除了；
       *   · 纯 Alt+字母 在 Chrome/Windows 下不会产生文本输入。
       * 而这条守卫的代价很具体（键控无障碍探针 B1/B1b 实测）：用户在助手输入框里
       * 打字时按 Alt+W/Alt+E **毫无反应** —— 全局快捷键"看起来是坏的"，
       * 这比"可能打出字符"更糟，而后者在剔除 AltGr 之后并不会发生。
       * 所以现在：**Alt 组合键与焦点无关，一律生效**；Esc 仍走上面那条让路逻辑。
       */
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "w") {
        event.preventDefault();
        const channel = wakeChannel();
        if (channel.currentState === "live") channel.stop();
        else void channel.start();
      } else if (key === "e") {
        event.preventDefault();
        if (expanded) close();
        else reopen();
      } else if (key === "r") {
        event.preventDefault();
        const turn = latestBotTurn(agent.turns);
        if (turn) runtimeRef.current.speak(turn.text);
      } else if (key === "m") {
        event.preventDefault();
        /**
         * 「重新听」：`start()` 在已经是 live 时是空操作，所以还得 `resume()`。
         * 否则用户在"命令已交出去、推流暂停"的那 2.5 秒里按 Alt+M 会毫无反应 ——
         * 而"重新听"这个动作最需要立刻生效的恰恰是那一刻。
         */
        void wakeChannel().start();
        wakeChannel().resume();
      }
    };
    /** 捕获阶段监听：Esc 的让路判据必须早于页面 Modal 的冒泡监听器（见上面的根因说明） */
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [agent.open, agent.turns, expanded, close, reopen]);

  /* ---------- 状态推导 ---------- */
  /**
   * 状态优先级（**顺序本身就是设计**，改之前先想清楚）：
   *
   *   1. 等确认     —— 用户此刻必须做决定，别的都不重要
   *   2. 出错       —— 包括"音频通道断了"，必须压过一切"看起来正常"的状态
   *   3. 播报中     —— 执行器的 RESPONDING
   *   4. 思考中     —— 理解/规划/执行/等工具
   *   5. 识别中
   *   6. 正在听     —— `collecting` 优先于 `partial`：
   *                    collecting 在唤醒那一刻就为真，而 partial 要等音频攒够；
   *                    用 partial 当判据会让唤醒后有近一秒显示「待机」。
   *   7. 待机
   *
   * ⚠ 踩过的坑：初版把「有 partial 就算正在听」放在「思考中」**前面**，
   * 于是小木已经在执行了，徽标还写着「正在听」（字幕要等 command 事件才清）。
   * 现在 collecting / partial 都排在思考之后。
   */
  const dockState: DockState = useMemo(() => {
    if (agent.pendingConfirm) return "confirming";
    // 通道断了、连不上、出错：界面上必须是"出错"，不能显示成待机或正在听
    if (wake.state === "error" || wake.state === "reconnecting") return "error";
    if (agent.agentState === "ERROR") return "error";
    if (agent.agentState === "RESPONDING") return "speaking";
    if (agent.agentState === "THINKING") return "thinking";
    if (
      agent.agentState === "UNDERSTANDING" ||
      agent.agentState === "PLANNING" ||
      agent.agentState === "EXECUTING" ||
      agent.agentState === "WAITING_TOOL"
    ) {
      return "thinking";
    }
    if (agent.agentState === "RECOGNIZING") return "recognizing";
    /*
      ⚠ `LISTENING` 原来没被映射，于是**脚本化模拟**（剧本快捷键 Ctrl+B/Y/M+数字、示例问句）
      期间徽标一直写「待机」—— 逐字字幕已经出来了，状态却像什么都没发生。
      `wake.state === "live"` 那条只覆盖**真实唤醒**（那时才有通道），脚本化输入没有通道，
      所以必须在这里按 `agentState` 补上。放在 `RECOGNIZING` 之后，
      "正在收尾识别"优先于"正在听"，与真实链路的先后一致。
    */
    if (agent.agentState === "LISTENING") return "listening";
    if (wake.state === "live" && (wake.collecting || wake.partial)) return "listening";
    return "idle";
  }, [agent.agentState, agent.pendingConfirm, wake.collecting, wake.partial, wake.state]);

  const query = latestUserText(agent.turns);
  const turn = latestBotTurn(agent.turns);
  const reply: ReplyView | null = useMemo(() => (turn ? buildReplyView(turn, query) : null), [turn, query]);

  /**
   * 什么时候显示气泡面板。
   *
   * ⚠ 这里踩过一个坑：初版写成 `agent.open || expanded || dockState !== "idle" || Boolean(reply)`，
   * 结果**关不掉** —— 回复会一直留在会话流里，`reply` 永远非空，于是面板永远可见。
   * 实测现象就是"点了关闭按钮，气泡还在"。
   *
   * 正确判据只应包含"此刻正在交互"与"用户显式展开历史"：
   *   · `agent.open`  —— 本轮交互由程序发起（唤醒/串口/命令式打开）
   *   · `active`      —— 正在听/识别/思考/播报/等确认/出错，这些必须看得见
   *   · `expanded`    —— 用户点了形象，想回看上一轮
   * 关闭后三者都为假，面板就该消失；历史仍然留在 store 里，点一下形象就能回看。
   */
  /**
   * 通道错误是否已经被用户按 × 确认过。
   *
   * `errorSignature` 为 null 表示当前没有通道错误（那时这条判据不参与）。
   * 这一条只影响**错误态**：正在听 / 思考 / 播报 / 等确认一律照旧显示。
   */
  const errorSignature = useMemo(() => {
    if (wake.state !== "error" && wake.state !== "reconnecting") return null;
    /*
     * 用 `stableNote` 归一化后再当签名。
     *
     * 直接用 `wake.note` 会漏：它带着退避参数（「8000ms 后第 9 次重试」），
     * 后台每重试一次文本就变一次 —— 用户按 × 记下的签名与下一轮的签名对不上，
     * 「已确认」当场失效，面板又被顶回来（这就是"关掉还是弹出来"的根因）。
     * 归一化后，「重连中」无论重试多少次都是同一条；换了原因（比如变成
     * 「麦克风权限被拒绝」）签名才变，仍会照常提示。
     */
    return `${wake.state}|${stableNote(wake.note ?? "")}`;
  }, [wake.state, wake.note]);
  errorSignatureRef.current = errorSignature;
  const wakeErrorDismissed = errorSignature !== null && errorSignature === dismissedWakeError;
  const active = dockState !== "idle" && !wakeErrorDismissed;
  const visible = agent.open || expanded || active;

  /**
   * 唤醒应答：判定唤醒后先回一句「我在」，用户再继续说命令。
   *
   * ── 判据为什么是 wakeCount 变化，而不是 lastWake 不为空 ──────────
   * `lastWake` 是**有值就一直在**（上一轮的唤醒信息会保留），拿它当条件会变成
   * "每次重渲染都播一遍"。`wakeCount` 只在服务端判定唤醒时自增
   * （`wakeChannel.ts` 的 `this.wakeCount += 1`），"计数变了"才等于"这一次唤醒"。
   *
   * ── 为什么不用 Agent state 驱动 ────────────────────────────────
   * 唤醒应答要在**命令还没说完**时就出声（PRD §9：唤醒到可见反馈 ≤800ms），
   * 而 Agent 状态是命令识别之后才动的 —— 挂在唤醒通道上才赶得上。
   *
   * 气泡已收起（`visible` 为假）时不播：用户已经把形象收起来了。
   *
   * 依赖里必须**同时**写 `visible`：少了它，唤醒发生时闭包里读到的是旧值
   * （气泡明明收着却出声，或者反过来）；判断用的是「计数变了」这个 ref 闸门，
   * 所以多跟一个 `visible` 也不会变成"每次重渲染都播"。
   */
  const wakeRepliedRef = useRef(wakeChannel().wakeCountValue);
  useEffect(() => {
    if (wake.wakeCount === wakeRepliedRef.current) return;
    wakeRepliedRef.current = wake.wakeCount;
    if (!visible) return;
    void outputRef.current?.speak(WAKE_REPLY_TEXT).catch(() => {
      /* 播报失败不阻断交互：语音包缺失时 VoiceOutput 自己会回退合成音 */
    });
  }, [wake.wakeCount, visible]);

  /**
   * 焦点归还用的两个 ref（见 close() 里的说明）：
   *   · `avatarRef`     —— 兜底落点：小木的常驻入口，永远存在
   *   · `focusReturnRef` —— 面板出现**之前**焦点在谁身上，关闭时还给它
   */
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnRef = useRef<Element | null>(null);

  /* ------------------------------------------------------------------ *
   * 拖拽 · 实时缩放（逻辑在 XiaomuStage.ts，纯函数已单测）
   *
   * 为什么把"位置/尺寸"放在 `.xd` 根节点上：
   *   `.xd__panel`（对话框）是这个根节点的子元素、绝对定位贴着形象。
   *   所以移动/缩放根节点，**形象与对话框自然一起动、一起限界** ——
   *   这正是用户要的"绑定在一起拖动"，不需要额外同步两套坐标。
   * ------------------------------------------------------------------ */
  const dockRef = useRef<HTMLDivElement | null>(null);
  /* 记忆只在挂载时读一次：之后以组件内的 state 为准，避免与拖动过程互相打架 */
  const initialStage = useMemo(() => readStageMemory(), []);
  const [stagePos, setStagePos] = useState<StagePos | null>(initialStage.pos);
  const [size, setSize] = useState<number>(initialStage.size || defaultSizeForViewport(typeof window === "undefined" ? 0 : window.innerHeight));
  const [gesture, setGesture] = useState<null | "drag" | "resize">(null);

  /* 手势过程的中间量放 ref：它们每帧都在变，放 state 会让整棵树每帧重渲染 */
  const gestureRef = useRef<{
    mode: "drag" | "resize";
    x: number;
    y: number;
    startRight: number;
    startBottom: number;
    startSize: number;
  } | null>(null);

  /** 面板的实际尺寸（限界要用它算并集）；面板没开时为 null */
  const panelSizeOf = useCallback((): { width: number; height: number } | null => {
    const panel = dockRef.current?.querySelector(".xd__panel");
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
  }, []);

  /** 当前位置：没有用户位置时用 CSS 里那套默认锚点（right 24 / bottom 120） */
  const effectivePos = useCallback((): StagePos => {
    const base: StagePos = stagePos ?? { right: 24, bottom: 120 };
    const vw = window.innerWidth, vh = window.innerHeight;
    return clampPos(base, { size }, panelSizeOf(), vw, vh);
  }, [stagePos, size, panelSizeOf]);

  const applySize = useCallback((next: number) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = Math.min(maxSizeForViewport(vw, vh), clampSize(next));
    setSize((prevSize) => {
      setStagePos((prev) => {
        const base: StagePos = prev ?? { right: 24, bottom: 120 };
        return clampPos(resizeKeepingTopLeft(base, prevSize, s), { size: s }, panelSizeOf(), vw, vh);
      });
      return s;
    });
    writeStageMemory({ pos: stagePos, size: s });
  }, [panelSizeOf, stagePos]);

  const beginGesture = useCallback((mode: "drag" | "resize") => (e: React.PointerEvent) => {
    const pos = effectivePos();
    gestureRef.current = {
      mode, x: e.clientX, y: e.clientY,
      startRight: pos.right, startBottom: pos.bottom, startSize: size,
    };
    setGesture(mode);
    /* 指针捕获：手指/鼠标移出元素后仍然收得到 move，这是 Pointer Events 的关键一步 */
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, [effectivePos, size]);
  const beginDrag = useMemo(() => beginGesture("drag"), [beginGesture]);
  const beginResize = useMemo(() => beginGesture("resize"), [beginGesture]);

  /* move/up 挂在 window 上：即使指针跑出形象、或者中途捕获丢失，手势也不会卡住 */
  useEffect(() => {
    if (!gesture) return undefined;
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (g.mode === "drag") {
        /**
         * 拖动倾斜：左右移动时形象微微侧身，最大 ±5°。
         *
         * 角度写进 CSS 变量而不是直接改 transform —— 形象上挂着一整套状态动画
         * （`xd-idle` / `xd-listen` / … 都在动 transform），直接写 inline transform 会被
         * 动画覆盖，而变量能让 CSS 用 `.xd--dragging` 这一个开关统管两条规则：
         * 拖动期间 `animation: none` 停掉状态动画，再由变量做 rotate。
         */
        const tilt = Math.max(-5, Math.min(5, dx * 0.08));
        if (dockRef.current) {
          dockRef.current.style.setProperty("--drag-tilt", String(tilt));
        }
        setStagePos(clampPos(
          posFromDrag({ right: g.startRight, bottom: g.startBottom, x: g.x, y: g.y }, dx, dy),
          { size: g.startSize }, panelSizeOf(), window.innerWidth, window.innerHeight,
        ));
      } else {
        const next = sizeFromResize(g.startSize, dx, dy, window.innerWidth, window.innerHeight);
        setSize(next);
        /*
          缩放时**保持左上角不动**（用户口径："右下角拖动之后是向左上角缩放"）：
          位置以右下角为锚，直接改尺寸会表现为"往左上长"。
          先用 `resizeKeepingTopLeft` 把左上角钉住，再做并集夹取。
        */
        setStagePos(clampPos(
          resizeKeepingTopLeft({ right: g.startRight, bottom: g.startBottom }, g.startSize, next),
          { size: next }, panelSizeOf(), window.innerWidth, window.innerHeight,
        ));
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      gestureRef.current = null;
      setGesture(null);
      /**
       * 松手必须**清掉倾斜**。
       *
       * 不清的后果实测过：`.xd[style*="--drag-tilt"]` 这条选择器在拖完之后依然命中 ——
       * 形象会**永久歪着**，而且一直带着 `scale(1.02)`，看着像"卡住了"。
       * 这里连同 `--drag-tilt` 一起把 inline 样式清空，CSS 那两条规则随之失效。
       */
      if (dockRef.current) {
        dockRef.current.style.removeProperty("--drag-tilt");
      }
      /* 手势结束时才写记忆：拖动过程中每帧写 localStorage 会明显掉帧 */
      if (g) setStagePos((cur) => { writeStageMemory({ pos: cur, size: g.mode === "resize" ? size : g.startSize }); return cur; });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gesture, panelSizeOf, size]);

  /* 视口尺寸变化（拖窗口、转屏）时重新夹取：否则元素可能整块留在屏幕外 */
  useEffect(() => {
    const onResize = () => {
      setStagePos((prev) => {
        const base: StagePos = prev ?? { right: 24, bottom: 120 };
        return clampPos(base, { size }, panelSizeOf(), window.innerWidth, window.innerHeight);
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size, panelSizeOf]);

  const dragging = gesture === "drag";
  const resizing = gesture === "resize";

  useEffect(() => {
    if (visible) {
      // 只在"从不可见变可见"的那一刻记一次，避免把面板内部的焦点也记进去
      if (!focusReturnRef.current) focusReturnRef.current = document.activeElement;
    }
  }, [visible]);

  const listening = wake.state === "live";

  return (
    <div
      ref={dockRef}
      className={`xd${visible ? " is-open" : ""}${dragging ? " xd--dragging" : ""}${resizing ? " xd--resizing" : ""}`}
      data-state={dockState}
      data-interaction-id={agent.interactionId || ""}
      data-queued={queueDepth}
      /*
        位置与尺寸由内联样式驱动（`clampPos` 的结果）。
        CSS 里那套 `right: 24px; bottom: 120px` 保留为**默认值** ——
        用户没调整过时内联样式与它一致，读起来也是同一处语义。
      */
      style={{
        right: `${effectivePos().right}px`,
        bottom: `${effectivePos().bottom}px`,
        /* 形象尺寸由变量下发，`.xd__avatar` 的 width/height 读它 */
        ["--xd-size" as string]: `${size}px`,
      }}
    >
      {visible ? (
        <section className="xd__panel" role="region" aria-label="小木对话">
          <header className="xd__head">
            <span className="xd__state">
              <i className="xd__dot" aria-hidden="true" />
              {DOCK_STATE_LABEL[dockState]}
            </span>
            <span className="xd__intent" title="命中的意图 / 队列">
              {/*
                队列可见性文案用「待处理 N 条」而不是「排队中 N 条」：
                N 是**在处理 + 在排队**的总数（当前一条跑完才轮到下一条），
                说成"排队中"会把正在执行的那条也算进去，读数就不准了。
              */}
              {queueDepth > 0 ? `待处理 ${queueDepth} 条` : reply?.intentId ?? (listening ? "常驻唤醒已开" : "待命")}
            </span>
            {/*
              「一条龙」走到第几条（用户口径 2026-09-17：「ctrl加shift加z，25个对话循环播放，
              按一下播放一个」）。这一格只在用一条龙键走流程时出现：
              按一下就走一条，走到第几条必须看得见 —— 否则那一条正在思考时，
              演示人分不清"没按上"还是"已经在走"。
            */}
            {agent.walk ? (
              <span className="xd__walk" title="一条龙：按一下走一条，走完 25 条回到第 1 条">
                一条龙 {agent.walk.index + 1}/{agent.walk.total}
              </span>
            ) : null}
            <button type="button" className="xd__icon-btn" onClick={close} aria-label="关闭小木（Esc）" title="关闭（Esc）">
              ×
            </button>
          </header>

          {/*
            用户流式字幕：定稿前就地更新，不重复新增气泡（FR-07）。

            ⚠ 三个来源的优先级不能少任何一个（2026-09-17 用户实测报的 bug）：
              1. `wake.partial` —— **真实唤醒**的流式字幕，来自唤醒通道；
              2. `query`        —— 已入库的整句（`agent.turns` 里的用户轮次）；
              3. `agent.partial`—— **脚本化模拟**的流式字幕（剧本快捷键 Ctrl+B/Y/M+数字、
                                   「示例问句」都走 `VoiceInput.simulate()`，写的是这里）。

            缺了第 3 条会怎样：`simulate()` 每个字都在跑（实测 onPartial len=1..17 连续），
            但气泡里**没有任何元素渲染 `agent.partial`** —— 屏幕上就是"小木没反应，
            过一会儿突然接收到一整句话"，正是用户报的现象。
            全屏控制台（`VoiceConsole`）本来就读 `state.partial`，所以那条路径一直正常，
            只有气泡这条一直缺这个出口。
          */}
          {wake.partial || query || agent.partial ? (
            <p className="xd__user">{wake.partial || query || agent.partial}</p>
          ) : null}

          {agent.pendingConfirm ? (
            <div className="xd__confirm" role="alertdialog" aria-label="高风险操作确认">
              <b>{agent.pendingConfirm.title}</b>
              <p>{agent.pendingConfirm.detail}</p>
              <div className="xd__confirm-actions">
                <button type="button" className="xd__btn xd__btn--danger" onClick={() => resolveConfirm(true)}>
                  确认执行
                </button>
                {/*
                  按钮文字固定是「取消」（与全屏控制台一致）。
                  原来用的是 `cancelText`，而那是**取消之后的说明文案**
                  （「已取消，未执行任何动作。」），把它当按钮标签会很怪 ——
                  用户看到的按钮写着"已取消"，像是已经点过了。
                */}
                <button type="button" className="xd__btn" onClick={() => resolveConfirm(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {reply ? (
            <div className="xd__reply">
              {/* 主回答：**永不折叠**，归档/非实时声明就在它里面 */}
              <p className="xd__answer">{reply.mainAnswer}</p>

              {reply.facts.length ? (
                <div className="xd__fold">
                  <button
                    type="button"
                    className="xd__fold-btn"
                    aria-expanded={factsOpen}
                    onClick={() => setFactsOpen((value) => !value)}
                  >
                    业务状态 {reply.facts.length} 项 {factsOpen ? "▾" : "▸"}
                  </button>
                  {factsOpen ? (
                    <dl className="xd__facts">
                      {reply.facts.map((fact) => (
                        <div key={fact.k}>
                          <dt>{fact.k}</dt>
                          <dd>{fact.v}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              ) : null}

              {reply.sources.length ? (
                <div className="xd__fold">
                  <button
                    type="button"
                    className="xd__fold-btn"
                    aria-expanded={sourcesOpen}
                    onClick={() => setSourcesOpen((value) => !value)}
                  >
                    资料引用 {reply.sources.length} 条 {sourcesOpen ? "▾" : "▸"}
                  </button>
                  {sourcesOpen ? (
                    <ul className="xd__sources">
                      {reply.sources.map((source) => (
                        <li key={source.chunkId}>
                          <button
                            type="button"
                            className="xd__source"
                            onClick={() => {
                              /**
                               * 点击引用：展开原文片段（就地看"引的是哪句话"）
                               * 并跳到知识库对应文档（PRD FR-05「点击后打开现有知识库
                               * 原文位置或至少打开对应知识文档」）。
                               *
                               * 先展开再跳转：跳走之后气泡可能已卸载，
                               * 用户回来时至少还能看到上次引用的原文。
                               */
                              setOpenSource((id) => (id === source.chunkId ? null : source.chunkId));
                              navigate(source.route);
                            }}
                            title={`打开知识库：${source.title}（${source.locator}）`}
                          >
                            <b>{source.title}</b>
                            <span className="xd__locator">{source.locator}</span>
                          </button>
                          {openSource === source.chunkId ? <p className="xd__excerpt">{source.excerpt}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {/* 本轮实际生成时间（来自 turn.at，不是渲染时刻） */}
              <footer className="xd__foot">
                <time>{reply.at}</time>
                <span>{reply.voice}</span>
                {reply.level !== "rule" && reply.confidence > 0 ? <span>置信度 {reply.confidence.toFixed(3)}</span> : null}
                <button type="button" className="xd__link" onClick={() => runtimeRef.current.speak(reply.mainAnswer)}>
                  重播（Alt+R）
                </button>
              </footer>
              {reply.note ? <p className="xd__note">{reply.note}</p> : null}
            </div>
          ) : null}

          <footer className="xd__bar">
            <button
              type="button"
              className={`xd__btn xd__btn--wake${listening ? " is-live" : ""}`}
              /*
                ⚠ 浏览器根本不给麦克风时（内网 http 不是安全上下文）**直接置灰**：
                用户口径 2026-09-17「为什么我点击开启常驻唤醒就报错」—— 点了才报错，
                不如一开始就不能点，并把原因写在 title 与下面那行说明里。
                注意"权限被拒"是**另一种**情况（`mediaDevices` 在、只是没授权）：
                那种仍然让点，点完由 `wakeErrorHint` 告诉用户去哪把权限改回来。
              */
              disabled={!micOk}
              onClick={() => {
                const channel = wakeChannel();
                if (channel.currentState === "live") channel.stop();
                else void channel.start();
              }}
              title={
                micOk
                  ? "常驻唤醒：说两遍「小木小木」即可唤起（Alt+W 开关）。关掉气泡不会关掉它。"
                  : "这台机器的浏览器不给麦克风（内网 http 不是安全上下文）—— 唤醒用不了，请用下面「快捷键一览」里的键"
              }
            >
              {listening ? "常驻唤醒：已开" : micOk ? "开启常驻唤醒" : "这台机器不能开麦"}
            </button>
            <span className="xd__hint">两遍「小木小木」 → 停一下 → 说命令</span>
          </footer>

          {/*
            ── 快捷键一览（用户口径 2026-09-17）─────────────────────────
            「小木呢，别人内网登上去也得能用快捷键呼唤出来相应对话」。
            键位表原来只在代码和主机上的一份 md 里，内网另一台机器登进来的人看不到，
            于是"能用"变成"不会用"。这里把表放进气泡：任何机器、任何账号都看得到，
            数据源是条目表 + 剧本（`shortcutSheet.ts`），不手抄一行字。

            ⚠ 麦克风那行是**必须说的实话**：浏览器只在 https 或 localhost 下暴露
              `navigator.mediaDevices`，同事用内网 IP + http 打开时唤醒是用不了的，
              不写清楚就会被当成"小木坏了"。
          */}
          <div className="xd__keys-wrap">
            <button
              type="button"
              className="xd__fold-btn"
              aria-expanded={keysOpen}
              onClick={() => setKeysOpen((value) => !value)}
            >
              快捷键一览 · {sheetRows.length} 条（Ctrl+B/Y/M）{keysOpen ? "▾" : "▸"}
            </button>
            {/*
              一条龙：完整走一遍流程时**不用记 25 个键位**（用户口径 2026-09-17：
              「专门搞一个组合键用于完整走完流程。ctrl加shift加z，25个对话循环播放，
              按一下播放一个」）。键位文本来自唯一实现，页面上不手写一行字。
            */}
            <p className="xd__note xd__note--walk">{walkShortcutNote(sheetRows.length)}</p>
            {wake.state === "error" ? (
              /*
                ── 唤醒出错时，把**原因和怎么办**写在气泡里 ──────────────────
                用户 2026-09-17 实测报的：「为什么我点击开启常驻唤醒就报错」。
                实测复现：没给麦克风权限时徽标变成「出错了」，而界面上只有一句
                与原因无关的「音频链路当前不在线…」—— 真正的原因只打在控制台里。
                这里把 `wakeChannel` 记的原因翻成一句可操作的话（见 `wakeErrorHint`），
                放在快捷键一览的正上方：出错了先看这里，看不行就照着下面按。
              */
              <p className="xd__note xd__note--wake-error">{wakeErrorHint(wake.note ?? "")}</p>
            ) : null}
            {!micOk ? (
              <p className="xd__note">
                本机浏览器不允许用麦克风（内网 http 的安全限制，只有本机 localhost 或 https 才行）——
                唤醒与语音输入在这台机器上用不了；上面这张表里的快捷键**照样能唤出每一轮对话**。
              </p>
            ) : null}
            {keysOpen ? (
              <ol className="xd__keys">
                {sheetRows.map((row) => (
                  <li key={row.index}>
                    <b>{row.keys}</b>
                    <span className="xd__keys-round">{row.round}</span>
                    <span className="xd__keys-how">{row.how}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 形象本体：始终在场，点它展开/收起 */}
      <button
        type="button"
        ref={avatarRef}
        className="xd__avatar"
        /*
          按住形象 = 拖动（用户口径：「允许拖拽，虚拟形象和对话框绑定在一起拖动」）。
          单击仍然展开/收起 —— 两者靠"是否移动过"区分：Pointer 事件里
          位移小于阈值时不会阻止 click，所以点一下照旧生效。
        */
        onPointerDown={beginDrag}
        /* 位图会被浏览器当成可拖拽内容，起手就触发原生 drag，必须屏蔽 */
        onDragStart={(e) => e.preventDefault()}
        /**
         * 点形象 = 显式的"收起 / 展开"，语义要与**面板此刻是否真的可见**一致。
         *
         * ── 两处踩过的坑 ────────────────────────────────────────────────
         * ① `aria-expanded` 原来根本没有（键控无障碍探针 C4）：读屏用户
         *    无论面板开着还是关着，听到的都是"点击展开"。
         * ② 补上之后第一版写成 `aria-expanded={expanded}`（本地展开态），
         *    又不对：面板可能因为**本轮交互正在显示**（`agent.open`）而可见，
         *    那时 `expanded` 是 false —— 属性说"没展开"、屏幕上面板却开着。
         *    所以判据必须是 `visible`（面板可见性的唯一来源，见上面的推导）。
         * ③ 对应的点击行为也要跟上：面板可见时点它应当**收起**（走统一关闭），
         *    而不是把 `expanded` 翻成 true 之后屏幕毫无变化 —— 那正是
         *    "按了没反应"的另一种形态。
         */
        onClick={() => {
          if (visible) close();
          else reopen();
        }}
        aria-expanded={visible}
        aria-label={`小木（${DOCK_STATE_LABEL[dockState]}），${visible ? "点击收起" : "点击展开"}`}
        title={`小木 · ${DOCK_STATE_LABEL[dockState]}（点击${visible ? "收起" : "展开"}，Esc 关闭）`}
      >
        {/*
          形象本体是 `XiaomuFace`：**七状态各一张带 alpha 的位图帧**（v2），状态由本组件的 `dockState` 传入。

          原来这里是一张静态素材 + 一圈会呼吸的光环，七个状态在形象上看不出差别：
          图片里没有可以被单独选中的眼、眉、嘴，所以"状态"只能靠整张图晃一晃
          和徽标文字表达。用户要的是"小木有具体的表情"，那就必须把五官画成元素。
          素材本身没动 —— AppShell 的浮标与 SmallWoodPanel 还在用同一个 id。

          状态**没有**再往下传一层 props：`.xd` 根节点上的 `data-state` 已经是
          唯一来源，脸内部用 `.xd[data-state=…] .xf__…` 选择器取用（见 xiaomuDock.css）。
        */}
        <XiaomuFace state={dockState} />
        <span className="xd__ring" aria-hidden="true" />
        {/* 状态文字始终存在：关掉动效后仍能靠它分辨状态（FR-06） */}
        <span className="xd__badge">{DOCK_STATE_LABEL[dockState]}</span>
      </button>

      {/*
        右下角的小把手：实时调大小（用户口径：「右下角做一个小按钮用来实时调整大小」）。
        用 `aria-label` 说明它是做什么的；键盘用户也能用（←/→ 调整，见 onKeyDown）。
        它只在形象上，不在对话框上 —— 对话框的尺寸不该被这个把手改（那是另一个需求）。
      */}
      <button
        type="button"
        className="xd__grip"
        aria-label="拖动可调整小木大小"
        title="拖动调整大小（←/→ 微调）"
        onPointerDown={beginResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const next = clampSize(size + (e.key === "ArrowRight" ? 8 : -8));
            applySize(next);
          }
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M1 11 L11 1 M5 11 L11 5 M9 11 L11 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </svg>
      </button>
      {(dragging || resizing) && <span className="xd__size-tip">{size}px</span>}
    </div>
  );
}



