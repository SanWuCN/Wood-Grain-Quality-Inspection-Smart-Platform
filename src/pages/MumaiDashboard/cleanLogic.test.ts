import assert from "node:assert/strict";
import { test } from "node:test";

import { CLEAN_CATEGORIES, DEFAULT_THRESHOLDS, checkSplitLeakage, runClean, selectCleanVersionRecords } from "./cleanLogic.ts";
import { DATASET, SAMPLES } from "./seed/scenario.ts";
import type { Sample } from "./seed/types.ts";

/**
 * 夹具的路径/来源批次必须自洽（`sourceBatch: "ref/g1"` ↔ `path: "ref/g1/scan_000.csv"`）——
 * 否则"路径与来源校验"这一步会先把记录挑走，后面的规则根本轮不到，
 * 测试就变成在验证另一条规则（老版本夹具正是踩了这个坑：sourceBatch=ref-g1 配 ref/g1/... 路径）。
 */
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
  sourceBatch: "ref/g1",
  ...overrides,
});

const run = () => runClean(SAMPLES, DEFAULT_THRESHOLDS);

test("八步流水线逐步收敛：每步输入是上一步的保留，保留数等于输入减去本步命中", () => {
  const outcome = run();

  assert.deepEqual(
    outcome.steps.map((step) => step.key),
    ["schema", "path", "unique", "dedupe", "range", "label", "reference", "group"],
  );

  outcome.steps.forEach((step, index) => {
    assert.equal(step.kept, step.input - step.hits.length, `${step.label}：保留 ≠ 输入 − 命中`);
    assert.ok(step.kept <= step.input, `${step.label}：保留数不能大于输入`);
    if (index > 0) assert.equal(step.input, outcome.steps[index - 1].kept, `${step.label}：输入 ≠ 上一步保留`);
    /* 待审核数只数真进核验队列的：直接剔除（schema）与只做校验（path/unique/group）都是 0 */
    assert.equal(step.review, step.kind === "review" ? step.hits.length : 0, `${step.label}：待审核数对不上`);
  });

  assert.equal(outcome.kept, outcome.steps[outcome.steps.length - 1].kept);
  assert.equal(outcome.kept + outcome.flagged.length + outcome.unusable, SAMPLES.length);
});

test("同一条记录只被一条规则挑走：各步命中互不重叠，账目与样本总数对得上", () => {
  const outcome = run();
  const seen = new Set<string>();

  for (const step of outcome.steps) {
    for (const recordId of step.hits) {
      assert.ok(!seen.has(recordId), `${recordId} 被两步重复计入`);
      seen.add(recordId);
    }
  }

  const flaggedIds = outcome.flagged.map((item) => item.recordId);
  const droppedIds = outcome.dropped.map((item) => item.recordId);
  assert.equal(new Set(flaggedIds).size, flaggedIds.length, "核验队列里不能有重复记录");
  assert.deepEqual([...seen].sort(), [...flaggedIds, ...droppedIds].sort(), "命中集合 ≠ 核验队列 + 直接剔除");
  assert.equal(flaggedIds.length + droppedIds.length + outcome.kept, SAMPLES.length);
});

test("真实种子上的命中逐条可核验：谁、被哪条规则、命中值多少", () => {
  const outcome = run();

  assert.deepEqual(
    outcome.flagged.map((item) => [item.recordId, item.step, item.category, item.value]),
    [
      ["r-0003", "重复摘要筛查", "重复疑点", "dup=r-0002"],
      ["r-0007", "数值范围与饱和检查", "采集异常", "11.8%"],
      ["r-0008", "标签依据核验", "标签待核验", "无标签依据，单列待核验集合"],
      ["r-0009", "特征幅度与参考分布比对", "采集异常", "47 mm"],
    ],
  );

  /* 三类人工判断都要在真实数据上出现（⑰ 的备用播报念的就是这三类） */
  assert.deepEqual([...new Set(outcome.flagged.map((item) => item.category))].sort(), [...CLEAN_CATEGORIES].sort());

  /* 确定不可用的两条：读都读不了，直接剔除、不占用人工核验时间 */
  assert.deepEqual(
    outcome.dropped.map((item) => item.recordId),
    ["r-0005", "r-0010"],
  );
  assert.equal(outcome.nominalMm, 25, "参考件标定中位应取自 reference 批次（25 mm）");
});

