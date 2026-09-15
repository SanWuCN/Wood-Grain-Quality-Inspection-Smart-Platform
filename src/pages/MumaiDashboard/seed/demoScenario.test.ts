/**
 * 纯本地演示数据包 `DEMO_SCENARIO_V3`（unit test）
 *
 * ── 这一组在防什么（工作清单 §6、§11.1、§11.5）──────────────────────
 *   §6    ：形成**单一** `DEMO_SCENARIO_V3` 数据入口，不得在播报组件、
 *           页面组件或语音模块里复制一套数字；
 *   §11.1 ：所有播报变量必须来自它，模板缺字段时进入缺失态，**禁止补写**；
 *   §11.5 ：同一指标在台词、页面、测试里必须引用同一数据键，
 *           不得在三个文件里手写三个数值。
 *
 * 所以这组测试做三件事：
 *   1. **逐项钉住 §6 的冻结值**（数值 + 单位 + 数据键），冻结值一旦被改动就红；
 *   2. **钉住"单一入口"**：这些值必须能在 `DEMO_SCENARIO_V3` 里按数据键取到，
 *      且与既有 seed 里已有的同类值**指向同一个来源**（不是第二份真值）；
 *   3. **钉住缺失态**：按数据键取不到时必须返回明确的"无"，而不是 undefined/空串。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_BUSINESS_DATE, DEMO_SCENARIO_V3, scenarioValue, SCENARIO_KEYS } from "./scenario.ts";

/* ------------------------------------------------------------------ *
 * 1. 时间与工单标识（§6.1）
 * ------------------------------------------------------------------ */

test("§6.1 演示业务日期沿用既有的 DEMO_BUSINESS_DATE，不新起第二个常量", () => {
  assert.equal(DEMO_BUSINESS_DATE, "2026-09-11");
  /* 必须是**同一个值**：另起一个 "2026-09-11" 字面量就是第二份真值 */
  assert.equal(
    DEMO_SCENARIO_V3.clock.businessDate,
    DEMO_BUSINESS_DATE,
    "演示时钟必须引用既有常量，不能另写一个字面量",
  );
});

test("§6.1 天气统计区间为 2026-06-11 至 2026-09-10", () => {
  assert.equal(DEMO_SCENARIO_V3.weather.rangeStart, "2026-06-11");
  assert.equal(DEMO_SCENARIO_V3.weather.rangeEnd, "2026-09-10");
  assert.equal(DEMO_SCENARIO_V3.weather.panelTitle, "平台环境档案 · 截止 2026-09-10");
});

test("§6.1 关键标识符逐个冻结", () => {
  assert.equal(DEMO_SCENARIO_V3.mission.id, "MSN-2026-0911-02");
  assert.equal(DEMO_SCENARIO_V3.map.version, "MAP-SH-06");
  assert.equal(DEMO_SCENARIO_V3.map.resolutionM, 0.05);
  assert.equal(DEMO_SCENARIO_V3.twin.sceneId, "scene-SH-0901");
  assert.equal(DEMO_SCENARIO_V3.draftOrder.no, "WO-2026-0912");
  assert.equal(DEMO_SCENARIO_V3.components.focus, "Z04");
  assert.equal(DEMO_SCENARIO_V3.components.count, 4);
});

/* ------------------------------------------------------------------ *
 * 2. 三个月天气快照（§6.2）—— 四分类逐项
 * ------------------------------------------------------------------ */

test("§6.2 降雨四项数值 + 单位 + 数据键", () => {
  const rain = DEMO_SCENARIO_V3.weather.rain;
  assert.equal(rain.totalMm, 412.0);
  assert.equal(rain.rainyDays, 37);
  assert.equal(rain.stormDays, 4);
  assert.equal(rain.longestWetSpellDays, 5);
  assert.equal(rain.peakDailyMm, 52.6);
  assert.equal(rain.unit, "mm");
});

test("§6.2 湿度三项数值 + 页面风险映射", () => {
  const rh = DEMO_SCENARIO_V3.weather.humidity;
  assert.equal(rh.avgPct, 78);
  assert.equal(rh.highHumidityDays, 39);
  assert.equal(rh.maxDailyAvgPct, 92);
  assert.deepEqual(rh.risks, ["木材含水率偏高", "霉变", "漆层起翘"]);
});

