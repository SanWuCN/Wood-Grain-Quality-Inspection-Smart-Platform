/**
 * UC-04 自适应布局 · 列数纯函数（unit test，2.3 + 2.20）
 *
 * ── 为什么列数必须是"纯函数"────────────────────────────────────────
 * 它是**唯一**能在 Node 里被断言的布局事实。溢出、裁切、滚动条都要真浏览器
 * （走 3.5 的 E2E），但"1366 该是几列"这件事不该等到 E2E 才知道 ——
 * 一旦列数算错，E2E 只会告诉你"有横向滚动条"，不会告诉你断点写反了。
 *
 * ── 断点表（design.md §2，一个数字都不能改）─────────────────────────
 *   < 1024        → 1 列
 *   1024 – 1599   → 2 列
 *   ≥ 1600        → 3 列
 *
 * 1024 与 1600 是**各自的开关点**：恰好落在断点上的宽度属于右边那一档
 * （1024 → 2 列、1600 → 3 列）。这一条最容易写反成 `<=`，所以单独断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { columnsFor, COLUMN_BREAKPOINTS, minCellWidth } from "./layout.ts";

test("columnsFor：design.md §2 写死的四个取值（1366/1440/1920/1023）", () => {
  assert.equal(columnsFor(1366), 2, "笔电主力分辨率：两列");
  assert.equal(columnsFor(1440), 2, "1440 仍在 1024–1599 区间：两列");
  assert.equal(columnsFor(1920), 3, "台式主力分辨率：三列（≥1600）");
  assert.equal(columnsFor(1023), 1, "差一像素到断点：单列（备选 4a）");
});

test("columnsFor：三个区间各自的内部取值", () => {
  // 区间内部（不是断点）也要对，否则可能是"只在断点上凑对"
  assert.equal(columnsFor(360), 1, "手机竖屏");
  assert.equal(columnsFor(800), 1, "平板竖屏");
  assert.equal(columnsFor(1024), 2, "断点本身归右档");
  assert.equal(columnsFor(1280), 2);
  assert.equal(columnsFor(1599), 2, "断点前一像素");
  assert.equal(columnsFor(1600), 3, "断点本身归右档");
  assert.equal(columnsFor(2560), 3);
  assert.equal(columnsFor(3840), 3, "4K 也只有三列：格子再宽就没有比较意义了");
});

test("columnsFor：恰好落在断点上时归右档（1024/1600 是开关点，不是排他上界）", () => {
  // 单独再写一遍是因为这一条是 `<=` / `<` 最常写反的地方
  assert.equal(columnsFor(COLUMN_BREAKPOINTS.two), 2, "1024 → 2 列");
  assert.equal(columnsFor(COLUMN_BREAKPOINTS.three), 3, "1600 → 3 列");
  assert.equal(columnsFor(COLUMN_BREAKPOINTS.two - 1), 1, "1023 → 1 列");
  assert.equal(columnsFor(COLUMN_BREAKPOINTS.three - 1), 2, "1599 → 2 列");
});

test("columnsFor：非法/退化输入不返回 NaN 或 0（布局崩掉的常见成因）", () => {
  // 窗口还没测量出来时 innerWidth 可能是 0；某些环境下会读到 NaN。
  // 这两种输入都必须落回**最保守**的一列，而不是 0 列或 NaN 列 ——
  // 0 列会让 `repeat(0, 1fr)` 直接吞掉所有格子（整页空白）。
  for (const width of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const columns = columnsFor(width);
    assert.ok(Number.isInteger(columns), `columnsFor(${width}) 必须是整数，得到 ${columns}`);
    assert.ok(columns >= 1, `columnsFor(${width}) 至少 1 列，得到 ${columns}`);
  }
  assert.equal(columnsFor(0), 1);
  assert.equal(columnsFor(Number.NaN), 1);
  assert.equal(columnsFor(Number.POSITIVE_INFINITY), 3, "大到没边的宽度按最多列算");
});

test("columnsFor：单调不减（宽度变大时列数不许回退）", () => {
  // 单调性是"连续缩放窗口时不会排列错乱"（UC-04 时间/恢复）的数学前提：
  // 非单调的断点表会让用户把窗口拉宽反而少一列，看起来像"排错了"。
  let previous = 0;
  for (let width = 200; width <= 2600; width += 1) {
    const columns = columnsFor(width);
    assert.ok(columns >= previous, `宽度 ${width} 时列数从 ${previous} 掉回 ${columns}`);
    previous = columns;
  }
});

test("columnsFor：纯函数 —— 同一个宽度调一万次都是同一个结果，且不改入参", () => {
  const width = 1440;
  const first = columnsFor(width);
  for (let i = 0; i < 10000; i += 1) {
    assert.equal(columnsFor(width), first);
  }
  assert.equal(width, 1440, "入参被改了就不是纯函数");
});

test("minCellWidth：格子最小可读尺寸，>0 且不随列数变化", () => {
  // 用途：极扁/极窄视口下"宁可纵向滚动也不横向溢出、也不把格子压成不可读"
  // （UC-04 备选 4b）。它是 CSS minmax() 的第二个参数，必须是正数常量。
  assert.ok(minCellWidth >= 120, `格子最小宽度 ${minCellWidth} 太小，FPS/编号会挤成一团`);
  assert.ok(minCellWidth <= 480, `格子最小宽度 ${minCellWidth} 太大，1366 下两列会溢出`);
});
