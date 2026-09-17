/**
 * 训练曲线 · 纯逻辑（统计 / 发散判据 / ECharts option）
 *
 * ── 为什么单独一层 ────────────────────────────────────────────────
 * 「训练曲线」原先是一张手画的 SVG 折线：**没有纵轴刻度**（4 条网格线不标值）、
 * 横轴只写首末两个数字、鼠标放上去什么也读不到、图例不带当前值。评审看这张图
 * 没法回答最基本的问题 ——「第几轮降到多少、哪一轮开始不降了」。
 *
 * 现在拆两层：
 *   · 本文件：**纯函数** —— 统计量、发散判据、ECharts option 全在这里，能单测；
 *   · `TrainingRun.tsx` 的 `LossPanel`：只负责接线与文案。
 *
 * ── 口径（与种子同源，不许各写各的）────────────────────────────────
 *   · 「最优轮次」= 验证损失序列最低点的轮次（从数据算，不写死）；
 *   · 「早停」= 归档实验包声明的耐心值（`config` 里的 patience）与曲线对账：
 *     末轮 − 最优轮次 = 耐心 → 说明这条曲线正是按该规则停下来的；
 *   · 发散判据沿用原来的 0.02 容差：抬升不足 0.02 视为正常波动，不报过拟合。
 */

import type * as echarts from "echarts/core";
import { CHART } from "./design";
import { CHART_BASE } from "./pages/overview.constants";

export type CurvePoint = { x: number; y: number };

/** 一条曲线在当前已回放范围内的统计量 */
export type CurveStats = {
  /** 已回放的轮数 */
  epochs: number;
  first: number;
  last: number;
  min: number;
  /** 最低点所在轮次（从 1 数起） */
  minEpoch: number;
  /** 首轮 → 最低点的下降幅度（正数=降下来了） */
  drop: number;
  /** 末轮相对最低点的抬升（正数=已经不再下降） */
  riseFromMin: number;
};

export function curveStats(points: CurvePoint[]): CurveStats {
  if (points.length === 0) {
    return { epochs: 0, first: 0, last: 0, min: 0, minEpoch: 0, drop: 0, riseFromMin: 0 };
  }
  let minIndex = 0;
  points.forEach((point, index) => {
    if (point.y < points[minIndex].y) minIndex = index;
  });
  const first = points[0].y;
  const last = points[points.length - 1].y;
  const min = points[minIndex].y;
  return {
    epochs: points.length,
    first,
    last,
    min,
    minEpoch: points[minIndex].x,
    drop: first - min,
    riseFromMin: last - min,
  };
}

/**
 * 从验证损失序列里找出发散点。
 *
 * 剧本 S16 让架构师口播「训练误差下降、验证误差却持续上升，说明开始过拟合」——
 * 这句话要能从曲线上直接读出来，所以这里把最低点之后是否持续抬升算出来，
 * 而不是把结论写死在页面上：换成成功案例时这个提示自然就不出现。
 */
export function detectOverfit(val: number[]): { minEpoch: number; rise: number } | null {
  if (val.length < 3) return null;
  let minIndex = 0;
  val.forEach((value, index) => {
    if (value < val[minIndex]) minIndex = index;
  });
  const rise = val[val.length - 1] - val[minIndex];
  // 抬升不足 0.02 视为正常波动，不报发散
  if (minIndex >= val.length - 2 || rise < 0.02) return null;
  return { minEpoch: minIndex + 1, rise };
}

export type EarlyStop = {
  /** 曲线最低点所在轮次 */
  bestEpoch: number;
  /** 实际停止的轮次（= 曲线长度） */
  stopEpoch: number;
  /** 归档实验包声明的耐心值 */
  patience: number;
  /** 从最低点到停止经过了几轮 */
  roundsWithoutImprovement: number;
  /**
   * 曲线与声明规则是否对得上（末轮 − 最优 = 耐心）。
   *
   * 这一条是**自检**：种子里的曲线必须按早停规则生成，否则页面上「连续 6 轮不下降
   * 即停止」与曲线的最低点各说各话，现场数一遍格子就穿帮（踩过：最低点在 28/23 轮）。
   */
  consistent: boolean;
};

export function earlyStopOf(stats: CurveStats, patience: number): EarlyStop {
  const roundsWithoutImprovement = Math.max(0, stats.epochs - stats.minEpoch);
  return {
    bestEpoch: stats.minEpoch,
    stopEpoch: stats.epochs,
    patience,
    roundsWithoutImprovement,
    consistent: stats.epochs > 0 && roundsWithoutImprovement === patience,
  };
}

/** 从实验配置里取早停耐心（归档实验包里的真实配置项，不在页面上写死 6） */
export function patienceOf(config: { key: string; value: number }[]): number | null {
  const item = config.find((entry) => entry.key === "patience");
  return item && Number.isFinite(item.value) ? item.value : null;
}

export type LossSeries = { name: string; color: string; points: CurvePoint[] };

/** ECharts axis 触发时传给 formatter 的一条 */
type TipParam = { seriesName?: string; value?: unknown };

/**
 * Tooltip 文案（纯函数，便于单测）。
 *
 * 默认的 axis tooltip 只把每个系列的值堆在一起、横轴写 `15.00` —— 读起来像一串数字。
 * 这里改成一行读得懂的：「第 15 轮 · 候选 · 训练损失 0.320 · 候选 · 验证损失 0.439 · …」，
 * 用 ` · ` 分隔（而不是 `<br/>`）：分隔符在文本里也在，读屏与自动化都拿得到完整句子。
 */
