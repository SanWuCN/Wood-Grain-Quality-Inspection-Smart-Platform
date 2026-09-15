/**
 * TTS 不得反向唤醒小木（工作清单 v1.0 §9「验证小木自己的 TTS 不会反向唤醒小木」）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 小木播报时，声音会从扬声器出来、被麦克风收回去。若不加门控，就可能出现：
 *   · 自己念的台词里含「小木小木」或其他触发词 → **自己把自己唤醒**；
 *   · 播完立刻又进识别 → 死循环，演示现场表现为"小木自说自话停不下来"。
 *
 * 现状：唤醒通道开了 `echoCancellation`，且麦克风节点不接扬声器
 * （`wakeChannel.ts`）。但**回声消除不保证消除自身 TTS** ——
 * 浏览器只对"它认为来自扬声器的信号"做消除，音量、设备、耳机/外放都会影响效果。
 * 所以必须再加一层**逻辑门控**，而不是把正确性押在浏览器实现上。
 *
 * ── 判据设计：为什么是"播报中一律不接受"，而不是"播报中降低灵敏度" ──
 * 演示场景里用户**不会**在小木说话的同时下指令（说了也会被自己的播报盖住）。
 * 所以"播报中一律不接受"既最简单也最安全；
 * 播完再留一小段**静默期**，避免尾音与混响被当成新指令。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WAKEREJECT_TAIL_MS, shouldRejectWake } from "./wakeGate.ts";

test("播报进行中：一律不接受唤醒（§9 硬要求）", () => {
  const r = shouldRejectWake({ speaking: true, sinceSpeechEndMs: 0 });
  assert.equal(r.reject, true, "播报中不得接受唤醒，否则会自己唤醒自己");
  assert.match(r.reason, /播报/, `理由要能说清是"播报中"（实际：${r.reason}）`);
});

test("播报结束后仍有静默期：尾音与混响不算新指令", () => {
  const during = shouldRejectWake({ speaking: false, sinceSpeechEndMs: 0 });
  assert.equal(during.reject, true, "刚播完就接受，会把尾音当成指令");
  assert.match(during.reason, /静默|尾音/, `理由要能说清是"尾音期"（实际：${during.reason}）`);

  /* 边界：刚好到静默期结束就可以接受 */
  const atEdge = shouldRejectWake({ speaking: false, sinceSpeechEndMs: WAKEREJECT_TAIL_MS });
  assert.equal(atEdge.reject, false, "静默期结束应当恢复接受");

  const before = shouldRejectWake({ speaking: false, sinceSpeechEndMs: WAKEREJECT_TAIL_MS - 1 });
  assert.equal(before.reject, true, "静默期差 1ms 仍应拒绝（边界要闭合）");
});

test("没有播报过（从未说话）：正常接受", () => {
  const r = shouldRejectWake({ speaking: false, sinceSpeechEndMs: 60_000 });
  assert.equal(r.reject, false);
  assert.equal(r.reason, "", "接受时不该给理由");
});

test("静默期长度是一个有限的正数（不能设成 0 或无穷）", () => {
  assert.ok(WAKEREJECT_TAIL_MS > 0, "静默期必须为正，否则尾音会被当成指令");
  assert.ok(WAKEREJECT_TAIL_MS <= 3000, `静默期不宜过长（实际 ${WAKEREJECT_TAIL_MS}ms，超过 3s 会显得唤醒迟钝）`);
});
