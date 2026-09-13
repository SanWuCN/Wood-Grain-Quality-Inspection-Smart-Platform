#!/usr/bin/env node
/**
 * 木脉智检 · UI 视觉素材 v2.0 —— SVG 图标 → 受控 React 节点生成脚本
 *
 * 依据：木脉智检UI素材交接与平台部署修改PRD-v1.0 §3.1
 *   「用一次性生成脚本把已校验SVG转换为静态TSX映射。脚本处理 viewBox、path、
 *     circle、rect、line、polyline、polygon、ellipse、g 等实际出现的白名单元素；
 *     属性转为React命名。拒绝script、foreignObject、事件属性、外链和嵌入位图。
 *     未知结构报错供人工处理，不静默丢路径。不要用简单正则清洗后在运行时注入
 *     任意SVG字符串。」
 *
 * 因此这里是一个**构建期**脚本：
 *   - 解析 XML 用自带的极简解析器（只支持本素材包实际出现的结构）
 *   - 元素名 / 属性名走白名单，命中黑名单或未知结构一律**抛错退出**
 *   - 输出静态 TSX 模块（不含运行时解析器、不新增 Vite 插件）
 *   - 输出文件带来源与重新生成命令，人工改动源 SVG 后重跑本脚本
 *
 * 用法：
 *   node tools/build-ui-v2-icons.mjs
 *   node tools/build-ui-v2-icons.mjs --src <素材包目录> --out <输出文件>
 *
 * 默认 --src 为 .cache/ui-v2-src/木脉智检UI视觉素材-v2.0-20260913（gitignore 内，
 * 原素材目录只读，由维护者自行解压到该位置）。
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* ==================================================================
   1. 白名单 / 黑名单
   ================================================================== */

/** 允许出现的 SVG 元素（PRD §3.1 列举的实际出现集合） */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

/**
 * 允许保留并转成 React 属性名的几何 / 外观属性。
 * 注意：根 svg 上的 fill / stroke / stroke-width / stroke-linecap /
 * stroke-linejoin 由 Icon 组件统一提供（currentColor + 主题变量），
 * 这里刻意不收，避免生成物把颜色锁死。
 */
const ALLOWED_ATTRS = new Set([
  // 根 <svg> 上允许出现但生成时不输出（由 Icon 组件统一提供，见 ROOT_DROP）
  "viewBox",
  "aria-hidden",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "width",
  "height",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "transform",
  "id",
]);

/** PRD §3.1 明确拒绝的结构 */
const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "image",
  "use",
  "iframe",
  "style",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "mpath",
  "filter",
  "mask",
  "pattern",
  "audit",
]);

/** 事件属性 / 外链属性 / 危险协议 */
const FORBIDDEN_ATTR_RE = /^(on[a-z]+|xlink:href|href|src|action|formaction)$/i;
const FORBIDDEN_VALUE_RE = /(javascript:|data:|<\s*script|url\(\s*['"]?\s*(https?:)?\/\/)/i;

/** 素材包内图标集合 → 生成后的名字（small 变体加 -small 后缀） */
const GROUPS = [
  { dir: "icons/common", kind: "common" },
  { dir: "icons/business", kind: "business" },
  { dir: "icons/small", kind: "small" },
];

/* ==================================================================
   2. 极简 XML 解析（只支持本素材包的结构）
   ================================================================== */

/**
 * 把 SVG 文本解析成节点树。
 * 刻意不支持：CDATA、DOCTYPE 内部子集、命名空间前缀声明以外的复杂语法、
 * 自闭合以外的属性引号变体。遇到不支持的结构直接报错，不静默跳过。
 */
function parseXml(source, file) {
  let i = 0;
  const n = source.length;
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];

  const fail = (message) => {
    throw new Error(`[${file}] XML 解析失败：${message}（位置 ${i}）`);
  };

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;

    const text = source.slice(i, lt);
    if (text.trim().length > 0) {
      fail(`元素外出现非空文本内容 "${text.trim().slice(0, 40)}"`);
    }
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      if (end === -1) fail("注释未闭合");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i);
      if (end === -1) fail("处理指令未闭合");
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      fail("不支持 DOCTYPE / CDATA 等声明");
    }

    const gt = findTagEnd(source, i);
    if (gt === -1) fail("标签未闭合");
    const raw = source.slice(i + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      const top = stack.pop();
      if (!top || top.name !== name) fail(`标签不匹配 </${name}>`);
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body);
    if (!nameMatch) fail(`无法解析标签名 <${body.slice(0, 30)}>`);
    const name = nameMatch[1].toLowerCase();
    const attrs = parseAttrs(body.slice(nameMatch[1].length), file, fail);

    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    throw new Error(`[${file}] XML 解析失败：有 ${stack.length - 1} 个标签未闭合`);
  }
  return root;
}

