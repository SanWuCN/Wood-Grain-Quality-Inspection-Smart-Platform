/**
 * 页面内操作（`nav.op`）的词表与领取语义
 *
 * 这一组盯的是"错名字"和"领两次"这两类**不报错、只出丑**的失败：
 *   · 名字写错一个字母 → 现场那一下永远不发生（页面上什么都看不到，也没有报错）；
 *   · 领取没做成一次性 → 事件一次 + 挂载补一次 = 校验跑两遍、日志两条；
 *   · 操作与页面不对应（在 /twin 上等一个归档页的操作）→ 同上，静默失效。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NAV_OPS,
  NAV_OP_ROUTES,
  pendingNavOp,
  runNavOp,
  takePendingNavOp,
} from "./navOp.ts";

test("词表里的操作名非空、无重复，且每个都登记了兑现页面", () => {
  assert.ok(NAV_OPS.length > 0, "词表不能是空的");
  assert.equal(new Set(NAV_OPS).size, NAV_OPS.length, `操作名重复：${NAV_OPS.join("、")}`);
  for (const op of NAV_OPS) {
    assert.ok(op.trim().length > 0, "操作名不能是空串");
    assert.ok(NAV_OP_ROUTES[op], `「${op}」没有登记兑现页面 —— 跳错页会静默失效`);
    assert.ok(NAV_OP_ROUTES[op].startsWith("/"), `「${op}」的兑现页面应当是平台路由，实际 ${NAV_OP_ROUTES[op]}`);
  }
});

test("未登记的操作：不请求、不改待领取状态", () => {
  /* 先清干净 */
  takePendingNavOp(NAV_OPS[0]);
  assert.equal(pendingNavOp(), null);

  const sent = runNavOp("archive-verfiy" as never); // 故意拼错
  assert.equal(sent, false, "拼错的名字不该被当成一次操作");
  assert.equal(pendingNavOp(), null, "拼错的名字不该留下待领取状态");
});

test("登记过的操作：请求后待领取，且**只能领一次**", () => {
  const sent = runNavOp("archive-verify");
  assert.equal(pendingNavOp(), "archive-verify", "请求之后应当有待领取的操作");
  /* Node 里没有 window，事件发不出去 → sent=false 是正确的；
     真正要钉的是"状态记下了"，浏览器里那一半由验收工装覆盖。 */
  assert.equal(typeof sent, "boolean");

  assert.equal(takePendingNavOp("archive-verify"), true, "第一次领取必须成功");
  assert.equal(takePendingNavOp("archive-verify"), false, "第二次领取必须失败（防双跑）");
  assert.equal(pendingNavOp(), null, "领走之后不该留下残留");
});

test("领错名字领不到：待领取的操作只属于它自己那一页", () => {
  runNavOp("archive-verify");
  assert.equal(takePendingNavOp("archive-verify"), true);
  runNavOp("archive-verify");
  /* 另一个操作名来领，领不走；原来那个还在 */
  const other = NAV_OPS.find((op) => op !== "archive-verify");
  if (other) {
    assert.equal(takePendingNavOp(other), false, `「${other}」不该领走别的操作`);
    assert.equal(pendingNavOp(), "archive-verify", "别人的领取不该清掉正主");
  }
  assert.equal(takePendingNavOp("archive-verify"), true);
});
