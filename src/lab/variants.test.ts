/**
 * 任务 2.7 · 变体契约（unit test）—— 在 Node 里**不调用** `create()`
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * 展台是"加一个方案 = 加一个文件 + 挂一行"的结构。这个结构的代价是：
 * **某一版写坏了，页面上表现为"这一版没做"**，而不是"这一版报错了"。
 * 症状和"用户以为我们只做了 8 版"长得一模一样，事后极难追。
 * 所以把契约检查前移到这里：只要有一版少了 `oneLiner`、`needsWebGL` 不是布尔、
 * 编号撞车，就在 `node --test` 里当场红，不必打开浏览器去数格子。
 *
 * ── 为什么在 Node 里能 import 变体（它们都 import three）─────────────
 * three 是 ESM 且模块顶层不碰 `document`/`window`（只在 `createStage()` 这类
 * **函数体内部**才建 canvas），所以 Node 里 import 得动。反过来也说明一件事：
 * 这里**只能断言静态字段**，一行 `create()` 都不能调 —— Node 里没有 WebGL，
 * 调了会以 `document is not defined` 的形式失败，那种红是环境问题、不是契约问题。
 * 真实渲染归浏览器层（Phase 3 的 E2E）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_VARIANTS } from "./types.ts";
import { assertValidRegistry } from "./registry.ts";
import { ALL_VARIANTS } from "./variants/index.ts";

/** 契约要求的静态字段（`create` 单独判，因为它是函数） */
const STRING_FIELDS = ["id", "name", "oneLiner", "tech", "cost", "fidelityNote"] as const;

test("变体清单：10 版，且编号连续 01..10（页面按编号排，缺号会让对照表对不上）", () => {
  assert.equal(ALL_VARIANTS.length, 10, "9 版 three（含紫白配色 10 号）+ 1 版老方法");
  const ids = ALL_VARIANTS.map((v) => v.id);
  assert.deepEqual(ids, ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
});

test("变体契约：每版都满足 LabVariant 的静态字段要求", () => {
  for (const variant of ALL_VARIANTS) {
    for (const field of STRING_FIELDS) {
      const value = variant[field];
      assert.equal(typeof value, "string", `方案 ${variant.id} 的 ${field} 必须是字符串`);
      assert.ok(value.trim().length > 0, `方案 ${variant.id} 的 ${field} 不能是空串`);
    }
    assert.equal(
      typeof variant.needsWebGL,
      "boolean",
      `方案 ${variant.id} 的 needsWebGL 必须是布尔（老方法写 false）`,
    );
    assert.ok(
      variant.fidelity === "high" || variant.fidelity === "mid" || variant.fidelity === "low",
      `方案 ${variant.id} 的 fidelity 只能是 high/mid/low，得到 ${variant.fidelity}`,
    );
    assert.equal(typeof variant.create, "function", `方案 ${variant.id} 的 create 必须是函数`);
    // 签名：三个入参。少写一个在两处会静默拿到 undefined（stage 尤其致命）
    assert.equal(
      variant.create.length,
      3,
      `方案 ${variant.id} 的 create 必须收 (host, opts, stage) 三个参数，实际 ${variant.create.length} 个`,
    );
  }
});

test("老方法版必须标记为非 WebGL，且**只有它一个**（REQ-08 AC1）", () => {
  const domVariants = ALL_VARIANTS.filter((v) => !v.needsWebGL);
  assert.equal(domVariants.length, 1, "首版只有 09 是不需要 WebGL 的");
  assert.equal(domVariants[0].id, "09", "老方法版的编号是 09");
  // 页面靠这个布尔决定要不要建 WebGL 上下文；标错一个就是白占一个上下文配额
  assert.equal(ALL_VARIANTS.filter((v) => v.needsWebGL).length, 9);
});

test("清单与注册表一致：能过 assertValidRegistry，且顺序不被打乱", () => {
  // 页面启动时走的就是这条校验（UC-01 备选 4d）。这里提前跑一遍，
  // 免得"注册表坏了"只在浏览器里以整页报错的形式出现。
  assert.doesNotThrow(() => assertValidRegistry(ALL_VARIANTS));
  assert.ok(ALL_VARIANTS.length <= MAX_VARIANTS, `不能超过上限 ${MAX_VARIANTS}`);
});

test("同 id 不同版本的坑：清单里不允许出现重复 id（编号即身份）", () => {
  const seen = new Set<string>();
  for (const variant of ALL_VARIANTS) {
    assert.ok(!seen.has(variant.id), `id "${variant.id}" 重复了`);
    seen.add(variant.id);
  }
});

test("每版的一句话特点与技术要点必须是**给用户看的**，不是占位符", () => {
  for (const variant of ALL_VARIANTS) {
    // 防的是"复制粘贴建新方案后忘了改"，那会让展台上两格写着同一句话
    assert.ok(
      variant.oneLiner.length >= 8,
      `方案 ${variant.id} 的一句话特点太短（"${variant.oneLiner}"），页面上的标注就失去意义了`,
    );
    assert.ok(
      variant.tech.length >= 10,
      `方案 ${variant.id} 的技术要点太短（"${variant.tech}"），对照表会缺一列依据`,
    );
  }
  const oneLiners = new Set(ALL_VARIANTS.map((v) => v.oneLiner));
  assert.equal(oneLiners.size, ALL_VARIANTS.length, "两版写了同一句一句话特点，用户分不出区别");
});
