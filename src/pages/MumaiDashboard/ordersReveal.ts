/**
 * 工单详情的「随播报逐组展开」控制（演示用）
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────
 * 演示时用户说「读取这份工单」，期望的是：小木一边念，详情页一边**按同一节奏**
 * 把大模块铺开 —— 而不是人还没开口、整页内容已经全在那儿。
 *
 * ── 为什么用"计划 + 事件"而不是 URL 参数 ────────────────────────────
 *   · URL 参数（`?reveal=2`）会把播放进度写进历史记录，浏览器前进/后退会看到
 *     一串中间态，还会污染 `Orders.tsx` 的 `?order=` 选中逻辑；
 *   · 放组件 state 又跨不过"agent 在气泡里说话 / 页面在路由里渲染"这道边界。
 * 所以用模块级**一次性计划**：由 agent 开场时登记，按拍点推进，播完自动解除。
 *
 * ── 安全边界（很重要）─────────────────────────────────────────────────
 * **没有计划时一律"全部可见"** —— 用户自己点进工单、从地图跳进来、刷新页面，
 * 看到的都是完整详情。只有 agent 明确登记过的那一张工单、在那一次播报期间，
 * 才会逐组揭示。这条边界保证"演示效果"不会传染成"页面坏了"。
 *
 * ── 为什么是"命名分组"而不是"计数"（v1.1 改法）──────────────────────
 * 旧实现是 `beginOrderReveal(orderId, total: number)` + `useOrderReveal()` 返回数字，
 * 页面侧靠下标约定（`stage > 0` / `> 1` / `> 2`）决定显示哪些分区。问题有两个，
 * 都在《新工单红头委托与小木联动-AI交接文档 v1.0》里被点名：
 *   ① 文档要求"四组模块**按播报语义节点**依次展开"。计数无法表达"这一句对应哪一组"，
 *      只能平均分配，于是"人员 / 环境 / 下发 / 成果"被挤在同一段里一起冒出来 ——
 *      而文档明令这些**不得提前出现**；
 *   ② `panels: 3` 的语义只活在 `WorkOrderDetail.tsx` 的下标里，加一组就要同时改
 *      声明、推进、下标三处，极易漂移。
 * 现在：剧本声明**组名**、页面按**组名**门控、计划按**组名**推进。
 *
 * 调用关系：
 *   `agent/executor.ts`（剧本轮次）→ `beginOrderReveal` / `advanceOrderReveal`
 *   `pages/WorkOrderDetail.tsx`     → `useOrderReveal(orderId)` 拿到该显示哪些组
 */

import { useEffect, useState } from "react";

/** 单次揭示计划的兜底存活时间：agent 中途被打断也不会让页面停在半截 */
const PLAN_TTL_MS = 30000;

/**
 * 中文播报语速（字/秒）。
 *
 * 用来把台词长度换算成揭示节奏。**必须与 `tts.ts` 的看门狗口径一致** ——
 * 两处一旦漂移，就会出现"声音念完了、板块还在慢慢亮"（或反过来提前铺满）。
 * 5.5 字/秒对应约 182ms/字；此前 executor 里写的是 260ms/字，明显偏长，
 * 实测第①轮 64 字估算出 16.6s，而实际约 11.6s —— 那正是"页面跟不上嘴"的算术来源。
 */
export const CHARS_PER_SECOND = 5.5;

/** 每段至少留这么久，避免短句连闪（与 scriptStage 时期的口径一致） */
const MIN_SEGMENT_MS = 420;

/**
 * 工单详情页的**四大组**，顺序即播报顺序。
 *
 * ⚠ 顺序是契约：`script.ts` 的揭示声明与这里必须一致，测试会逐项核对
 *   （`ordersReveal.test.ts` 的「分段声明」用例），改动时两边一起改。
 */
export const ORDER_DETAIL_SECTIONS = ["order", "scope", "tasks", "pending"] as const;

export type OrderDetailSection = (typeof ORDER_DETAIL_SECTIONS)[number];

/**
 * 把台词切成语义段（按标点）。
 * 切句而不是按字数硬切：标点处本来就是说话的停顿，在那里切换分组最自然。
 */
