/**
 * 工单详情的「随播报逐步加载」控制（演示用）
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────
 * 演示时用户说「读取这份工单」，期望的是：小木一边念这份工单的内容，
 * 详情页一边**按同一节奏**把分区铺开 —— 而不是人还没开口、整页内容已经全在那儿。
 *
 * ── 为什么用"计划 + 事件"而不是 URL 参数 ────────────────────────────
 *   · URL 参数（`?reveal=2`）会把播放进度写进历史记录，浏览器前进/后退会看到
 *     一串中间态，还会污染 `Orders.tsx` 的 `?order=` 选中逻辑；
 *   · 放组件 state 又跨不过"agent 在气泡里说话 / 页面在路由里渲染"这道边界。
 * 所以用模块级**一次性计划**：由 agent 开场时登记，按拍点推进，播完自动解除。
 *
 * ── 安全边界（很重要）─────────────────────────────────────────────────
 * **没有计划时一律返回 `Infinity`** —— 用户自己点进工单、从地图跳进来、
 * 刷新页面，看到的都是完整详情。只有 agent 明确登记过的那一张工单、
 * 在那一次播报期间，才会逐段揭示。这条边界保证"演示效果"不会传染成"页面坏了"。
 *
 * 调用关系：
 *   `agent/executor.ts`（剧本轮次）→ `beginOrderReveal` / `advanceOrderReveal`
 *   `pages/WorkOrderDetail.tsx`     → `useOrderReveal(orderId)` 决定显示到第几段
 */

import { useEffect, useState } from "react";

/** 单次揭示计划的兜底存活时间：agent 中途被打断也不会让页面停在半截 */
const PLAN_TTL_MS = 30000;

type RevealPlan = {
  orderId: string;
  /** 一共分几段（= 详情页要逐段显示的分区数） */
  total: number;
  /** 已经揭示到第几段：0 表示还没开始 */
  stage: number;
  /** 兜底定时器：到点自动解除计划（页面随即显示完整内容） */
  timer: number;
};

let plan: RevealPlan | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function clearPlan(): void {
  if (plan) window.clearTimeout(plan.timer);
  plan = null;
}

/** 登记一次揭示计划（agent 在"要念这张工单"时调用）；stage 从 0 开始 */
export function beginOrderReveal(orderId: string, total: number): void {
  if (!orderId || total <= 0) return;
  clearPlan();
  plan = {
    orderId,
    total,
    stage: 0,
    timer: window.setTimeout(() => {
      /* 兜底：到点还没播完就解除计划，页面回到"完整显示"，不留半截 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  };
  notify();
}

/** 推进到第 next 段；到达 total 即视为播完，计划自动解除（页面显示完整内容） */
export function advanceOrderReveal(orderId: string, next: number): void {
  if (!plan || plan.orderId !== orderId) return;
  plan.stage = Math.min(next, plan.total);
  if (plan.stage >= plan.total) {
    clearPlan();
    notify();
    return;
  }
  notify();
}

/** 主动取消（例如用户中途点了别的工单） */
export function cancelOrderReveal(): void {
  if (!plan) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：当前这张工单"应该显示到第几段"。
 *
 * 返回值语义：`N` = 只显示前 N 段；`Infinity` = 全部显示（没有计划时的默认值）。
 */
export function useOrderReveal(orderId: string | null | undefined): number {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (!orderId || !plan || plan.orderId !== orderId) return Number.POSITIVE_INFINITY;
  return plan.stage;
}
