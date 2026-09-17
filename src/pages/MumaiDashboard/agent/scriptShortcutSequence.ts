/**
 * 剧本快捷键的**序列匹配**（纯函数，可单测）
 *
 * ── 为什么单独一个纯函数 ────────────────────────────────────────────
 * `Ctrl+B/Y/M + 数字` 是**两段式序列**（先按段前缀，再按目标键），判定里全是
 * 时间窗、修饰键、输入框/输入法这些容易写错又难复现的条件。仓库里已经有同款实现
 * （`useWorkOrderShortcut.ts` 的 Ctrl+Q+L），那份把判定写在 effect 里、
 * 没有单测；这里把判定抽成纯函数，配套测试直接喂"按键事件"验证行为，
 * 不必起浏览器。
 *
 * ── 口径（逐条与 useWorkOrderShortcut 对齐，避免两条序列各有一套规矩）──
 *   · 按住 Ctrl，先按**段前缀**（B / Y / M），再在 1.5 秒内按数字；
 *   · 长按产生的 repeat 不参与判定；输入法组字期间不参与；
 *   · 输入框 / 文本域 / 可编辑区域里不触发（用户可能正在打字）；
 *   · 只对**确实匹配**的序列处理默认行为（`preventDefault`），
 *     否则会吃掉浏览器与页面自己的快捷键。
 *
 * ── 键位方案（用户 2026-09-17 口径，前后改了三次）────────────────────
 * 原话：「1到10对话是 Ctrl+B+1到0，11到20是 Ctrl+N+1到0，21到25则是 Ctrl+M+1到5」，
 * 随后「ctrl加n换成加j的，ctrl加n有功能冲突了」，再随后「找个没冲突的替代j」。
 * 三次口径收在一句话上：**段前缀只能用浏览器自己没有动作的键**。
 *   · `Ctrl+N` = 新建窗口 —— Chrome 的**保留键**，页面 `preventDefault` 也拦不住；
 *   · `Ctrl+J` = 下载页 —— 拦得住，但"能拦"不等于"没冲突"，用户不认；
 *   · `Ctrl+Y` = 浏览器里没有动作（只在输入框里是"重做"，而本序列在输入框里本就不参与）。
 * 备选只剩 I / M / Q / Y（字母表里没被浏览器占的就这几个）：M 归第三段、
 * Q 归建单序列 `Ctrl+Q+L`、I 在 Firefox 是"页面信息"对话框，所以第二段落在 **Y**。
 * 最终三段（按 10 条一段换前缀，段内回到数字）：
 *   · `Ctrl+B` + `1..9 0` → 文档第 1–10 条
 *   · `Ctrl+Y` + `1..9 0` → 文档第 11–20 条
 *   · `Ctrl+M` + `1..5`    → 文档第 21–25 条
 * 现场记法变成"第几段用哪个前缀、段内第几个"，三段都是数字键，右手不用来回挪。
 *
 * ⚠ 段前缀只能选**浏览器自己没有动作**的键，名单见下面的 `BROWSER_OWNED_CTRL_KEYS`；
 *   其中 `Ctrl+N`（新窗口）、`Ctrl+T`（新标签）、`Ctrl+W`（关标签）是浏览器**保留键**，
 *   页面 `preventDefault` 也拦不住（清单见 `BROWSER_RESERVED_CTRL_KEYS`）。
 *   本方案的 B / Y / M 里，只有 B 有默认动作（切书签栏）且拦得住，Y 与 M 完全没有动作。
 *   ⚠ 段内数字与 `Ctrl+1..9`（切换标签页）表面同形，靠 `preventDefault` 拦 ——
 *   验收脚本 `tools/验收-快捷键气泡.mjs` 钉住"按完页面与浏览器都没被带走"。
 *
 * ⚠ 同一个数字键在三段里含义不同（`Ctrl+B+1` 是第 1 条，`Ctrl+Y+1` 是第 11 条），
 *   所以**键位不能用裸数字当标识**：全流程统一用 `"<前缀>:<键>"` 这种复合 id
 *   （见 `shortcutId`）。条目表、快捷键一览、验收脚本都走同一个 id。
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
   * 已经按下的**段前缀**（"b" / "y" / "m"），正等后面的数字；null = 还没按。
   *
   * ⚠ 不能拿 `pressedAt > 0` 当"已按过"的标志 —— 那等于把 0 当哨兵值，
   * 而 `performance.now()` 在页面刚加载时**真的可能返回 0**（测试里注入 0 也同理）：
   * 那时会判成"没按过"，快捷键就哑了。实测踩过这个坑（序列永远不命中），
   * 所以用显式字段区分"按了哪个前缀"。
   */
  armedPrefix: string | null;
  /** 按下前缀键的时刻（performance.now() 口径），仅在 armedPrefix 非空时有意义 */
  pressedAt: number;
};

