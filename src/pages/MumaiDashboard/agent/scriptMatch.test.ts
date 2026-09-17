/**
 * 小木脚本化交互 · 匹配与数据校验（unit test）
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * 「小木小木 + 关键词」这条链路最容易出的错不是崩溃，而是**答错轮次**：
 * 用户说了甲轮的词，小木播了乙轮的台词。这种错在演示现场最难堪，
 * 而且在浏览器里手动点很难覆盖（要靠嘴说 + ASR 出错字），所以必须靠单测钉住。
 *
 * 覆盖五类：
 *   1. 数据完整性 —— 20 轮、圈号唯一、台词逐字、语音编号只在稿子标注的那几轮出现
 *   2. 精确命中 —— 稿子里的"上一句"原话必须命中对应轮次
 *   3. 容错 —— 错字 / 同音字 / 词序乱 / 漏字 仍要命中
 *   4. 收口 —— 无关句不能命中；两轮得分接近要判 ambiguous（宁可反问）
 *   5. 唤醒词剥离 —— 「小木小木」剥掉后剩下的才是要匹配的内容
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, SCRIPT_ROUND_COUNT, mainLineOf, roundByNo } from "./script.ts";
import {
  MATCH_THRESHOLD,
  decodeChar,
  MIN_MARGIN,
  canonicalChars,
  coverageOf,
  matchScriptRound,
  rankScriptRounds,
  stripWakeWord,
} from "./scriptMatch.ts";

/* ------------------------------------------------------------------ *
 * 1. 数据完整性
 * ------------------------------------------------------------------ */

test("剧本共 22 轮，圈号唯一", () => {
  /*
    ⚠ 提取稿开头写的是"20 轮完整交互"，但稿子自己的圈号是 ①~㉒ 共 22 个。
    差异来自口径：稿子把"⑧⑨ 连续两轮共享同一条下一句"和"⑮ 一轮含 2 句"分别合并计数。
    实现按**圈号**走（对稿、对台词都以圈号为准），所以这里是 22。
  */
  assert.equal(SCRIPT_ROUND_COUNT, 22);
  const nos = SCRIPT_ROUNDS.map((r) => r.roundNo);
  assert.equal(new Set(nos).size, nos.length, "圈号有重复");
});

test("每轮都有标题、至少一个触发说法、且恰有一句主台词", () => {
  for (const round of SCRIPT_ROUNDS) {
    assert.ok(round.title.length > 0, `${round.roundNo} 缺标题`);
    /* ⚠ ⑪ 是本地事件触发（triggerSource: "local-event"），按设计**没有**语音触发短语 */
    if (round.triggerSource === "voice") {
      assert.ok(round.triggers.length >= 1, `${round.roundNo} 声明了语音触发，却没有触发说法`);
    } else {
      assert.equal(round.triggers.length, 0, `${round.roundNo} 是本地事件触发，不该登记语音触发短语`);
    }
    const mains = round.lines.filter((l) => l.role === "main");
    assert.equal(mains.length, 1, `${round.roundNo} 的主台词不是恰好一句`);
    assert.ok(mainLineOf(round).length > 10, `${round.roundNo} 主台词过短，疑似占位`);
  }
});

test("触发说法不重复（重复会让两轮永远同分、必然判 ambiguous）", () => {
  const seen = new Map<string, string>();
  for (const round of SCRIPT_ROUNDS) {
    for (const trigger of round.triggers) {
      const prev = seen.get(trigger);
      assert.equal(prev, undefined, `触发说法「${trigger}」在 ${prev} 与 ${round.roundNo} 重复`);
      seen.set(trigger, round.roundNo);
    }
  }
});

