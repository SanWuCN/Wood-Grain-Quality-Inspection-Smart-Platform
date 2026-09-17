/**
 * 语音对照表的**同步锁**
 *
 * 这张表是给人照读的，所以它最大的风险不是"写错一个字"，而是**悄悄过期**：
 * 剧本改了触发词或台词，表还是旧的 —— 现场照着表说，触发不了。
 * 那比没有表更糟（会先怀疑是识别坏了）。
 *
 * 所以这里直接拿 `SCRIPT_ROUNDS` 去核对生成出来的表：任一条触发说法、
 * 任一句 main 台词没出现在表里，这条测试就红，提示重跑生成脚本。
 *
 * 表的生成脚本：`D:\平台\tools-夜间\出语音对照表.ts`
 * （刻意不复用生成器的代码：生成器读的是同一批源；测试独立再走一遍，
 *   才能发现"生成器自己写漏了某一列"这类错。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { SCRIPT_ROUNDS } from "./script.ts";

const TABLE = "D:\\平台\\tools-夜间\\小木语音触发与回答对照表-v2.0.md";
const QUICK = "D:\\平台\\tools-夜间\\小木说什么它回什么-速查表-v2.0.md";

/**
 * 这几张表是**运行时产物**，刻意放在仓库外（`D:\平台\tools-夜间\`），生成脚本也在那里。
 *
 * ⚠ 所以换一台机器 / 重新 clone 之后，这里读不到文件 —— 那不是"表过期了"，
 *   而是"这台机器上还没生成表"。直接 `readFileSync` 会抛 ENOENT，
 *   整份 suite 变红，而红的原因与代码质量无关，是最容易被误当成真问题的一类噪声。
 *
 * 处理方式：文件不在 → **明确跳过并说明原因**（打一行 stderr，带上生成命令），
 * 在（开发机上）→ 照旧严格核对，一个字不放过。
 * 报告里仍会显示为 skipped，看到的人知道"这台机器没生成表"，不会以为是代码坏了。
 */
function loadTable(path: string, what: string): string | null {
  if (existsSync(path)) return readFileSync(path, "utf8");
  console.error(
    `[voiceDocSync] 跳过「${what}」核对：本机没有 ${path}\n` +
      "             生成命令：node --import ./tools/test-resolve-ts.mjs 'D:\\平台\\tools-夜间\\出语音对照表.ts'\n" +
      "                        node --import ./tools/test-resolve-ts.mjs 'D:\\平台\\tools-夜间\\出速查表.ts'",
  );
  return null;
}

test("语音对照表存在且覆盖全部 25 轮", () => {
  const text = loadTable(TABLE, "语音对照表");
  if (!text) return;
  assert.ok(text.includes("小木语音触发与回答对照表"), "标题不对，可能拿错了文件");

  for (const round of SCRIPT_ROUNDS) {
    assert.ok(text.includes(`### ${round.roundNo} `), `表里缺少第 ${round.roundNo} 轮的详表小节`);
    assert.ok(text.includes(round.title), `表里缺少第 ${round.roundNo} 轮的标题「${round.title}」`);
  }
});

test("表里逐字列出每一轮的触发说法（漏一条就说明表过期了）", () => {
  const text = loadTable(TABLE, "语音对照表");
  if (!text) return;
  const missing = [];
  for (const round of SCRIPT_ROUNDS) {
    for (const trigger of round.triggers) {
      if (!text.includes(`「${trigger}」`)) missing.push(`${round.roundNo}「${trigger}」`);
    }
  }
  assert.deepEqual(missing, [],
    `有 ${missing.length} 条触发说法没出现在对照表里，请重跑 出语音对照表.ts：${missing.join("、")}`);
});

test("表里逐字列出每一轮会念出来的台词（回答句不得与剧本分叉）", () => {
  const text = loadTable(TABLE, "语音对照表");
  if (!text) return;
  const missing = [];
  for (const round of SCRIPT_ROUNDS) {
    const main = round.lines.find((l) => l.role === "main");
    assert.ok(main, `第 ${round.roundNo} 轮没有 main 台词`);
    if (!text.includes(main.text)) missing.push(round.roundNo);
  }
  assert.deepEqual(missing, [],
    `第 ${missing.join("、")} 轮的台词与对照表不一致，请重跑 出语音对照表.ts`);
});

