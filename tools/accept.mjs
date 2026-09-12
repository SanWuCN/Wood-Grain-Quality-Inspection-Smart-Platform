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

const ALL_ROUTES = [
  ["/", "任务总览"],
  ["/orders", "工单档案"],
  ["/mapping", "建图巡检"],
  ["/twin", "数字孪生"],
  ["/adapt", "检测适配"],
  ["/knowledge", "知识库"],
  ["/archive", "报告归档"],
  ["/console", "演示控制"],
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
const base = arg("base", "http://localhost:5199");
const routes = only
  ? ALL_ROUTES.filter(([path]) => only.split(",").includes(path))
  : ALL_ROUTES;

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
    panels: (text.match(/tech-panel[^\n]*/g) ?? []).map((line) =>
      line.replace("tech-panel ", ""),
    ),
    overflow: pick(/overflow=(\w+)/),
  };
  // 「有色边框占比」用第二组正则再取一次，避免上面那条贪婪失败
  const m = text.match(/coloredBorder=(\d+) \((\d+)%\)/);
  if (m) {
    row.coloredBorders = m[1];
    row.coloredPct = m[2];
  }
  if (row.errors > 0) failed++;
  results.push(row);
  process.stdout.write(
    `${row.errors ? "✗" : "✓"} ${path.padEnd(11)} 字号${row.fontSizes} 有色边框${row.coloredPct}% 文字色${row.textColors} 背景色${row.bgColors} 边框色${row.borderColors}${row.errors ? ` 错误${row.errors}` : ""}\n`,
  );
}

const lines = [
  `# 验收结果 ${width}×${height}`,
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| 路由 | 页面 | 字号层级 | 字号集合 | 有色边框占比 | 文字色 | 背景色 | 边框色 | console error |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| \`${r.path}\` | ${r.label} | ${r.fontSizes} | ${r.sizeList} | ${r.coloredPct}% | ${r.textColors} | ${r.bgColors} | ${r.borderColors} | ${r.errors} |`,
  ),
  "",
  "## 规范目标",
  "",
  "- 字号层级 ≤ 5",
  "- 有色边框占比明显下降（且边框总数下降）",
  "- 文字色 ≤ 6 / 背景色 ≤ 8 / 边框色 ≤ 3",
  "- console error = 0",
  "",
  "## 面板几何（检查有无重叠 / 溢出）",
  "",
  ...results.flatMap((r) => [
    `### \`${r.path}\``,
    ...(r.panels.length ? r.panels.map((p) => `- ${p}`) : ["- （无浮层面板）"]),
    "",
  ]),
];

writeFileSync(resolve(outDir, "report.md"), lines.join("\n"), "utf8");
console.log(`\n报告：tmp-shot/accept-${width}/report.md`);
console.log(failed ? `✗ ${failed} 个路由存在 console error` : "✓ 所有路由 console 干净");
process.exit(failed ? 1 : 0);
