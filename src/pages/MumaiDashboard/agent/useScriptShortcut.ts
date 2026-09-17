/**
 * 剧本快捷键：Ctrl+B/N/M + 数字 → 模拟"听到这一句" → 交给理解链路
 *
 * ── 它在链路里的位置 ──────────────────────────────────────────────
 *   按键序列（`scriptShortcutSequence.ts` 判定：三段前缀 + 段内数字）
 *     → `planFor(entry)` 决定这一条**该怎么演**（见下）
 *     → 被动应答：`VoiceInput.simulate()` 逐字吐出这句话（每字 100–300ms 随机，
 *       模拟流式 ASR）→ 与语音控制台**同一条** `ask()` 理解链路
 *       （executor：剧本路由 → 意图兜底 → 播报），并带上条目里的 `roundNo`
 *       走 `ask()` 的**指定轮次直达**分支
 *     → 主动发起（`proactive`）：**不模拟识别**，交给 `executor.speakProactive()` ——
 *       思考 2.5–4 秒 → 小木自己开口（用户 2026-09-17 口径，见 `planFor` 的说明）
 *
 * ── 为什么要带段号（2026-09-17 修）────────────────────────────────
 * 演示人按了哪个键就是确定要看哪一轮，不该让模糊匹配去猜。旧实现只把触发语丢给
 * 匹配器，于是：两条条目的触发语**逐字相同**（同是「小木，启动数据清洗…」），
 * 按键命中哪一轮全看匹配器；那条没有触发语的轮次，`onFinal` 又把空文本丢掉，
 * 结果按了毫无反应。现在两条问题一起消掉。
 *
 * ── 为什么不用控制台那个 VoiceInput 实例 ──────────────────────────
 * 控制台是**可选打开**的面板（`AgentHost` 按需挂载），而快捷键要在任何页面都能用；
 * 依赖它就会出现"没开控制台 → 快捷键没反应"。所以本 Hook 自带一个 `VoiceInput`：
 * 它只用来做脚本化模拟，不碰麦克风（`simulate()` 不申请权限）。
 *
 * ── 为什么入队而不是直接调 ask ────────────────────────────────────
 * 一次模拟要 2–5 秒（逐字），期间用户可能又按了下一条快捷键。
 * `ask()` 并发写同一个 agent store 会交叉 push 用户轮次与小木轮次
 * （界面上出现"回答 A 挂在问题 B 下面"）—— 与控制台的 askQueue 同一套处理。
 *
 * ── 与既有快捷键的关系 ───────────────────────────────────────────
 * 序列是 `Ctrl+<段前缀>+<数字>`（前缀与键位见 `SCRIPT_SHORTCUT_GROUPS`，就是用户
 * 2026-09-17 要的"1–10 用 B、11–20 用 N、21–25 用 M"）；`Ctrl+Q+L` 是建单
 * （`useWorkOrderShortcut.ts`），`Alt+W/E/R/M` 是气泡开关与重播。
 * 两条序列各自只对自己关心的键做判定，互不干扰（两边都不认识的键一律不动）。
 */
import { useCallback, useEffect, useRef } from "react";

import { VoiceInput } from "./asr";
import { ask, speakProactive, type Runtime } from "./executor";
import { setAgent } from "./store";
import {
  advanceSequence,
  initialSequenceState,
  type KeyLike,
  type SequenceState,
} from "./scriptShortcutSequence";

