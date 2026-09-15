/**
 * 红头委托预览的**展示数据推导**（`buildCommissionView`）
 *
 * ── 为什么测纯函数而不是组件 ─────────────────────────────────────────
 * Node 原生测试没有 DOM，也不许为这一个组件新增测试依赖；
 * 而组件里唯一会"写错字"的地方就是「从工单详情推导要显示什么」这一步。
 * 把这一步抽成 `commissionView.ts` 的纯函数后，防幻觉规则变成可证伪的断言：
 *
 *   1. 正常详情：单位 / 标题 / 段落 / 落款 / 附件逐项与 detail 等值
 *   2. 受限详情：`restricted === true` 且正文与附件为空（防"受限还漏正文"）
 *   3. 字段缺失：输出里不得出现 `undefined` / `null` / `NaN` 字面量
 *   4. 不出现幻觉内容：平台内部编号（Z01~Z04）、"风险等级"、"树种" 一律不得进正文
 *   5. 附件名称逐字来自 detail，不改写、不补全
 *
 * 这些断言都是**可被写坏的**：把推导逻辑换成"从常识补一段委托文"、
 * 把受限分支写成只看 `attachments.length`、或者手滑 `String(undefined)`，
 * 下面每一条都会红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCommissionView } from "./commissionView.ts";
import type { WorkOrderDetail } from "../../api/client";

/* ------------------------------------------------------------------ *
 * 夹具：只用**假对象**，不连服务端、不读接口
 * ------------------------------------------------------------------ */

function makeDetail(over: {
  restricted?: boolean;
  requirementsText?: string | null;
  title?: string | null;
  unit?: string | null;
  date?: string | null;
} = {}): WorkOrderDetail {
  return {
    restricted: over.restricted ?? false,
    order: {
      id: "order-fixture-1",
      orderNo: "WO-2026-0001",
      revision: 1,
      assignmentRevision: 0,
      status: "待指派",
      pausedFrom: null,
      /*
        ⚠ 平台标题里合法地带着 Z01 / 风险等级 / 树种等**平台内部词**：
        它们属于工单，不属于委托原文。预览只允许取委托口径，
        这条夹具就是把"误把 order 字段当委托正文"的写法钉在测试里。
      */
      title: "示例寺古建筑检测 · 四根木柱检测",
      source: "shortcut",
      location: "上海市松江区示例寺院内",
      district: "上海市松江区",
      plannedStart: "2026-09-18",
      plannedEnd: "2026-09-20",
      schedulePrecision: "date",
      timeZone: "Asia/Shanghai",
      requirementsText: over.requirementsText === undefined
        ? "为掌握示例寺现场木柱保存状况，现委托贵方对四根木柱开展现场检测。检测范围限于上述四根木柱。"
        : (over.requirementsText as string),
      deliveryText: "检测记录及成果报告",
      createdAt: "2026-09-16T09:30:00.000Z",
      updatedAt: "2026-09-16T09:30:00.000Z",
    },
    commission: {
      title: over.title === undefined
        ? "关于开展示例寺四根木柱检测工作的委托"
        : (over.title as string),
      unit: over.unit === undefined ? "示例古建筑保护管理单位" : (over.unit as string),
      date: over.date === undefined ? "2026-09-16" : (over.date as string),
      no: null,
      projectName: "示例寺古建筑检测",
      address: "示例寺院内",
      subjectNote: "示例寺院内，具体位置进场核对",
      scope: "现场四根木柱的非破坏性检测",
      deliveryText: "检测记录及成果报告",
      contact: { role: "现场管理岗位", channel: "进场时间与资料交接由现场值班渠道联系" },
      attachments: [
        {
          assetId: "asset-commission-1",
          name: "示例寺建筑平面示意图.pdf",
          kind: "图纸",
          sizeText: "1.2 MB",
          sourceMode: "replay",
        },
        {
          assetId: "asset-commission-2",
          name: "现场进场与开放时间安排.docx",
          kind: "说明",
          sizeText: "86 KB",
          sourceMode: "replay",
        },
      ],
      sourceMode: "replay",
    },
    subjects: [],
  } as unknown as WorkOrderDetail;
}

