/**
 * 22 轮 · 台词逐字冻结（工作清单 v1.0 §7、§8）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * §8 给了每轮"小木固定回答"的**具体数字与措辞**，§7 又点名了 7 处必须改写的问题
 * （含 3 处 `xxxx`/`xxx` 占位符）。台词是演示的"事实输出"：
 * 念错一个数字，观众记下的就是错数字（比如把"缺失 34 帧"念成"缺了几帧"）。
 *
 * 所以这里逐轮钉住：
 *   · 台词里必须出现的**关键数字与标识符**（来自 §6 的冻结数据包）；
 *   · §7 点名的替换**必须已生效**（旧措辞不得复现）；
 *   · **不得残留占位符**（`xxx`/`xxxx`/`待补文案`，§10 阶段 F 要求全仓扫描）。
 *
 * ⚠ 只断言"必须含有的关键信息"，不逐字锁死整句：§7 的替换文案是逐字给定的，
 *   但那是给人读的对照表；真正要防的是**数字与结论走样**。
 *   逐字锁死的部分（§7 明文的替换句）单独列在下面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, mainLineOf } from "./script.ts";
import {
  FORBIDDEN_LEGACY_PHRASES,
  REQUIRED_REWRITE_PHRASES,
  SPEAKER_REWRITES_V1,
  findPlaceholders,
} from "./rehearsalScript.ts";

const lineOf = (no: string): string => {
  const round = SCRIPT_ROUNDS.find((r) => r.roundNo === no);
  assert.ok(round, `第 ${no} 轮不存在`);
  return mainLineOf(round!);
};

/* ------------------------------------------------------------------ *
 * 1. 关键数字必须出现在对应轮次的台词里（§6 + §8）
 * ------------------------------------------------------------------ */

