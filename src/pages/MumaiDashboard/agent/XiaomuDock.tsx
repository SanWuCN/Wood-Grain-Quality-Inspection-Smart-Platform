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
import { Illustration } from "../illustrations";
import { ask, type Runtime } from "./executor";
import { closeAgent, hasForeignModal, nextInteractionId } from "./api";
import { useAgentNavigate, useAgentSession } from "./agentSession";
import { getAgentState, resolveConfirm, setAgent, subscribeAgent } from "./store";
import { wakeChannel, type WakeSnapshot } from "./wakeChannel";
import { buildReplyView, latestBotTurn, latestUserText, type ReplyView } from "./replyView";
import { VoiceOutput } from "./tts";
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
  const [factsOpen, setFactsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [openSource, setOpenSource] = useState<string | null>(null);

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
         */
        void outputRef.current?.speak(text);
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

  /* ---------- 关闭：统一入口 ---------- */
  const close = useCallback(() => {
    setExpanded(false);
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
        setExpanded((value) => !value);
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
  }, [agent.open, agent.turns, expanded, close]);

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
    if (
      agent.agentState === "UNDERSTANDING" ||
      agent.agentState === "PLANNING" ||
      agent.agentState === "EXECUTING" ||
      agent.agentState === "WAITING_TOOL"
    ) {
      return "thinking";
    }
    if (agent.agentState === "RECOGNIZING") return "recognizing";
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
  const active = dockState !== "idle";
  const visible = agent.open || expanded || active;

  /**
   * 焦点归还用的两个 ref（见 close() 里的说明）：
   *   · `avatarRef`     —— 兜底落点：小木的常驻入口，永远存在
   *   · `focusReturnRef` —— 面板出现**之前**焦点在谁身上，关闭时还给它
   */
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnRef = useRef<Element | null>(null);
  useEffect(() => {
    if (visible) {
      // 只在"从不可见变可见"的那一刻记一次，避免把面板内部的焦点也记进去
      if (!focusReturnRef.current) focusReturnRef.current = document.activeElement;
    }
  }, [visible]);

  const listening = wake.state === "live";

  return (
    <div
      className={`xd${visible ? " is-open" : ""}`}
      data-state={dockState}
      data-interaction-id={agent.interactionId || ""}
      data-queued={queueDepth}
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
            <button type="button" className="xd__icon-btn" onClick={close} aria-label="关闭小木（Esc）" title="关闭（Esc）">
              ×
            </button>
          </header>

          {/* 用户流式字幕：定稿前就地更新，不重复新增气泡（FR-07） */}
          {query || wake.partial ? (
            <p className="xd__user">{wake.partial || query}</p>
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
              onClick={() => {
                const channel = wakeChannel();
                if (channel.currentState === "live") channel.stop();
                else void channel.start();
              }}
              title="常驻唤醒：说两遍「小木小木」即可唤起（Alt+W 开关）。关掉气泡不会关掉它。"
            >
              {listening ? "常驻唤醒：已开" : "开启常驻唤醒"}
            </button>
            <span className="xd__hint">两遍「小木小木」 → 停一下 → 说命令</span>
          </footer>
        </section>
      ) : null}

      {/* 形象本体：始终在场，点它展开/收起 */}
      <button
        type="button"
        ref={avatarRef}
        className="xd__avatar"
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
          else setExpanded(true);
        }}
        aria-expanded={visible}
        aria-label={`小木（${DOCK_STATE_LABEL[dockState]}），${visible ? "点击收起" : "点击展开"}`}
        title={`小木 · ${DOCK_STATE_LABEL[dockState]}（点击${visible ? "收起" : "展开"}，Esc 关闭）`}
      >
        <Illustration id="i04-xiaomu" height={112} avatar className="xd__figure" alt="小木" />
        <span className="xd__ring" aria-hidden="true" />
        {/* 状态文字始终存在：关掉动效后仍能靠它分辨状态（FR-06） */}
        <span className="xd__badge">{DOCK_STATE_LABEL[dockState]}</span>
      </button>
    </div>
  );
}
