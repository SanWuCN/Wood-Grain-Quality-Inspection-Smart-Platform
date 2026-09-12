/**
 * 知识库 · ECharts 薄封装
 *
 * 只做三件事：初始化、setOption、跟随容器尺寸 resize、卸载时 dispose。
 * 不引第三方 wrapper，避免给项目加依赖。
 *
 * 规范 §5.1：本模块的图表一律用「蓝 + 青」为主色，网格 / 坐标轴文字 / Tooltip
 * 全部走 knowledge/constants.ts 的 KB_CHART（与 tokens.css 同值），禁止白底 Tooltip。
 */

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export function EChart({
  option,
  height,
  onPick,
  className = "",
}: {
  /** ECharts option（每次变更都会 setOption） */
  option: Record<string, unknown>;
  /** 像素高度；不传则由 CSS 撑满父容器 */
  height?: number;
  /** 点选回调：把 seriesName / dataIndex 交回页面 */
  onPick?: (seriesName: string, dataIndex: number) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // StrictMode 下 effect 会跑两次：同一个 DOM 节点上不能 init 两个实例，
    // 否则第 2 个实例拿不到内部 scheduler，resize 时会抛 dataTask 未定义。
    const existing = echarts.getInstanceByDom(element);
    const instance = existing ?? echarts.init(element, undefined, { renderer: "canvas" });
    chart.current = instance;
    let disposed = false;

    /**
     * 容器尺寸变化 → 下一帧再 resize。
     *
     * 不能在 ResizeObserver 回调里直接调 chart.resize()：ECharts 的 resize 会
     * 同步改画布尺寸与内部布局，等于在观察回调里制造新布局，浏览器会把
     * 「布局 → 观察回调 → 布局」循环打到上限并冻结整页。交给 rAF 合并一次即可。
     */
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) instance.resize();
      });
    });
    observer.observe(element);

    instance.on("click", (params: unknown) => {
      const payload = params as { seriesName?: string; dataIndex?: number };
      pickRef.current?.(payload.seriesName ?? "", payload.dataIndex ?? -1);
    });

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  const memoOption = useMemo(() => option, [option]);

  useEffect(() => {
    chart.current?.setOption(memoOption, { notMerge: true, lazyUpdate: true });
  }, [memoOption]);
  return <div ref={box} className={`kb-chart ${className}`} style={height ? { height } : undefined} />;
}