/**
 * 把所有**可读文本**摊平成一个字符串。
 *
 * 防幻觉断言必须在"用户真能看见的全部文字"上做，
 * 只查 `paragraphs` 会漏掉附件名、落款、摘要这些同样会被渲染的字段。
 */
function readableText(view: ReturnType<typeof buildCommissionView>): string {
  return [
    view.headUnit,
    view.title,
    ...view.paragraphs,
    view.signUnit,
    view.signDate,
    view.restrictedNote,
    ...view.placeholders,
    ...view.summary.map((item) => `${item.k}：${item.v}`),
    ...view.attachments.map((item) => `${item.name}|${item.kind}|${item.sizeText}`),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 1. 正常详情：逐项等值
 * ------------------------------------------------------------------ */

test("正常详情：单位 / 标题 / 段落 / 落款逐项与 detail 一致", () => {
  const detail = makeDetail();
  const view = buildCommissionView(detail);

  assert.equal(view.restricted, false, "可看全量的详情不该被判成受限");
  assert.equal(view.headUnit, detail.commission.unit);
  assert.equal(view.title, detail.commission.title);
  assert.equal(view.signUnit, detail.commission.unit, "落款单位必须与红头单位同源");
  assert.equal(view.signUnit, view.headUnit);

  assert.ok(view.paragraphs.length >= 2, `长正文应分段排版，实际只有 ${view.paragraphs.length} 段`);
  assert.equal(
    view.paragraphs.join(""),
    detail.order.requirementsText,
    "分段只能切分，不得增删一个字（严禁改写正文）",
  );
});

test("落款日期：ISO 日期排成中文写法，已是中文的写法原样不动", () => {
  const iso = buildCommissionView(makeDetail({ date: "2026-09-16" }));
  assert.equal(iso.signDate, "2026 年 9 月 16 日", `ISO 日期没有排成中文：${iso.signDate}`);

  /*
    接口若直接给出中文日期（服务端 `dateText` 口径），必须**原样显示**：
    再排一次就会变成「2026 年 9 月 16 日」以外的怪写法，测试在这里钉死。
  */
  const cn = buildCommissionView(makeDetail({ date: "2026 年 9 月 16 日" }));
  assert.equal(cn.signDate, "2026 年 9 月 16 日");
});

test("正常详情：段落按句号切分且每段都带句末标点、不留空白段", () => {
  const view = buildCommissionView(makeDetail());
  for (const [index, paragraph] of view.paragraphs.entries()) {
    assert.ok(paragraph.trim().length > 0, `第 ${index + 1} 段是空白段`);
    assert.ok(
      /[。！？；]$/.test(paragraph),
      `第 ${index + 1} 段没有句末标点，说明切分切碎了句子：${paragraph}`,
    );
  }
});

test("正常详情：附件条数与名称 / 类型 / 大小逐条等值", () => {
  const detail = makeDetail();
  const view = buildCommissionView(detail);

  assert.equal(view.attachments.length, detail.commission.attachments.length);
  for (const [index, expected] of detail.commission.attachments.entries()) {
    const actual = view.attachments[index];
    assert.equal(actual.name, expected.name, `第 ${index + 1} 个附件名被改写了`);
    assert.equal(actual.kind, expected.kind);
    assert.equal(actual.sizeText, expected.sizeText);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 受限详情：正文与附件一条都不许漏
 * ------------------------------------------------------------------ */

test("受限详情：restricted 为真，正文段落与附件为空", () => {
  const detail = makeDetail({ restricted: true });
  const view = buildCommissionView(detail);

  assert.equal(view.restricted, true);
  assert.deepEqual(view.paragraphs, [], "受限账号不得拿到委托正文");
  assert.deepEqual(view.attachments, [], "受限账号不得拿到附件清单");
  assert.equal(
    readableText(view).includes(detail.order.requirementsText),
    false,
    "受限视图的任何可读字段都不得回显委托原文",
  );
  for (const item of detail.commission.attachments) {
    assert.equal(
      readableText(view).includes(item.name),
      false,
      `受限视图漏出了附件名：${item.name}`,
    );
  }
  assert.ok(view.restrictedNote.length > 0, "受限时必须给出一句说明，不能只剩一片空白");
});

test("受限详情：正文即使被服务端误下发也不渲染（只看 restricted，不看正文长度）", () => {
  /*
    服务端受限时 `order.requirementsText` 会置空字符串。
    这里故意**给它一段正文**：组件若按"正文非空才显示"来分支就会漏。
    口径是"受限就是受限"，判定必须来自 `restricted` 字段本身。
  */
  const detail = makeDetail({ restricted: true, requirementsText: "为掌握示例寺现场木柱保存状况……" });
  const view = buildCommissionView(detail);

  assert.equal(view.restricted, true);
  assert.deepEqual(view.paragraphs, [], "受限分支必须无视 requirementsText");
  assert.deepEqual(view.attachments, []);
});

/* ------------------------------------------------------------------ *
 * 3. 字段缺失：不得出现 undefined / null / NaN 字面量
 * ------------------------------------------------------------------ */

test("字段缺失：输出里不出现 undefined / null / NaN 字面量，缺失项进 placeholders 或显示 —", () => {
  const detail = makeDetail({ title: null, unit: null, date: null, requirementsText: null });
  const view = buildCommissionView(detail);

  const all = [
    ...Object.values(view).map((value) => JSON.stringify(value) ?? "undefined"),
    JSON.stringify(view),
  ].join("\n");

  for (const bad of ["undefined", "null", "NaN"]) {
    assert.equal(all.includes(bad), false, `展示数据里混进了 ${bad} 字面量：${all}`);
  }
  for (const field of [view.headUnit, view.title, view.signUnit, view.signDate]) {
    assert.ok(field.trim().length > 0, "缺失字段必须落到占位符，不能是空白");
  }
  assert.ok(view.placeholders.length > 0, "缺失项要进 placeholders，供界面统一列出");
});

test("字段缺失：附件为空时给出「附件未明确」，绝不补一条像样的附件", () => {
  const detail = makeDetail();
  detail.commission.attachments = [];
  const view = buildCommissionView(detail);

  assert.deepEqual(view.attachments, []);
  assert.ok(
    view.placeholders.includes("附件未明确"),
    `附件为空时必须明确写「附件未明确」，实际 placeholders=${JSON.stringify(view.placeholders)}`,
  );
});

/* ------------------------------------------------------------------ *
 * 4. 不出现幻觉内容
 * ------------------------------------------------------------------ */

test("不出现幻觉内容：平台内部编号与「风险等级 / 树种」等平台词不得进可读文本", () => {
  const text = readableText(buildCommissionView(makeDetail()));

  for (const token of ["Z01", "Z02", "Z03", "Z04"]) {
    assert.equal(text.includes(token), false, `委托预览里出现了平台内部编号 ${token}`);
  }
  for (const word of ["风险等级", "树种"]) {
    assert.equal(text.includes(word), false, `委托预览里出现了平台口径词「${word}」`);
  }
});

/* ------------------------------------------------------------------ *
 * 5. 附件名称逐字来自 detail
 * ------------------------------------------------------------------ */

test("附件名称逐字来自 detail，不改写、不截断、不补后缀", () => {
  const detail = makeDetail();
  detail.commission.attachments = [
    {
      assetId: "asset-commission-plain",
      name: "示例寺建筑平面示意图.pdf",
      kind: "图纸",
      sizeText: "1.2 MB",
      sourceMode: "replay",
    },
  ];
  const view = buildCommissionView(detail);

  assert.equal(view.attachments[0].name, "示例寺建筑平面示意图.pdf");
  assert.equal(
    view.attachments[0].name,
    detail.commission.attachments[0].name,
    "附件名必须与接口返回逐字相同",
  );
  assert.equal(readableText(view).includes("示例寺建筑平面示意图.pdf"), true);
});

/* ------------------------------------------------------------------ *
 * 摘要（受限时唯一能给账号看的内容）
 * ------------------------------------------------------------------ */

test("摘要取自工单详情本身的字段，不做任何推断", () => {
  const detail = makeDetail();
  const view = buildCommissionView(detail);
  const map = new Map(view.summary.map((item) => [item.k, item.v]));

  assert.equal(map.get("工单编号"), detail.order.orderNo);
  assert.equal(map.get("状态"), detail.order.status);
  assert.equal(map.get("地点"), detail.order.location);
  assert.ok(map.has("标题"), "摘要里应有平台工单标题");
});
