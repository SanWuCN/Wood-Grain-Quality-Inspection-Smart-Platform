/**
 * 「剧本情景里小木的每一句话都有音频吗」—— 静态覆盖核对（真清单、真文件、真快照）
 *
 * ── 为什么不能只看清单 ──────────────────────────────────────────────
 * 播放凭据是 `public/voice/manifest.json`（键 = **逐字台词**，值 = 音频路径），
 * 而现场服务的是 `dist/voice/*`。三层里任何一层对不上，表现都一模一样：
 * **静默回退浏览器合成音**（音色变了，界面上看不出任何异常）。所以这里三层都查：
 *   ① 剧本 → 清单：25 轮的主台词逐字命中（比对口径与运行时一致：只去空白）；
 *   ② 清单 → 文件：命中路径指向的文件真在 `public/voice/` 里、且大小 > 0；
 *   ③ public → dist：`dist/voice/` 里同名文件字节数一致（改完 public 没 `npm run build`
 *      的话，8000 上跑的还是旧快照 —— 这条踩过）。
 *
 * 另外查两条容易被忽略的：
 *   · **张冠李戴**：25 轮的 round-NN.mp3 必须与 25 句主台词一一对应（不许两个键指同一个、
 *     也不许某轮的主台词指到别人的文件上）；
 *   · **断链**：清单里所有值指向的文件都必须存在（留着一堆死键 = 以后改文案时看不出问题）。
 *
 * 判定口径（刻意如此，别改成"没录音就红"）：
 *   · 一轮的**主台词**（`role === "main"`）必须有音频 —— 它是唯一会被念出来的那句；
 *   · `host` / `audit` / `waiting` 行**设计上不播报**（executor 只取 main），
 *     它们没有音频不是缺口，报告里单独列出来说明；
 *   · 意图问答（"示例问句"那条路径）走 `composeReply` 的同义模板随机挑，
 *     静态穷举不了，这里只报清单里已有的条数，**不声称全覆盖**。
 *
 * 用法（仓库根目录）：node tools/验收-小木音频覆盖.mjs
 * 退出码：0 = 剧本 25 轮全覆盖且三层一致；1 = 有缺口（逐条打印）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCRIPT_ROUNDS } from "../src/pages/MumaiDashboard/agent/script.ts";

const ROOT = new URL("../", import.meta.url);
const MANIFEST = fileURLToPath(new URL("public/voice/manifest.json", ROOT));
const VOICE_DIR = fileURLToPath(new URL("public/voice", ROOT));
const DIST_VOICE_DIR = fileURLToPath(new URL("dist/voice", ROOT));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};
const note = (text) => console.log(`    · ${text}`);

/** 与 `voicePack.ts` 的 `normalize()` 同一口径：只去空白，标点全角一律保持 */
const normalize = (text) => text.trim().replace(/[\s]+/g, "");

