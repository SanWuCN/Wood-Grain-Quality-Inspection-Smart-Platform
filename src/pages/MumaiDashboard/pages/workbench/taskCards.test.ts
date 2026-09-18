/**
 * 执行工作台 · 任务卡（`taskCards.ts`）
 *
 * 这一层是纯逻辑，所以"卡片上会出现什么"能被逐条断言。四条判据都对着剧本的硬要求：
 *   · **两批卡的执行人就是剧本点名的岗位**（补采→全栈、样本与测区→具身、分组与验证→项目经理、
 *     适配验证→架构师），姓名一律从 `MEMBERS` 取，不在这里写第二份花名册；
 *   · **没有"已完成"**：状态只有 草稿 / 已保存 / 已回执，`TASK_STATE_STEP` 里也没有 done 这条路；
 *   · **完成条件写"什么算完成"**，不是"已经完成"（防幻觉：结论要有依据）；
 *   · **按卡判人**：回执只对得上执行人本人（否则别人的卡会被点掉）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskCardEntity } from "../../api/client.ts";
import { MEMBERS } from "../../seed/scenario.ts";
import {
  TASK_BATCHES,
  TASK_STATE_LABEL,
  TASK_STATE_STEP,
  batchOf,
  canAdvance,
  cardsFor,
  cardsOfOrder,
  groupByBatch,
  ownerOf,
  progressOf,
} from "./taskCards.ts";

function card(overrides: Partial<TaskCardEntity> = {}): TaskCardEntity {
  return {
    id: "TK-20260918-01",
    orderId: "wo-1",
    orderNo: "WO-20260918-0001",
    batchKey: "startup",
    seq: 1,
    title: "现场建档",
    ownerAccountId: "ma",
    ownerLabel: "马",
    ownerRole: "具身智能工程师",
    inputs: ["四根木柱影像采集批次"],
    doneCondition: "影像与地图版本按本工单归档",
    note: null,
    source: "小木",
    state: "draft",
    createdBy: "shi",
    createdAt: "2026-09-18T10:00:00+08:00",
    savedBy: null,
    savedAt: null,
    ackedBy: null,
    ackedAt: null,
    ...overrides,
  };
}

test("两批任务卡：批次、轮次与张数都对得上剧本", () => {
  assert.deepEqual(
    TASK_BATCHES.map((item) => [item.batchKey, item.roundNo, item.cards.length]),
    [
      ["startup", "⑥", 4],
      ["adapt", "⑮", 4],
    ],
  );
  assert.equal(batchOf("startup")?.label, "开工四项");
  assert.equal(batchOf("nope"), null);
});

test("开工四项就是剧本那句「现场建档、风险初筛、重点精扫和复核交付」", () => {
  assert.deepEqual(
    batchOf("startup")?.cards.map((item) => item.title),
    ["现场建档", "风险初筛", "重点精扫", "复核交付"],
  );
  /* ⑮ 的分工原话：「补采交全栈执行，样本与测区由具身核对，项目经理审核分组和验证结果」 */
  const adapt = batchOf("adapt")?.cards ?? [];
  assert.equal(adapt.find((item) => item.title === "补充参考样本")?.ownerAccountId, "rao");
  assert.equal(adapt.find((item) => item.title === "样本与测区核对")?.ownerAccountId, "ma");
  assert.equal(adapt.find((item) => item.title === "分组与验证审核")?.ownerAccountId, "shen");
  assert.equal(adapt.find((item) => item.title === "适配验证")?.ownerAccountId, "shi");
});

test("每张卡的执行人都在花名册里，且卡片内容完整（无空项）", () => {
  for (const batch of TASK_BATCHES) {
    for (const card of batch.cards) {
      assert.ok(
        MEMBERS.some((member) => member.id === card.ownerAccountId),
        `${card.title} 的执行人 ${card.ownerAccountId} 不在 MEMBERS 里`,
      );
      assert.ok(card.inputs.length >= 1, `${card.title} 没有写输入`);
      assert.ok(card.doneCondition.length >= 8, `${card.title} 的完成条件太短，等于没写`);
      /* 完成条件是"什么算完成"，不许写成"已完成 / 已通过"这类结论 */
      assert.doesNotMatch(card.doneCondition, /已完成|已通过|已验收/, `${card.title} 的完成条件写成了结论`);
    }
  }
});

