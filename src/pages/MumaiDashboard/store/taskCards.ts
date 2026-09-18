/**
 * 执行工作台 · 服务端实体这一侧的读写（页面与小木共用）
 *
 * 分工与 `store/cruise.ts` 同一套：
 *   · **谁生成了卡片、谁保存、谁回执** = 服务端 `taskCard` 实体
 *     （`server/services/workflow.mjs` 的 `task.create / task.save / task.ack`）；
 *   · **卡片内容**（标题 / 执行人 / 输入 / 完成条件）来自 `pages/workbench/taskCards.ts`，
 *     这里只把它交给服务端，不在前端拼状态、不本地先行；
 *   · 卡片编号 `TK-<工单号日期段>-<两位流水>` 由服务端生成 —— 页面自己编号，
 *     换台电脑就会对不上（与巡航任务号同一条坑）。
 *
 * ── 为什么小木这边只调 `ensureTaskCards` ───────────────────────────
 * 剧本里小木只做两件事：⑥「把工单任务同步到工作台」、⑮「生成任务草稿」。
 * 保存（史核对后）与回执（执行人）都是**人的动作**，必须由页面上的按钮触发 ——
 * 所以这里没有"自动保存/自动回执"的入口，`ensureTaskCards` 也只是幂等地生成草稿。
 */

import { useSharedStore } from "./shared";
import { useWorkOrderStore } from "./workOrders";
import { batchOf, cardsFor, type TaskCardRecord } from "../pages/workbench/taskCards";

export type TaskCreateResult = {
  created: boolean;
  orderId: string;
  orderNo?: string | null;
  batchKey: string;
  cardIds: string[];
};

/**
 * 工单号：任务卡的编号是 `TK-<工单号日期段>-<流水>`，所以这一步不能漏。
 *
 * 踩过一次：小木那条路（executor）只传了 `orderId`，服务端拿不到工单号，
 * 编号退化成 `TK-01`（不带日期段）—— 页面那条路传了工单号却是 `TK-20260918-01`，
 * 同一张工单的卡片编号形状不一致，验收当场红。现在统一在这里补：
 * 调用方给就给，不给就从工单 store 里查（列表 → 详情），查不到才留空。
 */
function orderNoOf(orderId: string, given?: string | null): string | null {
  if (given) return given;
  const state = useWorkOrderStore.getState();
  return state.orders.find((item) => item.id === orderId)?.orderNo ?? state.detail?.order.orderNo ?? null;
}

/**
 * 生成某一批任务卡（幂等：同一张工单的同一个批次只生成一次）。
 *
 * 失败**不抛给调用方去补播成功话术**：调用方（executor / 页面）自己决定怎么提示。
 */
export async function ensureTaskCards(batchKey: string, orderId: string, orderNo?: string | null): Promise<TaskCreateResult> {
  if (!batchOf(batchKey)) throw new Error(`未登记的任务卡批次：${batchKey}`);
  const cards = cardsFor(batchKey);
  const result = await useSharedStore.getState().send({
    action: "task.create",
    entityId: null,
    payload: { orderId, orderNo: orderNoOf(orderId, orderNo), batchKey, cards },
  });
  return result.result as unknown as TaskCreateResult;
}

/** 核对后保存（草稿 → 已保存）：核对人（史/沈）的动作 */
export async function saveTaskCard(cardId: string, revision: number): Promise<void> {
  await useSharedStore.getState().send({
    action: "task.save",
    entityId: cardId,
    expectedRevision: revision,
    payload: {},
  });
}

/** 执行人回执（已保存 → 已回执）：服务端记下是谁、什么时候 */
export async function ackTaskCard(cardId: string, revision: number, note?: string): Promise<void> {
  await useSharedStore.getState().send({
    action: "task.ack",
    entityId: cardId,
    expectedRevision: revision,
    payload: note ? { note } : {},
  });
}

/** 实体 revision：命令总线按它做冲突检测（两台电脑同时点只有一台成功） */
export function taskCardRevisionOf(list: readonly TaskCardRecord[] | undefined, cardId: string): number | null {
  return (list ?? []).find((item) => item.id === cardId)?.revision ?? null;
}
