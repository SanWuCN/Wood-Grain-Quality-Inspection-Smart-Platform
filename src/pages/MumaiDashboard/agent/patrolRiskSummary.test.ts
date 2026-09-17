/**
 * 新增对话「查近三个月巡检风险汇总」的回归测试
 * ── 这一组在防什么 ──────────────────────────────────────────────
 *   1. **触发**：用户的原始问法必须命中新意图。改之前实测 Top1 = 0.145
 *      （`history_summary`），低于 low 阈值 → 回退兜底话术
 *      （当时是「我没有理解你的指令」，2026-09-17 起统一为「不好意思，请再说一遍」）。
 *   2. **不误伤近义意图**：新语料里「近三个月」与 `site_weather` 的
 *      「查近三个月天气」共享全部 bigram，必须钉住天气那句仍然归天气，
 *      且 margin 不被吃到 `minMargin` 以下 —— 否则以后加例句就会静默互抢。
 *   3. **数字可复核**：回答里的 6 个数字全部来自 seed，本测试逐项钉死；
 *      并核对「窗口日期与天气档案同源」「地点数是真实工单算出来的」
 *      「14 = 已修复 7 + 正在安排施工 2 + 已受理待处置 5」。
 *   4. **意图位置**：必须 append 在数组末尾，否则 `voicePackOf()` 按下标
 *      生成的「AI语音N」会整体漂移。
 *   5. **模板与事实对齐**：模板里的每个 `{占位符}` 都要能在 `INTENTS`
 *      声明的 facts 与 `facts.ts` 的表里找到，缺一个就会在运行期整段
 *      回退成 Fallback（`executor.ts` 的 missing 分支）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SEMANTIC_THRESHOLDS, understand } from "./matcher.ts";
import { INTENTS, PATROL_RISK_SUMMARY_ID, voicePackOf, type Intent } from "./intents.ts";
import { normalize } from "./lang.ts";
import { DEMO_SCENARIO_V3, HISTORIC_ORDERS, PATROL_WINDOW_RISKS, PATROL_WINDOW_STATS } from "../seed/scenario.ts";

const summary = INTENTS.find((item) => item.id === PATROL_RISK_SUMMARY_ID) as Intent;

/* ------------------------------------------------------------------ *
 * 1. 触发：原始问法与同义说法
 * ------------------------------------------------------------------ */

test("新意图存在且是 QUERY，位置在意图目录尾部（语音编号不漂移）", () => {
  assert.ok(summary, "patrol_risk_summary 必须在意图目录里");
  assert.equal(summary.type, "QUERY");
  /**
   * ⚠ 这里刻意**不写**「必须是数组最后一条」。
   *
   * 原来写的就是最后一条，结果后来追加「小木自我介绍」意图时这条断言立刻变红 ——
   * 但语音编号其实**没有**漂移（新意图也是 append 在末尾），红的是断言本身。
   * 真正要守的是「新增一律追加在目录尾部」，而不是「它永远是最后一个」：
   *   · 既有意图的相对顺序不变 → `voicePackOf` 的「AI语音N」不漂移；
   *   · 新增意图只允许出现在尾部。
   */
  const index = INTENTS.findIndex((item) => item.id === PATROL_RISK_SUMMARY_ID);
  const appended = INTENTS.slice(index).map((item) => item.id);
  assert.deepEqual(
    appended,
    [PATROL_RISK_SUMMARY_ID, "introduce_self"],
    `patrol_risk_summary 之后只应有后来追加的意图，实际：${appended.join(", ")}`,
  );
  /* 既有意图的语音编号不受影响：第一条仍是 AI语音1；编号按当前下标自动跟随 */
  assert.equal(voicePackOf(INTENTS[0].id), "AI语音1");
  assert.equal(voicePackOf(PATROL_RISK_SUMMARY_ID), `AI语音${index + 1}`);
});

test("用户原话命中新意图：Top1 + 置信档可用 + margin 过闸", () => {
  const raw = "小木，帮我查一下过去三个月我们一共到过多少个地方巡检，发现了多少个风险点，目前已修复的有多少";
  const result = understand(raw);
  assert.equal(result.rule, null, "这句话不该被任何确定性规则截走");
  assert.equal(result.ranking[0].intentId, PATROL_RISK_SUMMARY_ID);
  assert.notEqual(result.level, "fallback", `Top1=${result.ranking[0].score} 低于低置信阈值会回退`);
  assert.ok(result.marginOk, `margin=${result.margin} 低于 ${SEMANTIC_THRESHOLDS.minMargin} 会被判成"不敢猜"`);
  assert.equal(result.intent?.id, PATROL_RISK_SUMMARY_ID);
});

