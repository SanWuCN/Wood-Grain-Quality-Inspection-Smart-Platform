/**
 * 播报看门狗的窗口口径 —— 单测（纯函数）
 *
 * ── 这一条在防什么（2026-09-18 实测踩到）────────────────────────────
 * 第④轮台词换成短句「收到，已启用同步备份。」（11 字）之后，同步备份小窗**再也不弹**了。
 * 根因不在台词，也不在小窗：音频看门狗按「字数 × 260ms」算成 2.86 秒，
 * 而那条录音本身有 **3.12 秒** —— 看门狗先到点把音频 `pause()` 掉，
 * `ended` 永远不来，`playAudio()` 的 Promise 永远不兑现，
 * 而 `executor` 正等着它才弹小窗。
 *
 * 所以这里钉住两件事：
 *   ① 有真实音频时长时，窗口必须**大于**它（+余量），不能按字数把长录音掐掉；
 *   ② 读不到时长时仍有兜底（按字数估），且不短于 2.5 秒。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { watchdogMsFor } from "./tts.ts";

test("看门狗按真实音频时长算：3.12 秒的短句录音不会被 2.86 秒的字数估时掐掉", () => {
  const text = "收到，已启用同步备份。"; // 11 字
  const byText = watchdogMsFor(text);
  assert.equal(byText, Math.max(2500, text.length * 260));
  assert.ok(byText < 3120, `字数估时本来就只有 ${byText}ms —— 这正是当初的坑`);

  const byAudio = watchdogMsFor(text, 3.12);
  assert.ok(byAudio > 3120, `按音频时长算必须留出余量，实得 ${byAudio}ms`);
  assert.equal(byAudio, 3120 + 1200);
});

test("看门狗兜底：读不到时长时按字数估，且不短于 2.5 秒", () => {
  const ten = "十个字十个字十个字十"; // 10 字
  assert.equal(ten.length, 10, "这条断言本身要能证伪：字符串长度写错就会红");
  assert.equal(watchdogMsFor("好"), 2500, "极短句也要有 2.5 秒下限");
  assert.equal(watchdogMsFor("", 2), 3200, "空文本但有音频时长：按音频算");
  assert.equal(watchdogMsFor(ten, null), 2600);
  assert.equal(watchdogMsFor(ten, Number.NaN), 2600, "NaN 不是时长");
  assert.equal(watchdogMsFor(ten, 0), 2600, "0 也不是有效时长");
});

test("看门狗只做兜底，不会比正常播报短：长录音按录音，长文本按文本，取较大者", () => {
  const long = "已按工单地点建立天气查询。近三个月累计降雨412毫米、降雨37天、单日峰值52.6毫米。";
  /* 长文本没有时长时按字数（约 44 字 → 11.4 秒），有更长的真实时长时按真实时长 */
  assert.ok(watchdogMsFor(long) > 10000);
  assert.ok(watchdogMsFor(long, 20) > 20000);
});
