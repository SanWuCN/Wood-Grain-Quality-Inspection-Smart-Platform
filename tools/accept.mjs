/**
 * accept.mjs —— 全平台验收脚本
 *
 * 对每个路由做三件事：
 *   1. 无头截图（1920×1080，可切档）
 *   2. 跑设计规范 §12 的量化探针（字号层级 / 有色边框 / 颜色数量）
 *   3. 收集 console error 与未捕获异常
 *
 * 用法：
 *   node tools/accept.mjs                     # 全部路由，1920×1080
 *   node tools/accept.mjs --w 1280 --h 720    # 换档
 *   node tools/accept.mjs --routes /,/orders  # 只跑指定路由
 *
 * 退出码：有任何 console error / 异常 → 1，否则 0。
 * 本项目是 hash 路由，脚本内部会把 `/orders` 拼成 `#/orders`。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 路由表必须与 `src/pages/MumaiDashboard/routes.tsx` 一一对应。
 *
 * 原来这里还留着 `/adapt` 与 `/console` —— 「检测适配」拆成「硬件详情 / 固件及模型」
 * 时路由改了，脚本没跟着改，于是验收长期在跑两个已经不存在的路由：
 * 它们落到 404 空白页，探针读到「字号 0、有色边框 0%」照样判通过，
 * 而真正要验的 `/hardware`、`/firmware` 一次都没被覆盖过。
 * 改路由时请同步改这里。
 */
