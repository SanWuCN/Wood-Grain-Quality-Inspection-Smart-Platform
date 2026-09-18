/**
 * 环境读数录入预设（unit test）
 *
 * 这只提词器唯一会"写错"的东西就是**那几个数**和**填入顺序** —— 政府 / 文保演示里
 * 一个对不上文档的读数，比少一个功能严重。所以断言逐条对着
 * 《PRD-工单指派与扫描仪下发-v1.0》写，每条都能被写坏：
 *
 *   1. 逐字：四个读数 + 测量位置 = §9.2 示例包字段原文（改一个数、换个说法就红）；
 *   2. 顺序：四项读数 → 测量位置 → 测量时间（= 弹窗里字段自上而下的顺序）；
 *   3. 一次一项 / 只填空的 / 填满返回 `null`（提词器不越权保存、不覆盖人打的字）；
 *   4. 数值能过服务端校验：落在缺省量程与字段硬边界内（判据照抄
 *      `server/services/work-orders.mjs` 的 `INSTRUMENT_CATALOG` 与 `validate()`，
 *      不从服务端 import —— 那会让前端测试依赖 .mjs，期望值本来就该在这里再写一遍）；
 *   5. 不填 1013.25（§7.1 L218 / O3 / AC-15）；
 *   6. 气压步骤把单位一起给成 kPa（值 101 是 kPa 口径的；给成 hPa 会变成 10.1 kPa 必判红）；
 *   7. 测量时间不写死日期、不晚于当前、分钟精度（改回固定日期就红）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_PRESET_ORDER,
  ENV_PRESET_POSITION,
  ENV_PRESET_PRESSURE_UNIT,
  ENV_PRESET_READINGS,
  envPresetMeasuredAt,
  nextEnvPresetFill,
  type EnvPresetKey,
  type EnvPresetStep,
} from "./envPreset.ts";

/* ------------------------------------------------------------------ *
 * 逐字期望（剧本第 71 行沈的口播；用户 2026-09-23 拍板以剧本为准）
 * ------------------------------------------------------------------ */

const EXPECTED_READINGS = {
  airTempC: "22",
  relativeHumidityPct: "58",
  windSpeedMs: "0.6",
  atmosphericPressureHpa: "101",
} as const;

const EXPECTED_POSITION = "示例寺院内四根木柱检测区域";

/** 填入顺序 = 弹窗字段顺序；顺序变了现场就是"数字跳着出现" */
const EXPECTED_ORDER: readonly EnvPresetKey[] = [
  "airTempC",
  "relativeHumidityPct",
  "windSpeedMs",
  "atmosphericPressureHpa",
  "position",
  "measuredAt",
] as const;

/** 服务端缺省量程（`INSTRUMENT_CATALOG`：TH-01 / WS-01 / BP-01）与字段硬边界 */
const DEFAULT_RANGES = {
  airTempC: { min: -20, max: 60 },
  relativeHumidityPct: { min: 0, max: 100 },
  windSpeedMs: { min: 0, max: 30 },
  atmosphericPressureHpa: { min: 300, max: 1100 },
} as const;

/** 恒压标准大气压：只允许出现在"不得填入"的断言里（§7.1 L218 / O3） */
const STANDARD_ATMOSPHERE_HPA = 1013.25;

/** 一个固定的"按下 Enter 的那一刻"：本地墙钟 2026-09-28 09:05:41 */
const NOW = new Date(2026, 8, 28, 9, 5, 41);

/**
 * 模拟弹窗里连按 `times` 次 Enter：每一步把结果并回输入框状态。
 *
 * 调用姿势与组件里的 `fillNextPreset()` 完全一致（`{ ...values, position, measuredAt }`
 * 一起传进去），所以这里绿了、页面上就是绿的。
 */
function pressEnter(
  times: number,
  now: Date,
  initial: Partial<Record<EnvPresetKey, string>> = {},
): { state: Partial<Record<EnvPresetKey, string>>; steps: EnvPresetStep[] } {
  const state: Partial<Record<EnvPresetKey, string>> = { ...initial };
  const steps: EnvPresetStep[] = [];
  for (let index = 0; index < times; index += 1) {
    const step = nextEnvPresetFill(state, now);
    if (!step) break;
    state[step.key] = step.value;
    steps.push(step);
  }
  return { state, steps };
}

/* ------------------------------------------------------------------ *
 * 1. 逐字：与 PRD §9.2 示例包字段一致
 * ------------------------------------------------------------------ */

test("四个读数逐字等于 PRD §9.2 示例包字段", () => {
  assert.deepEqual(
    { ...ENV_PRESET_READINGS },
    { ...EXPECTED_READINGS },
    "读数只能照文档抄，不得另编一套「看着差不多」的值",
  );
});

