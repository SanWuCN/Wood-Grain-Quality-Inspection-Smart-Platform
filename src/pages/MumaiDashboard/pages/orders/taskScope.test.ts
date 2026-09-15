/**
 * 任务范围与出发清单的**受控配置**（unit test）
 *
 * ── 为什么测数据而不是组件 ───────────────────────────────────────────
 * Node 原生测试没有 DOM，也不许为这一个面板新增渲染依赖；而这块面板里唯一
 * 会"写错"的东西就是**文案本身** —— 政府 / 文保类演示里写错一句比样式丑严重得多。
 *
 * 《新工单红头委托与小木联动-AI交接文档 v1.0》§四项任务与出发清单 / §附件未明确信息：
 *   · 四项任务与四组装备是"本演示的确定性整理结果"，不允许由模型自由改写或增删；
 *   · 出发清单"应作为代码内受控配置或服务端字段维护，不得根据图片内容临时生成"；
 *   · 附件未明确的项必须显示为「待现场确认」或「附件未明确」，不得补写成确定事实。
 *
 * 所以这组断言盯的是三件事，每一条都**能被写坏**（改一个字、调一次顺序、
 * 顺手把平台内部编号塞进委托侧文案、少写一次 freeze，下面就会红）：
 *
 *   1. 结构：恰好 4 项任务 / 4 组装备，顺序与序号固定；每组文案逐字等值
 *   2. 防幻觉：不得出现 Z01–Z04、「雷达」「置信度」「缺陷位置」，待确认项不得给确定值
 *   3. 不可变：导出是冻结的，改它不会影响下一次读取
 *
 * ⚠ 期望值在这里**再写一遍**（而不是 import 后被测对象自比）：带着 `as const`
 *   的断言在编译期就把字面量钉死，运行时又是逐字等值 —— 直接把 `FOUR_TASKS`
 *   抄进期望里那种"自己跟自己比"的写法不会出现在这里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEPARTURE_KIT, FOUR_TASKS, TO_CONFIRM } from "./taskScope.ts";

/* ------------------------------------------------------------------ *
 * 逐字期望（交接文档 v1.0 原文，去句末语气词）
 * ------------------------------------------------------------------ */

/** 四项任务：名称与说明都是文档原话，一个字不能改 */
const EXPECTED_TASKS = [
  { no: 1, name: "现场建档", detail: "用于逐根确认位置、拍摄影像并记录现场环境" },
  { no: 2, name: "风险初筛", detail: "用于依据现场可见信息形成待复核清单，不预先写入检测结论" },
  { no: 3, name: "重点精扫", detail: "用于对现场确认的重点区域执行非破坏性精细采集" },
  { no: 4, name: "复核交付", detail: "用于核对原始数据、影像、记录和成果报告的可追溯性" },
] as const;

/** 出发清单：四组装备，组名与顺序即演示口径 */
const EXPECTED_KIT = [
  { group: "建档装备", items: "相机、备用电池、尺寸标尺、构件编号牌和现场记录终端" },
  { group: "环境记录装备", items: "温湿度仪、风速仪及对应校准记录" },
  { group: "精扫装备", items: "手持扫描仪、备用电池、数据线和存储介质" },
  { group: "安全装备", items: "安全帽、防滑手套、警示隔离带和急救包" },
] as const;

/** 平台内部编号：属于服务端事务生成的事实，**不得**混进委托侧文案 */
const PLATFORM_ONLY_IDS = ["Z01", "Z02", "Z03", "Z04"] as const;

/** 平台内部结论词：未产生风险记录前不得出现（防幻觉硬规则第 6 条） */
const PLATFORM_ONLY_TERMS = ["雷达", "置信度", "缺陷位置"] as const;