export function lossTooltipText(params: TipParam | TipParam[]): string {
  const list = Array.isArray(params) ? params : [params];
  const epoch = Math.round(Number((list[0]?.value as number[] | undefined)?.[0] ?? 0));
  const rows = list
    .map((item) => {
      const value = Number((item.value as number[] | undefined)?.[1]);
      if (!Number.isFinite(value)) return null;
      return `${item.seriesName ?? "损失"} ${value.toFixed(3)}`;
    })
    .filter((row): row is string => row !== null);
  return [`第 ${epoch} 轮`, ...rows].join(" · ");
}

/**
 * 组装损失曲线的 ECharts option。
 *
 * 与总览页共用 `CHART_BASE`（配色 / Tooltip 外观 / 字体统一注入），
 * 这里只给坐标轴、图例、系列与两条标记线。
 *
 * `drawn` 是当前回放到第几轮：候选两条曲线按它截断（从左往右长），
 * 基线整条铺满 —— 基线是上一版跑完的历史记录，留着它才有对照物。
 * 标记线也跟着 `drawn` 走：回放还没到最优轮次时**不提前剧透**。
 */
export function buildLossOption({
  train,
  val,
  baseline,
  drawn,
  epochCount,
  bestEpoch,
  stopEpoch,
  threshold,
}: {
  train: LossSeries;
  val: LossSeries;
  baseline: LossSeries;
  drawn: number;
  epochCount: number;
  bestEpoch: number;
  stopEpoch: number;
  /** 判定阈值（可选）：画一条水平参考线 */
  threshold?: number;
}): echarts.EChartsCoreOption {
  const slice = (points: CurvePoint[]) => points.slice(0, Math.max(1, Math.min(drawn, points.length)));
  const growing = drawn < epochCount;
  const line = (series: LossSeries, points: CurvePoint[]) => ({
    name: series.name,
    type: "line" as const,
    /* 边跑边画时点太密会糊成一条带子：回放前期露点，跑满后只看线 */
    showSymbol: growing,
    symbolSize: 4,
    lineStyle: { width: 2 },
    itemStyle: { color: series.color },
    emphasis: { focus: "series" as const },
    data: points.map((point) => [point.x, point.y]),
    ...(series === val
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            label: { color: CHART.axisText, fontSize: 12, position: "insideEndTop" as const },
            data: [
              ...(drawn >= bestEpoch
                ? [
                    {
                      xAxis: bestEpoch,
                      lineStyle: { color: CHART.palette[2], type: "dashed" as const, width: 1 },
                      label: { formatter: `最优轮次 ${bestEpoch}` },
                    },
                  ]
                : []),
              ...(drawn >= stopEpoch
                ? [
                    {
                      xAxis: stopEpoch,
                      lineStyle: { color: CHART.axisText, type: "dotted" as const, width: 1 },
                      label: { formatter: `第 ${stopEpoch} 轮停止` },
                    },
                  ]
                : []),
            ],
          },
        }
      : {}),
  });

  return {
    ...CHART_BASE,
    grid: { left: 52, right: 22, top: 34, bottom: 26 },
    legend: {
      top: 0,
      right: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 3,
      itemGap: 14,
      textStyle: { color: CHART.axisText, fontSize: 12 },
    },
    tooltip: {
      ...(CHART_BASE.tooltip as object),
      trigger: "axis",
      /* 给自动化留一个稳定的落点：Tooltip 是画在 DOM 上的，E2E 直接读它的文字 */
      className: "tw-chart__tip",
      axisPointer: {
        type: "cross",
        /* 指针标签写「第 N 轮」而不是「15.00」 */
        label: { backgroundColor: "#12283f", formatter: (params: { value: number }) => `第 ${Math.round(params.value)} 轮` },
      },
      formatter: (params: TipParam | TipParam[]) => lossTooltipText(params),
      valueFormatter: (value: number) => (typeof value === "number" ? value.toFixed(3) : String(value)),
    },
    xAxis: {
      type: "value",
      name: "轮次",
      nameTextStyle: { color: CHART.axisText, fontSize: 12 },
      min: 0,
      max: epochCount,
      /* 30 轮 → 0/5/10/…/30；刻度是真实轮次，不是等分出来的假标签 */
      interval: epochCount <= 12 ? 2 : Math.ceil(epochCount / 6),
      axisLine: { lineStyle: { color: CHART.grid } },
      axisLabel: { color: CHART.axisText, formatter: (value: number) => String(Math.round(value)) },
      splitLine: { show: true, lineStyle: { color: CHART.grid } },
    },
    yAxis: {
      type: "value",
      name: "损失",
      nameTextStyle: { color: CHART.axisText, fontSize: 12 },
      /* scale：不满轴从 0 起 —— 损失在 0.2–1.2 之间，从 0 起会把差异压平 */
      scale: true,
      axisLine: { lineStyle: { color: CHART.grid } },
      axisLabel: { color: CHART.axisText, formatter: (value: number) => value.toFixed(2) },
      splitLine: { show: true, lineStyle: { color: CHART.grid } },
    },
    series: [
      line(train, slice(train.points)),
      line(val, slice(val.points)),
      line(baseline, baseline.points),
      ...(threshold !== undefined
        ? [
            {
              name: "判定阈值",
              type: "line" as const,
              showSymbol: false,
              lineStyle: { width: 1, type: "dashed" as const, color: CHART.palette[3] },
              data: [
                [0, threshold],
                [epochCount, threshold],
              ],
            },
          ]
        : []),
    ],
  };
}
