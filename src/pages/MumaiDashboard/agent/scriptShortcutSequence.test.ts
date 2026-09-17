/**
 * 剧本快捷键序列判定的单测
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * `Ctrl+B/Y/M + 数字` 是两段式序列，判定里全是时间窗与修饰键条件。写错的后果分两种，
 * 都很隐蔽：
 *   · 太宽 → 用户按 Ctrl+B 想干别的（加粗、或输入法选词）时**凭空触发一轮对话**；
 *   · 太严 → 现场按键没反应，讲解人以为功能坏了。
 * 所以每条口径都单独钉一个用例。
 *
 * ── 2026-09-17 键位改成三段（用户口径，前后改了三次）──────────────
 * 「1到10对话是 Ctrl+B+1到0，11到20是 Ctrl+N+1到0，21到25则是 Ctrl+M+1到5」；
 * 随后「ctrl加n换成加j的，ctrl加n有功能冲突了」（Ctrl+N = 新建窗口，**拦不住**）；
 * 再随后「找个没冲突的替代j」（Ctrl+J = 下载页）。最终第二段的段前缀是 **Y**
 * （浏览器里没有默认动作，理由与备选取舍见实现里的 `BROWSER_OWNED_CTRL_KEYS`）。
 * 于是**同一个数字键在三段里含义不同**：这里凡是查键位的地方都用复合 id
 * （`"b:1"` / `"y:0"` / `"m:5"`，见 `shortcutId`），并专门钉住"跨段不许串"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_OWNED_CTRL_KEYS,
  BROWSER_RESERVED_CTRL_KEYS,
  RESERVED_SHORTCUT_KEYS,
  SCRIPT_SEQUENCE_PREFIX_KEYS,
  SCRIPT_SEQUENCE_WINDOW_MS,
  SCRIPT_SHORTCUT_GROUPS,
  SCRIPT_SHORTCUT_KEYS,
  SCRIPT_WALK_KEY,
  advanceSequence,
  initialSequenceState,
  isWalkKey,
  nextScriptIndex,
  parseShortcutId,
  shortcutId,
  shortcutLabel,
  walkKeyLabel,
  type KeyLike,
} from "./scriptShortcutSequence.ts";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: true,
  ...extra,
});

/** 按一次段前缀，返回 armed 之后的序列状态 */
const arm = (prefix: string, at = 0) => {
  const verdict = advanceSequence(key(prefix), initialSequenceState, at);
  assert.equal(verdict.kind, "armed", `Ctrl+${prefix.toUpperCase()} 应当进入 armed`);
  return verdict.state;
};

test("Ctrl+B 之后按数字 → 命中第 1–10 段的那一条", () => {
  const state = arm("b", 1000);
  const fired = advanceSequence(key("1"), state, 1200);
  assert.equal(fired.kind, "fire");
  assert.equal(fired.kind === "fire" ? fired.id : "", "b:1");
  /* 命中之后序列清空：再按一次数字不该重复触发 */
  assert.equal(fired.state.armedPrefix, null);
  assert.equal(advanceSequence(key("1"), fired.state, 1300).kind, "ignore");
});

test("三段前缀各自命中自己的复合 id（同一个数字键含义不同）", () => {
  const cases: [string, string, string][] = [
    ["b", "1", "b:1"],
    ["b", "0", "b:0"],
    ["y", "1", "y:1"],
    ["y", "0", "y:0"],
    ["m", "1", "m:1"],
    ["m", "5", "m:5"],
  ];
  for (const [prefix, digit, id] of cases) {
    const fired = advanceSequence(key(digit), arm(prefix), 500);
    assert.equal(fired.kind, "fire", `Ctrl+${prefix.toUpperCase()}+${digit} 应当命中`);
    assert.equal(fired.kind === "fire" ? fired.id : "", id);
  }
});

test("跨段不许串：段外的数字不命中，且不清掉半截序列以外的行为要一致", () => {
  /* Ctrl+M 这一段只有 1..5 —— 按 6 不该命中（第 26 条不存在） */
  assert.equal(advanceSequence(key("6"), arm("m"), 300).kind, "ignore");
  /* Ctrl+B / Ctrl+Y 两段各有 1..0，0 有效；字母不是任何段的目标键 */
  assert.equal(advanceSequence(key("q"), arm("b"), 300).kind, "ignore");
  assert.equal(advanceSequence(key("a"), arm("y"), 300).kind, "ignore");
});

test("超出 1.5 秒窗口 → 不命中，且半截序列被清掉", () => {
  const state = arm("y", 0);
  const late = advanceSequence(key("2"), state, SCRIPT_SEQUENCE_WINDOW_MS + 1);
  assert.equal(late.kind, "ignore");
  assert.equal(late.state.armedPrefix, null, "过期后必须清状态，否则下一次按键会被当成序列后半截");
});

