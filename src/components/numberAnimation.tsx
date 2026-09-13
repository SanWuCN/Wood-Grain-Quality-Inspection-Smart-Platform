/**
 * 数字变化动效（ReactBits Counter 口径）
 *
 * 视觉来源：https://www.reactbits.dev/components/counter —— 数字出现时从起始值
 * 「滚」到目标值；之后每次值变化，都从**当前屏幕上的那个数**继续滚到新值，
 * 而不是重新从 0 数一遍。
 *
 * 谁该用它
 * --------
 * 平台里凡是「会变的数」都走这里：实时轮询指标（GPU / 内存 / 网络 / 功耗）、
 * 进度百分比、传感器读数、计数与 KPI。**定值常量、编号、日期、设备 ID 不要用** ——
 * 它们本来就不会变，滚动只会变成噪音。
 *
 * 三条硬约束（出自 `docs/验收-总览四窗口与平台数据-v1.0.md`）
 * ----------------------------------------------------------
 *   · ANI-07 连续收到指标推送只做短平滑更新，不触发面板 / 图表重新入场
 *     → 本组件没有「重新入场」这种状态：它只改自己那一个文本节点。默认时长
 *       0.8s 短于 2s 轮询间隔，所以永远在上一次补间结束后才开始下一段。
 *   · ANI-10 开启「减少动态效果」时所有有效数字直接呈现最终状态
 *     → prefers-reduced-motion 命中时只写终值，一帧都不插值。
 *   · ANI-13 页面在后台停留后返回，先刷新快照，不追赶播放后台漏掉的动画
 *     → 切到后台立刻把在跑的补间杀掉并落到当前值；回到前台看到的就是最新快照。
 *
 * 为什么用 textContent 直接写、而不是 setState
 * --------------------------------------------
 * 一屏上可能同时有几十个数字在滚，每帧 setState 就是每帧几十次 React 渲染，
 * 而总览页本来就在 2s 轮询 + 三维地图的压力下。这里只改自己那一个文本节点的
 * 文本，不进 React 的更新队列。代价是组件不再「受控」于 React 的文本 ——
 * 因此渲染出来的固定子节点是占位符，真正的数字一律由 effect 写入；
 * 占位符永远不会变，React 也就不会去覆盖我们写进去的值。
 *
 * 用法
 * ----
 *   <NumberAnimation value={summary.gpuBasePercent} digits={0} suffix="%" />
 *   <NumberAnimation value={item.received} /> /
 *   <NumberAnimation value={bytes} format={bytesPerSec} />
 *   <NumberAnimation value={n} active={ready} />      // 等面板入场后再数
 *   <NumberAnimation value={n ?? null} />             // 空值 → 显示「—」
 */

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { gsap } from "gsap";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

/** 数字格式化的默认区域：与平台其它地方的 `toLocaleString("zh-CN")` 一致 */
const LOCALE = "zh-CN";
/** 入场计数时长。ANI-14「常规尾段 ≤900ms」，取 0.8s */
const DEFAULT_DURATION = 0.8;
/**
 * 空值占位。平台统一用「—」表示「未采集 / 未提供」，
 * **不用 0 冒充**有效样本（PRD §9.5 / §10.3）。
 */
const DEFAULT_FALLBACK = "—";

export interface NumberAnimationProps {
  /** 目标值。null / undefined / NaN 一律渲染成 `fallback`，不参与插值 */
  value: number | null | undefined;

  /** 本段补间时长（秒）。默认 0.8s；传 0 就是「直接落值」 */
  duration?: number;
  /** 本段补间延迟（秒） */
  delay?: number;

