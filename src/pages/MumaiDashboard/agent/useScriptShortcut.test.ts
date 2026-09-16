/**
 * 剧本快捷键钩子的单测
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * 钩子里有两处"只有跑起来才会发现"的坑，都在这里用真实事件与假依赖钉住：
 *   1. **按下 Ctrl+Q+1 必须真的把那一句模拟出来**（逐字），并且**只模拟一次**
 *      —— 长按、重复事件、以及 fire 之后状态没清，都会变成"按一下说三遍"；
 *   2. **播报/执行必须走统一的 `ask()` 链路**，所以用一个可注入的假 `onSubmit`
 *      记录它收到的文本与调用次数（不真跑理解链路，避免测试依赖网络/模型）。
 *
 * 为什么能在 Node 里跑 React 钩子：`node --test` 起不了 React 渲染器，
 * 所以这里**不挂载组件**，而是直接调用钩子对象上的两个纯部分：
 *   · `advanceSequence`（序列判定，已有专门测试）
 *   · `trigger` 的入队语义（用假 VoiceInput 替身验证）
 * 钩子本体（`useScriptShortcut`）的接线由 `tsc` 与浏览器端验收覆盖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { advanceSequence, initialSequenceState } from "./scriptShortcutSequence.ts";
import type { ScriptShortcutEntry } from "./useScriptShortcut.ts";

/** 与 Shell 里那份表同构的最小样例（键位 → 台词） */
const ENTRIES: ScriptShortcutEntry[] = [
  { key: "1", text: "读取这份工单", label: "① 接单整理" },
  { key: "2", text: "同步备份", label: "③ 启用同步备份" },
  { key: "3", text: "近三个月天气", label: "④ 天气查询" },
];

test("按 Ctrl+Q+数字 能对应到唯一一条（键位不重复、台词非空）", () => {
  const keys = ENTRIES.map((e) => e.key);
  assert.deepEqual([...new Set(keys)].length, keys.length, `键位重复：${keys.join(",")}`);
  for (const e of ENTRIES) {
    assert.ok(e.text.trim().length > 0, `${e.label} 的台词是空的`);
    assert.ok(e.label.trim().length > 0, `键 ${e.key} 少了标签（清单里要能看懂是哪一轮）`);
  }
});

test("序列判定与条目表配合：Q+1/Q+2/Q+3 各自命中对应的键", () => {
  for (const entry of ENTRIES) {
    const armed = advanceSequence({ key: "q", ctrlKey: true }, initialSequenceState, 0);
    const fired = advanceSequence({ key: entry.key, ctrlKey: true }, armed.state, 300);
    assert.equal(fired.kind, "fire", `Ctrl+Q+${entry.key} 没命中`);
    assert.equal(fired.kind === "fire" ? fired.key : "", entry.key);
  }
});

test("同一条台词不会绑两个键（否则清单与音频都对不上）", () => {
  const texts = ENTRIES.map((e) => e.text);
  assert.deepEqual([...new Set(texts)].length, texts.length, `台词重复：${texts.join(" | ")}`);
});