/** 一条"按快捷键就会说出这句话"的剧本对话 */
export type ScriptShortcutEntry = {
  /**
   * 触发键的**复合 id**：`"b:1"` / `"n:0"` / `"m:5"`。
   *
   * 为什么不是裸数字：同一个数字键在三段里含义不同（`Ctrl+B+1` 是第 1 条、
   * `Ctrl+N+1` 是第 11 条），裸数字会让条目表、查表与清单三处都失去唯一性。
   * 给人看的写法统一走 `shortcutLabel(id)` → `Ctrl+B+1`。
   */
  key: string;
  /** 这一轮要说的话（逐字照剧本；模拟识别时会一个字一个字蹦出来） */
  text: string;
  /** 人看的标签（哪一幕/哪一轮），进日志与清单用 */
  label: string;
  /**
   * 这一条**指定**要播的剧本轮次（圈号，如 "①"、"⑪"）。
   *
   * ── 为什么必须带（而不是让匹配器去猜）────────────────────────────
   * 演示人按了哪个键，就是**确定**要看哪一轮 —— 没有"可能听错"这回事。
   * 不带段号的话，这条链路会把触发语丢给模糊匹配，于是出现两种现场事故：
   *   · 两条条目的触发语**逐字相同**时（段203 与段205 就是同一句
   *     「小木，启动数据清洗…」），按键命中的是哪一轮全看匹配器心情；
   *   · 台词被改写后触发语与剧本对不上，按键就静默落到意图兜底。
   * 带上了就走 `executor.ask(..., { roundNo })` 的**直达通道**（score: 1 / verdict: hit）。
   */
  roundNo?: string;
  /**
   * 这一条要念的是该轮里的**哪一句**（逐字，必须是该轮 lines 里真实存在的）。
   *
   * 一轮可能有多句戏（⑰ 主台词 + `audit` 审核播报）。不带这个字段时只念主台词。
   */
  lineOverride?: string;
  /**
   * **小木主动发起**的一轮：按键后**不模拟识别**，小木思考一小会儿自己说。
   *
   * ── 为什么要有这个字段（用户口径 2026-09-17）──────────────────────
   * 用户原话：「部分主动触发的对话，其也会模拟接受消息，这是不对的，
   * 应该在我按按钮后小木思考一小会儿后主动说话」。
   *
   * 文档第 6/13/20 条原文写的是「按钮触发。」—— 现场是**按按钮**，不是说话。
   * 之前这三条被当成"没有触发语"处理：拿该轮台词当"听到的话"喂给识别链路，
   * 屏幕上就先逐字"收到"一遍小木自己的台词，然后小木再把同一句念一遍。
   * 同一句话说两遍、而且第二遍假装是听来的 —— 那是把主动播报演成了被动应答。
   *
   * 标了 `proactive` 的条目：`text` 此时 = **本轮小木要说的那句话**（逐字），
   * 只作展示与自检用，**不会**被投进识别链路；链路走 `executor.speakProactive()`。
   */
  proactive?: boolean;
};

export type UseScriptShortcutOptions = {
  entries: readonly ScriptShortcutEntry[];
  runtime: Runtime;
  /** 认出这句话之后交出去（默认走 `ask()`；测试里可注入假实现） */
  onSubmit?: (
    text: string,
    runtime: Runtime,
    entry: ScriptShortcutEntry,
  ) => void | Promise<void>;
  /**
   * 「小木主动发起」的条目按下去之后交出去（默认走 `speakProactive()`）。
   * 与 `onSubmit` 分开，是因为两者语义不同：一个"听到了话"，一个"没人说话"。
   */
  onProactive?: (roundNo: string, runtime: Runtime, entry: ScriptShortcutEntry) => void | Promise<void>;
  /** 是否启用（默认启用） */
  enabled?: boolean;
};

/**
 * 一条条目该按什么参数交给理解链路（默认路径用）。
 *
 * ── 为什么单独抽出来 ──────────────────────────────────────────────
 * `useScriptShortcut` 是 React 钩子，`node --test` 里挂不起来（没有渲染器），
 * 而"到底有没有把段号传下去"恰恰是**最需要钉住**的一环：
 * 漏传不会报错、不会崩，只会静默退回模糊匹配 —— 台上表现是"按键后进了别的轮次"。
 * 所以把这段判断抽成纯函数，测试直接调它，不必挂组件。
 */
export function askArgsFor(entry: ScriptShortcutEntry): {
  text: string;
  target: { roundNo?: string; lineOverride?: string } | undefined;
} {
  const target: { roundNo?: string; lineOverride?: string } = {};
  if (entry.roundNo) target.roundNo = entry.roundNo;
  if (entry.lineOverride) target.lineOverride = entry.lineOverride;
  return {
    text: entry.text,
    target: Object.keys(target).length ? target : undefined,
  };
}

