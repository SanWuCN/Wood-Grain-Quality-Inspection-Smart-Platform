/**
 * 总览页图表（ECharts）
 *
 * 四个面板各有一张图，全部按规范 §5.1 出图：
 *   · 调色板只用 `design.ts` 的 `CHART.palette`（蓝 #4EA8FF / 青 #5DE4FF 为主，
 *     绿/黄/红只在**语义**需要时出现 —— 这里是状态分布、通道状态、风险关闭率，
 *     都属于规范 §1.3 的业务状态，不是装饰色）
 *   · Grid `rgba(130,180,230,.08)`、轴文字 #647990、Tooltip 深底 #0B1726
 *     + 边框 rgba(78,168,255,.25) —— 禁止白底 Tooltip
 *   · 单图主色系列不超过 3 种
 *
 * 为什么不复用 `src/components/chart.tsx`：
 * 那一个在挂载瞬间就 `echarts.init`，而总览页的面板是浮层，首帧尺寸可能还是 0
 * （`useDebounceEffect` 里 `size?.width !== 0` 那个守卫在 0 尺寸时拿不到正确宽高，
 * 图会画成 0×0 再也长不回来）。这里用 ResizeObserver 在**拿到真实尺寸之后**才 init，
 * 并且每次尺寸变化都 resize。
 *
 * 组件只负责「挂实例 + 跟着尺寸走」，option 由调用方给 —— 图表语义留在页面里，
 * 换图不用动这个文件。共用的配色/Tooltip 基底在 `overview.constants.ts`
 * 的 `CHART_BASE`（本文件只导出组件，才能满足 react-refresh 的
 * `only-export-components`）。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { CHART_ANIMATION_DELAY_MS } from "./useEntranceSettled";

/* 只注册用到的模块：整包 echarts 会明显拖慢总览页首屏 */
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/**
 * 给 option 装上动画参数。
 *
 * `animate=false` 时把 animation 全关（含数据更新动画）：用于「入场已经结束
 * 才挂上来的图」，此时再长一遍会让页面看起来在抽搐。
 */
function optionFor(option: echarts.EChartsCoreOption, animate: boolean): echarts.EChartsCoreOption {
  return {
    ...option,
    animation: animate,
    animationDuration: 900,
    animationEasing: "cubicOut",
    animationDelay: (index: number) => CHART_ANIMATION_DELAY_MS + index * 40,
  };
}

export default function Chart({
  option,
  className,
  ariaLabel,
  animate = true,
}: {
  option: echarts.EChartsCoreOption;
  className?: string;
  /** 图表是「一眼看懂」的图形，仍然给屏幕阅读器一句话说明 */
  ariaLabel?: string;
  /**
   * 是否播放入场动画。
   *
   * 默认开启，由调用方在**面板入场动画播完之后**才置为 true
   * （见 `useEntranceSettled`）：扇区/柱子在面板还没滑到位时就长出来，
   * 看起来像页面在抽搐。关掉时直接以终态呈现（减少动效偏好也走这条）。
   */
  animate?: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const instance = useRef<echarts.EChartsType | null>(null);
  /** 最新一份 option：实例晚于 effect 建起来时用它补画（见下面 init 分支的注释） */
  const latest = useRef<echarts.EChartsCoreOption>(option);
  const animateRef = useRef(animate);
  animateRef.current = animate;

  useEffect(() => {
    const node = box.current;
    if (!node) return;

    let frame = 0;

    /*
     * 首次拿到非零尺寸时才 init（浮层在布局完成前 contentRect 是 0×0，
     * 那时 init 出来的实例会一直是 0 宽 0 高，后面再也长不回来）；
     * 之后每次尺寸变化只 resize —— 用 setOption 重建实例会让面板闪一下。
     *
     * init 之后**必须立刻补一次 setOption**：本组件是懒加载路由里的浮层，
     * ResizeObserver 的首次回调通常晚于 React 的 effect，那时 `[option]`
     * 那个 effect 早就跑过了（当时实例还不存在）。只靠那个 effect，
     * 实例会一直空着 —— 现象就是容器有尺寸、里面一个 canvas 都没有。
     */
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      if (!instance.current) {
        instance.current = echarts.init(node, undefined, { renderer: "canvas" });
        /* 建实例时按当前状态决定要不要动画：入场已经播完的就直接终态 */
        instance.current.setOption(optionFor(latest.current, animateRef.current), { notMerge: true });
        return;
      }
      /* resize 合并到下一帧：面板高度由 grid 轨道算出，连续触发时只画一次 */
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => instance.current?.resize());
    });
    observer.observe(node);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, []);

  /* 实例已存在时，option 变化走这里；实例还没起来就只更新 ref，等 init 时补画 */
  useEffect(() => {
    latest.current = option;
    instance.current?.setOption(optionFor(option, animate), { notMerge: true, lazyUpdate: true });
  }, [option, animate]);

  return <div ref={box} className={className} role="img" aria-label={ariaLabel} />;
}
