/**
 * 唤醒链路的路由判定（`routeUtterance`）
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * `scriptMatch.test.ts` 证明的是"匹配算法对"，那是**零件**；
 * 用户要的是"说「小木小木 + 关键词」→ 播对应台词"这条**链路**通。
 * 链路里唯一的分叉点就是 `routeUtterance`：它决定走剧本还是走原意图。
 * 分叉判错有两种后果，都比算法错更难查：
 *   · 该走剧本却走了意图 → 听到的是模板文案，不是台词（排练对不上稿）
 *   · 不该走剧本却走了   → 说了句无关的话，小木却念了一整段台词
 *
 * 另外这里钉住"**只有 hit 才走剧本**"：ambiguous / too-weak 一律交回原链路。
 * 演示现场"猜错轮次"比"没听懂"难堪得多。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeUtterance } from "./scriptMatch.ts";
import { mainLineOf, roundByNo, SCRIPT_ROUNDS } from "./script.ts";

test("「小木小木 + 关键词」→ kind=script 且给出逐字台词", () => {
  const cases: [string, string][] = [
    ["小木小木，读取这份工单，解读任务范围和出发清单", "①"],
    ["小木小木，请你联网查找一下现场情况，提供近三个月的天气数据，评估该地古建可能存在的风险", "②"],
    ["小木小木，对比四根木柱，按风险从高到低排序", "⑧"],
    ["小木小木，打开你标记的原图，把疑点区域放大", "⑨"],
    ["小木小木，核对接收清单，告诉我缺了什么", "⑭"],
    ["小木小木，启动数据清洗，列出需要人工审核的记录，生成数据集划分", "⑮"],
    ["小木小木，汇总新旧模型的验证结果，检查部署条件", "⑯"],
    ["小木小木，生成本次任务复盘，重点写异常原因、处置过程和后续待办", "㉑"],
  ];
  for (const [utterance, expectedNo] of cases) {
    const r = routeUtterance(utterance);
    assert.equal(r.kind, "script", `「${utterance}」应走剧本，实际走了 ${r.kind}`);
    if (r.kind !== "script") return;
    assert.equal(r.round.roundNo, expectedNo, `「${utterance}」命中了 ${r.round.roundNo}`);
    assert.equal(r.line, mainLineOf(roundByNo(expectedNo)!), "给出的应是该轮的逐字台词");
  }
});

test("模糊输入（错字 / 漏字 / 词序乱）仍走剧本", () => {
  const cases: [string, string][] = [
    ["小木小木，对比四根木柱", "⑧"],
    ["小木小木，启动数据青洗", "⑮"],
    ["小木小木，对比两个摸型", "⑯"],
    ["小木小木，工单草稿", "⑳"],
    /*
      ⚠ 这里原先是「近三个月天气」→ ②。触发器精简成 2~4 字短词之后
      （见 22c2b6f：22 轮的 triggers 改为短关键词，便于演示前准备），
      ② 现登记「近三个月天气 / 天气数据 / 古建风险 / 现场情况」；
      自然不该再要求命中。换成对**现有短词**做漏字，测的仍是同一件事：
      用户只说一部分，也要命中。
    */
    ["小木小木，古剑风险", "②"],
    ["小木小木，整理出发清单和任务范围，把这份工单读了", "①"],
  ];
  for (const [utterance, expectedNo] of cases) {
    const r = routeUtterance(utterance);
    assert.equal(r.kind, "script", `「${utterance}」应走剧本`);
    if (r.kind !== "script") return;
    assert.equal(r.round.roundNo, expectedNo, `「${utterance}」命中了 ${r.round.roundNo}`);
  }
});

test("无关的话**不走**剧本（交回原有意图链路）", () => {
  const unrelated = [
    "小木小木，今天天气怎么样",
    "小木小木，帮我把灯打开",
    "小木小木，你叫什么名字",
    "小木小木，一加一等于几",
    "今天天气怎么样",
    "",
  ];
  for (const utterance of unrelated) {
    const r = routeUtterance(utterance);
    assert.equal(r.kind, "intent", `「${utterance}」不该走剧本`);
  }
});

