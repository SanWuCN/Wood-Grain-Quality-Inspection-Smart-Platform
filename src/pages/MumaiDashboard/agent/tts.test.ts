/**
 * 语音输出 · 探测结论的处理规则 —— 单测
 *
 * ── 这一组在防什么 ────────────────────────────────────────────────
 * 2026-09-17 实测的现场事故：第一轮按键时页面正忙（刚登录进来），
 * 音频探测的 1.2 秒预算内没等到 `canplaythrough` → 老实现把它当成"没有语音包"，
 * **还把这个 false 缓存了** → 这一轮直接回退浏览器合成音，后面的轮次也可能一起受影响。
 * 现场表现是"第一轮的声音是机器的"，而且不报任何错。
 *
 * 所以把"探测结论怎么处理"抽成纯函数钉住：超时 ≠ 没有；否定结论不许缓存。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideProbe } from "./tts.ts";

test("探到了：缓存「有」，不再重试", () => {
  assert.deepEqual(decideProbe("ok", false), { retry: false, cache: true, value: true });
  assert.deepEqual(decideProbe("ok", true), { retry: false, cache: true, value: true });
});

test("浏览器明确说读不了（onerror）：算没有，并且可以缓存", () => {
  assert.deepEqual(decideProbe("missing", false), { retry: false, cache: true, value: false });
  assert.deepEqual(decideProbe("missing", true), { retry: false, cache: true, value: false });
});

test("超时不等于没有：再审一次，且绝不缓存否定结论", () => {
  /* 第一次超时 → 重试；这一趟**不能**缓存 false（否则第一轮赶上页面忙就永久回退合成音） */
  assert.deepEqual(decideProbe("timeout", false), { retry: true, cache: false, value: false });
  /* 重试之后还是超时 → 这一轮先按没有处理，但仍然不缓存（下次还能重新探） */
  assert.deepEqual(decideProbe("timeout", true), { retry: false, cache: false, value: false });
});

test("只有「有」和「明确没有」两种结论会被记住", () => {
  const cached = [
    decideProbe("ok", false),
    decideProbe("missing", false),
    decideProbe("timeout", false),
    decideProbe("timeout", true),
  ].filter((decision) => decision.cache);
  assert.deepEqual(
    cached.map((decision) => decision.value),
    [true, false],
    "能被缓存的就是这两条：有素材、以及浏览器明确说读不了",
  );
});