  /* ---- 格式化：三种写法按优先级从高到低 ---- */
  /** 完全自定义：拿一个数返回一段文本（单位、换算、档位都能自己管） */
  format?: (value: number) => string;
  /**
   * 固定小数位。与 `options` 同时给时以 `digits` 为准。
   *
   * ⚠️ 它走 `Intl.NumberFormat` 的 `minimum/maximumFractionDigits`，
   * **不保证与 `Number.prototype.toFixed` 逐位相同**：`(87.05).toFixed(1)` 得
   * `"87.0"`（该 double 实际略小于 87.05），而 Intl 会给 `"87.1"`。
   * 绝大多数取值两者一致，但**原来用 `toFixed` 渲染、且值可能正好压在半个刻度上**
   * 的调用点（覆盖率、得分这类百分比最典型）应当把原函数直接交给 `format=`
   * （例：`format={formatCoverage}`），才能保证文本逐字节不变。
   */
  digits?: number;
  /** 前缀 / 后缀（单位、箭头）。后缀写在数字之外，滚动时不会跟着变 */
  prefix?: string;
  suffix?: string;
  /**
   * 千分位。默认开（`1,234`），与平台「数量使用千位分隔」的口径一致。
   *
   * **量测值要显式关掉**：毫秒、秒、GiB、% 这类读数的原文本本来就没有分隔符，
   * 开了会把 `离线 1200s` 变成 `离线 1,200s`（多一个字符，可能撑破被裁剪的行）。
   * 判据很简单 —— 原来的表达式有没有逗号：`{x}` / `String(x)` / `x.toFixed(n)`
   * 都没有，只有 `toLocaleString()` 才有。序号、编号同理按 `group={false}` 处理。
   */
  group?: boolean;
  /** Intl.NumberFormat 选项（兼容旧调用点） */
  options?: Intl.NumberFormatOptions;

  /** 入场起点，默认 0（ReactBits 的「从 0 数上去」） */
  from?: number;

  /** 空值占位，默认「—」 */
  fallback?: string;

  /**
   * 入场门控。false 时停在起始值不动（面板还没入场），转 true 才开始计数。
   * 与 `useEntranceSettled` 配合，保证数字随面板出现，而不是在地图开场时就播完。
   */
  active?: boolean;

  className?: string;
  style?: CSSProperties;
}

/** 参与格式化的那部分配置，统一打包以便存进 ref */
type FormatterConfig = {
  format?: (value: number) => string;
  options?: Intl.NumberFormatOptions;
  digits?: number;
  group?: boolean;
  prefix: string;
  suffix: string;
};

/**
 * 生成格式化器。
 *
 * 关键点：**滚动过程中的每一帧和最终落值走的是同一个格式化器**，
 * 所以小数位、千分位、单位不会在动画中途跳变。
 *
 * `sample` 只用来决定「没有显式指定小数位时保留几位」：目标值是整数就按整数滚，
 * 是小数就保留两位。
 */
function createFormatter(config: FormatterConfig, sample: number): (value: number) => string {
  const { format, options, digits, group, prefix, suffix } = config;
  if (format) return format;

  const minimumFractionDigits = digits ?? options?.minimumFractionDigits;
  /**
   * `maximumFractionDigits` 必须 ≥ `minimumFractionDigits`，否则 Intl 直接抛
   * RangeError。调用点只写 `{ minimumFractionDigits: 2 }` 时这里补上 2。
   */
  const maximumFractionDigits = Math.max(
    minimumFractionDigits ?? 0,
    digits ?? options?.maximumFractionDigits ?? (Number.isInteger(sample) ? 0 : 2),
  );

  const formatter = new Intl.NumberFormat(LOCALE, {
    ...options,
    minimumFractionDigits,
    maximumFractionDigits,
    useGrouping: group ?? options?.useGrouping ?? true,
  });

  return (value) => `${prefix}${formatter.format(value)}${suffix}`;
}

