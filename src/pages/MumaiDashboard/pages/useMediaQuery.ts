/**
 * 媒体查询 hook
 *
 * 总览页用它决定「这一档屏幕显示多少内容」：四块面板高度在 1920 是 435px、
 * 到 1366 只剩 292px，工单列表收起态就得从 4 行降到 3 行，否则面板出现滚动条。
 *
 * 与 CSS 媒体查询保持同一份条件字符串（`(max-width: 1440px), (max-height: 800px)`）：
 * 布局是 CSS 决定的，JS 只负责跟着少渲染一点，
 * 两边条件写得不一致就会出现「CSS 已经收窄、JS 还以为很宽」的错位。
 */

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * prefers-reduced-motion（PRD §7.1：开启后默认暂停自动位移，不隐藏内容）
 *
 * 与 CSS 的 `@media (prefers-reduced-motion: reduce)` 同一个偏好，
 * JS 侧读它是为了让**行为**也停（自动轮播），而不只是把动画时长设成 0。
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