/** 找到标签结束的 '>'，跳过属性值里的引号内容 */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(source, file, fail) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(source)) !== null) {
    const gap = source.slice(consumed, match.index);
    if (gap.trim().length > 0) {
      fail(`属性之间有无法解析的内容 "${gap.trim().slice(0, 30)}"（${file}）`);
    }
    consumed = match.index + match[0].length;
    attrs[match[1]] = match[3] !== undefined ? match[3] : match[4];
  }
  if (source.slice(consumed).trim().length > 0) {
    fail(`标签尾部有无法解析的内容 "${source.slice(consumed).trim().slice(0, 30)}"（${file}）`);
  }
  return attrs;
}

/* ==================================================================
   3. 校验 + 转换
   ================================================================== */

function camel(name) {
  return name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function validateNode(node, file) {
  if (node.name !== "#root") {
    if (FORBIDDEN_ELEMENTS.has(node.name)) {
      throw new Error(`[${file}] 出现被禁止的元素 <${node.name}>`);
    }
    if (!ALLOWED_ELEMENTS.has(node.name)) {
      throw new Error(
        `[${file}] 出现白名单外的元素 <${node.name}>，不静默丢弃：请人工确认后扩展 ALLOWED_ELEMENTS`,
      );
    }
  }

  for (const [key, value] of Object.entries(node.attrs)) {
    if (FORBIDDEN_ATTR_RE.test(key)) {
      throw new Error(`[${file}] <${node.name}> 出现被禁止的属性 ${key}`);
    }
    if (FORBIDDEN_VALUE_RE.test(value)) {
      throw new Error(`[${file}] <${node.name}> 的 ${key} 含被禁止的值（外链 / 脚本 / 内嵌位图）`);
    }
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    if (!ALLOWED_ATTRS.has(key)) {
      throw new Error(
        `[${file}] <${node.name}> 出现白名单外的属性 ${key}，不静默丢弃：请人工确认`,
      );
    }
  }

  for (const child of node.children) validateNode(child, file);
}

/** 根 <svg> 上由 Icon 组件统一提供的表现属性，生成时不重复输出 */
const ROOT_DROP = new Set([
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "aria-hidden",
]);

function serializeAttrs(node, file, isRoot) {
  const out = [];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    if (isRoot && ROOT_DROP.has(key)) continue;
    out.push(`${camel(key)}=${JSON.stringify(value)}`);
  }
  return out;
}

function serialize(node, file, isRoot = false) {
  const attrs = serializeAttrs(node, file, isRoot);
  const head = attrs.length > 0 ? `${node.name} ${attrs.join(" ")}` : node.name;

  if (node.children.length === 0) return `  <${head} />`;

  const inner = node.children.map((child) => serialize(child, file)).join("\n");
  return `  <${head}>\n${inner}\n  </${node.name}>`;
}

function convertFile(path, fileLabel) {
  const source = readFileSync(path, "utf8");
  const tree = parseXml(source, fileLabel);
  validateNode(tree, fileLabel);

  const svg = tree.children.find((child) => child.name === "svg");
  if (!svg) throw new Error(`[${fileLabel}] 找不到根 <svg>`);
  if (svg.attrs.viewBox !== "0 0 24 24") {
    throw new Error(
      `[${fileLabel}] viewBox 不是 "0 0 24 24"（实际 "${svg.attrs.viewBox}"）：Icon 组件按 24 画布渲染`,
    );
  }

  return svg.children.map((child) => serialize(child, fileLabel)).join("\n");
}

/* ==================================================================
   4. 主流程
   ================================================================== */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const srcRoot = resolve(
  argValue("--src", ".cache/ui-v2-src/木脉智检UI视觉素材-v2.0-20260913"),
);
const outFile = resolve(argValue("--out", "src/assets/ui-v2/icons/generated.tsx"));

/**
 * 图标名唯一化。
 *
 * 素材包 33 枚通用 + 11 枚业务 = 44 枚标准图标构成**公开的 name 集合**。
 * 16px 简化版不是公开名字：PRD §3.2 要求「16px 优先匹配五个 small 变体」，
 * 也就是说它们由 Icon 组件按 size 内部选用，调用方仍然写 nav-report。
 * 因此 small 组单独收集成 UI_V2_SMALL_PATHS，键为对应的标准图标名。
 */
const byName = new Map();
const smallByName = new Map();

for (const group of GROUPS) {
  const dir = join(srcRoot, group.dir);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`找不到素材目录 ${dir}，请先把 v2 素材包解压到 ${srcRoot}`);
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".svg")) continue;
    if (entry.startsWith("._") || entry.startsWith(".")) continue; // macOS 资源分支
    const name = entry.replace(/\.svg$/, "");
    const source = `${group.dir}/${entry}`;
    const body = convertFile(join(dir, entry), source);

    if (group.kind === "small") {
      // nav-report-small.svg → nav-report；action-expand-small → action-expand
      const standard = name.endsWith("-small") ? name.slice(0, -"-small".length) : name;
      if (smallByName.has(standard)) {
        throw new Error(`16px 简化版重复映射到同一个标准图标名 "${standard}"`);
      }
      smallByName.set(standard, { standard, source, body });
      continue;
    }

    if (byName.has(name)) {
      throw new Error(`图标名冲突："${name}" 同时出现在 ${byName.get(name).source} 与 ${source}`);
    }
    byName.set(name, { name, body, source, kind: group.kind });
  }
}

