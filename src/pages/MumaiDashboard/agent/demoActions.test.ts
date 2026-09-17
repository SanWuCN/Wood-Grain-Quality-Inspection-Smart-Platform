/**
 * 单一动作注册表（工作清单 v1.0 §10 阶段 C、阶段 D）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * §8 给每轮都写了「必须发生的可见动作」，但改造前 **7 轮说完台词页面纹丝不动**
 * （**旧编号** ③⑤⑥⑦⑪⑬⑭＝重排后的 ⑥⑧⑨⑩⑬⑮⑯）。§10 阶段 C 要求「建立**单一动作注册表**，
 * 把'播报片段—状态更新—页面展开'绑定为可回放事件」，
 * 阶段 D 又要求补齐 10 个演示表面。
 *
 * 把这两件事做成两份东西会立刻分叉：表面组件各写各的数据、动作表再抄一遍轮次。
 * 所以这里用**一份注册表**同时表达：
 *   · 哪一轮 → 播完打开哪个表面；
 *   · 那个表面展示哪些**数据键**（指向 `DEMO_SCENARIO_V3`，不写字面量）。
 *
 * ── 两条硬约束 ──────────────────────────────────────────────────────
 *   1. 25 轮**每一轮**都必须登记动作（§10 最终验收：要求操作的轮次全部有可见页面变化）；
 *   2. 表面里的每个数字都必须给**数据键**而不是字面量 ——
 *      §11.5 禁止"同一指标在三个文件里手写三个数值"。
 *      这条由本测试直接查数据键能否从 `DEMO_SCENARIO_V3` 取到值来证伪。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_ROUNDS } from "./script.ts";
import { DEMO_ACTIONS, SURFACE_KINDS, actionFor } from "./demoActions.ts";
import { scenarioValue } from "../seed/scenario.ts";

test("25 轮每一轮都登记了动作（没有'播完什么都不发生'的轮次）", () => {
  for (const round of SCRIPT_ROUNDS) {
    const action = actionFor(round.roundNo);
    assert.ok(action, `第 ${round.roundNo} 轮没有登记动作 —— 播完台词页面不会有任何变化`);
  }
  assert.equal(DEMO_ACTIONS.length, 25, "动作表应恰好覆盖 25 轮（= SCRIPT_ROUNDS 的 25 轮）");
});

test("每个动作的表面类型都在已知清单内", () => {
  for (const action of DEMO_ACTIONS) {
    assert.ok(
      (SURFACE_KINDS as readonly string[]).includes(action.surface),
      `第 ${action.roundNo} 轮的表面类型「${action.surface}」不在 SURFACE_KINDS 里`,
    );
  }
});

test("§10 阶段 D 要求的 10 个演示表面全部有轮次承接", () => {
  /*
    §10 阶段 D 逐条点名的表面。每条都要能指到至少一轮 ——
    否则就是"要求做了但没人用"，页面上永远看不到。
  */
  const required: [string, string][] = [
    ["weather", "天气四分类"],
    ["material", "素材质检"],
    ["anomaly", "异常帧"],
    ["receipt", "接收清单"],
    ["clean", "清洗漏斗"],
    ["model", "模型对照"],
    ["deploy", "部署演习"],
    ["fusion", "三路融合"],
    ["review", "复盘"],
    ["delivery", "交付差异"],
  ];
  for (const [kind, label] of required) {
    assert.ok(
      (SURFACE_KINDS as readonly string[]).includes(kind),
      `SURFACE_KINDS 缺少「${kind}」（${label}）`,
    );
    const users = DEMO_ACTIONS.filter((a) => a.surface === kind);
    assert.ok(users.length >= 1, `表面「${kind}」（${label}）没有任何轮次使用它`);
  }
});

test("动作里的每个数据键都能从 DEMO_SCENARIO_V3 取到值（禁止散落字面量）", () => {
  for (const action of DEMO_ACTIONS) {
    assert.ok(action.dataKeys.length > 0, `第 ${action.roundNo} 轮的动作没有给数据键`);
    for (const key of action.dataKeys) {
      const value = scenarioValue(key);
      assert.notEqual(
        value,
        undefined,
        `第 ${action.roundNo} 轮引用了不存在的数据键「${key}」—— 数字必须是取自数据包，不能是字面量`,
      );
    }
  }
});

