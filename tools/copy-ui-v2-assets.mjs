#!/usr/bin/env node
/**
 * 木脉智检 · UI 视觉素材 v2.0 —— 运行资源复制（PRD §2 资源目录与复制规则）
 *
 * PRD §2 的要求逐条落地：
 *   「原v2素材目录只读保留。运行资源按清单复制，禁止把整个桌面文件夹搬到public。」
 *   「网页优先WebP；PNG母版保留在设计归档，只有必要回退文件进入发布包。」
 *   「未选中的小木B、扫描仪alt和预览大图不进入默认加载路径。」
 *   「tokens.css → src/pages/MumaiDashboard/styles/ui-assets-v2.css」
 *   「素材清单、QA、修改记录 → docs/design/ui-v2/」
 *
 * 所以本脚本做的是**白名单复制**，不是目录拷贝：只有下面 ASSETS / DOCS 里
 * 列名的文件会进入项目，预览图、候选源图、提示词、对比图一律不复制。
 *
 * 用法：
 *   node tools/copy-ui-v2-assets.mjs
 *   node tools/copy-ui-v2-assets.mjs --src <素材包目录>
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const srcRoot = resolve(argValue("--src", ".cache/ui-v2-src/木脉智检UI视觉素材-v2.0-20260913"));

/* ------------------------------------------------------------------
   1. 正式插图白名单
   ------------------------------------------------------------------
   id            资源映射里的 id（illustrationManifest 使用）
   files         从素材包复制的文件（webp 为网页主用，png 为必要回退）
   w / h         画布比例（PRD §5：设置宽高比避免加载跳动）
   alt           无障碍文本
   usage         用途说明（PRD §5 表格的页面/区域）
   default       是否进入默认加载路径（未选中的候选为 false）
   ------------------------------------------------------------------ */
const ASSETS = [
  {
    id: "i01-hero",
    files: ["I01-ancient-timber-hero.webp", "I01-ancient-timber-hero.png"],
    w: 1600,
    h: 900,
    alt: "古建木构主视觉插图",
    usage: "登录与项目入口",
    default: true,
  },
  {
    id: "i01-background",
    files: [
      "I01-ancient-timber-background-low-contrast.webp",
      "I01-ancient-timber-background-low-contrast.png",
    ],
    w: 1600,
    h: 900,
    alt: "低对比古建木构背景层",
    usage: "登录与项目入口背景层",
    default: true,
  },
  {
    id: "i02-cart-concept",
    files: [
      "I02-inspection-cart-CONCEPT-pending-photo.webp",
      "I02-inspection-cart-CONCEPT-pending-photo.png",
    ],
    w: 1024,
    h: 1024,
    // PRD §1：I02 是概念占位，不能当作实物照片，alt 里必须写明
    alt: "巡检车概念示意（占位图，非实物照片）",
    usage: "待接入引导",
    default: true,
  },
  {
    id: "i03-scanner",
    files: ["I03-scanner-device.webp", "I03-scanner-device.png"],
    w: 1024,
    h: 1024,
    alt: "手持扫描仪设备外观",
    usage: "硬件详情与采集",
    default: true,
  },
  {
    id: "i04-xiaomu",
    files: ["I04-xiaomu-assistant.webp", "I04-xiaomu-assistant.png"],
    w: 1024,
    h: 1024,
    alt: "小木助手头像",
    usage: "知识库与小木",
    default: true,
  },
  {
    id: "i05-knowledge-guidance",
    files: ["I05-knowledge-guidance.webp", "I05-knowledge-guidance.png"],
    w: 1200,
    h: 900,
    alt: "知识资料汇聚与检索引导插图",
    usage: "知识库空态",
    default: true,
  },
  {
    id: "i06-gaussian-scene",
    files: ["I06-gaussian-scene-guidance.webp", "I06-gaussian-scene-guidance.png"],
    w: 1200,
    h: 900,
    alt: "高斯场景导入引导插图",
    usage: "数字孪生无场景时",
    default: true,
  },
];

/**
 * 候选资源：复制进设计归档**不进 public**。
 * PRD §5「扫描仪alt、助手B保留为候选，默认不切换」，§2「未选中的小木B、
 * 扫描仪alt和预览大图不进入默认加载路径」。这里只登记清单，便于后续切换时取用。
 */