test("服务端载荷带齐执行人姓名与岗位（姓名只有一个来源：MEMBERS）", () => {
  const payload = cardsFor("startup");
  assert.equal(payload.length, 4);
  const first = payload[0] as Record<string, unknown>;
  assert.equal(first.ownerAccountId, "ma");
  assert.equal(first.ownerLabel, MEMBERS.find((item) => item.id === "ma")?.name);
  assert.equal(first.ownerRole, MEMBERS.find((item) => item.id === "ma")?.role);
  assert.equal(first.source, "小木");
  assert.deepEqual(cardsFor("nope"), []);
});

test("ownerOf：查不到时如实显示账号 id，不编一个中文名", () => {
  assert.deepEqual(ownerOf("rao"), { label: "饶", role: "全栈开发工程师" });
  assert.deepEqual(ownerOf("nobody"), { label: "nobody", role: "未登记岗位" });
});

test("状态机只有三步、没有「已完成」这条路", () => {
  assert.deepEqual(Object.keys(TASK_STATE_LABEL).sort(), ["accepted", "draft", "saved"]);
  assert.deepEqual(
    Object.entries(TASK_STATE_STEP).map(([state, step]) => [state, step.action]),
    [
      ["draft", "task.save"],
      ["saved", "task.ack"],
      ["accepted", null],
    ],
  );
});

test("按工单取卡：批次顺序稳定、批次内按 seq（不是 id 字典序）", () => {
  const list = [
    { id: "b", revision: 1, updatedAt: "", data: card({ id: "TK-20260918-09", batchKey: "adapt", seq: 2 }) },
    { id: "a", revision: 1, updatedAt: "", data: card({ id: "TK-20260918-01", batchKey: "startup", seq: 1 }) },
    { id: "c", revision: 1, updatedAt: "", data: card({ id: "TK-20260918-10", batchKey: "adapt", seq: 1 }) },
    { id: "d", revision: 1, updatedAt: "", data: card({ id: "TK-20260918-02", orderId: "wo-2", batchKey: "startup", seq: 2 }) },
  ];
  const cards = cardsOfOrder(list, "wo-1");
  assert.deepEqual(
    cards.map((item) => item.id),
    ["TK-20260918-01", "TK-20260918-10", "TK-20260918-09"],
    "批次顺序或批次内 seq 排错了（TK-10 不能排在 TK-9 后面）",
  );
  assert.deepEqual(cardsOfOrder(list, null), [], "没有工单时不该给出任何卡");
  assert.deepEqual(groupByBatch(cards).map((item) => [item.label, item.cards.length]), [
    ["开工四项", 1],
    ["异常适配四项", 2],
  ]);
});

test("进度统计与卡片状态一致", () => {
  const progress = progressOf([
    card({ state: "draft" }),
    card({ id: "b", state: "saved" }),
    card({ id: "c", state: "accepted" }),
    card({ id: "d", state: "accepted" }),
  ]);
  assert.deepEqual(progress, { total: 4, draft: 1, saved: 1, accepted: 2 });
});

test("按卡判人：保存看权限，回执只认这张卡的执行人", () => {
  const canAll = () => true;
  const canNothing = () => false;
  const shi = { id: "shi" };
  const ma = { id: "ma" };

  /* 草稿：有 task:manage 就能保存；没有就给出原因 */
  assert.equal(canAdvance(card({ state: "draft" }), shi, canAll).allowed, true);
  const denied = canAdvance(card({ state: "draft" }), ma, canNothing);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /task:manage/);

  /* 已保存：执行人本人可回执，别人不行 */
  assert.equal(canAdvance(card({ state: "saved", ownerAccountId: "ma" }), ma, canAll).allowed, true);
  const other = canAdvance(card({ state: "saved", ownerAccountId: "ma" }), shi, canAll);
  assert.equal(other.allowed, false);
  assert.match(other.reason, /由马回执/);

  /* 已回执：没有下一步 */
  assert.deepEqual(canAdvance(card({ state: "accepted" }), ma, canAll), { allowed: false, reason: "已回执" });
});
