/**
 * 页面内操作（`nav.op`）：跳转之后的**那一下**
 *
 * ── 为什么需要它（用户 2026-10-01）──────────────────────────────────
 * 「针对一些只有跳转不太合适的对话加上特殊页面或操作」。
 * 25 轮里绝大多数是"跳到某页 + 弹一个演示浮层"，但有几轮的主角**不是某一页**，
 * 而是**页面上要真的发生一件事**：
 *   · ⑱「同时打开归档版本的验证摘要」—— 归档页默认写着「尚未运行校验」，
 *     跳过去什么都不发生；要把**真实的交付文件校验跑一遍**（24 项逐项结论）才叫"打开摘要"；
 *   · ㉑「调用本批次分析流程」—— 融合页一打开结果就全在，需要"流程跑起来"的过程。
 * 这类动作既不是导航（URL 不变）也不是浮层（不是一块面板），所以单开一个词表。
 *
 * ── 与既有机制的关系 ────────────────────────────────────────────────
 *   · `demoSurfaceAction.ts`（`mumai:demo-surface`）管"弹哪一块浮层"；
 *   · 本模块（`mumai:nav-op`）管"页面里做哪一件事"；
 *   · 事件名与派发留在 `.ts` 里（组件那边只管监听），与本仓库既有做法一致 ——
 *     单测跑在 Node 原生类型剥离下，只认 `.ts` 不认 `.tsx`。
 *
 * ── 时序：跳转与挂载谁先到都有可能 ──────────────────────────────────
 * `runNavOp()` 既发事件、也把操作记成**待领取**：
 *   · 页面已经挂载 → 事件当场兑现；
 *   · 页面还在挂载路上 → 事件丢掉，但 `takePendingNavOp()` 在挂载时补上。
 * 两处都走 `takePendingNavOp()` 领取（领到即清空），所以**同一次跳转只会执行一次**，
 * 不会出现"事件一次 + 挂载补一次"的双跑。
 */

/** 已登记的操作名（写错一个字母 = 现场那一下永远不发生，所以有单测盯着） */
export const NAV_OPS = ["archive-verify"] as const;

export type NavOp = (typeof NAV_OPS)[number];

/**
 * 每个操作**只在某一个页面上兑现**：跳错页面 = 现场那一下永远不发生，
 * 而且不报错、只出丑 —— 所以把这层对应关系写成数据，由 `scriptNav.test.ts` 核对。
 */
export const NAV_OP_ROUTES: Record<NavOp, string> = {
  "archive-verify": "/archive",
};

/** 跨树事件名（页面监听它，见 `useNavOp`） */
export const NAV_OP_EVENT = "mumai:nav-op";

/** 待领取的操作：跳转发出后、页面挂载前的那一段窗口靠它兜住 */
let pending: NavOp | null = null;

/**
 * 请求一次页面内操作（由 `navigate_page` 在跳转之后调用）。
 *
 * @returns 事件是否真的发出去了（不在浏览器里 → false）
 */
export function runNavOp(op: NavOp): boolean {
  if (!NAV_OPS.includes(op)) {
    /* 词表外的操作一律不发：宁可什么都不做，也不要把一个错名字悄悄吞掉 */
    console.warn(`[nav-op] 未登记的操作：${op}（已登记：${NAV_OPS.join("、")}）`);
    return false;
  }
  pending = op;
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(NAV_OP_EVENT, { detail: { op } }));
  return true;
}

/** 领取一次操作：只有"正等着的那一个"能领到，领到即清空（防双跑） */
export function takePendingNavOp(op: NavOp): boolean {
  if (pending !== op) return false;
  pending = null;
  return true;
}

/** 给验收/单测看：现在有没有待领取的操作 */
export function pendingNavOp(): NavOp | null {
  return pending;
}
