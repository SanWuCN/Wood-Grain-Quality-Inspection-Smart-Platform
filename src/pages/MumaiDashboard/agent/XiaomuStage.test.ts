/**
 * 小木浮标位置与尺寸 · 纯函数单测
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * 拖拽/缩放最容易出的错不是崩溃，而是**边界条件**：
 *   · 对话框比形象宽得多（约 360 vs 132），限界若只按形象算，面板会伸出屏幕外 ——
 *     `clampPos` 必须按"形象 ∪ 面板"的并集夹取；
 *   · 拖到视口左上以外、缩放到极端值、视口被拖得很小 —— 这些都要有确定行为；
 *   · 斜着拖把手时，只取单轴的实现会出现"一个方向不跟手"。
 * 这些在浏览器里手测覆盖不全（要恰好拖到边界），所以写成纯函数单测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EDGE_GAP,
  SIZE_DEFAULT,
  SIZE_MAX,
  SIZE_MIN,
  clampPos,
  clampRectToViewport,
  clampSize,
  maxSizeForViewport,
  posFromDrag,
  resizeKeepingTopLeft,
  sizeFromResize,
  unionRect,
  type StagePos,
} from "./XiaomuStage.ts";

/* ------------------------------------------------------------------ *
 * 尺寸夹取
 * ------------------------------------------------------------------ */

test("clampSize：下限/上限/默认值/非法值", () => {
  assert.equal(clampSize(0), SIZE_MIN, "过小应抬到下限");
  assert.equal(clampSize(-50), SIZE_MIN, "负数应抬到下限");
  assert.equal(clampSize(1e6), SIZE_MAX, "过大应压到上限");
  assert.equal(clampSize(132), 132, "区间内应原样返回");
  assert.equal(clampSize(Number.NaN), SIZE_DEFAULT, "NaN 应回落默认");
  assert.equal(clampSize(Number.POSITIVE_INFINITY), SIZE_DEFAULT, "Infinity 应回落默认");
  assert.equal(clampSize(120.6), 121, "应取整");
});

test("尺寸上下限本身是合理的（防止被改成恒真区间）", () => {
  assert.ok(SIZE_MIN > 0 && SIZE_MIN < SIZE_DEFAULT, "下限要小于默认");
  assert.ok(SIZE_MAX > SIZE_DEFAULT, "上限要大于默认");
  /* 用户口径「极限大小翻一倍」：240 → 480 */
  assert.equal(SIZE_MAX, 480, "上限是默认的两倍多一点，且已被用户明确指定为翻倍");
  assert.ok(EDGE_GAP >= 0, "留白不能为负");
});

test("maxSizeForViewport：上限跟着视口收，小窗口不会让形象占满屏", () => {
  /* 大视口：给到 SIZE_MAX */
  assert.equal(maxSizeForViewport(1920, 1080), 480);
  /* 小视口：按短边比例收（700 × 0.62 = 434） */
  assert.equal(maxSizeForViewport(1200, 700), 434);
  /* 极窄：不会低于下限 */
  assert.equal(maxSizeForViewport(100, 100), SIZE_MIN);
  /* 非法输入回落 SIZE_MAX */
  assert.equal(maxSizeForViewport(Number.NaN, 800), SIZE_MAX);
});

test("sizeFromResize：带上视口时受视口上限约束", () => {
  /* 700 高 → 上限 434，拖到 900 也应被压到 434 */
  assert.equal(sizeFromResize(200, 400, 400, 1200, 700), 434);
  /* 不给视口时用 SIZE_MAX */
  assert.equal(sizeFromResize(200, 400, 400), SIZE_MAX);
});

test("resizeKeepingTopLeft：**左上角不动**，尺寸增长由右/下边吸收", () => {
  /*
    这是用户指出来的手感问题：「右下角拖动之后是向左上角缩放」。
    位置以右下角为锚，所以要让左上角钉住，尺寸增加多少、right/bottom 就要减少多少。
  */
  const pos = { right: 100, bottom: 100 };
  /* 变大 50：right/bottom 各减 50 → 左上角坐标不变 */
  assert.deepEqual(resizeKeepingTopLeft(pos, 132, 182), { right: 50, bottom: 50 });
  /* 变小 50：right/bottom 各加 50 */
  assert.deepEqual(resizeKeepingTopLeft(pos, 182, 132), { right: 150, bottom: 150 });
  /* 尺寸不变：位置不变 */
  assert.deepEqual(resizeKeepingTopLeft(pos, 132, 132), pos);
  /* 不允许负锚点 */
  const clamped = resizeKeepingTopLeft({ right: 10, bottom: 10 }, 132, 300);
  assert.ok(clamped.right >= 0 && clamped.bottom >= 0, "锚点不能为负");
});

