import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CLEAN_FLOW_STAGES,
  advanceCleanFlowReveal,
  beginCleanFlowReveal,
  cancelCleanFlowReveal,
  cleanFlowStagesFor,
} from "./cleanFlowReveal.ts";

/**
 * `cleanFlowReveal` 用 `window.setTimeout` 做兜底 TTL，Node 里没有 window。
 * 这里塞一个**记账式**替身：定时器回调不真跑，测试自己决定什么时候触发 ——
 * 既能验证"到点自动解除"，也不用让测试真的等 30 秒。
 */
type FakeTimer = { id: number; fn: () => void; ms: number };

const timers: FakeTimer[] = [];
const cleared: number[] = [];
let nextTimerId = 1;

(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  },
  clearTimeout: (id: number) => {
    cleared.push(id);
  },
};

const last = () => timers[timers.length - 1];

test("没登记计划时页面拿到 null（自己决定停在哪一步），登记后从第一步开始（一步都不预支）", () => {
  cancelCleanFlowReveal();
  assert.equal(cleanFlowStagesFor("DS-06"), null);

  beginCleanFlowReveal("DS-06", ["pick", "configure", "precheck", "cleaned"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), [], "刚登记时不能先把阶段点亮");
  assert.equal(cleanFlowStagesFor("DS-07"), null, "计划绑定数据集：别的数据集读不到");
  cancelCleanFlowReveal();
});

test("按拍推进：一拍点亮一组阶段，重复推进幂等", () => {
  beginCleanFlowReveal("DS-06", ["pick", "configure", "precheck", "cleaned"]);

  advanceCleanFlowReveal("DS-06", ["pick"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick"]);

  advanceCleanFlowReveal("DS-06", ["pick"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick"], "同一拍重复推进不能重复点亮或回退");

  advanceCleanFlowReveal("DS-06", ["configure", "precheck"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick", "configure", "precheck"], "顺序按计划里的阶段顺序给");
  cancelCleanFlowReveal();
});

test("推完最后一拍页面仍读得到（走得到最后一步），计划由兜底 TTL 或用户动手解除", () => {
  beginCleanFlowReveal("DS-06", ["pick", "cleaned"]);

  advanceCleanFlowReveal("DS-06", ["pick"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick"]);

  advanceCleanFlowReveal("DS-06", ["cleaned"]);
  /*
    这里**不能**立刻解除计划：页面照着"已点亮的最后一个阶段"往前走，
    一解除就只读到 null —— 实测现象是「一直停在预检查，清洗不执行」。
  */
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick", "cleaned"], "推完最后一拍页面还要读得到");

  /* 用户一动手就交回给人 */
  cancelCleanFlowReveal();
  assert.equal(cleanFlowStagesFor("DS-06"), null);
});

test("别的数据集推不动本计划，也不影响本计划已点亮的阶段", () => {
  beginCleanFlowReveal("DS-06", ["pick", "configure", "precheck"]);

  advanceCleanFlowReveal("DS-99", ["precheck"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), []);

  advanceCleanFlowReveal("DS-06", ["precheck"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["precheck"], "计划允许的阶段可以被单独点亮（不必依次推）");
  cancelCleanFlowReveal();
});

test("用户自己动手／本轮被打断时立刻取消，页面归人", () => {
  beginCleanFlowReveal("DS-06", ["pick", "configure"]);
  const timer = last();
  advanceCleanFlowReveal("DS-06", ["pick"]);

  cancelCleanFlowReveal();
  assert.equal(cleanFlowStagesFor("DS-06"), null);
  assert.ok(cleared.includes(timer.id), "取消时要清掉兜底定时器");

  /* 没计划时取消是空操作（页面按钮一路调它，不能抛） */
  cancelCleanFlowReveal();
});

test("计划里的阶段名要落在真实阶段表内，未知阶段与空计划一律不登记", () => {
  cancelCleanFlowReveal();
  beginCleanFlowReveal("DS-06", ["precheck", "根本不存在的阶段", "versioned"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), []);
  advanceCleanFlowReveal("DS-06", ["precheck", "versioned"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["precheck", "versioned"], "非法阶段不占名额，两个合法阶段都点亮");
  cancelCleanFlowReveal();

  beginCleanFlowReveal("DS-06", ["根本不存在的阶段"]);
  assert.equal(cleanFlowStagesFor("DS-06"), null, "全是非法阶段等于没登记");

  beginCleanFlowReveal("", ["pick"]);
  assert.equal(cleanFlowStagesFor("DS-06"), null, "没有数据集 id 不登记");

  assert.deepEqual([...CLEAN_FLOW_STAGES], ["pick", "configure", "precheck", "cleaned", "reviewed", "versioned"]);
});

test("兜底 TTL：到点自动解除计划，不留半截舞台", () => {
  beginCleanFlowReveal("DS-06", ["pick", "configure", "precheck", "cleaned"]);

  const timer = last();
  assert.ok(timer.ms > 0 && timer.ms <= 60_000, "兜底时长要有限");
  advanceCleanFlowReveal("DS-06", ["pick"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), ["pick"]);

  timer.fn();
  assert.equal(cleanFlowStagesFor("DS-06"), null, "到点必须解除，页面回到可自由操作");
});

test("重新登记计划会先解除上一份（不并发两份计划）", () => {
  beginCleanFlowReveal("DS-06", ["pick", "configure"]);
  const first = last();

  beginCleanFlowReveal("DS-06", ["cleaned"]);
  assert.ok(cleared.includes(first.id), "上一份计划的兜底定时器要被清掉");
  assert.deepEqual(cleanFlowStagesFor("DS-06"), []);

  advanceCleanFlowReveal("DS-06", ["pick"]);
  assert.deepEqual(cleanFlowStagesFor("DS-06"), [], "旧计划的阶段不该还能被点亮");
  cancelCleanFlowReveal();
});

test("页面侧：所有「往下走一步」的按钮都过 userAdvance，用户一点就接管", () => {
  /* 静态检查（与 operationInsights.test.ts 同一做法）：漏包一个按钮，
     脚本就会在用户点过之后继续抢页面 —— 这类回归在界面上很难一眼看出来。 */
  const source = readFileSync(new URL("./pages/DatasetCleanFlow.tsx", import.meta.url), "utf8");

  assert.match(source, /const userAdvance = \(run: \(\) => void\) => \(\) => \{/);
  assert.match(source, /cancelCleanFlowReveal\(\)/);
  for (const raw of [
    `onClick={() => setStage(`,
    `onClick={runPrecheck}`,
    `onClick={runCleaning}`,
    `onClick={makeVersion}`,
    `onClick={() => setReviewOpen(true)}`,
    `onClick={() => setConfigOpen(true)}`,
  ]) {
    assert.ok(!source.includes(raw), `未接管用户的按钮：${raw}`);
  }
  assert.ok(source.includes("useCleanFlowReveal(DATASET.id)"), "页面要订阅这一份数据集的推进计划");
});
