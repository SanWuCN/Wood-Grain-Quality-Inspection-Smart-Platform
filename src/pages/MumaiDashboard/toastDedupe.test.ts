/**
 * 通知去重（unit test）
 *
 * ── 防的是什么（用户实测反馈）────────────────────────────────────────
 * 「这边怎么打开了一大堆红头文件预览」
 *
 * 诱因链条：连按 `Ctrl+Q+L` 会留下**多条**通知，每条都带「查看」；
 * 每条「查看」都能点开红头委托预览 —— 于是看起来像"打开了一大堆委托"。
 * 同一张工单的重复通知本该合并成一条，这是本次要钉住的行为。
 *
 * ── 为什么在 Node 里测纯逻辑而不是渲染 ──────────────────────────────
 * 本仓库的单测跑在 Node 原生 `--test` 下，没有 DOM、也不许为此加依赖。
 * 而"哪些通知该合并"本来就是一段可以脱离 UI 讲清的列表规约，
 * 值得单独钉住；`context.tsx` 里的 `toast()` 只是它的调用方。
 * （浏览器侧的验证在 `tools/验红头委托.mjs`，那边验的是时序与导航。）
 *
 * ⚠ 这段逻辑与 `context.tsx` 的 `toast()` **必须一致**。两处若漂移，
 *   会出现"测试过了但界面还在堆"——所以要改就一起改，并把这里当作规格说明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type ToastAction = { label: string; to: string };
type ToastItem = { id: number; text: string; tone: string; action?: ToastAction };

let nextId = 1;
const reset = () => { nextId = 1; };

/**
 * `context.tsx` 的 `toast()` 里那段 setState 的等价实现（纯函数版）。
 *
 * 与实现保持同一判据：**按 `action.to` 合并** —— 它已含具体 orderId
 * （`commission:<orderId>`），所以同一张工单的重复通知合并、
 * 不同工单的通知各自保留（防幻觉规则 12 要求多单都能单独查看）。
 */
function pushToast(list: ToastItem[], text: string, tone: string, action?: ToastAction): ToastItem[] {
  const id = nextId++;
  const kept = action?.to ? list.filter((item) => item.action?.to !== action.to) : list;
  return [...kept, { id, text, tone, action }];
}

/* ------------------------------------------------------------------ *
 * 1. 合并行为
 * ------------------------------------------------------------------ */

test("同一去向的通知只留一条（连按快捷键不再堆一屏）", () => {
  reset();
  const target = "commission:wo-1";
  let list: ToastItem[] = [];
  list = pushToast(list, "收到新工单 WO-1，待项目经理指派", "ok", { label: "查看", to: target });
  list = pushToast(list, "收到新工单 WO-1，待项目经理指派", "ok", { label: "查看", to: target });
  list = pushToast(list, "新工单 WO-1 已存在（重复触发未重复建单）", "warn", { label: "查看", to: target });

  assert.equal(list.length, 1, `同一个去向只应留一条（实际 ${list.length} 条）`);
  /* 保留**新的一条**：文案可能不同（第三次就是"已存在"那条） */
  assert.match(list[0].text, /已存在/, "合并时应保留最新的一条");
});

test("不同工单的通知各自保留（多单都要能单独查看）", () => {
  reset();
  let list: ToastItem[] = [];
  list = pushToast(list, "收到新工单 WO-1", "ok", { label: "查看", to: "commission:wo-1" });
  list = pushToast(list, "收到新工单 WO-2", "ok", { label: "查看", to: "commission:wo-2" });

  assert.equal(list.length, 2, "不同工单不能被合并掉 —— 否则用户点不到第二张委托");
  assert.deepEqual(list.map((t) => t.action?.to), ["commission:wo-1", "commission:wo-2"]);
});

test("没有去向的通知不参与合并（普通提示各留一条）", () => {
  reset();
  let list: ToastItem[] = [];
  list = pushToast(list, "环境草稿已保存", "ok");
  list = pushToast(list, "环境草稿已保存", "ok");

  assert.equal(list.length, 2, "无 action 的通知没有可比较的去向，不应被误合并");
});

/* ------------------------------------------------------------------ *
 * 2. 合并后的可点性（不能把"该点的"合并没了）
 * ------------------------------------------------------------------ */

test("合并后仍保留最新的 id（旧 id 的定时器到期不会把新那条删掉）", () => {
  reset();
  const target = "commission:wo-9";
  let list: ToastItem[] = [];
  list = pushToast(list, "第一次", "ok", { label: "查看", to: target });
  const firstId = list[0].id;
  list = pushToast(list, "第二次", "ok", { label: "查看", to: target });
  const secondId = list[0].id;

  assert.notEqual(firstId, secondId, "合并后应是**新**的那条，id 必须不同");
  /*
    真实实现里每条通知各挂一个 8 秒定时器按 id 清理：
    旧 id 到期时 `filter(item => item.id !== 旧id)` 不会误删新那条 —— 这条断言就是在钉这点。
  */
  const afterOldTimerFires = list.filter((item) => item.id !== firstId);
  assert.equal(afterOldTimerFires.length, 1, "旧定时器到期不应删掉新通知");
  assert.equal(afterOldTimerFires[0].id, secondId);
});

test("连续 5 次同一去向，最终仍只有 1 条", () => {
  reset();
  let list: ToastItem[] = [];
  for (let i = 0; i < 5; i += 1) {
    list = pushToast(list, `第 ${i + 1} 次`, "ok", { label: "查看", to: "commission:wo-5" });
  }
  assert.equal(list.length, 1);
});