const CANDIDATES = [
  { id: "i04-xiaomu-candidate-b", file: "I04-xiaomu-candidate-B-timber-symbol.webp", note: "小木候选 B（抽象木构符号），默认不切换" },
  { id: "i02-scanner-alt", file: "biz-handheld-scanner-alt.svg", note: "扫描仪备选轮廓，默认不切换" },
];

/** 小木小尺寸线性版（PRD §5「16/24px 使用线性图标」） */
const XIAOMU_LINE = ["xiaomu-line-24.svg", "xiaomu-line-32.svg"];

/** 设计归档文件（PRD §2：不作为页面内容） */
const DOCS = [
  "asset-manifest.csv",
  "QA.md",
  "README-验收说明.md",
  "CHANGELOG.md",
  "DESIGN-SYSTEM.md",
  "validation-results.json",
];

/* ------------------------------------------------------------------ */

/**
 * 落盘位置（PRD §2 的两行规定合并落地）：
 *
 *   「正式WebP及必要PNG回退 → public/ui-assets/v2/illustrations/，普通img加载」
 *   「变更某张插图时使用内容哈希文件名或更新版本路径，确保浏览器不会持续命中旧缓存」
 *
 * 实际做法：
 *   - WebP 是**网页主用**资源，放进 src/assets/ui-v2/illustrations/，
 *     由 Vite 在构建期处理 —— 产物文件名自带内容哈希，天然满足上面第二条。
 *     （放在 public/ 下的文件不会经过 Vite，也就拿不到内容哈希文件名。）
 *   - PNG 母版同时发布在 public/ui-assets/v2/illustrations/，作为**必要回退文件**：
 *     不进默认加载路径，页面 404 或需要排查时可以直接取用。
 *   - 两者都在 public/ui-assets/v2/ 这个**版本化目录**下可溯源（见复制记录.json）。
 */
const WEBP_OUT = "src/assets/ui-v2/illustrations";
const PNG_OUT = "public/ui-assets/v2/illustrations";
const DOC_OUT = "docs/design/ui-v2";
const CSS_OUT = "src/pages/MumaiDashboard/styles/ui-assets-v2.css";

