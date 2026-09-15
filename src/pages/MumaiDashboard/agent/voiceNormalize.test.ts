/**
 * §9.2 听写变体归一化 + 阶段化提示 + TTS 不自唤醒（工作清单 v1.0 §9）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * §9.2 给了 6 条**必须支持**的听写变体归一化表。它们不是"最好支持"，
 * 而是"必须"——ASR 把「古建」听成「古剑」是最容易发生的一类错，
 * 不归一化就会出现"用户说了正确的词、平台判没听懂"。
 *
 *   听写变体                        → 统一语义
 *   Z零四 / Z04 / 四号柱 / 四号木柱   → Z04
 *   古建 / 误识别为古剑               → 古建筑风险
 *   数据 / 误识别为数剧               → 数据
 *   清洗 / 误识别为青洗               → 数据清洗
 *   模型 / 误识别为摸型               → 模型对比
 *   三个月 / 近三月 / 90天            → 三个月天气区间
 *
 * §9.2 末还有两条硬要求：
 *   · 不得把 `工单`、`天气`、`模型`、`清单`、`打开` 这类**单个泛词**直接映射为动作；
 *   · 语音上下文提示应按**当前阶段短句**切换，单条 ≤40 汉字，
 *     不把 22 轮长文本一次性塞进识别提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeUtterance } from "./scriptMatch.ts";
import {
  normalizeEntitySpelling,
  phaseHintFor,
  PHASE_HINT_MAX_CHARS,
} from "./voiceNormalize.ts";

/* ------------------------------------------------------------------ *
 * 1. 实体归一化：Z04 的四种说法
 * ------------------------------------------------------------------ */

test("§9.2 Z04 的四种说法都归一化成同一个码", () => {
  for (const variant of ["Z04", "z04", "Z零四", "四号柱", "四号木柱"]) {
    assert.equal(
      normalizeEntitySpelling(variant),
      "Z04",
      `「${variant}」应归一化为 Z04`,
    );
  }
});

test("§9.2 其余编号同样归一化（Z01–Z03）", () => {
  assert.equal(normalizeEntitySpelling("Z零一"), "Z01");
  assert.equal(normalizeEntitySpelling("一号柱"), "Z01");
  assert.equal(normalizeEntitySpelling("Z零三"), "Z03");
  assert.equal(normalizeEntitySpelling("三号木柱"), "Z03");
  /* 不该被误改：不在 Z01–Z04 范围内的编号保持原样 */
  assert.equal(normalizeEntitySpelling("Z09"), "Z09");
});

/* ------------------------------------------------------------------ *
 * 2. 同音归一化：§9.2 逐条（走整条匹配链路验证）
 * ------------------------------------------------------------------ */

test("§9.2 古剑 → 古建：「古剑风险」与「古建风险」命中同一轮", () => {
  const a = routeUtterance("小木小木，古建风险");
  const b = routeUtterance("小木小木，古剑风险");
  assert.equal(a.kind, "script", "「古建风险」应命中");
  assert.equal(b.kind, "script", "「古剑风险」（ASR 误听）也必须命中");
  if (a.kind === "script" && b.kind === "script") {
    assert.equal(a.round.roundNo, b.round.roundNo, "两条说法应落到同一轮");
  }
});

test("§9.2 数剧 → 数据、青洗 → 清洗、摸型 → 模型 都能命中", () => {
  /* 这三条用"带这些误听字的完整说法"验，模拟真实 ASR 输出 */
  for (const [utterance, want] of [
    ["小木小木，清洗这批数剧", "⑮"],
    ["小木小木，青洗这批数据", "⑮"],
    ["小木小木，对比两个摸型", "⑯"],
  ] as [string, string][]) {
    const r = routeUtterance(utterance);
    assert.equal(r.kind, "script", `「${utterance}」应命中剧本`);
    if (r.kind === "script") {
      assert.equal(r.round.roundNo, want, `「${utterance}」应命中 ${want}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. 单个泛词不得映射为动作（§9.2 末）
 * ------------------------------------------------------------------ */

test("§9.2 泛词单独出现一律不触发（工单/天气/模型/清单/打开/数据）", () => {
  for (const word of ["工单", "天气", "模型", "清单", "打开", "数据", "素材", "复盘"]) {
    const r = routeUtterance(`小木小木，${word}`);
    assert.equal(r.kind, "intent", `泛词「${word}」不得触发剧本`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 阶段化提示（§9.2 末）
 * ------------------------------------------------------------------ */

test("阶段提示按当前阶段切换，且单条不超过 40 个汉字", () => {
  const hints = [
    phaseHintFor("idle"),
    phaseHintFor("listening"),
    phaseHintFor("thinking"),
    phaseHintFor("speaking"),
    phaseHintFor("confirming"),
  ];
  for (const hint of hints) {
    assert.ok(hint.length > 0, "每个阶段都要有提示");
    assert.ok(
      hint.length <= PHASE_HINT_MAX_CHARS,
      `阶段提示不得超过 ${PHASE_HINT_MAX_CHARS} 字：「${hint}」是 ${hint.length} 字`,
    );
  }
  /* 不同阶段应当给出不同提示，否则"阶段化"没意义 */
  assert.ok(new Set(hints).size >= 4, `阶段提示重复过多：${JSON.stringify(hints)}`);
});

test("阶段提示不得把 22 轮长文本塞进去（防「一次给一整套」）", () => {
  const hint = phaseHintFor("listening");
  /* 提示是"该说什么"的短引导，不该出现台词里的长串数字 */
  for (const bad of ["412.0", "3840×1920", "scan-Z04-001", "DEMO-M02b"]) {
    assert.ok(!hint.includes(bad), `阶段提示里不该出现具体数据「${bad}」`);
  }
  assert.ok(
    hint.includes("小木小木") || hint.includes("说"),
    `提示要能指导用户开口（实际：「${hint}」）`,
  );
});
