/**
 * UC-05 AC2/AC3 · FPS 实测与合格判据（unit test，2.5）
 *
 * ── 这一组断言在防两种"看起来很专业其实没测"的假 FPS ────────────────
 *   ① **固定值充数**：`renderStats()` 恒返回 60。它在页面上看不出问题，
 *      但对照表会跟着假 —— 而用户是拿对照表做决策的（REQ-06 AC2"不得虚报"）。
 *   ② **瞬时值充数**：只看最后一帧的 `1/dt`。切标签页回来、GC 卡一下、
 *      截图工装按下快门的那一帧都会让这个数掉到 5，于是"这版不合格"是假警报。
 * 所以判据必须是**滑动窗口均值**，且"合格"要求它在窗口填满后**连续 ≥3 秒 ≥30**。
 *
 * ── 3 秒这个门槛为什么不能省 ────────────────────────────────────────
 * 首次编译着色器、首次上传贴图都发生在头几百毫秒里。只看"窗口值 ≥30"的话，
 * 一个每次启动卡 2 秒、之后勉强 31 FPS 的版本会判合格；要求连续 3 秒，
 * 这一段卡顿会实打实地把它拉下去。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createFpsMeter, PASS_FPS, PASS_STREAK_MS, FPS_WINDOW_MS } from "./fps.ts";

/** 以固定帧间隔喂 n 帧，返回最后一帧的时间戳 */
function feed(meter: ReturnType<typeof createFpsMeter>, fps: number, frames: number, startAt = 0): number {
  const dt = 1000 / fps;
  let at = startAt;
  for (let i = 0; i < frames; i += 1) {
    at += dt;
    meter.push(at);
  }
  return at;
}

test("常量就是硬指标：窗口 1000ms、门槛 30 FPS、连续 3000ms", () => {
  assert.equal(FPS_WINDOW_MS, 1000);
  assert.equal(PASS_FPS, 30);
  assert.equal(PASS_STREAK_MS, 3000);
});

test("窗口为空时 value() 返回 0，而不是编一个数出来", () => {
  const meter = createFpsMeter();
  assert.equal(meter.value(), 0, "没喂过帧就没有 FPS 可言");
  assert.equal(meter.sampleCount(), 0);
  assert.equal(meter.isPassing(), false, "0 帧不许判合格");
});

test("单帧也不编数：一帧算不出帧率，value() 仍是 0", () => {
  const meter = createFpsMeter();
  meter.push(1000);
  assert.equal(meter.value(), 0);
  assert.equal(meter.isPassing(), false);
});

test("滑动窗口均值：稳定 60 FPS 时窗口值收敛到 60（±3）", () => {
  const meter = createFpsMeter();
  feed(meter, 60, 120);
  assert.ok(Math.abs(meter.value() - 60) <= 3, `60 FPS 输入得到 ${meter.value()}`);
});

test("滑动窗口均值：稳定 24 FPS 时窗口值收敛到 24（±3）—— 门槛之下要如实低", () => {
  const meter = createFpsMeter();
  feed(meter, 24, 120);
  assert.ok(Math.abs(meter.value() - 24) <= 3, `24 FPS 输入得到 ${meter.value()}`);
  assert.equal(meter.isPassing(), false, "24 FPS 不许判合格");
});

test("窗口只算最近 1000ms：久远的慢帧滑出去之后 value() 要回升", () => {
  const meter = createFpsMeter();
  // 先来 2 秒 10 FPS（很慢）
  const at = feed(meter, 10, 20);
  const slow = meter.value();
  assert.ok(slow < 20, `慢帧阶段应该是低值，得到 ${slow}`);

  // 再跑 2 秒 60 FPS —— 慢帧已经全部滑出 1000ms 窗口
  feed(meter, 60, 120, at);
  const fast = meter.value();
  assert.ok(fast > 50, `快帧阶段窗口值应回升到 60 附近，得到 ${fast}`);
  assert.ok(fast > slow, "窗口必须是滑动的，不是全历史平均");
});

test("isPassing：窗口**没填满**之前一律不合格（头几帧不算数）", () => {
  const meter = createFpsMeter();
  // 只喂了 500ms（60 FPS × 30 帧）
  feed(meter, 60, 30);
  assert.ok(meter.value() > 50, "值本身已经很高");
  assert.equal(meter.isPassing(), false, "但窗口未填满 → 时间跨度不足，不许判合格");
});

