/**
 * 任务 2.14 + 2.17 · 循环状态机（unit test，**不需要浏览器**）
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * 展台里最贵的一类 bug 不是"某版不好看"，而是**状态自相矛盾**：
 *   · 按了"暂停全部"，点开一格看细节，画面又动起来了（UC-02 备选 4b）；
 *   · 连点暂停按钮，出现"一半格子停了、一半还在跑"（UC-03 备选 4a）；
 *   · 放大那一格的 FPS 沿用了格子态的旧数值（REQ-03 AC3）。
 * 这三件事**在截图里看不出来**（静态图分不出"停住的那一帧"和"动着的某一帧"），
 * 所以只能在状态机这一层断言。
 *
 * ── 怎么在没有 DOM 的情况下测 ───────────────────────────────────────
 * `LabLoop` 唯一碰 DOM 的地方是 `host.getBoundingClientRect()`（量尺寸）与
 * 失败提示（`markTileFailed`）。本测试传一个**长这样的普通对象**进去，
 * 两个方法都打桩。于是不需要 jsdom、不需要浏览器、不需要新增依赖 ——
 * 而循环的状态推进、暂停广播、焦点切换、FPS 计量全都能跑真代码。
 *
 * ⚠ 这里**不测** `needsWebGL: true` 的格子：那要建 WebGL 上下文，Node 里没有。
 * 所以暂停/焦点的广播路径用 `needsWebGL: false` 的假方案覆盖 —— 广播逻辑
 * 对两类方案是同一条代码路径（`wrap()` 里不区分），这个取舍是安全的。
 * 真 WebGL 一版的暂停像素差归 Phase 3 的 E2E（浏览器里量）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LabLoop, type LabTile } from "./loop.ts";
import type { LabVariant, VariantRuntime } from "./types.ts";

/** 造一个"长得像 DOM 元素"的最小替身：只实现 LabLoop 真正用到的那一个方法 */
function fakeHost(width = 120, height = 120): HTMLElement {
  const host = {
    getBoundingClientRect: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    append: () => {},
    ownerDocument: null,
    appendChild: () => {},
  };
  return host as unknown as HTMLElement;
}

/** 记下每一次 update 的 dt，用来证明"暂停时时间轴没有推进" */
function recordingVariant(id: string): { variant: LabVariant; updates: number[]; disposals: () => number } {
  const updates: number[] = [];
  let disposed = 0;
  const variant: LabVariant = {
    id,
    name: `假方案 ${id}`,
    oneLiner: "只在单测里存在的一版",
    tech: "不建任何东西，只记录 update/dispose 被调用",
    needsWebGL: false,
    cost: "无",
    fidelity: "mid",
    fidelityNote: "不适用",
    create: (_host, _opts, _stage): VariantRuntime => ({
      update: (dt) => updates.push(dt),
      dispose: () => {
        disposed += 1;
      },
    }),
  };
  return { variant, updates, disposals: () => disposed };
}

function attach(loop: LabLoop, id: string): { tile: LabTile; updates: number[] } {
  const { variant, updates } = recordingVariant(id);
  const tile = loop.attach(variant, fakeHost());
  assert.equal(tile.ready, true, `假方案 ${id} 应当挂载成功`);
  return { tile, updates };
}

test("attach：非 WebGL 方案拿到 undefined 舞台，且不占上下文预算", () => {
  const loop = new LabLoop({ contextBudget: 0 });
  const { tile } = attach(loop, "A");
  assert.equal(tile.stage, null, "老方法版不该有舞台");
  assert.equal(loop.degraded.length, 0, "预算为 0 也不该影响不需要 WebGL 的方案");
});

test("renderFrame：正常推进时每格都收到 dt，并喂进 FPS 表", () => {
  const loop = new LabLoop();
  const { tile, updates } = attach(loop, "A");
  loop.renderFrame(0.016, 1000);
  loop.renderFrame(0.016, 1016);
  assert.equal(updates.length, 2, "帧循环要真的把 dt 发给方案");
  assert.ok(tile.meter.sampleCount() >= 2, "FPS 表要拿到时间戳（否则读数永远是 0）");
});

test("全局暂停：**不推进时间轴**（这是「双帧像素差 ≈ 0」的前提，REQ-04 AC1）", () => {
  const loop = new LabLoop();
  const { updates } = attach(loop, "A");
  loop.renderFrame(0.016, 1000);
  const before = updates.length;
  loop.setPaused(true);
  loop.renderFrame(0.016, 1016);
  loop.renderFrame(0.016, 1032);
  assert.equal(updates.length, before, "暂停期间一次 update 都不能发生");
  loop.setPaused(false);
  loop.renderFrame(0.016, 1048);
  assert.equal(updates.length, before + 1, "恢复后必须重新开始推进");
});

test("REQ-03 AC4 / UC-02 备选 4b：**全局暂停优先于放大** —— 暂停中放大不得偷偷播放", () => {
  const loop = new LabLoop();
  const { updates: a } = attach(loop, "A");
  const { updates: b } = attach(loop, "B");

  loop.setPaused(true);
  loop.renderFrame(0.016, 1000);
  const beforeA = a.length;
  const beforeB = b.length;

  // 用户在暂停状态下点开放大 B 看细节
  loop.setFocused("B");
  loop.renderFrame(0.016, 1016);
  loop.renderFrame(0.016, 1032);

  assert.equal(a.length, beforeA, "被放大的不是 A，A 当然不能动");
  assert.equal(b.length, beforeB, "**B 在全局暂停下也不能动** —— 这就是「偷偷恢复播放」");
  assert.equal(loop.isPaused(), true, "放大不该把全局暂停改掉");
  assert.equal(loop.focusedTile()?.variant.id, "B");
});

