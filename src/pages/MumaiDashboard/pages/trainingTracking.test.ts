import assert from "node:assert/strict";
import { test } from "node:test";

import type { Experiment } from "../seed/types.ts";
import { buildTrainingTracking } from "./trainingTracking.ts";

const experiment: Experiment = {
  id: "EXP-ARCHIVE-01",
  title: "构件适配归档记录",
  baselineVersion: "M-01",
  candidateVersion: "M-02",
  datasetVersion: "DS-01",
  learningRate: 0.001,
  stopCondition: "验证损失连续 3 轮未下降即停止",
  updateScope: "分类头",
  inputSpec: "1x420",
  threshold: 0.5,
  jobSteps: [
    { key: "queue", label: "排队", state: "已完成", at: "00:02" },
    { key: "prepare", label: "数据准备", state: "已完成", at: "00:08" },
    { key: "adapt", label: "适配", state: "已完成", at: "00:20" },
    { key: "validate", label: "验证", state: "已完成", at: "00:26" },
    { key: "done", label: "完成", state: "已完成", at: "00:28" },
  ],
  curveOld: { id: "old", label: "old", color: "#000", points: [] },
  curveNew: { id: "new", label: "new", color: "#000", points: [] },
  curveTrain: { id: "train", label: "train", color: "#000", points: [] },
  curveVal: { id: "val", label: "val", color: "#000", points: [] },
  predictionsOld: [],
  predictionsNew: [],
  acceptance: [
    { key: "same", label: "测试集一致", detail: "同一清单", pass: true },
    { key: "metric", label: "指标门槛", detail: "召回率未达标", pass: false },
  ],
  config: [],
  log: [
    { at: "00:02", level: "INFO", step: "queue", text: "任务入队" },
    { at: "00:08", level: "INFO", step: "prepare", text: "数据完成" },
    { at: "00:20", level: "WARN", step: "adapt", text: "验证波动" },
    { at: "00:26", level: "ERROR", step: "validate", text: "指标未通过" },
  ],
  node: [],
  sourceMode: "replay",
};

test("当前任务按可见日志推进，归档阶段保持原记录且不被改写", () => {
  const archivedBefore = structuredClone(experiment.jobSteps);
  const tracking = buildTrainingTracking(experiment, {
    started: true,
    running: true,
    visibleLogCount: 2,
    updatedAt: "2026-09-16 10:20:30",
  });

  assert.equal(tracking.current.state, "运行中");
  assert.equal(tracking.current.stageLabel, "数据准备");
  assert.equal(tracking.current.updatedAt, "2026-09-16 10:20:30");
  assert.deepEqual(experiment.jobSteps, archivedBefore);
  assert.ok(tracking.archive.steps.every((step) => step.state === "已完成"));
});

test("归档摘要关联实验版本、通过数、记录时间和异常提示", () => {
  const tracking = buildTrainingTracking(experiment, {
    started: false,
    running: false,
    visibleLogCount: experiment.log.length,
    updatedAt: null,
  });

  assert.equal(tracking.current.state, "待提交");
  assert.equal(tracking.archive.experimentId, "EXP-ARCHIVE-01");
  assert.equal(tracking.archive.versionText, "M-01 -> M-02");
  assert.equal(tracking.archive.passed, 1);
  assert.equal(tracking.archive.total, 2);
  assert.equal(tracking.archive.updatedAt, "00:28");
  assert.deepEqual(tracking.archive.alerts, ["指标门槛：召回率未达标"]);
});

test("当前任务只汇总当前已出现的告警，不提前泄露后续错误", () => {
  const partial = buildTrainingTracking(experiment, {
    started: true,
    running: true,
    visibleLogCount: 3,
    updatedAt: "2026-09-16 10:21:00",
  });
  assert.deepEqual(partial.current.alerts, ["验证波动"]);

  const complete = buildTrainingTracking(experiment, {
    started: true,
    running: false,
    visibleLogCount: experiment.log.length,
    updatedAt: "2026-09-16 10:22:00",
  });
  assert.equal(complete.current.state, "已完成");
  assert.deepEqual(complete.current.alerts, ["验证波动", "指标未通过"]);
});
