/**
 * 工单详情「随播报逐组展开」· 计划机制（unit test）
 *
 * ── 为什么从"计数"改成"命名"
 * 旧实现是 `beginOrderReveal(orderId, total)` + `useOrderReveal()` 返回一个**数字**，
 * 页面侧用下标约定（`revealStage > 0` / `> 1` / `> 2`）决定显示哪些分区。
 * 那套写法有两个问题，在《新工单红头委托与小木联动-AI交接文档 v1.0》里都被点名：
 *   ① 交接文档要求"四组模块**按播报语义节点**依次展开"，而计数无法表达
 *      "这一句对应哪一组"——只能平均分配，于是"人员 / 环境 / 下发 / 成果"
 *      会被挤在同一段里一起冒出来（文档明令：**不得提前出现**）；
 *   ② `panels: 3` 这个数字的语义只存在于 `WorkOrderDetail.tsx` 里的下标约定中，
 *      加一组模块就要同时改三处（声明、推进、下标），极易漂移。
 * 现在改成**命名分段**：剧本声明组名、页面按组名门控、计划按组名推进。
 *
 * ── 本轮测试先钉住的行为（实现前应当是红的）
 *   1. 计划按**组名**推进，`revealed` 单调增长且不重复
 *   2. 没有计划时（用户自己点进工单 / 刷新）**全部可见**，不漏内容
 *   3. 计划只在**它绑定的那张工单**上生效 —— 看别的工单必须完整显示（不串单）
 *   4. 全部揭示完 / 主动取消 / 兜底超时 → 计划解除，页面回到完整可见
 *   5. 语义拍点：每个语义段至少推进一组，且顺序与声明一致；最后一段推完全部
 *   6. 拍点时间按**段**累加（不是按整段总字数平均分配）
 *
 * ⚠ 这组测试在 Node 里跑，没有 DOM —— 所以只测**纯逻辑**：
 *   `window` 的定时器用最小桩替换（见下方 mockWindow），
 *   `useOrderReveal` 这个 React hook 不在这里测（它只做订阅转发）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRIPT_ROUNDS } from "./agent/script.ts";

/*
  最小 window 桩：只需要 setTimeout / clearTimeout。
  刻意**不用**真实定时器 —— 测试要能手动"快进"，而不是等 30 秒。
*/
type FakeTimer = { id: number; fn: () => void; ms: number };
const fake: { timers: FakeTimer[]; next: number } = { timers: [], next: 1 };