test("REQ-03 AC1：放大时其余格暂停（省下的 GPU 给被放大那格）", () => {
  const loop = new LabLoop();
  const { updates: a } = attach(loop, "A");
  const { updates: b } = attach(loop, "B");

  loop.setFocused("B");
  loop.renderFrame(0.016, 1000);
  loop.renderFrame(0.016, 1016);

  assert.equal(a.length, 0, "放大 B 时 A 必须停");
  assert.equal(b.length, 2, "被放大的 B 必须继续动");
});

test("REQ-03 AC2：还原（setFocused(null)）后全部格恢复动画", () => {
  const loop = new LabLoop();
  const { updates: a } = attach(loop, "A");
  const { updates: b } = attach(loop, "B");

  loop.setFocused("B");
  loop.renderFrame(0.016, 1000);
  loop.setFocused(null);
  loop.renderFrame(0.016, 1016);

  assert.ok(a.length >= 1, "还原后 A 要恢复");
  assert.ok(b.length >= 2, "还原后 B 继续（它本来就在动）");
  assert.equal(loop.focusedTile(), null);
});

test("放大不存在的 id：安全落回「无放大」，不抛错也不改变暂停态", () => {
  const loop = new LabLoop();
  attach(loop, "A");
  loop.setPaused(true);
  loop.setFocused("不存在的编号");
  assert.equal(loop.focusedTile(), null);
  assert.equal(loop.isPaused(), true, "传个不存在的编号不该把暂停态搞丢");
});

test("REQ-03 AC3：放大前后 FPS 重新计量（不能沿用格子态旧数值）", () => {
  const loop = new LabLoop();
  const { tile } = attach(loop, "A");
  loop.renderFrame(0.016, 1000);
  loop.renderFrame(0.016, 1016);
  assert.ok(tile.meter.sampleCount() > 0);

  loop.setFocused("A");
  assert.equal(tile.meter.sampleCount(), 0, "放大那一刻帧率表必须清零重算");
  assert.equal(tile.handle?.renderStats().fps, 0, "清零后读数是 0，而不是编一个旧数");
});

test("REQ-04 AC5：暂停态写进 renderStats，工装不必去猜（renderStats 的三个字段）", () => {
  const loop = new LabLoop();
  const { tile } = attach(loop, "A");
  loop.setFocused("A");
  loop.setPaused(true);
  const stats = tile.handle?.renderStats();
  assert.deepEqual(stats, { fps: 0, paused: true, focused: true });
});

test("REQ-04 AC1：连点暂停用「目标态」而不是取反，最后一次点击永远胜出", () => {
  const loop = new LabLoop();
  const { updates } = attach(loop, "A");

  // 模拟"快速连点五次"：每次都显式给目标态（页面按钮走的就是这条路）
  for (const target of [true, true, false, true, true]) loop.setPaused(target);
  assert.equal(loop.isPaused(), true);

  const before = updates.length;
  loop.renderFrame(0.016, 1000);
  assert.equal(updates.length, before, "最终状态是暂停，就必须真的停住（不能出现「半暂停」）");

  loop.setPaused(false);
  loop.setPaused(false);
  assert.equal(loop.isPaused(), false, "幂等的目标态：重复设同一个值不翻转");
  loop.renderFrame(0.016, 1016);
  assert.equal(updates.length, before + 1);
});

test("UC-01 备选 4c：WebGL 上下文超预算时不建上下文，并记进 degraded 供页面显式提示", () => {
  const loop = new LabLoop({ contextBudget: 0 });
  const webglVariant: LabVariant = {
    ...recordingVariant("W").variant,
    needsWebGL: true,
  };
  const tile = loop.attach(webglVariant, fakeHost());

  assert.equal(tile.ready, false, "预算用尽时这一格不能算就绪");
  assert.match(String(tile.error), /预算/, "错误信息要说明是预算问题，而不是含糊的失败");
  assert.deepEqual(loop.degraded, ["W"], "降级必须留痕，否则用户会以为「这版没做」");
});

test("失败隔离（REQ-01 AC3）：一版 create() 抛错不拖垮其它格", () => {
  const loop = new LabLoop();
  attach(loop, "A");
  const boom: LabVariant = {
    ...recordingVariant("BOOM").variant,
    create: () => {
      throw new Error("故意炸一个（模拟着色器编译失败）");
    },
  };
  const bad = loop.attach(boom, fakeHost());
  const { updates } = attach(loop, "C");

  assert.equal(bad.ready, false);
  assert.match(String(bad.error), /故意炸一个/);
  loop.renderFrame(0.016, 1000);
  assert.equal(updates.length, 1, "坏掉的那一格不影响其它格继续推进");
});

test("refitAll：只重排就绪的格子，坏格跳过（不抛错）", () => {
  const loop = new LabLoop();
  attach(loop, "A");
  const bad = loop.attach(
    { ...recordingVariant("B").variant, create: () => { throw new Error("x"); } },
    fakeHost(),
  );
  assert.equal(bad.ready, false);
  assert.doesNotThrow(() => loop.refitAll(() => ({ width: 200, height: 200 })));
});

test("dispose：幂等且把全部句柄放掉（页面卸载/重排两处都会调）", () => {
  const loop = new LabLoop();
  const a = recordingVariant("A");
  const b = recordingVariant("B");
  loop.attach(a.variant, fakeHost());
  loop.attach(b.variant, fakeHost());

  loop.dispose();
  loop.dispose();
  assert.equal(a.disposals(), 1, "重复 dispose 不该重复释放（也不是 0 次）");
  assert.equal(b.disposals(), 1);
  assert.equal(loop.tiles.length, 0);
});
