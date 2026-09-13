/**
 * 木脉智检 · 药丸导航（PillNav）
 *
 * 交互取自 React Bits 的 PillNav（https://www.reactbits.dev/components/pill-nav）：
 *   - 每个导航项是一枚药丸，圆角 9999px
 *   - 指针进入时，从药丸**底边中点**长出一个圆（圆的半径由药丸的宽高算出来，
 *     保证放大后完整覆盖整枚药丸），把药丸底色填成强调色
 *   - 同时把「图标 + 文字」整体向上滚出，另一份同内容从下方滚入 —— 圆填满的
 *     那一刻，文字已经在深色底上，不会出现半程可读性差的中间态
 *   - 指针离开时圆缩回 0，文字反向滚回
 *
 * 与上游的差异（都是按本平台的设计系统改的，不是简化）：
 *   1) 配色全部走 src/styles/tokens.css 的 token：
 *      主色 --primary #4EA8FF、选中底 --fill-active、
 *      科技光效色 --glow-cyan #5DE4FF（规范 §1.2 允许它出现在导航当前项）。
 *      上游的 baseColor / pillColor / hoveredPillTextColor 三个 props 因此不再需要。
 *   2) 规范 §4 要求「选中态同时有底色或边线、文字变化，不能仅变色」，
 *      所以当前项有三重标记：--fill-active 底色 + 2px 主色底线 + 主色圆点。
 *   3) 规范 §11「普通 Panel 不发光」：填色圆用实心 #5DE4FF，不加外发光、不加光晕。
 *   4) 规范 §4：导航图标默认 20px（这里 18px 以适配 85px 顶栏的两行布局）。
 *   5) 无障碍：当前项给 aria-current="page"，键盘焦点有 2px 焦点环
 *      （--mumai-focus，规范 §4）；滚入的那一份内容 aria-hidden，
 *      屏幕阅读器只会读到一次标签。
 *   6) prefers-reduced-motion: reduce 时不跑动画，改为静态悬停底色
 *      （规范 §6.2 / 评审 V13「检查展开、加载、失败、降级与减少动态效果」）。
 *
 * 用法（顶栏）：items 由 design.ts 的 NAV_ITEMS 映射而来，
 * activeKey 为当前页面的 key，renderIcon 提供图标（会被渲染两份，
 * 一份在静止层、一份在滚入层，两份必须是同一枚图标）。
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { gsap } from "gsap";

export interface PillNavItem {
  /** 稳定标识（一次会话内不变），用作 React key */
  key: string;
  /** 药丸上的中文标签 */
  label: string;
  /** 图标。返回 null 表示这一项没有图标（窄屏会整列隐藏图标，不靠这里控制） */
  renderIcon?: () => ReactNode;
  /** 无障碍名称，默认用 label */
  ariaLabel?: string;
}

export interface PillNavProps {
  items: readonly PillNavItem[];
  /** 当前项 key */
  activeKey: string;
  /** 点击某一项 */
  onSelect: (item: PillNavItem) => void;
  /** 附加 className（顶栏用它挂定位与响应式规则） */
  className?: string;
  /** 导航本身的无障碍名称 */
  ariaLabel?: string;
}

/** 滚入动效的时长（秒）。0.32s 落在规范 §6.2 的 micro-interaction 档（180–260ms）附近 */
const DUR_FILL = 0.32;
const DUR_OUT = 0.22;