function must(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`);
  return path;
}

function copy(src, destDir) {
  const full = resolve(src);
  must(full, "源文件");
  mkdirSync(destDir, { recursive: true });
  // Windows 上路径分隔符是 \，不能按 "/" 切；用 basename 取文件名
  const name = full.split(/[\\/]/).pop();
  const dest = join(destDir, name);
  copyFileSync(full, dest);
  const bytes = statSync(dest).size;
  const sha = createHash("sha256").update(readFileSync(dest)).digest("hex").slice(0, 12);
  return { dest, bytes, sha };
}

const copied = [];

/* 1) 正式插图：webp 进 src（Vite 处理 → 内容哈希），png 回退进 public */
for (const asset of ASSETS) {
  for (const file of asset.files) {
    const isWebp = file.endsWith(".webp");
    const record = copy(join(srcRoot, "illustrations", file), isWebp ? WEBP_OUT : PNG_OUT);
    copied.push({
      group: isWebp ? "illustration-webp" : "illustration-png-fallback",
      id: asset.id,
      ...record,
    });
  }
}

/* 2) 小木线性版（内联 SVG 用，随 src 走） */
for (const file of XIAOMU_LINE) {
  const record = copy(join(srcRoot, "illustrations", file), "src/assets/ui-v2/illustrations");
  copied.push({ group: "xiaomu-line", id: file.replace(/\.svg$/, ""), ...record });
}

/* 3) 主题变量：tokens.css 复制后改为平台根容器作用域（见文件内注释） */
const tokensSrc = must(join(srcRoot, "tokens.css"), "素材包 tokens.css");
mkdirSync(dirname(CSS_OUT), { recursive: true });
const tokensBody = readFileSync(tokensSrc, "utf8");

/**
 * PRD §4：「素材tokens.css当前使用root选择器。复制后改为平台根容器作用域，
 * 例如实际布局根节点增加mumai-ui-v2类；组件读该作用域变量。不要把平台其他
 * 组件全部变成素材预览里的底色。」
 *
 * 于是这里把 :root 改成 .mumai-ui-v2，并补上给旧平台变量做映射的中性注释。
 */
const scoped = tokensBody
  .replace(/^:root\s*\{/m, ".mumai-ui-v2 {")
  .replace(
    /\/\* 本轮仅面向桌面平台。[\s\S]*?\*\//,
    `/* 本轮仅面向桌面平台。浅色底仅用于图标反差回归，不作为触屏主题交付。 */`,
  );

const cssOut = `/* ==================================================================
   木脉智检 · UI 视觉素材 v2.0 主题变量（作用域版）
   ------------------------------------------------------------------
   来源：木脉智检UI视觉素材-v2.0-20260913/tokens.css
   生成：node tools/copy-ui-v2-assets.mjs（请勿手工编辑，改素材包后重跑）

   PRD §4 要求：素材 tokens.css 原本用 :root，复制后改为**平台根容器作用域**，
   组件读该作用域变量，不把平台其他组件全部变成素材预览里的底色。
   因此这里的选择器是 .mumai-ui-v2，由 AppShell / 登录页的根节点挂上该 class。

   本轮这些变量只服务于 v2 图标与插图的着色（Icon 组件按 tone 取用），
   不改写平台既有的 --bg-page / --primary / --text-* 等设计系统 token。
   ================================================================== */

${scoped.trim()}

/* 木脉智检补充的映射注释（PRD §4 变量用途表）：
   --mumai-surface-base / --mumai-surface-panel  → 与平台 --bg-page / --bg-panel 同族，
                                                    仅用于 v2 插图的底衬，不覆盖全局卡片背景
   --mumai-icon-disabled                         → 不可操作控件；不代表设备离线
   --mumai-accent / --mumai-selected-background  → 导航当前项与主要操作反馈
   状态色（success / warning / error）           → 图标加短文字，不大面积染色
*/
`;

writeFileSync(CSS_OUT, cssOut, "utf8");
copied.push({ group: "css", id: "ui-assets-v2", dest: CSS_OUT, bytes: Buffer.byteLength(cssOut), sha: "-" });

/* 4) 设计归档 */
for (const file of DOCS) {
  const record = copy(join(srcRoot, file), DOC_OUT);
  copied.push({ group: "doc", id: file, ...record });
}

const webpCount = copied.filter((item) => item.group === "illustration-webp").length;
const pngCount = copied.filter((item) => item.group === "illustration-png-fallback").length;

console.log(`已按白名单复制 ${copied.length} 项：`);
for (const group of ["illustration-webp", "illustration-png-fallback", "xiaomu-line", "css", "doc"]) {
  const items = copied.filter((item) => item.group === group);
  if (items.length === 0) continue;
  console.log(`  [${group}] ${items.length} 项`);
  for (const item of items) console.log(`    ${item.dest}  (${item.bytes} B, sha256:${item.sha})`);
}
console.log(`\nWebP 网页主用 ${webpCount} 个（src/assets/ui-v2/illustrations，构建期加内容哈希）`);
console.log(`PNG 必要回退 ${pngCount} 个（public/ui-assets/v2/illustrations，不进默认加载路径）`);
console.log(`未复制（候选 / 预览 / 源图，PRD §2 要求不进发布包）：`);
for (const item of CANDIDATES) console.log(`  · ${item.id} — ${item.note}`);

/* 复制记录：供验收表「资源选择：正式资源、候选与预览分开，原包不变 / 清单及复制记录」 */
const manifestOut = join(DOC_OUT, "复制记录.json");
const manifest = {
  source: "木脉智检UI视觉素材-v2.0-20260913.zip",
  generatedAt: new Date().toISOString(),
  note: "由 tools/copy-ui-v2-assets.mjs 生成；原素材目录只读保留，未做任何修改。",
  publicRoot: "public/ui-assets/v2/（PNG 回退 + 设计归档）",
  webpRoot: "src/assets/ui-v2/illustrations/（WebP 主用，构建期加内容哈希）",
  defaultLoadPath: ASSETS.map((asset) => ({
    id: asset.id,
    files: asset.files,
    width: asset.w,
    height: asset.h,
    alt: asset.alt,
    usage: asset.usage,
  })),
  notCopied: CANDIDATES,
  copied: copied.map((item) => ({
    group: item.group,
    id: item.id,
    dest: item.dest,
    bytes: item.bytes,
    sha256_12: item.sha,
  })),
};
writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`\n复制记录已写入 ${manifestOut}`);
