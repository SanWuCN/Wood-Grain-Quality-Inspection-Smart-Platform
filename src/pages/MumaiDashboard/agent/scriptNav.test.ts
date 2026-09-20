/**
 * 「小木带路」的逐轮核对（v2，用户 2026-09-23 口径）
 *
 * ── 这条测试防的是什么 ──────────────────────────────────────────────
 * 用户原话：「对平台进行页面添加及和小木互动时触发的自动操作……操作或展示页面少就添加」。
 * 于是每一轮小木说完都必须在平台上**落到某张页面上**。三件事必须同时成立，缺一个
 * 就会在现场变成"念完停在原地"或者更糟的"跳进一个不存在的页面"：
 *   1. **每一轮都有 nav**（25/25）—— 漏一轮就是那一轮没有页面动作；
 *   2. **路径真的存在**（对着 `routes.tsx` 的登记核对）—— 写错路径会落进兜底路由
 *      「页面不存在」，比不跳还难看；
 *   3. **页签 key 真的存在于那个页面的页签表**（对着 `Hardware.tsx` / `Firmware.tsx`
 *      的 `TABS` 核对）—— 页签写错时页面不报错，只是**内容区一片空白**，
 *      这是最难发现的一种错（页头还在、页签一个都不高亮）。
 *
 * 页签表与路由表都在 `.tsx` 里（Node 原生类型剥离跑不了 `.tsx`），所以这里**读源码文本**
 * 提取 key —— 与 `operationInsights.test.ts` 读文件核对的做法同一路子，
 * 好处是"页面改了、这里跟着红"，而不是各写一份名单慢慢漂移。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCRIPT_ROUNDS } from "./script.ts";
import { NAV_OPS, NAV_OP_ROUTES } from "./navOp.ts";

const PAGES = new URL("../pages/", import.meta.url);
const readPage = (name: string) => readFileSync(new URL(name, PAGES), "utf8");

/** 从 `const TABS = [...]`（或带类型标注的写法）里取出全部页签 key */
function tabKeys(file: string): string[] {
  const text = readPage(file);
  const start = text.indexOf("const TABS");
  assert.notEqual(start, -1, `${file} 里找不到 const TABS 声明`);
  /* 两种写法都要认：`] as const;`（Hardware/Firmware）与不带 as const 的 `];`（Knowledge） */
  const closing = /\]\s*(?:as const)?\s*;/g;
  closing.lastIndex = start;
  const hit = closing.exec(text);
  assert.ok(hit, `${file} 的 TABS 数组没有找到结尾`);
  const block = text.slice(start, hit.index);
  return [...block.matchAll(/\{\s*key:\s*"([a-z0-9_-]+)"/g)].map((m) => m[1]);
}