/** 三块内容的序列化文本：防幻觉交叉检查都在它上面做 */
function serialized(): string {
  return [
    ...FOUR_TASKS.map((item) => `${item.no} ${item.name} ${item.detail}`),
    ...DEPARTURE_KIT.map((kit) => `${kit.group} ${kit.items}`),
    ...TO_CONFIRM,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 1. 四项任务：数量、顺序、序号
 * ------------------------------------------------------------------ */

test("四项任务恰好 4 项，顺序固定为 现场建档 → 风险初筛 → 重点精扫 → 复核交付", () => {
  assert.equal(FOUR_TASKS.length, 4, "多一项或漏一项都属于改动演示口径");
  assert.deepEqual(
    FOUR_TASKS.map((item) => item.name),
    ["现场建档", "风险初筛", "重点精扫", "复核交付"],
    "顺序即播报口径（第①轮台词按此顺序念），不得重排",
  );
});

test("四项任务序号为 1..4 且连续", () => {
  assert.deepEqual(
    FOUR_TASKS.map((item) => item.no),
    [1, 2, 3, 4],
    "序号必须连续；跳号会让面板上的「01/02/03/04」与任务对不上",
  );
});

/* ------------------------------------------------------------------ *
 * 2. 四项任务说明：逐条等值（不是"包含"）
 * ------------------------------------------------------------------ */

test("四项任务名称与说明逐字匹配交接文档 v1.0", () => {
  for (const expected of EXPECTED_TASKS) {
    const actual = FOUR_TASKS.find((item) => item.no === expected.no);
    assert.ok(actual, `缺少序号 ${expected.no} 的任务`);
    assert.equal(actual.name, expected.name, `序号 ${expected.no} 的任务名称必须逐字一致`);
    assert.equal(actual.detail, expected.detail, `「${expected.name}」的说明必须逐字一致`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. 出发清单：四组，逐字
 * ------------------------------------------------------------------ */

test("出发清单恰好 4 组，组名与顺序逐字匹配", () => {
  assert.equal(DEPARTURE_KIT.length, 4, "装备分组是预设值，不得增删");
  assert.deepEqual(
    DEPARTURE_KIT.map((kit) => kit.group),
    ["建档装备", "环境记录装备", "精扫装备", "安全装备"],
  );
});

test("每组装备文本逐字匹配交接文档 v1.0", () => {
  for (const expected of EXPECTED_KIT) {
    const actual = DEPARTURE_KIT.find((kit) => kit.group === expected.group);
    assert.ok(actual, `缺少分组「${expected.group}」`);
    assert.equal(actual.items, expected.items, `「${expected.group}」的装备文本必须逐字一致`);
  }
});

test("每组装备文本非空且不是占位符（空串会让面板看着像没写完）", () => {
  for (const kit of DEPARTURE_KIT) {
    assert.ok(kit.items.trim().length > 0, `「${kit.group}」的装备文本不能为空`);
    assert.ok(!kit.items.includes("—"), `「${kit.group}」不能拿占位符充当装备文本`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 待确认清单：只陈述"待确认"，不给确定值
 * ------------------------------------------------------------------ */

test("待确认清单至少 6 项且每项非空", () => {
  assert.ok(TO_CONFIRM.length >= 6, `附件未明确的项不得被"精简"掉（实际 ${TO_CONFIRM.length} 项）`);
  for (const item of TO_CONFIRM) {
    assert.ok(item.trim().length > 0, "待确认项不能是空串");
  }
});

test("待确认项不得给确定值：无 Z01–Z04 编号、无结论式写法、无 11 位手机号", () => {
  for (const item of TO_CONFIRM) {
    for (const id of PLATFORM_ONLY_IDS) {
      assert.ok(!item.includes(id), `待确认项不得出现平台内部编号 ${id}（实际：${item}）`);
    }
    /*
      结论式写法："树种：银杏"「含水率 14.2%」这类把待确认项直接写成事实的排版。
      注意只扫**中文冒号 / 半角冒号紧跟取值**与"含水率"本身 —— 正常句子里的
      "现场联系人姓名和电话号码"不含冒号，不会被误伤。
    */
    assert.ok(
      !/[：:]\s*\S/.test(item),
      `待确认项不得用「标签：取值」的确定值写法（实际：${item}）`,
    );
    assert.ok(!item.includes("含水率"), `待确认项不得给出含水率读数（实际：${item}）`);
    assert.ok(
      !/\d{11}/.test(item),
      `待确认项不得出现 11 位手机号（实际：${item}）`,
    );
  }
});

test("待确认项必须落在「附件未明确信息」的范围内，且指向现场核对", () => {
  const joined = TO_CONFIRM.join("\n");
  assert.match(joined, /位置/, "四根木柱的位置属于附件未明确项");
  assert.match(joined, /现场联系人/, "现场联系人属于附件未明确项");
  assert.match(joined, /校准/, "仪器校准有效性属于附件未明确项");
  assert.match(joined, /安全边界|封控|进场动线/, "现场安全边界属于附件未明确项");
});

/* ------------------------------------------------------------------ *
 * 5. 防幻觉交叉检查
 * ------------------------------------------------------------------ */

test("受控配置里不得混入平台内部编号与平台内部结论词", () => {
  const text = serialized();
  for (const id of PLATFORM_ONLY_IDS) {
    assert.ok(!text.includes(id), `平台内部编号 ${id} 不得出现在委托侧文案里`);
  }
  for (const term of PLATFORM_ONLY_TERMS) {
    assert.ok(!text.includes(term), `平台内部结论词「${term}」不得出现在委托侧文案里`);
  }
});

test("受控配置里不得出现树种 / 风险等级 / 含水率的确定值写法", () => {
  const text = serialized();
  assert.ok(!/[：:]\s*\S/.test(text), "受控配置里不得出现「标签：取值」的确定值写法");
  assert.ok(!/\d{11}/.test(text), "受控配置里不得出现 11 位手机号");
  assert.ok(!text.includes("含水率"), "含水状态属于待现场确认项，不得写成读数");
});

/* ------------------------------------------------------------------ *
 * 6. 不可变性：改导出数组不影响下一次读取
 * ------------------------------------------------------------------ */

test("三个导出都是冻结的（数组与元素）", () => {
  assert.ok(Object.isFrozen(FOUR_TASKS), "FOUR_TASKS 必须是冻结的受控配置");
  assert.ok(Object.isFrozen(DEPARTURE_KIT), "DEPARTURE_KIT 必须是冻结的受控配置");
  assert.ok(Object.isFrozen(TO_CONFIRM), "TO_CONFIRM 必须是冻结的受控配置");
  for (const item of FOUR_TASKS) assert.ok(Object.isFrozen(item), "任务条目必须一并冻结");
  for (const kit of DEPARTURE_KIT) assert.ok(Object.isFrozen(kit), "装备分组必须一并冻结");
});

test("尝试改动导出会被拒绝，且下一次读取拿到的还是原文案", () => {
  /* 冻结后写属性会抛 TypeError（ESM 恒为严格模式）；这里只断言"改不动"，不依赖报错类型 */
  assert.throws(() => {
    (FOUR_TASKS[0] as { detail: string }).detail = "模型改写的说明";
  }, "冻结的任务说明必须改不动");
  assert.throws(() => {
    (DEPARTURE_KIT as unknown as { group: string }[]).push({ group: "临时加的组" });
  }, "冻结的装备分组必须加不进新组");
  assert.throws(() => {
    (TO_CONFIRM as unknown as string[]).push("顺手补的一条确定事实");
  }, "冻结的待确认清单必须加不进新项");

  assert.equal(FOUR_TASKS[0].detail, EXPECTED_TASKS[0].detail, "被拒的改动不能留下痕迹");
  assert.equal(FOUR_TASKS.length, 4);
  assert.equal(DEPARTURE_KIT.length, 4);
  assert.equal(TO_CONFIRM.length >= 6, true);
});
