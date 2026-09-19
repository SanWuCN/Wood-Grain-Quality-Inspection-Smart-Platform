/**
 * 「打开你标记的原图」的跨树开关（剧本 ⑫）
 *
 * 与 `demoSurfaceAction.ts` 同一套做法：组件在 Twin 页里、触发方在 `executor`
 * 或页面上的一颗按钮，两棵树不相邻，事件是这块代码里既有的跨树约定。
 * 事件名与派发单独放 `.ts`，是因为单测只认 `.ts` —— 而"点了没反应"这种毛病
 * 恰恰只能靠单测提前发现（不会报错、不会崩）。
 */
export const ORIGINAL_PHOTO_EVENT = "mumai:original-photo";

/**
 * 打开原图查看窗口。
 *
 * @param componentId 看哪个构件的原片；**留空表示"按页面上当前选中的构件"**
 *                    （⑫ 的台词是「打开你标记的原图」，选中的那根就是"你标记的"）
 * @returns 事件是否真的发出去了（不在浏览器里 → false）
 */
export function openOriginalPhoto(componentId = ""): boolean {
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(ORIGINAL_PHOTO_EVENT, { detail: { componentId } }));
  return true;
}