test("窗口边界：刚好等于窗口仍算命中（闭合边界）", () => {
  const state = arm("b", 0);
  assert.equal(advanceSequence(key("3"), state, SCRIPT_SEQUENCE_WINDOW_MS).kind, "fire");
});

test("没有先按段前缀就直接按数字 → 不命中", () => {
  assert.equal(advanceSequence(key("4"), initialSequenceState, 500).kind, "ignore");
});

test("修饰键不合规就不命中，并清掉半截序列", () => {
  const state = arm("b", 0);
  /* 松开 Ctrl 再按数字 */
  assert.equal(advanceSequence({ key: "5", ctrlKey: false }, state, 100).kind, "ignore");
  /* 带 Alt 或 Meta 也不算 */
  assert.equal(advanceSequence(key("6", { altKey: true }), state, 100).kind, "ignore");
  assert.equal(advanceSequence(key("7", { metaKey: true }), state, 100).kind, "ignore");
  /* 不合规的按键必须把 armed 状态清掉，防止"Ctrl 松了也算" */
  const afterBad = advanceSequence(key("8", { altKey: true }), state, 100);
  assert.equal(afterBad.state.armedPrefix, null);
});

test("按住 Shift 一律不算本序列的键（否则会吃掉浏览器自己的 Ctrl+Shift+* ）", () => {
  /*
    2026-09-17 用真实输入通道实测查出：`event.key` 在按住 Shift 时是**大写**，
    旧判定 `toLowerCase()` 之后照样比对段前缀 —— 于是 `Ctrl+Shift+B` 把 1–10 段
    "待命"并 `preventDefault()`，**把浏览器"显示/隐藏书签栏"吃掉了**（实测可视高度不再变化）。
    现在按住 Shift 直接不算：不吃浏览器的组合，「一条龙」Ctrl+Shift+Z 另走 `isWalkKey`。
  */
  assert.equal(advanceSequence(key("b", { shiftKey: true }), initialSequenceState, 0).kind, "ignore");
  assert.equal(advanceSequence(key("B", { shiftKey: true }), initialSequenceState, 0).kind, "ignore");
  const state = arm("b", 0);
  assert.equal(advanceSequence(key("1", { shiftKey: true }), state, 100).kind, "ignore");
  assert.equal(advanceSequence(key("B", { shiftKey: true }), state, 100).kind, "ignore");
  /* 松开 Shift 之后照常能用（不是把序列搞哑了） */
  assert.equal(advanceSequence(key("b"), initialSequenceState, 0).kind, "armed");
});

test("长按产生的 repeat 与输入法组字期间不参与", () => {
  const state = arm("b", 0);
  assert.equal(advanceSequence(key("1", { repeat: true }), state, 50).kind, "ignore");
  assert.equal(advanceSequence(key("1", { isComposing: true }), state, 50).kind, "ignore");
});

test("输入框 / 文本域 / 可编辑区域里不触发", () => {
  const state = arm("b", 0);
  const cases = [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ];
  /*
    ⚠ 状态必须**跟着判定结果往后传**（每次用上一次返回的 state）。
    第一版这里反复拿同一个 armed state 去喂：前几次判定一旦命中就把序列清空，
    后面的用例自然全变 ignore —— 那是测试自己把状态用掉了，不是实现的问题。
  */
  let current = state;
  for (const target of cases) {
    const verdict = advanceSequence(key("1", { target }), current, 50);
    assert.equal(verdict.kind, "ignore", `不该在 ${JSON.stringify(target)} 里触发`);
    current = verdict.state;
  }
  /* 普通容器里照常触发（此时序列仍是 armed，因为上面的判定都没消费它） */
  assert.equal(advanceSequence(key("1", { target: { tagName: "DIV" } }), current, 50).kind, "fire");
});

test("键表 = 用户口径的三段（B:1..0 / Y:1..0 / M:1..5），共 25 个位置", () => {
  /* 键表顺序 = 用户《小木对话总文案.txt》25 条的顺序；错一位就会"按了第 7 个键、
     小木念第 8 条"。 */
  assert.deepEqual(
    [...SCRIPT_SHORTCUT_KEYS],
    [
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((k) => `b:${k}`),
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((k) => `y:${k}`),
      ...["1", "2", "3", "4", "5"].map((k) => `m:${k}`),
    ],
    "必须是 Ctrl+B+1..0、Ctrl+Y+1..0、Ctrl+M+1..5",
  );
  assert.equal(SCRIPT_SHORTCUT_KEYS.length, 25, "25 个键对应文档 25 条对话");
  assert.equal(new Set(SCRIPT_SHORTCUT_KEYS).size, 25, "复合 id 必须互不相同");
  assert.deepEqual(
    SCRIPT_SHORTCUT_GROUPS.map((g) => g.prefix),
    ["b", "y", "m"],
    "前缀顺序 = 段落顺序（1–10、11–20、21–25）",
  );
  assert.deepEqual([...SCRIPT_SEQUENCE_PREFIX_KEYS], ["b", "y", "m"]);
  /* 每段的键数要能覆盖对应条数：10 + 10 + 5 */
  assert.deepEqual(
    SCRIPT_SHORTCUT_GROUPS.map((g) => g.keys.length),
    [10, 10, 5],
  );
});