/** 路由表登记的一级页面路径 */
function routePaths(): string[] {
  const text = readPage("../routes.tsx");
  return [...text.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
}

test("每一轮小木都有一个页面落点（25/25，一个都不能少）", () => {
  assert.equal(SCRIPT_ROUNDS.length, 25, "剧本轮次数量变了，先确认再改这条断言");
  const missing = SCRIPT_ROUNDS.filter((round) => !round.nav).map((round) => round.roundNo);
  assert.deepEqual(missing, [], `这些轮次没有页面落点：${missing.join(" ")}`);
});

test("工单页的轮次必须说清选中哪一张（不许留空猜单）", () => {
  for (const round of SCRIPT_ROUNDS) {
    if (round.nav?.route !== "order") continue;
    assert.ok(
      round.nav.order === "bound" || round.nav.order === "current" || typeof round.nav.order === "string",
      `第 ${round.roundNo} 轮走工单页，但没有声明订单来源（bound / current / 具体 id）`,
    );
  }
});

test("每一条 nav 路径都在路由表里登记过", () => {
  const known = new Set(routePaths());
  for (const round of SCRIPT_ROUNDS) {
    const route = round.nav?.route;
    if (!route || route === "order") continue;
    assert.ok(
      known.has(route),
      `第 ${round.roundNo} 轮要跳到 ${route}，但 routes.tsx 里没有这条路由（会落进「页面不存在」兜底页）`,
    );
  }
});

test("页内页签 key 必须存在于该页面的页签表里", () => {
  const tabsOf: Record<string, string[]> = {
    "/hardware": tabKeys("Hardware.tsx"),
    "/firmware": tabKeys("Firmware.tsx"),
    "/knowledge": tabKeys("Knowledge.tsx"),
  };
  /* 顺带钉住页签表本身没被读空：读空了下面的循环会静默全过 */
  for (const [route, keys] of Object.entries(tabsOf)) {
    assert.ok(keys.length >= 3, `${route} 只读到 ${keys.length} 个页签 key，取值逻辑可能失效了`);
  }
  for (const round of SCRIPT_ROUNDS) {
    const nav = round.nav;
    if (!nav || nav.route === "order" || !nav.tab) continue;
    const keys = tabsOf[nav.route];
    assert.ok(keys, `第 ${round.roundNo} 轮给 ${nav.route} 指定了页签，但这一页没有可核对的页签表`);
    assert.ok(
      keys.includes(nav.tab),
      `第 ${round.roundNo} 轮要打开 ${nav.route} 的 "${nav.tab}" 页签，实际页签是：${keys.join(" / ")}`,
    );
  }
});

test("非工单页的轮次不得再写 order 字段（有的话说明是从工单页复制过来的）", () => {
  for (const round of SCRIPT_ROUNDS) {
    const nav = round.nav;
    if (!nav || nav.route === "order") continue;
    assert.equal(nav.order, undefined, `第 ${round.roundNo} 轮不是工单页，却带着 order 字段`);
  }
});

test("环境记录页的轮次（⑤ 天气、⑧ 参数建议）落在同一张页面上", () => {
  /* 两轮讲的是同一件事的两半（查天气 → 给参数建议），页面不一致观众要跟着来回跳 */
  const weather = SCRIPT_ROUNDS.find((round) => round.roundNo === "⑤")?.nav;
  const advice = SCRIPT_ROUNDS.find((round) => round.roundNo === "⑧")?.nav;
  assert.deepEqual(weather, advice, "⑤ 与 ⑧ 应当落在同一张环境记录页上");
  assert.equal(weather?.tab, "env", "环境记录页的页签 key 应当是 env（Hardware.tsx 的 TABS）");
});

test("页面内操作（nav.op）必须在词表里，且跳的页面就是兑现它的那一页", () => {
  /*
    用户 2026-10-01：「针对一些只有跳转不太合适的对话加上特殊页面或操作」。
    这类"跳过去之后还要做一件事"的轮次，最容易出的错不是崩溃，而是**静默失效**：
    名字拼错、或者跳到了不会处理这个操作的页面 —— 现场表现都是"小木念完了，屏幕上什么都没发生"。
  */
  const withOp = SCRIPT_ROUNDS.filter((round) => round.nav?.op);
  assert.ok(withOp.length > 0, "至少应当有一轮声明了页面内操作（⑱ 归档验证摘要）");

  for (const round of withOp) {
    const nav = round.nav!;
    const op = nav.op!;
    assert.ok(
      (NAV_OPS as readonly string[]).includes(op),
      `第 ${round.roundNo} 轮的操作「${op}」不在词表里（写了也不会有人处理）：${NAV_OPS.join(" / ")}`,
    );
    assert.equal(
      nav.route,
      NAV_OP_ROUTES[op as (typeof NAV_OPS)[number]],
      `第 ${round.roundNo} 轮跳 ${nav.route}，但「${op}」是在另一页上兑现的 —— 跳错页 = 那一下永远不发生`,
    );
  }
  /* ⑱ 是这次新增用例：归档验证摘要落在**报告归档页**（那一页才有交付清单与校验结果） */
  const archive = SCRIPT_ROUNDS.find((round) => round.roundNo === "⑱")?.nav;
  assert.equal(archive?.route, "/archive", "⑱ 归档验证摘要应当落在报告归档页");
  assert.equal(archive?.op, "archive-verify", "⑱ 要带上「跳过去自动跑一次交付文件校验」这个操作");
});
