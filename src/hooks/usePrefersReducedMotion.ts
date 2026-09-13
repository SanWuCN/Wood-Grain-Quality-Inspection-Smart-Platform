/**
 * prefers-reduced-motion（系统「减少动态效果」偏好）
 *
 * 单独放在 `src/hooks/` 而不是留在地图/总览页里：数字动效组件
 * （`src/components/numberAnimation.tsx`）是全局共享件，不能反向去 import
 * 某个页面模块。原来写在 `pages/MumaiDashboard/pages/useMediaQuery.ts` 里的那份
 * 现在从这里转出，全平台只有一份实现。
 *
 * 与 CSS 的 `@media (prefers-reduced-motion: reduce)` 是同一个偏好：JS 侧读它
 * 是为了让**行为**也停（数字不再逐帧插值、自动轮播不再位移），
 * 而不只是把动画时长设成 0。验收口径见 ANI-10。
 */

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function readMatch(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readMatch);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    /* 挂载后立刻对齐一次：渲染与副作用之间用户可能刚改过系统设置 */
    setReduced(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