/**
 * 一条条目按下键之后**该怎么演**。
 *
 * ── 为什么把这个判断抽成纯函数（除了 `askArgsFor` 之外再来一个）────────
 * "这一条要不要模拟'听到'"是**最不能写错**的一处分叉，而它恰恰是钩子里的分支：
 * 写错了不会崩、不会报错，只会让屏幕先逐字"收到"一遍小木自己的台词
 * （用户 2026-09-17 实测报的就是这个）。钩子在 `node --test` 里挂不起来，
 * 所以把判断抽出来，测试直接喂条目、断言"这条到底会不会被当成一句话听到"。
 *
 * @returns null = 这一条什么都不该做（既没有主动发起的轮次，也没有可模拟的文本）
 */
export type ShortcutPlan =
  /** 小木主动发起：不模拟识别，思考一小会儿自己说该轮台词 */
  | { kind: "proactive"; roundNo: string }
  /** 模拟"听到了这句话"，再走理解链路直达 target.roundNo */
  | { kind: "speech"; text: string; target: { roundNo?: string; lineOverride?: string } | undefined };

export function planFor(entry: ScriptShortcutEntry): ShortcutPlan | null {
  if (entry.proactive) {
    /* 主动发起必须有轮次：没有轮次就没有"该说哪一句"，按键只能是空响 */
    return entry.roundNo ? { kind: "proactive", roundNo: entry.roundNo } : null;
  }
  if (!entry.text.trim() && !entry.roundNo) return null;
  const { text, target } = askArgsFor(entry);
  return { kind: "speech", text, target };
}

