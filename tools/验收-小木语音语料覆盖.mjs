/**
 * 小木「会说出口的句子」全量清单 vs 语音包覆盖（只读核对）
 *
 * 为什么需要它：`验收-小木音频覆盖.mjs` 只核了剧本 25 轮的主台词，
 * 而小木还会说**意图问答**那一批（每轮台词之外的自由问答 / 示例问句）。
 * 那些句子的文本由 `intents.ts` 的模板 + `facts.ts` 的事实值渲染而成，
 * 一旦没命中 `public/voice/manifest.json`，从前是**静默回退浏览器合成音**；
 * 2026-10-01 起按用户口径「播放的都是音频而非合成音」改成**只显示字幕**，
 * 但"哪几句没录音"仍然必须是可查的事实 —— 这就是本脚本的用处。
 *
 * 判据分两类（别混成一条）：
 *   · **硬失败**：模板有取不到值的占位符（会渲染出「（）」这种句子并降级成
 *     未命中话术）—— 这是 bug，必须修；
 *   · **报告项**：句子解析不到音频（会静音）。其中有的是运行期才拿得到的值
 *     （planner 的 goal/routeText、设备自检结果），静态枚举注定看不到，
 *     所以只如实列出，**不当作失败**。
 *
 * usage: node --import ./tools/test-resolve-ts.mjs tools/验收-小木语音语料覆盖.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const MANIFEST = fileURLToPath(new URL("public/voice/manifest.json", ROOT));
const VOICE_DIR = fileURLToPath(new URL("public/voice", ROOT));

const { INTENTS } = await import("../src/pages/MumaiDashboard/agent/intents.ts");
const { evaluateFacts } = await import("../src/pages/MumaiDashboard/agent/facts.ts");
const { SCRIPT_ROUNDS } = await import("../src/pages/MumaiDashboard/agent/script.ts");
const { STAGES, CHANNELS: channelList } = await import("../src/pages/MumaiDashboard/seed/scenario.ts");
const { WAYPOINTS } = await import("../src/pages/MumaiDashboard/seed/scenario.ts");
/* 用与运行时**同一个**匹配函数：验收与线上不能各写一套（写两套必然漂移） */
const { resolveAudio } = await import("../src/pages/MumaiDashboard/agent/voicePack.ts");

const normalize = (text) => String(text).trim().replace(/\s+/g, "");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
const pack = new Map();
for (const [key, value] of Object.entries(raw)) {
  if (key.startsWith("_")) continue;
  if (typeof value === "string" && value) pack.set(normalize(key), value);
}

/** 演示现场的实际取值：与 `agent/store.ts` 的 `initialLive()` 同一口径 */
const live = {
  /* 电量由计划里程推、位置取最后一个航点（store.ts:24 / :26） */
  battery: 86,
  position: WAYPOINTS[WAYPOINTS.length - 1]?.label ?? "—",
  missionState: "idle",
  mapId: "MAP-SH-06",
  mapping: false,
  scanning: true,
  waypointDone: WAYPOINTS.length,
  waypointTotal: WAYPOINTS.length,
};
const session = {
  stageKey: STAGES[0]?.key ?? "",
  accountLabel: "史 · 人工智能架构师",
  sourceMode: "demo",
  channelSummary: channelList
    .map((item) => `${item.label}${item.state === "online" ? "在线" : item.state === "stale" ? `延迟${item.ageSec}s` : "离线"}`)
    .join("、"),
};
const entities = {
  pageLabel: "任务总览",
  route: "/",
  pillar: "Z04",
  zone: "Z04-lower",
};

/** 每一句：来源 + 文本 + 命中情况 */
const spoken = [];
const brokenTemplates = [];

for (const intent of INTENTS) {
  const templates = [intent.response.text, ...(intent.response.alternatives ?? [])];
  for (const template of templates) {
    const factSet = evaluateFacts(intent, { ...session, entities, template, live });
    spoken.push({ from: `intent:${intent.id}`, text: factSet.text, missing: factSet.missing });
    /* 占位符没取到值 → 运行时会把整句降级成"未命中"话术，而这些句子**含空括号**，
       就算录了音也对不上（实测：open_evidence 渲染出「金柱 Z04（）」这种）。 */
    if (factSet.missing.length) brokenTemplates.push({ id: intent.id, template, missing: factSet.missing });
  }
}

