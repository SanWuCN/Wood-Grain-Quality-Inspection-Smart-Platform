/**
 * 工单页的「工单识别」入口（剧本 §9：**史点击工单识别**）
 *
 * ── 用户文档要求的是什么 ──────────────────────────────────────────
 * 《木脉智检》第二章 §9 的动作列逐字写着：
 *
 *   （史点击工单识别；小木读取当前工单与附件索引，生成任务卡和装备核对清单，
 *     未填字段标为待补。）
 *
 * 也就是说：这是**史在平台上的一个真实点击**，不是他口头喊一句。此前平台上
 * 没有这个按钮 —— 剧本里要求"点"的地方只能靠快捷键（Ctrl+B+2）代替，
 * 与文档写的操作对不上。本模块把那次点击补成真的。
 *
 * ── 为什么不是"再实现一遍小木读工单" ────────────────────────────────
 * 点下去要发生的事，剧本第②轮已经全部实现好了：
 *   · `script.ts` ② 的 `intentId: "view_current_order"` → `open_order` 跳工单页；
 *   · `reveal.target: "order-detail"` → 工单摘要 / 委托与主体 / 任务范围与出发清单 /
 *     待确认信息**按台词逐组展开**（这正是"装备核对清单 + 未填字段标为待补"）；
 *   · `nav.order: "bound"` → 打开的是**显式绑定的那张工单**，不是列表最新那张。
 * 所以这里只做两件接线，绝不复制台词或跳转逻辑：
 *   1. `commissionBinding.bind(orderId)` —— 把"史点的就是这一张"写成显式绑定
 *      （防幻觉规则 3 的落点）。绑定不会自己过期，下一次点「查看」/「工单识别」
 *      会把它覆盖掉，这与通知栏「查看」那条既有口径完全一致；
 *   2. 派发既有的 `mumai:script-fire` 事件（下标 → 条目表行号），
 *      与气泡里"点关键词直达该轮"走的是**同一条**通道、同一个 `ask()` 链路。
 *
 * ── 为什么不直接调 `ask()` ────────────────────────────────────────
 * 页面上没有 `Runtime`（导航 / 会话事实 / 语音输出三件套都在 `Shell` 手里），
 * 而 `Shell` 里那份"某一轮该怎么演"的唯一实现是 `useScriptShortcut`。
 * 再写一条 ask 通路等于把按键、关键词点击、按钮三处各写一套，迟早分叉。
 *
 * ⚠ 轮次编号写死为 `②`：剧本重排编号时这里与 `script.ts` 的 `nav` 要一起改。
 *   `orderRecognize.test.ts` 把"② 必须仍是指向绑定工单的那一轮"钉住了 ——
 *   编号被挪走时先红，而不是现场点出一个别的轮次。
 */
import { SCRIPT_SHORTCUT_ENTRIES } from "../../agent/scriptShortcutEntries";
import { SCRIPT_ROUNDS, mainLineOf } from "../../agent/script";
import { KEYWORD_FIRE_EVENT } from "../../agent/keywordHint";
import { commissionBinding } from "../../commissionBinding";
import { advanceOrderReveal, alignBeats, beginOrderReveal, splitSegments } from "../../ordersReveal";

/** 点「工单识别」要演的那一轮 */
export const RECOGNIZE_ROUND_NO = "②";

/**
 * 按钮上那行小字与 tooltip 的**唯一来源**：条目表里"听到的那句话"。
 *
 * 与快捷键一览、气泡关键词提示同一份文本 —— 现场三种触发方式说法一致，
 * 不会出现"按钮的提示语和按键走的轮次对不上"。
 */
export function recognizeEntry() {
  return SCRIPT_SHORTCUT_ENTRIES.find((entry) => entry.roundNo === RECOGNIZE_ROUND_NO) ?? null;
}

/**
 * 这一轮现在**真的能演**吗（三件事缺一不可，缺了就说明剧本或表被改坏了）：
 *   · 条目表里有 ②：没有条目就没有"听到的话"，事件下标无从谈起；
 *   · ② 的落点是工单页：否则点"工单识别"会跳到别的页面去；
 *   · ② 取**显式绑定**的工单：否则会去念列表最新那张（正是要防的"念错单"）。
 */
export function recognizeReady(): boolean {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === RECOGNIZE_ROUND_NO);
  return Boolean(recognizeEntry()) && round?.nav?.route === "order" && round.nav.order === "bound";
}

/**
 * 点下去的第一件事：**把小木要读的那几组先收起来，只留第一拍**。
 *
 * ── 为什么必须有这一步（现场实测出来的）─────────────────────────────
 * 按下按钮时人**已经站在这张工单页上**，页面这时是"没有计划 → 整页完整可见"
 * （`ordersReveal` 的安全边界）。而小木要过两三秒（气泡的"思考"节拍）才开口，
 * 第②轮登记揭示计划那一刻，八个分组会**先全部消失、再一组组亮回来** ——
 * 台上看到的是"内容闪了一下"，比不做揭示还糟。
 *
 * 所以这里提前登记**同一份**计划（同一张单、同一组声明，见 `beginOrderReveal`
 * 的"同一份声明不重来"），并立刻亮出第一拍（与 `runRevealTimeline` 的 0 时刻
 * 同源：切段 → `alignBeats` → 取第一拍）。于是：
 *   · 点下这一秒 → 页面只剩"工单摘要 + 委托与主体"（正是"正在读取这份工单"）；
 *   · 小木开口后 → 第②轮自己的时间线接着往下推，节奏仍由**播报**决定。
 *
 * @returns 是否登记成功（拿不到轮次声明就 false，调用方不必据此报错）
 */
export function primeRecognizeReveal(orderId: string): boolean {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === RECOGNIZE_ROUND_NO);
  const reveal = round?.reveal;
  if (!round || !orderId || !reveal || reveal.sections.length === 0) return false;
  beginOrderReveal(orderId, reveal.sections);
  const first = alignBeats(splitSegments(mainLineOf(round)), reveal.beats ?? [])[0] ?? [];
  if (first.length) advanceOrderReveal(orderId, first);
  return true;
}

/**
 * 史点了「工单识别」：把这张工单绑给小木，让小木读它。
 *
 * @returns 事件是否真的发出去了（没有条目 / 没有工单 id / 不在浏览器里 → false，
 *          调用方据此给出可恢复提示，而不是让按钮点了没反应）
 */
export function recognizeOrder(orderId: string): boolean {
  const index = SCRIPT_SHORTCUT_ENTRIES.findIndex((entry) => entry.roundNo === RECOGNIZE_ROUND_NO);
  if (index < 0 || !orderId) return false;
  if (typeof window === "undefined") return false;
  /* 先绑定再派发：② 的导航在播报开始时读绑定，顺序反了就会打开上一张工单 */
  commissionBinding.bind(orderId);
  /* 页面先收成"读取中"的样子，免得小木开口那一刻整页闪一下（见上一条注释） */
  primeRecognizeReveal(orderId);
  window.dispatchEvent(new CustomEvent(KEYWORD_FIRE_EVENT, { detail: { index } }));
  return true;
}
