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
 * 判据来源：`script.ts` 的 25 轮 + `scriptShortcutEntries.ts` 的表，两边对读。
 * 2026-09-17 重排后，用户文档 25 条与 25 轮**一一对应**（每条只有一个回答），
 * 三份权威（文档顺序 / 轮次顺序 / 键位顺序）已经是同一个顺序，表里不再有 `lineOverride`。
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

/** 轮次 → 指向它的条目（重排后一轮一条，这个 Map 仍按"可能多条"处理，多出来的会被下面的用例逮住） */
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

test("25 轮每轮都至少有一个快捷键能直达（没有进不去的轮次）", () => {
  assert.equal(SCRIPT_ROUNDS.length, 25, "剧本已按用户文档重排为 25 轮");
  const unreachable = SCRIPT_ROUNDS.filter((r) => !entriesByRound.has(r.roundNo));
  assert.deepEqual(
    unreachable.map((r) => `${r.roundNo} ${r.title}`),
    [],
    "这些轮次没有任何快捷键指向，现场进不去",
  );
});

test("条目与轮次一一对应（25 轮 25 条，多绑/漏绑都不许）", () => {
  /*
    重排后文档 25 条与 25 轮是 1:1：一轮只由一条快捷键直达。
    旧表里一轮挂多条是为了"同一轮念备用句"，那个需求已经随 `lineOverride` 一起消失。
    这条把"一一对应"钉死：以后谁再加回一轮两条，必须同时想清楚备用句怎么播。
  */
  assert.equal(SCRIPT_SHORTCUT_ENTRIES.length, SCRIPT_ROUNDS.length, "条目数与轮次数必须相等");
  const multi = [...entriesByRound].filter(([, list]) => list.length > 1);
  assert.deepEqual(
    multi.map(([roundNo, list]) => `${roundNo}×${list.length}`),
    [],
    "这些轮次被多条快捷键指向（一轮只有一句回答，多绑没有意义）",
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

test("键位顺序 = 剧本出场顺序（三段：Ctrl+B+1..0 → Ctrl+J+1..0 → Ctrl+M+1..5）", () => {
  /*
    表里用的是**文档条号 + 圈号标签**，而剧本用的是圈号；键位顺序则是三段数字键。
    三份顺序必须同时对齐：这里不重打映射，而是用"键位 id 在该键表里的下标"与
    "条目在表中的出场顺序"交叉验证 —— 顺序错位会让"第 N 个键"落到别的轮次上。
    ⚠ 2026-09-17 起键位是复合 id（`"b:1"`）：同一个数字键在三段里含义不同，
      所以这里比对的是 id 而不是裸数字。
  */
  const positions = SCRIPT_SHORTCUT_ENTRIES.map((e) => ALLOWED_KEYS.indexOf(e.key));
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, "键位没有按剧本顺序排列");
  assert.deepEqual(
    positions,
    Array.from({ length: ALLOWED_KEYS.length }, (_, i) => i),
    "键位必须把键表用满且各用一次（有缺口就说明表过期了）",
  );
  /* 逐条对齐圈号：第 i 个键 = 剧本第 i 轮 */
  SCRIPT_SHORTCUT_ENTRIES.forEach((entry, i) => {
    assert.equal(
      entry.roundNo,
      SCRIPT_ROUNDS[i]?.roundNo,
      `第 ${i + 1} 个键（${entry.key}）应当直达剧本第 ${i + 1} 轮 ${SCRIPT_ROUNDS[i]?.roundNo}，现在指向 ${entry.roundNo}`,
    );
  });
});

test("每条条目的触发语都是非空文本（空文本会被识别链路丢掉）", () => {
  for (const entry of SCRIPT_SHORTCUT_ENTRIES) {
    assert.ok(
      entry.text.trim().length > 0,
      `${entry.label} 的触发语是空的 —— 现场按下后会静默无反应`,
    );
  }
});

test("⑬ 轮（无触发语的那轮）用该段台词兜底，且指向 ⑬", () => {
  /*
    剧本里 ⑬（段230，重排前的 ⑪）是**小木主动起头**的一轮：`triggerSource: "local-event"`、
    `triggers` 为空，没有别人说的触发语。它必须仍然可直达：条目表用该段小木自己的台词
    当"听到的话"，并指到 ⑬。否则 `Ctrl+J+3` 会像早期实现那样按了毫无反应。
    （早期版本这里盯的是"⑪ 轮"，重排后无触发语那轮挪到了 ⑬，钉的仍然是不变量本身。）
  */
  const r13 = SCRIPT_ROUNDS.find((r) => r.roundNo === "⑬");
  assert.ok(r13, "剧本里没有 ⑬ 轮");
  /* 先确认"⑬ 确实是无触发语那轮"，否则这条用例会在轮次再挪位时悄悄失去意义 */
  assert.equal(r13!.triggerSource, "local-event", "⑬ 轮应当由本地任务事件触发");
  assert.deepEqual(r13!.triggers, [], "⑬ 轮不该有触发语（语音不得抢触发）");
  const entry = SCRIPT_SHORTCUT_ENTRIES.find((e) => e.roundNo === "⑬");
  assert.ok(entry, "没有指向 ⑬ 轮的快捷键");
  assert.equal(entry.text, mainLineOf(r13!), "⑬ 轮那条应当直接模拟该段台词（剧本里它没有触发语）");
});

test("表里没有 lineOverride，且 text 都能过识别链路（出现覆写字段就说明表过期了）", () => {
  /*
    ⚠ 这条替换掉了原来的"lineOverride 必须是该轮里真实存在的一句"。
    为什么换：`replyScript` 会在 `lineOverride` 与本轮 `lines[].text` 逐字比对失败时
    **静默退回主台词**，所以旧断言钉的是"覆写句必须逐字存在"。重排后用户文档 25 条与
    25 轮一一对应、每条只有一个回答，`lineOverride` 这个机制**已经没有任何轮次用得上**——
    继续钉"覆写句存在"等于对空集合做断言（恒真），反而放过了真正的风险：
    表还是按旧轮次生成的（或有人手改回一句覆写），现场就会"按了这条、念了别句"。

    ⚠ 这里**不能**顺手改成"text 必须逐字等于本轮主台词"（第一版就这么写，跑出来 22 条红）：
    重排后条目的 text 是**用户在文档里说的那半句**（22 条），只有文档写「按钮触发。」的
    ⑥⑬⑳ 用该轮小木自己的台词 —— 逐字相等只对那 3 条成立。而用户那句话本来就不在
    `script.ts` 里（剧本只存小木的回答，用户台词由文档给），所以"逐字同源"这个锁
    在这张表上根本没有可对读的源，硬造一个只会是假锁。

    真正该锁的是"表与 25 轮 1:1、键位不串、文本可用"这三件事：
      1. 不许出现 `lineOverride`（一轮一句回答，覆写已无处可指；出现即表过期）；
      2. 每条 text 非空、能过识别链路（与 `useScriptShortcut.trigger` 的
         `if (!entry.text.trim() && !entry.roundNo) return;` 同一口径；
         空文本会在 `onFinal` 被丢掉 —— 早期"按了 Ctrl+Q+B 没反应"就是这个原因）；
      3. 条目与轮次一一对应且圈号不重复（重复即两条键模拟同一句、清单与音频对不上）。
    "哪个键 → 哪一轮"的逐条对齐由上面「键位顺序 = 剧本出场顺序」那条用例钉住。
  */
  const withOverride = SCRIPT_SHORTCUT_ENTRIES.filter(
    (e) => "lineOverride" in e && e.lineOverride !== undefined,
  );
  assert.deepEqual(
    withOverride.map((e) => `${e.label} → ${e.lineOverride}`),
    [],
    "这些条目还带 lineOverride：一轮只有一句回答，覆写句已经无处可指，表需要重新生成",
  );

  for (const entry of SCRIPT_SHORTCUT_ENTRIES) {
    assert.ok(
      entry.text.trim().length > 0,
      `${entry.label} 的 text 是空的，识别链路会把它丢掉 —— 现场按下后静默无反应`,
    );
    /* 每轮只有一句 main（⑥ 的 waiting、⑰ 的 audit 是备用播报，不参与按键直达）：
       main 不唯一，"这一轮念哪句"就又得靠猜了 */
    const round = SCRIPT_ROUNDS.find((r) => r.roundNo === entry.roundNo);
    assert.ok(round, `${entry.label} 指向的轮次不存在`);
    assert.equal(
      round!.lines.filter((l) => l.role === "main").length,
      1,
      `第 ${entry.roundNo} 轮的 main 台词不唯一，按键直达就没有确定的落点`,
    );
  }

  const roundNos = SCRIPT_SHORTCUT_ENTRIES.map((e) => e.roundNo);
  assert.equal(
    new Set(roundNos).size,
    roundNos.length,
    `有轮次被两条快捷键指向：${roundNos.join(",")}（一轮一句回答，多绑只会互相盖住）`,
  );
});
