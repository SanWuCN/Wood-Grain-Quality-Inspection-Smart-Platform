/**
 * 「切到内部点云」的跨树开关（数字孪生主视图）
 *
 * ── 谁在用 ──────────────────────────────────────────────────────────
 *   · `executor`：**㉒「证据对照与补核清单」**播完时切过去 —— 这一轮落在数字孪生页，
 *     台词说的正是"两路共同提示的项目优先展示"，而内部响应区（虫蛀/裂痕）就是两路证据
 *     汇到的那一层。**刻意不放在 ⑪**：⑪ 讲的是"外观可见的表面缺损与孔洞状疑点"，
 *     那时候还没做精扫，把内部点云摆出来等于把后面的结论提前演了（剧情矛盾）；
 *   · 页面上的人：主视图那行页签本来就是手动入口，这个事件只是让"小木带路"也能到。
 *
 * 与 `demoSurfaceAction.ts` / `originalPhotoAction.ts` 同一套做法：事件名与派发单独放
 * `.ts`，因为单测只认 `.ts`，而"派了但没人听"这种毛病不会报错、只会现场没反应。
 */
export const TWIN_INTERNAL_CLOUD_EVENT = "mumai:twin-internal-cloud";

/**
 * 切到内部点云，并可选地聚焦某根柱子。
 *
 * @param componentId 要聚焦的构件（留空 = 保持页面上当前选中的那根）
 * @returns 事件是否真的发出去了（不在浏览器里 → false）
 */
export function openInternalCloud(componentId = ""): boolean {
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(TWIN_INTERNAL_CLOUD_EVENT, { detail: { componentId } }));
  return true;
}
