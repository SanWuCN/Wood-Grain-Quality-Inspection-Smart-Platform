#!/usr/bin/env node
/**
 * 木脉智检 · UI 素材 v2.0 图标数据静态核对（构建期，不依赖浏览器）
 *
 * 对照 PRD §8 验收表的「资源选择 / 名称兼容 / 小尺寸」三行，逐项核对生成数据：
 *   1. 公开图标名与素材包数量一致（33 通用 + 11 业务 = 44）
 *   2. 16px 简化版正好五枚，且键必须是对应的**标准图标名**
 *   3. 同名标准版与简化版的几何必须不同（否则「16px 优先 small」等于没生效）
 *   4. 简化版节点数不超过标准版（简化方向，而不是更复杂）
 *   5. 每个 small 变体文件在素材包里真实存在
 *   6. 旧名别名与保留旧名都能在组件里解析（不出现未知映射）
 *
 * 用法：node tools/check-ui-v2-icons.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const GENERATED = "src/assets/ui-v2/icons/generated.tsx";
const ICONS_COMPONENT = "src/pages/MumaiDashboard/icons.tsx";
const ASSET_ROOT = ".cache/ui-v2-src/木脉智检UI视觉素材-v2.0-20260913";

const failures = [];
const notes = [];
const check = (name, ok, detail) => {
  (ok ? notes : failures).push({ name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${detail}`);
};

const source = readFileSync(GENERATED, "utf8");

/** 取某个常量对象字面量的完整文本（按花括号配平） */
function extractObject(text, constName) {
  // 必须匹配「const X = {」这种真正的定义行：
  // 文件头的注释里也会提到这些名字，indexOf 会先命中注释，取到错的片段。
  // 同时允许 export 前缀（生成文件里的几个表是导出的，组件内的不是）。
  const pattern = new RegExp(`(?:export\\s+)?const ${constName}\\b\\s*(?::[^=]*)?=`);
  const match = pattern.exec(text);
  if (!match) return null;
  const braceStart = text.indexOf("{", match.index + match[0].length - 1);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

/** 取某个键对应的 JSX 片段（按圆括号配平） */
function geometryOf(body, key) {
  const at = body.indexOf(`"${key}":`);
  if (at < 0) return null;
  const open = body.indexOf("(", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "(") depth += 1;
    else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return null;
}

/* ---------- 1. 公开图标名数量 ---------- */
const nameLines = source.split("\n").filter((line) => line.trim().startsWith('| "'));
check("公开图标名 44 枚", nameLines.length === 44, `${nameLines.length} 枚（素材包 33 + 11）`);

/* ---------- 2. 16px 简化版五枚 ---------- */
const standard = extractObject(source, "UI_V2_ICON_PATHS");
const small = extractObject(source, "UI_V2_SMALL_PATHS");
check("标准版与简化版图形表都存在", Boolean(standard && small), standard && small ? "已生成" : "缺失");

const EXPECTED_SMALL = [
  "action-expand",
  "nav-report",
  "biz-sample-group",
  "biz-multimodal",
  "biz-material-adapt",
];
const smallKeys = small
  ? [...small.matchAll(/^\s*"([a-z0-9-]+)":\s*\(/gm)].map((m) => m[1])
  : [];
check(
  "16px 简化版正好五枚且是标准图标名",
  smallKeys.length === 5 && EXPECTED_SMALL.every((name) => smallKeys.includes(name)),
  smallKeys.join(" / ") || "(未登记)",
);

/* ---------- 3/4. 几何必须不同，且方向是「更简」 ---------- */
const identical = [];
const notSimpler = [];
for (const name of EXPECTED_SMALL) {
  const a = geometryOf(small ?? "", name);
  const b = geometryOf(standard ?? "", name);
  if (!a || !b) {
    identical.push(`${name}(缺)`);
    continue;
  }
  const shape = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (shape(a) === shape(b)) identical.push(name);
  const nodeCount = (text) => (text.match(/jsxDEV\(/g) ?? []).length || (text.match(/<(path|rect|circle|line|polyline|polygon|ellipse)/g) ?? []).length;
  if (nodeCount(a) > nodeCount(b)) notSimpler.push(name);
}
check("16px 几何与标准版不同", identical.length === 0, identical.length ? `相同/缺失：${identical.join(" ")}` : "五枚都与标准版不同");
check("简化版节点数不超过标准版", notSimpler.length === 0, notSimpler.length ? `更复杂：${notSimpler.join(" ")}` : "五枚都是精简方向");

/* ---------- 5. 素材包里对应的简化版文件必须真实存在 ---------- */
if (existsSync(ASSET_ROOT)) {
  const missingFiles = EXPECTED_SMALL.filter(
    (name) => !existsSync(resolve(ASSET_ROOT, "icons/small", `${name}-small.svg`)),
  );
  check(
    "简化版源文件在素材包中存在",
    missingFiles.length === 0,
    missingFiles.length ? `缺 ${missingFiles.join(" ")}` : "五枚 -small.svg 均可查",
  );
} else {
  console.log(`SKIP  简化版源文件核对  —  素材包未解压到 ${ASSET_ROOT}`);
}

/* ---------- 6. 组件里的 name 全部可解析（无未知映射） ---------- */
const component = readFileSync(ICONS_COMPONENT, "utf8");
const aliasKeys = [...component.matchAll(/^\s{2}([a-z][a-z0-9]*):\s*"[a-z0-9-]+",\s*$/gm)].map((m) => m[1]);
const aliasValues = [...component.matchAll(/^\s{2}[a-z][a-z0-9]*:\s*"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
const knownNames = nameLines.map((line) => line.replace(/^\s*\|\s*"/, "").replace(/",?$/, ""));
const unresolvedAliases = aliasValues.filter((value) => !knownNames.includes(value));
check(
  "别名目标都是已知 v2 图标",
  unresolvedAliases.length === 0,
  unresolvedAliases.length ? `未解析：${unresolvedAliases.join(" ")}` : `${aliasKeys.length} 个别名都指向有效名称`,
);

/* ---------- 保留的旧名必须有图形，不能落到中性占位 ---------- */
const legacyArrayMatch = /const LEGACY_NAMES = \[([\s\S]*?)\] as const;/.exec(component);
const legacyNames = legacyArrayMatch
  ? [...legacyArrayMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
  : [];
const legacyBlock = extractObject(component, "LEGACY_PATHS");
const legacyWithShape = legacyBlock
  ? // 两种写法都要认：多行 `name: (\n …\n)` 与单行 `name: <path … />`
    [...legacyBlock.matchAll(/^\s{2}([a-z-]+):\s*[(\w<]/gm)].map((m) => m[1])
  : [];
const legacyMissingShape = legacyNames.filter((name) => !legacyWithShape.includes(name));
check(
  "保留旧名都有对应图形",
  legacyNames.length > 0 && legacyMissingShape.length === 0,
  legacyNames.length
    ? `${legacyNames.length} 枚保留：${legacyNames.join(" ")}${legacyMissingShape.length ? `，缺图形：${legacyMissingShape.join(" ")}` : ""}`
    : "LEGACY_NAMES 未解析",
);

console.log(`\n合计 ${notes.length + failures.length} 项，失败 ${failures.length} 项`);
process.exit(failures.length > 0 ? 1 : 0);
