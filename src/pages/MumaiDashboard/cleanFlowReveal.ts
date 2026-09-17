/**
 * 数据清洗流程 · 逐拍推进（与 `ordersReveal.ts` 同一套做法，按数据集 id 记计划）
 *
 * ── 用户口径 2026-09-18 ────────────────────────────────────────────
 * 「小木，启动数据清洗，列出需要…这个对话需要小木跳转到固件及模型，数据集，
 * 直接一步一步引导到人工核验」——第 17 条（⑰）说完之后，数据集页上的清洗流程
 * 要**跟着播报一段一段往前走**，走到「人工核验」那一步停住（核验是人的责任，
 * 脚本不替人点「采纳 / 排除」）。
 *
 * ── 为什么另起一个模块而不是复用 ordersReveal ────────────────────
 * 两者结构一样（模块级计划 + React 订阅 + executor 按拍推进 + 兜底 TTL），
 * 但**键**不同：工单页按 `orderId` 绑计划，这里按数据集 id；
 * 共用一份状态会让两个页面互相串计划（工单跳一下，数据集页跟着亮）。通用部分
 * （切段、对齐拍点、按时刻推进）留在 `ordersReveal.ts`，这里只放"这一件事"的状态。
 *
 * ⚠ 与 ordersReveal 一样，状态挂在 `globalThis` 上：Vite dev 下同一个源文件可能被
 *   实例化多份（相对 / 绝对引用各一份），计划登记在 A 实例、页面在 B 实例读，
 *   表现就是"台词念完了，流程一步没动"。
 */

import { useEffect, useState } from "react";

/** 清洗流程里可以"被推进到"的阶段（与 `DatasetCleanFlow` 的 `Stage` 对齐） */
export const CLEAN_FLOW_STAGES = ["pick", "configure", "precheck", "cleaned", "reviewed", "versioned"] as const;
export type CleanFlowStage = (typeof CLEAN_FLOW_STAGES)[number];

/** 计划最长活多久（与工单页同一口径）：到点自动解除，页面回到可自由操作 */
const PLAN_TTL_MS = 30_000;

type CleanFlowPlan = {
  datasetId: string;
  /** 这次计划**允许**推进到的阶段（顺序即推进顺序） */
  stages: CleanFlowStage[];
  /** 已经推进到的阶段 */
  revealed: Set<CleanFlowStage>;
  /** 兜底定时器 */
  timer: number;
};

const STORE_KEY = "__mumaiCleanFlowRevealStore";

type CleanFlowStore = { plan: CleanFlowPlan | null; listeners: Set<() => void> };

function storeOf(): CleanFlowStore {
  const host = globalThis as unknown as { [STORE_KEY]?: CleanFlowStore };
  return (host[STORE_KEY] ??= { plan: null, listeners: new Set() });
}

function currentPlan(): CleanFlowPlan | null {
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

/** 登记一次计划：刚登记时**一步都不推进**（第一拍要等小木开口） */
export function beginCleanFlowReveal(datasetId: string, stages: readonly string[]): void {
  const wanted = stages.filter((stage): stage is CleanFlowStage =>
    (CLEAN_FLOW_STAGES as readonly string[]).includes(stage),
  );
  if (!datasetId || wanted.length === 0) return;
  clearPlan();
  storeOf().plan = {
    datasetId,
    stages: wanted,
    revealed: new Set(),
    timer: window.setTimeout(() => {
      /* 兜底：到点还没推完就解除计划，页面回到"人自己点"的状态，不留半截 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  };
  notify();
}

/**
 * 推进到这些阶段。幂等；只对**本计划绑定的数据集**生效（防串页）。
 *
 * ⚠ 推完最后一个阶段**不解除计划**（真踩过）：页面是照着"计划里已点亮的最后一个阶段"
 * 往前走的，一解除页面就只能读到 `null`，最后一个阶段（`cleaned`）永远不生效 ——
 * 实测现象是「页面一直停在预检查，清洗就是不执行」，而计划那边显示已经推完。
 * 登记保持到**兜底 TTL** 到点，或者用户一动手调 `cancelCleanFlowReveal()` 解除。
 */
export function advanceCleanFlowReveal(datasetId: string, stages: readonly string[]): void {
  const plan = currentPlan();
  if (!plan || plan.datasetId !== datasetId) return;
  for (const stage of stages) {
    if (plan.stages.includes(stage as CleanFlowStage)) plan.revealed.add(stage as CleanFlowStage);
  }
  notify();
}

/** 主动取消（用户自己点了流程按钮、或这一轮被打断）→ 立刻交回给人操作 */
export function cancelCleanFlowReveal(): void {
  if (!currentPlan()) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：这一份数据集**已经被推进到哪些阶段**。
 *
 * `null` = 没有计划（页面自己决定停在哪一步）；数组 = 只允许这些阶段被脚本点亮。
 */
export function cleanFlowStagesFor(datasetId: string | null | undefined): CleanFlowStage[] | null {
  const plan = currentPlan();
  if (!datasetId || !plan || plan.datasetId !== datasetId) return null;
  return plan.stages.filter((stage) => plan.revealed.has(stage));
}

/** React 侧订阅（用法见 `DatasetCleanFlow`） */
export function useCleanFlowReveal(datasetId: string | null | undefined): CleanFlowStage[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    const shared = storeOf().listeners;
    shared.add(listener);
    return () => {
      shared.delete(listener);
    };
  }, []);
  return cleanFlowStagesFor(datasetId);
}

/**
 * 页面挂载探针：等数据集页真的渲染出来再补拍点。
 *
 * 判据用 `.dc-track`（阶段轨道）—— 它是这一页唯一的骨架，导航没到就一定没有。
 * ⚠ 与工单页同一个教训：探针的类名写错时，探测永远为假 → 立刻走到"到点补齐"，
 *   逐步推进等于没发生，而现象看起来像"功能没生效"。
 */
export function cleanFlowMounted(): boolean {
  return typeof document !== "undefined" && document.querySelector(".dc-track") !== null;
}
