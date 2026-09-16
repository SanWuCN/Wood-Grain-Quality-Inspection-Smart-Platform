import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_THRESHOLDS, runClean, selectCleanVersionRecords } from "./cleanLogic.ts";
import type { Sample } from "./seed/types.ts";

const sample = (overrides: Partial<Sample> = {}): Sample => ({
  physicalSampleId: "S-01",
  recordId: "r-0001",
  path: "ref/g1/scan_000.csv",
  materialSource: "来源卡 A",
  knownState: "正常",
  labelBasis: "来源卡 + 目视复核",
  quality: "可用",
  qualityReason: "字段完整",
  groupId: "G-01",
  distanceMm: 25,
  direction: "0°",
  saturationPct: 0.4,
  duplicateOf: null,
  sourceBatch: "ref-g1",
  ...overrides,
});

test("同一物理样本的不同方向记录不是重复帧，只有显式 duplicateOf 才进入核验", () => {
  const samples = [
    sample(),
    sample({ recordId: "r-0002", path: "ref/g1/scan_001.csv", direction: "45°" }),
    sample({ recordId: "r-0003", path: "ref/g1/scan_002.csv", direction: "45°", duplicateOf: "r-0002", quality: "待审核" }),
  ];

  const outcome = runClean(samples, DEFAULT_THRESHOLDS);

  assert.deepEqual(outcome.flagged.map((item) => item.recordId), ["r-0003"]);
  assert.equal(outcome.kept, 2);
});

test("已有不可用质量结论的记录进入人工核验，生成版本只保留未命中项和被排除的误报", () => {
  const samples = [
    sample(),
    sample({ recordId: "r-bad", path: "broken.csv", quality: "不可用", qualityReason: "格式损坏" }),
    sample({ recordId: "r-sat", path: "sat.csv", saturationPct: 12, quality: "待审核" }),
  ];
  const outcome = runClean(samples, DEFAULT_THRESHOLDS);

  assert.deepEqual(outcome.flagged.map((item) => item.recordId), ["r-bad", "r-sat"]);
  const version = selectCleanVersionRecords(samples, outcome, { "r-bad": "accept", "r-sat": "exclude" });
  assert.deepEqual(version.includedRecordIds, ["r-0001", "r-sat"]);
  assert.deepEqual(version.removedRecordIds, ["r-bad"]);
  assert.deepEqual(version.undecidedRecordIds, []);
});
