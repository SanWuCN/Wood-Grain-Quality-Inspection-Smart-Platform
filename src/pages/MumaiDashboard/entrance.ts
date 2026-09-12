/**
 * 页面入场动画 —— 对齐 Demo2 源码的那一套。
 *
 * Demo2 的做法（`Demo2/panel/index.tsx` + `hooks/useMoveTo.ts`）：
 *   - 顶栏 `useMoveTo("toBottom", 0.6)`：从 `translate(0,-100%)` 落到位
 *   - 左栏三块 `useMoveTo("toRight", 0.8, 0.5/0.6/0.7)`：从 `translate(-100%,0)` 滑入
 *   - 右栏三块 `useMoveTo("toLeft", 0.8, 0.5/0.6/0.7)`：从 `translate(100%,0)` 滑入
 *   - 触发时机：`useConfigStore.mapPlayComplete` 变 true（地图镜头推完的那一刻，
 *     也就是 t≈2.5s），**不是**等地图完全展开 —— 两段动画是咬合的。
 *
 * 这里把同一套时序搬到外壳上，由 Shell 统一驱动，所以：
 *   - 所有页面都有顶栏入场，不需要每个页面各自接一遍
 *   - 总览页两侧四个 Panel 分别从左右滑入（Demo2 一栏 3 块，这里一栏 2 块，
 *     所以间隔按 `STAGGER` 收窄到 0.1s 以内，整体节奏保持一致）
 *
 * 与 Demo2 的差异只有一处：`mapPlayComplete` 是「中国/上海模式的镜头推完」，
 * 只有总览页有地图。非总览页没有这个信号，所以在 boot 结束后立即播放。
 */

import { useEffect, useLayoutEffect, useState } from "react";
import { gsap } from "gsap";

/** Demo2 的原值，不要随手改：改了这个，整段开场节奏就和 demo_2 对不上了 */
const DUR_HEADER = 0.6;
const DUR_SIDE = 0.8;
const DELAY_BASE = 0.5;
const STAGGER = 0.1;

const reduceMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

interface Step {
  el: Element;
  from: gsap.TweenVars;
  duration: number;
  delay: number;
}

function collect(): Step[] {
  const steps: Step[] = [];
  const q = (selector: string) => document.querySelector(selector);

  /** 顶栏：从上方落下（Demo2 `toBottom`） */
  const header = q(".appshell__header");
  if (header) {
    steps.push({
      el: header,
      from: { yPercent: -100 },
      duration: DUR_HEADER,
      delay: 0,
    });
  }

  /** 内容区里的页面根节点：非总览页用一次轻量的淡入上浮 */
  const stage = q(".appshell__stage");
  const pageRoot = stage?.firstElementChild ?? null;
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".ov__panel"));

  if (panels.length) {
    // 总览：左右两栏各两块 Panel，分别从左右滑入
    const left: HTMLElement[] = [];
    const right: HTMLElement[] = [];
    for (const panel of panels) {
      const box = panel.getBoundingClientRect();
      (box.left + box.width / 2 < window.innerWidth / 2 ? left : right).push(panel);
    }
    left.forEach((el, index) => {
      steps.push({
        el,
        from: { xPercent: -100 },
        duration: DUR_SIDE,
        delay: DELAY_BASE + index * STAGGER,
      });
    });
    right.forEach((el, index) => {
      steps.push({
        el,
        from: { xPercent: 100 },
        duration: DUR_SIDE,
        delay: DELAY_BASE + index * STAGGER,
      });
    });

    // 面包屑 / 图例按钮 / 底部状态条：跟着地图一起出现，不做位移
    for (const [selector, delay] of [
      [".ov__crumb", 0.32],
      [".ov__actions", 0.42],
      [".ov__hint", 0.46],
      [".ov__foot", 0.5],
    ] as const) {
      const el = q(selector);
      if (el) steps.push({ el, from: { y: 14 }, duration: 0.5, delay });
    }
  } else if (pageRoot) {
    steps.push({
      el: pageRoot,
      from: { y: 18 },
      duration: 0.56,
      delay: 0.08,
    });
  }

  /** 底部状态条从下方升起，右下角控件缩放入场 */
  const ticker = q(".appshell__ticker");
  if (ticker) {
    steps.push({ el: ticker, from: { yPercent: 100 }, duration: 0.7, delay: 0.62 });
  }
  const fab = q(".appshell__fab");
  if (fab) {
    steps.push({ el: fab, from: { scale: 0.6, y: 16 }, duration: 0.5, delay: 0.7 });
  }
  const login = q(".appshell__login");
  if (login) {
    steps.push({ el: login, from: { y: 22 }, duration: 0.6, delay: 0.66 });
  }

  return steps;
}