const icons = [...byName.values()];

/* 每个 small 变体都必须能对上一个标准图标，否则是素材包改名而脚本没跟上 */
for (const variant of smallByName.values()) {
  if (!byName.has(variant.standard)) {
    throw new Error(
      `16px 简化版 ${variant.source} 找不到对应的标准图标 "${variant.standard}"，` +
        `请人工确认标准图标名后更新脚本`,
    );
  }
}

if (icons.length === 0) throw new Error("没有解析到任何 SVG 图标");

const byGroup = (prefix) => icons.filter((icon) => icon.source.startsWith(prefix)).length;

const iconMap = icons
  .map((icon) => `  ${JSON.stringify(icon.name)}: (\n    <>\n${icon.body}\n    </>\n  ),`)
  .join("\n");

const smallEntries = [...smallByName.values()];
const smallMap = smallEntries
  .map(
    (item) =>
      `  ${JSON.stringify(item.standard)}: (\n    <>\n${item.body}\n    </>\n  ),`,
  )
  .join("\n");

const header = `/**
 * 本文件由脚本生成，请勿手工编辑。
 *
 * 来源：木脉智检 UI 视觉素材 v2.0（2026-09-13）
 *   icons/common   ${byGroup("icons/common")} 枚通用图标  → UI_V2_ICON_PATHS
 *   icons/business ${byGroup("icons/business")} 枚业务图标  → UI_V2_ICON_PATHS
 *   icons/small    ${smallEntries.length} 枚 16px 简化版    → UI_V2_SMALL_PATHS
 *
 * 公开图标名共 ${icons.length} 枚。16px 简化版**不占独立名字**：按 PRD §3.2，
 * 它们由 Icon 组件在 size=16 时自动选用，调用方仍写 nav-report 这类标准名。
 *
 * 重新生成：
 *   node tools/build-ui-v2-icons.mjs
 *
 * 生成规则（PRD §3.1）：只处理 path / circle / ellipse / rect / line / polyline /
 * polygon / g；属性转 React 命名；script、foreignObject、事件属性、外链、内嵌位图
 * 一律拒绝；白名单外的元素或属性直接报错，不静默丢路径。
 * 颜色不写死：描边与填充继承 currentColor，由 Icon 组件按 tone 提供。
 */

import type { ReactNode } from "react";

/** 素材包内的图标标识（通用图标与业务图标，等于 SVG 文件名去掉扩展名） */
export type UiV2IconName =
${icons.map((icon) => `  | ${JSON.stringify(icon.name)}`).join("\n")};

export const UI_V2_ICON_NAMES: readonly UiV2IconName[] = [
${icons.map((icon) => `  ${JSON.stringify(icon.name)},`).join("\n")}
];

/** 素材包文件 → 来源路径（供清单核对与验收追溯） */
export const UI_V2_ICON_SOURCE: Readonly<Record<UiV2IconName, string>> = {
${icons.map((icon) => `  ${JSON.stringify(icon.name)}: ${JSON.stringify(icon.source)},`).join("\n")}
};

/**
 * 16px 专用简化版（PRD §3.2 点名的五枚）。
 *
 * 键是它服务的**标准图标名**，值是素材包里对应的简化版文件：
${smallEntries.map((item) => ` *   ${item.standard} ← ${item.source}`).join("\n")}
 *
 * 其余图标名在 size=16 时回退到标准版，不显示空白（PRD §3.2）。
 */
export const UI_V2_SMALL_SOURCE: Readonly<Record<string, string>> = {
${smallEntries.map((item) => `  ${JSON.stringify(item.standard)}: ${JSON.stringify(item.source)},`).join("\n")}
};

export const UI_V2_SMALL_PATHS: Readonly<Record<string, ReactNode>> = {
${smallMap}
};

export const UI_V2_ICON_PATHS: Readonly<Record<UiV2IconName, ReactNode>> = {
${iconMap}
};
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, header, "utf8");

console.log(`已生成 ${outFile}`);
console.log(`  通用图标 ${byGroup("icons/common")} 枚（素材包 33）`);
console.log(`  业务图标 ${byGroup("icons/business")} 枚（素材包 11）`);
console.log(`  公开图标名 ${icons.length} 枚`);
console.log(`  16px 简化版 ${smallEntries.length} 枚（素材包 5，按 size 内部选用）`);
console.log(
  `  简化版映射：${smallEntries.map((item) => `${item.standard} ← ${item.source.split("/").pop()}`).join("，")}`,
);
