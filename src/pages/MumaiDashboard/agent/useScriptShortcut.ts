/**
 * 剧本快捷键：Ctrl+Q+N → 模拟"听到这一句" → 交给理解链路
 *
 * ── 它在链路里的位置 ──────────────────────────────────────────────
 *   按键序列（`scriptShortcutSequence.ts` 判定）
 *     → `VoiceInput.simulate()` 逐字吐出这句话（每字 100–300ms 随机，模拟流式 ASR）
 *     → 与语音控制台**同一条** `ask()` 理解链路（executor：剧本路由 → 意图兜底 → 播报）
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
  /** 触发键（1..9，对应 Ctrl+Q+<key>） */
  key: string;
  /** 这一轮要说的话（逐字照剧本；模拟识别时会一个字一个字蹦出来） */
  text: string;
  /** 人看的标签（哪一幕/哪一轮），进日志与清单用 */
  label: string;
};

export type UseScriptShortcutOptions = {
  entries: readonly ScriptShortcutEntry[];
  runtime: Runtime;
  /** 认出这句话之后交出去（默认走 `ask()`；测试里可注入假实现） */
  onSubmit?: (text: string, runtime: Runtime) => void | Promise<void>;
  /** 是否启用（默认启用） */
  enabled?: boolean;
};

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

  /* ---------- 自带一个只做"脚本化模拟"的 VoiceInput ---------- */
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
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
        const submit = onSubmit ?? ((t: string, rt: Runtime) => ask(t, rt, "example"));
        void submit(text, runtimeRef.current);
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
