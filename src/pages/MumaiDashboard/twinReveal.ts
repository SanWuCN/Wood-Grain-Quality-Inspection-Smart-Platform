/**
 * 数字孪生 · 四柱构件条逐柱点亮（剧本 ⑪ 用；与另两个揭示模块同一套做法）
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 剧本 ⑪ 演在**三维场景**里：史「现在提交四根木柱对应的原始关键帧……（在三维场景给木柱打标签）」→
 * 「小木，分析比较这四组标记的木构件，进行风险评估」→ 小木报出「当前 Z04 视角可见较明显的
 * 表面缺损和孔洞状疑点，建议优先复核 Z04 下部测区」。
 * 原先这一轮把页面带到了**工单详情**（按组展开），与剧本的场地（三维场景）对不上 ——
 * 用户口径是「每一轮都切到剧本对应的真实页面」。现在改到 `/twin`，
 * 并让顶部的四柱构件条**跟着台词逐柱点亮**，最后在 Z04 上打出「建议优先复核」。
 *
 * ── 键为什么**不是**工单号（第一版踩过，记在这里）────────────────────
 * 第一版按 `orderId` 绑计划（想着"换工单就不该继续点上一张单的柱子"），结果现场
 * **一根都不亮**：数字孪生页的工单选择框用的是 `seed/scenario.ts` 里的演示工单
 * （`WORK_ORDER` / `HISTORIC_ORDERS`，形如 `SH-2026-0901`），而 executor 手里的是
 * **服务端工单号**（`wo-20260918-0001`）—— 两边根本不是同一个键，页面永远匹配不上，
 * 于是 `twinSlotsFor()` 返回 `null`（= 全部可见），表现就是"计划登记了但什么都没发生"。
 *
 * 现在的口径：
 *   · 计划是**全局的一份**（同一时刻只可能有一轮小木在讲四柱，键=工单反而制造了假隔离）；
 *   · `orderId` 只作为**来源记录**留在计划里（排查时能看出这一轮是给哪张单登记的）；
 *   · "换工单就交回给人"这条约束改由**页面**保证：用户在工单选择框里换单时
 *     调 `cancelTwinReveal()`（见 `Twin.tsx` 的 `setOrderId` 分支），
 *     而不是靠键匹配 —— 键匹配在两边 id 体系不同的前提下本来就是错的。
 *
 * ⚠ 与 `ordersReveal` / `cleanFlowReveal` / `workbenchReveal` 一样，状态挂
 *   `globalThis`：Vite dev 下同一源文件可能实例化多份，计划登记在 A 实例、
 *   页面在 B 实例读，表现就是"台词念完了，构件一个没亮"。
 */

import { useEffect, useState } from "react";

/** 兜底 TTL：到点自动解除，页面回到四根全显示 */
const PLAN_TTL_MS = 30_000;

type TwinPlan = {
  /** 登记时那一轮想讲的工单（服务端 id，仅作记录与排查用，不参与匹配） */
  orderId: string | null;
  slots: string[];
  revealed: Set<string>;
  timer: number;
};

const STORE_KEY = "__mumaiTwinRevealStore";

type TwinStore = { plan: TwinPlan | null; listeners: Set<() => void> };

function storeOf(): TwinStore {
  const host = globalThis as unknown as { [STORE_KEY]?: TwinStore };
  return (host[STORE_KEY] ??= { plan: null, listeners: new Set() });
}

function currentPlan(): TwinPlan | null {
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

/** 登记一次计划：刚登记时**一根都不点亮**（第一拍要等小木开口） */
export function beginTwinReveal(slots: readonly string[], orderId: string | null = null): void {
  const wanted = slots.filter((slot) => /^Z\d{2}$/.test(slot));
  if (wanted.length === 0) return;
  clearPlan();
  storeOf().plan = {
    orderId,
    slots: wanted,
    revealed: new Set(),
    timer: window.setTimeout(() => {
      /* 兜底：到点还没推完就解除，页面回到"全部可见"，不留半截 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  };
  notify();
}

/**
 * 点亮这些构件。幂等。
 *
 * ⚠ 同另两个模块：推完最后一根**不解除计划** —— 页面照着"已点亮的最后一根"渲染，
 *   一解除就只能读到 `null`，最后一根永远不亮。
 */
export function advanceTwinReveal(slots: readonly string[]): void {
  const plan = currentPlan();
  if (!plan) return;
  for (const slot of slots) {
    if (plan.slots.includes(slot)) plan.revealed.add(slot);
  }
  notify();
}

/** 主动取消（用户自己换了工单、点了构件、或这一轮被打断）→ 立刻回到四根全显示 */
export function cancelTwinReveal(): void {
  if (!currentPlan()) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：**已经在点亮中的构件**。
 *
 * `null` = 没有计划（用户自己点进来、刷新、换工单都走这一支，看到的是完整四柱）。
 */
export function twinSlotsFor(): string[] | null {
  const plan = currentPlan();
  if (!plan) return null;
  return plan.slots.filter((slot) => plan.revealed.has(slot));
}

/** React 侧订阅（用法见 `Twin.tsx` 的四柱构件条） */
export function useTwinReveal(): string[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    const shared = storeOf().listeners;
    shared.add(listener);
    return () => {
      shared.delete(listener);
    };
  }, []);
  return twinSlotsFor();
}

/**
 * 页面挂载探针：等孪生页真的渲染出来再补拍点。
 *
 * 判据用 `.twin-cols`（四柱构件条本身）—— 它只在这一页出现，且是揭示的作用对象；
 * 用更外层的容器当判据会把"数据还没到、构件条还没渲染"也算成已挂载。
 */
export function twinMounted(): boolean {
  return typeof document !== "undefined" && document.querySelector(".twin-cols") !== null;
}
