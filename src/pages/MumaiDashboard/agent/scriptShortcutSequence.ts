/**
 * 剧本快捷键的**序列匹配**（纯函数，可单测）
 *
 * ── 为什么单独一个纯函数 ────────────────────────────────────────────
 * Ctrl+Q+N 是**两段式序列**（先 Q 再数字），判定里全是时间窗、修饰键、
 * 输入框/输入法这些容易写错又难复现的条件。仓库里已经有同款实现
 * （`useWorkOrderShortcut.ts` 的 Ctrl+Q+L），那份把判定写在 effect 里、
 * 没有单测；这里把判定抽成纯函数，配套测试直接喂"按键事件"验证行为，
 * 不必起浏览器。
 *
 * ── 口径（逐条与 useWorkOrderShortcut 对齐，避免两条序列各有一套规矩）──
 *   · 按住 Ctrl，先按 Q，再在 1.5 秒内按目标键；
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
   * 是否已经按过 Q、正等后半截。
   *
   * ⚠ 不能拿 `qPressedAt > 0` 当"已按过"的标志 —— 那等于把 0 当哨兵值，
   * 而 `performance.now()` 在页面刚加载时**真的可能返回 0**（测试里注入 0 也同理）：
   * 那时 armed 会被判成"没按过"，快捷键就哑了。实测踩过这个坑
   * （序列永远不命中），所以用显式标志位。
   */
  armed: boolean;
  /** 按 Q 的时刻（performance.now() 口径），仅在 armed 为真时有意义 */
  qPressedAt: number;
};

export const initialSequenceState: SequenceState = { armed: false, qPressedAt: 0 };

/**
 * 允许的目标键。
 *
 * ── 为什么数字之后还要字母 ─────────────────────────────────────────
 * 剧本里小木的戏份有 **24 条**（抽取见 `_script_extract/xiaomu_scenes.md`），
 * 而 `Ctrl+Q+1..9` 只有 9 个位置。第二条序列段沿用**同一个结构**
 * （按住 Ctrl+Q 再按一个键），字母部分与既有的 `Ctrl+Q+L` 同构：
 *   · 数字 `1..9`  → 前 9 条（主线、最常按的）
 *   · 字母 `A..Z`  → 第 10 条起，**排除 L**（L 是建单快捷键，绝不复用）
 * 为什么不用"两段数字"（Ctrl+Q+1+1）：那要求连按三个键，现场单手很难按准，
 * 而字母与数字混排时"按住 Ctrl+Q 再按一下"的手感是一致的。
 */
export const SCRIPT_SHORTCUT_KEYS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
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

  if (key === "q") {
    /* 只记时刻，不在这里 preventDefault —— 由调用方在 fire 或 armed 时决定，
       见下方说明：Ctrl+Q 在部分浏览器里有默认行为，需要拦；但纯函数不该碰事件 */
    return { kind: "armed", state: { armed: true, qPressedAt: nowMs } };
  }

  /* 被既有功能占用的键（如 L = 建单）显式拒绝：光靠"不在允许集合里"是隐式的，
     以后有人把 L 加进集合也不会有人注意；这条断言让"绝不复用"变成代码事实。 */
  if ((RESERVED_SHORTCUT_KEYS as readonly string[]).includes(key)) {
    return { kind: "ignore", state };
  }

  if ((SCRIPT_SHORTCUT_KEYS as readonly string[]).includes(key)) {
    const within = state.armed && nowMs - state.qPressedAt <= SCRIPT_SEQUENCE_WINDOW_MS;
    if (!within) return { kind: "ignore", state: initialSequenceState };
    return { kind: "fire", key, state: initialSequenceState };
  }

  /* 其它按键：不动状态。既有的 Ctrl+Q+L 由它自己的 handler 处理，
     两条序列互不干扰（都只对自己关心的键做判定）。 */
  return { kind: "ignore", state };
}
