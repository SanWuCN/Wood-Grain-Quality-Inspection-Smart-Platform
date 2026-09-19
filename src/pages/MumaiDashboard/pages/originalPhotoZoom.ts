/**
 * 「打开你标记的原图」里那个放大的算法（纯函数，可单测）
 *
 * ── 为什么单独一个 `.ts` ────────────────────────────────────────────
 * 窗口本体是 `.tsx`，而本仓库单测跑在 Node 原生类型剥离下，**只认 `.ts`**
 * （`.tsx` 会报 `ERR_UNKNOWN_FILE_EXTENSION`）。"放大多少倍"恰恰是最该被钉住的：
 * 写小了看不出疑点、写大了整屏都是木纹，而 26 张原片的框大小差了三四倍。
 *
 * ── 倍率怎么定 ──────────────────────────────────────────────────────
 * 目标是"框放大后大约占画面 42%"：`k ≈ 0.42 / max(框宽, 框高)`，
 * 再夹在 1.6×–4× 之间 ——
 *   · 下限 1.6×：太小的倍率等于没放大，讲解人还得用手比划；
 *   · 上限 4×：原片是 3024×4032，4× 之后单个像素已经约等于屏幕像素，
 *     再放大只是插值糊掉，不会多出信息。
 */

/** 放大后希望疑点区域占画面的比例 */
export const ZOOM_TARGET_SPAN = 0.42;
/** 倍率上下限（理由见文件头） */
export const ZOOM_MIN = 1.6;
export const ZOOM_MAX = 4;

/**
 * 按标注框大小算放大倍率。
 *
 * @param box 归一化的标注框（0–1）；没有框时返回 1（= 不放大，剧本原文要求）
 */
export function zoomFactorFor(box: { w: number; h: number } | null | undefined): number {
  if (!box) return 1;
  const span = Math.max(Number(box.w) || 0, Number(box.h) || 0);
  if (!(span > 0)) return 1;
  const raw = ZOOM_TARGET_SPAN / span;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
  /* 保留一位小数：屏幕上写"已放大疑点区域 2.7×"比写 2.6833… 好读 */
  return Math.round(clamped * 10) / 10;
}
