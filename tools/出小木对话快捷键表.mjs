/**
 * 生成《小木对话 · 快捷键对应表》，并核对文档与现网剧本的差异。
 *
 * 文案来源：用户 2026-09-17 的《小木对话总文案.txt》（25 条，顺序 = 剧本顺序）。
 * 快捷键来源：用户口述方案 —— 前 10 条 `Ctrl+M+1..0`，之后按键盘 q 那一排往后。
 *
 * ⚠ 本文档一个字都不手抄：文案逐字来自那份 txt 的原文，快捷键按固定规则生成。
 *
 * 用法：node 'D:\\平台\\tools-夜间\\出小木对话快捷键表.mjs'
 */
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "file:///D:/%E5%B9%B3%E5%8F%B0/Wood-Grain-Quality-Inspection-Smart-Platform-RAO/Wood-Grain-Quality-Inspection-Smart-Platform-RAO";
const ROOT = decodeURIComponent(REPO.replace("file:///", ""));
const DOC = "C:\\Users\\jklkj\\.dsh\\attachments\\v1\\files\\4d\\4dfed92dd9fc8a45b5950f23b3bc2fb2026a09590c990b0580015dc8da2e0d75\\小木对话总文案.txt";
const OUT = "D:\\平台\\小木对话-快捷键对应表-v1.0.md";

/* ---------- 1) 解析文档：每条 = "序号：触发语 小木：回答" ---------- */
const raw = readFileSync(DOC, "utf8").split(/\r?\n/);
const items = [];
for (const line of raw) {
  const m = /^\s*(\d+)\s*[:：]\s*(.+)$/.exec(line);
  if (!m) continue;
  const no = Number(m[1]);
  const body = m[2];
  /* 以「小木：」为界切分触发语与回答；"按钮触发" 这类没有小木前缀的也要收 */
  const k = body.indexOf("小木：");
  let trigger;
  let reply;
  if (k >= 0) {
    trigger = body.slice(0, k).trim();
    reply = body.slice(k + 3).trim();
  } else {
    /* 形如 "18：小木，跟踪…。两项记录已分开显示。…" —— 没有"小木："标记，
       按用户文档原样：触发语到第一个句号为止不可靠，这里整体当作回答的**前缀+回答**，
       标记为待人工确认（保留原文，不猜切分）。 */
    trigger = "（文档中该条无「小木：」分隔，触发语待确认）";
    reply = body.trim();
  }
  items.push({ no, trigger, reply });
}
console.log(`文档解析到 ${items.length} 条`);

/* ---------- 2) 快捷键：前 10 条 Ctrl+M+1..0；之后按 q 那一排往后 ---------- */
const Q_ROW = ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"];
const NEXT_ROW = ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'"];
const keys = [
  ...Array.from({ length: 10 }, (_, i) => `Ctrl+M+${i === 9 ? 0 : i + 1}`),
  ...Q_ROW.map((k) => `Ctrl+M+${k.toUpperCase()}`),
  ...NEXT_ROW.map((k) => `Ctrl+M+${k.toUpperCase()}`),
];
if (keys.length < items.length) throw new Error(`键位不够：${keys.length} < ${items.length}`);

/* ---------- 3) 与现网剧本逐条对照 ---------- */
const { SCRIPT_ROUNDS, mainLineOf } = await import(
  `${REPO}/src/pages/MumaiDashboard/agent/script.ts`
);
const manifest = JSON.parse(readFileSync(`${ROOT}/public/voice/manifest.json`, "utf8"));
const norm = (s) => String(s).replace(/[。，；：、！？\s（()）]/g, "");

const rows = items.map((it, i) => {
  const key = keys[i];
  const hit = SCRIPT_ROUNDS.find((r) => norm(mainLineOf(r)) === norm(it.reply));
  const audio = manifest[it.reply] ? String(manifest[it.reply]).replace("/voice/", "") : null;
  return { ...it, key, inScript: hit ? hit.roundNo : null, audio, index: i + 1 };
});

/* ---------- 4) 写文件 ---------- */
const L = [];
const w = (s = "") => L.push(s);
w("# 小木对话 · 快捷键对应表（v1.0）");
w();
w("> 文案逐字来自您给的《小木对话总文案.txt》（25 条），**顺序即剧本顺序** —— 演示时按序号往下按即可。");
w("> 快捷键：前 10 条 `Ctrl+M+1` … `Ctrl+M+0`；第 11 条起按键盘 **q 那一排**往后（q w e r t y u i o p [ ] \\），再接 a 排。");
w(`> 生成时间：${new Date().toLocaleString("zh-CN")}`);
w();
w("## 一、对应表");
w();
w("| # | 快捷键 | 触发语 | 小木要说的话 | 现网剧本 | 录音 |");
w("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  w(
    `| ${r.index} | \`${r.key}\` | ${r.trigger} | ${r.reply} | ${r.inScript ? "轮" + r.inScript : "**无对应**"} | ${r.audio ? `\`${r.audio}\`` : "**待合成**"} |`,
  );
}
w();
w("## 二、待你确认的差异");
w();
const missing = rows.filter((r) => !r.inScript);
const noAudio = rows.filter((r) => !r.audio);
w(`- **现网剧本里没有的条目**（共 ${missing.length} 条）：${missing.map((r) => r.index).join("、") || "无"}`);
w(`- **还没有录音的条目**（共 ${noAudio.length} 条）：${noAudio.map((r) => r.index).join("、") || "无"}`);
w();
w("## 三、逐条纯文本（供合成音频，逐字复制）");
w();
for (const r of rows) {
  w(`### ${String(r.index).padStart(2, "0")}. \`${r.key}\``);
  w("```");
  w(r.reply);
  w("```");
  w();
}
writeFileSync(OUT, L.join("\r\n"), "utf8");
console.log(`已写出 ${OUT}`);
console.log(`  共 ${rows.length} 条；剧本已有 ${rows.length - missing.length} 条；有录音 ${rows.length - noAudio.length} 条`);
if (missing.length) console.log(`  剧本缺：${missing.map((r) => `${r.index}(${r.reply.slice(0, 16)}…)`).join("  ")}`);
