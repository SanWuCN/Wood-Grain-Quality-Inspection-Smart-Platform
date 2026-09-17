/**
 * 演示表面的渲染数据（工作清单 v1.0 §10 阶段 D、§11.1、§11.5）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 表面组件本身没有渲染测试环境（本仓库单测跑在 Node 下、无 DOM），
 * 但"要显示什么"是**可以**断言的：标签齐不齐、值取到没有、
 * 缺失时显示什么。这三件事恰恰是最容易出错的 ——
 * 漏一个标签，观众在投屏上看到的就是 `weather.rain.peakDailyMm`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ACTIONS } from "./demoActions.ts";
import { rowsOf } from "./demoSurfaceRows.ts";
import { FIELD_LABELS, formatValue, labelOf } from "./demoSurfaceLabels.ts";
import { scenarioValue } from "../seed/scenario.ts";

test("每个被引用的数据键都有中文标签（漏了会在投屏上显示原始键名）", () => {
  for (const action of DEMO_ACTIONS) {
    for (const key of action.dataKeys) {
      assert.ok(
        labelOf(key) !== null,
        `第 ${action.roundNo} 轮引用的键「${key}」没有中文标签 —— ` +
          `必须补进 FIELD_LABELS，否则观众看到的是原始键名`,
      );
    }
  }
});

test("标签表里已有的键都能真的取到值（防「标签写了、数据没了」）", () => {
  for (const row of DEMO_ACTIONS.flatMap((a) => rowsOf(a))) {
    assert.equal(
      row.missing,
      false,
      `键「${row.key}」取不到值（缺失态）—— 标签表与数据包不一致`,
    );
  }
});

test("rowsOf 逐键产出标签与值，且值带单位", () => {
  /* ⚠ 天气四分类表面挂在 ⑤（天气风险查询）—— 2026-09-17 剧本重排后它不是 ② 了 */
  const weather = DEMO_ACTIONS.find((a) => a.roundNo === "⑤");
  assert.ok(weather, "⑤ 轮（天气风险查询）必须存在");
  const rows = rowsOf(weather!);

  assert.equal(rows.length, weather!.dataKeys.length, "每个数据键产出一行");
  const rainTotal = rows.find((r) => r.key === "weather.rain.totalMm");
  assert.ok(rainTotal, "应有累计降雨这一行");
  assert.equal(rainTotal!.label, "累计降雨");
  assert.equal(rainTotal!.value, "412 mm", `值应带单位（实际「${rainTotal!.value}」）`);
  assert.equal(rainTotal!.demoData, true, "天气快照属于本地实测数据，必须标注来源性质");

  /* 数组值用顿号连接（编号清单、标记时间点都是数组） */
  const codesAction = DEMO_ACTIONS.find((a) => a.roundNo === "②");
  assert.ok(codesAction, "② 轮（接单整理）必须存在");
  const codes = rowsOf(codesAction!).find((r) => r.key === "components.codes");
  assert.ok(codes, "② 轮的数据键里应有平台编号这一项");
  assert.equal(codes!.value, "Z01、Z02、Z03、Z04", `数组值应顿号连接（实际「${codes!.value}」）`);
});

test("取不到值时不补写、显示为缺失态（§11.1）", () => {
  /*
    §11.1：模板缺字段时进入缺失态，**禁止补写听起来合理的数字**。
    这里用一个不存在的数据键直接验渲染函数的行为 ——
    它必须给出"缺失"标记，而不是编一个 0 或空串糊过去。
  */
  const fake = {
    roundNo: "测试",
    title: "缺失态用例",
    surface: "weather" as const,
    dataKeys: ["weather.rain.totalMm", "weather.rain.notExist"],
    simulated: true,
  };
  const rows = rowsOf(fake);
  assert.equal(rows[0].missing, false);
  assert.equal(rows[1].missing, true, "取不到的键必须标为缺失");
  assert.equal(rows[1].value, "—", "缺失时应显示占位符，而不是编一个值");
  assert.match(rows[1].label, /标签缺失/, "没有标签时也要显式说明，不能默默显示键名");
});

test("formatValue 的三种形态：数字带单位、数组顿号、空值占位", () => {
  assert.equal(formatValue(412, "mm"), "412 mm");
  assert.equal(formatValue("4分18秒"), "4分18秒", "已是文本的值不加单位");
  assert.equal(formatValue(["a", "b"]), "a、b");
  assert.equal(formatValue(undefined), "—");
  assert.equal(formatValue(null), "—");
});

/* ------------------------------------------------------------------ *
 * 预警窗（用户口径 2026-09-17）
 *
 * 「⑬ 这个触发时，会弹出预警窗口，然后带个确认按钮」。
 * 预警窗与普通数据面板的差别是"要不要人回话"，这件事必须能被证伪：
 * 标了 `alert` 却没有确认按钮，就等于"看完就没了"—— 台上没人知道该谁回话。
 * ------------------------------------------------------------------ */

test("预警窗必须带确认按钮（否则预警没人回话）", () => {
  const alerts = DEMO_ACTIONS.filter((a) => a.alert);
  assert.ok(alerts.length >= 1, "至少应有一轮是预警窗（⑬ 小木主动起头的适用性预警）");
  for (const action of alerts) {
    assert.ok(
      action.button && action.button.length > 0,
      `第 ${action.roundNo} 轮是预警窗，却没有确认按钮 —— 预警窗是要人回话的`,
    );
    /* 预警窗要真的弹得出来：标了 revealOnly 的轮次不弹浮层，两者互斥 */
    assert.notEqual(
      action.revealOnly,
      true,
      `第 ${action.roundNo} 轮既是预警窗又标了 revealOnly，浮层永远不弹 —— 自相矛盾`,
    );
    /* 确认按钮的文案不得带真实操作语义（由上面那条通用断言兜住，这里再点一次名） */
    for (const bad of ["下发设备", "刷写", "开始训练", "部署到设备"]) {
      assert.ok(
        !action.button.includes(bad),
        `第 ${action.roundNo} 轮的确认按钮「${action.button}」含真实操作语义「${bad}」`,
      );
    }
  }
});

test("预警窗的每一行都取真实数据键（不写死数字）", () => {
  for (const action of DEMO_ACTIONS.filter((a) => a.alert)) {
    assert.ok(action.dataKeys.length >= 3, `第 ${action.roundNo} 轮的预警窗只有 ${action.dataKeys.length} 行，信息不足以支撑一次判断`);
    for (const key of action.dataKeys) {
      const value = scenarioValue(key);
      assert.notEqual(value, undefined, `第 ${action.roundNo} 轮预警窗引用了不存在的数据键「${key}」`);
      assert.ok(labelOf(key) !== null, `第 ${action.roundNo} 轮预警窗的键「${key}」没有中文标签`);
    }
  }
});

test("标签文案不得出现无法核验的空话（§11.10）", () => {
  for (const [key, meta] of Object.entries(FIELD_LABELS)) {
    for (const bad of ["效果良好", "基本正常", "已完成处理", "运行良好"]) {
      assert.ok(
        !meta.label.includes(bad),
        `键「${key}」的标签含空话「${bad}」—— §11.10 要求状态说清对象与数量`,
      );
    }
  }
});
