/**
 * 木脉智检 · 药丸导航（PillNav）
 *
 * 交互取自 React Bits 的 PillNav（https://www.reactbits.dev/components/pill-nav）：
 *   - 每个导航项是一枚药丸，圆角 9999px
 *   - 指针进入时，从药丸**底边中点**长出一个圆（圆的半径由药丸的宽高算出来，
 *     保证填满后完整覆盖整枚药丸），把药丸底色换成高亮底
 *   - 同时把「图标 + 文字」整体向上滚出，另一份同内容从下方滚入
 *   - 指针离开时圆缩回 0，文字反向滚回
 *
 * 与上游的差异（都是按本平台的设计系统改的，不是简化）：
 *   1) 配色全部走 src/styles/tokens.css 的 token：
 *      高亮底是 --glow-cyan 的 14% 淡青，文字 --text-primary，
 *      图标 --mumai-icon-accent（与当前项同一套取色）；
 *      当前项用 --fill-active 底 + --border-active 边 + 2px --primary 底线。
 *      上游的 baseColor / pillColor / hoveredPillTextColor 三个 props 因此不再需要。
 *      上游是**实心亮色填充 + 深色文字**，在这里太跳（评审口径：普通交互不发光、
 *      减少彩色），所以改成同一色系的淡底 + 亮字，动效不变、音量降一档。
 *   2) 规范 §4 要求「选中态同时有底色或边线、文字变化，不能仅变色」，
 *      所以当前项有三重标记：--fill-active 底色 + 2px 主色底线 + 主色圆点。
 *   3) 圆的最终缩放是 1 而不是上游的 1.2：顶栏两行贴得很紧，
 *      多出来的 20% 会把圆顶到左上角字标上去（见 FILL_SCALE 的注释）。
 *   4) 规范 §4：导航图标默认 20px（这里 16px 以适配 85px 顶栏的两行布局）。
 *   5) 无障碍：当前项给 aria-current="page"，键盘焦点有 2px 焦点环
 *      （--mumai-focus，规范 §4）；滚入的那一份内容 aria-hidden，
 *      屏幕阅读器只会读到一次标签。
 *   6) prefers-reduced-motion: reduce 时不跑动画，改为静态悬停底色
 *      （规范 §6.2 / 评审 V13「检查展开、加载、失败、降级与减少动态效果」）。
 *   7) 抗卡死：高亮态由 is-hot 类与 hotPills 标记共同维护，
 *      enter / leave 幂等，指针离开整条导航或窗口失焦时统一收尾 ——
 *      手快速划过一排药丸不会再留下「填满但不该填」的圆。
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
/** 文字与图标换色：比圆的位移快，手快速划过时颜色不会慢半拍 */
const DUR_TINT = 0.12;

/**
 * 圆的最终缩放。
 *
 * 上游用 1.2：多出来的 20% 会让圆**冲出药丸**，视觉上比药丸高约 8px。
 * 在这里不行 —— 顶栏两行贴得很紧（药丸顶边 y=39，左上角字标底边 y=40），
 * 圆一涨就把「木脉智检」压掉一块。
 * 半径公式本身已经让圆刚好过药丸的四个角，所以 1 就够；
 * 再加下面那 4px 直径余量，圆覆盖整个药丸而完全落在药丸内部（药丸 overflow: clip）。
 */
const FILL_SCALE = 1;

/**
 * 药丸 → 它的高亮 / 收起控制函数。
 *
 * 放在模块级而不是组件里：顶栏整条导航只挂一个 PillNav 实例，
 * 这张表让「指针离开整条导航」这类收尾逻辑能一次把所有药丸落回常态，
 * 不需要在 DOM 上挂自定义属性。
 */
