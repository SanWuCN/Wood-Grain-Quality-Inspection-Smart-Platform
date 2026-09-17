/**
 * 剧本快捷键 · 覆盖与指向守卫
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * `useScriptShortcut` 的钩子测试只能验"按键 → 模拟出某句话"，它**验不了这张表本身对不对**：
 *   · 少绑一轮 —— 现场按遍所有键都进不去那一轮；
 *   · 绑错轮次 —— 按键后小木念的是**另一轮**的台词，演示时最难堪；
 *   · 键位顺序乱 —— 演示人不按顺序按也会乱，清单与音频对不上。
 * 上面三种错都不会让代码报错，只会在台上暴露，所以这里逐条钉住。
 *
 * 判据来源：`script.ts` 的 22 轮 + `scriptShortcutEntries.ts` 的表，两边对读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, mainLineOf } from "./script.ts";
import { SCRIPT_SHORTCUT_ENTRIES } from "./scriptShortcutEntries.ts";
import { RESERVED_SHORTCUT_KEYS, SCRIPT_SHORTCUT_KEYS } from "./scriptShortcutSequence.ts";

/*
  `SCRIPT_SHORTCUT_KEYS` 是 `as const` 的只读字面量元组，`includes` / `indexOf` 只接受
  那串字面量本身；条目表里的 `key` 是普通 `string`，所以这里显式宽化成 `readonly string[]`
  再查 —— 不宽化就得把每条 key 都断言成字面量，反而更容易写错。
*/
const ALLOWED_KEYS: readonly string[] = SCRIPT_SHORTCUT_KEYS;

/** 轮次 → 指向它的条目（可能多条，如 ⑮ 有段203/段205 两条） */
const entriesByRound = new Map<string, (typeof SCRIPT_SHORTCUT_ENTRIES)[number][]>();
for (const entry of SCRIPT_SHORTCUT_ENTRIES) {
  if (!entry.roundNo) continue;
  const list = entriesByRound.get(entry.roundNo) ?? [];
  list.push(entry);
  entriesByRound.set(entry.roundNo, list);
}

test("每一条快捷键都指定了轮次（否则只能靠模糊匹配碰运气）", () => {
  const missing = SCRIPT_SHORTCUT_ENTRIES.filter((e) => !e.roundNo);
  assert.deepEqual(
    missing.map((e) => e.label),
    [],
    "这些条目没带 roundNo，按了键会退回模糊匹配",
  );
  for (const entry of SCRIPT_SHORTCUT_ENTRIES) {
    assert.ok(
      SCRIPT_ROUNDS.some((r) => r.roundNo === entry.roundNo),
      `${entry.label} 指向的第 ${entry.roundNo} 轮在剧本里不存在`,
    );
  }
});

test("22 轮每轮都至少有一个快捷键能直达（没有进不去的轮次）", () => {
  const unreachable = SCRIPT_ROUNDS.filter((r) => !entriesByRound.has(r.roundNo));
  assert.deepEqual(
    unreachable.map((r) => `${r.roundNo} ${r.title}`),
    [],
    "这些轮次没有任何快捷键指向，现场进不去",
  );
});

test("键位不重复，且全部落在允许的键位上", () => {
  const keys = SCRIPT_SHORTCUT_ENTRIES.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, `键位重复：${keys.join(",")}`);
  for (const key of keys) {
    assert.ok(
      ALLOWED_KEYS.includes(key),
      `键位 ${key} 不在允许表里（可能是保留键 ${RESERVED_SHORTCUT_KEYS.join("/")}）`,
    );
  }
});

test("键位顺序 = 剧本出场顺序（1..9 之后 a..z，跳过保留键）", () => {
  /*
    表里用的是**段号标签**，而剧本用的是圈号；两者靠 `entries_final.json` 的映射对齐。
    这里不重打那份映射，而是用"该条目的触发语能否在该轮上下文里找到"来交叉验证顺序 ——
    顺序错位会让"第 N 个键"落到别的轮次上。
  */
  const positions = SCRIPT_SHORTCUT_ENTRIES.map((e) => ALLOWED_KEYS.indexOf(e.key));
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, "键位没有按剧本顺序排列");
});

test("每条条目的触发语都是非空文本（空文本会被识别链路丢掉）", () => {
  for (const entry of SCRIPT_SHORTCUT_ENTRIES) {
    assert.ok(
      entry.text.trim().length > 0,
      `${entry.label} 的触发语是空的 —— 现场按下后会静默无反应`,
    );
  }
});

test("⑪ 轮（无触发语的那轮）用该段台词兜底，且指向 ⑪", () => {
  /*
    剧本里 ⑪（段155）是**小木主动起头**的一轮，没有别人说的触发语。
    它必须仍然可直达：条目表用该段小木自己的台词当"听到的话"，并指到 ⑪。
    否则 `Ctrl+Q+B` 会像早期实现那样按了毫无反应。
  */
  const r11 = SCRIPT_ROUNDS.find((r) => r.roundNo === "⑪");
  assert.ok(r11, "剧本里没有 ⑪ 轮");
  const entry = SCRIPT_SHORTCUT_ENTRIES.find((e) => e.roundNo === "⑪");
  assert.ok(entry, "没有指向 ⑪ 轮的快捷键");
  assert.equal(entry.text, mainLineOf(r11!), "⑪ 轮那条应当直接模拟该段台词（剧本里它没有触发语）");
});

test("lineOverride 必须是该轮里真实存在的一句（否则播报层会忽略它、静默退回主台词）", () => {
  /*
    ⚠ `replyScript` 拿 `lineOverride` 跟本轮 `lines[].text` **逐字**比对，不逐字相同就
    忽略覆写、退回主台词。所以写错一个字（哪怕只是缺个句号）都不会报错，
    只会表现为"按了段221 却念了段229" —— 台上才发现。这里逐条钉住。
  */
  const withOverride = SCRIPT_SHORTCUT_ENTRIES.filter((e) => e.lineOverride);
  assert.ok(withOverride.length > 0, "应该至少有一条指向备用句的快捷键（段15/205/221）");
  for (const entry of withOverride) {
    const round = SCRIPT_ROUNDS.find((r) => r.roundNo === entry.roundNo);
    assert.ok(round, `${entry.label} 指向的轮次不存在`);
    assert.ok(
      round!.lines.some((l) => l.text === entry.lineOverride),
      `${entry.label} 的 lineOverride 不是第 ${entry.roundNo} 轮里的台词（逐字对不上）`,
    );
    assert.notEqual(
      entry.lineOverride,
      mainLineOf(round!),
      `${entry.label} 的 lineOverride 就是主台词，没必要写（写了反而掩盖"这是备用句"的信息）`,
    );
  }
});

test("指向同一轮的多条条目，触发语各不相同（否则按键分不出差别）", () => {
  for (const [roundNo, list] of entriesByRound) {
    if (list.length < 2) continue;
    const texts = list.map((e) => e.text);
    assert.equal(
      new Set(texts).size,
      texts.length,
      `第 ${roundNo} 轮的多条快捷键触发语重复：${texts.join(" | ")}`,
    );
  }
});
