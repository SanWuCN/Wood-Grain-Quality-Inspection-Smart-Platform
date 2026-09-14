/**
 * 小木形象展台 · 单文件 HTML 打包（把 vite 产物内联成一个 html）
 *
 * ── 为什么要有这一步 ────────────────────────────────────────────────
 * `vite build` 出来的仍然是 `index.html + assets/xxx.js + assets/xxx.css` 三件套 ——
 * 丢给别人的时候少一个文件就白屏。这个脚本把 js 与 css **内联进 html**，
 * 产出 `小木形象展台.html` 单个文件：拷走就能开，不需要 node_modules、不需要 5173。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node tools/打包展台.mjs
 * 产物落在 `dist-lab/小木形象展台.html`，同时复制一份到 `D:\平台\` 便于直接双击。
 *
 * ⚠ 打开方式：**用静态服务器打开**（比如产品那台 8000，或 `npx vite preview`）。
 *   直接双击走 `file://` 时，Chrome 会把 ES module 当跨源脚本拦掉 —— 那是浏览器的
 *   安全策略，不是文件坏了。文件本身是完整的、离线的（three 已经打进里面了）。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(
  "D:\\平台",
  "Wood-Grain-Quality-Inspection-Smart-Platform-RAO",
  "Wood-Grain-Quality-Inspection-Smart-Platform-RAO",
);
const OUT_DIR = resolve(REPO, "dist-lab");
const HTML_IN = resolve(OUT_DIR, "xiaomu-lab.html");
const HTML_OUT = resolve(OUT_DIR, "小木形象展台.html");
const HANDOFF_COPY = resolve("D:\\平台", "小木形象展台.html");

function log(line) {
  console.log(line);
}

/* ── 1. 跑 vite 打包（单文件配置）────────────────────────────────── */
log("① vite build（vite.lab.config.ts）…");
const build = spawnSync("npx", ["vite", "build", "--config", "vite.lab.config.ts"], {
  cwd: REPO,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) {
  console.error(`vite build 失败，exit=${build.status}`);
  process.exit(1);
}

if (!existsSync(HTML_IN)) {
  console.error(`找不到产物 ${HTML_IN}`);
  process.exit(1);
}

/* ── 2. 内联 js 与 css ───────────────────────────────────────────── */
log("② 内联 js/css…");
let html = readFileSync(HTML_IN, "utf8");
const assetsDir = resolve(OUT_DIR, "assets");
const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
let inlinedJs = 0;
let inlinedCss = 0;

// <script type="module" crossorigin src="./assets/x.js"></script>
html = html.replace(
  /<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/g,
  (match, src) => {
    const file = resolve(OUT_DIR, src.replace(/^\.\//, ""));
    if (!existsSync(file)) return match;
    const code = readFileSync(file, "utf8");
    inlinedJs += 1;
    // ⚠ 内联脚本里不能出现 `</script>`；打包产物里的字符串若含它会把 html 截断
    const safe = code.replace(/<\/script>/gi, "<\\/script>");
    /*
      类型保持 `module`：产物是 ESM（含 import.meta 等语法可能被降级），
      改成普通脚本会踩 "Cannot use import statement outside a module"。
    */
    return `<script type="module">\n${safe}\n</script>`;
  },
);

// <link rel="stylesheet" crossorigin href="./assets/x.css">
html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/g,
  (match, href) => {
    const file = resolve(OUT_DIR, href.replace(/^\.\//, ""));
    if (!existsSync(file)) return match;
    inlinedCss += 1;
    return `<style>\n${readFileSync(file, "utf8")}\n</style>`;
  },
);

html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, "");

if (inlinedJs === 0) {
  console.error("没有内联到任何 js —— 产物的 script 标签结构变了，检查 vite.lab.config.ts");
  process.exit(1);
}

writeFileSync(HTML_OUT, html, "utf8");
const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
log(`   内联 js ${inlinedJs} 个、css ${inlinedCss} 个 → ${HTML_OUT}（${kb} KB）`);

if (assets.length) {
  log(`   （assets/ 里的 ${assets.length} 个文件已不再被引用，可删；保留它们不影响单文件使用）`);
}

/* ── 3. 复制一份到 D:\平台\ 方便直接打开 ─────────────────────────── */
try {
  copyFileSync(HTML_OUT, HANDOFF_COPY);
  log(`③ 已复制一份到 ${HANDOFF_COPY}`);
} catch (err) {
  log(`③ 复制到交接目录失败（不影响产物）：${err instanceof Error ? err.message : err}`);
}

log("");
log("完成。打开方式二选一：");
log(`  · 静态服务器：把 ${HTML_OUT} 放进任一静态目录（或直接访问产品那台 8000）`);
log("  · 图省事：cd dist-lab && npx vite preview --port 5199");
log("⚠ 不要双击走 file://：Chrome 会按跨源拦掉 module 脚本。");