test("语音编号格式合法且不冲突（编号随录音交付增加，不写死集合）", () => {
  /**
   * ⚠ 这条原来断言的是「带编号的轮次**恰好**是 ⑧⑫⑮⑯⑱⑳」——
   * 那是"截至那一天的录音交付进度"，不是不变量。第一轮交付录音（AI语音1）时它立刻变红，
   * 红的却是断言本身：稿子里带编号的是 §168/§247/§299/§344/§410/§441 六处，
   * 而录音是**逐轮追加**的（① 已补录），所以集合必然会增长。
   *
   * 真正要守的两件事：
   *   · 编号格式统一为「AI语音N」，且**不许重复**（重复会让对接音频时张冠李戴）；
   *   · 每一轮至多一个编号（避免一轮对两段音频）。
   * 「标了编号就必须在语音包里命中」由 `scriptVoicePack.test.ts` 盯着，两处不重复。
   */
  const withVoice = SCRIPT_ROUNDS.filter((r) => r.voicePack !== null);
  assert.ok(withVoice.length > 0, "至少要有一轮带编号，否则这条测试等于没测");
  for (const round of withVoice) {
    assert.match(round.voicePack ?? "", /^AI语音\d+$/, `第 ${round.roundNo} 轮的编号格式不对：${round.voicePack}`);
  }
  const numbers = withVoice.map((r) => r.voicePack);
  const duplicated = numbers.filter((item, index) => numbers.indexOf(item) !== index);
  assert.deepEqual(duplicated, [], `语音编号重复：${duplicated.join("、")}`);
  const rounds = withVoice.map((r) => r.roundNo);
  const dupRounds = rounds.filter((item, index) => rounds.indexOf(item) !== index);
  assert.deepEqual(dupRounds, [], `同一轮出现多个语音编号：${dupRounds.join("、")}`);
});

test("含备用播报的轮次已登记，且备用台词不参与主播报", () => {
  /*
    ⚠ 这条原来断言"只有 ③ ⑮ 两轮有多行"。2026-09-17 按新剧本补戏份时，
    段15（同步备份）挂进了 ④、段221（两项记录已分开显示）挂进了 ⑯ ——
    两处都是稿子标「等待时选用」的备用播报，按 `role: "waiting"` 存档。
    所以名单变成 4 轮；**本意不变**：多行只能是非 main 的备用句，
    且它们的内容绝不能混进主播报（否则现场会把"等待中的话"当成结论念出来）。
  */
  const withExtra = SCRIPT_ROUNDS.filter((r) => r.lines.length > 1);
  assert.deepEqual(withExtra.map((r) => r.roundNo), ["③", "④", "⑮", "⑯"]);
  for (const round of withExtra) {
    const extras = round.lines.filter((l) => l.role !== "main");
    assert.equal(
      extras.length,
      round.lines.length - 1,
      `第 ${round.roundNo} 轮的多行里混进了第二条 main`,
    );
    for (const extra of extras) {
      assert.ok(
        !mainLineOf(round).includes(extra.text),
        `第 ${round.roundNo} 轮的备用句混进了主播报：${extra.text.slice(0, 18)}…`,
      );
    }
  }
  const r15 = roundByNo("⑮");
  assert.ok(r15);
  assert.equal(r15.lines[1].role, "audit");
  assert.ok(!mainLineOf(r15).includes("重复疑点"), "主台词不应包含备用播报内容");
});

test("⑪ 是唯一由小木主动发起、没有对应意图的预警轮", () => {
  const r11 = roundByNo("⑪");
  assert.ok(r11);
  assert.equal(r11.intentId, null);
  assert.ok(r11.precondition && r11.precondition.includes("主动起头"));
});

/* ------------------------------------------------------------------ *
 * 2. 精确命中：每一轮**自己登记的准备短语**都要能触发它
 * ------------------------------------------------------------------ */

/**
 * ⚠ 这一组原先钉的是**稿子里的长句**（「小木，把补采、数据审核和适配验证拆成任务卡…」）。
 *
 * 触发器在 22c2b6f 改成了 **2~4 字短关键词**（「任务卡」「拆成任务卡」这种），
 * 长句就不再是准备短语，于是长句断言全部失效。
 *
 * 演示的实际口径是：**短语提前准备好、照着说**（用户明确要求保持精简短语，
 * 并接受"长句可能被子串抢走"——准备阶段规避即可）。所以这里改为
 * **按剧本登记的 triggers 逐条断言**，与 `tools/验唤醒链路.mjs` 同一口径：
 *
 *   · 覆盖 —— 22 轮**每一轮**都必须至少有一个短语能命中它自己（这是功能承诺）
 *   · 自洽 —— 每条登记短语都必须命中它所属的那一轮，verdict 必须是 hit
 *
 * 好处是它不会因为"改了一句台词/换了一个短语"而失效 —— 这正是上一版失守的原因。
 */