export default function NumberAnimation({
  value,
  duration = DEFAULT_DURATION,
  delay,
  format,
  digits,
  prefix = "",
  suffix = "",
  group,
  options,
  from = 0,
  fallback = DEFAULT_FALLBACK,
  active = true,
  className,
  style,
}: NumberAnimationProps) {
  const reducedMotion = usePrefersReducedMotion();

  const hostRef = useRef<HTMLSpanElement>(null);
  /** 当前屏幕上的值：下一段补间从它出发，连续推送才不会重数 */
  const shownRef = useRef(from);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  /** 是否已经播过入场计数：只有第一次是从 `from` 数到目标值 */
  const enteredRef = useRef(false);

  /**
   * `format` / `options` 常常是内联字面量，每次渲染都是新对象。存进 ref 里读，
   * 它们就不会出现在下面 effect 的依赖上——否则每次渲染都会杀掉补间、从头再来。
   */
  const configRef = useRef<FormatterConfig>({ format, options, digits, group, prefix, suffix });
  /** 最新一次渲染拿到的格式化器与目标值，供 visibilitychange 直接落值用 */
  const formatterRef = useRef<((value: number) => string) | null>(null);
  /** 最新目标值。放 ref 里是为了让下面那个 visibilitychange effect 不必依赖 value ——
   *  否则每来一份新快照都要解绑再绑一次监听（2s 轮询下就是每 2s 一次无谓的增删）。 */
  const valueRef = useRef<number | null>(null);

  const finite = typeof value === "number" && Number.isFinite(value);

  /* 先同步配置，下面那个动画 effect 才读得到本次渲染的最新配置 */
  useLayoutEffect(() => {
    configRef.current = { format, options, digits, group, prefix, suffix };
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    tweenRef.current?.kill();
    tweenRef.current = null;

    /* 空值：写占位，但保留 `shownRef` —— 数据回来时从上次的位置接着滚，不从 0 重来 */
    if (!finite) {
      formatterRef.current = null;
      valueRef.current = null;
      host.textContent = fallback;
      return;
    }

    const config = configRef.current;
    const formatter = createFormatter(config, value);
    formatterRef.current = formatter;
    valueRef.current = value;

    /* 面板还没入场：停在起始值，等门控放行（数字随面板出现，不提前播完） */
    if (!active) {
      enteredRef.current = false;
      shownRef.current = from;
      host.textContent = createFormatter(config, from)(from);
      return;
    }

    if (!enteredRef.current) {
      enteredRef.current = true;
      shownRef.current = from;
    }

    /* 减少动态效果 / 页面在后台：直接落终值，不插值（ANI-10 / ANI-13） */
    if (reducedMotion || (typeof document !== "undefined" && document.hidden)) {
      shownRef.current = value;
      host.textContent = formatter(value);
      return;
    }

    /* 目标没变（例如只改了小数位）：直接按新格式重写，不起补间 */
    if (Math.abs(shownRef.current - value) < 1e-9) {
      shownRef.current = value;
      host.textContent = formatter(value);
      return;
    }

    const proxy = { current: shownRef.current };
    tweenRef.current = gsap.to(proxy, {
      current: value,
      duration,
      delay: delay ?? 0,
      ease: "power2.out",
      onUpdate: () => {
        shownRef.current = proxy.current;
        host.textContent = formatter(proxy.current);
      },
      onComplete: () => {
        /* 落值必须精确：补间最后一帧的浮点数不一定等于目标值 */
        shownRef.current = value;
        host.textContent = formatter(value);
        tweenRef.current = null;
      },
    });
  }, [value, finite, active, duration, delay, from, fallback, reducedMotion, digits, group, prefix, suffix]);

  /* 卸载时杀掉补间，避免回调打在已经摘掉的节点上 */
  useLayoutEffect(
    () => () => {
      tweenRef.current?.kill();
      tweenRef.current = null;
    },
    [],
  );

  /**
   * ANI-13：页面切到后台时，GSAP 的 rAF 会被浏览器暂停，补间会在回到前台那一刻
   * 「补播」后台漏掉的过程 —— 那正是验收里点名不要的行为。这里在隐藏的瞬间就把
   * 补间杀掉并落到最新值。
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) return;
      const host = hostRef.current;
      if (!host) return;
      tweenRef.current?.kill();
      tweenRef.current = null;
      const formatter = formatterRef.current;
      const latest = valueRef.current;
      if (formatter && latest !== null) {
        shownRef.current = latest;
        host.textContent = formatter(latest);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return (
    <span
      ref={hostRef}
      className={className}
      /**
       * 只用 data 属性、不加 class：全局 `.num` 那条规则会顺手改字体与字距，
       * 挂上去会悄悄改变既有版式。这个属性不参与任何样式，只给
       * `tools/shot.mjs` 一类的验收探针一个稳定选择器 ——
       * `document.querySelectorAll('[data-number-animation]')` 就是页面上全部动效数字。
       */
      data-number-animation=""
      /* 等宽数字：滚动过程中宽度不抖，右对齐的数字列不会左右晃 */
      style={{ fontVariantNumeric: "tabular-nums", ...style }}>
      {/* 固定占位：真正的数字由 effect 写入，React 不会来覆盖它 */}
      {fallback}
    </span>
  );
}
