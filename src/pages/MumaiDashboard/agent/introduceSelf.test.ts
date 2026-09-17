/**
 * 新增对话「小木自我介绍」的回归测试
 * ── 这一组在防什么 ──────────────────────────────────────────────
 *   1. **触发**：用户原话「小木，请介绍下自己」必须命中 `introduce_self`。
 *   2. **和平台介绍分清**：`introduce_platform`（介绍平台/系统）与本意图共享
 *      「介绍」这个高频词，是本仓库最容易互抢的一对。任何一边被抢走就红 ——
 *      这正是 `site_weather` 被新语料吃到 0.524 那次教训的推广。
 *   3. **意图位置**：必须 append 在数组末尾，否则 `voicePackOf()` 按下标生成的
 *      「AI语音N」会整体漂移。
 *   4. **回答是固定身份话术**：不带占位符、不带资料引用、不给 alternatives
 *      （多一个变体就多一份要录的音频，且录音按文本逐字匹配）。
 *   5. **与 PATROL 意图无冲突**：两块新增对话互不影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SEMANTIC_THRESHOLDS, understand } from "./matcher.ts";
import { INTENTS, INTRODUCE_SELF_ID, PATROL_RISK_SUMMARY_ID, voicePackOf, type Intent } from "./intents.ts";

const self = INTENTS.find((item) => item.id === INTRODUCE_SELF_ID) as Intent;
const EXPECTED_ANSWER = "我是智能数字工程师，负责古建维保问答、参数推荐和会议主持。";

/** 判定可用 = 高分，或低置信但 margin 过闸（与 executor 的接受条件一致） */
function accepted(text: string): ReturnType<typeof understand> {
  return understand(text);
}

test("意图存在、是 RESPONSE、且位置在意图目录末尾（语音编号不漂移）", () => {
  assert.ok(self, "introduce_self 必须在意图目录里");
  assert.equal(self.type, "RESPONSE");
  assert.equal(INTENTS[INTENTS.length - 1].id, INTRODUCE_SELF_ID, "必须 append 在末尾");
  assert.notEqual(INTENTS[INTENTS.length - 2].id, INTRODUCE_SELF_ID);
  /* 既有意图的语音编号不受影响 */
  assert.equal(voicePackOf(INTENTS[0].id), "AI语音1");
  assert.equal(voicePackOf(INTRODUCE_SELF_ID), `AI语音${INTENTS.length}`);
  /* 两块新增对话都在末尾，且互不影响 */
  assert.equal(voicePackOf(PATROL_RISK_SUMMARY_ID), `AI语音${INTENTS.length - 1}`);
});

test("用户原话「小木，请介绍下自己」命中自我介绍", () => {
  const result = accepted("小木，请介绍下自己");
  assert.equal(result.rule, null, "不该被确定性规则截走");
  assert.equal(result.ranking[0].intentId, INTRODUCE_SELF_ID);
  assert.notEqual(result.level, "fallback");
  assert.ok(result.marginOk, `margin=${result.margin} 低于 ${SEMANTIC_THRESHOLDS.minMargin}`);
  assert.equal(result.intent?.id, INTRODUCE_SELF_ID);
});

test("同义说法逐条命中自我介绍", () => {
  const variants = [
    "介绍一下你自己",
    "先做个自我介绍",
    "你叫什么名字",
    "你是哪位",
    "你能干什么",
  ];
  for (const text of variants) {
    const result = accepted(text);
    assert.equal(result.ranking[0].intentId, INTRODUCE_SELF_ID, `未命中：「${text}」`);
  }
});

test("「你是谁 / 你是做什么的」归自我介绍，不被平台介绍抢走", () => {
  for (const text of ["你是谁", "你是做什么的"]) {
    const result = accepted(text);
    assert.equal(result.ranking[0].intentId, INTRODUCE_SELF_ID, `「${text}」被抢：Top1=${result.ranking[0].intentId}`);
    assert.ok(
      result.level === "high" || (result.level === "low" && result.marginOk),
      `「${text}」判定不可用：level=${result.level} margin=${result.margin}`,
    );
  }
});

test("平台介绍的问法仍然归 introduce_platform（反向护栏）", () => {
  for (const text of [
    "介绍一下这个平台",
    "介绍一下这套系统",
    "你们这个项目是干什么的",
    "木脉智检是做什么的",
  ]) {
    const result = accepted(text);
    assert.equal(result.ranking[0].intentId, "introduce_platform", `「${text}」被抢：Top1=${result.ranking[0].intentId}`);
    assert.ok(result.margin >= SEMANTIC_THRESHOLDS.minMargin, `「${text}」margin=${result.margin} 已被自我介绍吃掉`);
  }
});

test("回答是固定身份话术：逐字、无占位符、无资料引用、无同义变体", () => {
  assert.equal(self.response.text, EXPECTED_ANSWER);
  assert.equal(self.response.alternatives, undefined, "身份话术不加变体（录音按文本逐字匹配）");
  assert.equal(self.response.sources, undefined, "不带资料引用");
  assert.deepEqual(self.response.facts, [], "没有占位符，因此 facts 为空");
  assert.equal(/\{\w+\}/.test(self.response.text), false, "回答里不该有占位符");
});
