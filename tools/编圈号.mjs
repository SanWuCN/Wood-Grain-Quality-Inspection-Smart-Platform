/**
 * 把 script.ts 里所有 `roundNo:` 行的值按出现次序改成 ①…㉕。
 *
 * ── 为什么只做这一件事 ────────────────────────────────────────────
 * 前两次"整套重排"的脚本都因为**块边界算错**把文件写坏（缺 `{`、多 `{`）。
 * 这个脚本**不碰任何结构**：逐行扫描，只替换 `roundNo: "…"` 里的圈号本身，
 * 行数、括号、注释全都不动 —— 结构坏不了。
 *
 * 用法：node tools/编圈号.mjs [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/pages/MumaiDashboard/agent/script.ts";
const WRITE = process.argv.includes("--write");
const CIRCLED = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩","⑪","⑫","⑬","⑭","⑮","⑯","⑰","⑱","⑲","⑳","㉑","㉒","㉓","㉔","㉕"];

const src = readFileSync(FILE, "utf8");
const nl = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

let k = 0;
const before = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = /^(\s*roundNo: ")([^"]+)(",\s*)$/.exec(lines[i]);
  if (!m) continue;
  before.push(m[2]);
  if (k >= CIRCLED.length) throw new Error(`轮块多于 ${CIRCLED.length} 个`);
  lines[i] = `${m[1]}${CIRCLED[k]}${m[3]}`;
  k += 1;
}
console.log(`轮块 ${k} 个`);
console.log(`  原圈号：${before.join(" ")}`);
console.log(`  新圈号：${CIRCLED.slice(0, k).join(" ")}`);
if (k !== 25) console.log(`  ⚠ 当前 ${k} 轮（目标是 25，还需新增 ${25 - k} 条）`);

const text = lines.join(nl);
if (!process.argv.includes("--write")) console.log("（dry-run）");
else {
  writeFileSync(FILE, text, "utf8");
  console.log(`已写出 ${FILE}`);
}