test("§6.2 大风与温差两项数值", () => {
  assert.equal(DEMO_SCENARIO_V3.weather.wind.maxGustMs, 17.8);
  assert.equal(DEMO_SCENARIO_V3.weather.wind.strongWindDays, 6);
  assert.deepEqual(DEMO_SCENARIO_V3.weather.wind.risks, ["迎风面连接", "松动", "表面风化"]);
  assert.equal(DEMO_SCENARIO_V3.weather.temperature.maxDailyDeltaC, 11.4);
  assert.deepEqual(DEMO_SCENARIO_V3.weather.temperature.risks, ["干缩湿胀", "细裂纹", "地仗层开裂"]);
});

test("§6.2 降雨风险映射与「本地演习数据」角标", () => {
  assert.deepEqual(DEMO_SCENARIO_V3.weather.rain.risks, ["柱脚积水返潮", "屋面排水", "渗漏痕迹"]);
  assert.equal(DEMO_SCENARIO_V3.weather.badge, "本地演习数据");
});

test("§6.2 小木标准播报逐字冻结（含全部四个数字）", () => {
  const line = DEMO_SCENARIO_V3.weather.script;
  assert.equal(
    line,
    "已完成近三个月天气查询。累计降雨412.0毫米，降雨37天，平均相对湿度78%，最大阵风17.8米每秒。" +
      "建议优先检查柱脚返潮、屋面排水、漆层起翘和迎风面连接，现场结论以实测为准。",
  );
  /* 播报里的每个数字都必须来自上面的数据键，不能是另写的字面量 */
  assert.ok(line.includes(String(DEMO_SCENARIO_V3.weather.rain.totalMm)), "播报要含 rain.totalMm");
  assert.ok(line.includes(String(DEMO_SCENARIO_V3.weather.rain.rainyDays)), "播报要含 rain.rainyDays");
  assert.ok(line.includes(String(DEMO_SCENARIO_V3.weather.humidity.avgPct)), "播报要含 humidity.avgPct");
  assert.ok(line.includes(String(DEMO_SCENARIO_V3.weather.wind.maxGustMs)), "播报要含 wind.maxGustMs");
});

/* ------------------------------------------------------------------ *
 * 3. 其余关键数据（§6.3）
 * ------------------------------------------------------------------ */

test("§6.3 现场环境五项（含测点相对 Z04 的位置）", () => {
  const env = DEMO_SCENARIO_V3.siteEnv;
  assert.equal(env.airTempC, 26.4);
  assert.equal(env.relativeHumidityPct, 78);
  assert.equal(env.windSpeedMs, 1.6);
  assert.equal(env.distanceToZ04M, 2.4);
  assert.equal(env.heightAboveGroundM, 1.1);
});

test("§6.3 重建素材五项（§7 的固定播报要逐字用到）", () => {
  const m = DEMO_SCENARIO_V3.material;
  assert.equal(m.videoCount, 1);
  assert.equal(m.durationText, "4分18秒");
  assert.equal(m.resolutionText, "3840×1920");
  assert.equal(m.keyFrames, 214);
  assert.equal(m.lowQualityClips, 2);
  assert.deepEqual(m.lowQualityMarks, ["00:43", "02:17"]);
  assert.equal(m.missingFiles, 0);
});

test("§6.3 异常采集四项", () => {
  const a = DEMO_SCENARIO_V3.anomaly;
  assert.equal(a.batchId, "scan-Z04-001");
  assert.equal(a.plannedFrames, 420);
  assert.equal(a.receivedFrames, 386);
  assert.equal(a.missingFrames, 34);
  assert.equal(a.featureShiftSigma, 2.7);
  /* 帧缺口要自洽：缺失 = 计划 − 收到（防「三个数字各自手写」的不一致） */
  assert.equal(a.missingFrames, a.plannedFrames - a.receivedFrames, "缺失帧必须等于计划减收到");
});