export const initialSequenceState: SequenceState = { armedPrefix: null, pressedAt: 0 };

/**
 * 三段键位表：**顺序 = 文档 25 条的顺序**。
 *
 * 每段是 `{ prefix, keys }`：按住 Ctrl 先按 `prefix`，再按 `keys` 里的某一个。
 * 段内顺序即条目顺序 —— 第 i 段第 j 个键 = 第 (前面各段键数之和 + j + 1) 条对话。
 */
export const SCRIPT_SHORTCUT_GROUPS = [
  /* 第 1–10 条 */
  { prefix: "b", keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] },
  /* 第 11–20 条（前缀用 Y：N 是浏览器保留键、J 是下载页，都被浏览器占着） */
  { prefix: "y", keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] },
  /* 第 21–25 条 */
  { prefix: "m", keys: ["1", "2", "3", "4", "5"] },
] as const;

/** 三段前缀（"b" / "y" / "m"），判定"这一次按的是不是段前缀"用 */
export const SCRIPT_SEQUENCE_PREFIX_KEYS: readonly string[] = SCRIPT_SHORTCUT_GROUPS.map(
  (group) => group.prefix,
);

/**
 * 全部 25 个键位的**复合 id**，顺序 = 文档 25 条的顺序。
 *
 * 形如 `"b:1"`、`"y:0"`、`"m:5"`；第 i 个 id 就是第 i 条对话的键位。
 * 条目表（`scriptShortcutEntries.ts`）的 `key` 字段用的就是这个 id。
 */
export const SCRIPT_SHORTCUT_KEYS: readonly string[] = SCRIPT_SHORTCUT_GROUPS.flatMap((group) =>
  group.keys.map((key) => `${group.prefix}:${key}`),
);

/** 段前缀 + 目标键 → 复合 id（全流程唯一的键位拼法） */
export function shortcutId(prefix: string, key: string): string {
  return `${prefix.toLowerCase()}:${String(key).toLowerCase()}`;
}

/** 复合 id → { prefix, key }；形状不对时返回 null（调用方据此拒绝，而不是硬猜） */
export function parseShortcutId(id: string): { prefix: string; key: string } | null {
  const match = /^([a-z0-9]):(.+)$/.exec(String(id).toLowerCase());
  if (!match) return null;
  return { prefix: match[1], key: match[2] };
}

/**
 * 复合 id → 给人看的键位文本，如 `Ctrl+B+1`。
 *
 * 显示规则只有这一处：条目表、气泡里的「快捷键一览」、给用户的对应表都调它，
 * 免得三个地方各写一套大小写或分隔符。
 */
export function shortcutLabel(id: string): string {
  const parsed = parseShortcutId(id);
  if (!parsed) return String(id);
  const { prefix, key } = parsed;
  const keyText = key === "\\" ? "\\" : key.toUpperCase();
  return `Ctrl+${prefix.toUpperCase()}+${keyText}`;
}

/** 被既有功能占用的键，一律不许出现在剧本快捷键表里 */
export const RESERVED_SHORTCUT_KEYS = ["l"] as const;

/**
 * 浏览器**保留**的 `Ctrl+<字母>`：页面 `preventDefault` 也拦不住，**绝对不许**当段前缀。
 *
 * 2026-09-17 现场第一次冲突就是 `Ctrl+N`（新建窗口）——按键后浏览器开出一个新窗口，
 * 拦不掉。名单写进代码，是为了让"选到保留键"在单测里直接红。
 */
