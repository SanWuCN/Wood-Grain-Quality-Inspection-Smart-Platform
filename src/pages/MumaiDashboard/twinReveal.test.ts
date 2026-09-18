/**
 * 数字孪生四柱构件条 · 逐柱点亮（`twinReveal.ts`）
 *
 * 纯逻辑部分（登记 / 推进 / 按工单读 / 取消）在 Node 里可测；React 钩子不测。
 * 四条判据针对的都是已经在另两个揭示模块上踩过的坑：
 *   · **登记时一根都不亮**（第一拍要等小木开口，不能一进页面四根全亮）；
 *   · **按工单绑**：另一张工单的计划不许点亮这张单的构件；
 *   · **推完最后一根不解除**（解除后页面只能读到 null，最后一根永远不亮）；
 *   · 槽位只认 `Z01`–`Z04` 这种形状，写错的槽位不登记（免得永远亮不了还查不出原因）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceTwinReveal,
  beginTwinReveal,
  cancelTwinReveal,
  twinSlotsFor,
} from "./twinReveal.ts";

/**
 * `twinReveal` 用 `window.setTimeout` 做兜底 TTL，Node 里没有 window。
 * 这里塞一个**记账式**替身（与 `cleanFlowReveal.test.ts` 同一套做法）：
 * 定时器回调不真跑，需要验证"到点自动解除"时由测试自己触发。
 */
type FakeTimer = { id: number; fn: () => void; ms: number };

const timers: FakeTimer[] = [];
const cleared: number[] = [];
let nextTimerId = 1;

(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout: (id: number) => {
    cleared.push(id);
  },
};

test("兜底 TTL 到点自动解除（页面回到四根全显示，不留半截）", () => {
  beginTwinReveal(["Z01", "Z02"], "wo-ttl");
  advanceTwinReveal(["Z01"]);
  assert.deepEqual(twinSlotsFor(), ["Z01"]);
  const timer = timers[timers.length - 1];
  assert.ok(timer, "登记计划时必须挂一个兜底定时器");
  assert.equal(timer.ms, 30_000);
  timer.fn();
  assert.equal(twinSlotsFor(), null, "到点后计划解除");
});

test("登记时一根都不亮，按拍推进后逐柱出现", () => {
  beginTwinReveal(["Z01", "Z02", "Z03", "Z04"]);
  assert.deepEqual(twinSlotsFor(), [], "刚登记就该是 0 根（第一拍等小木开口）");

  advanceTwinReveal(["Z01", "Z02", "Z03"]);
  assert.deepEqual(twinSlotsFor(), ["Z01", "Z02", "Z03"]);

  advanceTwinReveal(["Z04"]);
  assert.deepEqual(twinSlotsFor(), ["Z01", "Z02", "Z03", "Z04"], "推完最后一根不许解除计划");
  cancelTwinReveal();
});

test("计划是全局的一份，orderId 只作来源记录（第一版按它匹配 → 一根都不亮）", () => {
  beginTwinReveal(["Z01", "Z02"], "wo-20260918-0001");
  advanceTwinReveal(["Z01"]);
  /*
    ⚠ 这里**不按工单过滤**：数字孪生页的工单是种子工单（`SH-2026-0901` 这类），
    executor 手里是服务端工单号，两边 id 体系不同 —— 按 id 匹配的后果是页面永远读不到计划。
    换单交回给人这条约束由页面在用户切单时 `cancelTwinReveal()` 保证（见 Twin.tsx）。
  */
  assert.deepEqual(twinSlotsFor(), ["Z01"]);
  cancelTwinReveal();
  assert.equal(twinSlotsFor(), null);
});

test("没有计划时返回 null（用户自己点进来 / 刷新 / 换工单都是全显示）", () => {
  cancelTwinReveal();
  assert.equal(twinSlotsFor(), null);
});

test("槽位形状不对的声明不登记（免得永远亮不了）", () => {
  beginTwinReveal(["Z01", "东侧柱子", "z04", "Z04"]);
  /* 只登记合法的两个：Z01 与 Z04（大小写与中文名都不算构件号） */
  assert.deepEqual(twinSlotsFor(), []);
  advanceTwinReveal(["Z01", "东侧柱子", "z04", "Z04"]);
  assert.deepEqual(twinSlotsFor(), ["Z01", "Z04"]);
  cancelTwinReveal();

  /* 全是不合法的槽位时**不登记计划**：页面照旧全部可见 */
  beginTwinReveal(["东侧柱子"]);
  assert.equal(twinSlotsFor(), null);
  beginTwinReveal([]);
  assert.equal(twinSlotsFor(), null);
});

test("重复推进幂等、取消后立刻回到全部可见", () => {
  beginTwinReveal(["Z01", "Z02"]);
  advanceTwinReveal(["Z01"]);
  advanceTwinReveal(["Z01"]);
  assert.deepEqual(twinSlotsFor(), ["Z01"]);
  cancelTwinReveal();
  assert.equal(twinSlotsFor(), null);
});