test("段前缀不许撞浏览器自己的 Ctrl 组合（用户为这件事换过两次键位）", () => {
  /*
    用户原话两次：
      「ctrl加n换成加j的，ctrl加n有功能冲突了」—— Ctrl+N = 新建窗口，**保留键，拦不住**；
      「找个没冲突的替代j」—— Ctrl+J = 下载页。
    所以"键位不许和浏览器撞"必须是**能跑的判据**，而不是一句记住的话：
    以后有人把段前缀改成 H（历史）、D（收藏）、S（另存为）这类键，这条用例当场红。
    （名单口径 = Chrome / Edge；`b` 不在名单里，因为它在这两个浏览器里没有动作，
      书签栏开关是 Ctrl+Shift+B —— 已由 `tools/验收-浏览器不吃键位.mjs` 用真实按键验过。）
  */
  for (const prefix of SCRIPT_SEQUENCE_PREFIX_KEYS) {
    assert.equal(
      BROWSER_RESERVED_CTRL_KEYS.includes(prefix),
      false,
      `Ctrl+${prefix.toUpperCase()} 是浏览器保留键，页面 preventDefault 也拦不住，绝不许当段前缀`,
    );
    assert.equal(
      BROWSER_OWNED_CTRL_KEYS.includes(prefix),
      false,
      `Ctrl+${prefix.toUpperCase()} 浏览器自己有动作（名单见 BROWSER_OWNED_CTRL_KEYS）`,
    );
  }
  /* 名单自己也要守住硬禁区：别有人把 N/T/W 从"浏览器占用"里删掉 */
  for (const reserved of BROWSER_RESERVED_CTRL_KEYS) {
    assert.equal(
      BROWSER_OWNED_CTRL_KEYS.includes(reserved),
      true,
      `${reserved} 是保留键，必须留在 BROWSER_OWNED_CTRL_KEYS 里`,
    );
  }
  /* 三段前缀互不相同；也不许撞建单序列的 Q 与被占用的 L */
  assert.equal(
    new Set(SCRIPT_SEQUENCE_PREFIX_KEYS).size,
    SCRIPT_SHORTCUT_GROUPS.length,
    "三段前缀必须互不相同，否则段内数字会指向两个条目",
  );
  for (const taken of ["q", ...RESERVED_SHORTCUT_KEYS]) {
    assert.equal(
      SCRIPT_SEQUENCE_PREFIX_KEYS.includes(taken),
      false,
      `Ctrl+${taken.toUpperCase()} 已被别的功能占用（建单 Ctrl+Q+L / 保留键 L）`,
    );
  }
});

test("键位文本：复合 id → Ctrl+B+1 这样的写法（唯一一处实现）", () => {
  assert.equal(shortcutLabel("b:1"), "Ctrl+B+1");
  assert.equal(shortcutLabel("y:0"), "Ctrl+Y+0");
  assert.equal(shortcutLabel("m:5"), "Ctrl+M+5");
  assert.deepEqual(parseShortcutId("y:0"), { prefix: "y", key: "0" });
  assert.equal(parseShortcutId("nonsense"), null, "形状不对要返回 null，而不是硬猜");
  assert.equal(shortcutId("M", "5"), "m:5", "大小写归一");
});

test("被占用的键（L = 建单）与其它序列互不干扰", () => {
  for (const reserved of RESERVED_SHORTCUT_KEYS) {
    assert.equal(
      (SCRIPT_SHORTCUT_KEYS as readonly string[]).some((id) => parseShortcutId(id)?.key === reserved),
      false,
      `被占用的键 ${reserved} 不许出现在剧本快捷键里`,
    );
  }
  /* Ctrl+Q+L（建单）是**另一条**序列，键位仍归它：走到这里必须是 ignore */
  const state = arm("b", 0);
  assert.equal(advanceSequence({ key: "l", ctrlKey: true }, state, 50).kind, "ignore");
  /* Ctrl+B 之后按 "l" 也一样（l 不在任何段的键表里） */
  assert.equal(advanceSequence(key("l"), state, 50).kind, "ignore");
});

