/**
 * 同步备份小窗的回归测试
 * ── 这一组在防什么 ──────────────────────────────────────────────
 *   1. **不穿帮**：小窗里不能出现"云端 / 联网 / 上传"这类与纯本地演示相矛盾的词，
 *      也不能出现没有出处的数字（假速度、假剩余时间）。判据是**反向禁用词**，
 *      因为这类文案最容易在"想做得像一点"时被顺手加进去。
 *   2. **数字有出处**：备份对象必须逐条等于当前工单的 `attachments`
 *      （名字与体量都取自那里），语音段数是外部传入的真实值；
 *      传入 0 时**不许**显示段数，而不是编一个数。
 *   3. **停留够读完**：最后一条的浮现时刻必须早于自动收起的时刻，
 *      且两者用同一个节拍常量 —— 否则改一处就会"窗关了还有条目没出现"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WORK_ORDER } from "../seed/scenario.ts";
import {
  SYNC_MAX_MS,
  SYNC_MIN_MS,
  SYNC_PER_ENTRY_MS,
  SYNC_SOURCE_NOTE,
  buildSyncBackupStream,
  durationMsOf,
} from "./syncBackup.ts";

test("备份对象逐条等于当前工单的附件清单（名字与体量都不改写）", () => {
  const stream = buildSyncBackupStream(64);
  assert.deepEqual(
    stream.entries.map((item) => ({ name: item.name, size: item.size })),
    WORK_ORDER.attachments.map((item) => ({ name: item.name, size: item.sizeText })),
    "小窗里的对象必须就是工单附件本身，不能另写一份清单",
  );
  assert.ok(stream.entries.length >= 5, "备份对象太少说明取错了数据源");
  for (const entry of stream.entries) assert.equal(entry.state, "已同步");
});

test("文案不含穿帮词：不写云端 / 联网 / 上传，也不给假速度与假剩余时间", () => {
  const stream = buildSyncBackupStream(64);
  const text = [
    stream.title,
    stream.summary,
    SYNC_SOURCE_NOTE,
    stream.voiceLine.name,
    ...stream.entries.map((entry) => entry.name),
  ].join(" ");
  for (const banned of ["云端", "联网", "上传", "速度", "剩余", "云备份", "第三方"]) {
    assert.equal(text.includes(banned), false, `小窗文案出现穿帮词「${banned}」`);
  }
  /* 纯本地这件事要**正面**说清，而不是含糊带过 */
  assert.ok(SYNC_SOURCE_NOTE.includes("本地") || SYNC_SOURCE_NOTE.includes("本机"), "结论里必须说明数据在本机");
});

test("语音段数取不到时不编数字：那一行显示「—」且结论只报附件数", () => {
  const stream = buildSyncBackupStream(0);
  assert.equal(stream.voiceLine.size, "—", "取不到段数就如实留空，不许凑一个数");
  assert.ok(
    !/语音/.test(stream.summary) || stream.summary.includes("附件"),
    "结论在缺段数时仍应说清已同步的附件数",
  );
  assert.equal(stream.summary.includes("0 段"), false, "不能显示「0 段」这种像出错的说法");
});

test("停留时长够读完：最后一条（含语音行）浮现完成早于自动收起，且夹在区间内", () => {
  const stream = buildSyncBackupStream(64);
  /*
    行数比"工单附件数"多一行：末尾还有固定的语音包行。
    面板与计数都按 `entries.length + 1` 行排（`(total + 1) * perEntryMs`），
    所以这里的判据也必须是 +1 —— 差一行就会"窗关了还有行没出现"。
  */
  const lastRowAt = (stream.entries.length + 1) * SYNC_PER_ENTRY_MS;
  assert.ok(
    stream.autoCloseMs > lastRowAt,
    `自动收起 ${stream.autoCloseMs}ms 必须大于最后一行（含语音行）的出现时刻 ${lastRowAt}ms`,
  );
  assert.ok(stream.autoCloseMs >= SYNC_MIN_MS && stream.autoCloseMs <= SYNC_MAX_MS);
});

test("时长随条数增长（不是写死的），并在上下限处夹住", () => {
  assert.equal(durationMsOf(1), SYNC_MIN_MS, "条目很少时用下限兜底");
  assert.equal(durationMsOf(100), SYNC_MAX_MS, "条目很多时用上限封顶");
  assert.ok(durationMsOf(14) > durationMsOf(12), "条数增加时停留应当变长");
  assert.ok(SYNC_MIN_MS > 0 && SYNC_MAX_MS > SYNC_MIN_MS);
});
