import assert from "node:assert/strict";
import { test } from "node:test";
import { FUSION_RECORD } from "../seed/scenario.ts";
import {
  buildCalibrationRows,
  buildEvidenceMatches,
  calibrationSummary,
} from "./fusionInspection.ts";

test("视觉标定只陈述归档记录能证明的映射状态", () => {
  const rows = buildCalibrationRows(FUSION_RECORD);

  assert.equal(rows.length, FUSION_RECORD.annotations.length);
  assert.deepEqual(
    rows.map((row) => row.frameId),
    FUSION_RECORD.annotations.map((item) => item.image),
  );
  assert.ok(rows.every((row) => row.zone === "Z04-lower"));
  assert.ok(rows.every((row) => row.coordinateState === "测区级关联"));
  assert.ok(rows.every((row) => row.metricState === "物理尺度未提供"));
  assert.ok(rows.every((row) => row.source.length > 0));
});

test("疑点匹配由同一份视觉标注、雷达特征与融合输出派生", () => {
  const matches = buildEvidenceMatches(FUSION_RECORD);

  assert.equal(matches.length, FUSION_RECORD.zoneMatch.length);
  assert.deepEqual(
    matches.map((item) => [item.annotation.boxId, item.radar.segment]),
    [
      ["anno-box-07", "echo-Z04-lower-seg-07"],
      ["anno-box-03", "echo-Z04-lower-seg-11"],
      ["anno-box-11", "echo-Z04-lower-seg-13"],
    ],
  );
  assert.equal(matches[0].output?.riskId, "CUR-Z04-01");
  assert.equal(matches[1].output?.riskId, "CUR-Z04-02");
  assert.equal(matches[2].output?.riskId, "CUR-Z04-03");
  assert.equal(matches[2].quality, "待核对");
});

test("标定摘要不借用旧平台脚本中的模拟相机参数", () => {
  const summary = calibrationSummary(FUSION_RECORD);

  assert.deepEqual(summary, {
    frameCount: 3,
    zoneCount: 1,
    linkedCount: 3,
    metricCalibratedCount: 0,
  });
});

test("来源映射明确标记不匹配时，不关联融合输出并保持待核对", () => {
  const record = structuredClone(FUSION_RECORD);
  record.zoneMatch[0].matched = false;

  const [first] = buildEvidenceMatches(record);

  assert.equal(first.matched, false);
  assert.equal(first.output, null);
  assert.equal(first.quality, "待核对");
});