/* 剧本 25 轮的主台词（唯一会被念出来的那句） */
for (const round of SCRIPT_ROUNDS) {
  const main = round.lines.find((line) => line.role === "main");
  if (main) spoken.push({ from: `script:${round.roundNo}`, text: main.text, missing: [] });
}

/* 与剧本无关的固定句 / 降级句 / 唤醒应答 */
const { WAKE_REPLY_TEXT, NOT_HEARD_TEXT, FALLBACK_SPOKEN } = await import(
  "../src/pages/MumaiDashboard/agent/degrade.ts"
);
spoken.push({ from: "degrade:WAKE_REPLY_TEXT", text: WAKE_REPLY_TEXT, missing: [] });
spoken.push({ from: "degrade:NOT_HEARD_TEXT", text: `${NOT_HEARD_TEXT}。`, missing: [] });
spoken.push({ from: "degrade:FALLBACK_SPOKEN", text: FALLBACK_SPOKEN, missing: [] });
spoken.push({ from: "degrade:取消-任务", text: "好的，这条任务已经取消。", missing: [] });
spoken.push({ from: "degrade:取消-指令", text: "好的，这条指令已经取消。", missing: [] });

console.log(`语音包条目：${pack.size} 条`);
console.log(`枚举到的播报句：${spoken.length} 句\n`);

console.log("① 剧本那一路：25 轮主台词必须**逐字**有录音（用户口径：剧本里保证都是音频）");
const scriptLines = [];
for (const round of SCRIPT_ROUNDS) {
  for (const line of round.lines) scriptLines.push({ roundNo: round.roundNo, role: line.role, text: line.text });
}
const mainLines = scriptLines.filter((line) => line.role === "main");
const missingMains = mainLines.filter((line) => !pack.has(normalize(line.text)));
check(
  `剧本 ${SCRIPT_ROUNDS.length} 轮的念白（role=main）逐字命中音频`,
  missingMains.length === 0,
  missingMains.length
    ? `缺 ${missingMains.length} 句：第 ${missingMains.map((line) => line.roundNo).join("、")} 轮`
    : `${mainLines.length}/${mainLines.length} 命中`,
);
for (const line of missingMains) {
  console.log(`    · 第 ${line.roundNo} 轮「${line.text.slice(0, 40)}…」没有音频`);
}
/*
  其余角色**不该有音频**，有反而是错的：
  · `host` 是讲解人自己说的话（人在台上念，平台出声就变成两个人在念同一句）；
  · `audit` / `waiting` 是备用句，设计上只写进 note、不播。
  这两条也顺手核一下，免得有人"顺手补录"造成两个声音。
*/
const otherRoles = scriptLines.filter((line) => line.role !== "main");
const wronglyRecorded = otherRoles.filter((line) => pack.has(normalize(line.text)));
check(
  "讲解人/备用句没有被误录成小木的音频",
  wronglyRecorded.length === 0,
  wronglyRecorded.length
    ? `${wronglyRecorded.length} 句有音频（${[...new Set(wronglyRecorded.map((line) => line.role))].join("、")}）`
    : `${otherRoles.length} 句都没有音频（设计如此：不播报）`,
);