/**
 * @param ready 可以开始入场了（总览页 = 地图镜头推完；其它页 = boot 结束）
 * @param routeKey 路由标识，变化时重新播一遍
 * @param fallbackMs 兜底时长：到点无论 `ready` 是什么都强制入场
 */
export function useShellEntrance(ready: boolean, routeKey: string, fallbackMs = 3400) {
  /**
   * 兜底必须存在。
   *
   * `ready` 依赖 `mapPlayComplete` —— 那是地图那边的一次性闩锁。
   * 一旦出现「地图先完成、外壳后挂载」的顺序（HMR 热更新只替换了外壳、
   * 或闩锁被模块重载重置而地图没重挂），`ready` 会**永远是 false**，
   * 而各面板的初始态是 `opacity: 0` + 位移到屏幕外 ——
   * 结果就是两侧面板永久停在屏幕外，页面看起来像空的。
   * 所以这里挂一个定时器：到点无条件入场。
   */
  const [forced, setForced] = useState(false);
  useEffect(() => {
    setForced(false);
    const timer = window.setTimeout(() => setForced(true), fallbackMs);
    return () => window.clearTimeout(timer);
  }, [routeKey, fallbackMs]);

  const go = ready || forced;

  /**
   * 硬保险：到这还没显示就直接清掉内联 transform/opacity。
   *
   * 前面「先隐藏再播放」的做法有一个致命失败模式 —— 只要隐藏发生了、
   * 播放那一段因为任何原因没跑（组件挂载顺序、Suspense 让页面晚于外壳挂载、
   * 时间线被 HMR 打断），面板就**永远停在屏幕外**，页面看起来是空的。
   * 这里无条件兜一层：无论前面发生了什么，到点一定让所有元素回到自然位置。
   */
  useEffect(() => {
    const hard = window.setTimeout(() => {
      for (const step of collect()) {
        gsap.set(step.el, { clearProps: "transform,opacity" });
      }
    }, fallbackMs + 2600);
    return () => window.clearTimeout(hard);
  }, [routeKey, fallbackMs]);

  // 先隐藏：必须在浏览器绘制之前完成，否则会看到面板「闪一下再飞进来」
  useLayoutEffect(() => {
    if (reduceMotion()) return;
    const steps = collect();
    for (const step of steps) gsap.set(step.el, { opacity: 0, ...step.from });
    return () => {
      for (const step of steps) {
        gsap.killTweensOf(step.el);
        gsap.set(step.el, { clearProps: "transform,opacity" });
      }
    };
  }, [routeKey]);

  useEffect(() => {
    if (!go) return;
    const steps = collect();
    if (!steps.length) return;

    if (reduceMotion()) {
      for (const step of steps) {
        gsap.set(step.el, { opacity: 1, xPercent: 0, yPercent: 0, x: 0, y: 0 });
      }
      return;
    }

    const tl = gsap.timeline();
    for (const step of steps) {
      // 第 4 个参数是时间线上的绝对位置 —— 不传的话每段都会被追加到上一段之后，
      // 变成串行播放，而不是 Demo2 那种「同时开始、各自错开」的咬合节奏。
      tl.fromTo(
        step.el,
        { opacity: 0, ...step.from },
        {
          opacity: 1,
          xPercent: 0,
          yPercent: 0,
          x: 0,
          y: 0,
          scale: 1,
          duration: step.duration,
          ease: "power3.out",
          // 动画结束后清掉内联 transform，避免影响 hover / 后续布局
          clearProps: "transform,opacity",
        },
        step.delay,
      );
    }

    return () => {
      tl.kill();
    };
  }, [go, routeKey]);
}
