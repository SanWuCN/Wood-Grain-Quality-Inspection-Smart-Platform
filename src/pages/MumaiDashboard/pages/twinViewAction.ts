/**
 * 数字孪生主视图的跨树开关（内部点云 / 证据对照）
 *
 * ── 谁在用 ──────────────────────────────────────────────────────────
 *   · `executor`：**㉒「证据对照与补核清单」**播完时切到**证据对照**那一屏 ——
 *     用户 2026-10-01 的口径：「证据对照已打开…这个对话，还是要做具体的东西，而不只是跳转」，
 *     所以 ㉒ 的落点必须是那张**对照表**（视觉 ↔ 雷达 ↔ 凭什么算一致 + 补核清单），
 *     而不是只跳到数字孪生页。**刻意不放在 ⑪**：⑪ 讲的是"外观可见的表面缺损与孔洞状疑点"，
 *     那时候还没做精扫，把后面的结论提前演了就是剧情矛盾；
 *   · 内部点云那一屏由**证据对照页上的按钮**（「看内部点云」）或主视图页签进入 ——
 *     两路证据汇到的那一层正是内部响应区，所以它是证据对照的下钻，不抢 ㉒ 的主位。
 *
 * 与 `demoSurfaceAction.ts` / `originalPhotoAction.ts` 同一套做法：事件名与派发单独放
 * `.ts`，因为单测只认 `.ts`，而"派了但没人听"这种毛病不会报错、只会现场没反应。
 */
export const TWIN_INTERNAL_CLOUD_EVENT = "mumai:twin-internal-cloud";
/** ㉒ 播完切到「证据对照」那一屏 */
export const TWIN_EVIDENCE_EVENT = "mumai:twin-evidence";

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

/**
 * 切到「证据对照」（㉒ 的屏幕落点），并可选地聚焦某根柱子。
 *
 * @param componentId 要聚焦的构件（留空 = 保持页面上当前选中的那根）
 */
export function openEvidence(componentId = ""): boolean {
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(TWIN_EVIDENCE_EVENT, { detail: { componentId } }));
  return true;
}
