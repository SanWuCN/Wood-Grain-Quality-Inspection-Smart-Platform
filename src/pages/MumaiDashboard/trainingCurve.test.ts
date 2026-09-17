import assert from "node:assert/strict";
import { test } from "node:test";
import type { EChartsCoreOption } from "echarts/core";

import { EXPERIMENT, FAILED_EXPERIMENT, EARLY_STOP_PATIENCE, TRAIN_BEST_EPOCH, TRAIN_EPOCHS } from "./seed/scenario.ts";
import { buildLossOption, curveStats, detectOverfit, earlyStopOf, lossTooltipText, patienceOf } from "./trainingCurve.ts";

/** 训练页那三条曲线（顺序即图例顺序） */
const seriesOf = (experiment = EXPERIMENT) => [
  { name: experiment.curveTrain.label, color: experiment.curveTrain.color, points: experiment.curveTrain.points },
  { name: experiment.curveVal.label, color: experiment.curveVal.color, points: experiment.curveVal.points },
  { name: experiment.curveOld.label, color: experiment.curveOld.color, points: experiment.curveOld.points },
];

/**
 * 断言要看 option 的内部结构，而 `EChartsCoreOption` 是宽泛的联合类型。
 * 这里显式声明"本测试用到的那些字段"，比到处 `any` 更能说明在验什么。
 */
type OptionView = {
  xAxis: { type: string; min: number; max: number; interval: number };
  yAxis: { scale: boolean };
  legend?: unknown;
  tooltip: { trigger: string; className: string };
  series: {
    data: unknown[];
    showSymbol?: boolean;
    markLine?: { data: { xAxis: number; label: { formatter: string } }[] };
  }[];
};

const view = (option: EChartsCoreOption) => option as unknown as OptionView;

test("曲线的轮数与早停规则同源：30 轮、耐心 6、最低点落在第 24 轮", () => {
  assert.equal(TRAIN_EPOCHS, 30);
  assert.equal(EARLY_STOP_PATIENCE, 6);
  assert.equal(TRAIN_BEST_EPOCH, TRAIN_EPOCHS - EARLY_STOP_PATIENCE);

  for (const [name, experiment] of [
    ["成功案例", EXPERIMENT],
    ["失败案例", FAILED_EXPERIMENT],
  ] as const) {
    const stats = curveStats(experiment.curveVal.points);
    assert.equal(stats.epochs, TRAIN_EPOCHS, `${name}：验证损失轮数应等于实际跑过的轮数`);
    assert.equal(stats.minEpoch, TRAIN_BEST_EPOCH, `${name}：最低点应落在第 ${TRAIN_BEST_EPOCH} 轮`);

    /* 一条序列里最低点唯一：并列会让"最优轮次"变成一个区间，页面上没法写 */
    const values = experiment.curveVal.points.map((point) => point.y);
    assert.equal(values.filter((value) => value === stats.min).length, 1, `${name}：最低点不唯一`);

    /* 与归档实验包声明的 patience 对账：末轮 − 最低点 = 6 */
    const stop = earlyStopOf(stats, patienceOf(experiment.config) ?? 0);
    assert.equal(stop.patience, EARLY_STOP_PATIENCE);
    assert.equal(stop.roundsWithoutImprovement, EARLY_STOP_PATIENCE);
    assert.equal(stop.consistent, true, `${name}：曲线与「连续 6 轮不下降即停止」对不上`);
  }
});

