/**
 * 「证据对照」数据组装 · 单测（剧本 ㉒ 的屏幕落点）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 用户 2026-10-01：「证据对照已打开…这个对话，还是要做具体的东西，而不只是跳转」。
 * 这一屏最容易出的两类问题：
 *   1. **配错对**：视觉标注框与雷达响应段配错了，界面上就是"拿 A 的图去解释 B 的响应"。
 *      所以逐条核对：每一对的框号与段号必须来自同一条 `zoneMatch`，且同测区；
 *   2. **结论自己长出来**：页面自己算一个"优先级"，与风险记录对不上。
 *      所以：结论只用 `FUSION_RECORD.outputs[].priority`（并有与 `CURRENT_RISKS` 的交叉核对）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CURRENT_RISKS, FUSION_RECORD, FUSION_RULES } from "../seed/scenario.ts";
import { evidenceCrossCheck, evidenceModel, evidenceRules } from "./twinEvidence.ts";

test("两路共同提示与补核清单：按融合记录的 priority 分组，不另算一套", () => {
  const model = evidenceModel();
  assert.equal(model.recordId, FUSION_RECORD.recordId);
  assert.equal(model.ruleVersion, FUSION_RECORD.ruleVersion);
  assert.equal(model.batchId, FUSION_RECORD.batchId);

  const priorityIds = FUSION_RECORD.outputs.filter((item) => item.priority === "优先复核").map((item) => item.riskId);
  const supplementIds = FUSION_RECORD.outputs.filter((item) => item.priority !== "优先复核").map((item) => item.riskId);
  assert.deepEqual(model.priority.map((row) => row.riskId), priorityIds);
  assert.deepEqual(model.supplement.map((row) => row.riskId), supplementIds);
  assert.ok(model.priority.length >= 2, "两路共同提示至少要有两项，否则这一屏没东西可对照");
  assert.ok(model.supplement.length >= 1, "补核清单至少要有一项（资料不齐 / 质量不合格那条）");
});

test("每一对都是同一个测区的真框与真段（配错对就是拿 A 的图解释 B 的响应）", () => {
  const model = evidenceModel();
  for (const row of [...model.priority, ...model.supplement]) {
    const match = FUSION_RECORD.zoneMatch.find((item) => item.visual === row.visual.boxId);
    assert.ok(match, `${row.riskId} 的视觉框 ${row.visual.boxId} 不在 zoneMatch 里`);
    assert.ok(
      row.radar.segment.endsWith(match.radar),
      `${row.riskId} 的雷达段 ${row.radar.segment} 与配对表里的 ${match.radar} 对不上`,
    );
    const annotation = FUSION_RECORD.annotations.find((item) => item.boxId === row.visual.boxId);
    assert.ok(annotation, `${row.riskId} 的标注框不在 annotations 里`);
    assert.equal(row.zone, annotation.zone, `${row.riskId} 的测区与标注框的测区不一致`);
    const radar = FUSION_RECORD.radarFeatures.find((item) => item.segment === row.radar.segment);
    assert.equal(row.radar.amplitude, radar?.amplitude, `${row.riskId} 的幅值与雷达特征不一致`);
    assert.equal(row.radar.quality, radar?.quality, `${row.riskId} 的质量与雷达特征不一致`);
    assert.equal(row.visual.confidence, annotation.confidence, `${row.riskId} 的置信度与标注不一致`);
    /* 出处：图片文件名必须有（界面上要看得见"这是哪张图上的框"） */
    assert.match(row.visual.image, /\.jpg$/, `${row.riskId} 没有图片文件名`);
  }
});

test("补核理由要把「不合格的那一路」点出来（不能只说资料不齐）", () => {
  const model = evidenceModel();
  assert.equal(model.supplementReasons.length, model.supplement.length);
  const failing = FUSION_RECORD.branches.filter((item) => item.state !== "合格");
  assert.ok(failing.length >= 1, "融合记录里应有一条不合格的分支（质量门槛）");
  for (const reason of model.supplementReasons) {
    assert.ok(reason.includes(failing[0].detail), `补核理由里没写清哪一路不合格：${reason}`);
  }
});

test("判定规则与资料完整性直接来自记录（不手写第二份）", () => {
  const model = evidenceModel();
  assert.deepEqual(model.completeness, FUSION_RECORD.completeness);
  assert.deepEqual(model.branches, FUSION_RECORD.branches);
  assert.deepEqual(evidenceRules(), FUSION_RULES.map((item) => ({ ...item })));
  /* 「资料不齐」这一半必须真的能算出来：全 ok 时那一行不该出现 */
  const bad = model.completeness.filter((item) => !item.ok);
  assert.equal(bad.length, FUSION_RECORD.completeness.filter((item) => !item.ok).length);
});

test("与风险记录交叉核对：两边「优先复核」的条数必须一致", () => {
  const cross = evidenceCrossCheck();
  assert.equal(cross.priorityInRisks, CURRENT_RISKS.filter((item) => item.priority === "优先复核").length);
  assert.equal(cross.priorityInEvidence, evidenceModel().priority.length);
  assert.equal(cross.consistent, true, "证据对照的优先项与风险记录对不上时，页面会显示「需要人工核对」");
});
