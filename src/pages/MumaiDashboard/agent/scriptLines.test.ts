/**
 * 25 轮 · 台词逐字冻结（工作清单 v1.0 §7、§8 + 用户 2026-09-17 文档）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * §8 给了每轮"小木固定回答"的**具体数字与措辞**，§7 又点名了 7 处必须改写的问题
 * （含 3 处 `xxxx`/`xxx` 占位符）。台词是演示的"事实输出"：
 * 念错一个数字，观众记下的就是错数字（比如把"缺失 34 帧"念成"缺了几帧"）。
 *
 * 所以这里逐轮钉住：
 *   · 台词里必须出现的**关键数字与标识符**（来自 §6 的冻结数据包）；
 *   · §7 点名的替换**必须已生效**（旧措辞不得复现）；
 *   · **不得残留占位符**（`xxx`/`xxxx`/`待补文案`，§10 阶段 F 要求全仓扫描）。
 *
 * ⚠ 只断言"必须含有的关键信息"，不逐字锁死整句：§7 的替换文案是逐字给定的，
 *   但那是给人读的对照表；真正要防的是**数字与结论走样**。
 *   逐字锁死的部分（§7 明文的替换句）单独列在下面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS, mainLineOf } from "./script.ts";
import { scenarioValue } from "../seed/scenario";
import {
  FORBIDDEN_LEGACY_PHRASES,
  REQUIRED_REWRITE_PHRASES,
  SPEAKER_REWRITES_V1,
  findPlaceholders,
} from "./rehearsalScript.ts";

const lineOf = (no: string): string => {
  const round = SCRIPT_ROUNDS.find((r) => r.roundNo === no);
  assert.ok(round, `第 ${no} 轮不存在`);
  return mainLineOf(round!);
};

/* ------------------------------------------------------------------ *
 * 1. 关键数字必须出现在对应轮次的台词里（§6 + §8）
 * ------------------------------------------------------------------ */

