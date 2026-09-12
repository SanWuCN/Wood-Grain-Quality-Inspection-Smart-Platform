/**
 * 面板依次入场
 *
 * 对应 demo2 的 useMoveTo + useConfigStore.mapPlayComplete 那一套：
 * 地图开场动画结束后，左右面板分别从外侧滑入，顶部标题从上方落下。
 * 用 GSAP 而不是 CSS animation，是为了能拿到「地图播完」这个精确时刻。
 */

import { useEffect, useRef } from "react";
import { gsap } from "gsap";

export function usePanelEntrance(introDone: boolean) {
  const shellRef = useRef<HTMLElement | null>(null);
  const topRef = useRef<HTMLElement | null>(null);
  const leftRefs = [
    useRef<HTMLElement | null>(null),
    useRef<HTMLElement | null>(null),
    useRef<HTMLElement | null>(null),
  ];
  const rightRefs = [
    useRef<HTMLElement | null>(null),
    useRef<HTMLElement | null>(null),
    useRef<HTMLElement | null>(null),
  ];

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const targets = [
      topRef.current,
      ...leftRefs.map((r) => r.current),
      ...rightRefs.map((r) => r.current),
    ].filter(Boolean) as HTMLElement[];

    if (!targets.length) return;

    // 未开始前先全部藏起来，避免开场时面板已经露出来
    gsap.set(targets, { opacity: 0 });
    const tl = gsap.timeline({ paused: true });

    if (reduce) {
      tl.set(targets, { opacity: 1, x: 0, y: 0, clearProps: "transform" });
    } else {
      if (topRef.current) {
        tl.fromTo(
          topRef.current,
          { y: -34, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" },
          0,
        );
      }
      leftRefs.forEach((ref, index) => {
        if (!ref.current) return;
        tl.fromTo(
          ref.current,
          { x: -46, opacity: 0 },
          { x: 0, opacity: 1, duration: 0.68, ease: "power3.out" },
          0.12 + index * 0.11,
        );
      });
      rightRefs.forEach((ref, index) => {
        if (!ref.current) return;
        tl.fromTo(
          ref.current,
          { x: 46, opacity: 0 },
          { x: 0, opacity: 1, duration: 0.68, ease: "power3.out" },
          0.18 + index * 0.11,
        );
      });
    }

    if (introDone) {
      tl.play(0);
    } else {
      tl.pause(0);
    }

    return () => {
      tl.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone]);

  return { shellRef, topRef, leftRefs, rightRefs };
}
