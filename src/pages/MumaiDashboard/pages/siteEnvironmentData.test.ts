/**
 * 现场环境页的数据装配（`siteEnvironment.ts`）
 *
 * 这一层全是纯函数，所以"页面上会出现什么数"能被逐条断言。四条判据针对的都是
 * 已经在别处踩过的坑：
 *   · **数字只有一个来源** —— 天气四分类的每个值都必须等于 `scenarioValue()` 的返回值，
 *     页面上另写一套数就是 §11.5 禁止的"同一指标三个文件三个数"；
 *   · **空值不是 0** —— 没录入时显示「—」，不许把 0 / 26.4 / 78 这类默认值画上去（A09）；
 *   · **不联网、不假装实时** —— 来源文案里必须有"未启用联网查询"，不许出现"实时"；
 *   · **没有已校验版本就不编建议** —— 对照表整表进「待核验」（剧本原话）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EnvironmentView } from "../api/client.ts";
import { scenarioValue } from "../seed/scenario.ts";
import {
  compensationCompare,
  currentEnvReadings,
  humidityPrior,
  orderSiteRows,
  riskChecklist,
  rowsOfKeys,
  weatherCategories,
  weatherSource,
} from "./siteEnvironmentData.ts";

/** 一份"已录入 + 已校验"的环境实体（字段与 `EnvironmentView` 对齐，数值取自演示数据包） */
function envView(overrides: Partial<EnvironmentView> = {}): EnvironmentView {
  const inputs = {
    airTempC: 26.4,
    relativeHumidityPct: 78,
    windSpeedMs: 1.2,
    atmosphericPressureHpa: 1008.6,
  };
  return {
    draftRevision: 3,
    inputs,
    instruments: [],
    pressureInput: { value: 1008.6, unit: "hPa", hpa: 1008.6 },
    position: "示例寺院内四根木柱检测区域",
    measuredAt: "2026-09-11T12:26",
    needsRevalidate: false,
    updatedAt: "2026-09-11T12:26",
    updatedByLabel: "史 · 人工智能架构师",
    config: {
      configVersion: "CFG-02",
      draftRevision: 3,
      inputs,
      instruments: [],
      position: "示例寺院内四根木柱检测区域",
      measuredAt: "2026-09-11T12:26",
      checks: [
        { key: "airTempC", label: "温度是有限数值", ok: true, field: "airTempC", message: "当前 26.4 ℃" },
        {
          key: "windSpeedMs",
          label: "风速非负（0 是有效静风记录）",
          ok: true,
          field: "windSpeedMs",
          message: "当前 1.2 m/s；风速只作采集稳定性记录，不代入含水率模型",
        },
      ],
      methodVersion: "hh-emc-v1.2",
      validatedByLabel: "沈 · 项目经理",
      validatedAt: "2026-09-11T12:41",
      superseded: false,
    },
    catalog: [],
    fields: [
      { key: "airTempC", label: "温度", unit: "℃" },
      { key: "relativeHumidityPct", label: "相对湿度", unit: "%RH" },
      { key: "windSpeedMs", label: "风速", unit: "m/s" },
      { key: "atmosphericPressureHpa", label: "大气压", unit: "hPa" },
    ],
    ...overrides,
  };
}

test("天气四分类：四类齐全，且每个值都等于数据包里的值（单一来源）", () => {
  const categories = weatherCategories();
  assert.deepEqual(
    categories.map((item) => item.key),
    ["rain", "humidity", "wind", "temperature"],
  );
  for (const category of categories) {
    assert.ok(category.rows.length >= 1, `${category.title} 一类没有数据行`);
    for (const row of category.rows) {
      assert.ok(!row.label.startsWith("〔标签缺失"), `${row.key} 在标签表里没有中文标签`);
      assert.notEqual(row.value, "—", `${row.key} 取不到值 —— 数据键写错了或数据包改过`);
      /* 渲染出来的值必须以数据包里的原始值为准（不在这里二次加工） */
      assert.ok(
        row.value.startsWith(String(scenarioValue(row.key))),
        `${row.key} 显示的 ${row.value} 与数据包的 ${String(scenarioValue(row.key))} 不一致`,
      );
    }
    assert.ok(category.risks.length >= 1, `${category.title} 一类没有风险项`);
  }
});

test("数据键缺标签时不抛键名给观众（退化成「标签缺失」提示，值给「—」）", () => {
  const rows = rowsOfKeys(["weather.rain.totalMm", "weather.not.exists"]);
  assert.equal(rows[0].label, "累计降雨");
  assert.equal(rows[1].value, "—");
  assert.ok(rows[1].label.includes("标签缺失"));
});

test("风险清单：来自四类档案、去重、只讲优先检查项", () => {
  const risks = riskChecklist();
  assert.ok(risks.length >= 4, `风险项只有 ${risks.length} 条，剧本里四类各有点名的风险`);
  const items = risks.map((item) => item.item);
  assert.equal(new Set(items).size, items.length, "风险清单里有重复项");
  for (const risk of risks) assert.match(risk.from, /类档案$/);
});

