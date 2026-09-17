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
import { SCRIPT_SHORTCUT_KEYS, SCRIPT_SEQUENCE_PREFIX_KEY } from "./scriptShortcutSequence.ts";
import { SHEET_PREFIX, keyLabel, shortcutSheetRows } from "./shortcutSheet.ts";

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
    assert.equal(row.keys, `${SHEET_PREFIX}+${keyLabel(entry.key)}`, `第 ${index + 1} 行的键位不对`);
    assert.equal(row.round, `${round.roundNo} ${round.title}`, `第 ${index + 1} 行的轮次标题不对`);
    assert.equal(row.reply, mainLineOf(round), `第 ${index + 1} 行的小木台词与剧本不一致`);
    assert.ok(row.how.trim().length > 0, `第 ${index + 1} 行没写怎么触发`);
  });
});

test("键位序与序列实现同源（一览表不会自成一套键位）", () => {
  const rows = shortcutSheetRows();
  rows.forEach((row, index) => {
    const key = SCRIPT_SHORTCUT_KEYS[index];
    assert.equal(
      row.keys,
      `${SHEET_PREFIX}+${keyLabel(key)}`,
      `第 ${index + 1} 行与 SCRIPT_SHORTCUT_KEYS 的第 ${index + 1} 位不一致`,
    );
  });
  assert.equal(SHEET_PREFIX, `Ctrl+${SCRIPT_SEQUENCE_PREFIX_KEY.toUpperCase()}`);
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
