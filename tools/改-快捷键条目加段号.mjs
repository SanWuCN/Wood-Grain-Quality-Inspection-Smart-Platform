/**
 * 给 `scriptShortcutEntries.ts` 的每条补齐 `roundNo` / `lineOverride` / `text`。
 *
 * ── 这份表为什么需要工装来改 ────────────────────────────────────────
 * 表里 25 条要按**段号 → 轮次**的映射逐条加字段。手改一个字错，现场按键就会进错轮次，
 * 而且**测试抓不到**（表本身不知道"这段应该是哪一轮"）。所以：
 *   · 段号 → 轮次：`_script_extract/xiaomu_entries_final.json`（抽取结果，唯一事实源）
 *   · 轮次 → 台词：`script.ts` 的 `mainLineOf()` / 该段自己的台词
 *
 * ── 它做三件事 ────────────────────────────────────────────────────
 *   1. `roundNo`  —— 每条都绑定轮次，按键直达，不退回模糊匹配；
 *   2. `text`     —— 触发语为空（段155、段205 是「无触发语，本地事件/旁白」）或与别的条目
 *                    **逐字撞车**的，改用该段小木自己的台词当"听到的话"；
 *   3. `lineOverride` —— 这一条若**不是该轮主台词**（段15、段205、段221 都是「等待时选用」的
 *                    备用播报），显式声明"就念这一句"，否则按键念出来的是该轮 main。
 *
 * ⚠ 幂等性：本脚本只重写**整行**，输入行与输出行用同一个正则，所以连跑两遍结果一致。
 *   撞车清单写成**静态常量**而不是每遍现算 —— 现算的话第一遍改完、第二遍就检测不到了，
 *   那样第二遍会把已经改好的行又当成"没撞车"，行为随运行次数变化。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/改-快捷键条目加段号.mjs [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { SCRIPT_ROUNDS, mainLineOf } from "../src/pages/MumaiDashboard/agent/script.ts";

const FILE = "src/pages/MumaiDashboard/agent/scriptShortcutEntries.ts";
const XIAOMU = "D:\\平台\\_script_extract\\xiaomu_entries_final.json";

const entries = JSON.parse(readFileSync(XIAOMU, "utf8"));

/* 段号 → 轮次（唯一事实源） */
const roundOfSeg = new Map(entries.map((e) => [e.para, e.round]));

/*
  抽取结果里 **段221 的轮次是空的**（`"—"`）：它当初在剧本里找不到归处。
  2026-09-17 按戏份上下文挂进 ⑯ 轮 —— 搭档原话是段220（史：「小木，跟踪现场任务状态，
  同时打开归档版本的验证摘要。」），而 ⑯ 轮的 `next` 正是"本次部署使用屏幕上的归档版本"。
  改这里就等于改"段221 归哪一轮"，必须连同 `script.ts` 里那条备用行一起看。
*/
if (roundOfSeg.get(221) === "—") roundOfSeg.set(221, "⑯");

/* 段号 → 该段小木的逐字台词 */
const lineOfSeg = new Map(entries.map((e) => [e.para, e.line]));

/**
 * 去掉**句尾标点**后比较。
 *
 * ⚠ 抽取结果 `xiaomu_entries_final.json` 里的 `line` **丢了句尾句号**
 * （「…我已按照z01-z04编号」），而 `script.ts` 是「…我已按照Z01至Z04编号。」。
 * 不归一化就会把 21 条主台词误判成"不是主台词"，于是给每一轮都写上 `lineOverride` ——
 * 表面上还能跑（覆写内容就是主台词），但那张表从此失去"哪些是备用句"的信息，
 * 以后真加了第二句戏也看不出区别。
 */
const norm = (s) => String(s).replace(/[。，；、！？\s]+$/u, "").trim();

/*
  ── 备用句清单（静态，逐条有据）────────────────────────────────────
  这 3 段的戏**不是所在轮次的主台词**，所以要让播报层"就念这一句"（写 `lineOverride`）：

    · 段15  → ④ ：「收到，已启用同步备份」（主台词是段13「收到，我来核对范围…」）
    · 段205 → ⑮ ：「需要人工判断的记录已分为重复疑点…」（主台词是段203「清洗完成…」）
    · 段221 → ⑯ ：「两项记录已分开显示。现场任务按实际进度更新…」（主台词是段229「验证对照已打开…」）

  为什么写死而**不做文本比对**（试过，失败）：
  抽取结果与剧本是两份不同的文本，"同一句话"的写法能差到连字符都不同 ——
  段9 抽取件写 `z01-z04`，剧本写 `Z01至Z04`；断句也不同（，vs 。）。
  实测两轮：先按"去尾标点后互相包含"判，段9 失败；再抹掉所有标点（含 `-`）判，
  仍然失败，因为差异是**「至」这个字本身**。任何文本归一化都救不了这种差异，
  而判错的代价是给 21 条主台词都写上 `lineOverride`，那张表就失去"哪些是备用句"的信息。
  所以改用显式清单：它可核对、可复查，改剧本时一眼能看出要跟着改哪里。
*/
const BACKUP_SEGS = new Set([15, 205, 221]);

/**
 * 取出该轮里"那句备用播报"的**剧本原文**（含句尾标点）。
 *
 * 为什么不拿抽取结果的文本来比对：两份文本的写法会差到连字都不同（见上），
 * 比对上只会得到假阴性。这里改用"该轮里唯一一句非 main 的台词"——
 * ④/⑮/⑯ 恰好各只有一句（`scriptMatch.test.ts` 有断言钉住这一点），
 * 所以"唯一一句"就是"该段那一句"，不需要文本匹配。
 */
