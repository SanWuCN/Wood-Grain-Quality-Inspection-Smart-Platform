/**
 * 解析钩子本体：给「相对路径且不带扩展名」的导入补 `.ts` 后缀。
 *
 * 为什么需要：生产代码（`agent/matcher.ts`、`agent/facts.ts`、`lib.ts` …）
 * 内部用 `from "../seed/scenario"` 这种 Vite 口径的不带扩展名写法，
 * 而 Node 原生类型剥离要求显式后缀 —— 于是 `matcher` 这条链的测试在本仓库
 * `node --test` 下直接 `ERR_MODULE_NOT_FOUND`，匹配/意图/降级从来没有被
 * 自动测试覆盖过。**测试侧适配生产写法，生产代码一行不动。**
 *
 * 只接管相对路径（`./` `../`）；裸模块名、`@/` 别名与带后缀的一律交给 Node。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 候选后缀，顺序与 Vite 一致：先文件后目录索引 */
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier) || specifier.endsWith(".json");
    if (!isRelative || hasExtension || !context.parentURL) throw error;

    for (const suffix of CANDIDATES) {
      if (existsSync(fileURLToPath(new URL(specifier + suffix, context.parentURL)))) {
        return nextResolve(specifier + suffix, context);
      }
    }
    throw error;
  }
}
