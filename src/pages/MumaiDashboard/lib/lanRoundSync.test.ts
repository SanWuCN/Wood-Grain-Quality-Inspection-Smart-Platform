/**
 * 「本轮同步」读数 · 单测（`lib/lanRoundSync.ts`）
 *
 * ── 这一条最容易出的错 ──────────────────────────────────────────────
 * 地址比较写歪 → 面板把**跟上的端报成没跟上**（或反过来）。现场被问
 * 「两台机器是同一屏吗」时，这句话是拿来说给别人听的，错一次就很难圆。
 * 所以这里逐种情况钉住：同一地址、少参数、多参数、换页签、不跳页、只有本机。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentTurnEntity, CollabEnd } from "../api/client.ts";
import { endFollowed, endRoundNo, endRoundSuffix, navTarget, probeFollowHint, roundSyncView, selfEndIds } from "./lanRoundSync.ts";

const turn = (nav: Record<string, unknown> | null, roundNo = "⑨", at = "2026-09-20T01:00:00.000Z"): AgentTurnEntity => ({
  id: `t-${roundNo}-${at}`,
  roundNo,
  text: `第 ${roundNo} 轮台词`,
  nav,
  hostId: "host-self",
  by: "shi",
  at,
});

const end = (id: string, page: string | null, accountName = "沈"): CollabEnd => ({
  id,
  /* 地址按账号区分：面板上的"同步实测 × 本轮同步"是**按地址**对人和取名的 */
  address: accountName === "沈" ? "192.168.101.8" : accountName === "马" ? "192.168.101.9" : "192.168.101.1",
  sessionId: "demo-01",
  accountId: accountName === "沈" ? "shen" : "ma",
  accountName,
  page,
  openedAt: "2026-09-20T00:59:00.000Z",
  lastSeenAt: "2026-09-20T01:00:01.000Z",
  openedMs: 60_000,
  idleMs: 1_000,
});

test("落点按 navigate_page 同一套规则拼（tab / q / component 都要带上）", () => {
  assert.equal(navTarget({ route: "/mapping" }), "/mapping");
  assert.equal(navTarget({ route: "/hardware", tab: "triage" }), "/hardware?tab=triage");
  assert.equal(navTarget({ route: "/knowledge", tab: "search", q: "风险点处置记录" }), "/knowledge?tab=search&q=%E9%A3%8E%E9%99%A9%E7%82%B9%E5%A4%84%E7%BD%AE%E8%AE%B0%E5%BD%95");
  assert.equal(navTarget({ route: "/twin", component: "Z04" }), "/twin?component=Z04");
  /* 工单那种写法（route: "order"）落到工单列表 */
  assert.equal(navTarget({ route: "order" }), "/orders");
  /* 本轮不跳页 */
  assert.equal(navTarget(null), "");
  assert.equal(navTarget({}), "");
});

test("同页判定：跟上了就是跟上了，参数不同才算没跟上", () => {
  assert.equal(endFollowed("#/mapping", "/mapping"), true, "带 # 与不带 # 都要认");
  assert.equal(endFollowed("#/hardware?tab=triage", "/hardware?tab=triage"), true);
  /* 端地址上多带了参数（例如工单页多了 order=）仍然算跟上 */
  assert.equal(endFollowed("#/orders?order=wo-1", "/orders"), true);
  /* 页签不同 = 没跟上 */
  assert.equal(endFollowed("#/hardware?tab=env", "/hardware?tab=triage"), false);
  /* 少了目标参数 = 没跟上 */
  assert.equal(endFollowed("#/twin", "/twin?component=Z04"), false);
  /* 没上报页面 = 没跟上 */
  assert.equal(endFollowed(null, "/mapping"), false);
  /* 本轮不跳页时不做同页判断 */
  assert.equal(endFollowed("#/mapping", ""), false);
});

test("只有本机一台端：如实说「只有本机」，不吹成同步成功", () => {
  const view = roundSyncView([turn({ route: "/mapping" })], [end("self", "#/mapping", "史")], ["self"]);
  assert.ok(view);
  assert.equal(view.followed.length, 0);
  assert.equal(view.lagging.length, 0);
  assert.equal(view.tone, "warn");
  assert.match(view.verdict, /只有本机/);
});

