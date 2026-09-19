/**
 * 「这一步要不要真的跳转」· 单测（`agent/navigateTarget.ts`）
 *
 * ── 为什么这条要有单测 ──────────────────────────────────────────────
 * 用户 2026-10-01：「正常已经到数字孪生页面展示了，触发对话原地跳转一下反而导致
 * 数字孪生重新加载」。修法是"当前地址已经满足目标就不 navigate" —— 而这个判据
 * 一旦写反，会有两种相反的坏事：
 *   · 该跳的时候不跳（例如 ⑪ 要把 `?component=Z04` 选上，却被判成"已满足"）→ 页面上选错构件；
 *   · 不该跳的时候跳了 → 数字孪生整屏重新初始化（就是用户报的那条）。
 * 所以两种方向都在这里钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRoute, routeSatisfied } from "./navigateTarget.ts";

test("解析：`#/twin?component=Z04` 与 `/twin?component=Z04` 等价", () => {
  const withHash = parseRoute("#/twin?component=Z04");
  const without = parseRoute("/twin?component=Z04");
  assert.equal(withHash.path, "/twin");
  assert.equal(withHash.params.get("component"), "Z04");
  assert.deepEqual([...withHash.params], [...without.params]);
  /* 空地址退回根路径，不抛错 */
  assert.equal(parseRoute("").path, "/");
  assert.equal(parseRoute("#/").params.size, 0);
});

test("已经在目标页 → 不再跳（这条就是用户报的「原地跳一下重新加载」）", () => {
  /* ⑫/㉒ 的落点是 `/twin`，而当前已经在 `/twin` */
  assert.equal(routeSatisfied("#/twin", "/twin"), true);
  /* ⑪ 已经把 ?component=Z04 带上，下一轮又跳 `/twin`：目标要的信息都在地址里了 */
  assert.equal(routeSatisfied("#/twin?component=Z04", "/twin"), true);
  /* 完全同一个地址（再按一次同一个键） */
  assert.equal(routeSatisfied("#/twin?component=Z04", "/twin?component=Z04"), true);
  /* 带页签的页面同理 */
  assert.equal(routeSatisfied("#/firmware?tab=fusion", "/firmware?tab=fusion"), true);
  assert.equal(routeSatisfied("#/orders?order=wo-1", "/orders"), true, "工单页带没带 order 都算「已在工单页」");
});

test("该跳的时候必须跳（判反了会把构件选错 / 停在错页）", () => {
  /* 少了参数：⑪ 要把 Z04 选上，不能因为"路径一样"就跳过 */
  assert.equal(routeSatisfied("#/twin", "/twin?component=Z04"), false);
  /* 参数值不同：换一根柱子必须真的跳 */
  assert.equal(routeSatisfied("#/twin?component=Z01", "/twin?component=Z04"), false);
  /* 不同页面 */
  assert.equal(routeSatisfied("#/twin", "/orders"), false);
  assert.equal(routeSatisfied("#/knowledge?tab=search", "/knowledge?tab=overview"), false);
  /* 检索问题不同（第一轮带 q） */
  assert.equal(routeSatisfied("#/knowledge?tab=search&q=甲", "/knowledge?tab=search&q=乙"), false);
  assert.equal(routeSatisfied("#/knowledge?tab=search", "/knowledge?tab=search&q=乙"), false);
});

test("参数顺序不影响判定（URLSearchParams 的写出顺序可能与手写不同）", () => {
  assert.equal(routeSatisfied("#/knowledge?q=%E7%94%B2&tab=search", "/knowledge?tab=search&q=甲"), true);
});