test("来源口径：归档档案 + 未启用联网查询，且不出现「实时」", () => {
  const source = weatherSource();
  assert.match(source.source, /未启用联网查询/);
  assert.doesNotMatch(source.source, /实时/);
  assert.doesNotMatch(source.note, /实时/);
  assert.match(source.range, /近三个月/);
  assert.ok(source.range.includes(String(scenarioValue("weather.rangeStart"))));
});

test("没录入时读数是「—」而不是 0（A09）", () => {
  const empty = currentEnvReadings(null);
  assert.equal(empty.state, "pending");
  assert.deepEqual(empty.readings, []);

  const blank = envView({
    inputs: { airTempC: null, relativeHumidityPct: null, windSpeedMs: null, atmosphericPressureHpa: null },
    config: null,
  });
  const view = currentEnvReadings(blank);
  assert.equal(view.state, "pending");
  assert.deepEqual(
    view.readings.map((row) => row.value),
    ["—", "—", "—", "—"],
  );
  assert.equal(view.configVersion, null);
});

test("已录入时四项读数带单位，测量信息取服务端实体", () => {
  const view = currentEnvReadings(envView());
  assert.equal(view.state, "recorded");
  assert.deepEqual(
    view.readings.map((row) => row.value),
    ["26.4 ℃", "78 %RH", "1.2 m/s", "1008.6 hPa"],
  );
  assert.equal(view.configVersion, "CFG-02");
  assert.equal(view.configValidatedAt, "2026-09-11T12:41");
  assert.equal(view.meta.find((row) => row.k === "测量位置")?.v, "示例寺院内四根木柱检测区域");
});

test("参数建议：没有已校验版本时整表「待核验」，不编建议值", () => {
  const advice = compensationCompare(envView({ config: null }));
  assert.equal(advice.state, "pending");
  assert.equal(advice.methodVersion, null);
  assert.equal(advice.rows.length, 4);
  for (const row of advice.rows) {
    assert.equal(row[2], "待核验");
    assert.match(row[3], /尚未生成配置版本/);
  }
  assert.match(advice.note, /只形成建议/);
});

test("参数建议：有已校验版本时逐项给「当前录入 / 已校验 / 依据」", () => {
  const advice = compensationCompare(envView());
  assert.equal(advice.state, "ready");
  assert.equal(advice.methodVersion, "hh-emc-v1.2");
  assert.equal(advice.rows.length, 4);
  const wind = advice.rows.find((row) => row[0] === "风速");
  assert.ok(wind, "对照表里没有风速这一项");
  assert.equal(wind?.[1], "1.2 m/s");
  assert.match(String(wind?.[2]), /CFG-02/);
  assert.match(String(wind?.[3]), /不代入含水率模型/, "依据必须取服务端校验结论的原文");
});

test("HH 先验的口径里写明风速不代入", () => {
  const prior = humidityPrior();
  assert.equal(prior.model, "Hailwood-Horrobin");
  assert.match(prior.note, /不能直接当成木柱内部实测含水率/);
  assert.match(prior.windNote, /不代入/);
});

test("现场与工单：没有选中工单时给出空态行，不编地点", () => {
  const rows = orderSiteRows(null);
  assert.equal(rows.find((row) => row.k === "工单")?.v, "未选中工单");
  assert.equal(rows.find((row) => row.k === "现场地点")?.v, "—");
});

test("现场地点：服务端 location 已经带区县时不再拼一遍（避免「…松江区… · 上海市松江区」）", () => {
  const detail = {
    order: {
      id: "wo-1",
      orderNo: "WO-2026-0001",
      revision: 1,
      assignmentRevision: 0,
      status: "待指派" as const,
      pausedFrom: null,
      title: "示例寺古建筑检测",
      source: "平台新建",
      location: "上海市松江区示例寺院内",
      district: "上海市松江区",
      plannedStart: "2026-09-20",
      plannedEnd: "2026-09-22",
      schedulePrecision: "day",
      timeZone: "Asia/Shanghai",
      requirementsText: "",
      deliveryText: "",
      createdAt: "2026-09-18T10:00:00+08:00",
      updatedAt: "2026-09-18T10:00:00+08:00",
    },
    commission: {
      title: "红头委托",
      unit: "示例古建筑保护管理单位",
      date: "2026-09-18",
      no: null,
      projectName: "示例寺古建筑检测",
      address: "上海市松江区",
      subjectNote: "",
      scope: "",
      deliveryText: "",
      contact: { role: "项目经理", channel: "平台" },
      attachments: [],
      sourceMode: "live",
    },
    subjects: [{ subjectId: "s1", code: "Z01", type: "木柱", name: "木柱一", position: null, positionStatus: "pending" as const }],
  } as unknown as Parameters<typeof orderSiteRows>[0];

  const place = orderSiteRows(detail).find((row) => row.k === "现场地点")?.v;
  assert.equal(place, "上海市松江区示例寺院内");
  assert.equal(orderSiteRows(detail).find((row) => row.k === "检测主体")?.v, "Z01");
});