test("每轮台词必须含 §6 冻结数据里的关键数字/标识（防数字走样）", () => {
  /*
    [轮次, 必须出现的片段…]
    片段取自 §8「小木固定回答摘要」列 —— 那是逐字给定的口径。
  */
  const required: [string, string[]][] = [
    ["①", ["四项任务", "现场建档", "风险初筛", "重点精扫", "复核交付", "Z01", "Z04"]],
    ["②", ["412.0", "37", "78%", "17.8"]],
    ["③", ["四项任务", "现场建档"]],
    ["④", ["12项", "11项", "1项"]],
    ["⑤", ["26.4", "78%", "1.6", "CFG-02"]],
    ["⑥", ["96%"]],
    ["⑦", ["1段", "4分18秒", "3840×1920", "214", "00:43", "02:17"]],
    ["⑧", ["Z04", "Z03", "Z02", "Z01"]],
    ["⑨", ["Z04"]],
    ["⑩", ["MSN-2026-0911-02", "6个航点", "24.6"]],
    ["⑫", ["scan-Z04-001", "34帧", "2.7"]],
    ["⑬", ["四项", "缺帧", "补采", "图像", "证据"]],
    ["⑭", ["12条", "3条"]],
    ["⑮", ["12条", "9条", "3条", "6个样本组", "4", "1"]],
    ["⑯", ["3", "2", "4", "0.92", "0.94", "6项"]],
    ["⑰", ["DEMO-M02b", "DEMO-M02", "7项"]],
    ["⑱", ["420帧", "14帧", "3份", "Z04"]],
    ["⑲", ["两项", "一项", "88.4%", "90%"]],
    ["⑳", ["WO-2026-0912", "Z04"]],
    ["㉑", ["复盘"]],
    ["㉒", ["24项", "21项", "1项", "2项"]],
  ];
  for (const [no, fragments] of required) {
    const text = lineOf(no);
    for (const frag of fragments) {
      assert.ok(
        text.includes(frag),
        `第 ${no} 轮台词缺少「${frag}」\n      实际：${text}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. §7 点名的替换必须已生效
 * ------------------------------------------------------------------ */

test("§7 点名的 7 处改写已录入，且旧措辞不存在于平台任何文本", () => {
  /*
    ⚠ 这 7 处是**史的台词 / 过程性播报**，不是"小木对用户指令的应答"，
      所以它们存在 `rehearsalScript.ts`（排练参考），**不进 `script.ts` 的播报**。
      混在一起会让匹配器把史的台词也当成触发短语。
  */
  assert.equal(SPEAKER_REWRITES_V1.length, 7, "§7 恰好 7 处改写");

  /* ① 替换文案的关键措辞必须出现（证明改写已生效，不是只删了旧的） */
  const rewriteText = SPEAKER_REWRITES_V1.map((l) => l.text).join("\n");
  for (const phrase of REQUIRED_REWRITE_PHRASES) {
    assert.ok(rewriteText.includes(phrase), `§7 的替换文案缺少「${phrase}」`);
  }

  /* ② 旧措辞不得出现在**平台会念的文本**里（台词 + 触发短语 + 改写表） */
  const platformText = [
    ...SCRIPT_ROUNDS.map((r) => mainLineOf(r)),
    ...SCRIPT_ROUNDS.flatMap((r) => r.triggers),
    rewriteText,
  ].join("\n");
  for (const phrase of FORBIDDEN_LEGACY_PHRASES) {
    assert.ok(!platformText.includes(phrase), `旧措辞仍出现在平台文本里：「${phrase}」`);
  }

  /* ③ 每处改写都要写清"替换了什么"（排练时能对照） */
  for (const line of SPEAKER_REWRITES_V1) {
    assert.ok(line.replacedIssue.length > 0, `「${line.text.slice(0, 12)}…」没有记录被替换的问题`);
    assert.ok(line.speaker === "史" || line.speaker === "小木", "说话人只能是史或小木");
  }

  /* ④ 改写文案里不得再出现占位符 */
  for (const line of SPEAKER_REWRITES_V1) {
    assert.ok(!/x{3,}/i.test(line.text), `§7 改写文案仍含占位符：${line.text}`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. 占位符与"喵"字（§10 阶段 F、§7 末）
 * ------------------------------------------------------------------ */

test("全剧本不得残留占位符（xxx / xxxx / 待补文案）", () => {
  for (const round of SCRIPT_ROUNDS) {
    const text = `${round.title}\n${mainLineOf(round)}\n${round.triggers.join("|")}`;
    /* 严格模式：平台会念的文本里任何占位符都算残留 */
    const hits = findPlaceholders(text, false);
    assert.equal(hits.length, 0, `第 ${round.roundNo} 轮残留占位符：${hits.join(" / ")}`);
  }
});

test("改写表里的「记录式提及」允许保留，但不许顺手写进正式文案（§7）", () => {
  /*
    ⚠ 这里要区分两类出现，否则两条要求会互相打架：
      · **残留**（禁止）：平台会念的文本里出现占位符；
      · **记录**（允许）：`replacedIssue` 那一列的作用就是记下"原来这里是占位符"，
        把它也扫掉等于删掉改写的凭据。
    扫描函数 `findPlaceholders(text, allowRecord)` 用"占位符前 6 字里有 含/原/旧/曾"
    来区分 —— 下面三种情形各自钉一条，确保这个判据不是恒真。
  */
  for (const line of SPEAKER_REWRITES_V1) {
    /* 记录列：允许（它就是在描述历史问题） */
    assert.equal(
      findPlaceholders(line.replacedIssue, true).length,
      0,
      `改写表的「被替换问题」列不该被判为残留：${line.replacedIssue}`,
    );
    /* 正式文案：严格禁止 */
    assert.equal(
      findPlaceholders(line.text, false).length,
      0,
      `第 ${line.text.slice(0, 12)}… 的正式文案里残留占位符`,
    );
  }
  /* 判据不是恒真：直接显示占位符的文本必须被抓出来 */
  assert.deepEqual(findPlaceholders("这里写着 xxxx 请补全", true), ["xxxx"], "非记录式提及必须被抓出");
  assert.deepEqual(findPlaceholders("段落 171 含 xxxx", true), [], "记录式提及应放行");
});

test("平台播报文本不得带入工作清单里的语气词「喵」（§7 末）", () => {
  for (const round of SCRIPT_ROUNDS) {
    assert.ok(!mainLineOf(round).includes("喵"), `第 ${round.roundNo} 轮的台词带了「喵」`);
    for (const t of round.triggers) {
      assert.ok(!t.includes("喵"), `第 ${round.roundNo} 轮的触发短语带了「喵」`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4. 不得把风险说成诊断（§11.2）
 * ------------------------------------------------------------------ */

test("§11.2 台词不得把风险提示说成已确诊病害，也不得把待补采说成分析完成", () => {
  const all = SCRIPT_ROUNDS.map((r) => mainLineOf(r)).join("\n");
  /* 出现"确"字的地方不能是"确诊/确认病害"这类断言 */
  for (const bad of ["确诊", "已确诊", "确认为病害", "判定为病害"]) {
    assert.ok(!all.includes(bad), `台词出现诊断性断言「${bad}」，违反 §11.2`);
  }
  /* ⑫ 明确只标为采集异常、结论是待补采 */
  const r12 = lineOf("⑫");
  assert.ok(
    r12.includes("采集异常") || r12.includes("待补采"),
    "⑫ 必须说明只标记为采集异常/待补采，不得直接给病害结论",
  );
});