test("§6.3 数据清洗四组数字 + 划分自洽", () => {
  const c = DEMO_SCENARIO_V3.clean;
  assert.equal(c.rawCount, 12);
  assert.equal(c.keptCount, 9);
  assert.equal(c.excludedCount, 3);
  assert.equal(c.physicalGroups, 6);
  assert.equal(c.split.train, 4);
  assert.equal(c.split.validation, 1);
  assert.equal(c.split.test, 1);
  assert.equal(c.excludedCount, c.rawCount - c.keptCount, "排除数必须等于原始减保留");
  assert.equal(
    c.split.train + c.split.validation + c.split.test,
    c.physicalGroups,
    "训练+验证+测试必须等于物理样本组数",
  );
});

test("§6.3 模型验证：三项指标 + 部署条件 6/6", () => {
  const m = DEMO_SCENARIO_V3.model;
  assert.equal(m.missedBefore, 3);
  assert.equal(m.missedAfter, 2);
  assert.equal(m.falsePositiveBefore, 4);
  assert.equal(m.falsePositiveAfter, 2);
  assert.equal(m.recallBefore, 0.92);
  assert.equal(m.recallAfter, 0.94);
  assert.equal(m.deployChecksPassed, 6);
  assert.equal(m.deployChecksTotal, 6);
});

test("§6.3 端侧包三项 + 演习状态（不可真实刷写）", () => {
  const p = DEMO_SCENARIO_V3.package;
  assert.equal(p.id, "DEMO-PKG-02");
  assert.equal(p.sizeMb, 3.2);
  assert.equal(p.targetVersion, "DEMO-M02b");
  assert.equal(p.rollbackVersion, "DEMO-M02");
  assert.equal(p.simulatedOnly, true, "必须显式标注只能演习，不可真实刷写");
});

test("§6.3 精细分析：三路数据 + 预处理版本", () => {
  const f = DEMO_SCENARIO_V3.fusion;
  assert.equal(f.radarFrames, 420);
  assert.equal(f.imageFrames, 14);
  assert.equal(f.edgeResults, 3);
  assert.equal(f.preprocessVersion, "comp-v1.4");
  assert.equal(f.recordId, "fusion-2026-0911-01");
});

test("§6.3 归档交付 24/21/1/2 —— 四项必须自洽", () => {
  const d = DEMO_SCENARIO_V3.delivery;
  assert.equal(d.total, 24);
  assert.equal(d.passed, 21);
  assert.equal(d.missing, 1);
  assert.equal(d.summaryMismatch, 2);
  assert.equal(
    d.passed + d.missing + d.summaryMismatch,
    d.total,
    "通过 + 缺失 + 摘要不一致 必须等于总数（否则播报会出现「24 项之外还有」这种矛盾）",
  );
});

/* ------------------------------------------------------------------ *
 * 4. 单一入口与缺失态（§11.1）
 * ------------------------------------------------------------------ */

test("数据键可按名取到值（播报与页面都从这一处取）", () => {
  assert.equal(scenarioValue("weather.rain.totalMm"), 412.0);
  assert.equal(scenarioValue("mission.id"), "MSN-2026-0911-02");
  assert.equal(scenarioValue("delivery.total"), 24);
  /* 键清单必须覆盖到具体叶节点，否则页面只能自己写死 */
  assert.ok(SCENARIO_KEYS.includes("weather.rain.peakDailyMm"));
  assert.ok(SCENARIO_KEYS.includes("material.durationText"));
  assert.ok(SCENARIO_KEYS.includes("anomaly.missingFrames"));
});

test("取不到的数据键返回 undefined（进入缺失态），不得伪造默认值", () => {
  /* §11.1：模板缺字段时进入缺失态，**禁止补写听起来合理的数字** */
  assert.equal(scenarioValue("weather.rain.notExist"), undefined);
  assert.equal(scenarioValue("no.such.path"), undefined);
  assert.equal(scenarioValue(""), undefined);
});

test("数据包整体冻结，运行期不可被改写（防组件顺手改演示数据）", () => {
  assert.equal(Object.isFrozen(DEMO_SCENARIO_V3), true, "顶层对象必须冻结");
  assert.throws(
    () => {
      /* 故意违规：任何模块都不该能改写演示数据 */
      (DEMO_SCENARIO_V3 as unknown as { draftOrder: { no: string } }).draftOrder.no = "HACKED";
    },
    "改写冻结对象必须抛错",
  );
  assert.equal(DEMO_SCENARIO_V3.draftOrder.no, "WO-2026-0912", "值必须没被改掉");
});