test("两类案例只在最优之后分叉：成功案例抬升 < 0.02，失败案例 > 0.03（过拟合判据）", () => {
  const success = curveStats(EXPERIMENT.curveVal.points);
  const failed = curveStats(FAILED_EXPERIMENT.curveVal.points);

  /* 第 1…24 轮两条曲线逐点相同（同一起点同一条衰减核），分叉只发生在最优之后 */
  assert.deepEqual(
    EXPERIMENT.curveVal.points.slice(0, TRAIN_BEST_EPOCH),
    FAILED_EXPERIMENT.curveVal.points.slice(0, TRAIN_BEST_EPOCH),
  );
  assert.ok(success.riseFromMin > 0 && success.riseFromMin < 0.02, `成功案例末轮只抬升 ${success.riseFromMin}`);
  assert.ok(failed.riseFromMin > 0.03, `失败案例末轮抬升 ${failed.riseFromMin} 应超过 0.03`);

  assert.equal(detectOverfit(EXPERIMENT.curveVal.points.map((p) => p.y)), null, "成功案例不该判过拟合");
  const overfit = detectOverfit(FAILED_EXPERIMENT.curveVal.points.map((p) => p.y));
  assert.equal(overfit?.minEpoch, TRAIN_BEST_EPOCH, "失败案例的发散点应报最低点所在轮次");
  assert.ok((overfit?.rise ?? 0) > 0.03);
});

test("训练损失仍然一路下降：最低点就在末轮，不与验证损失同轮（S16 的口播依据）", () => {
  for (const [name, experiment] of [
    ["成功案例", EXPERIMENT],
    ["失败案例", FAILED_EXPERIMENT],
  ] as const) {
    const train = curveStats(experiment.curveTrain.points);
    assert.equal(train.epochs, TRAIN_EPOCHS);
    assert.equal(train.minEpoch, TRAIN_EPOCHS, `${name}：训练损失应仍在下降（最低点在末轮）`);
    /* 训练损失全程高于…不，是低于验证损失之外的另一条线：末值必须比首值低 */
    assert.ok(train.last < train.first * 0.3, `${name}：训练损失末值应明显低于首值`);
  }
});

test("统计量只算已回放范围：回放没走到，就不该出现后面的数（不提前剧透）", () => {
  const points = EXPERIMENT.curveVal.points;
  const early = curveStats(points.slice(0, 8));
  assert.equal(early.epochs, 8);
  assert.equal(early.minEpoch, 8, "前 8 轮里最低点在第 8 轮（衰减阶段）");
  assert.ok(early.min > curveStats(points).min, "回放早期的最低损失应高于整轮的最低损失");

  assert.deepEqual(curveStats([]), { epochs: 0, first: 0, last: 0, min: 0, minEpoch: 0, drop: 0, riseFromMin: 0 });
});

test("option 里有真实坐标轴、图例、Tooltip 与两条标记线（可读，不是一张哑图）", () => {
  const option = buildLossOption({
    series: seriesOf(),
    grow: [EXPERIMENT.curveTrain.label, EXPERIMENT.curveVal.label],
    drawn: TRAIN_EPOCHS,
    epochCount: TRAIN_EPOCHS,
    markLine: { seriesName: EXPERIMENT.curveVal.label, bestEpoch: TRAIN_BEST_EPOCH, stopEpoch: TRAIN_EPOCHS },
  });
  const anyOption = view(option);

  /* 横轴是真实轮次（0–30，每 5 轮一格），不是等分出来的假标签 */
  assert.equal(anyOption.xAxis.type, "value");
  assert.equal(anyOption.xAxis.min, 0);
  assert.equal(anyOption.xAxis.max, TRAIN_EPOCHS);
  assert.equal(anyOption.xAxis.interval, 5);
  /* 纵轴按数据缩放（损失在 0.2–1.2 之间，从 0 起会把差异压平） */
  assert.equal(anyOption.yAxis.scale, true);

  /* 三条曲线 + 图例 + 轴触发 Tooltip（Tooltip 落在 DOM 上，E2E 读它的文字） */
  assert.equal(anyOption.series.length, 3);
  assert.equal(anyOption.tooltip.trigger, "axis");
  assert.equal(anyOption.tooltip.className, "tw-chart__tip");
  assert.ok(anyOption.legend, "要有图例（三条线必须能对上名字）");

  /* 跑满整轮时两条标记线都在：最优轮次 + 停止轮次 */
  const marks = (anyOption.series[1].markLine?.data ?? []).map((item) => item.xAxis);
  assert.deepEqual(marks, [TRAIN_BEST_EPOCH, TRAIN_EPOCHS]);
  assert.match(anyOption.series[1].markLine?.data[0]?.label.formatter ?? "", /最优轮次 24/);
});

