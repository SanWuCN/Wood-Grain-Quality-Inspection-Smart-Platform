/**
 * 一次性维护脚本：把平台 CSS 里写死的图标尺寸改成读 `--mumai-icon-size`。
 *
 * 背景（PRD §3.2）：
 *   「旧组件调用方若通过 CSS 设置宽高，迁移时检查覆盖关系，避免 size 属性无效。」
 *
 * SVG 的 width/height **属性**属于表现属性（presentation attribute），
 * 优先级低于任何 CSS 规则。所以只要旧 CSS 里写了 `.xxx svg { width: 14px }`，
 * Icon 组件的 size 就完全失效 —— 实测量到过「attr=20 但渲染 14px」。
 *
 * 本脚本把这类规则统一改成 `var(--mumai-icon-size, <原值>)`：
 *   · 组件显式给了 size → 用 size（size 成为唯一真源）
 *   · 没给（非 Icon 的自绘 svg）→ 回落到原值，视觉零变化
 *
 * 用法：node tools/fix-icon-size-overrides.mjs [--dry]
 */

import { readFileSync, writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry");

/**
 * 需要处理的规则：选择器以 svg 结尾、是具体图标位、单条 width 声明。
 * 刻意**排除**这些（它们是图表/画布容器，不是图标，不该被 size 接管）：
 *   .trend-chart svg / .wavechart svg / .present__curves svg / .login__terrain svg
 */
const FILES = [
  "src/pages/MumaiDashboard/pages.css",
  "src/pages/MumaiDashboard/appshell.css",
  "src/pages/MumaiDashboard/dashboard.css",
  "src/pages/MumaiDashboard/agent/agent.css",
  "src/pages/MumaiDashboard/pages/login.css",
];

const SKIP_SELECTORS = [
  ".trend-chart svg",
  ".wavechart svg",
  ".present__curves svg",
  ".login__terrain svg",
];

let totalChanged = 0;

for (const file of FILES) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const out = [];
  let changed = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const selectorMatch = /^([^{}]*\bsvg)\s*\{\s*$/.exec(line);

    if (!selectorMatch || SKIP_SELECTORS.some((skip) => line.includes(skip))) {
      out.push(line);
      continue;
    }

    // 收集这条规则体内的声明
    const body = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].includes("}")) {
      body.push(lines[j]);
      j += 1;
    }
    if (j >= lines.length) {
      out.push(line);
      continue;
    }
    const closing = lines[j];

    let touched = false;
    const newBody = body.map((decl) => {
      const m = /^(\s*)width:\s*(\d+)px;\s*$/.exec(decl);
      if (!m) return decl;
      touched = true;
      return `${m[1]}width: var(--mumai-icon-size, ${m[2]}px);`;
    });

    // height 只在同一规则里也有写死的 width 时才一起改（保持成对）
    const newBody2 = touched
      ? newBody.map((decl) => {
          const m = /^(\s*)height:\s*(\d+)px;\s*$/.exec(decl);
          if (!m) return decl;
          return `${m[1]}height: var(--mumai-icon-size, ${m[2]}px);`;
        })
      : newBody;

    // flex: 0 0 13px 这种也会锁死宽度，一起接管
    const newBody3 = touched
      ? newBody2.map((decl) => {
          const m = /^(\s*)flex:\s*0\s+0\s+(\d+)px;\s*$/.exec(decl);
          if (!m) return decl;
          return `${m[1]}flex: 0 0 var(--mumai-icon-size, ${m[2]}px);`;
        })
      : newBody2;

    if (touched) {
      changed += 1;
      out.push(line, ...newBody3, closing);
    } else {
      out.push(line, ...body, closing);
    }
    i = j;
  }

  if (changed > 0) {
    totalChanged += changed;
    if (!DRY) writeFileSync(file, out.join("\n"), "utf8");
    console.log(`${DRY ? "[dry] " : ""}${file}：改写 ${changed} 条 svg 尺寸规则`);
  }
}

console.log(`\n合计 ${totalChanged} 条${DRY ? "（未写盘）" : ""}`);