test("同义说法逐条命中（换时间 / 换量词 / 换动词 / 省略说法）", () => {
  const variants = [
    "查过去三个月我们一共到过多少个地方巡检，发现了多少个风险点，目前已修复的有多少",
    "过去三个月我们一共到过多少个地方巡检，发现了多少个风险点",
    "过去三个月我们一共到过多少个地方巡检",
    "近三个月巡检了多少个地方，发现多少个风险点，已修复多少个",
    "这三个月一共到过多少个地方巡检，发现了多少个风险点，已修复了多少",
    "近三个月巡了几个地方，发现几个风险点，修好多少",
    "最近三个月去巡检了几个地方，发现几个问题点，修好了几个",
    "过去三个月巡检了几处地方，多少风险点，修复多少",
  ];
  for (const text of variants) {
    const result = understand(text);
    assert.equal(result.ranking[0].intentId, PATROL_RISK_SUMMARY_ID, `未命中：「${text}」`);
    assert.ok(
      result.level === "high" || (result.level === "low" && result.marginOk),
      `「${text}」判定不可用：level=${result.level} score=${result.ranking[0].score} margin=${result.margin}`,
    );
  }
});

test("识别错字「寻寂」被容错表折回「巡检」（现场实测：寻寂人）", () => {
  assert.equal(normalize("寻寂"), "巡检");
  assert.equal(normalize("过去三个月我们一共到多少个地方寻寂人"), "过去三个月我们一共到多少个地方巡检人");
  /* 只折词组，不动单字：「寂」单独出现不应被改写 */
  assert.ok(!normalize("寂静的院子").includes("巡检"));
});