test("resizeKeepingTopLeft：左上角确实不动（用并集坐标验证）", () => {
  const size0 = { size: 132 };
  const pos0 = { right: 300, bottom: 300 };
  const before = unionRect(pos0, size0, null, 1400, 900);
  const next = 200;
  const pos1 = resizeKeepingTopLeft(pos0, 132, next);
  const after = unionRect(pos1, { size: next }, null, 1400, 900);
  assert.equal(after.x, before.x, `左边界应不变：${before.x} → ${after.x}`);
  assert.equal(after.y, before.y, `上边界应不变：${before.y} → ${after.y}`);
  assert.equal(after.width, next, "尺寸应生效");
});

/* ------------------------------------------------------------------ *
 * 矩形夹取
 * ------------------------------------------------------------------ */

test("clampRectToViewport：四边越界都夹回，且保留留白", () => {
  const vw = 1000, vh = 800;
  assert.deepEqual(clampRectToViewport({ x: -50, y: -50, width: 100, height: 100 }, vw, vh),
    { x: EDGE_GAP, y: EDGE_GAP }, "左上越界 → 贴留白边");
  assert.deepEqual(clampRectToViewport({ x: 5000, y: 5000, width: 100, height: 100 }, vw, vh),
    { x: vw - 100 - EDGE_GAP, y: vh - 100 - EDGE_GAP }, "右下越界 → 贴留白边");
  assert.deepEqual(clampRectToViewport({ x: 400, y: 300, width: 100, height: 100 }, vw, vh),
    { x: 400, y: 300 }, "完全在内 → 不动");
});

test("clampRectToViewport：矩形比视口还大时贴左上角，不产生负坐标", () => {
  const r = clampRectToViewport({ x: 100, y: 100, width: 2000, height: 2000 }, 800, 600);
  assert.ok(r.x >= EDGE_GAP && r.y >= EDGE_GAP, "不应出现负坐标");
  assert.deepEqual(r, { x: EDGE_GAP, y: EDGE_GAP });
});

/* ------------------------------------------------------------------ *
 * 并集：限界必须按形象 ∪ 面板
 * ------------------------------------------------------------------ */

test("unionRect：无面板时就是形象本身", () => {
  const r = unionRect({ right: 0, bottom: 0 }, { size: 100 }, null, 1000, 800);
  assert.deepEqual(r, { x: 900, y: 700, width: 100, height: 100 });
});

test("unionRect：有面板时向左扩展，右边界仍由形象决定", () => {
  const r = unionRect({ right: 0, bottom: 0 }, { size: 100 }, { width: 300, height: 400 }, 1000, 800);
  assert.equal(r.x + r.width, 1000, "右边界对齐形象右边");
  assert.equal(r.y + r.height, 800, "下边界对齐形象下边");
  assert.ok(r.width >= 300 + 8, "宽度应至少覆盖面板 + 间隙");
});

test("clampPos：**面板伸出视口时必须把整体往右拉回**（只按形象算会漏掉这个）", () => {
  const vw = 1000, vh = 800;
  const size = { size: 132 };
  const panel = { width: 360, height: 420 };
  /* 把形象贴到左上角：此时面板左侧必然出屏 */
  const wanted: StagePos = { right: vw - 132 - EDGE_GAP, bottom: vh - 132 - EDGE_GAP };
  const before = unionRect(wanted, size, panel, vw, vh);
  assert.ok(before.x < EDGE_GAP, "前提：这个位置下面板确实会出屏");

  const fixed = clampPos(wanted, size, panel, vw, vh);
  const after = unionRect(fixed, size, panel, vw, vh);
  assert.ok(after.x >= EDGE_GAP - 0.001, `夹取后并集左边界应在留白内，实际 ${after.x}`);
  assert.ok(after.y >= EDGE_GAP - 0.001, `夹取后并集上边界应在留白内，实际 ${after.y}`);
  assert.ok(after.x + after.width <= vw - EDGE_GAP + 0.001, "右边界也在内");
  assert.ok(after.y + after.height <= vh - EDGE_GAP + 0.001, "下边界也在内");
});

