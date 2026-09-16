/**
 * 剧本快捷键条目表的生成与**逐条路由校验**（脚手架，不是生产代码）
 *
 * 用法（任意目录）：
 *   node --import <repo>/tools/test-resolve-ts.mjs <repo>/tools/生成-剧本快捷键表.mjs
 *
 * 它做三件事：
 *   1. 读 `_script_extract/xiaomu_raw.json`（从 docx 的 XML 直接抽出的 24 条小木台词 + 触发行，逐字）；
 *   2. 对每一条，用**真实路由器** `routeUtterance()` 验证"这句触发语确实落到目标剧本轮次"；
 *   3. 打印一张表（键位 → 段号 → 触发人 → 触发原话 → 小木台词 → 路由结果），
 *      并把可直接粘进 `scriptShortcutEntries.ts` 的条目打印出来。
 *
 * ⚠ 为什么要有第 2 步：快捷键最容易出的错不是"键位冲突"，而是
 * **"说出去的话并没有落在你以为的那一轮"** —— 那样演示时小木会答非所问，
 * 而脚本本身不会报错。所以这里把"路由到哪一轮"当成硬校验打印出来，落不上就标 ✘。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const RAW = "D:\\平台\\_script_extract\\xiaomu_raw.json";
/** Windows 上动态 import 必须给 file:// URL，直接拼盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME */
const imp = (rel) => pathToFileURL(`${REPO}/${rel}`).href;

const { routeUtterance } = await import(imp("src/pages/MumaiDashboard/agent/scriptMatch.ts"));
const { SCRIPT_ROUNDS } = await import(imp("src/pages/MumaiDashboard/agent/script.ts"));

const raw = JSON.parse(readFileSync(RAW, "utf8"));

/** 从触发原话里剥掉说话人前缀与括号旁白，得到"用户口播的那句" */
function utteranceOf(trigger) {
  if (!trigger) return "";
  let text = String(trigger).replace(/^[^：:]{1,3}[：:]/, "");
  text = text.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
  return text.trim();
}

/** 去掉括号旁白后的纯台词（不含前缀） */
function plainOf(line) {
  return String(line)
    .replace(/^小木（AI语音\d+）：/, "")
    .replace(/^小木：/, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}

const keys = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
];

console.log("键位 | 段号 | 触发人 | 触发原话（去前缀） | 小木台词（去旁白） | 路由到哪一轮 | 判定");
console.log("--- | --- | --- | --- | --- | --- | ---");

let ok = 0;
let bad = 0;
const entries = [];

raw.forEach((row, index) => {
  const key = keys[index] ?? "?";
  const utter = utteranceOf(row["触发段"]);
  const line = plainOf(row["纯台词"]);
  const who = row["触发段"] ? String(row["触发段"]).split("：")[0] : "（无触发语）";

  let routed = "（无触发语，只能靠快捷键直接播）";
  let verdict = "—";
  if (utter) {
    const r = routeUtterance(utter);
    if (r.kind === "script") {
      routed = `第${r.round.roundNo}轮《${r.round.title}》`;
      /*
        逐字比对：把剧本该轮的主台词也做同样的"去括号旁白"处理，再与抽取台词比较。
        ⚠ 不要用 `includes()` 这类宽口径 —— 第一版就是那样写的，结果把"台词已被改写"
        误判成"一致"（只要有一小段重合就算过）。这里只认**完全相等**，
        不等就报出双方字数，供人工逐条修。
      */
      const main = r.round.lines.find((l) => l.role === "main") ?? r.round.lines[0];
      const roundLine = plainOf(main.text);
      if (roundLine === line) {
        verdict = "✔ 逐字一致";
        ok += 1;
      } else {
        verdict = `⚠ 台词不同（剧本 ${roundLine.length} 字 / 抽取 ${line.length} 字）`;
        bad += 1;
      }
    } else {
      routed = "（未命中剧本，走意图兜底）";
      verdict = "✘ 未落到剧本";
      bad += 1;
    }
  }

  console.log(
    `Ctrl+Q+${key} | 段${row["段号"]} | ${who} | ${utter.slice(0, 26)} | ${line.slice(0, 26)}… | ${routed} | ${verdict}`,
  );

  entries.push({ key, paragraph: row["段号"], who, utter, line });
});

console.log("");
console.log(`合计 ${raw.length} 条；路由一致 ${ok} 条；需处理 ${bad} 条；无触发语 ${raw.filter((r) => !r["触发段"]).length} 条`);
console.log("");
console.log("=== 可直接粘进 scriptShortcutEntries.ts 的条目（触发语为空者需人工给一句说法） ===");
for (const e of entries) {
  const t = e.utter || "⚠ 待补触发语";
  console.log(
    `  { key: ${JSON.stringify(e.key)}, paragraph: ${e.paragraph}, label: ${JSON.stringify(`段${e.paragraph}·${e.who}`)}, text: ${JSON.stringify(t)} },`,
  );
}
void SCRIPT_ROUNDS;
