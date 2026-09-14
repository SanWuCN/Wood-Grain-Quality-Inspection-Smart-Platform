/**
 * 小木形象方案展台 · 自适应布局（REQ-05，UC-04）
 *
 * ── 只有两个导出，且两个都是纯的 ────────────────────────────────────
 * 展台页在 resize 时要做的判断只有"几列"，而"几列"完全由宽度决定。
 * 把这一个判断抽成纯函数，代价是十几行，收益是：
 *   · 断点写反（`<=` 写成 `<`）能在单测里当场红，不必等 E2E 报"有横向滚动条"；
 *   · 页面侧的 resize 处理只剩"算列数 → 写 CSS 变量"，不含条件分支。
 *
 * ⚠ 这个文件**不许**出现 `window` / `document` / `ResizeObserver`。
 *    一旦出现，它就再也不能在 Node 里断言，"列数是纯函数"这条 AC 也就名存实亡。
 */

/**
 * 断点表（design.md §2 写死的值）。
 *
 * 这两个数是**开关点**（inclusive）：宽度恰好等于它时归右边那一档。
 *   `two = 1024`    → 1024 起两列
 *   `three = 1600`  → 1600 起三列
 */
export const COLUMN_BREAKPOINTS = { two: 1024, three: 1600 } as const;

/**
 * 格子最小可读宽度（CSS 像素）。
 *
 * 用途有两个，都指向同一条 AC（UC-04 备选 4b：宁可纵向滚动也不横向溢出，
 * 也不把格子压成不可读）：
 *   1. `grid-template-columns: repeat(N, minmax(minCellWidth, 1fr))` 的下界；
 *   2. FPS 数字与"技术要点"那几行文字的最小容身宽度 —— 低于 160px 时
 *      一句话特点会折成四五行，标注就"不可读"了。
 */
export const minCellWidth = 220;

/**
 * 由视口宽度推导网格列数。
 *
 * 断点：`< 1024 → 1`、`1024–1599 → 2`、`≥ 1600 → 3`。
 *
 * 退化输入（0 / 负数 / NaN / -Infinity）→ 1 列：
 * 列数是 CSS `repeat(N, ...)` 的 N，取 0 会让整页变成空白 ——
 * 而"视口还没测量出来"在真实浏览器里是会发生的（首次布局前 innerWidth 可能为 0）。
 * 宁可先用单列把内容渲染出来，也不能整页空白。
 */
export function columnsFor(width: number): number {
  if (!Number.isFinite(width)) {
    // +Infinity 是"无限宽"，按最多列算；NaN / -Infinity 落回单列
    return width === Number.POSITIVE_INFINITY ? 3 : 1;
  }
  if (width < COLUMN_BREAKPOINTS.two) return 1;
  if (width < COLUMN_BREAKPOINTS.three) return 2;
  return 3;
}