test("clampPos：合法位置不应被改动", () => {
  const vw = 1400, vh = 900;
  const pos: StagePos = { right: 24, bottom: 120 };
  const fixed = clampPos(pos, { size: 132 }, { width: 360, height: 420 }, vw, vh);
  assert.deepEqual(fixed, pos, "本来就合法的位置不该被移动");
});

test("clampPos：视口变小时能重新夹取，且**形象本体始终完整可见**", () => {
  const size = { size: 132 };
  const panel = { width: 360, height: 420 };
  const pos: StagePos = { right: 24, bottom: 64 };
  const big = clampPos(pos, size, panel, 1400, 900);
  assert.deepEqual(big, pos, "大视口下合法位置不该被改动");

  /*
    ⚠ 契约（这里踩过"过约束"）：
    当视口比"形象 ∪ 面板"还小时，**"两者都要完整可见"物理上不可能** ——
    面板本身就 420px 高，视口只有 200px 时连它自己都放不下。
    所以 `clampPos` 的优先级是明确的：
      1. **并集左上角不越界**（面板/形象都不许跑到屏幕左上外面 —— 那里会彻底不可见）
      2. **形象本体完整可见**（它是拖动把柄，必须永远抓得到）
    两者冲突时牺牲第 2 条，但允许"回到默认位置"当兜底（见下）。
  */
  for (const [vw, vh] of [[1400, 900], [900, 700], [560, 620]] as [number, number][]) {
    const fixed = clampPos(pos, size, panel, vw, vh);
    const r = unionRect(fixed, size, panel, vw, vh);
    assert.ok(fixed.right >= 0 && fixed.bottom >= 0, `锚点不能为负（${vw}×${vh}）`);
    assert.ok(r.x >= 0 && r.y >= 0, `并集左上角不应越界（${vw}×${vh} → ${r.x},${r.y}）`);
    /* 视口够放时，形象本体也必须完整可见 */
    if (vw >= 132 + 16 && vh >= 132 + 420) {
      const avatarX = vw - fixed.right - size.size;
      const avatarY = vh - fixed.bottom - size.size;
      assert.ok(avatarX >= 0 && avatarX + size.size <= vw, `形象水平方向应完整可见（${vw}×${vh}，x=${avatarX}）`);
      assert.ok(avatarY >= 0 && avatarY + size.size <= vh, `形象垂直方向应完整可见（${vw}×${vh}，y=${avatarY}）`);
    }
  }
});

test("clampPos：极小视口（无解）时回落到默认位置，且形象仍可抓", () => {
  const size = { size: 132 };
  const panel = { width: 360, height: 420 };
  /*
    200×200 的视口**无解**：形象最左只能到 x=68，面板还要从 68 再往左占 360
    → 并集左上必然为负；而往右推会把形象推出屏幕。两条硬约束无法同时成立。
    此时实现回落到"默认位置夹进视口"（文档化的兜底）：
    宁可回到用户熟悉的默认位，也不给出一个越界坐标。
  */
  const fixed = clampPos({ right: 24, bottom: 64 }, size, panel, 200, 200);
  const avatarX = 200 - fixed.right - size.size;
  const avatarY = 200 - fixed.bottom - size.size;
  assert.ok(fixed.right >= 0 && fixed.bottom >= 0, "锚点不能为负");
  assert.ok(avatarX >= 0 && avatarX + size.size <= 200, `形象水平方向要抓得到（x=${avatarX}）`);
  assert.ok(avatarY >= 0 && avatarY + size.size <= 200, `形象垂直方向要抓得到（y=${avatarY}）`);
  const again = clampPos({ right: 24, bottom: 64 }, size, panel, 200, 200);
  assert.deepEqual(again, fixed, "重复调用必须稳定，否则每次 resize 都会漂");
});

