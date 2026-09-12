import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist",
    "src/components/**",
    "src/hooks/**",
    "src/pages/Demo0/**",
    "src/pages/Demo1/**",
    "src/pages/Demo2/**",
    "src/pages/Demo3/**",
    "src/pages/Index/**",
    // 直接沿用 sc-datav Demo2 的地图源码（逐字迁移，只换了数据与接线）。
    // 与上游 Demo2 一样排除在 lint 之外：那里的写法是上游风格，
    // 为了保持与原版一致，不做 prefer-const / 依赖数组之类的本地改写。
    "src/pages/MumaiDashboard/mapDemo/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // context 文件按惯例同时导出 Hook 与它的类型/常量，
    // 这类文件本来就不能做 fast refresh，关掉这条规则即可。
    files: ["src/pages/MumaiDashboard/context.tsx", "src/pages/MumaiDashboard/design.ts"],
    rules: { "react-refresh/only-export-components": "off" },
  },
]);