export const BROWSER_RESERVED_CTRL_KEYS: readonly string[] = ["n", "t", "w"];

/**
 * 浏览器自己有默认动作的 `Ctrl+<字母>`（Chrome / Edge，Windows 口径）。
 *
 * 为什么单独一张名单：用户为"键位和浏览器撞了"前后换了**两次**键位 ——
 * 「ctrl加n换成加j的，ctrl加n有功能冲突了」、「找个没冲突的替代j」。
 * 所以"不许撞浏览器"不能只写在注释里，得是能跑的判据（见 `scriptShortcutSequence.test.ts`）。
 *
 * ⚠ `b` 在名单里（切书签栏），但它是 1–10 段在用的前缀，且**拦得住**、现场没出过问题，
 *   单测把它作为唯一豁免显式写出来，免得以后有人以为名单是"全都不许用"而误改第一段。
 */
export const BROWSER_OWNED_CTRL_KEYS: readonly string[] = [
  "a", // 全选
  "b", // 书签栏开关（可拦；1–10 段在用，见上面的豁免说明）
  "c", // 复制
  "d", // 收藏
  "e", // 地址栏搜索
  "f", // 页内查找
  "g", // 查找下一个
  "h", // 历史记录
  "j", // 下载页
  "k", // 地址栏搜索
  "l", // 地址栏
  "n", // 新建窗口（保留键）
  "o", // 打开文件
  "p", // 打印
  "r", // 刷新
  "s", // 另存为
  "t", // 新标签（保留键）
  "u", // 查看源码
  "v", // 粘贴
  "w", // 关闭标签（保留键）
  "x", // 剪切
  "z", // 撤销
];

export type SequenceVerdict =
  /** 本次按键与序列无关（或半截序列已过期），状态按 state 更新 */
  | { kind: "ignore"; state: SequenceState }
  /** 按下了段前缀，等待段内数字 */
  | { kind: "armed"; state: SequenceState }
  /** 命中：应当触发 `id` 对应的那一条 */
  | { kind: "fire"; id: string; prefix: string; key: string; state: SequenceState };

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

  if (SCRIPT_SEQUENCE_PREFIX_KEYS.includes(key)) {
    /* 只记"按了哪个段前缀"与时刻，不在这里 preventDefault —— 由调用方在 fire 或 armed 时决定，
       见下方说明：Ctrl+B/Y/M 在部分浏览器里有默认行为，需要拦；但纯函数不该碰事件 */
    return { kind: "armed", state: { armedPrefix: key, pressedAt: nowMs } };
  }

  /* 被既有功能占用的键（如 L = 建单）显式拒绝：光靠"不在允许集合里"是隐式的，
     以后有人把 L 加进集合也不会有人注意；这条断言让"绝不复用"变成代码事实。 */
  if ((RESERVED_SHORTCUT_KEYS as readonly string[]).includes(key)) {
    return { kind: "ignore", state };
  }

  /*
    段内数字：只有在**该段**的键表里才算命中。
    这里刻意不查"所有段的键的并集"：`Ctrl+B+5` 与 `Ctrl+Y+5`、`Ctrl+M+5` 是不同的条目，
    拿并集判会把"没按前缀/按了别段前缀"的情况也判成命中。
  */
  const group = SCRIPT_SHORTCUT_GROUPS.find((item) => item.prefix === state.armedPrefix) ?? null;
  if (group && (group.keys as readonly string[]).includes(key)) {
    const within = nowMs - state.pressedAt <= SCRIPT_SEQUENCE_WINDOW_MS;
    if (!within) return { kind: "ignore", state: initialSequenceState };
    return {
      kind: "fire",
      id: shortcutId(group.prefix, key),
      prefix: group.prefix,
      key,
      state: initialSequenceState,
    };
  }

  /* 其它按键：不动状态。既有的 Ctrl+Q+L 由它自己的 handler 处理，
     两条序列互不干扰（都只对自己关心的键做判定）。 */
  return { kind: "ignore", state };
}
