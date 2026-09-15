/**
 * 待读取委托的**显式绑定**（unit test）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 《新工单红头委托与小木联动-AI交接文档 v1.0》的防幻觉硬规则第 3 条：
 *   「不使用 `orders[0]` 猜测用户正在查看的工单，必须优先使用**显式绑定**的待读取 orderId」
 * 第 12 条：连续触发多张工单时，每个通知 / 预览 / 语音读取 / 详情页必须保持**同一个** orderId。
 *
 * 旧实现正是靠"列表第一条 = 最新 = 用户想读的那张"（`scriptEntities()` 里写死的
 * `state.orders[0]?.id`）。它在两处会错：
 *   · 用户点了**第二条**通知的「查看」，读的却是第一条；
 *   · 连续按两次快捷键建了两张单，语音永远只读最新那张。
 * 两者都属于"把 A 的委托当成 B 的念出来"，是本需求里最不能出的错。
 *
 * ── 规格（实现前应当是红的）──────────────────────────────────────────
 *   1. 设置后能读回同一个 id；未设置时为 null
 *   2. **消费**（语音读取完）后必须清空 —— 否则下一轮又读到上一条委托
 *   3. 绑定失效（工单被删 / 不存在）时明确失败，且**清掉**绑定，
 *      不能留着一个指向不存在工单的 id 让后续流程拿它去导航
 *   4. 权限不足（restricted）时**只是不给正文**，绑定本身仍然有效 ——
 *      错误提示必须区分这两种情况（前者要"重新打开新工单通知"，后者是"没有权限"）
 *   5. 连续两张工单：后一次绑定覆盖前一次，"最后点的那张"说了算
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCommissionBinding,
  type CommissionLookup,
} from "./commissionBinding.ts";

/** 造一个查询桩：只有列在 known 里的工单存在 */
function lookupOf(known: Record<string, { restricted?: boolean }>): CommissionLookup {
  return {
    async describe(orderId: string) {
      const hit = known[orderId];
      if (!hit) return null;
      return { orderId, restricted: Boolean(hit.restricted) };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. 基本绑定与消费
 * ------------------------------------------------------------------ */

test("设置后能读回同一个 id；未设置时为 null", () => {
  const b = createCommissionBinding();
  assert.equal(b.get(), null, "初始应为未绑定");

  b.bind("wo-1");
  assert.equal(b.get(), "wo-1");
});

test("消费后必须清空（否则下一轮会念到上一条委托）", () => {
  const b = createCommissionBinding();
  b.bind("wo-1");
  assert.equal(b.consume(), "wo-1", "第一次消费拿到绑定的 id");
  assert.equal(b.get(), null, "消费后绑定必须清掉");
  assert.equal(b.consume(), null, "再消费拿到 null，不能重复消费同一条委托");
});

test("连续绑定两张工单：后一次覆盖前一次（最后点的那张说了算）", () => {
  const b = createCommissionBinding();
  b.bind("wo-1");
  b.bind("wo-2");
  assert.equal(b.get(), "wo-2");
  assert.equal(b.consume(), "wo-2");
  assert.equal(b.get(), null, "消费后不能回退到更早的那张");
});

test("绑定空 id 视为取消绑定（不留下一个空串绑定）", () => {
  const b = createCommissionBinding();
  b.bind("wo-1");
  b.bind("");
  assert.equal(b.get(), null);
});

/* ------------------------------------------------------------------ *
 * 2. 解析：绑定还在不在、有没有权限
 * ------------------------------------------------------------------ */

test("绑定有效且可见 → canRead，且给出 orderId", async () => {
  const b = createCommissionBinding();
  b.bind("wo-1");
  const r = await b.resolve(lookupOf({ "wo-1": {} }));
  assert.equal(r.state, "can-read");
  assert.equal(r.orderId, "wo-1");
});

test("未绑定 → 明确失败，提示必须让人知道要重新打开通知", async () => {
  const b = createCommissionBinding();
  const r = await b.resolve(lookupOf({ "wo-1": {} }));
  assert.equal(r.state, "unbound");
  assert.match(r.message, /重新打开新工单通知/, `提示要能指导用户下一步（实际：${r.message}）`);
});

test("绑定的工单已不存在 → 失败并**清掉**绑定（不留悬空 id 去导航）", async () => {
  const b = createCommissionBinding();
  b.bind("wo-deleted");
  const r = await b.resolve(lookupOf({ "wo-1": {} }));
  assert.equal(r.state, "missing");
  assert.match(r.message, /重新打开新工单通知/, "与未绑定同一口径：让用户重新点通知");
  assert.equal(b.get(), null, "指向不存在工单的绑定必须被清掉");
});

test("权限受限 → 绑定仍有效，但只给摘要（正文与附件不得展示）", async () => {
  const b = createCommissionBinding();
  b.bind("wo-secret");
  const r = await b.resolve(lookupOf({ "wo-secret": { restricted: true } }));
  assert.equal(r.state, "restricted");
  assert.equal(r.orderId, "wo-secret", "受限不等于读不到，导航目标仍然有效");
  assert.equal(b.get(), "wo-secret", "受限不能顺手把绑定清掉");
  /*
    ⚠ 这里原本写的是 assert.notMatch(...) —— Node 的 assert 没有这个方法，
    报的是 TypeError 而不是断言失败，很容易被误读成"逻辑错了"。
    改用 includes 判断，语义一样但不会踩 API 不存在的坑。
  */
  assert.ok(
    !r.message.includes("重新打开新工单通知"),
    `受限与失效是两回事，提示不能混（实际：${r.message}）`,
  );
});

test("resolve 不消费绑定（读一次不等于用掉）", async () => {
  const b = createCommissionBinding();
  b.bind("wo-1");
  await b.resolve(lookupOf({ "wo-1": {} }));
  await b.resolve(lookupOf({ "wo-1": {} }));
  assert.equal(b.get(), "wo-1", "多次解析后绑定仍在，只有 consume 才清");
});
