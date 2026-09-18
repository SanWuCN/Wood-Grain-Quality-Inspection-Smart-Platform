/**
 * 「工单识别」按钮的接线（unit test）
 *
 * ── 这个测试在防什么 ────────────────────────────────────────────────
 * 按钮本身在 JSX 里，`node --test` 挂不起组件；而**会静默写坏的三件事**
 * 全在这个模块里，且坏掉时都不会报错、只会现场出丑：
 *
 *   1. **点了跳错单**：② 的 `nav.order` 一旦从 `"bound"` 被改成别的东西，
 *      按钮就会去打开"列表最新那张"，而史点的是屏幕上这一张；
 *   2. **点了演错轮**：事件下标与条目表行号必须一一对应，错一位就是
 *      "点工单识别、小木念第③轮的开工清单"；
 *   3. **点了没反应**：没有条目 / 没有工单 id 时必须**返回 false**，
 *      让调用方给出提示，而不是把按钮做成一个哑巴。
 *
 * 期望值在这里再写一遍（而不是 import 后自比）：文档 §9 那句是逐字冻结的，
 * 抄进期望里才对得上"换一个字就红"的意图。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS } from "../../agent/script.ts";
import { SCRIPT_SHORTCUT_ENTRIES } from "../../agent/scriptShortcutEntries.ts";
import { KEYWORD_FIRE_EVENT } from "../../agent/keywordHint.ts";
import { commissionBinding } from "../../commissionBinding.ts";
import { cancelOrderReveal, revealSectionsFor } from "../../ordersReveal.ts";
import { RECOGNIZE_ROUND_NO, recognizeEntry, recognizeOrder, recognizeReady } from "./orderRecognize.ts";

/** 文档 §9 括号里那句（"听到的话"口径，与快捷键一览同一份文本） */
const DOC_LINE =
  "小木读取当前工单与附件索引，生成任务卡和装备核对清单，未填字段标为待补。";

/* ------------------------------------------------------------------ *
 * 1. 这一轮存在，且仍是"读绑定工单 + 展开工单页"的那一轮
 * ------------------------------------------------------------------ */

test("② 仍在条目表里，听到的那句话与文档 §9 逐字一致", () => {
  const entry = recognizeEntry();
  assert.ok(entry, "条目表里必须有 ②，否则按钮没有可派发的下标");
  assert.equal(entry.text, DOC_LINE);
  assert.notEqual(entry.proactive, true, "② 是语音轮：史说完小木才读，不是小木主动发起");
});

test("② 的落点是工单页，且取显式绑定的那张（按钮点的是屏幕上这一张）", () => {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === RECOGNIZE_ROUND_NO);
  assert.ok(round, "剧本里必须有 ②");
  assert.equal(round.nav?.route, "order");
  assert.equal(round.nav?.order, "bound");
  assert.ok(round.reveal?.target === "order-detail", "这一轮的展示面是工单页逐组展开");
  assert.equal(recognizeReady(), true);
});

/* ------------------------------------------------------------------ *
 * 2. 点下去真的派发事件，并且先绑定再派发
 * ------------------------------------------------------------------ */

test("recognizeOrder：绑定工单 → 派发既有的 script-fire 事件（下标 = 条目表行号）", () => {
  const sent: { type: string; detail: unknown }[] = [];
  const fakeWindow = {
    dispatchEvent(event: { type: string; detail?: unknown }) {
      sent.push({ type: event.type, detail: event.detail });
      return true;
    },
    /* 揭示计划会登记一个兜底 TTL 定时器：**不排真定时器**（否则测试要等 30 秒），
       这里给一个立即返回的桩，计划本身照样读得到 */
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const host = globalThis as unknown as { window?: unknown };
  const before = host.window;
  host.window = fakeWindow;
  try {
    assert.equal(recognizeOrder("wo-recognize-1"), true);
    assert.equal(sent.length, 1, "一次点击只派发一个事件");
    assert.equal(sent[0].type, KEYWORD_FIRE_EVENT);
    const expected = SCRIPT_SHORTCUT_ENTRIES.findIndex((item) => item.roundNo === RECOGNIZE_ROUND_NO);
    assert.deepEqual(sent[0].detail, { index: expected });
    assert.equal(expected, 1, "② 是条目表第 2 行（下标 1）；挪位了就要连键位一起改");
    assert.equal(commissionBinding.get(), "wo-recognize-1", "派发之前必须已经绑定这张工单");
  } finally {
    commissionBinding.bind("");
    cancelOrderReveal();
    host.window = before;
  }
});

/*
  ── 点下去那一刻，页面就该收成"读取中"的样子 ───────────────────────
  人按按钮时**已经站在这张工单页上**（整页可见）。若什么都不做，等小木开口、
  第②轮登记计划时八个分组会先全部消失再一组组亮回来 —— 台上看到"闪了一下"。
  这条断言钉住：点下去立刻只剩第一拍该有的组，且后面几组还没出现。
*/
test("点下去先收成第一拍：只剩该先出现的组，后面几组仍藏着", () => {
  const host = globalThis as unknown as { window?: unknown };
  const before = host.window;
  host.window = { dispatchEvent: () => true, setTimeout: () => 0, clearTimeout: () => {} };
  try {
    assert.equal(recognizeOrder("wo-recognize-2"), true);
    const shown = revealSectionsFor("wo-recognize-2");
    assert.ok(Array.isArray(shown), "点下去就该有揭示计划在跑（不是整页铺开）");
    assert.ok(shown.length > 0, "第一拍该有内容，否则页面会空几秒");
    assert.ok(shown.length < 4, `第一拍不该把四组都亮出来，实得 ${JSON.stringify(shown)}`);
    assert.ok(shown.includes("order"), "工单摘要属于第一拍");
    assert.equal(revealSectionsFor("wo-other"), null, "别的工单不受影响（null = 完整可见）");
  } finally {
    commissionBinding.bind("");
    cancelOrderReveal();
    host.window = before;
  }
});

/* ------------------------------------------------------------------ *
 * 3. 拿不到工单 id / 不在浏览器里 → 明确返回 false
 * ------------------------------------------------------------------ */

test("recognizeOrder：没有工单 id 或不在浏览器里时返回 false，且不留下绑定", () => {
  assert.equal(recognizeOrder(""), false, "列表还没拉回来时不能瞎绑一个空 id");
  assert.equal(commissionBinding.get(), null, "失败路径不得污染显式绑定");

  const sent: string[] = [];
  const host = globalThis as unknown as { window?: unknown };
  const before = host.window;
  host.window = { dispatchEvent: (event: { type: string }) => void sent.push(event.type) };
  try {
    /* 这一条在 Node 里**有** window：验证的是"空 id 不派发" */
    assert.equal(recognizeOrder(""), false);
    assert.deepEqual(sent, []);
  } finally {
    host.window = before;
  }
});
