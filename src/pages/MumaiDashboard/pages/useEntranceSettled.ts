/**
 * 「面板入场动画播完了吗」
 *
 * 总览页四块面板是滑入的（`entrance.ts`：从左右两侧 xPercent ±100 滑到位，
 * 最后一段在 0.6s 开始、0.8s 结束，加上顶栏一共 1.4s 左右）。图表如果在这之前
 * 就播自己的入场动画，扇区和柱子会在面板还在滑的时候长出来 —— 看起来像
 * 页面在抽搐，而不是「先摆好牌子，再让数据长出来」。
 *
 * 所以图表的动画要**排在面板之后**：这个 hook 只在总览页入场时间线跑完后
 * 返回 true，接到 `Chart` 的 `animate` 上，ECharts 的 `animationDelay` 再等 0.2s。
 *
 * 为什么不用 `useShellEntrance` 的 ready：那个条件在总览页等于
 * `mapPlayComplete`，是「地图镜头推完、面板开始滑入」的那一刻，
 * 比「面板滑完」早 1.4s —— 用它当信号，动画还是会和滑入重叠。
 *
 * 非总览页没有面板滑入（页面根节点只有一次轻量淡入），等待时间给 0.4s 即可。
 * `prefers-reduced-motion` 时直接算作已就绪，不做等待。
 */

import { useEffect, useState } from "react";

/** 面板滑入最后一段的结束时刻（秒）：delay 0.6 + duration 0.8（entrance.ts） */
const PANEL_SETTLE_S = 1.4;
/** 非总览页：页面根节点淡入 0.08 + 0.56 ≈ 0.64s，取 0.4s 就够，动画本身还有延迟 */
const PAGE_SETTLE_S = 0.4;
/** 图自己再等一档，避免和面板定格同一帧开始 */
export const CHART_ANIMATION_DELAY_MS = 200;

export function useEntranceSettled(routeKey: string): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(false);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setSettled(true);
      return;
    }
    const seconds = routeKey === "/" ? PANEL_SETTLE_S : PAGE_SETTLE_S;
    const timer = window.setTimeout(() => setSettled(true), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [routeKey]);

  return settled;
}