test("动作的按钮只改本地演习状态，不带真实下发语义", () => {
  for (const action of DEMO_ACTIONS) {
    if (action.button) {
      /*
        §10 阶段 D：「所有按钮只改变本地演习状态，真实危险操作一律不可达」。
        所以按钮文案里不得出现会被理解成"真在操作"的词。

        ⚠ 判据要区分**肯定**与**否定**语境（第一版没区分，误报了）：
          · 「演习核对（不执行真实刷写）」—— 含「刷写」，但是**否定式说明**，
            恰恰是清单要求的"显著标注演习不刷写"，必须放行；
          · 「刷写到设备」—— 肯定式，属于要拦的。
        判法：命中禁用词时，看它前面 3 个字里有没有否定词。
      */
      const negatives = ["不", "勿", "非", "无需", "未"];
      for (const bad of ["下发设备", "刷写", "开始训练", "部署到设备"]) {
        let idx = action.button.indexOf(bad);
        while (idx >= 0) {
          /*
            ⚠ 窗口取 6 个字：实测「不**执行真实**刷写」里"不"与"刷写"隔了 5 个字，
            取 3 字窗口会把它误判成肯定式。禁用词本身很具体（4 个），
            窗口放宽不会漏掉真的违规写法。
          */
          const before = action.button.slice(Math.max(0, idx - 6), idx);
          assert.ok(
            negatives.some((n) => before.includes(n)),
            `第 ${action.roundNo} 轮的按钮文案「${action.button}」含**肯定式**真实操作语义「${bad}」（若是否定式说明，请写成「不…${bad}」）`,
          );
          idx = action.button.indexOf(bad, idx + 1);
        }
      }
    }
    assert.equal(typeof action.simulated, "boolean", `第 ${action.roundNo} 轮必须声明是否只影响本地演习状态`);
    assert.equal(action.simulated, true, `第 ${action.roundNo} 轮的动作必须声明只影响本地演习状态（§10 阶段 D）`);
  }
});

test("动作按幕/顺序排列，且标题不重复", () => {
  const titles = DEMO_ACTIONS.map((a) => a.title);
  assert.equal(new Set(titles).size, titles.length, `动作标题有重复：${titles.join(" / ")}`);
  /* 顺序应与剧本一致，便于逐轮核对 */
  assert.deepEqual(
    DEMO_ACTIONS.map((a) => a.roundNo),
    SCRIPT_ROUNDS.map((r) => r.roundNo),
    "动作表顺序应与 SCRIPT_ROUNDS 一致（逐轮对表时不至于错位）",
  );
});

/* ------------------------------------------------------------------ *
 * 现场穿帮的三道反向锁
 *
 * 这三条都是**看了真实演示之后**才发现的：界面在告诉观众"这是排练"。
 * 判据刻意写成"不许出现"，而不是"应该长什么样" —— 前者能证伪。
 * ------------------------------------------------------------------ */

test("面向观众的文案里不得出现「演习 / 演练」", () => {
  /*
    现场原话：「别的一些显示本地演习的意思，都穿帮了」。
    角标写「本地演习数据」、按钮写「演习下发」、按钮说明写「仅改变本地演习状态」
    —— 讲解人正说着业务，界面在旁边说演戏。

    诚实性不变：数据来源仍标注（改成「本地实测数据」），按钮影响范围仍说清
    （改成「只更新平台状态，不向设备发送指令」），只是不再用自我拆台的词。
  */
  const banned = ["演习", "演练"];
  const offenders = [];
  for (const action of DEMO_ACTIONS) {
    const fields: [string, string][] = [["标题", action.title], ["按钮", action.button ?? ""]];
    for (const [field, value] of fields) {
      for (const word of banned) {
        if (value.includes(word)) offenders.push(`第 ${action.roundNo} 轮${field}「${value}」含「${word}」`);
      }
    }
  }
  assert.deepEqual(offenders, [], `面向观众的文案里出现了排练用语：${offenders.join("；")}`);
});

test("工单页轮次的标题不得再描述「演示流程」（页面已经跳过去了）", () => {
  /*
    现场原话：「左下角弹出的打开新工单档案，四组模块随播报展开，穿帮了」。
    那行字写的是"小木这一轮在演示什么"，不是"平台现在是什么状态"。
    现在这 8 轮（②③④⑪⑳㉓㉔㉕）不再弹浮层（见 revealOnly），这里再锁一道标题措辞。
  */
  const narrations = ["随播报展开", "演示流程", "本轮", "这一轮"];
  const offenders = [];
  for (const action of DEMO_ACTIONS) {
    if (!action.revealOnly) continue;
    for (const word of narrations) {
      if (action.title.includes(word)) offenders.push(`第 ${action.roundNo} 轮标题「${action.title}」含旁白「${word}」`);
    }
  }
  assert.deepEqual(offenders, [], `工单页轮次的标题仍在描述演示流程：${offenders.join("；")}`);
});

test("标了 revealOnly 的轮次必须真的在工单页有线可展（否则既没浮层也没动作）", () => {
  const revealRounds = new Set(
    SCRIPT_ROUNDS.filter((r) => r.reveal?.target === "order-detail").map((r) => r.roundNo),
  );
  const orphans = DEMO_ACTIONS.filter((a) => a.revealOnly && !revealRounds.has(a.roundNo));
  assert.deepEqual(orphans.map((a) => a.roundNo), [],
    `这些轮次标了 revealOnly 却没有工单详情页揭示声明 —— 播完台词屏幕上什么都不会发生：${orphans.map((a) => a.roundNo).join("、")}`);

  /* 反向：标了 revealOnly 就不该再带浮层按钮（按钮长在浮层上，浮层不显示按钮就没意义） */
  const withButton = DEMO_ACTIONS.filter((a) => a.revealOnly && a.button);
  assert.deepEqual(withButton.map((a) => a.roundNo), [],
    "标了 revealOnly 的轮次不显示浮层，按钮不会出现 —— 应把按钮语义挪到工单页或去掉");
});
