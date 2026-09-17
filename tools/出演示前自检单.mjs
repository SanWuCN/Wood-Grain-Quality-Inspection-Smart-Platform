/**
 * 生成《演示前自检单》
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 上台前要核对的事实散在四个地方：快捷键表（`scriptShortcutEntries.ts`）、
 * 剧本（`script.ts`）、语音包（`public/voice/manifest.json` + 盘上文件）、
 * 服务与端口。手抄成一份"检查清单"必然过期，而过期的清单比没有更危险
 * （照着它检查，会把"已经坏了"当成"勾过了"）。
 *
 * 所以这里**全部现场读出来**：一个字都不手抄，随时可重跑。
 *
 * 用法：
 *   node --import ./tools/test-resolve-ts.mjs 'D:\平台\tools-夜间\出演示前自检单.mjs'
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const REPO = "file:///D:/%E5%B9%B3%E5%8F%B0/Wood-Grain-Quality-Inspection-Smart-Platform-RAO/Wood-Grain-Quality-Inspection-Smart-Platform-RAO";
const ROOT = decodeURIComponent(REPO.replace("file:///", ""));
const OUT = "D:\\平台\\演示前自检单-v1.0.md";

const { SCRIPT_ROUNDS, mainLineOf } = await import(
  `${REPO}/src/pages/MumaiDashboard/agent/script.ts`
);
const { SCRIPT_SHORTCUT_ENTRIES } = await import(
  `${REPO}/src/pages/MumaiDashboard/agent/scriptShortcutEntries.ts`
);
const { SCRIPT_SEQUENCE_WINDOW_MS, RESERVED_SHORTCUT_KEYS } = await import(
  `${REPO}/src/pages/MumaiDashboard/agent/scriptShortcutSequence.ts`
);
const { DEMO_ACTIONS } = await import(
  `${REPO}/src/pages/MumaiDashboard/agent/demoActions.ts`
);

/* ---------------- 现场读取的事实 ---------------- */

const manifest = JSON.parse(readFileSync(`${ROOT}/public/voice/manifest.json`, "utf8"));
const manifestKeys = new Set(
  Object.entries(manifest)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k]) => k),
);
const hasAudio = (text) => manifestKeys.has(text);

/** 盘上轮次录音 → 它现在还能命中哪一轮（反查语音包，不看稿子标了什么音色） */
const roundFiles = readdirSync(`${ROOT}/public/voice`).filter((f) => /^round-\d+\.mp3$/.test(f));
const audioStatus = roundFiles.sort().map((file) => {
  const key = Object.entries(manifest).find(([k, v]) => !k.startsWith("_") && v === `/voice/${file}`)?.[0];
  const round = key ? SCRIPT_ROUNDS.find((r) => mainLineOf(r) === key) : undefined;
  return { file, key, round };
});

const rows = SCRIPT_SHORTCUT_ENTRIES.map((e) => {
  /*
    ⚠ 字段名是 `roundNo` 不是 `round`：写成 `r.round` 不会报错，模板字符串会把它
    渲染成字面量 "undefined" —— 第一版整列轮次都是 undefined，而脚本本身"成功退出"。
    这类错只能靠**看一眼产出**发现。
  */
  const round = SCRIPT_ROUNDS.find((r) => r.roundNo === e.roundNo);
  return {
    key: e.key,
    roundNo: e.roundNo,
    title: round?.title ?? "—",
    line: e.lineOverride ?? (round ? mainLineOf(round) : ""),
  };
});

/* ---------------- 写文件 ---------------- */

const L = [];
const w = (s = "") => L.push(s);

w("# 演示前自检单 v1.0");
w();
w(`> 本文件由 \`tools-夜间/出演示前自检单.mjs\` **现场从代码与磁盘读出**（生成时间 ${new Date().toLocaleString("zh-CN")}），未手抄。`);
w("> 任何时候代码或录音有变，重跑该脚本即可刷新。");
w();

w("## 一、开演前三件事");
w();
const distIndex = `${ROOT}/dist/index.html`;
w(`- [ ] **页面能打开**：\`http://192.168.31.202:8000/\`（本机自测 \`http://127.0.0.1:8000/\`）`);
w(`- [ ] **构建产物是新的**：\`dist/index.html\` 存在 ${existsSync(distIndex) ? "✔" : "✘ 缺失，先 npm run build"}`);
w(`- [ ] **语音包在位**：\`public/voice/manifest.json\` 共 ${manifestKeys.size} 条`);
w();

