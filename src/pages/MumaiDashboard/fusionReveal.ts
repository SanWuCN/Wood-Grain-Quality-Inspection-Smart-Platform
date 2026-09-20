/**
 * 本批次分析流程 · 逐段推进（㉑，与 `cleanFlowReveal` / `ordersReveal` 同一套做法）
 *
 * ── 用户口径 2026-10-01 ────────────────────────────────────────────
 * 「针对一些只有跳转不太合适的对话加上特殊页面或操作」。
 * ㉑ 的台词是「**调用**本批次分析流程，完成图像标注和雷达分析，再按测区融合结果」，
 * 可原来只是跳到「固件及模型 · 融合分析」——那一页**一打开四块结果就全在**，
 * 观众看不到"流程被跑起来"这件事，屏幕上只有"跳了一页 + 弹一个浮层"。
 *
 * 现在：四块按拍依次出现（输入校验 → 图像标注 → 雷达分析 → 测区融合），
 * 与台词的三小句对齐 —— 「分析完成」/「图像标注与雷达结果已关联到 Z04 测区」/「融合视图已生成」。
 *
 * ── 为什么不复用 cleanFlowReveal ───────────────────────────────────
 * 结构一样（模块级计划 + React 订阅 + executor 按拍推进 + 兜底 TTL），但**键不同**：
 * 清洗页按数据集 id 绑计划，这里只有一条融合记录，所以按"有没有计划"judge。
 * 合成一份状态会让两个页面互相串计划（清洗跳一下，融合页跟着亮）。
 *
 * ⚠ 状态挂在 `globalThis` 上：Vite dev 下同一个源文件可能被实例化多份
 *   （相对 / 绝对引用各一份），计划登记在 A 实例、页面在 B 实例读，
 *   表现就是"台词念完了，流程一段没动"。
 */

import { useEffect, useState } from "react";

/** 融合页里可以"被推进到"的四段（与 `FusionTab` 的四块面板一一对应） */
export const FUSION_FLOW_SECTIONS = ["completeness", "visual", "radar", "fusion"] as const;
export type FusionSection = (typeof FUSION_FLOW_SECTIONS)[number];

/** 计划最长活多久（与工单页 / 清洗页同一口径）：到点自动解除，页面回到"四块都在" */
const PLAN_TTL_MS = 30_000;

type FusionPlan = {
  /** 这次计划**允许**推进到的段（顺序即推进顺序） */
  sections: FusionSection[];
  /** 已经点亮的段 */
  revealed: Set<FusionSection>;
  timer: number;
};

const STORE_KEY = "__mumaiFusionFlowRevealStore";

type FusionStore = { plan: FusionPlan | null; listeners: Set<() => void> };

function storeOf(): FusionStore {
  const host = globalThis as unknown as { [STORE_KEY]?: FusionStore };
  return (host[STORE_KEY] ??= { plan: null, listeners: new Set() });
}

function currentPlan(): FusionPlan | null {
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

/** 登记一次计划：刚登记时**一段都不点亮**（第一拍要等小木开口） */
export function beginFusionReveal(sections: readonly string[]): void {
  const wanted = sections.filter((section): section is FusionSection =>
    (FUSION_FLOW_SECTIONS as readonly string[]).includes(section),
  );
  if (wanted.length === 0) return;
  clearPlan();
  storeOf().plan = {
    sections: wanted,
    revealed: new Set(),
    timer: window.setTimeout(() => {
      /* 兜底：到点还没推完就解除计划 —— 页面回到"四块都在"，不留半截舞台 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  };
  notify();
}

/**
 * 点亮这些段。幂等；只对计划里允许的段生效。
 *
 * ⚠ 推完最后一段**不解除计划**（与清洗页同一个坑）：页面照着"已点亮的最后一段"画，
 * 一解除就只能读到 `null` → 立刻变回"四块全在"，最后一段的推进等于没发生。
 */
export function advanceFusionReveal(sections: readonly string[]): void {
  const plan = currentPlan();
  if (!plan) return;
  for (const section of sections) {
    if (plan.sections.includes(section as FusionSection)) plan.revealed.add(section as FusionSection);
  }
  notify();
}

/** 主动取消（用户自己动手、或这一轮被打断）→ 立刻交回给人 */
export function cancelFusionReveal(): void {
  if (!currentPlan()) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：这一屏**已经被推进到哪些段**。
 *
 * `null` = 没有计划（页面自己决定显示什么：四块都在）；
 * 数组 = 只允许这几段出现（顺序按计划里的段顺序）。
 */
export function fusionSectionsFor(): FusionSection[] | null {
  const plan = currentPlan();
  if (!plan) return null;
  return plan.sections.filter((section) => plan.revealed.has(section));
}

/** React 侧订阅（用法见 `adaptTabs.tsx` 的 FusionTab） */
export function useFusionReveal(): FusionSection[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    const shared = storeOf().listeners;
    shared.add(listener);
    return () => {
      shared.delete(listener);
    };
  }, []);
  return fusionSectionsFor();
}

/**
 * 页面挂载探针：等融合页真的渲染出来再补拍点。
 *
 * 判据用 `.adapt-grid--fusion`（这一页唯一的骨架，导航没到就一定没有）。
 * ⚠ 与清洗页同一个教训：探针类名写错 → 探测永远为假 → 立刻"到点补齐"，
 *   逐段推进等于没发生，而现象看起来像"功能没生效"。
 */
export function fusionMounted(): boolean {
  return typeof document !== "undefined" && document.querySelector(".adapt-grid--fusion") !== null;
}