const fileNameOf = (url) => String(url).replace(/^\/voice\//, "");

console.log(`清单：${MANIFEST}`);
console.log(`音频目录：${VOICE_DIR}\n`);

if (!existsSync(MANIFEST)) {
  console.error("✗ 找不到 public/voice/manifest.json —— 播放凭据缺失，整个语音包都不生效");
  process.exit(1);
}
const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
/** 键比对用去空白版本；`_说明` / `_注意` 这类下划线开头的元信息不算键 */
const pack = new Map();
let metaCount = 0;
for (const [key, value] of Object.entries(raw)) {
  if (key.startsWith("_")) {
    metaCount += 1;
    continue;
  }
  if (typeof value === "string" && value) pack.set(normalize(key), value);
}
console.log(`语音包条目：${pack.size} 条（另有 ${metaCount} 条下划线说明）\n`);

/* ------------------------------------------------------------------ *
 * ① 剧本 25 轮 → 清单
 * ------------------------------------------------------------------ */

console.log("① 剧本轮次的主台词（唯一会被念出来的那句）");
const rows = [];
let missingKey = 0;
for (const round of SCRIPT_ROUNDS) {
  const mains = round.lines.filter((line) => line.role === "main");
  const main = mains[0];
  if (mains.length !== 1 || !main) {
    check(`第 ${round.roundNo} 轮恰好一句主台词`, false, `实际 ${mains.length} 句`);
    continue;
  }
  const hit = pack.get(normalize(main.text));
  rows.push({ roundNo: round.roundNo, title: round.title, text: main.text, url: hit ?? null });
  if (!hit) missingKey += 1;
}
check(
  `剧本 ${SCRIPT_ROUNDS.length} 轮、每轮一句主台词`,
  rows.length === SCRIPT_ROUNDS.length,
  `核对到 ${rows.length} 句`,
);
check(
  "每句主台词都在语音包里逐字命中",
  missingKey === 0,
  missingKey ? `缺 ${missingKey} 句：${rows.filter((r) => !r.url).map((r) => r.roundNo).join("、")}` : `${rows.length}/${rows.length} 命中`,
);
for (const row of rows.filter((item) => !item.url)) {
  note(`缺音频：第 ${row.roundNo} 轮「${row.title}」→「${row.text.slice(0, 30)}…」`);
}

/* ------------------------------------------------------------------ *
 * ② 清单 → 文件（public）
 * ------------------------------------------------------------------ */

console.log("\n② 命中路径 → public/voice 里的真文件");
let missingFile = 0;
let emptyFile = 0;
for (const row of rows) {
  if (!row.url) continue;
  const file = `${VOICE_DIR}\\${fileNameOf(row.url)}`;
  if (!existsSync(file)) {
    missingFile += 1;
    note(`第 ${row.roundNo} 轮的音频不存在：${row.url}`);
    continue;
  }
  if (statSync(file).size === 0) {
    emptyFile += 1;
    note(`第 ${row.roundNo} 轮的音频是 0 字节：${row.url}`);
  }
}
check("25 句主台词指向的音频文件都真实存在", missingFile === 0, missingFile ? `缺 ${missingFile} 个文件` : "文件齐");
check("这些音频都不是 0 字节", emptyFile === 0, emptyFile ? `${emptyFile} 个空文件` : "大小正常");

/* 断链：清单里所有值都要有文件（留死键以后改文案看不出问题） */
const dangling = [...new Set([...pack.values()])].filter((url) => !existsSync(`${VOICE_DIR}\\${fileNameOf(url)}`));
check(
  "清单里没有指向不存在文件的死键",
  dangling.length === 0,
  dangling.length ? `死键指向：${dangling.slice(0, 6).join("、")}${dangling.length > 6 ? ` …共 ${dangling.length}` : ""}` : `${new Set([...pack.values()]).size} 个不同文件全部存在`,
);

/* ------------------------------------------------------------------ *
 * ③ 一一对应：round-NN.mp3 ↔ 第 NN 轮（防张冠李戴）
 * ------------------------------------------------------------------ */

console.log("\n③ 轮次与音频文件一一对应（防「键写一句、放另一句」）");
const onDisk = readdirSync(VOICE_DIR)
  .map((name) => /^round-(\d{2})\.mp3$/.exec(name))
  .filter(Boolean)
  .map((match) => match[0])
  .sort();
const referenced = rows.map((row) => (row.url ? fileNameOf(row.url) : null));
const referencedRoundFiles = referenced.filter((name) => /^round-\d{2}\.mp3$/.test(String(name)));
check(
  `磁盘上的 round-NN.mp3 数量与剧本轮数一致（${onDisk.length} / ${SCRIPT_ROUNDS.length}）`,
  onDisk.length === SCRIPT_ROUNDS.length,
  onDisk.length === SCRIPT_ROUNDS.length ? `round-01 … round-${String(onDisk.length).padStart(2, "0")}` : `盘上：${onDisk.join("、")}`,
);
check(
  "主台词引用的是 round-NN.mp3，且没有两个轮次共用一个文件",
  referencedRoundFiles.length === rows.length && new Set(referencedRoundFiles).size === rows.length,
  `引用 ${referencedRoundFiles.length} 个，去重后 ${new Set(referencedRoundFiles).size} 个`,
);
const otherFiles = referenced.filter((name) => name && !/^round-\d{2}\.mp3$/.test(name));
if (otherFiles.length) note(`有 ${otherFiles.length} 轮的主台词引用的是命名音频：${[...new Set(otherFiles)].join("、")}`);

/* ------------------------------------------------------------------ *
 * ④ public → dist 快照（8000 服务的是 dist）
 * ------------------------------------------------------------------ */

console.log("\n④ dist/voice 快照（8000 上真正播的就是它）");
if (!existsSync(DIST_VOICE_DIR)) {
  note("dist/voice 不存在（还没 npm run build），这一组跳过 —— 只跑 dev(5173) 时不影响");
} else {
  let staleCount = 0;
  let missingInDist = 0;
  for (const row of rows) {
    if (!row.url) continue;
    const name = fileNameOf(row.url);
    const from = `${VOICE_DIR}\\${name}`;
    const to = `${DIST_VOICE_DIR}\\${name}`;
    if (!existsSync(to)) {
      missingInDist += 1;
      note(`dist 里缺 ${name}（第 ${row.roundNo} 轮）`);
      continue;
    }
    if (statSync(from).size !== statSync(to).size) {
      staleCount += 1;
      note(`${name} 快照过期：public ${statSync(from).size} 字节 / dist ${statSync(to).size} 字节 → 要 npm run build`);
    }
  }
  check("25 句主台词的音频在 dist 里都有", missingInDist === 0, missingInDist ? `缺 ${missingInDist} 个` : "齐");
  check("dist 快照与 public 字节数一致（没有改完忘了 build）", staleCount === 0, staleCount ? `${staleCount} 个过期` : "一致");
  const distManifest = `${DIST_VOICE_DIR}\\manifest.json`;
  check(
    "dist 里的 manifest.json 与 public 一致",
    existsSync(distManifest) && readFileSync(distManifest, "utf8") === readFileSync(MANIFEST, "utf8"),
    existsSync(distManifest) ? "同字节" : "dist 里没有 manifest.json",
  );
}

/* ------------------------------------------------------------------ *
 * 边界：不播报的行与不走录音的路径（说清楚，免得当成缺口）
 * ------------------------------------------------------------------ */

console.log("\n⑤ 边界（不是缺口，但要知道）");
const byRole = { host: 0, audit: 0, waiting: 0 };
for (const round of SCRIPT_ROUNDS) {
  for (const line of round.lines) {
    if (line.role !== "main") byRole[line.role] = (byRole[line.role] ?? 0) + 1;
  }
}
note(`讲解人 host ${byRole.host} 行、审核 audit ${byRole.audit} 行、等待备用 waiting ${byRole.waiting} 行：设计上不播报，因此没有也不需要有音频`);
const intentKeys = pack.size - rows.filter((row) => row.url).length;
note(`清单里另外 ${intentKeys} 条是非剧本条目（意图问答 / 唤醒应答 / 固定句 / 降级句），本次不逐条核对其覆盖面`);
note("意图问答走 composeReply 的同义模板随机挑，静态穷举不了：没命中就回退浏览器合成音，界面文案不受影响");

console.log(`\n剧本主台词覆盖：${rows.filter((row) => row.url).length}/${rows.length}${failed === 0 ? "，全部通过" : `，${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