const ALL_ROUTES = [
  ["/", "任务总览"],
  ["/orders", "工单档案"],
  ["/mapping", "建图巡检"],
  ["/twin", "数字孪生"],
  ["/hardware", "硬件详情"],
  ["/firmware", "固件及模型"],
  ["/knowledge", "知识库"],
  ["/archive", "报告归档"],
  ["/present", "演示窗口"],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const width = arg("w", "1920");
const height = arg("h", "1080");
const only = arg("routes", "");
const wait = arg("wait", "8000");
const base = arg("base", "http://localhost:5173");
const routes = only
  ? ALL_ROUTES.filter(([path]) => only.split(",").includes(path))
  : ALL_ROUTES;

/**
 * 会话注入：**必须的**，和文档里 `tools/shot.mjs` 的用法同一个道理。
 *
 * `RequireLogin` 会把没有会话的访问送去 `#/login`，而登录页本身「有文字、
 * 有边框、console 干净」—— 探针照样读出「字号 4、有色边框 100%」，
 * 于是一整轮验收全部在给登录页打分，9 个业务路由一个都没真正打开过。
 * 这里默认用 `shi`（权限最全），需要换角色时用 `--init` 覆盖。
 */
const init =
  arg("init", "") ||
  "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shi',login:'shi'}))";

const outDir = resolve("tmp-shot", `accept-${width}`);
mkdirSync(outDir, { recursive: true });

const results = [];
let failed = 0;

for (const [path, label] of routes) {
  const url = `${base}/#${path}`;
  const out = resolve(outDir, `${path === "/" ? "overview" : path.slice(1)}.png`);
  const run = spawnSync(
    process.execPath,
    [
      resolve("tools/shot.mjs"),
      "--audit",
      "--url",
      url,
      "--out",
      out,
      "--wait",
      wait,
      "--w",
      width,
      "--h",
      height,
      "--init",
      init,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const pick = (re) => (text.match(re) ?? [])[1]?.trim() ?? "-";
  const errors = (text.match(/^\[(exception|console\.error|log)\].*$/gm) ?? []).filter(
    (line) => !/THREE\.Clock|deprecated/i.test(line),
  );

  const row = {
    path,
    label,
    fontSizes: pick(/fontSizes=(\d+)/),
    sizeList: pick(/fontSizes=\d+ -> ([^\n]+)/),
    borders: pick(/bordered=(\d+)/),
    coloredBorders: pick(/coloredBorder=(\d+) \((\d+)%\)/),
    coloredPct: pick(/coloredBorder=\d+ \(\d+\) \((\d+)%\)/),
    textColors: pick(/textColors=(\d+)/),
    bgColors: pick(/bgColors=(\d+)/),
    borderColors: pick(/borderColors=(\d+)/),
    errors: errors.length,
    /** 出错的原文：只报「错误 1」的话，看报告的人还得自己重跑一遍才知道是什么 */
    errorTexts: errors.slice(0, 3).map((line) => line.replace(/\s+/g, " ").slice(0, 220)),
    panels: (text.match(/tech-panel[^\n]*/g) ?? []).map((line) =>
      line.replace("tech-panel ", ""),
    ),
    overflow: pick(/overflow=(\w+)/),
    hash: pick(/hash:\s*(\S*)/),
  };
  // 「有色边框占比」用第二组正则再取一次，避免上面那条贪婪失败
  const m = text.match(/coloredBorder=(\d+) \((\d+)%\)/);
  if (m) {
    row.coloredBorders = m[1];
    row.coloredPct = m[2];
  }
  /**
   * 会话没生效的硬信号：最终停在 `#/login`。
   * 不把这条判成失败的话，整轮验收会「全部通过」而实际一张业务页都没打开
   * （登录页同样有字号层级和边框，探针读数看起来完全正常）。
   */
  row.landedOnLogin = row.hash.includes("/login");
  if (row.landedOnLogin) failed++;
  if (row.errors > 0) failed++;
  results.push(row);
  process.stdout.write(
    `${row.errors || row.landedOnLogin ? "✗" : "✓"} ${path.padEnd(11)} 字号${row.fontSizes} 有色边框${row.coloredPct}% 文字色${row.textColors} 背景色${row.bgColors} 边框色${row.borderColors}${row.errors ? ` 错误${row.errors}` : ""}${row.landedOnLogin ? " 落到登录页(会话未注入)" : ""}\n`,
  );
}

const lines = [
  `# 验收结果 ${width}×${height}`,
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| 路由 | 页面 | 最终 hash | 字号层级 | 字号集合 | 有色边框占比 | 文字色 | 背景色 | 边框色 | console error |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| \`${r.path}\` | ${r.label} | \`${r.hash}\` | ${r.fontSizes} | ${r.sizeList} | ${r.coloredPct}% | ${r.textColors} | ${r.bgColors} | ${r.borderColors} | ${r.errors} |`,
  ),
  "",
  "## 规范目标",
  "",
  "- 字号层级 ≤ 5",
  "- 有色边框占比明显下降（且边框总数下降）",
  "- 文字色 ≤ 6 / 背景色 ≤ 8 / 边框色 ≤ 3",
  "- console error = 0",
  "- 最终 hash 不得是 `#/login`（否则说明会话没注入，整轮截的都是登录页）",
  "",
  "## 面板几何（检查有无重叠 / 溢出）",
  "",
  ...results.flatMap((r) => [
    `### \`${r.path}\``,
    ...(r.panels.length ? r.panels.map((p) => `- ${p}`) : ["- （无浮层面板）"]),
    "",
  ]),
  // 出错原文单独一段：报告里只有「错误 1」没法定位，得让人一眼看到是什么
  ...(results.some((r) => r.errorTexts.length)
    ? [
        "## console error 原文",
        "",
        ...results
          .filter((r) => r.errorTexts.length)
          .flatMap((r) => [`### \`${r.path}\``, ...r.errorTexts.map((t) => `- ${t}`), ""]),
      ]
    : []),
];

writeFileSync(resolve(outDir, "report.md"), lines.join("\n"), "utf8");
console.log(`\n报告：tmp-shot/accept-${width}/report.md`);
if (failed) {
  const onLogin = results.filter((r) => r.landedOnLogin).map((r) => r.path);
  if (onLogin.length) {
    console.log(`✗ 有路由落到了登录页（会话未注入）：${onLogin.join("、")}`);
  }
  console.log(`✗ ${failed} 个路由未通过（console error 或未登录）`);
} else {
  console.log("✓ 所有路由 console 干净");
}
process.exit(failed ? 1 : 0);