test("识别错字原句仍然触发；只问地点数的简化问法也触发", () => {
  for (const text of [
    "过去三个月我们一共到多少个地方寻寂人",
    "过去三个月我们一共到过多少个地方",
  ]) {
    const result = understand(text);
    assert.equal(result.ranking[0].intentId, PATROL_RISK_SUMMARY_ID, `未命中：「${text}」`);
    assert.ok(
      result.level === "high" || (result.level === "low" && result.marginOk),
      `「${text}」判定不可用：level=${result.level} score=${result.ranking[0].score} margin=${result.margin}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 2. 不误伤：近义意图互抢的护栏
 * ------------------------------------------------------------------ */
test("「查近三个月天气」仍归 site_weather，且不被新语料吃到 margin 以下", () => {
  const result = understand("查近三个月天气");
  assert.equal(result.ranking[0].intentId, "site_weather");
  assert.equal(result.ranking[0].score, 1);
  assert.ok(
    result.margin >= SEMANTIC_THRESHOLDS.minMargin,
    `天气句的 margin=${result.margin} 已被新意图吃掉，需要给 site_weather 补语料或收窄新语料`,
  );
  assert.ok(
    (result.ranking[1]?.score ?? 0) < SEMANTIC_THRESHOLDS.lowConfidence,
    "新意图对天气句的得分必须留在低置信阈值以下",
  );
});

test("既有的历史汇总问法不被新意图抢走", () => {
  const result = understand("五月巡检发现几个风险");
  assert.equal(result.ranking[0].intentId, "history_summary");
});

/* ------------------------------------------------------------------ *
 * 3. 数字：逐项冻结 + 派生自洽
 * ------------------------------------------------------------------ */

test("冻结值：6 个数字与演示台词一致", () => {
  assert.equal(PATROL_WINDOW_STATS.siteCount, 5);
  assert.equal(PATROL_WINDOW_STATS.riskCount, 14);
  assert.equal(PATROL_WINDOW_STATS.highRiskCount, 2);
  assert.equal(PATROL_WINDOW_STATS.repairedCount, 7);
  assert.equal(PATROL_WINDOW_STATS.scheduledCount, 2);
  assert.equal(PATROL_WINDOW_STATS.acceptedCount, 5);
});

test("窗口与天气档案同源：近三个月在本平台只有一个口径", () => {
  assert.equal(PATROL_WINDOW_STATS.rangeStart, DEMO_SCENARIO_V3.weather.rangeStart);
  assert.equal(PATROL_WINDOW_STATS.rangeEnd, DEMO_SCENARIO_V3.weather.rangeEnd);
});

test("地点数是真实工单算出来的：窗口内 5 单，五月那单不算进来", () => {
  const inWindow = HISTORIC_ORDERS.filter(
    (order) =>
      order.createdAt.slice(0, 10) >= PATROL_WINDOW_STATS.rangeStart &&
      order.createdAt.slice(0, 10) <= PATROL_WINDOW_STATS.rangeEnd,
  );
  assert.equal(inWindow.length, PATROL_WINDOW_STATS.siteCount);
  assert.ok(
    !inWindow.some((order) => order.id === "MAY-DEMO-01"),
    "五月那轮在 2026-06-11 窗口外，不能计入「近三个月」",
  );
  /* 风险记录出现的站点必须与窗口内工单站点一致，两边不能各写一套地名 */
  const orderSites = [...new Set(inWindow.map((order) => order.site))].sort();
  assert.deepEqual([...PATROL_WINDOW_STATS.sites].sort(), orderSites);
});

test("派生自洽：风险数 = 三个状态之和；高风险只数「优先复核」", () => {
  const sum =
    PATROL_WINDOW_STATS.repairedCount + PATROL_WINDOW_STATS.scheduledCount + PATROL_WINDOW_STATS.acceptedCount;
  assert.equal(sum, PATROL_WINDOW_STATS.riskCount);
  assert.equal(
    PATROL_WINDOW_RISKS.filter((item) => item.level === "优先复核").length,
    PATROL_WINDOW_STATS.highRiskCount,
  );
  /* 每条记录的状态与等级都必须落在声明的取值里，避免将来写进错别字 */
  for (const item of PATROL_WINDOW_RISKS) {
    assert.ok(["已修复", "正在安排施工", "已受理待处置"].includes(item.status), `状态越界：${item.id}`);
    assert.ok(["优先复核", "一般复核"].includes(item.level), `等级越界：${item.id}`);
  }
});

test("回答不含提词（「等待 3 秒」这类是录音时的提示，不能上屏）", () => {
  /**
   * 现场实测教训：录音版本里曾把口播提示「（等待3s）」也念出来
   * （用户听到的是"请稍候等待 3S 查询完成"）。屏幕上出现这种提词会被一眼看穿，
   * 所以模板里一律不许有 —— 出现即红。
   */
  const allTexts = INTENTS.flatMap((item) => [item.response.text, ...(item.response.alternatives ?? [])]);
  const teleprompter = allTexts.filter((text) => /等待\s*3|3\s*秒|3S|（等待/.test(text));
  assert.deepEqual(teleprompter, [], `这些模板含提词：${JSON.stringify(teleprompter)}`);
  assert.equal(/等待\s*3|3\s*秒|3S|（等待/.test(summary.response.text), false);
});

test("回答首句与预录音频一致：都是「查询完成。」", () => {
  /**
   * `VoiceOutput.speak()` 按文本**逐字**匹配语音包。预录的
   * `patrol_risk_summary.mp3` 开头念的是「查询完成」，
   * 所以模板首句必须是同一个词 —— 少了它，屏幕与录音就对不上（一句多、一句少）。
   */
  assert.ok(summary.response.text.startsWith("查询完成。"), `模板首句应为「查询完成。」：${summary.response.text.slice(0, 12)}`);
});

/* ------------------------------------------------------------------ *
 * 4. 模板 ↔ 事实：占位符必须都有出处
 * ------------------------------------------------------------------ */

test("模板占位符全部在 response.facts 里声明，且没有多余声明", () => {
  const placeholders = [...summary.response.text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(placeholders, [...summary.response.facts].sort());
});

test("模板占位符都以 patrol 前缀命名，且与 seed 的派生态一一对应", () => {
  const expected: Record<string, number> = {
    patrolSiteCount: PATROL_WINDOW_STATS.siteCount,
    patrolRiskCount: PATROL_WINDOW_STATS.riskCount,
    patrolHighRiskCount: PATROL_WINDOW_STATS.highRiskCount,
    patrolRepairedCount: PATROL_WINDOW_STATS.repairedCount,
    patrolScheduledCount: PATROL_WINDOW_STATS.scheduledCount,
    patrolAcceptedCount: PATROL_WINDOW_STATS.acceptedCount,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(summary.response.facts.includes(key), `模板声明里缺 ${key}`);
    assert.equal(typeof value, "number");
  }
  /* 资料引用只声明 docId + chunkId，标题与原文由 facts.ts 从 seed 解析 */
  for (const source of summary.response.sources ?? []) {
    assert.ok(source.docId.startsWith("doc-"), `引用落点必须是知识库文档：${source.docId}`);
    assert.ok(source.chunkId.length > 0);
  }
});