export function useScriptShortcut({
  entries,
  runtime,
  onSubmit,
  onProactive,
  enabled = true,
}: UseScriptShortcutOptions) {
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  /** 按键 → 对话条目（同一个键重复注册属于配置错误，测试会拦，这里取第一条） */
  const byKey = useRef(new Map<string, ScriptShortcutEntry>());
  byKey.current = new Map(entries.map((entry) => [entry.key, entry]));

  /** 串行队列：一次模拟跑完再跑下一条，避免两轮回答交叉 */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const simulateRef = useRef<VoiceInput | null>(null);

  /** 正在模拟的那一条（`onFinal` 只有文本，拿段号要靠它） */
  const pendingRef = useRef<ScriptShortcutEntry | null>(null);

  /* ---------- 自带一个只做"脚本化模拟"的 VoiceInput ---------- */
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    /*
      当前正在模拟的那一条：`onFinal` 要拿到它的段号，但回调签名只有文本。
      用 ref 记住"这一次模拟的是谁"，与串行队列配对（一次只跑一条）。
    */
    const pending = pendingRef;
    const input = new VoiceInput({
      /*
        ⚠ 必须同时置 `open: true`（2026-09-17 用户实测出的真 bug）。
        只写 `partial` 的话，逐字文本**根本没有地方显示** —— 气泡面板的门控是
        `if (!agent.open && !expanded) return;`（`XiaomuDock.tsx`），
        而快捷键此前从不置 `open`。现场表现正如用户描述：
        「点击的时候小木应该有正在录入的样子…实测是小木没反应，过一会儿突然接收到一整句话」——
        那串 partial 一直在 store 里累积，但气泡被挡住，直到 `ask()` 收尾才看到整句。
        `open` 的语义在 dock 注释里写得很清楚：**本轮交互由程序发起**（唤醒/串口/命令式打开），
        快捷键属于同一类，所以这里置它是符合既有约定的，而不是绕过门控。
      */
      onListening: () =>
        setAgent({
          open: true,
          agentState: "LISTENING",
          stateNote: "识别中（脚本化模拟）",
          partial: "",
          finalText: "",
        }),
      onPartial: (text, final) =>
        setAgent({ partial: final ? "" : text, agentState: final ? "RECOGNIZING" : "LISTENING" }),
      onLevel: (level) => setAgent({ level }),
      onSpeechStart: () => setAgent({ agentState: "LISTENING", stateNote: "检测到说话" }),
      onSpeechEnd: () => setAgent({ agentState: "RECOGNIZING", stateNote: "检测到静音，正在收尾识别" }),
      onFinal: (text) => {
        if (!text.trim()) return;
        setAgent({ finalText: text, partial: "" });
        const entry = pending.current;
        pending.current = null;
        const submit =
          onSubmit ??
          ((t: string, rt: Runtime, e: ScriptShortcutEntry) => {
            const { target } = askArgsFor(e);
            return ask(t, rt, "example", target);
          });
        void submit(text, runtimeRef.current, entry ?? { key: "", text, label: "" });
      },
      onNotice: () => {
        /* 脚本化模拟不依赖麦克风，不会有通道提示 */
      },
      onError: (text) => {
        console.warn("[script-shortcut] 模拟识别出错：", text);
      },
      onBargeIn: () => {
        /* 模拟过程没有真实麦克风，不产生打断 */
      },
    });
    simulateRef.current = input;
    return () => {
      input.stopAll();
      simulateRef.current = null;
    };
  }, [onSubmit]);

  const trigger = useCallback(
    (entry: ScriptShortcutEntry) => {
      queue.current = queue.current.then(async () => {
        /*
          ⚠ 空文本也要能触发（历史坑）。
          ⑬ 轮（段155，重排前的 ⑪）在剧本里**没有触发语**（它是本地事件/旁白起头），
          早期实现直接 `simulate("")`，而 `onFinal` 会把空文本丢掉 ——
          现场表现就是"按了键什么都没发生"，且与"键没生效"无法区分。
          现在它走下面的 proactive 分支，根本不需要"听到的话"。
        */
        const plan = planFor(entry);
        if (!plan) return;

        /*
          ── 小木主动发起：**不模拟识别**（用户 2026-09-17 口径）──────────
          文档第 6/13/20 条是「按钮触发。」—— 现场按的是按钮，没人说话。
          所以这里既不 `simulate()`（否则气泡里会先逐字"收到"一遍小木自己的台词），
          也不进 `ask()`（那会往对话里 push 一条"用户说"的记录）。
          直接交给 `speakProactive()`：思考一小会儿 → 小木自己开口。
        */
        if (plan.kind === "proactive") {
          pendingRef.current = null;
          setAgent({ open: true, stateNote: `剧本快捷键：${entry.label}`, finalText: "", partial: "" });
          const run =
            onProactive ?? ((roundNo: string, rt: Runtime) => speakProactive(roundNo, rt));
          await run(plan.roundNo, runtimeRef.current, entry);
          return;
        }

        const input = simulateRef.current;
        if (!input) return;
        pendingRef.current = entry;
        setAgent({ stateNote: `剧本快捷键：${entry.label}`, finalText: "", partial: "" });
        input.simulate(plan.text);
      });
    },
    [onProactive],
  );

  /* ---------- 按键序列 ---------- */
  useEffect(() => {
    if (!enabled) return undefined;
    let state: SequenceState = initialSequenceState;
    const onKeyDown = (event: KeyboardEvent) => {
      const verdict = advanceSequence(event as unknown as KeyLike, state, performance.now());
      state = verdict.state;
      if (verdict.kind === "ignore") return;
      /* 只对确实属于本序列的按键拦默认行为：
         · armed —— Ctrl+B/N/M 在部分浏览器有默认动作（B 是加粗等），
           必须拦，否则序列还没按完页面就动了；
         · fire  —— 拦掉，避免数字键再触发别的默认行为。 */
      event.preventDefault();
      if (verdict.kind !== "fire") return;
      /* 查表用**复合 id**（"b:1"），不是裸数字：同一个数字在三段里是不同的条目 */
      const entry = byKey.current.get(verdict.id);
      if (!entry) return;
      trigger(entry);
    };
    /* Ctrl 松开就清序列：与 useWorkOrderShortcut 同一口径 */
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || !event.ctrlKey) state = initialSequenceState;
    };
    const reset = () => {
      state = initialSequenceState;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
    };
  }, [enabled, trigger]);
}