test("直接剔除的记录既不进核验队列，也不会从版本里漏过去", () => {
  const samples = [
    sample(),
    sample({ recordId: "r-bad", path: "ref/g1/broken.csv", quality: "不可用", qualityReason: "格式损坏" }),
  ];
  const outcome = runClean(samples, DEFAULT_THRESHOLDS);

  assert.deepEqual(outcome.flagged, [], "不可用 ≠ 疑似异常，不该出现在核验队列");
  assert.deepEqual(outcome.dropped.map((item) => item.recordId), ["r-bad"]);

  /* 没有任何人工结论时：可用记录进版本，不可用记录被剔除 */
  const untouched = selectCleanVersionRecords(samples, outcome, {});
  assert.deepEqual(untouched.includedRecordIds, ["r-0001"]);
  assert.deepEqual(untouched.removedRecordIds, ["r-bad"]);
});

test("人工核验逐条决定版本成员：未决记录不会被悄悄纳入或删除", () => {
  const outcome = run();
  const pending = selectCleanVersionRecords(SAMPLES, outcome, {});
  assert.deepEqual(pending.undecidedRecordIds, ["r-0003", "r-0007", "r-0008", "r-0009"]);

  const decided = selectCleanVersionRecords(SAMPLES, outcome, {
    "r-0003": "exclude",
    "r-0007": "accept",
    "r-0008": "accept",
    "r-0009": "accept",
  });
  assert.deepEqual(decided.undecidedRecordIds, []);
  /* 顺序即样本清单顺序：直接剔除的两条夹在核验采纳的三条中间 */
  assert.deepEqual(decided.removedRecordIds, ["r-0005", "r-0007", "r-0008", "r-0009", "r-0010"]);
  assert.equal(decided.includedRecordIds.length, SAMPLES.length - decided.removedRecordIds.length);
  assert.ok(decided.includedRecordIds.includes("r-0003"), "被人工排除的误报要留在新版本里");
});

test("阈值是真参数：收紧偏差会多挑出记录，放宽会把记录放回", () => {
  const base = run();

  const tight = runClean(SAMPLES, { ...DEFAULT_THRESHOLDS, referenceToleranceMm: 0 });
  const tightReferenceHits = tight.steps.find((step) => step.key === "reference")?.hits ?? [];
  assert.deepEqual(tightReferenceHits, ["r-0002", "r-0006", "r-0009"]);
  assert.ok(tight.flagged.length > base.flagged.length);
  assert.ok(tight.kept < base.kept);

  const loose = runClean(SAMPLES, { ...DEFAULT_THRESHOLDS, saturationMax: 50, referenceToleranceMm: 100 });
  assert.equal(loose.kept, 7, "放宽阈值后 r-0009 应回到保留集");
  assert.ok(!loose.flagged.some((item) => item.recordId === "r-0009"));

  /* 同一套阈值跑两次结果必须一致（页面上的数字要能复现，不能随机） */
  assert.deepEqual(loose, runClean(SAMPLES, { ...DEFAULT_THRESHOLDS, saturationMax: 50, referenceToleranceMm: 100 }));
});

test("饱和与标签是两条不同的规则：放宽饱和上限后，r-0007 落到标签依据这一步", () => {
  const loose = runClean(SAMPLES, { ...DEFAULT_THRESHOLDS, saturationMax: 50 });
  const r0007 = loose.flagged.find((item) => item.recordId === "r-0007");

  assert.equal(r0007?.step, "标签依据核验");
  assert.equal(r0007?.category, "标签待核验");
  assert.equal(runClean(SAMPLES, DEFAULT_THRESHOLDS).flagged.find((item) => item.recordId === "r-0007")?.step, "数值范围与饱和检查");
});

test("关闭重复帧合并，重复摘要这一步就空了（不把同木样多方向采样当重复）", () => {
  const outcome = runClean(SAMPLES, { ...DEFAULT_THRESHOLDS, dedupe: false });
  const dedupe = outcome.steps.find((step) => step.key === "dedupe");

  assert.deepEqual(dedupe?.hits, []);
  assert.equal(dedupe?.review, 0);
  assert.ok(!outcome.flagged.some((item) => item.category === "重复疑点"));
});

test("划分泄漏单独检查：同一物理样本不能同时出现在两个划分里", () => {
  assert.deepEqual(checkSplitLeakage(DATASET.splits), [], "当前种子划分应当无跨划分泄漏");

  assert.deepEqual(checkSplitLeakage([
    { name: "训练集", sampleIds: ["S-01", "S-02"] },
    { name: "验证集", sampleIds: ["S-01"] },
  ]), [{ physicalSampleId: "S-01", splits: ["训练集", "验证集"] }]);
});
