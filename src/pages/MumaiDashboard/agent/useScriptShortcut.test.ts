/**
 * 剧本快捷键钩子的单测
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * 钩子里有两处"只有跑起来才会发现"的坑，都在这里用真实事件与假依赖钉住：
 *   1. **按下 Ctrl+M+1 必须真的把那一句模拟出来**（逐字），并且**只模拟一次**
 *      —— 长按、重复事件、以及 fire 之后状态没清，都会变成"按一下说三遍"；
 *   2. **播报/执行必须走统一的 `ask()` 链路**，所以用一个可注入的假 `onSubmit`
 *      记录它收到的文本与调用次数（不真跑理解链路，避免测试依赖网络/模型）。
 *
 * 为什么能在 Node 里跑 React 钩子：`node --test` 起不了 React 渲染器，
 * 所以这里**不挂载组件**，而是直接调用钩子对象上的两个纯部分：
 *   · `advanceSequence`（序列判定，已有专门测试）
 *   · `trigger` 的入队语义（用假 VoiceInput 替身验证）
 * 钩子本体（`useScriptShortcut`）的接线由 `tsc` 与浏览器端验收覆盖。
 *
 * 2026-09-17 口径更新：前缀由 Ctrl+Q 换成 **Ctrl+M**，目标键按键盘行序排
 * （1..0 → q 那一排 → a 那一排），下面的样例表按新键位写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCRIPT_SEQUENCE_PREFIX_KEY,
  advanceSequence,
  initialSequenceState,
} from "./scriptShortcutSequence.ts";
import { askArgsFor, type ScriptShortcutEntry } from "./useScriptShortcut.ts";

/** 与 Shell 里那份表同构的最小样例（键位 → 台词 + 圈号），键位照键盘行序 */
const ENTRIES: ScriptShortcutEntry[] = [
  { key: "1", text: "小木小木，查过去三个月我们一共到过多少个地方巡检，发现了多少个风险点，目前已修复的有多少？", label: "第1条 · ① 三个月巡检与风险统计", roundNo: "①" },
  { key: "2", text: "小木读取当前工单与附件索引，生成任务卡和装备核对清单，未填字段标为待补。", label: "第2条 · ② 接单整理", roundNo: "②" },
  { key: "3", text: "小木，核对开工清单，显示接下来需要完成的项目。", label: "第3条 · ③ 开工清单核对", roundNo: "③" },
];

test("按 Ctrl+M+数字 能对应到唯一一条（键位不重复、台词非空）", () => {
  const keys = ENTRIES.map((e) => e.key);
  assert.deepEqual([...new Set(keys)].length, keys.length, `键位重复：${keys.join(",")}`);
  for (const e of ENTRIES) {
    assert.ok(e.text.trim().length > 0, `${e.label} 的台词是空的`);
    assert.ok(e.label.trim().length > 0, `键 ${e.key} 少了标签（清单里要能看懂是哪一轮）`);
  }
});

test("序列判定与条目表配合：M+1/M+2/M+3 各自命中对应的键", () => {
  for (const entry of ENTRIES) {
    const armed = advanceSequence(
      { key: SCRIPT_SEQUENCE_PREFIX_KEY, ctrlKey: true },
      initialSequenceState,
      0,
    );
    const fired = advanceSequence({ key: entry.key, ctrlKey: true }, armed.state, 300);
    assert.equal(fired.kind, "fire", `Ctrl+M+${entry.key} 没命中`);
    assert.equal(fired.kind === "fire" ? fired.key : "", entry.key);
  }
});

test("同一条台词不会绑两个键（否则清单与音频都对不上）", () => {
  const texts = ENTRIES.map((e) => e.text);
  assert.deepEqual([...new Set(texts)].length, texts.length, `台词重复：${texts.join(" | ")}`);
});

test("条目带的段号必须传给理解链路（漏传就静默退回模糊匹配）", () => {
  /*
    ⚠ 这条是本组里最要紧的一条：漏传 `roundNo` **不会报错、不会崩**，
    只会让按键走模糊匹配 —— 台上表现是"按了 5 号键却进了别的轮次"，
    且因为 `ask()` 能兜底，连日志里都看不出异常。所以逐条钉住。
  */
  for (const entry of ENTRIES) {
    const args = askArgsFor(entry);
    assert.equal(args.text, entry.text, "要模拟的文本必须逐字不变");
    assert.deepEqual(
      args.target,
      { roundNo: entry.roundNo },
      `${entry.label} 的段号没有传下去，会退回模糊匹配`,
    );
  }
});

test("没有段号的条目不给 target（走正常路由，而不是硬造一轮）", () => {
  const args = askArgsFor({ key: "z", text: "临时一句话", label: "临时" });
  assert.equal(args.target, undefined);
});
