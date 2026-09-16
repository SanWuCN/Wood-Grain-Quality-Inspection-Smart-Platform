import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCaptureInsights,
  buildCleanProgress,
  type CaptureBatchInput,
  type CapturePackageInput,
} from "./operationInsights.ts";

const batch: CaptureBatchInput = {
  batchId: "scan-Z04-001",
  startedAt: "T+27:36",
  receive: {
    radar: { received: 386, expected: 420, state: "部分接收" },
    image: { received: 12, expected: 12, state: "完成" },
    result: { received: 0, expected: 1, state: "未开始" },
  },
};

const packages: CapturePackageInput[] = [
  {
    id: "pkg-raw",
    name: "scan-Z04-001_radar_spectrum.zip",
    kind: "原始雷达数据",
    source: "毫米波扫描仪",
    batchId: "scan-Z04-001",
    capturedAt: "T+27:36",
    state: "已入库",
    checks: [
      { key: "schema", label: "格式与字段", pass: true, detail: "字段完整" },
      { key: "stamp", label: "时间戳与配置版本", pass: false, detail: "缺 34 帧" },
    ],
  },
  {
    id: "pkg-img",
    name: "scan-Z04-001_images.zip",
    kind: "表面图像",
    source: "毫米波扫描仪",
    batchId: "scan-Z04-001",
    capturedAt: "T+27:52",
    state: "已入库",
    checks: [{ key: "schema", label: "格式与字段", pass: true, detail: "JPEG 12 帧" }],
  },
];

test("采集成果汇总全部由当前批次接收数与关联文件校验项推导", () => {
  const result = buildCaptureInsights(batch, packages);

  assert.equal(result.expected, 433);
  assert.equal(result.received, 398);
  assert.equal(result.missing, 35);
  assert.equal(result.progress, 92);
  assert.deepEqual(result.channels.map((item) => item.progress), [92, 100, 0]);
  assert.deepEqual(result.integrity, { passed: 2, total: 3 });
  assert.equal(result.artifacts.length, 2);
});

test("采集异常可定位到具体通道或文件校验项", () => {
  const result = buildCaptureInsights(batch, packages);

  assert.deepEqual(
    result.issues.map((item) => [item.source, item.detail]),
    [
      ["雷达原始数据", "缺少 34 条，已接收 386/420"],
      ["结果文件", "缺少 1 条，已接收 0/1"],
      ["scan-Z04-001_radar_spectrum.zip · 时间戳与配置版本", "缺 34 帧"],
    ],
  );
});

test("人工核验排除误报后，清洗产物保留数必须回加，不能沿用算法初筛保留数", () => {
  const progress = buildCleanProgress({
    stage: "versioned",
    totalRecords: 12,
    outcome: { kept: 7, flagged: 3 },
    acceptedAnomalies: 1,
    excludedFalsePositives: 2,
  });

  assert.equal(progress.percent, 100);
  assert.equal(progress.processed, 12);
  assert.equal(progress.pendingReview, 0);
  assert.equal(progress.outputRecords, 9);
  assert.equal(progress.removedRecords, 1);
  assert.equal(progress.reviewState, "人工核验完成");
});

test("清洗过程各状态给出独立进度，执行清洗前不伪造已处理数量", () => {
  assert.deepEqual(
    ["pick", "configure", "precheck", "cleaned", "reviewed", "versioned"].map((stage) =>
      buildCleanProgress({ stage, totalRecords: 12 }).percent,
    ),
    [0, 20, 40, 60, 80, 100],
  );
  assert.equal(buildCleanProgress({ stage: "precheck", totalRecords: 12 }).processed, 0);
});

test("采集与清洗页面不向用户显示被禁的可信度弱化措辞", () => {
  for (const file of ["CaptureRun.tsx", "DatasetCleanFlow.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /演示|非真实/, `${file} 不得出现被禁措辞`);
  }
});
