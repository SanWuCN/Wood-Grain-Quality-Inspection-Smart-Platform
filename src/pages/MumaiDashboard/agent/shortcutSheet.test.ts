/**
 * 气泡里的**对话一览** · 单测（纯数据，不起 DOM）
 *
 * 这一组防两件事：
 *   ① **表错位**：一览是现场唯一能看的说明书，一旦"第 7 条配了第 8 轮的话"，
 *      照着说就串戏，而且没人会发现 —— 所以逐条核对两个来源是否对得上；
 *   ② **键位不许回到屏幕上**（用户 2026-10-01：「小木气泡快捷键显示删了」）：
 *      这一览的数据里不该再出现 `Ctrl` 字样 —— 有人顺手把键位列加回来，这条会红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, mainLineOf } from "./script.ts";
import { SCRIPT_SHORTCUT_ENTRIES } from "./scriptShortcutEntries.ts";
import { shortcutSheetRows } from "./shortcutSheet.ts";

test("一览表的行数 = 剧本轮数 = 条目数（第 N 条 = 第 N 轮）", () => {
  const rows = shortcutSheetRows();
  assert.equal(rows.length, SCRIPT_ROUNDS.length);
  assert.equal(rows.length, SCRIPT_SHORTCUT_ENTRIES.length);
  assert.ok(rows.length >= 25, `行数只有 ${rows.length}，应该覆盖整本剧本`);
});

test("每一行的轮次、台词都与其来源逐字一致", () => {
  const rows = shortcutSheetRows();
  rows.forEach((row, index) => {
    const entry = SCRIPT_SHORTCUT_ENTRIES[index];
    const round = SCRIPT_ROUNDS[index];
    assert.equal(entry.roundNo, round.roundNo, `第 ${index + 1} 行的条目与轮次错位`);
    assert.equal(row.round, `${round.roundNo} ${round.title}`, `第 ${index + 1} 行的轮次标题不对`);
    assert.equal(row.reply, mainLineOf(round), `第 ${index + 1} 行的小木台词与剧本不一致`);
    assert.ok(row.how.trim().length > 0, `第 ${index + 1} 行没写怎么触发`);
  });
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

test("一览里不再出现键位（用户 2026-10-01：「小木气泡快捷键显示删了」）", () => {
  const rows = shortcutSheetRows();
  for (const row of rows) {
    for (const value of [row.round, row.how, row.reply]) {
      assert.equal(
        /ctrl|shift|alt/i.test(value),
        false,
        `第 ${row.index} 行的「${value.slice(0, 24)}…」里出现了键位字样 —— 键位不该再画在气泡上`,
      );
    }
  }
});