test("每一轮登记的准备短语，逐条命中它自己", () => {
  for (const round of SCRIPT_ROUNDS) {
    /* ⑪ 由本地事件触发，没有语音触发短语 —— 跳过它，其余轮必须逐条自洽 */
    if (round.triggerSource !== "voice") continue;
    for (const phrase of round.triggers) {
      const utterance = stripWakeWord(`小木小木，${phrase}`);
      const m = matchScriptRound(utterance);
      assert.ok(m, `「${phrase}」没有返回匹配`);
      assert.equal(
        m.round.roundNo,
        round.roundNo,
        `「${phrase}」命中了 ${m.round.roundNo} 而不是 ${round.roundNo}：${m.reason}`,
      );
      assert.equal(m.verdict, "hit", `「${phrase}」判定为 ${m.verdict}：${m.reason}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3. 容错：错字 / 同音字 / 词序 / 漏字
 * ------------------------------------------------------------------ */

test("同音错字仍能命中（ASR 最常见的错误）", () => {
  const cases: [string, string][] = [
    ["比较这四住木构件，给出优先覆核顺序", "⑧"],      // 柱→住、复→覆
    ["启动数据青洗，列出需要人工合对的记录", "⑮"],      // 清→青、核→合
    ["对比两个摸型", "⑯"],                    // 模→摸
    ["把补彩、数据审核和适配验证拆成任务卡", "⑬"],      // 采→彩
    ["生成工丹草稿，列出复核位置", "⑳"],                // 单→丹
  ];
  for (const [utterance, expected] of cases) {
    const m = matchScriptRound(utterance);
    assert.ok(m, `「${utterance}」没有返回匹配`);
    assert.equal(m.round.roundNo, expected, `「${utterance}」命中了 ${m.round.roundNo}：${m.reason}`);
  }
});

test("漏字/截断仍能命中（用户只说触发词的一部分）", () => {
  const cases: [string, string][] = [
    ["读取工单", "①"],
    ["近三个月天气", "②"],
    ["开工清单", "④"],
    ["补偿参数建议", "⑤"],
    ["重建素材", "⑦"],
    ["巡检任务预检", "⑩"],
    ["核对接收清单", "⑭"],
    ["工单草稿", "⑳"],
  ];
  for (const [utterance, expected] of cases) {
    const m = matchScriptRound(utterance);
    assert.ok(m, `「${utterance}」没有返回匹配`);
    assert.equal(m.round.roundNo, expected, `「${utterance}」命中了 ${m.round.roundNo}：${m.reason}`);
  }
});

test("词序打乱仍能命中（覆盖率用计数而非子串）", () => {
  const m = matchScriptRound("整理出发清单和任务范围，把这份工单读了");
  assert.ok(m);
  assert.equal(m.round.roundNo, "①", m.reason);
});

/* ------------------------------------------------------------------ *
 * 4. 收口
 * ------------------------------------------------------------------ */

test("无关的话不能命中（宁可不答，也不能乱答台词）", () => {
  const unrelated = [
    "今天天气怎么样",
    "帮我把灯打开",
    "这个东西多少钱",
    "你叫什么名字",
    "一加一等于几",
  ];
  for (const utterance of unrelated) {
    const m = matchScriptRound(utterance);
    /* 允许返回对象，但结论必须是"没到阈值"，不能是 hit */
    if (m) {
      assert.notEqual(m.verdict, "hit", `「${utterance}」被误判为命中 ${m.round.roundNo}：${m.reason}`);
    }
  }
});

test("两轮得分接近时判 ambiguous，不硬选一个", () => {
  /*
    ⑫ 汇总本次异常证据   vs   ⑯ 汇总新旧模型的验证结果
    只说"汇总一下"时，两个都有"汇总"，应当判为歧义。
    这里断言的是**行为**：要么 too-weak、要么 ambiguous，绝不能是 hit。
  */
  const m = matchScriptRound("汇总一下");
  if (m) {
    assert.notEqual(m.verdict, "hit", `「汇总一下」不该直接命中：${m.reason}`);
  }
});

test("阈值与余量常量是有意义的值（防止被改成恒真）", () => {
  assert.ok(MATCH_THRESHOLD > 0.4 && MATCH_THRESHOLD < 0.95, "阈值要在合理区间");
  assert.ok(MIN_MARGIN > 0, "余量必须为正，否则歧义判定失效");
});

/* ------------------------------------------------------------------ *
 * 5. 唤醒词剥离与基础函数
 * ------------------------------------------------------------------ */

test("剥掉唤醒词后剩下的是要匹配的内容", () => {
  assert.equal(stripWakeWord("小木小木读取这份工单"), "读取这份工单");
  assert.equal(stripWakeWord("小木小木，读取这份工单"), "读取这份工单");
  assert.equal(stripWakeWord("小木小木 打开标注原图"), "打开标注原图");
});

test("整句「小木小木 + 关键词」直接可匹配（端到端口径）", () => {
  const m = matchScriptRound(stripWakeWord("小木小木，对比四根木柱"));
  assert.ok(m);
  assert.equal(m.round.roundNo, "⑧", m.reason);
  assert.equal(m.verdict, "hit");
});

test("canonicalChars 做同音归并，且顺序保留", () => {
  /*
    ⚠ 归并方式改过：现在是**按拼音解码**（返回值形如 `py:si`），
    不再返回"归一化后的汉字"。原来那条 `join("") === "四柱"` 的断言
    是在钉"手写同音组"那套实现的内部形态，实现一换就失效 —— 属于**断言了内部形态**。
    现在断言的是**行为**：同音的两串解码后必须相等。
  */
  assert.deepEqual(canonicalChars("四柱"), canonicalChars("四住"));
  assert.deepEqual(canonicalChars("清洗"), canonicalChars("青洗"));
  /* 顺序必须保留（覆盖率是按多重集合算的，但解码本身不能乱序） */
  assert.equal(canonicalChars("四柱").length, 2);
});

test("拼音解码：ASR 同音误听自动等价（真机实测那一条）", () => {
  /*
    用户实测：说「数据清洗」→ ASR 输出「数据清晰」→ 原先回兜底。
    根因是只能靠手写同音组，而「洗/晰」没在表里。
    现在按拼音解码，「清」与「晰」都解成 `py:qing`，自动等价 —— 不需要枚举误听字。
  */
  assert.deepEqual(canonicalChars("数据清洗"), canonicalChars("数据清晰"));
  assert.deepEqual(canonicalChars("模型"), canonicalChars("摸型"));
  assert.deepEqual(canonicalChars("巡检"), canonicalChars("询检"));
  /* 不同音的字不能被混起来（否则匹配就失去分辨力） */
  assert.notDeepEqual(canonicalChars("数据"), canonicalChars("数字"));
  assert.notDeepEqual(canonicalChars("模型"), canonicalChars("模样"));
});

test("decodeChar：手写同音组优先于拼音（保留局部微调的例外通道）", () => {
  const a = decodeChar("柱");
  const b = decodeChar("住");
  assert.equal(a, b, "同音组里的两个字必须解成同一个码");
  /* 拼音表外的字回落成它自己 */
  assert.equal(decodeChar("𠮷"), "𠮷");
});

test("coverageOf：完全覆盖=1，部分覆盖按比例，空触发=0", () => {
  assert.equal(coverageOf(canonicalChars("读取这份工单"), canonicalChars("读取工单")), 1);
  assert.equal(coverageOf(canonicalChars("读取"), canonicalChars("读取工单")), 0.5);
  assert.equal(coverageOf(canonicalChars("随便说点什么"), canonicalChars("")), 0);
});

test("rankScriptRounds 返回按分数降序的候选，且长度受 topN 限制", () => {
  const ranked = rankScriptRounds("小木小木，启动数据清洗", 3);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].round.roundNo, "⑮");
  for (let i = 0; i + 1 < ranked.length; i += 1) {
    assert.ok(ranked[i].score >= ranked[i + 1].score, "候选没有按分数降序");
  }
});