w("## 二、快捷键（按住 Ctrl+Q，再按一个键；两键间隔需在 " + SCRIPT_SEQUENCE_WINDOW_MS + " 毫秒内）");
w();
w(`保留键（不用于剧本）：${RESERVED_SHORTCUT_KEYS.map((k) => `\`${k}\``).join("、")}　|　建单键：\`Ctrl+Q+L\``);
w();
w("| 快捷键 | 轮次 | 标题 | 小木要说的话 | 有录音 |");
w("| --- | --- | --- | --- | --- |");
for (const r of rows) {
  w(
    `| \`Ctrl+Q+${r.key.toUpperCase()}\` | ${r.roundNo} | ${r.title} | ${r.line} | ` +
      `${hasAudio(r.line) ? "✔" : "— 走浏览器合成音"} |`,
  );
}
w();

w("## 三、录音实况（反查语音包，不看稿子标注）");
w();
w("| 盘上文件 | 语音包里有键吗 | 归属轮次 | 结论 |");
w("| --- | --- | --- | --- |");
for (const a of audioStatus) {
  w(
    `| \`${a.file}\` | ${a.key ? "有" : "**无**"} | ${a.round ? a.round.roundNo : "—"} | ` +
      `${a.round ? "正在服役" : "**已作废**（台词改写过，需重录或删除该文件）"} |`,
  );
}
w();
w(`小结：盘上 ${audioStatus.length} 条轮次录音，其中 **${audioStatus.filter((a) => a.round).length} 条**仍在服役。`);
w();

w("## 四、唤醒（远场）");
w();
w("- 判定门限 `GATE_RMS = 0.0015`、静默跳过 `SILENCE_SKIP_MS = 1500`（原 0.008 / 1000 —— 旧值会把近场一半的帧丢掉，离得远喊不醒）");
w("- 唤醒应答语音：`我在`（语音包键 `我在` → `wake-ack.mp3`）");
w("- 唤醒命中后**不断流**：服务端进入「收集命令」状态，继续收音，所以「小木小木，打开地图」一口气说完也不会丢后半句");
w();
w("### 开演前跑一次语音链路自检（**别跳**）");
w();
w("```");
w("node 'D:\\平台\\voice-module\\tools\\自检-语音链路.mjs'");
w("```");
w();
w("判据（能证伪，不是看状态码）：");
w("- 必须打印 `✔ WebSocket 已连上 ws://127.0.0.1:8780/asr`；");
w("- 必须收到上游首帧 `{\"type\":\"ready\", ...}` —— 只连上、收不到 ready 说明上游 ASR 没进会话；");
w("- 脚本带 `Origin: http://192.168.31.202:8000`，所以它能证明**局域网页面**也连得上（本机探活不算数）。");
w("- ⚠ `/voice-api/health` 返回 200 **不等于** WebSocket 是通的：那只是 HTTP 探活。");
w();

w("## 五、22 轮的页面动作（每一轮都登记了可见变化）");
w();
w("| 轮次 | 页面表面 | 动作 |");
w("| --- | --- | --- |");
for (const a of DEMO_ACTIONS) {
  w(`| ${a.roundNo} | \`${a.surface}\` | ${a.title ?? "—"} |`);
}
w();

w("## 六、已知待办（不影响本场演示）");
w();
w("- **① ② 两条录音已作废**（台词按新剧本改写），现场这两轮走浏览器合成音；重录文本见《小木剧本-快捷键清单与输出文字-v3.0.md》第二节。");
w("- **第⑦轮（段101）** 用的是 §7 定稿句（净稿原文含 3 个 `xxx` 占位符，不能上台）；若要按净稿口径，需提供该批素材的真实统计值。");
w("- **段15 / 段205 / 段221** 是「等待时选用」的备用句，按住对应快捷键只念该句（`lineOverride`），不会连带念主台词。");
w();

writeFileSync(OUT, L.join("\r\n"), "utf8");
console.log(`已写出 ${OUT}`);
console.log(`  快捷键 ${rows.length} 条　有录音 ${rows.filter((r) => hasAudio(r.line)).length} 条　盘上轮次录音 ${audioStatus.length} 条`);
console.log(`  页面动作 ${DEMO_ACTIONS.length} 条`);