test("isPassing：窗口填满且 ≥30，但**只持续了 1.5 秒** → 仍不合格", () => {
  const meter = createFpsMeter();
  // 跑 2.5 秒 60 FPS：窗口在第 1 秒填满，到此刻只连续合格了约 1.5 秒
  feed(meter, 60, 150);
  assert.equal(meter.isPassing(), false, "连续 1.5s 不够 3s（这一条是 3 秒门槛的直接体现）");
});

test("isPassing：窗口填满且 ≥30，**连续满 3 秒** → 合格", () => {
  const meter = createFpsMeter();
  /**
   * 5 秒 60 FPS。
   *
   * ⚠ 为什么不是"刚过 4 秒"就断言：合格需要两段时间前后叠加
   *   · 第 1 段：窗口**填满**（跨度到 1000ms）—— 冷启动起算约 1 秒；
   *   · 第 2 段：从那一刻起**再连续** ≥3000ms。
   * 所以合格时刻约在 4 秒出头，而不是 3 秒。喂 5 秒留足余量，
   * 这样断言考的是"3 秒门槛"本身，而不是我算错了启动开销。
   */
  feed(meter, 60, 300);
  assert.equal(meter.isPassing(), true, `5s@60FPS 应合格，value=${meter.value()}`);
  assert.ok(meter.passingForMs() >= PASS_STREAK_MS, `连续合格时长 ${meter.passingForMs()}ms`);
});

test("isPassing：从没合格过的meter，passingForMs 是 0（不是 NaN）", () => {
  const meter = createFpsMeter();
  assert.equal(meter.passingForMs(), 0);
  feed(meter, 10, 60);
  assert.equal(meter.passingForMs(), 0);
  assert.ok(Number.isFinite(meter.passingForMs()));
});

test("一次长卡顿（>1 秒）把连续合格时长清零，要重新攒满 3 秒", () => {
  const meter = createFpsMeter();
  let at = feed(meter, 60, 300);
  assert.equal(meter.isPassing(), true, "前置：先合格");

  // 卡顿 1.5 秒（相当于切走标签页 / 一次长 GC）
  at += 1500;
  meter.push(at);
  assert.equal(meter.isPassing(), false, "卡顿必须打断连续合格，而不是被窗口平滑掉");
  assert.equal(meter.passingForMs(), 0, "连续合格时长必须清零");

  // 再跑 5.5 秒 60 FPS 才重新合格（同样要先填满窗口、再攒 3 秒）
  feed(meter, 60, 330, at);
  assert.equal(meter.isPassing(), true, "重新攒满 3 秒后恢复合格");
});

test("两次卡顿之间攒不满 3 秒 → 一直不合格", () => {
  const meter = createFpsMeter();
  let at = feed(meter, 60, 120); // 1s 合格
  for (let i = 0; i < 5; i += 1) {
    at += 900; // 卡 0.9 秒
    meter.push(at);
    at = feed(meter, 60, 90, at); // 再跑 1.5 秒
  }
  assert.equal(meter.isPassing(), false, "每次都差一点到 3 秒，就不该判合格");
});

test("时间戳必须单调：回退或重复的时间戳被忽略，不会把窗口算成负数/NaN", () => {
  const meter = createFpsMeter();
  const at = feed(meter, 60, 120);
  const before = meter.value();

  meter.push(at - 500); // 回退
  meter.push(at); // 重复
  assert.ok(Number.isFinite(meter.value()), `value 变成非有限值：${meter.value()}`);
  assert.ok(meter.value() > 0);
  assert.ok(Math.abs(meter.value() - before) < 5, "非法时间戳不该改变窗口值");
});

test("窗口容量有上限：喂 10 分钟 120FPS 不会无限增长（长跑不泄漏）", () => {
  const meter = createFpsMeter();
  // 10 分钟 × 120 FPS = 72000 帧
  feed(meter, 120, 72000);
  // 1 秒窗口 @120FPS 只需存约 120 个时间戳；留一倍余量做断言上界
  assert.ok(meter.sampleCount() <= 300, `窗口里堆了 ${meter.sampleCount()} 个样本，超出预期`);
  assert.ok(meter.value() > 110, `长跑后窗口值应仍是 120 附近，得到 ${meter.value()}`);
});

test("重置：reset() 之后回到刚创建的状态（放大态要重新计量，UC-02 AC3）", () => {
  const meter = createFpsMeter();
  feed(meter, 60, 300);
  assert.equal(meter.isPassing(), true);

  meter.reset();
  assert.equal(meter.value(), 0);
  assert.equal(meter.sampleCount(), 0);
  assert.equal(meter.isPassing(), false);
  assert.equal(meter.passingForMs(), 0);
});
