/**
 * 生成《小木对话 · 快捷键对应表 v3.3》—— 给演示人照读的那张纸。
 *
 * ── 三条来源，一条都不手抄 ────────────────────────────────────────
 *   1. **键位与"照着说什么"** ← `scriptShortcutEntries.ts`
 *      （由 `tools-夜间/出快捷键条目.mjs` 从用户《小木对话总文案.txt》生成）；
 *   2. **小木要念的话** ← `script.ts` 的该轮主台词（逐字，剧本说了算）；
 *   3. **录音文件** ← `public/voice/manifest.json`（键 = 逐字台词）；
 *   4. **触发词** ← `script.ts` 的 `triggers`（说这些词（之一）也能触发同一轮）。
 * 表里任何一格都对得上源；源改了不重跑，`voiceDocSync.test.ts` 那一类同步锁会红。
 *
 * 用法：node "D:\平台\tools-夜间\出小木对话快捷键表.mjs"
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT =
  "D:/平台/Wood-Grain-Quality-Inspection-Smart-Platform-RAO/Wood-Grain-Quality-Inspection-Smart-Platform-RAO";
const OUT = "D:\\平台\\小木对话-快捷键对应表-v3.3.md";
const load = (rel) => import(pathToFileURL(`${ROOT}/src/pages/MumaiDashboard/${rel}`).href);

const { SCRIPT_ROUNDS, mainLineOf } = await load("agent/script.ts");
const { SCRIPT_SHORTCUT_ENTRIES } = await load("agent/scriptShortcutEntries.ts");
const { actionFor } = await load("agent/demoActions.ts");
const { SCRIPT_SHORTCUT_KEYS, SCRIPT_SEQUENCE_WINDOW_MS, shortcutLabel, walkKeyLabel } =
  await load("agent/scriptShortcutSequence.ts");
const manifest = JSON.parse(readFileSync(`${ROOT}/public/voice/manifest.json`, "utf8"));

/* 键位文本来自序列实现的唯一实现（三段前缀各不同，不能再拼一个常量前缀） */

/* ---------- 自检：条目 / 轮次 / 键位三者必须一一对应 ---------- */
if (SCRIPT_SHORTCUT_ENTRIES.length !== SCRIPT_ROUNDS.length) {
  throw new Error(`条目 ${SCRIPT_SHORTCUT_ENTRIES.length} 条 ≠ 剧本 ${SCRIPT_ROUNDS.length} 轮`);
}
if (SCRIPT_SHORTCUT_KEYS.length < SCRIPT_SHORTCUT_ENTRIES.length) {
  throw new Error(`键位只有 ${SCRIPT_SHORTCUT_KEYS.length} 个，不够 ${SCRIPT_SHORTCUT_ENTRIES.length} 条`);
}

const rows = SCRIPT_SHORTCUT_ENTRIES.map((entry, i) => {
  const round = SCRIPT_ROUNDS.find((r) => r.roundNo === entry.roundNo);
  if (!round) throw new Error(`第 ${i + 1} 条指向的轮次 ${entry.roundNo} 不存在`);
  if (entry.key !== SCRIPT_SHORTCUT_KEYS[i]) {
    throw new Error(`第 ${i + 1} 条的键位 ${entry.key} 与键表第 ${i + 1} 位 ${SCRIPT_SHORTCUT_KEYS[i]} 不一致`);
  }
  const reply = mainLineOf(round);
  const audio = typeof manifest[reply] === "string" ? manifest[reply].replace("/voice/", "") : null;
  /* 这一条是"照着说"还是"按钮触发"（后者用本轮台词当听到的话，见条目表说明） */
  const byButton = entry.text === reply;
  const action = actionFor(round.roundNo);
  return { i: i + 1, key: entry.key, label: shortcutLabel(entry.key), round, entry, reply, audio, byButton, action };
});

const noAudio = rows.filter((r) => !r.audio);
const L = [];
const w = (s = "") => L.push(s);