test("只说「工单」不得触发第①轮（交接文档明令）", () => {
  /*
    《新工单红头委托与小木联动-AI交接文档 v1.0》「触发短语」一节写死了这条：
      「无关短句、低置信结果和仅说"工单"不得触发整套流程」
    这条**不能只靠"阈值刚好不够"来保证** —— 阈值将来被调低、或有人往 ① 的
    triggers 里补回「工单」，整套流程（播报 + 关预览 + 跳转 + 揭示）就会
    被两个字触发。所以在这里显式钉住。

    背景：① 的 triggers 里曾经有一条 2 字短语「工单」，已删除；
    2 字在可信度阶梯上拿 0.6 < 阈值 0.62，本来也命不中（见 scriptMatch.ts）。
  */
  for (const utterance of ["小木小木，工单", "小木小木，工单列表", "小木小木，这份工单"]) {
    const r = routeUtterance(utterance);
    assert.equal(r.kind, "intent", `「${utterance}」不得走剧本（否则两个字就能触发整套演示流程）`);
  }
  /* 反向对照：补上动词就应该命中 —— 否则上面三条可能是因为"整条链路坏了"才通过 */
  assert.equal(routeUtterance("小木小木，读取工单").kind, "script", "「读取工单」必须命中（反向对照）");
});

test("§9.2 的歧义已消除：「打开工单」不再命中 ④（也不该命中 ①）", () => {
  /*
    ── 这条记录的是**被修掉的一个缺陷**（工作清单 §9.2 点名）────────────────
    原文：「`打开工单` 当前会命中第④轮而不是第①轮，今晚要保留测试并消除歧义，
      建议第①轮至少同时包含'读取'和'工单'，第④轮至少同时包含'开工'和'清单'」

    修之前的实测：`打开工单` 命中 ④（0.75）—— 因为「开工清单」与「打开工单」
    的字符多重集高度重合（开/工/单 都在）。后果是用户想"打开这张工单看看"，
    平台却播了④的台词并跳到"核对开工清单"。

    修法（本次一起做的两件事）：
      · ① 的触发补成含动作的完整说法（「读取这份工单」等），④ 用「核对开工清单」，
        两者字面不再混淆；
      · 新增「覆盖触发说法的比例 ≥ 0.75」这道门槛，把"没听全"的输入挡在门外。

    现在的期望：`打开工单` **既不命中 ④，也不命中 ①** —— 它没有读取意图，
    交回意图链路处理（那里可能有"打开工单列表"这类正当动作）。
    ⚠ 若将来有人把它塞回 ① 的触发列表，这条会红 —— 那正是要拦住的事：
      两个字面接近、语义不同的说法被混成一轮，演示时会答错。
  */
  const r = routeUtterance("小木小木，打开工单");
  if (r.kind === "script") {
    assert.notEqual(r.round.roundNo, "④", "§9.2 要求消除的歧义又回来了：命中 ④");
    assert.notEqual(r.round.roundNo, "①", "「打开工单」没有读取意图，不该命中 ①");
  }
});

test("歧义与弱命中一律交回原链路（只有 hit 才走剧本）", () => {
  const r = routeUtterance("小木小木，汇总一下");
  assert.equal(r.kind, "intent", "歧义输入不能直接播台词");
  if (r.kind === "intent" && r.match) {
    assert.notEqual(r.match.verdict, "hit", "既然回退了，verdict 就不该是 hit");
  }
});

test("剧本每一轮都能被它自己的第一个触发说法命中（数据自洽）", () => {
  for (const round of SCRIPT_ROUNDS) {
    /*
      ⚠ ⑪ 由**本地事件**触发（triggerSource: "local-event"），按设计没有语音触发短语，
      所以这里跳过它 —— 不是放宽要求，而是它的触发来源本来就不是语音。
    */
    if (round.triggerSource !== "voice") continue;
    const r = routeUtterance(`小木小木，${round.triggers[0]}`);
    assert.equal(r.kind, "script", `${round.roundNo} 的首个触发说法没命中自己`);
    if (r.kind !== "script") return;
    assert.equal(r.round.roundNo, round.roundNo, `${round.roundNo} 命中了别的轮次`);
  }
});

test("各轮台词彼此不同，且路由给出的就是本轮台词", () => {
  const seen = new Set<string>();
  for (const round of SCRIPT_ROUNDS) {
    const r = routeUtterance(`小木小木，${round.triggers[0]}`);
    if (r.kind !== "script") continue;
    assert.equal(r.line, mainLineOf(round), `${round.roundNo} 的台词不匹配`);
    assert.ok(!seen.has(r.line), `台词重复：${r.line.slice(0, 20)}…`);
    seen.add(r.line);
  }
});