const PILL_CONTROL = new WeakMap<HTMLElement, { enter: () => void; leave: () => void }>();

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
     * 当前处于「高亮态」的药丸（指针在上面，或键盘焦点在它上面）。
     *
     * 两个用途：
     *   1) 重算时跳过它 —— 悬停中重建时间线会把正在播的圆清零，那一枚就永远填不回来
     *   2) 换向时按它判断该往哪边走，避免重复触发同一方向的补间
     */
    const hotPills = new WeakSet<HTMLElement>();

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
        /*
          +4 而不是上游的 +2：这 4px 全部落在药丸**以内**（圆的底边也从 delta 再往里收，
          药丸本身还有 1px 边框），所以圆放大到 FILL_SCALE 时刚好齐平药丸边界 ——
          既盖满整枚药丸，又不会有一丝一毫溢到药丸外面去压住字标。
        */
        const diameter = Math.ceil(2 * radius) + 4;
        const delta = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - (width * width) / 4))) + 1;

        circle.style.width = `${diameter}px`;
        circle.style.height = `${diameter}px`;
        circle.style.bottom = `-${delta}px`;

        /** 文字整体上移一个药丸高 + 8px（规范 §4 的图标—标签间距也是 8px） */
        const shift = height + 8;

        /** 圆与文字/图标的终态色：进入补间与「直接落位」两条路径共用同一份定义 */
        const HOT_COLOR = "var(--text-primary)";

        /** 滚入层压在淡青圆上，用最亮的文字色 —— 与 CSS 的 .is-hot 规则一致 */
        const setColor = (isHot: boolean) => {
          if (isHot) gsap.set([pill, roll], { color: HOT_COLOR });
          else gsap.set([pill, roll], { clearProps: "color" });
        };

        const land = (isHot: boolean) => {
          gsap.set(circle, { scale: isHot ? FILL_SCALE : 0 });
          gsap.set(stack, { y: isHot ? -shift : 0, opacity: isHot ? 0 : 1 });
          gsap.set(roll, { y: isHot ? 0 : shift, opacity: isHot ? 1 : 0 });
          setColor(isHot);
        };

        if (reduced) {
          /*
            不跑动画：圆留在 0 缩放，颜色变化交给 CSS 的悬停静态态，
            因此这里连 color 都不写，只把两层内容摆回基准位置。
          */
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

        const tl = gsap.timeline({ paused: true });
        /*
           时间线上所有 tween 都带 overwrite: "auto" —— 上游的做法。
           tweenTo 会不断新建 tween，没有 overwrite 时新旧两段会同时写同一批
           属性，快速划过一排药丸就会出现「圆只填了一半」的残影。
        */
        tl.to(circle, { scale: FILL_SCALE, duration: DUR_FILL, ease: "power3.out", overwrite: "auto" }, 0);
        tl.to(stack, { y: -shift, opacity: 0, duration: DUR_FILL * 0.6, ease: "power3.out", overwrite: "auto" }, 0);
        // 文字与图标换色：文字色比圆的位移快，视觉上「一进来就亮」
        tl.to(pill, { color: HOT_COLOR, duration: DUR_TINT, ease: "power2.out", overwrite: "auto" }, 0);
        /*
           滚入的那一份在圆填到一半时进场（0.34 处）。它自己的颜色由 CSS 给定
           （.mumai-pill.is-hot .mumai-pill-roll → --text-primary），
           这里不重复写，避免两处各说一套。
        */
        tl.to(roll, { y: 0, opacity: 1, duration: DUR_FILL * 0.66, ease: "power3.out", overwrite: "auto" }, DUR_FILL * 0.34);

        let tween: gsap.core.Tween | null = null;
        let hot = false;

        /**
         * 高亮 / 收起。
         *
         * hot 这个标记是**防卡死的关键**：pointerenter 与 pointerleave
         * 可以在同一帧里前后脚到（手快速划过一排药丸、指针在边界抖动），
         * 这时 tweenTo 建出来的补间还没跑第一帧就被下一次调用 kill 掉，
         * 元素就停在「圆填了一半」或「圆填满了但指针已经走了」的状态上不动了。
         * 有了标记，离开时只在**确实处于高亮态**才反向；万一反向补间也被打断，
         * 下面 leave 里的 land(false) 直接落位，不会再留残影。
         */
        const setHot = (next: boolean) => {
          if (next === hot) return;
          hot = next;
          if (next) hotPills.add(pill);
          else hotPills.delete(pill);

          pill.classList.toggle("is-hot", next);
          tween?.kill();

          if (goInstant) {
            land(next);
            return;
          }

          if (next) {
            tween = tl.tweenTo(tl.duration(), { duration: DUR_FILL, ease: "power3.out", overwrite: "auto" });
          } else {
            tween = tl.tweenTo(0, {
              duration: DUR_OUT,
              ease: "power3.out",
              overwrite: "auto",
              onComplete: () => {
                // 反向走完把圆精确归零（中途改变窗口尺寸会留下残值），并撤掉内联文字色
                gsap.set(circle, { scale: 0 });
                setColor(false);
              },
            });
          }
        };

        /** 重建时正在高亮的药丸要按**终态**摆好，不能被清零 */
        const goInstant = hotPills.has(pill);
        land(goInstant);

        const onEnter = () => setHot(true);
        const onLeave = () => setHot(false);

        PILL_CONTROL.set(pill, { enter: onEnter, leave: onLeave });

        pill.addEventListener("pointerenter", onEnter);
        pill.addEventListener("pointerleave", onLeave);
        // 捕获阶段监听：focus 不冒泡，药丸内部元素拿到焦点时也算这一项
        pill.addEventListener("focus", onEnter, true);
        pill.addEventListener("blur", onLeave, true);

        cleanups.push(() => {
          pill.removeEventListener("pointerenter", onEnter);
          pill.removeEventListener("pointerleave", onLeave);
          pill.removeEventListener("focus", onEnter, true);
          pill.removeEventListener("blur", onLeave, true);
          PILL_CONTROL.delete(pill);
          tween?.kill();
          tl.kill();
        });
      }
    }

    build();

    /*
       兜底：指针离开整条导航时，把所有药丸强制落回常态。
       指针事件丢一个（切窗口、系统弹窗、鼠标移出浏览器）就可能留下一个
       「填满但不该填」的圆，这条收尾保证界面不会卡在那个状态。
    */
    const onRootLeave = () => {
      for (const pill of Array.from(root.querySelectorAll<HTMLElement>(".mumai-pill"))) {
        PILL_CONTROL.get(pill)?.leave();
      }
    };
    root.addEventListener("pointerleave", onRootLeave);
    window.addEventListener("blur", onRootLeave);

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
      root.removeEventListener("pointerleave", onRootLeave);
      window.removeEventListener("blur", onRootLeave);
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