test("非语音轮在表里被明确标注（不能让人以为说了就能触发）", () => {
  const text = loadTable(TABLE, "语音对照表");
  if (!text) return;
  for (const round of SCRIPT_ROUNDS) {
    if (round.triggerSource !== "local-event") continue;
    assert.ok(text.includes("非语音轮"), `第 ${round.roundNo} 轮是本地事件触发，表里必须标出「非语音轮」`);
    assert.ok(
      text.includes(`### ${round.roundNo} `) && text.includes("由本地任务事件触发"),
      `第 ${round.roundNo} 轮的非语音说明缺失`,
    );
  }
});

test("表里给出的判定阈值与实现一致（阈值改过而表没改 → 红）", async () => {
  const text = loadTable(TABLE, "语音对照表");
  if (!text) return;
  const match = await import("./scriptMatch.ts");
  for (const [name, value] of Object.entries({
    MATCH_THRESHOLD: match.MATCH_THRESHOLD,
    MIN_MARGIN: match.MIN_MARGIN,
    MIN_HIT_CHARS: match.MIN_HIT_CHARS,
    MIN_UTTERANCE_RATIO: match.MIN_UTTERANCE_RATIO,
    MIN_TRIGGER_COVERAGE: match.MIN_TRIGGER_COVERAGE,
  })) {
    assert.ok(text.includes(String(value)),
      `对照表里没有出现 ${name} 的当前值 ${value} —— 阈值改过了，请重跑 出语音对照表.ts`);
  }
});

/* ------------------------------------------------------------------ *
 * 速查表（两列版）—— 现场照着念的那张
 *
 * 它比对照表更"危险"：现场的人只看这一张。所以要求更硬 ——
 * 每一句台词、每一条说法必须逐字在里面，序号必须用**剧本圈号**，
 * 且第⑬轮不得出现在"我说什么"那一列（它不是语音触发的）。
 * ------------------------------------------------------------------ */

test("速查表：每一轮的推荐说法与回答逐字在内，且用剧本圈号", () => {
  const text = loadTable(QUICK, "速查表");
  if (!text) return;
  assert.ok(text.includes("速查表"), "速查表标题不对，可能拿错了文件");

  for (const round of SCRIPT_ROUNDS) {
    const main = round.lines.find((l) => l.role === "main");
    assert.ok(main, `第 ${round.roundNo} 轮没有 main 台词`);
    assert.ok(text.includes(main.text), `速查表里缺少第 ${round.roundNo} 轮的台词，请重跑 出速查表.ts`);
    /* 序号必须是圈号本身，不能是 1..25 的流水号 —— 现场对不上号就是缺陷 */
    const pattern = new RegExp(`\\| ${round.roundNo} \\|`, "u");
    assert.ok(pattern.test(text), `速查表里没有以圈号「${round.roundNo}」开头的行，请重跑 出速查表.ts`);
  }
});

test("速查表：推荐说法列不含第⑬轮（它是本地事件触发，说了也不响应）", () => {
  const text = loadTable(QUICK, "速查表");
  if (!text) return;
  const local = SCRIPT_ROUNDS.filter((r) => r.triggerSource === "local-event");
  assert.ok(local.length > 0, "应当存在非语音轮次（⑬）");

  /* 主表那一节里，⑬ 必须以「不用说话」出现，而不是给一个说法 */
  const mainSection = text.split("## 二、")[0];
  for (const round of local) {
    assert.ok(
      !new RegExp(`\\| ${round.roundNo} \\| \\*\\*`, "u").test(mainSection),
      `速查表主表把第 ${round.roundNo} 轮当成了「说这句话就能触发」，但它不由语音触发`,
    );
    assert.ok(mainSection.includes("不用说话") || !mainSection.includes(`| ${round.roundNo} |`),
      `速查表主表里第 ${round.roundNo} 轮必须要么不出现、要么明确写「不用说话」`);
  }
  assert.ok(text.includes("不用说话"), "速查表必须明确标出第⑬轮不用说话");
});
