/**
 * 快捷键一览 · 单测（纯数据，不起 DOM）
 *
 * 这一组防的是**表错位**：气泡里那张一览表是现场唯一能看的说明书，
 * 一旦"第 7 个键配了第 8 轮的话"，按下去就串戏，而且没人会发现。
 * 所以逐条核对三个来源（条目表 / 剧本 / 键位序）是否对得上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, mainLineOf } from "./script.ts";
import { SCRIPT_SHORTCUT_ENTRIES } from "./scriptShortcutEntries.ts";
import { SCRIPT_SHORTCUT_KEYS, shortcutLabel, walkKeyLabel } from "./scriptShortcutSequence.ts";
import { keyLabel, shortcutSheetRows, walkShortcutNote } from "./shortcutSheet.ts";

test("一览表的行数 = 剧本轮数 = 条目数（第 N 个键 = 第 N 轮）", () => {
  const rows = shortcutSheetRows();
  assert.equal(rows.length, SCRIPT_ROUNDS.length);
  assert.equal(rows.length, SCRIPT_SHORTCUT_ENTRIES.length);
  assert.ok(rows.length >= 25, `行数只有 ${rows.length}，应该覆盖整本剧本`);
});

test("每一行的键位、轮次、台词都与其来源逐字一致", () => {
  const rows = shortcutSheetRows();
  rows.forEach((row, index) => {
    const entry = SCRIPT_SHORTCUT_ENTRIES[index];
    const round = SCRIPT_ROUNDS[index];
    assert.equal(entry.roundNo, round.roundNo, `第 ${index + 1} 行的条目与轮次错位`);
    assert.equal(row.keys, keyLabel(entry.key), `第 ${index + 1} 行的键位不对`);
    assert.equal(row.round, `${round.roundNo} ${round.title}`, `第 ${index + 1} 行的轮次标题不对`);
    assert.equal(row.reply, mainLineOf(round), `第 ${index + 1} 行的小木台词与剧本不一致`);
    assert.ok(row.how.trim().length > 0, `第 ${index + 1} 行没写怎么触发`);
  });
});

test("键位序与序列实现同源（一览表不会自成一套键位）", () => {
  const rows = shortcutSheetRows();
  rows.forEach((row, index) => {
    const id = SCRIPT_SHORTCUT_KEYS[index];
    assert.equal(row.keys, shortcutLabel(id), `第 ${index + 1} 行与 SCRIPT_SHORTCUT_KEYS 的第 ${index + 1} 位不一致`);
  });
  /* 三段前缀各自的键位文本必须真的出现在表里（缺一段说明前缀串了） */
  for (const sample of ["Ctrl+B+1", "Ctrl+Y+1", "Ctrl+M+1", "Ctrl+M+5"]) {
    assert.ok(
      rows.some((row) => row.keys === sample),
      `一览表里没有 ${sample} —— 三段前缀（B/Y/M）应当各出现在自己的段里`,
    );
  }
});

test("主动发起的条目在表里写「按钮触发，不用说话」", () => {
  const rows = shortcutSheetRows();
  const proactive = SCRIPT_SHORTCUT_ENTRIES.map((entry, index) => (entry.proactive ? index : -1)).filter(
    (index) => index >= 0,
  );
  assert.ok(proactive.length >= 1, "至少应有一条主动发起的条目");
  for (const index of proactive) {
    assert.equal(rows[index].how, "按钮触发，不用说话", `第 ${index + 1} 行是主动发起，说明写错了`);
  }
  /* 反向：非主动发起的行不许写成"不用说话"（那会让人以为按键没反应） */
  rows.forEach((row, index) => {
    if (SCRIPT_SHORTCUT_ENTRIES[index].proactive) return;
    assert.notEqual(row.how, "按钮触发，不用说话", `第 ${index + 1} 行不是主动发起，却写着不用说话`);
  });
});

test("「一条龙」组合键那一行的文本与键位唯一实现同源", () => {
  /*
    用户口径 2026-09-17：「专门搞一个组合键用于完整走完流程。ctrl加shift加z，
    25个对话循环播放，按一下播放一个」。这一行是不用记 25 个键位的那条路，
    所以键位文本不许在页面里手写 —— 必须来自 `walkKeyLabel()`，
    条数也必须跟着一览表的实际行数走（剧本加一条就自动写成 26）。
  */
  const note = walkShortcutNote(25);
  assert.ok(note.includes(walkKeyLabel()), `说明里必须带上组合键：${note}`);
  assert.ok(note.includes("25"), `说明里要写清走到第几条：${note}`);
  assert.ok(walkShortcutNote(26).includes("26"), "条数来自调用方（一览表行数），不写死 25");
});