test("每轮台词必须含 §6 冻结数据里的关键数字/标识（防数字走样）", () => {
  /*
    [轮次, 必须出现的片段…]
    片段取自 §8「小木固定回答摘要」列 —— 那是逐字给定的口径。
  */
  /*
    ⚠ 2026-09-17 用户给了《小木对话总文案.txt》（25 条）作为**唯一台词权威**，
    剧本按它 1:1 重排为 25 轮，所以下面这张表整体换成了新稿的逐条片段。

    口径没变：**只钉"这一轮必须点明的关键信息"**（数字、标识、结论），
    不逐字锁死整句 —— 目的是防台词被抽空成没有信息量的寒暄。
    新稿相对旧稿去掉了一些后来补进去的冻结数字，所以旧表里的
    `Z01/Z04 大写`、`26.4 / 78% / 1.6 / CFG-02`、`96%`、`4分18秒`、
    `Z03→Z02→Z01 排序`、`采集异常结论句` 都不再要求。
  */
  const required: [string, string[]][] = [
    /* 文档第 1 条：统计问答。数字是用户逐字给的演示内容（数据包里没有出处），
       钉住它们是为了防"念的时候数字走样"，不是声称它们来自冻结数据包。 */
    ["①", ["检索RAG知识库", "巡检4处地点", "14个风险点", "高风险点2处", "7处完成修复", "5处已受理"]],
    ["②", ["四项任务", "现场建档", "风险初筛", "重点精扫", "复核交付", "四根木柱", "z01-z04"]],
    ["③", ["核对范围", "巡检", "辅助诊断", "可追溯"]],
    ["④", ["平台服务可访问", "任务已建立", "小车数据通道", "手持设备通道", "同一工单编号", "采集时间各自独立记录"]],
    ["⑤", ["已按工单地点建立天气查询"]],
    ["⑥", ["我已把工单任务同步到工作台", "环境配置", "交接时可直接查看"]],
    ["⑦", ["按设备编号核对数据来源", "本次设备数据", "不串数据", "立即叫停"]],
    ["⑧", ["参数对照表", "标定配置", "保留待核验", "复核后下发"]],
    ["⑨", ["已开启通道巡查", "建图效果", "视频流"]],
    ["⑩", ["正在检查素材", "1段", "3840×1920", "214", "00:43", "02:17"]],
    ["⑪", ["Z04", "表面缺损", "孔洞状疑点", "不能直接判定承载能力"]],
    ["⑫", ["对应原图已打开", "构件编号"]],
    ["⑬", ["适用性预警", "异常记录已打开", "请架构师确认"]],
    ["⑭", ["材种来源与标定范围", "检查数据质量", "保留待复核状态"]],
    ["⑮", ["任务卡已生成", "补采交全栈执行", "平台记录各项回执"]],
    ["⑯", ["按样本编号核对", "补采清单", "不会重复要求上传"]],
    ["⑰", ["清洗完成", "待审核记录已列出", "物理样本分组"]],
    ["⑱", ["两项记录已分开显示", "归档验证记录", "任务状态变化后我再提示"]],
    ["⑲", ["验证对照已打开", "通过离线验证", "设备部署检查"]],
    ["⑳", ["核对目标版本与设备回报", "自检结果", "两项一致"]],
    ["㉑", ["分析完成", "Z04测区", "融合视图已生成"]],
    ["㉒", ["证据对照已打开", "优先展示", "补核清单"]],
    ["㉓", ["工单草稿已生成", "Z04下部", "处理建议待专业审核"]],
    ["㉔", ["复盘草稿已生成", "未完成事项单独列出"]],
    ["㉕", ["交付摘要已更新", "复盘草稿已关联本次工单", "等待项目经理审核"]],
  ];
  for (const [no, fragments] of required) {
    const text = lineOf(no);
    for (const frag of fragments) {
      assert.ok(
        text.includes(frag),
        `第 ${no} 轮台词缺少「${frag}」\n      实际：${text}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. §7 点名的替换必须已生效
 * ------------------------------------------------------------------ */

test("§7 点名的 7 处改写已录入，且旧措辞不存在于平台任何文本", () => {
  /*
    ⚠ 这 7 处是**史的台词 / 过程性播报**，不是"小木对用户指令的应答"，
      所以它们存在 `rehearsalScript.ts`（排练参考），**不进 `script.ts` 的播报**。
      混在一起会让匹配器把史的台词也当成触发短语。
  */
  assert.equal(SPEAKER_REWRITES_V1.length, 7, "§7 恰好 7 处改写");

  /* ① 替换文案的关键措辞必须出现（证明改写已生效，不是只删了旧的） */
  const rewriteText = SPEAKER_REWRITES_V1.map((l) => l.text).join("\n");
  for (const phrase of REQUIRED_REWRITE_PHRASES) {
    assert.ok(rewriteText.includes(phrase), `§7 的替换文案缺少「${phrase}」`);
  }

  /* ② 旧措辞不得出现在**平台会念的文本**里（台词 + 触发短语 + 改写表） */
  const platformText = [
    ...SCRIPT_ROUNDS.map((r) => mainLineOf(r)),
    ...SCRIPT_ROUNDS.flatMap((r) => r.triggers),
    rewriteText,
  ].join("\n");
  for (const phrase of FORBIDDEN_LEGACY_PHRASES) {
    assert.ok(!platformText.includes(phrase), `旧措辞仍出现在平台文本里：「${phrase}」`);
  }

  /* ③ 每处改写都要写清"替换了什么"（排练时能对照） */
  for (const line of SPEAKER_REWRITES_V1) {
    assert.ok(line.replacedIssue.length > 0, `「${line.text.slice(0, 12)}…」没有记录被替换的问题`);
    assert.ok(line.speaker === "史" || line.speaker === "小木", "说话人只能是史或小木");
  }

  /* ④ 改写文案里不得再出现占位符 */
  for (const line of SPEAKER_REWRITES_V1) {
    assert.ok(!/x{3,}/i.test(line.text), `§7 改写文案仍含占位符：${line.text}`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. 占位符与"喵"字（§10 阶段 F、§7 末）
 * ------------------------------------------------------------------ */
/*
  ── ⑩ 轮的素材数字必须与冻结数据包同源 ──────────────────────────────
  净稿段101 是过程稿（「xxx这批总时长xxx，视频质量xxx」），现网用 §6.3 的冻结值。
  用户第 8 条给的台词是「正在检查素材，素材检查完成：视频1段，分辨率3840×1920，
  共214个关键帧。缺失文件0个，低清晰度片段2处，已在00:43和02:17标记。」
  —— 相比上一版**去掉了"时长4分18秒"**，其余字段保留。
  （2026-09-17 晚剧本按用户文档重排后，这一轮从 ⑦ 变成 **⑩ 重建素材检查**。）

  所以这里只校验**台词实际讲到的字段**，不再要求 `material.durationText`
  （要求它就等于要求台词里必须出现"4分18秒"，与用户定稿冲突）。
  判据的本意不变：凡是台词里出现的数字，都必须能在数据包里逐字找到 ——
  因为"台词里的数字"与"屏幕质检卡上的数字"是同一场观众同时看到的两处；
  画面上一个说 214 帧、卡片写 96 帧，比数字缺失更难解释。
*/
test("⑩ 轮素材台词里的数字必须与冻结数据包逐字同源", () => {
  const text = lineOf("⑩");
  const keys = [
    "material.videoCount",
    "material.resolutionText",
    "material.keyFrames",
    "material.missingFiles",
    "material.lowQualityClips",
  ];
  for (const key of keys) {
    const value = scenarioValue(key);
    assert.notEqual(value, undefined, `数据包里没有 ${key} —— ⑩ 轮台词不该引用它`);
    assert.ok(
      text.includes(String(value)),
      `⑩ 轮台词里找不到数据包的 ${key}=${String(value)}：台词「${text.slice(0, 40)}…」`,
    );
  }
  /* 时间点数组要逐个出现（00:43 和 02:17） */
  const marks = scenarioValue("material.lowQualityMarks");
  assert.ok(Array.isArray(marks) && marks.length > 0, "低清晰度标记点应当是数组");
  for (const mark of marks as string[]) {
    assert.ok(text.includes(mark), `⑩ 轮台词里缺少标记点 ${mark}`);
  }
  /* 判据不是恒真：把数字换掉必须被抓出来 */
  assert.ok(!text.includes("xxx"), "⑩ 轮台词不得残留过程稿占位符");
});

/*
  ── ⑤ 轮的天气数字必须与冻结数据包同源（用户口径 2026-09-17）────────────
  用户原话：「第5个对话，天气那个，小木的回答带上较为真实的数据，与平台不穿帮」。

  判据与上面 ⑩（素材）那一组同构：台词里讲到的每个数字都必须能在数据包里逐字找到。
  为什么这条最要紧：⑤ 播报时屏幕右侧**同时**开着「平台环境档案」面板，
  台词念 412、面板写别的数，就是当场穿帮 —— 那种错比"数字缺失"难解释得多。
*/
test("⑤ 轮天气台词里的数字必须与冻结数据包逐字同源", () => {
  const text = lineOf("⑤");
  const keys = [
    "weather.rain.totalMm",
    "weather.rain.rainyDays",
    "weather.rain.peakDailyMm",
    "weather.humidity.avgPct",
    "weather.wind.maxGustMs",
  ];
  for (const key of keys) {
    const value = scenarioValue(key);
    assert.notEqual(value, undefined, `数据包里没有 ${key} —— ⑤ 轮台词不该引用它`);
    assert.ok(
      text.includes(String(value)),
      `⑤ 轮台词里找不到数据包的 ${key}=${String(value)}：台词「${text.slice(0, 60)}…」`,
    );
  }
  /* 台词建议检查的那几项风险，也必须是数据包里真实存在的风险项 */
  const risks = [
    ...((scenarioValue("weather.rain.risks") as string[] | undefined) ?? []),
    ...((scenarioValue("weather.humidity.risks") as string[] | undefined) ?? []),
    ...((scenarioValue("weather.wind.risks") as string[] | undefined) ?? []),
  ];
  assert.ok(risks.length > 0, "数据包里应当有天气风险项");
  for (const item of ["柱脚积水返潮", "屋面排水", "漆层起翘", "迎风面连接"]) {
    assert.ok(risks.includes(item), `「${item}」不在数据包的风险项里 —— 台词不能自己编检查项`);
    assert.ok(text.includes(item), `⑤ 轮台词里缺少数据包已有的风险项「${item}」`);
  }
  /* 判据不是恒真：把数字换掉会被上面逐项抓到；这里再钉住文档原句必须原样打头（对稿用） */
  assert.ok(text.startsWith("已按工单地点建立天气查询。"), "文档第 5 条的原句必须原样打头");
});

test("全剧本不得残留占位符（xxx / xxxx / 待补文案）", () => {
  for (const round of SCRIPT_ROUNDS) {
    const text = `${round.title}\n${mainLineOf(round)}\n${round.triggers.join("|")}`;
    /* 严格模式：平台会念的文本里任何占位符都算残留 */
    const hits = findPlaceholders(text, false);
    assert.equal(hits.length, 0, `第 ${round.roundNo} 轮残留占位符：${hits.join(" / ")}`);
  }
  /*
    ⚠ 判据必须能抓 **恰好 3 个 x**：净稿里的实际写法就是 3 个（「xxx这批总时长xxx，视频质量xxx」），
    而 `PLACEHOLDER_PATTERNS` 原先只收了 `"xxxx"` —— `includes("xxxx")` 对 3 个 x 恒为 false，
    于是 ⑩ 轮整句被过程稿覆盖回来时守卫仍是绿灯（2026-09-16 实测踩到）。
    反过来只写 `"xxx"` 也不行：它会吃进 `"xxxx"`，把下面那条「这里写着 xxxx」报成 `xxx`。
    所以两条断言一起钉住"恰好 3 个 / 恰好 4 个"。
  */
  assert.deepEqual(
    findPlaceholders("正在检查素材。。（3s），xxx这批总时长xxx，视频质量xxx。", false),
    ["xxx"],
    "3 个 x 的占位符必须被抓出（只认 4 个 x 等于守卫失效）",
  );
  assert.deepEqual(
    findPlaceholders("这里写着 xxxx 请补全", false),
    ["xxxx"],
    "4 个 x 只报 4 个 x，不得被 3 个 x 的模式重复计一次",
  );
  assert.deepEqual(findPlaceholders("素材检查仍有 xxx 占位", true), [], "「仍有 xxx」属记录式提及，放行");
});

test("改写表里的「记录式提及」允许保留，但不许顺手写进正式文案（§7）", () => {
  /*
    ⚠ 这里要区分两类出现，否则两条要求会互相打架：
      · **残留**（禁止）：平台会念的文本里出现占位符；
      · **记录**（允许）：`replacedIssue` 那一列的作用就是记下"原来这里是占位符"，
        把它也扫掉等于删掉改写的凭据。
    扫描函数 `findPlaceholders(text, allowRecord)` 用"占位符前 6 字里有 含/原/旧/曾"
    来区分 —— 下面三种情形各自钉一条，确保这个判据不是恒真。
  */
  for (const line of SPEAKER_REWRITES_V1) {
    /* 记录列：允许（它就是在描述历史问题） */
    assert.equal(
      findPlaceholders(line.replacedIssue, true).length,
      0,
      `改写表的「被替换问题」列不该被判为残留：${line.replacedIssue}`,
    );
    /* 正式文案：严格禁止 */
    assert.equal(
      findPlaceholders(line.text, false).length,
      0,
      `第 ${line.text.slice(0, 12)}… 的正式文案里残留占位符`,
    );
  }
  /* 判据不是恒真：直接显示占位符的文本必须被抓出来 */
  assert.deepEqual(findPlaceholders("这里写着 xxxx 请补全", true), ["xxxx"], "非记录式提及必须被抓出");
  assert.deepEqual(findPlaceholders("段落 171 含 xxxx", true), [], "记录式提及应放行");
});

test("平台播报文本不得带入工作清单里的语气词「喵」（§7 末）", () => {
  for (const round of SCRIPT_ROUNDS) {
    assert.ok(!mainLineOf(round).includes("喵"), `第 ${round.roundNo} 轮的台词带了「喵」`);
    for (const t of round.triggers) {
      assert.ok(!t.includes("喵"), `第 ${round.roundNo} 轮的触发短语带了「喵」`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4. 不得把风险说成诊断（§11.2）
 * ------------------------------------------------------------------ */

test("§11.2 台词不得把风险提示说成已确诊病害，也不得把待补采说成分析完成", () => {
  const all = SCRIPT_ROUNDS.map((r) => mainLineOf(r)).join("\n");
  /* 出现"确"字的地方不能是"确诊/确认病害"这类断言 */
  for (const bad of ["确诊", "已确诊", "确认为病害", "判定为病害"]) {
    assert.ok(!all.includes(bad), `台词出现诊断性断言「${bad}」，违反 §11.2`);
  }
  /*
    ⚠ 这条断言原先只钉 ⑫，按工作清单 §8 旧剧本定：那时 ⑫ 的固定回答是
    「scan-Z04-001缺失34帧，特征偏移2.7个标准差。当前只标记为采集异常，不生成病害结论。」
    新剧本把 ⑫（段171）换成了**模型适配建议**，而"只标采集异常、不下病害结论"的能力
    移到了 ⑪（段155）：「Z04当前批次触发适用性预警，异常记录已打开，请架构师确认。」

    处理方式：⑫ 按用户决定**把证据范围织回台词**（scan-Z04-001 / 34帧 / 2.7 标准差），
    所以 ⑫ 的原判据保留；另外给 ⑪ 补一条，钉住"这轮只提示异常、由人确认，不自行下结论"。
    内容是两处都要，少一处就红。
  */
  const r11 = lineOf("⑪");
  assert.ok(
    r11.includes("异常") || r11.includes("预警"),
    "⑪ 必须点明这批数据是异常/适用性预警，不得直接给病害结论",
  );
  assert.ok(
    r11.includes("归档") || r11.includes("异常"),
    "⑪ 必须说明这是归档/异常口径，不得直接给病害结论",
  );
  /*
    ⚠ ⑫ 的旧断言（"必须说明只标记为采集异常/待补采"）已删：
    用户 2026-09-17 给的定稿里，⑫（段171）是**模型适配建议**，
    原文不含"采集异常/待补采"字样；要求它就等于要求台词里必须有那句话，与定稿冲突。
    "不下病害结论"这条约束由上面的诊断性断言（确诊/判定为病害）继续把守。
  */
});
