/**
 * 气泡里"用户那句话"该显示什么 —— 单测
 *
 * ── 这一组在防什么 ────────────────────────────────────────────────
 * 用户两次报的是同一个出口的不同毛病（2026-09-17）：
 *   第一次「实测下来是小木没反应，过一会儿突然就接收到一整句话」——
 *     气泡里**根本没有元素渲染** `agent.partial`；
 *   第二次「在使用一次对话后，下面再触发，小木气泡又做不到逐一显示录入信息了」——
 *     渲染顺序写成 `整句 || 实时字幕`，第一轮之后整句恒真，
 *     新一轮的逐字文本被旧句子挡住，**只有第一次能用**。
 *
 * 两次都不是"功能没写"，而是**显示优先级**写错，而且都不会报错。
 * 所以这里把优先级钉成用例：实时字幕永远压过已入库整句。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { bubbleUserText, latestUserText } from "./replyView.ts";

const round1 = "小木小木，查过去三个月我们一共到过多少个地方巡检，发现了多少个风险点，目前已修复的有多少？";
const round4 = "小木，请帮我做同步备份。";

test("第一次触发：还没有已入库整句时，显示实时字幕", () => {
  assert.equal(bubbleUserText({ wakePartial: "", partial: "小木小木", query: "" }), "小木小木");
});

test("第二次触发（用户报的回归）：上一轮整句还在，也必须显示新一轮的逐字字幕", () => {
  /* 上一轮已经入库 → query 是上一轮那句；这一轮刚开始逐字 → partial 只有几个字 */
  const shown = bubbleUserText({ wakePartial: "", partial: "小木，请帮", query: round1 });
  assert.equal(shown, "小木，请帮", "实时字幕必须压过上一轮的整句，否则第二轮永远看不到逐字");
  assert.notEqual(shown, round1, "不许把上一轮的旧句子挂在气泡上");
});

test("定稿时（实时字幕清空）才显示已入库的整句", () => {
  assert.equal(bubbleUserText({ wakePartial: "", partial: "", query: round4 }), round4);
});

test("真实唤醒的流式字幕优先级最高（麦克风正在说话时不被脚本模拟盖住）", () => {
  assert.equal(
    bubbleUserText({ wakePartial: "小木小木", partial: "小木，请帮", query: round1 }),
    "小木小木",
  );
});

test("三个来源都空 → 空串（气泡里那一格干脆不渲染）", () => {
  assert.equal(bubbleUserText({}), "");
  assert.equal(bubbleUserText({ wakePartial: "", partial: "", query: "" }), "");
});

test("最新一条用户整句由 latestUserText 取（喂给 bubbleUserText 的 query 就是它）", () => {
  const turns = [
    { kind: "user", text: round1 },
    { kind: "bot", text: "已整理为四项任务……" },
    { kind: "user", text: round4 },
  ];
  assert.equal(latestUserText(turns), round4, "取最后一条用户输入，不是第一条");
  /* 连上：定稿后气泡显示的就是最新那句 */
  assert.equal(bubbleUserText({ wakePartial: "", partial: "", query: latestUserText(turns) }), round4);
  /* 还没说过话时是空串，不是 undefined（气泡据此决定渲不渲染） */
  assert.equal(latestUserText([]), "");
  assert.equal(latestUserText([{ kind: "bot", text: "小木先说话" }]), "");
});