test("Tooltip 文案读得懂：第几轮 + 每一条线的值（不是一串裸数字）", () => {
  const text = lossTooltipText([
    { seriesName: "候选 · 训练损失", value: [15, 0.3195] },
    { seriesName: "候选 · 验证损失", value: [15, 0.4385] },
    { seriesName: "DEMO-M02 基线验证损失", value: [15, 0.5909] },
  ]);
  assert.equal(
    text,
    "第 15 轮 · 候选 · 训练损失 0.320 · 候选 · 验证损失 0.439 · DEMO-M02 基线验证损失 0.591",
  );
  /* 取不到值的系列不写进文案（宁可少一行，也不写 NaN） */
  assert.equal(lossTooltipText([{ seriesName: "候选 · 训练损失", value: [3, 0.9771] }, { seriesName: "空", value: null }]), "第 3 轮 · 候选 · 训练损失 0.977");
});

test("option 里带上了读懂 Tooltip 的两个 formatter（轴指针写轮次、内容写值）", () => {
  const option = view(
    buildLossOption({
      series: seriesOf(),
      drawn: TRAIN_EPOCHS,
      epochCount: TRAIN_EPOCHS,
    }),
  ) as unknown as {
    tooltip: {
      formatter: (params: unknown) => string;
      axisPointer: { label: { formatter: (params: { value: number }) => string } };
    };
  };

  assert.equal(option.tooltip.formatter([{ seriesName: "候选 · 验证损失", value: [24, 0.2928] }]), "第 24 轮 · 候选 · 验证损失 0.293");
  assert.equal(option.tooltip.axisPointer.label.formatter({ value: 24.0001 }), "第 24 轮");
});

test("投屏页那张图与训练页同源：两条曲线画在同一纵轴上，且没有回放标记", () => {
  const option = view(
    buildLossOption({
      series: [
        { name: EXPERIMENT.curveOld.label, color: EXPERIMENT.curveOld.color, points: EXPERIMENT.curveOld.points },
        { name: EXPERIMENT.curveNew.label, color: EXPERIMENT.curveNew.color, points: EXPERIMENT.curveNew.points },
      ],
      drawn: EXPERIMENT.curveOld.points.length,
      epochCount: EXPERIMENT.curveOld.points.length,
    }),
  );

  assert.equal(option.series.length, 2, "投屏只讲新旧两条");
  /* 同一个 yAxis（不是双轴）：两条曲线在同一量纲下才比得出谁好 */
  assert.equal(Array.isArray(option.yAxis), false);
  assert.equal(option.series[0].data.length, TRAIN_EPOCHS, "静态结论：整条铺满");
  assert.equal(option.series[1].data.length, TRAIN_EPOCHS);
  assert.equal(option.series[0].markLine, undefined, "投屏不画回放标记线");
  assert.ok(option.legend, "图例要有：大屏上必须认得出哪条是新、哪条是旧");
});

test("回放没走到最优轮次时，标记线不出现（曲线也按已回放长度截断）", () => {  const base = {
    series: seriesOf(),
    grow: [EXPERIMENT.curveTrain.label, EXPERIMENT.curveVal.label],
    epochCount: TRAIN_EPOCHS,
    markLine: { seriesName: EXPERIMENT.curveVal.label, bestEpoch: TRAIN_BEST_EPOCH, stopEpoch: TRAIN_EPOCHS },
  };
  const early = view(buildLossOption({ ...base, drawn: 6 }));

  assert.equal(early.series[0].data.length, 6, "候选曲线按已回放轮数截断");
  assert.equal(early.series[1].data.length, 6);
  assert.equal(early.series[2].data.length, TRAIN_EPOCHS, "基线整条铺满（上一版的历史记录，留着当对照物）");
  assert.deepEqual(early.series[1].markLine?.data, [], "还没走到第 24 轮，不提前剧透");
  assert.equal(early.series[0].showSymbol, true, "回放中露点，看得出画到哪一轮");

  const done = view(buildLossOption({ ...base, drawn: TRAIN_EPOCHS }));
  assert.equal(done.series[0].showSymbol, false, "跑满后只看线");
});