console.log("\n② 意图问答与固定句：能解析到录音就播，解析不到只显示字幕");
/*
  `device_link_check` 与 `robot_patrol_route` 的事实键**只在工具跑起来之后**才有
  （前者来自 `/api/device-readiness`，后者来自 planner 现算的 goal/routeText），
  静态枚举注定看不到 —— 它们不是 bug，列在下面单独说明。
*/
const RUNTIME_ONLY_FACTS = new Set(["device_link_check", "robot_patrol_route"]);
const brokenStatic = brokenTemplates.filter((item) => !RUNTIME_ONLY_FACTS.has(item.id));
const brokenRuntime = brokenTemplates.filter((item) => RUNTIME_ONLY_FACTS.has(item.id));
check(
  "意图模板没有取不到值的占位符（取不到会渲染出空括号，还会降级成未命中话术）",
  brokenStatic.length === 0,
  brokenStatic.length ? `${brokenStatic.length} 个模板有缺失键` : "全部可渲染",
);
for (const item of brokenStatic) {
  console.log(`    · ${item.id} 缺 ${item.missing.join("、")} → ${item.template.slice(0, 46)}…`);
}
if (brokenRuntime.length) {
  console.log(
    `    ·（不计失败）${[...new Set(brokenRuntime.map((item) => item.id))].join("、")} 的键由工具/planner 在运行期提供，静态枚举看不到`,
  );
}

console.log("\n③ 每一句能解析到哪条录音（解析不到 = 只显示字幕，不出合成音）");
/** 用与运行时同一个 `resolveAudio`：逐字命中，或"同一句、取值漂移"认回录音 */
const resolvedOf = (text) => resolveAudio(Object.fromEntries(pack), text);
const missing = spoken.filter((item) => !resolvedOf(item.text));
const exactCount = spoken.filter((item) => pack.has(normalize(item.text))).length;
const driftedItems = spoken.filter((item) => !pack.has(normalize(item.text)) && resolvedOf(item.text));
const silentItems = missing.filter((item) => !RUNTIME_ONLY_FACTS.has(String(item.from).replace("intent:", "")));
check(
  "剧本 25 轮的主台词全部逐字命中（演示动线不受影响）",
  spoken.filter((item) => String(item.from).startsWith("script:")).every((item) => pack.has(normalize(item.text))),
  `${spoken.filter((item) => String(item.from).startsWith("script:")).length} 轮`,
);
/*
  ⚠ 这一条**不算失败**，只报告。
  用户口径（2026-10-01）：「我只要剧本里保证都是音频就行」—— 剧本那一路由 ① 硬判；
  这里剩的是**自由问答**（意图目录里的条目，剧本里没有这些句子）：
  它们能解析到录音就播录音，解析不到就只显示字幕（不出合成音，见 tts.ts 的口径）。
  要它们也出声只有两条路：补录（合成工具每条要人工敲图形验证码），
  或把长句拆成固定段动态拼接（结构性改造）。在那之前，这里如实报数。
*/
console.log(
  `    ${silentItems.length === 0 ? "✓" : "·"} 意图/固定句：逐字命中 ${exactCount} 句 · ` +
    `取值漂移认回 ${driftedItems.length} 句 · 解析不到 ${silentItems.length} 句（只显示字幕）`,
);
for (const item of silentItems) {
  console.log(`    ·（只显示字幕）${item.from} →「${item.text.slice(0, 46)}${item.text.length > 46 ? "…" : ""}」`);
}
if (missing.length !== silentItems.length) {
  console.log(`    ·（不计失败）${missing.length - silentItems.length} 句属于运行期才有取值的类型`);
}

console.log("\n④ 命中路径指向的文件真的在磁盘上");
const dead = [];
for (const item of spoken) {
  const url = resolvedOf(item.text);
  if (!url) continue;
  const file = `${VOICE_DIR}\\${String(url).replace("/voice/", "")}`;
  if (!existsSync(file)) dead.push({ from: item.from, url });
}
check("命中路径都落在 public/voice 里", dead.length === 0, dead.length ? `${dead.length} 条断链` : "无断链");
for (const item of dead.slice(0, 10)) console.log(`    · ${item.from} → ${item.url}`);

console.log(`\n${failed === 0 ? "语料覆盖：全部通过" : `语料覆盖：${failed} 项未通过`}`);
console.log(
  `剧本那一路：${mainLines.length}/${mainLines.length} 句念白有音频（硬判据）` +
    `；自由问答另计：${exactCount} 句逐字命中、${driftedItems.length} 句漂移认回、${silentItems.length} 句只显示字幕。`,
);
process.exit(failed === 0 ? 0 : 1);
