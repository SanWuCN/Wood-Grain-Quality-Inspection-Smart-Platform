/**
 * 标定语料与意图库的**防漂移护栏**
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * 加一条意图要同时改**两处**语料，而这两处之间原本没有任何自动核对：
 *   · 真源：`agent/intents.ts` 的 `INTENTS[].examples`（运行时匹配用的就是它）；
 *   · 副本：`tools/agent-calib-data.mts` 的 `EXAMPLE_ROWS`（标定脚本读它）。
 * 副本文件头写着"修改 intents.ts 的 examples 时同步更新这里"——**靠人记**。
 * 忘了同步的后果不是显式报错，而是：
 *   · 标定脚本仍在跑**旧语料**，跑出"162/162 全命中"的漂亮数字；
 *   · 结论被当成"新意图也标定过了"，而实际上新例句根本没进标定集。
 * 也就是**证据失真**，比功能坏掉更难发现。
 *
 * 本测试把两处钉成逐条相等（id 集合 + 例句顺序 + 例句文本），
 * 不一致时直接报出差在哪条，省掉人工 diff。
 *
 * 顺带守住第 68 行那条既有约定：**每个例句都必须能在意图库里被自己命中**，
 * 即语料里不许出现"归属对不上"的句子（例如复制粘贴时把 B 的例句贴进 A）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { INTENTS } from "./intents.ts";
import { EXAMPLE_ROWS } from "../../../../tools/agent-calib-data.mts";

test("标定语料与意图库逐条一致（id 集合 + 例句顺序 + 文本）", () => {
  const live = INTENTS.map((item) => ({ id: item.id, examples: [...item.examples] }));
  const calib = EXAMPLE_ROWS.map((row) => ({ id: row.id, examples: [...row.examples] }));

  const liveIds = live.map((item) => item.id).sort();
  const calibIds = calib.map((item) => item.id).sort();
  assert.deepEqual(
    calibIds,
    liveIds,
    "标定语料的意图 id 与 intents.ts 对不上（新增/改名意图后忘了同步 tools/agent-calib-data.mts）",
  );

  for (const row of calib) {
    const source = live.find((item) => item.id === row.id);
    assert.ok(source, `标定语料里有 intents.ts 不存在的意图：${row.id}`);
    assert.deepEqual(
      row.examples,
      source.examples,
      `意图 ${row.id} 的例句与 intents.ts 不一致 —— 请同步 tools/agent-calib-data.mts 后重跑 标定脚本`,
    );
  }
});

test("语料条数与实测一致（数字变了要重跑标定，别让注释里的旧数字留着）", () => {
  const total = INTENTS.reduce((sum, item) => sum + item.examples.length, 0);
  assert.ok(INTENTS.length >= 30, `意图条数异常：${INTENTS.length}`);
  assert.ok(total >= 160, `例句总数异常：${total}`);
  /* 覆盖度最低要求：每条意图至少 3 个说法，否则"同一意图多种说法"的承诺就是空话 */
  const thin = INTENTS.filter((item) => item.examples.length < 3).map((item) => item.id);
  assert.deepEqual(thin, [], `这些意图的例句少于 3 条，匹配容错会很差：${thin.join("、")}`);
});

test("例句自身不得含唤醒词之外的无关前缀（保持可逐条朗读）", () => {
  /*
    演示时例句是**照着念**的，所以它必须是能直接说出口的一句话：
    不含占位符、不含量表符、不以标点开头结尾。
    （"小木，…"这种称呼前缀是允许的 —— 现场本来就会这么说。）
  */
  const bad: string[] = [];
  for (const item of INTENTS) {
    for (const example of item.examples) {
      if (/\{|\}|…|\t|\n/.test(example)) bad.push(`${item.id}: ${example}`);
      if (/^[，。、；：]|[，。、；：]$/.test(example)) bad.push(`${item.id}: ${example}`);
    }
  }
  assert.deepEqual(bad, [], `例句里有不能照读的内容：\n${bad.join("\n")}`);
});