test("clampPos：能放下并集的窄视口里，推完之后并集仍在视口内", () => {
  const size = { size: 132 };
  const panel = { width: 360, height: 420 };
  /* 560×620 放得下（360+8+132=500 ≤ 560，420 ≤ 620），推完之后必须合法 */
  const fixed = clampPos({ right: 24, bottom: 64 }, size, panel, 560, 620);
  const r = unionRect(fixed, size, panel, 560, 620);
  assert.ok(r.x >= 0 && r.y >= 0, `并集左上不应越界：${r.x},${r.y}`);
  const avatarX = 560 - fixed.right - size.size;
  const avatarY = 620 - fixed.bottom - size.size;
  assert.ok(avatarX >= 0 && avatarX + size.size <= 560, `形象水平要可见（x=${avatarX}）`);
  assert.ok(avatarY >= 0 && avatarY + size.size <= 620, `形象垂直要可见（y=${avatarY}）`);
});

test("clampPos：视口足够放下并集时，四边都必须在留白内", () => {
  const size = { size: 132 };
  const panel = { width: 360, height: 420 };
  const vw = 1400, vh = 900;
  for (const pos of [
    { right: 24, bottom: 64 },
    { right: 0, bottom: 0 },
    { right: 5000, bottom: 5000 },
    { right: vw, bottom: vh },
  ] as StagePos[]) {
    const fixed = clampPos(pos, size, panel, vw, vh);
    const r = unionRect(fixed, size, panel, vw, vh);
    assert.ok(r.x >= EDGE_GAP - 0.001, `左边界越界：pos=${JSON.stringify(pos)} → x=${r.x}`);
    assert.ok(r.y >= EDGE_GAP - 0.001, `上边界越界：pos=${JSON.stringify(pos)} → y=${r.y}`);
    assert.ok(r.x + r.width <= vw - EDGE_GAP + 0.001, `右边界越界：pos=${JSON.stringify(pos)}`);
    assert.ok(r.y + r.height <= vh - EDGE_GAP + 0.001, `下边界越界：pos=${JSON.stringify(pos)}`);
  }
});

/* ------------------------------------------------------------------ *
 * 拖动与缩放的方向
 * ------------------------------------------------------------------ */

test("posFromDrag：向右拖 → 右边距减小（视觉上跟着手走）", () => {
  const start = { right: 100, bottom: 100, x: 500, y: 500 };
  assert.deepEqual(posFromDrag(start, 40, 0), { right: 60, bottom: 100 });
  assert.deepEqual(posFromDrag(start, 0, 30), { right: 100, bottom: 70 });
  assert.deepEqual(posFromDrag(start, -25, -25), { right: 125, bottom: 125 });
});

test("posFromDrag：不允许越过左/上边界产生负锚点", () => {
  const start = { right: 10, bottom: 10, x: 0, y: 0 };
  const moved = posFromDrag(start, 999, 999);
  assert.ok(moved.right >= 0 && moved.bottom >= 0, "锚点不能为负");
});

test("sizeFromResize：向右下拖变大，且两轴位移取**平均**（斜拖也跟手）", () => {
  /* 单轴：另一轴≈0，平均值退化成该轴距离 */
  assert.equal(sizeFromResize(132, 20, 0), 142);
  assert.equal(sizeFromResize(132, 0, 20), 142);
  /* 斜拖：两轴各 30 → 平均 30（不是相加 60，也不是只取一个轴） */
  assert.equal(sizeFromResize(132, 30, 30), 162);
  /*
    这条是**回归断言**：曾经用 `Math.max(dx, dy)`，斜着往左上拖时会挑到较小的那个负数
    （dx=-10、dy=-30 → 取 -10），拖了一大段却只缩一点点，手感是"不跟手"。
  */
  assert.equal(sizeFromResize(132, -10, -30), 112, "斜向左上拖应按两轴平均缩小");
  assert.equal(sizeFromResize(132, -20, -20), 112);
  assert.equal(sizeFromResize(SIZE_MIN, -100, -100), SIZE_MIN, "不能小于下限");
  assert.equal(sizeFromResize(SIZE_MAX, 100, 100), SIZE_MAX, "不能大于上限");
});
