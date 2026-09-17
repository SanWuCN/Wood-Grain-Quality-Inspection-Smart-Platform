/**
 * 按新剧本逐字替换 `script.ts` 的轮次主台词（脚手架）
 *
 * 用法（仓库根目录）：
 *   node tools/改台词-按新剧本.mjs            # 预演（只打印将要改动的条数与首尾片段，不写文件）
 *   node tools/改台词-按新剧本.mjs --write    # 真正写入
 *
 * 数据来源（**逐字**，非手抄）：
 *   `D:\平台\_script_extract\xiaomu_raw.json`      —— 24 条小木台词（来自 document.xml）
 *   `D:\平台\_script_extract\xiaomu_map.json`      —— 段号 → 目标轮次（来自映射表）
 *   `D:\平台\_script_extract\xiaomu_entries.json`  —— 键位/触发语（与本任务无关，仅用于对照段号）
 *
 * ── 替换策略（为什么不是"全文搜旧台词"）────────────────────────────
 * 有的轮次台词是**多段字符串拼接**（如 ⑤ 用三段 `+` 拼成），直接搜旧文本会漏；
 * 有的旧台词在文件里出现两次（第④轮的主台词与备用句）。所以按**结构定位**：
 *   1. 找到 `roundNo: "<N>"` 那一刻；
 *   2. 到该轮对象结束（下一个 `roundNo:` 之前）为止；
 *   3. 在该区间里找 `role: "main"` 之后**第一个** `text:`，用括号配对算法取出字面量区间；
 *   4. 用新台词的单条字符串字面量替换整段。
 * 括号配对能同时兼容 `text: "…"` 与 `text:\n  "…" +\n  "…"` 两种写法。
 *
 * ⚠ 只改 `role: "main"` 的那条 `text`，其它字段（triggers/voicePack/reveal/nav/…）一律不碰。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = `${REPO}/src/pages/MumaiDashboard/agent/script.ts`;
const RAW = "D:\\平台\\_script_extract\\xiaomu_raw.json";
const MAP = "D:\\平台\\_script_extract\\xiaomu_map.json";

const write = process.argv.includes("--write");

const raw = JSON.parse(readFileSync(RAW, "utf8"));
const map = JSON.parse(readFileSync(MAP, "utf8"));
const bySeg = new Map(map.map((m) => [m.seg, m]));

/** 目标：段号 → 该段要写进哪一轮 */
/*
  ⚠ 段 15 / 段 205 这两条**不能按映射表机械替换**（预演时抓到的两个坑）：
    · 段15（"收到，已启用同步备份…"）与段13（"收到，我来核对范围…"）**同属第④轮**，
      剧本里的顺序是先核对范围、再启用备份。若把段15 写进主台词，就会把段13 顶掉，
      而段13 才是这一轮的主回答（且是**逐字一致**的那条）。所以段15 作为该轮**第二条**
      台词追加（`role: "waiting"`），主台词保持段13。
    · 段205（"需要人工判断的记录已分为…"）在第⑮轮里**已经是备用句**（`role: "waiting"`），
      它本来就对应"等待时选用"，所以**不动它**；第⑮轮的主台词仍是段203。
  这两条因此从替换任务里剔除，改由"追加/保持"另行处理。
*/
const SKIP_REPLACE = new Set(["15", "205"]);

const jobs = [];
for (const row of raw) {
  const seg = String(row["段号"]);
  if (SKIP_REPLACE.has(seg)) continue;
  const m = bySeg.get(seg);
  if (!m) continue;
  const round = m.round;
  if (!round || round === "—") continue; // 段221 无对应轮次，跳过（另行处理）
  jobs.push({ seg, round, text: row["纯台词"], key: m.idx });
}

/** 解析出每一轮的文本区间：roundNo → { start, end } */
function roundSpans(src) {
  const spans = [];
  const re = /roundNo:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) spans.push({ round: m[1], start: m.index, end: src.length });
  for (let i = 0; i < spans.length - 1; i += 1) spans[i].end = spans[i + 1].start;
  return spans;
}

/** 在区间内定位 `role: "main"` 之后的第一个 `text:`，返回其字面量区间的 [start, end) */
function mainTextSpan(src, span) {
  const chunk = src.slice(span.start, span.end);
  const roleIdx = chunk.indexOf('role: "main"');
  if (roleIdx < 0) return null;
  const textIdx = chunk.indexOf("text:", roleIdx);
  if (textIdx < 0) return null;
  const absStart = span.start + textIdx + "text:".length;
  /* 跳过空白 */
  let i = absStart;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '"') return null;
  /* 括号配对：字符串里的转义引号不算结束 */
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === '"') break;
    j += 1;
  }
  if (j >= src.length) return null;
  return { start: i, end: j + 1 };
}

function literal(text) {
  return JSON.stringify(text);
}

let src = readFileSync(SCRIPT, "utf8");
const spans = roundSpans(src);
const report = [];
/* 从后往前改：前面的区间不会被后面的替换影响 */
const ordered = [...jobs].sort((a, b) => {
  const sa = spans.findIndex((s) => s.round === a.round);
  const sb = spans.findIndex((s) => s.round === b.round);
  return sb - sa;
});

for (const job of ordered) {
  const span = spans.find((s) => s.round === job.round);
  if (!span) {
    report.push({ ...job, status: "✘ 找不到该轮次" });
    continue;
  }
  const t = mainTextSpan(src, span);
  if (!t) {
    report.push({ ...job, status: "✘ 该轮没有 role:main 的 text（可能已改过）" });
    continue;
  }
  const oldText = src.slice(t.start, t.end);
  if (oldText === literal(job.text)) {
    report.push({ ...job, status: "= 已一致，跳过" });
    continue;
  }
  src = src.slice(0, t.start) + literal(job.text) + src.slice(t.end);
  report.push({
    ...job,
    status: write ? "✔ 已替换" : "→ 将替换",
    oldHead: oldText.slice(0, 24),
    newHead: literal(job.text).slice(0, 24),
  });
}

console.log(`模式：${write ? "写入" : "预演"}`);
console.log(`段号→轮次任务：${jobs.length} 条`);
for (const r of report) {
  const extra = r.oldHead ? `  【${r.oldHead}…】→【${r.newHead}…】` : "";
  console.log(`  段${r.seg} → 第${r.round}轮  ${r.status}${extra}`);
}
const changed = report.filter((r) => r.status.includes("替换")).length;
console.log(`合计将改动：${changed} 处`);
if (write) {
  writeFileSync(SCRIPT, src, "utf8");
  console.log("已写入 script.ts");
} else {
  console.log("（预演结束，加 --write 才会写入）");
}
