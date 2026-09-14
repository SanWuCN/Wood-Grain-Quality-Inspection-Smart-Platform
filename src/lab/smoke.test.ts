/**
 * Phase 1 · 1.2 占位断言：只为确定"本项目到底怎么跑单测"。
 *
 * 本项目没有测试框架（package.json 里无 vitest/jest），所以按 TDD 工作流的
 * "适配项目现状"原则，优先用 Node 原生测试运行器 + 原生类型剥离，不新增依赖：
 *   node --test src/lab/*.test.ts
 * 若 Node 版本不支持直接跑 .ts，再退到 --experimental-strip-types。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("占位：测试运行器可用（Node 原生 + TS 类型剥离）", () => {
  const adds = (a: number, b: number): number => a + b;
  assert.equal(adds(1, 2), 3);
});
