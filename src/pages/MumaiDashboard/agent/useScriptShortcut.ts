/**
 * 剧本快捷键：Ctrl+Q+N → 模拟"听到这一句" → 交给理解链路
 *
 * ── 它在链路里的位置 ──────────────────────────────────────────────
 *   按键序列（`scriptShortcutSequence.ts` 判定）
 *     → `VoiceInput.simulate()` 逐字吐出这句话（每字 100–300ms 随机，模拟流式 ASR）
 *     → 与语音控制台**同一条** `ask()` 理解链路（executor：剧本路由 → 意图兜底 → 播报）
 *     → 并带上条目里的 `roundNo`，走 `ask()` 的**指定轮次直达**分支
 *
 * ── 为什么要带段号（2026-09-17 修）────────────────────────────────
 * 演示人按了哪个键就是确定要看哪一轮，不该让模糊匹配去猜。旧实现只把触发语丢给
 * 匹配器，于是：段203/段205 两条条目的触发语**逐字相同**（同是「小木，启动数据清洗…」），
 * 按键命中哪一轮全看匹配器；⑪ 轮那条触发语为空，`onFinal` 又把空文本丢掉，
 * 结果 `Ctrl+Q+B` 按了毫无反应。现在两条问题一起消掉。
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
 * 只用 `Ctrl+Q+1..9`：`Ctrl+Q+L` 是建单（`useWorkOrderShortcut.ts`），
 * `Alt+W/E/R/M` 是气泡开关与重播。两条序列各自只对自己关心的键做判定，
 * 互不干扰（两边都不认识的键一律不动）。
 */
import { useCallback, useEffect, useRef } from "react";

import { VoiceInput } from "./asr";
import { ask, type Runtime } from "./executor";
import { setAgent } from "./store";
import {
  advanceSequence,
  initialSequenceState,
  type KeyLike,
  type SequenceState,
} from "./scriptShortcutSequence";

/** 一条"按快捷键就会说出这句话"的剧本对话 */
export type ScriptShortcutEntry = {
  /** 触发键（1..9 / a..z，对应 Ctrl+Q+<key>） */
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
   * 一轮可能有多句戏（⑮ 主台词 + `audit` 审核播报；④ 主台词 + 段15 同步备份）。
   * 不带这个字段时只念主台词 —— 于是"指向备用句的那条快捷键"会念成主台词，
   * 按的是段221、听到的却是段229。带上它，按的键与念的话才是同一句。
   */
  lineOverride?: string;
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

export function useScriptShortcut({
  entries,
  runtime,
  onSubmit,
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
      onListening: () => setAgent({ agentState: "LISTENING", stateNote: "识别中（脚本化模拟）" }),
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

  const trigger = useCallback((entry: ScriptShortcutEntry) => {
    queue.current = queue.current.then(async () => {
      const input = simulateRef.current;
      if (!input) return;
      /*
        ⚠ 空文本也要能触发。
        ⑪ 轮（段155）在剧本里**没有触发语**（它是本地事件/旁白起头），
        早期实现直接 `simulate("")`，而 `onFinal` 会把空文本丢掉 ——
        现场表现就是"按了 Ctrl+Q+B 什么都没发生"，且与"键没生效"无法区分。
        现在这一条由条目表给出该轮的**主台词**（见 `scriptShortcutEntries`），
        模拟的就是"小木那句话被听到了"，再经段号直达该轮。
      */
      if (!entry.text.trim() && !entry.roundNo) return;
      pendingRef.current = entry;
      setAgent({ stateNote: `剧本快捷键：${entry.label}`, finalText: "", partial: "" });
      input.simulate(entry.text);
    });
  }, []);

  /* ---------- 按键序列 ---------- */
  useEffect(() => {
    if (!enabled) return undefined;
    let state: SequenceState = initialSequenceState;
    const onKeyDown = (event: KeyboardEvent) => {
      const verdict = advanceSequence(event as unknown as KeyLike, state, performance.now());
      state = verdict.state;
      if (verdict.kind === "ignore") return;
      /* 只对确实属于本序列的按键拦默认行为：
         · armed —— Ctrl+Q 在部分浏览器有默认动作，必须拦，否则序列还没按完页面就动了；
         · fire  —— 拦掉，避免数字键再触发别的默认行为。 */
      event.preventDefault();
      if (verdict.kind !== "fire") return;
      const entry = byKey.current.get(verdict.key);
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