test("与建单快捷键的窗口常量保持一致（两条序列一套口径）", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../useWorkOrderShortcut.ts", import.meta.url), "utf8"),
  );
  const match = /SEQUENCE_WINDOW_MS = (\d+)/.exec(src);
  assert.ok(match, "useWorkOrderShortcut.ts 里应当有 SEQUENCE_WINDOW_MS 常量");
  assert.equal(
    Number(match[1]),
    SCRIPT_SEQUENCE_WINDOW_MS,
    "两条序列的窗口必须一致：一个 1.5 秒、一个 2 秒会让讲解人按不准",
  );
});

/* ── 「一条龙」组合键（用户 2026-09-17：ctrl加shift加z，25个对话循环播放，按一下播放一个）── */

test("一条龙键 = Ctrl+Shift+Z：修饰键差一个都不认", () => {
  const walk = (extra: Partial<KeyLike> = {}) => ({ key: "z", ctrlKey: true, shiftKey: true, ...extra });
  assert.equal(isWalkKey(walk()), true, "Ctrl+Shift+Z 就是一条龙键");
  assert.equal(walkKeyLabel(), "Ctrl+Shift+Z", "给人看的写法只有这一处实现");
  assert.equal(isWalkKey(walk({ shiftKey: false })), false, "没按 Shift 不算（那是单条键位的地盘）");
  assert.equal(isWalkKey(walk({ ctrlKey: false })), false, "没按 Ctrl 不算（裸 Z 是普通输入）");
  assert.equal(isWalkKey(walk({ altKey: true })), false, "多按 Alt 不算，免得撞 Alt+W/E/R/M");
  assert.equal(isWalkKey(walk({ metaKey: true })), false);
  assert.equal(isWalkKey(walk({ key: "x" })), false, "别的字母不算");
  assert.equal(isWalkKey(walk({ repeat: true })), false, "长按 repeat 不参与（否则一路自己走完 25 条）");
  assert.equal(isWalkKey(walk({ isComposing: true })), false, "输入法组字期间不参与");
  /* 输入框里 Ctrl+Shift+Z 是原生"重做"，不许被抢 */
  assert.equal(isWalkKey(walk({ target: { tagName: "INPUT" } })), false);
  assert.equal(isWalkKey(walk({ target: { tagName: "TEXTAREA" } })), false);
  assert.equal(isWalkKey(walk({ target: { tagName: "DIV", isContentEditable: true } })), false);
});

test("一条龙键不落在浏览器保留的 Ctrl+Shift 组合里（拦不住的键不能用）", () => {
  /*
    `Ctrl+Shift+N`（无痕窗口）、`Ctrl+Shift+T`（重开刚关掉的标签）、`Ctrl+Shift+W`（关窗口）
    都是浏览器**保留键**，页面 preventDefault 也拦不住 —— 两次换键位的教训见实现里的名单。
    `Ctrl+Shift+Z` 只有编辑类动作（输入框里的"重做"），不是浏览器级动作，所以可以用。
  */
  for (const reserved of ["n", "t", "w"]) {
    assert.notEqual(SCRIPT_WALK_KEY.key, reserved, `Ctrl+Shift+${reserved.toUpperCase()} 是浏览器保留键`);
  }
  assert.equal(SCRIPT_WALK_KEY.ctrl, true);
  assert.equal(SCRIPT_WALK_KEY.shift, true);
  /* 一条龙键也不能与三段键位的段前缀混为一谈：它不参与"段前缀 + 数字"的判定 */
  assert.equal(SCRIPT_SEQUENCE_PREFIX_KEYS.includes(SCRIPT_WALK_KEY.key), false);
});

test("一条龙游标：按一下走一条，走到第 25 条回到第 1 条", () => {
  assert.equal(nextScriptIndex(null, 25), 0, "还没播过 → 第 1 条");
  assert.equal(nextScriptIndex(0, 25), 1);
  assert.equal(nextScriptIndex(12, 25), 13);
  assert.equal(nextScriptIndex(24, 25), 0, "第 25 条之后回到第 1 条（用户口径「循环播放」）");
  assert.equal(nextScriptIndex(25, 25), 0, "越界当没播过，从头开始而不是跳到不存在的一条");
  assert.equal(nextScriptIndex(-1, 25), 0);
  assert.equal(nextScriptIndex(1.5, 25), 0, "非法下标不许算出下一条");
  assert.equal(nextScriptIndex(3, 0), 0, "没有条目时也不许抛错");
  /* 连按 25 下正好把 25 条各走一遍，第 26 下回到第 1 条 */
  const seen: number[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < 25; i += 1) {
    cursor = nextScriptIndex(cursor, 25);
    seen.push(cursor);
  }
  assert.deepEqual(seen, [...Array(25).keys()], "一条龙必须按文档顺序走完 25 条，不重不漏");
  assert.equal(nextScriptIndex(cursor, 25), 0, "第 26 次按回到第 1 条");
});
