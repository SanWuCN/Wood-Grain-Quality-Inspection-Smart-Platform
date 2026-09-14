/**
 * UC-01 备选 4d · 注册表校验（unit test）
 *
 * ── 这一组断言在防什么 ──────────────────────────────────────────────
 * 4d 的原话是「注册表为空或变体 id 重复 → 显式报错，不静默渲染」。
 * 这两件事在浏览器里**很难自然构造**（谁也不会手动去写一个空注册表），
 * 所以它们是本 spec 里少数只能靠单测覆盖的路径（已在 tasks.md 的覆盖检查里注明）。
 *
 * 另一条硬指标是 `MAX_VARIANTS = 12`（REQ-01 AC4）：浏览器 WebGL 上下文上限约 16，
 * 超过就必须"按上限降级 + 显式提示"，不能静默少画 —— 静默少画的后果是
 * 用户以为"这一版没做"，而不是"这一版被降级了"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRegistry,
  assertValidRegistry,
  MAX_VARIANTS,
  type RegistryEntry,
} from "./registry.ts";
import type { LabVariant } from "./types.ts";

/** 造一个只有标题字段的最小变体：注册表只关心 id/name/needsWebGL，不碰 create() */
function variant(id: string, needsWebGL = true): LabVariant {
  return {
    id,
    name: `方案 ${id}`,
    oneLiner: "一句话特点",
    tech: "技术要点",
    needsWebGL,
    cost: "低",
    fidelity: "mid",
    fidelityNote: "理由",
    create: () => {
      throw new Error("单测不调用 create()：Node 里没有 WebGL");
    },
  };
}

test("register：id 重复时抛错，且错误信息里带得上重复的那个 id", () => {
  const registry = createRegistry();
  registry.register(variant("01"));

  assert.throws(
    () => registry.register(variant("01")),
    (err: unknown) => {
      assert.ok(err instanceof Error, "必须是 Error，不能是字符串");
      assert.match(err.message, /01/, "错误信息里要能看出是哪个 id 重复");
      return true;
    },
  );
});

test("register：id 是空串或只有空白时抛错（空 id 在页面上就是无名格）", () => {
  const registry = createRegistry();

  assert.throws(() => registry.register(variant("")), /id/i);
  assert.throws(() => registry.register(variant("   ")), /id/i);
});

test("register：超过 MAX_VARIANTS 时抛错，第 12 个仍然收得下", () => {
  const registry = createRegistry();

  for (let i = 1; i <= MAX_VARIANTS; i += 1) {
    registry.register(variant(String(i).padStart(2, "0")));
  }
  assert.equal(registry.list().length, MAX_VARIANTS, "上限本身是允许的");

  assert.throws(() => registry.register(variant("13")), /12/);
});

test("assertValid：空注册表抛错（4d：不得静默渲染出一个空页面）", () => {
  assert.throws(() => assertValidRegistry([]), /空|没有|0 个/);
});

test("assertValid：缺 id / 缺 name / needsWebGL 不是布尔 → 全部抛错", () => {
  const base = variant("01");

  assert.throws(
    () => assertValidRegistry([{ ...base, id: "" }]),
    /id/i,
  );
  assert.throws(
    () => assertValidRegistry([{ ...base, name: "" }]),
    /name/i,
  );
  assert.throws(
    () => assertValidRegistry([{ ...base, needsWebGL: "yes" as unknown as boolean }]),
    /needsWebGL/i,
  );
  assert.throws(
    () => assertValidRegistry([{ ...base, create: undefined as unknown as LabVariant["create"] }]),
    /create/i,
  );
});

test("assertValid：收集**全部**问题再抛，而不是遇到第一个就返回", () => {
  // 一次只看一个错，修完再跑再报下一个 —— 那是"挤牙膏"式报错，
  // 4d 要的是"显式报错"：把坏在哪一次说清。
  const err = (() => {
    try {
      assertValidRegistry([]);
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err, "空注册表必须抛");

  assert.throws(
    () =>
      assertValidRegistry([
        { ...variant("01"), name: "" },
        variant("01"),
      ]),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /name/i, "第一条问题（缺 name）要在信息里");
      assert.match(msg, /01/, "第二条问题（id 重复）也要在信息里");
      return true;
    },
  );
});

test("assertValid：合法的注册表原样通过（不是有输入就报错的假校验）", () => {
  const entries: RegistryEntry[] = [variant("01"), variant("09", false)];
  assert.doesNotThrow(() => assertValidRegistry(entries));
});

test("registry.list()：保持注册顺序（编号即顺序，页面左上到右下按它排）", () => {
  const registry = createRegistry();
  registry.register(variant("03"));
  registry.register(variant("01"));
  registry.register(variant("02"));

  assert.deepEqual(
    registry.list().map((v) => v.id),
    ["03", "01", "02"],
  );
});

test("registry.list()：返回的是副本，外部改动不会污染注册表内部状态", () => {
  const registry = createRegistry();
  registry.register(variant("01"));

  registry.list().push(variant("99"));
  assert.equal(registry.list().length, 1);
});

test("MAX_VARIANTS 就是 12（硬指标写在断言里，改小改大都会红）", () => {
  assert.equal(MAX_VARIANTS, 12);
});
