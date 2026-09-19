/**
 * 「最后收到小车状态」这一句 · 单测（`pages/cartStatusText.ts`）
 *
 * ── 这条为什么值得钉 ────────────────────────────────────────────────
 * 现场最常被问的两句是「车怎么没了」和「**上次是什么时候通的**」，原来第二句没地方看。
 * 现在这个数字会被念出来，所以两种最容易说错的边界必须钉死：
 *   1. `ageMs === null` **不是**"刚刚断线"，而是**本轮服务启动后还没收到过** ——
 *      说成"刚断线"会让人去查网络，其实是服务刚重启（服务端 `cart.mjs` 也专门注释了这条）；
 *   2. 单位换算（秒 / 分钟 / 小时 / 天）不能越界说错，例如 59 秒不能说成"1 分钟前"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cartAgeMs, lastSeenText } from "./cartStatusText.ts";

test("null 要如实说「本轮服务启动后还没收到过」，不能说成刚断线", () => {
  assert.equal(lastSeenText(null), "本轮服务启动后还没收到过小车状态");
  assert.equal(lastSeenText(undefined), "本轮服务启动后还没收到过小车状态");
  assert.ok(!/刚|秒前|分钟前/.test(lastSeenText(null)), "不能拿「刚断线」的口径糊过去");
});

test("单位换算：刚刚 / 秒 / 分钟 / 小时 / 天", () => {
  assert.equal(lastSeenText(0), "刚刚还收到过小车状态");
  /* ⚠ 边界按**四舍五入后的秒数**判（4.4 s → 4 秒算「刚刚」，4.9 s → 5 秒就是「5 秒前」） */
  assert.equal(lastSeenText(4_400), "刚刚还收到过小车状态");
  assert.equal(lastSeenText(4_900), "最后收到小车状态：5 秒前");
  assert.equal(lastSeenText(12_000), "最后收到小车状态：12 秒前");
  assert.equal(lastSeenText(59_000), "最后收到小车状态：59 秒前", "59 秒还不能说成 1 分钟前");
  assert.equal(lastSeenText(60_000), "最后收到小车状态：1 分钟前");
  assert.equal(lastSeenText(3_540_000), "最后收到小车状态：59 分钟前");
  assert.equal(lastSeenText(3_600_000), "最后收到小车状态：1 小时前");
  assert.equal(lastSeenText(23 * 3_600_000), "最后收到小车状态：23 小时前");
  assert.equal(lastSeenText(25 * 3_600_000), "最后收到小车状态：1 天前");
  assert.equal(lastSeenText(72 * 3_600_000), "最后收到小车状态：3 天前");
});

test("年龄怎么取：本轮优先，其次服务端落盘的上一次成功联系；都没有才是「从没收到过」", () => {
  const now = Date.parse("2026-09-20T02:00:00.000Z");
  /* 本轮收到了 → 用本轮 */
  assert.equal(cartAgeMs({ ageMs: 1_500, lastSeenAt: "2026-09-20T01:00:00.000Z" }, now), 1_500);
  /* 本轮还没收到（服务刚重启）→ 退回落盘的上一次成功联系：这正是"上次什么时候通的" */
  assert.equal(cartAgeMs({ ageMs: null, lastSeenAt: "2026-09-20T01:48:00.000Z" }, now), 12 * 60_000);
  assert.equal(lastSeenText(cartAgeMs({ ageMs: null, lastSeenAt: "2026-09-20T01:48:00.000Z" }, now)), "最后收到小车状态：12 分钟前");
  /* 两个都没有 → null，由 lastSeenText 说"本轮服务启动后还没收到过" */
  assert.equal(cartAgeMs({ ageMs: null, lastSeenAt: null }, now), null);
  assert.equal(cartAgeMs(null, now), null);
  assert.equal(cartAgeMs({ ageMs: null, lastSeenAt: "坏时间" }, now), null);
  /* 时钟回拨不能算出负数 */
  assert.equal(cartAgeMs({ ageMs: null, lastSeenAt: "2026-09-20T03:00:00.000Z" }, now), 0);
});
