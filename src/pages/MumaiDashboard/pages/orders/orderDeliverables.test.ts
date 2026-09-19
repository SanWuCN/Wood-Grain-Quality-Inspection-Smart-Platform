/**
 * 「小木生成物」（㉓ 工单草稿 / ㉔ 复盘草稿 / ㉕ 交付摘要）· 单测
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 用户 2026-10-01：「平台最后几个对话需要更好的平台展示，而不只是跳转下页面」。
 * 于是这三轮各带出一块面板。面板最容易出的两类问题都在这里钉住：
 *
 *   1. **编数字**：屏幕上多出几个"看着合理"的数字，而 seed 里根本不是那么回事。
 *      所以逐条核对：交付校验的四个数必须等于 `DEMO_SCENARIO_V3.delivery`、
 *      草稿编号/位置/附件必须来自 `DRAFT_ORDER`、异常事件条数必须由 `TRIAGE_EVENTS`
 *      现算、待办必须来自 `TODO_ITEMS`（不手写条数）；
 *   2. **两组契约漂移**：面板的揭示组名要同时出现在
 *      `orderDeliverables.DELIVERABLE_SECTIONS`、`ordersReveal.ORDER_DETAIL_SECTIONS`
 *      与 `script.ts` 的拍点表里 —— 少一处，面板在播报期间就永远不亮。
 *      这里把"这一轮的 sections 正好包含这一份生成物的组"也一并断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_SCENARIO_V3, DELIVERY_ARTIFACTS, DRAFT_ORDER, TODO_ITEMS } from "../../seed/scenario.ts";
import { TRIAGE_EVENTS } from "../../seed/deviceLogs.ts";
import { SCRIPT_ROUNDS } from "../../agent/script.ts";
import { ORDER_DETAIL_SECTIONS } from "../../ordersReveal.ts";
import {
  DELIVERABLE_SECTIONS,
  DELIVERABLE_TITLES,
  draftOrderBlocks,
  reviewBlocks,
  summaryBlocks,
} from "./orderDeliverables.ts";

const ORDER = { orderNo: "WO-20260919-0001", status: "待指派", title: "示例寺古建筑检测" };
/** 把 blocks 拍平成"键 → 值"便于逐条核对 */
const flat = (blocks: ReturnType<typeof draftOrderBlocks>) =>
  blocks.flatMap((block) => block.lines.map((line) => ({ section: block.section, ...line })));

test("三份生成物的组名都在页面揭示声明里（少一处面板就不亮）", () => {
  const declared = new Set<string>(ORDER_DETAIL_SECTIONS);
  for (const [kind, sections] of Object.entries(DELIVERABLE_SECTIONS)) {
    for (const section of sections) {
      assert.ok(declared.has(section), `${kind} 的组名 ${section} 不在 ORDER_DETAIL_SECTIONS 里`);
    }
  }
  assert.equal(
    new Set(Object.values(DELIVERABLE_SECTIONS).flat()).size,
    Object.values(DELIVERABLE_SECTIONS).flat().length,
    "组名不能重复（重复会让两块抢同一个门控）",
  );
});

test("㉓㉔㉕ 三轮的拍点表各自带上自己那一份生成物（不再三页一样）", () => {
  const expectOf: [string, readonly string[], keyof typeof DELIVERABLE_SECTIONS][] = [
    ["㉓", DELIVERABLE_SECTIONS.draft, "draft"],
    ["㉔", DELIVERABLE_SECTIONS.review, "review"],
    ["㉕", DELIVERABLE_SECTIONS.summary, "summary"],
  ];
  for (const [roundNo, sections, kind] of expectOf) {
    const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo);
    assert.ok(round?.reveal, `第 ${roundNo} 轮没有揭示声明`);
    for (const section of sections) {
      assert.ok(round.reveal!.sections.includes(section), `第 ${roundNo} 轮的 sections 里少了 ${section}`);
    }
    /* 反证：另外两份生成物**不该**在这一轮出现（否则观众又看到"三块一样的面板"） */
    for (const [other, otherSections] of Object.entries(DELIVERABLE_SECTIONS)) {
      if (other === kind) continue;
      for (const section of otherSections) {
        assert.equal(
          round.reveal!.sections.includes(section),
          false,
          `第 ${roundNo} 轮不该带上 ${other} 的 ${section}`,
        );
      }
    }
    assert.equal(round.reveal!.split, "clause", `第 ${roundNo} 轮的台词是小句连成的，要按小句切段`);
  }
});