/** 指针进入时圆放大的倍数：1.2 保证圆完整包住药丸，四角不留缝 */
const FILL_SCALE = 1.2;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export default function PillNav({
  items,
  activeKey,
  onSelect,
  className,
  ariaLabel = "主导航",
}: PillNavProps) {
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const cleanups: Array<() => void> = [];

    /**
     * 建时间线。
     *
     * 每次都重新量药丸的宽高：中文标签宽度随角色权限（导航项数量）和父容器
     * media query（窄屏收窄 padding / 隐藏图标）变化，圆必须按**当前**尺寸算，
     * 否则窗口尺寸变化后圆会盖不满药丸，四角会漏出原来的底色。
     */
    function build() {
      cleanups.splice(0).forEach((fn) => fn());

      const pills = Array.from(root!.querySelectorAll<HTMLElement>(".mumai-pill"));
      const reduced = prefersReducedMotion();

      for (const pill of pills) {
        const circle = pill.querySelector<HTMLElement>(".mumai-pill-circle");
        const stack = pill.querySelector<HTMLElement>(".mumai-pill-stack");
        const roll = pill.querySelector<HTMLElement>(".mumai-pill-roll");
        if (!circle || !stack || !roll) continue;

        const width = pill.offsetWidth;
        const height = pill.offsetHeight;
        if (width === 0 || height === 0) continue;

        /*
          圆盖住一枚 w×h 的药丸，需要多大的半径？
          设圆心在药丸底边中点下方 d 处、半径为 R，圆过药丸的左上角：
            R² = (w/2)² + (h − d)²  且  R = d
          解得 R = ((w/2)² + h²) / (2h)，也就是上游那行公式。
          圆用 left:50% + bottom:−delta 定位，delta 是圆心落在底边之下的距离，
          于是圆心正好在底边中点下方 R 处。
        */
        const radius = (width * width) / 4 / (2 * height) + height / 2;
        const diameter = Math.ceil(2 * radius) + 2;
        const delta = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - (width * width) / 4))) + 1;

        circle.style.width = `${diameter}px`;
        circle.style.height = `${diameter}px`;
        circle.style.bottom = `-${delta}px`;

        /** 文字整体上移一个药丸高 + 8px（规范 §4 的图标—标签间距也是 8px） */
        const shift = height + 8;

        if (reduced) {
          // 不跑动画：圆留在 0 缩放，悬停/选中的变化全部交给 CSS 静态态
          gsap.set(circle, { xPercent: -50, scale: 0, transformOrigin: "50% 100%" });
          gsap.set(stack, { y: 0, opacity: 1 });
          gsap.set(roll, { y: shift, opacity: 0 });
          continue;
        }

        gsap.set(circle, {
          xPercent: -50,
          scale: 0,
          transformOrigin: `50% ${diameter - delta}px`,
        });
        gsap.set(stack, { y: 0, opacity: 1 });
        gsap.set(roll, { y: shift, opacity: 0 });

        const tl = gsap.timeline({ paused: true });
        /*
           时间线上所有 tween 都带 overwrite: "auto" —— 上游的做法。
           tweenTo 会不断新建 tween，没有 overwrite 时新旧两段会同时写同一批
           属性，快速划过一排药丸就会出现「圆只填了一半」的残影。
        */
        tl.to(circle, { scale: FILL_SCALE, duration: DUR_FILL, ease: "power3.out", overwrite: "auto" }, 0);
        tl.to(stack, { y: -shift, opacity: 0, duration: DUR_FILL * 0.6, ease: "power3.out", overwrite: "auto" }, 0);
        // 三件事各占时间线的不同区段，整条线走完（tweenTo 到 duration）就是填满态
        tl.to(roll, { y: 0, opacity: 1, duration: DUR_FILL * 0.66, ease: "power3.out", overwrite: "auto" }, DUR_FILL * 0.34);
        // 反向走到底时圆必须精确回到 0：中途改变窗口尺寸会让量出来的 scale 留下残值
        tl.eventCallback("onReverseComplete", () => {
          gsap.set(circle, { scale: 0 });
        });

        let tween: gsap.core.Tween | null = null;

        const enter = () => {
          /*
             键盘焦点也走同一条动效：焦点落在药丸上时把圆填满，
             否则纯键盘操作只能靠 2px 焦点环辨认，和鼠标悬停的反馈不一致。
          */
          tween?.kill();
          tween = tl.tweenTo(tl.duration(), { duration: DUR_FILL, ease: "power3.out", overwrite: "auto" });
        };
        const leave = () => {
          tween?.kill();
          tween = tl.tweenTo(0, { duration: DUR_OUT, ease: "power3.out", overwrite: "auto" });
        };

        const onFocus = () => enter();
        const onBlur = () => leave();

        pill.addEventListener("pointerenter", enter);
        pill.addEventListener("pointerleave", leave);
        // 捕获阶段监听：focus 不冒泡，药丸内部元素拿到焦点时也算这一项
        pill.addEventListener("focus", onFocus, true);
        pill.addEventListener("blur", onBlur, true);

        cleanups.push(() => {
          pill.removeEventListener("pointerenter", enter);
          pill.removeEventListener("pointerleave", leave);
          pill.removeEventListener("focus", onFocus, true);
          pill.removeEventListener("blur", onBlur, true);
          tween?.kill();
          tl.kill();
        });
      }
    }

    build();

    /*
       只在宽度真正变化时重建：字体加载完成、角色权限变化（导航项数量变了）
       都会让药丸宽度变，重建后圆才盖得满。高度变化不重建（避免悬停时抖动）。
    */
    let lastWidth = 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      build();
    });
    observer.observe(root);

    // 自托管字体会在首帧之后才生效，中文标签宽度会跳一次，那时必须重新量
    document.fonts?.ready.then(build).catch(() => {});

    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMotionChange = () => build();
    media?.addEventListener?.("change", onMotionChange);

    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", onMotionChange);
      cleanups.splice(0).forEach((fn) => fn());
    };
  }, [items, activeKey]);

  return (
    <nav className={className} ref={containerRef} aria-label={ariaLabel}>
      <ul className="mumai-pill-list">
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <li key={item.key}>
              <button
                type="button"
                className={`mumai-pill${active ? " is-active" : ""}`}
                onClick={() => onSelect(item)}
                aria-current={active ? "page" : undefined}
                aria-label={item.ariaLabel ?? item.label}>
                {/* 填色圆：由 useEffect 按药丸实测尺寸摆位并驱动 */}
                <span className="mumai-pill-circle" aria-hidden="true" />
                {/* 静止层：默认可见，悬停时整层向上滚出 */}
                <span className="mumai-pill-stack mumai-pill-up">
                  {item.renderIcon?.()}
                  {item.label}
                </span>
                {/*
                  滚入层：与静止层同内容，初始位于药丸下方（aria-hidden）。
                  药丸有 overflow:hidden，未悬停时它不可见、也不撑宽药丸。
                */}
                <span className="mumai-pill-stack mumai-pill-roll" aria-hidden="true">
                  {item.renderIcon?.()}
                  {item.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