test("全部跟上 / 有人掉队：结论能直接念（并把掉队那台停在哪一页写出来）", () => {
  /* 注入 nowMs：这一条讲的是"端已经上报过之后"的判定，别落到"刚讲完还没上报"那一档 */
  const later = Date.parse("2026-09-20T01:05:00.000Z");
  const all = roundSyncView(
    [turn({ route: "/hardware", tab: "triage" })],
    [end("self", "#/hardware?tab=triage", "史"), end("a", "#/hardware?tab=triage"), end("b", "#/hardware?tab=triage", "马")],
    ["self"],
    later,
  );
  assert.ok(all);
  assert.equal(all.followed.length, 2);
  assert.equal(all.lagging.length, 0);
  assert.equal(all.tone, "ok");
  assert.match(all.verdict, /2 台端都在第 ⑨ 轮的页面上/);

  const partial = roundSyncView(
    [turn({ route: "/hardware", tab: "triage" })],
    [end("self", "#/hardware?tab=triage", "史"), end("a", "#/hardware?tab=triage"), end("b", "#/mapping", "马")],
    ["self"],
    later,
  );
  assert.ok(partial);
  assert.equal(partial.followed.length, 1);
  assert.equal(partial.lagging.length, 1);
  assert.equal(partial.tone, "warn");
  assert.match(partial.verdict, /1 台端已同页/);
  assert.match(partial.verdict, /马（#\/mapping）/);
  assert.equal(partial.laggingLabel, "没跟上", "端已上报过、确实停在别页时，抬头是「没跟上」");
});

test("刚讲完的那几秒：端每 15 秒才上报一次，这时说「还没上报」而不是「掉队」", () => {
  /*
    实测踩到：讲完一轮立刻看面板，端还没上报，两台都被算成"还在别的页面"——
    讲解人当场会以为同步坏了。20 秒以内按"还没上报"讲（tone=info，不是警告）。
  */
  const justAfter = Date.parse("2026-09-20T01:00:05.000Z");
  const view = roundSyncView(
    [turn({ route: "/hardware", tab: "triage" })],
    [end("self", "#/hardware?tab=triage", "史"), end("a", "#/", "沈"), end("b", "#/", "马")],
    ["self"],
    justAfter,
  );
  assert.ok(view);
  assert.equal(view.lagging.length, 2, "还没上报的端仍然要列出来（不假装它们跟上了）");
  assert.equal(view.tone, "info");
  assert.match(view.verdict, /还没上报/);
  assert.equal(view.laggingLabel, "还没上报", "这一档的抬头也要写「还没上报」，不能写「没跟上」");
  assert.ok(!/掉队|还在别的页面/.test(view.verdict), "刚讲完不该下「掉队」的结论");
});

test("本轮不换页：不判同页，直接说「不换页」（别把不换页算成失败）", () => {
  const view = roundSyncView([turn({ route: "order" }, "④")], [end("self", "#/orders?order=wo-1", "史"), end("a", "#/mapping")], ["self"]);
  assert.ok(view);
  assert.equal(view.target, "/orders");
  /* 这一轮其实是要回工单页的（route: order 会被解析成 /orders），所以掉队的端要如实列出来 */
  assert.equal(view.lagging.length, 1);

  const noNav = roundSyncView([turn(null, "⑥")], [end("self", "#/workbench", "史"), end("a", "#/workbench")], ["self"]);
  assert.ok(noNav);
  assert.equal(noNav.target, "");
  assert.equal(noNav.tone, "info");
  assert.match(noNav.verdict, /不换页/);
  assert.equal(noNav.lagging.length, 0, "不换页时不该把人算成掉队");
});

test("取的是最近一轮（按 at），没有回合留痕时返回 null", () => {
  const view = roundSyncView(
    [turn({ route: "/mapping" }, "⑨", "2026-09-20T01:00:00.000Z"), turn({ route: "/orders" }, "㉕", "2026-09-20T02:00:00.000Z")],
    [end("self", "#/orders", "史")],
    ["self"],
  );
  assert.ok(view);
  assert.equal(view.roundNo, "㉕");
  assert.equal(roundSyncView([], [end("self", "#/orders", "史")], ["self"]), null);
});

test("该排除哪些端：局域网有同事时排除本机回环端；两端都在本机时不排除", () => {
  const loopA = { ...end("a", "#/mapping", "史"), address: "::ffff:127.0.0.1" };
  const loopB = { ...end("b", "#/mapping", "沈"), address: "127.0.0.1" };
  const lan = { ...end("c", "#/mapping", "马"), address: "192.168.101.8" };
  /* 有非回环端（同事在局域网上）→ 排除本机那台浏览器 */
  assert.deepEqual(selfEndIds([loopA, lan]), ["a"]);
  /* 两端都在本机（两个标签页做双机演示）→ 一个都不排除，否则面板会说"只有本机" */
  assert.deepEqual(selfEndIds([loopA, loopB]), []);
  /* 没有回环端（讲解机自己在局域网上）→ 不排除 */
  assert.deepEqual(selfEndIds([lan]), []);
  assert.deepEqual(selfEndIds([]), []);
});

test("端明细的「已在第几轮」：取它满足的**最新**那一轮，一轮都没跟到就如实说", () => {
  const turns = [
    turn({ route: "/mapping" }, "⑨", "2026-09-20T01:00:00.000Z"),
    turn({ route: "/firmware", tab: "dataset" }, "⑰", "2026-09-20T01:30:00.000Z"),
    turn({ route: "/hardware", tab: "triage" }, "⑬", "2026-09-20T01:20:00.000Z"),
  ];
  /* 停在 ⑰ 的落点上 → 报 ⑰（不是更早的 ⑨，也不是时间靠后但页面对不上的 ⑬） */
  assert.equal(endRoundNo(turns, "#/firmware?tab=dataset"), "⑰");
  assert.equal(endRoundSuffix(turns, "#/firmware?tab=dataset"), " · 已在第 ⑰ 轮");
  /* 一直停在 ⑨ 的落点上（后面的轮次都没跟）→ 报 ⑨ */
  assert.equal(endRoundNo(turns, "#/mapping"), "⑨");
  /* 刚打开还在首页 → 一轮都没跟到 */
  assert.equal(endRoundNo(turns, "#/"), null);
  assert.equal(endRoundSuffix(turns, "#/"), " · 还没跟到任何一轮");
  assert.equal(endRoundNo(turns, null), null);
  /* 不换页的那一轮不该被算成"跟到了" */
  assert.equal(endRoundNo([turn(null, "⑥")], "#/mapping"), null);
});

test("同步实测 × 本轮同步：把「收不到」与「没跟上」分开说", () => {
  const later = Date.parse("2026-09-20T01:05:00.000Z");
  const view = roundSyncView(
    [turn({ route: "/hardware", tab: "triage" })],
    [
      end("self", "#/hardware?tab=triage", "史"),
      end("a", "#/hardware?tab=triage", "沈"),
      end("b", "#/mapping", "马"),
    ],
    ["self"],
    later,
  );
  assert.ok(view);

  /* 没回执的端里：一个页面跟上了（沈 · .8）、一个本来就停在前几轮（马 · .9）→ 两句都要说清，且不能混 */
  const both = probeFollowHint(
    {
      ok: false,
      pending: [
        { id: "a", address: "192.168.101.8", accountId: "shen" },
        { id: "b", address: "192.168.101.9", accountId: "ma" },
      ],
    },
    view,
  );
  assert.match(both, /马 本来就停在别的页面/);
  assert.match(both, /沈 的页面是跟上的/);
  assert.match(both, /不是没跟上/);

  /* 全部待回执的端页面都跟上了 → 只说"像是推送/连接没到" */
  const push = probeFollowHint({ ok: false, pending: [{ id: "a", address: "192.168.101.8", accountId: "shen" }] }, view);
  assert.match(push, /更像是推送\/连接没到/);
  assert.ok(!/跟页/.test(push));

  /* 实测通过 / 没有待回执 / 没测过 / 没讲过任何一轮 → 不插话 */
  assert.equal(probeFollowHint({ ok: true, pending: [{ id: "a", address: "x", accountId: "shen" }] }, view), "");
  assert.equal(probeFollowHint({ ok: false, pending: [] }, view), "");
  assert.equal(probeFollowHint(null, view), "");
  assert.equal(
    probeFollowHint({ ok: false, pending: [{ id: "a", address: "192.168.101.8", accountId: "shen" }] }, null),
    "shen 的页面是跟上的，却没在时限内回执 —— 更像是推送/连接没到（不是没跟上）",
    "还没讲过任何一轮时也要能说清；没有端明细可对名字就退回账号名（shen，而不是 沈）",
  );
});

test("同机两端地址相同：按端 id 分谁没回执（按地址会把另一台认错）", () => {
  /*
    实测踩到：双机演示常在同一台机器上开两个浏览器（地址都是 127.0.0.1），
    按地址匹配时，面板把「未登录 @ 127.0.0.1」说成了「shi 本来就停在别的页面」。
    这一条把"按 id 分"钉死。
  */
  const later = Date.parse("2026-09-20T01:05:00.000Z");
  const sameMachine = (id: string, page: string, name: string): CollabEnd => ({
    ...end(id, page, name),
    address: "127.0.0.1",
  });
  const view = roundSyncView(
    [turn({ route: "/mapping" })],
    [sameMachine("a", "#/mapping", "沈"), sameMachine("b", "#/", "马")],
    [],
    later,
  );
  assert.ok(view);
  /* 没回执的是 b（马 · 还在首页），不是 a（沈 · 已在那一轮） */
  const hint = probeFollowHint({ ok: false, pending: [{ id: "b", address: "127.0.0.1", accountId: "ma" }] }, view);
  assert.match(hint, /马 本来就停在别的页面/, "按 id 应当认出是马");
  assert.ok(!/沈/.test(hint), "不能把同地址的另一台（沈）说成掉队");
});