(globalThis as unknown as { window: unknown }).window = {
  setTimeout(fn: () => void, ms: number): number {
    const id = fake.next++;
    fake.timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout(id: number): void {
    fake.timers = fake.timers.filter((t) => t.id !== id);
  },
};

/** 跑掉所有已登记的定时器（模拟"时间到了"） */
function runTimers(): void {
  const pending = [...fake.timers];
  fake.timers = [];
  for (const t of pending) t.fn();
}

/** 每个用例之间要把模块级状态清干净（计划是模块级单例） */
function resetAll(): void {
  cancelOrderReveal();
  fake.timers = [];
  fake.next = 1;
}

const {
  ORDER_DETAIL_SECTIONS,
  alignBeats,
  buildRevealSchedule,
  beginOrderReveal,
  advanceOrderReveal,
  cancelOrderReveal,
  revealSectionsFor,
  splitClauses,
  splitSegments,
} = await import("./ordersReveal.ts");

/* ------------------------------------------------------------------ *
 * 1. 分段声明本身
 * ------------------------------------------------------------------ */

test("分段声明：顺序固定、无重复，且覆盖最后三轮的三份生成物", async () => {
  /*
    前四组是第①–④轮讲的那张单本身；后九组是小木在最后三轮生成的交付物
    （用户 2026-10-01：「最后几个对话需要更好的平台展示，而不只是跳转下页面」）。
    顺序是契约：`script.ts` 的拍点表按这个顺序推进，来回跳会让页面看起来在闪。
  */
  assert.deepEqual(
    [...ORDER_DETAIL_SECTIONS],
    [
      "order",
      "scope",
      "tasks",
      "pending",
      "draft-focus",
      "draft-attachments",
      "draft-advice",
      "review-done",
      "review-issues",
      "review-version",
      "review-todo",
      "summary-check",
      "summary-todo",
      "summary-linked",
    ],
    "组名顺序即播报顺序：摘要 → 范围与清单 → 四项任务 → 待确认与后续 → ㉓草稿 → ㉔复盘 → ㉕交付摘要",
  );
  assert.equal(new Set(ORDER_DETAIL_SECTIONS).size, ORDER_DETAIL_SECTIONS.length, "不能有重复组名");

  /* 三份生成物的组名必须与数据模块逐字一致（两边各写一份就会漂） */
  const { DELIVERABLE_SECTIONS } = await import("./pages/orders/orderDeliverables.ts");
  assert.deepEqual(
    [...DELIVERABLE_SECTIONS.draft, ...DELIVERABLE_SECTIONS.review, ...DELIVERABLE_SECTIONS.summary],
    [...ORDER_DETAIL_SECTIONS].slice(4),
    "数据模块里的三份生成物组名与揭示声明必须一一对应",
  );
});

/* ------------------------------------------------------------------ *
 * 2. 计划推进与解除
 * ------------------------------------------------------------------ */

test("计划按组名推进：revealed 单调增长、不重复、只在绑定的工单上生效", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);

  assert.deepEqual(revealSectionsFor("wo-1"), [], "刚登记时一组都还没揭示");
  assert.deepEqual(revealSectionsFor("wo-2"), null, "别的工单不受影响（返回 null 表示完整可见）");

  advanceOrderReveal("wo-1", ["order"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order"]);

  advanceOrderReveal("wo-1", ["scope", "tasks"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order", "scope", "tasks"], "按声明顺序数组");

  /* 重复推进同一组不应重复出现 */
  advanceOrderReveal("wo-1", ["scope"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order", "scope", "tasks"], "重复推进是幂等的");

  /* 推错了工单：整条调用被忽略 */
  advanceOrderReveal("wo-other", ["pending"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order", "scope", "tasks"], "别的工单不能推进本计划");
});

test("全部揭示完 → 计划解除，页面回到完整可见", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  advanceOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  assert.equal(revealSectionsFor("wo-1"), null, "揭示完毕必须解除计划（null = 完整显示）");
});

/*
  ── 同一张单、同一份声明：第二次登记**不许把已亮的清掉**（2026-09-30）────
  场景：工单页「工单识别」按钮先登记一次（好让页面在小木开口前只显示第一拍），
  紧接着第②轮开讲时 executor 又登记一次。若每次都重来，页面会塌回"一组都没有"
  再重新亮 —— 台上看到的是"内容闪了一下"。
*/
test("同单同声明的重复登记：保留已揭示的组，不把页面清空重来", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  advanceOrderReveal("wo-1", ["order"]);
  /* 第二轮登记（同单、同声明、顺序也相同） */
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order"], "已亮的组必须还在（不能闪回空白）");
  /* 后续拍点照常推进，最后正常解除 */
  advanceOrderReveal("wo-1", ["scope", "tasks", "pending"]);
  assert.equal(revealSectionsFor("wo-1"), null);
});

test("换了工单或换了声明：必须重来一份计划（旧计划的进度不能带过去）", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  advanceOrderReveal("wo-1", ["order", "scope"]);
  /* ① 换工单 */
  beginOrderReveal("wo-2", ["order", "scope", "tasks", "pending"]);
  assert.deepEqual(revealSectionsFor("wo-2"), [], "新工单要从头开始");
  assert.equal(revealSectionsFor("wo-1"), null, "旧工单不再受计划约束");
  /* ② 同工单但声明不同（顺序变了） */
  advanceOrderReveal("wo-2", ["order", "scope"]);
  beginOrderReveal("wo-2", ["scope", "order", "tasks", "pending"]);
  assert.deepEqual(revealSectionsFor("wo-2"), [], "声明不同就是另一次登记，从零开始");
});

test("主动取消 → 立刻恢复完整可见（不能把页面留在半展开）", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  advanceOrderReveal("wo-1", ["order"]);
  assert.deepEqual(revealSectionsFor("wo-1"), ["order"]);
  cancelOrderReveal();
  assert.equal(revealSectionsFor("wo-1"), null);
});

test("兜底超时 → 计划自动解除，页面不永久停半截", () => {
  resetAll();
  beginOrderReveal("wo-1", ["order", "scope", "tasks", "pending"]);
  advanceOrderReveal("wo-1", ["order"]);
  assert.equal(fake.timers.length, 1, "登记时应挂一个兜底定时器");
  assert.ok(fake.timers[0].ms >= 20000, `兜底时长不能太短（实际 ${fake.timers[0].ms}ms）`);

  runTimers();
  assert.equal(revealSectionsFor("wo-1"), null, "兜底到点必须解除计划");
});

test("空分组 / 空 orderId 一律不登记计划（退回完整显示，而不是显示空页）", () => {
  resetAll();
  beginOrderReveal("", ["order"]);
  assert.equal(revealSectionsFor(""), null);
  beginOrderReveal("wo-3", []);
  assert.equal(revealSectionsFor("wo-3"), null, "没有分组可揭示时不该登记计划");
});

/* ------------------------------------------------------------------ *
 * 3. 语义拍点（本轮的核心新行为）
 * ------------------------------------------------------------------ */

/** 第①轮的四段短回复（与 script.ts 的 v1.0 文案对应） */
const SEGMENTS_V1 = [
  "读取中，工单摘要已生成。",
  "任务范围和出发清单已生成。",
  "已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付。",
  "附件里未明确的信息，我已单独列出。本次任务涉及的木构主体为四根木柱，我已按照 Z01 至 Z04 编号。",
];

/** 交接文档「模块展开节拍」表：第 n 段播完时该显示到哪一组 */
const BEATS_V1: string[][] = [
  ["order"],
  ["scope"],
  ["tasks"],
  ["pending"],
];

test("语义拍点：每段至少推进一组，且顺序与声明一致", () => {
  const schedule = buildRevealSchedule(SEGMENTS_V1, BEATS_V1);
  assert.equal(schedule.length, SEGMENTS_V1.length, "几段台词就应有几个拍点");

  let lastIndex = -1;
  const seen = new Set<string>();
  for (const [i, beat] of schedule.entries()) {
    assert.ok(beat.sections.length > 0, `第 ${i + 1} 段没有推进任何一组（会出现"念了但页面没动"）`);
    for (const key of beat.sections) {
      const idx = ORDER_DETAIL_SECTIONS.indexOf(key as (typeof ORDER_DETAIL_SECTIONS)[number]);
      assert.ok(idx > lastIndex, `第 ${i + 1} 段推进了 ${key}，但它的顺序不在前一拍之后（会来回跳）`);
      assert.ok(!seen.has(key), `${key} 被推进了两次`);
      lastIndex = idx;
      seen.add(key);
    }
  }
  /* 这里比的是**这一轮声明的组**（BEATS_V1 的并集），不是页面上全部组 ——
     最后三轮的三份生成物不在第①轮的拍点表里，拿全部组去比会假红 */
  assert.deepEqual([...seen], BEATS_V1.flat(), "四段念完必须覆盖这一轮声明的全部组");
});

test("拍点时间按**段**累加，不是按整段总字数平均分配", () => {
  const schedule = buildRevealSchedule(SEGMENTS_V1, BEATS_V1);

  assert.equal(schedule[0].atMs, 0, "第一拍在开口时立刻推进（页面不能是空的）");

  /* 逐段累加：第 n 拍的 atMs 应等于前 n-1 段时长之和 */
  let acc = 0;
  for (const [i, seg] of SEGMENTS_V1.entries()) {
    const expected = acc;
    assert.equal(schedule[i].atMs, expected, `第 ${i + 1} 拍应在 ${expected}ms（前几段累计）`);
    acc = expected + Math.max(420, Math.round((seg.length / 5.5) * 1000));
  }

  /* 反证"平均分配"是错的：短段与长段的落点不能等距 */
  const gaps = schedule.slice(1).map((b, i) => b.atMs - schedule[i].atMs);
  assert.ok(new Set(gaps).size > 1, `各段时长不应完全相同（实际 ${gaps.join(",")}）——若相同说明又按平均数分配了`);
});

test("段数少于拍数时把多出来的组摊到现有段上，一组都不许落下", () => {
  const more = buildRevealSchedule(["只有一段。"], alignBeats(["只有一段。"], BEATS_V1));
  assert.equal(more.length, 1, "段少时只产出实际段数的拍点");
  assert.deepEqual(more[0].sections, ["order", "scope", "tasks", "pending"],
    "只有一段时四组必须在这一拍里补齐 —— 否则后三组永远不会亮");

  /* 两段 / 四拍：首段第一组、末段含最后一组，中间顺次铺开 */
  const two = buildRevealSchedule(["甲。", "乙。"], alignBeats(["甲。", "乙。"], BEATS_V1));
  assert.equal(two.length, 2, "两段台词就是两个拍点");
  assert.equal(two[0].sections[0], "order", "第一段必须先亮摘要");
  assert.ok(two[1].sections.includes("pending"), "最后一段必须把末组补齐");
  assert.deepEqual([...two[0].sections, ...two[1].sections], BEATS_V1.flat(),
    "两拍合起来要覆盖这一轮声明的全部组，不重不漏");

  /* 段数 ≥ 拍数：原样返回，逐拍推进的节奏不变 */
  const aligned = alignBeats(SEGMENTS_V1, BEATS_V1);
  assert.deepEqual(aligned, BEATS_V1, "段数够时对齐不改变声明");
});

test("空输入不抛异常，返回空计划", () => {
  assert.deepEqual(buildRevealSchedule([], BEATS_V1), []);
  assert.deepEqual(buildRevealSchedule(SEGMENTS_V1, []), []);
  assert.deepEqual(alignBeats([], BEATS_V1), [], "没有段就没有拍，不越界");
});

/* ------------------------------------------------------------------ *
 * 4. 真实剧本全量核对 —— 这条是"永不揭示"缺陷的回归锁
 *
 * 上一次的故障：声明 4 拍、台词只切出 3 段，`min()` 把第 4 组丢掉，
 * 页面永久停在 3/7，只能等 30 秒兜底 TTL。全量扫一遍，任何一轮再出现
 * 「声明的组排不进任何一拍」都必须在这里红掉。
 * ------------------------------------------------------------------ */

test("真实 25 轮：凡声明揭示的组，都必须排得进某一拍（一个都不能落下）", () => {
  type RevealDecl = NonNullable<(typeof SCRIPT_ROUNDS)[number]["reveal"]>;
  const rounds: { roundNo: string; reveal: RevealDecl; text: string }[] = [];
  for (const r of SCRIPT_ROUNDS) {
    if (r.reveal?.target !== "order-detail") continue;
    const main = r.lines.find((l) => l.role === "main");
    assert.ok(main, `第「${r.roundNo}」轮没有 main 台词`);
    rounds.push({ roundNo: r.roundNo, reveal: r.reveal, text: main.text });
  }
  /*
    ⚠ 阈值跟着剧本走，不是拍脑袋定的。到 2026-09-23 为止，两轮的揭示目标从工单详情
    搬到了各自的真实页面：
      · ⑪「四柱风险初筛」→ **三维场景的四柱构件条**（`twin-components`，剧本演在三维场景）；
      · ⑳「设备版本回报核对」→ 不再声明 reveal（剧本那一轮是【S18】的**等待**段，
        页面是「固件及模型 · 更新交付」，那一页没有"逐块展开"的语义）。
    于是工单详情揭示从 8 轮减到 6 轮：②③④㉓㉔㉕。
    这条断言的本意是"有多轮在用工单详情揭示"（而不是那个具体数字），
    所以这里跟着改成 6，并且**下界只许再降不许乱升**：升上去意味着新增了揭示声明。
  */
  assert.ok(rounds.length >= 6, `应有多轮声明了工单详情揭示（实际 ${rounds.length} 轮）`);

  for (const { roundNo, reveal, text } of rounds) {
    /* 切段口径必须与执行侧一致（`executor.startOrderDetailReveal`）：㉓㉔㉕ 按小句切 */
    const segments = reveal.split === "clause" ? splitClauses(text) : splitSegments(text);
    const schedule = buildRevealSchedule(segments, alignBeats(segments, reveal.beats));
    const planned = schedule.flatMap((b) => b.sections);
    const missing = reveal.sections.filter((s) => !planned.includes(s));
    assert.deepEqual(missing, [],
      `第「${roundNo}」轮有 ${missing.length} 组永远排不进揭示计划（段数 ${segments.length} / 声明拍数 ${reveal.beats.length}）`);
    assert.deepEqual(planned, reveal.sections,
      `第「${roundNo}」轮的揭示顺序必须与声明的组顺序一致`);
  }
});
