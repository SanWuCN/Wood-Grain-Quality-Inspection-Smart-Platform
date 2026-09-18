/**
 * 执行工作台 · 任务卡逐拍铺开（与 `cleanFlowReveal.ts` / `ordersReveal.ts` 同一套做法）
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * ⑥⑮ 两轮的页面动作现在是"生成任务卡"，而**卡片是一次性冒出来还是跟着台词一张张出现**，
 * 观感完全不同：小木在 ⑮ 里念的正是四张卡各自的分工
 * （「补采交全栈执行，样本与测区由具身核对，项目经理审核分组和验证结果，平台记录各项回执」），
 * 一句一张才对得上。⑰ 的清洗流程页已经用同一套办法做过（`cleanFlowReveal`），
 * 这里只是换了个键与目标页面，通用部分（切段 / 对齐拍点 / 按时刻推进 / 兜底 TTL）
 * 仍然复用 `ordersReveal.ts` 的 `runRevealTimeline`。
 *
 * ── 键为什么是 `batchKey` 而不是工单号 ──────────────────────────────
 * 计划要能同时管住"开工四项"与"异常适配四项"两批（两轮各登记一次，互不干扰），
 * 而它们属于**同一张工单** —— 用工单号当键会让后一轮顶掉前一轮。
 * 槽位用位置编号 `c1…c4`：卡片是页面按 `seq` 渲染的，位置比标题稳定（标题改一个字就失配）。
 *
 * ⚠ 与另两个 reveal 模块一样，状态挂在 `globalThis` 上：Vite dev 下同一个源文件
 *   可能被实例化多份（相对 / 绝对引用各一份），计划登记在 A 实例、页面在 B 实例读，
 *   表现就是"台词念完了，卡片一张没出来"。
 */

import { useEffect, useState } from "react";

/** 一批最多四张卡（两批都是四张；槽位是位置，不是标题） */
export const WORKBENCH_SLOTS = ["c1", "c2", "c3", "c4"] as const;
export type WorkbenchSlot = (typeof WORKBENCH_SLOTS)[number];

/** 计划最长活多久（与另两个揭示模块同一口径）：到点自动解除，页面回到"全部可见" */
const PLAN_TTL_MS = 30_000;

type WorkbenchPlan = {
  batchKey: string;
  /** 这次计划**允许**点亮的槽位（顺序即推进顺序） */
  slots: WorkbenchSlot[];
  revealed: Set<WorkbenchSlot>;
  timer: number;
};

const STORE_KEY = "__mumaiWorkbenchRevealStore";

type WorkbenchStore = { plan: WorkbenchPlan | null; listeners: Set<() => void> };

function storeOf(): WorkbenchStore {
  const host = globalThis as unknown as { [STORE_KEY]?: WorkbenchStore };
  return (host[STORE_KEY] ??= { plan: null, listeners: new Set() });
}

function currentPlan(): WorkbenchPlan | null {
  return storeOf().plan;
}

function notify(): void {
  for (const listener of storeOf().listeners) listener();
}

function clearPlan(): void {
  const current = currentPlan();
  if (current) window.clearTimeout(current.timer);
  storeOf().plan = null;
}

/** 登记一次计划：刚登记时**一张都不点亮**（第一拍要等小木开口） */
export function beginWorkbenchReveal(batchKey: string, slots: readonly string[]): void {
  const wanted = slots.filter((slot): slot is WorkbenchSlot =>
    (WORKBENCH_SLOTS as readonly string[]).includes(slot),
  );
  if (!batchKey || wanted.length === 0) return;
  clearPlan();
  storeOf().plan = {
    batchKey,
    slots: wanted,
    revealed: new Set(),
    timer: window.setTimeout(() => {
      /* 兜底：到点还没推完就解除，页面回到"人自己看"的状态，不留半截 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  };
  notify();
}

/**
 * 点亮这些槽位。幂等；只对**本计划绑定的批次**生效（防串页）。
 *
 * ⚠ 同 `cleanFlowReveal`：推完最后一个槽位**不解除计划** —— 页面是照着
 *   "计划里已点亮的最后一个槽位"渲染的，一解除就只能读到 `null`，
 *   最后一张卡永远不出现（那正是清洗页踩过的坑）。
 */
export function advanceWorkbenchReveal(batchKey: string, slots: readonly string[]): void {
  const plan = currentPlan();
  if (!plan || plan.batchKey !== batchKey) return;
  for (const slot of slots) {
    if (plan.slots.includes(slot as WorkbenchSlot)) plan.revealed.add(slot as WorkbenchSlot);
  }
  notify();
}

/** 主动取消（用户自己动手、或这一轮被打断）→ 立刻交回给人看全部 */
export function cancelWorkbenchReveal(): void {
  if (!currentPlan()) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：这一批**已经被点亮到哪些槽位**。
 *
 * `null` = 没有计划（页面自己决定全显示）；数组 = 只允许这些槽位的卡出现。
 */
export function workbenchSlotsFor(batchKey: string | null | undefined): WorkbenchSlot[] | null {
  const plan = currentPlan();
  if (!batchKey || !plan || plan.batchKey !== batchKey) return null;
  return plan.slots.filter((slot) => plan.revealed.has(slot));
}

/** React 侧订阅（用法见 `Workbench.tsx`） */
export function useWorkbenchReveal(batchKey: string | null | undefined): WorkbenchSlot[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    const shared = storeOf().listeners;
    shared.add(listener);
    return () => {
      shared.delete(listener);
    };
  }, []);
  return workbenchSlotsFor(batchKey);
}

/**
 * 页面挂载探针：等工作台**真的渲染出来**再补拍点。
 *
 * 判据用 `.wb`（页面根）而不是 `.wb-cards`：卡片是异步生成的，用卡片当判据时
 * 计划会在卡片到达之前就走到"到点补齐"，逐拍铺开等于没发生 ——
 * 与工单页那次"探针类名写错、现象像功能没生效"是同一个坑。
 */
export function workbenchMounted(): boolean {
  return typeof document !== "undefined" && document.querySelector(".wb") !== null;
}
