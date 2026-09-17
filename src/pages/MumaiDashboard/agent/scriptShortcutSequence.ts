/**
 * 剧本快捷键的**序列匹配**（纯函数，可单测）
 *
 * ── 为什么单独一个纯函数 ────────────────────────────────────────────
 * Ctrl+M+N 是**两段式序列**（先 M 再目标键），判定里全是时间窗、修饰键、
 * 输入框/输入法这些容易写错又难复现的条件。仓库里已经有同款实现
 * （`useWorkOrderShortcut.ts` 的 Ctrl+Q+L），那份把判定写在 effect 里、
 * 没有单测；这里把判定抽成纯函数，配套测试直接喂"按键事件"验证行为，
 * 不必起浏览器。
 *
 * ── 口径（逐条与 useWorkOrderShortcut 对齐，避免两条序列各有一套规矩）──
 *   · 按住 Ctrl，先按 M，再在 1.5 秒内按目标键；
 *   · 长按产生的 repeat 不参与判定；输入法组字期间不参与；
 *   · 输入框 / 文本域 / 可编辑区域里不触发（用户可能正在打字）；
 *   · 只对**确实匹配**的序列处理默认行为（`preventDefault`），
 *     否则会吃掉浏览器与页面自己的快捷键。
 */

/** 序列有效窗口：与 `useWorkOrderShortcut.ts` 的 SEQUENCE_WINDOW_MS 必须一致 */
export const SCRIPT_SEQUENCE_WINDOW_MS = 1500;

/** 判定所需的最小事件形状（真实 KeyboardEvent 与测试构造的对象都满足） */
export type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: unknown;
};

export type SequenceState = {
  /**
   * 是否已经按过前缀键（M）、正等后半截。
   *
   * ⚠ 不能拿 `pressedAt > 0` 当"已按过"的标志 —— 那等于把 0 当哨兵值，
   * 而 `performance.now()` 在页面刚加载时**真的可能返回 0**（测试里注入 0 也同理）：
   * 那时 armed 会被判成"没按过"，快捷键就哑了。实测踩过这个坑
   * （序列永远不命中），所以用显式标志位。
   */
  armed: boolean;
  /** 按下前缀键的时刻（performance.now() 口径），仅在 armed 为真时有意义 */
  pressedAt: number;
};

export const initialSequenceState: SequenceState = { armed: false, pressedAt: 0 };

/**
 * 序列的**前缀键**：按住 Ctrl 先按它，再按目标键。
 *
 * ⚠ 用户 2026-09-17 口径：「前 10 句话 Ctrl+M+1..0，然后再按照键盘 q 开头那排
 *   顺序来，以此类推」—— 前缀从 Q 换成 M，目标键改成**键盘行序**（见
 *   `SCRIPT_SHORTCUT_KEYS`）。`Ctrl+Q+L`（建单）是另一条序列，不受影响。
 */
export const SCRIPT_SEQUENCE_PREFIX_KEY = "m";

/**
 * 允许的目标键，**顺序 = 文档 25 条的顺序**（第 i 个键 = 第 i 条对话）。
 *
 * ── 为什么是这个顺序 ────────────────────────────────────────────
 * 用户口径（2026-09-17）：「前 10 句话 Ctrl+M+1..0，然后再按照键盘 q 开头那排
 * 顺序来，以此类推」。所以：
 *   · `1 2 3 4 5 6 7 8 9 0`      → 文档第 1–10 条
 *   · `q w e r t y u i o p [ ] \` → 文档第 11–23 条（键盘上 q 那一排，13 个键）
 *   · `a s`                       → 文档第 24–25 条（接着是 a 那一排）
 * 现场演示时"照着文档顺序往下按"就是键盘从左到右一排排按，不用记编号。
 */
export const SCRIPT_SHORTCUT_KEYS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\",
  "a", "s",
] as const;

/** 被既有功能占用的键，一律不许出现在剧本快捷键表里 */
export const RESERVED_SHORTCUT_KEYS = ["l"] as const;

export type SequenceVerdict =
  /** 本次按键与序列无关（或半截序列已过期），状态按 needState 更新 */
  | { kind: "ignore"; state: SequenceState }
  /** 记下了 Q，等待目标键 */
  | { kind: "armed"; state: SequenceState }
  /** 命中：应当触发 targetKey 对应的那一条 */
  | { kind: "fire"; key: string; state: SequenceState };

function isEditable(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!element || !element.tagName) return false;
  const tag = String(element.tagName).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

/**
 * 处理一次 keydown，返回判定与新的序列状态。
 *
 * @param event  按键事件（形状见 KeyLike）
 * @param state  当前序列状态
 * @param nowMs  当前时刻（performance.now() 口径，注入便于测试）
 */
export function advanceSequence(event: KeyLike, state: SequenceState, nowMs: number): SequenceVerdict {
  /* 长按与输入法组字期间一律不参与：前者会把一次按键放大成多次触发，
     后者会把「选词数字」误当成快捷键 */
  if (event.repeat || event.isComposing) return { kind: "ignore", state };

  const key = String(event.key ?? "").toLowerCase();

  /* 修饰键不合规：Ctrl 必须按住，且不带 Meta / Alt。
     判据用"不满足就清空半截序列"，避免 Ctrl 松开后 1.5 秒内按数字还误触发 */
  const modifierOk = event.ctrlKey === true && !event.metaKey && !event.altKey;
  if (!modifierOk) return { kind: "ignore", state: initialSequenceState };

  /* 正在输入框/可编辑区域里打字：整条序列不参与（也不清状态，用户可能只是抬手碰了下键盘） */
  if (isEditable(event.target)) return { kind: "ignore", state };

  if (key === SCRIPT_SEQUENCE_PREFIX_KEY) {
    /* 只记时刻，不在这里 preventDefault —— 由调用方在 fire 或 armed 时决定，
       见下方说明：Ctrl+M 在部分浏览器里有默认行为，需要拦；但纯函数不该碰事件 */
    return { kind: "armed", state: { armed: true, pressedAt: nowMs } };
  }

  /* 被既有功能占用的键（如 L = 建单）显式拒绝：光靠"不在允许集合里"是隐式的，
     以后有人把 L 加进集合也不会有人注意；这条断言让"绝不复用"变成代码事实。 */
  if ((RESERVED_SHORTCUT_KEYS as readonly string[]).includes(key)) {
    return { kind: "ignore", state };
  }

  if ((SCRIPT_SHORTCUT_KEYS as readonly string[]).includes(key)) {
    const within = state.armed && nowMs - state.pressedAt <= SCRIPT_SEQUENCE_WINDOW_MS;
    if (!within) return { kind: "ignore", state: initialSequenceState };
    return { kind: "fire", key, state: initialSequenceState };
  }

  /* 其它按键：不动状态。既有的 Ctrl+Q+L 由它自己的 handler 处理，
     两条序列互不干扰（都只对自己关心的键做判定）。 */
  return { kind: "ignore", state };
}