w("# 小木对话 · 快捷键对应表 v3.3");
w();
w("> **顺序 = 您给的《小木对话总文案.txt》25 条的顺序 = 剧本 25 轮的顺序**。");
w("> 演示时**照着序号往下按**就行：按键 → 气泡里逐字「听到」这句话 → 小木按剧本回答 + 页面动起来。");
w();
w("> 键位规则（按 10 条一段换前缀，段内都是数字键）：");
w("> · 第 **1–10** 条 → **`Ctrl+B+1`** … **`Ctrl+B+0`**（B 段）");
w("> · 第 **11–20** 条 → **`Ctrl+Y+1`** … **`Ctrl+Y+0`**（Y 段）");
w("> · 第 **21–25** 条 → **`Ctrl+M+1`** … **`Ctrl+M+5`**（M 段）");
w(`> 两次按键之间要在 **${SCRIPT_SEQUENCE_WINDOW_MS / 1000} 秒**内完成（先按住 Ctrl 按段前缀 B/Y/M，再按数字）。`);
w(">");
/* 「一条龙」组合键：用户口径 2026-09-17「专门搞一个组合键用于完整走完流程…按一下播放一个」 */
w(`> ▶ **完整走一遍不用记上面这些键位**：按 **\`${walkKeyLabel()}\`** —— 按一下走一条，`);
w(`> 第 1 条 → 第 ${rows.length} 条循环（气泡头部会显示「一条龙 3/${rows.length}」，一眼看到走到哪了）。`);
w(">");
w("> ⚠ `Ctrl+Q+L`（建工单）是**另一条**序列，与本表不冲突。");
w(`> 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
w();
w("---");
w();
w("## 一、对照表（25 条）");
w();
w("| # | 快捷键 | 照着说（触发语） | 小木要念的话 | 剧本轮次 | 录音 |");
w("| --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  /*
    ⚠ 「按钮触发」那三条（⑥⑬⑳）的字面是"不用说话"：按键等于按了那个按钮，
    小木思考一小会儿**自己开口**，气泡里不会出现"收到的消息"（用户 2026-09-17 口径）。
  */
  const say = r.byButton ? "（按钮触发：不用说话，小木想一下自己说）" : r.entry.text;
  w(
    `| ${r.i} | **\`${r.label}\`** | ${say} | ${r.reply} | ${r.round.roundNo} ${r.round.title} | ${
      r.audio ? `\`${r.audio}\`` : "**未录**"
    } |`,
  );
}
w();
w("## 二、照着念也行（每轮的语音触发词）");
w();
w("快捷键是「演示捷径」；现场如果直接说话，说下面任一**触发词**（前面加唤醒词「小木小木」）也进同一轮。");
w();
w("| 轮次 | 触发词（任说其一） |");
w("| --- | --- |");
for (const r of rows) {
  const t = r.round.triggers.length ? r.round.triggers.map((x) => `「${x}」`).join(" / ") : "**无（本地事件触发，说了不响应）**";
  w(`| ${r.round.roundNo} ${r.round.title} | ${t} |`);
}
w();
w("## 三、按下去屏幕上同时发生什么");
w();
w("小木一边说，平台一边动。左列是按的键，右列是**这一轮结束时页面上应该看到的东西**");
w("（取自动作注册表 `demoActions.ts`，不是手写的说明）。");
w();
for (const r of rows) {
  const a = r.action;
  if (!a) {
    w(`- \`${r.label}\`　${r.round.roundNo} ${r.round.title} → **（缺少动作登记，属缺陷）**`);
    continue;
  }
  const tag = a.alert ? "⚠ **预警窗**" : a.revealOnly ? "工单详情页" : "浮层";
  const btn = a.button ? `　按钮：\`${a.button}\`` : "";
  w(`- \`${r.label}\`　${r.round.roundNo} ${r.round.title} → ${tag}：${a.title}${btn}`);
}
w();
w("> ⑬（`Ctrl+Y+3`）是**唯一**小木自己起头的一轮：它会弹出**预警窗**（红色描边 +");
w("> 「预警」角标 + 确认按钮）。按钮点下去只把平台状态标成「已确认」，**不向设备发送任何指令**。");
w();
w("## 四、25 条纯文本（供校对 / 重新合成音频，逐字复制）");
w();
for (const r of rows) {
  w(`### ${String(r.i).padStart(2, "0")}. \`${r.label}\` · ${r.round.roundNo} ${r.round.title}`);
  w("```");
  w(r.reply);
  w("```");
  w();
}
w("## 五、自检");
w();
w(`- 条目数 = ${rows.length}（剧本 ${SCRIPT_ROUNDS.length} 轮，一一对应）`);
w(`- 键位：${rows.map((r) => r.label).join(" ")}`);
w(`- 已录音：${rows.length - noAudio.length} / ${rows.length}${noAudio.length ? `　**未录**：${noAudio.map((r) => r.i).join("、")}` : "　（全部就位）"}`);
w(`- 播放凭据：\`public/voice/manifest.json\`（键 = 上面"小木要念的话"逐字，命中即播录音，未命中自动回退浏览器语音）`);
w();

writeFileSync(OUT, L.join("\r\n"), "utf8");
console.log(`已写出 ${OUT}`);
console.log(`  共 ${rows.length} 条；有录音 ${rows.length - noAudio.length} 条；未录 ${noAudio.length} 条`);
if (!existsSync(`${ROOT}/public/voice/manifest.json`)) console.warn("⚠ 没找到 manifest.json");