function pickBackupLine(round, own, seg) {
  const extras = round.lines.filter((l) => l.role !== "main");
  if (extras.length !== 1) {
    throw new Error(
      `段${seg} 标为备用句，但第 ${round.roundNo} 轮有 ${extras.length} 句非主台词 —— ` +
        `无法确定该念哪一句，请把 BACKUP_SEGS 与剧本一起核对`,
    );
  }
  const line = extras[0].text;
  /* 至少确认"抽取件那段话确实属于这一句"：取前 8 个汉字做锚点 */
  const anchor = String(own).replace(/[^\u4e00-\u9fa5]/gu, "").slice(0, 8);
  const haystack = String(line).replace(/[^\u4e00-\u9fa5]/gu, "");
  if (anchor && !haystack.includes(anchor)) {
    throw new Error(
      `段${seg} 与第 ${round.roundNo} 轮那句备用播报对不上（锚点「${anchor}」不在「${line}」里）`,
    );
  }
  return line;
}

/*
  **触发语撞车**（静态）：段203 与段205 原本都写着段202 那句「小木，启动数据清洗…」，
  但剧本里段205 明写「无触发语，本地事件/旁白」—— 它是等待时段选用的审核播报，
  本来就没有人喊它。两条触发语逐字相同时，按键命中哪一轮全看匹配器。
  这类条目改用**它自己那句台词**当"听到的话"（两条因此各不相同）。
*/
const COLLIDED_SEGS = new Set([203, 205]);

const src = readFileSync(FILE, "utf8");
const newline = src.includes("\r\n") ? "\r\n" : "\n";

/**
 * 表体行的形状（输入与输出共用，故幂等）。
 *
 * ⚠ 必须容忍"字段已经存在"：跑第二遍时输入里已带 `roundNo` / `lineOverride`。
 *   不允许的话第二遍一条都匹配不上 —— 而且**不报错**，只会以为"已经改好了"。
 * ⚠ 必须按 `/\r?\n/` 切行：本仓库源文件是 CRLF，只按 `\n` 切会让行尾留 `\r`，
 *   行尾锚点 `$` 永远匹配不上，同样是"静默零改动"。
 */
const LINE_RE =
  /^(\s*)\{ key: "([^"]+)", label: "(?:段(\d+)·)?([^"]+)", roundNo: "([^"]+)",(?: lineOverride: "((?:[^"\\]|\\.)*)",)? text: "(?:[^"\\]|\\.)*" \},$/;

const out = [];
let changed = 0;
let skipped = 0;
let overrides = 0;

for (const line of src.split(/\r?\n/)) {
  const m = line.match(LINE_RE);
  if (!m) {
    if (line.includes("{ key:")) {
      skipped += 1;
      console.warn(`⚠ 未匹配（格式可能漂移）：${line.trim().slice(0, 90)}`);
    }
    out.push(line);
    continue;
  }
  const [, indent, key, segText, who, roundField, existingOverride] = m;
  const seg = segText ? Number(segText) : null;

  /* 第⑩轮那条没有段号：轮次已在行里，只做"原样保留"（它没有可回填的段） */
  if (seg === null) {
    out.push(line);
    continue;
  }

  const roundNo = roundOfSeg.get(seg);
  if (!roundNo || roundNo === "—") {
    throw new Error(`段${seg} 在抽取结果里没有轮次归属，不能给它定 roundNo`);
  }
  if (roundNo !== roundField) {
    throw new Error(`段${seg} 表里写的是 ${roundField}、抽取结果是 ${roundNo} —— 先查清哪个对`);
  }

  const round = SCRIPT_ROUNDS.find((r) => r.roundNo === roundNo);
  if (!round) throw new Error(`段${seg} 指向的轮次 ${roundNo} 在剧本里不存在`);

  const own = lineOfSeg.get(seg) ?? mainLineOf(round);
  /* ① 模拟"听到的话"：撞车或曾经为空 → 用该段自己的台词 */
  const text = COLLIDED_SEGS.has(seg) ? own : undefined;
  /*
    ② 备用句 → 显式声明只念这一句。
    `lineOverride` 的内容必须是**剧本里那一句的原文**（含句尾标点）：它会被 `replyScript`
    拿去跟本轮 `lines[].text` 逐字比对，不逐字相同就被判成"稿外文本"而忽略、静默退回主台词。
    故意**不**用抽取结果那份文本（它缺标点、写法也可能不同），而是在本轮 lines 里找
    "谁包含这段文字"来确定是哪一句。
  */
  const override = BACKUP_SEGS.has(seg) ? pickBackupLine(round, own, seg) : null;

  const finalText = text ?? m[0].match(/, text: "((?:[^"\\]|\\.)*)" \},$/)?.[1];
  if (finalText == null) throw new Error(`段${seg} 取不到 text，拒绝写出半成品`);

  const overrideField = override ? `, lineOverride: ${JSON.stringify(override)}` : "";
  if (override) overrides += 1;
  out.push(
    `${indent}{ key: "${key}", label: "段${seg}·${who}", roundNo: "${roundNo}"${overrideField}, text: ${JSON.stringify(finalText)} },`,
  );
  changed += 1;
}

console.log(`条目处理 ${changed} 条　其中 lineOverride ${overrides} 条　未匹配 ${skipped} 条`);
if (!process.argv.includes("--write")) {
  console.log("（dry-run：加 --write 才落盘）");
} else {
  writeFileSync(FILE, out.join(newline), "utf8");
  console.log(`已写出 ${FILE}`);
}
