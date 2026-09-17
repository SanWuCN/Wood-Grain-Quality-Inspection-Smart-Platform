/**
 * `node --test` 的入口：注册 TS 后缀解析钩子（钩子本体见 `test-resolve-hooks.mjs`）。
 *
 * 用法：
 *   node --import ./tools/test-resolve-ts.mjs --test "src/pages/MumaiDashboard/**\/*.test.ts"
 *
 * 背景：生产代码内部用 Vite 口径的不带扩展名导入，Node 原生跑 TS 时解析不到，
 * 导致 `agent/matcher.ts` 这条链的测试根本跑不起来。本文件只修**测试侧**的
 * 解析，生产代码与打包流程不受影响。
 */
import { register } from "node:module";

register("./test-resolve-hooks.mjs", import.meta.url);