test("㉓ 工单草稿：编号/位置/附件都来自复核工单草稿，且标明来源", () => {
  const lines = flat(draftOrderBlocks());
  const value = (k: string) => lines.find((line) => line.k === k)?.v ?? "";
  assert.equal(value("草稿编号"), DRAFT_ORDER.id);
  assert.equal(value("复核位置"), DRAFT_ORDER.location);
  assert.equal(value("等级"), DRAFT_ORDER.level);
  assert.equal(value("来源风险"), DRAFT_ORDER.sourceRiskIds.join(" / "));
  assert.equal(value("附件合计"), `${DRAFT_ORDER.attachments.length} 项`);
  for (const attachment of DRAFT_ORDER.attachments) {
    assert.ok(
      lines.some((line) => line.k === attachment.name),
      `附件 ${attachment.name} 没有出现在面板里`,
    );
  }
  /* 状态如实：草稿就是草稿，不许写成已下发 */
  assert.match(value("当前状态"), /草稿/);
  assert.equal(lines.every((line) => line.from.length > 0), true, "每一行都要有来源");
});

test("㉔ 复盘草稿：异常/数据集/待办的数字都是现算的", () => {
  const lines = flat(reviewBlocks(ORDER));
  const value = (prefix: string) => lines.find((line) => line.k.startsWith(prefix))?.v ?? "";
  const settled = TRIAGE_EVENTS.filter((item) => item.state === "已结案").length;
  assert.equal(value("巡检异常事件"), `共 ${TRIAGE_EVENTS.length} 条 · 已结案 ${settled} 条 · ${TRIAGE_EVENTS.length - settled} 条在跟踪`);
  assert.match(value("数据集"), /审核 \d+\/\d+ 通过/);
  assert.match(value("归档交付"), new RegExp(`${DEMO_SCENARIO_V3.delivery.passed}/${DEMO_SCENARIO_V3.delivery.total}`));
  assert.match(value("地图"), new RegExp(DEMO_SCENARIO_V3.map.version));
  /* 未完成事项：条数与 TODO_ITEMS 现算一致，且逐条列出 */
  const open = TODO_ITEMS.filter((item) => item.state !== "已完成");
  const todoBlock = reviewBlocks(ORDER).find((block) => block.section === DELIVERABLE_SECTIONS.review[3]);
  assert.ok(todoBlock, "没有「后续待办」这一块");
  assert.equal(todoBlock.lines.length, open.length, "未完成事项条数与总览待办不一致");
  assert.match(todoBlock.title, new RegExp(`未完成 ${open.length} 项`));
  assert.equal(lines.every((line) => line.from.length > 0), true, "每一行都要有来源");
});

test("㉕ 交付摘要：四个校验数取自归档交付清单，摘要前缀取自真实产物", () => {
  const lines = flat(summaryBlocks(ORDER));
  const value = (k: string) => lines.find((line) => line.k === k)?.v ?? "";
  assert.equal(value("归档清单"), `${DEMO_SCENARIO_V3.delivery.total} 项`);
  assert.equal(value("校验通过"), `${DEMO_SCENARIO_V3.delivery.passed} 项`);
  assert.equal(value("缺失文件"), `${DEMO_SCENARIO_V3.delivery.missing} 项`);
  assert.equal(value("摘要不一致"), `${DEMO_SCENARIO_V3.delivery.summaryMismatch} 项`);
  /* 逐项摘要：至少列出一份真实产物的 sha256 前缀（"逐项对照"要看得见）。
     取样口径与实现同源：**已发布的优先**，没有已发布就退回清单前三份。 */
  const published = DELIVERY_ARTIFACTS.filter((item) => item.state === "已发布");
  const sample = (published.length ? published : DELIVERY_ARTIFACTS)[0];
  assert.ok(
    lines.some((line) => line.v.startsWith(`${sample.sha256}…`)),
    `面板里没有列出真实产物摘要（${sample.name}）`,
  );
  assert.equal(value("复盘草稿"), "已关联本次工单");
  assert.equal(lines.every((line) => line.from.length > 0), true, "每一行都要有来源");
});

test("面板标题带轮次号，且与剧本里的轮次对得上", () => {
  for (const [kind, meta] of Object.entries(DELIVERABLE_TITLES)) {
    assert.match(meta.roundNo, /^[㉑-㉕]$/, `${kind} 的轮次号格式不对：${meta.roundNo}`);
    assert.ok(
      SCRIPT_ROUNDS.some((round) => round.roundNo === meta.roundNo),
      `${kind} 指向的轮次 ${meta.roundNo} 不在剧本里`,
    );
  }
});
