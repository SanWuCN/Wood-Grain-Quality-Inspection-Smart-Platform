import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist",
    // 构建期素材缓存（.gitignore 已排除）：放的是第三方素材原包解压结果，
    // 不是本项目源码，lint 不应把它当源码解析。
    ".cache/**",
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
  {
    /*
      UI 素材 v2.0（2026-09-13）接入后新增的两个模块，与 context.tsx 同一情形：
      Icon / Illustration 组件与它们配套的常量、映射表住在同一个文件里
      （PRD §3 / §5 要求「页面通过资源映射访问文件」，映射表就是接口的一部分）。
      这些模块是站点级基础设施，不是需要热更的页面组件，
      因此和 context.tsx 一样关掉 fast-refresh 这条规则，而不是把映射表拆散。
    */
    files: [
      "src/pages/MumaiDashboard/icons.tsx",
      "src/pages/MumaiDashboard/illustrations.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
]);
