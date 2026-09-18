/**
 * 素材质检页的数据装配（`materials.ts`）
 *
 * 纯函数，逐条断言。四组判据：
 *   · 素材清单里的每个数都等于 `scenarioValue("material.*")`（与播报、浮层卡片同源）；
 *   · 低清晰度标记**一条不落**（00:43 / 02:17），且每条都给出"怎么做"的建议；
 *   · **不编没测得的数**：检查结论里不出现"重叠率 xx%"这类没有出处的数字；
 *   · 来源文件与关键帧读 `SCENES`，并标清"预采"（本轮按预采素材演示）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENES, scenarioValue } from "../seed/scenario.ts";
import {
  currentSource,
  historySources,
  lowQualityMarks,
  materialAdvice,
  materialChecks,
  materialOrigin,
  materialSummary,
} from "./materialsData.ts";

test("素材清单：每个数都等于数据包里的值（与播报、浮层卡片同源）", () => {
  const rows = materialSummary();
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      "material.videoCount",
      "material.resolutionText",
      "material.durationText",
      "material.keyFrames",
      "material.missingFiles",
      "material.lowQualityClips",
    ],
  );
  for (const row of rows) {
    assert.ok(!row.label.startsWith("〔标签缺失"), `${row.key} 没有中文标签`);
    assert.notEqual(row.value, "—", `${row.key} 取不到值`);
    assert.ok(row.value.startsWith(String(scenarioValue(row.key))), `${row.key} 显示的值与数据包不一致`);
  }
  /* 小木那句播报里的三个数都要能在这一屏上找到 */
  const text = rows.map((row) => row.value).join(" ");
  assert.match(text, /3840×1920/);
  assert.match(text, /214/);
});

test("低清晰度标记：两处都在，且每处都给「该怎么做」的建议", () => {
  const marks = lowQualityMarks();
  assert.equal(marks.length, Number(scenarioValue("material.lowQualityClips")));
  assert.deepEqual(
    marks.map((mark) => mark.at),
    ["00:43", "02:17"],
  );
  for (const mark of marks) {
    assert.match(mark.at, /^\d{2}:\d{2}$/);
    assert.ok(mark.note.length >= 6, `${mark.at} 没有说清是什么画面问题`);
    assert.match(mark.advice, /重看|补拍/);
  }
});

test("检查项：结论只落在测得的数据上，不出现没出处的重叠率", () => {
  const checks = materialChecks();
  assert.deepEqual(
    checks.map((item) => item.key),
    ["files", "slice", "sharpness", "coverage", "persons"],
  );
  const files = checks.find((item) => item.key === "files");
  assert.equal(files?.state, "ok", "缺失文件 0 个 → 这一项是通过");
  assert.match(String(files?.detail), /缺失文件 0 个/);

  const sharpness = checks.find((item) => item.key === "sharpness");
  assert.equal(sharpness?.state, "watch");
  assert.match(String(sharpness?.detail), /00:43 \/ 02:17/);

  /* 重叠率没有实测来源：只能写"人工重看"，不能出现百分比 */
  const coverage = checks.find((item) => item.key === "coverage");
  assert.equal(coverage?.state, "watch");
  assert.doesNotMatch(String(coverage?.detail), /\d+\s*%/);
  assert.match(String(coverage?.detail), /人工重看|重叠/);

  for (const check of checks) {
    assert.doesNotMatch(check.detail, /\d+\s*%/, `${check.key} 出现了没有出处的百分比`);
  }
});

test("采集建议：逐条对上标记点，并说明预采/现场的分工", () => {
  const advice = materialAdvice();
  assert.ok(advice.length >= 3);
  assert.ok(advice.some((item) => item.startsWith("00:43")));
  assert.ok(advice.some((item) => item.startsWith("02:17")));
  assert.ok(advice.some((item) => /重叠/.test(item)));
  assert.ok(advice.some((item) => /预采素材走处理流程/.test(item)));
});

test("来源与关键帧：读 SCENES，本轮是预采视频，历史是五月离线预采", () => {
  const current = currentSource();
  assert.ok(current, "种子里应当有本轮的 SceneAsset");
  assert.match(current.sourceVideo, /precollected_sh_0901_pano\.mp4/);
  assert.match(current.sourceVideo, /预采/);
  assert.equal(current.keyframes, Number(scenarioValue("material.keyFrames")), "关键帧数与素材清单同源");
  assert.equal(current.version, SCENES.find((item) => item.round === "本轮")?.version);

  const history = historySources();
  assert.ok(history.length >= 1);
  for (const item of history) {
    assert.equal(item.round, "历史");
    assert.match(item.sourceVideo, /may_round1_pano\.mp4/);
  }
});

test("来源声明写明「预置演示结果」与「不发公网请求」", () => {
  const origin = materialOrigin();
  assert.match(origin.tool, /预置结果/);
  assert.match(origin.note, /预置结果/);
  assert.match(origin.note, /不发公网请求/);
});