test("测量位置逐字等于 PRD §9.2 示例包字段", () => {
  assert.equal(ENV_PRESET_POSITION, EXPECTED_POSITION);
});

test("读数都是可解析的有限数（不是「26.4 ℃」这种带货单位文本）", () => {
  for (const [key, text] of Object.entries(ENV_PRESET_READINGS)) {
    const value = Number(text);
    assert.ok(Number.isFinite(value), `${key} 必须是纯数值文本，实际：${text}`);
    assert.equal(text.trim(), text, `${key} 首尾不得带空白，否则输入框里会看着脏`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 顺序：与弹窗字段自上而下的顺序一致
 * ------------------------------------------------------------------ */

test("填入顺序固定为 四项读数 → 测量位置 → 测量时间", () => {
  assert.equal(ENV_PRESET_ORDER.length, 6, "六项 = 弹窗里可填的全部字段，多一项少一项都要说清");
  assert.deepEqual([...ENV_PRESET_ORDER], [...EXPECTED_ORDER], "顺序即演示口径，不得重排");
  assert.equal(new Set(ENV_PRESET_ORDER).size, 6, "同一项不能在顺序表里出现两次");
});

/* ------------------------------------------------------------------ *
 * 3. 一次一项 / 只填空的 / 填满即止
 * ------------------------------------------------------------------ */

test("连按 6 次 Enter：按顺序一次填一项，六项齐全且与文档逐字一致", () => {
  const { state, steps } = pressEnter(6, NOW);
  assert.deepEqual(steps.map((step) => step.key), [...EXPECTED_ORDER], "每次只填一项，且按顺序");
  assert.equal(state.airTempC, EXPECTED_READINGS.airTempC);
  assert.equal(state.relativeHumidityPct, EXPECTED_READINGS.relativeHumidityPct);
  assert.equal(state.windSpeedMs, EXPECTED_READINGS.windSpeedMs);
  assert.equal(state.atmosphericPressureHpa, EXPECTED_READINGS.atmosphericPressureHpa);
  assert.equal(state.position, EXPECTED_POSITION);
  assert.equal(state.measuredAt, envPresetMeasuredAt(NOW));
});

test("六项填满后第 7 次 Enter 无事发生（返回 null，不自动保存也不自动校验）", () => {
  const { state } = pressEnter(6, NOW);
  assert.equal(nextEnvPresetFill(state, NOW), null);
});

test("人打的字不被覆盖：已有输入（含首尾空白的位置文本）原样保留", () => {
  const { state, steps } = pressEnter(6, NOW, { airTempC: "25.1", position: "  现场手打的位置  " });
  assert.equal(state.airTempC, "25.1", "手打的读数不得被预置值冲掉");
  assert.equal(state.position, "  现场手打的位置  ", "手打的位置文本（连空白）不得被改写");
  assert.deepEqual(
    steps.map((step) => step.key),
    ["relativeHumidityPct", "windSpeedMs", "atmosphericPressureHpa", "measuredAt"],
    "已填的项要跳过，只往前走",
  );
});

test("纯空白算没填（与组件判空口径一致，不拿 Number('') 当 0）", () => {
  const { state } = pressEnter(1, NOW, { airTempC: "   " });
  assert.equal(state.airTempC, EXPECTED_READINGS.airTempC);
  const blankPosition = pressEnter(5, NOW, { position: "  " });
  assert.equal(blankPosition.state.position, EXPECTED_POSITION, "空白位置同样要补上");
});

/* ------------------------------------------------------------------ *
 * 4. 数值过得了服务端校验
 * ------------------------------------------------------------------ */

/**
 * 气压换算（与 `server/services/work-orders.mjs` 的 §7.1 同一口径）：
 * 1 hPa = 100 Pa、1 kPa = 10 hPa。**必须按预设值自己的单位换算再比量程** ——
 * 量程 300–1100 是 hPa 口径，而预设现在是 `101 kPa`（= 1010 hPa）。
 */
const HPA_PER_UNIT: Record<string, number> = { hPa: 1, kPa: 10, Pa: 0.01 };

test("四项读数落在缺省量程与字段硬边界内（照抄服务端 validate 的判据）", () => {
  for (const [key, range] of Object.entries(DEFAULT_RANGES)) {
    const raw = Number(ENV_PRESET_READINGS[key as keyof typeof ENV_PRESET_READINGS]);
    const value =
      key === "atmosphericPressureHpa" ? raw * (HPA_PER_UNIT[ENV_PRESET_PRESSURE_UNIT] ?? 1) : raw;
    assert.ok(
      value >= range.min && value <= range.max,
      `${key} = ${raw} ${key === "atmosphericPressureHpa" ? ENV_PRESET_PRESSURE_UNIT : ""}（${value} hPa）超出量程 ${range.min}–${range.max}，按 Enter 后校验会判红`,
    );
  }
  assert.ok(Number(ENV_PRESET_READINGS.windSpeedMs) >= 0, "风速非负");
  assert.ok(Number(ENV_PRESET_READINGS.atmosphericPressureHpa) > 0, "大气压必须为正");
});

test("不填 1013.25（恒压标准大气压不是现场实测值）", () => {
  assert.notEqual(
    Number(ENV_PRESET_READINGS.atmosphericPressureHpa),
    STANDARD_ATMOSPHERE_HPA,
    "O3 / AC-15：系统不得自动填入 1013.25 hPa，预设也不许",
  );
});

/* ------------------------------------------------------------------ *
 * 5. 气压：值与单位绑定
 * ------------------------------------------------------------------ */

test("气压那一步连单位一起给 kPa（值 101 是 kPa 口径的）", () => {
  const { steps } = pressEnter(6, NOW);
  const pressure = steps.find((step) => step.key === "atmosphericPressureHpa");
  assert.ok(pressure, "顺序表里必须有气压项");
  assert.equal(
    "unit" in pressure ? pressure.unit : null,
    ENV_PRESET_PRESSURE_UNIT,
    "气压步骤必须带上单位",
  );
  assert.equal(ENV_PRESET_PRESSURE_UNIT, "kPa", "预设值 101 是 kPa 口径的（剧本念的是「101千帕」），单位只能是 kPa");
  /* 换算到 hPa 必须落在量程内：101 kPa = 1010 hPa */
  assert.equal(
    Number(ENV_PRESET_READINGS.atmosphericPressureHpa) * HPA_PER_UNIT[ENV_PRESET_PRESSURE_UNIT],
    1010,
    "101 kPa 应当换算成 1010 hPa（服务端按这个值落库与校验）",
  );
});

test("其余三项读数不带单位（单位由字段标签给出，输入框里只放数字）", () => {
  const { steps } = pressEnter(6, NOW);
  for (const key of ["airTempC", "relativeHumidityPct", "windSpeedMs"] as const) {
    const step = steps.find((item) => item.key === key);
    assert.ok(step);
    assert.ok(!("unit" in step) || step.unit === undefined, `${key} 不该带单位`);
  }
});

/* ------------------------------------------------------------------ *
 * 6. 测量时间：按现场墙钟生成
 * ------------------------------------------------------------------ */

test("测量时间是 YYYY-MM-DDTHH:mm 的分钟精度文本", () => {
  assert.match(envPresetMeasuredAt(NOW), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test("测量时间取的是现场墙钟：年月日时分逐个对上，且截到分钟（不晚于此刻）", () => {
  const text = envPresetMeasuredAt(NOW);
  assert.equal(text, "2026-09-28T09:05");
  assert.ok(new Date(text).getTime() <= NOW.getTime(), "截到分钟只会比此刻更早，绝不会跑到未来");
});

test("测量时间不写死日期：两个不同的时刻必须给出两个不同的值", () => {
  const other = new Date(2026, 11, 31, 23, 59, 59);
  assert.notEqual(
    envPresetMeasuredAt(NOW),
    envPresetMeasuredAt(other),
    "写死日期迟早把演示卡在「测量时间不晚于服务端时间」这条校验上",
  );
  assert.equal(envPresetMeasuredAt(other), "2026-12-31T23:59");
});

test("取值的基准时刻由调用方给：同一次按键里六项用的是同一个 now", () => {
  const { state } = pressEnter(6, NOW);
  assert.equal(state.measuredAt, envPresetMeasuredAt(NOW));
});

/* ------------------------------------------------------------------ *
 * 7. 受控配置不可变
 * ------------------------------------------------------------------ */

test("顺序表与读数表是冻结的，改不动", () => {
  assert.ok(Object.isFrozen(ENV_PRESET_ORDER));
  assert.ok(Object.isFrozen(ENV_PRESET_READINGS));
  assert.throws(() => {
    (ENV_PRESET_READINGS as { airTempC: string }).airTempC = "30";
  }, "冻结的读数表必须改不动");
  assert.throws(() => {
    (ENV_PRESET_ORDER as EnvPresetKey[]).push("position");
  }, "冻结的顺序表必须加不进新项");
  assert.equal(ENV_PRESET_READINGS.airTempC, EXPECTED_READINGS.airTempC, "被拒的改动不能留下痕迹");
});