export function splitSegments(text: string): string[] {
  const parts = String(text)
    .split(/[。！？；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [String(text)];
}

/** 一段文字的播报耗时估算（毫秒） */
export function segmentDurationMs(segment: string): number {
  return Math.max(MIN_SEGMENT_MS, Math.round((segment.length / CHARS_PER_SECOND) * 1000));
}

/** 一个揭示拍点：第几段念完之后，应把哪些组显示出来（时间按**段**累加算出） */
export type RevealBeat = {
  /** 第几段（从 0 开始） */
  segmentIndex: number;
  /** 该段念完的时刻（毫秒，相对开口） */
  atMs: number;
  /** 到这一刻应揭示的组（只含本拍新推进的） */
  sections: string[];
};

/**
 * 把"声明的拍点表"对齐到**实际段数**。
 *
 * ── 为什么必须有这一步（真踩过，8 轮同时中招）──────────────────────
 * 声明里的 `beats` 是按"这段台词会切出几句话"写死的，而实际段数是**语言决定的**：
 * 一句话里全是顿号、没有句号，`splitSegments` 就只能切出 1 段。
 * 旧实现在 `buildRevealSchedule` 里取 `min(段数, 拍数)` 截断 —— 于是多出来的组
 * **连定时器都不会有**：第①轮 3 段 / 4 拍 → `pending` 永不揭示，页面永久停在 3/7；
 * 第④⑩⑰⑳㉑轮只有 1 段 / 3 拍 → 只亮 `order`，另外两组永不出现。
 * 表现是"小木念完了，板块还缺一块"，而且**只能等 30 秒兜底 TTL** 才补齐。
 *
 * ── 规则 ───────────────────────────────────────────────────────────
 *   · 段数 ≥ 拍数：原样返回（逐拍推进，节奏不变）；
 *   · 段数 < 拍数：把**每一拍的组按顺序**摊到现有段上，首末段必须各占一拍，
 *     保证 `sections` 里的每一组都排得进某一拍 —— **一个都不许落下**。
 *
 * 宁可某一拍多亮一组（念到最后一句时补齐），也不能留下永不出现的板块：
 * "少一块"比"少一次停顿"严重得多。
 *
 * @param segments 台词实际切出的语义段（顺序即播报顺序）
 * @param beats    声明的拍点表（与 `segments` 下标对齐意图）
 */
export function alignBeats(segments: string[], beats: string[][]): string[][] {
  const segCount = segments.length;
  if (segCount === 0) return [];
  if (beats.length <= segCount) return beats.slice(0, segCount);

  /* 按"拍到段的映射"合并：map[i] 收集落在第 i 段上的所有组，顺序即声明顺序 */
  const map: string[][] = Array.from({ length: segCount }, () => []);
  const span = segCount - 1;
  for (let i = 0; i < beats.length; i += 1) {
    const at = span === 0 ? 0 : Math.round((i * span) / (beats.length - 1));
    for (const key of beats[i] ?? []) if (!map[at].includes(key)) map[at].push(key);
  }
  return map;
}

/**
 * 按"语义拍点表"算揭示计划。
 *
 * ── 与旧算法的区别（这是本次要修的行为）────────────────────────────
 * 旧算法把**整段台词的总时长**按分区数平均分配，于是各拍等距 ——
 * 短句和长句的落点一样长，念到哪、亮到哪就对不上。
 * 现在按**段**累加：第 n 段的时刻 = 前 n-1 段的估算时长之和。
 *
 * ⚠ 调用方先把 `beats` 交给 `alignBeats()` 对齐到实际段数（见那里的说明）——
 *   本函数只负责"按段累加算时刻"，不再做任何截断。
 *
 * @param segments 台词切成的语义段（顺序即播报顺序）
 * @param beats    每段对应要推进的组（与 `segments` 下标对齐；缺省即该段不推进）
 */
export function buildRevealSchedule(segments: string[], beats: string[][]): RevealBeat[] {
  const count = Math.min(segments.length, beats.length);
  const out: RevealBeat[] = [];
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    out.push({ segmentIndex: i, atMs: acc, sections: [...(beats[i] ?? [])] });
    acc += segmentDurationMs(segments[i]);
  }
  return out;
}

type RevealPlan = {
  orderId: string;
  /** 这次计划**允许**揭示的组（顺序即播报顺序） */
  sections: string[];
  /** 已经揭示的组 */
  revealed: Set<string>;
  /** 兜底定时器：到点自动解除计划（页面随即完整显示） */
  timer: number;
};

/**
 * 模块级状态。
 *
 * ── ⚠ 为什么不直接用 `let plan = null`（真踩过）────────────────────
 * Vite dev 下同一个源文件**可能被实例化多份**：`"../ordersReveal"`（相对引用）
 * 与 `/src/pages/MumaiDashboard/ordersReveal`（绝对引用）会落到不同的模块实例。
 * 一旦如此，`executor` 登记的计划与 `WorkOrderDetail` 读到的计划**不是同一份** ——
 * 现象是"台词念完了，页面一组都没亮"（`revealSectionsFor` 永远返回 null 或永远空）。
 * 把状态挂到 `globalThis` 上，模块被求值几次都只有一份计划。
 * 本仓库既有做法一致（`window.__mumaiAsk`、`window.__mumaiAgent` 同理）。
 */
const STORE_KEY = "__mumaiOrdersRevealStore";

type RevealStore = { plan: RevealPlan | null; listeners: Set<() => void> };

function storeOf(): RevealStore {
  const host = globalThis as unknown as { [STORE_KEY]?: RevealStore };
  return (host[STORE_KEY] ??= { plan: null, listeners: new Set() });
}

/** 当前计划（每次读都从共享 store 取，保证与别的模块实例看到同一份） */
function currentPlan(): RevealPlan | null {
  return storeOf().plan;
}

function setPlan(next: RevealPlan | null): void {
  storeOf().plan = next;
}

function notify(): void {
  /* 遍历**共享 store** 的监听器：本模块实例订阅的与别处订阅的都要通知到 */
  for (const listener of storeOf().listeners) listener();
}

function clearPlan(): void {
  const current = currentPlan();
  if (current) window.clearTimeout(current.timer);
  setPlan(null);
}

/**
 * 登记一次揭示计划（agent 在"要念这张工单"时调用）。
 *
 * 刚登记时**一组都不揭示**：第一组要等第一句念出来才亮，
 * 否则会出现"人还没开口、摘要已经在了"。
 */
export function beginOrderReveal(orderId: string, sections: readonly string[]): void {
  if (!orderId || sections.length === 0) return;
  clearPlan();
  setPlan({
    orderId,
    sections: [...sections],
    revealed: new Set<string>(),
    timer: window.setTimeout(() => {
      /* 兜底：到点还没播完就解除计划，页面回到"完整显示"，不留半截 */
      clearPlan();
      notify();
    }, PLAN_TTL_MS),
  });
  notify();
}

/**
 * 推进揭示：把 `sections` 里的组标为已揭示。
 *
 * 幂等（重复推进同一组无副作用）；只对**本计划绑定的工单**生效（防串单）。
 * 全部揭示完即视为播完，计划自动解除 —— 页面显示完整内容。
 */
export function advanceOrderReveal(orderId: string, sections: readonly string[]): void {
  /*
    先把计划取到局部常量再判断：`currentPlan()` 每次返回的是**共享 store** 里的引用，
    TS 不会把这个调用结果的收窄带进后面的闭包（`every(...)` 里的回调），
    直接写会报 "possibly null"。取局部引用是最省事也最安全的写法 ——
    顺带保证整个函数体看到的是**同一份**计划（中途被清掉也不会读空）。
  */
  const current = currentPlan();
  if (!current || current.orderId !== orderId) return;
  for (const key of sections) {
    if (current.sections.includes(key)) current.revealed.add(key);
  }
  if (current.sections.every((key) => current.revealed.has(key))) {
    clearPlan();
    notify();
    return;
  }
  notify();
}

/** 主动取消（例如用户中途点了别的工单、或交互被中断）→ 立刻完整显示 */
export function cancelOrderReveal(): void {
  if (!currentPlan()) return;
  clearPlan();
  notify();
}

/**
 * 页面侧：当前这张工单**该显示哪些组**。
 *
 * 返回值语义（注意与旧版的区别）：
 *   · `null`         —— 完整显示。没有计划、或计划不属于这张工单时的默认值；
 *   · `string[]`     —— 只显示这些组（按声明顺序）。
 *
 * 用 `null` 而不是"空数组"表达"完整显示"：空数组是有意义的（一组都还没亮），
 * 两者混用会让调用方把"刚登记还没开口"错当成"没有计划"，从而一次性铺满。
 */
export function revealSectionsFor(orderId: string | null | undefined): string[] | null {
  /* 同 advanceOrderReveal：模块级可变变量要先落到局部，闭包里的收窄才成立 */
  const current = currentPlan();
  if (!orderId || !current || current.orderId !== orderId) return null;
  return current.sections.filter((key) => current.revealed.has(key));
}

/**
 * React 侧订阅：拿到该工单**该显示哪些组**（`null` = 完整显示）。
 *
 * 返回的数组是每次渲染新构造的（`revealSectionsFor` 里 filter 出来的），
 * 所以调用方**不要**把它放进依赖数组参与相等比较 —— 用 `?.length` 或 `?.includes()`。
 */
export function useOrderReveal(orderId: string | null | undefined): string[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    const shared = storeOf().listeners;
    shared.add(listener);
    return () => {
      shared.delete(listener);
    };
  }, []);
  return revealSectionsFor(orderId);
}
