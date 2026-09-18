/**
 * 演示表面（左下角浮层）的跨树开关
 *
 * ── 为什么单独一个 `.ts` ────────────────────────────────────────────
 * 组件本体在 `demoSurface.tsx`，而本仓库的单测跑在 Node 原生类型剥离下，
 * **只认 `.ts`、不认 `.tsx`**（实测 `ERR_UNKNOWN_FILE_EXTENSION: ".tsx"`）。
 * "打开哪一轮的表面"这件事又恰恰是最该被钉住的（写错轮次 = 现场弹错窗口，
 * 不会报错、只会出丑），所以把事件名与派发留在这里，组件那边只管画。
 *
 * ── 谁在用 ──────────────────────────────────────────────────────────
 *   · `agent/executor.ts`：某一轮播报收尾时打开该轮的表面；
 *   · `pages/Mapping.tsx`：**人自己**打开通道巡查窗口（剧本 §102
 *     「等待时选用：小车继续建图，**史在平台开启数据通道巡查**」）——
 *     与 ⑨ 那一轮弹的是同一个窗口，不是第二个实现。
 */
export const DEMO_SURFACE_EVENT = "mumai:demo-surface";

/**
 * 打开某一轮的表面（轮次号必须是 `DEMO_ACTIONS` 里有的那一轮）。
 *
 * @returns 事件是否真的发出去了（不在浏览器里 → false）
 */
export function openDemoSurface(roundNo: string): boolean {
  if (!roundNo || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(DEMO_SURFACE_EVENT, { detail: { roundNo } }));
  return true;
}
