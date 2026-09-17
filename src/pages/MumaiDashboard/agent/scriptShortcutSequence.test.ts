/**
 * 剧本快捷键序列判定的单测
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * Ctrl+M+N 是两段式序列，判定里全是时间窗与修饰键条件。写错的后果分两种，
 * 都很隐蔽：
 *   · 太宽 → 用户按 Ctrl+M 想干别的（或输入法选词）时**凭空触发一轮对话**；
 *   · 太严 → 现场按键没反应，讲解人以为功能坏了。
 * 所以每条口径都单独钉一个用例。
 *
 * ── 2026-09-17 前缀换键（Q → M）────────────────────────────────
 * 前缀从 Q 改成 M（`SCRIPT_SEQUENCE_PREFIX_KEY`），目标键也从"9 个数字 + 一串字母"
 * 改成**键盘行序** 25 个（`1..0` → `q` 那一排 → `a` 那一排）。
 * 这一组里凡是写着"先按哪个键"的地方都用常量而不是字面量：
 * 前缀是 M，目标键表 25 个 —— 键表一变，这里跟着一起变，不会留下过期口径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESERVED_SHORTCUT_KEYS,
  SCRIPT_SEQUENCE_PREFIX_KEY,
  SCRIPT_SEQUENCE_WINDOW_MS,
  SCRIPT_SHORTCUT_KEYS,
  advanceSequence,
  initialSequenceState,
  type KeyLike,
} from "./scriptShortcutSequence.ts";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: true,
  ...extra,
});

test("Ctrl+M 之后按数字 → 命中对应的那一条", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 1000);
  assert.equal(armed.kind, "armed");
  const fired = advanceSequence(key("1"), armed.state, 1200);
  assert.equal(fired.kind, "fire");
  assert.equal(fired.kind === "fire" ? fired.key : "", "1");
  /* 命中之后序列清空：再按一次数字不该重复触发 */
  assert.equal(fired.state.armed, false);
  assert.equal(advanceSequence(key("1"), fired.state, 1300).kind, "ignore");
});

test("超出 1.5 秒窗口 → 不命中，且半截序列被清掉", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  const late = advanceSequence(key("2"), armed.state, SCRIPT_SEQUENCE_WINDOW_MS + 1);
  assert.equal(late.kind, "ignore");
  assert.equal(late.state.armed, false, "过期后必须清状态，否则下一次按键会被当成序列后半截");
});

test("窗口边界：刚好等于窗口仍算命中（闭合边界）", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  assert.equal(advanceSequence(key("3"), armed.state, SCRIPT_SEQUENCE_WINDOW_MS).kind, "fire");
});

test("没有先按 M 就直接按数字 → 不命中", () => {
  assert.equal(advanceSequence(key("4"), initialSequenceState, 500).kind, "ignore");
});

test("修饰键不合规就不命中，并清掉半截序列", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  /* 松开 Ctrl 再按数字 */
  assert.equal(advanceSequence({ key: "5", ctrlKey: false }, armed.state, 100).kind, "ignore");
  /* 带 Alt 或 Meta 也不算 */
  assert.equal(advanceSequence(key("6", { altKey: true }), armed.state, 100).kind, "ignore");
  assert.equal(advanceSequence(key("7", { metaKey: true }), armed.state, 100).kind, "ignore");
  /* 不合规的按键必须把 armed 状态清掉，防止"Ctrl 松了也算" */
  const afterBad = advanceSequence(key("8", { altKey: true }), armed.state, 100);
  assert.equal(afterBad.state.armed, false);
});

test("长按产生的 repeat 与输入法组字期间不参与", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  assert.equal(advanceSequence(key("1", { repeat: true }), armed.state, 50).kind, "ignore");
  assert.equal(advanceSequence(key("1", { isComposing: true }), armed.state, 50).kind, "ignore");
});

test("输入框 / 文本域 / 可编辑区域里不触发", () => {
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  const cases = [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ];
  /*
    ⚠ 状态必须**跟着判定结果往后传**（每次用上一次返回的 state）。
    第一版这里反复拿同一个 `armed.state` 去喂：前几次判定一旦命中就把序列清空，
    后面的用例自然全变 ignore —— 那是测试自己把状态用掉了，不是实现的问题。
  */
  let state = armed.state;
  for (const target of cases) {
    const verdict = advanceSequence(key("1", { target }), state, 50);
    assert.equal(verdict.kind, "ignore", `不该在 ${JSON.stringify(target)} 里触发`);
    state = verdict.state;
  }
  /* 普通容器里照常触发（此时序列仍是 armed，因为上面的判定都没消费它） */
  assert.equal(advanceSequence(key("1", { target: { tagName: "DIV" } }), state, 50).kind, "fire");
});

test("目标键集合 = 键盘行序 25 个（1..0 → q 那一排 13 个 → a、s）", () => {
  const keys = [...SCRIPT_SHORTCUT_KEYS];
  /* 键表顺序 = 用户《小木对话总文案.txt》25 条的顺序，现场"照着文档往下按"就是
     键盘从左到右一排排按；错一位就会"按了第 7 个键，小木念第 8 条"。 */
  assert.deepEqual(
    keys,
    [
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
      "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\",
      "a", "s",
    ],
    "键表必须是键盘行序：前 10 个数字 → q 那一排 13 个 → a、s",
  );
  assert.equal(keys.length, 25, "25 个键对应文档 25 条对话");
  assert.equal(new Set(keys).size, keys.length, `键表里有重复键：${keys.join(",")}`);
  for (const reserved of RESERVED_SHORTCUT_KEYS) {
    /* `keys` 的元素类型是字面量联合（不含保留键），所以这里先转成 string[] 再查：
       直接用 `keys.includes(reserved)` 会被 tsc 判成"不可能相等"而报错 ——
       那恰恰说明这个断言在编译期就已经成立，运行期再确认一次更保险。 */
    assert.equal((keys as readonly string[]).includes(reserved), false, `被占用的键 ${reserved} 不许出现在剧本快捷键里`);
  }
  /* Ctrl+Q+L（建单）是**另一条**序列，键位仍归它：走到这里必须是 ignore */
  const armed = advanceSequence(key(SCRIPT_SEQUENCE_PREFIX_KEY), initialSequenceState, 0);
  assert.equal(advanceSequence({ key: "l", ctrlKey: true }, armed.state, 50).kind, "ignore");
  /* 键表里的键（首尾都试）照常命中：前缀键自己不算目标键 */
  assert.equal(advanceSequence(key("a"), armed.state, 50).kind, "fire");
  assert.equal(advanceSequence(key("s"), armed.state, 50).kind, "fire");
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
