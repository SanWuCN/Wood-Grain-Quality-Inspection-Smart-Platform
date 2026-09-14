/**
 * 导出「小木语音条目清单」
 *
 * 交互稿的备注里承诺过这件事：
 *   「如需按「小木语音条目」单独导出清单（编号、触发条件、文本、预期下一动作），告诉我即可继续」
 * 这里把它做出来，数据**直接取自 `script.ts`**，不另抄一份 ——
 * 抄一份就会与代码漂移，而语音编号（AI语音3~8）是拿去做配音资源的对接键，漂不起。
 *
 * 写法说明：全部用**数组 join** 而不是模板字符串。
 * 这份文档里有大量中文引号与括号，模板串里再嵌引号极易写坏（本仓库为此返工多次），
 * 数组拼接虽然啰嗦但不会出错。
 *
 * 用法：node tools/xiaomu/导出语音清单.mjs
 *      输出目录可用 XIAOMU_OUT_DIR 覆盖（默认 D:\平台\rebuild）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { SCRIPT_ROUNDS, SCRIPT_ROUND_COUNT, mainLineOf } from "../../src/pages/MumaiDashboard/agent/script.ts";

const OUT_DIR = process.env.XIAOMU_OUT_DIR || "D:\\平台\\rebuild";
const OUT = resolve(OUT_DIR, "小木语音条目清单.md");
mkdirSync(OUT_DIR, { recursive: true });

const voiceRows = SCRIPT_ROUNDS.filter((r) => r.voicePack);
const ttsRows = SCRIPT_ROUNDS.filter((r) => !r.voicePack);

/** 表格单元格转义：竖线会破坏 markdown 表格 */
const esc = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|");

/** 带语音编号的那张表的行 */
const rowWithVoice = (r) =>
  "| **" + r.voicePack + "** | " + r.roundNo + " " + r.title + " | " + r.paragraph +
  " | " + esc(r.triggers.join(" ／ ")) + " | " + esc(mainLineOf(r)) + " | " + esc(r.next || "—") + " |";

/** 不带编号的那张表的行 */
const rowPlain = (r) =>
  "| " + r.roundNo + " " + r.title + " | " + r.paragraph +
  " | " + esc(r.triggers.join(" ／ ")) + " | " + esc(mainLineOf(r)) + " | " + esc(r.next || "—") + " |";

/*
  特殊轮次的处理口径。这不是新写的规则，而是把交互稿文末那几条整理成表格便于改稿对照，
  所以措辞尽量贴着稿子。
*/
const SPECIAL = [
  "| ⑪ | 唯一由小木**主动起头**，没有上一句问句 | 仍可被「小木小木 + 适用性预警」触发（排练方便），" +
    "但 `precondition` 写明真实流程是架构师在采集页看到「适用域待核验」事件后触发，不靠语音唤醒进入 |",
  "| ③ | 上一句属**等待时段选用**播报，非问答 | 主句可触发；备用句（`role: waiting`）**只记录不播**，" +
    "避免「没在等待却播等待文案」 |",
  "| ⑮ | 一轮含 2 句，第 2 句是人工审核未结束时的备用播报 | 只播第 1 句；第 2 句（`role: audit`）" +
    "写进 `note` 提示存在、**不主动念** —— 排演约束要求「不按倒计时编造成功」 |",
  "| ⑧⑨ | 连续两轮，下一句共享同一条史的报告台词 | 各自独立触发、互不依赖；两条台词分别逐字保留 |",
];

const CONSTRAINTS = [
  "未接通真实工具时读**预置演示结果**，且必须明确标注「预设标注演示」（⑧）；",
  "**不虚构放大定位**（⑨）；",
  "**不创建不存在的证据**；",
  "**不按倒计时编造成功**（⑰）；",
  "**不补写尚未完成的训练成绩**（⑯）。",
];

const doc = [
  "# 小木语音条目清单 · 木脉智检第二章",
  "",
  "> 生成方式：`node tools/xiaomu/导出语音清单.mjs`，数据直接取自 `agent/script.ts`" +
    "（不另抄一份，避免与代码漂移）。",
  "> 共 **" + SCRIPT_ROUND_COUNT + "** 轮；其中带配音编号 **" + voiceRows.length +
    "** 条、走 TTS **" + ttsRows.length + "** 条。",
  "",
  "## 一、带配音编号的条目（对接配音资源用这张表）",
  "",
  "| 语音编号 | 轮次 | 段落 | 触发条件（任一说法即可命中） | 逐字文本 | 预期下一动作 |",
  "|---|---|---|---|---|---|",
  ...voiceRows.map(rowWithVoice),
  "",
  "## 二、其余条目（稿子未标编号，走浏览器 TTS）",
  "",
  "| 轮次 | 段落 | 触发条件 | 逐字文本 | 预期下一动作 |",
  "|---|---|---|---|---|",
  ...ttsRows.map(rowPlain),
  "",
  "## 三、特殊轮次的处理口径（来自交互稿，实现时必须保持）",
  "",
  "| 轮次 | 特殊之处 | 现在的处理 |",
  "|---|---|---|",
  ...SPECIAL,
  "",
  "## 四、排演约束（稿子文末摘录，转载时不可丢）",
  "",
  "落成每轮的 `precondition` 字段（见 `script.ts`），触发时会随轮次一起展示给排练者：",
  "",
  ...CONSTRAINTS.map((c) => "- " + c),
  "",
  "## 五、接入方式",
  "",
  "```",
  "「小木小木」唤醒 → 唤醒通道派发 mumai:xiaomu-ask → ask() → routeUtterance()",
  "  ├─ 命中剧本（verdict = hit）→ 播该轮逐字台词（voice 列即本表的语音编号）",
  "  └─ 未命中 / 歧义 / 弱命中 → 交回原有意图链路（不猜轮次）",
  "```",
  "",
  "端到端验证：`node tools/验唤醒链路.mjs`" +
    "（逐轮驱动真实 ask()，断言界面回答与台词**完全相等**）。",
  "",
];

writeFileSync(OUT, doc.join("\n"), "utf8");
console.log("已写出 " + OUT);
console.log("  轮次 " + SCRIPT_ROUND_COUNT + "　带编号 " + voiceRows.length + "　走 TTS " + ttsRows.length);
for (const r of voiceRows) console.log("    " + r.voicePack + "  ← " + r.roundNo + " " + r.title);
